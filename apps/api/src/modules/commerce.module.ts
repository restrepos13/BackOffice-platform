import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Param, Patch, Post, Put, Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { addonCatalog, cancelDeadline, isAddonKey, modulesWithAddons, readAddonStates, saveAddonCatalog } from '../common/addons';
import { periodOf, shiftPeriod } from '../common/billing-engine';
import { HUMAN_OVERSIGHT_NOTICE, LANDING_NOTICE, META_NOTICE, NUMBERS_NOTICE, REFERRAL, SERVICE_MODES, planPriceFor, serviceModeOf } from '../common/offer';
import { AuditModule, AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Lo que la empresa contrata además del plan:
 *  - Complementos: la empresa los pide (el equipo los configura y activa) y los
 *    apaga ella misma cuando quiera; si lo hace antes del día de pago, el mes
 *    siguiente ya no se cobra.
 *  - Landing de regalo de la primera suscripción: el equipo la construye y la
 *    marca como entregada con su enlace.
 *  - Referidos: cada empresa tiene su enlace; si la empresa referida paga 2
 *    meses, la que la trajo recibe 20 % de descuento por 2 meses (automático).
 */

/** Código de referido en el registro → la empresa nueva queda enlazada a quien la invitó. */
export async function linkReferral(prisma: any, companyId: string, code: unknown) {
  const clean = String(code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(clean)) return false;
  const referrer = await prisma.company.findFirst({ where: { referralCode: clean } });
  if (!referrer || referrer.id === companyId) return false;
  await prisma.company.update({ where: { id: companyId }, data: { referredById: referrer.id, referralJson: JSON.stringify({ status: 'PENDING', code: clean }) } });
  return true;
}

const LANDING_STATUSES = ['PENDING', 'BUILDING', 'DELIVERED'] as const;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

@Injectable()
export class CommerceService {
  private readonly logger = new Logger('Commerce');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
  ) {}

  private companyIdOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  private async team(subject: string, body: string) {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } });
    const raw = row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || 'restrepos591@gmail.com';
    for (const toEmail of raw.split(',').map((e: string) => e.trim()).filter(Boolean).slice(0, 10)) {
      await this.emails.systemSend({ toEmail, subject, body }).catch((err: any) => this.logger.warn(`aviso no enviado: ${err.message}`));
    }
  }

  /* ── Complementos: lado de la empresa ──────────────────────────── */

  async addons(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const [catalog, states] = [await addonCatalog(this.prisma), readAddonStates(company)];
    const deadline = cancelDeadline();
    return {
      deadline,
      nextBillingDay: new Date(deadline.getTime() + 1),
      addons: catalog.map((a) => {
        const st = states[a.key];
        return {
          ...a,
          active: !!st?.enabled,
          qty: st?.qty ?? 1,
          since: st?.since ?? null,
          until: st?.until ?? null,
          requested: !!st?.requestedAt && !st?.enabled,
          monthly: st?.enabled ? (st.price ?? a.price) * (a.perUnit ? Math.max(1, st.qty ?? 1) : 1) : 0,
        };
      }),
    };
  }

  async request(user: AuthUser, key: string, dto: { qty?: number; companyId?: string }) {
    if (!isAddonKey(key)) throw new NotFoundException('Ese complemento no existe');
    const id = this.companyIdOf(user, dto?.companyId);
    const def = (await addonCatalog(this.prisma)).find((a) => a.key === key)!;
    if (def.status !== 'AVAILABLE') throw new BadRequestException(`${def.name} estará disponible próximamente`);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const states = readAddonStates(company);
    if (states[key]?.enabled) throw new BadRequestException('Ya lo tienes activo');
    const qty = def.perUnit ? Math.min(10, Math.max(1, Math.round(Number(dto?.qty) || 1))) : 1;
    states[key] = { ...(states[key] ?? { enabled: false }), enabled: false, qty, requestedAt: new Date().toISOString() };
    await this.prisma.company.update({ where: { id }, data: { addonsJson: JSON.stringify(states) } });
    await this.audit.log({ actor: user, companyId: id, action: 'addon.request', entity: 'Company', entityId: id, detail: `${def.name}${qty > 1 ? ` x${qty}` : ''}` });
    await this.team(
      `Complemento pedido: ${company.name} quiere ${def.name}${qty > 1 ? ` x${qty}` : ''}`,
      `<p><b>${esc(company.name)}</b> pidió el complemento <b>${esc(def.name)}</b>${qty > 1 ? ` (${qty} ${def.perUnit}s)` : ''}: $${(def.price * qty).toLocaleString('es-CO')} al mes.</p><p>Configúralo y actívalo en Plataforma → Ventas → Complementos.</p>`,
    );
    return this.addons(user, id);
  }

  /** La empresa lo apaga cuando quiera: se cobra solo hasta el mes en curso. */
  async cancel(user: AuthUser, key: string, dto: { companyId?: string }) {
    if (!isAddonKey(key)) throw new NotFoundException('Ese complemento no existe');
    const id = this.companyIdOf(user, dto?.companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const states = readAddonStates(company);
    const st = states[key];
    if (!st?.enabled && !st?.requestedAt) throw new BadRequestException('Ese complemento no está activo');
    states[key] = { ...st, enabled: false, requestedAt: null, ...(st?.enabled ? { until: new Date().toISOString() } : {}) };
    await this.prisma.company.update({
      where: { id },
      data: { addonsJson: JSON.stringify(states), modulesJson: JSON.stringify(modulesWithAddons(parseJson<string[]>(company.modulesJson, []), states)) },
    });
    await this.audit.log({ actor: user, companyId: id, action: 'addon.cancel', entity: 'Company', entityId: id, detail: key });
    return this.addons(user, id);
  }

  /* ── Complementos: lado del equipo ─────────────────────────────── */

  async setAddon(actor: AuthUser, companyId: string, key: string, dto: { enabled?: boolean; qty?: number; price?: number | null }) {
    if (!isAddonKey(key)) throw new NotFoundException('Ese complemento no existe');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const def = (await addonCatalog(this.prisma)).find((a) => a.key === key)!;
    const states = readAddonStates(company);
    const prev = states[key] ?? { enabled: false };
    const now = new Date().toISOString();
    const enabled = dto.enabled ?? prev.enabled;
    states[key] = {
      ...prev,
      enabled,
      ...(dto.qty != null && def.perUnit ? { qty: Math.min(10, Math.max(1, Math.round(Number(dto.qty)))) } : {}),
      ...(dto.price !== undefined ? { price: dto.price == null ? undefined : Math.max(0, Number(dto.price)) } : {}),
      ...(enabled && !prev.enabled ? { since: now, until: null, requestedAt: null } : {}),
      ...(!enabled && prev.enabled ? { until: now } : {}),
    };
    // Cada complemento con sección propia aparece (o se oculta) en el menú de la empresa
    let modules = modulesWithAddons(parseJson<string[]>(company.modulesJson, []), states);
    if (key === 'social' && enabled && !modules.includes('marketing')) modules = [...modules, 'marketing'];
    const data: Record<string, any> = { addonsJson: JSON.stringify(states), modulesJson: JSON.stringify(modules) };
    await this.prisma.company.update({ where: { id: companyId }, data });
    await this.audit.log({ actor, companyId, action: enabled ? 'addon.activate' : 'addon.deactivate', entity: 'Company', entityId: companyId, detail: def.name });
    return this.addons(actor, companyId);
  }

  async requests() {
    const companies = await this.prisma.company.findMany({ where: { addonsJson: { contains: 'requestedAt' } }, select: { id: true, name: true, addonsJson: true } });
    const catalog = await addonCatalog(this.prisma);
    const out: any[] = [];
    for (const c of companies) {
      const states = readAddonStates(c);
      for (const [key, st] of Object.entries(states)) {
        if (!st?.requestedAt || st.enabled) continue;
        const def = catalog.find((a) => a.key === key);
        out.push({ companyId: c.id, companyName: c.name, key, name: def?.name ?? key, qty: st.qty ?? 1, monthly: (def?.price ?? 0) * (def?.perUnit ? st.qty ?? 1 : 1), requestedAt: st.requestedAt });
      }
    }
    return out.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  }

  async catalog() {
    return addonCatalog(this.prisma);
  }

  async saveCatalog(actor: AuthUser, dto: any) {
    const r = await saveAddonCatalog(this.prisma, dto?.overrides ?? {});
    await this.audit.log({ actor, action: 'addon.catalog', entity: 'PlatformSetting', entityId: 'ADDON_CATALOG', detail: 'Precios de complementos' });
    return r;
  }

  /** Resumen de "Mi plan": plan, modalidad, qué incluye y cuándo se cobra. */
  async planSummary(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company: any = await this.prisma.company.findUniqueOrThrow({ where: { id }, include: { plan: true } });
    const mode = serviceModeOf(company);
    const deadline = cancelDeadline();
    return {
      company: { name: company.name, status: company.status },
      plan: company.plan
        ? { name: company.plan.name, line: company.plan.line, maxLines: company.plan.maxLines, maxUsers: company.plan.maxUsers, price: company.plan.line === 'WPP' ? planPriceFor(company.plan, mode) : company.customPriceMonthly ?? company.plan.priceMonthly, includedMetaUsd: company.plan.includedMetaUsd ?? 10 }
        : null,
      serviceMode: mode,
      mode: SERVICE_MODES[mode],
      billingCycle: company.billingCycle ?? 'MONTHLY',
      nextBillingDay: new Date(deadline.getTime() + 1),
      notices: { humanOversight: HUMAN_OVERSIGHT_NOTICE, numbers: NUMBERS_NOTICE, meta: META_NOTICE },
    };
  }

  /** Planes vigentes para la portada pública (sin datos internos). */
  async publicPlans() {
    const plans = await this.prisma.plan.findMany({ where: { active: true, line: 'WPP' }, orderBy: { sortOrder: 'asc' } });
    const catalog = await addonCatalog(this.prisma);
    return {
      plans: plans.map((p: any) => ({
        name: p.name, tier: p.tier, maxLines: p.maxLines, priceSelf: p.priceMonthly, priceManaged: planPriceFor(p, 'MANAGED'),
        includedMetaUsd: p.includedMetaUsd ?? 10, highlight: p.highlight, features: parseJson<string[]>(p.featuresJson, []),
      })),
      modes: SERVICE_MODES,
      addons: catalog.map((a) => ({ name: a.name, description: a.description, price: a.price, perUnit: a.perUnit ?? null, status: a.status })),
      notices: { numbers: NUMBERS_NOTICE, meta: META_NOTICE, landing: LANDING_NOTICE, humanOversight: HUMAN_OVERSIGHT_NOTICE },
    };
  }

  /* ── Landing de regalo ─────────────────────────────────────────── */

  async landing(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const l = parseJson<Record<string, any>>(company.landingJson, {});
    return { status: l.status ?? null, url: l.url ?? null, deliveredAt: l.deliveredAt ?? null, notice: LANDING_NOTICE };
  }

  async setLanding(actor: AuthUser, companyId: string, dto: { status?: string; url?: string; notes?: string }) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const l = parseJson<Record<string, any>>(company.landingJson, {});
    const status = (LANDING_STATUSES as readonly string[]).includes(String(dto.status)) ? String(dto.status) : l.status ?? 'PENDING';
    const url = dto.url !== undefined ? String(dto.url).trim().slice(0, 300) : l.url;
    if (url && !/^https:\/\/[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(url)) throw new BadRequestException('El enlace debe empezar por https:// (ej. https://negocio.vercel.app)');
    if (status === 'DELIVERED' && !url) throw new BadRequestException('Para marcarla entregada pon el enlace de la landing');
    const next = { ...l, status, url: url || null, notes: dto.notes !== undefined ? String(dto.notes).slice(0, 1000) : l.notes, ...(status === 'DELIVERED' && l.status !== 'DELIVERED' ? { deliveredAt: new Date().toISOString() } : {}) };
    await this.prisma.company.update({ where: { id: companyId }, data: { landingJson: JSON.stringify(next) } });
    await this.audit.log({ actor, companyId, action: 'landing.update', entity: 'Company', entityId: companyId, detail: `${status}${url ? ` · ${url}` : ''}` });
    return next;
  }

  async landings() {
    const rows = await this.prisma.company.findMany({ where: { landingJson: { contains: 'status' } }, select: { id: true, name: true, landingJson: true } });
    return rows.map((c: any) => ({ companyId: c.id, companyName: c.name, ...parseJson<Record<string, any>>(c.landingJson, {}) }))
      .sort((a: any, b: any) => (a.status === 'DELIVERED' ? 1 : 0) - (b.status === 'DELIVERED' ? 1 : 0));
  }

  /* ── Referidos ─────────────────────────────────────────────────── */

  private async ensureCode(company: any): Promise<string> {
    if (company.referralCode) return company.referralCode;
    for (let i = 0; i < 5; i++) {
      const code = randomBytes(4).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
      if (code.length < 6) continue;
      if (await this.prisma.company.findFirst({ where: { referralCode: code } })) continue;
      await this.prisma.company.update({ where: { id: company.id }, data: { referralCode: code } });
      return code;
    }
    throw new BadRequestException('No se pudo crear el código, intenta de nuevo');
  }

  async referrals(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const code = await this.ensureCode(company);
    const referred = await this.prisma.company.findMany({ where: { referredById: id }, select: { id: true, name: true, createdAt: true, status: true, referralJson: true } });
    const paid = await Promise.all(referred.map((r: any) => this.prisma.invoice.count({ where: { companyId: r.id, status: 'PAID' } })));
    return {
      code,
      rule: REFERRAL,
      referred: referred.map((r: any, i: number) => {
        const st = parseJson<Record<string, any>>(r.referralJson, {});
        return { name: r.name, joinedAt: r.createdAt, paidMonths: paid[i], status: st.status === 'REWARDED' ? 'REWARDED' : 'PENDING', rewardedAt: st.rewardedAt ?? null };
      }),
    };
  }


  /** Cada día: referidas con 2 meses pagos → 20 % de descuento x 2 meses a quien las trajo. */
  @Cron('15 6 * * *')
  async rewardReferrals() {
    const pending = await this.prisma.company.findMany({ where: { referredById: { not: null }, referralJson: { contains: '"PENDING"' } } }).catch(() => []);
    for (const c of pending as any[]) {
      const paid = await this.prisma.invoice.count({ where: { companyId: c.id, status: 'PAID' } });
      if (paid < REFERRAL.minPaidMonths) continue;
      const referrer = await this.prisma.company.findUnique({ where: { id: c.referredById } });
      if (!referrer) continue;
      const start = shiftPeriod(periodOf(), 1);
      const adj = await this.prisma.billingAdjustment.create({
        data: {
          companyId: referrer.id, kind: 'DISCOUNT', concept: `Premio por referir a ${c.name}`, amount: 0, percent: REFERRAL.discountPercent,
          startPeriod: start, endPeriod: shiftPeriod(start, REFERRAL.months - 1), recurring: false, active: true, createdBy: 'Programa de referidos',
        },
      });
      await this.prisma.company.update({
        where: { id: c.id },
        data: { referralJson: JSON.stringify({ ...parseJson<Record<string, any>>(c.referralJson, {}), status: 'REWARDED', rewardedAt: new Date().toISOString(), adjustmentId: adj.id }) },
      });
      await this.audit.log({ actor: null as any, companyId: referrer.id, action: 'referral.reward', entity: 'BillingAdjustment', entityId: adj.id, detail: `${REFERRAL.discountPercent}% x ${REFERRAL.months} meses por ${c.name}` });
      await this.team(`Referido premiado: ${referrer.name} trajo a ${c.name}`, `<p>${esc(c.name)} ya pagó ${paid} meses. Se aplicó a <b>${esc(referrer.name)}</b> un ${REFERRAL.discountPercent}% de descuento desde ${start} por ${REFERRAL.months} meses.</p>`);
    }
  }
}

@Controller()
export class CommerceController {
  constructor(private readonly commerce: CommerceService) {}

  @Get('company/addons')
  addons(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.commerce.addons(user, companyId);
  }

  @Post('company/addons/:key/request')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  request(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() dto: any) {
    return this.commerce.request(user, key, dto ?? {});
  }

  @Post('company/addons/:key/cancel')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  cancel(@CurrentUser() user: AuthUser, @Param('key') key: string, @Body() dto: any) {
    return this.commerce.cancel(user, key, dto ?? {});
  }

  @Public()
  @Get('public/plans')
  publicPlans() {
    return this.commerce.publicPlans();
  }

  @Get('company/plan')
  planSummary(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.commerce.planSummary(user, companyId);
  }

  @Get('company/landing')
  landing(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.commerce.landing(user, companyId);
  }

  @Get('company/referrals')
  referrals(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.commerce.referrals(user, companyId);
  }

  @Patch('platform/companies/:id/addons/:key')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  setAddon(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('key') key: string, @Body() dto: any) {
    return this.commerce.setAddon(user, id, key, dto ?? {});
  }

  @Get('platform/addon-requests')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  requests() {
    return this.commerce.requests();
  }

  @Get('platform/addon-catalog')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  catalog() {
    return this.commerce.catalog();
  }

  @Put('platform/addon-catalog')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  saveCatalog(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.commerce.saveCatalog(user, dto);
  }

  @Get('platform/landings')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  landings() {
    return this.commerce.landings();
  }

  @Patch('platform/companies/:id/landing')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  setLanding(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.commerce.setLanding(user, id, dto ?? {});
  }
}

@Module({
  imports: [AuditModule, EmailsModule],
  controllers: [CommerceController],
  providers: [CommerceService],
  exports: [CommerceService],
})
export class CommerceModule {}
