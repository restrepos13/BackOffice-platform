/**
 * Capa común de proveedores publicitarios (Meta, Google, TikTok).
 * Cada plataforma tiene su adaptador; no se las fuerza a comportarse igual:
 * cada una declara qué operaciones soporta de verdad (capabilities).
 *
 * Clasificación de operaciones:
 *  - READ: solo lectura (cuentas, campañas, métricas).
 *  - WRITE: cambia recursos sin gastar (pausar, crear en PAUSA).
 *  - SPEND: puede consumir presupuesto del cliente (activar, subir presupuesto).
 *    Las SPEND siempre exigen confirmación explícita de una persona.
 */

export type ProviderKey = 'META' | 'GOOGLE' | 'TIKTOK';
export type AdLevel = 'CAMPAIGN' | 'ADSET' | 'AD';
export type OperationClass = 'READ' | 'WRITE' | 'SPEND';

export const OPERATIONS: Record<string, OperationClass> = {
  listAccounts: 'READ',
  fetchEntities: 'READ',
  fetchInsights: 'READ',
  pause: 'WRITE',
  createCampaignPaused: 'WRITE',
  resume: 'SPEND', // reanudar vuelve a gastar
  setBudget: 'SPEND',
};

export interface ProviderCapabilities {
  read: boolean;
  insights: boolean;
  pause: boolean;
  resume: boolean;
  createCampaign: boolean;
  setBudget: boolean;
  conversions: boolean;
}

export interface AccountRef {
  externalId: string;
  currency: string;
  timezone?: string | null;
}

export interface RemoteAccount {
  externalId: string;
  name: string;
  currency: string;
  timezone: string | null;
  active: boolean;
  /** Lo que el usuario del token puede hacer en la cuenta (Meta: MANAGE, ADVERTISE, ANALYZE…) */
  tasks?: string[];
}

export interface RemoteEntity {
  level: AdLevel;
  externalId: string;
  campaignExternalId: string | null;
  adsetExternalId: string | null;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  issues: string[];
  providerUpdatedAt: string | null;
  raw: Record<string, unknown>;
}

/** Fila diaria a nivel anuncio (las campañas se agregan sumando sus anuncios). */
export interface RemoteInsight {
  level: 'AD';
  externalId: string;
  campaignExternalId: string | null;
  adsetExternalId: string | null;
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  leads: number;
  conversations: number;
  purchases: number;
  purchaseValue: number;
  raw: Record<string, unknown>;
}

export interface CampaignDraft {
  name: string;
  /** Objetivo normalizado de BackOffice */
  objective: 'LEADS' | 'MESSAGES' | 'TRAFFIC' | 'SALES' | 'AWARENESS' | 'ENGAGEMENT';
}

/** INCOMPLETE = la plataforma devolvió más datos de los que se pudieron leer (o pidió un rango menor). */
export type ProviderErrorKind = 'AUTH' | 'PERMISSION' | 'RATE_LIMIT' | 'NOT_FOUND' | 'NOT_SUPPORTED' | 'NOT_CONFIGURED' | 'INCOMPLETE' | 'PROVIDER';

export class AdsProviderError extends Error {
  constructor(public readonly kind: ProviderErrorKind, message: string, public readonly providerCode?: number | string) {
    super(message);
  }
}

export interface AdsProvider {
  readonly key: ProviderKey;
  readonly label: string;
  /** true = datos simulados. Jamás se presentan como operaciones reales. */
  readonly demo: boolean;
  readonly capabilities: ProviderCapabilities;
  /** Qué falta configurar para operar en modo real (vacío = listo). */
  missingConfig(): string[];
  listAccounts(token: string): Promise<RemoteAccount[]>;
  fetchEntities(account: AccountRef, token: string): Promise<RemoteEntity[]>;
  fetchInsights(account: AccountRef, token: string, since: string, until: string): Promise<RemoteInsight[]>;
  setStatus(account: AccountRef, token: string, level: AdLevel, externalId: string, status: 'ACTIVE' | 'PAUSED'): Promise<Record<string, unknown>>;
  createCampaignPaused(account: AccountRef, token: string, draft: CampaignDraft): Promise<{ externalId: string; response: Record<string, unknown> }>;
  /**
   * Alcance (personas únicas) y frecuencia del periodo completo, por cuenta y
   * por campaña. Opcional: si el proveedor no lo da, no se muestran.
   */
  fetchPeriodStats?(account: AccountRef, token: string, since: string, until: string): Promise<PeriodStats>;
}

export interface PeriodStatRow { reach: number; impressions: number; frequency: number | null }
export interface PeriodStats { account: PeriodStatRow | null; campaigns: Array<PeriodStatRow & { externalId: string }> }

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

/** Monedas sin decimales en Meta (offset 1). El resto usa centavos (offset 100). */
const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);
export const currencyOffset = (currency: string) => (OFFSET_ONE.has(String(currency).toUpperCase()) ? 1 : 100);
export const fromMinor = (value: unknown, currency: string): number | null =>
  value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value) / currencyOffset(currency);
export const toMinor = (value: number, currency: string) => Math.round(value * currencyOffset(currency));

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3));
