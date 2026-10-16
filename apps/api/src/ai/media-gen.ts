/**
 * Generación de imágenes para redes (la paga BackOffice, dentro del extra).
 * Proveedor en Dev Tools → Settings:
 *   MEDIA_IMAGE_PROVIDER = DEEPINFRA | GEMINI | SIMULADO   (por defecto DEEPINFRA si
 *                          hay llave de plataforma; si no, SIMULADO)
 *   MEDIA_IMAGE_MODEL    = p. ej. black-forest-labs/FLUX-1-dev (DeepInfra) o
 *                          gemini-2.5-flash-image (Gemini)
 * Higgsfield (imágenes y video premium) queda para cuando se defina la cuenta.
 * SIMULADO dibuja una tarjeta SVG: sirve para probar todo el flujo sin gastar.
 */
import { createHash } from 'crypto';
import { platformAiKey } from './ai-access';
import { PROVIDER_COST_USD } from '../common/social-addon';

export type Aspect = '1:1' | '4:5' | '9:16';

export interface GeneratedImage {
  buffer: Buffer;
  mime: string;
  ext: string;
  provider: string;
  model: string;
  costUsd: number;
}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

const SIZES: Record<Aspect, { w: number; h: number }> = {
  '1:1': { w: 1024, h: 1024 },
  '4:5': { w: 1024, h: 1280 },
  '9:16': { w: 768, h: 1344 },
};

export async function imageConfig(prisma: any) {
  const rows = await prisma.platformSetting.findMany({ where: { key: { in: ['MEDIA_IMAGE_PROVIDER', 'MEDIA_IMAGE_MODEL'] } } });
  const get = (k: string) => rows.find((r: any) => r.key === k)?.value?.trim();
  const deepinfraKey = await platformAiKey(prisma);
  const provider = (get('MEDIA_IMAGE_PROVIDER') || (deepinfraKey ? 'DEEPINFRA' : 'SIMULADO')).toUpperCase();
  const model = get('MEDIA_IMAGE_MODEL')
    || (provider === 'GEMINI' ? 'gemini-2.5-flash-image' : provider === 'DEEPINFRA' ? 'black-forest-labs/FLUX-1-dev' : 'placeholder');
  return { provider, model, deepinfraKey };
}

function escapeXml(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
}

/** Tarjeta de prueba (modo SIMULADO): no gasta ni sale a internet. */
export function placeholderImage(prompt: string, aspect: Aspect, brand = '#1a1a1a'): GeneratedImage {
  const { w, h } = SIZES[aspect];
  const words = prompt.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > 28) {
      lines.push(line.trim());
      line = word;
    } else line += ` ${word}`;
    if (lines.length >= 6) break;
  }
  if (line && lines.length < 6) lines.push(line.trim());
  const hue = parseInt(createHash('md5').update(prompt).digest('hex').slice(0, 2), 16);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="hsl(${hue},28%,86%)"/>
  <rect x="48" y="48" width="${w - 96}" height="${h - 96}" fill="none" stroke="${brand}" stroke-width="6"/>
  <text x="96" y="150" font-family="Helvetica,Arial" font-size="30" font-weight="700" fill="${brand}" letter-spacing="4">VISTA PREVIA · MODO PRUEBA</text>
  ${lines.map((l, i) => `<text x="96" y="${260 + i * 72}" font-family="Georgia,serif" font-size="56" fill="${brand}">${escapeXml(l)}</text>`).join('\n  ')}
</svg>`;
  return { buffer: Buffer.from(svg), mime: 'image/svg+xml', ext: 'svg', provider: 'SIMULADO', model: 'placeholder', costUsd: 0 };
}

export async function generateImage(
  prisma: any,
  input: { prompt: string; aspect?: Aspect; brandColor?: string | null },
  fetchImpl: FetchLike = (url, init) => fetch(url, init) as any,
): Promise<GeneratedImage> {
  const aspect = input.aspect ?? '1:1';
  const { provider, model, deepinfraKey } = await imageConfig(prisma);
  const prompt = input.prompt.slice(0, 1500);

  if (provider === 'DEEPINFRA') {
    if (!deepinfraKey) throw new Error('Falta la llave de DeepInfra de la plataforma (DEEPINFRA_API_KEY)');
    const { w, h } = SIZES[aspect];
    const res = await fetchImpl('https://api.deepinfra.com/v1/openai/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deepinfraKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: `${w}x${h}`, n: 1, response_format: 'b64_json' }),
    });
    if (!res.ok) throw new Error(`DeepInfra respondió ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('DeepInfra no devolvió imagen');
    const scale = (w * h) / (1024 * 1024);
    return {
      buffer: Buffer.from(b64, 'base64'), mime: 'image/png', ext: 'png', provider, model,
      costUsd: (PROVIDER_COST_USD[`deepinfra:${model}`] ?? 0.01) * scale,
    };
  }

  if (provider === 'GEMINI') {
    const keys = String(process.env.GEMINI_API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
    if (!keys.length) throw new Error('Faltan llaves de Gemini (GEMINI_API_KEYS)');
    let last = '';
    for (const key of keys) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${prompt}\nFormato ${aspect}. Sin texto ni logos dentro de la imagen.` }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      });
      if (!res.ok) {
        last = `${res.status} ${(await res.text()).slice(0, 120)}`;
        continue; // cuota agotada o modelo no disponible → siguiente llave
      }
      const data = await res.json();
      const part = (data?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data);
      if (!part) {
        last = 'sin imagen en la respuesta';
        continue;
      }
      const mime = part.inlineData.mimeType || 'image/png';
      return {
        buffer: Buffer.from(part.inlineData.data, 'base64'), mime, ext: mime.includes('jpeg') ? 'jpg' : 'png',
        provider, model, costUsd: PROVIDER_COST_USD[`gemini:${model}`] ?? 0.039,
      };
    }
    throw new Error(`Gemini no generó la imagen (${last})`);
  }

  return placeholderImage(prompt, aspect, input.brandColor ?? undefined);
}
