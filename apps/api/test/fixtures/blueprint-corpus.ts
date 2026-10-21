/**
 * Negocios de ejemplo para comparar el plano de la IA con el del motor por
 * código (test/blueprint-engine.spec.ts). Respuestas como las escribiría un
 * dueño real: cortas, con faltas de detalle y sin orden fijo.
 */
export interface CorpusCase { id: string; answers: Array<[string, string]> }

const Q = {
  que: '¡Hola! Te voy a hacer unas preguntas cortas para armar tu cuenta. Para empezar: ¿qué hace tu negocio?',
  nombre: '¡Qué bien! ¿Cómo se llama tu negocio y en qué ciudad está?',
  volumen: '¿Más o menos cuántos clientes te escriben al día?',
};

export const CORPUS: CorpusCase[] = [
  { id: 'ropa', answers: [
    [Q.que, 'Tengo una marca de ropa pequeña para mujer, hacemos blusas, vestidos y jeans'],
    [Q.nombre, 'Se llama Lúa, en Medellín'],
    [Q.volumen, '10 a 30'],
    ['¿Cómo te encuentran y qué te preguntan primero?', 'Por Instagram y WhatsApp, siempre preguntan tallas y precio'],
    ['¿Cómo entregas los pedidos?', 'Enviamos por transportadora a todo el país, en Medellín también por mensajería'],
    ['¿Cómo te pagan?', 'Transferencia Bancolombia y Nequi, antes de enviar'],
    ['¿Qué quieres que haga el asistente?', 'Que responda tallas y precios, muestre el catálogo y tome los datos del pedido. Los vestidos valen 120.000 y las blusas 65.000'],
  ] },
  { id: 'almuerzos', answers: [
    [Q.que, 'Vendo almuerzos caseros a domicilio para oficinas'],
    [Q.nombre, 'Sazón de la Abuela, en Bogotá, Chapinero'],
    [Q.volumen, '30 a 100'],
    ['¿Cómo llegan los pedidos?', 'Por WhatsApp desde las 9 de la mañana, tengo 3 domiciliarios propios'],
    ['¿Qué ofreces?', 'Menú del día a 16.000 con sopa, seco y jugo, y ejecutivo a 22.000'],
    ['¿Horario?', 'Lunes a viernes de 11 am a 3 pm'],
    ['¿Cómo te pagan?', 'Efectivo contra entrega o Nequi'],
  ] },
  { id: 'unas', answers: [
    [Q.que, 'Tengo un salón de uñas y pestañas'],
    [Q.nombre, 'Glow Nails, en Cali'],
    [Q.volumen, '10 a 30'],
    ['¿Cómo agendan?', 'Por WhatsApp, eligen la manicurista y la hora'],
    ['¿Qué servicios y precios?', 'Semipermanente 45.000, acrílicas 90.000, pestañas pelo a pelo 120.000'],
    ['¿Pides algo para separar?', 'Sí, un anticipo de 20.000 por Nequi para apartar la cita'],
    ['¿Horario?', 'Lunes a sábado de 9 am a 7 pm'],
  ] },
  { id: 'odonto', answers: [
    [Q.que, 'Consultorio odontológico particular'],
    [Q.nombre, 'Sonrisa Plena, en Pereira'],
    [Q.volumen, '1 a 10'],
    ['¿Qué servicios ofreces?', 'Limpieza, blanqueamiento, ortodoncia y diseño de sonrisa. La valoración cuesta 50.000'],
    ['¿Cómo agendan?', 'Llaman o escriben y les damos cita con la doctora'],
    ['¿Qué datos necesitas?', 'Nombre, cédula, edad y si tienen alguna enfermedad'],
    ['¿Qué quieres que haga el asistente?', 'Que agende citas, recuerde la cita un día antes y responda precios aproximados'],
  ] },
  { id: 'alturas', answers: [
    [Q.que, 'Somos un centro de entrenamiento en trabajo seguro en alturas'],
    [Q.nombre, 'Alturas Seguras, en Itagüí'],
    [Q.volumen, '10 a 30'],
    ['¿Cómo funcionan los cursos?', 'Curso avanzado de 40 horas y reentrenamiento de 8 horas, hay grupos cada semana con cupo de 20'],
    ['¿Qué piden para inscribirse?', 'Cédula, certificado de EPS y ARL vigente, y el pago antes de iniciar'],
    ['¿Precios?', 'Avanzado 380.000 y reentrenamiento 180.000. Empresas tienen descuento por grupo'],
    ['¿Qué pasa después?', 'Se entrega certificado y hay que reentrenar cada año, nos gustaría recordarles'],
  ] },
  { id: 'inmobiliaria', answers: [
    [Q.que, 'Inmobiliaria de arriendos y ventas de apartamentos'],
    [Q.nombre, 'Habitar, en Medellín'],
    [Q.volumen, '30 a 100'],
    ['¿Qué preguntan primero?', 'Precio, zona, número de habitaciones y si tiene parqueadero'],
    ['¿Cómo sigue el proceso?', 'Agendamos visita con un asesor y luego hacen el estudio de arrendamiento con documentos'],
    ['¿Qué documentos piden?', 'Cédula, carta laboral, extractos y un codeudor'],
    ['¿Qué quieres que haga el asistente?', 'Filtrar a los interesados, enviar fotos del inmueble y agendar visitas'],
  ] },
  { id: 'tecnologia', answers: [
    [Q.que, 'Tienda de celulares y accesorios'],
    [Q.nombre, 'TecnoMax, en Barranquilla'],
    [Q.volumen, '30 a 100'],
    ['¿Qué vendes?', 'Celulares nuevos Samsung y Xiaomi, forros, cargadores y audífonos'],
    ['¿Cómo entregas?', 'En la tienda o envío por Servientrega a todo el país'],
    ['¿Cómo pagan?', 'Efectivo, tarjeta, transferencia y crédito con Addi'],
    ['¿Horario?', 'Lunes a sábado de 9 am a 8 pm y domingos de 10 a 2'],
  ] },
  { id: 'taller', answers: [
    [Q.que, 'Taller de mantenimiento de motos'],
    [Q.nombre, 'MotoServicio El Paisa, en Envigado'],
    [Q.volumen, '10 a 30'],
    ['¿Qué servicios?', 'Cambio de aceite, revisión general, frenos y sincronización. El cambio de aceite está en 35.000'],
    ['¿Cómo funciona?', 'Traen la moto, la revisamos, les damos la cotización y cuando está lista les avisamos'],
    ['¿Agendan cita?', 'Sí, preferimos con cita para no hacerlos esperar'],
    ['¿Cómo pagan?', 'Efectivo o transferencia al recoger la moto'],
  ] },
  { id: 'fotografia', answers: [
    [Q.que, 'Soy fotógrafo de bodas y eventos'],
    [Q.nombre, 'Luz Eterna Fotografía, en Bucaramanga'],
    [Q.volumen, '1 a 10'],
    ['¿Cómo te contratan?', 'Me escriben, preguntan disponibilidad de la fecha y les envío los paquetes'],
    ['¿Precios?', 'Paquete básico 1.800.000 y premium 3.500.000 con video'],
    ['¿Cómo cobras?', 'Separan la fecha con el 30% de anticipo y el resto el día del evento'],
    ['¿Qué quieres que haga el asistente?', 'Que pregunte la fecha, el lugar y el tipo de evento y envíe la cotización'],
  ] },
  { id: 'reposteria', answers: [
    [Q.que, 'Hago tortas y postres por encargo'],
    [Q.nombre, 'Dulce Antojo, en Manizales'],
    [Q.volumen, '1 a 10'],
    ['¿Con cuánta anticipación?', 'Mínimo 2 días antes, para eventos grandes una semana'],
    ['¿Qué vendes y a cuánto?', 'Tortas desde 60.000, cupcakes la docena a 45.000 y mesas de postres'],
    ['¿Cómo entregas?', 'Recogen en mi casa o domicilio con costo adicional'],
    ['¿Cómo pagan?', 'La mitad para separar por Nequi y el resto al entregar'],
  ] },
  { id: 'gimnasio', answers: [
    [Q.que, 'Gimnasio con clases grupales y zona de pesas'],
    [Q.nombre, 'Power Fit, en Villavicencio'],
    [Q.volumen, '10 a 30'],
    ['¿Qué planes tienes?', 'Mensualidad 90.000, trimestre 240.000 y clase de prueba gratis'],
    ['¿Horario?', 'Lunes a viernes de 5 am a 10 pm y sábados de 7 am a 2 pm'],
    ['¿Qué preguntan?', 'Precios, horarios de clases de spinning y si hay entrenador personalizado'],
    ['¿Qué quieres que haga el asistente?', 'Que responda planes, agende la clase de prueba y recuerde la renovación de la mensualidad'],
  ] },
  { id: 'webcam', answers: [
    [Q.que, 'Estudio webcam con 12 modelos'],
    [Q.nombre, 'Studio Venus, en Cali'],
    [Q.volumen, 'Más de 100'],
    ['¿Qué venden por el chat?', 'Fotos y videos personalizados, y suscripción mensual'],
    ['¿Cómo pagan?', 'Por la plataforma o transferencia, siempre antes de enviar el contenido'],
    ['¿Qué quieres que haga el asistente?', 'Conversar con los fans, ofrecer el contenido de la galería y nunca enviar sin pago'],
    ['¿Algo más?', 'Que cada modelo tenga su propia línea y personalidad'],
  ] },
];

/** Respuestas del dueño en orden (lo que reciben ambos motores). */
export function ownerAnswers(c: CorpusCase): string[] {
  return c.answers.map(([, a]) => a);
}

/** Conversación en el formato del registro. */
export function conversation(c: CorpusCase) {
  return c.answers.flatMap(([q, a]) => [{ role: 'assistant' as const, content: q }, { role: 'user' as const, content: a }]);
}
