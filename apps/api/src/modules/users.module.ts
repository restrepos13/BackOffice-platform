import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, publicUser } from '../auth/auth.service';
import { CurrentUser, Roles } from '../auth/decorators';
import {
  AuthUser,
  ROLES,
  isPlatformRole,
  scopeCompanyId,
} from '../common/constants';
import { AuditService } from './audit.module';
import { forgetSession } from '../auth/jwt.guard';

/** Claves de plataforma: más largas que las de empresa (ven todas las empresas). */
const PLATFORM_MIN_PASSWORD = 10;

class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(2) name!: string;
  @IsIn(Object.values(ROLES)) role!: string;
  @IsString() @MinLength(8) password!: string;
  @IsOptional() @IsString() companyId?: string;
  @IsOptional() @IsString() jobTitle?: string;
  @IsOptional() @IsString() phone?: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsIn(Object.values(ROLES)) role?: string;
  @IsOptional() @IsString() jobTitle?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() active?: boolean;
  @IsOptional() @IsString() @MinLength(8) password?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private safe<T extends Record<string, any>>(u: T) {
    // Nunca salen hashes, secretos de MFA ni contadores internos
    return publicUser(u) as Omit<T, 'passwordHash'>;
  }

  async list(user: AuthUser, companyId?: string) {
    const scoped = scopeCompanyId(user, companyId);
    const users = await this.prisma.user.findMany({
      where: scoped ? { companyId: scoped } : undefined,
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: { company: { select: { name: true, slug: true } } },
    });
    return users.map((u) => this.safe(u));
  }

  async create(actor: AuthUser, dto: CreateUserDto) {
    // Roles de empresa solo pueden crear usuarios dentro de su empresa y de rango igual o menor
    // El admin de la empresa también da de alta a sus domiciliarios
    const companyRoles: string[] = [ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER, ROLES.COMPANY_COURIER];
    if (!isPlatformRole(actor.role)) {
      if (!companyRoles.includes(dto.role)) {
        throw new ForbiddenException('No puedes crear usuarios de plataforma');
      }
      dto.companyId = actor.companyId ?? undefined;
    }
    this.assertCanManageRole(actor, dto.role);
    if (isPlatformRole(dto.role)) this.assertPlatformPassword(dto.password);
    if (
      [...companyRoles, ROLES.COMPANY_AREA].includes(dto.role) &&
      !dto.companyId
    ) {
      throw new BadRequestException('Un usuario de empresa necesita companyId');
    }
    const exists = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });
    if (exists) throw new BadRequestException('Ya existe un usuario con ese correo');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email.toLowerCase(),
        name: dto.name,
        role: dto.role,
        companyId: isPlatformRole(dto.role) ? null : dto.companyId,
        jobTitle: dto.jobTitle,
        phone: dto.phone,
        passwordHash: AuthService.hashPassword(dto.password),
      },
    });
    await this.audit.log({
      actor,
      companyId: user.companyId,
      action: 'user.create',
      entity: 'User',
      entityId: user.id,
      detail: `${user.name} (${user.role})`,
    });
    return this.safe(user);
  }

  /**
   * Reglas del equipo BackOffice:
   *  - Solo un Super Admin crea, edita o borra Super Admins.
   *  - Un Dev da de alta otros Devs (y usuarios de empresas), nunca Super Admins.
   */
  private assertCanManageRole(actor: AuthUser, role: string) {
    if (role === ROLES.SUPER_ADMIN && actor.role !== ROLES.SUPER_ADMIN) {
      throw new ForbiddenException('Solo un Super Admin puede gestionar cuentas Super Admin');
    }
  }

  private assertPlatformPassword(password?: string) {
    if (password && password.length < PLATFORM_MIN_PASSWORD) {
      throw new BadRequestException(
        `La contraseña de un usuario de plataforma necesita al menos ${PLATFORM_MIN_PASSWORD} caracteres`,
      );
    }
  }

  /** Nunca dejar la plataforma sin un Super Admin activo. */
  private async assertNotLastSuperAdmin(target: { id: string; role: string; active: boolean }) {
    if (target.role !== ROLES.SUPER_ADMIN || !target.active) return;
    const others = await this.prisma.user.count({
      where: { role: ROLES.SUPER_ADMIN, active: true, id: { not: target.id } },
    });
    if (others === 0) throw new BadRequestException('Debe quedar al menos un Super Admin activo');
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto) {
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    if (!isPlatformRole(actor.role) && target.companyId !== actor.companyId) {
      throw new ForbiddenException();
    }
    if (!isPlatformRole(actor.role) && dto.role && isPlatformRole(dto.role)) {
      throw new ForbiddenException('No puedes asignar roles de plataforma');
    }
    this.assertCanManageRole(actor, target.role);
    if (dto.role) this.assertCanManageRole(actor, dto.role);
    // Pasar de plataforma a empresa (o al revés) cambia a quién ve: se hace creando otro usuario
    if (dto.role && isPlatformRole(dto.role) !== isPlatformRole(target.role)) {
      throw new BadRequestException('No se puede pasar un usuario entre plataforma y empresa; crea uno nuevo');
    }
    if (target.id === actor.id && (dto.active === false || (dto.role && dto.role !== target.role))) {
      throw new BadRequestException('No puedes desactivarte ni cambiarte el rol a ti mismo');
    }
    if (dto.active === false || (dto.role && dto.role !== target.role)) {
      await this.assertNotLastSuperAdmin(target);
    }
    if (isPlatformRole(dto.role ?? target.role)) this.assertPlatformPassword(dto.password);
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        name: dto.name,
        role: dto.role,
        jobTitle: dto.jobTitle,
        phone: dto.phone,
        active: dto.active,
        ...(dto.password
          ? { passwordHash: AuthService.hashPassword(dto.password), failedLogins: 0, lockedUntil: null }
          : {}),
        // Clave, rol o estado nuevos: las sesiones abiertas de esa persona se cierran
        ...(dto.password || dto.active === false || (dto.role && dto.role !== target.role)
          ? { sessionVersion: (target.sessionVersion ?? 0) + 1 }
          : {}),
      },
    });
    forgetSession(id); // rol o estado nuevos rigen desde la próxima petición
    await this.audit.log({
      actor,
      companyId: user.companyId,
      action: 'user.update',
      entity: 'User',
      entityId: user.id,
      detail: user.name,
    });
    return this.safe(user);
  }

  async remove(actor: AuthUser, id: string) {
    const target = await this.prisma.user.findUniqueOrThrow({ where: { id } });
    if (!isPlatformRole(actor.role) && target.companyId !== actor.companyId) {
      throw new ForbiddenException();
    }
    if (target.id === actor.id) {
      throw new BadRequestException('No puedes eliminar tu propio usuario');
    }
    this.assertCanManageRole(actor, target.role);
    await this.assertNotLastSuperAdmin(target);
    await this.prisma.user.delete({ where: { id } });
    forgetSession(id);
    await this.audit.log({
      actor,
      companyId: target.companyId,
      action: 'user.delete',
      entity: 'User',
      entityId: id,
      detail: target.name,
    });
    return { ok: true };
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN, ROLES.COMPANY_VIEWER)
  list(@CurrentUser() user: AuthUser, @Query('companyId') companyId?: string) {
    return this.users.list(user, companyId);
  }

  @Post()
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(user, dto);
  }

  @Patch(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(user, id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.SUPER_ADMIN, ROLES.DEV, ROLES.COMPANY_ADMIN)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.remove(user, id);
  }
}

@Module({
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
