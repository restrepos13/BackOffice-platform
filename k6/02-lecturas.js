// 02 · Barrido de lecturas: TODOS los GET sin parámetros del API, con cada rol.
// Ninguno puede responder 5xx ni tardar más de 2 s. Anota el estado por rol para el informe.
import http from 'k6/http';
import { check } from 'k6';
import { API, RUTAS, cab, entrarTodos, anotar, resumen } from './lib/comun.js';

export const options = { vus: 1, iterations: 1, setupTimeout: '120s', summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'], thresholds: { 'checks{tipo:sin5xx}': ['rate==1'] } };

const SALTAR = [/^\/events\/stream$/, /callback$/, /^\/webhooks\//];
const GETS = RUTAS.filter((r) => r.verb === 'GET' && !r.route.includes(':') && !SALTAR.some((x) => x.test(r.route)));

export function setup() { return entrarTodos(); }

export default function (s) {
  const empresaA = s.ADMIN_A.companyId;
  const pasadas = [
    ['SUPER_ADMIN', s.SUPER_ADMIN, ''], ['SUPER_ADMIN+empresa', s.SUPER_ADMIN, empresaA],
    ['DEV', s.DEV, ''], ['DEV+empresa', s.DEV, empresaA],
    ['COMPANY_ADMIN', s.ADMIN_A, ''], ['COMPANY_ADMIN (Nova)', s.ADMIN_C, ''], ['COMPANY_ADMIN (Nexus)', s.ADMIN_NEXUS, ''],
    ['COMPANY_VIEWER', s.VIEWER_A, ''], ['COMPANY_AREA', s.AREA_NEXUS, ''],
  ];
  for (const [rol, ses, companyId] of pasadas) {
    for (const r of GETS) {
      const url = API + r.route + (companyId ? `?companyId=${companyId}` : '');
      const res = http.get(url, { headers: cab(r.pub ? null : ses.token), tags: { name: 'GET ' + r.route }, timeout: '30s' });
      check(res, { 'sin 5xx': (x) => x.status < 500 && x.status !== 0 }, { tipo: 'sin5xx' });
      check(res, { 'menos de 2 s': (x) => x.timings.duration < 2000 }, { tipo: 'rapidez' });
      anotar({ t: 'get', rol, ruta: r.route, status: res.status, ms: Math.round(res.timings.duration), bytes: (res.body || '').length, roles: r.roles, pub: r.pub, err: res.status >= 500 ? String(res.body).slice(0, 200) : undefined });
    }
  }
}
export const handleSummary = resumen('02-lecturas');
