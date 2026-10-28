import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ROLE_LABELS, timeAgo } from '../../lib/format';
import type { UserRow } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Table,
} from '../../components/ui';
import { PickCompany, useCompanyScope, withScope } from './shared';

interface MemberForm {
  id?: string;
  name: string;
  email: string;
  role: string;
  jobTitle: string;
  password: string;
}

const emptyForm: MemberForm = {
  name: '', email: '', role: 'COMPANY_VIEWER', jobTitle: '', password: '',
};

interface Invitation {
  id: string; email: string; name: string | null; role: string; opsProfile: string | null; invitedByName: string | null;
  createdAt: string; expiresAt: string; status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
}
const INVITE_STATUS: Record<Invitation['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
  PENDING: { label: 'Pendiente', tone: 'warn' }, ACCEPTED: { label: 'Aceptada', tone: 'ok' },
  REVOKED: { label: 'Revocada', tone: 'neutral' }, EXPIRED: { label: 'Vencida', tone: 'bad' },
};

export default function Team() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<MemberForm | null>(null);
  const [inviting, setInviting] = useState<{ email: string; name: string; role: string } | null>(null);
  const [inviteLink, setInviteLink] = useState<{ link: string; emailStatus: string; email: string } | null>(null);

  const invitations = useQuery({
    queryKey: ['invitations', q],
    queryFn: () => api.get<Invitation[]>(withScope('/users/invitations', q)),
    enabled: ready && canWrite,
  });
  const invite = useMutation({
    mutationFn: (f: { email: string; name: string; role: string }) =>
      api.post<{ link: string; emailStatus: string; invitation: Invitation }>('/users/invitations', {
        email: f.email.trim(), name: f.name.trim() || undefined, role: f.role, ...(companyId ? { companyId } : {}),
      }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      setInviteLink({ link: r.link, emailStatus: r.emailStatus, email: r.invitation.email });
      setInviting(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(withScope(`/users/invitations/${id}`, q)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations'] });
      toast.success('Invitación revocada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const { data: users, isLoading } = useQuery({
    queryKey: ['team', q],
    queryFn: () => api.get<UserRow[]>(withScope('/users', q)),
    enabled: ready,
  });

  const save = useMutation({
    mutationFn: (form: MemberForm) =>
      form.id
        ? api.patch(`/users/${form.id}`, {
            name: form.name, role: form.role,
            jobTitle: form.jobTitle || undefined,
            ...(form.password ? { password: form.password } : {}),
          })
        : api.post('/users', {
            name: form.name, email: form.email, role: form.role,
            jobTitle: form.jobTitle || undefined, password: form.password,
            ...(companyId ? { companyId } : {}),
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team'] });
      toast.success('Miembro guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/users/${u.id}`, { active: !u.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['team'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="Roles y accesos"
        title="Equipo"
        actions={canWrite ? (
          <>
            <Button variant="outline" onClick={() => setEditing({ ...emptyForm })}>Crear con contraseña</Button>
            <Button onClick={() => setInviting({ email: '', name: '', role: 'COMPANY_VIEWER' })}>+ Invitar por correo</Button>
          </>
        ) : undefined}
      />

      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <div className="border-2 border-line bg-paper px-4 py-3">
          <Badge tone="ink">Admin de empresa</Badge>
          <p className="mt-2 text-xs text-ink-2">
            Control total del panel: bots, integraciones, equipo, configuración y facturación.
          </p>
        </div>
        <div className="border-2 border-line bg-paper px-4 py-3">
          <Badge tone="neutral">Visualización</Badge>
          <p className="mt-2 text-xs text-ink-2">
            Solo lectura: ve métricas, conversaciones y contactos, sin poder cambiar nada.
          </p>
        </div>
      </div>

      <Table head={['Miembro', 'Rol', 'Cargo', 'Estado', 'Último acceso', canWrite ? '' : ' ']}>
        {users?.map((u) => (
          <tr key={u.id}>
            <td className="px-4 py-3">
              <p className="font-semibold">{u.name}{u.id === me?.id ? ' (tú)' : ''}</p>
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
            <td className="px-4 py-3 text-right">
              {canWrite && (
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm" variant="ghost"
                    onClick={() =>
                      setEditing({
                        id: u.id, name: u.name, email: u.email, role: u.role,
                        jobTitle: u.jobTitle ?? '', password: '',
                      })
                    }
                  >
                    Editar
                  </Button>
                  {u.id !== me?.id && (
                    <Button size="sm" variant="ghost" onClick={() => toggleActive.mutate(u)}>
                      {u.active ? 'Desactivar' : 'Activar'}
                    </Button>
                  )}
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>

      {canWrite && (invitations.data?.length ?? 0) > 0 && (
        <div className="mt-8">
          <p className="kicker mb-2">Invitaciones</p>
          <Table head={['Correo', 'Rol', 'Estado', 'Invitó', 'Vence', '']}>
            {invitations.data!.map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-3 text-sm">{i.email}{i.name ? <span className="block text-xs text-ink-3">{i.name}</span> : null}</td>
                <td className="px-4 py-3 text-sm">{ROLE_LABELS[i.role] ?? i.role}</td>
                <td className="px-4 py-3"><Badge tone={INVITE_STATUS[i.status].tone}>{INVITE_STATUS[i.status].label}</Badge></td>
                <td className="px-4 py-3 text-xs text-ink-3">{i.invitedByName ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-ink-3">{i.status === 'PENDING' ? new Date(i.expiresAt).toLocaleDateString('es-CO') : '—'}</td>
                <td className="px-4 py-3 text-right">
                  {i.status === 'PENDING' && <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(i.id)}>Revocar</Button>}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      <Modal open={!!inviting} onClose={() => setInviting(null)} kicker="Equipo" title="Invitar por correo">
        {inviting && (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">La persona recibe un enlace para crear su propia contraseña. Vence en 7 días y sirve una sola vez.</p>
            <Field label="Correo" required>
              <Input type="email" value={inviting.email} onChange={(e) => setInviting({ ...inviting, email: e.target.value })} />
            </Field>
            <Field label="Nombre (opcional)">
              <Input value={inviting.name} onChange={(e) => setInviting({ ...inviting, name: e.target.value })} />
            </Field>
            <Field label="Rol">
              <Select value={inviting.role} onChange={(e) => setInviting({ ...inviting, role: e.target.value })}>
                <option value="COMPANY_ADMIN">Admin de empresa</option>
                <option value="COMPANY_VIEWER">Visualización</option>
                <option value="COMPANY_COURIER">Domiciliario</option>
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setInviting(null)}>Cancelar</Button>
              <Button disabled={invite.isPending || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(inviting.email.trim())} onClick={() => invite.mutate(inviting)}>
                {invite.isPending ? 'Invitando…' : 'Enviar invitación'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={!!inviteLink} onClose={() => setInviteLink(null)} kicker="Invitación creada" title={inviteLink ? `Invitación para ${inviteLink.email}` : ''}>
        {inviteLink && (
          <div className="space-y-3">
            <p className="text-sm">
              {inviteLink.emailStatus === 'SENT'
                ? 'Le enviamos el enlace por correo.'
                : 'El correo de la plataforma no está configurado o falló: comparte tú este enlace con la persona (por WhatsApp, por ejemplo).'}
            </p>
            <p className="break-all border-2 border-line bg-bone p-2 font-mono text-xs">{inviteLink.link}</p>
            <p className="text-xs text-ink-3">Por seguridad este enlace se muestra solo ahora: no queda guardado en BackOffice.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(inviteLink.link).then(() => toast.success('Enlace copiado'), () => toast.error('No se pudo copiar')); }}>Copiar enlace</Button>
              <Button onClick={() => setInviteLink(null)}>Listo</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Equipo"
        title={editing?.id ? `Editar ${editing.name}` : 'Crear miembro con contraseña'}
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Nombre" required>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Correo" required>
              <Input type="email" value={editing.email} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Rol">
              <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option value="COMPANY_ADMIN">Admin de empresa</option>
                <option value="COMPANY_VIEWER">Visualización</option>
                <option value="COMPANY_COURIER">Domiciliario</option>
              </Select>
              {editing.role === 'COMPANY_COURIER' && (
                <span className="mt-1 block text-xs text-ink-3">
                  Entra desde el celular a esta misma dirección: ve solo su ruta, comparte su ubicación en turno y marca recogido / entregado.
                </span>
              )}
            </Field>
            <Field label="Cargo">
              <Input value={editing.jobTitle} onChange={(e) => setEditing({ ...editing, jobTitle: e.target.value })} />
            </Field>
            <Field
              label={editing.id ? 'Nueva contraseña (opcional)' : 'Contraseña temporal'}
              hint="Mínimo 8 caracteres" required={!editing.id}
            >
              <Input type="text" value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button
                disabled={save.isPending || !editing.name || (!editing.id && (!editing.email || editing.password.length < 8))}
                onClick={() => save.mutate(editing)}
              >
                {save.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
