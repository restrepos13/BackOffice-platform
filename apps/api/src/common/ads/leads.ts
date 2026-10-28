import { deterministicId } from '../automation/run-signals';

/**
 * Meta Lead Ads (formularios instantáneos). Meta avisa por webhook (objeto
 * "page", campo "leadgen") con los identificadores; los datos que escribió la
 * persona se piden aparte a Graph con un token de la página que tenga
 * `leads_retrieval`. Sin ese permiso el lead queda registrado con sus IDs
 * (sirven para la atribución) y en espera de permiso: no se inventan datos.
 */

export interface LeadgenEvent {
  pageId: string;
  leadgenId: string;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  createdTime: Date | null;
}

const id = (v: unknown) => (v === undefined || v === null || v === '' ? null : /^\d{1,30}$/.test(String(v)) ? String(v) : null);

/** Eventos de formularios dentro de un webhook de Meta (ignora todo lo demás). */
export function parseLeadgenEvents(body: any): LeadgenEvent[] {
  if (body?.object !== 'page') return [];
  const out: LeadgenEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'leadgen') continue;
      const v = change?.value ?? {};
      const leadgenId = id(v.leadgen_id);
      const pageId = id(v.page_id ?? entry?.id);
      if (!leadgenId || !pageId) continue;
      const t = Number(v.created_time);
      out.push({
        pageId, leadgenId, formId: id(v.form_id), adId: id(v.ad_id), adsetId: id(v.adgroup_id),
        createdTime: Number.isFinite(t) && t > 0 ? new Date(t * 1000) : null,
      });
    }
  }
  return out;
}

/** _id del lead: el mismo leadgen_id siempre cae en la misma fila (reintentos de Meta). */
export const leadDocId = (leadgenId: string) => deterministicId('adlead', leadgenId);

/**
 * Datos de contacto de la respuesta de Graph (field_data). Solo se toman
 * nombre, correo y teléfono; del resto se guardan los nombres de los campos.
 */
export function contactFromFields(fieldData: unknown): { name: string | null; email: string | null; phone: string | null; fieldNames: string[] } {
  const list = Array.isArray(fieldData) ? fieldData : [];
  const get = (...names: string[]) => {
    for (const f of list) {
      if (names.includes(String(f?.name ?? '').toLowerCase())) {
        const v = Array.isArray(f?.values) ? String(f.values[0] ?? '').trim() : '';
        if (v) return v.slice(0, 160);
      }
    }
    return null;
  };
  const first = get('first_name');
  const last = get('last_name');
  const name = get('full_name', 'name', 'nombre', 'nombre_completo') ?? ([first, last].filter(Boolean).join(' ') || null);
  const email = get('email', 'correo', 'correo_electronico');
  const rawPhone = get('phone_number', 'phone', 'telefono', 'celular', 'whatsapp');
  const digits = rawPhone?.replace(/[^\d+]/g, '') ?? '';
  const bare = digits.replace(/\D/g, '');
  return {
    name,
    email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email.toLowerCase() : null,
    // Meta suele mandar el número con indicativo (+57…). Sin "+" no se adivina el país:
    // con 11 dígitos o más se asume que ya lo trae; con menos, se guarda tal cual
    phone: bare.length < 7 ? null : digits.startsWith('+') ? `+${bare}` : bare.length >= 11 ? `+${bare}` : bare,
    fieldNames: list.map((f: any) => String(f?.name ?? '')).filter(Boolean).slice(0, 30),
  };
}
