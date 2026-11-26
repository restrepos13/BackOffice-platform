// 05 · Carga, pico, estrés y resistencia. PERFIL=carga|pico|estres|resistencia|login|whatsapp
//   carga        uso normal alto: 60 personas navegando 2 min + mensajes de WhatsApp entrando + logins
//   pico         salto brusco de 10 a 300 personas
//   estres       peticiones por segundo en aumento hasta encontrar dónde se rompe
//   resistencia  40 personas durante 6 min, para ver fugas de memoria o degradación
//   login        cuántos inicios de sesión por segundo aguanta (bcrypt)
//   whatsapp     ráfaga de mensajes entrantes por el webhook
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { API, SLUG_A, USUARIOS, cab, entrar, resumen } from './lib/comun.js';

const PERFIL = __ENV.PERFIL || 'carga';
const PESADAS = /pdf|compare\/summary|stock\/search|calendar\/google|data-export/;
const LECTURAS = JSON.parse(open('./datos/lecturas-admin.json')).map((x) => x.ruta).filter((r) => !PESADAS.test(r));
// Lo que más se abre en el día a día pesa más en la mezcla
const FRECUENTES = ['/conversations/inbox', '/conversations', '/contacts', '/auth/me', '/metrics/company', '/orders', '/reports/daily', '/automations', '/billing/summary'];

const errores5xx = new Counter('bo_errores_5xx');
const limitadas = new Counter('bo_respuestas_429');
const okNavegacion = new Rate('bo_navegacion_ok');
const tLogin = new Trend('bo_login_ms', true);
const tWebhook = new Trend('bo_webhook_ms', true);
const tLectura = new Trend('bo_lectura_ms', true);

const personas = (etapas) => ({ executor: 'ramping-vus', exec: 'navegar', startVUs: 0, stages: etapas, gracefulRampDown: '5s' });
const ritmo = (exec, etapas, vus = 200) => ({ executor: 'ramping-arrival-rate', exec, startRate: etapas[0].target, timeUnit: '1s', preAllocatedVUs: Math.min(vus, 100), maxVUs: vus, stages: etapas });

const ESCENARIOS = {
  carga: {
    personas: personas([{ duration: '30s', target: 60 }, { duration: '2m', target: 60 }, { duration: '15s', target: 0 }]),
    mensajes: ritmo('mensajeEntrante', [{ duration: '2m45s', target: 5 }], 40),
    ingresos: ritmo('ingreso', [{ duration: '2m45s', target: 1 }], 20),
  },
  pico: { personas: personas([{ duration: '15s', target: 10 }, { duration: '10s', target: 300 }, { duration: '40s', target: 300 }, { duration: '10s', target: 10 }, { duration: '20s', target: 10 }]) },
  estres: { lecturas: ritmo('lectura', [{ duration: '20s', target: 100 }, { duration: '30s', target: 300 }, { duration: '30s', target: 600 }, { duration: '30s', target: 1000 }, { duration: '30s', target: 1500 }, { duration: '30s', target: 2000 }, { duration: '10s', target: 0 }], 1500) },
  resistencia: { personas: personas([{ duration: '20s', target: 40 }, { duration: '6m', target: 40 }, { duration: '10s', target: 0 }]), mensajes: ritmo('mensajeEntrante', [{ duration: '6m30s', target: 2 }], 20) },
  login: { ingresos: ritmo('ingreso', [{ duration: '25s', target: 1 }, { duration: '25s', target: 2 }, { duration: '25s', target: 3 }, { duration: '25s', target: 4 }, { duration: '25s', target: 6 }, { duration: '5s', target: 0 }], 150) },
  whatsapp: { mensajes: ritmo('mensajeEntrante', [{ duration: '25s', target: 10 }, { duration: '25s', target: 20 }, { duration: '25s', target: 30 }, { duration: '25s', target: 45 }, { duration: '25s', target: 60 }, { duration: '5s', target: 0 }], 400) },
};
const UMBRALES = {
  carga: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500', 'p(99)<1500'], bo_errores_5xx: ['count==0'], bo_navegacion_ok: ['rate>0.99'] },
  resistencia: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'], bo_errores_5xx: ['count==0'] },
  pico: { bo_errores_5xx: ['count==0'], http_req_duration: ['p(95)<3000'] },
};
export const options = { scenarios: ESCENARIOS[PERFIL], thresholds: UMBRALES[PERFIL] || {}, setupTimeout: '120s', summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'], discardResponseBodies: true };

export function setup() {
  // Sesiones de las empresas de demostración; cada persona virtual usa una
  return ['ADMIN_A', 'VIEWER_A', 'ADMIN_B', 'VIEWER_B', 'ADMIN_C', 'ADMIN_NEXUS'].map((k) => entrar(USUARIOS[k]).token);
}
const elegir = (a) => a[Math.floor(Math.random() * a.length)];
const ruta = () => (Math.random() < 0.5 ? elegir(FRECUENTES) : elegir(LECTURAS));
function medir(r) {
  if (r.status >= 500 || r.status === 0) errores5xx.add(1);
  if (r.status === 429) limitadas.add(1);
}

/** Una persona usando el panel: abre una pantalla (2 a 4 consultas a la vez) y la mira un rato. */
export function navegar(tokens) {
  const t = tokens[__VU % tokens.length], n = 2 + Math.floor(Math.random() * 3);
  const rs = http.batch(Array.from({ length: n }, () => { const p = ruta(); return ['GET', API + p, null, { headers: cab(t), tags: { name: 'GET (panel)' } }]; }));
  for (const r of rs) { medir(r); tLectura.add(r.timings.duration); okNavegacion.add(r.status === 200); }
  sleep(1 + Math.random() * 2);
}
/** Una consulta suelta, sin pausa (para el estrés por ritmo de llegada). */
export function lectura(tokens) {
  const r = http.get(API + ruta(), { headers: cab(tokens[__ITER % tokens.length]), tags: { name: 'GET (panel)' } });
  medir(r); tLectura.add(r.timings.duration); check(r, { 'lectura 200': (x) => x.status === 200 });
}
export function ingreso() {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ email: elegir(Object.values(USUARIOS)), password: __ENV.K6_PASSWORD }), { headers: cab(null), tags: { name: 'POST /auth/login' }, timeout: '20s' });
  medir(r); tLogin.add(r.timings.duration); check(r, { 'login 201': (x) => x.status === 201 });
}
export function mensajeEntrante() {
  const tel = `5732${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const cuerpo = { object: 'whatsapp_business_account', entry: [{ id: 'k6', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'k6' }, contacts: [{ wa_id: tel, profile: { name: `Carga ${tel.slice(-5)}` } }], messages: [{ from: tel, id: `wamid.k6.${tel}.${Date.now()}.${__VU}.${__ITER}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: 'Hola, ¿tienen disponibilidad esta semana?' } }] } }] }] };
  const r = http.post(`${API}/webhooks/${SLUG_A}/whatsapp`, JSON.stringify(cuerpo), { headers: cab(null), tags: { name: 'POST /webhooks/:slug/whatsapp' } });
  medir(r); tWebhook.add(r.timings.duration); check(r, { 'webhook aceptado': (x) => x.status < 300 });
}
export const handleSummary = resumen(`05-carga-${PERFIL}`);
