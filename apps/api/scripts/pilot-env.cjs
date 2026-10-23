#!/usr/bin/env node
/**
 * Ejecuta un comando con las variables del entorno AISLADO del piloto
 * (apps/api/.env.pilot, que no se versiona) y SOLO esas: las variables que ya
 * estén en la terminal se reemplazan, y ENV_FILE apunta al mismo archivo para
 * que la API no lea el .env de siempre.
 *
 *   node scripts/pilot-env.cjs node dist/main.js
 *   node scripts/pilot-env.cjs npx prisma db push --skip-generate
 *
 * Antes de ejecutar, comprueba que la base sea local y que su nombre contenga
 * «pilot». Nunca imprime valores.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env.pilot');
if (!fs.existsSync(file)) {
  console.error('Falta apps/api/.env.pilot (ver docs/lpulpo/SETUP_GUIDE.md)');
  process.exit(1);
}
const vars = {};
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) vars[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
}
const db = (() => {
  try {
    const u = new URL(vars.DATABASE_URL || '');
    return { host: u.hostname, name: u.pathname.slice(1) };
  } catch {
    return null;
  }
})();
if (!db || !['127.0.0.1', 'localhost'].includes(db.host) || !/pilot/i.test(db.name)) {
  console.error('DATABASE_URL de .env.pilot no apunta a una base local con «pilot» en el nombre: no se ejecuta nada.');
  process.exit(1);
}
const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('Uso: node scripts/pilot-env.cjs <comando> [args]');
  process.exit(1);
}
const env = { ...process.env, ...vars, ENV_FILE: '.env.pilot' };
const child = spawn(cmd, args, { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
child.on('exit', (code) => process.exit(code ?? 1));
