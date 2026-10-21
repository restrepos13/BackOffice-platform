/**
 * Reglas de salud de la plataforma (Plataforma → Salud). Sin IA: umbrales,
 * proporciones y tendencias. Recibe métricas ya medidas y devuelve semáforos
 * con un consejo concreto ("sube de plan", "limpia esta colección").
 * Los límites de cada plan y los umbrales los editan los devs (HEALTH_CONFIG).
 */

export type Level = 'OK' | 'WARN' | 'CRIT' | 'NA';
export type Area = 'IA' | 'MONGO' | 'RENDER' | 'REDIS' | 'CUPOS' | 'EMPRESAS';

export interface HealthConfig {
  /** Gasto de IA que pagamos nosotros (US$) */
  aiDailyBudgetUsd: number;
  aiMonthlyBudgetUsd: number;
  /** Pico: hoy cuesta más de N veces el promedio de 7 días */
  aiSpikeFactor: number;
  aiSpikeMinUsd: number;
  openrouterMinCreditUsd: number;
  /** MongoDB Atlas (M0 gratis = 512 MB) */
  mongoLimitMb: number;
  mongoWarnPct: number;
  mongoCritPct: number;
  /** Render (Free y Starter = 512 MB) */
  renderPlan: string;
  renderRamMb: number;
  ramWarnPct: number;
  ramCritPct: number;
  p95WarnMs: number;
  p95CritMs: number;
  errorWarnPct: number;
  errorCritPct: number;
  restartsWarn: number;
  /** Días (de los últimos 7) por encima del umbral para recomendar subir de plan */
  upgradeAfterDays: number;
  /** Redis: si el servidor no informa su límite, se usa este (Render Key Value Free = 25 MB) */
  redisLimitMb: number;
  redisWarnPct: number;
  redisCritPct: number;
  queueWaitingWarn: number;
  queueFailedWarn: number;
  /** Cupos gratis */
  quotaWarnPct: number;
  /** OpenRouter: pedidos gratis al día (50 sin saldo; 1.000 con 10+ créditos) */
  openrouterFreeDailyLimit: number;
  /** Empresas en riesgo */
  inactiveDays: number;
  invoiceOverdueDays: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  aiDailyBudgetUsd: 5,
  aiMonthlyBudgetUsd: 100,
  aiSpikeFactor: 2,
  aiSpikeMinUsd: 0.5,
  openrouterMinCreditUsd: 5,
  mongoLimitMb: 512,
  mongoWarnPct: 70,
  mongoCritPct: 85,
  renderPlan: 'Free',
  renderRamMb: 512,
  ramWarnPct: 75,
  ramCritPct: 90,
  p95WarnMs: 800,
  p95CritMs: 2000,
  errorWarnPct: 2,
  errorCritPct: 5,
  restartsWarn: 3,
  upgradeAfterDays: 3,
  redisLimitMb: 25,
  redisWarnPct: 70,
  redisCritPct: 85,
  queueWaitingWarn: 100,
  queueFailedWarn: 50,
  quotaWarnPct: 80,
  openrouterFreeDailyLimit: 50,
  inactiveDays: 7,
  invoiceOverdueDays: 15,
};

/** Mezcla lo guardado con los valores por defecto (solo números válidos; el plan como texto). */
export function healthConfig(raw: unknown): HealthConfig {
  const o: Record<string, unknown> = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: any = { ...DEFAULT_HEALTH_CONFIG };
  for (const [k, def] of Object.entries(DEFAULT_HEALTH_CONFIG)) {
    if (!(k in o)) continue;
    if (typeof def === 'number') {
      const n = Number(o[k]);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    } else if (typeof o[k] === 'string' && String(o[k]).trim()) {
      out[k] = String(o[k]).trim().slice(0, 40);
    }
  }
  return out;
}

export interface DayStat { day: string; p95Max: number | null; rssMaxMb: number | null; errorPct: number | null }

export interface HealthMetrics {
  at: string;
  trm: number;
  perf: { requests: number; errors5xx: number; p50Ms: number | null; p95Ms: number | null; rssMb: number; heapMb: number; loopP95Ms: number; uptimeMin: number };
  restarts24h: number;
  days: DayStat[];
  mongo: { usedMb: number; dataMb: number; indexMb: number; storageMb: number; collections: Array<{ name: string; mb: number; count: number }>; growthMbPerDay: number | null } | null;
  redis: { usedMb: number; maxMb: number | null; local?: boolean; queues: Array<{ name: string; waiting: number; active: number; delayed: number; failed: number }> } | null;
  ai: { todayUsd: number; monthUsd: number; projectionUsd: number; avg7Usd: number; top: Array<{ companyId: string; name: string; usd: number }>; openrouter: { remainingUsd: number | null; totalCredits: number | null } };
  quotas: { gemini: Array<{ label: string; used: number; limit: number }>; openrouter: Array<{ label: string; used: number; limit: number }> };
  companies: Array<{ id: string; name: string; reasons: string[] }>;
  /** Controles de seguridad del servidor (producción) */
  security?: { production: boolean; trustProxyHops: number; metaSecret: boolean; wompiEventsSecret: boolean; platformMfaRequired: boolean; platformWithoutMfa: number };
}

export interface HealthCheck {
  key: string;
  area: Area;
  title: string;
  level: Level;
  value: string;
  detail: string;
  advice?: string;
}

const usd = (n: number) => `US$${n.toFixed(n < 10 ? 2 : 0)}`;
const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

function byPct(value: number, warn: number, crit: number): Level {
  return value >= crit ? 'CRIT' : value >= warn ? 'WARN' : 'OK';
}

export function evaluateHealth(m: HealthMetrics, c: HealthConfig): HealthCheck[] {
  const out: HealthCheck[] = [];

  /* ── 1. Gasto de IA que pagamos nosotros ── */
  const monthPct = pct(m.ai.projectionUsd, c.aiMonthlyBudgetUsd);
  out.push({
    key: 'ai.month', area: 'IA', title: 'Gasto de IA del mes (lo pagamos nosotros)',
    level: c.aiMonthlyBudgetUsd > 0 ? byPct(monthPct, 80, 100) : 'NA',
    value: `${usd(m.ai.monthUsd)} · cierre ≈ ${usd(m.ai.projectionUsd)}`,
    detail: `≈ ${cop(m.ai.monthUsd * m.trm)} en lo que va del mes; al ritmo actual cierra en ${cop(m.ai.projectionUsd * m.trm)} (${monthPct}% del presupuesto de ${usd(c.aiMonthlyBudgetUsd)}).`,
    advice: monthPct >= 80 ? `Revisa quién más gasta${m.ai.top[0] ? ` (${m.ai.top[0].name}: ${usd(m.ai.top[0].usd)})` : ''}. Si es crecimiento real, sube el presupuesto o ajusta el precio de "Todo incluido".` : undefined,
  });
  const spike = m.ai.todayUsd >= Math.max(c.aiSpikeMinUsd, m.ai.avg7Usd * c.aiSpikeFactor) && m.ai.avg7Usd > 0;
  const overDay = c.aiDailyBudgetUsd > 0 && m.ai.todayUsd >= c.aiDailyBudgetUsd;
  out.push({
    key: 'ai.today', area: 'IA', title: 'Gasto de IA de hoy',
    level: overDay ? 'CRIT' : spike ? 'WARN' : 'OK',
    value: usd(m.ai.todayUsd),
    detail: `Promedio de los últimos 7 días: ${usd(m.ai.avg7Usd)} al día. Tope diario: ${usd(c.aiDailyBudgetUsd)}.`,
    advice: overDay ? 'Pasó el tope del día: revisa si una empresa entró en bucle o recibe spam.' : spike ? `Hoy va ${m.ai.avg7Usd > 0 ? (m.ai.todayUsd / m.ai.avg7Usd).toFixed(1) : '—'} veces lo normal. Mira las empresas que más gastan.` : undefined,
  });
  const credit = m.ai.openrouter.remainingUsd;
  // Cuenta que nunca compró créditos: solo usa modelos gratis, no es una alerta
  const neverBought = credit != null && (m.ai.openrouter.totalCredits ?? 0) <= 0;
  out.push({
    key: 'ai.openrouter', area: 'IA', title: 'Saldo de OpenRouter',
    level: credit == null || neverBought ? 'NA' : credit <= 0 ? 'CRIT' : credit < c.openrouterMinCreditUsd ? 'WARN' : 'OK',
    value: credit == null ? 'Sin dato' : neverBought ? 'Cuenta gratis' : usd(credit),
    detail: credit == null
      ? 'No hay llave de OpenRouter o no respondió.'
      : neverBought
        ? 'Solo usa modelos gratis (registro). Claude Haiku y los modelos de pago necesitan créditos.'
        : `Créditos comprados: ${usd(m.ai.openrouter.totalCredits ?? 0)}. Mínimo de alerta: ${usd(c.openrouterMinCreditUsd)}.`,
    advice: credit != null && !neverBought && credit < c.openrouterMinCreditUsd ? 'Recarga créditos en openrouter.ai para no quedarte sin Claude Haiku ni modelos de pago.' : undefined,
  });

  /* ── 2. MongoDB Atlas ── */
  if (!m.mongo) {
    out.push({ key: 'mongo.size', area: 'MONGO', title: 'Espacio de MongoDB', level: 'NA', value: 'Sin dato', detail: 'No se pudo leer el tamaño de la base.' });
  } else {
    const used = pct(m.mongo.usedMb, c.mongoLimitMb);
    const left = c.mongoLimitMb - m.mongo.usedMb;
    const days = m.mongo.growthMbPerDay && m.mongo.growthMbPerDay > 0 ? Math.floor(left / m.mongo.growthMbPerDay) : null;
    const byDays: Level = days == null ? 'OK' : days < 7 ? 'CRIT' : days < 30 ? 'WARN' : 'OK';
    const level = [byPct(used, c.mongoWarnPct, c.mongoCritPct), byDays].includes('CRIT') ? 'CRIT' : [byPct(used, c.mongoWarnPct, c.mongoCritPct), byDays].includes('WARN') ? 'WARN' : 'OK';
    const big = m.mongo.collections.slice(0, 3).map((x) => `${x.name} (${x.mb} MB)`).join(', ');
    out.push({
      key: 'mongo.size', area: 'MONGO', title: 'Espacio de MongoDB',
      level,
      value: `${m.mongo.usedMb} de ${c.mongoLimitMb} MB (${used}%)`,
      detail: `Datos ${m.mongo.dataMb} MB + índices ${m.mongo.indexMb} MB. ${m.mongo.growthMbPerDay != null ? `Crece ${m.mongo.growthMbPerDay} MB al día${days != null ? `: se llena en unos ${days} días` : ''}.` : 'Aún no hay historial para medir el crecimiento.'} Lo que más pesa: ${big || '—'}.`,
      advice: level === 'OK' ? undefined : `Sube el plan de Atlas (de M0 a M10) o limpia lo que más pesa${big ? ` (${big})` : ''}.`,
    });
  }

  /* ── 3. Render ── */
  const enough = m.perf.requests >= 20;
  out.push({
    key: 'render.speed', area: 'RENDER', title: 'Velocidad de respuesta (última hora)',
    level: !enough || m.perf.p95Ms == null ? 'NA' : m.perf.p95Ms >= c.p95CritMs ? 'CRIT' : m.perf.p95Ms >= c.p95WarnMs ? 'WARN' : 'OK',
    value: !enough || m.perf.p95Ms == null ? 'Poco tráfico para medir' : `La mitad en ${m.perf.p50Ms} ms · 95% en ${m.perf.p95Ms} ms`,
    detail: `${m.perf.requests} peticiones en la última hora. Retraso del servidor: ${m.perf.loopP95Ms} ms. Umbrales: ${c.p95WarnMs} / ${c.p95CritMs} ms.`,
  });
  const ram = pct(m.perf.rssMb, c.renderRamMb);
  out.push({
    key: 'render.memory', area: 'RENDER', title: 'Memoria del servidor',
    level: byPct(ram, c.ramWarnPct, c.ramCritPct),
    value: `${m.perf.rssMb} de ${c.renderRamMb} MB (${ram}%)`,
    detail: `Plan ${c.renderPlan}. Si llega al 100% Render reinicia el servidor y se cortan las respuestas.`,
  });
  const errPct = m.perf.requests ? Math.round((m.perf.errors5xx / m.perf.requests) * 1000) / 10 : 0;
  out.push({
    key: 'render.errors', area: 'RENDER', title: 'Errores del servidor (última hora)',
    level: !enough ? 'NA' : errPct >= c.errorCritPct ? 'CRIT' : errPct >= c.errorWarnPct ? 'WARN' : 'OK',
    value: `${m.perf.errors5xx} errores (${errPct}%)`,
    detail: 'Respuestas 5xx: algo falló de nuestro lado. El detalle está en Dev Tools → Logs.',
  });
  out.push({
    key: 'render.restarts', area: 'RENDER', title: 'Reinicios en 24 horas',
    level: m.restarts24h >= c.restartsWarn ? 'WARN' : 'OK',
    value: String(m.restarts24h),
    detail: `Encendido hace ${m.perf.uptimeMin < 120 ? `${m.perf.uptimeMin} min` : `${Math.round(m.perf.uptimeMin / 60)} h`}.`,
    advice: m.restarts24h >= c.restartsWarn
      ? (/free/i.test(c.renderPlan) ? 'En el plan Free el servidor se duerme tras 15 minutos sin uso y el primer cliente espera casi un minuto. El plan Starter lo mantiene despierto.' : 'Revisa los logs: puede ser falta de memoria.')
      : undefined,
  });
  const badDays = m.days.filter((d) => (d.p95Max != null && d.p95Max >= c.p95WarnMs) || (d.rssMaxMb != null && pct(d.rssMaxMb, c.renderRamMb) >= c.ramWarnPct) || (d.errorPct != null && d.errorPct >= c.errorWarnPct));
  const recommend = badDays.length >= c.upgradeAfterDays || (/free/i.test(c.renderPlan) && m.restarts24h >= c.restartsWarn);
  out.push({
    key: 'render.plan', area: 'RENDER', title: '¿Subir el plan de Render?',
    level: recommend ? 'WARN' : 'OK',
    value: recommend ? 'Sí, se recomienda' : 'Por ahora no',
    detail: `${badDays.length} de los últimos ${m.days.length || 0} días estuvo lento, con poca memoria o con errores (se recomienda desde ${c.upgradeAfterDays}).`,
    advice: recommend ? `Pasa del plan ${c.renderPlan} al siguiente (más memoria y CPU${/free/i.test(c.renderPlan) ? ', y sin dormirse' : ''}).` : undefined,
  });

  /* ── 4. Redis y colas ── */
  if (!m.redis) {
    out.push({ key: 'redis.memory', area: 'REDIS', title: 'Redis (colas de mensajes)', level: 'CRIT', value: 'Sin conexión', detail: 'Sin Redis no salen ni entran mensajes de WhatsApp.', advice: 'Revisa REDIS_URL y el servicio Key Value en Render.' });
  } else if (!m.redis.maxMb && m.redis.local) {
    out.push({ key: 'redis.memory', area: 'REDIS', title: 'Memoria de Redis', level: 'NA', value: `${m.redis.usedMb} MB`, detail: 'Redis de este computador: no tiene límite. En Render el límite lo informa el servidor.' });
  } else {
    const limit = m.redis.maxMb && m.redis.maxMb > 0 ? m.redis.maxMb : c.redisLimitMb;
    const used = pct(m.redis.usedMb, limit);
    const level = byPct(used, c.redisWarnPct, c.redisCritPct);
    out.push({
      key: 'redis.memory', area: 'REDIS', title: 'Memoria de Redis',
      level,
      value: `${m.redis.usedMb} de ${limit} MB (${used}%)`,
      detail: m.redis.maxMb ? 'Límite informado por el servidor de Redis.' : `Límite tomado de la configuración (${c.redisLimitMb} MB).`,
      advice: level === 'OK' ? undefined : 'Sube el plan de Key Value en Render o baja cuántos trabajos terminados se guardan.',
    });
  }
  if (m.redis) {
    const waiting = m.redis.queues.reduce((n, q) => n + q.waiting + q.delayed, 0);
    const failed = m.redis.queues.reduce((n, q) => n + q.failed, 0);
    out.push({
      key: 'redis.queues', area: 'REDIS', title: 'Colas de mensajes',
      level: failed >= c.queueFailedWarn || waiting >= c.queueWaitingWarn ? 'WARN' : 'OK',
      value: `${waiting} en espera · ${failed} fallidos`,
      detail: m.redis.queues.map((q) => `${q.name}: ${q.waiting} esperando, ${q.active} activos, ${q.failed} fallidos`).join(' · '),
      advice: failed >= c.queueFailedWarn ? 'Reintenta los fallidos desde Dev Tools y revisa los logs.' : waiting >= c.queueWaitingWarn ? 'Los mensajes se están acumulando: el servidor no da abasto.' : undefined,
    });
  }

  /* ── 5. Cupos gratis ── */
  const quota = (key: string, title: string, rows: Array<{ label: string; used: number; limit: number }>) => {
    if (!rows.length) {
      out.push({ key, area: 'CUPOS', title, level: 'NA', value: 'Sin llaves', detail: 'No hay llaves configuradas.' });
      return;
    }
    const worst = Math.max(...rows.map((r) => pct(r.used, r.limit)));
    const allOut = rows.every((r) => r.used >= r.limit);
    out.push({
      key, area: 'CUPOS', title,
      level: allOut ? 'CRIT' : worst >= c.quotaWarnPct ? 'WARN' : 'OK',
      value: rows.map((r) => `${r.used}/${r.limit}`).join(' · '),
      detail: rows.map((r) => `${r.label}: ${pct(r.used, r.limit)}%`).join(' · '),
      advice: allOut ? 'Todas las llaves se agotaron hoy: el registro usa el plan B sin IA hasta mañana. Agrega otra llave.' : worst >= c.quotaWarnPct ? 'Una llave está por agotarse: agrega otra para repartir.' : undefined,
    });
  };
  quota('quota.gemini', 'Cupo gratis de Gemini (hoy)', m.quotas.gemini);
  quota('quota.openrouter', 'Cupo gratis de OpenRouter (hoy)', m.quotas.openrouter);

  /* ── 10. Empresas en riesgo ── */
  out.push({
    key: 'companies.risk', area: 'EMPRESAS', title: 'Empresas en riesgo',
    level: m.companies.length ? 'WARN' : 'OK',
    value: m.companies.length ? `${m.companies.length} empresa${m.companies.length === 1 ? '' : 's'}` : 'Ninguna',
    detail: m.companies.slice(0, 6).map((x) => `${x.name}: ${x.reasons.join(', ')}`).join(' · ') || 'Todas tienen WhatsApp, asistente activo, movimiento y facturas al día.',
    advice: m.companies.length ? 'Llámalas: una empresa sin WhatsApp o sin movimiento es una empresa que se va.' : undefined,
  });

  /* ── Seguridad: configuración que no debe faltar en producción ── */
  if (m.security?.production) {
    const sec = m.security;
    out.push({
      key: 'security.proxy', area: 'RENDER', title: 'Límites por IP (anti fuerza bruta)',
      level: sec.trustProxyHops > 0 ? 'OK' : 'CRIT',
      value: sec.trustProxyHops > 0 ? `Proxy de confianza: ${sec.trustProxyHops}` : 'Sin configurar',
      detail: 'Sin TRUST_PROXY_HOPS todos los visitantes comparten la IP del proxy y los límites de login no distinguen a nadie.',
      advice: sec.trustProxyHops > 0 ? undefined : 'Agrega TRUST_PROXY_HOPS=2 en Render (Vercel → Render).',
    });
    out.push({
      key: 'security.webhooks', area: 'RENDER', title: 'Firmas de webhooks',
      level: sec.metaSecret ? 'OK' : 'WARN',
      value: sec.metaSecret ? 'Meta firmado' : 'Falta META_APP_SECRET',
      detail: `Sin el secreto de Meta se rechazan los mensajes de WhatsApp Cloud, Instagram y Messenger. Wompi: ${sec.wompiEventsSecret ? 'eventos firmados' : 'sin secret (pagos por Wompi rechazados)'}.`,
    });
    out.push({
      key: 'security.mfa', area: 'RENDER', title: 'Verificación en dos pasos de plataforma',
      level: sec.platformWithoutMfa === 0 && sec.platformMfaRequired ? 'OK' : sec.platformWithoutMfa > 0 ? 'CRIT' : 'WARN',
      value: `${sec.platformWithoutMfa} cuenta(s) de plataforma sin MFA`,
      detail: sec.platformMfaRequired ? 'PLATFORM_MFA_REQUIRED=true: sin MFA no pueden usar la plataforma.' : 'Aún no es obligatoria (PLATFORM_MFA_REQUIRED).',
      advice: sec.platformWithoutMfa > 0 ? 'Cada dev la activa en "Seguridad de mi cuenta"; luego PLATFORM_MFA_REQUIRED=true en Render.' : undefined,
    });
  }

  return out;
}

/** Resumen por nivel para el semáforo general y la insignia del menú. */
export function healthSummary(checks: HealthCheck[]) {
  const crit = checks.filter((x) => x.level === 'CRIT').length;
  const warn = checks.filter((x) => x.level === 'WARN').length;
  return { level: (crit ? 'CRIT' : warn ? 'WARN' : 'OK') as Level, crit, warn };
}

/** Estadística diaria a partir de las fotos de 10 minutos. */
export function dailyStats(samples: Array<{ at: Date | string; data: any }>, days = 7, now = new Date()): DayStat[] {
  const since = now.getTime() - days * 86400e3;
  const map = new Map<string, { p95: number[]; rss: number[]; req: number; err: number }>();
  for (const s of samples) {
    const t = new Date(s.at).getTime();
    if (t < since) continue;
    const day = new Date(t - 5 * 3600e3).toISOString().slice(0, 10); // día de Colombia
    const d = map.get(day) ?? { p95: [], rss: [], req: 0, err: 0 };
    const perf = s.data?.perf;
    if (perf?.p95Ms != null && (perf.requests ?? 0) >= 20) d.p95.push(perf.p95Ms);
    if (perf?.rssMb != null) d.rss.push(perf.rssMb);
    d.req += perf?.requests10 ?? 0;
    d.err += perf?.errors10 ?? 0;
    map.set(day, d);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({
    day,
    p95Max: d.p95.length ? Math.max(...d.p95) : null,
    rssMaxMb: d.rss.length ? Math.max(...d.rss) : null,
    errorPct: d.req >= 20 ? Math.round((d.err / d.req) * 1000) / 10 : null,
  }));
}

/** MB por día que crece la base (regresión simple sobre las fotos de los últimos 7 días). */
export function growthPerDay(points: Array<{ at: Date | string; mb: number }>): number | null {
  const pts = points.filter((p) => Number.isFinite(p.mb)).map((p) => ({ x: new Date(p.at).getTime() / 86400e3, y: p.mb }));
  if (pts.length < 6) return null;
  const span = pts[pts.length - 1].x - pts[0].x;
  if (span < 0.5) return null; // menos de medio día de historial: no es tendencia
  const mx = pts.reduce((n, p) => n + p.x, 0) / pts.length;
  const my = pts.reduce((n, p) => n + p.y, 0) / pts.length;
  const num = pts.reduce((n, p) => n + (p.x - mx) * (p.y - my), 0);
  const den = pts.reduce((n, p) => n + (p.x - mx) ** 2, 0);
  return den ? Math.round((num / den) * 100) / 100 : null;
}
