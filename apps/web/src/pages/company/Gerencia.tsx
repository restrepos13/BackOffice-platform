import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, Minus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime, fmtNum, fmtUsd, timeAgo } from '../../lib/format';
import type { ExecutiveReport } from '../../lib/types';
import { Badge, Card, Loading, PageHeader } from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

function Delta({ current, prev }: { current: number; prev: number }) {
  if (prev === 0 && current === 0) {
    return <span className="flex items-center gap-1 text-xs text-ink-3"><Minus size={12} /> sin cambio</span>;
  }
  const pct = prev === 0 ? 100 : Math.round(((current - prev) / prev) * 100);
  if (pct >= 0) {
    return (
      <span className="flex items-center gap-1 text-xs font-semibold text-ok">
        <ArrowUpRight size={12} /> +{pct}% vs. semana pasada
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs font-semibold text-bad">
      <ArrowDownRight size={12} /> {pct}% vs. semana pasada
    </span>
  );
}

export default function Gerencia() {
  const { ready, q } = useCompanyScope();
  const { data, isLoading } = useQuery({
    queryKey: ['executive', q],
    queryFn: () => api.get<ExecutiveReport>(withScope('/ops/executive', q)),
    enabled: ready,
    refetchInterval: 60_000,
  });

  if (!ready) return <PickCompany />;
  if (isLoading || !data) return <Loading label="El bot jefe está auditando…" />;
  const { week, savings, pending } = data;

  const weekCards = [
    { label: 'Conversaciones nuevas', value: week.conversations, prev: week.conversationsPrev },
    { label: 'Mensajes atendidos', value: week.messages, prev: week.messagesPrev },
    { label: 'Contactos nuevos', value: week.newContacts, prev: week.newContactsPrev },
    { label: 'Citas agendadas', value: week.appointments, prev: week.appointmentsPrev },
  ];

  return (
    <>
      <PageHeader
        kicker="Tu operación auditada, en tiempo real"
        title="Reporte a"
        accent="gerencia."
        actions={<p className="kicker self-center">Actualizado {timeAgo(data.generatedAt)}</p>}
      />

      {/* Ahorro estimado — el titular del reporte */}
      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <section className="border-2 border-ink bg-ink text-bone">
          <header className="border-b-2 border-bone/30 px-5 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-line">
              Ahorro estimado · mes en curso
            </p>
          </header>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3 p-5">
            <div>
              <p className="display text-6xl">
                {savings.salariesEquivalent.toFixed(1)}
                <span className="text-2xl"> sueldos</span>
              </p>
              <p className="mt-1 text-sm text-line">
                ≈ {fmtUsd(savings.savedUsd)} este mes
              </p>
            </div>
            <div className="text-xs text-line">
              <p>{fmtNum(savings.aiRepliesMonth)} respuestas de la IA este mes</p>
              <p>÷ {fmtNum(savings.agentCapacityPerMonth)} conversaciones que atiende una persona</p>
              <p>× {fmtUsd(savings.salaryUsd)} de sueldo mensual equivalente</p>
              <p className="mt-2">
                Costo real de esa IA: <strong className="text-bone">{fmtUsd(savings.aiCostMonth)}</strong>
              </p>
              <Link to="/app/settings" className="mt-1 inline-block underline">
                Ajustar parámetros →
              </Link>
            </div>
          </div>
        </section>

        {/* Áreas auditadas — el "bot jefe" */}
        <Card kicker="Bot jefe · auditoría en vivo" title="Áreas">
          <ul className="space-y-2.5">
            {data.areas.map((area) => (
              <li key={area.area} className="flex items-start justify-between gap-3 border-b border-line pb-2 last:border-0">
                <div className="flex items-start gap-2">
                  {area.ok ? (
                    <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" />
                  ) : (
                    <AlertTriangle size={16} className="mt-0.5 shrink-0 text-bad" />
                  )}
                  <div>
                    <p className="text-sm font-semibold">{area.area}</p>
                    <p className="text-xs text-ink-3">{area.detail}</p>
                  </div>
                </div>
                <Badge tone={area.ok ? 'ok' : 'bad'}>{area.ok ? 'OK' : 'Atención'}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* Semana vs semana */}
      <div className="mt-6">
        <p className="kicker mb-2">Últimos 7 días vs. los 7 anteriores</p>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {weekCards.map((card) => (
            <div key={card.label} className="border-2 border-ink bg-paper px-4 py-3">
              <p className="kicker">{card.label}</p>
              <p className="display mt-1 text-3xl">{fmtNum(card.value)}</p>
              <div className="mt-1"><Delta current={card.value} prev={card.prev} /></div>
            </div>
          ))}
        </div>
      </div>

      {/* Pendientes accionables */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card kicker="Próximas 48 horas" title="Citas">
          {pending.upcomingAppointments.length === 0 ? (
            <p className="text-sm text-ink-3">Sin citas próximas.</p>
          ) : (
            <ul className="space-y-2">
              {pending.upcomingAppointments.map((appointment) => (
                <li key={appointment.id} className="border-b border-line pb-2 text-sm last:border-0">
                  <p className="font-semibold">{appointment.title}</p>
                  <p className="text-xs text-ink-3">
                    {appointment.contact} · {fmtDateTime(appointment.startsAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link to="/app/agenda" className="mt-3 block text-xs font-semibold uppercase tracking-wider hover:underline">
            Ver agenda →
          </Link>
        </Card>

        <Card kicker="Vencidos" title="Seguimientos">
          {pending.overdueFollowUps.length === 0 ? (
            <p className="text-sm text-ok">✓ Nada vencido — al día.</p>
          ) : (
            <ul className="space-y-2">
              {pending.overdueFollowUps.map((followUp) => (
                <li key={followUp.id} className="border-b border-line pb-2 text-sm last:border-0">
                  <p className="font-semibold">{followUp.note}</p>
                  <p className="text-xs text-bad">
                    {followUp.contact} · vencido {timeAgo(followUp.dueAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <Link to="/app/agenda" className="mt-3 block text-xs font-semibold uppercase tracking-wider hover:underline">
            Gestionar →
          </Link>
        </Card>

        <Card kicker="Se están enfriando" title="Leads calientes">
          {pending.staleHotLeads.length === 0 ? (
            <p className="text-sm text-ok">✓ Todos con actividad reciente.</p>
          ) : (
            <ul className="space-y-2">
              {pending.staleHotLeads.map((lead) => (
                <li key={lead.id} className="flex items-center justify-between border-b border-line pb-2 text-sm last:border-0">
                  <p className="font-semibold">{lead.name}</p>
                  <p className="text-xs text-warn">sin actividad {timeAgo(lead.lastActivityAt)}</p>
                </li>
              ))}
            </ul>
          )}
          <Link to="/app/contacts" className="mt-3 block text-xs font-semibold uppercase tracking-wider hover:underline">
            Ver contactos →
          </Link>
        </Card>
      </div>

      <p className="mt-4 text-xs text-ink-3">
        Este reporte se recalcula en vivo con los datos de tu operación. Cuando el
        motor de IA esté conectado, el bot jefe también lo enviará resumido a tu
        WhatsApp cada mañana.
      </p>
    </>
  );
}
