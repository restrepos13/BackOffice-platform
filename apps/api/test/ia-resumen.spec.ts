/**
 * Reportes: «Resumen en palabras» para gerencia. Solo cifras agregadas (nada
 * de clientes), IA de la empresa o cadena genérica gratis y, sin IA, plantilla.
 * El reporte nunca falla por esto. Nada llama a una API real.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { CompanyTextAi } from '../src/ai/company-text-ai';
import { ReportsService } from '../src/modules/reports.module';
import { compareFacts, dailyFacts, pdfSafe, summaryMessages, templateCompareSummary, templateDailySummary, validSummary } from '../src/common/report-summary';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

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

const DAILY = {
  date: '2026-11-03',
  pedidos: { recibidos: 12, confirmados: 10, programados: 2, despachados: 9, entregados: 8, cancelados: 1 },
  conversaciones: { atendidas: 30, escaladas: 3, conIntervencionHumana: 2, resueltasPorIA: 25 },
  dudas: { pedidosBajaConfianza: [{ id: 'o1', customer: 'Juan Pérez' }], escalamientos: [{ orderId: 'o2', customer: 'Ana Ruiz', reason: 'quiere hablar con alguien' }] },
  alertas: { pedidosSinConfirmar: [{ id: 'o3', customer: 'Ana Ruiz' }], entregasProximasSinArea: [], recordatoriosFallidos: [{ id: 'r1', lastError: '3001234567 no existe' }], conversacionesSinRespuesta: 4 },
  precisionIA: { dia: { total: 5, corregidos: 0, precisionPct: 100 }, mes: { total: 40, corregidos: 4, precisionPct: 90 } },
  feedback: { respuestas: 2, promedio: 4.5, negativos: [{ customer: 'Juan Pérez', rating: 2, comment: 'llegó frío' }] },
};
const WEEKS = [
  { label: 'Sem 27 oct', pedidos: 40, entregados: 36, cancelados: 2, cumplimientoPct: 90, tomadosIA: 20, precisionIAPct: 85 },
  { label: 'Sem 03 nov', pedidos: 50, entregados: 30, cancelados: 1, cumplimientoPct: 95, tomadosIA: 25, precisionIAPct: 92 },
];

describe('resumen en palabras del reporte', () => {
  it('los hechos son solo cifras agregadas: ni nombres, ni teléfonos, ni comentarios de clientes', () => {
    const facts = dailyFacts(DAILY, WEEKS);
    const sent = JSON.stringify(summaryMessages('diario', facts));
    expect(sent).not.toMatch(/Juan|Ana|Pérez|Ruiz|3001234567|frío|hablar con alguien/);
    expect(facts.alertas).toEqual({ sinConfirmar: 1, entregasSinArea: 0, recordatoriosFallidos: 1, clientesSinRespuesta: 4 });
    expect(facts.semana?.actual.pedidos).toBe(50);
  });

  it('la plantilla dice 3 a 5 frases con las cifras reales', () => {
    const t = templateDailySummary(dailyFacts(DAILY, WEEKS));
    const sentences = t.split(/(?<=\.)\s+/);
    expect(sentences.length).toBeGreaterThanOrEqual(3);
    expect(sentences.length).toBeLessThanOrEqual(5);
    expect(t).toContain('llegaron 12 pedidos');
    expect(t).toContain('acertó en el 90 %');
    expect(t).toContain('25 % más que el periodo anterior');
    const c = templateCompareSummary(compareFacts('month', WEEKS)!);
    expect(c).toMatch(/^Este mes van 50 pedidos, 25 % más/);
  });

  it('rechaza un resumen de IA con cifras inventadas, listas o de largo equivocado', () => {
    const facts = dailyFacts(DAILY, WEEKS);
    const ok = 'Ayer llegaron 12 pedidos y se entregaron 8. La IA resolvió 25 de las 30 conversaciones. La precisión del mes va en 90 %. Revisa los 4 clientes sin respuesta.';
    expect(validSummary(ok, facts)).toBe(ok);
    expect(validSummary(ok.replace('12 pedidos', '120 pedidos'), facts)).toBeNull();
    expect(validSummary('Muy bien todo. Sigan así.', facts)).toBeNull();
    expect(validSummary(`${ok} Una. Dos. Tres.`, facts)).toBeNull();
  });

  it('el texto del PDF queda en caracteres que pdfkit sí dibuja', () => {
    expect(pdfSafe('Ventas “récord” — 12 pedidos… → bien ✅')).toBe('Ventas "récord" - 12 pedidos... -> bien ');
  });
});

describe('resumen en el reporte diario: proveedor y plan B', () => {
  function setup(company: Record<string, any> = {}) {
    const { prisma, db } = createMockPrisma();
    db.company.push({
      id: 'co1', name: 'Catering Test', status: 'ACTIVE', timezone: 'America/Bogota', modulesJson: JSON.stringify(['orders']),
      orderConfigJson: JSON.stringify({ dailyReport: { channel: 'EMAIL', email: 'gerencia@catering.co' } }), ...company,
    });
    const audit = { log: jest.fn(async () => undefined) };
    const emails = { systemSend: jest.fn(async (_m: any) => undefined) };
    return { prisma, db, audit, emails };
  }
  const reports = (ctx: ReturnType<typeof setup>, pool: any, ai?: any) => {
    const service = new ReportsService(ctx.prisma as any, ctx.audit as any, ctx.emails as any, ai);
    (service as any).textAi = new CompanyTextAi(ctx.prisma, ai, pool);
    return service;
  };
  const today = new Intl.DateTimeFormat('en-CA').format(new Date());

  it('sin IA disponible (AI_UNAVAILABLE) guarda y envía el resumen con plantilla; el reporte no falla', async () => {
    const ctx = setup();
    const service = reports(ctx, fakePool([unavailable()]));
    const r = await service.runDaily('co1', today, null);
    expect(r.data.resumen.source).toBe('PLANTILLA');
    expect(r.data.resumen.text).toMatch(/no llegaron pedidos nuevos/);
    const stored = JSON.parse(ctx.db.dailyReport[0].dataJson);
    expect(stored.resumen.text).toBe(r.data.resumen.text);
    expect((ctx.emails.systemSend.mock.calls[0] as any)[0].body).toContain(`<strong>Resumen:</strong> ${r.data.resumen.text}`);
    // Consultar el día devuelve el resumen guardado (no vuelve a llamar a la IA)
    expect((await service.dailyWithSummary('co1', today)).resumen.text).toBe(r.data.resumen.text);
  });

  it('con la cadena genérica usa la IA si respeta las cifras, y si inventa vuelve a la plantilla', async () => {
    const good = 'Ayer no llegaron pedidos y no hubo conversaciones. Este mes la IA todavía no tomó pedidos. No hay alertas pendientes que revisar.';
    const ctx = setup();
    const service = reports(ctx, fakePool([JSON.stringify({ resumen: good }), JSON.stringify({ resumen: 'Ayer llegaron 47 pedidos. Todo salió perfecto. Se vendieron 900 tortas.' })]));
    const company = ctx.db.company[0];
    const facts = dailyFacts(await service.buildDaily('co1', today), []);
    expect(await service.summarize(company, 'diario', facts)).toMatchObject({ text: good, source: 'IA_GENERICA', model: 'gemini-2.5-flash' });
    expect((await service.summarize(company, 'diario', facts)).source).toBe('PLANTILLA');
    expect(ctx.db.aiUsageEvent).toHaveLength(0); // la genérica no se le cobra a la empresa
  });

  it('pasado el tope diario de la genérica, el resumen sale con plantilla', async () => {
    const ctx = setup();
    ctx.db.platformSetting.push({ id: 's1', key: 'GENERIC_AI_DAILY_PER_COMPANY', value: '0' });
    const pool = fakePool([JSON.stringify({ resumen: 'x' })]);
    const r = await reports(ctx, pool).summarize(ctx.db.company[0], 'comparativo', compareFacts('week', WEEKS)!);
    expect(r.source).toBe('PLANTILLA');
    expect(pool.chat).not.toHaveBeenCalled();
  });

  it('el comparativo genera su resumen una vez por día y periodo', async () => {
    const ctx = setup();
    const pool = fakePool([unavailable()]);
    const service = reports(ctx, pool);
    const a = await service.compareSummary('co1', 'week');
    const b = await service.compareSummary('co1', 'week');
    expect(a.resumen?.source).toBe('PLANTILLA');
    expect(b.resumen).toBe(a.resumen);
    expect(pool.chat).toHaveBeenCalledTimes(1);
  });
});
