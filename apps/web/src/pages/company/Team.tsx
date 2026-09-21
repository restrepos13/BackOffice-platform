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

export default function Team() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<MemberForm | null>(null);

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
        actions={canWrite ? <Button onClick={() => setEditing({ ...emptyForm })}>+ Invitar miembro</Button> : undefined}
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

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Equipo"
        title={editing?.id ? `Editar ${editing.name}` : 'Invitar miembro'}
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
              </Select>
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
