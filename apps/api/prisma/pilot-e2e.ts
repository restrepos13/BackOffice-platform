/**
 * Recorrido de punta a punta del flujo mínimo de producciones contra la API
 * REAL del piloto y su base REAL (aislada), con dos empresas de prueba que se
 * crean y se borran en la misma corrida. No toca la empresa LPulpo ni envía
 * nada fuera (no hay credenciales externas en este entorno).
 *
 *   node scripts/pilot-env.cjs npx ts-node --transpile-only prisma/pilot-e2e.ts
 *
 * Requiere la API del piloto corriendo (PORT de .env.pilot). Nunca imprime contraseñas ni tokens.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { deleteCompanyLooseData } from '../src/common/company-cleanup';

const API = `http://localhost:${process.env.PORT || 4011}/api`;
const prisma = new PrismaClient();
const PREFIX = 'e2e-piloto-';
let passed = 0;

function ok(step: string, cond: unknown, detail = '') {
  if (!cond) throw new Error(`FALLÓ: ${step}${detail ? ` (${detail})` : ''}`);
  passed++;
  console.log(`  ✔ ${step}`);
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

async function login(email: string, password: string) {
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j: any = await res.json();
  if (!j?.token) throw new Error(`No se pudo iniciar sesión como ${email} (${res.status})`);
  return j.token as string;
}

async function cleanup() {
  const companies = await prisma.company.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
  for (const c of companies) {
    await deleteCompanyLooseData(prisma, c.id);
    await prisma.auditLog.deleteMany({ where: { companyId: c.id } });
    await prisma.user.deleteMany({ where: { companyId: c.id } });
    await prisma.company.delete({ where: { id: c.id } });
  }
  return companies.length;
}

async function main() {
  const url = new URL(String(process.env.DATABASE_URL));
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !/pilot/i.test(url.pathname)) throw new Error('Solo corre contra la base local del piloto');
  await cleanup();
  const products = JSON.stringify({ AUTOMATION: { enabled: true }, ADS: { enabled: false }, CREATIVE: { enabled: false } });
  const modules = JSON.stringify(['inbox', 'contacts', 'team', 'productions']);
  const A = await prisma.company.create({ data: { name: 'E2E Agencia A (prueba)', slug: `${PREFIX}a`, status: 'ACTIVE', productsJson: products, modulesJson: modules } });
  const B = await prisma.company.create({ data: { name: 'E2E Agencia B (prueba)', slug: `${PREFIX}b`, status: 'ACTIVE', productsJson: products, modulesJson: modules } });
  const pw = randomBytes(16).toString('base64url');
  const hash = bcrypt.hashSync(pw, 10);
  const mk = (email: string, role: string, companyId: string, opsProfile: string | null) =>
    prisma.user.create({ data: { email, name: email.split('@')[0], role, companyId, opsProfile, passwordHash: hash, active: true } });
  await mk('e2e-admin-a@prueba.local', 'COMPANY_ADMIN', A.id, null);
  await mk('e2e-booker-a@prueba.local', 'COMPANY_VIEWER', A.id, 'BOOKER');
  await mk('e2e-aprobador-a@prueba.local', 'COMPANY_VIEWER', A.id, 'BOOKER_APPROVER');
  await mk('e2e-consulta-a@prueba.local', 'COMPANY_VIEWER', A.id, null);
  await mk('e2e-admin-b@prueba.local', 'COMPANY_ADMIN', B.id, null);
  const booker = await login('e2e-booker-a@prueba.local', pw);
  const approver = await login('e2e-aprobador-a@prueba.local', pw);
  const viewer = await login('e2e-consulta-a@prueba.local', pw);
  const adminB = await login('e2e-admin-b@prueba.local', pw);
  const bookerUser = await prisma.user.findUnique({ where: { email: 'e2e-booker-a@prueba.local' } });

  console.log('Flujo mínimo (API y base reales del piloto, datos de prueba):');
  // 1-3
  let r = await call(booker, 'POST', '/productions', { clientName: 'Marca de prueba E2E', contactName: 'Contacto de prueba', contactPhone: '+570000000000', channel: 'REFERRAL', referredBy: 'Referido de prueba', isTest: true });
  ok('1. Un booker crea una solicitud', r.status === 201, String(r.status));
  const id = r.body.production.id;
  ok('2. Se registran contacto y canal de origen', r.body.production.channel === 'REFERRAL' && r.body.production.contactName === 'Contacto de prueba');
  ok('3. Recibe identificador legible y estado válido', /^PR-\d{4}$/.test(r.body.production.code) && r.body.production.status === 'NUEVA', r.body.production.code);
  // 4
  r = await call(booker, 'PATCH', `/productions/${id}`, { ownerId: bookerUser!.id, nextAction: 'Completar brief' });
  ok('4. Se asigna un booker', r.status === 200 && r.body.production.ownerId === bookerUser!.id);
  // 5
  r = await call(booker, 'PUT', `/productions/${id}/brief`, { brief: { description: 'Campaña de prueba', objective: 'Validar el flujo' } });
  ok('5a. El brief parcial muestra lo que falta', r.body.missing.toComplete.length > 0);
  r = await call(booker, 'POST', `/productions/${id}/transition`, { to: 'BRIEF_COMPLETO' });
  ok('5b. No se da por completo con campos faltantes', r.status === 400);
  r = await call(booker, 'PUT', `/productions/${id}/brief`, { brief: { dates: '2026-11-20', duration: 'Jornada completa', modelsCount: 1, deliverables: '10 fotos (prueba)' } });
  ok('5c. Brief completo y listo para cotizar', r.body.missing.toComplete.length === 0 && r.body.missing.toQuote.length === 0);
  r = await call(booker, 'POST', `/productions/${id}/transition`, { to: 'BRIEF_COMPLETO' });
  ok('5d. Transición a brief completo', r.body.production.status === 'BRIEF_COMPLETO');
  await call(booker, 'POST', `/productions/${id}/transition`, { to: 'BUSCANDO_RECURSOS' });
  // 6-7
  const model = (await call(booker, 'POST', '/productions/resources', { kind: 'MODEL', name: 'Modelo de prueba E2E' })).body;
  r = await call(booker, 'POST', `/productions/${id}/assignments`, { serviceType: 'MODEL', resourceId: model.id, role: 'SELECTED', startsAt: '2026-11-20T14:00:00Z', endsAt: '2026-11-20T20:00:00Z' });
  ok('6. Se registra el recurso necesario', r.status === 201);
  const aid = r.body.id;
  r = await call(booker, 'POST', `/productions/assignments/${aid}/availability`, { availability: 'AVAILABLE', note: 'Registro manual de prueba (nadie fue contactado)' });
  ok('7a. Disponibilidad documentada como registro manual', r.body.availabilitySource === 'MANUAL' && r.body.reservation === 'NONE');
  r = await call(booker, 'POST', `/productions/assignments/${aid}/hold`, {});
  ok('7b. Sin regla de retención confirmada, se exige vencimiento', r.status === 400);
  r = await call(booker, 'POST', `/productions/assignments/${aid}/hold`, { holdExpiresAt: '2026-11-01T00:00:00Z' });
  ok('7c. Retención temporal con vencimiento explícito', r.body.reservation === 'HOLD');
  await call(booker, 'POST', `/productions/${id}/transition`, { to: 'PROPUESTA_EN_PREPARACION' });
  // 8-9
  const pendingLines = [{ id: 'm1', category: 'MODEL', description: 'Modelo jornada (VALOR DE PRUEBA)', quantity: 1, unit: 'FULL_DAY', unitCost: 1000, costStatus: 'ESTIMATED', unitPrice: 1500, priceStatus: 'ESTIMATED', billing: 'INCLUDED' }, { id: 'x1', category: 'CATERING', description: 'Alimentación (por definir)', billing: 'TO_CONFIRM' }];
  r = await call(booker, 'POST', `/productions/${id}/quotes`, { lines: pendingLines });
  const q1 = r.body.quotes[0];
  ok('8. Cotización con valores de prueba e importes pendientes', q1.totals.complete === false && q1.totals.clientTotal === null);
  await call(booker, 'POST', `/productions/quotes/${q1.id}/submit`, {});
  r = await call(booker, 'POST', `/productions/quotes/${q1.id}/decision`, { decision: 'APPROVE' });
  ok('9a. Quien edita no puede aprobar', r.status === 403);
  r = await call(approver, 'POST', `/productions/quotes/${q1.id}/decision`, { decision: 'APPROVE' });
  ok('9b. No se aprueba con valores pendientes', r.status === 400);
  await call(approver, 'POST', `/productions/quotes/${q1.id}/decision`, { decision: 'REJECT', note: 'Falta definir la alimentación (prueba)' });
  r = await call(booker, 'POST', `/productions/${id}/quotes`, {});
  const q2 = r.body.quotes[0];
  await call(booker, 'PUT', `/productions/quotes/${q2.id}`, { lines: [pendingLines[0], { ...pendingLines[1], unitPrice: 300, unitCost: 200, billing: 'CLIENT_DIRECT' }] });
  await call(booker, 'POST', `/productions/quotes/${q2.id}/submit`, {});
  r = await call(approver, 'POST', `/productions/quotes/${q2.id}/decision`, { decision: 'APPROVE', note: 'Aprobación de prueba' });
  ok('9c. La aprueba el usuario autorizado (v2) y queda registrado quién', r.body.production.status === 'COTIZACION_APROBADA' && r.body.quotes[0].decidedByName === 'e2e-aprobador-a');
  ok('9d. La versión 2 guarda qué cambió frente a la 1', r.body.quotes[0].diff.changed.length === 1);
  // 10
  r = await call(booker, 'POST', `/productions/${id}/tasks`, { title: 'Coordinar transporte (prueba)', dueAt: '2026-11-19T15:00:00Z' });
  let detail: any = null;
  for (let i = 0; i < 20; i++) {
    detail = (await call(booker, 'GET', `/productions/${id}`)).body;
    if (detail.tasks.filter((t: any) => t.origin === 'RULE').length >= 5) break;
    await new Promise((res) => setTimeout(res, 300));
  }
  ok('10. Tareas de coordinación: por regla (motor real vía cola) y manuales', detail.tasks.filter((t: any) => t.origin === 'RULE').length >= 5 && detail.tasks.some((t: any) => t.origin === 'MANUAL'), String(detail.tasks.length));
  const runs = (await call(booker, 'GET', '/productions/runs')).body;
  ok('10b. Ejecuciones del motor persistidas y completadas', runs.length > 0 && runs.every((x: any) => x.status === 'COMPLETED'), runs.map((x: any) => x.status).join(','));
  // 11
  ok('11. Los cambios quedan en el historial', ['created', 'assigned', 'brief', 'status', 'resource', 'availability', 'reservation', 'quote', 'approval', 'task'].every((t) => detail.events.some((e: any) => e.type === t)));
  // 12
  r = await call(booker, 'POST', `/productions/${id}/issues`, { kind: 'PRUEBA', severity: 'HIGH', description: 'Incidencia simulada de prueba: el cliente cambió el horario' });
  const iid = r.body.id;
  r = await call(booker, 'POST', `/productions/issues/${iid}/resolve`, { resolution: 'Se ajustó el horario (prueba)' });
  ok('12. Incidencia simulada registrada y resuelta con seguimiento', r.body.status === 'RESOLVED');
  // 13-14
  await call(booker, 'POST', `/productions/quotes/${q2.id}/mark-sent`, { note: 'Simulación: no se envió nada; registro de prueba' });
  r = await call(booker, 'POST', `/productions/${id}/transition`, { to: 'ACEPTADA_POR_CLIENTE', evidence: 'Aceptación simulada de prueba' });
  await call(booker, 'POST', `/productions/${id}/transition`, { to: 'CONFIRMACION_DE_RECURSOS_PENDIENTE' });
  r = await call(booker, 'POST', `/productions/${id}/transition`, { to: 'CONFIRMADA' });
  ok('13. Avanza por transiciones válidas hasta donde lo permiten los recursos', r.status === 400 && /por confirmar/.test(r.body.message));
  r = await call(booker, 'POST', `/productions/${id}/transition`, { to: 'CERRADA' });
  detail = (await call(booker, 'GET', `/productions/${id}`)).body;
  ok('14. No queda confirmada ni cerrada sin cumplir condiciones', r.status === 400 && detail.production.status === 'CONFIRMACION_DE_RECURSOS_PENDIENTE');
  // 15
  r = await call(adminB, 'GET', `/productions/${id}?companyId=${A.id}`);
  const listB = (await call(adminB, 'GET', `/productions?includeTest=true&companyId=${A.id}`)).body;
  const patchB = await call(adminB, 'PATCH', `/productions/${id}?companyId=${A.id}`, { notes: 'x' });
  const decideB = await call(adminB, 'POST', `/productions/quotes/${q2.id}/decision?companyId=${A.id}`, { decision: 'REJECT', note: 'x' });
  ok('15. Otra empresa no puede ver ni tocar nada (aunque envíe el companyId)', r.status === 404 && listB.total === 0 && patchB.status === 404 && decideB.status === 404);
  const viewerPatch = await call(viewer, 'PATCH', `/productions/${id}`, { notes: 'x' });
  ok('15b. Un usuario de consulta no modifica', viewerPatch.status === 403);
  const integ = (await call(booker, 'GET', '/productions/integrations')).body.items;
  ok('Integraciones: ninguna aparece conectada sin evidencia', integ.every((x: any) => x.readiness !== 'RECEIVING'));
  console.log(`\n${passed} comprobaciones superadas.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    const n = await cleanup().catch(() => -1);
    console.log(`Limpieza: ${n} empresa(s) de prueba borradas de la base del piloto.`);
    await prisma.$disconnect();
  });
