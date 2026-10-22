import {
  Body,
  Controller,
  Delete,
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
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';
import { Products } from '../auth/products.guard';

@Injectable()
export class PersonasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(t: any) {
    return {
      ...t,
      personality: parseJson<Record<string, string>>(t.personalityJson, {}),
    };
  }

  /** Globales (companyId null) + propias de la empresa del usuario. */
  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const templates = await this.prisma.personaTemplate.findMany({
      where: isPlatformRole(user.role) && !scoped
        ? undefined
        : { OR: [{ companyId: null }, { companyId: scoped }] },
      orderBy: [{ companyId: 'asc' }, { category: 'asc' }, { name: 'asc' }],
      include: { company: { select: { name: true, slug: true } } },
    });
    return templates.map((t) => this.serialize(t));
  }

  async create(user: AuthUser, dto: any) {
    // Plataforma puede crear plantillas globales; empresas solo propias.
    const companyId = isPlatformRole(user.role)
      ? (dto.companyId ?? null)
      : user.companyId;
    if (!isPlatformRole(user.role) && !companyId) {
      throw new ForbiddenException();
    }
    const template = await this.prisma.personaTemplate.create({
      data: {
        companyId,
        name: dto.name,
        category: dto.category ?? 'General',
        description: dto.description,
        systemPrompt: dto.systemPrompt ?? '',
        personalityJson: JSON.stringify(dto.personality ?? {}),
        welcomeMessage: dto.welcomeMessage,
        handoffKeywords: dto.handoffKeywords,
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'persona.create',
      entity: 'PersonaTemplate', entityId: template.id, detail: template.name,
    });
    return this.serialize(template);
  }

  private async assertAccess(user: AuthUser, id: string) {
    const template = await this.prisma.personaTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Plantilla no encontrada');
    if (!isPlatformRole(user.role)) {
      // las globales no las puede tocar una empresa
      if (!template.companyId || template.companyId !== user.companyId) {
        throw new ForbiddenException();
      }
    }
    return template;
  }

  async update(user: AuthUser, id: string, dto: any) {
    await this.assertAccess(user, id);
    const template = await this.prisma.personaTemplate.update({
      where: { id },
      data: {
        name: dto.name,
        category: dto.category,
        description: dto.description,
        systemPrompt: dto.systemPrompt,
        welcomeMessage: dto.welcomeMessage,
        handoffKeywords: dto.handoffKeywords,
        ...(dto.personality
          ? { personalityJson: JSON.stringify(dto.personality) }
          : {}),
      },
    });
    return this.serialize(template);
  }

  async remove(user: AuthUser, id: string) {
    const template = await this.assertAccess(user, id);
    await this.prisma.personaTemplate.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: template.companyId, action: 'persona.delete',
      entity: 'PersonaTemplate', entityId: id, detail: template.name,
    });
    return { ok: true };
  }
}

@Products('AUTOMATION')
@Controller('personas')
export class PersonasController {
  constructor(private readonly personas: PersonasService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.personas.list(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.personas.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.personas.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.personas.remove(user, id);
  }
}

@Module({
  controllers: [PersonasController],
  providers: [PersonasService],
})
export class PersonasModule {}
