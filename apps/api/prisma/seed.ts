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
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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
    prisma.user.deleteMany(),
    prisma.company.deleteMany(),
    prisma.plan.deleteMany(),
    prisma.platformSetting.deleteMany(),
  ]);

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
      model: 'claude-sonnet-5', temperature: 0.6,
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
      model: 'claude-opus-5', temperature: 0.3,
      systemPrompt:
        'Eres el bot auditor de Mas Salud Latam. Supervisas citas, ventas y seguimientos, y reportas a gerencia con métricas y alertas accionables.',
      personalityJson: JSON.stringify({
        tone: 'Directo y ejecutivo', style: 'Reportes con datos', language: 'es',
      }),
    },
  });
  await prisma.integration.createMany({
    data: [
      {
        companyId: masSalud.id, botId: msBot.id, type: 'WHATSAPP',
        name: 'WhatsApp Business API', status: 'CONNECTED',
        configJson: JSON.stringify({
          displayPhone: '+506 8888 1234', phoneNumberId: '1042XXXX', wabaId: '2231XXXX',
        }),
        webhookUrl: 'http://localhost:4001/api/webhooks/mas-salud-latam/whatsapp',
        lastSyncAt: hoursAgo(1),
      },
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
      model: 'claude-sonnet-5', temperature: 0.7,
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
  await prisma.integration.createMany({
    data: [
      {
        companyId: hmMotors.id, botId: hmBot.id, type: 'WHATSAPP',
        name: 'WhatsApp Business API', status: 'CONNECTED',
        configJson: JSON.stringify({
          displayPhone: '+506 7000 2222', phoneNumberId: '1099XXXX', wabaId: '2255XXXX',
        }),
        webhookUrl: 'http://localhost:4001/api/webhooks/hm-motors/whatsapp',
        lastSyncAt: hoursAgo(1),
      },
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
      model: 'claude-sonnet-5',
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
    companyId: string, botId: string, list: SeedContact[],
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
            companyId, botId, contactId: contact.id,
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
    { name: 'Daniela Rojas', phone: '+506 8188 3322', stage: 'CALIENTE', tags: ['blanqueamiento'] },
  ]);

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
  ]);

  await seedContacts(lotes.id, lotesBot.id, [
    { name: 'Andrés Zapata', phone: '+57 300 111 2233', stage: 'POTENCIAL', tags: ['lote 120m²'] },
    { name: 'Paula Gómez', phone: '+57 301 222 3344', stage: 'CURIOSO' },
  ]);

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

  // ── Consumo (45 días) ─────────────────────────────────────────────
  console.log('Registros de consumo…');
  const usageProfiles: Array<{ companyId: string; base: number }> = [
    { companyId: masSalud.id, base: 320 },
    { companyId: hmMotors.id, base: 150 },
    { companyId: lotes.id, base: 15 },
  ];
  for (const { companyId, base } of usageProfiles) {
    for (let i = 45; i >= 0; i--) {
      const factor = 0.7 + rand() * 0.7; // variación diaria
      const weekend = [0, 6].includes(day(i).getDay()) ? 0.55 : 1;
      const messagesIn = Math.round(base * factor * weekend);
      const messagesOut = Math.round(messagesIn * (1.05 + rand() * 0.2));
      const aiTokens = messagesOut * randInt(160, 260);
      await prisma.usageRecord.create({
        data: {
          companyId, date: day(i),
          messagesIn, messagesOut, aiTokens,
          aiCostUsd: Math.round(aiTokens * 0.000011 * 100) / 100,
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
    ],
  });

  console.log('Seed listo ✅  (contraseña de todos los usuarios demo: backoffice2026)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
