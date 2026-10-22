import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { isPlatformRole } from '../common/constants';
import { ProductInactiveError, ProductKey, hasAnyProduct } from '../common/products';
import { IS_PUBLIC_KEY } from './decorators';

export const PRODUCTS_KEY = 'products';

/**
 * El endpoint pertenece a uno de estos productos (basta con tener uno).
 * Va en el controlador o en el método (el método manda). Sin decorador = común
 * a todos (cuenta, equipo, plan, facturación, catálogo del negocio…).
 */
export const Products = (...products: ProductKey[]) => SetMetadata(PRODUCTS_KEY, products);

/**
 * Acceso por producto verificado en el servidor (no solo ocultando el menú).
 * La empresa sale SIEMPRE de la sesión: nada que mande el navegador cuenta.
 * Plataforma (SUPER_ADMIN/DEV) administra todas las empresas y no se limita.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { productsJson: string | null; planId: string | null; at: number }>();

export function forgetCompanyProducts(companyId: string) {
  cache.delete(companyId);
}

@Injectable()
export class ProductsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  private async companyRow(companyId: string) {
    const hit = cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const row = await this.prisma.company.findUnique({ where: { id: companyId }, select: { productsJson: true, planId: true } });
    if (!row) {
      cache.delete(companyId);
      return null;
    }
    const fresh = { productsJson: row.productsJson ?? null, planId: row.planId ?? null, at: Date.now() };
    if (cache.size > 5000) cache.clear();
    cache.set(companyId, fresh);
    return fresh;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const required = this.reflector.getAllAndOverride<ProductKey[]>(PRODUCTS_KEY, targets);
    if (!required?.length) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) return true; // sin sesión ya lo frenó JwtAuthGuard
    if (isPlatformRole(user.role)) return true;
    const company = user.companyId ? await this.companyRow(user.companyId) : null;
    if (!company || !hasAnyProduct(company, required)) throw new ForbiddenException(ProductInactiveError.body(required, company));
    return true;
  }
}
