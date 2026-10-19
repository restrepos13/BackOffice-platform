/**
 * Seguimiento de cada intento de registro (embudo + seguimiento comercial).
 *  - El navegador manda un token propio en cada paso: así se sabe hasta dónde
 *    llega cada persona aunque no termine.
 *  - Los datos de contacto se guardan apenas los escribe bien (lo avisa el
 *    formulario), para poder ayudarle si se queda a mitad.
 *  - El equipo marca el seguimiento: contactado, reunión, demo, ganado, perdido.
 */
import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../common/constants';

export const SIGNUP_STEPS = ['STARTED', 'INTERVIEW', 'PREVIEW', 'ACCOUNT', 'DONE'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
export const FOLLOW_STATUSES = ['NEW', 'CONTACTED', 'MEETING', 'DEMO_DONE', 'WON', 'LOST'] as const;

/** Sin actividad por este tiempo y sin terminar = abandonó. */
export const ABANDON_AFTER_MS = 30 * 60e3;

export const STEP_LABELS: Record<SignupStep, string> = {
  STARTED: 'Abrió el registro',
  INTERVIEW: 'Respondiendo preguntas',
  PREVIEW: 'Revisando su plan',
  ACCOUNT: 'Llenando sus datos',
  DONE: 'Creó su empresa',
};

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function isSessionToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN.test(v);
}

export class SignupTracker {
  constructor(private readonly prisma: any) {}

  private async get(token: string) {
    return this.prisma.signupSession.findUnique({ where: { token } });
  }

  /**
   * Registra actividad. El paso solo avanza (volver atrás no "des-avanza"), las
   * respuestas guardan el máximo y la IA suma.
   */
  async touch(
    token: unknown,
    patch: {
      step?: SignupStep; answers?: number; description?: string; businessName?: string; businessType?: string;
      rubro?: string; mode?: string; ai?: { calls: number; tokens: number }; companyId?: string;
      referrer?: string; userAgent?: string;
    } = {},
  ) {
    if (!isSessionToken(token)) return null;
    try {
      const now = new Date();
      const current = await this.get(token);
      const stepIdx = (s?: string) => SIGNUP_STEPS.indexOf((s ?? 'STARTED') as SignupStep);
      const step = patch.step && stepIdx(patch.step) > stepIdx(current?.step) ? patch.step : current?.step ?? patch.step ?? 'STARTED';
      const data: Record<string, any> = {
        step,
        lastSeenAt: now,
        ...(patch.answers !== undefined ? { answers: Math.max(current?.answers ?? 0, patch.answers) } : {}),
        ...(clip(patch.description, 600) && !current?.description ? { description: clip(patch.description, 600) } : {}),
        ...(clip(patch.businessName, 80) ? { businessName: clip(patch.businessName, 80) } : {}),
        ...(clip(patch.businessType, 80) ? { businessType: clip(patch.businessType, 80) } : {}),
        ...(clip(patch.rubro, 20) ? { rubro: clip(patch.rubro, 20) } : {}),
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.companyId ? { companyId: patch.companyId } : {}),
        ...(patch.ai ? { aiCalls: (current?.aiCalls ?? 0) + patch.ai.calls, aiTokens: (current?.aiTokens ?? 0) + patch.ai.tokens } : {}),
      };
      if (current) return await this.prisma.signupSession.update({ where: { id: current.id }, data });
      return await this.prisma.signupSession.create({
        data: { token, ...data, referrer: clip(patch.referrer, 200), userAgent: clip(patch.userAgent, 200) },
      });
    } catch {
      return null; // el seguimiento nunca rompe el registro
    }
  }

  /** Datos de contacto que la persona ya escribió bien (para ayudarle si abandona). */
  async contact(token: unknown, raw: Record<string, unknown>) {
    if (!isSessionToken(token)) return;
    const email = clip(raw?.email, 120)?.toLowerCase();
    const phone = clip(raw?.phone, 25);
    const patch = {
      ...(clip(raw?.name, 80) ? { contactName: clip(raw?.name, 80) } : {}),
      ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? { email } : {}),
      ...(phone && phone.replace(/\D/g, '').length >= 10 ? { phone } : {}),
      ...(clip(raw?.companyName, 80) ? { businessName: clip(raw?.companyName, 80) } : {}),
    };
    if (!Object.keys(patch).length) return;
    await this.touch(token, { step: 'ACCOUNT' });
    const current = await this.get(token);
    if (current) await this.prisma.signupSession.update({ where: { id: current.id }, data: patch }).catch(() => undefined);
  }

  /** Error que vio la persona (se guardan los últimos 10). */
  async error(token: unknown, step: string | undefined, message: string) {
    if (!isSessionToken(token)) return;
    await this.touch(token);
    const current = await this.get(token);
    if (!current) return;
    let list: any[] = [];
    try {
      list = JSON.parse(current.errorsJson ?? '[]');
    } catch {
      list = [];
    }
    list.push({ at: new Date().toISOString(), step: clip(step, 20) ?? current.step, message: clip(message, 200) ?? 'error' });
    await this.prisma.signupSession.update({ where: { id: current.id }, data: { errorsJson: JSON.stringify(list.slice(-10)) } }).catch(() => undefined);
  }

  /* ── Para el equipo ─────────────────────────────────────────────── */

  static view(s: any, now = Date.now()) {
    let errors: any[] = [];
    try {
      errors = JSON.parse(s.errorsJson ?? '[]');
    } catch {
      errors = [];
    }
    const done = s.step === 'DONE';
    const abandoned = !done && now - new Date(s.lastSeenAt).getTime() > ABANDON_AFTER_MS;
    const digits = String(s.phone ?? '').replace(/\D/g, '');
    return {
      id: s.id,
      step: s.step,
      stepLabel: STEP_LABELS[s.step as SignupStep] ?? s.step,
      state: done ? 'DONE' : abandoned ? 'ABANDONED' : 'ACTIVE',
      answers: s.answers,
      description: s.description ?? null,
      businessName: s.businessName ?? null,
      businessType: s.businessType ?? null,
      rubro: s.rubro ?? null,
      contactName: s.contactName ?? null,
      email: s.email ?? null,
      phone: s.phone ?? null,
      whatsapp: digits.length === 10 && digits.startsWith('3') ? `57${digits}` : digits.length >= 11 ? digits : null,
      mode: s.mode ?? null,
      aiCalls: s.aiCalls,
      aiTokens: s.aiTokens,
      errors,
      companyId: s.companyId ?? null,
      referrer: s.referrer ?? null,
      followStatus: s.followStatus,
      meetingAt: s.meetingAt ?? null,
      followNotes: s.followNotes ?? null,
      followBy: s.followBy ?? null,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
    };
  }

  async list(filter: { state?: string; days?: number } = {}) {
    const days = Math.min(90, Math.max(1, Number(filter.days) || 30));
    const since = new Date(Date.now() - days * 86400e3);
    const rows = await this.prisma.signupSession.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { lastSeenAt: 'desc' },
      take: 500,
    });
    const now = Date.now();
    const all = rows.map((r: any) => SignupTracker.view(r, now));
    // Embudo: cuántos llegaron AL MENOS a cada paso
    const reached = (step: SignupStep) => all.filter((r: any) => SIGNUP_STEPS.indexOf(r.step) >= SIGNUP_STEPS.indexOf(step)).length;
    const funnel = SIGNUP_STEPS.map((step) => ({ step, label: STEP_LABELS[step], count: reached(step) }));
    const sessions = filter.state && filter.state !== 'ALL'
      ? all.filter((r: any) => (filter.state === 'TODO' ? r.followStatus === 'NEW' && (r.state === 'DONE' || r.email || r.phone) : r.state === filter.state))
      : all;
    const withAi = all.filter((r: any) => r.aiCalls > 0);
    return {
      days,
      funnel,
      totals: {
        sessions: all.length,
        done: all.filter((r: any) => r.state === 'DONE').length,
        abandoned: all.filter((r: any) => r.state === 'ABANDONED').length,
        active: all.filter((r: any) => r.state === 'ACTIVE').length,
        pendingFollow: all.filter((r: any) => r.followStatus === 'NEW' && (r.state === 'DONE' || r.email || r.phone)).length,
        avgTokens: withAi.length ? Math.round(withAi.reduce((a: number, r: any) => a + r.aiTokens, 0) / withAi.length) : 0,
        guided: all.filter((r: any) => r.mode === 'guided').length,
      },
      sessions: sessions.slice(0, 200),
    };
  }

  /** Para el menú: pendientes de contactar y el último registro terminado. */
  async summary() {
    const since = new Date(Date.now() - 30 * 86400e3);
    const rows = await this.prisma.signupSession.findMany({
      where: { createdAt: { gte: since }, followStatus: 'NEW' },
      orderBy: { lastSeenAt: 'desc' },
      take: 300,
    });
    const now = Date.now();
    const views = rows.map((r: any) => SignupTracker.view(r, now));
    const pending = views.filter((v: any) => v.state === 'DONE' || v.email || v.phone);
    // El último terminado, sin importar su seguimiento (si no, marcarlo daría un falso "nuevo")
    const latest = await this.prisma.signupSession.findFirst({ where: { step: 'DONE' }, orderBy: { createdAt: 'desc' } });
    return {
      pendingFollow: pending.length,
      latestDone: latest ? { id: latest.id, name: latest.businessName ?? 'Sin nombre', at: latest.lastSeenAt } : null,
    };
  }

  async follow(actor: AuthUser, id: string, dto: { followStatus?: string; meetingAt?: string | null; followNotes?: string }) {
    const current = await this.prisma.signupSession.findUnique({ where: { id } });
    if (!current) throw new BadRequestException('Ese registro no existe');
    const data: Record<string, any> = { followBy: actor.name };
    if (dto.followStatus !== undefined) {
      if (!(FOLLOW_STATUSES as readonly string[]).includes(dto.followStatus)) throw new BadRequestException('Estado de seguimiento inválido');
      data.followStatus = dto.followStatus;
    }
    if (dto.meetingAt !== undefined) {
      const at = dto.meetingAt ? new Date(dto.meetingAt) : null;
      if (at && Number.isNaN(at.getTime())) throw new BadRequestException('Fecha de reunión inválida');
      data.meetingAt = at;
      if (at && (data.followStatus ?? current.followStatus) === 'NEW') data.followStatus = 'MEETING';
    }
    if (dto.followNotes !== undefined) data.followNotes = String(dto.followNotes).slice(0, 2000);
    const row = await this.prisma.signupSession.update({ where: { id }, data });
    return SignupTracker.view(row);
  }

  /** Sesiones para avisar: terminaron, o abandonaron dejando cómo contactarlas. */
  async pendingNotifications() {
    const cutoff = new Date(Date.now() - ABANDON_AFTER_MS);
    const rows = await this.prisma.signupSession.findMany({
      where: {
        // En Mongo "null" no encuentra campos ausentes: se piden las dos cosas
        OR: [{ notifiedAt: null }, { notifiedAt: { isSet: false } }],
        lastSeenAt: { lt: cutoff },
        createdAt: { gte: new Date(Date.now() - 3 * 86400e3) },
      },
      take: 50,
    });
    return rows.filter((r: any) => r.step !== 'DONE' && (r.email || r.phone));
  }

  async markNotified(id: string) {
    await this.prisma.signupSession.update({ where: { id }, data: { notifiedAt: new Date() } }).catch(() => undefined);
  }
}
