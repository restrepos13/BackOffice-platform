import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import {
  type NavContext, accountItems, activeWorkspace, adsGroups, automationGroups, creativeGroups, groupsFor, isItemActive,
  productOfPath,
} from './navigation';

const ALL: NavContext = {
  products: ['AUTOMATION', 'CREATIVE', 'ADS'],
  modules: ['inbox', 'contacts', 'bots', 'automations', 'analytics', 'billing', 'team', 'orders', 'production', 'delivery', 'agenda', 'campaigns', 'media', 'gerencia', 'marketing', 'reactivation', 'collections', 'salesAudit'],
};
const labels = (groups: ReturnType<typeof automationGroups>) => groups.flatMap((g) => g.items.map((i) => i.label));

describe('Arquitectura de información', () => {
  it('Automation agrupa por tareas y no incluye diseño ni publicidad', () => {
    const groups = automationGroups(ALL);
    expect(groups.map((g) => g.title)).toEqual(['Inicio', 'Atención y canales', 'Ventas y clientes', 'Automatización', 'Operaciones']);
    const all = labels(groups);
    expect(all).toEqual(expect.arrayContaining(['Reportes', 'Conversaciones', 'Contactos', 'Reactivación', 'Cobranza', 'Auditor de ventas', 'Asistentes IA', 'Flujos y reglas', 'Pedidos', 'Agenda', 'Domicilios']));
    // Analítica, reporte a gerencia y oportunidades se unificaron en «Reportes»
    expect(all).not.toEqual(expect.arrayContaining(['Analítica']));
    expect(all).not.toContain('Reporte a gerencia');
    expect(all).not.toContain('Oportunidades');
    expect(all).not.toEqual(expect.arrayContaining(['Mis diseños', 'Calendario', 'Campañas', 'Biblioteca']));
  });

  it('Creative y Ads tienen sus grupos; la biblioteca es la misma en los dos (no hay otra)', () => {
    // Creative diseña; publicar, programar y las oportunidades publicitarias están en Ads (sin duplicados)
    expect(creativeGroups(ALL).map((g) => g.title)).toEqual(['Crear', 'Diseños', 'Marca', 'Biblioteca creativa', 'Contenido']);
    expect(labels(creativeGroups(ALL))).not.toEqual(expect.arrayContaining(['Oportunidades y avance']));
    expect(labels(creativeGroups(ALL)).some((l) => /Calendario|Reglas de publicación/.test(l))).toBe(false);
    expect(adsGroups(ALL).map((g) => g.title)).toEqual(['Resumen publicitario', 'Campañas y cuentas', 'Publicaciones en redes', 'Creatividades y recursos', 'Inteligencia y oportunidades', 'Automatización publicitaria', 'Leads, ventas y atribución']);
    const lib = (gs: ReturnType<typeof adsGroups>) => gs.flatMap((g) => g.items).filter((i) => i.to === '/app/biblioteca');
    expect(lib(creativeGroups(ALL))).toHaveLength(1);
    expect(lib(adsGroups(ALL))).toHaveLength(1);
  });

  it('el tipo de negocio manda: a una constructora no le aparecen pedidos aunque tenga la sección', () => {
    const construction: NavContext = { ...ALL, hides: ['menu', 'production', 'delivery', 'orders', 'media'] };
    const all = labels(automationGroups(construction));
    expect(all).not.toContain('Pedidos');
    expect(all).not.toContain('Clientes');
    expect(all).not.toContain('Domicilios');
    expect(all).toEqual(expect.arrayContaining(['Agenda', 'Contactos', 'Reportes']));
  });

  it('las secciones del rubro mandan: sin pedidos ni campañas no aparecen; los grupos vacíos se quitan', () => {
    const basic: NavContext = { products: ['AUTOMATION'], modules: ['inbox', 'contacts', 'bots'] };
    const all = labels(automationGroups(basic));
    expect(all).not.toContain('Pedidos');
    expect(all).not.toContain('Campañas por WhatsApp');
    expect(all).toContain('Mi negocio');
    expect(labels(creativeGroups({ ...ALL, modules: [] }))).not.toContain('Piezas y redes');
  });

  it('un producto no contratado no tiene menú', () => {
    expect(groupsFor('CREATIVE', { ...ALL, products: ['ADS'] })).toEqual([]);
    expect(groupsFor('ADS', { ...ALL, products: ['ADS'] }).length).toBeGreaterThan(0);
  });

  it('Empresa y cuenta es global; Primeros pasos solo en configuración inicial', () => {
    expect(accountItems({}).map((i) => i.label)).toEqual(['Configuración', 'Equipo', 'Mi plan', 'Facturación', 'Consumo IA']);
    expect(accountItems({ onboarding: true })[0].label).toBe('Primeros pasos');
  });

});

describe('Producto activo según la ruta', () => {
  it('cada ruta pertenece a su producto; lo global y la biblioteca no fuerzan cambio', () => {
    expect(productOfPath('/app/inbox')).toBe('AUTOMATION');
    expect(productOfPath('/app')).toBe('AUTOMATION');
    expect(productOfPath('/app/creative/editor/x')).toBe('CREATIVE');
    expect(productOfPath('/app/marketing')).toBe('CREATIVE');
    expect(productOfPath('/app/ads')).toBe('ADS');
    expect(productOfPath('/platform/dev')).toBe('PLATFORM');
    for (const p of ['/app/settings', '/app/billing', '/app/team', '/app/mi-plan', '/app/usage', '/app/biblioteca', '/app/producto/ads']) expect(productOfPath(p)).toBeNull();
  });

  it('en una ruta global se queda el último producto usado; en la biblioteca, el último entre Creative y Ads', () => {
    const all = ['AUTOMATION', 'CREATIVE', 'ADS'] as const;
    expect(activeWorkspace('/app/settings', [...all], 'ADS')).toBe('ADS');
    expect(activeWorkspace('/app/biblioteca', [...all], 'AUTOMATION')).toBe('CREATIVE');
    expect(activeWorkspace('/app/biblioteca', [...all], 'ADS')).toBe('ADS');
    expect(activeWorkspace('/app/biblioteca', ['ADS'], null)).toBe('ADS');
    // Si el último ya no está contratado, no se muestra
    expect(activeWorkspace('/app/settings', ['CREATIVE'], 'ADS')).toBe('CREATIVE');
  });

  it('marca el ítem correcto, también por pestaña', () => {
    const [dash] = automationGroups(ALL)[0].items;
    expect(isItemActive(dash, '/app', '')).toBe(true);
    expect(isItemActive(dash, '/app/inbox', '')).toBe(false);
    const ops = automationGroups(ALL).find((g) => g.id === 'operaciones')!.items;
    const pedidos = ops.find((i) => i.label === 'Pedidos')!;
    expect(isItemActive(pedidos, '/app/orders', '')).toBe(true);
    expect(isItemActive(pedidos, '/app/orders/reports', '')).toBe(false);
    const cr = creativeGroups(ALL).flatMap((g) => g.items);
    const resultados = cr.find((i) => i.to.endsWith('tab=resultados'))!;
    const crear = cr.find((i) => i.to.endsWith('tab=crear'))!;
    const disenos = cr.find((i) => i.to.endsWith('tab=disenos'))!;
    // «Crear» es la entrada por defecto de Creative
    expect(isItemActive(crear, '/app/creative', '')).toBe(true);
    expect(isItemActive(resultados, '/app/creative', '')).toBe(false);
    expect(isItemActive(resultados, '/app/creative', '?tab=resultados')).toBe(true);
    expect(isItemActive(disenos, '/app/creative', '?tab=disenos')).toBe(true);
    expect(isItemActive(disenos, '/app/creative/editor/abc', '')).toBe(true);
    expect(isItemActive(resultados, '/app/creative/editor/abc', '')).toBe(false);
  });
});

describe('Rutas', () => {
  it('cada opción del menú apunta a una ruta que existe en la app', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const routes = [...app.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
    const matches = (path: string) => routes.some((r) => r === path || new RegExp(`^${r.replace(/:[^/]+/g, '[^/]+')}$`).test(path));
    const items = [
      ...automationGroups(ALL), ...creativeGroups(ALL), ...adsGroups(ALL),
      { id: 'cuenta', title: '', items: accountItems({ onboarding: true }) },
    ].flatMap((g) => g.items);
    for (const i of items) expect([i.to, matches(i.to.split('?')[0])]).toEqual([i.to, true]);
  });
});
