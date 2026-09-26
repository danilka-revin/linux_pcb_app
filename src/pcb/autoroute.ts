// Автотрассировка одной связи (точка A -> точка B) на двух слоях меди.
//
// Алгоритм: волновой поиск A* по сетке с шагом `step` на двух слоях (K1/K2),
// переходы между слоями — переходными отверстиями (via). Состояние учитывает
// направление движения, чтобы штрафовать изломы и получать «чистые» дорожки
// под 45°/90°.
//
// Правило пайки: в исходные площадки-«пяточки», которые задаёт пользователь
// (не переходы-«мостовые»), дорожка ВСЕГДА входит только по нижнему слою K2
// (сторона пайки). К SMD-площадке дорожка подходит по слою самой площадки.
// Переходные отверстия («мостовые») доступны с любого слоя. Дальше дорожка
// может свободно менять слой через переходные отверстия.

import type { Entity, Pt, Track, Via } from './model';
import { uid } from './model';
import { expandDoc } from './expand';

export type Cu = 'k1' | 'k2';

export interface RouteOpts {
  trackW: number;      // ширина дорожки, мм
  clearance: number;   // зазор до чужих дорожек и прочей меди, мм
  holeClear?: number;  // зазор до чужих отверстий (площадки, переходы, крепёжные), мм; по умолч. = clearance
  viaSize: number;     // диаметр площадки перехода, мм
  viaDrill: number;    // сверло перехода, мм
  step: number;        // шаг сетки трассировки, мм
  viaCost: number;     // «цена» одного перехода (в мм длины дорожки)
  topMul: number;      // множитель длины на верхнем слое (>1 — предпочитать низ)
  allowVias?: boolean; // false: искать на разрешённых слоях без переходов
  allowTop: boolean;   // разрешить верхний слой и переходы
  angle: '45' | '90';  // допустимые направления
  edge?: number;       // отступ от края платы, мм (по умолчанию = зазор)
}

/** Конечная точка связи */
export interface RouteEnd {
  x: number; y: number;
  layers: Cu[];        // на каких слоях допустимо подключение:
                       // площадка — только K2, SMD — свой слой, переход — оба
  r: number;           // радиус собственной меди точки (площадки), мм
  entId?: string;      // id примитива (после развёртки), к которому подключаемся
  kind?: 'pad' | 'via' | 'smd';
  tht?: boolean;       // площадка-«пяточка» (вход только по K2 — сторона пайки)
}

export interface RouteResult {
  ok: boolean;
  ents: Entity[];      // новые дорожки и переходы
  length: number;      // суммарная длина дорожек, мм
  vias: number;
  msg: string;
  drc: number;         // число нарушений зазора после проверки (0 — чисто)
}

// ---------------------------------------------------------------------------
// Геометрия меди: «скелет» (отрезки с радиусом) или полигон.

interface Shape {
  id: string;
  layers: Cu[];
  segs: [number, number, number, number][]; // отрезки скелета
  r: number;                                  // радиус вокруг скелета
  poly?: Pt[];                                // залитая область (r = 0)
  bb: [number, number, number, number];
  hole?: boolean;                             // неметаллизированное отверстие
  drilled?: boolean;                          // объект с отверстием (площадка/переход/отверстие)
}

function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - x1) * dx + (py - y1) * dy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function segSegDist(a: [number, number, number, number], b: [number, number, number, number]): number {
  // пересечение
  const [ax1, ay1, ax2, ay2] = a, [bx1, by1, bx2, by2] = b;
  const d1x = ax2 - ax1, d1y = ay2 - ay1, d2x = bx2 - bx1, d2y = by2 - by1;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) > 1e-12) {
    const t = ((bx1 - ax1) * d2y - (by1 - ay1) * d2x) / den;
    const u = ((bx1 - ax1) * d1y - (by1 - ay1) * d1x) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(
    segDist(ax1, ay1, bx1, by1, bx2, by2), segDist(ax2, ay2, bx1, by1, bx2, by2),
    segDist(bx1, by1, ax1, ay1, ax2, ay2), segDist(bx2, by2, ax1, ay1, ax2, ay2),
  );
}

function inPoly(pts: Pt[], x: number, y: number): boolean {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

function polySegs(pts: Pt[]): [number, number, number, number][] {
  return pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return [p.x, p.y, q.x, q.y] as [number, number, number, number];
  });
}

/** Расстояние от точки до меди примитива (0 — внутри) */
export function shapeDist(s: Shape, x: number, y: number): number {
  if (s.poly) {
    if (inPoly(s.poly, x, y)) return 0;
  }
  let m = Infinity;
  for (const g of s.segs) {
    const d = segDist(x, y, g[0], g[1], g[2], g[3]);
    if (d < m) m = d;
  }
  return Math.max(0, m - s.r);
}

/** Расстояние между двумя фигурами (0 — касаются/перекрываются) */
function shapeShapeDist(a: Shape, b: Shape): number {
  if (a.poly && b.segs.length && inPoly(a.poly, b.segs[0][0], b.segs[0][1])) return 0;
  if (b.poly && a.segs.length && inPoly(b.poly, a.segs[0][0], a.segs[0][1])) return 0;
  let m = Infinity;
  for (const g of a.segs) for (const h of b.segs) {
    const d = segSegDist(g, h);
    if (d < m) m = d;
  }
  return Math.max(0, m - a.r - b.r);
}

function mkShape(id: string, layers: Cu[], segs: [number, number, number, number][], r: number, poly?: Pt[], hole?: boolean): Shape {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const g of segs) {
    x1 = Math.min(x1, g[0], g[2]); y1 = Math.min(y1, g[1], g[3]);
    x2 = Math.max(x2, g[0], g[2]); y2 = Math.max(y2, g[1], g[3]);
  }
  return { id, layers, segs, r, poly, bb: [x1 - r, y1 - r, x2 + r, y2 + r], hole, drilled: hole };
}

const drilled = (ss: Shape[]): Shape[] => { ss.forEach((x) => { x.drilled = true; }); return ss; };

function boxPoly(cx: number, cy: number, hw: number, hh: number): Pt[] {
  return [
    { x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy - hh },
    { x: cx + hw, y: cy + hh }, { x: cx - hw, y: cy + hh },
  ];
}

/** Медные фигуры развёрнутого примитива */
export function copperShapes(e: Entity): Shape[] {
  switch (e.kind) {
    case 'pad': {
      const sh = padShapes(e);
      return e.drill > 0 ? drilled(sh) : sh;
    }
    case 'via':
      return drilled([mkShape(e.id, ['k1', 'k2'], [[e.x, e.y, e.x, e.y]], e.size / 2)]);
    default:
      return otherShapes(e);
  }
}

function padShapes(e: Extract<Entity, { kind: 'pad' }>): Shape[] {
      if (e.shape === 'square') {
        const p = boxPoly(e.x, e.y, e.size / 2, e.size / 2);
        return [mkShape(e.id, ['k1', 'k2'], polySegs(p), 0, p)];
      }
      if (e.shape === 'oct') {
        const r = e.size / 2 / Math.cos(Math.PI / 8);
        const p: Pt[] = [];
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 8 + (i * Math.PI) / 4;
          p.push({ x: e.x + r * Math.cos(a), y: e.y + r * Math.sin(a) });
        }
        return [mkShape(e.id, ['k1', 'k2'], polySegs(p), 0, p)];
      }
      return [mkShape(e.id, ['k1', 'k2'], [[e.x, e.y, e.x, e.y]], e.size / 2)];
}

function otherShapes(e: Entity): Shape[] {
  switch (e.kind) {
    case 'hole':
      return [mkShape(e.id, ['k1', 'k2'], [[e.x, e.y, e.x, e.y]], e.d / 2, undefined, true)];
    case 'smd': {
      const rot = ((Math.round(e.rot) % 180) + 180) % 180;
      const w = rot === 90 ? e.h : e.w, h = rot === 90 ? e.w : e.h;
      const p = boxPoly(e.x, e.y, w / 2, h / 2);
      return [mkShape(e.id, [e.layer], polySegs(p), 0, p)];
    }
    case 'track': {
      const segs: [number, number, number, number][] = [];
      for (let i = 0; i < e.pts.length - 1; i++)
        segs.push([e.pts[i].x, e.pts[i].y, e.pts[i + 1].x, e.pts[i + 1].y]);
      if (!segs.length && e.pts.length) segs.push([e.pts[0].x, e.pts[0].y, e.pts[0].x, e.pts[0].y]);
      return segs.length ? [mkShape(e.id, [e.layer], segs, e.w / 2)] : [];
    }
    case 'poly':
      return e.pts.length >= 3 ? [mkShape(e.id, [e.layer], polySegs(e.pts), 0, e.pts)] : [];
    case 'rect': {
      if (e.layer !== 'k1' && e.layer !== 'k2') return [];
      const p = boxPoly(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2);
      if (e.filled) return [mkShape(e.id, [e.layer], polySegs(p), 0, p)];
      return [mkShape(e.id, [e.layer], polySegs(p), e.th / 2)];
    }
    case 'circle':
      if (e.layer !== 'k1' && e.layer !== 'k2') return [];
      {
        const segs: [number, number, number, number][] = [];
        const n = 24;
        for (let i = 0; i < n; i++) {
          const a1 = (i * 2 * Math.PI) / n, a2 = ((i + 1) * 2 * Math.PI) / n;
          segs.push([e.x + e.r * Math.cos(a1), e.y + e.r * Math.sin(a1), e.x + e.r * Math.cos(a2), e.y + e.r * Math.sin(a2)]);
        }
        return [mkShape(e.id, [e.layer], segs, e.w / 2)];
      }
    case 'line':
      if (e.layer !== 'k1' && e.layer !== 'k2') return [];
      return [mkShape(e.id, [e.layer as Cu], [[e.x1, e.y1, e.x2, e.y2]], e.w / 2)];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------

/** Найти медный примитив (площадку/переход/SMD) под точкой для подключения */
export function pickEndpoint(entities: Entity[], p: Pt, tol: number, layer?: Cu): RouteEnd | null {
  const flat = expandDoc(entities);
  let best: { e: Entity; d: number; edge: number } | null = null;
  for (const e of flat) {
    if (e.kind !== 'pad' && e.kind !== 'via' && e.kind !== 'smd') continue;
    if (layer && !endpointOf(e)?.layers.includes(layer)) continue;
    for (const s of copperShapes(e)) {
      const d = shapeDist(s, p.x, p.y);
      if (d <= tol) {
        const dc = Math.hypot(p.x - e.x, p.y - e.y);
        if (!best || d < best.edge - 1e-6 || (Math.abs(d - best.edge) < 1e-6 && dc < best.d)) best = { e, d: dc, edge: d };
      }
    }
  }
  if (!best) return null;
  return endpointOf(best.e);
}

export function endpointOf(e: Entity): RouteEnd | null {
  if (e.kind === 'pad') {
    // «Пяточка»: пайка со стороны K2 — вход только по нижнему слою (всегда, даже без отверстия)
    return { x: e.x, y: e.y, layers: ['k2'], r: e.size / 2, entId: e.id, kind: 'pad', tht: true };
  }
  // «Мостовая» (переход) — доступна с любого слоя
  if (e.kind === 'via') return { x: e.x, y: e.y, layers: ['k2', 'k1'], r: e.size / 2, entId: e.id, kind: 'via' };
  if (e.kind === 'smd') {
    // К SMD — только по слою самой площадки
    const rot = ((Math.round(e.rot) % 180) + 180) % 180;
    const r = Math.min(rot === 90 ? e.h : e.w, rot === 90 ? e.w : e.h) / 2;
    return { x: e.x, y: e.y, layers: [e.layer], r, entId: e.id, kind: 'smd' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Двоичная куча (минимум по f)

class Heap {
  private k: number[] = [];
  private f: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, pr: number): void {
    const k = this.k, f = this.f;
    let i = k.length;
    k.push(key); f.push(pr);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[p] <= pr) break;
      k[i] = k[p]; f[i] = f[p]; i = p;
    }
    k[i] = key; f[i] = pr;
  }
  pop(): number {
    const k = this.k, f = this.f;
    const top = k[0];
    const lk = k.pop()!, lf = f.pop()!;
    const n = k.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && f[c + 1] < f[c]) c++;
        if (f[c] >= lf) break;
        k[i] = k[c]; f[i] = f[c]; i = c;
      }
      k[i] = lk; f[i] = lf;
    }
    return top;
  }
}

const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/** Границы платы: по контуру, иначе 0..w × 0..h */
function boardBounds(entities: Entity[], w: number, h: number): [number, number, number, number] {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of expandDoc(entities)) {
    const l = (e as { layer?: string }).layer;
    if (l !== 'outline') continue;
    if (e.kind === 'rect') { x1 = Math.min(x1, e.x); y1 = Math.min(y1, e.y); x2 = Math.max(x2, e.x + e.w); y2 = Math.max(y2, e.y + e.h); }
    else if (e.kind === 'line') { x1 = Math.min(x1, e.x1, e.x2); y1 = Math.min(y1, e.y1, e.y2); x2 = Math.max(x2, e.x1, e.x2); y2 = Math.max(y2, e.y1, e.y2); }
    else if (e.kind === 'circle') { x1 = Math.min(x1, e.x - e.r); y1 = Math.min(y1, e.y - e.r); x2 = Math.max(x2, e.x + e.r); y2 = Math.max(y2, e.y + e.r); }
  }
  if (!isFinite(x1) || x2 - x1 < 1 || y2 - y1 < 1) return [0, 0, w, h];
  return [x1, y1, x2, y2];
}

/** Сбор цепи: всё, что электрически связано с примитивами-зёрнами */
export function netOf(shapes: Shape[], seeds: Set<string>): Set<string> {
  const inNet = new Set<string>();
  const queue: Shape[] = [];
  for (const s of shapes) if (seeds.has(s.id)) { inNet.add(s.id); queue.push(s); }
  while (queue.length) {
    const a = queue.pop()!;
    for (const b of shapes) {
      if (inNet.has(b.id) || b.hole || a.hole) continue;
      if (!a.layers.some((l) => b.layers.includes(l))) continue;
      if (b.bb[0] > a.bb[2] + 1e-6 || b.bb[2] < a.bb[0] - 1e-6 || b.bb[1] > a.bb[3] + 1e-6 || b.bb[3] < a.bb[1] - 1e-6) continue;
      if (shapeShapeDist(a, b) <= 1e-4) { inNet.add(b.id); queue.push(b); }
    }
  }
  return inNet;
}

interface Attempt {
  nodes: { x: number; y: number; l: Cu }[];
}

function search(
  o: RouteOpts, A: RouteEnd, B: RouteEnd,
  obst: Shape[], netShapes: Shape[], bounds: [number, number, number, number], margin: number,
): Attempt | 'blockA' | 'blockB' | null {
  const st = o.step;
  const edge = o.edge ?? o.clearance;
  const ix0 = Math.ceil(bounds[0] / st), iy0 = Math.ceil(bounds[1] / st);
  const ix1 = Math.floor(bounds[2] / st), iy1 = Math.floor(bounds[3] / st);
  const W = ix1 - ix0 + 1, H = iy1 - iy0 + 1;
  if (W < 2 || H < 2) return null;
  const N = W * H;
  const X = (i: number): number => (ix0 + i) * st;
  const Y = (j: number): number => (iy0 + j) * st;

  // поле расстояний до чужой меди на каждом слое + до отверстий
  // dist — до дорожек/прочей меди, distH — до объектов с отверстиями
  const dist = [new Float32Array(N).fill(1e9), new Float32Array(N).fill(1e9)];
  const distH = [new Float32Array(N).fill(1e9), new Float32Array(N).fill(1e9)];
  const viaBlock = new Uint8Array(N);
  const hc = o.holeClear ?? o.clearance;
  const trackNeed = o.clearance + o.trackW / 2 + margin;
  const viaNeed = o.clearance + o.viaSize / 2 + margin;
  const trackNeedH = hc + o.trackW / 2 + margin;
  const viaNeedH = hc + o.viaSize / 2 + margin;
  const R = Math.max(trackNeed, viaNeed, trackNeedH, viaNeedH) + st;
  const cellRange = (bb: [number, number, number, number], r: number) => ({
    i1: Math.max(0, Math.floor((bb[0] - r) / st) - ix0), i2: Math.min(W - 1, Math.ceil((bb[2] + r) / st) - ix0),
    j1: Math.max(0, Math.floor((bb[1] - r) / st) - iy0), j2: Math.min(H - 1, Math.ceil((bb[3] + r) / st) - iy0),
  });
  for (const s of obst) {
    const { i1, i2, j1, j2 } = cellRange(s.bb, R);
    for (let j = j1; j <= j2; j++) {
      const y = Y(j);
      for (let i = i1; i <= i2; i++) {
        const d = shapeDist(s, X(i), y);
        if (d > R) continue;
        const c = j * W + i;
        const f = s.drilled ? distH : dist;
        for (const l of s.layers) {
          const li = l === 'k1' ? 0 : 1;
          if (d < f[li][c]) f[li][c] = d;
        }
      }
    }
  }
  // переходы не ставить на собственные площадки цепи и вплотную к ним
  for (const s of netShapes) {
    const need = o.viaSize / 2 + Math.max(o.clearance, hc);
    const { i1, i2, j1, j2 } = cellRange(s.bb, need + st);
    for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++)
      if (shapeDist(s, X(i), Y(j)) < need) viaBlock[j * W + i] = 1;
  }
  const free = (li: number, c: number): boolean => dist[li][c] >= trackNeed && distH[li][c] >= trackNeedH;
  const viaOk = (c: number): boolean => !viaBlock[c] &&
    dist[0][c] >= viaNeed && dist[1][c] >= viaNeed && distH[0][c] >= viaNeedH && distH[1][c] >= viaNeedH;
  const inEdge = (i: number, j: number, need: number): boolean => {
    const x = X(i), y = Y(j);
    return x - bounds[0] >= need && bounds[2] - x >= need && y - bounds[1] >= need && bounds[3] - y >= need;
  };

  // Слои входа: у площадки это всегда K2 (сторона пайки), у SMD — её слой,
  // у перехода — оба (с учётом запрета верхнего слоя).
  const entA = A.layers.filter((l) => o.allowTop || l === 'k2');
  const entB = B.layers.filter((l) => o.allowTop || l === 'k2');
  if (!entA.length || !entB.length) return null;

  const mul = [o.allowTop ? o.topMul : Infinity, 1];
  const dirs = o.angle === '90' ? [0, 2, 4, 6] : [0, 1, 2, 3, 4, 5, 6, 7];
  const turnCost = [0, 0.35 * st + 0.15, 1.2 * st + 0.4, Infinity, Infinity];
  const ND = 9; // 8 направлений + «нет направления»
  const S = 2 * N * ND;
  const g = new Float32Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const heap = new Heap();

  const hr = (x: number, y: number): number => {
    const dx = Math.abs(x - B.x), dy = Math.abs(y - B.y);
    const oct = o.angle === '90' ? dx + dy : Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    return Math.max(0, oct - B.r - st * 1.5);
  };
  const key = (li: number, c: number, d: number): number => (li * N + c) * ND + d;

  // стартовые узлы: внутри собственной площадки A (или ближайшие)
  const nodesNear = (P: RouteEnd): number[] => {
    // Длинная узкая SMD-площадка — не круг с радиусом половины ширины.
    // Используем всю её медь: выход у торца может быть свободен, хотя центр
    // окружён соседними выводами и между ними не проходит узел сетки.
    const terminal = netShapes.filter(s => s.id === P.entId);
    const bb = terminal.length ? terminal.reduce<[number, number, number, number]>(
      (b, s) => [Math.min(b[0], s.bb[0]), Math.min(b[1], s.bb[1]), Math.max(b[2], s.bb[2]), Math.max(b[3], s.bb[3])],
      [Infinity, Infinity, -Infinity, -Infinity]) : null;
    const reach = st + trackNeed;
    const rr = Math.max(P.r, st * 0.75);
    const out: number[] = [];
    const i1 = Math.max(0, Math.floor((bb ? bb[0] - reach : P.x - rr) / st) - ix0), i2 = Math.min(W - 1, Math.ceil((bb ? bb[2] + reach : P.x + rr) / st) - ix0);
    const j1 = Math.max(0, Math.floor((bb ? bb[1] - reach : P.y - rr) / st) - iy0), j2 = Math.min(H - 1, Math.ceil((bb ? bb[3] + reach : P.y + rr) / st) - iy0);
    for (let j = j1; j <= j2; j++) for (let i = i1; i <= i2; i++)
      if (terminal.length ? terminal.some(s => shapeDist(s, X(i), Y(j)) <= reach + 1e-6) : Math.hypot(X(i) - P.x, Y(j) - P.y) <= rr + 1e-6) out.push(j * W + i);
    if (!out.length) {
      const i = Math.round(P.x / st) - ix0, j = Math.round(P.y / st) - iy0;
      if (i >= 0 && i < W && j >= 0 && j < H) out.push(j * W + i);
    }
    return out;
  };
  // короткий подвод «узел сетки → центр площадки» тоже должен соблюдать зазоры
  const stubSegmentOk = (li: number, x: number, y: number, P: Pt): boolean => {
    const l: Cu = li ? 'k2' : 'k1';
    const seg: [number, number, number, number] = [x, y, P.x, P.y];
    for (const s of obst) {
      if (!s.layers.includes(l)) continue;
      const need = (s.drilled ? hc : o.clearance) + o.trackW / 2 + s.r;
      if (s.bb[0] - need > Math.max(x, P.x) || s.bb[2] + need < Math.min(x, P.x) ||
        s.bb[1] - need > Math.max(y, P.y) || s.bb[3] + need < Math.min(y, P.y)) continue;
      if (s.poly && inPoly(s.poly, x, y)) return false;
      for (const g of s.segs) if (segSegDist(seg, g) < need - 1e-6) return false;
    }
    return true;
  };
  const stubPath = (li: number, x: number, y: number, P: RouteEnd): Pt[] | null => {
    if (stubSegmentOk(li, x, y, P)) return [];
    // Выход вдоль узкой площадки, затем на сетку: диагональный подвод
    // из центра мог пересекать соседний вывод даже при свободном торце.
    for (const bend of [{ x, y: P.y }, { x: P.x, y }]) {
      if (stubSegmentOk(li, x, y, bend) && stubSegmentOk(li, bend.x, bend.y, P)) return [bend];
    }
    return null;
  };
  const stubOk = (li: number, x: number, y: number, P: RouteEnd): boolean => stubPath(li, x, y, P) !== null;
  const startCells = nodesNear(A);
  const goalCells = new Set(nodesNear(B));
  for (const c of startCells) {
    const i = c % W, j = (c / W) | 0;
    for (const l of entA) {
      const li = l === 'k1' ? 0 : 1;
      if (!free(li, c) || !stubOk(li, X(i), Y(j), A)) continue;
      const g0 = Math.hypot(X(i) - A.x, Y(j) - A.y) * mul[li];
      const k = key(li, c, 8);
      if (g0 < g[k]) { g[k] = g0; heap.push(k, g0 + hr(X(i), Y(j))); }
    }
  }
  const goalLi = new Set(entB.map((l) => (l === 'k1' ? 0 : 1)));
  if (!heap.size) return 'blockA';
  {
    let any = false;
    for (const c of goalCells) {
      const i = c % W, j = (c / W) | 0;
      for (const li of goalLi) if (free(li, c) && stubOk(li, X(i), Y(j), B)) any = true;
    }
    if (!any) return 'blockB';
  }

  let found = -1;
  let iter = 0;
  const maxIter = 6_000_000;
  while (heap.size && iter++ < maxIter) {
    const k = heap.pop();
    if (closed[k]) continue;
    closed[k] = 1;
    const gk = g[k];
    const d = k % ND;
    const lc = (k - d) / ND;
    const li = lc >= N ? 1 : 0;
    const c = lc - li * N;
    const i = c % W, j = (c - i) / W;
    // цель
    if (goalLi.has(li) && goalCells.has(c) && stubOk(li, X(i), Y(j), B)) { found = k; break; }
    // ходы по слою
    for (const nd of dirs) {
      let tc = 0;
      if (d !== 8) {
        let diff = Math.abs(nd - d); if (diff > 4) diff = 8 - diff;
        tc = turnCost[diff];
        if (!isFinite(tc)) continue;
      }
      const ni = i + DX[nd], nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
      const nc = nj * W + ni;
      if (!free(li, nc)) continue;
      if (!inEdge(ni, nj, edge + o.trackW / 2) && !goalCells.has(nc)) continue;
      // диагональ: проверка «срезания угла» между двумя препятствиями
      if (nd & 1) {
        const c1 = j * W + ni, c2 = nj * W + i;
        if (!free(li, c1) && !free(li, c2)) continue;
      }
      const len = (nd & 1 ? Math.SQRT2 : 1) * st;
      const nk = key(li, nc, nd);
      if (closed[nk]) continue;
      const ng = gk + len * mul[li] + tc;
      if (ng < g[nk]) {
        g[nk] = ng; prev[nk] = k;
        heap.push(nk, ng + hr(X(ni), Y(nj)));
      }
    }
    // переход на другой слой
    if (o.allowTop && o.allowVias !== false && viaOk(c) && inEdge(i, j, edge + o.viaSize / 2)) {
      const oli = 1 - li;
      if (free(oli, c)) {
        const nk = key(oli, c, 8);
        if (!closed[nk]) {
          const ng = gk + o.viaCost;
          if (ng < g[nk]) {
            g[nk] = ng; prev[nk] = k;
            heap.push(nk, ng + hr(X(i), Y(j)));
          }
        }
      }
    }
  }
  if (found < 0) return null;
  const nodes: { x: number; y: number; l: Cu }[] = [];
  for (let k = found; k >= 0; k = prev[k]) {
    const d = k % ND;
    const lc = (k - d) / ND;
    const li = lc >= N ? 1 : 0;
    const c = lc - li * N;
    const i = c % W, j = (c - i) / W;
    nodes.push({ x: +X(i).toFixed(4), y: +Y(j).toFixed(4), l: li ? 'k2' : 'k1' });
  }
  nodes.reverse();
  const first = nodes[0], last = nodes[nodes.length - 1];
  const entry = stubPath(first.l === 'k1' ? 0 : 1, first.x, first.y, A)!;
  const exit = stubPath(last.l === 'k1' ? 0 : 1, last.x, last.y, B)!;
  nodes.unshift(...entry.slice().reverse().map(p => ({ ...p, l: first.l })));
  nodes.push(...exit.map(p => ({ ...p, l: last.l })));
  return { nodes };
}

/** Полилинии и переходы из цепочки узлов */
function buildEnts(o: RouteOpts, A: RouteEnd, B: RouteEnd, nodes: { x: number; y: number; l: Cu }[]): { ents: Entity[]; length: number; vias: number } {
  const pts = [{ x: A.x, y: A.y, l: nodes[0].l }, ...nodes, { x: B.x, y: B.y, l: nodes[nodes.length - 1].l }];
  // разбить на участки одного слоя
  const runs: { l: Cu; pts: Pt[] }[] = [];
  const viaPts: Pt[] = [];
  for (const p of pts) {
    const run = runs[runs.length - 1];
    if (!run || run.l !== p.l) {
      if (run) viaPts.push({ x: p.x, y: p.y });
      runs.push({ l: p.l, pts: run ? [{ x: p.x, y: p.y }] : [{ x: p.x, y: p.y }] });
    } else {
      const last = run.pts[run.pts.length - 1];
      if (Math.hypot(last.x - p.x, last.y - p.y) > 1e-6) run.pts.push({ x: p.x, y: p.y });
    }
  }
  // убрать промежуточные точки на прямой
  const simplify = (ps: Pt[]): Pt[] => {
    if (ps.length < 3) return ps;
    const out = [ps[0]];
    for (let i = 1; i < ps.length - 1; i++) {
      const a = out[out.length - 1], b = ps[i], c = ps[i + 1];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cr) > 1e-7) out.push(b);
    }
    out.push(ps[ps.length - 1]);
    return out;
  };
  const ents: Entity[] = [];
  let length = 0;
  for (const r of runs) {
    const sp = simplify(r.pts);
    if (sp.length < 2) continue;
    for (let i = 0; i < sp.length - 1; i++) length += Math.hypot(sp[i + 1].x - sp[i].x, sp[i + 1].y - sp[i].y);
    const t: Track = { id: uid(), kind: 'track', pts: sp, w: o.trackW, layer: r.l };
    ents.push(t);
  }
  for (const p of viaPts) {
    const v: Via = { id: uid(), kind: 'via', x: p.x, y: p.y, size: o.viaSize, drill: o.viaDrill };
    ents.push(v);
  }
  return { ents, length, vias: viaPts.length };
}

/** Проверка зазоров готового результата относительно чужой меди */
function drcCount(o: RouteOpts, ents: Entity[], obst: Shape[]): number {
  let bad = 0;
  for (const e of ents) {
    for (const s of copperShapes(e)) {
      for (const ob of obst) {
        if (!s.layers.some((l) => ob.layers.includes(l))) continue;
        const cl = ob.drilled || s.drilled ? (o.holeClear ?? o.clearance) : o.clearance;
        if (ob.bb[0] > s.bb[2] + cl || ob.bb[2] < s.bb[0] - cl ||
          ob.bb[1] > s.bb[3] + cl || ob.bb[3] < s.bb[1] - cl) continue;
        if (shapeShapeDist(s, ob) < cl - 1e-3) bad++;
      }
    }
  }
  return bad;
}

/**
 * Проложить дорожку между A и B.
 * entities — текущие элементы документа (компоненты разворачиваются автоматически).
 * ownIds — остальные площадки той же заданной цепи: к её меди можно примыкать.
 */
export function autoroute(
  entities: Entity[], boardW: number, boardH: number,
  A: RouteEnd, B: RouteEnd, o: RouteOpts, ownIds: string[] = [],
): RouteResult {
  const fail = (msg: string): RouteResult => ({ ok: false, ents: [], length: 0, vias: 0, msg, drc: 0 });
  if (Math.hypot(A.x - B.x, A.y - B.y) < 1e-6) return fail('Точки совпадают');
  if (!Number.isFinite(o.step) || o.step < 0.02) return fail('Минимальный шаг сетки трассировки — 0.02 мм');
  if (!o.allowTop && [A, B].some(p => !p.layers.includes('k2')))
    return fail('Выбран SMD-контакт на K1. Включите «Разрешить верх (K1) и переходы»: по K2 к нему подключиться нельзя.');

  const flat = expandDoc(entities);
  const shapes = flat.flatMap(copperShapes);
  const seeds = new Set<string>(ownIds);
  if (A.entId) seeds.add(A.entId);
  if (B.entId) seeds.add(B.entId);
  const net = netOf(shapes, seeds);
  const obst = shapes.filter((s) => !net.has(s.id));
  // Пайка снизу: сверху к собственной площадке-«пяточке» дорожка подходить не должна
  for (const e of flat) {
    if (e.kind !== 'pad' || !net.has(e.id)) continue;
    for (const s of shapes) if (s.id === e.id) obst.push({ ...s, layers: ['k1'], id: s.id + '#top' });
  }
  const netShapes = shapes.filter((s) => net.has(s.id) && (s.drilled || s.id === A.entId || s.id === B.entId));

  let bounds = boardBounds(entities, boardW, boardH);
  const pad = 2;
  bounds = [
    Math.min(bounds[0], Math.min(A.x, B.x) - pad), Math.min(bounds[1], Math.min(A.y, B.y) - pad),
    Math.max(bounds[2], Math.max(A.x, B.x) + pad), Math.max(bounds[3], Math.max(A.y, B.y) + pad),
  ];
  // ограничить размер сетки (память/время)
  const cells = ((bounds[2] - bounds[0]) / o.step) * ((bounds[3] - bounds[1]) / o.step);
  if (cells > 400_000) return fail('Слишком большая плата для такого мелкого шага — увеличьте шаг сетки трассировки');

  let firstFound: { ents: Entity[]; length: number; vias: number; drc: number } | null = null;
  for (const margin of [0, o.step * 0.3, o.step * 0.6]) {
    const at = search(o, A, B, obst, netShapes, bounds, margin);
    if (at === 'blockA' || at === 'blockB') {
      if (margin === 0) return fail(`${at === 'blockA' ? 'Первая' : 'Вторая'} точка слишком близко к чужой дорожке или отверстию — нельзя подвести дорожку с заданным зазором`);
      continue;
    }
    if (!at) {
      if (margin === 0) break; // без запаса не нашлось — дальше тем более
      continue;
    }
    const built = buildEnts(o, A, B, at.nodes);
    const drc = drcCount(o, built.ents, obst);
    if (!firstFound || drc < firstFound.drc) firstFound = { ...built, drc };
    if (drc === 0) break;
  }
  if (!firstFound) {
    const why = !o.allowTop
      ? 'Путь только по нижнему слою не найден — разрешите верхний слой и переходы'
      : 'Путь не найден: мешают другие элементы. Уменьшите зазор/ширину или шаг сетки';
    return fail(why);
  }
  const { ents, length, vias, drc } = firstFound;
  let msg = `Готово: ${length.toFixed(1)} мм, переходов: ${vias}`;
  if (drc) msg += ` · внимание: ${drc} нарушений зазора, проверьте`;
  return { ok: true, ents, length, vias, msg, drc };
}

/** Минимальный зазор от круга (x, y, r) до меди документа, мм (0 — перекрытие) */
export function clearanceAt(entities: Entity[], x: number, y: number, r: number): number {
  let m = Infinity;
  for (const e of expandDoc(entities))
    for (const s of copperShapes(e)) {
      const d = shapeDist(s, x, y) - r;
      if (d < m) m = d;
    }
  return Math.max(0, m);
}
