/**
 * De dónde llegó cada chat: anuncio de Meta (clic a WhatsApp), publicación o
 * mensaje directo. Meta y Twilio mandan el "referral" en el primer mensaje
 * que viene de un anuncio; se guarda en la conversación y, la primera vez, en
 * el contacto (primer origen, nunca se sobreescribe).
 */
export interface ChatOrigin {
  kind: 'AD' | 'POST' | 'DIRECT';
  headline?: string;
  body?: string;
  sourceUrl?: string;
  sourceId?: string;
  ctwaClid?: string;
  at: string;
}

const cut = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function build(r: { source_type?: unknown; source_url?: unknown; source_id?: unknown; headline?: unknown; body?: unknown; ctwa_clid?: unknown }, at: Date): ChatOrigin | null {
  const sourceUrl = cut(r.source_url, 500);
  const sourceId = cut(r.source_id, 80);
  const ctwaClid = cut(r.ctwa_clid, 200);
  if (!sourceUrl && !sourceId && !ctwaClid) return null;
  const type = String(r.source_type ?? '').toLowerCase();
  return {
    kind: type === 'post' ? 'POST' : 'AD',
    headline: cut(r.headline, 160), body: cut(r.body, 300), sourceUrl, sourceId, ctwaClid, at: at.toISOString(),
  };
}

/** Twilio: ReferralSourceUrl, ReferralSourceId, ReferralSourceType, ReferralHeadline, ReferralBody, ReferralCtwaClid. */
export function originFromTwilio(payload: Record<string, any>, at = new Date()): ChatOrigin | null {
  return build({
    source_type: payload?.ReferralSourceType, source_url: payload?.ReferralSourceUrl, source_id: payload?.ReferralSourceId,
    headline: payload?.ReferralHeadline, body: payload?.ReferralBody, ctwa_clid: payload?.ReferralCtwaClid,
  }, at);
}

/** WhatsApp Cloud API: message.referral. */
export function originFromMeta(message: any, at = new Date()): ChatOrigin | null {
  return message?.referral ? build(message.referral, at) : null;
}

export function directOrigin(at = new Date()): ChatOrigin {
  return { kind: 'DIRECT', at: at.toISOString() };
}

/**
 * Datos a guardar: en la conversación nueva siempre hay origen (directo si no
 * vino de anuncio); si una conversación abierta recibe un anuncio, se marca.
 */
export function originUpdates(origin: ChatOrigin | null, conversation: { originJson?: string | null }, contact: { originJson?: string | null }, isNew: boolean) {
  const conv = origin ?? (isNew ? directOrigin() : null);
  return {
    conversation: conv && (isNew || (origin && !conversation.originJson?.includes('"AD"'))) ? { originJson: JSON.stringify(conv) } : null,
    contact: !contact.originJson && conv ? { originJson: JSON.stringify(conv) } : null,
  };
}
