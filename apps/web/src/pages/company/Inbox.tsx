import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  AlertTriangle, ArrowLeft, Bot, Check, CheckCheck, Hand, Info,
  Image as ImageIcon, MapPin, Paperclip, Receipt, Search, Send, UserRound, X, Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useLiveEvents } from '../../lib/events';
import {
  CHANNEL_LABELS, CONVO_STATUS_LABELS, STAGE_LABELS, fmtDateTime, fmtMoney, fmtUsd, timeAgo,
} from '../../lib/format';
import type { Conversation, Integration, MediaAsset, Message, QuickReply } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Textarea, statusTone,
} from '../../components/ui';
import { MediaImage, MessageFile } from '../../components/media';
import { AppointmentModal, FollowUpModal } from './Agenda';
import ChatInsights from '../../components/ChatInsights';
import { PickCompany, useCompanyScope, withScope } from './shared';

/** Ticks de entrega estilo WhatsApp para mensajes salientes. */
function DeliveryTicks({ status }: { status?: Message['deliveryStatus'] }) {
  if (!status) return null;
  if (status === 'FAILED') return <X size={12} className="inline text-bad" aria-label="Falló" />;
  if (status === 'QUEUED') return <span className="text-[10px]" aria-label="En cola">⏱</span>;
  if (status === 'SENT') return <Check size={12} className="inline" aria-label="Enviado" />;
  return (
    <CheckCheck
      size={12}
      className={clsx('inline', status === 'READ' && 'text-info')}
      aria-label={status === 'READ' ? 'Leído' : 'Entregado'}
    />
  );
}

/** Lectura del comprobante de pago que hizo la IA (nunca marca pagado sola). */
function ReceiptReading({ json }: { json?: string | null }) {
  if (!json) return null;
  let a: { kind?: string; amount?: number | null; currency?: string | null; bank?: string | null; reference?: string | null; date?: string | null; summary?: string } = {};
  try { a = JSON.parse(json); } catch { return null; }
  if (a.kind !== 'RECEIPT') {
    return a.summary ? <p className="mt-1 border-l-2 border-line pl-2 text-xs italic text-ink-3">IA: {a.summary}</p> : null;
  }
  return (
    <div className="mt-1.5 border-2 border-ok bg-ok-soft px-2 py-1.5 text-xs text-ink">
      <p className="flex items-center gap-1 font-semibold"><Receipt size={12} /> Comprobante leído por IA</p>
      <p className="mt-0.5 tabular-nums">
        {a.amount != null ? fmtMoney(a.amount, a.currency ?? 'COP') : 'Monto ilegible'}
        {a.bank && ` · ${a.bank}`}{a.reference && ` · ref ${a.reference}`}
      </p>
      {a.date && <p className="text-ink-3">{a.date}</p>}
      <p className="mt-0.5 text-[10px] uppercase tracking-wider text-ink-3">Verifica en el banco antes de marcar pagado</p>
    </div>
  );
}

/** Administrador de respuestas rápidas ("/" en el compositor). */
function QuickRepliesModal({ open, onClose, q }: { open: boolean; onClose: () => void; q: string }) {
  const queryClient = useQueryClient();
  const { data: replies } = useQuery({
    queryKey: ['quick-replies', q],
    queryFn: () => api.get<QuickReply[]>(withScope('/quick-replies', q)),
    enabled: open,
  });
  const [form, setForm] = useState<Partial<QuickReply>>({ shortcut: '', title: '', body: '' });
  const save = useMutation({
    mutationFn: () => form.id
      ? api.patch(withScope(`/quick-replies/${form.id}`, q), form)
      : api.post(withScope('/quick-replies', q), form),
    onSuccess: () => {
      toast.success('Respuesta guardada');
      setForm({ shortcut: '', title: '', body: '' });
      queryClient.invalidateQueries({ queryKey: ['quick-replies'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/quick-replies/${id}`, q)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quick-replies'] }),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Conversaciones" title="Respuestas rápidas" wide>
      <div className="grid gap-6 md:grid-cols-2">
        <div className="max-h-[55vh] space-y-2 overflow-y-auto">
          {replies?.map((r) => (
            <div key={r.id} className="border-2 border-ink bg-paper p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold"><span className="font-mono text-ink-3">/{r.shortcut}</span> · {r.title}</p>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setForm(r)}>Editar</Button>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(r.id)}>Quitar</Button>
                </div>
              </div>
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-ink-2">{r.body}</p>
            </div>
          ))}
          {replies?.length === 0 && <p className="py-6 text-center text-sm text-ink-3">Aún no hay respuestas rápidas.</p>}
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-2">
            <Field label="Atajo"><Input value={form.shortcut ?? ''} placeholder="horario" onChange={(e) => setForm({ ...form, shortcut: e.target.value.replace(/^\//, '') })} /></Field>
            <Field label="Título"><Input value={form.title ?? ''} placeholder="Horario de atención" onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          </div>
          <Field label="Texto" hint="Usa {nombre} para el nombre del cliente">
            <Textarea rows={5} value={form.body ?? ''} onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            {form.id && <Button variant="outline" onClick={() => setForm({ shortcut: '', title: '', body: '' })}>Nueva</Button>}
            <Button disabled={!form.shortcut || !form.body || save.isPending} onClick={() => save.mutate()}>
              {form.id ? 'Guardar cambios' : 'Agregar'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default function Inbox() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [lineId, setLineId] = useState(params.get('line') ?? '');
  const [onlyAttention, setOnlyAttention] = useState(params.get('attention') === '1');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(params.get('open'));
  const [draft, setDraft] = useState('');
  const [managingReplies, setManagingReplies] = useState(false);
  const [replyIndex, setReplyIndex] = useState(0);
  const [photoPicker, setPhotoPicker] = useState(false);
  const [showInfo, setShowInfo] = useState(() => { try { return localStorage.getItem('inbox-info') !== '0'; } catch { return true; } });
  const [scheduling, setScheduling] = useState(false);
  const [followingUp, setFollowingUp] = useState(false);
  const [typingBy, setTypingBy] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastTypingSent = useRef(0);

  const { data: lines } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
    select: (items) => items.filter((i) => i.type === 'WHATSAPP'),
  });

  const listPath = withScope(
    `/conversations?x=1${status ? `&status=${status}` : ''}${onlyAttention ? '&needsAttention=true' : ''}${lineId ? `&integrationId=${lineId}` : ''}${search ? `&q=${encodeURIComponent(search)}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`,
    q,
  );
  const { data: conversations, isLoading } = useQuery({
    queryKey: ['conversations', listPath],
    queryFn: () => api.get<Conversation[]>(listPath),
    enabled: ready,
    refetchInterval: 60_000, // respaldo; lo normal llega por SSE
  });

  const { data: detail } = useQuery({
    queryKey: ['conversation', selectedId],
    queryFn: () => api.get<Conversation>(`/conversations/${selectedId}`),
    enabled: !!selectedId,
  });

  // ─── Tiempo real: mensajes nuevos, estados y "escribiendo…" ───
  useLiveEvents(companyId, (event) => {
    if (event.type === 'typing') {
      if (event.conversationId === selectedId && event.userName) {
        setTypingBy(event.userName);
        clearTimeout(typingTimer.current);
        typingTimer.current = setTimeout(() => setTypingBy(null), 4000);
      }
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
    if (event.conversationId && event.conversationId === selectedId) {
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
    }
  }, ready);

  const { data: mediaAssets } = useQuery({
    queryKey: ['media', q],
    queryFn: () => api.get<MediaAsset[]>(withScope('/media', q)),
    enabled: ready && photoPicker,
    select: (items) => items.filter((m) => m.active),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [detail?.messages?.length]);

  const { data: quickReplies } = useQuery({
    queryKey: ['quick-replies', q],
    queryFn: () => api.get<QuickReply[]>(withScope('/quick-replies', q)),
    enabled: ready && canWrite,
  });
  // "/atajo" al inicio del borrador abre el selector de respuestas rápidas
  const slash = /^\/(\S*)$/.exec(draft);
  const replyMatches = slash
    ? (quickReplies ?? []).filter((r) =>
        `${r.shortcut} ${r.title}`.toLowerCase().includes(slash[1].toLowerCase())).slice(0, 6)
    : [];
  function applyReply(r: QuickReply) {
    const first = detail?.contact.name?.split(' ')[0] ?? '';
    setDraft(r.body.replace(/\{nombre\}/gi, first));
    setReplyIndex(0);
  }

  const send = useMutation({
    mutationFn: (payload?: { mediaAssetId?: string }) =>
      api.post(`/conversations/${selectedId}/messages`, {
        content: draft,
        mediaAssetId: payload?.mediaAssetId,
      }),
    onSuccess: () => {
      setDraft('');
      setPhotoPicker(false);
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

  const setMode = useMutation({
    mutationFn: (mode: 'HUMAN' | 'BOT') =>
      api.patch(`/conversations/${selectedId}/mode`, { mode }),
    onSuccess: (_data, mode) => {
      toast.success(mode === 'HUMAN' ? 'Modo humano activado: la IA no responde aquí' : 'La IA retoma la conversación');
      queryClient.invalidateQueries({ queryKey: ['conversation', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  // Presencia "escribiendo…" hacia el resto del equipo (cada 2,5 s máx.)
  const notifyTyping = () => {
    if (!selectedId || Date.now() - lastTypingSent.current < 2500) return;
    lastTypingSent.current = Date.now();
    api.post('/events/typing', {
      conversationId: selectedId,
      ...(companyId ? { companyId } : {}),
    }).catch(() => undefined);
  };

  if (!ready) return <PickCompany />;

  return (
    <>
      <PageHeader kicker="Supervisión" title="Conversaciones" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] items-center gap-2 border-2 border-ink bg-bone px-3">
          <Search size={14} className="shrink-0 text-ink-3" />
          <input
            className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-ink-3"
            placeholder="Cliente, teléfono o contenido…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Buscar conversaciones"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="max-w-[170px]">
          <option value="">Todos los estados</option>
          {Object.entries(CONVO_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </Select>
        {(lines?.length ?? 0) > 1 && (
          <Select value={lineId} onChange={(e) => setLineId(e.target.value)} className="max-w-[200px]" aria-label="Filtrar por línea">
            <option value="">Todas las líneas</option>
            {lines?.map((line) => (
              <option key={line.id} value={line.id}>{line.name}</option>
            ))}
          </Select>
        )}
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="max-w-[150px]" aria-label="Desde" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="max-w-[150px]" aria-label="Hasta" />
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
        {/* Lista (en móvil se oculta cuando hay conversación abierta) */}
        <div className={clsx('overflow-y-auto lg:border-r-2 lg:border-ink', selectedId && 'hidden lg:block')}>
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
                    {convo.contact.customer && (
                      <span className={clsx('font-normal', selectedId === convo.id ? 'text-line' : 'text-ink-3')}>
                        {' '}· {convo.contact.customer.name}
                      </span>
                    )}
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
                  {convo.botPaused && (
                    <Badge tone="warn">
                      {convo.attendedByName ? `Humano: ${convo.attendedByName}` : 'IA en pausa'}
                    </Badge>
                  )}
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
          <div className={clsx('flex min-h-0 flex-col', !selectedId && 'hidden lg:flex')}>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-ink px-4 py-2.5">
              <div className="flex items-center gap-2">
                <button
                  className="cursor-pointer border-2 border-ink p-1 lg:hidden"
                  onClick={() => setSelectedId(null)}
                  aria-label="Volver a la lista"
                >
                  <ArrowLeft size={13} />
                </button>
                <div>
                  <p className="font-semibold">
                    {detail.contact.name}
                    {detail.contact.customer && (
                      <span className="font-normal text-ink-3"> · {detail.contact.customer.name}</span>
                    )}
                  </p>
                  <p className="text-xs text-ink-3">
                    {detail.contact.phone} · {STAGE_LABELS[detail.contact.stage]}
                    {detail.integration ? ` · ${detail.integration.name}` : detail.bot ? ` · ${detail.bot.name}` : ''}
                  </p>
                </div>
                {detail.botPaused ? (
                  <Badge tone="warn">
                    <Hand size={10} className="mr-1 inline" />
                    {detail.attendedByName ? `Atiende ${detail.attendedByName}` : 'IA en pausa'}
                  </Badge>
                ) : (
                  <Badge tone="info">
                    <Bot size={10} className="mr-1 inline" /> IA activa
                  </Badge>
                )}
              </div>
              {canWrite && (
                <div className="flex flex-wrap gap-2">
                  {/* MODO HUMANO explícito por conversación */}
                  {detail.botPaused ? (
                    <Button size="sm" onClick={() => setMode.mutate('BOT')} disabled={setMode.isPending}>
                      <Bot size={12} /> Devolver a la IA
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setMode.mutate('HUMAN')} disabled={setMode.isPending}>
                      <Hand size={12} /> Modo humano
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={showInfo ? undefined : 'outline'}
                    aria-pressed={showInfo}
                    onClick={() => setShowInfo((v) => { try { localStorage.setItem('inbox-info', v ? '0' : '1'); } catch { /* sin almacenamiento */ } return !v; })}
                  >
                    <Info size={12} /> Info del chat
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setScheduling(true)}>
                    Agendar cita
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setFollowingUp(true)}>
                    Seguimiento
                  </Button>
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

            {showInfo && (
              <div className="max-h-[45%] shrink-0 overflow-y-auto">
                <ChatInsights conversationId={detail.id} />
              </div>
            )}

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
                    {message.mediaAsset && (
                      <div className="mb-1.5">
                        <MediaImage
                          id={message.mediaAsset.id}
                          alt={message.mediaAsset.name}
                          className="h-40 w-full border-2 border-ink"
                        />
                        <p className={clsx(
                          'mt-1 text-[11px]',
                          message.direction === 'OUT' && message.author === 'BOT' ? 'text-line' : 'text-ink-3',
                        )}>
                          <Paperclip size={10} className="mr-1 inline" />{message.mediaAsset.name}
                          {message.mediaAsset.priceUsd > 0 && ` · ${fmtUsd(message.mediaAsset.priceUsd)}`}
                        </p>
                      </div>
                    )}
                    {/* Multimedia de WhatsApp: audio reproducible, imágenes, documentos */}
                    {message.fileName && message.type && message.type !== 'TEXT' && (
                      <div className="mb-1.5">
                        <MessageFile messageId={message.id} type={message.type as 'AUDIO' | 'IMAGE' | 'DOCUMENT'} />
                        {message.type === 'IMAGE' && <ReceiptReading json={message.analysisJson} />}
                        {message.type === 'AUDIO' && message.transcription && (
                          <p className="mt-1 border-l-2 border-line pl-2 text-xs italic text-ink-3">
                            "{message.transcription}"
                          </p>
                        )}
                      </div>
                    )}
                    {message.type === 'LOCATION' && message.latitude != null && message.longitude != null ? (
                      <a
                        href={`https://www.google.com/maps?q=${message.latitude},${message.longitude}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-2 text-sm underline-offset-2 hover:underline"
                      >
                        <MapPin size={15} className="mt-0.5 shrink-0" />
                        <span>
                          <strong>Ubicación compartida</strong>
                          <span className="block text-xs opacity-80">
                            {message.content.replace(/^\[ubicación\]\s*/i, '') || `${message.latitude.toFixed(5)}, ${message.longitude.toFixed(5)}`}
                          </span>
                        </span>
                      </a>
                    ) : message.content && (
                      <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                    )}
                    <p className={clsx(
                      'mt-1 flex items-center justify-end gap-1 text-[10px] uppercase tracking-wider',
                      message.direction === 'OUT' && message.author === 'BOT' ? 'text-line' : 'text-ink-3',
                    )}>
                      {message.author === 'CONTACT'
                        ? 'Cliente'
                        : message.author === 'BOT'
                          ? 'IA'
                          : (message.authorName ?? 'Agente')}
                      {' · '}{fmtDateTime(message.createdAt)}
                      {message.direction === 'OUT' && <DeliveryTicks status={message.deliveryStatus} />}
                    </p>
                  </div>
                </div>
              ))}
              {typingBy && (
                <p className="flex items-center gap-2 text-xs text-ink-3">
                  <UserRound size={12} />
                  <span className="italic">{typingBy} está escribiendo…</span>
                  <span className="inline-flex gap-0.5" aria-hidden>
                    <span className="h-1 w-1 animate-pulse bg-ink-3" />
                    <span className="h-1 w-1 animate-pulse bg-ink-3 [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-pulse bg-ink-3 [animation-delay:300ms]" />
                  </span>
                </p>
              )}
            </div>

            {canWrite && (
              <footer className="relative flex gap-2 border-t-2 border-ink p-3">
                {replyMatches.length > 0 && (
                  <div className="absolute bottom-full left-3 right-3 mb-1 border-2 border-ink bg-paper shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]">
                    {replyMatches.map((r, i) => (
                      <button
                        key={r.id}
                        className={clsx('block w-full cursor-pointer px-3 py-2 text-left', i === replyIndex % replyMatches.length ? 'bg-ink text-bone' : 'hover:bg-bone-2')}
                        onMouseDown={(e) => { e.preventDefault(); applyReply(r); }}
                      >
                        <span className="font-mono text-xs opacity-70">/{r.shortcut}</span>
                        <span className="ml-2 text-sm font-semibold">{r.title}</span>
                        <span className="block truncate text-xs opacity-70">{r.body}</span>
                      </button>
                    ))}
                  </div>
                )}
                <Textarea
                  rows={2}
                  placeholder={
                    detail.botPaused
                      ? 'Responder como humano…'
                      : 'Intervenir como humano… (la IA se pausa) · / para respuestas rápidas'
                  }
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    notifyTyping();
                  }}
                  onKeyDown={(e) => {
                    if (replyMatches.length) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        setReplyIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : replyMatches.length - 1)) % replyMatches.length);
                        return;
                      }
                      if (e.key === 'Enter' || e.key === 'Tab') {
                        e.preventDefault();
                        applyReply(replyMatches[replyIndex % replyMatches.length]);
                        return;
                      }
                    }
                    if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
                      e.preventDefault();
                      send.mutate(undefined);
                    }
                  }}
                />
                <div className="flex flex-col gap-2">
                  <Button
                    disabled={!draft.trim() || send.isPending}
                    onClick={() => send.mutate(undefined)}
                    aria-label="Enviar"
                  >
                    <Send size={14} />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setPhotoPicker(true)}
                    aria-label="Enviar foto de la galería"
                  >
                    <ImageIcon size={14} />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setManagingReplies(true)}
                    aria-label="Respuestas rápidas"
                    title="Respuestas rápidas (escribe / en el mensaje)"
                  >
                    <Zap size={14} />
                  </Button>
                </div>
              </footer>
            )}
          </div>
        ) : (
          <div className="hidden items-center justify-center lg:flex">
            <p className="serif-accent text-2xl text-ink-3">
              elige una conversación para supervisarla.
            </p>
          </div>
        )}
      </div>

      {/* Acciones rápidas sobre el contacto de la conversación */}
      {detail && (
        <>
          <AppointmentModal
            open={scheduling}
            onClose={() => setScheduling(false)}
            contacts={[detail.contact]}
            presetContactId={detail.contact.id}
          />
          <FollowUpModal
            open={followingUp}
            onClose={() => setFollowingUp(false)}
            contacts={[detail.contact]}
            presetContactId={detail.contact.id}
          />
        </>
      )}

      <QuickRepliesModal open={managingReplies} onClose={() => setManagingReplies(false)} q={q} />

      {/* Enviar foto de la galería */}
      <Modal
        open={photoPicker}
        onClose={() => setPhotoPicker(false)}
        kicker="Galería"
        title="Enviar foto"
        wide
      >
        {(mediaAssets?.length ?? 0) === 0 ? (
          <p className="py-6 text-center text-sm text-ink-3">
            No hay imágenes activas en la galería. Cárgalas en la sección Galería.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {mediaAssets?.map((asset) => (
              <button
                key={asset.id}
                className="cursor-pointer border-2 border-ink bg-bone text-left transition-shadow hover:shadow-[4px_4px_0_0_rgba(26,26,26,0.9)]"
                disabled={send.isPending}
                onClick={() => send.mutate({ mediaAssetId: asset.id })}
              >
                <MediaImage id={asset.id} alt={asset.name} className="h-28 w-full border-b-2 border-ink" />
                <div className="flex items-center justify-between gap-1 p-2">
                  <p className="truncate text-xs font-semibold">{asset.name}</p>
                  {asset.priceUsd > 0 && <Badge tone="ink">{fmtUsd(asset.priceUsd)}</Badge>}
                </div>
              </button>
            ))}
          </div>
        )}
      </Modal>
    </>
  );
}
