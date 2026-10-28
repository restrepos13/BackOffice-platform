import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeAiCredits } from '../ai/ai-access';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson, scopeCompanyId } from '../common/constants';
import {
  PERIOD_RE, computeCompanyInvoice, earlyExitFee, invoiceCurrency, periodOf, sanitizeLines, shiftPeriod, summarize, monthsBetween, includedIva,
} from '../common/billing-engine';
import { AuditService } from './audit.module';
import { SubscriptionsModule, SubscriptionsService } from './subscriptions.module';
import { deterministicId } from '../common/automation/run-signals';

/**
 * Cobro a las empresas, personalizable mes a mes:
 *  - Vista previa / resumen del mes con sus líneas (plan o precio pactado,
 *    cargos, descuentos, consumo de WhatsApp al costo).
 *  - Ajustes por empresa (solo plataforma): un mes, un rango o recurrentes.
 *  - Facturas pendientes editables (línea a línea) antes de cobrarlas.
 *  - Permanencia: montaje gratis con permanencia mínima; salida anticipada
 *    con cobro proporcional del montaje.
 * La IA de BackOffice se vende en paquetes prepagos (ai-credits.module).
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly subscriptions?: SubscriptionsService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private assertPeriod(period: string | undefined, fallback = periodOf()): string {
    const p = period ?? fallback;
    if (!PERIOD_RE.test(p)) throw new BadRequestException('Período inválido (usa YYYY-MM)');
    return p;
  }

  private companyWithPlan(id: string) {
    return this.prisma.company.findUniqueOrThrow({ where: { id }, include: { plan: true } });
  }

  /** Resumen del mes (lo que se le va a cobrar) + estado de la IA y la permanencia. */
  async summary(user: AuthUser, companyId?: string, period?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const p = this.assertPeriod(period);
    const company = await this.companyWithPlan(scoped);
    const [invoice, credits, usage] = await Promise.all([
      computeCompanyInvoice(this.prisma, company, p),
      computeAiCredits(this.prisma, company),
      this.usageTotals(scoped, p),
    ]);
    const currency = invoiceCurrency(company);
    return {
      period: p,
      currency,
      company: { id: company.id, name: company.name, status: company.status },
      plan: company.plan
        ? {
            name: company.plan.name, code: company.plan.code, line: company.plan.line,
            priceMonthly: company.plan.priceMonthly, currency: company.plan.currency,
          }
        : null,
      customPriceMonthly: company.customPriceMonthly ?? null,
      billingCycle: company.billingCycle ?? 'MONTHLY',
      annualStartPeriod: company.annualStartPeriod ?? null,
      // Próximo cobro anual (el mes de inicio de cada ciclo)
      nextAnnualCharge: company.billingCycle === 'ANNUAL' && company.annualStartPeriod
        ? shiftPeriod(company.annualStartPeriod, Math.max(0, Math.ceil(monthsBetween(company.annualStartPeriod, p) / 12)) * 12)
        : null,
      lines: invoice.lines,
      planAmount: invoice.planAmount,
      consumptionAmount: invoice.consumptionAmount,
      total: invoice.total,
      iva: invoice.iva,
      consumption: usage,
      ai: credits,
      contract: this.contractInfo(company),
    };
  }

  private async usageTotals(companyId: string, period: string) {
    const [y, m] = period.split('-').map(Number);
    const usage = await this.prisma.usageRecord.findMany({
      where: { companyId, date: { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) } },
    });
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      aiCostUsd: round(usage.reduce((s, u) => s + u.aiCostUsd, 0)),
      aiTokens: usage.reduce((s, u) => s + u.aiTokens, 0),
      whatsappCostUsd: round(usage.reduce((s, u) => s + u.waCostUsd, 0)),
      whatsappConversations: usage.reduce((s, u) => s + u.waConversations, 0),
      storageCostUsd: round(usage.reduce((s, u) => s + u.storageCostUsd, 0)),
      storageMb: round(usage.length ? Math.max(...usage.map((u) => u.storageMb)) : 0),
    };
  }

  private contractInfo(company: any) {
    const minTermMonths = company.minTermMonths ?? company.plan?.minTermMonths ?? 0;
    const setupFeeValue = company.setupFeeValue ?? company.plan?.setupFeeValue ?? 0;
    const start: Date | null = company.contractStartAt ?? null;
    const endsAt = start && minTermMonths
      ? new Date(start.getFullYear(), start.getMonth() + minTermMonths, start.getDate())
      : null;
    return {
      contractStartAt: start,
      minTermMonths,
      setupFeeValue,
      endsAt,
      inForce: !!endsAt && endsAt > new Date(),
      earlyExit: earlyExitFee({ contractStartAt: start, minTermMonths, setupFeeValue }),
    };
  }

  async invoices(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const rows = await this.prisma.invoice.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { period: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
    });
    return rows.map((i) => ({ ...i, lines: parseJson<any[]>(i.linesJson, []), iva: includedIva(i.totalAmount, i.currency) }));
  }

  /* ── Ajustes (solo plataforma) ───────────────────────────────────── */

  async listAdjustments(user: AuthUser, companyId: string) {
    const scoped = this.resolveCompany(user, companyId);
    return this.prisma.billingAdjustment.findMany({
      where: { companyId: scoped },
      orderBy: [{ startPeriod: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private validateAdjustment(dto: any) {
    const kind = String(dto?.kind ?? '');
    if (!['CHARGE', 'DISCOUNT', 'PRICE'].includes(kind)) {
      throw new BadRequestException('Tipo de ajuste inválido (CHARGE, DISCOUNT o PRICE)');
    }
    const concept = String(dto?.concept ?? '').trim().slice(0, 140);
    if (!concept) throw new BadRequestException('Escribe el concepto del ajuste');
    const startPeriod = this.assertPeriod(dto?.startPeriod);
    const endPeriod = dto?.endPeriod ? this.assertPeriod(dto.endPeriod) : null;
    if (endPeriod && endPeriod < startPeriod) {
      throw new BadRequestException('El mes final no puede ser anterior al inicial');
    }
    const percent = dto?.percent === null || dto?.percent === undefined || dto?.percent === ''
      ? null
      : Number(dto.percent);
    if (percent != null && (!Number.isFinite(percent) || percent <= 0 || percent > 100)) {
      throw new BadRequestException('El porcentaje debe estar entre 0 y 100');
    }
    if (percent != null && kind !== 'DISCOUNT') {
      throw new BadRequestException('El porcentaje solo aplica a descuentos');
    }
    const amount = Number(dto?.amount ?? 0);
    if (percent == null && (!Number.isFinite(amount) || amount < 0)) {
      throw new BadRequestException('El valor debe ser un número mayor o igual a 0');
    }
    return {
      kind, concept, amount: percent == null ? amount : 0, percent,
      startPeriod, endPeriod, recurring: !!dto?.recurring && !endPeriod,
    };
  }

  async createAdjustment(user: AuthUser, companyId: string, dto: any) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const data = this.validateAdjustment(dto);
    const adj = await this.prisma.billingAdjustment.create({
      data: { companyId, ...data, createdBy: user.name },
    });
    await this.audit.log({
      actor: user, companyId, action: 'billing.adjustment_create',
      entity: 'BillingAdjustment', entityId: adj.id,
      detail: `${data.kind} · ${data.concept} · ${data.percent != null ? `${data.percent}%` : data.amount} · ${data.startPeriod}${data.endPeriod ? `→${data.endPeriod}` : data.recurring ? '→∞' : ''}`,
    });
    return adj;
  }

  async updateAdjustment(user: AuthUser, id: string, dto: any) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const existing = await this.prisma.billingAdjustment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Ajuste no encontrado');
    const data = dto?.active !== undefined && Object.keys(dto).length === 1
      ? { active: !!dto.active }
      : { ...this.validateAdjustment({ ...existing, ...dto }), ...(dto?.active !== undefined ? { active: !!dto.active } : {}) };
    const adj = await this.prisma.billingAdjustment.update({ where: { id }, data });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'billing.adjustment_update',
      entity: 'BillingAdjustment', entityId: id, detail: adj.concept,
    });
    return adj;
  }

  async removeAdjustment(user: AuthUser, id: string) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const existing = await this.prisma.billingAdjustment.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Ajuste no encontrado');
    await this.prisma.billingAdjustment.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'billing.adjustment_delete',
      entity: 'BillingAdjustment', entityId: id, detail: existing.concept,
    });
    return { ok: true };
  }

  /** Vista previa de varios meses (para ver cómo cambia el cobro). */
  async forecast(user: AuthUser, companyId: string, months = 3) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.companyWithPlan(scoped);
    const start = periodOf();
    const out: Array<{ period: string; total: number; lines: any[] }> = [];
    for (let i = 0; i < Math.min(Math.max(months, 1), 12); i++) {
      const p = shiftPeriod(start, i);
      const inv = await computeCompanyInvoice(this.prisma, company, p);
      out.push({ period: p, total: inv.total, lines: inv.lines });
    }
    return { currency: invoiceCurrency(company), months: out };
  }

  /* ── Facturas pendientes editables (solo plataforma) ─────────────── */

  async updateInvoice(user: AuthUser, id: string, dto: { lines?: any[]; notes?: string }) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const invoice = await this.prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (invoice.status === 'PAID') throw new BadRequestException('Una factura pagada no se edita');
    const data: Record<string, any> = {};
    if (dto.lines !== undefined) {
      const lines = sanitizeLines(dto.lines, invoice.currency);
      if (lines.length === 0) throw new BadRequestException('La factura necesita al menos una línea');
      const totals = summarize(lines, invoice.currency);
      Object.assign(data, {
        linesJson: JSON.stringify(lines),
        planAmount: totals.planAmount,
        consumptionAmount: totals.consumptionAmount,
        totalAmount: totals.total,
      });
    }
    if (dto.notes !== undefined) data.notes = String(dto.notes).slice(0, 500) || null;
    const updated = await this.prisma.invoice.update({ where: { id }, data });
    await this.audit.log({
      actor: user, companyId: invoice.companyId, action: 'billing.invoice_edit',
      entity: 'Invoice', entityId: id,
      detail: `${invoice.period}: ${invoice.totalAmount} → ${updated.totalAmount} ${invoice.currency}`,
    });
    return { ...updated, lines: parseJson<any[]>(updated.linesJson, []) };
  }

  /** Emite (o reemplaza si sigue pendiente) la factura de un mes con el cálculo actual. */
  async issueInvoice(user: AuthUser, companyId: string, period: string) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const p = this.assertPeriod(period);
    const company = await this.companyWithPlan(companyId);
    const existing = await this.prisma.invoice.findFirst({ where: { companyId, period: p } });
    if (existing?.status === 'PAID') throw new BadRequestException('Ese mes ya está pagado');
    const inv = await computeCompanyInvoice(this.prisma, company, p);
    const data = {
      planAmount: inv.planAmount, consumptionAmount: inv.consumptionAmount, totalAmount: inv.total,
      currency: invoiceCurrency(company), linesJson: JSON.stringify(inv.lines),
    };
    // Una factura por empresa y mes: el _id sale de ambos (dos emisiones a la vez no crean dos)
    const id = deterministicId('inv', companyId, p);
    let invoice: any;
    if (existing) {
      // Solo se recalcula si sigue pendiente (compare-and-set: un pago simultáneo no se pisa)
      const r = await this.prisma.invoice.updateMany({ where: { id: existing.id, status: { not: 'PAID' } }, data });
      if (r.count !== 1) throw new BadRequestException('Ese mes ya está pagado');
      invoice = await this.prisma.invoice.findUniqueOrThrow({ where: { id: existing.id } });
    } else {
      try {
        invoice = await this.prisma.invoice.create({ data: { id, companyId, period: p, status: 'PENDING', ...data } });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
        throw new BadRequestException('Esa factura se acaba de emitir: recarga para verla');
      }
    }
    await this.subscriptions?.onInvoiceIssued(companyId, invoice);
    await this.audit.log({
      actor: user, companyId, action: existing ? 'billing.invoice_recalc' : 'billing.invoice_issue',
      entity: 'Invoice', entityId: invoice.id, detail: `${p} · ${inv.total} ${data.currency}`,
    });
    return { ...invoice, lines: inv.lines };
  }
}

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string, @Query('period') period?: string) {
    return this.billing.summary(user, companyId, period);
  }

  @Get('invoices')
  invoices(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.billing.invoices(user, companyId);
  }

  @Get('forecast')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  forecast(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string, @Query('months') months?: string) {
    return this.billing.forecast(user, companyId ?? '', Number(months) || 3);
  }

  @Get('adjustments')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  adjustments(@CurrentUser() user: AuthUser, @Query('companyId') companyId: string) {
    return this.billing.listAdjustments(user, companyId);
  }

  @Post('adjustments')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  createAdjustment(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.billing.createAdjustment(user, dto?.companyId, dto);
  }

  @Patch('adjustments/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  updateAdjustment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.billing.updateAdjustment(user, id, dto);
  }

  @Delete('adjustments/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  removeAdjustment(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.billing.removeAdjustment(user, id);
  }

  @Patch('invoices/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  updateInvoice(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.billing.updateInvoice(user, id, dto);
  }

  @Post('invoices/issue')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  issueInvoice(@CurrentUser() user: AuthUser, @Body() dto: { companyId: string; period: string }) {
    return this.billing.issueInvoice(user, dto?.companyId, dto?.period);
  }
}

@Module({
  imports: [SubscriptionsModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
