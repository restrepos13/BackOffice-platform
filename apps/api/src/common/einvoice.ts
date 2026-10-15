import { decryptSecret, encryptSecret, isEncrypted } from './crypto';
import { parseJson } from './constants';

/**
 * Facturación electrónica (DIAN, Colombia) a través de un proveedor
 * autorizado. Proveedores:
 *  - ALEGRA: API v1 (Basic auth email:token). Crea el contacto y la factura con
 *    generateStamp (timbrado DIAN). Requiere la cuenta de Alegra de la empresa
 *    con su numeración DIAN habilitada.
 *  - SIMULADO: numera localmente (SIM-0001…) sin enviar nada a la DIAN — para
 *    demos y pruebas. Nunca usar como factura legal.
 * Config por empresa en Company.einvoiceConfigJson (token cifrado).
 */

export interface EinvoiceConfig {
  provider?: 'ALEGRA' | 'SIMULADO';
  email?: string;
  tokenEnc?: string;
  /** Impuesto al consumo / IVA por defecto (restaurantes: 8 % INC) */
  taxRate?: number;
  /** id del impuesto en Alegra (si se usa) */
  alegraTaxId?: number;
  /** id del producto genérico en Alegra para las líneas */
  alegraItemId?: number;
  nextSimNumber?: number;
}

export function serializeEinvoiceConfig(raw: string | null | undefined) {
  const cfg = parseJson<EinvoiceConfig>(raw, {});
  return {
    provider: cfg.provider ?? null,
    email: cfg.email ?? null,
    hasToken: !!cfg.tokenEnc,
    taxRate: cfg.taxRate ?? 0.08,
    alegraTaxId: cfg.alegraTaxId ?? null,
    alegraItemId: cfg.alegraItemId ?? null,
    ready: cfg.provider === 'SIMULADO' || (cfg.provider === 'ALEGRA' && !!cfg.email && !!cfg.tokenEnc),
  };
}

export function sealToken(value: string): string {
  try {
    return encryptSecret(value);
  } catch {
    return value;
  }
}

function readToken(value?: string): string | null {
  if (!value) return null;
  if (!isEncrypted(value)) return value;
  try {
    return decryptSecret(value);
  } catch {
    return null;
  }
}

export interface EinvoiceInput {
  orderCode: string;
  customer: { name: string; taxId?: string | null; email?: string | null; phone?: string | null };
  items: Array<{ name: string; quantity: number; unitPrice: number }>;
  deliveryFee?: number | null;
  discount?: number | null;
  date: Date;
}

export interface EinvoiceResult {
  ok: boolean;
  number?: string;
  providerId?: string;
  error?: string;
}

/** Totales con el impuesto incluido en el precio (como cobra un restaurante). */
export function einvoiceTotals(input: EinvoiceInput, taxRate: number) {
  const gross = input.items.reduce((s, i) => s + i.unitPrice * i.quantity, 0) + (input.deliveryFee ?? 0) - (input.discount ?? 0);
  const base = gross / (1 + taxRate);
  return { total: Math.round(gross), base: Math.round(base), tax: Math.round(gross - base) };
}

export async function issueEinvoice(
  rawConfig: string | null | undefined,
  input: EinvoiceInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ result: EinvoiceResult; nextConfig?: string }> {
  const cfg = parseJson<EinvoiceConfig>(rawConfig, {});
  if (!input.items.length) return { result: { ok: false, error: 'El pedido no tiene ítems' } };

  if (cfg.provider === 'SIMULADO') {
    const n = cfg.nextSimNumber ?? 1;
    return {
      result: { ok: true, number: `SIM-${String(n).padStart(4, '0')}`, providerId: `sim_${input.orderCode}_${n}` },
      nextConfig: JSON.stringify({ ...cfg, nextSimNumber: n + 1 }),
    };
  }
  if (cfg.provider !== 'ALEGRA') return { result: { ok: false, error: 'Facturación electrónica no configurada' } };
  const token = readToken(cfg.tokenEnc);
  if (!cfg.email || !token) return { result: { ok: false, error: 'Faltan el correo o el token de Alegra' } };

  const auth = `Basic ${Buffer.from(`${cfg.email}:${token}`).toString('base64')}`;
  const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };
  const base = 'https://api.alegra.com/api/v1';
  try {
    // 1) Contacto (consumidor final si no hay documento)
    const identification = input.customer.taxId?.replace(/[^\d]/g, '') || '222222222222';
    const contactRes = await fetchImpl(`${base}/contacts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: input.customer.name.slice(0, 100),
        identification,
        email: input.customer.email ?? undefined,
        phonePrimary: input.customer.phone ?? undefined,
        type: ['client'],
      }),
    });
    const contact: any = await contactRes.json().catch(() => ({}));
    if (!contactRes.ok || !contact?.id) {
      return { result: { ok: false, error: `Alegra (contacto): ${contact?.message ?? contactRes.status}` } };
    }
    // 2) Factura con timbrado DIAN
    const taxRate = cfg.taxRate ?? 0.08;
    const lines = [
      ...input.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Math.round(i.unitPrice / (1 + taxRate)) })),
      ...(input.deliveryFee ? [{ name: 'Domicilio', quantity: 1, price: Math.round(input.deliveryFee / (1 + taxRate)) }] : []),
    ].map((l) => ({
      ...(cfg.alegraItemId ? { id: cfg.alegraItemId } : {}),
      name: l.name.slice(0, 150),
      price: l.price,
      quantity: l.quantity,
      ...(cfg.alegraTaxId ? { tax: [{ id: cfg.alegraTaxId }] } : {}),
    }));
    const day = input.date.toISOString().slice(0, 10);
    const invoiceRes = await fetchImpl(`${base}/invoices`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        date: day, dueDate: day, client: contact.id, items: lines,
        paymentForm: 'CASH', paymentMethod: 'CASH',
        observations: `Pedido #${input.orderCode}`,
        stamp: { generateStamp: true },
      }),
    });
    const invoice: any = await invoiceRes.json().catch(() => ({}));
    if (!invoiceRes.ok || !invoice?.id) {
      return { result: { ok: false, error: `Alegra (factura): ${invoice?.message ?? invoiceRes.status}` } };
    }
    return {
      result: {
        ok: true,
        providerId: String(invoice.id),
        number: invoice.numberTemplate?.fullNumber ?? invoice.numberTemplate?.number ?? String(invoice.id),
      },
    };
  } catch (err: any) {
    return { result: { ok: false, error: `Alegra no respondió: ${err.message}` } };
  }
}
