import { useQuery } from '@tanstack/react-query';
import { ArrowRight, BarChart3, Bell, Building2, CalendarCheck, Check, Clock, FileText, Gift, MessageCircle, Palette, Repeat, ShoppingBag, Sparkles, Truck, UserRound, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../lib/api';
import { HOME, HOME_FAQ, SECTORS } from './site/content';
import { SavingsCalculator } from './site/SavingsCalculator';
import { CtaBand, FaqList, SectionTitle, SiteLayout } from './site/SiteChrome';
import { useSeo } from './site/seo';

export interface PublicPlans {
  plans: Array<{ name: string; tier: string | null; maxLines: number; priceSelf: number; priceManaged: number; includedMetaUsd: number; highlight: boolean; features: string[] }>;
  modes: Record<'SELF' | 'MANAGED', { name: string; short: string }>;
  addons: Array<{ name: string; description: string; price: number; perUnit: string | null; status: 'AVAILABLE' | 'SOON'; included?: boolean }>;
  notices: { numbers: string; meta: string; landing: string; humanOversight: string };
}

const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;

/**
 * Portada pública (antes de iniciar sesión): qué automatiza BackOffice, cuánto
 * ahorra (con los números del visitante), para quién es, qué funciona hoy y
 * cuánto cuesta. Se prerenderiza al compilar (scripts/prerender.mjs) para que
 * buscadores y asistentes de IA lean el texto sin ejecutar JavaScript.
 * No afirma aprobaciones de Meta, Google ni TikTok ni promete resultados.
 */

const PAINS = [
  { icon: Clock, title: 'Horas respondiendo lo mismo', text: 'Precio, horario, ubicación, “¿hay domicilio?”: decenas de veces al día.' },
  { icon: Bell, title: 'Mensajes que se enfrían', text: 'Lo que llega de noche o en la hora pico se responde tarde o nunca.' },
  { icon: FileText, title: 'Datos copiados a mano', text: 'Pedidos y citas pasados del chat a un cuaderno, con errores.' },
  { icon: Wallet, title: 'Plata que no se cobra', text: 'Saldos pendientes y clientes que nadie volvió a contactar.' },
];

const PROCESSES = [
  { icon: MessageCircle, title: 'Atención 24/7', text: 'El asistente de IA responde con tu información y pasa a una persona cuando hace falta.', href: '/automatizacion-de-whatsapp' },
  { icon: ShoppingBag, title: 'Pedidos', text: 'Del chat a la cola del negocio, con productos, dirección y pago, sin copiar nada.', href: '/sectores/restaurantes-y-domicilios' },
  { icon: Truck, title: 'Domicilios', text: 'Asignación, ruta y link de seguimiento en vivo para el cliente.', href: '/sectores/restaurantes-y-domicilios' },
  { icon: CalendarCheck, title: 'Citas y reservas', text: 'Agenda sin dobles reservas, con recordatorios.', href: '/sectores/servicios-con-citas' },
  { icon: Wallet, title: 'Cobranza', text: 'Saldos pendientes y recordatorios de pago por WhatsApp.', href: '/automatizacion-de-procesos' },
  { icon: Repeat, title: 'Reactivación', text: 'Mensajes para los clientes que dejaron de comprar.', href: '/automatizacion-de-procesos' },
  { icon: UserRound, title: 'Seguimiento comercial', text: 'Embudo con etapas: ningún interesado se queda sin respuesta.', href: '/crm-con-whatsapp' },
  { icon: BarChart3, title: 'Reportes', text: 'Ventas, conversaciones y pendientes en un resumen para el dueño.', href: '/automatizacion-de-procesos' },
];

const STEPS = [
  { title: 'Cuéntanos tu negocio', text: 'Escríbelo como se lo contarías a un empleado nuevo: qué vendes, precios, horario.' },
  { title: 'Se arma tu espacio', text: 'Catálogo, horario, preguntas frecuentes y las herramientas de tu sector, listos para revisar.' },
  { title: 'Conectamos tu WhatsApp', text: 'Por la plataforma oficial de WhatsApp Business, contigo. Eliges el plan cuando todo funcione.' },
];

const SECTOR_ICONS = [ShoppingBag, CalendarCheck, MessageCircle, Building2];

const PRODUCTS = [
  { icon: MessageCircle, name: 'Automation', text: 'WhatsApp con IA, clientes, pedidos, citas, cobranza, automatizaciones y reportes.' },
  { icon: Palette, name: 'Creative', text: 'Identidad de marca y diseños editables para redes y anuncios, con aprobación antes de publicar.' },
  { icon: BarChart3, name: 'Ads', text: 'Resultados de tus cuentas de Meta, Google y TikTok junto a lo que pasa en tu WhatsApp.' },
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
    items: ['Meta Ads: resultados, pausar o reanudar y crear anuncios', 'Google Ads: resultados, pausar o reanudar', 'TikTok Ads: resultados, pausar o reanudar', 'Mensajes de Instagram y Messenger', 'Publicación programada en Facebook e Instagram', 'Google Calendar y Google Drive'],
  },
  {
    title: 'Próximamente',
    note: 'En el plan; todavía no disponible.',
    items: ['Crear anuncios en Google Ads y TikTok Ads', 'Llamadas con IA', 'Facturación electrónica DIAN', 'Verificación automática de transferencias'],
  },
];

/** Conversación de ejemplo del hero (texto, no imagen: se ve apenas llega el HTML). */
function ChatMock() {
  const msgs: Array<{ me?: boolean; text: string; tag?: string }> = [
    { text: 'Hola, ¿tienen domicilio a Laureles? ¿Cuánto vale la hamburguesa doble?' },
    { me: true, text: 'Hola. Sí, llegamos a Laureles en 35 a 45 minutos. La doble cuesta $28.000 y el domicilio $5.000. ¿Te la preparo?' },
    { text: 'Sí, una doble sin cebolla. Pago con transferencia.' },
    { me: true, text: 'Listo: 1 doble sin cebolla + domicilio = $33.000. Te dejo los datos para la transferencia y el link para seguir tu pedido.', tag: 'Pedido creado · enviado a cocina' },
  ];
  return (
    <figure className="relative mx-auto w-full max-w-sm">
      <div className="border-2 border-ink bg-paper shadow-[10px_10px_0_0_rgba(26,26,26,0.9)]">
        <div className="flex items-center gap-3 border-b-2 border-ink bg-ink px-4 py-3 text-bone">
          <span aria-hidden className="flex h-8 w-8 items-center justify-center bg-wa font-bold text-ink">B</span>
          <div className="leading-tight">
            <p className="text-sm font-semibold">Tu negocio</p>
            <p className="text-[11px] text-line">Asistente de IA · responde al instante</p>
          </div>
        </div>
        <div className="space-y-2.5 bg-bone-2 p-4">
          {msgs.map((m) => (
            <div key={m.text} className={`flex flex-col ${m.me ? 'items-end' : 'items-start'}`}>
              <p className={`max-w-[85%] border-2 border-ink px-3 py-2 text-[13px] leading-snug ${m.me ? 'bg-ok-soft' : 'bg-paper'}`}>{m.text}</p>
              {m.tag && <span className="mt-1.5 inline-flex items-center gap-1 bg-ink px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-bone"><Check size={11} /> {m.tag}</span>}
            </div>
          ))}
        </div>
      </div>
      <figcaption className="mt-4 text-center text-xs text-ink-3">Conversación de ejemplo. El asistente solo usa los precios y datos que configura el negocio.</figcaption>
    </figure>
  );
}

function PlansSection() {
  const { data } = useQuery({ queryKey: ['public-plans'], queryFn: () => api.get<PublicPlans>('/public/plans'), staleTime: 10 * 60_000 });
  const [mode, setMode] = useState<'SELF' | 'MANAGED'>('MANAGED');
  return (
    <section className="scroll-mt-20 border-y-2 border-ink bg-paper" id="planes">
      <div className="mx-auto max-w-6xl px-4 py-16 md:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <SectionTitle kicker="Planes mensuales en pesos colombianos" title="Planes" accent="claros" />
          {data && data.plans.length > 0 && (
            <div className="mb-8 flex border-2 border-ink" role="radiogroup" aria-label="Modalidad">
              {(['MANAGED', 'SELF'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}
                  className={`cursor-pointer px-4 py-2 text-sm font-semibold ${mode === m ? 'bg-ink text-bone' : 'bg-bone'}`}>
                  {data.modes[m].name}
                </button>
              ))}
            </div>
          )}
        </div>
        {!data || !data.plans.length ? (
          <p className="max-w-2xl text-ink-2">
            Planes mensuales según cuántos números de WhatsApp necesitas, con o sin acompañamiento del equipo. Empiezas sin tarjeta y eliges el plan cuando todo funcione. <Link to="/registro" className="font-semibold underline">Crea tu cuenta</Link> o <Link to="/contacto" className="font-semibold underline">escríbenos</Link> para conocer los precios vigentes.
          </p>
        ) : (
          <>
            <p className="mb-5 max-w-3xl text-sm text-ink-2">{data.modes[mode].short}</p>
            <div className="grid gap-4 md:grid-cols-3">
              {data.plans.map((p) => (
                <article key={p.name} className={`flex flex-col border-2 border-ink bg-bone p-5 ${p.highlight ? 'shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]' : ''}`}>
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
              <p className="flex gap-2 border-2 border-line bg-bone p-3"><Gift size={16} className="mt-0.5 shrink-0" />{data.notices.landing}</p>
              <p className="flex gap-2 border-2 border-line bg-bone p-3"><UserRound size={16} className="mt-0.5 shrink-0" />{data.notices.humanOversight}</p>
              <p className="border-2 border-line bg-bone p-3 text-xs text-ink-2">{data.notices.numbers}</p>
              <p className="border-2 border-line bg-bone p-3 text-xs text-ink-2">{data.notices.meta}</p>
            </div>
            {data.addons.some((a) => a.included) && (
              <div className="mt-8">
                <p className="kicker mb-3">Incluido en todos los planes</p>
                <div className="grid gap-3 md:grid-cols-3">
                  {data.addons.filter((a) => a.included).map((a) => (
                    <div key={a.name} className="border-2 border-ink bg-bone p-4">
                      <p className="font-semibold">{a.name}</p>
                      <p className="mt-1 text-sm text-ink-2">{a.description}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.addons.some((a) => !a.included) && (
              <div className="mt-8">
                <p className="kicker mb-3">Complementos</p>
                <div className="flex flex-wrap gap-2">
                  {data.addons.filter((a) => !a.included).map((a) => (
                    <span key={a.name} title={a.description} className={`inline-flex items-center gap-2 border-2 px-3 py-1.5 text-sm ${a.status === 'SOON' ? 'border-line text-ink-3' : 'border-ink bg-bone'}`}>
                      {a.name}
                      <span className="text-xs">{a.status === 'SOON' ? 'Próximamente' : `${cop(a.price)}/mes${a.perUnit ? ` por ${a.perUnit}` : ''}`}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default function Landing() {
  useSeo(HOME);
  const { hash } = useLocation();
  // Los enlaces /#planes y /#sectores del menú llegan con el ancla: bajar hasta ella
  useEffect(() => {
    if (!hash) return;
    document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <SiteLayout>
      {/* Hero */}
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-10 md:px-6 md:pt-16 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <p className="kicker mb-4">Automatización de procesos con WhatsApp e IA · Colombia</p>
          <h1 className="display text-[clamp(2.6rem,7.4vw,5.6rem)] leading-[0.92]">
            Automatiza tu WhatsApp
            <br />y tu negocio,{' '}
            <span className="serif-accent text-[0.8em] normal-case">y deja de perder tiempo y dinero.</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-ink-2">
            BackOffice responde a tus clientes por WhatsApp con un asistente de IA supervisado por tu equipo, y convierte cada conversación en un proceso ordenado: pedidos, citas, cobros, seguimientos y reportes en un solo panel.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/registro"
              className="inline-flex items-center gap-2 bg-ink px-6 py-3.5 text-sm font-semibold uppercase tracking-[0.08em] text-bone shadow-[6px_6px_0_0_rgba(31,122,61,0.9)] transition-transform hover:-translate-y-0.5"
            >
              <Sparkles size={16} /> Crea tu cuenta
            </Link>
            <a href="#ahorro" className="inline-flex items-center gap-2 border-2 border-ink bg-paper px-6 py-3 text-sm font-semibold uppercase tracking-[0.08em] hover:bg-bone-2">
              Calcula tu ahorro <ArrowRight size={16} />
            </a>
          </div>
          <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-3">
            <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" /> Sin tarjeta para empezar</li>
            <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" /> WhatsApp oficial de Meta</li>
            <li className="flex items-center gap-1.5"><Check size={13} className="text-ok" /> Una persona siempre puede tomar el control</li>
          </ul>
        </div>
        <ChatMock />
      </section>

      {/* El problema */}
      <section className="border-y-2 border-ink bg-ink text-bone">
        <div className="mx-auto max-w-6xl px-4 py-14 md:px-6">
          <p className="kicker !text-line">El costo de atender a mano</p>
          <h2 className="display mt-2 max-w-3xl text-4xl md:text-5xl">
            WhatsApp no es gratis <span className="serif-accent text-[0.82em] normal-case">si alguien lo atiende todo el día.</span>
          </h2>
          <div className="mt-10 grid gap-px border-2 border-ink-2 bg-ink-2 sm:grid-cols-2 lg:grid-cols-4">
            {PAINS.map((p) => (
              <article key={p.title} className="bg-ink p-5">
                <p.icon size={22} strokeWidth={1.8} className="text-wa" />
                <h3 className="mt-4 font-semibold">{p.title}</h3>
                <p className="mt-1 text-sm text-line">{p.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* Procesos */}
      <section id="procesos" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 md:px-6">
        <SectionTitle
          kicker="Qué automatiza"
          title="Cada proceso,"
          accent="del chat a la operación"
          intro="Lo repetitivo lo hace el sistema; tu equipo se queda con lo que necesita criterio. Cada empresa activa solo lo que usa."
        />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {PROCESSES.map((p) => (
            <Link key={p.title} to={p.href} className="group flex flex-col border-2 border-ink bg-paper p-5 transition-shadow hover:shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
              <p.icon size={22} strokeWidth={1.8} />
              <h3 className="mt-4 text-lg font-semibold">{p.title}</h3>
              <p className="mt-1 flex-1 text-sm text-ink-2">{p.text}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.08em]">Ver más <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" /></span>
            </Link>
          ))}
        </div>
      </section>

      {/* Cómo funciona */}
      <section className="border-y-2 border-ink bg-paper">
        <div className="mx-auto max-w-6xl px-4 py-14 md:px-6">
          <SectionTitle kicker="Cómo funciona" title="Empieza hoy," accent="sin consultorías eternas" />
          <ol className="grid gap-0 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className={`py-6 md:px-6 ${i > 0 ? 'border-t-2 border-ink md:border-l-2 md:border-t-0' : 'md:pl-0'}`}>
                <p className="display text-4xl text-ok">{String(i + 1).padStart(2, '0')}</p>
                <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-ink-2">{s.text}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Calculadora */}
      <section id="ahorro" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-16 md:px-6">
        <SectionTitle
          kicker="Ahorro de costos"
          title="Haz la cuenta"
          accent="con tus números"
          intro="Cuánto tiempo y dinero se va hoy en responder WhatsApp a mano, y cuánto podrías liberar automatizando lo repetitivo."
        />
        <SavingsCalculator />
      </section>

      {/* Sectores */}
      <section id="sectores" className="scroll-mt-20 border-y-2 border-ink bg-paper">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <SectionTitle kicker="Sectores" title="Hecho a la medida" accent="de tu negocio" intro="Cada empresa ve solo las herramientas de su tipo de negocio." />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SECTORS.map((s, i) => {
              const Icon = SECTOR_ICONS[i % SECTOR_ICONS.length];
              return (
                <Link key={s.path} to={s.path} className="group flex flex-col border-2 border-ink bg-bone p-5 transition-shadow hover:shadow-[6px_6px_0_0_rgba(26,26,26,0.9)]">
                  <Icon size={22} strokeWidth={1.8} />
                  <h3 className="mt-4 text-lg font-semibold">{s.nav}</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">{s.h1} {s.accent}</p>
                  <span className="mt-4 inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-[0.08em]">Ver solución <ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" /></span>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* Productos */}
      <section className="mx-auto max-w-6xl px-4 py-16 md:px-6">
        <SectionTitle kicker="La plataforma" title="Una plataforma," accent="tres productos" intro="Cada empresa tiene su propio espacio, separado de las demás, y activa solo lo que necesita." />
        <div className="grid gap-4 lg:grid-cols-3">
          {PRODUCTS.map((p, i) => (
            <article key={p.name} className={`flex flex-col border-2 border-ink p-5 ${i === 0 ? 'bg-ink text-bone' : 'bg-paper'}`}>
              <p.icon size={22} strokeWidth={1.8} />
              <h3 className="display mt-4 text-3xl">{p.name}</h3>
              <p className={`mt-1 text-sm ${i === 0 ? 'text-line' : 'text-ink-2'}`}>{p.text}</p>
            </article>
          ))}
        </div>
        <div className="mt-6 grid gap-3 text-sm md:grid-cols-2">
          <p className="border-2 border-ink bg-paper p-4">
            <b>Tú mantienes el control.</b> La IA responde con lo que el negocio configuró y una persona puede tomar cualquier conversación. Las cuentas publicitarias se conectan con tu propio usuario, nunca con tu contraseña, y se desconectan cuando quieras.
          </p>
          <p className="border-2 border-ink bg-paper p-4">
            <b>Sobre las plataformas.</b> Las integraciones con Meta Ads, Google Ads y TikTok Ads están construidas y en pruebas mientras cada plataforma revisa y autoriza la aplicación. BackOffice no está afiliado ni respaldado por Meta, Google ni TikTok.
          </p>
        </div>
      </section>

      {/* Estado */}
      <section id="estado" className="scroll-mt-20 border-t-2 border-ink">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6">
          <SectionTitle kicker="Estado de las funciones" title="Lo que hay," accent="lo que se prueba y lo que viene" intro="BackOffice está en desarrollo y validación con los primeros negocios. Preferimos decirte con claridad qué funciona hoy." />
          <div className="grid gap-4 lg:grid-cols-3">
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
        </div>
      </section>

      <PlansSection />

      <FaqList items={HOME_FAQ} />

      <CtaBand title="Automatiza hoy." />
    </SiteLayout>
  );
}
