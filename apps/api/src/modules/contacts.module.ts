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
  ) {
    const scoped = scopeCompanyId(user, companyId);
    const contacts = await this.prisma.contact.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(stage ? { stage } : {}),
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
    const contact = await this.prisma.contact.create({
      data: {
        companyId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        channel: dto.channel ?? 'WHATSAPP',
        stage: dto.stage ?? 'CURIOSO',
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

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    const contact = await this.prisma.contact.update({
      where: { id },
      data: {
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        channel: dto.channel,
        stage: dto.stage,
        notes: dto.notes,
        assignedToId: dto.assignedToId,
        ...(dto.customerId !== undefined ? { customerId: dto.customerId || null } : {}),
        ...(dto.tags ? { tagsJson: JSON.stringify(dto.tags) } : {}),
        lastActivityAt: new Date(),
      },
    });
    if (dto.stage && dto.stage !== existing.stage) {
      await this.audit.log({
        actor: user, companyId: existing.companyId, action: 'contact.stage',
        entity: 'Contact', entityId: id,
        detail: `${contact.name}: ${existing.stage} → ${dto.stage}`,
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
  ) {
    return this.contacts.list(user, companyId, stage, search);
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
