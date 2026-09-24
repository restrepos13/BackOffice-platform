/**
 * Plantillas de aprovisionamiento: todo lo que se configuró a mano para la
 * primera empresa de cada vertical queda aquí como DATOS. Crear la siguiente
 * empresa igual = elegir la plantilla en el wizard, cero código.
 *
 * Además el wizard permite CLONAR la configuración de una empresa existente
 * (companies.module → cloneConfigInto), que cubre cualquier caso no previsto.
 */

export interface CompanyTemplate {
  id: string;
  name: string;
  description: string;
  /** Lo que el wizard muestra que incluye */
  includes: string[];
  modules: string[];
  currency: string;
  orderConfig?: Record<string, any>;
  bot?: {
    name: string;
    description: string;
    systemPrompt: string;
    personality: Record<string, string>;
    sales: Record<string, string>;
    welcomeMessage?: string;
    replyDelayMinSec?: number;
    replyDelayMaxSec?: number;
    handoffKeywords?: string;
  };
  areas?: Array<{
    name: string;
    description?: string;
    notifyChannel: 'PANEL' | 'EMAIL' | 'WHATSAPP';
    reminderHoursBefore: number;
  }>;
  channels: string[];
}

export const COMPANY_TEMPLATES: CompanyTemplate[] = [
  {
    id: 'catering',
    name: 'Catering / pedidos programados',
    description:
      'El paquete completo del vertical de catering (como Nexus): pedidos por WhatsApp con IA, distribución a áreas, agenda con cortes y franjas, recordatorios, reportes y feedback post-entrega.',
    includes: [
      'Módulo de pedidos completo (estados, trazabilidad, calendario)',
      'Agenda con horarios, corte, anticipación y franjas de ejemplo',
      '4 áreas de producción base (Cocina, Empaque, Logística, Despacho)',
      'Asistente IA con personalidad de toma de pedidos (borrador, se activa al conectar la llave)',
      'Línea de WhatsApp en sandbox (jamás envía mensajes reales hasta activarla)',
      'Reporte diario, comparativos, consulta y encuesta de feedback',
    ],
    modules: ['inbox', 'contacts', 'orders', 'bots', 'automations', 'analytics', 'billing', 'team'],
    currency: 'COP',
    orderConfig: {
      statuses: [
        'borrador', 'confirmado', 'programado', 'en_produccion', 'listo',
        'empacado', 'despachado', 'entregado', 'cancelado', 'requiere_atencion',
      ],
      schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' },
      orderCutoff: '14:00',
      minLeadHours: 18,
      maxPerSlot: 8,
      slots: [
        { key: 'manana', label: 'Mañana', from: '06:00', to: '12:00' },
        { key: 'tarde', label: 'Tarde', from: '12:00', to: '16:00' },
      ],
      holidays: [],
      reminderDefaults: { areaHours: 24, dispatchHours: 3, clientSameDayHour: 7 },
      feedbackDelayHours: 3,
      aiConfidenceThreshold: 0.8,
    },
    bot: {
      name: 'Asistente de pedidos',
      description: 'Toma pedidos por WhatsApp sin sonar a bot.',
      systemPrompt:
        'Atiendes el WhatsApp de un negocio de comida al por mayor con entregas ' +
        'programadas. Conversas natural, tomas el pedido completo (productos, ' +
        'cantidades, fecha/hora, dirección, observaciones) pidiendo solo lo que ' +
        'falte, de a uno o dos datos. A clientes recurrentes no les preguntas lo ' +
        'que ya sabemos. Antes de cerrar envías el resumen completo y esperas un ' +
        'sí explícito. Si no estás seguro, NO inventas: confirmas o escalas. ' +
        'Respetas horarios, cortes y anticipación mínima; si algo no cabe, ' +
        'propones alternativas. Jamás dices que eres una IA ni usas menús.',
      personality: {
        tone: 'Español colombiano, informal pero profesional; tuteo',
        style: 'Mensajes cortos, a veces en varios envíos; sin menús ni botones',
        limits: 'No inventar; sin confirmación explícita el pedido queda en borrador; duda → escalar',
        language: 'es-CO',
      },
      sales: {
        goal: 'Cerrar el pedido completo y agendado; sugerir complementos solo si encajan.',
        style: 'Consultivo: primero resolver, después sugerir. Nunca presionar.',
        objections: 'Fuera de horario o sin anticipación: proponer la franja válida más cercana.',
      },
      welcomeMessage: '¡Hola! ¿En qué te ayudo hoy?',
      replyDelayMinSec: 6,
      replyDelayMaxSec: 40,
      handoffKeywords: 'queja, reclamo, factura, gerente, hablar con alguien',
    },
    areas: [
      { name: 'Cocina', description: 'Producción de alimentos', notifyChannel: 'PANEL', reminderHoursBefore: 24 },
      { name: 'Empaque', description: 'Porcionado y empaque', notifyChannel: 'PANEL', reminderHoursBefore: 12 },
      { name: 'Logística', description: 'Insumos y montaje', notifyChannel: 'PANEL', reminderHoursBefore: 12 },
      { name: 'Despacho', description: 'Entregas y rutas', notifyChannel: 'PANEL', reminderHoursBefore: 3 },
    ],
    channels: ['WHATSAPP'],
  },
  {
    id: 'webcam',
    name: 'Estudio webcam / creadores',
    description:
      'Ventas por chat con IA estilo chatter: varias líneas de WhatsApp (una por modelo/perfil), galería de contenido con precio, habilidades de venta y tiempos humanizados.',
    includes: [
      'Asistente IA con modo chatter (ventas, upsell, manejo de objeciones)',
      'Galería de fotos con precio PPV para enviar en el chat',
      'Líneas de WhatsApp múltiples (una por modelo), cada una con personalidad propia',
      'CRM de contactos con etapas y analytics por línea',
    ],
    modules: ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team'],
    currency: 'USD',
    bot: {
      name: 'Chatter IA',
      description: 'Vende contenido y agenda shows conversando como una persona.',
      systemPrompt:
        'Eres quien chatea con los fans de una modelo. Conversas coqueto pero ' +
        'elegante, generas conexión y vendes contenido y shows. Nunca suenas a ' +
        'robot ni presionas: seduces con la conversación. Jamás compartes datos ' +
        'personales reales ni prometes encuentros presenciales.',
      personality: {
        tone: 'Cercano, coqueto, juguetón; español o inglés según el cliente',
        style: 'Mensajes cortos y naturales, emojis con medida',
        limits: 'Sin datos personales reales; sin encuentros; precios solo del catálogo',
      },
      sales: {
        goal: 'Vender contenido PPV y shows privados; construir recurrencia.',
        style: 'Seducción conversacional; el fan siente atención genuina.',
        upsell: 'Después de una compra, ofrecer el siguiente nivel una sola vez.',
        objections: 'Si duda por precio, ofrecer una pieza de menor valor, nunca descuentos.',
      },
      replyDelayMinSec: 10,
      replyDelayMaxSec: 90,
    },
    channels: ['WHATSAPP'],
  },
  {
    id: 'servicios',
    name: 'Servicios con citas (clínicas, salones, talleres)',
    description:
      'Atención por WhatsApp con IA que responde preguntas frecuentes, califica al cliente y agenda citas con seguimientos.',
    includes: [
      'Asistente IA que agenda citas y responde FAQs',
      'Agenda de citas + seguimientos desde la bandeja',
      'CRM con etapas y reporte a gerencia',
    ],
    modules: ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team'],
    currency: 'COP',
    bot: {
      name: 'Recepcionista IA',
      description: 'Atiende, resuelve dudas y agenda citas.',
      systemPrompt:
        'Atiendes el WhatsApp de un negocio de servicios. Respondes dudas con la ' +
        'información oficial, calificas la necesidad del cliente y agendas citas ' +
        'proponiendo horarios disponibles. Confirmas fecha, hora y servicio antes ' +
        'de cerrar. Si el caso es delicado o el cliente lo pide, pasas con una persona.',
      personality: {
        tone: 'Amable y profesional; tuteo suave',
        style: 'Respuestas claras y cortas',
        limits: 'No dar diagnósticos ni precios fuera de la lista oficial',
      },
      sales: {
        goal: 'Convertir consultas en citas confirmadas.',
        style: 'Servicial, sin presionar.',
      },
      replyDelayMinSec: 4,
      replyDelayMaxSec: 25,
    },
    channels: ['WHATSAPP'],
  },
];

export function findTemplate(id?: string | null): CompanyTemplate | null {
  if (!id) return null;
  return COMPANY_TEMPLATES.find((t) => t.id === id) ?? null;
}
