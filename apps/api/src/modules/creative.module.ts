import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException,
  Param, Patch, Post, Put, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { createHash, randomBytes } from 'crypto';
import { createReadStream, readFileSync } from 'fs';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { ALLOWED_FONTS, DesignDoc, DesignDocError, FORMATS, FormatKey, assetIdsOf, blankDoc, validateDesignDoc } from '../common/design-doc';
import { TEMPLATES, TemplateKey, buildTemplate } from '../common/creative-templates';
import { CATEGORIES, readPolicy, reviewDecision, scheduleProblem } from '../common/creative-policy';
import { imageInfo } from '../common/creative-policy';
import { CREATIVE_COSTS, grantExtraCredits } from '../common/creative-credits';
import { socialAddon, socialUsage } from '../common/social-addon';
import { ensureFile, removeFile, saveFile } from '../common/file-store';
import { profileOfCompany } from '../common/business-profile';
import { resolveIdentity, sanitizeVisual, suggestVisual, ResolvedIdentity } from '../common/creative/identity';
import { AssetDims, Content, FAMILIES, Family, seedHash, tokensFor } from '../common/creative/compose';
import { CATALOG as ART_CATALOG, GOALS, GOAL_LABEL, Goal, propose } from '../common/creative/art-direction';
import { checkQuality } from '../common/creative/quality';
import { fingerprint } from '../common/creative/similarity';
import { adaptDesign, readComposition } from '../common/creative/adapt';
import { LibraryModule } from './library.module';
import { CreativeCreateController, CreativeCreateService } from './creative-create';
import { AI_PROVIDER } from '../ai/types';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { AuditModule, AuditService } from './audit.module';
import { Products } from '../auth/products.guard';
import { assertAssetDeletable } from './library.module';
import { ProductInactiveError, hasProduct } from '../common/products';

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
    if (!isPlatformRole(user.role) && !hasProduct(company, 'CREATIVE')) throw new ForbiddenException(ProductInactiveError.body(['CREATIVE'], company));
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
    // El editor trabaja con imágenes: los videos de la biblioteca (Ads Intelligence) no aparecen aquí
    const rows = await this.prisma.brandAsset.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'desc' }, take: 300 });
    return rows.filter((a: any) => String(a.mimeType).startsWith('image/')).slice(0, 200);
  }

  /** Productos del catálogo (los de Pedidos/Menú), con si tienen foto. */
  async catalogProducts(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const rows = await this.prisma.product.findMany({ where: { companyId: company.id, active: true, ...NOT_DELETED }, select: { id: true, name: true, price: true, imageFile: true }, orderBy: { name: 'asc' }, take: 300 });
    return rows.map((r) => ({ id: r.id, name: r.name, price: r.price ?? null, hasImage: !!r.imageFile }));
  }

  /**
   * Usa la foto de un producto del catálogo en Creative. Se COPIA como recurso
   * (así borrar el recurso nunca rompe la foto del menú). Si ya se copió, se reutiliza.
   */
  async assetFromProduct(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const product = await this.prisma.product.findUnique({ where: { id: String(dto?.productId ?? '') } });
    if (!product || product.companyId !== company.id) throw new NotFoundException('Producto no encontrado');
    if (!product.imageFile) throw new BadRequestException('Ese producto no tiene foto en el catálogo');
    const name = `Producto · ${product.name}`.slice(0, 80);
    const existing = await this.prisma.brandAsset.findFirst({ where: { companyId: company.id, kind: 'IMAGE', name, createdBy: 'Catálogo' } });
    if (existing) return existing;
    const path = await ensureFile(this.prisma, company.id, product.imageFile);
    if (!path) throw new NotFoundException('La foto del producto no está disponible');
    const buffer = readFileSync(path);
    const info = imageInfo(buffer);
    if (!info) throw new BadRequestException('La foto del producto no es PNG, JPG o WEBP');
    const ext = info.mime === 'image/png' ? 'png' : info.mime === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `brand-${randomBytes(12).toString('hex')}.${ext}`;
    await saveFile(this.prisma, company.id, fileName, buffer, info.mime);
    return this.prisma.brandAsset.create({
      data: { companyId: company.id, kind: 'IMAGE', name, fileName, mimeType: info.mime, sizeBytes: buffer.length, width: info.width, height: info.height, createdBy: 'Catálogo', source: 'CATALOG', originModule: 'CREATIVE', sha256: createHash('sha256').update(buffer).digest('hex') },
    });
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
        source: 'UPLOAD', originModule: 'CREATIVE', sha256: createHash('sha256').update(file.buffer).digest('hex'),
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
    await assertAssetDeletable(this.prisma, asset.companyId, asset.id);
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
      composition: readComposition(d.compositionJson),
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
    // Desde una propuesta de dirección de arte: el documento llega armado y se valida igual que cualquier guardado
    const comp = dto?.doc && dto?.composition && (FAMILIES as readonly string[]).includes(dto.composition.family)
      ? { family: dto.composition.family as Family, variant: Number(dto.composition.variant) || 0, goal: String(dto.composition.goal ?? '').slice(0, 20), seed: Number(dto.composition.seed) || 0 }
      : null;
    if (comp) {
      try { doc = validateDesignDoc(dto.doc, format); } catch (e) { throw new BadRequestException(e instanceof DesignDocError ? e.message : 'Diseño inválido'); }
    } else if (tpl) {
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
        companyId: company.id, name: clip(dto?.name, 80) || (comp ? ART_CATALOG[comp.family].label : tpl ? tpl.name : 'Diseño en blanco'), format, docJson: JSON.stringify(doc),
        version: 1, templateKey: tpl?.key ?? null, compositionJson: comp ? JSON.stringify(comp) : null, createdBy: user.name, updatedBy: user.name, createdAt: now, updatedAt: now,
      },
    });
    await this.prisma.creativeDesignVersion.create({ data: { designId: d.id, companyId: company.id, version: 1, docJson: d.docJson, createdBy: user.name } });
    if (comp) await this.event(company.id, 'composition_selected', d.id, comp.family, { goal: comp.goal, variant: comp.variant, format });
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
      data: { companyId: d.companyId, name: `${d.name} (copia)`.slice(0, 80), format: d.format, docJson: d.docJson, version: 1, templateKey: d.templateKey, compositionJson: d.compositionJson ?? null, createdBy: user.name, updatedBy: user.name, createdAt: now, updatedAt: now },
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
  /* ── Dirección de arte ── */

  private async event(companyId: string, type: string, designId: string | null, family: string | null, data: Record<string, unknown> = {}) {
    await this.prisma.creativeEvent.create({ data: { companyId, designId, type, family, dataJson: JSON.stringify(data).slice(0, 2000) } }).catch(() => undefined);
  }

  /** Todo lo que la dirección de arte necesita de ESTA empresa (nada de otras). */
  private async artContext(company: any) {
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    const brand = this.brandView(b, company);
    const profile = profileOfCompany(parseJson(company.onboardingJson, {}));
    const identity: ResolvedIdentity = resolveIdentity({
      visual: b?.visualJson ? sanitizeVisual(parseJson(b.visualJson, {})) : null,
      sector: profile.key, tone: brand.tone, colors: brand.colors.map((c: any) => c.hex), fonts: brand.fonts,
      logoAssetId: brand.logos[0]?.assetId ?? null, restrictions: brand.restrictions,
    });
    const assets = await this.prisma.brandAsset.findMany({ where: { companyId: company.id }, select: { id: true, kind: true, width: true, height: true }, take: 500 });
    const dims: AssetDims = Object.fromEntries(assets.map((a) => [a.id, { width: a.width, height: a.height }]));
    const recentDesigns = await this.prisma.creativeDesign.findMany({ where: { companyId: company.id, status: 'ACTIVE' }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, compositionJson: true, docJson: true } });
    const recent = recentDesigns.map((d) => readComposition(d.compositionJson)?.family).filter(Boolean) as Family[];
    // Huella estructural de las piezas recientes (incluye diseños hechos a mano): la repetición se mide por estructura
    const recentPrints = recentDesigns.map((d) => { try { return { id: d.id, fp: fingerprint(JSON.parse(d.docJson)) }; } catch { return null; } }).filter(Boolean) as Array<{ id: string; fp: ReturnType<typeof fingerprint> }>;
    return { brand, profile, identity, dims, assets, recent, recentPrints, companySeed: seedHash(company.id), brandName: brand.name || company.name };
  }

  artCatalog() {
    return {
      goals: GOALS.map((g) => ({ key: g, label: GOAL_LABEL[g] })),
      families: FAMILIES.map((f) => ({ key: f, label: ART_CATALOG[f].label, purpose: ART_CATALOG[f].purpose, usesPhoto: ART_CATALOG[f].usesPhoto })),
    };
  }

  async visual(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const ctx = await this.artContext(company);
    const b = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    return { saved: b?.visualJson ? sanitizeVisual(parseJson(b.visualJson, {})) : null, resolved: ctx.identity, sector: ctx.profile.label, version: b?.version ?? 0 };
  }

  async suggestVisualFor(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const ctx = await this.artContext(company);
    // Solo se devuelve: no se guarda nada hasta que la persona lo acepte
    return suggestVisual(ctx.profile.key, ctx.brand.tone);
  }

  async saveVisual(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const visual = sanitizeVisual(dto?.visual ?? {});
    if (visual.references?.length) {
      const owned = await this.prisma.brandAsset.count({ where: { id: { in: visual.references }, companyId: company.id } });
      if (owned !== visual.references.length) throw new BadRequestException('Alguna referencia no es un recurso de tu empresa');
    }
    const current = await this.prisma.brandProfile.findUnique({ where: { companyId: company.id } });
    if (current && dto?.expectedVersion !== undefined && Number(dto.expectedVersion) !== current.version) throw new ConflictException('Alguien más cambió la marca. Recarga para ver la última versión.');
    const now = new Date();
    if (current) await this.prisma.brandProfile.update({ where: { companyId: company.id }, data: { visualJson: JSON.stringify(visual), version: current.version + 1, updatedAt: now, updatedBy: user.name } });
    else await this.prisma.brandProfile.create({ data: { companyId: company.id, name: company.name, visualJson: JSON.stringify(visual), version: 1, updatedAt: now, updatedBy: user.name } });
    await this.audit.log({ actor: user, companyId: company.id, action: 'creative.visual_identity', entity: 'BrandProfile', entityId: company.id, detail: (visual.personality ?? []).join(', ') || 'estilo visual' });
    return this.visual(user, company.id);
  }

  private content(dto: any, owned: Set<string>): Content {
    const s = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined);
    const photos = (Array.isArray(dto?.photos) ? dto.photos : []).filter((id: unknown) => typeof id === 'string' && owned.has(id)).slice(0, 4);
    if (Array.isArray(dto?.photos) && photos.length !== Math.min(4, dto.photos.length)) throw new BadRequestException('Alguna foto no es un recurso de tu empresa');
    const items = (Array.isArray(dto?.items) ? dto.items : []).slice(0, 4).map((it: any) => ({ name: s(it?.name, 60) ?? '', price: s(it?.price, 20), assetId: typeof it?.assetId === 'string' && owned.has(it.assetId) ? it.assetId : undefined })).filter((it: any) => it.name);
    const headline = s(dto?.headline, 140) ?? s(dto?.quote, 140);
    if (!headline) throw new BadRequestException('Escribe el mensaje principal');
    return {
      headline, kicker: s(dto?.kicker, 40), body: s(dto?.body, 280), price: s(dto?.price, 24), cta: s(dto?.cta, 40), validity: s(dto?.validity, 80),
      date: s(dto?.date?.day, 6) ? { day: s(dto.date.day, 6)!, month: s(dto.date.month, 12) ?? '' } : undefined,
      place: s(dto?.place, 100), quote: s(dto?.quote, 280), author: s(dto?.author, 60),
      points: (Array.isArray(dto?.points) ? dto.points : []).map((x: unknown) => s(x, 120)).filter(Boolean).slice(0, 4) as string[],
      items, photos,
    };
  }

  async proposals(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const ctx = await this.artContext(company);
    const goal = (GOALS as readonly string[]).includes(dto?.goal) ? (dto.goal as Goal) : 'PRODUCT';
    const format = (dto?.format in FORMATS ? dto.format : 'IG_POST') as FormatKey;
    const content = this.content(dto?.content ?? {}, new Set(ctx.assets.map((a) => a.id)));
    const consistentWith = (FAMILIES as readonly string[]).includes(dto?.consistentWith) ? (dto.consistentWith as Family) : null;
    // "Otras variantes" manda 1, 2…: recorre las estructuras siguientes a la preferida por la marca
    const seed = Number.isInteger(dto?.seed) && dto.seed >= 0 ? dto.seed : 0;
    const res = propose(ctx.identity, { goal, format, content, recent: ctx.recent, recentPrints: ctx.recentPrints.map((r) => r.fp), consistentWith, seed, alt: seed, companySeed: ctx.companySeed, brandName: ctx.brandName, dims: ctx.dims });
    const brandLogoIds = ctx.brand.logos.map((l: any) => l.assetId);
    const out = res.proposals.map((p) => ({
      ...p,
      composition: { family: p.family, variant: p.variant, goal, seed },
      checks: checkQuality(p.doc, this.qualityCtx(ctx, brandLogoIds, p.family)).filter((i) => i.severity !== 'INFO'),
    }));
    await this.event(company.id, 'composition_suggested', null, null, { goal, format, families: out.map((p) => p.family), seed });
    return { proposals: out, note: res.note, unavailable: res.unavailable, identity: { personality: ctx.identity.personality, photoStyle: ctx.identity.photoStyle } };
  }

  private qualityCtx(ctx: any, brandLogoIds: string[], family: Family | null) {
    const prices = [
      ...ctx.brand.products.map((p: any) => Number(p.price)).filter((n: number) => Number.isFinite(n) && n > 0),
      ...ctx.brand.offers.map((o: any) => Number(o.price)).filter((n: number) => Number.isFinite(n) && n > 0),
    ];
    return {
      brandLogoIds, confirmedPrices: prices, confirmedOffers: ctx.brand.offers.map((o: any) => String(o.text ?? '')),
      assetDims: ctx.dims, ownedAssetIds: new Set<string>(ctx.assets.map((a: any) => a.id)), family, recentFamilies: ctx.recent,
      recentPrints: (ctx.recentPrints ?? []).map((r: any) => r.fp),
    };
  }

  /** Revisión de calidad de un diseño (del guardado o del que está en pantalla). No modifica nada. */
  async check(user: AuthUser, designId: string, dto: any) {
    const d = await this.designOf(user, designId);
    const company = await this.prisma.company.findUnique({ where: { id: d.companyId } });
    const ctx = await this.artContext(company);
    let doc: DesignDoc;
    try { doc = validateDesignDoc(dto?.doc ?? parseJson(d.docJson, null), d.format as FormatKey); } catch (e) { throw new BadRequestException(e instanceof DesignDocError ? e.message : 'Diseño inválido'); }
    const measured: Record<string, number> = {};
    if (dto?.measured && typeof dto.measured === 'object') for (const [k, v] of Object.entries(dto.measured).slice(0, 200)) if (Number.isFinite(Number(v)) && Number(v) >= 0) measured[k] = Number(v);
    const comp = readComposition(d.compositionJson);
    // El propio diseño no cuenta como repetición de sí mismo
    const recent = ctx.recent.slice(comp ? 1 : 0);
    const recentPrints = ctx.recentPrints.filter((r: any) => r.id !== d.id);
    const expectCta = dto?.forAds === true || ['PRODUCT', 'PROMO'].includes(comp?.goal ?? '');
    const issues = checkQuality(doc, { ...this.qualityCtx({ ...ctx, recent, recentPrints }, ctx.brand.logos.map((l: any) => l.assetId), comp?.family ?? null), measured, expectCta });
    if (dto?.forExport) await this.event(d.companyId, 'quality_warnings', d.id, comp?.family ?? null, { block: issues.filter((i) => i.severity === 'BLOCK').length, warn: issues.filter((i) => i.severity === 'WARN').length, codes: [...new Set(issues.map((i) => i.code))] });
    return { issues, blocking: issues.some((i) => i.severity === 'BLOCK') };
  }

  /** Adapta a otro formato creando una copia editable (el original no cambia). */
  async adapt(user: AuthUser, designId: string, dto: any) {
    const d = await this.designOf(user, designId);
    const to = (dto?.format in FORMATS ? dto.format : null) as FormatKey | null;
    if (!to || to === d.format) throw new BadRequestException('Elige un formato distinto');
    const company = await this.prisma.company.findUnique({ where: { id: d.companyId } });
    const ctx = await this.artContext(company);
    const comp = readComposition(d.compositionJson);
    const src = validateDesignDoc(parseJson(d.docJson, null), d.format as FormatKey);
    const { doc, method } = adaptDesign(src, comp, to, tokensFor(ctx.identity, to, ctx.companySeed, ctx.brandName), ctx.dims);
    const valid = validateDesignDoc(doc, to);
    await this.assertAssetsOwned(d.companyId, valid);
    const now = new Date();
    const copy = await this.prisma.creativeDesign.create({
      data: {
        companyId: d.companyId, name: `${d.name} · ${FORMATS[to].label}`.slice(0, 80), format: to, docJson: JSON.stringify(valid), version: 1, templateKey: d.templateKey,
        compositionJson: comp ? JSON.stringify({ ...comp, adaptedFrom: d.id }) : null, createdBy: user.name, updatedBy: user.name, createdAt: now, updatedAt: now,
      },
    });
    await this.prisma.creativeDesignVersion.create({ data: { designId: copy.id, companyId: copy.companyId, version: 1, docJson: copy.docJson, createdBy: user.name } });
    return { ...this.designView(copy), method };
  }

  /** Eventos del navegador (lista cerrada; el diseño debe ser de la empresa). */
  async clientEvent(user: AuthUser, dto: any, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const type = String(dto?.type ?? '');
    if (!['composition_rejected', 'manual_edit'].includes(type)) throw new BadRequestException('Evento desconocido');
    let designId: string | null = null;
    let family: string | null = (FAMILIES as readonly string[]).includes(dto?.family) ? dto.family : null;
    if (dto?.designId) {
      const d = await this.prisma.creativeDesign.findUnique({ where: { id: String(dto.designId) } });
      if (!d || d.companyId !== company.id) throw new NotFoundException('Diseño no encontrado');
      designId = d.id;
      family = readComposition(d.compositionJson)?.family ?? family;
    }
    const data = { kinds: Array.isArray(dto?.kinds) ? dto.kinds.filter((k: unknown) => typeof k === 'string').slice(0, 10) : undefined, families: Array.isArray(dto?.families) ? dto.families.filter((f: unknown) => (FAMILIES as readonly string[]).includes(String(f))) : undefined };
    await this.event(company.id, type, designId, family, data);
    return { ok: true };
  }

  /** Resumen de uso por familia (para aprender qué se usa; no mide ventas). */
  async artStats(user: AuthUser, companyId?: string) {
    const company = await this.companyOf(user, companyId);
    const since = new Date(Date.now() - 90 * 86400e3);
    const rows = await this.prisma.creativeEvent.findMany({ where: { companyId: company.id, createdAt: { gte: since } }, select: { type: true, family: true }, take: 5000 });
    const by: Record<string, Record<string, number>> = {};
    for (const r of rows) { const f = r.family ?? '—'; by[f] = by[f] ?? {}; by[f][r.type] = (by[f][r.type] ?? 0) + 1; }
    return { since: since.toISOString(), byFamily: by, note: 'Cuenta uso (sugerido, elegido, exportado, en campaña). No indica qué diseño vende más.' };
  }

  async uploadExport(user: AuthUser, designId: string, file: Express.Multer.File | undefined, expectedVersion?: unknown) {
    const d = await this.designOf(user, designId);
    if (!file?.buffer?.length) throw new BadRequestException('Falta la imagen exportada');
    // El editor dice qué versión dibujó: si el diseño cambió entretanto, la imagen no es de esta versión
    if (expectedVersion !== undefined && expectedVersion !== '' && Number(expectedVersion) !== d.version) {
      throw new ConflictException('El diseño cambió mientras se exportaba. Vuelve a intentarlo.');
    }
    if (file.size > MAX_EXPORT_BYTES) throw new BadRequestException('La exportación pesa demasiado');
    const info = imageInfo(file.buffer);
    if (!info || info.mime === 'image/webp') throw new BadRequestException('La exportación debe ser PNG o JPEG');
    const f = FORMATS[d.format as FormatKey];
    if (info.width !== f.width || info.height !== f.height) throw new BadRequestException(`La imagen debe medir ${f.width}×${f.height}`);
    const fileName = `design-${d.id}-v${d.version}-${randomBytes(4).toString('hex')}.${info.mime === 'image/png' ? 'png' : 'jpg'}`;
    await saveFile(this.prisma, d.companyId, fileName, file.buffer, info.mime);
    // Solo si nadie guardó otra versión mientras tanto (si no, el nombre diría una versión equivocada)
    const res = await this.prisma.creativeDesign.updateMany({ where: { id: d.id, version: d.version }, data: { exportFile: fileName, exportMime: info.mime } });
    if (res.count === 0) {
      await removeFile(this.prisma, d.companyId, fileName);
      throw new ConflictException('El diseño cambió mientras se exportaba. Vuelve a intentarlo.');
    }
    if (d.exportFile) await removeFile(this.prisma, d.companyId, d.exportFile);
    // Exportar no es éxito comercial: solo se registra que se exportó
    await this.event(d.companyId, 'export_completed', d.id, readComposition(d.compositionJson)?.family ?? null, { format: d.format, version: d.version });
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
    const comp = readComposition(d.compositionJson);
    if (comp) await this.event(d.companyId, 'variant_in_campaign', d.id, comp.family, { pieceId: piece.id, campaignId: piece.campaignId ?? null });
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

@Products('CREATIVE')
@Controller('creative')
export class CreativeController {
  constructor(private readonly creative: CreativeService) {}

  @Get('templates')
  templates() {
    return this.creative.templates();
  }

  @Get('catalog-products')
  catalogProducts(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.catalogProducts(user, companyId);
  }

  @Post('assets/from-product')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  assetFromProduct(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.assetFromProduct(user, dto, companyId);
  }

  @Get('art/catalog')
  artCatalog() {
    return this.creative.artCatalog();
  }

  @Get('art/stats')
  artStats(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.artStats(user, companyId);
  }

  @Post('art/proposals')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  proposals(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.proposals(user, dto, companyId);
  }

  @Post('design-events')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  designEvent(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.clientEvent(user, dto, companyId);
  }

  @Get('brand/visual')
  visual(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.visual(user, companyId);
  }

  @Put('brand/visual')
  @Roles(...WRITE)
  saveVisual(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.creative.saveVisual(user, dto, companyId);
  }

  @Post('brand/visual/suggest')
  @Roles(...WRITE)
  suggestVisual(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.creative.suggestVisualFor(user, companyId);
  }

  @Post('designs/:id/adapt')
  @Roles(...WRITE)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  adapt(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.adapt(user, id, dto);
  }

  @Post('designs/:id/check')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  check(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.creative.check(user, id, dto);
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
  uploadExport(@CurrentUser() user: AuthUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body('expectedVersion') expectedVersion?: string) {
    return this.creative.uploadExport(user, id, file, expectedVersion);
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
  imports: [AuditModule, LibraryModule],
  controllers: [CreativeController, CreativeCreateController],
  providers: [CreativeService, CreativeCreateService, { provide: AI_PROVIDER, useClass: DeepInfraProvider }],
  exports: [CreativeService],
})
export class CreativeModule {}
