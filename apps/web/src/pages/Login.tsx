import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '../lib/auth';
import { Button, Field, Input } from '../components/ui';

export default function Login() {
  const { user, login, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  if (!loading && user) {
    return (
      <Navigate
        to={user.role === 'SUPER_ADMIN' || user.role === 'DEV' ? '/platform' : '/app'}
        replace
      />
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const u = await login(email, password);
      // Cada rol aterriza en su espacio (área, domiciliario, empresa o plataforma)
      navigate(u.role === 'SUPER_ADMIN' || u.role === 'DEV' ? '/platform' : '/');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al iniciar sesión');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bone px-4">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <p className="kicker">Estudio de automatización con IA</p>
          <h1 className="display text-6xl">
            Back
            <br />
            Office<span className="text-ok">.</span>
          </h1>
          <p className="serif-accent mt-2 text-2xl text-ink-2">
            tu operación, en un solo panel.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 border-2 border-ink bg-paper p-6 shadow-[8px_8px_0_0_rgba(26,26,26,0.9)]"
        >
          <Field label="Correo" required>
            <Input
              type="email"
              autoComplete="email"
              placeholder="tu@empresa.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label="Contraseña" required>
            <Input
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'Entrando…' : 'Entrar al panel →'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm">
          ¿Aún no tienes cuenta?{' '}
          <Link to="/registro" className="font-semibold underline">Crea tu empresa con IA</Link>
        </p>
        <p className="kicker mt-2 text-center">
          <Link to="/" className="hover:underline">← Volver al inicio</Link>
        </p>
      </div>
    </div>
  );
}
