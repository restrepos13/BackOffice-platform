/**
 * Capa de IA agnóstica del proveedor.
 * Implementación actual y por defecto: DeepInfra (decisión de negocio: siempre
 * DeepInfra salvo indicación explícita). Cambiar de proveedor = nueva clase que
 * implemente AiProvider, sin tocar el motor.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiChatOptions {
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: ChatMessage[];
  /** Pide salida JSON estricta al proveedor (si lo soporta). */
  jsonMode?: boolean;
}

export interface AiChatResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AiTranscribeOptions {
  apiKey: string;
  filePath: string;
  mimeType: string;
  language?: string;
}

export interface AiProvider {
  chat(opts: AiChatOptions): Promise<AiChatResult>;
  transcribe(opts: AiTranscribeOptions): Promise<{ text: string }>;
}

/** Token de inyección del proveedor de IA. */
export const AI_PROVIDER = 'AI_PROVIDER';

/* ─── Contrato de salida del motor ───────────────────────────────────── */

export type EngineState =
  | 'saludo'
  | 'identificando'
  | 'tomando_pedido'
  | 'completando_datos'
  | 'esperando_confirmacion'
  | 'cerrado'
  | 'escalado';

export type EngineAction =
  | 'none'
  | 'update_draft'
  | 'request_confirmation'
  | 'confirm_order'
  | 'escalate';

export interface DraftItem {
  productName: string;
  quantity: number;
  unit?: string;
  presentation?: string;
  specifications?: string;
}

export interface DraftOrder {
  deliveryAtISO?: string; // fecha/hora de entrega en ISO
  addressLabel?: string; // etiqueta de una dirección conocida del cliente
  address?: string; // o dirección literal nueva
  observations?: string;
  items: DraftItem[];
}

/**
 * Lo que el modelo DEBE devolver: objeto tipado, jamás texto libre que luego
 * se parsea. Si no valida, se reintenta una vez y después se escala.
 */
export interface EngineOutput {
  reply: string[]; // 1..3 mensajes cortos, como escribe una persona
  state: EngineState;
  action: EngineAction;
  order: DraftOrder | null;
  confidence: number; // 0..1 — vs. umbral explícito de la organización
  escalationReason: string | null;
  missingFields: string[];
}

const STATES: EngineState[] = [
  'saludo', 'identificando', 'tomando_pedido', 'completando_datos',
  'esperando_confirmacion', 'cerrado', 'escalado',
];
const ACTIONS: EngineAction[] = [
  'none', 'update_draft', 'request_confirmation', 'confirm_order', 'escalate',
];

/** Extrae el primer objeto JSON del contenido (el modelo a veces envuelve). */
export function extractJson(content: string): unknown | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Validación manual y estricta del contrato (sin librerías nuevas).
 * Devuelve el objeto tipado o una lista de errores.
 */
export function validateEngineOutput(
  raw: unknown,
): { ok: true; output: EngineOutput } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['la salida no es un objeto JSON'] };
  }
  const o = raw as Record<string, unknown>;

  if (
    !Array.isArray(o.reply) ||
    o.reply.length < 1 ||
    o.reply.length > 3 ||
    !o.reply.every((r) => typeof r === 'string' && r.trim().length > 0)
  ) {
    errors.push('reply debe ser un arreglo de 1 a 3 strings no vacíos');
  }
  if (typeof o.state !== 'string' || !STATES.includes(o.state as EngineState)) {
    errors.push(`state inválido: ${String(o.state)}`);
  }
  if (typeof o.action !== 'string' || !ACTIONS.includes(o.action as EngineAction)) {
    errors.push(`action inválida: ${String(o.action)}`);
  }
  if (
    typeof o.confidence !== 'number' ||
    Number.isNaN(o.confidence) ||
    o.confidence < 0 ||
    o.confidence > 1
  ) {
    errors.push('confidence debe ser un número entre 0 y 1');
  }
  if (o.order !== null && o.order !== undefined) {
    const order = o.order as Record<string, unknown>;
    if (typeof order !== 'object') {
      errors.push('order debe ser objeto o null');
    } else {
      if (!Array.isArray(order.items)) {
        errors.push('order.items debe ser un arreglo');
      } else {
        for (const [i, itemRaw] of (order.items as unknown[]).entries()) {
          const item = itemRaw as Record<string, unknown>;
          if (typeof item?.productName !== 'string' || !item.productName.trim()) {
            errors.push(`order.items[${i}].productName requerido`);
          }
          if (typeof item?.quantity !== 'number' || item.quantity <= 0) {
            errors.push(`order.items[${i}].quantity debe ser número > 0`);
          }
        }
      }
      if (
        order.deliveryAtISO !== undefined &&
        order.deliveryAtISO !== null &&
        (typeof order.deliveryAtISO !== 'string' ||
          Number.isNaN(Date.parse(order.deliveryAtISO)))
      ) {
        errors.push('order.deliveryAtISO debe ser fecha ISO válida');
      }
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    output: {
      reply: (o.reply as string[]).map((r) => r.trim()),
      state: o.state as EngineState,
      action: o.action as EngineAction,
      order: (o.order ?? null) as DraftOrder | null,
      confidence: o.confidence as number,
      escalationReason:
        typeof o.escalationReason === 'string' ? o.escalationReason : null,
      missingFields: Array.isArray(o.missingFields)
        ? (o.missingFields as unknown[]).filter((m): m is string => typeof m === 'string')
        : [],
    },
  };
}
