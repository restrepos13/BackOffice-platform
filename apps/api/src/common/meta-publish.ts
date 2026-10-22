/**
 * Publicación en la página de Facebook y el Instagram profesional de la empresa
 * (Graph API). La empresa conecta SU cuenta con Facebook Login (OAuth) o pegando
 * un token de página; el token se guarda cifrado y en modo prueba nada sale.
 *
 * Permisos que pide el login: pages_show_list, pages_read_engagement,
 * pages_manage_posts, instagram_basic, instagram_content_publish, business_management.
 * Instagram descarga la imagen/video desde una URL pública (por eso cada pieza
 * tiene un token público de medio). Límite de Meta: 100 publicaciones por día en IG.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const GRAPH = 'https://graph.facebook.com/v21.0';
export const META_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
  'instagram_basic', 'instagram_content_publish', 'business_management',
];

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;
const defaultFetch: FetchLike = (url, init) => fetch(url, init) as any;

export class MetaError extends Error {
  constructor(message: string, public readonly code?: number) {
    super(message);
  }
}

async function graph(fetchImpl: FetchLike, path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  const qs = new URLSearchParams(params).toString();
  const res = method === 'GET'
    ? await fetchImpl(`${GRAPH}${path}?${qs}`)
    : await fetchImpl(`${GRAPH}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    throw new MetaError(data?.error?.message ?? `Meta respondió ${res.status}`, data?.error?.code);
  }
  return data;
}

/* ── OAuth ── */

export function signState(payload: Record<string, unknown>, secret: string): string {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState<T = Record<string, any>>(state: string, secret: string, maxAgeMs = 15 * 60e3): T | null {
  const [body, sig] = String(state ?? '').split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.t || Date.now() - data.t > maxAgeMs) return null;
    return data as T;
  } catch {
    return null;
  }
}

export function oauthUrl(input: { appId: string; redirectUri: string; state: string; scopes?: string[] }): string {
  const qs = new URLSearchParams({
    client_id: input.appId, redirect_uri: input.redirectUri, state: input.state,
    scope: (input.scopes ?? META_SCOPES).join(','), response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${qs}`;
}

/** code → token de usuario de larga duración (60 días). */
export async function exchangeCode(input: { appId: string; appSecret: string; redirectUri: string; code: string }, fetchImpl = defaultFetch) {
  const short = await graph(fetchImpl, '/oauth/access_token', {
    client_id: input.appId, client_secret: input.appSecret, redirect_uri: input.redirectUri, code: input.code,
  });
  const long = await graph(fetchImpl, '/oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: input.appId, client_secret: input.appSecret, fb_exchange_token: short.access_token,
  });
  return String(long.access_token ?? short.access_token);
}

export interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  igUserId: string | null;
  igUsername: string | null;
}

/** Páginas que administra la persona (con su token de página, que no vence). */
export async function listPages(userToken: string, fetchImpl = defaultFetch): Promise<MetaPage[]> {
  const data = await graph(fetchImpl, '/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50', access_token: userToken,
  });
  return (data?.data ?? []).map((p: any) => ({
    id: String(p.id), name: String(p.name ?? ''), accessToken: String(p.access_token ?? ''),
    igUserId: p.instagram_business_account?.id ?? null, igUsername: p.instagram_business_account?.username ?? null,
  }));
}

/** Verifica un token de página pegado a mano. */
export async function inspectPage(pageId: string, pageToken: string, fetchImpl = defaultFetch) {
  const data = await graph(fetchImpl, `/${encodeURIComponent(pageId)}`, {
    fields: 'id,name,instagram_business_account{id,username}', access_token: pageToken,
  });
  return {
    id: String(data.id), name: String(data.name ?? ''),
    igUserId: data.instagram_business_account?.id ?? null, igUsername: data.instagram_business_account?.username ?? null,
  };
}

/* ── Publicación ── */

export type MediaKind = 'image' | 'video' | 'none';

export async function publishFacebook(
  input: { pageId: string; token: string; message: string; mediaUrl?: string | null; kind: MediaKind },
  fetchImpl = defaultFetch,
): Promise<{ id: string; url: string }> {
  const base = { access_token: input.token };
  let data: any;
  if (input.kind === 'image' && input.mediaUrl) {
    data = await graph(fetchImpl, `/${input.pageId}/photos`, { ...base, url: input.mediaUrl, caption: input.message }, 'POST');
  } else if (input.kind === 'video' && input.mediaUrl) {
    data = await graph(fetchImpl, `/${input.pageId}/videos`, { ...base, file_url: input.mediaUrl, description: input.message }, 'POST');
  } else {
    data = await graph(fetchImpl, `/${input.pageId}/feed`, { ...base, message: input.message }, 'POST');
  }
  const id = String(data.post_id ?? data.id);
  return { id, url: `https://www.facebook.com/${id}` };
}

/**
 * Instagram en dos pasos: contenedor → publicar. Las imágenes se publican de una;
 * los videos (reels) quedan "pending" hasta que Meta termine de procesarlos y el
 * cron vuelve a intentar con el mismo contenedor.
 */
export async function createInstagramContainer(
  input: { igUserId: string; token: string; caption: string; mediaUrl: string; kind: 'image' | 'video' },
  fetchImpl = defaultFetch,
): Promise<string> {
  const params: Record<string, string> = { access_token: input.token, caption: input.caption };
  if (input.kind === 'video') {
    params.media_type = 'REELS';
    params.video_url = input.mediaUrl;
  } else {
    params.image_url = input.mediaUrl;
  }
  const data = await graph(fetchImpl, `/${input.igUserId}/media`, params, 'POST');
  return String(data.id);
}

export async function containerStatus(containerId: string, token: string, fetchImpl = defaultFetch): Promise<string> {
  const data = await graph(fetchImpl, `/${containerId}`, { fields: 'status_code', access_token: token });
  return String(data.status_code ?? 'FINISHED');
}

export async function publishInstagramContainer(igUserId: string, containerId: string, token: string, fetchImpl = defaultFetch) {
  const data = await graph(fetchImpl, `/${igUserId}/media_publish`, { creation_id: containerId, access_token: token }, 'POST');
  return { id: String(data.id) };
}
