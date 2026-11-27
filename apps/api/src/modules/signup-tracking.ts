/**
 * Seguimiento de cada intento de registro (embudo + seguimiento comercial).
 *  - El navegador manda un token propio en cada paso: así se sabe hasta dónde
 *    llega cada persona aunque no termine.
 *  - El contacto (negocio + WhatsApp) se pide ANTES de las preguntas: desde ahí
 *    la persona queda en «Por contactar» aunque se vaya.
 *  - Cada pantalla deja un evento (SignupEvent): con eso el panel muestra el
 *    abandono pregunta por pregunta, el tiempo de cada una y la fuente.
 *  - El equipo marca el seguimiento: contactado, reunión, demo, ganado, perdido;
 *    el primer contacto queda con quién y cuándo (tiempo de respuesta).
 */
import { BadRequestException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { AuthUser } from '../common/constants';

export const SIGNUP_STEPS = ['STARTED', 'CONTACT', 'INTERVIEW', 'PREVIEW', 'ACCOUNT', 'DONE'] as const;
export type SignupStep = (typeof SIGNUP_STEPS)[number];
export const FOLLOW_STATUSES = ['NEW', 'CONTACTED', 'MEETING', 'DEMO_DONE', 'WON', 'LOST'] as const;

/** Sin actividad por este tiempo y sin terminar = abandonó. */
export const ABANDON_AFTER_MS = 30 * 60e3;
/** El enlace «retoma tu registro» del correo vence a las 72 horas. */
export const RESUME_TTL_MS = 72 * 3600e3;

export const STEP_LABELS: Record<SignupStep, string> = {
  STARTED: 'Abrió el registro',
  CONTACT: 'Dejó contacto',
  INTERVIEW: 'Respondiendo preguntas',
  PREVIEW: 'Revisando su plan',
  ACCOUNT: 'Llenando sus datos',
  DONE: 'Creó su empresa',
};

/** Las 5 preguntas del registro (el texto vive en la web; aquí, para el panel y los avisos). */
export const SIGNUP_QUESTIONS = [
  { id: 'tipo', label: 'Tipo de negocio' },
  { id: 'oferta', label: 'Qué vende y a qué precio' },
  { id: 'asistente', label: 'Qué quiere que haga el asistente' },
  { id: 'operacion', label: 'Entregas, citas o cierre' },
  { id: 'volumen', label: 'Clientes que escriben al día' },
] as const;
export const QUESTION_COUNT = SIGNUP_QUESTIONS.length;
const QUESTION_IDS: string[] = SIGNUP_QUESTIONS.map((q) => q.id);

/** Antes de las preguntas (lo que pasa en la pantalla de entrada). */
export const PRE_EVENTS = ['registro_abierto', 'presentacion_vista', 'formulario_visto', 'formulario_empezado', 'contacto_enviado', 'contacto_dejado'] as const;
/** Después de las preguntas. */
export const POST_EVENTS = ['adelanto_visto', 'plan_revisado', 'datos_llenados', 'empresa_creada'] as const;
export const EVENT_TYPES = [...PRE_EVENTS, 'pregunta_vista', 'pregunta_respondida', ...POST_EVENTS] as const;
export type SignupEventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<SignupEventType, string> = {
  registro_abierto: 'Cargó la página',
  presentacion_vista: 'Vio la pantalla de entrada',
  formulario_visto: 'Vio el formulario',
  formulario_empezado: 'Empezó a escribir',
  contacto_enviado: 'Tocó «Empezar»',
  contacto_dejado: 'Dejó su contacto',
  pregunta_vista: 'Vio la pregunta',
  pregunta_respondida: 'Respondió la pregunta',
  adelanto_visto: 'Vio el adelanto',
  plan_revisado: 'Vio su propuesta',
  datos_llenados: 'Llegó a sus datos',
  empresa_creada: 'Creó su empresa',
};

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const clip = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

export function isSessionToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN.test(v);
}

const UTM_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const FBCLID = /^[A-Za-z0-9_-]{8,255}$/;
const LANDING = /^\/[^\s<>"']{0,199}$/;
/** ?g=manizales (grupos de Facebook por ciudad) */
export const GROUP = /^[a-z0-9-]{1,40}$/;

/* ── Fuente de tráfico ─────────────────────────────────────────────── */

const OWN_SITE = /(^|\.)backoffice\.store$|^localhost$|^127\.0\.0\.1$|\.vercel\.app$|\.onrender\.com$/i;

function externalHost(referrer: unknown): string | null {
  try {
    const host = new URL(String(referrer ?? '')).hostname.toLowerCase();
    return host && !OWN_SITE.test(host) ? host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

const cap = (s: string) => s.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

/**
 * De dónde vino: grupo por ciudad (?g=), anuncio de Meta (utm de Meta o fbclid),
 * otra campaña con utm, orgánico (llegó desde otro sitio) o directo.
 */
export function sourceOf(s: { g?: string | null; utmSource?: string | null; fbclid?: string | null; referrer?: string | null }): { key: string; label: string } {
  if (s.g) return { key: `GRUPOS:${s.g}`, label: `Grupos · ${cap(s.g)}` };
  const src = String(s.utmSource ?? '').toLowerCase();
  if (/^(grupo|grupos|fb[-_]?grupos|facebook[-_]grupos)$/.test(src)) return { key: 'GRUPOS', label: 'Grupos de Facebook' };
  if (s.fbclid || /^(meta|facebook|fb|instagram|ig)$/.test(src)) return { key: 'META_AD', label: 'Anuncio de Meta' };
  if (src) return { key: `UTM:${src}`, label: `Campaña · ${src}` };
  const host = externalHost(s.referrer);
  if (host) return { key: 'ORGANIC', label: 'Orgánico' };
  return { key: 'DIRECT', label: 'Directo' };
}

function matchesSource(key: string, filter?: string) {
  if (!filter || filter === 'ALL') return true;
  return key === filter || (filter === 'GRUPOS' && key.startsWith('GRUPOS'));
}

/* ── Horario del equipo (para medir la respuesta en horario laboral) ─── */

/** Lunes a viernes 8 a. m.–6 p. m. y sábados 9 a. m.–12 m. (hora de Bogotá). */
export function inBusinessHours(at: Date): boolean {
  const l = new Date(at.getTime() - 5 * 3600e3);
  const dow = l.getUTCDay();
  const h = l.getUTCHours() + l.getUTCMinutes() / 60;
  if (dow === 0) return false;
  if (dow === 6) return h >= 9 && h < 12;
  return h >= 8 && h < 18;
}

/* ── Enlace para retomar (firmado, con vencimiento) ─────────────────── */

function resumeKey() {
  return `${process.env.JWT_SECRET ?? 'sin-secreto'}:signup-resume`;
}

function sign(body: string) {
  return createHmac('sha256', resumeKey()).update(body).digest('base64url').slice(0, 32);
}

export function resumeToken(sessionId: string, now = Date.now()): string {
  const body = `${sessionId}.${Math.floor((now + RESUME_TTL_MS) / 1000)}`;
  return `${Buffer.from(body).toString('base64url')}.${sign(body)}`;
}

/** Id de la sesión si el enlace es auténtico y no venció; si no, null. */
export function readResumeToken(t: unknown, now = Date.now()): string | null {
  if (typeof t !== 'string' || t.length > 200) return null;
  const [b64, sig] = t.split('.');
  if (!b64 || !sig) return null;
  let body = '';
  try {
    body = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = sign(body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const [id, exp] = body.split('.');
  if (!id || !/^\d+$/.test(exp ?? '') || Number(exp) * 1000 < now) return null;
  return id;
}

/* ── Respuestas guardadas (para retomar) ───────────────────────────── */

export type SignupAnswers = Partial<Record<(typeof SIGNUP_QUESTIONS)[number]['id'], string>>;

export function cleanAnswers(raw: unknown): SignupAnswers {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const text = clip(v, 600);
    if (QUESTION_IDS.includes(k) && text) out[k] = text;
  }
  return out;
}

function parseProgress(s: any): { answers: SignupAnswers; link?: string } {
  try {
    const p = JSON.parse(s?.progressJson ?? '{}');
    return { answers: cleanAnswers(p?.answers), ...(typeof p?.link === 'string' ? { link: p.link.slice(0, 200) } : {}) };
  } catch {
    return { answers: {} };
  }
}

/** Respuestas en una línea, para avisos y el mensaje de WhatsApp. */
export function answersLine(answers: SignupAnswers, max = 220): string {
  return SIGNUP_QUESTIONS.filter((q) => answers[q.id]).map((q) => answers[q.id]).join(' · ').slice(0, max);
}

export class SignupTracker {
  constructor(private readonly prisma: any) {}

  private async get(token: string) {
    return this.prisma.signupSession.findUnique({ where: { token } });
  }

  /** Modo en que va el registro ("ai" o "guided"). */
  async modeOf(token: unknown): Promise<string | null> {
    if (!isSessionToken(token)) return null;
    try {
      return (await this.get(token))?.mode ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Registra actividad. El paso solo avanza (volver atrás no "des-avanza"), las
   * respuestas guardan el máximo y la IA suma. Fuente: primer toque.
   */
  async touch(
    token: unknown,
    patch: {
      step?: SignupStep; answers?: number; description?: string; businessName?: string; businessType?: string;
      rubro?: string; mode?: string; ai?: { calls: number; tokens: number }; companyId?: string;
      referrer?: string; userAgent?: string; utmSource?: string; utmCampaign?: string; dailyChats?: number;
      utmMedium?: string; utmContent?: string; utmId?: string; fbclid?: string; landingPath?: string;
      g?: string; questionNo?: number; progress?: { answers: SignupAnswers; link?: string };
    } = {},
  ) {
    if (!isSessionToken(token)) return null;
    try {
      const now = new Date();
      const current = await this.get(token);
      const stepIdx = (s?: string) => SIGNUP_STEPS.indexOf((s ?? 'STARTED') as SignupStep);
      const step = patch.step && stepIdx(patch.step) > stepIdx(current?.step) ? patch.step : current?.step ?? patch.step ?? 'STARTED';
      const g = String(patch.g ?? '').toLowerCase();
      const referrer = clip(patch.referrer, 200);
      const data: Record<string, any> = {
        step,
        lastSeenAt: now,
        ...(patch.answers !== undefined ? { answers: Math.max(current?.answers ?? 0, patch.answers) } : {}),
        ...(clip(patch.description, 600) && !current?.description ? { description: clip(patch.description, 600) } : {}),
        ...(clip(patch.businessName, 80) ? { businessName: clip(patch.businessName, 80) } : {}),
        ...(clip(patch.businessType, 80) ? { businessType: clip(patch.businessType, 80) } : {}),
        ...(clip(patch.rubro, 20) ? { rubro: clip(patch.rubro, 20) } : {}),
        ...(patch.mode ? { mode: patch.mode } : {}),
        ...(patch.dailyChats ? { dailyChats: Math.round(patch.dailyChats) } : {}),
        ...(clip(patch.utmSource, 60) && !current?.utmSource ? { utmSource: clip(patch.utmSource, 60)!.toLowerCase() } : {}),
        ...(clip(patch.utmCampaign, 120) && !current?.utmCampaign ? { utmCampaign: clip(patch.utmCampaign, 120) } : {}),
        // Primer toque: lo que trajo a la persona la primera vez no se reemplaza
        ...(clip(patch.utmMedium, 60) && !current?.utmMedium ? { utmMedium: clip(patch.utmMedium, 60)!.toLowerCase() } : {}),
        ...(clip(patch.utmContent, 120) && !current?.utmContent ? { utmContent: clip(patch.utmContent, 120) } : {}),
        ...(UTM_ID.test(String(patch.utmId ?? '')) && !current?.utmId ? { utmId: String(patch.utmId) } : {}),
        ...(FBCLID.test(String(patch.fbclid ?? '')) && !current?.fbclid ? { fbclid: String(patch.fbclid) } : {}),
        ...(LANDING.test(String(patch.landingPath ?? '')) && !current?.landingPath ? { landingPath: String(patch.landingPath) } : {}),
        ...(GROUP.test(g) && !current?.g ? { g } : {}),
        // De dónde llegó: solo otro sitio cuenta (navegar dentro de la web no es una fuente)
        ...(current && !current.referrer && externalHost(referrer) ? { referrer } : {}),
        ...(patch.questionNo && patch.questionNo >= 1 && patch.questionNo <= QUESTION_COUNT ? { questionNo: Math.round(patch.questionNo) } : {}),
        ...(patch.progress ? { progressJson: JSON.stringify({ answers: patch.progress.answers, ...(patch.progress.link ? { link: patch.progress.link } : {}) }).slice(0, 5000) } : {}),
        ...(patch.companyId ? { companyId: patch.companyId } : {}),
        ...(patch.ai ? { aiCalls: (current?.aiCalls ?? 0) + patch.ai.calls, aiTokens: (current?.aiTokens ?? 0) + patch.ai.tokens } : {}),
      };
      if (current) return await this.prisma.signupSession.update({ where: { id: current.id }, data });
      return await this.prisma.signupSession.create({
        data: { token, ...data, referrer: externalHost(referrer) ? referrer : undefined, userAgent: clip(patch.userAgent, 200) },
      });
    } catch {
      return null; // el seguimiento nunca rompe el registro
    }
  }

  /**
   * Datos de contacto que la persona ya escribió bien (para ayudarle si abandona).
   * `step`: CONTACT desde la pantalla de entrada; sin él, el correo del formulario
   * de la cuenta marca ACCOUNT. Devuelve qué es nuevo (para avisar una sola vez).
   */
  async contact(token: unknown, raw: Record<string, unknown>, opts: { step?: SignupStep } = {}): Promise<{
    phoneAdded: boolean; emailAdded: boolean; name: string | null; businessName: string | null; phone: string | null; email: string | null;
    campaign: string | null; source: string; session: any;
  } | undefined> {
    if (!isSessionToken(token)) return;
    const email = clip(raw?.email, 120)?.toLowerCase();
    const phone = clip(raw?.phone, 25);
    const patch: Record<string, any> = {
      ...(clip(raw?.name, 80) ? { contactName: clip(raw?.name, 80) } : {}),
      ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? { email } : {}),
      ...(phone && phone.replace(/\D/g, '').length >= 10 ? { phone } : {}),
      ...(clip(raw?.companyName, 80) ? { businessName: clip(raw?.companyName, 80) } : {}),
    };
    if (!Object.keys(patch).length) return;
    const step = opts.step ?? (patch.email ? 'ACCOUNT' : undefined);
    await this.touch(token, step ? { step } : {});
    const current = await this.get(token);
    if (!current) return;
    if (patch.phone && !current.contactAt) patch.contactAt = new Date();
    const saved = await this.prisma.signupSession.update({ where: { id: current.id }, data: patch }).then((r: any) => r).catch(() => null);
    const after = saved ?? current;
    return {
      phoneAdded: !!saved && !!patch.phone && !current.phone,
      emailAdded: !!saved && !!patch.email && !current.email,
      name: after.contactName ?? null,
      businessName: after.businessName ?? null,
      phone: after.phone ?? null,
      email: after.email ?? null,
      campaign: current.utmCampaign ?? (current.fbclid ? 'Meta (sin campaña)' : null),
      source: sourceOf(after).label,
      session: after,
    };
  }

  /**
   * Un paso del embudo. Cada tipo (y cada pregunta) cuenta una vez por sesión:
   * recargar o volver atrás no infla el embudo.
   */
  async event(token: unknown, type: unknown, extra: { questionNo?: unknown; questionId?: unknown; progress?: unknown; link?: unknown } = {}, meta: Parameters<SignupTracker['touch']>[1] = {}) {
    if (!isSessionToken(token) || !(EVENT_TYPES as readonly string[]).includes(String(type))) return null;
    const t = type as SignupEventType;
    const isQuestion = t === 'pregunta_vista' || t === 'pregunta_respondida';
    const n = Number(extra.questionNo);
    if (isQuestion && !(Number.isInteger(n) && n >= 1 && n <= QUESTION_COUNT)) return null;
    const questionId = isQuestion ? (QUESTION_IDS.includes(String(extra.questionId)) ? String(extra.questionId) : QUESTION_IDS[n - 1]) : undefined;
    const answers = cleanAnswers(extra.progress);
    const link = clip(extra.link, 200);
    const session = await this.touch(token, {
      ...meta,
      ...(isQuestion ? { step: 'INTERVIEW' as const, questionNo: n } : {}),
      ...(t === 'pregunta_respondida' ? { answers: n } : {}),
      ...(t === 'plan_revisado' ? { step: 'PREVIEW' as const } : {}),
      ...(t === 'datos_llenados' ? { step: 'ACCOUNT' as const } : {}),
      ...(Object.keys(answers).length ? { progress: { answers, link } } : {}),
      ...(answers.tipo && answers.oferta ? { description: `${answers.tipo}: ${answers.oferta}` } : {}),
    });
    if (!session) return null;
    try {
      const where = { sessionId: session.id, type: t, ...(isQuestion ? { questionNo: n } : {}) };
      if (await this.prisma.signupEvent.findFirst({ where })) return session;
      await this.prisma.signupEvent.create({ data: { ...where, ...(questionId ? { questionId } : {}), at: new Date() } });
    } catch {
      /* el embudo nunca rompe el registro */
    }
    return session;
  }

  /** Lo que eligió en «contacto rápido»: que le escriban hoy o una videollamada. */
  async preference(token: unknown, kind: 'TODAY' | 'CALL', meetingAt?: Date) {
    if (!isSessionToken(token)) return null;
    const current = await this.get(token);
    if (!current) return null;
    return this.prisma.signupSession.update({
      where: { id: current.id },
      data: {
        contactPreference: kind,
        lastSeenAt: new Date(),
        ...(kind === 'CALL' && meetingAt ? { meetingAt, ...(current.followStatus === 'NEW' ? { followStatus: 'MEETING' } : {}) } : {}),
      },
    });
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

  /** Lo que se devuelve al abrir el enlace del correo: retoma justo donde iba. */
  async resume(t: unknown) {
    const id = readResumeToken(t);
    if (!id) throw new BadRequestException('Este enlace venció o no es válido. Empieza de nuevo: tus datos de contacto ya los tenemos.');
    const s = await this.prisma.signupSession.findUnique({ where: { id } });
    if (!s) throw new BadRequestException('No encontramos ese registro. Empieza de nuevo, por favor.');
    if (s.step === 'DONE') throw new BadRequestException('Ese registro ya terminó: entra con tu correo y tu contraseña.');
    await this.prisma.signupSession.update({ where: { id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
    const p = parseProgress(s);
    return {
      session: s.token,
      questionNo: s.questionNo ?? null,
      answers: p.answers,
      link: p.link ?? null,
      contact: { companyName: s.businessName ?? '', phone: s.phone ?? '', email: s.email ?? '' },
    };
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
    const source = sourceOf(s);
    const progress = parseProgress(s);
    const baseLabel = STEP_LABELS[s.step as SignupStep] ?? s.step;
    const contactAt = s.contactAt ?? null;
    return {
      id: s.id,
      step: s.step,
      // En qué pregunta va (o en cuál se fue)
      stepLabel: s.step === 'INTERVIEW' && s.questionNo ? `${baseLabel} · pregunta ${s.questionNo} de ${QUESTION_COUNT}` : baseLabel,
      questionNo: s.questionNo ?? null,
      state: done ? 'DONE' : abandoned ? 'ABANDONED' : 'ACTIVE',
      answers: s.answers,
      answersMap: progress.answers,
      link: progress.link ?? null,
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
      utmSource: s.utmSource ?? null,
      utmCampaign: s.utmCampaign ?? null,
      utmContent: s.utmContent ?? null,
      g: s.g ?? null,
      source: source.key,
      sourceLabel: source.label,
      dailyChats: s.dailyChats ?? null,
      contactPreference: s.contactPreference ?? null,
      contactAt,
      firstContactAt: s.firstContactAt ?? null,
      firstContactBy: s.firstContactBy ?? null,
      responseMinutes: contactAt && s.firstContactAt ? Math.max(0, Math.round((+new Date(s.firstContactAt) - +new Date(contactAt)) / 60e3)) : null,
      followStatus: s.followStatus,
      meetingAt: s.meetingAt ?? null,
      followNotes: s.followNotes ?? null,
      followBy: s.followBy ?? null,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
    };
  }

  async list(filter: { state?: string; days?: number; source?: string } = {}) {
    const days = Math.min(90, Math.max(1, Number(filter.days) || 30));
    const since = new Date(Date.now() - days * 86400e3);
    const rows = await this.prisma.signupSession.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { lastSeenAt: 'desc' },
      take: 2000,
    });
    const now = Date.now();
    const everyone = rows.map((r: any) => SignupTracker.view(r, now));
    const all = everyone.filter((r: any) => matchesSource(r.source, filter.source));
    // Embudo: cuántos llegaron AL MENOS a cada paso. Los registros de antes del
    // paso «Dejó contacto» cuentan ahí si dejaron su WhatsApp.
    const idx = (s: string) => SIGNUP_STEPS.indexOf(s as SignupStep);
    const reached = (step: SignupStep) => all.filter((r: any) => idx(r.step) >= idx(step) || (step === 'CONTACT' && !!r.phone)).length;
    const funnel = SIGNUP_STEPS.map((step) => ({ step, label: STEP_LABELS[step], count: reached(step) }));
    const isTodo = (r: any) => r.followStatus === 'NEW' && (r.state === 'DONE' || r.email || r.phone);
    const sessions = filter.state && filter.state !== 'ALL'
      ? all.filter((r: any) => (filter.state === 'TODO' ? isTodo(r) : r.state === filter.state))
      : all;
    const withAi = all.filter((r: any) => r.aiCalls > 0);

    // Fuentes (siempre sobre todos: es el menú del filtro)
    const bySourceMap = new Map<string, { key: string; label: string; sessions: number; contacts: number; done: number }>();
    for (const r of everyone) {
      const row = bySourceMap.get(r.source) ?? { key: r.source, label: r.sourceLabel, sessions: 0, contacts: 0, done: 0 };
      row.sessions++;
      if (r.phone) row.contacts++;
      if (r.state === 'DONE') row.done++;
      bySourceMap.set(r.source, row);
    }
    const bySource = [...bySourceMap.values()].sort((a, b) => b.sessions - a.sessions);

    return {
      days,
      source: filter.source && filter.source !== 'ALL' ? filter.source : null,
      funnel,
      detail: await this.detail(all.map((r: any) => r.id), since),
      bySource,
      response: SignupTracker.responseStats(all),
      totals: {
        sessions: all.length,
        done: all.filter((r: any) => r.state === 'DONE').length,
        abandoned: all.filter((r: any) => r.state === 'ABANDONED').length,
        active: all.filter((r: any) => r.state === 'ACTIVE').length,
        pendingFollow: all.filter(isTodo).length,
        avgTokens: withAi.length ? Math.round(withAi.reduce((a: number, r: any) => a + r.aiTokens, 0) / withAi.length) : 0,
        guided: all.filter((r: any) => r.mode === 'guided').length,
      },
      sessions: sessions.slice(0, 200),
    };
  }

  /**
   * Embudo detallado desde los eventos: la pantalla de entrada, cada pregunta
   * (cuántos la vieron, la respondieron, % de abandono y tiempo promedio) y lo
   * que sigue. Solo cuenta desde que existen los eventos.
   */
  async detail(sessionIds: string[], since: Date) {
    const ids = new Set(sessionIds);
    const events: any[] = (await this.prisma.signupEvent.findMany({ where: { at: { gte: since } }, take: 50000 }).catch(() => [])).filter((e: any) => ids.has(e.sessionId));
    const first = new Map<string, Date>(); // sesión|tipo|pregunta → primera vez
    for (const e of events) {
      const k = `${e.sessionId}|${e.type}|${e.questionNo ?? ''}`;
      const at = new Date(e.at);
      if (!first.has(k) || at < first.get(k)!) first.set(k, at);
    }
    const count = (type: string, q?: number) => {
      const suffix = `|${type}|${q ?? ''}`;
      let n = 0;
      for (const k of first.keys()) if (k.endsWith(suffix)) n++;
      return n;
    };
    const pre = PRE_EVENTS.map((type) => ({ type, label: EVENT_LABELS[type], count: count(type) }));
    const questions = SIGNUP_QUESTIONS.map((q, i) => {
      const n = i + 1;
      const viewed = count('pregunta_vista', n);
      const answered = count('pregunta_respondida', n);
      const secs: number[] = [];
      for (const [k, at] of first) {
        const [sid, type, qn] = k.split('|');
        if (type !== 'pregunta_vista' || qn !== String(n)) continue;
        const done = first.get(`${sid}|pregunta_respondida|${n}`);
        if (done && done >= at) secs.push(Math.min(1800, (done.getTime() - at.getTime()) / 1000));
      }
      return {
        n, id: q.id, label: q.label, viewed, answered,
        dropPct: viewed ? Math.round(((viewed - Math.min(answered, viewed)) / viewed) * 100) : null,
        avgSeconds: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length) : null,
      };
    });
    const post = POST_EVENTS.map((type) => ({ type, label: EVENT_LABELS[type], count: count(type) }));
    return { pre, questions, post, measuredSince: events.length ? new Date(Math.min(...events.map((e) => +new Date(e.at)))) : null };
  }

  /** Tiempo desde «Dejó contacto» hasta el primer contacto del equipo. */
  static responseStats(rows: any[]) {
    const timed = rows.filter((r) => r.contactAt && r.firstContactAt);
    const minutes = timed.map((r) => r.responseMinutes as number).sort((a, b) => a - b);
    const inHours = timed.filter((r) => inBusinessHours(new Date(r.contactAt)));
    const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2] : Math.round((minutes[minutes.length / 2 - 1] + minutes[minutes.length / 2]) / 2)) : null;
    return {
      contacted: timed.length,
      waiting: rows.filter((r) => r.contactAt && !r.firstContactAt && r.followStatus === 'NEW').length,
      avgMinutes: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
      medianMinutes: median,
      // Meta: menos de 5 minutos en horario laboral
      under5InHoursPct: inHours.length ? Math.round((inHours.filter((r) => r.responseMinutes < 5).length / inHours.length) * 100) : null,
      inHours: inHours.length,
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
    // Primer contacto: la primera vez que sale de «Sin contactar» (mide el tiempo de respuesta)
    if (!current.firstContactAt && data.followStatus && data.followStatus !== 'NEW') {
      data.firstContactAt = new Date();
      data.firstContactBy = actor.name;
    }
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

  /** Quien se quedó a mitad (30 min) y dejó correo: recibe «Te quedaste en la pregunta X» una sola vez. */
  async pendingResumeEmails() {
    const cutoff = new Date(Date.now() - ABANDON_AFTER_MS);
    const rows = await this.prisma.signupSession.findMany({
      where: {
        OR: [{ resumeEmailAt: null }, { resumeEmailAt: { isSet: false } }],
        lastSeenAt: { lt: cutoff },
        createdAt: { gte: new Date(Date.now() - 3 * 86400e3) },
      },
      take: 50,
    });
    return rows.filter((r: any) => r.step !== 'DONE' && r.email);
  }

  async markResumeEmailed(id: string) {
    await this.prisma.signupSession.update({ where: { id }, data: { resumeEmailAt: new Date() } }).catch(() => undefined);
  }
}
