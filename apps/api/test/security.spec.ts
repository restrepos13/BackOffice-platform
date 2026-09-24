/**
 * Pruebas Fase 7 — SEGURIDAD.
 * 1) Aislamiento multi-tenant: un admin de la empresa B ataca activamente
 *    recursos de la empresa A en cada servicio del módulo → 403/404 SIEMPRE,
 *    y los listados jamás mezclan tenants.
 * 2) Mínimo privilegio del rol COMPANY_AREA (guard global).
 * 3) Endurecimiento del login: bloqueo por intentos, anti-enumeración,
 *    política de contraseñas.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RolesGuard } from '../src/auth/roles.guard';
import { AuthService } from '../src/auth/auth.service';
import { OrdersService, RemindersService } from '../src/modules/orders.module';
import { CatalogService } from '../src/modules/catalog.module';
import { ConversationsService } from '../src/modules/conversations.module';
import { ReportsService } from '../src/modules/reports.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const VICTIM_ADMIN = {
  id: 'uv', email: 'v@a.co', name: 'Víctima', role: 'COMPANY_ADMIN' as const,
  companyId: 'coA',
};
const ATTACKER = {
  id: 'ua', email: 'atk@b.co', name: 'Atacante', role: 'COMPANY_ADMIN' as const,
  companyId: 'coB',
};
const AREA_USER = {
  id: 'uarea', email: 'area@a.co', name: 'Área', role: 'COMPANY_AREA' as const,
  companyId: 'coA',
};

function setup() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const emails = { systemSend: jest.fn(async () => undefined) };
  const reminders = new RemindersService(prisma as any, audit as any, emails as any);
  const orders = new OrdersService(prisma as any, audit as any, reminders);
  const catalog = new CatalogService(prisma as any, audit as any);
  const conversations = new ConversationsService(prisma as any, audit as any);
  const reports = new ReportsService(prisma as any, audit as any, emails as any);

  for (const [id, slug] of [['coA', 'empresa-a'], ['coB', 'empresa-b']] as const) {
    db.company.push({
      id, name: `Empresa ${id}`, slug, status: 'ACTIVE',
      timezone: 'America/Bogota', modulesJson: JSON.stringify(['orders']),
      orderConfigJson: '{}', waTemplatesJson: '[]',
    });
  }
  db.customer.push({ id: 'custA', companyId: 'coA', name: 'Cliente de A', addressesJson: '[]' });
  db.contact.push({
    id: 'ctA', companyId: 'coA', customerId: 'custA',
    name: 'Contacto A', phone: '+571', channel: 'WHATSAPP', stage: 'CLIENTE',
  });
  db.productionArea.push({
    id: 'areaA', companyId: 'coA', name: 'Cocina A',
    responsiblesJson: '[]', notifyChannel: 'PANEL', reminderHoursBefore: 24, active: true,
  });
  db.product.push({
    id: 'prodA', companyId: 'coA', name: 'Producto A', unit: 'unidad',
    presentationsJson: '[]', active: true, deletedAt: null,
  });
  db.order.push({
    id: 'orderA', companyId: 'coA', customerId: 'custA', contactId: 'ctA',
    status: 'programado', deliveryAt: new Date(Date.now() + 86400e3),
    deliveryAddressJson: '{}', takenByType: 'IA', correctedAfterAi: false,
    createdAt: new Date(), deletedAt: null,
  });
  db.orderItem.push({
    id: 'itemA', companyId: 'coA', orderId: 'orderA', productName: 'Producto A',
    quantity: 5, unit: 'unidad', productionAreaId: 'areaA', areaStatus: 'pendiente',
    createdAt: new Date(),
  });
  db.conversation.push({
    id: 'convA', companyId: 'coA', contactId: 'ctA', channel: 'WHATSAPP',
    status: 'OPEN', botPaused: false, needsAttention: false, unreadCount: 0,
    lastMessageAt: new Date(),
  });
  db.message.push({
    id: 'msgA', conversationId: 'convA', direction: 'IN', author: 'CONTACT',
    content: 'dato confidencial de A', fileName: 'secreto.ogg', type: 'AUDIO',
    createdAt: new Date(),
  });
  db.feedback.push({
    id: 'fbA', companyId: 'coA', orderId: 'orderA', customerId: 'custA', contactId: 'ctA',
    requestedAt: new Date(), status: 'RESPONDIDO', respondedAt: new Date(),
    rating: 5, sentiment: 'POSITIVO', comment: 'top', alerted: false,
  });

  return { prisma, db, orders, catalog, conversations, reports, audit };
}

/* ═══ 1. Ataques multi-tenant por operación ═══ */

describe('aislamiento multi-tenant: TODO ataque cruzado falla', () => {
  it.each([
    ['ver el detalle de un pedido ajeno', (s: any) => s.orders.detail(ATTACKER, 'orderA')],
    ['editar un pedido ajeno', (s: any) => s.orders.edit(ATTACKER, 'orderA', { observations: 'hackeado' })],
    ['marcar listo un ítem ajeno', (s: any) => s.orders.markItemReady(ATTACKER, 'itemA')],
    ['editar un producto ajeno', (s: any) => s.catalog.saveProduct(ATTACKER, { name: 'pwned' }, 'prodA')],
    ['borrar un producto ajeno', (s: any) => s.catalog.removeProduct(ATTACKER, 'prodA')],
    ['editar un área ajena', (s: any) => s.catalog.saveArea(ATTACKER, { name: 'pwned' }, 'areaA')],
    ['editar un cliente ajeno', (s: any) => s.catalog.saveCustomer(ATTACKER, { name: 'pwned' }, 'custA')],
    ['borrar un cliente ajeno', (s: any) => s.catalog.removeCustomer(ATTACKER, 'custA')],
    ['leer una conversación ajena', (s: any) => s.conversations.detail(ATTACKER, 'convA')],
    ['escribir en una conversación ajena', (s: any) => s.conversations.sendMessage(ATTACKER, 'convA', 'inyectado')],
    ['pausar la IA de una conversación ajena', (s: any) => s.conversations.setMode(ATTACKER, 'convA', 'HUMAN')],
    ['cambiar estado de una conversación ajena', (s: any) => s.conversations.updateStatus(ATTACKER, 'convA', { status: 'RESOLVED' })],
  ])('%s → Forbidden/NotFound', async (_name, attack) => {
    const services = setup();
    await expect(attack(services)).rejects.toThrow(
      /Forbidden|no encontrad|No encontrad/i,
    );
    // Nada quedó modificado en el tenant víctima
    expect(services.db.order.find((o: any) => o.id === 'orderA')!.observations).toBeUndefined();
    expect(services.db.product.find((p: any) => p.id === 'prodA')!.name).toBe('Producto A');
    expect(services.db.customer.find((c: any) => c.id === 'custA')!.name).toBe('Cliente de A');
  });

  it('archivo de un mensaje ajeno → Forbidden (jamás el archivo)', async () => {
    const s = setup();
    const res: any = { setHeader: jest.fn(), status: jest.fn(), end: jest.fn() };
    await expect(s.conversations.messageFile(ATTACKER, 'msgA', res)).rejects.toThrow(ForbiddenException);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('los listados escopan en silencio: el atacante ve SOLO lo suyo aunque pida companyId ajeno', async () => {
    const s = setup();
    const [orders, customers, products, convos] = await Promise.all([
      s.orders.list(ATTACKER, { companyId: 'coA' }),
      s.catalog.listCustomers(ATTACKER, 'coA'),
      s.catalog.listProducts(ATTACKER, 'coA'),
      s.conversations.list(ATTACKER, { companyId: 'coA' }),
    ]);
    expect(orders).toHaveLength(0);
    expect(customers).toHaveLength(0);
    expect(products).toHaveLength(0);
    expect(convos).toHaveLength(0);
  });

  it('reportes: el atacante pide companyId ajeno y recibe SUS datos (vacíos), jamás los de A', async () => {
    const s = setup();
    const today = new Intl.DateTimeFormat('en-CA').format(new Date());
    // El controller escopa con resolveCompany: para roles de empresa manda SU companyId
    const dailyB = await s.reports.buildDaily('coB', today);
    expect(dailyB.pedidos.recibidos).toBe(0);
    const feedbackB = await s.reports.feedbackSummary('coB');
    expect(feedbackB.respondidos).toBe(0);
    const historyB = await s.reports.history(ATTACKER, 'coA'); // pide coA…
    expect(historyB).toHaveLength(0); // …y recibe lo de coB (vacío)
  });

  it('la vista por área jamás cruza tenant: área de A pedida por B → NotFound', async () => {
    const s = setup();
    await expect(s.orders.areaView(ATTACKER, 'coA', 'areaA')).rejects.toThrow(
      /no encontrada|Forbidden|Falta/i,
    );
  });

  it('un usuario de ÁREA no entra a la bandeja ni a su detalle (403)', async () => {
    const s = setup();
    await expect(s.conversations.list(AREA_USER, {})).rejects.toThrow(ForbiddenException);
    await expect(s.conversations.detail(AREA_USER, 'convA')).rejects.toThrow(ForbiddenException);
    const res: any = { setHeader: jest.fn() };
    await expect(s.conversations.messageFile(AREA_USER, 'msgA', res)).rejects.toThrow(ForbiddenException);
  });

  it('crear recursos "para" otra empresa: quedan SIEMPRE en la del usuario', async () => {
    const s = setup();
    const customer = await s.catalog.saveCustomer(ATTACKER, {
      name: 'Nuevo', companyId: 'coA', // intenta plantarlo en A
    });
    expect(customer.companyId).toBe('coB');
    const product = await s.catalog.saveProduct(ATTACKER, {
      name: 'Nuevo P', companyId: 'coA',
    });
    expect(product.companyId).toBe('coB');
  });
});

/* ═══ 2. Guard de roles: mínimo privilegio de COMPANY_AREA ═══ */

describe('RolesGuard: COMPANY_AREA con mínimo privilegio', () => {
  function guardCtx(user: any, url: string, required?: string[], isPublic = false) {
    const reflector: any = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(isPublic) // IS_PUBLIC_KEY
        .mockReturnValueOnce(required), // ROLES_KEY
    };
    const guard = new RolesGuard(reflector);
    const ctx: any = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user, url }) }),
    };
    return () => guard.canActivate(ctx);
  }

  it.each([
    ['endpoint sin @Roles (pedidos, catálogo, contactos…)', '/api/orders', undefined],
    ['endpoint con @Roles que NO lo incluye', '/api/reports/daily', ['SUPER_ADMIN', 'COMPANY_ADMIN']],
  ])('área bloqueada en %s', (_n, url, required) => {
    expect(guardCtx(AREA_USER, url as string, required as any)).toThrow(ForbiddenException);
  });

  it.each([
    ['su vista de área', '/api/orders/area-view', ['SUPER_ADMIN', 'DEV', 'COMPANY_ADMIN', 'COMPANY_VIEWER', 'COMPANY_AREA']],
    ['marcar ítem listo', '/api/orders/items/x/ready', ['SUPER_ADMIN', 'DEV', 'COMPANY_ADMIN', 'COMPANY_AREA']],
  ])('área permitida en %s (roles explícitos)', (_n, url, required) => {
    expect(guardCtx(AREA_USER, url, required)()).toBe(true);
  });

  it('área puede usar su propia cuenta (/api/auth/*)', () => {
    expect(guardCtx(AREA_USER, '/api/auth/me', undefined)()).toBe(true);
    expect(guardCtx(AREA_USER, '/api/auth/change-password', undefined)()).toBe(true);
  });

  it('los demás roles no cambian: sin @Roles pasa, con @Roles se exige', () => {
    expect(guardCtx(ATTACKER, '/api/orders', undefined)()).toBe(true);
    expect(guardCtx(ATTACKER, '/api/companies', ['SUPER_ADMIN'])).toThrow(ForbiddenException);
    expect(guardCtx(VICTIM_ADMIN, '/api/orders', ['COMPANY_ADMIN'])()).toBe(true);
  });
});

/* ═══ 3. Login endurecido ═══ */

describe('login: bloqueo por intentos y anti-enumeración', () => {
  function authSetup() {
    const { prisma } = createMockPrisma();
    // mock-prisma no trae colección user: la simulamos mínima
    const users: any[] = [];
    (prisma as any).user = {
      findUnique: async ({ where }: any) =>
        users.find((u) => u.email === where.email || u.id === where.id) ?? null,
      findUniqueOrThrow: async ({ where }: any) => {
        const u = users.find((x) => x.id === where.id);
        if (!u) throw new Error('no user');
        return u;
      },
      update: async ({ where, data }: any) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return u;
      },
    };
    const audit = { log: jest.fn(async () => undefined) };
    const jwt = { signAsync: async () => 'token-de-prueba' };
    const auth = new AuthService(prisma as any, jwt as any, audit as any);
    users.push({
      id: 'u1', email: 'admin@test.co', name: 'Admin', role: 'COMPANY_ADMIN',
      companyId: 'coA', active: true, failedLogins: 0, lockedUntil: null,
      passwordHash: AuthService.hashPassword('Correcta-123'),
      company: null,
    });
    return { auth, users, audit };
  }

  it('login correcto funciona y resetea el contador de fallos', async () => {
    const { auth, users } = authSetup();
    users[0].failedLogins = 3;
    const res = await auth.login('admin@test.co', 'Correcta-123');
    expect(res.token).toBe('token-de-prueba');
    expect(users[0].failedLogins).toBe(0);
    expect(users[0].lockedUntil).toBeNull();
  });

  it('5 intentos fallidos → cuenta bloqueada 15 min con auditoría', async () => {
    const { auth, users, audit } = authSetup();
    for (let i = 0; i < 5; i++) {
      await expect(auth.login('admin@test.co', 'mala')).rejects.toThrow('Credenciales inválidas');
    }
    expect(users[0].lockedUntil).toBeInstanceOf(Date);
    expect(users[0].lockedUntil.getTime()).toBeGreaterThan(Date.now() + 10 * 60e3);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.lockout' }),
    );
  });

  it('cuenta bloqueada: NI SIQUIERA la contraseña correcta entra, mismo mensaje genérico', async () => {
    const { auth, users } = authSetup();
    users[0].lockedUntil = new Date(Date.now() + 10 * 60e3);
    await expect(auth.login('admin@test.co', 'Correcta-123')).rejects.toThrow('Credenciales inválidas');
  });

  it('anti-enumeración: correo inexistente y contraseña mala responden EXACTAMENTE igual', async () => {
    const { auth } = authSetup();
    const err1 = await auth.login('noexiste@test.co', 'x'.repeat(10)).catch((e) => e);
    const err2 = await auth.login('admin@test.co', 'x'.repeat(10)).catch((e) => e);
    expect(err1.message).toBe(err2.message);
    expect(err1.constructor).toBe(err2.constructor);
  });

  it('cuenta desactivada no entra aunque la contraseña sea correcta', async () => {
    const { auth, users } = authSetup();
    users[0].active = false;
    await expect(auth.login('admin@test.co', 'Correcta-123')).rejects.toThrow('Credenciales inválidas');
  });

  it('cambio de contraseña exige mínimo 8 caracteres y la actual correcta', async () => {
    const { auth } = authSetup();
    await expect(auth.changePassword('u1', 'Correcta-123', 'corta')).rejects.toThrow(/8 caracteres/);
    await expect(auth.changePassword('u1', 'equivocada', 'NuevaClave-99')).rejects.toThrow(/no coincide/);
    await expect(auth.changePassword('u1', 'Correcta-123', 'NuevaClave-99')).resolves.toEqual({ ok: true });
  });

  it('el bloqueo expira: pasada la ventana vuelve a permitir el login correcto', async () => {
    const { auth, users } = authSetup();
    users[0].lockedUntil = new Date(Date.now() - 1000); // ya venció
    const res = await auth.login('admin@test.co', 'Correcta-123');
    expect(res.token).toBeDefined();
    expect(users[0].lockedUntil).toBeNull();
  });
});
