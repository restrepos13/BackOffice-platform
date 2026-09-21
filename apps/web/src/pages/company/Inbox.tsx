import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import {
  CHANNEL_LABELS, CONVO_STATUS_LABELS, STAGE_LABELS, fmtDateTime, timeAgo,
} from '../../lib/format';
import type { Conversation, Integration } from '../../lib/types';
import {
  Badge, Button, Loading, PageHeader, Select, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function Inbox() {
  const { ready, q, canWrite } = useCompanyScope();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [lineId, setLineId] = useState(params.get('line') ?? '');
  const [onlyAttention, setOnlyAttention] = useState(params.get('attention') === '1');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: lines } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
    select: (items) => items.filter((i) => i.type === 'WHATSAPP'),
  });

  const listPath = withScope(
    `/conversations?x=1${status ? `&status=${status}` : ''}${onlyAttention ? '&needsAttention=true' : ''}${lineId ? `&integrationId=${lineId}` : ''}`,
    q,
  );
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['conversations', listPath],
    queryFn: () => api.get<Conversation[]>(listPath),
    enabled: ready,
    refetchInterval: 20_000,
  });

  const { data: detail } = useQuery({
    queryKey: ['conversation', selectedId],
    queryFn: () => api.get<Conversation>(`/conversations/${selectedId}`),
    enabled: !!selectedId,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [detail?.messages?.length]);

  const send = useMutation({
    mutationFn: () =>
      api.post(`/conversations/${selectedId}/messages`, { content: draft }),
    onSuccess: () => {
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const setConvoStatus = useMutation({
    mutationFn: (patch: { status?: string; needsAttention?: boolean }) =>
      api.patch(`/conversations/${selectedId}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader kicker="Supervisión" title="Conversaciones" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[180px]">
          <option value="">Todos los estados</option>
          {Object.entries(CONVO_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
        {(lines?.length ?? 0) > 1 && (
          <Select value={lineId} onChange={(e) => setLineId(e.target.value)} className="max-w-[220px]" aria-label="Filtrar por línea">
            <option value="">Todas las líneas</option>
            {lines?.map((line) => (
              <option key={line.id} value={line.id}>{line.name}</option>
            ))}
          </Select>
        )}
        <button
          onClick={() => setOnlyAttention(!onlyAttention)}
          className={clsx(
            'flex cursor-pointer items-center gap-2 border-2 border-ink px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em]',
            onlyAttention ? 'bg-bad text-white' : 'bg-paper hover:bg-bone-2',
          )}
        >
          <AlertTriangle size={13} /> Solo con atención
        </button>
      </div>

      <div className="grid gap-0 border-2 border-ink bg-paper lg:grid-cols-[380px_1fr]" style={{ height: 'calc(100vh - 250px)', minHeight: 420 }}>
        {/* Lista */}
        <div className="overflow-y-auto border-r-2 border-ink">
          {isLoading ? (
            <Loading />
          ) : (
            conversations?.map((convo) => (
              <button
                key={convo.id}
                onClick={() => setSelectedId(convo.id)}
                className={clsx(
                  'block w-full cursor-pointer border-b border-line px-4 py-3 text-left transition-colors',
                  selectedId === convo.id ? 'bg-ink text-bone' : 'hover:bg-bone-2',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold">
                    {convo.needsAttention && (
                      <AlertTriangle size={12} className="mr-1 inline text-bad" />
                    )}
                    {convo.contact.name}
                  </p>
                  <span className={clsx('shrink-0 text-[10px]', selectedId === convo.id ? 'text-line' : 'text-ink-3')}>
                    {timeAgo(convo.lastMessageAt)}
                  </span>
                </div>
                <p className={clsx('mt-0.5 truncate text-xs', selectedId === convo.id ? 'text-line' : 'text-ink-3')}>
                  {convo.messages?.[0]?.content ?? '—'}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Badge tone={statusTone(convo.status)}>{CONVO_STATUS_LABELS[convo.status]}</Badge>
                  <Badge tone="neutral">
                    {convo.integration?.name ?? CHANNEL_LABELS[convo.channel] ?? convo.channel}
                  </Badge>
                  {convo.unreadCount > 0 && <Badge tone="ink">{convo.unreadCount}</Badge>}
                </div>
              </button>
            ))
          )}
          {conversations?.length === 0 && (
            <p className="p-6 text-center text-sm text-ink-3">Sin conversaciones.</p>
          )}
        </div>

        {/* Detalle */}
        {detail ? (
          <div className="flex min-h-0 flex-col">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink px-4 py-2.5">
              <div>
                <p className="font-semibold">{detail.contact.name}</p>
                <p className="text-xs text-ink-3">
                  {detail.contact.phone} · {STAGE_LABELS[detail.contact.stage]}
                  {detail.integration ? ` · ${detail.integration.name}` : detail.bot ? ` · ${detail.bot.name}` : ''}
                </p>
              </div>
              {canWrite && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={detail.needsAttention ? 'danger' : 'outline'}
                    onClick={() => setConvoStatus.mutate({ needsAttention: !detail.needsAttention })}
                  >
                    {detail.needsAttention ? 'Quitar alerta' : 'Marcar atención'}
                  </Button>
                  {detail.status !== 'RESOLVED' ? (
                    <Button size="sm" onClick={() => setConvoStatus.mutate({ status: 'RESOLVED' })}>
                      Resolver ✓
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setConvoStatus.mutate({ status: 'OPEN' })}>
                      Reabrir
                    </Button>
                  )}
                </div>
              )}
            </header>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto bg-bone p-4">
              {detail.messages.map((message) => (
                <div
                  key={message.id}
                  className={clsx('flex', message.direction === 'IN' ? 'justify-start' : 'justify-end')}
                >
                  <div
                    className={clsx(
                      'max-w-[70%] border-2 px-3 py-2',
                      message.direction === 'IN'
                        ? 'border-ink bg-paper'
                        : message.author === 'AGENT'
                          ? 'border-info bg-info-soft'
                          : 'border-ink bg-ink text-bone',
                    )}
                  >
                    <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                    <p className={clsx(
                      'mt-1 text-[10px] uppercase tracking-wider',
                      message.direction === 'OUT' && message.author === 'BOT' ? 'text-line' : 'text-ink-3',
                    )}>
                      {message.author === 'CONTACT' ? 'Cliente' : message.author === 'BOT' ? 'IA' : 'Agente'} · {fmtDateTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {canWrite && (
              <footer className="flex gap-2 border-t-2 border-ink p-3">
                <Textarea
                  rows={2}
                  placeholder="Intervenir como humano… (el bot se pausa en esta conversación)"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                      e.preventDefault();
                      send.mutate();
                    }
                  }}
                />
                <Button
                  disabled={!draft.trim() || send.isPending}
                  onClick={() => send.mutate()}
                  aria-label="Enviar"
                >
                  <Send size={14} />
                </Button>
              </footer>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center">
            <p className="serif-accent text-2xl text-ink-3">
              elige una conversación para supervisarla.
            </p>
          </div>
        )}
      </div>
    </>
  );
}
