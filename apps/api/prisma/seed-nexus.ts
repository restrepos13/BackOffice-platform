/**
 * Seed de NEXUS (catering) — módulo de pedidos.
 * Crea (o recrea) el tenant "nexus" con datos realistas para probar el módulo:
 * catálogo, áreas de producción, empresas cliente, contactos, pedidos en varios
 * estados con trazabilidad, recordatorios y feedback.
 *
 * SOLO toca datos del tenant nexus — jamás otras organizaciones.
 * Correr: pnpm db:seed:nexus
 *
 * Acceso: admin@nexuscatering.co · SEED_PASSWORD_NEXUS (COMPANY_ADMIN)
 *         cocina@nexuscatering.co · SEED_PASSWORD_NEXUS (COMPANY_VIEWER por ahora;
 *         pasará a rol de área en la Fase 5)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PASSWORD = bcrypt.hashSync('SEED_PASSWORD_NEXUS', 10);

function at(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function main() {
  // ── Limpiar SOLO el tenant nexus (idempotente) ──
  const existing = await prisma.company.findUnique({ where: { slug: 'nexus' } });
  if (existing) {
    console.log('Recreando tenant nexus…');
    await prisma.company.delete({ where: { id: existing.id } }); // cascada
  }
  await prisma.user.deleteMany({ where: { email: { contains: '@nexuscatering.co' } } });

  const growth = await prisma.plan.findUnique({ where: { code: 'growth' } });

  console.log('Empresa Nexus…');
  const nexus = await prisma.company.create({
    data: {
      name: 'Nexus Catering',
      slug: 'nexus',
      legalName: 'Nexus Catering S.A.S.',
      industry: 'Catering / Alimentos al por mayor',
      country: 'Colombia',
      city: 'Bogotá',
      contactEmail: 'admin@nexuscatering.co', // ← reemplazar por el real
      contactPhone: '+57 300 000 0000', // ← reemplazar por el real
      status: 'ACTIVE',
      planId: growth?.id,
      timezone: 'America/Bogota',
      currency: 'COP',
      brandColor: '#1F4F7A',
      notes:
        'Primera empresa real. Catering B2B: ~10 empresas cliente, ~50 pedidos/mes. ' +
        'WhatsApp por Twilio (cuenta propia del cliente). Trazabilidad hasta despacho.',
      modulesJson: JSON.stringify([
        'inbox', 'contacts', 'orders', 'bots', 'automations', 'analytics', 'billing', 'team',
      ]),
      // Reglas de agenda del negocio — editables desde el panel (Fase 4/5)
      orderConfigJson: JSON.stringify({
        // Estados default del pedido (el flujo vendido)
        statuses: [
          'borrador', 'confirmado', 'programado', 'en_produccion', 'listo',
          'empacado', 'despachado', 'entregado', 'cancelado', 'requiere_atencion',
        ],
        schedule: { days: [1, 2, 3, 4, 5, 6], open: '06:00', close: '16:00' }, // lun–sáb
        orderCutoff: '14:00', // corte: pedidos hasta las 2 pm del día anterior
        minLeadHours: 18, // anticipación mínima
        maxPerSlot: 8, // capacidad máxima de entregas por franja
        slots: [
          { key: 'manana', label: 'Mañana', from: '06:00', to: '12:00' },
          { key: 'tarde', label: 'Tarde', from: '12:00', to: '16:00' },
        ],
        holidays: [], // festivos: se cargan desde el panel
        reminderDefaults: { areaHours: 24, dispatchHours: 3, clientSameDayHour: 7 },
        feedbackDelayHours: 3, // feedback al cliente 3 h después de entregado
      }),
      savingsSalaryUsd: 350,
      agentCapacityPerMonth: 250,
    },
  });

  console.log('Usuarios…');
  await prisma.user.create({
    data: {
      email: 'admin@nexuscatering.co', name: 'Administración Nexus',
      role: 'COMPANY_ADMIN', jobTitle: 'Gerencia', companyId: nexus.id,
      passwordHash: PASSWORD,
    },
  });

  console.log('Asistente IA y línea WhatsApp…');
  const bot = await prisma.bot.create({
    data: {
      companyId: nexus.id,
      name: 'Asistente Nexus',
      status: 'DRAFT', // se activa cuando el motor (Fase 2) esté conectado
      description: 'Toma pedidos de catering por WhatsApp sin sonar a bot.',
      provider: 'deepinfra',
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      temperature: 0.7,
      systemPrompt:
        'Eres quien atiende el WhatsApp de Nexus Catering (Bogotá). Atiendes a empresas ' +
        'que piden comida al por mayor con entregas programadas. Conversas natural, tomas ' +
        'el pedido completo (productos, cantidades, fecha/hora, dirección, observaciones), ' +
        'pides solo lo que falte, de a uno o dos datos, sin sonar a formulario. A clientes ' +
        'recurrentes no les preguntas lo que ya sabemos: "lo mismo del mes pasado pero para ' +
        '40" debe funcionar. Antes de cerrar, envías el resumen completo y esperas un sí ' +
        'explícito. Si no estás seguro de algo, NO inventas: confirmas con el cliente o ' +
        'escalas a una persona. Respetas horarios, cortes y anticipación mínima del negocio; ' +
        'si algo no cabe, propones alternativas. Jamás dices que eres una IA ni usas menús numerados.',
      personalityJson: JSON.stringify({
        tone: 'Español colombiano, informal pero profesional; tuteo',
        style: 'Mensajes cortos, a veces en varios envíos; sin emojis excesivos; nada de menús ni botones',
        limits: 'No inventar datos; sin confirmación explícita el pedido queda en borrador; incertidumbre → escalar',
        language: 'es-CO',
      }),
      welcomeMessage: '¡Hola! Bienvenido a Nexus 👋 ¿en qué te ayudo hoy?',
      handoffKeywords: 'queja, reclamo, factura, gerente, hablar con alguien',
      replyDelayMinSec: 6,
      replyDelayMaxSec: 40,
      typingSimulation: true,
      salesJson: JSON.stringify({
        goal: 'Cerrar el pedido completo y agendado; sugerir complementos solo si encajan.',
        style: 'Consultivo: primero resolver, después sugerir. Nunca presionar.',
        catalog: 'Catálogo de la organización (almuerzos, refrigerios, estaciones de café, frutas).',
        upsell: 'Si piden almuerzos para +30 personas, ofrecer estación de café una sola vez.',
        objections: 'Fuera de horario o sin anticipación: proponer la franja válida más cercana.',
      }),
    },
  });
  await prisma.integration.create({
    data: {
      companyId: nexus.id,
      botId: bot.id,
      type: 'WHATSAPP',
      name: 'Línea Pedidos Nexus',
      status: 'DISCONNECTED', // se conecta en Fase 3 con las credenciales Twilio de Nexus
      promptMode: 'INHERIT',
      // Proveedor Twilio (cuenta del cliente). Credenciales reales van CIFRADAS
      // en la Fase 3 — aquí solo la forma esperada:
      configJson: JSON.stringify({
        provider: 'TWILIO',
        accountSid: '', // ← Nexus
        authTokenEncrypted: '', // ← se cifra al guardarse desde el panel
        fromNumber: '', // ← número de WhatsApp de Nexus
      }),
      webhookUrl: 'http://localhost:4001/api/webhooks/nexus/twilio', // se implementa en Fase 3
    },
  });

  console.log('Áreas de producción…');
  const [cocina, empaque, logistica, despacho] = await Promise.all(
    [
      {
        name: 'Cocina', description: 'Producción de alimentos',
        responsiblesJson: JSON.stringify([{ name: 'Jefe de cocina', phone: '+57 300 000 0001' }]),
        notifyChannel: 'WHATSAPP', notifyTarget: '+57 300 000 0001',
        reminderHoursBefore: 24,
      },
      {
        name: 'Empaque', description: 'Porcionado y empaque',
        responsiblesJson: JSON.stringify([{ name: 'Coordinación de empaque' }]),
        notifyChannel: 'PANEL', reminderHoursBefore: 12,
      },
      {
        name: 'Logística', description: 'Rutas y programación de entregas',
        responsiblesJson: JSON.stringify([{ name: 'Coordinación logística', phone: '+57 300 000 0002' }]),
        notifyChannel: 'WHATSAPP', notifyTarget: '+57 300 000 0002',
        reminderHoursBefore: 12,
      },
      {
        name: 'Despacho', description: 'Salida de pedidos',
        responsiblesJson: JSON.stringify([{ name: 'Encargado de despacho', phone: '+57 300 000 0003' }]),
        notifyChannel: 'WHATSAPP', notifyTarget: '+57 300 000 0003',
        reminderHoursBefore: 3,
      },
    ].map((area) => prisma.productionArea.create({ data: { companyId: nexus.id, ...area } })),
  );
  const cocinaUser = await prisma.user.create({
    data: {
      email: 'cocina@nexuscatering.co', name: 'Cocina Nexus',
      role: 'COMPANY_VIEWER', jobTitle: 'Área de cocina', companyId: nexus.id,
      productionAreaId: cocina.id, passwordHash: PASSWORD,
    },
  });

  console.log('Catálogo…');
  const productos = await Promise.all(
    [
      {
        name: 'Almuerzo ejecutivo', category: 'Almuerzos', unit: 'porción',
        description: 'Proteína + 2 acompañamientos + ensalada + jugo',
        presentationsJson: JSON.stringify([
          { name: 'Individual (bandeja sellada)' }, { name: 'Buffet por 10' },
        ]),
        productionAreaId: cocina.id,
      },
      {
        name: 'Refrigerio AM', category: 'Refrigerios', unit: 'unidad',
        description: 'Sándwich o wrap + fruta + bebida',
        presentationsJson: JSON.stringify([{ name: 'Caja individual' }]),
        productionAreaId: cocina.id,
      },
      {
        name: 'Refrigerio PM', category: 'Refrigerios', unit: 'unidad',
        description: 'Producto de panadería + bebida caliente o fría',
        presentationsJson: JSON.stringify([{ name: 'Caja individual' }]),
        productionAreaId: cocina.id,
      },
      {
        name: 'Estación de café', category: 'Bebidas', unit: 'servicio',
        description: 'Café, aromática, vasos e insumos para X personas',
        presentationsJson: JSON.stringify([
          { name: 'Para 20 personas' }, { name: 'Para 50 personas' },
        ]),
        productionAreaId: logistica.id,
      },
      {
        name: 'Bandeja de frutas', category: 'Complementos', unit: 'bandeja',
        description: 'Fruta picada de temporada',
        presentationsJson: JSON.stringify([{ name: 'Bandeja x15 porciones' }]),
        productionAreaId: cocina.id,
      },
      {
        name: 'Almuerzo vegetariano', category: 'Almuerzos', unit: 'porción',
        description: 'Menú sin proteína animal',
        presentationsJson: JSON.stringify([{ name: 'Individual (bandeja sellada)' }]),
        productionAreaId: cocina.id,
      },
    ].map((producto) => prisma.product.create({ data: { companyId: nexus.id, ...producto } })),
  );
  const [almuerzo, refrigerioAM, , estacionCafe, bandejaFrutas, vegetariano] = productos;

  console.log('Empresas cliente y contactos…');
  const constructora = await prisma.customer.create({
    data: {
      companyId: nexus.id, name: 'Constructora Andina S.A.S.', taxId: '900123456-7',
      addressesJson: JSON.stringify([
        { label: 'Obra Salitre', address: 'Av. 68 # 24-50', city: 'Bogotá', instructions: 'Entregar en portería de obra, preguntar por almacén' },
        { label: 'Oficina principal', address: 'Cra 15 # 93-60 piso 4', city: 'Bogotá', instructions: '' },
      ]),
      notes: 'Facturan a fin de mes. El personal de obra almuerza a las 12:00 en punto.',
    },
  });
  const clinica = await prisma.customer.create({
    data: {
      companyId: nexus.id, name: 'Clínica Santa Fe del Norte', taxId: '900987654-3',
      addressesJson: JSON.stringify([
        { label: 'Sede norte', address: 'Calle 127 # 19-30', city: 'Bogotá', instructions: 'Recepción de insumos por sótano 1, antes de 11:30' },
      ]),
      notes: 'Requieren opción vegetariana siempre (mínimo 10%). Personal asistencial.',
    },
  });
  const techhub = await prisma.customer.create({
    data: {
      companyId: nexus.id, name: 'TechHub Coworking', taxId: '901222333-1',
      addressesJson: JSON.stringify([
        { label: 'Sede única', address: 'Cra 11 # 84-20', city: 'Bogotá', instructions: 'Dejar en cafetería del piso 2' },
      ]),
      notes: 'Eventos variables: confirman número final el día anterior.',
    },
  });

  const [marta, andres, lucia] = await Promise.all([
    prisma.contact.create({
      data: {
        companyId: nexus.id, customerId: constructora.id,
        name: 'Marta Ruiz (Constructora Andina)', phone: '+57 310 555 0101',
        channel: 'WHATSAPP', stage: 'CLIENTE',
        tagsJson: JSON.stringify(['compras', 'recurrente']),
        notes: 'Encargada de compras. Pide siempre para la obra Salitre.',
      },
    }),
    prisma.contact.create({
      data: {
        companyId: nexus.id, customerId: clinica.id,
        name: 'Andrés Peña (Clínica Santa Fe)', phone: '+57 311 555 0202',
        channel: 'WHATSAPP', stage: 'CLIENTE',
        tagsJson: JSON.stringify(['servicios generales']),
      },
    }),
    prisma.contact.create({
      data: {
        companyId: nexus.id, customerId: techhub.id,
        name: 'Lucía Gómez (TechHub)', phone: '+57 312 555 0303',
        channel: 'WHATSAPP', stage: 'CLIENTE',
        tagsJson: JSON.stringify(['eventos']),
      },
    }),
  ]);

  console.log('Pedidos de ejemplo…');
  const addr = (customer: { addressesJson: string }, index = 0) =>
    JSON.stringify(JSON.parse(customer.addressesJson)[index]);

  // Pedido 1: confirmado y programado para pasado mañana (flujo típico IA)
  const pedido1 = await prisma.order.create({
    data: {
      companyId: nexus.id, customerId: constructora.id, contactId: marta.id,
      status: 'programado', deliveryAt: at(2, 11, 30),
      deliveryAddressJson: addr(constructora),
      observations: 'Personal de obra: entregar 11:30 máx. Incluir 5 vegetarianos.',
      takenByType: 'IA', aiConfidence: 0.96,
      items: {
        create: [
          {
            companyId: nexus.id, productId: almuerzo.id, productName: 'Almuerzo ejecutivo',
            quantity: 45, unit: 'porción', presentation: 'Individual (bandeja sellada)',
            productionAreaId: cocina.id,
          },
          {
            companyId: nexus.id, productId: vegetariano.id, productName: 'Almuerzo vegetariano',
            quantity: 5, unit: 'porción', presentation: 'Individual (bandeja sellada)',
            productionAreaId: cocina.id,
          },
        ],
      },
    },
  });
  for (const [from, to, minsAgo] of [
    [null, 'borrador', 300], ['borrador', 'confirmado', 240], ['confirmado', 'programado', 180],
  ] as const) {
    await prisma.orderStatusHistory.create({
      data: {
        companyId: nexus.id, orderId: pedido1.id,
        fromStatus: from, toStatus: to,
        authorType: to === 'programado' ? 'SISTEMA' : 'IA',
        authorName: to === 'programado' ? 'Agenda automática' : 'Asistente Nexus',
        reason: to === 'confirmado' ? 'Cliente confirmó el resumen por WhatsApp' : undefined,
        createdAt: new Date(Date.now() - minsAgo * 60000),
      },
    });
  }
  await prisma.reminder.createMany({
    data: [
      {
        companyId: nexus.id, orderId: pedido1.id, kind: 'AREA',
        recipientJson: JSON.stringify({ name: 'Jefe de cocina', phone: '+57 300 000 0001', productionAreaId: cocina.id }),
        channel: 'WHATSAPP', scheduledAt: at(1, 11, 30), templateKey: 'recordatorio_area',
      },
      {
        companyId: nexus.id, orderId: pedido1.id, kind: 'DESPACHO',
        recipientJson: JSON.stringify({ name: 'Encargado de despacho', phone: '+57 300 000 0003' }),
        channel: 'WHATSAPP', scheduledAt: at(2, 8, 30), templateKey: 'recordatorio_despacho',
      },
      {
        companyId: nexus.id, orderId: pedido1.id, kind: 'CLIENTE',
        recipientJson: JSON.stringify({ name: marta.name, phone: marta.phone }),
        channel: 'WHATSAPP', scheduledAt: at(2, 7, 0), templateKey: 'recordatorio_cliente',
      },
    ],
  });

  // Pedido 2: en producción para mañana (clínica, con vegetarianos)
  const pedido2 = await prisma.order.create({
    data: {
      companyId: nexus.id, customerId: clinica.id, contactId: andres.id,
      status: 'en_produccion', deliveryAt: at(1, 11, 0),
      deliveryAddressJson: addr(clinica),
      observations: 'Sótano 1 antes de 11:30. 4 vegetarianos incluidos.',
      takenByType: 'IA', aiConfidence: 0.92,
      items: {
        create: [
          {
            companyId: nexus.id, productId: almuerzo.id, productName: 'Almuerzo ejecutivo',
            quantity: 36, unit: 'porción', presentation: 'Individual (bandeja sellada)',
            productionAreaId: cocina.id,
          },
          {
            companyId: nexus.id, productId: vegetariano.id, productName: 'Almuerzo vegetariano',
            quantity: 4, unit: 'porción', productionAreaId: cocina.id,
          },
          {
            companyId: nexus.id, productId: bandejaFrutas.id, productName: 'Bandeja de frutas',
            quantity: 2, unit: 'bandeja', presentation: 'Bandeja x15 porciones',
            productionAreaId: cocina.id,
          },
        ],
      },
    },
  });
  for (const [from, to, hrs] of [
    [null, 'borrador', 30], ['borrador', 'confirmado', 28], ['confirmado', 'programado', 27],
    ['programado', 'en_produccion', 3],
  ] as const) {
    await prisma.orderStatusHistory.create({
      data: {
        companyId: nexus.id, orderId: pedido2.id, fromStatus: from, toStatus: to,
        authorType: to === 'en_produccion' ? 'USUARIO' : 'IA',
        authorName: to === 'en_produccion' ? 'Administración Nexus' : 'Asistente Nexus',
        createdAt: new Date(Date.now() - hrs * 3600000),
      },
    });
  }

  // Pedido 3: entregado la semana pasada, con feedback positivo
  const pedido3 = await prisma.order.create({
    data: {
      companyId: nexus.id, customerId: techhub.id, contactId: lucia.id,
      status: 'entregado', deliveryAt: at(-6, 9, 0),
      deliveryAddressJson: addr(techhub),
      observations: 'Evento de 30 personas.',
      takenByType: 'IA', aiConfidence: 0.97,
      items: {
        create: [
          {
            companyId: nexus.id, productId: refrigerioAM.id, productName: 'Refrigerio AM',
            quantity: 30, unit: 'unidad', presentation: 'Caja individual',
            productionAreaId: cocina.id, areaStatus: 'lista', areaReadyAt: at(-6, 6, 30),
          },
          {
            companyId: nexus.id, productId: estacionCafe.id, productName: 'Estación de café',
            quantity: 1, unit: 'servicio', presentation: 'Para 50 personas',
            productionAreaId: logistica.id, areaStatus: 'lista', areaReadyAt: at(-6, 7, 0),
          },
        ],
      },
    },
  });
  const flujo3 = [
    'borrador', 'confirmado', 'programado', 'en_produccion', 'listo', 'empacado', 'despachado', 'entregado',
  ];
  for (let i = 0; i < flujo3.length; i++) {
    await prisma.orderStatusHistory.create({
      data: {
        companyId: nexus.id, orderId: pedido3.id,
        fromStatus: i === 0 ? null : flujo3[i - 1], toStatus: flujo3[i],
        authorType: i < 3 ? 'IA' : i === flujo3.length - 1 ? 'USUARIO' : 'SISTEMA',
        authorName: i < 3 ? 'Asistente Nexus' : i === flujo3.length - 1 ? 'Administración Nexus' : 'Flujo automático',
        createdAt: new Date(at(-6, 9, 0).getTime() - (flujo3.length - i) * 3 * 3600000),
      },
    });
  }
  await prisma.feedback.create({
    data: {
      companyId: nexus.id, orderId: pedido3.id, customerId: techhub.id, contactId: lucia.id,
      requestedAt: at(-6, 12, 0), respondedAt: at(-6, 14, 20),
      rating: 5, comment: 'Todo llegó a tiempo y la estación de café fue un éxito. ¡Gracias!',
      sentiment: 'POSITIVO', status: 'RESPONDIDO',
    },
  });

  // Pedido 4: requiere atención (información contradictoria → escalado)
  const pedido4 = await prisma.order.create({
    data: {
      companyId: nexus.id, customerId: constructora.id, contactId: marta.id,
      status: 'requiere_atencion', deliveryAt: at(3, 12, 0),
      deliveryAddressJson: addr(constructora, 1),
      observations:
        'ESCALADO: el cliente pidió "lo mismo del mes pasado" pero cambió la sede y la cantidad no coincide con el histórico. Confirmar con Marta.',
      takenByType: 'IA', aiConfidence: 0.55,
      items: {
        create: [
          {
            companyId: nexus.id, productId: almuerzo.id, productName: 'Almuerzo ejecutivo',
            quantity: 60, unit: 'porción', productionAreaId: cocina.id,
            observations: 'Cantidad por confirmar (histórico: 45-50)',
          },
        ],
      },
    },
  });
  await prisma.orderStatusHistory.createMany({
    data: [
      {
        companyId: nexus.id, orderId: pedido4.id, fromStatus: null, toStatus: 'borrador',
        authorType: 'IA', authorName: 'Asistente Nexus',
        createdAt: new Date(Date.now() - 90 * 60000),
      },
      {
        companyId: nexus.id, orderId: pedido4.id, fromStatus: 'borrador', toStatus: 'requiere_atencion',
        authorType: 'IA', authorName: 'Asistente Nexus',
        reason: 'Confianza 0.55 < umbral 0.8: dirección distinta al histórico y cantidad inusual',
        createdAt: new Date(Date.now() - 85 * 60000),
      },
    ],
  });

  const counts = {
    áreas: await prisma.productionArea.count({ where: { companyId: nexus.id } }),
    productos: await prisma.product.count({ where: { companyId: nexus.id } }),
    clientes: await prisma.customer.count({ where: { companyId: nexus.id } }),
    pedidos: await prisma.order.count({ where: { companyId: nexus.id } }),
    trazas: await prisma.orderStatusHistory.count({ where: { companyId: nexus.id } }),
    recordatorios: await prisma.reminder.count({ where: { companyId: nexus.id } }),
  };
  console.log('Nexus listo ✅', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
