import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Module, Query, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, NOT_DELETED, ROLES, isPlatformRole, parseJson } from '../common/constants';
import { ExportSection, buildDataExportPdf } from '../common/pdf';
import { AuditModule, AuditService } from './audit.module';

/**
 * "Descarga tus datos": todo lo de la empresa sale SOLO en PDF (con su marca),
 * nunca en CSV ni Excel. El administrador elige qué secciones quiere.
 */

export const EXPORT_SECTIONS: Record<string, string> = {
  contactos: 'Contactos',
  conversaciones: 'Conversaciones',
  pedidos: 'Pedidos',
  cobranza: 'Cuentas por cobrar',
  productos: 'Catálogo',
  equipo: 'Equipo',
  facturas: 'Facturas de BackOffice',
};

const MAX_ROWS = 3000;
const ORIGIN: Record<string, string> = { AD: 'Anuncio', POST: 'Publicación', DIRECT: 'Directo' };
const STAGE: Record<string, string> = { CURIOSO: 'Curioso', POTENCIAL: 'Potencial', CALIENTE: 'Caliente', CLIENTE: 'Cliente', DESCARTADO: 'Descartado' };
/** Etapas propias del embudo de cada empresa: PREGUNTA_POR_TALLAS → Pregunta por tallas */
const stageLabel = (k: string) => STAGE[k] ?? (k ? k.charAt(0) + k.slice(1).toLowerCase().replaceAll('_', ' ') : '');
const ROLE: Record<string, string> = { COMPANY_ADMIN: 'Administrador', COMPANY_VIEWER: 'Consulta', COMPANY_AREA: 'Área de producción', COMPANY_COURIER: 'Domiciliario' };

const day = (d: Date | string | null | undefined, tz = 'America/Bogota') =>
  d ? new Intl.DateTimeFormat('es-CO', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d)) : '';
const money = (n: number | null | undefined, currency = 'COP') =>
  n == null ? '' : `${currency === 'USD' ? 'US$' : '$'}${Math.round(n).toLocaleString('es-CO')}`;

@Injectable()
export class DataExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private note(n: number) {
    return n >= MAX_ROWS ? `Se muestran los ${MAX_ROWS} más recientes. Si necesitas todo el histórico, pídeselo a tu agente.` : undefined;
  }

  async sections(companyId: string, keys: string[], tz: string): Promise<ExportSection[]> {
    const out: ExportSection[] = [];
    const take = MAX_ROWS;
    for (const key of keys) {
      if (key === 'contactos') {
        const rows = await this.prisma.contact.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' }, take, include: { assignedTo: { select: { name: true } } } });
        out.push({
          title: EXPORT_SECTIONS[key], note: this.note(rows.length),
          columns: [{ label: 'Nombre', width: 3 }, { label: 'Teléfono', width: 2 }, { label: 'Correo', width: 3 }, { label: 'Etapa', width: 1.5 }, { label: 'Origen', width: 1.4 }, { label: 'Asesor', width: 2 }, { label: 'Etiquetas', width: 2.5 }, { label: 'Desde', width: 1.6 }],
          rows: rows.map((c: any) => [
            c.name, c.phone ?? c.externalId ?? '', c.email ?? '', stageLabel(c.stage),
            ORIGIN[parseJson<any>(c.originJson, {})?.kind] ?? '', c.assignedTo?.name ?? '',
            parseJson<string[]>(c.tagsJson, []).join(', '), `${day(c.createdAt, tz)}${c.optOut ? ' · no recibe mensajes' : ''}`,
          ]),
        });
      } else if (key === 'conversaciones') {
        const rows = await this.prisma.conversation.findMany({ where: { companyId }, orderBy: { lastMessageAt: 'desc' }, take, include: { contact: { select: { name: true, phone: true } }, integration: { select: { name: true } }, _count: { select: { messages: true } } } });
        out.push({
          title: EXPORT_SECTIONS[key], note: this.note(rows.length),
          columns: [{ label: 'Cliente', width: 3 }, { label: 'Teléfono', width: 2 }, { label: 'Línea', width: 2.2 }, { label: 'Origen', width: 1.4 }, { label: 'Anuncio', width: 2.6 }, { label: 'Mensajes', width: 1.5, align: 'right' }, { label: 'Estado', width: 1.4 }, { label: 'Inició', width: 1.6 }, { label: 'Último', width: 1.6 }],
          rows: rows.map((c: any) => {
            const o = parseJson<any>(c.originJson, {});
            return [
              c.contact?.name ?? '', c.contact?.phone ?? '', c.integration?.name ?? c.channel, ORIGIN[o?.kind] ?? '', o?.headline ?? '',
              String(c._count?.messages ?? 0), c.status === 'RESOLVED' ? 'Resuelta' : c.botPaused ? 'Con persona' : 'Abierta', day(c.createdAt, tz), day(c.lastMessageAt, tz),
            ];
          }),
        });
      } else if (key === 'pedidos') {
        const rows = await this.prisma.order.findMany({ where: { companyId, ...NOT_DELETED }, orderBy: { createdAt: 'desc' }, take, include: { contact: { select: { name: true } }, customer: { select: { name: true } } } });
        out.push({
          title: EXPORT_SECTIONS[key], note: this.note(rows.length),
          columns: [{ label: 'Pedido', width: 1.3 }, { label: 'Fecha', width: 1.6 }, { label: 'Cliente', width: 3 }, { label: 'Estado', width: 1.8 }, { label: 'Pago', width: 1.4 }, { label: 'Total', width: 1.6, align: 'right' }],
          rows: rows.map((o: any) => [
            String(o.id).slice(-6).toUpperCase(), day(o.createdAt, tz), o.customer?.name ?? o.contact?.name ?? '',
            String(o.status ?? '').replaceAll('_', ' ').replace(/^./, (c: string) => c.toUpperCase()), o.paymentStatus === 'APPROVED' ? 'Pagado' : 'Pendiente', money(o.total),
          ]),
        });
      } else if (key === 'cobranza') {
        const rows = await this.prisma.receivable.findMany({ where: { companyId }, orderBy: { dueDate: 'desc' }, take });
        const contacts = await this.prisma.contact.findMany({ where: { id: { in: [...new Set(rows.map((r: any) => r.contactId))] as string[] } }, select: { id: true, name: true } });
        const byId = new Map(contacts.map((c: any) => [c.id, c.name]));
        out.push({
          title: EXPORT_SECTIONS[key], note: this.note(rows.length),
          columns: [{ label: 'Cliente', width: 3 }, { label: 'Concepto', width: 3 }, { label: 'Valor', width: 1.6, align: 'right' }, { label: 'Vence', width: 1.6 }, { label: 'Estado', width: 1.4 }, { label: 'Avisos', width: 1.1, align: 'right' }, { label: 'Pagó', width: 1.6 }],
          rows: rows.map((r: any) => [
            byId.get(r.contactId) ?? '', r.concept, money(r.amount), day(r.dueDate, tz),
            r.status === 'PAID' ? 'Pagada' : r.status === 'CANCELLED' ? 'Anulada' : 'Pendiente', String(r.remindersSent ?? 0), day(r.paidAt, tz),
          ]),
        });
      } else if (key === 'productos') {
        const rows = await this.prisma.product.findMany({ where: { companyId, ...NOT_DELETED }, orderBy: { name: 'asc' }, take });
        out.push({
          title: EXPORT_SECTIONS[key], note: this.note(rows.length),
          columns: [{ label: 'Producto', width: 3 }, { label: 'Categoría', width: 2 }, { label: 'Precio', width: 1.6, align: 'right' }, { label: 'Unidad', width: 1.2 }, { label: 'Estado', width: 1.4 }, { label: 'Descripción', width: 4 }],
          rows: rows.map((p: any) => [p.name, p.category ?? '', money(p.price), p.unit ?? '', !p.active ? 'Inactivo' : p.soldOut ? 'Agotado' : 'Disponible', (p.description ?? '').slice(0, 240)]),
        });
      } else if (key === 'equipo') {
        const rows = await this.prisma.user.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { name: true, email: true, phone: true, role: true, jobTitle: true, active: true, lastLoginAt: true } });
        out.push({
          title: EXPORT_SECTIONS[key],
          columns: [{ label: 'Nombre', width: 3 }, { label: 'Correo', width: 3 }, { label: 'Teléfono', width: 2 }, { label: 'Rol', width: 2 }, { label: 'Cargo', width: 2 }, { label: 'Estado', width: 1.2 }, { label: 'Último ingreso', width: 1.8 }],
          rows: rows.map((u: any) => [u.name, u.email, u.phone ?? '', ROLE[u.role] ?? u.role, u.jobTitle ?? '', u.active ? 'Activo' : 'Inactivo', day(u.lastLoginAt, tz)]),
        });
      } else if (key === 'facturas') {
        const rows = await this.prisma.invoice.findMany({ where: { companyId }, orderBy: { period: 'desc' }, take: 120 });
        out.push({
          title: EXPORT_SECTIONS[key],
          columns: [{ label: 'Periodo', width: 1.4 }, { label: 'Plan', width: 1.6, align: 'right' }, { label: 'Consumo', width: 1.6, align: 'right' }, { label: 'Total', width: 1.6, align: 'right' }, { label: 'Estado', width: 1.4 }, { label: 'Emitida', width: 1.6 }, { label: 'Pagada', width: 1.6 }],
          rows: rows.map((i: any) => [i.period, money(i.planAmount, i.currency), money(i.consumptionAmount, i.currency), money(i.totalAmount, i.currency), i.status === 'PAID' ? 'Pagada' : 'Pendiente', day(i.issuedAt, tz), day(i.paidAt, tz)]),
        });
      }
    }
    return out;
  }

  async pdf(user: AuthUser, query: { companyId?: string; sections?: string }) {
    const companyId = isPlatformRole(user.role) ? query.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const keys = String(query.sections ?? '').split(',').map((s) => s.trim()).filter((s) => s in EXPORT_SECTIONS);
    if (!keys.length) throw new BadRequestException('Elige al menos una sección para descargar');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const sections = await this.sections(companyId, [...new Set(keys)], company.timezone ?? 'America/Bogota');
    const buffer = await buildDataExportPdf(company, sections, { requestedBy: user.name });
    await this.audit.log({ actor: user, companyId, action: 'data.export_pdf', entity: 'Company', entityId: companyId, detail: keys.map((k) => EXPORT_SECTIONS[k]).join(', ') });
    const slug = String(company.slug ?? 'empresa').replace(/[^a-z0-9-]/gi, '');
    return { buffer, filename: `${slug}-datos-${new Intl.DateTimeFormat('en-CA', { timeZone: company.timezone ?? 'America/Bogota' }).format(new Date())}.pdf` };
  }
}

@Controller('company/data-export')
export class DataExportController {
  constructor(private readonly exporter: DataExportService) {}

  @Get('sections')
  sections() {
    return EXPORT_SECTIONS;
  }

  @Get('pdf')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async pdf(@CurrentUser() user: AuthUser, @Query() query: { companyId?: string; sections?: string }, @Res() res: Response) {
    const { buffer, filename } = await this.exporter.pdf(user, query);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

@Module({
  imports: [AuditModule],
  controllers: [DataExportController],
  providers: [DataExportService],
})
export class DataExportModule {}
