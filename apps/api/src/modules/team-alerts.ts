/**
 * Avisos al celular del equipo (Telegram).
 *
 * Por qué Telegram: es gratis, llega al instante a cualquier teléfono y no
 * exige plantillas aprobadas como WhatsApp para mensajes que inicia el negocio.
 *
 * Configuración (Plataforma → Registros → Avisos a tu celular):
 *  1. Se crea un bot con @BotFather y se pega su token (se guarda cifrado).
 *  2. Se le escribe cualquier cosa al bot y «Vincular» detecta el chat.
 *  3. Se eligen qué avisos llegan.
 *
 * Un aviso que falla NUNCA rompe lo que lo disparó (registro, login, conexión).
 */
import { BadRequestException, Body, Controller, Delete, Get, Global, Injectable, Logger, Module, Post, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';

export const ALERT_EVENTS = {
  SIGNUP_CONTACT: 'Alguien empezó el registro y dejó su WhatsApp',
  SIGNUP_DONE: 'Alguien terminó el registro (empresa nueva)',
  SIGNUP_ABANDONED: 'Alguien dejó el registro a mitad (30 min sin volver)',
  CLIENT_LOGIN: 'Un cliente inició sesión',
  ADS_CONNECTED: 'Un cliente conectó su cuenta publicitaria',
} as const;
export type AlertEvent = keyof typeof ALERT_EVENTS;

const TOKEN_KEY = 'TELEGRAM_ALERTS_BOT_TOKEN';
const CFG_KEY = 'TEAM_ALERTS';
/** Mismo cliente que vuelve a entrar: un aviso por hora como mucho. */
const LOGIN_QUIET_MS = 60 * 60e3;

interface AlertsConfig {
  chatId?: string;
  chatName?: string;
  botName?: string;
  events?: Partial<Record<AlertEvent, boolean>>;
}

export interface AlertsStatus {
  configured: boolean;
  botName: string | null;
  botLink: string | null;
  linked: boolean;
  chatName: string | null;
  events: Record<AlertEvent, boolean>;
  labels: typeof ALERT_EVENTS;
  lastSent: { at: string; event: AlertEvent; ok: boolean; error?: string } | null;
}

/** Escapa para el modo HTML de Telegram. */
export const tg = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));

/** wa.me con un saludo listo para mandar (solo dígitos; Colombia por defecto). */
export function waLink(phone: unknown, text?: string): string | null {
  let d = String(phone ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) d = `57${d}`;
  if (d.length < 11 || d.length > 15) return null;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

@Injectable()
export class TeamAlertsService {
  private readonly logger = new Logger('TeamAlerts');
  private lastSent: AlertsStatus['lastSent'] = null;
  private recentLogins = new Map<string, number>();

  /** Reemplazables en pruebas. */
  fetchImpl: (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }> = (u, i) => fetch(u, i) as any;
  now: () => number = () => Date.now();

  constructor(private readonly prisma: PrismaService) {}

  private async setting(key: string) {
    return (await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
  }

  private async put(key: string, value: string) {
    await this.prisma.platformSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  }

  private async token(): Promise<string | null> {
    const raw = (await this.setting(TOKEN_KEY))?.trim() || process.env[TOKEN_KEY]?.trim() || '';
    if (!raw) return null;
    try {
      return isEncrypted(raw) ? decryptSecret(raw) : raw;
    } catch {
      return null;
    }
  }

  private async config(): Promise<AlertsConfig> {
    return parseJson<AlertsConfig>(await this.setting(CFG_KEY), {});
  }

  private async api(token: string, method: string, body?: Record<string, unknown>) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8_000),
    });
    const data = await res.json().catch(() => ({}));
    // El token va en la URL: nunca se repite en los errores
    if (!data?.ok) throw new Error(String(data?.description ?? `Telegram respondió ${res.status}`).slice(0, 160));
    return data.result;
  }

  async status(): Promise<AlertsStatus> {
    const cfg = await this.config();
    const token = await this.token();
    const events = Object.fromEntries(Object.keys(ALERT_EVENTS).map((k) => [k, cfg.events?.[k as AlertEvent] ?? true])) as Record<AlertEvent, boolean>;
    return {
      configured: !!token, botName: cfg.botName ?? null, botLink: cfg.botName ? `https://t.me/${cfg.botName}` : null,
      linked: !!(token && cfg.chatId), chatName: cfg.chatName ?? null, events, labels: ALERT_EVENTS, lastSent: this.lastSent,
    };
  }

  /** Paso 1: el token del bot de @BotFather. Se comprueba con Telegram antes de guardarlo. */
  async saveToken(raw: unknown): Promise<AlertsStatus> {
    const token = String(raw ?? '').trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/.test(token)) throw new BadRequestException('Ese no parece un token de @BotFather (se ve como 123456789:ABC…).');
    let me: any;
    try {
      me = await this.api(token, 'getMe');
    } catch (e: any) {
      throw new BadRequestException(`Telegram no aceptó el token: ${e.message}`);
    }
    await this.put(TOKEN_KEY, encryptSecret(token));
    // Bot nuevo: el chat vinculado al anterior ya no sirve
    await this.put(CFG_KEY, JSON.stringify({ ...(await this.config()), botName: me?.username ?? null, chatId: undefined, chatName: undefined }));
    return this.status();
  }

  /** Paso 2: después de escribirle al bot, se toma el último chat privado que le habló. */
  async link(): Promise<AlertsStatus> {
    const token = await this.token();
    if (!token) throw new BadRequestException('Primero pega el token del bot.');
    const updates: any[] = await this.api(token, 'getUpdates', { limit: 50, allowed_updates: ['message'] }).catch((e) => {
      throw new BadRequestException(`No se pudo leer el bot: ${e.message}`);
    });
    const chat = [...(updates ?? [])].reverse().map((u) => u?.message?.chat).find((c) => c?.type === 'private');
    if (!chat) throw new BadRequestException('Todavía no le escribiste al bot. Ábrelo en Telegram, toca «Iniciar» y vuelve a intentar.');
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'tu Telegram';
    await this.put(CFG_KEY, JSON.stringify({ ...(await this.config()), chatId: String(chat.id), chatName: name }));
    await this.api(token, 'sendMessage', { chat_id: chat.id, text: 'Listo: desde ahora te aviso aquí lo importante de BackOffice.' }).catch(() => undefined);
    return this.status();
  }

  async setEvents(raw: unknown): Promise<AlertsStatus> {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const events = Object.fromEntries(Object.keys(ALERT_EVENTS).filter((k) => k in input).map((k) => [k, input[k] === true]));
    const cfg = await this.config();
    await this.put(CFG_KEY, JSON.stringify({ ...cfg, events: { ...cfg.events, ...events } }));
    return this.status();
  }

  async disconnect(): Promise<AlertsStatus> {
    await this.prisma.platformSetting.deleteMany({ where: { key: TOKEN_KEY } });
    const { chatId: _c, chatName: _n, botName: _b, ...rest } = await this.config();
    await this.put(CFG_KEY, JSON.stringify(rest));
    return this.status();
  }

  async test(): Promise<AlertsStatus> {
    const ok = await this.send('SIGNUP_DONE', '<b>Prueba</b>\nAsí te van a llegar los avisos de BackOffice.', undefined, true);
    if (!ok) throw new BadRequestException(this.lastSent?.error ? `No se pudo enviar: ${this.lastSent.error}` : 'Falta vincular tu Telegram.');
    return this.status();
  }

  /**
   * Envía un aviso. Devuelve false si no está configurado, el evento está
   * apagado o Telegram falló; jamás lanza.
   */
  async send(event: AlertEvent, html: string, button?: { text: string; url: string | null }, force = false): Promise<boolean> {
    try {
      const token = await this.token();
      const cfg = await this.config();
      if (!token || !cfg.chatId) return false;
      if (!force && cfg.events?.[event] === false) return false;
      await this.api(token, 'sendMessage', {
        chat_id: cfg.chatId, text: html.slice(0, 3800), parse_mode: 'HTML', disable_web_page_preview: true,
        ...(button?.url ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
      });
      this.lastSent = { at: new Date(this.now()).toISOString(), event, ok: true };
      return true;
    } catch (e: any) {
      this.lastSent = { at: new Date(this.now()).toISOString(), event, ok: false, error: String(e?.message ?? e).slice(0, 160) };
      this.logger.warn(`aviso ${event} no enviado: ${this.lastSent.error}`);
      return false;
    }
  }

  /** Un cliente (usuario de una empresa) inició sesión. El equipo de plataforma no avisa. */
  async clientLogin(user: { id: string; name?: string | null; email?: string | null; companyId?: string | null; createdAt?: Date | null; company?: { name?: string | null } | null }, previousLoginAt: Date | null) {
    if (!user.companyId) return;
    // El primer ingreso justo al terminar el registro ya llegó como «empresa nueva»
    if (!previousLoginAt && user.createdAt && this.now() - new Date(user.createdAt).getTime() < 15 * 60e3) return;
    const last = this.recentLogins.get(user.id) ?? 0;
    if (this.now() - last < LOGIN_QUIET_MS) return;
    this.recentLogins.set(user.id, this.now());
    if (this.recentLogins.size > 2000) this.recentLogins.clear();
    const since = previousLoginAt ? Math.round((this.now() - previousLoginAt.getTime()) / 86400e3) : null;
    const when = since === null ? 'primera vez' : since === 0 ? 'ya había entrado hoy' : `última vez hace ${since} ${since === 1 ? 'día' : 'días'}`;
    await this.send('CLIENT_LOGIN', `<b>Inició sesión</b> ${tg(user.name ?? user.email)}\n${tg(user.company?.name ?? 'Empresa')} · ${when}`);
  }
}

@Controller('platform/alerts')
export class TeamAlertsController {
  constructor(private readonly alerts: TeamAlertsService) {}

  @Get() @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  status() { return this.alerts.status(); }

  @Put('telegram') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  saveToken(@Body() dto: { token?: unknown }) { return this.alerts.saveToken(dto?.token); }

  @Post('telegram/link') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  link() { return this.alerts.link(); }

  @Delete('telegram') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  disconnect(@CurrentUser() _u: AuthUser) { return this.alerts.disconnect(); }

  @Put('events') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  events(@Body() dto: { events?: unknown }) { return this.alerts.setEvents(dto?.events); }

  @Post('test') @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  test() { return this.alerts.test(); }
}

@Global()
@Module({
  controllers: [TeamAlertsController],
  providers: [TeamAlertsService],
  exports: [TeamAlertsService],
})
export class TeamAlertsModule {}
