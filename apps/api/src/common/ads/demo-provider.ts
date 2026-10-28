import {
  AccountRef, AdLevel, AdsProvider, CampaignDraft, PeriodStats, ProviderKey, RemoteAccount, RemoteEntity, RemoteInsight, addDays,
} from './provider';

/**
 * Proveedor de DEMOSTRACIÓN. Genera datos simulados y deterministas (la misma
 * cuenta siempre da los mismos números) para mostrar el producto sin una
 * cuenta real. Todo lo que sale de aquí se guarda con mode=DEMO y la interfaz
 * lo etiqueta como "Datos de demostración". Las acciones no tocan nada real.
 *
 * Escenarios incluidos a propósito para que la auditoría tenga qué mostrar:
 *  - Una campaña cuyo costo por resultado sube en la última semana.
 *  - Un anuncio que gasta sin resultados.
 *  - Un anuncio rechazado.
 *  - Un anuncio que concentra el gasto con peor costo que su par.
 */

function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

interface DemoAd { id: string; name: string; campaign: string; adset: string; status: string; issues: string[]; daily: number; cpr: number; kind: 'leads' | 'conversations' | 'purchases'; trend?: 'worse'; dead?: boolean; ticket?: number }

function plan(prefix: string) {
  const c = (n: number) => `${prefix}c${n}`;
  const s = (n: number) => `${prefix}s${n}`;
  const a = (n: number) => `${prefix}a${n}`;
  const campaigns = [
    { id: c(1), name: 'Mensajes WhatsApp · Desayunos', objective: 'OUTCOME_ENGAGEMENT', daily: 40000 },
    { id: c(2), name: 'Leads · Café en grano', objective: 'OUTCOME_LEADS', daily: 30000 },
    { id: c(3), name: 'Ventas · Tienda online', objective: 'OUTCOME_SALES', daily: 25000 },
  ];
  const adsets = [
    { id: s(1), name: 'Laureles 3 km · 22-40', campaign: c(1) },
    { id: s(2), name: 'Medellín · intereses café', campaign: c(2) },
    { id: s(3), name: 'Remarketing visitantes', campaign: c(3) },
  ];
  const ads: DemoAd[] = [
    { id: a(1), name: 'Video croissant 9:16', campaign: c(1), adset: s(1), status: 'ACTIVE', issues: [], daily: 26000, cpr: 2600, kind: 'conversations', trend: 'worse' },
    { id: a(2), name: 'Foto latte 1:1', campaign: c(1), adset: s(1), status: 'ACTIVE', issues: [], daily: 14000, cpr: 1900, kind: 'conversations' },
    { id: a(3), name: 'Carrusel orígenes', campaign: c(2), adset: s(2), status: 'ACTIVE', issues: [], daily: 21000, cpr: 7000, kind: 'leads' },
    { id: a(4), name: 'Promo 20% primera bolsa', campaign: c(2), adset: s(2), status: 'ACTIVE', issues: [], daily: 9000, cpr: 0, kind: 'leads', dead: true },
    { id: a(5), name: 'Catálogo dinámico', campaign: c(3), adset: s(3), status: 'ACTIVE', issues: [], daily: 18000, cpr: 22000, kind: 'purchases', ticket: 52000 },
    { id: a(6), name: '«El mejor café del mundo»', campaign: c(3), adset: s(3), status: 'DISAPPROVED', issues: ['El anuncio incumple la política de afirmaciones engañosas'], daily: 0, cpr: 0, kind: 'purchases' },
  ];
  return { campaigns, adsets, ads };
}

export class DemoAdsProvider implements AdsProvider {
  readonly demo = true;
  readonly label: string;
  readonly capabilities = { read: true, insights: true, pause: true, resume: true, createCampaign: true, setBudget: false, conversions: false };

  constructor(readonly key: ProviderKey, private readonly today: () => Date = () => new Date()) {
    this.label = `${key === 'META' ? 'Meta Ads' : key === 'GOOGLE' ? 'Google Ads' : 'TikTok Ads'} (demostración)`;
  }

  missingConfig() {
    return [];
  }

  async listAccounts(): Promise<RemoteAccount[]> {
    return [{ externalId: `demo_${this.key.toLowerCase()}_1`, name: 'Cuenta de demostración', currency: 'COP', timezone: 'America/Bogota', active: true }];
  }

  async fetchEntities(account: AccountRef): Promise<RemoteEntity[]> {
    const p = plan(`${account.externalId}_`);
    const ent = (level: AdLevel, r: any, extra: Partial<RemoteEntity>): RemoteEntity => ({
      level, externalId: r.id, campaignExternalId: null, adsetExternalId: null, name: r.name, status: 'ACTIVE', effectiveStatus: 'ACTIVE',
      objective: null, dailyBudget: null, lifetimeBudget: null, issues: [], providerUpdatedAt: null, raw: { demo: true }, ...extra,
    });
    return [
      ...p.campaigns.map((c) => ent('CAMPAIGN', c, { campaignExternalId: c.id, objective: c.objective, dailyBudget: c.daily })),
      ...p.adsets.map((s) => ent('ADSET', s, { campaignExternalId: s.campaign, adsetExternalId: s.id })),
      ...p.ads.map((a) => ent('AD', a, {
        campaignExternalId: a.campaign, adsetExternalId: a.adset, status: a.status === 'DISAPPROVED' ? 'ACTIVE' : a.status,
        effectiveStatus: a.status, issues: a.issues,
      })),
    ];
  }

  async fetchInsights(account: AccountRef, _token: string, since: string, until: string): Promise<RemoteInsight[]> {
    const p = plan(`${account.externalId}_`);
    const end = until;
    const out: RemoteInsight[] = [];
    for (let day = since; day <= until; day = addDays(day, 1)) {
      const daysAgo = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400e3);
      for (const a of p.ads) {
        if (!a.daily) continue;
        const r = rng(`${a.id}${day}`);
        const spend = Math.round(a.daily * (0.8 + r() * 0.4));
        // Escenario "empeora": la última semana el costo por resultado del anuncio
        // se duplica (la campaña sube con holgura sobre el umbral del 30 %, sin
        // depender del ruido de cada fecha)
        const cpr = a.trend === 'worse' && daysAgo < 7 ? a.cpr * 2.2 : a.cpr;
        const results = a.dead || !cpr ? 0 : Math.max(0, Math.round((spend / cpr) * (0.85 + r() * 0.3)));
        const impressions = Math.round(spend / (9 + r() * 4)) * 1;
        const clicks = Math.round(impressions * (0.009 + r() * 0.008));
        out.push({
          level: 'AD', externalId: a.id, campaignExternalId: a.campaign, adsetExternalId: a.adset, date: day,
          spend, impressions, reach: Math.round(impressions / (1.6 + r() * 0.6)), clicks, linkClicks: Math.round(clicks * 0.8),
          leads: a.kind === 'leads' ? results : 0,
          conversations: a.kind === 'conversations' ? results : 0,
          purchases: a.kind === 'purchases' ? results : 0,
          purchaseValue: a.kind === 'purchases' ? results * (a.ticket ?? 0) : 0,
          raw: { demo: true },
        });
      }
    }
    return out;
  }

  /** Alcance simulado del periodo (personas únicas ≈ impresiones / frecuencia). */
  async fetchPeriodStats(account: AccountRef, token: string, since: string, until: string): Promise<PeriodStats> {
    const rows = await this.fetchInsights(account, token, since, until);
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.campaignExternalId ?? '', (by.get(r.campaignExternalId ?? '') ?? 0) + r.impressions);
    const stat = (impressions: number, f: number) => ({ impressions, reach: Math.round(impressions / f), frequency: Math.round(f * 100) / 100 });
    const total = [...by.values()].reduce((s, n) => s + n, 0);
    return {
      account: total ? stat(total, 2.6) : null,
      campaigns: [...by.entries()].map(([externalId, imp], i) => ({ externalId, ...stat(imp, 2.1 + i * 0.4) })),
    };
  }

  async setStatus(_a: AccountRef, _t: string, _l: AdLevel, externalId: string, status: 'ACTIVE' | 'PAUSED') {
    return { demo: true, simulated: `Estado ${status} simulado para ${externalId}. No se tocó ninguna cuenta real.` };
  }

  async createCampaignPaused(_a: AccountRef, _t: string, draft: CampaignDraft) {
    const id = `demo_new_${Date.now().toString(36)}`;
    return { externalId: id, response: { demo: true, simulated: `Campaña "${draft.name}" creada en PAUSA solo en la demostración.` } };
  }

  /** Días que se generan al sincronizar (relativos a hoy). */
  window() {
    const until = addDays(this.today().toISOString().slice(0, 10), -1);
    return { since: addDays(until, -59), until };
  }
}
