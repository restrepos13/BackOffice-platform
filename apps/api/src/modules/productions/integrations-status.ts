import { PrismaService } from '../../prisma/prisma.service';
import { parseJson } from '../../common/constants';
import { isEncrypted } from '../../common/crypto';

/**
 * Estado de las integraciones con EVIDENCIA, sin llamar a servicios externos:
 *  - NOT_IMPLEMENTED: no hay código (Dropbox, formularios de Lead Ads).
 *  - NOT_CONFIGURED: hay código pero faltan credenciales o conexión.
 *  - CONFIGURED_UNVERIFIED: hay credenciales guardadas; nadie comprobó que funcione.
 *  - RECEIVING: se han recibido datos reales (mensajes, sincronizaciones) — con fecha.
 * Nunca se marca «conectada» solo porque exista un formulario o un botón.
 */

export type Readiness = 'NOT_IMPLEMENTED' | 'NOT_CONFIGURED' | 'CONFIGURED_UNVERIFIED' | 'RECEIVING' | 'ERROR';

export interface IntegrationReport {
  key: string;
  name: string;
  priority: number;
  readiness: Readiness;
  evidence: string[];
  missing: string[];
  safety: string;
  detail?: unknown;
}

async function setting(prisma: PrismaService, key: string): Promise<boolean> {
  const row = await prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
  return !!(row?.value || process.env[key]);
}

export async function integrationsReport(prisma: PrismaService, companyId: string): Promise<IntegrationReport[]> {
  const company: any = await prisma.company.findUnique({ where: { id: companyId }, select: { slug: true } });
  const lines: any[] = await prisma.integration.findMany({ where: { companyId } });
  const since = new Date(Date.now() - 30 * 86400e3);
  const lastInbound = async (channel: string) => {
    const conv: any[] = await prisma.conversation.findMany({ where: { companyId, channel }, select: { id: true }, take: 2000 });
    if (!conv.length) return null;
    const m: any = await prisma.message.findFirst({ where: { conversationId: { in: conv.map((c) => c.id) }, direction: 'IN', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' } });
    return m?.createdAt ?? null;
  };
  const metaSecret = await setting(prisma, 'META_APP_SECRET');
  const verifyToken = await setting(prisma, 'META_VERIFY_TOKEN');

  // WhatsApp
  const wa = lines.filter((l) => l.type === 'WHATSAPP').map((l) => {
    const cfg = parseJson<Record<string, any>>(l.configJson, {});
    const provider = cfg.provider === 'META' ? 'META_CLOUD_API' : cfg.accountSid || cfg.provider === 'TWILIO' ? 'TWILIO' : 'SIN_DEFINIR';
    const hasCreds = provider === 'META_CLOUD_API' ? isEncrypted(cfg.accessTokenEnc) && !!cfg.phoneNumberId : provider === 'TWILIO' ? !!cfg.accountSid && isEncrypted(cfg.authTokenEnc) : false;
    return { id: l.id, name: l.name, provider, hasCredentials: hasCreds, sandbox: cfg.sandbox === true, number: cfg.displayPhone ?? cfg.fromNumber ?? null };
  });
  const waIn = await lastInbound('WHATSAPP');
  const waReady: Readiness = waIn ? 'RECEIVING' : wa.some((x) => x.hasCredentials) ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED';

  // Instagram y Messenger
  const meta = lines.filter((l) => ['INSTAGRAM', 'MESSENGER'].includes(l.type)).map((l) => {
    const cfg = parseJson<Record<string, any>>(l.configJson, {});
    return { id: l.id, type: l.type, name: l.name, hasToken: isEncrypted(cfg.accessTokenEnc), sandbox: cfg.sandbox === true };
  });
  const igIn = await lastInbound('INSTAGRAM');
  const fbIn = await lastInbound('MESSENGER');

  // Meta Ads
  const accounts: any[] = await prisma.adAccount.findMany({ where: { companyId } });
  const realAccounts = accounts.filter((a) => a.mode !== 'DEMO');
  const synced = realAccounts.filter((a) => a.lastSyncAt);
  const adsReady: Readiness = realAccounts.some((a) => a.status === 'EXPIRED' || a.lastError) ? 'ERROR' : synced.length ? 'RECEIVING' : realAccounts.length ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED';

  // Google Calendar
  const gcalApp = (await setting(prisma, 'GOOGLE_CLIENT_ID')) && (await setting(prisma, 'GOOGLE_CLIENT_SECRET'));
  const gcal: any = await prisma.calendarConnection.findFirst({ where: { companyId } }).catch(() => null);
  const gcalReady: Readiness = gcal?.status === 'CONNECTED' && gcal.lastSyncStatus === 'OK' ? 'RECEIVING' : gcal?.status === 'REVOKED' || gcal?.status === 'ERROR' ? 'ERROR' : gcal ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED';

  return [
    {
      key: 'whatsapp', name: 'WhatsApp', priority: 1, readiness: waReady,
      evidence: [
        `${wa.length} línea(s) de WhatsApp registradas`,
        ...wa.map((x) => `${x.name}: ${x.provider}${x.hasCredentials ? ', con credenciales cifradas' : ', sin credenciales'}${x.sandbox ? ' (modo prueba)' : ''}`),
        waIn ? `Último mensaje entrante real: ${new Date(waIn).toISOString()}` : 'Sin mensajes entrantes en los últimos 30 días',
        `Firma de webhooks de Meta (META_APP_SECRET): ${metaSecret ? 'configurada' : 'no configurada'}`,
      ],
      missing: [
        ...(wa.length ? [] : ['Registrar la línea de LPulpo (número, proveedor: Cloud API de Meta o Twilio)']),
        ...(metaSecret ? [] : ['META_APP_SECRET para validar la firma de los webhooks']),
        ...(verifyToken ? [] : ['META_VERIFY_TOKEN para suscribir el webhook']),
        'Plantillas aprobadas para escribir fuera de la ventana de 24 h (hoy solo salen por Twilio)',
        'Tarifas de Meta para Colombia: pendientes de verificar (desde el 1-oct-2026 Meta cobra mensajes de servicio tras 1.000 gratis por número al mes)',
      ],
      safety: 'En el piloto no se envía nada: las cotizaciones y consultas se registran como hechas por fuera del sistema.',
      detail: { lines: wa, webhook: company?.slug ? { meta: `/api/webhooks/${company.slug}/whatsapp` } : null },
    },
    {
      key: 'meta_ads', name: 'Meta Ads (solo lectura)', priority: 2, readiness: adsReady,
      evidence: [
        `${realAccounts.length} cuenta(s) reales y ${accounts.length - realAccounts.length} de demostración`,
        ...realAccounts.map((a) => `${a.name}: ${a.status}${a.lastSyncAt ? `, última sincronización ${new Date(a.lastSyncAt).toISOString()}` : ', nunca sincronizada'}${a.lastError ? ` · error: ${String(a.lastError).slice(0, 120)}` : ''}`),
        'Se leen: cuentas, campañas, conjuntos, anuncios, gasto, impresiones, alcance, clics, leads, conversaciones y compras (adaptador real de la Graph API)',
        'No existe: envío de conversiones ni lectura de formularios de Lead Ads',
      ],
      missing: realAccounts.length ? ['Comparar las cifras con el Administrador de anuncios para los mismos días'] : ['Token con permiso ads_read de una persona administradora de la cuenta de LPulpo, o revisión de la app para OAuth'],
      safety: 'Los datos de demostración están marcados y nunca se mezclan con los reales. Para el piloto: no pausar, crear ni cambiar presupuestos.',
    },
    {
      key: 'google_calendar', name: 'Google Calendar', priority: 3, readiness: gcalApp ? gcalReady : 'NOT_CONFIGURED',
      evidence: [
        `Cliente OAuth de la plataforma: ${gcalApp ? 'configurado' : 'no configurado'}`,
        gcal ? `Conexión de la empresa: ${gcal.status}${gcal.lastSyncAt ? `, última sincronización ${new Date(gcal.lastSyncAt).toISOString()}` : ''}` : 'La empresa no ha conectado su calendario',
        'Código probado contra un Google simulado; no se ha probado con una cuenta real',
      ],
      missing: [...(gcalApp ? [] : ['GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (ver docs/google-calendar.md)']), 'Elegir qué calendario representa la locación propia', 'Prueba de punta a punta con la cuenta de LPulpo'],
      safety: 'Las reservas de Producciones son internas; la sincronización con Google no confirma ni cancela producciones.',
    },
    {
      key: 'instagram', name: 'Instagram (mensajes)', priority: 4,
      readiness: igIn ? 'RECEIVING' : meta.some((m) => m.type === 'INSTAGRAM' && m.hasToken) ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
      evidence: [igIn ? `Último mensaje entrante real: ${new Date(igIn).toISOString()}` : 'Sin mensajes entrantes', `${meta.filter((m) => m.type === 'INSTAGRAM').length} cuenta(s) registradas`],
      missing: ['Permisos de mensajería de la app de Meta (revisión de la app) y token de la página', 'Prueba en vivo con la cuenta de LPulpo'],
      safety: 'Mientras tanto, las solicitudes de Instagram se registran a mano con canal «Instagram».',
    },
    {
      key: 'facebook', name: 'Facebook Messenger', priority: 4,
      readiness: fbIn ? 'RECEIVING' : meta.some((m) => m.type === 'MESSENGER' && m.hasToken) ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
      evidence: [fbIn ? `Último mensaje entrante real: ${new Date(fbIn).toISOString()}` : 'Sin mensajes entrantes', `${meta.filter((m) => m.type === 'MESSENGER').length} página(s) registradas`],
      missing: ['Permiso pages_messaging (revisión de la app) y token de la página'],
      safety: 'Registro manual con canal «Facebook» mientras tanto.',
    },
    {
      key: 'lead_ads', name: 'Formularios de Lead Ads', priority: 5, readiness: 'NOT_IMPLEMENTED',
      evidence: ['No hay suscripción a leadgen ni lectura de formularios en el código'],
      missing: ['Confirmar si LPulpo usa formularios instantáneos', 'Permiso leads_retrieval y webhook leadgen'],
      safety: 'Solo se construye si LPulpo los usa.',
    },
    {
      key: 'dropbox', name: 'Dropbox', priority: 3, readiness: 'NOT_IMPLEMENTED',
      evidence: ['No hay integración con Dropbox en el código', 'Las fichas de recursos aceptan referencias manuales (ruta de Dropbox o enlace https) marcadas como no verificadas'],
      missing: [
        'App de Dropbox con permisos de solo lectura (files.metadata.read; files.content.read solo si se muestran miniaturas)',
        'Saber si es cuenta personal o de equipo y qué carpetas entran al inventario',
        'Criterios de organización y derechos de uso de las fotos',
      ],
      safety: 'Diseño: inventario de solo lectura con cursor, sin mover, renombrar ni borrar; los vínculos con modelos pasan por revisión humana.',
    },
  ];
}

/** Validación estática de WhatsApp (no envía nada ni llama a Meta). */
export async function validateWhatsapp(prisma: PrismaService, companyId: string) {
  const report = (await integrationsReport(prisma, companyId)).find((r) => r.key === 'whatsapp')!;
  const lines = ((report.detail as any)?.lines ?? []) as Array<{ name: string; provider: string; hasCredentials: boolean; sandbox: boolean }>;
  const checks = [
    { check: 'Hay al menos una línea registrada', ok: lines.length > 0 },
    { check: 'La línea tiene proveedor definido', ok: lines.some((l) => l.provider !== 'SIN_DEFINIR') },
    { check: 'Las credenciales están guardadas y cifradas', ok: lines.some((l) => l.hasCredentials) },
    { check: 'La firma de los webhooks se puede validar (META_APP_SECRET)', ok: report.evidence.some((e) => e.includes('META_APP_SECRET): configurada')) },
    { check: 'Se han recibido mensajes reales', ok: report.readiness === 'RECEIVING' },
  ];
  return { readiness: report.readiness, checks, note: 'Validación sin contacto con Meta ni Twilio: confirma la configuración guardada, no que el número esté operando.' };
}
