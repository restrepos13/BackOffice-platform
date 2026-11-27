import { ArrowRight, Menu, Sparkles } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LegalFooterLinks } from '../legal-links';
import { CIUDAD, EMAIL, RESPONSABLE, WA_TEXT, mailLink, waLink } from '../public-info';
import { GUIDES, SECTORS, SOLUTIONS, type Faq } from './content';
import { useWarmApi } from './seo';

/** Encabezado, pie y piezas comunes de la portada y las páginas públicas. */

const NAV = [
  { to: '/automatizacion-de-whatsapp', label: 'WhatsApp con IA' },
  { to: '/automatizacion-de-procesos', label: 'Procesos' },
  { to: '/#sectores', label: 'Sectores' },
  { to: '/calculadora-de-ahorro', label: 'Calculadora' },
  { to: '/#planes', label: 'Planes' },
];

function SiteHeader() {
  const menu = useRef<HTMLDetailsElement>(null);
  const close = () => menu.current?.removeAttribute('open');
  return (
    <header className="sticky top-0 z-30 border-b-2 border-ink bg-bone/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-6">
        <Link to="/" className="display text-2xl leading-none" aria-label="BackOffice, inicio">
          BackOffice<span className="text-ok">.</span>
        </Link>
        <nav aria-label="Principal" className="flex items-center gap-1">
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} className="hidden px-2.5 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline lg:inline-block">
              {n.label}
            </Link>
          ))}
          <Link to="/login" className="px-2.5 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline">
            Iniciar sesión
          </Link>
          <Link to="/registro" className="hidden bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-bone hover:bg-ink-2 sm:inline-block">
            Crea tu cuenta
          </Link>
          <details ref={menu} className="relative lg:hidden">
            <summary className="flex cursor-pointer list-none items-center border-2 border-ink p-1.5 [&::-webkit-details-marker]:hidden" aria-label="Menú">
              <Menu size={18} />
            </summary>
            <div className="absolute right-0 top-full mt-2 w-64 border-2 border-ink bg-paper p-2 shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
              {NAV.map((n) => (
                <Link key={n.to} to={n.to} onClick={close} className="block px-3 py-2 text-sm font-semibold hover:bg-bone-2">{n.label}</Link>
              ))}
              <Link to="/registro" onClick={close} className="mt-1 block bg-ink px-3 py-2 text-sm font-semibold text-bone">Crea tu cuenta</Link>
            </div>
          </details>
        </nav>
      </div>
    </header>
  );
}

function FooterColumn({ title, links }: { title: string; links: Array<{ to: string; label: string }> }) {
  return (
    <nav aria-label={title} className="flex flex-col gap-1.5">
      <p className="kicker">{title}</p>
      {links.map((l) => <Link key={l.to} to={l.to} className="hover:underline">{l.label}</Link>)}
    </nav>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t-2 border-ink">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-ink-2 sm:grid-cols-2 md:px-6 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <div>
          <p className="display text-2xl leading-none text-ink">BackOffice<span className="text-ok">.</span></p>
          <p className="mt-3 max-w-sm text-xs text-ink-3">
            Automatización de procesos con WhatsApp e IA para negocios. Software en la nube en desarrollo y validación con los primeros negocios. Servicio prestado por {RESPONSABLE}, persona natural, desde {CIUDAD.split(',')[0]}, Colombia.
          </p>
          <div className="mt-4 flex flex-col gap-1 text-xs">
            <a href={waLink()} target="_blank" rel="noreferrer" className="hover:underline">WhatsApp {WA_TEXT}</a>
            <a href={mailLink()} className="hover:underline">{EMAIL}</a>
          </div>
        </div>
        <FooterColumn title="Soluciones" links={SOLUTIONS.map((p) => ({ to: p.path, label: p.nav }))} />
        <FooterColumn title="Sectores" links={SECTORS.map((p) => ({ to: p.path, label: p.nav }))} />
        <FooterColumn
          title="Recursos"
          links={[{ to: '/calculadora-de-ahorro', label: 'Calculadora de ahorro' }, ...GUIDES.map((p) => ({ to: p.path, label: p.nav }))]}
        />
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-xs text-ink-3 md:px-6">
          <p>© {new Date().getFullYear()} BackOffice · {CIUDAD}</p>
          <LegalFooterLinks />
        </div>
      </div>
    </footer>
  );
}

export function SiteLayout({ children }: { children: ReactNode }) {
  useWarmApi();
  return (
    <div className="min-h-screen bg-bone text-ink">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-ink focus:px-3 focus:py-2 focus:text-bone">
        Ir al contenido
      </a>
      <SiteHeader />
      <main id="contenido">{children}</main>
      <SiteFooter />
      <WhatsAppFloat />
    </div>
  );
}

/**
 * Número de WhatsApp de BackOffice para el botón flotante: VITE_PUBLIC_WHATSAPP
 * (Vercel), con indicativo. Sin número configurado, el botón no aparece.
 */
export function publicWhatsapp(env: Record<string, string | undefined> = import.meta.env as Record<string, string | undefined>): string | null {
  const d = String(env.VITE_PUBLIC_WHATSAPP ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('3')) return `57${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

export function WhatsAppFloat({ number = publicWhatsapp() }: { number?: string | null }) {
  if (!number) return null;
  const href = `https://wa.me/${number}?text=${encodeURIComponent('¡Hola! Quiero saber más de BackOffice para mi negocio.')}`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Escríbenos por WhatsApp"
      className="fixed bottom-4 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[#25D366] text-white shadow-[0_6px_18px_rgba(0,0,0,0.25)] transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:bottom-6 sm:right-6"
    >
      <svg viewBox="0 0 32 32" width="28" height="28" fill="currentColor" aria-hidden>
        <path d="M16.04 3C8.86 3 3.03 8.82 3.03 16c0 2.29.6 4.53 1.74 6.5L3 29l6.68-1.75A12.96 12.96 0 0 0 16.04 29C23.2 29 29 23.18 29 16S23.2 3 16.04 3Zm0 23.62c-2.02 0-4-.54-5.72-1.57l-.41-.24-3.96 1.04 1.06-3.86-.27-.4A10.6 10.6 0 0 1 5.4 16c0-5.86 4.77-10.62 10.64-10.62 5.86 0 10.6 4.76 10.6 10.62s-4.74 10.62-10.6 10.62Zm5.82-7.95c-.32-.16-1.9-.94-2.19-1.04-.3-.11-.51-.16-.72.16-.21.32-.83 1.04-1.02 1.26-.19.21-.37.24-.69.08-.32-.16-1.35-.5-2.57-1.59-.95-.85-1.59-1.9-1.78-2.22-.19-.32-.02-.49.14-.65.14-.14.32-.37.48-.56.16-.19.21-.32.32-.53.11-.21.05-.4-.03-.56-.08-.16-.72-1.74-.99-2.38-.26-.62-.52-.54-.72-.55h-.61c-.21 0-.56.08-.85.4-.29.32-1.12 1.09-1.12 2.66s1.15 3.09 1.31 3.3c.16.21 2.26 3.45 5.47 4.84.76.33 1.36.53 1.83.68.77.24 1.47.21 2.02.13.62-.09 1.9-.78 2.17-1.53.27-.75.27-1.39.19-1.53-.08-.13-.29-.21-.61-.37Z" />
      </svg>
    </a>
  );
}

/** Título de sección: Anton en mayúsculas + acento en Playfair itálica. */
export function SectionTitle({ kicker, title, accent, intro, as: Tag = 'h2' }: { kicker?: string; title: string; accent?: string; intro?: string; as?: 'h1' | 'h2' }) {
  return (
    <div className="mb-8">
      {kicker && <p className="kicker mb-2">{kicker}</p>}
      <Tag className={`display ${Tag === 'h1' ? 'text-[clamp(2.4rem,7vw,5.25rem)] leading-[0.92]' : 'text-4xl md:text-5xl'}`}>
        {title}{accent && <> <span className="serif-accent text-[0.82em] normal-case">{accent}</span></>}
      </Tag>
      {intro && <p className="mt-4 max-w-2xl text-ink-2">{intro}</p>}
    </div>
  );
}

/** Preguntas frecuentes con <details>: se leen sin JavaScript y en el HTML prerenderizado. */
export function FaqList({ items, title = 'Preguntas frecuentes' }: { items: Faq[]; title?: string }) {
  return (
    <section className="mx-auto max-w-6xl px-4 py-14 md:px-6" aria-labelledby="faq">
      <div className="grid gap-8 lg:grid-cols-[1fr_2fr]">
        <div>
          <p className="kicker mb-2">Dudas</p>
          <h2 id="faq" className="display text-4xl md:text-5xl">{title}</h2>
        </div>
        <div className="border-t-2 border-ink">
          {items.map((f) => (
            <details key={f.q} className="group border-b-2 border-ink">
              <summary className="flex cursor-pointer list-none items-start justify-between gap-4 py-4 text-left font-semibold [&::-webkit-details-marker]:hidden">
                <h3 className="text-base">{f.q}</h3>
                <span aria-hidden className="display mt-0.5 text-xl leading-none transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="pb-5 pr-8 text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Banda final de llamada a la acción. */
export function CtaBand({ title = 'Empieza hoy.', text = 'Describe tu negocio y revisa tu cuenta armada, sin tarjeta. Si prefieres hablar antes, escríbenos por WhatsApp.' }: { title?: string; text?: string }) {
  return (
    <section className="bg-ink text-bone">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-4 py-14 md:px-6">
        <div>
          <h2 className="display text-4xl md:text-6xl">{title}</h2>
          <p className="mt-3 max-w-xl text-sm text-line">{text}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/registro" className="inline-flex items-center gap-2 bg-bone px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-ink hover:bg-paper">
            <Sparkles size={16} /> Crea tu cuenta
          </Link>
          <a href={waLink('Hola, quiero saber cómo BackOffice puede automatizar mi negocio')} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 border-2 border-bone px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-ink-2">
            Hablar por WhatsApp <ArrowRight size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}
