import { useState } from 'react';
import { Badge, Button, Card, Field, Input } from '../../../components/ui';
import PartnerConnect from './PartnerConnect';

/** Lo que Meta concedió de verdad a una conexión (lo calcula el servidor). */
export interface AccountAccess {
  verified: boolean;
  read: boolean;
  manage: boolean;
  missing: string[];
  tasks: string[];
  accountRoleLimited: boolean;
  /** Formularios instantáneos: null = sin verificar */
  leads?: boolean | null;
  leadsMissing?: string[];
}

/** Estado de permisos de una cuenta conectada, en palabras simples. */
export function AccessBadge({ access }: { access?: AccountAccess }) {
  if (!access) return null;
  if (!access.verified) {
    return <span className="block text-[11px] text-ink-3">Permisos: sin verificar (conexión anterior). Vuelve a conectarla para que BackOffice confirme qué puede hacer.</span>;
  }
  if (access.manage && !access.missing.length) {
    return <span className="block text-xs"><Badge tone="ok">Permisos completos</Badge> <span className="text-ink-3">Lee y mide todo; puede pausar y crear campañas en pausa con tu confirmación.</span></span>;
  }
  return (
    <span className="block text-xs">
      <Badge tone="warn">{access.manage ? 'Permisos incompletos' : 'Solo lectura'}</Badge>{' '}
      <span className="text-ink-2">
        {access.accountRoleLimited
          ? 'Tu rol en la cuenta publicitaria solo permite ver resultados: asígnale «Control total» al usuario del token. '
          : ''}
        {access.missing.length ? `Faltan: ${access.missing.join(', ')}. ` : ''}
        {!access.manage ? 'Se ven las métricas, pero pausar o crear campañas fallará.' : ''}
      </span>
    </span>
  );
}

const SCOPES = ['ads_management', 'ads_read', 'business_management'];
const LEAD_SCOPES = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads'];

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center border-2 border-ink text-xs font-bold">{n}</span>
      <span className="text-sm leading-relaxed">{children}</span>
    </li>
  );
}

/**
 * Guía para conectar Meta Ads con permisos completos. Tres caminos:
 * Facebook (si la app de BackOffice está configurada), acceso de socio
 * (el cliente no comparte ninguna credencial) o token de un usuario del sistema.
 */
export function MetaConnectGuide(props: {
  oauth: boolean;
  partnerBusinessId: string | null;
  onOAuth: () => void;
  oauthPending: boolean;
  manual: { accountId: string; token: string };
  setManual: (v: { accountId: string; token: string }) => void;
  onConnect: () => void;
  connectPending: boolean;
  /** Empresa en pantalla (?companyId=) y qué refrescar cuando la conexión por socio termina */
  scope?: string;
  onConnected?: () => void;
}) {
  const [way, setWay] = useState<'socio' | 'token'>(props.partnerBusinessId ? 'socio' : 'token');
  return (
    <Card kicker="Meta Ads · Facebook e Instagram" title="Conectar tu cuenta publicitaria" className="lg:col-span-2">
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <div className="space-y-3 text-sm text-ink-2">
          <p><b className="text-ink">Qué hace BackOffice con la conexión.</b> Lee tus campañas, conjuntos y anuncios, trae 60 días de métricas y las actualiza cada 6 horas; detecta oportunidades y te explica por qué.</p>
          <p>Con <b className="text-ink">permisos completos</b> también puede pausar o reanudar anuncios y crear campañas nuevas en pausa, <b className="text-ink">siempre con tu confirmación</b>. Nunca sube presupuestos ni activa campañas por su cuenta, y cada acción queda registrada con quién la aprobó.</p>
          <p className="border-2 border-line bg-paper px-3 py-2 text-xs">BackOffice nunca te pide la contraseña de Facebook. Puedes quitar el acceso cuando quieras desde la configuración de tu negocio en Meta.</p>
          {props.oauth && (
            <div className="border-t-2 border-line pt-3">
              <p className="mb-2"><b className="text-ink">Lo más rápido:</b> entra con Facebook y, cuando te pregunte, deja marcados todos los permisos y todas tus cuentas publicitarias.</p>
              <Button disabled={props.oauthPending} onClick={props.onOAuth}>Continuar con Facebook</Button>
            </div>
          )}
        </div>

        <div>
          <div className="mb-3 flex flex-wrap gap-2 text-sm" role="tablist" aria-label="Forma de conectar">
            {props.partnerBusinessId && (
              <button type="button" role="tab" aria-selected={way === 'socio'} onClick={() => setWay('socio')}
                className={`cursor-pointer border-2 px-3 py-1 ${way === 'socio' ? 'border-ink bg-ink text-bone' : 'border-line'}`}>Dar acceso a BackOffice (recomendado)</button>
            )}
            <button type="button" role="tab" aria-selected={way === 'token'} onClick={() => setWay('token')}
              className={`cursor-pointer border-2 px-3 py-1 ${way === 'token' ? 'border-ink bg-ink text-bone' : 'border-line'}`}>Avanzado: con un token</button>
          </div>

          {way === 'socio' && props.partnerBusinessId ? (
            <PartnerConnect q={props.scope ?? ''} onConnected={() => props.onConnected?.()} />
          ) : (
            <div data-testid="guide-token">
              <ol className="space-y-3">
                <Step n={1}>En <b>business.facebook.com → Configuración → Usuarios → Usuarios del sistema</b>, toca <b>Agregar</b>: nómbralo «BackOffice» con rol <b>Administrador</b>.</Step>
                <Step n={2}>En ese usuario, toca <b>Asignar activos → Cuentas publicitarias</b>, elige tu cuenta y activa <b>Control total</b> (administrar la cuenta publicitaria).</Step>
                <Step n={3}>Toca <b>Generar nuevo token</b>. Elige la app de tu negocio (si no tienes, créala gratis en developers.facebook.com con el tipo «Negocio»; solo sirve para generar el token). Caducidad: <b>Nunca</b>.</Step>
                <Step n={4}>Marca estos permisos: {SCOPES.map((s, i) => <span key={s}><code className="font-mono text-xs">{s}</code>{i < SCOPES.length - 1 ? ', ' : ''}</span>)}. Si tus anuncios usan formularios instantáneos, marca también {LEAD_SCOPES.map((s, i) => <span key={s}><code className="font-mono text-xs">{s}</code>{i < LEAD_SCOPES.length - 1 ? ', ' : ''}</span>)} para que BackOffice traiga a tu CRM a quienes los llenan. Copia el token.</Step>
                <Step n={5}>Pega abajo el ID de la cuenta publicitaria (<code className="font-mono text-xs">act_…</code>, está junto a su nombre en el Administrador de anuncios) y el token. BackOffice comprueba con Meta qué permisos tiene y te lo muestra.</Step>
              </ol>
              <div className="mt-4 space-y-2 border-t-2 border-line pt-4">
                <Field label="ID de la cuenta publicitaria"><Input placeholder="act_1234567890" value={props.manual.accountId} onChange={(e) => props.setManual({ ...props.manual, accountId: e.target.value })} /></Field>
                <Field label="Token de acceso" hint="Se guarda cifrado y nunca se vuelve a mostrar"><Input type="password" autoComplete="off" value={props.manual.token} onChange={(e) => props.setManual({ ...props.manual, token: e.target.value })} /></Field>
                <Button size="sm" disabled={props.connectPending || !props.manual.accountId || !props.manual.token} onClick={props.onConnect}>{props.connectPending ? 'Verificando con Meta…' : 'Verificar y conectar'}</Button>
              </div>
            </div>
          )}
          <p className="mt-3 text-[11px] text-ink-3">Los nombres de los menús de Meta pueden cambiar un poco según la versión que veas.</p>
        </div>
      </div>
    </Card>
  );
}

/** Qué puede hacer BackOffice con los permisos que Meta concedió, en palabras simples. */
export function CapabilitiesCard({ access }: { access?: AccountAccess }) {
  if (!access) return null;
  const manage = access.verified ? access.manage : null;
  const rows: Array<{ ok: boolean | null; title: string; detail: string }> = [
    { ok: access.read, title: 'Leer y medir', detail: 'Campañas, conjuntos y anuncios con 60 días de métricas, actualizadas cada 6 horas.' },
    { ok: access.read, title: 'Recomendar', detail: 'Oportunidades explicadas: costo que sube, gasto que se cae, anuncios sin resultados o rechazados.' },
    { ok: manage, title: 'Crear anuncios completos', detail: 'Imagen, texto, público, presupuesto y fechas. Se crean en pausa; tú decides cuándo activarlos.' },
    { ok: manage, title: 'Pausar, reanudar y activar', detail: 'Siempre con tu confirmación y dentro del tope diario que definas.' },
    { ok: manage, title: 'Programar la semana', detail: 'Fechas de inicio y fin de cada anuncio, en la zona horaria de tu cuenta.' },
    {
      ok: access.verified ? !!access.leads : null, title: 'Leer formularios instantáneos',
      detail: access.leads
        ? 'Cada 10 minutos trae quién llenó el formulario de tus anuncios y crea el contacto en tu CRM con el anuncio del que vino.'
        : `Para traer nombre, teléfono y correo de quienes llenan tus formularios falta que Meta conceda: ${(access.leadsMissing?.length ? access.leadsMissing : ['leads_retrieval']).join(', ')}.`,
    },
    { ok: access.read, title: 'Analizar con IA', detail: 'Un resumen escrito de qué funciona, qué no y qué hacer esta semana. La IA interpreta las cifras; no las calcula ni cambia nada en tu cuenta.' },
  ];
  return (
    <Card kicker="Tu conexión con Meta" title="Qué puede hacer BackOffice">
      <ul className="grid gap-3 md:grid-cols-2" data-testid="capabilities">
        {rows.map((r) => (
          <li key={r.title} className="flex gap-3 text-sm">
            <Badge tone={r.ok === null ? 'neutral' : r.ok ? 'ok' : 'warn'}>{r.ok === null ? 'Por verificar' : r.ok ? 'Sí' : 'Falta permiso'}</Badge>
            <span><b>{r.title}.</b> <span className="text-ink-2">{r.detail}</span></span>
          </li>
        ))}
      </ul>
      <p className="mt-4 border-t-2 border-line pt-3 text-xs text-ink-3">
        Lo que BackOffice nunca hace solo: subir presupuestos, activar campañas o gastar por encima de tu tope. El análisis con IA usa la IA de tu empresa; sin ella, las oportunidades se siguen detectando con reglas.
      </p>
    </Card>
  );
}
