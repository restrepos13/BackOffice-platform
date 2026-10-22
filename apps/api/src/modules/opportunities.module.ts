import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Param, Post, Put, Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { DEFAULT_STAGES } from '../common/pipelines';
import { reactivationConfig } from '../common/addon-config';
import { OPEN, OppAction, addDecision, canMove, storeDetected, view } from '../common/opportunities/store';
import { detectCrm } from '../common/opportunities/crm-detectors';
import { observeFollowUp, observeMetric, observePause, ready } from '../common/opportunities/observe';
import { addDays, isoDay } from '../common/ads/provider';
import { ReactivationService } from './addons/reactivation.service';
import { AdsModule, AdsService } from './ads.module';
import { AuditModule, AuditService } from './audit.module';
import { Products } from '../auth/products.guard';
import { ProductInactiveError, hasAnyProduct, hasProduct } from '../common/products';

/**
 * Radar comercial: oportunidades de anuncios y del CRM en un solo lugar,
 * con su evidencia, el registro de decisiones y el resultado observado.
 * Más el "contexto" del negocio: qué sabe BackOffice, qué falta y por dónde
 * empezar, para no pedir datos que ya existen.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
const DAY = 86400e3;
const RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const EVIDENCE_RANK: Record<string, number> = { SUFFICIENT: 0, INITIAL: 1, MISSING_DATA: 2 };

/** Datos que la persona puede corregir (pisan lo inferido). */
const EDITABLE: Record<string, string> = {
  businessType: 'Tipo de negocio', city: 'Ciudad', audience: 'A quién le vendes', mainGoal: 'Objetivo principal', averageTicket: 'Venta promedio',
};
const EVENTS = ['visit', 'intent', 'first_value', 'opportunity_opened', 'abandon_step'];

/** Fuentes del Radar que la empresa puede ver: anuncios con Ads Intelligence, CRM con Automation. */
export function sourcesOf(company: { productsJson?: string | null; planId?: string | null }): Array<'ADS' | 'CRM'> {
  return [...(hasProduct(company, 'ADS') ? (['ADS'] as const) : []), ...(hasProduct(company, 'AUTOMATION') ? (['CRM'] as const) : [])];
}

@Injectable()
export class OpportunitiesService {
  private readonly logger = new Logger('Oportunidades');
  now: () => Date = () => new Date();
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly ads: AdsService) {}

  /** radar=true: oportunidades (necesita alguna fuente). radar=false: contexto de Creative/Ads. */
  async companyOf(user: AuthUser, companyId?: string, radar = true) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    if (radar && !sourcesOf(company).length) throw new ForbiddenException(ProductInactiveError.body(['AUTOMATION', 'ADS'], company));
    if (!radar && !hasAnyProduct(company, ['CREATIVE', 'ADS'])) throw new ForbiddenException(ProductInactiveError.body(['CREATIVE', 'ADS'], company));
    return company;
  }

  private async opp(company: { id: string; productsJson?: string | null; planId?: string | null }, id: string) {
    const o = await this.prisma.opportunity.findUnique({ where: { id } });
    // Una oportunidad de una fuente que la empresa no tiene activa no existe para ella
    if (!o || o.companyId !== company.id || !sourcesOf(company).includes(o.source as any)) throw new NotFoundException('Oportunidad no encontrada');
    return o;
  }

  /* ── Detección del CRM ── */

  async detectCrm(companyId: string) {
    const now = this.now();
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) return { detected: 0 };
    const since = new Date(now.getTime() - 60 * DAY);
    const [convs, contacts, pipelines] = await Promise.all([
      this.prisma.conversation.findMany({ where: { companyId, lastMessageAt: { gte: new Date(now.getTime() - 30 * DAY) } }, orderBy: { lastMessageAt: 'desc' }, take: 400 }),
      this.prisma.contact.findMany({ where: { companyId, createdAt: { gte: since } }, select: { id: true, name: true, stage: true, createdAt: true, lastActivityAt: true }, take: 5000 }),
      this.prisma.pipeline.findMany({ where: { companyId } }),
    ]);
    // Dirección del último mensaje de cada conversación
    const ids = convs.map((c) => c.id);
    const msgs = ids.length ? await this.prisma.message.findMany({ where: { conversationId: { in: ids } }, orderBy: { createdAt: 'desc' }, select: { conversationId: true, direction: true, createdAt: true }, take: 8000 }) : [];
    const lastDir = new Map<string, string>();
    for (const m of msgs) if (!lastDir.has(m.conversationId)) lastDir.set(m.conversationId, m.direction);
    const withConv = new Set((await this.prisma.conversation.findMany({ where: { companyId, contactId: { in: contacts.map((c) => c.id) } }, select: { contactId: true }, take: 10000 })).map((c) => c.contactId));
    const closed = new Set(DEFAULT_STAGES.filter((s) => s.kind !== 'OPEN').map((s) => s.key));
    for (const p of pipelines) for (const st of parseJson<any[]>(p.stagesJson, [])) if (st.kind !== 'OPEN') closed.add(st.key);
    const dormant = await new ReactivationService(this.prisma as any).candidates(company, reactivationConfig(company), now).catch(() => []);
    const items = await this.prisma.orderItem.findMany({
      where: { order: { companyId, status: { notIn: ['borrador', 'cancelado'] }, createdAt: { gte: since } } },
      select: { productName: true, quantity: true, order: { select: { createdAt: true } } }, take: 20000,
    }).catch(() => []);
    const drafts = detectCrm({
      now,
      conversations: convs.map((c) => ({ id: c.id, contactId: c.contactId, status: c.status, lastMessageAt: c.lastMessageAt, lastDirection: (lastDir.get(c.id) as any) ?? null })),
      contacts: contacts.map((c) => ({ ...c, hasConversation: withConv.has(c.id) })),
      firstStage: DEFAULT_STAGES[0].key, closedStages: closed,
      dormant: dormant.map((d) => ({ contactId: d.contactId, dormantDays: d.dormantDays, basis: d.basis })),
      items: (items as any[]).map((it) => ({ productName: it.productName, quantity: it.quantity, createdAt: it.order?.createdAt ?? now })),
    });
    return storeDetected(this.prisma, { companyId, source: 'CRM', mode: 'REAL', keyPrefix: 'crm' }, drafts, now);
  }

  async detectNow(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const sources = sourcesOf(c);
    const crm = sources.includes('CRM') ? await this.detectCrm(c.id) : null;
    const ads = sources.includes('ADS') ? await this.ads.runAudit(c.id).catch(() => ({})) : null;
    return { crm, ads };
  }

  /* ── Lectura ── */

  async list(user: AuthUser, q: { companyId?: string; source?: string; view?: string; mode?: string }) {
    const c = await this.companyOf(user, q.companyId);
    const statuses = q.view === 'done' ? ['EXECUTED', 'OBSERVING', 'RESULT'] : q.view === 'closed' ? ['DISMISSED', 'SNOOZED'] : q.view === 'all' ? undefined : OPEN;
    const where: any = { companyId: c.id, ...(statuses ? { status: { in: statuses } } : {}) };
    const sources = sourcesOf(c);
    where.source = q.source === 'ADS' || q.source === 'CRM' ? (sources.includes(q.source) ? q.source : '__none__') : { in: sources };
    if (q.mode === 'REAL' || q.mode === 'DEMO') where.mode = q.mode;
    const rows = await this.prisma.opportunity.findMany({ where, orderBy: { lastSeenAt: 'desc' }, take: 200 });
    // Lo real va antes que lo de demostración; dentro, más grave y con más evidencia primero
    return rows.map((r) => view(r, this.now())).sort((a: any, b: any) =>
      (a.mode === 'DEMO' ? 1 : 0) - (b.mode === 'DEMO' ? 1 : 0)
      || (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3)
      || (EVIDENCE_RANK[a.evidence] ?? 3) - (EVIDENCE_RANK[b.evidence] ?? 3));
  }

  /** Contactos de una oportunidad de seguimiento (solo de la misma empresa). */
  async contacts(user: AuthUser, id: string, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const o = await this.opp(c, id);
    const action = parseJson<OppAction>(o.actionJson, { type: 'NONE', risk: 'LOW', reversible: true });
    const ids = action.contactIds ?? [];
    if (!ids.length) return [];
    const rows = await this.prisma.contact.findMany({ where: { companyId: c.id, id: { in: ids } }, select: { id: true, name: true, phone: true, stage: true, lastActivityAt: true }, take: 200 });
    // Último chat de cada uno, para abrirlo directo en Conversaciones
    const convs = await this.prisma.conversation.findMany({ where: { companyId: c.id, contactId: { in: rows.map((r) => r.id) } }, orderBy: { lastMessageAt: 'desc' }, select: { id: true, contactId: true }, take: 1000 });
    const last = new Map<string, string>();
    for (const cv of convs) if (!last.has(cv.contactId)) last.set(cv.contactId, cv.id);
    return rows.map((r) => ({ ...r, conversationId: last.get(r.id) ?? null }));
  }

  /* ── Decisiones del usuario ── */

  async move(user: AuthUser, id: string, dto: { to?: string; note?: string; snoozeDays?: number }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const o = await this.opp(c, id);
    const to = String(dto?.to ?? '');
    if (!canMove(o.status, to)) throw new BadRequestException('Ese cambio de estado no está permitido');
    const now = this.now();
    const data: any = { status: to, decisionsJson: addDecision(o.decisionsJson, { at: now.toISOString(), by: user.name, status: to, note: dto?.note }) };
    if (to === 'SNOOZED') {
      const days = [1, 3, 7, 14, 30].includes(Number(dto?.snoozeDays)) ? Number(dto!.snoozeDays) : 7;
      data.snoozedUntil = new Date(now.getTime() + days * DAY);
    }
    if (to === 'DISMISSED' && !String(dto?.note ?? '').trim()) data.decisionsJson = addDecision(o.decisionsJson, { at: now.toISOString(), by: user.name, status: to, note: 'Sin motivo' });
    // Preparar un seguimiento congela la lista y sus etapas (para medir después)
    if (to === 'PREPARED') {
      const action = parseJson<OppAction>(o.actionJson, { type: 'NONE', risk: 'LOW', reversible: true });
      if (action.contactIds?.length) data.baselineJson = JSON.stringify(await this.contactBaseline(c.id, action.contactIds));
    }
    await this.prisma.opportunity.update({ where: { id }, data });
    return view(await this.prisma.opportunity.findUnique({ where: { id } }), this.now());
  }

  private async contactBaseline(companyId: string, ids: string[]) {
    const rows = await this.prisma.contact.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, stage: true }, take: 500 });
    return { contactIds: rows.map((r) => r.id), stages: Object.fromEntries(rows.map((r) => [r.id, r.stage])) };
  }

  /**
   * Actuar: si la acción es ejecutable (pausar un anuncio) se ejecuta en la
   * plataforma con confirmación; si no, se registra que la persona actuó.
   * En ambos casos queda "en observación" hasta medir qué pasó después.
   */
  async act(user: AuthUser, id: string, dto: { confirm?: boolean; note?: string }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const o = await this.opp(c, id);
    if (!OPEN.includes(o.status as any)) throw new ConflictException('Esta oportunidad ya no está abierta');
    if (dto?.confirm !== true) throw new BadRequestException('Confirma la acción');
    const action = parseJson<OppAction>(o.actionJson, { type: 'NONE', risk: 'LOW', reversible: true });
    const now = this.now();
    let baseline: any = parseJson(o.baselineJson, null);
    let decisions = o.decisionsJson;
    let executed: any = null;
    if (action.type === 'PAUSE') {
      // Pausar es una acción de riesgo medio: debe haberse preparado y aprobado
      if (o.status !== 'NEEDS_APPROVAL') throw new BadRequestException('Primero revisa la acción preparada y apruébala');
      executed = await this.ads.pauseForOpportunity(user.name, c.id, o);
      baseline = executed.baseline;
      decisions = addDecision(decisions, { at: now.toISOString(), by: user.name, status: 'EXECUTED', note: executed.demo ? 'Pausado (demostración, simulado)' : 'Pausado en la plataforma' });
      await this.audit.log({ actor: user, companyId: c.id, action: 'opportunity.execute', entity: 'Opportunity', entityId: o.id, detail: o.title });
    } else {
      if (!baseline && action.contactIds?.length) baseline = await this.contactBaseline(c.id, action.contactIds);
      if (!baseline && o.source === 'ADS' && o.accountId && o.externalId && o.level) {
        const m = await this.ads.metricsSince(c.id, o.accountId, o.level, o.externalId, addDays(isoDay(now), -7));
        baseline = { costPerResult: m.totals.costPerResult, results: m.totals.results, effectiveStatus: m.effectiveStatus };
      }
      decisions = addDecision(decisions, { at: now.toISOString(), by: user.name, status: 'EXECUTED', note: dto?.note || 'La persona registró que actuó' });
    }
    decisions = addDecision(decisions, { at: now.toISOString(), by: 'Sistema', status: 'OBSERVING', note: 'Se medirá qué pasa en los próximos días' });
    await this.prisma.opportunity.update({
      where: { id },
      data: { status: 'OBSERVING', actedAt: now, baselineJson: baseline ? JSON.stringify(baseline) : null, decisionsJson: decisions },
    });
    await this.milestone(c.id, 'firstActionAt');
    return { ok: true, demo: executed?.demo ?? o.mode === 'DEMO', opportunity: view(await this.prisma.opportunity.findUnique({ where: { id } }), this.now()) };
  }

  /** Guarda la fecha de un hito una sola vez (sin datos personales). */
  private async milestone(companyId: string, key: string) {
    const ctx = await this.prisma.companyContext.findUnique({ where: { companyId } });
    const progress = parseJson<Record<string, any>>(ctx?.progressJson, {});
    if (progress[key]) return;
    progress[key] = this.now().toISOString();
    if (ctx) await this.prisma.companyContext.update({ where: { companyId }, data: { progressJson: JSON.stringify(progress), updatedAt: this.now() } });
    else await this.prisma.companyContext.create({ data: { companyId, progressJson: JSON.stringify(progress), updatedAt: this.now() } });
  }

  /* ── Observación de resultados ── */

  async observe(companyId?: string) {
    const now = this.now();
    const rows = await this.prisma.opportunity.findMany({ where: { status: 'OBSERVING', ...(companyId ? { companyId } : {}) }, take: 300 });
    let done = 0;
    for (const o of rows) {
      if (!o.actedAt || !ready(o.actedAt, o.ruleKey, now)) continue;
      const base = parseJson<any>(o.baselineJson, null);
      const action = parseJson<OppAction>(o.actionJson, { type: 'NONE', risk: 'LOW', reversible: true });
      let result: any = null;
      if (base?.contactIds?.length) {
        const contacts = await this.prisma.contact.findMany({ where: { companyId: o.companyId, id: { in: base.contactIds } }, select: { id: true, stage: true, lastActivityAt: true } });
        const orders = await this.prisma.order.findMany({ where: { companyId: o.companyId, ...NOT_DELETED, contactId: { in: base.contactIds }, createdAt: { gt: o.actedAt }, status: { notIn: ['borrador', 'cancelado'] } }, select: { contactId: true } });
        result = observeFollowUp(base, o.actedAt, contacts as any, new Set(orders.map((x) => x.contactId as string)));
      } else if (o.source === 'ADS' && o.accountId && o.externalId && o.level) {
        const after = await this.ads.metricsSince(o.companyId, o.accountId, o.level, o.externalId, isoDay(o.actedAt));
        if (action.type === 'PAUSE') result = observePause({ dailySpend: base?.dailySpend ?? 0 }, { days: after.totals.days, spend: after.totals.spend, results: after.totals.results });
        else if (o.ruleKey === 'AD_ISSUES') result = { kind: 'STATUS', facts: [`Estado al actuar: ${base?.effectiveStatus ?? '—'}`, `Estado ahora: ${after.effectiveStatus ?? '—'}`], note: 'Estado reportado por la plataforma.' };
        else result = observeMetric('Costo por resultado', base?.costPerResult ?? null, after.totals.costPerResult);
      } else {
        result = { kind: 'NOTE', facts: [], note: 'No hay una métrica automática para esta oportunidad. Puedes anotar el resultado tú mismo.' };
      }
      await this.prisma.opportunity.update({
        where: { id: o.id },
        data: {
          status: 'RESULT', resultAt: now, resultJson: JSON.stringify(result),
          decisionsJson: addDecision(o.decisionsJson, { at: now.toISOString(), by: 'Sistema', status: 'RESULT', note: 'Resultado medido' }),
        },
      });
      done++;
    }
    return { observed: done };
  }

  /** La persona anota el resultado (p. ej. "cerré 2 ventas"). Queda como dato declarado, no medido. */
  async noteResult(user: AuthUser, id: string, dto: { note?: string }, companyId?: string) {
    const c = await this.companyOf(user, companyId);
    const o = await this.opp(c, id);
    if (!['OBSERVING', 'RESULT'].includes(o.status)) throw new BadRequestException('Primero registra que actuaste');
    const note = String(dto?.note ?? '').trim().slice(0, 400);
    if (!note) throw new BadRequestException('Escribe qué pasó');
    const prev = parseJson<any>(o.resultJson, {});
    await this.prisma.opportunity.update({
      where: { id },
      data: {
        resultJson: JSON.stringify({ ...prev, declared: { note, by: user.name, at: this.now().toISOString() } }),
        decisionsJson: addDecision(o.decisionsJson, { at: this.now().toISOString(), by: user.name, status: o.status, note: `Resultado anotado: ${note}` }),
      },
    });
    return view(await this.prisma.opportunity.findUnique({ where: { id } }), this.now());
  }

  @Cron('20 * * * *')
  async hourly() {
    if (this.busy || process.env.OPPORTUNITIES_CRON_DISABLED === '1') return;
    this.busy = true;
    try {
      await this.observe();
      // Detección del CRM una vez al día por empresa (a la hora 6 de Bogotá ≈ 11 UTC)
      if (this.now().getUTCHours() === 11) {
        const companies = await this.prisma.company.findMany({
          where: { status: { in: ['ACTIVE', 'TRIAL', 'ONBOARDING'] }, OR: [{ planId: { not: null } }, { productsJson: { contains: '"enabled":true' } }] },
          select: { id: true, planId: true, productsJson: true }, take: 500,
        });
        for (const c of companies.filter((x) => hasProduct(x, 'AUTOMATION'))) await this.detectCrm(c.id).catch((err) => this.logger.warn(`CRM ${c.id}: ${err.message}`));
      }
    } finally {
      this.busy = false;
    }
  }

  /* ── Contexto del negocio ── */

  async context(user: AuthUser, companyId?: string) {
    const c = await this.companyOf(user, companyId, false);
    const ctx = await this.prisma.companyContext.findUnique({ where: { companyId: c.id } });
    const overrides = parseJson<Record<string, { value: string; at: string; by: string }>>(ctx?.overridesJson, {});
    const progress = parseJson<Record<string, any>>(ctx?.progressJson, {});
    const ob = parseJson<Record<string, any>>(c.onboardingJson, {});
    const [brand, products, contacts, orders, convs, designs, exported, wa, social, adReal, adDemo, opps, acted, results, published, evidenced] = await Promise.all([
      this.prisma.brandProfile.findUnique({ where: { companyId: c.id } }),
      this.prisma.product.count({ where: { companyId: c.id, active: true, ...NOT_DELETED } }),
      this.prisma.contact.count({ where: { companyId: c.id } }),
      this.prisma.order.count({ where: { companyId: c.id, ...NOT_DELETED } }),
      this.prisma.conversation.count({ where: { companyId: c.id } }),
      this.prisma.creativeDesign.findFirst({ where: { companyId: c.id }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
      this.prisma.creativeDesign.findFirst({ where: { companyId: c.id, exportFile: { not: null } }, orderBy: { updatedAt: 'asc' }, select: { updatedAt: true } }),
      this.prisma.integration.count({ where: { companyId: c.id, type: 'WHATSAPP', status: 'CONNECTED' } }),
      this.prisma.integration.count({ where: { companyId: c.id, type: 'META_SOCIAL', status: 'CONNECTED' } }),
      this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'REAL', status: 'CONNECTED' } }),
      this.prisma.adAccount.count({ where: { companyId: c.id, mode: 'DEMO' } }),
      this.prisma.opportunity.count({ where: { companyId: c.id, status: { in: OPEN }, mode: 'REAL' } }),
      this.prisma.opportunity.findFirst({ where: { companyId: c.id, mode: 'REAL', actedAt: { not: null } }, orderBy: { actedAt: 'asc' } }),
      this.prisma.opportunity.findFirst({ where: { companyId: c.id, mode: 'REAL', status: 'RESULT', actedAt: { not: null } }, orderBy: { resultAt: 'asc' } }),
      this.prisma.contentPiece.findFirst({ where: { companyId: c.id, status: 'PUBLICADO' }, orderBy: { publishedAt: 'asc' }, select: { publishedAt: true } }),
      this.prisma.opportunity.findFirst({ where: { companyId: c.id, mode: 'REAL', evidence: 'SUFFICIENT' }, orderBy: { firstSeenAt: 'asc' }, select: { firstSeenAt: true } }),
    ]);
    const designsFirst = designs;
    const exportedFirst = exported;
    const fact = (key: string, label: string, inferred: unknown, source: string) => {
      const o = overrides[key];
      if (o) return { key, label, value: o.value, source: 'Corregido por ti', confirmed: true, editable: true };
      return { key, label, value: inferred === undefined || inferred === null || inferred === '' ? null : String(inferred), source, confirmed: false, editable: key in EDITABLE };
    };
    const known = [
      fact('businessName', 'Nombre', brand?.name || c.name, 'Registro'),
      fact('businessType', 'Tipo de negocio', ob.businessType ?? c.industry, 'Registro'),
      fact('city', 'Ciudad', c.city, 'Registro'),
      fact('audience', 'A quién le vendes', brand?.audience, 'Marca'),
      fact('mainGoal', 'Objetivo principal', null, '—'),
      fact('averageTicket', 'Venta promedio', null, '—'),
      { key: 'catalog', label: 'Catálogo', value: products ? `${products} productos activos` : null, source: 'Catálogo', confirmed: true, editable: false },
      { key: 'crm', label: 'CRM', value: contacts ? `${contacts} contactos, ${convs} conversaciones, ${orders} pedidos` : null, source: 'CRM', confirmed: true, editable: false },
    ];
    const connections = [
      { key: 'whatsapp', label: 'WhatsApp', connected: wa > 0, why: 'Para detectar seguimientos pendientes y saber de qué anuncio llegó cada chat.' },
      { key: 'social', label: 'Página de Facebook / Instagram', connected: social > 0, why: 'Solo hace falta para publicar o programar.' },
      { key: 'ads', label: 'Cuenta publicitaria', connected: adReal > 0, demo: adDemo > 0, why: 'Solo hace falta para revisar tus anuncios y medir su costo por cliente.' },
    ];
    const missing = [
      ...(!brand ? [{ key: 'brand', label: 'Tu marca (colores, logo, tono)', why: 'Para que los diseños salgan con tu identidad. Toma un minuto y puedes aceptar una propuesta.', href: '/app/creative?tab=marca' }] : []),
      ...(!products ? [{ key: 'catalog', label: 'Productos', why: 'Para proponer publicaciones y detectar productos que crecen.', href: '/app/orders/settings' }] : []),
      ...(!known.find((k) => k.key === 'mainGoal')?.value ? [{ key: 'mainGoal', label: 'Objetivo principal', why: 'Para ordenar las sugerencias según lo que más te importa.', editable: true }] : []),
    ];
    // Logros útiles (no tareas administrativas); la fecha cuenta cuándo pasó
    const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
    const steps = [
      { key: 'design', label: 'Primera pieza creada', at: iso((designsFirst as any)?.createdAt), href: '/app/creative?tab=disenos&nuevo=1' },
      { key: 'export', label: 'Primera pieza exportada o publicada', at: iso((exportedFirst as any)?.updatedAt ?? (published as any)?.publishedAt), href: '/app/creative?tab=disenos' },
      { key: 'evidence', label: 'Primera mejora identificada con evidencia', at: iso((evidenced as any)?.firstSeenAt), href: '/app/creative?tab=oportunidades' },
      { key: 'acted', label: 'Primera oportunidad atendida', at: iso(acted?.actedAt), href: '/app/creative?tab=oportunidades' },
      { key: 'result', label: 'Primer resultado medido', at: iso(results?.resultAt), href: '/app/creative?tab=oportunidades' },
    ].map((st) => ({ ...st, done: !!st.at }));
    const firstValueAt = [progress.firstValueAt, iso(acted?.actedAt), iso((exportedFirst as any)?.updatedAt)].filter(Boolean).sort()[0] ?? null;
    const minutes = (a?: string | null, b?: string | null) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60000)) : null);
    // ¿Qué necesitas hoy? Ordenado por lo que hay en los datos de esta empresa
    const intents = [
      { key: 'followup', label: 'Tengo consultas pero no cierro ventas', hint: convs ? 'Revisamos tus conversaciones y tu embudo' : 'Cuando lleguen conversaciones por WhatsApp, las revisamos', href: convs ? '/app/creative?tab=oportunidades&source=CRM' : '/app/integrations', available: convs > 0, needs: convs ? null : (wa ? 'Recibir las primeras conversaciones' : 'Conectar WhatsApp'), score: opps && convs ? 3 : convs ? 2 : 0 },
      { key: 'post', label: 'Necesito una publicación', hint: 'Plantillas con tu marca, sin conectar nada', href: '/app/creative?tab=disenos&nuevo=1', available: true, needs: null, score: designsFirst ? 1 : 3 },
      { key: 'review_ads', label: 'Revisa mis anuncios', hint: adReal ? 'Auditamos tu cuenta conectada' : 'Te pedimos acceso solo para esto', href: adReal ? '/app/ads?tab=oportunidades' : '/app/ads?tab=cuentas', available: true, needs: adReal ? null : 'Conectar cuenta publicitaria', score: adReal ? 3 : 1 },
      { key: 'more_clients', label: 'Quiero conseguir más clientes', hint: 'Armamos una propuesta de campaña con lo que ya sabemos', href: '/app/ads?tab=nueva', available: true, needs: null, score: 2 },
      { key: 'recover', label: 'Quiero recuperar clientes que dejaron de comprar', hint: orders ? 'Usamos tus pedidos para encontrarlos' : 'Necesita pedidos registrados', href: orders ? '/app/reactivacion' : '/app/orders', available: orders > 0, needs: orders ? null : 'Registrar pedidos', score: orders ? 2 : 0 },
      { key: 'budget', label: '¿Estoy aprovechando mi presupuesto?', hint: adReal ? 'Comparamos gasto y resultados' : 'Necesita una cuenta publicitaria', href: '/app/ads', available: true, needs: adReal ? null : 'Conectar cuenta publicitaria', score: adReal ? 2 : 0 },
    ].sort((a, b) => b.score - a.score);
    return {
      known, connections, missing, steps, intents,
      progress: {
        firstVisitAt: progress.firstVisitAt ?? null, firstIntentAt: progress.firstIntentAt ?? null, firstValueAt, firstActionAt: progress.firstActionAt ?? iso(acted?.actedAt),
        minutesToFirstValue: minutes(progress.firstVisitAt, firstValueAt), abandons: (progress.abandons ?? []).length,
        lastIntent: parseJson<any>(ctx?.preferencesJson, {}).intent ?? null,
      },
      counts: { openOpportunities: opps },
    };
  }

  async correct(user: AuthUser, key: string, dto: { value?: string | null }, companyId?: string) {
    const c = await this.companyOf(user, companyId, false);
    if (!(key in EDITABLE)) throw new BadRequestException('Ese dato no se puede editar aquí');
    const ctx = await this.prisma.companyContext.findUnique({ where: { companyId: c.id } });
    const overrides = parseJson<Record<string, any>>(ctx?.overridesJson, {});
    const value = dto?.value === null || dto?.value === undefined ? '' : String(dto.value).trim().slice(0, 200);
    if (value) overrides[key] = { value, at: this.now().toISOString(), by: user.name };
    else delete overrides[key];
    const data = { overridesJson: JSON.stringify(overrides), updatedAt: this.now() };
    if (ctx) await this.prisma.companyContext.update({ where: { companyId: c.id }, data });
    else await this.prisma.companyContext.create({ data: { companyId: c.id, ...data } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'context.correct', entity: 'CompanyContext', entityId: c.id, detail: `${EDITABLE[key]}: ${value || '(borrado)'}` });
    return this.context(user, c.id);
  }

  /** Eventos de uso para medir tiempo al primer valor y abandonos (sin datos personales). */
  async event(user: AuthUser, dto: { type?: string; intent?: string; step?: string }, companyId?: string) {
    const c = await this.companyOf(user, companyId, false);
    const type = String(dto?.type ?? '');
    if (!EVENTS.includes(type)) throw new BadRequestException('Evento desconocido');
    const ctx = await this.prisma.companyContext.findUnique({ where: { companyId: c.id } });
    const progress = parseJson<Record<string, any>>(ctx?.progressJson, {});
    const prefs = parseJson<Record<string, any>>(ctx?.preferencesJson, {});
    const at = this.now().toISOString();
    if (type === 'visit' && !progress.firstVisitAt) progress.firstVisitAt = at;
    if ((type === 'first_value' || type === 'opportunity_opened') && !progress.firstValueAt) progress.firstValueAt = at;
    if (type === 'intent') {
      const intent = String(dto?.intent ?? '').slice(0, 40);
      progress.intents = [...(progress.intents ?? []), { intent, at }].slice(-50);
      if (!progress.firstIntentAt) progress.firstIntentAt = at;
      prefs.intent = intent;
      prefs.lastIntentAt = at;
    }
    if (type === 'abandon_step') progress.abandons = [...(progress.abandons ?? []), { step: String(dto?.step ?? '').slice(0, 40), at }].slice(-50);
    const data = { progressJson: JSON.stringify(progress), preferencesJson: JSON.stringify(prefs), updatedAt: this.now() };
    if (ctx) await this.prisma.companyContext.update({ where: { companyId: c.id }, data });
    else await this.prisma.companyContext.create({ data: { companyId: c.id, ...data } });
    return { ok: true };
  }
}

// Radar compartido: cada fuente se filtra por producto en el servicio (ADS → Ads Intelligence, CRM → Automation)
@Products('AUTOMATION', 'CREATIVE', 'ADS')
@Controller()
export class OpportunitiesController {
  constructor(private readonly s: OpportunitiesService) {}

  @Get('opportunities') @Roles(...READ) list(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.list(u, q); }
  @Post('opportunities/detect') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 6 } }) detect(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.detectNow(u, c); }
  @Get('opportunities/:id/contacts') @Roles(...READ) contacts(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.contacts(u, id, c); }
  @Post('opportunities/:id/move') @Roles(...WRITE) move(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.move(u, id, dto, c); }
  @Post('opportunities/:id/act') @Roles(...WRITE) act(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.act(u, id, dto, c); }
  @Post('opportunities/:id/result') @Roles(...WRITE) result(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.noteResult(u, id, dto, c); }

  @Get('creative/context') @Roles(...READ) context(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.context(u, c); }
  @Put('creative/context/:key') @Roles(...WRITE) correct(@CurrentUser() u: AuthUser, @Param('key') key: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.correct(u, key, dto, c); }
  @Post('creative/events') @Roles(...READ) @Throttle({ default: { ttl: 60_000, limit: 60 } }) event(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.event(u, dto, c); }
}

@Module({
  imports: [AuditModule, AdsModule],
  providers: [OpportunitiesService],
  controllers: [OpportunitiesController],
})
export class OpportunitiesModule {}
