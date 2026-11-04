import { ArrowRight, Check, ChevronRight, Sparkles } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { pageByPath, type Block } from './content';
import { SavingsCalculator } from './SavingsCalculator';
import { CtaBand, FaqList, SectionTitle, SiteLayout } from './SiteChrome';
import { useSeo } from './seo';

/** Páginas de soluciones, sectores, calculadora y guías (todas salen de content.ts). */

const SECTION_LABEL = { solucion: 'Soluciones', sector: 'Sectores', guia: 'Guías', herramienta: 'Herramientas' } as const;

function BlockView({ block, alt }: { block: Block; alt: boolean }) {
  const wrap = alt ? 'border-y-2 border-ink bg-paper' : '';
  const head = <SectionTitle kicker={block.kicker} title={block.title} accent={block.accent} intro={'intro' in block ? block.intro : undefined} />;
  return (
    <section className={wrap}>
      <div className="mx-auto max-w-6xl px-4 py-14 md:px-6">
        {head}
        {block.kind === 'cards' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {block.items.map((it) => (
              <article key={it.title} className={`border-2 border-ink p-5 ${alt ? 'bg-bone' : 'bg-paper'}`}>
                <h3 className="text-lg font-semibold">{it.title}</h3>
                <p className="mt-1 text-sm text-ink-2">{it.text}</p>
              </article>
            ))}
          </div>
        )}
        {block.kind === 'steps' && (
          <ol className={`grid gap-6 md:grid-cols-2 ${block.items.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
            {block.items.map((it, i) => (
              <li key={it.title} className="border-t-2 border-ink pt-4">
                <p className="display text-4xl text-ok">{String(i + 1).padStart(2, '0')}</p>
                <h3 className="mt-1 font-semibold">{it.title}</h3>
                <p className="mt-1 text-sm text-ink-2">{it.text}</p>
              </li>
            ))}
          </ol>
        )}
        {block.kind === 'compare' && (
          <div className="border-2 border-ink">
            <div className="hidden grid-cols-2 border-b-2 border-ink md:grid">
              <p className="kicker px-5 py-3">Sin automatizar</p>
              <p className="kicker border-l-2 border-ink bg-ink px-5 py-3 !text-bone">Con BackOffice</p>
            </div>
            {block.rows.map((r, i) => (
              <div key={r.before} className={`grid md:grid-cols-2 ${i > 0 ? 'border-t-2 border-ink' : ''}`}>
                <p className={`p-5 text-sm text-ink-3 ${alt ? 'bg-bone' : 'bg-paper'}`}><span className="kicker mb-1 block md:hidden">Sin automatizar</span>{r.before}</p>
                <p className="flex gap-2 border-t-2 border-ink bg-ok-soft p-5 text-sm md:border-l-2 md:border-t-0">
                  <Check size={16} className="mt-0.5 shrink-0 text-ok" />
                  <span><span className="kicker mb-1 block md:hidden">Con BackOffice</span>{r.after}</span>
                </p>
              </div>
            ))}
          </div>
        )}
        {block.kind === 'text' && (
          <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-4 text-ink-2">
              {block.paragraphs.map((p) => <p key={p.slice(0, 40)}>{p}</p>)}
            </div>
            {block.list && (
              <ul className="space-y-2 border-l-4 border-ink pl-5 text-sm">
                {block.list.map((l) => <li key={l} className="flex gap-2"><Check size={14} className="mt-1 shrink-0" />{l}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default function MarketingPage() {
  const { pathname } = useLocation();
  const page = pageByPath(pathname.replace(/\/+$/, ''));
  // La ruta solo existe para páginas de content.ts; esto cubre una URL con barra final
  useSeo(page ?? { path: '/', title: 'BackOffice', description: '' });
  if (!page) return null;

  return (
    <SiteLayout>
      <div className="mx-auto max-w-6xl px-4 pt-6 md:px-6">
        <nav aria-label="Ruta" className="flex flex-wrap items-center gap-1 text-xs text-ink-3">
          <Link to="/" className="hover:underline">Inicio</Link>
          <ChevronRight size={12} />
          <span>{SECTION_LABEL[page.kind]}</span>
          <ChevronRight size={12} />
          <span aria-current="page" className="text-ink">{page.nav}</span>
        </nav>
      </div>

      <section className="mx-auto max-w-6xl px-4 pb-12 pt-8 md:px-6 md:pt-12">
        <p className="kicker mb-4">{page.kicker}</p>
        <h1 className="display max-w-5xl text-[clamp(2.5rem,7.5vw,5.75rem)] leading-[0.92]">
          {page.h1}
          <br />
          <span className="serif-accent text-[0.8em] normal-case">{page.accent}</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-2">{page.intro}</p>
        {page.published && (
          <p className="mt-3 text-xs text-ink-3">
            Publicado el <time dateTime={page.published}>{new Date(`${page.published}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' })}</time> · Equipo BackOffice
          </p>
        )}
        {page.kind !== 'guia' && (
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/registro" className="inline-flex items-center gap-2 bg-ink px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5">
              <Sparkles size={16} /> Crea tu cuenta
            </Link>
            {!page.calculator && (
              <Link to="/calculadora-de-ahorro" className="inline-flex items-center gap-2 border-2 border-ink bg-paper px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-bone-2">
                Calcula tu ahorro <ArrowRight size={16} />
              </Link>
            )}
          </div>
        )}
      </section>

      {page.calculator && page.kind === 'herramienta' && (
        <section className="mx-auto max-w-6xl px-4 pb-14 md:px-6">
          <SavingsCalculator />
        </section>
      )}

      {page.blocks.map((b, i) => <BlockView key={b.title} block={b} alt={i % 2 === 0} />)}

      {page.calculator && page.kind !== 'herramienta' && (
        <section className="mx-auto max-w-6xl px-4 py-14 md:px-6">
          <SectionTitle kicker="Calculadora" title="Haz la cuenta" accent="con tus números" />
          <SavingsCalculator compact />
        </section>
      )}

      {page.faq.length > 0 && <FaqList items={page.faq} />}

      <section className="mx-auto max-w-6xl px-4 pb-14 md:px-6">
        <p className="kicker mb-3">Sigue leyendo</p>
        <div className="grid gap-3 md:grid-cols-3">
          {page.related.map((p) => pageByPath(p)).filter((p) => !!p).map((p) => (
            <Link key={p!.path} to={p!.path} className="group flex items-center justify-between gap-3 border-2 border-ink bg-paper p-4 font-semibold hover:bg-bone-2">
              {p!.nav}
              <ArrowRight size={16} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      </section>

      <CtaBand />
    </SiteLayout>
  );
}
