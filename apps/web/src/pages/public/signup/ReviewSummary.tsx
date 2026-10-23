import type { ReactNode } from 'react';
import { COMPLEXITY_LABEL, STATUS_LABEL, type SetupProfile } from '../../../lib/setup';
import type { Preview } from '../signup-helpers';
import type { StepNumber } from './parts';
import { PRODUCT_CARDS, PRODUCT_ORDER } from './ProductsStep';

/** Paso 4: resumen de lo que se va a crear, con «Editar» que lleva a cada paso. */

export interface PendingConnection { key: string; label: string; detail: string }

/** Lo que no queda conectado al crear la cuenta y hay que hacer después (sin simular nada). */
export function pendingConnections(setup: SetupProfile | null): PendingConnection[] {
  const selected = setup?.products.selected ?? ['AUTOMATION'];
  const caps = new Set((setup?.capabilities ?? []).filter((c) => c.included).map((c) => c.key));
  const out: PendingConnection[] = [];
  if (selected.includes('AUTOMATION')) out.push({ key: 'whatsapp', label: 'Tu número de WhatsApp', detail: 'Lo conectamos contigo en una llamada corta.' });
  if (caps.has('AGENDA')) out.push({ key: 'calendar', label: 'Google Calendar (opcional)', detail: 'Para ver tus reservas en tu calendario. Se conecta desde Integraciones.' });
  if (selected.includes('ADS')) out.push({ key: 'ads', label: 'Tu cuenta publicitaria de Meta', detail: 'La conectas desde Publicidad cuando entres.' });
  const systems = setup?.answers.integrations ?? [];
  if (systems.length && selected.includes('AUTOMATION')) {
    out.push({ key: 'systems', label: `Tus otros programas (${systems.join(', ')})`, detail: 'No se conectan solos: lo revisamos contigo.' });
  }
  return out;
}

function Row({ title, onEdit, children }: { title: string; onEdit?: () => void; children: ReactNode }) {
  return (
    <div className="border-b-2 border-line px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="kicker">{title}</h3>
        {onEdit && (
          <button type="button" onClick={onEdit} className="cursor-pointer text-xs font-semibold underline-offset-2 hover:underline" aria-label={`Editar: ${title}`}>
            Editar
          </button>
        )}
      </div>
      <div className="mt-1 text-sm">{children}</div>
    </div>
  );
}

export default function ReviewSummary({ preview, setup, companyName, city, onEdit }: {
  preview: Preview;
  setup: SetupProfile | null;
  companyName: string;
  city: string;
  onEdit: (step: StepNumber) => void;
}) {
  const selected = setup?.products.selected ?? ['AUTOMATION'];
  const included = (setup?.capabilities ?? []).filter((c) => c.included);
  const pending = pendingConnections(setup);
  return (
    <section aria-labelledby="summary-title" className="border-2 border-ink bg-paper">
      <h2 id="summary-title" className="border-b-2 border-ink px-4 py-3 text-base font-semibold">Resumen de tu cuenta</h2>
      <Row title="Negocio" onEdit={() => onEdit(2)}>
        <p className="font-semibold">{companyName || 'Sin nombre'}</p>
        <p className="text-ink-2">{[setup?.business.activity || preview.blueprint.businessType, city].filter(Boolean).join(' · ')}</p>
      </Row>
      {setup && (
        <Row title="Perfil detectado" onEdit={() => onEdit(2)}>
          <p>{setup.business.label} · complejidad <b>{COMPLEXITY_LABEL[setup.complexity.level].toLowerCase()}</b></p>
        </Row>
      )}
      <Row title="Productos" onEdit={setup ? () => onEdit(3) : undefined}>
        <ul className="space-y-0.5">
          {PRODUCT_ORDER.filter((k) => selected.includes(k)).map((k) => <li key={k} className="font-semibold">{PRODUCT_CARDS[k].name}</li>)}
        </ul>
      </Row>
      {included.length > 0 && (
        <Row title="Funciones" onEdit={() => onEdit(2)}>
          <ul className="space-y-1">
            {included.map((c) => (
              <li key={c.key} className="flex items-start justify-between gap-2">
                <span>{c.label}</span>
                <span className={c.status === 'AVAILABLE' ? 'shrink-0 text-xs font-semibold text-ok' : c.status === 'PARTIAL' ? 'shrink-0 text-xs font-semibold text-warn' : 'shrink-0 text-xs font-semibold text-ink-3'}>
                  {c.status === 'PLANNED' ? 'En desarrollo' : STATUS_LABEL[c.status]}
                </span>
              </li>
            ))}
          </ul>
        </Row>
      )}
      {pending.length > 0 && (
        <Row title="Se conecta después">
          <ul className="space-y-1.5">
            {pending.map((p) => (
              <li key={p.key}>
                <span className="font-semibold">{p.label}</span>
                <span className="block text-xs text-ink-3">{p.detail}</span>
              </li>
            ))}
          </ul>
        </Row>
      )}
    </section>
  );
}
