/**
 * Prerender de las páginas públicas (corre al final de `pnpm build`).
 *
 * Buscadores y asistentes de IA (Google, Bing, ChatGPT, Gemini, Perplexity)
 * leen el HTML sin ejecutar JavaScript. Este script escribe cada página
 * pública con su texto, su <head> (título, descripción, canónica, vista previa)
 * y sus datos estructurados de schema.org; en el navegador React reutiliza ese
 * HTML (hydrateRoot en main.tsx). También genera sitemap.xml y llms.txt.
 *
 *  dist/index.html            → portada prerenderizada
 *  dist/app.html              → la app vacía, para el panel y demás rutas
 *  dist/<ruta>.html           → soluciones, sectores, guías y legales
 *
 * Si el API no responde, la sección de planes se prerenderiza sin precios y el
 * navegador los pide al cargar: el build nunca depende del servidor.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.NODE_ENV ||= 'production';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const API = (process.env.PRERENDER_API_URL || 'https://backoffice-platform-90ic.onrender.com').replace(/\/$/, '');

const { renderToPipeableStream } = await import('react-dom/server');
const entry = await import(pathToFileURL(join(root, 'dist-ssr', 'entry-prerender.js')).href);
const { SITE_URL } = entry;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const urlOf = (path) => `${SITE_URL}${path === '/' ? '/' : path}`;

async function fetchPlans() {
  if (process.env.PRERENDER_SKIP_API === '1') return undefined;
  try {
    // Hasta 50 s: si el servidor gratis de Render está dormido, tarda en despertar
    const res = await fetch(`${API}/api/public/plans`, { signal: AbortSignal.timeout(50_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data?.plans) || !data.modes || !data.notices) throw new Error('respuesta inesperada');
    return data;
  } catch (e) {
    console.warn(`[prerender] sin planes del API (${e.message}): se cargan en el navegador`);
    return undefined;
  }
}

function render(element) {
  return new Promise((ok, fail) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    sink.on('finish', () => ok(Buffer.concat(chunks).toString('utf8')));
    let failed = false;
    const stream = renderToPipeableStream(element, {
      // Todo resuelto (incluidas las páginas con lazy): el HTML sale completo, sin scripts en línea
      onAllReady() {
        if (!failed) stream.pipe(sink);
      },
      onShellError: fail,
      onError(e) {
        failed = true;
        fail(e);
      },
    });
  });
}

/** Código de la página para precargar (el mismo que pediría React al reutilizar el HTML). */
function preloads(manifest, module) {
  const seen = new Set();
  const files = [];
  const walk = (key) => {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk.isEntry) files.push(chunk.file);
    for (const k of chunk.imports ?? []) walk(k);
  };
  walk(module);
  if (!manifest[module]) console.warn(`[prerender] ${module} no está en el manifiesto`);
  // Lo que index.html ya precarga (vendor) no se repite
  return files.filter((f) => !template.includes(`/${f}"`)).map((f) => `<link rel="modulepreload" crossorigin href="/${f}" />`);
}

function headFor(page) {
  const url = urlOf(page.path);
  return [
    `<title>${esc(page.title)}</title>`,
    `<meta name="description" content="${esc(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />`,
    `<meta property="og:type" content="${page.path.startsWith('/guias/') ? 'article' : 'website'}" />`,
    `<meta property="og:locale" content="es_CO" />`,
    `<meta property="og:site_name" content="BackOffice" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE_URL}/og.png" />`,
    `<meta property="og:image:alt" content="BackOffice: automatización de WhatsApp y procesos con IA" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`,
    `<meta name="twitter:image" content="${SITE_URL}/og.png" />`,
  ].map((t) => `    ${t}`).join('\n');
}

// app.html existe si el script ya corrió sobre este build (vite vacía dist/ al compilar)
const template = await readFile(join(dist, existsSync(join(dist, 'app.html')) ? 'app.html' : 'index.html'), 'utf8');
const manifest = JSON.parse(await readFile(join(dist, '.vite', 'manifest.json'), 'utf8'));
const OG_START = '<!--og:start-->';
const OG_END = '<!--og:end-->';
if (!template.includes(OG_START) || !template.includes('<div id="root"></div>')) throw new Error('[prerender] index.html no tiene las marcas esperadas');

// La app vacía queda como app.html: Vercel y el API la sirven para el panel y las demás rutas
await writeFile(join(dist, 'app.html'), template);

const plans = await fetchPlans();
const data = plans ? { queries: [{ key: ['public-plans'], data: plans }] } : {};
const pages = entry.pages(plans);

for (const page of pages) {
  const body = await render(entry.element(page.path, data));
  if (body.length < 2000 || !body.includes('<h1')) throw new Error(`[prerender] ${page.path} salió vacía`);
  const start = template.indexOf(OG_START) + OG_START.length;
  const end = template.indexOf(OG_END);
  let html = `${template.slice(0, start)}\n${headFor(page)}\n    ${template.slice(end)}`;
  const ld = `<script type="application/ld+json">${json({ '@context': 'https://schema.org', '@graph': page.jsonLd })}</script>`;
  html = html.replace('</head>', `    ${preloads(manifest, page.module).join('\n    ')}\n    ${ld}\n  </head>`);
  const ssrData = page.path === '/' && plans ? `<script type="application/json" id="bo-ssr-data">${json(data)}</script>` : '';
  html = html.replace('<div id="root"></div>', `<div id="root" data-ssr="${page.path}">${body}</div>${ssrData}`);
  const file = page.path === '/' ? join(dist, 'index.html') : join(dist, `${page.path.slice(1)}.html`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}

const today = new Date().toISOString().slice(0, 10);
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map((p) => `  <url><loc>${urlOf(p.path)}</loc><lastmod>${today}</lastmod><priority>${p.priority.toFixed(1)}</priority></url>`),
  '</urlset>',
  '',
].join('\n');
await writeFile(join(dist, 'sitemap.xml'), sitemap);
await writeFile(join(dist, 'llms.txt'), entry.llmsTxt());

if (!existsSync(join(dist, 'robots.txt'))) throw new Error('[prerender] falta robots.txt en public/');
console.log(`[prerender] ${pages.length} páginas${plans ? ' con planes' : ' (planes en el navegador)'} · sitemap.xml · llms.txt`);
