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
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson, scopeCompanyId } from '../common/constants';
import { DEFAULT_STAGES, PipelineStage, sanitizeStages } from '../common/pipelines';
import { AuditService } from './audit.module';

/** Embudos de venta configurables por empresa (CRM de contactos). */
@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private serialize(p: any) {
    return { ...p, stages: parseJson<PipelineStage[]>(p.stagesJson, []) };
  }

  /** Embudos de la empresa; siempre incluye el estándar (id "default"). */
  async list(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const rows = await this.prisma.pipeline.findMany({ where: { companyId: scoped }, orderBy: { createdAt: 'asc' } });
    return [
      { id: 'default', name: 'Embudo estándar', stages: DEFAULT_STAGES, isDefault: !rows.some((r) => r.isDefault), builtIn: true },
      ...rows.map((r) => this.serialize(r)),
    ];
  }

  async save(user: AuthUser, dto: any, id?: string, companyId?: string) {
    let stages: PipelineStage[];
    try {
      stages = sanitizeStages(dto?.stages);
    } catch (err: any) {
      throw new BadRequestException(err.message);
    }
    const name = String(dto?.name ?? '').trim().slice(0, 60);
    if (!name) throw new BadRequestException('Ponle un nombre al embudo');
    let scoped: string;
    if (id) {
      const existing = await this.prisma.pipeline.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException('Embudo no encontrado');
      if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
      scoped = existing.companyId;
      // Contactos en etapas que se eliminaron vuelven a la primera etapa
      const keys = new Set(stages.map((s) => s.key));
      const orphans = await this.prisma.contact.findMany({ where: { pipelineId: id }, select: { id: true, stage: true } });
      for (const c of orphans.filter((o) => !keys.has(o.stage))) {
        await this.prisma.contact.update({ where: { id: c.id }, data: { stage: stages[0].key } });
      }
    } else {
      scoped = this.resolveCompany(user, companyId ?? dto?.companyId);
      const count = await this.prisma.pipeline.count({ where: { companyId: scoped } });
      if (count >= 10) throw new BadRequestException('Máximo 10 embudos por empresa');
    }
    if (dto?.isDefault) {
      await this.prisma.pipeline.updateMany({ where: { companyId: scoped }, data: { isDefault: false } });
    }
    const data = { name, stagesJson: JSON.stringify(stages), ...(dto?.isDefault !== undefined ? { isDefault: !!dto.isDefault } : {}) };
    const pipeline = id
      ? await this.prisma.pipeline.update({ where: { id }, data })
      : await this.prisma.pipeline.create({ data: { companyId: scoped, ...data } });
    await this.audit.log({
      actor: user, companyId: scoped, action: id ? 'pipeline.update' : 'pipeline.create',
      entity: 'Pipeline', entityId: pipeline.id, detail: `${name}: ${stages.map((s) => s.label).join(' → ')}`,
    });
    return this.serialize(pipeline);
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.prisma.pipeline.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Embudo no encontrado');
    if (!isPlatformRole(user.role) && existing.companyId !== user.companyId) throw new ForbiddenException();
    // Los contactos vuelven al embudo estándar, en su primera etapa
    await this.prisma.contact.updateMany({ where: { pipelineId: id }, data: { pipelineId: null, stage: 'CURIOSO' } });
    await this.prisma.pipeline.delete({ where: { id } });
    await this.audit.log({ actor: user, companyId: existing.companyId, action: 'pipeline.delete', entity: 'Pipeline', entityId: id, detail: existing.name });
    return { ok: true };
  }

  /** Etapas válidas para un contacto (las de su embudo o las estándar). */
  async stagesFor(pipelineId: string | null | undefined): Promise<PipelineStage[]> {
    if (!pipelineId || pipelineId === 'default') return DEFAULT_STAGES;
    const p = await this.prisma.pipeline.findUnique({ where: { id: pipelineId } });
    return p ? parseJson<PipelineStage[]>(p.stagesJson, DEFAULT_STAGES) : DEFAULT_STAGES;
  }
}

@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.pipelines.list(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.pipelines.save(user, dto, undefined, companyId);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.pipelines.save(user, dto, id);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.pipelines.remove(user, id);
  }
}

@Module({
  controllers: [PipelinesController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}
