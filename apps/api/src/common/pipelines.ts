/**
 * Embudos de venta configurables. Si la empresa no crea ninguno se usa el
 * embudo estándar (CURIOSO → POTENCIAL → CALIENTE → CLIENTE / DESCARTADO).
 */

export interface PipelineStage {
  key: string;
  label: string;
  kind: 'OPEN' | 'WON' | 'LOST';
}

export const DEFAULT_STAGES: PipelineStage[] = [
  { key: 'CURIOSO', label: 'Curioso', kind: 'OPEN' },
  { key: 'POTENCIAL', label: 'Potencial', kind: 'OPEN' },
  { key: 'CALIENTE', label: 'Caliente', kind: 'OPEN' },
  { key: 'CLIENTE', label: 'Cliente', kind: 'WON' },
  { key: 'DESCARTADO', label: 'Descartado', kind: 'LOST' },
];

export function stageKey(label: string): string {
  return label
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
    .slice(0, 30);
}

/** Valida las etapas que llegan del panel: 2 a 12, claves únicas, al menos una abierta. */
export function sanitizeStages(raw: unknown): PipelineStage[] {
  if (!Array.isArray(raw)) throw new Error('Las etapas deben ser una lista');
  const seen = new Set<string>();
  const stages: PipelineStage[] = [];
  for (const item of raw as any[]) {
    const label = String(item?.label ?? '').trim().slice(0, 40);
    if (!label) continue;
    const key = stageKey(item?.key || label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    stages.push({ key, label, kind: item?.kind === 'WON' || item?.kind === 'LOST' ? item.kind : 'OPEN' });
  }
  if (stages.length < 2 || stages.length > 12) throw new Error('Un embudo tiene entre 2 y 12 etapas');
  if (!stages.some((s) => s.kind === 'OPEN')) throw new Error('Al menos una etapa debe estar abierta');
  return stages;
}
