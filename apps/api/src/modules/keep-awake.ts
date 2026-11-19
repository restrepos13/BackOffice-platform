/**
 * Despertador del servidor.
 *
 * En el plan gratis de Render el servicio se duerme tras ~15 min sin tráfico
 * de afuera y tarda ~1 min en despertar. Para que eso no le pase a quien llega
 * de un anuncio, cada 10 min el propio servidor se llama por su URL pública
 * (pasa por el proxy de Render, así que cuenta como tráfico de afuera).
 *
 * Modos (PlatformSetting KEEP_AWAKE, se cambia en Plataforma → Publicidad):
 *  - AUTO (por defecto): solo mientras haya anuncios entregando en Meta.
 *  - ON: siempre.
 *  - OFF: nunca.
 *
 * Límites a tener en cuenta: si el servidor ya está dormido, nada corre hasta
 * que alguien entre (activar la campaña desde el panel lo despierta). Y el plan
 * gratis da 750 h/mes por cuenta: un servicio 24/7 usa ~744.
 */
import { BadRequestException, Body, Controller, Get, Injectable, Logger, Module, Put } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { AuditModule, AuditService } from './audit.module';
import { MetaAdsModule, MetaAdsService } from './meta-ads.module';

export const KEEP_AWAKE_KEY = 'KEEP_AWAKE';
export type KeepAwakeMode = 'AUTO' | 'ON' | 'OFF';
const MODES: KeepAwakeMode[] = ['AUTO', 'ON', 'OFF'];

export interface KeepAwakeStatus {
  mode: KeepAwakeMode;
  /** URL que se llama; null fuera de Render (local no hace falta). */
  url: string | null;
  /** ¿En el último control tocaba mantenerlo despierto? */
  active: boolean;
  /** Por qué sí o por qué no, en palabras. */
  reason: string;
  /** Campañas entregando según el último control (modo AUTO). */
  campaigns: string[];
  lastCheckAt: string | null;
  lastPing: { at: string; ok: boolean; ms: number; error?: string } | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** URL pública del propio servicio: Render la da sola en RENDER_EXTERNAL_URL. */
export function selfUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.KEEP_AWAKE_URL || env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\//i.test(raw) ? raw : null;
}

@Injectable()
export class KeepAwakeService {
  private readonly logger = new Logger('KeepAwake');
  private last: Pick<KeepAwakeStatus, 'active' | 'reason' | 'campaigns' | 'lastCheckAt' | 'lastPing'> = {
    active: false, reason: 'Todavía no se revisó (corre cada 10 min).', campaigns: [], lastCheckAt: null, lastPing: null,
  };
  private running = false;

  /** Reemplazables en pruebas. */
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number }> = (url, init) => fetch(url, init) as any;
  env: NodeJS.ProcessEnv = process.env;
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ads: MetaAdsService,
  ) {}

  private async saved(): Promise<{ mode: KeepAwakeMode; updatedAt: string | null; updatedBy: string | null }> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: KEEP_AWAKE_KEY } }).catch(() => null);
    const v = parseJson<{ mode?: string; updatedAt?: string; updatedBy?: string }>(row?.value ?? null, {});
    return { mode: MODES.includes(v.mode as KeepAwakeMode) ? (v.mode as KeepAwakeMode) : 'AUTO', updatedAt: v.updatedAt ?? null, updatedBy: v.updatedBy ?? null };
  }

  async status(): Promise<KeepAwakeStatus> {
    const s = await this.saved();
    return { ...s, url: selfUrl(this.env), ...this.last };
  }

  async setMode(actor: AuthUser, mode: unknown): Promise<KeepAwakeStatus> {
    const m = String(mode ?? '').toUpperCase() as KeepAwakeMode;
    if (!MODES.includes(m)) throw new BadRequestException('Modo inválido: AUTO, ON u OFF');
    const value = JSON.stringify({ mode: m, updatedAt: this.clock().toISOString(), updatedBy: actor.name || actor.email || actor.id });
    await this.prisma.platformSetting.upsert({ where: { key: KEEP_AWAKE_KEY }, update: { value }, create: { key: KEEP_AWAKE_KEY, value } });
    await this.audit.log({ actor, action: 'platform.keep_awake', entity: 'PlatformSetting', entityId: KEEP_AWAKE_KEY, detail: m });
    // Se aplica ya, sin esperar al próximo turno
    await this.tick();
    return this.status();
  }

  @Cron('*/10 * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { mode } = await this.saved();
      const at = this.clock().toISOString();
      let active = false;
      let reason = '';
      let campaigns: string[] = [];
      if (mode === 'OFF') reason = 'Apagado: el servidor se duerme tras 15 min sin visitas.';
      else if (mode === 'ON') { active = true; reason = 'Encendido siempre.'; }
      else {
        const live = await this.ads.deliveringNow();
        if (live === null) {
          // Sin poder leer Meta, mejor despierto que perder a alguien que hizo clic
          active = true;
          reason = 'Automático: no se pudo leer Meta, así que se mantiene despierto por las dudas.';
        } else {
          campaigns = [...new Set(live.map((a) => a.campaign || a.name))];
          active = live.length > 0;
          reason = active ? 'Automático: hay anuncios entregando en Meta.' : 'Automático: ninguna campaña entregando, se deja dormir.';
        }
      }
      this.last = { ...this.last, active, reason, campaigns, lastCheckAt: at };
      if (active) await this.ping();
    } catch (e: any) {
      this.logger.warn(`despertador: ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  private async ping(): Promise<void> {
    const url = selfUrl(this.env);
    const at = this.clock().toISOString();
    if (!url) {
      this.last.lastPing = null;
      this.last.reason += ' (Fuera de Render no se llama a nada.)';
      return;
    }
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'BackOffice-KeepAwake' } });
      this.last.lastPing = { at, ok: res.ok, ms: Date.now() - t0, ...(res.ok ? {} : { error: `respondió ${res.status}` }) };
    } catch (e: any) {
      this.last.lastPing = { at, ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 120) };
    }
  }
}

@Controller('platform/keep-awake')
export class KeepAwakeController {
  constructor(private readonly keepAwake: KeepAwakeService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  status() {
    return this.keepAwake.status();
  }

  @Put()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  setMode(@CurrentUser() user: AuthUser, @Body() dto: { mode?: unknown }) {
    return this.keepAwake.setMode(user, dto?.mode);
  }
}

@Module({
  imports: [AuditModule, MetaAdsModule],
  controllers: [KeepAwakeController],
  providers: [KeepAwakeService],
})
export class KeepAwakeModule {}
