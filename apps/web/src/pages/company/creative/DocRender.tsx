import Konva from 'konva';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Ellipse, Group, Image as KImage, Line, Rect, Shape, Text } from 'react-konva';
import {
  type DesignDoc, type El, type FontStyle, type Gradient, type ImageEl, type ImageMask, type PathPreset, type Shadow, type ShapeEl, type TextEl,
  coverCrop, fontsOf, loadAsset, loadFonts,
} from '../../../lib/creative';

/**
 * Dibujo ÚNICO de un documento de diseño. Lo usan el editor (que además
 * exporta desde aquí), la vista previa de propuestas y el laboratorio
 * visual: lo que se ve en una vista previa es exactamente lo que sale en la
 * exportación.
 *
 * Los elementos sin propiedades del editor ampliado (degradados, sombras,
 * recortes con forma, filtros, frases destacadas…) se dibujan exactamente
 * como antes: un diseño viejo no cambia ni un píxel.
 */

type Loader = (assetId: string, q: string) => Promise<HTMLImageElement>;
/** De dónde salen las imágenes (por defecto, los recursos privados de la empresa). */
export const AssetLoaderContext = createContext<Loader>(loadAsset);

export function useAssetImage(assetId: string | null | undefined, q: string) {
  const load = useContext(AssetLoaderContext);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    if (!assetId) { setImg(null); return; }
    load(assetId, q).then((i) => alive && setImg(i)).catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [assetId, q, load]);
  return { img, failed };
}

/* ── Utilidades de estilo ── */

/** Degradado de Konva para una caja de w×h (centered: el origen del nodo es el centro, como en Ellipse). */
export function gradientProps(g: Gradient | undefined | null, w: number, h: number, centered = false): Record<string, unknown> {
  if (!g) return {};
  const stops = g.stops.flatMap((s) => [s.at, s.color]);
  const cx = (centered ? 0 : w / 2);
  const cy = (centered ? 0 : h / 2);
  if (g.kind === 'radial') {
    return { fillPriority: 'radial-gradient', fillRadialGradientStartPoint: { x: cx, y: cy }, fillRadialGradientEndPoint: { x: cx, y: cy }, fillRadialGradientStartRadius: 0, fillRadialGradientEndRadius: Math.hypot(w, h) / 2, fillRadialGradientColorStops: stops };
  }
  // 0° = de izquierda a derecha; 90° = de arriba hacia abajo
  const a = (g.angle * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const half = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  return { fillPriority: 'linear-gradient', fillLinearGradientStartPoint: { x: cx - dx * half, y: cy - dy * half }, fillLinearGradientEndPoint: { x: cx + dx * half, y: cy + dy * half }, fillLinearGradientColorStops: stops };
}

/** Sombra: el alfa del color (#RRGGBBAA) pasa a la opacidad de la sombra. */
export function shadowProps(s: Shadow | undefined): Record<string, unknown> {
  if (!s) return {};
  const alpha = s.color.length === 9 ? parseInt(s.color.slice(7, 9), 16) / 255 : 1;
  return { shadowColor: s.color.slice(0, 7), shadowOpacity: alpha, shadowBlur: s.blur, shadowOffsetX: s.x, shadowOffsetY: s.y, shadowForStrokeEnabled: false };
}

/* ── Geometría (coordenadas normalizadas 0..1, dibujadas en una caja w×h) ── */

type Ctx = Konva.Context;
type Cmd = ['M' | 'L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];

const PRESETS: Record<PathPreset, Cmd[]> = {
  blob: [['M', 0.5, 0], ['C', 0.79, 0, 1, 0.2, 0.98, 0.47], ['C', 0.96, 0.77, 0.75, 1, 0.47, 0.98], ['C', 0.19, 0.96, 0, 0.76, 0.02, 0.48], ['C', 0.04, 0.2, 0.22, 0, 0.5, 0], ['Z']],
  blob2: [['M', 0.42, 0.03], ['C', 0.68, -0.03, 0.96, 0.12, 0.97, 0.4], ['C', 0.99, 0.62, 0.86, 0.72, 0.8, 0.86], ['C', 0.72, 1.02, 0.42, 1.01, 0.24, 0.9], ['C', 0.06, 0.8, -0.02, 0.6, 0.03, 0.38], ['C', 0.07, 0.18, 0.2, 0.07, 0.42, 0.03], ['Z']],
  wave: [['M', 0, 0.35], ['C', 0.17, 0.08, 0.33, 0.08, 0.5, 0.35], ['C', 0.67, 0.62, 0.83, 0.62, 1, 0.35], ['L', 1, 1], ['L', 0, 1], ['Z']],
  'wave-top': [['M', 0, 0], ['L', 1, 0], ['L', 1, 0.65], ['C', 0.83, 0.92, 0.67, 0.92, 0.5, 0.65], ['C', 0.33, 0.38, 0.17, 0.38, 0, 0.65], ['Z']],
  arch: [['M', 0, 1], ['L', 0, 0.5], ['C', 0, 0.22, 0.22, 0, 0.5, 0], ['C', 0.78, 0, 1, 0.22, 1, 0.5], ['L', 1, 1], ['Z']],
  leaf: [['M', 0, 1], ['C', 0, 0.45, 0.45, 0, 1, 0], ['C', 1, 0.55, 0.55, 1, 0, 1], ['Z']],
  ribbon: [['M', 0, 0], ['L', 1, 0], ['L', 0.94, 0.5], ['L', 1, 1], ['L', 0, 1], ['L', 0.06, 0.5], ['Z']],
  arrow: [['M', 0, 0.3], ['L', 0.62, 0.3], ['L', 0.62, 0], ['L', 1, 0.5], ['L', 0.62, 1], ['L', 0.62, 0.7], ['L', 0, 0.7], ['Z']],
  bubble: [['M', 0.1, 0], ['L', 0.9, 0], ['C', 0.96, 0, 1, 0.04, 1, 0.1], ['L', 1, 0.7], ['C', 1, 0.76, 0.96, 0.8, 0.9, 0.8], ['L', 0.36, 0.8], ['L', 0.18, 1], ['L', 0.21, 0.8], ['L', 0.1, 0.8], ['C', 0.04, 0.8, 0, 0.76, 0, 0.7], ['L', 0, 0.1], ['C', 0, 0.04, 0.04, 0, 0.1, 0], ['Z']],
  brush: [['M', 0.02, 0.2], ['C', 0.2, 0.06, 0.45, 0.13, 0.7, 0.06], ['C', 0.85, 0.02, 0.96, 0.08, 1, 0.22], ['L', 0.98, 0.78], ['C', 0.8, 0.95, 0.55, 0.86, 0.3, 0.94], ['C', 0.15, 0.98, 0.05, 0.92, 0, 0.8], ['Z']],
  squiggle: [['M', 0, 0.5], ['C', 0.125, 0, 0.25, 0, 0.375, 0.5], ['C', 0.5, 1, 0.625, 1, 0.75, 0.5], ['C', 0.875, 0, 1, 0, 1, 0.5]],
};

function trace(ctx: Ctx, cmds: Cmd[], w: number, h: number) {
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1] * w, c[2] * h);
    else if (c[0] === 'L') ctx.lineTo(c[1] * w, c[2] * h);
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1] * w, c[2] * h, c[3] * w, c[4] * h, c[5] * w, c[6] * h);
    else ctx.closePath();
  }
}
function ellipsePath(ctx: Ctx, w: number, h: number) {
  const k = 0.5523;
  const rx = w / 2;
  const ry = h / 2;
  ctx.moveTo(w, ry);
  ctx.bezierCurveTo(w, ry + ry * k, rx + rx * k, h, rx, h);
  ctx.bezierCurveTo(rx - rx * k, h, 0, ry + ry * k, 0, ry);
  ctx.bezierCurveTo(0, ry - ry * k, rx - rx * k, 0, rx, 0);
  ctx.bezierCurveTo(rx + rx * k, 0, w, ry - ry * k, w, ry);
  ctx.closePath();
}
/** Rectángulo con radios por esquina: [arriba-izq, arriba-der, abajo-der, abajo-izq]. */
function roundRectPath(ctx: Ctx, w: number, h: number, r: [number, number, number, number]) {
  const m = Math.min(w, h) / 2;
  const [a, b, c, d] = r.map((x) => Math.max(0, Math.min(m, x)));
  ctx.moveTo(a, 0);
  ctx.lineTo(w - b, 0);
  if (b) ctx.quadraticCurveTo(w, 0, w, b);
  ctx.lineTo(w, h - c);
  if (c) ctx.quadraticCurveTo(w, h, w - c, h);
  ctx.lineTo(d, h);
  if (d) ctx.quadraticCurveTo(0, h, 0, h - d);
  ctx.lineTo(0, a);
  if (a) ctx.quadraticCurveTo(0, 0, a, 0);
  ctx.closePath();
}
function regularPath(ctx: Ctx, w: number, h: number, n: number, inner?: number) {
  const pts = inner === undefined ? n : n * 2;
  for (let i = 0; i < pts; i++) {
    const r = inner !== undefined && i % 2 === 1 ? inner : 1;
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / pts;
    const x = w / 2 + (Math.cos(a) * r * w) / 2;
    const y = h / 2 + (Math.sin(a) * r * h) / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Contorno del recorte de una imagen (también sirve para su sombra y su borde). */
export function maskPath(ctx: Ctx, mask: ImageMask, w: number, h: number, radius = 0) {
  const s = Math.min(w, h);
  if (mask === 'circle') return ellipsePath(ctx, w, h);
  if (mask === 'pill') return roundRectPath(ctx, w, h, [s / 2, s / 2, s / 2, s / 2]);
  if (mask === 'arch') {
    const r = Math.min(w / 2, h);
    ctx.moveTo(0, h);
    ctx.lineTo(0, r);
    ctx.bezierCurveTo(0, r * 0.45, w / 2 - (w / 2) * 0.55, 0, w / 2, 0);
    ctx.bezierCurveTo(w / 2 + (w / 2) * 0.55, 0, w, r * 0.45, w, r);
    ctx.lineTo(w, h);
    ctx.closePath();
    return;
  }
  if (mask === 'blob') return trace(ctx, PRESETS.blob, w, h);
  if (mask === 'hexagon') return trace(ctx, [['M', 0.25, 0], ['L', 0.75, 0], ['L', 1, 0.5], ['L', 0.75, 1], ['L', 0.25, 1], ['L', 0, 0.5], ['Z']], w, h);
  if (mask === 'diamond') return trace(ctx, [['M', 0.5, 0], ['L', 1, 0.5], ['L', 0.5, 1], ['L', 0, 0.5], ['Z']], w, h);
  if (mask === 'leaf') return roundRectPath(ctx, w, h, [s * 0.5, 0, s * 0.5, 0]);
  if (mask === 'squircle') return roundRectPath(ctx, w, h, [s * 0.22, s * 0.22, s * 0.22, s * 0.22]);
  return roundRectPath(ctx, w, h, [radius, radius, radius, radius]);
}

/** Dibujo de las formas nuevas (polígono, estrella y formas predefinidas). */
function shapePath(ctx: Ctx, e: ShapeEl) {
  if (e.type === 'polygon') return regularPath(ctx, e.width, e.height, e.sides ?? 6);
  if (e.type === 'star') return regularPath(ctx, e.width, e.height, e.points ?? 5, e.innerRatio ?? 0.5);
  return trace(ctx, PRESETS[e.preset ?? 'blob'], e.width, e.height);
}

/* ── Imágenes ── */

const FILTER_KEY = (f: ImageEl['filters']) => (f ? `${f.brightness}|${f.contrast}|${f.saturation}|${f.blur}|${f.grayscale}` : '');

function FilteredImage({ img, el, x = 0, y = 0, extra }: { img: HTMLImageElement; el: ImageEl; x?: number; y?: number; extra?: Record<string, unknown> }) {
  const ref = useRef<Konva.Image>(null);
  const f = el.filters;
  const key = FILTER_KEY(f);
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n) return;
    if (!f) { n.clearCache(); n.filters([]); n.getLayer()?.batchDraw(); return; }
    const list: Array<typeof Konva.Filters.Blur> = [];
    if (f.brightness) list.push(Konva.Filters.Brighten);
    if (f.contrast) list.push(Konva.Filters.Contrast);
    if (f.saturation) list.push(Konva.Filters.HSL);
    if (f.grayscale) list.push(Konva.Filters.Grayscale);
    if (f.blur) list.push(Konva.Filters.Blur);
    n.cache();
    n.filters(list);
    n.brightness(f.brightness);
    n.contrast(f.contrast);
    n.saturation(f.saturation);
    n.blurRadius(f.blur);
    n.getLayer()?.batchDraw();
    // el.width/height cambian el tamaño del caché
  }, [key, img, el.width, el.height, el.crop, f]);
  const flip = el.flipX ? { scaleX: -1, x: x + el.width } : { x };
  return <KImage ref={ref} image={img} y={y} width={el.width} height={el.height} crop={el.crop ?? undefined} {...flip} {...extra} />;
}

export function ImageNode({ el, q, common }: { el: ImageEl; q: string; common: Record<string, any> }) {
  const { img, failed } = useAssetImage(el.assetId, q);
  if (!img) {
    // Recurso faltante: caja visible para no perder la capa
    return <Rect {...common} width={el.width} height={el.height} fill={failed ? '#F2DCDA' : '#ECE8E2'} stroke={failed ? '#B42318' : '#BBB'} strokeWidth={2} dash={[12, 8]} cornerRadius={el.cornerRadius} />;
  }
  const mask = el.mask ?? 'none';
  const plain = mask === 'none' && !el.shadow && !el.stroke && !el.flipX && !el.filters;
  if (plain) return <KImage {...common} image={img} width={el.width} height={el.height} crop={el.crop ?? undefined} cornerRadius={el.cornerRadius} />;
  const path = (ctx: Ctx) => maskPath(ctx, mask, el.width, el.height, el.cornerRadius);
  return (
    <Group {...common} width={el.width} height={el.height}>
      {el.shadow && <Shape width={el.width} height={el.height} fill="#FFFFFF" listening={false} {...shadowProps(el.shadow)} sceneFunc={(ctx, s) => { ctx.beginPath(); path(ctx); ctx.fillShape(s); }} />}
      <Group clipFunc={(ctx) => { path(ctx as unknown as Ctx); }}>
        <FilteredImage img={img} el={el} />
      </Group>
      {el.stroke && el.strokeWidth ? <Shape width={el.width} height={el.height} stroke={el.stroke} strokeWidth={el.strokeWidth} listening={false} sceneFunc={(ctx, s) => { ctx.beginPath(); path(ctx); ctx.strokeShape(s); }} /> : null}
    </Group>
  );
}

/* ── Fondo ── */

export function Background({ doc, q }: { doc: DesignDoc; q: string }) {
  const { img } = useAssetImage(doc.background.assetId, q);
  const ov = doc.background.overlay;
  return (
    <>
      <Rect x={0} y={0} width={doc.width} height={doc.height} fill={doc.background.color} {...gradientProps(doc.background.gradient, doc.width, doc.height)} listening={false} name="__bg" />
      {img && <KImage image={img} x={0} y={0} width={doc.width} height={doc.height} crop={coverCrop(img, doc.width, doc.height)} listening={false} />}
      {ov && <Rect x={0} y={0} width={doc.width} height={doc.height} fill={ov.color} {...gradientProps(ov.gradient, doc.width, doc.height)} opacity={ov.opacity} listening={false} />}
    </>
  );
}

/* ── Texto ── */

const styleOf = (base: FontStyle, s: FontStyle): string => s === 'normal' ? base : s;
const fontCss = (style: string, size: number, family: string) => `${style.replace('normal', '').trim()} ${size}px "${family}"`.trim();

interface Run { text: string; x: number; y: number; w: number; accent: boolean }
let measureCtx: CanvasRenderingContext2D | null = null;

/**
 * Distribución por palabras de un texto con una frase destacada (como
 * wrap="word" de Konva): cada tramo se dibuja con su propio estilo.
 */
export function layoutRich(e: TextEl): { runs: Run[]; height: number } {
  const accent = e.accent!;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  const ctx = measureCtx!;
  const lower = e.text.toLowerCase();
  const at = lower.indexOf(accent.text.toLowerCase());
  const segs = at < 0 ? [{ t: e.text, a: false }] : [{ t: e.text.slice(0, at), a: false }, { t: e.text.slice(at, at + accent.text.length), a: true }, { t: e.text.slice(at + accent.text.length), a: false }];
  // Palabras con su estilo (los espacios separan; los saltos de línea fuerzan línea nueva)
  const tokens: Array<{ t: string; a: boolean; br?: boolean }> = [];
  for (const s of segs) {
    s.t.split(/(\n| +)/).forEach((p) => {
      if (!p) return;
      if (p === '\n') tokens.push({ t: '', a: s.a, br: true });
      else if (/^ +$/.test(p)) tokens.push({ t: ' ', a: s.a });
      else tokens.push({ t: p, a: s.a });
    });
  }
  const width = (t: string, a: boolean) => {
    ctx.font = fontCss(a ? styleOf(e.fontStyle, accent.style) : e.fontStyle, e.fontSize, e.fontFamily);
    return ctx.measureText(t).width + e.letterSpacing * t.length;
  };
  const lines: Array<Array<{ t: string; a: boolean; w: number }>> = [[]];
  let lineW = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.br) { lines.push([]); lineW = 0; continue; }
    if (tk.t === ' ') { if (lines.at(-1)!.length) { const w = width(' ', tk.a); lines.at(-1)!.push({ t: ' ', a: tk.a, w }); lineW += w; } continue; }
    // Una palabra puede venir partida en dos tramos (mitad destacada): se mide junta para cortar la línea
    const w = width(tk.t, tk.a);
    const cur = lines.at(-1)!;
    const trailing = cur.length && cur.at(-1)!.t === ' ' ? cur.at(-1)!.w : 0;
    if (cur.length && lineW + w > e.width + 0.5 && trailing) {
      cur.pop();
      lines.push([{ t: tk.t, a: tk.a, w }]);
      lineW = w;
    } else { cur.push({ t: tk.t, a: tk.a, w }); lineW += w; }
  }
  const lh = e.fontSize * e.lineHeight;
  const runs: Run[] = [];
  lines.forEach((ln, i) => {
    while (ln.length && ln.at(-1)!.t === ' ') ln.pop();
    const total = ln.reduce((s, x) => s + x.w, 0);
    let x = e.align === 'center' ? (e.width - total) / 2 : e.align === 'right' ? e.width - total : 0;
    // Tramos contiguos con el mismo estilo se dibujan juntos
    for (const p of ln) {
      const last = runs.at(-1);
      if (last && last.y === i * lh && last.accent === p.a) { last.text += p.t; last.w += p.w; }
      else runs.push({ text: p.t, x, y: i * lh, w: p.w, accent: p.a });
      x += p.w;
    }
  });
  return { runs, height: Math.max(1, lines.length) * lh };
}

function RichText({ e, common }: { e: TextEl; common: Record<string, any> }) {
  const accent = e.accent!;
  const { runs, height } = useMemo(() => layoutRich(e), [e]);
  const pad = e.fontSize * 0.08;
  return (
    <Group {...common} width={e.width} height={height} name="richtext" textHeight={height}>
      {accent.marker && runs.filter((r) => r.accent && r.text.trim()).map((r, i) => (
        <Rect key={`m${i}`} x={r.x - pad} y={r.y + (e.fontSize * e.lineHeight) / 2 - e.fontSize * 0.36} width={r.w + pad * 2} height={e.fontSize * 0.78} fill={accent.marker!} cornerRadius={e.fontSize * 0.08} listening={false} />
      ))}
      {runs.map((r, i) => (
        <Text key={i} x={r.x} y={r.y} text={r.text} fontFamily={e.fontFamily} fontSize={e.fontSize} lineHeight={e.lineHeight} letterSpacing={e.letterSpacing}
          fontStyle={r.accent ? styleOf(e.fontStyle, accent.style) : e.fontStyle} fill={r.accent ? accent.color : e.fill}
          {...(!r.accent ? gradientProps(e.gradient, r.w, e.fontSize * e.lineHeight) : {})}
          stroke={e.stroke} strokeWidth={e.strokeWidth ?? 0} fillAfterStrokeEnabled {...shadowProps(e.shadow)} textDecoration={e.textDecoration} />
      ))}
    </Group>
  );
}

/** Texto con caja de fondo o degradado: se mide el alto real para dibujar la caja a su medida. */
function BoxedText({ e, common }: { e: TextEl; common: Record<string, any> }) {
  const ref = useRef<Konva.Text>(null);
  const [box, setBox] = useState({ h: e.fontSize * e.lineHeight, w: e.width });
  useLayoutEffect(() => {
    const n = ref.current;
    if (!n) return;
    const h = n.height();
    const w = Math.min(e.width, n.getTextWidth());
    if (Math.abs(h - box.h) > 0.5 || Math.abs(w - box.w) > 0.5) setBox({ h, w });
  });
  const bg = e.background;
  const bx = e.align === 'center' ? (e.width - box.w) / 2 : e.align === 'right' ? e.width - box.w : 0;
  return (
    <Group {...common} width={e.width} height={box.h} name="boxedtext" textHeight={box.h}>
      {bg && <Rect x={bx - bg.padX} y={-bg.padY} width={box.w + bg.padX * 2} height={box.h + bg.padY * 2} fill={bg.color} cornerRadius={bg.radius} {...shadowProps(e.shadow)} />}
      <Text ref={ref} text={e.text} width={e.width} fontFamily={e.fontFamily} fontSize={e.fontSize} fontStyle={e.fontStyle} align={e.align} lineHeight={e.lineHeight} letterSpacing={e.letterSpacing}
        fill={e.fill} {...gradientProps(e.gradient, e.width, box.h)} stroke={e.stroke} strokeWidth={e.strokeWidth ?? 0} fillAfterStrokeEnabled
        {...(!bg ? shadowProps(e.shadow) : {})} textDecoration={e.textDecoration} wrap="word" />
    </Group>
  );
}

function TextNode({ e, c }: { e: TextEl; c: Record<string, any> }) {
  if (e.accent?.text && e.text.toLowerCase().includes(e.accent.text.toLowerCase())) return <RichText e={e} common={c} />;
  if (e.background || e.gradient) return <BoxedText e={e} common={c} />;
  return <Text {...c} text={e.text} width={e.width} fontFamily={e.fontFamily} fontSize={e.fontSize} fontStyle={e.fontStyle} align={e.align} lineHeight={e.lineHeight} letterSpacing={e.letterSpacing} fill={e.fill}
    stroke={e.stroke} strokeWidth={e.strokeWidth ?? 0} fillAfterStrokeEnabled {...shadowProps(e.shadow)} textDecoration={e.textDecoration} wrap="word" />;
}

/* ── Formas ── */

function ShapeNode({ e, c }: { e: ShapeEl; c: Record<string, any> }) {
  const dash = e.dash ? [Math.max(4, e.strokeWidth * 3), Math.max(4, e.strokeWidth * 2)] : undefined;
  const sh = shadowProps(e.shadow);
  if (e.type === 'rect') return <Rect {...c} width={e.width} height={e.height} fill={e.fill} {...gradientProps(e.gradient, e.width, e.height)} stroke={e.stroke} strokeWidth={e.strokeWidth} cornerRadius={e.cornerRadius} dash={dash} {...sh} />;
  if (e.type === 'ellipse') return <Ellipse {...c} x={e.x + e.width / 2} y={e.y + e.height / 2} radiusX={e.width / 2} radiusY={e.height / 2} fill={e.fill} {...gradientProps(e.gradient, e.width, e.height, true)} stroke={e.stroke} strokeWidth={e.strokeWidth} dash={dash} {...sh} />;
  if (e.type === 'line') return <Line {...c} points={[0, 0, e.width, 0]} stroke={e.stroke} strokeWidth={e.strokeWidth} hitStrokeWidth={Math.max(20, e.strokeWidth)} lineCap="round" dash={dash} {...sh} />;
  const open = e.type === 'path' && e.preset === 'squiggle';
  return (
    <Shape {...c} width={e.width} height={e.height} fill={open ? undefined : e.fill} {...(open ? {} : gradientProps(e.gradient, e.width, e.height))}
      stroke={open ? (e.stroke.endsWith('00') && e.stroke.length === 9 ? e.fill : e.stroke) : e.stroke} strokeWidth={open ? Math.max(2, e.strokeWidth || 6) : e.strokeWidth} lineCap="round" lineJoin="round" dash={dash} {...sh}
      sceneFunc={(ctx, s) => { ctx.beginPath(); shapePath(ctx, e); if (open) ctx.strokeShape(s); else ctx.fillStrokeShape(s); }} />
  );
}

/** Vuelve a dibujar cuando terminan de cargar las fuentes del documento (Konva mide al dibujar). */
export function useDocFonts(doc: DesignDoc | null | undefined) {
  const fonts = fontsOf(doc).sort().join('|');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    if (fonts) loadFonts(fonts.split('|')).then(() => alive && setTick((n) => n + 1));
    return () => { alive = false; };
  }, [fonts]);
  return tick;
}

/** Elementos visibles del documento, en orden. `common` agrega lo interactivo (solo el editor). */
export function DocNodes({ doc, q, common, fontsTick }: { doc: DesignDoc; q: string; common?: (e: El) => Record<string, any>; fontsTick?: number }) {
  // El editor pasa su propio contador (para volver a enganchar la selección tras redibujar)
  const own = useDocFonts(fontsTick === undefined ? doc : null);
  const tick = fontsTick ?? own;
  return (
    <>
      {doc.elements.filter((e) => e.visible).map((e) => {
        const c = common ? common(e) : { id: e.id, x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity, listening: false };
        if (e.type === 'text') return <TextNode key={`${e.id}:${tick}`} e={e} c={c} />;
        if (e.type === 'image') return <ImageNode key={e.id} el={e} q={q} common={c} />;
        return <ShapeNode key={e.id} e={e} c={c} />;
      })}
    </>
  );
}
