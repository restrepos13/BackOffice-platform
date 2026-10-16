import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Patch,
  Post,
  Param,
  Query,
  UnauthorizedException, ConflictException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { isLatLng, roundMoney } from '../common/geo';
import { issueEinvoice, sealToken, serializeEinvoiceConfig } from '../common/einvoice';
import { orderCode } from '../common/tracking';
import { AuditService } from './audit.module';
import { OrdersModule, OrdersService } from './orders.module';

export const EXTERNAL_SOURCES = ['RAPPI', 'UBER_EATS', 'DIDI', 'IFOOD', 'WEB', 'POS', 'OTRO'];

/**
 * Pedidos de otras plataformas (Rappi, Uber Eats, tienda web, POS…) entran a
 * la MISMA operación (áreas, domicilios, reportes) por un endpoint con llave
 * de API de la empresa (Dev Tools → API keys, scope "orders"). Idempotente por
 * (empresa, origen, id externo): un reintento no duplica el pedido.
 *
 * Además: factura electrónica DIAN de un pedido (proveedor de la empresa).
 */
@Injectable()
export class InboundOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  /** Llave de API → empresa (solo llaves de empresa con scope de pedidos). */
  async companyFromKey(rawKey: string | undefined) {
    const key = String(rawKey ?? '').trim();
    if (!key.startsWith('bo_live_')) throw new UnauthorizedException('Falta la llave de API (header x-api-key)');
    const hash = createHash('sha256').update(key).digest('hex');
    const apiKey = await this.prisma.apiKey.findFirst({ where: { hash } });
    if (!apiKey || apiKey.revokedAt || !apiKey.companyId) throw new UnauthorizedException('Llave de API inválida o revocada');
    const scopes = parseJson<string[]>(apiKey.scopesJson, []);
    if (!scopes.some((s) => s === 'orders' || s === 'write' || s === '*')) {
      throw new ForbiddenException('La llave no tiene permiso para crear pedidos (scope "orders")');
    }
    await this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
    return apiKey.companyId;
  }

  validate(dto: any) {
    const source = String(dto?.source ?? '').toUpperCase();
    if (!EXTERNAL_SOURCES.includes(source)) throw new BadRequestException(`source inválido (${EXTERNAL_SOURCES.join(', ')})`);
    const externalId = String(dto?.externalId ?? '').trim().slice(0, 80);
    if (!externalId) throw new BadRequestException('Falta externalId (id del pedido en la plataforma)');
    const name = String(dto?.customer?.name ?? '').trim().slice(0, 100);
    if (!name) throw new BadRequestException('Falta customer.name');
    if (!Array.isArray(dto?.items) || dto.items.length === 0 || dto.items.length > 60) {
      throw new BadRequestException('items debe tener entre 1 y 60 productos');
    }
    for (const [i, item] of dto.items.entries()) {
      if (!String(item?.name ?? item?.sku ?? '').trim()) throw new BadRequestException(`items[${i}].name requerido`);
      const q = Number(item?.quantity);
      if (!Number.isFinite(q) || q <= 0 || q > 1000) throw new BadRequestException(`items[${i}].quantity inválido`);
    }
    return { source, externalId, name };
  }

  async createExternal(companyId: string, dto: any) {
    const { source, externalId, name } = this.validate(dto);
    const existing = await this.prisma.order.findFirst({ where: { companyId, source, externalId } });
    if (existing) return { id: existing.id, code: orderCode(existing.id), status: existing.status, duplicate: true };

    // Candado único: si el integrador reintenta en paralelo, solo uno crea el pedido
    const claim = await this.claimExternal(companyId, source, externalId);
    if ('duplicate' in claim) return claim.duplicate;
    try {
      return await this.createClaimed(companyId, dto, source, externalId, name);
    } catch (err) {
      await this.prisma.inboundOrderKey.delete({ where: { id: claim.id } }).catch(() => undefined);
      throw err;
    }
  }

  private async claimExternal(companyId: string, source: string, externalId: string): Promise<{ id: string } | { duplicate: any }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.prisma.inboundOrderKey.create({ data: { companyId, source, externalId } });
      } catch (err: any) {
        if (err?.code !== 'P2002') throw err;
      }
      // Otro request tiene el candado: esperar a que termine su pedido
      for (let i = 0; i < 40; i++) {
        const order = await this.prisma.order.findFirst({ where: { companyId, source, externalId } });
        if (order) return { duplicate: { id: order.id, code: orderCode(order.id), status: order.status, duplicate: true } };
        await new Promise((r) => setTimeout(r, 150));
      }
      // Candado huérfano (el proceso murió a mitad): se libera y se reintenta una vez
      const stale = await this.prisma.inboundOrderKey.findFirst({ where: { companyId, source, externalId } });
      if (stale && Date.now() - new Date(stale.createdAt).getTime() > 30_000) {
        await this.prisma.inboundOrderKey.delete({ where: { id: stale.id } }).catch(() => undefined);
        continue;
      }
      break;
    }
    throw new ConflictException('Ese pedido se está procesando: reintenta en unos segundos');
  }

  private async createClaimed(companyId: string, dto: any, source: string, externalId: string, name: string) {

    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const currency = company.currency ?? 'COP';
    const phone = dto.customer?.phone ? String(dto.customer.phone).replace(/[^\d+]/g, '').slice(0, 20) : null;
    let contact = phone ? await this.prisma.contact.findFirst({ where: { companyId, phone } }) : null;
    let customer = contact?.customerId ? await this.prisma.customer.findUnique({ where: { id: contact.customerId } }) : null;
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: { companyId, name, notes: `Cliente de ${source}` },
      });
    }
    if (!contact && phone) {
      contact = await this.prisma.contact.create({
        data: { companyId, name, phone, channel: 'WHATSAPP', stage: 'CLIENTE', customerId: customer.id },
      });
    }
    const products = await this.prisma.product.findMany({ where: { companyId, ...NOT_DELETED } });
    const items = dto.items.map((item: any) => {
      const label = String(item.name ?? item.sku).trim();
      const product = products.find((p) => p.name.toLowerCase() === label.toLowerCase()) ?? null;
      return {
        companyId,
        productId: product?.id ?? null,
        productName: product?.name ?? label.slice(0, 120),
        quantity: Number(item.quantity),
        unit: product?.unit ?? 'unidad',
        specifications: item.notes ? String(item.notes).slice(0, 200) : null,
        productionAreaId: product?.productionAreaId ?? null,
        _price: Number.isFinite(Number(item.unitPrice)) ? Number(item.unitPrice) : product?.price ?? null,
      };
    });
    const subtotal = roundMoney(items.reduce((s: number, i: any) => s + (i._price ?? 0) * i.quantity, 0), currency);
    const fee = Number.isFinite(Number(dto.deliveryFee)) ? Number(dto.deliveryFee) : null;
    const total = Number.isFinite(Number(dto.total)) ? Number(dto.total) : subtotal + (fee ?? 0);
    const address = {
      label: source,
      address: dto.customer?.address ? String(dto.customer.address).slice(0, 200) : null,
      ...(isLatLng({ lat: dto.customer?.lat, lng: dto.customer?.lng }) ? { lat: Number(dto.customer.lat), lng: Number(dto.customer.lng) } : {}),
      ...(dto.customer?.notes ? { instructions: String(dto.customer.notes).slice(0, 200) } : {}),
    };
    const deliveryAt = dto.deliveryAt ? new Date(dto.deliveryAt) : new Date(Date.now() + 40 * 60e3);
    if (Number.isNaN(deliveryAt.getTime())) throw new BadRequestException('deliveryAt inválido');

    const order = await this.prisma.order.create({
      data: {
        companyId, customerId: customer.id, contactId: contact?.id ?? null, status: 'borrador',
        source, externalId, takenByType: 'HUMANO', takenByName: source,
        deliveryAt, deliveryAddressJson: JSON.stringify(address),
        observations: dto.observations ? String(dto.observations).slice(0, 500) : null,
        subtotal, deliveryFee: fee, total,
        paymentStatus: dto.paid ? 'PAID' : 'NONE', ...(dto.paid ? { paidAt: new Date(), paymentMethod: source } : {}),
        items: { create: items.map(({ _price, ...rest }: any) => rest) },
      },
    });
    await this.prisma.orderStatusHistory.create({
      data: { companyId, orderId: order.id, fromStatus: null, toStatus: 'borrador', authorType: 'SISTEMA', authorName: source, reason: `Pedido externo ${externalId}` },
    });
    // Misma operación que un pedido de WhatsApp: áreas, agenda, recordatorios
    await this.orders.changeStatus(order.id, 'confirmado', { type: 'SISTEMA', name: source }, `Recibido de ${source}`);
    await this.audit.log({
      actor: null, companyId, action: 'order.external', entity: 'Order', entityId: order.id,
      detail: `${source} ${externalId} · ${items.length} ítems · ${total}`,
    });
    const fresh = await this.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    return { id: order.id, code: orderCode(order.id), status: fresh.status, duplicate: false };
  }

  /* ── Factura electrónica: configuración por empresa ── */

  async updateEinvoiceConfig(user: AuthUser, dto: any, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const cfg = parseJson<Record<string, any>>(company.einvoiceConfigJson, {});
    const provider = dto?.provider === 'ALEGRA' || dto?.provider === 'SIMULADO' ? dto.provider : dto?.provider === null ? undefined : cfg.provider;
    const next: Record<string, any> = { ...cfg, provider };
    if (dto?.email !== undefined) next.email = String(dto.email).trim().slice(0, 120) || undefined;
    if (dto?.token) next.tokenEnc = sealToken(String(dto.token).trim());
    if (dto?.taxRate !== undefined) {
      const rate = Number(dto.taxRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 0.3) throw new BadRequestException('El impuesto va de 0 a 0,30');
      next.taxRate = rate;
    }
    if (dto?.alegraTaxId !== undefined) next.alegraTaxId = dto.alegraTaxId ? Number(dto.alegraTaxId) : undefined;
    if (dto?.alegraItemId !== undefined) next.alegraItemId = dto.alegraItemId ? Number(dto.alegraItemId) : undefined;
    await this.prisma.company.update({ where: { id }, data: { einvoiceConfigJson: JSON.stringify(next) } });
    await this.audit.log({ actor: user, companyId: id, action: 'einvoice.config', entity: 'Company', entityId: id, detail: provider ?? 'desactivada' });
    return serializeEinvoiceConfig(JSON.stringify(next));
  }

  /* ── Factura electrónica de un pedido ── */

  async einvoice(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { items: true, customer: true, contact: true } });
    if (!order || order.deletedAt) throw new NotFoundException('Pedido no encontrado');
    if (!isPlatformRole(user.role) && order.companyId !== user.companyId) throw new ForbiddenException();
    if (['borrador', 'cancelado'].includes(order.status)) throw new BadRequestException('Solo se factura un pedido confirmado');
    if (order.einvoiceStatus === 'EMITIDA') throw new BadRequestException(`El pedido ya tiene factura ${order.einvoiceNumber}`);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: order.companyId } });
    const products = await this.prisma.product.findMany({ where: { companyId: order.companyId } });
    const { result, nextConfig } = await issueEinvoice(company.einvoiceConfigJson, {
      orderCode: orderCode(order.id),
      customer: {
        name: order.customer.name, taxId: order.customer.taxId,
        email: null, phone: order.contact?.phone ?? null,
      },
      items: order.items.map((i) => ({
        name: i.productName, quantity: i.quantity,
        unitPrice: products.find((p) => p.id === i.productId)?.price ?? 0,
      })),
      deliveryFee: order.deliveryFee,
      discount: order.discount,
      date: new Date(),
    });
    if (nextConfig) await this.prisma.company.update({ where: { id: company.id }, data: { einvoiceConfigJson: nextConfig } });
    await this.prisma.order.update({
      where: { id: order.id },
      data: result.ok
        ? { einvoiceStatus: 'EMITIDA', einvoiceNumber: result.number, einvoiceId: result.providerId, einvoiceError: null }
        : { einvoiceStatus: 'ERROR', einvoiceError: result.error?.slice(0, 300) },
    });
    await this.audit.log({
      actor: user, companyId: order.companyId, action: result.ok ? 'order.einvoice' : 'order.einvoice_error',
      entity: 'Order', entityId: order.id, detail: result.ok ? `Factura ${result.number}` : result.error,
    });
    if (!result.ok) throw new BadRequestException(result.error);
    return { ok: true, number: result.number };
  }
}

@Controller()
export class InboundOrdersController {
  constructor(private readonly inbound: InboundOrdersService) {}

  /** Pedidos de otras plataformas — autenticado con x-api-key de la empresa. */
  @Public()
  @Post('inbound/orders')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async create(@Headers('x-api-key') apiKey: string, @Body() dto: any) {
    const companyId = await this.inbound.companyFromKey(apiKey);
    return this.inbound.createExternal(companyId, dto);
  }

  @Patch('einvoice/config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  einvoiceConfig(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.inbound.updateEinvoiceConfig(user, dto, companyId);
  }

  @Post('orders/:id/einvoice')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  einvoice(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.inbound.einvoice(user, id);
  }
}

@Module({
  imports: [OrdersModule],
  controllers: [InboundOrdersController],
  providers: [InboundOrdersService],
})
export class InboundOrdersModule {}
