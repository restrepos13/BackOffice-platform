/**
 * Qué proveedor atiende cada llamada de IA de una empresa. Da igual cuál tenga:
 *  - Llave de DeepInfra (de la empresa o de BackOffice): Llama, Qwen, DeepSeek…
 *    tal cual, y la transcripción de audios.
 *  - Llave de OpenRouter (de la empresa, «sk-or-…», o la de BackOffice cuando
 *    no hay DeepInfra): TODO va por OpenRouter. Los modelos de DeepInfra se
 *    atienden con el modelo de OpenRouter configurado (OPENROUTER_MODEL; por
 *    defecto Claude Haiku 5.5, que además lee imágenes y sale más barato que
 *    Llama 3.3 70B allá). Los audios no se transcriben (OpenRouter no tiene Whisper).
 *  - Modelos premium (Claude, GPT…): siempre por OpenRouter; con la llave de
 *    OpenRouter de la empresa o con la de BackOffice, nunca con una de DeepInfra.
 */

/** Llave "virtual" de BackOffice cuando solo hay OpenRouter configurado. */
export const PLATFORM_OPENROUTER_KEY = '__backoffice_openrouter__';

export function isOpenRouterModel(modelId: string | null | undefined): boolean {
  return /^(anthropic|openai|x-ai)\//.test(String(modelId ?? ''));
}

export function openRouterKey(): string | null {
  return String(process.env.OPENROUTER_API_KEY ?? '').split(',').map((k) => k.trim()).find(Boolean) ?? null;
}

/** ¿La llave es de OpenRouter? (la de BackOffice o una de la empresa) */
export function isOpenRouterKey(key: string | null | undefined): boolean {
  return key === PLATFORM_OPENROUTER_KEY || /^sk-or-/.test(String(key ?? '').trim());
}

/** Modelo de OpenRouter para lo que no es un modelo de OpenRouter (Dev Tools → OPENROUTER_MODEL). */
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-haiku-5.5';

export function openRouterModelFor(modelId: string | null | undefined): string {
  if (isOpenRouterModel(modelId)) return String(modelId);
  const wanted = String(process.env.OPENROUTER_MODEL ?? '').trim();
  return /^[\w.-]+\/[\w.:-]+$/.test(wanted) ? wanted : DEFAULT_OPENROUTER_MODEL;
}
