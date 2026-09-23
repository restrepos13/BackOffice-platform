import { Global, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * Colas BullMQ sobre Redis (servicio local de Homebrew).
 *  - wa-inbound:  procesar webhooks entrantes de Twilio (el webhook responde
 *    200 de inmediato y el trabajo pesado ocurre aquí).
 *  - wa-outbound: envío de mensajes con reintentos y backoff exponencial.
 *  - engine:      procesamiento demorado de conversaciones (agrupa mensajes
 *    consecutivos vía jobs con delay y deduplicación por conversación).
 * Los workers viven en TwilioModule (inbound/outbound) y EngineModule (engine).
 */

export const WA_INBOUND_QUEUE = 'WA_INBOUND_QUEUE';
export const WA_OUTBOUND_QUEUE = 'WA_OUTBOUND_QUEUE';
export const ENGINE_QUEUE = 'ENGINE_QUEUE';

export function redisConnection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
  };
}

const logger = new Logger('Queues');

function makeQueue(name: string): Queue {
  const queue = new Queue(name, {
    connection: redisConnection(),
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
  ],
  exports: [WA_INBOUND_QUEUE, WA_OUTBOUND_QUEUE, ENGINE_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  async onApplicationShutdown() {
    await Promise.all(queues.map((q) => q.close().catch(() => undefined)));
  }
}
