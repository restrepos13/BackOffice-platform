import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import { AuditService } from './audit.module';

const startedAt = Date.now();

@Injectable()
export class DevToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async health() {
    let dbOk = true;
    try {
      await this.prisma.$runCommandRaw({ ping: 1 });
    } catch {
      dbOk = false;
    }
    const [companies, users, conversations, messages] = await Promise.all([
      this.prisma.company.count(),
      this.prisma.user.count(),
      this.prisma.conversation.count(),
      this.prisma.message.count(),
    ]);
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected (MongoDB Atlas)' : 'error',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      node: process.version,
      env: process.env.NODE_ENV ?? 'development',
      counts: { companies, users, conversations, messages },
    };
  }

  async listApiKeys() {
    return this.prisma.apiKey.findMany({
      orderBy: { createdAt: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
    });
  }

  async createApiKey(actor: AuthUser, dto: { name: string; companyId?: string; scopes?: string[] }) {
    const secret = `bo_live_${randomBytes(24).toString('hex')}`;
    const key = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        companyId: dto.companyId ?? null,
        prefix: secret.slice(0, 16),
        hash: createHash('sha256').update(secret).digest('hex'),
        scopesJson: JSON.stringify(dto.scopes ?? ['read']),
      },
    });
    await this.audit.log({
      actor, companyId: dto.companyId, action: 'apikey.create',
      entity: 'ApiKey', entityId: key.id, detail: dto.name,
    });
    // El secreto solo se devuelve una vez
    return { ...key, secret };
  }

  async revokeApiKey(actor: AuthUser, id: string) {
    const key = await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      actor, companyId: key.companyId, action: 'apikey.revoke',
      entity: 'ApiKey', entityId: id, detail: key.name,
    });
    return key;
  }

  async getSettings() {
    const rows = await this.prisma.platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setSettings(actor: AuthUser, values: Record<string, string>) {
    for (const [key, value] of Object.entries(values)) {
      await this.prisma.platformSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
      });
    }
    await this.audit.log({
      actor, action: 'settings.update', entity: 'PlatformSetting',
      detail: Object.keys(values).join(', '),
    });
    return this.getSettings();
  }
}

@Controller('dev')
@Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
export class DevToolsController {
  constructor(private readonly dev: DevToolsService) {}

  @Get('health')
  health() {
    return this.dev.health();
  }

  @Get('apikeys')
  listApiKeys() {
    return this.dev.listApiKeys();
  }

  @Post('apikeys')
  createApiKey(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.dev.createApiKey(user, dto);
  }

  @Delete('apikeys/:id')
  revokeApiKey(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.dev.revokeApiKey(user, id);
  }

  @Get('settings')
  getSettings() {
    return this.dev.getSettings();
  }

  @Put('settings')
  setSettings(@CurrentUser() user: AuthUser, @Body() values: Record<string, string>) {
    return this.dev.setSettings(user, values);
  }
}

@Module({
  controllers: [DevToolsController],
  providers: [DevToolsService],
})
export class DevToolsModule {}
