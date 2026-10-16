import { clsx } from 'clsx';
import { ArrowLeft, Check, Plus, Send, Sparkles, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtMoney } from '../../lib/format';
import type { AuthUser, BusinessBlueprint, InterviewTurn, SetupProposal } from '../../lib/types';
import { Button, Field, Input, Select, Textarea } from '../../components/ui';

/**
 * Registro a la medida (sin plantillas cerradas):
 *  1. Conversemos: la IA entrevista al dueño, una pregunta a la vez.
 *  2. Tu BackOffice: herramientas, proceso, catálogo y asistente propuestos
 *     para SU negocio, todo editable antes de crear la cuenta.
 *  3. Tu cuenta.
 */

const RUBRO_LABELS: Record<string, string> = {
  COMIDAS: 'Comidas y domicilios',
  SERVICIOS: 'Servicios, citas y cursos',
  VENTAS: 'Tiendas, ventas y comercio',
  WEBCAM: 'Webcam y creadores',
};

const TOOLS: Record<string, { title: string; desc: string }> = {
  orders: { title: 'Pedidos y catálogo', desc: 'Productos o servicios con precio, pedidos, clientes y reportes de ventas.' },
  agenda: { title: 'Agenda', desc: 'Citas, cupos, cohortes o visitas con recordatorios automáticos.' },
  campaigns: { title: 'Campañas y seguimiento', desc: 'Mensajes masivos por WhatsApp y recordatorio a quien no responde.' },
  production: { title: 'Producción por áreas', desc: 'Cocina, taller o empaque: cada área ve lo suyo, con comandas.' },
  delivery: { title: 'Domicilios en vivo', desc: 'Domiciliarios con GPS, rutas y link de seguimiento al cliente.' },
  menu: { title: 'Catálogo con QR', desc: 'Menú o catálogo público para pedir por WhatsApp.' },
  media: { title: 'Galería con precios', desc: 'Fotos o contenido que el asistente vende por el chat.' },
  gerencia: { title: 'Reporte a gerencia', desc: 'Resumen para el dueño: ahorro, pendientes y equipo.' },
  analytics: { title: 'Métricas', desc: 'Conversaciones, ventas y tiempos de respuesta.' },
  automations: { title: 'Automatizaciones', desc: 'Flujos con n8n y webhooks hacia tus otros sistemas.' },
  marketing: { title: 'Contenido para redes', desc: 'Planeación de piezas y reels.' },
};

const STARTERS = [
  'Tengo un restaurante de almuerzos con domicilios en Medellín',
  'Vendo ropa para mujer por Instagram y WhatsApp',
  'Somos un centro de certificación en trabajo en alturas',
  'Tengo un consultorio odontológico y agendo citas',
];

type Msg = { role: 'user' | 'assistant'; content: string; note?: string; options?: string[] };

const OPENING = '¡Hola! Soy la consultora de BackOffice. Voy a hacerte unas preguntas cortas para armar tu cuenta a la medida de tu negocio. Para empezar: ¿qué hace tu negocio y a quién le vende?';

interface Preview {
  rubro: string;
  rubroLabel: string;
  company: { name: string; city: string; summary: string };
  proposal: SetupProposal;
  blueprint: BusinessBlueprint;
}

function Section({ title, hint, children, action }: { title: string; hint?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-2 border-ink bg-paper p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {hint && <p className="text-xs text-ink-3">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Chips({ items, onChange, placeholder }: { items: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-1 border-2 border-ink bg-bone px-2 py-1 text-xs font-semibold">
          {it}
          <button type="button" aria-label={`Quitar ${it}`} className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => onChange(items.filter((x) => x !== it))}>
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        className="min-w-[140px] flex-1 border-b-2 border-line bg-transparent px-1 py-1 text-xs outline-none focus:border-ink"
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

export default function Signup() {
  const { user, loading, adopt } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: OPENING }]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [interviewDone, setInterviewDone] = useState(false);
  const [building, setBuilding] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ companyName: '', city: '', name: '', email: '', phone: '', password: '', accept: false });
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = 'Crea tu empresa · BackOffice';
  }, []);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, thinking]);

  if (!loading && user) return <Navigate to="/" replace />;

  const answers = messages.filter((m) => m.role === 'user').length;
  const transcript = () => messages.map(({ role, content }) => ({ role, content }));

  async function answer(text: string) {
    const t = text.trim();
    if (!t || thinking) return;
    const next: Msg[] = [...messages, { role: 'user', content: t }];
    setMessages(next);
    setDraft('');
    setThinking(true);
    try {
      const turn = await api.post<InterviewTurn>('/public/signup/interview', { messages: next.map(({ role, content }) => ({ role, content })) });
      const withNote = next.map((m, i) => (i === next.length - 1 && turn.understood ? { ...m, note: turn.understood } : m));
      if (turn.done) {
        setMessages([...withNote, { role: 'assistant', content: '¡Perfecto! Ya entiendo cómo funciona tu negocio. Voy a armar tu BackOffice a la medida.' }]);
        setInterviewDone(true);
        void build([...withNote.map(({ role, content }) => ({ role, content }))]);
      } else {
        setMessages([...withNote, { role: 'assistant', content: turn.question, options: turn.options }]);
      }
    } catch (e) {
      setMessages(messages);
      setDraft(t);
      toast.error(e instanceof Error ? e.message : 'La IA no respondió, intenta de nuevo');
    } finally {
      setThinking(false);
    }
  }

  async function build(history = transcript()) {
    setBuilding(true);
    try {
      const r = await api.post<Preview>('/public/signup/preview', { messages: history });
      setPreview(r);
      setForm((f) => ({ ...f, companyName: f.companyName || r.company.name, city: f.city || r.company.city }));
      setStep(2);
      window.scrollTo({ top: 0 });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No pudimos armar tu empresa');
      setInterviewDone(false);
    } finally {
      setBuilding(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!preview) return;
    setBusy(true);
    try {
      const res = await api.post<{ token: string; user: AuthUser }>('/public/signup', {
        messages: transcript(),
        rubro: preview.rubro,
        proposal: preview.proposal,
        blueprint: preview.blueprint,
        company: { name: form.companyName, city: form.city },
        admin: { name: form.name, email: form.email, phone: form.phone, password: form.password },
        acceptTerms: form.accept,
      });
      adopt(res.token, res.user);
      toast.success('¡Tu empresa quedó creada!');
      navigate('/app/bienvenida', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No pudimos crear tu cuenta');
    } finally {
      setBusy(false);
    }
  }

  const p = preview?.proposal;
  const bp = preview?.blueprint;
  const setP = (next: Partial<SetupProposal>) => preview && setPreview({ ...preview, proposal: { ...preview.proposal, ...next } });
  const setBp = (next: Partial<BusinessBlueprint>) => preview && setPreview({ ...preview, blueprint: { ...preview.blueprint, ...next } });
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');

  return (
    <div className="min-h-screen bg-bone text-ink">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5 md:px-6">
        <Link to="/" className="display text-2xl leading-none">
          BackOffice<span className="text-ok">.</span>
        </Link>
        <Link to="/login" className="text-xs font-semibold uppercase tracking-[0.08em] hover:underline">
          Ya tengo cuenta
        </Link>
      </header>

      <main className="mx-auto max-w-6xl px-4 pb-16 md:px-6">
        <ol className="mb-6 flex flex-wrap gap-2 text-[11px] font-semibold uppercase tracking-[0.1em]">
          {['Conversemos', 'Tu BackOffice', 'Tu cuenta'].map((label, i) => (
            <li
              key={label}
              className={clsx('flex items-center gap-2 border-2 px-3 py-1.5', step === i + 1 ? 'border-ink bg-ink text-bone' : step > i + 1 ? 'border-ink bg-paper' : 'border-line text-ink-3')}
            >
              {step > i + 1 ? <Check size={12} /> : <span>{i + 1}</span>} {label}
            </li>
          ))}
        </ol>

        {/* ── 1. Entrevista ── */}
        {step === 1 && (
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
            <section className="flex h-[min(680px,calc(100vh-170px))] flex-col border-2 border-ink bg-paper shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]">
              <header className="flex items-center justify-between border-b-2 border-ink px-5 py-3">
                <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} /> Tu consultora de BackOffice</p>
                <span className="text-[11px] text-ink-3">{answers === 0 ? 'Unas 5 preguntas' : `Respuesta ${answers}`}</span>
              </header>
              <div ref={scroll} className="flex-1 space-y-4 overflow-y-auto bg-bone p-5">
                {messages.map((m, i) => (
                  <div key={i} className={clsx('flex flex-col', m.role === 'user' ? 'items-end' : 'items-start')}>
                    <p className={clsx('max-w-[85%] whitespace-pre-wrap border-2 px-4 py-2.5 text-[15px] leading-snug', m.role === 'user' ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper')}>
                      {m.content}
                    </p>
                    {m.note && <p className="mt-1 max-w-[85%] text-right text-[11px] italic text-ink-3">Entendí: {m.note}</p>}
                  </div>
                ))}
                {(thinking || building) && (
                  <p className="text-xs italic text-ink-3">{building ? 'Armando tu BackOffice a la medida… (unos segundos)' : 'Pensando…'}</p>
                )}
              </div>
              {!interviewDone && (
                <div className="border-t-2 border-ink p-3">
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {(answers === 0 ? STARTERS : lastAssistant?.options ?? []).map((o) => (
                      <button
                        key={o}
                        type="button"
                        disabled={thinking}
                        onClick={() => (answers === 0 ? setDraft(o) : answer(o))}
                        className="cursor-pointer border border-ink bg-paper px-2.5 py-1 text-xs hover:bg-bone-2 disabled:opacity-40"
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      answer(draft);
                    }}
                  >
                    <Textarea
                      rows={2}
                      value={draft}
                      maxLength={1200}
                      disabled={thinking}
                      placeholder={answers === 0 ? 'Cuéntalo con tus palabras…' : 'Escribe tu respuesta o elige una opción'}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          answer(draft);
                        }
                      }}
                    />
                    <Button type="submit" disabled={!draft.trim() || thinking} aria-label="Enviar"><Send size={15} /></Button>
                  </form>
                </div>
              )}
              {interviewDone && !building && !preview && (
                <div className="border-t-2 border-ink p-3">
                  <Button className="w-full" onClick={() => build()}>Reintentar armar mi BackOffice</Button>
                </div>
              )}
            </section>
            <aside className="space-y-4">
              <h1 className="display text-5xl leading-none">
                Tu negocio, <span className="serif-accent normal-case">a tu manera.</span>
              </h1>
              <p className="text-sm text-ink-2">
                No te encasillamos en una plantilla: la IA te pregunta cómo trabajas y arma tus herramientas, tu proceso de venta y tu asistente.
                Al final lo revisas y lo cambias como quieras.
              </p>
              {answers >= 2 && !interviewDone && (
                <Button variant="outline" className="w-full" disabled={thinking || building} onClick={() => { setInterviewDone(true); void build(); }}>
                  <Sparkles size={14} /> Ya te conté suficiente, armarlo
                </Button>
              )}
            </aside>
          </div>
        )}

        {/* ── 2. Plano a la medida ── */}
        {step === 2 && preview && p && bp && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0 flex-1">
                <p className="kicker">Tu BackOffice a la medida · todo se puede cambiar</p>
                <input
                  className="display w-full bg-transparent text-4xl outline-none md:text-5xl"
                  value={form.companyName}
                  placeholder="Nombre de tu empresa"
                  onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  aria-label="Nombre de tu empresa"
                />
                <input
                  className="serif-accent w-full bg-transparent text-xl text-ink-2 outline-none"
                  value={bp.businessType}
                  placeholder="Tipo de negocio"
                  onChange={(e) => setBp({ businessType: e.target.value })}
                  aria-label="Tipo de negocio"
                />
              </div>
              <Field label="Tus planes son de" hint="Solo define los precios que ves">
                <Select value={preview.rubro} onChange={(e) => setPreview({ ...preview, rubro: e.target.value, rubroLabel: RUBRO_LABELS[e.target.value] })}>
                  {Object.entries(RUBRO_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
            </div>

            {bp.needs.length > 0 && (
              <Section title="Lo que necesitas y cómo lo resolvemos">
                <div className="grid gap-3 md:grid-cols-2">
                  {bp.needs.map((n, i) => (
                    <div key={i} className="relative border-2 border-line bg-bone p-3 pr-8 text-sm">
                      <p className="font-semibold">{n.title}</p>
                      <p className="mt-1 text-ink-2">{n.solution}</p>
                      <button type="button" aria-label="Quitar" className="absolute right-2 top-2 cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ needs: bp.needs.filter((_, j) => j !== i) })}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section title="Tus herramientas" hint="Prende solo lo que vas a usar. Conversaciones, contactos, asistente IA, equipo y facturación siempre van incluidos.">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Object.entries(TOOLS).map(([key, t]) => {
                  const on = bp.modules.includes(key);
                  const needsOrders = ['production', 'delivery', 'menu'].includes(key) && !bp.modules.includes('orders');
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setBp({ modules: on ? bp.modules.filter((m) => m !== key) : [...bp.modules, key, ...(needsOrders ? ['orders'] : [])] })}
                      className={clsx('flex cursor-pointer items-start gap-3 border-2 p-3 text-left transition-colors', on ? 'border-ink bg-ink text-bone' : 'border-line bg-bone hover:border-ink')}
                    >
                      <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border-2', on ? 'border-bone bg-bone text-ink' : 'border-ink')}>
                        {on && <Check size={12} />}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{t.title}</span>
                        <span className={clsx('block text-xs', on ? 'text-line' : 'text-ink-3')}>{t.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <div className="grid gap-5 lg:grid-cols-2">
              <Section
                title="Tu proceso de venta"
                hint="Las etapas por las que pasa cada cliente en tu tablero"
                action={bp.pipeline && bp.pipeline.stages.length < 10 && (
                  <Button size="sm" variant="ghost" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: [...bp.pipeline!.stages, { key: '', label: 'Nueva etapa', kind: 'OPEN' }] } })}>
                    <Plus size={12} /> Etapa
                  </Button>
                )}
              >
                {bp.pipeline ? (
                  <ol className="space-y-1.5">
                    {bp.pipeline.stages.map((s, i) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-5 text-right text-xs tabular-nums text-ink-3">{i + 1}</span>
                        <Input
                          value={s.label}
                          className="!py-1.5 text-sm"
                          onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })}
                        />
                        <Select
                          value={s.kind}
                          className="!w-28 !py-1.5 text-xs"
                          onChange={(e) => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.map((x, j) => (j === i ? { ...x, kind: e.target.value as 'OPEN' } : x)) } })}
                        >
                          <option value="OPEN">En curso</option>
                          <option value="WON">Ganado</option>
                          <option value="LOST">Perdido</option>
                        </Select>
                        <button type="button" aria-label="Quitar etapa" className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setBp({ pipeline: { ...bp.pipeline!, stages: bp.pipeline!.stages.filter((_, j) => j !== i) } })}>
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-ink-3">Usarás el proceso estándar: curioso → potencial → caliente → cliente.</p>
                )}
              </Section>

              <Section
                title={preview.rubro === 'SERVICIOS' ? 'Tus servicios' : preview.rubro === 'COMIDAS' ? 'Tu menú' : 'Tu catálogo'}
                hint="Lo que el asistente puede ofrecer, con precio"
                action={<Button size="sm" variant="ghost" onClick={() => setP({ products: [...p.products, { name: '', category: null, price: null, description: null, presentations: [] }] })}><Plus size={12} /> Agregar</Button>}
              >
                {p.products.length === 0 && <p className="text-sm text-ink-3">Agrega tus productos o servicios aquí o después en tu panel.</p>}
                <ul className="space-y-1.5">
                  {p.products.map((prod, i) => (
                    <li key={i} className="grid grid-cols-[minmax(0,1fr)_130px_auto] items-center gap-2">
                      <Input
                        value={prod.name}
                        placeholder="Nombre"
                        className="!py-1.5 text-sm"
                        onChange={(e) => setP({ products: p.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                      />
                      <Input
                        type="number"
                        min={0}
                        value={prod.price ?? ''}
                        placeholder="Precio"
                        className="!py-1.5 text-sm"
                        onChange={(e) => setP({ products: p.products.map((x, j) => (j === i ? { ...x, price: e.target.value === '' ? null : Number(e.target.value) } : x)) })}
                      />
                      <button type="button" aria-label="Quitar" className="cursor-pointer p-1 text-ink-3 hover:text-bad" onClick={() => setP({ products: p.products.filter((_, j) => j !== i) })}>
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>

            {p.assistant && (
              <Section title="Tu asistente" hint="Cómo atiende tu WhatsApp">
                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Nombre"><Input value={p.assistant.name} onChange={(e) => setP({ assistant: { ...p.assistant!, name: e.target.value } })} /></Field>
                      <Field label="Tono"><Input value={p.assistant.tone} onChange={(e) => setP({ assistant: { ...p.assistant!, tone: e.target.value } })} /></Field>
                    </div>
                    <Field label="Saludo"><Textarea rows={2} value={p.assistant.welcome} onChange={(e) => setP({ assistant: { ...p.assistant!, welcome: e.target.value } })} /></Field>
                    <Field label="Datos que le pide al cliente">
                      <Chips items={bp.clientData} onChange={(clientData) => setBp({ clientData })} placeholder="+ agregar dato (Enter)" />
                    </Field>
                  </div>
                  <Field label="Cómo atiende, paso a paso" hint="Un paso por línea">
                    <Textarea
                      rows={8}
                      value={bp.assistantFlow.join('\n')}
                      onChange={(e) => setBp({ assistantFlow: e.target.value.split('\n').slice(0, 10) })}
                    />
                  </Field>
                </div>
              </Section>
            )}

            <div className="grid gap-5 lg:grid-cols-3">
              <Section title="Respuestas rápidas" hint="Para tu equipo: escriben / y salen listas">
                {bp.quickReplies.length === 0 && <p className="text-sm text-ink-3">Las creas después.</p>}
                <ul className="space-y-2 text-sm">
                  {bp.quickReplies.map((r, i) => (
                    <li key={r.shortcut} className="flex items-start justify-between gap-2">
                      <span><span className="font-mono text-xs text-ink-3">/{r.shortcut}</span> {r.title}</span>
                      <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ quickReplies: bp.quickReplies.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Seguimientos automáticos" hint="Si el cliente deja de responder">
                {bp.followUps.length === 0 && <p className="text-sm text-ink-3">Sin seguimientos por ahora.</p>}
                <ul className="space-y-2 text-sm">
                  {bp.followUps.map((f, i) => (
                    <li key={i} className="flex items-start justify-between gap-2">
                      <span><span className="text-xs text-ink-3">A las {f.afterHours} h:</span> {f.message}</span>
                      <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setBp({ followUps: bp.followUps.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
              </Section>
              <Section title="Preguntas que ya sabe responder">
                {p.faqs.length === 0 && <p className="text-sm text-ink-3">Las agregas después.</p>}
                <ul className="space-y-2 text-sm">
                  {p.faqs.map((f, i) => (
                    <li key={i} className="flex items-start justify-between gap-2">
                      <span>{f.question}</span>
                      <button type="button" aria-label="Quitar" className="cursor-pointer text-ink-3 hover:text-bad" onClick={() => setP({ faqs: p.faqs.filter((_, j) => j !== i) })}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
                {p.schedule && (
                  <p className="mt-3 border-t border-line pt-2 text-xs text-ink-3">
                    Horario: {p.schedule.days.map((d) => ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][d]).join(', ')} · {p.schedule.open}–{p.schedule.close}
                  </p>
                )}
              </Section>
            </div>

            <div className="flex flex-wrap justify-between gap-3">
              <Button variant="outline" onClick={() => { setStep(1); setInterviewDone(false); setPreview(null); }}><ArrowLeft size={14} /> Seguir conversando</Button>
              <Button disabled={!form.companyName.trim()} onClick={() => { setStep(3); window.scrollTo({ top: 0 }); }}>Así me gusta, crear mi cuenta</Button>
            </div>
          </div>
        )}

        {/* ── 3. Cuenta ── */}
        {step === 3 && preview && (
          <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
            <form onSubmit={create} className="space-y-4 border-2 border-ink bg-paper p-6 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]">
              <h1 className="display text-4xl">Tu cuenta</h1>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Nombre de la empresa" required>
                  <Input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} required maxLength={80} />
                </Field>
                <Field label="Ciudad">
                  <Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} maxLength={60} />
                </Field>
                <Field label="Tu nombre" required>
                  <Input autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
                </Field>
                <Field label="WhatsApp" required hint="Por aquí te escribimos para dejar todo listo">
                  <Input type="tel" autoComplete="tel" placeholder="300 123 4567" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} required />
                </Field>
                <Field label="Correo" required>
                  <Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
                </Field>
                <Field label="Contraseña" required hint="Mínimo 8 caracteres">
                  <Input type="password" autoComplete="new-password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
                </Field>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={form.accept} onChange={(e) => setForm({ ...form, accept: e.target.checked })} />
                <span>Acepto los términos del servicio y autorizo el tratamiento de mis datos para crear y operar mi cuenta.</span>
              </label>
              <div className="flex flex-wrap justify-between gap-3">
                <Button type="button" variant="outline" onClick={() => setStep(2)}><ArrowLeft size={14} /> Atrás</Button>
                <Button type="submit" disabled={busy || !form.accept}>{busy ? 'Creando tu empresa…' : 'Crear mi empresa'}</Button>
              </div>
            </form>
            <aside className="space-y-3 text-sm">
              <p className="kicker">Qué pasa después</p>
              <ol className="space-y-3">
                <li className="border-l-2 border-ink pl-3"><b>Entras a tu panel</b> con tus herramientas, tu proceso y tu asistente ya armados.</li>
                <li className="border-l-2 border-ink pl-3"><b>Te escribimos por WhatsApp</b> para conectar tu número y probar tu asistente.</li>
                <li className="border-l-2 border-ink pl-3"><b>Eliges tu plan</b> cuando todo esté funcionando. Sin tarjeta para empezar.</li>
              </ol>
              <p className="text-xs text-ink-3">Desde: {fmtMoney(preview.rubro === 'SERVICIOS' ? 129000 : preview.rubro === 'COMIDAS' ? 149000 : preview.rubro === 'WEBCAM' ? 390000 : 199000)}/mes, IVA incluido.</p>
            </aside>
          </section>
        )}
      </main>
    </div>
  );
}
