import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NOT_DELETED } from '../../common/constants';
import { addonEnabled, salesAuditConfig } from '../../common/addon-config';
import { AI_PROVIDER, type AiProvider, extractJson } from '../../ai/types';
import { AiSession, recordAiUsage, resolveAiAccess } from '../../ai/ai-access';
import { EmailsService } from '../emails.module';

/**
 * Auditor de ventas con IA (informe semanal).
 *  1. Con código (gratis): conversaciones de la semana, cuántas terminaron en
 *     venta, tiempo de primera respuesta y, para cada una que NO vendió, el
 *     motivo más probable por reglas (precio, demora, sin producto, no le
 *     respondimos, el cliente dejó de responder, otro).
 *  2. Con IA (opcional, una sola llamada por semana, pocos miles de tokens):
 *     afina los motivos leyendo fragmentos y da 3 recomendaciones concretas.
 *     Si no hay IA disponible, el informe sale igual con las reglas.
 *  3. Se guarda, se ve en el panel y se envía por correo.
 */

const DAY = 86400e3;

export type LossReason = 'PRECIO' | 'DEMORA' | 'SIN_PRODUCTO' | 'NO_RESPONDIMOS' | 'CLIENTE_SE_ENFRIO' | 'OTRO';

export const LOSS_LABELS: Record<LossReason, string> = {
  PRECIO: 'Le pareció caro',
  DEMORA: 'Tardamos en responder o en entregar',
  SIN_PRODUCTO: 'No teníamos lo que buscaba',
  NO_RESPONDIMOS: 'Nadie le respondió',
  CLIENTE_SE_ENFRIO: 'Dejó de responder',
  OTRO: 'Otro motivo',
};

const RULES: Array<{ reason: LossReason; re: RegExp; side: 'IN' | 'OUT' | 'ANY' }> = [
  // Objeción de precio (preguntar el precio NO es una objeción)
  { reason: 'PRECIO', re: /\b(caro|costoso|muy alto|descuento|m[aá]s barato|rebaja|no me alcanza|fuera de (mi )?presupuesto|no tengo presupuesto)\b/i, side: 'IN' },
  { reason: 'SIN_PRODUCTO', re: /\b(agotad[oa]s?|no (lo )?tenemos|no hay|no nos queda|sin existencias|no est[aá] disponible|no manejamos)\b/i, side: 'OUT' },
  { reason: 'SIN_PRODUCTO', re: /\b(no tienen|no hay|lo tienen\?|tienen disponible)\b/i, side: 'IN' },
  { reason: 'DEMORA', re: /\b(demora|demor[aó]|tarda|tard[oó]|lento|para hoy|no me han respondido|hola\?|sigue(n)? ah[ií])\b/i, side: 'IN' },
];

const SLOW_FIRST_REPLY_MIN = 15;

export interface AuditStats {
  conversations: number;
  sales: number;
  conversion: number;
  revenue: number;
  avgFirstReplyMin: number | null;
  lost: number;
}

@Injectable()
export class SalesAuditService {
  private readonly logger = new Logger('AuditorVentas');

  constructor(
    private readonly prisma: PrismaService,
    private readonly emails: EmailsService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  /** Motivo por reglas de una conversación que no terminó en venta. */
  classify(messages: Array<{ direction: string; content: string; createdAt: Date; author?: string }>, firstReplyMin: number | null, now: Date): LossReason {
    const last = messages[messages.length - 1];
    if (last && last.direction === 'IN' && now.getTime() - new Date(last.createdAt).getTime() > 2 * 3600e3) return 'NO_RESPONDIMOS';
    for (const rule of RULES) {
      const hit = messages.some((m) => (rule.side === 'ANY' || m.direction === rule.side) && rule.re.test(m.content ?? ''));
      if (hit) return rule.reason;
    }
    if (firstReplyMin != null && firstReplyMin > SLOW_FIRST_REPLY_MIN) return 'DEMORA';
    if (last && last.direction === 'OUT') return 'CLIENTE_SE_ENFRIO';
    return 'OTRO';
  }

  private firstReplyMinutes(messages: Array<{ direction: string; createdAt: Date }>): number | null {
    const firstIn = messages.find((m) => m.direction === 'IN');
    if (!firstIn) return null;
    const reply = messages.find((m) => m.direction === 'OUT' && new Date(m.createdAt) > new Date(firstIn.createdAt));
    return reply ? Math.round((new Date(reply.createdAt).getTime() - new Date(firstIn.createdAt).getTime()) / 60000) : null;
  }

  private recommendationsFor(reasons: Array<{ reason: LossReason; count: number }>, stats: AuditStats): string[] {
    const out: string[] = [];
    const top = reasons.filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
    for (const r of top.slice(0, 3)) {
      if (r.reason === 'NO_RESPONDIMOS') out.push('Hay clientes que escribieron y nadie les respondió: revisa las conversaciones marcadas para una persona y responde el mismo día.');
      if (r.reason === 'PRECIO') out.push('Varios clientes sintieron el precio alto: prueba una opción más económica, un combo o explica mejor qué incluye.');
      if (r.reason === 'SIN_PRODUCTO') out.push('Se perdieron ventas por productos agotados: actualiza los agotados en el catálogo y ofrece una alternativa parecida.');
      if (r.reason === 'DEMORA') out.push('La demora está costando ventas: responde más rápido o deja que el asistente conteste solo en las horas de más movimiento.');
      if (r.reason === 'CLIENTE_SE_ENFRIO') out.push('Hay clientes que dejaron de responder: activa los seguimientos automáticos para escribirles a las pocas horas.');
    }
    if (stats.avgFirstReplyMin != null && stats.avgFirstReplyMin > SLOW_FIRST_REPLY_MIN && !out.some((x) => x.includes('demora'))) {
      out.push(`Tu primera respuesta tarda en promedio ${stats.avgFirstReplyMin} minutos; bajarla a menos de 5 suele subir las ventas.`);
    }
    // Con pocos datos igual dejamos acciones concretas para la semana
    if (stats.lost > 0 && out.length < 3) out.push(`${stats.lost === 1 ? 'Escríbele hoy a quien no compró' : `Escríbeles hoy a los ${stats.lost} que no compraron`} esta semana (están en los ejemplos) con un mensaje corto y personal.`);
    if (stats.sales > 0 && out.length < 3) out.push('A quienes sí compraron, pregúntales en un par de días cómo les fue: es la forma más fácil de que vuelvan y te recomienden.');
    return out.slice(0, 3);
  }

  async generate(company: any, opts: { now?: Date; days?: number; send?: boolean } = {}) {
    const now = opts.now ?? new Date();
    const days = opts.days ?? 7;
    const from = new Date(now.getTime() - days * DAY);
    const conversations = await this.prisma.conversation.findMany({
      where: { companyId: company.id, lastMessageAt: { gte: from } },
      include: { contact: { select: { name: true } } },
      take: 400,
    });
    const rows: Array<{ id: string; contact: string; sold: boolean; amount: number; reason: LossReason | null; firstReplyMin: number | null; snippet: string; transcript: string }> = [];
    for (const conv of conversations) {
      const messages = await this.prisma.message.findMany({ where: { conversationId: conv.id, createdAt: { gte: from } }, orderBy: { createdAt: 'asc' }, take: 60 });
      if (!messages.some((m: any) => m.direction === 'IN')) continue;
      const orders = await this.prisma.order.findMany({ where: { conversationId: conv.id, status: { notIn: ['borrador', 'cancelado'] }, createdAt: { gte: from }, ...NOT_DELETED }, select: { total: true } });
      const firstReplyMin = this.firstReplyMinutes(messages);
      const sold = orders.length > 0;
      const keyIn = [...messages].reverse().find((m: any) => m.direction === 'IN');
      rows.push({
        id: conv.id, contact: conv.contact?.name ?? 'Cliente', sold, amount: orders.reduce((s: number, o: any) => s + (o.total ?? 0), 0),
        reason: sold ? null : this.classify(messages, firstReplyMin, now), firstReplyMin,
        snippet: String(keyIn?.content ?? '').slice(0, 160),
        transcript: messages.slice(-8).map((m: any) => `${m.direction === 'IN' ? 'Cliente' : 'Negocio'}: ${String(m.content ?? '').slice(0, 160)}`).join('\n'),
      });
    }
    const replies = rows.map((r) => r.firstReplyMin).filter((v): v is number => v != null);
    const stats: AuditStats = {
      conversations: rows.length,
      sales: rows.filter((r) => r.sold).length,
      conversion: rows.length ? Math.round((rows.filter((r) => r.sold).length / rows.length) * 1000) / 10 : 0,
      revenue: rows.reduce((s, r) => s + r.amount, 0),
      avgFirstReplyMin: replies.length ? Math.round(replies.reduce((a, b) => a + b, 0) / replies.length) : null,
      lost: rows.filter((r) => !r.sold).length,
    };
    const lostRows = rows.filter((r) => !r.sold);
    let reasons = (Object.keys(LOSS_LABELS) as LossReason[]).map((reason) => ({ reason, label: LOSS_LABELS[reason], count: lostRows.filter((r) => r.reason === reason).length }));
    let recommendations = this.recommendationsFor(reasons, stats);
    let source: 'IA' | 'REGLAS' = 'REGLAS';
    let model: string | null = null;
    let tokens = 0;

    // Afinado con IA (una llamada por semana)
    if (salesAuditConfig(company).useAi && this.ai && lostRows.length >= 3) {
      try {
        const access = await resolveAiAccess(this.prisma, company);
        if (access.ok) {
          const session = new AiSession(access);
          const ai = this.ai;
          const sample = lostRows.slice(0, 25);
          const aiModel = 'meta-llama/Llama-3.3-70B-Instruct';
          const { result, billedTo } = await session.run((apiKey) => ai.chat({
            apiKey, model: aiModel, temperature: 0.2, maxTokens: 900, jsonMode: true,
            messages: [
              {
                role: 'system',
                content:
                  `Eres auditor de ventas de ${company.name}. Te paso conversaciones de WhatsApp que NO terminaron en venta, cada una con un número. ` +
                  `Para cada una elige el motivo principal: ${Object.keys(LOSS_LABELS).join(', ')}. ` +
                  'Luego da exactamente 3 recomendaciones cortas, concretas y accionables para el dueño (en español colombiano, sin tecnicismos). ' +
                  'Devuelve SOLO JSON: {"motivos":[{"n":1,"motivo":"PRECIO"}],"recomendaciones":["","",""]}',
              },
              { role: 'user', content: sample.map((r, i) => `#${i + 1}\n${r.transcript}`).join('\n\n').slice(0, 14000) },
            ],
          }));
          tokens = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
          model = result.model ?? aiModel;
          await recordAiUsage(this.prisma, { companyId: company.id, model: model!, inputTokens: result.inputTokens, outputTokens: result.outputTokens, billedTo, purpose: 'AUDITOR' });
          const parsed: any = extractJson(result.content);
          const valid = new Set(Object.keys(LOSS_LABELS));
          if (Array.isArray(parsed?.motivos)) {
            for (const m of parsed.motivos) {
              const row = sample[Number(m?.n) - 1];
              if (row && valid.has(m?.motivo)) row.reason = m.motivo;
            }
            reasons = (Object.keys(LOSS_LABELS) as LossReason[]).map((reason) => ({ reason, label: LOSS_LABELS[reason], count: lostRows.filter((r) => r.reason === reason).length }));
          }
          const recs = Array.isArray(parsed?.recomendaciones) ? parsed.recomendaciones.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 280)).slice(0, 3) : [];
          if (recs.length) recommendations = recs;
          source = 'IA';
        }
      } catch (err: any) {
        this.logger.warn(`${company.name}: sin IA para el auditor (${err.message}); informe con reglas`);
      }
    }

    const examples = (Object.keys(LOSS_LABELS) as LossReason[]).flatMap((reason) =>
      lostRows.filter((r) => r.reason === reason).slice(0, 2).map((r) => ({ reason, label: LOSS_LABELS[reason], contact: r.contact, conversationId: r.id, snippet: r.snippet })));
    const audit = await this.prisma.salesAudit.create({
      data: {
        companyId: company.id, periodStart: from, periodEnd: now, statsJson: JSON.stringify(stats),
        reasonsJson: JSON.stringify(reasons.filter((r) => r.count > 0).sort((a, b) => b.count - a.count)),
        recommendationsJson: JSON.stringify(recommendations), examplesJson: JSON.stringify(examples), source, model, tokens,
      },
    });
    if (opts.send !== false) await this.email(company, audit).catch((err: any) => this.logger.warn(`correo del auditor: ${err.message}`));
    return this.serialize(audit);
  }

  serialize(a: any) {
    const parse = (v: string, f: any) => {
      try {
        return JSON.parse(v);
      } catch {
        return f;
      }
    };
    return {
      id: a.id, periodStart: a.periodStart, periodEnd: a.periodEnd, stats: parse(a.statsJson, {}), reasons: parse(a.reasonsJson, []),
      recommendations: parse(a.recommendationsJson, []), examples: parse(a.examplesJson, []), source: a.source, tokens: a.tokens, createdAt: a.createdAt,
    };
  }

  private async email(company: any, audit: any) {
    const cfg = salesAuditConfig(company);
    const admins = cfg.email ? [cfg.email] : (await this.prisma.user.findMany({ where: { companyId: company.id, role: 'COMPANY_ADMIN', active: true }, select: { email: true } })).map((u: any) => u.email);
    const a = this.serialize(audit);
    const body = `<p>Así le fue a <b>${company.name}</b> esta semana:</p>
      <p><b>${a.stats.conversations}</b> conversaciones · <b>${a.stats.sales}</b> ventas (${a.stats.conversion}%)${a.stats.avgFirstReplyMin != null ? ` · primera respuesta en ${a.stats.avgFirstReplyMin} min` : ''}</p>
      ${a.reasons.length ? `<p><b>Por qué se perdieron ventas:</b></p><ul>${a.reasons.map((r: any) => `<li>${r.label}: ${r.count}</li>`).join('')}</ul>` : ''}
      ${a.recommendations.length ? `<p><b>Qué te recomendamos:</b></p><ol>${a.recommendations.map((r: string) => `<li>${r}</li>`).join('')}</ol>` : ''}
      <p>Mira el detalle en tu panel → Auditor de ventas.</p>`;
    for (const toEmail of admins.slice(0, 5)) {
      await this.emails.systemSend({ toEmail, subject: `Auditor de ventas · ${company.name}: ${a.stats.sales} ventas de ${a.stats.conversations} conversaciones`, body });
    }
  }

  async list(companyId: string) {
    const rows = await this.prisma.salesAudit.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take: 12 });
    return rows.map((r: any) => this.serialize(r));
  }

  /** Lunes 7:00 (Bogotá): informe de la semana para cada empresa con el complemento. */
  @Cron('0 7 * * 1', { timeZone: 'America/Bogota' })
  async weekly() {
    const companies = await this.prisma.company.findMany({ where: { status: 'ACTIVE', addonsJson: { contains: 'salesAudit' } } }).catch(() => []);
    for (const company of companies as any[]) {
      if (!addonEnabled(company, 'salesAudit')) continue;
      try {
        await this.generate(company);
      } catch (err: any) {
        this.logger.error(`${company.name}: ${err.message}`);
      }
    }
  }
}
