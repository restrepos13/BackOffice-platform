import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { parseJson } from '../../common/constants';
import { hasProduct } from '../../common/products';
import { DEFAULT_STAGES } from '../../common/pipelines';
import { CausedBy, DomainEvent, contactStageChanged, setDomainEventHandler } from '../../common/domain-events';
import { ACTIONS, Definition, EvalContext, TRIGGERS, evaluateConditions, triggerMatches, validateDefinition } from '../../common/automation/definition';
import { CancelRun, PermanentError, WaitUntil, deterministicId } from '../../common/automation/run-signals';
import { WorkflowService } from '../productions/workflow.service';
import { OrdersService } from '../orders.module';

export const RUN_KIND = 'automation.run';
/** Profundidad máxima de automatizaciones encadenadas (A cambia algo que dispara B…) */
export const MAX_DEPTH = 3;
const COUNTED = ['PENDING', 'RUNNING', 'WAITING', 'RETRYABLE', 'COMPLETED', 'FAILED'];

export interface Step { index: number; type: string; status: 'DONE' | 'FAILED' | 'WAITING'; at: string; output?: Record<string, unknown>; error?: string; resumeAt?: string }

/**
 * Motor de automatizaciones de empresa sobre WorkflowRun (el mismo motor de
 * Producciones): crea ejecuciones desde eventos de dominio y ejecuta sus
 * acciones en orden, una sola vez cada una.
 *
 *  - Ejecución: _id determinista por (empresa, automatización, ocurrencia) →
 *    un evento repetido no crea otra ejecución.
 *  - Pasos: cada acción deja su resultado en stepsJson; un reintento continúa
 *    desde la que falló. Los efectos que crean registros usan también _id
 *    determinista (ejecución + paso), así un corte entre el efecto y la
 *    bitácora no duplica nada.
 *  - Bucles: los cambios hechos por una automatización viajan con `causedBy`;
 *    no se redispara la misma automatización y la cadena se corta en MAX_DEPTH.
 *  - Frecuencia: tope de ejecuciones por hora por automatización.
 *  - Solo acciones internas. Nada sale de BackOffice.
 */
@Injectable()
export class AutomationEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Automations');
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: WorkflowService,
    private readonly orders: OrdersService,
  ) {}

  onModuleInit() {
    this.workflow.registerHandler(RUN_KIND, (run) => this.executeRun(run));
    setDomainEventHandler((e) => this.onEvent(e));
  }

  onModuleDestroy() {
    setDomainEventHandler(null);
  }

  /* ─── Contexto de evaluación ───────────────────────────────────────── */

  private contactContext(c: any): EvalContext {
    if (!c) return {};
    return {
      'contact.name': c.name ?? null, 'contact.phone': c.phone ?? null, 'contact.email': c.email ?? null,
      'contact.channel': c.channel ?? null, 'contact.stage': c.stage ?? null,
      'contact.tags': parseJson<string[]>(c.tagsJson, []).filter((t) => typeof t === 'string'),
      'contact.assigned': !!c.assignedToId,
    };
  }

  /** Lee el registro de origen SOLO dentro de la empresa del evento. */
  async buildContext(companyId: string, type: DomainEvent['type'], recordId: string, data: Record<string, any> = {}): Promise<{ ctx: EvalContext; contactId: string | null } | null> {
    if (TRIGGERS[type].record === 'contact') {
      const contact = await this.prisma.contact.findFirst({ where: { id: recordId, companyId } });
      if (!contact) return null;
      const ctx = this.contactContext(contact);
      if (type === 'contact.stage_changed') Object.assign(ctx, { 'event.fromStage': data.fromStage ?? null, 'event.toStage': data.toStage ?? contact.stage });
      return { ctx, contactId: contact.id };
    }
    const order: any = await this.prisma.order.findFirst({ where: { id: recordId, companyId } });
    if (!order) return null;
    const contact = order.contactId ? await this.prisma.contact.findFirst({ where: { id: order.contactId, companyId } }) : null;
    return {
      ctx: {
        ...this.contactContext(contact),
        'order.status': data.toStatus ?? order.status, 'event.fromStatus': data.fromStatus ?? null,
        'order.total': typeof order.total === 'number' ? order.total : null, 'order.source': order.source ?? null,
        'order.paymentStatus': order.paymentStatus ?? null, 'order.hasCourier': !!order.courierId,
      },
      contactId: contact?.id ?? null,
    };
  }

  async versionOf(automationId: string, version: number): Promise<Definition | null> {
    const row: any = await this.prisma.automationVersion.findFirst({ where: { id: `${automationId}:v${version}` } });
    if (!row) return null;
    try {
      return validateDefinition(parseJson(row.definitionJson, {}));
    } catch {
      return null;
    }
  }

  /* ─── Disparo ──────────────────────────────────────────────────────── */

  async onEvent(event: DomainEvent): Promise<{ scheduled: string[]; skipped: Array<{ automationId: string; reason: string }> }> {
    const out = { scheduled: [] as string[], skipped: [] as Array<{ automationId: string; reason: string }> };
    const depth = (event.causedBy?.depth ?? 0) + 1;
    const automations: any[] = await this.prisma.automation.findMany({ where: { companyId: event.companyId, status: 'ACTIVE', triggerType: event.type } });
    if (!automations.length) return out;
    if (depth > MAX_DEPTH) {
      this.logger.warn(`cadena de automatizaciones cortada en profundidad ${MAX_DEPTH} (${event.type} ${event.recordId})`);
      for (const a of automations) out.skipped.push({ automationId: a.id, reason: 'loop_depth' });
      return out;
    }
    const company = await this.prisma.company.findUnique({ where: { id: event.companyId } });
    if (!company || !hasProduct(company as any, 'AUTOMATION')) return out;
    const built = await this.buildContext(event.companyId, event.type, event.recordId, event.data ?? {});
    if (!built) return out;

    for (const a of automations) {
      if (event.causedBy?.automationId === a.id) { out.skipped.push({ automationId: a.id, reason: 'self_trigger' }); continue; }
      const def = await this.versionOf(a.id, a.version);
      if (!def || def.trigger.type !== event.type) { out.skipped.push({ automationId: a.id, reason: 'no_version' }); continue; }
      if (!triggerMatches(def, built.ctx)) { out.skipped.push({ automationId: a.id, reason: 'trigger_filter' }); continue; }
      const evaluation = evaluateConditions(def.conditions, built.ctx);
      if (!evaluation.passed) { out.skipped.push({ automationId: a.id, reason: 'conditions' }); continue; }

      const key = def.options.dedupe === 'once_per_record' ? `auto:${a.id}:rec:${event.recordId}` : `auto:${a.id}:${event.eventId}`;
      const since = new Date(this.now().getTime() - 3600_000);
      const recent = await this.prisma.workflowRun.count({ where: { companyId: a.companyId, automationId: a.id, status: { in: COUNTED }, createdAt: { gte: since } } });
      const limited = recent >= def.options.maxRunsPerHour;

      const run: any = await this.workflow.schedule(
        a.companyId, RUN_KIND, key,
        { event: { type: event.type, recordId: event.recordId, eventId: event.eventId, data: event.data ?? {} }, contactId: built.contactId, conditions: evaluation.results, depth, causedBy: event.causedBy ?? null, ...(limited ? { rateLimited: true } : {}) },
        null, null,
        {
          maxAttempts: def.options.maxAttempts,
          extra: {
            automationId: a.id, automationVersion: a.version, triggerType: event.type,
            sourceType: TRIGGERS[event.type].record, sourceId: event.recordId, eventId: event.eventId, stepsJson: '[]',
          },
        },
      );
      if (run) out.scheduled.push(run.id);
    }
    return out;
  }

  /* ─── Ejecución ────────────────────────────────────────────────────── */

  private async saveSteps(runId: string, steps: Step[]) {
    await this.prisma.workflowRun.update({ where: { id: runId }, data: { stepsJson: JSON.stringify(steps).slice(0, 20_000), updatedAt: this.now() } });
  }

  async executeRun(run: any): Promise<Record<string, unknown>> {
    const payload = parseJson<Record<string, any>>(run.payloadJson, {});
    if (payload.rateLimited) throw new CancelRun('Se alcanzó el máximo de ejecuciones por hora de esta automatización');
    const automation: any = await this.prisma.automation.findFirst({ where: { id: run.automationId, companyId: run.companyId } });
    if (!automation) throw new CancelRun('La automatización ya no existe');
    if (automation.status !== 'ACTIVE') throw new CancelRun(`La automatización está ${automation.status === 'PAUSED' ? 'pausada' : 'archivada o en borrador'}`);
    const company = await this.prisma.company.findUnique({ where: { id: run.companyId } });
    if (!company || !hasProduct(company as any, 'AUTOMATION')) throw new CancelRun('La empresa ya no tiene Automation activo');
    const def = await this.versionOf(automation.id, run.automationVersion);
    if (!def) throw new PermanentError(`No se encontró la versión ${run.automationVersion} de la automatización`);

    const steps = parseJson<Step[]>(run.stepsJson, []);
    const causedBy: CausedBy = { runId: run.id, automationId: automation.id, depth: payload.depth ?? 1 };
    for (let i = 0; i < def.actions.length; i++) {
      const action = def.actions[i];
      const prev = steps[i];
      if (prev?.status === 'DONE') continue;
      if (action.type === 'wait') {
        const resumeAt = prev?.status === 'WAITING' && prev.resumeAt ? new Date(prev.resumeAt) : new Date(this.now().getTime() + action.config.hours * 3600_000);
        if (this.now() < resumeAt) {
          steps[i] = { index: i, type: action.type, status: 'WAITING', at: this.now().toISOString(), resumeAt: resumeAt.toISOString() };
          await this.saveSteps(run.id, steps);
          throw new WaitUntil(resumeAt);
        }
        steps[i] = { index: i, type: action.type, status: 'DONE', at: this.now().toISOString(), output: { waitedUntil: resumeAt.toISOString() } };
        await this.saveSteps(run.id, steps);
        continue;
      }
      try {
        const output = await this.runAction(run, automation, action, i, payload, causedBy);
        steps[i] = { index: i, type: action.type, status: 'DONE', at: this.now().toISOString(), output };
        await this.saveSteps(run.id, steps);
      } catch (err: any) {
        steps[i] = { index: i, type: action.type, status: 'FAILED', at: this.now().toISOString(), error: String(err?.message ?? err).slice(0, 300) };
        await this.saveSteps(run.id, steps);
        throw err;
      }
    }
    return { actions: def.actions.length };
  }

  private async contactFor(run: any, payload: Record<string, any>): Promise<any> {
    let contactId: string | null = run.sourceType === 'contact' ? run.sourceId : null;
    if (run.sourceType === 'order') {
      const order: any = await this.prisma.order.findFirst({ where: { id: run.sourceId, companyId: run.companyId } });
      contactId = order?.contactId ?? payload.contactId ?? null;
    }
    if (!contactId) throw new PermanentError('El pedido no tiene un contacto asociado');
    const contact = await this.prisma.contact.findFirst({ where: { id: contactId, companyId: run.companyId } });
    if (!contact) throw new PermanentError('El contacto ya no existe en esta empresa');
    return contact;
  }

  /** Solo reemplaza {{contact.name}}: no hay plantillas ejecutables. */
  private render(text: string, contact: any) {
    return text.replace(/\{\{\s*contact\.name\s*\}\}/g, contact?.name ?? '');
  }

  private async stagesOf(companyId: string, pipelineId: string | null): Promise<string[]> {
    if (!pipelineId) return DEFAULT_STAGES.map((s) => s.key);
    const p: any = await this.prisma.pipeline.findFirst({ where: { id: pipelineId, companyId } });
    return parseJson<Array<{ key: string }>>(p?.stagesJson, DEFAULT_STAGES).map((s) => s.key);
  }

  async runAction(run: any, automation: any, action: Definition['actions'][number], index: number, payload: Record<string, any>, causedBy: CausedBy): Promise<Record<string, unknown>> {
    const companyId = run.companyId;
    const actor = `Automatización «${automation.name}»`;
    const effectId = (prefix: string) => deterministicId(prefix, run.id, String(index));
    switch (action.type) {
      case 'create_follow_up': {
        const contact = await this.contactFor(run, payload);
        const id = effectId('fu');
        try {
          await this.prisma.followUp.create({
            data: { id, companyId, contactId: contact.id, note: this.render(action.config.note, contact).slice(0, 500), dueAt: new Date(this.now().getTime() + action.config.dueInHours * 3600_000), createdBy: actor },
          });
          return { followUpId: id };
        } catch (e: any) {
          if (e?.code === 'P2002') return { followUpId: id, already: true };
          throw e;
        }
      }
      case 'add_tag':
      case 'remove_tag': {
        const contact = await this.contactFor(run, payload);
        const tags = parseJson<string[]>(contact.tagsJson, []).filter((t) => typeof t === 'string');
        const tag = String(action.config.tag);
        const has = tags.some((t) => t.toLowerCase() === tag.toLowerCase());
        if (action.type === 'add_tag' ? has : !has) return { changed: false };
        const next = action.type === 'add_tag' ? [...tags, tag].slice(0, 50) : tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
        await this.prisma.contact.update({ where: { id: contact.id }, data: { tagsJson: JSON.stringify(next) } });
        return { changed: true, tag };
      }
      case 'set_stage': {
        const contact = await this.contactFor(run, payload);
        const stage = String(action.config.stage);
        const valid = await this.stagesOf(companyId, contact.pipelineId ?? null);
        if (!valid.includes(stage)) throw new PermanentError(`La etapa ${stage} no existe en el embudo del contacto`);
        if (contact.stage === stage) return { changed: false };
        // Condicional: si alguien la cambió en el mismo instante, se respeta
        const r = await this.prisma.contact.updateMany({ where: { id: contact.id, companyId, stage: contact.stage }, data: { stage } });
        if (!r.count) return { changed: false, reason: 'la etapa cambió mientras tanto' };
        await contactStageChanged(companyId, contact.id, contact.stage, stage, causedBy);
        return { changed: true, from: contact.stage, to: stage };
      }
      case 'assign_owner': {
        const contact = await this.contactFor(run, payload);
        const user = await this.prisma.user.findFirst({ where: { id: String(action.config.userId), companyId, active: true } });
        if (!user || user.role === 'COMPANY_COURIER') throw new PermanentError('El responsable no está activo en esta empresa');
        if (contact.assignedToId === user.id) return { changed: false };
        await this.prisma.contact.update({ where: { id: contact.id }, data: { assignedToId: user.id } });
        return { changed: true, userId: user.id };
      }
      case 'log_activity': {
        const contact = run.sourceType === 'contact' || payload.contactId ? await this.prisma.contact.findFirst({ where: { id: run.sourceType === 'contact' ? run.sourceId : payload.contactId, companyId } }) : null;
        const id = effectId('act');
        try {
          await this.prisma.auditLog.create({
            data: { id, actorId: null, actorName: actor.slice(0, 120), companyId, action: 'automation.activity', entity: run.sourceType === 'order' ? 'Order' : 'Contact', entityId: run.sourceId, detail: this.render(action.config.text, contact).slice(0, 500) },
          });
          return { activityId: id };
        } catch (e: any) {
          if (e?.code === 'P2002') return { activityId: id, already: true };
          throw e;
        }
      }
      case 'assign_courier': {
        if (run.sourceType !== 'order') throw new PermanentError('Solo aplica a pedidos');
        const order: any = await this.prisma.order.findFirst({ where: { id: run.sourceId, companyId } });
        if (!order) throw new PermanentError('El pedido ya no existe');
        const courier: any = await this.orders.autoAssignCourier(order.id, 'automation');
        return courier ? { assigned: true, courierId: courier.id } : { assigned: false, reason: 'sin domiciliario disponible, ya asignado o la asignación sigue en el proceso original' };
      }
      default:
        throw new PermanentError(`Acción no soportada: ${(action as any).type}`);
    }
  }

  /** Descripción legible de lo que haría cada acción (simulación: no ejecuta nada). */
  describeAction(action: Definition['actions'][number]): string {
    const c = action.config;
    switch (action.type) {
      case 'create_follow_up': return `Crearía un seguimiento «${c.note}» para dentro de ${c.dueInHours} h`;
      case 'add_tag': return `Agregaría la etiqueta «${c.tag}»`;
      case 'remove_tag': return `Quitaría la etiqueta «${c.tag}»`;
      case 'set_stage': return `Pasaría el contacto a la etapa ${c.stage}`;
      case 'assign_owner': return `Asignaría el contacto al usuario ${c.userId}`;
      case 'log_activity': return `Registraría la actividad «${c.text}»`;
      case 'wait': return `Esperaría ${c.hours} h antes de seguir`;
      case 'assign_courier': return 'Asignaría el domiciliario en turno (si la migración está activa)';
      default: return ACTIONS[(action as any).type]?.label ?? 'Acción';
    }
  }
}
