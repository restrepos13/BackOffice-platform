/**
 * Genera (o completa) las respuestas de referencia de la IA para el corpus.
 * Uso: npx ts-node --transpile-only test/fixtures/gen-blueprint-refs.ts
 * No corre en los tests: solo se usa para refrescar la referencia.
 */
import { PrismaClient } from '@prisma/client';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GeminiPool } from '../../src/ai/gemini-pool';
import { blueprintSystemPrompt } from '../../src/common/signup-prompts';
import { CORPUS } from './blueprint-corpus';

const OUT = join(__dirname, 'blueprint-ai-reference.json');

(async () => {
  const prisma = new PrismaClient();
  const pool = new GeminiPool(prisma);
  const refs: Record<string, any> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
  for (const c of CORPUS) {
    if (refs[c.id]) continue;
    const transcript = c.answers.map(([q, a]) => `P: ${q.slice(0, 140)}\nR: ${a}`).join('\n');
    try {
      const r = await pool.chatJson(
        { json: true, temperature: 0.2, maxTokens: 6000, deadlineMs: 120_000, messages: [{ role: 'system', content: blueprintSystemPrompt() }, { role: 'user', content: transcript }] },
        (o: any) => !!(o?.empresa || o?.asistente || o?.rubro),
      );
      refs[c.id] = { model: r.result.model, raw: r.raw };
      writeFileSync(OUT, JSON.stringify(refs, null, 1));
      console.log(`${c.id}: listo (${r.result.model})`);
    } catch (err) {
      console.log(`${c.id}: falló ${(err as Error).message}`);
    }
  }
  await prisma.$disconnect();
})();
