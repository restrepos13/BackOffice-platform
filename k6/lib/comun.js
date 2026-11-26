// Utilidades comunes de las pruebas k6. Solo corren contra el entorno local aislado.
import http from 'k6/http';

export const BASE = __ENV.K6_BASE || 'http://localhost:4021';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) {
  throw new Error(`K6_BASE debe ser local (recibido: ${BASE}). Estas pruebas no se corren contra producción.`);
}
export const API = `${BASE}/api`;
const PW = __ENV.K6_PASSWORD;
if (!PW) throw new Error('Falta K6_PASSWORD: corré k6 con «node k6/entorno.cjs k6 run …»');

/** Un usuario por rol, de las empresas de demostración que crean los seeds. */
export const USUARIOS = {
  SUPER_ADMIN: 'santiago@backoffice.dev',
  DEV: 'dev@backoffice.dev',
  ADMIN_A: 'admin@massaludlatam.com',
  VIEWER_A: 'vista@massaludlatam.com',
  ADMIN_B: 'admin@hmmotors.net',
  VIEWER_B: 'vista@hmmotors.net',
  ADMIN_C: 'admin@novastudio.co',
  ADMIN_NEXUS: 'admin@nexuscatering.co',
  AREA_NEXUS: 'cocina@nexuscatering.co',
};
export const SLUG_A = 'mas-salud-latam';

/** IP distinta por petición: el limitador por IP no interfiere con las pruebas de capacidad
 *  (el API de pruebas confía en X-Forwarded-For: TRUST_PROXY_HOPS=1). */
export const ipAleatoria = () => `10.${rnd(250)}.${rnd(250)}.${1 + rnd(250)}`;
const rnd = (n) => Math.floor(Math.random() * n);

export function cab(token, ip) {
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || ipAleatoria() };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export function entrar(email) {
  const r = http.post(`${API}/auth/login`, JSON.stringify({ email, password: PW }), { headers: cab(null), tags: { name: 'POST /auth/login' }, responseType: 'text' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`No se pudo entrar como ${email}: ${r.status}`);
  const j = r.json();
  return { token: j.token, id: j.user.id, role: j.user.role, companyId: j.user.companyId, email };
}

export function entrarTodos() {
  const s = {};
  for (const [k, email] of Object.entries(USUARIOS)) s[k] = entrar(email);
  return s;
}

/** Línea de resultado para el informe (se recoge con --console-output). */
export const anotar = (o) => console.log('R|' + JSON.stringify(o));

/** Rutas del inventario (k6/datos/rutas.json, generado leyendo los controladores). */
export const RUTAS = JSON.parse(open('../datos/rutas.json'));
export const conParams = (ruta, valor = 'k6inexistente000000000000') => ruta.replace(/:[A-Za-z]+/g, valor);

export function resumen(nombre) {
  return (data) => {
    const m = data.metrics, v = (k, f) => (m[k] && m[k].values[f] !== undefined ? m[k].values[f] : null);
    const out = {
      suite: nombre, fecha: new Date().toISOString(),
      peticiones: v('http_reqs', 'count'), porSegundo: v('http_reqs', 'rate'),
      fallidas: v('http_req_failed', 'rate'),
      ms: { media: v('http_req_duration', 'avg'), mediana: v('http_req_duration', 'med'), p90: v('http_req_duration', 'p(90)'), p95: v('http_req_duration', 'p(95)'), p99: v('http_req_duration', 'p(99)'), max: v('http_req_duration', 'max') },
      checks: m.checks ? { ok: m.checks.values.passes, mal: m.checks.values.fails } : null,
      umbrales: Object.fromEntries(Object.entries(m).filter(([, x]) => x.thresholds).map(([k, x]) => [k, x.thresholds])),
      extra: Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('bo_')).map(([k, x]) => [k, x.values])),
    };
    const p = (n) => (n === null ? '—' : Math.round(n * 10) / 10);
    const txt = `\n${nombre}: ${out.peticiones} peticiones (${p(out.porSegundo)}/s) · fallidas ${p((out.fallidas || 0) * 100)}% · p50 ${p(out.ms.mediana)} ms · p95 ${p(out.ms.p95)} ms · p99 ${p(out.ms.p99)} ms · máx ${p(out.ms.max)} ms · checks ${out.checks ? out.checks.ok + ' ok / ' + out.checks.mal + ' mal' : '—'}\n`;
    return { stdout: txt, [`k6/resultados/${nombre}.json`]: JSON.stringify(out, null, 1) };
  };
}
