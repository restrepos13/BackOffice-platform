/**
 * Fase 4 · Omnichannel Inbox: aislamiento, roles, asignación, notas internas,
 * recepción y envío (con mocks: NUNCA sale un mensaje real), webhooks
 * repetidos y fuera de orden, resultados ambiguos, modo humano/bot,
 * ventana de 24 h y plantillas, estados de canal, respuestas rápidas,
 * eventos en vivo, paginación y filtros, y asociación con contactos.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConversationsController, ConversationsService } from '../src/modules/conversations.module';
import { TwilioService } from '../src/modules/twilio.module';
import { WebhooksService } from '../src/modules/webhooks.module';
import { PromotionsService } from '../src/modules/promotions.module';
import { messagingWindow, templateVariables } from '../src/common/inbox/window';
import { channelState } from '../src/common/inbox/channel-status';
import { SendError, classifySendError, sanitizeError, shouldApplyStatus } from '../src/common/inbox/delivery';
import { encryptSecret } from '../src/common/crypto';
import { ROLES_KEY } from '../src/auth/decorators';
import { createMockPrisma } from './helpers/mock-prisma';

const ADMIN_A = { id: 'uA', name: 'Ana', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const ADMIN_A2 = { id: 'uA2', name: 'Beto', email: 'b@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const VIEWER_A = { id: 'uV', name: 'Vera', email: 'v@a.co', role: 'COMPANY_VIEWER' as const, companyId: 'coA' };
const AREA_A = { id: 'uR', name: 'Área', email: 'r@a.co', role: 'COMPANY_AREA' as const, companyId: 'coA' };
const ADMIN_B = { id: 'uB', name: 'Bruno', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const META_TOKEN = 'EAAG'.padEnd(40, 'z');

function world() {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  const audit = { log: jest.fn(async () => undefined) };
  const events = { emit: jest.fn() };
  const outbound = { enqueueOutbound: jest.fn(async () => undefined) };
  db.company.push(
    { id: 'coA', name: 'Aurora', slug: 'aurora', orderConfigJson: '{}', waTemplatesJson: JSON.stringify([{ key: 'retomar', name: 'Retomar', contentSid: 'HX1', category: 'UTILIDAD', body: 'Hola {{1}}, ¿seguimos con tu pedido {{2}}?' }]) },
    { id: 'coB', name: 'Otra', slug: 'otra', orderConfigJson: '{}', waTemplatesJson: '[]' },
  );
  db.user.push(
    { id: 'uA', name: 'Ana', companyId: 'coA', role: 'COMPANY_ADMIN', active: true },
    { id: 'uA2', name: 'Beto', companyId: 'coA', role: 'COMPANY_ADMIN', active: true },
    { id: 'uV', name: 'Vera', companyId: 'coA', role: 'COMPANY_VIEWER', active: true },
    { id: 'uOff', name: 'Inactivo', companyId: 'coA', role: 'COMPANY_ADMIN', active: false },
    { id: 'uB', name: 'Bruno', companyId: 'coB', role: 'COMPANY_ADMIN', active: true },
  );
  db.integration.push(
    { id: 'twA', companyId: 'coA', type: 'WHATSAPP', name: 'WhatsApp Twilio', configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }) },
    { id: 'metaA', companyId: 'coA', type: 'WHATSAPP', name: 'WhatsApp Cloud', configJson: JSON.stringify({ provider: 'META', phoneNumberId: '1099', accessTokenEnc: encryptSecret(META_TOKEN) }) },
    { id: 'igA', companyId: 'coA', type: 'INSTAGRAM', name: 'Instagram', configJson: '{}' },
  );
  const convs = new ConversationsService(prisma as any, audit as any, events as any, outbound as any);
  return { prisma, db, audit, events, outbound, convs };
}

/** Conversación con un mensaje del cliente hace `hoursAgo` horas. */
function chat(db: any, id: string, o: Record<string, any> = {}, hoursAgo = 1) {
  const contactId = `ct_${id}`;
  db.contact.push({ id: contactId, companyId: o.companyId ?? 'coA', name: o.name ?? `Cliente ${id}`, phone: o.phone ?? `+5730000${id.padStart(5, '0')}`, stage: 'CURIOSO', externalId: o.externalId });
  db.conversation.push({
    id, companyId: 'coA', contactId, integrationId: 'twA', channel: 'WHATSAPP', status: 'OPEN', botPaused: false, needsAttention: false,
    unreadCount: 0, lastMessageAt: new Date(Date.now() - hoursAgo * 3600e3), createdAt: new Date(), ...o,
  });
  db.message.push({ id: `in_${id}`, conversationId: id, direction: 'IN', author: 'CONTACT', content: o.text ?? 'hola', type: 'TEXT', createdAt: new Date(Date.now() - hoursAgo * 3600e3) });
}

describe('Inbox · aislamiento y roles', () => {
  it('B no ve, no asigna, no anota ni reenvía en conversaciones de A, aunque mande el companyId', async () => {
    const { db, convs } = world();
    chat(db, 'c1');
    const list = await convs.inbox(ADMIN_B, { companyId: 'coA' });
    expect(list.items).toHaveLength(0);
    await expect(convs.detail(ADMIN_B, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.notes(ADMIN_B, 'c1', {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.addNote(ADMIN_B, 'c1', 'x')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.assign(ADMIN_B, 'c1', 'uB')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.window(ADMIN_B, 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.verifyChannel(ADMIN_B, 'metaA')).rejects.toBeInstanceOf(NotFoundException);
    expect(await convs.channels(ADMIN_B)).toEqual([]);
  });

  it('escribir exige rol de atención; el área de producción no entra a la bandeja', async () => {
    const roles = (m: string) => Reflect.getMetadata(ROLES_KEY, (ConversationsController.prototype as any)[m]) as string[];
    for (const m of ['assign', 'addNote', 'resend', 'verifyChannel', 'sendMessage', 'setMode']) {
      expect(roles(m)).toEqual(expect.arrayContaining(['COMPANY_ADMIN']));
      expect(roles(m)).not.toContain('COMPANY_VIEWER');
    }
    const { db, convs } = world();
    chat(db, 'c1');
    await expect(convs.inbox(AREA_A, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(convs.notes(AREA_A, 'c1', {})).rejects.toBeInstanceOf(ForbiddenException);
    // Un lector de la empresa puede ver la bandeja y las notas, no escribir
    expect((await convs.inbox(VIEWER_A, {})).items).toHaveLength(1);
  });
});

describe('Inbox · lista, filtros y paginación', () => {
  it('pagina con cursor estable y cuenta con datos reales de la empresa', async () => {
    const { db, convs } = world();
    for (let i = 0; i < 35; i++) chat(db, `c${i}`, { unreadCount: i % 5 === 0 ? 2 : 0, assignedToId: i < 3 ? 'uA' : undefined }, i);
    const p1 = await convs.inbox(ADMIN_A, {});
    expect(p1.items).toHaveLength(30);
    expect(p1.items[0].id).toBe('c0');
    const p2 = await convs.inbox(ADMIN_A, { cursor: p1.nextCursor! });
    expect(p2.items.map((c: any) => c.id)).toEqual(['c30', 'c31', 'c32', 'c33', 'c34']);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((c: any) => c.id)).size).toBe(35);
    expect(p1.counts).toEqual({ unread: 7, mine: 3, unassigned: 32, attention: 0 });
    expect(p1.items[0].assignedToName).toBe('Ana');
    await expect(convs.inbox(ADMIN_A, { cursor: 'basura|x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filtra por canal, modo, responsable, no leídos, estado y busca por nombre, teléfono o identificador', async () => {
    const { db, convs } = world();
    chat(db, 'w1', { name: 'Laura Gómez', phone: '+573001112233', assignedToId: 'uA', unreadCount: 1 });
    chat(db, 'i1', { channel: 'INSTAGRAM', integrationId: 'igA', name: 'Pedro', botPaused: true, externalId: 'INSTAGRAM:IGSID_77' });
    chat(db, 'r1', { status: 'RESOLVED', name: 'Resuelta' });
    const ids = async (f: Record<string, string>) => (await convs.inbox(ADMIN_A, f)).items.map((c: any) => c.id).sort();
    expect(await ids({ channel: 'instagram' })).toEqual(['i1']);
    expect(await ids({ mode: 'HUMAN' })).toEqual(['i1']);
    expect(await ids({ assignee: 'me' })).toEqual(['w1']);
    expect(await ids({ assignee: 'none' })).toEqual(['i1', 'r1']);
    expect(await ids({ unread: 'true' })).toEqual(['w1']);
    expect(await ids({ status: 'RESOLVED' })).toEqual(['r1']);
    expect(await ids({ q: 'laura' })).toEqual(['w1']);
    expect(await ids({ q: '1112233' })).toEqual(['w1']);
    expect(await ids({ q: 'IGSID_77' })).toEqual(['i1']);
    await expect(convs.inbox(ADMIN_A, { status: 'CUALQUIERA' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('el historial se lee por páginas, en orden cronológico', async () => {
    const { db, convs } = world();
    chat(db, 'c1');
    for (let i = 0; i < 120; i++) db.message.push({ id: `m${i}`, conversationId: 'c1', direction: i % 2 ? 'IN' : 'OUT', author: i % 2 ? 'CONTACT' : 'BOT', content: `${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) });
    const last = await convs.messagesPage(ADMIN_A, 'c1', {});
    expect(last.items).toHaveLength(50);
    expect(last.hasOlder).toBe(true);
    expect(last.items[last.items.length - 1].id).toBe('in_c1');
    const older = await convs.messagesPage(ADMIN_A, 'c1', { before: String(last.oldest) });
    expect(older.items).toHaveLength(50);
    expect(new Date(older.items[49].createdAt).getTime()).toBeLessThan(new Date(last.items[0].createdAt).getTime());
  });
});

describe('Inbox · asignación', () => {
  it('asigna, cambia y quita; deja auditoría y avisa en vivo sin datos sensibles', async () => {
    const { db, convs, audit, events } = world();
    chat(db, 'c1');
    expect(await convs.assign(ADMIN_A, 'c1', 'uA2')).toMatchObject({ ok: true, assignedToName: 'Beto' });
    expect(db.conversation[0]).toMatchObject({ assignedToId: 'uA2', assignedById: 'uA' });
    await convs.assign(ADMIN_A, 'c1', 'uA');
    await convs.assign(ADMIN_A, 'c1', null);
    expect(db.conversation[0].assignedToId).toBeNull();
    const details = (audit.log.mock.calls as any[]).map((c) => c[0]).filter((x) => x.action.startsWith('conversation.'));
    expect(details.map((d) => d.detail)).toEqual(['sin responsable → Beto', 'Beto → Ana', 'Ana → sin responsable']);
    expect(events.emit).toHaveBeenCalledWith('coA', { type: 'conversation.updated', conversationId: 'c1', assignedToId: 'uA2' });
    expect(await convs.assign(ADMIN_A, 'c1', null)).toMatchObject({ unchanged: true });
  });

  it('no asigna a usuarios de otra empresa, inactivos o sin rol de atención', async () => {
    const { db, convs } = world();
    chat(db, 'c1');
    await expect(convs.assign(ADMIN_A, 'c1', 'uB')).rejects.toThrow(/no pertenece/);
    await expect(convs.assign(ADMIN_A, 'c1', 'uOff')).rejects.toThrow(/inactivo/);
    await expect(convs.assign(ADMIN_A, 'c1', 'uV')).rejects.toThrow(/permiso para atender/);
    await expect(convs.assign(ADMIN_A, 'c1', 'nadie')).rejects.toThrow(/no pertenece/);
    expect((await convs.assignees(ADMIN_A)).map((u: any) => u.id).sort()).toEqual(['uA', 'uA2']);
  });
});

describe('Inbox · notas internas', () => {
  it('se guardan con autor y fecha, no crean mensajes ni salen por ningún canal, y el evento no lleva el texto', async () => {
    const { db, convs, outbound, events } = world();
    chat(db, 'c1');
    const n = await convs.addNote(ADMIN_A, 'c1', '  Pidió factura a nombre de la empresa  ');
    expect(n).toMatchObject({ companyId: 'coA', conversationId: 'c1', authorId: 'uA', authorName: 'Ana', body: 'Pidió factura a nombre de la empresa' });
    expect(db.message.filter((m: any) => m.direction === 'OUT')).toHaveLength(0);
    expect(outbound.enqueueOutbound).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('coA', { type: 'note.new', conversationId: 'c1' });
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('factura');
    expect((await convs.notes(VIEWER_A, 'c1', {})).items).toHaveLength(1);
    await expect(convs.addNote(ADMIN_A, 'c1', '   ')).rejects.toBeInstanceOf(BadRequestException);
    await expect(convs.addNote(ADMIN_A, 'c1', 'x'.repeat(2001))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Inbox · ventana de 24 h y plantillas', () => {
  it('reglas por canal y proveedor, sin ocultar restricciones', () => {
    const tw = { type: 'WHATSAPP', configJson: JSON.stringify({ provider: 'TWILIO' }) };
    const meta = { type: 'WHATSAPP', configJson: JSON.stringify({ provider: 'META' }) };
    const ig = { type: 'INSTAGRAM', configJson: '{}' };
    const recent = new Date(Date.now() - 3600e3);
    const old = new Date(Date.now() - 30 * 3600e3);
    const tpl = JSON.stringify([{ key: 'k', contentSid: 'HX', body: 'Hola {{1}} {{2}}' }, { key: 'sinsid', body: 'x' }]);
    expect(messagingWindow({ channel: 'WHATSAPP', integration: tw, lastInboundAt: recent }).mode).toBe('FREE_TEXT');
    const twOld = messagingWindow({ channel: 'WHATSAPP', integration: tw, lastInboundAt: old, waTemplatesJson: tpl });
    expect(twOld).toMatchObject({ mode: 'TEMPLATE_ONLY', templates: [{ key: 'k', variables: 2 }] });
    expect(messagingWindow({ channel: 'WHATSAPP', integration: tw, lastInboundAt: old, waTemplatesJson: '[]' }).reason).toMatch(/no tiene plantillas/);
    expect(messagingWindow({ channel: 'WHATSAPP', integration: meta, lastInboundAt: old, waTemplatesJson: tpl })).toMatchObject({ mode: 'BLOCKED', reason: expect.stringMatching(/Cloud API de Meta aún no/) });
    expect(messagingWindow({ channel: 'INSTAGRAM', integration: ig, lastInboundAt: old }).reason).toMatch(/Instagram no permite/);
    expect(messagingWindow({ channel: 'WHATSAPP', integration: null, lastInboundAt: recent }).mode).toBe('BLOCKED');
    expect(templateVariables('A {{1}} y {{3}}')).toBe(3);
  });

  it('fuera de la ventana no deja escribir texto libre; con plantilla registrada y sus variables, sí', async () => {
    const { db, convs, outbound } = world();
    chat(db, 'c1', {}, 30);
    await expect(convs.sendMessage(ADMIN_A, 'c1', 'hola de nuevo')).rejects.toThrow(/plantilla aprobada/);
    expect(db.message.filter((m: any) => m.direction === 'OUT')).toHaveLength(0);
    await expect(convs.sendMessage(ADMIN_A, 'c1', '', undefined, { key: 'inventada' })).rejects.toThrow(/no está registrada/);
    await expect(convs.sendMessage(ADMIN_A, 'c1', '', undefined, { key: 'retomar', variables: ['Laura'] })).rejects.toThrow(/2 variables/);
    const m: any = await convs.sendMessage(ADMIN_A, 'c1', '', undefined, { key: 'retomar', variables: ['Laura', '#A1'] });
    expect(m).toMatchObject({ templateKey: 'retomar', content: 'Hola Laura, ¿seguimos con tu pedido #A1?', deliveryStatus: 'QUEUED' });
    expect(outbound.enqueueOutbound).toHaveBeenCalledWith({ messageId: m.id, contentSid: 'HX1', contentVariables: { 1: 'Laura', 2: '#A1' }, metaCategory: 'UTILIDAD' });
  });

  it('una conversación resuelta no recibe mensajes hasta reabrirla; el estado solo acepta valores del modelo', async () => {
    const { db, convs } = world();
    chat(db, 'c1', { status: 'RESOLVED' });
    await expect(convs.sendMessage(ADMIN_A, 'c1', 'hola')).rejects.toThrow(/resuelta/);
    await expect(convs.updateStatus(ADMIN_A, 'c1', { status: 'BORRADO' })).rejects.toBeInstanceOf(BadRequestException);
    await convs.updateStatus(ADMIN_A, 'c1', { status: 'OPEN' });
    await expect(convs.sendMessage(ADMIN_A, 'c1', 'hola')).resolves.toMatchObject({ deliveryStatus: 'QUEUED' });
  });
});

describe('Inbox · modo humano y bot', () => {
  it('tomar la conversación registra quién y cuándo, y retira las respuestas del bot que aún no salían', async () => {
    const { db, convs, audit } = world();
    chat(db, 'c1');
    db.message.push({ id: 'bot1', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'Te ayudo…', deliveryStatus: 'QUEUED', createdAt: new Date() });
    db.message.push({ id: 'bot0', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'ya salió', deliveryStatus: 'SENT', createdAt: new Date() });
    await convs.setMode(ADMIN_A, 'c1', 'HUMAN');
    expect(db.conversation[0]).toMatchObject({ botPaused: true, attendedByName: 'Ana', modeChangedBy: 'Ana' });
    expect(db.conversation[0].modeChangedAt).toBeInstanceOf(Date);
    expect(msg(db, 'bot1').deliveryStatus).toBe('CANCELLED');
    expect(msg(db, 'bot0').deliveryStatus).toBe('SENT');
    expect((audit.log.mock.calls as any[]).some((c) => c[0].action === 'conversation.human_mode')).toBe(true);
    await convs.setMode(ADMIN_A, 'c1', 'BOT');
    expect(db.conversation[0]).toMatchObject({ botPaused: false, attendedByName: null, needsAttention: false });
  });

  it('escribir a mano toma la conversación (pausa al bot) con la misma regla', async () => {
    const { db, convs } = world();
    chat(db, 'c1');
    db.message.push({ id: 'bot1', conversationId: 'c1', direction: 'OUT', author: 'BOT', content: 'Te ayudo…', deliveryStatus: 'QUEUED', createdAt: new Date() });
    await convs.sendMessage(ADMIN_A, 'c1', 'Hola, te atiendo yo');
    expect(db.conversation[0]).toMatchObject({ botPaused: true, status: 'HANDOFF', modeChangedBy: 'Ana' });
    expect(msg(db, 'bot1').deliveryStatus).toBe('CANCELLED');
  });
});

/** TwilioService con el envío por Meta reemplazado (nunca toca la red). */
function sender(w: ReturnType<typeof world>) {
  const svc = new TwilioService(w.prisma as any, w.audit as any, {} as any, {} as any, {} as any, w.events as any);
  const calls: any[] = [];
  let next: (() => Promise<{ id: string }>) | null = null;
  svc.sendMeta = (async (input: any) => {
    calls.push(input);
    if (next) return next();
    return { id: `wamid.${calls.length}` };
  }) as any;
  return { svc, calls, respond: (fn: () => Promise<{ id: string }>) => { next = fn; } };
}

/** Mensaje por id (falla clara si no existe). */
const msg = (db: any, id: string) => { const m = db.message.find((x: any) => x.id === id); if (!m) throw new Error(`sin mensaje ${id}`); return m; };

function outMsg(db: any, id: string, conv = 'c1', o: Record<string, any> = {}) {
  db.message.push({ id, conversationId: conv, direction: 'OUT', author: 'AGENT', content: 'respuesta', deliveryStatus: 'QUEUED', createdAt: new Date(), ...o });
}

describe('Inbox · envío y ciclo de vida (con el proveedor simulado)', () => {
  it('éxito: queda SENT con el ID del proveedor; el sandbox queda SIMULATED, nunca "enviado"', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1');
    const { svc, calls } = sender(w);
    await svc.processOutbound({ messageId: 'o1' });
    expect(msg(w.db, 'o1')).toMatchObject({ deliveryStatus: 'SENT', providerId: 'wamid.1' });
    expect(calls[0]).toMatchObject({ channel: 'WHATSAPP', recipient: expect.stringMatching(/^\+57/) });
    chat(w.db, 'c2');
    outMsg(w.db, 'o2', 'c2');
    await svc.processOutbound({ messageId: 'o2' });
    expect(msg(w.db, 'o2')).toMatchObject({ deliveryStatus: 'SIMULATED', deliveryError: expect.stringMatching(/no salió/) });
    expect(calls).toHaveLength(1);
  });

  it('rechazo del proveedor: FALLIDO con el motivo, sin tokens; credenciales inválidas marcan el canal', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1');
    const { svc, respond } = sender(w);
    respond(async () => { throw classifySendError({ status: 400, message: `Meta respondió 400: número inválido access_token=${META_TOKEN}` }); });
    await svc.processOutbound({ messageId: 'o1' });
    const m = msg(w.db, 'o1');
    expect(m.deliveryStatus).toBe('FAILED');
    expect(m.deliveryError).toMatch(/número inválido/);
    expect(JSON.stringify(w.db)).not.toContain(META_TOKEN);
    expect(w.db.conversation[0].needsAttention).toBe(true);
    outMsg(w.db, 'o2');
    respond(async () => { throw classifySendError({ status: 401, code: 190, message: 'token expired' }); });
    await svc.processOutbound({ messageId: 'o2' });
    expect(channelState(w.db.integration.find((i: any) => i.id === 'metaA') as any).state).toBe('AUTH_ERROR');
  });

  it('límite del proveedor (429): vuelve a la cola y lanza para que la cola reintente; no duplica', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1');
    const { svc, respond, calls } = sender(w);
    respond(async () => { throw classifySendError({ status: 429, message: 'rate' }); });
    await expect(svc.processOutbound({ messageId: 'o1' })).rejects.toBeInstanceOf(SendError);
    expect(msg(w.db, 'o1').deliveryStatus).toBe('QUEUED');
    respond(async () => ({ id: 'wamid.ok' }));
    await svc.processOutbound({ messageId: 'o1' });
    expect(msg(w.db, 'o1')).toMatchObject({ deliveryStatus: 'SENT', providerId: 'wamid.ok' });
    await svc.processOutbound({ messageId: 'o1' });
    expect(calls).toHaveLength(2);
  });

  it('resultado ambiguo (sin respuesta): INCIERTO, no se reintenta solo; reenviar exige confirmar', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1');
    const { svc, respond, calls } = sender(w);
    respond(async () => { throw new SendError('UNCERTAIN', 'Sin respuesta de Meta: socket hang up'); });
    await svc.processOutbound({ messageId: 'o1' });
    expect(msg(w.db, 'o1').deliveryStatus).toBe('UNCERTAIN');
    expect(await svc.processOutbound({ messageId: 'o1' })).toMatchObject({ skipped: expect.stringMatching(/incierto/) });
    expect(calls).toHaveLength(1);
    await expect(w.convs.resend(ADMIN_A, 'c1', 'o1')).rejects.toThrow(/puede duplicarlo/);
    await w.convs.resend(ADMIN_A, 'c1', 'o1', true);
    expect(w.outbound.enqueueOutbound).toHaveBeenCalledWith({ messageId: 'o1' });
    expect(msg(w.db, 'o1').deliveryStatus).toBe('QUEUED');
  });

  it('un intento que se cortó a mitad (SENDING viejo) queda incierto; dos workers no envían el mismo mensaje', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1', 'c1', { deliveryStatus: 'SENDING', sendStartedAt: new Date(Date.now() - 10 * 60e3) });
    const { svc, calls } = sender(w);
    await svc.processOutbound({ messageId: 'o1' });
    expect(msg(w.db, 'o1').deliveryStatus).toBe('UNCERTAIN');
    outMsg(w.db, 'o2');
    await Promise.all([svc.processOutbound({ messageId: 'o2' }), svc.processOutbound({ messageId: 'o2' }).catch(() => undefined)]);
    expect(calls).toHaveLength(1);
  });

  it('una respuesta del bot preparada antes de que el agente tomara la conversación se retira, no se envía', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA', botPaused: true, modeChangedAt: new Date() });
    outMsg(w.db, 'b1', 'c1', { author: 'BOT', createdAt: new Date(Date.now() - 5000) });
    const { svc, calls } = sender(w);
    expect(await svc.processOutbound({ messageId: 'b1' })).toMatchObject({ cancelled: 'modo humano' });
    expect(msg(w.db, 'b1').deliveryStatus).toBe('CANCELLED');
    expect(calls).toHaveLength(0);
  });

  it('clasificación y limpieza de errores', () => {
    expect(classifySendError({ status: 403 }).outcome).toBe('AUTH');
    expect(classifySendError({ status: 400 }).outcome).toBe('REJECTED');
    expect(classifySendError({ status: 503 }).outcome).toBe('UNCERTAIN');
    expect(classifySendError(new Error('ECONNRESET')).outcome).toBe('UNCERTAIN');
    expect(sanitizeError('fallo Bearer abc.def access_token=XYZ https://u:p@host/x')).not.toMatch(/abc\.def|XYZ|u:p/);
    expect(shouldApplyStatus('READ', 'DELIVERED')).toBe(false);
    expect(shouldApplyStatus('SENT', 'SENT')).toBe(false);
    expect(shouldApplyStatus('SENT', 'READ')).toBe(true);
    expect(shouldApplyStatus('DELIVERED', 'FAILED')).toBe(false);
  });
});

describe('Inbox · recepción y webhooks', () => {
  const waBody = (id: string, from = '573001112233', text = 'hola') => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '1099' }, contacts: [{ wa_id: from, profile: { name: 'Laura' } }], messages: [{ id, from, type: 'text', text: { body: text } }] } }] }],
  });

  function hooks(w: ReturnType<typeof world>) {
    const engineQueue = { add: jest.fn(async () => undefined), getJob: jest.fn(async () => null) };
    return { engineQueue, svc: new WebhooksService(w.prisma as any, engineQueue as any, { add: jest.fn() } as any, w.events as any) };
  }

  it('dos webhooks iguales al mismo tiempo crean un solo mensaje (sin índice único)', async () => {
    const w = world();
    const { svc, engineQueue } = hooks(w);
    await Promise.all([svc.ingestWhatsapp('aurora', waBody('wamid.IN1')), svc.ingestWhatsapp('aurora', waBody('wamid.IN1')), svc.ingestWhatsapp('aurora', waBody('wamid.IN1'))]);
    expect(w.db.message.filter((m: any) => m.providerId === 'wamid.IN1')).toHaveLength(1);
    expect(w.db.contact).toHaveLength(1);
    expect(engineQueue.add).toHaveBeenCalledTimes(1);
    expect(w.events.emit).toHaveBeenCalledWith('coA', { type: 'message.new', conversationId: w.db.conversation[0].id, direction: 'IN' });
  });

  it('un mensaje de un contacto existente se asocia a él (no crea otro)', async () => {
    const w = world();
    w.db.contact.push({ id: 'ctLaura', companyId: 'coA', name: 'Laura', phone: '+573001112233', stage: 'CLIENTE' });
    const { svc } = hooks(w);
    await svc.ingestWhatsapp('aurora', waBody('wamid.IN2'));
    expect(w.db.contact).toHaveLength(1);
    expect(w.db.conversation[0].contactId).toBe('ctLaura');
    expect(w.db.contact[0].stage).toBe('CLIENTE');
  });

  it('si el procesamiento falla a mitad, el reintento del proveedor sí entra', async () => {
    const w = world();
    const { svc } = hooks(w);
    const create = w.prisma.conversation.create;
    let fail = true;
    (w.prisma.conversation as any).create = async (args: any) => {
      if (fail) { fail = false; throw new Error('Mongo no respondió'); }
      return create(args);
    };
    await expect(svc.ingestWhatsapp('aurora', waBody('wamid.IN3'))).rejects.toThrow(/Mongo/);
    await svc.ingestWhatsapp('aurora', waBody('wamid.IN3'));
    expect(w.db.message.filter((m: any) => m.providerId === 'wamid.IN3')).toHaveLength(1);
  });

  it('estados de WhatsApp Cloud: repetidos o fuera de orden no retroceden; un fallo trae el motivo; otra empresa no toca nada', async () => {
    const w = world();
    chat(w.db, 'c1', { integrationId: 'metaA' });
    outMsg(w.db, 'o1', 'c1', { deliveryStatus: 'SENT', providerId: 'wamid.OUT1' });
    const { svc } = hooks(w);
    const st = (status: string, extra: any = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.OUT1', status, ...extra }] } }] }] });
    await svc.ingestWhatsapp('aurora', st('read'));
    await svc.ingestWhatsapp('aurora', st('delivered'));
    await svc.ingestWhatsapp('aurora', st('read'));
    expect(msg(w.db, 'o1').deliveryStatus).toBe('READ');
    outMsg(w.db, 'o2', 'c1', { deliveryStatus: 'SENT', providerId: 'wamid.OUT2' });
    await svc.ingestWhatsapp('aurora', { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.OUT2', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] } }] }] });
    expect(msg(w.db, 'o2')).toMatchObject({ deliveryStatus: 'FAILED', deliveryError: 'Meta: Re-engagement message (131047)' });
    outMsg(w.db, 'o3', 'c1', { deliveryStatus: 'SENT', providerId: 'wamid.OUT3' });
    await svc.ingestWhatsapp('otra', { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.OUT3', status: 'read' }] } }] }] });
    expect(msg(w.db, 'o3').deliveryStatus).toBe('SENT');
  });
});

describe('Inbox · estado de los canales', () => {
  it('no hay "conectado" sin verificación: sandbox, sin configurar, pendiente, verificado, credenciales inválidas', async () => {
    const w = world();
    const states = Object.fromEntries((await w.convs.channels(ADMIN_A)).map((c: any) => [c.id, c.state]));
    expect(states).toEqual({ twA: 'SANDBOX', metaA: 'PENDING_VERIFICATION', igA: 'NOT_CONFIGURED' });
    const calls: string[] = [];
    w.convs.fetchImpl = async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url.split('?')[0]}`);
      return { ok: false, status: 401, json: async () => ({ error: { code: 190, message: 'Session has expired' } }) };
    };
    expect(await w.convs.verifyChannel(ADMIN_A, 'metaA')).toMatchObject({ state: 'AUTH_ERROR', label: 'Credenciales vencidas o sin permiso' });
    w.convs.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: '1099' }) });
    expect(await w.convs.verifyChannel(ADMIN_A, 'metaA')).toMatchObject({ state: 'VERIFIED' });
    // Solo lectura: ninguna llamada de envío
    expect(calls.every((c) => c.startsWith('GET ') && !c.includes('/messages'))).toBe(true);
    // La verificación no expone el token
    expect(JSON.stringify(await w.convs.channels(ADMIN_A))).not.toContain(META_TOKEN);
    expect(await w.convs.verifyChannel(ADMIN_A, 'twA')).toMatchObject({ state: 'SANDBOX' });
  });
});

describe('Inbox · respuestas rápidas', () => {
  it('por empresa, con atajo único y validación; B no toca las de A', async () => {
    const w = world();
    const promos = new PromotionsService(w.prisma as any, w.audit as any);
    const r: any = await promos.saveQuickReply(ADMIN_A, { shortcut: '/Horario', title: 'Horario', body: 'Abrimos de 8 a 6' });
    expect(r).toMatchObject({ companyId: 'coA', shortcut: 'horario' });
    await expect(promos.saveQuickReply(ADMIN_A, { shortcut: 'horario', title: 'Otro', body: 'x' })).rejects.toThrow(/Ya existe/);
    await expect(promos.saveQuickReply(ADMIN_A, { shortcut: 'x', title: '', body: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(await promos.listQuickReplies(ADMIN_B)).toEqual([]);
    await expect(promos.removeQuickReply(ADMIN_B, r.id)).rejects.toThrow();
    expect(w.db.quickReply).toHaveLength(1);
  });
});

describe('Inbox · reenvío', () => {
  it('solo mensajes fallidos o inciertos, de la misma conversación, dentro de la ventana', async () => {
    const w = world();
    chat(w.db, 'c1');
    outMsg(w.db, 'ok1', 'c1', { deliveryStatus: 'SENT' });
    outMsg(w.db, 'f1', 'c1', { deliveryStatus: 'FAILED', deliveryError: 'x' });
    await expect(w.convs.resend(ADMIN_A, 'c1', 'ok1')).rejects.toThrow(/Solo se reenvía/);
    await expect(w.convs.resend(ADMIN_A, 'otra', 'f1')).rejects.toBeInstanceOf(NotFoundException);
    await w.convs.resend(ADMIN_A, 'c1', 'f1');
    expect(msg(w.db, 'f1')).toMatchObject({ deliveryStatus: 'QUEUED', deliveryError: null });
    await expect(w.convs.resend(ADMIN_A, 'c1', 'f1')).rejects.toThrow(/Solo se reenvía/);
    void ConflictException;
  });
});
