import { StaticRouter } from 'react-router-dom';
import App from './App';
import { Root, createQueryClient, type SsrData } from './Root';
import { CIUDAD, EMAIL, WA_NUMBER, WA_TEXT } from './pages/public/public-info';
import { GUIDES, HOME, HOME_FAQ, PAGES, SECTORS, SOLUTIONS, type Faq } from './pages/public/site/content';
import { SITE_NAME, SITE_URL, type SeoMeta } from './pages/public/site/seo';
import type { PublicPlans } from './pages/public/Landing';

export { SITE_URL };

/**
 * Entrada del prerender (scripts/prerender.mjs la compila con `vite build --ssr`).
 * Por cada página pública entrega: el árbol de React (el mismo de main.tsx,
 * con StaticRouter), sus etiquetas de búsqueda y sus datos estructurados
 * (schema.org), más el contenido de sitemap.xml y llms.txt.
 */

export interface PrerenderPage extends SeoMeta {
  /** Módulo de la página en el manifiesto de Vite (para precargar su código) */
  module: string;
  jsonLd: object[];
  priority: number;
}

const ORG_ID = `${SITE_URL}/#organizacion`;
const SITE_ID = `${SITE_URL}/#sitio`;
const APP_ID = `${SITE_URL}/#software`;
const abs = (path: string) => `${SITE_URL}${path === '/' ? '/' : path}`;

const LEGAL: SeoMeta[] = [
  { path: '/privacidad', title: 'Política de privacidad — BackOffice', description: 'Qué datos trata BackOffice, para qué, con qué permisos de Meta, Google y TikTok, cuánto tiempo se guardan y cómo ejercer tus derechos según la Ley 1581 de 2012.' },
  { path: '/terminos', title: 'Términos y condiciones — BackOffice', description: 'Condiciones de uso de BackOffice, software en la nube para automatizar la atención por WhatsApp y los procesos de un negocio.' },
  { path: '/eliminacion-de-datos', title: 'Eliminación de datos — BackOffice', description: 'Cómo desconectar tus cuentas y pedir la eliminación de tus datos en BackOffice.' },
  { path: '/contacto', title: 'Contacto — BackOffice', description: 'Escríbenos por WhatsApp o correo para conocer BackOffice, resolver dudas o pedir soporte. Medellín, Colombia.' },
];

const organization = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: SITE_NAME,
  url: `${SITE_URL}/`,
  logo: `${SITE_URL}/logo.png`,
  image: `${SITE_URL}/og.png`,
  description: HOME.description,
  email: EMAIL,
  telephone: WA_TEXT.replace(/\s/g, ''),
  areaServed: { '@type': 'Country', name: 'Colombia' },
  address: { '@type': 'PostalAddress', addressLocality: CIUDAD.split(',')[0], addressRegion: 'Antioquia', addressCountry: 'CO' },
  contactPoint: { '@type': 'ContactPoint', contactType: 'sales', telephone: `+${WA_NUMBER}`, email: EMAIL, availableLanguage: ['es'], url: `https://wa.me/${WA_NUMBER}` },
  knowsAbout: ['Automatización de WhatsApp', 'Automatización de procesos', 'CRM', 'Chatbots con inteligencia artificial', 'Atención al cliente', 'Pedidos y domicilios', 'Agenda de citas', 'Cobranza'],
};

const website = { '@type': 'WebSite', '@id': SITE_ID, url: `${SITE_URL}/`, name: SITE_NAME, inLanguage: 'es-CO', publisher: { '@id': ORG_ID } };

function software(plans?: PublicPlans) {
  const prices = (plans?.plans ?? []).flatMap((p) => [p.priceSelf, p.priceManaged]).filter((n) => n > 0);
  return {
    '@type': 'SoftwareApplication',
    '@id': APP_ID,
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    applicationCategory: 'BusinessApplication',
    applicationSubCategory: 'CRM y automatización de WhatsApp',
    operatingSystem: 'Web',
    inLanguage: 'es-CO',
    description: HOME.description,
    publisher: { '@id': ORG_ID },
    featureList: [
      'Asistente de IA para WhatsApp con paso a una persona',
      'Bandeja compartida con varios usuarios por número',
      'Contactos, embudo comercial y seguimiento',
      'Pedidos, catálogo y domicilios con seguimiento en vivo',
      'Agenda de citas y reservas sin dobles reservas',
      'Cobranza y reactivación de clientes',
      'Campañas y automatizaciones por WhatsApp',
      'Reportes para el dueño o gerente',
      'Diseños con la marca del negocio (Creative)',
      'Resultados de cuentas publicitarias (Ads)',
    ],
    ...(prices.length
      ? { offers: { '@type': 'AggregateOffer', priceCurrency: 'COP', lowPrice: Math.min(...prices), highPrice: Math.max(...prices), offerCount: plans!.plans.length, url: `${SITE_URL}/#planes` } }
      : {}),
  };
}

const faqPage = (path: string, faq: Faq[]) => ({
  '@type': 'FAQPage',
  '@id': `${abs(path)}#preguntas`,
  mainEntity: faq.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});

const breadcrumbs = (items: Array<{ name: string; path: string }>) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: abs(it.path) })),
});

const webPage = (m: SeoMeta, type = 'WebPage') => ({
  '@type': type,
  '@id': `${abs(m.path)}#pagina`,
  url: abs(m.path),
  name: m.title,
  description: m.description,
  inLanguage: 'es-CO',
  isPartOf: { '@id': SITE_ID },
  about: { '@id': APP_ID },
});

const SECTION = { solucion: 'Soluciones', sector: 'Sectores', guia: 'Guías', herramienta: 'Herramientas' } as const;

/** Todas las páginas que se escriben como HTML al compilar. */
export function pages(plans?: PublicPlans): PrerenderPage[] {
  const home: PrerenderPage = {
    ...HOME,
    module: 'src/pages/public/Landing.tsx',
    priority: 1,
    jsonLd: [organization, website, software(plans), webPage(HOME), faqPage('/', HOME_FAQ)],
  };
  const content: PrerenderPage[] = PAGES.map((p) => ({
    path: p.path,
    title: p.title,
    description: p.description,
    module: 'src/pages/public/site/MarketingPage.tsx',
    priority: p.kind === 'solucion' ? 0.9 : p.kind === 'guia' ? 0.6 : 0.8,
    jsonLd: [
      p.kind === 'guia'
        ? {
            '@type': 'Article',
            '@id': `${abs(p.path)}#articulo`,
            headline: `${p.h1} ${p.accent}`.replace(/\.$/, ''),
            description: p.description,
            inLanguage: 'es-CO',
            datePublished: p.published,
            dateModified: p.published,
            author: { '@id': ORG_ID },
            publisher: { '@id': ORG_ID },
            image: `${SITE_URL}/og.png`,
            mainEntityOfPage: abs(p.path),
          }
        : webPage(p),
      breadcrumbs([{ name: 'Inicio', path: '/' }, { name: `${SECTION[p.kind]}: ${p.nav}`, path: p.path }]),
      ...(p.faq.length ? [faqPage(p.path, p.faq)] : []),
    ],
  }));
  const legal: PrerenderPage[] = LEGAL.map((l) => ({
    ...l,
    module: 'src/pages/public/Legal.tsx',
    priority: 0.3,
    jsonLd: [webPage(l, l.path === '/contacto' ? 'ContactPage' : 'WebPage'), breadcrumbs([{ name: 'Inicio', path: '/' }, { name: l.title.split(' — ')[0], path: l.path }])],
  }));
  return [home, ...content, ...legal];
}

/** El mismo árbol de main.tsx, en el servidor. */
export function element(url: string, data: SsrData) {
  const client = createQueryClient();
  for (const q of data.queries ?? []) client.setQueryData(q.key, q.data);
  return (
    <Root client={client}>
      <StaticRouter location={url}>
        <App />
      </StaticRouter>
    </Root>
  );
}

/** llms.txt: resumen del sitio para asistentes de IA (https://llmstxt.org). */
export function llmsTxt(): string {
  const line = (p: { path: string; nav?: string; title: string; description: string }) => `- [${p.nav ?? p.title.split(' | ')[0]}](${abs(p.path)}): ${p.description}`;
  return [
    '# BackOffice',
    '',
    `> ${HOME.description}`,
    '',
    'BackOffice es un software en la nube (SaaS) hecho en Medellín, Colombia, para negocios que atienden y venden por WhatsApp. Conecta el número oficial de WhatsApp Business del negocio con un asistente de inteligencia artificial supervisado por el equipo, y convierte cada conversación en procesos ordenados: pedidos, domicilios, citas, cobranza, reactivación de clientes, seguimiento comercial y reportes. Es multiempresa: cada negocio tiene su espacio separado y activa solo lo que usa. Tiene tres productos: Automation (WhatsApp, CRM y procesos), Creative (diseños con la marca del negocio) y Ads (resultados de cuentas de Meta, Google y TikTok, en pruebas mientras cada plataforma autoriza la aplicación).',
    '',
    'Está en desarrollo y validación con los primeros negocios. Los planes son mensuales en pesos colombianos y se empieza sin tarjeta.',
    '',
    '## Soluciones',
    ...SOLUTIONS.map(line),
    '',
    '## Sectores',
    ...SECTORS.map(line),
    '',
    '## Recursos',
    ...PAGES.filter((p) => p.kind === 'herramienta').map(line),
    ...GUIDES.map(line),
    '',
    '## Preguntas frecuentes',
    ...HOME_FAQ.flatMap((f) => [`### ${f.q}`, f.a, '']),
    '## Contacto',
    `- WhatsApp: ${WA_TEXT} (https://wa.me/${WA_NUMBER})`,
    `- Correo: ${EMAIL}`,
    `- Ciudad: ${CIUDAD}`,
    '',
    '## Opcional',
    ...LEGAL.map((l) => `- [${l.title.split(' — ')[0]}](${abs(l.path)}): ${l.description}`),
    '',
  ].join('\n');
}
