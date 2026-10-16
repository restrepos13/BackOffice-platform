/**
 * Pruebas — Dev Tools ampliado: tablero de salud (colas, settings checklist),
 * simulador de mensajes (SOLO sandbox), pruebas de SMTP/DeepInfra, logs y
 * reintento de colas.
 */
import { DevToolsService } from '../src/modules/devtools.module';
import { BufferedLogger, getRecentLogs } from '../src/common/log-buffer';
import { AiProvider } from '../src/ai/types';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const DEV = {
  id: 'dev1', email: 'dev@backoffice.dev', name: 'Dev', role: 'DEV' as const,
  companyId: null,
};

function fakeQueue(counts: Record<string, number> = {}, failedJobs: any[] = []) {
  return {
    getJobCounts: jest.fn(async () => ({
      waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0, ...counts,
    })),
    getFailed: jest.fn(async () => failedJobs),
    add: jest.fn(async () => undefined),
  };
}

function setup(over: {
  ai?: AiProvider;
  queues?: { in?: any; out?: any; engine?: any };
} = {}) {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const emails = { systemSend: jest.fn(async () => ({ status: 'QUEUED' })) };
  const twilio = { enqueueInbound: jest.fn(async () => undefined) };
  const events = { subscriberCount: () => 3, emit: jest.fn(), subscribe: jest.fn() };
  const service = new DevToolsService(
    prisma as any, audit as any, emails as any, twilio as any,
    events as any, over.ai,
    over.queues?.in, over.queues?.out, over.queues?.engine,
  );
  // Mongo ping del mock
  (prisma as any).$runCommandRaw = jest.fn(async () => ({ ok: 1 }));

  db.company.push({
    id: 'co1', name: 'Nexus', slug: 'nexus', timezone: 'America/Bogota',
    orderConfigJson: '{}', waTemplatesJson: '[]', deepinfraApiKey: 'llave-x',
  });
  db.integration.push({
    id: 'line1', companyId: 'co1', type: 'WHATSAPP', name: 'Línea Sandbox',
    configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }),
  });
  return { prisma, db, service, audit, emails, twilio };
}

/* ═══ Simulador de mensajes entrantes ═══ */

describe('simulador de mensajes (dev)', () => {
  it('inyecta por la MISMA cola del webhook con MessageSid sintético', async () => {
    const ctx = setup();
    const result = await ctx.service.simulateInbound(DEV as any, {
      companyId: 'co1', from: '+57 310 000 0001', name: 'Laura', body: 'Hola, quiero cotizar',
    });
    expect(result.ok).toBe(true);
    expect(result.sid).toMatch(/^SIM_/);
    expect(ctx.twilio.enqueueInbound).toHaveBeenCalledWith(
      'co1', 'line1',
      expect.objectContaining({
        Body: 'Hola, quiero cotizar',
        From: 'whatsapp:+573100000001', // sin espacios
        ProfileName: 'Laura',
      }),
    );
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dev.simulate_inbound' }),
    );
  });

  it('JAMÁS contra una línea de producción (sin sandbox) → 400', async () => {
    const ctx = setup();
    ctx.db.integration[0].configJson = JSON.stringify({
      provider: 'TWILIO', sandbox: false, accountSid: 'AC_REAL',
    });
    await expect(
      ctx.service.simulateInbound(DEV as any, { companyId: 'co1', body: 'x' }),
    ).rejects.toThrow(/SANDBOX/i);
    expect(ctx.twilio.enqueueInbound).not.toHaveBeenCalled();
  });

  it('empresa sin línea → 404; mensaje vacío → 400', async () => {
    const ctx = setup();
    await expect(
      ctx.service.simulateInbound(DEV as any, { companyId: 'no-line', body: 'x' }),
    ).rejects.toThrow(/línea/i);
    await expect(
      ctx.service.simulateInbound(DEV as any, { companyId: 'co1', body: '  ' }),
    ).rejects.toThrow(/mensaje/i);
  });

  it('sin teléfono usa uno por defecto (no revienta)', async () => {
    const ctx = setup();
    const result = await ctx.service.simulateInbound(DEV as any, {
      companyId: 'co1', body: 'hola',
    });
    expect(result.from).toBe('+570000000001');
  });
});

/* ═══ Tablero de salud ═══ */

describe('tablero de salud (dev/status)', () => {
  it('reporta db, colas, sse y checklist de settings con faltantes', async () => {
    const ctx = setup({
      queues: {
        in: fakeQueue({ waiting: 2 }),
        out: fakeQueue({ failed: 3 }),
        engine: fakeQueue(),
      },
    });
    ctx.db.platformSetting.push({ key: 'WEBHOOK_BASE_URL', value: 'https://x' });
    ctx.db.platformSetting.push({ key: 'SMTP_HOST', value: 'smtp.x' }); // SMTP incompleto

    const status = await ctx.service.status();
    expect(status.db.ok).toBe(true);
    expect(status.sseConnections).toBe(3);
    expect(status.queues.find((q: any) => q.name === 'wa-outbound')!.failed).toBe(3);

    const webhooks = status.settingsChecklist.find((g: any) => g.group === 'Webhooks')!;
    expect(webhooks.complete).toBe(true);
    const smtp = status.settingsChecklist.find((g: any) => g.group === 'Correo')!;
    expect(smtp.complete).toBe(false);
    expect(smtp.keys.find((k: any) => k.key === 'SMTP_HOST')!.configured).toBe(true);
    expect(smtp.keys.find((k: any) => k.key === 'SMTP_PASS')!.configured).toBe(false);
  });

  it('Redis caído en una cola → status degradado sin reventar', async () => {
    const broken = {
      getJobCounts: jest.fn(async () => {
        throw new Error('ECONNREFUSED redis');
      }),
      getFailed: jest.fn(async () => []),
    };
    const ctx = setup({ queues: { in: broken as any } });
    const status = await ctx.service.status();
    expect(status.status).toBe('degraded');
    expect(status.queues[0].error).toContain('ECONNREFUSED');
  });

  it('retryFailed reintenta y audita los jobs fallidos', async () => {
    const job = { retry: jest.fn(async () => undefined) };
    const ctx = setup({
      queues: { out: fakeQueue({}, [job, job]) },
    });
    const result = await ctx.service.retryFailed(DEV as any);
    expect(result['wa-outbound']).toBe(2);
    expect(job.retry).toHaveBeenCalledTimes(2);
    expect(ctx.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dev.queues_retry' }),
    );
  });
});

/* ═══ Pruebas de integraciones ═══ */

describe('utilidades de prueba (dev)', () => {
  it('correo de prueba: destino inválido → 400; válido → systemSend', async () => {
    const ctx = setup();
    await expect(ctx.service.testEmail(DEV as any, 'no-es-correo')).rejects.toThrow(/inválido/);
    await ctx.service.testEmail(DEV as any, 'yo@test.co');
    expect(ctx.emails.systemSend).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: 'yo@test.co' }),
    );
  });

  it('prueba DeepInfra: llave OK mide latencia; empresa sin llave → ok:false', async () => {
    const ai: AiProvider = {
      chat: jest.fn(async () => ({
        content: 'OK', inputTokens: 5, outputTokens: 1, model: 'llama-test',
      })),
      transcribe: jest.fn(async () => ({ text: '' })),
    } as any;
    const ctx = setup({ ai });
    const good = await ctx.service.testDeepinfra(DEV as any, 'co1');
    expect(good.ok).toBe(true);
    expect(good.model).toBe('llama-test');

    delete (ctx.db.company[0] as any).deepinfraApiKey;
    const missing = await ctx.service.testDeepinfra(DEV as any, 'co1');
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('llave');
  });

  it('prueba DeepInfra: proveedor caído → ok:false con el error (sin excepción)', async () => {
    const ai: AiProvider = {
      chat: jest.fn(async () => {
        throw new Error('DeepInfra respondió 401');
      }),
      transcribe: jest.fn(async () => ({ text: '' })),
    } as any;
    const ctx = setup({ ai });
    const result = await ctx.service.testDeepinfra(DEV as any, 'co1');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
  });
});

/* ═══ Ring buffer de logs ═══ */

describe('log buffer', () => {
  it('captura error/warn con contexto y filtra por nivel', () => {
    const logger = new BufferedLogger();
    // silenciar la salida real en el test
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    logger.error('se cayó Atlas', undefined, 'Prisma');
    logger.warn('salida inválida del modelo', 'Engine');

    const all = getRecentLogs('all', 10);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0].message).toContain('salida inválida'); // más reciente primero
    const errors = getRecentLogs('error', 10);
    expect(errors.some((e) => e.message.includes('Atlas'))).toBe(true);
    expect(errors.every((e) => e.level === 'error')).toBe(true);

    jest.restoreAllMocks();
  });
});

describe('API keys: permisos y secreto', () => {
  it('solo acepta permisos conocidos y el hash nunca sale del API', async () => {
    const { service, db } = setup();
    const created = await service.createApiKey({ id: 'dev', role: 'DEV', name: 'Dev' } as any, { name: 'Rappi', companyId: 'co1', scopes: ['orders', 'admin', '*', 'read'] });
    expect(created.secret).toMatch(/^bo_live_/);
    expect(created).not.toHaveProperty('hash');
    expect(created.scopes).toEqual(['orders', 'read']);
    expect(JSON.parse(db.apiKey[0].scopesJson)).toEqual(['orders', 'read']);
    const list = await service.listApiKeys();
    expect(list[0]).not.toHaveProperty('hash');
    expect(list[0]).not.toHaveProperty('secret');
    expect(list[0].scopes).toEqual(['orders', 'read']);
  });

  it('sin permisos explícitos la key queda de solo lectura', async () => {
    const { service } = setup();
    const created = await service.createApiKey({ id: 'dev', role: 'DEV', name: 'Dev' } as any, { name: 'Reportes' });
    expect(created.scopes).toEqual(['read']);
  });
});
