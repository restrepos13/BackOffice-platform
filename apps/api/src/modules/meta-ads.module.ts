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
import { toMinor } from '../common/ads/provider';
import { GOALS, LaunchDraft, buildLaunch, draftFrom, parseAmount, slugify, todayIn, validateLaunch } from '../common/ads/launch';
import { AuditModule, AuditService } from './audit.module';

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
const CFG_KEY = 'META_ADS_CONFIG';
const MANUAL_KEY = 'META_ADS_MANUAL';
const PREFS_KEY = 'META_ADS_PREFS';
const LAUNCH_PREFIX = 'META_ADS_LAUNCH:';
const STEPS = ['campaign', 'adset', 'creative', 'ad'] as const;
const LOCK_MS = 2 * 60_000;
const MAX_IMAGE = 8 * 1024 * 1024;
const META_SOURCES = ['facebook', 'instagram', 'fb', 'ig', 'meta', 'messenger'];

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
    if (!res.ok || data?.error) throw new BadRequestException(`Meta: ${data?.error?.message ?? `respondió ${res.status}`}`);
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

  /** Registros que llegaron desde Meta en el rango, por campaña. */
  private async attribution(since: Date) {
    const rows = await this.prisma.signupSession.findMany({ where: { createdAt: { gte: since } }, take: 5000 });
    const fromMeta = rows.filter((r: any) => META_SOURCES.includes(String(r.utmSource ?? '').toLowerCase()) || /facebook|instagram|fb\.com|l\.instagram/i.test(String(r.referrer ?? '')));
    const byCampaign = new Map<string, { sessions: number; done: number }>();
    for (const r of fromMeta) {
      const key = (r.utmCampaign ?? '(sin campaña)').toLowerCase();
      const c = byCampaign.get(key) ?? { sessions: 0, done: 0 };
      c.sessions++;
      if (r.step === 'DONE') c.done++;
      byCampaign.set(key, c);
    }
    return {
      totalSessions: rows.length,
      metaSessions: fromMeta.length,
      metaDone: fromMeta.filter((r: any) => r.step === 'DONE').length,
      byCampaign,
    };
  }

  async overview(query: { days?: string }) {
    const days = [7, 14, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const since = new Date(Date.now() - days * 86400e3);
    const sinceDay = since.toISOString().slice(0, 10);
    const attr = await this.attribution(since);
    const manual = (await this.manual()).filter((m) => m.date >= sinceDay);
    const cfg = await this.config();
    // Las campañas lanzadas desde aquí se cruzan por su utm_campaign exacto
    const launched = new Map((await this.launches()).filter((l) => l.ids.campaign).map((l) => [l.ids.campaign as string, l]));

    let account: any = null;
    let campaigns: any[] = [];
    let error: string | null = null;
    if (cfg) {
      try {
        const [info, list, insights] = await Promise.all([
          this.graph(`/${cfg.accountId}`, cfg.token, { fields: 'name,currency,account_status,amount_spent' }),
          this.graph(`/${cfg.accountId}/campaigns`, cfg.token, { fields: 'id,name,status,effective_status,objective', limit: '50' }),
          this.graph(`/${cfg.accountId}/insights`, cfg.token, {
            level: 'campaign',
            fields: 'campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,actions',
            time_range: JSON.stringify({ since: sinceDay, until: new Date().toISOString().slice(0, 10) }),
            limit: '100',
          }),
        ]);
        account = { id: cfg.accountId, name: info.name, currency: info.currency, status: info.account_status };
        const ins = new Map((insights?.data ?? []).map((r: any) => [String(r.campaign_id), r]));
        campaigns = (list?.data ?? []).map((c: any) => {
          const r: any = ins.get(String(c.id)) ?? {};
          const action = (type: RegExp) => (r.actions ?? []).filter((a: any) => type.test(a.action_type)).reduce((s: number, a: any) => s + Number(a.value || 0), 0);
          const launch = launched.get(String(c.id));
          const attributed = attr.byCampaign.get(launch?.utmCampaign ?? String(c.name).toLowerCase()) ?? { sessions: 0, done: 0 };
          const spend = Number(r.spend ?? 0);
          return {
            id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status, objective: c.objective, launchId: launch?.id ?? null,
            spend, impressions: Number(r.impressions ?? 0), reach: Number(r.reach ?? 0), clicks: Number(r.clicks ?? 0),
            ctr: Number(r.ctr ?? 0), cpc: Number(r.cpc ?? 0),
            leads: action(/lead/), conversations: action(/messaging_conversation_started/), linkClicks: action(/^link_click$/),
            signups: attributed.sessions, companies: attributed.done,
            costPerSignup: attributed.sessions ? Math.round(spend / attributed.sessions) : null,
            costPerCompany: attributed.done ? Math.round(spend / attributed.done) : null,
          };
        }).sort((a: any, b: any) => b.spend - a.spend);
      } catch (err: any) {
        error = err?.message ?? 'No se pudo leer Meta';
        this.logger.warn(`overview: ${error}`);
      }
    }
    const manualSpend = manual.reduce((s, m) => s + m.spend, 0);
    const metaSpend = campaigns.reduce((s, c) => s + c.spend, 0);
    const spend = metaSpend + manualSpend;
    return {
      days,
      connected: !!cfg,
      account,
      error,
      campaigns,
      manual,
      totals: {
        spend: Math.round(spend),
        signupsFromMeta: attr.metaSessions,
        companiesFromMeta: attr.metaDone,
        signupsTotal: attr.totalSessions,
        costPerSignup: attr.metaSessions ? Math.round(spend / attr.metaSessions) : null,
        costPerCompany: attr.metaDone ? Math.round(spend / attr.metaDone) : null,
      },
      attribution: [...attr.byCampaign.entries()].map(([campaign, v]) => ({ campaign, ...v })),
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
    const plan = buildLaunch(launch.draft, { ...ctx, pageId: launch.pageId });
    const act = launch.accountId;
    try {
      for (const step of STEPS) {
        if (launch.ids[step]) continue;
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
  overview(@Query() query: { days?: string }) {
    return this.ads.overview(query);
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
})
export class MetaAdsModule {}
