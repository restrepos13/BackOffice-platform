import {
  BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, Logger, NotFoundException, Optional, Param, Post, Query, forwardRef,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'crypto';
import { readFile } from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.module';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { hasProduct } from '../common/products';
import { ensureFile, removeFile, saveFile } from '../common/file-store';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { readCompanyKey, recordAiUsage } from '../ai/ai-access';
import { CREATIVE_COSTS, InsufficientCreditsError, commitCreativeCredits, releaseCreativeCredits, reserveCreativeCredits } from '../common/creative-credits';
import { CatalogItem, Intent, MAX_DESCRIPTION, artRequestFrom, intentMessages, interpretIntent, normalizeAiIntent } from '../common/creative/intent';
import { ImageOpError, RemoveBgProvider, validateCutout, type CutoutProvider, type FetchLike } from '../common/creative/cutout';
import { CreativeService } from './creative.module';
import { LibraryService, exportedVersion } from './library.module';

/**
 * «Crear para vender»: la entrada principal de Creative.
 *  1. start: qué tiene la empresa (fotos, catálogo, marca, IA, créditos, Ads).
 *  2. intent: la descripción libre → intención estructurada (reglas siempre;
 *     IA de la empresa si la tiene, validada por las mismas reglas).
 *  3. Las propuestas visuales salen del motor determinista existente
 *     (/creative/art/proposals) con el pedido que arma artRequestFrom.
 *  4. cutout: quita el fondo de una foto con un servicio especializado; el
 *     original no se toca y el recorte queda como derivado en la biblioteca.
 *  5. to-ads: un diseño exportado pasa a la biblioteca y abre el flujo de Ads
 *     (que valida y crea en pausa como siempre).
 */

const INTENT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const AI_TIMEOUT_MS = 20_000;
const REMOVE_BG_KEY = 'REMOVE_BG_API_KEY';
/** Más que el timeout del proveedor (45 s) con holgura: una reserva así de vieja ya no está en curso */
const CUTOUT_STALE_MS = 3 * 60_000;

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), ms))]);

@Injectable()
export class CreativeCreateService {
  private readonly logger = new Logger('CreativeCreate');
  fetchImpl: FetchLike = (u, i) => fetch(u, i) as any;
  /** Reemplazable en pruebas (sin llamadas reales) */
  cutoutProvider?: (prisma: PrismaService) => Promise<CutoutProvider | null>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    // creative.module importa este archivo: forwardRef evita el ciclo de importación
    @Inject(forwardRef(() => CreativeService)) private readonly creative: CreativeService,
    private readonly library: LibraryService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  private async cutout(): Promise<CutoutProvider | null> {
    if (this.cutoutProvider) return this.cutoutProvider(this.prisma);
    const row = await this.prisma.platformSetting.findUnique({ where: { key: REMOVE_BG_KEY } }).catch(() => null);
    const key = row?.value?.trim() || process.env[REMOVE_BG_KEY] || '';
    return key ? new RemoveBgProvider(key, this.fetchImpl) : null;
  }

  private async catalog(user: AuthUser, companyId?: string): Promise<CatalogItem[]> {
    return (await this.creative.catalogProducts(user, companyId)) as CatalogItem[];
  }

  private async ownedImages(companyId: string, ids: unknown): Promise<string[]> {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((x) => /^[\w-]{6,40}$/.test(x)).slice(0, 6);
    if (!list.length) return [];
    const rows = await this.prisma.brandAsset.findMany({ where: { id: { in: list }, companyId, kind: { in: ['IMAGE', 'LOGO'] } }, select: { id: true } });
    if (rows.length !== list.length) throw new BadRequestException('Alguna imagen no es de tu biblioteca');
    return list;
  }

  /* ── 1. Punto de partida ── */

  async start(user: AuthUser, companyId?: string) {
    const company = await this.creative.companyOf(user, companyId);
    const [brand, credits, catalog, photos, adAccounts, cutout] = await Promise.all([
      this.creative.brand(user, company.id),
      this.creative.credits(user, company.id),
      this.catalog(user, company.id),
      this.prisma.brandAsset.findMany({ where: { companyId: company.id, kind: 'IMAGE' }, orderBy: { createdAt: 'desc' }, take: 24 }),
      this.prisma.adAccount.count({ where: { companyId: company.id, mode: 'REAL', status: 'CONNECTED' } }).catch(() => 0),
      this.cutout(),
    ]);
    const b: any = brand;
    const aiKey = !!readCompanyKey(company.deepinfraApiKey);
    return {
      materials: {
        photos: photos.map((a) => ({ id: a.id, name: a.name, width: a.width, height: a.height, source: a.source ?? 'UPLOAD', derivedFromId: a.derivedFromId ?? null, createdAt: a.createdAt })),
        catalog: catalog.slice(0, 100),
      },
      brand: {
        // La marca nunca bloquea: se dice qué hay confirmado y qué será provisional
        hasLogo: (b?.logos?.length ?? 0) > 0,
        colorsConfirmed: (b?.colors?.length ?? 0) > 0 && b?.confirmed !== false,
        colors: (b?.colors ?? []).slice(0, 6),
        note: (b?.colors?.length ?? 0) > 0 ? null : 'Tu marca aún no tiene colores confirmados: usaremos una paleta provisional que puedes guardar después.',
      },
      ai: {
        available: aiKey && !!this.ai,
        note: aiKey
          ? 'Usamos la IA de tu empresa para entender lo que escribes (lo cobra tu proveedor, aparte). Los datos se validan siempre: nunca inventamos precios ni ofertas.'
          : 'Sin proveedor de IA configurado: entendemos tu descripción con reglas. Funciona, pero entiende menos matices.',
      },
      cutout: cutout
        ? { configured: true, provider: cutout.label, credits: CREATIVE_COSTS.IMAGE }
        : { configured: false, provider: null, credits: CREATIVE_COSTS.IMAGE, note: 'Quitar el fondo aún no está configurado en BackOffice (servicio especializado pendiente de activar).' },
      credits: { monthlyLeft: credits.monthly.left, extra: credits.extra },
      ads: { contracted: hasProduct(company, 'ADS'), connected: adAccounts > 0 },
      limits: { description: MAX_DESCRIPTION, photos: 6 },
    };
  }

  /* ── 2. Intención ── */

  async intent(user: AuthUser, dto: any, companyId?: string): Promise<{ intent: Intent; art: ReturnType<typeof artRequestFrom>; ai: { used: boolean; note: string | null } }> {
    const company = await this.creative.companyOf(user, companyId);
    const description = String(dto?.description ?? '').trim();
    if (description.length < 8) throw new BadRequestException('Cuéntanos en una frase qué quieres promocionar');
    if (description.length > MAX_DESCRIPTION) throw new BadRequestException(`La descripción admite hasta ${MAX_DESCRIPTION} caracteres`);
    const assetIds = await this.ownedImages(company.id, dto?.assetIds);
    const catalog = await this.catalog(user, company.id);
    const rules = interpretIntent(description, catalog, assetIds);
    let intent = rules;
    let note: string | null = null;
    let used = false;
    const apiKey = readCompanyKey(company.deepinfraApiKey);
    if (apiKey && this.ai) {
      try {
        const res = await withTimeout(this.ai.chat({ apiKey, model: INTENT_MODEL, temperature: 0, maxTokens: 300, jsonMode: true, messages: intentMessages(description, catalog) }), AI_TIMEOUT_MS);
        await recordAiUsage(this.prisma, { companyId: company.id, model: INTENT_MODEL, inputTokens: res.inputTokens, outputTokens: res.outputTokens, billedTo: 'BYOK', purpose: 'creative.intent' });
        intent = normalizeAiIntent(extractJson(res.content), rules, catalog);
        used = true;
      } catch (err: any) {
        note = err?.timeout ? 'La IA tardó demasiado; usamos la interpretación por reglas.' : 'La IA no respondió; usamos la interpretación por reglas.';
        this.logger.warn(`intent ${company.id}: ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
    // Lo que la persona confirma en pantalla manda (y se valida igual)
    if (dto?.overrides && typeof dto.overrides === 'object') intent = this.applyOverrides(intent, dto.overrides, catalog);
    return { intent, art: artRequestFrom(intent), ai: { used, note } };
  }

  /** Correcciones de la persona: solo campos permitidos y valores válidos. */
  private applyOverrides(i: Intent, o: Record<string, any>, catalog: CatalogItem[]): Intent {
    const next: Intent = { ...i };
    if (typeof o.productId === 'string') {
      const p = catalog.find((x) => x.id === o.productId);
      if (p) Object.assign(next, { productId: p.id, productName: p.name, productPrice: p.price, productDescription: null });
    }
    if (typeof o.productDescription === 'string' && o.productDescription.trim()) Object.assign(next, { productId: null, productName: null, productPrice: null, productDescription: o.productDescription.trim().slice(0, 60) });
    if (['WHATSAPP', 'WEBSITE', 'STORE', 'SOCIAL'].includes(o.destination)) next.destination = o.destination;
    if (typeof o.offer === 'string') next.offer = o.offer.trim().slice(0, 60) || null;
    // Confirmar una oferta es una decisión explícita de la persona
    next.offerConfirmed = !!next.offer && o.offerConfirmed === true;
    if (typeof o.offerValidity === 'string') next.offerValidity = o.offerValidity.trim().slice(0, 40) || null;
    if (typeof o.callToAction === 'string') next.callToAction = o.callToAction.trim().slice(0, 40) || null;
    const re = interpretIntent(next.sourceDescription, catalog, next.assetIds);
    return { ...next, missingInformation: re.missingInformation.filter((m) => !(m.key === 'product' && (next.productId || next.productDescription)) && !(m.key === 'offer' && (next.offerConfirmed || !next.offer)) && !(m.key === 'destination' && next.destination)) };
  }

  /* ── 4. Quitar el fondo ── */

  async removeBackground(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.creative.companyOf(user, companyId);
    const asset = await this.prisma.brandAsset.findUnique({ where: { id: String(dto?.assetId ?? '') } });
    if (!asset || asset.companyId !== company.id) throw new NotFoundException('Imagen no encontrada en tu biblioteca');
    if (asset.kind !== 'IMAGE' || !/^image\/(jpe?g|png)$/.test(asset.mimeType)) throw new BadRequestException('Para quitar el fondo usa una foto JPG o PNG');
    if (asset.source === 'CUTOUT') throw new BadRequestException('Esta imagen ya es un recorte');
    // Ya recortada: se reutiliza sin cobrar otra vez
    const done = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, derivedFromId: asset.id, source: 'CUTOUT' } });
    if (done) return { created: false, asset: this.view(done), original: this.view(asset) };
    const provider = await this.cutout();
    if (!provider) throw new BadRequestException({ code: 'NOT_CONFIGURED', message: 'Quitar el fondo aún no está configurado en BackOffice.' });
    const path = await ensureFile(this.prisma, company.id, asset.fileName);
    if (!path) throw new NotFoundException('El archivo original no está disponible: súbelo de nuevo');
    const image = await readFile(path);
    const reservation = await this.reserveCutout(company, user, asset.id);
    const { key, credits } = reservation;
    let png: Buffer;
    let size: { width: number; height: number };
    let fileName: string | null = null;
    let derived;
    try {
      png = await provider.removeBackground(image, asset.mimeType);
      size = validateCutout(png, { width: asset.width, height: asset.height });
      fileName = `asset-${randomBytes(12).toString('hex')}.png`;
      await saveFile(this.prisma, company.id, fileName, png, 'image/png');
      derived = await this.prisma.brandAsset.create({
        data: {
          companyId: company.id, kind: 'IMAGE', name: `${asset.name} · sin fondo`.slice(0, 80), fileName, mimeType: 'image/png', sizeBytes: png.length,
          width: size.width, height: size.height, createdBy: user.name, source: 'CUTOUT', originModule: 'CREATIVE', derivedFromId: asset.id,
          sha256: createHash('sha256').update(png).digest('hex'),
        },
      });
    } catch (err: any) {
      // Falló antes de existir el recorte: se devuelven los créditos, no queda archivo suelto y el original queda igual
      if (fileName) await removeFile(this.prisma, company.id, fileName).catch(() => undefined);
      await releaseCreativeCredits(this.prisma, key, String(err?.message ?? 'error').slice(0, 200));
      if (err instanceof ImageOpError) throw new BadRequestException({ code: err.kind, message: `${err.message} No se cobraron créditos.` });
      throw err;
    }
    // El recorte ya existe: el cobro se confirma. Si confirmar falla, la reserva queda descontada
    // (el trabajo se hizo) y se registra para revisarla; nunca se devuelve un recorte entregado.
    await commitCreativeCredits(this.prisma, key, { provider: provider.key, resourceId: derived.id })
      .catch((e) => this.logger.error(`cutout commit ${key}: ${String(e?.message ?? e).slice(0, 120)}`));
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.cutout', entity: 'BrandAsset', entityId: derived.id, detail: `${provider.label} · de ${asset.id} · ${credits} crédito(s)` })
      .catch(() => undefined);
    return { created: true, asset: this.view(derived), original: this.view(asset), credits };
  }

  /**
   * Reserva los créditos de un recorte con una llave por intento
   * (cutout:<foto>:<n>, n = intentos ya terminados): el mismo intento nunca
   * cobra dos veces y, tras un fallo o tras borrar el recorte, se puede repetir.
   * Una reserva sin terminar de hace más de CUTOUT_STALE_MS (el proceso murió
   * a mitad) se libera, para que la foto no quede bloqueada para siempre.
   */
  private async reserveCutout(company: any, user: AuthUser, assetId: string, retried = false): Promise<{ key: string; credits: number }> {
    const finished = await this.prisma.creativeCreditMove.count({ where: { companyId: company.id, kind: { in: ['RELEASE', 'COMMIT'] }, idempotencyKey: { startsWith: `cutout:${assetId}:` } } });
    const key = `cutout:${assetId}:${finished}`;
    let reserved;
    try {
      reserved = await reserveCreativeCredits(this.prisma, { company, operation: 'IMAGE', key, userId: user.id, resourceType: 'BrandAsset', resourceId: assetId });
    } catch (err) {
      if (err instanceof InsufficientCreditsError) throw new BadRequestException({ code: 'NO_CREDITS', message: err.message });
      throw err;
    }
    if (!reserved.reused) return { key, credits: reserved.credits };
    const move = await this.prisma.creativeCreditMove.findUnique({ where: { idempotencyKey: key } });
    const age = move?.createdAt ? Date.now() - new Date(move.createdAt).getTime() : 0;
    if (!retried && age > CUTOUT_STALE_MS) {
      await releaseCreativeCredits(this.prisma, key, 'Reserva sin terminar: el proceso se interrumpió');
      return this.reserveCutout(company, user, assetId, true);
    }
    throw new ConflictException('Este recorte ya se está procesando. Espera unos segundos.');
  }

  private view(a: any) {
    return { id: a.id, name: a.name, width: a.width ?? null, height: a.height ?? null, mimeType: a.mimeType, source: a.source ?? 'UPLOAD', derivedFromId: a.derivedFromId ?? null };
  }

  /* ── 5. De Creative a Ads ── */

  /**
   * Lleva la versión exportada de un diseño a la biblioteca (sin duplicar) y
   * devuelve cómo abrir Ads con esa imagen. Ads valida y crea en pausa como siempre.
   */
  async toAds(user: AuthUser, designId: string, companyId?: string) {
    const company = await this.creative.companyOf(user, companyId);
    const d = await this.prisma.creativeDesign.findUnique({ where: { id: String(designId ?? '') } });
    if (!d || d.companyId !== company.id) throw new NotFoundException('Diseño no encontrado');
    if (!d.exportFile) throw new BadRequestException('Exporta el diseño antes de usarlo en un anuncio');
    // La exportación lleva la versión en el nombre: si el diseño cambió (o no se sabe de qué versión es), hay que volver a exportar
    if (exportedVersion(d.exportFile) !== d.version) throw new BadRequestException('El diseño cambió después de exportarlo: expórtalo de nuevo');
    const res = await this.library.fromDesign(user, d.id, company.id);
    const adsContracted = hasProduct(company, 'ADS');
    const connected = adsContracted ? await this.prisma.adAccount.count({ where: { companyId: company.id, mode: 'REAL', status: 'CONNECTED' } }) : 0;
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.to_ads', entity: 'CreativeDesign', entityId: d.id, detail: `recurso ${res.asset.id}` });
    return {
      asset: res.asset,
      ads: {
        contracted: adsContracted,
        connected: connected > 0,
        // Ruta del flujo de Ads con la imagen precargada (el usuario sigue configurando ahí)
        url: adsContracted ? `/app/ads?tab=nueva&asset=${encodeURIComponent(res.asset.id)}&design=${encodeURIComponent(d.id)}` : null,
        note: !adsContracted ? 'Tu empresa no tiene Ads Intelligence: la imagen quedó en tu biblioteca para usarla cuando lo actives.' : connected ? null : 'Conecta tu cuenta publicitaria en Ads para crear el anuncio.',
      },
    };
  }

  /** Dónde se usó un diseño en anuncios y qué se sabe de sus resultados (sin inventar). */
  async adUsage(user: AuthUser, designId: string, companyId?: string) {
    const company = await this.creative.companyOf(user, companyId);
    const d = await this.prisma.creativeDesign.findUnique({ where: { id: String(designId ?? '') } });
    if (!d || d.companyId !== company.id) throw new NotFoundException('Diseño no encontrado');
    const launches = await this.prisma.adLaunch.findMany({ where: { companyId: company.id, designId: d.id }, orderBy: { createdAt: 'desc' }, take: 20 });
    const out: Array<Record<string, unknown>> = [];
    for (const l of launches) {
      const ids = parseJson<Record<string, string>>(l.idsJson, {});
      const rows = ids.ad ? await this.prisma.adInsightDaily.findMany({ where: { companyId: company.id, accountId: l.accountId, level: 'AD', externalId: ids.ad } }) : [];
      const spend = rows.reduce((s, r) => s + r.spend, 0);
      out.push({
        launchId: l.id, name: parseJson<any>(l.draftJson, {}).name ?? '—', status: l.status, createdAt: l.createdAt,
        results: rows.length
          ? { days: rows.length, spend, impressions: rows.reduce((s, r) => s + r.impressions, 0), clicks: rows.reduce((s, r) => s + r.clicks, 0), conversations: rows.reduce((s, r) => s + r.conversations, 0), leads: rows.reduce((s, r) => s + r.leads, 0) }
          : null,
        resultsNote: rows.length ? null : l.status === 'ACTIVE' ? 'Meta todavía no reporta resultados de este anuncio (se sincroniza cada 6 horas).' : 'Sin resultados: el anuncio no ha estado activo.',
      });
    }
    return { designId: d.id, launches: out };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('CREATIVE')
@Controller('creative/create')
export class CreativeCreateController {
  constructor(private readonly s: CreativeCreateService) {}

  @Get('start') @Roles(...READ)
  start(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.start(u, c); }

  @Post('intent') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 15 } })
  intent(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.intent(u, dto, c); }

  /** Cuesta créditos y llama a un servicio externo: límite estricto */
  @Post('cutout') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  cutout(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.removeBackground(u, dto, c); }

  @Post('to-ads/:designId') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  toAds(@CurrentUser() u: AuthUser, @Param('designId') id: string, @Query('companyId') c?: string) { return this.s.toAds(u, id, c); }

  @Get('ad-usage/:designId') @Roles(...READ)
  adUsage(@CurrentUser() u: AuthUser, @Param('designId') id: string, @Query('companyId') c?: string) { return this.s.adUsage(u, id, c); }
}
