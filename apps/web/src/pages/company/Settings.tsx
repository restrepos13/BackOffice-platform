import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { COMPANY_STATUS_LABELS, MODULE_LABELS, fmtDate, fmtUsd } from '../../lib/format';
import type { Company } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, PageHeader, Textarea, statusTone,
} from '../../components/ui';
import { PickCompany, useCompanyScope } from './shared';

export default function CompanySettings() {
  const { ready, companyId, canWrite, isPlatform } = useCompanyScope();
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
                    {company.plan.isCustom ? 'A medida' : `${fmtUsd(company.plan.priceMonthly)}/mes`}
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
