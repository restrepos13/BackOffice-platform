import { clsx } from 'clsx';
import { ArrowLeft, ArrowRight, Check, Clock, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import SetupProgress from '../../../components/SetupProgress';
import SetupEditor from '../../../components/setup/SetupEditor';
import { Badge, Button } from '../../../components/ui';
import { COMPLEXITY_LABEL, type CapabilityStatus, type SetupProfile } from '../../../lib/setup';
import type { Preview } from '../signup-helpers';
import { Notice, Panel, StepActions, StepTitle } from './parts';

/**
 * Paso 2: lo que entendimos y lo que proponemos, separando lo disponible hoy
 * de lo que funciona en parte o llega en una próxima fase. No hay cifras ni
 * ahorros inventados: solo lo que el perfil calculado dice.
 */

export const PRODUCT_SHORT: Record<string, string> = { AUTOMATION: 'Automation', ADS: 'Ads Intelligence', CREATIVE: 'Creative' };

const GROUPS: Array<{ status: CapabilityStatus; title: string; hint: string }> = [
  { status: 'AVAILABLE', title: 'Disponible desde el primer día', hint: 'Funciona hoy, una vez configurado.' },
  { status: 'PARTIAL', title: 'Disponible en parte', hint: 'Funciona con límites que te contamos.' },
  { status: 'PLANNED', title: 'En desarrollo', hint: 'Queda registrado; todavía no funciona.' },
];

export function CapabilityGroups({ setup, onlyIncluded = false }: { setup: SetupProfile; onlyIncluded?: boolean }) {
  const caps = setup.capabilities.filter((c) => !onlyIncluded || c.included);
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => {
        const items = caps.filter((c) => c.status === g.status);
        if (!items.length) return null;
        return (
          <div key={g.status}>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="text-sm font-semibold">{g.title}</h3>
              <span className="text-xs text-ink-3">{g.hint}</span>
            </div>
            <ul className="space-y-2">
              {items.map((c) => (
                <li key={c.key} className={clsx('flex gap-3 border-2 px-3 py-2.5', g.status === 'PLANNED' ? 'border-dashed border-line bg-bone' : 'border-line bg-paper')}>
                  <span className={clsx('mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center', g.status === 'AVAILABLE' ? 'bg-ok text-white' : g.status === 'PARTIAL' ? 'bg-warn text-white' : 'border-2 border-line text-ink-3')} aria-hidden>
                    {g.status === 'PLANNED' ? <Clock size={11} /> : <Check size={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{c.label}</span>
                      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{PRODUCT_SHORT[c.product]}</span>
                      {!c.included && <Badge tone="neutral">No incluido en tu selección</Badge>}
                    </span>
                    {c.why && <span className="mt-0.5 block text-xs text-ink-2">Por qué: {c.why}</span>}
                    {c.note && <span className="mt-0.5 block text-xs text-ink-3">{c.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export default function ProposalStep(props: {
  preview: Preview;
  companyName: string;
  onCompanyName: (v: string) => void;
  nameError: string | null;
  setup: SetupProfile | null;
  onSetup: (s: SetupProfile) => void;
  building: boolean;
  buildError: string | null;
  onRegenerate: () => void;
  onCorrectAnswers: () => void;
  onNext: () => void;
}) {
  const { preview, setup } = props;
  const bp = preview.blueprint;
  const [adjusting, setAdjusting] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);

  if (props.building) {
    return (
      <Panel className="p-6">
        <SetupProgress title="Volviendo a armar tu propuesta" steps={['Releyendo tus respuestas', 'Eligiendo tus herramientas', 'Últimos detalles']} running expectedMs={22000} hint="Esto toma entre 10 y 40 segundos." />
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <StepTitle kicker="Paso 2 · Tu propuesta" title="Esto es lo que entendimos">
        Revisa que describa bien tu negocio. Si algo no es así, corrígelo: la propuesta se ajusta sola.
      </StepTitle>

      <div className="space-y-6">
        {preview.mode === 'guided' && (
          <Notice tone="warn">
            Nuestra IA no estuvo disponible, así que armamos la propuesta con preguntas fijas. Es una base correcta pero más sencilla; puedes ajustarla aquí y el equipo te ayuda a afinarla.
          </Notice>
        )}
        {props.buildError && (
          <Notice tone="bad" action={<Button size="sm" onClick={props.onRegenerate}><RotateCcw size={13} /> Reintentar</Button>}>
            {props.buildError} Tu propuesta anterior sigue aquí.
          </Notice>
        )}

        {/* Negocio detectado */}
        <Panel className="p-5 sm:p-6">
          <label htmlFor="company-name" className="kicker">Nombre de tu negocio</label>
          <input
            id="company-name"
            className={clsx('mt-1 w-full border-b-2 bg-transparent pb-1 text-2xl font-semibold outline-none sm:text-3xl', props.nameError ? 'border-bad' : 'border-line focus:border-ink')}
            value={props.companyName}
            placeholder="Escribe el nombre"
            maxLength={80}
            aria-invalid={props.nameError ? true : undefined}
            aria-describedby={props.nameError ? 'company-name-error' : undefined}
            onChange={(e) => props.onCompanyName(e.target.value)}
          />
          {props.nameError && <p id="company-name-error" role="alert" className="mt-1 text-sm font-semibold text-bad">{props.nameError}</p>}
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-3">Tipo de negocio</dt>
              <dd className="font-semibold">{bp.businessType || setup?.business.label || preview.rubroLabel}</dd>
            </div>
            {setup && (
              <>
                <div>
                  <dt className="text-xs text-ink-3">A qué se dedica</dt>
                  <dd className="font-semibold">{setup.business.activity}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-3">Complejidad de la operación</dt>
                  <dd className="font-semibold">{COMPLEXITY_LABEL[setup.complexity.level]}</dd>
                </div>
              </>
            )}
          </dl>
          {setup && setup.complexity.reasons.length > 0 && (
            <p className="mt-2 text-xs text-ink-3">Calculada por: {setup.complexity.reasons.join(' · ')}.</p>
          )}
        </Panel>

        {/* Problemas que resolvemos */}
        {bp.needs.length > 0 && (
          <section aria-labelledby="needs-title">
            <h2 id="needs-title" className="mb-3 text-lg font-semibold">Lo que te proponemos resolver</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {bp.needs.slice(0, 6).map((n, i) => (
                <li key={i} className="border-2 border-line bg-paper p-4">
                  <p className="text-sm font-semibold">{n.title}</p>
                  <p className="mt-1 text-sm text-ink-2">{n.solution}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Funciones con su estado real */}
        {setup && setup.capabilities.length > 0 && (
          <section aria-labelledby="caps-title">
            <h2 id="caps-title" className="mb-1 text-lg font-semibold">Las funciones que usarías</h2>
            <p className="mb-4 text-sm text-ink-2">En el siguiente paso eliges qué productos activar. Cada función dice a cuál pertenece.</p>
            <CapabilityGroups setup={setup} />
          </section>
        )}

        {/* Ajustar */}
        {setup && (
          <section className="border-2 border-line bg-paper">
            <button type="button" aria-expanded={adjusting} onClick={() => setAdjusting((v) => !v)} className="flex w-full cursor-pointer items-center justify-between gap-3 p-4 text-left">
              <span>
                <span className="flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal size={15} aria-hidden /> Ajustar lo que entendimos</span>
                <span className="mt-0.5 block text-xs text-ink-3">Tipo de negocio, qué necesitas, canales, equipo y tareas. La propuesta se recalcula al instante.</span>
              </span>
              <span className="text-xs font-semibold text-ink-2">{adjusting ? 'Cerrar' : 'Abrir'}</span>
            </button>
            {adjusting && (
              <div className="border-t-2 border-line p-4">
                <SetupEditor value={setup} onChange={props.onSetup} mode="client" endpoint="/public/setup/evaluate" hide={['products', 'capabilities']} />
              </div>
            )}
          </section>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <button type="button" onClick={props.onCorrectAnswers} className="cursor-pointer font-semibold underline-offset-2 hover:underline">Corregir mis respuestas</button>
          {confirmRegen ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-ink-2">Se pierden los cambios que hiciste en la propuesta.</span>
              <Button size="sm" variant="outline" onClick={() => { setConfirmRegen(false); props.onRegenerate(); }}>Sí, volver a generar</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRegen(false)}>Cancelar</Button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmRegen(true)} className="flex cursor-pointer items-center gap-1 font-semibold text-ink-2 underline-offset-2 hover:underline">
              <RotateCcw size={13} aria-hidden /> Volver a generar la propuesta
            </button>
          )}
        </div>
      </div>

      <StepActions
        back={<Button variant="outline" onClick={props.onCorrectAnswers}><ArrowLeft size={14} /> Atrás</Button>}
        next={<Button onClick={props.onNext} className="!px-5 !py-2.5">Elegir productos <ArrowRight size={15} /></Button>}
      />
    </div>
  );
}
