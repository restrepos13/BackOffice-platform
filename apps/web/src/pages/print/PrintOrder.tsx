import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { ORDER_SOURCE_LABELS, PAYMENT_STATUS_LABELS, fmtMoney } from '../../lib/format';
import type { Company, Order } from '../../lib/types';

/**
 * Comanda imprimible para impresora térmica (80 mm o 58 mm).
 * Se abre en ventana aparte y dispara el diálogo de impresión;
 * ?auto=0 desactiva la impresión automática.
 */
export default function PrintOrder() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const [width, setWidth] = useState<'80' | '58'>(() => {
    try { return (localStorage.getItem('bo_print_width') as '80' | '58') || '80'; } catch { return '80'; }
  });
  const { data: order, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<Order>(`/orders/${id}`),
    enabled: !!id,
  });
  const { data: company } = useQuery({
    queryKey: ['company', order?.companyId],
    queryFn: () => api.get<Company>(`/companies/${order!.companyId}`),
    enabled: !!order?.companyId,
    retry: false,
  });

  useEffect(() => {
    try { localStorage.setItem('bo_print_width', width); } catch { /* sin storage */ }
  }, [width]);

  useEffect(() => {
    if (!order || params.get('auto') === '0') return;
    const t = setTimeout(() => window.print(), 400);
    return () => clearTimeout(t);
  }, [order, params]);

  if (error) return <p style={{ padding: 16, fontFamily: 'monospace' }}>No se pudo cargar el pedido.</p>;
  if (!order) return <p style={{ padding: 16, fontFamily: 'monospace' }}>Cargando…</p>;

  const address = (() => {
    try { return JSON.parse(order.deliveryAddressJson ?? '{}') as Record<string, string>; } catch { return {}; }
  })();
  const mm = Number(width);
  const when = new Date(order.deliveryAt);

  return (
    <div className="print-root">
      <style>{`
        @page { size: ${mm}mm auto; margin: 2mm; }
        body { background: #fff !important; }
        .print-root { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; color: #000; }
        .ticket { width: ${mm - 4}mm; margin: 12px auto; font-size: ${mm === 58 ? 11 : 12.5}px; line-height: 1.35; }
        .ticket h1 { font-size: 1.35em; font-weight: 800; text-align: center; margin: 0; }
        .ticket .big { font-size: 1.9em; font-weight: 800; text-align: center; letter-spacing: .05em; }
        .ticket .c { text-align: center; }
        .ticket hr { border: 0; border-top: 1px dashed #000; margin: 6px 0; }
        .ticket table { width: 100%; border-collapse: collapse; }
        .ticket td { vertical-align: top; padding: 1px 0; }
        .ticket .qty { width: 3ch; font-weight: 800; }
        .ticket .r { text-align: right; white-space: nowrap; }
        .ticket .note { font-size: .92em; padding-left: 3ch; }
        .ticket .box { border: 1.5px solid #000; padding: 3px 5px; margin-top: 4px; font-weight: 700; }
        .toolbar { display: flex; gap: 8px; justify-content: center; padding: 10px; border-bottom: 1px solid #ddd; font-family: system-ui, sans-serif; font-size: 13px; }
        .toolbar button { border: 2px solid #111; background: #fff; padding: 4px 10px; cursor: pointer; font-weight: 600; }
        .toolbar button[aria-pressed="true"] { background: #111; color: #fff; }
        @media print { .toolbar { display: none; } .ticket { margin: 0; } }
      `}</style>
      <div className="toolbar">
        <button aria-pressed={width === '80'} onClick={() => setWidth('80')}>80 mm</button>
        <button aria-pressed={width === '58'} onClick={() => setWidth('58')}>58 mm</button>
        <button onClick={() => window.print()}>Imprimir</button>
      </div>
      <div className="ticket">
        <h1>{company?.name ?? 'Comanda'}</h1>
        <p className="big">#{order.code ?? order.id.slice(-5).toUpperCase()}</p>
        <p className="c">
          {when.toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' })}{' '}
          {when.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}
          {order.source && order.source !== 'WHATSAPP' ? ` · ${ORDER_SOURCE_LABELS[order.source] ?? order.source}` : ''}
        </p>
        <hr />
        <p><b>{order.customer.name}</b></p>
        {order.contact?.phone && <p>Tel: {order.contact.phone}</p>}
        {(address.address || address.text) && <p>Dir: {address.address ?? address.text}</p>}
        {address.instructions && <p>Ref: {address.instructions}</p>}
        <hr />
        <table>
          <tbody>
            {order.items.map((item) => (
              <tr key={item.id}>
                <td className="qty">{item.quantity}</td>
                <td>
                  {item.productName}
                  {item.presentation && <div className="note">{item.presentation}</div>}
                  {item.specifications && <div className="note">* {item.specifications}</div>}
                  {item.observations && <div className="note">* {item.observations}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {order.observations && <p className="box">NOTA: {order.observations}</p>}
        {order.total != null && (
          <>
            <hr />
            <table>
              <tbody>
                {order.subtotal != null && <tr><td>Subtotal</td><td className="r">{fmtMoney(order.subtotal)}</td></tr>}
                {(order.discount ?? 0) > 0 && <tr><td>Descuento{order.couponCode ? ` ${order.couponCode}` : ''}</td><td className="r">-{fmtMoney(order.discount)}</td></tr>}
                {(order.deliveryFee ?? 0) > 0 && <tr><td>Domicilio</td><td className="r">{fmtMoney(order.deliveryFee)}</td></tr>}
                <tr><td><b>TOTAL</b></td><td className="r"><b>{fmtMoney(order.total)}</b></td></tr>
              </tbody>
            </table>
            <p className="c" style={{ marginTop: 4 }}>
              {PAYMENT_STATUS_LABELS[order.paymentStatus ?? 'NONE']}{order.paymentMethod ? ` · ${order.paymentMethod}` : ''}
            </p>
          </>
        )}
        <hr />
        <p className="c" style={{ fontSize: '.85em' }}>
          {order.takenByType === 'IA' ? 'Pedido tomado por IA' : `Tomado por ${order.takenByName ?? 'el equipo'}`}
        </p>
      </div>
    </div>
  );
}
