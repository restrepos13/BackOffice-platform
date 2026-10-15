import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'crypto';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import {
  AuthUser,
  NOT_DELETED,
  ROLES,
  isPlatformRole,
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { geocodeAddress, isLatLng, quoteDelivery, roadKm, travelMinutes } from '../common/geo';
import { CUSTOMER_STATUS_LABEL, orderCode } from '../common/tracking';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { OrdersModule, OrdersService } from './orders.module';

/**
 * Domicilios (tipo Rappi, con la marca de cada empresa):
 *  - Panel: tablero en vivo (mapa con domiciliarios y destinos), asignación.
 *  - Domiciliario (rol COMPANY_COURIER, web móvil): turno, su ruta, GPS cada
 *    ~10 s, "recogí" (→ despachado + aviso al cliente) y "entregué" (+ foto).
 *  - Público: GET /public/track/:token — lo que ve el cliente final, sin login
 *    y sin datos internos (nada de ids, teléfonos del equipo ni rastro GPS).
 */

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const PROOF_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const ROUTE_STATUSES = ['programado', 'en_produccion', 'listo', 'empacado', 'despachado'];
const COURIER_STATUSES = ['listo', 'empacado', 'despachado'];

function firstName(name?: string | null): string {
  return String(name ?? '').trim().split(/\s+/)[0] || 'Domiciliario';
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger('Delivery');

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private destinationOf(order: any) {
    const address = parseJson<any>(order.deliveryAddressJson, {});
    return {
      label: address.label ?? null,
      address: address.address ?? null,
      instructions: address.instructions ?? null,
      lat: isLatLng(address) ? Number(address.lat) : null,
      lng: isLatLng(address) ? Number(address.lng) : null,
    };
  }

  /* ── Panel de la empresa ─────────────────────────────────────────── */

  /** Tablero en vivo: domiciliarios, pedidos por despachar y en ruta. */
  async board(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const since = new Date(Date.now() - 36 * 3600e3);
    const [couriers, orders] = await Promise.all([
      this.prisma.user.findMany({
        where: { companyId: scoped, role: ROLES.COMPANY_COURIER, active: true },
        select: {
          id: true, name: true, phone: true, onShift: true,
          lastLat: true, lastLng: true, lastLocAt: true,
        },
        orderBy: { name: 'asc' },
      }),
      this.prisma.order.findMany({
        where: {
          companyId: scoped, ...NOT_DELETED,
          OR: [
            { status: { in: ROUTE_STATUSES }, deliveryAt: { lte: new Date(Date.now() + 36 * 3600e3) } },
            { status: 'entregado', deliveredAt: { gte: since } },
          ],
        },
        include: {
          customer: { select: { name: true } },
          contact: { select: { name: true, phone: true } },
          items: { select: { productName: true, quantity: true } },
        },
        orderBy: { deliveryAt: 'asc' },
        take: 300,
      }),
    ]);
    const activeByCourier = new Map<string, number>();
    for (const o of orders) {
      if (o.courierId && o.status !== 'entregado') {
        activeByCourier.set(o.courierId, (activeByCourier.get(o.courierId) ?? 0) + 1);
      }
    }
    return {
      origin: isLatLng(cfg.delivery?.origin) ? cfg.delivery.origin : null,
      deliveryEnabled: !!cfg.delivery?.enabled,
      couriers: couriers.map((c) => ({ ...c, activeOrders: activeByCourier.get(c.id) ?? 0 })),
      orders: orders.map((o) => ({
        id: o.id,
        code: orderCode(o.id),
        status: o.status,
        deliveryAt: o.deliveryAt,
        etaAt: o.etaAt,
        dispatchedAt: o.dispatchedAt,
        deliveredAt: o.deliveredAt,
        courierId: o.courierId,
        customer: o.customer?.name ?? o.contact?.name ?? 'Cliente',
        phone: o.contact?.phone ?? null,
        total: o.total,
        distanceKm: o.distanceKm,
        items: o.items.reduce((sum, i) => sum + i.quantity, 0),
        destination: this.destinationOf(o),
      })),
    };
  }

  /** Asigna (o quita) el domiciliario de un pedido. */
  async assign(user: AuthUser, orderId: string, courierId: string | null) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt) throw new NotFoundException('Pedido no encontrado');
    if (!isPlatformRole(user.role) && order.companyId !== user.companyId) throw new ForbiddenException();
    if (['entregado', 'cancelado'].includes(order.status)) {
      throw new BadRequestException('El pedido ya está cerrado');
    }
    let courier: any = null;
    if (courierId) {
      courier = await this.prisma.user.findFirst({
        where: { id: courierId, companyId: order.companyId, role: ROLES.COMPANY_COURIER, active: true },
      });
      if (!courier) throw new BadRequestException('Domiciliario no válido para esta empresa');
    }
    await this.prisma.order.update({ where: { id: orderId }, data: { courierId: courier?.id ?? null } });
    await this.audit.log({
      actor: user, companyId: order.companyId, action: 'delivery.assign',
      entity: 'Order', entityId: orderId,
      detail: courier ? `#${orderCode(orderId)} → ${courier.name}` : `#${orderCode(orderId)} sin domiciliario`,
    });
    this.events.emit(order.companyId, { type: 'delivery.updated', orderId });
    return { ok: true, courier: courier ? { id: courier.id, name: courier.name } : null };
  }

  /** Rastro GPS del día de un domiciliario (para dibujar su recorrido). */
  async trail(user: AuthUser, courierId: string, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const courier = await this.prisma.user.findFirst({ where: { id: courierId, companyId: scoped } });
    if (!courier) throw new NotFoundException('Domiciliario no encontrado');
    const pings = await this.prisma.courierPing.findMany({
      where: { companyId: scoped, userId: courierId, createdAt: { gte: new Date(Date.now() - 12 * 3600e3) } },
      orderBy: { createdAt: 'asc' },
      select: { lat: true, lng: true, createdAt: true },
      take: 2000,
    });
    return { courierId, points: pings };
  }

  /** Ubica una dirección en el mapa (configurar el punto de despacho, probar). */
  async geocode(user: AuthUser, address: string, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const text = String(address ?? '').trim().slice(0, 200);
    if (!text) throw new BadRequestException('Escribe una dirección');
    const hit = await geocodeAddress(text, { city: company.city, country: company.country });
    if (!hit) throw new NotFoundException('No encontramos esa dirección en el mapa: prueba con barrio y ciudad');
    return hit;
  }

  /** Cotización de prueba con la configuración guardada (lo mismo que hace el agente). */
  async quote(user: AuthUser, dto: { address?: string; lat?: number; lng?: number; subtotal?: number }, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    let point = isLatLng({ lat: dto?.lat, lng: dto?.lng }) ? { lat: Number(dto.lat), lng: Number(dto.lng) } : null;
    let resolved: string | null = null;
    if (!point && dto?.address) {
      const hit = await geocodeAddress(String(dto.address).slice(0, 200), { city: company.city, country: company.country });
      if (hit) { point = { lat: hit.lat, lng: hit.lng }; resolved = hit.formatted; }
    }
    if (!point) throw new NotFoundException('No pudimos ubicar esa dirección');
    return {
      point,
      resolved,
      ...quoteDelivery(cfg.delivery, point, Number(dto?.subtotal) || 0, company.currency ?? 'COP'),
    };
  }

  /* ── Domiciliario (web móvil) ────────────────────────────────────── */

  private async courier(user: AuthUser) {
    const courier = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!courier || courier.role !== ROLES.COMPANY_COURIER || !courier.companyId) {
      throw new ForbiddenException('Solo para domiciliarios');
    }
    return courier;
  }

  private async ownOrder(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.deletedAt || order.courierId !== user.id) {
      throw new NotFoundException('Ese pedido no está asignado a ti');
    }
    return order;
  }

  async myRoute(user: AuthUser) {
    const courier = await this.courier(user);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: courier.companyId! } });
    const orders = await this.prisma.order.findMany({
      where: {
        courierId: courier.id, ...NOT_DELETED,
        OR: [
          { status: { in: COURIER_STATUSES } },
          { status: 'entregado', deliveredAt: { gte: new Date(Date.now() - 14 * 3600e3) } },
        ],
      },
      include: {
        customer: { select: { name: true } },
        contact: { select: { name: true, phone: true } },
        items: { select: { productName: true, quantity: true, presentation: true } },
      },
      orderBy: { deliveryAt: 'asc' },
    });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    return {
      company: { name: company.name, brandColor: company.brandColor, logoUrl: company.logoUrl, currency: company.currency },
      courier: { name: courier.name, onShift: courier.onShift, lastLocAt: courier.lastLocAt },
      origin: isLatLng(cfg.delivery?.origin) ? cfg.delivery.origin : null,
      stops: orders.map((o) => ({
        id: o.id,
        code: orderCode(o.id),
        status: o.status,
        deliveryAt: o.deliveryAt,
        etaAt: o.etaAt,
        customer: o.contact?.name ?? o.customer?.name ?? 'Cliente',
        phone: o.contact?.phone ?? null,
        total: o.total,
        observations: o.observations,
        items: o.items,
        destination: this.destinationOf(o),
      })),
    };
  }

  async setShift(user: AuthUser, on: boolean) {
    const courier = await this.courier(user);
    await this.prisma.user.update({ where: { id: courier.id }, data: { onShift: !!on } });
    await this.audit.log({
      actor: user, companyId: courier.companyId, action: on ? 'delivery.shift_start' : 'delivery.shift_end',
      entity: 'User', entityId: courier.id, detail: courier.name,
    });
    this.events.emit(courier.companyId!, { type: 'courier.shift', userId: courier.id, onShift: !!on });
    return { ok: true, onShift: !!on };
  }

  /** Posición GPS del domiciliario en turno (cada ~10 s desde el celular). */
  async ping(user: AuthUser, dto: { lat: number; lng: number; accuracy?: number; speed?: number; heading?: number }) {
    const courier = await this.courier(user);
    if (!courier.onShift) throw new BadRequestException('Inicia tu turno para compartir ubicación');
    const lat = Number(dto?.lat);
    const lng = Number(dto?.lng);
    if (!isLatLng({ lat, lng })) throw new BadRequestException('Coordenadas inválidas');
    const num = (v: unknown, max: number) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Number(v), 0), max) : null);
    const now = new Date();

    // Anti-ráfaga: a lo sumo un registro cada 4 s por domiciliario
    const fresh = !courier.lastLocAt || now.getTime() - courier.lastLocAt.getTime() >= 4000;
    await this.prisma.user.update({
      where: { id: courier.id },
      data: { lastLat: lat, lastLng: lng, lastLocAt: now },
    });
    if (fresh) {
      await this.prisma.courierPing.create({
        data: {
          companyId: courier.companyId!, userId: courier.id, lat, lng,
          accuracy: num(dto.accuracy, 10000), speed: num(dto.speed, 100), heading: num(dto.heading, 360),
        },
      });
    }

    // Recalcula la llegada estimada de lo que lleva en ruta
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: courier.companyId! } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const inRoute = await this.prisma.order.findMany({
      where: { courierId: courier.id, status: 'despachado', ...NOT_DELETED },
      select: { id: true, deliveryAddressJson: true },
    });
    for (const order of inRoute) {
      const dest = parseJson<any>(order.deliveryAddressJson, {});
      if (!isLatLng(dest)) continue;
      const km = roadKm({ lat, lng }, { lat: Number(dest.lat), lng: Number(dest.lng) }, cfg.delivery?.roadFactor ?? 1.35);
      const minutes = travelMinutes(km, cfg.delivery?.avgSpeedKmh ?? 22);
      await this.prisma.order.update({
        where: { id: order.id },
        data: { etaAt: new Date(now.getTime() + minutes * 60e3) },
      });
    }
    this.events.emit(courier.companyId!, {
      type: 'courier.location', userId: courier.id, lat, lng, at: now.toISOString(),
    });
    return { ok: true, inRoute: inRoute.length };
  }

  /** "Recogí el pedido": listo/empacado → despachado + aviso al cliente con el link. */
  async pickup(user: AuthUser, orderId: string) {
    const courier = await this.courier(user);
    const order = await this.ownOrder(user, orderId);
    const author = { type: 'USUARIO' as const, name: courier.name };
    if (order.status === 'listo') {
      await this.orders.changeStatus(orderId, 'empacado', author, 'Recogido por el domiciliario');
    } else if (order.status !== 'empacado') {
      throw new BadRequestException(
        `El pedido está "${CUSTOMER_STATUS_LABEL[order.status] ?? order.status}": todavía no se puede recoger`,
      );
    }
    // ETA inicial con la última posición conocida (el GPS la va afinando)
    const dest = parseJson<any>(order.deliveryAddressJson, {});
    if (isLatLng(dest) && courier.lastLat != null && courier.lastLng != null) {
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: order.companyId } });
      const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
      const km = roadKm({ lat: courier.lastLat, lng: courier.lastLng }, { lat: Number(dest.lat), lng: Number(dest.lng) }, cfg.delivery?.roadFactor ?? 1.35);
      await this.prisma.order.update({
        where: { id: orderId },
        data: { etaAt: new Date(Date.now() + travelMinutes(km, cfg.delivery?.avgSpeedKmh ?? 22) * 60e3) },
      });
    }
    await this.orders.changeStatus(orderId, 'despachado', author, 'Salió a entregar');
    this.events.emit(order.companyId, { type: 'delivery.updated', orderId });
    return { ok: true, status: 'despachado' };
  }

  /** "Entregué": despachado → entregado (+ foto opcional como prueba). */
  async deliver(user: AuthUser, orderId: string, file?: Express.Multer.File) {
    const courier = await this.courier(user);
    const order = await this.ownOrder(user, orderId);
    if (order.status !== 'despachado') {
      throw new BadRequestException('Primero marca el pedido como recogido');
    }
    let proof: string | null = null;
    if (file) {
      const ext = PROOF_MIME[file.mimetype];
      if (!ext) throw new BadRequestException('La foto debe ser JPG, PNG o WEBP');
      if (file.size > 8 * 1024 * 1024) throw new BadRequestException('La foto supera 8 MB');
      const dir = join(UPLOADS_DIR, order.companyId);
      mkdirSync(dir, { recursive: true });
      proof = `entrega-${randomBytes(12).toString('hex')}.${ext}`;
      writeFileSync(join(dir, proof), file.buffer);
    }
    await this.prisma.order.update({
      where: { id: orderId },
      data: { etaAt: null, ...(proof ? { deliveryProofFile: proof } : {}) },
    });
    await this.orders.changeStatus(orderId, 'entregado', { type: 'USUARIO', name: courier.name }, proof ? 'Entregado con foto' : 'Entregado');
    this.events.emit(order.companyId, { type: 'delivery.updated', orderId });
    return { ok: true, status: 'entregado' };
  }

  /** Foto de la entrega (panel, autenticado y tenant-scoped). */
  async proofFile(user: AuthUser, orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order?.deliveryProofFile) throw new NotFoundException('Sin foto de entrega');
    if (!isPlatformRole(user.role) && order.companyId !== user.companyId) throw new ForbiddenException();
    const path = join(UPLOADS_DIR, order.companyId, order.deliveryProofFile);
    if (!path.startsWith(join(UPLOADS_DIR, order.companyId)) || !existsSync(path)) {
      throw new NotFoundException('Archivo no disponible');
    }
    return path;
  }

  /* ── Público: seguimiento con la marca de la empresa ─────────────── */

  async publicTracking(token: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token ?? '')) throw new NotFoundException('Link inválido');
    const order = await this.prisma.order.findFirst({
      where: { trackingToken: token, ...NOT_DELETED },
      include: {
        company: true,
        items: { select: { productName: true, quantity: true, presentation: true } },
        statusHistory: { orderBy: { createdAt: 'asc' }, select: { toStatus: true, createdAt: true } },
        feedback: { select: { rating: true, status: true } },
      },
    });
    if (!order) throw new NotFoundException('No encontramos este pedido');
    // Pasadas 72 h de la entrega el link deja de mostrar el detalle
    const expired = order.deliveredAt && Date.now() - order.deliveredAt.getTime() > 72 * 3600e3;
    const company = order.company;
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const destination = this.destinationOf(order);

    let courier: any = null;
    if (order.courierId && order.status === 'despachado') {
      const user = await this.prisma.user.findUnique({ where: { id: order.courierId } });
      const fresh = user?.lastLocAt && Date.now() - user.lastLocAt.getTime() < 10 * 60e3;
      courier = user
        ? {
            name: firstName(user.name),
            ...(fresh && user.lastLat != null ? { lat: user.lastLat, lng: user.lastLng, updatedAt: user.lastLocAt } : {}),
          }
        : null;
    }

    // Línea de tiempo amigable (un paso por etapa, sin estados internos)
    const steps = [
      { key: 'recibido', label: 'Pedido recibido', statuses: ['confirmado', 'programado'] },
      { key: 'preparando', label: 'En preparación', statuses: ['en_produccion', 'listo', 'empacado'] },
      { key: 'en_camino', label: 'En camino', statuses: ['despachado'] },
      { key: 'entregado', label: 'Entregado', statuses: ['entregado'] },
    ];
    const reachedAt = (statuses: string[]) =>
      order.statusHistory.find((h) => statuses.includes(h.toStatus))?.createdAt ?? null;
    const order_ = ['borrador', 'confirmado', 'programado', 'en_produccion', 'listo', 'empacado', 'despachado', 'entregado'];
    const currentIdx = order_.indexOf(order.status);
    const timeline = steps.map((step) => {
      const stepIdx = Math.min(...step.statuses.map((s) => order_.indexOf(s)));
      return {
        key: step.key,
        label: step.label,
        done: currentIdx >= stepIdx && currentIdx !== -1,
        at: reachedAt(step.statuses),
      };
    });

    return {
      company: {
        name: company.name,
        logoUrl: company.logoUrl,
        brandColor: company.brandColor,
        whatsapp: company.contactPhone,
        currency: company.currency,
      },
      order: {
        code: orderCode(order.id),
        status: order.status,
        statusLabel: CUSTOMER_STATUS_LABEL[order.status] ?? order.status,
        cancelled: order.status === 'cancelado',
        needsReview: order.status === 'requiere_atencion',
        deliveryAt: order.deliveryAt,
        etaAt: order.status === 'despachado' || order.status === 'en_produccion' || order.status === 'listo' || order.status === 'empacado' || order.status === 'programado'
          ? order.etaAt : null,
        deliveredAt: order.deliveredAt,
        // Campos armados a mano: jamás sale un id interno aunque cambie la consulta
        items: expired
          ? []
          : order.items.map((i: any) => ({
              productName: i.productName,
              quantity: i.quantity,
              presentation: i.presentation ?? null,
            })),
        subtotal: expired ? null : order.subtotal,
        deliveryFee: expired ? null : order.deliveryFee,
        total: expired ? null : order.total,
        address: expired ? null : destination.address,
        timeline,
        rated: order.feedback?.status === 'RESPONDIDO',
      },
      map: expired
        ? null
        : {
            destination: destination.lat != null ? { lat: destination.lat, lng: destination.lng } : null,
            origin: isLatLng(cfg.delivery?.origin) ? { lat: cfg.delivery.origin.lat, lng: cfg.delivery.origin.lng } : null,
            courier: courier?.lat != null ? { lat: courier.lat, lng: courier.lng, updatedAt: courier.updatedAt } : null,
          },
      courier: courier ? { name: courier.name } : null,
      expired: !!expired,
    };
  }

  /* ── Mantenimiento ───────────────────────────────────────────────── */

  /** Diario 03:00: depura rastro GPS viejo y cierra turnos olvidados. */
  @Cron('0 3 * * *')
  async housekeeping() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      const purged = await this.prisma.courierPing.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - 7 * 86400e3) } },
      });
      const closed = await this.prisma.user.updateMany({
        where: {
          role: ROLES.COMPANY_COURIER, onShift: true,
          OR: [{ lastLocAt: null }, { lastLocAt: { lt: new Date(Date.now() - 12 * 3600e3) } }],
        },
        data: { onShift: false },
      });
      this.logger.log(`domicilios: ${purged.count} pings depurados, ${closed.count} turnos cerrados`);
    } catch (err: any) {
      this.logger.warn(`housekeeping de domicilios falló: ${err.message}`);
    }
  }
}

@Controller('delivery')
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get('board')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  board(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.delivery.board(user, companyId);
  }

  @Post('orders/:id/assign')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: { courierId?: string | null }) {
    return this.delivery.assign(user, id, dto?.courierId || null);
  }

  @Post('geocode')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  geocode(@CurrentUser() user: AuthUser, @Body() dto: { address: string }, @Query('companyId') companyId?: string) {
    return this.delivery.geocode(user, dto?.address, companyId);
  }

  @Post('quote')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  quote(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.delivery.quote(user, dto, companyId);
  }

  @Get('couriers/:id/trail')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  trail(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('companyId') companyId?: string) {
    return this.delivery.trail(user, id, companyId);
  }

  @Get('orders/:id/proof')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  async proof(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const path = await this.delivery.proofFile(user, id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(path).pipe(res);
  }

  /* Domiciliario */

  @Get('me/route')
  @Roles(ROLES.COMPANY_COURIER)
  myRoute(@CurrentUser() user: AuthUser) {
    return this.delivery.myRoute(user);
  }

  @Post('me/shift')
  @Roles(ROLES.COMPANY_COURIER)
  shift(@CurrentUser() user: AuthUser, @Body() dto: { on: boolean }) {
    return this.delivery.setShift(user, !!dto?.on);
  }

  @Post('me/location')
  @Roles(ROLES.COMPANY_COURIER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  location(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.delivery.ping(user, dto);
  }

  @Post('me/orders/:id/pickup')
  @Roles(ROLES.COMPANY_COURIER)
  pickup(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.delivery.pickup(user, id);
  }

  @Post('me/orders/:id/deliver')
  @Roles(ROLES.COMPANY_COURIER)
  @UseInterceptors(FileInterceptor('photo', { limits: { fileSize: 8 * 1024 * 1024 } }))
  deliver(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFile() photo?: Express.Multer.File) {
    return this.delivery.deliver(user, id, photo);
  }
}

/** Seguimiento público del cliente final (sin login). */
@Public()
@Controller('public/track')
export class PublicTrackingController {
  constructor(private readonly delivery: DeliveryService) {}

  @Get(':token')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  track(@Param('token') token: string) {
    return this.delivery.publicTracking(token);
  }
}

@Module({
  imports: [OrdersModule],
  controllers: [DeliveryController, PublicTrackingController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
