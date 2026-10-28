/** Recorridos guiados: cada uno se marca una sola vez por usuario. */
import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { createMockPrisma } from './helpers/mock-prisma';

function world() {
  const { prisma, db } = createMockPrisma();
  db.user.push({ id: 'u1', email: 'a@a.co', name: 'A', role: 'COMPANY_ADMIN', companyId: 'coA', active: true, tourDoneAt: null, toursJson: null });
  const svc = new AuthService(prisma as any, {} as any, { log: jest.fn() } as any);
  return { svc, db };
}

describe('recorridos guiados', () => {
  it('el de Ads queda registrado aparte del de bienvenida y no se reescribe', async () => {
    const { svc, db } = world();
    const r: any = await svc.completeTour('u1', 'ads');
    expect(Object.keys(r.tours)).toEqual(['ads']);
    const first = JSON.parse(db.user[0].toursJson).ads;
    expect(db.user[0].tourDoneAt).toBeNull();
    await svc.completeTour('u1', 'ads');
    expect(JSON.parse(db.user[0].toursJson).ads).toBe(first);
  });

  it('sin nombre marca el de bienvenida; un recorrido desconocido se rechaza', async () => {
    const { svc, db } = world();
    await svc.completeTour('u1');
    expect(db.user[0].tourDoneAt).toBeInstanceOf(Date);
    await expect(svc.completeTour('u1', 'cualquiera')).rejects.toBeInstanceOf(BadRequestException);
    expect(db.user[0].toursJson).toBeNull();
  });
});
