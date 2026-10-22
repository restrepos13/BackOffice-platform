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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ensureFile, mirrorFile, removeFile } from '../common/file-store';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { Response } from 'express';
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
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

/**
 * Galería de medios: fotos que la empresa carga para que la IA (o un agente)
 * las envíe por chat. Seguridad:
 *  - Solo imágenes (jpeg/png/webp/gif), máx. 10 MB.
 *  - Nombre de archivo aleatorio; jamás se usa el nombre original en disco.
 *  - El archivo se sirve SOLO vía endpoint autenticado con control de tenant.
 */
const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MAX_SIZE = 10 * 1024 * 1024;

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private serialize(m: any) {
    return { ...m, tags: parseJson<string[]>(m.tagsJson, []) };
  }

  private async assertAccess(user: AuthUser, id: string) {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Archivo no encontrado');
    if (!isPlatformRole(user.role) && asset.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return asset;
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const assets = await this.prisma.mediaAsset.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { integration: { select: { id: true, name: true } } },
    });
    return assets.map((m) => this.serialize(m));
  }

  async upload(user: AuthUser, file: Express.Multer.File, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    if (!file) throw new BadRequestException('Falta el archivo');
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) {
      throw new BadRequestException('Solo imágenes JPG, PNG, WebP o GIF');
    }
    if (file.size > MAX_SIZE) {
      throw new BadRequestException('Máximo 10 MB por imagen');
    }

    const dir = join(UPLOADS_DIR, companyId);
    mkdirSync(dir, { recursive: true });
    const fileName = `${randomBytes(16).toString('hex')}.${ext}`;
    writeFileSync(join(dir, fileName), file.buffer);
    await mirrorFile(this.prisma, companyId, fileName, file.buffer, file.mimetype);

    const asset = await this.prisma.mediaAsset.create({
      data: {
        companyId,
        integrationId: dto.integrationId || null,
        name: (dto.name || file.originalname || 'Imagen').slice(0, 120),
        fileName,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        priceUsd: dto.priceUsd ? Number(dto.priceUsd) : 0,
        tagsJson: JSON.stringify(
          typeof dto.tags === 'string'
            ? dto.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
            : (dto.tags ?? []),
        ),
      },
    });
    await this.audit.log({
      actor: user, companyId, action: 'media.upload', entity: 'MediaAsset',
      entityId: asset.id, detail: asset.name,
    });
    return this.serialize(asset);
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    const asset = await this.prisma.mediaAsset.update({
      where: { id },
      data: {
        name: dto.name,
        integrationId: dto.integrationId === '' ? null : dto.integrationId,
        priceUsd: dto.priceUsd != null ? Number(dto.priceUsd) : undefined,
        active: dto.active,
        ...(dto.tags ? { tagsJson: JSON.stringify(dto.tags) } : {}),
      },
    });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'media.update',
      entity: 'MediaAsset', entityId: id, detail: asset.name,
    });
    return this.serialize(asset);
  }

  async remove(user: AuthUser, id: string) {
    const asset = await this.assertAccess(user, id);
    await this.prisma.mediaAsset.delete({ where: { id } });
    await removeFile(this.prisma, asset.companyId, asset.fileName);
    await this.audit.log({
      actor: user, companyId: asset.companyId, action: 'media.delete',
      entity: 'MediaAsset', entityId: id, detail: asset.name,
    });
    return { ok: true };
  }

  /** Sirve el binario con control de acceso por tenant. */
  async serveFile(user: AuthUser, id: string, res: Response) {
    const asset = await this.assertAccess(user, id);
    const path = await ensureFile(this.prisma, asset.companyId, asset.fileName);
    if (!path) throw new NotFoundException('Archivo no disponible');
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Disposition', 'inline');
    createReadStream(path).pipe(res);
  }
}

@Products('AUTOMATION')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.media.list(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SIZE } }))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: any,
  ) {
    return this.media.upload(user, file, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.media.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.media.remove(user, id);
  }

  @Get(':id/file')
  serveFile(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    return this.media.serveFile(user, id, res);
  }
}

@Module({
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
