import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  Optional,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { buildDailyReportPdf } from '../common/pdf';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  NOT_DELETED,
  ROLES,
  isPlatformRole,
  parseJson,
} from '../common/constants';
import { AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';
import { EventsService } from './events.module';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';

/* ═══ Herramientas predefinidas de la consulta en lenguaje natural ═══
 * El modelo SOLO elige herramienta + parámetros de esta lista. El texto del
 * usuario JAMÁS llega a la base de datos: cada herramienta es una consulta
 * Prisma fija, siempre limitada a la organización autenticada. */

const ASK_TOOLS: Array<{ name: string; description: string; params: string }> = [
  { name: 'pedidos_por_fecha', description: 'Pedidos con entrega en un rango de fechas, opcionalmente filtrados por estado', params: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","status":"opcional: borrador|confirmado|programado|en_produccion|listo|empacado|despachado|entregado|cancelado|requiere_atencion"}' },
  { name: 'pedidos_sin_confirmar', description: 'Pedidos que siguen en borrador o requieren atención (sin confirmar todavía)', params: '{}' },
  { name: 'pedidos_escalados', description: 'Pedidos escalados a una persona en un rango, con su motivo', params: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' },
  { name: 'top_clientes', description: 'Clientes que más pidieron en un rango (por número de pedidos y unidades)', params: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","limit":5}' },
  { name: 'top_productos', description: 'Productos más pedidos en un rango', params: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD","limit":5}' },
  { name: 'comparar_periodos', description: 'Comparativo de las últimas semanas o meses: volumen, cumplimiento de entregas y precisión de la IA', params: '{"granularity":"week|month"}' },
  { name: 'resumen_dia', description: 'Resumen operativo completo de un día (pedidos, conversaciones, alertas, precisión)', params: '{"date":"YYYY-MM-DD"}' },
  { name: 'feedback_resumen', description: 'Calificaciones y comentarios de clientes en un rango (promedio, distribución, negativos)', params: '{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}' },
];

const VALID_STATUSES = [
  'borrador', 'confirmado', 'programado', 'en_produccion', 'listo',
  'empacado', 'despachado', 'entregado', 'cancelado', 'requiere_atencion',
];

function safeDate(value: any, fallback: Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function dayRange(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00`);
  return { start, end: new Date(start.getTime() + 86400e3) };
}

/** Fecha de HOY en hora local del servidor (no UTC — a la noche difieren). */
export function localToday(): string {
  return new Intl.DateTimeFormat('en-CA').format(new Date());
}

function pct(part: number, total: number): number | null {
  if (!total) return null;
  return Math.round((part / total) * 1000) / 10;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger('Reports');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
    @Optional() private readonly events?: EventsService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!scoped) throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  /* ═══ 1. Reporte diario ═══ */

  /** Arma el reporte operativo de un día (YYYY-MM-DD). Todo calculado en vivo. */
  async buildDaily(companyId: string, date: string) {
    const { start, end } = dayRange(date);
    const now = new Date();
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const threshold = Number(cfg.aiConfidenceThreshold ?? 0.8);
    const monthStart = new Date(start.getFullYear(), start.getMonth(), 1);

    const [
      recibidos,
      transiciones,
      inMessages,
      agentMessages,
      escaladasAudit,
      dudasPedidos,
      escalamientosDia,
      borradoresViejos,
      proximas,
      recordatoriosFallidos,
      sinRespuesta,
      iaDia,
      iaMes,
      feedbackDia,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { companyId, ...NOT_DELETED, createdAt: { gte: start, lt: end } },
      }),
      this.prisma.orderStatusHistory.findMany({
        where: { companyId, createdAt: { gte: start, lt: end } },
        select: { orderId: true, toStatus: true },
      }),
      this.prisma.message.findMany({
        where: { conversation: { companyId }, direction: 'IN', createdAt: { gte: start, lt: end } },
        select: { conversationId: true },
      }),
      this.prisma.message.findMany({
        where: { conversation: { companyId }, author: 'AGENT', createdAt: { gte: start, lt: end } },
        select: { conversationId: true },
      }),
      this.prisma.auditLog.count({
        where: { companyId, action: 'engine.escalate', createdAt: { gte: start, lt: end } },
      }),
      this.prisma.order.findMany({
        where: {
          companyId, ...NOT_DELETED,
          createdAt: { gte: start, lt: end },
          aiConfidence: { not: null, lt: threshold },
        },
        select: {
          id: true, status: true, aiConfidence: true, deliveryAt: true,
          customer: { select: { name: true } },
        },
        take: 20,
      }),
      this.prisma.orderStatusHistory.findMany({
        where: { companyId, toStatus: 'requiere_atencion', createdAt: { gte: start, lt: end } },
        select: {
          orderId: true, reason: true, authorType: true,
          order: { select: { customer: { select: { name: true } } } },
        },
        take: 20,
      }),
      this.prisma.order.findMany({
        where: {
          companyId, ...NOT_DELETED, status: 'borrador',
          createdAt: { lt: new Date(now.getTime() - 12 * 3600e3) },
        },
        select: { id: true, createdAt: true, deliveryAt: true, customer: { select: { name: true } } },
        take: 10,
      }),
      this.prisma.order.findMany({
        where: {
          companyId, ...NOT_DELETED,
          status: { in: ['confirmado', 'programado', 'en_produccion'] },
          deliveryAt: { gte: now, lte: new Date(now.getTime() + 48 * 3600e3) },
        },
        select: {
          id: true, deliveryAt: true,
          customer: { select: { name: true } },
          items: { select: { productionAreaId: true, productName: true } },
        },
      }),
      this.prisma.reminder.findMany({
        where: {
          companyId, status: 'FALLIDO',
          updatedAt: { gte: new Date(now.getTime() - 7 * 86400e3) },
        },
        select: { id: true, kind: true, lastError: true, orderId: true },
        take: 10,
      }),
      this.prisma.conversation.count({
        where: {
          companyId,
          unreadCount: { gt: 0 },
          lastMessageAt: { lt: new Date(now.getTime() - 2 * 3600e3) },
        },
      }),
      this.prisma.order.findMany({
        where: { companyId, ...NOT_DELETED, takenByType: 'IA', createdAt: { gte: start, lt: end } },
        select: { correctedAfterAi: true },
      }),
      this.prisma.order.findMany({
        where: { companyId, ...NOT_DELETED, takenByType: 'IA', createdAt: { gte: monthStart, lt: end } },
        select: { correctedAfterAi: true },
      }),
      this.prisma.feedback.findMany({
        where: { companyId, respondedAt: { gte: start, lt: end } },
        select: { rating: true, sentiment: true, comment: true, customer: { select: { name: true } } },
      }),
    ]);

    const byStatus = (status: string) =>
      new Set(transiciones.filter((t) => t.toStatus === status).map((t) => t.orderId)).size;
    const atendidas = new Set(inMessages.map((m) => m.conversationId)).size;
    const conHumano = new Set(agentMessages.map((m) => m.conversationId)).size;
    const proximasSinArea = proximas
      .filter((o) => o.items.some((i) => !i.productionAreaId))
      .map((o) => ({
        id: o.id, deliveryAt: o.deliveryAt, customer: o.customer.name,
        itemsSinArea: o.items.filter((i) => !i.productionAreaId).map((i) => i.productName),
      }));

    // Indicador de precisión REAL: pedidos IA sin corrección posterior / total IA
    const precision = (rows: Array<{ correctedAfterAi: boolean }>) => ({
      total: rows.length,
      corregidos: rows.filter((r) => r.correctedAfterAi).length,
      precisionPct: pct(rows.filter((r) => !r.correctedAfterAi).length, rows.length),
    });

    const ratings = feedbackDia.filter((f) => f.rating != null).map((f) => f.rating!) as number[];

    return {
      date,
      companyId,
      generatedAt: now.toISOString(),
      pedidos: {
        recibidos,
        confirmados: byStatus('confirmado'),
        programados: byStatus('programado'),
        despachados: byStatus('despachado'),
        entregados: byStatus('entregado'),
        cancelados: byStatus('cancelado'),
      },
      conversaciones: {
        atendidas,
        escaladas: escaladasAudit,
        conIntervencionHumana: conHumano,
        resueltasPorIA: Math.max(atendidas - escaladasAudit - conHumano, 0),
      },
      dudas: {
        pedidosBajaConfianza: dudasPedidos.map((o) => ({
          id: o.id, customer: o.customer.name, status: o.status,
          aiConfidence: o.aiConfidence, deliveryAt: o.deliveryAt,
        })),
        escalamientos: escalamientosDia.map((h) => ({
          orderId: h.orderId, customer: h.order?.customer?.name ?? '—',
          reason: h.reason, authorType: h.authorType,
        })),
      },
      alertas: {
        pedidosSinConfirmar: borradoresViejos.map((o) => ({
          id: o.id, customer: o.customer.name, createdAt: o.createdAt, deliveryAt: o.deliveryAt,
        })),
        entregasProximasSinArea: proximasSinArea,
        recordatoriosFallidos,
        conversacionesSinRespuesta: sinRespuesta,
      },
      precisionIA: {
        dia: precision(iaDia),
        mes: precision(iaMes),
      },
      feedback: {
        respuestas: feedbackDia.length,
        promedio: ratings.length
          ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
          : null,
        negativos: feedbackDia
          .filter((f) => f.sentiment === 'NEGATIVO')
          .map((f) => ({ customer: f.customer?.name ?? '—', rating: f.rating, comment: f.comment })),
      },
    };
  }

  /** Genera, guarda y envía el reporte de un día por el canal configurado. */
  async runDaily(companyId: string, date: string, actor: AuthUser | null) {
    const data = await this.buildDaily(companyId, date);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const reportCfg = cfg.dailyReport ?? {};
    const channel = reportCfg.channel === 'EMAIL' ? 'EMAIL' : 'PANEL';

    const report = await this.prisma.dailyReport.upsert({
      where: { companyId_date: { companyId, date } },
      create: { companyId, date, dataJson: JSON.stringify(data), channel },
      update: { dataJson: JSON.stringify(data), channel },
    });

    let sent = false;
    if (channel === 'EMAIL' && reportCfg.email) {
      const p = data.pedidos;
      const c = data.conversaciones;
      const prec = data.precisionIA.mes.precisionPct;
      await this.emails.systemSend({
        companyId,
        toEmail: reportCfg.email,
        subject: `Reporte diario ${company.name} — ${date}`,
        body: `
          <h2>Reporte del ${date}</h2>
          <p><strong>Pedidos:</strong> ${p.recibidos} recibidos · ${p.confirmados} confirmados · ${p.programados} programados · ${p.despachados} despachados · ${p.entregados} entregados</p>
          <p><strong>Conversaciones:</strong> ${c.atendidas} atendidas · ${c.resueltasPorIA} resueltas por la IA · ${c.escaladas} escaladas · ${c.conIntervencionHumana} con intervención humana</p>
          <p><strong>Precisión de la IA (mes):</strong> ${prec != null ? `${prec}%` : 'sin datos'}</p>
          <p><strong>Alertas:</strong> ${data.alertas.pedidosSinConfirmar.length} sin confirmar · ${data.alertas.entregasProximasSinArea.length} entregas sin área · ${data.alertas.recordatoriosFallidos.length} recordatorios fallidos · ${data.alertas.conversacionesSinRespuesta} clientes sin respuesta</p>
          <p>El detalle completo está en el panel → Pedidos → Reportes.</p>`,
      });
      sent = true;
    }
    await this.prisma.dailyReport.update({
      where: { id: report.id },
      data: { sentAt: new Date() },
    });
    await this.audit.log({
      actor, companyId, action: 'report.daily',
      entity: 'DailyReport', entityId: report.id,
      detail: `${date} · canal ${channel}${sent ? ' (enviado)' : ''}`,
    });
    this.events?.emit(companyId, { type: 'report.daily', date });
    return { reportId: report.id, channel, sent, data };
  }

  /** Job: cada hora revisa qué organizaciones tienen el envío configurado
   *  para esa hora (en SU zona horaria) y genera el reporte del día anterior. */
  @Cron('5 * * * *')
  async cronDaily() {
    if (process.env.JEST_WORKER_ID) return;
    const companies = await this.prisma.company.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, timezone: true, modulesJson: true, orderConfigJson: true },
    });
    for (const company of companies) {
      const modules = parseJson<string[]>(company.modulesJson, []);
      if (!modules.includes('orders')) continue;
      const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
      const hour = Number(cfg.dailyReport?.hour ?? NaN);
      if (Number.isNaN(hour)) continue; // sin reporte configurado

      const tz = company.timezone || 'America/Bogota';
      const localHour = Number(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
          .format(new Date()),
      );
      if (localHour !== hour) continue;

      const yesterday = new Date(Date.now() - 86400e3);
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(yesterday);
      const existing = await this.prisma.dailyReport.findUnique({
        where: { companyId_date: { companyId: company.id, date } },
      });
      if (existing?.sentAt) continue; // idempotente: ya se generó y envió

      await this.runDaily(company.id, date, null).catch((err) =>
        this.logger.error(`reporte diario ${company.id}: ${err.message}`),
      );
    }
  }

  async history(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const rows = await this.prisma.dailyReport.findMany({
      where: { companyId: scoped },
      orderBy: { date: 'desc' },
      take: 60,
    });
    return rows.map((r) => ({
      id: r.id, date: r.date, channel: r.channel, sentAt: r.sentAt,
      data: parseJson<any>(r.dataJson, {}),
    }));
  }

  /* ═══ 2. Comparativo semanal y mensual ═══ */

  async compare(companyId: string, granularity: 'week' | 'month', periods = 8) {
    const now = new Date();
    const buckets: Array<{ label: string; start: Date; end: Date }> = [];
    for (let i = periods - 1; i >= 0; i--) {
      if (granularity === 'week') {
        // Semanas lunes–domingo
        const monday = new Date(now);
        monday.setHours(0, 0, 0, 0);
        monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - i * 7);
        const end = new Date(monday.getTime() + 7 * 86400e3);
        buckets.push({
          label: `Sem ${new Intl.DateTimeFormat('es-CO', { day: '2-digit', month: 'short' }).format(monday)}`,
          start: monday, end,
        });
      } else {
        const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
        buckets.push({
          label: new Intl.DateTimeFormat('es-CO', { month: 'short', year: '2-digit' }).format(start),
          start, end,
        });
      }
    }

    const since = buckets[0].start;
    const orders = await this.prisma.order.findMany({
      where: { companyId, ...NOT_DELETED, deliveryAt: { gte: since } },
      select: {
        status: true, deliveryAt: true, takenByType: true, correctedAfterAi: true,
      },
    });

    const rows = buckets.map((b) => {
      const inBucket = orders.filter((o) => o.deliveryAt >= b.start && o.deliveryAt < b.end);
      const pasados = inBucket.filter((o) => o.deliveryAt < now);
      const entregados = inBucket.filter((o) => o.status === 'entregado').length;
      const cancelados = inBucket.filter((o) => o.status === 'cancelado').length;
      const ia = inBucket.filter((o) => o.takenByType === 'IA');
      return {
        label: b.label,
        from: b.start.toISOString().slice(0, 10),
        pedidos: inBucket.length,
        entregados,
        cancelados,
        // Cumplimiento: de las entregas cuya fecha ya pasó, cuántas llegaron a "entregado"
        cumplimientoPct: pct(entregados, pasados.length),
        tomadosIA: ia.length,
        precisionIAPct: pct(ia.filter((o) => !o.correctedAfterAi).length, ia.length),
      };
    });
    return { granularity, buckets: rows, generatedAt: now.toISOString() };
  }

  /* ═══ Feedback / testimonios ═══ */

  async feedbackSummary(companyId: string, from?: string, to?: string) {
    const start = safeDate(from, new Date(Date.now() - 90 * 86400e3));
    const end = new Date(safeDate(to, new Date()).getTime() + 86400e3);
    const rows = await this.prisma.feedback.findMany({
      where: { companyId, requestedAt: { gte: start, lt: end } },
      orderBy: { requestedAt: 'desc' },
      include: {
        customer: { select: { name: true } },
        order: { select: { id: true, deliveryAt: true } },
      },
      take: 200,
    });
    const answered = rows.filter((r) => r.status === 'RESPONDIDO');
    const ratings = answered.filter((r) => r.rating != null).map((r) => r.rating!) as number[];
    const distribution = [1, 2, 3, 4, 5].map((star) => ({
      star, count: ratings.filter((r) => r === star).length,
    }));
    return {
      solicitados: rows.length,
      respondidos: answered.length,
      tasaRespuestaPct: pct(answered.length, rows.length),
      promedio: ratings.length
        ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
        : null,
      distribution,
      negativos: answered.filter((r) => r.sentiment === 'NEGATIVO').length,
      // Testimonios para uso comercial: positivos con comentario
      testimonios: answered
        .filter((r) => r.sentiment === 'POSITIVO' && r.comment)
        .slice(0, 20)
        .map((r) => ({
          customer: r.customer?.name ?? 'Cliente', rating: r.rating,
          comment: r.comment, orderId: r.orderId, respondedAt: r.respondedAt,
        })),
      recientes: answered.slice(0, 30).map((r) => ({
        customer: r.customer?.name ?? 'Cliente', rating: r.rating,
        sentiment: r.sentiment, comment: r.comment,
        orderId: r.orderId, respondedAt: r.respondedAt, alerted: r.alerted,
      })),
    };
  }

  /* ═══ Observabilidad: salud operativa (alertas activas) ═══ */

  /**
   * Alertas operativas en vivo: recordatorios fallidos, mensajes no
   * entregados, escalamientos por encima de lo normal y feedback negativo.
   * Plataforma sin companyId = TODAS las empresas (monitoreo global).
   */
  async opsHealth(companyId?: string) {
    const now = new Date();
    const day = new Date(now.getTime() - 24 * 3600e3);
    const week = new Date(now.getTime() - 7 * 86400e3);
    const co = companyId ? { companyId } : {};

    const [failedReminders, failedMessages, escalations24h, escalations7d, negativeFeedback, attention] =
      await Promise.all([
        this.prisma.reminder.findMany({
          where: { ...co, status: 'FALLIDO', updatedAt: { gte: week } },
          select: { id: true, companyId: true, kind: true, lastError: true, orderId: true, updatedAt: true },
          take: 50,
        }),
        this.prisma.message.findMany({
          where: {
            deliveryStatus: 'FAILED',
            createdAt: { gte: week },
            ...(companyId ? { conversation: { companyId } } : {}),
          },
          select: { id: true, conversationId: true, content: true, createdAt: true },
          take: 50,
        }),
        this.prisma.auditLog.count({
          where: { ...co, action: 'engine.escalate', createdAt: { gte: day } },
        }),
        this.prisma.auditLog.count({
          where: { ...co, action: 'engine.escalate', createdAt: { gte: week } },
        }),
        this.prisma.feedback.count({
          where: { ...co, sentiment: 'NEGATIVO', respondedAt: { gte: week } },
        }),
        this.prisma.conversation.count({ where: { ...co, needsAttention: true } }),
      ]);

    // "Por encima de lo normal": el día actual supera 2× el promedio diario
    const dailyAvg = escalations7d / 7;
    const escalationSpike = escalations24h > Math.max(dailyAvg * 2, 3);

    const companies = companyId
      ? []
      : await this.prisma.company.findMany({ select: { id: true, name: true } });
    const companyName = (id: string) => companies.find((c) => c.id === id)?.name ?? id;

    return {
      generatedAt: now.toISOString(),
      ok:
        failedReminders.length === 0 &&
        failedMessages.length === 0 &&
        !escalationSpike,
      recordatoriosFallidos: failedReminders.map((r) => ({
        ...r, company: companyId ? undefined : companyName(r.companyId),
      })),
      mensajesNoEntregados: failedMessages.map((m) => ({
        id: m.id, conversationId: m.conversationId,
        preview: (m.content ?? '').slice(0, 60), createdAt: m.createdAt,
      })),
      escalamientos: { ultimas24h: escalations24h, promedioDiario7d: Math.round(dailyAvg * 10) / 10, anormal: escalationSpike },
      feedbackNegativo7d: negativeFeedback,
      conversacionesConAlerta: attention,
    };
  }

  /* ═══ 3. Consulta en lenguaje natural (tools predefinidas) ═══ */

  private async runTool(companyId: string, tool: string, params: Record<string, any>) {
    const now = new Date();
    const from = safeDate(params.from, new Date(now.getTime() - 7 * 86400e3));
    const toEnd = new Date(safeDate(params.to, now).getTime() + 86400e3);
    const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);

    switch (tool) {
      case 'pedidos_por_fecha': {
        const status = VALID_STATUSES.includes(params.status) ? params.status : undefined;
        const orders = await this.prisma.order.findMany({
          where: {
            companyId, ...NOT_DELETED,
            deliveryAt: { gte: from, lt: toEnd },
            ...(status ? { status } : {}),
          },
          orderBy: { deliveryAt: 'asc' },
          include: {
            customer: { select: { name: true } },
            items: { select: { productName: true, quantity: true } },
          },
          take: 100,
        });
        const byStatus: Record<string, number> = {};
        for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
        return {
          total: orders.length,
          porEstado: byStatus,
          pedidos: orders.slice(0, 20).map((o) => ({
            id: o.id, cliente: o.customer.name, entrega: o.deliveryAt, estado: o.status,
            items: o.items.map((i) => `${i.quantity} × ${i.productName}`).join(', '),
          })),
        };
      }
      case 'pedidos_sin_confirmar': {
        const orders = await this.prisma.order.findMany({
          where: { companyId, ...NOT_DELETED, status: { in: ['borrador', 'requiere_atencion'] } },
          orderBy: { createdAt: 'asc' },
          include: { customer: { select: { name: true } } },
          take: 50,
        });
        return {
          total: orders.length,
          pedidos: orders.map((o) => ({
            id: o.id, cliente: o.customer.name, estado: o.status,
            creado: o.createdAt, entrega: o.deliveryAt,
          })),
        };
      }
      case 'pedidos_escalados': {
        const rows = await this.prisma.orderStatusHistory.findMany({
          where: { companyId, toStatus: 'requiere_atencion', createdAt: { gte: from, lt: toEnd } },
          orderBy: { createdAt: 'desc' },
          include: { order: { select: { customer: { select: { name: true } }, status: true } } },
          take: 50,
        });
        return {
          total: rows.length,
          escalados: rows.map((h) => ({
            orderId: h.orderId, cliente: h.order?.customer?.name ?? '—',
            motivo: h.reason ?? 'sin motivo registrado',
            por: h.authorType, cuando: h.createdAt, estadoActual: h.order?.status,
          })),
        };
      }
      case 'top_clientes': {
        const orders = await this.prisma.order.findMany({
          where: { companyId, ...NOT_DELETED, deliveryAt: { gte: from, lt: toEnd } },
          include: {
            customer: { select: { name: true } },
            items: { select: { quantity: true } },
          },
        });
        const byCustomer = new Map<string, { cliente: string; pedidos: number; unidades: number }>();
        for (const o of orders) {
          const row = byCustomer.get(o.customerId) ?? { cliente: o.customer.name, pedidos: 0, unidades: 0 };
          row.pedidos += 1;
          row.unidades += o.items.reduce((a, i) => a + i.quantity, 0);
          byCustomer.set(o.customerId, row);
        }
        return {
          top: [...byCustomer.values()].sort((a, b) => b.pedidos - a.pedidos).slice(0, limit),
        };
      }
      case 'top_productos': {
        const items = await this.prisma.orderItem.findMany({
          where: { companyId, order: { ...NOT_DELETED, deliveryAt: { gte: from, lt: toEnd } } },
          select: { productName: true, quantity: true },
        });
        const byProduct = new Map<string, { producto: string; unidades: number; lineas: number }>();
        for (const i of items) {
          const row = byProduct.get(i.productName) ?? { producto: i.productName, unidades: 0, lineas: 0 };
          row.unidades += i.quantity;
          row.lineas += 1;
          byProduct.set(i.productName, row);
        }
        return {
          top: [...byProduct.values()].sort((a, b) => b.unidades - a.unidades).slice(0, limit),
        };
      }
      case 'comparar_periodos':
        return this.compare(companyId, params.granularity === 'month' ? 'month' : 'week');
      case 'resumen_dia': {
        const date = typeof params.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.date)
          ? params.date
          : localToday();
        return this.buildDaily(companyId, date);
      }
      case 'feedback_resumen':
        return this.feedbackSummary(companyId, params.from, params.to);
      default:
        throw new BadRequestException(`Herramienta desconocida: ${tool}`);
    }
  }

  private async recordUsage(companyId: string, model: string, inputTokens: number, outputTokens: number) {
    const entry = await this.prisma.aiModel.findUnique({ where: { modelId: model } });
    const costUsd = entry
      ? (inputTokens * entry.inputCostPerMTok + outputTokens * entry.outputCostPerMTok) / 1_000_000
      : 0;
    await this.prisma.aiUsageEvent.create({
      data: {
        companyId, model, inputTokens, outputTokens,
        costUsd: Math.round(costUsd * 1e6) / 1e6,
      },
    });
  }

  /**
   * Consulta en lenguaje natural. El modelo SOLO elige una herramienta de la
   * lista con sus parámetros (JSON); la ejecución es Prisma fijo tenant-scoped
   * y la respuesta final SIEMPRE viene acompañada de los datos que la respaldan.
   */
  async ask(user: AuthUser, companyId: string | undefined, question: string) {
    const scoped = this.resolveCompany(user, companyId);
    const q = (question ?? '').trim().slice(0, 500);
    if (!q) throw new BadRequestException('Escribe una pregunta');
    if (!this.ai) throw new BadRequestException('Motor de IA no disponible');

    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    if (!company.deepinfraApiKey) {
      throw new BadRequestException(
        'La organización no tiene llave de DeepInfra configurada (Configuración → Llave DeepInfra)',
      );
    }
    const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
    const model = cfg.askModel ?? 'meta-llama/Llama-3.3-70B-Instruct';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: company.timezone || 'America/Bogota' })
      .format(new Date());

    // Paso 1: el modelo elige herramienta + parámetros (nada más)
    const toolCatalog = ASK_TOOLS
      .map((t) => `- ${t.name}: ${t.description}. Parámetros: ${t.params}`)
      .join('\n');
    const selection = await this.ai.chat({
      apiKey: company.deepinfraApiKey,
      model,
      temperature: 0,
      maxTokens: 300,
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content: `Eres el analista de datos de ${company.name} (módulo de pedidos). Hoy es ${today} (zona ${company.timezone}).
Tu ÚNICA salida es un JSON {"tool": "<nombre>", "params": {…}} eligiendo UNA herramienta:
${toolCatalog}
Reglas: fechas siempre YYYY-MM-DD; si la pregunta menciona "el viernes", "mañana", "la semana pasada", resuélvelo a fechas concretas a partir de hoy. Si ninguna herramienta aplica, responde {"tool": "ninguna", "params": {}}.`,
        },
        { role: 'user', content: q },
      ],
    });
    await this.recordUsage(scoped, selection.model, selection.inputTokens, selection.outputTokens);

    const parsed = extractJson(selection.content) as { tool?: string; params?: any } | null;
    const tool = parsed?.tool ?? 'ninguna';
    if (tool === 'ninguna' || !ASK_TOOLS.some((t) => t.name === tool)) {
      return {
        question: q,
        tool: null,
        data: null,
        answer:
          'No tengo una consulta preparada para eso. Puedo responder sobre pedidos por fecha, pendientes de confirmar, escalamientos, top de clientes y productos, comparativos, el resumen de un día y el feedback de clientes.',
      };
    }
    const params = parsed?.params && typeof parsed.params === 'object' ? parsed.params : {};
    const data = await this.runTool(scoped, tool, params);

    // Paso 2: redacción de la respuesta citando los datos (que también se devuelven)
    const answerRes = await this.ai.chat({
      apiKey: company.deepinfraApiKey,
      model,
      temperature: 0.2,
      maxTokens: 400,
      messages: [
        {
          role: 'system',
          content:
            'Responde en español, breve y directo, citando las cifras de los datos. No inventes nada que no esté en los datos. Sin markdown pesado: máximo 4 frases o una lista corta.',
        },
        {
          role: 'user',
          content: `Pregunta: ${q}\n\nDatos (JSON de la herramienta ${tool}): ${JSON.stringify(data).slice(0, 6000)}`,
        },
      ],
    });
    await this.recordUsage(scoped, answerRes.model, answerRes.inputTokens, answerRes.outputTokens);

    await this.audit.log({
      actor: user, companyId: scoped, action: 'report.ask',
      entity: 'Company', entityId: scoped, detail: `${tool}: ${q.slice(0, 120)}`,
    });
    return { question: q, tool, params, data, answer: answerRes.content.trim() };
  }
}

/* ═══ Controlador ═══ */

const READ_ROLES = [
  ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER,
] as const;
const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly prisma: PrismaService,
  ) {}

  private scoped(user: AuthUser, companyId?: string): string {
    const scoped = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!scoped) throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  @Get('daily')
  @Roles(...READ_ROLES)
  daily(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('date') date?: string,
  ) {
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : localToday();
    return this.reports.buildDaily(this.scoped(user, companyId), day);
  }

  @Post('daily/run')
  @Roles(...WRITE_ROLES)
  runDaily(
    @CurrentUser() user: AuthUser,
    @Body() dto: { companyId?: string; date?: string },
  ) {
    const day = dto.date && /^\d{4}-\d{2}-\d{2}$/.test(dto.date)
      ? dto.date
      : localToday();
    return this.reports.runDaily(this.scoped(user, dto.companyId), day, user);
  }

  /** Reporte diario en PDF con la identidad de la marca. */
  @Get('daily/pdf')
  @Roles(...READ_ROLES)
  async dailyPdf(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('companyId') companyId?: string,
    @Query('date') date?: string,
  ) {
    const scoped = this.scoped(user, companyId);
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : localToday();
    const [data, company] = await Promise.all([
      this.reports.buildDaily(scoped, day),
      this.prisma.company.findUniqueOrThrow({ where: { id: scoped } }),
    ]);
    const buffer = await buildDailyReportPdf(company, data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="reporte-${day}.pdf"`);
    res.send(buffer);
  }

  @Get('history')
  @Roles(...READ_ROLES)
  history(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.reports.history(user, companyId);
  }

  @Get('compare')
  @Roles(...READ_ROLES)
  compare(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('granularity') granularity?: string,
  ) {
    return this.reports.compare(
      this.scoped(user, companyId),
      granularity === 'month' ? 'month' : 'week',
    );
  }

  @Get('feedback')
  @Roles(...READ_ROLES)
  feedback(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.feedbackSummary(this.scoped(user, companyId), from, to);
  }

  @Get('ops-health')
  @Roles(...READ_ROLES)
  opsHealth(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    // Plataforma sin companyId = monitoreo global; empresa = SIEMPRE la suya
    if (isPlatformRole(user.role)) return this.reports.opsHealth(companyId || undefined);
    return this.reports.opsHealth(user.companyId!);
  }

  @Post('ask')
  @Roles(...READ_ROLES)
  ask(
    @CurrentUser() user: AuthUser,
    @Body() dto: { companyId?: string; question: string },
  ) {
    return this.reports.ask(user, dto.companyId, dto.question);
  }
}

@Module({
  imports: [EmailsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
