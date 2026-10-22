/**
 * Las tres líneas de producto de BackOffice y qué tiene activo cada empresa.
 *
 *  - AUTOMATION: CRM conversacional, asistentes IA, canales, ventas, pedidos,
 *    agenda, campañas por WhatsApp, complementos (reactivación, cobranza,
 *    auditor) y reportes de operación.
 *  - CREATIVE: identidad visual, diseños, editor, dirección de arte,
 *    contenido orgánico (marketing y redes) y sus créditos.
 *  - ADS: Ads Intelligence (cuentas publicitarias, métricas, Autopilot,
 *    Campaign Studio, atribución).
 *
 * Estado en Company.productsJson: { [key]: { enabled, since?, until?, requestedAt?, requestedBy? } }.
 *
 * Compatibilidad: las empresas que no tienen productsJson (todas las anteriores
 * a esta separación) siguen exactamente como estaban: Automation siempre, y
 * Creative + Ads con cualquier plan (así era antes). Cuando plataforma guarda
 * los productos de una empresa, desde ese momento manda lo guardado.
 *
 * Esto NO define precios ni cobra nada: la facturación sigue con plan +
 * complementos. Cobrar por producto es una decisión comercial pendiente.
 */

export const PRODUCTS = ['AUTOMATION', 'CREATIVE', 'ADS'] as const;
export type ProductKey = (typeof PRODUCTS)[number];

export const PRODUCT_INFO: Record<ProductKey, { name: string; short: string; home: string; summary: string }> = {
  AUTOMATION: {
    name: 'BackOffice Automation',
    short: 'Automation',
    home: '/app',
    summary: 'Atención, ventas y operación con IA: conversaciones, asistentes, pedidos, agenda, campañas y seguimientos.',
  },
  CREATIVE: {
    name: 'BackOffice Creative',
    short: 'Creative',
    home: '/app/creative',
    summary: 'Identidad visual, diseños editables por capas, dirección de arte, adaptación de formatos y contenido orgánico.',
  },
  ADS: {
    name: 'BackOffice Ads Intelligence',
    short: 'Ads Intelligence',
    home: '/app/ads',
    summary: 'Tus cuentas publicitarias en un solo lugar: métricas, oportunidades, reglas con aprobación y campañas.',
  },
};

export interface ProductState {
  enabled: boolean;
  since?: string | null;
  until?: string | null;
  requestedAt?: string | null;
  requestedBy?: string | null;
}

type CompanyLike = { productsJson?: string | null; planId?: string | null };

export function isProductKey(v: unknown): v is ProductKey {
  return typeof v === 'string' && (PRODUCTS as readonly string[]).includes(v);
}

function parse(raw: string | null | undefined): Record<string, any> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** ¿La empresa tiene su elección de productos guardada (o sigue con la regla anterior)? */
export function productsExplicit(company: CompanyLike): boolean {
  const raw = parse(company?.productsJson);
  return !!raw && PRODUCTS.some((k) => raw[k] && typeof raw[k] === 'object' && 'enabled' in raw[k]);
}

/** Estado de los tres productos de la empresa. */
export function readProducts(company: CompanyLike): Record<ProductKey, ProductState> {
  const raw = parse(company?.productsJson) ?? {};
  const explicit = productsExplicit(company);
  const out = {} as Record<ProductKey, ProductState>;
  for (const key of PRODUCTS) {
    const saved = raw[key] && typeof raw[key] === 'object' ? raw[key] : {};
    const enabled = explicit ? saved.enabled === true : key === 'AUTOMATION' || !!company?.planId;
    out[key] = {
      enabled,
      since: saved.since ?? null,
      until: saved.until ?? null,
      requestedAt: saved.requestedAt ?? null,
      requestedBy: saved.requestedBy ?? null,
    };
  }
  return out;
}

export function activeProducts(company: CompanyLike): ProductKey[] {
  const states = readProducts(company);
  return PRODUCTS.filter((k) => states[k].enabled);
}

export function hasProduct(company: CompanyLike, key: ProductKey): boolean {
  return readProducts(company)[key].enabled;
}

export function hasAnyProduct(company: CompanyLike, keys: readonly ProductKey[]): boolean {
  const states = readProducts(company);
  return keys.some((k) => states[k].enabled);
}

/**
 * Nueva elección de productos (plataforma). Conserva las fechas: `since` al
 * encender, `until` al apagar; apagar no borra datos de la empresa.
 */
export function withProducts(company: CompanyLike, next: Partial<Record<ProductKey, boolean>>, now = new Date()): string {
  const current = readProducts(company);
  const out: Record<string, ProductState> = {};
  for (const key of PRODUCTS) {
    const was = current[key];
    const enabled = typeof next[key] === 'boolean' ? (next[key] as boolean) : was.enabled;
    const changed = enabled !== was.enabled || !productsExplicit(company);
    out[key] = {
      enabled,
      since: enabled ? (changed && !was.enabled ? now.toISOString() : was.since ?? null) : was.since ?? null,
      until: enabled ? null : changed && was.enabled ? now.toISOString() : was.until ?? null,
      // Encenderlo atiende la solicitud
      requestedAt: enabled ? null : was.requestedAt ?? null,
      requestedBy: enabled ? null : was.requestedBy ?? null,
    };
  }
  return JSON.stringify(out);
}

/** Registra que la empresa pidió activar un producto (lo activa el equipo). */
export function withProductRequest(company: CompanyLike, key: ProductKey, by: string, now = new Date()): string {
  const request = { requestedAt: now.toISOString(), requestedBy: by };
  if (productsExplicit(company)) {
    const current = readProducts(company);
    return JSON.stringify({ ...current, [key]: { ...current[key], ...request } });
  }
  // Con la regla anterior, la solicitud se guarda SIN "enabled": la empresa sigue
  // con la regla (si después elige plan, Creative y Ads se le activan igual que antes)
  const raw = parse(company?.productsJson) ?? {};
  return JSON.stringify({ ...raw, [key]: request });
}

export class ProductInactiveError {
  static body(keys: readonly ProductKey[], company?: CompanyLike | null) {
    const names = keys.map((k) => PRODUCT_INFO[k].name);
    // Regla anterior sin plan: lo que falta es elegir un plan (así lo veía antes la empresa)
    const needsPlan = !!company && !productsExplicit(company) && !company.planId;
    return {
      statusCode: 403,
      code: 'PRODUCT_INACTIVE',
      products: keys,
      needsPlan,
      message: needsPlan
        ? `${names.join(' y ')} viene con tu plan: elige uno en Mi plan.`
        : `Esta función es parte de ${names.join(' o ')}, que tu empresa no tiene activo. Puedes pedir que lo activen desde el menú.`,
    };
  }
}
