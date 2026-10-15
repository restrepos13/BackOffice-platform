import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { getToken } from '../lib/api';
import type { AiModel } from '../lib/types';
import { api } from '../lib/api';
import { Select } from './ui';
import { clsx } from 'clsx';

/**
 * Imagen de la galería servida por endpoint autenticado:
 * se descarga con el JWT en el header (nunca token en la URL) y se
 * muestra vía object URL.
 */
export function MediaImage({
  id,
  alt,
  className,
  path,
}: {
  id: string;
  alt: string;
  className?: string;
  /** Endpoint autenticado alternativo (p. ej. foto de producto) */
  path?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(path ? `/api${path}` : `/api/media/${id}/file`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, path]);

  if (failed) {
    return (
      <div className={clsx('flex items-center justify-center bg-bone-2 text-xs text-ink-3', className)}>
        Sin acceso
      </div>
    );
  }
  if (!src) {
    return <div className={clsx('animate-pulse bg-bone-2', className)} aria-label={alt} />;
  }
  return <img src={src} alt={alt} className={clsx('object-cover', className)} />;
}

/**
 * Archivo adjunto de un mensaje de WhatsApp (audio/imagen/documento),
 * servido por endpoint autenticado y tenant-scoped.
 */
export function MessageFile({
  messageId,
  type,
  className,
}: {
  messageId: string;
  type: 'AUDIO' | 'IMAGE' | 'DOCUMENT';
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(`/api/conversations/messages/${messageId}/file`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [messageId]);

  if (failed) {
    return (
      <div className={clsx('flex items-center justify-center bg-bone-2 px-3 py-2 text-xs text-ink-3', className)}>
        Archivo no disponible
      </div>
    );
  }
  if (!src) {
    return <div className={clsx('h-10 animate-pulse bg-bone-2', className)} aria-label="Cargando archivo…" />;
  }
  if (type === 'AUDIO') {
    return <audio controls src={src} className={clsx('w-full max-w-[260px]', className)} />;
  }
  if (type === 'IMAGE') {
    return <img src={src} alt="Imagen recibida" className={clsx('max-h-56 border-2 border-ink object-cover', className)} />;
  }
  return (
    <a
      href={src}
      download
      className={clsx(
        'inline-block border-2 border-ink bg-bone px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] hover:bg-ink hover:text-bone',
        className,
      )}
    >
      Descargar documento
    </a>
  );
}

/** Catálogo de modelos DeepInfra (con costos declarados). */
export function useAiModels() {
  return useQuery({
    queryKey: ['ai-models'],
    queryFn: () => api.get<AiModel[]>('/ai-models'),
    staleTime: 60_000,
  });
}

export const fmtPerM = (n: number) =>
  `$${n < 1 ? n.toFixed(2).replace(/0$/, '') : n.toFixed(2)}/M`;

/** Select de modelo IA alimentado por el catálogo (muestra costo por M tokens). */
export function ModelSelect({
  value,
  onChange,
  allowInherit,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** agrega la opción "Heredar del bot" (para líneas) */
  allowInherit?: boolean;
  disabled?: boolean;
}) {
  const { data: models } = useAiModels();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
      {allowInherit && <option value="">Heredar del bot</option>}
      {models?.filter((m) => m.active).map((m) => (
        <option key={m.id} value={m.modelId}>
          {m.name} · in {fmtPerM(m.inputCostPerMTok)} / out {fmtPerM(m.outputCostPerMTok)}
          {m.recommended ? ' ★' : ''}
        </option>
      ))}
      {/* si el valor actual no está en el catálogo, no perderlo */}
      {value && !models?.some((m) => m.modelId === value) && (
        <option value={value}>{value}</option>
      )}
    </Select>
  );
}
