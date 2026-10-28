/**
 * Protección de los seeds. Un seed solo corre si TODO esto se cumple:
 *  1. El proceso no es de producción (RENDER, HEALTH_ENV=prod o APP_ENV=production).
 *  2. DATABASE_URL apunta a una base de la lista de desarrollo
 *     (DEV_DATABASE_ALLOWLIST, por defecto backoffice_dev) y nunca a una protegida.
 *  3. SEED_CONFIRM_DB repite exactamente el nombre de esa base.
 *  4. La base efectiva de la conexión (dbStats) es la misma que la de la URL.
 * Borrar datos es un paso aparte: si la base ya tiene empresas o usuarios, el
 * seed se niega salvo que SEED_RESET_CONFIRM también repita el nombre de la base.
 * Ninguna variable sola alcanza: en producción o contra una base protegida
 * falla aunque las confirmaciones estén puestas.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { checkDatabase, devDatabaseAllowlist, isProduction, isProtectedDatabase, DbTarget } from '../src/common/runtime-env';

type Env = Record<string, string | undefined>;

let loaded = false;

/** Carga apps/api/.env (o ENV_FILE) sin pisar lo que ya esté en el entorno. */
export function loadApiEnv(env: Env = process.env) {
  if (loaded) return;
  loaded = true;
  const file = join(__dirname, '..', env.ENV_FILE || '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export interface SeedCheck {
  ok: boolean;
  target: DbTarget | null;
  reason?: string;
}

/** Validación previa a conectarse (sin red). */
export function checkSeedTarget(env: Env = process.env): SeedCheck {
  if (isProduction(env)) return { ok: false, target: null, reason: 'este proceso está configurado como producción' };
  const db = checkDatabase(env);
  const target = db.target;
  if (!db.ok || !target) return { ok: false, target, reason: db.reason };
  if (isProtectedDatabase(target.name)) return { ok: false, target, reason: `«${target.name}» es una base protegida` };
  if (!devDatabaseAllowlist(env).includes(target.name)) {
    return { ok: false, target, reason: `«${target.name}» no está en la lista de bases de desarrollo (${devDatabaseAllowlist(env).join(', ')})` };
  }
  if (env.SEED_CONFIRM_DB !== target.name) return { ok: false, target, reason: `falta la autorización: define SEED_CONFIRM_DB=${target.name}` };
  return { ok: true, target };
}

interface SeedPrisma {
  $runCommandRaw(cmd: Record<string, unknown>): Promise<unknown>;
  company: { count(args?: unknown): Promise<number> };
  user: { count(args?: unknown): Promise<number> };
}

/**
 * Comprueba el destino y decide si hace falta limpiar. Lanza si no se puede
 * seguir. reset=true solo si la base tiene datos Y SEED_RESET_CONFIRM lo autoriza.
 * Con scoped=true (seeds que solo rehacen su propia empresa de prueba) no se
 * exige base vacía, pero sí todo lo demás.
 */
export async function prepareSeed(
  prisma: SeedPrisma,
  script: string,
  env: Env = process.env,
  opts: { scoped?: boolean } = {},
): Promise<{ target: DbTarget; reset: boolean }> {
  const pre = checkSeedTarget(env);
  if (!pre.ok || !pre.target) throw new Error(`${script}: no se ejecuta — ${pre.reason}`);
  const target = pre.target;
  const stats = (await prisma.$runCommandRaw({ dbStats: 1 })) as { db?: string };
  if (stats?.db !== target.name) throw new Error(`${script}: la conexión efectiva es «${stats?.db ?? '?'}», no «${target.name}»`);
  if (opts.scoped) return { target, reset: false };
  const existing = (await prisma.company.count()) + (await prisma.user.count());
  if (!existing) return { target, reset: false };
  if (env.SEED_RESET_CONFIRM !== target.name) {
    throw new Error(
      `${script}: la base «${target.name}» ya tiene datos. Para BORRARLOS y volver a sembrar define además SEED_RESET_CONFIRM=${target.name}`,
    );
  }
  return { target, reset: true };
}
