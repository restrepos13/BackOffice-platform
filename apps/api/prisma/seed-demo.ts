/**
 * Seed de desarrollo — BackOffice Platform.
 * Usuarios demo (contraseña para todos: backoffice2026):
 *   santiago@backoffice.dev  → SUPER_ADMIN
 *   daniel@backoffice.dev    → SUPER_ADMIN
 *   dev@backoffice.dev       → DEV
 *   admin@massaludlatam.com  → COMPANY_ADMIN (Mas Salud Latam)
 *   vista@massaludlatam.com  → COMPANY_VIEWER (Mas Salud Latam)
 *   admin@hmmotors.net       → COMPANY_ADMIN (HM Motors)
 *   admin@lotesancestral.com → COMPANY_ADMIN (Lotes Ancestral, en trial)
 *   admin@novastudio.co      → COMPANY_ADMIN (Nova Studio, agencia webcam multi-línea)
 *   monitor@novastudio.co    → COMPANY_VIEWER (Nova Studio)
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { seedPassword } from './seed-passwords';
import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const prisma = new PrismaClient();
const PASSWORD = bcrypt.hashSync('backoffice2026', 10);

// Pseudo-aleatorio determinista para que el seed sea reproducible
let seedState = 42;
function rand(): number {
  seedState = (seedState * 9301 + 49297) % 233280;
  return seedState / 233280;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

function day(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d;
}
function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * 3600 * 1000);
}

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

  console.log('Catálogo de modelos IA (DeepInfra)…');
  // Precios de REFERENCIA (USD por 1M tokens). Actualizar contra deepinfra.com/pricing
  // desde Plataforma → Modelos IA. Estos costos se declaran al cliente tal cual.
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
        name: 'Recepcionista de clínica',
        category: 'Clínicas',
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
        name: 'Asesora de estudio webcam',
        category: 'Estudios webcam',
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
        name: 'Vendedor automotriz',
        category: 'Automotriz',
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
        name: 'Vendedora inmobiliaria',
        category: 'Inmobiliaria',
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
        name: 'Cobranza amable',
        category: 'Ventas',
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

  console.log('Planes…');
  const [starter, growth, scale] = await Promise.all([
    prisma.plan.create({
      data: {
        code: 'starter', name: 'Starter', priceMonthly: 299,
        maxBots: 10, maxWorkspaces: 1, maxUsers: 5,
        featuresJson: JSON.stringify([
          'Hasta 10 perfiles/modelos', '1 workspace', 'Panel de agencia completo',
          'Personalidad individual + memoria', 'Historial de conversaciones',
          'Métricas básicas y onboarding inicial',
        ]),
      },
    }),
    prisma.plan.create({
      data: {
        code: 'growth', name: 'Growth', priceMonthly: 599, highlight: true,
        maxBots: 30, maxWorkspaces: 1, maxUsers: 15,
        featuresJson: JSON.stringify([
          'Hasta 30 perfiles/modelos', 'Analytics por modelo',
          'Supervisión de conversaciones', 'Reglas de personalidad y roles de equipo',
          'Respuestas sugeridas y exportación de datos', 'Soporte prioritario',
        ]),
      },
    }),
    prisma.plan.create({
      data: {
        code: 'scale', name: 'Scale', priceMonthly: 999,
        maxBots: 75, maxWorkspaces: 3, maxUsers: 40,
        featuresJson: JSON.stringify([
          'Hasta 75 perfiles/modelos', '3 workspaces',
          'Analytics avanzado + reportes operativos', 'Auditoría y trazabilidad completa',
          'API, webhooks e integraciones avanzadas', 'Onboarding y migración asistida',
        ]),
      },
    }),
  ]);
  await prisma.plan.create({
    data: {
      code: 'enterprise', name: 'Enterprise', priceMonthly: 0, isCustom: true,
      maxBots: 999, maxWorkspaces: 99, maxUsers: 999,
      featuresJson: JSON.stringify([
        '100+ modelos', 'Límites personalizados', 'SSO', 'Permisos avanzados',
        'SLA', 'Integraciones privadas', 'Aislamiento dedicado opcional',
      ]),
    },
  });

  console.log('Equipo de plataforma…');
  const santiago = await prisma.user.create({
    data: {
      email: 'santiago@backoffice.dev', name: 'Santiago Restrepo',
      role: 'SUPER_ADMIN', jobTitle: 'Co-fundador', passwordHash: PASSWORD,
    },
  });
  await prisma.user.create({
    data: {
      email: 'daniel@backoffice.dev', name: 'Daniel Loaiza',
      role: 'SUPER_ADMIN', jobTitle: 'Co-fundador', passwordHash: PASSWORD,
    },
  });
  await prisma.user.create({
    data: {
      email: 'dev@backoffice.dev', name: 'Dev BackOffice',
      role: 'DEV', jobTitle: 'Desarrollador', passwordHash: PASSWORD,
    },
  });
  // Cuentas dev personales de los fundadores (contraseñas propias, fuertes —
  // estas cuentas se usan con la web expuesta por túnel)
  await prisma.user.create({
    data: {
      email: 'restrepos591@gmail.com', name: 'Santiago Restrepo',
      role: 'DEV', jobTitle: 'Co-fundador · Dev',
      passwordHash: bcrypt.hashSync(seedPassword('SEED_PASSWORD_DEV_SANTIAGO'), 10),
    },
  });
  await prisma.user.create({
    data: {
      email: 'danielloaiza609@gmail.com', name: 'Daniel Loaiza',
      role: 'DEV', jobTitle: 'Co-fundador · Dev',
      passwordHash: bcrypt.hashSync(seedPassword('SEED_PASSWORD_DEV_DANIEL'), 10),
    },
  });

  // ── Empresa 1: Mas Salud Latam ────────────────────────────────────
  console.log('Mas Salud Latam…');
  const masSalud = await prisma.company.create({
    data: {
      name: 'Mas Salud Latam', slug: 'mas-salud-latam',
      legalName: 'Mas Salud Latam S.A.', industry: 'Salud',
      country: 'Costa Rica', city: 'San José',
      website: 'https://massaludlatam.com',
      contactEmail: 'gerencia@massaludlatam.com', contactPhone: '+506 8888 0000',
      status: 'ACTIVE', planId: growth.id, timezone: 'America/Costa_Rica',
      brandColor: '#0E7C66',
      notes: 'Caso 01 — clínica con bot jefe auditor. Ahorro equivalente a 16 sueldos.',
    },
  });
  const msAdmin = await prisma.user.create({
    data: {
      email: 'admin@massaludlatam.com', name: 'Gerencia Mas Salud',
      role: 'COMPANY_ADMIN', jobTitle: 'Gerente general',
      companyId: masSalud.id, passwordHash: PASSWORD,
    },
  });
  await prisma.user.create({
    data: {
      email: 'vista@massaludlatam.com', name: 'Recepción Mas Salud',
      role: 'COMPANY_VIEWER', jobTitle: 'Recepción',
      companyId: masSalud.id, passwordHash: PASSWORD,
    },
  });
  const msBot = await prisma.bot.create({
    data: {
      companyId: masSalud.id, name: 'Asistente Mas Salud', status: 'ACTIVE',
      description: 'Chatbot de ventas: atiende y agenda pacientes 24/7.',
      model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.6,
      systemPrompt:
        'Eres el asistente de la clínica Mas Salud Latam. Atiendes pacientes por WhatsApp: resuelves dudas de servicios, precios y horarios, y agendas citas en el calendario. Tono cálido, profesional y natural — jamás suenas a robot.',
      personalityJson: JSON.stringify({
        tone: 'Cálido y profesional', style: 'Cercano, frases cortas',
        limits: 'No da diagnósticos médicos; deriva a un especialista.',
        language: 'es',
      }),
      welcomeMessage: '¡Hola! Soy el asistente de Mas Salud. ¿En qué te ayudo hoy?',
      handoffKeywords: 'urgencia, emergencia, queja, hablar con humano',
    },
  });
  const msAuditor = await prisma.bot.create({
    data: {
      companyId: masSalud.id, name: 'Bot Jefe Auditor', status: 'ACTIVE',
      description: 'Audita todas las áreas de la clínica y reporta a gerencia en tiempo real.',
      model: 'deepseek-ai/DeepSeek-R1', temperature: 0.3,
      systemPrompt:
        'Eres el bot auditor de Mas Salud Latam. Supervisas citas, ventas y seguimientos, y reportas a gerencia con métricas y alertas accionables.',
      personalityJson: JSON.stringify({
        tone: 'Directo y ejecutivo', style: 'Reportes con datos', language: 'es',
      }),
    },
  });
  // Dos líneas de WhatsApp: Citas hereda las instrucciones del bot,
  // Ventas tiene instrucciones propias (promptMode CUSTOM).
  const msLineaCitas = await prisma.integration.create({
    data: {
      companyId: masSalud.id, botId: msBot.id, type: 'WHATSAPP',
      name: 'Línea Citas', status: 'CONNECTED', promptMode: 'INHERIT',
      configJson: JSON.stringify({
        displayPhone: '+506 8888 1234', phoneNumberId: '1042XXXX', wabaId: '2231XXXX',
      }),
      webhookUrl: 'http://localhost:4001/api/webhooks/mas-salud-latam/whatsapp',
      lastSyncAt: hoursAgo(1),
    },
  });
  const msLineaVentas = await prisma.integration.create({
    data: {
      companyId: masSalud.id, botId: msBot.id, type: 'WHATSAPP',
      name: 'Línea Ventas', status: 'CONNECTED', promptMode: 'CUSTOM',
      configJson: JSON.stringify({
        displayPhone: '+506 8888 5678', phoneNumberId: '1043XXXX', wabaId: '2231XXXX',
      }),
      webhookUrl: 'http://localhost:4001/api/webhooks/mas-salud-latam/whatsapp',
      lastSyncAt: hoursAgo(2),
      overridePrompt:
        'Eres el asesor comercial de Mas Salud Latam. Este número recibe tráfico de campañas: tu objetivo es convertir interesados en citas valoradas. Presentas promociones vigentes, resuelves objeciones de precio y cierras la cita. Tono vendedor pero humano.',
      overridePersonalityJson: JSON.stringify({
        tone: 'Comercial y empático', style: 'Orientado a cierre, sin presión',
        limits: 'No da diagnósticos; descuentos solo los publicados.', language: 'es',
      }),
      overrideWelcome: '¡Hola! 😊 Vi que te interesó nuestra promo, ¿te cuento cómo funciona?',
      overrideHandoff: 'queja, gerente, reembolso',
    },
  });
  await prisma.integration.createMany({
    data: [
      {
        companyId: masSalud.id, type: 'META_ADS', name: 'Meta Ads',
        status: 'CONNECTED',
        configJson: JSON.stringify({ adAccount: 'act_884XXXX' }),
        lastSyncAt: hoursAgo(3),
      },
      {
        companyId: masSalud.id, botId: msBot.id, type: 'GOOGLE_CALENDAR',
        name: 'Google Calendar', status: 'CONNECTED',
        configJson: JSON.stringify({ calendar: 'citas@massaludlatam.com' }),
        lastSyncAt: hoursAgo(2),
      },
      {
        companyId: masSalud.id, type: 'N8N', name: 'n8n Automations',
        status: 'DISCONNECTED', connectUrl: 'http://localhost:5678',
      },
    ],
  });

  // ── Empresa 2: HM Motors ──────────────────────────────────────────
  console.log('HM Motors…');
  const hmMotors = await prisma.company.create({
    data: {
      name: 'HM Motors', slug: 'hm-motors',
      industry: 'Automotriz', country: 'Costa Rica', city: 'San José',
      website: 'https://hmmotors.net',
      contactEmail: 'ventas@hmmotors.net', contactPhone: '+506 7000 1111',
      status: 'ACTIVE', planId: starter.id, timezone: 'America/Costa_Rica',
      brandColor: '#B3261E',
      notes: 'Caso 03 — concesionario. Califica leads y agenda citas sin humanos.',
    },
  });
  await prisma.user.create({
    data: {
      email: 'admin@hmmotors.net', name: 'Dirección HM Motors',
      role: 'COMPANY_ADMIN', jobTitle: 'Director comercial',
      companyId: hmMotors.id, passwordHash: PASSWORD,
    },
  });
  await prisma.user.create({
    data: {
      email: 'vista@hmmotors.net', name: 'Equipo Ventas HM',
      role: 'COMPANY_VIEWER', jobTitle: 'Vendedor',
      companyId: hmMotors.id, passwordHash: PASSWORD,
    },
  });
  const hmBot = await prisma.bot.create({
    data: {
      companyId: hmMotors.id, name: 'Asesor HM', status: 'ACTIVE',
      description: 'Califica compradores reales y agenda citas con el vendedor.',
      model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.7,
      systemPrompt:
        'Eres el asesor virtual de HM Motors. Pides al cliente los datos del auto que busca, evalúas si hay intención real de compra y, si la hay, agendas cita en el calendario del vendedor. Filtra curiosos con amabilidad.',
      personalityJson: JSON.stringify({
        tone: 'Comercial y ágil', style: 'Preguntas concretas',
        limits: 'No negocia precios finales; eso lo cierra el vendedor.',
        language: 'es',
      }),
      welcomeMessage: '¡Hola! Soy el asesor de HM Motors 🚗 ¿Qué auto estás buscando?',
      handoffKeywords: 'financiamiento, gerente, queja',
    },
  });
  const hmLinea = await prisma.integration.create({
    data: {
      companyId: hmMotors.id, botId: hmBot.id, type: 'WHATSAPP',
      name: 'Línea Ventas', status: 'CONNECTED', promptMode: 'INHERIT',
      configJson: JSON.stringify({
        displayPhone: '+506 7000 2222', phoneNumberId: '1099XXXX', wabaId: '2255XXXX',
      }),
      webhookUrl: 'http://localhost:4001/api/webhooks/hm-motors/whatsapp',
      lastSyncAt: hoursAgo(1),
    },
  });
  await prisma.integration.createMany({
    data: [
      {
        companyId: hmMotors.id, botId: hmBot.id, type: 'GOOGLE_CALENDAR',
        name: 'Google Calendar', status: 'CONNECTED',
        configJson: JSON.stringify({ calendar: 'citas@hmmotors.net' }),
        lastSyncAt: hoursAgo(5),
      },
      {
        companyId: hmMotors.id, type: 'META_ADS', name: 'Meta Ads',
        status: 'DISCONNECTED',
        connectUrl:
          'https://www.facebook.com/v21.0/dialog/oauth?client_id=META_APP_ID_PENDIENTE&redirect_uri=http%3A%2F%2Flocalhost%3A4001%2Fintegrations%2Fmeta%2Fcallback&state=hm-motors:ads&scope=ads_read,ads_management',
      },
    ],
  });

  // ── Empresa 3: Lotes Ancestral (trial) ────────────────────────────
  console.log('Lotes Ancestral…');
  const lotes = await prisma.company.create({
    data: {
      name: 'Lotes Ancestral', slug: 'lotes-ancestral',
      industry: 'Inmobiliaria', country: 'Colombia', city: 'Medellín',
      website: 'https://lotesancestral.com',
      contactEmail: 'info@lotesancestral.com',
      status: 'TRIAL', planId: starter.id, timezone: 'America/Bogota',
      trialEndsAt: day(-10),
      notes: 'Proyecto de lotes en Colombia. Landing entregada; plataforma en trial.',
    },
  });
  await prisma.user.create({
    data: {
      email: 'admin@lotesancestral.com', name: 'Comercial Ancestral',
      role: 'COMPANY_ADMIN', jobTitle: 'Directora comercial',
      companyId: lotes.id, passwordHash: PASSWORD,
    },
  });
  const lotesBot = await prisma.bot.create({
    data: {
      companyId: lotes.id, name: 'Asistente Ancestral', status: 'DRAFT',
      description: 'Atiende interesados en lotes y agenda visitas al proyecto.',
      model: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      systemPrompt: 'Eres el asistente del proyecto Lotes Ancestral…',
      welcomeMessage: '¡Hola! Bienvenido a Lotes Ancestral 🌱',
    },
  });
  await prisma.integration.createMany({
    data: [
      {
        companyId: lotes.id, botId: lotesBot.id, type: 'WHATSAPP',
        name: 'WhatsApp Business API', status: 'DISCONNECTED',
        connectUrl:
          'https://www.facebook.com/v21.0/dialog/oauth?client_id=META_APP_ID_PENDIENTE&redirect_uri=http%3A%2F%2Flocalhost%3A4001%2Fintegrations%2Fmeta%2Fcallback&state=lotes-ancestral:whatsapp&scope=whatsapp_business_management,whatsapp_business_messaging',
        webhookUrl: 'http://localhost:4001/api/webhooks/lotes-ancestral/whatsapp',
      },
      {
        companyId: lotes.id, type: 'META_ADS', name: 'Meta Ads',
        status: 'DISCONNECTED',
        connectUrl:
          'https://www.facebook.com/v21.0/dialog/oauth?client_id=META_APP_ID_PENDIENTE&redirect_uri=http%3A%2F%2Flocalhost%3A4001%2Fintegrations%2Fmeta%2Fcallback&state=lotes-ancestral:ads&scope=ads_read,ads_management',
      },
    ],
  });

  // ── Empresa 4: Nova Studio (agencia webcam — caso multi-línea) ────
  console.log('Nova Studio…');
  const nova = await prisma.company.create({
    data: {
      name: 'Nova Studio', slug: 'nova-studio',
      industry: 'Estudio webcam', country: 'Colombia', city: 'Medellín',
      contactEmail: 'admin@novastudio.co', contactPhone: '+57 300 555 0101',
      status: 'ACTIVE', planId: growth.id, timezone: 'America/Bogota',
      brandColor: '#7A1F5C',
      // BYOK demo: llave ficticia para mostrar el estado "conectada" (enmascarada)
      deepinfraApiKey: 'di_demo_no_real_0000',
      notes: 'Agencia webcam con un número de WhatsApp por modelo. Cada línea tiene personalidad propia (promptMode CUSTOM).',
    },
  });
  await prisma.user.create({
    data: {
      email: 'admin@novastudio.co', name: 'Dirección Nova Studio',
      role: 'COMPANY_ADMIN', jobTitle: 'Directora', companyId: nova.id,
      passwordHash: PASSWORD,
    },
  });
  await prisma.user.create({
    data: {
      email: 'monitor@novastudio.co', name: 'Monitor Nova',
      role: 'COMPANY_VIEWER', jobTitle: 'Supervisión', companyId: nova.id,
      passwordHash: PASSWORD,
    },
  });
  const novaBot = await prisma.bot.create({
    data: {
      companyId: nova.id, name: 'Motor IA Nova', status: 'ACTIVE',
      description: 'Motor común del estudio: reglas generales, memoria y límites. Cada línea define su propia personalidad encima.',
      model: 'deepseek-ai/DeepSeek-V3', temperature: 0.8,
      systemPrompt:
        'Eres un perfil del estudio Nova. Reglas generales para todas las líneas: conversas con calidez y memoria de cada cliente, priorizas clientes de alto valor, nunca compartes datos personales reales ni links externos, y los pagos van solo por los canales oficiales del estudio. La personalidad concreta la define cada línea.',
      personalityJson: JSON.stringify({
        tone: 'Cálido y con personalidad', style: 'Conversacional, con memoria',
        limits: 'Sin datos personales reales, sin links externos, pagos solo canales oficiales.',
        language: 'es',
      }),
      handoffKeywords: 'pago, problema, reembolso, supervisor',
      // Tiempos humanizados: nadie responde en 0 segundos
      replyDelayMinSec: 8, replyDelayMaxSec: 45, typingSimulation: true,
      salesJson: JSON.stringify({
        goal: 'Fidelizar clientes y vender contenido premium (PPV) de la galería.',
        style: 'Venta suave: primero conexión, después la oferta. Nunca insistir dos veces seguidas.',
        catalog: 'Contenido de la galería según el precio marcado en cada foto. Sesiones privadas: consultar disponibilidad.',
        upsell: 'A clientes recurrentes ofrecer packs; a clientes de alto valor, contenido exclusivo antes que a nadie.',
        objections: 'Si dice que es caro: recordar el valor de lo exclusivo, ofrecer alternativa más económica una sola vez.',
      }),
    },
  });
  const novaPersonas: Array<{
    name: string; phone: string; tone: string; style: string; welcome: string;
    prompt: string;
  }> = [
    {
      name: 'Línea Valentina', phone: '+57 300 555 1001',
      tone: 'Dulce y juguetona', style: 'Emojis con medida, preguntas sobre el día del cliente',
      welcome: 'Holaa 💛 te estaba esperando, ¿cómo va tu día?',
      prompt: 'Eres Valentina: dulce, juguetona y atenta. Recuerdas los gustos de cada cliente y les preguntas por lo que te contaron la última vez.',
    },
    {
      name: 'Línea Sofía', phone: '+57 300 555 1002',
      tone: 'Elegante y misteriosa', style: 'Mensajes cortos, deja con ganas de más',
      welcome: 'Vaya, mira quién apareció… 😏',
      prompt: 'Eres Sofía: elegante, segura y un punto misteriosa. Respondes con calma, nunca pareces ansiosa, y haces que el cliente busque tu atención.',
    },
    {
      name: 'Línea Isabella', phone: '+57 300 555 1003',
      tone: 'Alegre y conversadora', style: 'Charla fluida, humor ligero',
      welcome: '¡Holaaa! 😄 justo pensaba en ti, ¿todo bien?',
      prompt: 'Eres Isabella: alegre, espontánea y conversadora. Ríes con facilidad, usas humor ligero y haces sentir al cliente como un amigo cercano.',
    },
    {
      name: 'Línea Luna', phone: '+57 300 555 1004',
      tone: 'Tranquila y empática', style: 'Escucha activa, mensajes cálidos y largos',
      welcome: 'Hola 🌙 qué lindo verte por aquí, cuéntame de ti…',
      prompt: 'Eres Luna: tranquila, empática y buena escuchando. Muchos clientes buscan compañía: les das conversación genuina y recuerdas lo que les importa.',
    },
  ];
  const novaLines: string[] = [];
  for (const persona of novaPersonas) {
    const line = await prisma.integration.create({
      data: {
        companyId: nova.id, botId: novaBot.id, type: 'WHATSAPP',
        name: persona.name, status: 'CONNECTED', promptMode: 'CUSTOM',
        configJson: JSON.stringify({
          displayPhone: persona.phone,
          phoneNumberId: `12${randInt(10, 99)}XXXX`, wabaId: '3311XXXX',
        }),
        webhookUrl: 'http://localhost:4001/api/webhooks/nova-studio/whatsapp',
        lastSyncAt: hoursAgo(randInt(1, 5)),
        overridePrompt: persona.prompt,
        overridePersonalityJson: JSON.stringify({
          tone: persona.tone, style: persona.style,
          limits: 'Los del estudio: sin datos reales, sin links, pagos oficiales.',
          language: 'es',
        }),
        overrideWelcome: persona.welcome,
        overrideHandoff: 'pago, problema, reembolso, supervisor',
      },
    });
    novaLines.push(line.id);
  }
  // Valentina tiene además reglas de venta y tiempos propios
  await prisma.integration.update({
    where: { id: novaLines[0] },
    data: {
      overrideReplyDelayMinSec: 15,
      overrideReplyDelayMaxSec: 90,
      overrideSalesJson: JSON.stringify({
        goal: 'Convertir a Mark y a los VIP en compradores semanales de PPV.',
        style: 'Juguetona: la oferta llega como un secreto compartido, nunca como catálogo.',
        catalog: 'Sets de fotos de la galería a su precio marcado; personalizados desde $50.',
        upsell: 'Después de 2 compras, ofrecer el pack mensual.',
        objections: 'Si duda, cambiar de tema con cariño y reintentar en otro momento.',
      }),
    },
  });

  // Galería de Nova: fotos que la IA puede enviar (placeholders de color)
  console.log('Galería de medios…');
  const uploadsDir = resolve(__dirname, '..', 'uploads', nova.id);
  mkdirSync(uploadsDir, { recursive: true });
  const PLACEHOLDERS: Array<{ name: string; b64: string; price: number; tags: string[]; line?: string }> = [
    {
      name: 'Set rosa — 6 fotos', price: 25, tags: ['ppv', 'set', 'valentina'],
      line: novaLines[0],
      b64: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAAJElEQVR42mO41rmMKohh1KBRg0YNGjVo1KBRg0YNGjVoeBgEAKfaD1vtsKqtAAAAAElFTkSuQmCC',
    },
    {
      name: 'Set lila — exclusivo VIP', price: 40, tags: ['ppv', 'vip', 'valentina'],
      line: novaLines[0],
      b64: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAAJElEQVR42mNY3r2PKohh1KBRg0YNGjRo1KBRg0YNGjVoeBgEAFH60EyubUqTAAAAAElFTkSuQmCC',
    },
    {
      name: 'Preview gratuito — dorado', price: 0, tags: ['gratis', 'preview'],
      b64: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAAJElEQVR42mM4tiyFKohh1KBRg0YNGjVo1KBRg0YNGjVoeBgEAKNfcExYQirEAAAAAElFTkSuQmCC',
    },
    {
      name: 'Set noche — Luna', price: 30, tags: ['ppv', 'luna'],
      line: novaLines[3],
      b64: 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAgCAIAAACHPC9vAAAAJElEQVR42mOwsQqiCmIYNWjUoFGDRg0aNWjUoFGDRg0aHgYBAOd/WB8csn5JAAAAAElFTkSuQmCC',
    },
  ];
  for (const ph of PLACEHOLDERS) {
    const fileName = `seed-${ph.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
    const buf = Buffer.from(ph.b64, 'base64');
    writeFileSync(join(uploadsDir, fileName), buf);
    await prisma.mediaAsset.create({
      data: {
        companyId: nova.id,
        integrationId: ph.line ?? null,
        name: ph.name,
        fileName,
        mimeType: 'image/png',
        sizeBytes: buf.length,
        priceUsd: ph.price,
        tagsJson: JSON.stringify(ph.tags),
        timesSent: randInt(0, 14),
      },
    });
  }

  // ── Contactos y conversaciones ────────────────────────────────────
  console.log('Contactos y conversaciones…');

  interface SeedContact {
    name: string; phone: string; stage: string; channel?: string;
    tags?: string[]; convo?: {
      status: string; needsAttention?: boolean; hoursAgo: number;
      messages: Array<[/*author*/ 'CONTACT' | 'BOT' | 'AGENT', string]>;
    };
  }

  async function seedContacts(
    companyId: string, botId: string, list: SeedContact[], integrationId?: string,
  ) {
    for (const c of list) {
      const contact = await prisma.contact.create({
        data: {
          companyId, name: c.name, phone: c.phone,
          channel: c.channel ?? 'WHATSAPP', stage: c.stage,
          tagsJson: JSON.stringify(c.tags ?? []),
          lastActivityAt: c.convo ? hoursAgo(c.convo.hoursAgo) : hoursAgo(randInt(4, 200)),
        },
      });
      if (c.convo) {
        const convo = await prisma.conversation.create({
          data: {
            companyId, botId, contactId: contact.id, integrationId,
            channel: c.channel ?? 'WHATSAPP',
            status: c.convo.status,
            needsAttention: !!c.convo.needsAttention,
            unreadCount: c.convo.needsAttention ? randInt(1, 4) : 0,
            lastMessageAt: hoursAgo(c.convo.hoursAgo),
          },
        });
        let offset = c.convo.messages.length;
        for (const [author, content] of c.convo.messages) {
          await prisma.message.create({
            data: {
              conversationId: convo.id,
              direction: author === 'CONTACT' ? 'IN' : 'OUT',
              author, content,
              tokens: author === 'BOT' ? randInt(60, 220) : null,
              createdAt: hoursAgo(c.convo.hoursAgo + offset * 0.05),
            },
          });
          offset -= 1;
        }
      }
    }
  }

  await seedContacts(masSalud.id, msBot.id, [
    {
      name: 'María Fernández', phone: '+506 8811 2233', stage: 'CLIENTE',
      tags: ['odontología'], convo: {
        status: 'RESOLVED', hoursAgo: 3,
        messages: [
          ['CONTACT', 'Hola! Vi su página, ¿tienen disponibilidad para este sábado?'],
          ['BOT', '¡Hola María! Claro que sí 😊 Para el sábado tenemos espacio a las 10:00 am y a las 3:30 pm, ¿cuál te queda mejor?'],
          ['CONTACT', 'La de las 10 está perfecta'],
          ['BOT', 'Listo, quedaste agendada para el sábado a las 10:00 am ✅ Un día antes te envío un recordatorio por aquí.'],
        ],
      },
    },
    {
      name: 'Carlos Jiménez', phone: '+506 8722 9911', stage: 'CALIENTE',
      tags: ['implantes', 'presupuesto'], convo: {
        status: 'HANDOFF', needsAttention: true, hoursAgo: 1,
        messages: [
          ['CONTACT', 'Necesito hablar con un humano, tengo una queja del servicio de ayer'],
          ['BOT', 'Lamento mucho eso, Carlos. Ya notifiqué al equipo: una persona de la clínica te escribe por aquí en los próximos minutos.'],
        ],
      },
    },
    {
      name: 'Ana Solano', phone: '+506 8633 4455', stage: 'POTENCIAL',
      tags: ['ortodoncia'], convo: {
        status: 'OPEN', hoursAgo: 6,
        messages: [
          ['CONTACT', '¿Cuánto cuesta la valoración de ortodoncia?'],
          ['BOT', 'La valoración inicial cuesta ₡15.000 e incluye radiografía panorámica. ¿Quieres que te agende una cita esta semana?'],
          ['CONTACT', 'Déjame ver mi agenda y te digo'],
        ],
      },
    },
    {
      name: 'Jorge Brenes', phone: '+506 8544 7788', stage: 'CURIOSO',
      convo: {
        status: 'OPEN', hoursAgo: 12,
        messages: [
          ['CONTACT', '¿Dónde quedan ubicados?'],
          ['BOT', 'Estamos en San José, 200 m sur del parque central. ¿Te comparto la ubicación por Maps?'],
        ],
      },
    },
    {
      name: 'Lucía Mora', phone: '+506 8455 6677', stage: 'CLIENTE',
      tags: ['limpieza', 'recurrente'],
    },
    { name: 'Pedro Alfaro', phone: '+506 8366 5544', stage: 'POTENCIAL' },
    { name: 'Sofía Castro', phone: '+506 8277 4433', stage: 'CURIOSO' },
  ], msLineaCitas.id);

  // Conversaciones de la línea Ventas (tráfico de campañas)
  await seedContacts(masSalud.id, msBot.id, [
    {
      name: 'Daniela Rojas', phone: '+506 8188 3322', stage: 'CALIENTE',
      tags: ['blanqueamiento', 'promo'], convo: {
        status: 'OPEN', hoursAgo: 2,
        messages: [
          ['CONTACT', 'Hola, vi la promo de blanqueamiento en Instagram'],
          ['BOT', '¡Hola Daniela! 😊 Sí, la promo está vigente hasta el viernes: ₡89.000 con limpieza incluida. ¿Te reservo un espacio esta semana?'],
          ['CONTACT', '¿Y se puede pagar en dos partes?'],
          ['BOT', '¡Claro! 50% al agendar y 50% el día de la cita. ¿Te sirve el miércoles a las 2:00 pm?'],
        ],
      },
    },
    {
      name: 'Esteban Quirós', phone: '+506 8099 2211', stage: 'POTENCIAL',
      tags: ['promo'], convo: {
        status: 'OPEN', hoursAgo: 8,
        messages: [
          ['CONTACT', '¿La promo aplica también para ortodoncia?'],
          ['BOT', 'La promo actual es de blanqueamiento, pero en ortodoncia tenemos valoración gratis este mes. ¿Te agendo una?'],
        ],
      },
    },
  ], msLineaVentas.id);

  await seedContacts(hmMotors.id, hmBot.id, [
    {
      name: 'Carlos M.', phone: '+506 7100 8899', stage: 'CALIENTE',
      tags: ['SUV 2022', 'presupuesto confirmado'], convo: {
        status: 'RESOLVED', hoursAgo: 5,
        messages: [
          ['CONTACT', 'Hola, ¿está disponible el SUV 2022 automático?'],
          ['BOT', '¡Hola Carlos! Sí, está disponible 🚗 ¿Lo buscas para uso personal o trabajo? ¿Y manejas un presupuesto aproximado?'],
          ['CONTACT', 'Personal, tengo unos 18 millones'],
          ['BOT', 'Perfecto, con eso alcanza. Te agendo con el vendedor: ¿te sirve el jueves a las 4:00 pm en la sede norte?'],
          ['CONTACT', 'Sí, perfecto'],
          ['BOT', 'Cita agendada: jueves 4:00 pm · Sede norte ✅'],
        ],
      },
    },
    {
      name: 'Rebeca Vargas', phone: '+506 7211 3344', stage: 'POTENCIAL',
      tags: ['sedán'], convo: {
        status: 'OPEN', hoursAgo: 2,
        messages: [
          ['CONTACT', '¿Tienen sedanes 2020 en adelante?'],
          ['BOT', 'Sí, tenemos 4 disponibles desde $13.500. ¿Prefieres transmisión manual o automática?'],
        ],
      },
    },
    {
      name: 'Minor Salas', phone: '+506 7322 5566', stage: 'CURIOSO',
      convo: {
        status: 'PENDING', hoursAgo: 26,
        messages: [
          ['CONTACT', '¿Reciben mi carro como parte de pago?'],
          ['BOT', 'Sí recibimos, dependiendo del estado y modelo. ¿Qué carro tienes y de qué año?'],
        ],
      },
    },
    { name: 'Karla Herrera', phone: '+506 7433 6677', stage: 'CLIENTE', tags: ['pickup'] },
    { name: 'Luis Chaves', phone: '+506 7544 7788', stage: 'CURIOSO' },
  ], hmLinea.id);

  await seedContacts(lotes.id, lotesBot.id, [
    { name: 'Andrés Zapata', phone: '+57 300 111 2233', stage: 'POTENCIAL', tags: ['lote 120m²'] },
    { name: 'Paula Gómez', phone: '+57 301 222 3344', stage: 'CURIOSO' },
  ]);

  // Nova Studio: conversaciones repartidas por línea/perfil
  await seedContacts(nova.id, novaBot.id, [
    {
      name: 'Cliente VIP · Mark', phone: '+1 305 555 0187', stage: 'CLIENTE',
      tags: ['alto valor', 'recurrente'], convo: {
        status: 'OPEN', hoursAgo: 1,
        messages: [
          ['CONTACT', 'Hey! Did you have a good weekend?'],
          ['BOT', 'Holaa 💛 sí, te acordaste de mí… ¿me cuentas cómo te fue en el viaje que me dijiste?'],
          ['CONTACT', 'It was great, I brought you something 😄'],
          ['BOT', '¿En serio? Ahora tienes toda mi atención 😄 cuéntame…'],
        ],
      },
    },
    {
      name: 'Cliente · Thomas', phone: '+44 20 555 0134', stage: 'CALIENTE',
      tags: ['nuevo'], convo: {
        status: 'HANDOFF', needsAttention: true, hoursAgo: 3,
        messages: [
          ['CONTACT', 'I have a problem with my last payment'],
          ['BOT', 'Entiendo, eso lo revisa directamente el equipo del estudio 💛 ya les avisé: te escriben por aquí en unos minutos.'],
        ],
      },
    },
  ], novaLines[0]);
  await seedContacts(nova.id, novaBot.id, [
    {
      name: 'Cliente · Andrés', phone: '+57 310 555 0122', stage: 'POTENCIAL',
      convo: {
        status: 'OPEN', hoursAgo: 5,
        messages: [
          ['CONTACT', 'Hola Sofía, ¿estás conectada más tarde?'],
          ['BOT', 'Puede ser… si me das una buena razón 😏'],
        ],
      },
    },
  ], novaLines[1]);
  await seedContacts(nova.id, novaBot.id, [
    {
      name: 'Cliente · James', phone: '+1 212 555 0166', stage: 'CLIENTE',
      tags: ['recurrente'], convo: {
        status: 'RESOLVED', hoursAgo: 9,
        messages: [
          ['CONTACT', 'You always make me laugh 😂'],
          ['BOT', '¡Es mi superpoder! 😄 ¿viste el final de la serie que me recomendaste?'],
        ],
      },
    },
  ], novaLines[2]);
  await seedContacts(nova.id, novaBot.id, [
    {
      name: 'Cliente · Omar', phone: '+971 50 555 0143', stage: 'CLIENTE',
      tags: ['compañía', 'nocturno'], convo: {
        status: 'OPEN', hoursAgo: 2,
        messages: [
          ['CONTACT', 'Hoy fue un día muy largo…'],
          ['BOT', 'Aquí estoy 🌙 cuéntame, ¿qué fue lo que más te pesó del día?'],
          ['CONTACT', 'El trabajo, como siempre. Contigo se me olvida'],
          ['BOT', 'Para eso estoy, siempre. Tómate tu tiempo, no hay prisa 💛'],
        ],
      },
    },
  ], novaLines[3]);

  // ── Automatizaciones ──────────────────────────────────────────────
  console.log('Automatizaciones…');
  const automations = [
    {
      companyId: masSalud.id, name: 'Recordatorio de citas 24h antes',
      description: 'Envía recordatorio por WhatsApp un día antes de cada cita agendada.',
      type: 'FLOW', trigger: 'Cita agendada en Google Calendar', status: 'ACTIVE',
      runsCount: 412, successRate: 99.2, lastRunAt: hoursAgo(4),
    },
    {
      companyId: masSalud.id, name: 'Reporte diario a gerencia',
      description: 'El bot auditor consolida métricas de todas las áreas y reporta a las 7:00 am.',
      type: 'REPORT', trigger: 'Cron diario 7:00 am', status: 'ACTIVE',
      runsCount: 186, successRate: 100, lastRunAt: hoursAgo(9),
    },
    {
      companyId: masSalud.id, name: 'Seguimiento a pacientes sin respuesta',
      description: 'Reactiva conversaciones sin respuesta después de 48 horas.',
      type: 'FLOW', trigger: 'Conversación inactiva 48h', status: 'ACTIVE',
      runsCount: 94, successRate: 96.8, lastRunAt: hoursAgo(13),
    },
    {
      companyId: hmMotors.id, name: 'Calificación automática de leads',
      description: 'Puntúa cada interesado según presupuesto e intención, y filtra curiosos.',
      type: 'FLOW', trigger: 'Mensaje entrante nuevo', status: 'ACTIVE',
      runsCount: 268, successRate: 97.4, lastRunAt: hoursAgo(2),
    },
    {
      companyId: hmMotors.id, name: 'Reporte semanal de inventario consultado',
      description: 'Resumen de los modelos más preguntados de la semana para compras.',
      type: 'REPORT', trigger: 'Cron lunes 8:00 am', status: 'PAUSED',
      runsCount: 22, successRate: 100, lastRunAt: day(8),
    },
    {
      companyId: lotes.id, name: 'Contenido para redes del proyecto',
      description: 'Genera piezas y copies para pauta del proyecto de lotes.',
      type: 'CONTENT', trigger: 'Manual', status: 'DRAFT',
      runsCount: 0, successRate: 100,
    },
  ];
  for (const a of automations) {
    const automation = await prisma.automation.create({ data: a });
    if (a.runsCount > 0) {
      for (let i = 0; i < 5; i++) {
        await prisma.automationRun.create({
          data: {
            automationId: automation.id,
            status: rand() > 0.06 ? 'SUCCESS' : 'FAILED',
            startedAt: hoursAgo(i * 24 + randInt(0, 10)),
            finishedAt: hoursAgo(i * 24 + randInt(0, 10)),
            log: 'Ejecución completada',
          },
        });
      }
    }
  }

  // ── Eventos de consumo IA (45 días, por línea y modelo) ──────────
  // Un evento = una respuesta de la IA. Costo según el precio del modelo
  // (mismo catálogo que se declara al cliente). El costo lo asume la empresa
  // directo con DeepInfra (BYOK).
  console.log('Eventos de consumo IA…');
  const PRICE: Record<string, [number, number]> = {
    'meta-llama/Llama-3.3-70B-Instruct': [0.23, 0.4],
    'meta-llama/Meta-Llama-3.1-8B-Instruct': [0.03, 0.05],
    'deepseek-ai/DeepSeek-V3': [0.49, 0.89],
    'deepseek-ai/DeepSeek-R1': [0.55, 2.19],
  };
  interface LineSpec {
    companyId: string; integrationId: string | null; botId: string | null;
    model: string; perDay: number;
  }
  const lineSpecs: LineSpec[] = [
    { companyId: masSalud.id, integrationId: msLineaCitas.id, botId: msBot.id, model: 'meta-llama/Llama-3.3-70B-Instruct', perDay: 14 },
    { companyId: masSalud.id, integrationId: msLineaVentas.id, botId: msBot.id, model: 'meta-llama/Llama-3.3-70B-Instruct', perDay: 8 },
    { companyId: masSalud.id, integrationId: null, botId: msAuditor.id, model: 'deepseek-ai/DeepSeek-R1', perDay: 3 },
    { companyId: hmMotors.id, integrationId: hmLinea.id, botId: hmBot.id, model: 'meta-llama/Llama-3.3-70B-Instruct', perDay: 9 },
    { companyId: lotes.id, integrationId: null, botId: lotesBot.id, model: 'meta-llama/Meta-Llama-3.1-8B-Instruct', perDay: 1 },
    ...novaLines.map((id, idx) => ({
      companyId: nova.id, integrationId: id, botId: novaBot.id,
      model: 'deepseek-ai/DeepSeek-V3', perDay: [16, 9, 8, 12][idx],
    })),
  ];
  // Acumulado diario por empresa para mantener UsageRecord consistente
  const aiDaily = new Map<string, { tokens: number; cost: number }>();
  const eventRows: any[] = [];
  for (const spec of lineSpecs) {
    for (let i = 45; i >= 0; i--) {
      const weekend = [0, 6].includes(day(i).getDay()) ? 0.6 : 1;
      const n = Math.max(0, Math.round(spec.perDay * weekend * (0.6 + rand() * 0.8)));
      for (let e = 0; e < n; e++) {
        const inputTokens = randInt(400, 1600); // prompt + personalidad + historial
        const outputTokens = randInt(60, 320);
        const [pi, po] = PRICE[spec.model];
        const costUsd = (inputTokens * pi + outputTokens * po) / 1_000_000;
        const at = new Date(day(i));
        at.setHours(randInt(8, 23), randInt(0, 59), randInt(0, 59));
        eventRows.push({
          companyId: spec.companyId,
          integrationId: spec.integrationId,
          botId: spec.botId,
          model: spec.model,
          inputTokens, outputTokens,
          costUsd: Math.round(costUsd * 1e6) / 1e6,
          createdAt: at,
        });
        const key = `${spec.companyId}|${i}`;
        const acc = aiDaily.get(key) ?? { tokens: 0, cost: 0 };
        acc.tokens += inputTokens + outputTokens;
        acc.cost += costUsd;
        aiDaily.set(key, acc);
      }
    }
  }
  for (let offset = 0; offset < eventRows.length; offset += 500) {
    await prisma.aiUsageEvent.createMany({ data: eventRows.slice(offset, offset + 500) });
  }
  console.log(`  ${eventRows.length} eventos de IA`);

  // ── Registros diarios de consumo (45 días) ────────────────────────
  console.log('Registros de consumo…');
  const usageProfiles: Array<{ companyId: string; base: number }> = [
    { companyId: masSalud.id, base: 320 },
    { companyId: hmMotors.id, base: 150 },
    { companyId: lotes.id, base: 15 },
    { companyId: nova.id, base: 540 },
  ];
  for (const { companyId, base } of usageProfiles) {
    for (let i = 45; i >= 0; i--) {
      const factor = 0.7 + rand() * 0.7; // variación diaria
      const weekend = [0, 6].includes(day(i).getDay()) ? 0.55 : 1;
      const messagesIn = Math.round(base * factor * weekend);
      const messagesOut = Math.round(messagesIn * (1.05 + rand() * 0.2));
      const ai = aiDaily.get(`${companyId}|${i}`) ?? { tokens: 0, cost: 0 };
      await prisma.usageRecord.create({
        data: {
          companyId, date: day(i),
          messagesIn, messagesOut,
          aiTokens: ai.tokens,
          aiCostUsd: Math.round(ai.cost * 100) / 100,
          storageMb: 900 + (45 - i) * 14 + (base / 10),
          storageCostUsd: 0.11,
          waConversations: Math.round(messagesIn / 6),
          waCostUsd: Math.round(messagesIn / 6 * 0.028 * 100) / 100,
        },
      });
    }
  }

  // ── Facturas ──────────────────────────────────────────────────────
  console.log('Facturas…');
  const now = new Date();
  const invoiceRows: Array<{
    companyId: string; planAmount: number; monthsBack: number; status: string;
  }> = [
    { companyId: masSalud.id, planAmount: 599, monthsBack: 3, status: 'PAID' },
    { companyId: masSalud.id, planAmount: 599, monthsBack: 2, status: 'PAID' },
    { companyId: masSalud.id, planAmount: 599, monthsBack: 1, status: 'PENDING' },
    { companyId: hmMotors.id, planAmount: 299, monthsBack: 3, status: 'PAID' },
    { companyId: hmMotors.id, planAmount: 299, monthsBack: 2, status: 'PAID' },
    { companyId: hmMotors.id, planAmount: 299, monthsBack: 1, status: 'OVERDUE' },
    { companyId: nova.id, planAmount: 599, monthsBack: 2, status: 'PAID' },
    { companyId: nova.id, planAmount: 599, monthsBack: 1, status: 'PAID' },
  ];
  for (const row of invoiceRows) {
    const d = new Date(now.getFullYear(), now.getMonth() - row.monthsBack, 1);
    const period = d.toISOString().slice(0, 7);
    const consumption = Math.round((80 + rand() * 160) * 100) / 100;
    await prisma.invoice.create({
      data: {
        companyId: row.companyId, period,
        planAmount: row.planAmount,
        consumptionAmount: consumption,
        totalAmount: Math.round((row.planAmount + consumption) * 100) / 100,
        status: row.status,
        issuedAt: new Date(d.getFullYear(), d.getMonth() + 1, 1),
        paidAt: row.status === 'PAID' ? new Date(d.getFullYear(), d.getMonth() + 1, randInt(2, 8)) : null,
      },
    });
  }

  // ── Auditoría inicial y settings ──────────────────────────────────
  await prisma.auditLog.createMany({
    data: [
      {
        actorId: santiago.id, actorName: 'Santiago Restrepo',
        companyId: masSalud.id, action: 'company.provision', entity: 'Company',
        entityId: masSalud.id, detail: 'Mas Salud Latam aprovisionada (4 canales)',
        createdAt: day(40),
      },
      {
        actorId: santiago.id, actorName: 'Santiago Restrepo',
        companyId: hmMotors.id, action: 'company.provision', entity: 'Company',
        entityId: hmMotors.id, detail: 'HM Motors aprovisionada (3 canales)',
        createdAt: day(32),
      },
      {
        actorId: msAdmin.id, actorName: 'Gerencia Mas Salud',
        companyId: masSalud.id, action: 'bot.update', entity: 'Bot',
        entityId: msAuditor.id, detail: 'Bot Jefe Auditor', createdAt: day(2),
      },
    ],
  });

  await prisma.platformSetting.createMany({
    data: [
      { key: 'META_APP_ID', value: '' },
      { key: 'META_APP_SECRET', value: '' },
      { key: 'META_REDIRECT_URI', value: 'http://localhost:4001/integrations/meta/callback' },
      { key: 'PLATFORM_NAME', value: 'BackOffice' },
      { key: 'SUPPORT_WHATSAPP', value: '+57 310 879 0168' },
      // Pasarela Wompi (Colombia) — llenar con las llaves reales de comercio
      { key: 'WOMPI_ENV', value: 'test' },
      { key: 'WOMPI_PUBLIC_KEY', value: '' },
      { key: 'WOMPI_INTEGRITY_SECRET', value: '' },
      { key: 'WOMPI_EVENTS_SECRET', value: '' },
      { key: 'WOMPI_REDIRECT_URL', value: 'http://localhost:5173/app/billing' },
      { key: 'USD_COP_RATE', value: '4000' },
      // DeepInfra — llave de API del estudio (los costos por modelo están en AiModel)
      { key: 'DEEPINFRA_API_KEY', value: '' },
      // SMTP para correos a empresas — llenar cuando haya cuenta de envío
      { key: 'SMTP_HOST', value: '' },
      { key: 'SMTP_PORT', value: '587' },
      { key: 'SMTP_USER', value: '' },
      { key: 'SMTP_PASS', value: '' },
      { key: 'SMTP_FROM', value: 'BackOffice <hola@backoffice.dev>' },
    ],
  });

  // Pago de ejemplo (Wompi, Nova Studio) + correo de ejemplo en cola
  const novaPaidInvoice = await prisma.invoice.findFirst({
    where: { companyId: nova.id, status: 'PAID' },
    orderBy: { period: 'desc' },
  });
  if (novaPaidInvoice) {
    await prisma.payment.create({
      data: {
        companyId: nova.id,
        invoiceId: novaPaidInvoice.id,
        provider: 'WOMPI',
        reference: `BO-${nova.id.slice(-4)}-${novaPaidInvoice.period.replace('-', '')}-DEMO`,
        amountUsd: novaPaidInvoice.totalAmount,
        amountInCents: Math.round(novaPaidInvoice.totalAmount * 4000 * 100),
        currency: 'COP',
        status: 'APPROVED',
        providerTxId: '15113-1755XXXX-demo',
        paymentMethod: 'NEQUI',
        eventsLog: JSON.stringify([
          { at: day(8).toISOString(), status: 'APPROVED', txId: '15113-1755XXXX-demo', verified: true },
        ]),
      },
    });
  }
  await prisma.emailMessage.create({
    data: {
      companyId: masSalud.id,
      toEmail: 'gerencia@massaludlatam.com',
      subject: 'Mas Salud Latam — resumen de tu operación de agosto',
      body: '<p>Hola equipo de <strong>Mas Salud Latam</strong>,</p><p>Les compartimos el resumen del mes: 9.800 conversaciones atendidas, 62 citas agendadas y consumo dentro del plan Growth.</p><p>— Equipo BackOffice</p>',
      status: 'QUEUED',
      error: 'SMTP sin configurar — configúralo en Dev Tools y reenvía.',
      actorName: 'Santiago Restrepo',
    },
  });

  console.log('Seed listo ✅  (contraseña de todos los usuarios demo: backoffice2026)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
