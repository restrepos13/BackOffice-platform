import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Send, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge, Button, Loading, PageHeader } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';
import CheckoutSection from '../../components/CheckoutSection';
import ScheduleCall from '../../components/ScheduleCall';
import TeamQuest from '../../components/TeamQuest';
import { AiCostSummary } from './AiCosts';
import { COMPLEXITY_LABEL, STATUS_LABEL, type SetupProfile } from '../../lib/setup';

/**
 * Primeros pasos: avance real de la configuración, una guía con IA que
 * acompaña y los planes del rubro (la activación la hace el equipo).
 */

interface OnboardingStatus {
  company: { id: string; name: string; status: string; planId: string | null };
  rubro: string;
  rubroLabel: string;
  onboarding: { contactName?: string; businessType?: string; needs?: Array<{ title: string; solution: string }>; assistantFlow?: string[]; clientData?: string[] };
  checklist: { items: Array<{ key: string; label: string; done: boolean; link: string }>; done: number; total: number; percent: number };
  /** Perfil de incorporación (null en empresas anteriores) */
  setup?: SetupProfile | null;
  plans: Array<{ id: string; name: string; priceMonthly: number; currency: string; annualPrice: number; highlight: boolean; minTermMonths: number; features: string[] }>;
  requestedPlan: { name: string; billingCycle: string; amount: number; at: string } | null;
  chatLeft: number;
}

type Msg = { role: 'user' | 'assistant'; content: string };

function GuideChat({ q, name, chatLeft }: { q: string; name: string; chatLeft: number }) {
  const [messages, setMessages] = useState<Msg[]>([
    { role: 'assistant', content: `¡Hola${name ? `, ${name.split(' ')[0]}` : ''}! Soy tu guía de configuración. Pregúntame lo que necesites: qué te falta, cómo cargar tu catálogo o qué plan te conviene.` },
  ]);
  const [draft, setDraft] = useState('');
  const [left, setLeft] = useState(chatLeft);
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);
  const ask = useMutation({
    mutationFn: (history: Msg[]) => api.post<{ reply: string; chatLeft: number }>(withScope('/onboarding/chat', q), { messages: history.slice(1) }),
    onSuccess: (r) => {
      setMessages((m) => [...m, { role: 'assistant', content: r.reply }]);
      setLeft(r.chatLeft);
    },
    onError: (e) => {
      setMessages((m) => m.slice(0, -1));
      toast.error(e instanceof Error ? e.message : 'La guía no respondió');
    },
  });
  const send = (text: string) => {
    const t = text.trim();
    if (!t || ask.isPending) return;
    const next = [...messages, { role: 'user' as const, content: t }];
    setMessages(next);
    setDraft('');
    ask.mutate(next);
  };
  const suggestions = ['¿Qué me falta para empezar?', '¿Qué hacen ustedes y qué hago yo?', '¿Qué plan me conviene?'];
  return (
    <section className="flex h-[520px] flex-col border-2 border-ink bg-paper">
      <header className="flex items-center justify-between border-b-2 border-ink px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-semibold"><Sparkles size={15} /> Guía con IA</p>
        <span className="text-[11px] text-ink-3">{left} mensajes hoy</span>
      </header>
      <div ref={scroll} className="flex-1 space-y-3 overflow-y-auto bg-bone p-4">
        {messages.map((m, i) => (
          <div key={i} className={clsx('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <p className={clsx('max-w-[85%] whitespace-pre-wrap border-2 px-3 py-2 text-sm', m.role === 'user' ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper')}>
              {m.content}
            </p>
          </div>
        ))}
        {ask.isPending && <p className="text-xs italic text-ink-3">Escribiendo…</p>}
      </div>
      {messages.length === 1 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 pt-3">
          {suggestions.map((s) => (
            <button key={s} type="button" onClick={() => send(s)} className="cursor-pointer border border-ink px-2 py-1 text-xs hover:bg-bone-2">
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input
          className="min-w-0 flex-1 border-2 border-ink bg-bone px-3 py-2 text-sm outline-none focus:bg-paper"
          placeholder={left > 0 ? 'Escribe tu pregunta…' : 'Mañana seguimos: escríbenos por WhatsApp'}
          value={draft}
          maxLength={1000}
          disabled={left <= 0}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={!draft.trim() || ask.isPending || left <= 0} aria-label="Enviar"><Send size={14} /></Button>
      </form>
    </section>
  );
}

export default function Onboarding() {
  const { ready, q, canWrite } = useCompanyScope();
  const { data: st, isLoading } = useQuery({
    queryKey: ['onboarding', q],
    queryFn: () => api.get<OnboardingStatus>(withScope('/onboarding', q)),
    enabled: ready,
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !st) return <Loading label="Cargando tus primeros pasos…" />;
  const { checklist } = st;

  return (
    <>
      <PageHeader kicker={`${st.rubroLabel} · ${st.company.status === 'ONBOARDING' ? 'en configuración' : 'activa'}`} title="Primeros pasos" accent={st.company.name} />

      <TeamQuest q={q} compact />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-6">
          <section className="border-2 border-ink bg-paper p-5">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <p className="kicker">Tu avance</p>
                <p className="display text-5xl">{checklist.percent}%</p>
              </div>
              <p className="text-sm text-ink-2">{checklist.done} de {checklist.total} pasos listos</p>
            </div>
            <div className="mt-3 h-3 border-2 border-ink bg-bone">
              <div className="h-full bg-ok transition-all" style={{ width: `${checklist.percent}%` }} />
            </div>
            <ul className="mt-5 divide-y divide-line">
              {checklist.items.map((item) => (
                <li key={item.key} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex items-center gap-3 text-sm">
                    <span className={clsx('flex h-6 w-6 shrink-0 items-center justify-center border-2', item.done ? 'border-ok bg-ok text-bone' : 'border-ink')}>
                      {item.done && <Check size={13} />}
                    </span>
                    <span className={item.done ? 'text-ink-3 line-through' : ''}>{item.label}</span>
                  </span>
                  {!item.done && item.key !== 'plan' && (
                    <Link to={item.link} className="shrink-0 text-xs font-semibold uppercase tracking-wider underline">Ir</Link>
                  )}
                </li>
              ))}
            </ul>
            {st.setup && (
              <div className="mt-5 border-t-2 border-line pt-4">
                <p className="kicker">Tu configuración</p>
                <p className="mt-1 text-sm">
                  {st.setup.business.activity} · complejidad <b>{COMPLEXITY_LABEL[st.setup.complexity.level].toLowerCase()}</b> · usas {st.setup.products.selected.map((k) => ({ AUTOMATION: 'Automation', CREATIVE: 'Creative', ADS: 'Ads Intelligence' })[k]).join(', ')}
                </p>
                <ul className="mt-2 space-y-1">
                  {st.setup.capabilities.filter((c) => c.included).map((c) => (
                    <li key={c.key} className="flex flex-wrap items-start justify-between gap-2 text-xs">
                      <span>{c.label}{c.note ? <span className="block text-ink-3">{c.note}</span> : null}</span>
                      <Badge tone={c.status === 'AVAILABLE' ? 'ok' : c.status === 'PARTIAL' ? 'warn' : 'neutral'}>{STATUS_LABEL[c.status]}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center gap-3 border-2 border-line bg-bone px-3 py-3">
              <ScheduleCall q={q} topic="SETUP" label="Agéndame con un agente" />
              <p className="text-xs text-ink-2">Conectar tu WhatsApp, la inteligencia artificial y las plantillas lo hacemos nosotros contigo en una llamada.</p>
            </div>
          </section>

          {(st.onboarding.needs?.length || st.onboarding.assistantFlow?.length) ? (
            <section className="border-2 border-ink bg-paper p-5">
              <p className="kicker">Tu BackOffice a la medida{st.onboarding.businessType ? ` · ${st.onboarding.businessType}` : ''}</p>
              <div className="mt-3 grid gap-5 md:grid-cols-2">
                {!!st.onboarding.needs?.length && (
                  <div>
                    <p className="mb-2 text-sm font-semibold">Lo que necesitas</p>
                    <ul className="space-y-2 text-sm">
                      {st.onboarding.needs.map((n) => (
                        <li key={n.title} className="border-l-2 border-ok pl-3"><b>{n.title}</b><span className="block text-xs text-ink-2">{n.solution}</span></li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!st.onboarding.assistantFlow?.length && (
                  <div>
                    <p className="mb-2 text-sm font-semibold">Cómo atiende tu asistente</p>
                    <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
                      {st.onboarding.assistantFlow.map((f) => <li key={f}>{f.replace(/^\d+[.)]\s*/, '')}</li>)}
                    </ol>
                    {!!st.onboarding.clientData?.length && (
                      <p className="mt-2 text-xs text-ink-3">Le pide al cliente: {st.onboarding.clientData.join(', ')}.</p>
                    )}
                    <Link to="/app/bots" className="mt-2 inline-block text-xs font-semibold uppercase tracking-wider underline">Ajustar mi asistente</Link>
                  </div>
                )}
              </div>
            </section>
          ) : null}

          <AiCostSummary q={q} />

          <CheckoutSection q={q} canWrite={canWrite} />
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <GuideChat q={q} name={st.onboarding.contactName ?? ''} chatLeft={st.chatLeft} />
        </div>
      </div>
    </>
  );
}
