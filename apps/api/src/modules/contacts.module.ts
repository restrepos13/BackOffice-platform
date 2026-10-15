import {
  BadRequestException,
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
import { DEFAULT_STAGES } from '../common/pipelines';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  parseJson,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(c: any) {
    return { ...c, tags: parseJson<string[]>(c.tagsJson, []) };
  }

  private async assertAccess(user: AuthUser, id: string) {
    const contact = await this.prisma.contact.findUnique({ where: { id } });
    if (!contact) throw new NotFoundException('Contacto no encontrado');
    if (!isPlatformRole(user.role) && contact.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return contact;
  }

  async list(
    user: AuthUser,
    companyId?: string,
    stage?: string,
    search?: string,
    pipelineId?: string,
  ) {
    const scoped = scopeCompanyId(user, companyId);
    const contacts = await this.prisma.contact.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(stage ? { stage } : {}),
        // Embudo: "default" = contactos sin embudo propio
        ...(pipelineId && pipelineId !== 'default' ? { pipelineId } : {}),
        // Mongo: null no matchea documentos sin el campo → ambos casos
        ...(pipelineId === 'default' && !search ? { OR: [{ pipelineId: null }, { pipelineId: { isSet: false } }] } : {}),
        ...(pipelineId === 'default' && search ? { AND: [{ OR: [{ pipelineId: null }, { pipelineId: { isSet: false } }] }] } : {}),
        ...(search
          ? {
              OR: [
                { name: { contains: search } },
                { phone: { contains: search } },
                { email: { contains: search } },
              ],
            }
          : {}),
      },
      orderBy: { lastActivityAt: 'desc' },
      include: {
        assignedTo: { select: { id: true, name: true } },
        company: { select: { name: true, slug: true } },
        _count: { select: { conversations: true } },
      },
      take: 500,
    });
    return contacts.map((c) => this.serialize(c));
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const pipelineId = dto.pipelineId && dto.pipelineId !== 'default' ? String(dto.pipelineId) : null;
    const stages = await this.stagesOf(pipelineId, companyId);
    const stage = dto.stage && stages.some((s) => s.key === dto.stage) ? dto.stage : stages[0].key;
    const contact = await this.prisma.contact.create({
      data: {
        companyId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        channel: dto.channel ?? 'WHATSAPP',
        stage,
        pipelineId,
        tagsJson: JSON.stringify(dto.tags ?? []),
        notes: dto.notes,
        assignedToId: dto.assignedToId,
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'contact.create',
      entity: 'Contact', entityId: contact.id, detail: contact.name,
    });
    return this.serialize(contact);
  }

  /** Etapas del embudo (el estándar si no tiene uno propio). */
  private async stagesOf(pipelineId: string | null, companyId: string): Promise<Array<{ key: string }>> {
    if (!pipelineId) return DEFAULT_STAGES;
    const p = await this.prisma.pipeline.findFirst({ where: { id: pipelineId, companyId } });
    if (!p) throw new BadRequestException('El embudo no existe');
    return parseJson<Array<{ key: string }>>(p.stagesJson, DEFAULT_STAGES);
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    // Embudo y etapa: la etapa debe existir en el embudo del contacto; al
    // cambiar de embudo sin etapa, el contacto entra en la primera
    const pipelineChanged = dto.pipelineId !== undefined;
    const pipelineId = pipelineChanged
      ? (!dto.pipelineId || dto.pipelineId === 'default' ? null : String(dto.pipelineId))
      : existing.pipelineId ?? null;
    let stage: string | undefined = dto.stage;
    if (pipelineChanged || stage) {
      const stages = await this.stagesOf(pipelineId, existing.companyId);
      if (!stage) stage = stages[0].key;
      if (!stages.some((s) => s.key === stage)) throw new BadRequestException(`La etapa ${stage} no está en ese embudo`);
    }
    const contact = await this.prisma.contact.update({
      where: { id },
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        channel: dto.channel,
        stage,
        notes: dto.notes,
        ...(dto.pipelineId !== undefined ? { pipelineId } : {}),
        // Baja manual de campañas y seguimientos
        ...(dto.optOut !== undefined ? { optOut: !!dto.optOut, optOutAt: dto.optOut ? new Date() : null } : {}),
        assignedToId: dto.assignedToId,
        ...(dto.customerId !== undefined ? { customerId: dto.customerId || null } : {}),
        ...(dto.tags ? { tagsJson: JSON.stringify(dto.tags) } : {}),
        lastActivityAt: new Date(),
      },
    });
    if (stage && stage !== existing.stage) {
      await this.audit.log({
        actor: user, companyId: existing.companyId, action: 'contact.stage',
        entity: 'Contact', entityId: id,
        detail: `${contact.name}: ${existing.stage} → ${stage}`,
      });
    }
    return this.serialize(contact);
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.assertAccess(user, id);
    await this.prisma.contact.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'contact.delete',
      entity: 'Contact', entityId: id, detail: existing.name,
    });
    return { ok: true };
  }
}

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('stage') stage?: string,
    @Query('search') search?: string,
    @Query('pipelineId') pipelineId?: string,
  ) {
    return this.contacts.list(user, companyId, stage, search, pipelineId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.contacts.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.contacts.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.contacts.remove(user, id);
  }
}

@Module({
  controllers: [ContactsController],
  providers: [ContactsService],
})
export class ContactsModule {}
