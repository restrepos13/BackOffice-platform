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
  NOT_DELETED,
} from '../common/constants';
import { AuditService } from './audit.module';
import { Products } from '../auth/products.guard';

/**
 * Catálogo del módulo de pedidos: productos, áreas de producción y empresas
 * cliente. Todo configurable por organización desde el panel — nada en código.
 */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!scoped) throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  private async assertTenant(user: AuthUser, doc: { companyId: string } | null, what: string) {
    if (!doc) throw new NotFoundException(`${what} no encontrado`);
    if (!isPlatformRole(user.role) && doc.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
  }

  /* ── Productos ── */

  async listProducts(user: AuthUser, companyId?: string, includeInactive = false) {
    const scoped = scopeCompanyId(user, companyId);
    const products = await this.prisma.product.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...NOT_DELETED,
        ...(includeInactive ? {} : { active: true }),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: { productionArea: { select: { id: true, name: true } } },
    });
    return products.map((p) => ({
      ...p,
      // Normalizado a strings (tolera la forma vieja [{name}])
      presentations: parseJson<any[]>(p.presentationsJson, [])
        .map((x) => (typeof x === 'string' ? x : x?.name))
        .filter(Boolean),
    }));
  }

  async saveProduct(user: AuthUser, dto: any, id?: string) {
    const companyId = id
      ? (await this.prisma.product.findUniqueOrThrow({ where: { id } })).companyId
      : this.resolveCompany(user, dto.companyId);
    if (!isPlatformRole(user.role) && companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    const data = {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      unit: dto.unit ?? 'unidad',
      productionAreaId: dto.productionAreaId || null,
      active: dto.active ?? true,
      // Precio que cotiza el agente (vacío = "a confirmar con el equipo")
      ...(dto.price !== undefined
        ? {
            price:
              dto.price === null || dto.price === '' || !Number.isFinite(Number(dto.price))
                ? null
                : Math.max(0, Number(dto.price)),
          }
        : {}),
      ...(dto.presentations
        ? { presentationsJson: JSON.stringify(dto.presentations) }
        : {}),
    };
    const product = id
      ? await this.prisma.product.update({ where: { id }, data })
      : await this.prisma.product.create({ data: { companyId, ...data } });
    await this.audit.log({
      actor: user, companyId, action: id ? 'product.update' : 'product.create',
      entity: 'Product', entityId: product.id, detail: product.name,
    });
    return product;
  }

  async removeProduct(user: AuthUser, id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    await this.assertTenant(user, product, 'Producto');
    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date(), active: false }, // soft delete
    });
    await this.audit.log({
      actor: user, companyId: product!.companyId, action: 'product.delete',
      entity: 'Product', entityId: id, detail: product!.name,
    });
    return { ok: true };
  }

  /* ── Áreas de producción ── */

  async listAreas(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const areas = await this.prisma.productionArea.findMany({
      where: { ...(scoped ? { companyId: scoped } : {}), active: true },
      orderBy: { name: 'asc' },
    });
    return areas.map((a) => ({
      ...a,
      responsibles: parseJson<any[]>(a.responsiblesJson, []),
    }));
  }

  async saveArea(user: AuthUser, dto: any, id?: string) {
    const companyId = id
      ? (await this.prisma.productionArea.findUniqueOrThrow({ where: { id } })).companyId
      : this.resolveCompany(user, dto.companyId);
    if (!isPlatformRole(user.role) && companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    const data = {
      name: dto.name,
      description: dto.description,
      notifyChannel: dto.notifyChannel ?? 'PANEL',
      notifyTarget: dto.notifyTarget,
      reminderHoursBefore:
        dto.reminderHoursBefore != null ? Number(dto.reminderHoursBefore) : undefined,
      active: dto.active,
      ...(dto.responsibles
        ? { responsiblesJson: JSON.stringify(dto.responsibles) }
        : {}),
    };
    const area = id
      ? await this.prisma.productionArea.update({ where: { id }, data })
      : await this.prisma.productionArea.create({
          data: { companyId, ...data, name: dto.name, reminderHoursBefore: Number(dto.reminderHoursBefore ?? 24) },
        });
    await this.audit.log({
      actor: user, companyId, action: id ? 'area.update' : 'area.create',
      entity: 'ProductionArea', entityId: area.id, detail: area.name,
    });
    return area;
  }

  /* ── Empresas cliente (Customer) ── */

  async listCustomers(user: AuthUser, companyId?: string, search?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const customers = await this.prisma.customer.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...NOT_DELETED,
        ...(search ? { name: { contains: search } } : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        contacts: { select: { id: true, name: true, phone: true } },
        _count: { select: { orders: true } },
      },
      take: 300,
    });
    return customers.map((c) => ({
      ...c,
      addresses: parseJson<any[]>(c.addressesJson, []),
    }));
  }

  async saveCustomer(user: AuthUser, dto: any, id?: string) {
    const companyId = id
      ? (await this.prisma.customer.findUniqueOrThrow({ where: { id } })).companyId
      : this.resolveCompany(user, dto.companyId);
    if (!isPlatformRole(user.role) && companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    const data = {
      name: dto.name,
      taxId: dto.taxId,
      notes: dto.notes,
      active: dto.active,
      ...(dto.addresses ? { addressesJson: JSON.stringify(dto.addresses) } : {}),
    };
    const customer = id
      ? await this.prisma.customer.update({ where: { id }, data })
      : await this.prisma.customer.create({ data: { companyId, ...data, name: dto.name } });
    await this.audit.log({
      actor: user, companyId, action: id ? 'customer.update' : 'customer.create',
      entity: 'Customer', entityId: customer.id, detail: customer.name,
    });
    return customer;
  }

  async removeCustomer(user: AuthUser, id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id } });
    await this.assertTenant(user, customer, 'Cliente');
    await this.prisma.customer.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    return { ok: true };
  }
}

const WRITE_ROLES = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;

@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('products')
  listProducts(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('all') all?: string,
  ) {
    return this.catalog.listProducts(user, companyId, all === '1');
  }

  @Post('products')
  @Roles(...WRITE_ROLES)
  createProduct(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.catalog.saveProduct(user, dto);
  }

  @Patch('products/:id')
  @Roles(...WRITE_ROLES)
  updateProduct(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.catalog.saveProduct(user, dto, id);
  }

  @Delete('products/:id')
  @Roles(...WRITE_ROLES)
  removeProduct(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.removeProduct(user, id);
  }

  @Get('areas')
  listAreas(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.catalog.listAreas(user, companyId);
  }

  @Post('areas')
  @Roles(...WRITE_ROLES)
  createArea(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.catalog.saveArea(user, dto);
  }

  @Patch('areas/:id')
  @Roles(...WRITE_ROLES)
  updateArea(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.catalog.saveArea(user, dto, id);
  }
}

@Products('AUTOMATION')
@Controller('customers')
export class CustomersController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('search') search?: string,
  ) {
    return this.catalog.listCustomers(user, companyId, search);
  }

  @Post()
  @Roles(...WRITE_ROLES)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.catalog.saveCustomer(user, dto);
  }

  @Patch(':id')
  @Roles(...WRITE_ROLES)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.catalog.saveCustomer(user, dto, id);
  }

  @Delete(':id')
  @Roles(...WRITE_ROLES)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.catalog.removeCustomer(user, id);
  }
}

@Module({
  controllers: [CatalogController, CustomersController],
  providers: [CatalogService],
})
export class CatalogModule {}
