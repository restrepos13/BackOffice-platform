/**
 * Cada negocio ve y recibe lo que le sirve: una constructora no toma pedidos,
 * su asistente no cotiza (ofrece y agenda) y nada expone llaves de los canales.
 */
import { companyProfile, detectProfile, salesPolicy, PROFILES } from '../src/common/business-profile';
import { BotsService } from '../src/modules/bots.module';
import { AutomationsService } from '../src/modules/automations.module';
import { encryptSecret } from '../src/common/crypto';
import { createMockPrisma } from './helpers/mock-prisma';

const ADMIN = { id: 'uA', name: 'A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };

describe('tipo de negocio', () => {
  it('reconoce una constructora y la marca como venta consultiva sin pedidos', () => {
    const p = detectProfile('Somos una constructora: remodelaciones de cocinas y baños, acabados y obra civil', 'Constructora');
    expect(p.key).toBe('CONSTRUCCION');
    expect(p.consultative).toBe(true);
    expect(p.deny).toEqual(expect.arrayContaining(['orders', 'delivery', 'menu']));
    // Desde lo que guardó el registro o el tipo de negocio de la empresa
    expect(companyProfile({ onboardingJson: null, industry: 'Remodelaciones y acabados' }).key).toBe('CONSTRUCCION');
    expect(companyProfile({ onboardingJson: JSON.stringify({ businessType: 'Restaurante', rubro: 'COMIDAS' }) }).key).toBe('COMIDA');
  });

  it('la IA de un negocio consultivo no cotiza: ofrece, entiende y agenda; un restaurante no recibe esa regla', () => {
    const policy = salesPolicy(PROFILES.CONSTRUCCION);
    expect(policy).toMatch(/NUNCA des precios cerrados, cotizaciones/);
    expect(policy).toMatch(/proponer una cita o visita/);
    expect(policy).toMatch(/qué le pareció la atención/);
    expect(salesPolicy(PROFILES.COMIDA)).toBe('');
  });
});

describe('Automatizaciones según el negocio', () => {
  it('una constructora no ve disparadores ni acciones de pedidos aunque tenga la sección', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'Obras', slug: 'a', industry: 'Constructora y remodelaciones', modulesJson: JSON.stringify(['inbox', 'contacts', 'orders', 'agenda']) });
    const svc = new AutomationsService(prisma as any, { log: jest.fn() } as any, {} as any);
    const cat: any = await svc.catalog(ADMIN);
    expect(cat.triggers.some((t: any) => t.record === 'order')).toBe(false);
    expect(cat.actions.some((a: any) => a.needs === 'order')).toBe(false);
    // Un restaurante sí los ve
    db.company[0] = { ...db.company[0], industry: 'Restaurante de almuerzos' };
    const food: any = await svc.catalog(ADMIN);
    expect(food.triggers.some((t: any) => t.record === 'order')).toBe(true);
  });
});

describe('Asistente · canales', () => {
  it('el detalle del asistente lista sus canales sin llaves ni configJson crudo', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'coA', name: 'A', slug: 'a' });
    db.bot.push({ id: 'b1', companyId: 'coA', name: 'Ana', personalityJson: '{}', salesJson: '{}', toolsJson: '[]', createdAt: new Date() });
    db.integration.push({ id: 'i1', companyId: 'coA', botId: 'b1', type: 'WHATSAPP', name: 'Ventas', status: 'CONNECTED', configJson: JSON.stringify({ displayPhone: '+57 300', authTokenEnc: encryptSecret('twilio-secret'), accessTokenEnc: encryptSecret('meta-secret'), refreshTokenEnc: 'x' }) });
    const bot: any = await new BotsService(prisma as any, { log: jest.fn() } as any).detail(ADMIN, 'b1');
    expect(bot.integrations).toEqual([expect.objectContaining({ id: 'i1', config: expect.objectContaining({ displayPhone: '+57 300', twilioConfigured: true, metaConfigured: true }) })]);
    const json = JSON.stringify(bot);
    expect(json).not.toMatch(/configJson|authTokenEnc|accessTokenEnc|refreshTokenEnc/);
  });
});
