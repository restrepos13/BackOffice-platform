/**
 * Qué proveedor atiende cada modelo del asistente:
 *  - DeepInfra (por defecto): Llama, Qwen, DeepSeek… con la llave del cliente
 *    (BYOK) o la de BackOffice.
 *  - OpenRouter: modelos premium (Claude Haiku). Solo con la IA de BackOffice
 *    (paquetes): la llave del cliente es de DeepInfra y no sirve para estos.
 */

/** Llave "virtual" de BackOffice cuando solo hay OpenRouter configurado. */
export const PLATFORM_OPENROUTER_KEY = '__backoffice_openrouter__';

export function isOpenRouterModel(modelId: string | null | undefined): boolean {
  return /^(anthropic|openai|x-ai)\//.test(String(modelId ?? ''));
}

export function openRouterKey(): string | null {
  return String(process.env.OPENROUTER_API_KEY ?? '').split(',').map((k) => k.trim()).find(Boolean) ?? null;
}
