import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CalendarPlus, Check, ChevronDown, Mail, MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtNum, timeAgo } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Stat, Tabs, Textarea } from '../../components/ui';
import PhoneAlerts from './PhoneAlerts';

/**
 * Registros por la web: el embudo completo (quién empezó, hasta dónde llegó,
 * quién abandonó y por qué) y el seguimiento del equipo con cada persona:
 * escribirle, agendar la reunión y llevar notas.
 */

interface SessionRow {
  id: string;
  step: string;
  stepLabel: string;
  state: 'DONE' | 'ABANDONED' | 'ACTIVE';
  answers: number;
  description: string | null;
  businessName: string | null;
  businessType: string | null;
  rubro: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  mode: 'ai' | 'guided' | null;
  aiCalls: number;
  aiTokens: number;
  errors: Array<{ at: string; step: string; message: string }>;
  companyId: string | null;
  referrer: string | null;
  questionNo: number | null;
  answersMap: Record<string, string>;
  link: string | null;
  utmCampaign: string | null;
  g: string | null;
  source: string;
  sourceLabel: string;
  contactPreference: 'TODAY' | 'CALL' | null;
  contactAt: string | null;
  firstContactAt: string | null;
  firstContactBy: string | null;
  responseMinutes: number | null;
  followStatus: string;
  meetingAt: string | null;
  followNotes: string | null;
  followBy: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface FunnelDetail {
  pre: Array<{ type: string; label: string; count: number }>;
  questions: Array<{ n: number; id: string; label: string; viewed: number; answered: number; dropPct: number | null; avgSeconds: number | null }>;
  post: Array<{ type: string; label: string; count: number }>;
  measuredSince: string | null;
}

interface RegistrosData {
  days: number;
  source: string | null;
  funnel: Array<{ step: string; label: string; count: number }>;
  detail: FunnelDetail;
  bySource: Array<{ key: string; label: string; sessions: number; contacts: number; done: number }>;
  response: { contacted: number; waiting: number; avgMinutes: number | null; medianMinutes: number | null; under5InHoursPct: number | null; inHours: number };
  totals: { sessions: number; done: number; abandoned: number; active: number; pendingFollow: number; avgTokens: number; guided: number };
  sessions: SessionRow[];
}

const FOLLOW: Record<string, { label: string; tone: 'neutral' | 'info' | 'warn' | 'ok' | 'bad' | 'ink' }> = {
  NEW: { label: 'Sin contactar', tone: 'bad' },
  CONTACTED: { label: 'Contactado', tone: 'info' },
  MEETING: { label: 'Reunión agendada', tone: 'warn' },
  DEMO_DONE: { label: 'Demo hecha', tone: 'info' },
  WON: { label: 'Cliente', tone: 'ok' },
  LOST: { label: 'No siguió', tone: 'neutral' },
};

const STATE: Record<SessionRow['state'], { label: string; tone: 'ok' | 'bad' | 'warn' }> = {
  DONE: { label: 'Creó su empresa', tone: 'ok' },
  ABANDONED: { label: 'Abandonó', tone: 'bad' },
  ACTIVE: { label: 'En curso', tone: 'warn' },
};

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Evento de Google Calendar listo para guardar (sin conectar cuentas). */
function calendarLink(s: SessionRow, at: string) {
  const start = new Date(at);
  const end = new Date(start.getTime() + 30 * 60e3);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const qs = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Demo BackOffice · ${s.businessName ?? s.contactName ?? 'Registro web'}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: [
      s.contactName && `Contacto: ${s.contactName}`,
      s.phone && `WhatsApp: ${s.phone}`,
      s.email && `Correo: ${s.email}`,
      s.businessType && `Negocio: ${s.businessType}`,
      s.description && `Lo que contó: ${s.description}`,
    ].filter(Boolean).join('\n'),
    ...(s.email ? { add: s.email } : {}),
  });
  return `https://calendar.google.com/calendar/render?${qs}`;
}

/** Primer mensaje de WhatsApp con su nombre y lo que respondió en el registro. */
export function waText(s: Pick<SessionRow, 'state' | 'contactName' | 'businessName' | 'answersMap'>) {
  const hi = `¡Hola${s.contactName ? ` ${s.contactName.split(' ')[0]}` : ''}!`;
  const what = s.answersMap?.oferta && s.answersMap.oferta !== 'Lo agrego después' ? s.answersMap.oferta : s.answersMap?.tipo?.replace(/^Otro: /, '');
  const wants = s.answersMap?.asistente?.replace(/Otro: /g, '').toLowerCase();
  if (s.state === 'DONE') {
    return `${hi} Soy del equipo de BackOffice. Vi que creaste ${s.businessName ?? 'tu empresa'} y quiero mostrarte cómo funciona y dejar tu WhatsApp conectado. ¿Te queda bien una reunión corta esta semana?`;
  }
  return `${hi} Soy del equipo de BackOffice. Vi que estás armando el asistente de WhatsApp${s.businessName ? ` para ${s.businessName}` : ''}${what ? ` (${what.slice(0, 80)})` : ''}${wants ? ` para ${wants.slice(0, 90)}` : ''}. ¿Te ayudo a dejarlo funcionando? Toma 2 minutos.`;
}

function waLink(s: SessionRow) {
  return `https://wa.me/${s.whatsapp}?text=${encodeURIComponent(waText(s))}`;
}

const SOURCE_FILTERS = [
  { key: 'ALL', label: 'Todas las fuentes' },
  { key: 'META_AD', label: 'Anuncio de Meta' },
  { key: 'GRUPOS', label: 'Grupos (todas las ciudades)' },
  { key: 'ORGANIC', label: 'Orgánico' },
  { key: 'DIRECT', label: 'Directo' },
];

const minutes = (m: number | null) => (m === null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const seconds = (s: number | null) => (s === null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

const QUESTION_LABELS: Record<string, string> = { tipo: 'Tipo de negocio', oferta: 'Qué vende', asistente: 'Qué hará el asistente', operacion: 'Cómo opera', volumen: 'Clientes al día' };

export default function Registros() {
  const queryClient = useQueryClient();
  const [days, setDays] = useState(30);
  const [filter, setFilter] = useState('TODO');
  const [source, setSource] = useState('ALL');
  const [open, setOpen] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<{ row: SessionRow; at: string; notes: string } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['registros', days, filter, source],
    queryFn: () => api.get<RegistrosData>(`/onboarding/registros?days=${days}&state=${filter}&source=${encodeURIComponent(source)}`),
    refetchInterval: 60_000,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; followStatus?: string; meetingAt?: string | null; followNotes?: string }) =>
      api.patch<SessionRow>(`/onboarding/registros/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['registros'] });
      queryClient.invalidateQueries({ queryKey: ['registros-summary'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !data) return <Loading />;
  const started = data.funnel[0]?.count || 0;

  return (
    <>
      <PageHeader
        kicker="Embudo de la web"
        title="Registros"
        actions={
          <div className="flex flex-wrap gap-2">
            <Select className="!w-56" value={source} onChange={(e) => setSource(e.target.value)} aria-label="Fuente">
              {SOURCE_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
              {data?.bySource.filter((b) => b.key.startsWith('GRUPOS:') || b.key.startsWith('UTM:')).map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </Select>
            <Select className="!w-40" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Rango">
              <option value={7}>Últimos 7 días</option>
              <option value={30}>Últimos 30 días</option>
              <option value={90}>Últimos 90 días</option>
            </Select>
          </div>
        }
      />

      <PhoneAlerts />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="Empezaron" value={fmtNum(data.totals.sessions)} />
        <Stat label="Crearon empresa" value={fmtNum(data.totals.done)} hint={started ? `${Math.round((data.totals.done / started) * 100)}% de los que empezaron` : undefined} />
        <Stat label="Abandonaron" value={fmtNum(data.totals.abandoned)} hint="30 min sin actividad" />
        <Stat label="Por contactar" value={fmtNum(data.totals.pendingFollow)} hint="Terminaron o dejaron contacto" />
        <Stat label="IA por registro" value={`${fmtNum(data.totals.avgTokens)} tokens`} hint={data.totals.guided ? `${data.totals.guided} sin IA (plan B)` : 'Promedio'} />
        <Stat
          label="Primer contacto"
          value={minutes(data.response.medianMinutes)}
          hint={data.response.under5InHoursPct !== null
            ? `${data.response.under5InHoursPct}% en menos de 5 min (horario laboral) · ${data.response.waiting} esperando`
            : `Mediana desde que dejan su contacto · ${data.response.waiting} esperando`}
        />
      </div>

      <Card kicker="Hasta dónde llega la gente" title="Embudo" className="mb-6">
        <ol className="space-y-2">
          {data.funnel.map((f, i) => {
            const pct = started ? Math.round((f.count / started) * 100) : 0;
            const lost = i > 0 ? data.funnel[i - 1].count - f.count : 0;
            return (
              <li key={f.step} className="grid grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-3 text-sm">
                <span className="font-semibold">{f.label}</span>
                <span className="h-6 bg-bone-2">
                  <span className="flex h-full items-center bg-ink px-2 text-xs font-semibold text-bone" style={{ width: `${Math.max(pct, f.count ? 6 : 0)}%` }}>
                    {f.count}
                  </span>
                </span>
                <span className="w-32 text-right text-xs text-ink-3">
                  {pct}%{lost > 0 && <span className="text-bad"> · se fueron {lost}</span>}
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card kicker="Pantalla por pantalla" title="Embudo detallado">
          <FunnelDetailView detail={data.detail} />
        </Card>
        <Card kicker="De dónde vienen" title="Por fuente">
          {data.bySource.length === 0 ? (
            <p className="text-sm text-ink-3">Todavía no hay registros en este rango.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-[0.08em] text-ink-3">
                  <th className="py-1.5 font-semibold">Fuente</th>
                  <th className="py-1.5 text-right font-semibold">Abrieron</th>
                  <th className="py-1.5 text-right font-semibold">Contacto</th>
                  <th className="py-1.5 text-right font-semibold">Empresa</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.bySource.map((b) => (
                  <tr key={b.key} className={clsx(source !== 'ALL' && (b.key === source || (source === 'GRUPOS' && b.key.startsWith('GRUPOS'))) && 'font-semibold')}>
                    <td className="py-1.5">
                      <button type="button" className="cursor-pointer text-left underline-offset-2 hover:underline" onClick={() => setSource(b.key)}>{b.label}</button>
                    </td>
                    <td className="py-1.5 text-right">{b.sessions}</td>
                    <td className="py-1.5 text-right">{b.contacts} <span className="text-xs text-ink-3">({b.sessions ? Math.round((b.contacts / b.sessions) * 100) : 0}%)</span></td>
                    <td className="py-1.5 text-right">{b.done}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <div className="mb-4">
        <Tabs
          active={filter}
          onChange={setFilter}
          tabs={[
            { id: 'TODO', label: 'Por contactar', badge: data.totals.pendingFollow },
            { id: 'DONE', label: 'Crearon empresa' },
            { id: 'ABANDONED', label: 'Abandonaron' },
            { id: 'ACTIVE', label: 'En curso' },
            { id: 'ALL', label: 'Todos' },
          ]}
        />
      </div>

      {data.sessions.length === 0 ? (
        <EmptyState title="Nada por aquí" hint={filter === 'TODO' ? 'Todos los registros están atendidos.' : 'No hay registros en este grupo.'} />
      ) : (
        <ul className="space-y-3">
          {data.sessions.map((s) => {
            const expanded = open === s.id;
            return (
              <li key={s.id} className="border-2 border-ink bg-paper">
                <div className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-base font-semibold">{s.businessName ?? s.contactName ?? 'Sin nombre todavía'}</p>
                      <Badge tone={STATE[s.state].tone}>{STATE[s.state].label}</Badge>
                      <Badge tone={FOLLOW[s.followStatus]?.tone ?? 'neutral'}>{FOLLOW[s.followStatus]?.label ?? s.followStatus}</Badge>
                      {s.mode === 'guided' && <Badge tone="warn">Sin IA</Badge>}
                      <Badge tone="neutral">{s.sourceLabel}</Badge>
                      {s.contactPreference === 'TODAY' && <Badge tone="bad">Pidió que le escriban hoy</Badge>}
                      {s.contactPreference === 'CALL' && <Badge tone="warn">Agendó videollamada</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-ink-2">
                      {s.businessType ? `${s.businessType} · ` : ''}
                      {s.state === 'DONE' ? 'Terminó el registro' : <>Se quedó en <b>{s.stepLabel.toLowerCase()}</b> ({s.answers} respuestas)</>}
                      {' · '}{timeAgo(s.lastSeenAt)}
                    </p>
                    <p className="mt-1 text-sm">
                      {[s.contactName, s.phone, s.email].filter(Boolean).join(' · ') || <span className="text-ink-3">No dejó datos de contacto</span>}
                    </p>
                    {s.meetingAt && (
                      <p className="mt-1 text-sm font-semibold">
                        Reunión: {new Date(s.meetingAt).toLocaleString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    )}
                    {s.contactAt && (
                      <p className={clsx('mt-1 text-xs font-semibold', s.firstContactAt ? 'text-ink-3' : 'text-bad')}>
                        {s.firstContactAt
                          ? `Primer contacto a los ${minutes(s.responseMinutes)}${s.firstContactBy ? ` · ${s.firstContactBy}` : ''}`
                          : `Dejó su contacto ${timeAgo(s.contactAt)} y nadie le ha escrito`}
                      </p>
                    )}
                    {s.errors.length > 0 && <p className="mt-1 text-xs font-semibold text-bad">Vio {s.errors.length} {s.errors.length === 1 ? 'error' : 'errores'}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {s.whatsapp && (
                      <a href={waLink(s)} target="_blank" rel="noopener noreferrer" onClick={() => s.followStatus === 'NEW' && update.mutate({ id: s.id, followStatus: 'CONTACTED' })}>
                        <Button size="sm"><MessageCircle size={13} /> WhatsApp</Button>
                      </a>
                    )}
                    {s.email && (
                      <a href={`mailto:${s.email}?subject=${encodeURIComponent('Tu cuenta de BackOffice')}`}>
                        <Button size="sm" variant="outline"><Mail size={13} /> Correo</Button>
                      </a>
                    )}
                    {s.followStatus === 'NEW' && (s.phone || s.email) && (
                      <Button size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: s.id, followStatus: 'CONTACTED' })}>
                        <Check size={13} /> Contactado
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setMeeting({ row: s, at: toLocalInput(s.meetingAt), notes: s.followNotes ?? '' })}>
                      <CalendarPlus size={13} /> Reunión
                    </Button>
                    <Select
                      className="!w-44 !py-1.5 text-xs"
                      value={s.followStatus}
                      aria-label="Seguimiento"
                      onChange={(e) => update.mutate({ id: s.id, followStatus: e.target.value })}
                    >
                      {Object.entries(FOLLOW).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </Select>
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.id)} className="cursor-pointer p-1 text-ink-3 hover:text-ink" aria-label="Ver detalle">
                      <ChevronDown size={16} className={clsx('transition-transform', expanded && 'rotate-180')} />
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="grid gap-4 border-t-2 border-line bg-bone p-4 text-sm md:grid-cols-2">
                    <div className="space-y-2">
                      {Object.keys(s.answersMap ?? {}).length > 0 ? (
                        <dl className="space-y-1">
                          <dt className="kicker">Lo que respondió</dt>
                          {Object.entries(s.answersMap).map(([k, v]) => (
                            <dd key={k}><span className="text-ink-3">{QUESTION_LABELS[k] ?? k}:</span> {v}</dd>
                          ))}
                          {s.link && <dd><span className="text-ink-3">Instagram o web:</span> {s.link}</dd>}
                        </dl>
                      ) : s.description && <p><span className="kicker block">Lo que contó</span>{s.description}</p>}
                      <p className="text-xs text-ink-3">
                        Empezó {new Date(s.createdAt).toLocaleString('es-CO')} · IA: {s.aiCalls} llamadas, {fmtNum(s.aiTokens)} tokens
                        {` · fuente: ${s.sourceLabel}`}
                        {s.utmCampaign ? ` (${s.utmCampaign})` : ''}
                        {s.referrer ? ` · llegó desde ${s.referrer}` : ''}
                      </p>
                      {s.companyId && <Link to={`/platform/companies/${s.companyId}`} className="text-xs font-semibold underline">Abrir la empresa</Link>}
                    </div>
                    <div className="space-y-2">
                      {s.errors.length > 0 && (
                        <div>
                          <span className="kicker block">Errores que vio</span>
                          <ul className="space-y-1 text-xs">
                            {s.errors.map((e, i) => <li key={i}><span className="text-ink-3">{timeAgo(e.at)} · {e.step}:</span> {e.message}</li>)}
                          </ul>
                        </div>
                      )}
                      {s.followNotes && <p><span className="kicker block">Notas{s.followBy ? ` · ${s.followBy}` : ''}</span>{s.followNotes}</p>}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Modal open={!!meeting} onClose={() => setMeeting(null)} kicker="Seguimiento" title={meeting ? `Reunión con ${meeting.row.businessName ?? meeting.row.contactName ?? 'este registro'}` : ''}>
        {meeting && (
          <div className="space-y-4">
            <Field label="Fecha y hora">
              <Input type="datetime-local" value={meeting.at} onChange={(e) => setMeeting({ ...meeting, at: e.target.value })} />
            </Field>
            <Field label="Notas" hint="Qué necesita, qué le mostraste, próximos pasos">
              <Textarea rows={4} value={meeting.notes} onChange={(e) => setMeeting({ ...meeting, notes: e.target.value })} />
            </Field>
            {meeting.at && (
              <a href={calendarLink(meeting.row, new Date(meeting.at).toISOString())} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm font-semibold underline">
                <CalendarPlus size={14} /> Agregar a Google Calendar (con invitación a su correo)
              </a>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setMeeting(null)}>Cancelar</Button>
              <Button
                disabled={update.isPending}
                onClick={() =>
                  update.mutate(
                    { id: meeting.row.id, meetingAt: meeting.at ? new Date(meeting.at).toISOString() : null, followNotes: meeting.notes },
                    { onSuccess: () => { toast.success('Seguimiento guardado'); setMeeting(null); } },
                  )
                }
              >
                Guardar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

/** Pantalla de entrada → cada pregunta → propuesta y cuenta, con el % que se va en cada fila. */
function FunnelDetailView({ detail }: { detail: FunnelDetail }) {
  const opened = detail.pre[0]?.count ?? 0;
  const Row = ({ label, count, prev, extra }: { label: string; count: number; prev?: number; extra?: string }) => {
    const pct = opened ? Math.round((count / opened) * 100) : 0;
    const lost = prev !== undefined && prev > count ? prev - count : 0;
    return (
      <li className="grid grid-cols-[minmax(0,170px)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <span className="truncate font-semibold" title={label}>{label}</span>
        <span className="h-5 bg-bone-2">
          <span className="flex h-full items-center bg-ink px-2 text-xs font-semibold text-bone" style={{ width: `${Math.max(pct, count ? 6 : 0)}%` }}>{count}</span>
        </span>
        <span className="w-36 text-right text-xs text-ink-3">
          {pct}%{lost > 0 && <span className="text-bad"> · −{lost} ({prev ? Math.round((lost / prev) * 100) : 0}%)</span>}{extra ? ` · ${extra}` : ''}
        </span>
      </li>
    );
  };
  if (!opened && !detail.questions.some((q) => q.viewed)) {
    return <p className="text-sm text-ink-3">Todavía no hay datos: el embudo detallado empieza a contar con el registro nuevo.</p>;
  }
  const lastPre = detail.pre[detail.pre.length - 1]?.count ?? 0;
  return (
    <div className="space-y-5">
      <div>
        <p className="kicker mb-2">Antes de las preguntas</p>
        <ol className="space-y-1.5">
          {detail.pre.map((p, i) => <Row key={p.type} label={p.label} count={p.count} prev={i ? detail.pre[i - 1].count : undefined} />)}
        </ol>
      </div>
      <div>
        <p className="kicker mb-2">Las 5 preguntas</p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-[0.08em] text-ink-3">
              <th className="py-1.5 font-semibold">Pregunta</th>
              <th className="py-1.5 text-right font-semibold">La vieron</th>
              <th className="py-1.5 text-right font-semibold">Respondieron</th>
              <th className="py-1.5 text-right font-semibold">Abandono</th>
              <th className="py-1.5 text-right font-semibold">Tiempo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {detail.questions.map((q) => (
              <tr key={q.n}>
                <td className="py-1.5"><span className="text-ink-3">{q.n}.</span> {q.label}</td>
                <td className="py-1.5 text-right">{q.viewed}</td>
                <td className="py-1.5 text-right">{q.answered}</td>
                <td className={clsx('py-1.5 text-right font-semibold', (q.dropPct ?? 0) >= 30 ? 'text-bad' : (q.dropPct ?? 0) >= 15 ? 'text-warn' : '')}>{q.dropPct === null ? '—' : `${q.dropPct}%`}</td>
                <td className="py-1.5 text-right text-ink-2">{seconds(q.avgSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div>
        <p className="kicker mb-2">Después de las preguntas</p>
        <ol className="space-y-1.5">
          {detail.post.map((p, i) => <Row key={p.type} label={p.label} count={p.count} prev={i ? detail.post[i - 1].count : detail.questions[detail.questions.length - 1]?.answered ?? lastPre} />)}
        </ol>
      </div>
      {detail.measuredSince && <p className="text-xs text-ink-3">Medido desde {new Date(detail.measuredSince).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' })}. Los % son sobre los que cargaron la página.</p>}
    </div>
  );
}
