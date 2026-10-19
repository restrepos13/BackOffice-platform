import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, Module, Param, Post, Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { AuditModule, AuditService } from './audit.module';

/**
 * Publicidad de BackOffice en Meta (Facebook / Instagram) — solo para el equipo.
 *  - Con la cuenta publicitaria conectada (token + act_…) trae campañas, gasto,
 *    alcance, clics y resultados, y permite pausar o activar una campaña.
 *  - Cruza el gasto con los registros: quien llega con ?utm_source=facebook o
 *    instagram y ?utm_campaign=… queda atribuido a esa campaña, así se ve
 *    cuánto cuesta cada registro y cada empresa creada.
 *  - Sin conexión se puede anotar el gasto a mano y el cruce funciona igual.
 */

const GRAPH = 'https://graph.facebook.com/v21.0';
const CFG_KEY = 'META_ADS_CONFIG';
const MANUAL_KEY = 'META_ADS_MANUAL';
const META_SOURCES = ['facebook', 'instagram', 'fb', 'ig', 'meta', 'messenger'];

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

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
      ? await this.fetchImpl(`${GRAPH}${path}?${qs}`)
      : await this.fetchImpl(`${GRAPH}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs });
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
          const attributed = attr.byCampaign.get(String(c.name).toLowerCase()) ?? { sessions: 0, done: 0 };
          const spend = Number(r.spend ?? 0);
          return {
            id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status, objective: c.objective,
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

  async setStatus(actor: AuthUser, id: string, status: string) {
    if (!['ACTIVE', 'PAUSED'].includes(status)) throw new BadRequestException('Estado inválido');
    if (!/^\d{5,30}$/.test(id)) throw new BadRequestException('Campaña inválida');
    const cfg = await this.config();
    if (!cfg) throw new BadRequestException('Conecta primero la cuenta publicitaria');
    await this.graph(`/${id}`, cfg.token, { status }, 'POST');
    await this.audit.log({ actor, action: 'ads.status', entity: 'MetaCampaign', entityId: id, detail: status === 'PAUSED' ? 'Campaña pausada' : 'Campaña activada' });
    return { ok: true, status };
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
    return this.ads.setStatus(user, id, String(dto?.status ?? ''));
  }
}

@Module({
  imports: [AuditModule],
  controllers: [MetaAdsController],
  providers: [MetaAdsService],
})
export class MetaAdsModule {}
