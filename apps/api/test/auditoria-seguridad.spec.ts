/**
 * Auditoría de seguridad (oct-2026): cada corrección tiene su prueba.
 * Dos empresas ficticias (A y B) con varios roles; lo que debe fallar, falla
 * en el backend aunque se manipulen identificadores.
 */
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService, publicUser } from '../src/auth/auth.service';
import { JwtAuthGuard, forgetSession } from '../src/auth/jwt.guard';
import { base32Decode, base32Encode, currentStep, totpAt, verifyTotp } from '../src/common/totp';
import { isSecretSetting, maskSetting } from '../src/modules/devtools.module';
import { isTwilioMediaUrl } from '../src/modules/twilio.module';
import { WebhooksService } from '../src/modules/webhooks.module';
import { PaymentsService } from '../src/modules/payments.module';
import { UsersService } from '../src/modules/users.module';
import { CompaniesService } from '../src/modules/companies.module';
import { ConversationsService } from '../src/modules/conversations.module';
import { DataExportService } from '../src/modules/data-export.module';
import { AgentCallsService } from '../src/modules/agent-calls.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'a'.repeat(64);
process.env.JWT_SECRET = 'secreto-de-pruebas-suficientemente-largo';

const audit = { log: jest.fn(async () => undefined) };
const jwt = new JwtService({ secret: process.env.JWT_SECRET, signOptions: { expiresIn: '1h', algorithm: 'HS256' } });

const A_ADMIN = { id: 'aAdm', email: 'admin@a.co', name: 'Admin A', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };
const A_VIEWER = { id: 'aView', email: 'ver@a.co', name: 'Consulta A', role: 'COMPANY_VIEWER' as const, companyId: 'coA' };
const B_ADMIN = { id: 'bAdm', email: 'admin@b.co', name: 'Admin B', role: 'COMPANY_ADMIN' as const, companyId: 'coB' };
const DEV = { id: 'dev1', email: 'dev@backoffice.dev', name: 'Dev', role: 'DEV' as const, companyId: null };

function world() {
  const { prisma, db } = createMockPrisma();
  db.company.push({ id: 'coA', name: 'Empresa A', slug: 'empresa-a', timezone: 'America/Bogota' }, { id: 'coB', name: 'Empresa B', slug: 'empresa-b', timezone: 'America/Bogota' });
  const hash = bcrypt.hashSync('Clave-Segura-2026', 4);
  for (const u of [A_ADMIN, A_VIEWER, B_ADMIN, DEV]) db.user.push({ ...u, active: true, passwordHash: hash, failedLogins: 0, lockedUntil: null, sessionVersion: 0, mfaEnabled: false });
  db.contact.push({ id: 'ctA', companyId: 'coA', name: 'Cliente de A', phone: '+57300', stage: 'CLIENTE', tagsJson: '[]', createdAt: new Date() });
  db.conversation.push({ id: 'cvA', companyId: 'coA', contactId: 'ctA', channel: 'WHATSAPP', status: 'OPEN', createdAt: new Date(), lastMessageAt: new Date() });
  return { prisma, db };
}

function guardFor(prisma: any) {
  const reflector = { getAllAndOverride: () => false };
  return new JwtAuthGuard(jwt, reflector as any, prisma);
}
function ctxWith(token: string, url = '/api/conversations') {
  const req: any = { headers: { authorization: `Bearer ${token}` }, originalUrl: url };
  return { req, ctx: { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) } as any };
}

describe('TOTP (verificación en dos pasos)', () => {
  it('cumple el vector de la RFC 6238 y no acepta el mismo código dos veces', () => {
    // RFC 6238, SHA1, T = 59 s → 94287082 (los últimos 6 dígitos)
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpAt(secret, 1)).toBe('287082');
    const now = Date.now();
    const code = totpAt(secret, currentStep(now));
    const used = verifyTotp(secret, code, null, now);
    expect(used).toBe(currentStep(now));
    expect(verifyTotp(secret, code, used, now)).toBeNull(); // anti-repetición
    expect(verifyTotp(secret, '000000', null, now)).toBeNull();
    expect(verifyTotp(secret, 'abc', null, now)).toBeNull();
  });
});

describe('Sesiones: revocación real y MFA', () => {
  it('el login con MFA pide el código; el token del paso MFA no sirve como sesión', async () => {
    const { prisma, db } = world();
    const auth = new AuthService(prisma as any, jwt, audit as any);
    const setup = await auth.mfaSetup(DEV.id);
    const enabled: any = await auth.mfaEnable(DEV.id, totpAt(setup.secret, currentStep()));
    expect(enabled.recoveryCodes).toHaveLength(8);
    const step1: any = await auth.login(DEV.email, 'Clave-Segura-2026');
    expect(step1).toMatchObject({ mfaRequired: true });
    expect(step1.token).toBeUndefined();
    // El token intermedio no abre la plataforma
    const { ctx } = ctxWith(step1.mfaToken);
    await expect(guardFor(prisma).canActivate(ctx)).rejects.toThrow(/inválido/);
    // Código equivocado: falla y cuenta como intento
    await expect(auth.verifyMfa(step1.mfaToken, '000000')).rejects.toThrow(/inválido/);
    expect(db.user.find((u: any) => u.id === DEV.id)!.failedLogins).toBe(1);
    // Código de recuperación: sirve una sola vez
    const rc = enabled.recoveryCodes[0];
    const ok: any = await auth.verifyMfa(step1.mfaToken, rc);
    expect(ok.token).toEqual(expect.any(String));
    await expect(auth.verifyMfa(step1.mfaToken, rc)).rejects.toThrow(/inválido/);
    // Los secretos del MFA nunca salen del API
    const me = await auth.me(DEV.id);
    expect(me).not.toHaveProperty('mfaSecretEnc');
    expect(me).not.toHaveProperty('mfaRecoveryJson');
    expect(me).not.toHaveProperty('passwordHash');
  });

  it('cerrar sesión, cambiar contraseña o que un admin te cambie la clave invalida los tokens viejos', async () => {
    const { prisma } = world();
    const auth = new AuthService(prisma as any, jwt, audit as any);
    const users = new UsersService(prisma as any, audit as any);
    const guard = guardFor(prisma);

    let s: any = await auth.login(A_ADMIN.email, 'Clave-Segura-2026');
    const first = ctxWith(s.token);
    await expect(guard.canActivate(first.ctx)).resolves.toBe(true);
    await auth.logout(A_ADMIN.id);
    await expect(guard.canActivate(first.ctx)).rejects.toThrow(/sesión se cerró/);

    s = await auth.login(A_ADMIN.email, 'Clave-Segura-2026');
    const second = ctxWith(s.token);
    const changed: any = await auth.changePassword(A_ADMIN.id, 'Clave-Segura-2026', 'Otra-Clave-2026');
    await expect(guard.canActivate(second.ctx)).rejects.toThrow(/sesión se cerró/);
    await expect(guard.canActivate(ctxWith(changed.token).ctx)).resolves.toBe(true); // la sesión actual sigue

    const view: any = await auth.login(A_VIEWER.email, 'Clave-Segura-2026');
    const viewCtx = ctxWith(view.token);
    await users.update(A_ADMIN, A_VIEWER.id, { password: 'Nueva-Clave-123' });
    forgetSession(A_VIEWER.id);
    await expect(guard.canActivate(viewCtx.ctx)).rejects.toThrow(/sesión se cerró/);
  });

  it('un token firmado sin emisor/audiencia o con otro secreto no entra', async () => {
    const { prisma } = world();
    const guard = guardFor(prisma);
    const sinClaims = await jwt.signAsync({ sub: A_ADMIN.id, sv: 0 });
    await expect(guard.canActivate(ctxWith(sinClaims).ctx)).rejects.toThrow(/inválido/);
    const otroSecreto = await new JwtService({ secret: 'otro-secreto-cualquiera-largo' }).signAsync({ sub: DEV.id, sv: 0 }, { issuer: 'backoffice-api', audience: 'backoffice-web' });
    await expect(guard.canActivate(ctxWith(otroSecreto).ctx)).rejects.toThrow(/inválido/);
  });

  it('con PLATFORM_MFA_REQUIRED, un dev sin MFA solo puede activarlo', async () => {
    const { prisma } = world();
    const auth = new AuthService(prisma as any, jwt, audit as any);
    const s: any = await auth.login(DEV.email, 'Clave-Segura-2026');
    process.env.PLATFORM_MFA_REQUIRED = 'true';
    try {
      await expect(guardFor(prisma).canActivate(ctxWith(s.token, '/api/companies').ctx)).rejects.toThrow(/dos pasos/);
      await expect(guardFor(prisma).canActivate(ctxWith(s.token, '/api/auth/mfa/setup').ctx)).resolves.toBe(true);
    } finally {
      delete process.env.PLATFORM_MFA_REQUIRED;
    }
  });
});

describe('Webhooks y pagos: nada sin firma en producción', () => {
  const prod = (fn: () => Promise<void>) => async () => {
    process.env.RENDER = 'true';
    try { await fn(); } finally { delete process.env.RENDER; }
  };

  it('Meta: sin META_APP_SECRET en producción se rechaza; con secreto, la firma es obligatoria', prod(async () => {
    const { prisma, db } = world();
    const svc = new WebhooksService(prisma as any);
    await expect(svc.assertSignature(Buffer.from('{}'), undefined)).rejects.toThrow(/META_APP_SECRET/);
    db.platformSetting.push({ id: 's', key: 'META_APP_SECRET', value: 'app-secret' });
    await expect(svc.assertSignature(Buffer.from('{}'), 'sha256=00')).rejects.toThrow(/inválida/);
  }));

  it('Wompi: un evento "APROBADO" sin firma no regala créditos ni paga facturas (aunque esté en modo test)', prod(async () => {
    const { prisma, db } = world();
    db.payment.push({ id: 'p1', companyId: 'coA', reference: 'PKG-1', purpose: 'AI_CREDITS', status: 'PENDING', metaJson: '{"conversations":500}' });
    const payments = new PaymentsService(prisma as any, audit as any);
    await expect(payments.handleWompiEvent({ data: { transaction: { reference: 'PKG-1', status: 'APPROVED' } } })).rejects.toThrow(/WOMPI_EVENTS_SECRET/);
    expect(db.payment[0].status).toBe('PENDING');
    db.company[0].paymentConfigJson = JSON.stringify({ env: 'test' });
    await expect(payments.handleCompanyWompiEvent('empresa-a', { data: { transaction: { reference: 'X', status: 'APPROVED' } } })).rejects.toThrow(/events secret/);
  }));

  it('Twilio: las credenciales solo viajan a servidores de Twilio', () => {
    expect(isTwilioMediaUrl('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1')).toBe(true);
    expect(isTwilioMediaUrl('https://atacante.com/robar')).toBe(false);
    expect(isTwilioMediaUrl('https://api.twilio.com.atacante.com/x')).toBe(false);
    expect(isTwilioMediaUrl('http://api.twilio.com/x')).toBe(false);
    expect(isTwilioMediaUrl('https://user:pass@api.twilio.com/x')).toBe(false);
  });
});

describe('Secretos', () => {
  it('Dev Tools nunca devuelve secretos completos', () => {
    for (const k of ['DEEPINFRA_API_KEY', 'SMTP_PASS', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'WOMPI_EVENTS_SECRET', 'WOMPI_INTEGRITY_SECRET', 'MPT_API_KEY', 'GEMINI_API_KEYS']) {
      expect(isSecretSetting(k)).toBe(true);
    }
    for (const k of ['WOMPI_PUBLIC_KEY', 'PUBLIC_WEB_URL', 'SIGNUP_NOTIFY_EMAIL', 'TRM_MARKUP_COP']) expect(isSecretSetting(k)).toBe(false);
    expect(maskSetting('di_123456789abcdef')).toBe('••••cdef');
    expect(maskSetting('corto')).toBe('••••');
    expect(maskSetting('')).toBe('');
  });

  it('el usuario público no lleva hash, secretos de MFA ni contadores', () => {
    const out = publicUser({ id: 'u', name: 'X', passwordHash: 'h', mfaSecretEnc: 's', mfaRecoveryJson: '[]', mfaLastStep: 1, sessionVersion: 3, failedLogins: 2, lockedUntil: null });
    expect(Object.keys(out).sort()).toEqual(['id', 'name']);
  });
});

describe('Aislamiento entre empresas (A y B)', () => {
  it('B no ve ni toca a A manipulando identificadores', async () => {
    const { prisma, db } = world();
    const conv = new ConversationsService(prisma as any, audit as any);
    await expect(conv.insights(B_ADMIN as any, 'cvA')).rejects.toThrow();
    const users = new UsersService(prisma as any, audit as any);
    await expect(users.update(B_ADMIN as any, A_VIEWER.id, { active: false })).rejects.toThrow();
    await expect(users.remove(B_ADMIN as any, A_VIEWER.id)).rejects.toThrow();
    const companies = new CompaniesService(prisma as any, audit as any);
    await expect(companies.update(B_ADMIN as any, 'coA', { name: 'hackeada' })).rejects.toThrow();
    expect(db.company[0].name).toBe('Empresa A');
    // La exportación ignora el companyId que mande una empresa: solo salen sus datos
    const exporter = new DataExportService(prisma as any, audit as any);
    const { buffer } = await exporter.pdf(B_ADMIN as any, { sections: 'contactos', companyId: 'coA' });
    expect(buffer.toString('latin1')).not.toContain('Cliente de A');
    // Citas: B no cancela una cita de A
    const calls = new AgentCallsService(prisma as any, audit as any, { systemSend: jest.fn() } as any);
    db.agentCall.push({ id: 'callA', companyId: 'coA', status: 'REQUESTED', topic: 'SETUP', slotAt: new Date(Date.now() + 864e5), phone: '300', requestedBy: 'A', createdAt: new Date(), updatedAt: new Date() });
    await expect(calls.cancel(B_ADMIN as any, 'callA')).rejects.toThrow(/no encontrada/);
  });

  it('escalada vertical: un admin de empresa no se da plan, precio ni rol de plataforma', async () => {
    const { prisma } = world();
    const companies = new CompaniesService(prisma as any, audit as any);
    for (const field of ['planId', 'status', 'customPriceMonthly', 'aiBillingMode', 'addons', 'limits', 'modules']) {
      await expect(companies.update(A_ADMIN as any, 'coA', { [field]: 'x' })).rejects.toThrow(/Solo plataforma/);
    }
    const users = new UsersService(prisma as any, audit as any);
    await expect(users.update(A_ADMIN as any, A_VIEWER.id, { role: 'DEV' })).rejects.toThrow(/plataforma/);
    await expect(users.create(A_ADMIN as any, { email: 'x@a.co', name: 'X', role: 'SUPER_ADMIN', password: 'clave-muy-larga-1' } as any)).rejects.toThrow(/plataforma/);
    await expect(users.update(A_ADMIN as any, A_ADMIN.id, { role: 'COMPANY_VIEWER' })).rejects.toThrow(/ti mismo/);
  });
});
