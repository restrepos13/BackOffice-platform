// 06 · Volumen de datos: cuánto tarda y cuánto pesa cada pantalla de una empresa con miles de registros.
// Se corre después de las pruebas de carga, que dejan a la empresa de prueba con miles de contactos y conversaciones.
import http from 'k6/http';
import { API, USUARIOS, cab, entrar, anotar, resumen } from './lib/comun.js';
export const options = { vus: 1, iterations: 1 };
const LECTURAS = JSON.parse(open('./datos/lecturas-admin.json')).map((x) => x.ruta).filter((r) => !/pdf|compare\/summary/.test(r));
export default function () {
  const t = entrar(USUARIOS.ADMIN_A).token;
  for (const ruta of LECTURAS) {
    const r = http.get(API + ruta, { headers: cab(t), timeout: '120s', tags: { name: 'GET ' + ruta } });
    anotar({ t: 'volumen', ruta, status: r.status, ms: Math.round(r.timings.duration), kb: Math.round((r.body || '').length / 1024) });
  }
}
export const handleSummary = resumen('06-volumen');
