import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, Delete, ExecutionContext, ForbiddenException, Get, HttpException, HttpStatus,
  Injectable, Logger, Module, NotFoundException, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { AdsProviderError } from '../common/ads/provider';
import { addDays } from '../common/ads/provider';
import { todayIn } from '../common/ads/launch';
import { GraphCallLog, GraphFetch, MetaGraphClient, MetaGraphError, authState, metaGraphVersion, redact, redactBody } from '../common/meta/graph-client';
import { debugToken, dialogUrl, exchangeCodeForToken } from '../common/meta/oauth';
import { ACCOUNT_FIELDS, ACT_ID, AD_FIELDS, ADSET_FIELDS, CAMPAIGN_FIELDS, INSIGHT_FIELDS, MetaAdsReader, MetaInsight, MetaObject, ObjectLevel } from '../common/meta/ads-reader';
import { AuditModule, AuditService } from './audit.module';

/**
 * Meta Ads · integración INTERNA de desarrollo.
 *
 * Solo para el equipo de BackOffice, en localhost, con la app de Meta en modo
 * Development y nuestra cuenta publicitaria de pruebas. No es una función para
 * clientes: no aparece en ningún panel de empresa, no tiene companyId y sus
 * datos viven en colecciones propias (MetaDev*) que nada comercial lee.
 *
 * Acceso (todo en backend, no en React):
 *  - META_DEV_ENABLED=1, y nunca con NODE_ENV=production ni en Render/Vercel.
 *  - Usuario autenticado con rol DEV (ni SUPER_ADMIN ni roles de empresa).
 *  - Si algo de eso falla, responde 404: desde afuera no se sabe que existe.
 *
 * Solo lectura: no pausa, no activa, no crea nada ni toca presupuestos. La
 * única llamada que no es GET es revocar el permiso de la app al desconectar.
 */

export const META_DEV_CONNECTION_ID = 'internal-dev';
export const META_DEV_COOKIE = 'bo_meta_dev_state';
export const META_DEV_CALLBACK_PATH = '/api/dev/meta-ads/callback';
export const META_DEV_LABEL = 'Datos internos de desarrollo · cuenta de pruebas del equipo';
const STATE_TTL_MS = 10 * 60e3;
const SYNC_LOCK_MS = 5 * 60e3;
const ALLOWED_SCOPES = ['ads_read', 'ads_management', 'business_management'];
/** Fase de solo lectura: ads_management no hace falta */
const DEFAULT_SCOPES = ['ads_read', 'business_management'];
const MAX_CALLS_KEPT = 200;
const LEVEL_LABEL: Record<string, string> = { ACCOUNT: 'Cuentas', CAMPAIGN: 'Campañas', ADSET: 'Conjuntos de anuncios', AD: 'Anuncios' };

export function metaDevEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.META_DEV_ENABLED === '1' && env.NODE_ENV !== 'production' && !env.RENDER && !env.VERCEL;
}

/** La URI de redirección es fija y local: se valida exacta, sin parámetros extra. */
export function validateRedirectUri(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('META_DEV_REDIRECT_URI no es una URL válida');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('META_DEV_REDIRECT_URI debe ser http o https');
  if (!['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('META_DEV_REDIRECT_URI debe apuntar a localhost en esta fase');
  if (u.pathname !== META_DEV_CALLBACK_PATH || u.search || u.hash || u.username || u.password) {
    throw new Error(`META_DEV_REDIRECT_URI debe terminar exactamente en ${META_DEV_CALLBACK_PATH}`);
  }
  return `${u.origin}${u.pathname}`;
}

export function devScopes(raw?: string) {
  const valid = String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => ALLOWED_SCOPES.includes(s));
  return valid.length ? [...new Set(valid)] : DEFAULT_SCOPES;
}

export function devConfig(env: NodeJS.ProcessEnv = process.env) {
  const appId = String(env.META_DEV_APP_ID ?? '').trim();
  const appSecret = String(env.META_DEV_APP_SECRET ?? '').trim();
  let redirectUri: string | null = null;
  let redirectError: string | null = null;
  try {
    redirectUri = validateRedirectUri(String(env.META_DEV_REDIRECT_URI ?? '').trim() || `http://localhost:5173${META_DEV_CALLBACK_PATH}`);
  } catch (e: any) {
    redirectError = e.message;
  }
  const missing = [
    !/^\d{5,25}$/.test(appId) ? 'META_DEV_APP_ID' : null,
    !appSecret ? 'META_DEV_APP_SECRET' : null,
    redirectError,
  ].filter((x): x is string => !!x);
  return {
    appId, appSecret, redirectUri, redirectError, missing,
    scopes: devScopes(env.META_DEV_SCOPES),
    version: metaGraphVersion(),
    defaultDays: [30, 60].includes(Number(env.META_DEV_SYNC_DAYS)) ? Number(env.META_DEV_SYNC_DAYS) : 30,
    webBase: redirectUri ? new URL(redirectUri).origin : 'http://localhost:5173',
  };
}

const sha = (...parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex');
const dayMs = 86400e3;

function cookieValue(req: Request, name: string): string | null {
  for (const part of String(req.headers?.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

type Counts = { created: number; updated: number; unchanged: number; total: number };

/** Respuesta HTTP para un error de Meta (sin 401: el panel lo tomaría como sesión vencida). */
function httpFrom(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof AdsProviderError) {
    const auth = authState(err);
    const body = { message: err.message, code: auth ? `AUTH_${auth}` : err.kind, metaCode: err.providerCode ?? null, metaSubcode: (err as MetaGraphError).subcode ?? null };
    const status = auth ? HttpStatus.CONFLICT
      : err.kind === 'RATE_LIMIT' ? HttpStatus.TOO_MANY_REQUESTS
      : err.kind === 'PERMISSION' ? HttpStatus.FORBIDDEN
      : err.kind === 'NOT_FOUND' ? HttpStatus.NOT_FOUND
      : HttpStatus.BAD_GATEWAY;
    return new HttpException(body, status);
  }
  return new BadRequestException(redact(String((err as any)?.message ?? err)).slice(0, 300));
}

@Injectable()
export class MetaDevGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    // 404 y no 403: para quien no es del equipo, esta ruta no existe
    if (!metaDevEnabled() || user?.role !== ROLES.DEV) throw new NotFoundException();
    return true;
  }
}

@Injectable()
export class MetaDevService {
  private readonly logger = new Logger('MetaDev');
  /** Reemplazables en pruebas */
  fetchImpl: GraphFetch = (u, i) => fetch(u, i) as any;
  now: () => Date = () => new Date();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  config() {
    return devConfig();
  }

  private connection() {
    return this.prisma.metaDevConnection.findUnique({ where: { id: META_DEV_CONNECTION_ID } });
  }

  private client(token: string, calls?: GraphCallLog[]) {
    const cfg = this.config();
    return new MetaGraphClient({
      token, appSecret: cfg.appSecret || undefined, fetchImpl: this.fetchImpl, sleep: this.sleep,
      onCall: (l) => { if (calls && calls.length < MAX_CALLS_KEPT) calls.push(l); },
    });
  }

  private requireConfig() {
    const cfg = this.config();
    if (cfg.missing.length) throw new BadRequestException({ message: `Falta configurar en apps/api/.env: ${cfg.missing.join(', ')}`, code: 'NOT_CONFIGURED' });
    return cfg as typeof cfg & { redirectUri: string };
  }

  /** Token descifrado de la conexión, comprobando que siga vigente. */
  private async token(): Promise<{ conn: any; token: string }> {
    const conn = await this.connection();
    if (!conn?.tokenEnc || conn.status === 'DISCONNECTED') throw new BadRequestException({ message: 'Meta no está conectado', code: 'NOT_CONNECTED' });
    if (conn.status === 'EXPIRED' || conn.status === 'REVOKED') {
      throw new ConflictException({ message: conn.status === 'REVOKED' ? 'La autorización fue revocada en Meta. Conecta de nuevo.' : 'El token de Meta venció. Conecta de nuevo.', code: `AUTH_${conn.status}` });
    }
    if (conn.tokenExpiresAt && new Date(conn.tokenExpiresAt).getTime() <= this.now().getTime()) {
      await this.markAuth(conn, 'EXPIRED', 'El token llegó a su fecha de vencimiento');
      throw new ConflictException({ message: 'El token de Meta venció. Meta no permite renovarlo: hay que autorizar de nuevo.', code: 'AUTH_EXPIRED' });
    }
    try {
      return { conn, token: decryptSecret(conn.tokenEnc) };
    } catch {
      throw new ConflictException({ message: 'No se pudo descifrar el token guardado (¿cambió MASTER_ENCRYPTION_KEY?). Conecta de nuevo.', code: 'TOKEN_UNREADABLE' });
    }
  }

  private async markAuth(conn: any, status: 'EXPIRED' | 'REVOKED', detail: string) {
    await this.prisma.metaDevConnection.update({ where: { id: conn.id }, data: { status, lastError: detail, lastErrorKind: 'AUTH', updatedAt: this.now() } });
    await this.audit.log({ actor: null, action: 'meta_dev.auth_lost', entity: 'MetaDevConnection', entityId: conn.id, detail: `${status}: ${detail}` });
  }

  /** Ejecuta una lectura en vivo; si Meta dice que el token no sirve, la conexión queda vencida o revocada. */
  private async live<T>(fn: (reader: MetaAdsReader, client: MetaGraphClient) => Promise<T>, calls?: GraphCallLog[]): Promise<T> {
    const { conn, token } = await this.token();
    const client = this.client(token, calls);
    try {
      return await fn(new MetaAdsReader(client), client);
    } catch (err) {
      const auth = authState(err);
      if (auth) await this.markAuth(conn, auth, (err as Error).message);
      throw httpFrom(err);
    }
  }

  /* ── Estado ── */

  async status() {
    const cfg = this.config();
    const conn = await this.connection();
    const runs = await this.prisma.metaDevSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 });
    const acct = conn?.selectedAccountId;
    const stored = acct
      ? Object.fromEntries(await Promise.all(['CAMPAIGN', 'ADSET', 'AD'].map(async (l) => [l, await this.prisma.metaDevObject.count({ where: { accountId: acct, level: l } })])))
      : {};
    const insights = acct ? await this.prisma.metaDevInsight.count({ where: { accountId: acct } }) : 0;
    const expires = conn?.tokenExpiresAt ? new Date(conn.tokenExpiresAt) : null;
    return {
      label: META_DEV_LABEL,
      config: {
        appId: cfg.appId || null, appSecretSet: !!cfg.appSecret, redirectUri: cfg.redirectUri, redirectError: cfg.redirectError,
        scopes: cfg.scopes, version: cfg.version, missing: cfg.missing, defaultDays: cfg.defaultDays, readOnly: true,
      },
      connection: conn ? {
        status: conn.status, metaUserId: conn.metaUserId, metaUserName: conn.metaUserName,
        scopes: parseJson<string[]>(conn.scopesJson, []), declined: parseJson<string[]>(conn.declinedJson, []),
        longLived: conn.longLived ?? null, tokenExpiresAt: expires,
        daysLeft: expires ? Math.max(0, Math.floor((expires.getTime() - this.now().getTime()) / dayMs)) : null,
        dataAccessExpiresAt: conn.dataAccessExpiresAt, selectedAccountId: conn.selectedAccountId, selectedAccountName: conn.selectedAccountName,
        accountCurrency: conn.accountCurrency, accountTimezone: conn.accountTimezone,
        lastSyncAt: conn.lastSyncAt, lastSyncStatus: conn.lastSyncStatus, lastError: conn.lastError, lastErrorKind: conn.lastErrorKind,
        syncing: !!conn.syncLockUntil && new Date(conn.syncLockUntil).getTime() > this.now().getTime(),
        connectedBy: conn.connectedBy, connectedAt: conn.connectedAt,
      } : { status: 'DISCONNECTED' },
      stored: { ...stored, INSIGHT: insights },
      runs: runs.map((r) => this.runView(r, false)),
    };
  }

  private runView(r: any, withCalls: boolean) {
    return {
      id: r.id, accountId: r.accountId, status: r.status, days: r.days, since: r.since, until: r.until,
      counts: parseJson(r.countsJson, {}), warnings: parseJson<string[]>(r.warningsJson, []), error: r.error, errorKind: r.errorKind,
      startedBy: r.startedBy, startedAt: r.startedAt, finishedAt: r.finishedAt,
      ...(withCalls ? { calls: parseJson<GraphCallLog[]>(r.callsJson, []) } : { callCount: parseJson<unknown[]>(r.callsJson, []).length }),
    };
  }

  async runs() {
    const rows = await this.prisma.metaDevSyncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 });
    return rows.map((r) => this.runView(r, true));
  }

  /* ── OAuth ── */

  /** Arranca OAuth: state aleatorio de un solo uso, guardado como hash y atado al navegador (cookie). */
  async connect(user: AuthUser) {
    const cfg = this.requireConfig();
    const nonce = randomBytes(32).toString('base64url');
    const now = this.now();
    await this.prisma.metaDevOAuthState.deleteMany({ where: { expiresAt: { lt: now } } });
    await this.prisma.metaDevOAuthState.create({ data: { id: sha(nonce), userId: user.id, createdAt: now, expiresAt: new Date(now.getTime() + STATE_TTL_MS), usedAt: null } });
    await this.audit.log({ actor: user, action: 'meta_dev.oauth_start', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: `Permisos pedidos: ${cfg.scopes.join(', ')}` });
    return {
      url: dialogUrl({ appId: cfg.appId, redirectUri: cfg.redirectUri }, nonce, cfg.scopes, cfg.version),
      nonce,
      secureCookie: cfg.redirectUri.startsWith('https:'),
    };
  }

  /** Consume el state: tiene que coincidir con la cookie, existir, no estar usado ni vencido. */
  private async consumeState(state: string | undefined, cookie: string | null): Promise<string | null> {
    if (!state || !cookie || state.length > 128) return null;
    const a = Buffer.from(state);
    const b = Buffer.from(cookie);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const id = sha(state);
    const now = this.now();
    const used = await this.prisma.metaDevOAuthState.updateMany({ where: { id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (used.count !== 1) return null;
    return (await this.prisma.metaDevOAuthState.findUnique({ where: { id } }))?.userId ?? null;
  }

  /** Vuelta de Meta. Devuelve a dónde redirigir; el token jamás va en la URL. */
  async callback(q: { code?: string; state?: string; error?: string; error_reason?: string }, cookie: string | null): Promise<string> {
    const cfg = this.config();
    const back = (r: string, motivo?: string) => `${cfg.webBase}/dev/meta-ads?r=${r}${motivo ? `&motivo=${motivo}` : ''}`;
    const userId = await this.consumeState(q.state, cookie);
    if (!userId) {
      this.logger.warn('OAuth Meta (dev): state inválido, usado o vencido');
      return back('error', 'state');
    }
    const actor = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!actor || actor.role !== ROLES.DEV) return back('error', 'usuario');
    const who = { id: actor.id, name: actor.name, email: actor.email, role: actor.role, companyId: null } as AuthUser;
    if (q.error || !q.code) {
      const cancelled = q.error === 'access_denied';
      await this.audit.log({ actor: who, action: cancelled ? 'meta_dev.oauth_cancelled' : 'meta_dev.oauth_error', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: redact(`${q.error ?? 'sin código'} ${q.error_reason ?? ''}`).slice(0, 120) });
      return cancelled ? back('cancelado') : back('error', 'meta');
    }
    if (cfg.missing.length) return back('error', 'config');
    try {
      const t = await exchangeCodeForToken({ appId: cfg.appId, appSecret: cfg.appSecret, redirectUri: cfg.redirectUri! }, q.code, { fetchImpl: this.fetchImpl, now: this.now() });
      const dbg = await debugToken({ appId: cfg.appId, appSecret: cfg.appSecret }, t.accessToken, { fetchImpl: this.fetchImpl });
      // El token tiene que ser válido y de NUESTRA app
      if (!dbg.isValid || dbg.appId !== cfg.appId) {
        await this.audit.log({ actor: who, action: 'meta_dev.oauth_error', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: 'Token inválido o de otra app' });
        return back('error', 'token');
      }
      const reader = new MetaAdsReader(this.client(t.accessToken));
      const [me, perms] = await Promise.all([reader.me(), reader.permissions()]);
      const now = this.now();
      const data = {
        tokenEnc: encryptSecret(t.accessToken), longLived: t.longLived,
        tokenExpiresAt: dbg.expiresAt ?? t.expiresAt, dataAccessExpiresAt: dbg.dataAccessExpiresAt,
        scopesJson: JSON.stringify(perms.granted), declinedJson: JSON.stringify(perms.declined),
        metaUserId: me?.id ? String(me.id) : dbg.userId, metaUserName: me?.name ? String(me.name).slice(0, 120) : null, appId: cfg.appId,
        status: 'CONNECTED', lastError: null, lastErrorKind: null, connectedBy: actor.name, connectedAt: now, updatedAt: now,
      };
      await this.prisma.metaDevConnection.upsert({ where: { id: META_DEV_CONNECTION_ID }, update: data, create: { id: META_DEV_CONNECTION_ID, ...data } });
      await this.audit.log({ actor: who, action: 'meta_dev.connect', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: `Permisos concedidos: ${perms.granted.join(', ') || 'ninguno'}` });
      return perms.granted.includes('ads_read') ? back('conectado') : back('conectado', 'sin_ads_read');
    } catch (err: any) {
      this.logger.warn(`OAuth Meta (dev): ${redact(String(err?.message ?? err)).slice(0, 200)}`);
      await this.audit.log({ actor: who, action: 'meta_dev.oauth_error', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: redact(String(err?.message ?? err)).slice(0, 200) });
      return back('error', 'intercambio');
    }
  }

  /* ── Cuentas ── */

  async accounts() {
    const list = await this.live((r) => r.adAccounts());
    await this.saveObjects('ACCOUNTS', 'ACCOUNT', list);
    const conn = await this.connection();
    return list.map((a) => ({ id: a.externalId, name: a.name, status: a.status, currency: a.currency, timezone: a.timezone, selected: a.externalId === conn?.selectedAccountId }));
  }

  async select(user: AuthUser, dto: { accountId?: string }) {
    const id = String(dto?.accountId ?? '').trim();
    if (!ACT_ID.test(id)) throw new BadRequestException('Cuenta inválida: usa el formato act_1234567890');
    const list = await this.live((r) => r.adAccounts());
    const acct = list.find((a) => a.externalId === id);
    if (!acct) throw new ForbiddenException('Esa cuenta no está entre las que autorizó este token');
    await this.prisma.metaDevConnection.update({
      where: { id: META_DEV_CONNECTION_ID },
      data: { selectedAccountId: acct.externalId, selectedAccountName: acct.name, accountCurrency: acct.currency, accountTimezone: acct.timezone, updatedAt: this.now() },
    });
    await this.audit.log({ actor: user, action: 'meta_dev.select', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: `${acct.name} (${acct.externalId})` });
    return { ok: true, accountId: acct.externalId, name: acct.name };
  }

  /* ── Sincronización manual ── */

  /** Guarda sin duplicar (id derivado de cuenta + nivel + id de Meta) y cuenta nuevos / actualizados / sin cambios. */
  private async saveObjects(accountId: string, level: ObjectLevel, list: MetaObject[]): Promise<Counts> {
    const scopeAcct = level === 'ACCOUNT' ? null : accountId;
    const existing = await this.prisma.metaDevObject.findMany({ where: { level, ...(scopeAcct ? { accountId: scopeAcct } : {}) } });
    const byId = new Map(existing.map((x: any) => [x.id, x]));
    const now = this.now();
    const counts: Counts = { created: 0, updated: 0, unchanged: 0, total: list.length };
    const fresh = new Map<string, any>();
    for (const o of list) {
      const acct = level === 'ACCOUNT' ? o.externalId : accountId;
      const id = sha('obj', acct, level, o.externalId).slice(0, 40);
      const fields = { name: o.name, status: o.status, effectiveStatus: o.effectiveStatus, objective: o.objective, campaignId: o.campaignId, adsetId: o.adsetId, currency: o.currency, timezone: o.timezone };
      const hash = sha(JSON.stringify(fields));
      const old = byId.get(id);
      if (!old) {
        if (!fresh.has(id)) counts.created++;
        fresh.set(id, { id, scope: 'DEV_INTERNAL', accountId: acct, level, externalId: o.externalId, ...fields, hash, rawJson: JSON.stringify(redactBody(o.raw)).slice(0, 20000), firstSeenAt: now, syncedAt: now });
      } else if (old.hash !== hash) {
        await this.prisma.metaDevObject.update({ where: { id }, data: { ...fields, hash, rawJson: JSON.stringify(redactBody(o.raw)).slice(0, 20000), syncedAt: now } });
        counts.updated++;
      } else {
        counts.unchanged++;
      }
    }
    if (fresh.size) await this.prisma.metaDevObject.createMany({ data: [...fresh.values()] });
    return counts;
  }

  private async saveInsights(accountId: string, currency: string | null, rows: MetaInsight[]): Promise<Counts> {
    const counts: Counts = { created: 0, updated: 0, unchanged: 0, total: rows.length };
    if (!rows.length) return counts;
    const existing = await this.prisma.metaDevInsight.findMany({ where: { accountId } });
    const byId = new Map(existing.map((x: any) => [x.id, x]));
    const now = this.now();
    const fresh = new Map<string, any>();
    for (const r of rows) {
      const id = sha('ins', accountId, r.campaignId, r.dateStart, r.dateStop).slice(0, 40);
      const fields = {
        campaignName: r.campaignName, impressions: r.impressions, clicks: r.clicks, spend: r.spend, cpc: r.cpc, cpm: r.cpm, ctr: r.ctr, reach: r.reach,
        actionsJson: JSON.stringify(r.actions), currency,
      };
      const hash = sha(JSON.stringify(fields));
      const old = byId.get(id);
      if (!old) {
        if (!fresh.has(id)) counts.created++;
        fresh.set(id, { id, scope: 'DEV_INTERNAL', accountId, level: 'CAMPAIGN', campaignId: r.campaignId, dateStart: r.dateStart, dateStop: r.dateStop, ...fields, hash, rawJson: JSON.stringify(redactBody(r.raw)).slice(0, 8000), syncedAt: now });
      } else if (old.hash !== hash) {
        // Meta sigue ajustando la atribución unos días: se actualiza lo que cambió
        await this.prisma.metaDevInsight.update({ where: { id }, data: { ...fields, hash, rawJson: JSON.stringify(redactBody(r.raw)).slice(0, 8000), syncedAt: now } });
        counts.updated++;
      } else {
        counts.unchanged++;
      }
    }
    if (fresh.size) await this.prisma.metaDevInsight.createMany({ data: [...fresh.values()] });
    return counts;
  }

  async sync(user: AuthUser, dto: { days?: number | string }) {
    const cfg = this.requireConfig();
    const { conn, token } = await this.token();
    const act = conn.selectedAccountId as string | null;
    if (!act) throw new BadRequestException({ message: 'Primero elige la cuenta publicitaria de pruebas', code: 'NO_ACCOUNT' });
    const days = [30, 60].includes(Number(dto?.days)) ? Number(dto!.days) : cfg.defaultDays;
    const start = this.now();
    const locked = await this.prisma.metaDevConnection.updateMany({
      where: { id: META_DEV_CONNECTION_ID, OR: [{ syncLockUntil: { isSet: false } }, { syncLockUntil: null }, { syncLockUntil: { lt: start } }] },
      data: { syncLockUntil: new Date(start.getTime() + SYNC_LOCK_MS) },
    });
    if (locked.count !== 1) throw new ConflictException({ message: 'Ya hay una sincronización en curso', code: 'SYNC_RUNNING' });
    // Los días son los de la zona horaria de la cuenta, como los muestra Meta
    const until = todayIn(conn.accountTimezone, start);
    const since = addDays(until, -(days - 1));
    const run = await this.prisma.metaDevSyncRun.create({ data: { scope: 'DEV_INTERNAL', accountId: act, days, since, until, status: 'RUNNING', startedBy: user.name, startedAt: start } });
    const calls: GraphCallLog[] = [];
    const reader = new MetaAdsReader(this.client(token, calls));
    const counts: Record<string, Counts> = {};
    const warnings: string[] = [];
    let skipped = false;
    let failure: AdsProviderError | null = null;
    try {
      counts.CAMPAIGN = await this.saveObjects(act, 'CAMPAIGN', await reader.campaigns(act));
      for (const level of ['ADSET', 'AD'] as const) {
        try {
          counts[level] = await this.saveObjects(act, level, level === 'ADSET' ? await reader.adsets(act) : await reader.ads(act));
        } catch (err) {
          // Sin permiso para un nivel: se sigue con lo demás y la corrida queda parcial
          if (!(err instanceof AdsProviderError) || !['PERMISSION', 'NOT_FOUND', 'NOT_SUPPORTED'].includes(err.kind)) throw err;
          warnings.push(`${LEVEL_LABEL[level]}: ${err.message}`);
          skipped = true;
        }
      }
      const rows = await reader.campaignInsights(act, since, until);
      counts.INSIGHT = await this.saveInsights(act, conn.accountCurrency, rows);
      if (!rows.length) warnings.push(`Meta respondió data: [] para Insights entre ${since} y ${until}: no hay métricas en ese rango. No se completó nada con valores inventados.`);
    } catch (err: any) {
      failure = err instanceof AdsProviderError ? err : new MetaGraphError('PROVIDER', redact(String(err?.message ?? err)).slice(0, 300));
    }
    const done = this.now();
    const status = failure ? (counts.CAMPAIGN ? 'PARTIAL' : 'ERROR') : skipped ? 'PARTIAL' : 'OK';
    const auth = authState(failure);
    await this.prisma.metaDevSyncRun.update({
      where: { id: run.id },
      data: {
        status, countsJson: JSON.stringify(counts), callsJson: JSON.stringify(calls), warningsJson: JSON.stringify(warnings),
        error: failure?.message ?? null, errorKind: failure?.kind ?? null, finishedAt: done,
      },
    });
    await this.prisma.metaDevConnection.update({
      where: { id: META_DEV_CONNECTION_ID },
      data: {
        syncLockUntil: null, lastSyncStatus: status, lastError: failure?.message ?? null, lastErrorKind: failure?.kind ?? null,
        ...(status !== 'ERROR' ? { lastSyncAt: done } : {}),
        ...(auth ? { status: auth } : {}),
        updatedAt: done,
      },
    });
    await this.audit.log({
      actor: user, action: failure ? 'meta_dev.sync_error' : 'meta_dev.sync', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID,
      detail: `${act} · ${status}${failure ? ` · ${failure.kind}: ${failure.message}` : ''}`.slice(0, 300),
    });
    return {
      runId: run.id, status, since, until, days, counts, warnings, calls: calls.length,
      error: failure?.message ?? null, errorKind: auth ? `AUTH_${auth}` : failure?.kind ?? null,
    };
  }

  /* ── Datos guardados ── */

  private async selected() {
    const conn = await this.connection();
    if (!conn?.selectedAccountId) throw new BadRequestException({ message: 'Todavía no hay cuenta de pruebas elegida', code: 'NO_ACCOUNT' });
    return conn;
  }

  async objects(level: string) {
    const lv = ['CAMPAIGN', 'ADSET', 'AD'].includes(level) ? level : 'CAMPAIGN';
    const conn = await this.selected();
    const rows = await this.prisma.metaDevObject.findMany({ where: { accountId: conn.selectedAccountId!, level: lv }, orderBy: { name: 'asc' } });
    return rows.map((r: any) => ({
      id: r.externalId, name: r.name, status: r.status, effectiveStatus: r.effectiveStatus, objective: r.objective,
      campaignId: r.campaignId, adsetId: r.adsetId, firstSeenAt: r.firstSeenAt, syncedAt: r.syncedAt, raw: parseJson(r.rawJson, {}),
    }));
  }

  async insights() {
    const conn = await this.selected();
    const rows = await this.prisma.metaDevInsight.findMany({ where: { accountId: conn.selectedAccountId! }, orderBy: { dateStart: 'desc' } });
    // Totales por campaña: solo lo que sí se puede sumar día a día (el alcance no)
    const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b);
    const byCampaign = new Map<string, { campaignId: string; campaignName: string | null; days: number; impressions: number | null; clicks: number | null; spend: number | null }>();
    for (const r of rows as any[]) {
      const t = byCampaign.get(r.campaignId) ?? { campaignId: r.campaignId, campaignName: r.campaignName, days: 0, impressions: null, clicks: null, spend: null };
      t.days++;
      t.impressions = add(t.impressions, r.impressions);
      t.clicks = add(t.clicks, r.clicks);
      t.spend = add(t.spend, r.spend);
      byCampaign.set(r.campaignId, t);
    }
    return {
      currency: conn.accountCurrency,
      rows: rows.map((r: any) => ({
        campaignId: r.campaignId, campaignName: r.campaignName, dateStart: r.dateStart, dateStop: r.dateStop,
        impressions: r.impressions, clicks: r.clicks, spend: r.spend, cpc: r.cpc, cpm: r.cpm, ctr: r.ctr, reach: r.reach,
        actions: parseJson(r.actionsJson, []), syncedAt: r.syncedAt,
      })),
      totals: [...byCampaign.values()],
    };
  }

  /* ── Respuesta cruda de Meta (para revisar) ── */

  /**
   * Consulta en vivo de UNA página (máx. 25 filas) para revisar lo que responde
   * Meta. No se guarda ni toca las sincronizaciones. Insights usa los días
   * elegidos en la pantalla (30 o 60); sin ese dato, META_DEV_SYNC_DAYS.
   */
  async raw(kind: string, daysParam?: string) {
    const cfg = this.config();
    let days = cfg.defaultDays;
    if (daysParam !== undefined && daysParam !== '') {
      if (!['30', '60'].includes(String(daysParam))) throw new BadRequestException({ message: 'Días inválidos: solo 30 o 60', code: 'INVALID_DAYS' });
      days = Number(daysParam);
    }
    const conn = await this.connection();
    const act = conn?.selectedAccountId;
    const needsAct = ['campaigns', 'adsets', 'ads', 'insights'].includes(kind);
    if (needsAct && !act) throw new BadRequestException({ message: 'Primero elige la cuenta de pruebas', code: 'NO_ACCOUNT' });
    const until = todayIn(conn?.accountTimezone, this.now());
    const req: Record<string, [string, Record<string, string>]> = {
      me: ['/me', { fields: 'id,name' }],
      permissions: ['/me/permissions', {}],
      accounts: ['/me/adaccounts', { fields: ACCOUNT_FIELDS, limit: '25' }],
      campaigns: [`/${act}/campaigns`, { fields: CAMPAIGN_FIELDS, limit: '25' }],
      adsets: [`/${act}/adsets`, { fields: ADSET_FIELDS, limit: '25' }],
      ads: [`/${act}/ads`, { fields: AD_FIELDS, limit: '25' }],
      insights: [`/${act}/insights`, { level: 'campaign', time_increment: '1', time_range: JSON.stringify({ since: addDays(until, -(days - 1)), until }), fields: INSIGHT_FIELDS, limit: '25' }],
    };
    if (!req[kind]) throw new BadRequestException('Consulta no permitida');
    // Rango exacto que va a Meta (solo Insights usa fechas)
    const range = kind === 'insights' ? { days, ...JSON.parse(req.insights[1].time_range) as { since: string; until: string } } : null;
    const meta = { live: true, saved: false, maxRows: 25, range };
    const calls: GraphCallLog[] = [];
    try {
      const body = await this.live((_r, client) => client.get(req[kind][0], req[kind][1]), calls);
      return { ok: true, kind, ...meta, calls, body: redactBody(body) };
    } catch (err: any) {
      // El error también se muestra: es justo lo que hay que revisar
      return { ok: false, kind, ...meta, calls, error: err?.getResponse?.() ?? { message: redact(String(err?.message ?? err)) } };
    }
  }

  /* ── Credencial: comprobar que está guardada de forma segura ── */

  async credential(liveCheck: boolean) {
    const cfg = this.config();
    const conn = await this.connection();
    const enc = conn?.tokenEnc ?? null;
    let decrypts = false;
    if (enc) {
      try {
        decrypts = decryptSecret(enc).length > 0;
      } catch {
        decrypts = false;
      }
    }
    const out: Record<string, unknown> = {
      stored: !!enc,
      encrypted: isEncrypted(enc),
      algorithm: 'AES-256-GCM · llave MASTER_ENCRYPTION_KEY (solo en .env del API)',
      storedLength: enc ? enc.length : 0,
      decryptsWithCurrentKey: decrypts,
      exposedByApi: false,
      longLived: conn?.longLived ?? null,
      tokenExpiresAt: conn?.tokenExpiresAt ?? null,
      dataAccessExpiresAt: conn?.dataAccessExpiresAt ?? null,
      scopes: parseJson<string[]>(conn?.scopesJson, []),
      declined: parseJson<string[]>(conn?.declinedJson, []),
    };
    if (liveCheck && enc && !cfg.missing.length) {
      const { token } = await this.token();
      try {
        const d = await debugToken({ appId: cfg.appId, appSecret: cfg.appSecret }, token, { fetchImpl: this.fetchImpl });
        out.live = { isValid: d.isValid, appIdMatches: d.appId === cfg.appId, type: d.type, expiresAt: d.expiresAt, dataAccessExpiresAt: d.dataAccessExpiresAt, scopes: d.scopes };
      } catch (err) {
        out.live = { error: httpFrom(err).getResponse() };
      }
    }
    return out;
  }

  /* ── Desconexión ── */

  async disconnect(user: AuthUser, opts: { revoke?: boolean; purge?: boolean }) {
    const conn = await this.connection();
    let revoked: 'OK' | 'FAILED' | 'SKIPPED' = 'SKIPPED';
    let revokeError: string | null = null;
    if (opts.revoke && conn?.tokenEnc) {
      try {
        await this.client(decryptSecret(conn.tokenEnc)).revokeAppPermissions();
        revoked = 'OK';
      } catch (err: any) {
        // Si ya estaba vencido o revocado en Meta, igual se borra aquí
        revoked = 'FAILED';
        revokeError = redact(String(err?.message ?? err)).slice(0, 200);
      }
    }
    if (conn) {
      await this.prisma.metaDevConnection.update({
        where: { id: META_DEV_CONNECTION_ID },
        data: {
          tokenEnc: null, status: 'DISCONNECTED', tokenExpiresAt: null, dataAccessExpiresAt: null, syncLockUntil: null, updatedAt: this.now(),
          ...(opts.purge ? { selectedAccountId: null, selectedAccountName: null, accountCurrency: null, accountTimezone: null, lastSyncAt: null, lastSyncStatus: null } : {}),
        },
      });
    }
    let purged = 0;
    if (opts.purge) {
      purged += (await this.prisma.metaDevObject.deleteMany({})).count;
      purged += (await this.prisma.metaDevInsight.deleteMany({})).count;
      purged += (await this.prisma.metaDevSyncRun.deleteMany({})).count;
      await this.prisma.metaDevOAuthState.deleteMany({});
    }
    await this.audit.log({ actor: user, action: 'meta_dev.disconnect', entity: 'MetaDevConnection', entityId: META_DEV_CONNECTION_ID, detail: `revocar en Meta: ${revoked}${opts.purge ? ` · datos internos borrados: ${purged}` : ''}` });
    return { ok: true, revoked, revokeError, purged };
  }
}

@Controller('dev/meta-ads')
@UseGuards(MetaDevGuard)
export class MetaDevController {
  constructor(private readonly svc: MetaDevService) {}

  @Get('status') status() { return this.svc.status(); }

  @Get('connect') @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async connect(@CurrentUser() u: AuthUser, @Res({ passthrough: true }) res: Response) {
    const r = await this.svc.connect(u);
    // Ata el state a este navegador: la vuelta de Meta tiene que traer la misma cookie
    res.cookie(META_DEV_COOKIE, r.nonce, { httpOnly: true, sameSite: 'lax', secure: r.secureCookie, path: '/api/dev/meta-ads', maxAge: STATE_TTL_MS });
    return { url: r.url };
  }

  @Get('accounts') @Throttle({ default: { ttl: 60_000, limit: 20 } }) accounts() { return this.svc.accounts(); }
  @Post('select') select(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.svc.select(u, dto); }
  @Post('sync') @Throttle({ default: { ttl: 60_000, limit: 5 } }) sync(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.svc.sync(u, dto); }
  @Get('runs') runs() { return this.svc.runs(); }
  @Get('objects') objects(@Query('level') level: string) { return this.svc.objects(String(level ?? '').toUpperCase()); }
  @Get('insights') insights() { return this.svc.insights(); }
  @Get('raw') @Throttle({ default: { ttl: 60_000, limit: 20 } }) raw(@Query('kind') kind: string, @Query('days') days?: string) { return this.svc.raw(String(kind ?? ''), days); }
  @Get('credential') @Throttle({ default: { ttl: 60_000, limit: 10 } }) credential(@Query('live') live?: string) { return this.svc.credential(live === '1'); }

  @Delete('connection')
  disconnect(@CurrentUser() u: AuthUser, @Query('revoke') revoke?: string, @Query('purge') purge?: string) {
    return this.svc.disconnect(u, { revoke: revoke !== '0', purge: purge === '1' });
  }
}

/** La vuelta de Meta llega sin sesión del panel: se valida con el state de un solo uso + la cookie. */
@Controller('dev/meta-ads')
export class MetaDevCallbackController {
  constructor(private readonly svc: MetaDevService) {}

  @Public()
  @SkipThrottle()
  @Get('callback')
  async callback(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    if (!metaDevEnabled()) throw new NotFoundException();
    const to = await this.svc.callback(
      { code: q.code, state: q.state, error: q.error, error_reason: q.error_reason },
      cookieValue(req, META_DEV_COOKIE),
    );
    res.clearCookie(META_DEV_COOKIE, { path: '/api/dev/meta-ads' });
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, to);
  }
}

@Module({
  imports: [AuditModule],
  providers: [MetaDevService, MetaDevGuard],
  controllers: [MetaDevController, MetaDevCallbackController],
})
export class MetaDevModule {}
