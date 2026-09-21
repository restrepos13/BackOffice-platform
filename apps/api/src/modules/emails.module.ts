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

  private async deliver(id: string) {
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
        html: message.body,
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
})
export class EmailsModule {}
