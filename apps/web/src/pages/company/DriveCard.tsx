import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge, Button, Card } from '../../components/ui';
import ScheduleCall from '../../components/ScheduleCall';
import { withScope } from './shared';

interface DriveStatus { available: boolean; connected: boolean; needsReconnect: boolean; email: string | null }
interface PickerAccess { accessToken: string; appId: string | null; developerKey: string | null }
type ImportResult = { results: Array<{ fileId: string; ok: boolean; duplicate?: boolean; error?: string }> };

const RESULT: Record<string, [string, 'success' | 'error' | 'info']> = {
  listo: ['Google Drive conectado. Elige las fotos y videos que quieres traer.', 'success'],
  cancelado: ['Cancelaste la conexión con Google.', 'info'],
  permisos: ['Google no dio permiso para abrir tus archivos. Intenta de nuevo y acepta el acceso.', 'error'],
  error: ['No se pudo conectar Google Drive. Intenta de nuevo.', 'error'],
};

const MEDIA = 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime';

declare global {
  interface Window { gapi?: any; google?: any }
}

let pickerReady: Promise<void> | null = null;
/** Carga el selector de archivos de Google una sola vez. */
function loadPicker(): Promise<void> {
  if (window.google?.picker) return Promise.resolve();
  pickerReady ??= new Promise<void>((resolve, reject) => {
    const fail = () => { pickerReady = null; reject(new Error('No se pudo abrir el selector de Google. Revisa tu conexión e intenta de nuevo.')); };
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.async = true;
    s.onload = () => window.gapi.load('picker', { callback: () => resolve(), onerror: fail });
    s.onerror = fail;
    document.head.appendChild(s);
  });
  return pickerReady;
}

/** Abre el selector de Google y devuelve los ids elegidos (vacío si se cierra sin elegir). */
async function pickFiles(access: PickerAccess): Promise<string[]> {
  await loadPicker();
  const { picker } = window.google;
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS).setMimeTypes(MEDIA).setIncludeFolders(true).setSelectFolderEnabled(false);
    let builder = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setMaxItems(20)
      .setOAuthToken(access.accessToken)
      .setLocale('es')
      .setTitle('Elige fotos y videos para tu biblioteca')
      .setCallback((data: any) => {
        if (data.action === picker.Action.PICKED) resolve((data.docs ?? []).map((d: any) => String(d.id)));
        else if (data.action === picker.Action.CANCEL) resolve([]);
      });
    if (access.appId) builder = builder.setAppId(access.appId);
    if (access.developerKey) builder = builder.setDeveloperKey(access.developerKey);
    builder.build().setVisible(true);
  });
}

/**
 * Google Drive de la empresa, dentro de la Biblioteca: se conecta una vez y
 * se eligen en el selector de Google las fotos y videos que quiere traer.
 * BackOffice solo ve esos archivos, nunca el resto del Drive, y no cambia ni
 * borra nada.
 */
export function DriveCard({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useQuery({ queryKey: ['drive', q], queryFn: () => api.get<DriveStatus>(withScope('/drive', q)) });
  useEffect(() => {
    const r = params.get('drive');
    if (!r || !RESULT[r]) return;
    const [msg, kind] = RESULT[r];
    (kind === 'success' ? toast.success : kind === 'error' ? toast.error : toast.info)(msg);
    params.delete('drive');
    setParams(params, { replace: true });
  }, [params, setParams]);
  const connect = useMutation({ mutationFn: () => api.post<{ url: string }>(withScope('/drive/connect', q)), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => toast.error(e instanceof Error ? e.message : 'Error') });
  const disconnect = useMutation({
    mutationFn: () => api.delete(withScope('/drive', q)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['drive'] }); toast.success('Drive desconectado. Lo que ya trajiste sigue en tu biblioteca.'); },
  });
  const bring = useMutation({
    mutationFn: async () => {
      const ids = await pickFiles(await api.post<PickerAccess>(withScope('/drive/picker', q)));
      return ids.length ? api.post<ImportResult>(withScope('/drive/import', q), { fileIds: ids }) : null;
    },
    onSuccess: (r) => {
      if (!r) return;
      queryClient.invalidateQueries({ queryKey: ['library'] });
      const ok = r.results.filter((x) => x.ok).length;
      if (ok) toast.success(`${ok} archivo(s) en tu biblioteca`);
      r.results.filter((x) => !x.ok).forEach((f) => toast.error(f.error ?? 'No se pudo traer un archivo'));
    },
    onError: (e) => { queryClient.invalidateQueries({ queryKey: ['drive'] }); toast.error(e instanceof Error ? e.message : 'Error'); },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <Card kicker="Tus fotos y videos" title="Google Drive" className="mb-6">
      {!s.available ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="max-w-xl text-ink-2">Pronto podrás traer de tu Google Drive las fotos de tu negocio sin descargarlas una por una.</p>
          <ScheduleCall q={q} topic="OTHER" label="Avísenme cuando esté" size="sm" variant="outline" />
        </div>
      ) : !s.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="max-w-xl text-ink-2">
            {s.needsReconnect ? 'Google retiró el permiso de BackOffice: vuelve a conectar tu Drive.' : 'Conecta tu Google Drive y elige las fotos y videos que quieres usar. BackOffice solo ve los archivos que tú eliges: nunca el resto de tu Drive, y nunca cambia ni borra nada.'}
          </p>
          {canWrite && <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}><FolderOpen size={14} /> {s.needsReconnect ? 'Reconectar Drive' : 'Conectar Google Drive'}</Button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>
            <Badge tone="ok">Conectado</Badge> {s.email && <span className="text-ink-3">{s.email}</span>}
            <span className="block text-ink-2">Imágenes (JPG, PNG, WEBP hasta 8 MB) y videos (MP4, MOV hasta 12 MB), hasta 20 a la vez.</span>
          </p>
          {canWrite && (
            <span className="flex flex-wrap gap-2">
              <Button size="sm" disabled={bring.isPending} onClick={() => bring.mutate()}>{bring.isPending ? 'Trayendo…' : 'Elegir de Drive'}</Button>
              <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Desconectar</Button>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
