import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, getToken } from '../../lib/api';
import { fmtUsd, timeAgo } from '../../lib/format';
import type { Integration, MediaAsset } from '../../lib/types';
import {
  Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader,
  Select, Switch,
} from '../../components/ui';
import { MediaImage } from '../../components/media';
import { PickCompany, useCompanyScope, withScope } from './shared';

export default function Media() {
  const { ready, q, canWrite, companyId } = useCompanyScope();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    name: '', priceUsd: '', tags: '', integrationId: '',
  });
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<MediaAsset | null>(null);

  const { data: assets, isLoading } = useQuery({
    queryKey: ['media', q],
    queryFn: () => api.get<MediaAsset[]>(withScope('/media', q)),
    enabled: ready,
  });
  const { data: lines } = useQuery({
    queryKey: ['integrations', q],
    queryFn: () => api.get<Integration[]>(withScope('/integrations', q)),
    enabled: ready,
    select: (items) => items.filter((i) => i.type === 'WHATSAPP'),
  });

  async function doUpload() {
    if (!pendingFile) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', pendingFile);
      form.append('name', uploadForm.name || pendingFile.name);
      if (uploadForm.priceUsd) form.append('priceUsd', uploadForm.priceUsd);
      if (uploadForm.tags) form.append('tags', uploadForm.tags);
      if (uploadForm.integrationId) form.append('integrationId', uploadForm.integrationId);
      if (companyId) form.append('companyId', companyId);
      const res = await fetch('/api/media', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? 'Error al subir');
      queryClient.invalidateQueries({ queryKey: ['media'] });
      toast.success('Imagen cargada — la IA ya puede enviarla');
      setPendingFile(null);
      setUploadForm({ name: '', priceUsd: '', tags: '', integrationId: '' });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al subir');
    } finally {
      setUploading(false);
    }
  }

  const update = useMutation({
    mutationFn: (patch: { id: string } & Record<string, unknown>) => {
      const { id, ...body } = patch;
      return api.patch(`/media/${id}`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] });
      setEditing(null);
      toast.success('Actualizada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/media/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['media'] });
      setEditing(null);
      toast.success('Eliminada');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (!ready) return <PickCompany />;
  if (isLoading) return <Loading />;

  return (
    <>
      <PageHeader
        kicker="Contenido que envía tu IA"
        title="Galería"
        actions={
          canWrite ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setPendingFile(file);
                  e.target.value = '';
                }}
              />
              <Button onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Cargar imagen
              </Button>
            </>
          ) : undefined
        }
      />

      <p className="mb-6 max-w-2xl text-sm text-ink-2">
        Cargas aquí las fotos y la IA (o un agente) las envía en las
        conversaciones. Si le pones precio, es contenido de pago: la IA lo
        ofrece según sus reglas de venta. Puedes asignar cada imagen a una
        línea concreta o dejarla disponible para todas.
      </p>

      {assets?.length === 0 ? (
        <EmptyState
          title="Galería vacía"
          hint="Carga la primera imagen (JPG, PNG, WebP o GIF · máx. 10 MB)."
          action={canWrite ? <Button onClick={() => fileRef.current?.click()}>Cargar imagen</Button> : undefined}
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {assets?.map((asset) => (
            <div key={asset.id} className="border-2 border-ink bg-paper">
              <MediaImage id={asset.id} alt={asset.name} className="h-40 w-full border-b-2 border-ink" />
              <div className="p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-semibold" title={asset.name}>{asset.name}</p>
                  {asset.priceUsd > 0 ? (
                    <Badge tone="ink">{fmtUsd(asset.priceUsd)}</Badge>
                  ) : (
                    <Badge tone="ok">Gratis</Badge>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-ink-3">
                  {asset.integration?.name ?? 'Todas las líneas'} · enviada {asset.timesSent}×
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {asset.tags.map((tag) => <Badge key={tag}>{tag}</Badge>)}
                  {!asset.active && <Badge tone="bad">Inactiva</Badge>}
                </div>
                {canWrite && (
                  <Button size="sm" variant="outline" className="mt-2 w-full" onClick={() => setEditing(asset)}>
                    Editar
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Subida */}
      <Modal
        open={!!pendingFile}
        onClose={() => setPendingFile(null)}
        kicker={pendingFile ? `${(pendingFile.size / 1024 / 1024).toFixed(1)} MB` : ''}
        title="Cargar imagen"
      >
        <div className="space-y-4">
          <Field label="Nombre">
            <Input
              value={uploadForm.name}
              placeholder={pendingFile?.name}
              onChange={(e) => setUploadForm({ ...uploadForm, name: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Precio (USD)" hint="0 = gratis">
              <Input
                type="number" min={0} step={1}
                value={uploadForm.priceUsd}
                onChange={(e) => setUploadForm({ ...uploadForm, priceUsd: e.target.value })}
              />
            </Field>
            <Field label="Línea" hint="Vacío = todas">
              <Select
                value={uploadForm.integrationId}
                onChange={(e) => setUploadForm({ ...uploadForm, integrationId: e.target.value })}
              >
                <option value="">Todas las líneas</option>
                {lines?.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Etiquetas" hint="Separadas por coma: ppv, set, vip…">
            <Input value={uploadForm.tags} onChange={(e) => setUploadForm({ ...uploadForm, tags: e.target.value })} />
          </Field>
          <Button className="w-full" disabled={uploading} onClick={doUpload}>
            {uploading ? 'Subiendo…' : 'Cargar a la galería'}
          </Button>
        </div>
      </Modal>

      {/* Edición */}
      <Modal open={!!editing} onClose={() => setEditing(null)} kicker="Galería" title={editing?.name ?? ''}>
        {editing && (
          <div className="space-y-4">
            <MediaImage id={editing.id} alt={editing.name} className="h-48 w-full border-2 border-ink" />
            <Field label="Nombre">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Precio (USD)">
                <Input
                  type="number" min={0} step={1}
                  value={editing.priceUsd}
                  onChange={(e) => setEditing({ ...editing, priceUsd: Number(e.target.value) })}
                />
              </Field>
              <Field label="Línea">
                <Select
                  value={editing.integrationId ?? ''}
                  onChange={(e) => setEditing({ ...editing, integrationId: e.target.value || null })}
                >
                  <option value="">Todas las líneas</option>
                  {lines?.map((line) => <option key={line.id} value={line.id}>{line.name}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex items-center justify-between border-2 border-line bg-bone px-3 py-2">
              <p className="text-sm">La IA puede enviarla</p>
              <Switch
                checked={editing.active}
                onChange={(v) => setEditing({ ...editing, active: v })}
                label="Activa"
              />
            </div>
            <div className="flex gap-2">
              <Button
                className="flex-1"
                disabled={update.isPending}
                onClick={() =>
                  update.mutate({
                    id: editing.id, name: editing.name,
                    priceUsd: editing.priceUsd,
                    integrationId: editing.integrationId ?? '',
                    active: editing.active,
                  })
                }
              >
                Guardar
              </Button>
              <Button variant="danger" onClick={() => remove.mutate(editing.id)}>
                Eliminar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
