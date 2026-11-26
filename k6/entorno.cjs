#!/usr/bin/env node
/**
 * Ejecuta un comando con las variables del entorno AISLADO de pruebas de carga
 * (apps/api/.env.k6, que no se versiona) y solo esas. Se niega si la base no es
 * local o su nombre no contiene «pilot» y «k6». Nunca imprime valores.
 *
 *   node k6/entorno.cjs node dist/main.js          (desde cualquier carpeta)
 *   node k6/entorno.cjs k6 run k6/01-humo.js
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const api = path.join(__dirname, '..', 'apps', 'api');
const file = path.join(api, '.env.k6');
if (!fs.existsSync(file)) { console.error('Falta apps/api/.env.k6 (ver k6/README.md)'); process.exit(1); }
const vars = {};
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}
let db = null;
try { const u = new URL(vars.DATABASE_URL || ''); db = { host: u.hostname, name: u.pathname.slice(1) }; } catch { /* inválida */ }
if (!db || !['127.0.0.1', 'localhost'].includes(db.host) || !/pilot/i.test(db.name) || !/k6/i.test(db.name)) {
  console.error('DATABASE_URL de .env.k6 no apunta a la base local de pruebas: no se ejecuta nada.');
  process.exit(1);
}
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('Uso: node k6/entorno.cjs <comando> [args]'); process.exit(1); }
const inApi = !['k6'].includes(cmd);
const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...vars, ENV_FILE: '.env.k6' }, cwd: inApi ? api : path.join(__dirname, '..') });
child.on('exit', (code) => process.exit(code ?? 1));
