import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream } from 'fs';
import { readFile } from 'fs/promises';
import {
  AiChatOptions,
  AiChatResult,
  AiProvider,
  AiTranscribeOptions,
} from './types';

const CHAT_URL = 'https://api.deepinfra.com/v1/openai/chat/completions';
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
