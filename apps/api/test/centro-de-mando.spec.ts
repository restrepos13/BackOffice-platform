import { detectProfile, fitToProfile, interviewHint, profileOfCompany } from '../src/common/business-profile';
import { originFromMeta, originFromTwilio, originUpdates } from '../src/common/chat-origin';
import { guidedTurn } from '../src/common/signup-guided';
import { DataExportService } from '../src/modules/data-export.module';
import { createMockPrisma } from './helpers/mock-prisma';

describe('perfil del negocio (sin IA)', () => {
  it('una marca de ropa no recibe cosas de restaurante', () => {
    const p = detectProfile('tengo una marca de ropa pequeña, vendo por Instagram');
    expect(p.key).toBe('ROPA');
    expect(interviewHint(p)).toMatch(/NUNCA.*menú/);
    const proposal: any = { delivery: { enabled: true, baseFee: 5000, perKm: 1000, maxKm: 8, prepMinutes: 30 } };
    const bp = fitToProfile({ modules: ['orders', 'menu', 'delivery', 'production', 'campaigns'] }, proposal, p, 'marca de ropa, envío por transportadora');
    expect(bp.modules).toEqual(['orders', 'campaigns']);
    expect(proposal.delivery).toMatchObject({ kind: 'SHIPPING', perKm: null, prepMinutes: null });
  });

  it('con taller de confección propio sí deja producción; comida sí tiene domicilios', () => {
    const ropa = detectProfile('marca de ropa con taller de confección');
    expect(fitToProfile({ modules: ['orders', 'production'] }, null, ropa, 'tenemos taller de confección').modules).toContain('production');
    const comida = detectProfile('restaurante de almuerzos con domiciliarios');
    expect(fitToProfile({ modules: ['orders', 'menu', 'delivery'] }, null, comida, 'restaurante con domiciliarios').modules).toEqual(['orders', 'menu', 'delivery']);
  });

  it('distingue palabras completas y usa el tipo de negocio de la empresa', () => {
    expect(detectProfile('barbería en Envigado').key).toBe('BELLEZA');
    expect(detectProfile('los clientes solicitan cotización de camisetas').key).toBe('ROPA');
    expect(profileOfCompany({ businessType: 'Tienda de ropa' }, 'VENTAS').roles).toContain('Confección o taller');
    expect(profileOfCompany({}, 'COMIDAS').key).toBe('COMIDA');
  });

  it('el plan B sin IA pregunta tallas a una marca de ropa', () => {
    const envio = guidedTurn('tengo una marca de ropa pequeña', 3);
    expect(envio.pregunta).toMatch(/llegan las prendas/);
    expect(envio.opciones).toContain('Envío por transportadora');
    const t = guidedTurn('tengo una marca de ropa pequeña', 4);
    expect(t.pregunta).toMatch(/preguntan primero/);
    expect(t.opciones).toContain('Tallas y disponibilidad');
  });
});

describe('origen del chat', () => {
  it('lee el anuncio de Twilio y de Meta; sin anuncio es directo', () => {
    expect(originFromTwilio({ ReferralSourceType: 'ad', ReferralSourceUrl: 'https://fb.me/x', ReferralHeadline: 'Colección otoño', ReferralCtwaClid: 'abc' })).toMatchObject({ kind: 'AD', headline: 'Colección otoño' });
    expect(originFromMeta({ referral: { source_type: 'post', source_url: 'https://fb.com/p/1', source_id: '1' } })).toMatchObject({ kind: 'POST' });
    expect(originFromTwilio({ Body: 'hola' })).toBeNull();
    const fresh = originUpdates(null, {}, {}, true);
    expect(JSON.parse(fresh.conversation!.originJson).kind).toBe('DIRECT');
    // El primer origen del contacto no se sobreescribe
    const later = originUpdates(originFromTwilio({ ReferralSourceUrl: 'https://fb.me/y' }), { originJson: '{"kind":"DIRECT"}' }, { originJson: '{"kind":"DIRECT"}' }, false);
    expect(JSON.parse(later.conversation!.originJson).kind).toBe('AD');
    expect(later.contact).toBeNull();
  });
});

describe('descarga de datos', () => {
  it('sale solo en PDF, con las secciones elegidas y deja registro', async () => {
    const { prisma, db } = createMockPrisma();
    db.company.push({ id: 'c1', name: 'Lúa', slug: 'lua', timezone: 'America/Bogota' });
    db.contact.push({ id: 'k1', companyId: 'c1', name: 'Karen', phone: '+57 300', stage: 'CALIENTE', tagsJson: '["vip"]', createdAt: new Date(), originJson: '{"kind":"AD"}' });
    const audit = { log: jest.fn() };
    const svc = new DataExportService(prisma as any, audit as any);
    const { buffer, filename } = await svc.pdf({ id: 'u1', name: 'Karen', role: 'COMPANY_ADMIN', companyId: 'c1' } as any, { sections: 'contactos,hackeo' });
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(filename).toMatch(/^lua-datos-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'data.export_pdf', detail: 'Contactos' }));
    await expect(svc.pdf({ id: 'u1', name: 'K', role: 'COMPANY_ADMIN', companyId: 'c1' } as any, { sections: 'csv' })).rejects.toThrow(/al menos una/);
  });
});
