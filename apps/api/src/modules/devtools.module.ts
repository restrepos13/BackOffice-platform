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
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { getRecentLogs } from '../common/log-buffer';
import { AuditService } from './audit.module';
import { EventsService } from './events.module';
import { EmailsModule, EmailsService } from './emails.module';
import { TwilioModule, TwilioService } from './twilio.module';
import { AI_PROVIDER, AiProvider } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { resolveAiAccess } from '../ai/ai-access';
import {
  ENGINE_QUEUE,
  WA_INBOUND_QUEUE,
  WA_OUTBOUND_QUEUE,
} from '../queue/queue.module';

const startedAt = Date.now();

/** Checklist de settings de plataforma: qué está configurado y qué falta. */
const SETTING_GROUPS: Array<{ group: string; keys: string[]; purpose: string }> = [
  { group: 'Webhooks', keys: ['WEBHOOK_BASE_URL'], purpose: 'URL pública para Twilio/Meta (firma de webhooks)' },
  { group: 'Meta', keys: ['META_APP_ID', 'META_VERIFY_TOKEN'], purpose: 'Conexión de canales y verificación del webhook Cloud API' },
  { group: 'Correo', keys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'], purpose: 'Envío real de correos (sin esto quedan en cola)' },
  { group: 'Wompi', keys: ['WOMPI_PUBLIC_KEY', 'WOMPI_INTEGRITY_SECRET', 'WOMPI_EVENTS_SECRET', 'USD_COP_RATE'], purpose: 'Pagos Colombia' },
  { group: 'Video (MoneyPrinterTurbo)', keys: ['MPT_BASE_URL', 'MPT_API_KEY'], purpose: 'Generación de reels del módulo de marketing' },
];

@Injectable()
export class DevToolsService {
  constructor(
    private readonly prisma: PrismaService,
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
      keys: g.keys.map((key) => ({ key, configured: !!settings[key] })),
      complete: g.keys.every((key) => !!settings[key]),
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
    if (!access.ok) return { ok: false, error: access.reason };
    const start = Date.now();
    try {
      const res = await this.ai.chat({
        apiKey: access.apiKey,
        model: 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0,
        maxTokens: 5,
        messages: [{ role: 'user', content: 'Responde solo: OK' }],
      });
      await this.audit.log({
        actor, companyId, action: 'dev.test_deepinfra',
        entity: 'Company', entityId: companyId, detail: `ok en ${Date.now() - start} ms (${access.billedTo})`,
      });
      return { ok: true, latencyMs: Date.now() - start, model: res.model, reply: res.content.trim().slice(0, 40), billedTo: access.billedTo };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
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
    return this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
    });
  }

  async createApiKey(actor: AuthUser, dto: { name: string; companyId?: string; scopes?: string[] }) {
    const secret = `bo_live_${randomBytes(24).toString('hex')}`;
    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        companyId: dto.companyId ?? null,
        prefix: secret.slice(0, 16),
        hash: createHash('sha256').update(secret).digest('hex'),
        scopesJson: JSON.stringify(dto.scopes ?? ['read']),
      },
    });
    await this.audit.log({
      actor, companyId: dto.companyId, action: 'apikey.create',
      entity: 'ApiKey', entityId: key.id, detail: dto.name,
    });
    // El secreto solo se devuelve una vez
    return { ...key, secret };
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
  controllers: [DevToolsController],
  providers: [
    DevToolsService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
})
export class DevToolsModule {}
