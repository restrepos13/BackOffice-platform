import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowRight, Check, Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { withScope } from '../pages/company/shared';
import ScheduleCall from './ScheduleCall';
import SetupProgress, { ProgressBar } from './SetupProgress';
import { Button } from './ui';

/**
 * Primeros pasos de una empresa sin plan, directo en el dashboard: cuatro
 * preguntas de un toque sobre su equipo (con opciones de SU tipo de negocio),
 * una barra que avanza con cada respuesta y, al final, cómo queda su centro de
 * mando y una llamada con un agente para dejarlo listo. Nada de formularios.
 */

interface QuestStatus {
  company: { id: string; name: string; planId: string | null };
  onboarding: { contactName?: string; phone?: string };
  profile: { key: string; label: string; roles: string[]; pains: string[] };
  team: { size?: string; roles?: string[]; whatsappBy?: string; pains?: string[]; doneAt?: string } | null;
}

const SIZES = ['Solo yo', '2 a 3', '4 a 10', '11 a 25', 'Más de 25'];
const WHATSAPP_BY = ['Yo', 'Una persona del equipo', 'Varias personas', 'Nadie fijo, cuando se puede'];
const CHEERS = ['¡Perfecto!', '¡Muy bien!', '¡Vas volando!', '¡Último paso!'];

/** Qué ve cada función en BackOffice (por palabras, sin IA). */
function accessFor(role: string): string {
  const r = role.toLowerCase();
  if (/admin|gerenc|dueñ/.test(r)) return 'Todo el panel';
  if (/venta|asesor|vendedor|inscrip|captaci|atenci|recepci|chatter/.test(r)) return 'Conversaciones, contactos y pedidos';
  if (/cocina|confecci|taller|producci|técnic|tecnic/.test(r)) return 'Su área de trabajo con lo que tiene que preparar';
  if (/domicil|envío|envio|entrega|mensaj/.test(r)) return 'Sus entregas del día';
  if (/bodega|inventario|empaque|repuesto|compras/.test(r)) return 'Pedidos por despachar';
  if (/cuenta|contab|factur|caja|pago|cobr/.test(r)) return 'Cobranza, pagos y reportes';
  if (/redes|foto|marketing|diseñ|diseñ/.test(r)) return 'Campañas y mensajes a clientes';
  if (/agenda|cita|cupo|docente|profesional|estilista|médic|medic|monitor|modelo/.test(r)) return 'Su agenda y sus clientes';
  return 'Lo que necesite: lo ajustamos contigo';
}

/** Qué herramienta resuelve cada dolor. */
function toolFor(pain: string): { tool: string; to: string } {
  const p = pain.toLowerCase();
  if (/cobr|pago|cartera/.test(p)) return { tool: 'Cobranza humanizada', to: '/app/cobranza' };
  if (/seguimiento|no compra|vuelvan|dormid/.test(p)) return { tool: 'Reactivación de clientes', to: '/app/reactivacion' };
  if (/agend|cita|reprogram|huecos|no llegan|recordar/.test(p)) return { tool: 'Agenda con recordatorios', to: '/app/agenda' };
  if (/vendi|cuánto|cuanto|sabe/.test(p)) return { tool: 'Auditor de ventas y reportes', to: '/app/auditor' };
  if (/envío|envio|domicil|despach|bodega/.test(p)) return { tool: 'Pedidos y entregas', to: '/app/orders' };
  if (/redes|publicar/.test(p)) return { tool: 'Campañas por WhatsApp', to: '/app/campaigns' };
  return { tool: 'Tu asistente IA 24/7', to: '/app/bots' };
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={clsx('cursor-pointer border-2 px-4 py-2.5 text-left text-sm transition-transform active:scale-95', on ? 'border-ink bg-ink text-bone' : 'border-ink bg-paper hover:bg-bone-2')}
    >
      {on && <Check size={13} className="mr-1.5 inline" />}{children}
    </button>
  );
}

export default function TeamQuest({ q, compact = false }: { q: string; compact?: boolean }) {
  const queryClient = useQueryClient();
  const { data: st } = useQuery({ queryKey: ['onboarding', q], queryFn: () => api.get<QuestStatus>(withScope('/onboarding', q)) });
  const [step, setStep] = useState(0); // 0 intro · 1-4 preguntas · 5 armando · 6 resultado
  const [size, setSize] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const [whatsappBy, setWhatsappBy] = useState<string | null>(null);
  const [pains, setPains] = useState<string[]>([]);
  const [cheer, setCheer] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.post(withScope('/onboarding/team', q), patch),
    onSuccess: (_r, patch) => { if (patch.done) queryClient.invalidateQueries({ queryKey: ['onboarding'] }); },
  });

  // Retoma donde iba (si ya contestó algo)
  useEffect(() => {
    if (!st?.team || step !== 0) return;
    setSize(st.team.size ?? null);
    setRoles(st.team.roles ?? []);
    setWhatsappBy(st.team.whatsappBy ?? null);
    setPains(st.team.pains ?? []);
    if (st.team.doneAt) setStep(6);
  }, [st?.team]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Armando tu centro de mando": se ve el avance y luego el resultado
  useEffect(() => {
    if (step !== 5) return;
    const t = setTimeout(() => setStep(6), 3800);
    return () => clearTimeout(t);
  }, [step]);

  if (!st || st.company.planId) return null;
  const solo = size === 'Solo yo';
  const roleOptions = [...new Set([...st.profile.roles, ...roles])];
  const pct = step === 0 ? 0 : step >= 5 ? 100 : Math.round(((step - 1) / 4) * 100);

  const next = (patch: Record<string, unknown>, to: number) => {
    save.mutate(patch);
    setCheer(CHEERS[Math.min(to - 2, CHEERS.length - 1)] ?? null);
    setStep(to);
  };

  if (step === 6) {
    const myRoles = (st.team?.roles?.length ? st.team.roles : roles).slice(0, 6);
    const myPains = (st.team?.pains?.length ? st.team.pains : pains).slice(0, 3);
    return (
      <section className="mb-6 border-2 border-ink bg-paper p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="kicker">Tu centro de mando · {st.profile.label}</p>
            <h2 className="display text-3xl">Así queda tu equipo en BackOffice</h2>
          </div>
          {compact && <span className="flex items-center gap-1 text-xs text-ok"><Check size={14} /> Listo</span>}
        </div>
        <div className="mt-4 grid gap-5 md:grid-cols-2">
          <div>
            <p className="mb-2 text-sm font-semibold">{solo ? 'Lo que vas a ver tú' : 'Quién ve qué'}</p>
            <ul className="space-y-1.5 text-sm">
              {(myRoles.length ? myRoles : ['Administración']).map((r) => (
                <li key={r} className="flex items-start justify-between gap-3 border-b border-line pb-1.5">
                  <span className="font-semibold">{r}</span>
                  <span className="text-right text-ink-2">{accessFor(r)}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">Lo que te va a quitar trabajo</p>
            <ul className="space-y-1.5 text-sm">
              {(myPains.length ? myPains : ['Responder rápido']).map((p) => {
                const t = toolFor(p);
                return (
                  <li key={p} className="border-l-2 border-ok pl-3">
                    <span className="block text-ink-2">{p}</span>
                    <Link to={t.to} className="font-semibold underline">{t.tool}</Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3 border-t-2 border-line pt-4">
          <ScheduleCall q={q} topic="SETUP" label="Agéndame para dejar todo listo" defaultPhone={st.onboarding.phone ?? ''} />
          <Link to="/app/bienvenida#planes" className="inline-flex items-center gap-1 text-sm font-semibold underline">Ver planes <ArrowRight size={14} /></Link>
          <p className="w-full text-xs text-ink-3">En la llamada creamos los usuarios de tu equipo y conectamos tu WhatsApp contigo. Tú no haces nada técnico.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6 border-2 border-ink bg-paper p-5" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="kicker flex items-center gap-1.5"><Sparkles size={13} /> Arma tu centro de mando · 1 minuto</p>
        {step > 0 && step < 5 && <p className="text-xs text-ink-3">Pregunta {step} de 4</p>}
      </div>
      <ProgressBar pct={pct} className="mt-2" />
      {cheer && step > 1 && step < 5 && <p className="mt-2 text-sm font-semibold text-ok">{cheer}</p>}

      {step === 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="display text-3xl">{st.onboarding.contactName ? `${st.onboarding.contactName.split(' ')[0]}, ` : ''}armemos tu centro de mando</h2>
            <p className="mt-1 text-sm text-ink-2">Cuatro preguntas de un toque sobre tu equipo y te mostramos cómo queda {st.company.name} organizada en BackOffice.</p>
          </div>
          <Button onClick={() => setStep(1)}>Empezar <ArrowRight size={14} /></Button>
        </div>
      )}

      {step === 1 && (
        <div className="mt-4">
          <h2 className="display text-2xl">¿Cuántas personas trabajan contigo?</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {SIZES.map((s) => <Chip key={s} on={size === s} onClick={() => { setSize(s); next({ size: s }, 2); }}>{s}</Chip>)}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="mt-4">
          <h2 className="display text-2xl">{solo ? '¿Qué haces tú en el día a día?' : '¿Qué hacen en tu equipo?'}</h2>
          <p className="text-sm text-ink-3">Toca todas las que apliquen.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {roleOptions.map((r) => (
              <Chip key={r} on={roles.includes(r)} onClick={() => setRoles((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r]))}>{r}</Chip>
            ))}
            <form className="flex items-stretch" onSubmit={(e) => { e.preventDefault(); const v = other.trim(); if (v && !roles.includes(v)) setRoles((x) => [...x, v]); setOther(''); }}>
              <input value={other} onChange={(e) => setOther(e.target.value)} maxLength={40} placeholder="Otra función" className="w-36 border-2 border-r-0 border-ink bg-bone px-3 text-sm outline-none" />
              <button type="submit" aria-label="Agregar función" className="cursor-pointer border-2 border-ink bg-paper px-2 hover:bg-bone-2"><Plus size={14} /></button>
            </form>
          </div>
          <div className="mt-4 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>Atrás</Button>
            <Button disabled={!roles.length} onClick={() => next({ roles }, 3)}>Siguiente <ArrowRight size={14} /></Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="mt-4">
          <h2 className="display text-2xl">¿Quién responde hoy el WhatsApp?</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(solo ? WHATSAPP_BY.filter((w) => w === 'Yo' || w.startsWith('Nadie')) : WHATSAPP_BY).map((w) => (
              <Chip key={w} on={whatsappBy === w} onClick={() => { setWhatsappBy(w); next({ whatsappBy: w }, 4); }}>{w}</Chip>
            ))}
          </div>
          <Button variant="ghost" className="mt-3" onClick={() => setStep(2)}>Atrás</Button>
        </div>
      )}

      {step === 4 && (
        <div className="mt-4">
          <h2 className="display text-2xl">¿Qué te quita más tiempo?</h2>
          <p className="text-sm text-ink-3">Elige hasta tres.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {st.profile.pains.map((p) => (
              <Chip key={p} on={pains.includes(p)} onClick={() => setPains((x) => (x.includes(p) ? x.filter((y) => y !== p) : x.length >= 3 ? x : [...x, p]))}>{p}</Chip>
            ))}
          </div>
          <div className="mt-4 flex justify-between">
            <Button variant="ghost" onClick={() => setStep(3)}>Atrás</Button>
            <Button disabled={!pains.length} onClick={() => { save.mutate({ pains, done: true }); setStep(5); }}>Armar mi centro de mando <ArrowRight size={14} /></Button>
          </div>
        </div>
      )}

      {step === 5 && (
        <SetupProgress
          className="mt-4"
          title="Armando tu centro de mando"
          steps={['Ubicando a tu equipo', 'Definiendo quién ve qué', 'Eligiendo tus herramientas', 'Preparando tu panel']}
          running
          expectedMs={3600}
        />
      )}
    </section>
  );
}
