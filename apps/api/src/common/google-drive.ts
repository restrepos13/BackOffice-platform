/**
 * Cliente mínimo de Google Drive API v3 (REST + fetch) para la Biblioteca:
 * leer los metadatos de un archivo y descargarlo. Solo lectura y solo de los
 * archivos que el cliente elige en el selector de Google (Picker).
 * Docs: https://developers.google.com/drive/api/reference/rest/v3
 */
import { GoogleApiError } from './google-calendar';

/**
 * drive.file: BackOffice solo ve los archivos que el cliente elige en el
 * selector de Google, no el resto de su Drive (no es un permiso restringido).
 */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/userinfo.email'];

const API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'];

export type BinFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer> }>;
const defaultFetch: BinFetch = (u, i) => fetch(u, i) as any;

async function get(fetchImpl: BinFetch, token: string, url: string) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err: any) {
    throw new GoogleApiError('NETWORK', `No hubo conexión con Google: ${err?.message ?? 'error de red'}`);
  }
  if (res.ok) return res;
  const body = await res.json().catch(() => null);
  const message = String(body?.error?.message ?? `Google respondió ${res.status}`).slice(0, 200);
  if (res.status === 401 || res.status === 403) throw new GoogleApiError('AUTH', message, res.status);
  if (res.status === 404) throw new GoogleApiError('NOT_FOUND', message, res.status);
  if (res.status === 429) throw new GoogleApiError('RATE', message, res.status);
  if (res.status >= 500) throw new GoogleApiError('SERVER', message, res.status);
  throw new GoogleApiError('BAD_REQUEST', message, res.status);
}

export async function driveEmail(token: string, fetchImpl: BinFetch = defaultFetch): Promise<string | null> {
  const r = await get(fetchImpl, token, 'https://www.googleapis.com/oauth2/v2/userinfo');
  return (await r.json())?.email ?? null;
}

/** Metadatos de un archivo (para validar tipo y tamaño antes de traerlo). */
export async function fileMeta(token: string, fileId: string, fetchImpl: BinFetch = defaultFetch) {
  const r = await get(fetchImpl, token, `${API}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: 'id,name,mimeType,size', supportsAllDrives: 'true' })}`);
  const f = await r.json();
  return { id: String(f.id), name: String(f.name), mimeType: String(f.mimeType), size: f.size ? Number(f.size) : null };
}

export async function download(token: string, fileId: string, maxBytes: number, fetchImpl: BinFetch = defaultFetch): Promise<Buffer> {
  const r = await get(fetchImpl, token, `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new GoogleApiError('BAD_REQUEST', 'El archivo pesa demasiado');
  return buf;
}
