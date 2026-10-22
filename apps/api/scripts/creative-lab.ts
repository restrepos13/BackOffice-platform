/**
 * Laboratorio visual de la dirección de arte (herramienta de desarrollo).
 * Genera piezas con el MISMO motor que usa el endpoint /creative/art/proposals
 * (resolveIdentity → propose → adaptDesign → checkQuality) para marcas
 * FICTICIAS, y escribe un informe de similitud estructural y calidad.
 * El render a PNG lo hace la página /lab/creative de la web con el mismo
 * renderizador que la exportación del editor.
 *
 *   npx ts-node --transpile-only scripts/creative-lab.ts <carpeta-salida>
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { FormatKey } from '../src/common/design-doc';
import { resolveIdentity, sanitizeVisual } from '../src/common/creative/identity';
import { Content, FAMILIES, compose, seedHash, tokensFor } from '../src/common/creative/compose';
import { Goal, propose } from '../src/common/creative/art-direction';
import { checkQuality } from '../src/common/creative/quality';
import { adaptDesign } from '../src/common/creative/adapt';
import { SAME_STRUCTURE, differences, fingerprint, structuralSimilarity } from '../src/common/creative/similarity';

interface Brand {
  key: string; name: string; sector: string; tone: string; colors: string[]; fonts: string[];
  visual: Record<string, unknown> | null; theme: string;
  products: Array<{ name: string; price: string }>;
  copy: Record<string, Partial<Content>>;
}

const BRANDS: Brand[] = [
  {
    key: 'aurora', name: 'Café Aurora', sector: 'COMIDA', tone: 'Cálido y cercano, de origen y oficio, nunca técnico', colors: ['#7A3E1D', '#F6EFE6', '#E8A33D', '#3B2416'], fonts: [], visual: null, theme: 'coffee',
    products: [{ name: 'Latte de la casa', price: '$9.500' }, { name: 'Croissant de almendras', price: '$8.500' }, { name: 'Cold brew 12 h', price: '$11.000' }],
    copy: {
      PROMO: { headline: '2x1 en croissants de la tarde', price: '2x1', validity: 'De 3 a 5 p. m., hasta el 15 de noviembre', cta: 'Ven por el tuyo', kicker: 'Solo esta semana' },
      PRODUCT: { headline: 'Latte de la casa', price: '$9.500', body: 'Espresso de origen y leche texturizada a mano.', cta: 'Pide por WhatsApp' },
      TIP: { headline: 'Tu café dura más en un frasco oscuro', body: 'Lejos de la nevera y del sol. Muele solo lo que vas a preparar.', kicker: 'Tip de barista' },
      TESTIMONIAL: { quote: 'El mejor desayuno del barrio, siempre recién horneado.', author: 'Ana M., clienta desde 2024', headline: 'El mejor desayuno del barrio' },
      CATALOG: { headline: 'Para acompañar tu tarde', cta: 'Pide por WhatsApp' },
      INFO: { headline: 'Así preparamos tu café', points: ['Tostamos cada semana', 'Granos de Urrao y Huila', 'Domicilio en 30 minutos'], cta: 'Escríbenos' },
    },
  },
  {
    key: 'granos', name: 'Granos & Co', sector: 'COMIDA', tone: 'Sobrio, minimalista y exclusivo', colors: ['#1C1C1C', '#FAFAF7', '#C8A27A', '#2B2B2B'], fonts: ['DM Serif Display', 'Inter'],
    visual: { personality: ['MINIMALISTA', 'ELEGANTE'], photoStyle: 'ENMARCADA', density: 'AIREADA', alignment: 'IZQUIERDA', positioning: 'PREMIUM', logoPlacement: 'ABAJO_DERECHA' }, theme: 'coffee',
    products: [{ name: 'Geisha lavado', price: '$62.000' }, { name: 'Pour over', price: '$14.000' }, { name: 'Bolsa Huila 250 g', price: '$45.000' }],
    copy: {
      PROMO: { headline: 'Geisha lavado, edición limitada', price: '15 % menos', validity: 'Hasta agotar existencias', cta: 'Reserva tu bolsa' },
      PRODUCT: { headline: 'Pour over de origen', price: '$14.000', body: 'Filtrado lento, notas de jazmín y durazno.', cta: 'Visítanos' },
      TIP: { headline: 'Agua a 92 °C, no hirviendo', body: 'El agua hirviendo quema el café y lo vuelve amargo.', kicker: 'Método' },
      TESTIMONIAL: { quote: 'Un café que se toma despacio. Volveré.', author: 'Julián R.', headline: 'Un café que se toma despacio' },
      CATALOG: { headline: 'Selección de la semana' },
      INFO: { headline: 'Catas privadas para equipos', points: ['Grupos de 6 a 12 personas', 'Tres orígenes guiados', 'En tu oficina o en la tienda'], cta: 'Agenda una cata' },
    },
  },
  {
    key: 'lumiere', name: 'Lumière Skin', sector: 'BELLEZA', tone: 'Elegante, sereno y refinado', colors: ['#B48A78', '#FFFFFF', '#E9D8CF', '#2E2523'], fonts: ['Playfair Display', 'Lato'],
    visual: { personality: ['ELEGANTE'], photoStyle: 'ENMARCADA', density: 'AIREADA', alignment: 'CENTRADA', positioning: 'PREMIUM' }, theme: 'cosmetic',
    products: [{ name: 'Sérum vitamina C', price: '$129.000' }, { name: 'Crema de noche', price: '$98.000' }, { name: 'Tónico de rosas', price: '$64.000' }],
    copy: {
      PROMO: { headline: 'Ritual de noche con 20 % menos', price: '20 %', validity: 'Hasta el 30 de noviembre', cta: 'Descúbrelo' },
      PRODUCT: { headline: 'Sérum vitamina C', price: '$129.000', body: 'Luminosidad visible en cuatro semanas.', cta: 'Agenda tu asesoría' },
      TIP: { headline: 'El protector solar va todos los días', body: 'Incluso en casa: la luz de las pantallas y ventanas también cuenta.', kicker: 'Consejo de piel' },
      TESTIMONIAL: { quote: 'Mi piel nunca se había visto tan descansada.', author: 'Laura P.', headline: 'Mi piel nunca se había visto tan descansada' },
      CATALOG: { headline: 'Tu rutina completa' },
      INFO: { headline: 'Asesoría de piel personalizada', points: ['Diagnóstico de 30 minutos', 'Rutina por escrito', 'Seguimiento a las 4 semanas'], cta: 'Reserva tu cita' },
    },
  },
  {
    key: 'pulso', name: 'Pulso Gym', sector: 'GENERAL', tone: 'Enérgico, directo y motivador', colors: ['#0D0D0D', '#F2F2F2', '#C6FF00', '#FF2E63'], fonts: ['Anton', 'Inter'],
    visual: { personality: ['ENERGICA', 'AUDAZ'], photoStyle: 'PROTAGONISTA', density: 'COMPACTA', alignment: 'ASIMETRICA', positioning: 'JUVENIL' }, theme: 'gym',
    products: [{ name: 'Plan mensual', price: '$89.000' }, { name: 'Plan trimestral', price: '$239.000' }, { name: 'Clase funcional', price: '$15.000' }],
    copy: {
      PROMO: { headline: 'Inscripción gratis este mes', price: '$0', validity: 'Hasta el 31 de octubre', cta: 'Empieza hoy', kicker: 'Sin excusas' },
      PRODUCT: { headline: 'Funcional de 45 minutos', price: '$15.000', body: 'Fuerza, cardio y movilidad en grupos pequeños.', cta: 'Reserva tu clase' },
      TIP: { headline: 'Calienta 10 minutos antes de entrenar', body: 'Movilidad articular y cardio suave reducen lesiones.', kicker: 'Entrena mejor' },
      TESTIMONIAL: { quote: 'Bajé 8 kilos y gané fuerza en tres meses.', author: 'Camilo T., socio', headline: 'Bajé 8 kilos en tres meses' },
      CATALOG: { headline: 'Elige tu plan', cta: 'Inscríbete' },
      INFO: { headline: 'Entrenadores certificados', points: ['Plan de entrenamiento personal', 'Abierto de 5 a. m. a 10 p. m.', 'Parqueadero gratis'], cta: 'Ven a conocernos' },
    },
  },
  {
    key: 'vertice', name: 'Vértice Consultores', sector: 'SERVICIOS', tone: 'Profesional, claro y confiable', colors: ['#0B2545', '#F4F6F8', '#13A89E', '#1B1B1B'], fonts: ['Montserrat', 'Inter'],
    visual: { personality: ['PROFESIONAL', 'MINIMALISTA'], photoStyle: 'SUAVE', density: 'EQUILIBRADA', alignment: 'IZQUIERDA', positioning: 'CORPORATIVO' }, theme: 'office',
    products: [{ name: 'Diagnóstico financiero', price: '$1.200.000' }, { name: 'Acompañamiento mensual', price: '$3.500.000' }],
    copy: {
      PROMO: { headline: 'Diagnóstico financiero sin costo', price: 'Gratis', validity: 'Para las primeras 10 empresas', cta: 'Agenda una llamada' },
      PRODUCT: { headline: 'Diagnóstico financiero en 10 días', price: '$1.200.000', body: 'Flujo de caja, costos y márgenes con un plan de acción.', cta: 'Solicítalo' },
      TIP: { headline: 'Separa las cuentas personales de las del negocio', body: 'Es el primer paso para saber si tu empresa gana dinero.', kicker: 'Finanzas claras' },
      TESTIMONIAL: { quote: 'En dos meses entendimos dónde se iba el margen.', author: 'Gerente, empresa de logística', headline: 'Entendimos dónde se iba el margen' },
      CATALOG: { headline: 'Servicios para pymes' },
      INFO: { headline: 'Cómo trabajamos', points: ['Diagnóstico con tus datos reales', 'Plan de acción priorizado', 'Seguimiento mensual'], cta: 'Conversemos' },
    },
  },
  {
    key: 'kiddo', name: 'Kiddo Juguetes', sector: 'TIENDA', tone: 'Divertido, alegre y fresco', colors: ['#FF6B35', '#FFF8E7', '#2EC4B6', '#1D3557'], fonts: ['Poppins', 'Nunito'],
    visual: { personality: ['DIVERTIDA', 'ENERGICA'] }, theme: 'toys',
    products: [{ name: 'Bloques de madera', price: '$69.000' }, { name: 'Rompecabezas 100', price: '$39.000' }, { name: 'Kit de arte', price: '$54.000' }, { name: 'Peluche zorro', price: '$45.000' }],
    copy: {
      PROMO: { headline: 'Juguetes de madera con 30 % menos', price: '30 %', validity: 'Hasta el domingo', cta: 'Compra aquí' },
      PRODUCT: { headline: 'Bloques de madera natural', price: '$69.000', body: 'Pintura al agua, sin tóxicos. Desde los 2 años.', cta: 'Pídelo ya' },
      TIP: { headline: 'Juega 15 minutos sin pantallas', body: 'Construir con bloques mejora la concentración y la creatividad.', kicker: 'Para papás' },
      TESTIMONIAL: { quote: 'Mi hija no suelta el kit de arte desde que llegó.', author: 'Paola, mamá de Sara', headline: 'No suelta el kit de arte' },
      CATALOG: { headline: 'Los favoritos de la semana', cta: 'Ver todos' },
      INFO: { headline: 'Envíos a todo el país', points: ['Envío gratis desde $150.000', 'Cambios hasta 30 días', 'Empaque de regalo'], cta: 'Escríbenos' },
    },
  },
  {
    key: 'raiz', name: 'Verde Raíz', sector: 'SALUD', tone: 'Natural, cálido y cercano', colors: ['#3A5A40', '#F1F5EE', '#A3B18A', '#1F2A20'], fonts: ['Lora', 'Nunito'],
    visual: { personality: ['NATURAL', 'CALIDA'], photoStyle: 'SUAVE' }, theme: 'nature',
    products: [{ name: 'Consulta nutricional', price: '$120.000' }, { name: 'Plan de 3 meses', price: '$320.000' }],
    copy: {
      PROMO: { headline: 'Primera consulta con 25 % menos', price: '25 %', validity: 'Durante noviembre', cta: 'Agenda tu cita' },
      PRODUCT: { headline: 'Plan de alimentación de 3 meses', price: '$320.000', body: 'Con controles quincenales y recetas para tu semana.', cta: 'Empieza hoy' },
      TIP: { headline: 'Llena medio plato con verduras', body: 'Es la regla más simple para comer mejor sin contar calorías.', kicker: 'Consejo de nutrición' },
      TESTIMONIAL: { quote: 'Aprendí a comer bien sin dietas imposibles.', author: 'Andrés G., paciente', headline: 'Aprendí a comer bien sin dietas imposibles' },
      CATALOG: { headline: 'Nuestros servicios' },
      INFO: { headline: 'Nutrición basada en evidencia', points: ['Nutricionistas con tarjeta profesional', 'Planes según tus exámenes', 'Consultas presenciales o virtuales'], cta: 'Escríbenos' },
    },
  },
];

const INTENTS: Goal[] = ['PROMO', 'PRODUCT', 'TIP', 'TESTIMONIAL', 'CATALOG', 'INFO'];
const FORMATS_ADAPT: FormatKey[] = ['IG_PORTRAIT', 'STORY', 'FB_POST'];

export function assetsOf(b: Brand) {
  const dims: Record<string, { width: number; height: number }> = {
    [`${b.key}-logo`]: { width: 600, height: 600 },
    [`${b.key}-photo1`]: { width: 1600, height: 1200 },
    [`${b.key}-photo2`]: { width: 1200, height: 1600 },
    [`${b.key}-prod1`]: { width: 1200, height: 1200 },
    [`${b.key}-prod2`]: { width: 1200, height: 1200 },
    [`${b.key}-prod3`]: { width: 1200, height: 1200 },
    [`${b.key}-prod4`]: { width: 1200, height: 1200 },
  };
  return dims;
}

export function runLab() {
  const cases: any[] = [];
  for (const b of BRANDS) {
    const identity = resolveIdentity({ visual: b.visual ? sanitizeVisual(b.visual) : null, sector: b.sector, tone: b.tone, colors: b.colors, fonts: b.fonts, logoAssetId: `${b.key}-logo`, restrictions: [] });
    const dims = assetsOf(b);
    const recent: any[] = [];
    const recentPrints: any[] = [];
    for (const goal of INTENTS) {
      const base = b.copy[goal] ?? {};
      const content: Content = {
        headline: base.headline ?? b.name, ...base,
        items: goal === 'CATALOG' ? b.products.slice(0, 4).map((p, i) => ({ name: p.name, price: p.price, assetId: `${b.key}-prod${i + 1}` })) : undefined,
        photos: goal === 'TIP' || goal === 'INFO' ? [] : goal === 'PRODUCT' ? [`${b.key}-prod1`] : [`${b.key}-photo1`, `${b.key}-photo2`],
      };
      const seed = seedHash(`${b.key}:${goal}`);
      const r = propose(identity, { goal, format: 'IG_POST', content, recent, recentPrints, seed, alt: 0, companySeed: seedHash(b.key), brandName: b.name, dims });
      r.proposals.forEach((p, rankIdx) => {
        const issues = checkQuality(p.doc, { brandLogoIds: [`${b.key}-logo`], confirmedPrices: b.products.map((x) => Number(x.price.replace(/\D/g, ''))), confirmedOffers: [String(b.copy.PROMO?.price ?? '')], assetDims: dims, ownedAssetIds: new Set(Object.keys(dims)) });
        cases.push({ id: `${b.key}-${goal}-${rankIdx}`, brand: b.key, brandName: b.name, sector: b.sector, theme: b.theme, goal, rank: rankIdx, family: p.family, variant: p.variant, reason: p.reason, omitted: p.omitted, format: 'IG_POST', doc: p.doc, issues });
        if (rankIdx === 0) {
          for (const f of FORMATS_ADAPT) {
            const { doc, method } = adaptDesign(p.doc, { family: p.family, variant: p.variant, goal, seed }, f, tokensFor(identity, f, seedHash(b.key), b.name), dims);
            const issuesA = checkQuality(doc, { brandLogoIds: [`${b.key}-logo`], confirmedPrices: [], confirmedOffers: [], assetDims: dims, ownedAssetIds: new Set(Object.keys(dims)) }).filter((i) => !['UNCONFIRMED_PRICE', 'UNCONFIRMED_DISCOUNT'].includes(i.code));
            cases.push({ id: `${b.key}-${goal}-0-${f}`, brand: b.key, brandName: b.name, sector: b.sector, theme: b.theme, goal, rank: 0, family: p.family, variant: p.variant, format: f, method, doc, issues: issuesA, adapted: true });
          }
        }
      });
      if (r.proposals[0]) { recent.unshift(r.proposals[0].family); recentPrints.unshift(fingerprint(r.proposals[0].doc)); }
    }
  }
  return cases;
}

export function report(cases: any[]) {
  const top = cases.filter((c) => c.rank === 0 && !c.adapted);
  const fp = new Map(cases.map((c) => [c.id, fingerprint(c.doc)]));
  const lines: string[] = [];
  const findings: any = { crossBrandSame: [], sameSector: [], withinProposals: [], familyMatrix: [], quality: {}, coherence: [] };

  // 1) Entre marcas, misma intención: ¿la pieza principal es la misma estructura?
  for (const goal of INTENTS) {
    const list = top.filter((c) => c.goal === goal);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const s = structuralSimilarity(fp.get(list[i].id)!, fp.get(list[j].id)!);
      if (s >= SAME_STRUCTURE) findings.crossBrandSame.push({ goal, a: list[i].brand, b: list[j].brand, family: `${list[i].family}/${list[j].family}`, similarity: s });
    }
  }
  // 2) Mismo rubro: Aurora vs Granos
  for (const goal of INTENTS) {
    const a = top.find((c) => c.brand === 'aurora' && c.goal === goal);
    const b = top.find((c) => c.brand === 'granos' && c.goal === goal);
    if (a && b) findings.sameSector.push({ goal, aurora: a.family, granos: b.family, similarity: structuralSimilarity(fp.get(a.id)!, fp.get(b.id)!), differences: differences(fp.get(a.id)!, fp.get(b.id)!) });
  }
  // 3) Dentro de las propuestas de una misma petición
  const groups = new Map<string, any[]>();
  for (const c of cases.filter((x) => !x.adapted)) { const k = `${c.brand}-${c.goal}`; groups.set(k, [...(groups.get(k) ?? []), c]); }
  for (const [k, list] of groups) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const s = structuralSimilarity(fp.get(list[i].id)!, fp.get(list[j].id)!);
    if (s >= SAME_STRUCTURE) findings.withinProposals.push({ request: k, a: list[i].family, b: list[j].family, similarity: s });
  }
  // 4) Familias redundantes: todas con el mismo contenido y la misma identidad
  const id = resolveIdentity({ visual: null, sector: 'GENERAL', tone: '', colors: ['#1F3A5F', '#F6F3EE', '#E07A5F', '#1A1A1A'], fonts: [], logoAssetId: 'n-logo', restrictions: [] });
  const neutral: Content = { kicker: 'Nuevo', headline: 'Un mensaje principal de largo medio', body: 'Un texto de apoyo de una o dos líneas.', price: '$45.000', cta: 'Escríbenos', validity: 'Hasta el domingo', date: { day: '08', month: 'Nov' }, place: 'Centro', quote: 'Una frase de un cliente real sobre el servicio.', author: 'Cliente', points: ['Primer punto', 'Segundo punto', 'Tercer punto'], items: [{ name: 'Uno', price: '$10.000', assetId: 'n-p1' }, { name: 'Dos', price: '$12.000', assetId: 'n-p2' }, { name: 'Tres', price: '$9.000' }], photos: ['n-ph1', 'n-ph2'] };
  const nd = { 'n-logo': { width: 600, height: 600 }, 'n-p1': { width: 1200, height: 1200 }, 'n-p2': { width: 1200, height: 1200 }, 'n-ph1': { width: 1600, height: 1200 }, 'n-ph2': { width: 1200, height: 1600 } };
  const fams = FAMILIES.map((f) => ({ f, fp: fingerprint(compose(f, tokensFor(id, 'IG_POST', 1, 'N'), neutral, 0, nd)) }));
  for (let i = 0; i < fams.length; i++) for (let j = i + 1; j < fams.length; j++) {
    const s = structuralSimilarity(fams[i].fp, fams[j].fp);
    findings.familyMatrix.push({ a: fams[i].f, b: fams[j].f, similarity: s });
  }
  findings.familyMatrix.sort((x: any, y: any) => y.similarity - x.similarity);
  // 5) Calidad
  for (const c of cases) for (const i of c.issues) { const k = `${i.severity}:${i.code}`; findings.quality[k] = (findings.quality[k] ?? 0) + 1; }
  // 6) Coherencia contenido ↔ composición (reglas verificables)
  for (const c of top) {
    const hasBadge = c.doc.elements.some((e: any) => e.role === 'badge');
    if (c.goal === 'PROMO' && !['OFFER', 'TYPE_DOMINANT'].includes(c.family) && !hasBadge) findings.coherence.push(`${c.id}: una promoción quedó en ${c.family} (el descuento no es protagonista)`);
    if (c.goal === 'CATALOG' && c.family !== 'CATALOG') findings.coherence.push(`${c.id}: catálogo en ${c.family}`);
    if (c.goal === 'TESTIMONIAL' && c.family !== 'TESTIMONIAL') findings.coherence.push(`${c.id}: testimonio en ${c.family}`);
    const photos = c.doc.elements.filter((e: any) => e.type === 'image' && e.role !== 'logo').length;
    if (c.goal === 'CATALOG' && photos === 0) findings.coherence.push(`${c.id}: catálogo sin fotos de producto`);
    if (c.omitted?.length) findings.coherence.push(`${c.id}: no entró ${c.omitted.join(', ')}`);
  }

  lines.push(`# Laboratorio visual · ${new Date().toISOString().slice(0, 10)}`, '', `Piezas generadas: ${cases.length} (${top.length} principales, ${cases.filter((c) => c.adapted).length} adaptadas).`, '');
  lines.push('## Misma estructura entre marcas distintas (similitud ≥ 0,8)', ...findings.crossBrandSame.map((x: any) => `- ${x.goal}: ${x.a} vs ${x.b} · ${x.family} · ${x.similarity}`), '');
  lines.push('## Mismo rubro (Café Aurora vs Granos & Co)', ...findings.sameSector.map((x: any) => `- ${x.goal}: ${x.aurora} vs ${x.granos} · similitud ${x.similarity} · difiere en: ${x.differences.join(', ') || 'nada estructural'}`), '');
  lines.push('## Propuestas casi iguales dentro de una misma petición', ...findings.withinProposals.map((x: any) => `- ${x.request}: ${x.a} vs ${x.b} · ${x.similarity}`), '');
  lines.push('## Familias más parecidas entre sí (mismo contenido e identidad)', ...findings.familyMatrix.slice(0, 10).map((x: any) => `- ${x.a} vs ${x.b} · ${x.similarity}`), '');
  lines.push('## Avisos de calidad', ...Object.entries(findings.quality).sort().map(([k, v]) => `- ${k}: ${v}`), '');
  lines.push('## Coherencia contenido ↔ composición', ...findings.coherence.map((x: string) => `- ${x}`), '');
  return { findings, markdown: lines.join('\n') };
}

if (require.main === module) {
  const out = process.argv[2];
  if (!out) throw new Error('Falta la carpeta de salida');
  mkdirSync(out, { recursive: true });
  const cases = runLab();
  const { findings, markdown } = report(cases);
  const brands = BRANDS.map((b) => ({ key: b.key, name: b.name, theme: b.theme, colors: b.colors, assets: assetsOf(b) }));
  writeFileSync(join(out, 'cases.json'), JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Marcas y recursos FICTICIOS para pruebas', brands, cases }));
  writeFileSync(join(out, 'findings.json'), JSON.stringify(findings, null, 2));
  writeFileSync(join(out, 'informe.md'), markdown);
  console.log(markdown);
}
