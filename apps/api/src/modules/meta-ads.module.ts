import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Query,
  UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { publicWebUrl } from '../common/tracking';
import { metaAdsVersion } from '../common/ads/meta-ads-provider';
import { fromMinor, toMinor } from '../common/ads/provider';
import { GOALS, LaunchDraft, buildLaunch, draftFrom, parseAmount, slugify, todayIn, validateLaunch } from '../common/ads/launch';
import { AuditModule, AuditService } from './audit.module';
import {
  DateRange, Funnel, SessionLite, Thresholds, VIA_LABEL, addDaysIso, addToFunnel, alertsFor, attributionResolver, cleanThresholds, dayIn, deliveryOf, derived,
  emptyFunnel, INSIGHT_FIELDS, isFromMeta, metaErrorKind, metaRow, norm, paceOf, rangeFor, utmFromUrl,
} from '../common/ads/own-funnel';

/**
 * Publicidad de BackOffice en Meta (Facebook / Instagram) — solo para el equipo.
 *  - Con la cuenta publicitaria conectada (token + act_…) trae campañas, gasto,
 *    alcance, clics y resultados, y permite pausar o activar una campaña.
 *  - Cruza el gasto con los registros: quien llega con ?utm_source=facebook o
 *    instagram y ?utm_campaign=… queda atribuido a esa campaña, así se ve
 *    cuánto cuesta cada registro y cada empresa creada.
 *  - Sin conexión se puede anotar el gasto a mano y el cruce funciona igual.
 *  - Lanza campañas propias (campaña → conjunto → creativo → anuncio), todo
 *    en PAUSA. Activar y subir presupuesto gastan dinero: exigen confirm=true
 *    y respetan el tope diario. Cada lanzamiento guarda los ids de Meta paso
 *    a paso, así un reintento continúa donde falló sin duplicar.
 */

const graphBase = () => `https://graph.facebook.com/${metaAdsVersion()}`;
// Los videos se suben por un host aparte
const graphVideoBase = () => `https://graph-video.facebook.com/${metaAdsVersion()}`;
const CFG_KEY = 'META_ADS_CONFIG';
const MANUAL_KEY = 'META_ADS_MANUAL';
const PREFS_KEY = 'META_ADS_PREFS';
const LAUNCH_PREFIX = 'META_ADS_LAUNCH:';
const STEPS = ['campaign', 'adset', 'creative', 'ad'] as const;
const LOCK_MS = 2 * 60_000;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_VIDEO = 64 * 1024 * 1024;
// Meta procesa el video después de subirlo: se espera un poco antes de crear el creativo
const VIDEO_WAIT_MS = 4_000;
const VIDEO_WAIT_TRIES = 10;
const MAP_KEY = 'META_ADS_UTM_MAP';
const ALERTS_KEY = 'META_ADS_ALERTS';
/** Lo leído de Meta se reutiliza 12 minutos (botón «Actualizar» para pedirlo ya). */
const META_CACHE_MS = 12 * 60_000;

/** Error de Graph con su código (190 token vencido, 200 permisos…), para explicarlo en la pantalla. */
export class MetaApiError extends BadRequestException {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

interface Prefs {
  pageId?: string;
  pageName?: string;
  instagramUserId?: string;
  maxDailyBudget?: number;
}

type LaunchStatus = 'CREATING' | 'FAILED' | 'PAUSED' | 'ACTIVE' | 'ARCHIVED';

export interface Launch {
  id: string;
  createdAt: string;
  createdBy: string;
  status: LaunchStatus;
  accountId: string;
  currency: string;
  draft: LaunchDraft;
  utmCampaign: string;
  link: string | null;
  pageId: string;
  ids: Partial<Record<(typeof STEPS)[number], string>>;
  error: string | null;
  lockUntil: string | null;
  history: Array<{ at: string; by: string; event: string; detail?: string }>;
}

interface ManualSpend {
  id: string;
  date: string;
  campaign: string;
  spend: number;
  notes: string;
}

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger('MetaAds');

  /** Reemplazable en pruebas (sin pasar por la inyección de Nest). */
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;
  /** Pausa entre consultas a Meta (reemplazable en pruebas). */
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async setting(key: string) {
    return (await this.prisma.platformSetting.findUnique({ where: { key } }))?.value ?? null;
  }

  private async put(key: string, value: string) {
    const existing = await this.prisma.platformSetting.findUnique({ where: { key } });
    if (existing) await this.prisma.platformSetting.update({ where: { key }, data: { value } });
    else await this.prisma.platformSetting.create({ data: { key, value } });
  }

  private async config(): Promise<{ accountId: string; token: string } | null> {
    const cfg = parseJson<{ accountId?: string; token?: string }>(await this.setting(CFG_KEY), {});
    if (!cfg.accountId || !cfg.token) return null;
    try {
      return { accountId: cfg.accountId, token: isEncrypted(cfg.token) ? decryptSecret(cfg.token) : cfg.token };
    } catch {
      return null;
    }
  }

  private async graph(path: string, token: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') {
    const qs = new URLSearchParams({ ...params, access_token: token }).toString();
    const res = method === 'GET'
      ? await this.fetchImpl(`${graphBase()}${path}?${qs}`)
      : await this.fetchImpl(`${graphBase()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new MetaApiError(Number(data?.error?.code) || res.status, `Meta: ${data?.error?.message ?? `respondió ${res.status}`}`);
    return data;
  }

  async connect(actor: AuthUser, dto: { accountId?: string; token?: string }) {
    const raw = String(dto?.accountId ?? '').trim().replace(/^act_/, '');
    if (!/^\d{5,25}$/.test(raw)) throw new BadRequestException('El ID de la cuenta publicitaria son solo números (ej. act_1234567890)');
    const token = String(dto?.token ?? '').trim();
    if (token.length < 20) throw new BadRequestException('Pega el token de acceso de Meta (con permiso ads_read o ads_management)');
    const accountId = `act_${raw}`;
    const info = await this.graph(`/${accountId}`, token, { fields: 'name,currency,account_status' });
    await this.put(CFG_KEY, JSON.stringify({ accountId, token: encryptSecret(token) }));
    await this.audit.log({ actor, action: 'ads.connect', entity: 'PlatformSetting', entityId: CFG_KEY, detail: `${info.name} (${accountId})` });
    return { ok: true, account: { id: accountId, name: info.name, currency: info.currency } };
  }

  async disconnect(actor: AuthUser) {
    await this.prisma.platformSetting.deleteMany({ where: { key: CFG_KEY } });
    await this.audit.log({ actor, action: 'ads.disconnect', entity: 'PlatformSetting', entityId: CFG_KEY, detail: 'Cuenta publicitaria desconectada' });
    return { ok: true };
  }

  async manual(): Promise<ManualSpend[]> {
    return parseJson<ManualSpend[]>(await this.setting(MANUAL_KEY), []);
  }

  async addManual(actor: AuthUser, dto: any) {
    // Pesos sin centavos: "50.000" o "50,000" son cincuenta mil
    const spend = Number(String(dto?.spend ?? '').replace(/\D/g, ''));
    const date = String(dto?.date ?? '').slice(0, 10);
    const campaign = String(dto?.campaign ?? '').trim().slice(0, 120);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BadRequestException('Fecha inválida');
    if (!(spend > 0)) throw new BadRequestException('Escribe cuánto se gastó');
    if (!campaign) throw new BadRequestException('Escribe el nombre de la campaña (el mismo de utm_campaign)');
    const list = await this.manual();
    list.unshift({ id: `m${Date.now()}`, date, campaign, spend: Math.round(spend), notes: String(dto?.notes ?? '').slice(0, 300) });
    await this.put(MANUAL_KEY, JSON.stringify(list.slice(0, 500)));
    await this.audit.log({ actor, action: 'ads.manual', entity: 'PlatformSetting', entityId: MANUAL_KEY, detail: `${campaign} · $${Math.round(spend).toLocaleString('es-CO')}` });
    return list;
  }

  async removeManual(id: string) {
    const list = (await this.manual()).filter((m) => m.id !== id);
    await this.put(MANUAL_KEY, JSON.stringify(list));
    return list;
  }

  /* ───────────────────────── Resultados de la pauta propia ───────────────────────── */

  /** Caché de lo leído en Meta (Meta guarda el historial; no hace falta pedirlo en cada clic). */
  private metaCache = new Map<string, { at: number; value: any }>();
  /** Reemplazable en pruebas. */
  clock: () => Date = () => new Date();

  async thresholds(): Promise<Thresholds> {
    return cleanThresholds(parseJson<Partial<Thresholds>>(await this.setting(ALERTS_KEY), {}));
  }

  async saveThresholds(actor: AuthUser, dto: any) {
    const before = await this.thresholds();
    const next = cleanThresholds(dto, before);
    await this.put(ALERTS_KEY, JSON.stringify(next));
    await this.audit.log({ actor, action: 'ads.alerts', entity: 'PlatformSetting', entityId: ALERTS_KEY, detail: JSON.stringify(next) });
    return next;
  }

  /**
   * Conjuntos de anuncios entregando ahora (para el despertador del servidor).
   * Activo en Meta y sin fecha de fin vencida. null = no se pudo saber
   * (sin cuenta conectada o Meta no respondió).
   */
  async deliveringNow(): Promise<{ id: string; name: string; campaign: string }[] | null> {
    const cfg = await this.config();
    if (!cfg) return null;
    try {
      const data = await this.graph(`/${cfg.accountId}/adsets`, cfg.token, {
        fields: 'id,name,end_time,campaign{name}',
        effective_status: JSON.stringify(['ACTIVE']),
        limit: '25',
      });
      const now = this.clock().getTime();
      return (data?.data ?? [])
        .filter((a: any) => !a.end_time || Date.parse(a.end_time) > now)
        .map((a: any) => ({ id: String(a.id), name: String(a.name ?? ''), campaign: String(a.campaign?.name ?? '') }));
    } catch (e: any) {
      this.logger.warn(`despertador: no se pudo leer Meta (${e?.message ?? e})`);
      return null;
    }
  }

  async mappings(): Promise<Record<string, string[]>> {
    return parseJson<Record<string, string[]>>(await this.setting(MAP_KEY), {});
  }

  /** Asigna (o quita) un utm_campaign a una campaña de Meta. Lo que ya estaba atribuido a otra no se mueve. */
  async setMapping(actor: AuthUser, dto: { campaignId?: unknown; utmCampaign?: unknown; remove?: unknown }) {
    const campaignId = String(dto?.campaignId ?? '').trim();
    const utm = String(dto?.utmCampaign ?? '').trim().slice(0, 120);
    if (!/^\d{5,30}$/.test(campaignId)) throw new BadRequestException('Elige la campaña de Meta');
    if (!norm(utm)) throw new BadRequestException('Escribe el utm_campaign que quieres asignar');
    const map = await this.mappings();
    const list = (map[campaignId] ?? []).filter((u) => norm(u) !== norm(utm));
    if (dto?.remove !== true) {
      const other = Object.entries(map).find(([id, utms]) => id !== campaignId && utms.some((u) => norm(u) === norm(utm)));
      if (other) throw new ConflictException(`«${utm}» ya está asignado a otra campaña (${other[0]}). Quítalo de allá primero.`);
      list.push(utm);
    }
    if (list.length > 20) throw new BadRequestException('Máximo 20 utm_campaign por campaña');
    if (list.length) map[campaignId] = list;
    else delete map[campaignId];
    await this.put(MAP_KEY, JSON.stringify(map));
    await this.audit.log({ actor, action: dto?.remove === true ? 'ads.mapping.remove' : 'ads.mapping', entity: 'MetaCampaign', entityId: campaignId, detail: utm });
    this.metaCache.clear();
    return map;
  }

  private async graphAll(path: string, token: string, params: Record<string, string>, maxPages = 5) {
    const out: any[] = [];
    let page = await this.graph(path, token, params);
    for (let i = 0; ; i++) {
      out.push(...(page?.data ?? []));
      const next = page?.paging?.next;
      if (!next || typeof next !== 'string' || !next.startsWith('https://graph.facebook.com/') || i + 1 >= maxPages) break;
      const res = await this.fetchImpl(next);
      page = await res.json().catch(() => ({}));
      if (!res.ok || page?.error) throw new MetaApiError(Number(page?.error?.code) || res.status, `Meta: ${page?.error?.message ?? `respondió ${res.status}`}`);
    }
    return out;
  }

  /** Todo lo que se lee de Meta para el rango: una llamada por nivel. */
  private async readMeta(cfg: { accountId: string; token: string }, range: DateRange, refresh: boolean) {
    const key = `${cfg.accountId}|${range.since}|${range.until}`;
    const hit = this.metaCache.get(key);
    if (!refresh && hit && this.clock().getTime() - hit.at < META_CACHE_MS) return hit.value;
    const act = cfg.accountId;
    const time_range = JSON.stringify({ since: range.since, until: range.until });
    const ins = (level: string, extra: Record<string, string> = {}, idFields = '') =>
      this.graphAll(`/${act}/insights`, cfg.token, { level, time_range, fields: [idFields, INSIGHT_FIELDS].filter(Boolean).join(','), limit: '500', ...extra });
    const [campaigns, adsets, ads, byCampaign, byAd, daily, account, lifetime] = await Promise.all([
      this.graphAll(`/${act}/campaigns`, cfg.token, { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,issues_info', limit: '200' }),
      this.graphAll(`/${act}/adsets`, cfg.token, { fields: 'id,campaign_id,daily_budget,lifetime_budget,start_time,end_time,effective_status', limit: '200' }),
      this.graphAll(`/${act}/ads`, cfg.token, { fields: 'id,name,campaign_id,adset_id,status,effective_status,ad_review_feedback,issues_info,creative{id,object_story_spec,url_tags,asset_feed_spec}', limit: '200' }),
      ins('campaign', {}, 'campaign_id'),
      ins('ad', {}, 'ad_id,campaign_id'),
      this.graphAll(`/${act}/insights`, cfg.token, { level: 'account', time_range, time_increment: '1', fields: 'spend,impressions,inline_link_clicks', limit: '500' }),
      ins('account'),
      this.graphAll(`/${act}/insights`, cfg.token, { level: 'campaign', date_preset: 'maximum', fields: 'campaign_id,spend', limit: '500' }),
    ]);
    const value = { campaigns, adsets, ads, byCampaign, byAd, daily, account: account[0] ?? {}, lifetime, at: this.clock().toISOString() };
    if (this.metaCache.size > 50) this.metaCache.clear();
    this.metaCache.set(key, { at: this.clock().getTime(), value });
    return value;
  }

  /**
   * Tablero de la pauta propia: por campaña y por anuncio, cuánto se gastó,
   * qué trajo (visitas, registros, empresas, pagos) y cuánto costó cada cosa.
   * Meta se pide en vivo con caché; la base de BackOffice, siempre al día.
   */
  async overview(query: { range?: string; since?: string; until?: string; refresh?: string; days?: string }) {
    // Compatibilidad: ?days=7|14|30|90
    const q = query.range ? query : query.days ? (['7', '14', '30'].includes(String(query.days)) ? { range: String(query.days) } : { range: 'custom', since: '', until: '' }) : query;
    const cfg = await this.config();
    const now = this.clock();
    let account: { id: string; name: string; currency: string; timezone: string; status: number } | null = null;
    let error: { kind: string; message: string } | null = null;
    if (cfg) {
      try {
        const info = await this.graph(`/${cfg.accountId}`, cfg.token, { fields: 'name,currency,timezone_name,account_status' });
        account = { id: cfg.accountId, name: String(info.name ?? cfg.accountId), currency: String(info.currency ?? 'COP'), timezone: String(info.timezone_name ?? 'America/Bogota'), status: Number(info.account_status) };
      } catch (err: any) {
        error = metaErrorKind(Number(err?.code) || 0, String(err?.message ?? '').replace(/^Meta: /, ''));
      }
    }
    const tz = account?.timezone ?? 'America/Bogota';
    const currency = account?.currency ?? 'COP';
    const range = rangeFor(q, tz, now);
    const money = (n: number) => new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: currency === 'COP' ? 0 : 2 }).format(n);

    let meta: any = null;
    if (cfg && account) {
      try {
        meta = await this.readMeta(cfg, range, query.refresh === '1');
      } catch (err: any) {
        error = metaErrorKind(Number(err?.code) || 0, String(err?.message ?? '').replace(/^Meta: /, ''));
        this.logger.warn(`resultados: ${error.message}`);
      }
    }

    // ── BackOffice: registros del rango y lo que pagaron esas empresas
    const sessions: SessionLite[] = await this.prisma.signupSession.findMany({
      where: { createdAt: { gte: range.start, lt: range.end } }, orderBy: { createdAt: 'desc' }, take: 20000,
    });
    const fromMeta = sessions.filter(isFromMeta);
    const companyIds = [...new Set(fromMeta.map((s) => s.companyId).filter(Boolean))] as string[];
    const [companies, payments] = companyIds.length
      ? await Promise.all([
        this.prisma.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, name: true, status: true } }),
        this.prisma.payment.findMany({ where: { companyId: { in: companyIds }, provider: 'WOMPI', status: 'APPROVED', invoiceId: { not: null } }, select: { companyId: true, amountInCents: true, currency: true } }),
      ])
      : [[], []];
    const paid = new Map<string, number>();
    let otherCurrency = false;
    for (const p of payments as any[]) {
      const same = String(p.currency ?? 'COP').toUpperCase() === currency.toUpperCase();
      if (!same) otherCurrency = true;
      paid.set(p.companyId, (paid.get(p.companyId) ?? 0) + (same ? (Number(p.amountInCents) || 0) / 100 : 0));
    }
    const companyById = new Map((companies as any[]).map((c) => [c.id, c]));

    // ── Atribución
    const launches = (await this.launches()).filter((l) => l.ids.campaign && l.accountId === cfg?.accountId);
    const mappings = await this.mappings();
    const campaignsRaw: any[] = meta?.campaigns ?? [];
    const adsRaw: any[] = meta?.ads ?? [];
    const adLinks = adsRaw.map((a) => {
      const c = a?.creative ?? {};
      const spec = c.object_story_spec ?? {};
      const link = spec.link_data?.link ?? spec.link_data?.call_to_action?.value?.link ?? spec.video_data?.call_to_action?.value?.link ?? c.asset_feed_spec?.link_urls?.[0]?.website_url ?? null;
      return { id: String(a.id), name: String(a.name ?? a.id), campaignId: String(a.campaign_id), link, ...utmFromUrl(link, c.url_tags) };
    });
    const resolve = attributionResolver({
      campaigns: campaignsRaw.map((c) => ({ id: String(c.id), name: String(c.name ?? '') })),
      ads: adLinks,
      launches: launches.map((l) => ({ campaignId: l.ids.campaign as string, utmCampaign: l.utmCampaign })),
      mappings,
    });

    const byCampaign = new Map<string, { funnel: Funnel; byAd: Map<string, Funnel>; noAd: Funnel }>();
    const unattributed = new Map<string, { utmSource: string | null; utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; utmId: string | null; fbclid: boolean; funnel: Funnel }>();
    const total = emptyFunnel();
    const dailyDone = new Map<string, number>();
    const signups: any[] = [];
    const campaignName = new Map(campaignsRaw.map((c) => [String(c.id), String(c.name ?? c.id)]));
    const adName = new Map(adLinks.map((a) => [a.id, a.name]));
    for (const s of fromMeta) {
      addToFunnel(total, s, paid);
      const at = resolve(s);
      if (at.campaignId) {
        const c = byCampaign.get(at.campaignId) ?? { funnel: emptyFunnel(), byAd: new Map(), noAd: emptyFunnel() };
        addToFunnel(c.funnel, s, paid);
        if (at.adId) {
          const f = c.byAd.get(at.adId) ?? emptyFunnel();
          addToFunnel(f, s, paid);
          c.byAd.set(at.adId, f);
        } else addToFunnel(c.noAd, s, paid);
        byCampaign.set(at.campaignId, c);
      } else {
        const k = norm(s.utmCampaign) || '(sin utm_campaign)';
        const u = unattributed.get(k) ?? { utmSource: s.utmSource ?? null, utmMedium: s.utmMedium ?? null, utmCampaign: s.utmCampaign ?? null, utmContent: s.utmContent ?? null, utmId: s.utmId ?? null, fbclid: !!s.fbclid, funnel: emptyFunnel() };
        addToFunnel(u.funnel, s, paid);
        unattributed.set(k, u);
      }
      if (s.step === 'DONE') {
        const d = dayIn(new Date(s.createdAt), tz);
        dailyDone.set(d, (dailyDone.get(d) ?? 0) + 1);
      }
      if (s.step === 'DONE' || s.companyId) {
        const co = s.companyId ? companyById.get(s.companyId) : null;
        signups.push({
          id: s.id, createdAt: s.createdAt, companyId: s.companyId ?? null, companyName: co?.name ?? s.businessName ?? null, rubro: s.rubro ?? null,
          status: s.companyId && paid.has(s.companyId) ? 'PAGÓ' : co?.status === 'ACTIVE' ? 'ACTIVA' : co?.status ?? 'SIN EMPRESA',
          campaignId: at.campaignId, campaignName: at.campaignId ? campaignName.get(at.campaignId) ?? at.campaignId : null,
          adId: at.adId, adName: at.adId ? adName.get(at.adId) ?? at.adId : null, via: at.via ? VIA_LABEL[at.via] : null,
          utmCampaign: s.utmCampaign ?? null, utmContent: s.utmContent ?? null,
        });
      }
    }

    // ── Meta por campaña y por anuncio
    const insC = new Map<string, any>((meta?.byCampaign ?? []).map((r: any) => [String(r.campaign_id), r]));
    const insA = new Map<string, any>((meta?.byAd ?? []).map((r: any) => [String(r.ad_id), r]));
    const life = new Map<string, number>((meta?.lifetime ?? []).map((r: any) => [String(r.campaign_id), Number(r.spend) || 0]));
    const adsetsOf = new Map<string, any[]>();
    for (const s of meta?.adsets ?? []) adsetsOf.set(String(s.campaign_id), [...(adsetsOf.get(String(s.campaign_id)) ?? []), s]);
    const launchOf = new Map(launches.map((l) => [l.ids.campaign as string, l]));
    const fromMinorC = (v: unknown) => fromMinor(v, currency);

    const campaigns = campaignsRaw.map((c) => {
      const id = String(c.id);
      const sets = adsetsOf.get(id) ?? [];
      const sum = (k: string) => sets.reduce((acc, x) => acc + (fromMinorC(x[k]) ?? 0), 0);
      const dailyBudget = fromMinorC(c.daily_budget) ?? (sum('daily_budget') || null);
      const lifetimeBudget = fromMinorC(c.lifetime_budget) ?? (sum('lifetime_budget') || null);
      const startsAt = c.start_time ?? (sets.map((x) => x.start_time).filter(Boolean).sort()[0] ?? null);
      const ends = sets.map((x) => x.end_time);
      const endsAt = c.stop_time ?? (ends.length && ends.every(Boolean) ? ends.sort().slice(-1)[0] : null);
      const m = metaRow(insC.get(id));
      const att = byCampaign.get(id) ?? { funnel: emptyFunnel(), byAd: new Map(), noAd: emptyFunnel() };
      const delivery = deliveryOf(c, { now, endsAt, startsAt, budgetRemaining: c.lifetime_budget ? fromMinorC(c.budget_remaining) : null });
      const ads = adLinks.filter((a) => a.campaignId === id).map((a) => {
        const raw = adsRaw.find((x) => String(x.id) === a.id);
        const am = metaRow(insA.get(a.id));
        const f = att.byAd.get(a.id) ?? emptyFunnel();
        return {
          id: a.id, name: a.name, utmContent: a.utmContent ?? null, link: a.link ?? null,
          delivery: deliveryOf(raw, { now, endsAt }), metrics: am, funnel: f, derived: derived(am.spend, am, f),
        };
      }).sort((x, y) => y.metrics.spend - x.metrics.spend);
      const utms = [...new Set([
        ...(launchOf.get(id) ? [launchOf.get(id)!.utmCampaign] : []),
        ...(mappings[id] ?? []),
        ...adLinks.filter((a) => a.campaignId === id && a.utmCampaign).map((a) => a.utmCampaign as string),
      ])];
      return {
        id, name: String(c.name ?? id), status: c.status, effectiveStatus: c.effective_status, objective: c.objective, delivery,
        launchId: launchOf.get(id)?.id ?? null, utms, manualUtms: mappings[id] ?? [],
        metrics: m, funnel: att.funnel, unmatchedAds: att.noAd, derived: derived(m.spend, m, att.funnel),
        pace: paceOf({ dailyBudget, lifetimeBudget, spent: life.get(id) ?? m.spend, startsAt, endsAt, tz, now }),
        endsAt, ads,
      };
    }).filter((c) => c.metrics.spend > 0 || c.funnel.visits > 0 || ['ACTIVE', 'IN_REVIEW', 'SCHEDULED', 'REJECTED', 'NO_BUDGET', 'ISSUES'].includes(c.delivery.code))
      .sort((a, b) => b.metrics.spend - a.metrics.spend || b.funnel.visits - a.funnel.visits);

    // ── Totales
    const manual = (await this.manual()).filter((m) => m.date >= range.since && m.date <= range.until);
    const manualSpend = manual.reduce((s, m) => s + m.spend, 0);
    const acc = metaRow(meta?.account);
    const metaSpend = meta ? acc.spend : 0;
    const spend = metaSpend + manualSpend;
    const daily: Array<{ date: string; spend: number; results: number }> = [];
    const spendByDay = new Map<string, number>((meta?.daily ?? []).map((r: any) => [String(r.date_start), Number(r.spend) || 0]));
    for (let d = range.since; d <= range.until; d = addDaysIso(d, 1)) {
      const manualDay = manual.filter((m) => m.date === d).reduce((s, m) => s + m.spend, 0);
      daily.push({ date: d, spend: Math.round((spendByDay.get(d) ?? 0) + manualDay), results: dailyDone.get(d) ?? 0 });
    }
    const thresholds = await this.thresholds();
    const alerts = meta ? alertsFor(campaigns.map((c) => ({
      id: c.id, name: c.name, delivery: c.delivery, spend: c.metrics.spend, completed: c.funnel.completed, frequency: c.metrics.frequency,
      impressions: c.metrics.impressions, ctr: c.derived.ctr, endsAt: c.endsAt, running: c.delivery.code === 'ACTIVE', ads: c.ads,
    })), thresholds, money, now) : [];
    const unattributedList = [...unattributed.values()].map((u) => {
      const ms = manual.filter((m) => norm(m.campaign) === norm(u.utmCampaign)).reduce((s, m) => s + m.spend, 0);
      return { ...u, manualSpend: ms, derived: derived(ms, { impressions: 0, linkClicks: 0 }, u.funnel) };
    }).sort((a, b) => b.funnel.visits - a.funnel.visits);

    return {
      range: { preset: range.preset, since: range.since, until: range.until, days: range.days, timezone: tz },
      connected: !!cfg,
      account,
      error,
      cachedAt: meta?.at ?? null,
      currency,
      totals: {
        spend: Math.round(spend), metaSpend: Math.round(metaSpend), manualSpend,
        impressions: acc.impressions, reach: acc.reach, frequency: acc.frequency, linkClicks: acc.linkClicks,
        funnel: total, derived: derived(spend, acc, total),
        visitsAll: sessions.length, revenueOtherCurrency: otherCurrency,
      },
      daily,
      campaigns,
      unattributed: unattributedList,
      signups: signups.slice(0, 300),
      alerts,
      thresholds,
      mappings,
      manual,
    };
  }

  async setStatus(actor: AuthUser, id: string, status: string, confirm?: boolean) {
    if (!['ACTIVE', 'PAUSED'].includes(status)) throw new BadRequestException('Estado inválido');
    if (!/^\d{5,30}$/.test(id)) throw new BadRequestException('Campaña inválida');
    // Activar gasta presupuesto: siempre con confirmación explícita
    if (status === 'ACTIVE' && confirm !== true) throw new BadRequestException('Activar gasta presupuesto: confirma la acción');
    const cfg = await this.config();
    if (!cfg) throw new BadRequestException('Conecta primero la cuenta publicitaria');
    await this.graph(`/${id}`, cfg.token, { status }, 'POST');
    await this.audit.log({ actor, action: 'ads.status', entity: 'MetaCampaign', entityId: id, detail: status === 'PAUSED' ? 'Campaña pausada' : 'Campaña activada' });
    const launch = (await this.launches()).find((l) => l.ids.campaign === id && l.status !== 'ARCHIVED' && l.ids.ad);
    if (launch && launch.status !== status) {
      launch.status = status as LaunchStatus;
      this.note(launch, actor, status === 'PAUSED' ? 'Pausada desde la tabla' : 'Campaña activada desde la tabla');
      await this.saveLaunch(launch);
    }
    return { ok: true, status };
  }

  // ───────────────────────── Lanzar campañas propias ─────────────────────────

  private now() {
    return new Date();
  }

  async prefs(): Promise<Prefs> {
    return parseJson<Prefs>(await this.setting(PREFS_KEY), {});
  }

  private async requireConfig() {
    const cfg = await this.config();
    if (!cfg) throw new BadRequestException('Conecta primero la cuenta publicitaria');
    return cfg;
  }

  private async accountInfo(cfg: { accountId: string; token: string }) {
    const info = await this.graph(`/${cfg.accountId}`, cfg.token, { fields: 'name,currency,timezone_name,account_status' });
    return { id: cfg.accountId, name: String(info.name ?? cfg.accountId), currency: String(info.currency ?? 'COP'), timezone: info.timezone_name ?? null, status: Number(info.account_status) };
  }

  /** Lo que necesita el asistente de lanzamiento: cuenta, páginas, tope y destino. */
  async setup() {
    const cfg = await this.config();
    const prefs = await this.prefs();
    const landingBase = await publicWebUrl(this.prisma);
    if (!cfg) return { connected: false, account: null, prefs, pages: [], pagesError: null, landingBase, goals: GOALS };
    let account: Awaited<ReturnType<MetaAdsService['accountInfo']>> | null = null;
    let pages: Array<{ id: string; name: string; instagramUserId: string | null }> = [];
    let pagesError: string | null = null;
    try {
      account = await this.accountInfo(cfg);
    } catch (err: any) {
      pagesError = err?.message ?? 'No se pudo leer la cuenta';
    }
    try {
      const res = await this.graph('/me/accounts', cfg.token, { fields: 'id,name,instagram_business_account{id}', limit: '100' });
      pages = (res?.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id), instagramUserId: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null }));
    } catch (err: any) {
      // Sin pages_show_list el token no lista páginas: se puede escribir el ID a mano
      pagesError = pagesError ?? `No pudimos listar las páginas (${err?.message ?? 'error'}). Escribe el ID de la página a mano.`;
    }
    return { connected: true, account, prefs, pages, pagesError, landingBase, goals: GOALS };
  }

  async savePrefs(actor: AuthUser, dto: any) {
    const pageId = String(dto?.pageId ?? '').trim();
    const instagramUserId = String(dto?.instagramUserId ?? '').trim();
    // El tope está en la moneda de la cuenta conectada
    const cfg = await this.config();
    const currency = cfg ? await this.accountInfo(cfg).then((a) => a.currency, () => 'COP') : 'COP';
    const max = parseAmount(dto?.maxDailyBudget, currency);
    if (pageId && !/^\d{5,25}$/.test(pageId)) throw new BadRequestException('El ID de la página son solo números');
    if (instagramUserId && !/^\d{5,25}$/.test(instagramUserId)) throw new BadRequestException('El ID de Instagram son solo números');
    if (!(max > 0)) throw new BadRequestException('Define el tope de presupuesto diario (mayor a 0)');
    const before = await this.prefs();
    const prefs: Prefs = { pageId: pageId || undefined, pageName: String(dto?.pageName ?? '').slice(0, 120) || undefined, instagramUserId: instagramUserId || undefined, maxDailyBudget: max };
    await this.put(PREFS_KEY, JSON.stringify(prefs));
    await this.audit.log({
      actor, action: 'ads.prefs', entity: 'PlatformSetting', entityId: PREFS_KEY,
      detail: `Página ${prefs.pageName ?? prefs.pageId ?? '—'} · tope diario ${before.maxDailyBudget ?? '—'} → ${max}`,
    });
    return prefs;
  }

  /** Sube la imagen a la biblioteca de la cuenta y devuelve el hash para el anuncio. */
  async uploadImage(actor: AuthUser, file?: { buffer: Buffer; size: number; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta una imagen');
    if (file.size > MAX_IMAGE) throw new BadRequestException('La imagen pesa más de 8 MB');
    const b = file.buffer;
    const ext = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'jpg' : b.subarray(0, 4).toString('hex') === '89504e47' ? 'png' : null;
    if (!ext) throw new BadRequestException('Usa una imagen JPG o PNG');
    const cfg = await this.requireConfig();
    const res = await this.graph(`/${cfg.accountId}/adimages`, cfg.token, { bytes: b.toString('base64'), name: `backoffice-${Date.now()}.${ext}` }, 'POST');
    const img: any = Object.values(res?.images ?? {})[0];
    if (!img?.hash) throw new BadRequestException('Meta no devolvió el identificador de la imagen');
    await this.audit.log({ actor, action: 'ads.image', entity: 'MetaAdImage', entityId: String(img.hash), detail: `${Math.round(file.size / 1024)} KB` });
    return { hash: String(img.hash), width: img.width ?? null, height: img.height ?? null };
  }

  /**
   * Sube el video a la biblioteca de la cuenta y devuelve su ID. Meta lo
   * procesa después (segundos a un par de minutos); el lanzamiento espera a
   * que esté listo antes de crear el creativo.
   */
  async uploadVideo(actor: AuthUser, file?: { buffer: Buffer; size: number; originalname?: string }) {
    if (!file?.buffer?.length) throw new BadRequestException('Adjunta un video');
    if (file.size > MAX_VIDEO) throw new BadRequestException('El video pesa más de 64 MB');
    // MP4 y MOV: la caja "ftyp" va en los bytes 4 a 8
    if (file.buffer.subarray(4, 8).toString('latin1') !== 'ftyp') throw new BadRequestException('Usa un video MP4 o MOV');
    const cfg = await this.requireConfig();
    const form = new FormData();
    form.append('access_token', cfg.token);
    form.append('name', `backoffice-${Date.now()}`);
    form.append('source', new Blob([new Uint8Array(file.buffer)], { type: 'video/mp4' }), 'anuncio.mp4');
    const res = await this.fetchImpl(`${graphVideoBase()}/${cfg.accountId}/advideos`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new BadRequestException(`Meta: ${data?.error?.message ?? `respondió ${res.status}`}`);
    if (!data?.id) throw new BadRequestException('Meta no devolvió el identificador del video');
    await this.audit.log({ actor, action: 'ads.video', entity: 'MetaAdVideo', entityId: String(data.id), detail: `${(file.size / 1048576).toFixed(1)} MB` });
    return { id: String(data.id) };
  }

  /** Estado de un video en Meta: listo o no, y su miniatura. */
  async videoStatus(id: string) {
    if (!/^\d{5,25}$/.test(id)) throw new BadRequestException('El ID del video son solo números');
    const cfg = await this.requireConfig();
    const v = await this.graph(`/${id}`, cfg.token, { fields: 'status,picture,length' });
    const status = String(v?.status?.video_status ?? '');
    return { id, ready: status === 'ready', failed: status === 'error', status, thumb: v?.picture ? String(v.picture) : null, seconds: typeof v?.length === 'number' ? Math.round(v.length) : null };
  }

  /** Espera a que Meta termine de procesar el video; devuelve su miniatura. */
  private async videoReady(id: string) {
    for (let i = 0; i < VIDEO_WAIT_TRIES; i++) {
      const v = await this.videoStatus(id);
      if (v.failed) throw new BadRequestException('Meta no pudo procesar el video: súbelo de nuevo (MP4, H.264, hasta 64 MB)');
      if (v.ready) return v.thumb;
      await this.wait(VIDEO_WAIT_MS);
    }
    throw new BadRequestException('Meta todavía está procesando el video. Espera un minuto y dale a Reintentar: no se duplica nada.');
  }

  private async context(cfg: { accountId: string; token: string }) {
    const [account, prefs, landingBase] = await Promise.all([this.accountInfo(cfg), this.prefs(), publicWebUrl(this.prisma)]);
    return {
      account,
      prefs,
      ctx: {
        currency: account.currency, timezone: account.timezone, pageId: prefs.pageId ?? null, instagramUserId: prefs.instagramUserId ?? null,
        landingBase, maxDailyBudget: prefs.maxDailyBudget ?? null, today: todayIn(account.timezone, this.now()),
      },
    };
  }

  private async checkDraft(dto: any) {
    const cfg = await this.requireConfig();
    const { account, ctx } = await this.context(cfg);
    const draft = draftFrom(dto, account.currency);
    const errors = validateLaunch(draft, ctx);
    const utm = slugify(draft.name);
    if (utm && (await this.launches()).some((l) => l.status !== 'ARCHIVED' && l.utmCampaign === utm)) {
      errors.push('Ya hay un lanzamiento con ese nombre: cámbialo para que el seguimiento no se mezcle');
    }
    return { cfg, account, ctx, draft, errors };
  }

  /** Revisión sin efectos: valida y muestra lo que se enviaría a Meta. */
  async preview(dto: any) {
    const { account, ctx, draft, errors } = await this.checkDraft(dto);
    const plan = errors.length ? null : buildLaunch(draft, ctx);
    return {
      valid: !errors.length,
      errors,
      account: { id: account.id, name: account.name, currency: account.currency },
      summary: plan && {
        goal: GOALS[draft.goal].label,
        utmCampaign: plan.utmCampaign,
        link: plan.link,
        dailyBudget: draft.dailyBudget,
        maxDailyBudget: ctx.maxDailyBudget,
        pageId: ctx.pageId,
        format: plan.format,
        // Todo se crea en pausa; nada gasta hasta activar
        status: 'PAUSED',
      },
      payload: plan && { campaign: plan.campaign, adset: plan.adset, creative: plan.creative, ad: plan.ad },
    };
  }

  async launches(): Promise<Launch[]> {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { startsWith: LAUNCH_PREFIX } } });
    return rows
      .map((r: any) => parseJson<Launch | null>(r.value, null))
      .filter((l: Launch | null): l is Launch => !!l)
      .sort((a: Launch, b: Launch) => b.createdAt.localeCompare(a.createdAt));
  }

  private async launch(id: string) {
    if (!/^[a-z0-9]{6,40}$/.test(id)) throw new NotFoundException('Lanzamiento no encontrado');
    const row = await this.prisma.platformSetting.findUnique({ where: { key: `${LAUNCH_PREFIX}${id}` } });
    const launch = parseJson<Launch | null>(row?.value, null);
    if (!row || !launch) throw new NotFoundException('Lanzamiento no encontrado');
    return { launch, raw: row.value as string };
  }

  private async saveLaunch(launch: Launch) {
    await this.put(`${LAUNCH_PREFIX}${launch.id}`, JSON.stringify(launch));
  }

  private note(launch: Launch, actor: AuthUser, event: string, detail?: string) {
    launch.history = [...(launch.history ?? []), { at: this.now().toISOString(), by: actor.name, event, ...(detail ? { detail } : {}) }].slice(-50);
  }

  /** Toma el lanzamiento con compare-and-set: dos clics a la vez no crean dos veces. */
  private async lock(id: string) {
    const { launch, raw } = await this.launch(id);
    if (launch.lockUntil && Date.parse(launch.lockUntil) > this.now().getTime()) throw new ConflictException('Este lanzamiento ya se está procesando');
    launch.lockUntil = new Date(this.now().getTime() + LOCK_MS).toISOString();
    const res = await this.prisma.platformSetting.updateMany({ where: { key: `${LAUNCH_PREFIX}${id}`, value: raw }, data: { value: JSON.stringify(launch) } });
    if (res.count !== 1) throw new ConflictException('Este lanzamiento ya se está procesando');
    return launch;
  }

  private async release(launch: Launch) {
    launch.lockUntil = null;
    await this.saveLaunch(launch);
    return launch;
  }

  /** Crea en Meta los pasos que falten (todo en PAUSA). Continúa donde quedó. */
  private async runSteps(actor: AuthUser, launch: Launch) {
    const cfg = await this.requireConfig();
    if (cfg.accountId !== launch.accountId) {
      launch.status = 'FAILED';
      launch.error = `La cuenta conectada (${cfg.accountId}) no es la del lanzamiento (${launch.accountId})`;
      return this.release(launch);
    }
    const { ctx } = await this.context(cfg);
    let plan = buildLaunch(launch.draft, { ...ctx, pageId: launch.pageId });
    const act = launch.accountId;
    try {
      for (const step of STEPS) {
        if (launch.ids[step]) continue;
        // El creativo de video necesita el video ya procesado (y su miniatura si no hay portada)
        if (step === 'creative' && launch.draft.videoId) {
          const videoThumb = await this.videoReady(launch.draft.videoId);
          plan = buildLaunch(launch.draft, { ...ctx, pageId: launch.pageId }, { videoThumb });
        }
        const params: Record<string, string> =
          step === 'campaign' ? plan.campaign
            : step === 'adset' ? { ...plan.adset, campaign_id: launch.ids.campaign! }
              : step === 'creative' ? plan.creative
                : { ...plan.ad, adset_id: launch.ids.adset!, creative: JSON.stringify({ creative_id: launch.ids.creative }) };
        const path = { campaign: 'campaigns', adset: 'adsets', creative: 'adcreatives', ad: 'ads' }[step];
        const res = await this.graph(`/${act}/${path}`, cfg.token, params, 'POST');
        if (!res?.id) throw new BadRequestException(`Meta no devolvió el ID (${step})`);
        launch.ids[step] = String(res.id);
        // Se guarda cada id apenas llega: un reintento no lo vuelve a crear
        await this.saveLaunch(launch);
      }
      launch.status = 'PAUSED';
      launch.error = null;
      this.note(launch, actor, 'Creada en Meta (en pausa)', `campaña ${launch.ids.campaign}`);
      await this.audit.log({ actor, action: 'ads.launch.create', entity: 'MetaCampaign', entityId: launch.ids.campaign!, detail: `${launch.draft.name} · ${GOALS[launch.draft.goal].label} (en pausa)` });
    } catch (err: any) {
      const done = STEPS.filter((s) => launch.ids[s]).length;
      launch.status = 'FAILED';
      launch.error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      this.note(launch, actor, `Falló en el paso ${done + 1} de 4`, launch.error);
      this.logger.warn(`launch ${launch.id}: ${launch.error}`);
    }
    return this.release(launch);
  }

  async createLaunch(actor: AuthUser, dto: any) {
    if (dto?.confirm !== true) throw new BadRequestException('Confirma la creación en Meta');
    const { cfg, account, ctx, draft, errors } = await this.checkDraft(dto?.draft ?? dto);
    if (errors.length) throw new BadRequestException({ message: 'Revisa el lanzamiento', errors });
    const now = this.now().toISOString();
    const launch: Launch = {
      id: randomBytes(9).toString('hex'),
      createdAt: now,
      createdBy: actor.name,
      status: 'CREATING',
      accountId: cfg.accountId,
      currency: account.currency,
      draft,
      utmCampaign: slugify(draft.name),
      link: buildLaunch(draft, ctx).link,
      pageId: ctx.pageId!,
      ids: {},
      error: null,
      lockUntil: new Date(Date.parse(now) + LOCK_MS).toISOString(),
      history: [{ at: now, by: actor.name, event: 'Lanzamiento preparado' }],
    };
    await this.prisma.platformSetting.create({ data: { key: `${LAUNCH_PREFIX}${launch.id}`, value: JSON.stringify(launch) } });
    return this.runSteps(actor, launch);
  }

  async retryLaunch(actor: AuthUser, id: string) {
    const current = (await this.launch(id)).launch;
    if (current.status !== 'FAILED') throw new BadRequestException('Solo se reintenta un lanzamiento que falló');
    const launch = await this.lock(id);
    launch.status = 'CREATING';
    this.note(launch, actor, 'Reintento');
    return this.runSteps(actor, launch);
  }

  /** Activa anuncio, conjunto y campaña (en ese orden: la campaña al final). */
  async activateLaunch(actor: AuthUser, id: string, dto: { confirm?: boolean }) {
    if (dto?.confirm !== true) throw new BadRequestException('Activar gasta presupuesto: confirma la acción');
    const current = (await this.launch(id)).launch;
    if (current.status !== 'PAUSED' || !current.ids.ad) throw new BadRequestException('Solo se activa un lanzamiento creado y en pausa');
    const prefs = await this.prefs();
    if (!prefs.maxDailyBudget || current.draft.dailyBudget > prefs.maxDailyBudget) {
      throw new BadRequestException(`El presupuesto (${current.draft.dailyBudget.toLocaleString('es-CO')}) supera el tope diario actual. Bájalo antes de activar.`);
    }
    const launch = await this.lock(id);
    const cfg = await this.requireConfig();
    try {
      for (const step of ['ad', 'adset', 'campaign'] as const) {
        await this.graph(`/${launch.ids[step]}`, cfg.token, { status: 'ACTIVE' }, 'POST');
      }
      launch.status = 'ACTIVE';
      launch.error = null;
      this.note(launch, actor, 'Activada', `${launch.draft.dailyBudget.toLocaleString('es-CO')} ${launch.currency} al día`);
      await this.audit.log({ actor, action: 'ads.launch.activate', entity: 'MetaCampaign', entityId: launch.ids.campaign!, detail: `${launch.draft.name} · ${launch.draft.dailyBudget} ${launch.currency}/día` });
    } catch (err: any) {
      // Si algo quedó a medias la campaña sigue en pausa (se activa de última)
      launch.error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      this.note(launch, actor, 'No se pudo activar', launch.error);
    }
    return this.release(launch);
  }

  async pauseLaunch(actor: AuthUser, id: string) {
    const current = (await this.launch(id)).launch;
    if (!current.ids.campaign || !['ACTIVE', 'PAUSED'].includes(current.status)) throw new BadRequestException('Este lanzamiento no tiene campaña creada');
    const launch = await this.lock(id);
    const cfg = await this.requireConfig();
    try {
      await this.graph(`/${launch.ids.campaign}`, cfg.token, { status: 'PAUSED' }, 'POST');
      launch.status = 'PAUSED';
      launch.error = null;
      this.note(launch, actor, 'Pausada');
      await this.audit.log({ actor, action: 'ads.launch.pause', entity: 'MetaCampaign', entityId: launch.ids.campaign!, detail: launch.draft.name });
    } catch (err: any) {
      launch.error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      this.note(launch, actor, 'No se pudo pausar', launch.error);
      await this.release(launch);
      throw new BadRequestException(launch.error);
    }
    return this.release(launch);
  }

  /** Cambia el presupuesto diario del conjunto. Subirlo exige confirmación. */
  async setLaunchBudget(actor: AuthUser, id: string, dto: { dailyBudget?: unknown; confirm?: boolean }) {
    const current = (await this.launch(id)).launch;
    if (!current.ids.adset || !['ACTIVE', 'PAUSED'].includes(current.status)) throw new BadRequestException('Este lanzamiento no tiene conjunto creado');
    const amount = parseAmount(dto?.dailyBudget, current.currency);
    if (!(amount > 0)) throw new BadRequestException('El presupuesto diario debe ser mayor a 0');
    const prefs = await this.prefs();
    if (!prefs.maxDailyBudget || amount > prefs.maxDailyBudget) throw new BadRequestException(`Supera el tope diario (${(prefs.maxDailyBudget ?? 0).toLocaleString('es-CO')} ${current.currency})`);
    if (amount > current.draft.dailyBudget && dto?.confirm !== true) throw new BadRequestException('Subir el presupuesto gasta más: confirma la acción');
    const launch = await this.lock(id);
    const cfg = await this.requireConfig();
    try {
      await this.graph(`/${launch.ids.adset}`, cfg.token, { daily_budget: String(toMinor(amount, launch.currency)) }, 'POST');
      const before = launch.draft.dailyBudget;
      launch.draft.dailyBudget = amount;
      launch.error = null;
      this.note(launch, actor, 'Presupuesto cambiado', `${before.toLocaleString('es-CO')} → ${amount.toLocaleString('es-CO')} ${launch.currency}`);
      await this.audit.log({ actor, action: 'ads.launch.budget', entity: 'MetaAdSet', entityId: launch.ids.adset!, detail: `${launch.draft.name} · ${before} → ${amount} ${launch.currency}/día` });
    } catch (err: any) {
      launch.error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      await this.release(launch);
      throw new BadRequestException(launch.error);
    }
    return this.release(launch);
  }

  /** Lo quita de la lista (no borra nada en Meta). Si está activo hay que pausarlo antes. */
  async archiveLaunch(actor: AuthUser, id: string) {
    const launch = await this.lock(id);
    if (launch.status === 'ACTIVE') {
      await this.release(launch);
      throw new BadRequestException('Pausa la campaña antes de archivarla');
    }
    launch.status = 'ARCHIVED';
    this.note(launch, actor, 'Archivado (no se borró nada en Meta)');
    await this.audit.log({ actor, action: 'ads.launch.archive', entity: 'PlatformSetting', entityId: `${LAUNCH_PREFIX}${id}`, detail: launch.draft.name });
    return this.release(launch);
  }

  /** Lo que se muestra: sin token ni datos internos del candado. */
  view(l: Launch) {
    const { lockUntil, ...rest } = l;
    return { ...rest, processing: !!lockUntil && Date.parse(lockUntil) > this.now().getTime(), goalLabel: GOALS[l.draft.goal]?.label ?? l.draft.goal };
  }
}

@Controller('platform/ads')
export class MetaAdsController {
  constructor(private readonly ads: MetaAdsService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  overview(@Query() query: { range?: string; since?: string; until?: string; refresh?: string; days?: string }) {
    return this.ads.overview(query);
  }

  @Put('mappings')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  setMapping(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.setMapping(user, dto);
  }

  @Get('alerts')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  thresholds() {
    return this.ads.thresholds();
  }

  @Put('alerts')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  saveThresholds(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.saveThresholds(user, dto);
  }

  @Post('connect')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  connect(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.connect(user, dto);
  }

  @Delete('connect')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  disconnect(@CurrentUser() user: AuthUser) {
    return this.ads.disconnect(user);
  }

  @Post('manual')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  addManual(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.addManual(user, dto);
  }

  @Delete('manual/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  removeManual(@Param('id') id: string) {
    return this.ads.removeManual(id);
  }

  @Post('campaigns/:id/status')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  status(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.ads.setStatus(user, id, String(dto?.status ?? ''), dto?.confirm === true);
  }

  @Get('setup')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  setup() {
    return this.ads.setup();
  }

  @Put('setup')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  savePrefs(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.savePrefs(user, dto);
  }

  @Post('images')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE } }))
  uploadImage(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    return this.ads.uploadImage(user, file);
  }

  @Post('videos')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_VIDEO } }))
  uploadVideo(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File) {
    return this.ads.uploadVideo(user, file);
  }

  @Get('videos/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  videoStatus(@Param('id') id: string) {
    return this.ads.videoStatus(id);
  }

  @Get('launches')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async launches() {
    return (await this.ads.launches()).filter((l) => l.status !== 'ARCHIVED').map((l) => this.ads.view(l));
  }

  @Post('launches/preview')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  preview(@Body() dto: any) {
    return this.ads.preview(dto?.draft ?? dto);
  }

  @Post('launches')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.ads.view(await this.ads.createLaunch(user, dto));
  }

  @Post('launches/:id/retry')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async retry(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ads.view(await this.ads.retryLaunch(user, id));
  }

  @Post('launches/:id/activate')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async activate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.ads.view(await this.ads.activateLaunch(user, id, dto));
  }

  @Post('launches/:id/pause')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async pause(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ads.view(await this.ads.pauseLaunch(user, id));
  }

  @Put('launches/:id/budget')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async budget(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.ads.view(await this.ads.setLaunchBudget(user, id, dto));
  }

  @Delete('launches/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  async archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ads.view(await this.ads.archiveLaunch(user, id));
  }
}

@Module({
  imports: [AuditModule],
  controllers: [MetaAdsController],
  providers: [MetaAdsService],
  exports: [MetaAdsService],
})
export class MetaAdsModule {}
