/**
 * Perfil de incorporación: el modelo ÚNICO con el que se configura una empresa,
 * lo arme la entrevista de IA (autoservicio) o un administrador en una reunión
 * (asistido). Separa tres cosas que antes se confundían:
 *
 *  1. Perfil de negocio: sector y actividad concreta (canchas, catering…).
 *  2. Complejidad operativa: SIMPLE | INTERMEDIATE | COMPLEX, calculada con
 *     señales de cómo trabaja (etapas, personas, dependencias entre áreas,
 *     aprobaciones, sistemas externos y volumen), NO con el sector.
 *  3. Productos: Automation, Creative y Ads Intelligence, cada uno por separado.
 *
 * De ahí salen las capacidades que necesita, cada una con su estado REAL en el
 * sistema (disponible, parcial o próxima fase): nada se presenta como hecho si
 * no lo está. Todo es código determinista y se valida aquí; lo que mande el
 * navegador o la IA se normaliza y se recalcula en el servidor.
 *
 * Se guarda en Company.onboardingJson.setup (versionado). Los demás campos de
 * onboardingJson no cambian: sus consumidores siguen igual.
 */
import { PRODUCTS, PRODUCT_INFO, ProductKey, isProductKey } from './products';
import { PROFILES, ProfileKey, detectProfile } from './business-profile';

export const SETUP_VERSION = 1;

/* ── Catálogos ─────────────────────────────────────────────────────── */

export const NEEDS = ['RESERVAS', 'PEDIDOS', 'VENTAS', 'ATENCION', 'COORDINACION', 'PROCESOS_INTERNOS'] as const;
export type Need = (typeof NEEDS)[number];
export const NEED_LABEL: Record<Need, string> = {
  RESERVAS: 'Reservas, citas o turnos',
  PEDIDOS: 'Pedidos',
  VENTAS: 'Ventas y cotizaciones',
  ATENCION: 'Atención y preguntas de clientes',
  COORDINACION: 'Coordinación entre áreas (compras, producción, entregas)',
  PROCESOS_INTERNOS: 'Procesos internos (aprobaciones, solicitudes, tareas del equipo)',
};

export const INTAKE = ['WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'Llamadas', 'Presencial', 'Página web', 'Apps de domicilios', 'Correo'] as const;

export const COMPLEXITY = ['SIMPLE', 'INTERMEDIATE', 'COMPLEX'] as const;
export type Complexity = (typeof COMPLEXITY)[number];
export const COMPLEXITY_LABEL: Record<Complexity, string> = { SIMPLE: 'Simple', INTERMEDIATE: 'Intermedia', COMPLEX: 'Compleja' };

/** Estado real en el sistema: lo que no existe se dice. */
export type CapabilityStatus = 'AVAILABLE' | 'PARTIAL' | 'PLANNED';

export const CAPABILITIES = {
  ATENCION_IA: { label: 'Atención por WhatsApp con asistente de IA y paso a una persona', product: 'AUTOMATION', modules: [], status: 'AVAILABLE', note: '' },
  PEDIDOS: { label: 'Pedidos con catálogo y precios', product: 'AUTOMATION', modules: ['orders'], status: 'AVAILABLE', note: '' },
  DOMICILIOS: { label: 'Domicilios con seguimiento en vivo', product: 'AUTOMATION', modules: ['delivery'], status: 'AVAILABLE', note: '' },
  PRODUCCION: { label: 'Coordinación por áreas (cocina, taller, empaque)', product: 'AUTOMATION', modules: ['production'], status: 'AVAILABLE', note: '' },
  AGENDA: {
    label: 'Reservas por el chat con disponibilidad real', product: 'AUTOMATION', modules: ['agenda'], status: 'AVAILABLE',
    note: 'El asistente consulta los turnos libres, reserva cuando el cliente confirma, y cancela o reprograma; nunca reserva dos veces el mismo espacio. Se activa al configurar tus espacios, servicios y horario en Agenda.',
  },
  RECORDATORIOS: {
    label: 'Recordatorios y seguimiento', product: 'AUTOMATION', modules: ['campaigns'], status: 'PARTIAL',
    note: 'Recordatorio de cada reserva por WhatsApp. Dentro de las 24 h de la última conversación sale solo; fuera de ellas Meta exige la plantilla aprobada «recordatorio_reserva» (si no existe, queda registrado que no se envió).',
  },
  SEGUIMIENTO_VENTAS: { label: 'Embudo de ventas, seguimientos y reactivación', product: 'AUTOMATION', modules: ['campaigns'], status: 'AVAILABLE', note: '' },
  REPORTES: { label: 'Reporte diario para el dueño o gerente', product: 'AUTOMATION', modules: ['gerencia'], status: 'AVAILABLE', note: '' },
  INTEGRACIONES: {
    label: 'Conexión con tus otros sistemas', product: 'AUTOMATION', modules: [], status: 'PARTIAL',
    note: 'Hoy: pedidos de otras plataformas por API. Conectar cada sistema que usas se revisa con el equipo.',
  },
  PROCESOS: {
    label: 'Procesos internos de varias etapas con responsables', product: 'AUTOMATION', modules: [], status: 'PLANNED',
    note: 'Queda registrado lo que necesitas; el motor de procesos llega en la próxima fase.',
  },
  APROBACIONES: {
    label: 'Aprobaciones humanas dentro de los procesos', product: 'AUTOMATION', modules: [], status: 'PLANNED',
    note: 'Hoy toda acción que gasta dinero pide confirmación y la IA pasa a una persona lo que no sabe; los flujos de aprobación configurables llegan en la próxima fase.',
  },
  CONTENIDO: { label: 'Diseños y contenido para redes', product: 'CREATIVE', modules: [], status: 'AVAILABLE', note: '' },
  PUBLICIDAD: {
    label: 'Gestión y análisis de publicidad pagada', product: 'ADS', modules: [], status: 'AVAILABLE',
    note: 'Meta (Facebook e Instagram). Google y TikTok aún no están conectados.',
  },
} as const satisfies Record<string, { label: string; product: ProductKey; modules: readonly string[]; status: CapabilityStatus; note: string }>;
export type CapabilityKey = keyof typeof CAPABILITIES;

/** Sistemas que la gente nombra: así se cuentan las herramientas externas. */
const TOOLS: Array<[RegExp, string]> = [
  [/excel|hoja de calculo/, 'Excel'], [/google sheets|sheets|hojas de google/, 'Google Sheets'], [/siigo/, 'Siigo'], [/alegra/, 'Alegra'],
  [/world office/, 'World Office'], [/helisa/, 'Helisa'], [/\bsap\b/, 'SAP'], [/odoo/, 'Odoo'], [/quickbooks/, 'QuickBooks'],
  [/shopify/, 'Shopify'], [/woocommerce|wordpress/, 'WooCommerce'], [/\bwix\b/, 'Wix'], [/mercado ?libre/, 'Mercado Libre'],
  [/rappi/, 'Rappi'], [/didi/, 'DiDi Food'], [/uber eats/, 'Uber Eats'], [/ifood/, 'iFood'], [/calendly/, 'Calendly'],
  [/google calendar|calendario de google/, 'Google Calendar'], [/hubspot/, 'HubSpot'], [/trello/, 'Trello'], [/notion/, 'Notion'],
  [/\bpos\b|punto de venta|software de caja/, 'Punto de venta'], [/factura(cion)? electronica|dian/, 'Facturación electrónica'],
];

/** Áreas o roles por los que pasa el trabajo: cada traspaso es una dependencia. */
const AREAS: Array<[RegExp, string]> = [
  [/compras|proveedor/, 'compras'], [/produccion|cocina|taller|fabrica|confeccion/, 'producción'], [/bodega|inventario/, 'bodega'],
  [/despacho|empaque|logistic/, 'despacho'], [/entrega|domicili|mensajer|transport/, 'entregas'], [/contabilidad|facturaci|cartera/, 'contabilidad'],
  [/ventas|comercial|asesor/, 'ventas'], [/diseno|creativ/, 'diseño'], [/calidad|revision/, 'calidad'], [/recepcion/, 'recepción'],
];

/* ── Tipos ─────────────────────────────────────────────────────────── */

export interface SetupAnswers {
  /** Qué vende o qué servicio presta, en sus palabras */
  offer: string;
  /** Por dónde le llegan las solicitudes */
  intake: string[];
  /** Tareas que hace a mano */
  manualTasks: string[];
  /** Las que más tiempo le quitan */
  timeConsuming: string[];
  needs: Need[];
  /** Lo que quiere automatizar */
  automate: string[];
  /** Lo que debe seguir aprobando una persona */
  humanApproval: string[];
  /** null = no se sabe */
  wantsContent: boolean | null;
  wantsAds: boolean | null;
  /** Sistemas o integraciones que usa o necesita */
  integrations: string[];
}

export interface OperationSignals {
  stages: number | null;
  people: number | null;
  /** Áreas distintas por las que pasa el trabajo */
  areas: string[];
  dailyVolume: number | null;
}

export interface CapabilityView {
  key: CapabilityKey;
  label: string;
  product: ProductKey;
  status: CapabilityStatus;
  note: string;
  /** El producto de la capacidad está entre los elegidos */
  included: boolean;
  why: string;
}

export interface SetupProfile {
  version: number;
  source: 'SELF_SERVICE' | 'ASSISTED';
  business: { profileKey: ProfileKey; label: string; activity: string };
  answers: SetupAnswers;
  signals: OperationSignals;
  complexity: {
    level: Complexity;
    /** Calculada por las señales (la que manda si no hay ajuste) */
    computed: Complexity;
    score: number;
    reasons: string[];
    /** Ajuste del administrador, con su motivo */
    override: { level: Complexity; reason: string; by: string | null } | null;
  };
  products: { selected: ProductKey[]; recommended: ProductKey[]; reasons: Partial<Record<ProductKey, string[]>> };
  capabilities: CapabilityView[];
  agentCallId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export class SetupValidationError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

/* ── Utilidades ────────────────────────────────────────────────────── */

const plain = (t: unknown) => ` ${String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v: unknown, max = 10, len = 80) => {
  const seen = new Set<string>();
  return (Array.isArray(v) ? v : [])
    .map((x) => str(x, len))
    .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()))
    .slice(0, max);
};
const int = (v: unknown, min: number, max: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[^\d.]/g, '')) : NaN;
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : null;
};
const bool = (v: unknown) => (v === true || v === false ? v : null);
const sentences = (t: string) => String(t ?? '').split(/(?<!\d)[.;\n]|[.;\n](?!\d)/).map((x) => x.trim()).filter(Boolean);

export function isNeed(v: unknown): v is Need {
  return typeof v === 'string' && (NEEDS as readonly string[]).includes(v);
}
export function isComplexity(v: unknown): v is Complexity {
  return typeof v === 'string' && (COMPLEXITY as readonly string[]).includes(v);
}

/* ── Lectura de lo que contó el dueño (sin IA) ─────────────────────── */

/**
 * Señales y respuestas que se leen del texto por código. Es el respaldo de la
 * IA y también completa lo que la IA deje vacío.
 */
export function readOperation(text: string, dailyVolume: number | null = null): { answers: SetupAnswers; signals: OperationSignals } {
  const t = plain(text);
  const all = sentences(text);
  const needs = new Set<Need>();
  if (/reserv|cancha|turno|\bcita|agend|cupo|disponibilidad|alquil|separar (la|el) /.test(t)) needs.add('RESERVAS');
  if (/pedido|domicili|encargo|ordenes de compra|para llevar|despach/.test(t)) needs.add('PEDIDOS');
  if (/cotiza|vend|prospect|clientes potenciales|seguimiento a (los )?(clientes|interesados)|cerrar (la )?venta/.test(t)) needs.add('VENTAS');
  if (/pregunt|responder|atender|dudas|informacion|whatsapp/.test(t)) needs.add('ATENCION');
  if (/coordin|compras|produccion|bodega|logistic|despacho|proveedor|inventario/.test(t)) needs.add('COORDINACION');
  if (/proceso interno|aprob|aprue|autoriz|visto bueno|requisici|solicitudes internas|orden(es)? de trabajo|flujo de trabajo|nomina/.test(t)) needs.add('PROCESOS_INTERNOS');

  const intake = INTAKE.filter((c) => ({
    WhatsApp: /whatsapp|wpp|whats/, Instagram: /instagram|\big\b/, Facebook: /facebook|\bfb\b/, TikTok: /tiktok/, Llamadas: /llamad|telefono|nos llaman/,
    Presencial: /presencial|llegan al local|en el local|en persona|van al/, 'Página web': /pagina web|sitio web|tienda online|web/, 'Apps de domicilios': /rappi|didi|uber eats|ifood/, Correo: /correo|email|e-mail/,
  } as Record<string, RegExp>)[c].test(t));

  // Personas: "somos 5", "12 empleados", "equipo de 3", "solo yo"
  let people: number | null = null;
  const pm = /somos (\d{1,4})|(\d{1,4}) (personas|empleados|trabajadores|colaboradores|en el equipo)|equipo de (\d{1,4})/.exec(t);
  const more = /mas de (\d{1,4}) (personas|empleados|trabajadores)/.exec(t);
  if (more) people = Number(more[1]) + 1;
  else if (pm) people = Number(pm[1] ?? pm[2] ?? pm[4]);
  else if (/(yo|solo yo) y mi (hermano|hermana|socio|socia|esposo|esposa|pareja|mama|papa|hijo|hija)|somos dos/.test(t)) people = 2;
  else if (/solo yo|yo solo|yo sola|lo hago yo|unicamente yo/.test(t)) people = 1;

  // Etapas: "5 pasos" o los conectores de una secuencia (primero, luego, después, finalmente…)
  let stages: number | null = null;
  const sm = /(\d{1,2}) (pasos|etapas|fases)/.exec(t);
  if (sm) stages = Number(sm[1]);
  else {
    const seq = (t.match(/\b(primero|luego|despues|entonces|finalmente|por ultimo|al final)\b/g) ?? []).length;
    if (seq >= 2) stages = seq + 1;
  }

  const areas = [...new Set(AREAS.filter(([re]) => re.test(t)).map(([, n]) => n))];
  const integrations = [...new Set(TOOLS.filter(([re]) => re.test(t)).map(([, n]) => n))];
  const manual = all.filter((x) => /a mano|manual|me toca|nos toca|anoto|anotamos|apunto|cuaderno|uno por uno|copio|copiamos/.test(plain(x))).map((x) => str(x, 120));
  const slow = all.filter((x) => /tiempo|todo el dia|demora|tarda|lo que mas|me quita|perdemos|pierdo/.test(plain(x))).map((x) => str(x, 120));
  const approvals = all.filter((x) => /aprob|aprue|autoriz|visto bueno|revis[ae] (el|la|mi) (gerente|jefe|duen|supervisor|socio)|pasar por (mi|el gerente|una persona)|siempre (lo|la) (decido|reviso|apruebo)/.test(plain(x))).map((x) => str(x, 120));
  const automate = all.filter((x) => /quiero que|me gustaria que|que (el asistente|la ia|el bot) /.test(plain(x))).map((x) => str(x, 120));
  const content = /redes sociales|contenido|publicaciones|posts?\b|historias|diseno|disenos|piezas graficas|flyer|reels/.test(t);
  const ads = /publicidad|pauta|anuncio|\bads\b|campanas pagadas|promocionar|meta ads|facebook ads|google ads|pautar/.test(t);
  const onlyService = /solo atender (a los |a mis )?clientes/.test(t);
  const noContent = onlyService || /no (necesito|quiero|hago) (contenido|redes|disenos)/.test(t);
  const noAds = onlyService || /no (hago|pago|necesito|quiero) (publicidad|pauta|anuncios)/.test(t);

  return {
    answers: {
      offer: '',
      intake,
      manualTasks: list(manual, 8, 120),
      timeConsuming: list(slow, 6, 120),
      needs: NEEDS.filter((n) => needs.has(n)),
      automate: list(automate, 8, 120),
      humanApproval: list(approvals, 6, 120),
      wantsContent: noContent ? false : content ? true : null,
      wantsAds: noAds ? false : ads ? true : null,
      integrations,
    },
    signals: { stages, people, areas, dailyVolume },
  };
}

/** Lo que devuelve la IA en el plano (`operacion`), validado; lo inválido se descarta. */
export function operationFromAi(raw: unknown): { answers: Partial<SetupAnswers>; signals: Partial<OperationSignals> } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const needsMap: Record<string, Need> = {
    reservas: 'RESERVAS', pedidos: 'PEDIDOS', ventas: 'VENTAS', atencion: 'ATENCION', coordinacion: 'COORDINACION', procesos_internos: 'PROCESOS_INTERNOS',
  };
  const needs = list(o.necesidades, 6, 30).map((n) => needsMap[plain(n).trim().replace(/\s+/g, '_')] ?? (isNeed(n.toUpperCase()) ? (n.toUpperCase() as Need) : null)).filter(Boolean) as Need[];
  return {
    answers: {
      ...(str(o.que_ofrece, 200) ? { offer: str(o.que_ofrece, 200) } : {}),
      ...(Array.isArray(o.canales_entrada) ? { intake: list(o.canales_entrada, 9, 40) } : {}),
      ...(Array.isArray(o.tareas_manuales) ? { manualTasks: list(o.tareas_manuales, 8, 120) } : {}),
      ...(Array.isArray(o.tareas_que_mas_tiempo) ? { timeConsuming: list(o.tareas_que_mas_tiempo, 6, 120) } : {}),
      ...(needs.length ? { needs } : {}),
      ...(Array.isArray(o.automatizar) ? { automate: list(o.automatizar, 8, 120) } : {}),
      ...(Array.isArray(o.requiere_aprobacion) ? { humanApproval: list(o.requiere_aprobacion, 6, 120) } : {}),
      ...(bool(o.quiere_contenido) !== null ? { wantsContent: bool(o.quiere_contenido) } : {}),
      ...(bool(o.quiere_publicidad) !== null ? { wantsAds: bool(o.quiere_publicidad) } : {}),
      ...(Array.isArray(o.sistemas) ? { integrations: list(o.sistemas, 10, 40) } : {}),
    },
    signals: {
      ...(int(o.etapas, 1, 50) !== null ? { stages: int(o.etapas, 1, 50) } : {}),
      ...(int(o.personas, 1, 10000) !== null ? { people: int(o.personas, 1, 10000) } : {}),
      ...(Array.isArray(o.areas) ? { areas: list(o.areas, 10, 40) } : {}),
    },
  };
}

/* ── Complejidad ───────────────────────────────────────────────────── */

/**
 * Complejidad por cómo trabaja, no por el sector. Cada señal suma 0, 1 o 2:
 * etapas, personas, dependencias entre áreas, aprobaciones, sistemas externos
 * y volumen; procesos internos o coordinación entre áreas suman 1.
 */
export function computeComplexity(a: SetupAnswers, s: OperationSignals): { level: Complexity; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    if (points > 0) {
      score += points;
      reasons.push(reason);
    }
  };
  if (s.stages !== null) add(s.stages >= 5 ? 2 : s.stages >= 3 ? 1 : 0, `${s.stages} etapas en su proceso`);
  if (s.people !== null) add(s.people > 10 ? 2 : s.people >= 3 ? 1 : 0, `${s.people} ${s.people === 1 ? 'persona' : 'personas'} en el equipo`);
  const handoffs = Math.max(0, s.areas.length - 1);
  add(handoffs >= 3 ? 2 : handoffs >= 1 ? 1 : 0, `el trabajo pasa por ${s.areas.length} áreas (${s.areas.join(', ')})`);
  add(a.humanApproval.length >= 2 ? 2 : a.humanApproval.length === 1 ? 1 : 0, `${a.humanApproval.length} ${a.humanApproval.length === 1 ? 'paso necesita' : 'pasos necesitan'} aprobación de una persona`);
  add(a.integrations.length >= 3 ? 2 : a.integrations.length >= 1 ? 1 : 0, `usa ${a.integrations.join(', ')}`);
  if (s.dailyVolume !== null) add(s.dailyVolume > 100 ? 2 : s.dailyVolume >= 30 ? 1 : 0, `unos ${s.dailyVolume} clientes al día`);
  if (a.needs.includes('PROCESOS_INTERNOS')) add(1, 'tiene procesos internos que coordinar');
  if (a.needs.includes('COORDINACION')) add(1, 'coordina compras, producción o entregas');
  const level: Complexity = score >= 7 ? 'COMPLEX' : score >= 3 ? 'INTERMEDIATE' : 'SIMPLE';
  if (!reasons.length) reasons.push('pocas etapas, un equipo pequeño y sin aprobaciones ni sistemas externos');
  return { level, score, reasons };
}

/* ── Capacidades y productos ───────────────────────────────────────── */

export function deriveCapabilities(profileKey: ProfileKey, a: SetupAnswers, s: OperationSignals, level: Complexity, text = ''): Array<{ key: CapabilityKey; why: string }> {
  const out = new Map<CapabilityKey, string>();
  const t = plain(text);
  const operational = a.needs.length > 0 || a.intake.some((c) => c !== 'Presencial');
  if (operational) out.set('ATENCION_IA', 'Te escriben clientes y quieres responder rápido');
  if (a.needs.includes('RESERVAS')) {
    out.set('AGENDA', 'Trabajas con reservas, citas o turnos');
    out.set('RECORDATORIOS', 'Las reservas necesitan confirmación y recordatorio');
  }
  if (a.needs.includes('PEDIDOS')) {
    out.set('PEDIDOS', 'Recibes pedidos');
    const ownCouriers = /domiciliario|mensajero|motorizado|domicilios propios|nuestros domicilios/.test(t) || PROFILES[profileKey].shipping === 'DOMICILIARIOS';
    if (ownCouriers) out.set('DOMICILIOS', 'Entregas con tus propios domiciliarios');
    if (s.areas.some((x) => ['producción', 'despacho', 'bodega'].includes(x)) || a.needs.includes('COORDINACION')) {
      out.set('PRODUCCION', 'El pedido pasa por varias áreas antes de salir');
    }
  }
  if (a.needs.includes('VENTAS')) out.set('SEGUIMIENTO_VENTAS', 'Haces seguimiento para cerrar ventas');
  if (a.needs.includes('COORDINACION') && !a.needs.includes('PEDIDOS')) out.set('PROCESOS', 'Coordinas trabajo entre varias áreas');
  if (a.needs.includes('PROCESOS_INTERNOS') || (level === 'COMPLEX' && s.areas.length >= 3)) out.set('PROCESOS', 'Tienes procesos de varias etapas con responsables');
  if (a.humanApproval.length) out.set('APROBACIONES', 'Algunos pasos deben seguir aprobados por una persona');
  if (a.integrations.length) out.set('INTEGRACIONES', `Usas ${a.integrations.join(', ')}`);
  if (level !== 'SIMPLE' && operational) out.set('REPORTES', 'Con más etapas y personas conviene un resumen diario');
  if (a.wantsContent) out.set('CONTENIDO', 'Quieres contenido o diseños para tus redes');
  if (a.wantsAds) out.set('PUBLICIDAD', 'Inviertes o quieres invertir en publicidad pagada');
  return [...out.entries()].map(([key, why]) => ({ key, why }));
}

export function recommendProducts(caps: Array<{ key: CapabilityKey; why: string }>): { recommended: ProductKey[]; reasons: Partial<Record<ProductKey, string[]>> } {
  const reasons: Partial<Record<ProductKey, string[]>> = {};
  for (const c of caps) {
    const p = CAPABILITIES[c.key].product;
    reasons[p] = [...(reasons[p] ?? []), c.why];
  }
  let recommended = PRODUCTS.filter((p) => reasons[p]?.length);
  if (!recommended.length) {
    recommended = ['AUTOMATION'];
    reasons.AUTOMATION = ['Es la base para atender a tus clientes; puedes cambiarlo'];
  }
  return { recommended, reasons };
}

/** Herramientas del panel (Company.modules) que piden las capacidades de los productos elegidos. */
export function modulesForCapabilities(caps: Array<{ key: CapabilityKey }>, selected: ProductKey[]): string[] {
  return [...new Set(caps.filter((c) => selected.includes(CAPABILITIES[c.key].product)).flatMap((c) => [...CAPABILITIES[c.key].modules]))];
}

/** Herramientas de pedidos que sobran si ninguna capacidad las pide (reservas no es pedidos). */
export const ORDER_FAMILY = ['orders', 'production', 'delivery', 'menu'];

/**
 * Herramientas del panel según el perfil: se suman las que piden las capacidades
 * de los productos elegidos y se quitan las de pedidos que su perfil no usa y
 * ninguna capacidad pide (una cancha no necesita menú ni domicilios).
 */
export function alignModules(modules: string[], setup: Pick<SetupProfile, 'capabilities' | 'products' | 'business'>): string[] {
  const required = modulesForCapabilities(setup.capabilities, setup.products.selected);
  const deny = PROFILES[setup.business.profileKey]?.deny ?? [];
  const drop = new Set(ORDER_FAMILY.filter((m) => deny.includes(m) && !required.includes(m)));
  return [...new Set([...modules.filter((m) => !drop.has(m)), ...required])];
}

/* ── Armar y validar ───────────────────────────────────────────────── */

/** Productos elegidos: claves válidas, sin repetir, al menos uno. */
export function validateProducts(raw: unknown): ProductKey[] {
  if (!Array.isArray(raw)) throw new SetupValidationError('products', 'Elige al menos un producto');
  const bad = raw.filter((p) => !isProductKey(p));
  if (bad.length) throw new SetupValidationError('products', `Producto desconocido: ${bad.map(String).join(', ').slice(0, 60)}`);
  const out = PRODUCTS.filter((p) => raw.includes(p));
  if (!out.length) throw new SetupValidationError('products', 'Elige al menos un producto');
  return out;
}

/** Lo que no es un sistema que se pueda conectar: papel, cuaderno o los propios canales. */
const NOT_A_SYSTEM = /cuaderno|libreta|papel|a mano|agenda fisica|tablero|pizarra|whatsapp|instagram|facebook|llamad|telefono|nequi|daviplata|efectivo/;

function cleanAnswers(raw: any): SetupAnswers {
  return {
    offer: str(raw?.offer, 200),
    intake: list(raw?.intake, 9, 40),
    manualTasks: list(raw?.manualTasks, 8, 120),
    timeConsuming: list(raw?.timeConsuming, 6, 120),
    needs: NEEDS.filter((n) => Array.isArray(raw?.needs) && raw.needs.includes(n)),
    automate: list(raw?.automate, 8, 120),
    humanApproval: list(raw?.humanApproval, 6, 120),
    wantsContent: bool(raw?.wantsContent),
    wantsAds: bool(raw?.wantsAds),
    integrations: list(raw?.integrations, 10, 40).filter((x) => !NOT_A_SYSTEM.test(plain(x))),
  };
}

function cleanSignals(raw: any): OperationSignals {
  return {
    stages: int(raw?.stages, 1, 50),
    people: int(raw?.people, 1, 10000),
    areas: list(raw?.areas, 10, 40),
    dailyVolume: int(raw?.dailyVolume, 1, 100000),
  };
}

/**
 * Valida y RECALCULA un perfil (venga del navegador, de la IA o de un
 * administrador). Lo único que se respeta tal cual es lo que la persona decide:
 * respuestas, productos elegidos y, si es administrador, el ajuste de complejidad.
 */
export function normalizeSetup(
  raw: unknown,
  ctx: { source: 'SELF_SERVICE' | 'ASSISTED'; by?: string | null; allowOverride?: boolean; now?: Date; text?: string },
): SetupProfile {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const answers = cleanAnswers(o.answers);
  const signals = cleanSignals(o.signals);
  const key = o.business?.profileKey && o.business.profileKey in PROFILES ? (o.business.profileKey as ProfileKey) : detectProfile(`${answers.offer} ${ctx.text ?? ''}`, answers.offer).key;
  const computed = computeComplexity(answers, signals);
  const ov = o.complexity?.override;
  const override = ctx.allowOverride && ov && isComplexity(ov.level) && str(ov.reason, 240)
    ? { level: ov.level as Complexity, reason: str(ov.reason, 240), by: ctx.by ?? null }
    : null;
  if (ctx.allowOverride && ov && isComplexity(ov.level) && !str(ov.reason, 240)) {
    throw new SetupValidationError('complexity', 'Escribe por qué ajustas la complejidad');
  }
  const level = override?.level ?? computed.level;
  const caps = deriveCapabilities(key, answers, signals, level, ctx.text);
  const { recommended, reasons } = recommendProducts(caps);
  const selected = o.products?.selected !== undefined ? validateProducts(o.products.selected) : recommended;
  return {
    version: SETUP_VERSION,
    source: ctx.source,
    business: { profileKey: key, label: PROFILES[key].label, activity: str(o.business?.activity, 100) || PROFILES[key].label },
    answers,
    signals,
    complexity: { level, computed: computed.level, score: computed.score, reasons: computed.reasons, override },
    products: { selected, recommended, reasons },
    capabilities: caps.map(({ key: k, why }) => {
      const c = CAPABILITIES[k];
      return { key: k, label: c.label, product: c.product, status: c.status, note: c.note, included: selected.includes(c.product), why };
    }),
    agentCallId: str(o.agentCallId, 40) || null,
    updatedAt: (ctx.now ?? new Date()).toISOString(),
    updatedBy: ctx.by ?? null,
  };
}

/**
 * Perfil a partir de lo que contó el dueño: IA (si respondió) completada con
 * la lectura por código. Mismo formato en autoservicio y asistido.
 */
export function setupFromConversation(input: {
  text: string;
  firstAnswer?: string;
  dailyVolume?: number | null;
  ai?: unknown;
  activity?: string;
  source: 'SELF_SERVICE' | 'ASSISTED';
  by?: string | null;
}): SetupProfile {
  const code = readOperation(input.text, input.dailyVolume ?? null);
  const ai = operationFromAi(input.ai);
  const merged: SetupAnswers = { ...code.answers, ...ai.answers };
  // Las necesidades se suman (la IA puede omitir una que el texto deja clara)
  merged.needs = NEEDS.filter((n) => code.answers.needs.includes(n) || (ai.answers.needs ?? []).includes(n));
  merged.integrations = [...new Set([...(ai.answers.integrations ?? []), ...code.answers.integrations])].slice(0, 10);
  if (!merged.offer) merged.offer = str(input.firstAnswer ?? input.text, 200);
  const signals: OperationSignals = {
    stages: ai.signals.stages ?? code.signals.stages,
    people: ai.signals.people ?? code.signals.people,
    // Si la IA nombró las áreas, mandan las suyas (sumarlas a las del texto las duplica: «despacho» y «Despacho y entregas»)
    areas: (ai.signals.areas?.length ? ai.signals.areas : code.signals.areas).slice(0, 10),
    dailyVolume: code.signals.dailyVolume,
  };
  const profile = detectProfile(input.text, input.firstAnswer ?? '');
  return normalizeSetup(
    { business: { profileKey: profile.key, activity: input.activity }, answers: merged, signals },
    { source: input.source, by: input.by, text: input.text },
  );
}

/** El mismo perfil con otra selección de productos (sin recalcular lo demás). */
export function withSelectedProducts(setup: SetupProfile, selected: ProductKey[]): SetupProfile {
  return {
    ...setup,
    products: { ...setup.products, selected },
    capabilities: setup.capabilities.map((c) => ({ ...c, included: selected.includes(c.product) })),
  };
}

/** Perfil guardado de una empresa (null en las anteriores a este modelo o si está dañado). */
export function setupOf(company: { onboardingJson?: string | null }): SetupProfile | null {
  try {
    const ob = company?.onboardingJson ? JSON.parse(company.onboardingJson) : null;
    const s = ob?.setup;
    if (!s || typeof s !== 'object' || s.version !== SETUP_VERSION || !s.products?.selected) return null;
    return s as SetupProfile;
  } catch {
    return null;
  }
}

/** Catálogo para las pantallas (sin lógica: los cálculos son del servidor). */
export function setupCatalog() {
  return {
    profiles: Object.values(PROFILES).map((p) => ({ key: p.key, label: p.label })),
    needs: NEEDS.map((k) => ({ key: k, label: NEED_LABEL[k] })),
    intake: [...INTAKE],
    complexity: COMPLEXITY.map((k) => ({ key: k, label: COMPLEXITY_LABEL[k] })),
    products: PRODUCTS.map((k) => ({ key: k, name: PRODUCT_INFO[k].name, short: PRODUCT_INFO[k].short, summary: PRODUCT_INFO[k].summary })),
    capabilities: (Object.keys(CAPABILITIES) as CapabilityKey[]).map((k) => ({ key: k, ...CAPABILITIES[k] })),
  };
}
