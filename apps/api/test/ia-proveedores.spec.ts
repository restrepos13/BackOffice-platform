/**
 * Cadena genérica con Groq y Cerebras: mismas reglas que Gemini (rotación de
 * llaves, agotada hasta mañana, apartada 1 h, modelo inexistente, cuelgue →
 * 10 min), catálogo real por GET /models y orden automático de la cadena.
 * Ninguna prueba llama a una API real: fetch siempre es simulado.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { GeminiPool, chainId, sanitizeChain } from '../src/ai/gemini-pool';
import { fingerprint, pickDefaultModel, textModelsFrom } from '../src/ai/openai-compat';
import { benchEntry } from '../src/ai/setup-ai-bench';
import { DevToolsService } from '../src/modules/devtools.module';
import { createMockPrisma } from './helpers/mock-prisma';

function reply(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}
const okChat = (content: string) => reply(200, { choices: [{ message: { content } }], usage: { total_tokens: 12 } });
const models = (...ids: string[]) => reply(200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', active: true })) });

const ENV = {
  GEMINI_API_KEYS: '', GEMINI_MODELS: 'gemini-2.5-flash,gemini-3.5-flash',
  GROQ_API_KEYS: 'gsk_groq-uno-1111,gsk_groq-dos-2222', CEREBRAS_API_KEY: 'csk-cere-uno-3333',
  OPENROUTER_API_KEY: '', GROQ_MODEL: '', CEREBRAS_MODEL: '',
};

describe('Groq y Cerebras en la cadena genérica', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, ...ENV }; });
  afterAll(() => { process.env = OLD; });

  it('rota las llaves de Groq: 429 deja la llave agotada hasta mañana y nunca se guarda la llave', async () => {
    const { prisma, db } = createMockPrisma();
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init: any) => {
      const key = init.headers.Authorization.slice(7);
      calls.push(`${key.includes('uno') ? 'uno' : 'dos'}@${new URL(url).host}`);
      if (key.includes('uno')) return reply(429, { error: { message: 'Rate limit reached for requests per day' } });
      return okChat('{"ok":true}');
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const r = await pool.tryEntry({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }, { messages: [{ role: 'user', content: 'hola' }], json: true });
    expect(r.result).toMatchObject({ provider: 'GROQ', model: 'llama-3.3-70b-versatile', keyLabel: 'groq 2', content: '{"ok":true}' });
    expect(calls).toEqual(['uno@api.groq.com', 'dos@api.groq.com']);
    const usage = db.aiKeyUsage.find((u: any) => u.provider === 'GROQ' && u.fingerprint === fingerprint('gsk_groq-uno-1111'));
    expect(usage?.exhaustedAt).toBeTruthy();
    // Agotada hoy: la siguiente llamada ya no la intenta
    calls.length = 0;
    await pool.tryEntry({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }, { messages: [{ role: 'user', content: 'otra' }] });
    expect(calls).toEqual(['dos@api.groq.com']);
    expect(JSON.stringify(db.aiKeyUsage)).not.toMatch(/gsk_groq|csk-cere/);
  });

  it('401/403 aparta la llave 1 h y 404 marca el modelo como inexistente para esa llave', async () => {
    const { prisma } = createMockPrisma();
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const key = init.headers.Authorization.slice(7);
      const model = JSON.parse(init.body).model;
      if (key.includes('uno')) return reply(401, { error: { message: 'Invalid API Key' } });
      if (model === 'no-existe') return reply(404, { error: { message: 'model not found' } });
      return okChat('ok');
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const groq = pool.keyed.GROQ;
    const gone = await pool.tryEntry({ provider: 'GROQ', model: 'no-existe' }, { messages: [{ role: 'user', content: 'x' }] });
    expect(gone.result).toBeNull();
    expect(gone.error).toBe('modelo no disponible para esta llave');
    expect(groq.cooldown.get(fingerprint('gsk_groq-uno-1111'))! - Date.now()).toBeGreaterThan(55 * 60e3);
    expect(groq.cooldown.get(`${fingerprint('gsk_groq-dos-2222')}:no-existe`)! - Date.now()).toBeGreaterThan(5 * 3600e3);
    // La llave apartada no se vuelve a intentar; la otra sigue funcionando con un modelo real
    fetchImpl.mockClear();
    const ok = await pool.tryEntry({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }, { messages: [{ role: 'user', content: 'x' }] });
    expect(ok.result?.keyLabel).toBe('groq 2');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('un modelo de Cerebras que se cuelga descansa 10 minutos', async () => {
    const { prisma } = createMockPrisma();
    const fetchImpl = jest.fn((_url: string, init: any) => new Promise((_ok, fail) => {
      init.signal.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const r = await pool.tryEntry({ provider: 'CEREBRAS', model: 'gpt-oss-120b' }, { messages: [{ role: 'user', content: 'x' }], timeoutMs: 1600 });
    expect(r.error).toBe('tardó demasiado');
    const until = pool.keyed.CEREBRAS.cooldown.get(`${fingerprint('csk-cere-uno-3333')}:gpt-oss-120b`)!;
    expect(until - Date.now()).toBeGreaterThan(9 * 60e3);
    expect((await pool.availability({ provider: 'CEREBRAS', model: 'gpt-oss-120b', enabled: true })).state).toBe('DESCANSANDO');
    // Y queda en las estadísticas del modelo
    expect((await pool.stats())['CEREBRAS:gpt-oss-120b']).toMatchObject({ ok: 0, fail: 1, lastError: 'tardó demasiado' });
  });

  it('si el modelo no acepta JSON estricto, reintenta sin response_format en vez de descartarlo', async () => {
    const { prisma } = createMockPrisma();
    const bodies: any[] = [];
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return reply(400, { error: { message: 'response_format json_object is not supported for this model' } });
      return okChat('<think>pensando</think>{"listo":1}');
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const r = await pool.tryEntry({ provider: 'CEREBRAS', model: 'qwen-3-32b' }, { messages: [{ role: 'user', content: 'x' }], json: true });
    expect(r.result?.content).toBe('{"listo":1}');
    expect(bodies.map((b) => !!b.response_format)).toEqual([true, false]);
  });

  it('solo ofrece modelos de texto que existen en GET /models y elige el de por defecto dentro de esa lista', async () => {
    expect(textModelsFrom({ data: [{ id: 'whisper-large-v3' }, { id: 'llama-3.3-70b-versatile' }, { id: 'meta-llama/llama-prompt-guard-2-86m' }, { id: 'viejo', active: false }, { id: 'models/gemini-2.5-flash' }, { id: 'groq/compound' }] }))
      .toEqual(['gemini-2.5-flash', 'llama-3.3-70b-versatile']);
    expect(pickDefaultModel(['qwen-3-32b', 'gpt-oss-120b'], [/^llama-3\.3-70b/, /gpt-oss-120b/])).toBe('gpt-oss-120b');
    // El configurado solo se usa si existe
    expect(pickDefaultModel(['qwen-3-32b'], [/llama/], 'inventado-9000')).toBe('qwen-3-32b');
    expect(pickDefaultModel([], [/llama/])).toBeNull();
  });

  it('orden automático: Gemini 2.5 Flash → Groq → Cerebras → resto de Gemini, solo con modelos del catálogo', async () => {
    const { prisma } = createMockPrisma();
    process.env.GEMINI_API_KEYS = 'llave-gem-1111';
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('groq.com') && url.endsWith('/models')) return models('whisper-large-v3', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile');
      if (url.includes('cerebras.ai') && url.endsWith('/models')) return models('qwen-3-32b', 'gpt-oss-120b');
      if (url.endsWith('/models')) return models('gemini-2.5-flash', 'gemini-3.5-flash', 'text-embedding-004');
      return okChat('ok');
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    // Sin catálogo todavía: Groq y Cerebras no entran (no se puede validar el modelo)
    expect((await pool.chain()).entries.map(chainId)).toEqual(['GEMINI:gemini-2.5-flash', 'GEMINI:gemini-3.5-flash']);
    const refreshed = await pool.refreshCatalogs();
    expect(refreshed).toMatchObject({ GROQ: { count: 2, error: null }, CEREBRAS: { count: 2, error: null }, GEMINI: { count: 2, error: null } });
    expect((await pool.chain()).entries.map(chainId)).toEqual([
      'GEMINI:gemini-2.5-flash', 'GROQ:llama-3.3-70b-versatile', 'CEREBRAS:gpt-oss-120b', 'GEMINI:gemini-3.5-flash',
    ]);
    expect(await pool.inCatalog({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' })).toBe(true);
    expect(await pool.inCatalog({ provider: 'GROQ', model: 'mixtral-que-ya-no-existe' })).toBe(false);
    // Un orden guardado en Dev Tools manda, y acepta los proveedores nuevos
    await pool.saveChain([{ provider: 'CEREBRAS', model: 'gpt-oss-120b' }, { provider: 'GROQ', model: 'llama-3.3-70b-versatile', enabled: false }, { provider: 'RARO', model: 'x' }]);
    expect((await pool.chain()).entries).toEqual([
      { provider: 'CEREBRAS', model: 'gpt-oss-120b', enabled: true },
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile', enabled: false },
    ]);
  });

  it('si el catálogo falla se conserva el último bueno y se anota el error', async () => {
    const { prisma } = createMockPrisma();
    let down = false;
    const fetchImpl = jest.fn(async () => (down ? reply(503, { error: 'caído' }) : models('llama-3.3-70b-versatile')));
    const groq = new GeminiPool(prisma, fetchImpl as any).keyed.GROQ;
    expect((await groq.refreshModels())?.ids).toEqual(['llama-3.3-70b-versatile']);
    down = true;
    const after = await groq.refreshModels();
    expect(after?.ids).toEqual(['llama-3.3-70b-versatile']);
    expect(after?.error).toMatch(/^503/);
  });

  it('recorre la cadena en orden y, si ningún proveedor responde, lanza AI_UNAVAILABLE para el plan B', async () => {
    const { prisma } = createMockPrisma();
    const order: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init: any) => {
      order.push(`${new URL(url).host}:${JSON.parse(init.body).model}`);
      return reply(503, { error: 'saturado' });
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    await pool.saveChain([
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
      { provider: 'CEREBRAS', model: 'gpt-oss-120b' },
      { provider: 'GEMINI', model: 'gemini-2.5-flash' }, // sin llaves de Gemini: se salta sin llamar
    ]);
    const err = await pool.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(order).toEqual(['api.groq.com:llama-3.3-70b-versatile', 'api.cerebras.ai:gpt-oss-120b']);
  });

  it('la prueba de Dev Tools (setup-ai-bench) también mide a Groq y Cerebras', async () => {
    const { prisma } = createMockPrisma();
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      const sys = JSON.parse(init.body).messages[0].content as string;
      return okChat(/plano|A LA MEDIDA de un negocio/i.test(sys) && !/entrevistas/i.test(sys)
        ? JSON.stringify({ empresa: { nombre: 'Panadería Doña Rosa' }, rubro: 'COMIDAS', productos: [{ nombre: 'Torta de chocolate', precio: 60000 }, { nombre: 'Pan' }], asistente: { nombre: 'Rosa', bienvenida: 'Hola, soy de la panadería Doña Rosa' }, embudo: { etapas: [{ tipo: 'nueva' }, { tipo: 'cotizada' }, { tipo: 'ganada' }] } })
        : JSON.stringify({ pregunta: '¿Cómo te hacen los pedidos?', opciones: ['WhatsApp', 'En el local'] }));
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    const r = await benchEntry(pool, { provider: 'GROQ', model: 'llama-3.3-70b-versatile' });
    expect(r.id).toBe('GROQ:llama-3.3-70b-versatile');
    expect(r.score).toBeGreaterThanOrEqual(85);
    expect((await pool.stats())['GROQ:llama-3.3-70b-versatile'].bench?.score).toBe(r.score);
  });

  it('Dev Tools muestra si hay llave cargada sin mostrarla nunca', async () => {
    const { prisma } = createMockPrisma();
    const pool = new GeminiPool(prisma, jest.fn() as any);
    const st = await pool.status();
    expect(st.groq.keys.map((k) => k.label)).toEqual(['Groq · llave 1 cargada', 'Groq · llave 2 cargada']);
    expect(st.cerebras.keys.map((k) => k.label)).toEqual(['Cerebras · llave 1 cargada']);
    expect(JSON.stringify(st)).not.toMatch(/gsk_|csk-|1111|2222|3333/);
    expect(sanitizeChain([{ provider: 'GROQ', model: 'llama 3' }])).toEqual([]); // nombres inválidos fuera
  });

  it('Dev Tools no guarda las llaves de la IA genérica en la base aunque lleguen desde el panel', async () => {
    const { prisma, db } = createMockPrisma();
    const service = new DevToolsService(prisma as any, { log: jest.fn(async () => undefined) } as any, {} as any, {} as any, {} as any);
    await service.setSettings({ id: 'dev1', role: 'DEV', name: 'Dev', email: 'd@x.co', companyId: null } as any, {
      GROQ_API_KEYS: 'gsk_nunca-en-la-base', CEREBRAS_API_KEY: 'csk-nunca', GENERIC_AI_DAILY_PER_COMPANY: '15',
    });
    expect(db.platformSetting.map((s: any) => s.key)).toEqual(['GENERIC_AI_DAILY_PER_COMPANY']);
    expect(JSON.stringify(db.platformSetting)).not.toMatch(/gsk_|csk-/);
  });
});

describe('la cadena genérica siempre manda texto sanitizado', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD, GEMINI_API_KEYS: 'llave-gem-1111', GEMINI_MODELS: 'gemini-2.5-flash', GROQ_API_KEYS: '', CEREBRAS_API_KEY: '', OPENROUTER_API_KEY: '' }; });
  afterAll(() => { process.env = OLD; });

  it('lo que llega al proveedor no tiene teléfonos, correos ni nombres de contactos', async () => {
    const { prisma } = createMockPrisma();
    const bodies: string[] = [];
    const fetchImpl = jest.fn(async (_url: string, init: any) => {
      bodies.push(init.body);
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'listo' } }], usage: { total_tokens: 3 } }) };
    });
    const pool = new GeminiPool(prisma, fetchImpl as any);
    await pool.chat({
      knownNames: ['Carlos Gómez'],
      messages: [{ role: 'user', content: 'Panadería en Envigado. Carlos Gómez (3104567890, carlos@gmail.com) pide pan de $3.000' }],
    });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toMatch(/3104567890|carlos@gmail|Carlos|Gómez/);
    expect(bodies[0]).toContain('$3.000');
    expect(bodies[0]).toContain('Envigado');
  });
});
