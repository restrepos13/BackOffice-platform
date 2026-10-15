import { readFile } from 'fs/promises';
import { AiProvider, extractJson } from './types';
import { AiSession } from './ai-access';

/**
 * Lectura de imágenes con un modelo de visión (DeepInfra): reconoce
 * comprobantes de pago (Nequi, Daviplata, Bancolombia, transferencias) y
 * extrae monto, entidad y referencia. Nunca marca un pedido como PAGADO por
 * sí sola: queda "comprobante recibido" para que una persona lo verifique.
 */

export const VISION_MODEL = 'meta-llama/Llama-3.2-11B-Vision-Instruct';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export interface ImageAnalysis {
  kind: 'RECEIPT' | 'OTHER';
  amount: number | null;
  currency: string | null;
  bank: string | null;
  reference: string | null;
  date: string | null;
  recipient: string | null;
  summary: string;
}

/** Valida y normaliza lo que devuelve el modelo (jamás se confía a ciegas). */
export function normalizeAnalysis(raw: unknown): ImageAnalysis {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const str = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  let amount: number | null = null;
  if (typeof o.monto === 'number') amount = o.monto;
  else if (typeof o.monto === 'string') {
    // "$41.000", "41,000.00", "41000" → 41000
    const digits = o.monto.replace(/[^\d,.]/g, '');
    const normalized = /,\d{2}$/.test(digits)
      ? digits.replace(/\./g, '').replace(',', '.')
      : digits.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.');
    const n = Number(normalized);
    amount = Number.isFinite(n) ? n : null;
  }
  if (amount != null && (amount <= 0 || amount > 1e9)) amount = null;
  const isReceipt = o.es_comprobante === true || o.es_comprobante === 'true';
  return {
    kind: isReceipt && amount != null ? 'RECEIPT' : 'OTHER',
    amount: isReceipt ? amount : null,
    currency: str(o.moneda, 5) ?? (isReceipt ? 'COP' : null),
    bank: str(o.entidad, 40),
    reference: str(o.referencia, 60),
    date: str(o.fecha, 40),
    recipient: str(o.destinatario, 80),
    summary: str(o.descripcion, 200) ?? (isReceipt ? 'Comprobante de pago' : 'Imagen'),
  };
}

/** Texto que ve la IA conversacional en lugar de la imagen. */
export function describeForChat(a: ImageAnalysis): string {
  if (a.kind === 'RECEIPT') {
    const money = a.amount != null ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: a.currency ?? 'COP', maximumFractionDigits: 0 }).format(a.amount) : 'monto ilegible';
    return `[imagen: comprobante de pago${a.bank ? ` ${a.bank}` : ''} por ${money}${a.reference ? `, ref ${a.reference}` : ''}]`;
  }
  return `[imagen: ${a.summary}]`;
}

export async function analyzeImage(
  ai: AiProvider,
  session: AiSession,
  filePath: string,
  mimeType: string,
): Promise<{ analysis: ImageAnalysis; inputTokens: number; outputTokens: number; billedTo: 'BYOK' | 'PLATFORM' }> {
  const buffer = await readFile(filePath);
  if (buffer.length > MAX_IMAGE_BYTES) {
    return {
      analysis: { kind: 'OTHER', amount: null, currency: null, bank: null, reference: null, date: null, recipient: null, summary: 'Imagen muy pesada para analizar' },
      inputTokens: 0, outputTokens: 0, billedTo: session.billedTo,
    };
  }
  const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`;
  const { result, billedTo } = await session.run((apiKey) =>
    ai.chat({
      apiKey,
      model: VISION_MODEL,
      temperature: 0,
      maxTokens: 300,
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content:
            'Analizas imágenes que un cliente envía por WhatsApp a un negocio en Colombia. ' +
            'Devuelve SOLO un JSON: {"es_comprobante": boolean, "monto": number|null, "moneda": "COP"|null, ' +
            '"entidad": "Nequi|Daviplata|Bancolombia|…"|null, "referencia": string|null, "fecha": string|null, ' +
            '"destinatario": string|null, "descripcion": "qué muestra la imagen en una frase"}. ' +
            'Es comprobante solo si muestra una transferencia o pago exitoso. No inventes datos ilegibles: usa null.',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '¿Qué hay en esta imagen?' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  );
  return {
    analysis: normalizeAnalysis(extractJson(result.content)),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    billedTo,
  };
}

/** ¿El monto del comprobante cubre el total del pedido? (tolerancia de $100) */
export function receiptMatches(amount: number | null, orderTotal: number | null | undefined): boolean {
  if (amount == null || orderTotal == null) return false;
  return amount + 100 >= orderTotal;
}

/** Cómo ve el modelo conversacional un mensaje (audio transcrito, imagen leída). */
export function messageForModel(m: {
  direction: string; type?: string | null; content: string;
  transcription?: string | null; analysisJson?: string | null; author?: string;
}): string {
  let text = m.content;
  if (m.direction === 'IN' && m.transcription) text = `[audio] ${m.transcription}`;
  if (m.direction === 'IN' && m.type === 'IMAGE' && m.analysisJson) {
    try {
      text = describeForChat(JSON.parse(m.analysisJson));
    } catch {
      /* análisis corrupto: se deja el texto original */
    }
  }
  return text + (m.author === 'AGENT' ? ' [respondió una persona del equipo]' : '');
}
