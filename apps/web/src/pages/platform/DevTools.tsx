import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtNum, timeAgo } from '../../lib/format';
import type { ApiKeyRow, Company } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select,
  Stat, Table,
} from '../../components/ui';

interface Health {
  status: string;
  db: string;
  uptimeSeconds: number;
  node: string;
  env: string;
  counts: Record<string, number>;
}

export default function DevTools() {
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState<{ name: string; companyId: string } | null>(null);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const { data: health } = useQuery({
    queryKey: ['dev-health'],
    queryFn: () => api.get<Health>('/dev/health'),
    refetchInterval: 15_000,
  });
  const { data: apiKeys, isLoading } = useQuery({
    queryKey: ['apikeys'],
    queryFn: () => api.get<ApiKeyRow[]>('/dev/apikeys'),
  });
  const { data: settings } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => api.get<Record<string, string>>('/dev/settings'),
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });

  const createKey = useMutation({
    mutationFn: (form: { name: string; companyId: string }) =>
      api.post<ApiKeyRow>('/dev/apikeys', {
        name: form.name,
        companyId: form.companyId || undefined,
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

  const saveSettings = useMutation({
    mutationFn: (values: Record<string, string>) => api.put('/dev/settings', values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platform-settings'] });
      toast.success('Configuración guardada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const uptime = health
    ? `${Math.floor(health.uptimeSeconds / 3600)}h ${Math.floor((health.uptimeSeconds % 3600) / 60)}m`
    : '—';

  return (
    <>
      <PageHeader kicker="Panel técnico" title="Dev" accent="tools." />

      {/* Salud del sistema */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat
          label="Estado"
          value={health?.status === 'ok' ? 'OK' : '⚠'}
          tone={health?.status === 'ok' ? 'ok' : 'bad'}
          hint={health?.db}
        />
        <Stat label="Uptime" value={uptime} hint={`Node ${health?.node ?? ''}`} />
        <Stat label="Empresas" value={health?.counts.companies ?? '—'} />
        <Stat label="Usuarios" value={health?.counts.users ?? '—'} />
        <Stat label="Conversaciones" value={fmtNum(health?.counts.conversations ?? 0)} />
        <Stat label="Mensajes" value={fmtNum(health?.counts.messages ?? 0)} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* API keys */}
        <Card
          kicker="Acceso programático"
          title="API keys"
          actions={<Button size="sm" onClick={() => setNewKey({ name: '', companyId: '' })}>+ Nueva</Button>}
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

        {/* Configuración Meta */}
        <Card kicker="Ecosistema Meta" title="Credenciales de conexión">
          <p className="mb-4 text-sm text-ink-2">
            Cuando tengamos la app de Meta aprobada, estos valores alimentan los
            links de conexión de WhatsApp, Instagram, Messenger y Meta Ads de
            todas las empresas. Sin cuentas guardadas: solo el App ID y el
            redirect del OAuth.
          </p>
          {settings && (
            <SettingsForm
              settings={settings}
              onSave={(values) => saveSettings.mutate(values)}
              saving={saveSettings.isPending}
            />
          )}
        </Card>
      </div>

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
            <Button
              className="w-full"
              disabled={!newKey.name || createKey.isPending}
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
    PLATFORM_NAME: settings.PLATFORM_NAME ?? 'BackOffice',
    SUPPORT_WHATSAPP: settings.SUPPORT_WHATSAPP ?? '',
    DEEPINFRA_API_KEY: settings.DEEPINFRA_API_KEY ?? '',
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
      <Field label="Meta App ID" hint="De developers.facebook.com — pendiente de crear">
        <Input value={form.META_APP_ID} onChange={(e) => set({ META_APP_ID: e.target.value })} />
      </Field>
      <Field label="OAuth Redirect URI">
        <Input value={form.META_REDIRECT_URI} onChange={(e) => set({ META_REDIRECT_URI: e.target.value })} />
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
