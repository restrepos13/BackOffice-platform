/**
 * Verificación de Ads Intelligence en la base de DESARROLLO, sin cuentas reales.
 *
 * Usa el servicio real (AdsService) contra backoffice_dev con dos cuentas de una
 * empresa de prueba propia («verificacion-ads»):
 *  - una cuenta «Real» servida por un Meta FALSO dentro de este proceso (ninguna
 *    llamada sale a internet; cada llamada queda registrada para auditarla);
 *  - una cuenta de demostración (proveedor DEMO).
 * Cada número que muestra BackOffice se recalcula aquí por separado a partir de
 * las filas guardadas en la base. Solo toca datos de la empresa de prueba.
 *
 *   SEED_CONFIRM_DB=backoffice_dev npx ts-node --transpile-only scripts/verify-ads-dev.ts
 */
import 'reflect-metadata';
import { checkSeedTarget, loadApiEnv } from '../prisma/seed-guard';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdsService } from '../src/modules/ads.module';
import { addDays } from '../src/common/ads/provider';
import { todayIn } from '../src/common/ads/launch';

loadApiEnv();

const SLUG = 'verificacion-ads';
const ACT = '7700112233';
const results: Array<{ area: string; check: string; ok: boolean; detail: string }> = [];
const check = (area: string, name: string, ok: boolean, detail = '') => results.push({ area, check: name, ok: !!ok, detail });
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (a: number, b: number) => (b ? r2(((a - b) / b) * 100) : null);
const near = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined ? a === b : Math.abs(a - b) <= 0.011);

/* ── Meta falso: 3 campañas con objetivos distintos, 60 días ── */
type Call = { method: string; path: string; params: Record<string, string> };
const calls: Call[] = [];
let failPosts = false;
let today = '';

const ADS = [
  { ad: '41001', set: '31001', camp: '21001', name: 'Tráfico a la web', objective: 'OUTCOME_TRAFFIC', budget: 1000000 },
  { ad: '41002', set: '31002', camp: '21002', name: 'Chats de WhatsApp', objective: 'OUTCOME_ENGAGEMENT', budget: 2000000 },
  { ad: '41003', set: '31003', camp: '21003', name: 'Formulario de reservas', objective: 'OUTCOME_LEADS', budget: 1500000 },
];

/** Día a día por anuncio. Ayer (último día completo) casi no hay gasto; la campaña de chats empeora en los últimos 7 días. */
function dayRow(a: (typeof ADS)[number], d: string) {
  const yesterday = addDays(today, -1);
  const recent = d > addDays(today, -7);
  const drop = d === yesterday ? 0.05 : 1;
  const base = { ad_id: a.ad, adset_id: a.set, campaign_id: a.camp, date_start: d, account_currency: 'COP' };
  if (a.objective === 'OUTCOME_TRAFFIC') {
    return { ...base, spend: String(10000 * drop), impressions: String(Math.round(1000 * drop)), reach: '800', clicks: String(Math.round(30 * drop)), inline_link_clicks: String(Math.round(20 * drop)), actions: [] };
  }
  if (a.objective === 'OUTCOME_ENGAGEMENT') {
    const conv = d === yesterday ? 0 : recent ? 2 : 4;
    return { ...base, spend: String(20000 * drop), impressions: String(Math.round(700 * drop)), reach: '500', clicks: String(Math.round(10 * drop)), inline_link_clicks: '0', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(conv) }] };
  }
  return { ...base, spend: String(15000 * drop), impressions: String(Math.round(900 * drop)), reach: '700', clicks: String(Math.round(18 * drop)), inline_link_clicks: String(Math.round(12 * drop)), actions: [{ action_type: 'lead', value: d === yesterday ? '0' : '3' }] };
}

function graphRoute(path: string, q: URLSearchParams, method: string): any {
  if (method === 'POST') {
    if (failPosts) return { error: { code: 2, message: 'Service temporarily unavailable' }, __status: 503 };
    return /^\/\d+$/.test(path) ? { success: true } : { error: { code: 100, message: 'Ruta no prevista en la verificación' } };
  }
  if (path === '/me/adaccounts') return { data: [{ account_id: ACT, name: 'Restaurante (simulado)', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1 }] };
  if (path.endsWith('/campaigns')) return { data: ADS.map((a) => ({ id: a.camp, name: a.name, status: 'ACTIVE', effective_status: 'ACTIVE', objective: a.objective, daily_budget: String(a.budget) })) };
  if (path.endsWith('/adsets')) return { data: ADS.map((a) => ({ id: a.set, name: `${a.name} · conjunto`, campaign_id: a.camp, status: 'ACTIVE', effective_status: 'ACTIVE' })) };
  if (path.endsWith('/ads')) return { data: ADS.map((a) => ({ id: a.ad, name: `${a.name} · anuncio`, campaign_id: a.camp, adset_id: a.set, status: 'ACTIVE', effective_status: 'ACTIVE' })) };
  if (path.endsWith('/insights')) {
    if (q.get('level') === 'account') return { data: [{ reach: '5000', impressions: '18000', frequency: '3.6' }] };
    if (q.get('level') === 'campaign') return { data: ADS.map((a) => ({ campaign_id: a.camp, reach: '2000', impressions: '6000', frequency: '3' })) };
    const range = JSON.parse(q.get('time_range') ?? '{}');
    const out: any[] = [];
    for (let d = range.since; d && d <= range.until; d = addDays(d, 1)) for (const a of ADS) out.push(dayRow(a, d));
    return { data: out };
  }
  return { data: [] };
}

const fakeFetch = async (url: string, init?: any) => {
  const u = new URL(url);
  const method = init?.method ?? 'GET';
  const params = method === 'GET' ? u.searchParams : new URLSearchParams(init?.body ?? '');
  const path = u.pathname.replace(/^\/v[\d.]+/, '');
  const clean: Record<string, string> = {};
  params.forEach((v, k) => { if (k !== 'access_token') clean[k] = v; });
  calls.push({ method, path, params: clean });
  const body = graphRoute(path, params, method);
  const status = body?.__status ?? (body?.error ? 400 : 200);
  return { ok: status < 400, status, json: async () => body } as any;
};

/* ── Recalculo independiente ── */
function recompute(rows: any[]) {
  const t = rows.reduce((s, r) => ({ spend: s.spend + r.spend, impressions: s.impressions + r.impressions, clicks: s.clicks + r.clicks }), { spend: 0, impressions: 0, clicks: 0 });
  return {
    ...t,
    ctr: t.impressions ? r2((t.clicks / t.impressions) * 100) : null,
    cpc: t.clicks ? r2(t.spend / t.clicks) : null,
    cpm: t.impressions ? r2((t.spend / t.impressions) * 1000) : null,
  };
}
const window = (until: string, days: number) => {
  const since = addDays(until, -(days - 1));
  return { current: { since, until }, previous: { since: addDays(since, -days), until: addDays(since, -1) } };
};
const within = (d: string, p: { since: string; until: string }) => d >= p.since && d <= p.until;

async function main() {
  const pre = checkSeedTarget(process.env);
  if (!pre.ok) throw new Error(`No se ejecuta: ${pre.reason}`);
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  const audit = { log: async () => undefined };
  const svc = new AdsService(prisma, audit as any);
  svc.fetchImpl = fakeFetch as any;
  today = todayIn('America/Bogota');

  try {
    /* Empresa de prueba propia; se limpian solo sus datos de Ads */
    const company = await prisma.company.upsert({
      where: { slug: SLUG },
      update: {},
      create: { name: 'Verificación Ads (desarrollo)', slug: SLUG, status: 'ACTIVE', currency: 'COP', timezone: 'America/Bogota', productsJson: JSON.stringify({ ADS: { enabled: true }, AUTOMATION: { enabled: true }, CREATIVE: { enabled: false } }) },
    });
    const companyId = company.id;
    for (const m of ['adActionLog', 'adRule', 'adSettings', 'opportunity', 'adSyncRun', 'adInsightDaily', 'adEntity', 'adAccount'] as const) {
      await (prisma as any)[m].deleteMany({ where: { companyId } });
    }
    const user = { id: 'verificador', name: 'Verificador', email: 'verificador@example.invalid', role: 'COMPANY_ADMIN', companyId } as any;

    /* 1. Conexión y sincronización (Real simulado + Demo) */
    const real: any = await svc.connectManual(user, { accountId: ACT, token: 'EAAG' + 'x'.repeat(60) });
    const s1: any = await svc.sync(user, real.id, companyId);
    const demo: any = await svc.connectDemo(user, { provider: 'META' });
    check('Sincronización', 'La cuenta simulada sincroniza completa', s1.status === 'OK', `estado ${s1.status}`);
    const s2: any = await svc.sync(user, real.id, companyId);
    const realRows = await prisma.adInsightDaily.findMany({ where: { companyId, accountId: real.id } });
    const demoRows = await prisma.adInsightDaily.findMany({ where: { companyId, accountId: demo.id } });
    const keys = new Set(realRows.map((r) => `${r.level}:${r.externalId}:${r.date}`));
    check('Sincronización', 'Re-sincronizar no duplica filas', s2.status === 'OK' && keys.size === realRows.length, `${realRows.length} filas, ${keys.size} únicas`);
    check('Sincronización', 'Ningún token queda en registros de sincronización', !JSON.stringify(await prisma.adSyncRun.findMany({ where: { companyId } })).includes('EAAGxxxx'));

    /* 2. Métricas: gasto, impresiones, clics, CTR, CPC, CPM (7 y 30 días) */
    for (const days of [7, 30]) {
      const ov: any = await svc.overview(user, { mode: 'REAL', days: String(days) });
      // El día de hoy va a medias: el periodo termina ayer (zona de la cuenta)
      const until = addDays(today, -1);
      const w = window(until, days);
      const mine = recompute(realRows.filter((r) => within(r.date, w.current)));
      const prev = recompute(realRows.filter((r) => within(r.date, w.previous)));
      check('Métricas', `${days} d · hoy (a medias) queda fuera`, !ov.daily.some((d: any) => d.date === today) && ov.period.current.until === until, `termina ${ov.period.current.until}`);
      check('Métricas', `${days} d · periodo correcto`, ov.period.current.since === w.current.since && ov.period.current.until === w.current.until && ov.period.previous.until === w.previous.until, `${ov.period.current.since}→${ov.period.current.until} vs ${ov.period.previous.since}→${ov.period.previous.until}`);
      for (const k of ['spend', 'impressions', 'clicks', 'ctr', 'cpc', 'cpm'] as const) {
        check('Métricas', `${days} d · ${k}`, near(ov.totals[k], mine[k]), `BackOffice ${ov.totals[k]} · recalculado ${mine[k]}`);
      }
      /* 3. Diferencias entre periodos */
      for (const k of ['spend', 'ctr', 'cpc', 'cpm'] as const) {
        const want = ov.comparable ? pct(mine[k] as number, prev[k] as number) : null;
        const got = ov.deltas[k];
        check('Periodos', `${days} d · variación ${k}`, want === null ? got === null : got !== null && Math.abs(got - want) <= 0.6, `BackOffice ${got} % · recalculado ${want} %`);
      }
      /* 4. Objetivos distintos */
      check('Objetivos', `${days} d · sin costo por resultado único al mezclar objetivos`, ov.totals.costPerResult === null && ov.totals.results === null && ov.notes.some((n: string) => /objetivo|tipo|mezcl/i.test(n)), ov.notes.join(' | ').slice(0, 160));
      for (const c of ov.campaigns) {
        const a = ADS.find((x) => x.camp === c.externalId)!;
        const rows = realRows.filter((r) => r.campaignExternalId === c.externalId && within(r.date, w.current));
        const field = a.objective === 'OUTCOME_ENGAGEMENT' ? 'conversations' : a.objective === 'OUTCOME_LEADS' ? 'leads' : 'linkClicks';
        const res = rows.reduce((s, r: any) => s + r[field], 0);
        const sp = rows.reduce((s, r) => s + r.spend, 0);
        check('Objetivos', `${days} d · «${a.name}» cuenta ${field}`, c.results === res && near(c.costPerResult, res ? r2(sp / res) : null), `resultados ${c.results}/${res} · costo ${c.costPerResult}/${res ? r2(sp / res) : null}`);
      }
    }

    /* 5. Hallazgos: caída de gasto, costo por resultado y explicación completa */
    await svc.runAudit(companyId);
    const findings = await prisma.opportunity.findMany({ where: { companyId, source: 'ADS' } });
    const realF = findings.filter((f) => f.mode === 'REAL');
    const drop = realF.find((f) => f.ruleKey === 'SPEND_DROP');
    const yesterday = addDays(today, -1);
    const ySpend = realRows.filter((r) => r.date === yesterday).reduce((s, r) => s + r.spend, 0);
    const prior = Array.from({ length: 7 }, (_, i) => realRows.filter((r) => r.date === addDays(yesterday, -(i + 1))).reduce((s, r) => s + r.spend, 0));
    const avg = prior.reduce((s, v) => s + v, 0) / 7;
    const ev = drop ? JSON.parse(drop.evidenceJson) : {};
    check('Hallazgos', 'Detecta la caída de gasto del último día completo', !!drop && ev.daySpend === ySpend && Math.abs(ev.avg7 - Math.round(avg)) <= 1, `ayer ${ySpend} vs promedio ${Math.round(avg)} (${Math.round((ySpend / avg) * 100)} %)`);
    const cpr = realF.find((f) => f.ruleKey === 'CPR_UP' && f.externalId === '21002');
    check('Hallazgos', 'Detecta que el costo por chat subió', !!cpr, cpr ? cpr.title : 'no apareció');
    const noFalse = !realF.some((f) => f.ruleKey === 'SPEND_SPIKE');
    check('Hallazgos', 'No marca un pico de gasto que no existe', noFalse);
    const complete = realF.every((f) => {
      const x = JSON.parse(f.explanationJson);
      return x.rule && x.facts?.length && x.interpretation && x.action && f.title && f.evidenceJson !== '{}';
    });
    check('Hallazgos', 'Cada hallazgo explica regla, hechos, interpretación, acción y evidencia', complete && realF.length > 0, `${realF.length} hallazgos reales: ${realF.map((f) => f.ruleKey).join(', ')}`);
    await svc.runAudit(companyId);
    const again = await prisma.opportunity.count({ where: { companyId, source: 'ADS' } });
    check('Hallazgos', 'Repetir la auditoría no duplica hallazgos', again === findings.length, `${findings.length} → ${again}`);

    /* 6. Separación Demo / Real */
    const ovReal: any = await svc.overview(user, { mode: 'REAL', days: '30' });
    const ovDemo: any = await svc.overview(user, { mode: 'DEMO', days: '30' });
    const dUntil = demoRows.reduce((m, r) => (r.date > m ? r.date : m), '');
    const demoMine = recompute(demoRows.filter((r) => within(r.date, window(dUntil, 30).current)));
    check('Demo / Real', 'Los totales Real no incluyen filas de demostración', near(ovReal.totals.spend, recompute(realRows.filter((r) => within(r.date, window(ovReal.period.current.until, 30).current))).spend));
    check('Demo / Real', 'Los totales Demo son solo de la cuenta de demostración', near(ovDemo.totals.spend, demoMine.spend), `Demo ${ovDemo.totals.spend} · recalculado ${demoMine.spend}`);
    check('Demo / Real', 'Cada vista lista solo cuentas de su modo', ovReal.accounts.every((a: any) => a.mode === 'REAL') && ovDemo.accounts.every((a: any) => a.mode === 'DEMO'));
    check('Demo / Real', 'Los hallazgos llevan su modo y la demo se rotula como simulada',
      findings.every((f) => (f.mode === 'DEMO') === (f.accountId === demo.id)) && findings.filter((f) => f.mode === 'DEMO').every((f) => f.sourcesJson.includes('demostración')));
    const ovDefault: any = await svc.overview(user, { days: '30' });
    check('Demo / Real', 'Con cuentas reales, la vista por defecto es Real (nunca mezclada)', ovDefault.mode === 'REAL' && near(ovDefault.totals.spend, ovReal.totals.spend));

    /* 7. Aprobaciones, reintentos y registro */
    const before = await prisma.adEntity.findMany({ where: { companyId }, select: { id: true, dailyBudget: true, lifetimeBudget: true } });
    await svc.saveSettings(user, { autonomy: 'RECOMMEND' });
    await svc.createRule(user, { name: 'Costo por chat alto', metric: 'CPL', level: 'CAMPAIGN', windowDays: 7, operator: 'GT', threshold: 6000, action: 'PAUSE' });
    const postsBefore = calls.filter((c) => c.method === 'POST').length;
    await svc.runRules(companyId, true);
    const proposals = await prisma.adActionLog.findMany({ where: { companyId, mode: 'REAL', status: 'PROPOSED' } });
    check('Acciones', 'En modo «recomendar» la regla solo propone (no llama a Meta)', proposals.length > 0 && calls.filter((c) => c.method === 'POST').length === postsBefore, `${proposals.length} propuestas: ${proposals.map((p) => p.entityName).join(', ')}`);
    await svc.runRules(companyId, true);
    check('Acciones', 'Evaluar de nuevo el mismo día no duplica propuestas', (await prisma.adActionLog.count({ where: { companyId, mode: 'REAL', status: 'PROPOSED' } })) === proposals.length);
    const target = proposals[0];
    let rejected = false;
    try { await svc.decideAction(user, target.id, { decision: 'APPROVE' }); } catch { rejected = true; }
    check('Acciones', 'Aprobar sin confirmación se rechaza', rejected);
    failPosts = true;
    let failed = false;
    try { await svc.decideAction(user, target.id, { decision: 'APPROVE', confirm: true }); } catch { failed = true; }
    const approved = await prisma.adActionLog.findUnique({ where: { id: target.id } });
    const exec = await prisma.adActionLog.findFirst({ where: { companyId, idempotencyKey: `approved:${target.id}` } });
    check('Acciones', 'Si Meta falla, la ejecución queda FALLIDA (no como éxito) y la propuesta guarda quién aprobó', failed && exec?.status === 'FAILED' && approved?.status === 'APPROVED' && approved?.approvedBy === 'Verificador', `ejecución ${exec?.status} · error «${exec?.error}»`);
    let dup = false;
    try { await svc.decideAction(user, target.id, { decision: 'APPROVE', confirm: true }); } catch { dup = true; }
    check('Acciones', 'Una propuesta ya decidida no se puede aprobar dos veces', dup);
    failPosts = false;
    const retry: any = await svc.retryAction(user, exec!.id, {});
    const execRows = await prisma.adActionLog.findMany({ where: { companyId, idempotencyKey: `approved:${target.id}` } });
    check('Acciones', 'El reintento usa la misma clave y termina EJECUTADO sin duplicar', retry.status === 'EXECUTED' && execRows.length === 1 && execRows[0].status === 'EXECUTED', `${execRows.length} registro(s) · ${execRows[0]?.status}`);
    const listed: any[] = await svc.actions(user, { mode: 'REAL' });
    const row = listed.find((x) => x.id === target.id);
    check('Acciones', 'El historial enlaza propuesta → aprobación → ejecución', row?.execution?.status === 'EXECUTED' && row?.approvedBy === 'Verificador', `propuesta ${row?.status} · ejecución ${row?.execution?.status}`);
    const paused = await prisma.adEntity.findFirst({ where: { companyId, accountId: real.id, externalId: target.externalId! } });
    check('Acciones', 'El elemento quedó en pausa (estado confirmado por la plataforma)', paused?.status === 'PAUSED');

    /* 8. Ninguna recomendación modifica presupuestos */
    await svc.saveSettings(user, { autonomy: 'AUTHORIZED', autoActions: ['PAUSE', 'BUDGET', 'RESUME'] });
    const st: any = await svc.settings(user);
    check('Presupuestos', 'La configuración solo admite «pausar» como acción automática', JSON.stringify(st.autoActions) === '["PAUSE"]', `autoActions guardado: ${JSON.stringify(st.autoActions)}`);
    await svc.createRule(user, { name: 'Gasto alto por anuncio', metric: 'SPEND', level: 'AD', windowDays: 7, operator: 'GT', threshold: 1, action: 'PAUSE' });
    await svc.runRules(companyId, true);
    const posts = calls.filter((c) => c.method === 'POST');
    const budgetCalls = posts.filter((c) => Object.keys(c.params).some((k) => /budget|bid/i.test(k)));
    const onlyStatus = posts.every((c) => Object.keys(c.params).every((k) => k === 'status') && ['PAUSED', 'ACTIVE'].includes(c.params.status));
    check('Presupuestos', 'Todas las escrituras a Meta son solo cambios de estado', onlyStatus && budgetCalls.length === 0, `${posts.length} escrituras: ${[...new Set(posts.map((c) => JSON.stringify(c.params)))].join(' ')}`);
    check('Presupuestos', 'Ninguna escritura activa o reanuda algo sin una persona', !posts.some((c) => c.params.status === 'ACTIVE'));
    const after = await prisma.adEntity.findMany({ where: { companyId }, select: { id: true, dailyBudget: true, lifetimeBudget: true } });
    const same = before.every((b) => { const a = after.find((x) => x.id === b.id); return a && a.dailyBudget === b.dailyBudget && a.lifetimeBudget === b.lifetimeBudget; });
    check('Presupuestos', 'Los presupuestos guardados no cambiaron', same, `${before.length} elementos comparados`);
    const kinds = [...new Set((await prisma.adActionLog.findMany({ where: { companyId } })).map((x) => x.action))];
    check('Presupuestos', 'El registro solo contiene alertas, propuestas de pausa, pausas o reanudaciones', kinds.every((k) => ['ALERT', 'RECOMMEND_PAUSE', 'PAUSE', 'RESUME'].includes(k)), kinds.join(', '));
  } finally {
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  let area = '';
  for (const r of results) {
    if (r.area !== area) console.log(`\n${(area = r.area)}`);
    console.log(`  ${r.ok ? '✔' : '✘'} ${r.check}${r.detail ? `  — ${r.detail}` : ''}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} verificaciones OK · ${calls.length} llamadas al Meta simulado (ninguna a internet)`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(`Verificación interrumpida: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
