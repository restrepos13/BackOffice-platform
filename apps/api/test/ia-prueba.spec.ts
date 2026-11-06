/**
 * IA de prueba de BackOffice: la autoriza un dev por empresa (nunca por
 * defecto), el motor de Creative crea y la IA corrige con reglas que decide el
 * código, y la revisión con imagen va solo a Gemini. Nada llama a una IA real.
 */
import { BadRequestException } from '@nestjs/common';
import { activeAiTrial, aiTrialFrom, readAiTrial } from '../src/common/ai-trial';
import { applyChanges, applyReview, reviewMessages } from '../src/common/creative/ai-review';
import { DesignDoc, validateDesignDoc } from '../src/common/design-doc';
import { CompanyTextAi } from '../src/ai/company-text-ai';
import { GeminiPool } from '../src/ai/gemini-pool';
import { CreativeService } from '../src/modules/creative.module';
import { AiTrialService } from '../src/modules/ai-trial.module';
import { createMockPrisma } from './helpers/mock-prisma';

const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const DEV = { id: 'd1', name: 'Santiago', email: 's@b.co', role: 'DEV' as const, companyId: null } as any;
const audit = () => ({ log: jest.fn(async (_e: any) => undefined) });
const trial = (dailyLimit = 10, days = 7) => JSON.stringify({ until: new Date(Date.now() + days * 864e5).toISOString(), dailyLimit, authorizedBy: 'Santiago', authorizedAt: new Date().toISOString() });

function text(id: string, role: string, t: string, o: Record<string, any> = {}) {
  return { id, type: 'text', name: id, role, text: t, x: 80, y: 80, width: 900, height: 120, rotation: 0, opacity: 1, visible: true, locked: false, fontFamily: 'Inter', fontSize: 60, fontStyle: 'bold', align: 'left', lineHeight: 1.2, letterSpacing: 0, fill: '#111111', textDecoration: '', ...o };
}
function doc(): DesignDoc {
  return validateDesignDoc({
    schemaVersion: 1, format: 'IG_POST', width: 1080, height: 1080, background: { color: '#FFFFFF', assetId: null },
    elements: [
      text('h', 'headline', 'Tacos al pastor'),
      text('p', 'price', '$12.000', { y: 300 }),
      text('q', 'quote', 'Los mejores de la ciudad', { y: 500 }),
      text('c', 'cta', 'Pide ya', { y: 700, locked: true }),
    ],
  }, 'IG_POST');
}

describe('autorización de la IA de prueba', () => {
  it('valida días y tope; vencida no cuenta como activa', () => {
    const t = aiTrialFrom({ days: 3, dailyLimit: 40, note: 'Prueba viernes' }, 'Santiago', new Date('2026-11-06T12:00:00Z'));
    expect(t).toMatchObject({ until: '2026-11-09T12:00:00.000Z', dailyLimit: 40, authorizedBy: 'Santiago', note: 'Prueba viernes' });
    expect(() => aiTrialFrom({ days: 0 }, 'x')).toThrow(/días/);
    expect(() => aiTrialFrom({ dailyLimit: 5000 }, 'x')).toThrow(/tope/);
    expect(activeAiTrial({ aiTrialJson: JSON.stringify(t) }, new Date('2026-11-08T00:00:00Z'))).not.toBeNull();
    expect(activeAiTrial({ aiTrialJson: JSON.stringify(t) }, new Date('2026-11-10T00:00:00Z'))).toBeNull();
    expect(readAiTrial({ aiTrialJson: 'basura' })).toBeNull();
    expect(activeAiTrial({})).toBeNull(); // por defecto: sin IA de prueba
  });

  it('el dev la autoriza y la quita; queda en auditoría y la empresa la ve', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'Aurora' });
    const log = audit();
    const svc = new AiTrialService(prisma as any, log as any);
    expect(await svc.status('coA')).toMatchObject({ trial: null, active: false, source: 'NINGUNA' });
    const on = await svc.authorize(DEV, 'coA', {});
    expect(on).toMatchObject({ active: true, source: 'GENERICA', trial: { dailyLimit: 30, authorizedBy: 'Santiago' } });
    expect(Date.parse(on.trial!.until) - Date.now()).toBeGreaterThan(6.9 * 864e5);
    await expect(svc.authorize(DEV, 'coA', { days: 99 })).rejects.toBeInstanceOf(BadRequestException);
    const off = await svc.revoke(DEV, 'coA');
    expect(off).toMatchObject({ trial: null, active: false, source: 'NINGUNA' });
    expect(log.log.mock.calls.map((c: any) => c[0].action)).toEqual(['ai.trial_authorized', 'ai.trial_revoked']);
  });

  it('solo SUPER_ADMIN y DEV pueden autorizarla', () => {
    const { AiTrialController } = require('../src/modules/ai-trial.module');
    for (const method of ['status', 'authorize', 'revoke']) {
      expect(Reflect.getMetadata('roles', AiTrialController.prototype[method])).toEqual(['SUPER_ADMIN', 'DEV']);
    }
  });
});

describe('la IA corrige, el código decide qué entra', () => {
  const palette = new Set(['#E63946', '#111111', '#FFFFFF']);

  it('acepta redacción, tamaños, posiciones y colores de la paleta', () => {
    const { doc: d, applied } = applyChanges(doc(), [
      { id: 'h', texto: 'Tacos al pastor recién hechos', tam: 1.2, x: 100, y: 120, color: '#E63946' },
      { id: 'fondo', color: '#111111' },
    ], palette);
    const h = d.elements.find((e) => e.id === 'h') as any;
    expect(h).toMatchObject({ text: 'Tacos al pastor recién hechos', x: 100, y: 120, fill: '#E63946' });
    // El texto más largo no cabe a 72 px en su caja: la letra se ajusta sola (nunca por debajo del 75 %)
    expect(h.fontSize).toBeLessThan(72);
    expect(h.fontSize).toBeGreaterThanOrEqual(45);
    expect(d.background.color).toBe('#111111');
    expect(applied).toBe(5);
  });

  it('rechaza cifras inventadas, precios, testimonios, lo bloqueado, colores fuera de la paleta y salirse del lienzo', () => {
    const before = doc();
    const { doc: d, applied } = applyChanges(before, [
      { id: 'h', texto: 'Tacos al pastor 2x1 por $9.900' }, // cifras que no estaban
      { id: 'p', texto: '$8.000' }, // los precios no se tocan
      { id: 'q', texto: 'Los peores de la ciudad' }, // los testimonios no se tocan
      { id: 'c', x: 10, y: 10 }, // bloqueado
      { id: 'h', color: '#00FF00' }, // fuera de la paleta
      { id: 'h', x: 900 }, // 900 + 900 de ancho se sale
      { id: 'h', tam: 1.6 }, // se limita a 1.35
      { id: 'nuevo', texto: 'Elemento inventado' },
    ], palette);
    const h = d.elements.find((e) => e.id === 'h') as any;
    expect(h.text).toBe('Tacos al pastor');
    expect(h.fill).toBe('#111111');
    expect(h.x).toBe(80);
    expect(h.fontSize).toBe(81);
    expect((d.elements.find((e) => e.id === 'p') as any).text).toBe('$12.000');
    expect((d.elements.find((e) => e.id === 'q') as any).text).toBe('Los mejores de la ciudad');
    expect(d.elements.find((e) => e.id === 'c')!.x).toBe(80);
    expect(d.elements).toHaveLength(4);
    expect(applied).toBe(1);
  });

  it('el tamaño llega como factor o en píxeles', () => {
    const px = applyChanges(doc(), [{ id: 'h', tam: 66 }], palette).doc.elements.find((e) => e.id === 'h') as any;
    expect(px.fontSize).toBe(66);
    const tiny = applyChanges(doc(), [{ id: 'h', tam: 10 }], palette).doc.elements.find((e) => e.id === 'h') as any;
    expect(tiny.fontSize).toBe(45); // 10 px es menos del 75 %: se limita
  });

  it('ordena según la IA y vuelve a la pieza del motor si la corrección la empeora', () => {
    const proposals = [{ doc: doc(), family: 'A' }, { doc: doc(), family: 'B' }, { doc: doc(), family: 'C' }];
    const raw = {
      orden: [2, 0, 7, 2],
      propuestas: [
        { indice: 0, motivo: 'Titular más claro', cambios: [{ id: 'h', texto: 'Tacos al pastor de verdad' }] },
        { indice: 1, motivo: 'Más grande', cambios: [{ id: 'h', tam: 1.3 }] },
      ],
    };
    // La propuesta B queda con un error de calidad nuevo: se revierte
    const quality = (d: DesignDoc, p: any) => (p.family === 'B' && (d.elements[0] as any).fontSize > 60 ? [{ code: 'X', severity: 'BLOCK', kind: 'VERIFIED', message: 'se sale' }] : []) as any;
    const r = applyReview(proposals, raw, { format: 'IG_POST', palette: [...palette], quality });
    expect(r.used).toBe(true);
    expect(r.proposals.map((p) => p.family)).toEqual(['C', 'A', 'B']);
    expect(r.proposals[1]).toMatchObject({ aiReview: { changes: 1, note: 'Titular más claro', reverted: false } });
    expect((r.proposals[1].doc.elements[0] as any).text).toBe('Tacos al pastor de verdad');
    expect(r.proposals[2]).toMatchObject({ aiReview: { changes: 0, reverted: true } });
    expect((r.proposals[2].doc.elements[0] as any).fontSize).toBe(60);
  });

  it('la instrucción lleva el pedido, la paleta y las piezas, sin datos de clientes', () => {
    const msgs = reviewMessages({ request: 'Promo de tacos para oficinas', business: 'Taquería Lúa', format: 'IG_POST', palette: ['#E63946'], proposals: [{ doc: doc(), family: 'A' }] });
    const all = msgs.map((m) => String(m.content)).join('\n');
    expect(all).toContain('Promo de tacos para oficinas');
    expect(all).toContain('#E63946');
    expect(all).toContain('"id":"h"');
    expect(all).toMatch(/Nunca: inventes precios/);
  });
});

describe('Creative: el motor crea y la IA corrige (solo si hay IA)', () => {
  function world(company: Record<string, any> = {}) {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'Aurora', planId: 'p1', onboardingJson: JSON.stringify({ businessType: 'cafetería' }), ...company });
    db.brandAsset.push({ id: 'p1', companyId: 'coA', kind: 'IMAGE', name: 'latte', fileName: 'a', mimeType: 'image/png', sizeBytes: 1, width: 1600, height: 1600 });
    const svc = new CreativeService(prisma as any, audit() as any);
    // La IA "corrige" el titular de la primera pieza que recibe
    const chat = jest.fn(async (opts: any) => {
      const piezas = JSON.parse(String(opts.messages[1].content).split('Piezas: ')[1]);
      const h = piezas[0].elementos.find((e: any) => e.rol === 'headline');
      return { content: JSON.stringify({ orden: [0], propuestas: [{ indice: 0, motivo: 'Titular más vendedor', cambios: [{ id: h.id, texto: 'Latte de la casa, recién hecho' }] }] }), model: 'gemini-2.5-flash', keyLabel: 'g', tokens: 10, provider: 'GEMINI' };
    });
    (svc as any).textAi = new CompanyTextAi(prisma, undefined, { chat } as any);
    return { svc, db, chat };
  }
  const body = { goal: 'PRODUCT', format: 'IG_POST', content: { headline: 'Latte de la casa', photos: ['p1'] }, request: 'Quiero vender el latte' };

  it('sin IA autorizada, entrega las piezas del motor sin llamar a nadie', async () => {
    const w = world();
    const r = await w.svc.proposals(A, body);
    expect(r.ai).toEqual({ used: false, source: 'NINGUNA', note: null });
    expect(w.chat).not.toHaveBeenCalled();
    expect(r.proposals.length).toBeGreaterThan(0);
  });

  it('con la IA de prueba, corrige la pieza, cuenta un uso y deja el motivo', async () => {
    const w = world({ aiTrialJson: trial(3) });
    const r = await w.svc.proposals(A, body);
    expect(w.chat).toHaveBeenCalledTimes(1);
    expect(r.ai).toMatchObject({ used: true, source: 'GENERICA' });
    expect(r.proposals[0]).toMatchObject({ aiReview: { changes: 1, note: 'Titular más vendedor', reverted: false } });
    expect(r.proposals[0].doc.elements.some((e: any) => e.text === 'Latte de la casa, recién hecho')).toBe(true);
    expect(w.db.aiKeyUsage[0]).toMatchObject({ fingerprint: 'coA', requests: 1 });
  });

  it('si la IA falla, entrega las del motor y devuelve el uso', async () => {
    const w = world({ aiTrialJson: trial(3) });
    w.chat.mockRejectedValueOnce(new Error('ocupada'));
    const r = await w.svc.proposals(A, body);
    expect(r.ai).toMatchObject({ used: false, source: 'GENERICA', note: expect.stringMatching(/motor/) });
    expect(w.db.aiKeyUsage[0]?.requests ?? 0).toBe(0);
  });
});

describe('revisión con imagen: solo Gemini', () => {
  it('salta Groq y Cerebras, manda el texto sanitizado con la imagen a Gemini', async () => {
    const { prisma } = createMockPrisma();
    const pool = new GeminiPool(prisma as any);
    (pool as any).chain = async () => ({ entries: [
      { provider: 'GROQ', model: 'llama', enabled: true },
      { provider: 'GEMINI', model: 'gemini-2.5-flash', enabled: true },
    ] });
    const groq = jest.fn();
    const gemini = jest.fn(async (model: string, _o: any) => ({ result: { content: '{"ok":true}', model, keyLabel: 'g1', tokens: 5 }, error: '' }));
    (pool.keyed as any).GROQ.tryModel = groq;
    (pool.keyed as any).GEMINI.tryModel = gemini;
    const r = await pool.chatVision({ messages: [{ role: 'user', content: 'Revisa mi anuncio, escríbeme al 3001234567' }], imageDataUrl: 'data:image/jpeg;base64,AAAA' });
    expect(r).toMatchObject({ provider: 'GEMINI', content: '{"ok":true}' });
    expect(groq).not.toHaveBeenCalled();
    const sent = (gemini.mock.calls[0] as any)[1].messages[0].content;
    expect(sent[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });
    expect(sent[0].text).not.toContain('3001234567'); // el teléfono se quita igual
    await expect(pool.chatVision({ messages: [], imageDataUrl: 'https://x.co/a.png' })).rejects.toThrow(/inválida/);
  });
});
