/**
 * Medición aproximada de texto en el servidor (no hay navegador): ancho
 * medio de carácter por fuente. Sirve para elegir tamaños y estimar
 * desbordes. Es una ESTIMACIÓN: el editor mide con el texto real y esa
 * medición manda en el control de calidad.
 */

const CHAR: Record<string, number> = {
  Inter: 0.55, Montserrat: 0.6, Poppins: 0.6, Roboto: 0.53, Raleway: 0.56, Nunito: 0.55, Lato: 0.52,
  'Playfair Display': 0.53, Lora: 0.54, 'DM Serif Display': 0.5, Anton: 0.43, 'Bebas Neue': 0.4, Oswald: 0.46, 'Archivo Black': 0.66, Pacifico: 0.56,
};

export function charWidth(font: string, size: number, bold = false, upper = false) {
  return (CHAR[font] ?? 0.56) * size * (bold ? 1.06 : 1) * (upper ? 1.12 : 1);
}

/** Corte de líneas por palabras (como el editor, wrap="word"). */
export function wrap(text: string, size: number, width: number, font: string, bold = false, upper = false): string[] {
  const cw = charWidth(font, size, bold, upper);
  const maxChars = Math.max(1, Math.floor(width / cw));
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
      else { lines.push(line); line = word; }
      // Palabra más larga que la línea: se parte (también lo haría el editor)
      while (line.length > maxChars) { lines.push(line.slice(0, maxChars)); line = line.slice(maxChars); }
    }
    lines.push(line);
  }
  return lines;
}

export function textHeight(text: string, size: number, width: number, font: string, lineHeight: number, bold = false, upper = false) {
  return wrap(text, size, width, font, bold, upper).length * size * lineHeight;
}

/** Mayor tamaño (entre min y max) con el que el texto entra en la caja. */
export function fitSize(text: string, o: { width: number; maxHeight: number; font: string; lineHeight: number; max: number; min: number; bold?: boolean; upper?: boolean; maxLines?: number }) {
  let size = Math.round(o.max);
  while (size > o.min) {
    const lines = wrap(text, size, o.width, o.font, o.bold, o.upper).length;
    if (lines * size * o.lineHeight <= o.maxHeight && (!o.maxLines || lines <= o.maxLines)) break;
    size -= Math.max(1, Math.round(size * 0.05));
  }
  size = Math.max(Math.round(o.min), size);
  const lines = wrap(text, size, o.width, o.font, o.bold, o.upper).length;
  return { size, lines, height: Math.ceil(lines * size * o.lineHeight), fits: lines * size * o.lineHeight <= o.maxHeight + 1 };
}
