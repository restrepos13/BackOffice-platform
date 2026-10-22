/**
 * Dirección de arte de Creative: identidad visual con procedencia, familias
 * de composición, diferenciación real entre marcas, diversidad sin forzarla,
 * control de calidad, adaptación de formatos y aislamiento entre empresas.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import { CreativeService } from '../src/modules/creative.module';
import { FORMATS, FormatKey, validateDesignDoc } from '../src/common/design-doc';
import { resolveIdentity, sanitizeVisual, suggestVisual } from '../src/common/creative/identity';
import { Content, FAMILIES, Family, compose, tokensFor } from '../src/common/creative/compose';
import { propose, rank } from '../src/common/creative/art-direction';
import { checkQuality } from '../src/common/creative/quality';
import { adaptDesign, contentOf, scaleAdapt } from '../src/common/creative/adapt';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };

const ident = (over: Partial<Parameters<typeof resolveIdentity>[0]> = {}) => resolveIdentity({
  visual: null, sector: 'COMIDA', tone: 'cercano', colors: ['#7A3E1D', '#F6EFE6', '#E8A33D', '#3B2416'], fonts: [], logoAssetId: 'logo1', restrictions: [], ...over,
});
const dims = { logo1: { width: 600, height: 600 }, p1: { width: 1600, height: 1600 }, p2: { width: 1600, height: 1200 }, p3: { width: 1200, height: 1200 } };
const full: Content = {
  kicker: 'Nuevo', headline: 'Café de origen Urrao, tostado esta semana', body: 'Notas de panela y cacao. Pregunta por la bolsa de 250 g.',
  price: '$38.000', cta: 'Pide por WhatsApp', validity: 'Hasta el 15 de noviembre', date: { day: '08', month: 'Nov' }, place: 'Laureles · sábado 10 a. m.',
  quote: 'El mejor desayuno del barrio, siempre recién horneado.', author: 'Ana M., clienta',
  items: [{ name: 'Latte', price: '$9.500', assetId: 'p1' }, { name: 'Croissant', price: '$8.500', assetId: 'p2' }, { name: 'Cold brew', price: '$11.000' }],
  points: ['Tostamos cada semana', 'Café 100 % colombiano', 'Domicilio en 30 minutos'],
  photos: ['p1', 'p2'],
};
const qctx = (over: object = {}) => ({ brandLogoIds: ['logo1'], confirmedPrices: [38000, 9500, 8500, 11000], confirmedOffers: [], assetDims: dims, ownedAssetIds: new Set(['logo1', 'p1', 'p2', 'p3']), ...over });

/** Firma estructural: qué hay y dónde (en proporciones), sin colores. */
function structure(doc: ReturnType<typeof compose>) {
  return doc.elements.map((e) => `${e.type}:${e.role ?? ''}:${Math.round((e.x / doc.width) * 10)},${Math.round((e.y / doc.height) * 10)},${Math.round((e.width / doc.width) * 10)}x${Math.round((e.height / doc.height) * 10)}`).join('|');
}

describe('Identidad visual', () => {
  it('cada valor dice si es confirmado, sugerido o por defecto; lo confirmado manda', () => {
    const def = ident({ sector: 'GENERAL', tone: '' });
    expect(def.personality.source).toBe('SUGGESTED');
    const conf = ident({ visual: sanitizeVisual({ personality: ['ELEGANTE'], photoStyle: 'SIN_FOTO' }) });
    expect(conf.personality).toEqual({ value: ['ELEGANTE'], source: 'CONFIRMED' });
    expect(conf.photoStyle.value).toBe('SIN_FOTO');
    expect(ident().personality.value).toContain('CALIDA');
  });

  it('limpia lo que llega del panel y la sugerencia no se aplica sola', () => {
    const v = sanitizeVisual({ positioning: 'HACKER', personality: ['ELEGANTE', 'x', 'ENERGICA', 'AUDAZ', 'CALIDA'], colorRoles: { primary: 'red', accent: '#00ff00' }, references: ['ok_1', '../etc'] });
    expect(v.positioning).toBeNull();
    expect(v.personality).toEqual(['ELEGANTE', 'ENERGICA', 'AUDAZ']);
    expect(v.colorRoles).toEqual({ primary: undefined, accent: '#00FF00', background: undefined, text: undefined });
    expect(v.references).toEqual(['ok_1']);
    // Lo negado no cuenta: "nunca técnico" no vuelve profesional a la marca
    expect(suggestVisual('COMIDA', 'Cálido y cercano, nunca técnico ni formal').values.personality).not.toContain('PROFESIONAL');
    const s = suggestVisual('BELLEZA', 'elegante y cercano');
    expect(s.values.personality).toEqual(expect.arrayContaining(['ELEGANTE', 'CALIDA']));
    expect(s.reasons.at(-1)).toMatch(/punto de partida/);
  });
});

describe('Motor de composición', () => {
  const formats = Object.keys(FORMATS) as FormatKey[];
  const identities = {
    calida: ident(),
    elegante: ident({ visual: sanitizeVisual({ personality: ['ELEGANTE', 'MINIMALISTA'], density: 'AIREADA', alignment: 'CENTRADA' }), fonts: ['Playfair Display', 'Lato'] }),
    energica: ident({ visual: sanitizeVisual({ personality: ['ENERGICA', 'AUDAZ'] }), fonts: ['Anton', 'Inter'], colors: ['#111111', '#FFE500', '#FF3D00', '#FFFFFF'] }),
  };

  for (const [name, id] of Object.entries(identities)) {
    for (const family of FAMILIES) {
      it(`${family} · marca ${name}: documento válido y editable en los 4 formatos, sin texto cortado ni encimado`, () => {
        for (const f of formats) {
          const doc = compose(family, tokensFor(id, f, 7, 'Aurora'), full, 0, dims);
          expect(() => validateDesignDoc(JSON.parse(JSON.stringify(doc)), f)).not.toThrow();
          expect(doc.elements.length).toBeGreaterThan(2);
          expect(doc.elements.some((e) => e.type === 'text' && e.role === 'headline' || e.role === 'quote')).toBe(true);
          const issues = checkQuality(doc, qctx());
          const bad = issues.filter((i) => ['OFF_CANVAS', 'OVERLAP', 'FOREIGN_ASSET', 'LOW_CONTRAST'].includes(i.code));
          expect({ family, format: f, bad: bad.map((b) => `${b.code}:${b.elementName}`) }).toEqual({ family, format: f, bad: [] });
        }
      });
    }
  }

  it('es determinista: misma entrada, mismo documento', () => {
    const t = tokensFor(identities.calida, 'IG_POST', 7, 'Aurora');
    expect(compose('MODULAR', t, full, 1, dims)).toEqual(compose('MODULAR', t, full, 1, dims));
  });

  it('cambiar solo la paleta NO cambia la estructura; cambiar la identidad sí', () => {
    const base = ident({ visual: sanitizeVisual({ personality: ['CALIDA'] }) });
    const otherPalette = ident({ visual: sanitizeVisual({ personality: ['CALIDA'] }), colors: ['#1F3A5F', '#F2F2F2', '#2EC4B6', '#0B132B'] });
    const s1 = structure(compose('EDITORIAL', tokensFor(base, 'IG_POST', 7, 'X'), full, 0, dims));
    const s2 = structure(compose('EDITORIAL', tokensFor(otherPalette, 'IG_POST', 7, 'X'), full, 0, dims));
    expect(s1).toBe(s2); // solo color: no cuenta como diseño distinto
    const s3 = structure(compose('EDITORIAL', tokensFor(identities.elegante, 'IG_POST', 7, 'X'), full, 0, dims));
    expect(s3).not.toBe(s1); // márgenes, alineación y jerarquía distintos
  });

  it('las familias tienen estructuras realmente distintas entre sí', () => {
    const t = tokensFor(identities.calida, 'IG_POST', 7, 'X');
    const sigs = new Set(FAMILIES.map((f) => structure(compose(f, t, full, 0, dims))));
    expect(sigs.size).toBe(FAMILIES.length);
  });
});

describe('Dirección de arte', () => {
  const req = (over: object = {}) => ({ goal: 'PRODUCT' as const, format: 'IG_POST' as FormatKey, content: full, recent: [] as Family[], seed: 1, companySeed: 7, brandName: 'Aurora', dims, ...over });

  it('dos empresas del mismo rubro con identidades distintas reciben direcciones distintas', () => {
    const calida = ident();
    const elegante = ident({ visual: sanitizeVisual({ personality: ['ELEGANTE', 'MINIMALISTA'], photoStyle: 'ENMARCADA' }) });
    const r1 = propose(calida, req()).proposals[0];
    const r2 = propose(elegante, req()).proposals[0];
    expect(r1.family).toBe('HERO_PHOTO');
    expect(r2.family).toBe('EDITORIAL');
    expect(r2.reason).toMatch(/personalidad/);
  });

  it('propone hasta 3 estructuras distintas, explica por qué, y si solo una encaja no inventa más', () => {
    const r = propose(ident(), req());
    expect(r.proposals.length).toBe(3);
    expect(new Set(r.proposals.map((p) => p.family)).size).toBe(3);
    expect(r.proposals[0].reason).toMatch(/^Recomendada porque/);
    const event = propose(ident(), req({ goal: 'EVENT', content: { headline: 'Cata de café', date: { day: '08', month: 'Nov' }, photos: [] } }));
    expect(event.proposals.map((p) => p.family)).toEqual(['EVENT']);
    expect(event.note).toMatch(/una sola dirección/);
  });

  it('sin foto no propone familias que la necesitan, y lo dice', () => {
    const r = propose(ident(), req({ content: { ...full, photos: [] } }));
    expect(r.proposals.map((p) => p.family)).not.toContain('HERO_PHOTO');
    expect(r.unavailable.find((u) => u.family === 'HERO_PHOTO')!.why).toMatch(/foto/);
  });

  it('evita repetir lo reciente, salvo que se pida consistencia de campaña', () => {
    const fresh = rank(ident(), req({ recent: ['HERO_PHOTO', 'HERO_PHOTO', 'HERO_PHOTO'] }))[0];
    expect(fresh.family).not.toBe('HERO_PHOTO');
    const camp = propose(ident(), req({ recent: ['HERO_PHOTO', 'HERO_PHOTO'], consistentWith: 'HERO_PHOTO' }));
    expect(camp.proposals.map((p) => p.family)).toEqual(['HERO_PHOTO']);
    expect(camp.note).toMatch(/campaña/);
  });

  it('la misma semilla reproduce las propuestas', () => {
    expect(propose(ident(), req({ seed: 42 }))).toEqual(propose(ident(), req({ seed: 42 })));
  });
});

describe('Control de calidad', () => {
  const t = tokensFor(ident(), 'IG_POST', 7, 'Aurora');
  const base = () => compose('EDITORIAL', t, full, 0, dims);

  it('no modifica el documento', () => {
    const d = base();
    const copy = JSON.stringify(d);
    checkQuality(d, qctx());
    expect(JSON.stringify(d)).toBe(copy);
  });

  it('bloquea texto cortado por el borde e imágenes ajenas; avisa lo demás', () => {
    const d = base();
    const h = d.elements.find((e) => e.role === 'headline')!;
    h.x = 900;
    (d.elements.find((e) => e.type === 'image' && e.role === 'photo') as any).assetId = 'deOtraEmpresa';
    const codes = checkQuality(d, qctx()).map((i) => `${i.severity}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['BLOCK:OFF_CANVAS', 'BLOCK:FOREIGN_ASSET']));
  });

  it('precio no confirmado, contraste bajo, letra pequeña y logo ausente', () => {
    const d = base();
    const body = d.elements.find((e) => e.role === 'headline') as any;
    body.text = 'Ahora a $12.345 y 30% menos';
    body.fill = '#F6EFE6';
    body.fontSize = 14;
    d.elements = d.elements.filter((e) => e.role !== 'logo');
    const issues = checkQuality(d, qctx());
    const codes = issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['UNCONFIRMED_PRICE', 'UNCONFIRMED_DISCOUNT', 'LOW_CONTRAST', 'SMALL_TEXT', 'NO_LOGO']));
    expect(issues.find((i) => i.code === 'SMALL_TEXT')!.kind).toBe('HEURISTIC');
    // El precio confirmado no se marca
    body.text = 'Bolsa de 250 g a $38.000';
    expect(checkQuality(d, qctx()).map((i) => i.code)).not.toContain('UNCONFIRMED_PRICE');
  });

  it('la medición real del editor manda sobre la estimación del servidor', () => {
    const d = base();
    const h = d.elements.find((e) => e.role === 'headline')!;
    const est = checkQuality(d, qctx()).find((i) => i.code === 'TEXT_OVERFLOW' && i.elementId === h.id);
    expect(est).toBeUndefined();
    const real = checkQuality(d, qctx({ measured: { [h.id]: h.height * 2 } })).find((i) => i.code === 'TEXT_OVERFLOW' && i.elementId === h.id);
    expect(real).toMatchObject({ kind: 'VERIFIED', severity: 'WARN' });
  });

  it('historias: avisa lo que queda bajo la interfaz (guía, no regla oficial)', () => {
    const d = compose('TYPE_DOMINANT', tokensFor(ident(), 'STORY', 7, 'Aurora'), full, 0, dims);
    expect(checkQuality(d, qctx()).filter((i) => i.code === 'STORY_SAFE_ZONE')).toEqual([]);
    const k = d.elements.find((e) => e.type === 'text')!;
    k.y = 40;
    const w = checkQuality(d, qctx()).find((i) => i.code === 'STORY_SAFE_ZONE')!;
    expect(w).toMatchObject({ severity: 'WARN', kind: 'HEURISTIC' });
  });

  it('señala la repetición como información, no como error', () => {
    const issue = checkQuality(base(), qctx({ family: 'EDITORIAL', recentFamilies: ['EDITORIAL', 'EDITORIAL', 'EDITORIAL', 'TIPS'] })).find((i) => i.code === 'REPETITION')!;
    expect(issue.severity).toBe('INFO');
  });
});

describe('Adaptación de formatos', () => {
  it('recompone la misma dirección y conserva lo que la persona editó', () => {
    const id = ident();
    const doc = compose('OFFER', tokensFor(id, 'IG_POST', 7, 'Aurora'), full, 0, dims);
    (doc.elements.find((e) => e.role === 'headline') as any).text = 'Texto que escribió la persona';
    const { doc: story, method } = adaptDesign(doc, { family: 'OFFER', variant: 0, goal: 'PROMO', seed: 1 }, 'STORY', tokensFor(id, 'STORY', 7, 'Aurora'), dims);
    expect(method).toBe('RECOMPOSED');
    expect(story.format).toBe('STORY');
    expect(contentOf(story).headline).toBe('Texto que escribió la persona');
    expect(contentOf(story).price).toBe('$38.000');
    const bad = checkQuality(story, qctx()).filter((i) => ['OFF_CANVAS', 'OVERLAP'].includes(i.code));
    expect(bad).toEqual([]);
  });

  it('los diseños anteriores (sin dirección de arte) se escalan y siguen siendo válidos', () => {
    const legacy = { schemaVersion: 1, format: 'IG_POST' as FormatKey, width: 1080, height: 1080, background: { color: '#FFFFFF', assetId: null }, elements: [{ id: 't1', type: 'text', name: 'T', text: 'Hola', x: 100, y: 100, width: 800, height: 100, rotation: 0, opacity: 1, visible: true, locked: false, fontFamily: 'Inter', fontSize: 60, fontStyle: 'normal', align: 'left', lineHeight: 1.2, letterSpacing: 0, fill: '#111111', textDecoration: '', role: 'headline' }] };
    expect(() => validateDesignDoc(legacy, 'IG_POST')).not.toThrow();
    const r = adaptDesign(legacy as any, null, 'FB_POST', tokensFor(ident(), 'FB_POST', 7, 'X'), {});
    expect(r.method).toBe('SCALED');
    expect(() => validateDesignDoc(r.doc, 'FB_POST')).not.toThrow();
    expect(scaleAdapt(legacy as any, 'STORY').elements[0].x).toBeGreaterThanOrEqual(0);
  });
});

describe('Servicio de Creative con dirección de arte', () => {
  function world() {
    const { prisma, db } = createMockPrisma();
    db.company.push(
      { id: 'coA', name: 'Aurora', planId: 'p1', onboardingJson: JSON.stringify({ businessType: 'cafetería' }) },
      { id: 'coB', name: 'Otra', planId: 'p1', onboardingJson: JSON.stringify({ businessType: 'cafetería' }) },
    );
    db.brandAsset.push(
      { id: 'p1', companyId: 'coA', kind: 'IMAGE', name: 'latte', fileName: 'a', mimeType: 'image/png', sizeBytes: 1, width: 1600, height: 1600 },
      { id: 'pb', companyId: 'coB', kind: 'IMAGE', name: 'ajena', fileName: 'b', mimeType: 'image/png', sizeBytes: 1, width: 1600, height: 1600 },
    );
    return { prisma, db, svc: new CreativeService(prisma as any, audit as any) };
  }

  it('propone, crea desde la propuesta con su composición y registra los eventos', async () => {
    const { svc, db } = world();
    const r = await svc.proposals(A, { goal: 'PRODUCT', format: 'IG_POST', content: { headline: 'Latte de la casa', price: '$9.500', photos: ['p1'] } });
    expect(r.proposals.length).toBeGreaterThan(0);
    const p = r.proposals[0];
    const d = await svc.createDesign(A, { format: 'IG_POST', doc: p.doc, composition: p.composition });
    expect((d as any).composition.family).toBe(p.family);
    expect(db.creativeEvent.map((e: any) => e.type)).toEqual(['composition_suggested', 'composition_selected']);
  });

  it('B no puede usar fotos de A ni adaptar, revisar o etiquetar eventos de diseños de A', async () => {
    const { svc } = world();
    await expect(svc.proposals(B, { goal: 'PRODUCT', content: { headline: 'x', photos: ['p1'] } })).rejects.toThrow(/no es un recurso de tu empresa/);
    const r = await svc.proposals(A, { goal: 'PRODUCT', content: { headline: 'Latte', photos: ['p1'] } });
    const d = await svc.createDesign(A, { format: 'IG_POST', doc: r.proposals[0].doc, composition: r.proposals[0].composition });
    await expect(svc.adapt(B, d.id, { format: 'STORY' })).rejects.toThrow(/no encontrado/);
    await expect(svc.check(B, d.id, {})).rejects.toThrow(/no encontrado/);
    await expect(svc.clientEvent(B, { type: 'manual_edit', designId: d.id })).rejects.toThrow(/no encontrado/);
    // Un documento armado a mano con la foto de otra empresa tampoco pasa
    const stolen = { ...r.proposals[0].doc, elements: r.proposals[0].doc.elements.map((e: any) => (e.type === 'image' && e.role === 'photo' ? { ...e, assetId: 'pb' } : e)) };
    await expect(svc.createDesign(A, { format: 'IG_POST', doc: stolen, composition: r.proposals[0].composition })).rejects.toThrow();
  });

  it('adaptar crea una copia nueva y deja el original igual', async () => {
    const { svc, db } = world();
    const r = await svc.proposals(A, { goal: 'PROMO', content: { headline: '2x1 en croissants', price: '$8.500', validity: 'Hasta el domingo', photos: ['p1'] } });
    const d = await svc.createDesign(A, { format: 'IG_POST', doc: r.proposals[0].doc, composition: r.proposals[0].composition });
    const before = db.creativeDesign.find((x: any) => x.id === d.id)!.docJson;
    const copy = await svc.adapt(A, d.id, { format: 'STORY' });
    expect(copy.method).toBe('RECOMPOSED');
    expect(copy.format).toBe('STORY');
    expect(db.creativeDesign.find((x: any) => x.id === d.id)!.docJson).toBe(before);
    expect((copy as any).composition.adaptedFrom).toBe(d.id);
  });

  it('la identidad visual se guarda por empresa y una referencia ajena se rechaza', async () => {
    const { svc } = world();
    const saved = await svc.saveVisual(A, { visual: { personality: ['ELEGANTE'], density: 'AIREADA' } });
    expect(saved.resolved.personality).toEqual({ value: ['ELEGANTE'], source: 'CONFIRMED' });
    expect((await svc.visual(B)).resolved.personality.source).not.toBe('CONFIRMED');
    await expect(svc.saveVisual(A, { visual: { references: ['pb'] } })).rejects.toThrow(/no es un recurso de tu empresa/);
  });

  it('la revisión para exportar registra solo conteos y códigos', async () => {
    const { svc, db } = world();
    const r = await svc.proposals(A, { goal: 'PRODUCT', content: { headline: 'Latte', photos: ['p1'] } });
    const d = await svc.createDesign(A, { format: 'IG_POST', doc: r.proposals[0].doc, composition: r.proposals[0].composition });
    const res = await svc.check(A, d.id, { forExport: true });
    expect(res).toHaveProperty('blocking');
    const ev = db.creativeEvent.find((e: any) => e.type === 'quality_warnings')!;
    expect(Object.keys(JSON.parse(ev.dataJson)).sort()).toEqual(['block', 'codes', 'warn']);
  });
});
