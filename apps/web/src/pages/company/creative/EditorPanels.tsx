import { useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../../../lib/api';
import {
  type DesignDoc, type El, FONT_GROUPS, type FontStyle, type Gradient, IMAGE_MASKS, type ImageEl, type ImageMask, PATH_PRESETS, type PathPreset,
  SINGLE_WEIGHT_FONTS, type Shadow, type ShapeEl, type TextEl, loadFonts, newId,
} from '../../../lib/creative';
import { Button, Select } from '../../../components/ui';
import { withScope } from '../shared';

/**
 * Controles del editor ampliado (degradados, sombras, recortes, filtros,
 * frases destacadas, formas y fotos gratis). El editor les pasa su selector
 * de color, que ya respeta los colores protegidos de la marca.
 */

export type ColorPicker = (p: { value: string; onChange: (v: string) => void }) => ReactNode;
type Patch = (patch: Partial<El>) => void;

export const MASK_LABELS: Record<ImageMask, string> = {
  none: 'Rectángulo', circle: 'Círculo', pill: 'Píldora', arch: 'Arco', blob: 'Orgánica', hexagon: 'Hexágono', diamond: 'Rombo', leaf: 'Hoja', squircle: 'Redondeada',
};
const PRESET_LABELS: Record<PathPreset, string> = {
  blob: 'Mancha', blob2: 'Mancha 2', wave: 'Onda (abajo)', 'wave-top': 'Onda (arriba)', arch: 'Arco', leaf: 'Hoja', ribbon: 'Cinta', arrow: 'Flecha', bubble: 'Globo de diálogo', brush: 'Pincelada', squiggle: 'Garabato',
};

const opaque = (c: string) => c.slice(0, 7);
/** Negro o blanco, el que mejor se lea sobre un color (luminancia relativa WCAG). */
export function readableOn(hex: string) {
  const ch = (i: number) => { const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#111111' : '#FFFFFF';
}
const fade = (c: string) => `${opaque(c)}00`;

export function Num({ label, value, onChange, step = 1, min, max }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number }) {
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
  return (
    <label className="block text-[11px] text-ink-3">{label}
      <input type="number" step={step} value={Math.round(value * 100) / 100} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(clamp(Number(e.target.value)))} className="mt-0.5 w-full border-2 border-line bg-paper px-1.5 py-1 text-xs text-ink" />
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (n: number) => void }) {
  return (
    <label className="block text-[11px] text-ink-3">
      <span className="flex justify-between"><span>{label}</span><span>{Math.round(value * 100) / 100}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-ink" />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="flex border-2 border-ink text-[11px]">
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onChange(v)} className={clsx('flex-1 cursor-pointer px-1.5 py-1', value === v ? 'bg-ink text-paper' : 'bg-paper hover:bg-bone-2')}>{l}</button>
      ))}
    </div>
  );
}

export function Section({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="border-t-2 border-line pt-2">
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-ink-2">{title}</summary>
      <div className="mt-2 space-y-2">{children}</div>
    </details>
  );
}

/* ── Relleno: color sólido o degradado ── */

export function FillControl({ fill, gradient, palette, Color, onChange }: {
  fill: string; gradient?: Gradient | null; palette: string[]; Color: ColorPicker;
  onChange: (p: { fill?: string; gradient?: Gradient | undefined }) => void;
}) {
  const mode = gradient ? 'g' : 's';
  const g = gradient ?? { kind: 'linear' as const, angle: 90, stops: [{ at: 0, color: opaque(fill) }, { at: 1, color: palette.find((c) => c.toUpperCase() !== opaque(fill).toUpperCase()) ?? '#111111' }] };
  const set = (next: Partial<Gradient>) => onChange({ gradient: { ...g, ...next } });
  const setStop = (i: number, color: string) => set({ stops: g.stops.map((s, j) => (j === i ? { ...s, color } : s)) });
  const first = g.stops[0];
  const last = g.stops[g.stops.length - 1];
  const fades = last.color.length === 9 && last.color.endsWith('00');
  return (
    <div className="space-y-2">
      <Segmented value={mode} options={[['s', 'Color'], ['g', 'Degradado']]} onChange={(v) => onChange(v === 's' ? { gradient: undefined } : { gradient: g })} />
      {mode === 's' ? <Color value={fill} onChange={(v) => onChange({ fill: v })} /> : (
        <>
          <p className="text-[11px] text-ink-3">Desde</p>
          <Color value={first.color} onChange={(v) => setStop(0, v)} />
          <p className="text-[11px] text-ink-3">Hasta</p>
          {!fades && <Color value={last.color} onChange={(v) => setStop(g.stops.length - 1, v)} />}
          <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
            <input type="checkbox" checked={fades} onChange={(e) => setStop(g.stops.length - 1, e.target.checked ? fade(first.color) : palette[0] ?? '#111111')} />
            Que se desvanezca (transparente)
          </label>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="block text-[11px] text-ink-3">Tipo
              <Select value={g.kind} onChange={(e) => set({ kind: e.target.value as Gradient['kind'] })}><option value="linear">Lineal</option><option value="radial">Radial</option></Select>
            </label>
            {g.kind === 'linear' && <Num label="Ángulo" value={g.angle} min={0} max={360} step={15} onChange={(v) => set({ angle: v })} />}
          </div>
          {g.kind === 'linear' && (
            <div className="flex gap-1">
              {[[90, '↓'], [270, '↑'], [0, '→'], [180, '←'], [45, '↘'], [135, '↙']].map(([a, l]) => (
                <button key={a} type="button" onClick={() => set({ angle: Number(a) })} className={clsx('h-6 w-6 cursor-pointer border-2 text-xs', g.angle === a ? 'border-ink bg-ink text-paper' : 'border-line')}>{l}</button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Sombra ── */

const SHADOWS: Array<[string, Shadow | undefined]> = [
  ['Ninguna', undefined],
  ['Suave', { color: '#0000002E', blur: 28, x: 0, y: 10 }],
  ['Media', { color: '#00000055', blur: 36, x: 0, y: 16 }],
  ['Dura', { color: '#000000AA', blur: 0, x: 10, y: 10 }],
  ['Brillo', { color: '#FFFFFFB3', blur: 34, x: 0, y: 0 }],
];

export function ShadowControl({ value, onChange, Color }: { value?: Shadow; onChange: (s: Shadow | undefined) => void; Color: ColorPicker }) {
  const current = SHADOWS.find(([, s]) => (s ? value && s.blur === value.blur && s.x === value.x && s.y === value.y : !value))?.[0] ?? 'Personalizada';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {SHADOWS.map(([l, s]) => (
          <button key={l} type="button" onClick={() => onChange(s ? { ...s } : undefined)} className={clsx('cursor-pointer border-2 px-2 py-0.5 text-[11px]', current === l ? 'border-ink bg-ink text-paper' : 'border-line hover:border-ink')}>{l}</button>
        ))}
      </div>
      {value && (
        <>
          <Color value={opaque(value.color)} onChange={(c) => onChange({ ...value, color: `${opaque(c)}${value.color.slice(7, 9) || 'FF'}` })} />
          <div className="grid grid-cols-3 gap-1.5">
            <Num label="Difuminado" value={value.blur} min={0} max={200} onChange={(v) => onChange({ ...value, blur: v })} />
            <Num label="X" value={value.x} min={-300} max={300} onChange={(v) => onChange({ ...value, x: v })} />
            <Num label="Y" value={value.y} min={-300} max={300} onChange={(v) => onChange({ ...value, y: v })} />
          </div>
          <Slider label="Intensidad" min={0.05} max={1} step={0.05} value={value.color.length === 9 ? parseInt(value.color.slice(7, 9), 16) / 255 : 1}
            onChange={(a) => onChange({ ...value, color: `${opaque(value.color)}${Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase()}` })} />
        </>
      )}
    </div>
  );
}

/* ── Texto ── */

export function FontSelect({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  return (
    <Select value={value} onChange={(e) => { const f = e.target.value; void loadFonts([f]); onChange(f); }} style={{ fontFamily: value }}>
      {FONT_GROUPS.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.fonts.map(([f]) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
        </optgroup>
      ))}
    </Select>
  );
}

const STYLE_OPTS: Array<[FontStyle, string]> = [['normal', 'Igual'], ['bold', 'Negrita'], ['italic', 'Cursiva'], ['bold italic', 'Ambas']];

export function TextExtras({ el, palette, Color, update }: { el: TextEl; palette: string[]; Color: ColorPicker; update: Patch }) {
  const single = SINGLE_WEIGHT_FONTS.includes(el.fontFamily);
  const isUpper = el.text === el.text.toUpperCase() && /[A-ZÁÉÍÓÚÑ]/.test(el.text);
  return (
    <>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" onClick={() => update({ text: isUpper ? el.text.charAt(0) + el.text.slice(1).toLowerCase() : el.text.toUpperCase(), letterSpacing: isUpper ? 0 : Math.round(el.fontSize * 0.04) } as Partial<TextEl>)}>{isUpper ? 'Aa' : 'AA'}</Button>
        <Select value={el.textDecoration} onChange={(e) => update({ textDecoration: e.target.value as TextEl['textDecoration'] } as Partial<TextEl>)}>
          <option value="">Sin subrayado</option><option value="underline">Subrayado</option><option value="line-through">Tachado</option>
        </Select>
      </div>
      {single && /bold/.test(el.fontStyle) && <p className="text-[11px] text-warn">{el.fontFamily} tiene un solo grosor: la negrita se simula.</p>}
      <Section title="Color del texto" open>
        <FillControl fill={el.fill} gradient={el.gradient} palette={palette} Color={Color} onChange={(p) => update(p as Partial<TextEl>)} />
      </Section>
      <Section title="Frase destacada">
        <p className="text-[11px] text-ink-3">Escribe una palabra o frase del texto para darle otro color, otro estilo o un resaltador.</p>
        <input value={el.accent?.text ?? ''} placeholder="Ej.: 30 % menos" onChange={(e) => update({ accent: e.target.value.trim() ? { text: e.target.value.slice(0, 200), color: el.accent?.color ?? palette[1] ?? palette[0] ?? '#E8A33D', marker: el.accent?.marker ?? null, style: el.accent?.style ?? 'normal' } : undefined } as Partial<TextEl>)}
          className="w-full border-2 border-line bg-paper px-2 py-1 text-xs" />
        {el.accent && !el.text.toLowerCase().includes(el.accent.text.toLowerCase()) && <p className="text-[11px] text-warn">Esa frase no está en el texto.</p>}
        {el.accent && (
          <>
            <Color value={el.accent.color} onChange={(v) => update({ accent: { ...el.accent!, color: v } } as Partial<TextEl>)} />
            <Segmented value={el.accent.style} options={STYLE_OPTS} onChange={(v) => update({ accent: { ...el.accent!, style: v } } as Partial<TextEl>)} />
            <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
              <input type="checkbox" checked={!!el.accent.marker} onChange={(e) => {
                // Con resaltador, la frase pasa a un color que se lea encima (y vuelve al de antes al quitarlo)
                const marker = e.target.checked ? (palette.find((c) => c.toUpperCase() !== el.accent!.color.toUpperCase()) ?? '#FFE066') : null;
                update({ accent: { ...el.accent!, marker, color: marker ? readableOn(marker) : el.accent!.color } } as Partial<TextEl>);
              }} />
              Resaltador detrás
            </label>
            {el.accent.marker && <Color value={el.accent.marker} onChange={(v) => update({ accent: { ...el.accent!, marker: v } } as Partial<TextEl>)} />}
          </>
        )}
      </Section>
      <Section title="Caja de fondo">
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
          <input type="checkbox" checked={!!el.background} onChange={(e) => update({ background: e.target.checked ? { color: palette[0] ?? '#111111', padX: Math.round(el.fontSize * 0.5), padY: Math.round(el.fontSize * 0.25), radius: Math.round(el.fontSize * 0.3) } : undefined } as Partial<TextEl>)} />
          Poner una caja de color detrás (etiquetas, botones)
        </label>
        {el.background && (
          <>
            <Color value={el.background.color} onChange={(v) => update({ background: { ...el.background!, color: v } } as Partial<TextEl>)} />
            <div className="grid grid-cols-3 gap-1.5">
              <Num label="Margen lados" value={el.background.padX} min={0} max={300} onChange={(v) => update({ background: { ...el.background!, padX: v } } as Partial<TextEl>)} />
              <Num label="Margen arriba" value={el.background.padY} min={0} max={300} onChange={(v) => update({ background: { ...el.background!, padY: v } } as Partial<TextEl>)} />
              <Num label="Esquinas" value={el.background.radius} min={0} max={500} onChange={(v) => update({ background: { ...el.background!, radius: v } } as Partial<TextEl>)} />
            </div>
          </>
        )}
      </Section>
      <Section title="Contorno de letras">
        <Color value={el.stroke ?? '#111111'} onChange={(v) => update({ stroke: v, strokeWidth: el.strokeWidth || Math.max(2, Math.round(el.fontSize * 0.04)) } as Partial<TextEl>)} />
        <Num label="Grosor (0 = sin contorno)" value={el.strokeWidth ?? 0} min={0} max={40} onChange={(v) => update(v ? { strokeWidth: v, stroke: el.stroke ?? '#111111' } as Partial<TextEl> : { strokeWidth: undefined, stroke: undefined } as Partial<TextEl>)} />
      </Section>
    </>
  );
}

/* ── Formas ── */

export function ShapeExtras({ el, palette, Color, update }: { el: ShapeEl; palette: string[]; Color: ColorPicker; update: Patch }) {
  return (
    <>
      {el.type !== 'line' && !(el.type === 'path' && el.preset === 'squiggle') && (
        <Section title="Relleno" open>
          <FillControl fill={el.fill} gradient={el.gradient} palette={palette} Color={Color} onChange={(p) => update(p as Partial<ShapeEl>)} />
        </Section>
      )}
      <Section title={el.type === 'line' || el.preset === 'squiggle' ? 'Trazo' : 'Borde'} open={el.type === 'line'}>
        <Color value={el.stroke.length === 9 && el.stroke.endsWith('00') ? (palette[0] ?? '#111111') : el.stroke} onChange={(v) => update({ stroke: v, strokeWidth: el.strokeWidth || 4 } as Partial<ShapeEl>)} />
        <div className="grid grid-cols-2 gap-1.5">
          <Num label="Grosor" value={el.strokeWidth} min={0} max={100} onChange={(v) => update({ strokeWidth: v } as Partial<ShapeEl>)} />
          {el.type === 'rect' && <Num label="Esquinas" value={el.cornerRadius} min={0} max={1000} onChange={(v) => update({ cornerRadius: v } as Partial<ShapeEl>)} />}
        </div>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2"><input type="checkbox" checked={!!el.dash} onChange={(e) => update({ dash: e.target.checked || undefined } as Partial<ShapeEl>)} /> Línea punteada</label>
      </Section>
      {el.type === 'polygon' && <Num label="Lados" value={el.sides ?? 6} min={3} max={12} onChange={(v) => update({ sides: Math.round(v) } as Partial<ShapeEl>)} />}
      {el.type === 'star' && (
        <div className="grid grid-cols-2 gap-1.5">
          <Num label="Puntas" value={el.points ?? 5} min={3} max={40} onChange={(v) => update({ points: Math.round(v) } as Partial<ShapeEl>)} />
          <Num label="Profundidad" value={el.innerRatio ?? 0.5} min={0.2} max={0.95} step={0.05} onChange={(v) => update({ innerRatio: v } as Partial<ShapeEl>)} />
        </div>
      )}
      {el.type === 'path' && (
        <Select value={el.preset ?? 'blob'} onChange={(e) => update({ preset: e.target.value as PathPreset } as Partial<ShapeEl>)}>
          {PATH_PRESETS.map((p) => <option key={p} value={p}>{PRESET_LABELS[p]}</option>)}
        </Select>
      )}
    </>
  );
}

/* ── Imágenes ── */

export function ImageExtras({ el, Color, update }: { el: ImageEl; Color: ColorPicker; update: Patch }) {
  const f = el.filters ?? { brightness: 0, contrast: 0, saturation: 0, blur: 0, grayscale: false };
  const setF = (p: Partial<typeof f>) => {
    const n = { ...f, ...p };
    update({ filters: n.brightness || n.contrast || n.saturation || n.blur || n.grayscale ? n : undefined } as Partial<ImageEl>);
  };
  return (
    <>
      <Section title="Forma de la foto" open>
        <div className="grid grid-cols-3 gap-1">
          {IMAGE_MASKS.map((m) => (
            <button key={m} type="button" onClick={() => update({ mask: m === 'none' ? undefined : m } as Partial<ImageEl>)} className={clsx('cursor-pointer border-2 px-1 py-1 text-[11px]', (el.mask ?? 'none') === m ? 'border-ink bg-ink text-paper' : 'border-line hover:border-ink')}>{MASK_LABELS[m]}</button>
          ))}
        </div>
        {(el.mask ?? 'none') === 'none' && <Num label="Esquinas" value={el.cornerRadius} min={0} max={1000} onChange={(v) => update({ cornerRadius: v } as Partial<ImageEl>)} />}
      </Section>
      <Section title="Ajustes de color">
        <Slider label="Brillo" min={-0.5} max={0.5} step={0.02} value={f.brightness} onChange={(v) => setF({ brightness: v })} />
        <Slider label="Contraste" min={-60} max={60} step={2} value={f.contrast} onChange={(v) => setF({ contrast: v })} />
        <Slider label="Saturación" min={-2} max={2} step={0.1} value={f.saturation} onChange={(v) => setF({ saturation: v })} />
        <Slider label="Desenfoque" min={0} max={40} step={1} value={f.blur} onChange={(v) => setF({ blur: v })} />
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2"><input type="checkbox" checked={f.grayscale} onChange={(e) => setF({ grayscale: e.target.checked })} /> Blanco y negro</label>
        {el.filters && <Button size="sm" variant="ghost" onClick={() => update({ filters: undefined } as Partial<ImageEl>)}>Quitar ajustes</Button>}
      </Section>
      <Section title="Borde y espejo">
        <Color value={el.stroke ?? '#FFFFFF'} onChange={(v) => update({ stroke: v, strokeWidth: el.strokeWidth || 8 } as Partial<ImageEl>)} />
        <Num label="Grosor del borde (0 = sin borde)" value={el.strokeWidth ?? 0} min={0} max={100} onChange={(v) => update(v ? { strokeWidth: v, stroke: el.stroke ?? '#FFFFFF' } as Partial<ImageEl> : { strokeWidth: undefined, stroke: undefined } as Partial<ImageEl>)} />
        <label className="flex items-center gap-1.5 text-[11px] text-ink-2"><input type="checkbox" checked={!!el.flipX} onChange={(e) => update({ flipX: e.target.checked || undefined } as Partial<ImageEl>)} /> Voltear horizontal</label>
      </Section>
    </>
  );
}

/* ── Fondo del lienzo ── */

export function BackgroundExtras({ doc, palette, Color, commit }: { doc: DesignDoc; palette: string[]; Color: ColorPicker; commit: (d: DesignDoc) => void }) {
  const bg = doc.background;
  const ov = bg.overlay;
  return (
    <div className="space-y-2">
      <FillControl fill={bg.color} gradient={bg.gradient} palette={palette} Color={Color} onChange={(p) => commit({ ...doc, background: { ...bg, ...(p.fill ? { color: p.fill } : {}), gradient: 'gradient' in p ? p.gradient ?? null : bg.gradient } })} />
      {bg.assetId && (
        <>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-2">
            <input type="checkbox" checked={!!ov} onChange={(e) => commit({ ...doc, background: { ...bg, overlay: e.target.checked ? { color: '#000000', gradient: null, opacity: 0.4 } : null } })} />
            Velo sobre la foto de fondo (para que el texto se lea)
          </label>
          {ov && (
            <>
              <FillControl fill={ov.color} gradient={ov.gradient} palette={palette} Color={Color} onChange={(p) => commit({ ...doc, background: { ...bg, overlay: { ...ov, ...(p.fill ? { color: p.fill } : {}), gradient: 'gradient' in p ? p.gradient ?? null : ov.gradient } } })} />
              <Slider label="Opacidad del velo" min={0} max={1} step={0.05} value={ov.opacity} onChange={(v) => commit({ ...doc, background: { ...bg, overlay: { ...ov, opacity: v } } })} />
            </>
          )}
        </>
      )}
    </div>
  );
}

/* ── Catálogo de formas para agregar ── */

export function shapeCatalog(doc: DesignDoc, palette: string[]): Array<{ label: string; make: () => El }> {
  const S = Math.min(doc.width, doc.height);
  const c0 = palette[0] ?? '#1F3A5F';
  const c1 = palette[1] ?? palette[0] ?? '#E8A33D';
  const base = (name: string, w: number, h: number) => ({ id: newId('s'), name, x: Math.round((doc.width - w) / 2), y: Math.round((doc.height - h) / 2), width: Math.round(w), height: Math.round(h), rotation: 0, opacity: 1, visible: true, locked: false, stroke: '#00000000', strokeWidth: 0, cornerRadius: 0 });
  const shape = (name: string, type: ShapeEl['type'], w: number, h: number, extra: Partial<ShapeEl> = {}): (() => El) => () => ({ ...base(name, w, h), type, fill: c0, ...extra } as ShapeEl);
  return [
    { label: 'Rectángulo', make: shape('Rectángulo', 'rect', S * 0.4, S * 0.25) },
    { label: 'Redondeado', make: shape('Rectángulo', 'rect', S * 0.4, S * 0.25, { cornerRadius: Math.round(S * 0.04) }) },
    { label: 'Círculo', make: shape('Círculo', 'ellipse', S * 0.3, S * 0.3, { fill: c1 }) },
    { label: 'Línea', make: shape('Línea', 'line', S * 0.6, 0, { fill: '#00000000', stroke: '#111111', strokeWidth: 6 }) },
    { label: 'Triángulo', make: shape('Triángulo', 'polygon', S * 0.3, S * 0.28, { sides: 3 }) },
    { label: 'Hexágono', make: shape('Hexágono', 'polygon', S * 0.3, S * 0.3, { sides: 6 }) },
    { label: 'Estrella', make: shape('Estrella', 'star', S * 0.3, S * 0.3, { points: 5, innerRatio: 0.45, fill: c1 }) },
    { label: 'Sello de oferta', make: shape('Sello', 'star', S * 0.3, S * 0.3, { points: 24, innerRatio: 0.86, fill: c1 }) },
    ...PATH_PRESETS.map((p) => ({
      label: PRESET_LABELS[p],
      make: shape(PRESET_LABELS[p], 'path', p.startsWith('wave') ? doc.width : S * 0.35, p.startsWith('wave') ? S * 0.25 : p === 'ribbon' || p === 'brush' ? S * 0.12 : p === 'squiggle' ? S * 0.06 : p === 'arrow' ? S * 0.18 : S * 0.35,
        { preset: p, fill: p === 'blob' || p === 'blob2' ? c1 : c0, ...(p === 'squiggle' ? { stroke: c0, strokeWidth: Math.round(S * 0.008) } : {}) }),
    })),
  ];
}

/* ── Fotos gratis (Pexels) ── */

interface StockPhoto { id: number; width: number; height: number; alt: string; photographer: string; photographerUrl: string; url: string; thumb: string; avgColor: string | null }
interface StockAsset { id: string; name: string; kind: string; width: number | null; height: number | null }

export function StockPhotos({ q, onPick }: { q: string; onPick: (a: StockAsset) => void }) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [orientation, setOrientation] = useState('');
  const [page, setPage] = useState(1);
  const search = useQuery({
    queryKey: ['stock', q, query, orientation, page],
    enabled: !!query,
    queryFn: () => api.get<{ configured: boolean; photos: StockPhoto[]; hasMore: boolean }>(withScope(`/creative/stock/search?q=${encodeURIComponent(query)}&page=${page}${orientation ? `&orientation=${orientation}` : ''}`, q)),
    staleTime: 5 * 60_000,
  });
  const status = useQuery({ queryKey: ['stock-status', q], queryFn: () => api.get<{ configured: boolean }>(withScope('/creative/stock/status', q)), staleTime: 60_000 });
  const take = useMutation({
    mutationFn: (p: StockPhoto) => api.post<StockAsset>(withScope('/creative/stock/import', q), { id: p.id }),
    onSuccess: onPick,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo traer la foto'),
  });
  if (status.data && !status.data.configured) {
    return <p className="text-sm text-ink-3">Las fotos gratis de Pexels todavía no están activadas en BackOffice. Mientras tanto, sube tus propias fotos.</p>;
  }
  return (
    <div className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(text.trim()); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Busca: café, familia, casa campestre, playa…" className="min-w-0 flex-1 border-2 border-ink bg-paper px-2 py-1.5 text-sm" />
        <Select value={orientation} onChange={(e) => { setOrientation(e.target.value); setPage(1); }}>
          <option value="">Cualquier forma</option><option value="square">Cuadradas</option><option value="portrait">Verticales</option><option value="landscape">Horizontales</option>
        </Select>
        <Button size="sm" type="submit" disabled={!text.trim()}><Search size={13} /> Buscar</Button>
      </form>
      <p className="text-[11px] text-ink-3">
        Fotos gratuitas de <a href="https://www.pexels.com" target="_blank" rel="noreferrer" className="underline">Pexels</a>, con permiso de uso comercial. Son de referencia: no las uses para mostrar como tuyo un producto, un lugar o un resultado que no lo es.
      </p>
      {search.isLoading && <p className="text-sm text-ink-3">Buscando…</p>}
      {search.error && <p className="text-sm text-bad">{search.error instanceof Error ? search.error.message : 'Error'}</p>}
      {search.data && (
        <>
          <div className="grid max-h-[46vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
            {search.data.photos.map((p) => (
              <button key={p.id} type="button" disabled={take.isPending} onClick={() => take.mutate(p)} className="group relative cursor-pointer overflow-hidden border-2 border-line text-left hover:border-ink" style={{ background: p.avgColor ?? '#ECE8E2' }}>
                <img src={p.thumb} alt={p.alt || 'Foto de Pexels'} loading="lazy" className="aspect-[4/3] w-full object-cover" />
                <span className="absolute inset-x-0 bottom-0 truncate bg-ink/70 px-1.5 py-0.5 text-[10px] text-paper">Foto: {p.photographer}</span>
              </button>
            ))}
          </div>
          {!search.data.photos.length && <p className="text-sm text-ink-3">No encontramos fotos. Prueba con otras palabras (en español o en inglés).</p>}
          <div className="flex justify-between">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Anteriores</Button>
            {take.isPending && <span className="text-xs text-ink-3">Trayendo la foto a tu biblioteca…</span>}
            <Button size="sm" variant="outline" disabled={!search.data.hasMore} onClick={() => setPage((n) => n + 1)}>Más fotos</Button>
          </div>
        </>
      )}
    </div>
  );
}
