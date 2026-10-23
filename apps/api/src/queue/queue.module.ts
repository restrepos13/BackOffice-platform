import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * Colas BullMQ sobre Redis (servicio local de Homebrew).
 *  - wa-inbound:  procesar webhooks entrantes de Twilio (el webhook responde
 *    200 de inmediato y el trabajo pesado ocurre aquí).
 *  - wa-outbound: envío de mensajes con reintentos y backoff exponencial.
 *  - workflow:    ejecuciones del motor de Automation (producciones).
 *  - engine:      procesamiento demorado de conversaciones (agrupa mensajes
 *    consecutivos vía jobs con delay y deduplicación por conversación).
 * Los workers viven en TwilioModule (inbound/outbound) y EngineModule (engine).
 */

export const WA_INBOUND_QUEUE = 'WA_INBOUND_QUEUE';
export const WA_OUTBOUND_QUEUE = 'WA_OUTBOUND_QUEUE';
export const ENGINE_QUEUE = 'ENGINE_QUEUE';
export const WORKFLOW_QUEUE = 'WORKFLOW_QUEUE';

/**
 * Prefijo de las llaves en Redis (BULLMQ_PREFIX). Sin él, el de siempre ("bull").
 * Un entorno aislado (piloto) usa su propio prefijo para no compartir trabajos
 * con otra API conectada al mismo Redis.
 */
export function queuePrefix(): { prefix?: string } {
  const p = String(process.env.BULLMQ_PREFIX ?? '').trim();
  return /^[\w:-]{1,40}$/.test(p) ? { prefix: p } : {};
}

/** REDIS_URL completo: redis:// o rediss:// (TLS), con usuario y clave (Render Key Value, Upstash…). */
export function redisConnection() {
  // Tolera comillas o espacios pegados por error en el panel del hosting
  const raw = String(process.env.REDIS_URL ?? '').trim().replace(/^['"]|['"]$/g, '') || 'redis://localhost:6379';
  let url: URL;
  try {
    url = new URL(raw);
    if (!/^rediss?:$/.test(url.protocol)) throw new Error('protocolo');
  } catch {
    throw new Error(`REDIS_URL inválida: debe verse como redis://usuario:clave@host:6379 o rediss://… (llegó algo que empieza por "${raw.slice(0, 8)}…")`);
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null as null, // requerido por BullMQ
  };
}

const logger = new Logger('Queues');

function makeQueue(name: string): Queue {
  const queue = new Queue(name, {
    connection: redisConnection(),
    ...queuePrefix(),
    defaultJobOptions: {
      removeOnComplete: 500,
      removeOnFail: 2000,
    },
  });
  queue.on('error', (err) => logger.error(`${name}: ${err.message}`));
  return queue;
}

const queues: Queue[] = [];

@Global()
@Module({
  providers: [
    {
      provide: WA_INBOUND_QUEUE,
      useFactory: () => {
        const q = makeQueue('wa-inbound');
        queues.push(q);
        return q;
      },
    },
    {
      provide: WA_OUTBOUND_QUEUE,
      useFactory: () => {
        const q = makeQueue('wa-outbound');
        queues.push(q);
        return q;
      },
    },
    {
      provide: ENGINE_QUEUE,
      useFactory: () => {
        const q = makeQueue('engine');
        queues.push(q);
        return q;
      },
    },
    {
      provide: WORKFLOW_QUEUE,
      useFactory: () => {
        const q = makeQueue('workflow');
        queues.push(q);
        return q;
      },
    },
  ],
  exports: [WA_INBOUND_QUEUE, WA_OUTBOUND_QUEUE, ENGINE_QUEUE, WORKFLOW_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  }
}
