import { Body, Controller, Get, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../auth/decorators';
import { Products } from '../../auth/products.guard';
import { AuthUser } from '../../common/constants';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit.module';
import { integrationsReport, validateWhatsapp } from './integrations-status';
import { ProductionsService } from './productions.service';
import { WorkflowService } from './workflow.service';

/**
 * Producciones (Automation). Sin @Roles: los permisos finos los decide el
 * servicio según el perfil del usuario; los roles restringidos (área y
 * domiciliario) quedan fuera por el RolesGuard global. El companyId de la
 * consulta solo cuenta para roles de plataforma.
 */
@Products('AUTOMATION')
@Controller('productions')
export class ProductionsController {
  constructor(
    private readonly s: ProductionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('overview') overview(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.overview(u, c); }
  @Get() list(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.list(u, q); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.create(u, dto, c); }
  @Post('from-conversation') fromConversation(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.createFromConversation(u, dto, c); }

  // Catálogo, equipo, configuración, integraciones y motor (antes de :id)
  @Get('resources') resources(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.listResources(u, q); }
  @Post('resources') createResource(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.saveResource(u, null, dto, c); }
  @Patch('resources/:rid') updateResource(@CurrentUser() u: AuthUser, @Param('rid') rid: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.saveResource(u, rid, dto, c); }
  @Post('resources/:rid/rates') addRate(@CurrentUser() u: AuthUser, @Param('rid') rid: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.addRate(u, rid, dto, c); }
  @Get('team') team(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.team(u, c); }
  @Put('team/:userId') setProfile(@CurrentUser() u: AuthUser, @Param('userId') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.setProfile(u, id, dto, c); }
  @Get('settings') settings(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) { return this.s.getSettings(u, c); }
  @Put('settings') saveSettings(@CurrentUser() u: AuthUser, @Body() dto: any, @Query('companyId') c?: string) { return this.s.saveSettings(u, dto, c); }
  @Get('runs') runs(@CurrentUser() u: AuthUser, @Query() q: any) { return this.s.runs(u, q); }

  @Get('integrations')
  async integrations(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) {
    const ctx = await this.s.ctx(u, c, 'view');
    return { items: await integrationsReport(this.prisma, ctx.companyId), canManage: ctx.perms.has('integrations') };
  }

  @Post('integrations/whatsapp/validate') @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async validateWhatsapp(@CurrentUser() u: AuthUser, @Query('companyId') c?: string) {
    const ctx = await this.s.ctx(u, c, 'integrations');
    return validateWhatsapp(this.prisma, ctx.companyId);
  }

  // Tareas, incidencias, recursos asignados y cotizaciones por su propio id
  @Patch('tasks/:taskId') updateTask(@CurrentUser() u: AuthUser, @Param('taskId') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.updateTask(u, id, dto, c); }
  @Post('issues/:issueId/resolve') resolveIssue(@CurrentUser() u: AuthUser, @Param('issueId') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.resolveIssue(u, id, dto, c); }
  @Patch('assignments/:aid') updateAssignment(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.updateAssignment(u, id, dto, c); }
  @Post('assignments/:aid/availability') availability(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.setAvailability(u, id, dto, c); }
  @Post('assignments/:aid/hold') hold(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.hold(u, id, dto, c); }
  @Post('assignments/:aid/request-confirmation') requestConfirmation(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.requestConfirmation(u, id, dto, c); }
  @Post('assignments/:aid/confirm') confirm(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.confirm(u, id, dto, c); }
  @Post('assignments/:aid/release') release(@CurrentUser() u: AuthUser, @Param('aid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.release(u, id, dto, c); }
  @Put('quotes/:qid') updateQuote(@CurrentUser() u: AuthUser, @Param('qid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.updateQuote(u, id, dto, c); }
  @Post('quotes/:qid/submit') submitQuote(@CurrentUser() u: AuthUser, @Param('qid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.submitQuote(u, id, dto, c); }
  @Post('quotes/:qid/decision') decideQuote(@CurrentUser() u: AuthUser, @Param('qid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.decideQuote(u, id, dto, c); }
  @Post('quotes/:qid/mark-sent') markSent(@CurrentUser() u: AuthUser, @Param('qid') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.markQuoteSent(u, id, dto, c); }

  // Una producción
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string, @Query('companyId') c?: string) { return this.s.get(u, id, c); }
  @Patch(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.update(u, id, dto, c); }
  @Put(':id/brief') brief(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.updateBrief(u, id, dto, c); }
  @Post(':id/transition') transition(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.transition(u, id, dto, c); }
  @Post(':id/tasks') createTask(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.createTask(u, id, dto, c); }
  @Post(':id/issues') createIssue(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.createIssue(u, id, dto, c); }
  @Post(':id/assignments') addAssignment(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.addAssignment(u, id, dto, c); }
  @Post(':id/quotes') createQuote(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') c?: string) { return this.s.createQuote(u, id, dto, c); }
}

@Module({
  imports: [AuditModule],
  controllers: [ProductionsController],
  providers: [ProductionsService, WorkflowService],
  exports: [ProductionsService, WorkflowService],
})
export class ProductionsModule {}
