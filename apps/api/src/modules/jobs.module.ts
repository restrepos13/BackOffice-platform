import { Controller, Injectable, Logger, Module, Post, Query } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import { AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';
import { ExecutiveService, OpsModule } from './ops.module';
import { seedDemoCompany } from '../demo/demo-company';

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Trabajos programados de la plataforma:
 *  - Facturación mensual (día 1, 06:00): factura del período anterior por
 *    empresa activa = plan + consumo (WhatsApp + storage; la IA es BYOK y
 *    se paga directo a DeepInfra). Idempotente: no duplica períodos.
 *  - Reporte diario a gerencia (07:00): el resumen del bot jefe al correo de
 *    contacto de cada empresa activa (queda en cola hasta que haya SMTP).
 * Ambos también se pueden disparar a mano desde Dev Tools.
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: EmailsService,
    private readonly executive: ExecutiveService,
    private readonly audit: AuditService,
  ) {}

  /** Genera las facturas de un período (default: el mes anterior). */
  async generateInvoices(period?: string) {
    const now = new Date();
    const base = period
      ? new Date(Number(period.split('-')[0]), Number(period.split('-')[1]) - 1, 1)
      : new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const p = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
    const from = new Date(base.getFullYear(), base.getMonth(), 1);
    const to = new Date(base.getFullYear(), base.getMonth() + 1, 1);

    const companies = await this.prisma.company.findMany({
      where: { status: 'ACTIVE', planId: { not: null } },
      include: { plan: true },
    });

    let created = 0;
    let skipped = 0;
    for (const company of companies) {
      const exists = await this.prisma.invoice.findFirst({
        where: { companyId: company.id, period: p },
      });
      if (exists) {
        skipped++;
        continue;
      }
      const usage = await this.prisma.usageRecord.findMany({
        where: { companyId: company.id, date: { gte: from, lt: to } },
      });
      const consumption = round(
        usage.reduce((s, u) => s + u.waCostUsd + u.storageCostUsd, 0),
      );
      const planAmount = company.plan?.priceMonthly ?? 0;
      await this.prisma.invoice.create({
        data: {
          companyId: company.id,
          period: p,
          planAmount,
          consumptionAmount: consumption,
          totalAmount: round(planAmount + consumption),
          status: 'PENDING',
        },
      });
      created++;
    }
    this.logger.log(`Facturas ${p}: ${created} creadas, ${skipped} ya existían`);
    return { period: p, created, skipped, companies: companies.length };
  }

  /** Envía (o encola) el reporte a gerencia de cada empresa activa. */
  async sendExecutiveEmails() {
    const companies = await this.prisma.company.findMany({
      where: { status: 'ACTIVE', contactEmail: { not: null } },
    });
    let sent = 0;
    for (const company of companies) {
      if (!company.contactEmail) continue;
      const report = await this.executive.build(company.id);
      const issues = report.areas.filter((a) => !a.ok);
      const body = `
<p>Hola equipo de <strong>${company.name}</strong>, este es el reporte diario de su operación:</p>
<h3>Auditoría de áreas</h3>
<ul>${report.areas
        .map((a) => `<li>${a.ok ? '✅' : '⚠️'} <strong>${a.area}</strong>: ${a.detail}</li>`)
        .join('')}</ul>
<h3>Últimos 7 días</h3>
<ul>
  <li>${report.week.conversations} conversaciones nuevas (antes: ${report.week.conversationsPrev})</li>
  <li>${report.week.messages} mensajes atendidos (antes: ${report.week.messagesPrev})</li>
  <li>${report.week.newContacts} contactos nuevos · ${report.week.appointments} citas agendadas</li>
</ul>
<h3>Ahorro estimado del mes</h3>
<p>${report.savings.salariesEquivalent.toFixed(1)} sueldos ≈ USD ${report.savings.savedUsd.toFixed(2)}
 (la IA respondió ${report.savings.aiRepliesMonth} veces, con un costo real de USD ${report.savings.aiCostMonth.toFixed(2)}).</p>
${report.pending.overdueFollowUps.length ? `<p>⚠️ Tienen ${report.pending.overdueFollowUps.length} seguimiento(s) vencido(s).</p>` : ''}
<p>El detalle en vivo está en su panel → <strong>Gerencia</strong>.</p>
<p>— El bot jefe de BackOffice</p>`;
      await this.emails.systemSend({
        companyId: company.id,
        toEmail: company.contactEmail,
        subject: `${company.name} — reporte a gerencia (${issues.length === 0 ? 'todo OK' : `${issues.length} área(s) con atención`})`,
        body,
      });
      sent++;
    }
    this.logger.log(`Reportes a gerencia: ${sent} correos generados`);
    return { sent };
  }

  // Día 1 de cada mes, 06:00 — facturas del mes anterior
  @Cron('0 6 1 * *')
  async cronInvoices() {
    const result = await this.generateInvoices();
    await this.audit.log({
      actor: null, action: 'jobs.invoices', entity: 'Invoice',
      detail: `Período ${result.period}: ${result.created} facturas generadas`,
    });
  }

  // Todos los días, 07:00 — reporte a gerencia
  @Cron('0 7 * * *')
  async cronExecutiveEmails() {
    const result = await this.sendExecutiveEmails();
    await this.audit.log({
      actor: null, action: 'jobs.executive-emails', entity: 'EmailMessage',
      detail: `${result.sent} reportes a gerencia enviados/encolados`,
    });
  }

  /** Regenera la empresa DEMO de ventas con fechas frescas (idempotente). */
  async resetDemoCompany() {
    await seedDemoCompany(this.prisma as any);
    return { ok: true, slug: 'delicias-demo' };
  }

  // Domingos 04:00 — la vitrina de ventas se renueva sola: pedidos "próximos"
  // siempre próximos, consumo de 30 días al día y tour sin ver.
  @Cron('0 4 * * 0')
  async cronDemoRefresh() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      await this.resetDemoCompany();
      await this.audit.log({
        actor: null, action: 'jobs.demo-refresh', entity: 'Company',
        detail: 'Empresa demo regenerada con fechas frescas',
      });
    } catch (err: any) {
      this.logger.error(`refresh de la empresa demo: ${err.message}`);
    }
  }
}

@Controller('jobs')
@Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  /** Disparo manual: facturas de un período (default mes anterior). */
  @Post('invoices')
  async invoices(@CurrentUser() user: AuthUser, @Query('period') period?: string) {
    const result = await this.jobs.generateInvoices(period);
    await this.audit.log({
      actor: user, action: 'jobs.invoices.manual', entity: 'Invoice',
      detail: `Período ${result.period}: ${result.created} creadas, ${result.skipped} existentes`,
    });
    return result;
  }

  /** Restaurar la empresa DEMO de ventas al estado perfecto, ya. */
  @Post('demo-reset')
  async demoReset(@CurrentUser() user: AuthUser) {
    const result = await this.jobs.resetDemoCompany();
    await this.audit.log({
      actor: user, action: 'jobs.demo-reset.manual', entity: 'Company',
      detail: 'Empresa demo restaurada desde Dev Tools',
    });
    return result;
  }

  /** Disparo manual: reporte a gerencia por correo, ahora. */
  @Post('executive-emails')
  async executiveEmails(@CurrentUser() user: AuthUser) {
    const result = await this.jobs.sendExecutiveEmails();
    await this.audit.log({
      actor: user, action: 'jobs.executive-emails.manual', entity: 'EmailMessage',
      detail: `${result.sent} reportes generados`,
    });
    return result;
  }
}

@Module({
  imports: [EmailsModule, OpsModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
