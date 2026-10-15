/**
 * Generador de códigos QR (ISO/IEC 18004) sin dependencias: modo byte,
 * corrección de errores M, versiones 1 a 10 (hasta 213 bytes — sobra para un
 * link). Devuelve la matriz y un SVG nítido para imprimir el menú.
 * Verificado módulo a módulo contra la librería `qrcode` (ver test/qr.spec.ts).
 */

// Corrección M, versiones 1..10: [codewords totales, EC por bloque, [[bloques, datos por bloque], …]]
const VERSIONS: Array<[number, number, Array<[number, number]>]> = [
  [26, 10, [[1, 16]]],
  [44, 16, [[1, 28]]],
  [70, 26, [[1, 44]]],
  [100, 18, [[2, 32]]],
  [134, 24, [[2, 43]]],
  [172, 16, [[4, 27]]],
  [196, 18, [[4, 31]]],
  [242, 22, [[2, 38], [2, 39]]],
  [292, 22, [[3, 36], [2, 37]]],
  [346, 26, [[4, 43], [1, 44]]],
];
const ALIGNMENT: number[][] = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/* ─── Reed-Solomon sobre GF(256), polinomio 0x11D ─── */
const EXP = new Array<number>(512);
const LOG = new Array<number>(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const res = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ res.shift()!;
    res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

/* ─── Codificación de datos ─── */
function encodeData(bytes: number[], version: number): number[] {
  const [total, ecPer, groups] = VERSIONS[version - 1];
  const dataCodewords = groups.reduce((s, [n, d]) => s + n * d, 0);
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // modo byte
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminador
  while (bits.length % 8) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; codewords.length < dataCodewords; pad++) codewords.push(pad % 2 === 0 ? 0xec : 0x11);

  // Bloques + EC, intercalados
  const blocks: number[][] = [];
  let offset = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      blocks.push(codewords.slice(offset, offset + size));
      offset += size;
    }
  }
  const ecBlocks = blocks.map((b) => rsRemainder(b, ecPer));
  const out: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecPer; i++) for (const e of ecBlocks) out.push(e[i]);
  if (out.length !== total) throw new Error('QR: tamaño de codewords inesperado');
  return out;
}

/* ─── Matriz ─── */
type Grid = { size: number; modules: boolean[][]; isFunction: boolean[][] };

function newGrid(version: number): Grid {
  const size = version * 4 + 17;
  return {
    size,
    modules: Array.from({ length: size }, () => new Array(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array(size).fill(false)),
  };
}

function setFn(g: Grid, x: number, y: number, dark: boolean) {
  g.modules[y][x] = dark;
  g.isFunction[y][x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(g, x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) setFn(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

function bchFormat(data: number): number {
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, mask: number) {
  const bits = bchFormat((0b00 << 3) | mask); // nivel M = 00
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) setFn(g, 8, i, bit(i));
  setFn(g, 8, 7, bit(6));
  setFn(g, 8, 8, bit(7));
  setFn(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFn(g, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setFn(g, g.size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFn(g, 8, g.size - 15 + i, bit(i));
  setFn(g, 8, g.size - 8, true); // módulo oscuro
}

function drawVersion(g: Grid, version: number) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFn(g, a, b, dark);
    setFn(g, b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number) {
  for (let i = 0; i < g.size; i++) {
    setFn(g, 6, i, i % 2 === 0);
    setFn(g, i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, g.size - 4, 3);
  drawFinder(g, 3, g.size - 4);
  const pos = ALIGNMENT[version - 1];
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (!corner) drawAlignment(g, pos[i], pos[j]);
    }
  }
  drawFormat(g, 0); // reserva (se reescribe con la máscara elegida)
  drawVersion(g, version);
}

function placeData(g: Grid, data: number[]) {
  let i = 0;
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? g.size - 1 - vert : vert;
        if (!g.isFunction[y][x] && i < data.length * 8) {
          g.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.isFunction[y][x] && MASKS[mask](x, y)) g.modules[y][x] = !g.modules[y][x];
    }
  }
}

/** Penalización estándar (N1..N4) para elegir la máscara. */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  // N1: rachas de 5+ del mismo color (filas y columnas)
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        const cur = pass === 0 ? m[a][b] : m[b][a];
        const prev = pass === 0 ? m[a][b - 1] : m[b - 1][a];
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // N2: bloques 2x2
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
  }
  // N3: patrón tipo buscador 1:1:3:1:1 con 4 claros a un lado
  const p1 = [true, false, true, true, true, false, true, false, false, false, false];
  const p2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let a = 0; a < size; a++) {
    for (let b = 0; b <= size - 11; b++) {
      for (const pattern of [p1, p2]) {
        if (pattern.every((v, k) => m[a][b + k] === v)) score += 40;
        if (pattern.every((v, k) => m[b + k][a] === v)) score += 40;
      }
    }
  }
  // N4: proporción de oscuros
  const dark = m.reduce((s, row) => s + row.filter(Boolean).length, 0);
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

export function qrMatrix(text: string, opts: { version?: number; mask?: number } = {}): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  let version = opts.version ?? 0;
  if (!version) {
    for (let v = 1; v <= VERSIONS.length; v++) {
      const [, , groups] = VERSIONS[v - 1];
      const capacityBits = groups.reduce((s, [n, d]) => s + n * d, 0) * 8;
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= capacityBits) {
        version = v;
        break;
      }
    }
  }
  if (!version) throw new Error('El texto es demasiado largo para el QR');
  const data = encodeData(bytes, version);
  const build = (mask: number) => {
    const g = newGrid(version);
    drawFunctionPatterns(g, version);
    placeData(g, data);
    applyMask(g, mask);
    drawFormat(g, mask);
    return g.modules;
  };
  if (opts.mask != null) return build(opts.mask);
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = build(mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best!;
}

/** SVG del QR (con margen de 4 módulos, como pide el estándar). */
export function qrSvg(text: string, opts: { size?: number; dark?: string; light?: string } = {}): string {
  const m = qrMatrix(text);
  const quiet = 4;
  const n = m.length + quiet * 2;
  const color = /^#[0-9a-f]{3,8}$/i.test(opts.dark ?? '') ? opts.dark : '#1a1a1a';
  const bg = /^#[0-9a-f]{3,8}$/i.test(opts.light ?? '') ? opts.light : '#ffffff';
  let path = '';
  for (let y = 0; y < m.length; y++) {
    for (let x = 0; x < m.length; x++) {
      if (m[y][x]) path += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }
  }
  const px = opts.size ?? 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="${bg}"/><path d="${path}" fill="${color}"/></svg>`;
}
