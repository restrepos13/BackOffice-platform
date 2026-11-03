import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Folder, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { Badge, Button, Card, Modal } from '../../components/ui';
import ScheduleCall from '../../components/ScheduleCall';
import { withScope } from './shared';

interface DriveStatus { available: boolean; connected: boolean; needsReconnect: boolean; email: string | null; folder: { id: string; name: string } | null }
interface DriveFile { id: string; name: string; mimeType: string; size: number | null; imported: boolean }

const RESULT: Record<string, [string, 'success' | 'error' | 'info']> = {
  elegir: ['Google Drive conectado. Elige la carpeta donde tienes tus fotos.', 'success'],
  cancelado: ['Cancelaste la conexión con Google.', 'info'],
  permisos: ['Google no dio permiso para ver tus archivos. Intenta de nuevo y acepta el acceso.', 'error'],
  error: ['No se pudo conectar Google Drive. Intenta de nuevo.', 'error'],
};

/**
 * La carpeta de Google Drive de la empresa, dentro de la Biblioteca: se
 * conecta una vez (solo lectura), se elige la carpeta y se traen las fotos y
 * videos que quiera usar. BackOffice nunca cambia ni borra nada en Drive.
 */
export function DriveCard({ q, canWrite }: { q: string; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const status = useQuery({ queryKey: ['drive', q], queryFn: () => api.get<DriveStatus>(withScope('/drive', q)) });
  const [picking, setPicking] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  useEffect(() => {
    const r = params.get('drive');
    if (!r || !RESULT[r]) return;
    const [msg, kind] = RESULT[r];
    (kind === 'success' ? toast.success : kind === 'error' ? toast.error : toast.info)(msg);
    if (r === 'elegir') setPicking(true);
    params.delete('drive');
    setParams(params, { replace: true });
  }, [params, setParams]);
  const connect = useMutation({ mutationFn: () => api.post<{ url: string }>(withScope('/drive/connect', q)), onSuccess: (r) => { window.location.href = r.url; }, onError: (e) => toast.error(e instanceof Error ? e.message : 'Error') });
  const disconnect = useMutation({
    mutationFn: () => api.delete(withScope('/drive', q)),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['drive'] }); toast.success('Drive desconectado. Lo que ya trajiste sigue en tu biblioteca.'); },
  });
  const s = status.data;
  if (!s) return null;
  return (
    <Card kicker="Tu carpeta de fotos" title="Google Drive" className="mb-6">
      {!s.available ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="max-w-xl text-ink-2">Pronto podrás conectar la carpeta de Google Drive donde tienes las fotos de tu negocio y traerlas aquí sin descargarlas una por una.</p>
          <ScheduleCall q={q} topic="OTHER" label="Avísenme cuando esté" size="sm" variant="outline" />
        </div>
      ) : !s.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p className="max-w-xl text-ink-2">
            {s.needsReconnect ? 'Google retiró el permiso de BackOffice: vuelve a conectar tu Drive.' : 'Conecta tu Google Drive y elige la carpeta donde tienes las fotos y videos de tu negocio. BackOffice solo puede verlos: nunca cambia ni borra nada en tu Drive.'}
          </p>
          {canWrite && <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}><FolderOpen size={14} /> {s.needsReconnect ? 'Reconectar Drive' : 'Conectar Google Drive'}</Button>}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <p>
            <Badge tone="ok">Conectado</Badge> {s.email && <span className="text-ink-3">{s.email}</span>}
            <span className="block text-ink-2">{s.folder ? <>Carpeta: <b>{s.folder.name}</b></> : 'Falta elegir la carpeta.'}</span>
          </p>
          {canWrite && (
            <span className="flex flex-wrap gap-2">
              {s.folder && <Button size="sm" onClick={() => setBrowsing(true)}>Traer fotos de Drive</Button>}
              <Button size="sm" variant="outline" onClick={() => setPicking(true)}>{s.folder ? 'Cambiar carpeta' : 'Elegir carpeta'}</Button>
              <Button size="sm" variant="ghost" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Desconectar</Button>
            </span>
          )}
        </div>
      )}
      {picking && <FolderPicker q={q} onClose={() => setPicking(false)} />}
      {browsing && <DriveFiles q={q} onClose={() => setBrowsing(false)} />}
    </Card>
  );
}

function FolderPicker({ q, onClose }: { q: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [path, setPath] = useState<Array<{ id: string; name: string }>>([{ id: 'root', name: 'Mi unidad' }]);
  const current = path[path.length - 1];
  const list = useQuery({ queryKey: ['drive-folders', q, current.id], queryFn: () => api.get<{ folders: Array<{ id: string; name: string }> }>(withScope(`/drive/folders?parent=${encodeURIComponent(current.id)}`, q)) });
  const choose = useMutation({
    mutationFn: (f: { id: string; name: string }) => api.post(withScope('/drive/folder', q), { folderId: f.id, folderName: f.name }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['drive'] }); toast.success('Carpeta elegida'); onClose(); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open onClose={onClose} kicker="Google Drive" title="Elige la carpeta de tus fotos">
      <p className="mb-2 text-xs text-ink-3">{path.map((p) => p.name).join(' / ')}</p>
      {list.isLoading ? <p className="text-sm text-ink-3">Cargando carpetas…</p> : list.error ? <p className="text-sm text-bad">{list.error instanceof Error ? list.error.message : 'Error'}</p> : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto border-2 border-line text-sm">
          {path.length > 1 && <li><button type="button" className="w-full cursor-pointer px-3 py-2 text-left text-ink-3 hover:bg-bone-2" onClick={() => setPath(path.slice(0, -1))}>← Volver</button></li>}
          {(list.data?.folders ?? []).map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline" onClick={() => setPath([...path, f])}><Folder size={14} className="mr-1 inline" />{f.name}</button>
              <Button size="sm" variant="outline" disabled={choose.isPending} onClick={() => choose.mutate(f)}>Usar esta</Button>
            </li>
          ))}
          {!list.data?.folders.length && <li className="px-3 py-2 text-ink-3">No hay carpetas aquí.</li>}
        </ul>
      )}
      {current.id !== 'root' && <Button className="mt-3 w-full" disabled={choose.isPending} onClick={() => choose.mutate(current)}>Usar «{current.name}»</Button>}
    </Modal>
  );
}

function DriveFiles({ q, onClose }: { q: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ['drive-files', q], queryFn: () => api.get<{ folder: { name: string } | null; files: DriveFile[] }>(withScope('/drive/files', q)) });
  const [chosen, setChosen] = useState<string[]>([]);
  const bring = useMutation({
    mutationFn: () => api.post<{ results: Array<{ fileId: string; ok: boolean; duplicate?: boolean; error?: string }> }>(withScope('/drive/import', q), { fileIds: chosen }),
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      queryClient.invalidateQueries({ queryKey: ['drive-files'] });
      const ok = r.results.filter((x) => x.ok).length;
      const failed = r.results.filter((x) => !x.ok);
      if (ok) toast.success(`${ok} archivo(s) en tu biblioteca`);
      failed.forEach((f) => toast.error(f.error ?? 'No se pudo traer un archivo'));
      if (!failed.length) onClose();
      setChosen([]);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open onClose={onClose} kicker="Google Drive" title={`Traer de «${list.data?.folder?.name ?? 'tu carpeta'}»`}>
      {list.isLoading ? <p className="text-sm text-ink-3">Leyendo tu carpeta…</p> : list.error ? <p className="text-sm text-bad">{list.error instanceof Error ? list.error.message : 'Error'}</p> : (
        <>
          <p className="mb-2 text-xs text-ink-3">Imágenes (JPG, PNG, WEBP hasta 8 MB) y videos (MP4, MOV hasta 12 MB). Elige hasta 20 a la vez.</p>
          <ul className="max-h-80 divide-y divide-line overflow-y-auto border-2 border-line text-sm">
            {(list.data?.files ?? []).map((f) => (
              <li key={f.id} className="flex items-center gap-2 px-3 py-2">
                <input type="checkbox" aria-label={f.name} disabled={f.imported} checked={chosen.includes(f.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, f.id].slice(0, 20) : c.filter((x) => x !== f.id)))} />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {f.imported ? <Badge tone="ok">Ya está</Badge> : <span className="text-xs text-ink-3">{f.mimeType.startsWith('video/') ? 'Video' : 'Imagen'}{f.size ? ` · ${(f.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>}
              </li>
            ))}
            {!list.data?.files.length && <li className="px-3 py-2 text-ink-3">Esta carpeta no tiene imágenes ni videos.</li>}
          </ul>
          <Button className="mt-3 w-full" disabled={!chosen.length || bring.isPending} onClick={() => bring.mutate()}>{bring.isPending ? 'Trayendo…' : `Traer ${chosen.length || ''} a la biblioteca`}</Button>
        </>
      )}
    </Modal>
  );
}
