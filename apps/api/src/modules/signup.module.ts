import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthModule } from '../auth/auth.module';
import { AuthService } from '../auth/auth.service';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { ChainEntry, GeminiPool, chainId, isAiUnavailable } from '../ai/gemini-pool';
import { benchMany } from '../ai/setup-ai-bench';
import { parseDailyChats } from '../common/ai-cost';
import { SignupStep, SignupTracker } from './signup-tracking';
import { linkReferral } from './commerce.module';
import { guidedBlueprint, guidedTurn } from '../common/signup-guided';
import { TEAM_SIZES, detectProfile, fitToProfile, interviewHint, profileOfCompany } from '../common/business-profile';
import { blueprintSystemPrompt, interviewSystemPrompt } from '../common/signup-prompts';
import { RUBRO_CONFIG, Rubro, guessRubro, isRubro, onboardingChecklist } from '../common/rubros';
import { ANNUAL_MONTHS_CHARGED } from '../common/billing-engine';
import { AuditModule, AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';
import { CompaniesModule, CompaniesService } from './companies.module';
import { SetupProposal, applySetupProposal, normalizeProposal } from './ai-setup.module';
import {
  Blueprint, agentPresetFor, assistantPromptFromBlueprint, moduleListFor,
  normalizeBlueprint, normalizeInterviewTurn, revalidateBlueprint,
} from '../common/blueprint';
import { AGENT_PRESETS } from '../ai/agent/tools';

/**
 * Registro por la web (autoservicio, sin prueba gratis):
 *  1. La persona describe su negocio → la IA (llaves genéricas de Gemini, con
 *     rotación) propone rubro, catálogo, horario, preguntas y asistente.
 *  2. Crea su cuenta → la empresa nace EN CONFIGURACIÓN (status ONBOARDING) con
 *     los módulos de SU rubro, y al equipo le llega un correo con lo que falta
 *     y el WhatsApp para contactarla.
 *  3. En "Primeros pasos" una IA la acompaña, ve su avance y elige plan
 *     (la activación y el cobro los hace el equipo).
 */

const SIGNUP_ACTOR: AuthUser = {
  id: 'registro-web', role: ROLES.DEV, companyId: null, name: 'Registro web', email: 'registro@backoffice.dev',
} as AuthUser;
const CHAT_DAILY_CAP = 40;
const MAX_QUESTIONS = 8; // la entrevista nunca se alarga más de esto
/** Primera pregunta fija (sin gastar IA): el nombre del negocio y la ciudad. */
const NAME_QUESTION = '¡Qué bien! ¿Cómo se llama tu negocio y en qué ciudad está?';
/** Segunda pregunta fija: cuántos clientes escriben al día (base del cálculo de costos de IA). */
const VOLUME_QUESTION = '¿Más o menos cuántos clientes te escriben al día?';
const VOLUME_OPTIONS = ['1 a 10', '10 a 30', '30 a 100', 'Más de 100'];

/** La respuesta a la pregunta de volumen, convertida a número. */
export function dailyChatsFrom(msgs: Array<{ role: string; content: string }>): number | null {
  const i = msgs.findIndex((m) => m.role === 'assistant' && m.content === VOLUME_QUESTION);
  const answer = i >= 0 ? msgs.slice(i + 1).find((m) => m.role === 'user') : null;
  return answer ? parseDailyChats(answer.content) : null;
}
/** Plano ya armado para la misma conversación (volver atrás o reintentar no gasta IA). */
const PREVIEW_CACHE_MS = 60 * 60e3;
const DEFAULT_NOTIFY = 'restrepos591@gmail.com';

/** Celular colombiano a formato internacional para wa.me (solo dígitos). */
export function whatsappDigits(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) return `57${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

export function slugBase(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'empresa';
}

/**
 * Error de un campo del formulario: el navegador lo pinta debajo de ese campo
 * (field) en vez de un aviso genérico.
 */
export function fieldError(field: string, message: string, code?: string): BadRequestException {
  return new BadRequestException({ statusCode: 400, field, message, ...(code ? { code } : {}) });
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

@Injectable()
export class SignupService {
  private readonly logger = new Logger('Signup');
  readonly pool: GeminiPool;
  readonly tracker: SignupTracker;
  private readonly previewCache = new Map<string, { at: number; value: any }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly emails: EmailsService,
    private readonly companies: CompaniesService,
    private readonly auth: AuthService,
  ) {
    this.pool = new GeminiPool(prisma);
    this.tracker = new SignupTracker(prisma);
  }

  /* ── 1. Entrevista con IA (pública) ────────────────────────────── */

  /** Conversación con el dueño: valida y recorta lo que manda el navegador. */
  private cleanConversation(raw: unknown) {
    const msgs = (Array.isArray(raw) ? raw : [])
      .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(0, MAX_QUESTIONS * 2 + 2)
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).trim().slice(0, 1200) }));
    const answers = msgs.filter((m) => m.role === 'user');
    return { msgs, answers };
  }

  /**
   * La IA pregunta, una cosa a la vez, cómo funciona el negocio y qué necesita.
   * Si ninguna IA responde (o responde algo que no se entiende), siguen las
   * preguntas fijas del plan B: la persona nunca se queda trabada.
   */
  async interview(dto: { messages?: unknown; session?: unknown }, meta: { referrer?: string; userAgent?: string; utmSource?: string; utmCampaign?: string } = {}) {
    const { msgs, answers } = this.cleanConversation(dto?.messages);
    if (!answers.length) throw fieldError('message', 'Cuéntanos primero qué hace tu negocio');
    if (answers[0].content.length < 10) {
      throw fieldError('message', 'Cuéntanos un poquito más. Por ejemplo: "Vendo almuerzos a domicilio en Medellín".');
    }
    await this.tracker.touch(dto?.session, { step: 'INTERVIEW', answers: answers.length, description: answers[0].content, ...meta });
    if (answers.length >= MAX_QUESTIONS) return { ...normalizeInterviewTurn({ listo: true }, answers.length, MAX_QUESTIONS), mode: 'ai' as const };
    // La primera pregunta siempre es la misma: no gasta IA y asegura el nombre
    if (answers.length === 1) {
      return { done: false, question: NAME_QUESTION, options: [], understood: '', mode: 'ai' as const };
    }
    if (answers.length === 2) {
      return { done: false, question: VOLUME_QUESTION, options: VOLUME_OPTIONS, understood: '', mode: 'ai' as const };
    }
    const daily = dailyChatsFrom(msgs);
    if (daily) await this.tracker.touch(dto?.session, { dailyChats: daily });
    // Si la IA ya falló en este registro, sigue guiado: nadie vuelve a esperar por ella
    const stickyGuided = (await this.tracker.modeOf(dto?.session)) === 'guided';
    if (!stickyGuided) try {
      // El tope de tokens no cuesta (se paga lo usado); el ahorro está en el historial compacto
      const { raw, tokens, calls } = await this.pool.chatJson(
        {
          temperature: 0.5,
          maxTokens: 1200,
          // Nadie espera más de 12 s una pregunta: si la IA se demora, siguen las preguntas guiadas
          deadlineMs: 12_000,
          messages: [
            { role: 'system', content: interviewSystemPrompt(MAX_QUESTIONS) },
            // Perfil detectado por código: preguntas y opciones de SU negocio, no de restaurante
            { role: 'system', content: interviewHint(detectProfile(answers.map((a) => a.content).join(' '), answers[0].content)) },
            // Historial compacto: las preguntas ya hechas pesan poco, las respuestas mandan
            ...msgs.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, m.role === 'assistant' ? 160 : 500) })),
          ],
        },
        (o) => o.listo === true || (typeof o.pregunta === 'string' && !!o.pregunta.trim()),
      );
      await this.tracker.touch(dto?.session, { ai: { calls, tokens }, mode: 'ai' });
      return { ...normalizeInterviewTurn(raw, answers.length, MAX_QUESTIONS), mode: 'ai' as const };
    } catch (err) {
      if (!isAiUnavailable(err)) throw err;
      const spent: any = (err as any).getResponse?.();
      if (spent?.calls) await this.tracker.touch(dto?.session, { ai: { calls: spent.calls, tokens: spent.tokens ?? 0 } });
    }
    // Plan B: si ya contó bastante, se arma con eso; si no, preguntas fijas
    await this.tracker.touch(dto?.session, { mode: 'guided' });
    // Las preguntas fijas de volumen ya se hicieron: el plan B arranca una más atrás
    const turn = answers.length >= 6 ? { listo: true } : guidedTurn(answers[0].content, answers.length - 1, answers.map((a) => a.content).join(' '));
    return { ...normalizeInterviewTurn(turn, answers.length, MAX_QUESTIONS), mode: 'guided' as const };
  }

  /* ── 2. Plano a la medida (público) ─────────────────────────────── */

  async preview(dto: { description?: string; messages?: unknown; session?: unknown }) {
    const { msgs, answers } = this.cleanConversation(dto?.messages);
    // Transcripción compacta: la pregunta corta, la respuesta completa (ahorra contexto)
    const transcript = msgs.length
      ? msgs.map((m) => (m.role === 'assistant' ? `P: ${m.content.slice(0, 140)}` : `R: ${m.content}`)).join('\n')
      : String(dto?.description ?? '').trim();
    const ownerText = msgs.length ? answers.map((a) => a.content).join(' ') : transcript;
    if (ownerText.length < 40) {
      throw fieldError('message', 'Cuéntanos un poquito más: qué vendes, a quién y cómo atiendes. Con una o dos frases basta.', 'TOO_SHORT');
    }
    if (transcript.length > 12000) throw fieldError('message', 'La conversación quedó muy larga. Empieza de nuevo con lo más importante.');
    await this.tracker.touch(dto?.session, { step: 'PREVIEW', answers: answers.length });
    const cacheKey = createHash('sha256').update(transcript).digest('hex');
    const cached = this.previewCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PREVIEW_CACHE_MS) return cached.value;
    const request = {
      json: true,
      temperature: 0.2,
      maxTokens: 6000,
      // La pantalla "Armando tu cuenta" espera como mucho 1 minuto; luego, el plano básico
      deadlineMs: 60_000,
      messages: [
        {
          role: 'system',
          content: blueprintSystemPrompt(),
        },
        { role: 'user' as const, content: transcript },
      ],
    };
    // Toda la cadena de modelos; si ninguno da un plano útil, el plano básico del plan B
    let raw: Record<string, any> | null = null;
    let mode: 'ai' | 'guided' = 'ai';
    try {
      const r = await this.pool.chatJson(request as any, (o) => !!(o?.empresa || o?.asistente || o?.rubro));
      raw = r.raw;
      await this.tracker.touch(dto?.session, { ai: { calls: r.calls, tokens: r.tokens } });
    } catch (err) {
      if (!isAiUnavailable(err)) throw err;
      const spent: any = (err as any).getResponse?.();
      if (spent?.calls) await this.tracker.touch(dto?.session, { ai: { calls: spent.calls, tokens: spent.tokens ?? 0 } });
    }
    if (!raw) {
      raw = guidedBlueprint(answers.length ? answers.map((a) => a.content) : [ownerText]);
      mode = 'guided';
    }
    const proposal = normalizeProposal(raw);
    const profile = detectProfile(ownerText, answers[0]?.content ?? ownerText);
    const bp = fitToProfile(normalizeBlueprint(raw, guessRubro(ownerText)), proposal, profile, ownerText);
    // Siempre hay asistente: si la IA no lo propuso, uno sensato con el nombre del negocio
    if (!proposal.assistant) {
      const business = typeof raw.empresa?.nombre === 'string' && raw.empresa.nombre.trim() ? raw.empresa.nombre.trim().slice(0, 60) : 'tu negocio';
      proposal.assistant = {
        name: 'Sara',
        tone: 'Cercano y profesional',
        style: 'Mensajes cortos y claros',
        welcome: `¡Hola! Soy Sara, de ${business}. ¿En qué te puedo ayudar?`,
        instructions: `Atiendes el WhatsApp de ${business}${bp.businessType ? ` (${bp.businessType})` : ''}: respondes dudas, das precios y requisitos que conoces y llevas al cliente al siguiente paso. Si no sabes algo, lo pasas a una persona del equipo.`,
      };
    }
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');
    const { rubro, ...blueprint } = bp;
    await this.tracker.touch(dto?.session, { mode, rubro, businessType: bp.businessType, businessName: str(raw.empresa?.nombre, 80) });
    const value = {
      rubro,
      rubroLabel: RUBRO_CONFIG[rubro].label,
      company: {
        name: str(raw.empresa?.nombre, 80),
        city: str(raw.empresa?.ciudad, 60),
        summary: str(raw.empresa?.resumen, 200),
      },
      proposal,
      blueprint,
      // Lo que la pantalla de revisión NO debe ofrecer a este tipo de negocio
      profile: { key: profile.key, label: profile.label, hide: profile.deny },
      mode,
    };
    if (mode === 'ai') {
      if (this.previewCache.size > 300) this.previewCache.clear();
      this.previewCache.set(cacheKey, { at: Date.now(), value });
    }
    return value;
  }

  /** Eventos sueltos del navegador: vio un paso, escribió su contacto, vio un error. */
  async track(dto: any, meta: { referrer?: string; userAgent?: string; utmSource?: string; utmCampaign?: string } = {}) {
    const session = dto?.session;
    const step = ['STARTED', 'INTERVIEW', 'PREVIEW', 'ACCOUNT'].includes(dto?.step) ? (dto.step as SignupStep) : undefined;
    if (dto?.event === 'contact') await this.tracker.contact(session, dto?.data ?? {});
    else if (dto?.event === 'error') await this.tracker.error(session, step, String(dto?.message ?? ''));
    else await this.tracker.touch(session, { step, ...meta });
    return { ok: true };
  }

  /* ── 3. Crear la cuenta (pública) ──────────────────────────────── */

  async register(dto: any) {
    const name = String(dto?.company?.name ?? '').trim().slice(0, 80);
    const city = String(dto?.company?.city ?? '').trim().slice(0, 60) || null;
    const adminName = String(dto?.admin?.name ?? '').trim().slice(0, 80);
    const email = String(dto?.admin?.email ?? '').trim().toLowerCase();
    const phone = String(dto?.admin?.phone ?? '').trim().slice(0, 25);
    const password = String(dto?.admin?.password ?? '');
    const { msgs } = this.cleanConversation(dto?.messages);
    await this.tracker.contact(dto?.session, { name: adminName, email, phone, companyName: name });
    const description = (String(dto?.description ?? '').trim()
      || msgs.filter((m) => m.role === 'user').map((m) => m.content).join(' · ')).slice(0, 4000);
    if (name.length < 2) throw fieldError('companyName', 'Escribe el nombre de tu negocio');
    if (adminName.length < 2) throw fieldError('name', 'Escribe tu nombre');
    if (!email) throw fieldError('email', 'Escribe tu correo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw fieldError('email', 'Ese correo no está bien escrito. Ejemplo: nombre@gmail.com');
    if (!whatsappDigits(phone)) throw fieldError('phone', 'Escribe tu número de WhatsApp de 10 números. Ejemplo: 300 123 4567');
    if (password.length < 8) throw fieldError('password', 'La contraseña necesita al menos 8 letras o números');
    if (dto?.acceptTerms !== true) throw fieldError('accept', 'Marca la casilla para aceptar los términos');
    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw fieldError('email', 'Ese correo ya tiene una cuenta. Entra con él o usa otro.', 'EMAIL_TAKEN');
    }
    const rubro: Rubro = isRubro(dto?.rubro) ? dto.rubro : guessRubro(`${name} ${description}`);
    const cfg = RUBRO_CONFIG[rubro];
    const proposal: SetupProposal | null = dto?.proposal && typeof dto.proposal === 'object' ? dto.proposal : null;
    // El plano puede venir editado por el dueño: se revalida completo
    const bp = dto?.blueprint && typeof dto.blueprint === 'object' ? revalidateBlueprint(dto.blueprint, rubro) : null;
    const modules = bp ? moduleListFor(bp) : cfg.modules;

    // Slug libre (el registro nunca falla porque el nombre ya exista)
    let slug = slugBase(name);
    if (await this.prisma.company.findUnique({ where: { slug } })) {
      slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    }

    const assistantPrompt = proposal?.assistant
      ? assistantPromptFromBlueprint(proposal.assistant.instructions || `Atiendes el WhatsApp de ${name}.`, bp ?? { businessType: '', assistantFlow: [], clientData: [] })
      : '';
    const created: any = await this.companies.provision(SIGNUP_ACTOR, {
      name, slug, city: city ?? undefined, country: 'Colombia', currency: 'COP', timezone: 'America/Bogota',
      contactEmail: email, contactPhone: phone, status: 'ONBOARDING',
      industry: bp?.businessType || cfg.label,
      templateId: cfg.templateId, modules,
      admin: { name: adminName, email, password, jobTitle: 'Dueño / administrador' },
      ...(proposal?.assistant?.name
        ? { bot: { name: proposal.assistant.name, systemPrompt: assistantPrompt, welcomeMessage: proposal.assistant.welcome } }
        : {}),
      notes: 'Registrada por la web (autoservicio).',
    } as any);
    const companyId: string = created?.id ?? created?.company?.id;

    if (proposal) {
      await applySetupProposal(this.prisma, this.audit, SIGNUP_ACTOR, companyId, proposal, {
        createAssistant: false,
        agentPreset: agentPresetFor(modules),
      });
      if (proposal.assistant) {
        await this.prisma.bot.updateMany({
          where: { companyId, name: proposal.assistant.name },
          data: {
            personalityJson: JSON.stringify({ tone: proposal.assistant.tone, style: proposal.assistant.style, language: 'es-CO' }),
            engineMode: 'AGENT',
            toolsJson: JSON.stringify(AGENT_PRESETS[agentPresetFor(modules)].tools),
          },
        });
      }
    }
    if (bp) await this.applyBlueprintExtras(companyId, bp);
    await this.prisma.company.update({
      where: { id: companyId },
      data: {
        onboardingJson: JSON.stringify({
          source: 'SIGNUP', rubro, description, contactName: adminName, phone, createdAt: new Date().toISOString(),
          ...(dailyChatsFrom(msgs) ? { dailyChats: dailyChatsFrom(msgs) } : {}),
          ...(bp ? { businessType: bp.businessType, needs: bp.needs, clientData: bp.clientData, assistantFlow: bp.assistantFlow, modules: bp.modules } : {}),
          ...(msgs.length ? { interview: msgs.slice(0, 18).map((m) => ({ role: m.role, content: m.content.slice(0, 600) })) } : {}),
        }),
      },
    });
    await this.audit.log({
      actor: SIGNUP_ACTOR, companyId, action: 'signup.create', entity: 'Company', entityId: companyId,
      detail: `${name} · ${bp?.businessType || cfg.label} · ${email}`,
    });

    if (dto?.referralCode) await linkReferral(this.prisma, companyId, dto.referralCode).catch(() => false);
    const session = await this.tracker.touch(dto?.session, { step: 'DONE', companyId, rubro, businessName: name, businessType: bp?.businessType });
    // Aviso al equipo (si el correo falla, el registro igual queda hecho)
    try {
      await this.notifyNewCompany(companyId);
      if (session) await this.tracker.markNotified(session.id);
    } catch (err: any) {
      this.logger.warn(`aviso de registro no enviado: ${err.message}`);
    }
    return this.auth.login(email, password);
  }

  /** Embudo propio, respuestas rápidas y seguimientos del plano. */
  private async applyBlueprintExtras(companyId: string, bp: Blueprint) {
    if (bp.pipeline) {
      await this.prisma.pipeline.create({
        data: { companyId, name: bp.pipeline.name, stagesJson: JSON.stringify(bp.pipeline.stages), isDefault: true },
      });
    }
    for (const r of bp.quickReplies) {
      await this.prisma.quickReply.create({ data: { companyId, ...r } });
    }
    if (bp.followUps.length) {
      const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
      const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {});
      const followUps = bp.followUps.map((f, i) => ({ id: `ia${i + 1}`, enabled: true, ...f }));
      await this.prisma.company.update({
        where: { id: companyId },
        data: { orderConfigJson: JSON.stringify({ ...cfg, followUps: [...(cfg.followUps ?? []), ...followUps] }) },
      });
    }
  }

  /** A quién avisar: SIGNUP_NOTIFY_EMAIL (uno o varios separados por coma). */
  private async notifyEmails(): Promise<string[]> {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } });
    const raw = row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || DEFAULT_NOTIFY;
    return [...new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 10);
  }

  private async sendToTeam(subject: string, body: string) {
    for (const toEmail of await this.notifyEmails()) {
      await this.emails.systemSend({ toEmail, subject, body });
    }
  }

  /**
   * Cada 15 min: quien dejó el registro a mitad (30 min sin actividad) PERO
   * dejó cómo contactarlo → aviso al equipo para ayudarle.
   */
  @Cron('*/15 * * * *')
  async notifyAbandoned() {
    const pending = await this.tracker.pendingNotifications().catch(() => []);
    for (const s of pending) {
      const v = SignupTracker.view(s);
      const wa = v.whatsapp ? ` · <a href="https://wa.me/${v.whatsapp}">escribirle por WhatsApp</a>` : '';
      try {
        await this.sendToTeam(
          `Registro sin terminar: ${v.businessName ?? v.contactName ?? v.email ?? 'sin nombre'} — se quedó en "${v.stepLabel}"`,
          `<p>Alguien empezó a crear su empresa y no terminó.</p>
           <p><b>Se quedó en:</b> ${esc(v.stepLabel)} (${v.answers} respuestas)</p>
           ${v.businessName ? `<p><b>Negocio:</b> ${esc(v.businessName)}${v.businessType ? ` · ${esc(v.businessType)}` : ''}</p>` : ''}
           ${v.description ? `<p><b>Lo que contó:</b> ${esc(v.description)}</p>` : ''}
           <p><b>Contacto:</b> ${esc(v.contactName ?? '')} ${esc(v.email ?? '')} ${esc(v.phone ?? '')}${wa}</p>
           ${v.errors.length ? `<p><b>Errores que vio:</b> ${v.errors.map((e: any) => esc(e.message)).join(' · ')}</p>` : ''}
           <p>Míralo en Plataforma → Registros.</p>`,
        );
        await this.tracker.markNotified(s.id);
      } catch (err: any) {
        this.logger.warn(`aviso de abandono no enviado: ${err.message}`);
      }
    }
  }

  async notifyNewCompany(companyId: string) {
    const status = await this.statusFor(companyId);
    const ob = status.onboarding;
    const wa = whatsappDigits(ob.phone);
    const pending = status.checklist.items.filter((i) => !i.done);
    const ready = status.checklist.items.filter((i) => i.done);
    const label = ob.businessType || RUBRO_CONFIG[status.rubro as Rubro]?.label || status.rubro;
    const li = (items: string[]) => `<ul style="margin:0 0 12px;padding-left:18px">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    const interview = Array.isArray(ob.interview) && ob.interview.length
      ? ob.interview.map((m: any) => `<p style="margin:0 0 6px"><b>${m.role === 'assistant' ? 'IA' : 'Dueño'}:</b> ${esc(m.content)}</p>`).join('')
      : `<p style="margin:0">${esc(String(ob.description ?? '').slice(0, 1200))}</p>`;
    const body = `
      <p style="margin:0 0 12px">Se registró una empresa nueva desde la web:</p>
      <h2 style="margin:0 0 4px;font-size:22px">${esc(status.company.name)}</h2>
      <p style="margin:0 0 16px;color:#555">${esc(label)} · plan de ${esc(RUBRO_CONFIG[status.rubro as Rubro]?.label ?? status.rubro)}${status.company.city ? ` · ${esc(status.company.city)}` : ''}</p>
      <p style="margin:0 0 4px"><b>Contacto:</b> ${esc(ob.contactName)} · ${esc(status.company.contactEmail)}</p>
      <p style="margin:0 0 16px"><b>WhatsApp:</b> ${esc(ob.phone)}${wa ? ` · <a href="https://wa.me/${wa}">escribirle</a>` : ''}</p>
      ${Array.isArray(ob.needs) && ob.needs.length ? `<p style="margin:0 0 6px"><b>Lo que necesita:</b></p>${li(ob.needs.map((n: any) => `${n.title} → ${n.solution}`))}` : ''}
      ${Array.isArray(ob.modules) && ob.modules.length ? `<p style="margin:0 0 6px"><b>Herramientas que eligió:</b> ${esc(ob.modules.join(', '))}</p>` : ''}
      <p style="margin:0 0 6px"><b>Falta configurar (${pending.length}):</b></p>${li(pending.map((i) => i.label))}
      ${ready.length ? `<p style="margin:0 0 6px"><b>Ya quedó listo con IA:</b></p>${li(ready.map((i) => i.label))}` : ''}
      <p style="margin:0 0 6px"><b>Entrevista:</b></p>
      <div style="margin:0 0 12px;padding:8px 12px;border-left:3px solid #1a1a1a;color:#333">${interview}</div>
      <p style="margin:0;color:#555">Ábrela en Plataforma → Empresas para terminar de configurarla.</p>`;
    await this.sendToTeam(`Nueva empresa: ${status.company.name} (${label}) — faltan ${pending.length} pasos`, body);
  }

  /* ── 3. Primeros pasos (empresa) ───────────────────────────────── */

  private companyIdOf(user: AuthUser, companyId?: string): string {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  async statusFor(companyId: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const modules = parseJson<string[]>(company.modulesJson, []);
    const rubro: string = ob.rubro
      ?? (modules.includes('production') || modules.includes('delivery') ? 'COMIDAS' : modules.includes('media') ? 'WEBCAM' : modules.includes('orders') ? 'VENTAS' : 'SERVICIOS');
    const [products, bots, connectedLines, plans] = await Promise.all([
      this.prisma.product.count({ where: { companyId, active: true, ...NOT_DELETED } }),
      this.prisma.bot.count({ where: { companyId } }),
      this.prisma.integration.count({ where: { companyId, status: 'CONNECTED' } }),
      this.prisma.plan.findMany({ where: { active: true, line: rubro }, orderBy: { sortOrder: 'asc' } }),
    ]);
    const pay = parseJson<Record<string, any>>(company.paymentConfigJson, {});
    const checklist = onboardingChecklist({
      rubro, company, products, bots, connectedLines,
      hasPayments: !!(pay.publicKey || pay.manualInstructions || pay.acceptCash),
      requestedPlan: !!ob.requestedPlan,
    });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const chatUsed = ob.chat?.day === today ? Number(ob.chat.count) || 0 : 0;
    return {
      company: {
        id: company.id, name: company.name, slug: company.slug, status: company.status, city: company.city,
        contactEmail: company.contactEmail, planId: company.planId,
      },
      rubro,
      rubroLabel: RUBRO_CONFIG[rubro as Rubro]?.label ?? rubro,
      onboarding: ob,
      checklist,
      plans: plans.map((p) => ({
        id: p.id, code: p.code, name: p.name, priceMonthly: p.priceMonthly, currency: p.currency,
        annualPrice: p.priceMonthly * ANNUAL_MONTHS_CHARGED, highlight: p.highlight,
        minTermMonths: p.minTermMonths, features: parseJson<string[]>(p.featuresJson, []),
      })),
      requestedPlan: ob.requestedPlan ?? null,
      chatLeft: Math.max(0, CHAT_DAILY_CAP - chatUsed),
      // Preguntas de su equipo con opciones de SU tipo de negocio (no de restaurante)
      profile: (() => { const p = profileOfCompany(ob, rubro); return { key: p.key, label: p.label, roles: p.roles, pains: p.pains }; })(),
      team: ob.team ?? null,
    };
  }

  /** Respuestas cortas sobre su equipo (primeros pasos del panel). Se guardan paso a paso. */
  async saveTeam(user: AuthUser, dto: any, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const clean = (v: unknown, max = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map((x) => clean(x)).filter(Boolean))].slice(0, 12) : []);
    const prev = ob.team ?? {};
    const team = {
      ...prev,
      ...(dto?.size !== undefined ? { size: TEAM_SIZES.includes(dto.size) ? dto.size : prev.size ?? null } : {}),
      ...(dto?.roles !== undefined ? { roles: list(dto.roles) } : {}),
      ...(dto?.whatsappBy !== undefined ? { whatsappBy: clean(dto.whatsappBy) } : {}),
      ...(dto?.pains !== undefined ? { pains: list(dto.pains) } : {}),
      ...(dto?.done ? { doneAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.prisma.company.update({ where: { id }, data: { onboardingJson: JSON.stringify({ ...ob, team }) } });
    if (dto?.done) {
      await this.audit.log({ actor: user, companyId: id, action: 'onboarding.team', entity: 'Company', entityId: id, detail: `${team.size ?? '?'} personas · ${(team.roles ?? []).join(', ')}` });
    }
    return team;
  }

  async status(user: AuthUser, companyId?: string) {
    return this.statusFor(this.companyIdOf(user, companyId));
  }

  /** IA de acompañamiento: guía la configuración con el estado real de la empresa. */
  async chat(user: AuthUser, dto: { messages?: Array<{ role: string; content: string }> }, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const st = await this.statusFor(id);
    if (st.chatLeft <= 0) {
      throw new BadRequestException('Llegaste al límite de mensajes de hoy. Mañana seguimos, o escríbenos por WhatsApp.');
    }
    const history = (Array.isArray(dto?.messages) ? dto.messages : [])
      .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
      .slice(-12)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 1000) }));
    if (!history.length || history[history.length - 1].role !== 'user') throw new BadRequestException('Escribe tu pregunta');
    const pending = st.checklist.items.filter((i) => !i.done).map((i) => `- ${i.label} (en el menú: ${i.place})`).join('\n') || '- Nada: todo listo';
    const done = st.checklist.items.filter((i) => i.done).map((i) => `- ${i.label}`).join('\n') || '- Aún nada';
    const plans = st.plans.map((p) => `- ${p.name}: desde $${p.priceMonthly.toLocaleString('es-CO')} al mes (anual $${p.annualPrice.toLocaleString('es-CO')}, 2 meses gratis)${p.minTermMonths ? `, montaje gratis con permanencia de ${p.minTermMonths} meses` : ''}`).join('\n');
    const result = await this.pool.chat({
      temperature: 0.4,
      maxTokens: 700,
      deadlineMs: 25_000,
      messages: [
        {
          role: 'system',
          content:
            `Eres la guía de configuración de BackOffice y acompañas a "${st.company.name}" (rubro: ${st.rubroLabel}). ` +
            'BackOffice atiende el WhatsApp del negocio con un asistente IA que responde, vende, toma pedidos o agenda citas, y le da al dueño un panel con todo.\n' +
            `Avance: ${st.checklist.done} de ${st.checklist.total} pasos.\nListo:\n${done}\nPendiente:\n${pending}\n` +
            `Planes de su rubro (COP, IVA incluido, precio "desde"; el valor final lo confirma el equipo):\n${plans}\n` +
            'Hay dos formas de pagar la IA: "Tu IA" (la pagan directo al proveedor) o "Todo incluido" (la cobramos a fin de mes junto con la mensualidad). Reactivación de clientes, cobranza y auditor de ventas vienen en todos los planes.\n' +
            'Reglas: respuestas cortas (máx. 5 líneas), cálidas, en español colombiano, sin tecnicismos. Texto plano: sin markdown, sin asteriscos, sin emojis y sin rutas ni enlaces; nombra la sección del menú como aparece arriba. ' +
            'Lo técnico (conectar el WhatsApp, la inteligencia artificial y las plantillas de Meta) NO lo hace el cliente: lo hace un agente de BackOffice en una llamada. Cuando pregunten por algo técnico, invítalos a tocar el botón "Agéndame con un agente". Nunca le pidas llaves ni que entre a otras páginas. ' +
            'Nunca pidas contraseñas, tarjetas ni datos bancarios. No inventes funciones, precios ni descuentos. Si preguntan algo ajeno a su negocio o a BackOffice, redirige con amabilidad.',
        },
        ...history,
      ],
    });
    // Cupo diario por empresa (protege las llaves genéricas)
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
    const count = ob.chat?.day === today ? (Number(ob.chat.count) || 0) + 1 : 1;
    await this.prisma.company.update({ where: { id }, data: { onboardingJson: JSON.stringify({ ...ob, chat: { day: today, count } }) } });
    return { reply: result.content.trim(), chatLeft: Math.max(0, CHAT_DAILY_CAP - count) };
  }

  /** La empresa elige plan: queda registrado y el equipo recibe el aviso. */
  async requestPlan(user: AuthUser, dto: { planId?: string; billingCycle?: string }, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const plan = await this.prisma.plan.findUnique({ where: { id: String(dto?.planId ?? '') } });
    if (!plan || !plan.active) throw new BadRequestException('Ese plan no está disponible');
    const cycle = dto?.billingCycle === 'ANNUAL' ? 'ANNUAL' : 'MONTHLY';
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const requestedPlan = {
      planId: plan.id, name: plan.name, priceMonthly: plan.priceMonthly, billingCycle: cycle,
      amount: cycle === 'ANNUAL' ? plan.priceMonthly * ANNUAL_MONTHS_CHARGED : plan.priceMonthly,
      at: new Date().toISOString(), by: user.name,
    };
    await this.prisma.company.update({ where: { id }, data: { onboardingJson: JSON.stringify({ ...ob, requestedPlan }) } });
    await this.audit.log({
      actor: user, companyId: id, action: 'signup.plan_request', entity: 'Plan', entityId: plan.id,
      detail: `${plan.name} · ${cycle === 'ANNUAL' ? 'anual' : 'mensual'}`,
    });
    const wa = whatsappDigits(ob.phone ?? company.contactPhone);
    try {
      await this.sendToTeam(
        `${company.name} eligió el plan ${plan.name} (${cycle === 'ANNUAL' ? 'anual' : 'mensual'})`,
        `<p><b>${esc(company.name)}</b> eligió el plan <b>${esc(plan.name)}</b> en pago ${cycle === 'ANNUAL' ? 'anual' : 'mensual'}:
          $${requestedPlan.amount.toLocaleString('es-CO')} (IVA incluido).</p>
          <p>Contacto: ${esc(ob.contactName ?? '')} · ${esc(company.contactEmail ?? '')}${wa ? ` · <a href="https://wa.me/${wa}">WhatsApp</a>` : ''}</p>
          <p>Asígnale el plan en Plataforma → Empresas → ${esc(company.name)} y actívala cuando pague.</p>`,
      );
    } catch (err: any) {
      this.logger.warn(`aviso de plan no enviado: ${err.message}`);
    }
    return { ok: true, requestedPlan };
  }

  /* ── Plataforma: cadena de modelos de la IA del registro ─────────── */

  /** Todo lo que necesita Dev Tools para elegir y ordenar modelos. */
  async aiChain() {
    const [{ entries, custom }, stats, catalog, status, account] = await Promise.all([
      this.pool.chain(), this.pool.stats(), this.pool.backup.configured() ? this.pool.backup.catalog() : Promise.resolve({ models: [], ranked: [] }),
      this.pool.status(), this.pool.backup.configured() ? this.pool.backup.account() : Promise.resolve(null),
    ]);
    const meta = new Map(catalog.models.map((m) => [m.id, m]));
    const availability = await Promise.all(entries.map((e) => this.pool.availability(e)));
    const rows = entries.map((e, i) => {
      const s = stats[chainId(e)];
      const m = e.provider === 'OPENROUTER' ? meta.get(e.model) : undefined;
      return {
        ...e,
        id: chainId(e),
        name: m?.name ?? e.model,
        context: m?.context ?? null,
        description: m?.description ?? (e.provider === 'GEMINI' ? 'Google Gemini con las llaves genéricas (rotan solas).' : ''),
        inCatalog: e.provider === 'GEMINI' || !catalog.models.length || meta.has(e.model),
        availability: availability[i],
        calls: s ? s.ok + s.fail : 0,
        successRate: s && s.ok + s.fail ? Math.round((s.ok / (s.ok + s.fail)) * 100) : null,
        avgSeconds: s && s.ok ? Math.round(s.totalMs / s.ok / 100) / 10 : null,
        lastError: s?.lastError ?? null,
        lastAt: s?.lastAt ?? null,
        bench: s?.bench ?? null,
      };
    });
    const inChain = new Set(entries.map((e) => chainId(e)));
    const suggestions = catalog.ranked
      .filter((id) => !inChain.has(`OPENROUTER:${id}`))
      .map((id) => ({ provider: 'OPENROUTER' as const, model: id, name: meta.get(id)?.name ?? id, context: meta.get(id)?.context ?? null, bench: stats[`OPENROUTER:${id}`]?.bench ?? null }));
    return {
      custom,
      entries: rows,
      suggestions,
      capacity: {
        gemini: status.keys,
        openrouter: { configured: this.pool.backup.configured(), keys: status.backup.keys, account },
      },
    };
  }

  async saveAiChain(actor: AuthUser, dto: { entries?: unknown }) {
    const entries = await this.pool.saveChain(dto?.entries);
    await this.audit.log({
      actor, action: 'signup.ai_chain', entity: 'PlatformSetting', entityId: 'SIGNUP_AI_CHAIN',
      detail: entries.filter((e) => e.enabled).map((e) => e.model).join(' → ').slice(0, 300),
    });
    return this.aiChain();
  }

  async resetAiChain(actor: AuthUser, dto: { stats?: boolean }) {
    await this.pool.saveChain([]);
    if (dto?.stats) await this.pool.resetStats();
    await this.audit.log({ actor, action: 'signup.ai_chain_reset', entity: 'PlatformSetting', entityId: 'SIGNUP_AI_CHAIN', detail: dto?.stats ? 'orden y estadísticas' : 'orden' });
    return this.aiChain();
  }

  /** Prueba uno, varios o todos (los de la cadena + sugeridos pedidos). */
  async testAiChain(dto: { ids?: unknown }) {
    const { entries } = await this.pool.chain();
    const wanted = Array.isArray(dto?.ids) ? dto.ids.map(String).slice(0, 20) : entries.map((e) => chainId(e));
    const targets: Array<Pick<ChainEntry, 'provider' | 'model'>> = wanted
      .map((id) => {
        const [provider, ...rest] = id.split(':');
        return { provider: provider as ChainEntry['provider'], model: rest.join(':') };
      })
      .filter((e) => (e.provider === 'GEMINI' || e.provider === 'OPENROUTER') && e.model);
    if (!targets.length) throw new BadRequestException('Elige al menos un modelo para probar');
    const results = await benchMany(this.pool, targets, 4);
    return { results: results.sort((a, b) => b.score - a.score || a.seconds - b.seconds), chain: await this.aiChain() };
  }

  /* ── Plataforma ────────────────────────────────────────────────── */

  async recentSignups() {
    const rows = await this.prisma.company.findMany({
      where: { onboardingJson: { contains: '"source":"SIGNUP"' } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const out: any[] = [];
    for (const c of rows) {
      const st = await this.statusFor(c.id);
      out.push({
        id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, rubroLabel: st.rubroLabel,
        contactName: st.onboarding.contactName, phone: st.onboarding.phone, whatsapp: whatsappDigits(st.onboarding.phone),
        percent: st.checklist.percent, pending: st.checklist.items.filter((i) => !i.done).map((i) => i.label),
        requestedPlan: st.requestedPlan,
      });
    }
    return out;
  }
}

/** De dónde llegó y desde qué dispositivo (sin IP ni datos personales). */
function requestMeta(req: any) {
  return {
    referrer: String(req?.body?.referrer ?? req?.headers?.referer ?? '').slice(0, 200) || undefined,
    userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 200) || undefined,
    // Campaña (ej. Meta Ads con ?utm_source=facebook&utm_campaign=…)
    utmSource: typeof req?.body?.utmSource === 'string' ? req.body.utmSource : undefined,
    utmCampaign: typeof req?.body?.utmCampaign === 'string' ? req.body.utmCampaign : undefined,
  };
}

@Controller()
export class SignupController {
  constructor(private readonly signup: SignupService) {}

  @Public()
  @Throttle({ default: { ttl: 10 * 60_000, limit: 40 } })
  @Post('public/signup/interview')
  interview(@Body() dto: any, @Req() req: any) {
    return this.signup.interview(dto, requestMeta(req));
  }

  @Public()
  @Throttle({ default: { ttl: 10 * 60_000, limit: 80 } })
  @Post('public/signup/track')
  track(@Body() dto: any, @Req() req: any) {
    return this.signup.track(dto, requestMeta(req));
  }

  @Public()
  @Throttle({ default: { ttl: 10 * 60_000, limit: 6 } })
  @Post('public/signup/preview')
  preview(@Body() dto: any) {
    return this.signup.preview(dto);
  }

  @Public()
  @Throttle({ default: { ttl: 10 * 60_000, limit: 3 } })
  @Post('public/signup')
  register(@Body() dto: any) {
    return this.signup.register(dto);
  }

  @Get('onboarding')
  status(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.signup.status(user, companyId);
  }

  @Post('onboarding/chat')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  chat(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.signup.chat(user, dto, companyId ?? dto?.companyId);
  }

  @Post('onboarding/team')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  saveTeam(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.signup.saveTeam(user, dto, companyId);
  }

  @Post('onboarding/request-plan')
  @Roles(ROLES.COMPANY_ADMIN)
  requestPlan(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.signup.requestPlan(user, dto);
  }

  @Get('onboarding/signups')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  signups() {
    return this.signup.recentSignups();
  }

  @Get('onboarding/ai-status')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  aiStatus() {
    return this.signup.pool.status();
  }

  @Get('onboarding/registros')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  registros(@Query('state') state?: string, @Query('days') days?: string) {
    return this.signup.tracker.list({ state, days: Number(days) || 30 });
  }

  @Get('onboarding/registros/summary')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  registrosSummary() {
    return this.signup.tracker.summary();
  }

  @Patch('onboarding/registros/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  follow(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.signup.tracker.follow(user, id, dto ?? {});
  }

  @Get('onboarding/ai-chain')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  aiChain() {
    return this.signup.aiChain();
  }

  @Post('onboarding/ai-chain')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  saveAiChain(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.signup.saveAiChain(user, dto);
  }

  @Post('onboarding/ai-chain/reset')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  resetAiChain(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.signup.resetAiChain(user, dto);
  }

  @Post('onboarding/ai-chain/test')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  @Throttle({ default: { ttl: 60_000, limit: 4 } })
  testAiChain(@Body() dto: any) {
    return this.signup.testAiChain(dto);
  }
}

@Module({
  imports: [AuthModule, AuditModule, EmailsModule, CompaniesModule],
  controllers: [SignupController],
  providers: [SignupService],
})
export class SignupModule {}
