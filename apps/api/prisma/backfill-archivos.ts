/**
 * Sube a la base (StoredFile) los archivos que solo están en disco local, para que
 * en Render (disco efímero) no falte ninguno. Idempotente.
 * Correr: pnpm --filter @backoffice/api exec ts-node --transpile-only prisma/backfill-archivos.ts
 */
import { PrismaClient } from '@prisma/client';
import { backfillFromDisk } from '../src/common/file-store';

const prisma = new PrismaClient();

async function main() {
  process.env.FILE_STORE = 'db';
  const companies = await prisma.company.findMany({ select: { id: true } });
  const copied = await backfillFromDisk(prisma, companies.map((c) => c.id));
  console.log(`Archivos copiados a la base: ${copied}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
