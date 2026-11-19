import { BadRequestException } from '@nestjs/common';
import { TeamAlertsService, waLink } from '../src/modules/team-alerts';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const BOT_TOKEN = `123456789:${'A'.repeat(35)}`;

/** Telegram falso: registra lo enviado y responde como la API real. */
function telegram(updates: any[] = [{ message: { chat: { id: 555, type: 'private', first_name: 'Santi' }, text: 'hola' } }]) {
  const sent: any[] = [];
  const fetchImpl = async (url: string, init?: any) => {
    const method = url.split('/').pop();
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (method === 'getMe') return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'backoffice_avisos_bot' } }) };
    if (method === 'getUpdates') return { ok: true, status: 200, json: async () => ({ ok: true, result: updates }) };
    if (method === 'sendMessage') { sent.push(body); return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }; }
    return { ok: false, status: 404, json: async () => ({ ok: false, description: 'Not Found' }) };
  };
  return { sent, fetchImpl };
}

async function linkedAlerts() {
  const { prisma, db } = createMockPrisma();
  const svc = new TeamAlertsService(prisma as any);
  const tgFake = telegram();
  svc.fetchImpl = tgFake.fetchImpl as any;
  await svc.saveToken(BOT_TOKEN);
  await svc.link();
  tgFake.sent.length = 0;
  return { svc, sent: tgFake.sent, db };
}

describe('avisos al celular (Telegram)', () => {
  it('guarda el token cifrado, vincula el chat que le escribió al bot y envía con botón de WhatsApp', async () => {
    const { prisma, db } = createMockPrisma();
    const svc = new TeamAlertsService(prisma as any);
    const tgFake = telegram();
    svc.fetchImpl = tgFake.fetchImpl as any;
    await expect(svc.saveToken('no-es-un-token')).rejects.toBeInstanceOf(BadRequestException);
    const s1 = await svc.saveToken(BOT_TOKEN);
    expect(s1).toMatchObject({ configured: true, linked: false, botLink: 'https://t.me/backoffice_avisos_bot' });
    expect(JSON.stringify(db.platformSetting)).not.toContain(BOT_TOKEN.split(':')[1]);
    const s2 = await svc.link();
    expect(s2).toMatchObject({ linked: true, chatName: 'Santi' });
    expect(tgFake.sent[0]).toMatchObject({ chat_id: 555 });
    const ok = await svc.send('SIGNUP_DONE', '<b>Empresa nueva</b>', { text: 'WhatsApp', url: waLink('300 123 4567', 'Hola') });
    expect(ok).toBe(true);
    expect(tgFake.sent[1]).toMatchObject({ chat_id: '555', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ url: 'https://wa.me/573001234567?text=Hola' }]] } });
  });

  it('sin vincular o con el evento apagado no envía; si Telegram falla no lanza', async () => {
    const { prisma } = createMockPrisma();
    const bare = new TeamAlertsService(prisma as any);
    expect(await bare.send('SIGNUP_DONE', 'x')).toBe(false);
    const { svc, sent } = await linkedAlerts();
    await svc.setEvents({ CLIENT_LOGIN: false });
    expect(await svc.send('CLIENT_LOGIN', 'x')).toBe(false);
    expect(sent).toHaveLength(0);
    svc.fetchImpl = async () => { throw new Error('sin red'); };
    expect(await svc.send('SIGNUP_DONE', 'x')).toBe(false);
    expect((await svc.status()).lastSent).toMatchObject({ ok: false, error: 'sin red' });
  });

  it('vincular sin haberle escrito al bot lo explica', async () => {
    const { prisma } = createMockPrisma();
    const svc = new TeamAlertsService(prisma as any);
    svc.fetchImpl = telegram([]).fetchImpl as any;
    await svc.saveToken(BOT_TOKEN);
    await expect(svc.link()).rejects.toThrow(/Todavía no le escribiste al bot/);
  });

  it('ingreso de clientes: solo usuarios de empresas, uno por hora, y no el primer ingreso justo tras registrarse', async () => {
    const { svc, sent } = await linkedAlerts();
    let now = Date.parse('2026-11-19T15:00:00Z');
    svc.now = () => now;
    await svc.clientLogin({ id: 'dev', name: 'Dev', companyId: null }, null);
    await svc.clientLogin({ id: 'nuevo', name: 'Recién', companyId: 'c1', createdAt: new Date(now - 60e3), company: { name: 'Café' } }, null);
    expect(sent).toHaveLength(0);
    await svc.clientLogin({ id: 'u1', name: 'Rosa', companyId: 'c1', company: { name: 'Panadería' } }, new Date(now - 3 * 86400e3));
    await svc.clientLogin({ id: 'u1', name: 'Rosa', companyId: 'c1', company: { name: 'Panadería' } }, new Date(now - 60e3));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('Rosa');
    expect(sent[0].text).toContain('hace 3 días');
    now += 61 * 60e3;
    await svc.clientLogin({ id: 'u1', name: 'Rosa', companyId: 'c1', company: { name: 'Panadería' } }, new Date(now - 61 * 60e3));
    expect(sent).toHaveLength(2);
  });

  it('el enlace de WhatsApp pasa celulares de Colombia a formato internacional', () => {
    expect(waLink('300 123 4567')).toBe('https://wa.me/573001234567');
    expect(waLink('+1 415 555 0101')).toBe('https://wa.me/14155550101');
    expect(waLink('123')).toBeNull();
  });
});
