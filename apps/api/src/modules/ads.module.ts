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
import { AccountRef, AdLevel, AdsProvider, AdsProviderError, FetchLike, ProviderKey, RemoteEntity, RemoteInsight, addDays, isoDay } from '../common/ads/provider';
import { META_ADS_SCOPES } from '../common/ads/meta-ads-provider';
import { DemoAdsProvider } from '../common/ads/demo-provider';
import { PROVIDER_KEYS, providerFor } from '../common/ads/registry';
import { daily, delta, groupBy, inRange, periods, totals } from '../common/ads/metrics';
import { CrmAdStats, audit } from '../common/ads/findings';
import { Autonomy, METRICS, RuleLike, budgetAllowed, evaluateRule, guardAutoAction, ruleRunKey, validateRule } from '../common/ads/autopilot';
import { adIdOf, revenueFunnel } from '../common/ads/revenue';
import { Brief, buildProposal, validateBrief } from '../common/ads/proposal';
import { OPEN, OppDraft, storeDetected } from '../common/opportunities/store';
import { AuditModule, AuditService } from './audit.module';
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
const SYNC_EVERY_H = 6;
const FIRST_SYNC_DAYS = 60;
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
    return { ...rest, hasToken: !!a.tokenEnc, scopes: parseJson<string[]>(a.scopesJson, []), dataAgeHours: ageH, stale: ageH === null || ageH > SYNC_EVERY_H * 2 };
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
      data: { companyId: c.id, provider: key, mode: 'DEMO', externalId: remote.externalId, name: remote.name, currency: remote.currency, timezone: remote.timezone, status: 'CONNECTED', connectedBy: user.name, updatedAt: this.now() },
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
    const acc = existing
      ? await this.prisma.adAccount.update({ where: { id: existing.id }, data })
      : await this.prisma.adAccount.create({ data: { companyId, provider: 'META', mode: 'REAL', externalId: remote.externalId, ...data } });
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

  async sync(user: AuthUser | null, accountId: string, companyId: string, trigger: 'MANUAL' | 'CRON' = 'MANUAL') {
    const a = await this.accountOf(companyId, accountId);
    if (a.status === 'DISCONNECTED') throw new BadRequestException('La cuenta está desconectada');
    const running = await this.prisma.adSyncRun.findFirst({ where: { accountId: a.id, status: 'RUNNING', startedAt: { gte: new Date(this.now().getTime() - 15 * 60e3) } } });
    if (running) throw new ConflictException('Ya hay una sincronización en curso para esta cuenta');
    const run = await this.prisma.adSyncRun.create({ data: { companyId, accountId: a.id, trigger, status: 'RUNNING', startedAt: this.now() } });
    const p = this.provider(a.provider, a.mode);
    const token = this.token(a);
    const until = isoDay(this.now());
    const since = a.lastSyncAt ? addDays(isoDay(new Date(a.lastSyncAt)), -RESYNC_DAYS) : addDays(until, -(FIRST_SYNC_DAYS - 1));
    try {
      const entities = await p.fetchEntities(this.ref(a), token);
      const insights = await p.fetchInsights(this.ref(a), token, since < addDays(until, -(FIRST_SYNC_DAYS - 1)) ? addDays(until, -(FIRST_SYNC_DAYS - 1)) : since, a.mode === 'DEMO' ? addDays(until, -1) : until);
      const e = await this.saveEntities(a, entities);
      const i = await this.saveInsights(a, insights);
      await this.prisma.adSyncRun.update({ where: { id: run.id }, data: { status: 'OK', countsJson: JSON.stringify({ entities: e, insights: i, since }), finishedAt: this.now() } });
      await this.prisma.adAccount.update({ where: { id: a.id }, data: { lastSyncAt: this.now(), lastError: null, status: 'CONNECTED' } });
      await this.runAudit(companyId).catch((err) => this.logger.warn(`auditoría ${companyId}: ${err.message}`));
      return { ok: true, entities: e, insights: i };
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      const expired = err instanceof AdsProviderError && err.kind === 'AUTH';
      await this.prisma.adSyncRun.update({ where: { id: run.id }, data: { status: 'ERROR', error: msg, finishedAt: this.now() } });
      await this.prisma.adAccount.update({ where: { id: a.id }, data: { lastError: msg, status: expired ? 'EXPIRED' : 'ERROR' } });
      if (user) await this.audit.log({ actor: user, companyId, action: 'ads.sync.error', entity: 'AdAccount', entityId: a.id, detail: msg });
      throw this.providerHttp(err);
    }
  }

  /** Guarda en lote: una consulta para leer lo que hay, createMany para lo nuevo y update solo de lo que cambió. */
  private async saveEntities(a: { id: string; companyId: string; provider: string; mode: string }, entities: RemoteEntity[]) {
    const existing = await this.prisma.adEntity.findMany({ where: { accountId: a.id } });
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
      const old = byKey.get(`${x.level}:${x.externalId}`);
      if (!old) {
        fresh.push({ companyId: a.companyId, accountId: a.id, provider: a.provider, mode: a.mode, level: x.level, externalId: x.externalId, ...data, syncedAt: now });
        continue;
      }
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
    if (fresh.length) await this.prisma.adEntity.createMany({ data: fresh });
    return fresh.length + changed;
  }

  private async saveInsights(a: { id: string; companyId: string; mode: string; currency: string }, rows: RemoteInsight[]) {
    if (!rows.length) return 0;
    const dates = rows.map((r) => r.date).sort();
    const existing = await this.prisma.adInsightDaily.findMany({ where: { accountId: a.id, date: { gte: dates[0], lte: dates[dates.length - 1] } } });
    const byKey = new Map(existing.map((x) => [`${x.level}:${x.externalId}:${x.date}`, x]));
    const now = this.now();
    const fresh: any[] = [];
    let changed = 0;
    const NUMS = ['spend', 'impressions', 'reach', 'clicks', 'linkClicks', 'leads', 'conversations', 'purchases', 'purchaseValue'] as const;
    for (const r of rows) {
      const data = {
        campaignExternalId: r.campaignExternalId, currency: a.currency, spend: r.spend, impressions: r.impressions, reach: r.reach, clicks: r.clicks,
        linkClicks: r.linkClicks, leads: r.leads, conversations: r.conversations, purchases: r.purchases, purchaseValue: r.purchaseValue,
        rawJson: JSON.stringify(r.raw).slice(0, 8000),
      };
      const old = byKey.get(`${r.level}:${r.externalId}:${r.date}`);
      if (!old) {
        fresh.push({ companyId: a.companyId, accountId: a.id, mode: a.mode, level: r.level, externalId: r.externalId, date: r.date, ...data, syncedAt: now });
      } else if (NUMS.some((k) => Number((old as any)[k]) !== Number(data[k]))) {
        // La atribución sigue moviendo los números unos días: se actualiza solo lo que cambió
        await this.prisma.adInsightDaily.update({ where: { id: old.id }, data: { ...data, syncedAt: now } });
        changed++;
      }
    }
    for (let k = 0; k < fresh.length; k += 1000) await this.prisma.adInsightDaily.createMany({ data: fresh.slice(k, k + 1000) });
    return fresh.length + changed;
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

  async overview(user: AuthUser, q: { companyId?: string; days?: string; accountId?: string; mode?: string; campaign?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const mode = await this.modeFor(c.id, q.mode);
    const days = [7, 14, 30, 60].includes(Number(q.days)) ? Number(q.days) : 30;
    const { accounts, entities, rows: all } = await this.data(c.id, mode, q.accountId);
    const rows = q.campaign ? all.filter((r) => r.campaignExternalId === q.campaign) : all;
    const until = this.lastDay(rows);
    const p = periods(until, days);
    const now = totals(rows.filter((r) => inRange(r.date, p.current)));
    const before = totals(rows.filter((r) => inRange(r.date, p.previous)));
    const byCampaign = groupBy(rows.filter((r) => inRange(r.date, p.current)), (r) => r.campaignExternalId);
    const campaigns = entities.filter((e) => e.level === 'CAMPAIGN').map((e) => ({
      id: e.id, externalId: e.externalId, name: e.name, status: e.effectiveStatus ?? e.status, objective: e.objective, dailyBudget: e.dailyBudget,
      accountId: e.accountId, ...totals(byCampaign.get(e.externalId) ?? []),
    })).sort((a, b) => b.spend - a.spend);
    const currencies = [...new Set(accounts.map((a) => a.currency))];
    const [openFindings, pendingActions, executed] = await Promise.all([
      this.prisma.opportunity.count({ where: { companyId: c.id, source: 'ADS', mode, status: { in: OPEN } } }),
      this.prisma.adActionLog.count({ where: { companyId: c.id, mode, status: 'PROPOSED' } }),
      this.prisma.adActionLog.count({ where: { companyId: c.id, mode, status: 'EXECUTED', createdAt: { gte: new Date(Date.parse(`${p.current.since}T00:00:00Z`)) } } }),
    ]);
    const realCount = await this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'REAL' } });
    const demoCount = await this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'DEMO' } });
    return {
      mode, modes: { real: realCount, demo: demoCount }, days, period: p, currency: currencies.length === 1 ? currencies[0] : null,
      mixedCurrencies: currencies.length > 1,
      accounts: accounts.map((a) => this.view(a)),
      totals: now, previous: before,
      deltas: {
        spend: delta(now.spend, before.spend), results: delta(now.results, before.results), costPerResult: delta(now.costPerResult, before.costPerResult),
        ctr: delta(now.ctr, before.ctr), cpc: delta(now.cpc, before.cpc), cpm: delta(now.cpm, before.cpm),
      },
      insufficient: now.days < Math.min(days, 7) || before.days === 0,
      daily: daily(rows, p.current),
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
    const metricsFor = (e: any) => totals(
      e.level === 'AD' ? byAd.get(e.externalId) ?? []
        : e.level === 'ADSET' ? entities.filter((x) => x.level === 'AD' && x.adsetExternalId === e.externalId).flatMap((x) => byAd.get(x.externalId) ?? [])
          : cur.filter((r) => r.campaignExternalId === e.externalId),
    );
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

  private async crmStats(companyId: string, conversations: number): Promise<CrmAdStats> {
    const cut = new Date(this.now().getTime() - 14 * 86400e3);
    const contacts = await this.prisma.contact.findMany({ where: { companyId, originJson: { contains: '"AD"' }, createdAt: { lte: cut } }, select: { stage: true, originJson: true }, take: 5000 });
    const recentAd = await this.prisma.contact.count({ where: { companyId, originJson: { contains: '"AD"' }, createdAt: { gte: new Date(this.now().getTime() - 7 * 86400e3) } } });
    return {
      // Si hubo contactos de anuncios recientes, el seguimiento funciona aunque los viejos sean pocos
      adLeads: Math.max(contacts.length, recentAd),
      stuckInFirstStage: contacts.filter((x) => x.stage === DEFAULT_STAGES[0].key).length,
      platformConversations: conversations,
    };
  }

  async runAudit(companyId: string) {
    const out: Record<string, number> = {};
    for (const mode of ['REAL', 'DEMO'] as const) {
      const accounts = await this.prisma.adAccount.findMany({ where: { companyId, mode, status: { not: 'DISCONNECTED' } } });
      for (const a of accounts) {
        const [entities, rows] = await Promise.all([
          this.prisma.adEntity.findMany({ where: { companyId, accountId: a.id } }),
          this.prisma.adInsightDaily.findMany({ where: { companyId, accountId: a.id, date: { gte: addDays(isoDay(this.now()), -60) } } }),
        ]);
        if (!rows.length && !entities.length) continue;
        const until = this.lastDay(rows);
        const conv7 = totals(rows.filter((r) => inRange(r.date, periods(until, 7).current))).conversations;
        // Los datos del CRM solo se cruzan con cuentas reales
        const crm = mode === 'REAL' ? await this.crmStats(companyId, conv7) : undefined;
        const drafts = audit(
          entities.map((e) => ({ ...e, issues: parseJson<string[]>(e.issuesJson, []) })),
          rows, { until, currency: a.currency, minSpend: 0 }, crm,
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

  private async changeStatus(actor: string, companyId: string, entity: any, status: 'ACTIVE' | 'PAUSED', meta: { source: 'USER' | 'RULE' | 'FINDING'; ruleId?: string; findingId?: string; key: string; data?: unknown }) {
    if (entity.companyId !== companyId) throw new ForbiddenException('El elemento no es de tu empresa');
    const a = await this.accountOf(companyId, entity.accountId);
    const done = await this.prisma.adActionLog.findUnique({ where: { idempotencyKey: meta.key } });
    if (done && done.status === 'EXECUTED') return { ok: true, duplicate: true, logId: done.id };
    const before = { status: entity.status, effectiveStatus: entity.effectiveStatus };
    const log = done ?? await this.prisma.adActionLog.create({
      data: {
        companyId, accountId: a.id, mode: a.mode, source: meta.source, ruleId: meta.ruleId ?? null, findingId: meta.findingId ?? null, idempotencyKey: meta.key,
        level: entity.level, externalId: entity.externalId, entityName: entity.name, action: status === 'PAUSED' ? 'PAUSE' : 'RESUME', status: 'PROPOSED',
        dataJson: JSON.stringify(meta.data ?? {}), beforeJson: JSON.stringify(before), reversible: true, actor,
      },
    });
    try {
      const response = await this.provider(a.provider, a.mode).setStatus(this.ref(a), this.token(a), entity.level as AdLevel, entity.externalId, status);
      await this.prisma.adEntity.update({ where: { id: entity.id }, data: { status, effectiveStatus: status === 'PAUSED' ? 'PAUSED' : entity.effectiveStatus === 'PAUSED' ? 'ACTIVE' : entity.effectiveStatus } });
      await this.prisma.adActionLog.update({ where: { id: log.id }, data: { status: 'EXECUTED', afterJson: JSON.stringify({ status }), providerResponse: JSON.stringify(response).slice(0, 2000), decidedAt: this.now(), actor } });
      return { ok: true, logId: log.id, demo: a.mode === 'DEMO' };
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 300);
      await this.prisma.adActionLog.update({ where: { id: log.id }, data: { status: 'FAILED', error: msg, decidedAt: this.now() } });
      if (err instanceof AdsProviderError && err.kind === 'AUTH') await this.prisma.adAccount.update({ where: { id: a.id }, data: { status: 'EXPIRED', lastError: msg } });
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
    return this.changeStatus(user.name, c.id, e, status, { source: 'USER', key: `user:${e.id}:${status}:${Date.now()}` });
  }

  async actions(user: AuthUser, q: { companyId?: string; status?: string; mode?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const mode = await this.modeFor(c.id, q.mode);
    const rows = await this.prisma.adActionLog.findMany({ where: { companyId: c.id, mode, ...(q.status ? { status: String(q.status) } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
    return rows.map((r) => ({ ...r, data: parseJson(r.dataJson, {}), before: parseJson(r.beforeJson, null), after: parseJson(r.afterJson, null) }));
  }

  async decideAction(user: AuthUser, id: string, dto: { decision?: string; confirm?: boolean }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const log = await this.prisma.adActionLog.findUnique({ where: { id } });
    if (!log || log.companyId !== c.id) throw new NotFoundException('Acción no encontrada');
    if (log.status !== 'PROPOSED') throw new ConflictException('Esta acción ya se decidió');
    if (dto?.decision === 'REJECT') {
      await this.prisma.adActionLog.update({ where: { id }, data: { status: 'REJECTED', actor: user.name, decidedAt: this.now() } });
      return { ok: true };
    }
    if (dto?.decision !== 'APPROVE' || dto?.confirm !== true) throw new BadRequestException('Confirma la acción');
    if (log.action !== 'RECOMMEND_PAUSE' && log.action !== 'PAUSE') throw new BadRequestException('Acción no ejecutable');
    const e = await this.prisma.adEntity.findFirst({ where: { companyId: c.id, accountId: log.accountId, level: log.level, externalId: log.externalId } });
    if (!e) throw new NotFoundException('El elemento ya no existe');
    await this.prisma.adActionLog.update({ where: { id }, data: { status: 'SKIPPED', error: 'Aprobada: se ejecuta como acción nueva', actor: user.name, decidedAt: this.now() } });
    return this.changeStatus(user.name, c.id, e, 'PAUSED', { source: 'RULE', ruleId: log.ruleId ?? undefined, key: `approved:${log.id}`, data: { approvedFrom: log.id } });
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
    return { mode, matches: evaluateRule(r as unknown as RuleLike, entities, rows, this.lastDay(rows)) };
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
        for (const m of evaluateRule(rule as unknown as RuleLike, entities, rows, until)) {
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
              companyId, accountId: account.id, mode, source: 'RULE', ruleId: rule.id, idempotencyKey: key, level: entity.level, externalId: entity.externalId,
              entityName: entity.name, action: g.decision === 'ALERT' ? 'ALERT' : 'RECOMMEND_PAUSE', status: g.decision === 'ALERT' ? 'EXECUTED' : 'PROPOSED',
              dataJson: JSON.stringify({ match: m, guard: g.reason, rule: rule.name }), reversible: false, actor: 'Autopilot',
            },
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
    return {
      period: p, connected: accounts.length > 0, currency: accounts[0]?.currency ?? c.currency,
      ...funnel,
      /** Total del negocio en el periodo: NO es ingreso atribuido a anuncios */
      businessRevenue: Math.round(businessRevenue),
      adLeadsWithoutId: contacts.filter((x) => !adIdOf(x)).length,
      method: 'Atribución directa: ID del anuncio que Meta envía en el primer mensaje de WhatsApp (clic a WhatsApp). Sin coincidencias aproximadas.',
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
        companyId: c.id, accountId: a.id, mode: a.mode, source: 'USER', idempotencyKey: key, level: 'CAMPAIGN', externalId: 'pending', entityName: proposal?.providerConfig?.name,
        action: 'CREATE_CAMPAIGN', status: 'PROPOSED', dataJson: JSON.stringify({ briefId: b.id, providerConfig: proposal?.providerConfig }), reversible: false, actor: user.name,
      },
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
      const due = await this.prisma.adAccount.findMany({
        where: { mode: 'REAL', status: 'CONNECTED', OR: [{ lastSyncAt: null }, { lastSyncAt: { lt: new Date(this.now().getTime() - SYNC_EVERY_H * 36e5) } }] },
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
  constructor(private readonly ads: AdsService) {}

  @Get('providers') @Roles(...READ) providers(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.providers(u, c); }
  @Get('accounts') @Roles(...READ) accounts(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.accounts(u, c); }
  @Post('accounts/demo') @Roles(...WRITE) demo(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.connectDemo(u, dto, c); }
  @Post('accounts/manual') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  manual(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.connectManual(u, dto, c); }
  @Delete('accounts/:id') @Roles(...WRITE) disconnect(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.disconnect(u, id, c); }
  @Post('accounts/:id/sync') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } })
  sync(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.ads.syncNow(u, id, c); }
  @Get('meta/oauth') @Roles(...WRITE) oauth(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.oauthStart(u, c); }
  @Get('meta/pending') @Roles(...WRITE) pending(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.pending(u, c); }
  @Post('meta/select') @Roles(...WRITE) select(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.selectPending(u, dto, c); }

  @Get('overview') @Roles(...READ) overview(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.overview(u, q); }
  @Get('campaigns') @Roles(...READ) campaigns(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.campaignTree(u, q); }
  @Post('entities/:id/status') @Roles(...WRITE) status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.setEntityStatus(u, id, dto, c); }

  @Post('audit') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } }) auditNow(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.ads.auditNow(u, c); }

  @Get('actions') @Roles(...READ) actions(@CurrentUser() u: AuthUser, @Query() q: any) { return this.ads.actions(u, q); }
  @Post('actions/:id/decide') @Roles(...WRITE) decide(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.ads.decideAction(u, id, dto, c); }
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
  providers: [AdsService],
  controllers: [AdsController, AdsPublicController],
  exports: [AdsService],
})
export class AdsModule {}
