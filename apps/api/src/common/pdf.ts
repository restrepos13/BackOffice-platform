import PDFDocument from 'pdfkit';

/**
 * PDFs con la identidad de CADA marca: banda del color de la empresa,
 * tipografía sobria y pie institucional. Sin archivos externos (fuentes
 * estándar de PDF) para que funcione en cualquier despliegue.
 */

interface BrandCompany {
  name: string;
  brandColor?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  city?: string | null;
  country?: string | null;
  timezone?: string | null;
}

const INK = '#1A1A1A';
const GRAY = '#6b6b6b';
const LINE = '#d9d4cf';

function fmt(d: Date | string, timezone?: string | null): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: timezone ?? 'America/Bogota',
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(d));
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Cabecera de marca: banda de color + nombre de la empresa + título. */
function brandHeader(doc: PDFKit.PDFDocument, company: BrandCompany, kicker: string, title: string) {
  const color = company.brandColor || INK;
  doc.rect(0, 0, doc.page.width, 8).fill(color);
  doc.moveDown(1.5);
  doc.fillColor(color).font('Helvetica-Bold').fontSize(20).text(company.name.toUpperCase(), 50, 34);
  doc.fillColor(GRAY).font('Helvetica').fontSize(8)
    .text(
      [company.city, company.country].filter(Boolean).join(', ') || ' ',
      50, 58,
    );
  doc.fillColor(GRAY).font('Helvetica').fontSize(9).text(kicker.toUpperCase(), 50, 80, { characterSpacing: 1 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(title, 50, 93);
  doc.moveTo(50, 118).lineTo(doc.page.width - 50, 118).lineWidth(1.5).strokeColor(INK).stroke();
  doc.y = 132;
}

function brandFooter(doc: PDFKit.PDFDocument, company: BrandCompany) {
  const y = doc.page.height - 46;
  doc.moveTo(50, y).lineTo(doc.page.width - 50, y).lineWidth(0.5).strokeColor(LINE).stroke();
  doc.fillColor(GRAY).font('Helvetica').fontSize(7.5).text(
    [
      company.name,
      company.contactEmail,
      company.contactPhone,
      `Generado ${fmt(new Date(), company.timezone)}`,
    ]
      .filter(Boolean)
      .join('  ·  '),
    50, y + 8, { width: doc.page.width - 100, align: 'center' },
  );
}

function row(doc: PDFKit.PDFDocument, label: string, value: string) {
  const y = doc.y;
  doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(label.toUpperCase(), 50, y, { characterSpacing: 0.5 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(value || '—', 50, y + 11, { width: doc.page.width - 100 });
  doc.y += 6;
}

/* ═══ Orden de pedido ═══ */

export async function buildOrderPdf(company: BrandCompany, order: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const color = company.brandColor || INK;
  const address = (() => {
    try {
      return JSON.parse(order.deliveryAddressJson ?? '{}');
    } catch {
      return {};
    }
  })();

  brandHeader(doc, company, `Pedido · ${String(order.id).slice(-6).toUpperCase()}`, 'Orden de pedido');

  row(doc, 'Cliente', order.customer?.name ?? '—');
  if (order.contact) row(doc, 'Contacto', `${order.contact.name} · ${order.contact.phone}`);
  row(doc, 'Entrega', fmt(order.deliveryAt, company.timezone));
  row(
    doc, 'Dirección',
    [address.label, address.address, address.city].filter(Boolean).join(' · ') || 'Sin dirección',
  );
  row(doc, 'Estado', String(order.status ?? '').replaceAll('_', ' '));
  if (order.observations) row(doc, 'Observaciones', order.observations);

  // Tabla de ítems
  doc.moveDown(1);
  const top = doc.y + 6;
  doc.rect(50, top, doc.page.width - 100, 20).fill(color);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5);
  doc.text('CANT.', 58, top + 6, { width: 50 });
  doc.text('PRODUCTO', 112, top + 6, { width: 220 });
  doc.text('PRESENTACIÓN', 336, top + 6, { width: 110 });
  doc.text('ÁREA', 450, top + 6, { width: 100 });
  let y = top + 20;
  for (const item of order.items ?? []) {
    doc.rect(50, y, doc.page.width - 100, 22).strokeColor(LINE).lineWidth(0.5).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(`${item.quantity} ${item.unit ?? ''}`, 58, y + 6, { width: 50 });
    doc.font('Helvetica').text(item.productName, 112, y + 6, { width: 220 });
    doc.fillColor(GRAY).fontSize(9).text(item.presentation ?? '—', 336, y + 6, { width: 110 });
    doc.text(item.productionArea?.name ?? '—', 450, y + 6, { width: 100 });
    y += 22;
    if (item.specifications) {
      doc.rect(50, y, doc.page.width - 100, 16).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.fillColor(GRAY).font('Helvetica-Oblique').fontSize(8)
        .text(`> ${item.specifications}`, 112, y + 4, { width: 380 });
      y += 16;
    }
  }
  doc.y = y + 14;

  // Trazabilidad
  if (order.statusHistory?.length) {
    doc.fillColor(GRAY).font('Helvetica').fontSize(8).text('TRAZABILIDAD', 50, doc.y, { characterSpacing: 0.5 });
    doc.moveDown(0.4);
    for (const h of order.statusHistory.slice(-8)) {
      doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(
        `${fmt(h.createdAt, company.timezone)} — ${h.fromStatus && h.fromStatus !== h.toStatus ? `${h.fromStatus} -> ` : ''}${h.toStatus}` +
        ` (${h.authorName ?? h.authorType})${h.reason ? `: ${h.reason}` : ''}`,
        50, doc.y, { width: doc.page.width - 100 },
      );
      doc.moveDown(0.2);
    }
  }

  brandFooter(doc, company);
  return collect(doc);
}

/* ═══ Reporte diario ═══ */

export async function buildDailyReportPdf(company: BrandCompany, data: any): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, bufferPages: true });
  const color = company.brandColor || INK;

  brandHeader(doc, company, `Reporte operativo · ${data.date}`, 'Reporte diario');

  // KPIs en dos columnas
  const kpis: Array<[string, string]> = [
    ['Pedidos recibidos', String(data.pedidos.recibidos)],
    ['Confirmados', String(data.pedidos.confirmados)],
    ['Programados', String(data.pedidos.programados)],
    ['Despachados', String(data.pedidos.despachados)],
    ['Entregados', String(data.pedidos.entregados)],
    ['Conversaciones', String(data.conversaciones.atendidas)],
    ['Resueltas por la IA', String(data.conversaciones.resueltasPorIA)],
    ['Escaladas', String(data.conversaciones.escaladas)],
  ];
  const colWidth = (doc.page.width - 100) / 4;
  let x = 50;
  let y = doc.y;
  kpis.forEach(([label, value], i) => {
    if (i > 0 && i % 4 === 0) {
      x = 50;
      y += 52;
    }
    doc.rect(x, y, colWidth - 8, 44).strokeColor(INK).lineWidth(1).stroke();
    doc.fillColor(GRAY).font('Helvetica').fontSize(7).text(label.toUpperCase(), x + 8, y + 7, { width: colWidth - 22 });
    doc.fillColor(color).font('Helvetica-Bold').fontSize(17).text(value, x + 8, y + 19);
    x += colWidth;
  });
  doc.y = y + 62;

  const precision = data.precisionIA?.mes;
  row(
    doc, 'Precisión de la IA (mes)',
    precision?.precisionPct != null
      ? `${precision.precisionPct}% (${precision.total} pedidos IA, ${precision.corregidos} corregidos)`
      : 'Sin pedidos IA en el mes',
  );

  doc.moveDown(0.6);
  doc.fillColor(GRAY).font('Helvetica').fontSize(8).text('ALERTAS', 50, doc.y, { characterSpacing: 0.5 });
  doc.moveDown(0.3);
  const alertas: string[] = [
    ...data.alertas.pedidosSinConfirmar.map(
      (o: any) => `Pedido de ${o.customer} sigue en borrador (sin confirmar).`,
    ),
    ...data.alertas.entregasProximasSinArea.map(
      (o: any) => `Entrega próxima de ${o.customer} con ítems sin área: ${o.itemsSinArea.join(', ')}.`,
    ),
    ...data.alertas.recordatoriosFallidos.map(
      (r: any) => `Recordatorio ${r.kind} fallido${r.lastError ? `: ${r.lastError}` : ''}.`,
    ),
    ...(data.alertas.conversacionesSinRespuesta > 0
      ? [`${data.alertas.conversacionesSinRespuesta} conversación(es) sin respuesta hace más de 2 h.`]
      : []),
  ];
  if (alertas.length === 0) {
    doc.fillColor(INK).font('Helvetica').fontSize(9.5).text('Sin alertas pendientes. Todo en orden.', 50, doc.y);
  } else {
    for (const alerta of alertas.slice(0, 12)) {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(`•  ${alerta}`, 50, doc.y, { width: doc.page.width - 100 });
      doc.moveDown(0.25);
    }
  }

  if (data.dudas?.escalamientos?.length || data.dudas?.pedidosBajaConfianza?.length) {
    doc.moveDown(0.6);
    doc.fillColor(GRAY).font('Helvetica').fontSize(8).text('CASOS DONDE LA IA DUDÓ', 50, doc.y, { characterSpacing: 0.5 });
    doc.moveDown(0.3);
    for (const d of (data.dudas.pedidosBajaConfianza ?? []).slice(0, 6)) {
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(`•  ${d.customer}: confianza ${Math.round((d.aiConfidence ?? 0) * 100)}%`, 50, doc.y);
      doc.moveDown(0.2);
    }
    for (const e of (data.dudas.escalamientos ?? []).slice(0, 6)) {
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(`•  ${e.customer}: ${e.reason ?? 'escalado'}`, 50, doc.y, { width: doc.page.width - 100 });
      doc.moveDown(0.2);
    }
  }

  if (data.feedback?.respuestas > 0) {
    doc.moveDown(0.6);
    row(
      doc, 'Feedback del día',
      `${data.feedback.respuestas} respuesta(s) · promedio ${data.feedback.promedio ?? '—'}/5` +
      (data.feedback.negativos.length ? ` · ${data.feedback.negativos.length} negativa(s)` : ''),
    );
  }

  brandFooter(doc, company);
  return collect(doc);
}

/* ═══ Descarga de datos de la empresa (solo PDF) ═══ */

export interface ExportSection {
  title: string;
  /** Anchos relativos; se reparten en el ancho útil de la hoja */
  columns: Array<{ label: string; width: number; align?: 'left' | 'right' }>;
  rows: string[][];
  note?: string;
}

/** Todas las secciones en tablas, con encabezado repetido al cambiar de página. */
export async function buildDataExportPdf(company: BrandCompany, sections: ExportSection[], meta: { requestedBy: string }): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 40, bufferPages: true });
  const color = company.brandColor || INK;
  const left = 40;
  const usable = doc.page.width - 80;
  const bottom = () => doc.page.height - 60;

  brandHeader(doc, company, 'Datos de tu empresa', 'Descarga de información');
  doc.fillColor(GRAY).font('Helvetica').fontSize(9)
    .text(`Pedido por ${meta.requestedBy} · ${fmt(new Date(), company.timezone)} · Contiene: ${sections.map((s) => `${s.title} (${s.rows.length})`).join(', ')}`, left, doc.y, { width: usable });
  doc.moveDown(0.8);

  for (const section of sections) {
    const total = section.columns.reduce((n, c) => n + c.width, 0);
    const widths = section.columns.map((c) => (c.width / total) * usable);
    const head = () => {
      const top = doc.y;
      doc.rect(left, top, usable, 18).fill(color);
      let x = left;
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
      section.columns.forEach((c, i) => {
        doc.text(c.label.toUpperCase(), x + 4, top + 5, { width: widths[i] - 8, align: c.align ?? 'left', lineBreak: false, ellipsis: true });
        x += widths[i];
      });
      doc.y = top + 18;
    };
    if (doc.y > bottom() - 80) doc.addPage();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(section.title, left, doc.y);
    if (section.note) doc.fillColor(GRAY).font('Helvetica').fontSize(8).text(section.note, left, doc.y + 2, { width: usable });
    doc.moveDown(0.4);
    if (!section.rows.length) {
      doc.fillColor(GRAY).font('Helvetica').fontSize(9).text('Sin registros.', left, doc.y);
      doc.moveDown(1.2);
      continue;
    }
    head();
    section.rows.forEach((r, idx) => {
      doc.font('Helvetica').fontSize(8);
      const h = Math.max(16, ...r.map((cell, i) => doc.heightOfString(cell || '—', { width: widths[i] - 8 }) + 7));
      if (doc.y + h > bottom()) {
        doc.addPage();
        doc.y = 40;
        head();
      }
      const top = doc.y;
      if (idx % 2 === 1) doc.rect(left, top, usable, h).fill('#f4f1ec');
      let x = left;
      doc.fillColor(INK).font('Helvetica').fontSize(8);
      r.forEach((cell, i) => {
        doc.text(cell || '—', x + 4, top + 4, { width: widths[i] - 8, align: section.columns[i]?.align ?? 'left' });
        x += widths[i];
      });
      doc.y = top + h;
    });
    doc.moveDown(1.2);
  }

  // Pie y número de página en cada hoja
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // Sin margen inferior: el pie no debe abrir hojas nuevas en blanco
    doc.page.margins.bottom = 0;
    brandFooter(doc, company);
    doc.fillColor(GRAY).font('Helvetica').fontSize(7.5)
      .text(`Página ${i + 1} de ${range.count}`, left, doc.page.height - 30, { width: usable, align: 'right', lineBreak: false });
  }
  return collect(doc);
}
