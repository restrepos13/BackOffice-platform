import type { DesignDoc, FormatKey } from '../design-doc';
import type { Content, Family } from './compose';
import type { Issue } from './quality';

/**
 * Contratos para IA futura en la dirección de arte. NINGUNO ESTÁ
 * IMPLEMENTADO NI CONECTADO: el sistema funciona completo con el motor
 * determinista, los recursos de la empresa y el editor.
 *
 * Reglas para cuando se implementen:
 *  - Cada llamada pasa por el libro de créditos (ver ai/creative-assist.ts:
 *    reservar → consumir o liberar, con clave idempotente).
 *  - Las salidas se validan antes de usarse: un recurso generado se guarda
 *    como BrandAsset de la empresa; un documento propuesto pasa por
 *    validateDesignDoc y checkQuality como cualquier otro.
 *  - Solo reciben datos de la empresa que pide (nunca de otras).
 *  - No pueden saltarse la confirmación de la persona ni publicar.
 */

/** Generar un recurso visual (fondo, ilustración) a partir de una descripción. */
export interface VisualAssetGenerator {
  generate(input: { companyId: string; prompt: string; width: number; height: number; style: string[] }): Promise<{ bytes: Buffer; mime: 'image/png' | 'image/jpeg' } | null>;
}

/** Elegir o recortar la mejor foto propia para una zona de la composición. */
export interface PhotoSelector {
  pick(input: { companyId: string; candidates: Array<{ assetId: string; width: number; height: number }>; zone: { width: number; height: number }; goal: string }): Promise<{ assetId: string; crop?: { x: number; y: number; width: number; height: number } } | null>;
}

/** Evaluación visual (complementa el control determinista; nunca lo reemplaza). */
export interface CompositionEvaluator {
  evaluate(input: { doc: DesignDoc; renderedPng: Buffer }): Promise<Array<Pick<Issue, 'code' | 'message'> & { severity: 'INFO' | 'WARN'; kind: 'HEURISTIC' }>>;
}

/** Proponer variantes de texto para un contenido, respetando la marca. */
export interface VariantProposer {
  variants(input: { companyId: string; content: Content; tone: string; avoidWords: string[]; count: number }): Promise<Content[]>;
}

/** Recomendar direcciones a partir de resultados REALES vinculados de forma fiable. */
export interface PerformanceAdvisor {
  advise(input: { companyId: string; format: FormatKey; history: Array<{ family: Family; exports: number; inCampaign: number; linkedResults?: { impressions: number; clicks: number } }> }): Promise<{ prefer: Family[]; why: string } | null>;
}

/** Hoy no hay proveedores configurados: todo devuelve null. */
export const AI_HOOKS: {
  generator: VisualAssetGenerator | null;
  photoSelector: PhotoSelector | null;
  evaluator: CompositionEvaluator | null;
  variants: VariantProposer | null;
  advisor: PerformanceAdvisor | null;
} = { generator: null, photoSelector: null, evaluator: null, variants: null, advisor: null };
