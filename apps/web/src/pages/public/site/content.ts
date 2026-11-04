import type { SeoMeta } from './seo';

/**
 * Contenido de las páginas públicas de soluciones, sectores y guías.
 *
 * Reglas del texto (se revisan antes de publicar):
 *  - Solo funciones que existen en la plataforma; lo que depende de una
 *    aprobación externa (Meta, Google, TikTok) se dice como tal.
 *  - Nada de cifras inventadas, clientes ficticios ni resultados prometidos.
 *    Los ahorros se calculan con los números del propio visitante.
 *  - Cada página responde preguntas concretas en lenguaje simple: así la
 *    entienden Google y los asistentes (ChatGPT, Gemini) al recomendar.
 */

export interface Item {
  title: string;
  text: string;
}

export type Block =
  | { kind: 'cards'; kicker?: string; title: string; accent?: string; intro?: string; items: Item[] }
  | { kind: 'steps'; kicker?: string; title: string; accent?: string; intro?: string; items: Item[] }
  | { kind: 'compare'; kicker?: string; title: string; accent?: string; intro?: string; rows: Array<{ before: string; after: string }> }
  | { kind: 'text'; kicker?: string; title: string; accent?: string; paragraphs: string[]; list?: string[]; note?: string };

export interface Faq {
  q: string;
  a: string;
}

export interface SitePage extends SeoMeta {
  kind: 'solucion' | 'sector' | 'guia' | 'herramienta';
  /** Nombre corto para menús y migas de pan */
  nav: string;
  kicker: string;
  h1: string;
  accent: string;
  intro: string;
  blocks: Block[];
  faq: Faq[];
  related: string[];
  /** Muestra la calculadora de ahorro en la página */
  calculator?: boolean;
  /** Guías: fecha de publicación (AAAA-MM-DD) */
  published?: string;
}

const HUMANO: Faq = {
  q: '¿La IA responde sola o alguien la supervisa?',
  a: 'Responde sola lo que el negocio le enseñó (precios, horarios, servicios, preguntas frecuentes) y pasa la conversación a una persona del equipo cuando el cliente lo pide, cuando la pregunta se sale de lo que sabe o cuando hay una decisión que debe tomar alguien. Todo queda en la bandeja de entrada, donde el equipo puede leer y tomar el control en cualquier momento.',
};

const CONEXION: Faq = {
  q: '¿Cómo se conecta mi número de WhatsApp?',
  a: 'Por la plataforma oficial de WhatsApp Business de Meta, no con aplicaciones no autorizadas que ponen en riesgo el número. Te acompañamos en la conexión. Meta cobra algunos mensajes según su tarifa vigente; en los planes se explica qué está incluido y qué se paga aparte.',
};

const PRECIO: Faq = {
  q: '¿Cuánto cuesta?',
  a: 'Hay planes mensuales en pesos colombianos según cuántos números de WhatsApp necesitas, con o sin acompañamiento del equipo. Empiezas sin tarjeta: describes tu negocio, revisas tu cuenta armada y eliges el plan cuando todo funciona. Los precios vigentes están en la sección de planes de la página principal.',
};

export const PAGES: SitePage[] = [
  /* ───────────── Soluciones ───────────── */
  {
    kind: 'solucion',
    path: '/automatizacion-de-whatsapp',
    nav: 'Automatización de WhatsApp',
    title: 'Automatización de WhatsApp con IA para negocios | BackOffice',
    description: 'Asistente de IA para WhatsApp que responde 24/7, toma pedidos, agenda citas y pasa a una persona cuando hace falta. Para negocios en Colombia.',
    kicker: 'Automatización de WhatsApp · IA supervisada',
    h1: 'Automatiza tu WhatsApp',
    accent: 'sin perder el trato humano.',
    intro: 'BackOffice conecta el WhatsApp de tu negocio con un asistente de IA que responde al instante lo que se pregunta todos los días, registra cada cliente y cada venta, y le pasa la conversación a tu equipo cuando hace falta una persona.',
    blocks: [
      {
        kind: 'compare',
        kicker: 'Antes y después',
        title: 'Lo que cambia',
        accent: 'en tu día',
        rows: [
          { before: 'Respondes las mismas preguntas (precio, horario, ubicación) decenas de veces al día.', after: 'El asistente responde al instante con la información que tú le diste, también de noche y los domingos.' },
          { before: 'Los mensajes que llegan fuera de horario se enfrían hasta el día siguiente.', after: 'Cada mensaje recibe respuesta y queda registrado para que tu equipo lo retome.' },
          { before: 'Los datos del cliente quedan perdidos en el chat del celular de alguien.', after: 'Cada contacto queda en el CRM con su historial, su etapa y lo que compró.' },
          { before: 'Nadie sabe cuántas conversaciones terminaron en venta.', after: 'Reportes de conversaciones, ventas y seguimientos pendientes para el dueño.' },
        ],
      },
      {
        kind: 'cards',
        kicker: 'Qué hace',
        title: 'Un asistente que',
        accent: 'trabaja con tus reglas',
        items: [
          { title: 'Responde preguntas frecuentes', text: 'Precios, horarios, medios de pago, zonas de entrega y políticas, con el tono de tu marca.' },
          { title: 'Toma pedidos y agenda citas', text: 'Arma el pedido con tu catálogo o reserva en tu agenda sin cruzar horarios.' },
          { title: 'Califica a cada cliente', text: 'Identifica qué busca, en qué etapa está y quién debe atenderlo.' },
          { title: 'Pasa a una persona', text: 'Cuando el cliente lo pide o la pregunta se sale de lo que sabe, avisa a tu equipo y deja el contexto listo.' },
          { title: 'Hace seguimiento', text: 'Recordatorios, cobros pendientes y mensajes para clientes que dejaron de comprar.' },
          { title: 'No inventa', text: 'Solo dice lo que el negocio configuró. Si no sabe algo, lo dice y lo pasa a una persona.' },
        ],
      },
      {
        kind: 'steps',
        kicker: 'Cómo empezar',
        title: 'De tu descripción',
        accent: 'a tu WhatsApp atendiendo',
        items: [
          { title: 'Describe tu negocio', text: 'Cuéntalo como a un empleado nuevo: qué vendes, precios, horarios y cómo atiendes.' },
          { title: 'Revisa lo que armó la IA', text: 'Catálogo, preguntas frecuentes, horario y herramientas de tu sector, listos para corregir.' },
          { title: 'Conecta tu número', text: 'Por la plataforma oficial de WhatsApp Business. Te acompañamos.' },
          { title: 'Mide y ajusta', text: 'Lee las conversaciones, corrige respuestas y mira qué se convierte en venta.' },
        ],
      },
    ],
    faq: [
      HUMANO,
      CONEXION,
      { q: '¿Puedo seguir usando WhatsApp desde el celular?', a: 'Las conversaciones del número conectado se atienden desde la bandeja de entrada de BackOffice, en el computador o en el navegador del celular, y varias personas del equipo pueden atender el mismo número con sus propios usuarios.' },
      { q: '¿Qué pasa si la IA no sabe una respuesta?', a: 'No la inventa: le dice al cliente que una persona lo va a atender y deja la conversación marcada para tu equipo.' },
      PRECIO,
    ],
    related: ['/automatizacion-de-procesos', '/crm-con-whatsapp', '/guias/como-automatizar-whatsapp-de-tu-negocio'],
  },
  {
    kind: 'solucion',
    path: '/automatizacion-de-procesos',
    nav: 'Automatización de procesos',
    title: 'Automatización de procesos para pymes | BackOffice',
    description: 'Automatiza pedidos, domicilios, citas, cobranza, reactivación de clientes y reportes desde WhatsApp. Menos tareas manuales, menos errores y más control.',
    kicker: 'Mejora de procesos · Pymes en Colombia',
    h1: 'Automatiza los procesos',
    accent: 'que hoy se comen tu tiempo.',
    intro: 'La mayoría de los negocios pierde horas en tareas que se repiten: copiar pedidos del chat a un cuaderno, confirmar citas una por una, recordar quién debe, avisar al domiciliario. BackOffice convierte esas tareas en procesos que se ejecutan solos y que tu equipo puede ver.',
    blocks: [
      {
        kind: 'cards',
        kicker: 'Procesos que automatiza',
        title: 'Del chat',
        accent: 'a la operación',
        items: [
          { title: 'Pedidos', text: 'El pedido sale del chat con productos, dirección y pago, y entra a la cola del negocio sin copiarlo a mano.' },
          { title: 'Producción y áreas', text: 'Cada área (por ejemplo cocina o empaque) ve solo lo que le toca y marca cuando termina.' },
          { title: 'Domicilios', text: 'Asignación al domiciliario, ruta en el mapa y link de seguimiento en vivo para el cliente.' },
          { title: 'Citas y reservas', text: 'Agenda sin dobles reservas, confirmaciones y recordatorios.' },
          { title: 'Cobranza', text: 'Lista de saldos pendientes y recordatorios de pago por WhatsApp, con el tono que tú defines.' },
          { title: 'Reactivación', text: 'Detecta clientes que dejaron de comprar y les escribe con una razón para volver.' },
          { title: 'Seguimiento comercial', text: 'Embudo con etapas y tareas: ningún interesado se queda sin respuesta.' },
          { title: 'Reportes', text: 'Ventas, conversaciones, tiempos y pendientes en un resumen para el dueño o gerente.' },
        ],
      },
      {
        kind: 'text',
        kicker: 'Por qué importa',
        title: 'Automatizar',
        accent: 'es ordenar primero',
        paragraphs: [
          'Automatizar un proceso desordenado solo lo hace fallar más rápido. Por eso BackOffice parte de cómo funciona tu negocio: qué pasa cuando llega un pedido, quién lo prepara, quién lo entrega, cuándo se cobra. Con eso arma el flujo y lo deja visible para todo el equipo.',
          'El resultado es menos trabajo repetitivo, menos errores al pasar datos de un lugar a otro y un registro de cada paso, para saber dónde se pierde el tiempo y el dinero.',
        ],
        list: [
          'Menos tareas manuales: lo repetitivo lo hace el sistema.',
          'Menos errores: el dato se escribe una vez, en el chat, y viaja solo.',
          'Más control: cada pedido, cita y cobro tiene un estado y un responsable.',
          'Mejores decisiones: reportes con lo que de verdad pasó en la semana.',
        ],
      },
      {
        kind: 'steps',
        kicker: 'Cómo lo hacemos',
        title: 'Tres pasos',
        accent: 'sin consultorías eternas',
        items: [
          { title: 'Describe el proceso', text: 'Qué pasa desde que el cliente escribe hasta que paga y recibe.' },
          { title: 'Activamos las herramientas de tu sector', text: 'Solo lo que tu negocio usa; el resto no estorba.' },
          { title: 'Ajustamos con datos', text: 'Los reportes muestran dónde se traba el proceso y qué conviene mejorar.' },
        ],
      },
    ],
    faq: [
      { q: '¿Qué procesos se pueden automatizar con BackOffice?', a: 'Atención por WhatsApp, toma de pedidos, producción por áreas, domicilios con seguimiento, citas y reservas, cobranza, reactivación de clientes, seguimiento comercial y reportes. Cada empresa activa solo lo que usa.' },
      { q: '¿Necesito saber de tecnología?', a: 'No. Describes tu negocio con tus palabras y la plataforma arma una primera versión que revisas y corriges. Si eliges un plan con acompañamiento, el equipo de BackOffice hace la configuración contigo.' },
      { q: '¿Cuánto tiempo toma empezar?', a: 'La cuenta se arma el mismo día con la descripción del negocio. Conectar el número oficial de WhatsApp depende de la verificación de Meta; te acompañamos en ese paso.' },
      HUMANO,
      PRECIO,
    ],
    related: ['/automatizacion-de-whatsapp', '/calculadora-de-ahorro', '/guias/cuanto-cuesta-atender-whatsapp-a-mano'],
  },
  {
    kind: 'solucion',
    path: '/crm-con-whatsapp',
    nav: 'CRM con WhatsApp',
    title: 'CRM con WhatsApp e IA para vender por chat | BackOffice',
    description: 'CRM conectado a WhatsApp: cada conversación se vuelve un contacto con historial, embudo, pedidos y cobros. Para equipos que venden por chat.',
    kicker: 'CRM · Ventas por WhatsApp',
    h1: 'Un CRM que vive',
    accent: 'donde están tus clientes.',
    intro: 'Tus clientes ya te escriben por WhatsApp. BackOffice convierte cada conversación en un contacto con historial, etapa y próximos pasos, para que el equipo venda en orden y el dueño vea qué está pasando sin pedir capturas de pantalla.',
    blocks: [
      {
        kind: 'cards',
        kicker: 'Qué incluye',
        title: 'Todo el cliente',
        accent: 'en un solo lugar',
        items: [
          { title: 'Bandeja compartida', text: 'Varias personas atienden el mismo número, cada una con su usuario, notas internas y asignación por conversación.' },
          { title: 'Contactos con historial', text: 'Conversaciones, pedidos, citas y pagos de cada cliente, juntos.' },
          { title: 'Embudo comercial', text: 'Etapas claras y seguimientos para que ningún interesado se pierda.' },
          { title: 'Campañas por WhatsApp', text: 'Mensajes a grupos de clientes con plantillas aprobadas por Meta.' },
          { title: 'Auditor de ventas', text: 'Complemento que cada semana explica por qué se perdieron ventas y qué hacer.' },
          { title: 'Datos exportables', text: 'La información es de tu empresa y la descargas cuando quieras.' },
        ],
      },
      {
        kind: 'compare',
        kicker: 'Hoja de cálculo vs CRM',
        title: 'Por qué no',
        accent: 'basta un Excel',
        rows: [
          { before: 'Alguien copia a mano los datos del chat, cuando se acuerda.', after: 'El contacto se crea solo al escribir y se actualiza con cada conversación.' },
          { before: 'No se sabe quién atendió a quién ni qué se le prometió.', after: 'Cada conversación tiene responsable, notas y estado.' },
          { before: 'Los seguimientos dependen de la memoria del vendedor.', after: 'El embudo muestra qué está pendiente y desde cuándo.' },
        ],
      },
    ],
    faq: [
      { q: '¿Qué diferencia hay entre BackOffice y WhatsApp Business?', a: 'WhatsApp Business es la aplicación para chatear desde un teléfono. BackOffice se conecta a la plataforma oficial de WhatsApp Business y le agrega lo que la app no tiene: asistente de IA, varios usuarios por número, contactos con historial, embudo, pedidos, cobranza, automatizaciones y reportes.' },
      { q: '¿Cada empresa tiene su propio espacio?', a: 'Sí. BackOffice es multiempresa: los datos de cada negocio están separados y cada usuario ve solo lo que su rol le permite.' },
      { q: '¿Puedo usarlo con Instagram y Messenger?', a: 'Los mensajes de Instagram y Messenger están construidos y en pruebas, a la espera de la autorización de Meta para usarlos con cuentas reales.' },
      CONEXION,
      PRECIO,
    ],
    related: ['/automatizacion-de-whatsapp', '/sectores/tiendas-y-ventas', '/sectores/inmobiliarias-y-proyectos'],
  },

  /* ───────────── Sectores ───────────── */
  {
    kind: 'sector',
    path: '/sectores/restaurantes-y-domicilios',
    nav: 'Restaurantes y domicilios',
    title: 'Pedidos por WhatsApp para restaurantes | BackOffice',
    description: 'Pedidos por WhatsApp sin copiarlos a mano: menú en línea, pedido directo a cocina, domiciliarios con ruta y seguimiento en vivo para el cliente.',
    kicker: 'Restaurantes · Comidas rápidas · Domicilios',
    h1: 'Pedidos por WhatsApp',
    accent: 'que llegan solos a la cocina.',
    intro: 'En la hora pico nadie tiene tiempo de contestar “¿qué hay hoy?” veinte veces. BackOffice responde, arma el pedido con tu menú, lo manda a la cocina y le da al cliente un link para seguir su domicilio.',
    blocks: [
      {
        kind: 'steps',
        kicker: 'El recorrido del pedido',
        title: 'Del mensaje',
        accent: 'a la puerta del cliente',
        items: [
          { title: 'El cliente escribe', text: 'El asistente muestra el menú, resuelve dudas y arma el pedido con dirección y forma de pago.' },
          { title: 'Entra a la cola', text: 'El pedido aparece en el panel y en la vista de cada área, sin copiarlo a mano.' },
          { title: 'Sale el domicilio', text: 'Asignas el domiciliario; él usa su propia app con la ruta.' },
          { title: 'El cliente lo sigue', text: 'Recibe un link para ver su pedido en camino en el mapa.' },
        ],
      },
      {
        kind: 'cards',
        kicker: 'Incluye',
        title: 'Hecho para',
        accent: 'la hora pico',
        items: [
          { title: 'Menú en línea', text: 'Un link con tus productos y precios para compartir en redes y en WhatsApp.' },
          { title: 'Vista por áreas', text: 'Cocina, bar o empaque ven solo lo suyo y marcan cuando terminan.' },
          { title: 'Domiciliarios', text: 'App para el domiciliario y mapa en vivo para el negocio.' },
          { title: 'Reportes de ventas', text: 'Qué se vende, a qué hora y por qué canal.' },
          { title: 'Clientes que vuelven', text: 'Mensajes para quienes dejaron de pedir.' },
          { title: 'Cobro', text: 'Medios de pago claros en el chat y registro de lo pagado.' },
        ],
      },
    ],
    faq: [
      { q: '¿El asistente puede tomar pedidos completos?', a: 'Sí. Usa tu menú configurado para armar el pedido con productos, cantidades, dirección y forma de pago, y lo deja en el panel para que el negocio lo confirme y lo prepare.' },
      { q: '¿El cliente puede ver dónde va su domicilio?', a: 'Sí. Recibe un link de seguimiento que muestra el estado del pedido y la ubicación del domiciliario en el mapa, sin ver datos de otros clientes.' },
      HUMANO,
      CONEXION,
    ],
    related: ['/automatizacion-de-procesos', '/automatizacion-de-whatsapp', '/calculadora-de-ahorro'],
  },
  {
    kind: 'sector',
    path: '/sectores/servicios-con-citas',
    nav: 'Servicios con citas',
    title: 'Agenda de citas por WhatsApp con IA | BackOffice',
    description: 'Agenda citas por WhatsApp sin cruces: el asistente ofrece espacios libres, reserva y envía recordatorios. Para consultorios, salones y talleres.',
    kicker: 'Consultorios · Estética · Salones · Talleres',
    h1: 'Citas por WhatsApp',
    accent: 'sin llamadas ni cruces de horario.',
    intro: 'Responder “¿tienes espacio el jueves?” y confirmar una por una consume horas de recepción. BackOffice ofrece los espacios libres, reserva sin dobles citas, envía recordatorios y deja todo en tu agenda.',
    blocks: [
      {
        kind: 'compare',
        kicker: 'Antes y después',
        title: 'La recepción',
        accent: 'sin el teléfono pegado',
        rows: [
          { before: 'Confirmar disponibilidad mirando una agenda de papel mientras el cliente espera.', after: 'El asistente ofrece solo los espacios realmente libres y reserva en el momento.' },
          { before: 'Dos personas reservan el mismo horario.', after: 'Cada espacio se bloquea al reservarse: no hay dobles citas.' },
          { before: 'Pacientes o clientes que olvidan la cita.', after: 'Recordatorios por WhatsApp antes de la cita.' },
        ],
      },
      {
        kind: 'cards',
        kicker: 'Incluye',
        title: 'Tu agenda,',
        accent: 'en orden',
        items: [
          { title: 'Agenda por servicio y persona', text: 'Duración, horarios y responsable de cada servicio.' },
          { title: 'Reservas y reprogramación', text: 'El cliente reserva o cambia su cita por chat.' },
          { title: 'Preguntas frecuentes', text: 'Precios, preparación, ubicación y medios de pago.' },
          { title: 'Cobro de saldos', text: 'Recordatorios de pago para servicios pendientes.' },
          { title: 'Google Calendar', text: 'Sincronización construida y en pruebas con la autorización de Google.' },
          { title: 'Paso a una persona', text: 'Casos delicados o preguntas clínicas pasan a tu equipo.' },
        ],
      },
    ],
    faq: [
      { q: '¿El asistente da recomendaciones médicas?', a: 'No. Agenda, responde preguntas administrativas (precios, horarios, preparación que el negocio haya escrito) y pasa a una persona del equipo cualquier consulta clínica o delicada.' },
      { q: '¿Se pueden evitar las dobles reservas?', a: 'Sí. Cada espacio se bloquea en el momento de reservar, así dos clientes no pueden tomar el mismo horario.' },
      HUMANO,
      CONEXION,
    ],
    related: ['/automatizacion-de-whatsapp', '/automatizacion-de-procesos', '/calculadora-de-ahorro'],
  },
  {
    kind: 'sector',
    path: '/sectores/tiendas-y-ventas',
    nav: 'Tiendas y ventas',
    title: 'Ventas por WhatsApp para tiendas | BackOffice',
    description: 'Vende por WhatsApp con orden: catálogo, respuestas inmediatas, clientes calificados, seguimiento, campañas y cobranza. Para tiendas físicas y en línea.',
    kicker: 'Tiendas · Comercio · Ventas por chat',
    h1: 'Vende por WhatsApp',
    accent: 'con el orden de una tienda grande.',
    intro: 'Muchas ventas se pierden por responder tarde o por no volver a escribir. BackOffice contesta al instante con tu catálogo, identifica a quién vale la pena llamar y recuerda cada seguimiento.',
    blocks: [
      {
        kind: 'cards',
        kicker: 'Incluye',
        title: 'Más ventas',
        accent: 'con el mismo equipo',
        items: [
          { title: 'Catálogo en el chat', text: 'Productos, precios y disponibilidad que el asistente usa para responder.' },
          { title: 'Clientes calificados', text: 'Quién está listo para comprar y quién solo está mirando.' },
          { title: 'Seguimiento', text: 'Recordatorios para retomar conversaciones que quedaron abiertas.' },
          { title: 'Campañas', text: 'Novedades y promociones para grupos de clientes, con plantillas aprobadas.' },
          { title: 'Cobranza', text: 'Pagos pendientes con recordatorio amable.' },
          { title: 'Contenido con tu marca', text: 'Diseños editables para redes y anuncios con Creative.' },
        ],
      },
      {
        kind: 'steps',
        kicker: 'Cómo vende',
        title: 'El camino',
        accent: 'de una venta',
        items: [
          { title: 'Pregunta', text: 'El cliente pregunta por un producto y recibe respuesta inmediata.' },
          { title: 'Califica', text: 'El asistente entiende qué busca y lo registra en el embudo.' },
          { title: 'Cierra', text: 'Arma el pedido o pasa a un vendedor con el contexto completo.' },
          { title: 'Vuelve', text: 'Tiempo después, una campaña o un mensaje de reactivación lo trae de nuevo.' },
        ],
      },
    ],
    faq: [
      { q: '¿Sirve para una tienda pequeña?', a: 'Sí. El plan de entrada es para un número de WhatsApp y se activan solo las herramientas que la tienda usa.' },
      { q: '¿Puedo enviar promociones a mis clientes?', a: 'Sí, con campañas por WhatsApp usando plantillas aprobadas por Meta y respetando a quienes no quieren recibir mensajes.' },
      HUMANO,
      PRECIO,
    ],
    related: ['/crm-con-whatsapp', '/automatizacion-de-whatsapp', '/calculadora-de-ahorro'],
  },
  {
    kind: 'sector',
    path: '/sectores/inmobiliarias-y-proyectos',
    nav: 'Inmobiliarias y proyectos',
    title: 'Leads por WhatsApp para inmobiliarias y lotes | BackOffice',
    description: 'Atiende al instante los leads de tu pauta por WhatsApp, califícalos, agenda visitas y haz seguimiento hasta la venta. Para inmobiliarias y lotes.',
    kicker: 'Inmobiliarias · Lotes · Proyectos · Asesorías',
    h1: 'Cada lead de tu pauta,',
    accent: 'atendido en segundos.',
    intro: 'Pagas por cada persona que escribe desde un anuncio, y muchas se enfrían esperando respuesta. BackOffice responde al instante, pregunta lo necesario para calificar, agenda la visita y deja al asesor con el contexto completo.',
    blocks: [
      {
        kind: 'steps',
        kicker: 'Del anuncio a la visita',
        title: 'Un proceso comercial',
        accent: 'que no se cae',
        items: [
          { title: 'Respuesta inmediata', text: 'El interesado recibe información del proyecto apenas escribe, de día o de noche.' },
          { title: 'Calificación', text: 'Presupuesto, zona, forma de pago y plazo, sin interrogatorios.' },
          { title: 'Visita agendada', text: 'El asistente ofrece horarios y deja la visita en la agenda del asesor.' },
          { title: 'Seguimiento', text: 'El embudo muestra quién visitó, quién separó y quién necesita otro contacto.' },
        ],
      },
      {
        kind: 'cards',
        kicker: 'Incluye',
        title: 'Menos leads',
        accent: 'perdidos',
        items: [
          { title: 'Sin precios inventados', text: 'El asistente solo da la información que el proyecto configuró; lo demás lo responde un asesor.' },
          { title: 'Asignación a asesores', text: 'Cada conversación tiene responsable y notas internas.' },
          { title: 'Embudo por etapas', text: 'Interesado, visita, separación, venta: con fechas y pendientes.' },
          { title: 'Resultados de la pauta', text: 'Conexión con Meta Ads construida y en pruebas para ver campañas junto a las conversaciones.' },
        ],
      },
    ],
    faq: [
      { q: '¿El asistente puede negociar precios?', a: 'No. Da la información que el proyecto autorizó y pasa a un asesor todo lo que requiere negociación o una decisión.' },
      { q: '¿Se puede saber qué anuncios traen los mejores interesados?', a: 'La conexión con Meta Ads, Google Ads y TikTok Ads está construida y en pruebas mientras cada plataforma autoriza la aplicación. Mientras tanto, el embudo registra de dónde llega cada contacto.' },
      HUMANO,
      CONEXION,
    ],
    related: ['/crm-con-whatsapp', '/automatizacion-de-whatsapp', '/calculadora-de-ahorro'],
  },

  /* ───────────── Herramienta ───────────── */
  {
    kind: 'herramienta',
    path: '/calculadora-de-ahorro',
    nav: 'Calculadora de ahorro',
    title: 'Calculadora de ahorro: automatizar WhatsApp | BackOffice',
    description: 'Calcula en un minuto cuántas horas y cuánto dinero al mes te cuesta atender WhatsApp a mano y cuánto podrías ahorrar automatizando las respuestas repetitivas.',
    kicker: 'Calculadora gratuita',
    h1: '¿Cuánto te cuesta',
    accent: 'atender WhatsApp a mano?',
    intro: 'Pon los números de tu negocio. La calculadora estima las horas que tu equipo dedica a responder mensajes repetitivos y lo que esas horas cuestan al mes. Es una estimación: cambia los valores hasta que se parezcan a tu realidad.',
    calculator: true,
    blocks: [
      {
        kind: 'text',
        kicker: 'Cómo se calcula',
        title: 'La fórmula,',
        accent: 'sin trucos',
        paragraphs: [
          'Horas al mes = conversaciones al día × minutos por conversación × días que atiendes al mes ÷ 60. El ahorro estimado es la parte de esas horas que corresponde a preguntas repetitivas, que un asistente puede responder, multiplicada por lo que cuesta una hora de tu equipo.',
          'No incluye las ventas que hoy se pierden por responder tarde o fuera de horario, que en muchos negocios pesan más que el tiempo.',
        ],
      },
    ],
    faq: [
      { q: '¿Qué porcentaje de conversaciones se puede automatizar?', a: 'Depende del negocio. Las preguntas repetitivas (precio, horario, ubicación, disponibilidad, estado de un pedido) suelen ser buena parte de los mensajes. Revisa una semana de chats y cuenta cuántos se responden siempre igual: ese es tu porcentaje.' },
      { q: '¿Cómo calculo el costo de una hora de mi equipo?', a: 'Suma el salario mensual y las prestaciones de quien atiende y divídelo entre las horas que trabaja al mes. Si atiendes tú, usa lo que vale tu hora en otras tareas del negocio.' },
      PRECIO,
    ],
    related: ['/guias/cuanto-cuesta-atender-whatsapp-a-mano', '/automatizacion-de-procesos', '/automatizacion-de-whatsapp'],
  },

  /* ───────────── Guías ───────────── */
  {
    kind: 'guia',
    path: '/guias/como-automatizar-whatsapp-de-tu-negocio',
    nav: 'Cómo automatizar tu WhatsApp',
    published: '2026-11-04',
    title: 'Cómo automatizar el WhatsApp de tu negocio | BackOffice',
    description: 'Guía para automatizar el WhatsApp de un negocio: qué automatizar primero, qué debe responder una persona, cómo conectar el número oficial y medir.',
    kicker: 'Guía práctica',
    h1: 'Cómo automatizar tu WhatsApp',
    accent: 'paso a paso.',
    intro: 'Automatizar WhatsApp no es poner un robot a contestar. Es decidir qué respuestas se repiten, qué decisiones necesitan una persona y cómo conectar el chat con el resto del negocio. Esta guía te lleva por los seis pasos, sirva o no BackOffice para tu caso.',
    blocks: [
      {
        kind: 'steps',
        kicker: 'Los seis pasos',
        title: 'De la idea',
        accent: 'al número funcionando',
        items: [
          { title: 'Cuenta tus preguntas repetidas', text: 'Revisa una semana de chats y anota las preguntas que respondes siempre igual. Esa lista es lo primero que se automatiza.' },
          { title: 'Escribe las respuestas oficiales', text: 'Precios, horarios, medios de pago, zonas, políticas de cambio. Si no está escrito, el asistente no debe decirlo.' },
          { title: 'Define cuándo responde una persona', text: 'Quejas, negociaciones, casos delicados y todo lo que no está en las respuestas oficiales.' },
          { title: 'Conecta el número oficial', text: 'Usa la plataforma oficial de WhatsApp Business. Las aplicaciones no autorizadas arriesgan el bloqueo del número.' },
          { title: 'Conecta el chat con tus procesos', text: 'Que el pedido, la cita o el cobro queden registrados sin copiarlos a mano.' },
          { title: 'Mide y corrige cada semana', text: 'Lee conversaciones, corrige respuestas y mira qué porcentaje termina en venta.' },
        ],
      },
      {
        kind: 'text',
        kicker: 'Errores comunes',
        title: 'Lo que',
        accent: 'conviene evitar',
        paragraphs: ['La mayoría de las automatizaciones fallan por las mismas razones, y casi ninguna es técnica.'],
        list: [
          'Dejar que el asistente invente precios o promesas que nadie aprobó.',
          'No tener una salida clara hacia una persona.',
          'Automatizar mensajes masivos sin permiso de los clientes.',
          'Medir solo cuántos mensajes se responden y no cuántos terminan en venta.',
          'Usar aplicaciones no oficiales que ponen en riesgo el número.',
        ],
      },
      {
        kind: 'text',
        kicker: 'Lista de chequeo',
        title: 'Antes de',
        accent: 'encender el asistente',
        paragraphs: ['Si puedes marcar todo esto, estás listo para automatizar.'],
        list: [
          'Tengo la lista de preguntas repetidas y sus respuestas oficiales.',
          'Sé quién del equipo recibe las conversaciones que pasan a una persona.',
          'Mi número está en la plataforma oficial de WhatsApp Business.',
          'Pedidos, citas o cobros quedan registrados en un sistema, no en un cuaderno.',
          'Tengo un día de la semana para revisar conversaciones y ajustar.',
        ],
      },
    ],
    faq: [
      { q: '¿Qué conviene automatizar primero en WhatsApp?', a: 'Las preguntas que se responden siempre igual: precios, horarios, ubicación, disponibilidad y estado de pedidos. Son las que más tiempo consumen y las de menor riesgo.' },
      { q: '¿Automatizar WhatsApp hace que el negocio se vea frío?', a: 'No si se hace bien: respuestas con el tono de la marca, inmediatas, y una persona disponible para lo que importa. Lo frío es dejar a un cliente sin respuesta hasta el día siguiente.' },
      { q: '¿Es legal enviar mensajes automáticos por WhatsApp?', a: 'Responder a quien te escribe sí. Para mensajes que inicia el negocio (promociones, recordatorios) Meta exige plantillas aprobadas y el permiso del cliente; en Colombia también aplica la ley de protección de datos personales (Ley 1581 de 2012).' },
    ],
    related: ['/automatizacion-de-whatsapp', '/calculadora-de-ahorro', '/guias/cuanto-cuesta-atender-whatsapp-a-mano'],
  },
  {
    kind: 'guia',
    path: '/guias/cuanto-cuesta-atender-whatsapp-a-mano',
    nav: 'Cuánto cuesta atender WhatsApp a mano',
    published: '2026-11-04',
    title: 'Cuánto cuesta atender WhatsApp a mano | BackOffice',
    description: 'Cómo calcular lo que cuesta atender WhatsApp a mano: horas del equipo, respuestas tardías, ventas perdidas fuera de horario y errores. Con ejemplo.',
    kicker: 'Guía · Ahorro de costos',
    h1: 'Lo que cuesta',
    accent: 'atender WhatsApp a mano.',
    intro: 'WhatsApp parece gratis porque no llega una factura. Pero cada conversación consume tiempo de alguien, y cada respuesta tardía puede costar una venta. Así se calcula lo que de verdad pagas.',
    calculator: true,
    blocks: [
      {
        kind: 'text',
        kicker: 'Costo directo',
        title: 'El tiempo',
        accent: 'de tu equipo',
        paragraphs: [
          'Multiplica las conversaciones al día por los minutos que toma cada una y por los días que atiendes al mes; divide entre 60 para tener horas. Multiplica esas horas por lo que cuesta una hora de quien atiende (salario más prestaciones, dividido entre las horas que trabaja al mes).',
          'Ejemplo ilustrativo, no un dato de un cliente real: 40 conversaciones al día de 4 minutos, 26 días al mes, son unas 69 horas mensuales. Si la hora cuesta 10.000 pesos, son unos 690.000 pesos al mes solo en responder.',
        ],
      },
      {
        kind: 'cards',
        kicker: 'Costos ocultos',
        title: 'Lo que',
        accent: 'no aparece en la nómina',
        items: [
          { title: 'Respuestas tardías', text: 'Un cliente que espera horas suele comprarle a quien respondió primero.' },
          { title: 'Fuera de horario', text: 'Los mensajes de la noche y del fin de semana se enfrían hasta el siguiente día hábil.' },
          { title: 'Errores al copiar', text: 'Pedidos o citas mal transcritos generan devoluciones, reprocesos y clientes molestos.' },
          { title: 'Seguimientos olvidados', text: 'Interesados que nadie volvió a contactar y cobros que nadie recordó.' },
        ],
      },
      {
        kind: 'text',
        kicker: 'Qué hacer',
        title: 'Cómo',
        accent: 'reducirlo',
        paragraphs: ['El primer ahorro viene de automatizar las respuestas repetitivas. El segundo, de conectar el chat con los procesos para no copiar datos a mano. El tercero, de medir: saber cuántas conversaciones terminan en venta muestra dónde se está perdiendo dinero.'],
      },
    ],
    faq: [
      { q: '¿WhatsApp Business es gratis para un negocio?', a: 'La aplicación WhatsApp Business no tiene costo, pero el tiempo que el equipo dedica a responder sí. La plataforma oficial para conectar sistemas (la API de WhatsApp Business) cobra algunos mensajes según la tarifa vigente de Meta.' },
      { q: '¿Cuánto se puede ahorrar automatizando?', a: 'Depende de cuántas conversaciones son repetitivas en tu negocio. Usa la calculadora con tus propios números; no hay una cifra que sirva para todos.' },
    ],
    related: ['/calculadora-de-ahorro', '/automatizacion-de-procesos', '/guias/como-automatizar-whatsapp-de-tu-negocio'],
  },
];

/* ───────────── Portada ───────────── */

export const HOME: SeoMeta = {
  path: '/',
  title: 'Automatización de WhatsApp y procesos con IA | BackOffice',
  description: 'Automatiza la atención por WhatsApp y los procesos de tu negocio con IA supervisada: pedidos, citas, cobros y reportes en un panel. Ahorra tiempo y dinero.',
};

export const HOME_FAQ: Faq[] = [
  {
    q: '¿Qué es BackOffice?',
    a: 'BackOffice es un software en la nube, hecho en Colombia, que automatiza la atención por WhatsApp y los procesos de un negocio con inteligencia artificial supervisada: responde clientes, toma pedidos, agenda citas, recuerda cobros, hace seguimiento comercial y entrega reportes, todo en un solo panel. Incluye además Creative (diseños con la marca del negocio) y Ads (resultados de las cuentas publicitarias).',
  },
  {
    q: '¿Qué procesos puedo automatizar?',
    a: 'Atención y preguntas frecuentes por WhatsApp, pedidos y domicilios, producción por áreas, citas y reservas, cobranza, reactivación de clientes, seguimiento comercial con embudo, campañas por WhatsApp y reportes para el dueño o gerente.',
  },
  {
    q: '¿Cómo me ayuda a ahorrar dinero?',
    a: 'Reduce las horas que tu equipo dedica a responder lo mismo, evita errores al copiar pedidos o citas a mano y recupera ventas que hoy se pierden por responder tarde o fuera de horario. La calculadora de ahorro estima cuánto con los números de tu negocio.',
  },
  HUMANO,
  CONEXION,
  { q: '¿Para qué tipo de negocios sirve?', a: 'Para negocios que atienden clientes por WhatsApp: restaurantes y domicilios, consultorios y servicios con citas, tiendas, inmobiliarias y proyectos, asesorías y más. Cada empresa ve solo las herramientas de su tipo de negocio.' },
  { q: '¿Mis datos y los de mis clientes son míos?', a: 'Sí. Cada empresa tiene su espacio separado, puede descargar sus datos y desconectar sus integraciones cuando quiera. La política de privacidad explica qué se guarda y cómo pedir su eliminación.' },
  PRECIO,
];

export const pageByPath = (path: string) => PAGES.find((p) => p.path === path);

export const SOLUTIONS = PAGES.filter((p) => p.kind === 'solucion');
export const SECTORS = PAGES.filter((p) => p.kind === 'sector');
export const GUIDES = PAGES.filter((p) => p.kind === 'guia');
