import { assertSchedulable, policyOf, resetApproval } from '../common/creative-guard';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ensureFile, mirrorFile } from '../common/file-store';
import { Cron } from '@nestjs/schedule';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret, isEncrypted } from '../common/crypto';
import { publicWebUrl } from '../common/tracking';
import { periodOf } from '../common/billing-engine';
import {
  CREDIT_COST, addSocialCost, refundCredits, reserveCredits, socialAddon, socialDefaults, socialUsage,
} from '../common/social-addon';
import {
  MetaError, containerStatus, createInstagramContainer, exchangeCode, inspectPage, listPages, oauthUrl,
  publishFacebook, publishInstagramContainer, signState, verifyState, type FetchLike, type MetaPage,
} from '../common/meta-publish';
import { Aspect, generateImage, imageConfig } from '../ai/media-gen';
import { GeminiPool } from '../ai/gemini-pool';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { platformAiKey } from '../ai/ai-access';
import { extractJson } from '../ai/types';
import { AuditService } from './audit.module';
import { EmailsModule, EmailsService } from './emails.module';
import { usdCopRate } from '../common/trm';

/**
 * Extra "Redes sociales con IA": imágenes generadas (las paga BackOffice, con
 * créditos del mes), copy y plan del mes con IA, conexión con la página de
 * Facebook / Instagram de la empresa y publicación programada (cron por minuto).
 */

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const TARGETS = ['facebook', 'instagram'] as const;
const DAY_MS = 86400e3;

type Connection = {
  integrationId: string;
  pageId: string;
  pageName: string;
  igUserId: string | null;
  igUsername: string | null;
  token: string | null;
  sandbox: boolean;
  method: string;
  pendingPages?: Array<Omit<MetaPage, 'accessToken'>>;
};

@Injectable()
export class SocialService {
  private readonly logger = new Logger('Social');
  private readonly pool: GeminiPool;
  /** Inyectable en pruebas: nada sale a internet. */
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly emails?: EmailsService,
  ) {
    this.pool = new GeminiPool(prisma);
  }

  private companyOf(user: AuthUser, companyId?: string): string {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  private async company(id: string) {
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    return c;
  }

  private async assertAddon(companyId: string) {
    const company = await this.company(companyId);
    const addon = socialAddon(company, await socialDefaults(this.prisma));
    if (!addon.enabled) {
      throw new ForbiddenException('El extra «Redes sociales con IA» no está activo para tu empresa. Pídelo desde Marketing.');
    }
    return { company, addon };
  }

  private async piece(user: AuthUser, id: string) {
    const p = await this.prisma.contentPiece.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pieza no encontrada');
    if (!isPlatformRole(user.role) && p.companyId !== user.companyId) throw new ForbiddenException();
    return p;
  }

  /* ── Estado del extra ── */

  async connection(companyId: string): Promise<Connection | null> {
    const row = await this.prisma.integration.findFirst({ where: { companyId, type: 'META_SOCIAL' } });
    if (!row) return null;
    const cfg = parseJson<Record<string, any>>(row.configJson, {});
    let token: string | null = null;
    if (isEncrypted(cfg.accessTokenEnc)) {
      try {
        token = decryptSecret(cfg.accessTokenEnc);
      } catch {
        token = null;
      }
    }
    return {
      integrationId: row.id, pageId: cfg.pageId ?? '', pageName: cfg.pageName ?? '', igUserId: cfg.igUserId ?? null,
      igUsername: cfg.igUsername ?? null, token, sandbox: cfg.sandbox === true || !token, method: cfg.method ?? 'MANUAL',
      pendingPages: Array.isArray(cfg.pendingPages) ? cfg.pendingPages.map(({ accessTokenEnc: _t, ...p }: any) => p) : undefined,
    };
  }

  private async metaApp() {
    const rows = await this.prisma.platformSetting.findMany({ where: { key: { in: ['META_APP_ID', 'META_APP_SECRET'] } } });
    const get = (k: string) => rows.find((r) => r.key === k)?.value?.trim() || process.env[k] || '';
    return { appId: get('META_APP_ID'), appSecret: get('META_APP_SECRET') };
  }

  async status(user: AuthUser, companyId?: string) {
    const id = this.companyOf(user, companyId);
    const company = await this.company(id);
    const defaults = await socialDefaults(this.prisma);
    const addon = socialAddon(company, defaults);
    const [usage, conn, app, img] = await Promise.all([socialUsage(this.prisma, id), this.connection(id), this.metaApp(), imageConfig(this.prisma)]);
    return {
      addon,
      defaults,
      usage: { ...usage, left: Math.max(0, addon.credits - usage.credits) },
      creditCost: CREDIT_COST,
      usdCop: await usdCopRate(this.prisma),
      imageProvider: img.provider,
      oauthAvailable: !!(app.appId && app.appSecret),
      connection: conn
        ? {
            connected: !!conn.pageId, pageId: conn.pageId, pageName: conn.pageName, igUsername: conn.igUsername,
            hasInstagram: !!conn.igUserId, sandbox: conn.sandbox, method: conn.method, pendingPages: conn.pendingPages ?? null,
          }
        : null,
      requested: !!parseJson<Record<string, any>>(company.addonsJson, {}).social?.requestedAt,
    };
  }

  /** La empresa pide el extra: le llega al equipo. */
  async requestAddon(user: AuthUser, companyId?: string) {
    const id = this.companyOf(user, companyId);
    const company = await this.company(id);
    const addons = parseJson<Record<string, any>>(company.addonsJson, {});
    await this.prisma.company.update({
      where: { id },
      data: { addonsJson: JSON.stringify({ ...addons, social: { ...(addons.social ?? {}), requestedAt: new Date().toISOString(), requestedBy: user.name } }) },
    });
    await this.audit.log({ actor: user, companyId: id, action: 'addon.request', entity: 'Company', entityId: id, detail: 'Redes sociales con IA' });
    try {
      const row = await this.prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } });
      await this.emails?.systemSend({
        toEmail: row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || 'restrepos591@gmail.com',
        subject: `${company.name} quiere el extra Redes sociales con IA`,
        body: `<p><b>${company.name}</b> pidió activar el extra <b>Redes sociales con IA</b> (lo pidió ${user.name}).</p><p>Actívalo en Plataforma → Empresas → ${company.name} → Cobro → Extras.</p>`,
      });
    } catch (err: any) {
      this.logger.warn(`aviso de extra no enviado: ${err.message}`);
    }
    return { ok: true };
  }

  /* ── IA de texto que paga la plataforma (copy y plan) ── */

  private async platformText(system: string, userMsg: string, maxTokens = 1500): Promise<string> {
    const key = await platformAiKey(this.prisma);
    if (key) {
      const r = await new DeepInfraProvider().chat({
        apiKey: key, model: 'meta-llama/Llama-3.3-70B-Instruct', temperature: 0.8, maxTokens, jsonMode: true,
        messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }],
      });
      return r.content;
    }
    const r = await this.pool.chat({ json: true, temperature: 0.8, maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: userMsg }] });
    return r.content;
  }

  async generateCopy(user: AuthUser, pieceId: string) {
    const piece = await this.piece(user, pieceId);
    const { company } = await this.assertAddon(piece.companyId);
    const raw = await this.platformText(
      `Eres el creativo de redes sociales de ${company.name}${company.industry ? ` (${company.industry})` : ''}. Español de Colombia.
Devuelve SOLO JSON: {"title":"gancho corto","copy":"caption listo para publicar (2-4 líneas, con llamado a la acción)","hashtags":["#...", 5 a 8],"image_prompt":"descripción visual detallada para generar la imagen (sin texto dentro)"}.
Sin promesas falsas ni exceso de emojis.`,
      `Pieza: ${piece.type} para ${parseJson<string[]>(piece.targetsJson, []).join(' y ') || 'Instagram y Facebook'}.\nIdea: ${piece.title}\nBrief: ${piece.brief ?? 'proponlo tú'}`,
      700,
    );
    const parsed = extractJson(raw) as any;
    if (!parsed?.copy) throw new BadRequestException('La IA no devolvió un texto válido, intenta de nuevo');
    const updated = await this.prisma.contentPiece.update({
      where: { id: pieceId },
      data: {
        title: String(parsed.title || piece.title).slice(0, 140),
        copy: String(parsed.copy).slice(0, 2200),
        hashtagsJson: JSON.stringify(Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 10) : []),
        ...(piece.approvedAt ? resetApproval(piece.status) : {}),
        imagePrompt: typeof parsed.image_prompt === 'string' ? parsed.image_prompt.slice(0, 1500) : piece.imagePrompt,
        status: piece.status === 'IDEA' ? 'BORRADOR' : piece.status,
      },
    });
    return serializePiece(updated);
  }

  /* ── Imagen con IA (gasta créditos del mes) ── */

  async generateImage(user: AuthUser, pieceId: string, dto: { prompt?: string; aspect?: Aspect }) {
    const piece = await this.piece(user, pieceId);
    const { company, addon } = await this.assertAddon(piece.companyId);
    const prompt = String(dto?.prompt ?? piece.imagePrompt ?? piece.brief ?? piece.title ?? '').trim();
    if (prompt.length < 8) throw new BadRequestException('Describe la imagen que quieres (mínimo 8 caracteres)');
    const aspect: Aspect = dto?.aspect && ['1:1', '4:5', '9:16'].includes(dto.aspect)
      ? dto.aspect
      : piece.type === 'STORY' || piece.type === 'REEL' ? '9:16' : '4:5';
    const ok = await reserveCredits(this.prisma, company.id, addon.credits, 'image');
    if (!ok) throw new BadRequestException(`Ya usaste los ${addon.credits} créditos de este mes. Se renuevan el 1 del próximo mes.`);
    try {
      const img = await generateImage(this.prisma, { prompt, aspect, brandColor: company.brandColor });
      const dir = join(UPLOADS_DIR, company.id);
      mkdirSync(dir, { recursive: true });
      const file = `contenido-${randomBytes(10).toString('hex')}.${img.ext}`;
      writeFileSync(join(dir, file), img.buffer);
      await mirrorFile(this.prisma, company.id, file, img.buffer, img.mime);
      await addSocialCost(this.prisma, company.id, img.costUsd);
      const updated = await this.prisma.contentPiece.update({
        where: { id: pieceId },
        data: {
          assetFile: file, assetMime: img.mime, imagePrompt: prompt, mediaToken: randomBytes(18).toString('hex'),
          status: ['IDEA', 'BORRADOR'].includes(piece.status) ? 'LISTO' : piece.status,
          // Imagen nueva = contenido nuevo: hay que volver a aprobar
          ...(piece.approvedAt ? resetApproval(piece.status) : {}),
        },
      });
      await this.audit.log({
        actor: user, companyId: company.id, action: 'social.image', entity: 'ContentPiece', entityId: pieceId,
        detail: `${img.provider} ${img.model} · ~US$${img.costUsd.toFixed(4)}`,
      });
      return { ...serializePiece(updated), provider: img.provider };
    } catch (err: any) {
      await refundCredits(this.prisma, company.id, 'image');
      throw new BadRequestException(`No se pudo generar la imagen: ${err.message}`);
    }
  }

  /** Archivo de la pieza para el panel (autenticado). */
  async assetPath(user: AuthUser, pieceId: string) {
    const piece = await this.piece(user, pieceId);
    if (piece.assetFile) await ensureFile(this.prisma, piece.companyId, piece.assetFile);
    return this.fileOf(piece);
  }

  private fileOf(piece: { companyId: string; assetFile: string | null; assetMime: string | null }) {
    if (!piece.assetFile) throw new NotFoundException('La pieza no tiene archivo');
    const base = join(UPLOADS_DIR, piece.companyId);
    const path = join(base, piece.assetFile);
    if (!path.startsWith(base) || !existsSync(path)) throw new NotFoundException('Archivo no encontrado');
    return { path, mime: piece.assetMime ?? 'application/octet-stream' };
  }

  /** Meta descarga el medio por esta URL pública (token aleatorio por pieza). */
  async publicAsset(token: string) {
    if (!/^[a-f0-9]{36}$/.test(token)) throw new NotFoundException();
    const piece = await this.prisma.contentPiece.findFirst({ where: { mediaToken: token } });
    if (!piece) throw new NotFoundException();
    if (piece.assetFile) await ensureFile(this.prisma, piece.companyId, piece.assetFile);
    return this.fileOf(piece);
  }

  /* ── Plan del mes con IA ── */

  async plan(user: AuthUser, dto: any, companyId?: string) {
    const id = this.companyOf(user, companyId);
    const { company } = await this.assertAddon(id);
    const weekdays = (Array.isArray(dto?.weekdays) ? dto.weekdays : []).map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (!weekdays.length) throw new BadRequestException('Elige al menos un día de la semana');
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(dto?.time) ? dto.time : '10:00';
    const count = Math.min(Math.max(Math.round(Number(dto?.count) || 8), 1), 20);
    const topic = String(dto?.topic ?? '').trim().slice(0, 600);
    const targets = (Array.isArray(dto?.targets) ? dto.targets : ['facebook', 'instagram']).filter((t: string) => (TARGETS as readonly string[]).includes(t));
    const start = dto?.startDate && !Number.isNaN(new Date(dto.startDate).getTime()) ? new Date(dto.startDate) : new Date(Date.now() + DAY_MS);
    const dates = nextSlots(start, weekdays, time, count, company.timezone || 'America/Bogota');
    const products = await this.prisma.product.findMany({ where: { companyId: id, active: true }, select: { name: true, price: true }, take: 20 });
    const raw = await this.platformText(
      `Eres el estratega de contenido de ${company.name}${company.industry ? ` (${company.industry})` : ''}${company.city ? ` en ${company.city}` : ''}. Español de Colombia.
Arma un calendario de ${count} publicaciones variadas (producto, detrás de cámaras, testimonio, educativo, promoción) para Instagram y Facebook.
Devuelve SOLO JSON: {"posts":[{"title":"","copy":"caption con llamado a la acción","hashtags":["#..."],"image_prompt":"escena visual detallada, sin texto"}]}.
No inventes precios ni promociones que no estén en los datos.`,
      `Tema o enfoque del mes: ${topic || 'el que mejor venda'}\nProductos/servicios: ${products.map((p) => `${p.name}${p.price ? ` ($${p.price})` : ''}`).join(', ') || 'no hay catálogo cargado'}`,
      3500,
    );
    const posts = ((extractJson(raw) as any)?.posts ?? []).filter((p: any) => p?.title && p?.copy).slice(0, count);
    if (!posts.length) throw new BadRequestException('La IA no armó el plan, intenta de nuevo con otro enfoque');
    const created: any[] = [];
    for (const [i, p] of posts.entries()) {
      created.push(await this.prisma.contentPiece.create({
        data: {
          companyId: id, type: 'POST', status: 'BORRADOR', title: String(p.title).slice(0, 140), brief: topic || null,
          copy: String(p.copy).slice(0, 2200), hashtagsJson: JSON.stringify(Array.isArray(p.hashtags) ? p.hashtags.map(String).slice(0, 10) : []),
          imagePrompt: typeof p.image_prompt === 'string' ? p.image_prompt.slice(0, 1500) : null,
          scheduledAt: dates[i] ?? null, targetsJson: JSON.stringify(targets), channel: targets[0] ?? null,
        },
      }));
    }
    await this.audit.log({ actor: user, companyId: id, action: 'social.plan', entity: 'Company', entityId: id, detail: `${created.length} publicaciones` });
    return { created: created.length, pieces: created.map(serializePiece) };
  }

  /* ── Programar y publicar ── */

  async schedule(user: AuthUser, pieceId: string, dto: { scheduledAt?: string; targets?: string[] }) {
    const piece = await this.piece(user, pieceId);
    await this.assertAddon(piece.companyId);
    const targets = (Array.isArray(dto?.targets) ? dto.targets : parseJson<string[]>(piece.targetsJson, [])).filter((t) => (TARGETS as readonly string[]).includes(t));
    if (!targets.length) throw new BadRequestException('Elige dónde publicar (Facebook, Instagram o ambos)');
    const when = dto?.scheduledAt ? new Date(dto.scheduledAt) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60e3) throw new BadRequestException('La fecha debe ser futura');
    if (!piece.copy?.trim()) throw new BadRequestException('Escribe o genera el texto antes de programar');
    if (targets.includes('instagram') && !piece.assetFile && !piece.assetUrl) {
      throw new BadRequestException('Instagram exige imagen o video: genéralo o súbelo primero');
    }
    const conn = await this.connection(piece.companyId);
    if (!conn?.pageId) throw new BadRequestException('Conecta primero tu página de Facebook / Instagram');
    if (targets.includes('instagram') && !conn.igUserId && !conn.sandbox) {
      throw new BadRequestException('Tu página no tiene una cuenta de Instagram profesional vinculada');
    }
    // Aprobación, redes autorizadas, horario, tope diario y pausa (reglas de la marca)
    await assertSchedulable(this.prisma, piece, when, targets);
    const updated = await this.prisma.contentPiece.update({
      where: { id: pieceId },
      data: { scheduledAt: when, targetsJson: JSON.stringify(targets), status: 'PROGRAMADO', publishError: null, channel: targets[0] },
    });
    return serializePiece(updated);
  }

  async publishNow(user: AuthUser, pieceId: string) {
    const piece = await this.piece(user, pieceId);
    await this.assertAddon(piece.companyId);
    if (piece.status === 'PUBLICADO') throw new BadRequestException('Esta pieza ya se publicó');
    await assertSchedulable(this.prisma, piece, new Date(), parseJson<string[]>(piece.targetsJson, []));
    await this.prisma.contentPiece.update({ where: { id: pieceId }, data: { status: 'PROGRAMADO', scheduledAt: new Date() } });
    return this.publishPiece(pieceId);
  }

  /** Publica en cada destino pendiente. Idempotente: lo ya publicado no se repite. */
  async publishPiece(pieceId: string) {
    // Pausa global de la marca o pieza sin aprobación: no se publica (queda como está)
    const pre = await this.prisma.contentPiece.findUnique({ where: { id: pieceId }, select: { companyId: true, approvedAt: true, status: true } });
    if (!pre) return null;
    if (pre.status === 'PROGRAMADO' && (!pre.approvedAt || (await policyOf(this.prisma, pre.companyId)).paused)) {
      return serializePiece(await this.prisma.contentPiece.findUniqueOrThrow({ where: { id: pieceId } }));
    }
    const claim = await this.prisma.contentPiece.updateMany({
      where: { id: pieceId, status: { in: ['PROGRAMADO', 'PUBLICANDO'] } },
      data: { status: 'PUBLICANDO', publishAttempts: { increment: 1 } },
    });
    if (claim.count === 0) return this.prisma.contentPiece.findUnique({ where: { id: pieceId } });
    const piece = await this.prisma.contentPiece.findUniqueOrThrow({ where: { id: pieceId } });
    const conn = await this.connection(piece.companyId);
    const results = parseJson<Record<string, any>>(piece.publishResultJson, {});
    const targets = parseJson<string[]>(piece.targetsJson, []);
    const caption = [piece.copy ?? piece.title, parseJson<string[]>(piece.hashtagsJson, []).join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
    const kind: 'image' | 'video' | 'none' = piece.assetMime?.startsWith('video') || (!piece.assetFile && piece.assetUrl && /\.mp4|video/i.test(piece.assetUrl))
      ? 'video' : piece.assetFile || piece.assetUrl ? 'image' : 'none';
    const mediaUrl = piece.assetFile && piece.mediaToken
      ? `${(await publicWebUrl(this.prisma)).replace(/\/$/, '')}/api/public/content/${piece.mediaToken}`
      : piece.assetUrl;
    let error: string | null = null;
    let pending = false;
    try {
      if (!conn?.pageId) throw new Error('La página de Facebook / Instagram ya no está conectada');
      if (!conn.sandbox && piece.assetMime === 'image/svg+xml') {
        throw new Error('La imagen es de prueba (proveedor SIMULADO): genera una real antes de publicar');
      }
      for (const target of targets) {
        if (results[target]?.id) continue;
        if (conn.sandbox) {
          results[target] = { id: `prueba-${target}-${Date.now()}`, sandbox: true };
          continue;
        }
        if (target === 'facebook') {
          results.facebook = await publishFacebook({ pageId: conn.pageId, token: conn.token!, message: caption, mediaUrl, kind }, this.fetchImpl);
        } else if (target === 'instagram') {
          if (!conn.igUserId) throw new Error('No hay Instagram profesional vinculado a la página');
          if (kind === 'none' || !mediaUrl) throw new Error('Instagram exige imagen o video');
          const containerId = results.instagram?.containerId
            ?? await createInstagramContainer({ igUserId: conn.igUserId, token: conn.token!, caption, mediaUrl, kind: kind === 'video' ? 'video' : 'image' }, this.fetchImpl);
          results.instagram = { containerId };
          const status = kind === 'video' ? await containerStatus(containerId, conn.token!, this.fetchImpl) : 'FINISHED';
          if (status === 'ERROR') throw new Error('Instagram no pudo procesar el video');
          if (status !== 'FINISHED') {
            pending = true; // el cron vuelve en un minuto con el mismo contenedor
            continue;
          }
          const pub = await publishInstagramContainer(conn.igUserId, containerId, conn.token!, this.fetchImpl);
          results.instagram = { containerId, id: pub.id };
        }
      }
    } catch (err: any) {
      error = err instanceof MetaError ? `Meta: ${err.message}` : String(err?.message ?? err);
    }
    const done = !error && !pending && targets.every((t) => results[t]?.id);
    const updated = await this.prisma.contentPiece.update({
      where: { id: pieceId },
      data: {
        publishResultJson: JSON.stringify(results),
        publishError: error,
        status: done ? 'PUBLICADO' : error ? 'ERROR' : 'PUBLICANDO',
        ...(done ? { publishedAt: new Date() } : {}),
      },
    });
    await this.audit.log({
      actor: null, companyId: piece.companyId, action: done ? 'social.published' : error ? 'social.publish_error' : 'social.publish_pending',
      entity: 'ContentPiece', entityId: pieceId, detail: error ?? targets.join(', '),
    });
    return serializePiece(updated);
  }

  /** Cada minuto: lo programado que ya toca y los reels que Meta seguía procesando. */
  @Cron('*/1 * * * *')
  async publishDue() {
    if (process.env.JEST_WORKER_ID) return;
    try {
      const due = await this.prisma.contentPiece.findMany({
        where: {
          OR: [
            { status: 'PROGRAMADO', scheduledAt: { lte: new Date() } },
            { status: 'PUBLICANDO', updatedAt: { lte: new Date(Date.now() - 60e3) }, publishAttempts: { lt: 15 } },
          ],
        },
        take: 20,
      });
      for (const p of due) await this.publishPiece(p.id).catch((err) => this.logger.warn(`publicar ${p.id}: ${err.message}`));
    } catch (err: any) {
      this.logger.warn(`cron de publicación: ${err.message}`);
    }
  }

  /* ── Conexión con Meta ── */

  private async redirectUri() {
    return `${(await publicWebUrl(this.prisma)).replace(/\/$/, '')}/api/public/social/meta/callback`;
  }

  async oauthStart(user: AuthUser, companyId?: string) {
    const id = this.companyOf(user, companyId);
    await this.assertAddon(id);
    const app = await this.metaApp();
    if (!app.appId || !app.appSecret) {
      throw new BadRequestException('El inicio de sesión con Facebook aún no está habilitado (faltan META_APP_ID y META_APP_SECRET). Usa la conexión manual o pídele al equipo.');
    }
    const state = signState({ c: id, u: user.id }, process.env.JWT_SECRET ?? 'dev');
    return { url: oauthUrl({ appId: app.appId, redirectUri: await this.redirectUri(), state }) };
  }

  /** Vuelta de Facebook: guarda las páginas y, si hay una sola, la conecta. */
  async oauthCallback(code: string | undefined, state: string | undefined): Promise<string> {
    const web = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    const data = verifyState<{ c: string; u: string }>(String(state ?? ''), process.env.JWT_SECRET ?? 'dev');
    if (!data || !code) return `${web}/app/marketing?meta=error`;
    try {
      const app = await this.metaApp();
      const userToken = await exchangeCode({ appId: app.appId, appSecret: app.appSecret, redirectUri: await this.redirectUri(), code }, this.fetchImpl);
      const pages = await listPages(userToken, this.fetchImpl);
      if (!pages.length) return `${web}/app/marketing?meta=sin-paginas`;
      if (pages.length === 1) {
        await this.saveConnection(data.c, pages[0], 'OAUTH');
        await this.audit.log({ actor: null, companyId: data.c, action: 'social.connect', entity: 'Company', entityId: data.c, detail: `${pages[0].name} (Facebook Login)` });
        return `${web}/app/marketing?meta=ok`;
      }
      await this.upsertIntegration(data.c, {
        method: 'OAUTH',
        pendingPages: pages.map((p) => ({ id: p.id, name: p.name, igUserId: p.igUserId, igUsername: p.igUsername, accessTokenEnc: encryptSecret(p.accessToken) })),
      }, 'PENDING');
      return `${web}/app/marketing?meta=elegir`;
    } catch (err: any) {
      this.logger.warn(`OAuth Meta: ${err.message}`);
      return `${web}/app/marketing?meta=error`;
    }
  }

  async selectPage(user: AuthUser, pageId: string, companyId?: string) {
    const id = this.companyOf(user, companyId);
    const row = await this.prisma.integration.findFirst({ where: { companyId: id, type: 'META_SOCIAL' } });
    const pending = parseJson<Record<string, any>>(row?.configJson, {}).pendingPages ?? [];
    const page = pending.find((p: any) => p.id === pageId);
    if (!page) throw new BadRequestException('Esa página no está en la lista');
    await this.saveConnection(id, { ...page, accessToken: decryptSecret(page.accessTokenEnc) }, 'OAUTH');
    return this.status(user, id);
  }

  async connectManual(user: AuthUser, dto: { pageId?: string; accessToken?: string; sandbox?: boolean }, companyId?: string) {
    const id = this.companyOf(user, companyId);
    await this.assertAddon(id);
    const pageId = String(dto?.pageId ?? '').trim();
    if (!/^\d{5,25}$/.test(pageId)) throw new BadRequestException('El ID de la página son solo números');
    const token = String(dto?.accessToken ?? '').trim();
    if (dto?.sandbox || !token) {
      await this.saveConnection(id, { id: pageId, name: 'Página en modo prueba', accessToken: '', igUserId: 'prueba', igUsername: 'modo_prueba' }, 'SANDBOX');
    } else {
      let info;
      try {
        info = await inspectPage(pageId, token, this.fetchImpl);
      } catch (err: any) {
        throw new BadRequestException(`Meta no aceptó el token: ${err.message}`);
      }
      await this.saveConnection(id, { ...info, accessToken: token }, 'MANUAL');
    }
    await this.audit.log({ actor: user, companyId: id, action: 'social.connect', entity: 'Company', entityId: id, detail: `página ${pageId}` });
    return this.status(user, id);
  }

  async disconnect(user: AuthUser, companyId?: string) {
    const id = this.companyOf(user, companyId);
    await this.prisma.integration.deleteMany({ where: { companyId: id, type: 'META_SOCIAL' } });
    await this.audit.log({ actor: user, companyId: id, action: 'social.disconnect', entity: 'Company', entityId: id, detail: 'Meta' });
    return { ok: true };
  }

  private async saveConnection(companyId: string, page: MetaPage, method: string) {
    await this.upsertIntegration(companyId, {
      method, pageId: page.id, pageName: page.name, igUserId: page.igUserId, igUsername: page.igUsername,
      ...(page.accessToken ? { accessTokenEnc: encryptSecret(page.accessToken) } : {}),
      sandbox: !page.accessToken, pendingPages: undefined,
    }, 'CONNECTED');
  }

  private async upsertIntegration(companyId: string, cfg: Record<string, any>, status: string) {
    const row = await this.prisma.integration.findFirst({ where: { companyId, type: 'META_SOCIAL' } });
    const clean = JSON.stringify(Object.fromEntries(Object.entries(cfg).filter(([, v]) => v !== undefined)));
    if (row) await this.prisma.integration.update({ where: { id: row.id }, data: { configJson: clean, status } });
    else await this.prisma.integration.create({ data: { companyId, type: 'META_SOCIAL', name: 'Facebook e Instagram (publicación)', configJson: clean, status } });
  }

  /* ── Plataforma: costo vs. precio del extra ── */

  async platformReport() {
    const companies = await this.prisma.company.findMany({ where: { addonsJson: { contains: '"social"' } }, select: { id: true, name: true, addonsJson: true } });
    const rate = await usdCopRate(this.prisma);
    const period = periodOf();
    const out: any[] = [];
    for (const c of companies) {
      const addon = socialAddon(c);
      if (!addon.enabled && !parseJson<Record<string, any>>(c.addonsJson, {}).social?.requestedAt) continue;
      const usage = await socialUsage(this.prisma, c.id, period);
      const costCop = Math.round(usage.costUsd * rate);
      out.push({ companyId: c.id, name: c.name, ...addon, usage, costCop, marginCop: addon.enabled ? Math.round(addon.price / 1.19) - costCop : 0 });
    }
    return { period, usdCop: rate, companies: out };
  }
}

/** Misma forma que /marketing/pieces (sin el token público del medio). */
export function serializePiece(p: any) {
  const { mediaToken: _t, ...rest } = p;
  return {
    ...rest,
    hashtags: parseJson<string[]>(p.hashtagsJson, []),
    targets: parseJson<string[]>(p.targetsJson ?? '[]', []),
    publishResult: parseJson<Record<string, any>>(p.publishResultJson ?? '{}', {}),
    hasAsset: !!p.assetFile,
  };
}

/** Próximas N fechas en los días elegidos a la hora indicada (hora local de la empresa). */
export function nextSlots(start: Date, weekdays: number[], time: string, count: number, timeZone = 'America/Bogota'): Date[] {
  const [hh, mm] = time.split(':').map(Number);
  const out: Date[] = [];
  // Colombia no tiene horario de verano: UTC-5 fijo; otras zonas usan el desfase del día
  const offsetMin = (d: Date) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((utc.getTime() - local.getTime()) / 60000);
  };
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < 400 && out.length < count; i++) {
    const day = new Date(cursor.getTime() + i * DAY_MS);
    if (!weekdays.includes(day.getUTCDay())) continue;
    const at = new Date(day.getTime() + (hh * 60 + mm + offsetMin(day)) * 60000);
    if (at.getTime() > Date.now()) out.push(at);
  }
  return out;
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [...WRITE, ROLES.COMPANY_VIEWER] as const;

@Controller()
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get('social/status')
  @Roles(...READ)
  status(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.social.status(user, companyId);
  }

  @Post('social/request')
  @Roles(...WRITE)
  request(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.social.requestAddon(user, companyId);
  }

  @Post('social/pieces/:id/copy')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  copy(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.social.generateCopy(user, id);
  }

  @Post('social/pieces/:id/image')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  image(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.social.generateImage(user, id, dto);
  }

  @Get('social/pieces/:id/asset')
  @Roles(...READ)
  async asset(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const f = await this.social.assetPath(user, id);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(f.path).pipe(res);
  }

  @Post('social/pieces/:id/schedule')
  @Roles(...WRITE)
  schedule(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.social.schedule(user, id, dto);
  }

  @Post('social/pieces/:id/publish')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  publish(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.social.publishNow(user, id);
  }

  @Post('social/plan')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  plan(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.social.plan(user, dto, companyId);
  }

  @Get('social/meta/oauth')
  @Roles(...WRITE)
  oauth(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.social.oauthStart(user, companyId);
  }

  @Public()
  @Get('public/social/meta/callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Res() res: Response) {
    res.redirect(await this.social.oauthCallback(code, state));
  }

  @Post('social/meta/select')
  @Roles(...WRITE)
  select(@CurrentUser() user: AuthUser, @Body('pageId') pageId: string, @Query('companyId') companyId?: string) {
    return this.social.selectPage(user, pageId, companyId);
  }

  @Post('social/meta/manual')
  @Roles(...WRITE)
  manual(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.social.connectManual(user, dto, companyId);
  }

  @Delete('social/meta')
  @Roles(...WRITE)
  disconnect(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.social.disconnect(user, companyId);
  }

  @Get('social/report')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  report() {
    return this.social.platformReport();
  }

  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @Get('public/content/:token')
  async publicContent(@Param('token') token: string, @Res() res: Response) {
    const f = await this.social.publicAsset(token);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    createReadStream(f.path).pipe(res);
  }
}

@Module({
  imports: [EmailsModule],
  controllers: [SocialController],
  providers: [SocialService],
  exports: [SocialService],
})
export class SocialModule {}
