import { BadRequestException, Body, Controller, Get, Inject, Injectable, Logger, Optional, Post, Query, forwardRef } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { CompanyTextAi, TextAiRoute } from '../ai/company-text-ai';
import { GeminiPool, isAiUnavailable } from '../ai/gemini-pool';
import { OPEN } from '../common/opportunities/store';
import {
  Analysis, AnalystContext, allowedNumbers, analystMessages, cleanQuestion, fmtDelta, fmtMoney, fmtNum, fmtPct, fmtTimes, normalizeAnalysis, unknownNumbers,
} from '../common/ads/analyst';
// Solo el tipo: ads.module importa este archivo (la clase se resuelve con forwardRef)
import type { AdsService } from './ads.module';

/**
 * Analista con IA de la publicidad de una empresa.
 *  - Junta lo que el código ya calculó (resultados, campañas, anuncios,
 *    hallazgos y embudo del CRM) y le pide a la IA que lo explique y proponga
 *    qué hacer. La IA no calcula ni ejecuta nada.
 *  - IA de la empresa (su llave) o, si el equipo la autorizó, la de prueba.
 *    Sin IA responde que no hay y la pantalla sigue con las reglas.
 *  - El último análisis queda guardado por empresa: abrir la pantalla no gasta.
 */

const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER];
const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN];
const key = (companyId: string, mode: string) => `ads:analysis:${companyId}:${mode}`;

export interface StoredAnalysis {
  at: string;
  days: number;
  period: { since: string; until: string };
  model: string;
  source: 'EMPRESA' | 'GENERICA';
  analysis: Analysis;
  /** Puntos que se descartaron por citar cifras que no estaban en los datos */
  dropped: number;
  by: string | null;
}

export type AnalysisResult =
  | ({ status: 'OK'; question: string | null } & StoredAnalysis)
  | { status: 'NO_AI' | 'NO_DATA' | 'ERROR'; message: string };

@Injectable()
export class AdsAnalystService {
  private readonly logger = new Logger('AdsAnalyst');
  readonly textAi: CompanyTextAi;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => require('./ads.module').AdsService)) private readonly ads: AdsService,
    @Optional() @Inject(AI_PROVIDER) ai?: AiProvider,
  ) {
    this.textAi = new CompanyTextAi(prisma, ai, new GeminiPool(prisma));
  }

  /** Qué IA tiene la empresa y el último análisis guardado. No llama a ninguna IA. */
  async last(user: AuthUser, q: { companyId?: string; mode?: string }) {
    const c = await this.ads.companyOf(user, q.companyId);
    const mode = q.mode === 'DEMO' ? 'DEMO' : 'REAL';
    const row = await this.prisma.platformSetting.findUnique({ where: { key: key(c.id, mode) } });
    return { ai: await this.textAi.describe(c), last: parseJson<StoredAnalysis | null>(row?.value, null) };
  }

  /** Todo lo que se le entrega a la IA: agregados ya calculados, escritos como se ven en pantalla. */
  async context(user: AuthUser, q: { companyId?: string; mode?: string; days?: string }): Promise<{ company: any; ctx: AnalystContext | null; days: number }> {
    const company = await this.ads.companyOf(user, q.companyId);
    const o: any = await this.ads.overview(user, { companyId: company.id, mode: q.mode, days: q.days });
    const days = o.days as number;
    if (!o.accounts?.length || !(o.totals?.spend > 0 || o.totals?.impressions > 0)) return { company, ctx: null, days };
    const cur = o.currency ?? 'COP';
    const money = (v: number | null | undefined) => fmtMoney(v, cur);
    const tree: any = await this.ads.campaignTree(user, { companyId: company.id, mode: o.mode, days: String(days) });
    const t = o.totals;
    const campaigns = (o.campaigns as any[]).filter((x) => x.spend > 0 || x.status === 'ACTIVE').slice(0, 12).map((x) => ({
      name: String(x.name).slice(0, 90), status: x.status ?? null, goal: x.resultLabel,
      spend: money(x.spend)!, shareOfSpend: t.spend > 0 ? fmtPct(Math.round((x.spend / t.spend) * 1000) / 10) : null,
      results: x.resultsAvailable ? fmtNum(x.results) : null, costPerResult: money(x.costPerResult), ctr: fmtPct(x.ctr),
      frequency: fmtTimes(x.frequency), dailyBudget: money(x.dailyBudget),
    }));
    const ads = (tree.campaigns as any[])
      .flatMap((camp) => camp.adsets.flatMap((s: any) => s.ads.map((a: any) => ({ a, camp }))))
      .filter((x) => x.a.metrics.spend > 0)
      .sort((x, y) => y.a.metrics.spend - x.a.metrics.spend)
      .slice(0, 15)
      .map(({ a, camp }) => ({
        name: String(a.name).slice(0, 90), campaign: String(camp.name).slice(0, 90), status: a.effectiveStatus ?? a.status ?? null,
        spend: money(a.metrics.spend)!, results: a.metrics.resultsAvailable ? `${fmtNum(a.metrics.results)} ${String(a.metrics.resultLabel).toLowerCase()}` : null,
        costPerResult: money(a.metrics.costPerResult), ctr: fmtPct(a.metrics.ctr), issues: (a.issues as string[]).slice(0, 3).map((i) => String(i).slice(0, 120)),
      }));
    const opps = await this.prisma.opportunity.findMany({ where: { companyId: company.id, source: 'ADS', mode: o.mode, status: { in: OPEN } }, orderBy: { lastSeenAt: 'desc' }, take: 10 });
    const findings = opps.map((f) => {
      const e = parseJson<any>(f.explanationJson, {});
      const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 200)).slice(0, n) : []);
      return { title: String(f.title).slice(0, 200), severity: f.severity, facts: list(e.facts, 4), interpretation: e.interpretation ? String(e.interpretation).slice(0, 300) : null, missing: list(e.missing, 3) };
    });
    // El CRM real nunca se cruza con datos de demostración
    let crm: AnalystContext['crm'] = null;
    if (o.mode === 'REAL') {
      const r: any = await this.ads.revenue(user, { companyId: company.id, days: String(days === 60 ? 60 : 30) });
      const m = (v: number | null | undefined) => fmtMoney(v, r.currency ?? cur);
      crm = {
        days: days === 60 ? 60 : 30,
        leads: fmtNum(r.totals.leads)!, qualified: fmtNum(r.totals.qualified)!, customers: fmtNum(r.totals.customers)!, sales: fmtNum(r.totals.sales)!, revenue: m(r.totals.revenue)!,
        costPerLead: m(r.totals.costPerLead), costPerCustomer: m(r.totals.cac), roas: r.totals.roas === null || r.totals.roas === undefined ? null : `${r.totals.roas}x`,
        byCampaign: (r.campaigns as any[]).filter((x) => x.leads > 0 || x.spend > 0).slice(0, 8).map((x) => ({
          campaign: String(x.campaignName).slice(0, 90), spend: m(x.spend)!, leads: fmtNum(x.leads)!, qualified: fmtNum(x.qualified)!, customers: fmtNum(x.customers)!, revenue: m(x.revenue)!, costPerLead: m(x.costPerLead),
        })),
        attribution: r.attribution?.counts ? { attributed: fmtNum(r.attribution.counts.ATTRIBUTED)!, partial: fmtNum(r.attribution.counts.PARTIAL)!, unattributed: fmtNum(r.attribution.counts.UNATTRIBUTED)! } : null,
        forms: r.leadForms ? { received: fmtNum(r.leadForms.received)!, withContact: fmtNum(r.leadForms.withContact)!, pendingPermission: fmtNum(r.leadForms.pendingPermission)! } : null,
      };
    }
    const settings = await this.prisma.adSettings.findUnique({ where: { companyId: company.id } });
    const ctx: AnalystContext = {
      business: String(company.name).slice(0, 80), industry: company.industry ? String(company.industry).slice(0, 60) : null, demo: o.mode === 'DEMO',
      period: { since: o.period.current.since, until: o.period.current.until, days, previousSince: o.period.previous.since, previousUntil: o.period.previous.until },
      comparable: !!o.comparable && !o.insufficient,
      totals: {
        spend: money(t.spend), mainResult: t.results === null ? null : `${fmtNum(t.results)} ${String(o.resultLabel ?? 'resultados').toLowerCase()}`, costPerResult: money(t.costPerResult),
        ctr: fmtPct(t.ctr), cpc: money(t.cpc), cpm: money(t.cpm), leads: fmtNum(t.leads), conversations: fmtNum(t.conversations), purchases: fmtNum(t.purchases),
        reach: t.reach === null || t.reach === undefined ? null : `${fmtNum(t.reach)} personas`, frequency: fmtTimes(t.frequency),
        impressions: fmtNum(t.impressions), clicks: fmtNum(t.clicks),
      },
      changes: { spend: fmtDelta(o.deltas.spend), results: fmtDelta(o.deltas.results), costPerResult: fmtDelta(o.deltas.costPerResult), ctr: fmtDelta(o.deltas.ctr), cpc: fmtDelta(o.deltas.cpc), cpm: fmtDelta(o.deltas.cpm) },
      notes: (o.notes as string[]).map((n) => String(n).slice(0, 300)).slice(0, 5),
      campaigns, ads, findings, crm,
      budget: { activeDaily: money(o.configuredDailyBudget) ?? '0', cap: money(settings?.maxDailyBudget ?? null) },
    };
    return { company, ctx, days };
  }

  async analyze(user: AuthUser, dto: { days?: unknown; mode?: unknown; question?: unknown }, companyId?: string): Promise<AnalysisResult> {
    const mode = dto?.mode === 'DEMO' ? 'DEMO' : dto?.mode === 'REAL' ? 'REAL' : undefined;
    const { company, ctx, days } = await this.context(user, { companyId, mode, days: String(dto?.days ?? '') });
    if (dto?.question !== undefined && dto?.question !== null && dto?.question !== '' && !cleanQuestion(dto.question)) throw new BadRequestException('Escribe tu pregunta en una frase');
    const question = cleanQuestion(dto?.question);
    if (!ctx) return { status: 'NO_DATA', message: 'Todavía no hay datos de anuncios en este periodo para analizar. Sincroniza la cuenta o elige un periodo más largo.' };
    const route = await this.textAi.route(company);
    if (route.kind === 'NINGUNA') return { status: 'NO_AI', message: 'Tu empresa todavía no tiene IA activa. Las oportunidades por reglas siguen funcionando; para el análisis escrito conecta tu proveedor de IA en Configuración.' };
    try {
      const done = await this.ask(company, route, ctx, question);
      if (!done) return { status: 'ERROR', message: 'La IA respondió en un formato que no se pudo usar. Intenta de nuevo; las oportunidades por reglas no cambian.' };
      const stored: StoredAnalysis = {
        at: this.now().toISOString(), days, period: { since: ctx.period.since, until: ctx.period.until },
        model: done.model, source: done.source, analysis: done.analysis, dropped: done.dropped, by: user.name ?? null,
      };
      // Una pregunta puntual no reemplaza el análisis general guardado
      if (!question) {
        const k = key(company.id, ctx.demo ? 'DEMO' : 'REAL');
        await this.prisma.platformSetting.upsert({ where: { key: k }, create: { key: k, value: JSON.stringify(stored) }, update: { value: JSON.stringify(stored) } });
      }
      return { status: 'OK', question, ...stored };
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      const status = err?.providerStatus;
      const message = err?.response?.code === 'GENERIC_AI_LIMIT' ? 'Se acabaron los usos de IA de prueba de hoy.'
        : isAiUnavailable(err) ? 'La IA de prueba no está disponible en este momento. Intenta en unos minutos.'
          : status === 401 || status === 403 ? 'Tu proveedor de IA rechazó la llave: revísala en Configuración.'
            : status === 402 ? 'Tu cuenta de IA no tiene saldo.'
              : 'La IA no respondió. Intenta de nuevo en un momento.';
      this.logger.warn(`análisis ${company.id}: ${String(err?.message ?? err).slice(0, 200)}`);
      return { status: 'ERROR', message };
    }
  }

  /** Pide, valida y (una sola vez) hace corregir las cifras que no salían de los datos. Un pedido = un cupo. */
  private async ask(company: any, route: TextAiRoute, ctx: AnalystContext, question: string | null) {
    if (route.kind === 'GENERICA') await this.textAi.reserveGeneric(company.id, route.trial.dailyLimit);
    const requestId = `ads-analysis-${company.id}-${this.now().getTime()}`;
    const knownNames = route.kind === 'GENERICA' ? await this.textAi.knownNames(company.id) : undefined;
    let rejected: string[] = [];
    const call = async (fix?: string[]) => {
      const r = await this.textAi.complete(company, route, {
        purpose: 'ads.analysis', requestId, json: true, maxTokens: 4000, temperature: 0.3, noThinking: true, messages: analystMessages(ctx, question, fix),
      }, { knownNames });
      const raw = extractJson(r.content);
      const n = normalizeAnalysis(raw, ctx, { question: !!question });
      // Aunque no quede nada útil, se sabe qué cifras citó para pedirle que las corrija
      rejected = n ? n.unknown : unknownNumbers(JSON.stringify(raw ?? ''), allowedNumbers(ctx));
      return n ? { ...n, model: r.model, source: r.source } : null;
    };
    let first;
    try {
      first = await call();
    } catch (err) {
      if (route.kind === 'GENERICA') await this.textAi.releaseGeneric(company.id);
      throw err;
    }
    if (first && !first.dropped) return first;
    // Citó cifras que no estaban (o no se pudo leer): un reintento diciéndole exactamente cuáles
    const second = await call(rejected).catch(() => null);
    if (second && (!first || second.dropped <= first.dropped)) return second;
    return first;
  }
}

@Controller('ads/ai')
@Products('ADS')
export class AdsAnalystController {
  constructor(private readonly s: AdsAnalystService) {}

  @Get('analysis') @Roles(...READ)
  last(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.last(u, q); }

  @Post('analysis') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } })
  analyze(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.analyze(u, dto, c); }
}

