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
    </div>
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
