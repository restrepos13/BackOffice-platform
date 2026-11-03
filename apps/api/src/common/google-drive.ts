/**
 * Cliente mínimo de Google Drive API v3 (REST + fetch) para la Biblioteca:
 * listar carpetas, listar las imágenes y videos de una carpeta y descargar
 * un archivo. Solo lectura. Docs: https://developers.google.com/drive/api/reference/rest/v3
 */
import { GoogleApiError } from './google-calendar';

/** Solo lectura de los archivos de Drive (para ver la carpeta que el cliente elige). */
export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/userinfo.email'];

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

const esc = (id: string) => id.replace(/['\\]/g, '');

export interface DriveFile { id: string; name: string; mimeType: string; size: number | null; thumbnailLink: string | null; modifiedTime: string | null }

export async function driveEmail(token: string, fetchImpl: BinFetch = defaultFetch): Promise<string | null> {
  const r = await get(fetchImpl, token, 'https://www.googleapis.com/oauth2/v2/userinfo');
  return (await r.json())?.email ?? null;
}

/** Carpetas dentro de `parent` ('root' = Mi unidad). */
export async function listFolders(token: string, parent = 'root', fetchImpl: BinFetch = defaultFetch) {
  const q = `'${esc(parent)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const r = await get(fetchImpl, token, `${API}/files?${new URLSearchParams({ q, fields: 'files(id,name)', orderBy: 'name', pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`);
  return ((await r.json())?.files ?? []).map((f: any) => ({ id: String(f.id), name: String(f.name) })) as Array<{ id: string; name: string }>;
}

/** Imágenes y videos de una carpeta (sin subcarpetas). */
export async function listMedia(token: string, folderId: string, fetchImpl: BinFetch = defaultFetch): Promise<DriveFile[]> {
  const types = DRIVE_MEDIA.map((m) => `mimeType = '${m}'`).join(' or ');
  const q = `'${esc(folderId)}' in parents and (${types}) and trashed = false`;
  const r = await get(fetchImpl, token, `${API}/files?${new URLSearchParams({ q, fields: 'files(id,name,mimeType,size,thumbnailLink,modifiedTime)', orderBy: 'modifiedTime desc', pageSize: '200', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`);
  return ((await r.json())?.files ?? []).map((f: any) => ({
    id: String(f.id), name: String(f.name), mimeType: String(f.mimeType), size: f.size ? Number(f.size) : null, thumbnailLink: f.thumbnailLink ?? null, modifiedTime: f.modifiedTime ?? null,
  }));
}

/** Metadatos de un archivo (para comprobar que está en la carpeta elegida). */
export async function fileMeta(token: string, fileId: string, fetchImpl: BinFetch = defaultFetch) {
  const r = await get(fetchImpl, token, `${API}/files/${encodeURIComponent(fileId)}?${new URLSearchParams({ fields: 'id,name,mimeType,size,parents', supportsAllDrives: 'true' })}`);
  const f = await r.json();
  return { id: String(f.id), name: String(f.name), mimeType: String(f.mimeType), size: f.size ? Number(f.size) : null, parents: (f.parents ?? []) as string[] };
}

export async function download(token: string, fileId: string, maxBytes: number, fetchImpl: BinFetch = defaultFetch): Promise<Buffer> {
  const r = await get(fetchImpl, token, `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new GoogleApiError('BAD_REQUEST', 'El archivo pesa demasiado');
  return buf;
}
