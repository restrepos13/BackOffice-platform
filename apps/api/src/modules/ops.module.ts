import {
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
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';

function startOfDay(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function daysFrom(base: Date, n: number): Date {
  const x = new Date(base);
  x.setDate(x.getDate() + n);
  return x;
}
const round = (n: number) => Math.round(n * 100) / 100;

/* ─── Citas ──────────────────────────────────────────────────────────── */

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertAccess(user: AuthUser, id: string) {
    const appointment = await this.prisma.appointment.findUnique({ where: { id } });
    if (!appointment) throw new NotFoundException('Cita no encontrada');
    if (!isPlatformRole(user.role) && appointment.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return appointment;
  }

  async list(user: AuthUser, companyId?: string, from?: string, to?: string, status?: string) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.appointment.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(status ? { status } : {}),
        startsAt: {
          gte: from ? new Date(from) : daysFrom(startOfDay(), -30),
          lte: to ? new Date(to) : daysFrom(startOfDay(), 60),
        },
      },
      orderBy: { startsAt: 'asc' },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
      take: 500,
    });
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const contact = await this.prisma.contact.findUnique({ where: { id: dto.contactId } });
    if (!contact || contact.companyId !== companyId) {
      throw new ForbiddenException('Contacto inválido');
    }
    const appointment = await this.prisma.appointment.create({
      data: {
        companyId,
        contactId: dto.contactId,
        title: dto.title,
        notes: dto.notes,
        location: dto.location,
        startsAt: new Date(dto.startsAt),
        durationMin: Number(dto.durationMin ?? 30),
        source: 'MANUAL',
        createdBy: user.name,
      },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
    });
    await this.audit.log({
      actor: user, companyId, action: 'appointment.create', entity: 'Appointment',
      entityId: appointment.id, detail: `${appointment.title} · ${contact.name}`,
    });
    return appointment;
  }

  async update(user: AuthUser, id: string, dto: any) {
    const existing = await this.assertAccess(user, id);
    const appointment = await this.prisma.appointment.update({
      where: { id },
      data: {
        title: dto.title,
        notes: dto.notes,
        location: dto.location,
        status: dto.status,
        ...(dto.startsAt ? { startsAt: new Date(dto.startsAt) } : {}),
        ...(dto.durationMin != null ? { durationMin: Number(dto.durationMin) } : {}),
      },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
    });
    if (dto.status && dto.status !== existing.status) {
      await this.audit.log({
        actor: user, companyId: existing.companyId, action: 'appointment.status',
        entity: 'Appointment', entityId: id,
        detail: `${appointment.title}: ${existing.status} → ${dto.status}`,
      });
    }
    return appointment;
  }

  async remove(user: AuthUser, id: string) {
    const existing = await this.assertAccess(user, id);
    await this.prisma.appointment.delete({ where: { id } });
    await this.audit.log({
      actor: user, companyId: existing.companyId, action: 'appointment.delete',
      entity: 'Appointment', entityId: id, detail: existing.title,
    });
    return { ok: true };
  }
}

/* ─── Seguimientos ───────────────────────────────────────────────────── */

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async assertAccess(user: AuthUser, id: string) {
    const followUp = await this.prisma.followUp.findUnique({ where: { id } });
    if (!followUp) throw new NotFoundException('Seguimiento no encontrado');
    if (!isPlatformRole(user.role) && followUp.companyId !== user.companyId) {
      throw new ForbiddenException();
    }
    return followUp;
  }

  async list(user: AuthUser, companyId?: string, status?: string) {
    const scoped = scopeCompanyId(user, companyId);
    return this.prisma.followUp.findMany({
      where: {
        ...(scoped ? { companyId: scoped } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { dueAt: 'asc' },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
      take: 300,
    });
  }

  async create(user: AuthUser, dto: any) {
    const companyId = isPlatformRole(user.role) ? dto.companyId : user.companyId;
    if (!companyId) throw new ForbiddenException('Falta companyId');
    const contact = await this.prisma.contact.findUnique({ where: { id: dto.contactId } });
    if (!contact || contact.companyId !== companyId) {
      throw new ForbiddenException('Contacto inválido');
    }
    const followUp = await this.prisma.followUp.create({
      data: {
        companyId,
        contactId: dto.contactId,
        note: dto.note,
        dueAt: new Date(dto.dueAt),
        createdBy: user.name,
      },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
    });
    await this.audit.log({
      actor: user, companyId, action: 'followup.create', entity: 'FollowUp',
      entityId: followUp.id, detail: `${contact.name}: ${dto.note}`,
    });
    return followUp;
  }

  async update(user: AuthUser, id: string, dto: any) {
    await this.assertAccess(user, id);
    return this.prisma.followUp.update({
      where: { id },
      data: {
        note: dto.note,
        status: dto.status,
        ...(dto.dueAt ? { dueAt: new Date(dto.dueAt) } : {}),
        ...(dto.status === 'DONE' ? { doneAt: new Date() } : {}),
      },
      include: { contact: { select: { id: true, name: true, phone: true, stage: true } } },
    });
  }

  async remove(user: AuthUser, id: string) {
    await this.assertAccess(user, id);
    await this.prisma.followUp.delete({ where: { id } });
    return { ok: true };
  }
}

/* ─── Reporte a Gerencia ─────────────────────────────────────────────── */

@Injectable()
export class ExecutiveService {
  constructor(private readonly prisma: PrismaService) {}

  async report(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');

    const today = startOfDay();
    const weekStart = daysFrom(today, -6);
    const prevWeekStart = daysFrom(today, -13);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const tomorrowEnd = daysFrom(today, 2);
    const staleThreshold = daysFrom(new Date(), -2);

    const [
      company, conversations, contacts, appointments, followUps,
      integrations, bots, msgWeek, msgPrevWeek, aiMonth,
    ] = await Promise.all([
      this.prisma.company.findUniqueOrThrow({ where: { id: scoped } }),
      this.prisma.conversation.findMany({
        where: { companyId: scoped },
        select: { status: true, needsAttention: true, lastMessageAt: true, createdAt: true },
      }),
      this.prisma.contact.findMany({
        where: { companyId: scoped },
        select: { id: true, name: true, stage: true, lastActivityAt: true, createdAt: true },
      }),
      this.prisma.appointment.findMany({
        where: { companyId: scoped, startsAt: { gte: daysFrom(today, -28) } },
        include: { contact: { select: { name: true } } },
        orderBy: { startsAt: 'asc' },
      }),
      this.prisma.followUp.findMany({
        where: { companyId: scoped, status: 'PENDING' },
        include: { contact: { select: { id: true, name: true } } },
        orderBy: { dueAt: 'asc' },
      }),
      this.prisma.integration.findMany({
        where: { companyId: scoped, type: 'WHATSAPP' },
        select: { name: true, status: true },
      }),
      this.prisma.bot.findMany({
        where: { companyId: scoped },
        select: { name: true, status: true, systemPrompt: true },
      }),
      this.prisma.message.count({
        where: { conversation: { companyId: scoped }, createdAt: { gte: weekStart } },
      }),
      this.prisma.message.count({
        where: {
          conversation: { companyId: scoped },
          createdAt: { gte: prevWeekStart, lt: weekStart },
        },
      }),
      this.prisma.aiUsageEvent.aggregate({
        where: { companyId: scoped, createdAt: { gte: monthStart } },
        _sum: { costUsd: true },
        _count: true,
      }),
    ]);

    const inWeek = (d: Date) => d >= weekStart;
    const inPrevWeek = (d: Date) => d >= prevWeekStart && d < weekStart;

    const attention = conversations.filter((c) => c.needsAttention).length;
    const overdueFollowUps = followUps.filter((f) => f.dueAt < new Date());
    const staleHotLeads = contacts.filter(
      (c) => c.stage === 'CALIENTE' && c.lastActivityAt < staleThreshold,
    );
    const upcoming = appointments.filter(
      (a) => a.startsAt >= today && a.startsAt < tomorrowEnd &&
        ['SCHEDULED', 'CONFIRMED'].includes(a.status),
    );
    const completed28d = appointments.filter((a) => a.status === 'COMPLETED').length;
    const noShow28d = appointments.filter((a) => a.status === 'NO_SHOW').length;
    const attendanceRate =
      completed28d + noShow28d > 0
        ? Math.round((completed28d / (completed28d + noShow28d)) * 100)
        : null;

    // Ahorro estimado del mes: respuestas de la IA ÷ capacidad humana × sueldo
    const aiReplies = aiMonth._count ?? 0;
    const salariesSaved = company.agentCapacityPerMonth > 0
      ? aiReplies / company.agentCapacityPerMonth
      : 0;

    // Áreas auditadas — el "bot jefe" de la landing, calculado en vivo
    const connectedLines = integrations.filter((i) => i.status === 'CONNECTED');
    const activeBots = bots.filter((b) => b.status === 'ACTIVE');
    const areas = [
      {
        area: 'Canales WhatsApp',
        ok: integrations.length > 0 && connectedLines.length === integrations.length,
        detail: integrations.length === 0
          ? 'Sin líneas creadas'
          : `${connectedLines.length}/${integrations.length} líneas conectadas`,
      },
      {
        area: 'Motor de IA',
        ok: !!company.deepinfraApiKey && activeBots.length > 0,
        detail: !company.deepinfraApiKey
          ? 'Falta la llave de DeepInfra'
          : activeBots.length === 0
            ? 'Ningún bot activo'
            : `${activeBots.length} bot(s) activo(s)`,
      },
      {
        area: 'Atención al cliente',
        ok: attention === 0,
        detail: attention === 0
          ? 'Sin conversaciones esperando a un humano'
          : `${attention} conversación(es) necesitan atención`,
      },
      {
        area: 'Seguimientos',
        ok: overdueFollowUps.length === 0,
        detail: overdueFollowUps.length === 0
          ? 'Nada vencido'
          : `${overdueFollowUps.length} seguimiento(s) vencido(s)`,
      },
      {
        area: 'Leads calientes',
        ok: staleHotLeads.length === 0,
        detail: staleHotLeads.length === 0
          ? 'Todos con actividad reciente'
          : `${staleHotLeads.length} sin actividad hace +48h`,
      },
    ];

    return {
      generatedAt: new Date().toISOString(),
      company: { name: company.name },
      week: {
        conversations: conversations.filter((c) => inWeek(c.createdAt)).length,
        conversationsPrev: conversations.filter((c) => inPrevWeek(c.createdAt)).length,
        messages: msgWeek,
        messagesPrev: msgPrevWeek,
        newContacts: contacts.filter((c) => inWeek(c.createdAt)).length,
        newContactsPrev: contacts.filter((c) => inPrevWeek(c.createdAt)).length,
        appointments: appointments.filter((a) => inWeek(a.createdAt)).length,
        appointmentsPrev: appointments.filter((a) => inPrevWeek(a.createdAt)).length,
      },
      savings: {
        aiRepliesMonth: aiReplies,
        agentCapacityPerMonth: company.agentCapacityPerMonth,
        salaryUsd: company.savingsSalaryUsd,
        salariesEquivalent: round(salariesSaved),
        savedUsd: round(salariesSaved * company.savingsSalaryUsd),
        aiCostMonth: round(aiMonth._sum.costUsd ?? 0),
      },
      areas,
      attendanceRate,
      pending: {
        attention,
        overdueFollowUps: overdueFollowUps.slice(0, 8).map((f) => ({
          id: f.id, note: f.note, dueAt: f.dueAt, contact: f.contact.name,
        })),
        upcomingAppointments: upcoming.slice(0, 8).map((a) => ({
          id: a.id, title: a.title, startsAt: a.startsAt,
          status: a.status, contact: a.contact.name,
        })),
        staleHotLeads: staleHotLeads.slice(0, 8).map((c) => ({
          id: c.id, name: c.name, lastActivityAt: c.lastActivityAt,
        })),
      },
    };
  }
}

/* ─── Controllers ────────────────────────────────────────────────────── */

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    return this.appointments.list(user, companyId, from, to, status);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.appointments.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.appointments.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.appointments.remove(user, id);
  }
}

@Controller('followups')
export class FollowUpsController {
  constructor(private readonly followUps: FollowUpsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('companyId') companyId?: string,
    @Query('status') status?: string,
  ) {
    return this.followUps.list(user, companyId, status);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.followUps.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.followUps.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.followUps.remove(user, id);
  }
}

@Controller('ops')
export class OpsController {
  constructor(private readonly executive: ExecutiveService) {}

  /** Reporte a Gerencia: el "bot jefe" calculado en vivo. */
  @Get('executive')
  executiveReport(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.executive.report(user, companyId);
  }
}

@Module({
  controllers: [AppointmentsController, FollowUpsController, OpsController],
  providers: [AppointmentsService, FollowUpsService, ExecutiveService],
})
export class OpsModule {}
