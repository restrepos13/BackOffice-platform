/**
 * Conexión de Meta Ads por ACCESO DE SOCIO, sin que el cliente toque tokens.
 *
 * 1. El cliente, en su portafolio de Meta, comparte su cuenta publicitaria con
 *    el portafolio de BackOffice (META_BUSINESS_ID) con «Control total».
 * 2. Escribe en BackOffice el número de su cuenta (act_…) y toca «Ya la compartí».
 * 3. BackOffice la busca entre las cuentas que le compartieron, se asigna su
 *    usuario del sistema (META_PARTNER_TOKEN) y la conecta sola.
 *
 * Además de la cuenta, el cliente comparte su página de Facebook, su Instagram
 * y su píxel (para anunciar a nombre de su marca, publicar y medir ventas):
 * BackOffice revisa cada uno y le dice qué quedó bien y qué le falta.
 *
 * Nunca se listan las cuentas compartidas por OTROS clientes: el cliente nombra
 * la suya y solo se responde por esa. Una cuenta ya conectada en otra empresa
 * no se puede tomar (lo impide AdsService).
 */
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Module, Optional, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES } from '../common/constants';
import { metaAdsVersion } from '../common/ads/meta-ads-provider';
import { AdsModule, AdsService } from './ads.module';
import { TeamAlertsService, tg } from './team-alerts';

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
/** Lo que BackOffice pide sobre la cuenta compartida (= «Control total» en Meta). */
const TASKS = ['MANAGE', 'ADVERTISE', 'ANALYZE'];
/** Sobre la página: control total (publicar, responder, anunciar y ver resultados). */
const PAGE_TASKS = ['MANAGE', 'CREATE_CONTENT', 'MODERATE', 'MESSAGING', 'ADVERTISE', 'ANALYZE'];

/** true = listo · false = no está compartido · null = Meta no dejó confirmarlo ahora. */
export interface AssetState { ok: boolean | null; name?: string }
export interface PartnerAssets { page: AssetState; instagram: AssetState; pixel: AssetState }

export type PartnerClaim =
  | { status: 'WAITING'; message: string }
  | { status: 'CONNECTED'; account: any; readOnly: boolean; assets: PartnerAssets };

export const accountDigits = (raw: unknown) => String(raw ?? '').trim().replace(/^act_/i, '').replace(/\D/g, '');

@Injectable()
export class AdsPartnerService {
  private readonly logger = new Logger('AdsPartner');
  /** Reemplazable en pruebas. */
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = (u, i) => fetch(u, i) as any;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: AdsService,
    @Optional() private readonly alerts?: TeamAlertsService,
  ) {}

  private async value(key: string) {
    return (await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null))?.value?.trim() || process.env[key]?.trim() || '';
  }

  async config() {
    const businessId = (await this.value('META_BUSINESS_ID')).replace(/\D/g, '');
    const token = await this.value('META_PARTNER_TOKEN');
    return { businessId: businessId || null, token: token.length > 20 ? token : null };
  }

  /** Para la guía: a quién compartir y si BackOffice conecta solo o hace falta el equipo. */
  async info(user: AuthUser, companyId?: string) {
    await this.ads.companyOf(user, companyId);
    const cfg = await this.config();
    return { businessId: cfg.businessId, automatic: !!(cfg.businessId && cfg.token) };
  }

  private async graph(path: string, token: string, params: Record<string, string> = {}, method: 'GET' | 'POST' = 'GET') {
    const base = `https://graph.facebook.com/${metaAdsVersion()}${path}`;
    const qs = new URLSearchParams({ ...params, access_token: token }).toString();
    const res = method === 'GET'
      ? await this.fetchImpl(`${base}?${qs}`)
      : await this.fetchImpl(base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.error) {
      const err: any = new Error(String(data?.error?.message ?? `Meta respondió ${res.status}`).slice(0, 200));
      err.code = Number(data?.error?.code) || res.status;
      throw err;
    }
    return data;
  }

  /** ¿Esa cuenta ya se la compartieron a BackOffice? Recorre las cuentas de clientes del portafolio. */
  private async findShared(businessId: string, token: string, digits: string) {
    const found = await this.scan(`/${businessId}/client_ad_accounts`, token, { fields: 'account_id,name,account_status' }, (a) => accountDigits(a.account_id ?? a.id) === digits);
    return found[0] ?? null;
  }

  /** Recorre un listado paginado de Meta (con tope) hasta encontrar lo que cumpla `hit`. */
  private async scan(path: string, token: string, params: Record<string, string>, hit: (x: any) => boolean) {
    let page = await this.graph(path, token, { limit: '200', ...params });
    for (let i = 0; i < 10; i++) {
      const found = (page?.data ?? []).filter(hit);
      if (found.length) return found;
      const next = page?.paging?.next;
      if (typeof next !== 'string' || !next.startsWith('https://graph.facebook.com/')) return [];
      const res = await this.fetchImpl(next);
      page = await res.json().catch(() => ({}));
    }
    return [];
  }

  /**
   * Página, Instagram y píxel que acompañan a la cuenta. Solo se miran los que
   * esa cuenta publicitaria ya usa (nunca los de otros clientes). Ningún fallo
   * de Meta frena la conexión: queda como «no se pudo confirmar».
   */
  async checkAssets(digits: string, cfg: { businessId: string; token: string }, meId?: string): Promise<PartnerAssets> {
    const out: PartnerAssets = { page: { ok: null }, instagram: { ok: null }, pixel: { ok: null } };
    let me = meId;
    const assign = async (path: string, tasks: string[]) => {
      try {
        me ??= String((await this.graph('/me', cfg.token, { fields: 'id' })).id);
        await this.graph(path, cfg.token, { user: me, tasks: JSON.stringify(tasks), business: cfg.businessId }, 'POST');
      } catch (e: any) {
        this.logger.warn(`socio: asignación en ${path}: ${e.message}`);
      }
    };

    // Página: la que la cuenta puede promocionar Y que el cliente compartió con BackOffice
    let pageId: string | null = null;
    try {
      const promote = (await this.graph(`/act_${digits}/promote_pages`, cfg.token, { fields: 'id,name', limit: '50' }))?.data ?? [];
      const ids = new Set(promote.map((p: any) => String(p.id)));
      const shared = ids.size ? await this.scan(`/${cfg.businessId}/client_pages`, cfg.token, { fields: 'id,name' }, (p) => ids.has(String(p.id))) : [];
      if (shared[0]) {
        pageId = String(shared[0].id);
        out.page = { ok: true, name: shared[0].name };
        await assign(`/${pageId}/assigned_users`, PAGE_TASKS);
      } else out.page = { ok: false };
    } catch (e: any) {
      this.logger.warn(`socio: páginas de act_${digits}: ${e.message}`);
    }

    // Instagram: el que la cuenta ya usa en anuncios o el vinculado a la página
    try {
      const ig = (await this.graph(`/act_${digits}/instagram_accounts`, cfg.token, { fields: 'id,username', limit: '10' }))?.data?.[0];
      if (ig) out.instagram = { ok: true, name: ig.username ? `@${ig.username}` : undefined };
    } catch (e: any) {
      this.logger.warn(`socio: instagram de act_${digits}: ${e.message}`);
    }
    if (!out.instagram.ok && pageId) {
      try {
        const linked = (await this.graph(`/${pageId}`, cfg.token, { fields: 'instagram_business_account{id,username}' }))?.instagram_business_account;
        out.instagram = linked ? { ok: true, name: linked.username ? `@${linked.username}` : undefined } : { ok: false };
      } catch (e: any) {
        this.logger.warn(`socio: instagram de la página ${pageId}: ${e.message}`);
      }
    } else if (!out.instagram.ok && out.page.ok === false) out.instagram = { ok: false };

    // Píxel / conjunto de datos de la cuenta
    try {
      const px = (await this.graph(`/act_${digits}/adspixels`, cfg.token, { fields: 'id,name', limit: '10' }))?.data?.[0];
      out.pixel = px ? { ok: true, name: px.name } : { ok: false };
    } catch (e: any) {
      this.logger.warn(`socio: píxel de act_${digits}: ${e.message}`);
    }
    return out;
  }

  /** «Volver a revisar»: solo sobre la cuenta de Meta que ESTA empresa ya conectó. */
  async assets(user: AuthUser, companyId?: string): Promise<{ account: string; assets: PartnerAssets }> {
    const company = await this.ads.companyOf(user, companyId);
    const cfg = await this.config();
    if (!cfg.businessId || !cfg.token) throw new BadRequestException('La conexión automática aún no está activada.');
    const acc = await this.prisma.adAccount.findFirst({ where: { companyId: company.id, provider: 'META', mode: 'REAL', status: { not: 'DISCONNECTED' } } });
    if (!acc) throw new BadRequestException('Primero conecta tu cuenta publicitaria (pasos de arriba).');
    return { account: acc.name, assets: await this.checkAssets(accountDigits(acc.externalId), { businessId: cfg.businessId, token: cfg.token }) };
  }

  /**
   * «Ya la compartí»: si Meta ya la muestra como compartida, BackOffice se
   * asigna y conecta. Si todavía no, responde WAITING (la pantalla vuelve a
   * preguntar sola durante unos minutos).
   */
  async claim(user: AuthUser, dto: { accountId?: unknown }, companyId?: string): Promise<PartnerClaim> {
    const company = await this.ads.companyOf(user, companyId);
    const digits = accountDigits(dto?.accountId);
    if (!/^\d{5,25}$/.test(digits)) throw new BadRequestException('Escribe el número de tu cuenta publicitaria (solo números, por ejemplo 1234567890).');
    const cfg = await this.config();
    if (!cfg.businessId || !cfg.token) throw new BadRequestException('La conexión automática aún no está activada. Avísale al equipo de BackOffice y la conectamos desde nuestro lado.');

    let shared: any;
    try {
      shared = await this.findShared(cfg.businessId, cfg.token, digits);
    } catch (e: any) {
      this.logger.warn(`socio: no se pudo leer client_ad_accounts (${e.message})`);
      throw new BadRequestException('Meta no respondió al buscar tu cuenta. Intenta en un minuto.');
    }
    if (!shared) {
      return { status: 'WAITING', message: 'Todavía no vemos la cuenta compartida. Si ya la compartiste, Meta puede tardar un par de minutos; seguimos buscando.' };
    }

    // BackOffice se asigna a sí mismo sobre la cuenta (su usuario del sistema)
    let meId: string | undefined;
    try {
      const me = await this.graph('/me', cfg.token, { fields: 'id' });
      meId = String(me.id);
      await this.graph(`/act_${digits}/assigned_users`, cfg.token, { user: String(me.id), tasks: JSON.stringify(TASKS), business: cfg.businessId }, 'POST');
    } catch (e: any) {
      // Ya asignado, o compartida con menos que «Control total»: se sigue y los permisos reales se ven al conectar
      this.logger.warn(`socio: asignación de act_${digits}: ${e.message}`);
    }

    const account = await this.ads.connectManual(user, { accountId: `act_${digits}`, token: cfg.token }, company.id).catch((e: any) => {
      // Recién compartida: a veces Meta tarda en dejar verla al usuario del sistema
      if (/no tiene acceso/i.test(String(e?.message))) return null;
      throw e;
    });
    if (!account) return { status: 'WAITING', message: 'Ya vemos tu cuenta; estamos terminando de conectarla. Esto toma unos segundos.' };

    const readOnly = !account.access?.manage;
    const assets = await this.checkAssets(digits, { businessId: cfg.businessId, token: cfg.token }, meId);
    const mark = (a: AssetState) => (a.ok ? '✓' : a.ok === false ? 'falta' : '¿?');
    void this.alerts?.send('ADS_CONNECTED', `<b>Conectó su cuenta publicitaria</b>\n${tg(company.name)} · ${tg(account.name)} (act_${digits})\nPágina ${mark(assets.page)} · Instagram ${mark(assets.instagram)} · Píxel ${mark(assets.pixel)}${readOnly ? '\nOjo: la compartió sin «Control total» (solo lectura).' : ''}`);
    return { status: 'CONNECTED', account, readOnly, assets };
  }
}

@Products('ADS')
@Controller('ads/meta/partner')
export class AdsPartnerController {
  constructor(private readonly partner: AdsPartnerService) {}

  @Get() @Roles(...READ)
  info(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.partner.info(u, c); }

  @Post('claim') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 12 } })
  claim(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.partner.claim(u, dto, c); }

  @Post('assets') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 12 } })
  assets(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.partner.assets(u, c); }
}

@Module({
  imports: [AdsModule],
  controllers: [AdsPartnerController],
  providers: [AdsPartnerService],
})
export class AdsPartnerModule {}
