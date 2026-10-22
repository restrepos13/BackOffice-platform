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

import { emphasisSplit, moodOf, LAYOUTS } from '../src/common/creative/compose';
import { droppedFields } from '../src/common/creative/art-direction';
import { fingerprint, structuralSimilarity, SAME_STRUCTURE } from '../src/common/creative/similarity';

describe('Laboratorio visual · mejoras respaldadas por hallazgos', () => {
  const sim = (a: any, b: any) => structuralSimilarity(fingerprint(a), fingerprint(b));
  const testimonialContent: Content = { headline: 'Bajé 8 kilos', quote: 'Bajé 8 kilos y gané fuerza en tres meses.', author: 'Camilo T.', photos: ['p1'] };

  it('el énfasis va a la oferta y nunca deja una preposición colgando', () => {
    expect(emphasisSplit('2x1 en croissants de la tarde')).toEqual({ first: true, a: 'en croissants de la tarde', emph: '2x1' });
    expect(emphasisSplit('Ritual de noche con 20 % menos')).toEqual({ first: false, a: 'Ritual de noche con', emph: '20 % menos' });
    expect(emphasisSplit('Inscripción gratis este mes').emph).toBe('gratis este mes');
    expect(emphasisSplit('Diagnóstico financiero sin costo').emph).toBe('sin costo');
    const plain = emphasisSplit('Para acompañar tu tarde de domingo');
    expect(plain.a.split(' ').at(-1)).not.toMatch(/^(de|la|tu|en|con)$/i);
  });

  it('cada carácter de marca recibe una ESTRUCTURA de testimonio distinta (no solo otro color)', () => {
    const ids = {
      CLEAR: ident({ visual: sanitizeVisual({ personality: ['PROFESIONAL'] }) }),
      REFINED: ident({ visual: sanitizeVisual({ personality: ['ELEGANTE'] }) }),
      WARM: ident({ visual: sanitizeVisual({ personality: ['CALIDA'] }) }),
      BOLD: ident({ visual: sanitizeVisual({ personality: ['ENERGICA'] }) }),
    };
    const docs = Object.entries(ids).map(([mood, id]) => {
      expect(moodOf(id)).toBe(mood);
      // Semilla de empresa 0: la estructura preferida de cada carácter (sin desempates)
      return propose(id, { goal: 'TESTIMONIAL', format: 'IG_POST', content: testimonialContent, recent: [], seed: 1, companySeed: 0, brandName: 'X', dims }).proposals[0].doc;
    });
    for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) expect(sim(docs[i], docs[j])).toBeLessThan(SAME_STRUCTURE);
  });

  it('dos marcas con el MISMO carácter pueden recibir estructuras distintas (desempate por empresa, reproducible)', () => {
    const warm = ident({ visual: sanitizeVisual({ personality: ['CALIDA'] }) });
    const info: Content = { headline: 'Así trabajamos', points: ['Uno', 'Dos', 'Tres'], cta: 'Escríbenos', photos: [] };
    const run = (companySeed: number) => propose(warm, { goal: 'INFO', format: 'IG_POST', content: info, recent: [], seed: 1, companySeed, brandName: 'X', dims }).proposals[0];
    const a = run(0);
    const b = run(1);
    expect(a.family).toBe(b.family);
    expect(sim(a.doc, b.doc)).toBeLessThan(SAME_STRUCTURE);
    expect(run(0)).toEqual(a);
  });

  it('las estructuras de oferta, testimonio, consejo e informativo son distintas entre sí', () => {
    const t = tokensFor(ident(), 'IG_POST', 7, 'X');
    for (const fam of ['OFFER', 'TESTIMONIAL', 'TIPS', 'CORPORATE_INFO'] as const) {
      const docs = Array.from({ length: LAYOUTS[fam].count }, (_, v) => compose(fam, t, full, v, dims));
      for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
        // Las dos bandas del consejo (lateral/superior) son variantes menores del mismo esquema
        if (fam === 'TIPS' && i === 0 && j === 1) continue;
        expect({ fam, i, j, s: sim(docs[i], docs[j]) < SAME_STRUCTURE }).toEqual({ fam, i, j, s: true });
      }
    }
  });

  it('no se pierde contenido en silencio: Editorial muestra los puntos y lo que no entra se informa', () => {
    const info: Content = { headline: 'Cómo trabajamos', points: ['Uno', 'Dos', 'Tres'], cta: 'Conversemos', photos: [] };
    const doc = compose('EDITORIAL', tokensFor(ident(), 'IG_POST', 7, 'X'), info, 0, dims);
    expect(doc.elements.filter((e) => e.role === 'point')).toHaveLength(3);
    expect(droppedFields('TYPE_DOMINANT', info)).toEqual(['points']);
    const r = propose(ident(), { goal: 'INFO', format: 'IG_POST', content: info, recent: [], seed: 1, companySeed: 7, brandName: 'X', dims });
    expect(r.proposals.map((p) => p.family)).not.toContain('TYPE_DOMINANT');
  });

  it('en una promoción con foto, el precio va en un sello visible', () => {
    const doc = compose('HERO_PHOTO', tokensFor(ident(), 'IG_POST', 7, 'X'), { headline: '2x1 en croissants', price: '2x1', photos: ['p1'] }, 0, dims);
    expect(doc.elements.some((e) => e.role === 'badge')).toBe(true);
    expect((doc.elements.find((e) => e.role === 'price') as any).fontSize).toBeGreaterThan(60);
  });

  it('catálogo de 3 productos en cuadrado: una fila de tarjetas altas (sin celda vacía)', () => {
    const doc = compose('CATALOG', tokensFor(ident(), 'IG_POST', 7, 'X'), full, 0, dims);
    const cards = doc.elements.filter((e) => e.name === 'Tarjeta');
    expect(cards).toHaveLength(3);
    expect(new Set(cards.map((c) => c.y)).size).toBe(1);
    expect(cards[0].height).toBeGreaterThan(cards[0].width);
  });

  it('si la estructura preferida repite una pieza reciente, elige otra estructura de la misma familia', () => {
    const id = ident({ visual: sanitizeVisual({ personality: ['ELEGANTE'] }) });
    const base = { goal: 'TESTIMONIAL' as const, format: 'IG_POST' as FormatKey, content: testimonialContent, recent: [] as Family[], seed: 1, companySeed: 7, brandName: 'X', dims };
    const first = propose(id, base).proposals[0];
    const again = propose(id, { ...base, recent: ['TESTIMONIAL'], recentPrints: [fingerprint(first.doc)] }).proposals[0];
    expect(again.family).toBe('TESTIMONIAL');
    expect(again.variant).not.toBe(first.variant);
    expect(sim(first.doc, again.doc)).toBeLessThan(SAME_STRUCTURE);
  });

  it('calidad: repetición medida por estructura, espacio vacío y precio poco visible', () => {
    const t = tokensFor(ident(), 'IG_POST', 7, 'X');
    const d = compose('EDITORIAL', t, full, 0, dims);
    const fp = fingerprint(d);
    const rep = checkQuality(d, qctx({ recentPrints: [fp, fp, fp] })).find((i) => i.code === 'REPETITION')!;
    expect(rep).toMatchObject({ severity: 'INFO', kind: 'VERIFIED' });
    const sparse = compose('TYPE_DOMINANT', t, { headline: 'Hola', photos: [] }, 0, dims);
    sparse.elements = sparse.elements.filter((e) => e.role !== 'decoration' || e.type === 'text');
    const h = sparse.elements.find((e) => e.role === 'headline')!;
    h.y = 100;
    (sparse.elements.find((e) => e.role === 'logo') as any).y = 90;
    expect(checkQuality(sparse, qctx()).map((i) => i.code)).toContain('EMPTY_SPACE');
    const small = compose('EDITORIAL', t, { headline: 'Una oferta muy buena', price: '$9.500', photos: [] }, 0, dims);
    (small.elements.find((e) => e.role === 'price') as any).fontSize = 20;
    expect(checkQuality(small, qctx()).map((i) => i.code)).toContain('PRICE_NOT_PROMINENT');
  });
});

describe('Fotos del catálogo en Creative', () => {
  it('copia la foto de un producto como recurso (sin duplicar) y no deja usar productos ajenos', async () => {
    const fs = require('fs');
    const path = require('path');
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'A', planId: 'p1' }, { id: 'coB', name: 'B', planId: 'p1' });
    const svc = new CreativeService(prisma as any, audit as any);
    // PNG mínimo real en la carpeta de la empresa
    const dir = path.join(process.env.UPLOADS_DIR ?? path.join(process.cwd(), 'uploads'), 'coA');
    fs.mkdirSync(dir, { recursive: true });
    const png = Buffer.alloc(64); png.writeUInt32BE(0x89504e47, 0); png.writeUInt32BE(0x0d0a1a0a, 4); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(800, 16); png.writeUInt32BE(800, 20);
    fs.writeFileSync(path.join(dir, 'prod-test.png'), png);
    db.product.push({ id: 'pr1', companyId: 'coA', name: 'Latte', price: 9500, active: true, deletedAt: null, imageFile: 'prod-test.png' }, { id: 'pr2', companyId: 'coB', name: 'Ajeno', active: true, deletedAt: null, imageFile: 'x.png' });
    expect((await svc.catalogProducts(A)).map((p: any) => [p.name, p.hasImage])).toEqual([['Latte', true]]);
    const a1 = await svc.assetFromProduct(A, { productId: 'pr1' });
    const a2 = await svc.assetFromProduct(A, { productId: 'pr1' });
    expect(a1.id).toBe(a2.id);
    expect(a1).toMatchObject({ width: 800, height: 800, kind: 'IMAGE' });
    expect(a1.fileName).not.toBe('prod-test.png'); // es una copia: borrar el recurso no rompe el menú
    await expect(svc.assetFromProduct(A, { productId: 'pr2' })).rejects.toThrow(/no encontrado/);
    for (const f of fs.readdirSync(dir)) if (f === 'prod-test.png' || f === a1.fileName) fs.unlinkSync(path.join(dir, f));
  });
});

describe('Laboratorio visual · segunda ronda', () => {
  it('nunca parte una palabra a la mitad (achica el texto hasta que la palabra más larga entra)', () => {
    const { fitSize, wrap } = require('../src/common/creative/text-fit');
    const f = fitSize('ENTRENADORES CERTIFICADOS', { width: 340, maxHeight: 900, font: 'Anton', lineHeight: 1, max: 160, min: 54, upper: true });
    const lines: string[] = wrap('ENTRENADORES CERTIFICADOS', f.size, 340, 'Anton', false, true);
    expect(lines).toEqual(['ENTRENADORES', 'CERTIFICADOS']);
  });

  it('las tarjetas del catálogo miden lo que su contenido (sin blanco sobrante)', () => {
    const doc = compose('CATALOG', tokensFor(ident(), 'IG_POST', 7, 'X'), full, 0, dims);
    const card = doc.elements.find((e) => e.name === 'Tarjeta')!;
    const inside = doc.elements.filter((e) => e.slot === '0' && e.name !== 'Tarjeta' && e.type !== 'rect' || (e.role === 'item-price' && e.slot === '0'));
    const bottom = Math.max(...inside.map((e) => e.y + e.height));
    expect(card.y + card.height - bottom).toBeLessThan(doc.height * 0.06);
  });

  it('en la oferta refinada el precio pesa más que el titular', () => {
    const doc = compose('OFFER', tokensFor(ident({ visual: sanitizeVisual({ personality: ['ELEGANTE'] }) }), 'IG_POST', 7, 'X'), { headline: 'Ritual de noche con 20 % menos', price: '20 %', validity: 'Hasta el 30', cta: 'Descúbrelo', photos: ['p1'] }, 3, dims);
    const price = doc.elements.find((e) => e.role === 'price') as any;
    const head = doc.elements.find((e) => e.role === 'headline') as any;
    expect(price.fontSize).toBeGreaterThan(head.fontSize);
  });
});

describe('Laboratorio visual · tercera ronda', () => {
  it('un precio como "$15.000" no se parte dentro del sello', () => {
    const id = ident({ visual: sanitizeVisual({ personality: ['ENERGICA'] }), fonts: ['Anton', 'Inter'] });
    const doc = compose('HERO_PHOTO', tokensFor(id, 'IG_POST', 7, 'X'), { headline: 'Funcional de 45 minutos', price: '$15.000', photos: ['p1'] }, 1, dims);
    const price = doc.elements.find((e) => e.role === 'price') as any;
    const { wrap } = require('../src/common/creative/text-fit');
    expect(wrap(price.text, price.fontSize, price.width, price.fontFamily, false, false)).toHaveLength(1);
  });
});

describe('Laboratorio visual · cuarta ronda', () => {
  it('editorial con mucho texto: la foto cede alto y el titular conserva su jerarquía', () => {
    const id = ident({ visual: sanitizeVisual({ personality: ['DIVERTIDA'] }), fonts: ['Poppins', 'Nunito'] });
    const c: Content = { headline: 'Bloques de madera natural', body: 'Pintura al agua, sin tóxicos. Desde los 2 años.', price: '$69.000', cta: 'Pídelo ya', photos: ['p1'] };
    const doc = compose('EDITORIAL', tokensFor(id, 'IG_POST', 7, 'X'), c, 0, dims);
    const h = doc.elements.find((e) => e.role === 'headline') as any;
    const others = doc.elements.filter((e) => e.type === 'text' && e.role === 'body') as any[];
    expect(h.fontSize).toBeGreaterThan(Math.max(...others.map((e) => e.fontSize)) * 1.3);
    expect(checkQuality(doc, qctx()).map((i) => i.code)).not.toContain('WEAK_HIERARCHY');
  });

  it('avisa (como heurística) cuando el titular no se distingue del resto', () => {
    const doc = compose('EDITORIAL', tokensFor(ident(), 'IG_POST', 7, 'X'), { headline: 'Titular', body: 'Texto de apoyo', photos: [] }, 0, dims);
    (doc.elements.find((e) => e.role === 'headline') as any).fontSize = 30;
    expect(checkQuality(doc, qctx()).find((i) => i.code === 'WEAK_HIERARCHY')).toMatchObject({ severity: 'INFO', kind: 'HEURISTIC' });
  });
});
