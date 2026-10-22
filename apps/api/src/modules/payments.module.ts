import { isProductionHost } from '../common/team-notify';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson, scopeCompanyId } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { creditAiLot } from '../ai/ai-access';
import { buildCheckoutUrl, verifyEventSignature } from '../common/wompi';
import { ensureTrackingLink, orderCode, publicWebUrl } from '../common/tracking';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { usdCopRate } from '../common/trm';
import { Products } from '../auth/products.guard';

/**
 * Pagos con Wompi (Colombia):
 *  1. A BackOffice (cuenta de plataforma, settings WOMPI_*): mensualidad
 *     (factura en COP o USD convertido) y paquetes prepagos de IA.
 *  2. Pedidos de los clientes de cada empresa, con la cuenta Wompi PROPIA de
 *     la empresa (Company.paymentConfigJson, secretos cifrados) y su propio
 *     webhook /payments/wompi/<slug>/events firmado con SU events secret.
 * Internacional (Stripe): pendiente.
 */

const APPROVED = 'APPROVED';
const FAILED_STATES = ['DECLINED', 'VOIDED', 'ERROR'];

export interface CompanyPaymentConfig {
  provider?: 'WOMPI';
  env?: 'test' | 'prod';
  publicKey?: string;
  integritySecretEnc?: string;
  eventsSecretEnc?: string;
  /** Instrucciones de pago manual que el agente comparte (Nequi, transferencia…) */
  manualInstructions?: string;
  acceptCash?: boolean;
}

function readSecret(value?: string | null): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

function sealSecret(value: string): string {
  try {
    return encryptSecret(value);
  } catch {
    return value; // dev sin MASTER_ENCRYPTION_KEY
  }
}

/** Lo que el panel puede ver de la configuración de pagos (jamás secretos). */
export function serializePaymentConfig(raw: string | null | undefined) {
  const cfg = parseJson<CompanyPaymentConfig>(raw, {});
  return {
    provider: cfg.provider ?? null,
    env: cfg.env ?? 'test',
    publicKey: cfg.publicKey ?? null,
    hasIntegritySecret: !!cfg.integritySecretEnc,
    hasEventsSecret: !!cfg.eventsSecretEnc,
    onlineReady: !!cfg.publicKey,
    manualInstructions: cfg.manualInstructions ?? null,
    acceptCash: cfg.acceptCash ?? true,
  };
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly events?: EventsService,
  ) {}

  private async settings(): Promise<Record<string, string>> {
    const rows = await this.prisma.platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /* ── 1. Pagos a BackOffice ───────────────────────────────────────── */

  private async platformCheckout(input: {
    companyId: string; reference: string; amountInCents: number; amountUsd: number;
    purpose: 'INVOICE' | 'AI_CREDITS'; invoiceId?: string; meta?: Record<string, any>;
    redirectPath: string;
  }) {
    const cfg = await this.settings();
    const publicKey = cfg.WOMPI_PUBLIC_KEY || '';
    const env = cfg.WOMPI_ENV || 'test';
    const web = await publicWebUrl(this.prisma);
    const checkoutUrl = buildCheckoutUrl({
      publicKey: publicKey || `pub_${env}_PENDIENTE`,
      reference: input.reference,
      amountInCents: input.amountInCents,
      integritySecret: cfg.WOMPI_INTEGRITY_SECRET || null,
      redirectUrl: cfg.WOMPI_REDIRECT_URL || `${web}${input.redirectPath}`,
    });
    const payment = await this.prisma.payment.create({
      data: {
        companyId: input.companyId,
        invoiceId: input.invoiceId ?? null,
        provider: 'WOMPI',
        reference: input.reference,
        amountUsd: input.amountUsd,
        amountInCents: input.amountInCents,
        currency: 'COP',
        status: 'PENDING',
        checkoutUrl,
        purpose: input.purpose,
        metaJson: JSON.stringify(input.meta ?? {}),
      },
    });
    return { ...payment, configured: !!publicKey };
  }

  /** Checkout de la mensualidad (factura en COP o en USD convertido a COP). */
  async createCheckout(user: AuthUser, invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { company: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (!isPlatformRole(user.role) && invoice.companyId !== user.companyId) throw new ForbiddenException();
    if (invoice.status === 'PAID') throw new BadRequestException('La factura ya está pagada');
    if (invoice.totalAmount <= 0) throw new BadRequestException('La factura no tiene valor a pagar');

    const rate = await usdCopRate(this.prisma);
    const cop = invoice.currency === 'COP' ? invoice.totalAmount : invoice.totalAmount * rate;
    const payment = await this.platformCheckout({
      companyId: invoice.companyId,
      reference: `BO-${invoice.companyId.slice(-4)}-${invoice.period.replace('-', '')}-${Date.now()}`,
      amountInCents: Math.round(cop * 100),
      amountUsd: invoice.currency === 'COP' ? Math.round((invoice.totalAmount / rate) * 100) / 100 : invoice.totalAmount,
      purpose: 'INVOICE',
      invoiceId: invoice.id,
      redirectPath: '/app/billing',
    });
    await this.audit.log({
      actor: user, companyId: invoice.companyId, action: 'payment.checkout',
      entity: 'Payment', entityId: payment.id, detail: `${invoice.period} · ${payment.reference}`,
    });
    return payment;
  }

  /** Checkout de un paquete prepago de IA (lo llama AiCreditsService). */
  async createPackageCheckout(user: AuthUser, companyId: string, pkg: any) {
    const rate = await usdCopRate(this.prisma);
    const cop = pkg.currency === 'USD' ? pkg.price * rate : pkg.price;
    const payment = await this.platformCheckout({
      companyId,
      reference: `PKG-${companyId.slice(-4)}-${Date.now()}`,
      amountInCents: Math.round(cop * 100),
      amountUsd: pkg.currency === 'USD' ? pkg.price : Math.round((pkg.price / rate) * 100) / 100,
      purpose: 'AI_CREDITS',
      meta: { packageId: pkg.id, conversations: pkg.conversations, validityMonths: pkg.validityMonths, name: pkg.name },
      redirectPath: '/app/usage',
    });
    await this.audit.log({
      actor: user, companyId, action: 'ai_credits.checkout',
      entity: 'Payment', entityId: payment.id, detail: `${pkg.name} · ${payment.reference}`,
    });
    return payment;
  }

  /**
   * Webhook de eventos de Wompi de BackOffice (transaction.updated).
   * APPROVED → factura pagada o paquete de IA acreditado (idempotente).
   */
  async handleWompiEvent(body: any) {
    const cfg = await this.settings();
    const secret = cfg.WOMPI_EVENTS_SECRET || '';
    const transaction = body?.data?.transaction;
    if (!transaction?.reference) throw new BadRequestException('Evento sin transacción');
    // La firma es OBLIGATORIA en el servidor de producción aunque Wompi esté en
    // modo test: un evento sin firma podría marcar facturas pagadas o regalar
    // créditos de IA. Sin secret solo se aceptan en un computador de pruebas.
    if (!secret && (isProductionHost() || (cfg.WOMPI_ENV || 'test') !== 'test')) {
      throw new UnauthorizedException('WOMPI_EVENTS_SECRET no configurado: eventos rechazados');
    }
    if (secret && !verifyEventSignature(body, secret)) {
      throw new UnauthorizedException('Firma del evento inválida');
    }
    const payment = await this.prisma.payment.findUnique({ where: { reference: transaction.reference } });
    if (!payment || payment.purpose === 'ORDER') throw new NotFoundException('Pago no encontrado');

    const updated = await this.recordEvent(payment, transaction, !!secret);
    if (transaction.status === APPROVED) {
      if (payment.purpose === 'AI_CREDITS') {
        const meta = parseJson<Record<string, any>>(payment.metaJson, {});
        await creditAiLot(this.prisma, {
          companyId: payment.companyId, conversations: Number(meta.conversations), source: 'PURCHASE',
          validityMonths: Number(meta.validityMonths ?? 12), packageId: meta.packageId ?? null,
          paymentRef: payment.reference, note: meta.name ?? null,
        });
        await this.audit.log({
          actor: null, companyId: payment.companyId, action: 'ai_credits.purchased',
          entity: 'Payment', entityId: payment.id, detail: `${meta.name ?? 'Paquete'} · ${meta.conversations} conversaciones`,
        });
        this.events?.emit(payment.companyId, { type: 'ai.credits', level: 'TOPUP' });
      } else if (payment.invoiceId) {
        await this.prisma.invoice.update({ where: { id: payment.invoiceId }, data: { status: 'PAID', paidAt: new Date() } });
        await this.audit.log({
          actor: null, companyId: payment.companyId, action: 'payment.approved',
          entity: 'Payment', entityId: payment.id, detail: `${payment.reference} vía ${transaction.payment_method_type ?? 'Wompi'}`,
        });
      }
    }
    return { ok: true, status: updated.status };
  }

  private async recordEvent(payment: any, transaction: any, verified: boolean) {
    const events = parseJson<any[]>(payment.eventsLog, []);
    events.push({ at: new Date().toISOString(), status: transaction.status, txId: transaction.id, verified });
    return this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: transaction.status ?? payment.status,
        providerTxId: transaction.id ?? payment.providerTxId,
        paymentMethod: transaction.payment_method_type ?? payment.paymentMethod,
        eventsLog: JSON.stringify(events),
      },
    });
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const payments = await this.prisma.payment.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { name: true, slug: true } },
        invoice: { select: { period: true } },
      },
      take: 100,
    });
    return payments.map((p) => ({ ...p, events: parseJson<any[]>(p.eventsLog, []), meta: parseJson(p.metaJson, {}) }));
  }

  /* ── 2. Cobro de pedidos con la cuenta Wompi de la empresa ───────── */

  async getCompanyConfig(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const web = await publicWebUrl(this.prisma);
    return {
      ...serializePaymentConfig(company.paymentConfigJson),
      webhookUrl: `${web}/api/payments/wompi/${company.slug}/events`,
    };
  }

  async updateCompanyConfig(user: AuthUser, dto: any, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const cfg = parseJson<CompanyPaymentConfig>(company.paymentConfigJson, {});
    const next: CompanyPaymentConfig = { ...cfg, provider: 'WOMPI' };
    if (dto.env !== undefined) next.env = dto.env === 'prod' ? 'prod' : 'test';
    if (dto.publicKey !== undefined) {
      const key = String(dto.publicKey).trim();
      if (key && !/^pub_(test|prod)_[A-Za-z0-9]+$/.test(key)) throw new BadRequestException('Llave pública de Wompi inválida (pub_test_… o pub_prod_…)');
      next.publicKey = key || undefined;
    }
    if (dto.integritySecret) next.integritySecretEnc = sealSecret(String(dto.integritySecret).trim());
    if (dto.eventsSecret) next.eventsSecretEnc = sealSecret(String(dto.eventsSecret).trim());
    if (dto.clearSecrets) {
      delete next.integritySecretEnc;
      delete next.eventsSecretEnc;
    }
    if (dto.manualInstructions !== undefined) next.manualInstructions = String(dto.manualInstructions).slice(0, 500) || undefined;
    if (dto.acceptCash !== undefined) next.acceptCash = !!dto.acceptCash;
    await this.prisma.company.update({ where: { id: scoped }, data: { paymentConfigJson: JSON.stringify(next) } });
    await this.audit.log({
      actor: user, companyId: scoped, action: 'payments.config_update', entity: 'Company', entityId: scoped,
      detail: `Wompi ${next.env ?? 'test'}${next.publicKey ? ' · llave pública cargada' : ''}`,
    });
    return this.getCompanyConfig(user, scoped);
  }

  /** Genera (o reutiliza) el link de pago de un pedido con la cuenta de la empresa. */
  async createOrderPaymentLink(orderId: string, actor: AuthUser | null) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { company: true } });
    if (!order || order.deletedAt) throw new NotFoundException('Pedido no encontrado');
    if (actor && !isPlatformRole(actor.role) && order.companyId !== actor.companyId) throw new ForbiddenException();
    if (['cancelado', 'borrador'].includes(order.status)) {
      throw new BadRequestException('Solo se cobra un pedido confirmado');
    }
    if (order.paymentStatus === 'PAID') throw new BadRequestException('El pedido ya está pagado');
    if (!order.total || order.total <= 0) throw new BadRequestException('El pedido no tiene total para cobrar');
    const cfg = parseJson<CompanyPaymentConfig>(order.company.paymentConfigJson, {});
    if (!cfg.publicKey) throw new BadRequestException('La empresa no tiene Wompi configurado (Configuración → Pagos)');

    // Mismo monto y link pendiente: se reutiliza (no se crean cobros duplicados)
    const amountInCents = Math.round(order.total * 100);
    const pending = await this.prisma.payment.findFirst({
      where: { companyId: order.companyId, purpose: 'ORDER', status: 'PENDING', amountInCents, metaJson: { contains: order.id } },
      orderBy: { createdAt: 'desc' },
    });
    if (pending?.checkoutUrl) return { url: pending.checkoutUrl, reference: pending.reference, reused: true };

    const reference = `ORD-${orderCode(order.id)}-${Date.now()}`;
    const trackingUrl = await ensureTrackingLink(this.prisma, order.id);
    const url = buildCheckoutUrl({
      publicKey: cfg.publicKey,
      reference,
      amountInCents,
      integritySecret: readSecret(cfg.integritySecretEnc),
      redirectUrl: trackingUrl,
    });
    await this.prisma.payment.create({
      data: {
        companyId: order.companyId, provider: 'WOMPI', reference, amountUsd: 0, amountInCents,
        currency: 'COP', status: 'PENDING', checkoutUrl: url, purpose: 'ORDER',
        metaJson: JSON.stringify({ orderId: order.id }),
      },
    });
    await this.prisma.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'PENDING', paymentLinkUrl: url, paymentRef: reference },
    });
    await this.audit.log({
      actor, companyId: order.companyId, action: 'order.payment_link',
      entity: 'Order', entityId: order.id, detail: `#${orderCode(order.id)} · ${order.total}`,
    });
    return { url, reference, reused: false };
  }

  /** Webhook de la cuenta Wompi de UNA empresa (pago de un pedido). */
  async handleCompanyWompiEvent(slug: string, body: any) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const cfg = parseJson<CompanyPaymentConfig>(company.paymentConfigJson, {});
    const secret = readSecret(cfg.eventsSecretEnc);
    // Igual que arriba: sin firma, cualquier comprador podría marcar su pedido como pagado
    if (!secret && (isProductionHost() || cfg.env === 'prod')) {
      throw new UnauthorizedException('Falta el events secret de Wompi de la empresa');
    }
    if (secret && !verifyEventSignature(body, secret)) throw new UnauthorizedException('Firma del evento inválida');
    const transaction = body?.data?.transaction;
    if (!transaction?.reference) throw new BadRequestException('Evento sin transacción');
    const payment = await this.prisma.payment.findUnique({ where: { reference: transaction.reference } });
    if (!payment || payment.companyId !== company.id || payment.purpose !== 'ORDER') {
      throw new NotFoundException('Pago no encontrado');
    }
    await this.recordEvent(payment, transaction, !!secret);
    const { orderId } = parseJson<{ orderId?: string }>(payment.metaJson, {});
    if (!orderId) return { ok: true };
    const order = await this.prisma.order.findFirst({ where: { id: orderId, companyId: company.id, ...NOT_DELETED } });
    if (!order) return { ok: true };
    if (transaction.status === APPROVED && order.paymentStatus !== 'PAID') {
      // El monto pagado debe cubrir el pedido (no se acepta un pago parcial como total)
      const paid = Number(transaction.amount_in_cents ?? payment.amountInCents);
      const ok = paid >= Math.round((order.total ?? 0) * 100);
      await this.prisma.order.update({
        where: { id: order.id },
        data: ok
          ? { paymentStatus: 'PAID', paidAt: new Date(), paymentMethod: transaction.payment_method_type ?? 'WOMPI' }
          : { paymentStatus: 'REPORTED' },
      });
      await this.audit.log({
        actor: null, companyId: company.id, action: ok ? 'order.paid' : 'order.payment_partial',
        entity: 'Order', entityId: order.id,
        detail: `#${orderCode(order.id)} · ${transaction.payment_method_type ?? 'Wompi'} · ${paid / 100}`,
      });
      this.events?.emit(company.id, { type: 'order.payment', orderId: order.id, status: ok ? 'PAID' : 'REPORTED' });
    } else if (FAILED_STATES.includes(transaction.status) && order.paymentStatus === 'PENDING') {
      await this.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'FAILED' } });
      this.events?.emit(company.id, { type: 'order.payment', orderId: order.id, status: 'FAILED' });
    }
    return { ok: true };
  }

  /** Marca un pedido como pagado a mano (efectivo, transferencia verificada). */
  async markOrderPaid(user: AuthUser, orderId: string, dto: { method?: string; verified?: boolean }) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt) throw new NotFoundException('Pedido no encontrado');
    if (!isPlatformRole(user.role) && order.companyId !== user.companyId) throw new ForbiddenException();
    const method = ['EFECTIVO', 'TRANSFERENCIA', 'NEQUI', 'DAVIPLATA', 'DATAFONO', 'OTRO'].includes(String(dto?.method))
      ? String(dto.method) : 'OTRO';
    const paid = dto?.verified !== false;
    await this.prisma.order.update({
      where: { id: orderId },
      data: paid
        ? { paymentStatus: 'PAID', paidAt: new Date(), paymentMethod: method }
        : { paymentStatus: 'NONE', paidAt: null },
    });
    await this.audit.log({
      actor: user, companyId: order.companyId, action: paid ? 'order.paid_manual' : 'order.payment_rejected',
      entity: 'Order', entityId: orderId, detail: `#${orderCode(orderId)} · ${method}`,
    });
    return { ok: true, paymentStatus: paid ? 'PAID' : 'NONE' };
  }
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.payments.list(user, companyId);
  }

  @Post('checkout')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  createCheckout(@CurrentUser() user: AuthUser, @Body('invoiceId') invoiceId: string) {
    return this.payments.createCheckout(user, invoiceId);
  }

  /** Endpoint público que recibe los eventos de Wompi de BackOffice. */
  @Public()
  @Post('wompi/events')
  wompiEvents(@Body() body: any) {
    return this.payments.handleWompiEvent(body);
  }

  /** Eventos de la cuenta Wompi de cada empresa (pagos de pedidos). */
  @Public()
  @Post('wompi/:slug/events')
  companyWompiEvents(@Param('slug') slug: string, @Body() body: any) {
    return this.payments.handleCompanyWompiEvent(slug, body);
  }

  @Products('AUTOMATION')
  @Get('config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  config(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.payments.getCompanyConfig(user, companyId);
  }

  @Products('AUTOMATION')
  @Patch('config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  updateConfig(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.payments.updateCompanyConfig(user, dto, companyId);
  }

  @Products('AUTOMATION')
  @Post('orders/:id/link')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  orderLink(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.payments.createOrderPaymentLink(id, user);
  }

  @Products('AUTOMATION')
  @Post('orders/:id/mark-paid')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  markPaid(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.payments.markOrderPaid(user, id, dto);
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
