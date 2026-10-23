/**
 * Producciones (piloto LPulpo): flujo completo con datos de PRUEBA, permisos,
 * aislamiento entre empresas, idempotencia, concurrencia y motor de Automation.
 * Todo es interno: ninguna prueba envía mensajes ni toca servicios externos.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ProductsGuard } from '../src/auth/products.guard';
import { ProductionsService } from '../src/modules/productions/productions.service';
import { WorkflowService } from '../src/modules/productions/workflow.service';
import { ProductionsController } from '../src/modules/productions/productions.module';
import { integrationsReport, validateWhatsapp } from '../src/modules/productions/integrations-status';
import { hourSlots, quoteTotals, sanitizeLines } from '../src/common/productions';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const NOW = new Date('2026-10-23T15:00:00Z');
const u = (id: string, role: string, companyId: string | null) => ({ id, name: id, email: `${id}@prueba.test`, role, companyId }) as any;
const ADMIN = u('admin', 'COMPANY_ADMIN', 'coA');
const BOOKER = u('booker', 'COMPANY_VIEWER', 'coA');
const APPROVER = u('aprobador', 'COMPANY_VIEWER', 'coA');
const FINANCE = u('finanzas', 'COMPANY_VIEWER', 'coA');
const OPS = u('operacion', 'COMPANY_VIEWER', 'coA');
const VIEWER = u('consulta', 'COMPANY_VIEWER', 'coA');
const AREA = u('area', 'COMPANY_AREA', 'coA');
const ADMIN_B = u('adminB', 'COMPANY_ADMIN', 'coB');
const DEV = u('dev', 'DEV', null);

function world() {
  const { prisma, db: raw } = createMockPrisma();
  const db = raw as any;
  const productsJson = JSON.stringify({ AUTOMATION: { enabled: true }, CREATIVE: { enabled: false }, ADS: { enabled: false } });
  db.company.push({ id: 'coA', name: 'Agencia de prueba A', slug: 'prueba-a', productsJson }, { id: 'coB', name: 'Agencia de prueba B', slug: 'prueba-b', productsJson });
  for (const [x, profile] of [[ADMIN, null], [BOOKER, 'BOOKER'], [APPROVER, 'BOOKER_APPROVER'], [FINANCE, 'FINANCE'], [OPS, 'OPERATIONS'], [VIEWER, null], [AREA, null], [ADMIN_B, null], [DEV, null]] as const) {
    db.user.push({ id: x.id, name: x.name, email: x.email, role: x.role, companyId: x.companyId, opsProfile: profile, active: true });
  }
  const svc = new ProductionsService(prisma as any, audit as any);
  const wf = new WorkflowService(prisma as any, svc);
  (svc as any).workflow = wf;
  let clock = NOW;
  svc.now = () => clock;
  wf.now = () => clock;
  return { prisma, db, svc, wf, setNow: (d: Date) => (clock = d) };
}

const FULL_BRIEF = { description: 'Campaña de prueba (datos ficticios)', dates: '2026-11-10', duration: 'Jornada completa', modelsCount: 2, deliverables: '20 fotos editadas' };

async function toProposal(w: ReturnType<typeof world>, user = BOOKER) {
  const r: any = await w.svc.create(user, { clientName: 'Marca de prueba', channel: 'WHATSAPP', isTest: true });
  const id = r.production.id;
  await w.svc.updateBrief(user, id, { brief: FULL_BRIEF });
  await w.svc.transition(user, id, { to: 'BRIEF_COMPLETO' });
  await w.svc.transition(user, id, { to: 'BUSCANDO_RECURSOS' });
  const model = await w.svc.saveResource(user, null, { kind: 'MODEL', name: 'Modelo de prueba 1' });
  const a: any = await w.svc.addAssignment(user, id, { serviceType: 'MODEL', resourceId: model.id, role: 'SELECTED', startsAt: '2026-11-10T13:00:00Z', endsAt: '2026-11-10T21:00:00Z' });
  await w.svc.transition(user, id, { to: 'PROPUESTA_EN_PREPARACION' });
  return { id, model, assignment: a };
}

const LINES = [
  { id: 'm1', category: 'MODEL', description: 'Modelo jornada (valor de prueba)', quantity: 2, unit: 'FULL_DAY', unitCost: 100, costStatus: 'ESTIMATED', unitPrice: 150, priceStatus: 'ESTIMATED', billing: 'INCLUDED' },
  { id: 'c1', category: 'CATERING', description: 'Alimentación', quantity: 1, unit: 'UNIT', unitCost: null, unitPrice: null, billing: 'TO_CONFIRM' },
];

describe('Solicitudes y brief', () => {
  it('crear: código legible, estado NUEVA, historial y tarea de brief creada por regla (ejecución real persistida)', async () => {
    const w = world();
    const r: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba', contactName: 'Contacto de prueba', channel: 'INSTAGRAM' });
    expect(r.production).toMatchObject({ code: 'PR-0001', status: 'NUEVA', channel: 'INSTAGRAM' });
    expect(r.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['created', 'task']));
    expect(r.tasks).toEqual([expect.objectContaining({ title: 'Completar el brief', origin: 'RULE', ruleKey: 'BRIEF' })]);
    expect(w.db.workflowRun).toEqual([expect.objectContaining({ kind: 'production.status', status: 'COMPLETED', attempts: 1, companyId: 'coA' })]);
    const r2: any = await w.svc.create(BOOKER, { clientName: 'Otra marca' });
    expect(r2.production.code).toBe('PR-0002');
    await expect(w.svc.create(BOOKER, { clientName: '  ' })).rejects.toThrow(/cliente/);
    await expect(w.svc.create(BOOKER, { clientName: 'x', channel: 'TIKTOK' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el brief no es obligatorio para crear; dice qué falta para completarlo y para cotizar', async () => {
    const w = world();
    const r: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    expect(r.missing.toComplete.map((m: any) => m.key)).toEqual(['description', 'dates', 'duration', 'modelsCount']);
    expect(r.missing.configStatus).toBe('PENDING');
    await expect(w.svc.transition(BOOKER, r.production.id, { to: 'BRIEF_COMPLETO' })).rejects.toThrow(/Falta en el brief/);
    const d: any = await w.svc.updateBrief(BOOKER, r.production.id, { brief: { description: 'x', dates: 'mañana', duration: 'Media jornada', modelsCount: '3', campoInventado: 'no' } });
    expect(d.brief).toMatchObject({ modelsCount: 3 });
    expect(d.brief.campoInventado).toBeUndefined();
    expect(d.missing.toComplete).toEqual([]);
    expect(d.missing.toQuote.map((m: any) => m.key)).toEqual(['deliverables']);
    expect((await w.svc.transition(BOOKER, r.production.id, { to: 'BRIEF_COMPLETO' }) as any).production.status).toBe('BRIEF_COMPLETO');
  });

  it('transiciones inválidas y las de la cotización se rechazan; repetir la misma no duplica', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    await expect(w.svc.transition(BOOKER, p.id, { to: 'CONFIRMADA' })).rejects.toThrow(/No se puede pasar/);
    await expect(w.svc.transition(BOOKER, p.id, { to: 'COTIZACION_APROBADA' })).rejects.toThrow(/desde la cotización/);
    await expect(w.svc.transition(BOOKER, p.id, { to: 'INVENTADO' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(w.svc.transition(BOOKER, p.id, { to: 'CANCELADA' })).rejects.toThrow(/motivo/);
    await w.svc.transition(BOOKER, p.id, { to: 'BRIEF_INCOMPLETO' });
    const events = w.db.productionEvent.length;
    const again: any = await w.svc.transition(BOOKER, p.id, { to: 'BRIEF_INCOMPLETO' });
    expect(again.unchanged).toBe(true);
    expect(w.db.productionEvent.length).toBe(events);
    expect(w.db.productionTask.filter((t: any) => t.ruleKey === 'BRIEF')).toHaveLength(1); // NUEVA y BRIEF_INCOMPLETO comparten la regla
  });

  it('edición simultánea con versión vieja: se rechaza sin pisar', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    await w.svc.update(BOOKER, p.id, { notes: 'cambio 1' });
    await expect(w.svc.transition(BOOKER, p.id, { to: 'BRIEF_INCOMPLETO', expectedVersion: 1 })).rejects.toBeInstanceOf(ConflictException);
  });

  it('pausar guarda el estado y reanudar vuelve a él; cancelar exige motivo y libera reservas internas', async () => {
    const w = world();
    const { id } = await toProposal(w);
    const paused: any = await w.svc.transition(BOOKER, id, { to: 'EN_PAUSA', reason: 'El cliente pidió esperar' });
    expect(paused.transitions.map((t: any) => t.status)).toContain('PROPUESTA_EN_PREPARACION');
    await w.svc.transition(BOOKER, id, { to: 'PROPUESTA_EN_PREPARACION' });
    const done: any = await w.svc.transition(BOOKER, id, { to: 'CANCELADA', reason: 'Prueba de cancelación' });
    expect(done.production).toMatchObject({ status: 'CANCELADA', closeReason: 'Prueba de cancelación' });
    await expect(w.svc.update(BOOKER, id, { notes: 'x' })).rejects.toThrow(/cerrada/);
  });

  it('desde una conversación: idempotente (la misma conversación no crea dos solicitudes)', async () => {
    const w = world();
    w.db.contact.push({ id: 'ct1', companyId: 'coA', name: 'Contacto de prueba', phone: '+570000000001' });
    w.db.conversation.push({ id: 'cv1', companyId: 'coA', contactId: 'ct1', channel: 'WHATSAPP', status: 'OPEN' });
    const a: any = await w.svc.createFromConversation(BOOKER, { conversationId: 'cv1' });
    const b: any = await w.svc.createFromConversation(BOOKER, { conversationId: 'cv1' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.production.id).toBe(a.production.id);
    expect(w.db.production).toHaveLength(1);
    expect(a.production).toMatchObject({ channel: 'WHATSAPP', clientName: 'Contacto de prueba' });
  });
});

describe('Responsables, tareas e incidencias', () => {
  it('asignar exige permiso y un usuario de la misma empresa', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    expect((await w.svc.update(BOOKER, p.id, { ownerId: 'booker' }) as any).production.ownerName).toBe('booker');
    await expect(w.svc.update(OPS, p.id, { ownerId: 'operacion' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.update(BOOKER, p.id, { ownerId: 'adminB' })).rejects.toThrow(/no es de esta empresa/);
  });

  it('tareas con dependencias: no se completa una bloqueada; las de regla no se duplican al repetir', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    const t1: any = await w.svc.createTask(BOOKER, p.id, { title: 'Pedir referencias de prueba' });
    const t2: any = await w.svc.createTask(BOOKER, p.id, { title: 'Armar moodboard', dependsOn: [t1.id], dueAt: '2026-10-24T15:00:00Z' });
    await expect(w.svc.updateTask(BOOKER, t2.id, { status: 'DONE' })).rejects.toThrow(/Bloqueada/);
    await w.svc.updateTask(BOOKER, t1.id, { status: 'DONE' });
    expect((await w.svc.updateTask(BOOKER, t2.id, { status: 'DONE' }) as any).status).toBe('DONE');
    // Repetir el motor para el mismo estado no crea otra tarea
    await w.wf.schedule('coA', 'production.status', 'status:otra-clave', { status: 'NUEVA' }, p.id);
    expect(w.db.productionTask.filter((t: any) => t.origin === 'RULE')).toHaveLength(1);
    await expect(w.svc.createTask(VIEWER, p.id, { title: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('incidencia controlada: se registra, impide cerrar y se resuelve con explicación', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    const issue: any = await w.svc.createIssue(BOOKER, p.id, { kind: 'CAMBIO_FECHA', severity: 'HIGH', description: 'Incidencia simulada: el cliente cambió la fecha' });
    await expect(w.svc.resolveIssue(BOOKER, issue.id, {})).rejects.toThrow(/cómo se resolvió/);
    const resolved: any = await w.svc.resolveIssue(BOOKER, issue.id, { resolution: 'Se reprogramó en el brief' });
    expect(resolved).toMatchObject({ status: 'RESOLVED', resolvedById: 'booker' });
    expect(w.db.productionEvent.filter((e: any) => e.type === 'issue')).toHaveLength(2);
  });
});

describe('Recursos, tarifas y disponibilidad', () => {
  it('recursos por empresa; tarifas solo con permiso y sin valores inventados', async () => {
    const w = world();
    const loc = await w.svc.saveResource(BOOKER, null, { kind: 'LOCATION', name: 'Locación propia (prueba)', owned: true, fileRefs: [{ provider: 'DROPBOX', ref: '/Locaciones/Estudio', label: 'Fotos' }] });
    expect(loc.fileRefs).toEqual([{ provider: 'DROPBOX', ref: '/Locaciones/Estudio', label: 'Fotos', verified: false }]);
    await expect(w.svc.saveResource(BOOKER, null, { kind: 'MODEL', name: 'x', fileRefs: [{ provider: 'URL', ref: 'http://inseguro' }] })).rejects.toThrow(/https/);
    await expect(w.svc.saveResource(VIEWER, null, { kind: 'MODEL', name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.addRate(BOOKER, loc.id, { kind: 'PRICE', unit: 'FULL_DAY', amount: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    const rate: any = await w.svc.addRate(FINANCE, loc.id, { kind: 'PRICE', unit: 'FULL_DAY' });
    expect(rate).toMatchObject({ amount: null, status: 'PENDING' });
    const asViewer: any[] = await w.svc.listResources(VIEWER, {});
    expect(asViewer[0]).toMatchObject({ ratesHidden: true, rates: undefined });
    const asFinance: any[] = await w.svc.listResources(FINANCE, {});
    expect(asFinance[0].rates).toHaveLength(1);
  });

  it('disponibilidad manual con nota; una retención exige vencimiento si la regla no está confirmada', async () => {
    const w = world();
    const { assignment } = await toProposal(w);
    await expect(w.svc.setAvailability(BOOKER, assignment.id, { availability: 'AVAILABLE' })).rejects.toThrow(/cómo se consultó/);
    const av: any = await w.svc.setAvailability(BOOKER, assignment.id, { availability: 'AVAILABLE', note: 'Respondió por chat (prueba)' });
    expect(av).toMatchObject({ availability: 'AVAILABLE', availabilitySource: 'MANUAL', reservation: 'NONE' }); // consultar no es reservar
    await expect(w.svc.hold(BOOKER, assignment.id, {})).rejects.toThrow(/pendiente de configurar/);
    const held: any = await w.svc.hold(BOOKER, assignment.id, { holdExpiresAt: '2026-10-25T15:00:00Z' });
    expect(held.reservation).toBe('HOLD');
    expect(w.db.productionSlotLock).toHaveLength(8);
  });

  it('dos producciones compiten por el mismo recurso y horario: solo una lo retiene', async () => {
    const w = world();
    const a = await toProposal(w);
    const p2: any = await w.svc.create(BOOKER, { clientName: 'Otra marca de prueba' });
    const b: any = await w.svc.addAssignment(BOOKER, p2.production.id, { serviceType: 'MODEL', resourceId: a.model.id, startsAt: '2026-11-10T18:00:00Z', endsAt: '2026-11-10T22:00:00Z' });
    const results = await Promise.allSettled([
      w.svc.hold(BOOKER, a.assignment.id, { holdExpiresAt: '2026-10-25T15:00:00Z' }),
      w.svc.hold(BOOKER, b.id, { holdExpiresAt: '2026-10-25T15:00:00Z' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    // Ningún candado a medias de la que perdió
    const owners = new Set(w.db.productionSlotLock.map((l: any) => l.assignmentId));
    expect(owners.size).toBe(1);
  });

  it('una retención vencida la libera el barrido y el horario queda libre para otra producción', async () => {
    const w = world();
    const a = await toProposal(w);
    await w.svc.hold(BOOKER, a.assignment.id, { holdExpiresAt: '2026-10-23T18:00:00Z' });
    w.setNow(new Date('2026-10-23T19:00:00Z'));
    const r = await w.wf.sweep();
    expect(r.holds).toBe(1);
    expect(w.db.productionAssignment.find((x: any) => x.id === a.assignment.id).reservation).toBe('RELEASED');
    expect(w.db.productionSlotLock).toHaveLength(0);
    await w.wf.sweep(); // repetir el barrido no hace nada más
    expect(w.db.workflowRun.filter((x: any) => x.kind === 'hold.expire')).toHaveLength(1);
  });

  it('confirmar un recurso: solo con permiso, después de que el cliente acepta y con evidencia', async () => {
    const w = world();
    const { id, assignment } = await toProposal(w);
    await w.svc.hold(BOOKER, assignment.id, { holdExpiresAt: '2026-10-30T15:00:00Z' });
    await expect(w.svc.confirm(BOOKER, assignment.id, { evidence: 'x' })).rejects.toThrow(/después de que el cliente acepta/);
    await expect(w.svc.confirm(VIEWER, assignment.id, { evidence: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    void id;
  });
});

describe('Cotizaciones versionadas y aprobación', () => {
  it('flujo completo: borrador, pendientes, aprobación con el rol correcto, nueva versión con diferencias e inmutabilidad', async () => {
    const w = world();
    const { id } = await toProposal(w);
    const d1: any = await w.svc.createQuote(BOOKER, id, { lines: LINES });
    const q1 = d1.quotes[0];
    expect(q1).toMatchObject({ version: 1, status: 'DRAFT' });
    expect(q1.totals).toMatchObject({ clientTotal: null, complete: false });
    await w.svc.submitQuote(BOOKER, q1.id, {});
    expect(w.db.production[0].status).toBe('COTIZACION_PENDIENTE_APROBACION');
    expect(w.db.productionTask.find((t: any) => t.ruleKey === 'APPROVE')).toMatchObject({ title: 'Aprobar la cotización (v1)' });
    // Editar no da permiso de aprobar
    await expect(w.svc.decideQuote(BOOKER, q1.id, { decision: 'APPROVE' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.decideQuote(APPROVER, q1.id, { decision: 'APPROVE' })).rejects.toThrow(/valores pendientes/);
    await expect(w.svc.decideQuote(APPROVER, q1.id, { decision: 'REJECT' })).rejects.toThrow(/por qué/);
    await w.svc.decideQuote(APPROVER, q1.id, { decision: 'REJECT', note: 'Falta definir la alimentación' });
    expect(w.db.production[0].status).toBe('PROPUESTA_EN_PREPARACION');
    const d2: any = await w.svc.createQuote(BOOKER, id, {});
    const q2 = d2.quotes[0];
    const fixed = [LINES[0], { ...LINES[1], unitPrice: 50, unitCost: 40, billing: 'CLIENT_DIRECT' }, { id: 'k1', category: 'COMMISSION', description: 'Comisión (base por confirmar, valor de prueba)', commission: { percent: 30, base: 'PRICE', appliesTo: ['m1'] }, billing: 'INCLUDED' }];
    const upd: any = await w.svc.updateQuote(BOOKER, q2.id, { lines: fixed });
    const v2 = upd.quotes.find((q: any) => q.version === 2);
    expect(v2.diff).toEqual({ added: ['k1'], removed: [], changed: [{ lineId: 'c1', fields: expect.arrayContaining(['unitCost', 'unitPrice', 'billing']) }] });
    expect(v2.totals).toMatchObject({ clientTotal: 390, clientDirect: 50, complete: true }); // 2×150 + 30 % de 300
    await w.svc.submitQuote(BOOKER, q2.id, {});
    const ok: any = await w.svc.decideQuote(APPROVER, q2.id, { decision: 'APPROVE', note: 'OK de prueba' });
    expect(ok.production).toMatchObject({ status: 'COTIZACION_APROBADA', approvedQuoteId: q2.id });
    expect(ok.quotes.find((q: any) => q.version === 2)).toMatchObject({ status: 'APPROVED', decidedByName: 'aprobador' });
    await expect(w.svc.updateQuote(BOOKER, q2.id, { lines: [] })).rejects.toThrow(/Solo se edita un borrador/);
    await expect(w.svc.decideQuote(APPROVER, q2.id, { decision: 'APPROVE' })).rejects.toThrow(/no está pendiente/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'production.quote.approve' }));
    // La vista sin permiso financiero no ve valores
    const asViewer: any = await w.svc.get(VIEWER, id);
    expect(asViewer.quotes[0].redacted).toBe(true);
    expect(asViewer.quotes[0].lines[0].unitPrice).toBeUndefined();
  });

  it('la comisión nunca se aplica sola: sin porcentaje o sin base, la línea queda pendiente', () => {
    const lines = sanitizeLines([{ id: 'a', category: 'MODEL', unitPrice: 100, billing: 'INCLUDED' }, { id: 'k', category: 'COMMISSION', commission: { appliesTo: ['a'] }, billing: 'INCLUDED' }]);
    expect(quoteTotals(lines)).toMatchObject({ clientTotal: null, complete: false, pending: [expect.objectContaining({ lineId: 'k' })] });
    expect(quoteTotals(sanitizeLines([{ id: 'a', category: 'MODEL', unitPrice: 100, billing: 'INCLUDED' }]))).toMatchObject({ clientTotal: 100, costTotal: null, margin: null });
  });

  it('de aprobada a confirmada: envío registrado (no enviado por el sistema), aceptación con evidencia y recursos confirmados', async () => {
    const w = world();
    const { id, assignment } = await toProposal(w);
    const d: any = await w.svc.createQuote(BOOKER, id, { lines: [{ ...LINES[0] }] });
    await w.svc.submitQuote(BOOKER, d.quotes[0].id, {});
    await w.svc.decideQuote(ADMIN, d.quotes[0].id, { decision: 'APPROVE' });
    await expect(w.svc.markQuoteSent(BOOKER, d.quotes[0].id, {})).rejects.toThrow(/cómo y cuándo/);
    await w.svc.markQuoteSent(BOOKER, d.quotes[0].id, { note: 'Simulación: el booker la envió por su cuenta' });
    await expect(w.svc.transition(BOOKER, id, { to: 'ACEPTADA_POR_CLIENTE' })).rejects.toThrow(/evidencia/);
    await w.svc.transition(BOOKER, id, { to: 'ACEPTADA_POR_CLIENTE', evidence: 'Mensaje de prueba del cliente' });
    await w.svc.transition(BOOKER, id, { to: 'CONFIRMACION_DE_RECURSOS_PENDIENTE' });
    await expect(w.svc.transition(BOOKER, id, { to: 'CONFIRMADA' })).rejects.toThrow(/por confirmar/);
    await w.svc.requestConfirmation(BOOKER, assignment.id, {});
    await expect(w.svc.confirm(BOOKER, assignment.id, {})).rejects.toThrow(/quién confirmó/);
    await w.svc.confirm(BOOKER, assignment.id, { evidence: 'Confirmación simulada en prueba' });
    const conf: any = await w.svc.transition(BOOKER, id, { to: 'CONFIRMADA' });
    expect(conf.production.status).toBe('CONFIRMADA');
    expect(conf.tasks.map((t: any) => t.ruleKey)).toEqual(expect.arrayContaining(['BRIEF', 'AVAILABILITY', 'PRICES', 'QUOTE', 'APPROVE', 'CONFIRM', 'LOGISTICS']));
    // No se cierra con tareas abiertas
    await w.svc.transition(BOOKER, id, { to: 'EN_PRODUCCION' });
    await w.svc.transition(BOOKER, id, { to: 'PENDIENTE_ENTREGA' });
    await expect(w.svc.transition(BOOKER, id, { to: 'CERRADA' })).rejects.toThrow(/tarea\(s\)/);
    for (const t of w.db.productionTask.filter((x: any) => x.status !== 'DONE')) await w.svc.updateTask(BOOKER, t.id, { status: 'DONE' });
    expect((await w.svc.transition(BOOKER, id, { to: 'CERRADA' }) as any).production.status).toBe('CERRADA');
    expect(w.db.productionEvent.every((e: any) => e.companyId === 'coA')).toBe(true);
  });
});

describe('Motor de Automation', () => {
  it('reintentos limitados con espera, error guardado y evento al agotarse', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    const run: any = await w.wf.schedule('coA', 'test.fail', 'test:fail:1', {}, p.id);
    expect(run).toMatchObject({ status: 'RETRYABLE', attempts: 1 });
    expect(JSON.parse(run.errorJson).message).toBe('Fallo de prueba controlado');
    expect(run.nextRetryAt.getTime()).toBeGreaterThan(NOW.getTime());
    for (let i = 0; i < 6; i++) {
      w.setNow(new Date(w.wf.now().getTime() + 61 * 60_000));
      await w.wf.sweep();
    }
    const final = w.db.workflowRun.find((r: any) => r.idempotencyKey === 'test:fail:1');
    expect(final).toMatchObject({ status: 'FAILED', attempts: 5 });
    expect(w.db.productionEvent.filter((e: any) => e.type === 'engine_error')).toHaveLength(1);
  });

  it('la misma clave no crea otra ejecución y dos workers no corren la misma a la vez', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    const a: any = await w.wf.schedule('coA', 'production.status', 'k1', { status: 'NUEVA' }, p.id);
    const b: any = await w.wf.schedule('coA', 'production.status', 'k1', { status: 'NUEVA' }, p.id);
    expect(b.id).toBe(a.id);
    w.db.workflowRun.find((r: any) => r.id === a.id).status = 'PENDING';
    const results = await Promise.all([w.wf.execute(a.id, 'coA'), w.wf.execute(a.id, 'coA')]);
    expect(results.filter((x) => x === 'SKIPPED')).toHaveLength(1);
    // Contexto de empresa: otra empresa no puede ejecutar la de A
    w.db.workflowRun.find((r: any) => r.id === a.id).status = 'PENDING';
    expect(await w.wf.execute(a.id, 'coB')).toBe('SKIPPED');
  });

  it('una ejecución abandonada (proceso caído) la retoma el barrido; una tarea vencida se marca una sola vez', async () => {
    const w = world();
    const { production: p }: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba' });
    const run: any = w.db.workflowRun[0];
    Object.assign(run, { status: 'RUNNING', lockedUntil: new Date(NOW.getTime() - 1000) });
    const t: any = await w.svc.createTask(BOOKER, p.id, { title: 'Tarea vencida de prueba', dueAt: '2026-10-22T10:00:00Z' });
    const r = await w.wf.sweep();
    expect(r.runs).toBe(1);
    expect(run.status).toBe('COMPLETED');
    await w.wf.sweep();
    expect(w.db.productionTask.find((x: any) => x.id === t.id).overdueNotifiedAt).toBeTruthy();
    expect(w.db.productionEvent.filter((e: any) => e.type === 'task_overdue')).toHaveLength(1);
    const ov: any = await w.svc.overview(BOOKER);
    expect(ov.counts.overdueTasks).toBe(1);
  });
});

describe('Aislamiento entre empresas y permisos', () => {
  it('B no puede ver, editar, mover, cotizar ni reservar nada de A aunque envíe sus ids o un companyId', async () => {
    const w = world();
    const { id, assignment } = await toProposal(w);
    const d: any = await w.svc.createQuote(BOOKER, id, { lines: LINES });
    const qid = d.quotes[0].id;
    const task: any = await w.svc.createTask(BOOKER, id, { title: 'Tarea de A' });
    const issue: any = await w.svc.createIssue(BOOKER, id, { description: 'Incidencia de A' });
    const nf = NotFoundException;
    await expect(w.svc.get(ADMIN_B, id, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.update(ADMIN_B, id, { notes: 'x' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.updateBrief(ADMIN_B, id, { brief: { description: 'x' } }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.transition(ADMIN_B, id, { to: 'CANCELADA', reason: 'x' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.createQuote(ADMIN_B, id, {}, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.updateQuote(ADMIN_B, qid, { lines: [] }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.submitQuote(ADMIN_B, qid, {}, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.decideQuote(ADMIN_B, qid, { decision: 'APPROVE' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.updateTask(ADMIN_B, task.id, { status: 'DONE' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.resolveIssue(ADMIN_B, issue.id, { resolution: 'x' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.hold(ADMIN_B, assignment.id, { holdExpiresAt: '2026-10-30T00:00:00Z' }, 'coA')).rejects.toBeInstanceOf(nf);
    await expect(w.svc.addAssignment(ADMIN_B, id, { serviceType: 'MODEL' }, 'coA')).rejects.toBeInstanceOf(nf);
    // B no puede usar recursos ni conversaciones de A
    const bProd: any = await w.svc.create(ADMIN_B, { clientName: 'Marca B' });
    await expect(w.svc.addAssignment(ADMIN_B, bProd.production.id, { serviceType: 'MODEL', resourceId: w.db.productionResource[0].id })).rejects.toThrow(/no encontrado en esta empresa/);
    w.db.conversation.push({ id: 'cvA', companyId: 'coA', contactId: null, channel: 'WHATSAPP' });
    await expect(w.svc.createFromConversation(ADMIN_B, { conversationId: 'cvA' }, 'coA')).rejects.toBeInstanceOf(nf);
    // Listados, inicio, catálogo, equipo y motor: solo lo propio
    expect((await w.svc.list(ADMIN_B, { companyId: 'coA', includeTest: 'true' })).items.map((x: any) => x.clientName)).toEqual(['Marca B']);
    expect((await w.svc.overview(ADMIN_B, 'coA')).counts.open).toBe(1);
    expect(await w.svc.listResources(ADMIN_B, { companyId: 'coA' })).toEqual([]);
    expect((await w.svc.team(ADMIN_B, 'coA')).users.map((x: any) => x.id)).toEqual(['adminB']);
    expect((await w.svc.runs(ADMIN_B, { companyId: 'coA' })).every((r: any) => r.companyId === 'coB')).toBe(true);
    await expect(w.svc.setProfile(ADMIN_B, 'booker', { profile: 'BOOKER' }, 'coA')).rejects.toBeInstanceOf(nf);
    // Plataforma sí elige empresa
    expect((await w.svc.list(DEV, { companyId: 'coA', includeTest: 'true' })).total).toBe(1);
  });

  it('consulta solo lee; el rol de área no entra; cada operación crítica exige su permiso', async () => {
    const w = world();
    const { id } = await toProposal(w);
    await expect(w.svc.get(VIEWER, id)).resolves.toBeTruthy();
    await expect(w.svc.update(VIEWER, id, { notes: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.transition(VIEWER, id, { to: 'EN_PAUSA', reason: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.createQuote(VIEWER, id, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.createQuote(FINANCE, id, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.saveSettings(BOOKER, { config: {} })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.setProfile(BOOKER, 'consulta', { profile: 'BOOKER' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.svc.list(AREA, {})).rejects.toThrow(/no tiene acceso/);
    // El administrador da perfiles, pero no «administración» a un usuario de consulta
    await expect(w.svc.setProfile(ADMIN, 'consulta', { profile: 'ADMIN' })).rejects.toThrow(/administrador/);
    await w.svc.setProfile(ADMIN, 'consulta', { profile: 'BOOKER' });
    await expect(w.svc.update(VIEWER, id, { notes: 'ahora sí' })).resolves.toBeTruthy();
    await expect(w.svc.setProfile(ADMIN, 'admin', { profile: 'VIEWER' })).rejects.toThrow(/acceso total/);
  });

  it('sin BackOffice Automation los endpoints responden 403', async () => {
    const w = world();
    w.db.company[0].productsJson = JSON.stringify({ AUTOMATION: { enabled: false }, CREATIVE: { enabled: true }, ADS: { enabled: false } });
    const guard = new ProductsGuard(new Reflector(), w.prisma as any);
    const ctx = { getHandler: () => (ProductionsController.prototype as any).list, getClass: () => ProductionsController, switchToHttp: () => ({ getRequest: () => ({ user: ADMIN }) }) } as any;
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('Configuración e integraciones', () => {
  it('nada comercial por defecto; la duración de retenciones se usa solo cuando se confirma', async () => {
    const w = world();
    const s: any = await w.svc.getSettings(ADMIN);
    expect(s.config.commercial.commission).toMatchObject({ status: 'PENDING' });
    expect(s.config.availability.holdHours.status).toBe('PENDING');
    await w.svc.saveSettings(ADMIN, { config: { availability: { holdHours: { status: 'CONFIRMED', value: 48, note: 'Confirmado en reunión (prueba)' } } } });
    const { assignment } = await toProposal(w);
    const held: any = await w.svc.hold(BOOKER, assignment.id, {});
    expect(new Date(held.holdExpiresAt).getTime()).toBe(NOW.getTime() + 48 * 3600e3);
  });

  it('integraciones con evidencia: sin líneas no hay WhatsApp; Dropbox y Lead Ads no existen; la demo no cuenta como real', async () => {
    const w = world();
    w.db.adAccount.push({ id: 'ad1', companyId: 'coA', provider: 'META', mode: 'DEMO', name: 'Demo', status: 'CONNECTED' });
    const r = await integrationsReport(w.prisma as any, 'coA');
    const by = Object.fromEntries(r.map((x) => [x.key, x.readiness]));
    expect(by).toMatchObject({ whatsapp: 'NOT_CONFIGURED', meta_ads: 'NOT_CONFIGURED', dropbox: 'NOT_IMPLEMENTED', lead_ads: 'NOT_IMPLEMENTED', google_calendar: 'NOT_CONFIGURED' });
    const v = await validateWhatsapp(w.prisma as any, 'coA');
    expect(v.checks[0]).toEqual({ check: 'Hay al menos una línea registrada', ok: false });
    // Una producción manual funciona aunque no haya ningún canal conectado
    const p: any = await w.svc.create(BOOKER, { clientName: 'Marca de prueba', channel: 'WHATSAPP' });
    expect(p.production.channel).toBe('WHATSAPP');
  });

  it('tramos por hora para el candado', () => {
    expect(hourSlots(new Date('2026-11-10T13:30:00Z'), new Date('2026-11-10T15:00:00Z')).map((d) => d.toISOString())).toEqual(['2026-11-10T13:00:00.000Z', '2026-11-10T14:00:00.000Z']);
  });
});
