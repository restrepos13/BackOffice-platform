/**
 * Lo que vende BackOffice, en un solo lugar.
 *
 * PRODUCTO: "Automatización humanizada de WhatsApp para vender 24/7".
 *  - Planes: Básico (1 número de WhatsApp), Intermedio (2) y Max (hasta 5).
 *    Más números u otros canales → precio a medida con un asesor.
 *  - El número de WhatsApp lo pone el cliente. Meta cobra por los mensajes
 *    (lo factura a través de Twilio): eso NO es de BackOffice.
 *
 * DOS MODALIDADES por plan:
 *  - SELF "Tu IA": automatizamos todo; la IA la paga el cliente con su tarjeta
 *    (DeepInfra u OpenRouter) y los mensajes de Meta/Twilio también, directo.
 *  - MANAGED "Todo incluido" (mes vencido): gestionamos todo. Factura del mes =
 *    mensualidad (incluye US$10 de mensajes de Meta, mantenimiento 24/7,
 *    acompañamiento remoto y mantenimiento de la landing) + IA consumida
 *    (costo real + 5 %, sin desglosar) + excedente de Meta sobre los US$10.
 *    No hay topes: se paga lo que se consume.
 *
 * REGALO: en la primera suscripción, una landing básica (solo de vista, con
 * botón a WhatsApp, sin dominio) que el cliente conserva aunque se vaya.
 *
 * REFERIDOS: quien trae otra empresa que se queda mínimo 2 meses pagos recibe
 * 20 % de descuento en su mensualidad durante 2 meses.
 *
 * Los precios viven en la base (Plan) y en PlatformSetting ADDON_CATALOG; los
 * de aquí son los valores iniciales.
 */

export type ServiceMode = 'SELF' | 'MANAGED';

/** Margen sobre el costo real de la IA en "Todo incluido" (no se muestra al cliente). */
export const AI_RESALE_MARKUP = 0.05;
/** US$ de mensajes de Meta incluidos al mes en "Todo incluido". */
export const DEFAULT_INCLUDED_META_USD = 10;
/** Programa de referidos */
export const REFERRAL = { discountPercent: 20, months: 2, minPaidMonths: 2 } as const;
/** Días hábiles máximos para salir en vivo */
export const MAX_IMPLEMENTATION_DAYS = 14;

export const SERVICE_MODES: Record<ServiceMode, { name: string; short: string; summary: string; includes: string[]; youPay: string[] }> = {
  SELF: {
    name: 'Tu IA',
    short: 'Automatizamos todo; la IA y los mensajes de Meta los pagas tú directo.',
    summary: 'Nosotros automatizamos todos los procesos de tu negocio. La inteligencia artificial la pagas tú con tu tarjeta en DeepInfra u OpenRouter, y los mensajes de WhatsApp se los pagas directo a Meta (a través de Twilio).',
    includes: ['Automatización de tu negocio y asistente que atiende como persona', 'Panel con todas tus herramientas', 'Soporte en horario hábil'],
    youPay: ['La IA, con tu tarjeta (DeepInfra u OpenRouter)', 'Los mensajes de WhatsApp, a Meta vía Twilio'],
  },
  MANAGED: {
    name: 'Todo incluido',
    short: 'Nosotros gestionamos todo y pagas a mes vencido lo que consumas.',
    summary: 'Nosotros gestionamos todo: la IA, los mensajes de WhatsApp y el mantenimiento. A fin de mes pagas tu mensualidad más la IA que usaste. La mensualidad ya incluye US$10 de mensajes de Meta; si se usan más, el excedente sale en tu factura.',
    includes: [
      'Todo lo de "Tu IA"',
      'La IA la gestionamos nosotros: pagas lo que uses, a fin de mes',
      'US$10 al mes de mensajes de WhatsApp (Meta) incluidos',
      'Mantenimiento 24/7 y acompañamiento remoto',
      'Mantenimiento de tu landing',
    ],
    youPay: ['Tu mensualidad', 'La IA que usaste en el mes', 'Los mensajes de Meta que pasen de US$10'],
  },
};

export interface PlanSeed {
  code: string;
  tier: 'BASICO' | 'INTERMEDIO' | 'MAX';
  name: string;
  priceMonthly: number;
  priceManaged: number;
  maxLines: number;
  maxUsers: number;
  maxCouriers: number;
  maxBots: number;
  minTermMonths: number;
  setupFeeValue: number;
  highlight: boolean;
  sortOrder: number;
  features: string[];
}

/** Precios base (COP, IVA incluido). Editables en Plataforma → Planes. */
export const WPP_PLANS: PlanSeed[] = [
  {
    code: 'wpp-basico', tier: 'BASICO', name: 'Básico', priceMonthly: 149000, priceManaged: 279000,
    maxLines: 1, maxUsers: 2, maxCouriers: 0, maxBots: 1, minTermMonths: 6, setupFeeValue: 300000, highlight: false, sortOrder: 1,
    features: [
      '1 número de WhatsApp (lo pones tú)',
      'Asistente de IA que atiende como una persona, 24/7',
      'Las herramientas de tu tipo de negocio',
      'Hasta 2 personas de tu equipo',
    ],
  },
  {
    code: 'wpp-intermedio', tier: 'INTERMEDIO', name: 'Intermedio', priceMonthly: 349000, priceManaged: 529000,
    maxLines: 2, maxUsers: 5, maxCouriers: 5, maxBots: 2, minTermMonths: 6, setupFeeValue: 500000, highlight: true, sortOrder: 2,
    features: [
      '2 números de WhatsApp (los pones tú)',
      'Asistente de IA por cada número',
      'Domicilios, agenda, campañas y reportes',
      'Hasta 5 personas de tu equipo',
    ],
  },
  {
    code: 'wpp-max', tier: 'MAX', name: 'Max', priceMonthly: 890000, priceManaged: 1190000,
    maxLines: 5, maxUsers: 15, maxCouriers: 999, maxBots: 5, minTermMonths: 12, setupFeeValue: 900000, highlight: false, sortOrder: 3,
    features: [
      'Hasta 5 números de WhatsApp (los pones tú)',
      'Asistentes y personalidades por número',
      'Todas las herramientas: producción, domicilios sin límite, gerencia',
      'Hasta 15 personas de tu equipo',
    ],
  },
];

export type AddonKey =
  | 'reactivation' | 'collections' | 'salesAudit' | 'extraChannels' | 'social'
  | 'apparelModels' | 'aiAds' | 'voiceCalls' | 'dian' | 'transferCheck';

export interface AddonDef {
  key: AddonKey;
  name: string;
  description: string;
  /** COP/mes (por unidad si perUnit) */
  price: number;
  perUnit?: string;
  status: 'AVAILABLE' | 'SOON';
  /** Viene incluido en todos los planes (sin costo, no se compra aparte). */
  included?: boolean;
}

export const ADDONS: AddonDef[] = [
  // Incluidos en todos los planes: el centro de mando de ventas de la empresa
  {
    key: 'reactivation', name: 'Reactivación de clientes dormidos', price: 0, status: 'AVAILABLE', included: true,
    description: 'La IA le escribe con un mensaje personal a quien no te compra hace 30, 60 o 90 días para que vuelva.',
  },
  {
    key: 'collections', name: 'Cobranza humanizada', price: 0, status: 'AVAILABLE', included: true,
    description: 'Recordatorios de pago amables por WhatsApp, con el valor y cómo pagar, para que no se te acumule la cartera.',
  },
  {
    key: 'salesAudit', name: 'Auditor de ventas con IA', price: 0, status: 'AVAILABLE', included: true,
    description: 'Cada semana te dice por qué se perdieron ventas (precio, demora, falta de producto) leyendo tus conversaciones.',
  },
  {
    key: 'extraChannels', name: 'Canal extra', price: 59000, perUnit: 'canal', status: 'AVAILABLE',
    description: 'Atiende también por Instagram, Messenger, el chat de tu página web o Telegram. Precio por cada canal.',
  },
  {
    key: 'social', name: 'Redes sociales con IA', price: 150000, status: 'AVAILABLE',
    description: 'Piezas e imágenes para tus redes hechas con IA y publicadas en Facebook e Instagram en los días que elijas.',
  },
  {
    key: 'apparelModels', name: 'Modelos de IA para marcas de ropa', price: 0, status: 'SOON',
    description: 'Fotos de tus prendas puestas en modelos creados con IA, listas para catálogo y redes.',
  },
  {
    key: 'aiAds', name: 'Anuncios con IA', price: 0, status: 'SOON',
    description: 'Crea y publica anuncios en Meta pensados para tu negocio, con imágenes de banco y textos hechos por IA.',
  },
  {
    key: 'voiceCalls', name: 'Llamadas con IA', price: 0, status: 'SOON',
    description: 'Una IA que contesta llamadas, resuelve dudas y agenda como lo haría tu equipo.',
  },
  {
    key: 'dian', name: 'Facturación electrónica DIAN', price: 0, status: 'SOON',
    description: 'Factura electrónica de tus ventas sin salir del panel.',
  },
  {
    key: 'transferCheck', name: 'Verificación real de transferencias', price: 0, status: 'SOON',
    description: 'Confirma contra tu banco que la transferencia del cliente sí llegó, no solo que mandó un comprobante.',
  },
];

/** Aviso que siempre acompaña la oferta: la IA no es 100 % precisa. */
export const HUMAN_OVERSIGHT_NOTICE =
  'Aunque todo quede automatizado, es indispensable que una persona de tu equipo esté pendiente de la plataforma: ningún modelo de IA es 100 % preciso.';

export const NUMBERS_NOTICE =
  'El número de WhatsApp lo pones tú. Básico: 1 número · Intermedio: 2 · Max: hasta 5. Si necesitas más números u otros canales, el precio cambia: habla con un asesor.';

export const META_NOTICE =
  'Meta cobra por los mensajes de WhatsApp (se factura a través de Twilio). Ese cobro no es de BackOffice: en "Tu IA" lo pagas directo y en "Todo incluido" te damos US$10 al mes y el excedente sale en tu factura.';

export const LANDING_NOTICE =
  'Con tu primera suscripción te regalamos una landing básica (solo de vista, con botón a tu WhatsApp) sin dominio. Es tuya aunque dejes de estar con nosotros; el dominio lo pagas tú si lo quieres.';

export function serviceModeOf(company: { serviceMode?: string | null }): ServiceMode {
  return company?.serviceMode === 'MANAGED' ? 'MANAGED' : 'SELF';
}

/** Precio del plan según la modalidad. */
export function planPriceFor(plan: { priceMonthly: number; priceManaged?: number | null } | null | undefined, mode: ServiceMode): number {
  if (!plan) return 0;
  return mode === 'MANAGED' && (plan.priceManaged ?? 0) > 0 ? plan.priceManaged! : plan.priceMonthly;
}

/** Herramientas que vienen en todos los planes (antes eran complementos). */
export const INCLUDED_ADDONS = ADDONS.filter((a) => a.included).map((a) => a.key);
