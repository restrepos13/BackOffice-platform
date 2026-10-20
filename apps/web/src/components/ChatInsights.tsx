import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronUp, ExternalLink, Megaphone, MessageCircle, Phone, ShoppingBag, UserRound } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { api } from '../lib/api';
import { fmtMoney, timeAgo } from '../lib/format';
import { Badge } from './ui';

/**
 * Ficha de rastreo del chat: de dónde llegó (anuncio, publicación o directo),
 * por qué línea entró, quién lo atiende, cuánto ha comprado y qué le debe.
 */

interface Origin { kind: 'AD' | 'POST' | 'DIRECT' | 'UNKNOWN'; label: string; headline?: string; body?: string; sourceUrl?: string; sourceId?: string; at?: string }
interface Insights {
  origin: Origin;
  firstOrigin: Origin | null;
  line: { id: string; name: string; phone: string | null; channel: string } | null;
  channel: string;
  startedAt: string;
  lastMessageAt: string;
  status: string;
  attendedBy: { kind: 'BOT' | 'HUMAN'; name: string };
  needsAttention: boolean;
  messages: { total: number; fromClient: number; fromBot: number; fromTeam: number; firstReplyMin: number | null };
  contact: { id: string; name: string; phone: string | null; email: string | null; stage: string; tags: string[]; assignedTo: string | null; since: string; optOut: boolean; conversations: number } | null;
  purchases: { count: number; total: number; last: { at: string; status: string; total: number } | null; unpaid: number };
  owed: number;
  lastAutomation: { addon: string; status: string; at: string } | null;
}

const date = (iso: string) => new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const AUTOMATION: Record<string, string> = { REACTIVATION: 'Reactivación', COLLECTIONS: 'Cobranza' };
const TOUCH: Record<string, string> = { SENT: 'enviado', SKIPPED: 'no se envió', REPLIED: 'respondió', RECOVERED: 'volvió a comprar', PAID: 'pagó' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-xs">
      <span className="shrink-0 text-ink-3">{label}</span>
      <span className="text-right font-semibold">{children}</span>
    </div>
  );
}

function Block({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="border-2 border-line bg-paper p-3">
      <p className="kicker mb-1 flex items-center gap-1.5">{icon} {title}</p>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}

export default function ChatInsights({ conversationId }: { conversationId: string }) {
  const { data: d } = useQuery({
    queryKey: ['chat-insights', conversationId],
    queryFn: () => api.get<Insights>(`/conversations/${conversationId}/insights`),
    refetchInterval: 60_000,
  });
  const [open, setOpen] = useState(false);
  if (!d) return <p className="p-3 text-xs text-ink-3">Cargando información del chat…</p>;
  const o = d.origin;
  // Franja de una línea: lo clave sin quitarle espacio a los mensajes
  const chip = (label: string, value: ReactNode, tone?: string) => (
    <span className="inline-flex items-center gap-1 whitespace-nowrap border-r border-line pr-3 last:border-r-0">
      <span className="text-ink-3">{label}</span> <b className={tone}>{value}</b>
    </span>
  );
  if (!open) {
    return (
      <div className="flex items-center gap-3 border-b-2 border-ink bg-bone px-4 py-2 text-xs">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          {chip('Origen', o.kind === 'AD' ? `Anuncio${o.headline ? `: ${o.headline}` : ''}` : o.kind === 'UNKNOWN' ? 'Sin dato' : o.label, o.kind === 'AD' ? 'text-info' : undefined)}
          {chip('Línea', d.line?.name ?? d.channel)}
          {chip('Atiende', d.attendedBy.kind === 'BOT' ? 'Asistente IA' : d.attendedBy.name)}
          {chip('Compras', `${d.purchases.count} · ${fmtMoney(d.purchases.total)}`)}
          {d.owed > 0 && chip('Debe', fmtMoney(d.owed), 'text-bad')}
          {d.messages.firstReplyMin != null && chip('1.ª respuesta', d.messages.firstReplyMin === 0 ? '< 1 min' : `${d.messages.firstReplyMin} min`)}
        </div>
        <button type="button" onClick={() => setOpen(true)} className="inline-flex shrink-0 cursor-pointer items-center gap-1 font-semibold underline">
          Ver toda la info <ChevronDown size={12} />
        </button>
      </div>
    );
  }
  return (
    <div className="relative grid gap-2 border-b-2 border-ink bg-bone p-3 pt-8 md:grid-cols-2 2xl:grid-cols-4">
      <button type="button" onClick={() => setOpen(false)} className="absolute right-3 top-2 inline-flex cursor-pointer items-center gap-1 text-xs font-semibold underline">
        Ocultar <ChevronUp size={12} />
      </button>
      <Block icon={<Megaphone size={12} />} title="De dónde llegó">
        <Row label="Origen">
          {o.kind === 'AD' ? <Badge tone="info">{o.label}</Badge> : o.label}
        </Row>
        {o.headline && <Row label="Anuncio">{o.headline}</Row>}
        {o.sourceUrl && (
          <Row label="Enlace">
            <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">Ver anuncio <ExternalLink size={11} /></a>
          </Row>
        )}
        {o.sourceId && <Row label="ID del anuncio">{o.sourceId}</Row>}
        {d.firstOrigin && d.firstOrigin.kind !== o.kind && <Row label="Primera vez llegó por">{d.firstOrigin.label}</Row>}
        <Row label="Inició">{date(d.startedAt)}</Row>
      </Block>

      <Block icon={<Phone size={12} />} title="Línea y atención">
        <Row label="Entró por">{d.line ? `${d.line.name}${d.line.phone ? ` · ${d.line.phone}` : ''}` : d.channel}</Row>
        <Row label="Lo atiende">{d.attendedBy.kind === 'BOT' ? 'Asistente IA' : d.attendedBy.name}</Row>
        <Row label="Asesor asignado">{d.contact?.assignedTo ?? 'Sin asignar'}</Row>
        <Row label="Primera respuesta">{d.messages.firstReplyMin == null ? '—' : d.messages.firstReplyMin === 0 ? 'Menos de 1 min' : `${d.messages.firstReplyMin} min`}</Row>
        <Row label="Último mensaje">{timeAgo(d.lastMessageAt)}</Row>
      </Block>

      <Block icon={<MessageCircle size={12} />} title="Conversación">
        <Row label="Mensajes">{d.messages.total}</Row>
        <Row label="Del cliente">{d.messages.fromClient}</Row>
        <Row label="Del asistente">{d.messages.fromBot}</Row>
        <Row label="Del equipo">{d.messages.fromTeam}</Row>
        <Row label="Chats con este cliente">{d.contact?.conversations ?? 1}</Row>
      </Block>

      <Block icon={<ShoppingBag size={12} />} title="Cliente y compras">
        <Row label="Cliente desde">{d.contact ? date(d.contact.since) : '—'}</Row>
        <Row label="Compras">{d.purchases.count} · {fmtMoney(d.purchases.total)}</Row>
        {d.purchases.last && <Row label="Última compra">{timeAgo(d.purchases.last.at)} · {fmtMoney(d.purchases.last.total)}</Row>}
        {d.owed > 0 && <Row label="Te debe"><span className="text-bad">{fmtMoney(d.owed)}</span></Row>}
        {d.lastAutomation && <Row label={AUTOMATION[d.lastAutomation.addon] ?? 'Automático'}>{TOUCH[d.lastAutomation.status] ?? d.lastAutomation.status} · {timeAgo(d.lastAutomation.at)}</Row>}
        {d.contact?.optOut && <Row label="Mensajes"><span className="text-bad">Pidió no recibir</span></Row>}
        {!!d.contact?.tags.length && (
          <div className="flex flex-wrap gap-1 py-1.5">{d.contact.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</div>
        )}
        {d.contact?.email && <Row label="Correo"><span className="inline-flex items-center gap-1"><UserRound size={11} />{d.contact.email}</span></Row>}
      </Block>
    </div>
  );
}
