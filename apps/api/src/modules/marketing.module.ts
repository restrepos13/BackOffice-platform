import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
} from '../common/constants';
import { AuditService } from './audit.module';
import { AI_PROVIDER, AiProvider, extractJson } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';

/**
 * MARKETING (extra por empresa, módulo "marketing"): campañas, calendario de
 * contenido y piezas (reels/posts/historias/anuncios) con copy generado por la
 * IA de la propia empresa (BYOK DeepInfra).
 *
 * Generación de VIDEO (reels): cascarón listo para MoneyPrinterTurbo —
 * la plataforma habla con su API (POST /api/v1/videos + polling de
 * /api/v1/tasks/{id}) cuando en Dev Tools → Settings existan:
 *   MPT_BASE_URL  (p. ej. http://localhost:8080)
 *   MPT_API_KEY   (header x-api-key; vacío si el generador no exige llave)
 * Sin eso, el botón del panel explica qué falta. Nada revienta.
 */

const PIECE_TYPES = ['REEL', 'POST', 'STORY', 'AD'];
const PIECE_STATUSES = ['IDEA', 'BORRADOR', 'LISTO', 'PROGRAMADO', 'PUBLICADO'];
const CAMPAIGN_STATUSES = ['BORRADOR', 'ACTIVA', 'PAUSADA', 'CERRADA'];
const CHANNELS = ['instagram', 'tiktok', 'facebook', 'youtube'];

@Injectable()
export class MarketingService {
  private readonly logger = new Logger('Marketing');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!scoped) throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private async assertCampaign(user: AuthUser, id: string) {
    const campaign = await this.prisma.marketingCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campaña no encontrada');
    if (!isPlatformRole(user.role) && campaign.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return campaign;
  }

  private async assertPiece(user: AuthUser, id: string) {
    const piece = await this.prisma.contentPiece.findUnique({ where: { id } });
    if (!piece) throw new NotFoundException('Pieza no encontrada');
    if (!isPlatformRole(user.role) && piece.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return piece;
  }

  private serializePiece(p: any) {
    return { ...p, hashtags: parseJson<string[]>(p.hashtagsJson, []) };
  }

  /* ═══ Campañas ═══ */

  async listCampaigns(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const campaigns = await this.prisma.marketingCampaign.findMany({
      where: { companyId: scoped },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const pieces = await this.prisma.contentPiece.findMany({
      where: { companyId: scoped, campaignId: { not: null } },
      select: { campaignId: true, status: true },
    });
    return campaigns.map((c) => ({
      ...c,
      channels: parseJson<string[]>(c.channelsJson, []),
      pieceCount: pieces.filter((p) => p.campaignId === c.id).length,
      publishedCount: pieces.filter((p) => p.campaignId === c.id && p.status === 'PUBLICADO').length,
    }));
  }

  async saveCampaign(user: AuthUser, dto: any, id?: string) {
    const companyId = id
      ? (await this.assertCampaign(user, id)).companyId
      : this.resolveCompany(user, dto.companyId);
    const data = {
      name: dto.name,
      objective: dto.objective,
      status: CAMPAIGN_STATUSES.includes(dto.status) ? dto.status : undefined,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      budgetUsd: dto.budgetUsd != null ? Number(dto.budgetUsd) : undefined,
      notes: dto.notes,
      ...(Array.isArray(dto.channels)
        ? { channelsJson: JSON.stringify(dto.channels.filter((c: string) => CHANNELS.includes(c))) }
        : {}),
    };
    const campaign = id
      ? await this.prisma.marketingCampaign.update({ where: { id }, data })
      : await this.prisma.marketingCampaign.create({
          data: { companyId, ...data, name: dto.name, status: dto.status ?? 'BORRADOR' },
        });
    await this.audit.log({
      actor: user, companyId, action: id ? 'marketing.campaign_update' : 'marketing.campaign_create',
      entity: 'MarketingCampaign', entityId: campaign.id, detail: campaign.name,
    });
    return campaign;
  }

  /* ═══ Piezas de contenido ═══ */

  async listPieces(user: AuthUser, q: { companyId?: string; status?: string; campaignId?: string; type?: string }) {
    const scoped = this.resolveCompany(user, q.companyId);
    const pieces = await this.prisma.contentPiece.findMany({
      where: {
        companyId: scoped,
        ...(q.status ? { status: q.status } : {}),
        ...(q.campaignId ? { campaignId: q.campaignId } : {}),
        ...(q.type ? { type: q.type } : {}),
      },
      orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return pieces.map((p) => this.serializePiece(p));
  }

  async savePiece(user: AuthUser, dto: any, id?: string) {
    const companyId = id
      ? (await this.assertPiece(user, id)).companyId
      : this.resolveCompany(user, dto.companyId);
    if (!id && !dto.title?.trim()) throw new BadRequestException('Falta el título de la pieza');
    const data = {
      title: dto.title,
      brief: dto.brief,
      copy: dto.copy,
      script: dto.script,
      type: PIECE_TYPES.includes(dto.type) ? dto.type : undefined,
      status: PIECE_STATUSES.includes(dto.status) ? dto.status : undefined,
      channel: CHANNELS.includes(dto.channel) ? dto.channel : dto.channel === null ? null : undefined,
      campaignId: dto.campaignId === null ? null : dto.campaignId,
      scheduledAt: dto.scheduledAt === null ? null : dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      publishedAt: dto.status === 'PUBLICADO' ? new Date() : undefined,
      assetUrl: dto.assetUrl,
      ...(Array.isArray(dto.hashtags) ? { hashtagsJson: JSON.stringify(dto.hashtags) } : {}),
    };
    const piece = id
      ? await this.prisma.contentPiece.update({ where: { id }, data })
      : await this.prisma.contentPiece.create({
          data: {
            companyId, ...data, title: dto.title,
            type: PIECE_TYPES.includes(dto.type) ? dto.type : 'POST',
            status: PIECE_STATUSES.includes(dto.status) ? dto.status : 'IDEA',
          },
        });
    await this.audit.log({
      actor: user, companyId, action: id ? 'marketing.piece_update' : 'marketing.piece_create',
      entity: 'ContentPiece', entityId: piece.id, detail: piece.title,
    });
    return this.serializePiece(piece);
  }

  async removePiece(user: AuthUser, id: string) {
    const piece = await this.assertPiece(user, id);
    await this.prisma.contentPiece.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: piece.companyId, action: 'marketing.piece_delete',
      entity: 'ContentPiece', entityId: id, detail: piece.title,
    });
    return { ok: true };
  }

  /* ═══ Copy con la IA de la empresa (BYOK) ═══ */

  async generateCopy(user: AuthUser, pieceId: string) {
    const piece = await this.assertPiece(user, pieceId);
    if (!this.ai) throw new BadRequestException('Motor de IA no disponible');
    const company = await this.prisma.company.findUniqueOrThrow({
      where: { id: piece.companyId },
    });
    if (!company.deepinfraApiKey) {
      throw new BadRequestException(
        'La organización no tiene llave de DeepInfra configurada (Configuración → Llave DeepInfra)',
      );
    }
    const typeLabel: Record<string, string> = {
      REEL: 'un reel corto de video (vertical 9:16)',
      POST: 'una publicación de feed',
      STORY: 'una historia',
      AD: 'un anuncio pago',
    };
    const result = await this.ai.chat({
      apiKey: company.deepinfraApiKey,
      model: 'meta-llama/Llama-3.3-70B-Instruct',
      temperature: 0.8,
      maxTokens: 700,
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content: `Eres el creativo de redes sociales de ${company.name}` +
            `${company.industry ? ` (${company.industry})` : ''}. Idioma: español${company.country ? ` (${company.country})` : ''}.
Devuelve SOLO un JSON: {"title": "gancho corto", "copy": "caption listo para publicar (2-4 líneas, con llamado a la acción)", "hashtags": ["#...", 5 a 8], "script": "solo si es reel: guion hablado de 30-45 segundos, natural, en primera persona"}.
Sin emojis excesivos, sin sonar a bot, sin promesas falsas.`,
        },
        {
          role: 'user',
          content: `Pieza: ${typeLabel[piece.type] ?? piece.type} para ${piece.channel ?? 'redes'}.
Título/idea actual: ${piece.title}
Brief: ${piece.brief ?? 'sin brief — proponlo tú a partir del título'}`,
        },
      ],
    });
    // Consumo BYOK registrado como cualquier respuesta de IA
    const catalogEntry = await this.prisma.aiModel.findUnique({
      where: { modelId: result.model },
    });
    await this.prisma.aiUsageEvent.create({
      data: {
        companyId: company.id, model: result.model,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        costUsd: catalogEntry
          ? Math.round(((result.inputTokens * catalogEntry.inputCostPerMTok + result.outputTokens * catalogEntry.outputCostPerMTok) / 1_000_000) * 1e6) / 1e6
          : 0,
      },
    });
    const parsed = extractJson(result.content) as any;
    if (!parsed?.copy) throw new BadRequestException('La IA no devolvió un copy válido — intenta de nuevo');

    const updated = await this.prisma.contentPiece.update({
      where: { id: pieceId },
      data: {
        title: parsed.title || piece.title,
        copy: parsed.copy,
        hashtagsJson: JSON.stringify(Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 10) : []),
        ...(piece.type === 'REEL' && parsed.script ? { script: parsed.script } : {}),
        status: piece.status === 'IDEA' ? 'BORRADOR' : piece.status,
      },
    });
    await this.audit.log({
      actor: user, companyId: company.id, action: 'marketing.copy_generated',
      entity: 'ContentPiece', entityId: pieceId, detail: updated.title,
    });
    return this.serializePiece(updated);
  }

  /* ═══ Video (cascarón MoneyPrinterTurbo) ═══ */

  private async mptConfig(): Promise<{ baseUrl: string; apiKey: string } | null> {
    const rows = await this.prisma.platformSetting.findMany({
      where: { key: { in: ['MPT_BASE_URL', 'MPT_API_KEY'] } },
    });
    const cfg = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    if (!cfg.MPT_BASE_URL) return null;
    return { baseUrl: String(cfg.MPT_BASE_URL).replace(/\/$/, ''), apiKey: cfg.MPT_API_KEY ?? '' };
  }

  /** Pide el reel al generador. Sin generador configurado → mensaje claro. */
  async renderVideo(user: AuthUser, pieceId: string) {
    const piece = await this.assertPiece(user, pieceId);
    if (piece.type !== 'REEL') {
      throw new BadRequestException('Solo las piezas tipo REEL generan video');
    }
    const mpt = await this.mptConfig();
    if (!mpt) {
      throw new BadRequestException(
        'El generador de video no está conectado todavía. El equipo BackOffice debe configurar MPT_BASE_URL (y MPT_API_KEY) en Dev Tools → Settings apuntando a MoneyPrinterTurbo.',
      );
    }
    const params = {
      video_subject: piece.title,
      ...(piece.script ? { video_script: piece.script } : {}),
      video_language: 'es',
      video_aspect: '9:16',
      voice_name: 'es-MX-DaliaNeural-Female',
      video_source: 'pexels',
      subtitle_enabled: true,
      video_count: 1,
    };
    const job = await this.prisma.videoJob.create({
      data: {
        companyId: piece.companyId,
        pieceId,
        paramsJson: JSON.stringify(params),
        state: 'PENDIENTE',
      },
    });
    try {
      const res = await fetch(`${mpt.baseUrl}/api/v1/videos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(mpt.apiKey ? { 'x-api-key': mpt.apiKey } : {}),
          'x-task-id': job.id,
        },
        body: JSON.stringify(params),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.data?.task_id) {
        throw new Error(`generador respondió ${res.status}: ${JSON.stringify(data).slice(0, 150)}`);
      }
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: { externalTaskId: data.data.task_id, state: 'PROCESANDO' },
      });
      await this.prisma.contentPiece.update({
        where: { id: pieceId },
        data: { videoJobId: job.id },
      });
      return { jobId: job.id, externalTaskId: data.data.task_id, state: 'PROCESANDO' };
    } catch (err: any) {
      await this.prisma.videoJob.update({
        where: { id: job.id },
        data: { state: 'FALLIDO', error: err.message },
      });
      throw new BadRequestException(`No se pudo encolar el video: ${err.message}`);
    }
  }

  async videoJob(user: AuthUser, jobId: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Tarea de video no encontrada');
    if (!isPlatformRole(user.role) && job.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return job;
  }

  /** Polling del generador: mapea estado/progreso y guarda la URL final. */
  @Cron('*/30 * * * * *')
  async pollVideoJobs() {
    if (process.env.JEST_WORKER_ID) return;
    const pending = await this.prisma.videoJob.findMany({
      where: { state: 'PROCESANDO', externalTaskId: { not: null } },
      take: 10,
    });
    if (!pending.length) return;
    const mpt = await this.mptConfig();
    if (!mpt) return;
    for (const job of pending) {
      try {
        const res = await fetch(`${mpt.baseUrl}/api/v1/tasks/${job.externalTaskId}`, {
          headers: mpt.apiKey ? { 'x-api-key': mpt.apiKey } : {},
        });
        if (res.status === 404) {
          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: { state: 'FALLIDO', error: 'La tarea ya no existe en el generador (¿reinicio sin Redis?)' },
          });
          continue;
        }
        const data: any = (await res.json())?.data ?? {};
        const progress = Number(data.progress ?? job.progress) || job.progress;
        if (data.state === 1) {
          const video = data.videos?.[0] ?? null;
          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: { state: 'COMPLETO', progress: 100, videoUrl: video },
          });
          if (job.pieceId && video) {
            await this.prisma.contentPiece.update({
              where: { id: job.pieceId },
              data: { assetUrl: video, status: 'LISTO' },
            });
          }
        } else if (data.state === -1) {
          await this.prisma.videoJob.update({
            where: { id: job.id },
            data: { state: 'FALLIDO', progress, error: `${data.failed_stage ?? 'pipeline'}: ${data.error ?? 'error'}` },
          });
        } else {
          await this.prisma.videoJob.update({ where: { id: job.id }, data: { progress } });
        }
      } catch (err: any) {
        this.logger.warn(`poll video ${job.id}: ${err.message}`);
      }
    }
  }

  /* ═══ Resumen / calendario ═══ */

  async summary(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const [pieces, campaigns, mpt] = await Promise.all([
      this.prisma.contentPiece.findMany({ where: { companyId: scoped } }),
      this.prisma.marketingCampaign.count({ where: { companyId: scoped, status: 'ACTIVA' } }),
      this.mptConfig(),
    ]);
    const byStatus: Record<string, number> = {};
    for (const p of pieces) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    const upcoming = pieces
      .filter((p) => p.scheduledAt && p.scheduledAt > new Date() && p.status !== 'PUBLICADO')
      .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime())
      .slice(0, 10)
      .map((p) => this.serializePiece(p));
    return {
      campañasActivas: campaigns,
      piezas: byStatus,
      totalPiezas: pieces.length,
      próximas: upcoming,
      videoGeneratorReady: !!mpt,
    };
  }
}

const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ_ROLES = [...WRITE_ROLES, ROLES.COMPANY_VIEWER] as const;

@Controller('marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  @Get('summary')
  @Roles(...READ_ROLES)
  summary(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.marketing.summary(user, companyId);
  }

  @Get('campaigns')
  @Roles(...READ_ROLES)
  listCampaigns(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.marketing.listCampaigns(user, companyId);
  }

  @Post('campaigns')
  @Roles(...WRITE_ROLES)
  createCampaign(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.marketing.saveCampaign(user, dto);
  }

  @Patch('campaigns/:id')
  @Roles(...WRITE_ROLES)
  updateCampaign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.marketing.saveCampaign(user, dto, id);
  }

  @Get('pieces')
  @Roles(...READ_ROLES)
  listPieces(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('campaignId') campaignId?: string,
    @Query('type') type?: string,
  ) {
    return this.marketing.listPieces(user, { companyId, status, campaignId, type });
  }

  @Post('pieces')
  @Roles(...WRITE_ROLES)
  createPiece(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.marketing.savePiece(user, dto);
  }

  @Patch('pieces/:id')
  @Roles(...WRITE_ROLES)
  updatePiece(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.marketing.savePiece(user, dto, id);
  }

  @Delete('pieces/:id')
  @Roles(...WRITE_ROLES)
  removePiece(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.marketing.removePiece(user, id);
  }

  @Post('pieces/:id/generate-copy')
  @Roles(...WRITE_ROLES)
  generateCopy(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.marketing.generateCopy(user, id);
  }

  @Post('pieces/:id/render-video')
  @Roles(...WRITE_ROLES)
  renderVideo(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.marketing.renderVideo(user, id);
  }

  @Get('video-jobs/:id')
  @Roles(...READ_ROLES)
  videoJob(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.marketing.videoJob(user, id);
  }
}

@Module({
  controllers: [MarketingController],
  providers: [
    MarketingService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
  exports: [MarketingService],
})
export class MarketingModule {}
