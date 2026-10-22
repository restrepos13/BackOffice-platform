import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { forgetCompanyProducts } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole } from '../common/constants';
import {
  PRODUCTS, PRODUCT_INFO, ProductKey, isProductKey, productsExplicit, readProducts, withProductRequest, withProducts,
} from '../common/products';
import { AuditModule, AuditService } from './audit.module';

/**
 * Productos de cada empresa (Automation, Creative, Ads Intelligence).
 *  - La empresa ve qué tiene y pide activar lo que le falta (lo activa el equipo).
 *  - Plataforma enciende o apaga cada producto. Apagar NO borra datos: solo
 *    corta el acceso y los procesos automáticos de ese producto.
 * Sin precios: cobrar por producto es una decisión comercial pendiente.
 */

export function productsView(company: { productsJson?: string | null; planId?: string | null }) {
  const states = readProducts(company);
  return {
    explicit: productsExplicit(company),
    products: PRODUCTS.map((key) => ({ key, ...PRODUCT_INFO[key], ...states[key] })),
  };
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async company(id: string | null | undefined) {
    if (!id) throw new ForbiddenException('Falta companyId');
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    return c;
  }

  async mine(user: AuthUser, companyId?: string) {
    const c = await this.company(isPlatformRole(user.role) ? companyId : user.companyId);
    return productsView(c);
  }

  async request(user: AuthUser, key: string) {
    if (!isProductKey(key)) throw new BadRequestException('Producto desconocido');
    const c = await this.company(user.companyId);
    const state = readProducts(c)[key];
    if (state.enabled) return { ok: true, already: 'ACTIVE', ...productsView(c) };
    if (state.requestedAt) return { ok: true, already: 'REQUESTED', ...productsView(c) };
    const updated = await this.prisma.company.update({ where: { id: c.id }, data: { productsJson: withProductRequest(c, key, user.name) } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'products.requested', entity: 'Company', entityId: c.id, detail: PRODUCT_INFO[key].name });
    return { ok: true, already: null, ...productsView(updated) };
  }

  /** Plataforma: { AUTOMATION?: boolean, CREATIVE?: boolean, ADS?: boolean } */
  async set(user: AuthUser, companyId: string, dto: Record<string, unknown>) {
    const c = await this.company(companyId);
    const next: Partial<Record<ProductKey, boolean>> = {};
    for (const key of PRODUCTS) if (typeof dto?.[key] === 'boolean') next[key] = dto[key] as boolean;
    if (!Object.keys(next).length) throw new BadRequestException('Indica qué productos quedan activos');
    const before = readProducts(c);
    const updated = await this.prisma.company.update({ where: { id: c.id }, data: { productsJson: withProducts(c, next) } });
    forgetCompanyProducts(c.id);
    const after = readProducts(updated);
    const changes = PRODUCTS.filter((k) => before[k].enabled !== after[k].enabled).map((k) => `${PRODUCT_INFO[k].short}: ${after[k].enabled ? 'activo' : 'inactivo'}`);
    await this.audit.log({ actor: user, companyId: c.id, action: 'products.updated', entity: 'Company', entityId: c.id, detail: changes.join(' · ') || 'sin cambios (elección guardada)' });
    return productsView(updated);
  }

  /** Plataforma: solicitudes de activación pendientes. */
  async requests() {
    const rows = await this.prisma.company.findMany({ where: { productsJson: { contains: 'requestedAt' } }, select: { id: true, name: true, productsJson: true, planId: true }, take: 500 });
    const out: Array<{ companyId: string; companyName: string; product: ProductKey; name: string; requestedAt: string; requestedBy: string | null }> = [];
    for (const r of rows) {
      const states = readProducts(r);
      for (const key of PRODUCTS) {
        const s = states[key];
        if (!s.enabled && s.requestedAt) out.push({ companyId: r.id, companyName: r.name, product: key, name: PRODUCT_INFO[key].name, requestedAt: s.requestedAt, requestedBy: s.requestedBy ?? null });
      }
    }
    return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
}

@Controller()
export class ProductsController {
  constructor(private readonly s: ProductsService) {}

  @Get('products')
  mine(@CurrentUser() u: AuthUser) {
    return this.s.mine(u);
  }

  @Post('products/:key/request')
  @Roles(ROLES.COMPANY_ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  request(@CurrentUser() u: AuthUser, @Param('key') key: string) {
    return this.s.request(u, key);
  }

  @Get('platform/companies/:id/products')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  ofCompany(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.s.mine(u, id);
  }

  @Put('platform/companies/:id/products')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  set(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: Record<string, unknown>) {
    return this.s.set(u, id, dto);
  }

  @Get('platform/product-requests')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  requests() {
    return this.s.requests();
  }
}

@Module({
  imports: [AuditModule],
  controllers: [ProductsController],
  providers: [ProductsService],
})
export class ProductsModule {}
