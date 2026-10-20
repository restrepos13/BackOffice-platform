import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtNum, fmtUsd, STAGE_LABELS } from '../../lib/format';
import type {
  Appointment, Bot, Company, CompanyMetrics, FollowUp, Integration, MediaAsset,
} from '../../lib/types';
import { Badge, Button, Card, Loading, PageHeader, Stat, statusTone } from '../../components/ui';
import { BarsChart, MessagesChart } from '../../components/charts';
import { PickCompany, useCompanyScope, withScope } from './shared';
import ScheduleCall from '../../components/ScheduleCall';
import { ProgressBar } from '../../components/SetupProgress';
import TeamQuest from '../../components/TeamQuest';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Buenos días';
  if (hour < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

/** Primeros pasos: lo técnico lo hace un agente contigo; lo tuyo, en un clic. */
function SetupChecklist({
  company,
  integrations,
  bots,
  media,
  q,
}: {
  company?: Company;
  integrations?: Integration[];
  bots?: Bot[];
  media?: MediaAsset[];
  q: string;
}) {
  const lines = (integrations ?? []).filter((i) => i.type === 'WHATSAPP');
  const steps: Array<{ label: string; hint: string; done: boolean; to: string; who: 'agent' | 'you'; optional?: boolean }> = [
    ...(company?.aiBillingMode === 'PLATFORM'
      ? []
      : [{
          label: 'Conectar tu inteligencia artificial',
          hint: 'Lo hacemos contigo en la llamada: no tienes que buscar ni copiar nada.',
          done: !!company?.hasDeepinfraKey,
          to: '/app/settings',
          who: 'agent' as const,
        }]),
    {
      label: 'Conectar tu WhatsApp',
      hint: 'Tu agente lo deja funcionando contigo. Solo ten tu celular a la mano.',
      done: lines.some((l) => l.status === 'CONNECTED'),
      to: '/app/integrations',
      who: 'agent',
    },
    {
      label: 'Conocer a tu asistente',
      hint: 'Ya lo armamos con lo que nos contaste. Míralo y cámbiale lo que quieras.',
      done: (bots ?? []).some((b) => (b.systemPrompt ?? '').length > 20),
      to: '/app/bots',
      who: 'you',
    },
    {
      label: 'Encender tu asistente',
      hint: 'Cuando te guste cómo responde, lo activamos juntos.',
      done: (bots ?? []).some((b) => b.status === 'ACTIVE'),
      to: '/app/bots',
      who: 'agent',
    },
    {
      label: 'Subir fotos de tus productos',
      hint: 'Las que el asistente puede enviar a tus clientes.',
      done: (media ?? []).length > 0,
      to: '/app/media',
      who: 'you',
      optional: true,
    },
  ];
  const corePending = steps.filter((s) => !s.done && !s.optional).length;
  if (corePending === 0) return null;
  const doneCount = steps.filter((s) => s.done).length;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <Card
      kicker={`Primeros pasos · ${pct}% listo`}
      title="Dejemos tu asistente funcionando"
      className="mb-6"
    >
      <ProgressBar pct={pct} className="mb-4" />
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {steps.map((step) => (
          <Link
            key={step.label}
            to={step.to}
            className={`flex items-start gap-2.5 border-2 px-3 py-2.5 transition-colors ${
              step.done
                ? 'border-line bg-bone text-ink-3'
                : 'border-ink bg-paper hover:bg-bone-2'
            }`}
          >
            {step.done ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
            ) : (
              <Circle size={16} className="mt-0.5 shrink-0" />
            )}
            <span>
              <span className={`block text-sm font-semibold ${step.done ? 'line-through' : ''}`}>
                {step.label}
                {step.optional ? ' · opcional' : ''}
              </span>
              {!step.done && (
                <>
                  <span className="mt-0.5 inline-block">
                    <Badge tone={step.who === 'agent' ? 'info' : 'neutral'}>{step.who === 'agent' ? 'Lo hacemos contigo' : 'Tú, en un clic'}</Badge>
                  </span>
                  <span className="block text-xs text-ink-3">{step.hint}</span>
                </>
              )}
            </span>
          </Link>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t-2 border-line pt-3">
        <ScheduleCall q={q} topic="SETUP" label="Agéndame con un agente" defaultPhone={company?.contactPhone ?? ''} />
        <p className="text-xs text-ink-3">No estás solo: un agente de BackOffice te llama y lo deja listo contigo.</p>
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { ready, q, companyId, isPlatform } = useCompanyScope();
  const { user } = useAuth();
  const { data, isLoading } = useQuery({
    queryKey: ['metrics-company', q],
    queryFn: () => api.get<CompanyMetrics>(withScope('/metrics/company', q)),
    enabled: ready,
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: ready,
  });
  const { data: integrations } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
  });
  const { data: bots } = useQuery({
    queryKey: ['bots', q],
    queryFn: () => api.get<Bot[]>(withScope('/bots', q)),
    enabled: ready,
  });
  const { data: media } = useQuery({
    queryKey: ['media', q],
    queryFn: () => api.get<MediaAsset[]>(withScope('/media', q)),
    enabled: ready,
  });
  const { data: appointments } = useQuery({
    queryKey: ['appointments', q],
    queryFn: () => api.get<Appointment[]>(withScope('/appointments', q)),
    enabled: ready,
  });
  const { data: followUps } = useQuery({
    queryKey: ['followups', q],
    queryFn: () => api.get<FollowUp[]>(withScope('/followups', q)),
    enabled: ready,
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="Cargando dashboard…" />;
  const { kpis } = data;

  const company = isPlatform
    ? companies?.find((c) => c.id === companyId)
    : companies?.[0];
  const firstName = (user?.name ?? '').split(' ')[0];
  const todayLabel = new Intl.DateTimeFormat('es-CO', {
    weekday: 'long', day: 'numeric', month: 'long',
  }).format(new Date());

  const todayAppointments = (appointments ?? []).filter((a) => {
    const d = new Date(a.startsAt);
    const now = new Date();
    return d.toDateString() === now.toDateString() &&
      ['SCHEDULED', 'CONFIRMED'].includes(a.status);
  });
  const pendingFollowUps = (followUps ?? []).filter((f) => f.status === 'PENDING');
  const overdueFollowUps = pendingFollowUps.filter((f) => new Date(f.dueAt) < new Date());

  return (
    <>
      <PageHeader
        kicker={`${todayLabel} · ${company?.name ?? 'Tu empresa'}`}
        title={`${greeting()},`}
        accent={`${firstName}.`}
        actions={
          kpis.attention > 0 ? (
            <Link to="/app/inbox?attention=1">
              <Button variant="danger">
                {kpis.attention} conversación{kpis.attention > 1 ? 'es' : ''} necesita atención →
              </Button>
            </Link>
          ) : undefined
        }
      />

      <TeamQuest q={q} />

      <SetupChecklist
        company={company}
        integrations={integrations}
        bots={bots}
        media={media}
        q={q}
      />

      {/* Agenda del día */}
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 border-2 border-ink bg-paper px-4 py-2.5 text-sm">
        <span className="kicker">Hoy</span>
        <Link to="/app/agenda" className="hover:underline">
          <strong>{todayAppointments.length}</strong> cita{todayAppointments.length !== 1 ? 's' : ''}
          {todayAppointments[0] && (
            <span className="text-ink-3">
              {' '}· próxima {new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit' }).format(new Date(todayAppointments[0].startsAt))} ({todayAppointments[0].contact.name})
            </span>
          )}
        </Link>
        <Link to="/app/agenda" className="hover:underline">
          <strong>{pendingFollowUps.length}</strong> seguimiento{pendingFollowUps.length !== 1 ? 's' : ''} pendiente{pendingFollowUps.length !== 1 ? 's' : ''}
          {overdueFollowUps.length > 0 && (
            <span className="font-semibold text-bad"> · {overdueFollowUps.length} vencido{overdueFollowUps.length !== 1 ? 's' : ''}</span>
          )}
        </Link>
        <Link to="/app/gerencia" className="ml-auto text-xs font-semibold uppercase tracking-wider hover:underline">
          Reporte a gerencia →
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Conversaciones hoy" value={kpis.conversationsToday} hint={`${kpis.conversations7d} esta semana`} />
        <Stat label="Abiertas" value={kpis.openConversations} hint="Sin resolver" />
        <Stat
          label="Necesitan atención" value={kpis.attention}
          tone={kpis.attention > 0 ? 'bad' : 'ok'} hint="Supervisión humana"
        />
        <Stat label="Leads calientes" value={kpis.hotLeads} tone="warn" hint={`${kpis.newContacts7d} contactos nuevos 7d`} />
        <Stat label="Mensajes 30d" value={fmtNum(kpis.messages30d)} hint={`${kpis.activeBots} bots activos`} />
        <Stat label="Consumo 30d" value={fmtUsd(kpis.consumption30d)} hint="IA + WhatsApp + storage" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Actividad" title="Mensajes por día" className="lg:col-span-2">
          <MessagesChart
            data={data.series}
            keys={[
              { key: 'messagesIn', name: 'Recibidos' },
              { key: 'messagesOut', name: 'Respondidos' },
            ]}
          />
        </Card>
        <Card kicker="CRM" title="Embudo de leads">
          <BarsChart
            data={data.funnel.map((f) => ({ ...f, label: STAGE_LABELS[f.stage] }))}
            dataKey="count"
            labelKey="label"
            name="Contactos"
          />
        </Card>
      </div>

      {/* Líneas más activas (perfiles / números) */}
      {data.lines.length > 0 && (
        <div className="mt-6">
          <Card
            kicker="Mensajes 30d por número"
            title="Tus líneas"
            actions={
              <Link to="/app/analytics">
                <Button size="sm" variant="outline">Ranking completo →</Button>
              </Link>
            }
          >
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {data.lines.slice(0, 4).map((line) => (
                <Link
                  key={line.id}
                  to={`/app/lines/${line.id}`}
                  className="block border-2 border-line bg-bone px-3 py-2 transition-colors hover:border-ink"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-semibold">{line.name}</p>
                    {line.attention > 0 && <Badge tone="bad">{line.attention}</Badge>}
                  </div>
                  <p className="display mt-1 text-2xl">{fmtNum(line.messages30d)}</p>
                  <p className="text-[11px] text-ink-3">
                    {line.conversations} conversaciones · {line.promptMode === 'CUSTOM' ? 'personalidad propia' : 'hereda del bot'}
                  </p>
                </Link>
              ))}
            </div>
          </Card>
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Asistentes" title="Tus bots">
          <ul className="space-y-3">
            {data.bots.map((bot) => (
              <li key={bot.id} className="flex items-center justify-between border-b border-line pb-2 last:border-0">
                <Link to={`/app/bots/${bot.id}`} className="text-sm font-semibold hover:underline">
                  {bot.name}
                </Link>
                <Badge tone={statusTone(bot.status)}>
                  {bot.status === 'ACTIVE' ? 'Activo' : bot.status === 'PAUSED' ? 'Pausado' : 'Borrador'}
                </Badge>
              </li>
            ))}
            {data.bots.length === 0 && <p className="text-sm text-ink-3">Sin bots todavía.</p>}
          </ul>
        </Card>
        <Card kicker="Canales" title="Conversaciones por canal">
          <BarsChart
            data={data.channelBreakdown}
            dataKey="count"
            labelKey="channel"
            name="Conversaciones"
            height={180}
          />
        </Card>
        <Card kicker="Resumen" title="Base de clientes">
          <div className="grid grid-cols-2 gap-3">
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Contactos</p>
              <p className="display text-2xl">{kpis.contacts}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Clientes</p>
              <p className="display text-2xl text-ok">{kpis.clients}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Automatizaciones</p>
              <p className="display text-2xl">{kpis.activeAutomations}</p>
            </div>
            <div className="border-2 border-line bg-bone px-3 py-2">
              <p className="kicker">Bots activos</p>
              <p className="display text-2xl">{kpis.activeBots}</p>
            </div>
          </div>
          <p className="mt-3 border-t border-line pt-3 text-xs text-ink-3">
            Tu base de datos de clientes es 100% tuya: cada conversación la
            alimenta y queda lista para tus campañas.
          </p>
        </Card>
      </div>
    </>
  );
}
