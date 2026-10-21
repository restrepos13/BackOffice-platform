/**
 * Correos del equipo de BackOffice (SIGNUP_NOTIFY_EMAIL en Dev Tools o .env).
 * Lo usan los avisos de registros, citas y salud de la plataforma.
 */
const DEFAULT_TEAM_EMAIL = 'restrepos591@gmail.com';

export async function teamEmails(prisma: any): Promise<string[]> {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'SIGNUP_NOTIFY_EMAIL' } }).catch(() => null);
  const raw = row?.value?.trim() || process.env.SIGNUP_NOTIFY_EMAIL || DEFAULT_TEAM_EMAIL;
  return [...new Set(String(raw).split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 10);
}

/** ¿Este proceso es el de producción? (Render define RENDER=true) */
export function isProductionHost(): boolean {
  return process.env.RENDER === 'true' || process.env.HEALTH_ENV === 'prod';
}
