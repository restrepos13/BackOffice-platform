import { DEFAULT_HEALTH_CONFIG, HealthMetrics, dailyStats, evaluateHealth, growthPerDay, healthConfig, healthSummary } from '../src/common/health-rules';
import { percentile, perfSnapshot, recordRequest, resetPerf } from '../src/common/perf-monitor';
import { infoValue } from '../src/modules/platform-health.module';

const base = (): HealthMetrics => ({
  at: '2026-10-21T15:00:00.000Z',
  trm: 3200,
  perf: { requests: 500, errors5xx: 1, p50Ms: 80, p95Ms: 300, rssMb: 200, heapMb: 120, loopP95Ms: 12, uptimeMin: 600 },
  restarts24h: 0,
  days: [],
  mongo: { usedMb: 100, dataMb: 80, indexMb: 20, storageMb: 90, collections: [{ name: 'Message', mb: 60, count: 9000 }], growthMbPerDay: 1 },
  redis: { usedMb: 3, maxMb: 25, queues: [{ name: 'Salientes', waiting: 0, active: 0, delayed: 0, failed: 0 }] },
  ai: { todayUsd: 1, monthUsd: 20, projectionUsd: 40, avg7Usd: 1, top: [{ companyId: 'c1', name: 'Lúa', usd: 12 }], openrouter: { remainingUsd: 20, totalCredits: 25 } },
  quotas: { gemini: [{ label: 'Llave 1', used: 10, limit: 80 }], openrouter: [{ label: 'OR 1', used: 5, limit: 1000 }] },
  companies: [],
});
const levelOf = (m: HealthMetrics, key: string, cfg = DEFAULT_HEALTH_CONFIG) => evaluateHealth(m, cfg).find((c) => c.key === key)!;

describe('salud de la plataforma (reglas sin IA)', () => {
  it('todo sano queda en verde', () => {
    const checks = evaluateHealth(base(), DEFAULT_HEALTH_CONFIG);
    expect(healthSummary(checks)).toMatchObject({ level: 'OK', crit: 0, warn: 0 });
  });

  it('IA: proyección sobre el presupuesto, pico del día y saldo bajo de OpenRouter', () => {
    const m = base();
    m.ai.projectionUsd = 120;
    expect(levelOf(m, 'ai.month').level).toBe('CRIT');
    expect(levelOf(m, 'ai.month').advice).toContain('Lúa');
    m.ai.todayUsd = 3;
    expect(levelOf(m, 'ai.today').level).toBe('WARN'); // 3 veces lo normal
    m.ai.todayUsd = 6;
    expect(levelOf(m, 'ai.today').level).toBe('CRIT'); // pasó el tope diario
    m.ai.openrouter.remainingUsd = 2;
    expect(levelOf(m, 'ai.openrouter').level).toBe('WARN');
    m.ai.openrouter.remainingUsd = null;
    expect(levelOf(m, 'ai.openrouter').level).toBe('NA');
    // Cuenta que nunca compró créditos: solo modelos gratis, no es alerta
    m.ai.openrouter = { remainingUsd: 0, totalCredits: 0 };
    expect(levelOf(m, 'ai.openrouter')).toMatchObject({ level: 'NA', value: 'Cuenta gratis' });
  });

  it('MongoDB: por porcentaje y por días hasta llenarse', () => {
    const m = base();
    m.mongo!.usedMb = 400; // 78 %
    expect(levelOf(m, 'mongo.size').level).toBe('WARN');
    m.mongo!.usedMb = 200;
    m.mongo!.growthMbPerDay = 60; // se llena en 5 días
    const c = levelOf(m, 'mongo.size');
    expect(c.level).toBe('CRIT');
    expect(c.detail).toContain('se llena en unos 5 días');
    expect(c.advice).toContain('Message');
  });

  it('Render: lento, memoria, errores, reinicios y recomendación de subir de plan', () => {
    const m = base();
    m.perf.p95Ms = 2500;
    expect(levelOf(m, 'render.speed').level).toBe('CRIT');
    m.perf.requests = 5;
    expect(levelOf(m, 'render.speed').level).toBe('NA'); // poco tráfico no es señal
    m.perf.requests = 500;
    m.perf.rssMb = 480;
    expect(levelOf(m, 'render.memory').level).toBe('CRIT');
    m.perf.errors5xx = 30;
    expect(levelOf(m, 'render.errors').level).toBe('CRIT');
    m.restarts24h = 4;
    expect(levelOf(m, 'render.restarts').advice).toContain('se duerme');
    expect(levelOf(m, 'render.plan').level).toBe('WARN');
    const ok = base();
    ok.days = [{ day: '2026-10-19', p95Max: 900, rssMaxMb: 200, errorPct: 0 }, { day: '2026-10-20', p95Max: 300, rssMaxMb: 200, errorPct: 0 }];
    expect(levelOf(ok, 'render.plan').level).toBe('OK'); // un día malo no basta
    ok.days.push({ day: '2026-10-18', p95Max: 1000, rssMaxMb: 200, errorPct: 0 }, { day: '2026-10-17', p95Max: 300, rssMaxMb: 450, errorPct: 0 });
    expect(levelOf(ok, 'render.plan').level).toBe('WARN');
  });

  it('Redis, colas, cupos gratis y empresas en riesgo', () => {
    const m = base();
    m.redis!.usedMb = 23;
    expect(levelOf(m, 'redis.memory').level).toBe('CRIT');
    m.redis!.queues[0].failed = 80;
    expect(levelOf(m, 'redis.queues').level).toBe('WARN');
    m.redis = { usedMb: 40, maxMb: null, local: true, queues: [] };
    expect(levelOf(m, 'redis.memory').level).toBe('NA'); // Redis de un computador: sin límite
    expect(levelOf(m, 'redis.queues').level).toBe('OK');
    m.redis = null;
    expect(levelOf(m, 'redis.memory').level).toBe('CRIT');
    m.quotas.gemini = [{ label: 'Llave 1', used: 70, limit: 80 }];
    expect(levelOf(m, 'quota.gemini').level).toBe('WARN');
    m.quotas.gemini = [{ label: 'Llave 1', used: 80, limit: 80 }];
    expect(levelOf(m, 'quota.gemini').level).toBe('CRIT');
    m.companies = [{ id: 'c1', name: 'Lúa', reasons: ['WhatsApp desconectado'] }];
    expect(levelOf(m, 'companies.risk')).toMatchObject({ level: 'WARN', value: '1 empresa' });
  });

  it('config: solo números válidos; el plan como texto', () => {
    const c = healthConfig({ mongoLimitMb: '2048', renderPlan: 'Starter', p95WarnMs: -5, hack: 1 });
    expect(c).toMatchObject({ mongoLimitMb: 2048, renderPlan: 'Starter', p95WarnMs: 800 });
    expect((c as any).hack).toBeUndefined();
  });

  it('tendencias: crecimiento por día y estadística diaria', () => {
    const t0 = new Date('2026-10-14T12:00:00Z').getTime();
    const pts = Array.from({ length: 8 }, (_, i) => ({ at: new Date(t0 + i * 86400e3), mb: 100 + i * 4 }));
    expect(growthPerDay(pts)).toBe(4);
    expect(growthPerDay(pts.slice(0, 3))).toBeNull();
    const days = dailyStats([
      { at: '2026-10-20T15:00:00Z', data: { perf: { p95Ms: 400, requests: 50, rssMb: 210, requests10: 50, errors10: 1 } } },
      { at: '2026-10-20T16:00:00Z', data: { perf: { p95Ms: 900, requests: 50, rssMb: 260, requests10: 50, errors10: 0 } } },
    ], 7, new Date('2026-10-21T12:00:00Z'));
    expect(days).toEqual([{ day: '2026-10-20', p95Max: 900, rssMaxMb: 260, errorPct: 1 }]);
  });

  it('medidor interno: percentiles, 5xx y lectura de Redis INFO', () => {
    resetPerf();
    const now = Date.now();
    for (let i = 1; i <= 100; i++) recordRequest(i, i === 100 ? 500 : 200, now);
    const s = perfSnapshot(60, now);
    expect(s).toMatchObject({ requests: 100, errors5xx: 1, p50Ms: 50, p95Ms: 95 });
    expect(percentile([], 95)).toBeNull();
    expect(infoValue('# Memory\r\nused_memory:3145728\r\nmaxmemory:26214400\r\n', 'maxmemory')).toBe(26214400);
  });
});
