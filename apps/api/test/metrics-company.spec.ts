/**
 * Resumen de la empresa: los mensajes de 30 días por línea salen de un conteo
 * agrupado (no de un cruce por relación) y no mezclan líneas ni empresas.
 */
import { MetricsService } from '../src/modules/metrics.module';
import { createMockPrisma } from './helpers/mock-prisma';

const ADMIN = { id: 'uA', name: 'A', email: 'a@a.co', role: 'COMPANY_ADMIN' as const, companyId: 'coA' };

it('cuenta los mensajes de los últimos 30 días de cada línea', async () => {
  const { prisma, db } = createMockPrisma();
  db.company.push({ id: 'coA', name: 'A', slug: 'a' });
  db.integration.push(
    { id: 'l1', companyId: 'coA', type: 'WHATSAPP', name: 'Ventas', status: 'CONNECTED', promptMode: 'INHERIT', configJson: '{"displayPhone":"+57 300"}' },
    { id: 'l2', companyId: 'coA', type: 'WHATSAPP', name: 'Soporte', status: 'CONNECTED', promptMode: 'INHERIT', configJson: '{}' },
  );
  const now = Date.now();
  const conv = (id: string, integrationId: string, companyId = 'coA') => ({ id, companyId, integrationId, contactId: 'k', channel: 'WHATSAPP', status: 'OPEN', needsAttention: false, lastMessageAt: new Date(), createdAt: new Date() });
  db.conversation.push(conv('c1', 'l1'), conv('c2', 'l1'), conv('c3', 'l2'), conv('cB', 'l1', 'coB'));
  const msg = (id: string, conversationId: string, daysAgo: number) => ({ id, conversationId, direction: 'IN', author: 'CONTACT', content: 'x', type: 'TEXT', createdAt: new Date(now - daysAgo * 86400e3) });
  db.message.push(msg('m1', 'c1', 1), msg('m2', 'c1', 2), msg('m3', 'c2', 5), msg('m4', 'c2', 45), msg('m5', 'c3', 3), msg('m6', 'cB', 1));
  const r: any = await new MetricsService(prisma as any).company(ADMIN);
  const by = Object.fromEntries(r.lines.map((l: any) => [l.id, l.messages30d]));
  expect(by).toEqual({ l1: 3, l2: 1 });
  expect(r.lines[0]).toMatchObject({ id: 'l1', conversations: 2, displayPhone: '+57 300' });
});
