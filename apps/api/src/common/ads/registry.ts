import { DemoAdsProvider } from './demo-provider';
import { MetaAdsProvider } from './meta-ads-provider';
import { AdsProvider, AdsProviderError, FetchLike, ProviderKey, RemoteAccount } from './provider';

/**
 * Google Ads y TikTok Ads: contrato listo, sin endpoints inventados.
 * Para habilitarlos hay que construir el adaptador real contra la API oficial
 * vigente cuando existan las credenciales (ver docs/creative-ads.md).
 */
class PendingProvider implements AdsProvider {
  readonly demo = false;
  readonly capabilities = { read: false, insights: false, pause: false, resume: false, createCampaign: false, setBudget: false, conversions: false };
  constructor(readonly key: ProviderKey, readonly label: string, private readonly needs: string[]) {}
  missingConfig() {
    return this.needs;
  }
  private no(): never {
    throw new AdsProviderError('NOT_CONFIGURED', `${this.label} todavía no está habilitado. Falta: ${this.needs.join('; ')}`);
  }
  async listAccounts(): Promise<RemoteAccount[]> { return this.no(); }
  async fetchEntities(): Promise<never> { return this.no(); }
  async fetchInsights(): Promise<never> { return this.no(); }
  async setStatus(): Promise<never> { return this.no(); }
  async createCampaignPaused(): Promise<never> { return this.no(); }
}

export const PROVIDER_KEYS: ProviderKey[] = ['META', 'GOOGLE', 'TIKTOK'];

export function providerFor(key: ProviderKey, mode: 'REAL' | 'DEMO', opts: { fetchImpl?: FetchLike; metaConfigured?: () => boolean } = {}): AdsProvider {
  if (mode === 'DEMO') return new DemoAdsProvider(key);
  if (key === 'META') return new MetaAdsProvider(opts.fetchImpl, opts.metaConfigured);
  if (key === 'GOOGLE') return new PendingProvider('GOOGLE', 'Google Ads', [
    'Developer token de Google Ads aprobado (GOOGLE_ADS_DEVELOPER_TOKEN)',
    'Cliente OAuth de Google Cloud con el alcance de Google Ads (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET)',
    'ID de la cuenta administradora (MCC) si se opera a través de una',
    'Adaptador real (GAQL para reportes; mutate para pausar)',
  ]);
  return new PendingProvider('TIKTOK', 'TikTok Ads', [
    'App aprobada en TikTok for Business Developers con acceso a la Marketing API (TIKTOK_APP_ID / TIKTOK_APP_SECRET)',
    'Autorización del anunciante (advertiser_id) por OAuth',
    'Adaptador real (reportes integrados; actualización de estado)',
  ]);
}
