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
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, scopeCompanyId } from '../common/constants';
import { chunkText, fetchPublicPage, searchChunks } from '../common/knowledge';
import { AuditService } from './audit.module';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');
const MAX_DOCS = 50;
const run = promisify(execFile);

/** Texto de un PDF con pdftotext (poppler). Sin él, error claro. */
export async function pdfToText(filePath: string): Promise<string> {
  try {
    const { stdout } = await run('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-'], {
      timeout: 20_000, maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new BadRequestException('Este servidor no puede leer PDFs: pega el texto o súbelo como página web');
    }
    throw new BadRequestException('No se pudo leer el PDF (¿está protegido o es una imagen escaneada?)');
  }
}

/**
 * Base de conocimiento por empresa: documentos de texto, páginas web o PDF,
 * partidos en fragmentos. El agente la consulta con buscar_conocimiento.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  list(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    return this.prisma.knowledgeDoc.findMany({ where: { companyId: scoped }, orderBy: { createdAt: 'desc' } });
  }

  /** Guarda un documento ya convertido a texto, en fragmentos. */
  async ingest(user: AuthUser, companyId: string, doc: { title: string; source: 'TEXT' | 'URL' | 'PDF'; url?: string; text: string }) {
    const count = await this.prisma.knowledgeDoc.count({ where: { companyId } });
    if (count >= MAX_DOCS) throw new BadRequestException(`Máximo ${MAX_DOCS} documentos por empresa`);
    const text = doc.text.trim();
    if (text.length < 20) throw new BadRequestException('El documento no tiene texto suficiente');
    const chunks = chunkText(text.slice(0, 400_000));
    const created = await this.prisma.knowledgeDoc.create({
      data: {
        companyId, title: doc.title.slice(0, 120) || 'Documento', source: doc.source,
        url: doc.url ?? null, chars: text.length, chunks: chunks.length,
      },
    });
    for (let i = 0; i < chunks.length; i++) {
      await this.prisma.knowledgeChunk.create({ data: { companyId, docId: created.id, idx: i, text: chunks[i] } });
    }
    await this.audit.log({
      actor: user, companyId, action: 'knowledge.add', entity: 'KnowledgeDoc', entityId: created.id,
      detail: `${doc.source} · ${created.title} · ${chunks.length} fragmentos`,
    });
    return created;
  }

  async addText(user: AuthUser, dto: { title?: string; text?: string }, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    return this.ingest(user, scoped, { title: dto?.title?.trim() || 'Texto', source: 'TEXT', text: String(dto?.text ?? '') });
  }

  async addUrl(user: AuthUser, dto: { url?: string; title?: string }, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    let page: { title: string; text: string };
    try {
      page = await fetchPublicPage(String(dto?.url ?? ''));
    } catch (err: any) {
      throw new BadRequestException(`No se pudo leer la página: ${err.message}`);
    }
    return this.ingest(user, scoped, { title: dto?.title?.trim() || page.title, source: 'URL', url: dto?.url, text: page.text });
  }

  async addPdf(user: AuthUser, file: Express.Multer.File | undefined, title: string | undefined, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    if (!file) throw new BadRequestException('Adjunta el PDF');
    if (file.mimetype !== 'application/pdf' || !file.buffer.subarray(0, 5).toString().startsWith('%PDF')) {
      throw new BadRequestException('El archivo debe ser un PDF');
    }
    const dir = join(UPLOADS_DIR, scoped);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `kb-${randomBytes(8).toString('hex')}.pdf`);
    writeFileSync(tmp, file.buffer);
    try {
      const text = await pdfToText(tmp);
      return await this.ingest(user, scoped, {
        title: title?.trim() || file.originalname.replace(/\.pdf$/i, ''), source: 'PDF', text,
      });
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ya no está */
      }
    }
  }

  async remove(user: AuthUser, id: string) {
    const doc = await this.prisma.knowledgeDoc.findUnique({ where: { id } });
    if (!doc) throw new NotFoundException('Documento no encontrado');
    if (!isPlatformRole(user.role) && doc.companyId !== user.companyId) throw new ForbiddenException();
    await this.prisma.knowledgeChunk.deleteMany({ where: { docId: id } });
    await this.prisma.knowledgeDoc.delete({ where: { id } });
    await this.audit.log({ actor: user, companyId: doc.companyId, action: 'knowledge.remove', entity: 'KnowledgeDoc', entityId: id, detail: doc.title });
    return { ok: true };
  }

  /** Búsqueda (la usa el agente y el panel para probar). */
  async search(companyId: string, query: string, top = 3) {
    const chunks = await this.prisma.knowledgeChunk.findMany({ where: { companyId }, take: 3000 });
    const docs = await this.prisma.knowledgeDoc.findMany({ where: { companyId }, select: { id: true, title: true } });
    return searchChunks(chunks, query, top).map((c) => ({
      text: c.text,
      score: Math.round(c.score * 100) / 100,
      doc: docs.find((d) => d.id === c.docId)?.title ?? 'Documento',
    }));
  }

  async testSearch(user: AuthUser, query: string, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    if (!query?.trim()) throw new BadRequestException('Escribe una pregunta');
    return this.search(scoped, query, 3);
  }
}

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.knowledge.list(user, companyId);
  }

  @Post('text')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  addText(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.knowledge.addText(user, dto, companyId);
  }

  @Post('url')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  addUrl(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.knowledge.addUrl(user, dto, companyId);
  }

  @Post('pdf')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  addPdf(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('title') title?: string,
    @Query('companyId') companyId?: string,
  ) {
    return this.knowledge.addPdf(user, file, title, companyId);
  }

  @Post('search')
  search(@CurrentUser() user: AuthUser, @Body('query') query: string, @Query('companyId') companyId?: string) {
    return this.knowledge.testSearch(user, query, companyId);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.knowledge.remove(user, id);
  }
}

@Module({
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
