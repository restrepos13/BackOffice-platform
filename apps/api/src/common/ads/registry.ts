import { DemoAdsProvider } from './demo-provider';
import { MetaAdsProvider } from './meta-ads-provider';
import { AdsProvider, FetchLike, ProviderKey } from './provider';
import { GoogleAdsConfig, GoogleAdsProvider } from './google-ads-provider';
import { TikTokAdsConfig, TikTokAdsProvider } from './tiktok-ads-provider';

export const PROVIDER_KEYS: ProviderKey[] = ['META', 'GOOGLE', 'TIKTOK'];

export function providerFor(
  key: ProviderKey,
  mode: 'REAL' | 'DEMO',
  opts: { fetchImpl?: FetchLike; metaConfigured?: () => boolean; google?: () => Promise<GoogleAdsConfig | null>; tiktok?: () => Promise<TikTokAdsConfig | null> } = {},
): AdsProvider {
  if (mode === 'DEMO') return new DemoAdsProvider(key);
  if (key === 'META') return new MetaAdsProvider(opts.fetchImpl, opts.metaConfigured);
  if (key === 'GOOGLE') return new GoogleAdsProvider(opts.google ?? (async () => null), opts.fetchImpl);
  return new TikTokAdsProvider(opts.tiktok ?? (async () => null), opts.fetchImpl);
}
