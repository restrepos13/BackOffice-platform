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
 * El tour queda SIN ver en cada regeneración (arranca solo en la demo).
 */
import type { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/** Slug reservado de la empresa demo (protegido contra borrado). */
export const DEMO_COMPANY_SLUG = 'delicias-demo';

const PASSWORD = bcrypt.hashSync('Demo-Delicias-2026', 10);

const MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

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
  if (existing) await prisma.company.delete({ where: { id: existing.id } }); // cascada
  await prisma.user.deleteMany({ where: { email: { contains: '@deliciasandinas.co' } } });

  const growth = await prisma.plan.findUnique({ where: { code: 'growth' } });

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
        'inbox', 'contacts', 'orders', 'bots', 'automations', 'analytics', 'billing', 'team', 'marketing',
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
      }),
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
    { name: 'Almuerzo ejecutivo', category: 'Almuerzos', unit: 'porción', presentations: ['Bandeja sellada', 'Buffet x10'], areaId: cocina.id, description: 'Proteína + 2 acompañamientos + ensalada + jugo' },
    { name: 'Almuerzo vegetariano', category: 'Almuerzos', unit: 'porción', presentations: ['Bandeja sellada'], areaId: cocina.id, description: 'Menú sin proteína animal' },
    { name: 'Desayuno empresarial', category: 'Desayunos', unit: 'unidad', presentations: ['Caja individual'], areaId: cocina.id, description: 'Sándwich artesanal + fruta + café' },
    { name: 'Refrigerio AM/PM', category: 'Refrigerios', unit: 'unidad', presentations: ['Caja individual'], areaId: cocina.id, description: 'Producto de panadería + bebida' },
    { name: 'Estación de café', category: 'Bebidas', unit: 'servicio', presentations: ['Para 25 personas', 'Para 50 personas'], areaId: logistica.id, description: 'Café de origen, aromáticas e insumos' },
    { name: 'Tabla de quesos y frutas', category: 'Complementos', unit: 'tabla', presentations: ['x15 personas'], areaId: cocina.id, description: 'Quesos madurados + fruta de temporada' },
    { name: 'Coffee break completo', category: 'Eventos', unit: 'persona', presentations: ['Dulce y salado'], areaId: logistica.id, description: 'Estación dulce/salada con montaje' },
    { name: 'Cena de gala', category: 'Eventos', unit: 'porción', presentations: ['Servido a la mesa'], areaId: cocina.id, description: 'Menú de tres tiempos para eventos' },
  ];
  const products: Record<string, any> = {};
  for (const p of productsData) {
    products[p.name] = await prisma.product.create({
      data: {
        companyId: co.id, name: p.name, category: p.category, unit: p.unit,
        description: p.description, presentationsJson: JSON.stringify(p.presentations),
        productionAreaId: p.areaId,
      },
    });
  }

  /* ─── Clientes y contactos ─── */
  console.log('Clientes…');
  const customersData = [
    { key: 'bancolombia', name: 'Torre Empresarial Milla de Oro', taxId: '900111222-3', notes: 'Comité los lunes: desayuno para 18 personas fijo.', addresses: [{ label: 'Piso 12', address: 'Cra 43A # 1-50, torre 2', city: 'Medellín' }], contact: { name: 'Juliana Restrepo', phone: '+57 310 200 3001' } },
    { key: 'clinica', name: 'Clínica del Prado', taxId: '900333444-5', notes: 'Requieren 20% de opción vegetariana. Personal asistencial.', addresses: [{ label: 'Sede principal', address: 'Cl 19 # 44-25', city: 'Medellín' }], contact: { name: 'Andrés Cano', phone: '+57 311 200 3002' } },
    { key: 'coworking', name: 'Céntrico Coworking', taxId: '901555666-7', notes: 'Eventos variables: confirman número final un día antes.', addresses: [{ label: 'Rooftop', address: 'Cra 35 # 8A-40', city: 'Medellín' }], contact: { name: 'Sara Mejía', phone: '+57 312 200 3003' } },
    { key: 'constructora', name: 'Constructora del Norte', taxId: '901777888-9', notes: 'Facturan a fin de mes. Almuerzan 12:00 en punto.', addresses: [{ label: 'Obra El Poblado', address: 'Cl 10 # 43-15', city: 'Medellín' }, { label: 'Obra Bello', address: 'Autopista Norte km 4', city: 'Bello' }], contact: { name: 'Mauricio Zapata', phone: '+57 313 200 3004' } },
    { key: 'universidad', name: 'Corporación Universitaria Andes', taxId: '902999000-1', notes: 'Eventos académicos; pago contra factura electrónica.', addresses: [{ label: 'Auditorio principal', address: 'Cl 50 # 40-30', city: 'Medellín' }], contact: { name: 'Diana Torres', phone: '+57 314 200 3005' } },
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
      deliveryAt: at(0, 12, 30), takenBy: 'IA', confidence: 0.95,
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
  Datos: 9 pedidos (todos los estados), 4 conversaciones,
  5 clientes, feedback con testimonios, 30 días de consumo,
  marketing, agenda y reporte diario. Todo ficticio.
════════════════════════════════════════════════════════`);
}
