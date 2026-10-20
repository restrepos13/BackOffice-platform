import { currentTrm } from '../common/trm';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { SkipThrottle } from '@nestjs/throttler';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { getRecentLogs } from '../common/log-buffer';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { EmailsModule, EmailsService } from './emails.module';
import { TwilioModule, TwilioService } from './twilio.module';
import { AI_PROVIDER, AiProvider } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { platformAiKey, readCompanyKey, resolveAiAccess } from '../ai/ai-access';
import {
  ENGINE_QUEUE,
  WA_INBOUND_QUEUE,
  WA_OUTBOUND_QUEUE,
} from '../queue/queue.module';

const startedAt = Date.now();

/** Permisos de una API key: read (consultas), write, orders (pedidos externos: Rappi, POS…) */
export const API_KEY_SCOPES = ['read', 'write', 'orders'];

/** Checklist de settings de plataforma: qué está configurado y qué falta. */
const SETTING_GROUPS: Array<{ group: string; keys: string[]; purpose: string }> = [
  { group: 'Webhooks', keys: ['WEBHOOK_BASE_URL'], purpose: 'URL pública para Twilio/Meta (firma de webhooks)' },
  { group: 'Web pública', keys: ['PUBLIC_WEB_URL'], purpose: 'Dominio de la web: links de seguimiento de pedidos (/t/…) que recibe el cliente' },
  { group: 'IA de BackOffice', keys: ['DEEPINFRA_API_KEY'], purpose: 'Llave propia para empresas en modo IA revendida (las BYOK usan la suya)' },
  { group: 'Meta', keys: ['META_APP_ID', 'META_VERIFY_TOKEN', 'META_APP_SECRET'], purpose: 'Canales Meta (WhatsApp Cloud, Instagram, Messenger): verificación y firma de webhooks' },
  { group: 'Registro web', keys: ['GEMINI_API_KEYS', 'SIGNUP_NOTIFY_EMAIL'], purpose: 'IA genérica (Gemini, llaves solo en el .env, rotan solas) que arma las empresas nuevas y las acompaña; correo que recibe cada registro' },
  { group: 'Correo', keys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'], purpose: 'Envío real de correos (sin esto quedan en cola)' },
  { group: 'Wompi', keys: ['WOMPI_PUBLIC_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET'], purpose: 'Pagos Colombia' },
  { group: 'Dólar (TRM)', keys: ['TRM_MARKUP_COP', 'USD_COP_RATE'], purpose: 'TRM oficial en vivo + margen; la tasa de respaldo solo se usa si no hay conexión' },
  { group: 'Video (MoneyPrinterTurbo)', keys: ['MPT_BASE_URL', 'MPT_API_KEY'], purpose: 'Generación de reels del módulo de marketing' },
];

@Injectable()
export class DevToolsService {
  constructor(
    readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
    private readonly twilio: TwilioService,
    @Optional() private readonly events?: EventsService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
    @Optional() @Inject(WA_INBOUND_QUEUE) private readonly inboundQueue?: Queue,
    @Optional() @Inject(WA_OUTBOUND_QUEUE) private readonly outboundQueue?: Queue,
    @Optional() @Inject(ENGINE_QUEUE) private readonly engineQueue?: Queue,
  ) {}

  private queues(): Array<{ name: string; queue: Queue }> {
    return [
      { name: 'wa-inbound', queue: this.inboundQueue! },
      { name: 'wa-outbound', queue: this.outboundQueue! },
      { name: 'engine', queue: this.engineQueue! },
    ].filter((q) => q.queue);
  }

  /** Tablero de salud: proceso, base, colas, SSE y settings pendientes. */
  async status() {
    const dbStart = Date.now();
    let dbOk = true;
    try {
      await this.prisma.$runCommandRaw({ ping: 1 });
    } catch {
      dbOk = false;
    }
    const dbMs = Date.now() - dbStart;

    const queues: Array<Record<string, any>> = [];
    let redisOk = true;
    for (const { name, queue } of this.queues()) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        queues.push({ name, ...counts });
      } catch (err: any) {
        redisOk = false;
        queues.push({ name, error: err.message });
      }
    }

    const settings = await this.getSettings();
    const settingsChecklist = SETTING_GROUPS.map((g) => ({
      group: g.group,
      purpose: g.purpose,
      // Configurado en Dev Tools o en el .env del servidor
      keys: g.keys.map((key) => ({ key, configured: !!settings[key] || !!process.env[key] })),
      complete: g.keys.every((key) => !!settings[key] || !!process.env[key]),
    }));

    const memory = process.memoryUsage();
    return {
      status: dbOk && redisOk ? 'ok' : 'degraded',
      db: { ok: dbOk, latencyMs: dbMs, engine: 'MongoDB Atlas' },
      redis: { ok: redisOk },
      queues,
      sseConnections: this.events?.subscriberCount() ?? 0,
      process: {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        node: process.version,
        rssMb: Math.round(memory.rss / 1048576),
        heapMb: Math.round(memory.heapUsed / 1048576),
        env: process.env.NODE_ENV ?? 'development',
      },
      settingsChecklist,
    };
  }

  /** Últimos errores/warnings del proceso (ring buffer del logger). */
  logs(level?: string, limit?: string) {
    return getRecentLogs(level, Number(limit) || 100);
  }

  /** Reintenta TODOS los jobs fallidos de las colas. */
  async retryFailed(actor: AuthUser) {
    const results: Record<string, number> = {};
    for (const { name, queue } of this.queues()) {
      const failed = await queue.getFailed(0, 200);
      for (const job of failed) await job.retry().catch(() => undefined);
      results[name] = failed.length;
    }
    await this.audit.log({
      actor, action: 'dev.queues_retry', entity: 'Queue',
      detail: Object.entries(results).map(([q, n]) => `${q}: ${n}`).join(' · '),
    });
    return results;
  }

  /**
   * Simulador de mensajes entrantes: dispara el MISMO flujo del webhook de
   * Twilio (cola → contacto → conversación → motor) SIN salir a internet.
   * SOLO funciona contra líneas en sandbox — jamás contra una línea real.
   */
  async simulateInbound(
    actor: AuthUser,
    dto: { companyId: string; from?: string; name?: string; body: string },
  ) {
    if (!dto.body?.trim()) throw new BadRequestException('Falta el mensaje');
    const line = await this.prisma.integration.findFirst({
      where: { companyId: dto.companyId, type: 'WHATSAPP' },
    });
    if (!line) throw new NotFoundException('La empresa no tiene línea de WhatsApp');
    const cfg = parseJson<Record<string, any>>(line.configJson, {});
    if (cfg.sandbox !== true) {
      throw new BadRequestException(
        'El simulador solo funciona con líneas EN SANDBOX (esta línea está en producción)',
      );
    }
    const sid = `SIM_${randomBytes(8).toString('hex')}`;
    const from = (dto.from?.trim() || '+570000000001').replace(/\s+/g, '');
    await this.twilio.enqueueInbound(dto.companyId, line.id, {
      MessageSid: sid,
      From: `whatsapp:${from}`,
      To: 'whatsapp:+14155238886',
      ProfileName: dto.name?.trim() || 'Cliente Simulado',
      Body: dto.body.trim(),
    });
    await this.audit.log({
      actor, companyId: dto.companyId, action: 'dev.simulate_inbound',
      entity: 'Integration', entityId: line.id,
      detail: `${from}: ${dto.body.slice(0, 80)}`,
    });
    return { ok: true, sid, line: line.name, from };
  }

  /** Correo de prueba con el SMTP configurado (o queda QUEUED si falta). */
  async testEmail(actor: AuthUser, to: string) {
    if (!to?.includes('@')) throw new BadRequestException('Correo destino inválido');
    const result = await this.emails.systemSend({
      companyId: null,
      toEmail: to,
      subject: 'Prueba de correo — BackOffice',
      body: '<p>Este es un correo de prueba disparado desde Dev Tools. Si lo estás leyendo, el SMTP funciona.</p>',
    });
    await this.audit.log({
      actor, action: 'dev.test_email', entity: 'EmailMessage', detail: to,
    });
    return result;
  }

  /** Prueba la llave DeepInfra de una empresa con una llamada mínima. */
  async testDeepinfra(actor: AuthUser, companyId: string) {
    if (!this.ai) throw new BadRequestException('Proveedor de IA no disponible');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const access = await resolveAiAccess(this.prisma, company);
    if (!access.ok) return { ok: false, error: access.reason, checks: [] };
    // Se prueba CADA llave que la empresa puede usar (en híbrido, las dos)
    const ai = this.ai;
    const candidates = [
      { source: 'BYOK' as const, key: readCompanyKey(company.deepinfraApiKey) },
      { source: 'PLATFORM' as const, key: await platformAiKey(this.prisma) },
    ].filter((c) =>
      c.key && (access.mode === 'HYBRID' || c.source === access.billedTo),
    );
    const checks: Array<{
      source: 'BYOK' | 'PLATFORM'; ok: boolean; latencyMs: number;
      model?: string; reply?: string; error?: string;
    }> = [];
    for (const candidate of candidates) {
      const start = Date.now();
      try {
        const res = await ai.chat({
          apiKey: candidate.key!,
          model: 'meta-llama/Llama-3.3-70B-Instruct',
          temperature: 0,
          maxTokens: 5,
          messages: [{ role: 'user', content: 'Responde solo: OK' }],
        });
        checks.push({ source: candidate.source, ok: true, latencyMs: Date.now() - start, model: res.model, reply: res.content.trim().slice(0, 40) });
      } catch (err: any) {
        checks.push({ source: candidate.source, ok: false, latencyMs: Date.now() - start, error: err.message });
      }
    }
    const primary = checks.find((c) => c.source === access.billedTo) ?? checks[0];
    await this.audit.log({
      actor, companyId, action: 'dev.test_deepinfra',
      entity: 'Company', entityId: companyId,
      detail: checks.map((c) => `${c.source}: ${c.ok ? `ok ${c.latencyMs} ms` : 'falló'}`).join(' · '),
    });
    return {
      ok: checks.some((c) => c.ok),
      mode: access.mode,
      billedTo: access.billedTo,
      latencyMs: primary?.latencyMs,
      model: primary?.model,
      reply: primary?.reply,
      error: checks.every((c) => !c.ok) ? primary?.error : undefined,
      checks,
    };
  }

  async health() {
    let dbOk = true;
    try {
      await this.prisma.$runCommandRaw({ ping: 1 });
    } catch {
      dbOk = false;
    }
    const [companies, users, conversations, messages] = await Promise.all([
      this.prisma.company.count(),
      this.prisma.user.count(),
      this.prisma.conversation.count(),
      this.prisma.message.count(),
    ]);
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected (MongoDB Atlas)' : 'error',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
      counts: { companies, users, conversations, messages },
    };
  }

  async listApiKeys() {
    const keys = await this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
    });
    // El hash nunca sale del API
    return keys.map(({ hash: _hash, scopesJson, ...k }) => ({ ...k, scopes: parseJson<string[]>(scopesJson, []) }));
  }

  async createApiKey(actor: AuthUser, dto: { name: string; companyId?: string; scopes?: string[] }) {
    const secret = `bo_live_${randomBytes(24).toString('hex')}`;
    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        companyId: dto.companyId ?? null,
        prefix: secret.slice(0, 16),
        hash: createHash('sha256').update(secret).digest('hex'),
        scopesJson: JSON.stringify(
          (Array.isArray(dto.scopes) ? dto.scopes : ['read']).filter((sc) => API_KEY_SCOPES.includes(String(sc))).slice(0, 5),
        ),
      },
    });
    await this.audit.log({
      actor, companyId: dto.companyId, action: 'apikey.create',
      entity: 'ApiKey', entityId: key.id, detail: dto.name,
    });
    // El secreto solo se devuelve una vez (el hash jamás)
    const { hash: _hash, scopesJson, ...rest } = key;
    return { ...rest, scopes: parseJson<string[]>(scopesJson, []), secret };
  }

  async revokeApiKey(actor: AuthUser, id: string) {
    const key = await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      actor, companyId: key.companyId, action: 'apikey.revoke',
      entity: 'ApiKey', entityId: id, detail: key.name,
    });
    return key;
  }

  async getSettings() {
    const rows = await this.prisma.platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSettings(actor: AuthUser, values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    await this.audit.log({
      actor, action: 'settings.update', entity: 'PlatformSetting',
      detail: Object.keys(values).join(', '),
    });
    return this.getSettings();
  }
}

/** Salud pública para Render y el ping que mantiene despierto el plan gratis. */
@Controller()
export class PublicHealthController {
  @Public()
  @SkipThrottle()
  @Get('health')
  health() {
    return { ok: true, at: new Date().toISOString() };
  }
}

@Controller('dev')
@Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
export class DevToolsController {
  constructor(private readonly dev: DevToolsService) {}

  @Get('health')
  health() {
    return this.dev.health();
  }

  @Get('status')
  status() {
    return this.dev.status();
  }

  @Get('logs')
  logs(@Query('level') level?: string, @Query('limit') limit?: string) {
    return this.dev.logs(level, limit);
  }

  @Post('queues/retry-failed')
  retryFailed(@CurrentUser() user: AuthUser) {
    return this.dev.retryFailed(user);
  }

  @Post('simulate-inbound')
  simulateInbound(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.dev.simulateInbound(user, dto);
  }

  @Post('test-email')
  testEmail(@CurrentUser() user: AuthUser, @Body('to') to: string) {
    return this.dev.testEmail(user, to);
  }

  @Post('test-deepinfra')
  testDeepinfra(@CurrentUser() user: AuthUser, @Body('companyId') companyId: string) {
    return this.dev.testDeepinfra(user, companyId);
  }

  @Get('apikeys')
  listApiKeys() {
    return this.dev.listApiKeys();
  }

  @Post('apikeys')
  createApiKey(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.dev.createApiKey(user, dto);
  }

  @Delete('apikeys/:id')
  revokeApiKey(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.dev.revokeApiKey(user, id);
  }

  @Get('trm')
  trm() {
    return currentTrm(this.dev.prisma);
  }

  @Post('trm/refresh')
  refreshTrm() {
    return currentTrm(this.dev.prisma, { force: true });
  }

  @Get('settings')
  getSettings() {
    return this.dev.getSettings();
  }

  @Put('settings')
  setSettings(@CurrentUser() user: AuthUser, @Body() values: Record<string, string>) {
    return this.dev.setSettings(user, values);
  }
}

@Module({
  imports: [EmailsModule, TwilioModule],
  controllers: [DevToolsController, PublicHealthController],
  providers: [
    DevToolsService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
})
export class DevToolsModule {}
