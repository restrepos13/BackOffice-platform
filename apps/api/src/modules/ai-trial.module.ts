import { BadRequestException, Body, Controller, Delete, Get, Inject, Injectable, Module, NotFoundException, Optional, Param, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES } from '../common/constants';
import {
  AI_TRIAL_DEFAULT_DAILY, AI_TRIAL_DEFAULT_DAYS, AI_TRIAL_MAX_DAILY, AI_TRIAL_MAX_DAYS, AI_TRIAL_NOTICE, activeAiTrial, aiTrialFrom, readAiTrial,
} from '../common/ai-trial';
import { CompanyTextAi } from '../ai/company-text-ai';
import { GeminiPool } from '../ai/gemini-pool';
import { DeepInfraProvider } from '../ai/deepinfra.provider';
import { AI_PROVIDER, AiProvider } from '../ai/types';
import { AuditService } from './audit.module';

/**
 * IA de prueba por empresa (common/ai-trial.ts). Solo la autoriza el equipo
 * de la plataforma (SUPER_ADMIN y DEV): nunca la empresa, nunca por defecto.
 */
@Injectable()
export class AiTrialService {
  readonly textAi: CompanyTextAi;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() @Inject(AI_PROVIDER) ai?: AiProvider,
  ) {
    this.textAi = new CompanyTextAi(prisma, ai, new GeminiPool(prisma));
  }

  private async company(id: string) {
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    return c;
  }

  async status(companyId: string) {
    const c = await this.company(companyId);
    const saved = readAiTrial(c);
    const active = activeAiTrial(c);
    const ai = await this.textAi.describe(c);
    return {
      trial: saved,
      active: !!active,
      expired: !!saved && !active,
      usageToday: active ? (await this.textAi.genericUsage(c.id, active.dailyLimit)).used : 0,
      // Si la empresa ya tiene IA propia, la de prueba queda de respaldo
      source: ai.source,
      defaults: { days: AI_TRIAL_DEFAULT_DAYS, dailyLimit: AI_TRIAL_DEFAULT_DAILY, maxDays: AI_TRIAL_MAX_DAYS, maxDailyLimit: AI_TRIAL_MAX_DAILY },
      covers: ['Creative: entender lo que pide el cliente y corregir las piezas del motor', 'Creative y Ads: sugerir textos para anuncios', 'Ads: revisar la pieza (imagen y textos) antes de publicar', 'Reportes: resumen en palabras'],
      notice: AI_TRIAL_NOTICE,
    };
  }

  async authorize(user: AuthUser, companyId: string, dto: any) {
    const c = await this.company(companyId);
    let trial;
    try {
      trial = aiTrialFrom(dto, user.name);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'Datos inválidos');
    }
    await this.prisma.company.update({ where: { id: c.id }, data: { aiTrialJson: JSON.stringify(trial) } });
    await this.audit.log({
      actor: user, companyId: c.id, action: 'ai.trial_authorized', entity: 'Company', entityId: c.id,
      detail: `IA de prueba hasta ${trial.until.slice(0, 10)} · ${trial.dailyLimit} usos al día${trial.note ? ` · ${trial.note}` : ''}`,
    });
    return this.status(c.id);
  }

  async revoke(user: AuthUser, companyId: string) {
    const c = await this.company(companyId);
    await this.prisma.company.update({ where: { id: c.id }, data: { aiTrialJson: null } });
    await this.audit.log({ actor: user, companyId: c.id, action: 'ai.trial_revoked', entity: 'Company', entityId: c.id, detail: 'IA de prueba desactivada' });
    return this.status(c.id);
  }
}

const PLATFORM = [ROLES.SUPER_ADMIN, ROLES.DEV] as const;

@Controller('platform/companies/:id/ai-trial')
export class AiTrialController {
  constructor(private readonly s: AiTrialService) {}

  @Get() @Roles(...PLATFORM)
  status(@Param('id') id: string) { return this.s.status(id); }

  @Put() @Roles(...PLATFORM)
  authorize(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: any) { return this.s.authorize(u, id, dto); }

  @Delete() @Roles(...PLATFORM)
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.s.revoke(u, id); }
}

@Module({
  controllers: [AiTrialController],
  providers: [AiTrialService, { provide: AI_PROVIDER, useClass: DeepInfraProvider }],
})
export class AiTrialModule {}
