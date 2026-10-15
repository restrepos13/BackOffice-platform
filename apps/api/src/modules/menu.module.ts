import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { randomBytes } from 'crypto';
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { qrSvg } from '../common/qr';
import { publicWebUrl } from '../common/tracking';
import { isSoldOut } from '../ai/agent/tools';
import { AuditService } from './audit.module';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const IMAGE_MIME: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Teléfono de WhatsApp al que el menú manda el pedido (solo dígitos). */
export function menuWhatsapp(company: any, lines: any[]): string | null {
  const cfg = parseJson<Record<string, any>>(company.orderConfigJson, {}).menu ?? {};
  const fromLine = lines
    .map((l) => parseJson<Record<string, any>>(l.configJson, {}))
    .map((c) => c.displayPhone || c.fromNumber)
    .find(Boolean);
  const raw = cfg.whatsappPhone || fromLine || company.contactPhone || '';
  const digits = String(raw).replace(/[^\d]/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Fin del día local (para "agotado por hoy"). */
function endOfToday(timezone: string): Date {
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone || 'America/Bogota' }));
  const diff = now.getTime() - local.getTime();
  local.setHours(23, 59, 59, 999);
  return new Date(local.getTime() + diff);
}

/**
 * Menú digital con QR y la marca de la empresa: página pública /m/<slug>,
 * fotos de productos, agotados (hoy o indefinido) y QR para imprimir. El
 * pedido se termina por WhatsApp con el agente (mensaje prellenado).
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async enabledCompany(slug: string) {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    const menu = parseJson<Record<string, any>>(company?.orderConfigJson, {}).menu;
    if (!company || !menu?.enabled || ['SUSPENDED', 'CANCELLED'].includes(company.status)) {
      throw new NotFoundException('Menú no disponible');
    }
    return { company, menu };
  }

  /** Menú público: solo productos activos, sin ids internos de áreas ni costos. */
  async publicMenu(slug: string) {
    const { company, menu } = await this.enabledCompany(slug);
    const [products, lines, promos] = await Promise.all([
      this.prisma.product.findMany({ where: { companyId: company.id, active: true, ...NOT_DELETED }, orderBy: { name: 'asc' } }),
      this.prisma.integration.findMany({ where: { companyId: company.id, type: 'WHATSAPP' } }),
      this.prisma.promotion.findMany({ where: { companyId: company.id, active: true, public: true } }),
    ]);
    const now = new Date();
    const categories = new Map<string, any[]>();
    for (const p of products) {
      const key = p.category?.trim() || 'Menú';
      categories.set(key, [
        ...(categories.get(key) ?? []),
        {
          id: p.id, name: p.name, description: p.description ?? null, price: p.price ?? null, unit: p.unit,
          presentations: parseJson<any[]>(p.presentationsJson, []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean),
          soldOut: isSoldOut(p, now), hasImage: !!p.imageFile,
        },
      ]);
    }
    return {
      company: {
        name: company.name, slug: company.slug, brandColor: company.brandColor, logoUrl: company.logoUrl,
        city: company.city, currency: company.currency ?? 'COP',
      },
      title: menu.title ?? null,
      note: menu.note ?? null,
      whatsapp: menuWhatsapp(company, lines),
      categories: [...categories.entries()].map(([name, items]) => ({ name, items })),
      promotions: promos
        .filter((p) => (!p.startsAt || p.startsAt <= now) && (!p.endsAt || p.endsAt >= now) && (p.maxUses == null || p.usedCount < p.maxUses))
        .map((p) => ({ name: p.name, description: p.description, code: p.code, kind: p.kind, value: p.value })),
    };
  }

  async productImagePath(slug: string, productId: string) {
    const { company } = await this.enabledCompany(slug);
    const product = await this.prisma.product.findFirst({ where: { id: productId, companyId: company.id, active: true, ...NOT_DELETED } });
    if (!product?.imageFile) throw new NotFoundException('Sin foto');
    const path = join(UPLOADS_DIR, company.id, product.imageFile);
    if (!path.startsWith(join(UPLOADS_DIR, company.id)) || !existsSync(path)) throw new NotFoundException('Sin foto');
    return path;
  }

  async menuQr(slug: string) {
    const { company } = await this.enabledCompany(slug);
    const url = `${await publicWebUrl(this.prisma)}/m/${company.slug}`;
    return qrSvg(url, { dark: '#1a1a1a' });
  }

  /** Para el panel: link y QR del menú (aunque todavía no esté publicado). */
  async menuInfo(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    const lines = await this.prisma.integration.findMany({ where: { companyId: id, type: 'WHATSAPP' } });
    const url = `${await publicWebUrl(this.prisma)}/m/${company.slug}`;
    const menu = parseJson<Record<string, any>>(company.orderConfigJson, {}).menu ?? {};
    return { url, enabled: !!menu.enabled, whatsapp: menuWhatsapp(company, lines), qrSvg: qrSvg(url) };
  }

  /* ── Productos: foto y agotados (panel) ── */

  private async assertProduct(user: AuthUser, id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || product.deletedAt) throw new NotFoundException('Producto no encontrado');
    if (!isPlatformRole(user.role) && product.companyId !== user.companyId) throw new ForbiddenException();
    return product;
  }

  async uploadImage(user: AuthUser, id: string, file?: Express.Multer.File) {
    const product = await this.assertProduct(user, id);
    if (!file) throw new BadRequestException('Adjunta la foto');
    const ext = IMAGE_MIME[file.mimetype];
    if (!ext) throw new BadRequestException('La foto debe ser JPG, PNG o WEBP');
    if (file.size > 5 * 1024 * 1024) throw new BadRequestException('La foto supera 5 MB');
    const dir = join(UPLOADS_DIR, product.companyId);
    mkdirSync(dir, { recursive: true });
    const name = `producto-${randomBytes(10).toString('hex')}.${ext}`;
    writeFileSync(join(dir, name), file.buffer);
    if (product.imageFile) {
      try {
        unlinkSync(join(dir, product.imageFile));
      } catch {
        /* ya no existía */
      }
    }
    await this.prisma.product.update({ where: { id }, data: { imageFile: name } });
    await this.audit.log({ actor: user, companyId: product.companyId, action: 'product.image', entity: 'Product', entityId: id, detail: product.name });
    return { ok: true };
  }

  async removeImage(user: AuthUser, id: string) {
    const product = await this.assertProduct(user, id);
    if (product.imageFile) {
      try {
        unlinkSync(join(UPLOADS_DIR, product.companyId, product.imageFile));
      } catch {
        /* ya no existía */
      }
    }
    await this.prisma.product.update({ where: { id }, data: { imageFile: null } });
    return { ok: true };
  }

  async panelImagePath(user: AuthUser, id: string) {
    const product = await this.assertProduct(user, id);
    if (!product.imageFile) throw new NotFoundException('Sin foto');
    const path = join(UPLOADS_DIR, product.companyId, product.imageFile);
    if (!existsSync(path)) throw new NotFoundException('Sin foto');
    return path;
  }

  /** Agotado: "TODAY" (hasta medianoche), "INDEFINITE" o false (disponible). */
  async setSoldOut(user: AuthUser, id: string, dto: { soldOut: boolean | string; until?: string }) {
    const product = await this.assertProduct(user, id);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: product.companyId } });
    const soldOut = dto?.soldOut === true || dto?.soldOut === 'true';
    let soldOutUntil: Date | null = null;
    if (soldOut && dto?.until === 'TODAY') soldOutUntil = endOfToday(company.timezone);
    else if (soldOut && dto?.until && dto.until !== 'INDEFINITE') {
      const d = new Date(dto.until);
      if (Number.isNaN(d.getTime()) || d <= new Date()) throw new BadRequestException('Fecha inválida');
      soldOutUntil = d;
    }
    await this.prisma.product.update({ where: { id }, data: { soldOut, soldOutUntil } });
    await this.audit.log({
      actor: user, companyId: product.companyId, action: soldOut ? 'product.sold_out' : 'product.available',
      entity: 'Product', entityId: id, detail: `${product.name}${soldOutUntil ? ` hasta ${soldOutUntil.toISOString()}` : ''}`,
    });
    return { ok: true, soldOut, soldOutUntil };
  }
}

@Controller()
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Public()
  @Get('public/menu/:slug')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  publicMenu(@Param('slug') slug: string) {
    return this.menu.publicMenu(slug);
  }

  @Public()
  @Get('public/menu/:slug/products/:id/image')
  async publicImage(@Param('slug') slug: string, @Param('id') id: string, @Res() res: Response) {
    const path = await this.menu.productImagePath(slug, id);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    createReadStream(path).pipe(res);
  }

  @Public()
  @Get('public/menu/:slug/qr.svg')
  @Header('Content-Type', 'image/svg+xml')
  @Header('Cache-Control', 'public, max-age=86400')
  qr(@Param('slug') slug: string) {
    return this.menu.menuQr(slug);
  }

  @Get('menu/info')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  info(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.menu.menuInfo(user, companyId);
  }

  @Post('catalog/products/:id/image')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 5 * 1024 * 1024 } }))
  uploadImage(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFile() image?: Express.Multer.File) {
    return this.menu.uploadImage(user, id, image);
  }

  @Delete('catalog/products/:id/image')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  removeImage(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.menu.removeImage(user, id);
  }

  @Get('catalog/products/:id/image')
  async panelImage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const path = await this.menu.panelImagePath(user, id);
    res.setHeader('Cache-Control', 'private, max-age=300');
    createReadStream(path).pipe(res);
  }

  @Patch('catalog/products/:id/sold-out')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_AREA)
  soldOut(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.menu.setSoldOut(user, id, dto);
  }
}

@Module({
  controllers: [MenuController],
  providers: [MenuService],
})
export class MenuModule {}
