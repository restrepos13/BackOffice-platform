/**
 * IA de las empresas con DeepInfra u OpenRouter, sin importar el proveedor:
 * la llave decide por dónde va cada llamada. Nada llama a un proveedor real.
 */
import { DeepInfraProvider } from '../src/ai/deepinfra.provider';
import { DEFAULT_OPENROUTER_MODEL, PLATFORM_OPENROUTER_KEY, isOpenRouterKey, openRouterModelFor } from '../src/ai/model-routing';

const OLD = process.env;
let calls: Array<{ url: string; auth: string; body: any }> = [];
let reply: { status: number; body: any } = { status: 200, body: {} };

beforeEach(() => {
  process.env = { ...OLD, OPENROUTER_API_KEY: 'sk-or-de-backoffice', DEEPINFRA_API_KEY: '', OPENROUTER_MODEL: '' };
  calls = [];
  reply = { status: 200, body: { choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 }, model: 'anthropic/claude-haiku-5.5' } };
  jest.spyOn(global, 'fetch').mockImplementation(async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization, body: init?.body && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body, text: async () => JSON.stringify(reply.body) } as any;
  });
});
afterEach(() => { jest.restoreAllMocks(); });
afterAll(() => { process.env = OLD; });

const ask = (apiKey: string, model = 'meta-llama/Llama-3.3-70B-Instruct') =>
  new DeepInfraProvider().chat({ apiKey, model, temperature: 0, maxTokens: 50, messages: [{ role: 'user', content: 'hola' }] });

describe('qué llave va a qué proveedor', () => {
  it('reconoce las llaves de OpenRouter y elige el modelo de allá', () => {
    expect(isOpenRouterKey('sk-or-v1-abc')).toBe(true);
    expect(isOpenRouterKey(PLATFORM_OPENROUTER_KEY)).toBe(true);
    expect(isOpenRouterKey('di_abc123')).toBe(false);
    expect(openRouterModelFor('meta-llama/Llama-3.3-70B-Instruct')).toBe(DEFAULT_OPENROUTER_MODEL);
    expect(openRouterModelFor('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
    process.env.OPENROUTER_MODEL = 'qwen/qwen-2.5-72b-instruct';
    expect(openRouterModelFor('meta-llama/Llama-3.3-70B-Instruct')).toBe('qwen/qwen-2.5-72b-instruct');
    process.env.OPENROUTER_MODEL = 'cualquier cosa rara';
    expect(openRouterModelFor('x')).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it('llave de DeepInfra: va a DeepInfra con el modelo tal cual', async () => {
    await ask('di_llave_de_la_empresa');
    expect(calls[0].url).toMatch(/api\.deepinfra\.com/);
    expect(calls[0].auth).toBe('Bearer di_llave_de_la_empresa');
    expect(calls[0].body.model).toBe('meta-llama/Llama-3.3-70B-Instruct');
  });

  it('llave de OpenRouter de la empresa: TODO va a OpenRouter, con su llave y Haiku 5.5', async () => {
    const r = await ask('sk-or-v1-de-la-empresa');
    expect(calls[0].url).toMatch(/openrouter\.ai/);
    expect(calls[0].auth).toBe('Bearer sk-or-v1-de-la-empresa');
    expect(calls[0].body.model).toBe('anthropic/claude-haiku-5.5');
    expect(r.model).toBe('anthropic/claude-haiku-5.5'); // el costo se calcula con el modelo que respondió
  });

  it('IA de BackOffice sin DeepInfra: va con la llave de OpenRouter del servidor', async () => {
    await ask(PLATFORM_OPENROUTER_KEY);
    expect(calls[0].url).toMatch(/openrouter\.ai/);
    expect(calls[0].auth).toBe('Bearer sk-or-de-backoffice');
    expect(calls[0].body.model).toBe('anthropic/claude-haiku-5.5');
  });

  it('modelos premium: con la llave de OpenRouter de la empresa sí; con su llave de DeepInfra no (403)', async () => {
    await ask('sk-or-v1-de-la-empresa', 'anthropic/claude-haiku-4.5');
    expect(calls[0].body.model).toBe('anthropic/claude-haiku-4.5');
    await expect(ask('di_llave_de_la_empresa', 'anthropic/claude-haiku-4.5')).rejects.toMatchObject({ providerStatus: 403 });
  });

  it('sin saldo: con la llave de la empresa es «sin saldo» (402, pasa a la de respaldo); con la de BackOffice, 503', async () => {
    reply = { status: 402, body: { error: { message: 'Insufficient credits' } } };
    await expect(ask('sk-or-v1-de-la-empresa')).rejects.toMatchObject({ providerStatus: 402 });
    await expect(ask(PLATFORM_OPENROUTER_KEY)).rejects.toMatchObject({ providerStatus: 503 });
  });

  it('las imágenes viajan a OpenRouter igual (Haiku 5.5 las lee)', async () => {
    await new DeepInfraProvider().chat({
      apiKey: 'sk-or-v1-de-la-empresa', model: 'meta-llama/Llama-3.2-11B-Vision-Instruct', temperature: 0, maxTokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: '¿qué ves?' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }],
    });
    expect(calls[0].body.model).toBe('anthropic/claude-haiku-5.5');
    expect(calls[0].body.messages[0].content[1].type).toBe('image_url');
  });

  it('audios con OpenRouter: no se transcriben (501, no salta a otra llave) y no se llama a nadie', async () => {
    await expect(new DeepInfraProvider().transcribe({ apiKey: 'sk-or-v1-de-la-empresa', filePath: __filename, mimeType: 'audio/ogg' })).rejects.toMatchObject({ providerStatus: 501 });
    expect(calls).toHaveLength(0);
  });
});
