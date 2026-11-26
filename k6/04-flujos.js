// 04 · Flujos funcionales de punta a punta, como los haría una persona:
// contactos, mensaje entrante de WhatsApp, conversación con la IA en el simulador, automatizaciones,
// base de conocimiento, respuestas rápidas, clientes, invitaciones, reportes y cierre de sesión.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { API, SLUG_A, USUARIOS, cab, entrar, entrarTodos, anotar, resumen } from './lib/comun.js';

export const options = { vus: 1, iterations: 1, setupTimeout: '120s', summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'], thresholds: { checks: ['rate==1'] } };
export function setup() { return entrarTodos(); }

const J = (r) => { try { return r.json(); } catch { return null; } };
const arr = (j) => (Array.isArray(j) ? j : j && typeof j === 'object' ? (Object.values(j).find((v) => Array.isArray(v)) || []) : []);
const sufijo = `${Date.now()}`.slice(-7);

export default function (s) {
  const A = s.ADMIN_A.token;
  const req = (verb, ruta, body, token = A) => http.request(verb, API + ruta, body === undefined ? null : JSON.stringify(body), { headers: cab(token), tags: { name: `${verb} ${ruta.replace(/\/[a-z0-9]{20,}/g, '/:id').split('?')[0]}` }, timeout: '60s' });
  const paso = (flujo, nombre, r, cond) => { const ok = check(r, { [`${flujo}: ${nombre}`]: cond }); anotar({ t: 'flujo', flujo, paso: nombre, status: r.status, ms: Math.round(r.timings.duration), ok, cuerpo: ok ? undefined : String(r.body).slice(0, 220) }); return ok; };

  group('contactos', () => {
    const c = req('POST', '/contacts', { name: `Prueba k6 ${sufijo}`, phone: `+57300${sufijo}`, email: `k6-${sufijo}@k6.invalid`, tags: ['k6'] });
    if (!paso('contactos', 'crear', c, (r) => r.status === 201 && !!r.json('id'))) return;
    const id = c.json('id');
    paso('contactos', 'aparece en el listado', req('GET', `/contacts?search=${sufijo}`), (r) => r.status === 200 && arr(J(r)).some((x) => x.id === id));
    paso('contactos', 'editar nota y etiquetas', req('PATCH', `/contacts/${id}`, { notes: 'nota k6', tags: ['k6', 'editado'] }), (r) => r.status === 200 && r.json('notes') === 'nota k6');
    paso('contactos', 'el visor no puede editar', req('PATCH', `/contacts/${id}`, { notes: 'visor' }, s.VIEWER_A.token), (r) => r.status === 403);
    paso('contactos', 'borrar', req('DELETE', `/contacts/${id}`), (r) => r.status === 200);
    paso('contactos', 'ya no aparece', req('GET', `/contacts?search=${sufijo}`), (r) => r.status === 200 && !arr(J(r)).some((x) => x.id === id));
  });

  group('mensaje entrante de WhatsApp', () => {
    const tel = `57311${sufijo}`, texto = `Hola, quiero agendar una cita (k6 ${sufijo})`;
    const cuerpo = { object: 'whatsapp_business_account', entry: [{ id: 'k6', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'k6' }, contacts: [{ wa_id: tel, profile: { name: `Cliente k6 ${sufijo}` } }], messages: [{ from: tel, id: `wamid.k6.${sufijo}`, timestamp: `${Math.floor(Date.now() / 1000)}`, type: 'text', text: { body: texto } }] } }] }] };
    const w = http.post(`${API}/webhooks/${SLUG_A}/whatsapp`, JSON.stringify(cuerpo), { headers: cab(null), tags: { name: 'POST /webhooks/:slug/whatsapp' } });
    paso('whatsapp', 'el webhook acepta el mensaje', w, (r) => r.status < 300);
    const rep = http.post(`${API}/webhooks/${SLUG_A}/whatsapp`, JSON.stringify(cuerpo), { headers: cab(null), tags: { name: 'POST /webhooks/:slug/whatsapp' } });
    paso('whatsapp', 'el mismo mensaje repetido no rompe', rep, (r) => r.status < 300);
    let conv = null, lista;
    for (let i = 0; i < 10 && !conv; i++) { sleep(0.5); lista = req('GET', '/conversations'); conv = arr(J(lista)).find((x) => JSON.stringify(x).includes(sufijo)); }
    paso('whatsapp', 'la conversación aparece en la bandeja', lista, () => !!conv);
    if (conv) {
      const d = req('GET', `/conversations/${conv.id}`);
      const veces = (String(d.body).match(new RegExp(`k6 ${sufijo}\\)`, 'g')) || []).length;
      paso('whatsapp', 'el mensaje quedó guardado una sola vez (sin duplicar)', d, (r) => r.status === 200 && veces === 1);
      sleep(3);
      const d2 = J(req('GET', `/conversations/${conv.id}`));
      const msgs = arr(d2 && d2.messages ? d2.messages : d2);
      anotar({ t: 'nota', flujo: 'whatsapp', mensajesEnLaConversacion: msgs.length, autores: msgs.map((m) => m.author || m.direction || m.role).join(','), nota: 'sin clave de IA en este entorno no se espera respuesta automática' });
    }
    const otra = http.post(`${API}/webhooks/empresa-que-no-existe/whatsapp`, JSON.stringify(cuerpo), { headers: cab(null) });
    paso('whatsapp', 'empresa desconocida no rompe', otra, (r) => r.status < 500);
  });

  group('simulador de conversación', () => {
    const r = req('POST', '/engine/simulate', { phone: `+57312${sufijo}`, name: 'Simulado k6', content: 'Hola, ¿qué horarios tienen?', reset: true });
    paso('simulador', 'responde sin romperse (sin IA configurada)', r, (x) => x.status < 500);
    anotar({ t: 'nota', flujo: 'simulador', status: r.status, respuesta: String(r.body).slice(0, 260) });
  });

  group('automatizaciones', () => {
    paso('automatizaciones', 'catálogo de disparadores y acciones', req('GET', '/automations/catalog'), (r) => r.status === 200);
    const l = req('GET', '/automations'); const autos = arr(J(l));
    paso('automatizaciones', 'listado con las de demostración', l, (r) => r.status === 200 && autos.length > 0);
    anotar({ t: 'nota', flujo: 'automatizaciones', deDemostracion: autos.length, deFormatoAntiguo: autos.filter((x) => x.legacy).length });
    const def = {
      trigger: { type: 'contact.created' },
      conditions: { match: 'all', rules: [{ field: 'contact.channel', op: 'eq', value: 'WHATSAPP' }] },
      actions: [{ type: 'add_tag', config: { tag: `auto-k6-${sufijo}` } }, { type: 'log_activity', config: { text: 'Bienvenida registrada por k6' } }],
    };
    paso('automatizaciones', 'una definición vacía se rechaza con el detalle', req('POST', '/automations/simulate', { definition: {}, sample: {} }), (r) => r.status === 400 && /disparador/.test(String(r.body)));
    paso('automatizaciones', 'simular con datos de ejemplo', req('POST', '/automations/simulate', { definition: def, sample: { 'contact.channel': 'WHATSAPP', 'contact.name': 'Ana' } }), (r) => r.status < 300);
    const nueva = req('POST', '/automations', { name: `Automatización k6 ${sufijo}`, definition: def });
    if (!paso('automatizaciones', 'crear', nueva, (r) => r.status === 201 && !!r.json('id'))) return;
    const id = nueva.json('id');
    paso('automatizaciones', 'un borrador no se puede pausar', req('POST', `/automations/${id}/status`, { status: 'PAUSED' }), (r) => r.status === 400);
    paso('automatizaciones', 'activar', req('POST', `/automations/${id}/status`, { status: 'ACTIVE' }), (r) => r.status < 300);
    const c = req('POST', '/contacts', { name: `Disparo k6 ${sufijo}`, phone: `+57314${sufijo}`, channel: 'WHATSAPP' });
    paso('automatizaciones', 'crear un contacto que la dispara', c, (r) => r.status === 201);
    let etiquetado = false, det;
    for (let i = 0; i < 16 && !etiquetado; i++) { sleep(0.5); det = req('GET', `/contacts?search=Disparo%20k6%20${sufijo}`); etiquetado = String(det.body).includes(`auto-k6-${sufijo}`); }
    paso('automatizaciones', 'la automatización corrió sola y etiquetó el contacto', det, () => etiquetado);
    const runs = req('GET', `/automations/runs?automationId=${id}`);
    paso('automatizaciones', 'la ejecución quedó en el historial', runs, (r) => r.status === 200 && String(r.body).includes(id));
    paso('automatizaciones', 'pausar', req('POST', `/automations/${id}/status`, { status: 'PAUSED' }), (r) => r.status < 300);
    paso('automatizaciones', 'una activada no se borra (conserva historial)', req('DELETE', `/automations/${id}`), (r) => r.status === 400);
    paso('automatizaciones', 'archivar', req('POST', `/automations/${id}/status`, { status: 'ARCHIVED' }), (r) => r.status < 300);
    if (c.status === 201) req('DELETE', `/contacts/${c.json('id')}`);
  });

  group('base de conocimiento', () => {
    const k = req('POST', '/knowledge/text', { title: `Horarios k6 ${sufijo}`, content: `Atendemos de lunes a viernes de 8 a 18. Código ${sufijo}.`, text: `Atendemos de lunes a viernes de 8 a 18. Código ${sufijo}.` });
    paso('conocimiento', 'agregar texto', k, (r) => r.status === 201);
    paso('conocimiento', 'buscar', req('POST', '/knowledge/search', { query: 'horarios de atención' }), (r) => r.status < 300);
    const l = arr(J(req('GET', '/knowledge'))); const mio = l.find((x) => JSON.stringify(x).includes(sufijo));
    if (mio) paso('conocimiento', 'borrar', req('DELETE', `/knowledge/${mio.id}`), (r) => r.status === 200);
  });

  group('respuestas rápidas', () => {
    const q = req('POST', '/quick-replies', { title: `Saludo k6 ${sufijo}`, shortcut: `k6${sufijo}`, content: 'Hola, gracias por escribir.', body: 'Hola, gracias por escribir.', text: 'Hola, gracias por escribir.' });
    if (paso('respuestas rápidas', 'crear', q, (r) => r.status === 201)) paso('respuestas rápidas', 'borrar', req('DELETE', `/quick-replies/${q.json('id')}`), (r) => r.status === 200);
  });

  group('pedidos y clientes (Nexus)', () => {
    const N = s.ADMIN_NEXUS.token;
    const c = req('POST', '/customers', { name: `Cliente k6 ${sufijo}`, phone: `+57313${sufijo}` }, N);
    if (paso('pedidos', 'crear cliente', c, (r) => r.status === 201)) paso('pedidos', 'borrar cliente', req('DELETE', `/customers/${c.json('id')}`, undefined, N), (r) => r.status === 200);
    const o = arr(J(req('GET', '/orders', undefined, N)));
    if (o[0]) {
      paso('pedidos', 'detalle de un pedido', req('GET', `/orders/${o[0].id}`, undefined, N), (r) => r.status === 200);
      paso('pedidos', 'PDF del pedido', req('GET', `/orders/${o[0].id}/pdf`, undefined, N), (r) => r.status === 200 && /pdf/.test(r.headers['Content-Type'] || ''));
    }
    paso('pedidos', 'vista del área de cocina', req('GET', '/orders/area-view', undefined, s.AREA_NEXUS.token), (r) => r.status === 200);
    paso('pedidos', 'cocina no ve clientes', req('GET', '/customers', undefined, s.AREA_NEXUS.token), (r) => r.status === 403);
    const menu = http.get(`${API}/public/menu/nexus`, { headers: cab(null), tags: { name: 'GET /public/menu/:slug' } });
    paso('pedidos', 'menú público', menu, (r) => r.status === 200 || r.status === 404);
  });

  group('equipo e invitaciones', () => {
    const i = req('POST', '/users/invitations', { email: `invitado-${sufijo}@k6.invalid`, name: 'Invitado k6', role: 'COMPANY_VIEWER' });
    if (paso('equipo', 'invitar a alguien', i, (r) => r.status === 201)) {
      const l = arr(J(req('GET', '/users/invitations'))); const inv = l.find((x) => JSON.stringify(x).includes(sufijo));
      paso('equipo', 'la invitación no expone el token', req('GET', '/users/invitations'), (r) => !/"token":"[^"]{10,}/.test(String(r.body)));
      if (inv) paso('equipo', 'revocar la invitación', req('DELETE', `/users/invitations/${inv.id}`), (r) => r.status === 200);
    }
    const sup = req('POST', '/users/invitations', { email: `super-${sufijo}@k6.invalid`, name: 'x', role: 'SUPER_ADMIN' });
    paso('equipo', 'no se puede invitar a alguien como SUPER_ADMIN', sup, (r) => r.status >= 400);
  });

  group('reportes y exportación', () => {
    paso('reportes', 'reporte diario en PDF', req('GET', '/reports/daily/pdf'), (r) => r.status === 200 && /pdf/.test(r.headers['Content-Type'] || ''));
    paso('reportes', 'secciones de exportación de datos', req('GET', '/company/data-export/sections'), (r) => r.status === 200);
    const claves = Object.keys(J(req('GET', '/company/data-export/sections')) || {});
    const pdf = req('GET', `/company/data-export/pdf?sections=${claves.join(',')}`);
    paso('reportes', 'exportación de datos (Ley 1581) en PDF', pdf, (r) => r.status === 200 && /pdf/.test(r.headers['Content-Type'] || ''));
  });

  group('registro público', () => {
    const cat = http.get(`${API}/public/setup/catalog`, { headers: cab(null) });
    paso('registro', 'catálogo de productos', cat, (r) => r.status === 200);
    const ev = http.post(`${API}/public/setup/evaluate`, JSON.stringify({ setup: {} }), { headers: cab(null) });
    paso('registro', 'evaluar una configuración vacía no rompe', ev, (r) => r.status < 500);
    const pv = http.post(`${API}/public/signup/preview`, JSON.stringify({}), { headers: cab(null) });
    paso('registro', 'vista previa vacía no rompe', pv, (r) => r.status < 500);
    const su = http.post(`${API}/public/signup`, JSON.stringify({}), { headers: cab(null) });
    paso('registro', 'registro vacío se rechaza con 4xx', su, (r) => r.status >= 400 && r.status < 500);
    anotar({ t: 'nota', flujo: 'registro', evaluate: ev.status, preview: pv.status, signup: su.status, msg: String(su.body).slice(0, 160) });
  });

  group('cierre de sesión', () => {
    const v = entrar(USUARIOS.VIEWER_B);
    paso('sesión', 'la sesión sirve', req('GET', '/auth/me', undefined, v.token), (r) => r.status === 200);
    paso('sesión', 'cerrar sesión', req('POST', '/auth/logout', {}, v.token), (r) => r.status < 300);
    paso('sesión', 'el token ya no sirve después de salir', req('GET', '/auth/me', undefined, v.token), (r) => r.status === 401);
  });
}
export const handleSummary = resumen('04-flujos');
