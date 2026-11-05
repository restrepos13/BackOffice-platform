import { TemplateDraft } from './meta-templates';

/**
 * Plantillas listas para enviar a revisión de Meta. Las claves y el orden de
 * las variables son los que ya usan los flujos de BackOffice (reservas,
 * domicilios, cobranza, reactivación, campañas, recordatorios de pedidos):
 * aprobada una, el flujo la usa sola fuera de la ventana de 24 h.
 *
 * Los avisos (UTILIDAD) son solo informativos a propósito: si llevan algo
 * promocional, Meta los cobra como marketing.
 */
export interface LibraryTemplate extends TemplateDraft {
  label: string;
  /** Para qué la usa BackOffice */
  usedFor: string;
  /** Qué significa cada variable, en orden */
  variables: string[];
  /** Rubros a los que se le sugiere (vacío = todos) */
  sectors: string[];
  /** Se crea sola al conectar el número */
  recommended: boolean;
}

export const TEMPLATE_LIBRARY: LibraryTemplate[] = [
  {
    key: 'recordatorio_reserva',
    label: 'Recordatorio de cita o reserva',
    category: 'UTILIDAD',
    usedFor: 'Recordatorio automático de citas y reservas (por defecto, 24 h antes).',
    body: 'Hola, te recordamos tu cita: {{1}}, el {{2}}. Si no puedes asistir, respóndenos por aquí y te ayudamos a reprogramar.',
    variables: ['Qué se agendó', 'Fecha y hora'],
    examples: ['Consulta general', 'martes 12 de noviembre a las 3:00 p. m.'],
    buttons: ['Confirmo', 'Reprogramar'],
    sectors: [],
    recommended: true,
  },
  {
    key: 'pedido_en_camino',
    label: 'Pedido en camino',
    category: 'UTILIDAD',
    usedFor: 'Aviso cuando un domicilio sale, con el enlace para seguirlo.',
    body: 'Tu pedido #{{1}} ya va en camino. Puedes seguirlo en vivo aquí: {{2}}\nGracias por tu compra.',
    variables: ['Código del pedido', 'Enlace de seguimiento'],
    examples: ['A1B2C3', 'https://backoffice.store/t/abc123'],
    sectors: ['COMIDAS', 'VENTAS'],
    recommended: true,
  },
  {
    key: 'recordatorio_cliente',
    label: 'Aviso sobre un pedido',
    category: 'UTILIDAD',
    usedFor: 'Recordatorios de entrega de pedidos programados.',
    body: 'Hola, tienes un aviso sobre tu pedido: {{1}}. Si tienes alguna duda, respóndenos por aquí.',
    variables: ['Detalle del aviso'],
    examples: ['tu pedido de mañana se entrega entre 11:00 a. m. y 12:00 m.'],
    sectors: ['COMIDAS'],
    recommended: false,
  },
  {
    key: 'feedback_cliente',
    label: 'Encuesta después de la entrega',
    category: 'UTILIDAD',
    usedFor: 'Pregunta cómo le fue al cliente con su pedido.',
    body: 'Hola, ¿cómo te fue con tu pedido? {{1}} Tu respuesta nos ayuda a mejorar el servicio.',
    variables: ['Pregunta'],
    examples: ['Califícanos de 1 a 5.'],
    sectors: ['COMIDAS'],
    recommended: false,
  },
  {
    key: 'cobro_pendiente',
    label: 'Recordatorio de pago pendiente',
    category: 'UTILIDAD',
    usedFor: 'Cobranza: recordatorio de un saldo pendiente.',
    body: 'Hola {{1}}, te recordamos que tienes un saldo pendiente de {{2}} por {{3}}. Si ya pagaste, envíanos el comprobante por aquí.',
    variables: ['Nombre', 'Valor', 'Concepto'],
    examples: ['Ana', '$120.000', 'la mensualidad de noviembre'],
    sectors: [],
    recommended: false,
  },
  {
    key: 'nuevo_pedido',
    label: 'Aviso interno: pedido nuevo',
    category: 'UTILIDAD',
    usedFor: 'Aviso a tu equipo (áreas de producción) cuando entra un pedido.',
    body: 'Aviso de tu operación: {{1}}. Revisa los detalles en tu panel de BackOffice.',
    variables: ['Detalle'],
    examples: ['entró el pedido #A1B2C3 para mañana a las 9:00 a. m.'],
    sectors: ['COMIDAS'],
    recommended: false,
  },
  {
    key: 'recordatorio_area',
    label: 'Aviso interno: tarea de un área',
    category: 'UTILIDAD',
    usedFor: 'Recordatorio a un área de producción antes de una entrega.',
    body: 'Recordatorio para tu área: {{1}}. Revisa los detalles en tu panel de BackOffice.',
    variables: ['Detalle'],
    examples: ['preparar 40 almuerzos del pedido #A1B2C3 antes de las 11:00 a. m.'],
    sectors: ['COMIDAS'],
    recommended: false,
  },
  {
    key: 'recordatorio_despacho',
    label: 'Aviso interno: despacho',
    category: 'UTILIDAD',
    usedFor: 'Recordatorio al equipo de despacho.',
    body: 'Recordatorio de despacho: {{1}}. Revisa los detalles en tu panel de BackOffice.',
    variables: ['Detalle'],
    examples: ['el pedido #A1B2C3 sale a las 11:30 a. m.'],
    sectors: ['COMIDAS'],
    recommended: false,
  },
  {
    key: 'reactivacion',
    label: 'Reactivación de clientes',
    category: 'MARKETING',
    usedFor: 'Escribirle a clientes que no compran hace tiempo, con una oferta.',
    body: 'Hola {{1}}, hace rato no sabemos de ti. Esta semana tenemos {{2}} para ti. ¿Te cuento más?',
    variables: ['Nombre', 'Oferta'],
    examples: ['Ana', '10 % de descuento en tu próximo pedido'],
    sectors: [],
    recommended: false,
  },
  {
    key: 'campana_novedades',
    label: 'Campaña: novedades',
    category: 'MARKETING',
    usedFor: 'Campañas a contactos fuera de las 24 h.',
    body: 'Hola {{1}}, tenemos novedades que te pueden interesar. Respóndenos este mensaje y te contamos.',
    variables: ['Nombre'],
    examples: ['Ana'],
    sectors: [],
    recommended: false,
  },
];

export const libraryTemplate = (key: string) => TEMPLATE_LIBRARY.find((t) => t.key === key) ?? null;
