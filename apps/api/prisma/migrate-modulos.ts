/**
 * Módulos por rubro (oct 2026): agenda, campañas, galería, gerencia, producción
 * y menú pasan a ser módulos que se prenden por empresa. Esta migración deja a
 * las empresas EXISTENTES viendo exactamente lo que ya veían (idempotente).
 * Correr: pnpm --filter @backoffice/api exec ts-node --transpile-only prisma/migrate-modulos.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, modulesJson: true, onboardingJson: true } });
  for (const c of companies) {
    if (c.onboardingJson?.includes('"source":"SIGNUP"')) continue; // ya nacieron con su rubro
    const modules: string[] = JSON.parse(c.modulesJson || '[]');
    const add = ['agenda', 'campaigns', 'media', 'gerencia', ...(modules.includes('orders') ? ['production', 'menu'] : [])];
    const next = [...new Set([...modules, ...add])];
    if (next.length !== modules.length) {
      await prisma.company.update({ where: { id: c.id }, data: { modulesJson: JSON.stringify(next) } });
      console.log(`${c.name}: + ${add.filter((m) => !modules.includes(m)).join(', ')}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
