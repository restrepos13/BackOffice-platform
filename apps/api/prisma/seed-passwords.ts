import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Contraseñas de las cuentas que crean los seeds. Viven SOLO en apps/api/.env
 * (no commiteado) — jamás en el código. Ver .env.example (SEED_PASSWORD_*).
 */
let loaded = false;

function loadEnvFile() {
  loaded = true;
  const file = join(__dirname, '..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export function seedPassword(name: string): string {
  if (!process.env[name] && !loaded) loadEnvFile();
  const value = process.env[name];
  if (!value) throw new Error(`Falta ${name} en apps/api/.env (ver .env.example)`);
  return value;
}
