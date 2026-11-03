import type { Company } from './types';

/**
 * Lo que depende del tipo de negocio en la interfaz: los ejemplos tienen que
 * sonar a SU negocio (a una constructora no se le habla de domicilios).
 */

export function usesOrders(company?: Company | null) {
  return !!company && (company.modules ?? []).includes('orders') && !(company.businessProfile?.hides ?? []).includes('orders');
}

const AUTOMATION_EXAMPLES: Record<string, string[]> = {
  COMIDA: ['Cuando un pedido pasa a «Entregado», enviarle al cliente un mensaje para que califique.', 'Cuando entra un contacto nuevo, asignarlo a la persona de caja.', 'Si un pedido lleva 30 minutos sin confirmar, avisarle al equipo.'],
  CONSTRUCCION: ['Cuando alguien pide una visita técnica, avisarle al comercial y crear la tarea.', 'Si un interesado lleva 3 días sin respuesta después de la propuesta, recordárselo a tu equipo.', 'Cuando el contacto pasa a «Obra contratada», etiquetarlo como cliente.'],
  INMOBILIARIA: ['Cuando un interesado agenda visita, avisarle al asesor de la zona.', 'Si alguien pidió información y no respondió en 2 días, crear un seguimiento.', 'Cuando el contacto pasa a «Documentos solicitados», asignarlo a la persona de contratos.'],
  SALUD: ['Cuando un paciente agenda, avisarle a recepción.', 'Si un contacto preguntó por una consulta y no agendó, crear un seguimiento.', 'Cuando alguien escribe por primera vez, etiquetarlo por especialidad.'],
  BELLEZA: ['Cuando una clienta agenda, avisarle a la profesional.', 'Si alguien preguntó precios y no agendó, crear un seguimiento al día siguiente.', 'Cuando un contacto vuelve después de 60 días, etiquetarlo como recurrente.'],
  ROPA: ['Cuando un pedido pasa a «Enviado», avisarle al cliente.', 'Si alguien preguntó por una talla y no compró, crear un seguimiento.', 'Cuando entra un contacto nuevo por Instagram, asignarlo a ventas.'],
  EDUCACION: ['Cuando alguien se inscribe, avisarle a coordinación.', 'Si un interesado no completó la inscripción en 2 días, crear un seguimiento.', 'Cuando el contacto pasa a «Matriculado», etiquetarlo con el curso.'],
};
const GENERIC = ['Cuando entra un contacto nuevo, asignarlo a una persona del equipo.', 'Si un interesado lleva días sin respuesta, crear un seguimiento para tu equipo.', 'Cuando un contacto cambia de etapa, etiquetarlo o avisar a quien corresponde.'];

export function automationExamples(company?: Company | null): string[] {
  return AUTOMATION_EXAMPLES[company?.businessProfile?.key ?? ''] ?? GENERIC;
}

/** Textos de ejemplo (placeholders) que suenan al negocio de la empresa. */
type SampleKey = 'tags' | 'campaignName' | 'campaignHint' | 'category' | 'unit' | 'presentation' | 'about' | 'coupon' | 'adOffer' | 'adText' | 'contentGoal';
const SAMPLES: Record<string, Partial<Record<SampleKey, string>>> = {
  COMIDA: {
    tags: 'vip, almuerzos', campaignName: 'Menú de la semana', campaignHint: 'Envía el menú de la semana, reactiva clientes que no piden hace días o anuncia una promoción.',
    category: 'desayunos, almuerzos…', unit: 'porción, unidad, bandeja…', presentation: 'individual, bandeja x10…', coupon: 'ALMUERZO10',
    about: 'Vendemos almuerzos ejecutivos en Laureles, de lunes a viernes de 11 a 3. Bandeja paisa 18.000, ajiaco 16.000. Domicilio 3.000 hasta 3 km. Pagos por Nequi o efectivo…',
    adOffer: 'Ej.: 2x1 martes de hamburguesas', adText: '2x1 en hamburguesas todos los martes. Escríbenos y reserva tu mesa.', contentGoal: 'Este mes queremos impulsar los almuerzos ejecutivos para empresas',
  },
  CONSTRUCCION: {
    tags: 'remodelación, cocina, visita', campaignName: 'Temporada de remodelaciones', campaignHint: 'Comparte trabajos recientes, invita a agendar una visita técnica o retoma a quienes pidieron información.',
    category: 'remodelación, acabados…', unit: 'servicio, metro cuadrado…', presentation: 'visita técnica, proyecto completo…', coupon: 'VISITA2026',
    about: 'Hacemos remodelaciones de cocinas, baños y apartamentos en Medellín y el Valle de Aburrá. Primero visitamos la obra sin costo y después enviamos la propuesta. Trabajamos con materiales certificados…',
    adOffer: 'Ej.: visita técnica sin costo este mes', adText: '¿Pensando en remodelar tu cocina? Agenda una visita técnica sin costo y te contamos cómo quedaría.', contentGoal: 'Este mes queremos mostrar las remodelaciones de cocinas que terminamos',
  },
  INMOBILIARIA: {
    tags: 'arriendo, venta, laureles', campaignName: 'Nuevos inmuebles de la semana', campaignHint: 'Comparte inmuebles nuevos, invita a agendar visitas o retoma a quienes buscaban en una zona.',
    category: 'arriendo, venta…', unit: 'inmueble', presentation: 'apartamento, casa, local…', coupon: 'SINCOMISION',
    about: 'Somos una inmobiliaria en Medellín con apartamentos en arriendo y venta en Laureles, Belén y El Poblado. Hacemos estudio en 48 horas…',
    adOffer: 'Ej.: apartamentos en arriendo en Laureles', adText: 'Apartamentos en arriendo en Laureles desde 2 habitaciones. Escríbenos y agenda tu visita.', contentGoal: 'Este mes queremos mover los apartamentos en arriendo de Laureles',
  },
  SALUD: {
    tags: 'control, primera vez', campaignName: 'Jornada de chequeo', campaignHint: 'Recuerda controles pendientes, anuncia una jornada o invita a pacientes que no vuelven hace meses.',
    category: 'consultas, procedimientos…', unit: 'consulta, sesión…', presentation: 'primera vez, control…', coupon: 'CHEQUEO',
    about: 'Consultorio odontológico en Envigado. Atendemos de lunes a sábado. Hacemos limpiezas, ortodoncia y diseño de sonrisa…',
    adOffer: 'Ej.: valoración de ortodoncia', adText: 'Agenda tu valoración de ortodoncia y conoce tu tratamiento. Escríbenos por WhatsApp.', contentGoal: 'Este mes queremos llenar la agenda de valoraciones',
  },
  BELLEZA: {
    tags: 'uñas, recurrente', campaignName: 'Agenda de diciembre', campaignHint: 'Llena los huecos de la agenda, anuncia un servicio nuevo o recuerda a clientas que no vuelven.',
    category: 'uñas, cabello…', unit: 'servicio, sesión…', presentation: 'básico, completo…', coupon: 'BIENVENIDA',
    about: 'Salón de belleza en Sabaneta: uñas, cejas, pestañas y cabello. Atendemos con cita de martes a domingo…',
    adOffer: 'Ej.: manicure + pedicure', adText: 'Manicure y pedicure con cita. Escríbenos y separa tu horario.', contentGoal: 'Este mes queremos llenar la agenda de los martes y miércoles',
  },
  ROPA: {
    tags: 'mayorista, nueva colección', campaignName: 'Nueva colección', campaignHint: 'Anuncia una colección, avisa de tallas que volvieron o retoma a quien preguntó y no compró.',
    category: 'blusas, jeans…', unit: 'prenda, unidad…', presentation: 'talla S, M, L…', coupon: 'COLECCION10',
    about: 'Marca de ropa femenina en Medellín. Enviamos a todo el país por transportadora. Tallas de la S a la XL…',
    adOffer: 'Ej.: nueva colección de jeans', adText: 'Llegó la nueva colección de jeans. Escríbenos y te mostramos tallas y colores.', contentGoal: 'Este mes queremos lanzar la colección de temporada',
  },
};
const GENERIC_SAMPLES: Record<SampleKey, string> = {
  tags: 'interesado, recurrente', campaignName: 'Novedades del mes', campaignHint: 'Anuncia una novedad, invita a quienes preguntaron y no compraron o recuerda a clientes que no vuelven hace tiempo.',
  category: 'categoría…', unit: 'unidad, servicio…', presentation: 'básico, completo…', coupon: 'BIENVENIDA10',
  about: 'Cuéntale al asistente qué ofreces, a quién, dónde atiendes, horarios, cómo se paga y lo que siempre te preguntan…',
  adOffer: 'Ej.: lo que quieres promocionar', adText: 'Cuenta en una o dos frases qué ofreces y qué debe hacer la persona (escribirte, agendar…).', contentGoal: 'Este mes queremos dar a conocer nuestro servicio principal',
};

export function sample(company: Company | null | undefined, key: SampleKey): string {
  return SAMPLES[company?.businessProfile?.key ?? '']?.[key] ?? GENERIC_SAMPLES[key];
}
