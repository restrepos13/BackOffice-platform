/** Contraseña aleatoria fuerte (sin caracteres ambiguos: 0/O, 1/l/I). */
export function strongPassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const pick = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint32Array(n)), (v) => chars[v % chars.length]).join('');
  return `BO-${pick(length)}`;
}
