import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import {
  AiChatOptions,
  AiChatResult,
  AiProvider,
  AiTranscribeOptions,
} from './types';
import { PLATFORM_OPENROUTER_KEY, isOpenRouterModel, openRouterKey } from './model-routing';

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
    if (isOpenRouterModel(opts.model)) return this.chatOpenRouter(opts);
    if (opts.apiKey === PLATFORM_OPENROUTER_KEY) {
      throw new AiProviderError(503, 'La IA de BackOffice necesita DEEPINFRA_API_KEY para este modelo (o elige un modelo premium)');
    }
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
   * Modelos premium (Claude Haiku) por OpenRouter. Solo con la IA de BackOffice:
   * si llega la llave DeepInfra de un cliente (BYOK) se rechaza con 403 y, en
   * modo híbrido, la sesión pasa sola a la llave de BackOffice.
   */
  private async chatOpenRouter(opts: AiChatOptions): Promise<AiChatResult> {
    const key = openRouterKey();
    const platformDeepInfra = process.env.DEEPINFRA_API_KEY?.trim();
    const isPlatformCall = opts.apiKey === PLATFORM_OPENROUTER_KEY || (!!platformDeepInfra && opts.apiKey === platformDeepInfra);
    if (!isPlatformCall) {
      throw new AiProviderError(403, 'Este modelo premium solo funciona con la IA de BackOffice (paquetes)');
    }
    if (!key) throw new AiProviderError(503, 'Falta OPENROUTER_API_KEY para los modelos premium');
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.PUBLIC_WEB_URL || 'https://backoffice.app',
        'X-Title': 'BackOffice',
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
      this.logger.error(`openrouter ${res.status}: ${body.slice(0, 300)}`);
      throw new AiProviderError(res.status === 401 || res.status === 402 ? 503 : res.status, `OpenRouter respondió ${res.status}`);
    }
    const data: any = await res.json();
    return {
      content: data?.choices?.[0]?.message?.content ?? '',
      inputTokens: data?.usage?.prompt_tokens ?? 0,
      outputTokens: data?.usage?.completion_tokens ?? 0,
      model: data?.model ?? opts.model,
    };
  }

  async transcribe(opts: AiTranscribeOptions): Promise<{ text: string }> {
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
