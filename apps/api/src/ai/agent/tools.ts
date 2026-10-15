import { NOT_DELETED, parseJson } from '../../common/constants';
import {
  DeliveryConfig,
  LatLng,
  geocodeAddress,
  isLatLng,
  nearestBranch,
  quoteDelivery,
  roundMoney,
} from '../../common/geo';
import { normalizeCode, pickPromotion } from '../../common/promotions';
import {
  CUSTOMER_STATUS_LABEL,
  ensureTrackingLink,
  orderCode,
  publicWebUrl,
} from '../../common/tracking';

/**
 * Herramientas del agente (estilo "agente con acceso a tablas"): la IA decide
 * QUÉ consultar y QUÉ hacer, pero cada herramienta es código nuestro —
 * parámetros validados, todo acotado a la empresa y a la conversación en
 * curso, y jamás SQL ni texto del usuario directo a la base.
 *
 * Permisos por bot (Bot.toolsJson): cada herramienta se habilita como
 * "read" (consulta) o "write" (modifica). Las de escritura exigen permiso write.
 */

export type ToolAccess = 'read' | 'write';

export interface ToolContext {
  prisma: any;
  /** OrdersService (pipeline de confirmación, agenda, transiciones). */
  orders?: {
    validateAgenda(companyId: string, at: Date, excludeOrderId?: string): Promise<{ ok: boolean; reason?: string; alternatives: Date[] }>;
    runConfirmationPipeline(orderId: string, author: { type: 'IA' | 'USUARIO' | 'SISTEMA'; name: string }): Promise<{ scheduled: boolean; reason?: string }>;
    changeStatus(orderId: string, to: string, author: { type: 'IA' | 'USUARIO' | 'SISTEMA'; name: string }, reason?: string): Promise<any>;
  };
  /** Cobro con la cuenta Wompi de la empresa (PaymentsService) */
  payments?: { createOrderPaymentLink(orderId: string, actor: null): Promise<{ url: string; reference: string }> };
  /** Base de conocimiento (KnowledgeService) */
  knowledge?: { search(companyId: string, query: string, top?: number): Promise<Array<{ text: string; doc: string; score: number }>> };
  company: any;
  orderConfig: Record<string, any>;
  conversation: any;
  contact: any;
  now: Date;
  geocode?: typeof geocodeAddress;
  /** Estado acumulado de la corrida (borrador tocado, pedido confirmado…). */
  state: { draftOrderId: string | null; confirmedOrderId: string | null; branches?: any[] };
}

export interface AgentTool {
  name: string;
  access: ToolAccess;
  description: string;
  params: string; // descripción compacta para el prompt
  run(ctx: ToolContext, args: Record<string, any>): Promise<Record<string, any>>;
}

/* ─── utilidades ─────────────────────────────────────────────────────── */

const PAYMENT_LABEL: Record<string, string> = {
  NONE: 'Pendiente de pago',
  PENDING: 'Link de pago enviado',
  REPORTED: 'Comprobante recibido, en verificación',
  PAID: 'Pagado',
  FAILED: 'El pago no se completó',
};

const ACTIVE_STATUSES = ['borrador', 'confirmado', 'programado', 'en_produccion', 'listo', 'empacado', 'despachado', 'requiere_atencion'];
const CANCELLABLE = ['borrador', 'confirmado', 'programado'];

function str(value: unknown, max = 300): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function fmtDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: tz || 'America/Bogota', weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit',
  }).format(d);
}

function money(value: number | null | undefined, currency: string): string | null {
  if (value == null) return null;
  return new Intl.NumberFormat('es-CO', {
    style: 'currency', currency: currency || 'COP', maximumFractionDigits: currency === 'COP' ? 0 : 2,
  }).format(value);
}

function deliveryCfg(ctx: ToolContext): DeliveryConfig {
  return (ctx.orderConfig?.delivery ?? {}) as DeliveryConfig;
}

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

export function matchProduct(products: any[], name: string): any | null {
  const n = normalize(name);
  if (!n) return null;
  return (
    products.find((p) => normalize(p.name) === n) ??
    products.find((p) => normalize(p.name).includes(n) || n.includes(normalize(p.name))) ??
    null
  );
}

async function activeProducts(ctx: ToolContext) {
  return ctx.prisma.product.findMany({
    where: { companyId: ctx.company.id, active: true, ...NOT_DELETED },
    take: 200,
  });
}

/** Agotado ahora (indefinido o hasta una fecha que todavía no llega). */
export function isSoldOut(p: { soldOut?: boolean; soldOutUntil?: Date | string | null }, now: Date): boolean {
  if (!p.soldOut) return false;
  return !p.soldOutUntil || new Date(p.soldOutUntil) > now;
}

async function branchesOf(ctx: ToolContext): Promise<any[]> {
  if (!ctx.state.branches) {
    ctx.state.branches = (await ctx.prisma.branch?.findMany({ where: { companyId: ctx.company.id, active: true } })) ?? [];
  }
  return ctx.state.branches ?? [];
}

/** Cotiza con la sucursal más cercana (si hay) y las zonas por barrio. */
async function quoteFor(ctx: ToolContext, dest: Destination, subtotal: number) {
  const point = isLatLng(dest) ? { lat: Number(dest.lat), lng: Number(dest.lng) } : null;
  const branch = nearestBranch(await branchesOf(ctx), point);
  const quote = quoteDelivery(deliveryCfg(ctx), point, subtotal, ctx.company.currency ?? 'COP', {
    addressText: [dest.address, dest.label, dest.city].filter(Boolean).join(' '),
    origin: branch ? { lat: branch.lat, lng: branch.lng } : null,
  });
  return { quote, branch };
}

/** Última ubicación compartida por WhatsApp en esta conversación (48 h). */
async function sharedLocation(ctx: ToolContext): Promise<(LatLng & { label: string }) | null> {
  const msg = await ctx.prisma.message.findFirst({
    where: {
      conversationId: ctx.conversation.id,
      direction: 'IN',
      type: 'LOCATION',
      createdAt: { gte: new Date(ctx.now.getTime() - 48 * 3600e3) },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!msg || !isLatLng({ lat: msg.latitude, lng: msg.longitude })) return null;
  return { lat: msg.latitude, lng: msg.longitude, label: msg.content };
}

/** Ficha del cliente de esta conversación; la crea si hace falta escribir. */
async function customerOf(ctx: ToolContext, create: boolean) {
  if (ctx.contact?.customerId) {
    const found = await ctx.prisma.customer.findUnique({ where: { id: ctx.contact.customerId } });
    if (found) return found;
  }
  if (!create || !ctx.contact) return null;
  const customer = await ctx.prisma.customer.create({
    data: {
      companyId: ctx.company.id,
      name: ctx.contact.name ?? 'Cliente por identificar',
      notes: 'Creado automáticamente por el agente desde WhatsApp.',
    },
  });
  await ctx.prisma.contact.update({ where: { id: ctx.contact.id }, data: { customerId: customer.id } });
  ctx.contact.customerId = customer.id;
  return customer;
}

interface Destination {
  label: string;
  address: string;
  city?: string;
  instructions?: string;
  lat?: number;
  lng?: number;
}

/**
 * Resuelve a dónde va el pedido: ubicación compartida → dirección guardada
 * (por etiqueta) → dirección escrita (geocodificada). Cachea coordenadas en
 * la ficha para no geocodificar dos veces.
 */
async function resolveDestination(
  ctx: ToolContext,
  args: Record<string, any>,
): Promise<{ ok: true; dest: Destination } | { ok: false; error: string }> {
  if (args.usar_ubicacion_compartida) {
    const loc = await sharedLocation(ctx);
    if (!loc) return { ok: false, error: 'El cliente no ha compartido su ubicación en esta conversación. Pídele que la envíe con el clip > Ubicación.' };
    return {
      ok: true,
      dest: {
        label: str(args.etiqueta_direccion, 40) || 'Ubicación compartida',
        address: str(args.direccion) || loc.label.replace(/^\[ubicación\]\s*/i, '') || 'Ubicación compartida por WhatsApp',
        lat: loc.lat, lng: loc.lng,
      },
    };
  }
  const label = str(args.etiqueta_direccion ?? args.etiqueta, 40);
  if (label) {
    const customer = await customerOf(ctx, false);
    const addresses = parseJson<any[]>(customer?.addressesJson, []);
    const saved = addresses.find((a) => normalize(a.label ?? '') === normalize(label));
    if (saved) {
      if (!isLatLng(saved) && ctx.geocode) {
        const geo = await ctx.geocode(saved.address, { city: saved.city ?? ctx.company.city, country: ctx.company.country });
        if (geo) {
          saved.lat = geo.lat; saved.lng = geo.lng;
          await ctx.prisma.customer.update({
            where: { id: customer.id },
            data: { addressesJson: JSON.stringify(addresses) },
          });
        }
      }
      return { ok: true, dest: saved };
    }
    if (!str(args.direccion)) {
      return { ok: false, error: `No hay una dirección guardada con la etiqueta "${label}".` };
    }
  }
  const text = str(args.direccion);
  if (!text) return { ok: false, error: 'Falta la dirección: pídela o pide que comparta la ubicación.' };
  const dest: Destination = { label: label || 'Indicada en la conversación', address: text, city: ctx.company.city ?? undefined };
  if (ctx.geocode) {
    const geo = await ctx.geocode(text, { city: ctx.company.city, country: ctx.company.country });
    if (geo) { dest.lat = geo.lat; dest.lng = geo.lng; }
  }
  return { ok: true, dest };
}

function scheduleSummary(cfg: Record<string, any>) {
  const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const schedule = cfg.schedule ?? {};
  return {
    dias: Array.isArray(schedule.days) ? schedule.days.map((d: number) => names[d]) : 'todos los días',
    abre: schedule.open ?? null,
    cierra: schedule.close ?? null,
    corte_pedidos_dia_anterior: cfg.orderCutoff ?? null,
    anticipacion_minima_horas: cfg.minLeadHours ?? 0,
    franjas: Array.isArray(cfg.slots) ? cfg.slots.map((s: any) => `${s.label ?? s.key ?? ''} ${s.from}-${s.to}`.trim()) : [],
  };
}

/** ¿Está abierto ahora? (en la zona horaria de la empresa) */
function openNow(cfg: Record<string, any>, now: Date, tz: string): boolean | null {
  const schedule = cfg.schedule ?? {};
  if (!schedule.open || !schedule.close) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'America/Bogota', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const hhmm = (v: string) => { const [h, m] = String(v).split(':').map(Number); return h * 60 + (m || 0); };
  if (Array.isArray(schedule.days) && schedule.days.length && !schedule.days.includes(day)) return false;
  return minutes >= hhmm(schedule.open) && minutes <= hhmm(schedule.close);
}

async function orderSummary(ctx: ToolContext, order: any) {
  const currency = ctx.company.currency ?? 'COP';
  const address = parseJson<any>(order.deliveryAddressJson, {});
  return {
    codigo: orderCode(order.id),
    estado: CUSTOMER_STATUS_LABEL[order.status] ?? order.status,
    items: (order.items ?? []).map((i: any) => ({
      producto: i.productName,
      cantidad: i.quantity,
      ...(i.presentation ? { presentacion: i.presentation } : {}),
      ...(i.specifications ? { notas: i.specifications } : {}),
    })),
    entrega: order.deliveryAt ? fmtDate(order.deliveryAt, ctx.company.timezone) : null,
    direccion: address.address ?? null,
    subtotal: money(order.subtotal, currency),
    envio: order.deliveryFee != null ? money(order.deliveryFee, currency) : null,
    ...(order.discount ? { descuento: money(order.discount, currency) } : {}),
    total: money(order.total, currency),
    pago: PAYMENT_LABEL[order.paymentStatus ?? 'NONE'] ?? 'Pendiente',
  };
}

/* ─── catálogo de herramientas ───────────────────────────────────────── */

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'ver_menu',
    access: 'read',
    description: 'Productos vigentes con precio, categoría y presentaciones. Úsala antes de ofrecer o cotizar cualquier cosa',
    params: '{"categoria"?: string, "buscar"?: string}',
    async run(ctx, args) {
      const currency = ctx.company.currency ?? 'COP';
      let products = await activeProducts(ctx);
      const cat = normalize(str(args.categoria, 60));
      const q = normalize(str(args.buscar, 60));
      if (cat) products = products.filter((p: any) => normalize(p.category ?? '').includes(cat));
      if (q) products = products.filter((p: any) => normalize(`${p.name} ${p.description ?? ''}`).includes(q));
      const menu = ctx.orderConfig?.menu?.enabled
        ? `${await publicWebUrl(ctx.prisma)}/m/${ctx.company.slug}`
        : null;
      return {
        moneda: currency,
        ...(menu ? { link_menu: menu } : {}),
        productos: products.slice(0, 60).map((p: any) => ({
          nombre: p.name,
          categoria: p.category ?? null,
          ...(isSoldOut(p, ctx.now) ? { agotado: true } : {}),
          precio: p.price != null ? money(p.price, currency) : 'precio a confirmar con el equipo',
          unidad: p.unit,
          ...(p.description ? { descripcion: p.description } : {}),
          presentaciones: parseJson<any[]>(p.presentationsJson, [])
            .map((x) => (typeof x === 'string' ? x : x?.name))
            .filter(Boolean),
        })),
        ...(products.length === 0 ? { nota: 'No hay productos que coincidan.' } : {}),
      };
    },
  },
  {
    name: 'ver_horarios',
    access: 'read',
    description: 'Horario de atención/entregas, corte de pedidos, franjas y si está abierto en este momento',
    params: '{}',
    async run(ctx) {
      const cfg = ctx.orderConfig ?? {};
      const delivery = deliveryCfg(ctx);
      return {
        ahora: fmtDate(ctx.now, ctx.company.timezone),
        abierto_ahora: openNow(cfg, ctx.now, ctx.company.timezone),
        ...scheduleSummary(cfg),
        domicilios: delivery.enabled
          ? { activos: true, cobertura_km: delivery.maxKm ?? null, tiempo_preparacion_min: delivery.prepMinutes ?? 25 }
          : { activos: false },
      };
    },
  },
  {
    name: 'ver_cliente',
    access: 'read',
    description: 'Ficha del cliente que escribe: nombre, direcciones guardadas, últimos pedidos y si compartió ubicación',
    params: '{}',
    async run(ctx) {
      const customer = await customerOf(ctx, false);
      const loc = await sharedLocation(ctx);
      if (!customer) {
        return {
          cliente_nuevo: true,
          nombre_en_whatsapp: ctx.contact?.name ?? null,
          compartio_ubicacion: !!loc,
        };
      }
      const orders = await ctx.prisma.order.findMany({
        where: { companyId: ctx.company.id, customerId: customer.id, status: { not: 'borrador' }, ...NOT_DELETED },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
        take: 3,
      });
      return {
        cliente_nuevo: false,
        nombre: customer.name,
        notas: customer.notes ?? null,
        direcciones: parseJson<any[]>(customer.addressesJson, []).map((a) => ({
          etiqueta: a.label, direccion: a.address, ...(a.instructions ? { indicaciones: a.instructions } : {}),
        })),
        compartio_ubicacion: !!loc,
        ultimos_pedidos: await Promise.all(orders.map((o: any) => orderSummary(ctx, o))),
      };
    },
  },
  {
    name: 'calcular_envio',
    access: 'read',
    description: 'Cobertura, costo del domicilio y tiempo estimado de llegada para una dirección o la ubicación compartida',
    params: '{"direccion"?: string, "etiqueta_direccion"?: string, "usar_ubicacion_compartida"?: boolean, "subtotal"?: number}',
    async run(ctx, args) {
      const resolved = await resolveDestination(ctx, args);
      if (!resolved.ok) return { error: resolved.error };
      const { dest } = resolved;
      const currency = ctx.company.currency ?? 'COP';
      const { quote, branch } = await quoteFor(ctx, dest, Number(args.subtotal) || 0);
      if (!quote.covered && !isLatLng(dest) && deliveryCfg(ctx).pricingMode !== 'ZONES') {
        return {
          error: 'No pude ubicar esa dirección en el mapa. Pídele al cliente que comparta su ubicación por WhatsApp.',
          direccion: dest.address,
        };
      }
      return {
        direccion: dest.address,
        cubierto: quote.covered,
        ...(quote.reason ? { motivo: quote.reason } : {}),
        ...(quote.zone ? { zona: quote.zone } : {}),
        ...(branch ? { sucursal: branch.name } : {}),
        distancia_km: quote.km,
        costo_envio: quote.fee != null ? money(quote.fee, currency) : null,
        tiempo_estimado_min: quote.etaMinutes,
      };
    },
  },
  {
    name: 'armar_pedido',
    access: 'write',
    description: 'Crea o REEMPLAZA el borrador del pedido de esta conversación (lista completa de ítems, entrega y dirección). Devuelve el resumen con precios para que se lo muestres al cliente',
    params: '{"items": [{"producto": string, "cantidad": number, "presentacion"?: string, "notas"?: string}], "entrega"?: "YYYY-MM-DDTHH:mm" | "lo antes posible", "direccion"?: string, "etiqueta_direccion"?: string, "usar_ubicacion_compartida"?: boolean, "observaciones"?: string, "cupon"?: string}',
    async run(ctx, args) {
      const rawItems = Array.isArray(args.items) ? args.items.slice(0, 40) : [];
      if (rawItems.length === 0) return { error: 'items vacío: arma el pedido con al menos un producto.' };
      const products = await activeProducts(ctx);
      const currency = ctx.company.currency ?? 'COP';
      const items: any[] = [];
      const notFound: string[] = [];
      const soldOut: string[] = [];
      for (const raw of rawItems) {
        const name = str(raw?.producto, 120);
        const qty = Number(raw?.cantidad);
        if (!name || !Number.isFinite(qty) || qty <= 0 || qty > 1000) {
          return { error: `Ítem inválido: ${JSON.stringify(raw).slice(0, 120)} (producto y cantidad > 0 requeridos)` };
        }
        const product = matchProduct(products, name);
        if (!product) { notFound.push(name); continue; }
        if (isSoldOut(product, ctx.now)) { soldOut.push(product.name); continue; }
        items.push({
          companyId: ctx.company.id,
          productId: product.id,
          productName: product.name,
          quantity: qty,
          unit: product.unit ?? 'unidad',
          presentation: str(raw?.presentacion, 80) || null,
          specifications: str(raw?.notas, 200) || null,
          productionAreaId: product.productionAreaId ?? null,
          _price: product.price ?? null,
        });
      }
      if (notFound.length) {
        return {
          error: 'Hay productos que no están en el menú. No inventes: muéstrale opciones reales (ver_menu) o pregunta.',
          no_encontrados: notFound,
        };
      }
      if (soldOut.length) {
        return {
          error: 'Hay productos agotados en este momento: ofrécele otra opción del menú.',
          agotados: soldOut,
        };
      }
      const pricesComplete = items.every((i) => i._price != null);
      const subtotal = roundMoney(items.reduce((sum, i) => sum + (i._price ?? 0) * i.quantity, 0), currency);

      const existing = ctx.state.draftOrderId
        ? await ctx.prisma.order.findUnique({ where: { id: ctx.state.draftOrderId } })
        : await ctx.prisma.order.findFirst({
            where: { conversationId: ctx.conversation.id, status: 'borrador', ...NOT_DELETED },
            orderBy: { createdAt: 'desc' },
          });

      // Dirección: nueva si viene en los argumentos; si no, la del borrador
      let address: Destination | null = null;
      if (args.usar_ubicacion_compartida || str(args.direccion) || str(args.etiqueta_direccion)) {
        const resolved = await resolveDestination(ctx, args);
        if (!resolved.ok) return { error: resolved.error };
        address = resolved.dest;
      } else if (existing) {
        const prev = parseJson<any>(existing.deliveryAddressJson, {});
        if (prev.address) address = prev;
      }

      const delivery = deliveryCfg(ctx);
      let fee: number | null = null;
      let km: number | null = null;
      let etaMinutes: number | null = null;
      let branchId: string | null = null;
      let zone: string | null = null;
      if (delivery.enabled && address && (isLatLng(address) || delivery.pricingMode === 'ZONES')) {
        const { quote, branch } = await quoteFor(ctx, address, subtotal);
        if (!quote.covered) return { error: `Fuera de cobertura: ${quote.reason}`, distancia_km: quote.km };
        fee = quote.fee; km = quote.km; etaMinutes = quote.etaMinutes;
        branchId = branch?.id ?? null; zone = quote.zone ?? null;
      }

      // Promoción: el cupón que dijo el cliente o la mejor automática
      const promos = await ctx.prisma.promotion.findMany({ where: { companyId: ctx.company.id, active: true } });
      const promoPick = pickPromotion(promos, {
        items: items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i._price })),
        subtotal, deliveryFee: fee, now: ctx.now,
      }, str(args.cupon, 30) || existing?.couponCode || null);
      if (str(args.cupon, 30) && !promoPick.result.ok) {
        return { error: `Cupón no aplicado: ${promoPick.result.reason}` };
      }
      const discount = promoPick.result.ok ? roundMoney(promoPick.result.discount, currency) : 0;

      // Entrega: "lo antes posible" (domicilios) o fecha/hora concreta
      let deliveryAt: Date | null = null;
      let asap = false;
      const when = str(args.entrega, 40);
      if (!when || /antes posible|ya|ahora|asap/i.test(when)) {
        if (delivery.enabled) {
          asap = true;
          deliveryAt = new Date(ctx.now.getTime() + (etaMinutes ?? Number(delivery.prepMinutes ?? 25) + 20) * 60e3);
        } else if (existing?.deliveryAt) {
          deliveryAt = existing.deliveryAt;
        }
      } else {
        const parsed = new Date(when);
        if (Number.isNaN(parsed.getTime())) return { error: `Fecha de entrega inválida: "${when}". Usa YYYY-MM-DDTHH:mm.` };
        deliveryAt = parsed;
      }

      const total = Math.max(0, roundMoney(subtotal + (fee ?? 0) - discount, currency));
      const data: Record<string, any> = {
        discount: discount || null,
        couponCode: promoPick.result.ok ? normalizeCode(promoPick.promo?.code) ?? null : null,
        branchId,
        deliveryAt: deliveryAt ?? existing?.deliveryAt ?? new Date(ctx.now.getTime() + 24 * 3600e3),
        deliveryAddressJson: JSON.stringify(address ?? {}),
        observations: str(args.observaciones, 500) || existing?.observations || null,
        subtotal: pricesComplete ? subtotal : null,
        deliveryFee: fee,
        total: pricesComplete ? total : null,
        distanceKm: km,
        etaAt: asap ? deliveryAt : null,
      };
      const cleanItems = items.map(({ _price, ...rest }) => rest);

      let orderId: string;
      if (existing && existing.status === 'borrador') {
        await ctx.prisma.orderItem.deleteMany({ where: { orderId: existing.id } });
        await ctx.prisma.order.update({ where: { id: existing.id }, data: { ...data, items: { create: cleanItems } } });
        orderId = existing.id;
      } else {
        const customer = await customerOf(ctx, true);
        const created = await ctx.prisma.order.create({
          data: {
            companyId: ctx.company.id,
            customerId: customer.id,
            contactId: ctx.contact.id,
            conversationId: ctx.conversation.id,
            status: 'borrador',
            takenByType: 'IA',
            ...data,
            items: { create: cleanItems },
          },
        });
        await ctx.prisma.orderStatusHistory.create({
          data: {
            companyId: ctx.company.id, orderId: created.id, fromStatus: null, toStatus: 'borrador',
            authorType: 'IA', authorName: 'Agente IA',
          },
        });
        orderId = created.id;
      }
      ctx.state.draftOrderId = orderId;

      const missing: string[] = [];
      if (!address?.address) missing.push('direccion');
      if (!deliveryAt && !delivery.enabled) missing.push('fecha y hora de entrega');
      if (delivery.enabled && address && !isLatLng(address) && delivery.pricingMode !== 'ZONES') missing.push('ubicacion (pide que comparta la ubicación para calcular el envío)');
      return {
        ok: true,
        borrador: {
          items: items.map((i) => ({
            producto: i.productName,
            cantidad: i.quantity,
            precio_unitario: money(i._price, currency) ?? 'a confirmar',
            ...(i.presentation ? { presentacion: i.presentation } : {}),
            ...(i.specifications ? { notas: i.specifications } : {}),
          })),
          subtotal: pricesComplete ? money(subtotal, currency) : 'a confirmar (hay productos sin precio)',
          envio: fee != null ? (fee === 0 ? 'gratis' : money(fee, currency)) : delivery.enabled ? 'pendiente de ubicación' : null,
          ...(zone ? { zona: zone } : {}),
          ...(discount ? { descuento: `-${money(discount, currency)} (${promoPick.promo?.name})` } : {}),
          total: pricesComplete ? money(total, currency) : 'a confirmar',
          entrega: asap
            ? `lo antes posible (aprox. ${etaMinutes ?? (delivery.prepMinutes ?? 25) + 20} min)`
            : deliveryAt ? fmtDate(deliveryAt, ctx.company.timezone) : 'sin definir',
          direccion: address?.address ?? 'sin definir',
        },
        faltantes: missing,
        siguiente_paso: missing.length
          ? 'Pide lo que falta.'
          : 'Muestra este resumen al cliente y pídele un SÍ explícito antes de confirmar_pedido.',
      };
    },
  },
  {
    name: 'confirmar_pedido',
    access: 'write',
    description: 'Confirma el borrador SOLO después de que el cliente aceptó explícitamente el resumen completo. Devuelve el código y el link de seguimiento',
    params: '{"cliente_confirmo": true}',
    async run(ctx, args) {
      if (args.cliente_confirmo !== true) {
        return { error: 'Solo se confirma cuando el cliente dijo que SÍ al resumen completo.' };
      }
      const draft = await ctx.prisma.order.findFirst({
        where: {
          ...(ctx.state.draftOrderId ? { id: ctx.state.draftOrderId } : { conversationId: ctx.conversation.id }),
          status: 'borrador', ...NOT_DELETED,
        },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!draft) return { error: 'No hay borrador para confirmar: usa armar_pedido primero.' };
      if (draft.items.length === 0) return { error: 'El borrador no tiene productos.' };
      const address = parseJson<any>(draft.deliveryAddressJson, {});
      if (!address.address) return { error: 'Falta la dirección de entrega.' };
      if (deliveryCfg(ctx).enabled && deliveryCfg(ctx).pricingMode !== 'ZONES' && !isLatLng(address)) {
        return { error: 'Falta la ubicación exacta para el domiciliario: pide que comparta la ubicación.' };
      }
      if (ctx.orders) {
        const agenda = await ctx.orders.validateAgenda(ctx.company.id, draft.deliveryAt, draft.id);
        if (!agenda.ok) {
          return {
            error: `No se puede para esa hora: ${agenda.reason}`,
            alternativas: agenda.alternatives.map((d) => fmtDate(d, ctx.company.timezone)),
          };
        }
      }
      await ctx.prisma.order.update({ where: { id: draft.id }, data: { status: 'confirmado' } });
      await ctx.prisma.orderStatusHistory.create({
        data: {
          companyId: ctx.company.id, orderId: draft.id, fromStatus: 'borrador', toStatus: 'confirmado',
          authorType: 'IA', authorName: 'Agente IA', reason: 'El cliente aceptó el resumen por chat',
        },
      });
      let scheduled = true;
      if (ctx.orders) {
        const pipeline = await ctx.orders.runConfirmationPipeline(draft.id, { type: 'IA', name: 'Agente IA' });
        scheduled = pipeline.scheduled;
      }
      // Embudo estándar: quien confirma pasa a CLIENTE (los embudos propios los mueve la empresa)
      if (ctx.contact?.id && !ctx.contact.pipelineId && ctx.contact.stage !== 'CLIENTE') {
        await ctx.prisma.contact.update({ where: { id: ctx.contact.id }, data: { stage: 'CLIENTE' } });
      }
      // Uso del cupón (condicional: nunca pasa de los usos máximos)
      if (draft.couponCode || draft.discount) {
        const promo = draft.couponCode
          ? await ctx.prisma.promotion.findFirst({ where: { companyId: ctx.company.id, code: draft.couponCode } })
          : null;
        if (promo) {
          await ctx.prisma.promotion.updateMany({
            where: { id: promo.id, ...(promo.maxUses != null ? { usedCount: { lt: promo.maxUses } } : {}) },
            data: { usedCount: { increment: 1 } },
          });
        }
      }
      const payCfg = parseJson<Record<string, any>>(ctx.company.paymentConfigJson, {});
      ctx.state.confirmedOrderId = draft.id;
      ctx.state.draftOrderId = draft.id;
      const link = await ensureTrackingLink(ctx.prisma, draft.id);
      const fresh = await ctx.prisma.order.findUnique({ where: { id: draft.id }, include: { items: true } });
      return {
        ok: true,
        quedo_en_revision: !scheduled,
        pedido: await orderSummary(ctx, fresh ?? draft),
        link_seguimiento: link,
        cobro: {
          pago_en_linea: !!payCfg.publicKey && !!ctx.payments,
          ...(payCfg.manualInstructions ? { instrucciones_pago: payCfg.manualInstructions } : {}),
          efectivo: payCfg.acceptCash !== false,
        },
        siguiente_paso: payCfg.publicKey
          ? 'Confírmale con el código y el link de seguimiento; si quiere pagar en línea usa enviar_link_pago.'
          : 'Confírmale al cliente con el código y compártele el link de seguimiento tal cual.',
      };
    },
  },
  {
    name: 'estado_pedido',
    access: 'read',
    description: 'Estado del pedido del cliente (el activo más reciente o por código), con domiciliario, tiempo estimado y link de seguimiento',
    params: '{"codigo"?: string}',
    async run(ctx, args) {
      const where: Record<string, any> = { companyId: ctx.company.id, status: { not: 'borrador' }, ...NOT_DELETED };
      if (ctx.contact?.customerId) where.customerId = ctx.contact.customerId;
      else where.contactId = ctx.contact?.id ?? '__none__';
      const orders = await ctx.prisma.order.findMany({
        where, include: { items: true }, orderBy: { createdAt: 'desc' }, take: 10,
      });
      const code = str(args.codigo, 12).replace('#', '').toUpperCase();
      const order = code
        ? orders.find((o: any) => orderCode(o.id) === code)
        : orders.find((o: any) => ACTIVE_STATUSES.includes(o.status)) ?? orders[0];
      if (!order) return { error: code ? `No encontré el pedido #${code} de este cliente.` : 'Este cliente no tiene pedidos registrados.' };
      let courier: any = null;
      if (order.courierId && order.status === 'despachado') {
        const user = await ctx.prisma.user.findUnique({ where: { id: order.courierId } });
        courier = user ? { nombre: String(user.name).split(' ')[0] } : null;
      }
      const etaMin = order.etaAt ? Math.max(0, Math.round((new Date(order.etaAt).getTime() - ctx.now.getTime()) / 60e3)) : null;
      return {
        pedido: await orderSummary(ctx, order),
        ...(courier ? { domiciliario: courier } : {}),
        ...(etaMin != null && ['despachado', 'listo', 'empacado', 'en_produccion', 'programado'].includes(order.status)
          ? { llega_en_min: etaMin } : {}),
        link_seguimiento: await ensureTrackingLink(ctx.prisma, order.id),
      };
    },
  },
  {
    name: 'cancelar_pedido',
    access: 'write',
    description: 'Cancela un pedido que todavía no entró a preparación. Si ya está en cocina o en camino NO se puede: pasa a humano',
    params: '{"codigo"?: string, "motivo": string}',
    async run(ctx, args) {
      const where: Record<string, any> = { companyId: ctx.company.id, ...NOT_DELETED };
      if (ctx.contact?.customerId) where.customerId = ctx.contact.customerId;
      else where.contactId = ctx.contact?.id ?? '__none__';
      const orders = await ctx.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 });
      const code = str(args.codigo, 12).replace('#', '').toUpperCase();
      const order = code
        ? orders.find((o: any) => orderCode(o.id) === code)
        : orders.find((o: any) => ACTIVE_STATUSES.includes(o.status));
      if (!order) return { error: 'No encontré un pedido activo para cancelar.' };
      if (!CANCELLABLE.includes(order.status)) {
        return {
          error: `El pedido #${orderCode(order.id)} ya está "${CUSTOMER_STATUS_LABEL[order.status] ?? order.status}": no se puede cancelar automáticamente. Usa pasar_a_humano.`,
        };
      }
      const reason = str(args.motivo, 200) || 'Cancelado por el cliente vía WhatsApp';
      if (ctx.orders) {
        await ctx.orders.changeStatus(order.id, 'cancelado', { type: 'IA', name: 'Agente IA' }, reason);
      } else {
        await ctx.prisma.order.update({ where: { id: order.id }, data: { status: 'cancelado' } });
      }
      return { ok: true, codigo: orderCode(order.id), estado: 'Cancelado' };
    },
  },
  {
    name: 'guardar_direccion',
    access: 'write',
    description: 'Guarda una dirección en la ficha del cliente (con su ubicación) para próximos pedidos',
    params: '{"etiqueta": string, "direccion"?: string, "usar_ubicacion_compartida"?: boolean, "indicaciones"?: string}',
    async run(ctx, args) {
      const label = str(args.etiqueta, 40);
      if (!label) return { error: 'Falta la etiqueta (ej. "Casa", "Oficina").' };
      const resolved = await resolveDestination(ctx, { ...args, etiqueta_direccion: undefined });
      if (!resolved.ok) return { error: resolved.error };
      const customer = await customerOf(ctx, true);
      const addresses = parseJson<any[]>(customer.addressesJson, []).filter(
        (a) => normalize(a.label ?? '') !== normalize(label),
      );
      const entry = {
        label,
        address: resolved.dest.address,
        ...(resolved.dest.city ? { city: resolved.dest.city } : {}),
        ...(str(args.indicaciones) ? { instructions: str(args.indicaciones, 200) } : {}),
        ...(isLatLng(resolved.dest) ? { lat: resolved.dest.lat, lng: resolved.dest.lng } : {}),
      };
      addresses.push(entry);
      await ctx.prisma.customer.update({
        where: { id: customer.id },
        data: { addressesJson: JSON.stringify(addresses.slice(-10)) },
      });
      return { ok: true, guardada: { etiqueta: label, direccion: entry.address, con_ubicacion: isLatLng(entry) } };
    },
  },
  {
    name: 'ver_promociones',
    access: 'read',
    description: 'Promociones y cupones vigentes que puedes ofrecer (combos, % de descuento, domicilio gratis)',
    params: '{}',
    async run(ctx) {
      const currency = ctx.company.currency ?? 'COP';
      const promos = await ctx.prisma.promotion.findMany({ where: { companyId: ctx.company.id, active: true, public: true } });
      const now = ctx.now;
      const vigentes = promos.filter((p: any) =>
        (!p.startsAt || new Date(p.startsAt) <= now) && (!p.endsAt || new Date(p.endsAt) >= now) &&
        (p.maxUses == null || (p.usedCount ?? 0) < p.maxUses));
      return {
        promociones: vigentes.map((p: any) => ({
          nombre: p.name,
          ...(p.description ? { detalle: p.description } : {}),
          beneficio: p.kind === 'PERCENT' ? `${p.value}% de descuento` : p.kind === 'FIXED' ? `${money(p.value, currency)} de descuento` : 'domicilio gratis',
          ...(p.code ? { cupon: p.code } : { se_aplica_sola: true }),
          ...(p.minSubtotal ? { compra_minima: money(p.minSubtotal, currency) } : {}),
          ...(p.endsAt ? { hasta: fmtDate(new Date(p.endsAt), ctx.company.timezone) } : {}),
        })),
        ...(vigentes.length === 0 ? { nota: 'No hay promociones vigentes.' } : {}),
      };
    },
  },
  {
    name: 'enviar_link_pago',
    access: 'write',
    description: 'Genera el link de pago en línea (Wompi: tarjeta, Nequi, PSE) del pedido confirmado del cliente. Si el negocio no cobra en línea, devuelve las instrucciones de pago manual',
    params: '{"codigo"?: string}',
    async run(ctx, args) {
      const where: Record<string, any> = { companyId: ctx.company.id, status: { notIn: ['borrador', 'cancelado'] }, paymentStatus: { not: 'PAID' }, ...NOT_DELETED };
      if (ctx.contact?.customerId) where.customerId = ctx.contact.customerId;
      else where.contactId = ctx.contact?.id ?? '__none__';
      const orders = await ctx.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 10 });
      const code = str(args.codigo, 12).replace('#', '').toUpperCase();
      const order = code ? orders.find((o: any) => orderCode(o.id) === code) : orders[0];
      if (!order) return { error: 'No hay un pedido confirmado pendiente de pago (si aún no confirma, usa confirmar_pedido primero).' };
      const payCfg = parseJson<Record<string, any>>(ctx.company.paymentConfigJson, {});
      if (!payCfg.publicKey || !ctx.payments) {
        return payCfg.manualInstructions
          ? { pago_en_linea: false, instrucciones_pago: payCfg.manualInstructions, nota: 'Pídele que envíe la foto del comprobante por aquí.' }
          : { error: 'El negocio no tiene pago en línea configurado: acuerda el pago con el cliente o pasar_a_humano.' };
      }
      try {
        const link = await ctx.payments.createOrderPaymentLink(order.id, null);
        return {
          ok: true,
          codigo: orderCode(order.id),
          total: money(order.total, ctx.company.currency ?? 'COP'),
          link_pago: link.url,
          siguiente_paso: 'Compártele el link de pago tal cual. Cuando pague, el pedido se marca solo como pagado.',
        };
      } catch (err: any) {
        return { error: err?.message ?? 'No se pudo generar el link de pago' };
      }
    },
  },
  {
    name: 'buscar_conocimiento',
    access: 'read',
    description: 'Busca en la base de conocimiento del negocio (políticas, preguntas frecuentes, documentos, página web) la respuesta a una duda del cliente',
    params: '{"pregunta": string}',
    async run(ctx, args) {
      const q = str(args.pregunta, 300);
      if (!q) return { error: 'Falta la pregunta.' };
      if (!ctx.knowledge) return { resultados: [], nota: 'Base de conocimiento no disponible.' };
      const hits = await ctx.knowledge.search(ctx.company.id, q, 3);
      return hits.length
        ? { resultados: hits.map((h) => ({ fuente: h.doc, texto: h.text.slice(0, 1200) })) }
        : { resultados: [], nota: 'No encontré nada sobre eso: no inventes, ofrece pasar_a_humano.' };
    },
  },
  {
    name: 'pasar_a_humano',
    access: 'read', // siempre disponible: el agente nunca queda atrapado
    description: 'Pasa la conversación a una persona del equipo (reclamos, casos raros, lo que no puedas resolver con certeza)',
    params: '{"motivo": string, "mensaje_al_cliente"?: string}',
    async run(_ctx, args) {
      return { escalar: true, motivo: str(args.motivo, 300) || 'El agente pidió ayuda humana' };
    },
  },
];

export const TOOL_NAMES = AGENT_TOOLS.map((t) => t.name);

/** Plantillas de agente por tipo de negocio (preconfiguran permisos). */
export const AGENT_PRESETS: Record<string, { label: string; description: string; tools: Array<{ tool: string; access: ToolAccess }> }> = {
  domicilios: {
    label: 'Restaurante / domicilios',
    description: 'Toma pedidos con precios, calcula el envío por ubicación, confirma y comparte el seguimiento en vivo',
    tools: AGENT_TOOLS.map((t) => ({ tool: t.name, access: t.access })),
  },
  pedidos_programados: {
    label: 'Pedidos programados (catering / almuerzos)',
    description: 'Pedidos con fecha y franja de entrega, direcciones guardadas y agenda con capacidad',
    tools: AGENT_TOOLS.filter((t) => t.name !== 'calcular_envio').map((t) => ({ tool: t.name, access: t.access })),
  },
  solo_consultas: {
    label: 'Solo consultas',
    description: 'Responde menú, horarios, envíos y estado de pedidos; no crea ni cancela nada',
    tools: AGENT_TOOLS.filter((t) => t.access === 'read').map((t) => ({ tool: t.name, access: 'read' as ToolAccess })),
  },
};

/** Herramientas habilitadas para un bot (pasar_a_humano siempre). */
export function enabledTools(toolsJson: string | null | undefined): Map<string, ToolAccess> {
  const config = parseJson<Array<{ tool: string; access: ToolAccess }>>(toolsJson, []);
  const map = new Map<string, ToolAccess>();
  for (const entry of Array.isArray(config) ? config : []) {
    const tool = AGENT_TOOLS.find((t) => t.name === entry?.tool);
    if (!tool) continue;
    map.set(tool.name, entry.access === 'write' ? 'write' : 'read');
  }
  map.set('pasar_a_humano', 'read');
  return map;
}

/** Sanea la config de herramientas que llega del panel. */
export function sanitizeToolsConfig(raw: unknown): Array<{ tool: string; access: ToolAccess }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Array<{ tool: string; access: ToolAccess }> = [];
  for (const entry of raw as any[]) {
    const tool = AGENT_TOOLS.find((t) => t.name === entry?.tool);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    // una herramienta de escritura puede quedar en solo lectura, nunca al revés
    const access: ToolAccess = entry.access === 'write' && tool.access === 'write' ? 'write' : 'read';
    out.push({ tool: tool.name, access });
  }
  return out;
}
