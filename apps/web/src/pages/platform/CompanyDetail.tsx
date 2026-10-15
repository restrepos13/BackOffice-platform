import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useActiveCompanyId } from '../../lib/auth';
import {
  BOT_STATUS_LABELS, COMPANY_STATUS_LABELS, INTEGRATION_STATUS_LABELS,
  MODULE_LABELS, ROLE_LABELS, fmtDate, fmtUsd, timeAgo,
} from '../../lib/format';
import type { AuditEntry, Company, Plan } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select,
  Switch, Table, Tabs, Textarea, statusTone,
} from '../../components/ui';

const ALL_MODULES = Object.keys(MODULE_LABELS);

export default function CompanyDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setCompanyId } = useActiveCompanyId();
  const [tab, setTab] = useState('resumen');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: company, isLoading } = useQuery({
    queryKey: ['company', id],
    queryFn: () => api.get<Company>(`/companies/${id}`),
  });
  const { data: plans } = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<Plan[]>('/plans'),
  });
  const { data: audit } = useQuery({
    queryKey: ['audit', id],
    queryFn: () => api.get<AuditEntry[]>(`/audit?companyId=${id}&take=40`),
    enabled: tab === 'auditoria',
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.patch<Company>(`/companies/${id}`, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['company', id] });
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa actualizada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/companies/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Empresa eliminada');
      navigate('/platform/companies');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !company) return <Loading label="Cargando empresa…" />;

  return (
    <>
      <PageHeader
        kicker={`Empresa · ${company.slug}`}
        title={company.name}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setCompanyId(company.id);
                navigate('/app');
              }}
            >
              Entrar al panel →
            </Button>
            {company.status !== 'SUSPENDED' ? (
              <Button
                variant="danger"
                onClick={() => update.mutate({ status: 'SUSPENDED' })}
              >
                Suspender
              </Button>
            ) : (
              <Button onClick={() => update.mutate({ status: 'ACTIVE' })}>
                Reactivar
              </Button>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Badge tone={statusTone(company.status)}>
          {COMPANY_STATUS_LABELS[company.status]}
        </Badge>
        {company.plan && (
          <Badge tone="ink">
            {company.plan.name} · {company.plan.isCustom ? 'a medida' : `${fmtUsd(company.plan.priceMonthly)}/mes`}
          </Badge>
        )}
        {company.trialEndsAt && company.status === 'TRIAL' && (
          <span className="text-xs text-ink-3">
            Trial vence: {fmtDate(company.trialEndsAt)}
          </span>
        )}
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'resumen', label: 'Resumen' },
          { id: 'config', label: 'Configuración' },
          { id: 'plan', label: 'Plan y módulos' },
          { id: 'usuarios', label: 'Usuarios', badge: company.users?.length },
          { id: 'bots', label: 'Bots', badge: company.bots?.length },
          { id: 'integraciones', label: 'Integraciones', badge: company.integrations?.length },
          { id: 'auditoria', label: 'Auditoría' },
          { id: 'peligro', label: 'Zona de riesgo' },
        ]}
      />

      <div className="mt-6">
        {tab === 'resumen' && (
          <div className="grid gap-6 lg:grid-cols-3">
            <Card kicker="Ficha" title="Datos" className="lg:col-span-1">
              <dl className="space-y-2 text-sm">
                <InfoRow k="Razón social" v={company.legalName} />
                <InfoRow k="Industria" v={company.industry} />
                <InfoRow k="Ubicación" v={[company.city, company.country].filter(Boolean).join(', ')} />
                <InfoRow k="Web" v={company.website} />
                <InfoRow k="Contacto" v={company.contactEmail} />
                <InfoRow k="Teléfono" v={company.contactPhone} />
                <InfoRow k="Zona horaria" v={company.timezone} />
                <InfoRow k="Alta" v={fmtDate(company.createdAt)} />
              </dl>
            </Card>
            <Card kicker="Actividad" title="Números" className="lg:col-span-2">
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MiniStat label="Usuarios" value={company.users?.length ?? 0} />
                <MiniStat label="Bots" value={company.bots?.length ?? 0} />
                <MiniStat label="Conversaciones" value={company._count?.conversations ?? 0} />
                <MiniStat label="Contactos" value={company._count?.contacts ?? 0} />
              </div>
              {company.notes && (
                <div className="mt-4 border-2 border-dashed border-line bg-bone p-3">
                  <p className="kicker mb-1">Notas internas</p>
                  <p className="text-sm text-ink-2">{company.notes}</p>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === 'config' && (
          <Card kicker="Editable" title="Configuración general">
            <ConfigForm company={company} onSave={(patch) => update.mutate(patch)} saving={update.isPending} />
          </Card>
        )}

        {tab === 'plan' && (
          <div className="grid gap-6 lg:grid-cols-2">
            <Card kicker="Suscripción" title="Plan">
              <Field label="Plan asignado">
                <Select
                  value={company.planId ?? ''}
                  onChange={(e) => update.mutate({ planId: e.target.value || null })}
                >
                  <option value="">Sin plan</option>
                  {plans?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.isCustom ? 'a medida' : `${fmtUsd(p.priceMonthly)}/mes`}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <Field label="Override máx. bots" hint="Vacío = plan">
                  <Input
                    type="number"
                    defaultValue={company.limits.maxBots ?? ''}
                    onBlur={(e) =>
                      update.mutate({
                        limits: {
                          ...company.limits,
                          ...(e.target.value ? { maxBots: Number(e.target.value) } : {}),
                        },
                      })
                    }
                  />
                </Field>
                <Field label="Override máx. usuarios" hint="Vacío = plan">
                  <Input
                    type="number"
                    defaultValue={company.limits.maxUsers ?? ''}
                    onBlur={(e) =>
                      update.mutate({
                        limits: {
                          ...company.limits,
                          ...(e.target.value ? { maxUsers: Number(e.target.value) } : {}),
                        },
                      })
                    }
                  />
                </Field>
              </div>
            </Card>
            <Card kicker="Quién paga la IA" title="Inteligencia artificial">
              <div className="space-y-4">
                <Field
                  label="Modo"
                  hint={company.aiBillingMode === 'PLATFORM'
                    ? 'La IA usa la llave de BackOffice y se cobra por conversación (incluidas del plan + excedente).'
                    : 'La empresa usa su propia llave de DeepInfra y paga la IA directo al proveedor.'}
                >
                  <Select
                    value={company.aiBillingMode ?? 'BYOK'}
                    onChange={(e) => update.mutate({ aiBillingMode: e.target.value })}
                  >
                    <option value="BYOK">Llave propia del cliente (BYOK)</option>
                    <option value="PLATFORM">IA de BackOffice (revendida)</option>
                  </Select>
                </Field>
                {company.aiBillingMode === 'PLATFORM' && (
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="Tope de gasto mensual (USD)" hint="Costo real; al llegar, la IA pasa a humano. Vacío = sin tope">
                      <Input
                        type="number" min={0} step={1}
                        defaultValue={company.aiSpendCapUsd ?? ''}
                        onBlur={(e) => update.mutate({ aiSpendCapUsd: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="Conversaciones incluidas" hint="Vacío = las del plan">
                      <Input
                        type="number" min={0} step={50}
                        defaultValue={company.aiIncludedOverride ?? ''}
                        onBlur={(e) => update.mutate({ aiIncludedOverride: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </Field>
                  </div>
                )}
                {company.aiBillingMode !== 'PLATFORM' && (
                  <p className="flex items-center justify-between text-sm">
                    <span className="kicker">Llave del cliente</span>
                    {company.hasDeepinfraKey
                      ? <Badge tone="ok">Conectada · {company.deepinfraKeyMasked}</Badge>
                      : <Badge tone="warn">Sin configurar</Badge>}
                  </p>
                )}
              </div>
            </Card>
            <Card kicker="Panel del cliente" title="Módulos habilitados">
              <div className="space-y-2">
                {ALL_MODULES.map((module) => (
                  <div key={module} className="flex items-center justify-between border-b border-line pb-2">
                    <p className="text-sm font-medium">{MODULE_LABELS[module]}</p>
                    <Switch
                      checked={company.modules.includes(module)}
                      onChange={(on) =>
                        update.mutate({
                          modules: on
                            ? [...company.modules, module]
                            : company.modules.filter((m) => m !== module),
                        })
                      }
                      label={MODULE_LABELS[module]}
                    />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        )}

        {tab === 'usuarios' && (
          <Table head={['Usuario', 'Rol', 'Cargo', 'Estado', 'Último acceso']}>
            {company.users?.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold">{u.name}</p>
                  <p className="text-xs text-ink-3">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={u.role === 'COMPANY_ADMIN' ? 'ink' : 'neutral'}>
                    {ROLE_LABELS[u.role]}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm">{u.jobTitle ?? '—'}</td>
                <td className="px-4 py-3">
                  <Badge tone={u.active ? 'ok' : 'bad'}>{u.active ? 'Activo' : 'Inactivo'}</Badge>
                </td>
                <td className="px-4 py-3 text-xs text-ink-3">
                  {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Nunca'}
                </td>
              </tr>
            ))}
          </Table>
        )}

        {tab === 'bots' && (
          <Table head={['Bot', 'Modelo', 'Estado', 'Conversaciones']}>
            {company.bots?.map((b: any) => (
              <tr key={b.id}>
                <td className="px-4 py-3">
                  <p className="font-semibold">{b.name}</p>
                  <p className="text-xs text-ink-3">{b.description ?? '—'}</p>
                </td>
                <td className="px-4 py-3 font-mono text-xs">{b.model}</td>
                <td className="px-4 py-3">
                  <Badge tone={statusTone(b.status)}>{BOT_STATUS_LABELS[b.status]}</Badge>
                </td>
                <td className="px-4 py-3 tabular-nums">{b._count?.conversations ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}

        {tab === 'integraciones' && (
          <Table head={['Canal', 'Estado', 'Bot', 'Última sync', 'Webhook']}>
            {company.integrations?.map((i: any) => (
              <tr key={i.id}>
                <td className="px-4 py-3 font-semibold">{i.name}</td>
                <td className="px-4 py-3">
                  <Badge tone={statusTone(i.status)}>
                    {INTEGRATION_STATUS_LABELS[i.status]}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm">{i.bot?.name ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-ink-3">
                  {i.lastSyncAt ? timeAgo(i.lastSyncAt) : '—'}
                </td>
                <td className="max-w-[280px] truncate px-4 py-3 font-mono text-[11px] text-ink-3">
                  {i.webhookUrl ?? '—'}
                </td>
              </tr>
            ))}
          </Table>
        )}

        {tab === 'auditoria' && (
          <Table head={['Acción', 'Detalle', 'Actor', 'Fecha']}>
            {audit?.map((entry) => (
              <tr key={entry.id}>
                <td className="px-4 py-3 font-mono text-xs">{entry.action}</td>
                <td className="px-4 py-3 text-sm">{entry.detail ?? '—'}</td>
                <td className="px-4 py-3 text-sm">{entry.actorName}</td>
                <td className="px-4 py-3 text-xs text-ink-3">{timeAgo(entry.createdAt)}</td>
              </tr>
            ))}
            {audit?.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-3">Sin registros.</td></tr>
            )}
          </Table>
        )}

        {tab === 'peligro' && (
          <Card kicker="Irreversible" title="Zona de riesgo" className="border-bad">
            <p className="mb-4 text-sm text-ink-2">
              Eliminar la empresa borra usuarios, bots, conversaciones, contactos y
              todo su historial. No hay vuelta atrás.
            </p>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Eliminar {company.name}
            </Button>
          </Card>
        )}
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        kicker="Confirmación"
        title={`¿Eliminar ${company.name}?`}
      >
        <p className="mb-4 text-sm">
          Se borrará <strong>todo</strong> el tenant. Escribe el slug{' '}
          <code className="border border-line bg-bone px-1 font-mono">{company.slug}</code>{' '}
          para confirmar.
        </p>
        <DeleteConfirm slug={company.slug} onConfirm={() => remove.mutate()} busy={remove.isPending} />
      </Modal>
    </>
  );
}

function DeleteConfirm({ slug, onConfirm, busy }: { slug: string; onConfirm: () => void; busy: boolean }) {
  const [value, setValue] = useState('');
  return (
    <div className="space-y-3">
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={slug} />
      <Button variant="danger" disabled={value !== slug || busy} onClick={onConfirm} className="w-full">
        {busy ? 'Eliminando…' : 'Eliminar definitivamente'}
      </Button>
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v?: string | null }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-1.5">
      <dt className="kicker">{k}</dt>
      <dd className="text-right">{v || '—'}</dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-2 border-line bg-bone px-3 py-2">
      <p className="kicker">{label}</p>
      <p className="display text-2xl">{value}</p>
    </div>
  );
}

function ConfigForm({
  company,
  onSave,
  saving,
}: {
  company: Company;
  onSave: (patch: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    name: company.name,
    legalName: company.legalName ?? '',
    industry: company.industry ?? '',
    country: company.country ?? '',
    city: company.city ?? '',
    website: company.website ?? '',
    contactEmail: company.contactEmail ?? '',
    contactPhone: company.contactPhone ?? '',
    timezone: company.timezone,
    brandColor: company.brandColor ?? '#1A1A1A',
    notes: company.notes ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Nombre"><Input value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
      <Field label="Razón social"><Input value={form.legalName} onChange={(e) => set({ legalName: e.target.value })} /></Field>
      <Field label="Industria"><Input value={form.industry} onChange={(e) => set({ industry: e.target.value })} /></Field>
      <Field label="País"><Input value={form.country} onChange={(e) => set({ country: e.target.value })} /></Field>
      <Field label="Ciudad"><Input value={form.city} onChange={(e) => set({ city: e.target.value })} /></Field>
      <Field label="Sitio web"><Input value={form.website} onChange={(e) => set({ website: e.target.value })} /></Field>
      <Field label="Correo de contacto"><Input value={form.contactEmail} onChange={(e) => set({ contactEmail: e.target.value })} /></Field>
      <Field label="Teléfono"><Input value={form.contactPhone} onChange={(e) => set({ contactPhone: e.target.value })} /></Field>
      <Field label="Zona horaria"><Input value={form.timezone} onChange={(e) => set({ timezone: e.target.value })} /></Field>
      <Field label="Color de marca">
        <div className="flex gap-2">
          <input
            type="color" value={form.brandColor} aria-label="Color de marca"
            onChange={(e) => set({ brandColor: e.target.value })}
            className="h-10 w-14 cursor-pointer border-2 border-ink bg-bone p-1"
          />
          <Input value={form.brandColor} onChange={(e) => set({ brandColor: e.target.value })} />
        </div>
      </Field>
      <div className="md:col-span-2">
        <Field label="Notas internas"><Textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
      </div>
      <div className="md:col-span-2 flex justify-end">
        <Button disabled={saving} onClick={() => onSave(form)}>
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </Button>
      </div>
    </div>
  );
}
