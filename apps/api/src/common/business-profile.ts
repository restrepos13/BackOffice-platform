/**
 * Perfil del negocio, detectado por código (sin IA) a partir de lo que cuenta
 * el dueño. Evita que una marca de ropa reciba preguntas u opciones de
 * restaurante: guía la entrevista de la IA, filtra herramientas que no aplican
 * y da las funciones típicas de su equipo para los primeros pasos del panel.
 */
import { Rubro } from './rubros';

export type ProfileKey =
  | 'ROPA' | 'COMIDA' | 'BELLEZA' | 'SALUD' | 'EDUCACION' | 'INMOBILIARIA'
  | 'TIENDA' | 'TALLER' | 'WEBCAM' | 'SERVICIOS' | 'GENERAL';

export interface BusinessProfile {
  key: ProfileKey;
  label: string;
  /** Cómo le llega lo vendido al cliente */
  shipping: 'TRANSPORTADORA' | 'DOMICILIARIOS' | 'NINGUNO' | 'CUALQUIERA';
  /** Herramientas que nunca le sirven a este perfil */
  deny: string[];
  /** Temas que sí importan y lo que jamás se debe preguntar (para la IA) */
  ask: string;
  never: string;
  /** Funciones típicas de su equipo (primeros pasos) */
  roles: string[];
  /** Lo que más le quita tiempo (primeros pasos) */
  pains: string[];
}

const FOOD_TOOLS = ['menu', 'production', 'delivery'];

export const PROFILES: Record<ProfileKey, BusinessProfile> = {
  ROPA: {
    key: 'ROPA', label: 'Marca de ropa y moda', shipping: 'TRANSPORTADORA', deny: FOOD_TOOLS,
    ask: 'tallas y guía de medidas, colecciones o lanzamientos, fotos de las prendas, envíos por transportadora, cambios y devoluciones, ventas al por mayor o al detal, Instagram',
    never: 'menú, cocina, comandas, mesas, domiciliarios propios, tarifa por kilómetro ni tiempo de preparación',
    roles: ['Ventas por WhatsApp e Instagram', 'Diseño y colecciones', 'Confección o taller', 'Bodega y empaques', 'Envíos', 'Fotos y redes sociales', 'Tienda física', 'Cuentas y pagos'],
    pains: ['Responder tallas y precios todo el día', 'Saber qué hay en bodega', 'Organizar los envíos', 'Cobrar y confirmar pagos', 'Publicar en redes'],
  },
  COMIDA: {
    key: 'COMIDA', label: 'Comidas y bebidas', shipping: 'DOMICILIARIOS', deny: [],
    ask: 'menú y precios, domicilios o para recoger, horarios, tiempos de entrega, zonas de cobertura, pedidos para eventos',
    never: 'tallas, colecciones ni transportadoras nacionales',
    roles: ['Cocina', 'Caja y pedidos', 'Meseros', 'Domiciliarios', 'Compras e inventario', 'Redes sociales', 'Administración'],
    pains: ['Tomar pedidos por WhatsApp', 'Coordinar domicilios', 'Saber qué se vendió en el día', 'Responder el menú una y otra vez'],
  },
  BELLEZA: {
    key: 'BELLEZA', label: 'Belleza y cuidado personal', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'servicios y precios, duración de cada servicio, agenda y profesionales, anticipos, recordatorios, productos que vende',
    never: 'menú, cocina, domicilios ni tiempos de preparación',
    roles: ['Estilistas o esteticistas', 'Recepción y agenda', 'Venta de productos', 'Redes sociales', 'Administración'],
    pains: ['Agendar citas por chat', 'Clientes que no llegan', 'Responder precios', 'Llenar los huecos de la agenda'],
  },
  SALUD: {
    key: 'SALUD', label: 'Salud y consultorios', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'especialidades, citas y disponibilidad, documentos o autorizaciones, convenios, preparación antes de la cita, pagos',
    never: 'menú, cocina, domicilios, tallas ni envíos',
    roles: ['Profesionales de salud', 'Recepción y citas', 'Facturación', 'Asistentes', 'Administración'],
    pains: ['Agendar y reprogramar citas', 'Pacientes que no llegan', 'Responder requisitos', 'Recordatorios'],
  },
  EDUCACION: {
    key: 'EDUCACION', label: 'Cursos y educación', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'cursos o programas, fechas y cupos, requisitos, inscripción y pagos, certificados, modalidad presencial o virtual',
    never: 'menú, cocina, domicilios ni tallas',
    roles: ['Docentes o instructores', 'Inscripciones y ventas', 'Certificados', 'Coordinación académica', 'Administración'],
    pains: ['Responder fechas y precios', 'Inscribir y cobrar', 'Llenar los cupos', 'Recordar clases'],
  },
  INMOBILIARIA: {
    key: 'INMOBILIARIA', label: 'Inmobiliaria', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'arriendo o venta, zonas, presupuesto del cliente, visitas, documentos para estudio, comisiones',
    never: 'menú, cocina, domicilios ni tallas',
    roles: ['Asesores comerciales', 'Captación de inmuebles', 'Visitas', 'Contratos y documentos', 'Administración'],
    pains: ['Filtrar a los interesados', 'Agendar visitas', 'Responder por cada inmueble', 'Hacer seguimiento'],
  },
  TIENDA: {
    key: 'TIENDA', label: 'Tienda y comercio', shipping: 'CUALQUIERA', deny: ['menu', 'production'],
    ask: 'productos y precios, disponibilidad, envíos o recogida, garantías, medios de pago, ventas al por mayor',
    never: 'cocina, comandas ni tiempos de preparación',
    roles: ['Vendedores', 'Caja', 'Bodega e inventario', 'Envíos', 'Redes sociales', 'Administración'],
    pains: ['Responder precios y disponibilidad', 'Organizar pedidos', 'Cobrar', 'Hacer seguimiento a quien no compra'],
  },
  TALLER: {
    key: 'TALLER', label: 'Taller y servicio técnico', shipping: 'NINGUNO', deny: ['menu', 'delivery'],
    ask: 'servicios y diagnósticos, citas o recepción de equipos, tiempos de entrega, repuestos, garantías',
    never: 'menú, cocina ni tallas',
    roles: ['Técnicos', 'Recepción', 'Repuestos', 'Entregas', 'Administración'],
    pains: ['Dar estados de reparación', 'Agendar', 'Cotizar', 'Avisar cuando está listo'],
  },
  WEBCAM: {
    key: 'WEBCAM', label: 'Webcam y creadores', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'perfiles o modelos, contenido que vende, precios, plataformas, turnos',
    never: 'menú, cocina, domicilios, tallas ni envíos',
    roles: ['Modelos o creadores', 'Monitores', 'Chatters', 'Soporte técnico', 'Administración'],
    pains: ['Atender muchos chats a la vez', 'Vender contenido', 'Saber cuánto vende cada perfil'],
  },
  SERVICIOS: {
    key: 'SERVICIOS', label: 'Servicios', shipping: 'NINGUNO', deny: FOOD_TOOLS,
    ask: 'servicios y precios, citas o visitas, requisitos, anticipos, seguimiento después del servicio',
    never: 'menú, cocina, domicilios ni tallas',
    roles: ['Profesionales o técnicos', 'Agenda y atención', 'Ventas', 'Administración'],
    pains: ['Agendar', 'Cotizar', 'Responder lo mismo todo el día', 'Hacer seguimiento'],
  },
  GENERAL: {
    key: 'GENERAL', label: 'Negocio', shipping: 'CUALQUIERA', deny: ['menu', 'production'],
    ask: 'qué ofrece y a quién, cómo vende, cómo entrega o presta el servicio, cómo cobra',
    never: 'cosas de restaurante (menú, cocina, domicilios propios) si no las mencionó',
    roles: ['Ventas', 'Atención al cliente', 'Operación', 'Entregas', 'Redes sociales', 'Administración'],
    pains: ['Responder rápido', 'Organizar ventas', 'Cobrar', 'Hacer seguimiento'],
  },
};

const KEYWORDS: Record<Exclude<ProfileKey, 'GENERAL'>, string[]> = {
  ROPA: ['ropa', 'moda', 'prenda', 'vestido', 'camiseta', 'jean', 'boutique', 'confeccion', 'lenceria', 'pijama', 'calzado', 'zapato', 'tenis', 'blusa', 'marca de ropa', 'coleccion', 'tallas'],
  COMIDA: ['restaurante', 'almuerzo', 'comida', 'catering', 'pizza', 'hamburguesa', 'panaderia', 'cafe', 'cafeteria', 'cocina', 'corrientazo', 'postre', 'empanada', 'arepa', 'reposteria', 'tortas', 'asadero', 'heladeria', 'licores', 'bar$'],
  BELLEZA: ['salon', 'peluqueria', 'barberia', 'spa', 'unas', 'manicure', 'estetica', 'pestanas', 'cejas', 'maquillaje', 'depilacion'],
  SALUD: ['consultorio', 'clinica', 'odontolog', 'medico', 'psicolog', 'fisioterap', 'nutricion', 'optica', 'laboratorio', 'veterinari', 'ips', 'paciente'],
  EDUCACION: ['curso', 'colegio', 'academia', 'clases', 'capacitacion', 'diplomado', 'certificacion', 'alturas', 'idiomas', 'escuela', 'estudiantes'],
  INMOBILIARIA: ['inmobiliaria', 'apartamento', 'arriendo', 'finca raiz', 'inmueble', 'casas', 'lotes', 'propiedad horizontal'],
  TIENDA: ['tienda', 'accesorios', 'joyeria', 'distribuidora', 'ferreteria', 'papeleria', 'tecnologia', 'celulares', 'perfumeria', 'cosmeticos', 'muebles', 'productos', 'mayorista', 'importadora'],
  TALLER: ['taller', 'mecanica', 'reparacion', 'servicio tecnico', 'mantenimiento', 'motos', 'carros', 'lavadero'],
  WEBCAM: ['webcam', 'modelos webcam', 'creador de contenido', 'onlyfans', 'chaturbate', 'stripchat', 'estudio de modelos'],
  SERVICIOS: ['cita', 'asesoria', 'consultoria', 'abogado', 'contador', 'agencia', 'eventos', 'fotografia', 'limpieza', 'gimnasio', 'entrenador'],
};

function plain(text: string) {
  return ` ${String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')} `;
}

/** Perfil más probable; empata a favor de lo que dijo primero (su descripción). */
export function detectProfile(text: string, first = ''): BusinessProfile {
  const t = plain(text);
  const lead = plain(first);
  let best: ProfileKey = 'GENERAL';
  let bestScore = 0;
  for (const [key, words] of Object.entries(KEYWORDS) as Array<[ProfileKey, string[]]>) {
    const score = words.reduce((n, w) => {
      // "palabra$" = solo la palabra completa (bar ≠ barbería); si no, cuenta el comienzo (consultorio, consultorios)
      const whole = w.endsWith('$');
      const re = new RegExp(`\\b${w.replace(/\$$/, '').trim()}${whole ? '\\b' : ''}`);
      return n + (re.test(t) ? 1 : 0) + (re.test(lead) ? 2 : 0);
    }, 0);
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return PROFILES[best];
}

/** Perfil de una empresa ya creada (tipo de negocio + descripción del registro + rubro). */
export function profileOfCompany(ob: Record<string, any>, rubro?: Rubro | string | null): BusinessProfile {
  const text = [ob?.businessType, ob?.description, ob?.rubro].filter(Boolean).join(' ');
  const found = detectProfile(text, ob?.businessType ?? '');
  if (found.key !== 'GENERAL') return found;
  if (rubro === 'COMIDAS') return PROFILES.COMIDA;
  if (rubro === 'WEBCAM') return PROFILES.WEBCAM;
  if (rubro === 'SERVICIOS') return PROFILES.SERVICIOS;
  if (rubro === 'VENTAS') return PROFILES.TIENDA;
  return found;
}

/** Contexto corto para la IA de la entrevista (no gasta casi tokens). */
export function interviewHint(profile: BusinessProfile): string {
  if (profile.key === 'GENERAL') return 'Aún no es claro el tipo de negocio: pregunta lo justo para entenderlo y NO asumas que es un restaurante.';
  return (
    `Este negocio es: ${profile.label}. Pregunta y propón opciones SOLO sobre lo que le sirve: ${profile.ask}. ` +
    `NUNCA preguntes ni ofrezcas opciones sobre ${profile.never}. Las opciones deben sonar a SU negocio, no genéricas.`
  );
}

/** Quita del plano lo que no aplica al perfil (herramientas y domicilios de restaurante). */
export function fitToProfile<T extends { modules: string[] }>(
  bp: T,
  proposal: { delivery?: any } | null | undefined,
  profile: BusinessProfile,
  ownerText: string,
): T {
  const t = plain(ownerText);
  const ownCouriers = /domiciliario|mensajero|motorizado|nuestros domicilios|domicilios propios/.test(t);
  let modules = bp.modules.filter((m) => !profile.deny.includes(m));
  // Confección o taller propio sí usa "producción" aunque sea ropa
  if (profile.key === 'ROPA' && /confeccion|taller|fabric|produccion/.test(t) && bp.modules.includes('production')) modules = [...modules, 'production'];
  if (profile.shipping !== 'DOMICILIARIOS' && !ownCouriers) modules = modules.filter((m) => m !== 'delivery');
  if (proposal?.delivery && profile.shipping !== 'DOMICILIARIOS' && !ownCouriers) {
    // Envíos por transportadora: nada de tarifa por km ni tiempo de preparación
    proposal.delivery = { ...proposal.delivery, kind: 'SHIPPING', perKm: null, maxKm: null, prepMinutes: null };
  }
  return { ...bp, modules: [...new Set(modules)] };
}


/** Tamaños de equipo que se ofrecen en primeros pasos */
export const TEAM_SIZES = ['Solo yo', '2 a 3', '4 a 10', '11 a 25', 'Más de 25'];
/** Personas que se asumen por tamaño (para recomendar el plan) */
export const TEAM_SIZE_PEOPLE: Record<string, number> = { 'Solo yo': 1, '2 a 3': 3, '4 a 10': 8, '11 a 25': 18, 'Más de 25': 30 };
