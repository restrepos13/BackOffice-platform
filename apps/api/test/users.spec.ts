/**
 * Pruebas — Equipo BackOffice: alta de devs, quién puede tocar a un Super Admin,
 * corte de acceso inmediato al desactivar y protección contra quedarse sin admins.
 */
import { UsersService } from '../src/modules/users.module';
import { JwtAuthGuard } from '../src/auth/jwt.guard';
import { createMockPrisma } from './helpers/mock-prisma';

const SA = { id: 'sa1', email: 'sa@backoffice.dev', name: 'SA', role: 'SUPER_ADMIN' as const, companyId: null };
const DEV = { id: 'dev1', email: 'dev@backoffice.dev', name: 'Dev', role: 'DEV' as const, companyId: null };
const ADMIN = { id: 'adm1', email: 'a@empresa.co', name: 'Admin', role: 'COMPANY_ADMIN' as const, companyId: 'c1' };

function setup() {
  const { prisma, db } = createMockPrisma();
  db.user.push(
    { ...SA, active: true, passwordHash: 'x', failedLogins: 0, lockedUntil: null },
    { ...DEV, active: true, passwordHash: 'x', failedLogins: 0, lockedUntil: null },
    { ...ADMIN, active: true, passwordHash: 'x', failedLogins: 0, lockedUntil: null },
  );
  const audit = { log: jest.fn(async () => undefined) };
  const service = new UsersService(prisma as any, audit as any);
  return { prisma, db, service, audit };
}

const newDev = { email: 'nuevo@backoffice.dev', name: 'Nuevo Dev', role: 'DEV', password: 'clave-larga-123' };

describe('Equipo BackOffice', () => {
  it('un Super Admin da de alta un dev sin empresa y sin exponer el hash', async () => {
    const { service, db, audit } = setup();
    const created: any = await service.create(SA, { ...newDev, companyId: 'c1' });
    expect(created.role).toBe('DEV');
    expect(created.companyId).toBeNull();
    expect(created.passwordHash).toBeUndefined();
    expect(db.user.find((u: any) => u.email === 'nuevo@backoffice.dev')).toBeTruthy();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.create' }));
  });

  it('un dev también puede dar de alta otro dev', async () => {
    const { service } = setup();
    const created: any = await service.create(DEV, newDev);
    expect(created.role).toBe('DEV');
  });

  it('un dev NO puede crear, editar ni borrar Super Admins', async () => {
    const { service } = setup();
    await expect(service.create(DEV, { ...newDev, role: 'SUPER_ADMIN' })).rejects.toThrow(/Super Admin/);
    await expect(service.update(DEV, 'sa1', { password: 'otra-clave-123' })).rejects.toThrow(/Super Admin/);
    await expect(service.remove(DEV, 'sa1')).rejects.toThrow(/Super Admin/);
  });

  it('un dev no se puede ascender a sí mismo ni ascender a otro a Super Admin', async () => {
    const { service } = setup();
    const other: any = await service.create(DEV, newDev);
    await expect(service.update(DEV, other.id, { role: 'SUPER_ADMIN' })).rejects.toThrow(/Super Admin/);
    await expect(service.update(DEV, 'dev1', { role: 'SUPER_ADMIN' })).rejects.toThrow();
  });

  it('la empresa no puede crear usuarios de plataforma', async () => {
    const { service } = setup();
    await expect(service.create(ADMIN, newDev)).rejects.toThrow(/plataforma/);
  });

  it('contraseña de plataforma mínima de 10 caracteres', async () => {
    const { service } = setup();
    await expect(service.create(SA, { ...newDev, password: 'corta123' })).rejects.toThrow(/10 caracteres/);
  });

  it('no se puede pasar un usuario de empresa a plataforma', async () => {
    const { service } = setup();
    await expect(service.update(SA, 'adm1', { role: 'DEV' })).rejects.toThrow(/plataforma y empresa/);
  });

  it('nadie se desactiva a sí mismo y siempre queda un Super Admin activo', async () => {
    const { service } = setup();
    await expect(service.update(SA, 'sa1', { active: false })).rejects.toThrow(/ti mismo/);
    const sa2: any = await service.create(SA, { ...newDev, email: 'sa2@backoffice.dev', role: 'SUPER_ADMIN' });
    await service.update(sa2, 'sa1', { active: false });
    await expect(service.remove(sa2 as any, 'sa1')).resolves.toEqual({ ok: true });
    await expect(service.update({ ...sa2, id: 'otro' } as any, sa2.id, { active: false })).rejects.toThrow(/al menos un Super Admin/);
  });

  it('un dev desactivado pierde el acceso enseguida aunque su token siga vigente', async () => {
    const { prisma, service } = setup();
    const dev: any = await service.create(SA, newDev);
    const jwt = { verifyAsync: jest.fn(async () => ({ sub: dev.id, email: dev.email, name: dev.name, role: 'DEV' })) };
    const reflector = { getAllAndOverride: () => false };
    const guard = new JwtAuthGuard(jwt as any, reflector as any, prisma as any);
    const req: any = { headers: { authorization: 'Bearer token' } };
    const ctx: any = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user.role).toBe('DEV');

    await service.update(SA, dev.id, { active: false });
    await expect(guard.canActivate(ctx)).rejects.toThrow(/desactivado/);

    await service.update(SA, dev.id, { active: true });
    // Desactivar cierra sus sesiones: al reactivarlo, el token viejo sigue sin servir (debe entrar de nuevo)
    await expect(guard.canActivate(ctx)).rejects.toThrow(/sesión se cerró/);
    await service.remove(SA, dev.id);
    await expect(guard.canActivate(ctx)).rejects.toThrow();
  });
});
