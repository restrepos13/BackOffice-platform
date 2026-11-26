// 03 · Seguridad: sesión obligatoria, permisos por rol, aislamiento entre empresas,
// límites de peticiones, cabeceras y entradas maliciosas. Corre solo en el entorno aislado:
// algunas pruebas INTENTAN escribir o borrar con un rol que no debería poder.
import http from 'k6/http';
import { check, group } from 'k6';
import encoding from 'k6/encoding';
import { API, BASE, RUTAS, USUARIOS, cab, conParams, entrarTodos, anotar, resumen } from './lib/comun.js';

export const options = { vus: 1, iterations: 1, setupTimeout: '120s', summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'] };

const pedir = (verb, url, token, body, ip) => http.request(verb === 'SSE' ? 'GET' : verb, url, verb === 'GET' || verb === 'SSE' ? null : JSON.stringify(body || {}), { headers: cab(token, ip), tags: { name: 'seg' }, timeout: '20s', redirects: 0 });
const lista = (j) => (Array.isArray(j) ? j : j && typeof j === 'object' ? (Object.values(j).find((v) => Array.isArray(v) && v.length && v[0] && v[0].id) || []) : []);

// k6 no garantiza el orden de las claves al leer JSON: se serializa con claves ordenadas para comparar.
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',')}}` : JSON.stringify(v));

export function setup() { return entrarTodos(); }

export default function (s) {
  group('1. sin sesión → 401', () => {
    for (const r of RUTAS.filter((x) => !x.pub)) {
      const res = pedir(r.verb, API + conParams(r.route), null);
      const ok = check(res, { 'sin token responde 401': (x) => x.status === 401 });
      if (!ok) anotar({ t: 'sin-sesion', verb: r.verb, ruta: r.route, status: res.status, archivo: r.file + ':' + r.line });
    }
  });

  group('2. tokens falsos → 401', () => {
    const [h, p] = s.ADMIN_A.token.split('.');
    const payload = JSON.parse(encoding.b64decode(p, 'rawurl', 's'));
    const forja = (hdr, pl, firma) => `${encoding.b64encode(JSON.stringify(hdr), 'rawurl')}.${encoding.b64encode(JSON.stringify(pl), 'rawurl')}.${firma}`;
    const casos = {
      'firma alterada': s.ADMIN_A.token.slice(0, -4) + 'AAAA',
      'alg none': forja({ alg: 'none', typ: 'JWT' }, { ...payload, role: 'SUPER_ADMIN' }, ''),
      'rol escalado con firma vieja': `${h}.${encoding.b64encode(JSON.stringify({ ...payload, role: 'SUPER_ADMIN', companyId: null }), 'rawurl')}.${s.ADMIN_A.token.split('.')[2]}`,
      'basura': 'no-es-un-token',
    };
    for (const [caso, tok] of Object.entries(casos)) {
      const res = pedir('GET', `${API}/auth/me`, tok);
      const ok = check(res, { 'token falso 401': (x) => x.status === 401 });
      anotar({ t: 'token', caso, status: res.status, ok });
    }
    const q = http.get(`${API}/auth/me?token=${s.ADMIN_A.token}&access_token=${s.ADMIN_A.token}`, { headers: cab(null) });
    anotar({ t: 'token', caso: 'token por query string', status: q.status, ok: check(q, { 'token en la URL no vale': (x) => x.status === 401 }) });
  });

  group('3. permisos por rol → 403', () => {
    const PLATAFORMA = ['SUPER_ADMIN,DEV', 'SUPER_ADMIN', '...PLATFORM'];
    const probar = (r, rol, ses) => {
      const res = pedir(r.verb, API + conParams(r.route), ses.token);
      const ok = check(res, { 'rol sin permiso recibe 403': (x) => x.status === 403 });
      if (!ok) anotar({ t: 'rol', rol, verb: r.verb, ruta: r.route, status: res.status, permitidos: r.roles, archivo: r.file + ':' + r.line, cuerpo: String(res.body).slice(0, 160) });
    };
    for (const r of RUTAS.filter((x) => PLATAFORMA.includes(x.roles))) {
      probar(r, 'COMPANY_ADMIN', s.ADMIN_A); probar(r, 'COMPANY_VIEWER', s.VIEWER_A); probar(r, 'COMPANY_AREA', s.AREA_NEXUS);
    }
    for (const r of RUTAS.filter((x) => x.roles === 'SUPER_ADMIN')) probar(r, 'DEV', s.DEV);
    for (const r of RUTAS.filter((x) => x.roles === 'SUPER_ADMIN,DEV,COMPANY_ADMIN')) { probar(r, 'COMPANY_VIEWER', s.VIEWER_A); probar(r, 'COMPANY_AREA', s.AREA_NEXUS); }
    // escritura con rol de solo lectura: todo POST/PUT/PATCH/DELETE con @Roles
    for (const r of RUTAS.filter((x) => !x.pub && x.verb !== 'GET' && x.verb !== 'SSE' && /WRITE/.test(x.roles))) probar(r, 'COMPANY_VIEWER', s.VIEWER_A);
  });

  group('4. aislamiento entre empresas', () => {
    // Para cada recurso con listado y rutas /:id: una empresa víctima lista los suyos y la empresa A
    // intenta leer, editar y borrar uno. Después se confirma que el registro sigue igual.
    const bases = [...new Set(RUTAS.filter((x) => /\/:id$/.test(x.route)).map((x) => x.route.replace(/\/:id$/, '')))]
      .filter((b) => RUTAS.some((x) => x.verb === 'GET' && x.route === b) && !/^\/(platform|dev|public)\b/.test(b));
    const victimas = [['HM Motors', s.ADMIN_B], ['Nexus Catering', s.ADMIN_NEXUS], ['Nova Studio', s.ADMIN_C]];
    for (const base of bases) {
      let probado = false;
      for (const [nombre, vic] of victimas) {
        const lb = pedir('GET', API + base, vic.token);
        if (lb.status !== 200) continue;
        let items; try { items = lista(lb.json()); } catch { continue; }
        const it = items.find((i) => i && i.id); if (!it) continue;
        probado = true;
        const tiene = (verb) => RUTAS.some((x) => x.verb === verb && x.route === base + '/:id');
        const firma = () => { const r = pedir('GET', API + base, vic.token); let l = []; try { l = lista(r.json()); } catch { /* */ } return canon(l.find((i) => i && i.id === it.id) || null); };
        const antes = firma();
        const out = { t: 'aislamiento', recurso: base, victima: nombre, global: it.companyId === undefined || it.companyId === null };
        if (tiene('GET')) { out.leer = pedir('GET', `${API}${base}/${it.id}`, s.ADMIN_A.token).status; out.leerConCompanyId = pedir('GET', `${API}${base}/${it.id}?companyId=${vic.companyId}`, s.ADMIN_A.token).status; }
        for (const verb of ['PATCH', 'PUT', 'DELETE']) if (tiene(verb)) out[verb] = pedir(verb, `${API}${base}/${it.id}`, s.ADMIN_A.token, { name: 'k6-ajeno', title: 'k6-ajeno', companyId: vic.companyId }).status;
        out.sigueIntacto = firma() === antes;
        out.ok = check(out, {
          'otra empresa no puede leer': (o) => o.global || ((o.leer === undefined || o.leer !== 200) && (o.leerConCompanyId === undefined || o.leerConCompanyId !== 200)),
          'otra empresa no puede editar ni borrar': (o) => ['PATCH', 'PUT', 'DELETE'].every((v) => o[v] === undefined || o[v] >= 400),
          'el registro sigue intacto': (o) => o.sigueIntacto,
        });
        anotar(out);
        break;
      }
      if (!probado) anotar({ t: 'aislamiento', recurso: base, nota: 'ninguna empresa de demostración tiene registros: sin probar' });
    }
    // el listado con ?companyId= de otra empresa no debe filtrar datos
    for (const base of ['/contacts', '/conversations', '/automations', '/bots', '/orders', '/customers', '/bookings', '/users', '/integrations', '/billing/invoices', '/knowledge', '/media']) {
      const mio = pedir('GET', API + base, s.ADMIN_A.token), con = pedir('GET', `${API}${base}?companyId=${s.ADMIN_B.companyId}`, s.ADMIN_A.token);
      const filtra = con.status === 200 && String(con.body).includes(s.ADMIN_B.companyId);
      anotar({ t: 'aislamiento-lista', recurso: base, status: con.status, igualAlPropio: con.body === mio.body, ok: check(con, { 'companyId ajeno no cambia el listado': () => !filtra }) });
    }
    // el visor no puede usar companyId para saltar de empresa
    const v = pedir('GET', `${API}/contacts?companyId=${s.ADMIN_B.companyId}`, s.VIEWER_A.token);
    anotar({ t: 'aislamiento-lista', recurso: '/contacts (visor)', status: v.status, ok: check(v, { 'visor no salta de empresa': (x) => !String(x.body).includes(s.ADMIN_B.companyId) }) });
  });

  group('5. límites de peticiones', () => {
    // 5a. inicio de sesión: 10 por minuto por IP (usuario inexistente, para no bloquear a nadie)
    const ip = '172.31.7.7'; let primera429 = 0;
    for (let i = 1; i <= 14; i++) {
      const r = http.post(`${API}/auth/login`, JSON.stringify({ email: 'nadie@k6.invalid', password: 'incorrecta-k6' }), { headers: cab(null, ip) });
      if (r.status === 429 && !primera429) primera429 = i;
    }
    anotar({ t: 'limite', caso: 'login: intentos desde una IP', primera429, ok: check(primera429, { 'login se limita a más tardar al intento 11': (n) => n > 0 && n <= 11 }) });
    // 5a-bis. bloqueo de la cuenta: 5 contraseñas malas (desde IPs distintas) y ni la buena entra
    for (let i = 1; i <= 5; i++) http.post(`${API}/auth/login`, JSON.stringify({ email: USUARIOS.VIEWER_B, password: 'incorrecta-k6' }), { headers: cab(null) });
    const buena = http.post(`${API}/auth/login`, JSON.stringify({ email: USUARIOS.VIEWER_B, password: __ENV.K6_PASSWORD }), { headers: cab(null) });
    const viejo = http.get(`${API}/auth/me`, { headers: cab(s.VIEWER_B.token) });
    anotar({ t: 'limite', caso: 'cuenta bloqueada tras 5 contraseñas malas', statusConLaBuena: buena.status, sesionYaAbiertaSigue: viejo.status, ok: check(buena, { 'la cuenta queda bloqueada': (x) => x.status === 401 }) });
    // 5b. límite global: 200 por minuto por IP
    const ip2 = '172.31.8.8'; let g429 = 0;
    for (let i = 1; i <= 230; i++) { const r = http.get(`${API}/auth/me`, { headers: cab(s.ADMIN_A.token, ip2) }); if (r.status === 429 && !g429) g429 = i; }
    anotar({ t: 'limite', caso: 'global: peticiones desde una IP', primera429: g429, ok: check(g429, { 'límite global salta cerca de 200': (n) => n > 0 && n <= 205 }) });
    // 5c. recuperación de contraseña
    let f429 = 0;
    for (let i = 1; i <= 14; i++) { const r = http.post(`${API}/public/account/password/forgot`, JSON.stringify({ email: `nadie${i}@k6.invalid` }), { headers: cab(null, '172.31.9.9') }); if (r.status === 429 && !f429) f429 = i; }
    anotar({ t: 'limite', caso: 'recuperar contraseña: solicitudes desde una IP', primera429: f429, ok: check(f429, { 'recuperar contraseña está limitado': (n) => n > 0 }) });
  });

  group('6. entradas maliciosas y cabeceras', () => {
    const L = (body, extra) => http.post(`${API}/auth/login`, body, { headers: { ...cab(null), ...(extra || {}) } });
    const casos = {
      'login: inyección NoSQL en email': L(JSON.stringify({ email: { $ne: null }, password: { $ne: null } })),
      'login: inyección NoSQL en password': L(JSON.stringify({ email: USUARIOS.ADMIN_A, password: { $gt: '' } })),
      'login: JSON roto': L('{"email": '),
      'login: cuerpo vacío': L(''),
      'login: contraseña de 1 MB': L(JSON.stringify({ email: USUARIOS.ADMIN_A, password: 'a'.repeat(1024 * 1024) })),
      'login: cuerpo de 12 MB': L(JSON.stringify({ email: USUARIOS.ADMIN_A, password: 'x', relleno: 'a'.repeat(12 * 1024 * 1024) })),
    };
    for (const [caso, r] of Object.entries(casos)) anotar({ t: 'entrada', caso, status: r.status, ms: Math.round(r.timings.duration), ok: check(r, { 'entrada maliciosa: 4xx, nunca 5xx ni 2xx': (x) => x.status >= 400 && x.status < 500 }) });

    // enumeración de usuarios: el mismo mensaje exista o no el correo
    const a = L(JSON.stringify({ email: USUARIOS.ADMIN_B, password: 'incorrecta-k6' })), b = L(JSON.stringify({ email: 'no-existe@k6.invalid', password: 'incorrecta-k6' }));
    anotar({ t: 'entrada', caso: 'login no revela si el correo existe', status: `${a.status}/${b.status}`, msExiste: Math.round(a.timings.duration), msNoExiste: Math.round(b.timings.duration), ok: check(a, { 'mismo estado y mensaje': () => a.status === b.status && a.body === b.body }) });
    const fa = http.post(`${API}/public/account/password/forgot`, JSON.stringify({ email: 'no-existe@k6.invalid' }), { headers: cab(null) });
    anotar({ t: 'entrada', caso: 'recuperar contraseña con correo inexistente', status: fa.status, cuerpo: String(fa.body).slice(0, 120) });

    // asignación masiva: un admin de empresa no puede subirse el rol ni cambiarse de empresa
    const yo = http.get(`${API}/auth/me`, { headers: cab(s.VIEWER_A.token) }).json();
    for (const [verb, ruta] of [['PATCH', `/users/${s.VIEWER_A.id}`], ['PATCH', `/users/${s.ADMIN_A.id}`]]) {
      const r = pedir(verb, API + ruta, s.ADMIN_A.token, { role: 'SUPER_ADMIN', companyId: s.ADMIN_B.companyId });
      const tras = http.get(`${API}/users`, { headers: cab(s.ADMIN_A.token) });
      const escalo = /SUPER_ADMIN/.test(String(tras.body));
      anotar({ t: 'entrada', caso: `asignación masiva ${verb} ${ruta.replace(/\/[a-z0-9]{20,}$/, '/:id')}`, status: r.status, ok: check(r, { 'no se puede auto-asignar SUPER_ADMIN': () => !escalo }) });
    }
    void yo;

    // XSS almacenado: el API debe guardar el texto tal cual (el escape es del front) y no romperse
    const x = pedir('POST', `${API}/contacts`, s.ADMIN_A.token, { name: '<script>alert(1)</script> k6', phone: '+573000000999' });
    anotar({ t: 'entrada', caso: 'contacto con HTML en el nombre', status: x.status, tipo: x.headers['Content-Type'], ok: check(x, { 'responde JSON, no HTML': (r) => /json/.test(r.headers['Content-Type'] || '') }) });
    if (x.status < 300) pedir('DELETE', `${API}/contacts/${x.json('id')}`, s.ADMIN_A.token);

    // archivos sensibles y recorrido de carpetas
    for (const p of ['/.env', '/.git/config', '/api/.env', '/uploads/../.env', '/uploads/..%2f.env', '/api/uploads/..%2f..%2f.env', '/package.json', '/uploads/']) {
      const r = http.get(BASE + p, { headers: cab(null) });
      const fuga = /DATABASE_URL|JWT_SECRET|\[core\]|"dependencies"/.test(String(r.body));
      anotar({ t: 'archivos', ruta: p, status: r.status, ok: check(r, { 'no expone archivos internos': () => !fuga }) });
    }
    // archivos de otra empresa sin sesión
    const up = http.get(`${BASE}/uploads/${s.ADMIN_C.companyId}/`, { headers: cab(null) });
    anotar({ t: 'archivos', ruta: '/uploads/<empresa>/ sin sesión', status: up.status });

    // cabeceras de seguridad y CORS
    const h = http.get(`${API}/health`, { headers: { Origin: 'https://sitio-malicioso.example', 'X-Forwarded-For': '10.9.9.9' } }).headers;
    const tiene = (k) => Object.keys(h).some((x) => x.toLowerCase() === k);
    const val = (k) => h[Object.keys(h).find((x) => x.toLowerCase() === k)] || null;
    anotar({ t: 'cabeceras', nosniff: val('x-content-type-options'), frame: val('x-frame-options'), hsts: val('strict-transport-security'), csp: !!val('content-security-policy'), poweredBy: val('x-powered-by'), corsParaAjeno: val('access-control-allow-origin'),
      ok: check(h, { 'X-Content-Type-Options': () => tiene('x-content-type-options'), 'sin X-Powered-By': () => !tiene('x-powered-by'), 'CORS no acepta orígenes ajenos': () => !val('access-control-allow-origin') || val('access-control-allow-origin') === 'http://localhost:4021' }) });

    // webhooks: sin firma (en local sin META_APP_SECRET se aceptan; en producción deben rechazarse)
    const w = http.post(`${API}/webhooks/whatsapp-cloud`, JSON.stringify({ entry: [] }), { headers: { ...cab(null), 'x-hub-signature-256': 'sha256=falsa' } });
    anotar({ t: 'webhook', caso: 'firma falsa', status: w.status });
  });
}
export const handleSummary = resumen('03-seguridad');
