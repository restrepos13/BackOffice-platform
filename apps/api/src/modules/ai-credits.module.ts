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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { AuthUser, ROLES, isPlatformRole, scopeCompanyId } from '../common/constants';
import { computeAiCredits, creditAiLot } from '../ai/ai-access';
import { AuditService } from './audit.module';
import { PaymentsModule, PaymentsService } from './payments.module';

/**
 * Paquetes prepagos de IA de BackOffice:
 *  - Catálogo (plataforma lo administra): conversaciones, precio, vigencia.
 *  - La empresa compra con Wompi (cuenta de BackOffice); al aprobarse el pago
 *    se acredita el lote (idempotente por referencia).
 *  - Plataforma puede regalar saldo (cortesía, compensación, prueba).
 *  - Historial: lotes con su vencimiento y consumo del mes.
 */
@Injectable()
export class AiCreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {}

  private resolveCompany(user: AuthUser, companyId?: string): string {
    const scoped = scopeCompanyId(user, companyId);
    if (!scoped || scoped === '__none__') throw new ForbiddenException('Falta companyId');
    return scoped;
  }

  packages(includeInactive = false) {
    return this.prisma.aiCreditPackage.findMany({
      where: includeInactive ? undefined : { active: true },
      orderBy: [{ sortOrder: 'asc' }, { conversations: 'asc' }],
    });
  }

  private validatePackage(dto: any) {
    const name = String(dto?.name ?? '').trim().slice(0, 80);
    const conversations = Math.round(Number(dto?.conversations));
    const price = Number(dto?.price);
    const validityMonths = Math.round(Number(dto?.validityMonths ?? 12));
    if (!name) throw new BadRequestException('Escribe el nombre del paquete');
    if (!Number.isFinite(conversations) || conversations < 1) throw new BadRequestException('Conversaciones debe ser ≥ 1');
    if (!Number.isFinite(price) || price < 0) throw new BadRequestException('Precio inválido');
    if (!Number.isFinite(validityMonths) || validityMonths < 1 || validityMonths > 36) {
      throw new BadRequestException('La vigencia va de 1 a 36 meses');
    }
    return {
      name, conversations, price, validityMonths,
      currency: dto?.currency === 'USD' ? 'USD' : 'COP',
      active: dto?.active ?? true,
      sortOrder: Math.round(Number(dto?.sortOrder ?? 0)) || 0,
    };
  }

  async savePackage(user: AuthUser, dto: any, id?: string) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const data = this.validatePackage(dto);
    const pkg = id
      ? await this.prisma.aiCreditPackage.update({ where: { id }, data })
      : await this.prisma.aiCreditPackage.create({ data });
    await this.audit.log({
      actor: user, action: id ? 'ai_package.update' : 'ai_package.create',
      entity: 'AiCreditPackage', entityId: pkg.id, detail: `${pkg.name}: ${pkg.conversations} conv · ${pkg.price} ${pkg.currency}`,
    });
    return pkg;
  }

  async removePackage(user: AuthUser, id: string) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    // Se desactiva (no se borra): hay lotes y pagos que lo referencian
    const pkg = await this.prisma.aiCreditPackage.update({ where: { id }, data: { active: false } });
    await this.audit.log({ actor: user, action: 'ai_package.disable', entity: 'AiCreditPackage', entityId: id, detail: pkg.name });
    return { ok: true };
  }

  /** Estado del saldo + lotes + consumo reciente de una empresa. */
  async status(user: AuthUser, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: scoped } });
    const [credits, lots, recentUses] = await Promise.all([
      computeAiCredits(this.prisma, company),
      this.prisma.aiCreditLot.findMany({ where: { companyId: scoped }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.aiCreditUse.findMany({ where: { companyId: scoped }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    const now = Date.now();
    return {
      credits,
      lots: lots.map((l) => ({ ...l, expired: l.expiresAt.getTime() <= now })),
      recentUses,
      packages: await this.packages(),
    };
  }

  /** La empresa compra un paquete: checkout de Wompi con la cuenta de BackOffice. */
  async checkout(user: AuthUser, packageId: string, companyId?: string) {
    const scoped = this.resolveCompany(user, companyId);
    const pkg = await this.prisma.aiCreditPackage.findUnique({ where: { id: packageId } });
    if (!pkg || !pkg.active) throw new NotFoundException('Paquete no disponible');
    return this.payments.createPackageCheckout(user, scoped, pkg);
  }

  /** Plataforma acredita saldo a mano (cortesía, compensación, pago por fuera). */
  async grant(user: AuthUser, dto: { companyId: string; conversations: number; validityMonths?: number; note?: string }) {
    if (!isPlatformRole(user.role)) throw new ForbiddenException();
    const company = await this.prisma.company.findUnique({ where: { id: dto?.companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');
    const conversations = Math.round(Number(dto.conversations));
    if (!Number.isFinite(conversations) || conversations < 1 || conversations > 1_000_000) {
      throw new BadRequestException('Cantidad inválida');
    }
    const lot = await creditAiLot(this.prisma, {
      companyId: company.id, conversations, source: 'GRANT',
      validityMonths: Math.min(Math.max(Math.round(Number(dto.validityMonths ?? 12)), 1), 36),
      note: dto.note?.slice(0, 200) ?? null, createdBy: user.name,
    });
    await this.audit.log({
      actor: user, companyId: company.id, action: 'ai_credits.grant',
      entity: 'AiCreditLot', entityId: lot.id, detail: `${conversations} conversaciones${dto.note ? ` · ${dto.note}` : ''}`,
    });
    return lot;
  }
}

@Controller('ai-credits')
export class AiCreditsController {
  constructor(private readonly credits: AiCreditsService) {}

  @Get('packages')
  packages(@CurrentUser() user: AuthUser, @Query('all') all?: string) {
    return this.credits.packages(all === '1' && isPlatformRole(user.role));
  }

  @Post('packages')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  createPackage(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.credits.savePackage(user, dto);
  }

  @Patch('packages/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  updatePackage(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: any) {
    return this.credits.savePackage(user, dto, id);
  }

  @Delete('packages/:id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  removePackage(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.credits.removePackage(user, id);
  }

  @Get('status')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  status(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.credits.status(user, companyId);
  }

  @Post('checkout')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  checkout(@CurrentUser() user: AuthUser, @Body() dto: { packageId: string; companyId?: string }) {
    return this.credits.checkout(user, dto?.packageId, dto?.companyId);
  }

  @Post('grant')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV)
  grant(@CurrentUser() user: AuthUser, @Body() dto: any) {
    return this.credits.grant(user, dto);
  }
}

@Module({
  imports: [PaymentsModule],
  controllers: [AiCreditsController],
  providers: [AiCreditsService],
})
export class AiCreditsModule {}
