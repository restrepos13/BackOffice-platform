/**
 * Precios oct 2026 — IDEMPOTENTE y SIN BORRAR NADA (seguro en producción):
 *  - Línea NEGOCIOS en COP (comidas, almuerzos, domicilios) con permanencia
 *    (montaje gratis; salida anticipada cobra el montaje proporcional).
 *  - Paquetes prepagos de IA de BackOffice (vencen a los 12 meses).
 * Los planes PRO en USD no se tocan (se revisan aparte con la competencia).
 * Correr: pnpm --filter @backoffice/api exec ts-node --transpile-only prisma/seed-precios.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEGOCIOS = [
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
];

const PACKAGES = [
  { name: 'Paquete 500', conversations: 500, price: 99000, sortOrder: 1 },
  { name: 'Paquete 2.000', conversations: 2000, price: 299000, sortOrder: 2 },
  { name: 'Paquete 5.000', conversations: 5000, price: 599000, sortOrder: 3 },
  { name: 'Paquete 15.000', conversations: 15000, price: 1490000, sortOrder: 4 },
];

async function main() {
  for (const p of NEGOCIOS) {
    const { features, ...data } = p;
    await prisma.plan.upsert({
      where: { code: p.code },
      create: { ...data, line: 'NEGOCIOS', currency: 'COP', featuresJson: JSON.stringify(features), includedAiConversations: 0 },
      update: { ...data, line: 'NEGOCIOS', currency: 'COP', featuresJson: JSON.stringify(features) },
    });
    console.log(`Plan ${p.name}: COP ${p.priceMonthly.toLocaleString('es-CO')}`);
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
  // Los PRO quedan en USD (se marca la línea explícitamente)
  await prisma.plan.updateMany({ where: { code: { in: ['starter', 'growth', 'scale', 'enterprise'] } }, data: { line: 'PRO', currency: 'USD' } });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
