import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!user || !user.active) {
      throw new UnauthorizedException('Credenciales inválidas');
    }
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Credenciales inválidas');

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = await this.jwt.signAsync({
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      companyId: user.companyId,
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        companyId: user.companyId,
        company: user.company,
        jobTitle: user.jobTitle,
      },
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { company: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!user) throw new UnauthorizedException();
    const { passwordHash: _ph, ...safe } = user;
    return safe;
  }

  static hashPassword(plain: string): string {
    return bcrypt.hashSync(plain, 10);
  }
}
