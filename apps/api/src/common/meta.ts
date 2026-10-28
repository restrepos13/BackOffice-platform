import { createHmac, timingSafeEqual } from 'crypto';
import { SendError, classifySendError, sanitizeError } from './inbox/delivery';
import { decryptSecret, isEncrypted } from './crypto';
import { parseJson } from './constants';

/**
 * Canales de Meta con la Graph API: Instagram, Messenger y WhatsApp Cloud API.
 * Token de página por integración (cifrado). Firma X-Hub-Signature-256 con el
 * App Secret de la app de Meta (META_APP_SECRET).
 */

/** Versión configurable: Meta retira versiones viejas (META_GRAPH_VERSION, por defecto v24.0). */
export const GRAPH = `https://graph.facebook.com/${(process.env.META_GRAPH_VERSION || 'v24.0').replace(/[^v0-9.]/g, '')}`;

export interface MetaLineConfig {
  provider: 'META';
  pageId?: string;
  igUserId?: string;
  phoneNumberId?: string;
  accessToken: string | null;
  sandbox: boolean;
}

export function metaLineConfig(integration: any): MetaLineConfig | null {
  const cfg = parseJson<Record<string, any>>(integration?.configJson, {});
  const isMetaChannel = ['INSTAGRAM', 'MESSENGER'].includes(integration?.type);
  if (cfg.provider !== 'META' && !isMetaChannel) return null;
  let accessToken: string | null = null;
  if (isEncrypted(cfg.accessTokenEnc)) {
    try {
      accessToken = decryptSecret(cfg.accessTokenEnc);
    } catch {
      accessToken = null;
    }
  }
  return {
    provider: 'META',
    pageId: cfg.pageId, igUserId: cfg.igUserId, phoneNumberId: cfg.phoneNumberId,
    // Sin token o marcada sandbox: jamás sale un mensaje real
    accessToken, sandbox: cfg.sandbox === true || !accessToken,
  };
}

/** X-Hub-Signature-256: "sha256=" + HMAC-SHA256(appSecret, cuerpo crudo). */
export function verifyMetaSignature(rawBody: Buffer | string | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const given = header.slice(7);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/** Envía un texto por el canal de Meta que corresponda. */
export async function sendMetaText(
  input: { channel: string; config: MetaLineConfig; recipient: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string }> {
  const { config } = input;
  if (!config.accessToken) throw new Error('La integración de Meta no tiene token');
  const isWhatsapp = input.channel === 'WHATSAPP';
  const url = isWhatsapp
    ? `${GRAPH}/${config.phoneNumberId}/messages`
    : `${GRAPH}/me/messages`;
  const body = isWhatsapp
    ? { messaging_product: 'whatsapp', to: input.recipient.replace(/[^\d]/g, ''), type: 'text', text: { body: input.text } }
    : { recipient: { id: input.recipient }, messaging_type: 'RESPONSE', message: { text: input.text.slice(0, 1000) } };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Sin respuesta: no se sabe si Meta lo recibió
    throw new SendError('UNCERTAIN', `Sin respuesta de Meta: ${sanitizeError(err)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw classifySendError({ status: res.status, code: data?.error?.code, message: `Meta respondió ${res.status}: ${data?.error?.message ?? 'error'}` });
  const id = data?.message_id ?? data?.messages?.[0]?.id;
  // Nunca se inventa un ID: si Meta aceptó pero no lo devolvió, el resultado es incierto
  if (!id) throw new SendError('UNCERTAIN', 'Meta respondió sin el identificador del mensaje');
  return { id: String(id) };
}

/** Eventos de mensaje de Instagram/Messenger normalizados (sin ecos). */
export function parseMessagingEvents(body: any): Array<{
  channel: 'INSTAGRAM' | 'MESSENGER'; accountId: string; senderId: string; mid: string; text: string; type: string;
}> {
  const channel = body?.object === 'instagram' ? 'INSTAGRAM' : body?.object === 'page' ? 'MESSENGER' : null;
  if (!channel) return [];
  const out: any[] = [];
  for (const entry of body?.entry ?? []) {
    for (const ev of entry?.messaging ?? []) {
      const msg = ev?.message;
      if (!msg || msg.is_echo || !ev?.sender?.id || !msg.mid) continue;
      const attachment = msg.attachments?.[0]?.type;
      out.push({
        channel,
        accountId: String(entry.id),
        senderId: String(ev.sender.id),
        mid: String(msg.mid),
        text: msg.text ?? (attachment ? `[${attachment} recibido]` : ''),
        type: attachment === 'image' ? 'IMAGE' : 'TEXT',
      });
    }
  }
  return out;
}
