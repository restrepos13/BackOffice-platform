import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import {
  AiChatOptions,
  AiChatResult,
  AiProvider,
  AiTranscribeOptions,
} from './types';
import { PLATFORM_OPENROUTER_KEY, isOpenRouterKey, isOpenRouterModel, openRouterKey, openRouterModelFor } from './model-routing';

const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TRANSCRIBE_URL = 'https://api.deepinfra.com/v1/openai/audio/transcriptions';
const WHISPER_MODEL = 'openai/whisper-large-v3-turbo';

/** Error del proveedor con su código HTTP (401/402/403 = llave rechazada o sin saldo). */
export class AiProviderError extends ServiceUnavailableException {
  constructor(public readonly providerStatus: number, message: string) {
    super(message);
  }
}

/**
 * Proveedor DeepInfra (API compatible con OpenAI).
 * La llave la decide ai-access.ts (la del cliente o la de BackOffice).
 */
@Injectable()
export class DeepInfraProvider implements AiProvider {
  private readonly logger = new Logger('DeepInfra');

  async chat(opts: AiChatOptions): Promise<AiChatResult> {
    // Una llave de OpenRouter (de la empresa o de BackOffice) manda TODO por OpenRouter
    if (isOpenRouterModel(opts.model) || isOpenRouterKey(opts.apiKey)) return this.chatOpenRouter(opts);
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`chat ${res.status}: ${body.slice(0, 300)}`);
      throw new AiProviderError(
        res.status,
        `DeepInfra respondió ${res.status} — revisar llave/modelo de la organización`,
      );
    }
    const data: any = await res.json();
    return {
      content: data?.choices?.[0]?.message?.content ?? '',
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
      model: data?.model ?? opts.model,
    };
  }

  /**
   * Por OpenRouter. La llave sale de quien paga:
   *  - Llave de OpenRouter de la empresa («sk-or-…»): esa, para cualquier modelo.
   *  - La de BackOffice (sin DeepInfra, o la de DeepInfra de BackOffice con un
   *    modelo premium): OPENROUTER_API_KEY del servidor.
   *  - La llave de DeepInfra de un cliente con un modelo premium: se rechaza
   *    (403) y, en modo híbrido, la sesión pasa sola a la llave de BackOffice.
   * Los modelos de DeepInfra se atienden con el de OpenRouter configurado.
   */
  private async chatOpenRouter(opts: AiChatOptions): Promise<AiChatResult> {
    const companyKey = /^sk-or-/.test(opts.apiKey.trim()) ? opts.apiKey.trim() : null;
    const platformDeepInfra = process.env.DEEPINFRA_API_KEY?.trim();
    const isPlatformCall = opts.apiKey === PLATFORM_OPENROUTER_KEY || (!!platformDeepInfra && opts.apiKey === platformDeepInfra);
    if (!companyKey && !isPlatformCall) {
      throw new AiProviderError(403, 'Este modelo premium solo funciona con una llave de OpenRouter o con la IA de BackOffice');
    }
    const key = companyKey ?? openRouterKey();
    if (!key) throw new AiProviderError(503, 'Falta OPENROUTER_API_KEY para la IA de BackOffice por OpenRouter');
    const model = openRouterModelFor(opts.model);
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_WEB_URL || 'https://backoffice.app',
        'X-Title': 'BackOffice',
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`openrouter ${res.status}: ${body.slice(0, 300)}`);
      // Con la llave de la empresa, 401/402 dicen «llave rechazada / sin saldo» (en híbrido pasa a la otra);
      // con la de BackOffice no: el problema es de la plataforma, no de la empresa
      const status = !companyKey && (res.status === 401 || res.status === 402) ? 503 : res.status;
      throw new AiProviderError(status, res.status === 402 ? 'La cuenta de OpenRouter no tiene saldo' : `OpenRouter respondió ${res.status}`);
    }
    const data: any = await res.json();
    return {
      content: data?.choices?.[0]?.message?.content ?? '',
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
      model: data?.model ?? model,
    };
  }

  async transcribe(opts: AiTranscribeOptions): Promise<{ text: string }> {
    if (isOpenRouterKey(opts.apiKey)) {
      // 501 (no 401/402): no es una llave rechazada, así que no salta a la de respaldo
      throw new AiProviderError(501, 'La transcripción de audios solo está disponible con DeepInfra');
    }
    const buffer = await readFile(opts.filePath);
    const form = new FormData();
    form.append('model', WHISPER_MODEL);
    if (opts.language) form.append('language', opts.language);
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: opts.mimeType }),
      'audio' + (opts.mimeType.includes('ogg') ? '.ogg' : '.mp3'),
    );
    const res = await fetch(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      body: form,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(`transcribe ${res.status}: ${body.slice(0, 300)}`);
      throw new AiProviderError(res.status, 'No se pudo transcribir el audio');
    }
    const data: any = await res.json();
    return { text: data?.text ?? '' };
  }
}
