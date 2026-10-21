import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, setToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Field, Input } from './ui';

/**
 * Verificación en dos pasos (TOTP): Google Authenticator, Microsoft
 * Authenticator, 1Password… Obligatoria para cuentas de plataforma cuando el
 * servidor tiene PLATFORM_MFA_REQUIRED=true; opcional para las demás.
 */
export default function MfaSettings() {
  const { isPlatform } = useAuth();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({ queryKey: ['mfa'], queryFn: () => api.get<{ enabled: boolean; recoveryCodesLeft: number }>('/auth/mfa') });
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; uri: string; qrSvg: string }>('/auth/mfa/setup'),
    onSuccess: (r) => { setSetup(r); setCode(''); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ token: string; recoveryCodes: string[] }>('/auth/mfa/enable', { code }),
    onSuccess: (r) => {
      setToken(r.token); // las demás sesiones se cerraron; esta sigue con un token nuevo
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      queryClient.invalidateQueries({ queryKey: ['mfa'] });
      toast.success('Verificación en dos pasos activada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  const disable = useMutation({
    mutationFn: () => api.post('/auth/mfa/disable', { password, code }),
    onSuccess: () => { toast.success('Verificación en dos pasos desactivada. Vuelve a iniciar sesión.'); setTimeout(() => (window.location.href = '/login'), 1200); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!status) return null;
  return (
    <div className="space-y-3 border-t-2 border-line pt-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-semibold"><ShieldCheck size={15} /> Verificación en dos pasos</p>
        <Badge tone={status.enabled ? 'ok' : isPlatform ? 'bad' : 'neutral'}>{status.enabled ? 'Activa' : 'Apagada'}</Badge>
      </div>

      {codes && (
        <div className="border-2 border-warn bg-warn-soft p-3">
          <p className="font-semibold">Guarda estos códigos de recuperación</p>
          <p className="text-xs">Sirven una sola vez cada uno si pierdes el celular. No los volveremos a mostrar.</p>
          <p className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{codes.map((c) => <span key={c}>{c}</span>)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => { void navigator.clipboard?.writeText(codes.join('\n')); toast.success('Copiados'); }}>Copiar</Button>
        </div>
      )}

      {!status.enabled && !setup && (
        <>
          <p className="text-ink-2">{isPlatform ? 'Tu cuenta tiene acceso a todas las empresas: actívala ya.' : 'Protege tu cuenta aunque alguien conozca tu contraseña.'}</p>
          <Button size="sm" disabled={start.isPending} onClick={() => start.mutate()}>Activar</Button>
        </>
      )}

      {setup && (
        <div className="space-y-2">
          <p>1. Escanea el código con tu app de autenticación.</p>
          <img alt="Código QR para la app de autenticación" className="h-44 w-44 border-2 border-ink bg-white p-1" src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qrSvg)}`} />
          <p className="text-xs text-ink-3">¿No puedes escanear? Escribe esta clave: <span className="font-mono break-all">{setup.secret}</span></p>
          <Field label="2. Escribe el código de 6 dígitos">
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setSetup(null)}>Cancelar</Button>
            <Button size="sm" disabled={code.replace(/\s/g, '').length !== 6 || enable.isPending} onClick={() => enable.mutate()}>Confirmar</Button>
          </div>
        </div>
      )}

      {status.enabled && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-3">Te quedan {status.recoveryCodesLeft} códigos de recuperación · Desactivar</summary>
          <div className="mt-2 space-y-2">
            <Field label="Contraseña"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Field label="Código de la app o de recuperación"><Input value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Button size="sm" variant="danger" disabled={!password || code.length < 6 || disable.isPending} onClick={() => disable.mutate()}>Desactivar</Button>
          </div>
        </details>
      )}
    </div>
  );
}
