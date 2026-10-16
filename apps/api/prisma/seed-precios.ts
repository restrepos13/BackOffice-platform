/**
 * Precios oct 2026 — IDEMPOTENTE y SIN BORRAR NADA (seguro en producción):
 *  - Planes por RUBRO en COP, IVA incluido, publicados "desde" (el precio final
 *    de cada empresa se ajusta con el cobro personalizable).
 *  - Pago anual = 10 mensualidades por 12 meses (lo calcula el motor de cobro).
 *  - Montaje gratis con permanencia (salida anticipada = montaje proporcional).
 *  - Paquetes prepagos de IA de BackOffice (vencen a los 12 meses).
 *  - Los planes viejos en USD (PRO) quedan inactivos para clientes nuevos; las
 *    empresas que ya los tienen no se tocan.
 * Correr: pnpm --filter @backoffice/api db:seed:precios
 */
import { PrismaClient } from '@prisma/client';


type PlanSeed = {
  code: string; name: string; priceMonthly: number; sortOrder: number;
  maxBots: number; maxWorkspaces: number; maxUsers: number; maxLines: number; maxCouriers: number;
  minTermMonths: number; setupFeeValue: number; highlight: boolean; features: string[];
};

const RUBROS: Record<string, PlanSeed[]> = {
  /* Restaurantes, almuerzos, domicilios y catering */
  COMIDAS: [
    {
      code: 'negocios-esencial', name: 'Esencial', priceMonthly: 149000, sortOrder: 1,
      maxBots: 2, maxWorkspaces: 1, maxUsers: 2, maxLines: 1, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 400000, highlight: false,
      features: [
        'Agente IA con herramientas: menú con precios, pedidos y estado',
        '1 línea de WhatsApp',
        'Página de seguimiento con tu marca',
        'Menú digital con QR',
        'Cobro en el chat (link de pago Wompi y comprobantes)',
        'Promociones y cupones',
        '2 usuarios',
      ],
    },
    {
      code: 'negocios-negocio', name: 'Negocio', priceMonthly: 349000, sortOrder: 2,
      maxBots: 5, maxWorkspaces: 1, maxUsers: 5, maxLines: 2, maxCouriers: 5,
      minTermMonths: 6, setupFeeValue: 1200000, highlight: true,
      features: [
        'Todo Esencial',
        '2 líneas de WhatsApp',
        'Domicilios en vivo: hasta 5 domiciliarios con GPS',
        'Campañas por WhatsApp y seguimiento automático',
        'Respuestas rápidas, comandas y reseñas en Google',
        'Reportes básicos',
        '5 usuarios',
      ],
    },
    {
      code: 'negocios-operacion', name: 'Operación', priceMonthly: 890000, sortOrder: 3,
      maxBots: 15, maxWorkspaces: 3, maxUsers: 15, maxLines: 5, maxCouriers: 999,
      minTermMonths: 12, setupFeeValue: 3000000, highlight: false,
      features: [
        'Todo Negocio',
        '5 líneas de WhatsApp',
        'Domiciliarios ilimitados, sucursales y zonas por barrio',
        'Áreas de producción, agenda con capacidad y pedidos programados',
        'Reporte a gerencia y consultas en lenguaje natural',
        'Facturación electrónica DIAN y pedidos de otras plataformas',
        '15 usuarios',
      ],
    },
  ],
  /* Estudios webcam, agencias y creadores (perfil = modelo) */
  WEBCAM: [
    {
      code: 'webcam-estudio', name: 'Estudio', priceMonthly: 390000, sortOrder: 1,
      maxBots: 5, maxWorkspaces: 1, maxUsers: 5, maxLines: 5, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 600000, highlight: false,
      features: [
        'Hasta 5 perfiles con chatter IA (personalidad y memoria propias)',
        'Una línea por perfil',
        'Galería con precios para vender contenido',
        'Supervisión de conversaciones y modo humano',
        'Métricas por perfil',
        '5 usuarios',
      ],
    },
    {
      code: 'webcam-agencia', name: 'Agencia', priceMonthly: 890000, sortOrder: 2,
      maxBots: 15, maxWorkspaces: 1, maxUsers: 15, maxLines: 15, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 1500000, highlight: true,
      features: [
        'Todo Estudio',
        'Hasta 15 perfiles',
        'Biblioteca de personalidades y reglas de venta por perfil',
        'Campañas y seguimiento automático a fans',
        'Ranking de perfiles y reportes',
        '15 usuarios',
      ],
    },
    {
      code: 'webcam-red', name: 'Red', priceMonthly: 1790000, sortOrder: 3,
      maxBots: 40, maxWorkspaces: 3, maxUsers: 40, maxLines: 40, maxCouriers: 0,
      minTermMonths: 12, setupFeeValue: 3000000, highlight: false,
      features: [
        'Todo Agencia',
        'Hasta 40 perfiles y 3 espacios de trabajo',
        'Reporte a gerencia y consultas en lenguaje natural',
        'Auditoría completa y permisos por rol',
        'API y webhooks',
        '40 usuarios',
      ],
    },
    {
      code: 'webcam-corporativo', name: 'Corporativo', priceMonthly: 2990000, sortOrder: 4,
      maxBots: 999, maxWorkspaces: 10, maxUsers: 999, maxLines: 999, maxCouriers: 0,
      minTermMonths: 12, setupFeeValue: 5000000, highlight: false,
      features: [
        'Más de 40 perfiles, límites a medida',
        'Todo Red',
        'Integraciones privadas y acompañamiento dedicado',
        'Migración asistida',
      ],
    },
  ],
  /* Consultorios, clínicas, salones y talleres (citas) */
  SERVICIOS: [
    {
      code: 'servicios-consultorio', name: 'Consultorio', priceMonthly: 129000, sortOrder: 1,
      maxBots: 2, maxWorkspaces: 1, maxUsers: 3, maxLines: 1, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 300000, highlight: false,
      features: [
        'Recepcionista IA que responde y agenda citas',
        'Agenda con recordatorios automáticos',
        '1 línea de WhatsApp',
        'Base de conocimiento (servicios, precios, políticas)',
        'Respuestas rápidas',
        '3 usuarios',
      ],
    },
    {
      code: 'servicios-centro', name: 'Centro', priceMonthly: 299000, sortOrder: 2,
      maxBots: 5, maxWorkspaces: 1, maxUsers: 8, maxLines: 2, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 900000, highlight: true,
      features: [
        'Todo Consultorio',
        '2 líneas de WhatsApp, Instagram y Messenger',
        'Campañas y seguimiento automático de pacientes o clientes',
        'Embudos configurables y reseñas en Google',
        'Cobro en el chat (Wompi)',
        '8 usuarios',
      ],
    },
    {
      code: 'servicios-red', name: 'Red de sedes', priceMonthly: 690000, sortOrder: 3,
      maxBots: 15, maxWorkspaces: 3, maxUsers: 20, maxLines: 5, maxCouriers: 0,
      minTermMonths: 12, setupFeeValue: 2000000, highlight: false,
      features: [
        'Todo Centro',
        'Varias sedes y 5 líneas',
        'Reporte a gerencia y consultas en lenguaje natural',
        'Facturación electrónica DIAN',
        'API y webhooks',
        '20 usuarios',
      ],
    },
  ],
  /* Inmobiliarias, educación, comercio: CRM + IA que vende */
  VENTAS: [
    {
      code: 'ventas-ventas', name: 'Ventas', priceMonthly: 199000, sortOrder: 1,
      maxBots: 2, maxWorkspaces: 1, maxUsers: 3, maxLines: 1, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 400000, highlight: false,
      features: [
        'Asistente IA que califica y atiende prospectos',
        'CRM con embudos configurables',
        '1 línea de WhatsApp',
        'Base de conocimiento y respuestas rápidas',
        'Exportación de tu base de datos',
        '3 usuarios',
      ],
    },
    {
      code: 'ventas-equipo', name: 'Equipo', priceMonthly: 449000, sortOrder: 2,
      maxBots: 5, maxWorkspaces: 1, maxUsers: 10, maxLines: 3, maxCouriers: 0,
      minTermMonths: 6, setupFeeValue: 1200000, highlight: true,
      features: [
        'Todo Ventas',
        '3 líneas de WhatsApp, Instagram y Messenger',
        'Campañas segmentadas y seguimiento automático',
        'Analytics por línea y por asesor',
        'Agenda y seguimientos',
        '10 usuarios',
      ],
    },
    {
      code: 'ventas-corporativo', name: 'Corporativo', priceMonthly: 990000, sortOrder: 3,
      maxBots: 20, maxWorkspaces: 3, maxUsers: 30, maxLines: 8, maxCouriers: 0,
      minTermMonths: 12, setupFeeValue: 3000000, highlight: false,
      features: [
        'Todo Equipo',
        '8 líneas y 3 espacios de trabajo',
        'Reporte a gerencia y consultas en lenguaje natural',
        'API, webhooks y auditoría completa',
        '30 usuarios',
      ],
    },
  ],
};

const PACKAGES = [
  { name: 'Paquete 500', conversations: 500, price: 99000, sortOrder: 1 },
  { name: 'Paquete 2.000', conversations: 2000, price: 299000, sortOrder: 2 },
  { name: 'Paquete 5.000', conversations: 5000, price: 599000, sortOrder: 3 },
  { name: 'Paquete 15.000', conversations: 15000, price: 1490000, sortOrder: 4 },
];

/** Siembra/actualiza planes por rubro y paquetes (la usa también el seed de producción). */
export async function seedPrecios(prisma: PrismaClient) {
  for (const [line, plans] of Object.entries(RUBROS)) {
    for (const p of plans) {
      const { features, ...data } = p;
      await prisma.plan.upsert({
        where: { code: p.code },
        create: { ...data, line, currency: 'COP', active: true, featuresJson: JSON.stringify(features), includedAiConversations: 0 },
        update: { ...data, line, currency: 'COP', active: true, featuresJson: JSON.stringify(features) },
      });
      console.log(`${line} · ${p.name}: desde COP ${p.priceMonthly.toLocaleString('es-CO')} (anual ${(p.priceMonthly * 10).toLocaleString('es-CO')})`);
    }
  }
  for (const pkg of PACKAGES) {
    const existing = await prisma.aiCreditPackage.findFirst({ where: { name: pkg.name } });
    if (existing) {
      await prisma.aiCreditPackage.update({ where: { id: existing.id }, data: { ...pkg, currency: 'COP', validityMonths: 12, active: true } });
    } else {
      await prisma.aiCreditPackage.create({ data: { ...pkg, currency: 'COP', validityMonths: 12 } });
    }
    console.log(`${pkg.name}: COP ${pkg.price.toLocaleString('es-CO')}`);
  }
  // Planes viejos en USD: no se ofrecen a clientes nuevos (quien los tiene, los conserva)
  const legacy = await prisma.plan.updateMany({
    where: { code: { in: ['starter', 'growth', 'scale', 'enterprise'] } },
    data: { line: 'PRO', currency: 'USD', active: false },
  });
  console.log(`Planes USD heredados desactivados para nuevos: ${legacy.count}`);
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedPrecios(prisma)
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
