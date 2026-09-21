import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import { AuditService } from './audit.module';

/**
 * Catálogo de modelos IA servidos por DeepInfra.
 * Los costos (USD por millón de tokens) son los que se DECLARAN al cliente:
 * el consumo se traslada al costo, sin margen. El equipo BackOffice mantiene
 * el catálogo actualizado contra deepinfra.com/pricing.
 */
@Injectable()
export class AiModelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Visible para cualquier usuario autenticado (transparencia de costos). */
  async list(includeInactive = false) {
    return this.prisma.aiModel.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ recommended: 'desc' }, { inputCostPerMTok: 'asc' }],
    });
  }

  async create(actor: AuthUser, dto: any) {
    const model = await this.prisma.aiModel.create({
      data: {
        provider: dto.provider ?? 'DEEPINFRA',
        modelId: dto.modelId,
        name: dto.name,
        inputCostPerMTok: Number(dto.inputCostPerMTok),
        outputCostPerMTok: Number(dto.outputCostPerMTok),
        contextK: Number(dto.contextK ?? 128),
        recommended: !!dto.recommended,
        notes: dto.notes,
      },
    });
    await this.audit.log({
      actor, action: 'aimodel.create', entity: 'AiModel',
      entityId: model.id, detail: model.modelId,
    });
    return model;
  }

  async update(actor: AuthUser, id: string, dto: any) {
    const model = await this.prisma.aiModel.update({
      where: { id },
      data: {
        name: dto.name,
        inputCostPerMTok: dto.inputCostPerMTok != null ? Number(dto.inputCostPerMTok) : undefined,
        outputCostPerMTok: dto.outputCostPerMTok != null ? Number(dto.outputCostPerMTok) : undefined,
        contextK: dto.contextK != null ? Number(dto.contextK) : undefined,
        recommended: dto.recommended,
        active: dto.active,
        notes: dto.notes,
      },
    });
    await this.audit.log({
      actor, action: 'aimodel.update', entity: 'AiModel',
      entityId: id, detail: model.modelId,
    });
    return model;
  }

  async remove(actor: AuthUser, id: string) {
    const model = await this.prisma.aiModel.delete({ where: { id } });
    await this.audit.log({
      actor, action: 'aimodel.delete', entity: 'AiModel',
      entityId: id, detail: model.modelId,
    });
    return { ok: true };
  }
}

@Controller('ai-models')
export class AiModelsController {
  constructor(private readonly models: AiModelsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    const isPlatform = user.role === ROLES.SUPER_ADMIN || user.role === ROLES.DEV;
    return this.models.list(isPlatform);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.models.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.models.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.models.remove(user, id);
  }
}

@Module({
  controllers: [AiModelsController],
  providers: [AiModelsService],
})
export class AiModelsModule {}
