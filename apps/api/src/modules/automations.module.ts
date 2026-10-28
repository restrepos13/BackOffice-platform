import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { assertSameTenant, requireTenant, tenantFilter } from '../common/tenant';
import { DEFAULT_STAGES } from '../common/pipelines';
import {
  Definition, DefinitionError, EvalContext, TRIGGERS, catalog, definitionRefs, evaluateConditions, triggerMatches, validateDefinition,
} from '../common/automation/definition';
import { AuditService, AuditModule } from './audit.module';
import { Products } from '../auth/products.guard';
import { ProductionsModule } from './productions/productions.module';
import { OrdersModule, courierAssignmentOwner } from './orders.module';
import { AutomationEngineService, RUN_KIND } from './automations/automation-engine.service';

const STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'] as const;
type Status = (typeof STATUSES)[number];
/** Transiciones permitidas (ARCHIVED solo vuelve a borrador). */
const TRANSITIONS: Record<Status, Status[]> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
};
/** Límite técnico por empresa (no comercial). */
export const MAX_AUTOMATIONS = 100;
const MAX_DRAFT_BYTES = 20_000;
const OPEN_RUN = ['PENDING', 'RETRYABLE', 'WAITING'];

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * Automatizaciones de empresa (motor v1).
 *  - configJson es el BORRADOR: se puede guardar incompleto, nunca se ejecuta.
 *  - Activar (o guardar una activa) valida estrictamente y publica una
 *    versión inmutable (AutomationVersion); las ejecuciones usan la versión
 *    con la que se crearon.
 *  - Las registradas antes del motor (sin triggerType) quedan como
 *    descriptivas: se pueden editar, pero no activar hasta tener definición.
 */
@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: AutomationEngineService,
  ) {}

  private async load(user: AuthUser, id: string) {
    const automation: any = await this.prisma.automation.findUnique({ where: { id } });
    if (!automation) throw new NotFoundException('Automatización no encontrada');
    assertSameTenant(user, automation, 'Automatización');
    return automation;
  }

  private draftOf(a: any): Record<string, unknown> {
    const d = parseJson<Record<string, unknown>>(a.configJson, {});
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  }

  private validation(draft: unknown): { valid: boolean; errors: string[] } {
    try {
      validateDefinition(draft);
      return { valid: true, errors: [] };
    } catch (e) {
      return { valid: false, errors: e instanceof DefinitionError ? e.errors : [String((e as Error).message)] };
    }
  }

  private serialize(a: any, extra: Record<string, unknown> = {}) {
    const draft = this.draftOf(a);
    return {
      id: a.id, companyId: a.companyId, name: a.name, description: a.description ?? null, status: a.status,
      triggerType: a.triggerType ?? null, version: a.version ?? 0, legacy: !a.triggerType && !(a.version > 0),
      legacyTrigger: a.triggerType ? null : a.trigger ?? null,
      definition: draft, validation: this.validation(draft), createdById: a.createdById ?? null,
      createdAt: a.createdAt, updatedAt: a.updatedAt, ...extra,
    };
  }

  /** Referencias de la definición deben ser de la empresa (responsables y etapas). */
  private async assertDefinitionRefs(companyId: string, def: Definition) {
    const { userIds, stages } = definitionRefs(def);
    for (const userId of userIds) {
      const u = await this.prisma.user.findFirst({ where: { id: userId, companyId, active: true } });
      if (!u || u.role === ROLES.COMPANY_COURIER) throw new BadRequestException('El responsable elegido no es un usuario activo de esta empresa');
    }
    if (stages.length) {
      const known = new Set(DEFAULT_STAGES.map((s) => s.key));
      const pipelines: any[] = await this.prisma.pipeline.findMany({ where: { companyId } });
      for (const p of pipelines) for (const s of parseJson<Array<{ key: string }>>(p.stagesJson, [])) known.add(s.key);
      const bad = stages.filter((s) => !known.has(s));
      if (bad.length) throw new BadRequestException(`Etapas que no existen en los embudos de esta empresa: ${bad.join(', ')}`);
    }
  }

  private strict(draft: unknown): Definition {
    try {
      return validateDefinition(draft);
    } catch (e) {
      if (e instanceof DefinitionError) throw new BadRequestException({ message: 'La automatización tiene errores', errors: e.errors });
      throw e;
    }
  }

  /** Publica una versión nueva (condicional: dos publicaciones a la vez no pisan el número). */
  private async publish(user: AuthUser, a: any, def: Definition) {
    await this.assertDefinitionRefs(a.companyId, def);
    const next = (a.version ?? 0) + 1;
    try {
      await this.prisma.automationVersion.create({
        data: { id: `${a.id}:v${next}`, companyId: a.companyId, automationId: a.id, version: next, definitionJson: JSON.stringify(def), createdById: user.id },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') throw new ConflictException('Otra persona publicó esta automatización al mismo tiempo. Recarga e intenta de nuevo.');
      throw e;
    }
    const r = await this.prisma.automation.updateMany({
      where: { id: a.id, companyId: a.companyId, version: a.version ?? 0 },
      data: { version: next, triggerType: def.trigger.type, configJson: JSON.stringify(def) },
    });
    if (!r.count) throw new ConflictException('La automatización cambió mientras la guardabas. Recarga e intenta de nuevo.');
    await this.audit.log({ actor: user, companyId: a.companyId, action: 'automation.publish', entity: 'Automation', entityId: a.id, detail: `${a.name} · versión ${next}` });
    return next;
  }

  async catalog(user: AuthUser, companyId?: string) {
    const id = requireTenant(user, companyId);
    const [pipelines, users, company] = await Promise.all([
      this.prisma.pipeline.findMany({ where: { companyId: id } }),
      this.prisma.user.findMany({ where: { companyId: id, active: true, role: { in: [ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER, ROLES.COMPANY_AREA] } }, select: { id: true, name: true, role: true } }),
      this.prisma.company.findUnique({ where: { id } }),
    ]);
    const delivery = parseJson<Record<string, any>>((company as any)?.orderConfigJson, {}).delivery ?? {};
    const base = catalog();
    const deliveryReady = !!(delivery.enabled && delivery.autoAssign);
    return {
      ...base,
      // Solo se ofrece lo que esta empresa puede usar
      actions: base.actions.filter((a) => a.type !== 'assign_courier' || deliveryReady),
      stages: [
        { pipelineId: null, name: 'Embudo estándar', stages: DEFAULT_STAGES.map((s) => ({ key: s.key, label: s.label })) },
        ...pipelines.map((p: any) => ({ pipelineId: p.id, name: p.name, stages: parseJson<Array<{ key: string; label: string }>>(p.stagesJson, []).map((s) => ({ key: s.key, label: s.label })) })),
      ],
      users,
      courierAssignment: deliveryReady ? { via: delivery.autoAssignVia === 'automation' ? 'automation' : 'legacy', owner: await courierAssignmentOwner(this.prisma, id, delivery) } : null,
    };
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = tenantFilter(user, companyId);
    const rows: any[] = await this.prisma.automation.findMany({ where: scoped ? { companyId: scoped } : undefined, orderBy: { createdAt: 'asc' } });
    const since = new Date(Date.now() - 30 * 86400e3);
    return Promise.all(rows.map(async (a) => {
      const where = { companyId: a.companyId, kind: RUN_KIND, automationId: a.id };
      const [lastRun, total, failed] = await Promise.all([
        this.prisma.workflowRun.findFirst({ where, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, createdAt: true, finishedAt: true } }),
        this.prisma.workflowRun.count({ where: { ...where, createdAt: { gte: since } } }),
        this.prisma.workflowRun.count({ where: { ...where, status: 'FAILED', createdAt: { gte: since } } }),
      ]);
      // Métricas REALES (ejecuciones del motor); las del seed no se muestran
      return this.serialize(a, { stats: { runs30d: total, failed30d: failed, lastRun } });
    }));
  }

  async get(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    const versions = await this.prisma.automationVersion.findMany({ where: { companyId: a.companyId, automationId: a.id }, orderBy: { version: 'desc' }, take: 20 });
    return this.serialize(a, { versions: versions.map((v: any) => ({ version: v.version, createdAt: v.createdAt, createdById: v.createdById })) });
  }

  private readDraft(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('La definición debe ser un objeto');
    const json = JSON.stringify(raw);
    if (json.length > MAX_DRAFT_BYTES) throw new BadRequestException('La definición es demasiado grande');
    return raw as Record<string, unknown>;
  }

  async create(user: AuthUser, dto: any) {
    const companyId = requireTenant(user, dto?.companyId);
    const name = clip(dto?.name, 80);
    if (name.length < 2) throw new BadRequestException('Escribe un nombre (2 a 80 caracteres)');
    const total = await this.prisma.automation.count({ where: { companyId, status: { not: 'ARCHIVED' } } });
    if (total >= MAX_AUTOMATIONS) throw new BadRequestException(`Máximo ${MAX_AUTOMATIONS} automatizaciones por empresa (archiva las que no uses)`);
    const draft = this.readDraft(dto?.definition);
    const automation = await this.prisma.automation.create({
      data: { companyId, name, description: clip(dto?.description, 500) || null, status: 'DRAFT', configJson: JSON.stringify(draft), createdById: user.id, version: 0 },
    });
    await this.audit.log({ actor: user, companyId, action: 'automation.create', entity: 'Automation', entityId: automation.id, detail: name });
    return this.serialize(automation);
  }

  async update(user: AuthUser, id: string, dto: any) {
    const a = await this.load(user, id);
    if (a.status === 'ARCHIVED') throw new BadRequestException('Está archivada: pásala a borrador para editarla');
    const data: Record<string, unknown> = {};
    if (dto?.name !== undefined) {
      const name = clip(dto.name, 80);
      if (name.length < 2) throw new BadRequestException('Escribe un nombre (2 a 80 caracteres)');
      data.name = name;
    }
    if (dto?.description !== undefined) data.description = clip(dto.description, 500) || null;
    if (dto?.definition !== undefined) {
      const draft = this.readDraft(dto.definition);
      if (a.status === 'ACTIVE' || a.status === 'PAUSED') {
        // Una automatización publicada solo guarda definiciones válidas (versión nueva)
        const def = this.strict(draft);
        if (Object.keys(data).length) await this.prisma.automation.update({ where: { id }, data });
        await this.publish(user, { ...a, ...data }, def);
        return this.get(user, id);
      }
      data.configJson = JSON.stringify(draft);
    }
    const updated = await this.prisma.automation.update({ where: { id }, data });
    await this.audit.log({ actor: user, companyId: a.companyId, action: 'automation.update', entity: 'Automation', entityId: id, detail: updated.name });
    return this.serialize(updated);
  }

  async setStatus(user: AuthUser, id: string, status: string) {
    const a = await this.load(user, id);
    if (!STATUSES.includes(status as Status)) throw new BadRequestException('Estado no válido');
    if (!TRANSITIONS[a.status as Status]?.includes(status as Status)) throw new BadRequestException(`No se puede pasar de ${a.status} a ${status}`);
    let version = a.version ?? 0;
    if (status === 'ACTIVE') {
      const draft = this.draftOf(a);
      if (!Object.keys(draft).length) throw new BadRequestException('Define disparador y acciones antes de activarla');
      const def = this.strict(draft);
      // Publica si el borrador difiere de la última versión
      const latest = version ? await this.engine.versionOf(a.id, version) : null;
      if (!latest || JSON.stringify(latest) !== JSON.stringify(def)) version = await this.publish(user, a, def);
    }
    const r = await this.prisma.automation.updateMany({ where: { id, companyId: a.companyId, status: a.status }, data: { status } });
    if (!r.count) throw new ConflictException('El estado cambió mientras tanto. Recarga e intenta de nuevo.');
    let cancelled = 0;
    if (status === 'PAUSED' || status === 'ARCHIVED') {
      // Lo que no empezó se cancela; lo que está corriendo termina su paso actual
      const c = await this.prisma.workflowRun.updateMany({
        where: { companyId: a.companyId, kind: RUN_KIND, automationId: a.id, status: { in: OPEN_RUN } },
        data: { status: 'CANCELLED', finishedAt: new Date(), lockedUntil: null, nextRetryAt: null, errorJson: JSON.stringify({ message: status === 'PAUSED' ? 'Automatización pausada' : 'Automatización archivada', name: 'CancelRun' }) },
      });
      cancelled = c.count;
    }
    await this.audit.log({
      actor: user, companyId: a.companyId, action: 'automation.status', entity: 'Automation', entityId: id,
      detail: `${a.name}: ${a.status} → ${status}${status === 'ACTIVE' ? ` (versión ${version})` : ''}${cancelled ? ` · ${cancelled} ejecución(es) cancelada(s)` : ''}`,
    });
    return { ...(await this.get(user, id)), cancelledRuns: cancelled };
  }

  async remove(user: AuthUser, id: string) {
    const a = await this.load(user, id);
    const runs = await this.prisma.workflowRun.count({ where: { companyId: a.companyId, kind: RUN_KIND, automationId: a.id } });
    if (a.status !== 'DRAFT' || (a.version ?? 0) > 0 || runs > 0) {
      throw new BadRequestException('Solo se eliminan borradores que nunca se activaron. Archívala para conservar su historial.');
    }
    await this.prisma.automation.delete({ where: { id } });
    await this.audit.log({ actor: user, companyId: a.companyId, action: 'automation.delete', entity: 'Automation', entityId: id, detail: a.name });
    return { ok: true };
  }

  /**
   * SIMULACIÓN: evalúa la definición contra un registro de ESTA empresa (solo
   * lectura) o contra valores de ejemplo. No crea ejecuciones ni cambia nada.
   */
  async simulate(user: AuthUser, dto: any) {
    const companyId = requireTenant(user, dto?.companyId);
    const def = this.strict(this.readDraft(dto?.definition));
    let ctx: EvalContext;
    let source: 'record' | 'sample';
    if (dto?.recordId) {
      const built = await this.engine.buildContext(companyId, def.trigger.type, String(dto.recordId), {});
      if (!built) throw new NotFoundException(`No hay ${TRIGGERS[def.trigger.type].record === 'contact' ? 'un contacto' : 'un pedido'} con ese id en esta empresa`);
      ctx = built.ctx;
      source = 'record';
    } else {
      const sample = dto?.sample && typeof dto.sample === 'object' && !Array.isArray(dto.sample) ? dto.sample : {};
      const fields = TRIGGERS[def.trigger.type].fields;
      ctx = {};
      for (const [k, v] of Object.entries(sample)) {
        const f = fields[k];
        if (!f) throw new BadRequestException(`Campo de ejemplo no disponible: ${k}`);
        if (f.type === 'number') ctx[k] = v === '' || v === null ? null : Number(v);
        else if (f.type === 'bool') ctx[k] = v === true || v === 'true';
        else if (f.type === 'tags') ctx[k] = Array.isArray(v) ? v.map(String).slice(0, 20) : String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        else ctx[k] = v === null ? null : String(v).slice(0, 200);
      }
      source = 'sample';
    }
    const trigger = triggerMatches(def, ctx);
    const conditions = evaluateConditions(def.conditions, ctx);
    const wouldRun = trigger && conditions.passed;
    return {
      simulation: true, source, wouldRun, triggerMatches: trigger, conditions,
      actions: def.actions.map((a, i) => ({ index: i, type: a.type, description: this.engine.describeAction(a) })),
      note: 'Simulación: no se creó ninguna ejecución ni se modificó ningún dato.',
    };
  }

  /* ─── Historial ────────────────────────────────────────────────────── */

  private serializeRun(r: any, automationName?: string, detail = false) {
    const steps = parseJson<any[]>(r.stepsJson, []);
    const error = parseJson<Record<string, any> | null>(r.errorJson, null);
    return {
      id: r.id, automationId: r.automationId, automationName: automationName ?? null, automationVersion: r.automationVersion ?? null,
      status: r.status, triggerType: r.triggerType, sourceType: r.sourceType, sourceId: r.sourceId, eventId: detail ? r.eventId : undefined,
      attempts: r.attempts, maxAttempts: r.maxAttempts, createdAt: r.createdAt, startedAt: r.startedAt ?? null, finishedAt: r.finishedAt ?? null,
      nextRetryAt: r.nextRetryAt ?? null, error: error ? { message: String(error.message ?? '').slice(0, 300), attempt: error.attempt ?? null } : null,
      stepsDone: steps.filter((s) => s?.status === 'DONE').length,
      ...(detail ? { steps, conditions: parseJson<Record<string, any>>(r.payloadJson, {}).conditions ?? [], depth: parseJson<Record<string, any>>(r.payloadJson, {}).depth ?? 1 } : {}),
    };
  }

  async runs(user: AuthUser, q: any) {
    const companyId = requireTenant(user, q?.companyId);
    const limit = Math.min(50, Math.max(1, Number(q?.limit) || 20));
    const where: Record<string, any> = { companyId, kind: RUN_KIND };
    if (q?.automationId) where.automationId = String(q.automationId);
    if (q?.status) {
      const list = String(q.status).split(',').filter((s) => ['PENDING', 'RUNNING', 'WAITING', 'COMPLETED', 'FAILED', 'RETRYABLE', 'CANCELLED'].includes(s));
      if (list.length) where.status = { in: list };
    }
    if (q?.before) {
      const before = new Date(String(q.before));
      if (Number.isNaN(before.getTime())) throw new BadRequestException('Cursor no válido');
      where.createdAt = { lt: before };
    }
    const rows: any[] = await this.prisma.workflowRun.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit);
    const ids = [...new Set(page.map((r) => r.automationId).filter(Boolean))];
    const names = new Map((await this.prisma.automation.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, name: true } })).map((a: any) => [a.id, a.name]));
    return {
      items: page.map((r) => this.serializeRun(r, names.get(r.automationId))),
      nextCursor: rows.length > limit ? new Date(page[page.length - 1].createdAt).toISOString() : null,
    };
  }

  private async loadRun(user: AuthUser, id: string, companyId?: string) {
    const tenant = requireTenant(user, companyId);
    const run: any = await this.prisma.workflowRun.findFirst({ where: { id, companyId: tenant, kind: RUN_KIND } });
    if (!run) throw new NotFoundException('Ejecución no encontrada');
    return run;
  }

  async run(user: AuthUser, id: string, companyId?: string) {
    const run = await this.loadRun(user, id, companyId);
    const a: any = run.automationId ? await this.prisma.automation.findFirst({ where: { id: run.automationId, companyId: run.companyId } }) : null;
    return this.serializeRun(run, a?.name, true);
  }

  async cancelRun(user: AuthUser, id: string, companyId?: string) {
    const run = await this.loadRun(user, id, companyId);
    const r = await this.prisma.workflowRun.updateMany({
      where: { id: run.id, companyId: run.companyId, status: { in: OPEN_RUN } },
      data: { status: 'CANCELLED', finishedAt: new Date(), lockedUntil: null, nextRetryAt: null, errorJson: JSON.stringify({ message: `Cancelada por ${user.name}`, name: 'CancelRun' }) },
    });
    if (!r.count) throw new BadRequestException('Solo se cancelan ejecuciones pendientes, en espera o por reintentar');
    await this.audit.log({ actor: user, companyId: run.companyId, action: 'automation.run_cancelled', entity: 'WorkflowRun', entityId: run.id, detail: run.automationId ?? '' });
    return { ok: true };
  }

  /** Migración de la asignación de domiciliarios (Bloque H): reversible. */
  async setCourierAssignment(user: AuthUser, dto: any) {
    const companyId = requireTenant(user, dto?.companyId);
    const via = dto?.via === 'automation' ? 'automation' : dto?.via === 'legacy' ? 'legacy' : null;
    if (!via) throw new BadRequestException('via debe ser automation o legacy');
    const company: any = await this.prisma.company.findUnique({ where: { id: companyId } });
    const config = parseJson<Record<string, any>>(company?.orderConfigJson, {});
    const delivery = config.delivery ?? {};
    if (!delivery.enabled || !delivery.autoAssign) throw new BadRequestException('La asignación automática de domiciliarios no está encendida en esta empresa');
    if (via === 'automation') {
      const active = await this.prisma.automation.count({ where: { companyId, status: 'ACTIVE', triggerType: 'order.status_changed', configJson: { contains: '"assign_courier"' } } });
      if (!active) throw new BadRequestException('Primero activa una automatización con la acción «Asignar domiciliario automático»');
    }
    const next = { ...config, delivery: { ...delivery, autoAssignVia: via === 'automation' ? 'automation' : undefined } };
    await this.prisma.company.update({ where: { id: companyId }, data: { orderConfigJson: JSON.stringify(next) } });
    await this.audit.log({ actor: user, companyId, action: 'automation.migration', entity: 'Company', entityId: companyId, detail: `Asignación de domiciliarios → ${via === 'automation' ? 'motor de automatizaciones' : 'proceso original'}` });
    return { via, owner: await courierAssignmentOwner(this.prisma, companyId, next.delivery) };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN];

@Products('AUTOMATION')
@Controller('automations')
export class AutomationsController {
  constructor(private readonly s: AutomationsService) {}

  @Get('catalog') catalog(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.catalog(u, c); }
  @Get('runs') runs(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.runs(u, q); }
  @Get('runs/:id') run(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.run(u, id, c); }
  @Post('runs/:id/cancel') @Roles(...WRITE) cancelRun(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.cancelRun(u, id, c); }
  @Post('simulate') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 30 } }) simulate(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.s.simulate(u, dto); }
  @Put('migrations/courier-assignment') @Roles(...WRITE) courier(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.s.setCourierAssignment(u, dto); }

  @Get() list(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.list(u, c); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.s.get(u, id); }
  @Post() @Roles(...WRITE) create(@CurrentUser() u: AuthUser, @Body() dto: any) { return this.s.create(u, dto); }
  @Patch(':id') @Roles(...WRITE) update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any) { return this.s.update(u, id, dto); }
  @Post(':id/status') @Roles(...WRITE) status(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body('status') status: string) { return this.s.setStatus(u, id, status); }
  @Delete(':id') @Roles(...WRITE) remove(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.s.remove(u, id); }
}

@Module({
  imports: [AuditModule, ProductionsModule, OrdersModule],
  controllers: [AutomationsController],
  providers: [AutomationsService, AutomationEngineService],
  exports: [AutomationEngineService],
})
export class AutomationsModule {}
