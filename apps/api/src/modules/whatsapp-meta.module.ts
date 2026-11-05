import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module,
  NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { GRAPH } from '../common/meta';
import { assertChannelAllowed, verifyChannelAllowed } from '../common/channel-limits';
import { integrationView } from '../common/integration-view';
import { usdCopRate } from '../common/trm';
import { META_BILLING_NOTICE, MetaCategory, metaRatesFor } from '../common/whatsapp/meta-rates';
import {
  META_TEMPLATE_LANGUAGE, MetaApiError, StoredTemplate, TEMPLATE_STATUS_LABEL, TemplateDraft, bodyVariables,
  createMetaTemplate, deleteMetaTemplate, listMetaTemplates, marketingSignals, mergeRemoteTemplates, metaNameFor,
  rejectionText, validateTemplateDraft, withMetaState,
} from '../common/whatsapp/meta-templates';
import { TEMPLATE_LIBRARY, libraryTemplate } from '../common/whatsapp/template-library';
import {
  exchangeSignupCode, missingSignupSettings, newRegistrationPin, readPhoneNumber, readSignupSession, registerPhone, subscribeApp,
} from '../common/whatsapp/embedded-signup';
import { AuditService } from './audit.module';

/**
 * WhatsApp por Meta directo (Cloud API), sin intermediarios:
 *  - Conectar el número con el registro integrado de Meta: queda a nombre de
 *    la empresa, en su cuenta, con su medio de pago.
 *  - Plantillas: crearlas (desde la biblioteca o propias), sincronizar su
 *    estado con Meta y eliminarlas. Los flujos las usan solas al aprobarse.
 *  - Transparencia: lo que Meta le cobra a la empresa, por categoría y por mes.
 */

/** Línea de Meta lista para administrar plantillas (WABA + token). */
interface MetaLine { id: string; wabaId: string; token: string; displayPhone: string | null }

@Injectable()
export class WhatsappMetaService {
  private readonly logger = new Logger('WhatsappMeta');
  /** Reemplazable en pruebas: ninguna prueba llama a Meta de verdad. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async setting(key: string): Promise<string> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } });
    return (row?.value ?? process.env[key] ?? '').trim();
  }

  private async companyOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    return company;
  }

  private stored(company: any): StoredTemplate[] {
    return parseJson<StoredTemplate[]>(company.waTemplatesJson, []).filter((t) => t && typeof t.key === 'string');
  }

  private async save(companyId: string, templates: StoredTemplate[]) {
    await this.prisma.company.update({ where: { id: companyId }, data: { waTemplatesJson: JSON.stringify(templates) } });
  }

  /** La primera línea de Meta conectada de la empresa con WABA y token. */
  private async metaLine(companyId: string): Promise<MetaLine | null> {
    const lines = await this.prisma.integration.findMany({ where: { companyId, type: 'WHATSAPP' }, orderBy: { createdAt: 'asc' } });
    for (const l of lines) {
      const cfg = parseJson<Record<string, any>>(l.configJson, {});
      if (cfg.provider !== 'META' || !cfg.wabaId || !isEncrypted(cfg.accessTokenEnc)) continue;
      try {
        return { id: l.id, wabaId: String(cfg.wabaId), token: decryptSecret(cfg.accessTokenEnc), displayPhone: cfg.displayPhone ?? null };
      } catch {
        continue; // token con otra llave maestra: esa línea no sirve para administrar
      }
    }
    return null;
  }

  private async requireMetaLine(companyId: string): Promise<MetaLine> {
    const line = await this.metaLine(companyId);
    if (!line) throw new BadRequestException('Primero conecta tu número de WhatsApp con Meta: las plantillas viven en tu cuenta de WhatsApp Business.');
    return line;
  }

  private metaError(err: unknown): never {
    if (err instanceof MetaApiError) throw new BadRequestException(err.message);
    throw err;
  }

  /* ── Configuración del botón y aviso de cobro ── */

  async config(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const [appId, appSecret, configId] = await Promise.all([this.setting('META_APP_ID'), this.setting('META_APP_SECRET'), this.setting('META_WA_CONFIG_ID')]);
    const missing = missingSignupSettings({ appId, appSecret, configId });
    return {
      available: missing.length === 0,
      // Qué falta solo lo ve el equipo de la plataforma (nombres, nunca valores)
      ...(isPlatformRole(user.role) ? { missing } : {}),
      appId: missing.length ? null : appId,
      configId: missing.length ? null : configId,
      graphVersion: GRAPH.split('/').pop(),
      notice: META_BILLING_NOTICE,
      rates: metaRatesFor(company),
      trm: await usdCopRate(this.prisma).catch(() => null),
    };
  }

  /* ── Conexión con el registro integrado de Meta ── */

  async connect(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const session = readSignupSession(dto);
    if (!session) throw new BadRequestException('Faltan datos de la conexión con Meta: vuelve a intentarlo desde el botón.');
    const [appId, appSecret, configId, verifyToken, base] = await Promise.all([
      this.setting('META_APP_ID'), this.setting('META_APP_SECRET'), this.setting('META_WA_CONFIG_ID'),
      this.setting('META_VERIFY_TOKEN'), this.setting('WEBHOOK_BASE_URL'),
    ]);
    if (missingSignupSettings({ appId, appSecret, configId }).length) {
      throw new BadRequestException('La conexión con Meta aún no está habilitada en BackOffice. Escríbenos y la hacemos contigo.');
    }
    // El número no puede quedar en dos empresas
    const taken = await this.prisma.integration.findFirst({
      where: { type: 'WHATSAPP', configJson: { contains: `"phoneNumberId":"${session.phoneNumberId}"` }, NOT: { companyId: company.id } },
      select: { id: true },
    });
    if (taken) throw new BadRequestException('Ese número ya está conectado en otra empresa de BackOffice.');

    let line = dto?.integrationId
      ? await this.prisma.integration.findFirst({ where: { id: String(dto.integrationId), companyId: company.id, type: 'WHATSAPP' } })
      : await this.prisma.integration.findFirst({ where: { companyId: company.id, type: 'WHATSAPP', configJson: { contains: `"phoneNumberId":"${session.phoneNumberId}"` } } });
    if (dto?.integrationId && !line) throw new NotFoundException('Línea no encontrada');

    let token: string;
    let phone;
    try {
      token = await exchangeSignupCode({ appId, appSecret, configId }, session.code, this.fetchImpl);
      phone = await readPhoneNumber(token, session.phoneNumberId, this.fetchImpl);
      const callback = base && verifyToken ? { url: `${base.replace(/\/$/, '')}/api/webhooks/${company.slug}/whatsapp`, verifyToken } : null;
      await subscribeApp(token, session.wabaId, callback, this.fetchImpl);
    } catch (err) {
      this.metaError(err);
    }
    const pin = newRegistrationPin();
    const registered = await registerPhone(token!, session.phoneNumberId, pin, this.fetchImpl);

    if (!line) {
      await assertChannelAllowed(this.prisma, company.id, 'WHATSAPP');
      line = await this.prisma.integration.create({
        data: {
          companyId: company.id, type: 'WHATSAPP', name: String(dto?.name ?? '').trim().slice(0, 60) || phone!.verifiedName || 'WhatsApp',
          status: 'DISCONNECTED', configJson: '{}', webhookUrl: `/api/webhooks/${company.slug}/whatsapp`,
        },
      });
      const created = line;
      await verifyChannelAllowed(this.prisma, company.id, 'WHATSAPP', created.id, () => this.prisma.integration.delete({ where: { id: created.id } }));
    }
    const previous = parseJson<Record<string, any>>(line.configJson, {});
    // Cambio de proveedor: se quitan las credenciales de Twilio para que no quede nada a medias
    const { accountSid: _a, authTokenEnc: _b, fromNumber: _c, messagingServiceSid: _d, sandbox: _e, ...keep } = previous;
    const config = {
      ...keep,
      provider: 'META',
      connectedVia: 'EMBEDDED_SIGNUP',
      connectedAt: new Date().toISOString(),
      phoneNumberId: session.phoneNumberId,
      wabaId: session.wabaId,
      displayPhone: phone!.displayPhone || keep.displayPhone || null,
      verifiedName: phone!.verifiedName,
      quality: phone!.quality,
      accessTokenEnc: encryptSecret(token!),
      ...(registered.ok ? { pinEnc: encryptSecret(pin) } : {}),
      registration: registered.ok ? { ok: true } : { ok: false, note: registered.note },
    };
    const updated = await this.prisma.integration.update({
      where: { id: line.id },
      data: { status: 'CONNECTED', configJson: JSON.stringify(config), lastSyncAt: new Date(), errorMsg: null },
      include: { company: { select: { name: true, slug: true } }, bot: { select: { id: true, name: true, model: true } } },
    });
    await this.audit.log({
      actor: user, companyId: company.id, action: 'whatsapp.meta_connect', entity: 'Integration', entityId: line.id,
      detail: `${config.displayPhone ?? 'número'} conectado con Meta (registro integrado)${registered.ok ? '' : ' · registro pendiente'}`,
    });
    // Las plantillas recomendadas se mandan a revisión de una vez (si alguna falla, no se cae la conexión)
    const templates = await this.installRecommended(company.id).catch((err) => ({ created: [], failed: [{ key: '*', error: String(err?.message ?? err) }] }));
    return {
      integration: integrationView(updated),
      registration: registered,
      templates,
      notice: META_BILLING_NOTICE,
    };
  }

  /* ── Plantillas ── */

  async list(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const rates = metaRatesFor(company);
    const line = await this.metaLine(company.id);
    const stored = this.stored(company);
    const templates = stored.map((t) => {
      const category = (t.category ?? 'MARKETING') as MetaCategory;
      return {
        key: t.key,
        label: t.name ?? t.key,
        body: t.body ?? '',
        category,
        provider: t.meta ? 'META' : t.contentSid ? 'TWILIO' : 'NONE',
        usable: !!t.contentSid,
        status: t.meta?.status ?? (t.contentSid ? 'APPROVED' : 'BORRADOR'),
        statusLabel: TEMPLATE_STATUS_LABEL[t.meta?.status ?? (t.contentSid ? 'APPROVED' : 'BORRADOR')],
        rejected: rejectionText(t.meta?.rejectedReason),
        previousCategory: t.meta?.previousCategory ?? null,
        quality: t.meta?.quality ?? null,
        variables: new Set(bodyVariables(t.body ?? '')).size,
        costPerMessageUsd: rates[category] ?? 0,
        usedFor: libraryTemplate(t.key)?.usedFor ?? null,
        updatedAt: t.meta?.updatedAt ?? null,
      };
    });
    const installed = new Set(stored.map((t) => t.key));
    return {
      connected: !!line,
      displayPhone: line?.displayPhone ?? null,
      templates,
      library: TEMPLATE_LIBRARY.filter((t) => !installed.has(t.key)).map((t) => ({
        key: t.key, label: t.label, category: t.category, body: t.body, usedFor: t.usedFor, variables: t.variables,
        recommended: t.recommended, costPerMessageUsd: rates[t.category],
      })),
      rates,
      notice: META_BILLING_NOTICE,
    };
  }

  private async submit(companyId: string, line: MetaLine, draft: TemplateDraft, label: string) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const stored = this.stored(company);
    const key = metaNameFor(draft.key);
    const existing = stored.find((t) => t.key === key);
    if (existing?.meta && !['REJECTED', 'DELETED', 'BORRADOR'].includes(existing.meta.status)) {
      throw new BadRequestException(`Ya tienes la plantilla «${existing.name ?? key}» en Meta.`);
    }
    if (existing && !existing.meta && existing.contentSid) {
      throw new BadRequestException(`La clave «${key}» ya la usa una plantilla de Twilio: elige otro nombre.`);
    }
    const res = await createMetaTemplate({ wabaId: line.wabaId, token: line.token, draft: { ...draft, key } }, this.fetchImpl).catch((err) => this.metaError(err));
    const now = new Date().toISOString();
    const entry = withMetaState(
      { key, name: label, category: draft.category, body: draft.body.trim() },
      {
        name: key, language: META_TEMPLATE_LANGUAGE, status: res.status, id: res.id || undefined, wabaId: line.wabaId,
        requestedCategory: draft.category, footer: draft.footer?.trim() || undefined,
        buttons: (draft.buttons ?? []).map((b) => b.trim()).filter(Boolean).slice(0, 3), examples: draft.examples.map(String), updatedAt: now,
      },
      res.category,
    );
    const next = [...stored.filter((t) => t.key !== key), entry];
    await this.save(companyId, next);
    return entry;
  }

  async create(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const draft: TemplateDraft = {
      key: String(dto?.key ?? dto?.label ?? ''),
      category: dto?.category === 'UTILIDAD' ? 'UTILIDAD' : dto?.category === 'MARKETING' ? 'MARKETING' : (undefined as any),
      body: String(dto?.body ?? ''),
      examples: Array.isArray(dto?.examples) ? dto.examples.map((e: unknown) => String(e ?? '').slice(0, 200)) : [],
      footer: dto?.footer ? String(dto.footer) : undefined,
      buttons: Array.isArray(dto?.buttons) ? dto.buttons.map((b: unknown) => String(b ?? '')) : [],
    };
    const errors = validateTemplateDraft(draft);
    if (errors.length) throw new BadRequestException({ message: errors[0], errors });
    const warnings = draft.category === 'UTILIDAD' && marketingSignals(draft.body).length
      ? [`Tiene palabras promocionales (${marketingSignals(draft.body).join(', ')}): Meta puede cobrarla como marketing.`]
      : [];
    if (warnings.length && dto?.acceptWarnings !== true) {
      throw new BadRequestException({ message: warnings[0], warnings, needsConfirmation: true, code: 'NEEDS_CONFIRMATION' });
    }
    const line = await this.requireMetaLine(company.id);
    const label = String(dto?.label ?? '').trim().slice(0, 60) || metaNameFor(draft.key);
    const entry = await this.submit(company.id, line, draft, label);
    await this.audit.log({ actor: user, companyId: company.id, action: 'whatsapp.template_create', entity: 'Company', entityId: company.id, detail: `${entry.key} (${entry.category}) enviada a revisión de Meta` });
    return { template: entry, warnings };
  }

  async installFromLibrary(user: AuthUser, key: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const lib = libraryTemplate(key);
    if (!lib) throw new NotFoundException('Esa plantilla no está en la biblioteca');
    const line = await this.requireMetaLine(company.id);
    const entry = await this.submit(company.id, line, lib, lib.label);
    await this.audit.log({ actor: user, companyId: company.id, action: 'whatsapp.template_create', entity: 'Company', entityId: company.id, detail: `${entry.key} (biblioteca) enviada a revisión de Meta` });
    return { template: entry };
  }

  /** Las recomendadas que aún no tiene (al conectar el número). */
  async installRecommended(companyId: string) {
    const line = await this.metaLine(companyId);
    if (!line) return { created: [], failed: [] };
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const have = new Set(this.stored(company).map((t) => t.key));
    const created: string[] = [];
    const failed: Array<{ key: string; error: string }> = [];
    for (const lib of TEMPLATE_LIBRARY.filter((t) => t.recommended && !have.has(t.key))) {
      try {
        await this.submit(companyId, line, lib, lib.label);
        created.push(lib.key);
      } catch (err: any) {
        failed.push({ key: lib.key, error: String(err?.response?.message ?? err?.message ?? err) });
      }
    }
    return { created, failed };
  }

  async sync(user: AuthUser | null, companyId: string) {
    const company = user ? await this.companyOf(user, companyId) : await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const line = await this.requireMetaLine(company.id);
    const remote = await listMetaTemplates({ wabaId: line.wabaId, token: line.token }, this.fetchImpl).catch((err) => this.metaError(err));
    const { templates, changed } = mergeRemoteTemplates(this.stored(company), remote);
    if (changed) await this.save(company.id, templates);
    return { changed, total: templates.filter((t) => t.meta).length };
  }

  async remove(user: AuthUser, key: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const stored = this.stored(company);
    const t = stored.find((x) => x.key === key);
    if (!t) throw new NotFoundException('Plantilla no encontrada');
    if (t.meta && t.meta.status !== 'DELETED') {
      const line = await this.requireMetaLine(company.id);
      await deleteMetaTemplate({ wabaId: line.wabaId, token: line.token, name: t.meta.name }, this.fetchImpl).catch((err) => {
        // Si Meta ya no la tiene, igual se quita de BackOffice
        if (!(err instanceof MetaApiError && err.status === 404)) this.metaError(err);
      });
    }
    await this.save(company.id, stored.filter((x) => x.key !== key));
    await this.audit.log({ actor: user, companyId: company.id, action: 'whatsapp.template_delete', entity: 'Company', entityId: company.id, detail: key });
    return { ok: true };
  }

  /* ── Lo que Meta le cobró a la empresa (estimado, por categoría) ── */

  async costs(user: AuthUser, month: string | undefined, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const now = new Date();
    const period = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : now.toISOString().slice(0, 7);
    const [y, m] = period.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    const rows = await this.prisma.message.findMany({
      where: { direction: 'OUT', createdAt: { gte: from, lt: to }, metaCategory: { not: null }, conversation: { companyId: company.id } },
      select: { metaCategory: true, metaCostUsd: true, deliveryStatus: true },
    });
    const by: Record<string, { count: number; usd: number }> = {};
    for (const r of rows) {
      if (r.deliveryStatus === 'SIMULATED' || r.deliveryStatus === 'FAILED' || r.deliveryStatus === 'CANCELLED') continue;
      const k = r.metaCategory ?? 'SERVICIO';
      by[k] ??= { count: 0, usd: 0 };
      by[k].count++;
      by[k].usd += r.metaCostUsd ?? 0;
    }
    const totalUsd = Object.values(by).reduce((s, v) => s + v.usd, 0);
    const trm = await usdCopRate(this.prisma).catch(() => null);
    return {
      period,
      byCategory: Object.entries(by).map(([category, v]) => ({ category, count: v.count, usd: Math.round(v.usd * 10000) / 10000 })),
      totalUsd: Math.round(totalUsd * 10000) / 10000,
      totalCop: trm ? Math.round(totalUsd * trm) : null,
      trm,
      paidTo: 'META',
      notice: META_BILLING_NOTICE,
    };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('AUTOMATION')
@Controller('whatsapp')
export class WhatsappMetaController {
  constructor(private readonly s: WhatsappMetaService) {}

  @Get('meta/config') @Roles(...READ)
  config(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.config(u, c); }

  @Post('meta/connect') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 5 } })
  connect(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.connect(u, dto, c); }

  @Get('templates') @Roles(...READ)
  list(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.list(u, c); }

  @Post('templates') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  create(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.create(u, dto, c); }

  @Post('templates/library/:key') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 20 } })
  install(@CurrentUser() u: AuthUser, @Param('key') key: string, @Query('companyId') c?: string) { return this.s.installFromLibrary(u, key, c); }

  @Post('templates/sync') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } })
  async sync(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) {
    const company = isPlatformRole(u.role) ? c : u.companyId;
    if (!company) throw new ForbiddenException('Falta companyId');
    return this.s.sync(u, company);
  }

  @Delete('templates/:key') @Roles(...WRITE)
  remove(@CurrentUser() u: AuthUser, @Param('key') key: string, @Query('companyId') c?: string) { return this.s.remove(u, key, c); }

  @Get('meta/costs') @Roles(...READ)
  costs(@CurrentUser() u: AuthUser, @Query('month') month?: string, @Query('companyId') c?: string) { return this.s.costs(u, month, c); }
}

@Module({
  controllers: [WhatsappMetaController],
  providers: [WhatsappMetaService],
  exports: [WhatsappMetaService],
})
export class WhatsappMetaModule {}
