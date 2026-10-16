import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Activity, CheckCircle2, Database, Mail, MessageSquare, RefreshCw,
  Send, Sparkles, XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtNum, timeAgo } from '../../lib/format';
import type { ApiKeyRow, Company } from '../../lib/types';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, Stat, Table, Tabs, Textarea,
} from '../../components/ui';

/* ─── Tipos del panel ────────────────────────────────────────────────── */

interface DevStatus {
  status: string;
  db: { ok: boolean; latencyMs: number; engine: string };
  redis: { ok: boolean };
  queues: Array<{ name: string; waiting?: number; active?: number; delayed?: number; failed?: number; completed?: number; error?: string }>;
  sseConnections: number;
  process: { uptimeSeconds: number; node: string; rssMb: number; heapMb: number; env: string };
  settingsChecklist: Array<{ group: string; purpose: string; complete: boolean; keys: Array<{ key: string; configured: boolean }> }>;
}

interface LogEntry {
  at: string;
  level: 'error' | 'warn' | 'log';
  context?: string;
  message: string;
}

interface OpsHealth {
  ok: boolean;
  recordatoriosFallidos: Array<{ id: string; company?: string; kind: string; lastError?: string }>;
  mensajesNoEntregados: Array<{ id: string; conversationId: string; preview: string }>;
  escalamientos: { ultimas24h: number; promedioDiario7d: number; anormal: boolean };
  feedbackNegativo7d: number;
  conversacionesConAlerta: number;
}

/* ─── Pestaña: Salud ─────────────────────────────────────────────────── */

function HealthTab({ companies }: { companies: Company[] }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['dev-status'],
    queryFn: () => api.get<DevStatus>('/dev/status'),
    refetchInterval: 10_000,
  });
  const { data: ops } = useQuery({
    queryKey: ['dev-ops-health'],
    queryFn: () => api.get<OpsHealth>('/reports/ops-health'),
    refetchInterval: 30_000,
  });

  const retryFailed = useMutation({
    mutationFn: () => api.post<Record<string, number>>('/dev/queues/retry-failed'),
    onSuccess: (r) => {
      toast.success(`Reintentados: ${Object.entries(r).map(([q, n]) => `${q} ${n}`).join(' · ')}`);
      queryClient.invalidateQueries({ queryKey: ['dev-status'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const [testTo, setTestTo] = useState('');
  const testEmail = useMutation({
    mutationFn: () => api.post<{ status?: string }>('/dev/test-email', { to: testTo }),
    onSuccess: (r: any) =>
      toast.success(
        r?.status === 'SENT'
          ? 'Correo de prueba ENVIADO'
          : 'Correo en cola (falta SMTP — se envía al configurarlo)',
      ),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const [diCompany, setDiCompany] = useState('');
  const testDi = useMutation({
    mutationFn: () => api.post<{
      ok: boolean; latencyMs?: number; model?: string; error?: string;
      checks?: Array<{ source: 'BYOK' | 'PLATFORM'; ok: boolean; latencyMs: number; error?: string }>;
    }>('/dev/test-deepinfra', { companyId: diCompany }),
    onSuccess: (r) => {
      const label = { BYOK: 'Cuenta de la empresa', PLATFORM: 'IA de BackOffice' };
      // Una línea por cuenta probada (en híbrido, las dos)
      if (r.checks?.length) {
        for (const c of r.checks) {
          c.ok
            ? toast.success(`${label[c.source]}: OK · ${c.latencyMs} ms`)
            : toast.error(`${label[c.source]}: falló — ${c.error}`, { duration: 8000 });
        }
        return;
      }
      r.ok
        ? toast.success(`Llave OK · ${r.latencyMs} ms · ${r.model}`)
        : toast.error(`Llave falló: ${r.error}`, { duration: 8000 });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!status) return <Loading label="Midiendo el sistema…" />;
  const uptime = `${Math.floor(status.process.uptimeSeconds / 3600)}h ${Math.floor((status.process.uptimeSeconds % 3600) / 60)}m`;
  const totalFailed = status.queues.reduce((a, q) => a + (q.failed ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Semáforo general */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Estado"
          value={status.status === 'ok' ? 'OK' : 'Degradado'}
          tone={status.status === 'ok' ? 'ok' : 'bad'}
          hint={`env ${status.process.env}`}
        />
        <Stat
          label="Base de datos"
          value={status.db.ok ? `${status.db.latencyMs} ms` : 'CAÍDA'}
          tone={status.db.ok ? (status.db.latencyMs < 500 ? 'ok' : 'warn') : 'bad'}
          hint={status.db.engine}
        />
        <Stat
          label="Redis / colas"
          value={status.redis.ok ? 'OK' : 'CAÍDO'}
          tone={status.redis.ok ? 'ok' : 'bad'}
          hint={`${totalFailed} jobs fallidos`}
        />
        <Stat label="SSE en vivo" value={status.sseConnections} hint="paneles conectados" />
        <Stat label="Uptime" value={uptime} hint={`Node ${status.process.node}`} />
        <Stat label="Memoria" value={`${status.process.rssMb} MB`} hint={`heap ${status.process.heapMb} MB`} />
      </div>

      {/* Colas */}
      <Card
        kicker="BullMQ sobre Redis"
        title="Colas de trabajo"
        actions={
          <Button size="sm" variant="outline" disabled={retryFailed.isPending || totalFailed === 0}
            onClick={() => retryFailed.mutate()}>
            <RefreshCw size={13} /> Reintentar fallidos ({totalFailed})
          </Button>
        }
      >
        <Table head={['Cola', 'En espera', 'Activos', 'Demorados', 'Fallidos', 'Completados']}>
          {status.queues.map((q) => (
            <tr key={q.name} className={q.error || (q.failed ?? 0) > 0 ? 'bg-bad-soft' : ''}>
              <td className="px-4 py-2.5 font-mono text-xs font-semibold">{q.name}</td>
              {q.error ? (
                <td colSpan={5} className="px-4 py-2.5 text-sm text-bad">{q.error}</td>
              ) : (
                <>
                  <td className="px-4 py-2.5 tabular-nums">{q.waiting}</td>
                  <td className="px-4 py-2.5 tabular-nums">{q.active}</td>
                  <td className="px-4 py-2.5 tabular-nums">{q.delayed}</td>
                  <td className={clsx('px-4 py-2.5 font-semibold tabular-nums', (q.failed ?? 0) > 0 && 'text-bad')}>{q.failed}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-3">{fmtNum(q.completed ?? 0)}</td>
                </>
              )}
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Alertas operativas cross-tenant */}
        <Card kicker="Todas las empresas" title="Alertas operativas">
          {!ops ? (
            <Loading />
          ) : (
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2">
                {ops.escalamientos.anormal
                  ? <XCircle size={15} className="text-bad" />
                  : <CheckCircle2 size={15} className="text-ok" />}
                Escalamientos 24 h: <strong>{ops.escalamientos.ultimas24h}</strong>
                <span className="text-ink-3">(promedio {ops.escalamientos.promedioDiario7d}/día{ops.escalamientos.anormal ? ' — POR ENCIMA DE LO NORMAL' : ''})</span>
              </p>
              <p className="flex items-center gap-2">
                {ops.recordatoriosFallidos.length
                  ? <XCircle size={15} className="text-bad" />
                  : <CheckCircle2 size={15} className="text-ok" />}
                Recordatorios fallidos (7 d): <strong>{ops.recordatoriosFallidos.length}</strong>
              </p>
              <p className="flex items-center gap-2">
                {ops.mensajesNoEntregados.length
                  ? <XCircle size={15} className="text-bad" />
                  : <CheckCircle2 size={15} className="text-ok" />}
                Mensajes no entregados (7 d): <strong>{ops.mensajesNoEntregados.length}</strong>
              </p>
              <p className="text-ink-2">
                Conversaciones con alerta: <strong>{ops.conversacionesConAlerta}</strong> ·
                Feedback negativo 7 d: <strong>{ops.feedbackNegativo7d}</strong>
              </p>
              {ops.recordatoriosFallidos.slice(0, 5).map((r) => (
                <p key={r.id} className="border-l-2 border-bad pl-2 text-xs text-ink-2">
                  {r.company ? `${r.company} · ` : ''}{r.kind}: {r.lastError ?? 'sin detalle'}
                </p>
              ))}
            </div>
          )}
        </Card>

        {/* Checklist de settings */}
        <Card kicker="Qué falta para operar al 100%" title="Configuración de plataforma">
          <div className="space-y-2.5">
            {status.settingsChecklist.map((g) => (
              <div key={g.group} className="border-b border-line pb-2">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {g.complete
                    ? <CheckCircle2 size={14} className="text-ok" />
                    : <XCircle size={14} className="text-warn" />}
                  {g.group}
                  <span className="font-normal text-xs text-ink-3">— {g.purpose}</span>
                </p>
                {!g.complete && (
                  <p className="mt-1 pl-6 text-xs text-ink-3">
                    Falta: {g.keys.filter((k) => !k.configured).map((k) => k.key).join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Utilidades de prueba */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card kicker="¿El SMTP funciona?" title="Probar correo">
          <div className="flex gap-2">
            <Input type="email" placeholder="tu@correo.com" value={testTo}
              onChange={(e) => setTestTo(e.target.value)} />
            <Button variant="outline" disabled={!testTo.includes('@') || testEmail.isPending}
              onClick={() => testEmail.mutate()}>
              <Mail size={14} /> Enviar
            </Button>
          </div>
        </Card>
        <Card kicker="¿La llave BYOK de una empresa sirve?" title="Probar DeepInfra">
          <div className="flex gap-2">
            <Select value={diCompany} onChange={(e) => setDiCompany(e.target.value)}>
              <option value="" disabled>Empresa…</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Button variant="outline" disabled={!diCompany || testDi.isPending}
              onClick={() => testDi.mutate()}>
              <Sparkles size={14} /> {testDi.isPending ? 'Probando…' : 'Probar'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            Hace una llamada mínima (~5 tokens) con la llave de la empresa y mide la latencia.
          </p>
        </Card>
      </div>
      <GeminiStatus />
    </div>
  );
}

/* ─── Pestaña: Simulador ─────────────────────────────────────────────── */

function SimulatorTab({ companies }: { companies: Company[] }) {
  const [companyId, setCompanyId] = useState('');
  const [from, setFrom] = useState('+573000000001');
  const [name, setName] = useState('Cliente Simulado');
  const [body, setBody] = useState('');
  const [history, setHistory] = useState<Array<{ at: string; body: string; ok: boolean; detail: string }>>([]);

  const simulate = useMutation({
    mutationFn: () => api.post<{ ok: boolean; sid: string; line: string }>('/dev/simulate-inbound', {
      companyId, from, name, body,
    }),
    onSuccess: (r) => {
      toast.success(`Mensaje inyectado a "${r.line}" — mira la bandeja de la empresa`);
      setHistory((h) => [{ at: new Date().toLocaleTimeString(), body, ok: true, detail: r.sid }, ...h].slice(0, 10));
      setBody('');
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : 'Error';
      toast.error(msg, { duration: 8000 });
      setHistory((h) => [{ at: new Date().toLocaleTimeString(), body, ok: false, detail: msg }, ...h].slice(0, 10));
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <Card
        kicker="Dispara el MISMO flujo del webhook (cola → contacto → conversación → motor) sin salir a internet"
        title="Simular mensaje entrante"
      >
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Empresa (línea en sandbox)" required>
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                <option value="" disabled>Elegir…</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Teléfono del cliente">
              <Input value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="Nombre del cliente">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Mensaje" required>
            <Textarea
              rows={3}
              placeholder="Hola, quiero 30 almuerzos para el jueves a las 11:30 en la Obra Norte…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && body.trim() && companyId) {
                  e.preventDefault();
                  simulate.mutate();
                }
              }}
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-3">
              Solo funciona con líneas EN SANDBOX — contra una línea de producción
              el API lo rechaza. Ideal para demos y para probar el motor.
            </p>
            <Button disabled={!companyId || !body.trim() || simulate.isPending} onClick={() => simulate.mutate()}>
              <Send size={14} /> {simulate.isPending ? 'Inyectando…' : 'Enviar'}
            </Button>
          </div>
        </div>
      </Card>

      <Card kicker="Esta sesión" title="Historial">
        {history.length === 0 ? (
          <p className="py-4 text-sm text-ink-3">
            Los mensajes simulados aparecen aquí y en la bandeja de la empresa
            (con la respuesta de la IA si tiene bot activo y llave).
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((h, i) => (
              <div key={i} className={clsx('border-l-2 pl-2 text-sm', h.ok ? 'border-ok' : 'border-bad')}>
                <p className="truncate">{h.body}</p>
                <p className="text-[11px] text-ink-3">{h.at} · {h.detail.slice(0, 48)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─── Pestaña: Logs ──────────────────────────────────────────────────── */

function LogsTab() {
  const [level, setLevel] = useState('all');
  const { data: logs, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['dev-logs', level],
    queryFn: () => api.get<LogEntry[]>(`/dev/logs?level=${level}&limit=150`),
    refetchInterval: 15_000,
  });

  return (
    <Card
      kicker="Últimos 500 en memoria del proceso (errores y warnings)"
      title="Logs del API"
      actions={
        <div className="flex gap-2">
          <Select value={level} onChange={(e) => setLevel(e.target.value)} className="!py-1.5 text-xs">
            <option value="all">Todo</option>
            <option value="error">Solo errores</option>
            <option value="warn">Solo warnings</option>
          </Select>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw size={13} />
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <Loading />
      ) : (logs?.length ?? 0) === 0 ? (
        <EmptyState title="Sin entradas" hint="Nada roto por ahora. Los errores y warnings del proceso aparecen aquí al instante." />
      ) : (
        <div className="max-h-[520px] space-y-1 overflow-y-auto font-mono text-xs">
          {logs?.map((entry, i) => (
            <div
              key={i}
              className={clsx(
                'flex gap-2 border-l-2 py-0.5 pl-2',
                entry.level === 'error' ? 'border-bad bg-bad-soft' : 'border-warn',
              )}
            >
              <span className="shrink-0 text-ink-3">{new Date(entry.at).toLocaleTimeString()}</span>
              {entry.context && <span className="shrink-0 font-semibold">[{entry.context}]</span>}
              <span className="break-all">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ─── Página ─────────────────────────────────────────────────────────── */

export default function DevTools() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('salud');
  const [newKey, setNewKey] = useState<{ name: string; companyId: string; scopes: string[] } | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const { data: apiKeys, isLoading } = useQuery({
    queryKey: ['apikeys'],
    queryFn: () => api.get<ApiKeyRow[]>('/dev/apikeys'),
    enabled: tab === 'apikeys',
  });
  const { data: settings } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => api.get<Record<string, string>>('/dev/settings'),
    enabled: tab === 'settings',
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });

  const createKey = useMutation({
    mutationFn: (form: { name: string; companyId: string; scopes: string[] }) =>
      api.post<ApiKeyRow>('/dev/apikeys', {
        name: form.name,
        companyId: form.companyId || undefined,
        scopes: form.scopes,
      }),
    onSuccess: (key) => {
      queryClient.invalidateQueries({ queryKey: ['apikeys'] });
      setNewKey(null);
      setCreatedSecret(key.secret ?? null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api.delete(`/dev/apikeys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['apikeys'] });
      toast.success('API key revocada');
    },
  });

  const runInvoices = useMutation({
    mutationFn: () => api.post<{ period: string; created: number; skipped: number }>('/jobs/invoices'),
    onSuccess: (r) =>
      toast.success(`Facturas ${r.period}: ${r.created} creadas, ${r.skipped} ya existían`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const runReports = useMutation({
    mutationFn: () => api.post<{ sent: number }>('/jobs/executive-emails'),
    onSuccess: (r) => toast.success(`${r.sent} reporte(s) a gerencia generados (ver Correos)`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const resetDemo = useMutation({
    mutationFn: () => api.post('/jobs/demo-reset'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa demo restaurada: datos frescos y tour sin ver');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const saveSettings = useMutation({
    mutationFn: (values: Record<string, string>) => api.put('/dev/settings', values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-settings'] });
      queryClient.invalidateQueries({ queryKey: ['dev-status'] });
      toast.success('Configuración guardada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <>
      <PageHeader kicker="Panel técnico" title="Dev" accent="tools." />

      <div className="mb-5">
        <Tabs
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'salud', label: 'Salud' },
            { id: 'simulador', label: 'Simulador' },
            { id: 'logs', label: 'Logs' },
            { id: 'operacion', label: 'Operación' },
            { id: 'settings', label: 'Settings' },
            { id: 'apikeys', label: 'API keys' },
          ]}
        />
      </div>

      {tab === 'salud' && <HealthTab companies={companies ?? []} />}
      {tab === 'simulador' && <SimulatorTab companies={companies ?? []} />}
      {tab === 'logs' && <LogsTab />}

      {tab === 'operacion' && (
        <Card kicker="Crons: facturas el día 1 · reporte a gerencia 7:00 · reporte diario por hora local · recordatorios cada minuto" title="Operación">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" disabled={runInvoices.isPending} onClick={() => runInvoices.mutate()}>
              {runInvoices.isPending ? 'Generando…' : 'Generar facturas del mes anterior'}
            </Button>
            <Button variant="outline" disabled={runReports.isPending} onClick={() => runReports.mutate()}>
              {runReports.isPending ? 'Enviando…' : 'Enviar reportes a gerencia ahora'}
            </Button>
            <Button variant="outline" disabled={resetDemo.isPending} onClick={() => resetDemo.mutate()}>
              {resetDemo.isPending ? 'Restaurando…' : 'Restaurar empresa demo'}
            </Button>
            <p className="text-xs text-ink-3">
              Todos los jobs corren solos y son idempotentes; estos botones los disparan a demanda.
              Los recordatorios del módulo de pedidos y el poll de videos corren cada minuto/30 s.
            </p>
          </div>
        </Card>
      )}

      {tab === 'settings' && settings && (
        <Card kicker="Credenciales y parámetros de plataforma" title="Settings">
          <SettingsForm
            settings={settings}
            onSave={(values) => saveSettings.mutate(values)}
            saving={saveSettings.isPending}
          />
        </Card>
      )}

      {tab === 'apikeys' && (
        <Card
          kicker="Acceso programático"
          title="API keys"
          actions={<Button size="sm" onClick={() => setNewKey({ name: '', companyId: '', scopes: ['read'] })}>+ Nueva</Button>}
        >
          {isLoading ? (
            <Loading />
          ) : (
            <div className="space-y-2">
              {apiKeys?.map((key) => (
                <div key={key.id} className="flex items-center justify-between gap-3 border-b border-line pb-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{key.name}</p>
                    <p className="font-mono text-xs text-ink-3">
                      {key.prefix}···{key.company ? ` · ${key.company.name}` : ' · global'}
                    </p>
                    <p className="mt-0.5 flex flex-wrap gap-1">
                      {(key.scopes ?? []).map((sc) => <Badge key={sc} tone={sc === 'orders' ? 'info' : 'neutral'}>{SCOPE_LABELS[sc] ?? sc}</Badge>)}
                      {key.lastUsedAt && <span className="text-[11px] text-ink-3">usada {new Date(key.lastUsedAt).toLocaleString('es-CO')}</span>}
                    </p>
                  </div>
                  {key.revokedAt ? (
                    <Badge tone="bad">Revocada</Badge>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => revokeKey.mutate(key.id)}>
                      Revocar
                    </Button>
                  )}
                </div>
              ))}
              {apiKeys?.length === 0 && (
                <p className="py-4 text-sm text-ink-3">Sin API keys todavía.</p>
              )}
            </div>
          )}
        </Card>
      )}
      {tab === 'apikeys' && <InboundOrdersDocs />}

      {/* Modal nueva key */}
      <Modal open={!!newKey} onClose={() => setNewKey(null)} kicker="API keys" title="Nueva API key">
        {newKey && (
          <div className="space-y-4">
            <Field label="Nombre" required>
              <Input value={newKey.name} placeholder="Integración n8n producción"
                onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} />
            </Field>
            <Field label="Empresa (opcional)" hint="Vacío = key global de plataforma">
              <Select value={newKey.companyId}
                onChange={(e) => setNewKey({ ...newKey, companyId: e.target.value })}>
                <option value="">Global</option>
                {companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Permisos">
              <div className="flex flex-wrap gap-3 text-sm">
                {Object.entries(SCOPE_LABELS).map(([sc, label]) => (
                  <label key={sc} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={newKey.scopes.includes(sc)}
                      onChange={(e) => setNewKey({ ...newKey, scopes: e.target.checked ? [...newKey.scopes, sc] : newKey.scopes.filter((x) => x !== sc) })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </Field>
            {newKey.scopes.includes('orders') && !newKey.companyId && (
              <p className="text-xs text-warn">Para recibir pedidos externos la key debe pertenecer a una empresa.</p>
            )}
            <Button
              className="w-full"
              disabled={!newKey.name || !newKey.scopes.length || (newKey.scopes.includes('orders') && !newKey.companyId) || createKey.isPending}
              onClick={() => createKey.mutate(newKey)}
            >
              {createKey.isPending ? 'Generando…' : 'Generar key'}
            </Button>
          </div>
        )}
      </Modal>

      {/* Modal secreto (solo se muestra una vez) */}
      <Modal
        open={!!createdSecret}
        onClose={() => setCreatedSecret(null)}
        kicker="Guárdala ahora"
        title="API key generada"
      >
        <p className="mb-3 text-sm">
          Este secreto <strong>no se vuelve a mostrar</strong>. Cópialo y guárdalo
          en un lugar seguro.
        </p>
        <div className="break-all border-2 border-ink bg-bone p-3 font-mono text-xs">
          {createdSecret}
        </div>
        <Button
          className="mt-4 w-full"
          onClick={() => {
            navigator.clipboard.writeText(createdSecret ?? '');
            toast.success('Copiada al portapapeles');
          }}
        >
          Copiar
        </Button>
      </Modal>
    </>
  );
}

function SettingsForm({
  settings,
  onSave,
  saving,
}: {
  settings: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    META_APP_ID: settings.META_APP_ID ?? '',
    META_REDIRECT_URI: settings.META_REDIRECT_URI ?? '',
    META_VERIFY_TOKEN: settings.META_VERIFY_TOKEN ?? '',
    PLATFORM_NAME: settings.PLATFORM_NAME ?? 'BackOffice',
    SUPPORT_WHATSAPP: settings.SUPPORT_WHATSAPP ?? '',
    WEBHOOK_BASE_URL: settings.WEBHOOK_BASE_URL ?? '',
    PUBLIC_WEB_URL: settings.PUBLIC_WEB_URL ?? '',
    DEEPINFRA_API_KEY: settings.DEEPINFRA_API_KEY ?? '',
    MPT_BASE_URL: settings.MPT_BASE_URL ?? '',
    MPT_API_KEY: settings.MPT_API_KEY ?? '',
    WOMPI_ENV: settings.WOMPI_ENV ?? 'test',
    WOMPI_PUBLIC_KEY: settings.WOMPI_PUBLIC_KEY ?? '',
    WOMPI_INTEGRITY_SECRET: settings.WOMPI_INTEGRITY_SECRET ?? '',
    WOMPI_EVENTS_SECRET: settings.WOMPI_EVENTS_SECRET ?? '',
    WOMPI_REDIRECT_URL: settings.WOMPI_REDIRECT_URL ?? '',
    USD_COP_RATE: settings.USD_COP_RATE ?? '4000',
    SMTP_HOST: settings.SMTP_HOST ?? '',
    SMTP_PORT: settings.SMTP_PORT ?? '587',
    SMTP_USER: settings.SMTP_USER ?? '',
    SMTP_PASS: settings.SMTP_PASS ?? '',
    SMTP_FROM: settings.SMTP_FROM ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-3">
      <Field label="URL pública de webhooks (WEBHOOK_BASE_URL)" hint="Dominio HTTPS donde Twilio/Meta encuentran el API (validación de firmas)">
        <Input value={form.WEBHOOK_BASE_URL} onChange={(e) => set({ WEBHOOK_BASE_URL: e.target.value })} placeholder="https://api.tudominio.com" />
      </Field>
      <Field
        label="URL pública de la web (PUBLIC_WEB_URL)"
        hint="Dominio donde el cliente final abre el seguimiento de su pedido (/t/…). Vacío = se deduce de los webhooks o del origen de la web"
      >
        <Input value={form.PUBLIC_WEB_URL} onChange={(e) => set({ PUBLIC_WEB_URL: e.target.value })} placeholder="https://app.tudominio.com" />
      </Field>
      <Field label="Meta App ID" hint="De developers.facebook.com — pendiente de crear">
        <Input value={form.META_APP_ID} onChange={(e) => set({ META_APP_ID: e.target.value })} />
      </Field>
      <Field label="OAuth Redirect URI">
        <Input value={form.META_REDIRECT_URI} onChange={(e) => set({ META_REDIRECT_URI: e.target.value })} />
      </Field>
      <Field
        label="Verify token del webhook"
        hint="El mismo que se registra en Meta al configurar el webhook (GET /api/webhooks/:slug/whatsapp)"
      >
        <Input type="password" value={form.META_VERIFY_TOKEN}
          onChange={(e) => set({ META_VERIFY_TOKEN: e.target.value })} />
      </Field>
      <Field label="Nombre de plataforma">
        <Input value={form.PLATFORM_NAME} onChange={(e) => set({ PLATFORM_NAME: e.target.value })} />
      </Field>
      <Field label="WhatsApp de soporte">
        <Input value={form.SUPPORT_WHATSAPP} onChange={(e) => set({ SUPPORT_WHATSAPP: e.target.value })} />
      </Field>

      <div className="border-t-2 border-line pt-3">
        <p className="kicker mb-2">DeepInfra · motor de modelos IA</p>
        <Field label="API key de pruebas del estudio (opcional)" hint="Cada empresa configura SU propia llave en su panel (BYOK) — esta es solo para pruebas internas">
          <Input type="password" value={form.DEEPINFRA_API_KEY}
            onChange={(e) => set({ DEEPINFRA_API_KEY: e.target.value })} />
        </Field>
      </div>

      <div className="border-t-2 border-line pt-3">
        <p className="kicker mb-2">Generador de video (MoneyPrinterTurbo) · reels del módulo de marketing</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="MPT_BASE_URL" hint="p. ej. http://localhost:8080">
            <Input value={form.MPT_BASE_URL} onChange={(e) => set({ MPT_BASE_URL: e.target.value })} />
          </Field>
          <Field label="MPT_API_KEY" hint="Vacío si el generador no exige llave">
            <Input type="password" value={form.MPT_API_KEY} onChange={(e) => set({ MPT_API_KEY: e.target.value })} />
          </Field>
        </div>
      </div>

      <div className="border-t-2 border-line pt-3">
        <p className="kicker mb-2">Pasarela Wompi (Colombia) · Internacional: próximamente</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Ambiente">
            <Input value={form.WOMPI_ENV} onChange={(e) => set({ WOMPI_ENV: e.target.value })} placeholder="test | production" />
          </Field>
          <Field label="Tasa USD → COP" hint="Para convertir la mensualidad">
            <Input value={form.USD_COP_RATE} onChange={(e) => set({ USD_COP_RATE: e.target.value })} />
          </Field>
          <Field label="Public key" hint="pub_test_… / pub_prod_…">
            <Input value={form.WOMPI_PUBLIC_KEY} onChange={(e) => set({ WOMPI_PUBLIC_KEY: e.target.value })} />
          </Field>
          <Field label="Integrity secret" hint="Firma del checkout">
            <Input type="password" value={form.WOMPI_INTEGRITY_SECRET} onChange={(e) => set({ WOMPI_INTEGRITY_SECRET: e.target.value })} />
          </Field>
          <Field label="Events secret" hint="Verifica los webhooks">
            <Input type="password" value={form.WOMPI_EVENTS_SECRET} onChange={(e) => set({ WOMPI_EVENTS_SECRET: e.target.value })} />
          </Field>
          <Field label="Redirect tras pagar">
            <Input value={form.WOMPI_REDIRECT_URL} onChange={(e) => set({ WOMPI_REDIRECT_URL: e.target.value })} />
          </Field>
        </div>
        <p className="mt-2 text-xs text-ink-3">
          Webhook a registrar en Wompi: <code className="border border-line bg-bone px-1 font-mono">POST /api/payments/wompi/events</code>
        </p>
      </div>

      <div className="border-t-2 border-line pt-3">
        <p className="kicker mb-2">SMTP · correos a empresas</p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Host">
            <Input value={form.SMTP_HOST} onChange={(e) => set({ SMTP_HOST: e.target.value })} placeholder="smtp.resend.com" />
          </Field>
          <Field label="Puerto">
            <Input value={form.SMTP_PORT} onChange={(e) => set({ SMTP_PORT: e.target.value })} />
          </Field>
          <Field label="Usuario">
            <Input value={form.SMTP_USER} onChange={(e) => set({ SMTP_USER: e.target.value })} />
          </Field>
          <Field label="Contraseña">
            <Input type="password" value={form.SMTP_PASS} onChange={(e) => set({ SMTP_PASS: e.target.value })} />
          </Field>
          <div className="md:col-span-2">
            <Field label="Remitente (From)">
              <Input value={form.SMTP_FROM} onChange={(e) => set({ SMTP_FROM: e.target.value })} placeholder="BackOffice <hola@backoffice.dev>" />
            </Field>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button disabled={saving} onClick={() => onSave(form)}>
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
      </div>
    </div>
  );
}

const SCOPE_LABELS: Record<string, string> = { read: 'Lectura', write: 'Escritura', orders: 'Pedidos externos' };

/** Cómo conectar Rappi, un POS o la tienda web: POST /api/inbound/orders. */
function InboundOrdersDocs() {
  const example = `curl -X POST ${window.location.origin}/api/inbound/orders \\
  -H "x-api-key: bo_live_…" -H "Content-Type: application/json" \\
  -d '{
    "source": "RAPPI",
    "externalId": "RP-99812",
    "customer": { "name": "Laura Gómez", "phone": "+573001112233",
                  "address": "Cra 70 #44-10, Laureles", "notes": "Torre 2" },
    "items": [ { "name": "Bandeja paisa", "quantity": 2, "unitPrice": 18000 } ],
    "deliveryFee": 0,
    "paid": true
  }'`;
  return (
    <Card kicker="Rappi, Uber Eats, DiDi, POS, tienda web" title="Pedidos externos">
      <div className="space-y-3 text-sm">
        <p className="text-ink-2">
          Rappi no tiene API pública para restaurantes pequeños: se conecta con un integrador (o Zapier/n8n leyendo el
          correo del pedido) que llama a este endpoint. El pedido entra al mismo flujo: cocina, comanda, domicilios y reportes.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-2">
          <li>Usa una API key de la empresa con permiso <b>Pedidos externos</b>.</li>
          <li><span className="font-mono">source</span>: RAPPI, UBER_EATS, DIDI, IFOOD, WEB, POS u OTRO. <span className="font-mono">externalId</span> evita duplicados: reenviar el mismo pedido devuelve el existente.</li>
          <li>Los productos se emparejan por nombre con el catálogo; si no existen entran como texto libre.</li>
        </ul>
        <pre className="overflow-x-auto border-2 border-ink bg-ink p-3 text-[11px] leading-relaxed text-bone">{example}</pre>
      </div>
    </Card>
  );
}

/** Llaves genéricas de Gemini (registro web y guía): uso de hoy y rotación. */
function GeminiStatus() {
  const { data, refetch, isFetching } = useQuery({
    queryKey: ['gemini-status'],
    queryFn: () => api.get<{ models: string[]; keys: Array<{ label: string; requestsToday: number; limit: number; exhausted: boolean; lastError: string | null }> }>('/onboarding/ai-status'),
  });
  return (
    <Card
      kicker="Registro web y guía de configuración"
      title="IA genérica (Gemini)"
      actions={<Button size="sm" variant="outline" disabled={isFetching} onClick={() => refetch()}>Actualizar</Button>}
    >
      {!data ? <Loading /> : data.keys.length === 0 ? (
        <p className="text-sm text-warn">Sin llaves: agrega GEMINI_API_KEYS en el .env del API.</p>
      ) : (
        <div className="space-y-2">
          {data.keys.map((k) => (
            <div key={k.label} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2 text-sm">
              <span className="font-mono text-xs">{k.label}</span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{k.requestsToday} / {k.limit} hoy</span>
                <Badge tone={k.exhausted ? 'bad' : 'ok'}>{k.exhausted ? 'Agotada · se usa la siguiente' : 'Disponible'}</Badge>
              </span>
              {k.lastError && <span className="w-full text-[11px] text-ink-3">Último error: {k.lastError}</span>}
            </div>
          ))}
          <p className="text-xs text-ink-3">Modelos en orden de prueba: {data.models.join(' → ')}. El tope diario se cambia con GEMINI_DAILY_LIMIT.</p>
        </div>
      )}
    </Card>
  );
}
