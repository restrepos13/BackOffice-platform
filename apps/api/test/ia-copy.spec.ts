/**
 * Creative / Ads: variaciones de copy con IA.
 * - Límites de Meta y botones permitidos; un reintento y luego se descarta.
 * - Reglas de la marca y políticas de Meta antes de devolver.
 * - IA propia de la empresa (queda en AiUsageEvent) o cadena genérica gratis
 *   con tope diario por empresa y sin cobro.
 * Nada llama a una API real: la IA de la empresa y la cadena son simuladas.
 */
import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { COPY_LIMITS, copyMessages, parseVariations, validateCopyVariation } from '../src/common/ads/copy-variations';
import { CompanyTextAi, GENERIC_AI_LIMIT } from '../src/ai/company-text-ai';
import { CreativeCopyService } from '../src/modules/creative-copy';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const ADMIN = { id: 'u1', email: 'a@a.co', name: 'Admin', role: 'COMPANY_ADMIN', companyId: 'co1' } as any;

const v = (o: Partial<Record<'titular' | 'texto' | 'descripcion' | 'cta' | 'enfoque', string>> = {}) => ({
  titular: 'Tortas de chocolate por encargo',
  texto: 'Pide tu torta de cumpleaños con 2 días de anticipación. Escríbenos por WhatsApp y te ayudamos.',
  descripcion: 'Hechas en Envigado',
  cta: 'WHATSAPP_MESSAGE',
  enfoque: 'beneficio',
  ...o,
});

/** Cadena genérica simulada: devuelve las respuestas en orden y guarda lo que recibió. */
function fakePool(responses: Array<string | Error>) {
  const seen: any[] = [];
  let i = 0;
  return {
    seen,
    chat: jest.fn(async (opts: any) => {
      seen.push(opts);
      const r = responses[Math.min(i++, responses.length - 1)];
      if (r instanceof Error) throw r;
      return { content: r, model: 'gemini-2.5-flash', keyLabel: 'llave 1', tokens: 50, provider: 'GEMINI' };
    }),
  };
}

function unavailable() {
  return new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'x' });
}

function setupCopy(company: Record<string, any> = {}) {
  const { prisma, db } = createMockPrisma();
  db.company.push({ id: 'co1', name: 'Panadería Doña Rosa', status: 'ACTIVE', timezone: 'America/Bogota', onboardingJson: JSON.stringify({ businessType: 'panadería', description: 'Pan y tortas en Envigado' }), ...company });
  db.brandProfile.push({ companyId: 'co1', name: 'Doña Rosa', tone: 'cercano', restrictionsJson: JSON.stringify(['competencia']), policyJson: JSON.stringify({ restrictedTopics: ['política'] }) });
  db.contact.push({ id: 'ct1', companyId: 'co1', name: 'Marta Lucía Gómez', phone: '+573001234567' });
  const audit = { log: jest.fn(async () => undefined) };
  return { prisma, db, audit };
}

/** IA de prueba autorizada por un dev (vigente) con su tope diario. */
const trial = (dailyLimit = 20) => JSON.stringify({ until: new Date(Date.now() + 7 * 864e5).toISOString(), dailyLimit, authorizedBy: 'Santiago', authorizedAt: new Date().toISOString() });

function copyService(ctx: ReturnType<typeof setupCopy>, pool: any, ai?: any) {
  const service = new CreativeCopyService(ctx.prisma as any, ctx.audit as any, ai);
  (service as any).textAi = new CompanyTextAi(ctx.prisma, ai, pool);
  return service;
}

describe('copy para Meta Ads: validación', () => {
  it('respeta los límites de Meta y la lista de botones', () => {
    expect(validateCopyVariation(v(), 'WHATSAPP')).toMatchObject({ ok: true, value: { cta: 'WHATSAPP_MESSAGE', ctaLabel: 'Enviar mensaje' } });
    const long = validateCopyVariation(v({ titular: 'x'.repeat(COPY_LIMITS.headline.max + 1), texto: 'y'.repeat(COPY_LIMITS.primaryText.max + 1), descripcion: 'z'.repeat(31) }), 'WHATSAPP');
    expect(long.ok).toBe(false);
    expect((long as any).errors.join(' ')).toMatch(/titular: 41.*texto: 126.*descripcion: 31/);
    // En web: la clave o el texto del botón, pero solo los permitidos
    expect(validateCopyVariation(v({ cta: 'Pedir ahora' }), 'WEBSITE')).toMatchObject({ ok: true, value: { cta: 'ORDER_NOW' } });
    expect(validateCopyVariation(v({ cta: 'BUY_TICKETS_NOW' }), 'WEBSITE').ok).toBe(false);
    expect(validateCopyVariation(v({ cta: 'SHOP_NOW' }), 'WHATSAPP').ok).toBe(false);
  });

  it('descarta textos con enlaces o con datos ocultos por el sanitizador', () => {
    expect(validateCopyVariation(v({ texto: 'Pide en www.donarosa.co tu torta favorita hoy mismo, te esperamos' }), 'WHATSAPP').ok).toBe(false);
    expect(validateCopyVariation(v({ texto: 'Escríbele a [contacto] al [teléfono] y pide tu torta de chocolate hoy' }), 'WHATSAPP').ok).toBe(false);
  });

  it('separa válidas de inválidas y no repite variaciones', () => {
    const r = parseVariations({ variaciones: [v(), v(), v({ titular: '' }), v({ titular: 'Otra idea distinta' })] }, 'WHATSAPP');
    expect(r.valid.map((x) => x.headline)).toEqual(['Tortas de chocolate por encargo', 'Otra idea distinta']);
    expect(r.errors).toHaveLength(1);
    expect(parseVariations({}, 'WHATSAPP').errors[0]).toMatch(/variaciones/);
  });

  it('la instrucción lleva solo datos del negocio y de la pieza, y los límites', () => {
    const msgs = copyMessages({ business: 'Doña Rosa', sector: 'Panadería', goalLabel: 'Mostrar un producto', destination: 'WHATSAPP', count: 3, product: 'Torta de chocolate' });
    const all = msgs.map((m) => m.content).join('\n');
    expect(all).toContain('titular 3-40; texto 20-125; descripcion 3-30');
    expect(all).toContain('WHATSAPP_MESSAGE');
    expect(all).not.toMatch(/cliente final|conversaci[oó]n de whatsapp/i);
  });
});

describe('copy para Meta Ads: proveedor, reintento, políticas y tope', () => {
  it('sin IA propia y con la IA de prueba autorizada usa la cadena genérica: un reintento y descarta lo que no cumple', async () => {
    const ctx = setupCopy({ aiTrialJson: trial(20) });
    const pool = fakePool([
      JSON.stringify({ variaciones: [v(), v({ titular: 'Un titular larguísimo que no cabe en el anuncio de Meta' })] }),
      JSON.stringify({ variaciones: [v({ titular: 'Tu torta lista en 2 días', enfoque: 'urgencia' }), v({ cta: 'COMPRAR_YA' })] }),
    ]);
    const service = copyService(ctx, pool);
    const r = await service.suggest(ADMIN, { goal: 'PRODUCT', destination: 'WHATSAPP', count: 3, product: 'Torta de chocolate' });
    expect(pool.chat).toHaveBeenCalledTimes(2); // un solo reintento
    expect(pool.seen[1].messages[1].content).toMatch(/no cumplió: variación 2: titular: \d+ caracteres/);
    expect(r.variations.map((x) => x.headline)).toEqual(['Tortas de chocolate por encargo', 'Tu torta lista en 2 días']);
    expect(r.discarded.limits).toBe(1);
    expect(r).toMatchObject({ source: 'GENERICA', quota: { used: 1, limit: 20 } });
    // La genérica recibe los nombres de contactos para quitarlos, y NO se le cobra a la empresa
    expect(pool.seen[0].knownNames).toContain('Marta Lucía Gómez');
    expect(JSON.stringify(pool.seen[0].messages)).not.toContain('Marta');
    expect(ctx.db.aiUsageEvent).toHaveLength(0);
  });

  it('las reglas de la marca y las políticas de Meta filtran antes de devolver', async () => {
    const ctx = setupCopy({ aiTrialJson: trial() });
    const pool = fakePool([JSON.stringify({ variaciones: [
      v({ titular: 'Mejor que la competencia' }), // tema prohibido por la marca
      v({ texto: '¿Estás gorda? Nuestras tortas light te ayudan, escríbenos ya mismo' }), // atributos personales: Meta lo rechaza
      v({ titular: 'Torta a $60.000', enfoque: 'precio' }), // precio: pasa, pero pide revisión
    ] })]);
    const r = await copyService(ctx, pool).suggest(ADMIN, { goal: 'PROMO', count: 3 });
    expect(r.variations.map((x) => x.headline)).toEqual(['Torta a $60.000']);
    expect(r.discarded.policies).toBe(2);
    expect(r.variations[0].review).toEqual({ needsReview: true, reasons: ['Menciona precios, descuentos o promociones'] });
  });

  it('tope diario de la IA de prueba: el que fijó el dev al autorizarla', async () => {
    const ctx = setupCopy({ aiTrialJson: trial(2) });
    const pool = fakePool([JSON.stringify({ variaciones: [v()] })]);
    const service = copyService(ctx, pool);
    await service.suggest(ADMIN, { count: 1 });
    await service.suggest(ADMIN, { count: 1 });
    const err = await service.suggest(ADMIN, { count: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    expect((err as HttpException).getResponse()).toMatchObject({ code: GENERIC_AI_LIMIT });
    expect(pool.chat).toHaveBeenCalledTimes(2);
    expect(await service.textAi.genericUsage('co1', 2)).toEqual({ used: 2, limit: 2 });
  });

  it('con IA propia (BYOK) usa la de la empresa, la registra en AiUsageEvent y no gasta el cupo de prueba', async () => {
    const ctx = setupCopy({ aiBillingMode: 'BYOK', deepinfraApiKey: 'llave-de-la-empresa', aiTrialJson: trial() });
    const pool = fakePool([unavailable()]);
    const ai = { chat: jest.fn(async () => ({ content: JSON.stringify({ variaciones: [v()] }), inputTokens: 300, outputTokens: 120, model: 'meta-llama/Llama-3.3-70B-Instruct' })), transcribe: jest.fn() };
    const r = await copyService(ctx, pool, ai).suggest(ADMIN, { count: 1 });
    expect(r.source).toBe('EMPRESA');
    expect(r.quota).toBeNull();
    expect(pool.chat).not.toHaveBeenCalled();
    expect((ai.chat.mock.calls[0] as any)[0].apiKey).toBe('llave-de-la-empresa');
    expect(ctx.db.aiUsageEvent).toEqual([expect.objectContaining({ companyId: 'co1', billedTo: 'BYOK', inputTokens: 300 })]);
    expect(await new CompanyTextAi(ctx.prisma, ai as any, pool as any).genericUsage('co1', 20)).toMatchObject({ used: 0 });
  });

  it('si ninguna IA responde, avisa con AI_UNAVAILABLE (sin romper) y no gasta el cupo', async () => {
    const ctx = setupCopy({ aiTrialJson: trial(5) });
    const service = copyService(ctx, fakePool([unavailable()]));
    const err = await service.suggest(ADMIN, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: 'AI_UNAVAILABLE' });
    expect(await service.textAi.genericUsage('co1', 5)).toEqual({ used: 0, limit: 5 });
  });

  it('sin IA propia y sin autorización del dev NO usa nuestras llaves: lo dice y no llama a nadie', async () => {
    const ctx = setupCopy();
    const pool = fakePool([JSON.stringify({ variaciones: [v()] })]);
    const service = copyService(ctx, pool);
    const err = await service.suggest(ADMIN, { count: 1 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'NO_AI' });
    expect(pool.chat).not.toHaveBeenCalled();
    expect(await service.status(ADMIN)).toMatchObject({ source: 'NINGUNA', quota: null });
    // Vencida tampoco
    ctx.db.company[0].aiTrialJson = JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), dailyLimit: 10 });
    expect((await service.suggest(ADMIN, { count: 1 }).catch((e) => e)).getResponse()).toMatchObject({ code: 'NO_AI' });
  });

  it('el tope no se pasa con pedidos al mismo tiempo', async () => {
    const ctx = setupCopy({ aiTrialJson: trial(2) });
    const textAi = new CompanyTextAi(ctx.prisma, undefined, fakePool([]) as any);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => textAi.reserveGeneric('co1', 2)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => r.reason.getResponse().code === GENERIC_AI_LIMIT)).toBe(true);
    expect(await textAi.genericUsage('co1', 2)).toEqual({ used: 2, limit: 2 });
    expect(ctx.db.aiKeyUsage).toHaveLength(1);
  });
});
