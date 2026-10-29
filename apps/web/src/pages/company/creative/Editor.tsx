import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type Konva from 'konva';
import {
  ArrowDown, ArrowLeft, ArrowUp, Bold, Circle, Copy, Download, Eye, EyeOff, FolderOpen, ImagePlus, Italic, Lock, Megaphone, Minus, Redo2,
  Save, Send, Square, Trash2, Type, Undo2, Unlock,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ellipse, Image as KImage, Layer, Line, Rect, Stage, Text, Transformer } from 'react-konva';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { api, uploadFile } from '../../../lib/api';
import {
  CATEGORY_LABELS, type DesignDoc, type El, FONTS, FORMATS, type FormatKey, History, type ImageEl, type ShapeEl, type TextEl,
  coverCrop, loadAsset, loadFonts, newId,
} from '../../../lib/creative';
import { Badge, Button, Field, Input, Loading, Modal, Select, Textarea } from '../../../components/ui';
import { useCompanyScope, withScope } from '../shared';
import { Background, DocNodes, useAssetImage } from './DocRender';

/**
 * Editor visual por capas de BackOffice Creative. Todo lo determinista
 * (mover, editar texto, colores, capas, guardar, exportar) es código: no hay
 * IA aquí. El documento se valida de nuevo en el servidor al guardar.
 */

interface DesignRes { id: string; name: string; format: FormatKey; version: number; doc: DesignDoc; composition?: { family: string } | null }
interface Issue { code: string; severity: 'BLOCK' | 'WARN' | 'INFO'; kind: 'VERIFIED' | 'HEURISTIC'; message: string; elementId?: string }
interface Brand { name: string; colors: Array<{ hex: string; label: string }>; logos: Array<{ assetId: string; label: string }>; protected: { logo?: boolean; colors?: boolean }; ctas: string[] }
interface Asset { id: string; name: string; kind: string; width: number | null; height: number | null }

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export { Background, ImageNode } from './DocRender';

export default function Editor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { q, canWrite } = useCompanyScope();
  const { data: loaded, isLoading, error } = useQuery({ queryKey: ['design', id], queryFn: () => api.get<DesignRes>(`/creative/designs/${id}`), staleTime: Infinity });
  const { data: brand } = useQuery({ queryKey: ['brand', q], queryFn: () => api.get<Brand>(withScope('/creative/brand', q)) });
  const { data: assets } = useQuery({ queryKey: ['brand-assets', q], queryFn: () => api.get<Asset[]>(withScope('/creative/assets', q)) });

  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [fontsReady, setFontsReady] = useState(false);
  const [recover, setRecover] = useState<DesignDoc | null>(null);
  const [imagePicker, setImagePicker] = useState(false);
  const [toCalendar, setToCalendar] = useState(false);
  const history = useRef(new History());
  const [, force] = useState(0);
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 600 });
  const draftKey = `creative-draft-${id}`;

  useEffect(() => { loadFonts().then(() => setFontsReady(true)); }, []);

  // Carga y recuperación de cambios sin guardar (si el navegador se cerró)
  useEffect(() => {
    if (!loaded) return;
    setDoc(loaded.doc);
    setName(loaded.name);
    setVersion(loaded.version);
    versionRef.current = loaded.version;
    savedDoc.current = loaded.doc;
    savedName.current = loaded.name;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        if (d.version === loaded.version && JSON.stringify(d.doc) !== JSON.stringify(loaded.doc)) setRecover(d.doc);
      }
    } catch { /* sin almacenamiento local */ }
  }, [loaded, draftKey]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc?.format]);

  const scale = doc ? Math.min((box.w - 32) / doc.width, (box.h - 32) / doc.height, 1) : 1;
  const sel = doc?.elements.find((e) => e.id === selected) ?? null;
  const isProtected = useCallback((e: El | null) => !!e && e.role === 'logo' && !!brand?.protected?.logo, [brand]);
  const palette = useMemo(() => brand?.colors.map((c) => c.hex) ?? [], [brand]);
  // Edición rápida: textos y fotos editables sin tocar el lienzo (orden de lectura: de arriba hacia abajo)
  const quickTexts = useMemo(() => (doc?.elements ?? []).filter((e) => e.type === 'text' && e.visible && !e.locked).sort((a, b) => a.y - b.y), [doc]);
  const quickPhotos = useMemo(() => (doc?.elements ?? []).filter((e) => e.visible && !e.locked && e.role !== 'logo' && (e.type === 'image' || (e.type === 'rect' && e.role === 'photo'))), [doc]);

  /* ── Cambios (con historial) ── */
  const editSent = useRef(false);
  const commit = useCallback((next: DesignDoc) => {
    setDoc((cur) => {
      if (cur) history.current.push(cur);
      return next;
    });
    setSaveState('dirty');
    force((n) => n + 1);
    // Primer cambio manual sobre una propuesta de dirección de arte (una vez por sesión)
    if (!editSent.current && loaded?.composition && canWrite) {
      editSent.current = true;
      void api.post(withScope('/creative/design-events', q), { type: 'manual_edit', designId: id }).catch(() => undefined);
    }
  }, [loaded, canWrite, q, id]);
  const update = useCallback((elId: string, patch: Partial<El>) => {
    if (!doc) return;
    commit({ ...doc, elements: doc.elements.map((e) => (e.id === elId ? ({ ...e, ...patch } as El) : e)) });
  }, [doc, commit]);
  const addEl = (el: El) => {
    if (!doc) return;
    if (doc.elements.length >= 150) return toast.error('Máximo 150 elementos por diseño');
    commit({ ...doc, elements: [...doc.elements, el] });
    setSelected(el.id);
  };
  const removeSel = () => {
    if (!doc || !sel) return;
    if (isProtected(sel)) return toast.error('El logo está protegido por la configuración de tu marca');
    commit({ ...doc, elements: doc.elements.filter((e) => e.id !== sel.id) });
    setSelected(null);
  };
  const duplicateSel = () => {
    if (!doc || !sel) return;
    addEl({ ...sel, id: newId(sel.type[0]), name: `${sel.name} copia`, x: sel.x + 30, y: sel.y + 30, locked: false } as El);
  };
  const move = (dir: 'up' | 'down' | 'top' | 'bottom') => {
    if (!doc || !sel) return;
    const els = doc.elements.filter((e) => e.id !== sel.id);
    const i = doc.elements.findIndex((e) => e.id === sel.id);
    const at = dir === 'top' ? els.length : dir === 'bottom' ? 0 : dir === 'up' ? Math.min(els.length, i + 1) : Math.max(0, i - 1);
    els.splice(at, 0, sel);
    commit({ ...doc, elements: els });
  };
  const undo = () => { if (!doc) return; const p = history.current.undo(doc); if (p) { setDoc(p); setSaveState('dirty'); force((n) => n + 1); } };
  const redo = () => { if (!doc) return; const n = history.current.redo(doc); if (n) { setDoc(n); setSaveState('dirty'); force((x) => x + 1); } };

  /* ── Guardado automático con control de versión ── */
  // La versión guardada y el documento que corresponde a ella (refs: las exportaciones las leen tras esperar el guardado)
  const versionRef = useRef(1);
  const savedDoc = useRef<DesignDoc | null>(null);
  const savedName = useRef('');
  const inflight = useRef<Promise<number | null> | null>(null);
  /** Guarda el documento actual; devuelve la versión guardada o null si no se pudo. */
  const save = useCallback(async (): Promise<number | null> => {
    if (!doc || !canWrite) return null;
    // Un guardado en curso se espera (antes se ignoraba y la exportación seguía sin esperar)
    while (inflight.current) await inflight.current;
    if (doc === savedDoc.current && name === savedName.current) return versionRef.current;
    const run = (async () => {
      setSaveState('saving');
      try {
        const r = await api.put<{ version: number }>(`/creative/designs/${id}`, { doc, expectedVersion: versionRef.current, name });
        versionRef.current = r.version;
        savedDoc.current = doc;
        savedName.current = name;
        setVersion(r.version);
        setSaveState('saved');
        try { localStorage.removeItem(draftKey); } catch { /* nada */ }
        return r.version;
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        setSaveState(/otra pestaña|otra persona/.test(msg) ? 'conflict' : 'error');
        if (!/otra pestaña/.test(msg)) toast.error(msg || 'No se pudo guardar');
        return null;
      }
    })();
    inflight.current = run;
    try { return await run; } finally { inflight.current = null; }
  }, [doc, id, name, canWrite, draftKey]);

  /** Antes de exportar o compartir: lo que se exporta tiene que estar guardado (y se dice qué versión es). */
  const ensureSaved = async () => {
    const v = await save();
    if (v == null) throw new Error('No se pudo guardar el diseño, así que no exportamos una versión sin guardar. Revisa el aviso de guardado e intenta de nuevo.');
    return v;
  };

  useEffect(() => {
    if (saveState !== 'dirty' || !doc) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ doc, version, at: Date.now() })); } catch { /* nada */ }
    const t = setTimeout(save, 1500);
    return () => clearTimeout(t);
  }, [doc, saveState, save, draftKey, version]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (saveState === 'dirty' || saveState === 'saving') { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  /* ── Teclado ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSel(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !sel.locked) { e.preventDefault(); removeSel(); }
      else if (sel && !sel.locked && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        update(sel.id, { x: sel.x + dx, y: sel.y + dy });
      } else if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Transformer sobre la capa seleccionada (no sobre capas bloqueadas o protegidas)
  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const node = sel && !sel.locked && !isProtected(sel) ? stage.findOne(`#${sel.id}`) : null;
    tr.nodes(node ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [sel, doc, isProtected]);

  /* ── Exportar ── */
  const renderBlob = async (mime: 'image/png' | 'image/jpeg'): Promise<Blob> => {
    const stage = stageRef.current!;
    const prev = selected;
    setSelected(null);
    trRef.current?.nodes([]);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const src = stage.toCanvas({ pixelRatio: 1 / scale });
    // Tamaño EXACTO del formato (el servidor lo exige)
    const out = document.createElement('canvas');
    out.width = doc!.width;
    out.height = doc!.height;
    out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
    setSelected(prev);
    return new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo exportar'))), mime, 0.92));
  };
  const exportMut = useMutation({
    mutationFn: async (mime: 'image/png' | 'image/jpeg') => {
      const v = await ensureSaved();
      const blob = await renderBlob(mime);
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${(name || 'diseno').replace(/[^\w-]+/g, '-')}.${ext}`;
      a.click();
      await uploadFile(withScope(`/creative/designs/${id}/export`, ''), 'file', new File([blob], `export.${ext}`, { type: mime }), { expectedVersion: String(v) });
    },
    onSuccess: () => {
      toast.success('Imagen exportada');
      // Primer resultado útil (para medir el tiempo hasta el primer valor)
      if (canWrite) api.post(withScope('/creative/events', q), { type: 'first_value' }).catch(() => undefined);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error al exportar'),
  });

  // Biblioteca compartida: guarda ESTA versión como recurso (la anterior queda intacta) sin descargar nada
  const toLibrary = useMutation({
    mutationFn: async () => {
      const v = await ensureSaved();
      const r = await api.post<{ blocking: boolean }>(`/creative/designs/${id}/check`, { doc, forExport: true });
      if (r.blocking) throw new Error('Hay problemas por corregir (usa «Revisar y exportar» para verlos).');
      const blob = await renderBlob('image/png');
      await uploadFile(withScope(`/creative/designs/${id}/export`, q), 'file', new File([blob], 'export.png', { type: 'image/png' }), { expectedVersion: String(v) });
      return api.post<{ created: boolean }>(withScope(`/library/from-design/${id}`, q));
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      toast.success(r.created ? 'Esta versión quedó en la Biblioteca' : 'Esta versión ya estaba en la Biblioteca', {
        action: { label: 'Ver', onClick: () => navigate('/app/biblioteca') },
      });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo llevar a la Biblioteca'),
  });

  // Del diseño al flujo de Ads: misma exportación que la biblioteca y Ads valida y crea en pausa
  const toAds = useMutation({
    mutationFn: async () => {
      const v = await ensureSaved();
      const r = await api.post<{ blocking: boolean }>(`/creative/designs/${id}/check`, { doc, forExport: true, forAds: true });
      if (r.blocking) throw new Error('Hay problemas por corregir antes de usarla en un anuncio (usa «Revisar y exportar» para verlos).');
      const blob = await renderBlob('image/png');
      await uploadFile(withScope(`/creative/designs/${id}/export`, q), 'file', new File([blob], 'export.png', { type: 'image/png' }), { expectedVersion: String(v) });
      return api.post<{ asset: { id: string }; ads: { contracted: boolean; connected: boolean; url: string | null; note: string | null } }>(withScope(`/creative/create/to-ads/${id}`, q));
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['library'] });
      if (r.ads.url) navigate(r.ads.url);
      else toast.info(r.ads.note ?? 'La imagen quedó en tu biblioteca.', { action: { label: 'Ver', onClick: () => navigate('/app/biblioteca') } });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo preparar la imagen para Ads'),
  });

  const adapt = useMutation({
    mutationFn: async (to: FormatKey) => {
      await ensureSaved();
      return api.post<{ id: string; method: 'RECOMPOSED' | 'SCALED' }>(`/creative/designs/${id}/adapt`, { format: to });
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ['designs'] });
      toast.success(r.method === 'RECOMPOSED' ? 'Copia recompuesta para el nuevo formato, con tus textos y fotos.' : 'Copia escalada (diseño anterior a la dirección de arte): revisa los avisos al exportar.');
      navigate(`/app/creative/editor/${r.id}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });

  /* ── Revisión antes de exportar (vista previa fiel + control de calidad) ── */
  const [review, setReview] = useState<{ url: string; issues: Issue[]; blocking: boolean } | null>(null);
  const openReview = useMutation({
    mutationFn: async () => {
      await ensureSaved();
      const blob = await renderBlob('image/png');
      // Altura real de cada texto tal como lo dibuja el lienzo (manda sobre la estimación del servidor)
      const measured: Record<string, number> = {};
      stageRef.current?.find('Text').forEach((n) => { if (n.id()) measured[n.id()] = Math.round(n.height()); });
      const r = await api.post<{ issues: Issue[]; blocking: boolean }>(`/creative/designs/${id}/check`, { doc, measured, forExport: true });
      return { url: URL.createObjectURL(blob), ...r };
    },
    onSuccess: setReview,
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo revisar'),
  });

  if (isLoading) return <Loading label="Abriendo tu diseño…" />;
  if (error || !loaded) return <p className="p-6 text-sm">No se pudo abrir el diseño. <Link className="underline" to="/app/creative">Volver</Link></p>;
  if (!doc) return <Loading label="Preparando el lienzo…" />;

  const common = (e: El) => ({
    id: e.id, x: e.x, y: e.y, rotation: e.rotation, opacity: e.opacity,
    draggable: canWrite && !e.locked && !isProtected(e),
    onMouseDown: () => setSelected(e.id),
    onTap: () => setSelected(e.id),
    onDragEnd: (ev: Konva.KonvaEventObject<DragEvent>) => update(e.id, e.type === 'ellipse' ? { x: Math.round(ev.target.x() - e.width / 2), y: Math.round(ev.target.y() - e.height / 2) } : { x: Math.round(ev.target.x()), y: Math.round(ev.target.y()) }),
    onTransformEnd: (ev: Konva.KonvaEventObject<Event>) => {
      const n = ev.target;
      const sx = n.scaleX();
      const sy = n.scaleY();
      n.scaleX(1);
      n.scaleY(1);
      const width = Math.max(5, Math.round(e.width * sx));
      const height = Math.max(e.type === 'line' ? 0 : 5, Math.round(e.height * sy));
      const patch: Partial<El> = { rotation: Math.round(n.rotation()), width, height };
      if (e.type === 'ellipse') Object.assign(patch, { x: Math.round(n.x() - width / 2), y: Math.round(n.y() - height / 2) });
      else Object.assign(patch, { x: Math.round(n.x()), y: Math.round(n.y()) });
      if (e.type === 'text') Object.assign(patch, { fontSize: Math.max(6, Math.round((e as TextEl).fontSize * sy)) });
      update(e.id, patch);
    },
  });

  const status: Record<SaveState, { t: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' }> = {
    saved: { t: 'Guardado', tone: 'ok' }, dirty: { t: 'Cambios sin guardar', tone: 'warn' }, saving: { t: 'Guardando…', tone: 'neutral' },
    error: { t: 'Error al guardar', tone: 'bad' }, conflict: { t: 'Otra pestaña lo cambió', tone: 'bad' },
  };

  const ColorInput = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div className="flex flex-wrap items-center gap-1">
      {palette.map((c) => <button key={c} type="button" title={c} onClick={() => onChange(c)} className={clsx('h-6 w-6 cursor-pointer border-2', value.toUpperCase() === c.toUpperCase() ? 'border-ink' : 'border-line')} style={{ background: c }} />)}
      {!brand?.protected?.colors && <input type="color" aria-label="Color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-7 w-9 cursor-pointer border-2 border-ink bg-paper" />}
      {brand?.protected?.colors && <span className="text-[11px] text-ink-3">Colores de marca protegidos</span>}
    </div>
  );

  const num = (label: string, v: number, onChange: (n: number) => void, step = 1) => (
    <label className="block text-[11px] text-ink-3">{label}
      <input type="number" step={step} value={Math.round(v * 100) / 100} onChange={(e) => Number.isFinite(Number(e.target.value)) && onChange(Number(e.target.value))} className="mt-0.5 w-full border-2 border-line bg-paper px-1.5 py-1 text-xs text-ink" />
    </label>
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bone">
      {/* Barra superior */}
      <header className="flex flex-wrap items-center gap-2 border-b-2 border-ink bg-paper px-3 py-2">
        <Link to="/app/creative" className="inline-flex items-center gap-1 text-sm underline"><ArrowLeft size={14} /> Creative</Link>
        <input value={name} disabled={!canWrite} onChange={(e) => { setName(e.target.value); setSaveState('dirty'); }} className="min-w-0 flex-1 border-2 border-transparent bg-transparent px-2 py-1 text-sm font-semibold hover:border-line focus:border-ink" aria-label="Nombre del diseño" />
        <Badge tone={status[saveState].tone}>{status[saveState].t}</Badge>
        <span className="hidden text-xs text-ink-3 sm:inline">{FORMATS[doc.format].label} · {doc.width}×{doc.height} · v{version}</span>
        <Button size="sm" variant="ghost" disabled={!history.current.canUndo} onClick={undo} aria-label="Deshacer"><Undo2 size={14} /></Button>
        <Button size="sm" variant="ghost" disabled={!history.current.canRedo} onClick={redo} aria-label="Rehacer"><Redo2 size={14} /></Button>
        {canWrite && <Button size="sm" variant="outline" disabled={saveState === 'saving'} onClick={() => void save()}><Save size={14} /> Guardar</Button>}
        <Button size="sm" variant="outline" disabled={openReview.isPending || exportMut.isPending} onClick={() => openReview.mutate()}><Download size={14} /> {openReview.isPending ? 'Revisando…' : 'Revisar y exportar'}</Button>
        {canWrite && <Button size="sm" variant="outline" disabled={toLibrary.isPending} onClick={() => toLibrary.mutate()} title="Guarda esta versión como recurso para tus anuncios"><FolderOpen size={14} /> {toLibrary.isPending ? 'Guardando…' : 'A la biblioteca'}</Button>}
        {canWrite && <Button size="sm" variant="outline" disabled={toAds.isPending} onClick={() => toAds.mutate()} title="Abre Crear anuncio en Ads con esta imagen (se crea en pausa)"><Megaphone size={14} /> {toAds.isPending ? 'Preparando…' : 'Usar en anuncio'}</Button>}
        {canWrite && <Button size="sm" onClick={() => setToCalendar(true)} title="Publicación orgánica en Facebook e Instagram (no es un anuncio pagado)"><Send size={14} /> Al calendario</Button>}
      </header>

      {saveState === 'error' && (
        <div className="flex items-center justify-between gap-2 border-b-2 border-bad bg-bad-soft px-3 py-2 text-sm">
          No se pudo guardar. Tus cambios siguen en este navegador; revisa tu conexión y reintenta.
          <Button size="sm" variant="outline" onClick={() => void save()}>Reintentar</Button>
        </div>
      )}
      {saveState === 'conflict' && (
        <div className="flex items-center justify-between gap-2 border-b-2 border-bad bg-bad-soft px-3 py-2 text-sm">
          Este diseño se guardó desde otra pestaña o por otra persona. Tus cambios siguen aquí y en un borrador local.
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Recargar la última versión</Button>
        </div>
      )}
      {recover && (
        <div className="flex items-center justify-between gap-2 border-b-2 border-warn bg-warn-soft px-3 py-2 text-sm">
          Encontramos cambios sin guardar de tu última sesión.
          <span className="flex gap-2">
            <Button size="sm" onClick={() => { commit(recover); setRecover(null); }}>Recuperarlos</Button>
            <Button size="sm" variant="ghost" onClick={() => { setRecover(null); try { localStorage.removeItem(draftKey); } catch { /* nada */ } }}>Descartar</Button>
          </span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Herramientas */}
        {canWrite && (
          <aside role="toolbar" aria-label="Herramientas del lienzo" aria-orientation="vertical" className="flex w-16 shrink-0 flex-col items-center gap-1 border-r-2 border-ink bg-paper py-2">
            {[
              { icon: Type, label: 'Texto', short: 'Texto', run: () => addEl({ id: newId('t'), type: 'text', name: 'Texto', text: 'Escribe aquí', x: doc.width * 0.1, y: doc.height * 0.4, width: doc.width * 0.8, height: 120, rotation: 0, opacity: 1, visible: true, locked: false, fontFamily: 'Montserrat', fontSize: Math.round(doc.width * 0.06), fontStyle: 'bold', align: 'center', lineHeight: 1.15, letterSpacing: 0, fill: '#111111', textDecoration: '' }) },
              { icon: Square, label: 'Rectángulo', short: 'Forma', run: () => addEl({ id: newId('r'), type: 'rect', name: 'Rectángulo', x: doc.width * 0.3, y: doc.height * 0.3, width: doc.width * 0.4, height: doc.width * 0.25, rotation: 0, opacity: 1, visible: true, locked: false, fill: palette[0] ?? '#DDDDDD', stroke: '#00000000', strokeWidth: 0, cornerRadius: 0 }) },
              { icon: Circle, label: 'Círculo', short: 'Círculo', run: () => addEl({ id: newId('c'), type: 'ellipse', name: 'Círculo', x: doc.width * 0.35, y: doc.height * 0.35, width: doc.width * 0.3, height: doc.width * 0.3, rotation: 0, opacity: 1, visible: true, locked: false, fill: palette[1] ?? '#DDDDDD', stroke: '#00000000', strokeWidth: 0, cornerRadius: 0 }) },
              { icon: Minus, label: 'Línea', short: 'Línea', run: () => addEl({ id: newId('l'), type: 'line', name: 'Línea', x: doc.width * 0.2, y: doc.height * 0.5, width: doc.width * 0.6, height: 0, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#00000000', stroke: '#111111', strokeWidth: 6, cornerRadius: 0 }) },
              { icon: ImagePlus, label: 'Imagen de la biblioteca', short: 'Imagen', run: () => setImagePicker(true) },
            ].map((t) => (
              <button key={t.label} type="button" title={`Agregar ${t.label.toLowerCase()}`} aria-label={`Agregar ${t.label.toLowerCase()}`} onClick={t.run} className="flex h-11 w-12 cursor-pointer flex-col items-center justify-center gap-0.5 border-2 border-transparent text-[10px] leading-none hover:border-ink">
                <t.icon size={16} aria-hidden />{t.short}
              </button>
            ))}
          </aside>
        )}

        {/* Lienzo */}
        <main ref={boxRef} className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[repeating-conic-gradient(#e7e3dd_0%_25%,#efebe5_0%_50%)] [background-size:20px_20px]">
          {fontsReady ? (
            <Stage
              ref={stageRef}
              width={doc.width * scale}
              height={doc.height * scale}
              scaleX={scale}
              scaleY={scale}
              className="shadow-[6px_6px_0_0_rgba(26,26,26,0.7)]"
              onMouseDown={(e) => { if (e.target === e.target.getStage() || e.target.name() === '__bg') setSelected(null); }}
            >
              <Layer>
                <Background doc={doc} q={q} />
                <DocNodes doc={doc} q={q} common={common} />
                <Transformer ref={trRef} rotateEnabled flipEnabled={false} boundBoxFunc={(o, n) => (n.width < 5 || n.height < 5 ? o : n)} anchorSize={10} borderStroke="#3F6B3A" anchorStroke="#3F6B3A" />
              </Layer>
            </Stage>
          ) : <Loading label="Cargando fuentes…" />}
        </main>

        {/* Propiedades y capas */}
        <aside className="flex w-72 shrink-0 flex-col overflow-y-auto border-l-2 border-ink bg-paper text-sm">
          <section className="border-b-2 border-line p-3">
            <p className="kicker mb-2">{sel ? sel.name : 'Edición rápida'}</p>
            {!sel && (
              <div className="space-y-3">
                {canWrite && quickTexts.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-[11px] text-ink-3">Cambia los textos aquí; el diseño se ajusta solo.</p>
                    {quickTexts.map((e) => (
                      <label key={e.id} className="block text-[11px] text-ink-3">{e.name}
                        <Textarea rows={(e as TextEl).text.length > 40 ? 3 : 1} value={(e as TextEl).text} onChange={(ev) => update(e.id, { text: ev.target.value.slice(0, 2000) })} className="mt-0.5 !text-sm" />
                      </label>
                    ))}
                  </div>
                )}
                {canWrite && quickPhotos.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {quickPhotos.map((e) => (
                      <Button key={e.id} size="sm" variant="outline" onClick={() => { setSelected(e.id); setImagePicker(true); }}><ImagePlus size={13} /> {e.type === 'image' ? 'Cambiar foto' : 'Poner foto'}{quickPhotos.length > 1 ? ` · ${e.name}` : ''}</Button>
                    ))}
                  </div>
                )}
                {canWrite && (
                  <Field label="Adaptar a otro formato" hint="Crea una copia editable; este diseño no cambia">
                    <Select value="" onChange={(e) => e.target.value && adapt.mutate(e.target.value as FormatKey)}>
                      <option value="">Crear copia en…</option>
                      {(Object.keys(FORMATS) as FormatKey[]).filter((f) => f !== doc.format).map((f) => <option key={f} value={f}>{FORMATS[f].label}</option>)}
                    </Select>
                  </Field>
                )}
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-ink-2">Fondo y opciones avanzadas</summary>
                  <div className="mt-2 space-y-2">
                    <ColorInput value={doc.background.color} onChange={(v) => commit({ ...doc, background: { ...doc.background, color: v } })} />
                    <Select value={doc.background.assetId ?? ''} disabled={!canWrite} onChange={(e) => commit({ ...doc, background: { ...doc.background, assetId: e.target.value || null } })}>
                      <option value="">Sin imagen de fondo</option>
                      {(assets ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                    <p className="text-[11px] text-ink-3">Para mover, girar o cambiar tamaños, toca un elemento del lienzo. Atajos: Ctrl+Z, Ctrl+Shift+Z, Ctrl+D, Supr, flechas.</p>
                  </div>
                </details>
              </div>
            )}
            {sel && (
              <fieldset disabled={!canWrite || sel.locked || isProtected(sel)} className="space-y-2">
                {isProtected(sel) && <p className="text-[11px] text-warn">Elemento de marca protegido (cámbialo en Marca).</p>}
                <Input value={sel.name} onChange={(e) => update(sel.id, { name: e.target.value.slice(0, 60) })} aria-label="Nombre de la capa" />
                {sel.type === 'text' && (
                  <>
                    <Textarea rows={3} value={(sel as TextEl).text} onChange={(e) => update(sel.id, { text: e.target.value.slice(0, 2000) })} aria-label="Texto" />
                    <Select value={(sel as TextEl).fontFamily} onChange={(e) => update(sel.id, { fontFamily: e.target.value })}>
                      {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                    </Select>
                    <div className="grid grid-cols-3 gap-1.5">
                      {num('Tamaño', (sel as TextEl).fontSize, (v) => update(sel.id, { fontSize: Math.min(400, Math.max(6, v)) }))}
                      {num('Interlínea', (sel as TextEl).lineHeight, (v) => update(sel.id, { lineHeight: Math.min(3, Math.max(0.6, v)) }), 0.05)}
                      {num('Espaciado', (sel as TextEl).letterSpacing, (v) => update(sel.id, { letterSpacing: v }))}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant={/bold/.test((sel as TextEl).fontStyle) ? undefined : 'outline'} aria-label="Negrita" onClick={() => { const s = (sel as TextEl).fontStyle; const b = /bold/.test(s); const i = /italic/.test(s); update(sel.id, { fontStyle: (!b && i ? 'bold italic' : !b ? 'bold' : i ? 'italic' : 'normal') }); }}><Bold size={13} /></Button>
                      <Button size="sm" variant={/italic/.test((sel as TextEl).fontStyle) ? undefined : 'outline'} aria-label="Cursiva" onClick={() => { const s = (sel as TextEl).fontStyle; const b = /bold/.test(s); const i = /italic/.test(s); update(sel.id, { fontStyle: (b && !i ? 'bold italic' : !i ? 'italic' : b ? 'bold' : 'normal') }); }}><Italic size={13} /></Button>
                      <Select value={(sel as TextEl).align} onChange={(e) => update(sel.id, { align: e.target.value as TextEl['align'] })}>
                        <option value="left">Izquierda</option><option value="center">Centro</option><option value="right">Derecha</option>
                      </Select>
                    </div>
                    <ColorInput value={(sel as TextEl).fill} onChange={(v) => update(sel.id, { fill: v })} />
                  </>
                )}
                {(sel.type === 'rect' || sel.type === 'ellipse' || sel.type === 'line') && (
                  <>
                    {sel.type !== 'line' && <><p className="text-[11px] text-ink-3">Relleno</p><ColorInput value={(sel as ShapeEl).fill} onChange={(v) => update(sel.id, { fill: v })} /></>}
                    <p className="text-[11px] text-ink-3">Borde</p>
                    <ColorInput value={(sel as ShapeEl).stroke} onChange={(v) => update(sel.id, { stroke: v })} />
                    <div className="grid grid-cols-2 gap-1.5">
                      {num('Grosor', (sel as ShapeEl).strokeWidth, (v) => update(sel.id, { strokeWidth: Math.min(100, Math.max(0, v)) }))}
                      {sel.type === 'rect' && num('Esquinas', (sel as ShapeEl).cornerRadius, (v) => update(sel.id, { cornerRadius: Math.max(0, v) }))}
                    </div>
                  </>
                )}
                {sel.type === 'image' && (
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => loadAsset((sel as ImageEl).assetId, q).then((img) => update(sel.id, { crop: coverCrop(img, sel.width, sel.height) }))}>Rellenar (recortar)</Button>
                    <Button size="sm" variant="outline" onClick={() => loadAsset((sel as ImageEl).assetId, q).then((img) => update(sel.id, { crop: null, height: Math.round(sel.width * img.naturalHeight / img.naturalWidth) }))}>Ajustar sin recorte</Button>
                    <Button size="sm" variant="outline" onClick={() => setImagePicker(true)}>Reemplazar</Button>
                  </div>
                )}
                {sel.role === 'photo' && sel.type === 'rect' && <Button size="sm" variant="outline" onClick={() => setImagePicker(true)}>Poner una foto aquí</Button>}
                <div className="grid grid-cols-4 gap-1.5">
                  {num('X', sel.x, (v) => update(sel.id, { x: v }))}
                  {num('Y', sel.y, (v) => update(sel.id, { y: v }))}
                  {num('Ancho', sel.width, (v) => update(sel.id, { width: Math.max(1, v) }))}
                  {num('Alto', sel.height, (v) => update(sel.id, { height: Math.max(0, v) }))}
                  {num('Giro', sel.rotation, (v) => update(sel.id, { rotation: Math.max(-360, Math.min(360, v)) }))}
                  {num('Opacidad', sel.opacity, (v) => update(sel.id, { opacity: Math.max(0, Math.min(1, v)) }), 0.05)}
                </div>
              </fieldset>
            )}
            {sel && canWrite && (
              <div className="mt-2 flex flex-wrap gap-1">
                <Button size="sm" variant="outline" aria-label="Subir capa" onClick={() => move('up')}><ArrowUp size={13} /></Button>
                <Button size="sm" variant="outline" aria-label="Bajar capa" onClick={() => move('down')}><ArrowDown size={13} /></Button>
                <Button size="sm" variant="outline" onClick={() => move('top')}>Al frente</Button>
                <Button size="sm" variant="outline" onClick={() => move('bottom')}>Al fondo</Button>
                <Button size="sm" variant="outline" aria-label="Duplicar" onClick={duplicateSel}><Copy size={13} /></Button>
                <Button size="sm" variant="danger" aria-label="Eliminar" disabled={sel.locked || isProtected(sel)} onClick={removeSel}><Trash2 size={13} /></Button>
              </div>
            )}
          </section>

          <section className="p-3">
            <p className="kicker mb-2">Capas ({doc.elements.length})</p>
            <ul className="space-y-1">
              {[...doc.elements].reverse().map((e) => (
                <li key={e.id} className={clsx('flex items-center gap-1 border-2 px-2 py-1 text-xs', selected === e.id ? 'border-ink bg-bone-2' : 'border-line')}>
                  <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left" onClick={() => setSelected(e.id)}>
                    {e.name}{e.role === 'logo' ? ' · logo' : ''}
                  </button>
                  {canWrite && (
                    <>
                      <button type="button" aria-label={e.visible ? 'Ocultar' : 'Mostrar'} className="cursor-pointer p-0.5" onClick={() => update(e.id, { visible: !e.visible })}>{e.visible ? <Eye size={13} /> : <EyeOff size={13} />}</button>
                      <button type="button" aria-label={e.locked ? 'Desbloquear' : 'Bloquear'} className="cursor-pointer p-0.5" disabled={isProtected(e)} onClick={() => update(e.id, { locked: !e.locked })}>{e.locked || isProtected(e) ? <Lock size={13} /> : <Unlock size={13} />}</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {!doc.elements.length && <p className="text-xs text-ink-3">Diseño vacío: agrega texto, formas o imágenes con la barra de la izquierda.</p>}
          </section>
        </aside>
      </div>

      <Modal open={!!review} onClose={() => setReview(null)} kicker="Antes de exportar" title="Así quedará tu archivo" wide>
        {review && (
          <div className="grid gap-4 text-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex items-start justify-center bg-bone-2 p-2"><img src={review.url} alt="Vista previa de la exportación" className="max-h-[60vh] w-auto border border-line" /></div>
            <div className="space-y-3">
              {!review.issues.length && <p className="text-ok">No encontramos problemas verificables.</p>}
              {(['BLOCK', 'WARN', 'INFO'] as const).map((sev) => {
                const list = review.issues.filter((i) => i.severity === sev);
                if (!list.length) return null;
                return (
                  <div key={sev}>
                    <p className={clsx('kicker mb-1', sev === 'BLOCK' ? 'text-bad' : sev === 'WARN' ? 'text-warn' : 'text-ink-3')}>{sev === 'BLOCK' ? 'Hay que corregir' : sev === 'WARN' ? 'Conviene revisar' : 'Para tener en cuenta'}</p>
                    <ul className="space-y-1">
                      {list.map((i, n) => (
                        <li key={n} className="flex items-start justify-between gap-2">
                          <span>{i.message}{i.kind === 'HEURISTIC' && <span className="ml-1 text-[11px] text-ink-3">(estimación)</span>}</span>
                          {i.elementId && <button type="button" className="shrink-0 cursor-pointer text-xs underline" onClick={() => { setSelected(i.elementId!); setReview(null); }}>Ir</button>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
              <p className="text-[11px] text-ink-3">Revisamos lo que se puede medir (bordes, tamaños, contraste, resolución, precios confirmados). La estética final la decides tú. Nada se cambia sin que lo hagas.</p>
              <div className="flex flex-wrap gap-2">
                <Button disabled={review.blocking || exportMut.isPending} onClick={() => { exportMut.mutate('image/png'); setReview(null); }}>Descargar PNG</Button>
                <Button variant="outline" disabled={review.blocking || exportMut.isPending} onClick={() => { exportMut.mutate('image/jpeg'); setReview(null); }}>Descargar JPG</Button>
              </div>
              {review.blocking && <p className="text-xs text-bad">Corrige lo marcado como «Hay que corregir»: así el archivo saldría cortado o con recursos que no son tuyos.</p>}
            </div>
          </div>
        )}
      </Modal>

      <ImagePicker
        open={imagePicker}
        q={q}
        assets={assets ?? []}
        onClose={() => setImagePicker(false)}
        onPick={(a) => {
          setImagePicker(false);
          if (sel && (sel.type === 'image' || (sel.type === 'rect' && sel.role === 'photo'))) {
            // Reemplaza conservando posición y tamaño (no hay que rehacer la composición)
            const img: ImageEl = { id: sel.id, type: 'image', name: sel.name, x: sel.x, y: sel.y, width: sel.width, height: sel.height, rotation: sel.rotation, opacity: sel.opacity, visible: true, locked: false, assetId: a.id, crop: null, cornerRadius: sel.type === 'rect' ? (sel as ShapeEl).cornerRadius : (sel as ImageEl).cornerRadius, ...(sel.role ? { role: sel.role } : {}) };
            commit({ ...doc, elements: doc.elements.map((e) => (e.id === sel.id ? img : e)) });
            if (a.width && a.height) loadAsset(a.id, q).then((im) => update(sel.id, { crop: coverCrop(im, sel.width, sel.height) } as Partial<El>)).catch(() => undefined);
          } else {
            const w = Math.round(doc.width * 0.5);
            const h = a.width && a.height ? Math.round((w * a.height) / a.width) : w;
            addEl({ id: newId('i'), type: 'image', name: a.name.slice(0, 60), assetId: a.id, x: Math.round((doc.width - w) / 2), y: Math.round((doc.height - h) / 2), width: w, height: h, rotation: 0, opacity: 1, visible: true, locked: false, crop: null, cornerRadius: 0, ...(a.kind === 'LOGO' ? { role: 'logo' } : {}) });
          }
        }}
      />

      <ToCalendar open={toCalendar} onClose={() => setToCalendar(false)} designId={id} name={name}
        beforeSend={async () => {
          // Mismo control que al exportar: lo bloqueante no pasa al calendario
          await ensureSaved();
          const r = await api.post<{ blocking: boolean }>(`/creative/designs/${id}/check`, { doc, forExport: true });
          if (r.blocking) throw new Error('Hay problemas por corregir (usa «Revisar y exportar» para verlos).');
          await exportMut.mutateAsync('image/png');
        }} />
    </div>
  );
}

function ImagePicker({ open, onClose, onPick, assets, q }: { open: boolean; onClose: () => void; onPick: (a: Asset) => void; assets: Asset[]; q: string }) {
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile<Asset>(withScope('/creative/assets', q), 'file', file, { kind: 'IMAGE', name: file.name }),
    onSuccess: (a) => { queryClient.invalidateQueries({ queryKey: ['brand-assets'] }); onPick(a); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'No se pudo subir'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Tus recursos" title="Elige una imagen" wide>
      <div className="space-y-3">
        <label className="inline-flex cursor-pointer items-center gap-2 border-2 border-ink bg-paper px-3 py-2 text-sm">
          <ImagePlus size={14} /> {upload.isPending ? 'Subiendo…' : 'Subir imagen (PNG, JPG o WEBP)'}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
        </label>
        <div className="grid max-h-[50vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {assets.map((a) => <AssetThumb key={a.id} asset={a} q={q} onClick={() => onPick(a)} />)}
        </div>
        {!assets.length && <p className="text-sm text-ink-3">Aún no tienes imágenes. Sube tu logo y fotos de tus productos.</p>}
      </div>
    </Modal>
  );
}

export function AssetThumb({ asset, q, onClick }: { asset: Asset; q: string; onClick?: () => void }) {
  const { img, failed } = useAssetImage(asset.id, q);
  return (
    <button type="button" onClick={onClick} className="group flex cursor-pointer flex-col border-2 border-line bg-paper text-left hover:border-ink">
      <span className="flex aspect-square items-center justify-center overflow-hidden bg-bone-2">
        {img ? <img alt={asset.name} src={img.src} className="h-full w-full object-contain" /> : <span className="text-[11px] text-ink-3">{failed ? 'No disponible' : 'Cargando…'}</span>}
      </span>
      <span className="truncate px-1.5 py-1 text-[11px]">{asset.kind === 'LOGO' ? 'Logo · ' : ''}{asset.name}</span>
    </button>
  );
}

function ToCalendar({ open, onClose, designId, name, beforeSend }: { open: boolean; onClose: () => void; designId: string; name: string; beforeSend: () => Promise<void> }) {
  const [title, setTitle] = useState(name);
  const [copy, setCopy] = useState('');
  const [category, setCategory] = useState('MARCA');
  const navigate = useNavigate();
  useEffect(() => { if (open) setTitle(name); }, [open, name]);
  const send = useMutation({
    mutationFn: async () => {
      await beforeSend();
      return api.post(`/creative/designs/${designId}/to-piece`, { title, copy, category });
    },
    onSuccess: () => { toast.success('Listo: quedó en tu calendario como borrador'); onClose(); navigate('/app/creative?tab=calendario'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Error'),
  });
  return (
    <Modal open={open} onClose={onClose} kicker="Calendario editorial" title="Llevar al calendario">
      <div className="space-y-3">
        <Field label="Título"><Input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Texto de la publicación" hint="Puedes escribirlo ahora o después"><Textarea rows={4} maxLength={2200} value={copy} onChange={(e) => setCopy(e.target.value)} /></Field>
        <Field label="Categoría" hint="Sirve para las reglas de publicación automática">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <p className="text-xs text-ink-3">Se exporta la imagen y entra como borrador. Antes de publicarse necesita aprobación.</p>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button disabled={send.isPending || !title.trim()} onClick={() => send.mutate()}>{send.isPending ? 'Enviando…' : 'Enviar al calendario'}</Button>
        </div>
      </div>
    </Modal>
  );
}
