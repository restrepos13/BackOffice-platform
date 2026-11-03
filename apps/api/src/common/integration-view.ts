import { parseJson } from './constants';

/**
 * Vista pública de una integración: los secretos (ni en claro ni cifrados) y el
 * configJson crudo nunca salen del API. La usan Integraciones, el detalle del
 * asistente y la ficha de la empresa.
 */
export function integrationView(i: any) {
  const { configJson: _raw, ...row } = i;
  const {
    authTokenEnc,
    authToken: _plain,
    authTokenEncrypted: _legacy,
    accessTokenEnc,
    accessToken: _metaPlain,
    refreshTokenEnc: _refresh,
    ...config
  } = parseJson<Record<string, any>>(i.configJson, {});
  return {
    ...row,
    config: { ...config, twilioConfigured: !!authTokenEnc, metaConfigured: !!accessTokenEnc },
    overridePersonality: parseJson<Record<string, string>>(i.overridePersonalityJson, {}),
    overrideSales: parseJson<Record<string, string>>(i.overrideSalesJson, {}),
  };
}
