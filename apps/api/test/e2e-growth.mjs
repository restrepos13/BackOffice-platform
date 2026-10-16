/**
 * E2E en SIMULTÁNEO contra el API VIVO (http://localhost:4001/api):
 * el lado de la EMPRESA (admin) y el lado de los DEVS (plataforma) trabajan
 * a la vez sobre una empresa de prueba aislada que el script crea y borra.
 *
 * - Nunca sale un mensaje real: la línea es sandbox y los contactos no tienen
 *   ventana de 24 h (las campañas los omiten sin plantilla).
 * - Ronda 1: flujos completos de cada lado en paralelo.
 * - Ronda 2: carreras sobre el mismo recurso (doble envío de campaña, pedido
 *   externo repetido, ajustes de cobro mientras la empresa consulta).
 *
 * Requiere: API corriendo + seeds. Correr: node test/e2e-growth.mjs
 */
import { randomBytes } from 'crypto';

const BASE = process.env.API_URL ?? 'http://localhost:4001/api';
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
const DEV = { email: 'restrepos591@gmail.com', password: process.env.SEED_PASSWORD_DEV_SANTIAGO };
// Borrar empresas es exclusivo del super admin (la limpieza final)
const SUPER = { email: 'santiago@backoffice.dev', password: process.env.SEED_PASSWORD_SANTIAGO };
if (!DEV.password || !SUPER.password) throw new Error('Faltan SEED_PASSWORD_DEV_SANTIAGO / SEED_PASSWORD_SANTIAGO en apps/api/.env');

let passed = 0;
const failures = [];
function check(side, name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ [${side}] ${name}`);
  } else {
    failures.push(`[${side}] ${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ [${side}] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  if (!raw) { try { data = JSON.parse(text); } catch {} }
  return { status: res.status, data };
}
const ok = (r) => r.status >= 200 && r.status < 300;
const msg = (r) => `${r.status} ${typeof r.data === 'object' ? JSON.stringify(r.data.message ?? r.data).slice(0, 160) : String(r.data).slice(0, 160)}`;

async function login(email, password) {
  const r = await call('POST', '/auth/login', { body: { email, password } });
  if (!ok(r)) throw new Error(`login ${email}: ${msg(r)}`);
  return r.data.accessToken ?? r.data.token;
}

const period = (offset = 0) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

/* ───────────────────────── Preparación ───────────────────────── */

const stamp = Date.now().toString(36);
const devToken = await login(DEV.email, DEV.password);
const superToken = await login(SUPER.email, SUPER.password);
const plans = await call('GET', '/plans', { token: devToken });
const plan = plans.data.find((p) => p.code === 'negocios-negocio');
const adminCreds = { email: `e2e-${stamp}@backoffice.test`, password: `E2e-${randomBytes(9).toString('base64url')}` };
const created = await call('POST', '/companies', {
  token: devToken,
  body: {
    name: `E2E Crecimiento ${stamp}`, city: 'Medellín', country: 'Colombia', currency: 'COP', timezone: 'America/Bogota',
    planId: plan?.id, status: 'ACTIVE', modules: ['inbox', 'contacts', 'orders', 'delivery', 'bots', 'billing', 'team'],
    admin: { name: 'Admin E2E', ...adminCreds },
  },
});
if (!ok(created)) throw new Error(`No se pudo crear la empresa de prueba: ${msg(created)}`);
const company = created.data.company ?? created.data;
const CO = company.id;
const q = `companyId=${CO}`;
console.log(`\nEmpresa de prueba: ${company.name} (${company.slug})`);
const adminToken = await login(adminCreds.email, adminCreds.password);
let apiKeyId = null;

try {
  /* Datos base: línea sandbox, productos, contactos */
  const line = await call('POST', '/integrations', { token: adminToken, body: { type: 'WHATSAPP', name: 'Línea sandbox' } });
  await call('PATCH', `/integrations/${line.data.id}`, { token: adminToken, body: { config: { provider: 'TWILIO', sandbox: true }, status: 'CONNECTED' } });
  const mkProduct = (name, price, category) => call('POST', '/catalog/products', {
    token: adminToken, body: { name, price, category, unit: 'porción', presentations: [], active: true },
  });
  const [bandeja, ajiaco] = await Promise.all([mkProduct('Bandeja paisa', 18000, 'Almuerzos'), mkProduct('Ajiaco', 16000, 'Almuerzos')]);
  for (let i = 0; i < 4; i++) {
    await call('POST', '/contacts', { token: adminToken, body: { name: `Cliente ${i}`, phone: `+57300000${1000 + i}`, channel: 'SIMULATOR', tags: i < 2 ? ['vip'] : [] } });
  }

  /* ═══ Ronda 1: empresa y devs en paralelo ═══ */
  console.log('\nRonda 1 · flujos en paralelo');

  const companySide = async () => {
    const S = 'empresa';
    // Agotados y menú QR
    let r = await call('PATCH', `/catalog/products/${ajiaco.data.id}/sold-out`, { token: adminToken, body: { soldOut: true, until: 'TODAY' } });
    check(S, 'marca un producto agotado hoy', ok(r), msg(r));
    const co = await call('GET', `/companies/${CO}`, { token: adminToken });
    r = await call('PATCH', `/companies/${CO}`, {
      token: adminToken,
      body: { orderConfig: { ...(co.data.orderConfig ?? {}), menu: { enabled: true, title: 'Almuerzos', whatsappPhone: '573000000000' } } },
    });
    check(S, 'publica el menú digital', ok(r), msg(r));
    const menu = await call('GET', `/public/menu/${company.slug}`);
    const items = (menu.data.categories ?? []).flatMap((c) => c.items);
    check(S, 'menú público muestra el agotado y el WhatsApp', ok(menu) && items.find((i) => i.name === 'Ajiaco')?.soldOut === true && menu.data.whatsapp === '573000000000', msg(menu));
    const qr = await call('GET', `/public/menu/${company.slug}/qr.svg`, { raw: true });
    check(S, 'QR del menú en SVG', ok(qr) && String(qr.data).startsWith('<svg'), msg(qr));

    // Promociones y respuestas rápidas
    r = await call('POST', '/promotions', { token: adminToken, body: { name: 'Combo 10%', code: 'COMBO10', kind: 'PERCENT', value: 10, minSubtotal: 20000 } });
    check(S, 'crea cupón COMBO10', ok(r) && r.data.code === 'COMBO10', msg(r));
    r = await call('POST', '/promotions', { token: adminToken, body: { name: 'Mal', kind: 'PERCENT', value: 150 } });
    check(S, 'rechaza un porcentaje mayor a 100', r.status === 400, msg(r));
    r = await call('POST', '/quick-replies', { token: adminToken, body: { shortcut: '/Horario', title: 'Horario', body: 'Hola {nombre}, abrimos de 11 a 3' } });
    check(S, 'crea respuesta rápida /horario', ok(r) && r.data.shortcut === 'horario', msg(r));
    r = await call('POST', '/quick-replies', { token: adminToken, body: { shortcut: 'horario', title: 'Otra', body: 'x' } });
    check(S, 'no permite atajos duplicados', r.status === 400, msg(r));

    // Embudo propio + contacto
    const pipe = await call('POST', '/pipelines', { token: adminToken, body: { name: 'Eventos', stages: [{ label: 'Solicitud' }, { label: 'Cotizado' }, { label: 'Contratado', kind: 'WON' }] } });
    check(S, 'crea embudo configurable', ok(pipe) && pipe.data.stages?.length === 3, msg(pipe));
    r = await call('POST', '/contacts', { token: adminToken, body: { name: 'Boda Gómez', phone: '+573009999999', channel: 'SIMULATOR', pipelineId: pipe.data.id } });
    check(S, 'contacto nuevo entra a la primera etapa del embudo', ok(r) && r.data.stage === 'SOLICITUD', msg(r));
    const std = await call('GET', '/contacts?pipelineId=default', { token: adminToken });
    check(S, 'el embudo estándar no mezcla contactos del embudo propio', ok(std) && std.data.length === 4 && !std.data.some((c) => c.name === 'Boda Gómez'), `vio ${std.data.length}`);

    // Conocimiento
    r = await call('POST', '/knowledge/text', { token: adminToken, body: { title: 'Políticas', text: 'Pagos: aceptamos Nequi, Daviplata y efectivo contra entrega.\n\nCobertura: Laureles, Estadio y Belén.' } });
    check(S, 'aprende un documento de texto', ok(r), msg(r));
    r = await call('POST', '/knowledge/search', { token: adminToken, body: { query: '¿puedo pagar con nequi?' } });
    check(S, 'la búsqueda encuentra la respuesta', ok(r) && r.data[0]?.text?.includes('Nequi'), msg(r));
    r = await call('POST', '/knowledge/url', { token: adminToken, body: { url: 'http://127.0.0.1:4001/api/health' } });
    check(S, 'bloquea URLs internas (SSRF)', r.status === 400, msg(r));

    // Domicilios por zonas + sucursal
    const co2 = await call('GET', `/companies/${CO}`, { token: adminToken });
    r = await call('PATCH', `/companies/${CO}`, {
      token: adminToken,
      body: {
        orderConfig: {
          ...(co2.data.orderConfig ?? {}),
          delivery: {
            enabled: true, origin: { lat: 6.2446, lng: -75.5958, address: 'Laureles' }, maxKm: 10, baseFee: 3000, perKm: 1000,
            pricingMode: 'ZONES', zonesFallbackKm: false, zones: [{ name: 'Laureles', fee: 4500, keywords: ['laureles', 'estadio'] }],
            autoAssign: true, delayAlertMinutes: 10, unassignedAlertMinutes: 15,
          },
        },
      },
    });
    check(S, 'configura domicilios por barrio', ok(r), msg(r));
    r = await call('POST', '/delivery/branches', { token: adminToken, body: { name: 'Sede Poblado', lat: 6.2087, lng: -75.5678, address: 'El Poblado' } });
    check(S, 'crea sucursal', ok(r), msg(r));
    r = await call('POST', '/delivery/quote', { token: adminToken, body: { address: 'Calle 44 # 74-10, barrio Laureles, Medellín', subtotal: 30000 } });
    check(S, 'cotiza la zona por el barrio de la dirección', ok(r) && r.data.fee === 4500 && r.data.zone === 'Laureles', msg(r));

    // Pagos y factura
    r = await call('PATCH', '/payments/config', { token: adminToken, body: { env: 'test', publicKey: 'pub_test_e2eFake123', integritySecret: 'test_integrity_e2e', manualInstructions: 'Nequi 300 000 0000', acceptCash: true } });
    check(S, 'configura Wompi de la empresa (secreto cifrado)', ok(r) && r.data.hasIntegritySecret && !JSON.stringify(r.data).includes('test_integrity_e2e'), msg(r));
    r = await call('PATCH', '/einvoice/config', { token: adminToken, body: { provider: 'SIMULADO', taxRate: 0.08 } });
    check(S, 'activa factura electrónica (simulada)', ok(r) && r.data.ready, msg(r));

    // Campaña (sin ventana de 24 h → todos omitidos: nada sale)
    r = await call('POST', '/campaigns/preview', { token: adminToken, body: { segment: { tags: ['vip'] }, integrationId: line.data.id } });
    check(S, 'vista previa de campaña segmentada', ok(r) && r.data.count === 2 && r.data.willSkip === 2, msg(r));
    const camp = await call('POST', '/campaigns', { token: adminToken, body: { name: 'Menú semana', integrationId: line.data.id, message: 'Hola {nombre}, menú nuevo', segment: { tags: ['vip'] } } });
    check(S, 'crea campaña en borrador', ok(camp) && camp.data.status === 'DRAFT', msg(camp));

    // Cobro mes a mes visto por la empresa
    r = await call('GET', '/billing/summary', { token: adminToken });
    check(S, 'consulta su cobro del mes', ok(r) && typeof r.data.total === 'number', msg(r));
    r = await call('POST', '/billing/adjustments', { token: adminToken, body: { companyId: CO, kind: 'DISCOUNT', concept: 'autodescuento', amount: 999999, startPeriod: period() } });
    check(S, 'NO puede crearse descuentos a sí misma', r.status === 403, msg(r));
    r = await call('GET', '/dev/apikeys', { token: adminToken });
    check(S, 'NO ve las API keys de la plataforma', r.status === 403, msg(r));
    return { campaignId: camp.data.id, lineId: line.data.id };
  };

  const devSide = async () => {
    const S = 'devs';
    // Cobro personalizable: precio propio este mes, cargo y descuento el siguiente
    let r = await call('PATCH', `/companies/${CO}`, { token: devToken, body: { customPriceMonthly: 300000 } });
    check(S, 'precio negociado para la empresa', ok(r), msg(r));
    const [charge, discount] = await Promise.all([
      call('POST', '/billing/adjustments', { token: devToken, body: { companyId: CO, kind: 'CHARGE', concept: 'Integración Rappi', amount: 120000, startPeriod: period(1), endPeriod: period(1) } }),
      call('POST', '/billing/adjustments', { token: devToken, body: { companyId: CO, kind: 'DISCOUNT', concept: 'Fidelidad', percent: 20, startPeriod: period(2), recurring: true } }),
    ]);
    check(S, 'cargo solo para el mes siguiente', ok(charge), msg(charge));
    check(S, 'descuento recurrente desde dentro de dos meses', ok(discount), msg(discount));
    r = await call('POST', '/billing/adjustments', { token: devToken, body: { companyId: CO, kind: 'DISCOUNT', concept: 'x', percent: 150, startPeriod: period() } });
    check(S, 'rechaza un descuento mayor al 100%', r.status === 400, msg(r));
    const fc = await call('GET', `/billing/forecast?${q}&months=4`, { token: devToken });
    const totals = (fc.data?.months ?? []).map((m) => m.total);
    check(S, 'proyección: este mes 300k, siguiente 420k, luego 240k', ok(fc) && totals[0] === 300000 && totals[1] === 420000 && totals[2] === 240000 && totals[3] === 240000, JSON.stringify(totals));
    r = await call('POST', '/billing/invoices/issue', { token: devToken, body: { companyId: CO, period: period() } });
    check(S, 'emite la factura del mes', ok(r) && r.data.totalAmount === 300000, msg(r));
    const inv = r.data;
    r = await call('PATCH', `/billing/invoices/${inv.id}`, { token: devToken, body: { lines: [{ kind: 'PLAN', concept: 'Plan Negocio', amount: 300000 }, { kind: 'DISCOUNT', concept: 'Cortesía', amount: 50000 }], notes: 'Ajuste comercial' } });
    check(S, 'edita la factura a mano (cortesía)', ok(r) && r.data.totalAmount === 250000, msg(r));

    // IA prepaga
    r = await call('POST', '/ai-credits/grant', { token: devToken, body: { companyId: CO, conversations: 500, validityMonths: 12, note: 'Cortesía E2E' } });
    check(S, 'regala un paquete de 500 conversaciones', ok(r), msg(r));
    r = await call('GET', `/ai-credits/status?${q}`, { token: devToken });
    check(S, 'el saldo refleja el paquete', ok(r) && JSON.stringify(r.data).includes('500'), msg(r));
    r = await call('GET', '/ai-credits/packages', { token: devToken });
    check(S, 'paquetes de IA en COP sembrados', ok(r) && r.data.some((p) => p.price === 299000 && p.currency === 'COP'), msg(r));

    // API key para pedidos externos + secreto nunca expuesto
    const key = await call('POST', '/dev/apikeys', { token: devToken, body: { name: `Rappi E2E ${stamp}`, companyId: CO, scopes: ['orders', 'superpoder'] } });
    apiKeyId = key.data.id;
    check(S, 'crea API key con permiso de pedidos (descarta permisos inventados)', ok(key) && JSON.stringify(key.data.scopes) === '["orders"]' && !('hash' in key.data), msg(key));
    const keys = await call('GET', '/dev/apikeys', { token: devToken });
    check(S, 'el listado de keys no expone hash ni secreto', ok(keys) && keys.data.every((k) => !('hash' in k) && !('secret' in k)), msg(keys));
    const settings = await call('GET', '/dev/settings', { token: devToken });
    check(S, 'settings incluye META_APP_SECRET', ok(settings) && JSON.stringify(settings.data).includes('META_APP_SECRET'), msg(settings));
    const order = await call('POST', '/inbound/orders', {
      headers: { 'x-api-key': key.data.secret },
      body: { source: 'RAPPI', externalId: `RP-${stamp}`, customer: { name: 'Laura Rappi', phone: '+573001112233', address: 'Laureles' }, items: [{ name: 'Bandeja paisa', quantity: 2 }], paid: true },
    });
    const saved = ok(order) ? await call('GET', `/orders/${order.data.id}`, { token: devToken }) : order;
    check(S, 'entra un pedido de Rappi con precio del catálogo, ya confirmado', ok(order) && saved.data.total === 36000 && saved.data.source === 'RAPPI' && order.data.status !== 'borrador', msg(saved));
    const bad = await call('POST', '/inbound/orders', { headers: { 'x-api-key': 'bo_live_inventada' }, body: {} });
    check(S, 'rechaza una llave inválida', bad.status === 401, msg(bad));
    return { apiKey: key.data.secret, orderId: order.data.id };
  };

  const [companyRes, devRes] = await Promise.all([companySide(), devSide()]);

  /* ═══ Ronda 2: carreras sobre el mismo recurso ═══ */
  console.log('\nRonda 2 · carreras simultáneas');

  // Doble envío de la misma campaña (dos clics / dos personas)
  const sends = await Promise.all([1, 2, 3].map(() => call('POST', `/campaigns/${companyRes.campaignId}/send`, { token: adminToken })));
  check('empresa', 'tres envíos simultáneos de la campaña → solo uno pasa', sends.filter(ok).length === 1 && sends.filter((r) => r.status === 400).length === 2, sends.map((r) => r.status).join(','));
  await new Promise((r) => setTimeout(r, 400));
  const detail = await call('GET', `/campaigns/${companyRes.campaignId}`, { token: adminToken });
  check('empresa', 'sin ventana de 24 h nada sale (omitidos, sin envíos reales)', ok(detail) && detail.data.stats.skipped === 2 && detail.data.stats.sent === 0, JSON.stringify(detail.data.stats));

  // El mismo pedido externo llega 5 veces a la vez (reintentos del integrador)
  const dupes = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/inbound/orders', {
    headers: { 'x-api-key': devRes.apiKey },
    body: { source: 'POS', externalId: `POS-${stamp}`, customer: { name: 'Mesa 4' }, items: [{ name: 'Ajiaco', quantity: 1, unitPrice: 16000 }] },
  })));
  const ids = new Set(dupes.filter(ok).map((r) => r.data.id));
  check('devs', 'cinco reintentos simultáneos → un solo pedido', dupes.every(ok) && ids.size === 1, `${[...ids].length} pedidos · ${dupes.map((r) => r.status).join(',')}`);

  // Empresa cobra el pedido mientras los devs cambian el cobro del mes
  const [link, paid, adj, summary] = await Promise.all([
    call('POST', `/payments/orders/${devRes.orderId}/link`, { token: adminToken }),
    call('POST', `/payments/orders/${[...ids][0]}/mark-paid`, { token: adminToken, body: { method: 'EFECTIVO' } }),
    call('POST', '/billing/adjustments', { token: devToken, body: { companyId: CO, kind: 'CHARGE', concept: 'Soporte extra', amount: 50000, startPeriod: period() } }),
    call('GET', '/billing/summary', { token: adminToken }),
  ]);
  check('empresa', 'un pedido ya pagado (Rappi) no genera link de cobro', link.status === 400, msg(link));
  check('empresa', 'marca pagado en efectivo el pedido del POS', ok(paid) && paid.data.paymentStatus === 'PAID', msg(paid));
  check('devs', 'agrega un cargo a este mes en caliente', ok(adj), msg(adj));
  check('empresa', 'su resumen sigue respondiendo durante el cambio', ok(summary), msg(summary));
  const after = await call('GET', '/billing/summary', { token: adminToken });
  check('empresa', 've el cargo nuevo en su cobro del mes (300k + 50k)', ok(after) && after.data.total === 350000, `total ${after.data.total}`);

  const einv = await call('POST', `/orders/${[...ids][0]}/einvoice`, { token: adminToken });
  check('empresa', 'emite factura electrónica del pedido', ok(einv) && einv.data.ok === true && String(einv.data.number).startsWith('SIM-'), msg(einv));
  const einv2 = await call('POST', `/orders/${[...ids][0]}/einvoice`, { token: adminToken });
  check('empresa', 'no factura dos veces el mismo pedido', einv2.status === 400, msg(einv2));
} finally {
  /* Limpieza: la empresa de prueba y su llave desaparecen */
  if (apiKeyId) await call('DELETE', `/dev/apikeys/${apiKeyId}`, { token: devToken });
  const devDel = await call('DELETE', `/companies/${CO}`, { token: devToken });
  check('devs', 'un DEV no puede borrar empresas (solo super admin)', devDel.status === 403, msg(devDel));
  const del = await call('DELETE', `/companies/${CO}`, { token: superToken });
  check('devs', 'el super admin borra la empresa de prueba', ok(del), msg(del));
  const gone = await call('GET', `/public/menu/${company.slug}`);
  check('devs', 'su menú público ya no existe', gone.status === 404, msg(gone));
}

console.log(`\n${passed} pasaron · ${failures.length} fallaron`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
