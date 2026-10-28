/**
 * Fase 3 · Ads Intelligence: sincronización idempotente y concurrente sin
 * índices únicos (como Atlas hoy), estados de sincronización y errores de
 * Meta, métricas por objetivo, alcance y frecuencia reales, hallazgos sin
 * duplicados, atribución por identificadores, Lead Ads y ciclo de acciones.
 * Todo con un Meta falso: ninguna prueba toca una cuenta real.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import { ConflictException, ForbiddenException } from '@nestjs/common';
import 'reflect-metadata';
import { AdsController, AdsService, adEntityId, adInsightId } from '../src/modules/ads.module';
import { AdLeadsService } from '../src/modules/ads-leads';
import { WebhooksService } from '../src/modules/webhooks.module';
import { audit as runAudit } from '../src/common/ads/findings';
import { comparable, mixedTotals, periodStatFor, resultTypeFor, totals, typedTotals } from '../src/common/ads/metrics';
import { chunks, nextAttempt } from '../src/common/ads/sync-policy';
import { attributionOf } from '../src/common/ads/revenue';
import { contactFromFields, leadDocId, parseLeadgenEvents } from '../src/common/ads/leads';
import { storeDetected } from '../src/common/opportunities/store';
import { encryptSecret } from '../src/common/crypto';
import { ROLES_KEY } from '../src/auth/decorators';
import { PRODUCTS_KEY } from '../src/auth/products.guard';
import { createMockPrisma } from './helpers/mock-prisma';

const auditLog = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const NOW = new Date('2026-10-27T15:00:00Z');
const TOKEN = 'EAAG'.padEnd(48, 'q');

function world(opts: { atlas?: boolean } = { atlas: true }) {
  const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: opts.atlas });
  db.company.push(
    { id: 'coA', name: 'Aurora', slug: 'aurora', planId: 'p1', currency: 'COP' },
    { id: 'coB', name: 'Otra', slug: 'otra', planId: 'p1', currency: 'COP' },
  );
  const svc = new AdsService(prisma as any, auditLog as any);
  svc.now = () => NOW;
  return { prisma, db, svc };
}

type Route = (u: URL, init?: any) => any;
/** Meta falso: una función decide la respuesta según ruta y parámetros. */
function graph(route: Route) {
  const calls: Array<{ path: string; params: URLSearchParams; method: string }> = [];
  const fn = async (url: string, init?: any) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    const params = method === 'GET' ? u.searchParams : new URLSearchParams(init?.body ?? '');
    const path = u.pathname.replace(/^\/v[\d.]+/, '');
    calls.push({ path, params, method });
    const body = route(Object.assign(u, { pathname: path }), { ...init, params }) ?? { data: [] };
    const status = body?.__status ?? (body?.error ? 400 : 200);
    return { ok: status < 400, status, json: async () => body };
  };
  return { fn, calls };
}

/** Cuenta real con 1 campaña de tráfico y 1 de mensajes, un anuncio cada una, 60 días de datos. */
function metaAccount(over: { insights?: (since: string, until: string) => any; entities?: () => any } = {}) {
  return graph((u, init) => {
    const p = u.pathname;
    const q = init?.params as URLSearchParams;
    if (p === '/me/adaccounts') return { data: [{ account_id: '90011', name: 'Real A', currency: 'COP', timezone_name: 'America/Bogota', account_status: 1 }] };
    if (p.endsWith('/campaigns')) return over.entities?.() ?? { data: [{ id: '11100', name: 'Tráfico web', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_TRAFFIC' }, { id: '22200', name: 'Chats', status: 'ACTIVE', effective_status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT' }] };
    if (p.endsWith('/adsets')) return { data: [{ id: '31100', name: 'S1', campaign_id: '11100', status: 'ACTIVE', effective_status: 'ACTIVE' }, { id: '32200', name: 'S2', campaign_id: '22200', status: 'ACTIVE', effective_status: 'ACTIVE' }] };
    if (p.endsWith('/ads')) return { data: [{ id: '41100', name: 'Ad web', campaign_id: '11100', adset_id: '31100', status: 'ACTIVE', effective_status: 'ACTIVE' }, { id: '42200', name: 'Ad chat', campaign_id: '22200', adset_id: '32200', status: 'ACTIVE', effective_status: 'ACTIVE' }] };
    if (p.endsWith('/insights')) {
      const range = JSON.parse(q.get('time_range') ?? '{}');
      if (q.get('level') === 'account') return { data: [{ reach: '4000', impressions: '10000', frequency: '2.5' }] };
      if (q.get('level') === 'campaign') return { data: [{ campaign_id: '11100', reach: '3000', impressions: '6000', frequency: '2' }, { campaign_id: '22200', reach: '1500', impressions: '4000', frequency: '2.67' }] };
      if (over.insights) return over.insights(range.since, range.until);
      const out: any[] = [];
      for (let d = range.since; d <= range.until; d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10)) {
        out.push({ ad_id: '41100', adset_id: '31100', campaign_id: '11100', date_start: d, spend: '10000', impressions: '1000', reach: '800', clicks: '30', inline_link_clicks: '20', actions: [] });
        out.push({ ad_id: '42200', adset_id: '32200', campaign_id: '22200', date_start: d, spend: '20000', impressions: '700', reach: '500', clicks: '10', inline_link_clicks: '0', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' }] });
      }
      return { data: out };
    }
    if (/^\/\d+$/.test(p) && init?.method === 'POST') return { success: true };
    return { data: [] };
  });
}

async function connectReal(svc: AdsService, g: ReturnType<typeof graph>) {
  svc.fetchImpl = g.fn as any;
  return svc.connectManual(A, { accountId: '90011', token: TOKEN });
}

describe('Ads · sincronización (sin índices únicos, como Atlas hoy)', () => {
  it('repetir la sincronización no duplica; los _id salen de la clave lógica', async () => {
    const { svc, db } = world();
    const acc = await connectReal(svc, metaAccount());
    const r1: any = await svc.sync(A, acc.id, 'coA');
    expect(r1.status).toBe('OK');
    const ent = db.adEntity.length;
    const ins = db.adInsightDaily.length;
    expect(ent).toBe(6);
    expect(ins).toBe(120); // 60 días × 2 anuncios
    await svc.sync(A, acc.id, 'coA');
    expect(db.adEntity.length).toBe(ent);
    expect(db.adInsightDaily.length).toBe(ins);
    expect(db.adEntity.find((e: any) => e.externalId === '41100')!.id).toBe(adEntityId(acc.id, 'AD', '41100'));
    expect(db.adInsightDaily.find((r: any) => r.externalId === '41100' && r.date === '2026-10-01')!.id).toBe(adInsightId(acc.id, 'AD', '41100', '2026-10-01'));
    expect(db.adAccount[0]).toMatchObject({ lastSyncStatus: 'OK', syncFailures: 0, lastErrorKind: null });
    expect(db.adAccount[0].nextSyncAt.getTime()).toBe(NOW.getTime() + 6 * 36e5);
  });

  it('dos sincronizaciones simultáneas de la misma cuenta: una sola corre (candado atómico)', async () => {
    const { svc, db } = world();
    const acc = await connectReal(svc, metaAccount());
    const results = await Promise.allSettled([svc.sync(A, acc.id, 'coA'), svc.sync(A, acc.id, 'coA')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect(db.adInsightDaily.length).toBe(120);
    // El candado se libera al terminar (aunque falle): la siguiente corre
    expect(db.adAccount[0].syncLockUntil).toBeNull();
    await expect(svc.sync(A, acc.id, 'coA')).resolves.toMatchObject({ status: 'OK' });
  });

  it('escrituras concurrentes del mismo lote no duplican aunque no haya índice único', async () => {
    const { svc, db } = world();
    const acc = await connectReal(svc, metaAccount());
    const a = db.adAccount[0];
    const rows = [{ level: 'AD', externalId: '41100', campaignExternalId: '11100', adsetExternalId: '31100', date: '2026-10-20', spend: 5, impressions: 1, reach: 1, clicks: 0, linkClicks: 0, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0, raw: {} }];
    await Promise.all([(svc as any).saveInsights(a, rows), (svc as any).saveInsights(a, rows), (svc as any).saveInsights(a, rows)]);
    expect(db.adInsightDaily.filter((r: any) => r.externalId === '41100' && r.date === '2026-10-20')).toHaveLength(1);
    expect(acc.id).toBe(a.id);
  });

  it('un tramo de métricas que falla deja la corrida PARCIAL: conserva lo guardado y reintenta después', async () => {
    const { svc, db } = world();
    let fail = false;
    const g = metaAccount({
      insights: (since) => (fail && since >= '2026-10-13' ? { error: { code: 17, message: 'User request limit reached' } }
        : { data: [{ ad_id: '41100', adset_id: '31100', campaign_id: '11100', date_start: since, spend: '1000', impressions: '100', clicks: '1', inline_link_clicks: '1', actions: [] }] }),
    });
    const acc = await connectReal(svc, g);
    await svc.sync(A, acc.id, 'coA');
    const kept = db.adInsightDaily.length;
    const lastOk = db.adAccount[0].lastSyncAt;
    fail = true;
    svc.now = () => new Date(NOW.getTime() + 7 * 36e5);
    const r: any = await svc.sync(A, acc.id, 'coA');
    expect(r).toMatchObject({ ok: false, status: 'PARTIAL', errorKind: 'RATE_LIMIT' });
    expect(r.note).toMatch(/no se borró/);
    expect(db.adInsightDaily.length).toBeGreaterThanOrEqual(kept);
    const a = db.adAccount[0];
    expect(a).toMatchObject({ lastSyncStatus: 'PARTIAL', lastErrorKind: 'RATE_LIMIT', status: 'CONNECTED', syncFailures: 1 });
    expect(a.lastSyncAt).toEqual(lastOk); // el próximo intento vuelve a cubrir el hueco
    expect(a.nextSyncAt.getTime() - svc.now().getTime()).toBe(60 * 60e3);
    const runs = await svc.syncRuns(A, acc.id);
    expect(runs[0]).toMatchObject({ status: 'PARTIAL', errorKind: 'RATE_LIMIT' });
    expect(runs[0].help).toMatch(/Se reintenta sola/);
  });

  it('token vencido → EXPIRED sin reintento automático; permisos → ERROR con reintento diario', async () => {
    const { svc, db } = world();
    const acc = await connectReal(svc, metaAccount());
    svc.fetchImpl = graph(() => ({ error: { code: 190, message: 'Error validating access token' }, __status: 401 })).fn as any;
    await expect(svc.sync(A, acc.id, 'coA')).rejects.toThrow(/venció|revocada/);
    expect(db.adAccount[0]).toMatchObject({ status: 'EXPIRED', lastSyncStatus: 'ERROR', lastErrorKind: 'AUTH', nextSyncAt: null });
    db.adAccount[0].status = 'CONNECTED';
    svc.fetchImpl = graph(() => ({ error: { code: 200, message: 'Requires ads_read permission' }, __status: 403 })).fn as any;
    await expect(svc.sync(A, acc.id, 'coA')).rejects.toThrow(/Permisos insuficientes/);
    expect(db.adAccount[0]).toMatchObject({ status: 'ERROR', lastErrorKind: 'PERMISSION' });
    expect(db.adAccount[0].nextSyncAt.getTime() - NOW.getTime()).toBe(24 * 36e5);
    // Ningún error expone el token
    expect(JSON.stringify(db.adSyncRun)).not.toContain(TOKEN);
    expect(JSON.stringify(await svc.accounts(A))).not.toContain(TOKEN);
  });

  it('si Meta tiene más páginas de las que se leen, la sincronización queda INCOMPLETA (no se guardan datos a medias como si fueran todos)', async () => {
    const { svc, db } = world();
    const g = graph((u) => {
      if (u.pathname === '/me/adaccounts') return { data: [{ account_id: '90011', name: 'Real A', currency: 'COP', account_status: 1 }] };
      if (u.pathname.endsWith('/campaigns')) return { data: [{ id: '11100', name: 'C', status: 'ACTIVE' }], paging: { next: 'https://graph.facebook.com/v24.0/act_90011/campaigns?after=x' } };
      return { data: [] };
    });
    const acc = await connectReal(svc, g);
    await expect(svc.sync(A, acc.id, 'coA')).rejects.toThrow(/incompleta/);
    expect(db.adAccount[0]).toMatchObject({ lastSyncStatus: 'ERROR', lastErrorKind: 'INCOMPLETE' });
    expect(db.adEntity).toHaveLength(0);
  });

  it('la política de reintentos crece y tiene tope; el rango se parte en tramos', () => {
    const at = (k: any, f: number) => (nextAttempt(k, f, NOW)!.getTime() - NOW.getTime()) / 60e3;
    expect(at('RATE_LIMIT', 1)).toBe(60);
    expect(at('RATE_LIMIT', 3)).toBe(240);
    expect(at('PROVIDER', 10)).toBe(720);
    expect(nextAttempt('AUTH', 1, NOW)).toBeNull();
    expect(chunks('2026-09-01', '2026-10-05')).toEqual([
      { since: '2026-09-01', until: '2026-09-15' }, { since: '2026-09-16', until: '2026-09-30' }, { since: '2026-10-01', until: '2026-10-05' },
    ]);
  });

  it('la empresa B no puede sincronizar ni ver las corridas de la cuenta de A', async () => {
    const { svc } = world();
    const acc = await connectReal(svc, metaAccount());
    await expect(svc.syncNow(B, acc.id)).rejects.toThrow(/no encontrada/);
    await expect(svc.syncRuns(B, acc.id)).rejects.toThrow(/no encontrada/);
  });
});

describe('Ads · métricas', () => {
  const row = (campaign: string, date: string, x: Partial<Record<string, number>> = {}) => ({
    externalId: `ad-${campaign}`, campaignExternalId: campaign, date, spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0, ...x,
  });

  it('cada objetivo cuenta su propio resultado; mezclar objetivos no da un costo por resultado único', () => {
    expect(resultTypeFor('OUTCOME_ENGAGEMENT')).toBe('conversations');
    expect(resultTypeFor('OUTCOME_TRAFFIC')).toBe('linkClicks');
    expect(resultTypeFor('OUTCOME_AWARENESS')).toBe('none');
    expect(resultTypeFor(null)).toBe('reported');
    const traffic = typedTotals([row('t', '2026-10-01', { spend: 1000, linkClicks: 50, conversations: 2 })], 'linkClicks');
    expect(traffic).toMatchObject({ results: 50, costPerResult: 20 });
    const types: Record<string, any> = { t: 'linkClicks', m: 'conversations' };
    const mixed = mixedTotals([row('t', '2026-10-01', { spend: 1000, linkClicks: 50 }), row('m', '2026-10-01', { spend: 3000, conversations: 10 })], (c) => types[c!]);
    expect(mixed.results).toBeNull();
    expect(mixed.costPerResult).toBeNull();
    expect(mixed.resultNote).toMatch(/objetivos distintos/);
    const single = mixedTotals([row('m', '2026-10-01', { spend: 3000, conversations: 10 })], () => 'conversations');
    expect(single).toMatchObject({ results: 10, costPerResult: 300, resultNote: null });
  });

  it('ceros y nulos: sin impresiones no hay CTR/CPM; sin resultados no hay costo; alcance de reconocimiento no aplica', () => {
    const t = typedTotals([row('x', '2026-10-01', { spend: 500 })], 'leads');
    expect(t).toMatchObject({ ctr: null, cpm: null, cpc: null, costPerResult: null, results: 0 });
    expect(typedTotals([row('x', '2026-10-01', { spend: 500 })], 'none')).toMatchObject({ resultsAvailable: false, costPerResult: null });
    expect(totals([])).toMatchObject({ spend: 0, ctr: null, costPerResult: null, days: 0 });
  });

  it('periodos incompatibles no se comparan; el alcance solo con el periodo exacto reportado', () => {
    expect(comparable({ days: 30 }, { days: 0 }).ok).toBe(false);
    expect(comparable({ days: 30 }, { days: 12 }).reason).toMatch(/no son comparables/);
    expect(comparable({ days: 7 }, { days: 7 }).ok).toBe(true);
    const json = JSON.stringify([{ since: '2026-10-21', until: '2026-10-27', reach: 10, impressions: 30, frequency: 3 }]);
    expect(periodStatFor(json, { since: '2026-10-21', until: '2026-10-27' })?.frequency).toBe(3);
    expect(periodStatFor(json, { since: '2026-10-20', until: '2026-10-27' })).toBeNull();
  });

  it('el resumen real: alcance y frecuencia de la plataforma, sin costo único al mezclar objetivos y con la nota', async () => {
    const { svc } = world();
    const acc = await connectReal(svc, metaAccount());
    await svc.sync(A, acc.id, 'coA');
    const o: any = await svc.overview(A, { days: '7', mode: 'REAL' });
    expect(o.period.current).toEqual({ since: '2026-10-21', until: '2026-10-27' });
    expect(o.totals).toMatchObject({ reach: 4000, frequency: 2.5, results: null, costPerResult: null });
    expect(o.notes.join(' ')).toMatch(/objetivos distintos/);
    const chat = o.campaigns.find((c: any) => c.externalId === '22200');
    expect(chat).toMatchObject({ resultType: 'conversations', results: 28, costPerResult: 5000, reach: 1500, frequency: 2.67 });
    const web = o.campaigns.find((c: any) => c.externalId === '11100');
    expect(web).toMatchObject({ resultType: 'linkClicks', results: 140, costPerResult: 500 });
    // 14 días: la plataforma no reportó alcance para ese periodo → no se inventa
    const o14: any = await svc.overview(A, { days: '14', mode: 'REAL' });
    expect(o14.totals.reach).toBeNull();
    expect(o14.notes.join(' ')).toMatch(/no están disponibles/);
    // Filtrando una campaña sí hay un tipo único
    const only: any = await svc.overview(A, { days: '7', mode: 'REAL', campaign: '22200' });
    expect(only.totals).toMatchObject({ resultType: 'conversations', results: 28, costPerResult: 5000, reach: 1500 });
  });
});

describe('Ads · hallazgos', () => {
  const ent = [
    { level: 'CAMPAIGN', externalId: 'c1', name: 'Chats', objective: 'OUTCOME_ENGAGEMENT', effectiveStatus: 'ACTIVE', issues: [] },
    { level: 'AD', externalId: 'a1', campaignExternalId: 'c1', name: 'A1', effectiveStatus: 'ACTIVE', issues: [] },
  ];
  const day = (n: number) => new Date(Date.UTC(2026, 9, 27) - n * 864e5).toISOString().slice(0, 10);
  const rows = (worse: boolean, spendLast = 10000) => Array.from({ length: 20 }, (_, i) => ({
    externalId: 'a1', campaignExternalId: 'c1', date: day(i), spend: i === 0 ? spendLast : 10000, impressions: 1000, reach: 900, clicks: 10, linkClicks: 5,
    leads: 0, conversations: worse && i < 7 ? 5 : 10, purchases: 0, purchaseValue: 0,
  }));
  const typeOf = () => 'conversations' as const;

  it('cada hallazgo trae regla aplicada, periodo y evidencia; su clave no cambia de un día al otro', () => {
    const today = runAudit(ent, rows(true), { until: day(0), currency: 'COP', typeOf });
    const cpr = today.find((f) => f.ruleKey === 'CPR_UP')!;
    expect(cpr.dedupeKey).toBe('CPR_UP:c1');
    expect(cpr.explanation.rule).toMatch(/30 %/);
    expect(cpr.period).toHaveProperty('current');
    expect(cpr.evidence).toHaveProperty('changePct');
    const tomorrow = runAudit(ent, rows(true).map((r) => ({ ...r, date: new Date(Date.parse(`${r.date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10) })), { until: day(-1), currency: 'COP', typeOf });
    expect(tomorrow.find((f) => f.ruleKey === 'CPR_UP')!.dedupeKey).toBe(cpr.dedupeKey);
    expect(today.every((f) => f.explanation.rule && f.evidenceLevel)).toBe(true);
  });

  it('caída del gasto con campañas activas: se mide el último día completo (no el de hoy, que va a medias)', () => {
    const partialToday = runAudit(ent, rows(false, 100), { until: day(0), currency: 'COP', typeOf });
    expect(partialToday.some((f) => f.ruleKey === 'SPEND_DROP')).toBe(false);
    const drop = rows(false).map((r) => (r.date === day(1) ? { ...r, spend: 500 } : r));
    const f = runAudit(ent, drop, { until: day(0), currency: 'COP', typeOf }).find((x) => x.ruleKey === 'SPEND_DROP')!;
    expect(f.period).toEqual({ day: day(1) });
    expect(f.evidence).toMatchObject({ daySpend: 500 });
  });

  it('diferencia entre conversaciones de la plataforma y del CRM, con sus advertencias', () => {
    const f = runAudit(ent, rows(false), { until: day(0), currency: 'COP', typeOf }, { adLeads: 5, stuckInFirstStage: 0, platformConversations: 70, crmAdConversations: 20 });
    const gap = f.find((x) => x.ruleKey === 'CONVERSATION_GAP')!;
    expect(gap.evidenceLevel).toBe('INITIAL');
    expect(gap.explanation.assumptions.join(' ')).toMatch(/pueden diferir/);
    expect(runAudit(ent, rows(false), { until: day(0), currency: 'COP', typeOf }, { adLeads: 5, stuckInFirstStage: 0, platformConversations: 70, crmAdConversations: 60 }).some((x) => x.ruleKey === 'CONVERSATION_GAP')).toBe(false);
  });

  it('un anuncio de tráfico no se compara con el costo de los chats', () => {
    const e2 = [...ent, { level: 'CAMPAIGN', externalId: 'c2', name: 'Web', objective: 'OUTCOME_TRAFFIC', effectiveStatus: 'ACTIVE', issues: [] }, { level: 'AD', externalId: 'a2', campaignExternalId: 'c2', name: 'A2', effectiveStatus: 'ACTIVE', issues: [] }];
    const r2 = [...rows(false), ...rows(false).map((r) => ({ ...r, externalId: 'a2', campaignExternalId: 'c2', conversations: 0, linkClicks: 40 }))];
    const types: Record<string, any> = { c1: 'conversations', c2: 'linkClicks' };
    const f = runAudit(e2, r2, { until: day(0), currency: 'COP', typeOf: (c) => types[c!] });
    expect(f.some((x) => x.ruleKey === 'SPEND_NO_RESULTS' && x.externalId === 'a2')).toBe(false);
    expect(f.some((x) => x.ruleKey === 'MEASUREMENT')).toBe(false);
  });

  it('re-detectar no duplica; si la condición desaparece se cierra y si vuelve se reabre la misma fila', async () => {
    const { prisma, db } = createMockPrisma({ atlasWithoutIndexes: true });
    const scope = { companyId: 'coA', source: 'ADS' as const, mode: 'REAL' as const, accountId: 'acc1', keyPrefix: 'acc1' };
    const drafts = runAudit(ent, rows(true), { until: day(0), currency: 'COP', typeOf }).map((d) => ({ ...d, sources: ['Meta Ads'] }));
    // Dos auditorías simultáneas (cron + manual) sin índice único: una fila por hallazgo
    await Promise.all([storeDetected(prisma, scope, drafts as any, NOW), storeDetected(prisma, scope, drafts as any, NOW)]);
    const n = db.opportunity.length;
    expect(n).toBe(drafts.length);
    await storeDetected(prisma, scope, drafts as any, new Date(NOW.getTime() + 864e5));
    expect(db.opportunity.length).toBe(n);
    await storeDetected(prisma, scope, [], new Date(NOW.getTime() + 2 * 864e5));
    const cpr = db.opportunity.find((o: any) => o.ruleKey === 'CPR_UP')!;
    expect(cpr.status).toBe('RESULT');
    await storeDetected(prisma, scope, drafts as any, new Date(NOW.getTime() + 3 * 864e5));
    expect(db.opportunity.length).toBe(n);
    expect(cpr.status).toBe('NEW');
    expect(JSON.parse(cpr.decisionsJson).at(-1).note).toBe('La condición volvió a detectarse');
    // Una descartada por la persona sigue descartada aunque se vuelva a detectar
    cpr.status = 'DISMISSED';
    await storeDetected(prisma, scope, drafts as any, new Date(NOW.getTime() + 4 * 864e5));
    expect(cpr.status).toBe('DISMISSED');
  });
});

describe('Ads · atribución', () => {
  const ads = new Map([['41100', { adsetExternalId: '31100', campaignExternalId: '11100' }]]);
  const o = (x: any) => ({ originJson: JSON.stringify(x) });

  it('atribuido solo con un ID presente; parcial si falta ubicarlo; nada por cercanía de fechas', () => {
    expect(attributionOf(o({ kind: 'AD', sourceId: '41100' }), ads)).toMatchObject({ state: 'ATTRIBUTED', campaignId: '11100', adsetId: '31100', via: 'WHATSAPP_REFERRAL' });
    expect(attributionOf(o({ kind: 'AD', sourceId: '999' }), ads)).toMatchObject({ state: 'PARTIAL', campaignId: null });
    expect(attributionOf(o({ kind: 'AD', ctwaClid: 'abc' }), ads)).toMatchObject({ state: 'PARTIAL', adId: null });
    expect(attributionOf(o({ kind: 'POST' }), ads)).toMatchObject({ state: 'UNATTRIBUTED' });
    expect(attributionOf(o({ kind: 'AD', via: 'LEAD_FORM', sourceId: '41100' }), ads)).toMatchObject({ state: 'ATTRIBUTED', via: 'LEAD_FORM' });
    // Directo: no vino de un anuncio, no hay nada que atribuir (aunque haya gasto ese día)
    expect(attributionOf(o({ kind: 'DIRECT' }), ads)).toBeNull();
    expect(attributionOf({ originJson: null }, ads)).toBeNull();
  });

  it('la vista de ventas separa atribuidos, parciales y sin atribuir, con su evidencia', async () => {
    const { svc, db } = world();
    const acc = await connectReal(svc, metaAccount());
    await svc.sync(A, acc.id, 'coA');
    const at = new Date('2026-10-20T12:00:00Z');
    db.contact.push(
      { id: 'k1', companyId: 'coA', name: 'Ana', stage: 'CURIOSO', createdAt: at, originJson: JSON.stringify({ kind: 'AD', sourceId: '42200' }) },
      { id: 'k2', companyId: 'coA', name: 'Beto', stage: 'CURIOSO', createdAt: at, originJson: JSON.stringify({ kind: 'AD', sourceId: '77777' }) },
      { id: 'k3', companyId: 'coA', name: 'Caro', stage: 'CURIOSO', createdAt: at, originJson: JSON.stringify({ kind: 'DIRECT' }) },
      { id: 'k4', companyId: 'coB', name: 'Otra empresa', stage: 'CURIOSO', createdAt: at, originJson: JSON.stringify({ kind: 'AD', sourceId: '42200' }) },
    );
    const r: any = await svc.revenue(A, { days: '30' });
    expect(r.attribution.counts).toEqual({ ATTRIBUTED: 1, PARTIAL: 1, UNATTRIBUTED: 0 });
    const ana = r.attribution.recent.find((x: any) => x.contactId === 'k1');
    expect(ana).toMatchObject({ campaignName: 'Chats', adsetName: 'S2', adName: 'Ad chat' });
    expect(ana.evidence).toMatch(/ID del anuncio 42200/);
    expect(r.attribution.recent.some((x: any) => x.contactId === 'k4' || x.contactId === 'k3')).toBe(false);
  });
});

describe('Ads · Meta Lead Ads (webhook)', () => {
  const hook = (leadgen = '880001', page = '5550001', ad = '42200') => ({
    object: 'page',
    entry: [{ id: page, changes: [{ field: 'leadgen', value: { leadgen_id: leadgen, page_id: page, form_id: '660001', ad_id: ad, adgroup_id: '32200', created_time: 1761570000 } }] }],
  });

  function leadsWorld(withToken: boolean, graphResponse: any = { field_data: [{ name: 'full_name', values: ['Laura Gómez'] }, { name: 'phone_number', values: ['+57 300 111 2233'] }, { name: 'email', values: ['LAURA@x.co'] }, { name: 'presupuesto', values: ['alto'] }] }) {
    const w = world();
    w.db.integration.push({ id: 'i1', companyId: 'coA', type: 'META_SOCIAL', configJson: JSON.stringify({ pageId: '5550001', ...(withToken ? { accessTokenEnc: encryptSecret('PAGE'.padEnd(40, 't')) } : {}) }) });
    const leads = new AdLeadsService(w.prisma as any);
    leads.now = () => NOW;
    const g = graph(() => graphResponse);
    leads.fetchImpl = g.fn as any;
    const hooks = new WebhooksService(w.prisma as any, undefined, undefined, undefined, leads);
    return { ...w, leads, hooks, calls: g.calls };
  }

  it('lee solo eventos leadgen válidos', () => {
    expect(parseLeadgenEvents(hook())).toEqual([{ pageId: '5550001', leadgenId: '880001', formId: '660001', adId: '42200', adsetId: '32200', createdTime: new Date(1761570000 * 1000) }]);
    expect(parseLeadgenEvents({ object: 'instagram', entry: [] })).toEqual([]);
    expect(parseLeadgenEvents({ object: 'page', entry: [{ changes: [{ field: 'feed', value: {} }] }] })).toEqual([]);
    expect(contactFromFields([{ name: 'phone_number', values: ['3001112233'] }]).phone).toBe('3001112233'); // sin indicativo no se adivina el país
  });

  it('con token de la página crea el contacto con origen en el formulario; el reintento de Meta no duplica', async () => {
    const { hooks, db, calls } = leadsWorld(true);
    await hooks.ingestMeta('aurora', hook());
    await hooks.ingestMeta('aurora', hook());
    expect(db.adLead).toHaveLength(1);
    expect(db.adLead[0]).toMatchObject({ id: leadDocId('880001'), status: 'FETCHED', adId: '42200', adsetId: '32200' });
    expect(JSON.parse(db.adLead[0].fieldNamesJson)).toEqual(['full_name', 'phone_number', 'email', 'presupuesto']);
    expect(JSON.stringify(db.adLead[0])).not.toContain('Laura'); // los datos personales van al contacto, no al lead
    expect(db.contact).toHaveLength(1);
    expect(db.contact[0]).toMatchObject({ companyId: 'coA', name: 'Laura Gómez', phone: '+573001112233', email: 'laura@x.co', channel: 'META_ADS' });
    expect(JSON.parse(db.contact[0].originJson)).toMatchObject({ kind: 'AD', via: 'LEAD_FORM', sourceId: '42200', leadgenId: '880001' });
    expect(calls.filter((c) => c.path === '/880001')).toHaveLength(1);
  });

  it('sin token o sin leads_retrieval queda pendiente de permiso, con sus IDs y sin contacto inventado', async () => {
    const noToken = leadsWorld(false);
    await noToken.hooks.ingestMeta('aurora', hook());
    expect(noToken.db.adLead[0]).toMatchObject({ status: 'PENDING_PERMISSION', adId: '42200' });
    expect(noToken.db.contact).toHaveLength(0);
    const denied = leadsWorld(true, { error: { code: 200, message: 'Requires leads_retrieval permission' }, __status: 403 });
    await denied.hooks.ingestMeta('aurora', hook());
    expect(denied.db.adLead[0].status).toBe('PENDING_PERMISSION');
    expect(denied.db.adLead[0].error).toMatch(/leads_retrieval/);
    expect(denied.db.contact).toHaveLength(0);
  });

  it('un lead de una página que la empresa no conectó se ignora; B no puede leer ni reintentar el de A', async () => {
    const { hooks, db, leads } = leadsWorld(true);
    await hooks.ingestMeta('aurora', hook('880002', '9999999'));
    expect(db.adLead).toHaveLength(0);
    await hooks.ingestMeta('aurora', hook());
    expect(await leads.list('coB')).toEqual([]);
    const other = await leads.fetch('coB', db.adLead[0].id);
    expect(other!.companyId).toBe('coA'); // el controlador responde 404 a B
    expect(db.adLead[0].status).toBe('FETCHED');
  });

  it('un contacto existente conserva su primer origen', async () => {
    const { hooks, db } = leadsWorld(true);
    db.contact.push({ id: 'old', companyId: 'coA', name: 'Laura', phone: '+573001112233', originJson: JSON.stringify({ kind: 'DIRECT' }) });
    await hooks.ingestMeta('aurora', hook());
    expect(db.contact).toHaveLength(1);
    expect(JSON.parse(db.contact[0].originJson).kind).toBe('DIRECT');
    expect(db.adLead[0].contactId).toBe('old');
  });
});

describe('Ads · acciones: sugerencia, aprobación, ejecución y resultado', () => {
  async function proposal() {
    const w = world();
    const g = metaAccount();
    const acc = await connectReal(w.svc, g);
    await w.svc.sync(A, acc.id, 'coA');
    w.db.adActionLog.push({ id: 'p1', companyId: 'coA', accountId: acc.id, mode: 'REAL', source: 'RULE', idempotencyKey: 'rule:r1:41100:2026-10-27', level: 'AD', externalId: '41100', entityName: 'Ad web', action: 'RECOMMEND_PAUSE', status: 'PROPOSED', dataJson: '{}', reversible: false, createdAt: NOW });
    return { ...w, acc, calls: g.calls };
  }

  it('dos aprobaciones simultáneas: una sola ejecución en la plataforma, enlazada a quién aprobó', async () => {
    const { svc, db, calls } = await proposal();
    calls.length = 0;
    const r = await Promise.allSettled([svc.decideAction(A, 'p1', { decision: 'APPROVE', confirm: true }), svc.decideAction(A, 'p1', { decision: 'APPROVE', confirm: true })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/41100')).toHaveLength(1);
    const p = db.adActionLog.find((l: any) => l.id === 'p1');
    expect(p).toMatchObject({ status: 'APPROVED', approvedBy: 'Admin A' });
    const list = await svc.actions(A, { mode: 'REAL' });
    expect(list.find((l: any) => l.id === 'p1')!.execution).toMatchObject({ status: 'EXECUTED' });
  });

  it('con la conexión vencida no se llama a la plataforma: queda FALLIDA; el reintento usa la misma clave', async () => {
    const { svc, db, calls, acc } = await proposal();
    db.adAccount[0].status = 'EXPIRED';
    calls.length = 0;
    await expect(svc.decideAction(A, 'p1', { decision: 'APPROVE', confirm: true })).rejects.toThrow(/venció/);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const exec = db.adActionLog.find((l: any) => l.idempotencyKey === 'approved:p1')!;
    expect(exec.status).toBe('FAILED');
    db.adAccount[0].status = 'CONNECTED';
    await svc.retryAction(A, exec.id, {});
    expect(db.adActionLog.filter((l: any) => l.idempotencyKey === 'approved:p1')).toHaveLength(1);
    expect(exec.status).toBe('EXECUTED');
    await expect(svc.retryAction(A, exec.id, {})).rejects.toThrow(/Solo se reintenta/);
    expect(acc.id).toBeTruthy();
  });

  it('si ya estaba en pausa no se ejecuta nada (OMITIDA, no "ejecutada"); rechazar no toca la plataforma', async () => {
    const { svc, db, calls } = await proposal();
    db.adEntity.find((e: any) => e.externalId === '41100')!.status = 'PAUSED';
    calls.length = 0;
    const r: any = await svc.decideAction(A, 'p1', { decision: 'APPROVE', confirm: true });
    expect(r.status).toBe('SKIPPED');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    db.adActionLog.push({ id: 'p2', companyId: 'coA', accountId: db.adAccount[0].id, mode: 'REAL', source: 'RULE', idempotencyKey: 'rule:r1:42200:x', level: 'AD', externalId: '42200', action: 'RECOMMEND_PAUSE', status: 'PROPOSED', dataJson: '{}', createdAt: NOW });
    await svc.decideAction(A, 'p2', { decision: 'REJECT' });
    expect(db.adActionLog.find((l: any) => l.id === 'p2')).toMatchObject({ status: 'REJECTED', actor: 'Admin A' });
    await expect(svc.decideAction(A, 'p2', { decision: 'APPROVE', confirm: true })).rejects.toBeInstanceOf(ConflictException);
  });

  it('B no puede aprobar, rechazar ni reintentar acciones de A', async () => {
    const { svc } = await proposal();
    await expect(svc.decideAction(B, 'p1', { decision: 'REJECT' })).rejects.toThrow(/no encontrada/);
    await expect(svc.retryAction(B, 'p1', {})).rejects.toThrow(/no encontrada/);
  });

  it('el Autopilot autorizado solo pausa: nunca envía presupuestos ni activa', async () => {
    const { svc, db, calls } = await proposal();
    db.adSettings.push({ id: 's', companyId: 'coA', autonomy: 'AUTHORIZED', autoActionsJson: '["PAUSE"]', globalPause: false, maxDataAgeHours: 48 });
    db.adRule.push({ id: 'r9', companyId: 'coA', name: 'Gasto alto', metric: 'SPEND', level: 'AD', windowDays: 7, operator: 'GT', threshold: 1, minSpend: 0, action: 'PAUSE', active: true, checkEveryMin: 60 });
    calls.length = 0;
    await svc.runRules('coA', true);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((c) => c.params.get('status') === 'PAUSED' && !c.params.has('daily_budget') && !c.params.has('lifetime_budget'))).toBe(true);
  });
});

describe('Ads · permisos por rol y producto', () => {
  const roles = (m: string) => Reflect.getMetadata(ROLES_KEY, (AdsController.prototype as any)[m]) as string[];

  it('todo el controlador exige el producto ADS; escribir exige un rol de escritura', () => {
    expect(Reflect.getMetadata(PRODUCTS_KEY, AdsController)).toEqual(['ADS']);
    for (const m of ['retry', 'leadFetch', 'decide', 'sync', 'status']) expect(roles(m)).not.toContain('COMPANY_VIEWER');
    for (const m of ['syncs', 'leadList', 'overview', 'revenue']) expect(roles(m)).toContain('COMPANY_VIEWER');
  });

  it('una empresa sin el producto no entra al servicio', async () => {
    const { svc, db } = world();
    db.company.push({ id: 'coX', name: 'Sin ads', planId: 'p1', currency: 'COP', productsJson: JSON.stringify({ AUTOMATION: { enabled: true }, ADS: { enabled: false } }) });
    await expect(svc.overview({ ...A, companyId: 'coX' }, {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});
