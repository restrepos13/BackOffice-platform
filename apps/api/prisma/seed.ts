/**
 * Seed de PRODUCCIÓN — BackOffice Platform.
 * Deja la plataforma vacía y lista para operar: planes, catálogo de modelos,
 * biblioteca de personalidades, settings, el equipo BackOffice y UNA empresa
 * de prueba vacía para revisar la vista de cliente.
 *
 * ⚠️ BORRA TODO lo existente. El seed con datos demo quedó en
 * prisma/seed-demo.ts (`pnpm db:seed:demo`).
 * ⚠️ Si se corre, la empresa DEMO de ventas ("Delicias Andinas") también se
 * borra: recréala con `pnpm db:seed:demo-empresa` (o el cron del domingo /
 * Dev Tools → Operación → "Restaurar empresa demo" la reviven solos).
 *
 * Cuentas:
 *   santiago@backoffice.dev      → SUPER_ADMIN · SEED_PASSWORD_SANTIAGO
 *   daniel@backoffice.dev        → SUPER_ADMIN · SEED_PASSWORD_DANIEL
 *   restrepos591@gmail.com       → DEV         · SEED_PASSWORD_DEV_SANTIAGO
 *   danielloaiza609@gmail.com    → DEV         · SEED_PASSWORD_DEV_DANIEL
 *   admin@empresa-prueba.com     → COMPANY_ADMIN (Empresa de Prueba) · SEED_PASSWORD_EMPRESA_PRUEBA
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { seedPassword } from './seed-passwords';

const prisma = new PrismaClient();
const hash = (plain: string) => bcrypt.hashSync(plain, 10);

async function main() {
  console.log('Limpiando base…');
  await prisma.$transaction([
    prisma.message.deleteMany(),
    prisma.conversation.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.automationRun.deleteMany(),
    prisma.automation.deleteMany(),
    prisma.integration.deleteMany(),
    prisma.bot.deleteMany(),
    prisma.usageRecord.deleteMany(),
    prisma.invoice.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.apiKey.deleteMany(),
    prisma.personaTemplate.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.emailMessage.deleteMany(),
    prisma.mediaAsset.deleteMany(),
    prisma.aiUsageEvent.deleteMany(),
    prisma.aiModel.deleteMany(),
    prisma.user.deleteMany(),
    prisma.company.deleteMany(),
    prisma.plan.deleteMany(),
    prisma.platformSetting.deleteMany(),
  ]);

  console.log('Planes…');
  const growth = await prisma.plan.create({
    data: {
      code: 'growth', name: 'Growth', priceMonthly: 599, highlight: true,
      maxBots: 30, maxWorkspaces: 1, maxUsers: 15,
      featuresJson: JSON.stringify([
        'Hasta 30 perfiles/modelos', 'Analytics por modelo',
        'Supervisión de conversaciones', 'Reglas de personalidad y roles de equipo',
        'Respuestas sugeridas y exportación de datos', 'Soporte prioritario',
      ]),
    },
  });
  await prisma.plan.createMany({
    data: [
      {
        code: 'starter', name: 'Starter', priceMonthly: 299,
        maxBots: 10, maxWorkspaces: 1, maxUsers: 5,
        featuresJson: JSON.stringify([
          'Hasta 10 perfiles/modelos', '1 workspace', 'Panel de agencia completo',
          'Personalidad individual + memoria', 'Historial de conversaciones',
          'Métricas básicas y onboarding inicial',
        ]),
      },
      {
        code: 'scale', name: 'Scale', priceMonthly: 999,
        maxBots: 75, maxWorkspaces: 3, maxUsers: 40,
        featuresJson: JSON.stringify([
          'Hasta 75 perfiles/modelos', '3 workspaces',
          'Analytics avanzado + reportes operativos', 'Auditoría y trazabilidad completa',
          'API, webhooks e integraciones avanzadas', 'Onboarding y migración asistida',
        ]),
      },
      {
        code: 'enterprise', name: 'Enterprise', priceMonthly: 0, isCustom: true,
        maxBots: 999, maxWorkspaces: 99, maxUsers: 999,
        featuresJson: JSON.stringify([
          '100+ modelos', 'Límites personalizados', 'SSO', 'Permisos avanzados',
          'SLA', 'Integraciones privadas', 'Aislamiento dedicado opcional',
        ]),
      },
    ],
  });

  console.log('Catálogo de modelos IA (DeepInfra)…');
  // Precios de REFERENCIA (USD por 1M tokens) — actualizar contra deepinfra.com/pricing
  await prisma.aiModel.createMany({
    data: [
      {
        modelId: 'meta-llama/Llama-3.3-70B-Instruct', name: 'Llama 3.3 70B',
        inputCostPerMTok: 0.23, outputCostPerMTok: 0.4, contextK: 128,
        recommended: true,
        notes: 'El caballo de batalla: calidad alta a costo bajo. Ideal para chatters y ventas.',
      },
      {
        modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B',
        inputCostPerMTok: 0.03, outputCostPerMTok: 0.05, contextK: 128,
        notes: 'Ultra económico: respuestas simples, calificación de leads, alto volumen.',
      },
      {
        modelId: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3',
        inputCostPerMTok: 0.49, outputCostPerMTok: 0.89, contextK: 128,
        notes: 'Tope de calidad conversacional. Para personalidades premium.',
      },
      {
        modelId: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (razonador)',
        inputCostPerMTok: 0.55, outputCostPerMTok: 2.19, contextK: 128,
        notes: 'Razonamiento profundo: bots auditores y reportes. No para chat en vivo.',
      },
      {
        modelId: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen 2.5 72B',
        inputCostPerMTok: 0.23, outputCostPerMTok: 0.4, contextK: 128,
        notes: 'Alternativa multilingüe fuerte (es/en).',
      },
      {
        modelId: 'mistralai/Mixtral-8x7B-Instruct-v0.1', name: 'Mixtral 8x7B',
        inputCostPerMTok: 0.24, outputCostPerMTok: 0.24, contextK: 32,
        notes: 'Rápido y parejo entrada/salida.',
      },
    ],
  });

  console.log('Biblioteca de personalidades…');
  await prisma.personaTemplate.createMany({
    data: [
      {
        name: 'Recepcionista de clínica', category: 'Clínicas',
        description: 'Agenda citas, resuelve dudas de servicios y deriva urgencias a un humano.',
        systemPrompt:
          'Eres la recepcionista virtual de una clínica. Atiendes pacientes por WhatsApp: resuelves dudas de servicios, precios y horarios, y agendas citas en el calendario. Nunca das diagnósticos médicos; ante síntomas o urgencias derivas de inmediato a un humano. Tono cálido, profesional y natural.',
        personalityJson: JSON.stringify({
          tone: 'Cálido y profesional', style: 'Cercano, frases cortas',
          limits: 'Sin diagnósticos médicos; urgencias → humano.', language: 'es',
        }),
        welcomeMessage: '¡Hola! Soy la asistente de la clínica 😊 ¿En qué te ayudo hoy?',
        handoffKeywords: 'urgencia, emergencia, dolor fuerte, queja, hablar con humano',
      },
      {
        name: 'Asesora de estudio webcam', category: 'Estudios webcam',
        description: 'Perfil con identidad propia: conversa con calidez, fideliza y detecta clientes de alto valor.',
        systemPrompt:
          'Eres la asistente de un perfil/modelo de un estudio. Conversas con calidez y personalidad propia, recuerdas los detalles de cada cliente y los haces sentir únicos. Detectas clientes de alto valor y los priorizas. Mantienes siempre los límites definidos por el estudio y nunca compartes datos personales reales.',
        personalityJson: JSON.stringify({
          tone: 'Coqueta, cercana y segura', style: 'Conversacional, con memoria de detalles',
          limits: 'Nunca comparte datos personales reales ni links externos; pagos solo por canales oficiales del estudio.',
          language: 'es',
        }),
        welcomeMessage: 'Holaa 💛 qué bueno verte por aquí, ¿cómo va tu día?',
        handoffKeywords: 'pago, problema, reembolso, supervisor',
      },
      {
        name: 'Vendedor automotriz', category: 'Automotriz',
        description: 'Califica compradores reales, filtra curiosos y agenda cita con el vendedor.',
        systemPrompt:
          'Eres el asesor virtual de un concesionario. Pides al cliente los datos del vehículo que busca, evalúas presupuesto e intención real de compra y, si la hay, agendas cita con el vendedor. Filtras curiosos con amabilidad. No negocias precios finales.',
        personalityJson: JSON.stringify({
          tone: 'Comercial y ágil', style: 'Preguntas concretas',
          limits: 'No negocia precios finales; eso lo cierra el vendedor.', language: 'es',
        }),
        welcomeMessage: '¡Hola! 🚗 ¿Qué vehículo estás buscando?',
        handoffKeywords: 'financiamiento, gerente, queja',
      },
      {
        name: 'Vendedora inmobiliaria', category: 'Inmobiliaria',
        description: 'Atiende interesados en proyectos, comparte información y agenda visitas.',
        systemPrompt:
          'Eres la asesora virtual de un proyecto inmobiliario. Respondes dudas de precios, financiación y disponibilidad, calificas el interés real y agendas visitas al proyecto. Tono aspiracional pero honesto.',
        personalityJson: JSON.stringify({
          tone: 'Aspiracional y confiable', style: 'Datos claros, sin presión',
          limits: 'No promete rentabilidades; cifras solo las oficiales.', language: 'es',
        }),
        welcomeMessage: '¡Hola! Bienvenido 🌱 ¿Te cuento sobre el proyecto?',
        handoffKeywords: 'contrato, abogado, negociar',
      },
      {
        name: 'Cobranza amable', category: 'Ventas',
        description: 'Recuerda pagos pendientes sin dañar la relación con el cliente.',
        systemPrompt:
          'Eres el asistente de cobranza. Recuerdas pagos pendientes con amabilidad y firmeza, ofreces opciones de pago y escalas a un humano si el cliente plantea una disputa. Jamás amenazas ni presionas.',
        personalityJson: JSON.stringify({
          tone: 'Amable y firme', style: 'Directo, con opciones',
          limits: 'Sin amenazas; disputas → humano.', language: 'es',
        }),
        handoffKeywords: 'disputa, reclamo, abogado, no voy a pagar',
      },
    ],
  });

  console.log('Equipo BackOffice…');
  await prisma.user.createMany({
    data: [
      {
        email: 'santiago@backoffice.dev', name: 'Santiago Restrepo',
        role: 'SUPER_ADMIN', jobTitle: 'Co-fundador',
        passwordHash: hash(seedPassword('SEED_PASSWORD_SANTIAGO')),
      },
      {
        email: 'daniel@backoffice.dev', name: 'Daniel Loaiza',
        role: 'SUPER_ADMIN', jobTitle: 'Co-fundador',
        passwordHash: hash(seedPassword('SEED_PASSWORD_DANIEL')),
      },
      {
        email: 'restrepos591@gmail.com', name: 'Santiago Restrepo',
        role: 'DEV', jobTitle: 'Co-fundador · Dev',
        passwordHash: hash(seedPassword('SEED_PASSWORD_DEV_SANTIAGO')),
      },
      {
        email: 'danielloaiza609@gmail.com', name: 'Daniel Loaiza',
        role: 'DEV', jobTitle: 'Co-fundador · Dev',
        passwordHash: hash(seedPassword('SEED_PASSWORD_DEV_DANIEL')),
      },
    ],
  });

  console.log('Empresa de prueba (vacía)…');
  const empresa = await prisma.company.create({
    data: {
      name: 'Empresa de Prueba', slug: 'empresa-de-prueba',
      industry: 'Demo interna', country: 'Colombia', city: 'Medellín',
      status: 'ACTIVE', planId: growth.id, timezone: 'America/Bogota',
      notes: 'Empresa interna para revisar la vista de cliente. Sin datos.',
    },
  });
  await prisma.user.create({
    data: {
      email: 'admin@empresa-prueba.com', name: 'Admin de Prueba',
      role: 'COMPANY_ADMIN', jobTitle: 'Administrador',
      companyId: empresa.id, passwordHash: hash(seedPassword('SEED_PASSWORD_EMPRESA_PRUEBA')),
    },
  });
  const bot = await prisma.bot.create({
    data: {
      companyId: empresa.id, name: 'Asistente de Prueba', status: 'DRAFT',
      description: 'Bot inicial para configurar y probar.',
      provider: 'deepinfra', model: 'meta-llama/Llama-3.3-70B-Instruct',
    },
  });
  await prisma.integration.create({
    data: {
      companyId: empresa.id, botId: bot.id, type: 'WHATSAPP',
      name: 'Línea principal', status: 'DISCONNECTED', promptMode: 'INHERIT',
      connectUrl:
        'https://www.facebook.com/v21.0/dialog/oauth?client_id=META_APP_ID_PENDIENTE&redirect_uri=http%3A%2F%2Flocalhost%3A4001%2Fintegrations%2Fmeta%2Fcallback&state=empresa-de-prueba:whatsapp&scope=whatsapp_business_management,whatsapp_business_messaging',
      webhookUrl: 'http://localhost:4001/api/webhooks/empresa-de-prueba/whatsapp',
    },
  });

  console.log('Configuración de plataforma…');
  await prisma.platformSetting.createMany({
    data: [
      { key: 'META_APP_ID', value: '' },
      { key: 'META_APP_SECRET', value: '' },
      { key: 'META_VERIFY_TOKEN', value: '' },
      { key: 'WEBHOOK_BASE_URL', value: 'http://localhost:4001' },
      { key: 'META_REDIRECT_URI', value: 'http://localhost:4001/integrations/meta/callback' },
      { key: 'PLATFORM_NAME', value: 'BackOffice' },
      { key: 'SUPPORT_WHATSAPP', value: '+57 310 879 0168' },
      { key: 'WOMPI_ENV', value: 'test' },
      { key: 'WOMPI_PUBLIC_KEY', value: '' },
      { key: 'WOMPI_INTEGRITY_SECRET', value: '' },
      { key: 'WOMPI_EVENTS_SECRET', value: '' },
      { key: 'WOMPI_REDIRECT_URL', value: 'http://localhost:5173/app/billing' },
      { key: 'USD_COP_RATE', value: '4000' },
      { key: 'DEEPINFRA_API_KEY', value: '' },
      { key: 'SMTP_HOST', value: '' },
      { key: 'SMTP_PORT', value: '587' },
      { key: 'SMTP_USER', value: '' },
      { key: 'SMTP_PASS', value: '' },
      { key: 'SMTP_FROM', value: 'BackOffice <hola@backoffice.dev>' },
    ],
  });

  console.log('Seed de producción listo ✅ — plataforma vacía + Empresa de Prueba');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
