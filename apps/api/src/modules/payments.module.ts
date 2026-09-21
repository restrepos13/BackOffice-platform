import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';

/**
 * Pasarela de pagos por suscripción.
 * Colombia: Wompi (Web Checkout + webhook de eventos con verificación de firma).
 * Internacional: pendiente (provider STRIPE reservado en el esquema).
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async settings(): Promise<Record<string, string>> {
    const rows = await this.prisma.platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Crea el checkout de Wompi para una factura pendiente. */
  async createCheckout(user: AuthUser, invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { company: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (!isPlatformRole(user.role) && invoice.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    if (invoice.status === 'PAID') {
      throw new BadRequestException('La factura ya está pagada');
    }

    const cfg = await this.settings();
    const publicKey = cfg.WOMPI_PUBLIC_KEY || '';
    const env = cfg.WOMPI_ENV || 'test';
    const rate = Number(cfg.USD_COP_RATE || 4000);
    const amountInCents = Math.round(invoice.totalAmount * rate * 100);
    const reference = `BO-${invoice.companyId.slice(-4)}-${invoice.period.replace('-', '')}-${Date.now()}`;

    // Firma de integridad (obligatoria en producción Wompi)
    const integritySecret = cfg.WOMPI_INTEGRITY_SECRET || '';
    const signature = integritySecret
      ? createHash('sha256')
          .update(`${reference}${amountInCents}COP${integritySecret}`)
          .digest('hex')
      : '';

    const params = new URLSearchParams({
      'public-key': publicKey || `pub_${env}_PENDIENTE`,
      currency: 'COP',
      'amount-in-cents': String(amountInCents),
      reference,
      'redirect-url': cfg.WOMPI_REDIRECT_URL || 'http://localhost:5173/app/billing',
    });
    if (signature) params.set('signature:integrity', signature);
    const checkoutUrl = `https://checkout.wompi.co/p/?${params.toString()}`;

    const payment = await this.prisma.payment.create({
      data: {
        companyId: invoice.companyId,
        invoiceId: invoice.id,
        provider: 'WOMPI',
        reference,
        amountUsd: invoice.totalAmount,
        amountInCents,
        currency: 'COP',
        status: 'PENDING',
        checkoutUrl,
      },
    });
    await this.audit.log({
      actor: user, companyId: invoice.companyId, action: 'payment.checkout',
      entity: 'Payment', entityId: payment.id,
      detail: `${invoice.period} · ${reference}`,
    });
    return { ...payment, configured: !!publicKey };
  }

  /**
   * Webhook de eventos de Wompi (transaction.updated).
   * Verifica el checksum: SHA256(valores de signature.properties + timestamp + events secret).
   */
  async handleWompiEvent(body: any) {
    const cfg = await this.settings();
    const secret = cfg.WOMPI_EVENTS_SECRET || '';

    const transaction = body?.data?.transaction;
    if (!transaction?.reference) {
      throw new BadRequestException('Evento sin transacción');
    }

    if (secret) {
      const props: string[] = body?.signature?.properties ?? [];
      const concat = props
        .map((prop: string) =>
          prop.split('.').reduce((acc: any, key: string) => acc?.[key], body.data),
        )
        .join('');
      const expected = createHash('sha256')
        .update(`${concat}${body.timestamp}${secret}`)
        .digest('hex');
      if (expected !== body?.signature?.checksum) {
        throw new UnauthorizedException('Firma del evento inválida');
      }
    }

    const payment = await this.prisma.payment.findUnique({
      where: { reference: transaction.reference },
    });
    if (!payment) throw new NotFoundException('Pago no encontrado');

    const events = parseJson<any[]>(payment.eventsLog, []);
    events.push({
      at: new Date().toISOString(),
      status: transaction.status,
      txId: transaction.id,
      verified: !!secret,
    });

    const updated = await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: transaction.status ?? payment.status,
        providerTxId: transaction.id ?? payment.providerTxId,
        paymentMethod:
          transaction.payment_method_type ?? payment.paymentMethod,
        eventsLog: JSON.stringify(events),
      },
    });

    // Pago aprobado → factura pagada
    if (transaction.status === 'APPROVED' && payment.invoiceId) {
      await this.prisma.invoice.update({
        where: { id: payment.invoiceId },
        data: { status: 'PAID', paidAt: new Date() },
      });
      await this.audit.log({
        actor: null, companyId: payment.companyId, action: 'payment.approved',
        entity: 'Payment', entityId: payment.id,
        detail: `${payment.reference} vía ${transaction.payment_method_type ?? 'Wompi'}`,
      });
    }
    return { ok: true, status: updated.status };
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
    return payments.map((p) => ({
      ...p,
      events: parseJson<any[]>(p.eventsLog, []),
    }));
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

  /** Endpoint público que recibe los eventos de Wompi. */
  @Public()
  @Post('wompi/events')
  wompiEvents(@Body() body: any) {
    return this.payments.handleWompiEvent(body);
  }
}

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
