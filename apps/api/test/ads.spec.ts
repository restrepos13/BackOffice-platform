/**
 * BackOffice Creative Ads: adaptador de Meta, sincronización sin duplicados,
 * auditoría con evidencia, aislamiento entre empresas, Autopilot con límites,
 * confirmación de acciones que gastan, atribución con el CRM y API de conversiones.
 */
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'k'.repeat(64);

import { AdsService } from '../src/modules/ads.module';
import { MetaAdsProvider, classifyMetaError, metaInsightRow } from '../src/common/ads/meta-ads-provider';
import { AdsProviderError, currencyOffset, fromMinor } from '../src/common/ads/provider';
import { audit as runAudit } from '../src/common/ads/findings';
import { budgetAllowed, evaluateRule, guardAutoAction } from '../src/common/ads/autopilot';
import { revenueFunnel } from '../src/common/ads/revenue';
import { buildProposal, validateBrief } from '../src/common/ads/proposal';
import { buildCapiEvent, sha256 } from '../src/common/ads/conversions';
import { totals } from '../src/common/ads/metrics';
import { encryptSecret } from '../src/common/crypto';
import { createMockPrisma } from './helpers/mock-prisma';

const auditLog = { log: jest.fn(async () => undefined) };
const A = { id: 'uA', name: 'Admin A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const B = { id: 'uB', name: 'Admin B', email: 'b@b.co', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };

function world() {
  const { prisma, db } = createMockPrisma();
  db.company.push(
    { id: 'coA', name: 'Aurora', planId: 'p1', currency: 'COP' },
    { id: 'coB', name: 'Otra', planId: 'p1', currency: 'COP' },
    { id: 'coSinPlan', name: 'Sin plan', planId: null, currency: 'COP' },
  );
  const svc = new AdsService(prisma as any, auditLog as any);
  return { prisma, db, svc };
}

/** Fetch falso de Graph: responde por ruta y registra las llamadas. */
function fakeGraph(routes: Record<string, any | ((url: string, init?: any) => any)>) {
  const calls: Array<{ url: string; init?: any }> = [];
  const fn = async (url: string, init?: any) => {
    calls.push({ url, init });
    const path = new URL(url).pathname.replace(/^\/v[\d.]+/, '');
    const hit = Object.entries(routes).find(([k]) => path === k || path.endsWith(k));
    const body = hit ? (typeof hit[1] === 'function' ? hit[1](url, init) : hit[1]) : { data: [] };
    const status = body?.__status ?? (body?.error ? 400 : 200);
    return { ok: status < 400, status, json: async () => body };
  };
  return { fn, calls };
}

describe('Ads · adaptador de Meta', () => {
  it('lee acciones sin contar dos veces los leads y usa el agregado de Meta', () => {
    const r = metaInsightRow({
      ad_id: '1', campaign_id: '9', adset_id: '5', date_start: '2026-10-01', spend: '1000', impressions: '100', reach: '80', clicks: '5', inline_link_clicks: '4',
      actions: [{ action_type: 'lead', value: '3' }, { action_type: 'onsite_conversion.lead_grouped', value: '3' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '2' }],
      action_values: [{ action_type: 'omni_purchase', value: '50000' }],
    });
    expect(r).toMatchObject({ leads: 3, conversations: 2, spend: 1000, linkClicks: 4, purchaseValue: 50000 });
  });

  it('convierte presupuestos según la moneda (COP sin decimales, USD en centavos)', () => {
    expect(currencyOffset('COP')).toBe(1);
    expect(currencyOffset('USD')).toBe(100);
    expect(fromMinor('50000', 'COP')).toBe(50000);
    expect(fromMinor('2500', 'USD')).toBe(25);
    expect(fromMinor(undefined, 'USD')).toBeNull();
  });

  it('clasifica errores: token vencido, límite de solicitudes, permisos', () => {
    expect(classifyMetaError({ code: 190, message: 'expired' }, 400).kind).toBe('AUTH');
    expect(classifyMetaError({ code: 17, message: 'limit' }, 400).kind).toBe('RATE_LIMIT');
    expect(classifyMetaError({ code: 200, message: 'perm' }, 403).kind).toBe('PERMISSION');
    expect(classifyMetaError({ code: 1, message: 'x' }, 500).kind).toBe('PROVIDER');
  });

  it('recorre la paginación con tope y no sigue enlaces fuera de Graph', async () => {
    let n = 0;
    const g = fakeGraph({
      '/me/adaccounts': (url: string) => {
        n++;
        if (url.includes('after=evil')) throw new Error('no debería seguir');
        return n === 1
          ? { data: [{ account_id: '111', name: 'A', currency: 'COP', account_status: 1 }], paging: { next: 'https://graph.facebook.com/v24.0/me/adaccounts?after=2' } }
          : { data: [{ account_id: '222', name: 'B', currency: 'USD', account_status: 2 }], paging: { next: 'https://evil.example.com/x?after=evil' } };
      },
    });
    const list = await new MetaAdsProvider(g.fn as any).listAccounts('tok');
    expect(list.map((a) => a.externalId)).toEqual(['act_111', 'act_222']);
    expect(list[1].active).toBe(false);
    expect(g.calls).toHaveLength(2);
  });

  it('crea campañas SIEMPRE en pausa, con categorías especiales y sin compartir presupuesto', async () => {
    const g = fakeGraph({ '/act_111/campaigns': { id: '777' } });
    const res = await new MetaAdsProvider(g.fn as any).createCampaignPaused({ externalId: 'act_111', currency: 'COP' }, 'tok', { name: 'X', objective: 'LEADS' });
    expect(res.externalId).toBe('777');
    const body = new URLSearchParams(g.calls[0].init.body);
    expect(body.get('status')).toBe('PAUSED');
    expect(body.get('objective')).toBe('OUTCOME_LEADS');
    expect(body.get('special_ad_categories')).toBe('[]');
    expect(body.get('is_adset_budget_sharing_enabled')).toBe('false');
  });
});

describe('Ads · cuentas, sincronización y aislamiento', () => {
  it('la cuenta demo sincroniza, no duplica al repetir y queda marcada como DEMO', async () => {
    const { svc, db } = world();
    const acc = await svc.connectDemo(A, { provider: 'META' });
    expect(acc.mode).toBe('DEMO');
    const ent = db.adEntity.length;
    const ins = db.adInsightDaily.length;
    expect(ent).toBeGreaterThan(5);
    expect(ins).toBeGreaterThan(100);
    await svc.sync(A, acc.id, 'coA');
    expect(db.adEntity.length).toBe(ent);
    expect(db.adInsightDaily.length).toBe(ins);
    expect(db.adInsightDaily.every((r: any) => r.mode === 'DEMO')).toBe(true);
    const ov = await svc.overview(A, {});
    expect(ov.mode).toBe('DEMO');
    expect(ov.totals.spend).toBeGreaterThan(0);
  });

  it('al re-sincronizar actualiza lo que la plataforma corrigió (atribución tardía) sin duplicar', async () => {
    const { svc, db } = world();
    const acc = await svc.connectDemo(A, {});
    const last = [...db.adInsightDaily].sort((x: any, y: any) => (x.date < y.date ? 1 : -1))[0];
    const real = last.spend;
    last.spend = 1;
    const before = db.adInsightDaily.length;
    // Simula que pasaron horas: vuelve a traer los últimos días
    db.adAccount[0].lastSyncAt = new Date();
    await svc.sync(A, acc.id, 'coA');
    expect(db.adInsightDaily.length).toBe(before);
    expect(db.adInsightDaily.find((r: any) => r.id === last.id)!.spend).toBe(real);
  });

  it('nunca devuelve el token y lo guarda cifrado', async () => {
    const { svc, db } = world();
    svc.fetchImpl = fakeGraph({ '/me/adaccounts': { data: [{ account_id: '123456', name: 'Real', currency: 'COP', account_status: 1 }] } }).fn as any;
    const acc = await svc.connectManual(A, { accountId: 'act_123456', token: 'EAAB'.padEnd(40, 'x') });
    expect(JSON.stringify(acc)).not.toContain('EAAB');
    expect((acc as any).tokenEnc).toBeUndefined();
    expect(db.adAccount[0].tokenEnc).toMatch(/^enc:/);
    expect(JSON.stringify(await svc.accounts(A))).not.toContain('enc:');
  });

  it('rechaza cuentas a las que el token no tiene acceso y cuentas ya conectadas en otra empresa', async () => {
    const { svc } = world();
    svc.fetchImpl = fakeGraph({ '/me/adaccounts': { data: [{ account_id: '123456', name: 'Real', currency: 'COP', account_status: 1 }] } }).fn as any;
    await expect(svc.connectManual(A, { accountId: '999999', token: 'x'.repeat(40) })).rejects.toThrow(/no tiene acceso/);
    await svc.connectManual(A, { accountId: '123456', token: 'x'.repeat(40) });
    await expect(svc.connectManual(B, { accountId: '123456', token: 'y'.repeat(40) })).rejects.toThrow(/otra empresa/);
  });

  it('B no puede ver, sincronizar, desconectar ni tocar nada de A (aunque manipule IDs)', async () => {
    const { svc, db } = world();
    const acc = await svc.connectDemo(A, {});
    const entity = db.adEntity.find((e: any) => e.level === 'CAMPAIGN')!;
    const finding = db.opportunity[0];
    const rule = await svc.createRule(A, { name: 'Gasto', metric: 'SPEND', windowDays: 7, threshold: 1, action: 'RECOMMEND_PAUSE' });
    const brief = await svc.saveBrief(A, { product: 'Café', goal: 'MESSAGES', location: 'Medellín', dailyBudget: 20000 });
    await expect(svc.syncNow(B, acc.id)).rejects.toThrow(/no encontrada/);
    await expect(svc.disconnect(B, acc.id)).rejects.toThrow(/no encontrada/);
    await expect(svc.setEntityStatus(B, entity.id, { status: 'PAUSED', confirm: true })).rejects.toThrow(/no encontrado/);
    expect(finding.companyId).toBe('coA');
    await expect(svc.updateRule(B, rule.id, { threshold: 0 })).rejects.toThrow(/no encontrada/);
    await expect(svc.deleteRule(B, rule.id)).rejects.toThrow(/no encontrada/);
    await expect(svc.createFromBrief(B, brief.id, { accountId: acc.id, confirm: true })).rejects.toThrow(/no encontrado/);
    // B intentando crear con SU brief sobre la cuenta de A
    const briefB = await svc.saveBrief(B, { product: 'Pan', goal: 'MESSAGES', location: 'Cali', dailyBudget: 10000 });
    await expect(svc.createFromBrief(B, briefB.id, { accountId: acc.id, confirm: true })).rejects.toThrow(/no encontrada/);
    // Y sus pantallas están vacías: el companyId de la petición no cuenta para usuarios de empresa
    const ovB = await svc.overview(B, { companyId: 'coA' });
    expect(ovB.accounts).toHaveLength(0);
    expect(ovB.totals.spend).toBe(0);
    await svc.runRules('coA', true);
    expect(await svc.actions(B, { companyId: 'coA' })).toHaveLength(0);
  });

  it('sin plan no hay publicidad', async () => {
    const { svc } = world();
    await expect(svc.accounts({ ...A, companyId: 'coSinPlan' })).rejects.toThrow(/plan/);
  });

  it('un token vencido deja la cuenta en EXPIRED y registra el intento fallido', async () => {
    const { svc, db } = world();
    svc.fetchImpl = fakeGraph({ '/me/adaccounts': { data: [{ account_id: '123456', name: 'Real', currency: 'COP', account_status: 1 }] } }).fn as any;
    const acc = await svc.connectManual(A, { accountId: '123456', token: 'x'.repeat(40) });
    svc.fetchImpl = fakeGraph({ '/act_123456/campaigns': { error: { code: 190, message: 'Session expired' }, __status: 400 } }).fn as any;
    await expect(svc.syncNow(A, acc.id)).rejects.toThrow(/venció/);
    expect(db.adAccount[0].status).toBe('EXPIRED');
    expect(db.adSyncRun[0].status).toBe('ERROR');
  });

  it('datos reales y de demostración nunca se mezclan', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    db.adAccount.push({ id: 'real1', companyId: 'coA', provider: 'META', mode: 'REAL', externalId: 'act_1', name: 'Real', currency: 'COP', status: 'CONNECTED', tokenEnc: encryptSecret('t'), lastSyncAt: new Date() });
    db.adInsightDaily.push({ id: 'i1', companyId: 'coA', accountId: 'real1', mode: 'REAL', level: 'AD', externalId: 'x', campaignExternalId: 'c', date: '2026-10-01', currency: 'COP', spend: 777, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0 });
    const real = await svc.overview(A, {});
    expect(real.mode).toBe('REAL');
    expect(real.accounts.every((a: any) => a.mode === 'REAL')).toBe(true);
    const demo = await svc.overview(A, { mode: 'DEMO' });
    expect(demo.accounts.every((a: any) => a.mode === 'DEMO')).toBe(true);
    // la revenue (CRM real) jamás usa la demo
    const rev = await svc.revenue(A, {});
    expect(rev.totals.spend).toBeLessThanOrEqual(777);
  });
});

describe('Ads · auditoría', () => {
  it('detecta los escenarios con evidencia y explicación, sin duplicar al re-auditar', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    const keys = new Set(db.opportunity.map((f: any) => f.ruleKey));
    expect(keys.has('CPR_UP')).toBe(true);
    expect(keys.has('SPEND_NO_RESULTS')).toBe(true);
    expect(keys.has('AD_ISSUES')).toBe(true);
    const n = db.opportunity.length;
    await svc.auditNow(A);
    expect(db.opportunity.length).toBe(n);
    const f = JSON.parse(db.opportunity[0].explanationJson);
    expect(f.facts.length).toBeGreaterThan(0);
    expect(f).toHaveProperty('assumptions');
    expect(f).toHaveProperty('missing');
    expect(f).toHaveProperty('uncertainty');
    expect(db.opportunity.every((o: any) => o.source === 'ADS' && o.mode === 'DEMO' && o.summary && JSON.parse(o.sourcesJson).length)).toBe(true);
    expect(db.opportunity.every((o: any) => ['SUFFICIENT', 'INITIAL', 'MISSING_DATA'].includes(o.evidence))).toBe(true);
  });

  it('sin resultados en toda la cuenta, culpa a la medición y no a las campañas', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      externalId: 'ad1', campaignExternalId: 'c1', date: `2026-10-${String(i + 1).padStart(2, '0')}`, spend: 10000, impressions: 1000, reach: 800, clicks: 10, linkClicks: 8, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0,
    }));
    const ents = [{ level: 'CAMPAIGN', externalId: 'c1', name: 'C', issues: [] }, { level: 'AD', externalId: 'ad1', campaignExternalId: 'c1', name: 'Ad', effectiveStatus: 'ACTIVE', issues: [] }];
    const f = runAudit(ents, rows, { until: '2026-10-14', currency: 'COP' });
    expect(f.map((x) => x.ruleKey)).toContain('MEASUREMENT');
    expect(f.map((x) => x.ruleKey)).not.toContain('SPEND_NO_RESULTS');
  });

  it('no juzga un anuncio por los días recientes (retraso de atribución) ni si es nuevo', () => {
    const mk = (id: string, d: string, spend: number, leads: number) => ({ externalId: id, campaignExternalId: 'c1', date: d, spend, impressions: 100, reach: 90, clicks: 2, linkClicks: 2, leads, conversations: 0, purchases: 0, purchaseValue: 0 });
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => mk('good', `2026-10-${String(i + 1).padStart(2, '0')}`, 10000, 5)),
      // El anuncio nuevo solo tiene gasto en los dos últimos días
      mk('new', '2026-10-09', 50000, 0), mk('new', '2026-10-10', 50000, 0),
    ];
    const ents = [
      { level: 'CAMPAIGN', externalId: 'c1', name: 'C', issues: [] },
      { level: 'AD', externalId: 'good', campaignExternalId: 'c1', name: 'Bueno', effectiveStatus: 'ACTIVE', issues: [] },
      { level: 'AD', externalId: 'new', campaignExternalId: 'c1', name: 'Nuevo', effectiveStatus: 'ACTIVE', issues: [] },
    ];
    const f = runAudit(ents, rows, { until: '2026-10-10', currency: 'COP' });
    expect(f.filter((x) => x.ruleKey === 'SPEND_NO_RESULTS')).toHaveLength(0);
  });
});

describe('Ads · Autopilot', () => {
  const base = { action: 'PAUSE' as const, autonomy: 'AUTHORIZED' as const, autoActions: ['PAUSE'], globalPause: false, dataAgeHours: 1, maxDataAgeHours: 6, entityActive: true, sameCompany: true, tokenValid: true };

  it('el guardia respeta pausa global, modo, habilitación, permisos y frescura', () => {
    expect(guardAutoAction(base).decision).toBe('EXECUTE');
    expect(guardAutoAction({ ...base, globalPause: true }).decision).toBe('SKIP');
    expect(guardAutoAction({ ...base, sameCompany: false }).decision).toBe('SKIP');
    expect(guardAutoAction({ ...base, autonomy: 'ANALYSIS' }).decision).toBe('ALERT');
    expect(guardAutoAction({ ...base, autonomy: 'RECOMMEND' }).decision).toBe('PROPOSE');
    expect(guardAutoAction({ ...base, autoActions: [] }).decision).toBe('PROPOSE');
    expect(guardAutoAction({ ...base, dataAgeHours: 30 }).decision).toBe('PROPOSE');
    expect(guardAutoAction({ ...base, dataAgeHours: null }).decision).toBe('PROPOSE');
    expect(guardAutoAction({ ...base, tokenValid: false }).decision).toBe('PROPOSE');
    expect(guardAutoAction({ ...base, entityActive: false }).decision).toBe('SKIP');
  });

  it('una regla que no se cumple no hace nada; la que se cumple propone una sola vez por día', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    await svc.saveSettings(A, { autonomy: 'RECOMMEND' });
    await svc.createRule(A, { name: 'Nunca', metric: 'SPEND', windowDays: 7, threshold: 1e12, action: 'RECOMMEND_PAUSE' });
    await svc.runRulesNow(A);
    expect(db.adActionLog).toHaveLength(0);
    await svc.createRule(A, { name: 'Gasto alto', metric: 'SPEND', windowDays: 7, threshold: 1, action: 'RECOMMEND_PAUSE' });
    await svc.runRulesNow(A);
    const n = db.adActionLog.length;
    expect(n).toBeGreaterThan(0);
    expect(db.adActionLog.every((l: any) => l.status === 'PROPOSED')).toBe(true);
    await svc.runRulesNow(A);
    expect(db.adActionLog.length).toBe(n);
  });

  it('en modo autorizado con pausar habilitado, pausa sola; con pausa global, no hace nada', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    await svc.saveSettings(A, { autonomy: 'AUTHORIZED', autoActions: ['PAUSE', 'RAISE_BUDGET'], globalPause: true });
    // La IA/el cliente no puede colar acciones que no existen
    expect((await svc.settings(A)).autoActions).toEqual(['PAUSE']);
    await svc.createRule(A, { name: 'Pausar caros', metric: 'SPEND', windowDays: 7, threshold: 1, action: 'PAUSE' });
    await svc.runRulesNow(A);
    expect(db.adActionLog).toHaveLength(0);
    await svc.saveSettings(A, { autonomy: 'AUTHORIZED', autoActions: ['PAUSE'], globalPause: false });
    await svc.runRulesNow(A);
    expect(db.adActionLog.some((l: any) => l.status === 'EXECUTED' && l.action === 'PAUSE' && l.actor === 'Autopilot')).toBe(true);
  });

  it('aprobar una propuesta la ejecuta una sola vez; revertir exige confirmación', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    await svc.saveSettings(A, { autonomy: 'RECOMMEND' });
    await svc.createRule(A, { name: 'Gasto', metric: 'SPEND', windowDays: 7, threshold: 1, action: 'RECOMMEND_PAUSE' });
    await svc.runRulesNow(A);
    const p = db.adActionLog.find((l: any) => l.status === 'PROPOSED')!;
    await expect(svc.decideAction(A, p.id, { decision: 'APPROVE' })).rejects.toThrow(/Confirma/);
    const res = await svc.decideAction(A, p.id, { decision: 'APPROVE', confirm: true });
    await expect(svc.decideAction(A, p.id, { decision: 'APPROVE', confirm: true })).rejects.toThrow(/ya se decidió/);
    await expect(svc.revertAction(A, (res as any).logId, {})).rejects.toThrow(/confirma/);
    await svc.revertAction(A, (res as any).logId, { confirm: true });
    expect(db.adActionLog.some((l: any) => l.action === 'RESUME' && l.status === 'EXECUTED')).toBe(true);
  });

  it('una acción que falla en la plataforma queda registrada como FAILED', async () => {
    const { svc, db } = world();
    svc.fetchImpl = fakeGraph({ '/me/adaccounts': { data: [{ account_id: '123456', name: 'Real', currency: 'COP', account_status: 1 }] } }).fn as any;
    await svc.connectManual(A, { accountId: '123456', token: 'x'.repeat(40) });
    db.adEntity.push({ id: 'e1', companyId: 'coA', accountId: db.adAccount[0].id, provider: 'META', mode: 'REAL', level: 'CAMPAIGN', externalId: '555555', name: 'C', status: 'ACTIVE', effectiveStatus: 'ACTIVE' });
    svc.fetchImpl = fakeGraph({ '/555555': { error: { code: 1, message: 'boom' }, __status: 500 } }).fn as any;
    await expect(svc.setEntityStatus(A, 'e1', { status: 'PAUSED', confirm: true })).rejects.toThrow(/boom/);
    expect(db.adActionLog[0].status).toBe('FAILED');
    expect(db.adEntity[0].status).toBe('ACTIVE');
  });

  it('reanudar (gasta dinero) exige confirmación explícita', async () => {
    const { svc, db } = world();
    await svc.connectDemo(A, {});
    const e = db.adEntity.find((x: any) => x.level === 'CAMPAIGN')!;
    await expect(svc.setEntityStatus(A, e.id, { status: 'ACTIVE' })).rejects.toThrow(/gasta presupuesto/);
  });

  it('las reglas validan sus límites y la frecuencia no suma alcances', () => {
    const rows = [
      { externalId: 'a', campaignExternalId: 'c', date: '2026-10-01', spend: 10, impressions: 500, reach: 100, clicks: 1, linkClicks: 1, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0 },
      { externalId: 'a', campaignExternalId: 'c', date: '2026-10-02', spend: 10, impressions: 500, reach: 100, clicks: 1, linkClicks: 1, leads: 0, conversations: 0, purchases: 0, purchaseValue: 0 },
    ];
    const m = evaluateRule({ id: 'r', name: 'F', metric: 'FREQUENCY', level: 'CAMPAIGN', windowDays: 7, operator: 'GT', threshold: 4, minSpend: 0, action: 'ALERT' }, [{ level: 'CAMPAIGN', externalId: 'c', name: 'C', effectiveStatus: 'ACTIVE' }], rows, '2026-10-02');
    expect(m[0].value).toBe(10);
    expect(budgetAllowed(100, 50).ok).toBe(false);
    expect(budgetAllowed(40, 50).ok).toBe(true);
    expect(budgetAllowed(-1, null).ok).toBe(false);
  });
});

describe('Ads · Campaign Studio', () => {
  it('valida lo esencial según el objetivo y respeta el tope de presupuesto', async () => {
    expect(validateBrief({ goal: 'SALES', product: 'x', location: 'y', dailyBudget: 1000 }, { currency: 'COP' })).toEqual(expect.arrayContaining(['Falta: destino (link o WhatsApp)', 'Falta: valor promedio de venta']));
    expect(validateBrief({ goal: 'MESSAGES', product: 'x', location: 'y', dailyBudget: 1000 }, { currency: 'COP' })).toEqual([]);
    const { svc } = world();
    await svc.saveSettings(A, { maxDailyBudget: 50000 });
    await expect(svc.saveBrief(A, { product: 'Café', goal: 'MESSAGES', location: 'Medellín', dailyBudget: 80000 })).rejects.toThrow(/tope diario/);
  });

  it('la propuesta separa recomendación de configuración y declara supuestos y faltantes', () => {
    const p = buildProposal({ product: 'Café', goal: 'MESSAGES', location: 'Medellín', dailyBudget: 30000 }, { currency: 'COP', brandName: 'Aurora', ctas: [] });
    expect(p.providerConfig.status).toBe('PAUSED');
    expect(p.missing.length).toBeGreaterThan(0);
    expect(p.recommendation.variants.map((v) => v.hypothesis)).toEqual(['OFERTA', 'PROPUESTA_DE_VALOR', 'FORMATO']);
    expect(p.recommendation.budget.total).toBe(30000 * 14);
  });

  it('crear la campaña pide confirmación, la deja en pausa y no se repite', async () => {
    const { svc, db } = world();
    const acc = await svc.connectDemo(A, {});
    const b = await svc.saveBrief(A, { product: 'Café', goal: 'MESSAGES', location: 'Medellín', dailyBudget: 20000 });
    await expect(svc.createFromBrief(A, b.id, { accountId: acc.id })).rejects.toThrow(/Confirma/);
    const res = await svc.createFromBrief(A, b.id, { accountId: acc.id, confirm: true });
    expect(res).toMatchObject({ status: 'PAUSED', demo: true });
    await expect(svc.createFromBrief(A, b.id, { accountId: acc.id, confirm: true })).rejects.toThrow(/ya se creó/);
    expect(db.adActionLog.filter((l: any) => l.action === 'CREATE_CAMPAIGN')).toHaveLength(1);
  });
});

describe('Ads · Revenue Intelligence', () => {
  const ads = [{ externalId: 'ad1', campaignExternalId: 'c1' }, { externalId: 'ad2', campaignExternalId: 'c2' }];
  const campaigns = [{ externalId: 'c1', name: 'Uno' }, { externalId: 'c2', name: 'Dos' }];
  const origin = (id: string) => JSON.stringify({ kind: 'AD', sourceId: id, at: '2026-10-01T00:00:00Z' });
  const d = (s: string) => new Date(`${s}T12:00:00Z`);
  const stages = { first: 'CURIOSO', won: new Set(['CLIENTE']), lost: new Set(['DESCARTADO']) };

  it('vincula solo con el ID del anuncio, separa ventas confirmadas y no atribuye ventas anteriores', () => {
    const f = revenueFunnel({
      contacts: [
        { id: 'k1', stage: 'CLIENTE', createdAt: d('2026-10-02'), originJson: origin('ad1') },
        { id: 'k2', stage: 'CURIOSO', createdAt: d('2026-10-03'), originJson: origin('ad1') },
        { id: 'k3', stage: 'CALIENTE', createdAt: d('2026-10-03'), originJson: origin('ad2') },
        { id: 'k4', stage: 'CLIENTE', createdAt: d('2026-10-03'), originJson: origin('desconocido') },
        { id: 'k5', stage: 'CLIENTE', createdAt: d('2026-10-03'), originJson: JSON.stringify({ kind: 'DIRECT' }) },
        { id: 'k1', stage: 'CLIENTE', createdAt: d('2026-10-02'), originJson: origin('ad1') },
      ],
      orders: [
        { contactId: 'k1', total: 100000, paymentStatus: 'PAID', status: 'confirmado', createdAt: d('2026-10-04') },
        { contactId: 'k1', total: 999999, paymentStatus: 'PAID', status: 'confirmado', createdAt: d('2026-09-01') },
        { contactId: 'k1', total: 50000, paymentStatus: 'PAID', status: 'cancelado', createdAt: d('2026-10-05') },
        { contactId: 'k3', total: 40000, paymentStatus: 'PENDING', status: 'confirmado', createdAt: d('2026-10-05') },
        { contactId: 'k5', total: 70000, paymentStatus: 'PAID', status: 'entregado', createdAt: d('2026-10-05') },
      ],
      ads, campaigns, spendByCampaign: new Map([['c1', { spend: 50000, results: 4 }], ['c2', { spend: 20000, results: 1 }]]), stages,
      since: d('2026-10-01'), until: d('2026-10-31'),
    });
    const c1 = f.campaigns.find((c) => c.campaignExternalId === 'c1')!;
    expect(c1).toMatchObject({ leads: 2, qualified: 1, customers: 1, sales: 1, revenue: 100000, costPerLead: 25000, cac: 50000, roas: 2 });
    const c2 = f.campaigns.find((c) => c.campaignExternalId === 'c2')!;
    expect(c2).toMatchObject({ leads: 1, qualified: 1, revenue: 0, roas: null });
    expect(f.unattributedAds).toBe(1);
    expect(f.totals.revenue).toBe(100000);
  });

  it('sin datos no inventa métricas', () => {
    const f = revenueFunnel({ contacts: [], orders: [], ads: [], campaigns: [], spendByCampaign: new Map(), stages, since: d('2026-10-01'), until: d('2026-10-31') });
    expect(f.totals).toMatchObject({ leads: 0, costPerLead: null, cac: null, roas: null });
  });

  it('separa la facturación total del negocio de lo atribuido a anuncios', async () => {
    const { svc, db } = world();
    db.order.push({ id: 'o1', companyId: 'coA', contactId: null, total: 500000, paymentStatus: 'PAID', status: 'confirmado', createdAt: new Date(), deletedAt: null });
    const r = await svc.revenue(A, {});
    expect(r.businessRevenue).toBe(500000);
    expect(r.totals.revenue).toBe(0);
    expect(r.connected).toBe(false);
  });
});

describe('Ads · API de conversiones', () => {
  it('sin consentimiento no arma el evento; con él, solo datos mínimos y con hash', () => {
    const base = { eventName: 'Purchase' as const, eventId: 'o1', eventTime: new Date('2026-10-01T00:00:00Z'), value: 52000, currency: 'COP', phone: '+57 300 123 4567', email: ' Ana@Mail.com ', ctwaClid: null };
    expect(buildCapiEvent({ ...base, consent: false })).toBeNull();
    const e: any = buildCapiEvent({ ...base, consent: true });
    expect(e.user_data.ph[0]).toBe(sha256('573001234567'));
    expect(e.user_data.em[0]).toBe(sha256('ana@mail.com'));
    expect(JSON.stringify(e)).not.toContain('300 123');
    expect(e.event_id).toBe('o1');
    expect(e.custom_data).toEqual({ value: 52000, currency: 'COP' });
  });
});

describe('Ads · métricas', () => {
  it('sin impresiones o clics las derivadas quedan en null, no en 0', () => {
    const t = totals([]);
    expect(t).toMatchObject({ spend: 0, ctr: null, cpc: null, cpm: null, costPerResult: null });
  });

  it('error de proveedor tipado', () => {
    expect(new AdsProviderError('AUTH', 'x').kind).toBe('AUTH');
  });
});
