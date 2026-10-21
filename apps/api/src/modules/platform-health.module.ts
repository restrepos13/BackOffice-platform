import { Body, Controller, Get, Inject, Injectable, Logger, Module, Put, Query } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import {
  DEFAULT_HEALTH_CONFIG, HealthCheck, HealthConfig, HealthMetrics, dailyStats, evaluateHealth, growthPerDay, healthConfig, healthSummary,
} from '../common/health-rules';
import { BOOT_ID, perfSnapshot, resetLoopMeter } from '../common/perf-monitor';
import { isProductionHost, teamEmails } from '../common/team-notify';
import { usdCopRate } from '../common/trm';
import { GeminiPool } from '../ai/gemini-pool';
import { ENGINE_QUEUE, WA_INBOUND_QUEUE, WA_OUTBOUND_QUEUE } from '../queue/queue.module';
import { AuditModule, AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';

/**
 * Salud de la plataforma (Plataforma → Salud). Cada 10 minutos mide:
 *  1. gasto de IA que pagamos nosotros y saldo de OpenRouter,
 *  2. espacio de MongoDB Atlas y su crecimiento,
 *  3. velocidad, memoria, errores y reinicios del servidor (Render),
 *  4. memoria de Redis y colas,
 *  5. cupos gratis de Gemini y OpenRouter,
 * 10. empresas en riesgo (sin WhatsApp, sin asistente, sin movimiento, factura vencida).
 * Guarda una foto (30 días de historial), avisa por correo al pasar a rojo y
 * manda un resumen diario a las 7:00 a. m. Todo con reglas, sin IA.
 */

const CONFIG_KEY = 'HEALTH_CONFIG';
const KEEP_DAYS = 30;
const DAY = 86400e3;
const ENV = isProductionHost() ? 'prod' : 'local';
/** Último nivel de cada alerta, por ambiente (las pruebas locales no tocan el de producción) */
const STATE_KEY = `HEALTH_STATE_${ENV}`;

const bogotaDay = (d: Date) => new Date(d.getTime() - 5 * 3600e3).toISOString().slice(0, 10);
const startOfBogotaDay = (d: Date) => new Date(`${bogotaDay(d)}T05:00:00.000Z`);

function esc(v: unknown) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** "used_memory:1234" → número (bytes) */
export function infoValue(info: string, key: string): number | null {
  const m = new RegExp(`^${key}:(\\d+)`, 'm').exec(info);
  return m ? Number(m[1]) : null;
}

@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger('Salud');
  private cache: { at: number; value: any } | null = null;
  private credits: { at: number; value: { remainingUsd: number | null; totalCredits: number | null } } | null = null;
  /** El tamaño de la base cambia despacio: se lee cada 15 min (leerlo tarda varios segundos) */
  private mongoCache: { at: number; value: Awaited<ReturnType<PlatformHealthService['readMongo']>> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
    @Inject(WA_INBOUND_QUEUE) private readonly inbound: Queue,
    @Inject(WA_OUTBOUND_QUEUE) private readonly outbound: Queue,
    @Inject(ENGINE_QUEUE) private readonly engine: Queue,
  ) {}

  async config(): Promise<HealthConfig> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: CONFIG_KEY } }).catch(() => null);
    try {
      return healthConfig(row?.value ? JSON.parse(row.value) : {});
    } catch {
      return { ...DEFAULT_HEALTH_CONFIG };
    }
  }

  async saveConfig(user: AuthUser, raw: unknown) {
    const clean = healthConfig(raw);
    const value = JSON.stringify(clean);
    await this.prisma.platformSetting.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value }, update: { value } });
    await this.audit.log({ actor: user, action: 'health.config', entity: 'PlatformSetting', detail: 'Umbrales de salud' });
    this.cache = null;
    return clean;
  }

  /* ── Mediciones ── */

  private async samples(days: number) {
    const rows = await this.prisma.healthSample.findMany({
      where: { env: ENV, at: { gte: new Date(Date.now() - days * DAY) } },
      orderBy: { at: 'asc' },
      select: { at: true, bootId: true, dataJson: true },
    });
    return rows.map((r: any) => {
      let data: any = {};
      try { data = JSON.parse(r.dataJson); } catch { /* foto dañada: se ignora */ }
      return { at: r.at, bootId: r.bootId, data };
    });
  }

  private async mongo(fresh = false) {
    if (!fresh && this.mongoCache && Date.now() - this.mongoCache.at < 15 * 60e3) return this.mongoCache.value;
    const value = await this.readMongo();
    if (value) this.mongoCache = { at: Date.now(), value };
    return value;
  }

  private async readMongo() {
    try {
      // En bytes y redondeado a décimas de MB (con scale=MB las colecciones chicas salen en 0)
      const mb = (bytes: unknown) => Math.round((Number(bytes ?? 0) / 1048576) * 10) / 10;
      const stats: any = await this.prisma.$runCommandRaw({ dbStats: 1 });
      const dataMb = mb(stats.dataSize);
      const indexMb = mb(stats.indexSize);
      const storageMb = mb(stats.storageSize);
      const collections: Array<{ name: string; mb: number; count: number }> = [];
      try {
        const list: any = await this.prisma.$runCommandRaw({ listCollections: 1, nameOnly: true });
        const names: string[] = (list?.cursor?.firstBatch ?? []).map((c: any) => c.name).filter((n: string) => !n.startsWith('system.'));
        // En paralelo por tandas (una por una tardaba ~10 s contra Atlas)
        const list80 = names.slice(0, 80);
        for (let i = 0; i < list80.length; i += 16) {
          const batch = await Promise.all(list80.slice(i, i + 16).map(async (name) => {
            try {
              const cs: any = await this.prisma.$runCommandRaw({ collStats: name });
              return { name, mb: mb(Number(cs.size ?? 0) + Number(cs.totalIndexSize ?? 0)), count: Number(cs.count ?? 0) };
            } catch {
              return null; // colección sin permiso de estadísticas
            }
          }));
          for (const b of batch) if (b) collections.push(b);
        }
      } catch { /* el plan no deja listar: solo el total */ }
      collections.sort((a, b) => b.mb - a.mb);
      return { usedMb: Math.round((dataMb + indexMb) * 10) / 10, dataMb, indexMb, storageMb, collections: collections.slice(0, 8) };
    } catch (err) {
      this.logger.warn(`MongoDB sin estadísticas: ${(err as Error).message}`);
      return null;
    }
  }

  private async redis() {
    try {
      // BullMQ 6: el cliente crudo de Redis vive en el backend de la cola
      const client: any = await (this.inbound as any).getBackend().client;
      const info: string = await client.info('memory');
      const used = infoValue(info, 'used_memory');
      const max = infoValue(info, 'maxmemory');
      const queues: Array<{ name: string; waiting: number; active: number; delayed: number; failed: number }> = [];
      for (const [name, q] of [['Entrantes', this.inbound], ['Salientes', this.outbound], ['Motor', this.engine]] as Array<[string, Queue]>) {
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        queues.push({ name, waiting: c.waiting ?? 0, active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 });
      }
      return {
        usedMb: Math.round(((used ?? 0) / 1048576) * 10) / 10,
        maxMb: max && max > 0 ? Math.round((max / 1048576) * 10) / 10 : null,
        local: ENV !== 'prod',
        queues,
      };
    } catch (err) {
      this.logger.warn(`Redis sin datos: ${(err as Error).message}`);
      return null;
    }
  }

  /** Gasto de IA que pagamos nosotros (eventos facturados a la plataforma). */
  private async aiSpend(now: Date) {
    const monthStart = new Date(`${bogotaDay(now).slice(0, 7)}-01T05:00:00.000Z`);
    const todayStart = startOfBogotaDay(now);
    const weekStart = new Date(todayStart.getTime() - 7 * DAY);
    const from = monthStart < weekStart ? monthStart : weekStart;
    const events = await this.prisma.aiUsageEvent.findMany({
      where: { billedTo: 'PLATFORM', createdAt: { gte: from } },
      select: { costUsd: true, companyId: true, createdAt: true },
    });
    let todayUsd = 0;
    let monthUsd = 0;
    let weekUsd = 0;
    const byCompany = new Map<string, number>();
    for (const e of events as any[]) {
      const at = new Date(e.createdAt);
      const cost = e.costUsd ?? 0;
      if (at >= todayStart) todayUsd += cost;
      else if (at >= weekStart) weekUsd += cost;
      if (at >= monthStart) {
        monthUsd += cost;
        byCompany.set(e.companyId, (byCompany.get(e.companyId) ?? 0) + cost);
      }
    }
    const [y, m] = bogotaDay(now).split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const elapsed = Math.max(1, (now.getTime() - monthStart.getTime()) / DAY);
    const topIds = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const names = await this.prisma.company.findMany({ where: { id: { in: topIds.map(([id]) => id) } }, select: { id: true, name: true } });
    const nameOf = new Map(names.map((c: any) => [c.id, c.name]));
    const r = (n: number) => Math.round(n * 10000) / 10000;
    return {
      todayUsd: r(todayUsd),
      monthUsd: r(monthUsd),
      projectionUsd: r((monthUsd / elapsed) * daysInMonth),
      avg7Usd: r(weekUsd / 7),
      top: topIds.map(([companyId, v]) => ({ companyId, name: nameOf.get(companyId) ?? '—', usd: r(v) })),
      openrouter: await this.openRouterCredits(),
    };
  }

  /** Saldo de OpenRouter (cacheado 30 min). */
  private async openRouterCredits(): Promise<{ remainingUsd: number | null; totalCredits: number | null }> {
    if (this.credits && Date.now() - this.credits.at < 30 * 60e3) return this.credits.value;
    const key = String(process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEYS ?? '').split(',')[0]?.trim();
    let value: { remainingUsd: number | null; totalCredits: number | null } = { remainingUsd: null, totalCredits: null };
    if (key && !process.env.JEST_WORKER_ID) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/credits', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const d: any = (await res.json())?.data ?? {};
          const total = Number(d.total_credits ?? 0);
          value = { totalCredits: total, remainingUsd: Math.round((total - Number(d.total_usage ?? 0)) * 100) / 100 };
        }
      } catch { /* sin dato */ }
    }
    this.credits = { at: Date.now(), value };
    return value;
  }

  private async quotas(cfg: HealthConfig, credits: { totalCredits: number | null }) {
    try {
      const st = await new GeminiPool(this.prisma).status();
      // Con 10 o más créditos comprados, OpenRouter sube el cupo gratis a 1.000 al día
      const orLimit = (credits.totalCredits ?? 0) >= 10 ? Math.max(1000, cfg.openrouterFreeDailyLimit) : cfg.openrouterFreeDailyLimit;
      return {
        gemini: st.keys.map((k: any) => ({ label: k.label, used: k.exhausted ? Math.max(k.requestsToday, k.limit) : k.requestsToday, limit: k.limit })),
        openrouter: st.backup.keys.map((k: any) => ({ label: k.label, used: k.exhausted ? Math.max(k.requestsToday, orLimit) : k.requestsToday, limit: orLimit })),
      };
    } catch {
      return { gemini: [], openrouter: [] };
    }
  }

  /** Empresas activas con plan que necesitan una llamada. */
  private async companiesAtRisk(cfg: HealthConfig, now: Date) {
    const companies = await this.prisma.company.findMany({
      where: { status: 'ACTIVE', planId: { not: null } },
      select: { id: true, name: true, createdAt: true },
    });
    if (!companies.length) return [];
    const ids = companies.map((c: any) => c.id);
    const inactiveSince = new Date(now.getTime() - cfg.inactiveDays * DAY);
    const [lines, bots, recent, invoices] = await Promise.all([
      this.prisma.integration.findMany({ where: { companyId: { in: ids }, type: 'WHATSAPP' }, select: { companyId: true, status: true } }),
      this.prisma.bot.findMany({ where: { companyId: { in: ids } }, select: { companyId: true, status: true } }),
      this.prisma.conversation.findMany({ where: { companyId: { in: ids }, lastMessageAt: { gte: inactiveSince } }, select: { companyId: true }, distinct: ['companyId'] }),
      this.prisma.invoice.findMany({ where: { companyId: { in: ids }, status: { not: 'PAID' }, issuedAt: { lt: new Date(now.getTime() - cfg.invoiceOverdueDays * DAY) } }, select: { companyId: true } }),
    ]);
    const active = new Set(recent.map((r: any) => r.companyId));
    const overdue = new Set(invoices.map((r: any) => r.companyId));
    const out: Array<{ id: string; name: string; reasons: string[] }> = [];
    for (const c of companies as any[]) {
      const reasons: string[] = [];
      if (!lines.some((l: any) => l.companyId === c.id && l.status === 'CONNECTED')) reasons.push('WhatsApp desconectado');
      if (!bots.some((b: any) => b.companyId === c.id && b.status === 'ACTIVE')) reasons.push('asistente apagado');
      if (!active.has(c.id) && new Date(c.createdAt) < inactiveSince) reasons.push(`sin conversaciones en ${cfg.inactiveDays} días`);
      if (overdue.has(c.id)) reasons.push('factura vencida');
      if (reasons.length) out.push({ id: c.id, name: c.name, reasons });
    }
    return out;
  }

  /** Configuración de seguridad que debe estar en producción. */
  private async security(): Promise<HealthMetrics['security']> {
    const keys = await this.prisma.platformSetting.findMany({ where: { key: { in: ['META_APP_SECRET', 'WOMPI_EVENTS_SECRET'] } }, select: { key: true, value: true } }).catch(() => []);
    const has = (k: string) => !!process.env[k] || keys.some((r: any) => r.key === k && r.value);
    // Total menos los que tienen MFA (en Mongo, los usuarios viejos no tienen el campo y no los encuentra un filtro "false")
    const platformWhere = { role: { in: ['SUPER_ADMIN', 'DEV'] }, active: true };
    const [platformTotal, platformMfa] = await Promise.all([
      this.prisma.user.count({ where: platformWhere }).catch(() => 0),
      this.prisma.user.count({ where: { ...platformWhere, mfaEnabled: true } }).catch(() => 0),
    ]);
    const platformWithoutMfa = Math.max(0, platformTotal - platformMfa);
    return {
      production: ENV === 'prod',
      trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0) || 0,
      metaSecret: has('META_APP_SECRET'),
      wompiEventsSecret: has('WOMPI_EVENTS_SECRET'),
      platformMfaRequired: process.env.PLATFORM_MFA_REQUIRED === 'true',
      platformWithoutMfa,
    };
  }

  /** Mide todo y evalúa. */
  async measure(now = new Date()): Promise<{ metrics: HealthMetrics; checks: HealthCheck[]; config: HealthConfig }> {
    const cfg = await this.config();
    const week = await this.samples(7);
    const perf = perfSnapshot(60);
    const day = week.filter((s) => s.at.getTime() >= now.getTime() - DAY);
    const boots = new Set([...day.map((s) => s.bootId), BOOT_ID]);
    const [mongo, redis, ai, trm] = await Promise.all([this.mongo(), this.redis(), this.aiSpend(now), usdCopRate(this.prisma)]);
    const metrics: HealthMetrics = {
      at: now.toISOString(),
      trm,
      perf,
      restarts24h: Math.max(0, boots.size - 1),
      days: dailyStats(week, 7, now),
      mongo: mongo ? { ...mongo, growthMbPerDay: growthPerDay(week.filter((s) => s.data?.mongo?.usedMb != null).map((s) => ({ at: s.at, mb: s.data.mongo.usedMb })).concat([{ at: now, mb: mongo.usedMb }])) } : null,
      redis,
      ai,
      quotas: await this.quotas(cfg, ai.openrouter),
      companies: await this.companiesAtRisk(cfg, now),
      security: await this.security(),
    };
    return { metrics, checks: evaluateHealth(metrics, cfg), config: cfg };
  }

  /** Lo que ve Plataforma → Salud (cacheado 1 minuto). */
  async view(refresh = false) {
    if (!refresh && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.value;
    const { metrics, checks, config } = await this.measure();
    const value = { at: metrics.at, env: ENV, summary: healthSummary(checks), checks, metrics, config };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Insignia del menú: lo de la última foto (barato). */
  async summary() {
    const last = await this.prisma.healthSample.findFirst({ where: { env: ENV }, orderBy: { at: 'desc' }, select: { at: true, dataJson: true } });
    if (!last) return { level: 'NA', crit: 0, warn: 0, at: null };
    try {
      return { ...JSON.parse(last.dataJson).summary, at: last.at };
    } catch {
      return { level: 'NA', crit: 0, warn: 0, at: last.at };
    }
  }

  /** Historial compacto para las gráficas (una cifra por foto). */
  async history(days = 30) {
    const rows = await this.samples(Math.min(KEEP_DAYS, Math.max(1, days)));
    return rows.map((s) => ({
      at: s.at,
      p95Ms: s.data?.perf?.p95Ms ?? null,
      rssMb: s.data?.perf?.rssMb ?? null,
      mongoMb: s.data?.mongo?.usedMb ?? null,
      redisMb: s.data?.redis?.usedMb ?? null,
      aiTodayUsd: s.data?.ai?.todayUsd ?? null,
      level: s.data?.summary?.level ?? null,
    }));
  }

  /* ── Vigilante ── */

  @Cron('*/10 * * * *')
  async snapshot() {
    try {
      const { metrics, checks } = await this.measure();
      const p10 = perfSnapshot(10);
      resetLoopMeter();
      const levels = Object.fromEntries(checks.map((c) => [c.key, c.level]));
      await this.prisma.healthSample.create({
        data: {
          env: ENV,
          bootId: BOOT_ID,
          at: new Date(metrics.at),
          dataJson: JSON.stringify({
            perf: { ...metrics.perf, requests10: p10.requests, errors10: p10.errors5xx },
            mongo: metrics.mongo ? { usedMb: metrics.mongo.usedMb } : null,
            redis: metrics.redis ? { usedMb: metrics.redis.usedMb } : null,
            ai: { todayUsd: metrics.ai.todayUsd, monthUsd: metrics.ai.monthUsd },
            summary: healthSummary(checks),
            levels,
          }),
        },
      });
      await this.prisma.healthSample.deleteMany({ where: { env: ENV, at: { lt: new Date(Date.now() - KEEP_DAYS * DAY) } } });
      await this.alertNewCritical(checks);
    } catch (err) {
      this.logger.error(`foto de salud falló: ${(err as Error).message}`);
    }
  }

  /** Correo inmediato solo cuando algo PASA a rojo (no repite mientras siga rojo). */
  private async alertNewCritical(checks: HealthCheck[]) {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: STATE_KEY } }).catch(() => null);
    let prev: Record<string, string> = {};
    try { prev = row?.value ? JSON.parse(row.value) : {}; } catch { prev = {}; }
    const now = Object.fromEntries(checks.map((c) => [c.key, c.level]));
    const fresh = checks.filter((c) => c.level === 'CRIT' && prev[c.key] !== 'CRIT');
    const value = JSON.stringify(now);
    await this.prisma.platformSetting.upsert({ where: { key: STATE_KEY }, create: { key: STATE_KEY, value }, update: { value } });
    // Desde un computador de pruebas no se avisa al equipo
    if (!fresh.length || ENV !== 'prod') return;
    await this.mail(`Salud en rojo: ${fresh.map((c) => c.title).join(' · ')}`, this.html(fresh, 'Esto acaba de pasar a rojo'));
  }

  /** Resumen diario a las 7:00 a. m. con lo amarillo y lo rojo. */
  @Cron('0 7 * * *', { timeZone: 'America/Bogota' })
  async dailyDigest() {
    if (ENV !== 'prod') return;
    try {
      const { checks } = await this.measure();
      const bad = checks.filter((c) => c.level === 'CRIT' || c.level === 'WARN');
      const s = healthSummary(checks);
      await this.mail(
        bad.length ? `Salud de BackOffice: ${s.crit} en rojo, ${s.warn} en amarillo` : 'Salud de BackOffice: todo en verde',
        bad.length ? this.html(bad, 'Resumen de hoy') : '<p>Todo en verde: IA, base de datos, servidor, Redis, cupos y empresas.</p>',
      );
    } catch (err) {
      this.logger.error(`resumen diario falló: ${(err as Error).message}`);
    }
  }

  private html(list: HealthCheck[], title: string) {
    const color = (l: string) => (l === 'CRIT' ? '#b42318' : '#b54708');
    return `<p><b>${esc(title)}</b></p>` + list.map((c) =>
      `<p style="border-left:4px solid ${color(c.level)};padding-left:8px"><b>${esc(c.title)}</b>: ${esc(c.value)}<br>${esc(c.detail)}${c.advice ? `<br><i>${esc(c.advice)}</i>` : ''}</p>`,
    ).join('') + '<p>Detalle en Plataforma → Salud.</p>';
  }

  private async mail(subject: string, body: string) {
    for (const toEmail of await teamEmails(this.prisma)) {
      await this.emails.systemSend({ toEmail, subject, body }).catch(() => undefined);
    }
  }
}

@Controller('platform/health')
@Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
export class PlatformHealthController {
  constructor(private readonly health: PlatformHealthService) {}

  @Get()
  view(@Query('refresh') refresh?: string) {
    return this.health.view(refresh === '1');
  }

  @Get('summary')
  summary() {
    return this.health.summary();
  }

  @Get('history')
  history(@Query('days') days?: string) {
    return this.health.history(Number(days) || 30);
  }

  @Get('config')
  config() {
    return this.health.config();
  }

  @Put('config')
  saveConfig(@CurrentUser() user: AuthUser, @Body() dto: unknown) {
    return this.health.saveConfig(user, dto);
  }
}

@Module({
  imports: [AuditModule, EmailsModule],
  controllers: [PlatformHealthController],
  providers: [PlatformHealthService],
})
export class PlatformHealthModule {}
