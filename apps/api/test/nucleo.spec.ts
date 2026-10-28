/**
 * Fase 1 — Núcleo SaaS: contexto de empresa, secciones en el servidor,
 * invitaciones, recuperación de contraseña, límites del plan, validación de
 * la configuración de la empresa e inventario de datos para el borrado.
 * Datos ficticios; nada sale del proceso (sin SMTP los correos quedan en cola).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AuthService } from '../src/auth/auth.service';
import { RolesGuard } from '../src/auth/roles.guard';
import { SectionsGuard } from '../src/auth/sections.guard';
import { AccountService, INVITE_TTL_MS, InvitationsController, RESET_TTL_MS, hashToken } from '../src/modules/account.module';
import { BotsService } from '../src/modules/bots.module';
import { CompaniesService, validateCompanyBasics } from '../src/modules/companies.module';
import { ContactsService } from '../src/modules/contacts.module';
import { EmailsService } from '../src/modules/emails.module';
import { IntegrationsService } from '../src/modules/integrations.module';
import { ProductionsController } from '../src/modules/productions/productions.module';
import { UsersController, UsersService } from '../src/modules/users.module';
import { CASCADE_MODELS, CLEANED_MODELS, ORPHANED_MODELS, SET_NULL_MODELS, companyDataFootprint } from '../src/common/company-cleanup';
import { effectiveLimit } from '../src/common/limits';
import { onboardingChecklist } from '../src/common/rubros';
import { assertRefsInTenant, requireTenant, tenantFilter } from '../src/common/tenant';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba-largo-123';
const u = (id: string, role: string, companyId: string | null) => ({ id, name: id, email: `${id.toLowerCase()}@prueba.test`, role, companyId }) as any;
const ADMIN_A = u('adminA', 'COMPANY_ADMIN', 'coA');
const VIEWER_A = u('viewerA', 'COMPANY_VIEWER', 'coA');
const AREA_A = u('areaA', 'COMPANY_AREA', 'coA');
const ADMIN_B = u('adminB', 'COMPANY_ADMIN', 'coB');
const DEV = u('dev', 'DEV', null);

function world() {
  const { prisma, db: raw } = createMockPrisma();
  const db = raw as any;
  db.plan.push({ id: 'p2', name: 'Plan de prueba', maxUsers: 6, maxBots: 1 });
  db.company.push(
    { id: 'coA', name: 'Empresa A (prueba)', slug: 'a', planId: 'p2', limitsJson: '{}', modulesJson: JSON.stringify(['inbox']) },
    { id: 'coB', name: 'Empresa B (prueba)', slug: 'b', planId: null, limitsJson: '{}', modulesJson: JSON.stringify(['inbox', 'productions']) },
  );
  for (const x of [ADMIN_A, VIEWER_A, AREA_A, ADMIN_B, DEV]) {
    db.user.push({ id: x.id, name: x.name, email: x.email, role: x.role, companyId: x.companyId, active: true, sessionVersion: 0, failedLogins: 0, passwordHash: bcrypt.hashSync('vieja-clave-123', 4) });
  }
  const audit = { log: jest.fn(async () => undefined) };
  const emails = new EmailsService(prisma as any, audit as any);
  const auth = new AuthService(prisma as any, new JwtService({ secret: process.env.JWT_SECRET }), audit as any);
  const account = new AccountService(prisma as any, audit as any, emails, auth);
  return { prisma, db, audit, account, users: new UsersService(prisma as any, audit as any) };
}
const guardCtx = (user: any, handler: any, cls: any) => ({ getHandler: () => handler, getClass: () => cls, switchToHttp: () => ({ getRequest: () => ({ user, url: '/api/x' }) }) }) as any;

describe('A · Contexto de empresa y autorización', () => {
  it('la empresa sale de la sesión: un usuario de empresa no puede pedir otra; plataforma debe elegir', () => {
    expect(requireTenant(ADMIN_A, 'coB')).toBe('coA');
    expect(() => requireTenant(DEV, undefined)).toThrow(ForbiddenException);
    expect(requireTenant(DEV, 'coB')).toBe('coB');
    expect(tenantFilter(ADMIN_A, 'coB')).toBe('coA');
    expect(tenantFilter(DEV, undefined)).toBeUndefined();
    expect(tenantFilter(u('x', 'COMPANY_ADMIN', null))).toBe('__none__');
  });

  it('referencias del navegador deben ser de la misma empresa', async () => {
    const w = world();
    w.db.bot.push({ id: 'botB', companyId: 'coB' });
    await expect(assertRefsInTenant(w.prisma, 'coA', { userId: 'adminB' })).rejects.toThrow(/no pertenece/);
    await expect(assertRefsInTenant(w.prisma, 'coA', { botId: 'botB' })).rejects.toThrow(/asistente/);
    await expect(assertRefsInTenant(w.prisma, 'coA', { userId: 'viewerA', customerId: null, contactId: '' })).resolves.toBeUndefined();
  });

  it('contactos: no se puede asignar a un usuario ni enlazar un cliente de otra empresa', async () => {
    const w = world();
    const contacts = new ContactsService(w.prisma as any, w.audit as any);
    w.db.customer.push({ id: 'custB', companyId: 'coB', name: 'Cliente B' }, { id: 'custA', companyId: 'coA', name: 'Cliente A' });
    const c: any = await contacts.create(ADMIN_A, { name: 'Contacto de prueba', phone: '+570000000001' });
    await expect(contacts.update(ADMIN_A, c.id, { assignedToId: 'adminB' })).rejects.toThrow(/responsable no pertenece/);
    await expect(contacts.update(ADMIN_A, c.id, { customerId: 'custB' })).rejects.toThrow(/cliente no pertenece/);
    await expect(contacts.create(ADMIN_A, { name: 'Otro', assignedToId: 'adminB' })).rejects.toThrow(/no pertenece/);
    // Un usuario de empresa no crea en otra aunque mande companyId
    const own: any = await contacts.create(ADMIN_A, { name: 'Propio', companyId: 'coB', assignedToId: 'viewerA', customerId: 'custA' });
    expect(own).toMatchObject({ companyId: 'coA', assignedToId: 'viewerA' });
    await expect(contacts.update(ADMIN_B, c.id, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('una línea no puede usar el asistente de otra empresa', async () => {
    const w = world();
    w.db.bot.push({ id: 'botB', companyId: 'coB', name: 'Bot B' });
    const integrations = new IntegrationsService(w.prisma as any, w.audit as any);
    await expect(integrations.create(ADMIN_A, { type: 'WEBHOOK', name: 'Hook', botId: 'botB' })).rejects.toThrow(/asistente no pertenece/);
  });

  it('las secciones también se exigen en el servidor (Producciones)', async () => {
    const w = world();
    const guard = new SectionsGuard(new Reflector(), w.prisma as any);
    const list = (ProductionsController.prototype as any).list;
    await expect(guard.canActivate(guardCtx(ADMIN_A, list, ProductionsController))).rejects.toThrow(/no está habilitada/);
    await expect(guard.canActivate(guardCtx(ADMIN_B, list, ProductionsController))).resolves.toBe(true);
    await expect(guard.canActivate(guardCtx(DEV, list, ProductionsController))).resolves.toBe(true);
    // Sin decorador de sección: no aplica
    await expect(guard.canActivate(guardCtx(ADMIN_A, (UsersController.prototype as any).list, UsersController))).resolves.toBe(true);
  });

  it('sin privilegios implícitos: consulta no administra usuarios ni invita; área no entra', () => {
    const roles = new RolesGuard(new Reflector());
    expect(() => roles.canActivate(guardCtx(VIEWER_A, (UsersController.prototype as any).create, UsersController))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(guardCtx(VIEWER_A, (InvitationsController.prototype as any).invite, InvitationsController))).toThrow(ForbiddenException);
    expect(() => roles.canActivate(guardCtx(AREA_A, (InvitationsController.prototype as any).list, InvitationsController))).toThrow(ForbiddenException);
    expect(roles.canActivate(guardCtx(ADMIN_A, (InvitationsController.prototype as any).invite, InvitationsController))).toBe(true);
  });
});

describe('B · Invitaciones', () => {
  it('se guarda solo el hash; el correo queda en la base SIN el enlace; quien invita ve el enlace una vez', async () => {
    const w = world();
    const r: any = await w.account.invite(ADMIN_A, { email: 'Nueva@Prueba.test', role: 'COMPANY_VIEWER', opsProfile: 'BOOKER', name: 'Nueva' });
    const token = new URL(r.link).searchParams.get('token')!;
    expect(token.length).toBeGreaterThan(30);
    expect(r.emailStatus).toBe('QUEUED'); // sin SMTP
    expect(w.db.authToken[0]).toMatchObject({ kind: 'INVITE', email: 'nueva@prueba.test', companyId: 'coA', tokenHash: hashToken(token), usedAt: null });
    expect(JSON.stringify(w.db.authToken)).not.toContain(token);
    expect(JSON.stringify(w.db.emailMessage)).not.toContain(token);
    expect(JSON.stringify(w.audit.log.mock.calls)).not.toContain(token);
    expect(w.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invite', companyId: 'coA' }));
  });

  it('aceptar crea el usuario en la empresa y rol invitados y abre sesión; reusar, vencida o revocada fallan', async () => {
    const w = world();
    const r: any = await w.account.invite(ADMIN_A, { email: 'nueva@prueba.test', role: 'COMPANY_VIEWER', opsProfile: 'BOOKER' });
    const token = new URL(r.link).searchParams.get('token')!;
    expect(await w.account.previewInvitation(token)).toMatchObject({ companyName: 'Empresa A (prueba)', email: 'nueva@prueba.test' });
    const s: any = await w.account.acceptInvitation({ token, password: 'clave-segura-1', name: 'Nueva Persona' });
    expect(s.token).toBeTruthy();
    expect(w.db.user.find((x: any) => x.email === 'nueva@prueba.test')).toMatchObject({ companyId: 'coA', role: 'COMPANY_VIEWER', opsProfile: 'BOOKER', name: 'Nueva Persona' });
    await expect(w.account.acceptInvitation({ token, password: 'otra-clave-123' })).rejects.toThrow(/no es válida/);
    // Vencida
    const r2: any = await w.account.invite(ADMIN_A, { email: 'vence@prueba.test', role: 'COMPANY_ADMIN' });
    const t2 = new URL(r2.link).searchParams.get('token')!;
    w.account.now = () => new Date(Date.now() + INVITE_TTL_MS + 1000);
    await expect(w.account.acceptInvitation({ token: t2, password: 'clave-segura-1' })).rejects.toThrow(/no es válida/);
    await expect(w.account.previewInvitation(t2)).rejects.toBeInstanceOf(NotFoundException);
    w.account.now = () => new Date();
    // Revocada (y solo la revoca su empresa)
    const r3: any = await w.account.invite(DEV, { email: 'revocar@prueba.test', role: 'COMPANY_VIEWER', companyId: 'coA' });
    await expect(w.account.revokeInvitation(ADMIN_B, r3.invitation.id)).rejects.toBeInstanceOf(NotFoundException);
    await w.account.revokeInvitation(ADMIN_A, r3.invitation.id);
    await expect(w.account.acceptInvitation({ token: new URL(r3.link).searchParams.get('token')!, password: 'clave-segura-1' })).rejects.toThrow(/no es válida/);
  });

  it('dos aceptaciones a la vez del mismo enlace crean un solo usuario', async () => {
    const w = world();
    const r: any = await w.account.invite(ADMIN_A, { email: 'doble@prueba.test', role: 'COMPANY_VIEWER' });
    const token = new URL(r.link).searchParams.get('token')!;
    const out = await Promise.allSettled([w.account.acceptInvitation({ token, password: 'clave-segura-1' }), w.account.acceptInvitation({ token, password: 'clave-segura-2' })]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(w.db.user.filter((x: any) => x.email === 'doble@prueba.test')).toHaveLength(1);
  });

  it('no revela si el correo ya tiene cuenta al invitar; al aceptar falla sin decir dónde', async () => {
    const w = world();
    const r: any = await w.account.invite(ADMIN_A, { email: 'AdminB@prueba.test', role: 'COMPANY_VIEWER' });
    expect(r.invitation.status).toBe('PENDING');
    await expect(w.account.acceptInvitation({ token: new URL(r.link).searchParams.get('token')!, password: 'clave-segura-1' })).rejects.toThrow(/no se puede usar con ese correo/);
    expect(w.db.user.filter((x: any) => x.email === 'adminb@prueba.test')).toEqual([expect.objectContaining({ companyId: 'coB', role: 'COMPANY_ADMIN' })]);
  });

  it('aislamiento: cada empresa lista solo sus invitaciones; consulta no invita; perfiles inválidos se rechazan', async () => {
    const w = world();
    await w.account.invite(ADMIN_A, { email: 'a1@prueba.test', role: 'COMPANY_VIEWER' });
    expect(await w.account.listInvitations(ADMIN_B, 'coA')).toEqual([]);
    expect(await w.account.listInvitations(ADMIN_A)).toHaveLength(1);
    await expect(w.account.invite(VIEWER_A, { email: 'x@prueba.test', role: 'COMPANY_VIEWER' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(w.account.invite(ADMIN_A, { email: 'x@prueba.test', role: 'COMPANY_ADMIN', opsProfile: 'BOOKER' })).rejects.toThrow(/solo aplica/);
    await expect(w.account.invite(ADMIN_A, { email: 'x@prueba.test', role: 'SUPER_ADMIN' } as any)).rejects.toThrow(/Rol no permitido/);
    // Reinvitar al mismo correo reemplaza la invitación anterior
    await w.account.invite(ADMIN_A, { email: 'a1@prueba.test', role: 'COMPANY_VIEWER' });
    expect((await w.account.listInvitations(ADMIN_A)).map((i: any) => i.status).sort()).toEqual(['PENDING', 'REVOKED']);
  });
});

describe('B · Recuperación de contraseña', () => {
  const tokenFromFlow = async (w: ReturnType<typeof world>, email: string) => {
    // El token solo viaja por correo: en la prueba se intercepta el envío
    let captured = '';
    const spy = jest.spyOn((w.account as any).emails, 'systemSend').mockImplementation(async (p: any) => {
      captured = /token=([\w-]+)/.exec(p.body)?.[1] ?? '';
      expect(p.storedBody).not.toContain(captured);
      return { status: 'QUEUED' } as any;
    });
    const r = await w.account.forgot({ email });
    spy.mockRestore();
    return { r, token: captured };
  };

  it('responde igual exista o no la cuenta; solo crea token si existe y está activa', async () => {
    const w = world();
    const a = await w.account.forgot({ email: 'nadie@prueba.test' });
    const b = await w.account.forgot({ email: 'admina@prueba.test' });
    expect(a).toEqual(b);
    expect(w.db.authToken).toHaveLength(1);
    w.db.user.find((x: any) => x.id === 'viewerA').active = false;
    await w.account.forgot({ email: 'viewera@prueba.test' });
    expect(w.db.authToken).toHaveLength(1);
    expect(JSON.stringify(w.db.emailMessage)).not.toMatch(/token=/);
  });

  it('restablecer: cambia la clave, cierra sesiones, quita el bloqueo; el enlace sirve una vez y vence', async () => {
    const w = world();
    const target = w.db.user.find((x: any) => x.id === 'adminA');
    Object.assign(target, { failedLogins: 3, lockedUntil: new Date(Date.now() + 600000) });
    const { token } = await tokenFromFlow(w, 'admina@prueba.test');
    expect(token).toBeTruthy();
    await w.account.reset({ token, password: 'nueva-clave-123' });
    expect(bcrypt.compareSync('nueva-clave-123', target.passwordHash)).toBe(true);
    expect(target).toMatchObject({ sessionVersion: 1, failedLogins: 0, lockedUntil: null });
    await expect(w.account.reset({ token, password: 'otra-clave-123' })).rejects.toThrow(/no es válido/);
    const { token: t2 } = await tokenFromFlow(w, 'admina@prueba.test');
    w.account.now = () => new Date(Date.now() + RESET_TTL_MS + 1000);
    await expect(w.account.reset({ token: t2, password: 'nueva-clave-456' })).rejects.toThrow(/no es válido/);
    expect(w.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.password_reset' }));
  });

  it('pedir otro enlace invalida el anterior; plataforma exige 10 caracteres; un token de invitación no sirve para restablecer', async () => {
    const w = world();
    const { token: t1 } = await tokenFromFlow(w, 'admina@prueba.test');
    const { token: t2 } = await tokenFromFlow(w, 'admina@prueba.test');
    await expect(w.account.reset({ token: t1, password: 'nueva-clave-123' })).rejects.toThrow(/no es válido/);
    await w.account.reset({ token: t2, password: 'nueva-clave-123' });
    const { token: tDev } = await tokenFromFlow(w, 'dev@prueba.test');
    await expect(w.account.reset({ token: tDev, password: 'corta-123' })).rejects.toThrow(/10 caracteres/);
    const inv: any = await w.account.invite(ADMIN_A, { email: 'z@prueba.test', role: 'COMPANY_VIEWER' });
    await expect(w.account.reset({ token: new URL(inv.link).searchParams.get('token')!, password: 'nueva-clave-123' })).rejects.toThrow(/no es válido/);
  });
});

describe('D · Límites del plan', () => {
  it('fuente: excepción válida de la empresa, si no el plan, si no sin límite; valores inválidos se ignoran', async () => {
    const w = world();
    expect(await effectiveLimit(w.prisma, 'coA', 'users')).toMatchObject({ max: 6, source: 'PLAN' });
    expect(await effectiveLimit(w.prisma, 'coB', 'users')).toMatchObject({ max: null, source: 'NONE' });
    w.db.company[0].limitsJson = JSON.stringify({ maxUsers: 4 });
    expect(await effectiveLimit(w.prisma, 'coA', 'users')).toMatchObject({ max: 4, source: 'COMPANY_OVERRIDE' });
    for (const bad of [-1, 'diez', 2.5]) {
      w.db.company[0].limitsJson = JSON.stringify({ maxUsers: bad });
      expect(await effectiveLimit(w.prisma, 'coA', 'users')).toMatchObject({ max: 6, source: 'PLAN' });
    }
  });

  it('usuarios: al llegar al cupo responde claro y queda auditado; domiciliarios no cuentan; B no consume el cupo de A', async () => {
    const w = world();
    w.db.company[0].limitsJson = JSON.stringify({ maxUsers: 2 });
    // A ya tiene 3 personas activas con cupo 2: no se agregan más (las existentes no se tocan)
    await expect(w.users.create(ADMIN_A, { email: 'n@prueba.test', name: 'Nueva', role: 'COMPANY_VIEWER', password: 'clave-segura-1' } as any)).rejects.toThrow(/límite de 2 personas de tu cuenta/);
    expect(w.audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'limit.reached', companyId: 'coA' }));
    await expect(w.users.create(ADMIN_A, { email: 'm@prueba.test', name: 'Moto', role: 'COMPANY_COURIER', password: 'clave-segura-1' } as any)).resolves.toBeTruthy();
    await expect(w.users.create(ADMIN_B, { email: 'b2@prueba.test', name: 'B2', role: 'COMPANY_VIEWER', password: 'clave-segura-1' } as any)).resolves.toBeTruthy();
    // Las invitaciones pendientes ocupan cupo
    w.db.company[0].limitsJson = JSON.stringify({ maxUsers: 4 });
    await w.account.invite(ADMIN_A, { email: 'cuarta@prueba.test', role: 'COMPANY_VIEWER' });
    await expect(w.account.invite(ADMIN_A, { email: 'quinta@prueba.test', role: 'COMPANY_VIEWER' })).rejects.toThrow(/límite de 4/);
    // Reactivar a alguien también ocupa cupo
    w.db.user.find((x: any) => x.id === 'areaA').active = false;
    await expect(w.users.update(ADMIN_A, 'areaA', { active: true } as any)).resolves.toBeTruthy();
    await expect(w.users.update(ADMIN_A, 'viewerA', { active: false } as any)).resolves.toBeTruthy();
  });

  it('dos altas simultáneas no superan el cupo', async () => {
    const w = world();
    w.db.company[0].limitsJson = JSON.stringify({ maxUsers: 4 });
    const mk = (n: number) => w.users.create(ADMIN_A, { email: `c${n}@prueba.test`, name: `C${n}`, role: 'COMPANY_VIEWER', password: 'clave-segura-1' } as any);
    await Promise.allSettled([mk(1), mk(2)]);
    expect(w.db.user.filter((x: any) => x.companyId === 'coA' && x.active && ['COMPANY_ADMIN', 'COMPANY_VIEWER', 'COMPANY_AREA'].includes(x.role)).length).toBeLessThanOrEqual(4);
  });

  it('asistentes: el plan permite 1; el segundo se rechaza', async () => {
    const w = world();
    const bots = new BotsService(w.prisma as any, w.audit as any);
    await expect(bots.create(ADMIN_A, { name: 'Bot 1', model: 'x' })).resolves.toBeTruthy();
    await expect(bots.create(ADMIN_A, { name: 'Bot 2', model: 'x' })).rejects.toThrow(/límite de 1 asistente/);
    expect(w.db.bot.filter((b: any) => b.companyId === 'coA')).toHaveLength(1);
  });
});

describe('C · Configuración de la empresa', () => {
  it('valida el formato de los datos básicos', () => {
    expect(() => validateCompanyBasics({ contactEmail: 'no-es-correo' })).toThrow(/correo/);
    expect(() => validateCompanyBasics({ brandColor: 'rojo' })).toThrow(/#RRGGBB/);
    expect(() => validateCompanyBasics({ timezone: 'Marte/Olympus' })).toThrow(/zona horaria/);
    expect(() => validateCompanyBasics({ website: 'ftp://x' })).toThrow(/https/);
    expect(() => validateCompanyBasics({ name: 'a' })).toThrow(/nombre/);
    const ok: any = { name: '  Empresa  ', contactEmail: 'Hola@Empresa.co', brandColor: '#1A2B3C', timezone: 'America/Bogota', website: '' };
    validateCompanyBasics(ok);
    expect(ok).toMatchObject({ name: 'Empresa', contactEmail: 'hola@empresa.co' });
  });

  it('una empresa no modifica otra ni sus campos de plataforma', async () => {
    const w = world();
    const companies = new CompaniesService(w.prisma as any, w.audit as any);
    await expect(companies.update(ADMIN_A, 'coB', { name: 'Hackeada' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(companies.update(ADMIN_A, 'coA', { modules: ['productions'] })).rejects.toThrow(/Solo plataforma/);
    await expect(companies.update(ADMIN_A, 'coA', { contactEmail: 'malo' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('«Invitar a tu equipo» solo aparece si el negocio dijo que trabaja con más personas', () => {
    const base = { rubro: 'SERVICIOS', company: { name: 'x', contactPhone: '1' }, products: 0, bots: 1, connectedLines: 0, hasPayments: false, requestedPlan: false, contracted: ['AUTOMATION'] };
    expect(onboardingChecklist(base).items.some((i) => i.key === 'equipo')).toBe(false);
    expect(onboardingChecklist({ ...base, team: { needed: true, done: false } }).items.find((i) => i.key === 'equipo')).toMatchObject({ done: false, link: '/app/team' });
  });
});

describe('E · Auditoría e inventario de datos', () => {
  it('cambiar el rol queda auditado con el detalle, nunca la contraseña', async () => {
    const w = world();
    await w.users.update(ADMIN_A, 'viewerA', { role: 'COMPANY_ADMIN', password: 'clave-nueva-123' } as any);
    const call = (w.audit.log.mock.calls as any[]).map((c) => c[0]).find((c) => c.action === 'user.update');
    expect(call.detail).toMatch(/rol COMPANY_VIEWER → COMPANY_ADMIN/);
    expect(call.detail).toMatch(/contraseña restablecida/);
    expect(call.detail).not.toContain('clave-nueva-123');
  });

  it('todo modelo con companyId del esquema está clasificado para el borrado (una sola vez)', () => {
    const schema = readFileSync(join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const withCompany = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s+companyId\s/m.test(body))
      .map(([, name]) => name[0].toLowerCase() + name.slice(1));
    const all = [...CASCADE_MODELS, ...CLEANED_MODELS, ...ORPHANED_MODELS, ...SET_NULL_MODELS] as string[];
    expect(withCompany.filter((m) => !all.includes(m))).toEqual([]);
    expect(all.length).toBe(new Set(all).size);
  });

  it('el inventario cuenta por destino y advierte sobre facturas y auditoría', async () => {
    const w = world();
    w.db.invoice.push({ id: 'i1', companyId: 'coA' });
    w.db.auditLog.push({ id: 'l1', companyId: 'coA' });
    w.db.adAccount.push({ id: 'ad1', companyId: 'coA' });
    w.db.adAccount.push({ id: 'ad2', companyId: 'coB' });
    const f: any = await companyDataFootprint(w.prisma, 'coA');
    expect(f.deletedByCascade).toMatchObject({ user: 3, invoice: 1, auditLog: 1 });
    expect(f.wouldBeOrphaned).toMatchObject({ adAccount: 1 });
    expect(f.warnings.join(' ')).toMatch(/facturas.*auditoría|auditoría/);
  });
});
