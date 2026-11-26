// 01 · Humo: ¿está vivo todo lo básico? Salud, páginas públicas, API pública e inicio de sesión de cada rol.
import http from 'k6/http';
import { check, group } from 'k6';
import { API, BASE, USUARIOS, cab, entrar, anotar, resumen } from './lib/comun.js';

export const options = { vus: 1, iterations: 1, summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'], thresholds: { checks: ['rate==1'] } };

const PAGINAS = ['/', '/automatizacion-de-whatsapp', '/automatizacion-de-procesos', '/crm-con-whatsapp', '/calculadora-de-ahorro', '/contacto', '/privacidad', '/terminos', '/eliminacion-de-datos', '/robots.txt', '/sitemap.xml', '/llms.txt', '/favicon.svg', '/site.webmanifest'];
const PUBLICAS = ['/health', '/public/plans', '/public/setup/catalog', '/public/terms'];

export default function () {
  group('salud', () => {
    const r = http.get(`${API}/health`);
    check(r, { 'health 200': (x) => x.status === 200, 'health ok:true': (x) => x.json('ok') === true });
  });
  group('páginas públicas', () => {
    for (const p of PAGINAS) {
      const r = http.get(BASE + p, { tags: { name: 'web ' + p } });
      const ok = check(r, { [`web ${p} 200`]: (x) => x.status === 200, [`web ${p} con contenido`]: (x) => (x.body || '').length > 100 });
      const titulo = ((r.body || '').match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      anotar({ t: 'web', ruta: p, status: r.status, ms: Math.round(r.timings.duration), bytes: (r.body || '').length, titulo, ok });
    }
    // páginas del sitemap (guías y sectores)
    const sm = http.get(BASE + '/sitemap.xml').body || '';
    const urls = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''));
    for (const p of urls) {
      const r = http.get(BASE + (p || '/'), { tags: { name: 'web sitemap' } });
      const ok = check(r, { 'página del sitemap 200': (x) => x.status === 200 });
      anotar({ t: 'sitemap', ruta: p || '/', status: r.status, ms: Math.round(r.timings.duration), ok });
    }
    const r404 = http.get(BASE + '/esta-pagina-no-existe-k6');
    anotar({ t: 'web404', status: r404.status, noindex: /noindex/.test(r404.body || '') });
  });
  group('API pública', () => {
    for (const p of PUBLICAS) {
      const r = http.get(API + p, { headers: cab(null), tags: { name: 'GET ' + p } });
      const ok = check(r, { [`${p} 200`]: (x) => x.status === 200 });
      anotar({ t: 'publica', ruta: p, status: r.status, ms: Math.round(r.timings.duration), ok });
    }
  });
  group('inicio de sesión por rol', () => {
    for (const [rol, email] of Object.entries(USUARIOS)) {
      const s = entrar(email);
      const me = http.get(`${API}/auth/me`, { headers: cab(s.token), tags: { name: 'GET /auth/me' } });
      const ok = check(me, { [`${rol} entra y /auth/me 200`]: (x) => x.status === 200, [`${rol} es quien dice`]: (x) => x.json('email') === email || x.json('user.email') === email });
      anotar({ t: 'login', rol, role: s.role, status: me.status, ok });
    }
  });
}
export const handleSummary = resumen('01-humo');
