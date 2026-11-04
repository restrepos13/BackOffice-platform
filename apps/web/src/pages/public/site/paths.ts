/**
 * Rutas de las páginas de content.ts. Viven aparte para que el paquete
 * principal (App.tsx) registre las rutas sin cargar todo el texto.
 * site.test.ts verifica que coincidan con PAGES y con vercel.json.
 */
export const SITE_PAGE_PATHS = [
  '/automatizacion-de-whatsapp',
  '/automatizacion-de-procesos',
  '/crm-con-whatsapp',
  '/sectores/restaurantes-y-domicilios',
  '/sectores/servicios-con-citas',
  '/sectores/tiendas-y-ventas',
  '/sectores/inmobiliarias-y-proyectos',
  '/calculadora-de-ahorro',
  '/guias/como-automatizar-whatsapp-de-tu-negocio',
  '/guias/cuanto-cuesta-atender-whatsapp-a-mano',
];
