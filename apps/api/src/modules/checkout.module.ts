import {
  BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException,
  Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { ANNUAL_MONTHS_CHARGED, periodOf } from '../common/billing-engine';
import { recommendPlan } from '../common/plan-recommend';
import { estimateAiCosts } from '../common/ai-cost';
import { addonCatalog, isAddonKey, modulesWithAddons, readAddonStates } from '../common/addons';
import {
  AI_RESALE_MARKUP, HUMAN_OVERSIGHT_NOTICE, LANDING_NOTICE, MAX_IMPLEMENTATION_DAYS, META_NOTICE, NUMBERS_NOTICE,
  SERVICE_MODES, type ServiceMode, planPriceFor,
} from '../common/offer';
import { ensureFile, removeFile, saveFile } from '../common/file-store';
import { AuditModule, AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Compra del plan desde el panel de la empresa.
 *  - La empresa ve el plan y el paquete de IA recomendados (por código), elige
 *    y "compra": NO se le muestran cuentas ni QR; ve un mensaje de que el equipo
 *    la contacta para terminar. Así se cuida el dato bancario y se hace la venta.
 *  - El equipo ve el pedido en Plataforma → Ventas, le escribe con los datos de
 *    pago (QR Bancolombia o cuenta de ahorros configurados aquí), confirma el
 *    pago y activa: plan, ciclo, paquete de IA y empresa ACTIVA en un clic.
 *  - Wompi sigue integrado pero se muestra como "próximamente".
 */

const METHODS_KEY = 'PAYMENT_METHODS';
const PLATFORM_FILES = 'platform';
const STATUSES = ['REQUESTED', 'CONTACTED', 'AWAITING_PAYMENT', 'PAID', 'ACTIVE', 'CANCELLED'] as const;

export interface BankAccount {
  id: string;
  bank: string;
  type: string;
  number: string;
  holder: string;
  document: string;
  owner: string;
}

export interface PaymentMethods {
  qr: { enabled: boolean; bank: string; holder: string; imageFile: string | null; note: string };
  accounts: BankAccount[];
  wompi: { status: 'COMING_SOON' | 'ACTIVE' };
  instructions: string;
}

const DEFAULT_METHODS: PaymentMethods = {
  qr: { enabled: false, bank: 'Bancolombia', holder: '', imageFile: null, note: '' },
  accounts: [],
  wompi: { status: 'COMING_SOON' },
  instructions: 'Envía el comprobante por este mismo chat y activamos tu cuenta el mismo día hábil.',
};

const money = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger('Checkout');

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

  /* ── Métodos de pago (los configura el equipo) ─────────────────── */

  async methods(): Promise<PaymentMethods> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: METHODS_KEY } });
    const saved = parseJson<Partial<PaymentMethods>>(row?.value, {});
    return {
      ...DEFAULT_METHODS,
      ...saved,
      qr: { ...DEFAULT_METHODS.qr, ...(saved.qr ?? {}) },
      wompi: { status: saved.wompi?.status === 'ACTIVE' ? 'ACTIVE' : 'COMING_SOON' },
      accounts: Array.isArray(saved.accounts) ? saved.accounts : [],
    };
  }

  private async writeMethods(m: PaymentMethods) {
    const value = JSON.stringify(m);
    const existing = await this.prisma.platformSetting.findUnique({ where: { key: METHODS_KEY } });
    if (existing) await this.prisma.platformSetting.update({ where: { key: METHODS_KEY }, data: { value } });
    else await this.prisma.platformSetting.create({ data: { key: METHODS_KEY, value } });
  }

  async saveMethods(actor: AuthUser, dto: any) {
    const current = await this.methods();
    const str = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
    const accounts: BankAccount[] = (Array.isArray(dto?.accounts) ? dto.accounts : []).slice(0, 6).map((a: any, i: number) => ({
      id: str(a?.id, 40) || `cuenta-${Date.now()}-${i}`,
      bank: str(a?.bank, 40),
      type: str(a?.type, 20) || 'Ahorros',
      number: str(a?.number, 30).replace(/[^\d-]/g, ''),
      holder: str(a?.holder, 80),
      document: str(a?.document, 30),
      owner: str(a?.owner, 40),
    }));
    for (const a of accounts) {
      if (!a.bank || a.number.replace(/\D/g, '').length < 6 || !a.holder) {
        throw new BadRequestException('Cada cuenta necesita banco, número (mínimo 6 dígitos) y titular');
      }
    }
    const next: PaymentMethods = {
      qr: {
        enabled: dto?.qr?.enabled === true,
        bank: str(dto?.qr?.bank, 40) || 'Bancolombia',
        holder: str(dto?.qr?.holder, 80),
        note: str(dto?.qr?.note, 200),
        imageFile: current.qr.imageFile,
      },
      accounts,
      wompi: { status: 'COMING_SOON' },
      instructions: str(dto?.instructions, 500) || DEFAULT_METHODS.instructions,
    };
    if (next.qr.enabled && !next.qr.imageFile) throw new BadRequestException('Sube primero la imagen del QR');
    await this.writeMethods(next);
    await this.audit.log({ actor, action: 'payments.methods', entity: 'PlatformSetting', entityId: METHODS_KEY, detail: `QR ${next.qr.enabled ? 'activo' : 'apagado'} · ${accounts.length} cuentas` });
    return next;
  }

  async uploadQr(actor: AuthUser, file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('Elige la imagen del QR');
    if (!/^image\/(png|jpe?g|webp)$/.test(file.mimetype)) throw new BadRequestException('El QR debe ser una imagen PNG, JPG o WEBP');
    if (file.size > 3 * 1024 * 1024) throw new BadRequestException('La imagen pesa más de 3 MB');
    const current = await this.methods();
    const name = `qr-pagos-${Date.now()}.${file.mimetype.includes('png') ? 'png' : file.mimetype.includes('webp') ? 'webp' : 'jpg'}`;
    await saveFile(this.prisma, PLATFORM_FILES, name, file.buffer, file.mimetype);
    if (current.qr.imageFile) await removeFile(this.prisma, PLATFORM_FILES, current.qr.imageFile);
    await this.writeMethods({ ...current, qr: { ...current.qr, imageFile: name } });
    await this.audit.log({ actor, action: 'payments.qr', entity: 'PlatformSetting', entityId: METHODS_KEY, detail: 'QR de pagos actualizado' });
    return this.methods();
  }

  async qrPath() {
    const m = await this.methods();
    if (!m.qr.imageFile) throw new NotFoundException('Aún no hay QR');
    const path = await ensureFile(this.prisma, PLATFORM_FILES, m.qr.imageFile);
    if (!path) throw new NotFoundException('No se encontró la imagen del QR');
    return path;
  }

  /* ── Lado de la empresa ────────────────────────────────────────── */

  private async needsOf(company: any) {
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const modules = Array.isArray(ob.modules) && ob.modules.length ? ob.modules : parseJson<string[]>(company.modulesJson, []);
    const users = await this.prisma.user.count({ where: { companyId: company.id, active: true } });
    const lines = await this.prisma.integration.count({ where: { companyId: company.id, type: 'WHATSAPP' } });
    return {
      dailyChats: Number(ob.dailyChats) > 0 ? Number(ob.dailyChats) : 20,
      modules,
      users: Math.max(1, users),
      lines: Math.max(1, lines),
    };
  }

  /** Costo estimado de la IA al mes con el modelo recomendado (para "Todo incluido"). */
  private async aiMonthlyEstimate(company: any, dailyChats: number) {
    const [models, bot, products, rate] = await Promise.all([
      this.prisma.aiModel.findMany({ where: { active: true } }),
      this.prisma.bot.findFirst({ where: { companyId: company.id } }),
      this.prisma.product.count({ where: { companyId: company.id, active: true } }),
      this.prisma.platformSetting.findUnique({ where: { key: 'USD_COP_RATE' } }),
    ]);
    const model = models.find((m: any) => m.modelId === bot?.model) ?? models.find((m: any) => m.recommended) ?? models[0];
    if (!model) return null;
    const trm = Number(rate?.value) > 1000 ? Number(rate!.value) : 4000;
    const est = estimateAiCosts(
      {
        promptChars: String(bot?.systemPrompt ?? '').length + String(bot?.personalityJson ?? '').length || 1500,
        knowledgeChars: 0, products, dailyChats, agentMode: bot?.engineMode === 'AGENT', trm,
      },
      [{ ...model, creditsPerConversation: 1 }],
      [],
    );
    const m = est.models[0];
    // El margen va adentro del estimado (no se desglosa)
    return { model: model.name, monthly: Math.round(m.perMonth.cop * (1 + AI_RESALE_MARKUP)) };
  }

  async checkout(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const [plansRaw, methods, lastOrder, catalog, firstPaid] = await Promise.all([
      this.prisma.plan.findMany({ where: { active: true, line: 'WPP' }, orderBy: { sortOrder: 'asc' } }),
      this.methods(),
      this.prisma.planOrder.findFirst({ where: { companyId: id, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' } }),
      addonCatalog(this.prisma),
      this.prisma.planOrder.count({ where: { companyId: id, status: 'ACTIVE' } }),
    ]);
    const plans = plansRaw.map((p: any) => ({
      id: p.id, name: p.name, tier: p.tier, priceSelf: p.priceMonthly, priceManaged: planPriceFor(p, 'MANAGED'),
      annualSelf: p.priceMonthly * ANNUAL_MONTHS_CHARGED, annualManaged: planPriceFor(p, 'MANAGED') * ANNUAL_MONTHS_CHARGED,
      maxUsers: p.maxUsers, maxLines: p.maxLines, maxCouriers: p.maxCouriers, sortOrder: p.sortOrder, highlight: p.highlight,
      minTermMonths: p.minTermMonths, includedMetaUsd: p.includedMetaUsd ?? 10, features: parseJson<string[]>(p.featuresJson, []),
    }));
    const needs = await this.needsOf(company);
    const plan = recommendPlan(plans.map((p) => ({ ...p, priceMonthly: p.priceSelf })), needs);
    const hasOwnKey = !!company.deepinfraApiKey;
    const states = readAddonStates(company);
    return {
      plans,
      modes: SERVICE_MODES,
      needs,
      recommendation: {
        plan,
        serviceMode: (hasOwnKey ? 'SELF' : 'MANAGED') as ServiceMode,
        modeReason: hasOwnKey
          ? 'Ya tienes tu propia cuenta de IA conectada: con "Tu IA" pagas menos de mensualidad.'
          : 'No tienes que crear cuentas ni poner tarjetas en otros sitios: nosotros gestionamos la IA y los mensajes, y pagas a fin de mes.',
        aiEstimate: await this.aiMonthlyEstimate(company, needs.dailyChats),
      },
      addons: catalog.map((a) => ({ ...a, active: !!states[a.key]?.enabled, requested: !!states[a.key]?.requestedAt && !states[a.key]?.enabled })),
      landingGift: firstPaid === 0,
      notices: {
        humanOversight: HUMAN_OVERSIGHT_NOTICE,
        numbers: NUMBERS_NOTICE,
        meta: META_NOTICE,
        landing: LANDING_NOTICE,
        implementation: `Tu automatización sale en vivo en máximo ${MAX_IMPLEMENTATION_DAYS} días.`,
        metaFree: 'Responder a quien te escribe no tiene costo de Meta. Meta cobra por los mensajes que tú inicias (campañas, recordatorios).',
      },
      // A la empresa solo le decimos QUÉ medios hay; los datos los envía el equipo
      paymentOptions: [
        { id: 'TRANSFER', label: 'Transferencia a cuenta de ahorros', available: methods.accounts.length > 0 },
        { id: 'QR', label: 'Código QR Bancolombia', available: methods.qr.enabled },
        { id: 'WOMPI', label: 'Tarjeta, PSE o Nequi (Wompi)', available: false, comingSoon: true },
      ],
      order: lastOrder ? this.serialize(lastOrder) : null,
    };
  }

  async createOrder(user: AuthUser, dto: { planId?: string; billingCycle?: string; serviceMode?: string; addons?: Array<{ key: string; qty?: number }> }) {
    if (user.role !== ROLES.COMPANY_ADMIN && !isPlatformRole(user.role)) throw new ForbiddenException('Solo el administrador de la empresa puede comprar');
    const companyId = this.companyIdOf(user, (dto as any)?.companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const plan = await this.prisma.plan.findUnique({ where: { id: String(dto?.planId ?? '') } });
    if (!plan || !plan.active) throw new BadRequestException('Ese plan ya no está disponible. Elige otro.');
    const cycle = dto?.billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const mode: ServiceMode = dto?.serviceMode === 'MANAGED' ? 'MANAGED' : 'SELF';
    const catalog = await addonCatalog(this.prisma);
    const addons = (Array.isArray(dto?.addons) ? dto.addons : [])
      .filter((a) => isAddonKey(a?.key))
      .map((a) => {
        const def = catalog.find((c) => c.key === a.key)!;
        const qty = def.perUnit ? Math.min(10, Math.max(1, Math.round(Number(a.qty) || 1))) : 1;
        return { key: def.key, name: def.name, qty, price: def.price * qty, status: def.status };
      })
      .filter((a) => a.status === 'AVAILABLE');
    const monthly = planPriceFor(plan, mode);
    const planAmount = cycle === 'ANNUAL' ? monthly * ANNUAL_MONTHS_CHARGED : monthly;
    const addonsTotal = addons.reduce((s, a) => s + a.price, 0);
    const total = planAmount + addonsTotal;
    const view = await this.checkout(user, companyId);
    // Un solo pedido abierto por empresa: el nuevo reemplaza al anterior sin pagar
    await this.prisma.planOrder.updateMany({
      where: { companyId, status: { in: ['REQUESTED', 'CONTACTED', 'AWAITING_PAYMENT'] } },
      data: { status: 'CANCELLED', notes: 'Reemplazado por un pedido nuevo' },
    });
    const order = await this.prisma.planOrder.create({
      data: {
        companyId, planId: plan.id, planName: plan.name, billingCycle: cycle, planAmount, serviceMode: mode,
        addonsJson: JSON.stringify(addons.map(({ status: _s, ...a }) => a)),
        aiPackageAmount: addonsTotal,
        total, currency: 'COP', status: 'REQUESTED', requestedBy: user.name,
        recommendationJson: JSON.stringify({
          plan: view.recommendation.plan?.planName ?? null,
          followed: view.recommendation.plan?.planId === plan.id,
          serviceMode: view.recommendation.serviceMode,
          followedMode: view.recommendation.serviceMode === mode,
          aiEstimate: view.recommendation.aiEstimate?.monthly ?? null,
        }),
      },
    });
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    await this.prisma.company.update({
      where: { id: companyId },
      data: { onboardingJson: JSON.stringify({ ...ob, requestedPlan: { planId: plan.id, name: plan.name, priceMonthly: monthly, billingCycle: cycle, serviceMode: mode, amount: total, at: new Date().toISOString(), by: user.name, orderId: order.id } }) },
    });
    await this.audit.log({ actor: user, companyId, action: 'checkout.order', entity: 'PlanOrder', entityId: order.id, detail: `${plan.name} · ${SERVICE_MODES[mode].name} · ${cycle === 'ANNUAL' ? 'anual' : 'mensual'}${addons.length ? ` + ${addons.map((a) => a.name).join(', ')}` : ''} · ${money(total)}` });
    try {
      await this.notifyTeam(company, order, ob);
    } catch (err: any) {
      this.logger.warn(`aviso de compra no enviado: ${err.message}`);
    }
    return { ok: true, order: this.serialize(order) };
  }

  private async notifyTeam(company: any, order: any, ob: Record<string, any>) {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } });
    const raw = row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || 'restrepos591@gmail.com';
    const digits = String(ob.phone ?? company.contactPhone ?? '').replace(/\D/g, '');
    const wa = digits.length === 10 ? `57${digits}` : digits.length >= 11 ? digits : null;
    for (const toEmail of raw.split(',').map((e: string) => e.trim()).filter(Boolean).slice(0, 10)) {
      await this.emails.systemSend({
        toEmail,
        subject: `Compra: ${company.name} quiere ${order.planName} · ${SERVICE_MODES[(order.serviceMode as ServiceMode) ?? 'SELF'].name} (${money(order.total)})`,
        body: `<p><b>${esc(company.name)}</b> quiere comprar:</p>
          <ul><li>Plan ${esc(order.planName)} · ${SERVICE_MODES[(order.serviceMode as ServiceMode) ?? 'SELF'].name} · ${order.billingCycle === 'ANNUAL' ? 'anual' : 'mensual'}: ${money(order.planAmount)}</li>
          ${parseJson<any[]>(order.addonsJson, []).map((a) => `<li>Complemento ${esc(a.name)}${a.qty > 1 ? ` x${a.qty}` : ''}: ${money(a.price)}</li>`).join('')}</ul>
          <p><b>Total: ${money(order.total)}</b> (IVA incluido)</p>
          <p>Contacto: ${esc(ob.contactName ?? '')} · ${esc(company.contactEmail ?? '')}${wa ? ` · <a href="https://wa.me/${wa}">WhatsApp</a>` : ''}</p>
          <p>Escríbele con los datos de pago desde Plataforma → Ventas y activa la cuenta cuando pague.</p>`,
      });
    }
  }

  /* ── Lado del equipo ───────────────────────────────────────────── */

  serialize(o: any) {
    return {
      id: o.id, companyId: o.companyId, planId: o.planId, planName: o.planName, billingCycle: o.billingCycle,
      planAmount: o.planAmount, aiPackageId: o.aiPackageId, aiPackageName: o.aiPackageName, aiPackageAmount: o.aiPackageAmount,
      total: o.total, currency: o.currency, status: o.status, method: o.method ?? null, notes: o.notes ?? null,
      serviceMode: o.serviceMode ?? 'SELF', addons: parseJson<Array<{ key: string; name: string; qty: number; price: number }>>(o.addonsJson, []),
      recommendation: parseJson<Record<string, any>>(o.recommendationJson, {}), requestedBy: o.requestedBy ?? null,
      handledBy: o.handledBy ?? null, paidAt: o.paidAt ?? null, activatedAt: o.activatedAt ?? null,
      createdAt: o.createdAt, updatedAt: o.updatedAt,
    };
  }

  async listOrders(status?: string) {
    const where = status && status !== 'ALL'
      ? status === 'OPEN' ? { status: { in: ['REQUESTED', 'CONTACTED', 'AWAITING_PAYMENT', 'PAID'] } } : { status }
      : {};
    const orders = await this.prisma.planOrder.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const companies = await this.prisma.company.findMany({
      where: { id: { in: [...new Set(orders.map((o: any) => o.companyId))] } },
      select: { id: true, name: true, status: true, contactEmail: true, contactPhone: true, onboardingJson: true },
    });
    const byId = new Map(companies.map((c: any) => [c.id, c]));
    const methods = await this.methods();
    return {
      methods: { qr: methods.qr.enabled, accounts: methods.accounts.length },
      orders: orders.map((o: any) => {
        const c: any = byId.get(o.companyId);
        const ob = parseJson<Record<string, any>>(c?.onboardingJson, {});
        const digits = String(ob.phone ?? c?.contactPhone ?? '').replace(/\D/g, '');
        return {
          ...this.serialize(o),
          company: c ? { id: c.id, name: c.name, status: c.status, email: c.contactEmail, contactName: ob.contactName ?? null } : null,
          whatsapp: digits.length === 10 ? `57${digits}` : digits.length >= 11 ? digits : null,
        };
      }),
    };
  }

  /** Mensaje listo para WhatsApp con los datos de pago (lo envía el equipo). */
  async paymentMessage(id: string, method: 'TRANSFER' | 'QR') {
    const order = await this.prisma.planOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    const company = await this.prisma.company.findUnique({ where: { id: order.companyId } });
    const ob = parseJson<Record<string, any>>(company?.onboardingJson, {});
    const m = await this.methods();
    const first = String(ob.contactName ?? '').split(' ')[0];
    const lines = [
      `¡Hola${first ? ` ${first}` : ''}! Gracias por elegir BackOffice para ${company?.name ?? 'tu empresa'}.`,
      '',
      `Tu pedido: plan ${order.planName} · ${SERVICE_MODES[(order.serviceMode as ServiceMode) ?? 'SELF'].name} (${order.billingCycle === 'ANNUAL' ? 'anual, 12 meses por el precio de 10' : 'mensual'})${parseJson<any[]>(order.addonsJson, []).length ? ` + ${parseJson<any[]>(order.addonsJson, []).map((a) => a.name).join(', ')}` : ''}.`,
      `Total a pagar: ${money(order.total)} (IVA incluido).`,
      ...(order.serviceMode === 'MANAGED' ? ['A fin de cada mes se suma la IA que uses y, si pasa de los US$10 incluidos, el excedente de mensajes de Meta.'] : []),
      '',
    ];
    if (method === 'QR') {
      lines.push(`Puedes pagar escaneando el código QR de ${m.qr.bank}${m.qr.holder ? ` a nombre de ${m.qr.holder}` : ''} que te envío en la siguiente imagen.`);
      if (m.qr.note) lines.push(m.qr.note);
    } else {
      if (!m.accounts.length) throw new BadRequestException('Configura al menos una cuenta en Ventas → Métodos de pago');
      lines.push(m.accounts.length > 1 ? 'Puedes transferir a cualquiera de estas cuentas:' : 'Puedes transferir a esta cuenta:');
      for (const a of m.accounts) {
        lines.push(`• ${a.bank} · ${a.type} N.º ${a.number} · ${a.holder}${a.document ? ` · C.C./NIT ${a.document}` : ''}`);
      }
    }
    lines.push('', m.instructions);
    return { text: lines.join('\n') };
  }

  async updateOrder(actor: AuthUser, id: string, dto: { status?: string; method?: string; notes?: string }) {
    const order = await this.prisma.planOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (order.status === 'ACTIVE') throw new BadRequestException('Este pedido ya está activado');
    const data: Record<string, any> = { handledBy: actor.name };
    if (dto.status !== undefined) {
      if (!(STATUSES as readonly string[]).includes(dto.status) || dto.status === 'ACTIVE') throw new BadRequestException('Estado inválido (para activar usa "Activar cuenta")');
      data.status = dto.status;
      if (dto.status === 'PAID') data.paidAt = new Date();
    }
    if (dto.method !== undefined) data.method = ['QR', 'TRANSFER', 'WOMPI'].includes(dto.method) ? dto.method : null;
    if (dto.notes !== undefined) data.notes = String(dto.notes).slice(0, 2000);
    const row = await this.prisma.planOrder.update({ where: { id }, data });
    await this.audit.log({ actor, companyId: order.companyId, action: 'checkout.update', entity: 'PlanOrder', entityId: id, detail: data.status ?? 'notas' });
    return this.serialize(row);
  }

  /** Pago confirmado → plan, ciclo, paquete de IA y empresa ACTIVA. */
  async activate(actor: AuthUser, id: string) {
    const order = await this.prisma.planOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Pedido no encontrado');
    if (order.status === 'ACTIVE') return this.serialize(order);
    if (order.status === 'CANCELLED') throw new BadRequestException('Este pedido está cancelado');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: order.companyId } });
    const mode: ServiceMode = order.serviceMode === 'MANAGED' ? 'MANAGED' : 'SELF';
    const now = new Date().toISOString();
    const states = readAddonStates(company);
    for (const a of parseJson<Array<{ key: string; qty: number; price: number }>>(order.addonsJson, [])) {
      if (!isAddonKey(a.key)) continue;
      states[a.key] = { ...(states[a.key] ?? {}), enabled: true, qty: a.qty, since: now, until: null, requestedAt: null };
    }
    // Primera suscripción → landing de regalo (la arma el equipo)
    const firstTime = (await this.prisma.planOrder.count({ where: { companyId: order.companyId, status: 'ACTIVE' } })) === 0;
    const landing = parseJson<Record<string, any>>(company.landingJson, {});
    await this.prisma.company.update({
      where: { id: order.companyId },
      data: {
        planId: order.planId,
        status: 'ACTIVE',
        billingCycle: order.billingCycle,
        ...(order.billingCycle === 'ANNUAL' ? { annualStartPeriod: periodOf() } : {}),
        contractStartAt: new Date(),
        serviceMode: mode,
        // "Todo incluido" usa la IA de BackOffice; "Tu IA", la llave del cliente
        aiBillingMode: mode === 'MANAGED' ? 'PLATFORM' : 'BYOK',
        addonsJson: JSON.stringify(states),
        modulesJson: JSON.stringify(modulesWithAddons(parseJson<string[]>(company.modulesJson, []), states)),
        ...(firstTime && !landing.status ? { landingJson: JSON.stringify({ status: 'PENDING', createdAt: now }) } : {}),
      },
    });
    const row = await this.prisma.planOrder.update({
      where: { id },
      data: { status: 'ACTIVE', activatedAt: new Date(), paidAt: order.paidAt ?? new Date(), handledBy: actor.name },
    });
    await this.audit.log({ actor, companyId: order.companyId, action: 'checkout.activate', entity: 'PlanOrder', entityId: id, detail: `${order.planName} · ${SERVICE_MODES[mode].name} activado · ${money(order.total)}${firstTime ? ' · landing de regalo pendiente' : ''}` });
    return this.serialize(row);
  }
}

@Controller()
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Get('onboarding/checkout')
  view(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.checkout.checkout(user, companyId);
  }

  @Post('onboarding/checkout')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  order(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.checkout.createOrder(user, dto);
  }

  @Get('platform/payment-methods')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  methods() {
    return this.checkout.methods();
  }

  @Put('platform/payment-methods')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  saveMethods(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.checkout.saveMethods(user, dto);
  }

  @Post('platform/payment-methods/qr')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } }))
  uploadQr(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File) {
    return this.checkout.uploadQr(user, file);
  }

  @Get('platform/payment-methods/qr')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async qr(@Res() res: Response) {
    res.sendFile(await this.checkout.qrPath());
  }

  @Get('platform/plan-orders')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  list(@Query('status') status?: string) {
    return this.checkout.listOrders(status);
  }

  @Get('platform/plan-orders/:id/message')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  message(@Param('id') id: string, @Query('method') method?: string) {
    return this.checkout.paymentMessage(id, method === 'QR' ? 'QR' : 'TRANSFER');
  }

  @Patch('platform/plan-orders/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.checkout.updateOrder(user, id, dto ?? {});
  }

  @Post('platform/plan-orders/:id/activate')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  activate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.checkout.activate(user, id);
  }
}

@Module({
  imports: [AuditModule, EmailsModule],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
