/**
 * «Qué te funciona»: aprende de los resultados reales que Meta reportó para
 * los anuncios hechos con diseños de Creative. Todo es cálculo con código sobre
 * datos sincronizados; si no hay suficiente, lo dice (nunca inventa).
 */

export interface DesignResult {
  designId: string; name: string; family: string | null; familyLabel: string | null; format: string;
  impressions: number; clicks: number; spend: number; conversations: number; leads: number; days: number;
}

export interface Group { key: string; label: string; designs: number; impressions: number; clicks: number; spend: number; conversations: number; ctr: number | null; cpc: number | null; costPerConversation: number | null }

/** Mínimo de impresiones para comparar un grupo (con menos, la diferencia es azar). */
export const MIN_IMPRESSIONS = 1000;

export function group(rows: DesignResult[], keyOf: (r: DesignResult) => string | null, labelOf: (k: string) => string): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const g = map.get(k) ?? { key: k, label: labelOf(k), designs: 0, impressions: 0, clicks: 0, spend: 0, conversations: 0, ctr: null, cpc: null, costPerConversation: null };
    g.designs += 1; g.impressions += r.impressions; g.clicks += r.clicks; g.spend += r.spend; g.conversations += r.conversations + r.leads;
    map.set(k, g);
  }
  return [...map.values()].map((g) => ({
    ...g,
    ctr: g.impressions ? g.clicks / g.impressions : null,
    cpc: g.clicks ? g.spend / g.clicks : null,
    costPerConversation: g.conversations ? g.spend / g.conversations : null,
  })).sort((a, b) => b.impressions - a.impressions);
}

/** Recomendaciones de diseño a partir de los grupos con datos suficientes. */
export function recommend(byFamily: Group[], byFormat: Group[]): string[] {
  const out: string[] = [];
  const compare = (groups: Group[], noun: (g: Group) => string) => {
    const solid = groups.filter((g) => g.impressions >= MIN_IMPRESSIONS && g.ctr !== null);
    if (solid.length < 2) return;
    const totalClicks = solid.reduce((s, g) => s + g.clicks, 0);
    const totalImp = solid.reduce((s, g) => s + g.impressions, 0);
    const avg = totalClicks / totalImp;
    const best = [...solid].sort((a, b) => b.ctr! - a.ctr!)[0];
    const worst = [...solid].sort((a, b) => a.ctr! - b.ctr!)[0];
    if (avg > 0 && best.ctr! >= avg * 1.2) out.push(`Las piezas ${noun(best)} consiguen ${Math.round((best.ctr! / avg - 1) * 100)} % más clics que tu promedio: úsalas en tu próxima campaña.`);
    if (avg > 0 && worst !== best && worst.ctr! <= avg * 0.8) out.push(`Las piezas ${noun(worst)} reciben ${Math.round((1 - worst.ctr! / avg) * 100)} % menos clics que tu promedio: prueba cambiarles la foto o el titular antes de volver a pautarlas.`);
  };
  compare(byFamily, (g) => `con estilo «${g.label}»`);
  compare(byFormat, (g) => `en formato ${g.label}`);
  return out;
}
