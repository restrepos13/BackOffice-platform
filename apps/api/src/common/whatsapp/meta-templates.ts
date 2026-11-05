import { GRAPH, MetaLineConfig } from '../meta';
import { SendError, classifySendError, sanitizeError } from '../inbox/delivery';
import { META_API_CATEGORY, MetaCategory, metaCategoryOf } from './meta-rates';

/**
 * Plantillas de WhatsApp por la Cloud API de Meta, sin intermediarios.
 *
 * Viven en la cuenta de WhatsApp Business (WABA) DE LA EMPRESA: BackOffice las
 * crea con el permiso que la empresa le dio al conectar su número, Meta las
 * revisa y avisa por webhook si las aprobó, rechazó, pausó o les cambió la
 * categoría. En BackOffice quedan en Company.waTemplatesJson junto a las de
 * Twilio; una plantilla de Meta solo tiene `contentSid` ("meta:<nombre>:<idioma>")
 * mientras está APROBADA, así todos los flujos que ya buscan "plantilla con
 * contentSid" (recordatorios, pedidos, campañas, cobros…) la usan sin cambios.
 */

export const META_TEMPLATE_PREFIX = 'meta:';
/** Español: Meta no tiene variante de Colombia (es_CO no existe en la API). */
export const META_TEMPLATE_LANGUAGE = 'es';

export type MetaTemplateStatus = 'BORRADOR' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED' | 'IN_APPEAL' | 'DELETED';

export interface MetaTemplateState {
  name: string;
  language: string;
  status: MetaTemplateStatus;
  id?: string;
  wabaId?: string;
  /** Lo que pidió la empresa al crearla */
  requestedCategory: 'UTILIDAD' | 'MARKETING';
  /** Si Meta la movió de categoría (ej. utilidad → marketing), de cuál venía */
  previousCategory?: MetaCategory;
  rejectedReason?: string;
  quality?: string;
  footer?: string;
  buttons?: string[];
  examples: string[];
  updatedAt: string;
}

/** Plantilla tal como se guarda en waTemplatesJson. */
export interface StoredTemplate {
  key: string;
  name?: string;
  category?: string;
  body?: string;
  contentSid?: string;
  meta?: MetaTemplateState;
  [k: string]: unknown;
}

export interface TemplateDraft {
  key: string;
  label?: string;
  category: 'UTILIDAD' | 'MARKETING';
  body: string;
  examples: string[];
  footer?: string;
  buttons?: string[];
}

export const metaTemplateRef = (name: string, language = META_TEMPLATE_LANGUAGE) => `${META_TEMPLATE_PREFIX}${name}:${language}`;

export function parseMetaTemplateRef(ref: unknown): { name: string; language: string } | null {
  const v = String(ref ?? '');
  if (!v.startsWith(META_TEMPLATE_PREFIX)) return null;
  const [name, language] = v.slice(META_TEMPLATE_PREFIX.length).split(':');
  return name ? { name, language: language || META_TEMPLATE_LANGUAGE } : null;
}

/** Variables {{1}}, {{2}}… en orden de aparición. */
export function bodyVariables(body: string): number[] {
  return [...String(body ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/** Nombre válido para Meta a partir de la clave (minúsculas, números y guion bajo). */
export function metaNameFor(key: string): string {
  return String(key ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/**
 * Lo mismo que revisa Meta antes de aceptar una plantilla, para que el error
 * se vea en BackOffice y no tres horas después en un rechazo.
 */
export function validateTemplateDraft(d: Partial<TemplateDraft>): string[] {
  const errors: string[] = [];
  const key = metaNameFor(d.key ?? '');
  if (!key || key.length < 3) errors.push('Ponle un nombre de al menos 3 letras (solo minúsculas, números y guion bajo).');
  if (d.category !== 'UTILIDAD' && d.category !== 'MARKETING') errors.push('Elige la categoría: aviso (utilidad) o promoción (marketing).');
  const body = String(d.body ?? '').trim();
  if (body.length < 10) errors.push('El texto es muy corto.');
  if (body.length > 1024) errors.push(`El texto tiene ${body.length} caracteres; Meta acepta máximo 1.024.`);
  const vars = bodyVariables(body);
  const distinct = [...new Set(vars)].sort((a, b) => a - b);
  if (distinct.some((n, i) => n !== i + 1)) errors.push('Las variables deben ir en orden: {{1}}, {{2}}, {{3}}… sin saltarse números.');
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body) || /\{\{\s*\d+\s*\}\}[\s.!?]*$/.test(body)) {
    errors.push('Meta rechaza las plantillas que empiezan o terminan con una variable: agrega texto antes y después.');
  }
  if (/\{\{\s*\d+\s*\}\}\s*\{\{\s*\d+\s*\}\}/.test(body)) errors.push('Dos variables seguidas no se aceptan: sepáralas con texto.');
  const examples = (d.examples ?? []).map((e) => String(e ?? '').trim());
  if (examples.length < distinct.length || examples.slice(0, distinct.length).some((e) => !e)) {
    errors.push(`Meta pide un ejemplo para cada variable (${distinct.length}).`);
  }
  if (d.footer && String(d.footer).trim().length > 60) errors.push('El pie de página va en máximo 60 caracteres.');
  if (d.footer && /\{\{/.test(d.footer)) errors.push('El pie de página no puede llevar variables.');
  const buttons = (d.buttons ?? []).map((b) => String(b ?? '').trim()).filter(Boolean);
  if (buttons.length > 3) errors.push('Máximo 3 botones de respuesta.');
  if (buttons.some((b) => b.length > 25)) errors.push('Cada botón va en máximo 25 caracteres.');
  return errors;
}

/** Palabras que hacen que Meta cobre un "aviso" como marketing (advertencia, no bloquea). */
export function marketingSignals(body: string): string[] {
  const hits = String(body ?? '').toLowerCase().match(/\b(promo\w*|descuento\w*|oferta\w*|gratis|2x1|rebaja\w*|aprovecha\w*|novedad\w*|nuev[oa]s? productos?|compra ya|últimos días|black friday)\b/g);
  return [...new Set(hits ?? [])];
}

export function buildTemplateComponents(d: TemplateDraft): any[] {
  const examples = d.examples.map((e) => cleanParam(e));
  const n = new Set(bodyVariables(d.body)).size;
  const components: any[] = [
    { type: 'BODY', text: d.body.trim(), ...(n ? { example: { body_text: [examples.slice(0, n)] } } : {}) },
  ];
  if (d.footer?.trim()) components.push({ type: 'FOOTER', text: d.footer.trim() });
  const buttons = (d.buttons ?? []).map((b) => b.trim()).filter(Boolean).slice(0, 3);
  if (buttons.length) components.push({ type: 'BUTTONS', buttons: buttons.map((text) => ({ type: 'QUICK_REPLY', text })) });
  return components;
}

/** Meta no acepta parámetros vacíos, con saltos de línea ni con más de 4 espacios seguidos. */
export function cleanParam(v: unknown): string {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return s || '-';
}

/** Parámetros en orden a partir de { '1': 'Ana', '2': 'martes' }. */
export function orderedParams(vars: Record<string, unknown> | undefined): string[] {
  return Object.entries(vars ?? {})
    .filter(([k]) => /^\d+$/.test(k))
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, v]) => cleanParam(v));
}

/* ── Llamadas a la Graph API (fetch inyectable para pruebas) ── */

type Fetch = typeof fetch;

export class MetaApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: number) {
    super(message);
  }
}

export async function metaGraph(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, body: unknown, fetchImpl: Fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}/${path.replace(/^\//, '')}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new MetaApiError(`Sin respuesta de Meta: ${sanitizeError(err)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.error ?? {};
    const detail = e.error_user_msg || e.error_user_title || e.message || 'error';
    throw new MetaApiError(sanitizeError(`Meta respondió ${res.status}: ${detail}`), res.status, Number(e.code) || undefined);
  }
  return data;
}

export async function createMetaTemplate(
  input: { wabaId: string; token: string; draft: TemplateDraft; language?: string },
  fetchImpl: Fetch = fetch,
): Promise<{ id: string; status: MetaTemplateStatus; category: MetaCategory | null }> {
  const data = await metaGraph('POST', `${input.wabaId}/message_templates`, input.token, {
    name: metaNameFor(input.draft.key),
    language: input.language ?? META_TEMPLATE_LANGUAGE,
    category: META_API_CATEGORY[input.draft.category],
    components: buildTemplateComponents(input.draft),
  }, fetchImpl);
  return { id: String(data?.id ?? ''), status: normalizeStatus(data?.status) ?? 'PENDING', category: metaCategoryOf(data?.category) };
}

export interface RemoteTemplate {
  id: string;
  name: string;
  language: string;
  status: MetaTemplateStatus;
  category: MetaCategory | null;
  rejectedReason?: string;
  quality?: string;
  body?: string;
}

export async function listMetaTemplates(input: { wabaId: string; token: string }, fetchImpl: Fetch = fetch): Promise<RemoteTemplate[]> {
  const out: RemoteTemplate[] = [];
  let path: string | null = `${input.wabaId}/message_templates?fields=id,name,language,status,category,rejected_reason,quality_score,components&limit=100`;
  for (let page = 0; path && page < 10; page++) {
    const data: any = await metaGraph('GET', path, input.token, undefined, fetchImpl);
    for (const t of data?.data ?? []) {
      out.push({
        id: String(t.id),
        name: String(t.name),
        language: String(t.language ?? META_TEMPLATE_LANGUAGE),
        status: normalizeStatus(t.status) ?? 'PENDING',
        category: metaCategoryOf(t.category),
        rejectedReason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : undefined,
        quality: t.quality_score?.score ? String(t.quality_score.score) : undefined,
        body: (t.components ?? []).find((c: any) => c?.type === 'BODY')?.text,
      });
    }
    const next: string | undefined = data?.paging?.next;
    // La siguiente página viene como URL completa: se pide solo el camino (misma versión de la API)
    path = next ? next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
  }
  return out;
}

export async function deleteMetaTemplate(input: { wabaId: string; token: string; name: string }, fetchImpl: Fetch = fetch): Promise<void> {
  await metaGraph('DELETE', `${input.wabaId}/message_templates?name=${encodeURIComponent(input.name)}`, input.token, undefined, fetchImpl);
}

/** Envía una plantilla aprobada. Los errores salen clasificados (rechazo, credenciales, reintento, incierto). */
export async function sendMetaTemplate(
  input: { config: MetaLineConfig; to: string; name: string; language: string; params: string[] },
  fetchImpl: Fetch = fetch,
): Promise<{ id: string }> {
  if (!input.config.accessToken) throw new SendError('AUTH', 'La línea de Meta no tiene token');
  const body = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: input.to.replace(/[^\d]/g, ''),
    type: 'template',
    template: {
      name: input.name,
      language: { code: input.language },
      ...(input.params.length ? { components: [{ type: 'body', parameters: input.params.map((text) => ({ type: 'text', text })) }] } : {}),
    },
  };
  let res: Response;
  try {
    res = await fetchImpl(`${GRAPH}/${input.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SendError('UNCERTAIN', `Sin respuesta de Meta: ${sanitizeError(err)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw classifySendError({ status: res.status, code: data?.error?.code, message: `Meta respondió ${res.status}: ${data?.error?.message ?? 'error'}` });
  const id = data?.messages?.[0]?.id;
  if (!id) throw new SendError('UNCERTAIN', 'Meta respondió sin el identificador del mensaje');
  return { id: String(id) };
}

/* ── Estado local: sincronización y avisos de Meta ── */

export function normalizeStatus(raw: unknown): MetaTemplateStatus | null {
  const v = String(raw ?? '').toUpperCase();
  const known: MetaTemplateStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'DELETED'];
  if ((known as string[]).includes(v)) return v as MetaTemplateStatus;
  if (v === 'PENDING_DELETION') return 'DELETED';
  if (v === 'FLAGGED' || v === 'LIMIT_EXCEEDED') return 'PAUSED';
  return null;
}

/** Deja la plantilla coherente: contentSid solo si Meta la aprobó; la categoría, la que Meta decidió. */
export function withMetaState(t: StoredTemplate, meta: MetaTemplateState, metaCategory?: MetaCategory | null): StoredTemplate {
  const next: StoredTemplate = { ...t, meta };
  if (metaCategory && metaCategory !== 'SERVICIO') {
    if (t.category && t.category !== metaCategory && !meta.previousCategory) {
      next.meta = { ...meta, previousCategory: t.category as MetaCategory };
    }
    next.category = metaCategory;
  }
  if (meta.status === 'APPROVED') next.contentSid = metaTemplateRef(meta.name, meta.language);
  else delete next.contentSid;
  return next;
}

/** Aplica lo que devolvió Meta al listar: estados, categoría y rechazo. Las de Twilio no se tocan. */
export function mergeRemoteTemplates(stored: StoredTemplate[], remote: RemoteTemplate[], now = new Date()): { templates: StoredTemplate[]; changed: number } {
  let changed = 0;
  const templates = stored.map((t) => {
    if (!t.meta) return t;
    const r = remote.find((x) => x.name === t.meta!.name && x.language === t.meta!.language);
    if (!r) {
      if (t.meta.status === 'DELETED' || t.meta.status === 'BORRADOR') return t;
      changed++;
      return withMetaState(t, { ...t.meta, status: 'DELETED', updatedAt: now.toISOString() });
    }
    const meta: MetaTemplateState = {
      ...t.meta, id: r.id, status: r.status, rejectedReason: r.rejectedReason, quality: r.quality, updatedAt: now.toISOString(),
    };
    if (r.status !== t.meta.status || (r.category && r.category !== t.category) || r.rejectedReason !== t.meta.rejectedReason) changed++;
    return withMetaState(t, meta, r.category);
  });
  return { templates, changed };
}

/**
 * Avisos de Meta sobre plantillas (webhook de la WABA):
 *  - message_template_status_update: aprobada, rechazada, pausada, deshabilitada…
 *  - template_category_update: Meta le cambió la categoría (afecta el costo)
 *  - message_template_quality_update: calidad (verde/amarilla/roja)
 */
export function applyTemplateWebhook(stored: StoredTemplate[], field: string, value: any, now = new Date()): { templates: StoredTemplate[]; hit: StoredTemplate | null } {
  const id = String(value?.message_template_id ?? '');
  const name = String(value?.message_template_name ?? '');
  const language = String(value?.message_template_language ?? '');
  const idx = stored.findIndex((t) => t.meta && ((id && t.meta.id === id) || (t.meta.name === name && (!language || t.meta.language === language))));
  if (idx === -1) return { templates: stored, hit: null };
  const t = stored[idx];
  const base: MetaTemplateState = { ...t.meta!, id: t.meta!.id || id || undefined, updatedAt: now.toISOString() };
  let next: StoredTemplate;
  if (field === 'message_template_status_update') {
    const status = normalizeStatus(value?.event) ?? base.status;
    const reason = value?.reason && value.reason !== 'NONE' ? String(value.reason) : undefined;
    next = withMetaState(t, { ...base, status, rejectedReason: status === 'REJECTED' ? reason ?? base.rejectedReason : undefined });
  } else if (field === 'template_category_update') {
    next = withMetaState(t, base, metaCategoryOf(value?.new_category));
  } else if (field === 'message_template_quality_update') {
    next = withMetaState(t, { ...base, quality: value?.new_quality_score ? String(value.new_quality_score) : base.quality });
  } else {
    return { templates: stored, hit: null };
  }
  const templates = [...stored];
  templates[idx] = next;
  return { templates, hit: next };
}

export const TEMPLATE_STATUS_LABEL: Record<MetaTemplateStatus, string> = {
  BORRADOR: 'Borrador',
  PENDING: 'En revisión de Meta',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  PAUSED: 'Pausada por Meta',
  DISABLED: 'Deshabilitada por Meta',
  IN_APPEAL: 'En apelación',
  DELETED: 'Eliminada',
};

/** Por qué Meta rechaza (código → explicación en español). */
export function rejectionText(reason?: string): string | undefined {
  if (!reason) return undefined;
  const map: Record<string, string> = {
    INVALID_FORMAT: 'El formato no es válido (revisa las variables y los ejemplos).',
    ABUSIVE_CONTENT: 'Meta consideró el contenido inapropiado.',
    INCORRECT_CATEGORY: 'La categoría no corresponde al contenido.',
    PROMOTIONAL: 'Tiene contenido promocional: debe ir como marketing.',
    TAG_CONTENT_MISMATCH: 'El contenido no coincide con la categoría elegida.',
    SCAM: 'Meta la marcó como posible engaño.',
  };
  return map[reason] ?? `Meta la rechazó (${reason}).`;
}
