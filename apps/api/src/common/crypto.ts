import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

/**
 * Cifrado de secretos por organización (credenciales de Twilio, etc.).
 * AES-256-GCM con llave maestra en MASTER_ENCRYPTION_KEY (.env, jamás en el
 * repo). Formato: enc:v1:<iv b64>:<tag b64>:<data b64>.
 * Los valores cifrados nunca salen por el API ni van a logs.
 */

const PREFIX = 'enc:v1:';

function masterKey(): Buffer {
  const raw = process.env.MASTER_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'MASTER_ENCRYPTION_KEY ausente o muy corta — define una de 64 hex en .env',
    );
  }
  // Normaliza cualquier formato de llave a 32 bytes
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decryptSecret(value: string): string {
  if (!isEncrypted(value)) {
    throw new Error('El valor no está cifrado con el formato esperado');
  }
  const [iv, tag, data] = value.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
