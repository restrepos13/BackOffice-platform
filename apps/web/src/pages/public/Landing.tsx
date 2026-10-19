import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CalendarCheck, Check, Gift, MessageCircle, ShoppingBag, Sparkles, UserRound, Video } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';

interface PublicPlans {
  plans: Array<{ name: string; tier: string | null; maxLines: number; priceSelf: number; priceManaged: number; includedMetaUsd: number; highlight: boolean; features: string[] }>;
  modes: Record<'SELF' | 'MANAGED', { name: string; short: string }>;
  addons: Array<{ name: string; description: string; price: number; perUnit: string | null; status: 'AVAILABLE' | 'SOON' }>;
  notices: { numbers: string; meta: string; landing: string; humanOversight: string };
}

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/**
 * Portada pública (antes de iniciar sesión): qué hace BackOffice, para quién
 * y dos caminos — crear la cuenta (la IA arma la empresa) o entrar.
 */

const RUBROS = [
  { icon: ShoppingBag, title: 'Comidas', text: 'Toma pedidos, cobra en el chat y sigue cada domicilio en vivo.' },
  { icon: CalendarCheck, title: 'Servicios con citas', text: 'Responde, agenda y recuerda las citas de tu consultorio, salón o taller.' },
  { icon: MessageCircle, title: 'Tiendas y ventas', text: 'Muestra tu catálogo, califica a cada cliente y vende por WhatsApp.' },
  { icon: Video, title: 'Webcam y creadores', text: 'Un chatter con IA por perfil, con personalidad propia y venta de contenido.' },
];

const STEPS = [
  { n: '01', title: 'Cuéntanos tu negocio', text: 'Escríbelo como se lo contarías a un empleado nuevo: qué vendes, precios, horario.' },
  { n: '02', title: 'La IA arma tu empresa', text: 'Tu catálogo, horario, preguntas frecuentes y tu asistente quedan listos en minutos.' },
  { n: '03', title: 'Te acompañamos', text: 'Te escribimos por WhatsApp, conectamos tu número y eliges el plan cuando todo funcione.' },
];

function PlansSection() {
  const { data } = useQuery({ queryKey: ['public-plans'], queryFn: () => api.get<PublicPlans>('/public/plans') });
  const [mode, setMode] = useState<'SELF' | 'MANAGED'>('MANAGED');
  if (!data || !data.plans.length) return null;
  return (
    <section className="mx-auto max-w-6xl px-4 py-14 md:px-6" id="planes">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kicker">Automatización humanizada de WhatsApp para vender 24/7</p>
          <h2 className="display text-4xl md:text-5xl">Planes <span className="serif-accent normal-case">claros</span></h2>
        </div>
        <div className="flex border-2 border-ink" role="radiogroup" aria-label="Modalidad">
          {(['MANAGED', 'SELF'] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
              className={`cursor-pointer px-4 py-2 text-sm font-semibold ${mode === m ? 'bg-ink text-bone' : 'bg-paper'}`}>
              {data.modes[m].name}
            </button>
          ))}
        </div>
      </div>
      <p className="mb-5 max-w-3xl text-sm text-ink-2">{data.modes[mode].short}</p>
      <div className="grid gap-4 md:grid-cols-3">
        {data.plans.map((p) => (
          <article key={p.name} className={`flex flex-col border-2 border-ink bg-paper p-5 ${p.highlight ? 'shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]' : ''}`}>
            <h3 className="display text-3xl">{p.name}</h3>
            <p className="text-sm font-semibold">{p.maxLines === 1 ? '1 número de WhatsApp' : p.tier === 'MAX' ? `Hasta ${p.maxLines} números` : `${p.maxLines} números de WhatsApp`}</p>
            <p className="display mt-3 text-3xl">{cop(mode === 'MANAGED' ? p.priceManaged : p.priceSelf)}<span className="text-sm text-ink-3">/mes</span></p>
            <p className="text-[11px] text-ink-3">IVA incluido{mode === 'MANAGED' ? ` · + la IA que uses · US$${p.includedMetaUsd} de Meta incluidos` : ' · la IA y Meta los pagas directo'}</p>
            <ul className="mt-3 flex-1 space-y-1 border-t border-line pt-3 text-sm">
              {p.features.map((f) => <li key={f} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0" />{f}</li>)}
            </ul>
          </article>
        ))}
      </div>
      <div className="mt-6 grid gap-3 text-sm md:grid-cols-2">
        <p className="flex gap-2 border-2 border-line bg-paper p-3"><Gift size={16} className="mt-0.5 shrink-0" />{data.notices.landing}</p>
        <p className="flex gap-2 border-2 border-line bg-paper p-3"><UserRound size={16} className="mt-0.5 shrink-0" />{data.notices.humanOversight}</p>
        <p className="border-2 border-line bg-paper p-3 text-xs text-ink-2">{data.notices.numbers}</p>
        <p className="border-2 border-line bg-paper p-3 text-xs text-ink-2">{data.notices.meta}</p>
      </div>
      <div className="mt-8">
        <p className="kicker mb-3">Complementos</p>
        <div className="flex flex-wrap gap-2">
          {data.addons.map((a) => (
            <span key={a.name} title={a.description} className={`inline-flex items-center gap-2 border-2 px-3 py-1.5 text-sm ${a.status === 'SOON' ? 'border-line text-ink-3' : 'border-ink bg-paper'}`}>
              {a.name}
              <span className="text-xs">{a.status === 'SOON' ? 'Próximamente' : `${cop(a.price)}/mes${a.perUnit ? ` por ${a.perUnit}` : ''}`}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Landing() {
  useEffect(() => {
    document.title = 'BackOffice — tu negocio atendido por IA en WhatsApp';
  }, []);

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 md:px-6">
        <p className="display text-2xl leading-none">
          BackOffice<span className="text-ok">.</span>
        </p>
        <nav className="flex items-center gap-2">
          <Link to="/login" className="px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline">
            Iniciar sesión
          </Link>
          <Link to="/registro" className="hidden bg-ink px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-bone hover:bg-ink-2 sm:inline-block">
            Crea tu cuenta
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto max-w-6xl px-4 pb-14 pt-8 md:px-6 md:pt-14">
          <p className="kicker mb-4">Para negocios grandes y pequeños · Colombia</p>
          <h1 className="display max-w-4xl text-[clamp(2.6rem,8vw,6rem)] leading-[0.92]">
            Tu WhatsApp atendido
            <br />
            por IA, <span className="serif-accent text-[0.8em] normal-case">las 24 horas.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-2">
            Responde, vende, toma pedidos y agenda citas como lo haría tu mejor empleado. Tú ves todo en un solo panel.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/registro"
              className="inline-flex items-center gap-2 bg-ink px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5"
            >
              <Sparkles size={16} /> Crea tu empresa con IA
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 border-2 border-ink bg-paper px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-bone-2"
            >
              Iniciar ahora <ArrowRight size={16} />
            </Link>
          </div>
          <p className="mt-4 text-xs text-ink-3">Sin tarjeta para empezar. El plan lo eliges cuando tu asistente ya esté funcionando.</p>
        </section>

        {/* Cómo funciona */}
        <section className="border-y-2 border-ink bg-paper">
          <div className="mx-auto grid max-w-6xl gap-0 px-4 md:grid-cols-3 md:px-6">
            {STEPS.map((s, i) => (
              <div key={s.n} className={`py-8 md:px-6 ${i > 0 ? 'border-t-2 border-ink md:border-l-2 md:border-t-0' : ''} ${i === 0 ? 'md:pl-0' : ''}`}>
                <p className="display text-4xl text-ok">{s.n}</p>
                <h2 className="mt-2 text-lg font-semibold">{s.title}</h2>
                <p className="mt-1 text-sm text-ink-2">{s.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Rubros */}
        <section className="mx-auto max-w-6xl px-4 py-14 md:px-6">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <h2 className="display text-4xl md:text-5xl">
              Hecho a la medida <span className="serif-accent normal-case">de tu negocio</span>
            </h2>
            <p className="max-w-sm text-sm text-ink-3">Cada empresa ve solo las herramientas de su tipo de negocio.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {RUBROS.map((r) => (
              <article key={r.title} className="flex flex-col border-2 border-ink bg-paper p-5">
                <r.icon size={22} strokeWidth={1.8} />
                <h3 className="mt-4 text-lg font-semibold">{r.title}</h3>
                <p className="mt-1 flex-1 text-sm text-ink-2">{r.text}</p>
              </article>
            ))}
          </div>
        </section>

        <PlansSection />

        {/* Cierre */}
        <section className="bg-ink text-bone">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-6 px-4 py-12 md:px-6">
            <div>
              <h2 className="display text-4xl md:text-5xl">Empieza hoy.</h2>
              <p className="mt-2 max-w-xl text-sm text-line">
                Describe tu negocio y en unos minutos tienes tu cuenta armada. Si ya tienes cuenta, entra a tu panel.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link to="/registro" className="inline-flex items-center gap-2 bg-bone px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-ink hover:bg-paper">
                <Sparkles size={16} /> Crea tu cuenta
              </Link>
              <Link to="/login" className="inline-flex items-center gap-2 border-2 border-bone px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-ink-2">
                Iniciar sesión
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-ink-3 md:px-6">
        <p>© {new Date().getFullYear()} BackOffice · Estudio de automatización con IA</p>
        <p>Medellín, Colombia</p>
      </footer>
    </div>
  );
}
