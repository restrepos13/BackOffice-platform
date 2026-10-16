/**
 * EMPRESA DEMO PERMANENTE — "Delicias Andinas" (catering FICTICIO, Medellín).
 * Es la vitrina de ventas: SIEMPRE debe existir en producción con datos
 * frescos. Esta función es idempotente (borra y recrea SOLO el tenant
 * delicias-demo) y la usan:
 *   1. El script pnpm db:seed:demo-empresa (siembra manual).
 *   2. Un cron semanal (jobs.module) que la regenera con fechas al día.
 *   3. El botón "Restaurar empresa demo" de Dev Tools → Operación.
 * La empresa está PROTEGIDA contra borrado desde el panel (companies.remove).
 *
 * Acceso demo:
 *   demo@deliciasandinas.co    · Demo-Delicias-2026  (COMPANY_ADMIN)
 *   cocina@deliciasandinas.co  · Demo-Delicias-2026  (COMPANY_AREA)
 *   andres@deliciasandinas.co  · Demo-Delicias-2026  (COMPANY_COURIER, en ruta)
 * El tour queda SIN ver en cada regeneración (arranca solo en la demo).
 */
import type { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { quoteDelivery } from '../common/geo';
import { newTrackingToken } from '../common/tracking';
import { deleteCompanyLooseData } from '../common/company-cleanup';
import { AGENT_PRESETS } from '../ai/agent/tools';

/** Slug reservado de la empresa demo (protegido contra borrado). */
export const DEMO_COMPANY_SLUG = 'delicias-demo';

const PASSWORD = bcrypt.hashSync('Demo-Delicias-2026', 10);

const MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

/** Cocina en Laureles: punto de despacho de los domicilios demo. */
const KITCHEN = { lat: 6.2446, lng: -75.5958, address: 'Cra 76 # 33-40, Laureles, Medellín' };

const DELIVERY_CONFIG = {
  enabled: true,
  origin: KITCHEN,
  maxKm: 14,
  baseFee: 4000,
  perKm: 900,
  minFee: 5000,
  freeFromSubtotal: 500000,
  prepMinutes: 30,
  avgSpeedKmh: 22,
  autoAssign: true,
  delayAlertMinutes: 10,
  unassignedAlertMinutes: 15,
  notifyDelayToCustomer: true,
};

function at(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/** Próximo día hábil (lun-sáb) a la hora dada, con ≥2 días de margen. */
function nextBusinessDay(offset: number, hour: number, minute = 0): Date {
  const d = at(offset, hour, minute);
  while (d.getDay() === 0) d.setDate(d.getDate() + 1);
  return d;
}

export async function seedDemoCompany(prisma: PrismaClient) {
  console.log('Recreando tenant delicias-demo…');
  const existing = await prisma.company.findUnique({ where: { slug: DEMO_COMPANY_SLUG } });
  if (existing) {
    // Lo que no cuelga de la empresa por relación (GPS, promos…) se limpia aparte
    await deleteCompanyLooseData(prisma, existing.id);
    await prisma.company.delete({ where: { id: existing.id } }); // cascada
  }
  await prisma.user.deleteMany({ where: { email: { contains: '@deliciasandinas.co' } } });

  // Línea Negocios (COP); si los precios aún no se sembraron, cae al plan Pro
  const growth = (await prisma.plan.findUnique({ where: { code: 'negocios-negocio' } }))
    ?? (await prisma.plan.findUnique({ where: { code: 'growth' } }));

  /* ─── Empresa ─── */
  const co = await prisma.company.create({
    data: {
      name: 'Delicias Andinas',
      slug: DEMO_COMPANY_SLUG,
      legalName: 'Delicias Andinas S.A.S. (DEMO)',
      industry: 'Catering corporativo',
      country: 'Colombia',
      city: 'Medellín',
      website: 'https://demo.deliciasandinas.co',
      contactEmail: 'demo@deliciasandinas.co',
      contactPhone: '+57 300 111 2233',
      status: 'ACTIVE',
      planId: growth?.id,
      timezone: 'America/Bogota',
      currency: 'COP',
      brandColor: '#3E5C3A', // verde oliva — identidad propia en correos y PDFs
      notes: 'EMPRESA DEMO para mostrar la plataforma a prospectos. Datos 100% ficticios.',
      modulesJson: JSON.stringify([
        'inbox', 'contacts', 'orders', 'delivery', 'bots', 'automations', 'analytics', 'billing', 'team', 'marketing',
      ]),
      orderConfigJson: JSON.stringify({
        schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '17:00' },
        orderCutoff: '15:00',
        minLeadHours: 16,
        maxPerSlot: 10,
        slots: [
          { key: 'manana', label: 'Mañana', from: '06:00', to: '12:00' },
          { key: 'tarde', label: 'Tarde', from: '12:00', to: '17:00' },
        ],
        holidays: [],
        reminderDefaults: { areaHours: 24, dispatchHours: 3, clientSameDayHour: 7 },
        feedbackDelayHours: 3,
        aiConfidenceThreshold: 0.8,
        knowledgeBase: [
          { question: '¿Cómo se paga?', answer: 'Transferencia o consignación; empresas con convenio pagan a 15 días con factura electrónica.' },
          { question: '¿Tienen opciones vegetarianas?', answer: 'Sí: todo menú puede incluir hasta un 100% de opciones vegetarianas o veganas, sin costo adicional.' },
          { question: '¿Cuál es el pedido mínimo?', answer: '10 unidades por producto para entregas en el Valle de Aburrá.' },
        ],
        dailyReport: { hour: 6, channel: 'PANEL' },
        delivery: DELIVERY_CONFIG,
        menu: { enabled: true, title: 'Menú corporativo', note: 'Pedidos con 16 horas de anticipación · Lun a sáb · Valle de Aburrá', whatsappPhone: '573001112233' },
        reviewMessage: '¡Gracias por elegirnos! Si te gustó, una reseña en Google nos ayuda muchísimo: {{link}}',
        followUps: [
          { id: 'borrador', enabled: true, when: 'draft_open', afterHours: 2, message: '¿Seguimos con tu pedido? Si quieres te lo dejo confirmado en un minuto.' },
        ],
      }),
      googleReviewUrl: 'https://g.page/r/delicias-andinas-demo/review',
      paymentConfigJson: JSON.stringify({
        provider: 'WOMPI', env: 'test', acceptCash: true,
        manualInstructions: 'Nequi 300 111 2233 o Bancolombia ahorros 000-000000-00 a nombre de Delicias Andinas SAS (DEMO). Envía la foto del comprobante por aquí.',
      }),
      einvoiceConfigJson: JSON.stringify({ provider: 'SIMULADO', taxRate: 0.08 }),
      savingsSalaryUsd: 400,
      agentCapacityPerMonth: 300,
    },
  });

  /* ─── Usuarios demo ─── */
  console.log('Usuarios…');
  await prisma.user.create({
    data: {
      email: 'demo@deliciasandinas.co', name: 'Carolina Díaz',
      role: 'COMPANY_ADMIN', jobTitle: 'Gerente general', companyId: co.id,
      passwordHash: PASSWORD, // tour SIN ver: arranca solo en la demo
    },
  });

  /* ─── Bot + línea ─── */
  console.log('Asistente IA y línea…');
  const bot = await prisma.bot.create({
    data: {
      companyId: co.id,
      name: 'Valentina',
      status: 'ACTIVE',
      description: 'Toma pedidos de catering por WhatsApp, con memoria de cada cliente.',
      provider: 'deepinfra',
      model: MODEL,
      temperature: 0.7,
      systemPrompt:
        'Eres Valentina, quien atiende el WhatsApp de Delicias Andinas (Medellín). ' +
        'Tomas pedidos de catering corporativo conversando natural: productos, cantidades, ' +
        'fecha/hora, dirección y observaciones. A clientes recurrentes no les preguntas lo ' +
        'que ya sabemos. Antes de cerrar envías el resumen completo y esperas un sí explícito. ' +
        'Si dudas, escalas a una persona. Jamás dices que eres una IA.',
      personalityJson: JSON.stringify({
        tone: 'Paisa cálido y profesional; tuteo',
        style: 'Mensajes cortos, cero formularios',
        limits: 'Sin confirmación explícita el pedido queda en borrador',
        language: 'es-CO',
      }),
      welcomeMessage: '¡Hola! Soy Valentina de Delicias Andinas 😊 ¿en qué te ayudo?',
      handoffKeywords: 'queja, reclamo, gerente, factura',
      replyDelayMinSec: 5,
      replyDelayMaxSec: 35,
      typingSimulation: true,
      salesJson: JSON.stringify({
        goal: 'Cerrar el pedido completo y agendado; sugerir complementos cuando encajen.',
        style: 'Consultivo, cero presión.',
        upsell: 'En pedidos de +30 almuerzos, ofrecer estación de café una sola vez.',
      }),
    },
  });
  const line = await prisma.integration.create({
    data: {
      companyId: co.id,
      botId: bot.id,
      type: 'WHATSAPP',
      name: 'Línea Pedidos Delicias',
      status: 'CONNECTED',
      promptMode: 'INHERIT',
      configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }),
      webhookUrl: 'http://localhost:4001/api/webhooks/delicias-demo/twilio',
    },
  });

  // Segundo asistente: AGENTE con herramientas para domicilios del día
  const deliveryBot = await prisma.bot.create({
    data: {
      companyId: co.id,
      name: 'Tomás · Domicilios',
      status: 'ACTIVE',
      description: 'Agente con herramientas: menú con precios, envío por ubicación, pedidos y seguimiento en vivo.',
      provider: 'deepinfra',
      model: MODEL,
      temperature: 0.4,
      engineMode: 'AGENT',
      toolsJson: JSON.stringify(AGENT_PRESETS.domicilios.tools),
      systemPrompt:
        'Eres Tomás y atiendes los domicilios de almuerzos de Delicias Andinas en Medellín. ' +
        'Ayudas a pedir el almuerzo del día: muestras el menú con precios, calculas el domicilio ' +
        'con la ubicación del cliente, confirmas y compartes el link para seguir el pedido en vivo.',
      personalityJson: JSON.stringify({
        tone: 'Paisa cercano y ágil; tuteo',
        style: 'Mensajes cortos, directo al grano',
        limits: 'Nunca confirmes sin un sí explícito del cliente',
        language: 'es-CO',
      }),
      welcomeMessage: '¡Hola! Soy Tomás de Delicias Andinas, ¿qué se te antoja hoy?',
      handoffKeywords: 'queja, reclamo, gerente',
      replyDelayMinSec: 2,
      replyDelayMaxSec: 10,
      typingSimulation: true,
      salesJson: JSON.stringify({
        goal: 'Cerrar el pedido del almuerzo en pocos mensajes.',
        upsell: 'Ofrecer jugo o refrigerio una sola vez si el pedido no lo trae.',
      }),
    },
  });
  await prisma.integration.create({
    data: {
      companyId: co.id,
      botId: deliveryBot.id,
      type: 'WHATSAPP',
      name: 'Línea Domicilios Delicias',
      status: 'CONNECTED',
      promptMode: 'INHERIT',
      configJson: JSON.stringify({ provider: 'TWILIO', sandbox: true }),
      webhookUrl: 'http://localhost:4001/api/webhooks/delicias-demo/twilio',
    },
  });

  /* ─── Domiciliarios ─── */
  console.log('Domiciliarios…');
  const andres = await prisma.user.create({
    data: {
      email: 'andres@deliciasandinas.co', name: 'Andrés Gómez',
      role: 'COMPANY_COURIER', jobTitle: 'Domiciliario', companyId: co.id,
      phone: '+57 315 400 1001', passwordHash: PASSWORD,
      onShift: true, lastLat: 6.2369, lastLng: -75.5852, lastLocAt: new Date(),
    },
  });
  await prisma.user.create({
    data: {
      email: 'luisa@deliciasandinas.co', name: 'Luisa Fernanda Ríos',
      role: 'COMPANY_COURIER', jobTitle: 'Domiciliaria', companyId: co.id,
      phone: '+57 315 400 1002', passwordHash: PASSWORD, onShift: false,
    },
  });
  // Rastro GPS de Andrés: de la cocina hacia la Clínica del Prado
  const trail = [
    [6.2446, -75.5958], [6.2433, -75.5931], [6.2419, -75.5905], [6.2404, -75.5887],
    [6.2391, -75.5872], [6.2380, -75.5862], [6.2369, -75.5852],
  ];
  await prisma.courierPing.createMany({
    data: trail.map(([lat, lng], i) => ({
      companyId: co.id, userId: andres.id, lat, lng, accuracy: 12,
      createdAt: new Date(Date.now() - (trail.length - i) * 90_000),
    })),
  });

  /* ─── Áreas ─── */
  console.log('Áreas…');
  const [cocina, , logistica, despacho] = await Promise.all(
    [
      { name: 'Cocina', description: 'Producción de alimentos', notifyChannel: 'PANEL', reminderHoursBefore: 24 },
      { name: 'Empaque', description: 'Porcionado y presentación', notifyChannel: 'PANEL', reminderHoursBefore: 12 },
      { name: 'Logística', description: 'Montaje y estaciones', notifyChannel: 'PANEL', reminderHoursBefore: 12 },
      { name: 'Despacho', description: 'Rutas y entregas', notifyChannel: 'PANEL', reminderHoursBefore: 3 },
    ].map((a) =>
      prisma.productionArea.create({
        data: { companyId: co.id, responsiblesJson: '[]', ...a },
      }),
    ),
  );
  // Usuario de área (vista de cocina para la demo)
  await prisma.user.create({
    data: {
      email: 'cocina@deliciasandinas.co', name: 'Equipo Cocina',
      role: 'COMPANY_AREA', jobTitle: 'Cocina', companyId: co.id,
      productionAreaId: cocina.id, passwordHash: PASSWORD,
    },
  });

  /* ─── Catálogo ─── */
  console.log('Catálogo…');
  const productsData = [
    { name: 'Almuerzo ejecutivo', category: 'Almuerzos', unit: 'porción', price: 18000, presentations: ['Bandeja sellada', 'Buffet x10'], areaId: cocina.id, description: 'Proteína + 2 acompañamientos + ensalada + jugo' },
    { name: 'Almuerzo vegetariano', category: 'Almuerzos', unit: 'porción', price: 18000, presentations: ['Bandeja sellada'], areaId: cocina.id, description: 'Menú sin proteína animal' },
    { name: 'Desayuno empresarial', category: 'Desayunos', unit: 'unidad', price: 14000, presentations: ['Caja individual'], areaId: cocina.id, description: 'Sándwich artesanal + fruta + café' },
    { name: 'Refrigerio AM/PM', category: 'Refrigerios', unit: 'unidad', price: 7500, presentations: ['Caja individual'], areaId: cocina.id, description: 'Producto de panadería + bebida' },
    { name: 'Estación de café', category: 'Bebidas', unit: 'servicio', price: 180000, presentations: ['Para 25 personas', 'Para 50 personas'], areaId: logistica.id, description: 'Café de origen, aromáticas e insumos' },
    { name: 'Tabla de quesos y frutas', category: 'Complementos', unit: 'tabla', price: 95000, presentations: ['x15 personas'], areaId: cocina.id, description: 'Quesos madurados + fruta de temporada' },
    { name: 'Coffee break completo', category: 'Eventos', unit: 'persona', price: 16000, presentations: ['Dulce y salado'], areaId: logistica.id, description: 'Estación dulce/salada con montaje' },
    { name: 'Cena de gala', category: 'Eventos', unit: 'porción', price: 65000, presentations: ['Servido a la mesa'], areaId: cocina.id, description: 'Menú de tres tiempos para eventos' },
  ];
  const products: Record<string, any> = {};
  for (const p of productsData) {
    products[p.name] = await prisma.product.create({
      data: {
        companyId: co.id, name: p.name, category: p.category, unit: p.unit,
        description: p.description, presentationsJson: JSON.stringify(p.presentations),
        productionAreaId: p.areaId, price: p.price,
      },
    });
  }

  /* ─── Clientes y contactos ─── */
  console.log('Clientes…');
  const customersData = [
    { key: 'bancolombia', name: 'Torre Empresarial Milla de Oro', taxId: '900111222-3', notes: 'Comité los lunes: desayuno para 18 personas fijo.', addresses: [{ label: 'Piso 12', address: 'Cra 43A # 1-50, torre 2', city: 'Medellín', lat: 6.2097, lng: -75.5703 }], contact: { name: 'Juliana Restrepo', phone: '+57 310 200 3001' } },
    { key: 'clinica', name: 'Clínica del Prado', taxId: '900333444-5', notes: 'Requieren 20% de opción vegetariana. Personal asistencial.', addresses: [{ label: 'Sede principal', address: 'Cl 19 # 44-25', city: 'Medellín', lat: 6.2316, lng: -75.5741 }], contact: { name: 'Andrés Cano', phone: '+57 311 200 3002' } },
    { key: 'coworking', name: 'Céntrico Coworking', taxId: '901555666-7', notes: 'Eventos variables: confirman número final un día antes.', addresses: [{ label: 'Rooftop', address: 'Cra 35 # 8A-40', city: 'Medellín', lat: 6.2120, lng: -75.5600 }], contact: { name: 'Sara Mejía', phone: '+57 312 200 3003' } },
    { key: 'constructora', name: 'Constructora del Norte', taxId: '901777888-9', notes: 'Facturan a fin de mes. Almuerzan 12:00 en punto.', addresses: [{ label: 'Obra El Poblado', address: 'Cl 10 # 43-15', city: 'Medellín', lat: 6.2077, lng: -75.5692 }, { label: 'Obra Bello', address: 'Autopista Norte km 4', city: 'Bello', lat: 6.3389, lng: -75.5579 }], contact: { name: 'Mauricio Zapata', phone: '+57 313 200 3004' } },
    { key: 'universidad', name: 'Corporación Universitaria Andes', taxId: '902999000-1', notes: 'Eventos académicos; pago contra factura electrónica.', addresses: [{ label: 'Auditorio principal', address: 'Cl 50 # 40-30', city: 'Medellín', lat: 6.2480, lng: -75.5560 }], contact: { name: 'Diana Torres', phone: '+57 314 200 3005' } },
  ];
  const customers: Record<string, { customer: any; contact: any }> = {};
  for (const c of customersData) {
    const customer = await prisma.customer.create({
      data: {
        companyId: co.id, name: c.name, taxId: c.taxId, notes: c.notes,
        addressesJson: JSON.stringify(c.addresses),
      },
    });
    const contact = await prisma.contact.create({
      data: {
        companyId: co.id, customerId: customer.id, name: c.contact.name,
        phone: c.contact.phone, channel: 'WHATSAPP', stage: 'CLIENTE',
        lastActivityAt: at(-1, 15),
      },
    });
    customers[c.key] = { customer, contact };
  }

  /* ─── Pedidos en TODOS los estados (con trazabilidad) ─── */
  console.log('Pedidos…');
  interface OrderSpec {
    key: string; customer: string; status: string; deliveryAt: Date;
    addressIdx?: number; takenBy?: 'IA' | 'HUMANO'; confidence?: number;
    corrected?: boolean; observations?: string;
    items: Array<{ product: string; qty: number; spec?: string; ready?: boolean }>;
    feedback?: { rating: number; comment: string; daysAgo: number };
    /** Domicilio: lo lleva Andrés (y minutos para llegar si va en ruta) */
    courier?: boolean;
    etaMinutes?: number;
    history: Array<{ to: string; by?: string; type?: 'IA' | 'USUARIO' | 'SISTEMA'; reason?: string; daysAgo: number; hour: number }>;
  }
  const orders: OrderSpec[] = [
    {
      key: 'entregado5', customer: 'bancolombia', status: 'entregado',
      deliveryAt: at(-6, 7, 30), takenBy: 'IA', confidence: 0.96,
      items: [{ product: 'Desayuno empresarial', qty: 18, ready: true }],
      feedback: { rating: 5, comment: 'Todo llegó puntual y delicioso. El comité quedó feliz. ¡Gracias Valentina!', daysAgo: 6 },
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 8, hour: 9 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 8, hour: 9 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 8, hour: 9 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 7, hour: 5 },
        { to: 'listo', type: 'SISTEMA', reason: 'Todas las áreas listas', daysAgo: 6, hour: 6 },
        { to: 'empacado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 6, hour: 6 },
        { to: 'despachado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 6, hour: 7 },
        { to: 'entregado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 6, hour: 8 },
      ],
    },
    {
      key: 'entregado4', customer: 'coworking', status: 'entregado',
      deliveryAt: at(-3, 16), takenBy: 'IA', confidence: 0.91,
      items: [
        { product: 'Coffee break completo', qty: 45, ready: true },
        { product: 'Tabla de quesos y frutas', qty: 3, ready: true },
      ],
      feedback: { rating: 4, comment: 'Muy buen montaje del coffee break. Solo faltaron algunos vasos.', daysAgo: 3 },
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 5, hour: 11 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 5, hour: 11 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 5, hour: 11 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 4, hour: 8 },
        { to: 'listo', type: 'SISTEMA', daysAgo: 3, hour: 13 },
        { to: 'empacado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 3, hour: 14 },
        { to: 'despachado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 3, hour: 15 },
        { to: 'entregado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 3, hour: 16 },
      ],
    },
    {
      key: 'entregado2', customer: 'constructora', status: 'entregado',
      deliveryAt: at(-2, 12), takenBy: 'IA', confidence: 0.93,
      items: [{ product: 'Almuerzo ejecutivo', qty: 60, spec: '10 vegetarianos', ready: true }],
      feedback: { rating: 2, comment: 'Llegó 40 minutos tarde y la obra almuerza a las 12 en punto.', daysAgo: 2 },
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 4, hour: 10 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 4, hour: 10 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 4, hour: 10 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 2, hour: 6 },
        { to: 'listo', type: 'SISTEMA', daysAgo: 2, hour: 10 },
        { to: 'empacado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 2, hour: 11 },
        { to: 'despachado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 2, hour: 11 },
        { to: 'entregado', by: 'Carolina Díaz', type: 'USUARIO', reason: 'Entrega con retraso por cierre vial', daysAgo: 2, hour: 12 },
      ],
    },
    {
      key: 'despachado', customer: 'clinica', status: 'despachado',
      deliveryAt: at(0, 12, 30), takenBy: 'IA', confidence: 0.95, courier: true, etaMinutes: 9,
      items: [
        { product: 'Almuerzo ejecutivo', qty: 36, ready: true },
        { product: 'Almuerzo vegetariano', qty: 9, ready: true },
      ],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 2, hour: 14 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 2, hour: 14 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 2, hour: 14 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 0, hour: 6 },
        { to: 'listo', type: 'SISTEMA', daysAgo: 0, hour: 10 },
        { to: 'empacado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 0, hour: 11 },
        { to: 'despachado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 0, hour: 11 },
      ],
    },
    {
      key: 'produccion', customer: 'universidad', status: 'en_produccion',
      deliveryAt: nextBusinessDay(1, 9), takenBy: 'IA', confidence: 0.9,
      observations: 'Congreso académico — montar 30 min antes en el auditorio.',
      items: [
        { product: 'Coffee break completo', qty: 120 },
        { product: 'Estación de café', qty: 2, spec: 'Para 50 personas c/u' },
      ],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 3, hour: 16 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 3, hour: 16 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 3, hour: 16 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 0, hour: 7 },
      ],
    },
    {
      key: 'programado', customer: 'bancolombia', status: 'programado',
      deliveryAt: nextBusinessDay(2, 7, 30), takenBy: 'IA', confidence: 0.97,
      observations: '"Lo mismo de todos los lunes" — cliente recurrente.',
      items: [{ product: 'Desayuno empresarial', qty: 18 }],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 1, hour: 10 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 1, hour: 10 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 1, hour: 10 },
      ],
    },
    {
      key: 'listoDomicilio', customer: 'coworking', status: 'listo',
      deliveryAt: new Date(Date.now() + 45 * 60e3), takenBy: 'IA', confidence: 0.94, courier: true,
      observations: 'Domicilio del día: dejar en recepción del rooftop.',
      items: [
        { product: 'Almuerzo ejecutivo', qty: 6, ready: true },
        { product: 'Almuerzo vegetariano', qty: 2, ready: true },
      ],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 0, hour: 10 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 0, hour: 10 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 0, hour: 10 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 0, hour: 10 },
        { to: 'listo', type: 'SISTEMA', reason: 'Todas las áreas listas', daysAgo: 0, hour: 11 },
      ],
    },
    {
      key: 'entregadoHoy', customer: 'bancolombia', status: 'entregado',
      deliveryAt: at(0, 9), takenBy: 'IA', confidence: 0.97, courier: true,
      items: [{ product: 'Refrigerio AM/PM', qty: 12, ready: true }],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 1, hour: 17 },
        { to: 'confirmado', type: 'IA', reason: 'Cliente confirmó el resumen', daysAgo: 1, hour: 17 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 1, hour: 17 },
        { to: 'en_produccion', by: 'Equipo Cocina', type: 'USUARIO', daysAgo: 0, hour: 7 },
        { to: 'listo', type: 'SISTEMA', daysAgo: 0, hour: 8 },
        { to: 'empacado', by: 'Andrés Gómez', type: 'USUARIO', daysAgo: 0, hour: 8 },
        { to: 'despachado', by: 'Andrés Gómez', type: 'USUARIO', daysAgo: 0, hour: 8 },
        { to: 'entregado', by: 'Andrés Gómez', type: 'USUARIO', reason: 'Entregado', daysAgo: 0, hour: 9 },
      ],
    },
    {
      key: 'manual', customer: 'constructora', status: 'programado',
      deliveryAt: nextBusinessDay(3, 12), addressIdx: 1,
      takenBy: 'HUMANO',
      observations: 'Pedido tomado por teléfono — obra nueva en Bello.',
      items: [{ product: 'Almuerzo ejecutivo', qty: 45, spec: 'Sin fríjoles (petición del maestro de obra)' }],
      history: [
        { to: 'borrador', by: 'Carolina Díaz', type: 'USUARIO', reason: 'Creado manualmente desde el panel', daysAgo: 1, hour: 15 },
        { to: 'confirmado', by: 'Carolina Díaz', type: 'USUARIO', daysAgo: 1, hour: 15 },
        { to: 'programado', type: 'SISTEMA', reason: 'Agenda automática', daysAgo: 1, hour: 15 },
      ],
    },
    {
      key: 'atencion', customer: 'coworking', status: 'requiere_atencion',
      deliveryAt: nextBusinessDay(2, 18), takenBy: 'IA', confidence: 0.55, corrected: true,
      observations: 'ESCALADO: el cliente pidió para "el evento del jueves" pero mencionó dos horas distintas (6 pm y 8 pm). Confirmar con Sara.',
      items: [{ product: 'Cena de gala', qty: 80 }],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 0, hour: 9 },
        { to: 'requiere_atencion', type: 'IA', reason: 'Confianza 0.55 < umbral 0.8: horas contradictorias', daysAgo: 0, hour: 9 },
      ],
    },
    {
      key: 'borrador', customer: 'universidad', status: 'borrador',
      deliveryAt: nextBusinessDay(4, 10), takenBy: 'IA', confidence: 0.88,
      items: [{ product: 'Refrigerio AM/PM', qty: 200 }],
      history: [{ to: 'borrador', type: 'IA', daysAgo: 0, hour: 11 }],
    },
    {
      key: 'cancelado', customer: 'clinica', status: 'cancelado',
      deliveryAt: at(-1, 12), takenBy: 'IA', confidence: 0.94,
      items: [{ product: 'Almuerzo ejecutivo', qty: 20 }],
      history: [
        { to: 'borrador', type: 'IA', daysAgo: 3, hour: 9 },
        { to: 'confirmado', type: 'IA', daysAgo: 3, hour: 9 },
        { to: 'programado', type: 'SISTEMA', daysAgo: 3, hour: 9 },
        { to: 'cancelado', by: 'Carolina Díaz', type: 'USUARIO', reason: 'El cliente reprogramó su jornada', daysAgo: 1, hour: 8 },
      ],
    },
  ];

  const orderIds: Record<string, string> = {};
  for (const spec of orders) {
    const { customer, contact } = customers[spec.customer];
    const addresses = JSON.parse(customer.addressesJson);
    const address = addresses[spec.addressIdx ?? 0];
    const subtotal = spec.items.reduce((sum, item) => sum + (products[item.product].price ?? 0) * item.qty, 0);
    const quote = quoteDelivery(DELIVERY_CONFIG, address, subtotal);
    const deliveryFee = quote.covered ? quote.fee : null;
    const lastStep = spec.history[spec.history.length - 1];
    const order = await prisma.order.create({
      data: {
        companyId: co.id,
        customerId: customer.id,
        contactId: contact.id,
        status: spec.status,
        deliveryAt: spec.deliveryAt,
        deliveryAddressJson: JSON.stringify(address),
        observations: spec.observations,
        takenByType: spec.takenBy ?? 'IA',
        takenByName: spec.takenBy === 'HUMANO' ? 'Carolina Díaz' : null,
        aiConfidence: spec.takenBy === 'HUMANO' ? null : spec.confidence,
        correctedAfterAi: spec.corrected ?? false,
        subtotal,
        deliveryFee,
        total: subtotal + (deliveryFee ?? 0),
        distanceKm: quote.km,
        ...(spec.status !== 'borrador' ? { trackingToken: newTrackingToken() } : {}),
        ...(spec.courier ? { courierId: andres.id } : {}),
        ...(spec.etaMinutes ? { etaAt: new Date(Date.now() + spec.etaMinutes * 60e3), dispatchedAt: new Date(Date.now() - 18 * 60e3) } : {}),
        ...(spec.status === 'entregado' ? { deliveredAt: at(-lastStep.daysAgo, lastStep.hour) } : {}),
        createdAt: at(-spec.history[0].daysAgo, spec.history[0].hour),
      },
    });
    orderIds[spec.key] = order.id;
    for (const item of spec.items) {
      const product = products[item.product];
      await prisma.orderItem.create({
        data: {
          companyId: co.id, orderId: order.id,
          productId: product.id, productName: product.name,
          quantity: item.qty, unit: product.unit,
          specifications: item.spec ?? null,
          productionAreaId: product.productionAreaId,
          areaStatus: item.ready ? 'listo' : 'pendiente',
          ...(item.ready ? { areaReadyAt: at(-1, 12) } : {}),
        },
      });
    }
    let prev: string | null = null;
    for (const h of spec.history) {
      await prisma.orderStatusHistory.create({
        data: {
          companyId: co.id, orderId: order.id,
          fromStatus: prev, toStatus: h.to,
          authorType: h.type ?? 'USUARIO',
          authorName: h.by ?? (h.type === 'IA' ? 'Valentina (IA)' : h.type === 'SISTEMA' ? 'Agenda automática' : 'Carolina Díaz'),
          reason: h.reason,
          createdAt: at(-h.daysAgo, h.hour),
        },
      });
      prev = h.to;
    }
    if (spec.feedback) {
      await prisma.feedback.create({
        data: {
          companyId: co.id, orderId: order.id,
          customerId: customer.id, contactId: contact.id,
          requestedAt: at(-spec.feedback.daysAgo, 15),
          respondedAt: at(-spec.feedback.daysAgo, 16),
          rating: spec.feedback.rating,
          comment: spec.feedback.comment,
          sentiment: spec.feedback.rating >= 4 ? 'POSITIVO' : spec.feedback.rating === 3 ? 'NEUTRO' : 'NEGATIVO',
          alerted: spec.feedback.rating <= 3,
          status: 'RESPONDIDO',
        },
      });
    }
  }

  /* ─── Recordatorios ─── */
  console.log('Recordatorios…');
  const reminderRows = [
    { orderKey: 'programado', kind: 'AREA', status: 'PENDIENTE', scheduledAt: nextBusinessDay(1, 7, 30), body: 'Recordatorio: 18 × Desayuno empresarial para Torre Milla de Oro — entrega mañana 7:30.' },
    { orderKey: 'programado', kind: 'CLIENTE', status: 'PENDIENTE', scheduledAt: nextBusinessDay(2, 7), body: 'Hola Juliana, te confirmamos tu entrega de hoy a las 7:30: 18 desayunos. ¡Quedamos atentos!' },
    { orderKey: 'produccion', kind: 'DESPACHO', status: 'ENVIADO', scheduledAt: at(0, 6), body: 'Despacho mañana 9:00 — Corporación Andes: 120 coffee break + 2 estaciones. Auditorio principal.' },
    { orderKey: 'despachado', kind: 'CLIENTE', status: 'ENVIADO', scheduledAt: at(0, 7), body: 'Hola Andrés, hoy a las 12:30 llegan tus 45 almuerzos. ¡Buen día!' },
  ];
  for (const r of reminderRows) {
    await prisma.reminder.create({
      data: {
        companyId: co.id, orderId: orderIds[r.orderKey], kind: r.kind,
        recipientJson: JSON.stringify({ name: 'Demo' }),
        channel: r.kind === 'CLIENTE' ? 'WHATSAPP' : 'PANEL',
        scheduledAt: r.scheduledAt, templateKey: 'demo',
        bodyRendered: r.body, status: r.status,
        ...(r.status === 'ENVIADO' ? { sentAt: r.scheduledAt } : {}),
      },
    });
  }

  /* ─── Conversaciones: la IA conversando + humano interviniendo ─── */
  console.log('Conversaciones…');
  async function conversation(
    key: string,
    opts: { status: string; needsAttention?: boolean; botPaused?: boolean; attendedBy?: string; customerKey: string; orderKey?: string; lastDaysAgo: number; lastHour: number },
    messages: Array<{ dir: 'IN' | 'OUT'; by?: 'BOT' | 'AGENT'; name?: string; text: string; minutesOffset: number; category?: string }>,
  ) {
    const { customer, contact } = customers[opts.customerKey];
    const base = at(-opts.lastDaysAgo, opts.lastHour);
    const convo = await prisma.conversation.create({
      data: {
        companyId: co.id, contactId: contact.id, customerId: customer.id,
        integrationId: line.id, botId: bot.id, channel: 'WHATSAPP',
        status: opts.status, needsAttention: opts.needsAttention ?? false,
        botPaused: opts.botPaused ?? false, attendedByName: opts.attendedBy ?? null,
        lastMessageAt: new Date(base.getTime() + messages[messages.length - 1].minutesOffset * 60e3),
        aiStateJson: '{}',
      },
    });
    for (const m of messages) {
      await prisma.message.create({
        data: {
          conversationId: convo.id,
          direction: m.dir,
          author: m.dir === 'IN' ? 'CONTACT' : (m.by ?? 'BOT'),
          authorName: m.name ?? null,
          content: m.text,
          type: 'TEXT',
          ...(m.dir === 'OUT'
            ? { deliveryStatus: 'READ', metaCategory: m.category ?? 'SERVICIO', metaCostUsd: m.category === 'UTILIDAD' ? 0.008 : 0 }
            : {}),
          createdAt: new Date(base.getTime() + m.minutesOffset * 60e3),
        },
      });
    }
    if (opts.orderKey) {
      await prisma.order.update({
        where: { id: orderIds[opts.orderKey] },
        data: { conversationId: convo.id },
      });
    }
    return convo;
  }

  // 1) Pedido completo tomado por la IA (cliente recurrente)
  await conversation('recurrente', { status: 'RESOLVED', customerKey: 'bancolombia', orderKey: 'programado', lastDaysAgo: 1, lastHour: 10 }, [
    { dir: 'IN', text: 'Hola Valentina! Para el lunes lo mismo de siempre porfa', minutesOffset: 0 },
    { dir: 'OUT', text: '¡Hola Juliana! 😊 Claro que sí: 18 desayunos empresariales para el lunes 7:30 am en el piso 12, ¿cierto?', minutesOffset: 1 },
    { dir: 'IN', text: 'Exacto', minutesOffset: 3 },
    { dir: 'OUT', text: 'Listo, te confirmo: 18 × Desayuno empresarial, lunes 7:30 am, Cra 43A # 1-50 torre 2 piso 12. ¿Confirmamos?', minutesOffset: 4 },
    { dir: 'IN', text: 'Confirmado, gracias!', minutesOffset: 6 },
    { dir: 'OUT', text: '¡Quedó agendado! El lunes a las 7 te escribo para confirmarte la salida. Buen fin de semana 🙌', minutesOffset: 7 },
  ]);

  // 2) Escalada: la IA dudó y pidió ayuda humana (needsAttention)
  await conversation('escalada', { status: 'OPEN', needsAttention: true, botPaused: true, customerKey: 'coworking', orderKey: 'atencion', lastDaysAgo: 0, lastHour: 9 }, [
    { dir: 'IN', text: 'Necesito 80 cenas de gala para el evento del jueves a las 6', minutesOffset: 0 },
    { dir: 'OUT', text: '¡Hola Sara! Con gusto. ¿El evento arranca a las 6 pm y la cena se sirve a esa hora, o más tarde?', minutesOffset: 1 },
    { dir: 'IN', text: 'El evento es a las 6 pero la cena a las 8... aunque déjame confirmar, puede que la movamos', minutesOffset: 4 },
    { dir: 'OUT', text: 'Tranquila, dejo el pedido anotado y una compañera del equipo te confirma la hora en un momento para no equivocarnos 😊', minutesOffset: 5 },
  ]);

  // 3) Humano interviniendo (modo humano visible en la demo)
  await conversation('humano', { status: 'HANDOFF', botPaused: true, attendedBy: 'Carolina Díaz', customerKey: 'constructora', lastDaysAgo: 0, lastHour: 14 }, [
    { dir: 'IN', text: 'Buenas, con quién hablo para un convenio de almuerzos mensual? Somos como 45 en la obra', minutesOffset: 0 },
    { dir: 'OUT', text: '¡Hola Mauricio! Qué buena noticia 😊 Para convenios mensuales te paso con Carolina, nuestra gerente. Un momento.', minutesOffset: 1 },
    { dir: 'OUT', by: 'AGENT', name: 'Carolina Díaz', text: 'Hola Mauricio, soy Carolina, la gerente. Para 45 almuerzos diarios te armo una propuesta con tarifa de convenio. ¿Te la envío hoy al correo?', minutesOffset: 8 },
    { dir: 'IN', text: 'Perfecto, al correo de la constructora. Gracias!', minutesOffset: 12 },
  ]);

  // 4) FAQ resuelta por la IA (base de conocimiento)
  await conversation('faq', { status: 'RESOLVED', customerKey: 'universidad', lastDaysAgo: 2, lastHour: 17 }, [
    { dir: 'IN', text: 'Hola, ¿ustedes manejan opciones vegetarianas? ¿Y cuál es el mínimo de pedido?', minutesOffset: 0 },
    { dir: 'OUT', text: '¡Hola Diana! Sí: todo menú puede ser hasta 100% vegetariano o vegano sin costo adicional. Y el mínimo son 10 unidades por producto en el Valle de Aburrá 😊 ¿Te cotizo algo?', minutesOffset: 1 },
    { dir: 'IN', text: 'Por ahora era eso, gracias!', minutesOffset: 5 },
    { dir: 'OUT', text: '¡Con gusto! Aquí estoy cuando quieras armar el pedido 🙌', minutesOffset: 6 },
  ]);

  /* ─── Consumo de IA (30 días, curva creciente) ─── */
  console.log('Consumo IA…');
  const usage: any[] = [];
  for (let day = 29; day >= 0; day--) {
    const events = Math.max(2, Math.round(3 + (29 - day) * 0.4 + (Math.sin(day) + 1) * 2));
    for (let i = 0; i < events; i++) {
      const inputTokens = 700 + Math.round(Math.random() * 900);
      const outputTokens = 90 + Math.round(Math.random() * 160);
      usage.push({
        companyId: co.id, integrationId: line.id, botId: bot.id, model: MODEL,
        inputTokens, outputTokens,
        costUsd: Math.round(((inputTokens * 0.23 + outputTokens * 0.4) / 1_000_000) * 1e6) / 1e6,
        createdAt: at(-day, 8 + (i % 9)),
      });
    }
  }
  await prisma.aiUsageEvent.createMany({ data: usage });

  /* ─── Marketing: campaña + piezas ─── */
  console.log('Marketing…');
  const campaign = await prisma.marketingCampaign.create({
    data: {
      companyId: co.id,
      name: 'Temporada de eventos de fin de año',
      objective: 'Llenar la agenda de diciembre con eventos corporativos',
      status: 'ACTIVA',
      channelsJson: JSON.stringify(['instagram', 'tiktok']),
      startsAt: at(-10, 0),
      endsAt: at(50, 0),
      budgetUsd: 300,
      notes: 'Enfoque: cenas de gala y coffee breaks para fiestas de empresa.',
    },
  });
  const pieces = [
    {
      type: 'REEL', status: 'LISTO', channel: 'instagram',
      title: 'El secreto de un coffee break que la gente SÍ recuerda',
      brief: 'Mostrar el montaje del coffee break del auditorio',
      copy: 'Un evento se olvida. Un buen café con el montaje perfecto, no. ☕ Agenda tu coffee break de fin de año antes de que se llene diciembre. Escríbenos.',
      hashtags: ['#catering', '#medellin', '#eventoscorporativos', '#coffeebreak'],
      script: 'Hola, ¿sabías que el 80% de la gente recuerda más el café del evento que las diapositivas? En Delicias Andinas montamos estaciones que se roban el show…',
    },
    {
      type: 'POST', status: 'PUBLICADO', channel: 'instagram',
      title: 'Testimonio Torre Milla de Oro',
      copy: '"Todo llegó puntual y delicioso. El comité quedó feliz." — Así arrancan los lunes nuestros clientes. Desayunos empresariales con entrega programada. 📦',
      hashtags: ['#desayunosempresariales', '#medellin'],
      publishedDaysAgo: 4,
    },
    {
      type: 'STORY', status: 'PROGRAMADO', channel: 'instagram',
      title: 'Detrás de cámaras: cocina a las 5 am',
      copy: 'Mientras Medellín duerme, la cocina ya está a mil. 🔥 Desliza para ver cómo salen 120 coffee breaks.',
      hashtags: ['#detrasdecamaras'],
      scheduledDays: 1,
    },
    {
      type: 'AD', status: 'BORRADOR', channel: 'facebook',
      title: 'Campaña cenas de gala diciembre',
      brief: 'Anuncio para gerentes de RRHH: cena de gala de fin de año sin estrés',
    },
  ];
  for (const p of pieces) {
    await prisma.contentPiece.create({
      data: {
        companyId: co.id, campaignId: campaign.id,
        type: p.type, status: p.status, channel: p.channel,
        title: p.title, brief: p.brief ?? null, copy: p.copy ?? null,
        script: (p as any).script ?? null,
        hashtagsJson: JSON.stringify(p.hashtags ?? []),
        scheduledAt: (p as any).scheduledDays ? at((p as any).scheduledDays, 18) : null,
        publishedAt: (p as any).publishedDaysAgo ? at(-(p as any).publishedDaysAgo, 18) : null,
      },
    });
  }

  /* ─── Agenda: citas y seguimientos ─── */
  console.log('Agenda…');
  await prisma.appointment.createMany({
    data: [
      {
        companyId: co.id, contactId: customers.universidad.contact.id,
        title: 'Degustación menú congreso', location: 'Planta Delicias Andinas',
        startsAt: nextBusinessDay(2, 15), durationMin: 60,
        status: 'CONFIRMED', source: 'IA', createdBy: 'Valentina (IA)',
        notes: 'Traen 3 personas del comité organizador.',
      },
      {
        companyId: co.id, contactId: customers.constructora.contact.id,
        title: 'Visita obra Bello — convenio mensual', location: 'Autopista Norte km 4',
        startsAt: nextBusinessDay(3, 10), durationMin: 45,
        status: 'SCHEDULED', source: 'MANUAL', createdBy: 'Carolina Díaz',
      },
    ],
  });
  await prisma.followUp.createMany({
    data: [
      {
        companyId: co.id, contactId: customers.coworking.contact.id,
        note: 'Confirmar hora definitiva de la cena de gala (6 u 8 pm)',
        dueAt: at(0, 17), status: 'PENDING', createdBy: 'Carolina Díaz',
      },
      {
        companyId: co.id, contactId: customers.constructora.contact.id,
        note: 'Enviar propuesta de convenio mensual (45 almuerzos/día)',
        dueAt: nextBusinessDay(1, 9), status: 'PENDING', createdBy: 'Carolina Díaz',
      },
    ],
  });

  /* ─── Crecimiento: promociones, respuestas rápidas, sucursal ─── */
  await prisma.promotion.createMany({
    data: [
      {
        companyId: co.id, name: 'Primer pedido -10%', code: 'BIENVENIDO10', kind: 'PERCENT', value: 10,
        description: '10% en tu primer pedido corporativo', minSubtotal: 150000, productIdsJson: '[]', public: true, active: true,
      },
      {
        companyId: co.id, name: 'Domicilio gratis en coffee breaks', code: null, kind: 'FREE_DELIVERY', value: 0,
        description: 'Coffee breaks desde $400.000 llevan el domicilio gratis',
        minSubtotal: 400000, productIdsJson: JSON.stringify([products['Coffee break completo'].id]), public: true, active: true,
      },
    ],
  });
  await prisma.quickReply.createMany({
    data: [
      { companyId: co.id, shortcut: 'horario', title: 'Horario', body: 'Hola {nombre}, atendemos de lunes a sábado de 6 a. m. a 5 p. m. Pedidos con 16 horas de anticipación.' },
      { companyId: co.id, shortcut: 'pago', title: 'Medios de pago', body: 'Puedes pagar por Nequi 300 111 2233 o Bancolombia (DEMO). Envíanos la foto del comprobante por aquí.' },
      { companyId: co.id, shortcut: 'minimo', title: 'Pedido mínimo', body: 'El pedido mínimo es de 10 unidades por producto en el Valle de Aburrá.' },
    ],
  });
  await prisma.branch.create({
    data: { companyId: co.id, name: 'Sede El Poblado', address: 'Cl 10 # 43D-30, El Poblado, Medellín', lat: 6.2087, lng: -75.5678, phone: '+57 300 111 2234', active: true },
  });
  await prisma.product.update({
    where: { id: products['Cena de gala'].id },
    data: { soldOut: true, soldOutUntil: at(0, 23, 59) },
  });

  /* ─── Reporte diario de ayer (guardado en el panel) ─── */
  await prisma.dailyReport.create({
    data: {
      companyId: co.id,
      date: new Intl.DateTimeFormat('en-CA').format(at(-1, 12)),
      channel: 'PANEL',
      sentAt: at(0, 6),
      dataJson: JSON.stringify({ note: 'Generado por el job diario (demo)' }),
    },
  });

  console.log(`
════════════════════════════════════════════════════════
  EMPRESA DEMO LISTA — Delicias Andinas (delicias-demo)
  demo@deliciasandinas.co    · Demo-Delicias-2026  (admin)
  cocina@deliciasandinas.co  · Demo-Delicias-2026  (área)
  andres@deliciasandinas.co  · Demo-Delicias-2026  (domiciliario)
  Datos: 11 pedidos (todos los estados), domicilios en vivo, 4 conversaciones,
  5 clientes, feedback con testimonios, 30 días de consumo,
  marketing, agenda, reporte diario, promos, menú QR (/m/delicias-demo),
  respuestas rápidas, sucursal y factura simulada. Todo ficticio.
════════════════════════════════════════════════════════`);
}
