/**
 * Medición aproximada de texto en el servidor (no hay navegador): ancho
 * medio de carácter por fuente. Sirve para elegir tamaños y estimar
 * desbordes. Es una ESTIMACIÓN: el editor mide con el texto real y esa
 * medición manda en el control de calidad.
 */

// Calibrado con el laboratorio visual (oct-2026): se comparó la estimación con la
// altura real que dibuja el editor en ~930 textos. La estimación queda
// apenas conservadora (nunca menos líneas que las reales) sin crear huecos.
const CHAR: Record<string, number> = {
  Inter: 0.53, Montserrat: 0.56, Poppins: 0.58, Roboto: 0.52, Raleway: 0.54, Nunito: 0.52, Lato: 0.5,
  'Playfair Display': 0.51, Lora: 0.5, 'DM Serif Display': 0.49, Anton: 0.42, 'Bebas Neue': 0.39, Oswald: 0.45, 'Archivo Black': 0.64, Pacifico: 0.55,
};

export function charWidth(font: string, size: number, bold = false, upper = false) {
  // En mayúsculas el motor agrega un espaciado entre letras del 4 % del tamaño: también ocupa ancho
  return (CHAR[font] ?? 0.56) * size * (bold ? 1.06 : 1) * (upper ? 1.12 : 1) + (upper ? size * 0.04 : 0);
}

/** Corte de líneas por palabras (como el editor, wrap="word"). */
const CONDENSED = ['Anton', 'Bebas Neue', 'Oswald'];

/** Los dígitos y símbolos de precio son más anchos que el promedio, sobre todo en fuentes condensadas (visto en el laboratorio: "$15.000" se partía). */
function digitFactor(text: string, font: string) {
  const digits = (text.match(/[0-9$%]/g) ?? []).length;
  if (!digits) return 1;
  return 1 + (digits / Math.max(1, text.replace(/\s/g, '').length)) * (CONDENSED.includes(font) ? 0.35 : 0.12);
}

export function wrap(text: string, size: number, width: number, font: string, bold = false, upper = false): string[] {
  const cw = charWidth(font, size, bold, upper) * digitFactor(text, font);
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
  // Nunca partir una palabra a la mitad: la más larga tiene que entrar entera en el ancho
  // (si ni al mínimo entra, se permite bajar hasta el 70 % del mínimo antes de rendirse)
  const longest = text.split(/\s+/).reduce((m, w) => (w.length > m.length ? w : m), '');
  const perChar = charWidth(o.font, 1, o.bold, o.upper) * digitFactor(text, o.font);
  const wordCap = longest ? Math.floor(o.width / (perChar * longest.length)) : o.max;
  const floor = Math.min(o.min, Math.max(o.min * 0.7, wordCap));
  o = { ...o, max: Math.min(o.max, Math.max(floor, wordCap)), min: Math.min(o.min, Math.max(floor, wordCap)) };
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
