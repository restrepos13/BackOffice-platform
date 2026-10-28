import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import type { AuthUser } from '../../lib/types';
import { ROLE_LABELS } from '../../lib/format';
import { Button, Field, Input } from '../../components/ui';

/**
 * Páginas públicas del ciclo de cuenta: recuperar contraseña, crear una nueva
 * con el enlace del correo y aceptar una invitación. El servidor valida todo;
 * los mensajes no revelan si una cuenta existe.
 */

function Shell({ kicker, title, children }: { kicker: string; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bone px-4">
      <div className="w-full max-w-md">
        <Link to="/login" className="display text-3xl leading-none">BackOffice<span className="text-ok">.</span></Link>
        <div className="mt-6 space-y-4 border-2 border-ink bg-paper p-6">
          <div>
            <p className="kicker">{kicker}</p>
            <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
          </div>
          {children}
        </div>
        <p className="mt-4 text-center text-sm"><Link to="/login" className="underline">Volver a iniciar sesión</Link></p>
      </div>
    </div>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : 'No se pudo completar. Intenta de nuevo.');

function PasswordFields({ password, confirm, onPassword, onConfirm, min }: { password: string; confirm: string; onPassword: (v: string) => void; onConfirm: (v: string) => void; min: number }) {
  return (
    <>
      <Field label="Contraseña nueva" required hint={`Mínimo ${min} caracteres`}>
        <Input type="password" autoComplete="new-password" value={password} minLength={min} onChange={(e) => onPassword(e.target.value)} required />
      </Field>
      <Field label="Repite la contraseña" required error={confirm && confirm !== password ? 'Las contraseñas no coinciden' : undefined}>
        <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => onConfirm(e.target.value)} required />
      </Field>
    </>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/public/account/password/forgot', { email: email.trim() });
      setSent(r.message);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell kicker="Recuperar acceso" title="¿Olvidaste tu contraseña?">
      {sent ? (
        <p role="status" className="text-sm">{sent} Revisa también la carpeta de spam. El enlace vence en 30 minutos.</p>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <p className="text-sm text-ink-2">Escribe el correo con el que entras. Si tiene una cuenta activa, te enviamos un enlace para crear una contraseña nueva.</p>
          <Field label="Correo" required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </Field>
          {error && <p role="alert" className="text-sm font-semibold text-bad">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || !email.trim()}>{busy ? 'Enviando…' : 'Enviar enlace'}</Button>
        </form>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ message: string }>('/public/account/password/reset', { token, password });
      setDone(r.message);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell kicker="Recuperar acceso" title="Crea una contraseña nueva">
      {!token ? (
        <p role="alert" className="text-sm">Falta el enlace. Ábrelo desde el correo o <Link to="/recuperar" className="underline">pide uno nuevo</Link>.</p>
      ) : done ? (
        <div className="space-y-3">
          <p role="status" className="text-sm">{done} Por seguridad cerramos las sesiones que tenías abiertas.</p>
          <Link to="/login"><Button className="w-full">Iniciar sesión</Button></Link>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={8} />
          {error && <p role="alert" className="text-sm font-semibold text-bad">{error} <Link to="/recuperar" className="underline">Pedir otro enlace</Link></p>}
          <Button type="submit" className="w-full" disabled={busy || password.length < 8 || password !== confirm}>{busy ? 'Guardando…' : 'Guardar contraseña'}</Button>
        </form>
      )}
    </Shell>
  );
}

export function AcceptInvitation() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const { adopt } = useAuth();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const invite = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => api.get<{ companyName: string; email: string; name: string | null; role: string; expiresAt: string }>(`/public/account/invitations/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string; user: AuthUser }>('/public/account/invitations/accept', { token, password, name: name.trim() || undefined });
      adopt(r.token, r.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  if (!token || invite.isError) {
    return (
      <Shell kicker="Invitación" title="Esta invitación no se puede usar">
        <p className="text-sm">{invite.isError ? errText(invite.error) : 'Falta el enlace de la invitación.'} Pídele a quien te invitó que te envíe una nueva.</p>
      </Shell>
    );
  }
  if (invite.isLoading || !invite.data) return <Shell kicker="Invitación" title="Revisando la invitación…"><p className="text-sm text-ink-3">Un momento.</p></Shell>;
  const inv = invite.data;
  return (
    <Shell kicker="Invitación" title={`Únete a ${inv.companyName}`}>
      <p className="text-sm text-ink-2">Te invitaron como <b>{ROLE_LABELS[inv.role] ?? inv.role}</b>. Tu usuario será <b>{inv.email}</b>.</p>
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Tu nombre">
          <Input autoComplete="name" value={name} placeholder={inv.name ?? ''} onChange={(e) => setName(e.target.value)} />
        </Field>
        <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} min={8} />
        {error && <p role="alert" className="text-sm font-semibold text-bad">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || password.length < 8 || password !== confirm}>{busy ? 'Creando tu cuenta…' : 'Aceptar y entrar'}</Button>
      </form>
    </Shell>
  );
}
