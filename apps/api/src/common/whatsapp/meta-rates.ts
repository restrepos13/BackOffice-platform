import { parseJson } from '../constants';

/**
 * Lo que Meta cobra por WhatsApp (Cloud API, sin intermediarios) y cómo se le
 * explica al cliente. Meta le cobra DIRECTO a la empresa, a la tarjeta que
 * registra en su cuenta de WhatsApp Business: BackOffice no intermedia ese pago
 * ni le pone recargo.
 *
 * Tarifas de referencia para Colombia (USD por mensaje entregado). Son
 * estimaciones: la cifra exacta la muestra Meta en la factura de la empresa.
 * Se pueden ajustar por empresa en orderConfigJson.metaRatesUsd.
 */
export const META_RATES_USD: Record<MetaCategory, number> = {
  SERVICIO: 0,
  UTILIDAD: 0.001,
  AUTENTICACION: 0.001,
  MARKETING: 0.015,
};

export type MetaCategory = 'SERVICIO' | 'UTILIDAD' | 'AUTENTICACION' | 'MARKETING';

/** Tarifas de la empresa (las suyas, si las configuró; si no, las de referencia). */
export function metaRatesFor(company: { orderConfigJson?: string | null } | null | undefined): Record<MetaCategory, number> {
  const custom = parseJson<Record<string, any>>(company?.orderConfigJson, {}).metaRatesUsd ?? {};
  const out = { ...META_RATES_USD };
  for (const k of Object.keys(out) as MetaCategory[]) {
    const v = Number(custom[k]);
    if (Number.isFinite(v) && v >= 0 && v < 1) out[k] = v;
  }
  return out;
}

/** Categoría de Meta (inglés, minúsculas o mayúsculas) → la nuestra. */
export function metaCategoryOf(raw: unknown): MetaCategory | null {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'marketing' || v === 'marketing_lite') return 'MARKETING';
  if (v === 'utility') return 'UTILIDAD';
  if (v.startsWith('authentication')) return 'AUTENTICACION';
  if (v === 'service' || v === 'referral_conversion') return 'SERVICIO';
  return null;
}

/** Nuestra categoría → la de la API de plantillas de Meta. */
export const META_API_CATEGORY: Record<'UTILIDAD' | 'MARKETING', 'UTILITY' | 'MARKETING'> = {
  UTILIDAD: 'UTILITY',
  MARKETING: 'MARKETING',
};

/**
 * Costo de un mensaje según el aviso de Meta (statuses[].pricing). Si Meta
 * dice que no es cobrable (respuesta dentro de las 24 h, entrada por anuncio),
 * cuesta 0 aunque la categoría tenga tarifa.
 */
export function costFromPricing(pricing: any, rates: Record<MetaCategory, number>): { category: MetaCategory; costUsd: number } | null {
  if (!pricing || typeof pricing !== 'object') return null;
  const category = metaCategoryOf(pricing.category) ?? 'SERVICIO';
  const free = pricing.billable === false || /^free/i.test(String(pricing.type ?? ''));
  return { category, costUsd: free ? 0 : rates[category] ?? 0 };
}

/**
 * Lo que se le dice al cliente, igual en todas las pantallas (conexión,
 * plantillas, campañas, consumo). Sin letra pequeña.
 */
export const META_BILLING_NOTICE = {
  title: 'Lo que Meta te cobra directo',
  summary:
    'Las conversaciones que inician tus clientes (cuando te escriben y les respondes dentro de las 24 horas) no tienen costo en Meta. Lo que sí cobra Meta son los mensajes que tú envías primero, con plantilla aprobada. Ese cobro llega a la tarjeta que registras en tu cuenta de WhatsApp Business, no a BackOffice, y nosotros no le ponemos ningún recargo.',
  items: [
    { category: 'SERVICIO', label: 'Respuestas a tus clientes (dentro de 24 h)', detail: 'Sin costo en Meta.' },
    { category: 'UTILIDAD', label: 'Avisos y recordatorios', detail: 'Citas, pedidos, pagos, cambios de estado. Muy baratos.' },
    { category: 'MARKETING', label: 'Promociones, campañas y reactivación', detail: 'Lo más costoso. Lo pagas a Meta aparte del plan.' },
  ],
  why:
    'Para que Meta nos cobrara a nosotros, tu número tendría que quedar dentro de la cuenta de WhatsApp de BackOffice: seríamos los dueños de tu línea, de tus conversaciones y de tu verificación ante Meta, y si algún día te vas, no podrías llevártela. No queremos tener ese control sobre tu negocio. Por eso el número queda a tu nombre, en tu propia cuenta, y Meta te cobra a ti directamente. BackOffice solo tiene el permiso que tú le das, y lo puedes quitar cuando quieras.',
  caveats: [
    'Las tarifas son las de referencia de Meta para Colombia y pueden cambiar; la cifra exacta aparece en tu factura de Meta (en dólares, con los impuestos y la comisión que aplique tu banco).',
    'Meta decide la categoría de cada plantilla. Si un aviso trae algo promocional, Meta lo cobra como marketing.',
    'Para enviar los mensajes que inicias tú, Meta te pide registrar un medio de pago en tu cuenta de WhatsApp Business.',
  ],
} as const;
