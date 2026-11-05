import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Button, Modal } from '../ui';

/**
 * WhatsApp por Meta directo: el aviso de lo que Meta cobra (igual en todas las
 * pantallas) y el botón de conexión con el registro integrado de Meta.
 */

export type MetaCategory = 'SERVICIO' | 'UTILIDAD' | 'AUTENTICACION' | 'MARKETING';

export interface MetaNotice {
  title: string;
  summary: string;
  items: Array<{ category: MetaCategory; label: string; detail: string }>;
  why: string;
  caveats: string[];
}

export interface MetaConfig {
  available: boolean;
  missing?: string[];
  appId: string | null;
  configId: string | null;
  graphVersion: string;
  notice: MetaNotice;
  rates: Record<MetaCategory, number>;
  trm: number | null;
}

export const CATEGORY_LABEL: Record<MetaCategory, string> = {
  SERVICIO: 'Respuesta',
  UTILIDAD: 'Aviso',
  AUTENTICACION: 'Código',
  MARKETING: 'Promoción',
};

/** US$ por mensaje → texto con su equivalente aproximado en pesos. */
export function perMessage(usd: number, trm: number | null): string {
  if (!usd) return 'Sin costo';
  const cop = trm ? ` (≈ $${Math.max(1, Math.round(usd * trm)).toLocaleString('es-CO')})` : '';
  return `US$${usd.toFixed(usd < 0.01 ? 4 : 3)}${cop} c/u`;
}

export function useMetaConfig(q: string) {
  return useQuery({
    queryKey: ['whatsapp-meta-config', q],
    queryFn: () => api.get<MetaConfig>(`/whatsapp/meta/config${q ? `?${q}` : ''}`),
    staleTime: 5 * 60_000,
  });
}

/** Qué cobra Meta, por qué lo cobra a la empresa y no a BackOffice. */
export function MetaBillingNotice({ notice, rates, trm, compact = false }: { notice: MetaNotice; rates: Record<MetaCategory, number>; trm: number | null; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  return (
    <div className="border-2 border-ink bg-paper p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="kicker">Transparencia</p>
          <p className="display text-lg">{notice.title}</p>
        </div>
        {compact && (
          <button type="button" className="text-xs font-semibold underline" onClick={() => setOpen((v) => !v)}>
            {open ? 'Ocultar' : 'Ver detalle'}
          </button>
        )}
      </div>
      <p className="mt-2 text-ink-2">{notice.summary}</p>
      {open && (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {notice.items.map((i) => (
              <div key={i.category} className="border-2 border-line p-3">
                <p className="text-xs font-semibold uppercase tracking-[0.08em]">{i.label}</p>
                <p className="mt-1 font-mono text-sm">{perMessage(rates[i.category] ?? 0, trm)}</p>
                <p className="mt-1 text-xs text-ink-3">{i.detail}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2 border-t-2 border-line pt-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">¿Por qué no lo cobramos nosotros?</p>
              <p className="text-ink-2">{notice.why}</p>
            </div>
          </div>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-ink-3">
            {notice.caveats.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

/* ── Registro integrado de Meta (Embedded Signup) ── */

declare global {
  interface Window {
    FB?: any;
    fbAsyncInit?: () => void;
  }
}

let sdkPromise: Promise<any> | null = null;

function loadFacebookSdk(appId: string, version: string): Promise<any> {
  if (window.FB) {
    window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
    return Promise.resolve(window.FB);
  }
  sdkPromise ??= new Promise((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/es_LA/sdk.js';
    s.async = true;
    s.defer = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => { sdkPromise = null; reject(new Error('No se pudo cargar la ventana de Meta. Revisa tu conexión o el bloqueador de anuncios.')); };
    document.body.appendChild(s);
  });
  return sdkPromise;
}

/** Abre la ventana de Meta y devuelve el código y el número que eligió la empresa. */
function runEmbeddedSignup(FB: any, configId: string): Promise<{ code: string; wabaId: string; phoneNumberId: string }> {
  return new Promise((resolve, reject) => {
    let code: string | null = null;
    let session: { wabaId: string; phoneNumberId: string } | null = null;
    let settled = false;
    const done = () => {
      if (settled || !code || !session) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      resolve({ code, ...session });
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      reject(new Error(msg));
    };
    function onMessage(event: MessageEvent) {
      let host = '';
      try { host = new URL(event.origin).hostname; } catch { return; }
      if (!/(^|\.)facebook\.com$/.test(host)) return;
      let data: any;
      try { data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (String(data.event).startsWith('FINISH') && data.data?.waba_id && data.data?.phone_number_id) {
        session = { wabaId: String(data.data.waba_id), phoneNumberId: String(data.data.phone_number_id) };
        done();
      } else if (data.event === 'CANCEL') {
        fail(data.data?.current_step ? `Cerraste la ventana de Meta en el paso «${data.data.current_step}». Puedes retomarla cuando quieras.` : 'Cerraste la ventana de Meta antes de terminar.');
      } else if (data.event === 'ERROR') {
        fail(data.data?.error_message ? `Meta: ${data.data.error_message}` : 'Meta reportó un error en la conexión.');
      }
    }
    window.addEventListener('message', onMessage);
    FB.login((response: any) => {
      if (response?.authResponse?.code) {
        code = response.authResponse.code;
        // El número llega por mensaje: se le da un momento por si llega después del código
        setTimeout(() => (session ? done() : fail('Meta no devolvió el número elegido. Vuelve a intentarlo.')), 10_000);
        done();
      } else {
        fail('No se completó la conexión con Meta.');
      }
    }, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { setup: {}, featureType: '', sessionInfoVersion: '3' },
    });
  });
}

interface ConnectResult {
  registration: { ok: boolean; note?: string };
  templates: { created: string[]; failed: Array<{ key: string; error: string }> };
}

/**
 * Botón "Conectar con Meta". Antes de abrir la ventana de Meta muestra lo que
 * Meta le cobrará a la empresa y por qué: la empresa lo acepta explícitamente.
 */
export function MetaConnectButton({ q, integrationId, label = 'Conectar con Meta', size = 'sm', variant = 'primary' }: {
  q: string; integrationId?: string; label?: string; size?: 'sm' | 'md'; variant?: 'primary' | 'outline';
}) {
  const queryClient = useQueryClient();
  const { data: cfg } = useMetaConfig(q);
  const [open, setOpen] = useState(false);
  const [accepted, setAccepted] = useState(false);

  const connect = useMutation({
    mutationFn: async () => {
      if (!cfg?.appId || !cfg.configId) throw new Error('La conexión con Meta aún no está habilitada.');
      const FB = await loadFacebookSdk(cfg.appId, cfg.graphVersion);
      const session = await runEmbeddedSignup(FB, cfg.configId);
      return api.post<ConnectResult>(`/whatsapp/meta/connect${q ? `?${q}` : ''}`, { ...session, ...(integrationId ? { integrationId } : {}) });
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] });
      queryClient.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      setOpen(false);
      toast.success(`Número conectado con Meta.${r.templates.created.length ? ` Mandamos ${r.templates.created.length} plantillas a revisión de Meta.` : ''}`);
      if (!r.registration.ok) toast.warning('Meta no terminó de registrar el número. Si los mensajes no llegan, escríbenos y lo revisamos contigo.');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo conectar'),
  });

  if (!cfg) return null;
  if (!cfg.available) {
    return cfg.missing?.length
      ? <span className="text-xs text-ink-3">Conexión con Meta pendiente: falta {cfg.missing.join(', ')}</span>
      : null;
  }
  return (
    <>
      <Button size={size} variant={variant} onClick={() => { setAccepted(false); setOpen(true); }}>{label}</Button>
      <Modal open={open} onClose={() => !connect.isPending && setOpen(false)} kicker="WhatsApp oficial de Meta" title="Conecta tu número" wide>
        <div className="space-y-4 text-sm">
          <ol className="list-decimal space-y-1 pl-5 text-ink-2">
            <li>Se abre una ventana de Meta: entras con tu Facebook y eliges (o creas) tu cuenta de negocio.</li>
            <li>Registras tu número de WhatsApp y lo verificas con un código.</li>
            <li>El número queda a nombre de tu empresa. BackOffice solo recibe permiso para atender por ti.</li>
          </ol>
          <MetaBillingNotice notice={cfg.notice} rates={cfg.rates} trm={cfg.trm} />
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>Entiendo que Meta le cobra directo a mi empresa los mensajes que yo inicio (avisos y promociones), y que BackOffice no cobra ni intermedia ese pago.</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={connect.isPending}>Cancelar</Button>
            <Button onClick={() => connect.mutate()} disabled={!accepted || connect.isPending}>
              {connect.isPending ? 'Conectando…' : 'Abrir la ventana de Meta'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
