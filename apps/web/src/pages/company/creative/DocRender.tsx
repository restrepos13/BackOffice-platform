import { createContext, useContext, useEffect, useState } from 'react';
import { Ellipse, Image as KImage, Line, Rect, Text } from 'react-konva';
import { type DesignDoc, type El, type ImageEl, coverCrop, loadAsset } from '../../../lib/creative';

/**
 * Dibujo ÚNICO de un documento de diseño. Lo usan el editor (que además
 * exporta desde aquí), la vista previa de propuestas y el laboratorio
 * visual: lo que se ve en una vista previa es exactamente lo que sale en la
 * exportación.
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

export function ImageNode({ el, q, common }: { el: ImageEl; q: string; common: Record<string, any> }) {
  const { img, failed } = useAssetImage(el.assetId, q);
  if (!img) {
    // Recurso faltante: caja visible para no perder la capa
    return <Rect {...common} width={el.width} height={el.height} fill={failed ? '#F2DCDA' : '#ECE8E2'} stroke={failed ? '#B42318' : '#BBB'} strokeWidth={2} dash={[12, 8]} cornerRadius={el.cornerRadius} />;
  }
  return <KImage {...common} image={img} width={el.width} height={el.height} crop={el.crop ?? undefined} cornerRadius={el.cornerRadius} />;
}

export function Background({ doc, q }: { doc: DesignDoc; q: string }) {
  const { img } = useAssetImage(doc.background.assetId, q);
  return (
    <>
      <Rect x={0} y={0} width={doc.width} height={doc.height} fill={doc.background.color} listening={false} name="__bg" />
      {img && <KImage image={img} x={0} y={0} width={doc.width} height={doc.height} crop={coverCrop(img, doc.width, doc.height)} listening={false} />}
    </>
  );
}

/** Elementos visibles del documento, en orden. `common` agrega lo interactivo (solo el editor). */
export function DocNodes({ doc, q, common }: { doc: DesignDoc; q: string; common?: (e: El) => Record<string, any> }) {
  return (
    <>
      {doc.elements.filter((e) => e.visible).map((e) => {
        const c = common ? common(e) : { id: e.id, x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity, listening: false };
        if (e.type === 'text') return <Text key={e.id} {...c} text={e.text} width={e.width} fontFamily={e.fontFamily} fontSize={e.fontSize} fontStyle={e.fontStyle} align={e.align} lineHeight={e.lineHeight} letterSpacing={e.letterSpacing} fill={e.fill} textDecoration={e.textDecoration} wrap="word" />;
        if (e.type === 'image') return <ImageNode key={e.id} el={e} q={q} common={c} />;
        if (e.type === 'rect') return <Rect key={e.id} {...c} width={e.width} height={e.height} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth} cornerRadius={e.cornerRadius} />;
        if (e.type === 'ellipse') return <Ellipse key={e.id} {...c} x={e.x + e.width / 2} y={e.y + e.height / 2} radiusX={e.width / 2} radiusY={e.height / 2} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth} />;
        return <Line key={e.id} {...c} points={[0, 0, e.width, 0]} stroke={e.stroke} strokeWidth={e.strokeWidth} hitStrokeWidth={Math.max(20, e.strokeWidth)} lineCap="round" />;
      })}
    </>
  );
}
