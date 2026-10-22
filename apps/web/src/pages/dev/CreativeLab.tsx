import type Konva from 'konva';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Layer, Stage } from 'react-konva';
import { type DesignDoc, loadFonts } from '../../lib/creative';
import { AssetLoaderContext, Background, DocNodes } from '../company/creative/DocRender';

/**
 * Laboratorio visual (SOLO en desarrollo, no existe en producción).
 * Dibuja las piezas que generó scripts/creative-lab.ts con el MISMO
 * renderizador del editor y las exporta al tamaño exacto, como la
 * exportación real. Las fotos son imágenes de prueba dibujadas aquí y
 * marcadas como tales: no son fotos de ninguna marca real.
 */

const HELPER = 'http://localhost:4599';

interface Case { id: string; brand: string; brandName: string; theme: string; goal: string; rank: number; family: string; format: string; adapted?: boolean; doc: DesignDoc; issues: any[] }
interface Brand { key: string; name: string; theme: string; colors: string[]; assets: Record<string, { width: number; height: number }> }

/** Imagen de prueba temática (dibujada), con la marca «IMAGEN DE PRUEBA». */
function testImage(assetId: string, brand: Brand): HTMLImageElement {
  const d = brand.assets[assetId] ?? { width: 1200, height: 1200 };
  const c = document.createElement('canvas');
  c.width = d.width;
  c.height = d.height;
  const x = c.getContext('2d')!;
  const [a, bg, acc, dark] = brand.colors;
  const W = d.width;
  const H = d.height;
  const S = Math.min(W, H);
  if (assetId.endsWith('-logo')) {
    x.fillStyle = bg; x.beginPath(); x.arc(W / 2, H / 2, S * 0.48, 0, 7); x.fill();
    x.strokeStyle = a; x.lineWidth = S * 0.03; x.stroke();
    x.fillStyle = a; x.font = `bold ${S * 0.16}px Georgia`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(brand.name.split(' ')[0], W / 2, H / 2);
  } else {
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, bg); g.addColorStop(1, acc);
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.fillStyle = 'rgba(0,0,0,0.08)';
    for (let i = 0; i < 14; i++) x.fillRect(0, (H / 14) * i, W, 2);
    const cx = W / 2;
    const cy = H / 2;
    x.save();
    if (brand.theme === 'coffee') {
      x.fillStyle = '#FBF7F2'; x.beginPath(); x.arc(cx, cy, S * 0.34, 0, 7); x.fill();
      x.fillStyle = dark; x.beginPath(); x.arc(cx, cy, S * 0.25, 0, 7); x.fill();
      x.fillStyle = '#F4E6D3'; x.beginPath(); x.ellipse(cx, cy, S * 0.1, S * 0.08, 0, 0, 7); x.fill();
    } else if (brand.theme === 'cosmetic') {
      x.fillStyle = a; x.fillRect(cx - S * 0.09, cy - S * 0.2, S * 0.18, S * 0.42);
      x.fillStyle = dark; x.fillRect(cx - S * 0.05, cy - S * 0.3, S * 0.1, S * 0.11);
      x.fillStyle = '#FFFFFF'; x.fillRect(cx - S * 0.07, cy - S * 0.02, S * 0.14, S * 0.08);
    } else if (brand.theme === 'gym') {
      x.fillStyle = dark; x.fillRect(cx - S * 0.3, cy - S * 0.03, S * 0.6, S * 0.06);
      for (const s of [-1, 1]) { x.fillRect(cx + s * S * 0.3 - S * 0.05, cy - S * 0.16, S * 0.1, S * 0.32); x.fillRect(cx + s * S * 0.2 - S * 0.03, cy - S * 0.12, S * 0.06, S * 0.24); }
    } else if (brand.theme === 'office') {
      x.fillStyle = dark; x.fillRect(cx - S * 0.32, cy + S * 0.1, S * 0.64, S * 0.04);
      x.fillStyle = a; x.fillRect(cx - S * 0.22, cy - S * 0.22, S * 0.44, S * 0.3);
      x.fillStyle = bg; x.fillRect(cx - S * 0.18, cy - S * 0.18, S * 0.36, S * 0.22);
    } else if (brand.theme === 'toys') {
      const cols = [a, acc, dark, '#FFD23F'];
      cols.forEach((col, i) => { x.fillStyle = col; x.fillRect(cx - S * 0.25 + (i % 2) * S * 0.26, cy - S * 0.22 + Math.floor(i / 2) * S * 0.24, S * 0.22, S * 0.22); });
    } else {
      x.fillStyle = a; x.beginPath(); x.ellipse(cx, cy, S * 0.12, S * 0.28, 0.6, 0, 7); x.fill();
      x.beginPath(); x.ellipse(cx + S * 0.08, cy, S * 0.12, S * 0.28, -0.6, 0, 7); x.fill();
    }
    x.restore();
    // Marca de agua: no es una foto real
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.fillRect(0, H - S * 0.07, W, S * 0.07);
    x.fillStyle = '#FFFFFF'; x.font = `${S * 0.035}px Arial`; x.textAlign = 'left'; x.textBaseline = 'middle';
    x.fillText(`IMAGEN DE PRUEBA · ${assetId}`, S * 0.03, H - S * 0.035);
  }
  const img = new Image();
  img.src = c.toDataURL('image/png');
  return img;
}

function Piece({ c, brand, onDone }: { c: Case; brand: Brand; onDone: (r: { id: string; measured: Record<string, number> }) => void }) {
  const ref = useRef<Konva.Stage>(null);
  const cache = useMemo(() => new Map<string, HTMLImageElement>(), []);
  const loader = useMemo(() => async (id: string) => {
    if (!cache.has(id)) cache.set(id, testImage(id, brand));
    const img = cache.get(id)!;
    if (!img.complete) await new Promise((r) => { img.onload = r; });
    return img;
  }, [brand, cache]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Espera a que estén todas las imágenes del documento
      const ids = c.doc.elements.filter((e) => e.type === 'image').map((e: any) => e.assetId);
      await Promise.all(ids.map((id) => loader(id)));
      await new Promise((r) => setTimeout(r, 120));
      const stage = ref.current;
      if (!stage || cancelled) return;
      // Igual que la exportación del editor: lienzo al tamaño EXACTO del formato
      const src = stage.toCanvas({ pixelRatio: 1 });
      const out = document.createElement('canvas');
      out.width = c.doc.width;
      out.height = c.doc.height;
      out.getContext('2d')!.drawImage(src, 0, 0);
      const blob: Blob = await new Promise((res) => out.toBlob((b) => res(b!), 'image/png'));
      await fetch(`${HELPER}/save?name=${encodeURIComponent(`${c.id}.png`)}`, { method: 'POST', body: blob });
      const measured: Record<string, number> = {};
      stage.find('Text').forEach((n) => { if (n.id()) measured[n.id()] = Math.round(n.height()); });
      onDone({ id: c.id, measured });
    })();
    return () => { cancelled = true; };
  }, [c, loader, onDone]);
  return (
    <AssetLoaderContext.Provider value={loader}>
      <Stage ref={ref} width={c.doc.width} height={c.doc.height}>
        <Layer><Background doc={c.doc} q="" /><DocNodes doc={c.doc} q="" /></Layer>
      </Stage>
    </AssetLoaderContext.Provider>
  );
}

export default function CreativeLab() {
  const [data, setData] = useState<{ brands: Brand[]; cases: Case[] } | null>(null);
  const [i, setI] = useState(0);
  const [ready, setReady] = useState(false);
  const measured = useRef<Record<string, Record<string, number>>>({});
  useEffect(() => { loadFonts().then(() => setReady(true)); fetch(`${HELPER}/cases`).then((r) => r.json()).then(setData); }, []);
  const onDone = useMemo(() => (r: { id: string; measured: Record<string, number> }) => {
    measured.current[r.id] = r.measured;
    setI((n) => n + 1);
  }, []);
  useEffect(() => {
    if (data && i === data.cases.length) fetch(`${HELPER}/save?name=measured.json`, { method: 'POST', body: JSON.stringify(measured.current) }).then(() => { (window as any).__labDone = true; });
  }, [i, data]);
  if (!data || !ready) return <p className="p-6">Cargando laboratorio…</p>;
  const c = data.cases[i];
  return (
    <div className="p-4 text-sm">
      <p>Laboratorio visual (desarrollo) · {Math.min(i, data.cases.length)} / {data.cases.length}</p>
      {c && <div style={{ position: 'absolute', left: -20000, top: 0 }}><Piece key={c.id} c={c} brand={data.brands.find((b) => b.key === c.brand)!} onDone={onDone} /></div>}
      {!c && <p id="lab-done">Listo.</p>}
    </div>
  );
}
