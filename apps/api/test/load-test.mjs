/**
 * Prueba de CARGA contra el API vivo: oleadas de peticiones concurrentes.
 * Criterio de éxito: CERO errores 5xx y el proceso sigue vivo — el exceso se
 * responde con 429 (rate limit), que es el comportamiento diseñado, no una caída.
 *
 * Correr: node test/load-test.mjs [total] [concurrencia]
 */
const BASE = process.env.API_URL ?? 'http://localhost:4001/api';

// Contraseñas de las cuentas sembradas: viven en apps/api/.env (SEED_PASSWORD_*).
try { process.loadEnvFile(new URL('../.env', import.meta.url)); } catch {}
function env(name) {
  if (!process.env[name]) throw new Error(`Falta ${name} en apps/api/.env`);
  return process.env[name];
}
const TOTAL = Number(process.argv[2] ?? 600);
const CONCURRENCY = Number(process.argv[3] ?? 60);

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@nexuscatering.co', password: env('SEED_PASSWORD_NEXUS') }),
  });
  const data = await res.json();
  if (!data.token) throw new Error(`login falló: ${res.status}`);
  return data.token;
}

const PATHS = [
  '/orders',
  '/conversations',
  '/customers',
  '/catalog/products',
  '/reports/compare?granularity=week',
  '/ai-usage/company?days=7',
  '/auth/me',
  '/marketing/summary',
];

async function main() {
  console.log(`\nCarga contra ${BASE}: ${TOTAL} peticiones · ${CONCURRENCY} concurrentes\n`);
  const token = await login();

  const latencies = [];
  const counts = { ok: 0, throttled: 0, clientError: 0, serverError: 0, network: 0 };
  let sent = 0;

  async function worker() {
    while (sent < TOTAL) {
      const i = sent++;
      const path = PATHS[i % PATHS.length];
      const start = performance.now();
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        await res.arrayBuffer(); // consumir el cuerpo completo
        latencies.push(performance.now() - start);
        if (res.status < 300) counts.ok++;
        else if (res.status === 429) counts.throttled++;
        else if (res.status < 500) counts.clientError++;
        else counts.serverError++;
      } catch {
        counts.network++;
      }
    }
  }

  const startAll = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - startAll) / 1000;

  latencies.sort((a, b) => a - b);
  const pct = (p) => Math.round(latencies[Math.floor((latencies.length - 1) * p)] ?? 0);

  // ¿El API sigue vivo y respondiendo bien después de la paliza?
  await new Promise((r) => setTimeout(r, 500));
  const alive = await fetch(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  console.log(`Duración: ${elapsed.toFixed(1)} s · ${(TOTAL / elapsed).toFixed(0)} req/s efectivas`);
  console.log(`  2xx OK:        ${counts.ok}`);
  console.log(`  429 throttled: ${counts.throttled}  (rate limit diseñado, no caída)`);
  console.log(`  4xx otros:     ${counts.clientError}`);
  console.log(`  5xx ERRORES:   ${counts.serverError}`);
  console.log(`  red/timeout:   ${counts.network}`);
  console.log(`Latencia ms — p50: ${pct(0.5)} · p95: ${pct(0.95)} · p99: ${pct(0.99)} · max: ${pct(1)}`);
  // 200 = vivo; 429 = vivo Y protegiéndose (esa ruta agotó su cupo del minuto)
  const isAlive = alive.status === 200 || alive.status === 429;
  console.log(`API vivo tras la carga: ${isAlive ? `SÍ (${alive.status})` : `NO (${alive.status})`}`);

  const pass = counts.serverError === 0 && counts.network === 0 && isAlive;
  console.log(`\n════ ${pass ? 'PASÓ' : 'FALLÓ'}: ${counts.serverError} errores 5xx, ${counts.network} caídas de red ════`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
});
