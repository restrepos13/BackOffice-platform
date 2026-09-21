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
}: {
  id: string;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    fetch(`/api/media/${id}/file`, {
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
  }, [id]);

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
