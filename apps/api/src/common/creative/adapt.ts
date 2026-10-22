import { DesignDoc, FORMATS, FormatKey, ImageElement, TextElement } from '../design-doc';
import { AssetDims, Content, Family, FAMILIES, Tokens, compose } from './compose';

/**
 * Adaptar una pieza a otro formato. Si se generó con dirección de arte, se
 * RECOMPONE la misma familia para el nuevo formato, conservando lo que la
 * persona escribió y las fotos que eligió (se leen por rol y slot del
 * documento actual, no del contenido original). Si es un diseño anterior,
 * se escala de forma proporcional y el control de calidad avisa lo que haya
 * que revisar.
 */

export interface Composition { family: Family; variant: number; goal: string; seed: number; adaptedFrom?: string | null }

export function readComposition(json: string | null | undefined): Composition | null {
  if (!json) return null;
  try {
    const c = JSON.parse(json);
    return (FAMILIES as readonly string[]).includes(c?.family) ? { family: c.family, variant: Number(c.variant) || 0, goal: String(c.goal ?? ''), seed: Number(c.seed) || 0, adaptedFrom: c.adaptedFrom ?? null } : null;
  } catch {
    return null;
  }
}

/** Contenido actual de un documento, leído por rol (incluye las ediciones de la persona). */
export function contentOf(doc: DesignDoc): Content {
  const texts = doc.elements.filter((e) => e.type === 'text') as TextElement[];
  const by = (role: string, slot?: string) => texts.find((t) => t.role === role && (slot === undefined || t.slot === slot))?.text;
  const headlineParts = texts.filter((t) => t.role === 'headline').map((t) => t.text);
  const slots = (role: string) => texts.filter((t) => t.role === role).sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0));
  const images = doc.elements.filter((e) => e.type === 'image') as ImageElement[];
  const itemNames = slots('item-name');
  return {
    kicker: by('kicker'),
    headline: headlineParts.join(' ') || by('quote') || '',
    body: by('body'),
    price: by('price'),
    cta: by('cta'),
    validity: by('validity'),
    place: by('place'),
    quote: by('quote'),
    author: by('author'),
    date: by('date', 'day') ? { day: by('date', 'day')!, month: by('date', 'month') ?? '' } : undefined,
    points: slots('point').map((t) => t.text),
    items: itemNames.map((n) => ({
      name: n.text,
      price: texts.find((t) => t.role === 'item-price' && t.slot === n.slot)?.text,
      assetId: images.find((i) => i.role === 'item-photo' && i.slot === n.slot)?.assetId,
    })),
    photos: images.filter((i) => i.role === 'photo').sort((a, b) => Number(a.slot ?? 0) - Number(b.slot ?? 0)).map((i) => i.assetId),
  };
}

/** Escalado proporcional (diseños sin dirección de arte). */
export function scaleAdapt(doc: DesignDoc, to: FormatKey): DesignDoc {
  const { width: W, height: H } = FORMATS[to];
  const sx = W / doc.width;
  const sy = H / doc.height;
  const s = Math.min(sx, sy);
  return {
    ...doc, format: to, width: W, height: H,
    elements: doc.elements.map((e, i) => {
      const cx = (e.x + e.width / 2) * sx;
      const cy = (e.y + e.height / 2) * sy;
      const w = e.width * s;
      const h = e.height * s;
      const out: any = { ...e, id: `a${i.toString(36)}${e.id}`.slice(0, 40), x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.max(1, Math.round(w)), height: Math.max(e.type === 'line' ? 0 : 1, Math.round(h)) };
      if (e.type === 'text') out.fontSize = Math.max(6, Math.round((e as TextElement).fontSize * s));
      return out;
    }),
  };
}

export function adaptDesign(doc: DesignDoc, comp: Composition | null, to: FormatKey, tokens: Tokens, dims: AssetDims): { doc: DesignDoc; method: 'RECOMPOSED' | 'SCALED' } {
  if (comp) {
    const content = contentOf(doc);
    if (content.headline || content.quote) return { doc: compose(comp.family, tokens, content, comp.variant, dims), method: 'RECOMPOSED' };
  }
  return { doc: scaleAdapt(doc, to), method: 'SCALED' };
}
