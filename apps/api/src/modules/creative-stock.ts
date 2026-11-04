import { BadRequestException, Body, Controller, Get, Inject, Injectable, Logger, Post, Query, forwardRef } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { Products } from '../auth/products.guard';
import { AuthUser, ROLES } from '../common/constants';
import { imageInfo } from '../common/creative-policy';
import { saveFile } from '../common/file-store';
import { AuditService } from './audit.module';
import { CreativeService } from './creative.module';

/**
 * Fotos gratis de Pexels para el editor (https://www.pexels.com/api/).
 * La clave de la API vive solo en el servidor (Dev Tools → PEXELS_API_KEY);
 * el navegador busca a través de BackOffice y, al elegir una foto, BackOffice
 * la descarga y la guarda como recurso de la empresa (así el lienzo no queda
 * «contaminado» al exportar y la foto sigue disponible aunque Pexels cambie).
 * Licencia de Pexels: uso comercial permitido, sin atribución obligatoria;
 * igual se guarda el nombre del fotógrafo.
 */

const KEY = 'PEXELS_API_KEY';
const API = 'https://api.pexels.com/v1';
/** Solo se descargan imágenes de este dominio (nada de URLs arbitrarias). */
const IMG_HOST = 'images.pexels.com';
const PER_PAGE = 24;
const MAX_BYTES = 8 * 1024 * 1024;

export interface StockPhoto { id: number; width: number; height: number; alt: string; photographer: string; photographerUrl: string; url: string; thumb: string; avgColor: string | null }

type BinFetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; arrayBuffer(): Promise<ArrayBuffer>; headers?: { get(k: string): string | null } }>;

function view(p: any): StockPhoto {
  return {
    id: Number(p.id), width: Number(p.width) || 0, height: Number(p.height) || 0, alt: String(p.alt ?? '').slice(0, 160),
    photographer: String(p.photographer ?? 'Pexels').slice(0, 80), photographerUrl: String(p.photographer_url ?? 'https://www.pexels.com'),
    url: String(p.url ?? 'https://www.pexels.com'), thumb: String(p.src?.medium ?? p.src?.small ?? ''), avgColor: /^#[0-9A-Fa-f]{6}$/.test(p.avg_color ?? '') ? p.avg_color : null,
  };
}

@Injectable()
export class CreativeStockService {
  private readonly logger = new Logger('Pexels');
  fetchImpl: BinFetch = (u, i) => fetch(u, i) as any;
  /** Búsquedas recientes (la cuota gratis de Pexels es de 200 por hora): misma búsqueda, misma respuesta por una hora */
  private cache = new Map<string, { at: number; data: { photos: StockPhoto[]; hasMore: boolean } }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(forwardRef(() => CreativeService)) private readonly creative: CreativeService,
  ) {}

  private async key() {
    const row = await this.prisma.platformSetting.findUnique({ where: { key: KEY } }).catch(() => null);
    return row?.value?.trim() || process.env[KEY] || '';
  }

  async status() {
    return { configured: !!(await this.key()) };
  }

  private async call(path: string) {
    const key = await this.key();
    if (!key) throw new BadRequestException('Las fotos gratis todavía no están activadas en BackOffice.');
    let res;
    try {
      res = await this.fetchImpl(`${API}${path}`, { headers: { Authorization: key } });
    } catch {
      throw new BadRequestException('No hubo conexión con Pexels. Intenta de nuevo.');
    }
    if (res.status === 429) throw new BadRequestException('Pexels pidió esperar un momento (límite de búsquedas). Intenta en unos minutos.');
    if (res.status === 404) throw new BadRequestException('Esa foto ya no está en Pexels.');
    if (!res.ok) {
      this.logger.warn(`Pexels respondió ${res.status}`);
      throw new BadRequestException('Pexels no respondió bien. Intenta de nuevo.');
    }
    return res.json();
  }

  async search(user: AuthUser, q: { q?: string; page?: string; orientation?: string; companyId?: string }) {
    await this.creative.companyOf(user, q.companyId, ['CREATIVE', 'ADS']);
    const query = String(q.q ?? '').trim().slice(0, 80);
    if (!query) return { configured: !!(await this.key()), photos: [], hasMore: false };
    const page = Math.min(50, Math.max(1, Math.floor(Number(q.page) || 1)));
    const orientation = ['landscape', 'portrait', 'square'].includes(String(q.orientation)) ? String(q.orientation) : '';
    const ck = `${query.toLowerCase()}|${page}|${orientation}`;
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < 3600_000) return { configured: true, ...hit.data };
    const params = new URLSearchParams({ query, page: String(page), per_page: String(PER_PAGE), locale: 'es-ES', ...(orientation ? { orientation } : {}) });
    const r = await this.call(`/search?${params}`);
    const data = { photos: ((r?.photos ?? []) as any[]).map(view).filter((p) => p.thumb.startsWith(`https://${IMG_HOST}/`)), hasMore: !!r?.next_page };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(ck, { at: Date.now(), data });
    return { configured: true, ...data };
  }

  /** Trae una foto a los recursos de la empresa (una sola vez por foto). */
  async import(user: AuthUser, dto: { id?: unknown }, companyId?: string) {
    const company = await this.creative.companyOf(user, companyId, ['CREATIVE', 'ADS']);
    const id = Math.floor(Number(dto?.id));
    if (!Number.isFinite(id) || id <= 0 || id > 1e12) throw new BadRequestException('Foto inválida');
    const externalId = `pexels:${id}`;
    const existing = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, externalId } });
    if (existing) return existing;
    const count = await this.prisma.brandAsset.count({ where: { companyId: company.id } });
    if (count >= 500) throw new BadRequestException('Llegaste al máximo de 500 recursos: borra los que no uses');
    // Los datos se piden a Pexels por id: el navegador nunca elige la URL que se descarga
    const p = await this.call(`/photos/${id}`);
    const original = String(p?.src?.original ?? '');
    let url: URL;
    try { url = new URL(original); } catch { throw new BadRequestException('Pexels no entregó la foto'); }
    if (url.protocol !== 'https:' || url.hostname !== IMG_HOST) throw new BadRequestException('Pexels no entregó la foto');
    // Versión comprimida de hasta 2000 px: suficiente para publicaciones y anuncios
    url.search = new URLSearchParams({ auto: 'compress', cs: 'tinysrgb', w: '2000' }).toString();
    let res;
    try { res = await this.fetchImpl(url.toString()); } catch { throw new BadRequestException('No se pudo descargar la foto de Pexels'); }
    if (!res.ok) throw new BadRequestException('No se pudo descargar la foto de Pexels');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_BYTES) throw new BadRequestException('La foto pesa demasiado');
    const info = imageInfo(buffer);
    if (!info) throw new BadRequestException('Pexels entregó un archivo que no es una imagen');
    const ext = info.mime === 'image/png' ? 'png' : info.mime === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `stock-${randomBytes(12).toString('hex')}.${ext}`;
    await saveFile(this.prisma, company.id, fileName, buffer, info.mime);
    const v = view(p);
    const name = `${v.alt || 'Foto'} · ${v.photographer} (Pexels)`.slice(0, 80);
    const asset = await this.prisma.brandAsset.create({
      data: {
        companyId: company.id, kind: 'IMAGE', name, fileName, mimeType: info.mime, sizeBytes: buffer.length, width: info.width, height: info.height,
        createdBy: user.name, source: 'STOCK', originModule: 'CREATIVE', externalId, sha256: createHash('sha256').update(buffer).digest('hex'),
      },
    });
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.stock_imported', entity: 'BrandAsset', entityId: asset.id, detail: `${externalId} · ${v.photographer}` });
    return asset;
  }
}

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const READ = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER] as const;

@Products('CREATIVE', 'ADS')
@Controller('creative/stock')
export class CreativeStockController {
  constructor(private readonly s: CreativeStockService) {}

  @Get('status') @Roles(...READ)
  status() { return this.s.status(); }

  @Get('search') @Roles(...READ) @Throttle({ default: { ttl: 60_000, limit: 40 } })
  search(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.search(u, q); }

  @Post('import') @Roles(...WRITE) @Throttle({ default: { ttl: 60_000, limit: 20 } })
  import(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.import(u, dto, c); }
}
