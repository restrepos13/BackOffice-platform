import { createHash, timingSafeEqual } from 'crypto';

/**
 * Wompi (Colombia) — utilidades puras: Web Checkout con firma de integridad y
 * verificación de la firma de los eventos. Las usan los pagos a BackOffice
 * (mensualidad, paquetes de IA) y los cobros de pedidos con la cuenta PROPIA
 * de cada empresa.
 */

export function integritySignature(reference: string, amountInCents: number, currency: string, secret: string): string {
  return createHash('sha256').update(`${reference}${amountInCents}${currency}${secret}`).digest('hex');
}

export function buildCheckoutUrl(input: {
  publicKey: string;
  reference: string;
  amountInCents: number;
  currency?: string;
  integritySecret?: string | null;
  redirectUrl?: string | null;
}): string {
  const currency = input.currency ?? 'COP';
  const params = new URLSearchParams({
    'public-key': input.publicKey,
    currency,
    'amount-in-cents': String(input.amountInCents),
    reference: input.reference,
  });
  if (input.redirectUrl) params.set('redirect-url', input.redirectUrl);
  if (input.integritySecret) {
    params.set('signature:integrity', integritySignature(input.reference, input.amountInCents, currency, input.integritySecret));
  }
  return `https://checkout.wompi.co/p/?${params.toString()}`;
}

/** checksum = SHA256(valores de signature.properties + timestamp + events secret) */
export function verifyEventSignature(body: any, eventsSecret: string): boolean {
  const props: string[] = body?.signature?.properties ?? [];
  if (!props.length || !body?.signature?.checksum) return false;
  const concat = props
    .map((prop: string) => prop.split('.').reduce((acc: any, key: string) => acc?.[key], body.data))
    .join('');
  const expected = createHash('sha256').update(`${concat}${body.timestamp}${eventsSecret}`).digest('hex');
  const got = String(body.signature.checksum);
  // Comparación en tiempo constante
  return got.length === expected.length && timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

/** Firma un evento (para tests y para el simulador de Dev Tools). */
export function signEvent(data: any, timestamp: number, eventsSecret: string, properties: string[]) {
  const concat = properties
    .map((prop) => prop.split('.').reduce((acc: any, key: string) => acc?.[key], data))
    .join('');
  return {
    properties,
    checksum: createHash('sha256').update(`${concat}${timestamp}${eventsSecret}`).digest('hex'),
  };
}
