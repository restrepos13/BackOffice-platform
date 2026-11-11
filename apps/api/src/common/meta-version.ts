/**
 * Versión de la Graph / Marketing API de Meta, en un solo lugar.
 * Meta retira versiones viejas (la v24.0 dejó de servir a Marketing el
 * 6-oct-2026): al subir de versión se cambia aquí y aplica a mensajería,
 * publicación, conexiones y publicidad. Cada uso puede fijarse por variable
 * de entorno si hace falta volver atrás sin desplegar código.
 */
export const META_DEFAULT_VERSION = 'v25.0';

export const metaVersion = (override?: string | null) => (override || META_DEFAULT_VERSION).replace(/[^v0-9.]/g, '') || META_DEFAULT_VERSION;
