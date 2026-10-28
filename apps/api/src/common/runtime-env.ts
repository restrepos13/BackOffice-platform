/**
 * Entorno de ejecución y a qué base puede conectarse cada uno.
 *
 * Producción la marca el hosting (Render define RENDER=true) o una variable
 * explícita (HEALTH_ENV=prod / APP_ENV=production). Todo lo demás es
 * desarrollo, y en desarrollo:
 *  - la API solo arranca contra una base permitida (DEV_DATABASE_ALLOWLIST,
 *    por defecto backoffice_dev) o contra una base LOCAL con «pilot» en el
 *    nombre (entorno aislado del piloto);
 *  - las tareas programadas quedan apagadas salvo SCHEDULERS_ENABLED=1;
 *  - las colas de Redis usan un prefijo propio para no compartir trabajos.
 * Las bases protegidas (la de producción) nunca se aceptan en desarrollo ni
 * para operaciones destructivas, aunque alguien las agregue a la lista.
 * Ninguna función devuelve ni registra la cadena de conexión: solo host y nombre.
 */

type Env = Record<string, string | undefined>;

export type AppEnv = 'production' | 'development';

/** Bases de producción: nunca destino de desarrollo ni de un seed destructivo. */
export const PROTECTED_DATABASES = ['backoffice'];
export const DEFAULT_DEV_DATABASES = ['backoffice_dev'];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const DB_NAME = /^[\w-]{1,64}$/;

export function appEnv(env: Env = process.env): AppEnv {
  const app = String(env.APP_ENV ?? '').trim().toLowerCase();
  if (env.RENDER === 'true' || env.HEALTH_ENV === 'prod' || app === 'production' || app === 'prod') return 'production';
  return 'development';
}

export function isProduction(env: Env = process.env): boolean {
  return appEnv(env) === 'production';
}

export interface DbTarget {
  host: string;
  name: string;
  local: boolean;
}

/** Host y nombre de la base de DATABASE_URL (sin credenciales). null si falta o no se entiende. */
export function databaseTarget(env: Env = process.env): DbTarget | null {
  const raw = String(env.DATABASE_URL ?? '').trim().replace(/^['"]|['"]$/g, '');
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^mongodb(\+srv)?:$/.test(url.protocol)) return null;
    const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
    return { host: url.hostname, name, local: LOCAL_HOSTS.includes(url.hostname) };
  } catch {
    return null;
  }
}

export function isProtectedDatabase(name: string): boolean {
  return PROTECTED_DATABASES.includes(name.toLowerCase());
}

/** Bases permitidas en desarrollo: DEV_DATABASE_ALLOWLIST (separadas por coma) o backoffice_dev. Las protegidas se descartan siempre. */
export function devDatabaseAllowlist(env: Env = process.env): string[] {
  const listed = String(env.DEV_DATABASE_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => DB_NAME.test(s));
  return (listed.length ? listed : DEFAULT_DEV_DATABASES).filter((n) => !isProtectedDatabase(n));
}

export interface DbCheck {
  ok: boolean;
  env: AppEnv;
  target: DbTarget | null;
  reason?: string;
}

/**
 * ¿Puede este proceso usar la base de DATABASE_URL?
 *  - Producción: debe indicar un nombre de base y no ser una de desarrollo.
 *  - Desarrollo: base de la lista permitida, o local con «pilot» en el nombre;
 *    nunca una base protegida en un servidor remoto.
 */
export function checkDatabase(env: Env = process.env): DbCheck {
  const mode = appEnv(env);
  const target = databaseTarget(env);
  const fail = (reason: string): DbCheck => ({ ok: false, env: mode, target, reason });
  if (!target) return fail('DATABASE_URL falta o no es una cadena mongodb:// válida');
  if (!target.name || !DB_NAME.test(target.name)) return fail('DATABASE_URL no indica un nombre de base válido');
  if (mode === 'production') {
    if (devDatabaseAllowlist(env).includes(target.name) || DEFAULT_DEV_DATABASES.includes(target.name)) {
      return fail(`producción apunta a la base de desarrollo «${target.name}»`);
    }
    return { ok: true, env: mode, target };
  }
  if (isProtectedDatabase(target.name) && !target.local) {
    return fail(`desarrollo apunta a la base de producción «${target.name}» (${target.host})`);
  }
  if (devDatabaseAllowlist(env).includes(target.name)) return { ok: true, env: mode, target };
  if (target.local && /pilot/i.test(target.name)) return { ok: true, env: mode, target };
  return fail(
    `la base «${target.name}» no está permitida en desarrollo (permitidas: ${devDatabaseAllowlist(env).join(', ')}; ` +
      'o una base local con «pilot» en el nombre). Si es correcta, agrégala a DEV_DATABASE_ALLOWLIST',
  );
}

/** Lanza si la base no es aceptable para este entorno. Lo llama la API antes de conectarse. */
export function assertDatabaseAllowed(env: Env = process.env): DbTarget {
  const r = checkDatabase(env);
  if (!r.ok || !r.target) throw new Error(`[entorno ${r.env}] conexión rechazada: ${r.reason}`);
  return r.target;
}

/** Tareas programadas (@Cron): encendidas en producción salvo SCHEDULERS_ENABLED=0; apagadas en desarrollo salvo SCHEDULERS_ENABLED=1. */
export function schedulersEnabled(env: Env = process.env): boolean {
  if (env.JEST_WORKER_ID) return false;
  const flag = String(env.SCHEDULERS_ENABLED ?? '').trim();
  if (isProduction(env)) return flag !== '0';
  return flag === '1';
}

/**
 * Prefijo de BullMQ. Si BULLMQ_PREFIX está definido se respeta; si no,
 * producción usa el de siempre ("bull") y desarrollo uno propio, para que una
 * API local nunca tome trabajos de otra conectada al mismo Redis.
 */
export function defaultQueuePrefix(env: Env = process.env): string | undefined {
  return isProduction(env) ? undefined : 'bo-dev';
}
