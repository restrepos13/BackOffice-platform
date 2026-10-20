import { AgentCallsService, candidateSlots, slotLabel } from '../src/modules/agent-calls.module';
import { createMockPrisma } from './helpers/mock-prisma';

const audit = { log: jest.fn() };
const ADMIN: any = { id: 'u1', name: 'Karen', role: 'COMPANY_ADMIN', companyId: 'c1' };
const DEV: any = { id: 'd1', name: 'Santiago', role: 'DEV', companyId: null };
// Lunes 19-oct-2026, 9:00 a. m. en Bogotá
const MONDAY_9AM = new Date('2026-10-19T14:00:00Z');

function setup() {
  const { prisma, db } = createMockPrisma();
  db.company.push({ id: 'c1', name: 'Lúa' });
  const emails = { systemSend: jest.fn().mockResolvedValue({}) };
  const svc = new AgentCallsService(prisma as any, audit as any, emails as any);
  return { svc, db, emails };
}

describe('citas con un agente', () => {
  it('ofrece turnos en horario de agentes, con 2 horas de anticipación y sin domingos', () => {
    const slots = candidateSlots(MONDAY_9AM);
    expect(slots[0].toISOString()).toBe('2026-10-19T16:00:00.000Z'); // 11:00 a. m. Bogotá
    expect(slots.every((s) => new Date(s.getTime() - 5 * 3600e3).getUTCDay() !== 0)).toBe(true);
    const saturday = slots.filter((s) => new Date(s.getTime() - 5 * 3600e3).getUTCDay() === 6);
    expect(saturday).toHaveLength(6); // 9:00 a 11:30
    expect(slotLabel(slots[0], MONDAY_9AM)).toBe('hoy a las 11:00 a. m.');
  });

  it('agenda con dos toques, avisa al equipo y el turno se llena con 2 citas', async () => {
    const { svc, db, emails } = setup();
    const { days } = await svc.slots(MONDAY_9AM);
    const at = days[0].slots[0].at;
    const call = await svc.book(ADMIN, { slotAt: at, topic: 'AI', phone: '310 200 3001' }, undefined, MONDAY_9AM);
    expect(call).toMatchObject({ topicLabel: 'Conectar la inteligencia artificial', status: 'REQUESTED', when: 'hoy a las 11:00 a. m.' });
    expect(emails.systemSend).toHaveBeenCalledWith(expect.objectContaining({ subject: expect.stringContaining('Lúa') }));
    expect(emails.systemSend.mock.calls[0][0].body).toContain('wa.me/573102003001');
    db.company.push({ id: 'c2', name: 'Otra' });
    await svc.book({ ...ADMIN, companyId: 'c2' }, { slotAt: at, phone: '3001112233' }, undefined, MONDAY_9AM);
    const after = await svc.slots(MONDAY_9AM);
    expect(after.days[0].slots[0].at).not.toBe(at);
    await expect(svc.book(ADMIN, { slotAt: at, phone: '3001112233' }, undefined, MONDAY_9AM)).rejects.toThrow(/ya no está disponible/);
  });

  it('valida teléfono y hora; el cliente cancela y el equipo la marca hecha', async () => {
    const { svc } = setup();
    const { days } = await svc.slots(MONDAY_9AM);
    await expect(svc.book(ADMIN, { slotAt: days[0].slots[1].at, phone: '12' }, undefined, MONDAY_9AM)).rejects.toThrow(/número/);
    await expect(svc.book(ADMIN, { slotAt: '2026-10-25T15:00:00.000Z', phone: '3001112233' }, undefined, MONDAY_9AM)).rejects.toThrow(/no está disponible/); // domingo
    const call = await svc.book(ADMIN, { slotAt: days[1].slots[0].at, phone: '3001112233' }, undefined, MONDAY_9AM);
    const done = await svc.update(DEV, call.id, { status: 'DONE', agentName: 'Daniel', doneNotes: 'IA conectada' });
    expect(done).toMatchObject({ status: 'DONE', statusLabel: 'Hecha', agentName: 'Daniel' });
    await expect(svc.cancel(ADMIN, call.id)).rejects.toThrow(/ya no se puede/);
    await expect(svc.cancel({ ...ADMIN, companyId: 'otra' }, call.id)).rejects.toThrow(/no encontrada/);
  });
});
