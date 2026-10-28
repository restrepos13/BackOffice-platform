/**
 * Fase 2 · motor genérico de automatizaciones (sobre WorkflowRun).
 * Todo corre contra el Prisma en memoria: ninguna prueba envía mensajes,
 * correos ni toca colas o servicios externos.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createMockPrisma } from './helpers/mock-prisma';
import { RolesGuard } from '../src/auth/roles.guard';
import { ProductsGuard } from '../src/auth/products.guard';
import { WorkflowService } from '../src/modules/productions/workflow.service';
import { OrdersService, RemindersService } from '../src/modules/orders.module';
import { AutomationsController, AutomationsService } from '../src/modules/automations.module';
import { AutomationEngineService, MAX_DEPTH } from '../src/modules/automations/automation-engine.service';
import { DefinitionError, evaluateRule, validateDefinition } from '../src/common/automation/definition';
import { contactCreated, contactStageChanged, orderHistory, setDomainEventHandler } from '../src/common/domain-events';

const PRODUCTS = JSON.stringify({ AUTOMATION: { enabled: true }, CREATIVE: { enabled: false }, ADS: { enabled: false } });
const u = (id: string, role: string, companyId: string | null) => ({ id, name: id, email: `${id}@prueba.test`, role, companyId }) as any;
const ADMIN_A = u('adminA', 'COMPANY_ADMIN', 'coA');
const VIEWER_A = u('viewerA', 'COMPANY_VIEWER', 'coA');
const ADMIN_B = u('adminB', 'COMPANY_ADMIN', 'coB');
const DEV = u('dev', 'DEV', null);

function world() {
  const { prisma, db } = createMockPrisma();
  db.company.push(
    { id: 'coA', name: 'Empresa A (prueba)', slug: 'a', productsJson: PRODUCTS, orderConfigJson: '{}' },
    { id: 'coB', name: 'Empresa B (prueba)', slug: 'b', productsJson: PRODUCTS, orderConfigJson: '{}' },
  );
  for (const x of [ADMIN_A, VIEWER_A, ADMIN_B]) db.user.push({ ...x, active: true });
  db.contact.push(
    { id: 'ctA', companyId: 'coA', name: 'Ana', phone: '+570001', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]', pipelineId: null },
    { id: 'ctA2', companyId: 'coA', name: 'Beto', phone: '+570002', channel: 'INSTAGRAM', stage: 'CURIOSO', tagsJson: '[]', pipelineId: null },
    { id: 'ctB', companyId: 'coB', name: 'Carla', phone: '+570003', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]', pipelineId: null },
  );
  const audit = { log: jest.fn(async (p: any) => { db.auditLog.push({ id: `a${db.auditLog.length}`, ...p }); }) };
  const reminders = new RemindersService(prisma as any, audit as any, {} as any);
  const orders = new OrdersService(prisma as any, audit as any, reminders);
  const workflow = new WorkflowService(prisma as any, { event: jest.fn() } as any);
  const engine = new AutomationEngineService(prisma as any, workflow, orders);
  engine.onModuleInit();
  const svc = new AutomationsService(prisma as any, audit as any, engine);
  let clock = new Date('2026-10-27T15:00:00Z');
  const now = () => new Date(clock);
  workflow.now = now;
  engine.now = now;
  const advance = (ms: number) => { clock = new Date(clock.getTime() + ms); };
  const runs = () => db.workflowRun.filter((r: any) => r.kind === 'automation.run');
  return { prisma, db, svc, engine, workflow, orders, audit, advance, runs };
}

afterEach(() => setDomainEventHandler(null));

const def = (over: Record<string, any> = {}) => ({
  trigger: { type: 'contact.created' },
  conditions: { match: 'all', rules: [{ field: 'contact.channel', op: 'eq', value: 'WHATSAPP' }] },
  actions: [
    { type: 'add_tag', config: { tag: 'nuevo' } },
    { type: 'create_follow_up', config: { note: 'Llamar a {{contact.name}}', dueInHours: 2 } },
    { type: 'log_activity', config: { text: 'Bienvenida registrada' } },
  ],
  ...over,
});

async function activeAutomation(w: ReturnType<typeof world>, definition: any, user = ADMIN_A, name = 'Bienvenida') {
  const a: any = await w.svc.create(user, { name, definition });
  await w.svc.setStatus(user, a.id, 'ACTIVE');
  return a.id as string;
}

describe('Definición: validación estricta', () => {
  it('rechaza disparadores, campos, operadores y acciones no soportados', () => {
    const errors = (raw: any) => { try { validateDefinition(raw); return []; } catch (e) { return (e as DefinitionError).errors; } };
    expect(errors({ ...def(), trigger: { type: 'message.received' } })).toContain('Elige un disparador válido');
    expect(errors({ ...def(), script: 'process.exit()' }).join()).toMatch(/no soportados: script/);
    expect(errors({ ...def(), conditions: { match: 'all', rules: [{ field: 'contact.password', op: 'eq', value: 'x' }] } }).join()).toMatch(/no está disponible/);
    expect(errors({ ...def(), conditions: { match: 'all', rules: [{ field: 'contact.tags', op: 'gt', value: 1 }] } }).join()).toMatch(/no aplica/);
    expect(errors({ ...def(), conditions: { match: 'all', rules: [], groups: [] } }).join()).toMatch(/anidados/);
    expect(errors({ ...def(), conditions: { match: 'all', rules: Array.from({ length: 11 }, () => ({ field: 'contact.name', op: 'exists' })) } }).join()).toMatch(/Máximo 10/);
    expect(errors({ ...def(), actions: [{ type: 'send_whatsapp', config: {} }] }).join()).toMatch(/no soportada/);
    expect(errors({ ...def(), actions: [{ type: 'assign_courier' }] }).join()).toMatch(/solo aplica a disparadores de pedidos/);
    expect(errors({ ...def(), actions: [{ type: 'add_tag', config: { tag: 'x' } }, { type: 'wait', config: { hours: 2 } }] }).join()).toMatch(/última acción/);
    expect(errors({ ...def(), actions: [{ type: 'create_follow_up', config: { note: 'x'.repeat(301), dueInHours: 1 } }] }).join()).toMatch(/300/);
    expect(errors({ ...def(), options: { maxRunsPerHour: 100000 } }).join()).toMatch(/por hora/);
    expect(errors({ ...def(), trigger: { type: 'order.status_changed', config: { toStatus: 'volando' } } }).join()).toMatch(/no permitido/);
  });

  it('los valores son datos: una «expresión» solo se compara como texto', () => {
    const d = validateDefinition({ ...def(), conditions: { match: 'all', rules: [{ field: 'contact.name', op: 'eq', value: '${process.exit(1)}' }] } });
    expect(evaluateRule(d.conditions.rules[0], { 'contact.name': '${process.exit(1)}' })).toBe(true);
    expect(evaluateRule(d.conditions.rules[0], { 'contact.name': 'Ana' })).toBe(false);
  });

  it('operadores tipados', () => {
    expect(evaluateRule({ field: 'n', op: 'gt', value: 10 }, { n: 11 })).toBe(true);
    expect(evaluateRule({ field: 'n', op: 'gt', value: 10 }, { n: '11' as any })).toBe(false); // sin coerción
    expect(evaluateRule({ field: 't', op: 'contains', value: 'VIP' }, { t: ['vip', 'b'] })).toBe(true);
    expect(evaluateRule({ field: 't', op: 'not_contains', value: 'vip' }, { t: ['VIP'] })).toBe(false);
    expect(evaluateRule({ field: 's', op: 'contains', value: 'ana' }, { s: 'Mariana' })).toBe(true);
    expect(evaluateRule({ field: 's', op: 'exists' }, { s: '' })).toBe(false);
    expect(evaluateRule({ field: 'e', op: 'in', value: ['listo', 'empacado'] }, { e: 'listo' })).toBe(true);
    expect(evaluateRule({ field: 'b', op: 'is_true' }, { b: true })).toBe(true);
    expect(evaluateRule({ field: 'x', op: 'raro' as any, value: 1 }, { x: 1 })).toBe(false);
  });
});

describe('Flujo completo: definir → disparar → evaluar → ejecutar en orden', () => {
  it('una empresa crea, activa y un contacto nuevo la dispara; las acciones corren en orden y quedan en el historial', async () => {
    const w = world();
    const id = await activeAutomation(w, def());
    expect(w.db.automationVersion).toHaveLength(1);
    await contactCreated('coA', 'ctA');
    const [run] = w.runs();
    expect(run).toMatchObject({ status: 'COMPLETED', automationId: id, automationVersion: 1, triggerType: 'contact.created', sourceType: 'contact', sourceId: 'ctA', attempts: 1 });
    const steps = JSON.parse(run.stepsJson);
    expect(steps.map((s: any) => [s.index, s.type, s.status])).toEqual([[0, 'add_tag', 'DONE'], [1, 'create_follow_up', 'DONE'], [2, 'log_activity', 'DONE']]);
    expect(JSON.parse(w.db.contact[0].tagsJson)).toEqual(['nuevo']);
    expect(w.db.followUp).toHaveLength(1);
    expect(w.db.followUp[0]).toMatchObject({ companyId: 'coA', contactId: 'ctA', note: 'Llamar a Ana', createdBy: 'Automatización «Bienvenida»' });
    expect(w.db.auditLog.find((l: any) => l.action === 'automation.activity')).toMatchObject({ companyId: 'coA', entityId: 'ctA' });

    const history: any = await w.svc.runs(ADMIN_A, { automationId: id });
    expect(history.items[0]).toMatchObject({ status: 'COMPLETED', automationName: 'Bienvenida', automationVersion: 1, stepsDone: 3, attempts: 1 });
    const detail: any = await w.svc.run(ADMIN_A, run.id);
    expect(detail.conditions).toEqual([{ field: 'contact.channel', op: 'eq', passed: true }]);
    const list: any[] = await w.svc.list(ADMIN_A);
    expect(list[0].stats).toMatchObject({ runs30d: 1, failed30d: 0 });
  });

  it('si las condiciones no se cumplen no se crea ejecución', async () => {
    const w = world();
    await activeAutomation(w, def());
    await contactCreated('coA', 'ctA2'); // INSTAGRAM
    expect(w.runs()).toHaveLength(0);
    expect(w.db.followUp).toHaveLength(0);
  });

  it('pedido: el cambio de estado registrado en el historial dispara con condiciones numéricas', async () => {
    const w = world();
    w.db.customer.push({ id: 'cuA', companyId: 'coA', name: 'Cliente A' });
    w.db.order.push({ id: 'orA', companyId: 'coA', customerId: 'cuA', contactId: 'ctA', status: 'confirmado', total: 150000, source: 'WHATSAPP', paymentStatus: 'NONE' });
    await activeAutomation(w, {
      trigger: { type: 'order.status_changed', config: { toStatus: 'programado' } },
      conditions: { match: 'all', rules: [{ field: 'order.total', op: 'gte', value: 100000 }] },
      actions: [{ type: 'create_follow_up', config: { note: 'Pedido grande de {{contact.name}}', dueInHours: 1 } }],
    }, ADMIN_A, 'Pedidos grandes');
    await orderHistory(w.prisma).create({ data: { companyId: 'coA', orderId: 'orA', fromStatus: 'confirmado', toStatus: 'en_produccion' } });
    expect(w.runs()).toHaveLength(0); // filtro del disparador
    await orderHistory(w.prisma).create({ data: { companyId: 'coA', orderId: 'orA', fromStatus: 'confirmado', toStatus: 'programado' } });
    expect(w.runs()[0]).toMatchObject({ status: 'COMPLETED', sourceType: 'order', sourceId: 'orA' });
    expect(w.db.followUp[0]).toMatchObject({ contactId: 'ctA', note: 'Pedido grande de Ana' });
  });
});

describe('Idempotencia, reintentos y recuperación', () => {
  it('eventos repetidos (y simultáneos) no duplican la ejecución ni los efectos', async () => {
    const w = world();
    await activeAutomation(w, def());
    await Promise.all([contactCreated('coA', 'ctA'), contactCreated('coA', 'ctA'), contactCreated('coA', 'ctA')]);
    await contactCreated('coA', 'ctA');
    expect(w.runs()).toHaveLength(1);
    expect(w.db.followUp).toHaveLength(1);
    expect(JSON.parse(w.db.contact[0].tagsJson)).toEqual(['nuevo']);
  });

  it('once_per_record: cambios de etapa repetidos del mismo contacto corren una sola vez', async () => {
    const w = world();
    await activeAutomation(w, { trigger: { type: 'contact.stage_changed' }, actions: [{ type: 'log_activity', config: { text: 'cambió' } }], options: { dedupe: 'once_per_record' } });
    await contactStageChanged('coA', 'ctA', 'CURIOSO', 'POTENCIAL');
    w.advance(3600_000);
    await contactStageChanged('coA', 'ctA', 'POTENCIAL', 'CALIENTE');
    expect(w.runs()).toHaveLength(1);
  });

  it('un fallo transitorio se reintenta con espera y continúa desde la acción que falló', async () => {
    const w = world();
    await activeAutomation(w, def());
    const original = w.prisma.followUp.create;
    let calls = 0;
    w.prisma.followUp.create = (async (args: any) => { if (++calls === 1) throw new Error('Mongo no respondió'); return original(args); }) as any;
    await contactCreated('coA', 'ctA');
    let run = w.runs()[0];
    expect(run.status).toBe('RETRYABLE');
    expect(JSON.parse(run.errorJson)).toMatchObject({ message: 'Mongo no respondió', attempt: 1 });
    expect(JSON.parse(run.stepsJson).map((s: any) => s.status)).toEqual(['DONE', 'FAILED']);
    // Antes de la espera el barrido no la toca
    await w.workflow.sweep();
    expect(w.runs()[0].status).toBe('RETRYABLE');
    w.advance(2 * 60_000 + 1);
    await w.workflow.sweep();
    run = w.runs()[0];
    expect(run).toMatchObject({ status: 'COMPLETED', attempts: 2 });
    expect(JSON.parse(w.db.contact[0].tagsJson)).toEqual(['nuevo']); // no se repitió
    expect(w.db.followUp).toHaveLength(1);
  });

  it('agota los intentos configurados y queda FAILED; un error permanente no se reintenta', async () => {
    const w = world();
    await activeAutomation(w, { ...def(), actions: [{ type: 'create_follow_up', config: { note: 'x', dueInHours: 1 } }], options: { maxAttempts: 2 } });
    w.prisma.followUp.create = (async () => { throw new Error('siempre falla'); }) as any;
    await contactCreated('coA', 'ctA');
    w.advance(60 * 60_000);
    await w.workflow.sweep();
    expect(w.runs()[0]).toMatchObject({ status: 'FAILED', attempts: 2 });
    w.advance(60 * 60_000);
    await w.workflow.sweep();
    expect(w.runs()[0].attempts).toBe(2);

    const w2 = world();
    w2.db.user.push({ id: 'ex', name: 'Ex', role: 'COMPANY_VIEWER', companyId: 'coA', active: true });
    await activeAutomation(w2, { ...def(), actions: [{ type: 'assign_owner', config: { userId: 'ex' } }] });
    w2.db.user.find((x: any) => x.id === 'ex')!.active = false;
    await contactCreated('coA', 'ctA');
    expect(w2.runs()[0]).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(JSON.parse(w2.runs()[0].errorJson).message).toMatch(/no está activo/);
  });

  it('una ejecución bloqueada (proceso caído) se recupera; dos workers no la corren a la vez', async () => {
    const w = world();
    await activeAutomation(w, def());
    const realExecute = w.workflow.execute.bind(w.workflow);
    w.workflow.execute = (async () => 'SKIPPED') as any; // el proceso «muere» antes de ejecutar
    await contactCreated('coA', 'ctA');
    w.workflow.execute = realExecute;
    const run = w.runs()[0];
    Object.assign(run, { status: 'RUNNING', lockedUntil: new Date(w.workflow.now().getTime() + 60_000), attempts: 1 });
    expect(await w.workflow.execute(run.id, 'coA')).toBe('SKIPPED'); // candado vigente
    w.advance(2 * 60_000);
    const [a, b] = await Promise.all([w.workflow.execute(run.id, 'coA'), w.workflow.execute(run.id, 'coA')]);
    expect([a, b].sort()).toEqual(['COMPLETED', 'SKIPPED']);
    expect(w.db.followUp).toHaveLength(1);
    // Contexto de empresa: la ejecución no se puede reclamar desde otra empresa
    expect(await w.workflow.execute(run.id, 'coB')).toBe('SKIPPED');
  });
});

describe('Esperas, pausa, versiones, bucles y límites', () => {
  const waitDef = () => ({ ...def(), actions: [{ type: 'add_tag', config: { tag: 'a' } }, { type: 'wait', config: { hours: 24 } }, { type: 'create_follow_up', config: { note: 'Seguimiento', dueInHours: 0 } }] });

  it('«Esperar» deja la ejecución en WAITING sin gastar intentos y sigue a la hora indicada', async () => {
    const w = world();
    await activeAutomation(w, waitDef());
    await contactCreated('coA', 'ctA');
    expect(w.runs()[0]).toMatchObject({ status: 'WAITING', attempts: 0 });
    expect(w.db.followUp).toHaveLength(0);
    w.advance(23 * 3600_000);
    await w.workflow.sweep();
    expect(w.runs()[0].status).toBe('WAITING');
    w.advance(3600_000 + 1);
    await w.workflow.sweep();
    expect(w.runs()[0]).toMatchObject({ status: 'COMPLETED', attempts: 1 });
    expect(w.db.followUp).toHaveLength(1);
  });

  it('pausar cancela lo pendiente; editar una activa publica otra versión sin alterar lo ya iniciado', async () => {
    const w = world();
    const id = await activeAutomation(w, waitDef());
    await contactCreated('coA', 'ctA');
    // Versión 2: cambia el texto del seguimiento
    await w.svc.update(ADMIN_A, id, { definition: { ...waitDef(), actions: [{ type: 'add_tag', config: { tag: 'a' } }, { type: 'wait', config: { hours: 24 } }, { type: 'create_follow_up', config: { note: 'Versión 2', dueInHours: 0 } }] } });
    expect(w.db.automation[0].version).toBe(2);
    expect(w.runs()[0].automationVersion).toBe(1);
    w.advance(25 * 3600_000);
    await w.workflow.sweep();
    expect(w.db.followUp[0].note).toBe('Seguimiento'); // corrió la versión 1

    await contactCreated('coA', 'ctA2');
    // ctA2 es INSTAGRAM: no cumple. Otro contacto de WhatsApp:
    w.db.contact.push({ id: 'ctA3', companyId: 'coA', name: 'Dani', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]' });
    await contactCreated('coA', 'ctA3');
    const waiting = w.runs().find((r: any) => r.sourceId === 'ctA3');
    expect(waiting).toMatchObject({ status: 'WAITING', automationVersion: 2 });
    const r: any = await w.svc.setStatus(ADMIN_A, id, 'PAUSED');
    expect(r.cancelledRuns).toBe(1);
    w.advance(25 * 3600_000);
    await w.workflow.sweep();
    expect(w.runs().find((x: any) => x.sourceId === 'ctA3')!.status).toBe('CANCELLED');
    // Pausada no dispara
    w.db.contact.push({ id: 'ctA4', companyId: 'coA', name: 'Eva', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]' });
    await contactCreated('coA', 'ctA4');
    expect(w.runs().find((x: any) => x.sourceId === 'ctA4')).toBeUndefined();
  });

  it('bucles: una automatización no se redispara a sí misma y las cadenas se cortan en profundidad', async () => {
    const w = world();
    // Se redispararía con su propio cambio de etapa
    await activeAutomation(w, { trigger: { type: 'contact.stage_changed' }, actions: [{ type: 'set_stage', config: { stage: 'CALIENTE' } }] }, ADMIN_A, 'Auto');
    await contactStageChanged('coA', 'ctA', 'CURIOSO', 'POTENCIAL');
    expect(w.runs()).toHaveLength(1);
    expect(w.db.contact[0].stage).toBe('CALIENTE');

    // Ping-pong entre dos automatizaciones
    const w2 = world();
    await activeAutomation(w2, { trigger: { type: 'contact.stage_changed', config: { toStage: 'POTENCIAL' } }, actions: [{ type: 'set_stage', config: { stage: 'CALIENTE' } }] }, ADMIN_A, 'Ping');
    await activeAutomation(w2, { trigger: { type: 'contact.stage_changed', config: { toStage: 'CALIENTE' } }, actions: [{ type: 'set_stage', config: { stage: 'POTENCIAL' } }] }, ADMIN_A, 'Pong');
    w2.db.contact[0].stage = 'POTENCIAL';
    await contactStageChanged('coA', 'ctA', 'CURIOSO', 'POTENCIAL');
    expect(w2.runs().length).toBe(MAX_DEPTH);
    expect(w2.runs().map((r: any) => JSON.parse(r.payloadJson).depth)).toEqual([1, 2, 3]);
  });

  it('límite de ejecuciones por hora: lo que excede queda CANCELADO y visible', async () => {
    const w = world();
    await activeAutomation(w, { ...def(), conditions: { match: 'all', rules: [] }, actions: [{ type: 'log_activity', config: { text: 'x' } }], options: { maxRunsPerHour: 2 } });
    for (const c of ['ctA', 'ctA2']) await contactCreated('coA', c);
    w.db.contact.push({ id: 'ctA5', companyId: 'coA', name: 'F', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]' });
    await contactCreated('coA', 'ctA5');
    expect(w.runs().map((r: any) => r.status)).toEqual(['COMPLETED', 'COMPLETED', 'CANCELLED']);
    expect(JSON.parse(w.runs()[2].errorJson).message).toMatch(/máximo de ejecuciones por hora/);
    w.advance(3600_000 + 1);
    w.db.contact.push({ id: 'ctA6', companyId: 'coA', name: 'G', channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]' });
    await contactCreated('coA', 'ctA6');
    expect(w.runs()[3].status).toBe('COMPLETED');
  });

  it('estados: borrador no dispara, archivada es de solo lectura, solo se borran borradores nunca activados', async () => {
    const w = world();
    const a: any = await w.svc.create(ADMIN_A, { name: 'Borrador', definition: def() });
    await contactCreated('coA', 'ctA');
    expect(w.runs()).toHaveLength(0);
    // Borrador incompleto se guarda, pero no se activa
    const b: any = await w.svc.create(ADMIN_A, { name: 'Incompleta', definition: { trigger: { type: 'contact.created' } } });
    expect(b.validation.valid).toBe(false);
    await expect(w.svc.setStatus(ADMIN_A, b.id, 'ACTIVE')).rejects.toMatchObject({ response: { errors: ['Agrega al menos una acción'] } });
    await w.svc.setStatus(ADMIN_A, a.id, 'ACTIVE');
    await expect(w.svc.remove(ADMIN_A, a.id)).rejects.toThrow(/Archívala/);
    await w.svc.setStatus(ADMIN_A, a.id, 'ARCHIVED');
    await expect(w.svc.update(ADMIN_A, a.id, { name: 'Otro' })).rejects.toThrow(/archivada/);
    await expect(w.svc.setStatus(ADMIN_A, a.id, 'ACTIVE')).rejects.toThrow(/No se puede pasar/);
    await expect(w.svc.remove(ADMIN_A, b.id)).resolves.toEqual({ ok: true });
    // Una activa solo acepta definiciones válidas
    const c = await activeAutomation(w, def(), ADMIN_A, 'Tercera');
    await expect(w.svc.update(ADMIN_A, c, { definition: { trigger: { type: 'contact.created' }, actions: [] } })).rejects.toThrow(/errores/);
  });
});

describe('Aislamiento entre empresas y autorización', () => {
  it('otra empresa no ve, edita, activa, simula ni consulta ejecuciones ajenas', async () => {
    const w = world();
    const id = await activeAutomation(w, def());
    await contactCreated('coA', 'ctA');
    const runId = w.runs()[0].id;
    await expect(w.svc.get(ADMIN_B, id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.svc.update(ADMIN_B, id, { name: 'robada' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.svc.setStatus(ADMIN_B, id, 'PAUSED')).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.svc.run(ADMIN_B, runId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(w.svc.cancelRun(ADMIN_B, runId)).rejects.toBeInstanceOf(NotFoundException);
    // El companyId que manda el navegador no cambia la empresa de un usuario de empresa
    expect((await w.svc.runs(ADMIN_B, { companyId: 'coA' })).items).toHaveLength(0);
    expect(await w.svc.list(ADMIN_B, 'coA')).toHaveLength(0);
    const created: any = await w.svc.create(ADMIN_B, { name: 'Mía', companyId: 'coA' });
    expect(created.companyId).toBe('coB');
    await expect(w.svc.simulate(ADMIN_B, { definition: def(), recordId: 'ctA' })).rejects.toBeInstanceOf(NotFoundException);
    // Un evento de B no corre automatizaciones de A
    await contactCreated('coB', 'ctB');
    expect(w.runs()).toHaveLength(1);
    // Un evento con empresa cruzada (contacto de A anunciado como de B) no encuentra el registro
    await activeAutomation(w, def(), ADMIN_B, 'De B');
    await contactCreated('coB', 'ctA');
    expect(w.runs()).toHaveLength(1);
    // Plataforma debe elegir empresa
    await expect(w.svc.runs(DEV, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect((await w.svc.runs(DEV, { companyId: 'coA' })).items).toHaveLength(1);
  });

  it('las referencias de la definición deben ser de la empresa', async () => {
    const w = world();
    const a: any = await w.svc.create(ADMIN_A, { name: 'Asignar', definition: { ...def(), actions: [{ type: 'assign_owner', config: { userId: 'adminB' } }] } });
    await expect(w.svc.setStatus(ADMIN_A, a.id, 'ACTIVE')).rejects.toThrow(/no es un usuario activo de esta empresa/);
    const b: any = await w.svc.create(ADMIN_A, { name: 'Etapa', definition: { ...def(), actions: [{ type: 'set_stage', config: { stage: 'INVENTADA' } }] } });
    await expect(w.svc.setStatus(ADMIN_A, b.id, 'ACTIVE')).rejects.toThrow(/no existen en los embudos/);
    expect(w.db.automationVersion).toHaveLength(0);
  });

  it('roles y producto: consulta no edita; sin Automation responde 403 y el motor no dispara', async () => {
    const w = world();
    const roles = new RolesGuard(new Reflector());
    const ctx = (user: any, method: string) => ({ getHandler: () => (AutomationsController.prototype as any)[method], getClass: () => AutomationsController, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as any;
    expect(() => roles.canActivate(ctx(VIEWER_A, 'create'))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctx(VIEWER_A, 'status'))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(ctx(VIEWER_A, 'simulate'))).toThrow(ForbiddenException);
    expect(roles.canActivate(ctx(VIEWER_A, 'runs'))).toBe(true);
    expect(roles.canActivate(ctx(ADMIN_A, 'create'))).toBe(true);
    await activeAutomation(w, def());
    w.db.company[0].productsJson = JSON.stringify({ AUTOMATION: { enabled: false }, CREATIVE: { enabled: true }, ADS: { enabled: false } });
    const products = new ProductsGuard(new Reflector(), w.prisma as any);
    await expect(products.canActivate(ctx(ADMIN_A, 'list'))).rejects.toBeInstanceOf(ForbiddenException);
    await contactCreated('coA', 'ctA');
    expect(w.runs()).toHaveLength(0);
  });
});

describe('Historial, simulación y efectos externos', () => {
  it('paginación por cursor y filtros por estado', async () => {
    const w = world();
    await activeAutomation(w, { ...def(), conditions: { match: 'all', rules: [] }, actions: [{ type: 'log_activity', config: { text: 'x' } }] });
    for (let i = 0; i < 5; i++) {
      w.db.contact.push({ id: `p${i}`, companyId: 'coA', name: `P${i}`, channel: 'WHATSAPP', stage: 'CURIOSO', tagsJson: '[]' });
      await contactCreated('coA', `p${i}`);
      w.advance(1000);
    }
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page: any = await w.svc.runs(ADMIN_A, { limit: 2, ...(cursor ? { before: cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((r: any) => r.sourceId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['p4', 'p3', 'p2', 'p1', 'p0']);
    expect((await w.svc.runs(ADMIN_A, { status: 'FAILED' })).items).toHaveLength(0);
    expect((await w.svc.runs(ADMIN_A, { limit: 500 })).items).toHaveLength(5); // tope 50
  });

  it('la simulación evalúa sin crear ejecuciones ni cambiar datos', async () => {
    const w = world();
    const before = JSON.stringify(w.db);
    const sim: any = await w.svc.simulate(ADMIN_A, { definition: def(), recordId: 'ctA' });
    expect(sim).toMatchObject({ simulation: true, source: 'record', wouldRun: true });
    expect(sim.actions.map((a: any) => a.description)[0]).toMatch(/Agregaría/);
    const sample: any = await w.svc.simulate(ADMIN_A, { definition: def(), sample: { 'contact.channel': 'INSTAGRAM' } });
    expect(sample.wouldRun).toBe(false);
    await expect(w.svc.simulate(ADMIN_A, { definition: def(), sample: { 'company.secret': 'x' } })).rejects.toThrow(/no disponible/);
    expect(JSON.stringify(w.db)).toBe(before);
  });

  it('ninguna acción del motor produce envíos externos', async () => {
    const w = world();
    await activeAutomation(w, { ...def(), actions: [{ type: 'add_tag', config: { tag: 'a' } }, { type: 'create_follow_up', config: { note: 'n', dueInHours: 1 } }, { type: 'log_activity', config: { text: 't' } }, { type: 'set_stage', config: { stage: 'POTENCIAL' } }, { type: 'assign_owner', config: { userId: 'viewerA' } }] });
    await contactCreated('coA', 'ctA');
    expect(w.runs()[0].status).toBe('COMPLETED');
    for (const c of ['message', 'reminder', 'broadcast', 'broadcastRecipient', 'emailMessage', 'bookingNotice', 'addonTouch']) expect((w.db as any)[c]).toHaveLength(0);
  });

  it('las automatizaciones descriptivas anteriores no muestran métricas de demostración ni se activan sin definición', async () => {
    const w = world();
    w.db.automation.push({ id: 'old', companyId: 'coA', name: 'Recordatorio 24h', trigger: 'Cita agendada', status: 'DRAFT', configJson: '{}', version: 0, runsCount: 412, successRate: 99.2 });
    const [row]: any[] = await w.svc.list(ADMIN_A);
    expect(row).toMatchObject({ legacy: true, legacyTrigger: 'Cita agendada', stats: { runs30d: 0 } });
    expect(row).not.toHaveProperty('runsCount');
    expect(row).not.toHaveProperty('successRate');
    await expect(w.svc.setStatus(ADMIN_A, 'old', 'ACTIVE')).rejects.toThrow(/Define disparador/);
  });
});

describe('Compatibilidad con Producciones', () => {
  it('las ejecuciones de Producciones siguen siendo idempotentes con _id determinista', async () => {
    const w = world();
    const a: any = await w.workflow.schedule('coA', 'test.fail', 'k1', {}, null, null, { maxAttempts: 1 });
    const b: any = await w.workflow.schedule('coA', 'test.fail', 'k1', {});
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^wf_[0-9a-f]{32}$/);
    expect(w.db.workflowRun).toHaveLength(1);
    expect(w.db.workflowRun[0].status).toBe('FAILED');
    // Misma clave en otra empresa = otra ejecución
    await w.workflow.schedule('coB', 'test.fail', 'k1', {}, null, null, { maxAttempts: 1 });
    expect(w.db.workflowRun).toHaveLength(2);
  });
});

describe('Bloque H · asignación de domiciliarios migrable y reversible', () => {
  function deliveryWorld() {
    const w = world();
    w.db.company[0].orderConfigJson = JSON.stringify({ delivery: { enabled: true, autoAssign: true } });
    w.db.user.push(
      { id: 'cur1', name: 'Domi Uno', role: 'COMPANY_COURIER', companyId: 'coA', active: true, onShift: true, lastLocAt: new Date() },
      { id: 'cur2', name: 'Domi Dos', role: 'COMPANY_COURIER', companyId: 'coA', active: true, onShift: true, lastLocAt: new Date() },
    );
    w.db.customer.push({ id: 'cuA', companyId: 'coA', name: 'Cliente A' });
    w.db.order.push(
      { id: 'busy', companyId: 'coA', customerId: 'cuA', status: 'despachado', courierId: 'cur1', deletedAt: null },
      { id: 'o1', companyId: 'coA', customerId: 'cuA', contactId: 'ctA', status: 'en_produccion', courierId: null, deletedAt: null },
      { id: 'o2', companyId: 'coA', customerId: 'cuA', contactId: 'ctA', status: 'en_produccion', courierId: null, deletedAt: null },
    );
    return w;
  }
  const courierDef = { trigger: { type: 'order.status_changed', config: { toStatus: 'listo' } }, conditions: { match: 'all', rules: [{ field: 'order.hasCourier', op: 'is_false' }] }, actions: [{ type: 'assign_courier' }] };
  const SYS = { type: 'SISTEMA' as const, name: 'prueba' };

  it('equivalencia: el motor asigna el mismo domiciliario que el proceso original, sin doble asignación', async () => {
    const legacy = deliveryWorld();
    await legacy.orders.changeStatus('o1', 'listo', SYS);
    const legacyCourier = legacy.db.order.find((o: any) => o.id === 'o1')!.courierId;
    expect(legacyCourier).toBe('cur2'); // el de menos carga

    const w = deliveryWorld();
    await activeAutomation(w, courierDef, ADMIN_A, 'Asignar domiciliario');
    // Antes de migrar: la automatización activa no asigna (dueño = proceso original)
    await w.svc.setCourierAssignment(ADMIN_A, { via: 'automation' });
    const assigns = jest.spyOn(w.orders, 'autoAssignCourier');
    await w.orders.changeStatus('o1', 'listo', SYS);
    expect(w.db.order.find((o: any) => o.id === 'o1')!.courierId).toBe(legacyCourier);
    expect(assigns.mock.calls.map((c) => c[1] ?? 'legacy').sort()).toEqual(['automation', 'legacy']); // los dos lo intentan; solo uno es dueño
    expect(w.db.auditLog.filter((l: any) => l.action === 'delivery.auto_assign')).toHaveLength(1);
    expect(w.runs()[0]).toMatchObject({ status: 'COMPLETED' });
    expect(JSON.parse(w.runs()[0].stepsJson)[0].output).toMatchObject({ assigned: true, courierId: 'cur2' });
  });

  it('reversión: volver al proceso original, o pausar la automatización, devuelve la asignación al original', async () => {
    const w = deliveryWorld();
    const id = await activeAutomation(w, courierDef, ADMIN_A, 'Asignar domiciliario');
    await w.svc.setCourierAssignment(ADMIN_A, { via: 'automation' });
    await w.svc.setStatus(ADMIN_A, id, 'PAUSED');
    await w.orders.changeStatus('o1', 'listo', SYS);
    expect(w.db.order.find((o: any) => o.id === 'o1')!.courierId).toBe('cur2'); // lo hizo el original
    await w.svc.setStatus(ADMIN_A, id, 'ACTIVE');
    await w.svc.setCourierAssignment(ADMIN_A, { via: 'legacy' });
    await w.orders.changeStatus('o2', 'listo', SYS);
    expect(w.db.order.find((o: any) => o.id === 'o2')!.courierId).toBeTruthy();
    expect(JSON.parse(w.runs().find((r: any) => r.sourceId === 'o2')!.stepsJson)[0].output).toMatchObject({ assigned: false });
    expect(w.db.auditLog.filter((l: any) => l.action === 'delivery.auto_assign')).toHaveLength(2);
  });

  it('no se puede pasar al motor sin una automatización activa que asigne', async () => {
    const w = deliveryWorld();
    await expect(w.svc.setCourierAssignment(ADMIN_A, { via: 'automation' })).rejects.toThrow(/Primero activa/);
    await expect(w.svc.setCourierAssignment(ADMIN_B, { via: 'automation' })).rejects.toThrow(/no está encendida/);
  });
});
