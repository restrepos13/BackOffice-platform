import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Dice5 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { ROLE_LABELS, timeAgo } from '../../lib/format';
import { strongPassword } from '../../lib/password';
import type { Company, UserRow } from '../../lib/types';
import {
  Badge, Button, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs,
} from '../../components/ui';

type Scope = 'team' | 'companies';

interface UserForm {
  id?: string;
  scope: Scope;
  name: string;
  email: string;
  role: string;
  companyId: string;
  password: string;
  jobTitle: string;
}

const PLATFORM_ROLES = ['SUPER_ADMIN', 'DEV'];
const COMPANY_ROLES = ['COMPANY_ADMIN', 'COMPANY_VIEWER', 'COMPANY_AREA', 'COMPANY_COURIER'];
const MIN_PASSWORD: Record<Scope, number> = { team: 10, companies: 8 };

const isPlatform = (role: string) => PLATFORM_ROLES.includes(role);

const newDev = (): UserForm => ({
  scope: 'team', name: '', email: '', role: 'DEV', companyId: '', password: strongPassword(), jobTitle: 'Desarrollador',
});
const newCompanyUser = (): UserForm => ({
  scope: 'companies', name: '', email: '', role: 'COMPANY_ADMIN', companyId: '', password: strongPassword(), jobTitle: '',
});

export default function PlatformUsers() {
  const queryClient = useQueryClient();
  const { user: me } = useAuth();
  const [tab, setTab] = useState<Scope>('team');
  const [editing, setEditing] = useState<UserForm | null>(null);
  const [removing, setRemoving] = useState<UserRow | null>(null);
  const [credentials, setCredentials] = useState<{ name: string; email: string; password: string; role: string } | null>(null);
  const [filter, setFilter] = useState('');
  const iAmSuperAdmin = me?.role === 'SUPER_ADMIN';

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
      if (form.id) {
        return api.patch(`/users/${form.id}`, {
          name: form.name,
          role: form.role,
          jobTitle: form.jobTitle || undefined,
          ...(form.password ? { password: form.password } : {}),
        });
      }
      return api.post('/users', {
        name: form.name, email: form.email.trim(), role: form.role,
        password: form.password, jobTitle: form.jobTitle || undefined,
        companyId: isPlatform(form.role) ? undefined : form.companyId,
      });
    },
    onSuccess: (_data, form) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      setEditing(null);
      if (!form.id || form.password) {
        setCredentials({ name: form.name, email: form.email.trim(), password: form.password, role: form.role });
      } else {
        toast.success('Usuario guardado');
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/users/${u.id}`, { active: !u.active }),
    onSuccess: (_d, u) => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success(u.active ? `${u.name} ya no puede entrar` : `${u.name} puede volver a entrar`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const remove = useMutation({
    mutationFn: (u: UserRow) => api.delete(`/users/${u.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.success('Usuario eliminado');
      setRemoving(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const all = users ?? [];
  const team = all.filter((u) => isPlatform(u.role));
  const companyUsers = all.filter((u) => !isPlatform(u.role));
  const q = filter.trim().toLowerCase();
  const rows = (tab === 'team' ? team : companyUsers).filter(
    (u) =>
      !q ||
      u.name.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.company?.name ?? '').toLowerCase().includes(q),
  );

  /** Un dev no toca cuentas Super Admin (el API también lo bloquea). */
  const canManage = (u: UserRow) => iAmSuperAdmin || u.role !== 'SUPER_ADMIN';

  const roleOptions = (form: UserForm) =>
    form.scope === 'team'
      ? PLATFORM_ROLES.filter((r) => r !== 'SUPER_ADMIN' || iAmSuperAdmin)
      : COMPANY_ROLES;

  const minPassword = editing ? MIN_PASSWORD[editing.scope] : 8;
  const passwordOk = editing
    ? editing.id
      ? !editing.password || editing.password.length >= minPassword
      : editing.password.length >= minPassword
    : false;
  const canSave = !!editing && editing.name.trim().length >= 2 && passwordOk &&
    (!!editing.id || (/\S+@\S+\.\S+/.test(editing.email) &&
      (editing.scope === 'team' || !!editing.companyId)));

  const accessText = credentials
    ? `Acceso a BackOffice\n${window.location.origin}/login\nCorreo: ${credentials.email}\nContraseña: ${credentials.password}\n\nCámbiala en tu perfil al entrar.`
    : '';

  return (
    <>
      <PageHeader
        kicker="Plataforma"
        title="Usuarios"
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setEditing(newCompanyUser())}>+ Usuario de empresa</Button>
            <Button onClick={() => setEditing(newDev())}>+ Nuevo dev</Button>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs
          tabs={[
            { id: 'team', label: 'Equipo BackOffice', badge: team.length },
            { id: 'companies', label: 'Usuarios de empresas', badge: companyUsers.length },
          ]}
          active={tab}
          onChange={(id) => setTab(id as Scope)}
        />
        <Input
          placeholder={tab === 'team' ? 'Buscar por nombre o correo…' : 'Buscar por nombre, correo o empresa…'}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-sm"
        />
      </div>

      {tab === 'team' && (
        <div className="mb-4 grid gap-3 border-2 border-ink bg-paper p-4 text-sm sm:grid-cols-2">
          <p>
            <b>Desarrollador.</b> Entra a todas las empresas, configura bots, módulos, cobros y Dev Tools,
            y puede dar de alta otros devs. No puede crear ni tocar cuentas Super Admin.
          </p>
          <p>
            <b>Super Admin.</b> Todo lo anterior y además gestiona a los Super Admin. Siempre debe quedar
            al menos uno activo. Al desactivar a alguien pierde el acceso en menos de un minuto.
          </p>
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : (
        <Table head={tab === 'team'
          ? ['Usuario', 'Rol', 'Estado', 'Último acceso', '']
          : ['Usuario', 'Rol', 'Empresa', 'Estado', 'Último acceso', '']}>
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-6 text-center text-sm text-ink-3">
                {q ? 'Nadie coincide con la búsqueda.' : 'Todavía no hay usuarios aquí.'}
              </td>
            </tr>
          )}
          {rows.map((u) => (
            <tr key={u.id}>
              <td className="px-4 py-3">
                <p className="font-semibold">
                  {u.name}
                  {u.id === me?.id && <span className="ml-2 text-xs font-normal text-ink-3">(tú)</span>}
                </p>
                <p className="text-xs text-ink-3">{u.email}</p>
                {u.jobTitle && <p className="text-xs text-ink-3">{u.jobTitle}</p>}
              </td>
              <td className="px-4 py-3">
                <Badge tone={u.role === 'SUPER_ADMIN' ? 'ink' : u.role === 'DEV' ? 'info' : 'neutral'}>
                  {ROLE_LABELS[u.role]}
                </Badge>
              </td>
              {tab === 'companies' && <td className="px-4 py-3 text-sm">{u.company?.name ?? '—'}</td>}
              <td className="px-4 py-3">
                <Badge tone={u.active ? 'ok' : 'bad'}>{u.active ? 'Activo' : 'Inactivo'}</Badge>
              </td>
              <td className="px-4 py-3 text-xs text-ink-3">
                {u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Nunca'}
              </td>
              <td className="px-4 py-3">
                {canManage(u) && (
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm" variant="outline"
                      onClick={() =>
                        setEditing({
                          id: u.id, scope: isPlatform(u.role) ? 'team' : 'companies',
                          name: u.name, email: u.email, role: u.role,
                          companyId: u.companyId ?? '', password: '', jobTitle: u.jobTitle ?? '',
                        })
                      }
                    >
                      Editar
                    </Button>
                    {u.id !== me?.id && (
                      <>
                        <Button size="sm" variant="ghost" disabled={toggleActive.isPending}
                          onClick={() => toggleActive.mutate(u)}>
                          {u.active ? 'Desactivar' : 'Activar'}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(u)}>Eliminar</Button>
                      </>
                    )}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        kicker={editing?.scope === 'team' ? 'Equipo BackOffice' : 'Usuarios de empresas'}
        title={editing?.id ? `Editar ${editing.name}` : editing?.scope === 'team' ? 'Nuevo dev' : 'Nuevo usuario de empresa'}
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Nombre" required>
              <Input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Correo" required hint={editing.id ? 'El correo no se cambia' : 'Con este correo inicia sesión'}>
              <Input type="email" value={editing.email} disabled={!!editing.id}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })} />
            </Field>
            <Field label="Rol" required>
              <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                {roleOptions(editing).map((value) => (
                  <option key={value} value={value}>{ROLE_LABELS[value]}</option>
                ))}
              </Select>
            </Field>
            {editing.scope === 'companies' && !editing.id && (
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
              label={editing.id ? 'Nueva contraseña (opcional)' : 'Contraseña temporal'}
              hint={`Mínimo ${minPassword} caracteres. Al guardar te la mostramos para copiarla.`}
              required={!editing.id}
            >
              <div className="flex gap-2">
                <Input type="text" value={editing.password}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
                <Button variant="outline" onClick={() => setEditing({ ...editing, password: strongPassword() })}
                  aria-label="Generar contraseña segura" title="Generar contraseña segura">
                  <Dice5 size={15} />
                </Button>
              </div>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button disabled={save.isPending || !canSave} onClick={() => save.mutate(editing)}>
                {save.isPending ? 'Guardando…' : editing.id ? 'Guardar' : 'Crear usuario'}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!credentials}
        onClose={() => setCredentials(null)}
        kicker="Acceso listo"
        title={credentials ? `Datos de ${credentials.name}` : ''}
      >
        {credentials && (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">
              Mándale estos datos por un canal privado. La contraseña no se vuelve a mostrar.
            </p>
            <pre className="whitespace-pre-wrap border-2 border-ink bg-bone-2 p-4 font-mono text-sm">{accessText}</pre>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setCredentials(null)}>Cerrar</Button>
              <Button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(accessText);
                    toast.success('Acceso copiado');
                  } catch {
                    toast.error('No se pudo copiar; selecciónalo a mano');
                  }
                }}
              >
                <Copy size={15} /> Copiar acceso
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        kicker="Eliminar usuario"
        title={removing ? `¿Eliminar a ${removing.name}?` : ''}
      >
        {removing && (
          <div className="space-y-4">
            <p className="text-sm text-ink-2">
              {removing.email} deja de poder entrar y la cuenta se borra. Si solo quieres quitarle el acceso
              por un tiempo, mejor desactívala.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setRemoving(null)}>Cancelar</Button>
              <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                {remove.isPending ? 'Eliminando…' : 'Eliminar'}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
