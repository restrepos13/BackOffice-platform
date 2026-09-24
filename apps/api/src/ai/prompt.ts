import { parseJson } from '../common/constants';

/**
 * Constructor del contexto que se le pasa al modelo.
 * Incluye: personalidad efectiva (línea o bot), reglas de negocio de la
 * organización, catálogo vigente, ficha del cliente, pedidos anteriores y
 * el borrador actual. El historial de mensajes va como turnos del chat.
 */

export interface PromptContext {
  companyName: string;
  timezone: string;
  now: Date;
  // Personalidad efectiva (ya resuelta línea vs bot por el motor)
  systemPrompt: string;
  personality: Record<string, string>;
  sales: Record<string, string>;
  welcomeMessage?: string | null;
  // Reglas de agenda del negocio (Company.orderConfigJson)
  orderConfig: Record<string, any>;
  // Catálogo vigente
  products: Array<{
    name: string;
    category?: string | null;
    unit: string;
    presentations: string[];
    description?: string | null;
  }>;
  // Ficha del cliente (si se reconoció el número)
  customer?: {
    name: string;
    notes?: string | null;
    addresses: Array<{ label: string; address: string; city?: string; instructions?: string }>;
  } | null;
  contactName?: string | null;
  // Pedidos anteriores del cliente (para "lo mismo del mes pasado")
  previousOrders: Array<{
    deliveryAt: Date;
    status: string;
    addressLabel?: string;
    items: Array<{ productName: string; quantity: number; presentation?: string | null }>;
  }>;
  // Borrador vigente de esta conversación (si existe)
  draft?: {
    deliveryAt?: Date | null;
    address?: string | null;
    observations?: string | null;
    items: Array<{ productName: string; quantity: number; presentation?: string | null; specifications?: string | null }>;
  } | null;
  confidenceThreshold: number;
}

function fmtDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const cfg = ctx.orderConfig ?? {};
  const schedule = cfg.schedule ?? {};
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const days = Array.isArray(schedule.days)
    ? schedule.days.map((d: number) => dayNames[d]).join(', ')
    : 'todos los días';

  const catalog = ctx.products
    .map((p) => {
      const pres = p.presentations.length ? ` · presentaciones: ${p.presentations.join(' / ')}` : '';
      return `- ${p.name} (${p.unit})${p.category ? ` [${p.category}]` : ''}${pres}${p.description ? ` — ${p.description}` : ''}`;
    })
    .join('\n');

  const previous = ctx.previousOrders.length
    ? ctx.previousOrders
        .map(
          (o) =>
            `- ${fmtDate(o.deliveryAt, ctx.timezone)} (${o.status})${o.addressLabel ? ` · ${o.addressLabel}` : ''}: ` +
            o.items.map((i) => `${i.quantity} × ${i.productName}${i.presentation ? ` (${i.presentation})` : ''}`).join(', '),
        )
        .join('\n')
    : 'Sin pedidos anteriores registrados.';

  const customerBlock = ctx.customer
    ? `FICHA DEL CLIENTE (ya lo conocemos — NO le pidas datos que ya están aquí):
Empresa: ${ctx.customer.name}
Contacto que escribe: ${ctx.contactName ?? 'desconocido'}
Direcciones registradas:
${ctx.customer.addresses.map((a) => `- "${a.label}": ${a.address}${a.city ? `, ${a.city}` : ''}${a.instructions ? ` (${a.instructions})` : ''}`).join('\n') || '- ninguna'}
${ctx.customer.notes ? `Condiciones/notas: ${ctx.customer.notes}` : ''}

PEDIDOS ANTERIORES de este cliente (para "lo mismo de la vez pasada"):
${previous}`
    : 'CLIENTE NUEVO: no tenemos ficha de este número. Con naturalidad, averigua el nombre de la empresa y de la persona.';

  // Base de conocimiento configurable (orderConfig.knowledgeBase):
  // FAQs de la organización que el modelo puede responder sin escalar.
  const kb = Array.isArray(cfg.knowledgeBase) ? cfg.knowledgeBase : [];
  const kbBlock = kb.length
    ? `BASE DE CONOCIMIENTO (responde estas dudas con esta información, sin inventar más):
${kb
  .map((f: any) =>
    typeof f === 'string' ? `- ${f}` : `- P: ${f.question}\n  R: ${f.answer}`,
  )
  .join('\n')}`
    : '';

  const draftBlock = ctx.draft
    ? `BORRADOR ACTUAL del pedido en esta conversación:
${ctx.draft.items.map((i) => `- ${i.quantity} × ${i.productName}${i.presentation ? ` (${i.presentation})` : ''}${i.specifications ? ` — ${i.specifications}` : ''}`).join('\n') || '- sin ítems aún'}
Entrega: ${ctx.draft.deliveryAt ? fmtDate(ctx.draft.deliveryAt, ctx.timezone) : 'SIN DEFINIR'}
Dirección: ${ctx.draft.address ?? 'SIN DEFINIR'}
${ctx.draft.observations ? `Observaciones: ${ctx.draft.observations}` : ''}`
    : 'No hay borrador de pedido en esta conversación todavía.';

  return `${ctx.systemPrompt}

PERSONALIDAD Y ESTILO (obligatorio):
- Tono: ${ctx.personality.tone ?? 'natural y profesional'}
- Estilo: ${ctx.personality.style ?? 'mensajes cortos'}
- Límites: ${ctx.personality.limits ?? ''}
- JAMÁS digas que eres una IA, asistente virtual o bot. Jamás uses menús
  numerados, "presione 1", listas de opciones ni te disculpes como robot.
- Escribe como una persona: mensajes cortos, si hace falta en 2 o 3 envíos.
- Pide los datos que falten de a uno o dos, conversando, sin sonar a formulario.

REGLAS DE VENTA:
${Object.entries(ctx.sales).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n') || '- (sin reglas de venta específicas)'}

EL NEGOCIO (${ctx.companyName}) — REGLAS DE AGENDA (no aceptes pedidos que las violen; propone alternativas):
- Días de entrega: ${days}, de ${schedule.open ?? '—'} a ${schedule.close ?? '—'}
- Corte de pedidos: hasta las ${cfg.orderCutoff ?? '—'} del día anterior
- Anticipación mínima: ${cfg.minLeadHours ?? 0} horas
- Fecha y hora actual: ${fmtDate(ctx.now, ctx.timezone)} (zona ${ctx.timezone})

CATÁLOGO VIGENTE (solo puedes ofrecer esto):
${catalog || '- catálogo vacío'}

${kbBlock ? `${kbBlock}\n\n` : ''}${customerBlock}

${draftBlock}

CÓMO TRABAJAS (máquina de estados): saludo → identificando (qué necesita) →
tomando_pedido → completando_datos (falta fecha/dirección/cantidades) →
esperando_confirmacion (enviaste el RESUMEN COMPLETO y esperas un SÍ explícito)
→ cerrado. Si dudas o hay contradicciones: escalado.

REGLA DE ORO: si no estás seguro de algo (producto ambiguo, cantidad rara,
dirección que no coincide, información contradictoria), NO inventes. Pregunta
al cliente, y si sigue la duda usa action "escalate" con el motivo. Umbral de
confianza de la organización: ${ctx.confidenceThreshold}. Si tu confianza está
por debajo, escala.

CONFIRMACIÓN OBLIGATORIA: nunca uses action "confirm_order" sin que el cliente
haya respondido afirmativa y explícitamente al resumen completo (productos,
cantidades, fecha/hora, dirección). Sin ese sí, el pedido sigue en borrador.

FORMATO DE RESPUESTA — devuelve SOLO un objeto JSON, sin texto alrededor:
{
  "reply": ["mensaje 1", "mensaje 2 opcional", "mensaje 3 opcional"],
  "state": "saludo|identificando|tomando_pedido|completando_datos|esperando_confirmacion|cerrado|escalado",
  "action": "none|update_draft|request_confirmation|confirm_order|escalate",
  "order": null | {
    "deliveryAtISO": "2026-09-25T11:30:00-05:00",
    "addressLabel": "etiqueta de dirección conocida (si aplica)",
    "address": "dirección literal (si es nueva)",
    "observations": "…",
    "items": [{"productName": "…", "quantity": 45, "unit": "porción", "presentation": "…", "specifications": "…"}]
  },
  "confidence": 0.0,
  "escalationReason": null,
  "missingFields": ["deliveryAt", "address"]
}
En "order" manda SIEMPRE el borrador completo acumulado (no solo el cambio).
Los nombres de productos deben salir del catálogo.`;
}
