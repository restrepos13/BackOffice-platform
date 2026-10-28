import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import { AuditService } from './audit.module';

/**
 * Correos personalizados a las empresas (solo equipo BackOffice).
 * SMTP configurable desde Dev Tools (SMTP_HOST, SMTP_PORT, SMTP_USER,
 * SMTP_PASS, SMTP_FROM). Sin SMTP configurado, el correo queda en cola
 * (QUEUED) y se puede reenviar cuando haya credenciales.
 * Variables disponibles en asunto y cuerpo: {{empresa}}, {{plan}}, {{contacto}}.
 */
@Injectable()
export class EmailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async settings(): Promise<Record<string, string>> {
    const rows = await this.prisma.platformSetting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private fill(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
  }

  private async deliver(id: string, htmlOverride?: string) {
    const message = await this.prisma.emailMessage.findUniqueOrThrow({
      where: { id },
    });
    const cfg = await this.settings();
    if (!cfg.SMTP_HOST) {
      return this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: 'QUEUED',
          error: 'SMTP sin configurar — configúralo en Dev Tools y reenvía.',
        },
      });
    }
    try {
      const transporter = nodemailer.createTransport({
        host: cfg.SMTP_HOST,
        port: Number(cfg.SMTP_PORT || 587),
        secure: Number(cfg.SMTP_PORT || 587) === 465,
        auth: cfg.SMTP_USER
          ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS ?? '' }
          : undefined,
      });
      await transporter.sendMail({
        from: cfg.SMTP_FROM || cfg.SMTP_USER,
        to: message.toEmail,
        subject: message.subject,
        html: htmlOverride ?? message.body,
      });
      return this.prisma.emailMessage.update({
        where: { id },
        data: { status: 'SENT', sentAt: new Date(), error: null },
      });
    } catch (err) {
      return this.prisma.emailMessage.update({
        where: { id },
        data: {
          status: 'FAILED',
          error: err instanceof Error ? err.message : 'Error de envío',
        },
      });
    }
  }

  async send(
    user: AuthUser,
    dto: { companyId?: string; toEmail?: string; subject: string; body: string },
  ) {
    if (!dto.subject?.trim() || !dto.body?.trim()) {
      throw new BadRequestException('Faltan asunto o cuerpo');
    }
    let toEmail = dto.toEmail?.trim();
    const vars: Record<string, string> = {};

    if (dto.companyId) {
      const company = await this.prisma.company.findUniqueOrThrow({
        where: { id: dto.companyId },
        include: { plan: true },
      });
      toEmail = toEmail || company.contactEmail || undefined;
      vars.empresa = company.name;
      vars.plan = company.plan?.name ?? 'Sin plan';
      vars.contacto = company.contactEmail ?? '';
    }
    if (!toEmail) {
      throw new BadRequestException(
        'La empresa no tiene correo de contacto: indica un destinatario',
      );
    }

    const message = await this.prisma.emailMessage.create({
      data: {
        companyId: dto.companyId ?? null,
        toEmail,
        subject: this.fill(dto.subject, vars),
        body: this.fill(dto.body, vars),
        actorName: user.name,
      },
    });
    await this.audit.log({
      actor: user, companyId: dto.companyId, action: 'email.send',
      entity: 'EmailMessage', entityId: message.id,
      detail: `→ ${toEmail}: ${message.subject}`,
    });
    return this.deliver(message.id);
  }

  /** Reintenta un correo en cola o fallido. */
  async resend(user: AuthUser, id: string) {
    await this.prisma.emailMessage.findUniqueOrThrow({ where: { id } });
    const result = await this.deliver(id);
    await this.audit.log({
      actor: user, companyId: result.companyId, action: 'email.resend',
      entity: 'EmailMessage', entityId: id, detail: `→ ${result.toEmail}`,
    });
    return result;
  }

  async list(companyId?: string) {
    return this.prisma.emailMessage.findMany({
      where: companyId ? { companyId } : undefined,
      orderBy: { createdAt: 'desc' },
      include: { company: { select: { name: true, slug: true } } },
      take: 200,
    });
  }

  /** Envío del sistema (crons): sin actor humano; queda en cola si no hay SMTP. */
  /** Layout de correo con la IDENTIDAD de cada marca: banda del color de la
   *  empresa, nombre en cabecera y pie institucional. */
  private async brandLayout(companyId: string | null | undefined, body: string): Promise<string> {
    const company = companyId
      ? await this.prisma.company.findUnique({
          where: { id: companyId },
          select: { name: true, brandColor: true, contactEmail: true, website: true },
        })
      : null;
    const color = company?.brandColor || '#1A1A1A';
    const name = company?.name ?? 'BackOffice';
    return `<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#E6E1DD;font-family:Helvetica,Arial,sans-serif;color:#1A1A1A;">
  <div style="max-width:600px;margin:24px auto;background:#F4F1EE;border:2px solid #1A1A1A;">
    <div style="height:8px;background:${color};"></div>
    <div style="padding:20px 28px;border-bottom:2px solid #1A1A1A;">
      <p style="margin:0;font-size:20px;font-weight:800;letter-spacing:0.04em;color:${color};text-transform:uppercase;">${name}</p>
    </div>
    <div style="padding:24px 28px;font-size:14px;line-height:1.6;">${body}</div>
    <div style="padding:14px 28px;border-top:1px solid #d9d4cf;font-size:11px;color:#6b6b6b;">
      ${[name, company?.contactEmail, company?.website].filter(Boolean).join(' · ')}
      <br/>Enviado automáticamente por la plataforma de ${name}.
    </div>
  </div>
</body></html>`;
  }

  async systemSend(params: {
    companyId?: string | null;
    toEmail: string;
    subject: string;
    body: string;
    /** true (default): envuelve el contenido en el layout de la marca */
    branded?: boolean;
    /**
     * Contenido con secretos (enlaces con token): se ENVÍA `body`, pero en la
     * base queda `storedBody` (sin el enlace). Si no hay SMTP, el correo queda
     * en cola ya sin el secreto: reenviarlo no sirve y hay que generar otro.
     */
    storedBody?: string;
  }) {
    const wrap = (b: string) => (params.branded === false ? Promise.resolve(b) : this.brandLayout(params.companyId, b));
    const html = await wrap(params.body);
    const stored = params.storedBody !== undefined ? await wrap(params.storedBody) : html;
    const message = await this.prisma.emailMessage.create({
      data: {
        companyId: params.companyId ?? null,
        toEmail: params.toEmail,
        subject: params.subject,
        body: stored,
        actorName: 'Sistema BackOffice',
      },
    });
    return this.deliver(message.id, params.storedBody !== undefined ? html : undefined);
  }
}

@Controller('emails')
@Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
export class EmailsController {
  constructor(private readonly emails: EmailsService) {}

  @Get()
  list(@Query('companyId') companyId?: string) {
    return this.emails.list(companyId);
  }

  @Post()
  send(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.emails.send(user, dto);
  }

  @Post('resend')
  resend(@CurrentUser() user: AuthUser, @Body('id') id: string) {
    return this.emails.resend(user, id);
  }
}

@Module({
  controllers: [EmailsController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
