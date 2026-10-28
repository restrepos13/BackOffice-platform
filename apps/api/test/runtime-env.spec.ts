/**
 * Aislamiento desarrollo / producción y protección de los seeds.
 * Todo corre en memoria: ninguna prueba abre una conexión real ni borra datos.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  appEnv,
  assertDatabaseAllowed,
  checkDatabase,
  devDatabaseAllowlist,
  schedulersEnabled,
} from '../src/common/runtime-env';
import { queuePrefix } from '../src/queue/queue.module';
import { checkSeedTarget, prepareSeed } from '../prisma/seed-guard';
import { PrismaService } from '../src/prisma/prisma.service';

const ATLAS = (db: string) => `mongodb+srv://usuario:clave@cluster0.example.mongodb.net/${db}?retryWrites=true`;
const DEV = { DATABASE_URL: ATLAS('backoffice_dev') };
const PROD = { RENDER: 'true', DATABASE_URL: ATLAS('backoffice') };

/** Prisma falso: registra si se intentó borrar algo. */
function fakePrisma(opts: { db: string; companies?: number; users?: number }) {
  const calls: string[] = [];
  return {
    calls,
    $runCommandRaw: async () => ({ db: opts.db }),
    company: { count: async () => opts.companies ?? 0, deleteMany: async () => calls.push('company.deleteMany') },
    user: { count: async () => opts.users ?? 0, deleteMany: async () => calls.push('user.deleteMany') },
  };
}

describe('entorno de ejecución', () => {
  it('producción solo si el hosting o una variable explícita lo dicen', () => {
    expect(appEnv({})).toBe('development');
    expect(appEnv({ NODE_ENV: 'production' })).toBe('development'); // NODE_ENV solo no alcanza
    expect(appEnv({ RENDER: 'true' })).toBe('production');
    expect(appEnv({ HEALTH_ENV: 'prod' })).toBe('production');
    expect(appEnv({ APP_ENV: 'production' })).toBe('production');
  });
});

describe('base de datos permitida por entorno', () => {
  it('desarrollo acepta backoffice_dev', () => {
    expect(checkDatabase(DEV)).toMatchObject({ ok: true, env: 'development', target: { name: 'backoffice_dev', local: false } });
  });

  it('desarrollo rechaza la base de producción, aunque esté en la lista permitida', () => {
    expect(checkDatabase({ DATABASE_URL: ATLAS('backoffice') }).ok).toBe(false);
    const forced = { DATABASE_URL: ATLAS('backoffice'), DEV_DATABASE_ALLOWLIST: 'backoffice,backoffice_dev' };
    expect(devDatabaseAllowlist(forced)).toEqual(['backoffice_dev']);
    expect(checkDatabase(forced).ok).toBe(false);
  });

  it('desarrollo rechaza una base desconocida, una URL sin nombre de base y la ausencia de URL', () => {
    expect(checkDatabase({ DATABASE_URL: ATLAS('otra_base') }).reason).toMatch(/no está permitida/);
    expect(checkDatabase({ DATABASE_URL: 'mongodb+srv://u:p@cluster0.example.mongodb.net/?x=1' }).ok).toBe(false);
    expect(checkDatabase({}).ok).toBe(false);
    expect(checkDatabase({ DATABASE_URL: 'postgres://u:p@h/db' }).ok).toBe(false);
  });

  it('el piloto aislado (base local con «pilot») sigue funcionando; una remota con «pilot» no', () => {
    expect(checkDatabase({ DATABASE_URL: 'mongodb://127.0.0.1:27019/backoffice_lpulpo_pilot?replicaSet=rs0' }).ok).toBe(true);
    expect(checkDatabase({ DATABASE_URL: ATLAS('backoffice_pilot') }).ok).toBe(false);
  });

  it('producción acepta su base y rechaza la de desarrollo', () => {
    expect(checkDatabase(PROD).ok).toBe(true);
    expect(checkDatabase({ RENDER: 'true', DATABASE_URL: ATLAS('backoffice_dev') }).ok).toBe(false);
  });

  it('el mensaje de error nunca incluye credenciales', () => {
    expect(() => assertDatabaseAllowed({ DATABASE_URL: ATLAS('backoffice') })).toThrow(/rechazada/);
    try {
      assertDatabaseAllowed({ DATABASE_URL: ATLAS('backoffice') });
    } catch (e) {
      expect(String(e)).not.toMatch(/clave|usuario/);
    }
  });

  it('la API no se conecta si la base no es válida para el entorno', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.RENDER;
      delete process.env.HEALTH_ENV;
      delete process.env.APP_ENV;
      process.env.DATABASE_URL = ATLAS('backoffice');
      const svc = new PrismaService();
      const connect = jest.spyOn(svc, '$connect').mockResolvedValue(undefined as never);
      await expect(svc.onModuleInit()).rejects.toThrow(/rechazada/);
      expect(connect).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });

  it('la API se niega si la conexión efectiva quedó en otra base', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.RENDER;
      process.env.DATABASE_URL = ATLAS('backoffice_dev');
      const svc = new PrismaService();
      jest.spyOn(svc, '$connect').mockResolvedValue(undefined as never);
      jest.spyOn(svc, '$runCommandRaw').mockResolvedValue({ db: 'backoffice' } as never);
      await expect(svc.onModuleInit()).rejects.toThrow(/se esperaba «backoffice_dev»/);
    } finally {
      process.env = saved;
    }
  });
});

describe('tareas programadas y colas', () => {
  it('en desarrollo los cron quedan apagados salvo SCHEDULERS_ENABLED=1', () => {
    expect(schedulersEnabled(DEV)).toBe(false);
    expect(schedulersEnabled({ ...DEV, SCHEDULERS_ENABLED: 'true' })).toBe(false);
    expect(schedulersEnabled({ ...DEV, SCHEDULERS_ENABLED: '1' })).toBe(true);
    expect(schedulersEnabled(PROD)).toBe(true);
    expect(schedulersEnabled({ ...PROD, SCHEDULERS_ENABLED: '0' })).toBe(false);
  });

  it('AppModule solo registra ScheduleModule cuando schedulersEnabled() lo permite', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'app.module.ts'), 'utf8');
    expect(src).toMatch(/\.\.\.\(schedulersEnabled\(\) \? \[ScheduleModule\.forRoot\(\)\] : \[\]\)/);
    expect(src.match(/ScheduleModule\.forRoot\(\)/g)).toHaveLength(1);
  });

  it('las colas de desarrollo usan su propio prefijo en Redis', () => {
    const saved = { ...process.env };
    try {
      delete process.env.BULLMQ_PREFIX;
      delete process.env.RENDER;
      delete process.env.HEALTH_ENV;
      delete process.env.APP_ENV;
      expect(queuePrefix()).toEqual({ prefix: 'bo-dev' });
      process.env.RENDER = 'true';
      expect(queuePrefix()).toEqual({}); // producción conserva el prefijo de siempre
      process.env.BULLMQ_PREFIX = 'piloto';
      expect(queuePrefix()).toEqual({ prefix: 'piloto' });
    } finally {
      process.env = saved;
    }
  });

  it('todos los workers usan la conexión y el prefijo compartidos', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(__dirname, '..', 'src'));
    let workers = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new Worker\(/g)) {
        workers++;
        const call = src.slice(m.index, (m.index ?? 0) + 400);
        expect(call).toMatch(/queuePrefix\(\)/);
        expect(call).toMatch(/connection(: redisConnection\(\))?[,\s]/);
      }
      // Ningún archivo del API trae una cadena de conexión propia
      expect(src).not.toMatch(/mongodb(\+srv)?:\/\/[^\s'"`]*@/);
    }
    expect(workers).toBeGreaterThanOrEqual(4);
  });

  it('todo script de prisma/ que borra datos pasa por un guardia de entorno', () => {
    const dir = join(__dirname, '..', 'prisma');
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'seed-guard.ts')) {
      const src = readFileSync(join(dir, f), 'utf8');
      if (!/\.(deleteMany|delete)\(/.test(src)) continue;
      // seeds: prepareSeed · recorrido del piloto: se niega fuera de la base local del piloto
      expect([f, /prepareSeed\(|Solo corre contra la base local del piloto/.test(src)]).toEqual([f, true]);
    }
  });
});

describe('protección del seed', () => {
  const OK = { ...DEV, SEED_CONFIRM_DB: 'backoffice_dev' };

  it('funciona en la base de desarrollo autorizada y vacía, sin borrar nada', async () => {
    const p = fakePrisma({ db: 'backoffice_dev' });
    await expect(prepareSeed(p, 'seed', OK)).resolves.toMatchObject({ reset: false, target: { name: 'backoffice_dev' } });
    expect(p.calls).toEqual([]);
  });

  it('falla si falta la autorización', async () => {
    expect(checkSeedTarget(DEV).reason).toMatch(/SEED_CONFIRM_DB=backoffice_dev/);
    await expect(prepareSeed(fakePrisma({ db: 'backoffice_dev' }), 'seed', DEV)).rejects.toThrow(/autorización/);
  });

  it('falla si la autorización no coincide con la base', async () => {
    await expect(prepareSeed(fakePrisma({ db: 'backoffice_dev' }), 'seed', { ...DEV, SEED_CONFIRM_DB: 'backoffice' })).rejects.toThrow(/autorización/);
  });

  it('falla si la base no es la permitida, aunque se confirme', async () => {
    const env = { DATABASE_URL: ATLAS('clientes'), SEED_CONFIRM_DB: 'clientes', SEED_RESET_CONFIRM: 'clientes' };
    await expect(prepareSeed(fakePrisma({ db: 'clientes' }), 'seed', env)).rejects.toThrow(/no está permitida/);
  });

  it('falla en producción aunque todas las variables permisivas estén puestas', async () => {
    const env = {
      ...PROD,
      DEV_DATABASE_ALLOWLIST: 'backoffice',
      SEED_CONFIRM_DB: 'backoffice',
      SEED_RESET_CONFIRM: 'backoffice',
    };
    const p = fakePrisma({ db: 'backoffice', companies: 9 });
    await expect(prepareSeed(p, 'seed', env)).rejects.toThrow(/producción/);
    // Y sin la marca de producción, contra la base de producción, tampoco
    const { RENDER: _r, ...noFlag } = env;
    await expect(prepareSeed(p, 'seed', noFlag)).rejects.toThrow(/rechaz|protegida|producción/);
    expect(p.calls).toEqual([]);
  });

  it('falla si la conexión efectiva no es la base autorizada', async () => {
    await expect(prepareSeed(fakePrisma({ db: 'backoffice' }), 'seed', OK)).rejects.toThrow(/conexión efectiva/);
  });

  it('con datos existentes exige una segunda autorización para borrar', async () => {
    const p = fakePrisma({ db: 'backoffice_dev', companies: 2, users: 5 });
    await expect(prepareSeed(p, 'seed', OK)).rejects.toThrow(/SEED_RESET_CONFIRM=backoffice_dev/);
    await expect(prepareSeed(p, 'seed', { ...OK, SEED_RESET_CONFIRM: 'otra' })).rejects.toThrow(/ya tiene datos/);
    await expect(prepareSeed(p, 'seed', { ...OK, SEED_RESET_CONFIRM: 'backoffice_dev' })).resolves.toMatchObject({ reset: true });
    expect(p.calls).toEqual([]); // el guardia decide; nunca borra por sí mismo
  });

  it('un seed acotado a su empresa no exige base vacía, pero sí todo lo demás', async () => {
    const p = fakePrisma({ db: 'backoffice_dev', companies: 3 });
    await expect(prepareSeed(p, 'seed-nexus', OK, { scoped: true })).resolves.toMatchObject({ reset: false });
    await expect(prepareSeed(p, 'seed-nexus', DEV, { scoped: true })).rejects.toThrow(/autorización/);
  });
});
