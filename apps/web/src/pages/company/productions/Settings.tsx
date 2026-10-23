import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Tabs } from '../../../components/ui';
import { PickCompany, useCompanyScope } from '../shared';
import { type TeamResponse, errorText, fmtDate, prodApi, useProdMutation } from './shared';

type Decision = { status: 'PENDING' | 'CONFIRMED' | 'NOT_APPLICABLE'; value?: unknown; note?: string };

const DECISIONS: Array<{ path: string; label: string; valueLabel?: string; numeric?: boolean }> = [
  { path: 'commercial.commission', label: 'Comisión (30 % indicado: base y servicios por confirmar)', valueLabel: 'Regla acordada' },
  { path: 'commercial.margins', label: 'Márgenes por tipo de servicio', valueLabel: 'Regla acordada' },
  { path: 'commercial.taxes', label: 'Impuestos y retenciones en la cotización', valueLabel: 'Regla acordada' },
  { path: 'commercial.cancellation', label: 'Política de cancelación y penalidades', valueLabel: 'Política' },
  { path: 'commercial.deposit', label: 'Anticipos y condiciones de pago', valueLabel: 'Condiciones' },
  { path: 'commercial.clientCoveredExpenses', label: 'Gastos que cubre el cliente directamente', valueLabel: 'Cuáles' },
  { path: 'availability.holdHours', label: 'Duración de una retención temporal', valueLabel: 'Horas', numeric: true },
  { path: 'availability.rules', label: 'Reglas de disponibilidad de modelos y locación', valueLabel: 'Reglas' },
  { path: 'approval.approvers', label: 'Quién aprueba cotizaciones', valueLabel: 'Quién' },
  { path: 'approval.threshold', label: 'Montos que requieren otra aprobación', valueLabel: 'Umbral' },
  { path: 'consent', label: 'Consentimiento para contactar modelos y usar sus fotos', valueLabel: 'Cómo se registra' },
];
const STATUS_TEXT: Record<string, string> = { PENDING: 'Pendiente de confirmar con LPulpo', CONFIRMED: 'Confirmado', NOT_APPLICABLE: 'No aplica' };
const READINESS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  RECEIVING: { label: 'Recibiendo datos reales', tone: 'ok' }, CONFIGURED_UNVERIFIED: { label: 'Configurada, sin verificar', tone: 'warn' },
  NOT_CONFIGURED: { label: 'Pendiente de configurar', tone: 'neutral' }, NOT_IMPLEMENTED: { label: 'No implementada', tone: 'bad' }, ERROR: { label: 'Con errores', tone: 'bad' },
};

const getPath = (o: any, path: string) => path.split('.').reduce((x, k) => x?.[k], o);
const setPath = (o: any, path: string, v: unknown) => {
  const keys = path.split('.');
  const copy = structuredClone(o);
  let cur = copy;
  keys.slice(0, -1).forEach((k) => { cur[k] = cur[k] ?? {}; cur = cur[k]; });
  cur[keys[keys.length - 1]] = v;
  return copy;
};

export default function ProductionSettings() {
  const { ready, q } = useCompanyScope();
  const [tab, setTab] = useState('decisiones');
  const settings = useQuery({ queryKey: ['production-settings', q], queryFn: () => prodApi.get<any>(q, '/settings'), enabled: ready });
  const team = useQuery({ queryKey: ['production-team', q], queryFn: () => prodApi.get<TeamResponse>(q, '/team'), enabled: ready });
  const integrations = useQuery({ queryKey: ['production-integrations', q], queryFn: () => prodApi.get<any>(q, '/integrations'), enabled: ready && tab === 'integraciones' });
  const runs = useQuery({ queryKey: ['production-runs', q], queryFn: () => prodApi.get<any[]>(q, '/runs'), enabled: ready && tab === 'motor' });
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => { if (settings.data) setCfg(settings.data.config); }, [settings.data]);
  const save = useProdMutation(q, () => prodApi.put(q, '/settings', { config: cfg }), 'Configuración guardada');
  const setProfile = useProdMutation(q, (b: { id: string; profile: string | null }) => prodApi.put(q, `/team/${b.id}`, { profile: b.profile }), 'Perfil actualizado');
  const [validation, setValidation] = useState<any>(null);

  if (!ready) return <PickCompany />;
  if (settings.isLoading || !cfg) return <Loading />;
  const canEdit = settings.data.canEdit;
  const c = settings.data.company;
  const pendingCount = DECISIONS.filter((d) => getPath(cfg, d.path)?.status === 'PENDING').length + (cfg.brief.status === 'PENDING' ? 1 : 0);

  return (
    <>
      <PageHeader kicker="Producciones" title="Configuración del flujo" actions={canEdit ? <Button onClick={() => save.mutate(undefined)} disabled={save.isPending}>{save.isPending ? 'Guardando…' : 'Guardar configuración'}</Button> : undefined} />
      <div className="mb-4 border-2 border-ink bg-paper p-4 text-sm">
        <p><b>{c?.name}</b>{c?.city ? ` · ${c.city}` : ''} · zona horaria {c?.timezone ?? '—'} · moneda {c?.currency ?? 'COP'}</p>
        <p className="mt-1 text-ink-2">{pendingCount} decisión(es) pendientes de confirmar con LPulpo. Nada comercial se aplica solo: lo pendiente queda vacío o bloquea la operación que depende de ello. Datos de la empresa en <Link className="underline" to="/app/settings">Configuración</Link>.</p>
      </div>
      <Tabs active={tab} onChange={setTab} tabs={[
        { id: 'decisiones', label: 'Parámetros comerciales', badge: pendingCount || undefined }, { id: 'brief', label: 'Servicios y brief' },
        { id: 'tareas', label: 'Tareas automáticas' }, { id: 'equipo', label: 'Usuarios y permisos' }, { id: 'integraciones', label: 'Canales e integraciones' }, { id: 'motor', label: 'Motor y errores' },
      ]} />
      <div className="mt-5 space-y-4">
        {tab === 'decisiones' && (
          <Card kicker="Pendiente de confirmar con LPulpo" title="Reglas comerciales y operativas">
            <div className="space-y-3">
              {DECISIONS.map((d) => {
                const dec: Decision = getPath(cfg, d.path) ?? { status: 'PENDING' };
                return (
                  <div key={d.path} className="grid gap-2 border-b border-line pb-3 md:grid-cols-[1.4fr_1fr_1fr_1.4fr]">
                    <p className="text-sm font-semibold">{d.label}</p>
                    <Select aria-label={`Estado: ${d.label}`} value={dec.status} disabled={!canEdit} onChange={(e) => setCfg(setPath(cfg, d.path, { ...dec, status: e.target.value }))}>
                      {Object.entries(STATUS_TEXT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </Select>
                    <Input aria-label={`${d.valueLabel}: ${d.label}`} placeholder={d.valueLabel} type={d.numeric ? 'number' : 'text'} disabled={!canEdit || dec.status !== 'CONFIRMED'} value={(dec.value as string) ?? ''} onChange={(e) => setCfg(setPath(cfg, d.path, { ...dec, value: d.numeric ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value }))} />
                    <Input aria-label={`Nota: ${d.label}`} placeholder="Nota" disabled={!canEdit} value={dec.note ?? ''} onChange={(e) => setCfg(setPath(cfg, d.path, { ...dec, note: e.target.value }))} />
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-ink-3">Hoy el sistema usa directamente solo la duración de retenciones (si está confirmada). La comisión y los márgenes se ingresan en cada cotización hasta que se acuerde una regla.</p>
          </Card>
        )}

        {tab === 'brief' && (
          <>
            <Card kicker="Servicios" title="Tipos de servicio que ofrece la agencia">
              <div className="flex flex-wrap gap-3">
                {cfg.serviceTypes.map((s: any, i: number) => (
                  <label key={s.key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" disabled={!canEdit} checked={s.enabled} onChange={(e) => setCfg({ ...cfg, serviceTypes: cfg.serviceTypes.map((x: any, j: number) => (j === i ? { ...x, enabled: e.target.checked } : x)) })} />
                    {s.label}
                  </label>
                ))}
              </div>
            </Card>
            <Card kicker="Brief" title="Campos obligatorios">
              <p className="mb-3 text-sm text-ink-2">Crear una solicitud no exige nada del brief. Aquí se define qué hace falta para darlo por completo y para poder cotizar.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead><tr className="text-left text-xs text-ink-3"><th className="py-1">Campo</th><th>Para completar</th><th>Para cotizar</th></tr></thead>
                  <tbody>
                    {settings.data.briefFields.map((f: any) => (
                      <tr key={f.key} className="border-t border-line">
                        <td className="py-1">{f.label}</td>
                        {(['requiredToComplete', 'requiredToQuote'] as const).map((k) => (
                          <td key={k}><input aria-label={`${f.label} ${k}`} type="checkbox" disabled={!canEdit} checked={cfg.brief[k].includes(f.key)} onChange={(e) => setCfg({ ...cfg, brief: { ...cfg.brief, [k]: e.target.checked ? [...cfg.brief[k], f.key] : cfg.brief[k].filter((x: string) => x !== f.key) } })} /></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={cfg.brief.status === 'CONFIRMED'} onChange={(e) => setCfg({ ...cfg, brief: { ...cfg.brief, status: e.target.checked ? 'CONFIRMED' : 'PENDING' } })} /> LPulpo confirmó esta lista</label>
              <Field label="Opciones de duración (separadas por coma)"><Input disabled={!canEdit} value={cfg.durations.join(', ')} onChange={(e) => setCfg({ ...cfg, durations: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
            </Card>
          </>
        )}

        {tab === 'tareas' && (
          <Card kicker="Motor de Automation" title="Tareas que se crean al cambiar de estado">
            <p className="mb-3 text-sm text-ink-2">Configuración inicial de ejemplo: cada tarea creada dice qué regla la generó. Se crean una sola vez por producción; desactívalas si no aplican.</p>
            <div className="space-y-2">
              {Object.entries(cfg.taskRules).map(([k, r]: [string, any]) => (
                <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={r.enabled} onChange={(e) => setCfg({ ...cfg, taskRules: { ...cfg.taskRules, [k]: { ...r, enabled: e.target.checked } } })} /> {r.title}</label>
              ))}
            </div>
            <Field label="Reintentos máximos del motor"><Input type="number" min={1} max={10} disabled={!canEdit} value={cfg.engine.maxAttempts} onChange={(e) => setCfg({ ...cfg, engine: { maxAttempts: Number(e.target.value) } })} /></Field>
          </Card>
        )}

        {tab === 'equipo' && (
          <Card kicker="Usuarios y permisos" title="Perfiles en Producciones">
            <p className="mb-3 text-sm text-ink-2">Los administradores de la empresa tienen acceso total. Los usuarios de consulta solo leen, hasta que se les asigne otro perfil. Aprobar cotizaciones es un perfil aparte. Para crear usuarios ve a <Link className="underline" to="/app/team">Equipo</Link>.</p>
            {team.isLoading ? <Loading /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead><tr className="text-left text-xs text-ink-3"><th className="py-1">Usuario</th><th>Rol</th><th>Perfil en Producciones</th><th>Puede</th></tr></thead>
                  <tbody>
                    {team.data?.users.map((u) => (
                      <tr key={u.id} className="border-t border-line align-top">
                        <td className="py-2">{u.name}{u.email && <span className="block text-xs text-ink-3">{u.email}</span>}</td>
                        <td className="py-2 text-xs">{u.role === 'COMPANY_ADMIN' ? 'Administración' : u.role === 'COMPANY_VIEWER' ? 'Consulta' : u.role}</td>
                        <td className="py-2">
                          {u.role === 'COMPANY_VIEWER' && canEdit ? (
                            <Select aria-label={`Perfil de ${u.name}`} value={u.opsProfile ?? ''} onChange={(e) => setProfile.mutate({ id: u.id, profile: e.target.value || null })}>
                              <option value="">Consulta</option>
                              {team.data!.profiles.filter((p) => !['ADMIN', 'VIEWER'].includes(p.key)).map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                            </Select>
                          ) : <span>{team.data!.profiles.find((p) => p.key === u.effectiveProfile)?.label ?? 'Sin acceso'}</span>}
                        </td>
                        <td className="py-2 text-xs text-ink-2">{u.permissions.map((p) => team.data!.permissionLabels[p]).join(' · ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}

        {tab === 'integraciones' && (
          integrations.isLoading ? <Loading /> : (
            <div className="space-y-3">
              <p className="text-sm text-ink-2">Estado con evidencia, sin llamar a servicios externos. Ninguna se marca como conectada solo porque exista la pantalla.</p>
              {integrations.data?.items.map((it: any) => (
                <Card key={it.key} kicker={`Prioridad ${it.priority}`} title={it.name}>
                  <Badge tone={READINESS[it.readiness]?.tone ?? 'neutral'}>{READINESS[it.readiness]?.label ?? it.readiness}</Badge>
                  <ul className="mt-2 list-disc pl-5 text-sm">{it.evidence.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>
                  {it.missing.length > 0 && <><p className="mt-2 text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">Falta</p><ul className="list-disc pl-5 text-sm text-ink-2">{it.missing.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul></>}
                  <p className="mt-2 text-xs text-ink-3">{it.safety}</p>
                  {it.key === 'whatsapp' && integrations.data.canManage && (
                    <div className="mt-3">
                      <Button size="sm" variant="outline" onClick={async () => { try { setValidation(await prodApi.post(q, '/integrations/whatsapp/validate')); } catch (e) { toast.error(errorText(e)); } }}>Validar configuración (sin enviar nada)</Button>
                      {validation && (
                        <ul className="mt-2 text-sm">
                          {validation.checks.map((c: any) => <li key={c.check}><b className={c.ok ? 'text-ok' : 'text-bad'}>{c.ok ? 'Cumple' : 'Falta'}</b> · {c.check}</li>)}
                          <li className="mt-1 text-xs text-ink-3">{validation.note}</li>
                        </ul>
                      )}
                    </div>
                  )}
                  {it.key === 'whatsapp' && <p className="mt-2 text-xs"><Link className="underline" to="/app/integrations">Ir a Canales e integraciones</Link></p>}
                  {it.key === 'meta_ads' && <p className="mt-2 text-xs"><Link className="underline" to="/app/ads?tab=cuentas">Ir a cuentas publicitarias</Link></p>}
                </Card>
              ))}
            </div>
          )
        )}

        {tab === 'motor' && (
          <Card kicker="Ejecuciones reales" title="Motor de Automation">
            <p className="mb-3 text-sm text-ink-2">Cada ejecución queda guardada con sus intentos y errores. Solo hace acciones internas (crear tareas, marcar vencidas, liberar retenciones). Un barrido cada 5 minutos retoma lo pendiente.</p>
            {runs.isLoading ? <Loading /> : !runs.data?.length ? <p className="text-sm text-ink-3">Aún no hay ejecuciones.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr className="text-left text-xs text-ink-3"><th className="py-1">Cuándo</th><th>Acción</th><th>Estado</th><th>Intentos</th><th>Detalle</th></tr></thead>
                  <tbody>
                    {runs.data.map((r) => (
                      <tr key={r.id} className="border-t border-line">
                        <td className="py-1 text-xs">{fmtDate(r.createdAt, true)}</td>
                        <td className="text-xs">{r.kind}{r.payload?.status ? ` → ${r.payload.status}` : ''}</td>
                        <td><Badge tone={r.status === 'COMPLETED' ? 'ok' : r.status === 'FAILED' ? 'bad' : r.status === 'RETRYABLE' ? 'warn' : 'neutral'}>{r.status}</Badge></td>
                        <td>{r.attempts}/{r.maxAttempts}</td>
                        <td className="text-xs">{r.error ? `Error: ${r.error.message}${r.nextRetryAt ? ` · reintento ${fmtDate(r.nextRetryAt, true)}` : ''}` : r.result?.created?.length ? `Tareas: ${r.result.created.join(', ')}` : r.result?.skipped ? String(r.result.skipped) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
