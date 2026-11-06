import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { Badge, Button, Card, Field, Input } from './ui';

/**
 * IA de prueba de BackOffice para una empresa (solo plataforma). Con nuestras
 * llaves (Gemini, Groq, Cerebras, OpenRouter) para que pruebe Creative, Ads y
 * los resúmenes antes de tener su propia IA. Nunca está activa por defecto.
 */

interface TrialStatus {
  trial: { until: string; dailyLimit: number; authorizedBy: string; authorizedAt: string; note?: string } | null;
  active: boolean;
  expired: boolean;
  usageToday: number;
  source: 'EMPRESA' | 'GENERICA' | 'NINGUNA';
  defaults: { days: number; dailyLimit: number; maxDays: number; maxDailyLimit: number };
  covers: string[];
  notice: string;
}

export default function AiTrialCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const key = ['ai-trial', companyId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<TrialStatus>(`/platform/companies/${companyId}/ai-trial`) });
  const [days, setDays] = useState('');
  const [daily, setDaily] = useState('');
  const [note, setNote] = useState('');

  const authorize = useMutation({
    mutationFn: () => api.put<TrialStatus>(`/platform/companies/${companyId}/ai-trial`, {
      days: Number(days || data?.defaults.days), dailyLimit: Number(daily || data?.defaults.dailyLimit), note: note.trim() || undefined,
    }),
    onSuccess: (r) => { queryClient.setQueryData(key, r); toast.success(`IA de prueba activa hasta el ${fmtDate(r.trial!.until)}`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo autorizar'),
  });
  const revoke = useMutation({
    mutationFn: () => api.delete<TrialStatus>(`/platform/companies/${companyId}/ai-trial`),
    onSuccess: (r) => { queryClient.setQueryData(key, r); toast.success('IA de prueba desactivada'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo desactivar'),
  });

  if (!data) return <Card kicker="Para que la empresa pruebe" title="IA de prueba"><p className="text-sm text-ink-3">Cargando…</p></Card>;
  const t = data.trial;
  return (
    <Card
      kicker="Para que la empresa pruebe"
      title="IA de prueba"
      actions={data.active ? <Badge tone="ok">Activa</Badge> : data.expired ? <Badge tone="warn">Vencida</Badge> : <Badge tone="neutral">Sin autorizar</Badge>}
    >
      <div className="space-y-4 text-sm">
        <p className="text-ink-2">
          Usa nuestras llaves (Gemini, Groq, Cerebras y OpenRouter) para que la empresa vea Creative y Ads con IA antes de asignarle una cuenta paga.
          Nunca está activa por defecto y se apaga sola al vencer.
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink-3">
          {data.covers.map((c) => <li key={c}>{c}</li>)}
        </ul>
        {data.source === 'EMPRESA' && (
          <p className="border-l-4 border-info pl-2 text-xs">Esta empresa ya tiene IA propia: se usa esa, y la de prueba queda solo de respaldo.</p>
        )}
        {t && (
          <div className="grid grid-cols-2 gap-2 border-2 border-line p-3 text-xs">
            <p><span className="kicker block">Vence</span>{fmtDate(t.until)}</p>
            <p><span className="kicker block">Usos hoy</span>{data.active ? `${data.usageToday} de ${t.dailyLimit}` : '—'}</p>
            <p><span className="kicker block">Autorizó</span>{t.authorizedBy || '—'} · {fmtDate(t.authorizedAt)}</p>
            {t.note && <p><span className="kicker block">Nota</span>{t.note}</p>}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Días" hint={`1 a ${data.defaults.maxDays}`}>
            <Input type="number" min={1} max={data.defaults.maxDays} placeholder={String(data.defaults.days)} value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
          <Field label="Usos al día" hint={`1 a ${data.defaults.maxDailyLimit}`}>
            <Input type="number" min={1} max={data.defaults.maxDailyLimit} placeholder={String(data.defaults.dailyLimit)} value={daily} onChange={(e) => setDaily(e.target.value)} />
          </Field>
        </div>
        <Field label="Nota (opcional)" hint="Ej: demostración del viernes con el dueño">
          <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => authorize.mutate()} disabled={authorize.isPending}>
            {data.active ? 'Renovar desde hoy' : 'Autorizar IA de prueba'}
          </Button>
          {t && <Button size="sm" variant="ghost" onClick={() => revoke.mutate()} disabled={revoke.isPending}>Desactivar</Button>}
        </div>
        <p className="border-t border-line pt-2 text-xs text-ink-3">Lo que ve la empresa: {data.notice}</p>
      </div>
    </Card>
  );
}
