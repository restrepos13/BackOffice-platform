import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CircleAlert, CircleHelp, Copy, MessageCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import { Badge, Button, Field, Input } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * Conectar Meta Ads dándole acceso de socio a BackOffice: el cliente no crea
 * usuarios del sistema ni copia tokens. Comparte su cuenta con nuestro
 * portafolio, escribe el número de su cuenta y BackOffice la conecta sola.
 */

interface PartnerInfo { businessId: string | null; automatic: boolean }
export interface AssetState { ok: boolean | null; name?: string }
export interface PartnerAssets { page: AssetState; instagram: AssetState; pixel: AssetState }
type Claim = { status: 'WAITING'; message: string } | { status: 'CONNECTED'; account: { name: string }; readOnly: boolean; assets?: PartnerAssets };

/** Lo que el cliente comparte con BackOffice, en el orden en que lo encuentra en Meta. */
export const SHARE_ITEMS = [
  { key: 'account', label: 'Cuenta publicitaria', path: ['Cuentas', 'Cuentas publicitarias'], why: 'crear, editar y pausar campañas y ver sus resultados', permission: 'Control total (administrar la cuenta publicitaria)' },
  { key: 'page', label: 'Página de Facebook', path: ['Cuentas', 'Páginas'], why: 'que los anuncios salgan a nombre de tu marca y publicar en ella', permission: 'Control total (todo, incluido contenido y anuncios)' },
  { key: 'instagram', label: 'Cuenta de Instagram', path: ['Cuentas', 'Cuentas de Instagram'], why: 'anunciar y publicar en tu Instagram', permission: 'Control total' },
  { key: 'pixel', label: 'Píxel o conjunto de datos', path: ['Orígenes de datos', 'Conjuntos de datos'], why: 'medir ventas y registros, y optimizar las campañas a resultados', permission: 'Control total (administrar el conjunto de datos)' },
] as const;

const HINT: Record<keyof PartnerAssets, string> = {
  page: 'Comparte la página que usas en tus anuncios (Cuentas › Páginas › Asignar socio).',
  instagram: 'Compártelo en Cuentas › Cuentas de Instagram, o vincúlalo a tu página de Facebook.',
  pixel: 'Compártelo en Orígenes de datos › Conjuntos de datos. Si aún no tienes píxel, puedes seguir: se crea después.',
};

/** Qué quedó bien y qué le falta al cliente después de conectar. */
export function SharedChecklist({ readOnly, assets, onRecheck, busy }: { readOnly: boolean; assets: PartnerAssets; onRecheck: () => void; busy: boolean }) {
  const rows: Array<{ key: string; label: string; state: AssetState; hint: string }> = [
    { key: 'account', label: 'Cuenta publicitaria', state: { ok: !readOnly }, hint: 'Quedó en solo lectura: vuelve a compartirla con «Control total».' },
    { key: 'page', label: 'Página de Facebook', state: assets.page, hint: HINT.page },
    { key: 'instagram', label: 'Instagram', state: assets.instagram, hint: HINT.instagram },
    { key: 'pixel', label: 'Píxel', state: assets.pixel, hint: HINT.pixel },
  ];
  const missing = rows.filter((r) => r.state.ok !== true).length;
  return (
    <div className="mt-4 border-2 border-ink bg-paper p-3 text-sm" data-testid="partner-checklist">
      <p className="font-semibold">{missing ? `Conectada. ${missing === 1 ? 'Falta 1 cosa' : `Faltan ${missing} cosas`} para usar todo` : 'Todo compartido: BackOffice ya puede trabajar tu publicidad completa'}</p>
      <ul className="mt-2 space-y-2">
        {rows.map((r) => (
          <li key={r.key} className="flex gap-2">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {r.state.ok ? <Check size={15} className="text-ok" /> : r.state.ok === false ? <CircleAlert size={15} className="text-bad" /> : <CircleHelp size={15} className="text-ink-3" />}
            </span>
            <span className="min-w-0">
              <b>{r.label}</b>{' '}
              <span className="text-ink-2">{r.state.ok ? (r.state.name ? `· ${r.state.name}` : '· lista') : r.state.ok === false ? '· falta' : '· no pudimos confirmarlo ahora'}</span>
              {r.state.ok !== true && <span className="block text-xs text-ink-3">{r.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
      {missing > 0 && <Button className="mt-3" size="sm" variant="outline" disabled={busy} onClick={onRecheck}>{busy ? 'Revisando…' : 'Ya lo compartí, volver a revisar'}</Button>}
    </div>
  );
}

/** Cada cuánto se vuelve a buscar y hasta cuándo (Meta tarda a veces un par de minutos). */
export const RETRY_MS = 15_000;
export const GIVE_UP_MS = 8 * 60_000;

export const accountNumber = (raw: string) => raw.trim().replace(/^act_/i, '').replace(/\D/g, '');

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center border-2 border-ink bg-paper text-xs font-bold">{n}</span>
      <div className="min-w-0 text-sm leading-relaxed">
        <p className="font-semibold">{title}</p>
        <div className="mt-0.5 text-ink-2">{children}</div>
      </div>
    </li>
  );
}

function Path({ items }: { items: readonly string[] }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1 text-xs">
      {items.map((it, i) => (
        <span key={it} className="flex items-center gap-1">
          <span className="border border-ink bg-bone px-1.5 py-0.5 font-semibold text-ink">{it}</span>
          {i < items.length - 1 && <span aria-hidden className="text-ink-3">›</span>}
        </span>
      ))}
    </span>
  );
}

/** Texto para mandarle a quien administra la cuenta en Meta (cuando no es el mismo dueño). */
export function adminInstructions(businessId: string) {
  return [
    'Hola, necesito que le des acceso a BackOffice a nuestra cuenta publicitaria de Meta:',
    '1. Entra a business.facebook.com/settings',
    `2. Comparte estas 4 cosas con el ID de portafolio ${businessId}, cada una con «Asignar socio» > «ID del portafolio comercial» y «Control total»:`,
    ...SHARE_ITEMS.map((it) => `   • ${it.label}: ${it.path.join(' > ')}`),
    'Con eso BackOffice puede crear y administrar los anuncios, publicar y medir resultados. No hay que compartir contraseñas.',
  ].join('\n');
}

export default function PartnerConnect({ q, onConnected }: { q: string; onConnected: () => void }) {
  const { data: info } = useQuery({ queryKey: ['ads-partner', q], queryFn: () => api.get<PartnerInfo>(withScope('/ads/meta/partner', q)) });
  const [account, setAccount] = useState('');
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ readOnly: boolean; assets: PartnerAssets } | null>(null);
  const [waiting, setWaiting] = useState<{ since: number; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Desde cuándo se busca (ref: los reintentos no deben ver un valor viejo)
  const since = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const claim = useMutation({
    mutationFn: () => api.post<Claim>(withScope('/ads/meta/partner/claim', q), { accountId: account }),
    onSuccess: (r) => {
      if (r.status === 'CONNECTED') {
        setWaiting(null);
        since.current = null;
        onConnected();
        if (r.assets) setResult({ readOnly: r.readOnly, assets: r.assets });
        if (r.readOnly) toast.warning(`«${r.account.name}» quedó conectada, pero en solo lectura: vuelve a compartirla con «Control total».`);
        else toast.success(`«${r.account.name}» quedó conectada. Ya puedes sincronizarla.`);
        return;
      }
      since.current ??= Date.now();
      if (Date.now() - since.current > GIVE_UP_MS) {
        setWaiting(null);
        since.current = null;
        toast.error('No vimos la cuenta compartida después de varios minutos. Revisa el paso 3 y el número de la cuenta, o escríbenos.');
        return;
      }
      setWaiting({ since: since.current, message: r.message });
      timer.current = setTimeout(() => claim.mutate(), RETRY_MS);
    },
    onError: (e) => { setWaiting(null); since.current = null; toast.error(e instanceof Error ? e.message : 'No se pudo buscar la cuenta'); },
  });

  const recheck = useMutation({
    mutationFn: () => api.post<{ account: string; assets: PartnerAssets }>(withScope('/ads/meta/partner/assets', q)),
    onSuccess: (r) => {
      setResult((prev) => ({ readOnly: prev?.readOnly ?? false, assets: r.assets }));
      const left = Object.values(r.assets).filter((a) => a.ok !== true).length;
      if (left) toast.info(left === 1 ? 'Todavía falta 1 cosa' : `Todavía faltan ${left} cosas`);
      else toast.success('Todo compartido');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo revisar'),
  });

  if (!info?.businessId) return null;
  const digits = accountNumber(account);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info.businessId!);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.info(`Cópialo a mano: ${info.businessId}`);
    }
  };
  const stop = () => { if (timer.current) clearTimeout(timer.current); since.current = null; setWaiting(null); };

  return (
    <div data-testid="guide-partner">
      <p className="mb-4 text-sm text-ink-2">
        Le das acceso a BackOffice desde tu portafolio de Meta, como harías con una agencia. <b className="text-ink">No compartes contraseñas ni tokens</b> y lo puedes quitar cuando quieras. Toma unos 3 minutos.
      </p>

      <details className="mb-4 border-2 border-line bg-paper px-3 py-2 text-sm">
        <summary className="cursor-pointer font-semibold">Antes de empezar: lo que necesitas</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
          <li>Ser <b>administrador</b> del portafolio comercial de Meta donde está la cuenta publicitaria. Si no lo eres, usa «Mandarle las instrucciones» abajo.</li>
          <li>Que la cuenta publicitaria esté dentro de un portafolio comercial. Si la usas solo desde tu Facebook personal, crea el portafolio gratis en business.facebook.com y agrega ahí tu cuenta (Cuentas › Cuentas publicitarias › Agregar).</li>
          <li>Hacerlo desde el computador es más fácil; en el celular, abre business.facebook.com en el navegador (no en la app de Facebook).</li>
        </ul>
      </details>

      <ol className="space-y-4">
        <Step n={1} title="Escribe el número de tu cuenta publicitaria">
          Lo ves en el Administrador de anuncios (adsmanager.facebook.com), debajo del nombre de la cuenta, o en la dirección de la página después de <code className="font-mono text-xs">act=</code>.
          <div className="mt-2 max-w-xs">
            <Field label="Número de la cuenta"><Input inputMode="numeric" placeholder="1234567890" value={account} onChange={(e) => setAccount(e.target.value)} disabled={!!waiting} /></Field>
          </div>
        </Step>
        <Step n={2} title="Copia el ID de BackOffice">
          Lo vas a pegar en cada una de las 4 cosas del paso 3:
          <span className="mt-2 flex flex-wrap items-center gap-2">
            <code className="border-2 border-ink bg-bone px-2 py-1 font-mono text-sm text-ink">{info.businessId}</code>
            <Button size="sm" variant="outline" onClick={copy}>{copied ? <><Check size={13} /> Copiado</> : <><Copy size={13} /> Copiar</>}</Button>
          </span>
        </Step>
        <Step n={3} title="Comparte estas 4 cosas con BackOffice">
          Entra a <b>business.facebook.com/settings</b>. En cada una: elígela, toca <b>Asignar socio</b> (puede decir «Socios» o «Compartir»), elige <b>ID del portafolio comercial</b>, pega el ID y activa <b>Control total</b>. Si Meta te pide un código de seguridad, es normal.
          <ol className="mt-2 space-y-2" data-testid="share-items">
            {SHARE_ITEMS.map((it, i) => (
              <li key={it.key} className="border-l-2 border-ink pl-2">
                <span className="font-semibold text-ink">{String.fromCharCode(97 + i)}. {it.label}</span> <span className="text-xs">— para {it.why}</span>
                <Path items={it.path} />
              </li>
            ))}
          </ol>
          <span className="mt-2 block text-xs text-ink-3">La cuenta publicitaria es lo único obligatorio para conectar; lo demás lo revisamos y te decimos si falta algo.</span>
        </Step>
        <Step n={4} title="Vuelve aquí y toca «Ya la compartí»">
          {info.automatic
            ? 'BackOffice busca tu cuenta y la conecta sola. Si Meta tarda, seguimos buscando unos minutos; no cierres esta página.'
            : 'Avísanos y la conectamos desde nuestro lado en el día.'}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {info.automatic ? (
              waiting ? (
                <>
                  <Badge tone="info">Buscando tu cuenta…</Badge>
                  <Button size="sm" variant="ghost" onClick={stop}>Detener</Button>
                </>
              ) : (
                <Button disabled={digits.length < 5 || claim.isPending} onClick={() => claim.mutate()}>{claim.isPending ? 'Buscando…' : 'Ya la compartí'}</Button>
              )
            ) : (
              <a className="inline-flex items-center gap-2 bg-ink px-4 py-2 text-sm font-semibold text-bone" href={`https://wa.me/?text=${encodeURIComponent(`Ya compartí mi cuenta publicitaria ${digits ? `act_${digits} ` : ''}con BackOffice como socio.`)}`} target="_blank" rel="noreferrer">
                <MessageCircle size={14} /> Avisar por WhatsApp
              </a>
            )}
          </div>
          {waiting && <p className="mt-2 text-xs text-ink-3" role="status">{waiting.message}</p>}
          {result && <SharedChecklist readOnly={result.readOnly} assets={result.assets} busy={recheck.isPending} onRecheck={() => recheck.mutate()} />}
        </Step>
      </ol>

      <div className="mt-5 border-t-2 border-line pt-4 text-sm">
        <p className="font-semibold">¿Otra persona administra tu Meta?</p>
        <p className="mt-0.5 text-ink-2">Mándale los pasos con nuestro ID y, cuando te diga que listo, toca «Ya la compartí».</p>
        <a className="mt-2 inline-flex items-center gap-2 border-2 border-ink px-3 py-1.5 text-xs font-semibold" href={`https://wa.me/?text=${encodeURIComponent(adminInstructions(info.businessId))}`} target="_blank" rel="noreferrer">
          <MessageCircle size={13} /> Mandarle las instrucciones
        </a>
      </div>

      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-semibold">Si algo no sale</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-2">
          <li><b>No aparece «Asignar socio»:</b> tu usuario no es administrador del portafolio. Pídele a quien lo es que lo haga (botón de arriba).</li>
          <li><b>No encuentro la cuenta en Cuentas publicitarias:</b> está en tu Facebook personal y no en el portafolio; agrégala primero al portafolio.</li>
          <li><b>Quedó «Solo lectura»:</b> la compartiste sin control total. Repite el paso 3 y activa «Control total».</li>
          <li><b>No veo «Cuentas de Instagram» o «Conjuntos de datos»:</b> tu Instagram o tu píxel no están en el portafolio. Agrégalos primero (botón «Agregar» en esa misma pantalla) o vincula el Instagram a tu página.</li>
          <li><b>Ya la había conectado antes:</b> comparte lo que falte y toca «Ya la compartí» otra vez para revisar todo.</li>
          <li><b>Pasan los minutos y no la vemos:</b> revisa que el número de la cuenta y el ID que pegaste sean exactos.</li>
        </ul>
      </details>
    </div>
  );
}
