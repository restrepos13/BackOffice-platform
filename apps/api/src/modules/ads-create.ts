import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Inject, Injectable, Logger, NotFoundException, Optional, Param, Post, Put, Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { hasProduct } from '../common/products';
import { decryptSecret } from '../common/crypto';
import { ensureFile } from '../common/file-store';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { readCompanyKey, recordAiUsage } from '../ai/ai-access';
import { VISION_MODEL } from '../ai/vision';
import { addDays, FetchLike } from '../common/ads/provider';
import { accessFrom, classifyMetaError, metaAdsVersion } from '../common/ads/meta-ads-provider';
import { todayIn, parseAmount } from '../common/ads/launch';
import {
  CLIENT_CTAS, CLIENT_GOALS, ClientDraft, buildClientLaunch, clientDraftFrom, planHints, validateClientDraft,
} from '../common/ads/client-launch';
import { checkCopy, checkImage, decodeImage, measure, scoreOf, thumbnailJpeg, CheckItem, ImageFacts } from '../common/ads/creative-check';
import { AiReview, normalizeReview, reviewMessages } from '../common/ads/creative-ai';

/**
 * Crear anuncios completos desde Ads, de la mano de la plataforma:
 *  1. Preparación: cuentas, permisos reales, páginas, tope de gasto y
 *     recomendaciones por código con el historial de la cuenta.
 *  2. Revisión del anuncio: SIEMPRE por código (gratis) y, si la empresa tiene
 *     su propia llave de IA, también con IA (lo paga a su proveedor).
 *  3. Creación en Meta TODO EN PAUSA (imagen → campaña → conjunto → creativo →
 *     anuncio). Activar es otra decisión, con confirmación y dentro del tope.
 *  4. La semana: qué conjuntos corren cada día (los de BackOffice y los que
 *     se crearon en Meta), con sus fechas de inicio y fin.
 */

type Step = 'campaign' | 'adset' | 'creative' | 'ad';
const STEPS: Step[] = ['campaign', 'adset', 'creative', 'ad'];
const PATHS: Record<Step, string> = { campaign: 'campaigns', adset: 'adsets', creative: 'adcreatives', ad: 'ads' };
const LOCK_MS = 2 * 60_000;
/** Modelo de visión para revisar anuncios (configurable en Dev Tools). */
const ADS_VISION_KEY = 'ADS_VISION_MODEL';

export interface ReviewResult {
  code: { score: number; items: CheckItem[]; facts: ImageFacts | null };
  ai:
    | { status: 'OK'; model: string; review: AiReview; billedTo: 'BYOK' }
    | { status: 'NO_KEY' | 'UNAVAILABLE' | 'ERROR'; message: string };
  at: string;
}

@Injectable()
export class AdsCreateService {
  private readonly logger = new Logger('AdsCreate');
  fetchImpl: FetchLike = (u, i) => fetch(u, i) as any;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  /* ── Empresa, cuenta y Graph ── */

  private async company(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    if (!isPlatformRole(user.role) && !hasProduct(c, 'ADS')) throw new ForbiddenException('Ads Intelligence no está activo');
    return c;
  }

  private async account(companyId: string, accountId?: string) {
    const accounts = await this.prisma.adAccount.findMany({ where: { companyId, mode: 'REAL', status: { not: 'DISCONNECTED' } }, orderBy: { createdAt: 'asc' } });
    const a = accountId ? accounts.find((x) => x.id === accountId) : accounts[0];
    if (accountId && !a) throw new NotFoundException('Cuenta publicitaria no encontrada');
    return { a: a ?? null, accounts };
  }

  private token(a: { tokenEnc: string | null }) {
    if (!a.tokenEnc) throw new BadRequestException('La cuenta no tiene una conexión vigente. Vuelve a conectarla.');
    try {
      return decryptSecret(a.tokenEnc);
    } catch {
      throw new BadRequestException('No se pudo leer la conexión guardada. Vuelve a conectarla.');
    }
  }

  private async graph(path: string, token: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
    const url = `https://graph.facebook.com/${metaAdsVersion()}${path}`;
    const body = new URLSearchParams({ ...params, access_token: token });
    let res;
    try {
      res = method === 'GET'
        ? await this.fetchImpl(`${url}?${body}`)
        : await this.fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
    } catch (e: any) {
      throw new BadRequestException(`No se pudo contactar a Meta: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) throw new BadRequestException(classifyMetaError(data?.error, res.status).message);
    return data;
  }

  private async maxDailyBudget(companyId: string) {
    return (await this.prisma.adSettings.findUnique({ where: { companyId } }))?.maxDailyBudget ?? null;
  }

  /* ── 1. Preparación ── */

  async setup(user: AuthUser, q: { companyId?: string; accountId?: string }) {
    const c = await this.company(user, q.companyId);
    const { a, accounts } = await this.account(c.id, q.accountId);
    const aiKey = !!readCompanyKey(c.deepinfraApiKey);
    const base = {
      accounts: accounts.map((x) => ({ id: x.id, name: x.name, externalId: x.externalId, currency: x.currency, access: accessFrom(parseJson<string[]>(x.scopesJson, [])) })),
      goals: Object.entries(CLIENT_GOALS).map(([key, g]) => ({ key, label: g.label, resultLabel: g.resultLabel })),
      ctas: Object.entries(CLIENT_CTAS).map(([key, label]) => ({ key, label })),
      maxDailyBudget: await this.maxDailyBudget(c.id),
      ai: {
        available: aiKey && !!this.ai,
        provider: 'DeepInfra',
        model: await this.visionModel(),
        note: aiKey
          ? 'La revisión con IA usa la llave de IA de tu empresa: lo que consuma lo cobra tu proveedor directamente, aparte de BackOffice.'
          : 'Tu empresa no tiene configurado un proveedor de IA. La revisión se hará solo con reglas (código): sirve, pero no entiende la imagen ni la oferta como lo haría una IA.',
      },
    };
    if (!a) return { ...base, account: null, pages: [], pagesError: null, today: todayIn(c.timezone, this.now()), hints: null };
    let pages: Array<{ id: string; name: string; instagramUserId: string | null }> = [];
    let pagesError: string | null = null;
    try {
      const res = await this.graph('/me/accounts', this.token(a), { fields: 'id,name,instagram_business_account{id}', limit: '100' });
      pages = (res?.data ?? []).map((p: any) => ({ id: String(p.id), name: String(p.name ?? p.id), instagramUserId: p.instagram_business_account?.id ? String(p.instagram_business_account.id) : null }));
      if (!pages.length) pagesError = 'Tu conexión no ve ninguna página de Facebook. Asígnale la página al usuario del sistema (o escribe su ID).';
    } catch (err: any) {
      pagesError = `No pudimos listar tus páginas: ${String(err?.message ?? 'error').replace(/\.$/, '')}. Escribe el ID de la página a mano.`;
    }
    const since = addDays(todayIn(a.timezone, this.now()), -60);
    const rows = await this.prisma.adInsightDaily.findMany({ where: { companyId: c.id, accountId: a.id, level: 'AD', date: { gte: since } } });
    return {
      ...base,
      account: { id: a.id, name: a.name, externalId: a.externalId, currency: a.currency, timezone: a.timezone, access: accessFrom(parseJson<string[]>(a.scopesJson, [])) },
      pages, pagesError,
      today: todayIn(a.timezone, this.now()),
      hints: { WHATSAPP: planHints(rows, 'WHATSAPP', null), WEBSITE: planHints(rows, 'WEBSITE', null) },
    };
  }

  /** Solo el tope diario (sin tocar el resto de la configuración de Autopilot). */
  async setBudgetCap(user: AuthUser, dto: { maxDailyBudget?: unknown }, companyId?: string) {
    const c = await this.company(user, companyId);
    const max = parseAmount(dto?.maxDailyBudget, c.currency || 'COP');
    if (!(max > 0)) throw new BadRequestException('El tope diario debe ser mayor a 0');
    const before = await this.maxDailyBudget(c.id);
    await this.prisma.adSettings.upsert({
      where: { companyId: c.id },
      update: { maxDailyBudget: max, updatedBy: user.name, updatedAt: this.now() },
      create: { companyId: c.id, maxDailyBudget: max, updatedBy: user.name, updatedAt: this.now() },
    });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ads.budget_cap', entity: 'AdSettings', entityId: c.id, detail: `${before ?? '—'} → ${max}` });
    return { maxDailyBudget: max };
  }

  /* ── 2. Revisión del anuncio ── */

  private async visionModel() {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: ADS_VISION_KEY } }).catch(() => null);
    return row?.value?.trim() || process.env[ADS_VISION_KEY] || VISION_MODEL;
  }

  private async assetBytes(companyId: string, assetId: string) {
    const asset = await this.prisma.brandAsset.findUnique({ where: { id: String(assetId ?? '') } });
    if (!asset || asset.companyId !== companyId) throw new NotFoundException('Imagen no encontrada en tu biblioteca');
    if (asset.kind !== 'IMAGE' || !/^image\/(jpe?g|png)$/.test(asset.mimeType)) throw new BadRequestException('El anuncio necesita una imagen JPG o PNG');
    const path = await ensureFile(this.prisma, companyId, asset.fileName);
    if (!path) throw new NotFoundException('No encontramos el archivo de la imagen: súbela de nuevo');
    return { asset, buffer: await readFile(path) };
  }

  async review(user: AuthUser, dto: any, companyId?: string): Promise<ReviewResult> {
    const c = await this.company(user, companyId);
    const draft = clientDraftFrom(dto?.draft ?? {}, c.currency || 'COP');
    let facts: ImageFacts | null = null;
    let decoded: ReturnType<typeof decodeImage> = null;
    const items: CheckItem[] = [];
    if (dto?.assetId) {
      const { buffer } = await this.assetBytes(c.id, dto.assetId);
      decoded = decodeImage(buffer);
      if (!decoded) items.push({ key: 'formato', area: 'IMAGEN', level: 'BAD', title: 'No pudimos leer la imagen', detail: 'El archivo está dañado o no es un JPG/PNG válido.', fix: 'Expórtala de nuevo en JPG o PNG.' });
      else {
        facts = measure(decoded, buffer.length, decoded.format);
        items.push(...checkImage(facts));
      }
    } else {
      items.push({ key: 'imagen', area: 'IMAGEN', level: 'BAD', title: 'Falta la imagen', detail: 'Sube la imagen publicitaria para revisarla.' });
    }
    items.push(...checkCopy({ goal: draft.goal, primaryText: draft.primaryText, headline: draft.headline, description: draft.description }));
    const code = { score: scoreOf(items), items, facts };
    const at = this.now().toISOString();

    const apiKey = readCompanyKey(c.deepinfraApiKey);
    if (!apiKey) return { code, ai: { status: 'NO_KEY', message: 'Sin proveedor de IA configurado: esta revisión es solo por reglas.' }, at };
    if (!this.ai) return { code, ai: { status: 'UNAVAILABLE', message: 'El motor de IA no está disponible en este momento.' }, at };
    const model = await this.visionModel();
    try {
      const dataUrl = decoded ? `data:image/jpeg;base64,${thumbnailJpeg(decoded).toString('base64')}` : null;
      const audience = `${draft.countries.join(', ') || '—'} · ${draft.advantageAudience ? 'público Advantage+ (Meta amplía)' : `${draft.ageMin}-${draft.ageMax} años`}`;
      const result = await this.ai.chat({
        apiKey, model, temperature: 0.3, maxTokens: 900, jsonMode: true,
        messages: reviewMessages({ business: c.name, industry: c.industry ?? null, goal: draft.goal, primaryText: draft.primaryText, headline: draft.headline, description: draft.description, audience, facts }, dataUrl) as any,
      });
      // Lo que consumió queda en «Consumo IA» como cualquier respuesta, pagado por la empresa
      await recordAiUsage(this.prisma, { companyId: c.id, model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, billedTo: 'BYOK', purpose: 'ads.creative' });
      const review = normalizeReview(extractJson(result.content));
      if (!review) return { code, ai: { status: 'ERROR', message: 'La IA respondió en un formato que no se pudo leer. Queda la revisión por reglas.' }, at };
      return { code, ai: { status: 'OK', model, review, billedTo: 'BYOK' }, at };
    } catch (err: any) {
      const status = err?.providerStatus;
      const message = status === 401 || status === 403 ? 'Tu proveedor de IA rechazó la llave: revísala en Configuración.'
        : status === 402 ? 'Tu cuenta de IA no tiene saldo.'
          : `La IA no respondió (${String(err?.message ?? 'error').slice(0, 120)}).`;
      return { code, ai: { status: 'ERROR', message: `${message} Queda la revisión por reglas.` }, at };
    }
  }

  /* ── 3. Crear en Meta (en pausa), activar, pausar ── */

  private async context(c: any, a: any, dto: any) {
    const max = await this.maxDailyBudget(c.id);
    const pageId = /^\d{5,25}$/.test(String(dto?.pageId ?? '')) ? String(dto.pageId) : null;
    const instagramUserId = /^\d{5,25}$/.test(String(dto?.instagramUserId ?? '')) ? String(dto.instagramUserId) : null;
    return { currency: a.currency, timezone: a.timezone, pageId, instagramUserId, maxDailyBudget: max, today: todayIn(a.timezone, this.now()) };
  }

  private assertCanManage(a: any) {
    const access = accessFrom(parseJson<string[]>(a.scopesJson, []));
    if (access.verified && !access.manage) {
      throw new BadRequestException(access.accountRoleLimited
        ? 'Tu conexión solo puede ver resultados en esa cuenta: dale «Control total» al usuario del token y vuelve a conectarla.'
        : `Tu conexión no tiene permiso para crear anuncios (faltan: ${access.missing.join(', ') || 'ads_management'}). Vuelve a conectarla con permisos completos.`);
    }
  }

  async preview(user: AuthUser, dto: any, companyId?: string) {
    const c = await this.company(user, companyId);
    const { a } = await this.account(c.id, dto?.accountId);
    if (!a) throw new BadRequestException('Conecta primero tu cuenta publicitaria');
    const draft = clientDraftFrom(dto?.draft ?? {}, a.currency);
    const ctx = await this.context(c, a, dto);
    const errors = validateClientDraft(draft, { ...ctx, hasImage: !!dto?.assetId });
    const plan = errors.length ? null : buildClientLaunch(draft, { ...ctx, imageHash: '(se sube al crear)' });
    const since = addDays(ctx.today, -60);
    const rows = await this.prisma.adInsightDaily.findMany({ where: { companyId: c.id, accountId: a.id, level: 'AD', date: { gte: since } } });
    return {
      valid: !errors.length, errors,
      summary: plan && {
        goal: CLIENT_GOALS[draft.goal].label, link: plan.link, dailyBudget: draft.dailyBudget, currency: a.currency,
        maxDailyBudget: ctx.maxDailyBudget, startDate: draft.startDate ?? null, endDate: draft.endDate ?? null, status: 'PAUSED',
      },
      hints: planHints(rows, draft.goal, draft.dailyBudget),
    };
  }

  private history(l: any, by: string, event: string, detail?: string) {
    const h = parseJson<any[]>(l.historyJson, []);
    return JSON.stringify([...h, { at: this.now().toISOString(), by, event, ...(detail ? { detail } : {}) }].slice(-50));
  }

  /** Candado compare-and-set: dos clics a la vez no crean ni activan dos veces. */
  private async lock(companyId: string, id: string) {
    const now = this.now();
    const r = await this.prisma.adLaunch.updateMany({
      where: { id, companyId, OR: [{ lockUntil: null }, { lockUntil: { isSet: false } }, { lockUntil: { lt: now } }] },
      data: { lockUntil: new Date(now.getTime() + LOCK_MS) },
    });
    if (r.count !== 1) throw new ConflictException('Este anuncio ya se está procesando');
    return this.prisma.adLaunch.findUniqueOrThrow({ where: { id } });
  }

  async create(user: AuthUser, dto: any, companyId?: string) {
    if (dto?.confirm !== true) throw new BadRequestException('Confirma la creación en Meta');
    const c = await this.company(user, companyId);
    const { a } = await this.account(c.id, dto?.accountId);
    if (!a) throw new BadRequestException('Conecta primero tu cuenta publicitaria');
    this.assertCanManage(a);
    const draft = clientDraftFrom(dto?.draft ?? {}, a.currency);
    const ctx = await this.context(c, a, dto);
    const errors = validateClientDraft(draft, { ...ctx, hasImage: !!dto?.assetId });
    if (errors.length) throw new BadRequestException({ message: 'Revisa el anuncio', errors });
    const { asset } = await this.assetBytes(c.id, dto.assetId); // existe y es una imagen válida de la empresa
    // Si viene de Creative: el diseño es de la empresa y la imagen es una exportación de ESE diseño
    let designId: string | null = null;
    if (dto?.designId) {
      const design = await this.prisma.creativeDesign.findUnique({ where: { id: String(dto.designId) } });
      if (!design || design.companyId !== c.id) throw new NotFoundException('Diseño no encontrado');
      if ((asset as any).designId !== design.id) throw new BadRequestException('La imagen no corresponde a ese diseño');
      // El diseño cambió después de llevarlo a Ads: la imagen ya no es la versión actual
      if ((asset as any).designVersion !== design.version) throw new BadRequestException('El diseño cambió después de traerlo a Ads. Vuelve a usar «Usar en anuncio» desde el editor para traer la versión actual.');
      designId = design.id;
    }
    const plan = buildClientLaunch(draft, { ...ctx, imageHash: '' });
    const id = randomBytes(9).toString('hex');
    const launch = await this.prisma.adLaunch.create({
      data: {
        id, companyId: c.id, accountId: a.id, status: 'CREATING', draftJson: JSON.stringify(draft), assetId: String(dto.assetId),
        pageId: ctx.pageId!, instagramUserId: ctx.instagramUserId, utmCampaign: plan.utmCampaign, link: plan.link,
        reviewJson: dto?.review ? JSON.stringify(dto.review).slice(0, 20000) : null, designId,
        historyJson: JSON.stringify([{ at: this.now().toISOString(), by: user.name, event: 'Anuncio preparado' }]),
        lockUntil: new Date(this.now().getTime() + LOCK_MS), createdBy: user.name, createdAt: this.now(), updatedAt: this.now(),
      },
    });
    return this.view(await this.runSteps(user, c, a, launch));
  }

  /** Sube la imagen y crea en Meta lo que falte (todo en PAUSA). Continúa donde quedó. */
  private async runSteps(user: AuthUser, c: any, a: any, launch: any) {
    const token = this.token(a);
    const ids = parseJson<Partial<Record<Step, string>>>(launch.idsJson, {});
    let imageHash: string | null = launch.imageHash ?? null;
    const save = (data: Record<string, unknown>) => this.prisma.adLaunch.update({ where: { id: launch.id }, data: { ...data, updatedAt: this.now() } });
    try {
      if (!imageHash) {
        const { buffer, asset } = await this.assetBytes(c.id, launch.assetId);
        const ext = asset.mimeType === 'image/png' ? 'png' : 'jpg';
        const res = await this.graph(`/${a.externalId}/adimages`, token, { bytes: buffer.toString('base64'), name: `backoffice-${launch.id}.${ext}` }, 'POST');
        const img: any = Object.values(res?.images ?? {})[0];
        if (!img?.hash) throw new BadRequestException('Meta no devolvió el identificador de la imagen');
        imageHash = String(img.hash);
        await save({ imageHash });
      }
      const draft = parseJson<ClientDraft>(launch.draftJson, {} as ClientDraft);
      const plan = buildClientLaunch(draft, {
        currency: a.currency, timezone: a.timezone, pageId: launch.pageId, instagramUserId: launch.instagramUserId, maxDailyBudget: null, today: todayIn(a.timezone, this.now()), imageHash,
      });
      for (const step of STEPS) {
        if (ids[step]) continue;
        const params = step === 'campaign' ? plan.campaign
          : step === 'adset' ? { ...plan.adset, campaign_id: ids.campaign! }
            : step === 'creative' ? plan.creative
              : { ...plan.ad, adset_id: ids.adset!, creative: JSON.stringify({ creative_id: ids.creative }) };
        const res = await this.graph(`/${a.externalId}/${PATHS[step]}`, token, params, 'POST');
        if (!res?.id) throw new BadRequestException(`Meta no devolvió el ID (${step})`);
        ids[step] = String(res.id);
        // Cada id se guarda apenas llega: un reintento no lo vuelve a crear
        await save({ idsJson: JSON.stringify(ids) });
      }
      await this.audit.log({ actor: user, companyId: c.id, action: 'ads.create', entity: 'AdLaunch', entityId: launch.id, detail: `${draft.name} · ${CLIENT_GOALS[draft.goal].label} (en pausa) · campaña ${ids.campaign}` });
      return save({ status: 'PAUSED', error: null, lockUntil: null, historyJson: this.history(launch, user.name, 'Creado en Meta (en pausa)', `campaña ${ids.campaign}`) });
    } catch (err: any) {
      const done = STEPS.filter((s) => ids[s]).length;
      const error = String(err?.response?.message ?? err?.message ?? 'Error en Meta').slice(0, 400);
      this.logger.warn(`launch ${launch.id}: ${error}`);
      return save({ status: 'FAILED', error, lockUntil: null, historyJson: this.history(launch, user.name, imageHash ? `Falló en el paso ${done + 2} de 5` : 'Falló al subir la imagen', error) });
    }
  }

  async list(user: AuthUser, companyId?: string) {
    const c = await this.company(user, companyId);
    const rows = await this.prisma.adLaunch.findMany({ where: { companyId: c.id, status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.view(r));
  }

  private async own(user: AuthUser, id: string, companyId?: string) {
    const c = await this.company(user, companyId);
    const l = await this.prisma.adLaunch.findUnique({ where: { id: String(id ?? '') } });
    if (!l || l.companyId !== c.id) throw new NotFoundException('Anuncio no encontrado');
    const a = await this.prisma.adAccount.findUnique({ where: { id: l.accountId } });
    if (!a || a.companyId !== c.id) throw new NotFoundException('La cuenta del anuncio ya no está conectada');
    return { c, l, a };
  }

  async retry(user: AuthUser, id: string, companyId?: string) {
    const { c, l, a } = await this.own(user, id, companyId);
    if (l.status !== 'FAILED') throw new BadRequestException('Solo se reintenta un anuncio que falló');
    this.assertCanManage(a);
    const locked = await this.lock(c.id, l.id);
    return this.view(await this.runSteps(user, c, a, locked));
  }

  /** Activa anuncio, conjunto y campaña (la campaña al final: si algo falla, nada gasta). */
  async activate(user: AuthUser, id: string, dto: { confirm?: boolean }, companyId?: string) {
    if (dto?.confirm !== true) throw new BadRequestException('Activar gasta presupuesto: confirma la acción');
    const { c, l, a } = await this.own(user, id, companyId);
    const ids = parseJson<Partial<Record<Step, string>>>(l.idsJson, {});
    if (l.status !== 'PAUSED' || !ids.ad) throw new BadRequestException('Solo se activa un anuncio creado y en pausa');
    const draft = parseJson<ClientDraft>(l.draftJson, {} as ClientDraft);
    const max = await this.maxDailyBudget(c.id);
    if (!max || draft.dailyBudget > max) throw new BadRequestException(`El presupuesto (${draft.dailyBudget.toLocaleString('es-CO')}) supera tu tope diario actual. Sube el tope o crea el anuncio con menos presupuesto.`);
    this.assertCanManage(a);
    const locked = await this.lock(c.id, l.id);
    const token = this.token(a);
    try {
      for (const step of ['ad', 'adset', 'campaign'] as const) await this.graph(`/${ids[step]}`, token, { status: 'ACTIVE' }, 'POST');
      await this.audit.log({ actor: user, companyId: c.id, action: 'ads.activate', entity: 'AdLaunch', entityId: l.id, detail: `${draft.name} · ${draft.dailyBudget} ${a.currency}/día` });
      return this.view(await this.prisma.adLaunch.update({ where: { id: l.id }, data: { status: 'ACTIVE', error: null, lockUntil: null, updatedAt: this.now(), historyJson: this.history(locked, user.name, 'Activado', `${draft.dailyBudget.toLocaleString('es-CO')} ${a.currency} al día`) } }));
    } catch (err: any) {
      const error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      await this.prisma.adLaunch.update({ where: { id: l.id }, data: { error, lockUntil: null, updatedAt: this.now(), historyJson: this.history(locked, user.name, 'No se pudo activar', error) } });
      throw new BadRequestException(error);
    }
  }

  async pause(user: AuthUser, id: string, companyId?: string) {
    const { c, l, a } = await this.own(user, id, companyId);
    const ids = parseJson<Partial<Record<Step, string>>>(l.idsJson, {});
    if (!ids.campaign || !['ACTIVE', 'PAUSED'].includes(l.status)) throw new BadRequestException('Este anuncio no tiene campaña creada');
    const locked = await this.lock(c.id, l.id);
    try {
      await this.graph(`/${ids.campaign}`, this.token(a), { status: 'PAUSED' }, 'POST');
      await this.audit.log({ actor: user, companyId: c.id, action: 'ads.pause_launch', entity: 'AdLaunch', entityId: l.id, detail: parseJson<any>(l.draftJson, {}).name });
      return this.view(await this.prisma.adLaunch.update({ where: { id: l.id }, data: { status: 'PAUSED', error: null, lockUntil: null, updatedAt: this.now(), historyJson: this.history(locked, user.name, 'Pausado') } }));
    } catch (err: any) {
      const error = String(err?.message ?? 'Error en Meta').slice(0, 400);
      await this.prisma.adLaunch.update({ where: { id: l.id }, data: { error, lockUntil: null, updatedAt: this.now() } });
      throw new BadRequestException(error);
    }
  }

  /** Lo quita de la lista (no borra nada en Meta). Activo: hay que pausarlo antes. */
  async archive(user: AuthUser, id: string, companyId?: string) {
    const { c, l } = await this.own(user, id, companyId);
    if (l.status === 'ACTIVE') throw new BadRequestException('Pausa el anuncio antes de archivarlo');
    const locked = await this.lock(c.id, l.id);
    await this.prisma.adLaunch.update({ where: { id: l.id }, data: { status: 'ARCHIVED', lockUntil: null, updatedAt: this.now(), historyJson: this.history(locked, user.name, 'Archivado (no se borró nada en Meta)') } });
    return { ok: true };
  }

  view(l: any) {
    const draft = parseJson<ClientDraft>(l.draftJson, {} as ClientDraft);
    const review = parseJson<ReviewResult | null>(l.reviewJson, null);
    return {
      id: l.id, status: l.status, accountId: l.accountId, draft, goalLabel: CLIENT_GOALS[draft.goal]?.label ?? draft.goal,
      ids: parseJson<Record<string, string>>(l.idsJson, {}), assetId: l.assetId, designId: l.designId ?? null, link: l.link, error: l.error ?? null,
      history: parseJson<any[]>(l.historyJson, []), createdBy: l.createdBy, createdAt: l.createdAt,
      reviewScore: review?.code?.score ?? null, reviewedWithAi: review?.ai?.status === 'OK',
      processing: !!l.lockUntil && new Date(l.lockUntil).getTime() > this.now().getTime(),
    };
  }

  /* ── 4. La semana ── */

  /**
   * Qué corre cada día de la semana (lunes a domingo): los conjuntos de las
   * cuentas conectadas según sus fechas en Meta, y los anuncios de BackOffice
   * que todavía no aparecen en la sincronización.
   */
  async week(user: AuthUser, q: { companyId?: string; start?: string }) {
    const c = await this.company(user, q.companyId);
    const { accounts } = await this.account(c.id);
    const today = todayIn(accounts[0]?.timezone ?? c.timezone, this.now());
    const ref = /^\d{4}-\d{2}-\d{2}$/.test(String(q.start ?? '')) ? String(q.start) : today;
    const wd = (new Date(`${ref}T12:00:00Z`).getUTCDay() + 6) % 7; // lunes = 0
    const monday = addDays(ref, -wd);
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const sunday = days[6];
    const ids = accounts.map((x) => x.id);
    const [adsets, campaigns, launches] = await Promise.all([
      this.prisma.adEntity.findMany({ where: { companyId: c.id, accountId: { in: ids }, level: 'ADSET' } }),
      this.prisma.adEntity.findMany({ where: { companyId: c.id, accountId: { in: ids }, level: 'CAMPAIGN' } }),
      this.prisma.adLaunch.findMany({ where: { companyId: c.id, status: { in: ['PAUSED', 'ACTIVE', 'CREATING', 'FAILED'] } } }),
    ]);
    const tzOf = new Map(accounts.map((x) => [x.id, x.timezone]));
    const day = (iso: unknown, tz: string | null | undefined) => (typeof iso === 'string' && iso ? todayIn(tz, new Date(iso)) : null);
    const items: Array<{ key: string; name: string; campaign: string | null; status: string; start: string | null; end: string | null; dailyBudget: number | null; source: 'META' | 'BACKOFFICE'; launchId?: string }> = [];
    const seen = new Set<string>();
    for (const s of adsets) {
      const raw = parseJson<any>(s.rawJson, {});
      const start = day(raw.start_time, tzOf.get(s.accountId));
      const end = day(raw.end_time, tzOf.get(s.accountId));
      if ((start && start > sunday) || (end && end < monday)) continue;
      const status = s.effectiveStatus ?? s.status ?? 'UNKNOWN';
      if (!['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PENDING_REVIEW', 'IN_PROCESS', 'WITH_ISSUES'].includes(status)) continue;
      seen.add(s.externalId);
      items.push({ key: s.id, name: s.name, campaign: campaigns.find((x) => x.externalId === s.campaignExternalId)?.name ?? null, status, start, end, dailyBudget: s.dailyBudget ?? null, source: 'META' });
    }
    for (const l of launches) {
      const lids = parseJson<Record<string, string>>(l.idsJson, {});
      if (lids.adset && seen.has(lids.adset)) continue;
      const d = parseJson<ClientDraft>(l.draftJson, {} as ClientDraft);
      if ((d.startDate && d.startDate > sunday) || (d.endDate && d.endDate < monday)) continue;
      items.push({ key: l.id, name: d.name, campaign: d.name, status: l.status, start: d.startDate ?? null, end: d.endDate ?? null, dailyBudget: d.dailyBudget ?? null, source: 'BACKOFFICE', launchId: l.id });
    }
    return {
      today, days, start: monday, previous: addDays(monday, -7), next: addDays(monday, 7),
      items: items.sort((x, y) => (x.start ?? '').localeCompare(y.start ?? '') || x.name.localeCompare(y.name)),
      note: 'Las fechas son las del conjunto de anuncios en Meta, en la zona horaria de tu cuenta. Un conjunto en pausa aparece, pero no gasta.',
    };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('ADS')
@Controller('ads/create')
export class AdsCreateController {
  constructor(private readonly s: AdsCreateService) {}

  @Get('setup') @Roles(...READ)
  setup(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.setup(u, q); }

  @Put('budget-cap') @Roles(...WRITE)
  budgetCap(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.setBudgetCap(u, dto, c); }

  /** Revisar con IA consume la llave de la empresa: límite para no gastar de más por accidente */
  @Post('review') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  review(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.review(u, dto, c); }

  @Post('preview') @Roles(...WRITE)
  preview(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.preview(u, dto, c); }

  @Get('launches') @Roles(...READ)
  list(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.list(u, c); }

  @Post('launches') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  create(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.create(u, dto, c); }

  @Post('launches/:id/retry') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  retry(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.retry(u, id, c); }

  @Post('launches/:id/activate') @Roles(...WRITE)
  activate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.activate(u, id, dto, c); }

  @Post('launches/:id/pause') @Roles(...WRITE)
  pause(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.pause(u, id, c); }

  @Delete('launches/:id') @Roles(...WRITE)
  archive(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.archive(u, id, c); }

  @Get('week') @Roles(...READ)
  week(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.week(u, q); }
}
