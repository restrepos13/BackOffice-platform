import { useMutation } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { downloadPdf } from '../lib/api';
import { withScope } from '../pages/company/shared';
import SetupProgress from './SetupProgress';
import { Button } from './ui';

/**
 * "Descarga tus datos": la información de la empresa sale SOLO en PDF, con su
 * marca. El administrador toca las secciones que quiere y descarga.
 */

const SECTIONS: Array<{ key: string; label: string }> = [
  { key: 'contactos', label: 'Contactos' },
  { key: 'conversaciones', label: 'Conversaciones' },
  { key: 'pedidos', label: 'Pedidos' },
  { key: 'cobranza', label: 'Cuentas por cobrar' },
  { key: 'productos', label: 'Catálogo' },
  { key: 'equipo', label: 'Equipo' },
  { key: 'facturas', label: 'Facturas de BackOffice' },
];

export default function DataExport({ q, only }: { q: string; only?: string[] }) {
  const options = only ? SECTIONS.filter((s) => only.includes(s.key)) : SECTIONS;
  const [picked, setPicked] = useState<string[]>(options.map((s) => s.key));
  const download = useMutation({
    mutationFn: () => downloadPdf(withScope(`/company/data-export/pdf?sections=${picked.join(',')}`, q), 'mis-datos.pdf'),
    onSuccess: () => toast.success('Tu PDF se descargó'),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo generar'),
  });
  return (
    <div className="space-y-3 text-sm">
      {options.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {options.map((s) => {
            const on = picked.includes(s.key);
            return (
              <button key={s.key} type="button" aria-pressed={on}
                onClick={() => setPicked((x) => (on ? x.filter((k) => k !== s.key) : [...x, s.key]))}
                className={clsx('cursor-pointer border-2 px-2.5 py-1 text-xs', on ? 'border-ink bg-ink text-bone' : 'border-line hover:border-ink')}>
                {on && <Check size={11} className="mr-1 inline" />}{s.label}
              </button>
            );
          })}
        </div>
      )}
      {download.isPending ? (
        <SetupProgress title="Preparando tu PDF" steps={['Reuniendo tu información', 'Ordenando las tablas', 'Poniéndole tu marca']} running expectedMs={6000} />
      ) : (
        <Button disabled={!picked.length} onClick={() => download.mutate()}><Download size={14} /> Descargar en PDF</Button>
      )}
      <p className="text-xs text-ink-3">Tus datos son tuyos. Por seguridad se descargan solo en PDF y queda registro de quién los descargó.</p>
    </div>
  );
}
