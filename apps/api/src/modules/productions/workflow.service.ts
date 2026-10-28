import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit, Optional, forwardRef } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { parseJson } from '../../common/constants';
import { TASK_RULES, mergeConfig } from '../../common/productions';
import { WORKFLOW_QUEUE, queuePrefix, redisConnection } from '../../queue/queue.module';
import { ProductionsService } from './productions.service';
import { CancelRun, WaitUntil, deterministicId } from '../../common/automation/run-signals';

/**
 * Motor de Automation: ejecuciones REALES y persistidas (WorkflowRun).
 *  - Cada ejecución tiene una clave determinista por empresa: la misma causa no
 *    se ejecuta dos veces (índice único companyId + idempotencyKey).
 *  - Se reclama con un candado temporal (lockedUntil): dos workers no corren la
 *    misma ejecución; si un proceso muere, el barrido la retoma.
 *  - Reintentos limitados (maxAttempts) con espera exponencial; el error queda
 *    guardado sin datos sensibles.
 *  - Solo acciones INTERNAS: crear tareas, marcar vencidas, liberar retenciones.
 *    Nada se envía fuera de BackOffice.
 * La cola BullMQ (con prefijo propio por entorno) acelera; el barrido garantiza.
 *
 * Es también el motor del módulo de automatizaciones: otros módulos registran
 * manejadores por `kind` (registerHandler). El _id de cada ejecución es
 * determinista (empresa + clave), así la unicidad la garantiza Mongo aunque el
 * índice único compuesto no exista en la base.
 */

export type WorkflowHandler = (run: any) => Promise<Record<string, unknown>>;

export interface ScheduleOptions {
  maxAttempts?: number;
  /** Campos extra del registro (automationId, triggerType, sourceId…) */
  extra?: Record<string, unknown>;
}

const LOCK_MS = 2 * 60_000;
const OPEN_TASK = ['TODO', 'IN_PROGRESS', 'BLOCKED'];

@Injectable()
export class WorkflowService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('Workflow');
  private worker: Worker | null = null;
  private readonly handlers = new Map<string, WorkflowHandler>();
  now = () => new Date();

  registerHandler(kind: string, handler: WorkflowHandler) {
    this.handlers.set(kind, handler);
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => ProductionsService)) private readonly productions: ProductionsService,
    @Optional() @Inject(WORKFLOW_QUEUE) private readonly queue?: Queue,
  ) {}

  onModuleInit() {
    if (process.env.JEST_WORKER_ID || process.env.WORKFLOW_WORKER_DISABLED === '1') return;
    this.worker = new Worker(
      'workflow',
      async (job) => this.execute(String(job.data?.runId), String(job.data?.companyId)),
      { connection: redisConnection(), ...queuePrefix(), concurrency: 4 },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`workflow job ${job?.id}: ${err.message}`));
    this.logger.log('Worker del motor de Automation arriba (workflow)');
  }

  async onApplicationShutdown() {
    await this.worker?.close().catch(() => undefined);
  }

  /** Registra una ejecución (idempotente) y la despacha. Devuelve la ejecución. */
  async schedule(companyId: string, kind: string, key: string, payload: Record<string, unknown>, productionId?: string | null, taskId?: string | null, opts: ScheduleOptions = {}) {
    let run: any = await this.prisma.workflowRun.findFirst({ where: { companyId, idempotencyKey: key } });
    if (!run) {
      const maxAttempts = opts.maxAttempts
        ?? mergeConfig(parseJson((await this.prisma.productionSettings.findUnique({ where: { companyId } }))?.configJson, {})).engine.maxAttempts;
      try {
        run = await this.prisma.workflowRun.create({
          data: {
            id: deterministicId('wf', companyId, key), companyId, kind, idempotencyKey: key, payloadJson: JSON.stringify(payload),
            productionId: productionId ?? null, taskId: taskId ?? null, maxAttempts, createdAt: this.now(), updatedAt: this.now(), ...(opts.extra ?? {}),
          },
        });
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
        return this.prisma.workflowRun.findFirst({ where: { companyId, idempotencyKey: key } });
      }
    } else {
      return run; // misma causa: no se repite
    }
    await this.dispatch(run);
    return this.prisma.workflowRun.findFirst({ where: { id: run.id } });
  }

  private async dispatch(run: any) {
    if (this.queue && !process.env.JEST_WORKER_ID) {
      try {
        // jobId determinista: BullMQ tampoco duplica
        await this.queue.add('run', { runId: run.id, companyId: run.companyId }, { jobId: `wf-${run.id}-${run.attempts}`, removeOnComplete: 500, removeOnFail: 2000 });
        return;
      } catch (e: any) {
        this.logger.warn(`Cola no disponible, se ejecuta en línea: ${e?.message}`);
      }
    }
    await this.execute(run.id, run.companyId);
  }

  /** Ejecuta una vez (si la puede reclamar). El contexto de empresa se valida contra la base. */
  async execute(runId: string, companyId: string): Promise<'COMPLETED' | 'RETRYABLE' | 'FAILED' | 'SKIPPED'> {
    const now = this.now();
    const claim = await this.prisma.workflowRun.updateMany({
      where: {
        id: runId, companyId, status: { in: ['PENDING', 'RETRYABLE', 'RUNNING', 'WAITING'] },
        OR: [{ lockedUntil: null }, { lockedUntil: { isSet: false } }, { lockedUntil: { lt: now } }],
      },
      data: { status: 'RUNNING', lockedUntil: new Date(now.getTime() + LOCK_MS), startedAt: now, attempts: { increment: 1 }, updatedAt: now },
    });
    if (!claim.count) return 'SKIPPED';
    const run: any = await this.prisma.workflowRun.findFirst({ where: { id: runId, companyId } });
    try {
      const result = await this.handle(run);
      await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', finishedAt: this.now(), lockedUntil: null, resultJson: JSON.stringify(result).slice(0, 2000), errorJson: null, nextRetryAt: null, updatedAt: this.now() } });
      return 'COMPLETED';
    } catch (err: any) {
      if (err instanceof WaitUntil) {
        // Espera programada: no cuenta como intento
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'WAITING', lockedUntil: null, nextRetryAt: err.until, attempts: Math.max(0, run.attempts - 1), updatedAt: this.now() } });
        // La cola lo despierta a tiempo; si no hay cola, el barrido (cada 5 min)
        if (this.queue && !process.env.JEST_WORKER_ID) {
          const delay = Math.max(0, err.until.getTime() - this.now().getTime());
          await this.queue.add('run', { runId: run.id, companyId }, { jobId: `wf-${run.id}-wait-${err.until.getTime()}`, delay, removeOnComplete: 500, removeOnFail: 2000 }).catch(() => undefined);
        }
        return 'RETRYABLE';
      }
      if (err instanceof CancelRun) {
        await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'CANCELLED', lockedUntil: null, nextRetryAt: null, finishedAt: this.now(), errorJson: JSON.stringify({ message: err.message.slice(0, 300), name: 'CancelRun' }), updatedAt: this.now() } });
        return 'FAILED';
      }
      const final = run.attempts >= run.maxAttempts || err?.permanent === true;
      const error = { message: String(err?.message ?? err).slice(0, 300), name: err?.name ?? 'Error', attempt: run.attempts };
      await this.prisma.workflowRun.update({
        where: { id: run.id },
        data: {
          status: final ? 'FAILED' : 'RETRYABLE', lockedUntil: null, errorJson: JSON.stringify(error),
          nextRetryAt: final ? null : new Date(this.now().getTime() + Math.min(60, 2 ** run.attempts) * 60_000), finishedAt: final ? this.now() : null, updatedAt: this.now(),
        },
      });
      if (final && run.productionId) {
        await this.productions.event(companyId, run.productionId, { type: 'SYSTEM', name: 'Motor de Automation' }, 'engine_error', `El motor falló tras ${run.attempts} intento(s) (${run.kind}): ${error.message}`, { runId: run.id });
      }
      this.logger.warn(`workflow ${run.kind} ${run.id}: ${error.message}${final ? ' (sin más reintentos)' : ''}`);
      return final ? 'FAILED' : 'RETRYABLE';
    }
  }

  /** Acciones internas. Cada una es idempotente por sí misma. */
  private async handle(run: any): Promise<Record<string, unknown>> {
    const payload = parseJson<Record<string, any>>(run.payloadJson, {});
    if (run.kind === 'production.status') return this.statusTasks(run.companyId, run.productionId, String(payload.status));
    if (run.kind === 'task.overdue') return this.markOverdue(run.companyId, run.taskId);
    if (run.kind === 'hold.expire') return { released: await this.productions.expireHold(run.companyId, String(payload.assignmentId)) };
    if (run.kind === 'test.fail') throw new Error('Fallo de prueba controlado');
    const handler = this.handlers.get(run.kind);
    if (handler) return handler(run);
    throw new Error(`Acción desconocida: ${run.kind}`);
  }

  /** Tareas de la configuración inicial para el estado al que llegó la producción. */
  private async statusTasks(companyId: string, productionId: string, status: string) {
    const p: any = await this.prisma.production.findFirst({ where: { id: productionId, companyId } });
    if (!p) throw new Error('La producción no existe en esta empresa');
    if (p.status !== status) return { skipped: 'la producción ya cambió de estado' };
    const cfg = mergeConfig(parseJson((await this.prisma.productionSettings.findUnique({ where: { companyId } }))?.configJson, {}));
    // La regla del brief también aplica a una solicitud NUEVA
    const effective = status === 'NUEVA' ? 'BRIEF_INCOMPLETO' : status;
    const created: string[] = [];
    let version: number | null = null;
    if (status === 'COTIZACION_PENDIENTE_APROBACION') {
      const q: any = await this.prisma.productionQuote.findFirst({ where: { companyId, productionId, status: 'PENDING_APPROVAL' }, orderBy: { version: 'desc' } });
      version = q?.version ?? null;
    }
    for (const [ruleKey, rule] of Object.entries(TASK_RULES)) {
      if (rule.status !== effective || !cfg.taskRules[ruleKey]?.enabled) continue;
      const key = `rule:${ruleKey}:${productionId}${version ? `:v${version}` : ''}`;
      const exists = await this.prisma.productionTask.findFirst({ where: { companyId, idempotencyKey: key } });
      if (exists) continue;
      try {
        await this.prisma.productionTask.create({
          data: {
            companyId, productionId, title: cfg.taskRules[ruleKey].title + (version ? ` (v${version})` : ''), origin: 'RULE', ruleKey,
            reason: `Regla «${ruleKey}» de la configuración inicial al entrar en ${status}`, idempotencyKey: key,
            assigneeId: p.ownerId ?? null, updatedAt: this.now(),
          },
        });
        created.push(ruleKey);
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
      }
    }
    if (created.length) {
      await this.productions.event(companyId, productionId, { type: 'SYSTEM', name: 'Motor de Automation' }, 'task', `Creó ${created.length} tarea(s) por regla: ${created.join(', ')}`, { rules: created });
    }
    return { created };
  }

  private async markOverdue(companyId: string, taskId: string) {
    const t: any = await this.prisma.productionTask.findFirst({ where: { id: taskId, companyId } });
    if (!t || !OPEN_TASK.includes(t.status) || t.overdueNotifiedAt) return { skipped: true };
    await this.prisma.productionTask.update({ where: { id: t.id }, data: { overdueNotifiedAt: this.now(), updatedAt: this.now() } });
    await this.productions.event(companyId, t.productionId, { type: 'SYSTEM', name: 'Motor de Automation' }, 'task_overdue', `Tarea vencida: «${t.title}»`, { taskId: t.id });
    return { marked: true };
  }

  /**
   * Barrido de recuperación (seguro de repetir): ejecuciones pendientes o
   * abandonadas, tareas vencidas y retenciones que expiraron.
   */
  async sweep() {
    const now = this.now();
    const due: any[] = await this.prisma.workflowRun.findMany({
      where: {
        OR: [
          { status: 'RETRYABLE', nextRetryAt: { lte: now } },
          { status: 'WAITING', nextRetryAt: { lte: now } },
          { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 60_000) } },
          { status: 'RUNNING', lockedUntil: { lt: now } },
        ],
      },
      take: 100,
    });
    for (const r of due) await this.execute(r.id, r.companyId);
    const overdue: any[] = await this.prisma.productionTask.findMany({ where: { status: { in: OPEN_TASK }, dueAt: { lt: now }, OR: [{ overdueNotifiedAt: null }, { overdueNotifiedAt: { isSet: false } }] }, take: 200 });
    for (const t of overdue) await this.schedule(t.companyId, 'task.overdue', `task.overdue:${t.id}`, {}, t.productionId, t.id);
    const holds: any[] = await this.prisma.productionAssignment.findMany({ where: { reservation: 'HOLD', holdExpiresAt: { lt: now } }, take: 200 });
    for (const a of holds) await this.schedule(a.companyId, 'hold.expire', `hold.expire:${a.id}:${new Date(a.holdExpiresAt).toISOString()}`, { assignmentId: a.id }, a.productionId);
    return { runs: due.length, overdue: overdue.length, holds: holds.length };
  }

  @Cron('*/5 * * * *')
  async recovery() {
    if (process.env.JEST_WORKER_ID || process.env.PRODUCTIONS_CRON_DISABLED === '1') return;
    try {
      await this.sweep();
    } catch (e: any) {
      this.logger.error(`Barrido del motor: ${e?.message}`);
    }
  }
}
