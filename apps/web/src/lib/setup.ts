import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * Perfil de incorporación (espejo de apps/api/src/common/setup-profile.ts).
 * El servidor valida y recalcula todo: aquí solo se edita y se muestra.
 */

export type ProductKey = 'AUTOMATION' | 'CREATIVE' | 'ADS';
export type Complexity = 'SIMPLE' | 'INTERMEDIATE' | 'COMPLEX';
export type CapabilityStatus = 'AVAILABLE' | 'PARTIAL' | 'PLANNED';

export interface SetupProfile {
  version: number;
  source: 'SELF_SERVICE' | 'ASSISTED';
  business: { profileKey: string; label: string; activity: string };
  answers: {
    offer: string;
    intake: string[];
    manualTasks: string[];
    timeConsuming: string[];
    needs: string[];
    automate: string[];
    humanApproval: string[];
    wantsContent: boolean | null;
    wantsAds: boolean | null;
    integrations: string[];
  };
  signals: { stages: number | null; people: number | null; areas: string[]; dailyVolume: number | null };
  complexity: {
    level: Complexity;
    computed: Complexity;
    score: number;
    reasons: string[];
    override: { level: Complexity; reason: string; by: string | null } | null;
  };
  products: { selected: ProductKey[]; recommended: ProductKey[]; reasons: Partial<Record<ProductKey, string[]>> };
  capabilities: Array<{ key: string; label: string; product: ProductKey; status: CapabilityStatus; note: string; included: boolean; why: string }>;
  agentCallId: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SetupCatalog {
  profiles: Array<{ key: string; label: string }>;
  needs: Array<{ key: string; label: string }>;
  intake: string[];
  complexity: Array<{ key: Complexity; label: string }>;
  products: Array<{ key: ProductKey; name: string; short: string; summary: string }>;
}

export const COMPLEXITY_LABEL: Record<Complexity, string> = { SIMPLE: 'Simple', INTERMEDIATE: 'Intermedia', COMPLEX: 'Compleja' };
export const STATUS_LABEL: Record<CapabilityStatus, string> = { AVAILABLE: 'Disponible', PARTIAL: 'En parte', PLANNED: 'Próxima fase' };

export function useSetupCatalog() {
  return useQuery({ queryKey: ['setup-catalog'], queryFn: () => api.get<SetupCatalog>('/public/setup/catalog'), staleTime: Infinity });
}

/**
 * Lo calculado por el servidor reemplaza lo calculado en pantalla, sin pisar
 * lo que la persona está escribiendo (respuestas, actividad, productos y ajuste).
 */
export function mergeEvaluated(local: SetupProfile, server: SetupProfile): SetupProfile {
  return {
    ...local,
    // Lo que el servidor descarta (p. ej. «cuaderno» no es un sistema) también sale de la pantalla
    answers: { ...local.answers, integrations: server.answers.integrations },
    business: { ...local.business, label: server.business.label },
    complexity: { ...server.complexity, override: local.complexity.override, level: local.complexity.override?.level ?? server.complexity.computed },
    products: { ...server.products, selected: local.products.selected },
    capabilities: server.capabilities.map((c) => ({ ...c, included: local.products.selected.includes(c.product) })),
  };
}
