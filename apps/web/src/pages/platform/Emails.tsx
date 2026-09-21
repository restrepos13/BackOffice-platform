import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import type { Company, EmailMessage } from '../../lib/types';
import {
  Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Select,
  Table, Textarea, statusTone,
} from '../../components/ui';

const EMAIL_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'En cola',
  SENT: 'Enviado',
  FAILED: 'Falló',
};

const TEMPLATES: { label: string; subject: string; body: string }[] = [
  {
    label: 'Bienvenida',
    subject: '¡Bienvenidos a BackOffice, {{empresa}}!',
    body: '<p>Hola equipo de <strong>{{empresa}}</strong>,</p><p>Su plataforma ya está activa con el plan <strong>{{plan}}</strong>. En el panel encuentran sus conversaciones, métricas y consumo en vivo.</p><p>Cualquier cosa nos escriben directo por WhatsApp — hablan con quienes construyen el producto.</p><p>— Santiago y Daniel, BackOffice</p>',
  },
  {
    label: 'Resumen mensual',
    subject: '{{empresa}} — resumen de tu operación del mes',
    body: '<p>Hola equipo de <strong>{{empresa}}</strong>,</p><p>Les compartimos el resumen del mes: [completar métricas].</p><p>Todo el detalle está en su panel, sección Analytics.</p><p>— Equipo BackOffice</p>',
  },
  {
    label: 'Factura pendiente',
    subject: '{{empresa}} — factura pendiente de pago',
    body: '<p>Hola equipo de <strong>{{empresa}}</strong>,</p><p>Les recordamos que tienen una factura pendiente. Pueden pagarla directo desde el panel, sección Facturación (botón <strong>Pagar con Wompi</strong>).</p><p>— Equipo BackOffice</p>',
  },
];

export default function Emails() {
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [composing, setComposing] = useState(false);
  const [form, setForm] = useState({
    companyId: params.get('companyId') ?? '',
    toEmail: '',
    subject: '',
    body: '',
  });
  const [preview, setPreview] = useState<EmailMessage | null>(null);

  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });
  const { data: emails, isLoading } = useQuery({
    queryKey: ['emails'],
    queryFn: () => api.get<EmailMessage[]>('/emails'),
  });

  const send = useMutation({
    mutationFn: () =>
      api.post<EmailMessage>('/emails', {
        companyId: form.companyId || undefined,
        toEmail: form.toEmail || undefined,
        subject: form.subject,
        body: form.body,
      }),
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      setComposing(false);
      setForm({ companyId: '', toEmail: '', subject: '', body: '' });
      if (message.status === 'SENT') toast.success(`Enviado a ${message.toEmail}`);
      else if (message.status === 'QUEUED')
        toast.warning('Quedó en cola: configura el SMTP en Dev Tools y reenvía.');
      else toast.error(`Falló: ${message.error}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const resend = useMutation({
    mutationFn: (id: string) => api.post<EmailMessage>('/emails/resend', { id }),
    onSuccess: (message) => {
      queryClient.invalidateQueries({ queryKey: ['emails'] });
      if (message.status === 'SENT') toast.success('Reenviado');
      else toast.warning(message.error ?? 'Sigue en cola');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const selectedCompany = companies?.find((c) => c.id === form.companyId);

  return (
    <>
      <PageHeader
        kicker="Comunicación con clientes"
        title="Correos"
        actions={<Button onClick={() => setComposing(true)}>+ Redactar correo</Button>}
      />

      <p className="mb-6 max-w-2xl text-sm text-ink-2">
        Correos personalizados del equipo BackOffice a las empresas. Usa las
        variables <code className="border border-line bg-bone px-1 font-mono text-xs">{'{{empresa}}'}</code>,{' '}
        <code className="border border-line bg-bone px-1 font-mono text-xs">{'{{plan}}'}</code> y{' '}
        <code className="border border-line bg-bone px-1 font-mono text-xs">{'{{contacto}}'}</code> — se
        reemplazan solas. El SMTP se configura en Dev Tools; mientras tanto los
        correos quedan en cola.
      </p>

      {isLoading ? (
        <Loading />
      ) : (
        <Table head={['Fecha', 'Para', 'Asunto', 'Enviado por', 'Estado', '']}>
          {emails?.map((message) => (
            <tr key={message.id} className="cursor-pointer hover:bg-bone-2" onClick={() => setPreview(message)}>
              <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-3">
                {fmtDateTime(message.createdAt)}
              </td>
              <td className="px-4 py-3">
                <p className="text-sm font-semibold">{message.company?.name ?? '—'}</p>
                <p className="text-xs text-ink-3">{message.toEmail}</p>
              </td>
              <td className="max-w-[300px] truncate px-4 py-3 text-sm">{message.subject}</td>
              <td className="px-4 py-3 text-sm">{message.actorName}</td>
              <td className="px-4 py-3">
                <Badge tone={statusTone(message.status)}>
                  {EMAIL_STATUS_LABELS[message.status]}
                </Badge>
              </td>
              <td className="px-4 py-3 text-right">
                {message.status !== 'SENT' && (
                  <Button
                    size="sm" variant="outline"
                    disabled={resend.isPending}
                    onClick={(e) => { e.stopPropagation(); resend.mutate(message.id); }}
                  >
                    Reenviar
                  </Button>
                )}
              </td>
            </tr>
          ))}
          {emails?.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-ink-3">Sin correos todavía.</td></tr>
          )}
        </Table>
      )}

      {/* Redactar */}
      <Modal open={composing} onClose={() => setComposing(false)} kicker="Correos" title="Redactar correo" wide>
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Empresa" hint="Activa las variables {{empresa}}, {{plan}}, {{contacto}}">
              <Select
                value={form.companyId}
                onChange={(e) => setForm({ ...form, companyId: e.target.value })}
              >
                <option value="">Sin empresa (correo libre)</option>
                {companies?.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field
              label="Destinatario"
              hint={
                selectedCompany?.contactEmail
                  ? `Vacío = contacto de la empresa (${selectedCompany.contactEmail})`
                  : 'Correo del destinatario'
              }
            >
              <Input
                type="email"
                value={form.toEmail}
                onChange={(e) => setForm({ ...form, toEmail: e.target.value })}
                placeholder={selectedCompany?.contactEmail ?? 'correo@empresa.com'}
              />
            </Field>
          </div>

          <div>
            <p className="kicker mb-2">Plantillas rápidas</p>
            <div className="flex flex-wrap gap-2">
              {TEMPLATES.map((template) => (
                <Button
                  key={template.label} size="sm" variant="outline"
                  onClick={() =>
                    setForm({ ...form, subject: template.subject, body: template.body })
                  }
                >
                  {template.label}
                </Button>
              ))}
            </div>
          </div>

          <Field label="Asunto" required>
            <Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Cuerpo (HTML)" required>
            <Textarea rows={8} className="font-mono text-xs" value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </Field>

          <Button
            className="w-full"
            disabled={!form.subject || !form.body || (!form.companyId && !form.toEmail) || send.isPending}
            onClick={() => send.mutate()}
          >
            {send.isPending ? 'Enviando…' : 'Enviar correo'}
          </Button>
        </div>
      </Modal>

      {/* Vista previa */}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        kicker={preview ? `→ ${preview.toEmail}` : ''}
        title={preview?.subject ?? ''}
        wide
      >
        {preview && (
          <div className="space-y-3">
            {preview.error && (
              <p className="border-2 border-warn bg-warn-soft px-3 py-2 text-xs text-warn">
                {preview.error}
              </p>
            )}
            <div
              className="border-2 border-line bg-white p-5 text-sm"
              dangerouslySetInnerHTML={{ __html: preview.body }}
            />
            <p className="kicker">
              {preview.actorName} · {fmtDateTime(preview.createdAt)}
              {preview.sentAt ? ` · entregado ${fmtDateTime(preview.sentAt)}` : ''}
            </p>
          </div>
        )}
      </Modal>
    </>
  );
}
