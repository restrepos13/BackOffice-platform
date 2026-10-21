/**
 * ¿Qué tanto se parece el plano armado por código al de la IA? Compara campo
 * por campo con palabras clave (sin tildes, plurales ni palabras vacías) y da
 * un puntaje de 0 a 100. Lo usa el test que exige al motor por código ≥ 70 %.
 */

const STOP = new Set(('a al ante con contra de del desde durante e el ella ellos en entre es esta este esto hasta la las le les lo los mas me mi mis muy no o para pero por que se si sin sobre su sus te tu tus un una uno unos unas y ya hay cada como cual cuando donde ser son fue estan esta estas estos sera puede pueden tiene tienen tu usted ustedes nuestro nuestra nuestros nuestras etc todo toda todos todas cliente clientes').split(' '));

/** Palabras clave normalizadas de un texto. */
export function keywords(text: string): Set<string> {
  const words = String(text ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
    .map((w) => (w.length > 6 ? w.slice(0, 6) : w)); // raíz corta: "entrega"/"entregar"/"entregado"
  return new Set(words);
}

/** Parecido de dos textos: palabras compartidas sobre el más corto. */
export function textSim(a: string, b: string): number {
  const A = keywords(a);
  const B = keywords(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const w of A) if (B.has(w)) common++;
  return common / Math.min(A.size, B.size);
}

/** F1 "suave" entre dos listas: cada elemento se empareja con el más parecido de la otra. */
export function listSim(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const best = (x: string, ys: string[]) => Math.max(...ys.map((y) => textSim(x, y)));
  const precision = a.reduce((n, x) => n + best(x, b), 0) / a.length;
  const recall = b.reduce((n, y) => n + best(y, a), 0) / b.length;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

export function setSim(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 1;
  let common = 0;
  for (const x of A) if (B.has(x)) common++;
  return common / new Set([...A, ...B]).size;
}

export interface ComparableBlueprint {
  rubro: string;
  businessType: string;
  needs: Array<{ title: string; solution: string }>;
  modules: string[];
  pipeline: { stages: Array<{ label: string; kind: string }> } | null;
  clientData: string[];
  assistantFlow: string[];
  quickReplies: Array<{ title: string; body: string }>;
  faqs: Array<{ question: string; answer: string }>;
  products: Array<{ name: string; price: number | null }>;
  schedule: { days: number[]; open: string; close: string } | null;
  deliveryEnabled: boolean | null;
  assistantWelcome: string;
  companyName: string;
  city: string;
}

/** Pesos (suman 100). */
export const WEIGHTS = {
  rubro: 8, businessType: 5, modules: 12, needs: 12, clientData: 10, assistantFlow: 12,
  pipeline: 8, replies: 10, facts: 15, identity: 8,
};

export function compareBlueprints(code: ComparableBlueprint, ai: ComparableBlueprint) {
  const parts: Record<keyof typeof WEIGHTS, number> = {
    rubro: code.rubro === ai.rubro ? 1 : 0,
    businessType: textSim(code.businessType, ai.businessType),
    modules: setSim(code.modules, ai.modules),
    needs: listSim(code.needs.map((n) => `${n.title} ${n.solution}`), ai.needs.map((n) => `${n.title} ${n.solution}`)),
    clientData: listSim(code.clientData, ai.clientData),
    assistantFlow: listSim(code.assistantFlow, ai.assistantFlow),
    pipeline: listSim((code.pipeline?.stages ?? []).map((s) => s.label), (ai.pipeline?.stages ?? []).map((s) => s.label)),
    replies: listSim(
      [...code.quickReplies.map((r) => `${r.title} ${r.body}`), ...code.faqs.map((f) => `${f.question} ${f.answer}`)],
      [...ai.quickReplies.map((r) => `${r.title} ${r.body}`), ...ai.faqs.map((f) => `${f.question} ${f.answer}`)],
    ),
    facts: (() => {
      const scores: number[] = [];
      if (code.products.length || ai.products.length) {
        const names = listSim(code.products.map((p) => p.name), ai.products.map((p) => p.name));
        const aiPrices = new Set(ai.products.map((p) => p.price).filter((x) => x != null));
        const codePrices = new Set(code.products.map((p) => p.price).filter((x) => x != null));
        const prices = aiPrices.size || codePrices.size ? setSim([...codePrices].map(String), [...aiPrices].map(String)) : 1;
        scores.push(names, prices);
      }
      if (code.schedule || ai.schedule) {
        scores.push(code.schedule && ai.schedule
          ? (setSim(code.schedule.days.map(String), ai.schedule.days.map(String)) + (code.schedule.open === ai.schedule.open ? 1 : 0) + (code.schedule.close === ai.schedule.close ? 1 : 0)) / 3
          : 0);
      }
      if (code.deliveryEnabled != null || ai.deliveryEnabled != null) scores.push(!!code.deliveryEnabled === !!ai.deliveryEnabled ? 1 : 0);
      return scores.length ? scores.reduce((n, x) => n + x, 0) / scores.length : 1;
    })(),
    identity: ((code.companyName.toLowerCase() === ai.companyName.toLowerCase() ? 1 : 0) + (code.city.toLowerCase() === ai.city.toLowerCase() ? 1 : 0) + textSim(code.assistantWelcome, ai.assistantWelcome)) / 3,
  };
  const score = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce((n, k) => n + WEIGHTS[k] * parts[k], 0);
  return { score: Math.round(score * 10) / 10, parts };
}
