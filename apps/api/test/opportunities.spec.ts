/**
 * Radar comercial: detección honesta en el CRM, estados que no se "resuelven"
 * con un clic, ejecución con controles, observación de resultados, contexto
 * del negocio y aislamiento entre empresas.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import { AdsService } from '../src/modules/ads.module';
import { OpportunitiesService } from '../src/modules/opportunities.module';
import { detectCrm, weekKey } from '../src/common/opportunities/crm-detectors';
import { canMove } from '../src/common/opportunities/store';
import { observeFollowUp, CAVEAT } from '../src/common/opportunities/observe';
import { createMockPrisma } from './helpers/mock-prisma';

const auditLog = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const DAY = 86400e3;
const NOW = new Date('2026-10-21T15:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

function world() {
  const { prisma, db } = createMockPrisma();
  db.company.push(
    { id: 'coA', name: 'Aurora', planId: 'p1', currency: 'COP', city: 'Medellín', onboardingJson: JSON.stringify({ businessType: 'Cafetería' }) },
    { id: 'coB', name: 'Otra', planId: 'p1', currency: 'COP' },
  );
  const ads = new AdsService(prisma as any, auditLog as any);
  const svc = new OpportunitiesService(prisma as any, auditLog as any, ads);
  svc.now = () => NOW;
  return { prisma, db, svc, ads };
}

/** CRM de A: 4 chats esperando respuesta, 1 respondido, 1 resuelto. */
function seedCrm(db: any) {
  for (let i = 1; i <= 6; i++) {
    db.contact.push({ id: `k${i}`, companyId: 'coA', name: `Cliente ${i}`, stage: 'CURIOSO', createdAt: ago(20), lastActivityAt: ago(3), optOut: false, channel: 'WHATSAPP' });
    db.conversation.push({ id: `cv${i}`, companyId: 'coA', contactId: `k${i}`, status: i === 6 ? 'RESOLVED' : 'OPEN', lastMessageAt: ago(3), createdAt: ago(20) });
    db.message.push({ id: `m${i}`, conversationId: `cv${i}`, direction: i === 5 ? 'OUT' : 'IN', content: 'hola', createdAt: ago(3) });
  }
  // Un contacto de B que nunca debe aparecer en nada de A
  db.contact.push({ id: 'kb', companyId: 'coB', name: 'Ajeno', stage: 'CURIOSO', createdAt: ago(20), lastActivityAt: ago(3) });
}

describe('Radar · detectores del CRM', () => {
  const base = { now: NOW, contacts: [], firstStage: 'CURIOSO', closedStages: new Set(['CLIENTE', 'DESCARTADO']), dormant: [], items: [] };

  it('seguimiento pendiente: solo chats cuyo último mensaje es del cliente, abiertos y de más de un día', () => {
    const conv = (id: string, dir: 'IN' | 'OUT', days: number, status = 'OPEN') => ({ id, contactId: id, status, lastMessageAt: ago(days), lastDirection: dir });
    const out = detectCrm({ ...base, conversations: [conv('a', 'IN', 2), conv('b', 'IN', 3), conv('c', 'IN', 5), conv('d', 'OUT', 2), conv('e', 'IN', 0.5), conv('f', 'IN', 2, 'RESOLVED'), conv('g', 'IN', 40)] });
    const f = out.find((o) => o.ruleKey === 'FOLLOW_UP_PENDING')!;
    expect(f.evidence).toMatchObject({ conversations: 3 });
    expect(f.action.contactIds).toEqual(['a', 'b', 'c']);
    // Lenguaje honesto: nada de ventas perdidas ni dinero
    expect(JSON.stringify(f)).not.toMatch(/perdid|\$/i);
    expect(f.impact).toBeNull();
  });

  it('por debajo de los umbrales no inventa oportunidades', () => {
    const conv = (id: string) => ({ id, contactId: id, status: 'OPEN', lastMessageAt: ago(2), lastDirection: 'IN' as const });
    expect(detectCrm({ ...base, conversations: [conv('a'), conv('b')] })).toEqual([]);
    expect(detectCrm({ ...base, conversations: [], dormant: [{ contactId: 'x', dormantDays: 90, basis: 'conversación' }, { contactId: 'y', dormantDays: 90, basis: 'conversación' }, { contactId: 'z', dormantDays: 90, basis: 'conversación' }] })).toEqual([]);
  });

  it('clientes inactivos cuentan solo si compraron; producto que crece es una hipótesis', () => {
    const out = detectCrm({
      ...base, conversations: [],
      dormant: [{ contactId: 'x', dormantDays: 60, basis: 'compra' }, { contactId: 'y', dormantDays: 70, basis: 'compra' }, { contactId: 'z', dormantDays: 80, basis: 'compra' }],
      items: [
        ...Array.from({ length: 12 }, () => ({ productName: 'Cold brew', quantity: 1, createdAt: ago(5) })),
        ...Array.from({ length: 6 }, () => ({ productName: 'Cold brew', quantity: 1, createdAt: ago(40) })),
      ],
    });
    expect(out.map((o) => o.ruleKey).sort()).toEqual(['DORMANT_CUSTOMERS', 'PRODUCT_GROWTH']);
    const g = out.find((o) => o.ruleKey === 'PRODUCT_GROWTH')!;
    expect(g.summary).toMatch(/hipótesis/);
    expect(g.evidence).toMatchObject({ units: 12, before: 6, growthPct: 100 });
  });

  it('la semana de la clave evita duplicar dentro de la misma semana', () => {
    expect(weekKey(new Date('2026-10-19T12:00:00Z'))).toBe(weekKey(new Date('2026-10-25T12:00:00Z')));
    expect(weekKey(new Date('2026-10-19T12:00:00Z'))).not.toBe(weekKey(new Date('2026-10-26T12:00:00Z')));
  });
});

describe('Radar · servicio', () => {
  it('detecta con datos reales del CRM, no duplica y, si la condición desaparece, no la da por "resuelta"', async () => {
    const { svc, db } = world();
    seedCrm(db);
    await svc.detectCrm('coA');
    expect(db.opportunity).toHaveLength(1);
    expect(db.opportunity[0]).toMatchObject({ source: 'CRM', ruleKey: 'FOLLOW_UP_PENDING', status: 'NEW', evidence: 'INITIAL' });
    await svc.detectCrm('coA');
    expect(db.opportunity).toHaveLength(1);
    // Se respondieron los chats → ya no se detecta
    for (const m of db.message) m.direction = 'OUT';
    await svc.detectCrm('coA');
    expect(db.opportunity[0].status).toBe('RESULT');
    expect(JSON.parse(db.opportunity[0].resultJson).kind).toBe('CONDITION_GONE');
  });

  it('las transiciones respetan el flujo: un clic no registra resultados', async () => {
    expect(canMove('NEW', 'RESULT')).toBe(false);
    expect(canMove('NEW', 'EXECUTED')).toBe(false);
    expect(canMove('OBSERVING', 'RESULT')).toBe(false);
    expect(canMove('NEW', 'SNOOZED')).toBe(true);
    const { svc, db } = world();
    seedCrm(db);
    await svc.detectCrm('coA');
    const id = db.opportunity[0].id;
    await expect(svc.move(A, id, { to: 'RESULT' })).rejects.toThrow(/no está permitido/);
    const snoozed = await svc.move(A, id, { to: 'SNOOZED', snoozeDays: 3 });
    expect(snoozed.status).toBe('SNOOZED');
    expect(new Date(db.opportunity[0].snoozedUntil).getTime()).toBe(NOW.getTime() + 3 * DAY);
    await svc.move(A, id, { to: 'NEW' });
    await svc.move(A, id, { to: 'DISMISSED', note: 'Ya los atendimos por teléfono' });
    const decisions = JSON.parse(db.opportunity[0].decisionsJson);
    expect(decisions.map((d: any) => d.status)).toEqual(['SNOOZED', 'NEW', 'DISMISSED']);
    expect(decisions[2]).toMatchObject({ by: 'Admin A', note: 'Ya los atendimos por teléfono' });
  });

  it('seguimiento: preparar congela la lista; actuar deja "en observación"; luego se mide sin afirmar causalidad', async () => {
    const { svc, db } = world();
    seedCrm(db);
    await svc.detectCrm('coA');
    const id = db.opportunity[0].id;
    await svc.move(A, id, { to: 'PREPARED' });
    expect(JSON.parse(db.opportunity[0].baselineJson).contactIds).toHaveLength(4);
    await expect(svc.act(A, id, {})).rejects.toThrow(/Confirma/);
    const res = await svc.act(A, id, { confirm: true, note: 'Les escribí a todos' });
    expect(res.opportunity.status).toBe('OBSERVING');
    // Antes de tiempo no se registra nada
    await svc.observe('coA');
    expect(db.opportunity[0].status).toBe('OBSERVING');
    // 8 días después: dos tuvieron actividad, uno avanzó y compró
    svc.now = () => new Date(NOW.getTime() + 8 * DAY);
    db.contact.find((c: any) => c.id === 'k1')!.lastActivityAt = new Date(NOW.getTime() + 2 * DAY);
    Object.assign(db.contact.find((c: any) => c.id === 'k2')!, { lastActivityAt: new Date(NOW.getTime() + 3 * DAY), stage: 'CLIENTE' });
    db.order.push({ id: 'o1', companyId: 'coA', contactId: 'k2', status: 'confirmado', createdAt: new Date(NOW.getTime() + 4 * DAY), deletedAt: null });
    await svc.observe('coA');
    const o = db.opportunity[0];
    expect(o.status).toBe('RESULT');
    const r = JSON.parse(o.resultJson);
    expect(r.metrics).toEqual({ listed: 4, active: 2, moved: 1, bought: 1 });
    expect(r.note).toBe(CAVEAT);
    await svc.noteResult(A, id, { note: 'Cerramos una venta de $52.000' });
    expect(JSON.parse(db.opportunity[0].resultJson).declared.note).toMatch(/52.000/);
  });

  it('pausar un anuncio exige preparación + aprobación + confirmación, y queda auditado', async () => {
    const { svc, ads, db } = world();
    await ads.connectDemo(A, {});
    const opp = db.opportunity.find((o: any) => o.ruleKey === 'SPEND_NO_RESULTS')!;
    await expect(svc.act(A, opp.id, { confirm: true })).rejects.toThrow(/apruébala/);
    await svc.move(A, opp.id, { to: 'NEEDS_APPROVAL' });
    const res = await svc.act(A, opp.id, { confirm: true });
    expect(res.demo).toBe(true);
    expect(db.opportunity.find((o: any) => o.id === opp.id)!.status).toBe('OBSERVING');
    expect(db.adActionLog.find((l: any) => l.findingId === opp.id)!.status).toBe('EXECUTED');
    expect(db.adEntity.find((e: any) => e.externalId === opp.externalId)!.status).toBe('PAUSED');
    await expect(svc.act(A, opp.id, { confirm: true })).rejects.toThrow(/ya no está abierta/);
  });

  it('B no ve, no mueve, no ejecuta ni lista contactos de oportunidades de A', async () => {
    const { svc, db } = world();
    seedCrm(db);
    await svc.detectCrm('coA');
    const id = db.opportunity[0].id;
    expect(await svc.list(B, { companyId: 'coA' })).toHaveLength(0);
    await expect(svc.move(B, id, { to: 'DISMISSED' })).rejects.toThrow(/no encontrada/);
    await expect(svc.act(B, id, { confirm: true })).rejects.toThrow(/no encontrada/);
    await expect(svc.contacts(B, id)).rejects.toThrow(/no encontrada/);
    await expect(svc.noteResult(B, id, { note: 'x' })).rejects.toThrow(/no encontrada/);
    // Aunque alguien colara un contacto ajeno en la lista, solo salen los de la empresa
    const action = JSON.parse(db.opportunity[0].actionJson);
    action.contactIds.push('kb');
    db.opportunity[0].actionJson = JSON.stringify(action);
    const list = await svc.contacts(A, id);
    expect(list.map((c: any) => c.id)).not.toContain('kb');
    // Y la vista no expone los ids, solo cuántos son
    const [v] = await svc.list(A, {});
    expect(v.action.contactIds).toBeUndefined();
    expect(v.action.contacts).toBe(5);
  });
});

describe('Radar · contexto del negocio', () => {
  it('muestra lo que se sabe con su fuente, permite corregirlo y no confunde inferencias con datos confirmados', async () => {
    const { svc } = world();
    const ctx = await svc.context(A);
    const type = ctx.known.find((k: any) => k.key === 'businessType')!;
    expect(type).toMatchObject({ value: 'Cafetería', source: 'Registro', confirmed: false });
    const after = await svc.correct(A, 'businessType', { value: 'Cafetería de especialidad' });
    expect(after.known.find((k: any) => k.key === 'businessType')).toMatchObject({ value: 'Cafetería de especialidad', source: 'Corregido por ti', confirmed: true });
    await expect(svc.correct(A, 'planId', { value: 'gratis' })).rejects.toThrow(/no se puede editar/);
    // B no ve la corrección de A
    const ctxB = await svc.context(B);
    expect(ctxB.known.find((k: any) => k.key === 'businessType')!.value).not.toBe('Cafetería de especialidad');
  });

  it('sin anuncios ni pedidos, lo primero es crear una publicación (no se exige conectar nada)', async () => {
    const { svc } = world();
    const ctx = await svc.context(A);
    expect(ctx.intents[0].key).toBe('post');
    expect(ctx.intents.find((i: any) => i.key === 'post')!.needs).toBeNull();
    expect(ctx.intents.find((i: any) => i.key === 'review_ads')!.needs).toMatch(/cuenta publicitaria/);
    expect(ctx.connections.find((c: any) => c.key === 'ads')!.why).toMatch(/Solo hace falta/);
  });

  it('registra la primera visita una sola vez y la intención elegida; rechaza eventos desconocidos', async () => {
    const { svc, db } = world();
    await svc.event(A, { type: 'visit' });
    const first = JSON.parse(db.companyContext[0].progressJson).firstVisitAt;
    svc.now = () => new Date(NOW.getTime() + DAY);
    await svc.event(A, { type: 'visit' });
    await svc.event(A, { type: 'intent', intent: 'post' });
    const p = JSON.parse(db.companyContext[0].progressJson);
    expect(p.firstVisitAt).toBe(first);
    expect(p.intents).toHaveLength(1);
    expect(JSON.parse(db.companyContext[0].preferencesJson).intent).toBe('post');
    await expect(svc.event(A, { type: 'hack' })).rejects.toThrow(/desconocido/);
  });
});

describe('Radar · observación', () => {
  it('cuenta actividad, cambios de etapa y compras de la lista, sin afirmar causalidad', () => {
    const r = observeFollowUp(
      { contactIds: ['a', 'b', 'c'], stages: { a: 'CURIOSO', b: 'CURIOSO', c: 'CURIOSO' } }, NOW,
      [{ id: 'a', stage: 'CURIOSO', lastActivityAt: ago(-1) }, { id: 'b', stage: 'CALIENTE', lastActivityAt: ago(5) }, { id: 'c', stage: 'CURIOSO', lastActivityAt: ago(5) }],
      new Set(['b']),
    );
    expect(r.metrics).toEqual({ listed: 3, active: 1, moved: 1, bought: 1 });
    expect(r.note).toMatch(/no prueba/);
  });
});

import { story } from '../src/common/opportunities/present';
import { runAssist, validateOutput } from '../src/common/ai/creative-assist';

describe('Radar · presentación (cinco preguntas)', () => {
  const base = {
    source: 'CRM', mode: 'REAL', ruleKey: 'FOLLOW_UP_PENDING', status: 'NEW', title: 'T', summary: 'Hay clientes sin respuesta.',
    explanationJson: JSON.stringify({ facts: ['4 conversaciones donde el último mensaje es del cliente'], action: 'Revisar la lista' }),
    sourcesJson: JSON.stringify(['CRM de BackOffice']), actionJson: JSON.stringify({ type: 'FOLLOW_UP' }), decisionsJson: '[]',
  };

  it('responde qué pasa, cómo lo sabemos, por qué importa y qué hacer, con datos reales', () => {
    const s = story(base, NOW);
    expect(s.what).toBe('Hay clientes sin respuesta.');
    expect(s.howWeKnow).toMatch(/^Según tus conversaciones.*4 conversaciones/);
    expect(s.whyItMatters).toMatch(/mostraron interés/);
    expect(s.next!.label).toBe('Ver a quiénes escribir');
    expect(s.next!.hint).toMatch(/no se envía nada automático/);
    expect(s.after).toBeNull();
    expect(s.dataKinds).toEqual(['CRM']);
  });

  it('distingue esperar, medido, «ya no se detecta», descartada y demostración', () => {
    const waiting = story({ ...base, status: 'OBSERVING', actedAt: NOW.toISOString() }, NOW);
    expect(waiting.after).toMatchObject({ kind: 'WAITING' });
    expect(waiting.after!.text).toMatch(/medimos qué pasó después/);
    expect(waiting.next).toBeNull();
    expect(story({ ...base, status: 'RESULT', resultJson: JSON.stringify({ kind: 'FOLLOW_UP', note: 'nota' }), resultAt: NOW }, NOW).after).toMatchObject({ kind: 'MEASURED', text: 'nota' });
    expect(story({ ...base, status: 'RESULT', resultJson: JSON.stringify({ kind: 'CONDITION_GONE' }) }, NOW).after!.kind).toBe('GONE');
    const dismissed = story({ ...base, status: 'DISMISSED', decisionsJson: JSON.stringify([{ status: 'DISMISSED', note: 'Ya los llamé' }]) }, NOW);
    expect(dismissed.after!.text).toMatch(/Ya los llamé/);
    const demo = story({ ...base, source: 'ADS', mode: 'DEMO', ruleKey: 'SPEND_NO_RESULTS' }, NOW);
    expect(demo.dataKinds).toEqual(['DEMO']);
    expect(demo.howWeKnow).toMatch(/demostración/);
    const growth = story({ ...base, ruleKey: 'PRODUCT_GROWTH', actionJson: JSON.stringify({ type: 'LINK', label: 'Crear una publicación' }) }, NOW);
    expect(growth.dataKinds).toContain('HYPOTHESIS');
  });

  it('la vista de la lista incluye la historia y los contactos traen su chat para abrirlo directo', async () => {
    const { svc, db } = world();
    seedCrm(db);
    await svc.detectCrm('coA');
    const [v] = await svc.list(A, {});
    expect(v.story.next.label).toBe('Ver a quiénes escribir');
    const contacts = await svc.contacts(A, v.id);
    expect(contacts.find((c: any) => c.id === 'k1')!.conversationId).toBe('cv1');
  });
});

describe('Radar · logros e hitos de la experiencia', () => {
  it('los logros son útiles y la primera acción y la primera intención quedan registradas una vez', async () => {
    const { svc, db } = world();
    const before = await svc.context(A);
    expect(before.steps.map((s: any) => s.key)).toEqual(['design', 'export', 'evidence', 'acted', 'result']);
    expect(before.steps.every((s: any) => !s.done)).toBe(true);
    seedCrm(db);
    await svc.detectCrm('coA');
    await svc.event(A, { type: 'visit' });
    await svc.event(A, { type: 'intent', intent: 'followup' });
    const id = db.opportunity[0].id;
    await svc.move(A, id, { to: 'PREPARED' });
    await svc.act(A, id, { confirm: true });
    const after = await svc.context(A);
    expect(after.steps.find((s: any) => s.key === 'acted')!.done).toBe(true);
    expect(after.progress.firstIntentAt).toBeTruthy();
    expect(after.progress.firstActionAt).toBeTruthy();
    expect(after.progress.minutesToFirstValue).toBe(0);
  });

  it('una intención sin datos no bloquea: lleva al paso que la habilita', async () => {
    const { svc } = world();
    const ctx = await svc.context(A);
    const f = ctx.intents.find((i: any) => i.key === 'followup')!;
    expect(f.available).toBe(false);
    expect(f.href).toBe('/app/integrations');
    expect(f.needs).toBe('Conectar WhatsApp');
    expect(ctx.intents.find((i: any) => i.key === 'recover')!.href).toBe('/app/orders');
  });
});

describe('IA · punto de integración (sin proveedor activo)', () => {
  const company = { id: 'coA', addonsJson: null };
  const fakeProvider = (output: unknown, fail = false) => ({ name: 'fake', model: 'm', complete: async () => { if (fail) throw new Error('caído'); return { output }; } });

  it('sin proveedor responde "no activada" y no toca créditos', async () => {
    const { prisma, db } = world();
    const r = await runAssist(prisma, null, { company, task: 'EXPLAIN_OPPORTUNITY', key: 'k1', payload: {} });
    expect(r).toMatchObject({ ok: false, reason: 'NOT_CONFIGURED' });
    expect(db.creativeCreditMove).toHaveLength(0);
  });

  it('salida inválida o falla del proveedor libera la reserva; salida válida la consume una sola vez', async () => {
    const { prisma, db } = world();
    expect(await runAssist(prisma, fakeProvider({ text: 'corto' }), { company, task: 'EXPLAIN_OPPORTUNITY', key: 'a', payload: {} })).toMatchObject({ reason: 'INVALID_OUTPUT' });
    expect(await runAssist(prisma, fakeProvider(null, true), { company, task: 'EXPLAIN_OPPORTUNITY', key: 'b', payload: {} })).toMatchObject({ reason: 'PROVIDER_ERROR' });
    const ok = await runAssist(prisma, fakeProvider({ text: 'Una explicación suficientemente larga para ser útil.' }), { company, task: 'EXPLAIN_OPPORTUNITY', key: 'c', payload: {} });
    expect(ok).toMatchObject({ ok: true });
    const kinds = db.creativeCreditMove.map((m: any) => `${m.idempotencyKey}:${m.kind}`);
    expect(kinds).toEqual(expect.arrayContaining(['a:RESERVE', 'a:release:RELEASE', 'b:RESERVE', 'b:release:RELEASE', 'c:RESERVE', 'c:commit:COMMIT']));
    // Reintentar la misma clave no vuelve a procesar ni a cobrar
    expect(await runAssist(prisma, fakeProvider({ text: 'Una explicación suficientemente larga para ser útil.' }), { company, task: 'EXPLAIN_OPPORTUNITY', key: 'c', payload: {} })).toMatchObject({ ok: false });
  });

  it('las variantes repetidas no cuentan', () => {
    expect(validateOutput('COPY_VARIANTS', { variants: ['Hola mundo', 'hola mundo', 'HOLA MUNDO'] })).toBeNull();
    expect(validateOutput('COPY_VARIANTS', { variants: ['Desayuno hoy', 'Café de origen', 'desayuno hoy'] })).toEqual(['Desayuno hoy', 'Café de origen']);
  });
});
