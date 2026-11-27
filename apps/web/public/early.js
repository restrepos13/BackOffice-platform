/*
 * Corre apenas llega el HTML, antes que la app (CSP: archivo propio, nada en línea).
 *  1. Fuentes de Google sin bloquear el primer pintado (en todas las páginas).
 *  2. En /registro: cuenta «registro_abierto» al instante (así se mide quién se
 *     va mientras carga el resto) y, si la persona toca «Empezar» antes de que
 *     cargue la app, guarda lo escrito: la app lo envía al arrancar.
 */
(function () {
  try {
    var fonts = document.getElementById('bo-fonts');
    if (fonts && fonts.getAttribute('data-href')) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = fonts.getAttribute('data-href');
      document.head.appendChild(l);
    }
  } catch (e) { /* sin fuentes: se ve con las del sistema */ }

  if (!/^\/registro\/?$/.test(location.pathname)) return;

  var KEY = 'bo_signup_session';
  var token = null;
  try {
    token = localStorage.getItem(KEY);
    if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
      var bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      token = Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(36)).slice(-2); }).join('').slice(0, 32);
      localStorage.setItem(KEY, token);
    }
  } catch (e) { token = null; }

  if (token && !/[?&]retomar=/.test(location.search)) {
    try {
      var qs = new URLSearchParams(location.search);
      var body = { session: token, type: 'registro_abierto' };
      var map = { utm_source: 'utmSource', utm_medium: 'utmMedium', utm_campaign: 'utmCampaign', utm_content: 'utmContent', utm_id: 'utmId', fbclid: 'fbclid', g: 'g' };
      for (var k in map) {
        var v = qs.get(k);
        if (v && !/\{\{.*\}\}/.test(v)) body[map[k]] = v.slice(0, k === 'fbclid' ? 255 : 120);
      }
      if (document.referrer) body.referrer = document.referrer.slice(0, 200);
      body.landingPath = (location.pathname + location.search).slice(0, 200);
      fetch('/api/public/signup/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).catch(function () {});
    } catch (e) { /* medición opcional */ }
  }

  // Tocó «Empezar» antes de que cargara la app: no se recarga la página, se guarda y se avisa
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || form.id !== 'signup-contact' || window.__signupReact) return;
    ev.preventDefault();
    window.__signupEarlySubmitted = true;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Un momento…'; }
  }, true);
})();
