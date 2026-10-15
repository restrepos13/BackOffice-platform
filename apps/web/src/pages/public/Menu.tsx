import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, ShoppingBag, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fmtMoney } from '../../lib/format';
import type { PublicMenu } from '../../lib/types';

/**
 * Menú digital público (QR en la mesa, link en Instagram). El cliente arma
 * el pedido y lo envía por WhatsApp con un mensaje prellenado: ahí lo
 * recibe el asistente IA, que confirma dirección, cobro y tiempos.
 */

class MenuError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

async function fetchMenu(slug: string): Promise<PublicMenu> {
  const res = await fetch(`/api/public/menu/${encodeURIComponent(slug)}`);
  if (!res.ok) throw new MenuError(res.status);
  return res.json();
}

type CartLine = { id: string; name: string; price: number | null; qty: number; presentation?: string };

export default function PublicMenuPage() {
  const { slug = '' } = useParams();
  const { data, error, isLoading } = useQuery({
    queryKey: ['public-menu', slug],
    queryFn: () => fetchMenu(slug),
    retry: (count, err) => !(err instanceof MenuError && err.status === 404) && count < 2,
  });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const accent = data?.company.brandColor || '#1a1a1a';
  const currency = data?.company.currency ?? 'COP';
  useEffect(() => {
    if (data) document.title = `${data.title ?? 'Menú'} · ${data.company.name}`;
  }, [data]);

  const total = cart.reduce((sum, l) => sum + (l.price ?? 0) * l.qty, 0);
  const count = cart.reduce((sum, l) => sum + l.qty, 0);
  const keyOf = (id: string, presentation?: string) => `${id}::${presentation ?? ''}`;

  function add(item: { id: string; name: string; price: number | null }, presentation?: string, delta = 1) {
    setCart((prev) => {
      const k = keyOf(item.id, presentation);
      const found = prev.find((l) => keyOf(l.id, l.presentation) === k);
      if (!found) return delta > 0 ? [...prev, { ...item, qty: 1, presentation }] : prev;
      return prev
        .map((l) => (keyOf(l.id, l.presentation) === k ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0);
    });
  }

  const waLink = useMemo(() => {
    if (!data?.whatsapp) return null;
    const lines = cart.map((l) => `• ${l.qty} x ${l.name}${l.presentation ? ` (${l.presentation})` : ''}`);
    const text = [
      `Hola ${data.company.name}, quiero hacer este pedido:`,
      ...lines,
      total > 0 ? `Total aprox.: ${fmtMoney(total, currency)}` : '',
      note.trim() ? `Nota: ${note.trim()}` : '',
    ].filter(Boolean).join('\n');
    return `https://wa.me/${data.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
  }, [data, cart, note, total, currency]);

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-bone text-sm text-ink-3">Cargando menú…</div>;
  }
  if (error || !data) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 bg-bone px-6 text-center">
        <p className="display text-3xl">Menú no disponible</p>
        <p className="text-sm text-ink-3">El negocio todavía no publica su menú digital o el link cambió.</p>
      </div>
    );
  }

  const visible = category ? data.categories.filter((c) => c.name === category) : data.categories;

  return (
    <div className="min-h-screen bg-bone pb-28 text-ink">
      <header className="px-4 pb-5 pt-8 text-bone" style={{ background: accent }}>
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          {data.company.logoUrl && (
            <img src={data.company.logoUrl} alt="" className="h-14 w-14 shrink-0 border-2 border-bone object-cover" />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] opacity-80">{data.company.city ?? 'Menú digital'}</p>
            <h1 className="display truncate text-3xl leading-tight">{data.company.name}</h1>
            {data.title && <p className="text-sm opacity-90">{data.title}</p>}
          </div>
        </div>
        {data.note && <p className="mx-auto mt-3 max-w-2xl text-sm opacity-90">{data.note}</p>}
      </header>

      {data.promotions.length > 0 && (
        <section className="mx-auto mt-4 max-w-2xl space-y-2 px-4">
          {data.promotions.map((p) => (
            <div key={p.name} className="border-2 border-ink bg-paper px-3 py-2">
              <p className="text-sm font-semibold">{p.name}</p>
              {p.description && <p className="text-xs text-ink-2">{p.description}</p>}
              {p.code && <p className="mt-1 text-xs">Código <span className="font-mono font-bold">{p.code}</span> — díselo al asistente</p>}
            </div>
          ))}
        </section>
      )}

      {data.categories.length > 1 && (
        <nav className="sticky top-0 z-10 mt-4 border-y-2 border-ink bg-bone">
          <div className="mx-auto flex max-w-2xl gap-1 overflow-x-auto px-4 py-2">
            {[null, ...data.categories.map((c) => c.name)].map((name) => (
              <button
                key={name ?? 'todo'}
                onClick={() => setCategory(name)}
                className="shrink-0 cursor-pointer border-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider"
                style={category === name ? { background: accent, borderColor: accent, color: '#f4efe6' } : { borderColor: '#1a1a1a' }}
              >
                {name ?? 'Todo'}
              </button>
            ))}
          </div>
        </nav>
      )}

      <main className="mx-auto max-w-2xl space-y-8 px-4 pt-5">
        {visible.map((cat) => (
          <section key={cat.name}>
            <h2 className="display mb-3 border-b-2 border-ink pb-1 text-2xl">{cat.name}</h2>
            <div className="space-y-3">
              {cat.items.map((item) => {
                const qty = cart.filter((l) => l.id === item.id).reduce((s, l) => s + l.qty, 0);
                return (
                  <article key={item.id} className={`flex gap-3 border-2 border-ink bg-paper p-3 ${item.soldOut ? 'opacity-55' : ''}`}>
                    {item.hasImage && (
                      <img
                        src={`/api/public/menu/${encodeURIComponent(slug)}/products/${item.id}/image`}
                        alt={item.name}
                        loading="lazy"
                        className="h-24 w-24 shrink-0 border-2 border-ink object-cover"
                      />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="font-semibold leading-snug">{item.name}</h3>
                        {item.price != null && <p className="shrink-0 font-semibold tabular-nums">{fmtMoney(item.price, currency)}</p>}
                      </div>
                      {item.description && <p className="mt-0.5 text-xs text-ink-2">{item.description}</p>}
                      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-2">
                        {item.soldOut ? (
                          <span className="text-[11px] font-bold uppercase tracking-wider text-bad">Agotado hoy</span>
                        ) : item.presentations.length > 1 ? (
                          item.presentations.map((pr) => (
                            <button
                              key={pr}
                              onClick={() => add(item, pr)}
                              className="cursor-pointer border-2 border-ink px-2 py-1 text-xs font-semibold hover:bg-bone-2"
                            >
                              + {pr}
                            </button>
                          ))
                        ) : qty > 0 ? (
                          <div className="flex items-center border-2 border-ink">
                            <button className="cursor-pointer p-1.5" aria-label="Quitar uno" onClick={() => add(item, item.presentations[0], -1)}><Minus size={14} /></button>
                            <span className="w-7 text-center text-sm font-semibold tabular-nums">{qty}</span>
                            <button className="cursor-pointer p-1.5" aria-label="Agregar uno" onClick={() => add(item, item.presentations[0])}><Plus size={14} /></button>
                          </div>
                        ) : (
                          <button
                            onClick={() => add(item, item.presentations[0])}
                            className="cursor-pointer px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-bone"
                            style={{ background: accent }}
                          >
                            Agregar
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
        <p className="pb-4 text-center text-[11px] text-ink-3">Menú digital por BackOffice</p>
      </main>

      {count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-ink bg-paper p-3">
          <button
            onClick={() => setOpen(true)}
            className="mx-auto flex w-full max-w-2xl cursor-pointer items-center justify-between px-4 py-3 text-bone"
            style={{ background: accent }}
          >
            <span className="flex items-center gap-2 text-sm font-semibold"><ShoppingBag size={16} /> {count} {count === 1 ? 'producto' : 'productos'}</span>
            <span className="text-sm font-semibold tabular-nums">{total > 0 ? fmtMoney(total, currency) : 'Ver pedido'}</span>
          </button>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/40" onClick={() => setOpen(false)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto border-t-2 border-ink bg-paper p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="display text-2xl">Tu pedido</h2>
              <button className="cursor-pointer p-1" aria-label="Cerrar" onClick={() => setOpen(false)}><X size={18} /></button>
            </div>
            <ul className="divide-y divide-line">
              {cart.map((l) => (
                <li key={keyOf(l.id, l.presentation)} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{l.name}</p>
                    {l.presentation && <p className="text-xs text-ink-3">{l.presentation}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center border-2 border-ink">
                      <button className="cursor-pointer p-1" aria-label="Quitar uno" onClick={() => add(l, l.presentation, -1)}><Minus size={13} /></button>
                      <span className="w-6 text-center text-sm tabular-nums">{l.qty}</span>
                      <button className="cursor-pointer p-1" aria-label="Agregar uno" onClick={() => add(l, l.presentation)}><Plus size={13} /></button>
                    </div>
                    {l.price != null && <span className="w-20 text-right text-sm tabular-nums">{fmtMoney(l.price * l.qty, currency)}</span>}
                  </div>
                </li>
              ))}
            </ul>
            <textarea
              className="mt-3 w-full border-2 border-ink bg-bone p-2 text-sm"
              rows={2}
              placeholder="Nota para el negocio (sin cebolla, timbre dañado…)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="mt-2 text-xs text-ink-3">El domicilio y el medio de pago se confirman por WhatsApp.</p>
            {waLink ? (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 flex w-full items-center justify-center py-3 text-sm font-semibold uppercase tracking-wider text-bone"
                style={{ background: accent }}
              >
                Pedir por WhatsApp{total > 0 ? ` · ${fmtMoney(total, currency)}` : ''}
              </a>
            ) : (
              <p className="mt-3 border-2 border-warn p-2 text-center text-sm">Este negocio aún no tiene WhatsApp configurado.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
