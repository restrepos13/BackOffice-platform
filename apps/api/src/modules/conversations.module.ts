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
  ) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.conversation.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(status ? { status } : {}),
        ...(needsAttention === 'true' ? { needsAttention: true } : {}),
      },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        contact: { select: { id: true, name: true, phone: true, stage: true } },
        bot: { select: { id: true, name: true } },
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
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    // marcar como leída
    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });
    return conversation;
  }

  async sendMessage(user: AuthUser, id: string, content: string) {
    const conversation = await this.assertAccess(user, id);
    const message = await this.prisma.message.create({
      data: {
        conversationId: id,
        direction: 'OUT',
        author: 'AGENT',
        content,
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
  ) {
    return this.conversations.list(user, companyId, status, needsAttention);
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
  ) {
    return this.conversations.sendMessage(user, id, content);
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
