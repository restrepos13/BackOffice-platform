/**
 * Editor ampliado (nov-2026): el esquema acepta degradados, sombras, recortes,
 * filtros, frases destacadas y formas nuevas solo si son válidos (un diseño
 * viejo no cambia); el control de calidad mide el contraste a través de los
 * velos en degradado; y las fotos de Pexels se traen sin que el navegador
 * elija la URL.
 */
import 'reflect-metadata';
import { validateDesignDoc } from '../src/common/design-doc';
import { checkQuality, gradientAt } from '../src/common/creative/quality';
import { resolveIdentity } from '../src/common/creative/identity';
import { compose, lookFor, tokensFor } from '../src/common/creative/compose';
import { CreativeStockService } from '../src/modules/creative-stock';
import { createMockPrisma } from './helpers/mock-prisma';

const base = { rotation: 0, opacity: 1, visible: true, locked: false };
const doc = (elements: any[], background: any = { color: '#FFFFFF', assetId: null }) => ({ schemaVersion: 1, format: 'IG_POST', width: 1080, height: 1080, background, elements });

describe('Esquema del editor ampliado', () => {
  it('guarda lo nuevo cuando es válido y descarta lo inválido sin romper', () => {
    const d = validateDesignDoc(doc([
      { ...base, id: 't1', type: 'text', name: 'T', text: 'Hola 30 % menos', x: 0, y: 0, width: 500, height: 80, fontFamily: 'Fraunces', fontSize: 60, fill: '#111111',
        gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#FF0000' }, { at: 1, color: '#0000FF00' }] },
        accent: { text: '30 % menos', color: '#E8A33D', marker: 'nope', style: 'italic' }, background: { color: '#FFFFFF', padX: 20, padY: 10, radius: 99 }, shadow: { color: '#00000055', blur: 30, x: 0, y: 10 } },
      { ...base, id: 's1', type: 'star', name: 'Sello', x: 0, y: 0, width: 200, height: 200, fill: '#E8A33D', points: 99, innerRatio: 0.86 },
      { ...base, id: 'p1', type: 'path', name: 'Onda', x: 0, y: 0, width: 1080, height: 200, fill: '#FFFFFF', preset: 'no-existe' },
      { ...base, id: 'i1', type: 'image', name: 'Foto', assetId: 'a1', x: 0, y: 0, width: 400, height: 400, mask: 'arch', filters: { brightness: 0.2, contrast: 0, saturation: 0, blur: 0, grayscale: false } },
      { ...base, id: 'i2', type: 'image', name: 'Foto 2', assetId: 'a1', x: 0, y: 0, width: 400, height: 400, mask: 'triangulo', filters: { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: false } },
    ], { color: '#F6EFE6', assetId: 'a1', gradient: { kind: 'radial', angle: 0, stops: [{ at: 0, color: '#FFFFFF' }] }, overlay: { color: '#000000', opacity: 2 } }));
    const [t, s, p, i, i2] = d.elements as any[];
    expect(t.fontFamily).toBe('Fraunces');
    expect(t.gradient.stops).toHaveLength(2);
    expect(t.accent).toEqual({ text: '30 % menos', color: '#E8A33D', marker: null, style: 'italic' });
    expect(t.background.radius).toBe(99);
    expect(t.shadow).toEqual({ color: '#00000055', blur: 30, x: 0, y: 10 });
    expect(s.points).toBe(40);
    expect(p.preset).toBe('blob');
    expect(i.mask).toBe('arch');
    expect(i.filters.brightness).toBe(0.2);
    // Recorte desconocido y filtros en cero: no se guarda nada
    expect(i2.mask).toBeUndefined();
    expect(i2.filters).toBeUndefined();
    // Un degradado de una sola parada no es degradado; la opacidad del velo se acota
    expect(d.background.gradient).toBeUndefined();
    expect(d.background.overlay).toEqual({ color: '#000000', gradient: null, opacity: 1 });
  });

  it('un diseño viejo queda exactamente igual', () => {
    const legacy = doc([{ ...base, id: 'r1', type: 'rect', name: 'R', x: 1, y: 2, width: 3, height: 4, fill: '#111111', stroke: '#00000000', strokeWidth: 0, cornerRadius: 0 }]);
    expect(validateDesignDoc(legacy)).toEqual(legacy);
  });

  it('rechaza tipos desconocidos y fuentes fuera de la lista quedan en Inter', () => {
    expect(() => validateDesignDoc(doc([{ ...base, id: 'x', type: 'svg', name: 'X', x: 0, y: 0, width: 1, height: 1 }]))).toThrow(/tipo desconocido/);
    const d = validateDesignDoc(doc([{ ...base, id: 't', type: 'text', name: 'T', text: 'a', x: 0, y: 0, width: 10, height: 10, fontFamily: 'Comic Sans' }]));
    expect((d.elements[0] as any).fontFamily).toBe('Inter');
  });
});

describe('Calidad con degradados y frases destacadas', () => {
  it('lee el color y la opacidad de un velo en degradado', () => {
    const g = { kind: 'linear' as const, angle: 90, stops: [{ at: 0, color: '#00000000' }, { at: 1, color: '#000000FF' }] };
    expect(gradientAt(g, { x: 0, y: 0, w: 100, h: 100 }, 50, 0).alpha).toBeCloseTo(0);
    expect(gradientAt(g, { x: 0, y: 0, w: 100, h: 100 }, 50, 100).alpha).toBeCloseTo(1);
  });

  it('texto blanco sobre la parte densa del velo se mide contra el velo; sobre la parte transparente, contra la foto', () => {
    const veil = { ...base, id: 'v', type: 'rect', name: 'Velo', x: 0, y: 300, width: 1080, height: 780, fill: '#1A1A1A', stroke: '#00000000', strokeWidth: 0, cornerRadius: 0, gradient: { kind: 'linear', angle: 90, stops: [{ at: 0, color: '#1A1A1A00' }, { at: 0.3, color: '#1A1A1AD1' }, { at: 1, color: '#1A1A1AF5' }] } };
    const text = (id: string, y: number) => ({ ...base, id, type: 'text', name: id, text: 'Titular', x: 100, y, width: 800, height: 80, fontFamily: 'Inter', fontSize: 60, fontStyle: 'bold', align: 'left', lineHeight: 1.1, letterSpacing: 0, fill: '#FFFFFF', textDecoration: '' });
    const d = validateDesignDoc(doc([{ ...base, id: 'f', type: 'image', name: 'Foto', assetId: 'a1', x: 0, y: 0, width: 1080, height: 1080, crop: null, cornerRadius: 0 }, veil, text('abajo', 800), text('arriba', 310)]));
    const issues = checkQuality(d, { brandLogoIds: [], confirmedPrices: [], confirmedOffers: [], assetDims: { a1: { width: 2000, height: 2000 } }, ownedAssetIds: new Set(['a1']) });
    expect(issues.find((i) => i.elementId === 'abajo')).toBeUndefined();
    expect(issues.find((i) => i.elementId === 'arriba')?.code).toBe('CONTRAST_UNKNOWN');
  });

  it('avisa cuando la frase destacada no se lee', () => {
    const d = validateDesignDoc(doc([{ ...base, id: 't', type: 'text', name: 'Titular', text: 'Hoy 2x1 en todo', x: 100, y: 100, width: 800, height: 80, fontFamily: 'Inter', fontSize: 60, fill: '#111111', accent: { text: '2x1', color: '#FFFF00', marker: null, style: 'normal' } }]));
    const issues = checkQuality(d, { brandLogoIds: [], confirmedPrices: [], confirmedOffers: [], assetDims: {}, ownedAssetIds: new Set() });
    expect(issues.some((i) => i.code === 'LOW_CONTRAST' && /frase destacada/.test(i.message))).toBe(true);
  });
});

describe('Acabado según el carácter de la marca', () => {
  const id = (personality: string[], fonts: string[] = [], seed?: number) => resolveIdentity({ visual: { personality } as any, sector: 'COMIDA', tone: '', colors: ['#7A3E1D', '#F6EFE6', '#E8A33D', '#3B2416'], fonts, logoAssetId: null, restrictions: [], seed });

  it('las marcas refinadas no llevan sombras; las enérgicas, sombra dura y sello en estrella', () => {
    expect(lookFor('REFINED', 1)).toMatchObject({ depth: 'NONE', badge: 'CIRCLE', emphasis: 'ITALIC' });
    expect(lookFor('BOLD', 1)).toMatchObject({ depth: 'HARD', badge: 'BURST', emphasis: 'MARKER' });
  });

  it('la fuente sugerida varía por empresa pero nunca pisa la que la marca confirmó', () => {
    const titles = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => id(['ELEGANTE'], [], s).fonts.title));
    expect(titles.size).toBeGreaterThan(1);
    expect(id(['ELEGANTE']).fonts.title).toBe('Playfair Display');
    expect(id(['ELEGANTE'], ['Inter', 'Lato'], 7).fonts).toMatchObject({ title: 'Inter', body: 'Lato' });
  });

  it('una oferta de marca cálida usa estrella, sombra y frase destacada legibles', () => {
    const ident = id(['CALIDA'], ['Lora', 'Lato']);
    const t = tokensFor(ident, 'IG_POST', 3, 'Café');
    const d = compose('OFFER', t, { headline: 'Croissants con 2x1 esta tarde', price: '2x1', cta: 'Ven', photos: ['p1'] }, 0, { p1: { width: 1200, height: 1200 } });
    const valid = validateDesignDoc(d);
    expect(valid.elements.some((e) => e.type === 'star' && e.role === 'badge')).toBe(true);
    expect(valid.elements.some((e) => e.role === 'cta' && e.type === 'rect' && e.shadow)).toBe(true);
  });
});

describe('Fotos gratis de Pexels', () => {
  function world(key = 'pk') {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'A', slug: 'a', productsJson: JSON.stringify({ CREATIVE: { enabled: true } }) });
    if (key) db.platformSetting.push({ key: 'PEXELS_API_KEY', value: key });
    const audit = { log: jest.fn(async () => undefined) };
    const creative = { companyOf: async (u: any) => db.company.find((c: any) => c.id === u.companyId) };
    const svc = new CreativeStockService(prisma as any, audit as any, creative as any);
    const calls: string[] = [];
    const png = Buffer.from('89504E470D0A1A0A0000000D49484452000003E8000002EE0806000000', 'hex');
    const photo = (id: number, original = `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`) => ({ id, width: 4000, height: 3000, url: `https://www.pexels.com/photo/${id}/`, photographer: 'Ana P', photographer_url: 'https://www.pexels.com/@ana', avg_color: '#AABBCC', alt: 'Casa campestre', src: { original, medium: `https://images.pexels.com/photos/${id}/m.jpeg` } });
    svc.fetchImpl = (async (url: string, init?: any) => {
      calls.push(`${url} ${init?.headers?.Authorization ?? ''}`);
      const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new Uint8Array(png).buffer });
      if (url.startsWith('https://api.pexels.com/v1/search')) return ok({ photos: [photo(1), photo(2)], next_page: 'x' });
      if (url.startsWith('https://api.pexels.com/v1/photos/66')) return ok(photo(66, 'https://evil.example.com/x.jpg'));
      if (url.startsWith('https://api.pexels.com/v1/photos/')) return ok(photo(Number(url.split('/').pop())));
      if (url.startsWith('https://images.pexels.com/')) return ok({});
      return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as any;
    return { svc, db, calls };
  }
  const A = { id: 'u', name: 'Ana', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };

  it('busca con la clave del servidor y repite la misma búsqueda desde la memoria', async () => {
    const w = world();
    const r = await w.svc.search(A, { q: 'casa campestre' });
    expect(r.photos).toHaveLength(2);
    expect(r.photos[0]).toMatchObject({ id: 1, photographer: 'Ana P', thumb: 'https://images.pexels.com/photos/1/m.jpeg' });
    expect(JSON.stringify(r)).not.toContain('pk');
    await w.svc.search(A, { q: 'Casa Campestre' });
    expect(w.calls.filter((c) => c.includes('/search')).length).toBe(1);
  });

  it('sin clave lo dice y no llama a Pexels', async () => {
    const w = world('');
    expect(await w.svc.status()).toEqual({ configured: false });
    await expect(w.svc.import(A, { id: 1 })).rejects.toThrow(/no están activadas/);
    expect(w.calls).toHaveLength(0);
  });

  it('trae la foto una sola vez, pidiendo la URL a Pexels (nunca una URL de otro dominio)', async () => {
    const w = world();
    const a = await w.svc.import(A, { id: 7 });
    expect(a).toMatchObject({ companyId: 'coA', source: 'STOCK', externalId: 'pexels:7', width: 1000, height: 750 });
    expect(a.name).toContain('Ana P');
    expect(w.calls.some((c) => c.startsWith('https://images.pexels.com/photos/7/') && c.includes('w=2000'))).toBe(true);
    await w.svc.import(A, { id: 7 });
    expect(w.db.brandAsset).toHaveLength(1);
    await expect(w.svc.import(A, { id: 66 })).rejects.toThrow(/no entregó/);
    await expect(w.svc.import(A, { id: 'abc' })).rejects.toThrow(/inválida/);
  });
});
