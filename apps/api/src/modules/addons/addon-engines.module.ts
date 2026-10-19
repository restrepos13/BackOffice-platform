import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, Roles } from '../../auth/decorators';
import { AuthUser, ROLES, isPlatformRole } from '../../common/constants';
import {
  DEFAULT_COLLECTIONS, DEFAULT_REACTIVATION, addonEnabled, collectionsConfig, reactivationConfig, salesAuditConfig, withAddonConfig,
} from '../../common/addon-config';
import { AI_PROVIDER } from '../../ai/types';
import { DeepInfraProvider } from '../../ai/deepinfra.provider';
import { AuditModule, AuditService } from '../audit.module';
import { EmailsModule } from '../emails.module';
import { ReactivationService } from './reactivation.service';
import { CollectionsService } from './collections.service';
import { SalesAuditService } from './sales-audit.service';

/**
 * Panel de los complementos automáticos: ver lo que harán y lo que lograron,
 * ajustar y ejecutar a demanda. Solo con el complemento activo (lo activa el
 * equipo cuando la empresa lo pide); el administrador configura, el de solo
 * lectura mira.
 */

const ADDON_NAMES: Record<string, string> = { reactivation: 'Reactivación de clientes dormidos', collections: 'Cobranza humanizada', salesAudit: 'Auditor de ventas' };

@Injectable()
export class AddonPanelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    readonly reactivation: ReactivationService,
    readonly collections: CollectionsService,
    readonly salesAudit: SalesAuditService,
  ) {}

  async company(user: AuthUser, companyId: string | undefined, key: string) {
    const id = isPlatformRole(user.role) ? companyId : user.companyId;
    if (!id) throw new ForbiddenException('Falta companyId');
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id } });
    if (!addonEnabled(company, key)) {
      throw new ForbiddenException(`${ADDON_NAMES[key]} no está activo. Pídelo en Mi plan y tu asesor lo configura.`);
    }
    return company;
  }

  async saveConfig(user: AuthUser, companyId: string | undefined, key: 'reactivation' | 'collections' | 'salesAudit', raw: any) {
    const company = await this.company(user, companyId, key);
    // Se guarda lo recibido y se vuelve a leer con los límites de cada campo
    const merged = { ...(key === 'reactivation' ? DEFAULT_REACTIVATION : key === 'collections' ? DEFAULT_COLLECTIONS : {}), ...(raw ?? {}) };
    const updated = await this.prisma.company.update({ where: { id: company.id }, data: { addonsJson: withAddonConfig(company, key, merged) } });
    const clean = key === 'reactivation' ? reactivationConfig(updated) : key === 'collections' ? collectionsConfig(updated) : salesAuditConfig(updated);
    await this.prisma.company.update({ where: { id: company.id }, data: { addonsJson: withAddonConfig(updated, key, clean) } });
    await this.audit.log({ actor: user, companyId: company.id, action: 'addon.config', entity: 'Company', entityId: company.id, detail: ADDON_NAMES[key] });
    return clean;
  }
}

@Controller('addons')
export class AddonPanelController {
  constructor(private readonly panel: AddonPanelService) {}

  /* Reactivación */
  @Get('reactivation')
  async reactivation(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.panel.reactivation.summary(await this.panel.company(user, companyId, 'reactivation'));
  }

  @Put('reactivation/config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  reactivationConfig(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.panel.saveConfig(user, companyId, 'reactivation', dto);
  }

  @Post('reactivation/run')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async reactivationRun(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    const company = await this.panel.company(user, companyId, 'reactivation');
    const limit = Number(dto?.limit);
    return this.panel.reactivation.run(company, { limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : undefined });
  }

  /* Cobranza */
  @Get('collections')
  async collections(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.panel.collections.summary(await this.panel.company(user, companyId, 'collections'));
  }

  @Put('collections/config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  collectionsConfig(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.panel.saveConfig(user, companyId, 'collections', dto);
  }

  @Post('collections/run')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async collectionsRun(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.panel.collections.run(await this.panel.company(user, companyId, 'collections'));
  }

  @Post('collections/receivables')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async createReceivable(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    const company = await this.panel.company(user, companyId, 'collections');
    return this.panel.collections.create(company.id, user.name, dto ?? {});
  }

  @Patch('collections/receivables/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async updateReceivable(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any, @Query('companyId') companyId?: string) {
    const company = await this.panel.company(user, companyId, 'collections');
    return this.panel.collections.update(company.id, id, dto ?? {});
  }

  /* Auditor */
  @Get('sales-audit')
  async salesAudit(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    const company = await this.panel.company(user, companyId, 'salesAudit');
    return { config: salesAuditConfig(company), reports: await this.panel.salesAudit.list(company.id) };
  }

  @Put('sales-audit/config')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  salesAuditConfig(@CurrentUser() user: AuthUser, @Body() dto: any, @Query('companyId') companyId?: string) {
    return this.panel.saveConfig(user, companyId, 'salesAudit', dto);
  }

  @Post('sales-audit/generate')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  async generate(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    const company = await this.panel.company(user, companyId, 'salesAudit');
    const last = (await this.panel.salesAudit.list(company.id))[0];
    // Uno por hora como máximo a demanda (el automático es semanal)
    if (last && Date.now() - new Date(last.createdAt).getTime() < 3600e3 && !isPlatformRole(user.role)) {
      throw new BadRequestException('Ya generaste un informe hace menos de una hora');
    }
    return this.panel.salesAudit.generate(company, { send: false });
  }
}

@Module({
  imports: [AuditModule, EmailsModule],
  controllers: [AddonPanelController],
  providers: [
    AddonPanelService, ReactivationService, CollectionsService, SalesAuditService,
    { provide: AI_PROVIDER, useClass: DeepInfraProvider },
  ],
})
export class AddonEnginesModule {}
