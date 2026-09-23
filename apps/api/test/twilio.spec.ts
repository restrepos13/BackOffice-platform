/**
 * Pruebas Fase 3 — Twilio: cifrado de credenciales, ventana de 24 h,
 * idempotencia del webhook entrante, sandbox del envío y estados de entrega.
 */
import { decryptSecret, encryptSecret, isEncrypted } from '../src/common/crypto';
import {
  TwilioService,
  isWithinServiceWindow,
  mapMediaType,
} from '../src/modules/twilio.module';
import { createMockPrisma } from './helpers/mock-prisma';

process.env.MASTER_ENCRYPTION_KEY =
  process.env.MASTER_ENCRYPTION_KEY || 'clave-de-prueba-para-tests-0123456789abcdef';

const fakeQueue = () => ({ add: jest.fn(async () => undefined), getJob: async () => null });

function setup() {
  const { prisma, db } = createMockPrisma();
  const audit = { log: jest.fn(async () => undefined) };
  const service = new TwilioService(
    prisma as any,
    audit as any,
    fakeQueue() as any,
    fakeQueue() as any,
    fakeQueue() as any,
  );

  db.company.push({
    id: 'co1', name: 'Catering Test', slug: 'catering-test',
    orderConfigJson: JSON.stringify({ groupingSeconds: 5 }),
  });
  db.integration.push({
    id: 'line1', companyId: 'co1', botId: 'bot1', type: 'WHATSAPP',
    configJson: JSON.stringify({
      provider: 'TWILIO',
      accountSid: 'ACtest',
      authTokenEnc: encryptSecret('token-secreto'),
      fromNumber: '+573000000000',
      sandbox: true,
    }),
  });
  return { service, db, audit };
}

describe('Cifrado de secretos (AES-256-GCM)', () => {
  test('ida y vuelta, formato reconocible, nunca en claro', () => {
    const encrypted = encryptSecret('mi-auth-token-twilio');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
    expect(encrypted).not.toContain('mi-auth-token-twilio');
    expect(isEncrypted(encrypted)).toBe(true);
    expect(decryptSecret(encrypted)).toBe('mi-auth-token-twilio');
  });
  test('cada cifrado usa IV distinto', () => {
    expect(encryptSecret('x')).not.toBe(encryptSecret('x'));
  });
});

describe('Ventana de servicio de 24 h', () => {
  test('dentro de la ventana → mensaje libre permitido', () => {
    expect(isWithinServiceWindow(new Date(Date.now() - 2 * 3600e3))).toBe(true);
  });
  test('fuera de la ventana o sin entrante → requiere plantilla', () => {
    expect(isWithinServiceWindow(new Date(Date.now() - 25 * 3600e3))).toBe(false);
    expect(isWithinServiceWindow(null)).toBe(false);
  });
});

describe('mapMediaType', () => {
  test('mapea audio/imagen/documento', () => {
    expect(mapMediaType('audio/ogg').type).toBe('AUDIO');
    expect(mapMediaType('image/jpeg').type).toBe('IMAGE');
    expect(mapMediaType('application/pdf')).toEqual({ type: 'DOCUMENT', ext: 'pdf' });
  });
});

describe('Webhook entrante (processInbound)', () => {
  const payload = {
    MessageSid: 'SM123', From: 'whatsapp:+573105550101',
    ProfileName: 'Marta', Body: 'Hola, quiero hacer un pedido', NumMedia: '0',
  };

  test('crea contacto, conversación y mensaje con providerId', async () => {
    const { service, db } = setup();
    const result = await service.processInbound({ companyId: 'co1', lineId: 'line1', payload });
    expect(result.messageId).toBeDefined();
    expect(db.contact).toHaveLength(1);
    expect(db.contact[0].phone).toBe('+573105550101');
    expect(db.conversation).toHaveLength(1);
    expect(db.conversation[0].integrationId).toBe('line1');
    expect(db.message[0].providerId).toBe('SM123');
    expect(db.message[0].direction).toBe('IN');
  });

  test('IDEMPOTENCIA: el mismo MessageSid dos veces NO duplica nada', async () => {
    const { service, db } = setup();
    await service.processInbound({ companyId: 'co1', lineId: 'line1', payload });
    const second = await service.processInbound({ companyId: 'co1', lineId: 'line1', payload });
    expect(second.skipped).toBe('duplicado');
    expect(db.message).toHaveLength(1);
    expect(db.contact).toHaveLength(1);
    expect(db.conversation).toHaveLength(1);
  });

  test('mensajes consecutivos reutilizan la conversación abierta', async () => {
    const { service, db } = setup();
    await service.processInbound({ companyId: 'co1', lineId: 'line1', payload });
    await service.processInbound({
      companyId: 'co1', lineId: 'line1',
      payload: { ...payload, MessageSid: 'SM124', Body: 'para el jueves' },
    });
    expect(db.conversation).toHaveLength(1);
    expect(db.message).toHaveLength(2);
    expect(db.conversation[0].unreadCount).toBe(2);
  });
});

describe('Envío saliente (processOutbound)', () => {
  function withConversation(db: any, lastInboundHoursAgo: number | null) {
    db.contact.push({ id: 'ct1', companyId: 'co1', phone: '+573105550101', name: 'Marta' });
    db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', integrationId: 'line1',
      channel: 'WHATSAPP', status: 'OPEN', botPaused: false, needsAttention: false,
    });
    if (lastInboundHoursAgo !== null) {
      db.message.push({
        id: 'in1', conversationId: 'cv1', direction: 'IN', author: 'CONTACT',
        content: 'hola', type: 'TEXT',
        createdAt: new Date(Date.now() - lastInboundHoursAgo * 3600e3),
      });
    }
    db.message.push({
      id: 'out1', conversationId: 'cv1', direction: 'OUT', author: 'BOT',
      content: 'Claro, te confirmo el pedido.', type: 'TEXT',
      deliveryStatus: 'QUEUED', createdAt: new Date(),
    });
  }

  test('sandbox: dentro de la ventana envía (simulado) como SERVICIO sin costo', async () => {
    const { service, db } = setup();
    withConversation(db, 2);
    const result = await service.processOutbound({ messageId: 'out1' });
    expect(String(result.sid)).toContain('SANDBOX');
    const message = db.message.find((m: any) => m.id === 'out1')!;
    expect(message.deliveryStatus).toBe('SENT');
    expect(message.metaCategory).toBe('SERVICIO');
    expect(message.metaCostUsd).toBe(0);
  });

  test('fuera de la ventana SIN plantilla → falla con alerta, no se envía', async () => {
    const { service, db, audit } = setup();
    withConversation(db, 30); // último entrante hace 30 h
    const result = await service.processOutbound({ messageId: 'out1' });
    expect(result.failed).toBe('fuera de ventana');
    const message = db.message.find((m: any) => m.id === 'out1')!;
    expect(message.deliveryStatus).toBe('FAILED');
    expect(db.conversation[0].needsAttention).toBe(true); // alerta en el panel
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'twilio.send_failed' }),
    );
  });

  test('fuera de la ventana CON plantilla → sale como UTILIDAD con costo', async () => {
    const { service, db } = setup();
    withConversation(db, 30);
    const result = await service.processOutbound({
      messageId: 'out1', contentSid: 'HX_template', metaCategory: 'UTILIDAD',
    });
    expect(result.category).toBe('UTILIDAD');
    const message = db.message.find((m: any) => m.id === 'out1')!;
    expect(message.deliveryStatus).toBe('SENT');
    expect(message.metaCostUsd).toBeCloseTo(0.008);
  });

  test('idempotencia del worker: un mensaje ya enviado no se reenvía', async () => {
    const { service, db } = setup();
    withConversation(db, 2);
    await service.processOutbound({ messageId: 'out1' });
    const again = await service.processOutbound({ messageId: 'out1' });
    expect(again.skipped).toBe('ya enviado');
  });
});

describe('Estados de entrega (status callback)', () => {
  test('actualiza el estado y no lo degrada por callbacks fuera de orden', async () => {
    const { service, db } = setup();
    db.contact.push({ id: 'ct1', companyId: 'co1', phone: '+573105550101' });
    db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', integrationId: 'line1',
      channel: 'WHATSAPP', status: 'OPEN', needsAttention: false,
    });
    db.message.push({
      id: 'out1', conversationId: 'cv1', direction: 'OUT', author: 'BOT',
      content: 'x', providerId: 'SMabc', deliveryStatus: 'SENT', createdAt: new Date(),
    });
    await service.processStatus('co1', { MessageSid: 'SMabc', MessageStatus: 'read' });
    expect(db.message[0].deliveryStatus).toBe('READ');
    // llega "delivered" tarde: no degrada READ
    await service.processStatus('co1', { MessageSid: 'SMabc', MessageStatus: 'delivered' });
    expect(db.message[0].deliveryStatus).toBe('READ');
  });

  test('failed marca el mensaje y levanta alerta', async () => {
    const { service, db, audit } = setup();
    db.contact.push({ id: 'ct1', companyId: 'co1', phone: '+573105550101' });
    db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', integrationId: 'line1',
      channel: 'WHATSAPP', status: 'OPEN', needsAttention: false,
    });
    db.message.push({
      id: 'out1', conversationId: 'cv1', direction: 'OUT', author: 'BOT',
      content: 'x', providerId: 'SMabc', deliveryStatus: 'SENT', createdAt: new Date(),
    });
    await service.processStatus('co1', {
      MessageSid: 'SMabc', MessageStatus: 'undelivered', ErrorCode: '63016',
    });
    expect(db.message[0].deliveryStatus).toBe('FAILED');
    expect(db.conversation[0].needsAttention).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'twilio.send_failed' }),
    );
  });

  test('un MessageSid de otra organización se ignora (aislamiento)', async () => {
    const { service, db } = setup();
    db.contact.push({ id: 'ct1', companyId: 'co1', phone: '+57' });
    db.conversation.push({
      id: 'cv1', companyId: 'co1', contactId: 'ct1', channel: 'WHATSAPP', status: 'OPEN',
    });
    db.message.push({
      id: 'out1', conversationId: 'cv1', direction: 'OUT', author: 'BOT',
      content: 'x', providerId: 'SMabc', deliveryStatus: 'SENT', createdAt: new Date(),
    });
    const result = await service.processStatus('OTRA_ORG', {
      MessageSid: 'SMabc', MessageStatus: 'delivered',
    });
    expect(result.skipped).toBe('mensaje desconocido');
    expect(db.message[0].deliveryStatus).toBe('SENT');
  });
});
