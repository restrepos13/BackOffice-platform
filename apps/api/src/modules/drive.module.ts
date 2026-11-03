import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, Post, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { decryptSecret, encryptSecret } from '../common/crypto';
import { signState, verifyState } from '../common/meta-publish';
import { publicWebUrl } from '../common/tracking';
import { GoogleApiError, type GoogleApp, authUrl, exchangeCode, refreshAccess, revokeToken } from '../common/google-calendar';
import { DRIVE_MEDIA, DRIVE_SCOPES, type BinFetch, download, driveEmail, fileMeta } from '../common/google-drive';
import { AuditModule, AuditService } from './audit.module';
import { LibraryModule, LibraryService, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './library.module';

/**
 * Google Drive de la empresa → Biblioteca. La empresa conecta SU cuenta de
 * Google con drive.file y elige en el selector de Google (Picker) las fotos y
 * videos que quiere traer: BackOffice solo ve esos archivos, no el resto de su
 * Drive, y no escribe ni borra nada. La autorización se guarda cifrada
 * (Integration GOOGLE_DRIVE).
 */

const TYPE = 'GOOGLE_DRIVE';

@Injectable()
export class DriveService {
  private readonly logger = new Logger('Drive');
  fetchImpl: BinFetch = (u, i) => fetch(u, i) as any;
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly library: LibraryService,
  ) {}

  private companyIdOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    return id;
  }

  private async setting(key: string) {
    const row = await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
    return row?.value?.trim() || process.env[key] || '';
  }

  async app(): Promise<GoogleApp | null> {
    const clientId = await this.setting('GOOGLE_CLIENT_ID');
    const clientSecret = await this.setting('GOOGLE_CLIENT_SECRET');
    if (!clientId || !clientSecret) return null;
    const base = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    return { clientId, clientSecret, redirectUri: `${base}/api/public/drive/callback` };
  }

  private async row(companyId: string) {
    return this.prisma.integration.findFirst({ where: { companyId, type: TYPE } });
  }

  private cfg(row: any) {
    return parseJson<Record<string, any>>(row?.configJson, {});
  }

  /** Token vigente (se renueva solo); si Google lo revocó, la conexión queda pidiendo reconectar. */
  private async token(row: any): Promise<string> {
    const c = this.cfg(row);
    if (c.accessTokenEnc && c.accessExpiresAt && new Date(c.accessExpiresAt).getTime() > this.now().getTime() + 60_000) return decryptSecret(c.accessTokenEnc);
    const app = await this.app();
    if (!app) throw new BadRequestException('Google Drive aún no está habilitado en BackOffice.');
    if (!c.refreshTokenEnc) throw new BadRequestException('Vuelve a conectar Google Drive.');
    try {
      const r = await refreshAccess(app, decryptSecret(c.refreshTokenEnc), this.fetchImpl as any);
      const next = { ...c, accessTokenEnc: encryptSecret(r.accessToken), accessExpiresAt: new Date(this.now().getTime() + r.expiresIn * 1000).toISOString() };
      await this.prisma.integration.update({ where: { id: row.id }, data: { configJson: JSON.stringify(next) } });
      return r.accessToken;
    } catch (err) {
      if (err instanceof GoogleApiError && err.kind === 'AUTH') {
        await this.prisma.integration.update({ where: { id: row.id }, data: { status: 'ERROR', errorMsg: 'Google retiró el permiso: vuelve a conectar Drive.' } });
        throw new BadRequestException('Google retiró el permiso de BackOffice: vuelve a conectar Drive.');
      }
      throw err;
    }
  }

  private fail(err: unknown): never {
    if (err instanceof GoogleApiError) {
      if (err.kind === 'NOT_FOUND') throw new NotFoundException('Ese archivo ya no está en tu Drive.');
      if (err.kind === 'AUTH') throw new BadRequestException('Tu cuenta de Google ya no da acceso a ese archivo: vuelve a conectar Drive.');
      throw new BadRequestException(`Google Drive no respondió: ${err.message}`);
    }
    throw err;
  }

  async status(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const [row, app] = await Promise.all([this.row(id), this.app()]);
    const c = this.cfg(row);
    return {
      available: !!app,
      connected: !!row && row.status === 'CONNECTED',
      needsReconnect: row?.status === 'ERROR',
      email: c.email ?? null,
    };
  }

  async start(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const app = await this.app();
    if (!app) throw new BadRequestException('Google Drive aún no está habilitado en BackOffice (falta configurar la app de Google). Pídeselo al equipo.');
    const state = signState({ c: id, u: user.id, k: 'gdrive' }, process.env.JWT_SECRET ?? 'dev');
    return { url: authUrl(app, state, DRIVE_SCOPES) };
  }

  async callback(code?: string, state?: string, error?: string): Promise<string> {
    const web = (await publicWebUrl(this.prisma)).replace(/\/$/, '');
    const back = (r: string) => `${web}/app/biblioteca?drive=${r}`;
    const data = verifyState<{ c: string; u: string; k: string }>(String(state ?? ''), process.env.JWT_SECRET ?? 'dev');
    if (!data || data.k !== 'gdrive') return back('error');
    if (error || !code) return back(error === 'access_denied' ? 'cancelado' : 'error');
    const app = await this.app();
    if (!app) return back('error');
    try {
      const t = await exchangeCode(app, code, this.fetchImpl as any);
      if (!t.scope.split(' ').includes(DRIVE_SCOPES[0])) return back('permisos');
      const existing = await this.row(data.c);
      const old = this.cfg(existing);
      const refresh = t.refreshToken ?? (old.refreshTokenEnc ? decryptSecret(old.refreshTokenEnc) : null);
      if (!refresh) return back('error');
      const email = await driveEmail(t.accessToken, this.fetchImpl).catch(() => null);
      const config = {
        provider: 'GOOGLE', email,
        refreshTokenEnc: encryptSecret(refresh), accessTokenEnc: encryptSecret(t.accessToken),
        accessExpiresAt: new Date(this.now().getTime() + t.expiresIn * 1000).toISOString(),
      };
      if (existing) await this.prisma.integration.update({ where: { id: existing.id }, data: { status: 'CONNECTED', errorMsg: null, configJson: JSON.stringify(config) } });
      else await this.prisma.integration.create({ data: { companyId: data.c, type: TYPE, name: 'Google Drive', status: 'CONNECTED', configJson: JSON.stringify(config) } });
      await this.audit.log({ actor: null, companyId: data.c, action: 'drive.connected', entity: 'Integration', entityId: data.c, detail: email ?? 'cuenta de Google' });
      return back('listo');
    } catch (err: any) {
      this.logger.warn(`OAuth Google Drive: ${err?.kind ?? ''} ${String(err?.message ?? '').slice(0, 120)}`);
      return back('error');
    }
  }

  private async connected(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const row = await this.row(id);
    if (!row || row.status !== 'CONNECTED') throw new BadRequestException('Conecta primero tu Google Drive');
    return { id, row };
  }

  /**
   * Lo que necesita el selector de Google en el navegador: un token de acceso
   * de corta duración (con drive.file solo abre lo que el cliente elija), el
   * número del proyecto de Google (para que lo elegido quede compartido con
   * BackOffice) y, si está configurada, la clave de API del selector.
   */
  async picker(user: AuthUser, companyId?: string) {
    const { row } = await this.connected(user, companyId);
    const app = await this.app();
    const appId = /^(\d+)-/.exec(app?.clientId ?? '')?.[1] ?? null;
    try {
      return { accessToken: await this.token(row), appId, developerKey: (await this.setting('GOOGLE_PICKER_API_KEY')) || null };
    } catch (err) { this.fail(err); }
  }

  /** Trae a la biblioteca los archivos elegidos en el selector; valida tipo y tamaño como cualquier subida. */
  async import(user: AuthUser, dto: { fileIds?: unknown }, companyId?: string) {
    const { id, row } = await this.connected(user, companyId);
    const ids = (Array.isArray(dto?.fileIds) ? dto.fileIds : []).map(String).filter((x) => /^[\w-]{1,200}$/.test(x)).slice(0, 20);
    if (!ids.length) throw new BadRequestException('Elige al menos un archivo');
    const token = await this.token(row);
    const out: Array<{ fileId: string; ok: boolean; assetId?: string; duplicate?: boolean; error?: string }> = [];
    for (const fileId of ids) {
      try {
        const meta = await fileMeta(token, fileId, this.fetchImpl);
        if (!DRIVE_MEDIA.includes(meta.mimeType)) throw new BadRequestException('Solo imágenes (JPG, PNG, WEBP) y videos (MP4, MOV)');
        const max = meta.mimeType.startsWith('video/') ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        if (meta.size && meta.size > max) throw new BadRequestException(`Pesa más de ${Math.round(max / 1024 / 1024)} MB`);
        const buffer = await download(token, fileId, max, this.fetchImpl);
        const res: any = await this.library.upload(user, { buffer, size: buffer.length, originalname: meta.name } as any, { name: meta.name.replace(/\.[^.]+$/, ''), kind: 'IMAGE', module: 'CREATIVE' }, id);
        if (!res.duplicate) await this.prisma.brandAsset.update({ where: { id: res.asset.id }, data: { source: 'DRIVE', externalId: fileId } });
        out.push({ fileId, ok: true, assetId: res.asset.id, duplicate: !!res.duplicate });
      } catch (err: any) {
        out.push({ fileId, ok: false, error: err instanceof GoogleApiError ? `Drive: ${err.message}` : String(err?.response?.message ?? err?.message ?? 'Error').slice(0, 160) });
      }
    }
    await this.audit.log({ actor: user, companyId: id, action: 'drive.import', entity: 'BrandAsset', entityId: id, detail: `${out.filter((o) => o.ok).length} de ${ids.length} archivo(s)` });
    return { results: out };
  }

  async disconnect(user: AuthUser, companyId?: string) {
    const id = this.companyIdOf(user, companyId);
    const row = await this.row(id);
    if (!row) return { ok: true };
    const c = this.cfg(row);
    // Se le quita el permiso a BackOffice en Google; lo ya traído a la biblioteca se queda
    if (c.refreshTokenEnc) await revokeToken(decryptSecret(c.refreshTokenEnc), this.fetchImpl as any).catch(() => undefined);
    await this.prisma.integration.delete({ where: { id: row.id } });
    await this.audit.log({ actor: user, companyId: id, action: 'drive.disconnected', entity: 'Integration', entityId: row.id });
    return { ok: true };
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('CREATIVE', 'ADS')
@Controller('drive')
export class DriveController {
  constructor(private readonly s: DriveService) {}

  @Get() @Roles(...READ)
  status(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.status(u, c); }

  @Post('connect') @Roles(...WRITE)
  connect(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.start(u, c); }

  @Post('picker') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 20 } })
  picker(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.picker(u, c); }

  @Post('import') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 10 } })
  import(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.import(u, dto, c); }

  @Delete() @Roles(...WRITE)
  disconnect(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.disconnect(u, c); }
}

@Controller('public/drive')
export class DrivePublicController {
  constructor(private readonly s: DriveService) {}

  @Public()
  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string, @Query('error') error: string, @Res() res: Response) {
    res.redirect(await this.s.callback(code, state, error));
  }
}

@Module({
  imports: [AuditModule, LibraryModule],
  controllers: [DriveController, DrivePublicController],
  providers: [DriveService],
})
export class DriveModule {}
