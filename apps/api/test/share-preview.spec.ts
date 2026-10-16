/**
 * Pruebas — Vista previa de links (Open Graph) para WhatsApp y redes.
 */
import {
  DEFAULT_META, SharePreviewService, injectMeta, metaTags,
} from '../src/modules/share-preview.module';
import { createMockPrisma } from './helpers/mock-prisma';

const BASE = 'https://backoffice.example.co';
const HTML = `<!doctype html><html><head><meta charset="UTF-8" />
<!--og:start-->
<title>Viejo</title>
<meta property="og:title" content="Viejo" />
<!--og:end-->
</head><body><div id="root"></div></body></html>`;

function setup() {
  const { prisma, db } = createMockPrisma();
  db.platformSetting.push({ id: 's1', key: 'PUBLIC_WEB_URL', value: BASE });
  db.company.push({
    id: 'c1', name: 'Delicias Andinas', slug: 'delicias-andinas', status: 'ACTIVE', city: 'Medellín',
    currency: 'COP', logoUrl: null,
    orderConfigJson: JSON.stringify({ menu: { enabled: true, title: 'Almuerzos de la semana' } }),
  });
  db.company.push({
    id: 'c2', name: 'Sin Menú', slug: 'sin-menu', status: 'ACTIVE', orderConfigJson: '{}',
  });
  db.product.push(
    { id: 'p1', companyId: 'c1', name: 'Bandeja paisa', price: 28000, active: true, imageFile: null },
    { id: 'p2', companyId: 'c1', name: 'Ajiaco', price: 22000, active: true, imageFile: 'ajiaco.jpg' },
    { id: 'p3', companyId: 'c1', name: 'Viejo', price: 1000, active: false, imageFile: null },
  );
  db.order.push({
    id: 'o1', companyId: 'c1', trackingToken: 'tok_1234567890abcdef', customerName: 'Laura Gómez',
    deliveryAddressJson: JSON.stringify({ address: 'Calle 10 # 5-20' }),
  });
  return { service: new SharePreviewService(prisma as any) };
}

describe('Vista previa de links (Open Graph)', () => {
  it('el menú muestra la empresa, cuántos productos, desde qué precio y la foto de un producto', async () => {
    const { service } = setup();
    const meta = await service.metaFor('/m/delicias-andinas');
    expect(meta.title).toBe('Delicias Andinas — Almuerzos de la semana');
    expect(meta.description).toMatch(/^Mira el menú y pide por WhatsApp en un toque\. 2 productos · desde \$\s?22\.000 · Medellín\.$/);
    expect(meta.description).toMatch(/desde \$\s?22\.000/);
    expect(meta.description).toContain('Medellín');
    expect(meta.image).toBe('/api/public/menu/delicias-andinas/products/p2/image');
    expect(meta.imageAlt).toContain('Ajiaco');
  });

  it('un menú apagado o inexistente cae en la tarjeta general', async () => {
    const { service } = setup();
    expect((await service.metaFor('/m/sin-menu')).title).toBe(DEFAULT_META.title);
    expect((await service.metaFor('/m/no-existe')).title).toBe(DEFAULT_META.title);
  });

  it('el rastreo solo muestra la empresa: nunca el nombre ni la dirección del cliente', async () => {
    const { service } = setup();
    const html = await service.render(HTML, '/t/tok_1234567890abcdef');
    expect(html).toContain('Tu pedido de Delicias Andinas');
    expect(html).not.toContain('Laura');
    expect(html).not.toContain('Calle 10');
  });

  it('las URLs de imagen y de página salen absolutas (WhatsApp no acepta relativas)', async () => {
    const { service } = setup();
    const html = await service.render(HTML, '/m/delicias-andinas');
    expect(html).toContain(`<meta property="og:image" content="${BASE}/api/public/menu/delicias-andinas/products/p2/image" />`);
    expect(html).toContain(`<meta property="og:url" content="${BASE}/m/delicias-andinas" />`);
    expect(html).not.toContain('Viejo');
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it('el registro tiene su propia tarjeta y la imagen general declara 1200×630', async () => {
    const { service } = setup();
    const html = await service.render(HTML, '/registro');
    expect(html).toContain('Crea tu empresa con IA');
    expect(html).toContain(`${BASE}/og.png`);
    expect(html).toContain('og:image:width" content="1200"');
  });

  it('escapa nombres con comillas o etiquetas', () => {
    const tags = metaTags({ ...DEFAULT_META, title: 'Pizza "La <b>Mejor</b>"', path: '/' }, BASE);
    expect(tags).toContain('Pizza &quot;La &lt;b&gt;Mejor&lt;/b&gt;&quot;');
    expect(tags).not.toContain('<b>');
  });

  it('sin marcas en el HTML igual inserta las etiquetas antes de </head>', () => {
    const out = injectMeta('<html><head><title>x</title></head><body></body></html>', '<meta property="og:title" content="y" />');
    expect(out).toContain('<meta property="og:title" content="y" />\n  </head>');
    expect(out).not.toContain('<title>x</title>');
  });
});
