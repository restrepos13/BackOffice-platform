/**
 * Vista previa de los links compartidos (Open Graph): la tarjeta con imagen,
 * título y frase que muestran WhatsApp, Facebook, Instagram, Telegram o Slack
 * cuando alguien pega un link.
 *
 * Los robots que arman esa tarjeta NO ejecutan JavaScript: leen el <head> del
 * HTML. Por eso el API sirve index.html con las etiquetas ya escritas según la
 * ruta:
 *  - /m/<slug>  → menú de la empresa: su nombre, cuántos productos, desde qué
 *                 precio y la foto de un producto (o su logo).
 *  - /t/<token> → rastreo: solo el nombre de la empresa. Jamás datos del
 *                 cliente (nombre, dirección, productos): el link se reenvía.
 *  - /registro y el resto → tarjeta general de BackOffice.
 * En Vercel, /m y /t se reenvían a este servicio (apps/web/vercel.json).
 */
import { Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NOT_DELETED, parseJson } from '../common/constants';
import { publicWebUrl } from '../common/tracking';

export interface ShareMeta {
  title: string;
  description: string;
  /** Ruta absoluta (https://…) o relativa a la web pública. */
  image: string;
  imageAlt: string;
  /** Solo la imagen general mide 1200×630; las fotos de producto, lo que midan. */
  imageSize?: { width: number; height: number };
  path: string;
  siteName?: string;
}

export const OG_START = '<!--og:start-->';
export const OG_END = '<!--og:end-->';

export const DEFAULT_META: Omit<ShareMeta, 'path'> = {
  title: 'BackOffice — WhatsApp con IA para tu negocio',
  description: 'Atiende, vende y cobra por WhatsApp con un asistente de IA que trabaja 24/7. Crea tu cuenta y la IA arma tu negocio en minutos.',
  image: '/og.png',
  imageAlt: 'BackOffice: WhatsApp con IA para tu negocio',
  imageSize: { width: 1200, height: 630 },
};

const SIGNUP_META: Omit<ShareMeta, 'path'> = {
  ...DEFAULT_META,
  title: 'Crea tu empresa con IA — BackOffice',
  description: 'Cuéntale a la IA cómo funciona tu negocio y en minutos tienes tu WhatsApp atendiendo, vendiendo y cobrando solo.',
};

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** Corta sin partir palabras (WhatsApp muestra ~2 líneas). */
function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

function absolute(base: string, pathOrUrl: string): string {
  return /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${base.replace(/\/$/, '')}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: currency === 'COP' ? 0 : 2 }).format(value);
  } catch {
    return `$${Math.round(value).toLocaleString('es-CO')}`;
  }
}

/** Etiquetas del <head> para una tarjeta. */
export function metaTags(meta: ShareMeta, base: string): string {
  const url = absolute(base, meta.path);
  const image = absolute(base, meta.image);
  const title = clip(meta.title, 70);
  const description = clip(meta.description, 160);
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<link rel="canonical" href="${esc(url)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="es_CO" />`,
    `<meta property="og:site_name" content="${esc(meta.siteName ?? 'BackOffice')}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:alt" content="${esc(meta.imageAlt)}" />`,
    ...(meta.imageSize
      ? [
          `<meta property="og:image:width" content="${meta.imageSize.width}" />`,
          `<meta property="og:image:height" content="${meta.imageSize.height}" />`,
        ]
      : []),
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(title)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
  ];
  return tags.map((t) => `    ${t}`).join('\n');
}

/** Reemplaza el bloque marcado de index.html (o lo agrega antes de </head>). */
export function injectMeta(html: string, tags: string): string {
  const start = html.indexOf(OG_START);
  const end = html.indexOf(OG_END);
  if (start !== -1 && end > start) {
    return `${html.slice(0, start + OG_START.length)}\n${tags}\n    ${html.slice(end)}`;
  }
  return html.replace(/<title>[\s\S]*?<\/title>/i, '').replace('</head>', `${tags}\n  </head>`);
}

@Injectable()
export class SharePreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async metaFor(path: string): Promise<ShareMeta> {
    const clean = path.split('?')[0].replace(/\/+$/, '') || '/';
    try {
      const menu = /^\/m\/([a-z0-9-]{1,80})$/i.exec(clean);
      if (menu) return (await this.menuMeta(menu[1])) ?? { ...DEFAULT_META, path: clean };
      const track = /^\/t\/([A-Za-z0-9_-]{16,64})$/.exec(clean);
      if (track) return (await this.trackingMeta(track[1])) ?? { ...DEFAULT_META, path: clean };
    } catch {
      /* si la base no responde, la tarjeta general es mejor que una página caída */
    }
    if (clean === '/registro') return { ...SIGNUP_META, path: clean };
    return { ...DEFAULT_META, path: clean };
  }

  async render(html: string, path: string): Promise<string> {
    const meta = await this.metaFor(path);
    return injectMeta(html, metaTags(meta, await publicWebUrl(this.prisma)));
  }

  /** Para el panel: la tarjeta del menú aunque todavía no esté publicado. */
  async menuCard(slug: string): Promise<ShareMeta | null> {
    return this.menuMeta(slug, false);
  }

  private async menuMeta(slug: string, requirePublished = true): Promise<ShareMeta | null> {
    const company = await this.prisma.company.findUnique({ where: { slug } });
    const menu = parseJson<Record<string, any>>(company?.orderConfigJson, {}).menu ?? {};
    if (!company || ['SUSPENDED', 'CANCELLED'].includes(company.status)) return null;
    if (requirePublished && !menu.enabled) return null;
    const products = await this.prisma.product.findMany({
      where: { companyId: company.id, active: true, ...NOT_DELETED },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, price: true, imageFile: true },
    });
    const prices = products.map((p) => p.price).filter((p): p is number => typeof p === 'number' && p > 0);
    const currency = company.currency ?? 'COP';
    const parts = [
      products.length ? `${products.length} ${products.length === 1 ? 'producto' : 'productos'}` : null,
      prices.length ? `desde ${money(Math.min(...prices), currency)}` : null,
      company.city || null,
    ].filter(Boolean);
    const note = typeof menu.note === 'string' && menu.note.trim() ? menu.note.trim() : null;
    const withPhoto = products.find((p) => p.imageFile);
    const logo = company.logoUrl && /^https:\/\//i.test(company.logoUrl) ? company.logoUrl : null;
    return {
      title: `${company.name} — ${typeof menu.title === 'string' && menu.title.trim() ? menu.title.trim() : 'Menú y pedidos'}`,
      description: [
        (note ?? 'Mira el menú y pide por WhatsApp en un toque.').replace(/[.\s]*$/, '.'),
        parts.length ? `${parts.join(' · ')}.` : '',
      ].filter(Boolean).join(' ').replace(/^(.)/, (c) => c.toUpperCase()),
      image: withPhoto
        ? `/api/public/menu/${encodeURIComponent(company.slug)}/products/${withPhoto.id}/image`
        : logo ?? DEFAULT_META.image,
      imageAlt: withPhoto ? `${withPhoto.name} de ${company.name}` : company.name,
      imageSize: withPhoto || logo ? undefined : DEFAULT_META.imageSize,
      path: `/m/${company.slug}`,
      siteName: company.name,
    };
  }

  private async trackingMeta(token: string): Promise<ShareMeta | null> {
    const order = await this.prisma.order.findFirst({
      where: { trackingToken: token, ...NOT_DELETED },
      select: { company: { select: { name: true, logoUrl: true } } },
    });
    if (!order) return null;
    const { name, logoUrl } = order.company;
    const logo = logoUrl && /^https:\/\//i.test(logoUrl) ? logoUrl : null;
    return {
      title: `Tu pedido de ${name}`,
      description: 'Mira en vivo en qué va tu pedido y cuándo llega.',
      image: logo ?? DEFAULT_META.image,
      imageAlt: name,
      imageSize: logo ? undefined : DEFAULT_META.imageSize,
      path: `/t/${token}`,
      siteName: name,
    };
  }
}

@Module({
  providers: [SharePreviewService],
  exports: [SharePreviewService],
})
export class SharePreviewModule {}
