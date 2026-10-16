import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { COMPANY_STATUS_LABELS, MODULE_LABELS, fmtDate, fmtUsd, planPriceLabel } from '../../lib/format';
import type { Company } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Select, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

function DeepinfraKeyForm({
  company,
  canWrite,
}: {
  company: Company;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: (value: string) =>
      api.patch(`/companies/${company.id}`, { deepinfraApiKey: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      setKey('');
      toast.success('Llave actualizada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <div className="space-y-3 text-sm">
      <p className="flex items-center justify-between">
        <span className="kicker">Estado</span>
        {company.hasDeepinfraKey ? (
          <Badge tone="ok">Conectada · {company.deepinfraKeyMasked}</Badge>
        ) : (
          <Badge tone="warn">Sin configurar</Badge>
        )}
      </p>
      {canWrite && (
        <>
          <Field
            label={company.hasDeepinfraKey ? 'Reemplazar llave' : 'API key de DeepInfra'}
            hint="Se obtiene en deepinfra.com → API Keys. Nunca se muestra completa."
          >
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="di_…"
            />
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1"
              disabled={!key.trim() || save.isPending}
              onClick={() => save.mutate(key.trim())}
            >
              {save.isPending ? 'Guardando…' : 'Guardar llave'}
            </Button>
            {company.hasDeepinfraKey && (
              <Button size="sm" variant="ghost" onClick={() => save.mutate('')}>
                Quitar
              </Button>
            )}
          </div>
        </>
      )}
      <p className="border-t border-line pt-2 text-xs text-ink-3">
        Con tu propia llave, el consumo de IA te lo factura DeepInfra directamente
        — aquí lo ves desglosado y en vivo en <strong>Consumo IA</strong>.
      </p>
    </div>
  );
}

function SavingsForm({
  company,
  canWrite,
}: {
  company: Company;
  canWrite: boolean;
}) {
  const queryClient = useQueryClient();
  const [salary, setSalary] = useState(String(company.savingsSalaryUsd));
  const [capacity, setCapacity] = useState(String(company.agentCapacityPerMonth));
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/companies/${company.id}`, {
        savingsSalaryUsd: Number(salary),
        agentCapacityPerMonth: Number(capacity),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['executive'] });
      toast.success('Parámetros guardados');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  return (
    <fieldset disabled={!canWrite} className="space-y-3 text-sm">
      <Field label="Sueldo mensual equivalente (USD)" hint="Lo que costaría una persona haciendo este trabajo">
        <Input type="number" min={0} value={salary} onChange={(e) => setSalary(e.target.value)} />
      </Field>
      <Field label="Conversaciones que atiende una persona al mes">
        <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      </Field>
      {canWrite && (
        <Button size="sm" className="w-full" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Guardando…' : 'Guardar parámetros'}
        </Button>
      )}
      <p className="border-t border-line pt-2 text-xs text-ink-3">
        Ahorro = respuestas de la IA en el mes ÷ capacidad de una persona × sueldo.
      </p>
    </fieldset>
  );
}

/** Reseñas en Google: tras una calificación de 4 o 5 se invita al cliente. */
function ReviewsCard({ company, canWrite }: { company: Company; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(company.googleReviewUrl ?? '');
  const [message, setMessage] = useState<string>((company.orderConfig as any)?.reviewMessage ?? '');
  const save = useMutation({
    mutationFn: () => api.patch(`/companies/${company.id}`, {
      googleReviewUrl: url.trim() || null,
      orderConfig: { ...(company.orderConfig ?? {}), reviewMessage: message.trim() || undefined },
    }),
    onSuccess: () => {
      toast.success('Reseñas guardadas');
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      queryClient.invalidateQueries({ queryKey: ['company', company.id] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Card kicker="Reputación" title="Reseñas en Google">
      <fieldset disabled={!canWrite} className="space-y-3">
        <p className="text-xs text-ink-3">Cuando un cliente califica 4 o 5 estrellas, el asistente le pide la reseña con este link. A quien califica bajo no se le pide: se alerta al equipo.</p>
        <Field label="Link para dejar reseña" hint="Google Business → Pedir reseñas → copiar link">
          <Input value={url} placeholder="https://g.page/r/…/review" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Mensaje" hint="Usa {{link}} donde va el enlace. Vacío = mensaje estándar">
          <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="¡Gracias por tu calificación! Nos ayudarías muchísimo con una reseña en Google: {{link}}" />
        </Field>
        {canWrite && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>}
      </fieldset>
    </Card>
  );
}

/** Factura electrónica DIAN (Alegra o modo simulado para demos). */
function EinvoiceCard({ company, canWrite, q }: { company: Company; canWrite: boolean; q: string }) {
  const queryClient = useQueryClient();
  const cfg = company.einvoiceConfig;
  const [form, setForm] = useState({
    provider: cfg?.provider ?? '', email: cfg?.email ?? '', token: '',
    taxRate: String(cfg?.taxRate ?? 0.08), alegraTaxId: cfg?.alegraTaxId ? String(cfg.alegraTaxId) : '', alegraItemId: cfg?.alegraItemId ? String(cfg.alegraItemId) : '',
  });
  const save = useMutation({
    mutationFn: () => api.patch(withScope('/einvoice/config', q), {
      provider: form.provider || null, email: form.email, token: form.token || undefined,
      taxRate: Number(form.taxRate), alegraTaxId: form.alegraTaxId || null, alegraItemId: form.alegraItemId || null,
    }),
    onSuccess: () => {
      toast.success('Facturación electrónica guardada');
      setForm((f) => ({ ...f, token: '' }));
      queryClient.invalidateQueries({ queryKey: ['companies'] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Card kicker="DIAN" title="Factura electrónica">
      <fieldset disabled={!canWrite} className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-ink-3">Emite la factura de cada pedido desde su detalle.</p>
          <Badge tone={cfg?.ready ? 'ok' : 'neutral'}>{cfg?.ready ? 'Lista' : 'Inactiva'}</Badge>
        </div>
        <Field label="Proveedor">
          <Select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            <option value="">Desactivada</option>
            <option value="ALEGRA">Alegra (proveedor tecnológico)</option>
            <option value="SIMULADO">Simulado (demos y pruebas)</option>
          </Select>
        </Field>
        {form.provider === 'ALEGRA' && (
          <>
            <Field label="Correo de la cuenta Alegra"><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Token de API" hint={cfg?.hasToken ? 'Guardado (cifrado). Escribe uno nuevo para reemplazarlo.' : 'Alegra → Configuración → Integraciones'}>
              <Input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="ID impuesto Alegra"><Input value={form.alegraTaxId} onChange={(e) => setForm({ ...form, alegraTaxId: e.target.value })} /></Field>
              <Field label="ID ítem genérico"><Input value={form.alegraItemId} onChange={(e) => setForm({ ...form, alegraItemId: e.target.value })} /></Field>
            </div>
          </>
        )}
        {form.provider && (
          <Field label="Impuesto incluido" hint="0,08 = impoconsumo restaurantes · 0,19 = IVA">
            <Input type="number" step={0.01} min={0} max={0.3} value={form.taxRate} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
          </Field>
        )}
        {canWrite && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Guardando…' : 'Guardar'}</Button>}
      </fieldset>
    </Card>
  );
}

export default function CompanySettings() {
  const { ready, companyId, canWrite, isPlatform, q } = useCompanyScope();
  const queryClient = useQueryClient();

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
    enabled: ready,
  });
  const company = isPlatform
    ? companies?.find((c) => c.id === companyId)
    : companies?.[0];

  const [form, setForm] = useState<any>(null);
  useEffect(() => {
    if (company && (!form || form.__id !== company.id)) {
      setForm({
        __id: company.id,
        name: company.name,
        website: company.website ?? '',
        contactEmail: company.contactEmail ?? '',
        contactPhone: company.contactPhone ?? '',
        timezone: company.timezone,
        brandColor: company.brandColor ?? '#1A1A1A',
      });
    }
  }, [company, form]);

  const save = useMutation({
    mutationFn: () => {
      const { __id, ...payload } = form;
      return api.patch(`/companies/${company!.id}`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['companies'] });
      toast.success('Configuración guardada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (!company || !form) return <Loading />;

  return (
    <>
      <PageHeader kicker="Tu cuenta" title="Configuración" />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
        <Card kicker="Editable" title="Datos de la empresa">
          <fieldset disabled={!canWrite} className="grid gap-4 md:grid-cols-2">
            <Field label="Nombre">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Sitio web">
              <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </Field>
            <Field label="Correo de contacto">
              <Input value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            </Field>
            <Field label="WhatsApp / teléfono">
              <Input value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
            <Field label="Zona horaria">
              <Input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
            </Field>
            <Field label="Color de marca">
              <div className="flex gap-2">
                <input
                  type="color" value={form.brandColor} aria-label="Color de marca"
                  onChange={(e) => setForm({ ...form, brandColor: e.target.value })}
                  className="h-10 w-14 cursor-pointer border-2 border-ink bg-bone p-1"
                />
                <Input value={form.brandColor} onChange={(e) => setForm({ ...form, brandColor: e.target.value })} />
              </div>
            </Field>
            {canWrite && (
              <div className="md:col-span-2 flex justify-end">
                <Button disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Guardando…' : 'Guardar cambios'}
                </Button>
              </div>
            )}
          </fieldset>
        </Card>
          <div className="grid gap-6 md:grid-cols-2">
            <ReviewsCard key={`r-${company.id}`} company={company} canWrite={canWrite} />
            <EinvoiceCard key={`e-${company.id}`} company={company} canWrite={canWrite} q={q} />
          </div>
        </div>

        <div className="space-y-4">
          <Card kicker="Suscripción" title={company.plan?.name ?? 'Sin plan'}>
            <div className="space-y-2 text-sm">
              <p className="flex items-center justify-between">
                <span className="kicker">Estado</span>
                <Badge tone={statusTone(company.status)}>
                  {COMPANY_STATUS_LABELS[company.status]}
                </Badge>
              </p>
              {company.plan && (
                <p className="flex items-center justify-between">
                  <span className="kicker">Tarifa fija</span>
                  <strong>
                    {planPriceLabel(company.plan, false)}{company.billingCycle === 'ANNUAL' ? ' · pago anual' : ''}
                  </strong>
                </p>
              )}
              {company.trialEndsAt && company.status === 'TRIAL' && (
                <p className="flex items-center justify-between">
                  <span className="kicker">Trial vence</span>
                  <strong>{fmtDate(company.trialEndsAt)}</strong>
                </p>
              )}
              <p className="border-t border-line pt-2 text-xs text-ink-3">
                Cambios de plan y límites se gestionan con el equipo BackOffice —
                escríbenos por WhatsApp y lo ajustamos el mismo día.
              </p>
            </div>
          </Card>

          {company.aiBillingMode === 'PLATFORM' ? (
            <Card kicker="Incluida en tu plan" title="Inteligencia artificial">
              <div className="space-y-2 text-sm">
                <p className="flex items-center justify-between">
                  <span className="kicker">Estado</span>
                  <Badge tone="ok">IA de BackOffice</Badge>
                </p>
                <p className="text-ink-2">
                  No necesitas cuentas ni llaves: tu asistente usa la IA de BackOffice. Tu plan trae
                  conversaciones incluidas cada mes; el detalle y el excedente los ves en <strong>Consumo IA</strong>.
                </p>
              </div>
            </Card>
          ) : company.aiBillingMode === 'HYBRID' ? (
            <Card kicker="Tu cuenta + IA de BackOffice" title="Inteligencia artificial">
              <p className="mb-3 text-sm text-ink-2">
                Usas tu propia cuenta de DeepInfra y además la IA de BackOffice
                {company.aiHybridPrimary === 'PLATFORM' ? ' (va primero; tu cuenta queda de respaldo)' : ' de respaldo'}.
                Si una no está disponible, la otra sigue respondiendo: tus clientes nunca quedan sin atención.
              </p>
              <DeepinfraKeyForm company={company} canWrite={canWrite} />
            </Card>
          ) : (
            <Card kicker="BYOK · el costo de IA lo pagas directo a DeepInfra" title="Llave DeepInfra">
              <DeepinfraKeyForm company={company} canWrite={canWrite} />
            </Card>
          )}

          <Card kicker="Cómo se calcula tu ahorro en Gerencia" title="Reporte a Gerencia">
            <SavingsForm company={company} canWrite={canWrite} />
          </Card>

          <Card kicker="Panel" title="Módulos activos">
            <div className="flex flex-wrap gap-1.5">
              {company.modules.map((module) => (
                <Badge key={module} tone="ok">{MODULE_LABELS[module] ?? module}</Badge>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
