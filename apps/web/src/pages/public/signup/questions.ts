/**
 * Las 5 preguntas del registro (sin IA: no gastan tokens ni hacen esperar).
 * La IA trabaja una sola vez, al final, con estas respuestas para armar la
 * propuesta. Cada pregunta cambia algo de la recomendación:
 *
 *  1. tipo       → perfil, plan y herramientas (opciones)
 *  2. oferta     → catálogo y precios (texto: es lo que más cambia la propuesta)
 *  3. asistente  → agenda, pedidos, pagos, seguimientos (varias opciones)
 *  4. operacion  → domicilios / envíos / agenda / cotización según el rubro (opciones)
 *  5. volumen    → plan y costos de IA (opciones; va al final, es la menos fácil)
 *
 * Siempre hay «Otro» con texto libre donde las opciones pueden quedarse cortas.
 */

export type Category = 'COMIDA' | 'SALUD' | 'TIENDA' | 'BELLEZA' | 'SERVICIOS' | 'RESERVAS' | 'EDUCACION' | 'OTRO';
export type QuestionId = 'tipo' | 'oferta' | 'asistente' | 'operacion' | 'volumen';
export type Answers = Partial<Record<QuestionId, string>>;

export interface Question {
  id: QuestionId;
  n: number;
  text: string;
  kind: 'single' | 'multi' | 'text';
  options?: string[];
  /** Muestra «Otro» con un campo de texto */
  other?: boolean;
  placeholder?: string;
  /** Respuesta de un toque para quien no lo tiene claro */
  skip?: string;
  hint?: string;
}

export const QUESTION_COUNT = 5;
export const OTHER = 'Otro';

/** Mismo texto y opciones que el servidor usa para calcular los mensajes al día (dailyChatsFrom). */
export const VOLUME_QUESTION = '¿Más o menos cuántos clientes te escriben al día?';
export const VOLUME_OPTIONS = ['1 a 10', '10 a 30', '30 a 100', 'Más de 100', 'Todavía no sé'];

export const TYPE_OPTIONS: Array<{ category: Category; label: string }> = [
  { category: 'COMIDA', label: 'Restaurante o comidas' },
  { category: 'SALUD', label: 'Clínica o consultorio' },
  { category: 'TIENDA', label: 'Tienda o ropa' },
  { category: 'BELLEZA', label: 'Belleza o estética' },
  { category: 'SERVICIOS', label: 'Servicios profesionales' },
  { category: 'RESERVAS', label: 'Reservas (canchas, hospedaje)' },
  { category: 'EDUCACION', label: 'Cursos o academia' },
];

export function categoryOf(tipo: string | undefined): Category {
  return TYPE_OPTIONS.find((o) => o.label === tipo)?.category ?? 'OTRO';
}

const OFFER: Record<Category, { text: string; placeholder: string }> = {
  COMIDA: { text: '¿Qué vendes y más o menos a qué precio?', placeholder: 'Ej.: almuerzo ejecutivo $18.000, bandeja paisa $25.000, jugos $6.000' },
  SALUD: { text: '¿Qué servicios das y más o menos a qué precio?', placeholder: 'Ej.: consulta general $80.000, limpieza dental $120.000' },
  TIENDA: { text: '¿Qué vendes y más o menos a qué precio?', placeholder: 'Ej.: jeans $90.000, blusas desde $45.000, envío nacional' },
  BELLEZA: { text: '¿Qué servicios das y más o menos a qué precio?', placeholder: 'Ej.: corte $25.000, uñas semipermanentes $45.000, cejas $20.000' },
  SERVICIOS: { text: '¿Qué servicios das y más o menos a qué precio?', placeholder: 'Ej.: asesoría contable desde $300.000 al mes, declaración de renta $150.000' },
  RESERVAS: { text: '¿Qué alquilas o reservas y más o menos a qué precio?', placeholder: 'Ej.: cancha de fútbol 5 a $90.000 la hora, $110.000 de noche' },
  EDUCACION: { text: '¿Qué cursos das y más o menos a qué precio?', placeholder: 'Ej.: curso de trabajo en alturas $250.000, 3 días' },
  OTRO: { text: '¿Qué vendes o qué servicios das, y más o menos a qué precio?', placeholder: 'Cuéntalo como se lo dirías a un cliente' },
};

const ASSISTANT: Record<Category, string[]> = {
  COMIDA: ['Responder el menú y los precios', 'Tomar pedidos', 'Pedir la dirección del domicilio', 'Confirmar pagos', 'Avisarme de cada pedido'],
  SALUD: ['Responder precios y servicios', 'Agendar citas', 'Recordar las citas', 'Pedir los datos del paciente', 'Pasarme los casos delicados'],
  TIENDA: ['Responder precios y disponibilidad', 'Mostrar el catálogo', 'Tomar pedidos', 'Confirmar pagos', 'Hacer seguimiento a quien no compró'],
  BELLEZA: ['Responder precios', 'Agendar citas', 'Recordar las citas', 'Pedir anticipo', 'Llenar los espacios libres'],
  SERVICIOS: ['Responder preguntas frecuentes', 'Pedir los datos para cotizar', 'Agendar reuniones', 'Hacer seguimiento a cotizaciones', 'Pasarme los clientes listos'],
  RESERVAS: ['Mostrar horarios libres', 'Tomar reservas', 'Pedir anticipo', 'Recordar la reserva', 'Responder precios'],
  EDUCACION: ['Responder fechas, cupos y precios', 'Inscribir estudiantes', 'Pedir documentos', 'Recordar el inicio del curso', 'Hacer seguimiento a interesados'],
  OTRO: ['Responder preguntas y precios', 'Tomar pedidos', 'Agendar citas', 'Confirmar pagos', 'Hacer seguimiento a clientes'],
};

const OPERATION: Record<Category, { text: string; options: string[] }> = {
  COMIDA: { text: '¿Cómo le llega la comida a tus clientes?', options: ['Domicilio con mis domiciliarios', 'Domicilio por apps', 'Vienen a recoger', 'Domicilio y recoger'] },
  SALUD: { text: '¿Cómo atiendes a tus pacientes?', options: ['Con cita', 'Por turnos o cupos', 'Llegan sin cita', 'Presencial y virtual'] },
  TIENDA: { text: '¿Cómo le llegan los pedidos a tus clientes?', options: ['Envío por transportadora', 'Domicilio en la ciudad', 'Recogen en la tienda', 'Varias formas'] },
  BELLEZA: { text: '¿Cómo atiendes a tus clientes?', options: ['Con cita', 'Llegan sin cita', 'Voy a domicilio', 'Con cita y sin cita'] },
  SERVICIOS: { text: '¿Cómo cierras una venta normalmente?', options: ['Envío una cotización', 'Agendo una visita o reunión', 'Se vende directo por el chat', 'Con un contrato'] },
  RESERVAS: { text: '¿Cómo reservan tus clientes?', options: ['Por horas', 'Por días o noches', 'Por cupos o grupos', 'Pagan anticipo para separar'] },
  EDUCACION: { text: '¿Tus cursos tienen fechas y cupos?', options: ['Fechas fijas con cupos', 'Cuando el estudiante quiera', 'Las dos', 'Son virtuales'] },
  OTRO: { text: '¿Cómo te pagan tus clientes?', options: ['Transferencia o Nequi', 'Efectivo', 'Tarjeta o link de pago', 'Varias formas'] },
};

/** Las 5 preguntas para este tipo de negocio (cambian 2, 3 y 4 según el rubro). */
export function questionsFor(category: Category): Question[] {
  return [
    { id: 'tipo', n: 1, text: '¿Qué tipo de negocio tienes?', kind: 'single', options: TYPE_OPTIONS.map((o) => o.label), other: true, placeholder: 'Escribe tu tipo de negocio' },
    { id: 'oferta', n: 2, kind: 'text', ...OFFER[category], skip: 'Lo agrego después', hint: 'Con esto armamos tu catálogo. Escribe lo principal; lo completas después.' },
    { id: 'asistente', n: 3, text: '¿Qué quieres que haga tu asistente?', kind: 'multi', options: ASSISTANT[category], other: true, placeholder: 'Otra tarea', hint: 'Puedes elegir varias.' },
    { id: 'operacion', n: 4, kind: 'single', ...OPERATION[category], other: true, placeholder: 'Cuéntanos cómo lo haces' },
    { id: 'volumen', n: 5, text: VOLUME_QUESTION, kind: 'single', options: VOLUME_OPTIONS },
  ];
}

/** «Otro: …» → solo lo que escribió (para leer y mostrar). */
export const plainAnswer = (a?: string) => (a ?? '').replace(/^Otro: /, '').trim();

/**
 * Las respuestas como conversación para la IA (el mismo formato de siempre:
 * pregunta → respuesta). La de volumen usa el texto exacto que el servidor
 * reconoce para calcular los mensajes al día.
 */
export function toMessages(companyName: string, answers: Answers, link?: string): Array<{ role: 'user' | 'assistant'; content: string }> {
  const category = categoryOf(answers.tipo);
  const qs = questionsFor(category);
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'assistant', content: '¿Cómo se llama tu negocio?' },
    { role: 'user', content: companyName.trim() || 'Mi negocio' },
  ];
  for (const q of qs) {
    const a = plainAnswer(answers[q.id]);
    if (!a) continue;
    const content = q.id === 'tipo'
      ? `Mi negocio es: ${a}`
      : q.id === 'oferta' && answers.oferta === q.skip
        ? 'Todavía no tengo la lista de productos y precios a la mano; la agrego después.'
        : q.id === 'asistente' ? `Quiero que el asistente: ${a.toLowerCase()}` : a;
    out.push({ role: 'assistant', content: q.text }, { role: 'user', content });
  }
  if (link?.trim()) out.push({ role: 'assistant', content: '¿Tienes Instagram o página web?' }, { role: 'user', content: link.trim() });
  return out;
}

/** Lo primero que se le lee a la oferta (para el adelanto): los nombres, sin precios («fútbol 5» se queda). */
export function firstItems(oferta: string, max = 2): string[] {
  return oferta
    .split(/[,;\n]| y /)
    .map((x) => x.split(/\s+(?:a|desde|por|de|en)?\s*\$|\$|:\s|\s+-\s+/i)[0].replace(/\s+\d[\d.,]{2,}\s*(mil|k)?\s*$/i, '').trim())
    .filter((x) => x.length >= 3 && x.length <= 40)
    .slice(0, max);
}

const VALUE: Record<Category, [string, string, string]> = {
  COMIDA: ['Responder el menú y los precios al instante', 'Tomar pedidos con dirección y forma de pago', 'Avisarte de cada pedido nuevo'],
  SALUD: ['Responder precios y servicios', 'Agendar citas sin cruces y recordarlas', 'Pasarte los casos que necesitan una persona'],
  TIENDA: ['Responder precios y disponibilidad', 'Tomar pedidos y confirmar pagos', 'Escribirle a quien preguntó y no compró'],
  BELLEZA: ['Responder precios', 'Agendar citas y recordarlas', 'Avisarte de cada cita nueva'],
  SERVICIOS: ['Responder lo que te preguntan siempre', 'Pedir los datos para cotizar', 'Pasarte los clientes listos para cerrar'],
  RESERVAS: ['Mostrar los horarios libres', 'Tomar reservas sin cruces', 'Recordar la reserva y pedir anticipo'],
  EDUCACION: ['Responder fechas, cupos y precios', 'Inscribir a los interesados', 'Recordarles el inicio del curso'],
  OTRO: ['Responder preguntas y precios', 'Tomar pedidos o agendar', 'Avisarte de cada cliente nuevo'],
};

/**
 * Adelanto a mitad de camino (después de la pregunta 2), armado por código con
 * lo que respondió: 3 viñetas como máximo, sin gastar IA.
 */
export function valuePreview(answers: Answers): string[] {
  const category = categoryOf(answers.tipo);
  const bullets = [...VALUE[category]];
  const items = answers.oferta && !/lo agrego después/i.test(answers.oferta) ? firstItems(plainAnswer(answers.oferta)) : [];
  if (items.length) {
    bullets[0] = `Responder precios de ${items.join(' y ').toLowerCase()} al instante`;
  }
  return bullets.slice(0, 3);
}
