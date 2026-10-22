import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge, Button, Card, Input, Loading } from '../../../components/ui';
import { OpportunityCard, type Opportunity } from '../../../components/opportunities/Opportunities';
import { useCompanyScope, withScope } from '../shared';

/**
 * Inicio de Creative: primero valor, después configuración.
 * 1) La oportunidad más relevante con su evidencia (o un vacío honesto).
 * 2) ¿Qué necesitas hoy? — entradas por intención, ordenadas por tus datos.
 * 3) Tu avance y lo que BackOffice ya sabe (editable) para no volver a preguntar.
 */

interface Context {
  known: Array<{ key: string; label: string; value: string | null; source: string; confirmed: boolean; editable: boolean }>;
  connections: Array<{ key: string; label: string; connected: boolean; demo?: boolean; why: string }>;
  missing: Array<{ key: string; label: string; why: string; href?: string; editable?: boolean }>;
  steps: Array<{ key: string; label: string; done: boolean }>;
  intents: Array<{ key: string; label: string; hint: string; href: string; available: boolean; needs: string | null }>;
  progress: { firstVisitAt: string | null; firstValueAt: string | null; lastIntent: string | null };
  counts: { openOpportunities: number };
}

export default function CreativeStart({ q }: { q: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useCompanyScope();
  const scope = (p: string) => withScope(p, q);
  const sent = useRef(false);
  const ctx = useQuery({ queryKey: ['creative-context', q], queryFn: () => api.get<Context>(scope('/creative/context')) });
  const opps = useQuery({ queryKey: ['opportunities', 'start', q], queryFn: () => api.get<Opportunity[]>(scope('/opportunities?view=open')) });
  const event = (body: Record<string, string>) => api.post(scope('/creative/events'), body).catch(() => undefined);
  useEffect(() => {
    if (sent.current || !canWrite) return;
    sent.current = true;
    void event({ type: 'visit' });
  }, [canWrite]);
  const top = opps.data?.[0];
  useEffect(() => {
    if (top && top.mode === 'REAL' && canWrite) void event({ type: 'opportunity_opened' });
  }, [top?.id]);
  const detect = useMutation({
    mutationFn: () => api.post(scope('/opportunities/detect')),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['opportunities'] }); queryClient.invalidateQueries({ queryKey: ['creative-context'] }); toast.success('Revisamos tus datos'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (ctx.isLoading || opps.isLoading || !ctx.data) return <Loading />;
  const c = ctx.data;
  const rest = (opps.data ?? []).slice(1, 4);
  const done = c.steps.filter((s) => s.done).length;

  return (
    <div className="space-y-8">
      {/* 1. Lo más relevante hoy */}
      <section>
        <p className="kicker mb-2">Lo más importante hoy</p>
        {top ? (
          <OpportunityCard o={top} scope={scope} canWrite={canWrite} />
        ) : (
          <div className="border-2 border-dashed border-line bg-paper p-5 text-sm">
            <p className="font-semibold">No encontramos nada urgente con evidencia suficiente.</p>
            <p className="mt-1 text-ink-2">Revisamos tus conversaciones, tu embudo, tus pedidos{c.connections.find((x) => x.key === 'ads')?.connected ? ' y tus anuncios' : ''}. Preferimos no mostrarte nada antes que inventar una oportunidad.</p>
            {canWrite && <Button size="sm" variant="outline" className="mt-3" disabled={detect.isPending} onClick={() => detect.mutate()}>{detect.isPending ? 'Revisando…' : 'Revisar de nuevo'}</Button>}
          </div>
        )}
        {rest.length > 0 && (
          <Link to="?tab=oportunidades" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold underline">
            {c.counts.openOpportunities > 1 ? `Ver las ${opps.data!.length} oportunidades abiertas` : 'Ver todas'} <ChevronRight size={14} />
          </Link>
        )}
      </section>

      {/* 2. Entradas por intención */}
      <section>
        <p className="kicker mb-2">¿Qué necesitas hoy?</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {c.intents.map((i) => (
            <button
              key={i.key} type="button" disabled={!i.available}
              onClick={() => { if (canWrite) void event({ type: 'intent', intent: i.key }); navigate(i.href); }}
              className={clsx('group cursor-pointer border-2 bg-paper p-3 text-left transition-colors', i.available ? 'border-ink hover:bg-bone-2' : 'cursor-not-allowed border-line opacity-60')}
            >
              <span className="flex items-start justify-between gap-2 font-semibold">{i.label}<ChevronRight size={16} className="mt-0.5 shrink-0 transition-transform group-hover:translate-x-0.5" /></span>
              <span className="mt-0.5 block text-xs text-ink-3">{i.hint}</span>
              {i.needs && <span className="mt-1 block text-[11px] text-warn">Para esto: {i.needs.toLowerCase()}</span>}
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* 3. Avance */}
        <Card kicker={`${done} de ${c.steps.length}`} title="Tu avance">
          <ol className="space-y-2 text-sm">
            {c.steps.map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <span className={clsx('flex h-5 w-5 items-center justify-center border-2', s.done ? 'border-ok bg-ok text-bone' : 'border-line')}>{s.done && <Check size={12} />}</span>
                <span className={clsx(s.done ? 'text-ink' : 'text-ink-3')}>{s.label}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 h-2 w-full border-2 border-ink bg-bone"><div className="h-full bg-ink transition-all" style={{ width: `${(done / c.steps.length) * 100}%` }} /></div>
          {c.missing.length > 0 && (
            <div className="mt-4 space-y-2 text-sm">
              <p className="kicker">Cuando quieras</p>
              {c.missing.map((m) => (
                <p key={m.key}>{m.href ? <Link to={m.href} className="font-semibold underline">{m.label}</Link> : <b>{m.label}</b>} <span className="text-ink-3">— {m.why}</span></p>
              ))}
            </div>
          )}
        </Card>

        {/* 4. Lo que sabemos */}
        <KnownCard q={q} c={c} canWrite={canWrite} />
      </div>

      {rest.length > 0 && (
        <section>
          <p className="kicker mb-2">También vale la pena</p>
          <div className="space-y-3">{rest.map((o) => <OpportunityCard key={o.id} o={o} scope={scope} canWrite={canWrite} compact />)}</div>
        </section>
      )}
    </div>
  );
}

function KnownCard({ q, c, canWrite }: { q: string; c: Context; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: ({ key, v }: { key: string; v: string | null }) => api.put(withScope(`/creative/context/${key}`, q), { value: v }),
    onSuccess: (data) => { queryClient.setQueryData(['creative-context', q], data); setEditing(null); toast.success('Guardado. No te lo volveremos a preguntar.'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Card kicker="Para no volver a preguntarte" title="Lo que BackOffice sabe">
      <ul className="divide-y divide-line text-sm">
        {c.known.map((k) => (
          <li key={k.key} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="text-ink-3">{k.label}</span>
            {editing === k.key ? (
              <span className="flex gap-1">
                <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} className="!w-48 !py-1" onKeyDown={(e) => e.key === 'Enter' && save.mutate({ key: k.key, v: value })} />
                <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ key: k.key, v: value })}>Guardar</Button>
              </span>
            ) : (
              <span className="flex items-center gap-2 text-right">
                {k.value ? <span>{k.value}</span> : <span className="text-ink-3">Sin dato</span>}
                {k.value && !k.confirmed && <Badge tone="neutral">{k.source}</Badge>}
                {k.confirmed && k.source === 'Corregido por ti' && <Badge tone="ok">Confirmado</Badge>}
                {canWrite && k.editable && <button type="button" className="cursor-pointer text-xs underline" onClick={() => { setEditing(k.key); setValue(k.value ?? ''); }}>{k.value ? 'Corregir' : 'Agregar'}</button>}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="kicker mb-1 mt-4">Conexiones (solo cuando hagan falta)</p>
      <ul className="space-y-1.5 text-sm">
        {c.connections.map((x) => (
          <li key={x.key}>
            <span className="flex items-center gap-2">{x.label} {x.connected ? <Badge tone="ok">Conectado</Badge> : x.demo ? <Badge tone="info">Demostración</Badge> : <Badge tone="neutral">Sin conectar</Badge>}</span>
            {!x.connected && <span className="block text-xs text-ink-3">{x.why}</span>}
          </li>
        ))}
      </ul>
    </Card>
  );
}
