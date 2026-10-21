import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * TOTP (RFC 6238, el de Google Authenticator / Microsoft Authenticator / 1Password):
 * HMAC-SHA1, 6 dígitos, pasos de 30 s, tolerancia de ±1 paso. Sin dependencias.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secreto nuevo de 160 bits (lo recomendado para SHA1). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const currentStep = (now = Date.now()) => Math.floor(now / 30_000);

/**
 * Verifica un código. Devuelve el paso usado (para no aceptar el mismo código dos
 * veces) o null. `lastStep` = último paso ya usado por este usuario.
 */
export function verifyTotp(secret: string, code: string, lastStep: number | null | undefined, now = Date.now()): number | null {
  const digits = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (lastStep != null && s <= lastStep) continue; // anti-repetición
    const expected = Buffer.from(totpAt(secret, s));
    if (timingSafeEqual(expected, Buffer.from(digits))) return s;
  }
  return null;
}

/** Enlace que leen las apps de autenticación (también como QR). */
export function otpauthUri(secret: string, account: string, issuer = 'BackOffice'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** 8 códigos de recuperación legibles (xxxx-xxxx). */
export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
