import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BarChart3, Building2, CalendarCheck, Check, Gift, MessageCircle, Palette, ShoppingBag, Sparkles, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { LegalFooterLinks } from './legal-links';
import { CIUDAD, EMAIL, RESPONSABLE, WA_TEXT, mailLink, waLink } from './public-info';

interface PublicPlans {
  plans: Array<{ name: string; tier: string | null; maxLines: number; priceSelf: number; priceManaged: number; includedMetaUsd: number; highlight: boolean; features: string[] }>;
  modes: Record<'SELF' | 'MANAGED', { name: string; short: string }>;
  addons: Array<{ name: string; description: string; price: number; perUnit: string | null; status: 'AVAILABLE' | 'SOON'; included?: boolean }>;
  notices: { numbers: string; meta: string; landing: string; humanOversight: string };
}

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/**
 * Portada pública (antes de iniciar sesión): qué es BackOffice, qué incluye,
 * qué está disponible hoy y cómo se conectan las cuentas publicitarias.
 * No afirma aprobaciones de Meta, Google ni TikTok ni promete resultados.
 */

const RUBROS = [
  { icon: ShoppingBag, title: 'Comidas', text: 'Toma pedidos, cobra en el chat y sigue cada domicilio en vivo.' },
  { icon: CalendarCheck, title: 'Servicios con citas', text: 'Responde, agenda y recuerda las citas de tu consultorio, salón o taller.' },
  { icon: MessageCircle, title: 'Tiendas y ventas', text: 'Muestra tu catálogo, califica a cada cliente y haz seguimiento a cada venta.' },
  { icon: Building2, title: 'Proyectos y asesorías', text: 'Atiende consultas, agenda visitas y haz seguimiento sin prometer precios por chat.' },
];

const STEPS = [
  { n: '01', title: 'Cuéntanos tu negocio', text: 'Escríbelo como se lo contarías a un empleado nuevo: qué vendes, precios, horario.' },
  { n: '02', title: 'Se arma tu espacio', text: 'Tu catálogo, horario, preguntas frecuentes y las herramientas de tu sector quedan listos para revisar.' },
  { n: '03', title: 'Te acompañamos', text: 'Conectamos tu WhatsApp contigo y eliges el plan cuando todo funcione.' },
];

const PRODUCTS = [
  {
    icon: MessageCircle,
    name: 'Automation',
    text: 'Atención, ventas y operación.',
    items: ['WhatsApp con asistente de IA y paso a una persona', 'Clientes y contactos con su historial', 'Embudo comercial y seguimientos', 'Pedidos, catálogo y domicilios', 'Agenda de citas', 'Cobranza y reactivación de clientes', 'Automatizaciones y campañas por WhatsApp', 'Reportes para el dueño o gerente'],
  },
  {
    icon: Palette,
    name: 'Creative',
    text: 'Contenido con la marca del negocio.',
    items: ['Identidad de marca: logo, colores y tono', 'Diseños editables para redes y anuncios', 'Biblioteca de imágenes y videos', 'Aprobación antes de publicar'],
  },
  {
    icon: BarChart3,
    name: 'Ads',
    text: 'Análisis de publicidad pagada.',
    items: ['Cuentas publicitarias propias de cada negocio', 'Resultados y métricas en un solo panel', 'Alertas y reglas con tu aprobación', 'Pausar o reanudar con confirmación'],
  },
];

const ADS_STEPS = [
  { n: '01', title: 'Conectas tu cuenta', text: 'Entras con tu propio usuario de Meta, Google o TikTok y apruebas los permisos en esa plataforma. Nunca te pedimos la contraseña.' },
  { n: '02', title: 'Eliges qué cuentas', text: 'Solo las cuentas publicitarias que tú seleccionas. Las demás no se tocan.' },
  { n: '03', title: 'Consultas resultados', text: 'Campañas, anuncios y métricas diarias en un panel, junto a lo que pasa en tu WhatsApp.' },
  { n: '04', title: 'Pausas o reanudas', text: 'Cuando la integración esté autorizada, desde BackOffice y siempre con tu confirmación.' },
];

/* Estado real de cada función. "En pruebas" = construido, pero depende de una
   autorización externa o de validarlo con negocios reales. */
const STATUS = [
  {
    title: 'Disponible',
    note: 'Funciona hoy en la plataforma.',
    items: ['WhatsApp con asistente de IA y paso a una persona', 'Clientes, contactos y embudo comercial', 'Pedidos, catálogo y domicilios', 'Agenda de citas', 'Cobranza y reactivación de clientes', 'Automatizaciones y campañas por WhatsApp', 'Reportes y descarga de datos de la empresa', 'Creative: marca, diseños y biblioteca'],
  },
  {
    title: 'En pruebas',
    note: 'Construido; pendiente de autorización de la plataforma externa o de validación.',
    items: ['Meta Ads: resultados, pausar o reanudar y crear anuncios', 'Google Ads: resultados, pausar o reanudar', 'TikTok Ads: resultados, pausar o reanudar', 'Mensajes de Instagram y Messenger', 'Publicación programada en Facebook e Instagram', 'Google Calendar y carpeta de Google Drive'],
  },
  {
    title: 'Próximamente',
    note: 'En el plan; todavía no disponible.',
    items: ['Crear anuncios en Google Ads y TikTok Ads', 'Anuncios generados con IA', 'Llamadas con IA', 'Facturación electrónica DIAN', 'Verificación automática de transferencias'],
  },
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
      {data.addons.some((a) => a.included) && (
        <div className="mt-8">
          <p className="kicker mb-3">Incluido en todos los planes</p>
          <div className="grid gap-3 md:grid-cols-3">
            {data.addons.filter((a) => a.included).map((a) => (
              <div key={a.name} className="border-2 border-ink bg-paper p-4">
                <p className="font-semibold">{a.name}</p>
                <p className="mt-1 text-sm text-ink-2">{a.description}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="mt-8">
        <p className="kicker mb-3">Complementos</p>
        <div className="flex flex-wrap gap-2">
          {data.addons.filter((a) => !a.included).map((a) => (
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
    document.title = 'BackOffice — CRM multiempresa con WhatsApp e IA para negocios';
  }, []);

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 md:px-6">
        <p className="display text-2xl leading-none">
          BackOffice<span className="text-ok">.</span>
        </p>
        <nav className="flex items-center gap-2">
          <a href="#incluye" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline md:inline-block">Qué incluye</a>
          <a href="#estado" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline md:inline-block">Estado</a>
          <Link to="/contacto" className="hidden px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] hover:underline md:inline-block">Contacto</Link>
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
          <p className="kicker mb-4">CRM SaaS multiempresa · para negocios de cualquier sector · Colombia</p>
          <h1 className="display max-w-4xl text-[clamp(2.6rem,8vw,6rem)] leading-[0.92]">
            Tus clientes, tu WhatsApp
            <br />
            y tu publicidad, <span className="serif-accent text-[0.8em] normal-case">en un solo panel.</span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-ink-2">
            BackOffice es un CRM en la nube: atiende tu WhatsApp con un asistente de IA supervisado por tu equipo, organiza clientes, embudo, pedidos y cobranza, y reúne los resultados de tus cuentas publicitarias.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/registro"
              className="inline-flex items-center gap-2 bg-ink px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5"
            >
              <Sparkles size={16} /> Crea tu empresa
            </Link>
            <a
              href="#incluye"
              className="inline-flex items-center gap-2 border-2 border-ink bg-paper px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-bone-2"
            >
              Ver qué incluye <ArrowRight size={16} />
            </a>
          </div>
          <p className="mt-4 text-xs text-ink-3">Proyecto en desarrollo y validación con los primeros negocios. Sin tarjeta para empezar: el plan lo eliges cuando todo esté funcionando.</p>
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

        {/* Qué incluye */}
        <section id="incluye" className="mx-auto max-w-6xl scroll-mt-4 px-4 py-14 md:px-6">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
            <h2 className="display text-4xl md:text-5xl">
              Un CRM, <span className="serif-accent normal-case">tres productos</span>
            </h2>
            <p className="max-w-sm text-sm text-ink-3">Cada empresa tiene su propio espacio, separado de las demás, y activa solo lo que necesita.</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {PRODUCTS.map((p) => (
              <article key={p.name} className="flex flex-col border-2 border-ink bg-paper p-5">
                <p.icon size={22} strokeWidth={1.8} />
                <h3 className="display mt-4 text-3xl">{p.name}</h3>
                <p className="text-sm text-ink-2">{p.text}</p>
                <ul className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
                  {p.items.map((it) => <li key={it} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0" />{it}</li>)}
                </ul>
              </article>
            ))}
          </div>
        </section>

        {/* Rubros */}
        <section className="mx-auto max-w-6xl px-4 pb-14 md:px-6">
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

        {/* Cuentas publicitarias */}
        <section id="publicidad" className="scroll-mt-4 border-y-2 border-ink bg-paper">
          <div className="mx-auto max-w-6xl px-4 py-14 md:px-6">
            <p className="kicker">Cuentas publicitarias</p>
            <h2 className="display mt-1 text-4xl md:text-5xl">
              Tu publicidad, <span className="serif-accent normal-case">conectada a tu operación</span>
            </h2>
            <p className="mt-3 max-w-2xl text-sm text-ink-2">
              Cada negocio conecta sus propias cuentas de anuncios. BackOffice no compra publicidad por ti ni usa tu presupuesto sin tu decisión.
            </p>
            <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {ADS_STEPS.map((s) => (
                <div key={s.n} className="border-t-2 border-ink pt-4">
                  <p className="display text-3xl text-ok">{s.n}</p>
                  <h3 className="mt-1 font-semibold">{s.title}</h3>
                  <p className="mt-1 text-sm text-ink-2">{s.text}</p>
                </div>
              ))}
            </div>
            <div className="mt-8 grid gap-3 text-sm md:grid-cols-2">
              <p className="border-2 border-ink bg-bone p-4">
                <b>Sobre las plataformas.</b> Las integraciones con Meta Ads, Google Ads y TikTok Ads están construidas y en pruebas. Para usarlas con cuentas reales, cada plataforma debe revisar y autorizar la aplicación de BackOffice; ese proceso todavía no ha concluido. BackOffice no está afiliado ni respaldado por Meta, Google ni TikTok.
              </p>
              <p className="border-2 border-ink bg-bone p-4">
                <b>Tú mantienes el control.</b> Puedes desconectar una cuenta desde BackOffice o quitarle el permiso desde la propia plataforma en cualquier momento. Mostramos datos para decidir mejor; no garantizamos resultados de ventas ni de anuncios.
              </p>
            </div>
          </div>
        </section>

        {/* Estado de las funciones */}
        <section id="estado" className="mx-auto max-w-6xl scroll-mt-4 px-4 py-14 md:px-6">
          <p className="kicker">Estado de las funciones</p>
          <h2 className="display mt-1 text-4xl md:text-5xl">
            Lo que hay, <span className="serif-accent normal-case">lo que se prueba y lo que viene</span>
          </h2>
          <p className="mt-3 max-w-2xl text-sm text-ink-2">BackOffice es un proyecto en desarrollo y validación. Preferimos decirte con claridad qué funciona hoy.</p>
          <div className="mt-8 grid gap-4 lg:grid-cols-3">
            {STATUS.map((c, i) => (
              <article key={c.title} className={`flex flex-col border-2 border-ink p-5 ${i === 0 ? 'bg-ink text-bone' : 'bg-paper'}`}>
                <h3 className="display text-3xl">{c.title}</h3>
                <p className={`mt-1 text-xs ${i === 0 ? 'text-line' : 'text-ink-3'}`}>{c.note}</p>
                <ul className="mt-4 space-y-2 text-sm">
                  {c.items.map((it) => <li key={it} className={`border-t pt-2 ${i === 0 ? 'border-ink-2' : 'border-line'}`}>{it}</li>)}
                </ul>
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
                Describe tu negocio y revisa tu cuenta armada. Si prefieres hablar antes, escríbenos.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link to="/registro" className="inline-flex items-center gap-2 bg-bone px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-ink hover:bg-paper">
                <Sparkles size={16} /> Crea tu cuenta
              </Link>
              <Link to="/contacto" className="inline-flex items-center gap-2 border-2 border-bone px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-ink-2">
                Contacto
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t-2 border-ink">
        <div className="mx-auto grid max-w-6xl gap-6 px-4 py-8 text-xs text-ink-3 md:grid-cols-[1.4fr_1fr_1fr] md:px-6">
          <div>
            <p className="display text-xl leading-none text-ink">BackOffice<span className="text-ok">.</span></p>
            <p className="mt-2 max-w-sm">
              CRM SaaS multiempresa en desarrollo. Servicio prestado por {RESPONSABLE}, persona natural, desde {CIUDAD.split(',')[0]}, Colombia.
            </p>
            <p className="mt-2">© {new Date().getFullYear()} BackOffice</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="kicker">Contacto</p>
            <a href={waLink()} target="_blank" rel="noreferrer" className="hover:underline">WhatsApp {WA_TEXT}</a>
            <a href={mailLink()} className="hover:underline">{EMAIL}</a>
          </div>
          <div className="flex flex-col gap-1">
            <p className="kicker">Legal</p>
            <LegalFooterLinks className="flex-col gap-y-1" />
          </div>
        </div>
      </footer>
    </div>
  );
}
