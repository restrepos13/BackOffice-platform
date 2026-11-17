/**
 * Correcciones de la auditoría de escala (17-nov-2026). Cada prueba fija el
 * comportamiento que se corrigió: que nada vuelva a recorrer los datos de
 * todas las empresas, que el webhook no pierda mensajes, que el login no
 * bloquee el servidor y que la IA tenga tiempo límite.
 */
import 'reflect-metadata';
import { ServiceUnavailableException } from '@nestjs/common';
import * as bcryptjs from 'bcryptjs';
import { verify as nativeVerify } from '@node-rs/bcrypt';
import { createMockPrisma } from './helpers/mock-prisma';
import { ContactsService } from '../src/modules/contacts.module';
import { WebhooksController, WebhooksService } from '../src/modules/webhooks.module';
import { AuthService, BCRYPT_COST } from '../src/auth/auth.service';
import { companyConversationIds, companyMessages, countCompanyMessages } from '../src/common/inbox/company-messages';
import { DeepInfraProvider, aiTimeoutMs } from '../src/ai/deepinfra.provider';
import { engineConcurrency } from '../src/modules/engine.module';

const ADMIN_A = { id: 'uA', name: 'Ana', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const SUPER = { id: 'uS', name: 'Santi', email: 's@b.co', role: 'SUPER_ADMIN' as const, companyId: null };

function world() {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
  db.company.push(
    { id: 'coA', name: 'Aurora', slug: 'aurora', orderConfigJson: '{}', waTemplatesJson: '[]' },
    { id: 'coB', name: 'Otra', slug: 'otra', orderConfigJson: '{}', waTemplatesJson: '[]' },
  );
  return { prisma, db };
}

describe('Contactos · conteo de conversaciones sin recorrer la plataforma', () => {
  function seed(db: any) {
    db.contact.push(
      { id: 'a1', companyId: 'coA', name: 'Ana', tagsJson: '[]', lastActivityAt: new Date('2026-11-10') },
      { id: 'a2', companyId: 'coA', name: 'Beto', tagsJson: '[]', lastActivityAt: new Date('2026-11-12') },
      { id: 'b1', companyId: 'coB', name: 'De otra', tagsJson: '[]', lastActivityAt: new Date('2026-11-11') },
    );
    db.conversation.push(
      { id: 'c1', companyId: 'coA', contactId: 'a1' },
      { id: 'c2', companyId: 'coA', contactId: 'a1' },
      { id: 'c3', companyId: 'coA', contactId: 'a2' },
      // Dato corrupto a propósito: una conversación de B que apunta a un contacto de A no se cuenta
      { id: 'c4', companyId: 'coB', contactId: 'a1' },
      { id: 'c5', companyId: 'coB', contactId: 'b1' },
    );
  }

  it('cuenta las conversaciones de cada contacto, solo de su empresa, y en el mismo orden de siempre', async () => {
    const { prisma, db } = world();
    seed(db);
    const svc = new ContactsService(prisma as any, { log: jest.fn() } as any);
    const rows = await svc.list(ADMIN_A);
    expect(rows.map((r: any) => [r.id, r._count.conversations])).toEqual([['a2', 1], ['a1', 2]]);
    expect(JSON.stringify(rows)).not.toContain('De otra');
  });

  it('la consulta de conteo filtra por empresa y por los contactos de la página (usa el índice [companyId, contactId])', async () => {
    const { prisma, db } = world();
    seed(db);
    const spy = jest.spyOn(prisma.conversation, 'findMany');
    const svc = new ContactsService(prisma as any, { log: jest.fn() } as any);
    await svc.list(SUPER, 'coB');
    expect(spy).toHaveBeenCalledWith({ where: { companyId: { in: ['coB'] }, contactId: { in: ['b1'] } }, select: { contactId: true } });
  });

  it('el esquema declara los índices de Contact que necesitan el listado, el webhook y los formularios', () => {
    const schema = require('fs').readFileSync(require('path').join(__dirname, '../prisma/schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model Contact {'), schema.indexOf('}', schema.indexOf('model Contact {')));
    for (const idx of ['[companyId, lastActivityAt(sort: Desc)]', '[companyId, phone]', '[companyId, externalId]', '[companyId, email]', '[companyId, stage, lastActivityAt(sort: Desc)]', '[companyId, createdAt(sort: Desc)]']) {
      expect(model).toContain(`@@index(${idx})`);
    }
  });
});

describe('Reportes · mensajes de una empresa en dos pasos', () => {
  it('devuelve solo los mensajes de la empresa, con filtros combinados y fechas', async () => {
    const { prisma, db } = world();
    db.conversation.push({ id: 'cA1', companyId: 'coA' }, { id: 'cA2', companyId: 'coA' }, { id: 'cB1', companyId: 'coB' });
    const d = (s: string) => new Date(`2026-11-${s}T12:00:00Z`);
    db.message.push(
      { id: 'm1', conversationId: 'cA1', direction: 'OUT', metaCategory: 'service', metaCostUsd: 0, createdAt: d('10') },
      { id: 'm2', conversationId: 'cA2', direction: 'OUT', metaCategory: 'marketing', metaCostUsd: 0.05, createdAt: d('12') },
      { id: 'm3', conversationId: 'cA2', direction: 'OUT', metaCategory: null, createdAt: d('12') },
      { id: 'm4', conversationId: 'cA1', direction: 'IN', createdAt: d('12') },
      { id: 'm5', conversationId: 'cB1', direction: 'OUT', metaCategory: 'marketing', metaCostUsd: 0.05, createdAt: d('12') },
    );
    expect((await companyConversationIds(prisma, 'coA')).sort()).toEqual(['cA1', 'cA2']);
    const out = await companyMessages(prisma, 'coA', { direction: 'OUT', metaCategory: { $ne: null }, createdAt: { $gte: d('11'), $lt: d('13') } }, ['metaCategory', 'metaCostUsd', 'createdAt']);
    expect(out).toEqual([{ id: 'm2', metaCategory: 'marketing', metaCostUsd: 0.05, createdAt: d('12') }]);
    expect(await countCompanyMessages(prisma, 'coA', { createdAt: { $gte: d('11') } })).toBe(3);
    expect(await countCompanyMessages(prisma, 'coB', {})).toBe(1);
    expect(await companyMessages(prisma, 'coA', { metaCostUsd: { $gt: 0 } }, ['metaCostUsd'])).toEqual([{ id: 'm2', metaCostUsd: 0.05 }]);
    expect(await companyMessages(prisma, 'coA', {}, ['conversationId'], { limit: 2 })).toHaveLength(2);
    expect(await companyMessages(prisma, 'sin-conversaciones', {}, ['id'])).toEqual([]);
    expect(await countCompanyMessages(prisma, 'sin-conversaciones', {})).toBe(0);
  });

  it('usa $in nativo (no el $or de Prisma) y parte las listas enormes', async () => {
    const ids = Array.from({ length: 120_001 }, (_, i) => `c${i}`);
    const calls: any[] = [];
    const prisma: any = {
      conversation: { findMany: async () => ids.map((id) => ({ id })) },
      message: { aggregateRaw: async ({ pipeline }: any) => { calls.push(pipeline); return [{ n: 1 }]; } },
    };
    expect(await countCompanyMessages(prisma, 'grande', { createdAt: { $gte: new Date('2026-11-01T00:00:00Z') } })).toBe(3);
    expect(calls.map((p) => p[0].$match.conversationId.$in.length)).toEqual([50_000, 50_000, 20_001]);
    expect(calls[0][0].$match.createdAt).toEqual({ $gte: { $date: '2026-11-01T00:00:00.000Z' } });
  });

  it('aguanta cientos de miles de filas sin desbordar la pila', async () => {
    const many = Array.from({ length: 300_000 }, (_, i) => ({ _id: `m${i}`, metaCostUsd: 0 }));
    const prisma: any = { conversation: { findMany: async () => [{ id: 'c1' }] }, message: { aggregateRaw: async () => many } };
    expect(await companyMessages(prisma, 'grande', {}, ['metaCostUsd'])).toHaveLength(300_000);
  });

  it('ningún reporte vuelve a filtrar mensajes por la relación conversation.companyId', () => {
    const fs = require('fs');
    const path = require('path');
    const files = ['reports.module.ts', 'ops.module.ts', 'aiusage.module.ts', 'whatsapp-meta.module.ts', 'subscriptions.module.ts'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(__dirname, '../src/modules', f), 'utf8');
      const blocks = src.split('prisma.message.').slice(1).map((b: string) => b.slice(0, 400));
      for (const b of blocks) expect(b).not.toMatch(/conversation:\s*\{\s*companyId/);
    }
  });
});

describe('Webhook · un fallo pide reintento en vez de perder el mensaje', () => {
  const waBody = (id: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '1099' }, contacts: [{ wa_id: '573001112233', profile: { name: 'Laura' } }], messages: [{ id, from: '573001112233', type: 'text', text: { body: 'hola' } }] } }] }],
  });

  function setup() {
    const w = world();
    w.db.integration.push({ id: 'lineA', companyId: 'coA', type: 'WHATSAPP', configJson: JSON.stringify({ phoneNumberId: '1099' }) });
    const engineQueue = { add: jest.fn(async () => undefined), getJob: jest.fn(async () => null) };
    const svc = new WebhooksService(w.prisma as any, engineQueue as any, { add: jest.fn() } as any, { emit: jest.fn() } as any);
    jest.spyOn(svc, 'assertSignature').mockResolvedValue(undefined as any);
    return { ...w, svc, ctl: new WebhooksController(svc), engineQueue };
  }

  it('si guardar falla responde 503 (Meta reintenta), registra el incidente y el reintento guarda el mensaje una sola vez', async () => {
    const { ctl, db, prisma } = setup();
    const create = prisma.message.create;
    let fail = true;
    (prisma.message as any).create = async (args: any) => {
      if (fail) { fail = false; throw new Error('Mongo no respondió'); }
      return create(args);
    };
    const req = { rawBody: Buffer.from('{}') } as any;
    await expect(ctl.ingest('aurora', waBody('wamid.R1'), req, 'sha256=x')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(db.incident.some((i: any) => i.kind === 'INBOUND_FAILED' && /Mongo no respondió/.test(i.detail))).toBe(true);
    expect(db.message).toHaveLength(0);
    // Meta reintenta el mismo aviso: entra, una sola vez
    await expect(ctl.ingest('aurora', waBody('wamid.R1'), req, 'sha256=x')).resolves.toMatchObject({ ok: true, stored: 1 });
    await expect(ctl.ingest('aurora', waBody('wamid.R1'), req, 'sha256=x')).resolves.toMatchObject({ ok: true, stored: 0 });
    expect(db.message.filter((m: any) => m.providerId === 'wamid.R1')).toHaveLength(1);
  });

  it('una empresa desconocida sigue respondiendo 200 (no hay nada que reintentar)', async () => {
    const { ctl } = setup();
    await expect(ctl.ingest('no-existe', waBody('wamid.X'), { rawBody: Buffer.from('{}') } as any, 'sha256=x')).resolves.toEqual({ ok: false });
  });
});

describe('Login · hash nativo, mismo costo, compatible con lo guardado', () => {
  it('las contraseñas guardadas con bcryptjs siguen validando y las nuevas son bcrypt estándar de costo 12', async () => {
    const old = bcryptjs.hashSync('Clave-Vieja-123', 10);
    expect(await nativeVerify('Clave-Vieja-123', old)).toBe(true);
    expect(await nativeVerify('otra', old)).toBe(false);
    const fresh = await AuthService.hashPassword('Clave-Nueva-123');
    expect(fresh.startsWith(`$2b$${BCRYPT_COST}$`)).toBe(true);
    expect(bcryptjs.compareSync('Clave-Nueva-123', fresh)).toBe(true); // reversible a la librería anterior si hiciera falta
  });

  it('el login funciona con un hash viejo y un correo inexistente responde lo mismo', async () => {
    const users: any[] = [{ id: 'u1', email: 'admin@test.co', name: 'Admin', role: 'COMPANY_ADMIN', companyId: 'coA', active: true, failedLogins: 0, lockedUntil: null, passwordHash: bcryptjs.hashSync('Correcta-123', 4), company: null }];
    const prisma: any = {
      user: {
        findUnique: async ({ where }: any) => users.find((u) => u.email === where.email) ?? null,
        update: async ({ where, data }: any) => Object.assign(users.find((u) => u.id === where.id), data),
      },
    };
    const auth = new AuthService(prisma, { signAsync: async () => 't' } as any, { log: jest.fn() } as any);
    jest.spyOn(auth as any, 'issue').mockResolvedValue({ token: 't' });
    await expect(auth.login('admin@test.co', 'Correcta-123')).resolves.toEqual({ token: 't' });
    await expect(auth.login('nadie@test.co', 'Correcta-123')).rejects.toThrow('Credenciales inválidas');
    await expect(auth.login('admin@test.co', 'Mala-123')).rejects.toThrow('Credenciales inválidas');
  });

  it('la comparación no bloquea el servidor: 8 logins a la vez dejan correr el resto', async () => {
    const hashed = await AuthService.hashPassword('Clave-Ocupada-123');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const start = Date.now();
    await Promise.all(Array.from({ length: 8 }, () => nativeVerify('x', hashed)));
    clearInterval(timer);
    const elapsed = Date.now() - start;
    // Si bloqueara el hilo principal, el intervalo casi no correría durante la espera
    expect(ticks).toBeGreaterThan((elapsed / 10) * 0.5);
  }, 30_000);
});

describe('IA · tiempo límite y concurrencia del motor', () => {
  const OLD = process.env;
  afterEach(() => { process.env = OLD; jest.restoreAllMocks(); });

  it('el tiempo límite es configurable dentro de un rango seguro', () => {
    process.env = { ...OLD, AI_TIMEOUT_MS: '' };
    expect(aiTimeoutMs()).toBe(45_000);
    process.env.AI_TIMEOUT_MS = '20000';
    expect(aiTimeoutMs()).toBe(20_000);
    process.env.AI_TIMEOUT_MS = '10';
    expect(aiTimeoutMs()).toBe(45_000);
  });

  it('un proveedor que no responde falla como 504 al cumplirse el límite', async () => {
    process.env = { ...OLD, AI_TIMEOUT_MS: '5000' };
    jest.spyOn(global, 'fetch').mockImplementation((_u: any, init: any) => new Promise((_ok, fail) => {
      init.signal.addEventListener('abort', () => fail(init.signal.reason));
    }) as any);
    const t = Date.now();
    await expect(new DeepInfraProvider().chat({ apiKey: 'di_llave', model: 'm', temperature: 0, maxTokens: 10, messages: [{ role: 'user', content: 'hola' }] }))
      .rejects.toMatchObject({ providerStatus: 504 });
    expect(Date.now() - t).toBeLessThan(8_000);
  }, 15_000);

  it('el motor atiende varias conversaciones a la vez (configurable, 1 a 32)', () => {
    process.env = { ...OLD, ENGINE_CONCURRENCY: '' };
    expect(engineConcurrency()).toBe(4);
    process.env.ENGINE_CONCURRENCY = '10';
    expect(engineConcurrency()).toBe(10);
    process.env.ENGINE_CONCURRENCY = '500';
    expect(engineConcurrency()).toBe(4);
  });
});

describe('Integraciones · conteo de conversaciones por línea sin recorrer la plataforma', () => {
  it('cuenta solo las conversaciones de la línea dentro de su empresa', async () => {
    const { IntegrationsService } = require('../src/modules/integrations.module');
    const { prisma, db } = world();
    db.integration.push({ id: 'lA', companyId: 'coA', type: 'WHATSAPP', name: 'Línea A', configJson: '{}', createdAt: new Date('2026-11-01') });
    db.conversation.push(
      { id: 'c1', companyId: 'coA', integrationId: 'lA' }, { id: 'c2', companyId: 'coA', integrationId: 'lA' },
      { id: 'c3', companyId: 'coA', integrationId: null }, { id: 'c4', companyId: 'coB', integrationId: 'lA' },
    );
    const spy = jest.spyOn(prisma.conversation, 'aggregateRaw');
    const svc = new IntegrationsService(prisma as any, { log: jest.fn() } as any);
    const [line] = await svc.list(ADMIN_A);
    expect(line._count).toEqual({ conversations: 2 });
    expect(spy).toHaveBeenCalledWith({ pipeline: [{ $match: { companyId: 'coA', integrationId: 'lA' } }, { $count: 'n' }] });
  });

  it('los asistentes cuentan sus conversaciones igual, dentro de su empresa', async () => {
    const { BotsService } = require('../src/modules/bots.module');
    const { prisma, db } = world();
    db.bot.push({ id: 'bA', companyId: 'coA', name: 'Asistente', createdAt: new Date('2026-11-01') });
    db.conversation.push({ id: 'c1', companyId: 'coA', botId: 'bA' }, { id: 'c2', companyId: 'coB', botId: 'bA' });
    const svc = new BotsService(prisma as any, { log: jest.fn() } as any);
    const [bot] = await svc.list(ADMIN_A);
    expect(bot._count).toEqual({ conversations: 1 });
  });
});
