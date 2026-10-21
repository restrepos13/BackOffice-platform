import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { ALLOWED_FONTS, DesignDoc, DesignDocError, FORMATS, FormatKey, assetIdsOf, blankDoc, validateDesignDoc } from '../common/design-doc';
import { TEMPLATES, TemplateKey, buildTemplate } from '../common/creative-templates';
import { CATEGORIES, readPolicy, reviewDecision, scheduleProblem } from '../common/creative-policy';
import { imageInfo } from '../common/creative-policy';
import { CREATIVE_COSTS, grantExtraCredits } from '../common/creative-credits';
import { socialAddon, socialUsage } from '../common/social-addon';
import { ensureFile, removeFile, saveFile } from '../common/file-store';
import { AuditModule, AuditService } from './audit.module';

/**
 * BackOffice Creative: identidad de marca, recursos, diseños editables por
 * capas (documento validado y versionado), plantillas, aprobaciones con
 * reglas de autonomía y créditos. Toda lectura y escritura se ata a la
 * empresa de la sesión (plataforma elige empresa); nunca a un id del navegador.
 */

const WRITE = [ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN] as const;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_BYTES = 12 * 1024 * 1024;
const KEEP_VERSIONS = 30;
const HEX = /^#[0-9a-fA-F]{6}$/;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, len: number) => (Array.isArray(v) ? v.map((x) => clip(x, len)).filter(Boolean).slice(0, max) : []);

@Injectable()
export class CreativeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /* ── Acceso ── */

  /** Empresa sobre la que actúa el usuario (la de su sesión; plataforma la elige). Exige plan. */
  async companyOf(user: AuthUser, companyId?: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    if (!company.planId && !isPlatformRole(user.role)) throw new ForbiddenException('Creative viene con tu plan: elige uno en Mi plan');
    return company;
  }

  private async designOf(user: AuthUser, designId: string) {
    const d = await this.prisma.creativeDesign.findUnique({ where: { id: designId } });
    if (!d || (!isPlatformRole(user.role) && d.companyId !== user.companyId)) throw new NotFoundException('Diseño no encontrado');
    return d;
  }

  private async assetOf(user: AuthUser, assetId: string) {
    const a = await this.prisma.brandAsset.findUnique({ where: { id: assetId } });
    if (!a || (!isPlatformRole(user.role) && a.companyId !== user.companyId)) throw new NotFoundException('Recurso no encontrado');
    return a;
  }

  private async pieceOf(user: AuthUser, pieceId: string) {
    const p = await this.prisma.contentPiece.findUnique({ where: { id: pieceId } });
    if (!p || (!isPlatformRole(user.role) && p.companyId !== user.companyId)) throw new NotFoundException('Pieza no encontrada');
    return p;
  }

  /** Las imágenes del diseño tienen que ser recursos de LA MISMA empresa. */
  private async assertAssetsOwned(companyId: string, doc: DesignDoc) {
    const ids = assetIdsOf(doc);
    if (!ids.length) return;
    const owned = await this.prisma.brandAsset.findMany({ where: { id: { in: ids }, companyId }, select: { id: true } });
    const ok = new Set(owned.map((a: any) => a.id));
    const missing = ids.filter((i) => !ok.has(i));
    if (missing.length) throw new BadRequestException('El diseño usa imágenes que no son de tu empresa o ya no existen');
  }

  /* ── Identidad de marca ── */

  private brandView(b: any, company: any) {
    return {
      id: b?.id ?? null,
      version: b?.version ?? 0,
      name: b?.name ?? company.name,
      description: b?.description ?? '',
      logos: parseJson<any[]>(b?.logosJson, []),
      colors: parseJson<any[]>(b?.colorsJson, []),
      fonts: parseJson<string[]>(b?.fontsJson, []),
      tone: b?.tone ?? '',
      vocabulary: parseJson<string[]>(b?.vocabularyJson, []),
      avoidWords: parseJson<string[]>(b?.avoidWordsJson, []),
      audience: b?.audience ?? '',
      products: parseJson<any[]>(b?.productsJson, []),
      ctas: parseJson<string[]>(b?.ctasJson, []),
      offers: parseJson<any[]>(b?.offersJson, []),
      restrictions: parseJson<string[]>(b?.restrictionsJson, []),
      formats: parseJson<string[]>(b?.formatsJson, []),
      protected: parseJson<Record<string, boolean>>(b?.protectedJson, {}),
      policy: readPolicy(parseJson(b?.policyJson, {})),
      suggestions: parseJson<Record<string, any> | null>(b?.suggestionsJson, null),
      updatedAt: b?.updatedAt ?? null,
      updatedBy: b?.updatedBy ?? null,
      allowedFonts: ALLOWED_FONTS,
    };
  }

  async brand(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    return this.brandView(b, company);
  }

  /** Guarda lo que la empresa confirmó. Con versión vieja → 409 (otro la cambió antes). */
  async saveBrand(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const current = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    if (current && Number(dto?.expectedVersion) !== current.version) throw new ConflictException('Alguien más cambió la marca. Recarga para ver la última versión.');
    const logos = (Array.isArray(dto?.logos) ? dto.logos : []).slice(0, 6).map((l: any) => ({ assetId: clip(l?.assetId, 40), label: clip(l?.label, 40) })).filter((l: any) => l.assetId);
    if (logos.length) {
      const owned = await this.prisma.brandAsset.count({ where: { id: { in: logos.map((l: any) => l.assetId) }, companyId: company.id } });
      if (owned !== logos.length) throw new BadRequestException('Algún logo no es un recurso de tu empresa');
    }
    const colors = (Array.isArray(dto?.colors) ? dto.colors : []).slice(0, 8).map((c: any) => ({ hex: clip(c?.hex, 7).toUpperCase(), label: clip(c?.label, 30) })).filter((c: any) => HEX.test(c.hex));
    const fonts = list(dto?.fonts, 3, 40).filter((f) => (ALLOWED_FONTS as readonly string[]).includes(f));
    const offers = (Array.isArray(dto?.offers) ? dto.offers : []).slice(0, 20).map((o: any) => ({
      text: clip(o?.text, 200), price: Number.isFinite(Number(o?.price)) && Number(o.price) > 0 ? Math.round(Number(o.price)) : null,
      validUntil: /^\d{4}-\d{2}-\d{2}$/.test(String(o?.validUntil ?? '')) ? String(o.validUntil) : null,
    })).filter((o: any) => o.text);
    const products = (Array.isArray(dto?.products) ? dto.products : []).slice(0, 60).map((p: any) => ({
      name: clip(p?.name, 80), price: Number.isFinite(Number(p?.price)) && Number(p.price) > 0 ? Math.round(Number(p.price)) : null,
    })).filter((p: any) => p.name);
    const data = {
      name: clip(dto?.name, 80) || company.name,
      description: clip(dto?.description, 600) || null,
      logosJson: JSON.stringify(logos),
      colorsJson: JSON.stringify(colors),
      fontsJson: JSON.stringify(fonts),
      tone: clip(dto?.tone, 200) || null,
      vocabularyJson: JSON.stringify(list(dto?.vocabulary, 30, 40)),
      avoidWordsJson: JSON.stringify(list(dto?.avoidWords, 30, 40)),
      audience: clip(dto?.audience, 400) || null,
      productsJson: JSON.stringify(products),
      ctasJson: JSON.stringify(list(dto?.ctas, 8, 60)),
      offersJson: JSON.stringify(offers),
      restrictionsJson: JSON.stringify(list(dto?.restrictions, 20, 160)),
      formatsJson: JSON.stringify(list(dto?.formats, 6, 20).filter((f) => f in FORMATS)),
      protectedJson: JSON.stringify({ logo: dto?.protected?.logo === true, colors: dto?.protected?.colors === true }),
      updatedBy: user.name,
      updatedAt: new Date(),
    };
    const saved = current
      ? await this.prisma.brandProfile.update({ where: { companyId: company.id }, data: { ...data, version: current.version + 1 } })
      : await this.prisma.brandProfile.create({ data: { ...data, companyId: company.id, version: 1 } });
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.brand_saved', entity: 'BrandProfile', entityId: saved.id, detail: `versión ${saved.version}` });
    return this.brandView(saved, company);
  }

  /**
   * Propuesta inicial de marca a partir de lo que la empresa ya contó (registro,
   * catálogo y asistente), SIN IA y sin tocar lo confirmado: queda como sugerencia.
   */
  async suggestBrand(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const ob = parseJson<Record<string, any>>(company.onboardingJson, {});
    const [bot, products] = await Promise.all([
      this.prisma.bot.findFirst({ where: { companyId: company.id }, select: { personaJson: true } as any }).catch(() => null),
      this.prisma.product.findMany({ where: { companyId: company.id, active: true }, select: { name: true, price: true }, take: 30 }).catch(() => []),
    ]);
    const persona = parseJson<Record<string, any>>((bot as any)?.personaJson, {});
    const suggestion = {
      description: ob.businessType ? `${ob.businessType}${company.city ? ` en ${company.city}` : ''}.` : null,
      tone: persona.tone ?? null,
      colors: company.brandColor && HEX.test(company.brandColor) ? [{ hex: company.brandColor.toUpperCase(), label: 'Principal' }] : [],
      products: (products as any[]).map((p) => ({ name: p.name, price: p.price ?? null })),
      ctas: ['Escríbenos por WhatsApp', 'Pide el tuyo hoy'],
      source: 'Datos de tu registro y tu catálogo (revísalos antes de aceptar)',
      createdAt: new Date().toISOString(),
    };
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    if (b) await this.prisma.brandProfile.update({ where: { companyId: company.id }, data: { suggestionsJson: JSON.stringify(suggestion) } });
    else await this.prisma.brandProfile.create({ data: { companyId: company.id, name: company.name, suggestionsJson: JSON.stringify(suggestion), version: 1 } });
    return suggestion;
  }

  async savePolicy(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const policy = readPolicy(dto);
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    if (b) await this.prisma.brandProfile.update({ where: { companyId: company.id }, data: { policyJson: JSON.stringify(policy), updatedAt: new Date(), updatedBy: user.name } });
    else await this.prisma.brandProfile.create({ data: { companyId: company.id, name: company.name, policyJson: JSON.stringify(policy), version: 1 } });
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.policy_saved', entity: 'BrandProfile', detail: `${policy.paused ? 'EN PAUSA · ' : ''}autonomía ${policy.autonomyEnabled ? `sí (${policy.autoCategories.join(', ') || 'sin categorías'})` : 'no'}` });
    return policy;
  }

  private async policyOf(companyId: string) {
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId }, select: { policyJson: true } });
    return readPolicy(parseJson(b?.policyJson, {}));
  }

  /* ── Recursos de marca ── */

  async assets(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    return this.prisma.brandAsset.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async uploadAsset(user: AuthUser, file: Express.Multer.File | undefined, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    if (!file?.buffer?.length) throw new BadRequestException('Elige una imagen');
    if (file.size > MAX_ASSET_BYTES) throw new BadRequestException('La imagen pesa más de 8 MB');
    // El tipo se lee de los bytes reales, no de lo que dice el navegador (SVG y otros no entran)
    const info = imageInfo(file.buffer);
    if (!info) throw new BadRequestException('Solo PNG, JPG o WEBP');
    if (info.width > 8000 || info.height > 8000) throw new BadRequestException('La imagen es demasiado grande (máx. 8000 px)');
    const count = await this.prisma.brandAsset.count({ where: { companyId: company.id } });
    if (count >= 500) throw new BadRequestException('Llegaste al máximo de 500 recursos: borra los que no uses');
    const ext = info.mime === 'image/png' ? 'png' : info.mime === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `brand-${randomBytes(12).toString('hex')}.${ext}`;
    await saveFile(this.prisma, company.id, fileName, file.buffer, info.mime);
    const asset = await this.prisma.brandAsset.create({
      data: {
        companyId: company.id, kind: ['LOGO', 'IMAGE', 'REFERENCE'].includes(dto?.kind) ? dto.kind : 'IMAGE',
        name: clip(dto?.name, 80) || clip(file.originalname, 80) || 'Imagen', fileName, mimeType: info.mime, sizeBytes: file.size,
        width: info.width, height: info.height, createdBy: user.name,
      },
    });
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.asset_uploaded', entity: 'BrandAsset', entityId: asset.id, detail: asset.name });
    return asset;
  }

  async serveAsset(user: AuthUser, assetId: string, res: Response) {
    const asset = await this.assetOf(user, assetId);
    const path = await ensureFile(this.prisma, asset.companyId, asset.fileName);
    if (!path) throw new NotFoundException('Archivo no disponible');
    res.setHeader('Content-Type', asset.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    createReadStream(path).pipe(res);
  }

  async deleteAsset(user: AuthUser, assetId: string) {
    const asset = await this.assetOf(user, assetId);
    await this.prisma.brandAsset.delete({ where: { id: asset.id } });
    await removeFile(this.prisma, asset.companyId, asset.fileName);
    await this.audit.log({ actor: user, companyId: asset.companyId, action: 'creative.asset_deleted', entity: 'BrandAsset', entityId: asset.id, detail: asset.name });
    return { ok: true };
  }

  /* ── Plantillas y diseños ── */

  templates() {
    return { templates: TEMPLATES, formats: Object.entries(FORMATS).map(([key, f]) => ({ key, ...f })), categories: CATEGORIES, fonts: ALLOWED_FONTS };
  }

  private designView(d: any, withDoc = false) {
    return {
      id: d.id, name: d.name, format: d.format, version: d.version, templateKey: d.templateKey, status: d.status,
      hasExport: !!d.exportFile, updatedAt: d.updatedAt, updatedBy: d.updatedBy, createdAt: d.createdAt,
      ...(withDoc ? { doc: parseJson(d.docJson, null) } : {}),
    };
  }

  async designs(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const rows = await this.prisma.creativeDesign.findMany({ where: { companyId: company.id, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' }, take: 200 });
    return rows.map((d: any) => this.designView(d));
  }

  async design(user: AuthUser, designId: string) {
    return this.designView(await this.designOf(user, designId), true);
  }

  async createDesign(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const format = (dto?.format in FORMATS ? dto.format : 'IG_POST') as FormatKey;
    const tpl = TEMPLATES.find((t) => t.key === dto?.templateKey);
    let doc: DesignDoc;
    if (tpl) {
      const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
      const brand = this.brandView(b, company);
      doc = buildTemplate(tpl.key as TemplateKey, format, {
        name: brand.name, colors: brand.colors.map((c: any) => c.hex), fonts: brand.fonts,
        logoAssetId: brand.logos[0]?.assetId ?? null, cta: brand.ctas[0] ?? null,
      });
    } else doc = blankDoc(format);
    doc = validateDesignDoc(doc, format);
    await this.assertAssetsOwned(company.id, doc);
    const count = await this.prisma.creativeDesign.count({ where: { companyId: company.id, status: 'ACTIVE' } });
    if (count >= 1000) throw new BadRequestException('Tienes demasiados diseños: archiva los que no uses');
    const now = new Date();
    const d = await this.prisma.creativeDesign.create({
      data: {
        companyId: company.id, name: clip(dto?.name, 80) || (tpl ? tpl.name : 'Diseño en blanco'), format, docJson: JSON.stringify(doc),
        version: 1, templateKey: tpl?.key ?? null, createdBy: user.name, updatedBy: user.name, createdAt: now, updatedAt: now,
      },
    });
    await this.prisma.creativeDesignVersion.create({ data: { designId: d.id, companyId: company.id, version: 1, docJson: d.docJson, createdBy: user.name } });
    return this.designView(d, true);
  }

  /**
   * Guarda el documento. Con la versión que el editor tenía abierta: si otro
   * guardó en el medio, 409 (no se pisan cambios). Guarda historial.
   */
  async saveDesign(user: AuthUser, designId: string, dto: any) {
    const d = await this.designOf(user, designId);
    const expected = Number(dto?.expectedVersion);
    if (!Number.isInteger(expected)) throw new BadRequestException('Falta la versión del diseño');
    let doc: DesignDoc;
    try {
      doc = validateDesignDoc(dto?.doc, d.format as FormatKey);
    } catch (err) {
      if (err instanceof DesignDocError) throw new BadRequestException(err.message);
      throw err;
    }
    await this.assertAssetsOwned(d.companyId, doc);
    const docJson = JSON.stringify(doc);
    if (docJson.length > 1_000_000) throw new BadRequestException('El diseño es demasiado grande');
    // Escritura condicional: solo si nadie cambió la versión desde que se abrió
    const res = await this.prisma.creativeDesign.updateMany({
      where: { id: d.id, version: expected },
      data: { docJson, version: expected + 1, updatedBy: user.name, updatedAt: new Date(), ...(dto?.name ? { name: clip(dto.name, 80) } : {}) },
    });
    if (res.count === 0) throw new ConflictException('Este diseño se guardó desde otra pestaña o por otra persona. Recarga para no perder cambios.');
    await this.prisma.creativeDesignVersion.create({ data: { designId: d.id, companyId: d.companyId, version: expected + 1, docJson, createdBy: user.name } });
    // Solo las últimas versiones
    const all = await this.prisma.creativeDesignVersion.findMany({ where: { designId: d.id }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
    const old = [...all].sort((a: any, b: any) => b.version - a.version).slice(KEEP_VERSIONS);
    if (old.length) await this.prisma.creativeDesignVersion.deleteMany({ where: { id: { in: old.map((o: any) => o.id) } } });
    return { id: d.id, version: expected + 1, savedAt: new Date().toISOString() };
  }

  async duplicateDesign(user: AuthUser, designId: string) {
    const d = await this.designOf(user, designId);
    const now = new Date();
    const copy = await this.prisma.creativeDesign.create({
      data: { companyId: d.companyId, name: `${d.name} (copia)`.slice(0, 80), format: d.format, docJson: d.docJson, version: 1, templateKey: d.templateKey, createdBy: user.name, updatedBy: user.name, createdAt: now, updatedAt: now },
    });
    await this.prisma.creativeDesignVersion.create({ data: { designId: copy.id, companyId: copy.companyId, version: 1, docJson: copy.docJson, createdBy: user.name } });
    return this.designView(copy);
  }

  async archiveDesign(user: AuthUser, designId: string) {
    const d = await this.designOf(user, designId);
    await this.prisma.creativeDesign.update({ where: { id: d.id }, data: { status: 'ARCHIVED', updatedAt: new Date(), updatedBy: user.name } });
    return { ok: true };
  }

  async versions(user: AuthUser, designId: string) {
    const d = await this.designOf(user, designId);
    const rows = await this.prisma.creativeDesignVersion.findMany({ where: { designId: d.id }, orderBy: { version: 'desc' }, take: KEEP_VERSIONS, select: { version: true, createdAt: true, createdBy: true } });
    return rows;
  }

  /** Vuelve a una versión anterior (como un guardado nuevo: no se pierde nada). */
  async restoreVersion(user: AuthUser, designId: string, version: number) {
    const d = await this.designOf(user, designId);
    const v = await this.prisma.creativeDesignVersion.findFirst({ where: { designId: d.id, version: Number(version) } });
    if (!v) throw new NotFoundException('Esa versión ya no existe');
    return this.saveDesign(user, d.id, { doc: parseJson(v.docJson, null), expectedVersion: d.version });
  }

  /** El editor exporta PNG/JPEG en el navegador y lo sube: se valida tipo y tamaño exacto del formato. */
  async uploadExport(user: AuthUser, designId: string, file: Express.Multer.File | undefined) {
    const d = await this.designOf(user, designId);
    if (!file?.buffer?.length) throw new BadRequestException('Falta la imagen exportada');
    if (file.size > MAX_EXPORT_BYTES) throw new BadRequestException('La exportación pesa demasiado');
    const info = imageInfo(file.buffer);
    if (!info || info.mime === 'image/webp') throw new BadRequestException('La exportación debe ser PNG o JPEG');
    const f = FORMATS[d.format as FormatKey];
    if (info.width !== f.width || info.height !== f.height) throw new BadRequestException(`La imagen debe medir ${f.width}×${f.height}`);
    const fileName = `design-${d.id}-v${d.version}-${randomBytes(4).toString('hex')}.${info.mime === 'image/png' ? 'png' : 'jpg'}`;
    await saveFile(this.prisma, d.companyId, fileName, file.buffer, info.mime);
    if (d.exportFile) await removeFile(this.prisma, d.companyId, d.exportFile);
    await this.prisma.creativeDesign.update({ where: { id: d.id }, data: { exportFile: fileName, exportMime: info.mime } });
    return { ok: true, version: d.version };
  }

  async serveExport(user: AuthUser, designId: string, res: Response) {
    const d = await this.designOf(user, designId);
    if (!d.exportFile) throw new NotFoundException('Aún no se ha exportado');
    const path = await ensureFile(this.prisma, d.companyId, d.exportFile);
    if (!path) throw new NotFoundException('Archivo no disponible');
    res.setHeader('Content-Type', d.exportMime ?? 'image/png');
    res.setHeader('Cache-Control', 'private, no-cache');
    createReadStream(path).pipe(res);
  }

  /** Lleva el diseño exportado al calendario como pieza en borrador (aún sin aprobar). */
  async toPiece(user: AuthUser, designId: string, dto: any) {
    const d = await this.designOf(user, designId);
    if (!d.exportFile) throw new BadRequestException('Exporta el diseño antes de llevarlo al calendario');
    const category = (CATEGORIES as readonly string[]).includes(dto?.category) ? dto.category : 'OTRO';
    const piece = await this.prisma.contentPiece.create({
      data: {
        companyId: d.companyId, type: 'POST', status: 'BORRADOR', title: clip(dto?.title, 120) || d.name,
        copy: clip(dto?.copy, 2200) || null, assetFile: d.exportFile, assetMime: d.exportMime ?? 'image/png',
        mediaToken: randomBytes(18).toString('hex'), designId: d.id, designVersion: d.version, category,
        campaignId: dto?.campaignId ? await this.campaignOf(d.companyId, dto.campaignId) : null,
      },
    });
    await this.audit.log({ actor: user, companyId: d.companyId, action: 'creative.piece_created', entity: 'ContentPiece', entityId: piece.id, detail: `${d.name} v${d.version}` });
    return { id: piece.id, status: piece.status };
  }

  private async campaignOf(companyId: string, campaignId: string) {
    const c = await this.prisma.marketingCampaign.findFirst({ where: { id: String(campaignId), companyId }, select: { id: true } });
    if (!c) throw new BadRequestException('Esa campaña no es de tu empresa');
    return c.id;
  }

  /* ── Aprobaciones y autonomía ── */

  private async humanApprovedCount(companyId: string) {
    return this.prisma.contentPiece.count({ where: { companyId, approvedAt: { not: null }, autoApproved: false } });
  }

  /** Pide revisión; si las reglas de autonomía lo permiten, queda aprobada sola (con el motivo registrado). */
  async submit(user: AuthUser, pieceId: string, dto: any) {
    const piece = await this.pieceOf(user, pieceId);
    if (['PUBLICADO', 'PUBLICANDO'].includes(piece.status)) throw new BadRequestException('Esta pieza ya se publicó');
    const category = (CATEGORIES as readonly string[]).includes(dto?.category) ? dto.category : piece.category ?? 'OTRO';
    const policy = await this.policyOf(piece.companyId);
    const decision = reviewDecision({ ...piece, category }, policy, await this.humanApprovedCount(piece.companyId));
    const auto = !decision.needsReview;
    await this.prisma.contentPiece.update({
      where: { id: piece.id },
      data: auto
        ? { category, status: 'APROBADO', approvedAt: new Date(), approvedBy: 'Reglas de autonomía', autoApproved: true, reviewNote: null }
        : { category, status: 'EN_REVISION', approvedAt: null, approvedBy: null, autoApproved: null, reviewNote: decision.reasons.join(' · ') },
    });
    await this.audit.log({ actor: user, companyId: piece.companyId, action: auto ? 'creative.auto_approved' : 'creative.submitted', entity: 'ContentPiece', entityId: piece.id, detail: auto ? category : decision.reasons.join(' · ') });
    return { status: auto ? 'APROBADO' : 'EN_REVISION', reasons: decision.reasons };
  }

  async approve(user: AuthUser, pieceId: string) {
    const piece = await this.pieceOf(user, pieceId);
    if (!['EN_REVISION', 'BORRADOR', 'LISTO', 'IDEA'].includes(piece.status)) throw new BadRequestException('Esta pieza no está esperando aprobación');
    await this.prisma.contentPiece.update({ where: { id: piece.id }, data: { status: 'APROBADO', approvedAt: new Date(), approvedBy: user.name, autoApproved: false, reviewNote: null } });
    await this.audit.log({ actor: user, companyId: piece.companyId, action: 'creative.approved', entity: 'ContentPiece', entityId: piece.id, detail: piece.title });
    return { status: 'APROBADO' };
  }

  async reject(user: AuthUser, pieceId: string, dto: any) {
    const piece = await this.pieceOf(user, pieceId);
    await this.prisma.contentPiece.update({ where: { id: piece.id }, data: { status: 'BORRADOR', approvedAt: null, approvedBy: null, autoApproved: null, reviewNote: clip(dto?.note, 400) || 'Pidieron cambios' } });
    await this.audit.log({ actor: user, companyId: piece.companyId, action: 'creative.rejected', entity: 'ContentPiece', entityId: piece.id, detail: clip(dto?.note, 200) });
    return { status: 'BORRADOR' };
  }

  /** Cola de aprobaciones y calendario (con filtros). */
  async calendar(user: AuthUser, q: { companyId?: string; status?: string; from?: string; to?: string; network?: string }) {
    const company = await this.companyOf(user, q.companyId);
    const where: any = { companyId: company.id };
    if (q.status) where.status = String(q.status);
    if (q.from || q.to) where.scheduledAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    if (q.network && ['facebook', 'instagram'].includes(q.network)) where.targetsJson = { contains: q.network };
    const rows = await this.prisma.contentPiece.findMany({ where, orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }], take: 300 });
    return rows.map((p: any) => {
      const { mediaToken: _t, ...rest } = p;
      return { ...rest, targets: parseJson<string[]>(p.targetsJson ?? '[]', []), publishResult: parseJson(p.publishResultJson ?? '{}', {}) };
    });
  }

  /** Validación de reglas antes de programar (la llama el módulo de publicación). */
  async assertCanSchedule(piece: any, when: Date) {
    if (!piece.approvedAt) throw new BadRequestException('Esta pieza necesita aprobación antes de programarse');
    const policy = await this.policyOf(piece.companyId);
    const company = await this.prisma.company.findUnique({ where: { id: piece.companyId }, select: { timezone: true } });
    const dayStart = new Date(when.getTime() - 12 * 3600e3);
    const dayEnd = new Date(when.getTime() + 12 * 3600e3);
    const sameDay = await this.prisma.contentPiece.count({ where: { companyId: piece.companyId, id: { not: piece.id }, status: { in: ['PROGRAMADO', 'PUBLICANDO', 'PUBLICADO'] }, scheduledAt: { gte: dayStart, lte: dayEnd } } });
    const problem = scheduleProblem(when, company?.timezone ?? 'America/Bogota', policy, sameDay);
    if (problem) throw new BadRequestException(problem);
    return policy;
  }

  /* ── Créditos ── */

  async credits(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const [usage, wallet, moves] = await Promise.all([
      socialUsage(this.prisma, company.id),
      this.prisma.creativeWallet.findUnique({ where: { companyId: company.id } }),
      this.prisma.creativeCreditMove.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);
    const addon = socialAddon(company);
    return {
      monthly: { limit: addon.enabled ? addon.credits : 0, used: usage.credits, left: Math.max(0, (addon.enabled ? addon.credits : 0) - usage.credits) },
      extra: wallet?.extraCredits ?? 0,
      costs: CREATIVE_COSTS,
      moves: moves.map((m: any) => ({ id: m.id, kind: m.kind, operation: m.operation, credits: m.credits, bucket: m.bucket, resourceType: m.resourceType, note: m.note, createdAt: m.createdAt })),
    };
  }

  async grant(user: AuthUser, companyId: string, dto: any) {
    const credits = Math.round(Number(dto?.credits));
    if (!(credits > 0 && credits <= 10000)) throw new BadRequestException('Créditos inválidos');
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const key = clip(dto?.reference, 80) ? `grant:${companyId}:${clip(dto.reference, 80)}` : `grant:${companyId}:${randomBytes(6).toString('hex')}`;
    const ok = await grantExtraCredits(this.prisma, companyId, credits, key, clip(dto?.note, 200) || `Por ${user.name}`);
    await this.audit.log({ actor: user, companyId, action: 'creative.credits_granted', entity: 'CreativeWallet', detail: `${credits} créditos · ${ok ? 'aplicado' : 'ya estaba aplicado'}` });
    return { ok, credits };
  }
}

@Controller('creative')
export class CreativeController {
  constructor(private readonly creative: CreativeService) {}

  @Get('templates')
  templates() {
    return this.creative.templates();
  }

  @Get('brand')
  brand(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.brand(user, companyId);
  }

  @Put('brand')
  @Roles(...WRITE)
  saveBrand(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.saveBrand(user, dto, companyId);
  }

  @Post('brand/suggest')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  suggest(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.suggestBrand(user, companyId);
  }

  @Put('policy')
  @Roles(...WRITE)
  policy(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.savePolicy(user, dto, companyId);
  }

  @Get('assets')
  assets(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.assets(user, companyId);
  }

  @Post('assets')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_ASSET_BYTES, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.uploadAsset(user, file, dto, companyId);
  }

  @Get('assets/:id/file')
  assetFile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    return this.creative.serveAsset(user, id, res);
  }

  @Delete('assets/:id')
  @Roles(...WRITE)
  deleteAsset(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.deleteAsset(user, id);
  }

  @Get('designs')
  designs(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.designs(user, companyId);
  }

  @Post('designs')
  @Roles(...WRITE)
  createDesign(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.createDesign(user, dto, companyId);
  }

  @Get('designs/:id')
  design(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.design(user, id);
  }

  @Put('designs/:id')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  saveDesign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.saveDesign(user, id, dto);
  }

  @Post('designs/:id/duplicate')
  @Roles(...WRITE)
  duplicate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.duplicateDesign(user, id);
  }

  @Delete('designs/:id')
  @Roles(...WRITE)
  archive(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.archiveDesign(user, id);
  }

  @Get('designs/:id/versions')
  versions(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.versions(user, id);
  }

  @Post('designs/:id/versions/:version/restore')
  @Roles(...WRITE)
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('version') version: string) {
    return this.creative.restoreVersion(user, id, Number(version));
  }

  @Post('designs/:id/export')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_EXPORT_BYTES, files: 1 } }))
  uploadExport(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File) {
    return this.creative.uploadExport(user, id, file);
  }

  @Get('designs/:id/export')
  exportFile(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    return this.creative.serveExport(user, id, res);
  }

  @Post('designs/:id/to-piece')
  @Roles(...WRITE)
  toPiece(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.toPiece(user, id, dto);
  }

  @Get('calendar')
  calendar(@CurrentUser() user: AuthUser, @Query() q: any) {
    return this.creative.calendar(user, q);
  }

  @Post('pieces/:id/submit')
  @Roles(...WRITE)
  submit(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.submit(user, id, dto);
  }

  @Post('pieces/:id/approve')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.creative.approve(user, id);
  }

  @Post('pieces/:id/reject')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.reject(user, id, dto);
  }

  @Get('credits')
  credits(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.credits(user, companyId);
  }

  @Post('credits/:companyId/grant')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  grant(@CurrentUser() user: AuthUser, @Param('companyId') companyId: string, @Body() dto: any) {
    return this.creative.grant(user, companyId, dto);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [CreativeController],
  providers: [CreativeService],
  exports: [CreativeService],
})
export class CreativeModule {}
