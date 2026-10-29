import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole } from '../common/constants';
import { imageInfo } from '../common/creative-policy';
import { ensureFile, removeFile, saveFile } from '../common/file-store';
import { ratioLabels, videoInfo } from '../common/media-info';
import { ProductInactiveError, hasAnyProduct, hasProduct } from '../common/products';
import { AuditModule, AuditService } from './audit.module';

/**
 * Biblioteca de recursos compartida por Creative y Ads Intelligence.
 *
 *  - Es el mismo BrandAsset que ya usaba Creative (no hay un segundo almacén):
 *    los recursos anteriores siguen ahí, con procedencia "subido en Creative".
 *  - Ads Intelligence sube sus propias imágenes y videos SIN necesitar Creative.
 *  - Con los dos productos, lo de uno se ve en el otro.
 *  - Un diseño de Creative entra como recurso por versión: exportar otra vez
 *    crea una versión nueva (derivedFromId) y la anterior no se toca, así un
 *    anuncio nunca cambia en silencio.
 *  - Vincular un recurso a una campaña/anuncio es un registro interno: NO sube
 *    nada a la plataforma publicitaria. Mientras esté vinculado no se borra.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Tope de video: lo que se puede respaldar en la base (el disco del servidor es efímero) */
export const MAX_VIDEO_BYTES = 12 * 1024 * 1024;
const MAX_ASSETS = 500;

const clip = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

type Origin = 'CREATIVE' | 'ADS';

/** Vista pública de un recurso (sin nombre de archivo en disco). */
export function assetView(a: any, linkCount = 0) {
  return {
    id: a.id, name: a.name, kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes,
    width: a.width ?? null, height: a.height ?? null, durationSec: a.durationSec ?? null,
    source: a.source ?? 'UPLOAD', originModule: (a.originModule ?? 'CREATIVE') as Origin,
    designId: a.designId ?? null, designVersion: a.designVersion ?? null, derivedFromId: a.derivedFromId ?? null,
    ratios: ratioLabels(a.width, a.height), createdBy: a.createdBy ?? null, createdAt: a.createdAt,
    linkCount, locked: linkCount > 0,
  };
}

@Injectable()
export class LibraryService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  /** Empresa de la sesión (plataforma puede indicar cuál) con Creative o Ads Intelligence. */
  async companyOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    if (!isPlatformRole(user.role) && !hasAnyProduct(company, ['CREATIVE', 'ADS'])) throw new ForbiddenException(ProductInactiveError.body(['CREATIVE', 'ADS'], company));
    return company;
  }

  private async assetOf(companyId: string, id: string) {
    const a = await this.prisma.brandAsset.findUnique({ where: { id } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('Recurso no encontrado');
    return a;
  }

  private async linkCounts(companyId: string, ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const links = await this.prisma.adAssetLink.findMany({ where: { companyId, assetId: { in: ids } }, select: { assetId: true } });
    const m = new Map<string, number>();
    for (const l of links) m.set(l.assetId, (m.get(l.assetId) ?? 0) + 1);
    return m;
  }

  async list(user: AuthUser, q: { companyId?: string; kind?: string; origin?: string; q?: string }) {
    const company = await this.companyOf(user, q.companyId);
    const where: any = { companyId: company.id };
    if (['LOGO', 'IMAGE', 'REFERENCE', 'VIDEO'].includes(String(q.kind))) where.kind = q.kind;
    const rows = await this.prisma.brandAsset.findMany({ where, orderBy: { createdAt: 'desc' }, take: MAX_ASSETS });
    let out = rows;
    if (q.origin === 'ADS') out = out.filter((a: any) => a.originModule === 'ADS');
    if (q.origin === 'CREATIVE') out = out.filter((a: any) => (a.originModule ?? 'CREATIVE') === 'CREATIVE');
    const text = clip(q.q, 60).toLowerCase();
    if (text) out = out.filter((a: any) => a.name.toLowerCase().includes(text));
    const counts = await this.linkCounts(company.id, out.map((a: any) => a.id));
    return {
      products: { creative: hasProduct(company, 'CREATIVE'), ads: hasProduct(company, 'ADS') },
      limits: { maxImageBytes: MAX_IMAGE_BYTES, maxVideoBytes: MAX_VIDEO_BYTES, maxAssets: MAX_ASSETS, total: rows.length },
      assets: out.map((a: any) => assetView(a, counts.get(a.id) ?? 0)),
    };
  }

  async detail(user: AuthUser, id: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    const links = await this.prisma.adAssetLink.findMany({ where: { companyId: company.id, assetId: a.id }, orderBy: { createdAt: 'desc' } });
    const entities = links.length ? await this.prisma.adEntity.findMany({ where: { companyId: company.id, id: { in: links.map((l: any) => l.adEntityId) } } }) : [];
    const byId = new Map(entities.map((e: any) => [e.id, e]));
    // Versiones del mismo diseño (la cadena original → derivadas)
    const versions = a.designId
      ? (await this.prisma.brandAsset.findMany({ where: { companyId: company.id, designId: a.designId }, orderBy: { createdAt: 'asc' } }))
        .map((v: any) => ({ id: v.id, designVersion: v.designVersion ?? null, createdAt: v.createdAt, current: v.id === a.id }))
      : [];
    const available = !!(await ensureFile(this.prisma, company.id, a.fileName));
    return {
      ...assetView(a, links.length),
      available,
      versions,
      links: links.map((l: any) => {
        const e: any = byId.get(l.adEntityId);
        return {
          id: l.id, adEntityId: l.adEntityId, provider: l.provider, level: l.level, name: e?.name ?? l.entityName,
          status: e?.effectiveStatus ?? e?.status ?? null, missing: !e, createdBy: l.createdBy, createdAt: l.createdAt,
        };
      }),
    };
  }

  async serve(user: AuthUser, id: string, res: Response, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    const path = await ensureFile(this.prisma, company.id, a.fileName);
    if (!path) throw new NotFoundException('El archivo ya no está disponible');
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(path).pipe(res);
  }

  /** De qué producto entra el recurso: el que pida la pantalla, si la empresa lo tiene. */
  private originFor(company: any, wanted: unknown): Origin {
    if (wanted === 'ADS' && hasProduct(company, 'ADS')) return 'ADS';
    if (wanted === 'CREATIVE' && hasProduct(company, 'CREATIVE')) return 'CREATIVE';
    return hasProduct(company, 'CREATIVE') ? 'CREATIVE' : 'ADS';
  }

  async upload(user: AuthUser, file: Express.Multer.File | undefined, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    if (!file?.buffer?.length) throw new BadRequestException('Elige una imagen o un video');
    // El tipo se lee de los bytes, no de lo que dice el navegador
    const img = imageInfo(file.buffer);
    const vid = img ? null : videoInfo(file.buffer);
    if (!img && !vid) throw new BadRequestException('Solo imágenes PNG, JPG o WEBP y videos MP4 o MOV');
    if (img && file.size > MAX_IMAGE_BYTES) throw new BadRequestException('La imagen pesa más de 8 MB');
    if (vid && file.size > MAX_VIDEO_BYTES) throw new BadRequestException('Por ahora los videos pueden pesar hasta 12 MB');
    if (img && (img.width > 8000 || img.height > 8000)) throw new BadRequestException('La imagen es demasiado grande (máx. 8000 px)');
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const same = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, sha256 } });
    if (same) return { duplicate: true, asset: assetView(same, (await this.linkCounts(company.id, [same.id])).get(same.id) ?? 0) };
    const count = await this.prisma.brandAsset.count({ where: { companyId: company.id } });
    if (count >= MAX_ASSETS) throw new BadRequestException(`Llegaste al máximo de ${MAX_ASSETS} recursos: borra los que no uses`);
    const mime = img?.mime ?? vid!.mime;
    const ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[mime];
    const fileName = `asset-${randomBytes(12).toString('hex')}.${ext}`;
    await saveFile(this.prisma, company.id, fileName, file.buffer, mime);
    const kind = vid ? 'VIDEO' : ['LOGO', 'IMAGE', 'REFERENCE'].includes(dto?.kind) ? dto.kind : 'IMAGE';
    const asset = await this.prisma.brandAsset.create({
      data: {
        companyId: company.id, kind, name: clip(dto?.name, 80) || clip(file.originalname, 80) || (vid ? 'Video' : 'Imagen'),
        fileName, mimeType: mime, sizeBytes: file.size, width: img?.width ?? vid?.width ?? null, height: img?.height ?? vid?.height ?? null,
        durationSec: vid?.durationSec ?? null, createdBy: user.name, source: 'UPLOAD', originModule: this.originFor(company, dto?.module), sha256,
      },
    });
    await this.audit.log({ actor: user, companyId: company.id, action: 'library.asset_uploaded', entity: 'BrandAsset', entityId: asset.id, detail: `${asset.name} (${asset.originModule})` });
    return { duplicate: false, asset: assetView(asset) };
  }

  async rename(user: AuthUser, id: string, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    const name = clip(dto?.name, 80);
    if (!name) throw new BadRequestException('Escribe un nombre');
    const updated = await this.prisma.brandAsset.update({ where: { id: a.id }, data: { name } });
    return assetView(updated, (await this.linkCounts(company.id, [a.id])).get(a.id) ?? 0);
  }

  async remove(user: AuthUser, id: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    await assertAssetDeletable(this.prisma, company.id, a.id);
    await this.prisma.brandAsset.delete({ where: { id: a.id } });
    await removeFile(this.prisma, company.id, a.fileName);
    await this.audit.log({ actor: user, companyId: company.id, action: 'library.asset_deleted', entity: 'BrandAsset', entityId: a.id, detail: a.name });
    return { ok: true };
  }

  /* ── Vínculos con campañas y anuncios (Ads Intelligence) ── */

  async entities(user: AuthUser, q: { companyId?: string; q?: string }) {
    const company = await this.companyOf(user, q.companyId);
    const text = clip(q.q, 60).toLowerCase();
    const rows = await this.prisma.adEntity.findMany({ where: { companyId: company.id }, orderBy: { syncedAt: 'desc' }, take: 300 });
    return rows
      .filter((e: any) => !text || e.name.toLowerCase().includes(text))
      .slice(0, 100)
      .map((e: any) => ({ id: e.id, name: e.name, level: e.level, provider: e.provider, mode: e.mode, status: e.effectiveStatus ?? e.status ?? null }));
  }

  async link(user: AuthUser, id: string, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    const entity = await this.prisma.adEntity.findUnique({ where: { id: String(dto?.adEntityId ?? '') } });
    if (!entity || entity.companyId !== company.id) throw new NotFoundException('Campaña o anuncio no encontrado');
    const existing = await this.prisma.adAssetLink.findFirst({ where: { assetId: a.id, adEntityId: entity.id } });
    if (existing) return { ok: true, linkId: existing.id, already: true };
    const link = await this.prisma.adAssetLink.create({
      data: { companyId: company.id, assetId: a.id, adEntityId: entity.id, provider: entity.provider, level: entity.level, entityName: clip(entity.name, 200), createdBy: user.name },
    });
    await this.audit.log({ actor: user, companyId: company.id, action: 'library.asset_linked', entity: 'BrandAsset', entityId: a.id, detail: `${entity.level} ${entity.name}` });
    if (a.designId) {
      await this.prisma.creativeEvent.create({ data: { companyId: company.id, designId: a.designId, type: 'variant_in_campaign', dataJson: JSON.stringify({ assetId: a.id, level: entity.level }) } }).catch(() => null);
    }
    return { ok: true, linkId: link.id, already: false };
  }

  async unlink(user: AuthUser, id: string, linkId: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const a = await this.assetOf(company.id, id);
    const link = await this.prisma.adAssetLink.findUnique({ where: { id: linkId } });
    if (!link || link.companyId !== company.id || link.assetId !== a.id) throw new NotFoundException('Vínculo no encontrado');
    await this.prisma.adAssetLink.delete({ where: { id: link.id } });
    await this.audit.log({ actor: user, companyId: company.id, action: 'library.asset_unlinked', entity: 'BrandAsset', entityId: a.id, detail: link.entityName });
    return { ok: true };
  }

  /* ── Desde Creative ── */

  /**
   * Lleva la exportación actual de un diseño a la biblioteca como recurso
   * propio (copia del archivo). Misma versión del diseño → el mismo recurso;
   * versión nueva → recurso nuevo que deriva del anterior, que queda intacto.
   */
  async fromDesign(user: AuthUser, designId: string, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    if (!isPlatformRole(user.role) && !hasProduct(company, 'CREATIVE')) throw new ForbiddenException(ProductInactiveError.body(['CREATIVE'], company));
    const d = await this.prisma.creativeDesign.findUnique({ where: { id: designId } });
    if (!d || d.companyId !== company.id) throw new NotFoundException('Diseño no encontrado');
    if (!d.exportFile) throw new BadRequestException('Exporta el diseño antes de llevarlo a la biblioteca');
    // La exportación tiene que ser de la versión actual: si el diseño cambió, se vuelve a exportar
    if (exportedVersion(d.exportFile) !== d.version) throw new BadRequestException('El diseño cambió después de exportarlo: expórtalo de nuevo');
    const same = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, designId: d.id, designVersion: d.version } });
    if (same) return { created: false, asset: assetView(same, (await this.linkCounts(company.id, [same.id])).get(same.id) ?? 0) };
    const path = await ensureFile(this.prisma, company.id, d.exportFile);
    if (!path) throw new NotFoundException('La exportación ya no está disponible: vuelve a exportar');
    const buffer = readFileSync(path);
    const info = imageInfo(buffer);
    if (!info) throw new BadRequestException('La exportación no es una imagen válida');
    const previous = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, designId: d.id }, orderBy: { createdAt: 'desc' } });
    const ext = info.mime === 'image/png' ? 'png' : 'jpg';
    const fileName = `asset-${randomBytes(12).toString('hex')}.${ext}`;
    await saveFile(this.prisma, company.id, fileName, buffer, info.mime);
    const asset = await this.prisma.brandAsset.create({
      data: {
        companyId: company.id, kind: 'IMAGE', name: clip(`${d.name} · v${d.version}`, 80), fileName, mimeType: info.mime, sizeBytes: buffer.length,
        width: info.width, height: info.height, createdBy: user.name, source: 'DESIGN', originModule: 'CREATIVE',
        designId: d.id, designVersion: d.version, derivedFromId: previous?.id ?? null, sha256: createHash('sha256').update(buffer).digest('hex'),
      },
    });
    await this.audit.log({ actor: user, companyId: company.id, action: 'library.design_added', entity: 'BrandAsset', entityId: asset.id, detail: `${d.name} v${d.version}` });
    return { created: true, asset: assetView(asset) };
  }
}

/** Versión que dice el nombre de la exportación (design-<id>-v<n>-…); null si no la trae. */
export function exportedVersion(fileName: string | null | undefined): number | null {
  const m = /-v(\d+)-/.exec(fileName ?? '');
  return m ? Number(m[1]) : null;
}

/** Un recurso usado en una campaña o anuncio no se borra (primero hay que desvincularlo). */
export async function assertAssetDeletable(prisma: any, companyId: string, assetId: string) {
  const used = await prisma.adAssetLink.count({ where: { companyId, assetId } });
  if (used) throw new ConflictException(`Este recurso está vinculado a ${used} ${used === 1 ? 'campaña o anuncio' : 'campañas o anuncios'}. Desvincúlalo antes de borrarlo.`);
  // Un anuncio creado desde Ads lo necesita para reintentar o auditar
  const launches = await prisma.adLaunch.count({ where: { companyId, assetId, status: { not: 'ARCHIVED' } } });
  if (launches) throw new ConflictException('Este recurso lo usa un anuncio creado en BackOffice. Quita el anuncio de la lista antes de borrarlo.');
  // Un recorte o derivado conserva su original: no se borra el original mientras tenga derivados
  const derived = await prisma.brandAsset.count({ where: { companyId, derivedFromId: assetId, source: 'CUTOUT' } });
  if (derived) throw new ConflictException('Esta foto tiene un recorte que depende de ella. Borra primero el recorte.');
}

@Products('CREATIVE', 'ADS')
@Controller('library')
export class LibraryController {
  constructor(private readonly s: LibraryService) {}

  @Get('assets')
  @Roles(...READ)
  list(@CurrentUser() u: AuthUser, @Query() q: any) {
    return this.s.list(u, q);
  }

  @Get('assets/:id')
  @Roles(...READ)
  detail(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) {
    return this.s.detail(u, id, c);
  }

  @Get('assets/:id/file')
  @Roles(...READ)
  file(@CurrentUser() u: AuthUser, @Param('id') id: string, @Res() res: Response, @Query('companyId') c?: string) {
    return this.s.serve(u, id, res, c);
  }

  @Post('assets')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_VIDEO_BYTES, files: 1 } }))
  upload(@CurrentUser() u: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() dto: any, @Query('companyId') c?: string) {
    return this.s.upload(u, file, dto, c);
  }

  @Patch('assets/:id')
  @Roles(...WRITE)
  rename(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) {
    return this.s.rename(u, id, dto, c);
  }

  @Delete('assets/:id')
  @Roles(...WRITE)
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) {
    return this.s.remove(u, id, c);
  }

  @Products('ADS')
  @Get('ad-entities')
  @Roles(...READ)
  entities(@CurrentUser() u: AuthUser, @Query() q: any) {
    return this.s.entities(u, q);
  }

  @Products('ADS')
  @Post('assets/:id/links')
  @Roles(...WRITE)
  link(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) {
    return this.s.link(u, id, dto, c);
  }

  @Products('ADS')
  @Delete('assets/:id/links/:linkId')
  @Roles(...WRITE)
  unlink(@CurrentUser() u: AuthUser, @Param('id') id: string, @Param('linkId') linkId: string, @Query('companyId') c?: string) {
    return this.s.unlink(u, id, linkId, c);
  }

  @Products('CREATIVE')
  @Post('from-design/:designId')
  @Roles(...WRITE)
  fromDesign(@CurrentUser() u: AuthUser, @Param('designId') designId: string, @Query('companyId') c?: string) {
    return this.s.fromDesign(u, designId, c);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [LibraryController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
