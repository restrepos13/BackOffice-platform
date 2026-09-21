import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';

@Injectable()
export class ConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertAccess(user: AuthUser, id: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    if (!isPlatformRole(user.role) && conversation.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return conversation;
  }

  async list(
    user: AuthUser,
    companyId?: string,
    status?: string,
    needsAttention?: string,
    integrationId?: string,
  ) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.conversation.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(status ? { status } : {}),
        ...(needsAttention === 'true' ? { needsAttention: true } : {}),
        ...(integrationId ? { integrationId } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        contact: { select: { id: true, name: true, phone: true, stage: true } },
        bot: { select: { id: true, name: true } },
        integration: { select: { id: true, name: true } },
        company: { select: { name: true, slug: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      take: 200,
    });
  }

  async detail(user: AuthUser, id: string) {
    await this.assertAccess(user, id);
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        contact: true,
        bot: { select: { id: true, name: true, model: true } },
        integration: { select: { id: true, name: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: {
            mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } },
          },
        },
      },
    });
    // marcar como leída
    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });
    return conversation;
  }

  async sendMessage(
    user: AuthUser,
    id: string,
    content: string,
    mediaAssetId?: string,
  ) {
    const conversation = await this.assertAccess(user, id);
    // La foto debe existir, estar activa y pertenecer al MISMO tenant
    if (mediaAssetId) {
      const asset = await this.prisma.mediaAsset.findUnique({
        where: { id: mediaAssetId },
      });
      if (!asset || asset.companyId !== conversation.companyId || !asset.active) {
        throw new ForbiddenException('Foto inválida para esta conversación');
      }
      await this.prisma.mediaAsset.update({
        where: { id: mediaAssetId },
        data: { timesSent: { increment: 1 } },
      });
    }
    if (!content?.trim() && !mediaAssetId) {
      throw new ForbiddenException('Mensaje vacío');
    }
    const message = await this.prisma.message.create({
      data: {
        conversationId: id,
        direction: 'OUT',
        author: 'AGENT',
        content: content?.trim() ?? '',
        mediaAssetId: mediaAssetId ?? null,
      },
      include: {
        mediaAsset: { select: { id: true, name: true, priceUsd: true, mimeType: true } },
      },
    });
    await this.prisma.conversation.update({
      where: { id },
      data: {
        lastMessageAt: new Date(),
        status: 'HANDOFF',
        needsAttention: false,
      },
    });
    return message;
  }

  async updateStatus(user: AuthUser, id: string, dto: any) {
    await this.assertAccess(user, id);
    return this.prisma.conversation.update({
      where: { id },
      data: {
        status: dto.status,
        needsAttention: dto.needsAttention,
      },
    });
  }
}

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
    @Query('needsAttention') needsAttention?: string,
    @Query('integrationId') integrationId?: string,
  ) {
    return this.conversations.list(
      user, companyId, status, needsAttention, integrationId,
    );
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.conversations.detail(user, id);
  }

  @Post(':id/messages')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  sendMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('content') content: string,
    @Body('mediaAssetId') mediaAssetId?: string,
  ) {
    return this.conversations.sendMessage(user, id, content, mediaAssetId);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  updateStatus(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.conversations.updateStatus(user, id, dto);
  }
}

@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
