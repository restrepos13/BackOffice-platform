import { clsx } from 'clsx';
import { CalendarClock, Check, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { api, postWithRetry } from '../../../lib/api';
import { sessionToken } from '../signup-helpers';

/**
 * Contacto rápido: «Que me escriban hoy» o «Agendar una videollamada de 15
 * min» con los horarios libres del equipo (los mismos de Citas). Aparece en
 * las preguntas (para quien prefiere que lo ayuden) y al final del registro.
 */

interface Slots { days: Array<{ date: string; label: string; slots: Array<{ at: string; label: string }> }> }

export default function QuickContact({ compact = false, phone }: { compact?: boolean; phone?: string }) {
  const [open, setOpen] = useState(!compact);
  const [mode, setMode] = useState<'choose' | 'pick' | 'done'>('choose');
  const [slots, setSlots] = useState<Slots | null>(null);
  const [day, setDay] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function today() {
    setBusy(true);
    setError(null);
    try {
      await postWithRetry('/public/signup/quick-contact', { session: sessionToken(), kind: 'TODAY' }, { tries: 3 });
      setDone(`Listo. Hoy te escribimos por WhatsApp${phone ? ` al ${phone}` : ''}.`);
      setMode('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos guardar tu solicitud. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    setMode('pick');
    setError(null);
    if (slots) return;
    try {
      setSlots(await api.get<Slots>('/public/signup/slots'));
    } catch {
      setError('No pudimos cargar los horarios. Intenta de nuevo en un momento.');
    }
  }

  async function book(at: string, label: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await postWithRetry<{ when: string | null }>('/public/signup/quick-contact', { session: sessionToken(), kind: 'CALL', at }, { tries: 3 });
      setDone(`Quedó agendada ${r.when ?? label}. Te escribimos por WhatsApp con el enlace de la videollamada.`);
      setMode('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos agendar. Elige otra hora.');
      setSlots(null);
      void pick();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="cursor-pointer text-sm font-semibold text-ink-2 underline underline-offset-2 hover:text-ink">
        ¿Prefieres que te ayudemos nosotros?
      </button>
    );
  }

  const current = slots?.days[day];
  return (
    <section className="border-2 border-line bg-paper p-4" aria-labelledby="quick-contact-title">
      <h2 id="quick-contact-title" className="text-sm font-semibold">¿Prefieres hablar con una persona?</h2>
      {mode === 'done' ? (
        <p role="status" className="mt-2 flex items-start gap-2 text-sm text-ok"><Check size={16} className="mt-0.5 shrink-0" aria-hidden /> <span className="text-ink">{done}</span></p>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <button type="button" disabled={busy} onClick={today} className="flex min-h-[48px] cursor-pointer items-center gap-2 border-2 border-ink bg-bone px-3 py-2.5 text-left text-sm font-semibold hover:bg-ink hover:text-bone disabled:opacity-50">
              <MessageCircle size={16} aria-hidden /> Que me escriban hoy
            </button>
            <button type="button" disabled={busy} onClick={pick} aria-pressed={mode === 'pick'} className={clsx('flex min-h-[48px] cursor-pointer items-center gap-2 border-2 border-ink px-3 py-2.5 text-left text-sm font-semibold hover:bg-ink hover:text-bone disabled:opacity-50', mode === 'pick' ? 'bg-ink text-bone' : 'bg-bone')}>
              <CalendarClock size={16} aria-hidden /> Agendar una videollamada de 15 min
            </button>
          </div>
          {mode === 'pick' && (
            <div className="mt-3">
              {!slots && !error && <p className="text-xs text-ink-3">Buscando horarios libres…</p>}
              {slots && !slots.days.length && <p className="text-sm text-ink-2">No hay horarios libres estos días. Toca «Que me escriban hoy» y te buscamos.</p>}
              {slots && !!slots.days.length && (
                <>
                  <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Día">
                    {slots.days.map((d, i) => (
                      <button key={d.date} type="button" role="tab" aria-selected={i === day} onClick={() => setDay(i)} className={clsx('shrink-0 cursor-pointer border-2 px-3 py-1.5 text-xs font-semibold capitalize', i === day ? 'border-ink bg-ink text-bone' : 'border-line bg-bone')}>
                        {d.label}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {current?.slots.map((s) => (
                      <button key={s.at} type="button" disabled={busy} onClick={() => book(s.at, s.label)} className="min-h-[44px] cursor-pointer border-2 border-line bg-bone px-2 py-2 text-sm hover:border-ink disabled:opacity-50">
                        {s.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {error && <p role="alert" className="mt-2 text-xs font-semibold text-bad">{error}</p>}
        </>
      )}
    </section>
  );
}
