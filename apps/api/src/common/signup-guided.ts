/**
 * Plan B del registro cuando NINGUNA IA responde (Gemini y OpenRouter caídos o
 * agotados): preguntas fijas con opciones para tocar y un plano básico armado
 * con reglas. La persona igual crea su empresa; el equipo la afina por WhatsApp.
 * Todo sale en el mismo formato que devuelve la IA, así pasa por los mismos
 * validadores (normalizeInterviewTurn, normalizeProposal, normalizeBlueprint).
 */
import { Rubro, guessRubro } from './rubros';
import { ProfileKey, detectProfile } from './business-profile';

interface GuidedQuestion {
  pregunta: string;
  opciones: string[];
}

const COMMON_START: GuidedQuestion[] = [
  { pregunta: '¿Cómo se llama tu negocio y en qué ciudad estás?', opciones: [] },
  { pregunta: '¿Quiénes te compran?', opciones: ['Personas', 'Empresas', 'Las dos'] },
];

const BY_RUBRO: Record<Rubro, GuidedQuestion[]> = {
  COMIDAS: [
    { pregunta: '¿Cómo le llega la comida a tus clientes?', opciones: ['Domicilio con mis domiciliarios', 'Domicilio por apps', 'Vienen a recoger', 'Las dos: domicilio y recoger'] },
    { pregunta: '¿Los pedidos son para el momento o con anticipación?', opciones: ['Para ya mismo', 'Con un día de anticipación', 'Los dos'] },
  ],
  SERVICIOS: [
    { pregunta: '¿Tus clientes reservan una cita o un cupo?', opciones: ['Sí, con cita', 'Sí, por cupos o grupos', 'No, llegan sin cita'] },
    { pregunta: '¿Qué le pides al cliente antes de atenderlo?', opciones: ['Nombre y teléfono', 'Documento de identidad', 'Un anticipo', 'Nada especial'] },
  ],
  VENTAS: [
    { pregunta: '¿Cómo entregas lo que vendes?', opciones: ['Envío a domicilio', 'Recogen en la tienda', 'Las dos'] },
    { pregunta: '¿Qué preguntan primero tus clientes?', opciones: ['El precio', 'Si hay disponibilidad o tallas', 'Cómo pagar', 'Tiempos de entrega'] },
  ],
  WEBCAM: [
    { pregunta: '¿Qué vendes por el chat?', opciones: ['Fotos y videos', 'Shows o sesiones', 'Suscripciones', 'Todo lo anterior'] },
    { pregunta: '¿Cuántas modelos o perfiles atiendes?', opciones: ['1 a 3', '4 a 10', 'Más de 10'] },
  ],
};

const COMMON_END: GuidedQuestion[] = [
  { pregunta: '¿Cómo te pagan tus clientes?', opciones: ['Transferencia o Nequi', 'Efectivo', 'Tarjeta o link de pago', 'Varias formas'] },
  { pregunta: '¿Qué quieres que haga el asistente por ti?', opciones: ['Responder preguntas', 'Tomar pedidos', 'Agendar citas', 'Cobrar y confirmar pagos'] },
];

/** Preguntas propias de perfiles que comparten rubro (una marca de ropa no es cualquier tienda). */
const BY_PROFILE: Partial<Record<ProfileKey, GuidedQuestion[]>> = {
  ROPA: [
    { pregunta: '¿Cómo le llegan las prendas a tus clientes?', opciones: ['Envío por transportadora', 'Recogen en la tienda', 'Las dos'] },
    { pregunta: '¿Qué te preguntan primero?', opciones: ['Tallas y disponibilidad', 'El precio', 'Cómo es el envío', 'Cambios y devoluciones'] },
  ],
  EDUCACION: [
    { pregunta: '¿Tus cursos tienen fechas y cupos?', opciones: ['Sí, fechas fijas con cupos', 'Cuando el estudiante quiera', 'Las dos'] },
    { pregunta: '¿Qué le pides al estudiante para inscribirlo?', opciones: ['Documento de identidad', 'Pago o anticipo', 'Certificados previos', 'Nada especial'] },
  ],
  BELLEZA: [
    { pregunta: '¿Tus clientes reservan con un profesional en especial?', opciones: ['Sí, eligen con quién', 'No, con quien esté libre', 'A veces'] },
    { pregunta: '¿Pides anticipo para separar la cita?', opciones: ['Sí, siempre', 'Solo en servicios largos', 'No'] },
  ],
};

export function guidedQuestions(rubro: Rubro, profile?: ProfileKey): GuidedQuestion[] {
  return [...COMMON_START, ...((profile && BY_PROFILE[profile]) || BY_RUBRO[rubro]), ...COMMON_END];
}

/** Siguiente pregunta fija (answered = respuestas que ya dio, contando la descripción). */
export function guidedTurn(firstAnswer: string, answered: number, allText = firstAnswer) {
  const questions = guidedQuestions(guessRubro(firstAnswer), detectProfile(allText, firstAnswer).key);
  const next = questions[answered - 1];
  return next
    ? { listo: false, pregunta: next.pregunta, opciones: next.opciones, nota: '' }
    : { listo: true, pregunta: '', opciones: [], nota: '' };
}

const NEEDS: Record<Rubro, Array<{ titulo: string; como_lo_resuelve: string }>> = {
  COMIDAS: [
    { titulo: 'Recibir pedidos por WhatsApp sin perder ninguno', como_lo_resuelve: 'El asistente toma el pedido, confirma dirección y total, y te llega ordenado a tu panel.' },
    { titulo: 'Mostrar el menú con precios', como_lo_resuelve: 'Un menú digital con QR para compartir por WhatsApp y redes.' },
    { titulo: 'Saber en qué va cada domicilio', como_lo_resuelve: 'Domicilios en vivo con link de seguimiento para tu cliente.' },
  ],
  SERVICIOS: [
    { titulo: 'Agendar citas sin estar pegado al celular', como_lo_resuelve: 'El asistente ofrece horarios libres y agenda la cita solo.' },
    { titulo: 'Que los clientes no falten', como_lo_resuelve: 'Recordatorios automáticos antes de cada cita.' },
    { titulo: 'Responder siempre las mismas preguntas', como_lo_resuelve: 'El asistente responde precios, requisitos y horarios al instante.' },
  ],
  VENTAS: [
    { titulo: 'Responder rápido a quien pregunta precios', como_lo_resuelve: 'El asistente muestra tu catálogo con precios a cualquier hora.' },
    { titulo: 'No dejar clientes sin respuesta', como_lo_resuelve: 'Seguimiento automático a quien dejó de responder.' },
    { titulo: 'Vender más a quien ya te compró', como_lo_resuelve: 'Campañas por WhatsApp a tus clientes.' },
  ],
  WEBCAM: [
    { titulo: 'Atender muchos chats a la vez', como_lo_resuelve: 'El asistente conversa como persona en cada línea, sin hacer esperar.' },
    { titulo: 'Vender contenido por el chat', como_lo_resuelve: 'Galería con precios que el asistente ofrece en la conversación.' },
    { titulo: 'Saber cuánto vende cada perfil', como_lo_resuelve: 'Reporte de ventas por línea y por día.' },
  ],
};

const CLIENT_DATA: Record<Rubro, string[]> = {
  COMIDAS: ['Nombre', 'Dirección', 'Barrio', 'Teléfono', 'Forma de pago'],
  SERVICIOS: ['Nombre', 'Teléfono', 'Servicio que necesita', 'Fecha y hora que prefiere'],
  VENTAS: ['Nombre', 'Teléfono', 'Producto que le interesa', 'Ciudad de envío'],
  WEBCAM: ['Nombre o apodo', 'Qué le interesa'],
};

const FLOW: Record<Rubro, string[]> = {
  COMIDAS: ['Saluda con el nombre del negocio', 'Muestra el menú o recomienda', 'Toma el pedido y la dirección', 'Confirma el total y la forma de pago', 'Avisa el tiempo de entrega'],
  SERVICIOS: ['Saluda con el nombre del negocio', 'Pregunta qué servicio necesita', 'Da precio y requisitos', 'Ofrece horarios libres y agenda', 'Confirma la cita y recuerda qué traer'],
  VENTAS: ['Saluda con el nombre del negocio', 'Pregunta qué está buscando', 'Muestra opciones con precio', 'Resuelve dudas de pago y envío', 'Cierra la venta o pasa a una persona'],
  WEBCAM: ['Saluda con calidez', 'Conversa y conoce qué le gusta', 'Ofrece el contenido de la galería', 'Confirma el pago antes de enviar'],
};

/** Nombre del negocio dicho en la primera respuesta guiada ("Se llama X, en Y"). */
function nameAndCity(answer: string): { nombre: string; ciudad: string } {
  const text = answer.replace(/\s+/g, ' ').trim();
  const city = /\b(?:en|de)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)\s*\.?$/.exec(text)?.[1] ?? '';
  let name = text
    .replace(/^(se llama|mi negocio se llama|el negocio se llama|somos|es)\s+/i, '')
    .replace(/\s*[,.-]?\s*(?:y\s+)?(?:estamos|quedamos|en|de)\s+[A-ZÁÉÍÓÚÑ][\s\S]*$/, '')
    .trim();
  if (name.length > 60 || name.split(' ').length > 6) name = '';
  return { nombre: name, ciudad: city };
}

/** Plano básico sin IA, en el formato de la IA (pasa por los mismos validadores). */
export function guidedBlueprint(answers: string[]) {
  const all = answers.join(' ');
  const rubro = guessRubro(all);
  const lower = all.toLowerCase();
  const { nombre, ciudad } = answers.length > 1 ? nameAndCity(answers[1]) : { nombre: '', ciudad: '' };
  const herramientas: Record<Rubro, string[]> = {
    COMIDAS: ['orders', 'menu', 'campaigns', ...(/domicilio|domiciliario/.test(lower) && !/por apps/.test(lower) ? ['delivery'] : [])],
    SERVICIOS: ['agenda', 'campaigns'],
    VENTAS: ['orders', 'campaigns', ...(/cita|visita/.test(lower) ? ['agenda'] : [])],
    WEBCAM: ['media', 'campaigns'],
  };
  const business = nombre || 'tu negocio';
  return {
    rubro,
    tipo_negocio: '',
    empresa: { nombre, ciudad, resumen: answers[0]?.slice(0, 200) ?? '' },
    necesidades: NEEDS[rubro],
    herramientas: herramientas[rubro],
    embudo: null,
    productos: [],
    horario: null,
    domicilios: null,
    datos_cliente: CLIENT_DATA[rubro],
    flujo_asistente: FLOW[rubro],
    respuestas_rapidas: [],
    seguimientos: [{ cuando: 'no_reply', horas: 3, mensaje: '¡Hola! ¿Pudiste ver la información? Quedo atenta para ayudarte.' }],
    preguntas: [],
    asistente: {
      nombre: 'Sara',
      tono: 'Cercano y profesional',
      estilo: 'Mensajes cortos y claros',
      bienvenida: `¡Hola! Soy Sara, de ${business}. ¿En qué te puedo ayudar?`,
      instrucciones: `Atiendes el WhatsApp de ${business}: respondes dudas, das precios y requisitos que conoces y llevas al cliente al siguiente paso. Si no sabes algo, lo pasas a una persona del equipo.`,
    },
  };
}
