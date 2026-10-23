import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, BarChart3, Check, MessagesSquare, Palette, Plus, Trash2, X } from 'lucide-react';
import { Button, Field, Input, Select, Textarea } from '../../../components/ui';
import type { ProductKey, SetupProfile } from '../../../lib/setup';
import type { BusinessBlueprint, SetupProposal } from '../../../lib/types';
import type { Preview } from '../signup-helpers';
import { Chips, EditableCard, Notice, StepActions, StepTitle } from './parts';

/**
 * Paso 3: qué productos activar (ninguno es obligatorio) y la configuración
 * inicial de lo elegido. Lo recomendado viene preseleccionado y se dice por qué.
 */

/** Orden de lanzamiento: Automation y Ads Intelligence primero. */
export const PRODUCT_ORDER: ProductKey[] = ['AUTOMATION', 'ADS', 'CREATIVE'];

export const PRODUCT_CARDS: Record<ProductKey, { name: string; icon: typeof MessagesSquare; tagline: string; examples: string[]; limits: string }> = {
  AUTOMATION: {
    name: 'Automation',
    icon: MessagesSquare,
    tagline: 'Atención y operación con IA',
    examples: [
      'Tu asistente responde por WhatsApp, toma pedidos o reservas y pasa a una persona lo que no sabe.',
      'Contactos, embudo de ventas y seguimiento a quien deja de responder.',
      'Agenda, recordatorios y reporte diario para el dueño.',
    ],
    limits: 'Conectar tu número de WhatsApp lo hacemos contigo. Los procesos con aprobaciones llegan en una próxima fase.',
  },
  ADS: {
    name: 'Ads Intelligence',
    icon: BarChart3,
    tagline: 'Tu publicidad pagada, clara y bajo control',
    examples: [
      'Gasto y resultados de tus campañas en un solo lugar.',
      'Oportunidades de mejora y reglas que piden tu aprobación antes de cambiar algo.',
      'Crear y ajustar campañas sin salir de BackOffice.',
    ],
    limits: 'Hoy conecta Meta (Facebook e Instagram); Google y TikTok aún no. El presupuesto de anuncios lo pagas directo a Meta.',
  },
  CREATIVE: {
    name: 'Creative',
    icon: Palette,
    tagline: 'Contenido y diseño para tu marca',
    examples: [
      'Tu marca (colores, logo y tono) guardada en un solo lugar.',
      'Diseños editables para redes y adaptación a varios formatos.',
    ],
    limits: 'No es necesario para empezar: lo puedes sumar cuando quieras.',
  },
};

const TOOLS: Record<string, { title: string; desc: string }> = {
  orders: { title: 'Pedidos y catálogo', desc: 'Tus productos o servicios con precio, pedidos y ventas.' },
  agenda: { title: 'Agenda', desc: 'Citas, cupos o reservas organizados en tu panel.' },
  campaigns: { title: 'Mensajes a tus clientes', desc: 'Envíos por WhatsApp y recordatorio a quien no responde.' },
  production: { title: 'Cocina o taller', desc: 'Cada área ve lo que tiene que preparar, con comandas.' },
  delivery: { title: 'Domicilios en vivo', desc: 'Tus domiciliarios con GPS y link de seguimiento.' },
  menu: { title: 'Menú con QR', desc: 'Tu menú o catálogo para pedir por WhatsApp.' },
  media: { title: 'Galería con precios', desc: 'Fotos o contenido que el asistente vende por el chat.' },
  gerencia: { title: 'Resumen para el dueño', desc: 'Cómo va el negocio, en un vistazo.' },
  analytics: { title: 'Números', desc: 'Conversaciones, ventas y tiempos de respuesta.' },
  automations: { title: 'Conexiones', desc: 'Conectar con tus otros programas.' },
  marketing: { title: 'Contenido para redes', desc: 'Ideas y piezas para tus redes sociales.' },
};

const RUBRO_LABELS: Record<string, string> = {
  COMIDAS: 'Comidas y domicilios',
  SERVICIOS: 'Servicios, citas y cursos',
  VENTAS: 'Tiendas, ventas y comercio',
  WEBCAM: 'Webcam y creadores',
};

/** Cambia la selección y marca qué funciones quedan incluidas (el servidor lo recalcula al crear). */
export function withProducts(setup: SetupProfile, selected: ProductKey[]): SetupProfile {
  const ordered = (['AUTOMATION', 'CREATIVE', 'ADS'] as ProductKey[]).filter((k) => selected.includes(k));
  return {
    ...setup,
    products: { ...setup.products, selected: ordered },
    capabilities: setup.capabilities.map((c) => ({ ...c, included: ordered.includes(c.product) })),
  };
}

export default function ProductsStep(props: {
  preview: Preview;
  setPreview: (p: Preview) => void;
  setup: SetupProfile | null;
  onSetup: (s: SetupProfile) => void;
  error: string | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const { preview, setup } = props;
  const p = preview.proposal;
  const bp = preview.blueprint;
  const setP = (next: Partial<SetupProposal>) => props.setPreview({ ...preview, proposal: { ...preview.proposal, ...next } });
  const setBp = (next: Partial<BusinessBlueprint>) => props.setPreview({ ...preview, blueprint: { ...preview.blueprint, ...next } });
  const selected = setup?.products.selected ?? ['AUTOMATION'];
  const automation = selected.includes('AUTOMATION');
  const toggle = (k: ProductKey) => {
    if (!setup) return;
    props.onSetup(withProducts(setup, selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]));
  };

  return (
    <div className="mx-auto max-w-4xl">
      <StepTitle kicker="Paso 3 · Productos" title="Elige qué vas a usar">
        Puedes elegir uno o varios. Solo se activa lo que marques y puedes sumar productos después.
        {setup?.products.recommended.length ? ' Marcamos lo recomendado según tus respuestas; desmarca lo que no quieras.' : ''}
      </StepTitle>

      {setup ? (
        <fieldset>
          <legend className="sr-only">Productos de BackOffice</legend>
          <div className="grid gap-4 md:grid-cols-3">
            {PRODUCT_ORDER.map((k) => {
              const card = PRODUCT_CARDS[k];
              const on = selected.includes(k);
              const rec = setup.products.recommended.includes(k);
              const reason = setup.products.reasons[k]?.[0];
              const Icon = card.icon;
              return (
                <label
                  key={k}
                  className={clsx(
                    'relative flex cursor-pointer flex-col border-2 p-5 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ink',
                    on ? 'border-ink bg-paper shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]' : 'border-line bg-bone hover:border-ink-3',
                  )}
                >
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(k)} aria-describedby={`prod-${k}-desc`} />
                  <span className="flex items-start justify-between gap-3">
                    <span className={clsx('flex h-10 w-10 items-center justify-center border-2', on ? 'border-ink bg-ink text-bone' : 'border-line text-ink-2')} aria-hidden>
                      <Icon size={18} />
                    </span>
                    <span className={clsx('flex h-6 w-6 items-center justify-center border-2', on ? 'border-ink bg-ink text-bone' : 'border-ink-3 bg-paper')} aria-hidden>
                      {on && <Check size={14} />}
                    </span>
                  </span>
                  <span className="mt-4 text-lg font-semibold">{card.name}</span>
                  <span className="text-sm text-ink-2">{card.tagline}</span>
                  {rec && (
                    <span className="mt-3 border-l-4 border-ok bg-ok-soft px-2.5 py-1.5 text-xs">
                      <b className="text-ok">Recomendado para tu negocio.</b>{reason ? ` ${reason}` : ''}
                    </span>
                  )}
                  <span id={`prod-${k}-desc`} className="mt-3 block flex-1">
                    <span className="sr-only">Sirve para: </span>
                    <ul className="space-y-1.5 text-sm text-ink-2">
                      {card.examples.map((e) => (
                        <li key={e} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden /> {e}</li>
                      ))}
                    </ul>
                    <span className="mt-3 block text-xs text-ink-3">{card.limits}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {props.error && <p role="alert" className="mt-3 text-sm font-semibold text-bad">{props.error}</p>}
        </fieldset>
      ) : (
        <Notice>Tu cuenta se crea con Automation. Podrás sumar Ads Intelligence o Creative después.</Notice>
      )}

      {/* Configuración inicial de lo elegido */}
      <section className="mt-10" aria-labelledby="config-title">
        <h2 id="config-title" className="text-lg font-semibold">Lo que dejamos listo al crear tu cuenta</h2>
        <p className="mb-4 mt-1 text-sm text-ink-2">Lo armamos con tus respuestas. Revisarlo es opcional: todo se puede cambiar después en tu panel.</p>
        {!automation && (
          <div className="mb-3">
            <Notice>Sin Automation no armamos asistente de WhatsApp, embudo ni respuestas rápidas. Tu catálogo sí queda guardado.</Notice>
          </div>
        )}
        <div className="space-y-3">
          {automation && (
            <>
              <EditableCard
                title="Tu asistente de WhatsApp"
                summary={p.assistant ? <>Se llama <b>{p.assistant.name}</b> y saluda así: “{p.assistant.welcome}”</> : 'Lo creamos contigo después'}
              >
                {p.assistant && (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Nombre"><Input value={p.assistant.name} onChange={(e) => setP({ assistant: { ...p.assistant!, name: e.target.value } })} /></Field>
                      <Field label="Cómo habla"><Input value={p.assistant.tone} onChange={(e) => setP({ assistant: { ...p.assistant!, tone: e.target.value } })} /></Field>
                    </div>
                    <Field label="Saludo"><Textarea rows={2} value={p.assistant.welcome} onChange={(e) => setP({ assistant: { ...p.assistant!, welcome: e.target.value } })} /></Field>
                    <Field label="Datos que le pide al cliente" hint="Escribe uno y presiona Enter">
                      <Chips label="Datos que le pide al cliente" items={bp.clientData} onChange={(clientData) => setBp({ clientData })} placeholder="+ agregar dato" />
                    </Field>
                    <Field label="Cómo atiende, paso a paso" hint="Un paso por línea">
                      <Textarea rows={5} value={bp.assistantFlow.join('\n')} onChange={(e) => setBp({ assistantFlow: e.target.value.split('\n').slice(0, 10) })} />
                    </Field>
                  </div>
                )}
              </EditableCard>

              <EditableCard
                title="Herramientas del panel"
                summary={bp.modules.length ? bp.modules.map((m) => TOOLS[m]?.title).filter(Boolean).join(' · ') : 'Solo lo básico: conversaciones, contactos y asistente'}
              >
                <p className="mb-3 text-xs text-ink-3">Conversaciones, contactos, asistente, equipo y facturación siempre van incluidos.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {Object.entries(TOOLS).filter(([key]) => !preview.profile?.hide.includes(key) || bp.modules.includes(key)).map(([key, t]) => {
                    const on = bp.modules.includes(key);
                    const needsOrders = ['production', 'delivery', 'menu'].includes(key) && !bp.modules.includes('orders');
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setBp({ modules: on ? bp.modules.filter((m) => m !== key) : [...bp.modules, key, ...(needsOrders ? ['orders'] : [])] })}
                        className={clsx('flex cursor-pointer items-start gap-3 border-2 p-3 text-left transition-colors', on ? 'border-ink bg-paper' : 'border-line bg-bone hover:border-ink-3')}
                      >
                        <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2', on ? 'border-ink bg-ink text-bone' : 'border-ink-3')} aria-hidden>
                          {on && <Check size={12} />}
                        </span>
                        <span>
                          <span className="block text-sm font-semibold">{t.title}</span>
                          <span className="block text-xs text-ink-3">{t.desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </EditableCard>
            </>
          )}

          <EditableCard
            title={preview.rubro === 'SERVICIOS' ? 'Tus servicios' : preview.rubro === 'COMIDAS' ? 'Tu menú' : 'Tu catálogo'}
            summary={p.products.length ? `${p.products.length} ${p.products.length === 1 ? 'producto' : 'productos'}: ${p.products.slice(0, 3).map((x) => x.name).filter(Boolean).join(', ')}${p.products.length > 3 ? '…' : ''}` : 'Vacío por ahora: lo llenas después en tu panel'}
          >
            <ul className="space-y-2">
              {p.products.map((prod, i) => (
                <li key={i} className="grid grid-cols-[minmax(0,1fr)_110px_auto] items-center gap-2">
                  <Input value={prod.name} placeholder="Nombre" aria-label={`Nombre del producto ${i + 1}`} onChange={(e) => setP({ products: p.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <Input
                    inputMode="numeric"
                    value={prod.price ?? ''}
                    placeholder="Precio"
                    aria-label={`Precio del producto ${i + 1}`}
                    onChange={(e) => {
                      const n = e.target.value.replace(/\D/g, '');
                      setP({ products: p.products.map((x, j) => (j === i ? { ...x, price: n ? Number(n) : null } : x)) });
                    }}
                  />
                  <button type="button" aria-label={`Quitar producto ${i + 1}`} className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setP({ products: p.products.filter((_, j) => j !== i) })}>
                    <Trash2 size={15} />
                  </button>
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setP({ products: [...p.products, { name: '', category: null, price: null, description: null, presentations: [] }] })}>
              <Plus size={13} /> Agregar
            </Button>
          </EditableCard>

          {automation && (
            <>
              <EditableCard
                title="Cómo avanza cada cliente"
                summary={bp.pipeline ? bp.pipeline.stages.map((s) => s.label).join(' → ') : 'Curioso → Interesado → Listo para comprar → Cliente'}
              >
                {bp.pipeline ? (
                  <>
                    <ol className="space-y-2">
                      {bp.pipeline.stages.map((s, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <span className="w-5 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                          <Input value={s.label} aria-label={`Etapa ${i + 1}`} onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
                          <Select
                            value={s.kind}
                            className="!w-32"
                            aria-label={`Tipo de la etapa ${i + 1}`}
                            onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'OPEN' } : x)) } })}
                          >
                            <option value="OPEN">En camino</option>
                            <option value="WON">Compró</option>
                            <option value="LOST">No compró</option>
                          </Select>
                          <button type="button" aria-label={`Quitar etapa ${i + 1}`} className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.filter((_, j) => j !== i) } })}>
                            <Trash2 size={15} />
                          </button>
                        </li>
                      ))}
                    </ol>
                    {bp.pipeline.stages.length < 10 && (
                      <Button size="sm" variant="outline" className="mt-3" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: [...bp.pipeline!.stages, { key: '', label: 'Nueva etapa', kind: 'OPEN' }] } })}>
                        <Plus size={13} /> Etapa
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-ink-3">Usarás estas etapas. Las puedes cambiar después en tu panel.</p>
                )}
              </EditableCard>

              <EditableCard
                title="Más detalles (opcional)"
                summary={`${bp.quickReplies.length} respuestas rápidas · ${p.faqs.length} preguntas frecuentes · ${bp.followUps.length} recordatorios`}
              >
                <div className="space-y-5">
                  <Field label="Tus planes de BackOffice son de" hint="Solo cambia los planes que te mostramos">
                    <Select value={preview.rubro} onChange={(e) => props.setPreview({ ...preview, rubro: e.target.value, rubroLabel: RUBRO_LABELS[e.target.value] })}>
                      {Object.entries(RUBRO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                  </Field>
                  <div>
                    <p className="kicker mb-2">Respuestas rápidas para tu equipo</p>
                    {bp.quickReplies.length === 0 && <p className="text-sm text-ink-3">Las creas después.</p>}
                    <ul className="space-y-1.5 text-sm">
                      {bp.quickReplies.map((r, i) => (
                        <li key={r.shortcut} className="flex items-start justify-between gap-2">
                          <span><span className="font-mono text-xs text-ink-3">/{r.shortcut}</span> {r.title}</span>
                          <button type="button" aria-label={`Quitar respuesta ${r.title}`} className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ quickReplies: bp.quickReplies.filter((_, j) => j !== i) })}><X size={14} /></button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="kicker mb-2">Si el cliente deja de responder</p>
                    {bp.followUps.length === 0 && <p className="text-sm text-ink-3">Sin recordatorios por ahora.</p>}
                    <ul className="space-y-1.5 text-sm">
                      {bp.followUps.map((f, i) => (
                        <li key={i} className="flex items-start justify-between gap-2">
                          <span><span className="text-xs text-ink-3">A las {f.afterHours} h:</span> {f.message}</span>
                          <button type="button" aria-label="Quitar recordatorio" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ followUps: bp.followUps.filter((_, j) => j !== i) })}><X size={14} /></button>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="kicker mb-2">Preguntas que ya sabe responder</p>
                    {p.faqs.length === 0 && <p className="text-sm text-ink-3">Las agregas después.</p>}
                    <ul className="space-y-1.5 text-sm">
                      {p.faqs.map((f, i) => (
                        <li key={i} className="flex items-start justify-between gap-2">
                          <span>{f.question}</span>
                          <button type="button" aria-label="Quitar pregunta" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setP({ faqs: p.faqs.filter((_, j) => j !== i) })}><X size={14} /></button>
                        </li>
                      ))}
                    </ul>
                    {p.schedule && (
                      <p className="mt-3 text-xs text-ink-3">
                        Horario: {p.schedule.days.map((d) => ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d]).join(', ')} · {p.schedule.open}–{p.schedule.close}
                      </p>
                    )}
                  </div>
                </div>
              </EditableCard>
            </>
          )}
        </div>
      </section>

      <StepActions
        back={<Button variant="outline" onClick={props.onBack}><ArrowLeft size={14} /> Atrás</Button>}
        next={<Button onClick={props.onNext} className="!px-5 !py-2.5">Revisar y crear cuenta <ArrowRight size={15} /></Button>}
      />
    </div>
  );
}
