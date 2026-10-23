/**
 * Motor del registro SIN IA. Si ninguna IA responde, el código lee lo que contó
 * el dueño (nombre, ciudad, productos y precios, horario, pagos, envíos,
 * documentos, lo que preguntan sus clientes y lo que quiere del asistente) y
 * arma el plano con plantillas por tipo de negocio. Sale en el MISMO formato de
 * la IA para pasar por los mismos validadores. Meta: parecerse ≥ 70 % al plano
 * de la IA (test/blueprint-engine.spec.ts lo mide con 12 negocios reales).
 */
import { BusinessProfile, ProfileKey, detectProfile } from './business-profile';
import { Rubro } from './rubros';
import { readOperation } from './setup-profile';

type Pair = [question: string, answer: string];

/* ── Texto ─────────────────────────────────────────────────────────── */

const plain = (t: string) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim();
const cop = (n: number) => `$${n.toLocaleString('es-CO')}`;
/** "vestidos, blusas y jeans" */
const humanList = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`);
const unique = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = plain(x);
    if (!x || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** Frases: corta en punto, punto y coma o salto, pero nunca dentro de "45.000". */
const sentences = (text: string) => String(text ?? '').split(/(?<!\d)[.;\n]|[.;\n](?!\d)/).map((x) => x.trim()).filter(Boolean);

/** "120.000" · "1.800.000" · "35 mil" · "60k" → número */
export function parseMoney(raw: string): number | null {
  const t = plain(raw).replace(/\s+/g, ' ').trim();
  let m = /^\$?\s*(\d{1,3}(?:[.,]\d{3})+)$/.exec(t);
  if (m) return Number(m[1].replace(/[.,]/g, ''));
  m = /^\$?\s*(\d+(?:[.,]\d+)?)\s*(mil|k)$/.exec(t);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 1000);
  m = /^\$?\s*(\d{4,9})$/.exec(t);
  return m ? Number(m[1]) : null;
}

const MONEY = /\$?\s?\d{1,3}(?:[.,]\d{3})+|\$?\s?\d+(?:[.,]\d+)?\s?(?:mil|k)\b|\$\s?\d{4,9}/gi;

/* ── Hechos que se leen de las respuestas ─────────────────────────── */

const CITIES = [
  'Medellín', 'Bogotá', 'Cali', 'Barranquilla', 'Cartagena', 'Bucaramanga', 'Pereira', 'Manizales', 'Armenia', 'Cúcuta', 'Ibagué',
  'Villavicencio', 'Santa Marta', 'Pasto', 'Neiva', 'Montería', 'Itagüí', 'Envigado', 'Bello', 'Sabaneta', 'Rionegro', 'Chía', 'Soacha',
  'Popayán', 'Valledupar', 'Sincelejo', 'Tunja', 'Palmira', 'Floridablanca', 'Dosquebradas', 'La Estrella', 'Caldas', 'Copacabana',
  'Girardot', 'Zipaquirá', 'Facatativá', 'Buenaventura', 'Riohacha', 'Yopal', 'Quibdó', 'Florencia', 'Tuluá', 'Cartago', 'Jamundí',
];

export interface Facts {
  /** Cómo trabaja (tareas, equipo, sistemas, contenido y publicidad), leído por código */
  operation: ReturnType<typeof readOperation>;
  profile: BusinessProfile;
  rubro: Rubro;
  name: string;
  city: string;
  businessType: string;
  products: Array<{ name: string; price: number | null }>;
  schedule: { days: number[]; open: string; close: string } | null;
  payments: string[];
  prepay: string | null;
  delivery: { mentioned: boolean; shipping: boolean; ownCouriers: boolean; pickup: boolean; sentence: string };
  /** Hay anticipo/abono de verdad (no solo "pago antes de enviar") */
  deposit: boolean;
  documents: string[];
  asks: string[];
  wishes: string[];
  collect: string[];
  appointments: boolean;
  reminders: string | null;
  quotes: boolean;
  anticipation: string | null;
  dailyChats: number | null;
  channels: string[];
}

const PAYMENTS: Array<[RegExp, string]> = [
  [/nequi/, 'Nequi'], [/daviplata/, 'Daviplata'], [/bancolombia/, 'transferencia Bancolombia'], [/transferencia/, 'transferencia'],
  [/efectivo/, 'efectivo'], [/tarjeta/, 'tarjeta'], [/contra ?entrega/, 'pago contra entrega'], [/\baddi\b/, 'Addi'],
  [/sistecredito/, 'Sistecrédito'], [/link de pago|pse/, 'link de pago'], [/plataforma/, 'la plataforma'],
];

const DOCUMENTS: Array<[RegExp, string]> = [
  [/cedula/, 'Cédula'], [/\beps\b/, 'Certificado de EPS'], [/\barl\b/, 'Certificado de ARL'], [/carta laboral/, 'Carta laboral'],
  [/extracto/, 'Extractos bancarios'], [/codeudor/, 'Datos del codeudor'], [/\brut\b/, 'RUT'], [/\bedad\b/, 'Edad'],
  [/enfermedad/, 'Enfermedades o condiciones de salud'], [/placa/, 'Placa'], [/historia clinica/, 'Historia clínica'],
];

const DAYS: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/** "lunes a viernes de 11 am a 3 pm" → días y horas (solo si hay días y horas, como la IA). */
export function parseSchedule(text: string): Facts['schedule'] {
  const t = plain(text);
  let days: number[] = [];
  const range = /(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?\s+(?:a|hasta)\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?/.exec(t);
  let from = 0;
  if (/todos los dias|toda la semana|lunes a domingo/.test(t)) {
    days = [0, 1, 2, 3, 4, 5, 6];
    from = Math.max(0, t.search(/todos los dias|toda la semana|lunes a domingo/));
  } else if (range) {
    const a = DAYS[range[1]];
    const b = DAYS[range[2]];
    for (let d = a; ; d = (d + 1) % 7) {
      days.push(d);
      if (d === b || days.length > 7) break;
    }
    from = range.index;
  }
  if (!days.length) return null;
  const after = t.slice(from);
  const h = /(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?\s*(?:a|-|hasta)\s*(?:las\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?/.exec(after);
  if (!h) return null;
  const to24 = (hh: number, suf?: string) => (suf && /p/.test(suf) && hh < 12 ? hh + 12 : suf && /a/.test(suf) && hh === 12 ? 0 : hh);
  let open = to24(Number(h[1]), h[3]);
  let close = to24(Number(h[4]), h[6]);
  if (!h[6] && close <= open) close += 12; // "de 10 a 2" = 10 a. m. a 2 p. m.
  if (open > 23 || close > 24 || close <= open) return null;
  const hhmm = (x: number, mm?: string) => `${String(x).padStart(2, '0')}:${mm ?? '00'}`;
  return { days: [...new Set(days)].sort((a, b) => a - b), open: hhmm(open, h[2]), close: hhmm(close === 24 ? 23 : close, close === 24 ? '59' : h[5]) };
}

const NOT_PRODUCT = /anticipo|abono|separar|apartar|descuento|domicilio|envio|cupo|mitad|%|costo adicional|cuota|saldo/;
const LEADING = /^(?:(?:y|e|o|tambien|ademas|hay|tenemos|vendemos|vendo|hacemos|hago|ofrecemos|ofrezco|manejamos|el|la|los|las|un|una|unos|unas|de|del|nuestro|nuestra|nuestros|nuestras)\s+)+/i;
const TRAILING = /\s+(?:a|en|de|del|desde|por|valen?|cuestan?|esta|estan|son|es|vale|la docena a|por persona|cada uno|cada una|con)$/i;

function productName(raw: string): string {
  let s = clean(raw).replace(LEADING, '');
  for (let i = 0; i < 3; i++) s = s.replace(TRAILING, '');
  s = s.replace(/\s+(?:a|en|desde|de)\s*$/i, '').trim();
  return s.split(' ').length <= 6 ? cap(s) : '';
}

/** Productos con precio ("los vestidos valen 120.000") y sin precio (listas: "blusas, vestidos y jeans"). */
export function parseProducts(pairs: Pair[]): Facts['products'] {
  const out: Facts['products'] = [];
  const productQ = /vend|ofrec|servicio|plan|precio|producto|curso|paquete|carta|menu|catalogo|cuanto/;
  pairs.forEach(([q, a], idx) => {
    for (const sentence of sentences(a)) {
      const clauses = sentence.split(/,|\s+y\s+(?=\S+(?:\s+\S+){0,4}\s+\$?\d)/);
      for (const clause of clauses) {
        const money = clause.match(MONEY);
        if (!money) continue;
        if (NOT_PRODUCT.test(plain(clause))) continue;
        // Varios precios en la misma frase: "básico 1.800.000 y premium 3.500.000"
        let rest = clause;
        for (const m of money) {
          const at = rest.indexOf(m);
          const before = rest.slice(0, at).split(/\s+y\s+/).pop() ?? '';
          const name = productName(before);
          const price = parseMoney(m);
          if (name && price && price >= 1000) out.push({ name, price });
          rest = rest.slice(at + m.length);
        }
      }
    }
    // Listas sin precio: en respuestas sobre qué vende, o en la primera respuesta tras "hacemos/vendemos…"
    const listSource = productQ.test(plain(q)) ? a : idx === 0 ? (/(?:hacemos|vendemos|vendo|ofrecemos|manejamos)\s+(.+)/i.exec(a)?.[1] ?? '') : '';
    for (const sentence of sentences(listSource)) {
      if (MONEY.test(sentence) && !/,/.test(sentence)) { MONEY.lastIndex = 0; continue; }
      MONEY.lastIndex = 0;
      const items = sentence.split(/,|\s+y\s+/).map((x) => x.replace(MONEY, '')).map(productName)
        .filter((x) => x && x.length > 2 && !/\d/.test(x) && !NOT_PRODUCT.test(plain(x)) && !/^(que|si|no|para|cuando|por)\b/i.test(x));
      if (items.length >= 2) for (const name of items) out.push({ name, price: null });
    }
  });
  // Sin duplicados: el que tiene precio gana
  const byKey = new Map<string, { name: string; price: number | null }>();
  for (const p of out) {
    const k = plain(p.name);
    const prev = byKey.get(k);
    if (!prev || (prev.price == null && p.price != null)) byKey.set(k, p);
  }
  return [...byKey.values()].slice(0, 12);
}

function nameAndCity(pairs: Pair[]): { name: string; city: string } {
  const pair = pairs.find(([q]) => /llama|nombre/.test(plain(q))) ?? pairs[1] ?? pairs[0];
  const answer = pair?.[1] ?? '';
  const city = CITIES.find((c) => plain(answer).includes(plain(c))) ?? /\ben\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/.exec(answer)?.[1] ?? '';
  let name = answer
    .replace(/^(se llama|mi negocio se llama|el negocio se llama|nos llamamos|somos|es)\s+/i, '')
    .split(/,|\s+en\s+|\s+de\s+(?=[A-ZÁÉÍÓÚ])/)[0];
  name = clean(name);
  if (name.split(' ').length > 6) name = '';
  return { name, city };
}

function businessTypeOf(first: string, profile: BusinessProfile): string {
  const m = /(?:tengo|tenemos|somos|soy|hago|vendo|vendemos|manejo|manejamos|ofrecemos)\s+(?:(?:unos|unas|una|un)\s+)?(.+)/i.exec(first);
  let s = clean((m?.[1] ?? first).split(/[,.]|\s+para\s+|\s+con\s+|\s+que\s+/)[0]);
  s = s.replace(/\b(pequen[oa]|pequeñ[oa]|grande|nuev[oa])\b/gi, '').replace(/\s+/g, ' ').trim();
  const words = s.split(' ');
  if (words.length > 6) s = words.slice(0, 6).join(' ');
  return cap(s) || profile.label;
}

/** Lo que viene después de "preguntan…" / "quieren saber…" (lista). */
function phrasesAfter(text: string, re: RegExp): string[] {
  const m = re.exec(text);
  if (!m) return [];
  return m[1].split(/,|\s+y\s+|\s+o\s+/).map((x) => clean(x.replace(/^(siempre|primero|por|el|la|los|las|si|que)\s+/i, '').replace(/[?¿.]/g, ''))).filter((x) => x && x.split(' ').length <= 6).slice(0, 6);
}

export function extractFacts(pairs: Pair[]): Facts {
  const answers = pairs.map(([, a]) => a);
  const all = answers.join('. ');
  const t = plain(all);
  const profile = detectProfile(all, answers[0] ?? '');
  const rubro: Rubro = ({ ROPA: 'VENTAS', TIENDA: 'VENTAS', INMOBILIARIA: 'VENTAS', GENERAL: 'VENTAS', COMIDA: 'COMIDAS', WEBCAM: 'WEBCAM' } as Partial<Record<ProfileKey, Rubro>>)[profile.key] ?? 'SERVICIOS';
  const { name, city } = nameAndCity(pairs);
  const payments = unique(PAYMENTS.filter(([re]) => re.test(t)).map(([, n]) => n)).filter((p, _, arr) => !(p === 'transferencia' && arr.includes('transferencia Bancolombia')));
  const prepaySentence = sentences(all).find((x) => /anticipo|la mitad|abono|\d+ ?%|separa|aparta/.test(plain(x)));
  const prepay = prepaySentence
    ? clean(prepaySentence.replace(/^(s[ií],?\s+)?(pedimos|cobramos|piden|pido|se pide|hay que pagar)?\s*/i, ''))
    : /antes de (enviar|iniciar|empezar)/.test(t) ? 'el pago antes de enviar' : null;
  const realPrepay = !!prepaySentence;
  const deliverySentence = sentences(all).find((s) => /transportadora|servientrega|interrapidisimo|coordinadora|envio|enviamos|domicilio|domiciliario|mensajeria|recogen|recoger/.test(plain(s))) ?? '';
  const delivery = {
    mentioned: !!deliverySentence,
    shipping: /transportadora|servientrega|interrapidisimo|coordinadora|todo el pais|envio|enviamos|mensajeria/.test(t),
    ownCouriers: /domiciliario|mensajero|motorizado/.test(t),
    pickup: /recogen|recoger|en la tienda|en mi casa|pasan por/.test(t),
    sentence: clean(deliverySentence),
  };
  const askPair = pairs.find(([q, a]) => /que te preguntan|preguntan primero|que preguntan|te preguntan/.test(plain(q)) || /preguntan|quieren saber/.test(plain(a)));
  const asks = askPair ? (phrasesAfter(askPair[1], /(?:preguntan|quieren saber|piden)\s+(.+)/i).length ? phrasesAfter(askPair[1], /(?:preguntan|quieren saber|piden)\s+(.+)/i) : phrasesAfter(askPair[1], /^(.+)$/)) : [];
  const wishPair = pairs.find(([q]) => /asistente|que haga|quieres que/.test(plain(q)));
  const wishes = wishPair ? phrasesAfter((sentences(wishPair[1])[0] ?? '').replace(/^que\s+(el asistente\s+)?/i, ''), /^(.+)$/) : [];
  const collect = phrasesAfter(all, /(?:pregunte|pida|tome|solicite)\s+(?:la |el |los |las )?(.+?)(?:\s+y\s+env|\.|$)/i);
  const reminders = /reentren/.test(t) ? 'el reentrenamiento' : /renovaci|mensualidad/.test(t) && /record/.test(t) ? 'la renovación' : /record/.test(t) ? 'las citas' : null;
  const daily = /(\d+)\s*a\s*(\d+)/.exec(answers[2] ?? '') ?? /(mas de)\s*(\d+)/.exec(plain(answers[2] ?? ''));
  return {
    operation: readOperation(all),
    profile, rubro, name, city,
    businessType: businessTypeOf(answers[0] ?? '', profile),
    products: parseProducts(pairs),
    schedule: parseSchedule(all),
    payments,
    prepay: prepay ? clean(prepay) : null,
    deposit: realPrepay,
    delivery,
    documents: unique(DOCUMENTS.filter(([re]) => re.test(t)).map(([, n]) => n)),
    asks,
    wishes,
    collect: collect.filter((x) => !/cotiza|precio/.test(plain(x))),
    appointments: /\bcita|agend|turno|reserva|visita|clase de prueba|grupo|cupo|fecha/.test(t) && !/^(ROPA|TIENDA)$/.test(profile.key),
    reminders,
    quotes: /cotiza|paquete|presupuesto/.test(t),
    anticipation: /(\d+)\s+dias?\s+antes|anticipaci/.test(t) ? (/minimo\s+(\d+)\s+dias?/.exec(t)?.[0] ?? 'con anticipación') : null,
    dailyChats: daily ? Number(daily[2]) : null,
    channels: unique([/instagram/.test(t) && 'Instagram', /whatsapp/.test(t) && 'WhatsApp', /facebook/.test(t) && 'Facebook', /tiktok/.test(t) && 'TikTok'].filter(Boolean) as string[]),
  };
}

/** "agende citas" → "Agendar citas" (lo que pidió el dueño, en infinitivo). */
const VERBS: Record<string, string> = {
  agende: 'Agendar', recuerde: 'Recordar', responda: 'Responder', muestre: 'Mostrar', tome: 'Tomar', envie: 'Enviar', mande: 'Enviar',
  pregunte: 'Preguntar', filtre: 'Filtrar', ofrezca: 'Ofrecer', converse: 'Conversar', cobre: 'Cobrar', confirme: 'Confirmar',
  atienda: 'Atender', venda: 'Vender', reciba: 'Recibir', avise: 'Avisar', cotice: 'Cotizar', registre: 'Registrar', organice: 'Organizar',
  explique: 'Explicar', resuelva: 'Resolver', separe: 'Separar', haga: 'Hacer', de: 'Dar', informe: 'Informar', valide: 'Validar',
};
export function wishToNeed(w: string): string {
  const words = clean(w).split(' ');
  const verb = VERBS[plain(words[0])];
  if (verb) return `${verb} ${words.slice(1).join(' ')}`.trim();
  const v = plain(words[0]);
  if (/^nunca$/.test(v)) return cap(clean(w));
  if (/[^aeiou]e$/.test(v) && v.length > 4) return `${cap(words[0].slice(0, -1))}ar ${words.slice(1).join(' ')}`.trim();
  return cap(clean(w));
}

const NEED_SOLUTION: Array<[RegExp, string]> = [
  [/agend|cita|visita|clase de prueba/, 'El asistente ofrece los horarios disponibles y agenda sin que estés pegado al celular.'],
  [/record|renov|reentren/, 'BackOffice envía recordatorios automáticos por WhatsApp en el momento justo.'],
  [/precio|respond|pregunt|informaci/, 'El asistente responde al instante con tus precios e información, a cualquier hora.'],
  [/catalog|mostr|foto|galer/, 'El asistente muestra tu catálogo con fotos y precios en la conversación.'],
  [/dato|pedido|tom/, 'El asistente toma los datos del pedido y te lo deja organizado en el panel.'],
  [/cotiz|paquete/, 'El asistente pregunta los detalles y envía la cotización con tus precios.'],
  [/filtr/, 'El asistente califica a cada interesado antes de pasarlo a un asesor.'],
  [/convers|fan/, 'El asistente conversa como una persona y mantiene el interés.'],
  [/pago|cobr|nunca envi/, 'El asistente confirma el pago antes de entregar.'],
];

/* ── Plantillas por tipo de negocio ───────────────────────────────── */

/** "las prendas", "el menú", "los servicios" */
const the = (noun: string) => (noun === 'menú' || noun === 'contenido' ? `el ${noun}` : noun === 'prendas' ? `las ${noun}` : `los ${noun}`);
const our = (noun: string) => (noun === 'menú' || noun === 'contenido' ? `nuestro ${noun}` : noun === 'prendas' ? `nuestras ${noun}` : `nuestros ${noun}`);

const NOUN: Record<ProfileKey, string> = {
  ROPA: 'prendas', COMIDA: 'menú', BELLEZA: 'servicios', SALUD: 'servicios', EDUCACION: 'cursos', INMOBILIARIA: 'inmuebles',
  TIENDA: 'productos', TALLER: 'servicios', WEBCAM: 'contenido', SERVICIOS: 'servicios', RESERVAS: 'espacios', GENERAL: 'productos',
};

type Stage = [string, 'abierta' | 'ganada' | 'perdida'];

function pipelineFor(f: Facts): Stage[] {
  const k = f.profile.key;
  if (k === 'COMIDA') {
    return f.anticipation || f.deposit
      ? [['Nuevo contacto', 'abierta'], ['Cotización enviada', 'abierta'], ['Abono recibido', 'abierta'], ['En producción', 'abierta'], ['Pedido entregado', 'ganada'], ['No concretó', 'perdida']]
      : [['Nuevo contacto', 'abierta'], ['Pregunta por el menú', 'abierta'], ['Pedido en curso', 'abierta'], ['Pedido entregado', 'ganada'], ['No concretó', 'perdida']];
  }
  if (k === 'BELLEZA') {
    return [['Contacto inicial', 'abierta'], ['Consulta de servicios', 'abierta'], ...(f.deposit ? [['Cita en proceso (anticipo pendiente)', 'abierta'] as Stage] : []), ['Cita confirmada', 'abierta'], ['Cita realizada', 'ganada'], ['No agendó', 'perdida']];
  }
  if (k === 'RESERVAS') return [['Contacto inicial', 'abierta'], ['Consulta disponibilidad', 'abierta'], ...(f.deposit ? [['Reserva separada (anticipo)', 'abierta'] as Stage] : [['Reserva separada', 'abierta'] as Stage]), ['Reserva cumplida', 'ganada'], ['No reservó o canceló', 'perdida']];
  if (k === 'SALUD') return [['Contacto inicial', 'abierta'], ['Cita agendada', 'abierta'], ['Cita realizada', 'abierta'], ['Tratamiento iniciado', 'ganada'], ['Cita perdida', 'perdida']];
  if (k === 'EDUCACION') {
    return [['Contacto inicial', 'abierta'], ['Información enviada', 'abierta'], ...(f.documents.length ? [['Documentos solicitados', 'abierta'] as Stage] : []), ['Pago pendiente', 'abierta'], ['Inscrito y pagado', 'ganada'], ...(/certificad/.test(plain(f.wishes.join(' ') + f.documents.join(' '))) || f.reminders ? [['Certificado entregado', 'ganada'] as Stage] : []), ['No se inscribió', 'perdida']];
  }
  if (k === 'INMOBILIARIA') return [['Interesado inicial', 'abierta'], ['Información enviada', 'abierta'], ['Visita agendada', 'abierta'], ['Documentos solicitados', 'abierta'], ['Estudio en proceso', 'abierta'], ['Arriendo o venta exitosa', 'ganada'], ['No califica o desiste', 'perdida']];
  if (k === 'TALLER') return [['Contacto inicial', 'abierta'], ['Revisión y cotización', 'abierta'], ['Servicio en proceso', 'abierta'], ['Listo para entrega y pago', 'abierta'], ['Entregado', 'ganada'], ['Cotización no aceptada', 'perdida']];
  if (k === 'WEBCAM') return [['Nuevo fan', 'abierta'], ['Enviando catálogo', 'abierta'], ['Esperando pago', 'abierta'], ['Contenido entregado', 'ganada'], ['Sin compra', 'perdida']];
  if (k === 'SERVICIOS') {
    if (/clase de prueba|mensualidad|plan/.test(plain(f.products.map((p) => p.name).join(' ') + f.wishes.join(' ')))) {
      return [['Contacto inicial', 'abierta'], ['Interesado en planes', 'abierta'], ['Clase de prueba agendada', 'abierta'], ['Clase de prueba realizada', 'abierta'], ['Inscrito', 'ganada'], ['No interesado', 'perdida']];
    }
    return [['Contacto inicial', 'abierta'], ['Información solicitada', 'abierta'], ['Cotización enviada', 'abierta'], ...(f.deposit ? [['Anticipo recibido', 'abierta'] as Stage] : []), ['Servicio realizado', 'ganada'], ['Perdido', 'perdida']];
  }
  // Ropa, tienda y lo demás: venta
  return [['Contacto inicial', 'abierta'], ['Consulta de producto', 'abierta'], ['Pedido en proceso', 'abierta'], ['Pago pendiente', 'abierta'], ['Venta confirmada', 'ganada'], ...(f.delivery.shipping ? [['Envío realizado', 'ganada'] as Stage] : []), ['Venta perdida', 'perdida']];
}

function clientDataFor(f: Facts): string[] {
  const k = f.profile.key;
  const t = plain([f.businessType, ...f.wishes, ...f.asks, ...f.products.map((p) => p.name)].join(' '));
  const out: string[] = k === 'WEBCAM' ? ['Nombre o usuario del fan', 'Tipo de contenido de interés'] : ['Nombre completo', 'Número de contacto'];
  if (f.delivery.shipping || f.delivery.ownCouriers) out.push(k === 'COMIDA' ? 'Dirección de entrega' : 'Dirección de envío');
  if (f.delivery.shipping && /todo el pais|ciudad|nacional/.test(plain(f.delivery.sentence))) out.push('Ciudad');
  if (k === 'COMIDA' && (f.anticipation || f.deposit)) out.push('Detalles del pedido', 'Fecha y hora de entrega o recogida');
  if (k === 'INMOBILIARIA') out.push('Tipo de inmueble (arriendo o venta)', 'Presupuesto aproximado', 'Zona de interés');
  if (k === 'TALLER' && /moto|carro|vehiculo/.test(plain(f.businessType))) out.push(`Marca y modelo de la ${/carro|vehiculo/.test(plain(f.businessType)) ? 'vehículo' : 'moto'}`, 'Servicio solicitado');
  if (f.appointments && ['BELLEZA', 'SALUD', 'TALLER'].includes(k)) out.push('Servicio deseado', 'Fecha y hora de la cita');
  if (/evento/.test(t)) out.push('Fecha del evento', 'Lugar del evento', 'Tipo de evento');
  for (const c of f.collect) out.push(cap(c));
  out.push(...f.documents);
  if (f.payments.some((p) => /transferencia|nequi|daviplata/i.test(p)) || f.prepay) out.push(f.deposit ? 'Comprobante de pago del anticipo' : 'Comprobante de pago');
  return unique(out).slice(0, 12);
}

function modulesFor(f: Facts): string[] {
  const k = f.profile.key;
  const out = new Set<string>(['gerencia', 'analytics']);
  if (f.products.length || ['ROPA', 'TIENDA', 'COMIDA', 'GENERAL'].includes(k) || f.quotes) out.add('orders');
  if (f.appointments || ['BELLEZA', 'SALUD', 'INMOBILIARIA'].includes(k)) out.add('agenda');
  if (f.reminders || (f.dailyChats ?? 0) >= 30) out.add('campaigns');
  if (k === 'COMIDA') {
    out.add('menu');
    out.add('production');
    if (f.delivery.mentioned) out.add('delivery');
  }
  if (k === 'WEBCAM' || (k === 'SERVICIOS' && /foto|video/.test(plain(f.businessType)))) out.add('media');
  return [...out];
}

function needsFor(f: Facts, noun: string): Array<{ titulo: string; como_lo_resuelve: string }> {
  const k = f.profile.key;
  const out: Array<{ titulo: string; como_lo_resuelve: string }> = [];
  // Primero lo que pidió el dueño con sus palabras (así lo resume también la IA)
  for (const w of f.wishes.slice(0, 3)) {
    const titulo = wishToNeed(w);
    if (titulo.split(' ').length < 2) continue;
    const sol = NEED_SOLUTION.find(([re]) => re.test(plain(titulo)))?.[1] ?? 'BackOffice lo hace automático por WhatsApp y te deja todo organizado.';
    out.push({ titulo, como_lo_resuelve: sol });
  }
  const asksText = f.asks.length ? humanList(f.asks.slice(0, 3)) : '';
  if (asksText) out.push({ titulo: `Responder preguntas frecuentes sobre ${asksText}`, como_lo_resuelve: 'El asistente responde al instante las preguntas más comunes con la información de tu negocio.' });
  if (f.appointments) {
    const what = k === 'INMOBILIARIA' ? 'visitas' : k === 'EDUCACION' ? 'inscripciones y cupos' : /clase de prueba/.test(plain(f.products.map((p) => p.name).join(' '))) ? 'clases de prueba' : 'citas';
    out.push({ titulo: `Agendar ${what} por WhatsApp`, como_lo_resuelve: `El asistente ofrece los horarios disponibles y agenda ${what} sin que estés pegado al celular.` });
  }
  if (f.products.length && !['INMOBILIARIA', 'EDUCACION'].includes(k)) out.push({ titulo: `Mostrar el catálogo de ${noun} a los clientes`, como_lo_resuelve: `BackOffice organiza ${noun === 'menú' ? 'tu menú' : `tus ${noun}`} con precios para mostrarlos fácilmente por WhatsApp.` });
  if (['ROPA', 'TIENDA', 'COMIDA', 'GENERAL'].includes(k)) out.push({ titulo: `Tomar los datos completos para los pedidos${f.delivery.mentioned ? ' y envíos' : ''}`, como_lo_resuelve: 'El asistente guía al cliente para recolectar los datos del pedido, la entrega y el pago.' });
  if (f.delivery.ownCouriers) out.push({ titulo: 'Coordinar los domicilios', como_lo_resuelve: 'Domicilios en vivo con tus domiciliarios y link de seguimiento para el cliente.' });
  if (f.deposit && f.prepay) out.push({ titulo: `Cobrar ${/anticipo/.test(plain(f.prepay)) ? 'el anticipo' : 'el abono'} para separar`, como_lo_resuelve: 'El asistente explica el pago para separar y pide el comprobante antes de confirmar.' });
  if (f.quotes) out.push({ titulo: 'Enviar cotizaciones rápido', como_lo_resuelve: 'El asistente pregunta los detalles y envía la cotización con tus precios.' });
  if (f.reminders) out.push({ titulo: `Recordar ${f.reminders}`, como_lo_resuelve: 'BackOffice envía recordatorios automáticos por WhatsApp en el momento justo.' });
  if (k === 'INMOBILIARIA' || f.wishes.some((w) => /filtr/.test(plain(w)))) out.push({ titulo: 'Filtrar a los interesados', como_lo_resuelve: 'El asistente pregunta presupuesto, zona y necesidades antes de pasarle el cliente a un asesor.' });
  if (f.documents.length && ['EDUCACION', 'INMOBILIARIA'].includes(k)) out.push({ titulo: 'Gestionar los documentos', como_lo_resuelve: `El asistente pide ${humanList(f.documents.slice(0, 4).map((d) => d.toLowerCase()))} y los deja organizados.` });
  if ((f.dailyChats ?? 0) >= 30) out.push({ titulo: 'Atender a muchos clientes al tiempo sin demoras', como_lo_resuelve: 'El asistente responde a todos a la vez, a cualquier hora.' });
  if (k === 'WEBCAM') out.push({ titulo: 'Validar pagos antes de enviar contenido', como_lo_resuelve: 'El asistente solo entrega el contenido cuando el pago está confirmado.' });
  out.push({ titulo: `Gestionar los ${['BELLEZA', 'SALUD', 'TALLER'].includes(k) ? 'servicios y pagos' : 'pedidos y las ventas'}`, como_lo_resuelve: 'BackOffice organiza clientes, ventas y pagos en un solo lugar.' });
  // Sin repetidos: dos necesidades que empiezan igual ("Agendar…") se quedan con la primera
  const seen = new Set<string>();
  return out.filter((n) => {
    const key = plain(n.titulo).split(' ').slice(0, 2).join(' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

function flowFor(f: Facts, noun: string, business: string): string[] {
  const k = f.profile.key;
  const steps = [`Saluda al cliente y se presenta como asistente de ${business}.`, 'Pregunta cómo puede ayudar y qué está buscando.'];
  const names = f.products.slice(0, 4).map((p) => p.name.toLowerCase());
  if (k === 'WEBCAM') steps.push('Conversa con calidez y conoce qué le gusta al fan.', 'Ofrece el contenido de la galería.');
  else if (names.length) steps.push(`Muestra ${the(noun)} (${humanList(names)}) con sus precios.`);
  else steps.push(`Da información sobre ${the(noun)} disponibles.`);
  if (f.asks.length) steps.push(`Responde preguntas sobre ${humanList(f.asks.slice(0, 3))}.`);
  if (k === 'INMOBILIARIA') steps.push('Pregunta presupuesto, zona y número de habitaciones para filtrar opciones.', 'Envía fotos de los inmuebles que coinciden.', 'Agenda la visita con un asesor.');
  else if (k === 'EDUCACION') steps.push(`Solicita los documentos para la inscripción${f.documents.length ? ` (${humanList(f.documents.slice(0, 3).map((d) => d.toLowerCase()))})` : ''}.`);
  else if (f.quotes) steps.push(`Pregunta los detalles${f.collect.length ? ` (${humanList(f.collect.slice(0, 3))})` : ''} y envía la cotización.`);
  else if (f.appointments) steps.push('Ofrece horarios disponibles y agenda la cita.');
  else if (['ROPA', 'TIENDA', 'COMIDA', 'GENERAL'].includes(k)) steps.push(`Si el cliente quiere comprar, solicita los datos del pedido${f.delivery.mentioned ? ' y de entrega' : ''}.`);
  for (const w of f.wishes.slice(0, 2)) {
    const need = wishToNeed(w);
    if (need.split(' ').length >= 2 && !steps.some((x) => plain(x).includes(plain(need).split(' ')[0].slice(0, 5)))) steps.push(`Si hace falta: ${need.charAt(0).toLowerCase()}${need.slice(1)}.`);
  }
  if (f.payments.length || f.prepay) steps.push(`Explica los medios de pago${f.payments.length ? ` (${humanList(f.payments)})` : ''}${f.prepay ? ` y ${f.prepay.toLowerCase()}` : ''}.`);
  if (k === 'WEBCAM') steps.push('Confirma el pago antes de enviar el contenido.');
  steps.push(f.appointments && k !== 'INMOBILIARIA' ? 'Confirma la cita y los datos del cliente.' : 'Confirma el pedido y los datos del cliente.');
  if (f.delivery.shipping) steps.push('Informa el proceso de envío y los tiempos de entrega.');
  if (f.reminders) steps.push(`Recuerda ${f.reminders} cuando corresponda.`);
  steps.push('Agradece y se despide con amabilidad.');
  return steps.slice(0, 10);
}

function repliesFor(f: Facts, noun: string) {
  const k = f.profile.key;
  const rr: Array<{ atajo: string; titulo: string; texto: string }> = [];
  const faq: Array<{ pregunta: string; respuesta: string }> = [];
  const priced = f.products.filter((p) => p.price != null);
  const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  if (k === 'ROPA') {
    rr.push({ atajo: 'tallas', titulo: 'Información de tallas', texto: '¡Hola! ¿Qué talla usas normalmente? Te ayudo a elegir la talla correcta según tus medidas.' });
    faq.push({ pregunta: '¿Qué tallas manejan?', respuesta: 'Te ayudamos a elegir la talla según tus medidas. Cuéntanos qué prenda te gusta.' });
  }
  if (priced.length) {
    const txt = priced.slice(0, 6).map((p) => `${p.name} ${cop(p.price!)}`).join(', ');
    rr.push({ atajo: 'precios', titulo: `Precios de ${noun}`, texto: `Nuestros precios: ${txt}. ¿Cuál te interesa?` });
    for (const p of priced.slice(0, 3)) faq.push({ pregunta: `¿Cuánto cuesta ${p.name.toLowerCase()}?`, respuesta: `${p.name} tiene un valor de ${cop(p.price!)}.` });
  }
  if (f.products.length) {
    rr.push({ atajo: 'catalogo', titulo: cap(our(noun)), texto: `Tenemos ${humanList(f.products.slice(0, 6).map((p) => p.name.toLowerCase()))}. ¿Te muestro alguno?` });
    faq.push({ pregunta: `¿Qué ${noun} ofrecen?`, respuesta: `Ofrecemos ${humanList(f.products.slice(0, 6).map((p) => p.name.toLowerCase()))}.` });
  }
  if (f.payments.length || f.prepay) {
    const txt = `${f.payments.length ? `Recibimos pagos por ${humanList(f.payments)}.` : ''}${f.prepay ? ` Para separar: ${f.prepay.toLowerCase()}.` : ''}`.trim();
    rr.push({ atajo: 'pago', titulo: 'Métodos de pago', texto: txt });
    faq.push({ pregunta: '¿Cómo puedo pagar?', respuesta: txt });
  }
  if (f.delivery.mentioned) {
    rr.push({ atajo: 'envio', titulo: k === 'COMIDA' ? 'Domicilios' : 'Información de envíos', texto: `${cap(f.delivery.sentence)}.` });
    faq.push({ pregunta: k === 'COMIDA' ? '¿Hacen domicilios?' : '¿Hacen envíos?', respuesta: `Sí. ${cap(f.delivery.sentence)}.` });
  }
  if (f.schedule) {
    const d = f.schedule.days;
    const days = d.length === 7 ? 'todos los días' : d.length > 1 && d[d.length - 1] - d[0] === d.length - 1 ? `de ${DAY_NAMES[d[0]]} a ${DAY_NAMES[d[d.length - 1]]}` : humanList(d.map((x) => DAY_NAMES[x]));
    const txt = `Atendemos ${days} de ${f.schedule.open} a ${f.schedule.close}.`;
    rr.push({ atajo: 'horario', titulo: 'Horario de atención', texto: txt });
    faq.push({ pregunta: '¿Cuál es el horario de atención?', respuesta: txt });
  }
  if (f.documents.length) {
    const txt = `Para continuar necesitamos: ${humanList(f.documents.map((x) => x.toLowerCase()))}.`;
    rr.push({ atajo: 'requisitos', titulo: k === 'EDUCACION' ? 'Requisitos de inscripción' : 'Documentos necesarios', texto: txt });
    faq.push({ pregunta: k === 'EDUCACION' ? '¿Cuáles son los requisitos para inscribirme?' : '¿Qué documentos necesito?', respuesta: txt });
  }
  if (f.appointments) {
    const what = k === 'INMOBILIARIA' ? 'visita' : 'cita';
    rr.push({ atajo: 'agendar', titulo: `Agendar ${what}`, texto: `¡Claro! ¿Qué día y hora te quedan bien para tu ${what}?` });
    faq.push({ pregunta: `¿Cómo puedo agendar una ${what}?`, respuesta: `Escríbenos por aquí el día y la hora que prefieres y te confirmamos la ${what}.` });
  }
  if (f.anticipation) {
    rr.push({ atajo: 'anticipacion', titulo: 'Tiempo de anticipación', texto: `Recibimos pedidos con ${f.anticipation}.` });
    faq.push({ pregunta: '¿Con cuánta anticipación debo pedir?', respuesta: `Con ${f.anticipation}.` });
  }
  for (const a of f.asks.slice(0, 2)) {
    if (!faq.some((x) => plain(x.pregunta).includes(plain(a).split(' ')[0]))) faq.push({ pregunta: `¿${cap(a)}?`, respuesta: 'Con gusto te cuento: dime qué necesitas y te doy la información.' });
  }
  return { rr: rr.slice(0, 6), faq: faq.slice(0, 6) };
}

/** Plano completo en el formato de la IA (rubro, empresa, necesidades, herramientas, embudo…). */
export function codeBlueprint(pairs: Pair[]) {
  const f = extractFacts(pairs);
  const k = f.profile.key;
  const noun = NOUN[k];
  const business = f.name || 'tu negocio';
  const { rr, faq } = repliesFor(f, noun);
  const topics = k === 'WEBCAM' ? 'nuestro contenido' : `${our(noun)}, precios${f.appointments ? ' y citas' : f.delivery.mentioned ? ', pedidos y envíos' : ' y pedidos'}`;
  const deliveryOn = f.delivery.mentioned;
  return {
    rubro: f.rubro,
    tipo_negocio: f.businessType,
    empresa: { nombre: f.name, ciudad: f.city, resumen: `${f.businessType}${f.city ? ` en ${f.city}` : ''}.` },
    necesidades: needsFor(f, noun),
    herramientas: modulesFor(f),
    embudo: { nombre: `Proceso de ${['BELLEZA', 'SALUD', 'TALLER'].includes(k) ? 'atención' : 'venta'}${f.name ? ` ${f.name}` : ''}`, etapas: pipelineFor(f).map(([nombre, tipo]) => ({ nombre, tipo })) },
    productos: f.products.map((p) => ({ nombre: p.name, categoria: '', precio: p.price, descripcion: '', presentaciones: [] })),
    horario: f.schedule ? { dias: f.schedule.days, abre: f.schedule.open, cierra: f.schedule.close } : null,
    domicilios: deliveryOn ? { activo: true, tarifa_base: null, por_km: null, cobertura_km: null, tiempo_preparacion_min: null } : null,
    datos_cliente: clientDataFor(f),
    flujo_asistente: flowFor(f, noun, business),
    respuestas_rapidas: rr,
    seguimientos: [{ cuando: 'no_reply', horas: 3, mensaje: `¡Hola de nuevo! ¿Tienes alguna otra pregunta sobre ${our(noun)}? Estoy aquí para ayudarte.` }],
    preguntas: faq,
    asistente: {
      nombre: 'Sofía',
      tono: 'Amable y servicial',
      estilo: 'Claro y directo',
      bienvenida: `¡Hola! Soy Sofía, la asistente virtual de ${business}. Estoy aquí para ayudarte con ${topics}. ¿Cómo puedo ayudarte hoy?`,
      instrucciones: `Atiende a los clientes de ${business}${f.businessType ? ` (${f.businessType.toLowerCase()})` : ''}: responde sobre ${the(noun)}${f.products.length ? ` como ${humanList(f.products.slice(0, 3).map((p) => p.name.toLowerCase()))}` : ''}, precios${f.payments.length ? `, medios de pago (${humanList(f.payments)})` : ''}${f.delivery.mentioned ? ' y envíos' : ''}${f.appointments ? ' y agenda citas' : ''}. Nunca inventa precios ni promociones; si no sabe algo, pasa la conversación a una persona del equipo.${k === 'WEBCAM' ? ' Nunca envía contenido sin pago confirmado.' : ''}`,
    },
  };
}

/* ── Entrevista sin IA: pregunta solo lo que aún no sabe ──────────── */

interface Topic { key: string; when: (f: Facts) => boolean; done: (f: Facts) => boolean; ask: (f: Facts) => { pregunta: string; opciones: string[] } }

const SELLS = (f: Facts) => ['ROPA', 'TIENDA', 'COMIDA', 'GENERAL', 'WEBCAM'].includes(f.profile.key);

const TOPICS: Topic[] = [
  {
    key: 'oferta', when: () => true, done: (f) => f.products.length >= 2,
    ask: (f) => ({ pregunta: `¿Qué ${NOUN[f.profile.key]} ofreces y a qué precio, más o menos?`, opciones: [] }),
  },
  {
    key: 'entrega', when: (f) => SELLS(f) && f.profile.key !== 'WEBCAM', done: (f) => f.delivery.mentioned,
    ask: (f) => ({
      pregunta: f.profile.key === 'COMIDA' ? '¿Cómo le llega la comida a tus clientes?' : '¿Cómo le llegan los pedidos a tus clientes?',
      opciones: f.profile.key === 'COMIDA'
        ? ['Domicilio con mis domiciliarios', 'Domicilio por apps', 'Vienen a recoger', 'Las dos: domicilio y recoger']
        : ['Envío por transportadora', 'Recogen en la tienda', 'Domicilio en la ciudad', 'Las dos'],
    }),
  },
  {
    key: 'citas', when: (f) => !SELLS(f), done: (f) => f.appointments,
    ask: (f) => ({
      pregunta: f.profile.key === 'EDUCACION' ? '¿Tus cursos tienen fechas y cupos?' : f.profile.key === 'INMOBILIARIA' ? '¿Cómo funcionan las visitas a los inmuebles?' : '¿Tus clientes agendan cita o turno?',
      opciones: f.profile.key === 'EDUCACION' ? ['Sí, fechas fijas con cupos', 'Cuando el estudiante quiera', 'Las dos'] : ['Sí, con cita', 'Sí, por cupos o grupos', 'No, llegan sin cita'],
    }),
  },
  {
    key: 'tareas', when: () => true, done: (f) => f.operation.answers.manualTasks.length + f.operation.answers.timeConsuming.length > 0,
    ask: () => ({ pregunta: '¿Qué haces a mano que más tiempo te quita?', opciones: ['Responder lo mismo todo el día', 'Anotar reservas o pedidos a mano', 'Cobrar y confirmar pagos', 'Hacer seguimiento a clientes'] }),
  },
  {
    key: 'equipo', when: () => true, done: (f) => f.operation.signals.people !== null,
    ask: () => ({ pregunta: '¿Cuántas personas trabajan contigo?', opciones: ['Solo yo', '2 a 3 personas', '4 a 10 personas', 'Más de 10 personas'] }),
  },
  {
    key: 'marketing', when: () => true, done: (f) => f.operation.answers.wantsContent !== null || f.operation.answers.wantsAds !== null,
    ask: () => ({ pregunta: '¿También necesitas contenido para redes o manejas publicidad pagada?', opciones: ['Solo atender clientes', 'Contenido para redes', 'Publicidad pagada', 'Contenido y publicidad'] }),
  },
  {
    key: 'pagos', when: () => true, done: (f) => f.payments.length > 0,
    ask: () => ({ pregunta: '¿Cómo te pagan tus clientes?', opciones: ['Transferencia o Nequi', 'Efectivo', 'Tarjeta o link de pago', 'Varias formas'] }),
  },
  {
    key: 'preguntan', when: () => true, done: (f) => f.asks.length > 0,
    ask: (f) => ({
      pregunta: '¿Qué te preguntan primero tus clientes?',
      opciones: ({
        ROPA: ['Tallas y disponibilidad', 'El precio', 'Cómo es el envío', 'Cambios y devoluciones'],
        COMIDA: ['El menú del día', 'El precio', 'Si hay domicilio', 'El horario'],
        BELLEZA: ['Precios', 'Disponibilidad de citas', 'Cuánto dura', 'Si piden anticipo'],
        SALUD: ['Precio de la consulta', 'Disponibilidad de citas', 'Si atienden por EPS', 'Requisitos'],
        EDUCACION: ['Fechas y cupos', 'Precio', 'Requisitos', 'Si dan certificado'],
        INMOBILIARIA: ['Precio', 'Zona', 'Habitaciones', 'Requisitos para arrendar'],
        RESERVAS: ['Disponibilidad', 'El precio por hora', 'Si piden anticipo', 'Dónde queda'],
      } as Partial<Record<ProfileKey, string[]>>)[f.profile.key] ?? ['El precio', 'Disponibilidad', 'Cómo pagar', 'Tiempos de entrega'],
    }),
  },
  {
    key: 'horario', when: (f) => f.profile.key !== 'WEBCAM', done: (f) => !!f.schedule,
    ask: () => ({ pregunta: '¿Qué días y en qué horario atiendes?', opciones: ['Lunes a viernes de 8 am a 6 pm', 'Lunes a sábado de 9 am a 7 pm', 'Todos los días de 8 am a 8 pm'] }),
  },
  {
    key: 'documentos', when: (f) => ['EDUCACION', 'INMOBILIARIA', 'SALUD'].includes(f.profile.key), done: (f) => f.documents.length > 0,
    ask: () => ({ pregunta: '¿Qué datos o documentos le pides al cliente?', opciones: ['Cédula', 'Certificados', 'Un anticipo', 'Nada especial'] }),
  },
  {
    key: 'asistente', when: () => true, done: (f) => f.wishes.length > 0,
    ask: (f) => ({
      pregunta: '¿Qué quieres que haga el asistente por ti?',
      opciones: SELLS(f) ? ['Responder preguntas', 'Tomar pedidos', 'Mostrar el catálogo', 'Cobrar y confirmar pagos'] : ['Responder preguntas', 'Agendar citas', 'Enviar cotizaciones', 'Recordar citas'],
    }),
  },
];

/** Siguiente pregunta sin IA: la primera que aún no está respondida (máx. `max` respuestas). */
export function codeInterviewTurn(pairs: Pair[], max = 8) {
  if (pairs.length >= max) return { listo: true, pregunta: '', opciones: [], nota: '' };
  const f = extractFacts(pairs);
  const asked = new Set(pairs.map(([q]) => plain(q)));
  for (const t of TOPICS) {
    if (!t.when(f) || t.done(f)) continue;
    const q = t.ask(f);
    if (asked.has(plain(q.pregunta))) continue; // ya se preguntó y no lo entendimos: no insistir
    return { listo: false, pregunta: q.pregunta, opciones: q.opciones, nota: '' };
  }
  return { listo: true, pregunta: '', opciones: [], nota: '' };
}

/** Conversación del registro → pares (pregunta, respuesta). */
export function toPairs(msgs: Array<{ role: string; content: string }>): Pair[] {
  const out: Pair[] = [];
  msgs.forEach((m, i) => {
    if (m.role !== 'user') return;
    const prev = msgs[i - 1];
    out.push([prev?.role === 'assistant' ? prev.content : '', m.content]);
  });
  return out;
}
