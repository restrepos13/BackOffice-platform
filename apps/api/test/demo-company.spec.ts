/**
 * Pruebas — empresa DEMO permanente de ventas.
 * La vitrina debe: sembrarse completa, regenerarse idempotente (el cron
 * semanal la mantiene fresca) y estar PROTEGIDA contra borrado desde el panel.
 */
import { DEMO_COMPANY_SLUG, seedDemoCompany } from '../src/demo/demo-company';
import { CompaniesService } from '../src/modules/companies.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const PLATFORM = {
  id: 'sa', email: 's@backoffice.dev', name: 'Santiago', role: 'SUPER_ADMIN' as const,
  companyId: null,
};

describe('empresa demo permanente', () => {
  it('siembra la vitrina completa: todos los módulos con datos', async () => {
    const { prisma, db } = createMockPrisma();
    await seedDemoCompany(prisma as any);

    const demo = db.company.find((c: any) => c.slug === DEMO_COMPANY_SLUG)!;
    expect(demo).toBeDefined();
    expect(demo.status).toBe('ACTIVE'); // jamás en trial que expire
    expect(JSON.parse(demo.modulesJson)).toEqual(
      expect.arrayContaining(['orders', 'marketing']),
    );

    const of = (col: any[]) => col.filter((r: any) => r.companyId === demo.id);
    expect(of(db.user).length).toBe(2); // admin + área
    expect(of(db.user).every((u: any) => !u.tourDoneAt)).toBe(true); // tour sin ver
    expect(of(db.order).length).toBeGreaterThanOrEqual(9);
    expect(of(db.customer).length).toBe(5);
    expect(of(db.product).length).toBe(8);
    expect(of(db.productionArea).length).toBe(4);
    expect(of(db.conversation).length).toBe(4);
    expect(of(db.feedback).length).toBe(3);
    expect(of(db.aiUsageEvent).length).toBeGreaterThan(50); // 30 días de consumo
    expect(of(db.marketingCampaign).length).toBe(1);
    expect(of(db.contentPiece).length).toBe(4);
    expect(of(db.appointment).length).toBe(2);
    expect(of(db.followUp).length).toBe(2);
    expect(of(db.reminder).length).toBeGreaterThanOrEqual(4);
    expect(of(db.dailyReport).length).toBe(1);

    // Cubre TODOS los estados del pedido que se muestran en demo
    const statuses = new Set(of(db.order).map((o: any) => o.status));
    for (const s of ['entregado', 'despachado', 'en_produccion', 'programado', 'requiere_atencion', 'borrador', 'cancelado']) {
      expect(statuses.has(s)).toBe(true);
    }
    // La línea demo SIEMPRE en sandbox (jamás un mensaje real)
    const line = of(db.integration)[0];
    expect(JSON.parse(line.configJson).sandbox).toBe(true);
  });

  it('es idempotente: regenerarla no duplica nada y refresca el tour', async () => {
    const { prisma, db } = createMockPrisma();
    await seedDemoCompany(prisma as any);
    // Simular uso entre demos: tour visto y datos tocados
    const admin = db.user.find((u: any) => u.email === 'demo@deliciasandinas.co')!;
    admin.tourDoneAt = new Date();

    await seedDemoCompany(prisma as any);

    expect(db.company.filter((c: any) => c.slug === DEMO_COMPANY_SLUG)).toHaveLength(1);
    expect(db.user.filter((u: any) => u.email === 'demo@deliciasandinas.co')).toHaveLength(1);
    const fresh = db.user.find((u: any) => u.email === 'demo@deliciasandinas.co')!;
    expect(fresh.tourDoneAt).toBeFalsy(); // recreado: el tour vuelve a salir
  });

  it('está PROTEGIDA: borrarla desde el panel → 400 con instrucciones', async () => {
    const { prisma, db } = createMockPrisma();
    const audit = { log: jest.fn(async () => undefined) };
    const companies = new CompaniesService(prisma as any, audit as any);
    await seedDemoCompany(prisma as any);
    const demo = db.company.find((c: any) => c.slug === DEMO_COMPANY_SLUG)!;

    await expect(companies.remove(PLATFORM as any, demo.id)).rejects.toThrow(/protegida/i);
    expect(db.company.find((c: any) => c.slug === DEMO_COMPANY_SLUG)).toBeDefined();
    // Cualquier otra empresa sí se puede borrar
    db.company.push({ id: 'otra', slug: 'otra', name: 'Otra', modulesJson: '[]' });
    await expect(companies.remove(PLATFORM as any, 'otra')).resolves.toEqual({ ok: true });
  });
});
