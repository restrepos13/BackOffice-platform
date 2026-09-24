/**
 * E2E de SEGURIDAD contra el API VIVO (http://localhost:4001/api).
 * Ataques multi-tenant reales por HTTP (guards incluidos), fuga de secretos,
 * mínimo privilegio del rol de área, headers, SSE y rate limiting.
 *
 * Requiere: API corriendo + seeds (pnpm db:seed y pnpm db:seed:nexus).
 * Correr:   node test/e2e-security.mjs
 * El rate-limit corre AL FINAL (consume el cupo de login por IP).
 */
const BASE = process.env.API_URL ?? 'http://localhost:4001/api';

const ACCOUNTS = {
  attacker: { email: 'admin@empresa-prueba.com', password: 'SEED_PASSWORD_EMPRESA_PRUEBA' },
  victim: { email: 'admin@nexuscatering.co', password: 'SEED_PASSWORD_NEXUS' },
  area: { email: 'cocina@nexuscatering.co', password: 'SEED_PASSWORD_NEXUS' },
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* respuestas no-JSON */
  }
  return { status: res.status, data, headers: res.headers };
}

async function login(account) {
  const { status, data } = await api('POST', '/auth/login', { body: account });
  if (status !== 201 && status !== 200) {
    throw new Error(`login ${account.email} → ${status}: ${JSON.stringify(data)}`);
  }
  return data.token;
}

const denied = (status) => status === 403 || status === 404;

async function main() {
  console.log(`\nE2E de seguridad contra ${BASE}\n`);

  /* ─── Sesiones ─── */
  const attacker = await login(ACCOUNTS.attacker);
  const victim = await login(ACCOUNTS.victim);
  const area = await login(ACCOUNTS.area);

  /* ─── Recolectar IDs del tenant víctima (con SU token) ─── */
  const [orders, convos, customers, products, areas, companies] = await Promise.all([
    api('GET', '/orders', { token: victim }),
    api('GET', '/conversations', { token: victim }),
    api('GET', '/customers', { token: victim }),
    api('GET', '/catalog/products', { token: victim }),
    api('GET', '/catalog/areas', { token: victim }),
    api('GET', '/companies', { token: victim }),
  ]);
  const order = orders.data?.[0];
  const item = order?.items?.[0];
  const convo = convos.data?.[0];
  const message = convo?.messages?.[0];
  const customer = customers.data?.[0];
  const product = products.data?.[0];
  const areaRow = areas.data?.[0];
  const victimCompany = companies.data?.[0];
  if (!order || !convo || !customer || !product || !victimCompany) {
    throw new Error('Faltan datos de Nexus: corre pnpm db:seed:nexus primero');
  }

  /* ─── 1. Autenticación básica y headers ─── */
  console.log('1) Autenticación y headers');
  {
    const noToken = await api('GET', '/orders');
    check('sin token → 401', noToken.status === 401);
    const badToken = await api('GET', '/orders', { token: 'x.y.z' });
    check('token inválido → 401', badToken.status === 401);
    const res = await fetch(`${BASE}/auth/login`, { method: 'OPTIONS' });
    check(
      'helmet activo (x-content-type-options)',
      res.headers.get('x-content-type-options') === 'nosniff' ||
        (await api('GET', '/orders')).headers.get('x-content-type-options') === 'nosniff',
    );
    const wrongPass = await api('POST', '/auth/login', {
      body: { email: ACCOUNTS.victim.email, password: 'incorrecta-123' },
    });
    const noUser = await api('POST', '/auth/login', {
      body: { email: 'fantasma@nadie.co', password: 'incorrecta-123' },
    });
    check('login fallido → 401', wrongPass.status === 401);
    check(
      'anti-enumeración: mismo mensaje para cuenta inexistente y contraseña mala',
      wrongPass.data?.message === noUser.data?.message,
      `${wrongPass.data?.message} vs ${noUser.data?.message}`,
    );
  }

  /* ─── 2. Ataques multi-tenant (atacante = Empresa de Prueba) ─── */
  console.log('2) Ataques multi-tenant');
  const attacks = [
    ['GET pedido ajeno', 'GET', `/orders/${order.id}`],
    ['PATCH pedido ajeno', 'PATCH', `/orders/${order.id}`, { observations: 'pwned' }],
    ['POST estado de pedido ajeno', 'POST', `/orders/${order.id}/status`, { status: 'cancelado', reason: 'x' }],
    ...(item ? [['POST ítem ajeno listo', 'POST', `/orders/items/${item.id}/ready`]] : []),
    ['GET conversación ajena', 'GET', `/conversations/${convo.id}`],
    ['POST mensaje en conversación ajena', 'POST', `/conversations/${convo.id}/messages`, { content: 'inyectado' }],
    ['PATCH modo de conversación ajena', 'PATCH', `/conversations/${convo.id}/mode`, { mode: 'HUMAN' }],
    ...(message ? [['GET archivo de mensaje ajeno', 'GET', `/conversations/messages/${message.id}/file`]] : []),
    ['PATCH cliente ajeno', 'PATCH', `/customers/${customer.id}`, { name: 'pwned' }],
    ['DELETE cliente ajeno', 'DELETE', `/customers/${customer.id}`],
    ['PATCH producto ajeno', 'PATCH', `/catalog/products/${product.id}`, { name: 'pwned' }],
    ['DELETE producto ajeno', 'DELETE', `/catalog/products/${product.id}`],
    ...(areaRow ? [['PATCH área ajena', 'PATCH', `/catalog/areas/${areaRow.id}`, { name: 'pwned' }]] : []),
    ['GET empresa ajena', 'GET', `/companies/${victimCompany.id}`],
    ['PATCH empresa ajena', 'PATCH', `/companies/${victimCompany.id}`, { name: 'pwned' }],
  ];
  for (const [name, method, path, body] of attacks) {
    const res = await api(method, path, { token: attacker, body });
    check(`${name} → ${res.status}`, denied(res.status), JSON.stringify(res.data).slice(0, 80));
  }

  // Listados escopados en silencio: pedir companyId ajeno devuelve LO PROPIO
  {
    const list = await api('GET', `/orders?companyId=${victimCompany.id}`, { token: attacker });
    check(
      'GET /orders?companyId=ajena → 0 pedidos de la víctima',
      list.status === 200 && Array.isArray(list.data) &&
        !list.data.some((o) => o.companyId === victimCompany.id),
    );
    const daily = await api('GET', `/reports/daily?companyId=${victimCompany.id}`, { token: attacker });
    check(
      'GET /reports/daily?companyId=ajena → reporte del PROPIO tenant',
      daily.status === 200 && daily.data?.companyId !== victimCompany.id,
    );
    const cal = await api('GET', `/orders/calendar?companyId=${victimCompany.id}`, { token: attacker });
    check(
      'GET calendario con companyId ajeno → sin datos de la víctima',
      cal.status === 200 &&
        !(cal.data?.days ?? []).some((d) => d.orders?.some((o) => o.companyId === victimCompany.id)),
    );
  }

  /* ─── 3. Fuga de secretos ─── */
  console.log('3) Secretos');
  {
    const integrations = await api('GET', '/integrations', { token: victim });
    const raw = JSON.stringify(integrations.data ?? '');
    check('las líneas jamás exponen authToken/authTokenEnc', !/authToken/i.test(raw), 'campo presente');
    const company = await api('GET', `/companies/${victimCompany.id}`, { token: victim });
    const compRaw = JSON.stringify(company.data ?? '');
    check(
      'la empresa jamás expone la llave DeepInfra completa',
      !/deepinfraApiKey"\s*:\s*"[^"]{12,}/.test(compRaw),
    );
  }

  /* ─── 4. Rol de área: mínimo privilegio ─── */
  console.log('4) Rol de área (COMPANY_AREA)');
  {
    const blocked = [
      ['bandeja', 'GET', '/conversations'],
      ['pedidos', 'GET', '/orders'],
      ['detalle de pedido', 'GET', `/orders/${order.id}`],
      ['clientes', 'GET', '/customers'],
      ['catálogo', 'GET', '/catalog/products'],
      ['reportes', 'GET', '/reports/daily'],
      ['consumo', 'GET', '/ai-usage/company'],
      ['contactos', 'GET', '/contacts'],
      ['equipo', 'GET', '/users'],
    ];
    for (const [name, method, path] of blocked) {
      const res = await api(method, path, { token: area });
      check(`área bloqueada en ${name} → ${res.status}`, res.status === 403);
    }
    const view = await api('GET', '/orders/area-view', { token: area });
    check('área SÍ entra a su vista', view.status === 200 && view.data?.area?.name);
    check(
      'la vista de cocina NO trae direcciones de entrega',
      !(view.data?.items ?? []).some((i) => i.deliveryAddress),
    );
    const me = await api('GET', '/auth/me', { token: area });
    check('área puede ver su propia cuenta', me.status === 200);
  }

  /* ─── 5. SSE: aislamiento del stream ─── */
  console.log('5) SSE');
  await (async () => {
    // El atacante pide el stream "de" la víctima: queda clavado a SU empresa
    const controller = new AbortController();
    const events = [];
    const streamDone = fetch(
      `${BASE}/events/stream?token=${attacker}&companyId=${victimCompany.id}`,
      { signal: controller.signal },
    )
      .then(async (res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          events.push(decoder.decode(value));
        }
      })
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));
    // La víctima genera un evento en SU tenant
    await api('POST', '/events/typing', {
      token: victim, body: { conversationId: convo.id },
    });
    await new Promise((r) => setTimeout(r, 1200));
    controller.abort();
    await streamDone;
    const all = events.join('');
    check('el stream conecta (hello)', all.includes('"ok":true'));
    check('el atacante NO recibe eventos del tenant víctima', !all.includes('typing'));

    const areaStream = await fetch(`${BASE}/events/stream?token=${area}`);
    check('rol de área sin stream → 403', areaStream.status === 403);
    areaStream.body?.cancel?.();
    const badStream = await fetch(`${BASE}/events/stream?token=basura`);
    check('stream con token inválido → 401', badStream.status === 401);
    badStream.body?.cancel?.();
  })();

  /* ─── 6. Rate limiting (al final: consume el cupo por IP) ─── */
  console.log('6) Rate limiting');
  {
    let got429 = false;
    for (let i = 0; i < 12; i++) {
      const res = await api('POST', '/auth/login', {
        body: { email: `nadie${i}@nadie.co`, password: 'incorrecta-123' },
      });
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    check('login limitado por IP (429 antes de 12 intentos)', got429);
  }

  /* ─── Resumen ─── */
  console.log(`\n════ RESULTADO: ${passed} OK · ${failed} FALLARON ════`);
  if (failures.length) {
    console.log('Fallas:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(2);
});
