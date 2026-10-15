import { AgentTool, ToolAccess } from './tools';

/**
 * Protocolo del agente (agnóstico del proveedor, JSON-mode):
 * en cada paso el modelo devuelve UNA de dos formas —
 *   {"tool_calls": [{"name": "...", "args": {...}}]}       → ejecutamos y le
 *                                                             devolvemos resultados
 *   {"reply": ["..."], "confidence": 0.9, "state": "..."}   → respuesta final
 * Validado a mano y estricto, igual que el contrato del motor de pedidos.
 */

export type AgentStep =
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, any> }> }
  | { kind: 'reply'; reply: string[]; confidence: number; state: string };

export const AGENT_STATES = [
  'saludo', 'consultando', 'tomando_pedido', 'esperando_confirmacion',
  'confirmado', 'seguimiento', 'cerrado',
];

export function validateAgentStep(
  raw: unknown,
): { ok: true; step: AgentStep } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['la salida no es un objeto JSON'] };
  }
  const o = raw as Record<string, any>;
  if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0) {
    if (o.tool_calls.length > 3) return { ok: false, errors: ['máximo 3 tool_calls por paso'] };
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    for (const [i, call] of o.tool_calls.entries()) {
      if (typeof call?.name !== 'string' || !call.name.trim()) {
        return { ok: false, errors: [`tool_calls[${i}].name requerido`] };
      }
      const args = call.args ?? call.arguments ?? {};
      if (typeof args !== 'object' || Array.isArray(args)) {
        return { ok: false, errors: [`tool_calls[${i}].args debe ser un objeto`] };
      }
      calls.push({ name: call.name.trim(), args });
    }
    return { ok: true, step: { kind: 'tools', calls } };
  }
  const errors: string[] = [];
  if (
    !Array.isArray(o.reply) || o.reply.length < 1 || o.reply.length > 3 ||
    !o.reply.every((r: unknown) => typeof r === 'string' && r.trim().length > 0)
  ) {
    errors.push('reply debe ser un arreglo de 1 a 3 strings no vacíos (o usa tool_calls)');
  }
  if (typeof o.confidence !== 'number' || Number.isNaN(o.confidence) || o.confidence < 0 || o.confidence > 1) {
    errors.push('confidence debe ser un número entre 0 y 1');
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    step: {
      kind: 'reply',
      reply: (o.reply as string[]).map((r) => r.trim()),
      confidence: o.confidence,
      state: typeof o.state === 'string' && AGENT_STATES.includes(o.state) ? o.state : 'consultando',
    },
  };
}

export interface AgentPromptContext {
  companyName: string;
  industry?: string | null;
  timezone: string;
  now: Date;
  systemPrompt: string;
  personality: Record<string, string>;
  sales: Record<string, string>;
  welcomeMessage?: string | null;
  knowledgeBase: any[];
  contactName?: string | null;
  tools: Array<{ tool: AgentTool; granted: ToolAccess }>;
  deliveryEnabled: boolean;
}

export function buildAgentPrompt(ctx: AgentPromptContext): string {
  const now = new Intl.DateTimeFormat('es-CO', {
    timeZone: ctx.timezone, weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(ctx.now);
  const isoNow = new Intl.DateTimeFormat('sv-SE', {
    timeZone: ctx.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(ctx.now).replace(' ', 'T');

  const toolLines = ctx.tools
    .map(({ tool }) => `- ${tool.name}${tool.access === 'write' ? ' (modifica datos)' : ''}: ${tool.description}. Args: ${tool.params}`)
    .join('\n');
  const kb = ctx.knowledgeBase.length
    ? `\nBASE DE CONOCIMIENTO (responde estas dudas sin inventar más):\n${ctx.knowledgeBase
        .map((f: any) => (typeof f === 'string' ? `- ${f}` : `- P: ${f.question}\n  R: ${f.answer}`))
        .join('\n')}\n`
    : '';
  const sales = Object.entries(ctx.sales).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');

  return `${ctx.systemPrompt || `Atiendes el WhatsApp de ${ctx.companyName}.`}

PERSONALIDAD Y ESTILO (obligatorio):
- Tono: ${ctx.personality.tone ?? 'cálido, cercano y eficiente'}
- Estilo: ${ctx.personality.style ?? 'mensajes cortos, como una persona por WhatsApp'}
${ctx.personality.limits ? `- Límites: ${ctx.personality.limits}\n` : ''}- JAMÁS digas que eres una IA o un bot. Nada de menús numerados ni "presione 1".
- Mensajes cortos (1 a 3 envíos). Pide los datos de a uno, conversando.
${ctx.welcomeMessage ? `- Saludo de bienvenida sugerido: "${ctx.welcomeMessage}"\n` : ''}${sales ? `\nREGLAS DE VENTA:\n${sales}\n` : ''}${kb}
NEGOCIO: ${ctx.companyName}${ctx.industry ? ` (${ctx.industry})` : ''}
Ahora: ${now} — en formato ISO local: ${isoNow} (zona ${ctx.timezone})
${ctx.contactName ? `Nombre del cliente en WhatsApp: ${ctx.contactName}\n` : ''}
TUS HERRAMIENTAS (son tu única fuente de verdad sobre el negocio):
${toolLines}

REGLAS DE ORO:
1. NUNCA inventes productos, precios, horarios, costos de envío ni estados de pedido: consúltalos con las herramientas. Si una herramienta devuelve "error", léelo y actúa (pregunta, ofrece alternativas o pasa a humano).
2. Antes de confirmar: usa armar_pedido, muéstrale al cliente el resumen (productos, total${ctx.deliveryEnabled ? ', envío' : ''}, entrega y dirección) y espera un SÍ explícito. Solo entonces confirmar_pedido con {"cliente_confirmo": true}.
3. Si el cliente cambia algo, vuelve a llamar armar_pedido con la lista COMPLETA actualizada.
${ctx.deliveryEnabled ? '4. Para domicilios lo ideal es la ubicación exacta: si la dirección no se pudo ubicar, pídele que comparta la ubicación por WhatsApp (clip > Ubicación).\n' : ''}5. Al confirmar, comparte el código del pedido y el link de seguimiento EXACTO que devuelve la herramienta.
6. Reclamos, enojo, pagos con problemas, casos raros o dudas que no puedas resolver con certeza → pasar_a_humano.

FORMATO DE SALIDA — devuelve SIEMPRE un único objeto JSON, una de estas dos formas:
A) Usar herramientas: {"tool_calls": [{"name": "<herramienta>", "args": {…}}]}   (máximo 3 por paso)
B) Responder al cliente: {"reply": ["mensaje 1", "mensaje 2"], "confidence": 0.0-1.0, "state": "saludo|consultando|tomando_pedido|esperando_confirmacion|confirmado|seguimiento|cerrado"}
"confidence" = qué tan seguro estás de que tu respuesta es correcta y completa.`;
}
