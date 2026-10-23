/**
 * Inicializa el espacio del piloto LPulpo en una base AISLADA. No crea datos
 * comerciales, tarifas, modelos ni producciones: solo la empresa, su
 * configuración inicial (todo lo comercial queda PENDIENTE) y los usuarios.
 *
 * Se niega a correr si:
 *  - PILOT_BOOTSTRAP_CONFIRM no es exactamente el nombre de la base;
 *  - la base no es local (127.0.0.1/localhost) ni su nombre contiene «pilot»;
 *  - la base ya tiene empresas distintas de LPulpo (no es la base del piloto).
 * Es idempotente: repetirlo no duplica nada ni cambia contraseñas existentes.
 *
 * Uso (desde apps/api, con las variables del piloto cargadas):
 *   PILOT_BOOTSTRAP_CONFIRM=<nombre de la base> PILOT_ADMIN_EMAIL=… PILOT_ADMIN_PASSWORD=… \
 *     npx ts-node --transpile-only prisma/pilot-bootstrap.ts
 * Las contraseñas se leen del entorno y nunca se imprimen.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { defaultConfig } from '../src/common/productions';

function target() {
  const raw = String(process.env.DATABASE_URL ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) throw new Error('Falta DATABASE_URL');
  const url = new URL(raw);
  return { host: url.hostname, db: url.pathname.replace(/^\//, ''), local: ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) };
}

async function main() {
  const t = target();
  if (!t.db) throw new Error('DATABASE_URL no indica el nombre de la base');
  if (!t.local && !/pilot/i.test(t.db)) throw new Error(`Base rechazada: «${t.db}» no es local ni su nombre contiene «pilot»`);
  if (process.env.PILOT_BOOTSTRAP_CONFIRM !== t.db) throw new Error(`Para confirmar, define PILOT_BOOTSTRAP_CONFIRM=${t.db}`);
  const prisma = new PrismaClient();
  try {
    const others = await prisma.company.findMany({ where: { slug: { not: 'lpulpo' } }, select: { slug: true }, take: 5 });
    if (others.length) throw new Error(`La base ya tiene otras empresas (${others.map((o) => o.slug).join(', ')}): no es la base aislada del piloto`);

    const company = await prisma.company.upsert({
      where: { slug: 'lpulpo' },
      update: {},
      create: {
        name: 'LPulpo', slug: 'lpulpo', status: 'ACTIVE', timezone: 'America/Bogota', currency: 'COP',
        // Automation primero; Ads Intelligence en solo lectura; Creative después
        productsJson: JSON.stringify({ AUTOMATION: { enabled: true }, ADS: { enabled: true }, CREATIVE: { enabled: false } }),
        modulesJson: JSON.stringify(['inbox', 'contacts', 'bots', 'analytics', 'billing', 'team', 'agenda', 'productions']),
      },
    });
    await prisma.productionSettings.upsert({
      where: { companyId: company.id },
      update: {},
      create: { companyId: company.id, configJson: JSON.stringify(defaultConfig()), updatedBy: 'pilot-bootstrap' },
    });

    const users: Array<{ email?: string; password?: string; name: string; role: string; companyId: string | null; label: string }> = [
      { email: process.env.PILOT_ADMIN_EMAIL, password: process.env.PILOT_ADMIN_PASSWORD, name: process.env.PILOT_ADMIN_NAME || 'Administración LPulpo', role: 'COMPANY_ADMIN', companyId: company.id, label: 'administrador de LPulpo' },
      { email: process.env.PILOT_DEV_EMAIL, password: process.env.PILOT_DEV_PASSWORD, name: process.env.PILOT_DEV_NAME || 'Equipo BackOffice', role: 'SUPER_ADMIN', companyId: null, label: 'plataforma (equipo BackOffice)' },
    ];
    for (const u of users) {
      if (!u.email || !u.password) {
        console.log(`· Usuario ${u.label}: omitido (faltan variables)`);
        continue;
      }
      if (u.password.length < 12) throw new Error(`La contraseña del usuario ${u.label} debe tener al menos 12 caracteres`);
      const exists = await prisma.user.findUnique({ where: { email: u.email.toLowerCase() } });
      if (exists) {
        console.log(`· Usuario ${u.label}: ya existe (no se cambió la contraseña)`);
        continue;
      }
      await prisma.user.create({ data: { email: u.email.toLowerCase(), name: u.name, role: u.role, companyId: u.companyId, passwordHash: bcrypt.hashSync(u.password, 12), active: true } });
      console.log(`· Usuario ${u.label}: creado`);
    }
    console.log(`Listo: empresa LPulpo en la base «${t.db}» (${t.local ? 'local' : 'remota'}). Sin datos comerciales ni de prueba.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`No se inicializó: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
