import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException,
  Param, Post, Put, Query, Res,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { exchangeCode, oauthUrl, signState, verifyState } from '../common/meta-publish';
import { publicWebUrl } from '../common/tracking';
import { DEFAULT_STAGES } from '../common/pipelines';
import { AccountRef, AdLevel, AdsProvider, AdsProviderError, FetchLike, PeriodStats, ProviderErrorKind, ProviderKey, RemoteEntity, RemoteInsight, addDays, isoDay } from '../common/ads/provider';
import { META_ADS_SCOPES } from '../common/ads/meta-ads-provider';
import { DemoAdsProvider } from '../common/ads/demo-provider';
import { PROVIDER_KEYS, providerFor } from '../common/ads/registry';
import {
  RESULT_LABEL, ResultType, comparable, delta, groupBy, inRange, mixedTotals, periodStatFor, periods, resultTypeFor, resultsOf, totals, typedTotals,
} from '../common/ads/metrics';
import { KIND_LABEL, SYNC_EVERY_H, SYNC_LOCK_MS, accountStatusAfter, chunks, nextAttempt } from '../common/ads/sync-policy';
import { deterministicId } from '../common/automation/run-signals';
import { CrmAdStats, audit } from '../common/ads/findings';
import { Autonomy, METRICS, RuleLike, budgetAllowed, evaluateRule, guardAutoAction, ruleRunKey, validateRule } from '../common/ads/autopilot';
import { AttributionState, adIdOf, attributionOf, revenueFunnel } from '../common/ads/revenue';
import { Brief, buildProposal, validateBrief } from '../common/ads/proposal';
import { OPEN, OppDraft, storeDetected } from '../common/opportunities/store';
import { AuditModule, AuditService } from './audit.module';
import { AdLeadsService } from './ads-leads';
import { Products } from '../auth/products.guard';
import { ProductInactiveError, hasProduct } from '../common/products';

/**
 * BackOffice Creative Ads: cuentas publicitarias de cada empresa, sincronización,
 * auditoría, Autopilot, atribución con el CRM y Campaign Studio.
 *
 * Reglas de oro:
 *  - La empresa sale SIEMPRE de la sesión (platform puede pasar companyId).
 *  - Los tokens viven cifrados y jamás salen por el API.
 *  - Lo que gasta dinero (reanudar, crear/activar) exige confirm=true de una persona.
 *  - Los datos DEMO llevan mode=DEMO y nunca se suman a los REAL.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
const FIRST_SYNC_DAYS = 60;

/*
 * Identidad e idempotencia sin depender de índices: el _id de cada fila se
 * deriva de su clave lógica, y Mongo siempre garantiza que _id sea único
 * (aunque en la base compartida falten los índices únicos declarados).
 *  - Cuenta:   empresa + plataforma + ID externo
 *  - Elemento: cuenta + nivel + ID externo
 *  - Métrica:  cuenta + nivel + ID externo + día
 *  - Acción:   clave de idempotencia
 */
export const adAccountId = (companyId: string, provider: string, externalId: string) => deterministicId('ada', companyId, provider, externalId);
export const adEntityId = (accountId: string, level: string, externalId: string) => deterministicId('ade', accountId, level, externalId);
export const adInsightId = (accountId: string, level: string, externalId: string, date: string) => deterministicId('adi', accountId, level, externalId, date);
export const adActionId = (idempotencyKey: string) => deterministicId('adl', idempotencyKey);

const isDup = (err: any) => err?.code === 'P2002';
const PERIOD_STATS_KEEP = 6;
/** Al re-sincronizar se vuelven a traer estos días: la atribución sigue cambiando */
const RESYNC_DAYS = 7;

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

@Injectable()
export class AdsService {
  private readonly logger = new Logger('Ads');
  fetchImpl: FetchLike = (u, i) => fetch(u, i) as any;
  /** Fecha "hoy" reemplazable en pruebas */
  now: () => Date = () => new Date();
  private cronBusy = false;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /* ── Empresa y permisos ── */

  async companyOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    if (!isPlatformRole(user.role) && !hasProduct(company, 'ADS')) throw new ForbiddenException(ProductInactiveError.body(['ADS'], company));
    return company;
  }

  private async accountOf(companyId: string, accountId: string) {
    const a = await this.prisma.adAccount.findUnique({ where: { id: accountId } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('Cuenta publicitaria no encontrada');
    return a;
  }

  private async metaApp() {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: ['META_APP_ID', 'META_APP_SECRET'] } } });
    const get = (k: string) => rows.find((r) => r.key === k)?.value?.trim() || process.env[k] || '';
    return { appId: get('META_APP_ID'), appSecret: get('META_APP_SECRET') };
  }

  private provider(key: string, mode: string, metaConfigured = true): AdsProvider {
    return providerFor(key as ProviderKey, mode === 'DEMO' ? 'DEMO' : 'REAL', { fetchImpl: this.fetchImpl, metaConfigured: () => metaConfigured });
  }

  private token(a: { tokenEnc: string | null; mode: string }) {
    if (a.mode === 'DEMO') return 'demo';
    if (!a.tokenEnc) throw new BadRequestException('La cuenta no tiene una conexión vigente. Vuelve a conectarla.');
    try {
      return decryptSecret(a.tokenEnc);
    } catch {
      throw new BadRequestException('No se pudo leer la conexión guardada. Vuelve a conectar la cuenta.');
    }
  }

  private ref(a: { externalId: string; currency: string; timezone: string | null }): AccountRef {
    return { externalId: a.externalId, currency: a.currency, timezone: a.timezone };
  }

  /** Vista pública de una cuenta: nunca incluye el token. */
  private view(a: any) {
    const { tokenEnc: _t, ...rest } = a;
    const ageH = a.lastSyncAt ? Math.round((this.now().getTime() - new Date(a.lastSyncAt).getTime()) / 36e5) : null;
    const { syncLockUntil, periodStatsJson: _p, ...pub } = rest;
    return {
      ...pub, hasToken: !!a.tokenEnc, scopes: parseJson<string[]>(a.scopesJson, []), dataAgeHours: ageH, stale: ageH === null || ageH > SYNC_EVERY_H * 2,
      // La credencial nunca sale: solo se dice que existe y cómo se guardó
      credential: a.mode === 'DEMO' ? 'Sin credencial (demostración)' : a.tokenEnc ? 'Guardada cifrada · no se muestra' : 'Sin credencial',
      syncing: !!syncLockUntil && new Date(syncLockUntil).getTime() > this.now().getTime(),
      errorHelp: a.lastErrorKind ? KIND_LABEL[a.lastErrorKind] ?? null : null,
    };
  }

  /* ── Proveedores y cuentas ── */

  async providers(user: AuthUser, companyId?: string) {
    await this.companyOf(user, companyId);
    const app = await this.metaApp();
    const metaReady = !!(app.appId && app.appSecret);
    return PROVIDER_KEYS.map((k) => {
      const p = this.provider(k, 'REAL', metaReady);
      return { key: k, label: p.label, capabilities: p.capabilities, missing: p.missingConfig(), oauth: k === 'META' && metaReady, demoAvailable: true };
    });
  }

  async accounts(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const rows = await this.prisma.adAccount.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'asc' } });
    return rows.map((a) => this.view(a));
  }

  async connectDemo(user: AuthUser, dto: { provider?: string }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const key = (PROVIDER_KEYS as string[]).includes(String(dto?.provider)) ? (dto!.provider as ProviderKey) : 'META';
    const p = new DemoAdsProvider(key);
    const [remote] = await p.listAccounts();
    const existing = await this.prisma.adAccount.findFirst({ where: { companyId: c.id, provider: key, externalId: remote.externalId } });
    const acc = existing ?? await this.prisma.adAccount.create({
      data: { id: adAccountId(c.id, key, remote.externalId), companyId: c.id, provider: key, mode: 'DEMO', externalId: remote.externalId, name: remote.name, currency: remote.currency, timezone: remote.timezone, status: 'CONNECTED', connectedBy: user.name, updatedAt: this.now() },
    }).catch(async (err: any) => {
      if (!isDup(err)) throw err;
      return this.prisma.adAccount.findUniqueOrThrow({ where: { id: adAccountId(c.id, key, remote.externalId) } });
    });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.demo', entity: 'AdAccount', entityId: acc.id, detail: `Cuenta de demostración ${key}` });
    await this.sync(user, acc.id, c.id);
    return this.view(await this.prisma.adAccount.findUnique({ where: { id: acc.id } }));
  }

  /** Conexión manual con token (p. ej. usuario del sistema de Business Manager). */
  async connectManual(user: AuthUser, dto: { accountId?: string; token?: string }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const raw = clip(dto?.accountId, 40).replace(/^act_/, '');
    if (!/^\d{5,25}$/.test(raw)) throw new BadRequestException('El ID de la cuenta publicitaria son solo números (act_1234567890)');
    const token = clip(dto?.token, 1000);
    if (token.length < 20) throw new BadRequestException('Pega el token de acceso (con permiso ads_read o ads_management)');
    const p = this.provider('META', 'REAL');
    let list;
    try {
      list = await p.listAccounts(token);
    } catch (e) {
      throw this.providerHttp(e);
    }
    const remote = list.find((a) => a.externalId === `act_${raw}`);
    if (!remote) throw new BadRequestException('Ese token no tiene acceso a esa cuenta publicitaria');
    return this.saveAccount(user, c.id, remote, token, ['manual']);
  }

  private async saveAccount(user: AuthUser | null, companyId: string, remote: { externalId: string; name: string; currency: string; timezone: string | null }, token: string, scopes: string[]) {
    // Una cuenta publicitaria solo puede estar conectada en una empresa a la vez
    const elsewhere = await this.prisma.adAccount.findFirst({ where: { provider: 'META', externalId: remote.externalId, mode: 'REAL', status: { not: 'DISCONNECTED' }, NOT: { companyId } } });
    if (elsewhere) throw new ConflictException('Esa cuenta publicitaria ya está conectada en otra empresa de BackOffice');
    const existing = await this.prisma.adAccount.findFirst({ where: { companyId, provider: 'META', externalId: remote.externalId } });
    const data = {
      name: remote.name, currency: remote.currency, timezone: remote.timezone, tokenEnc: encryptSecret(token),
      scopesJson: JSON.stringify(scopes), status: 'CONNECTED', lastError: null, connectedBy: user?.name ?? null, updatedAt: this.now(),
    };
    const id = adAccountId(companyId, 'META', remote.externalId);
    const acc = existing
      ? await this.prisma.adAccount.update({ where: { id: existing.id }, data: { ...data, nextSyncAt: this.now(), syncFailures: 0, lastErrorKind: null } })
      : await this.prisma.adAccount.create({ data: { id, companyId, provider: 'META', mode: 'REAL', externalId: remote.externalId, ...data, nextSyncAt: this.now(), syncFailures: 0 } })
        .catch(async (err: any) => {
          // Dos conexiones simultáneas de la misma cuenta: queda una sola fila
          if (!isDup(err)) throw err;
          return this.prisma.adAccount.update({ where: { id }, data });
        });
    await this.audit.log({ actor: user, companyId, action: 'ads.connect', entity: 'AdAccount', entityId: acc.id, detail: `${remote.name} (${remote.externalId})` });
    return this.view(acc);
  }

  async disconnect(user: AuthUser, accountId: string, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const a = await this.accountOf(c.id, accountId);
    // Se conserva el historial (métricas y acciones); solo se borra la credencial
    await this.prisma.adAccount.update({ where: { id: a.id }, data: { status: 'DISCONNECTED', tokenEnc: null, updatedAt: this.now() } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.disconnect', entity: 'AdAccount', entityId: a.id, detail: a.name });
    return { ok: true };
  }

  /* ── OAuth de Meta Ads ── */

  private async redirectUri() {
    return `${(await publicWebUrl(this.prisma)).replace(/\/$/, '')}/api/public/ads/meta/callback`;
  }

  async oauthStart(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const app = await this.metaApp();
    if (!app.appId || !app.appSecret) throw new BadRequestException('La conexión con Facebook aún no está habilitada (faltan META_APP_ID y META_APP_SECRET). Usa la conexión con token o pídele al equipo.');
    const state = signState({ c: c.id, u: user.id, k: 'ads' }, process.env.JWT_SECRET ?? 'dev');
    return { url: oauthUrl({ appId: app.appId, redirectUri: await this.redirectUri(), state, scopes: META_ADS_SCOPES }) };
  }

  async oauthCallback(code?: string, state?: string): Promise<string> {
    const web = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    const data = verifyState<{ c: string; u: string; k: string }>(String(state ?? ''), process.env.JWT_SECRET ?? 'dev');
    if (!data || data.k !== 'ads' || !code) return `${web}/app/ads?tab=cuentas&meta=error`;
    try {
      const app = await this.metaApp();
      const token = await exchangeCode({ appId: app.appId, appSecret: app.appSecret, redirectUri: await this.redirectUri(), code }, this.fetchImpl as any);
      const list = await this.provider('META', 'REAL').listAccounts(token);
      // Quedan pendientes de elegir (el token cifrado, nunca en la URL)
      await this.prisma.platformSetting.upsert({
        where: { key: `ADS_PENDING_${data.c}` },
        update: { value: JSON.stringify({ tokenEnc: encryptSecret(token), accounts: list, at: Date.now() }) },
        create: { key: `ADS_PENDING_${data.c}`, value: JSON.stringify({ tokenEnc: encryptSecret(token), accounts: list, at: Date.now() }) },
      });
      return `${web}/app/ads?tab=cuentas&meta=elegir`;
    } catch (err: any) {
      this.logger.warn(`OAuth Meta Ads: ${err.message}`);
      return `${web}/app/ads?tab=cuentas&meta=error`;
    }
  }

  async pending(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const row = await this.prisma.platformSetting.findUnique({ where: { key: `ADS_PENDING_${c.id}` } });
    const p = parseJson<{ accounts?: any[]; at?: number }>(row?.value, {});
    if (!p.accounts || !p.at || Date.now() - p.at > 30 * 60e3) return [];
    return p.accounts;
  }

  async selectPending(user: AuthUser, dto: { externalIds?: string[] }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const row = await this.prisma.platformSetting.findUnique({ where: { key: `ADS_PENDING_${c.id}` } });
    const p = parseJson<{ tokenEnc?: string; accounts?: any[]; at?: number }>(row?.value, {});
    if (!p.tokenEnc || !p.accounts || !p.at || Date.now() - p.at > 30 * 60e3) throw new BadRequestException('La autorización venció. Conecta de nuevo.');
    const wanted = new Set((dto?.externalIds ?? []).map(String));
    const chosen = p.accounts.filter((a) => wanted.has(a.externalId));
    if (!chosen.length) throw new BadRequestException('Elige al menos una cuenta');
    const token = decryptSecret(p.tokenEnc);
    const out: any[] = [];
    for (const a of chosen) out.push(await this.saveAccount(user, c.id, a, token, META_ADS_SCOPES));
    await this.prisma.platformSetting.delete({ where: { key: `ADS_PENDING_${c.id}` } }).catch(() => undefined);
    return out;
  }

  /* ── Sincronización ── */

  private providerHttp(e: unknown) {
    if (e instanceof AdsProviderError) return new BadRequestException(e.message);
    return e instanceof Error ? e : new BadRequestException('Error con la plataforma');
  }

  /**
   * Sincroniza una cuenta. Garantías:
   *  - Una sola a la vez por cuenta (candado compare-and-set en AdAccount).
   *  - Nunca borra: guarda lo que llega y actualiza lo que cambió.
   *  - Las métricas se piden por tramos; si un tramo falla, lo anterior queda
   *    guardado y la corrida queda PARTIAL (sin mover lastSyncAt, así el
   *    siguiente intento vuelve a cubrir el hueco).
   *  - Errores tipados: vencida, permisos, límite, incompleta. Cada uno con su
   *    siguiente intento (ver sync-policy).
   */
  async sync(user: AuthUser | null, accountId: string, companyId: string, trigger: 'MANUAL' | 'CRON' = 'MANUAL') {
    const a = await this.accountOf(companyId, accountId);
    if (a.status === 'DISCONNECTED') throw new BadRequestException('La cuenta está desconectada');
    const start = this.now();
    const locked = await this.prisma.adAccount.updateMany({
      where: { id: a.id, companyId, OR: [{ syncLockUntil: { isSet: false } }, { syncLockUntil: null }, { syncLockUntil: { lt: start } }] },
      data: { syncLockUntil: new Date(start.getTime() + SYNC_LOCK_MS) },
    });
    if (locked.count !== 1) throw new ConflictException('Ya hay una sincronización en curso para esta cuenta');
    const run = await this.prisma.adSyncRun.create({ data: { companyId, accountId: a.id, trigger, status: 'RUNNING', startedAt: start } });
    try {
      return await this.runSync(user, a, run.id, start);
    } finally {
      await this.prisma.adAccount.updateMany({ where: { id: a.id }, data: { syncLockUntil: null } });
    }
  }

  private async runSync(user: AuthUser | null, a: any, runId: string, start: Date) {
    const companyId = a.companyId as string;
    const p = this.provider(a.provider, a.mode);
    const until = a.mode === 'DEMO' ? addDays(isoDay(start), -1) : isoDay(start);
    const floor = addDays(isoDay(start), -(FIRST_SYNC_DAYS - 1));
    const wanted = a.lastSyncAt ? addDays(isoDay(new Date(a.lastSyncAt)), -RESYNC_DAYS) : floor;
    const since = wanted < floor ? floor : wanted;
    const counts = { entities: 0, insights: 0, since, until, chunksOk: 0, chunks: 0, warnings: [] as string[] };
    let failure: { kind: ProviderErrorKind; message: string } | null = null;
    let entitiesSaved = false;
    try {
      const token = this.token(a);
      counts.entities = await this.saveEntities(a, await p.fetchEntities(this.ref(a), token));
      entitiesSaved = true;
      const parts = chunks(since, until);
      counts.chunks = parts.length;
      for (const part of parts) {
        counts.insights += await this.saveInsights(a, await p.fetchInsights(this.ref(a), token, part.since, part.until));
        counts.chunksOk++;
      }
      // Alcance y frecuencia del periodo (no se pueden sumar día a día): opcional
      if (p.fetchPeriodStats) {
        try {
          await this.savePeriodStats(a, p, token, until);
        } catch (err: any) {
          counts.warnings.push(`Alcance y frecuencia no disponibles: ${String(err?.message ?? err).slice(0, 160)}`);
        }
      }
    } catch (err: any) {
      failure = {
        kind: err instanceof AdsProviderError ? err.kind : err instanceof BadRequestException ? 'AUTH' : 'PROVIDER',
        message: String(err?.message ?? err).slice(0, 300),
      };
    }
    const done = this.now();
    const partial = !!failure && entitiesSaved;
    const status = !failure ? 'OK' : partial ? 'PARTIAL' : 'ERROR';
    const failures = failure ? (a.syncFailures ?? 0) + 1 : 0;
    await this.prisma.adSyncRun.update({
      where: { id: runId },
      data: { status, countsJson: JSON.stringify(counts), error: failure?.message ?? null, errorKind: failure?.kind ?? null, finishedAt: done },
    });
    await this.prisma.adAccount.update({
      where: { id: a.id },
      data: {
        // Solo una corrida completa mueve la marca: así el siguiente intento cubre lo que faltó
        ...(failure ? {} : { lastSyncAt: done }),
        lastSyncStatus: status, lastError: failure?.message ?? null, lastErrorKind: failure?.kind ?? null,
        syncFailures: failures, nextSyncAt: nextAttempt(failure?.kind ?? null, failures, done),
        status: accountStatusAfter(failure?.kind ?? null, a.status),
      },
    });
    if (!failure) {
      // Los hallazgos solo se recalculan con datos completos
      await this.runAudit(companyId).catch((err) => this.logger.warn(`auditoría ${companyId}: ${err.message}`));
      return { ok: true, status, entities: counts.entities, insights: counts.insights, warnings: counts.warnings };
    }
    if (user) await this.audit.log({ actor: user, companyId, action: 'ads.sync.error', entity: 'AdAccount', entityId: a.id, detail: `${failure.kind}: ${failure.message}` });
    if (partial) {
      return {
        ok: false, status, entities: counts.entities, insights: counts.insights, warnings: counts.warnings,
        error: failure.message, errorKind: failure.kind, help: KIND_LABEL[failure.kind] ?? null,
        note: `Se guardaron los elementos y ${counts.chunksOk} de ${counts.chunks} tramos de métricas. Lo anterior no se borró; el resto se reintenta.`,
      };
    }
    throw new BadRequestException(failure.message);
  }

  /** Guarda alcance y frecuencia de 7 y 30 días tal como los reporta la plataforma. */
  private async savePeriodStats(a: any, p: AdsProvider, token: string, until: string) {
    const windows = [7, 30].map((d) => periods(until, d).current);
    const results: Array<{ w: { since: string; until: string }; stats: PeriodStats }> = [];
    for (const w of windows) results.push({ w, stats: await p.fetchPeriodStats!(this.ref(a), token, w.since, w.until) });
    const merge = (json: string | null | undefined, add: Array<{ since: string; until: string; reach: number; impressions: number; frequency: number | null }>) => {
      const old = parseJson<any[]>(json, []).filter((x) => !add.some((n) => n.since === x.since && n.until === x.until));
      return JSON.stringify([...add, ...old].slice(0, PERIOD_STATS_KEEP));
    };
    const acct = results.filter((r) => r.stats.account).map((r) => ({ since: r.w.since, until: r.w.until, ...r.stats.account! }));
    if (acct.length) await this.prisma.adAccount.update({ where: { id: a.id }, data: { periodStatsJson: merge(a.periodStatsJson, acct) } });
    const camps = await this.prisma.adEntity.findMany({ where: { companyId: a.companyId, accountId: a.id, level: 'CAMPAIGN' } });
    for (const c of camps) {
      const add = results.flatMap((r) => r.stats.campaigns.filter((x) => x.externalId === c.externalId).map((x) => ({ since: r.w.since, until: r.w.until, reach: x.reach, impressions: x.impressions, frequency: x.frequency })));
      if (add.length) await this.prisma.adEntity.update({ where: { id: c.id }, data: { periodStatsJson: merge(c.periodStatsJson, add) } });
    }
  }

  /** Inserta filas nuevas con _id determinista. Si otra corrida ya insertó alguna, se omite (no se duplica). */
  private async insertIdempotent(model: 'adEntity' | 'adInsightDaily', rows: any[]) {
    let inserted = 0;
    for (let k = 0; k < rows.length; k += 1000) {
      const batch = rows.slice(k, k + 1000);
      try {
        inserted += (await (this.prisma as any)[model].createMany({ data: batch })).count;
      } catch (err: any) {
        if (!isDup(err)) throw err;
        // Lote con filas ya existentes (escritura concurrente): fila por fila
        for (const row of batch) {
          if (await (this.prisma as any)[model].findUnique({ where: { id: row.id } })) continue;
          try {
            await (this.prisma as any)[model].create({ data: row });
            inserted++;
          } catch (e: any) {
            if (!isDup(e)) throw e;
          }
        }
      }
    }
    return inserted;
  }

  /** Guarda en lote: una consulta para leer lo que hay, inserción idempotente de lo nuevo y update solo de lo que cambió. */
  private async saveEntities(a: { id: string; companyId: string; provider: string; mode: string }, entities: RemoteEntity[]) {
    const existing = await this.prisma.adEntity.findMany({ where: { companyId: a.companyId, accountId: a.id } });
    const byKey = new Map(existing.map((x) => [`${x.level}:${x.externalId}`, x]));
    const now = this.now();
    const fresh: any[] = [];
    let changed = 0;
    for (const x of entities) {
      const data = {
        campaignExternalId: x.campaignExternalId, adsetExternalId: x.adsetExternalId, name: x.name, status: x.status, effectiveStatus: x.effectiveStatus,
        objective: x.objective, dailyBudget: x.dailyBudget, lifetimeBudget: x.lifetimeBudget, issuesJson: JSON.stringify(x.issues),
        rawJson: JSON.stringify(x.raw).slice(0, 20000), providerUpdatedAt: x.providerUpdatedAt ? new Date(x.providerUpdatedAt) : null,
      };
      const key = `${x.level}:${x.externalId}`;
      const old = byKey.get(key);
      if (!old) {
        byKey.set(key, { id: 'pending' } as any); // la plataforma repitió un elemento en la misma respuesta
        fresh.push({ id: adEntityId(a.id, x.level, x.externalId), companyId: a.companyId, accountId: a.id, provider: a.provider, mode: a.mode, level: x.level, externalId: x.externalId, ...data, syncedAt: now });
        continue;
      }
      if (old.id === 'pending') continue;
      const differs = (Object.keys(data) as Array<keyof typeof data>).some((k) => {
        const v1 = data[k] instanceof Date ? (data[k] as Date).getTime() : data[k] ?? null;
        const v0 = (old as any)[k] instanceof Date ? (old as any)[k].getTime() : (old as any)[k] ?? null;
        return v1 !== v0;
      });
      if (differs) {
        await this.prisma.adEntity.update({ where: { id: old.id }, data: { ...data, syncedAt: now } });
        changed++;
      }
    }
    return (await this.insertIdempotent('adEntity', fresh)) + changed;
  }

  private async saveInsights(a: { id: string; companyId: string; mode: string; currency: string }, rows: RemoteInsight[]) {
    if (!rows.length) return 0;
    const dates = rows.map((r) => r.date).sort();
    const existing = await this.prisma.adInsightDaily.findMany({ where: { companyId: a.companyId, accountId: a.id, date: { gte: dates[0], lte: dates[dates.length - 1] } } });
    const byKey = new Map(existing.map((x) => [`${x.level}:${x.externalId}:${x.date}`, x]));
    const now = this.now();
    const fresh = new Map<string, any>();
    let changed = 0;
    const NUMS = ['spend', 'impressions', 'reach', 'clicks', 'linkClicks', 'leads', 'conversations', 'purchases', 'purchaseValue'] as const;
    for (const r of rows) {
      const data = {
        campaignExternalId: r.campaignExternalId, currency: a.currency, spend: r.spend, impressions: r.impressions, reach: r.reach, clicks: r.clicks,
        linkClicks: r.linkClicks, leads: r.leads, conversations: r.conversations, purchases: r.purchases, purchaseValue: r.purchaseValue,
        rawJson: JSON.stringify(r.raw).slice(0, 8000),
      };
      const key = `${r.level}:${r.externalId}:${r.date}`;
      const old = byKey.get(key);
      if (!old) {
        // Si la plataforma repite una fila, gana la última
        fresh.set(key, { id: adInsightId(a.id, r.level, r.externalId, r.date), companyId: a.companyId, accountId: a.id, mode: a.mode, level: r.level, externalId: r.externalId, date: r.date, ...data, syncedAt: now });
      } else if (NUMS.some((k) => Number((old as any)[k]) !== Number(data[k]))) {
        // La atribución sigue moviendo los números unos días: se actualiza solo lo que cambió
        await this.prisma.adInsightDaily.update({ where: { id: old.id }, data: { ...data, syncedAt: now } });
        changed++;
      }
    }
    return (await this.insertIdempotent('adInsightDaily', [...fresh.values()])) + changed;
  }

  /** Últimas corridas de sincronización de una cuenta (para ver errores y tramos). */
  async syncRuns(user: AuthUser, accountId: string, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const a = await this.accountOf(c.id, accountId);
    const rows = await this.prisma.adSyncRun.findMany({ where: { companyId: c.id, accountId: a.id }, orderBy: { startedAt: 'desc' }, take: 10 });
    return rows.map((r) => ({ ...r, counts: parseJson(r.countsJson, {}), help: r.errorKind ? KIND_LABEL[r.errorKind] ?? null : null }));
  }

  async syncNow(user: AuthUser, accountId: string, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    return this.sync(user, accountId, c.id);
  }

  /* ── Datos para pantallas ── */

  private async data(companyId: string, mode: 'REAL' | 'DEMO', accountId?: string) {
    const accounts = await this.prisma.adAccount.findMany({ where: { companyId, mode, ...(accountId ? { id: accountId } : {}) } });
    const ids = accounts.map((a) => a.id);
    const since = addDays(isoDay(this.now()), -120);
    const [entities, rows] = await Promise.all([
      this.prisma.adEntity.findMany({ where: { companyId, accountId: { in: ids } } }),
      this.prisma.adInsightDaily.findMany({ where: { companyId, accountId: { in: ids }, date: { gte: since } } }),
    ]);
    return { accounts, entities, rows };
  }

  /** Modo que se muestra: REAL si hay cuentas reales; si solo hay demo, DEMO. Nunca mezclados. */
  private async modeFor(companyId: string, requested?: string): Promise<'REAL' | 'DEMO'> {
    if (requested === 'DEMO' || requested === 'REAL') return requested;
    const real = await this.prisma.adAccount.count({ where: { companyId, mode: 'REAL' } });
    return real ? 'REAL' : 'DEMO';
  }

  private lastDay(rows: Array<{ date: string }>) {
    return rows.reduce((m, r) => (r.date > m ? r.date : m), '') || addDays(isoDay(this.now()), -1);
  }

  /** Tipo de resultado de cada campaña según su objetivo (lo que se cuenta como "resultado"). */
  private typeOfFn(entities: Array<{ level: string; externalId: string; objective: string | null }>) {
    const map = new Map(entities.filter((e) => e.level === 'CAMPAIGN').map((e) => [e.externalId, resultTypeFor(e.objective)]));
    return (campaign: string | null | undefined): ResultType => (campaign ? map.get(campaign) ?? 'reported' : 'reported');
  }

  /** Serie diaria: gasto siempre; resultados solo si el periodo no mezcla tipos. */
  private dailySeries(rows: any[], p: { since: string; until: string }, typeOf: (c: string | null | undefined) => ResultType, mixed: boolean) {
    const byDay = groupBy(rows, (r: any) => r.date);
    const out: Array<{ date: string; spend: number; results: number; clicks: number; impressions: number }> = [];
    for (let d = p.since; d <= p.until; d = addDays(d, 1)) {
      const list = byDay.get(d) ?? [];
      const t = totals(list);
      const results = mixed ? 0 : [...groupBy(list, (r: any) => r.campaignExternalId ?? '__none__')]
        .reduce((sum, [c, l]) => sum + (resultsOf(totals(l), typeOf(c === '__none__' ? null : c)) ?? 0), 0);
      out.push({ date: d, spend: t.spend, results, clicks: t.clicks, impressions: t.impressions });
    }
    return out;
  }

  async overview(user: AuthUser, q: { companyId?: string; days?: string; accountId?: string; mode?: string; campaign?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const mode = await this.modeFor(c.id, q.mode);
    const days = [7, 14, 30, 60].includes(Number(q.days)) ? Number(q.days) : 30;
    const { accounts, entities, rows: all } = await this.data(c.id, mode, q.accountId);
    const rows = q.campaign ? all.filter((r) => r.campaignExternalId === q.campaign) : all;
    const until = this.lastDay(rows);
    const p = periods(until, days);
    const typeOf = this.typeOfFn(entities);
    const now = mixedTotals(rows.filter((r) => inRange(r.date, p.current)), typeOf);
    const before = mixedTotals(rows.filter((r) => inRange(r.date, p.previous)), typeOf);
    const cmp = comparable(now, before);
    const byCampaign = groupBy(rows.filter((r) => inRange(r.date, p.current)), (r) => r.campaignExternalId);
    const campaigns = entities.filter((e) => e.level === 'CAMPAIGN').map((e) => {
      const type = resultTypeFor(e.objective);
      const stat = periodStatFor(e.periodStatsJson, p.current);
      return {
        id: e.id, externalId: e.externalId, name: e.name, status: e.effectiveStatus ?? e.status, objective: e.objective, dailyBudget: e.dailyBudget,
        accountId: e.accountId, ...typedTotals(byCampaign.get(e.externalId) ?? [], type), resultLabel: RESULT_LABEL[type],
        reach: stat?.reach ?? null, frequency: stat?.frequency ?? null,
      };
    }).sort((a, b) => b.spend - a.spend);
    const currencies = [...new Set(accounts.map((a) => a.currency))];
    // Alcance: personas únicas. Solo una cuenta (o una campaña) y para el periodo exacto que reportó la plataforma
    const reachStat = q.campaign
      ? periodStatFor(entities.find((e) => e.level === 'CAMPAIGN' && e.externalId === q.campaign)?.periodStatsJson, p.current)
      : accounts.length === 1 ? periodStatFor(accounts[0].periodStatsJson, p.current) : null;
    const notes: string[] = [];
    if (now.resultNote) notes.push(now.resultNote);
    if (!reachStat) {
      notes.push(accounts.length > 1 && !q.campaign
        ? 'Alcance y frecuencia: con varias cuentas no se pueden sumar (una persona puede estar en más de una). Filtra por cuenta.'
        : 'Alcance y frecuencia: la plataforma los reporta para 7 y 30 días terminando en el último día sincronizado; para este periodo no están disponibles.');
    }
    if (!cmp.ok && cmp.reason) notes.push(`Variaciones: ${cmp.reason}`);
    const [openFindings, pendingActions, executed] = await Promise.all([
      this.prisma.opportunity.count({ where: { companyId: c.id, source: 'ADS', mode, status: { in: OPEN } } }),
      this.prisma.adActionLog.count({ where: { companyId: c.id, mode, status: 'PROPOSED' } }),
      this.prisma.adActionLog.count({ where: { companyId: c.id, mode, status: 'EXECUTED', createdAt: { gte: new Date(Date.parse(`${p.current.since}T00:00:00Z`)) } } }),
    ]);
    const realCount = await this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'REAL' } });
    const demoCount = await this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'DEMO' } });
    const d = (a: number | null, b: number | null) => (cmp.ok ? delta(a, b) : null);
    return {
      mode, modes: { real: realCount, demo: demoCount }, days, period: p, currency: currencies.length === 1 ? currencies[0] : null,
      mixedCurrencies: currencies.length > 1,
      accounts: accounts.map((a) => this.view(a)),
      totals: { ...now, reach: reachStat?.reach ?? null, frequency: reachStat?.frequency ?? null }, previous: before,
      deltas: {
        spend: d(now.spend, before.spend),
        // Resultados solo se comparan si ambos periodos miden el mismo tipo
        results: now.resultType && now.resultType === before.resultType ? d(now.results, before.results) : null,
        costPerResult: now.resultType && now.resultType === before.resultType ? d(now.costPerResult, before.costPerResult) : null,
        ctr: d(now.ctr, before.ctr), cpc: d(now.cpc, before.cpc), cpm: d(now.cpm, before.cpm),
      },
      comparable: cmp.ok,
      insufficient: now.days < Math.min(days, 7) || !cmp.ok,
      notes,
      daily: this.dailySeries(rows, p.current, typeOf, now.resultTypes.length > 1),
      resultLabel: now.resultType ? RESULT_LABEL[now.resultType] : null,
      campaigns,
      configuredDailyBudget: campaigns.filter((x) => x.status === 'ACTIVE').reduce((s, x) => s + (x.dailyBudget ?? 0), 0),
      openFindings, pendingActions, executedActions: executed,
    };
  }

  async campaignTree(user: AuthUser, q: { companyId?: string; days?: string; mode?: string; accountId?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const mode = await this.modeFor(c.id, q.mode);
    const days = [7, 14, 30, 60].includes(Number(q.days)) ? Number(q.days) : 30;
    const { entities, rows } = await this.data(c.id, mode, q.accountId);
    const p = periods(this.lastDay(rows), days).current;
    const cur = rows.filter((r) => inRange(r.date, p));
    const byAd = groupBy(cur, (r) => r.externalId);
    const typeOf = this.typeOfFn(entities);
    const metricsFor = (e: any) => {
      const type = typeOf(e.level === 'CAMPAIGN' ? e.externalId : e.campaignExternalId);
      const list = e.level === 'AD' ? byAd.get(e.externalId) ?? []
        : e.level === 'ADSET' ? entities.filter((x) => x.level === 'AD' && x.adsetExternalId === e.externalId).flatMap((x) => byAd.get(x.externalId) ?? [])
          : cur.filter((r) => r.campaignExternalId === e.externalId);
      const stat = e.level === 'CAMPAIGN' ? periodStatFor(e.periodStatsJson, p) : null;
      return { ...typedTotals(list, type), resultLabel: RESULT_LABEL[type], reach: stat?.reach ?? null, frequency: stat?.frequency ?? null };
    };
    const node = (e: any) => ({
      id: e.id, level: e.level, externalId: e.externalId, name: e.name, status: e.status, effectiveStatus: e.effectiveStatus, objective: e.objective,
      dailyBudget: e.dailyBudget, issues: parseJson<string[]>(e.issuesJson, []), syncedAt: e.syncedAt, metrics: metricsFor(e),
    });
    return {
      mode, period: p,
      campaigns: entities.filter((e) => e.level === 'CAMPAIGN').map((camp) => ({
        ...node(camp),
        adsets: entities.filter((s) => s.level === 'ADSET' && s.campaignExternalId === camp.externalId).map((s) => ({
          ...node(s),
          ads: entities.filter((a) => a.level === 'AD' && a.adsetExternalId === s.externalId).map(node),
        })),
      })),
    };
  }

  /* ── Auditoría / hallazgos ── */

  private async crmStats(companyId: string, conversations: number, window: { since: string; until: string }): Promise<CrmAdStats> {
    const cut = new Date(this.now().getTime() - 14 * 86400e3);
    // Conversaciones del CRM que llegaron con el dato de un anuncio en la misma ventana
    const crmAdConversations = await this.prisma.conversation.count({
      where: { companyId, originJson: { contains: '"AD"' }, createdAt: { gte: new Date(`${window.since}T00:00:00Z`), lt: new Date(`${addDays(window.until, 1)}T00:00:00Z`) } },
    });
    const contacts = await this.prisma.contact.findMany({ where: { companyId, originJson: { contains: '"AD"' }, createdAt: { lte: cut } }, select: { stage: true, originJson: true }, take: 5000 });
    const recentAd = await this.prisma.contact.count({ where: { companyId, originJson: { contains: '"AD"' }, createdAt: { gte: new Date(this.now().getTime() - 7 * 86400e3) } } });
    return {
      // Si hubo contactos de anuncios recientes, el seguimiento funciona aunque los viejos sean pocos
      adLeads: Math.max(contacts.length, recentAd),
      stuckInFirstStage: contacts.filter((x) => x.stage === DEFAULT_STAGES[0].key).length,
      platformConversations: conversations,
      crmAdConversations,
    };
  }

  async runAudit(companyId: string) {
    const out: Record<string, number> = {};
    for (const mode of ['REAL', 'DEMO'] as const) {
      const accounts = await this.prisma.adAccount.findMany({ where: { companyId, mode, status: { not: 'DISCONNECTED' } } });
      for (const a of accounts) {
        // Con datos incompletos no se juzga nada (ni se cierran hallazgos como "desaparecidos")
        if (a.lastSyncStatus === 'PARTIAL') continue;
        const [entities, rows] = await Promise.all([
          this.prisma.adEntity.findMany({ where: { companyId, accountId: a.id } }),
          this.prisma.adInsightDaily.findMany({ where: { companyId, accountId: a.id, date: { gte: addDays(isoDay(this.now()), -60) } } }),
        ]);
        if (!rows.length && !entities.length) continue;
        const until = this.lastDay(rows);
        const w7 = periods(until, 7).current;
        const conv7 = totals(rows.filter((r) => inRange(r.date, w7))).conversations;
        // Los datos del CRM solo se cruzan con cuentas reales
        const crm = mode === 'REAL' ? await this.crmStats(companyId, conv7, w7) : undefined;
        const drafts = audit(
          entities.map((e) => ({ ...e, issues: parseJson<string[]>(e.issuesJson, []) })),
          rows, { until, currency: a.currency, minSpend: 0, typeOf: this.typeOfFn(entities) }, crm,
        );
        const platform = mode === 'DEMO' ? 'Datos de demostración (simulados)' : `${a.provider === 'META' ? 'Meta Ads' : a.provider} (reportado por la plataforma)`;
        const opps: OppDraft[] = drafts.map((d) => ({
          ...d,
          sources: d.ruleKey.startsWith('LEAD_') ? [platform, 'CRM de BackOffice'] : [platform],
          action: d.ruleKey === 'LEAD_TRACKING'
            // Se arregla en la línea de WhatsApp, no en la campaña
            ? { ...d.action, type: 'LINK' as const, label: 'Revisar la línea de WhatsApp', href: '/app/integrations' }
            : { ...d.action, label: d.action.type === 'PAUSE' ? 'Pausar' : d.action.type === 'REVIEW' ? 'Revisar' : undefined, href: d.action.type === 'REVIEW' ? '/app/ads?tab=campanas' : undefined },
        }));
        await storeDetected(this.prisma, { companyId, source: 'ADS', mode, accountId: a.id, keyPrefix: a.id }, opps, this.now());
        out[a.id] = drafts.length;
      }
    }
    return out;
  }

  async auditNow(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    return this.runAudit(c.id);
  }

  /** Pausa el elemento de una oportunidad de anuncios (la confirmación la exige quien llama). */
  async pauseForOpportunity(actor: string, companyId: string, opp: { id: string; accountId: string | null; level: string | null; externalId: string | null }) {
    if (!opp.accountId || !opp.level || !opp.externalId) throw new BadRequestException('Esta oportunidad no tiene un elemento para pausar');
    const entity = await this.prisma.adEntity.findFirst({ where: { companyId, accountId: opp.accountId, level: opp.level, externalId: opp.externalId } });
    if (!entity) throw new NotFoundException('El elemento ya no existe en la cuenta');
    const since = addDays(isoDay(this.now()), -7);
    const rows = await this.prisma.adInsightDaily.findMany({ where: { companyId, accountId: opp.accountId, externalId: opp.externalId, date: { gte: since } } });
    const before = totals(rows);
    const res = await this.changeStatus(actor, companyId, entity, 'PAUSED', { source: 'FINDING', findingId: opp.id, key: `opportunity:${opp.id}` });
    return { ...res, baseline: { dailySpend: before.days ? before.spend / before.days : 0, since } };
  }

  /** Métricas de un elemento desde una fecha (para observar resultados). */
  async metricsSince(companyId: string, accountId: string, level: string, externalId: string, since: string) {
    const where: any = { companyId, accountId, date: { gte: since } };
    if (level === 'CAMPAIGN') where.campaignExternalId = externalId;
    else if (level === 'AD') where.externalId = externalId;
    const rows = await this.prisma.adInsightDaily.findMany({ where });
    const entity = await this.prisma.adEntity.findFirst({ where: { companyId, accountId, externalId } });
    return { totals: totals(rows), effectiveStatus: entity?.effectiveStatus ?? null };
  }

  /* ── Acciones sobre campañas (auditables) ── */

  /**
   * Cambia el estado de un elemento en la plataforma. Antes de llamar verifica
   * que la empresa, la cuenta (conectada y con credencial) y el elemento sigan
   * siendo válidos. Una clave de idempotencia = un registro (con _id derivado)
   * y una sola ejecución en curso (compare-and-set PROPOSED/FAILED → RUNNING).
   * El resultado lo confirma la plataforma: si falla, queda FAILED con el error.
   */
  private async changeStatus(actor: string, companyId: string, entity: any, status: 'ACTIVE' | 'PAUSED', meta: { source: 'USER' | 'RULE' | 'FINDING'; ruleId?: string; findingId?: string; key: string; data?: unknown }) {
    if (entity.companyId !== companyId) throw new ForbiddenException('El elemento no es de tu empresa');
    const a = await this.accountOf(companyId, entity.accountId);
    let log = await this.prisma.adActionLog.findUnique({ where: { idempotencyKey: meta.key } });
    if (log && log.companyId !== companyId) throw new ForbiddenException('El elemento no es de tu empresa');
    if (log && (log.status === 'EXECUTED' || log.status === 'SKIPPED')) return { ok: true, duplicate: true, logId: log.id, status: log.status };
    const before = { status: entity.status, effectiveStatus: entity.effectiveStatus };
    if (!log) {
      try {
        log = await this.prisma.adActionLog.create({
          data: {
            id: adActionId(meta.key), companyId, accountId: a.id, mode: a.mode, source: meta.source, ruleId: meta.ruleId ?? null, findingId: meta.findingId ?? null, idempotencyKey: meta.key,
            level: entity.level, externalId: entity.externalId, entityName: entity.name, action: status === 'PAUSED' ? 'PAUSE' : 'RESUME', status: 'PROPOSED',
            dataJson: JSON.stringify(meta.data ?? {}), beforeJson: JSON.stringify(before), reversible: true, actor,
          },
        });
      } catch (err: any) {
        if (!isDup(err)) throw err;
        log = await this.prisma.adActionLog.findUniqueOrThrow({ where: { id: adActionId(meta.key) } });
      }
    }
    // Una sola ejecución a la vez para esta clave
    const claim = await this.prisma.adActionLog.updateMany({ where: { id: log!.id, status: { in: ['PROPOSED', 'FAILED'] } }, data: { status: 'RUNNING', actor } });
    if (claim.count !== 1) throw new ConflictException('Esta acción ya se está ejecutando o ya se ejecutó');
    const fail = async (msg: string, kind?: string) => {
      await this.prisma.adActionLog.update({ where: { id: log!.id }, data: { status: 'FAILED', error: msg.slice(0, 300), decidedAt: this.now() } });
      if (kind === 'AUTH') await this.prisma.adAccount.update({ where: { id: a.id }, data: { status: 'EXPIRED', lastError: msg, lastErrorKind: 'AUTH' } });
    };
    // Verificaciones previas: nada se intenta con una conexión que no sirve
    if (a.mode !== 'DEMO' && (a.status !== 'CONNECTED' || !a.tokenEnc)) {
      const msg = a.status === 'EXPIRED' ? 'La conexión con la plataforma venció: vuelve a conectar la cuenta.' : 'La cuenta no está conectada: no se ejecutó nada.';
      await fail(msg);
      throw new BadRequestException(msg);
    }
    const current = await this.prisma.adEntity.findFirst({ where: { companyId, accountId: a.id, level: entity.level, externalId: entity.externalId } });
    if (!current) {
      await fail('El elemento ya no existe en la cuenta sincronizada');
      throw new NotFoundException('El elemento ya no existe en la cuenta sincronizada');
    }
    if (current.status === status) {
      // Ya estaba así: no se llama a la plataforma ni se marca como ejecutado por BackOffice
      await this.prisma.adActionLog.update({ where: { id: log!.id }, data: { status: 'SKIPPED', error: status === 'PAUSED' ? 'Ya estaba en pausa en la plataforma' : 'Ya estaba activo en la plataforma', decidedAt: this.now() } });
      return { ok: true, skipped: true, logId: log!.id, status: 'SKIPPED' };
    }
    try {
      const response = await this.provider(a.provider, a.mode).setStatus(this.ref(a), this.token(a), entity.level as AdLevel, entity.externalId, status);
      if ((response as any)?.success === false) throw new AdsProviderError('PROVIDER', 'La plataforma no confirmó el cambio');
      await this.prisma.adEntity.update({ where: { id: current.id }, data: { status, effectiveStatus: status === 'PAUSED' ? 'PAUSED' : current.effectiveStatus === 'PAUSED' ? 'ACTIVE' : current.effectiveStatus } });
      await this.prisma.adActionLog.update({ where: { id: log!.id }, data: { status: 'EXECUTED', error: null, afterJson: JSON.stringify({ status }), providerResponse: JSON.stringify(response).slice(0, 2000), decidedAt: this.now(), actor } });
      return { ok: true, logId: log!.id, demo: a.mode === 'DEMO', status: 'EXECUTED' };
    } catch (err: any) {
      await fail(String(err?.message ?? err), err instanceof AdsProviderError ? err.kind : undefined);
      throw this.providerHttp(err);
    }
  }

  async setEntityStatus(user: AuthUser, entityId: string, dto: { status?: string; confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const e = await this.prisma.adEntity.findUnique({ where: { id: entityId } });
    if (!e || e.companyId !== c.id) throw new NotFoundException('Elemento no encontrado');
    const status = dto?.status === 'ACTIVE' ? 'ACTIVE' : dto?.status === 'PAUSED' ? 'PAUSED' : null;
    if (!status) throw new BadRequestException('Estado inválido');
    // Reanudar vuelve a gastar dinero: siempre con confirmación explícita
    if (dto?.confirm !== true) throw new BadRequestException(status === 'ACTIVE' ? 'Reanudar gasta presupuesto: confirma la acción' : 'Confirma la acción');
    await this.audit.log({ actor: user, companyId: c.id, action: `ads.${status === 'PAUSED' ? 'pause' : 'resume'}`, entity: 'AdEntity', entityId: e.id, detail: e.name });
    // Doble clic dentro de 30 s = la misma acción
    return this.changeStatus(user.name, c.id, e, status, { source: 'USER', key: `user:${e.id}:${status}:${Math.floor(this.now().getTime() / 30e3)}` });
  }

  async actions(user: AuthUser, q: { companyId?: string; status?: string; mode?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const mode = await this.modeFor(c.id, q.mode);
    const rows = await this.prisma.adActionLog.findMany({ where: { companyId: c.id, mode, ...(q.status ? { status: String(q.status) } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return rows.map((r) => {
      const data = parseJson<any>(r.dataJson, {});
      const execution = data.executionLogId ? byId.get(data.executionLogId) : null;
      return {
        ...r, data, before: parseJson(r.beforeJson, null), after: parseJson(r.afterJson, null), providerResponse: undefined,
        // Ciclo completo: sugerida → aprobada (quién) → ejecutada / falló (lo que confirmó la plataforma)
        kind: ['ALERT'].includes(r.action) ? 'INFO' : r.action === 'RECOMMEND_PAUSE' ? 'SUGGESTION' : 'EXECUTION',
        execution: execution ? { id: execution.id, status: execution.status, error: execution.error, decidedAt: execution.decidedAt } : null,
        retryable: r.status === 'FAILED' && (r.action === 'PAUSE' || r.action === 'RESUME'),
      };
    });
  }

  /**
   * Aprobar o rechazar una propuesta. La propuesta pasa a APPROVED/REJECTED con
   * compare-and-set (dos personas a la vez no aprueban dos veces) y la
   * ejecución queda en su propio registro, enlazado.
   */
  async decideAction(user: AuthUser, id: string, dto: { decision?: string; confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const log = await this.prisma.adActionLog.findUnique({ where: { id } });
    if (!log || log.companyId !== c.id) throw new NotFoundException('Acción no encontrada');
    if (log.status !== 'PROPOSED') throw new ConflictException('Esta acción ya se decidió');
    if (dto?.decision === 'REJECT') {
      const r = await this.prisma.adActionLog.updateMany({ where: { id, companyId: c.id, status: 'PROPOSED' }, data: { status: 'REJECTED', actor: user.name, decidedAt: this.now() } });
      if (r.count !== 1) throw new ConflictException('Esta acción ya se decidió');
      await this.audit.log({ actor: user, companyId: c.id, action: 'ads.action.reject', entity: 'AdActionLog', entityId: id, detail: log.entityName ?? log.externalId });
      return { ok: true, status: 'REJECTED' };
    }
    if (dto?.decision !== 'APPROVE' || dto?.confirm !== true) throw new BadRequestException('Confirma la acción');
    if (log.action !== 'RECOMMEND_PAUSE' && log.action !== 'PAUSE') throw new BadRequestException('Acción no ejecutable');
    const e = await this.prisma.adEntity.findFirst({ where: { companyId: c.id, accountId: log.accountId, level: log.level, externalId: log.externalId } });
    if (!e) throw new NotFoundException('El elemento ya no existe');
    const key = `approved:${log.id}`;
    const approved = await this.prisma.adActionLog.updateMany({
      where: { id, companyId: c.id, status: 'PROPOSED' },
      data: { status: 'APPROVED', approvedBy: user.name, approvedAt: this.now(), dataJson: JSON.stringify({ ...parseJson(log.dataJson, {}), executionLogId: adActionId(key) }) },
    });
    if (approved.count !== 1) throw new ConflictException('Esta acción ya se decidió');
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.action.approve', entity: 'AdActionLog', entityId: id, detail: `Pausar ${log.entityName ?? log.externalId}` });
    return this.changeStatus(user.name, c.id, e, 'PAUSED', { source: 'RULE', ruleId: log.ruleId ?? undefined, key, data: { approvedFrom: log.id, approvedBy: user.name } });
  }

  /** Reintenta una ejecución que falló, con la MISMA clave: nunca se duplica. Reanudar exige confirmación. */
  async retryAction(user: AuthUser, id: string, dto: { confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const log = await this.prisma.adActionLog.findUnique({ where: { id } });
    if (!log || log.companyId !== c.id) throw new NotFoundException('Acción no encontrada');
    if (log.status !== 'FAILED' || (log.action !== 'PAUSE' && log.action !== 'RESUME')) throw new BadRequestException('Solo se reintenta una pausa o reanudación que falló');
    if (log.action === 'RESUME' && dto?.confirm !== true) throw new BadRequestException('Reanudar gasta presupuesto: confirma la acción');
    const e = await this.prisma.adEntity.findFirst({ where: { companyId: c.id, accountId: log.accountId, level: log.level, externalId: log.externalId } });
    if (!e) throw new NotFoundException('El elemento ya no existe');
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.action.retry', entity: 'AdActionLog', entityId: id, detail: log.entityName ?? log.externalId });
    return this.changeStatus(user.name, c.id, e, log.action === 'PAUSE' ? 'PAUSED' : 'ACTIVE', { source: log.source as any, ruleId: log.ruleId ?? undefined, key: log.idempotencyKey });
  }

  async revertAction(user: AuthUser, id: string, dto: { confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const log = await this.prisma.adActionLog.findUnique({ where: { id } });
    if (!log || log.companyId !== c.id) throw new NotFoundException('Acción no encontrada');
    if (log.status !== 'EXECUTED' || !log.reversible || log.action !== 'PAUSE') throw new BadRequestException('Esta acción no se puede revertir desde aquí');
    if (dto?.confirm !== true) throw new BadRequestException('Revertir reanuda el gasto: confirma la acción');
    const e = await this.prisma.adEntity.findFirst({ where: { companyId: c.id, accountId: log.accountId, level: log.level, externalId: log.externalId } });
    if (!e) throw new NotFoundException('El elemento ya no existe');
    return this.changeStatus(user.name, c.id, e, 'ACTIVE', { source: 'USER', key: `revert:${log.id}`, data: { revertOf: log.id } });
  }

  /* ── Ajustes y Autopilot ── */

  async settings(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const s = await this.prisma.adSettings.findUnique({ where: { companyId: c.id } });
    return {
      autonomy: (s?.autonomy ?? 'ANALYSIS') as Autonomy, globalPause: s?.globalPause ?? false, autoActions: parseJson<string[]>(s?.autoActionsJson, []),
      maxDailyBudget: s?.maxDailyBudget ?? null, maxDataAgeHours: s?.maxDataAgeHours ?? 6, updatedBy: s?.updatedBy ?? null, updatedAt: s?.updatedAt ?? null,
    };
  }

  async saveSettings(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const autonomy = ['ANALYSIS', 'RECOMMEND', 'AUTHORIZED'].includes(dto?.autonomy) ? dto.autonomy : 'ANALYSIS';
    const autoActions = (Array.isArray(dto?.autoActions) ? dto.autoActions : []).filter((x: string) => x === 'PAUSE');
    const max = dto?.maxDailyBudget === null || dto?.maxDailyBudget === '' || dto?.maxDailyBudget === undefined ? null : Number(dto.maxDailyBudget);
    if (max !== null && (!Number.isFinite(max) || max <= 0)) throw new BadRequestException('El tope diario debe ser mayor a 0');
    const age = Number(dto?.maxDataAgeHours ?? 6);
    const data = {
      autonomy, globalPause: dto?.globalPause === true, autoActionsJson: JSON.stringify(autoActions), maxDailyBudget: max,
      maxDataAgeHours: Number.isInteger(age) && age >= 1 && age <= 48 ? age : 6, updatedBy: user.name, updatedAt: this.now(),
    };
    await this.prisma.adSettings.upsert({ where: { companyId: c.id }, update: data, create: { companyId: c.id, ...data } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.settings', entity: 'AdSettings', entityId: c.id, detail: `${autonomy}${data.globalPause ? ' · pausa global' : ''}` });
    return this.settings(user, c.id);
  }

  async rules(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const rows = await this.prisma.adRule.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'asc' } });
    return { rules: rows, metrics: METRICS };
  }

  private ruleData(dto: any) {
    const r = {
      name: clip(dto?.name, 80), metric: dto?.metric, level: dto?.level ?? 'CAMPAIGN', windowDays: Number(dto?.windowDays), operator: dto?.operator ?? 'GT',
      threshold: Number(dto?.threshold), minSpend: Number(dto?.minSpend ?? 0), action: dto?.action ?? 'ALERT',
    };
    const err = validateRule(r as any);
    if (err) throw new BadRequestException(err);
    const freq = Number(dto?.checkEveryMin ?? 60);
    return { ...r, risk: r.action === 'PAUSE' ? 'MEDIUM' : 'LOW', active: dto?.active !== false, checkEveryMin: [30, 60, 180, 360, 1440].includes(freq) ? freq : 60 };
  }

  async createRule(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    if ((await this.prisma.adRule.count({ where: { companyId: c.id } })) >= 30) throw new BadRequestException('Máximo 30 reglas por empresa');
    const rule = await this.prisma.adRule.create({ data: { companyId: c.id, ...this.ruleData(dto), createdBy: user.name } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.rule.create', entity: 'AdRule', entityId: rule.id, detail: rule.name });
    return rule;
  }

  async updateRule(user: AuthUser, id: string, dto: any, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const r = await this.prisma.adRule.findUnique({ where: { id } });
    if (!r || r.companyId !== c.id) throw new NotFoundException('Regla no encontrada');
    const rule = await this.prisma.adRule.update({ where: { id }, data: this.ruleData({ ...r, ...dto }) });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.rule.update', entity: 'AdRule', entityId: id, detail: rule.name });
    return rule;
  }

  async deleteRule(user: AuthUser, id: string, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const r = await this.prisma.adRule.findUnique({ where: { id } });
    if (!r || r.companyId !== c.id) throw new NotFoundException('Regla no encontrada');
    await this.prisma.adRule.delete({ where: { id } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.rule.delete', entity: 'AdRule', entityId: id, detail: r.name });
    return { ok: true };
  }

  /** Prueba en seco: qué elementos cumplen hoy la regla (no ejecuta nada). */
  async testRule(user: AuthUser, id: string, q: { companyId?: string; mode?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const r = await this.prisma.adRule.findUnique({ where: { id } });
    if (!r || r.companyId !== c.id) throw new NotFoundException('Regla no encontrada');
    const mode = await this.modeFor(c.id, q.mode);
    const { entities, rows } = await this.data(c.id, mode);
    return { mode, matches: evaluateRule(r as unknown as RuleLike, entities, rows, this.lastDay(rows), this.ruleCtx(entities)) };
  }

  private ruleCtx(entities: any[]) {
    return {
      typeOf: this.typeOfFn(entities),
      periodStat: (level: string, externalId: string, w: { since: string; until: string }) =>
        level === 'CAMPAIGN' ? periodStatFor(entities.find((e) => e.level === 'CAMPAIGN' && e.externalId === externalId)?.periodStatsJson, w) : null,
    };
  }

  /** Evalúa las reglas de una empresa y registra lo que corresponda. */
  async runRules(companyId: string, force = false) {
    const settings = await this.prisma.adSettings.findUnique({ where: { companyId } });
    const rules = await this.prisma.adRule.findMany({ where: { companyId, active: true } });
    const results: Array<{ rule: string; externalId: string; decision: string; reason: string }> = [];
    for (const rule of rules) {
      if (!force && rule.lastRunAt && this.now().getTime() - rule.lastRunAt.getTime() < rule.checkEveryMin * 60e3) continue;
      for (const mode of ['REAL', 'DEMO'] as const) {
        const { accounts, entities, rows } = await this.data(companyId, mode);
        if (!accounts.length) continue;
        const until = this.lastDay(rows);
        for (const m of evaluateRule(rule as unknown as RuleLike, entities, rows, until, this.ruleCtx(entities))) {
          const entity = entities.find((e) => e.level === rule.level && e.externalId === m.externalId)!;
          const account = accounts.find((a) => a.id === entity.accountId)!;
          const ageH = account.lastSyncAt ? (this.now().getTime() - account.lastSyncAt.getTime()) / 36e5 : null;
          const g = guardAutoAction({
            action: rule.action as any, autonomy: (settings?.autonomy ?? 'ANALYSIS') as Autonomy, autoActions: parseJson<string[]>(settings?.autoActionsJson, []),
            globalPause: settings?.globalPause ?? false, dataAgeHours: ageH, maxDataAgeHours: settings?.maxDataAgeHours ?? 6,
            entityActive: (entity.effectiveStatus ?? entity.status) === 'ACTIVE', sameCompany: entity.companyId === companyId && account.companyId === companyId,
            tokenValid: account.mode === 'DEMO' || (account.status === 'CONNECTED' && !!account.tokenEnc),
          });
          const key = ruleRunKey(rule.id, m.externalId, isoDay(this.now()));
          results.push({ rule: rule.name, externalId: m.externalId, decision: g.decision, reason: g.reason });
          if (g.decision === 'SKIP') continue;
          if (await this.prisma.adActionLog.findUnique({ where: { idempotencyKey: key } })) continue;
          if (g.decision === 'EXECUTE') {
            await this.changeStatus('Autopilot', companyId, entity, 'PAUSED', { source: 'RULE', ruleId: rule.id, key, data: { match: m, guard: g.reason } }).catch((err) => this.logger.warn(`regla ${rule.id}: ${err.message}`));
            continue;
          }
          await this.prisma.adActionLog.create({
            data: {
              id: adActionId(key), companyId, accountId: account.id, mode, source: 'RULE', ruleId: rule.id, idempotencyKey: key, level: entity.level, externalId: entity.externalId,
              entityName: entity.name, action: g.decision === 'ALERT' ? 'ALERT' : 'RECOMMEND_PAUSE', status: g.decision === 'ALERT' ? 'EXECUTED' : 'PROPOSED',
              dataJson: JSON.stringify({ match: m, guard: g.reason, rule: rule.name }), reversible: false, actor: 'Autopilot',
            },
          }).catch((err: any) => {
            // Dos evaluaciones simultáneas: la propuesta del día ya existe
            if (!isDup(err)) throw err;
          });
        }
      }
      await this.prisma.adRule.update({ where: { id: rule.id }, data: { lastRunAt: this.now() } });
    }
    return results;
  }

  async runRulesNow(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    return this.runRules(c.id, true);
  }

  /* ── Revenue Intelligence ── */

  async revenue(user: AuthUser, q: { companyId?: string; days?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const days = [30, 60, 90].includes(Number(q.days)) ? Number(q.days) : 30;
    // Solo cuentas REALES: el CRM real nunca se cruza con datos de demostración
    const { accounts, entities, rows } = await this.data(c.id, 'REAL');
    // El CRM está al día: el periodo termina hoy (no en el último día con datos de anuncios)
    const p = periods(isoDay(this.now()), days).current;
    const since = new Date(`${p.since}T00:00:00Z`);
    const end = new Date(`${addDays(p.until, 1)}T00:00:00Z`);
    const [contacts, orders, pipelines, allSales] = await Promise.all([
      this.prisma.contact.findMany({ where: { companyId: c.id, originJson: { contains: '"AD"' }, createdAt: { gte: since, lt: end } }, select: { id: true, stage: true, createdAt: true, originJson: true }, take: 10000 }),
      this.prisma.order.findMany({ where: { companyId: c.id, ...NOT_DELETED, contactId: { not: null }, createdAt: { gte: since } }, select: { contactId: true, total: true, paymentStatus: true, status: true, createdAt: true }, take: 20000 }),
      this.prisma.pipeline.findMany({ where: { companyId: c.id } }),
      this.prisma.order.findMany({ where: { companyId: c.id, ...NOT_DELETED, createdAt: { gte: since, lt: end } }, select: { total: true, paymentStatus: true, status: true }, take: 20000 }),
    ]);
    const stages = new Set(DEFAULT_STAGES.filter((s) => s.kind === 'WON').map((s) => s.key));
    const lost = new Set(DEFAULT_STAGES.filter((s) => s.kind === 'LOST').map((s) => s.key));
    for (const pl of pipelines) for (const s of parseJson<any[]>(pl.stagesJson, [])) {
      if (s.kind === 'WON') stages.add(s.key);
      if (s.kind === 'LOST') lost.add(s.key);
    }
    const spendBy = new Map<string, { spend: number; results: number }>();
    for (const [k, list] of groupBy(rows.filter((r) => inRange(r.date, p)), (r) => r.campaignExternalId)) {
      const t = totals(list);
      spendBy.set(k, { spend: t.spend, results: t.results });
    }
    const funnel = revenueFunnel({
      contacts, orders, ads: entities.filter((e) => e.level === 'AD'), campaigns: entities.filter((e) => e.level === 'CAMPAIGN'),
      spendByCampaign: spendBy, stages: { first: DEFAULT_STAGES[0].key, won: stages, lost }, since, until: end,
    });
    const businessRevenue = allSales.filter((o) => o.status !== 'cancelado' && (o.paymentStatus === 'PAID' || o.status === 'entregado')).reduce((s, o) => s + (Number(o.total) || 0), 0);
    // Estado de atribución de cada contacto que llegó desde Meta (anuncio, formulario o publicación)
    const fromMeta = await this.prisma.contact.findMany({
      where: { companyId: c.id, createdAt: { gte: since, lt: end }, OR: [{ originJson: { contains: '"AD"' } }, { originJson: { contains: '"POST"' } }] },
      select: { id: true, name: true, stage: true, createdAt: true, originJson: true }, orderBy: { createdAt: 'desc' }, take: 10000,
    });
    const adMap = new Map(entities.filter((e) => e.level === 'AD').map((e) => [e.externalId, e]));
    const names = new Map(entities.map((e) => [`${e.level}:${e.externalId}`, e.name]));
    const counts: Record<AttributionState, number> = { ATTRIBUTED: 0, PARTIAL: 0, UNATTRIBUTED: 0 };
    const recent: any[] = [];
    for (const x of fromMeta) {
      const info = attributionOf(x, adMap);
      if (!info) continue;
      counts[info.state]++;
      if (recent.length < 50) {
        recent.push({
          contactId: x.id, name: x.name, createdAt: x.createdAt, stage: x.stage, ...info,
          adName: info.adId ? names.get(`AD:${info.adId}`) ?? null : null,
          adsetName: info.adsetId ? names.get(`ADSET:${info.adsetId}`) ?? null : null,
          campaignName: info.campaignId ? names.get(`CAMPAIGN:${info.campaignId}`) ?? null : null,
        });
      }
    }
    const leadCounts = await this.prisma.adLead.findMany({ where: { companyId: c.id, receivedAt: { gte: since, lt: end } }, select: { status: true } });
    return {
      period: p, connected: accounts.length > 0, currency: accounts[0]?.currency ?? c.currency,
      ...funnel,
      /** Total del negocio en el periodo: NO es ingreso atribuido a anuncios */
      businessRevenue: Math.round(businessRevenue),
      adLeadsWithoutId: contacts.filter((x) => !adIdOf(x)).length,
      method: 'Atribución directa por identificadores: el ID del anuncio que Meta envía en el primer mensaje de WhatsApp (clic a WhatsApp) o en el formulario de Lead Ads. Sin fechas cercanas ni coincidencias aproximadas.',
      attribution: {
        counts,
        recent,
        rules: {
          ATTRIBUTED: 'Trae el ID de un anuncio que está en las cuentas sincronizadas: se conocen anuncio, conjunto y campaña.',
          PARTIAL: 'Hay evidencia de que vino de un anuncio, pero no alcanza para ubicar la campaña.',
          UNATTRIBUTED: 'El origen dice anuncio o publicación, pero no trae ningún identificador utilizable.',
        },
      },
      leadForms: {
        received: leadCounts.length,
        withContact: leadCounts.filter((l) => l.status === 'FETCHED').length,
        pendingPermission: leadCounts.filter((l) => l.status === 'PENDING_PERMISSION').length,
        errors: leadCounts.filter((l) => l.status === 'ERROR').length,
      },
    };
  }

  /* ── Campaign Studio ── */

  async briefs(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const rows = await this.prisma.adBrief.findMany({ where: { companyId: c.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map((b) => ({ ...b, data: parseJson(b.dataJson, {}), proposal: parseJson(b.proposalJson, null) }));
  }

  private briefFrom(dto: any): Brief {
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(String(v).replace(/[^\d.]/g, '')));
    return {
      product: clip(dto?.product, 120), goal: dto?.goal, location: clip(dto?.location, 120), audience: clip(dto?.audience, 200) || undefined,
      dailyBudget: num(dto?.dailyBudget) as number, durationDays: num(dto?.durationDays), averageTicket: num(dto?.averageTicket), marginPct: num(dto?.marginPct),
      leadCapacityPerDay: num(dto?.leadCapacityPerDay), offer: clip(dto?.offer, 200) || undefined, destination: clip(dto?.destination, 300) || undefined,
      startDate: clip(dto?.startDate, 10) || undefined,
    };
  }

  async saveBrief(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const settings = await this.settings(user, c.id);
    const brief = this.briefFrom(dto);
    const errors = validateBrief(brief, { maxDailyBudget: settings.maxDailyBudget, currency: c.currency });
    if (errors.length) throw new BadRequestException(errors.join(' · '));
    const brand = await this.prisma.brandProfile.findUnique({ where: { companyId: c.id } });
    const { rows } = await this.data(c.id, 'REAL');
    const hist = totals(rows.filter((r) => inRange(r.date, periods(this.lastDay(rows), 30).current)));
    const proposal = buildProposal(brief, { currency: c.currency, brandName: brand?.name || c.name, ctas: parseJson<string[]>(brand?.ctasJson, []), historicalCostPerResult: hist.costPerResult,
      today: this.now().toLocaleDateString('sv-SE', { timeZone: c.timezone || 'America/Bogota' }) });
    const row = await this.prisma.adBrief.create({
      data: { companyId: c.id, title: clip(dto?.title, 80) || brief.product, dataJson: JSON.stringify(brief), proposalJson: JSON.stringify(proposal), status: 'PROPOSED', createdBy: user.name, updatedAt: this.now() },
    });
    return { ...row, data: brief, proposal };
  }

  /** Crea la campaña en la plataforma SIEMPRE en pausa. Confirmación obligatoria. */
  async createFromBrief(user: AuthUser, id: string, dto: { accountId?: string; confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const b = await this.prisma.adBrief.findUnique({ where: { id } });
    if (!b || b.companyId !== c.id) throw new NotFoundException('Brief no encontrado');
    if (b.status === 'CREATED') throw new ConflictException('Esta campaña ya se creó');
    if (dto?.confirm !== true) throw new BadRequestException('Confirma la creación');
    const a = await this.accountOf(c.id, String(dto?.accountId ?? ''));
    if (a.status !== 'CONNECTED') throw new BadRequestException('La cuenta no está conectada');
    const settings = await this.settings(user, c.id);
    const brief = parseJson<Brief>(b.dataJson, {} as Brief);
    const allowed = budgetAllowed(brief.dailyBudget, settings.maxDailyBudget);
    if (!allowed.ok) throw new BadRequestException(allowed.reason);
    const proposal = parseJson<any>(b.proposalJson, {});
    const key = `brief:${b.id}`;
    if (await this.prisma.adActionLog.findUnique({ where: { idempotencyKey: key } })) throw new ConflictException('La creación ya se intentó; revisa el registro de acciones');
    const log = await this.prisma.adActionLog.create({
      data: {
        id: adActionId(key), companyId: c.id, accountId: a.id, mode: a.mode, source: 'USER', idempotencyKey: key, level: 'CAMPAIGN', externalId: 'pending', entityName: proposal?.providerConfig?.name,
        action: 'CREATE_CAMPAIGN', status: 'PROPOSED', dataJson: JSON.stringify({ briefId: b.id, providerConfig: proposal?.providerConfig }), reversible: false, actor: user.name,
      },
    }).catch((err: any) => {
      // Doble clic: el _id derivado de la clave impide crear dos veces
      if (isDup(err)) throw new ConflictException('La creación ya se intentó; revisa el registro de acciones');
      throw err;
    });
    try {
      const res = await this.provider(a.provider, a.mode).createCampaignPaused(this.ref(a), this.token(a), { name: proposal.providerConfig.name, objective: proposal.providerConfig.objective });
      await this.prisma.adActionLog.update({ where: { id: log.id }, data: { status: 'EXECUTED', externalId: res.externalId, providerResponse: JSON.stringify(res.response).slice(0, 2000), decidedAt: this.now() } });
      await this.prisma.adBrief.update({ where: { id: b.id }, data: { status: 'CREATED', accountId: a.id, createdExternalId: res.externalId, updatedAt: this.now() } });
      await this.audit.log({ actor: user, companyId: c.id, action: 'ads.campaign.create', entity: 'AdBrief', entityId: b.id, detail: `${proposal.providerConfig.name} (en pausa)${a.mode === 'DEMO' ? ' · demo' : ''}` });
      return { ok: true, externalId: res.externalId, demo: a.mode === 'DEMO', status: 'PAUSED' };
    } catch (err: any) {
      await this.prisma.adActionLog.update({ where: { id: log.id }, data: { status: 'FAILED', error: String(err?.message ?? err).slice(0, 300), decidedAt: this.now() } });
      throw this.providerHttp(err);
    }
  }

  /* ── Tareas programadas ── */

  @Cron('*/30 * * * *')
  async tick() {
    if (this.cronBusy || process.env.ADS_CRON_DISABLED === '1') return;
    this.cronBusy = true;
    try {
      const now = this.now();
      // Vencidas (EXPIRED) y desconectadas no se reintentan solas; las con error sí, según su próximo intento
      const due = await this.prisma.adAccount.findMany({
        where: {
          mode: 'REAL', status: { in: ['CONNECTED', 'ERROR'] },
          OR: [
            { nextSyncAt: { lte: now } },
            {
              AND: [
                { OR: [{ nextSyncAt: { isSet: false } }, { nextSyncAt: null }] },
                { OR: [{ lastSyncAt: { isSet: false } }, { lastSyncAt: null }, { lastSyncAt: { lt: new Date(now.getTime() - SYNC_EVERY_H * 36e5) } }] },
              ],
            },
          ],
        },
        take: 20,
      });
      // Sin Ads Intelligence activo no se sincroniza ni corren reglas (los datos se conservan)
      const ruleRows = await this.prisma.adRule.findMany({ where: { active: true }, select: { companyId: true }, take: 500 });
      const ids = [...new Set([...due.map((a) => a.companyId), ...ruleRows.map((r) => r.companyId)])];
      const owners = ids.length ? await this.prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, planId: true, productsJson: true } }) : [];
      const withAds = new Set(owners.filter((c) => hasProduct(c, 'ADS')).map((c) => c.id));
      for (const a of due.filter((x) => withAds.has(x.companyId))) await this.sync(null, a.id, a.companyId, 'CRON').catch((err) => this.logger.warn(`sync ${a.id}: ${err.message}`));
      for (const companyId of new Set(ruleRows.map((r) => r.companyId).filter((id) => withAds.has(id)))) await this.runRules(companyId).catch((err) => this.logger.warn(`reglas ${companyId}: ${err.message}`));
    } finally {
      this.cronBusy = false;
    }
  }
}

@Products('ADS')
@Controller('ads')
export class AdsController {
  constructor(private readonly ads: AdsService, private readonly leads: AdLeadsService) {}

  @Get('providers') @Roles(...READ) providers(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.providers(u, c); }
  @Get('accounts') @Roles(...READ) accounts(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.accounts(u, c); }
  @Post('accounts/demo') @Roles(...WRITE) demo(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.connectDemo(u, dto, c); }
  @Post('accounts/manual') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  manual(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.connectManual(u, dto, c); }
  @Delete('accounts/:id') @Roles(...WRITE) disconnect(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.disconnect(u, id, c); }
  @Post('accounts/:id/sync') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } })
  sync(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.syncNow(u, id, c); }
  @Get('accounts/:id/syncs') @Roles(...READ) syncs(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.syncRuns(u, id, c); }
  @Get('meta/oauth') @Roles(...WRITE) oauth(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.oauthStart(u, c); }
  @Get('meta/pending') @Roles(...WRITE) pending(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.pending(u, c); }
  @Post('meta/select') @Roles(...WRITE) select(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.selectPending(u, dto, c); }

  @Get('overview') @Roles(...READ) overview(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.overview(u, q); }
  @Get('campaigns') @Roles(...READ) campaigns(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.campaignTree(u, q); }
  @Post('entities/:id/status') @Roles(...WRITE) status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.setEntityStatus(u, id, dto, c); }

  @Post('audit') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } }) auditNow(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.auditNow(u, c); }

  @Get('actions') @Roles(...READ) actions(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.actions(u, q); }
  @Post('actions/:id/decide') @Roles(...WRITE) decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.decideAction(u, id, dto, c); }
  @Post('actions/:id/retry') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  retry(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.retryAction(u, id, dto, c); }
  @Post('actions/:id/revert') @Roles(...WRITE) revert(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.revertAction(u, id, dto, c); }

  @Get('settings') @Roles(...READ) settings(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.settings(u, c); }
  @Put('settings') @Roles(...WRITE) saveSettings(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.saveSettings(u, dto, c); }
  @Get('rules') @Roles(...READ) rules(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.rules(u, c); }
  @Post('rules') @Roles(...WRITE) createRule(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.createRule(u, dto, c); }
  @Put('rules/:id') @Roles(...WRITE) updateRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.updateRule(u, id, dto, c); }
  @Delete('rules/:id') @Roles(...WRITE) deleteRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.deleteRule(u, id, c); }
  @Get('rules/:id/test') @Roles(...READ) testRule(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query() q: any) { return this.ads.testRule(u, id, q); }
  @Post('rules/run') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } }) runRules(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.runRulesNow(u, c); }

  @Get('revenue') @Roles(...READ) revenue(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.revenue(u, q); }

  @Get('leads') @Roles(...READ)
  async leadList(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.leads.list((await this.ads.companyOf(u, c)).id); }
  @Post('leads/:id/fetch') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async leadFetch(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) {
    const company = await this.ads.companyOf(u, c);
    const lead = await this.leads.fetch(company.id, id);
    if (!lead || lead.companyId !== company.id) throw new NotFoundException('Lead no encontrado');
    return lead;
  }

  @Get('briefs') @Roles(...READ) briefs(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.briefs(u, c); }
  @Post('briefs') @Roles(...WRITE) saveBrief(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.saveBrief(u, dto, c); }
  @Post('briefs/:id/create') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  createFromBrief(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.createFromBrief(u, id, dto, c); }
}

@Products('ADS')
@Controller('public/ads')
export class AdsPublicController {
  constructor(private readonly ads: AdsService) {}

  @Public()
  @Get('meta/callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    res.redirect(await this.ads.oauthCallback(code, state));
  }
}

@Module({
  imports: [AuditModule],
  providers: [AdsService, AdLeadsService],
  controllers: [AdsController, AdsPublicController],
  exports: [AdsService, AdLeadsService],
})
export class AdsModule {}
