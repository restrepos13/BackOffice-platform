import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ROLE_LABELS, timeAgo } from '../../lib/format';
import type { Company, UserRow } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Table,
} from '../../components/ui';

interface UserForm {
  id?: string;
  name: string;
  email: string;
  role: string;
  companyId: string;
  password: string;
  jobTitle: string;
}

const emptyForm: UserForm = {
  name: '', email: '', role: 'COMPANY_ADMIN', companyId: '', password: '', jobTitle: '',
};

export default function PlatformUsers() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [editing, setEditing] = useState<UserForm | null>(null);
  const [filter, setFilter] = useState('');

  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserRow[]>('/users'),
  });
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.get<Company[]>('/companies'),
  });

  const save = useMutation({
    mutationFn: (form: UserForm) => {
      const isPlatformRole = form.role === 'SUPER_ADMIN' || form.role === 'DEV';
      if (form.id) {
        return api.patch(`/users/${form.id}`, {
          name: form.name,
          role: form.role,
          jobTitle: form.jobTitle || undefined,
          ...(form.password ? { password: form.password } : {}),
        });
      }
      return api.post('/users', {
        name: form.name, email: form.email, role: form.role,
        password: form.password, jobTitle: form.jobTitle || undefined,
        companyId: isPlatformRole ? undefined : form.companyId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Usuario guardado');
      setEditing(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/users/${u.id}`, { active: !u.active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const filtered = (users ?? []).filter(
    (u) =>
      !filter ||
      u.name.toLowerCase().includes(filter.toLowerCase()) ||
      u.email.toLowerCase().includes(filter.toLowerCase()) ||
      (u.company?.name ?? '').toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <>
      <PageHeader
        kicker="Plataforma"
        title="Usuarios"
        actions={<Button onClick={() => setEditing({ ...emptyForm })}>+ Nuevo usuario</Button>}
      />

      <div className="mb-4">
        <Input
          placeholder="Buscar por nombre, correo o empresa…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {isLoading ? (
        <Loading />
      ) : (
        <Table head={['Usuario', 'Rol', 'Empresa', 'Estado', 'Último acceso', '']}>
          {filtered.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-3">
                <p className="font-semibold">{u.name}</p>
                <p className="text-xs text-ink-3">{u.email}</p>
              </td>
              <td className="px-4 py-3">
                <Badge tone={u.role === 'SUPER_ADMIN' ? 'ink' : u.role === 'DEV' ? 'info' : 'neutral'}>
                  {ROLE_LABELS[u.role]}
                </Badge>
              </td>
              <td className="px-4 py-3 text-sm">{u.company?.name ?? '— Plataforma'}</td>
              <td className="px-4 py-3">
                <Badge tone={u.active ? 'ok' : 'bad'}>{u.active ? 'Activo' : 'Inactivo'}</Badge>
              </td>
              <td className="px-4 py-3 text-xs text-ink-3">
                {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Nunca'}
              </td>
              <td className="px-4 py-3">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm" variant="outline"
                    onClick={() =>
                      setEditing({
                        id: u.id, name: u.name, email: u.email, role: u.role,
                        companyId: u.companyId ?? '', password: '', jobTitle: u.jobTitle ?? '',
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
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker="Usuarios"
        title={editing?.id ? `Editar ${editing.name}` : 'Nuevo usuario'}
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
            <Field label="Rol" required>
              <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </Select>
            </Field>
            {(editing.role === 'COMPANY_ADMIN' || editing.role === 'COMPANY_VIEWER') && !editing.id && (
              <Field label="Empresa" required>
                <Select value={editing.companyId}
                  onChange={(e) => setEditing({ ...editing, companyId: e.target.value })}>
                  <option value="">Elegir empresa…</option>
                  {companies?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="Cargo">
              <Input value={editing.jobTitle} onChange={(e) => setEditing({ ...editing, jobTitle: e.target.value })} />
            </Field>
            <Field
              label={editing.id ? 'Nueva contraseña (opcional)' : 'Contraseña'}
              hint="Mínimo 8 caracteres" required={!editing.id}
            >
              <Input type="text" value={editing.password}
                onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button
                disabled={save.isPending || (!editing.id && (!editing.email || editing.password.length < 8))}
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
