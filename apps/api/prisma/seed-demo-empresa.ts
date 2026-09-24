/**
 * Siembra manual de la empresa DEMO permanente ("Delicias Andinas").
 * La lógica vive en src/demo/demo-company.ts (la comparten el cron semanal
 * que la mantiene fresca y el botón de Dev Tools → Operación).
 *
 * Correr: pnpm db:seed:demo-empresa
 */
import { PrismaClient } from '@prisma/client';
import { seedDemoCompany } from '../src/demo/demo-company';

const prisma = new PrismaClient();

seedDemoCompany(prisma)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
