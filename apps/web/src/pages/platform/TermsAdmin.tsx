import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Loading, Modal, PageHeader, Stat, Textarea } from '../../components/ui';
import { TermsBody } from '../../components/Terms';

/**
 * Términos y condiciones (equipo): editar el texto, ver cómo se ve y publicar.
 *  - "Guardar corrección": arreglos de redacción; nadie tiene que aceptar de nuevo.
 *  - "Publicar nueva versión": cambio importante; todos los administradores de
 *    empresas deben aceptarlo la próxima vez que entren.
 */

interface TermsAdminView {
  version: number;
  title: string;
  body: string;
  updatedAt: string;
  updatedBy: string;
  usersTotal: number;
  usersAccepted: number;
}

export default function TermsAdmin() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['terms-admin'], queryFn: () => api.get<TermsAdminView>('/platform/terms') });
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [confirmPublish, setConfirmPublish] = useState(false);
  useEffect(() => {
    if (data) {
      setTitle(data.title);
      setBody(data.body);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (newVersion: boolean) => api.put<TermsAdminView>('/platform/terms', { title, body, newVersion }),
    onSuccess: (r, newVersion) => {
      queryClient.setQueryData(['terms-admin'], r);
      toast.success(newVersion ? `Versión ${r.version} publicada: todos deberán aceptarla al entrar` : 'Corrección guardada');
      setConfirmPublish(false);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  if (isLoading || !data) return <Loading />;
  const dirty = title !== data.title || body !== data.body;
  const pending = (body.match(/\[[^\]]+\]/g) ?? []).length;

  return (
    <>
      <PageHeader kicker="Lo que aceptan tus clientes" title="Términos" accent="y condiciones" />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Stat label="Versión vigente" value={`v${data.version}`} hint={`Actualizada ${timeAgo(data.updatedAt)} por ${data.updatedBy}`} />
        <Stat label="Ya la aceptaron" value={`${data.usersAccepted} de ${data.usersTotal}`} hint="Administradores de empresas" />
        <Stat label="Datos por completar" value={pending} hint="Textos entre [corchetes]" tone={pending ? 'warn' : 'ok'} />
      </div>

      {pending > 0 && (
        <p className="mb-4 border-2 border-warn bg-warn-soft px-4 py-3 text-sm">
          El borrador tiene {pending} datos por completar entre [corchetes] (razón social, NIT, correo…). Revísalos con tu abogado antes de publicar.
        </p>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <Card kicker="Editar" title="Texto">
          <div className="space-y-4">
            <Field label="Título"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></Field>
            <Field label="Contenido" hint='Títulos con "## ", listas con "- ", negrita con **texto**. Deja una línea en blanco entre párrafos.'>
              <Textarea rows={28} className="font-mono !text-xs" value={body} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="outline" disabled={!dirty} onClick={() => { setTitle(data.title); setBody(data.body); }}>Descartar cambios</Button>
              <div className="flex gap-2">
                <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate(false)}>Guardar corrección</Button>
                <Button disabled={save.isPending} onClick={() => setConfirmPublish(true)}>Publicar nueva versión</Button>
              </div>
            </div>
          </div>
        </Card>
        <Card kicker="Así lo ve el cliente" title="Vista previa" actions={<Link to="/terminos" target="_blank" className="text-xs underline">Página pública</Link>}>
          <div className="max-h-[820px] overflow-y-auto pr-2">
            <h2 className="display mb-3 text-2xl">{title}</h2>
            <TermsBody body={body} />
          </div>
        </Card>
      </div>

      <Modal open={confirmPublish} onClose={() => setConfirmPublish(false)} kicker="Nueva versión" title={`¿Publicar la versión ${data.version + 1}?`}>
        <div className="space-y-4 text-sm">
          <p>Todos los administradores de empresas ({data.usersTotal}) tendrán que leer y aceptar los términos la próxima vez que entren a su panel.</p>
          <p className="text-ink-3">Úsalo solo para cambios importantes. Para arreglar redacción usa "Guardar corrección".</p>
          {pending > 0 && <p><Badge tone="warn">Atención</Badge> Todavía hay {pending} datos entre [corchetes] sin completar.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmPublish(false)}>Cancelar</Button>
            <Button disabled={save.isPending} onClick={() => save.mutate(true)}>{save.isPending ? 'Publicando…' : 'Publicar'}</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
