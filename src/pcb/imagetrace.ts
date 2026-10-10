// Векторизация растрового изображения (логотипа/картинки) в контуры для
// шелкографии. Без внешних зависимостей: бинарный контур строится обходом
// рёбер пикселей (мarching-squares-подобно), затем упрощается Дугласом-Пекером
// и группируется в «лица» с дырками (буквы О, А и т.п.).
//
// Система координат на выходе — миллиметры платы: Y вверх, центр рисунка в (0;0).

import type { Poly, Pt } from './model';

export interface BitmapImage {
  width: number;
  height: number;
  /** RGBA, 4 байта на пиксель (как у ImageData.data) */
  data: Uint8ClampedArray | Uint8Array | readonly number[];
}

export interface TraceOptions {
  /** яркость ниже порога = «краска» (0…255) */
  threshold?: number;
  /** инверсия: светлый рисунок на тёмном фоне */
  invert?: boolean;
  /** итоговая ширина рисунка, мм */
  widthMm?: number;
  /** отбрасывать пятна меньше этой площади, мм² */
  minAreaMm2?: number;
  /** упрощение контуров (допуск), мм */
  simplifyMm?: number;
  /** максимальный размер обрабатываемого изображения в пикселях (сторона) */
  maxPixels?: number;
}

export interface TraceFace {
  outer: Pt[];
  holes: Pt[][];
}

export interface TraceResult {
  faces: TraceFace[];
  widthMm: number;
  heightMm: number;
  /** размер обработанной сетки, px */
  pxWidth: number;
  pxHeight: number;
  /** сколько мелких пятен отброшено */
  dropped: number;
}

const DEF: Required<TraceOptions> = {
  threshold: 128,
  invert: false,
  widthMm: 20,
  minAreaMm2: 0.02,
  simplifyMm: 0.04,
  maxPixels: 256,
};

/** Яркость пикселя 0…255; полностью прозрачные — фон (255). */
function grayAt(src: BitmapImage, x: number, y: number): number {
  const i = (y * src.width + x) * 4;
  const a = src.data[i + 3];
  if (a < 128) return 255;
  return 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2];
}

/** Уменьшение бокс-фильтром (средняя яркость) до maxPixels по большей стороне. */
function downscale(src: BitmapImage, maxPixels: number): { w: number; h: number; gray: Float32Array } {
  const sw = src.width, sh = src.height;
  const scale = Math.max(1, Math.ceil(Math.max(sw, sh) / Math.max(8, maxPixels)));
  const w = Math.max(1, Math.ceil(sw / scale));
  const h = Math.max(1, Math.ceil(sh / scale));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let yy = y * scale; yy < Math.min(sh, (y + 1) * scale); yy++) {
        for (let xx = x * scale; xx < Math.min(sw, (x + 1) * scale); xx++) {
          sum += grayAt(src, xx, yy); n++;
        }
      }
      gray[y * w + x] = n ? sum / n : 255;
    }
  }
  return { w, h, gray };
}

/** Площадь кольца по формуле шнурков (со знаком). */
export function ringArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return a / 2;
}

/** Точка внутри кольца (чет-нечет). */
function inRing(ring: Pt[], p: Pt): boolean {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

/** Упрощение Дугласа-Пекера для незамкнутой ломаной. */
function rdp(pts: Pt[], eps: number): Pt[] {
  if (pts.length < 3 || eps <= 0) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1, idx = -1;
    const a = pts[s], b = pts[e];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i].x - a.x) * dy - (pts[i].y - a.y) * dx) / L;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Упрощение замкнутого кольца: Дуглас-Пекер между двумя самыми далёкими точками. */
function simplifyRing(ring: Pt[], eps: number): Pt[] {
  if (ring.length < 4 || eps <= 0) return ring;
  // разрезаем кольцо в самой дальней от первой точки вершине — стабильный разрез
  let far = 0, farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i].x - ring[0].x, ring[i].y - ring[0].y);
    if (d > farD) { farD = d; far = i; }
  }
  const a = rdp(ring.slice(0, far + 1), eps);
  const b = rdp([...ring.slice(far), ring[0]], eps);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

interface Edge { x1: number; y1: number; x2: number; y2: number }

/**
 * Контурные рёбра бинарного изображения: ребро там, где «краска» соседствует
 * с фоном. Ориентация — краска слева при обходе (y вниз), после переворота Y
 * внешние кольца получают положительную площадь, дырки — отрицательную.
 */
function boundaryLoops(w: number, h: number, ink: Uint8Array): number[][][] {
  const key = (x: number, y: number) => y * (w + 1) + x;
  const edges = new Map<number, Edge[]>();
  const add = (e: Edge) => {
    const k = key(e.x1, e.y1);
    const list = edges.get(k);
    if (list) list.push(e); else edges.set(k, [e]);
  };
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h) ? 0 : ink[y * w + x];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add({ x1: x, y1: y, x2: x + 1, y2: y });         // верх, вправо
      if (!at(x + 1, y)) add({ x1: x + 1, y1: y, x2: x + 1, y2: y + 1 }); // право, вниз
      if (!at(x, y + 1)) add({ x1: x + 1, y1: y + 1, x2: x, y2: y + 1 }); // низ, влево
      if (!at(x - 1, y)) add({ x1: x, y1: y + 1, x2: x, y2: y });         // лево, вверх
    }
  }
  const loops: number[][][] = [];
  const take = (x: number, y: number): Edge | null => {
    const k = key(x, y);
    const list = edges.get(k);
    if (!list || !list.length) return null;
    const e = list.pop()!;
    if (!list.length) edges.delete(k);
    return e;
  };
  for (const [k, list] of [...edges.entries()]) {
    while (list.length) {
      const first = take(k % (w + 1), Math.floor(k / (w + 1)))!;
      const pts: number[][] = [[first.x1, first.y1]];
      let cur = first;
      let guard = 0;
      for (;;) {
        pts.push([cur.x2, cur.y2]);
        const next = take(cur.x2, cur.y2);
        if (!next || ++guard > 4 * w * h + 16) break;
        cur = next;
        if (cur.x2 === first.x1 && cur.y2 === first.y1) {
          pts.push([cur.x2, cur.y2]);
          break;
        }
      }
      if (pts.length >= 4) loops.push(pts);
    }
  }
  return loops;
}

/** Главный вход: картинка → лица (внешние кольца + дырки) в мм, центр в (0;0). */
export function traceImage(src: BitmapImage, opts: TraceOptions = {}): TraceResult {
  const o = { ...DEF, ...opts };
  const { w, h, gray } = downscale(src, o.maxPixels);
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    const dark = gray[i] < o.threshold;
    ink[i] = (o.invert ? !dark : dark) ? 1 : 0;
  }
  const loops = boundaryLoops(w, h, ink);
  const scale = o.widthMm / w;
  const heightMm = h * scale;

  // кольца в мм, Y вверх, центр изображения в нуле
  const rings: Pt[][] = [];
  for (const loop of loops) {
    const pts = loop.map(([x, y]) => ({ x: (x - w / 2) * scale, y: (h / 2 - y) * scale }));
    // последняя точка повторяет первую — убираем
    const last = pts[pts.length - 1];
    if (Math.abs(last.x - pts[0].x) < 1e-9 && Math.abs(last.y - pts[0].y) < 1e-9) pts.pop();
    const sim = simplifyRing(pts, o.simplifyMm);
    if (sim.length >= 3 && Math.abs(ringArea(sim)) >= o.minAreaMm2) rings.push(sim);
  }

  // вложенность: родитель — самое маленькое кольцо, содержащее наше
  const depth = new Int32Array(rings.length).fill(0);
  const parent = new Int32Array(rings.length).fill(-1);
  for (let i = 0; i < rings.length; i++) {
    let best = -1, bestA = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      const aj = Math.abs(ringArea(rings[j]));
      if (aj <= Math.abs(ringArea(rings[i])) + 1e-12) continue;
      if (!inRing(rings[j], rings[i][0])) continue;
      if (aj < bestA) { bestA = aj; best = j; }
    }
    parent[i] = best;
  }
  const depthOf = (i: number): number => {
    let d = 0, p = parent[i];
    const seen = new Set<number>();
    while (p >= 0 && !seen.has(p)) { seen.add(p); d++; p = parent[p]; }
    return d;
  };
  for (let i = 0; i < rings.length; i++) depth[i] = depthOf(i);

  const faces: TraceFace[] = [];
  const faceOfRing = new Map<number, TraceFace>();
  let dropped = 0;
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    const face: TraceFace = { outer: rings[i], holes: [] };
    faces.push(face);
    faceOfRing.set(i, face);
  }
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 0) continue;
    const face = faceOfRing.get(parent[i]);
    if (face) face.holes.push(rings[i]);
    else dropped++;
  }

  return { faces, widthMm: o.widthMm, heightMm, pxWidth: w, pxHeight: h, dropped };
}

/** Лица → полигоны модели (слой шелкографии/меди, дырки внутри). */
export function facesToPolys(
  faces: TraceFace[],
  layer: Poly['layer'],
  idFn: () => string,
): Poly[] {
  return faces.map((f) => ({
    id: idFn(),
    kind: 'poly' as const,
    pts: f.outer,
    holes: f.holes.length ? f.holes.map((h) => h.slice()) : undefined,
    layer,
  }));
}
