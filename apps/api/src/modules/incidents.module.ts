import { Controller, Get, Injectable, Logger, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import { INCIDENT_LABELS, INCIDENT_QUIET_MS, IncidentKind } from '../common/incidents';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Vigilante 24/7: cada 2 minutos revisa los incidentes.
 *  - Nuevo → aviso inmediato al equipo (OPS_ALERT_EMAIL o SIGNUP_NOTIFY_EMAIL).
 *  - Sigue pasando después de 1 hora → recordatorio.
 *  - 30 minutos sin repetirse → se cierra solo.
 * Mientras tanto, el bot nunca deja al cliente sin respuesta: si la IA falla le
 * dice "ya reviso con el equipo" y pasa la conversación a una persona.
 */

const REMIND_AFTER_MS = 60 * 60e3;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

@Injectable()
export class IncidentsService {
  private readonly logger = new Logger('Vigilante24x7');

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: EmailsService,
  ) {}

  private async recipients(): Promise<string[]> {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: ['OPS_ALERT_EMAIL', 'SIGNUP_NOTIFY_EMAIL'] } } });
    const raw = rows.find((r: any) => r.key === 'OPS_ALERT_EMAIL')?.value?.trim()
      || rows.find((r: any) => r.key === 'SIGNUP_NOTIFY_EMAIL')?.value?.trim()
      || process.env.SIGNUP_NOTIFY_EMAIL || 'restrepos591@gmail.com';
    return raw.split(',').map((e: string) => e.trim()).filter(Boolean).slice(0, 10);
  }

  private openWhere() {
    return { OR: [{ resolvedAt: null }, { resolvedAt: { isSet: false } }] };
  }

  @Cron('*/2 * * * *')
  async watch() {
    const now = Date.now();
    const open = await this.prisma.incident.findMany({ where: this.openWhere(), take: 200 }).catch(() => []);
    for (const inc of open as any[]) {
      // Silencio de 30 min → resuelto
      if (now - new Date(inc.lastAt).getTime() > INCIDENT_QUIET_MS) {
        await this.prisma.incident.update({ where: { id: inc.id }, data: { resolvedAt: new Date(), resolvedBy: 'Automático (30 min sin repetirse)' } });
        continue;
      }
      const due = !inc.notifiedAt || (now - new Date(inc.notifiedAt).getTime() > REMIND_AFTER_MS);
      if (!due) continue;
      const company = inc.companyId ? await this.prisma.company.findUnique({ where: { id: inc.companyId }, select: { name: true, contactPhone: true } }) : null;
      const label = INCIDENT_LABELS[inc.kind as IncidentKind] ?? inc.kind;
      const subject = `${inc.notifiedAt ? 'SIGUE PASANDO' : 'ALERTA'}: ${label}${company ? ` · ${company.name}` : ''} (${inc.count} ${inc.count === 1 ? 'vez' : 'veces'})`;
      try {
        for (const toEmail of await this.recipients()) {
          await this.emails.systemSend({
            toEmail,
            subject,
            body: `<p><b>${esc(label)}</b>${company ? ` en <b>${esc(company.name)}</b>` : ''}.</p>
              <p>Veces: ${inc.count} · desde ${new Date(inc.firstAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })} · última ${new Date(inc.lastAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
              <p>Detalle: ${esc(inc.detail)}</p>
              <p>El bot le dijo al cliente que el equipo revisa y dejó la conversación marcada para una persona. Revisa Plataforma → Incidentes 24/7.</p>`,
          });
        }
        await this.prisma.incident.update({ where: { id: inc.id }, data: { notifiedAt: new Date() } });
        this.logger.warn(subject);
      } catch (err: any) {
        this.logger.error(`no se pudo avisar el incidente ${inc.id}: ${err.message}`);
      }
    }
  }

  async list() {
    const since = new Date(Date.now() - 7 * 86400e3);
    const rows = await this.prisma.incident.findMany({ where: { lastAt: { gte: since } }, orderBy: { lastAt: 'desc' }, take: 200 });
    const companies = await this.prisma.company.findMany({
      where: { id: { in: [...new Set(rows.map((r: any) => r.companyId).filter(Boolean))] as string[] } },
      select: { id: true, name: true },
    });
    const names = new Map(companies.map((c: any) => [c.id, c.name]));
    const view = rows.map((r: any) => ({
      id: r.id, companyId: r.companyId, companyName: r.companyId ? names.get(r.companyId) ?? 'Empresa eliminada' : 'Plataforma',
      kind: r.kind, label: INCIDENT_LABELS[r.kind as IncidentKind] ?? r.kind, detail: r.detail, count: r.count,
      firstAt: r.firstAt, lastAt: r.lastAt, notifiedAt: r.notifiedAt ?? null, resolvedAt: r.resolvedAt ?? null, resolvedBy: r.resolvedBy ?? null,
    }));
    return { open: view.filter((v) => !v.resolvedAt), recent: view.filter((v) => v.resolvedAt) };
  }

  async resolve(actor: AuthUser, id: string) {
    const row = await this.prisma.incident.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Incidente no encontrado');
    await this.prisma.incident.update({ where: { id }, data: { resolvedAt: new Date(), resolvedBy: actor.name } });
    return { ok: true };
  }
}

@Controller('platform/incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  list() {
    return this.incidents.list();
  }

  @Post(':id/resolve')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  resolve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.incidents.resolve(user, id);
  }
}

@Module({
  imports: [EmailsModule],
  controllers: [IncidentsController],
  providers: [IncidentsService],
})
export class IncidentsModule {}
