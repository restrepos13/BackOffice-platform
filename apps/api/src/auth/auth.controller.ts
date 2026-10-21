import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';
import { AuthUser } from '../common/constants';

class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(6)
  @MaxLength(200)
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  @MinLength(6)
  currentPassword!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}

class MfaVerifyDto {
  @IsString()
  @MaxLength(2000)
  mfaToken!: string;

  @IsString()
  @MaxLength(20)
  code!: string;
}

class MfaCodeDto {
  @IsString()
  @MaxLength(20)
  code!: string;
}

class MfaDisableDto {
  @IsString()
  @MaxLength(200)
  password!: string;

  @IsString()
  @MaxLength(20)
  code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Anti fuerza bruta: máx. 10 intentos de login por minuto por IP
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Segundo paso del login (código de la app o de recuperación). */
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  @Post('mfa/verify')
  verifyMfa(@Body() dto: MfaVerifyDto) {
    return this.auth.verifyMfa(dto.mfaToken, dto.code);
  }

  @Get('mfa')
  mfaStatus(@CurrentUser() user: AuthUser) {
    return this.auth.mfaStatus(user.id);
  }

  @Post('mfa/setup')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  mfaSetup(@CurrentUser() user: AuthUser) {
    return this.auth.mfaSetup(user.id);
  }

  @Post('mfa/enable')
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  mfaEnable(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto) {
    return this.auth.mfaEnable(user.id, dto.code);
  }

  @Post('mfa/disable')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  mfaDisable(@CurrentUser() user: AuthUser, @Body() dto: MfaDisableDto) {
    return this.auth.mfaDisable(user.id, dto.password, dto.code);
  }

  /** Cierra la sesión en el servidor (todos los dispositivos). */
  @Post('logout')
  logout(@CurrentUser() user: AuthUser) {
    return this.auth.logout(user.id);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }

  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user.id, dto.currentPassword, dto.newPassword);
  }

  /** El tour de bienvenida se muestra una sola vez por usuario. */
  @Post('tour-done')
  tourDone(@CurrentUser() user: AuthUser) {
    return this.auth.completeTour(user.id);
  }
}
