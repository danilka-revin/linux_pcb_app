// Инструмент «Усечь кривую» (Trim / Extend / Break) — чистая геометрия без DOM.
//
// Логика как в CAD и CorelDRAW: кривая режется в точках пересечения с другими
// кривыми, кусок под курсором удаляется; «продлить» дотягивает конец кривой до
// ближайшей границы; «разрезать» делит кривую в точке клика.
//
// Кривые Безье делятся точно (де Кастельжо), поэтому дуги и сплайны не
// вырождаются в ломаные: после усечения форма оставшихся кусков не меняется.

import {
  luid, sampleBezierSegment, shapeBBox, shapeToPath, shapeToPolylines,
  type LaserShape, type PathNode, type PathShape, type Pt,
} from './model';

/** Шаг аппроксимации сегмента Безье при поиске пересечений. */
export const TRIM_SAMPLES = 16;
/** Реже этой дистанции два реза считаются одним, мм. */
const CUT_EPS = 2e-3;
/** Рез ближе этого к концу открытой кривой считается касанием и отбрасывается. */
const END_EPS = 1e-2;
/** Дальность поиска границы для «продлить», мм. */
const EXTEND_MAX_MM = 2000;

// ---------------- аппроксимация кривой ----------------

export interface SampledCurve {
  /** Точки полилинии; первая — узел 0. */
  pts: Pt[];
  /** Для каждой точки: индекс сегмента узлов и локальный параметр t (0..1). */
  map: { seg: number; t: number }[];
  /** Накопленная длина до каждой точки, мм. */
  cum: number[];
  /** Длина в конце каждого сегмента узлов (индекс = номер узла), мм. */
  nodeS: number[];
  /** Полная длина контура, мм. */
  length: number;
  closed: boolean;
}

const near = (a: Pt, b: Pt, eps = 1e-9) => Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

/** Точка кубической кривой между узлами a и b (рычаги берутся из узлов). */
export function cubicAt(a: PathNode, b: PathNode, t: number): Pt {
  const p1: Pt = { x: a.cp2x ?? a.x, y: a.cp2y ?? a.y };
  const p2: Pt = { x: b.cp1x ?? b.x, y: b.cp1y ?? b.y };
  const mt = 1 - t;
  return {
    x: mt * mt * mt * a.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * b.x,
    y: mt * mt * mt * a.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * b.y,
  };
}

/** Кривая — это настоящий Безье (а не отрезок)? */
function isCurved(a: PathNode, b: PathNode): boolean {
  const c1 = a.cp2x !== undefined && a.cp2y !== undefined && !near({ x: a.cp2x, y: a.cp2y }, { x: a.x, y: a.y }, 1e-9);
  const c2 = b.cp1x !== undefined && b.cp1y !== undefined && !near({ x: b.cp1x, y: b.cp1y }, { x: b.x, y: b.y }, 1e-9);
  return c1 || c2;
}

/** Развёртка кривой в полилинию с картой «точка → сегмент узлов и параметр t». */
export function samplePath(shape: PathShape, steps = TRIM_SAMPLES): SampledCurve {
  const nodes = shape.nodes;
  const pts: Pt[] = [];
  const map: { seg: number; t: number }[] = [];
  const cum: number[] = [];
  const nodeS: number[] = [0];
  const closed = !!shape.closed && nodes.length > 1;
  if (!nodes.length) return { pts, map, cum, nodeS, length: 0, closed };

  pts.push({ x: nodes[0].x, y: nodes[0].y });
  map.push({ seg: 0, t: 0 });
  cum.push(0);

  const segCount = closed ? nodes.length : Math.max(0, nodes.length - 1);
  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const add = isCurved(a, b) ? sampleBezierSegment(a, b, steps) : [{ x: b.x, y: b.y }];
    const n = add.length || 1;
    add.forEach((p, k) => {
      pts.push(p);
      map.push({ seg: i, t: (k + 1) / n });
    });
    let len = 0;
    for (let k = pts.length - add.length - 1; k < pts.length - 1; k++) {
      len += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].y - pts[k].y);
    }
    nodeS.push(nodeS[nodeS.length - 1] + len);
  }
  // накопленная длина — одним проходом, без накопления ошибок округления
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    cum.push(acc);
  }
  return { pts, map, cum, nodeS, length: acc, closed };
}

/** Ближайшая точка полилинии кривой: дистанция, индекс и длина вдоль контура. */
export function nearestOnSampled(
  curve: SampledCurve,
  p: Pt
): { dist: number; s: number; point: Pt; index: number } | null {
  const pts = curve.pts;
  if (!pts.length) return null;
  if (pts.length === 1) {
    return { dist: Math.hypot(p.x - pts[0].x, p.y - pts[0].y), s: 0, point: { ...pts[0] }, index: 0 };
  }
  let best = { dist: Infinity, s: 0, point: { ...pts[0] }, index: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-18 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) {
      best = { dist: d, s: curve.cum[i] + t * Math.sqrt(l2), point: q, index: i };
    }
  }
  return best;
}

// ---------------- пересечения ----------------

/** Точка пересечения двух отрезков; null если не пересекаются. */
export function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt, eps = 1e-9): Pt | null {
  const r1x = b.x - a.x, r1y = b.y - a.y;
  const r2x = d.x - c.x, r2y = d.y - c.y;
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < 1e-12) return null; // параллельны или коллинеарны
  const t1 = ((c.x - a.x) * r2y - (c.y - a.y) * r2x) / den;
  const t2 = ((c.x - a.x) * r1y - (c.y - a.y) * r1x) / den;
  if (t1 < -eps || t1 > 1 + eps || t2 < -eps || t2 > 1 + eps) return null;
  return { x: a.x + r1x * Math.max(0, Math.min(1, t1)), y: a.y + r1y * Math.max(0, Math.min(1, t1)) };
}

/** Точный параметр t на сегменте узлов, соответствующий точке p (бискон по отрезку аппроксимации). */
function refineT(a: PathNode, b: PathNode, p: Pt, t0: number, t1: number): number {
  if (!isCurved(a, b)) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    return l2 > 1e-18 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  }
  let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  if (hi - lo < 1e-12) return lo;
  for (let i = 0; i < 48; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const d1 = Math.hypot(cubicAt(a, b, m1).x - p.x, cubicAt(a, b, m1).y - p.y);
    const d2 = Math.hypot(cubicAt(a, b, m2).x - p.x, cubicAt(a, b, m2).y - p.y);
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/** Разрез кривой: сегмент узлов, параметр и длина вдоль контура. */
export interface Cut {
  seg: number;
  t: number;
  point: Pt;
  s: number;
}

/** Пространственный хэш отрезков — чтобы не сравнивать всё со всем. */
function buildGrid(segs: { a: Pt; b: Pt }[], cell: number): Map<string, number[]> {
  const g = new Map<string, number[]>();
  segs.forEach((s, i) => {
    const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x);
    const y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const k = `${cx}:${cy}`;
        const list = g.get(k);
        if (list) list.push(i);
        else g.set(k, [i]);
      }
    }
  });
  return g;
}

/**
 * Точный разрез по отрезку аппроксимации: индекс точки в полилинии + сама точка.
 * Отрезок [index, index+1] всегда лежит в сегменте узлов map[index+1].seg.
 */
export function cutAtSampled(curve: SampledCurve, nodes: PathNode[], index: number, p: Pt): Cut | null {
  const m0 = curve.map[index];
  const m1 = curve.map[index + 1];
  if (!m0 || !m1) return null;
  const seg = m1.seg;
  const a = nodes[seg];
  const b = nodes[(seg + 1) % nodes.length];
  if (!a || !b) return null;
  const t0 = m0.seg === seg ? m0.t : 0;
  const t = refineT(a, b, p, t0, m1.t);
  const base = curve.pts[index];
  const s = curve.cum[index] + (base ? Math.hypot(p.x - base.x, p.y - base.y) : 0);
  return { seg, t, point: { x: p.x, y: p.y }, s };
}

export interface CutOptions {
  /** Искать самопересечения кривой (по умолчанию да). */
  self?: boolean;
  /** Шаг аппроксимации Безье. */
  steps?: number;
}

/**
 * Все точки, где кривая `target` пересекает границы `boundaries`
 * (полилинии других объектов) или саму себя.
 */
export function findCuts(target: PathShape, boundaries: Pt[][], opts: CutOptions = {}): Cut[] {
  const steps = opts.steps ?? TRIM_SAMPLES;
  const self = opts.self !== false;
  const curve = samplePath(target, steps);
  if (curve.pts.length < 2) return [];

  const nodes = target.nodes;
  const nCount = nodes.length;
  const raw: Cut[] = [];

  const push = (index: number, p: Pt) => {
    const cut = cutAtSampled(curve, nodes, index, p);
    if (cut) raw.push(cut);
  };

  // 1. Пересечения с другими объектами
  const otherSegs: { a: Pt; b: Pt }[] = [];
  for (const pl of boundaries) {
    for (let i = 0; i < pl.length - 1; i++) otherSegs.push({ a: pl[i], b: pl[i + 1] });
  }
  if (otherSegs.length) {
    const cell = Math.max(1, Math.min(20, curve.length / 64 || 4));
    const grid = buildGrid(otherSegs, cell);
    for (let i = 0; i < curve.pts.length - 1; i++) {
      const a = curve.pts[i], b = curve.pts[i + 1];
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
      const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const seen = new Set<number>();
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          for (const idx of grid.get(`${cx}:${cy}`) ?? []) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            const p = segIntersect(a, b, otherSegs[idx].a, otherSegs[idx].b);
            if (p) push(i, p);
          }
        }
      }
    }
  }

  // 2. Самопересечения (несоседние отрезки аппроксимации)
  if (self && curve.pts.length > 3) {
    const ownSegs = curve.pts.slice(0, -1).map((p, i) => ({ a: p, b: curve.pts[i + 1] }));
    const cell = Math.max(1, Math.min(20, curve.length / 64 || 4));
    const grid = buildGrid(ownSegs, cell);
    const last = ownSegs.length - 1;
    for (let i = 0; i < ownSegs.length; i++) {
      const s = ownSegs[i];
      const x0 = Math.min(s.a.x, s.b.x), x1 = Math.max(s.a.x, s.b.x);
      const y0 = Math.min(s.a.y, s.b.y), y1 = Math.max(s.a.y, s.b.y);
      const seen = new Set<number>();
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) {
        for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
          for (const j of grid.get(`${cx}:${cy}`) ?? []) {
            if (j <= i + 1) continue;
            if (curve.closed && i === 0 && j === last) continue;
            if (seen.has(j)) continue;
            seen.add(j);
            const p = segIntersect(s.a, s.b, ownSegs[j].a, ownSegs[j].b);
            if (p) {
              // самопересечение даёт два реза: кривая проходит точку дважды
              push(i, p);
              push(j, p);
            }
          }
        }
      }
    }
  }

  // 3. Привязка к узлам, склейка повторов и сортировка по длине вдоль контура
  for (const c of raw) {
    let best = -1;
    let bestD = CUT_EPS;
    for (let i = 0; i < nCount; i++) {
      const d = Math.hypot(nodes[i].x - c.point.x, nodes[i].y - c.point.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      // рез ровно в узле: так деление кривой однозначно и не плодит дубли
      c.seg = best;
      c.t = 0;
      c.point = { x: nodes[best].x, y: nodes[best].y };
    } else if (c.t < 1e-6) c.t = 0;
    else if (c.t > 1 - 1e-6) c.t = 1;
  }
  raw.sort((p, q) => p.s - q.s);
  const merged: Cut[] = [];
  const seenNodes = new Set<number>();
  for (const c of raw) {
    if (c.t <= 0) {
      const key = c.seg % nCount;
      // точка замыкания и самопересечения в узле приходят несколько раз
      if (seenNodes.has(key)) continue;
      seenNodes.add(key);
      merged.push({ ...c });
      continue;
    }
    const prev = merged[merged.length - 1];
    if (
      prev
      && prev.t > 0
      && Math.abs(prev.s - c.s) < CUT_EPS
      && Math.hypot(prev.point.x - c.point.x, prev.point.y - c.point.y) < CUT_EPS
    ) {
      // одна и та же точка, пойманная двумя соседними отрезками аппроксимации
      prev.point = { x: (prev.point.x + c.point.x) / 2, y: (prev.point.y + c.point.y) / 2 };
      continue;
    }
    merged.push({ ...c });
  }

  // У открытой кривой рез в самом начале или в самом конце ничего не делит:
  // кусок получается нулевой длины, а объект при этом теряется. Такое бывает,
  // когда конец кривой просто касается границы или лежит на краю листа.
  if (!target.closed && merged.length) {
    const end = curve.length;
    for (let i = merged.length - 1; i >= 0; i--) {
      if (merged[i].s <= END_EPS || end - merged[i].s <= END_EPS) merged.splice(i, 1);
    }
  }
  return merged;
}

// ---------------- точное деление кривой ----------------

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

interface ChainItem {
  p: Pt;
  /** входящий рычаг (к предыдущему сегменту) */
  inH: Pt | null;
  /** исходящий рычаг (к следующему сегменту) */
  outH: Pt | null;
  smooth: boolean;
  /** здесь кривая разрезана (граница куска) */
  boundary: boolean;
  /** длина вдоль исходной кривой, мм */
  s: number;
}

/** Под-кривая [t0..t1] кубического Безье (контрольные точки). */
function subCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  const split = (q: [Pt, Pt, Pt, Pt], t: number): { left: [Pt, Pt, Pt, Pt]; right: [Pt, Pt, Pt, Pt] } => {
    const a1 = lerpPt(q[0], q[1], t);
    const a2 = lerpPt(q[1], q[2], t);
    const a3 = lerpPt(q[2], q[3], t);
    const b1 = lerpPt(a1, a2, t);
    const b2 = lerpPt(a2, a3, t);
    const c = lerpPt(b1, b2, t);
    return { left: [q[0], a1, b1, c], right: [c, b2, a3, q[3]] };
  };
  if (t0 <= 1e-12 && t1 >= 1 - 1e-12) return [p0, p1, p2, p3];
  const first = split([p0, p1, p2, p3], Math.max(1e-12, Math.min(1 - 1e-12, t1)));
  if (t0 <= 1e-12) return first.left;
  const u = Math.max(1e-12, Math.min(1 - 1e-12, t0 / Math.max(1e-9, t1)));
  return split(first.left, u).right;
}

/**
 * Точное деление сегмента Безье в точке t (де Кастельжо): возвращает узел слева
 * (с новым исходящим рычагом), новый узел и узел справа (с новым входящим рычагом).
 * Форма кривой при этом не меняется — в отличие от «средней точки» между узлами.
 */
export function splitSegmentAt(
  a: PathNode,
  b: PathNode,
  t: number
): { left: PathNode; mid: PathNode; right: PathNode } {
  const p0: Pt = { x: a.x, y: a.y };
  const p3: Pt = { x: b.x, y: b.y };
  if (!isCurved(a, b) || t <= 1e-9 || t >= 1 - 1e-9) {
    const mid: Pt = lerpPt(p0, p3, Math.max(0, Math.min(1, t)));
    return { left: { ...a }, mid: { x: mid.x, y: mid.y }, right: { ...b } };
  }
  const p1: Pt = { x: a.cp2x ?? a.x, y: a.cp2y ?? a.y };
  const p2: Pt = { x: b.cp1x ?? b.x, y: b.cp1y ?? b.y };
  const a1 = lerpPt(p0, p1, t);
  const a2 = lerpPt(p1, p2, t);
  const a3 = lerpPt(p2, p3, t);
  const b1 = lerpPt(a1, a2, t);
  const b2 = lerpPt(a2, a3, t);
  const c = lerpPt(b1, b2, t);
  const left: PathNode = { ...a };
  if (a.cp2x !== undefined || a.cp2y !== undefined) { left.cp2x = a1.x; left.cp2y = a1.y; }
  const right: PathNode = { ...b };
  if (b.cp1x !== undefined || b.cp1y !== undefined) { right.cp1x = a3.x; right.cp1y = a3.y; }
  const mid: PathNode = { x: c.x, y: c.y, cp1x: b1.x, cp1y: b1.y, cp2x: b2.x, cp2y: b2.y, smooth: true };
  return { left, mid, right };
}

/**
 * Цепочка точек кривой с рычагами и метками разрезов.
 * Кривые Безье делятся точно, поэтому геометрия кусков совпадает с исходной.
 */
function buildChain(shape: PathShape, cuts: Cut[]): ChainItem[] {
  const curve = samplePath(shape);
  const nodes = shape.nodes;
  const nCount = nodes.length;
  const closed = !!shape.closed && nCount > 1;
  const segCount = closed ? nCount : Math.max(0, nCount - 1);
  const bySeg = new Map<number, Cut[]>();
  for (const c of cuts) {
    if (c.t <= 0 || c.t >= 1) continue; // совпадает с узлом — отметим узел
    const list = bySeg.get(c.seg) ?? [];
    list.push(c);
    bySeg.set(c.seg, list);
  }
  for (const list of bySeg.values()) list.sort((a, b) => a.t - b.t);

  /** Узел тоже может быть разрезом (если точка пересечения попала точно в него). */
  const nodeCut = new Set<number>();
  for (const c of cuts) {
    if (c.t <= 0) nodeCut.add(c.seg % nCount);
    else if (c.t >= 1) nodeCut.add((c.seg + 1) % nCount);
  }

  const chain: ChainItem[] = [];
  const handle = (p: Pt, base: Pt): Pt | null => (near(p, base, 1e-9) ? null : { x: p.x, y: p.y });

  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nCount];
    const segCuts = bySeg.get(i) ?? [];
    const bounds = [0, ...segCuts.map((c) => c.t), 1];
    const p0: Pt = { x: a.x, y: a.y };
    const p1: Pt = { x: a.cp2x ?? a.x, y: a.cp2y ?? a.y };
    const p2: Pt = { x: b.cp1x ?? b.x, y: b.cp1y ?? b.y };
    const p3: Pt = { x: b.x, y: b.y };
    const curved = isCurved(a, b);
    const quads: [Pt, Pt, Pt, Pt][] = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const ta = bounds[k], tb = bounds[k + 1];
      if (curved) quads.push(subCubic(p0, p1, p2, p3, ta, tb));
      else {
        // прямой сегмент: под-отрезок считается линейно
        const A = lerpPt(p0, p3, ta);
        const B = lerpPt(p0, p3, tb);
        quads.push([A, A, B, B]);
      }
    }
    const sStart = curve.nodeS[i] ?? 0;
    const sEnd = curve.nodeS[i + 1] ?? sStart;

    if (i === 0) {
      chain.push({
        p: p0,
        inH: handle({ x: a.cp1x ?? a.x, y: a.cp1y ?? a.y }, p0),
        outH: handle(quads[0][1], p0),
        smooth: !!a.smooth,
        boundary: nodeCut.has(0),
        s: sStart,
      });
    } else {
      const prev = chain[chain.length - 1];
      prev.outH = handle(quads[0][1], prev.p);
    }

    for (let k = 0; k < quads.length; k++) {
      const q = quads[k];
      const isLast = k === quads.length - 1;
      const s = isLast
        ? sEnd
        : sStart + (sEnd - sStart) * bounds[k + 1];
      if (isLast) {
        if (closed && i === segCount - 1) break; // последний узел замкнутой кривой = первый
        chain.push({
          p: p3,
          inH: handle(q[2], p3),
          outH: handle({ x: b.cp2x ?? b.x, y: b.cp2y ?? b.y }, p3),
          smooth: !!b.smooth,
          boundary: nodeCut.has((i + 1) % nCount),
          s,
        });
      } else {
        const mid = q[3];
        const nextQuad = quads[k + 1];
        chain.push({
          p: mid,
          inH: handle(q[2], mid),
          outH: handle(nextQuad[1], mid),
          smooth: true,
          boundary: true,
          // настоящая длина дуги до разреза (не линейная интерполяция по t)
          s: segCuts[k]?.s ?? s,
        });
      }
    }
  }
  return chain;
}

function chainToNodes(run: ChainItem[], closed: boolean): PathNode[] {
  return run.map((it, idx) => {
    const first = idx === 0;
    const last = idx === run.length - 1;
    const inH = closed || !first ? it.inH : null;
    const outH = closed || !last ? it.outH : null;
    const node: PathNode = { x: it.p.x, y: it.p.y };
    if (inH) { node.cp1x = inH.x; node.cp1y = inH.y; }
    if (outH) { node.cp2x = outH.x; node.cp2y = outH.y; }
    if (inH && outH) node.smooth = it.smooth;
    return node;
  });
}

export interface CurvePiece {
  nodes: PathNode[];
  closed: boolean;
  /** диапазон длин вдоль исходной кривой, мм */
  from: number;
  to: number;
}

/** Деление кривой на куски по разрезам (точно по Безье). */
/** Попадает ли длина s (вдоль исходной кривой) внутрь куска. */
export function pieceContains(piece: CurvePiece, s: number, total: number, eps = CUT_EPS): boolean {
  const inside = (v: number) => v > piece.from + eps && v < piece.to - eps;
  if (inside(s)) return true;
  // кусок может проходить через точку замыкания замкнутого контура
  return total > 0 && inside(s + total);
}

/**
 * Деление кривой на куски по разрезам (точно по Безье).
 * Граничные узлы входят в оба соседних куска — геометрия не теряет continuity.
 */
export function splitPathAt(shape: PathShape, cuts: Cut[]): CurvePiece[] {
  const chain = buildChain(shape, cuts);
  if (chain.length < 2) return [];
  const closed = !!shape.closed && shape.nodes.length > 1;
  const total = samplePath(shape).length;
  const pieces: CurvePiece[] = [];

  const push = (run: ChainItem[], isClosed: boolean) => {
    if (run.length < 2) return;
    let len = 0;
    for (let i = 1; i < run.length; i++) {
      len += Math.hypot(run[i].p.x - run[i - 1].p.x, run[i].p.y - run[i - 1].p.y);
    }
    if (len < 1e-9) return; // вырожденный кусок
    pieces.push({
      nodes: chainToNodes(run, isClosed),
      closed: isClosed,
      from: run[0].s,
      to: isClosed ? run[0].s + total : run[run.length - 1].s,
    });
  };

  const marks: number[] = [];
  chain.forEach((it, i) => { if (it.boundary) marks.push(i); });

  if (!closed) {
    const boundsIdx = [-1, ...marks, chain.length - 1];
    for (let k = 0; k < boundsIdx.length - 1; k++) {
      const start = k === 0 ? 0 : boundsIdx[k];
      push(chain.slice(start, boundsIdx[k + 1] + 1), false);
    }
    return pieces;
  }

  if (!marks.length) {
    pieces.push({ nodes: chainToNodes(chain, true), closed: true, from: 0, to: total });
    return pieces;
  }

  // замкнутая кривая: раскручиваем кольцо от первого разреза
  const start = marks[0];
  const ring: ChainItem[] = [];
  for (let k = 0; k < chain.length; k++) ring.push(chain[(start + k) % chain.length]);
  ring.push({ ...ring[0], s: ring[0].s + total, boundary: true });
  const cutIdx = [0];
  ring.forEach((it, i) => { if (i > 0 && i < ring.length - 1 && it.boundary) cutIdx.push(i); });
  cutIdx.push(ring.length - 1);
  for (let k = 0; k < cutIdx.length - 1; k++) push(ring.slice(cutIdx[k], cutIdx[k + 1] + 1), false);
  return pieces;
}

// ---------------- работа с документом ----------------

/** Режим инструмента «Усечь кривую»: отрезать, дотянуть или просто разрезать. */
export type TrimMode = 'trim' | 'extend' | 'break';

export interface TrimOptions {
  /** Границы — только выделенные объекты (иначе все видимые). */
  boundaryIds?: Set<string>;
  /** Учитывать самопересечения кривой. */
  self?: boolean;
  /** Допуск попадания в кривую, мм. */
  tol?: number;
  /** Габарит стола (мм): контур листа тоже считается границей реза и добора. */
  sheet?: { w: number; h: number };
}

export interface TrimEdit {
  ok: boolean;
  message: string;
  /** id объектов, которые удаляются */
  remove: string[];
  /** объекты, которые добавляются вместо них */
  add: LaserShape[];
}

const noEdit = (message: string): TrimEdit => ({ ok: false, message, remove: [], add: [] });

/** Объект годится как граница реза: видимый, не заблокированный, не служебный. */
export function isBoundaryShape(s: LaserShape): boolean {
  if (s.hidden || s.locked) return false;
  if (s.kind === 'dim') return false;
  if (s.layer === 'guide') return false;
  return true;
}

/** Объект можно резать: кривая или примитив, который в неё превращается. */
export function trimmable(s: LaserShape): boolean {
  return isBoundaryShape(s) && s.kind !== 'text';
}

function toPath(shape: LaserShape): PathShape[] {
  if (shape.kind === 'path') return [shape];
  if (shape.kind === 'text' || shape.kind === 'dim') return [];
  return shapeToPath(shape);
}

/** Полилинии-границы: все объекты кроме цели (или только выделенные). */
function boundaryPolylines(shapes: LaserShape[], targetId: string, opts: TrimOptions): Pt[][] {
  const out: Pt[][] = [];
  for (const s of shapes) {
    if (s.id === targetId) continue;
    if (!isBoundaryShape(s)) continue;
    if (opts.boundaryIds && opts.boundaryIds.size && !opts.boundaryIds.has(s.id)) continue;
    for (const pl of shapeToPolylines(s)) if (pl.length >= 2) out.push(pl);
  }
  // Край стола — тоже граница: кривую можно усечь или дотянуть до листа.
  // При явном наборе границ («границы — выделенные») лист не подмешиваем.
  const sheet = opts.sheet;
  if (sheet && sheet.w > 0 && sheet.h > 0 && (!opts.boundaryIds || !opts.boundaryIds.size)) {
    out.push([
      { x: 0, y: 0 }, { x: sheet.w, y: 0 },
      { x: sheet.w, y: sheet.h }, { x: 0, y: sheet.h }, { x: 0, y: 0 },
    ]);
  }
  return out;
}

/** Контур с отверстиями → набор независимых замкнутых кривых. */
export function explodePath(shape: PathShape): PathShape[] {
  if (!shape.holes?.length) return [shape];
  const out: PathShape[] = [{ ...shape, holes: undefined }];
  shape.holes.forEach((h, i) => {
    if (h.length < 3) return;
    out.push({
      id: luid('hole'),
      kind: 'path',
      layer: shape.layer,
      name: `${shape.name} · отверстие ${i + 1}`,
      groupId: shape.groupId,
      nodes: h.map((n) => ({ ...n })),
      closed: true,
      filled: false,
    });
  });
  return out;
}

function pieceShape(base: LaserShape, piece: CurvePiece, index: number, total: number): PathShape {
  return {
    id: luid('trim'),
    kind: 'path',
    layer: base.layer,
    name: total > 1 ? `${base.name} · часть ${index + 1}` : `${base.name} (кривая)`,
    groupId: base.groupId,
    nodes: piece.nodes,
    closed: piece.closed,
    filled: piece.closed ? ('filled' in base ? base.filled : false) : false,
  };
}

/** Какая кривая объекта (или какой контур с отверстиями) ближе к точке. */
function pickTarget(shapes: LaserShape[], targetId: string, at: Pt, tol: number): {
  paths: PathShape[]; nearest: number; all: PathShape[];
} | null {
  const shape = shapes.find((s) => s.id === targetId);
  if (!shape) return null;
  const all = toPath(shape);
  if (!all.length) return null;
  const exploded = all.flatMap(explodePath);
  let nearest = -1;
  let bestD = Infinity;
  exploded.forEach((p, i) => {
    const c = samplePath(p);
    const hit = nearestOnSampled(c, at);
    if (hit && hit.dist < bestD) { bestD = hit.dist; nearest = i; }
  });
  if (nearest < 0 || bestD > Math.max(tol, 0.05)) return null;
  return { paths: exploded, nearest, all };
}

/** Какой кусок удалить: содержит длину s, а при клике ровно в разрезе — ближайший по середине. */
function pickPiece(pieces: CurvePiece[], s: number, total: number): number {
  const direct = pieces.findIndex((p) => pieceContains(p, s, total));
  if (direct >= 0) return direct;
  let best = -1;
  let bestD = Infinity;
  pieces.forEach((p, i) => {
    const span = p.to - p.from || total;
    const mid = p.from + span / 2;
    let d = Math.abs(mid - s);
    if (total > 0) d = Math.min(d, Math.abs(mid - total - s), Math.abs(mid + total - s));
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/**
 * Усечение: кривая режется по пересечениям с другими объектами,
 * кусок под курсором удаляется.
 */
export function trimCurve(shapes: LaserShape[], targetId: string, at: Pt, opts: TrimOptions = {}): TrimEdit {
  const shape = shapes.find((s) => s.id === targetId);
  if (!shape) return noEdit('Объект не найден.');
  if (!trimmable(shape)) return noEdit('Этот объект нельзя усекать (текст, размер или заблокированный слой).');
  const picked = pickTarget(shapes, targetId, at, opts.tol ?? 1.5);
  if (!picked) return noEdit('Клик мимо кривой.');

  const target = picked.paths[picked.nearest];
  const boundaries = boundaryPolylines(shapes, targetId, opts);
  if (!boundaries.length && opts.self === false) return noEdit('На листе больше нет кривых — усекать нечем.');
  const cuts = findCuts(target, boundaries, { self: opts.self });
  if (cuts.length < (target.closed ? 2 : 1)) {
    return noEdit(
      target.closed
        ? 'Замкнутый контур должен пересекать границу минимум в двух точках.'
        : 'Пересечений с другими кривыми нет — усекать нечем. Режим «Разрезать» режет кривую в точке клика.'
    );
  }

  const pieces = splitPathAt(target, cuts);
  if (pieces.length < 2) return noEdit('Не удалось разрезать кривую.');
  const curve = samplePath(target);
  const hit = nearestOnSampled(curve, at);
  if (!hit) return noEdit('Клик мимо кривой.');
  const total = curve.length || 1;
  const victim = pickPiece(pieces, hit.s, total);
  if (victim < 0) return noEdit('Не определён кусок для удаления.');

  const keep = pieces.filter((_, i) => i !== victim);
  const add: LaserShape[] = keep.map((p, i) => pieceShape(target, p, i, keep.length));
  // остальные контуры объекта (отверстия) сохраняются отдельными кривыми
  picked.paths.forEach((p, i) => { if (i !== picked.nearest) add.push(p); });

  return {
    ok: true,
    message: `Усечено: ${target.name} → ${keep.length} кусок(ов), удалён ${pieceLen(pieces[victim])} мм`,
    remove: [targetId],
    add,
  };
}

function pieceLen(piece: CurvePiece): string {
  return (piece.to - piece.from).toFixed(1);
}

/** Разрез кривой в точке клика (без пересечений с другими объектами). */
export function breakCurve(shapes: LaserShape[], targetId: string, at: Pt, opts: TrimOptions = {}): TrimEdit {
  const shape = shapes.find((s) => s.id === targetId);
  if (!shape) return noEdit('Объект не найден.');
  if (!trimmable(shape)) return noEdit('Этот объект нельзя разрезать.');
  const picked = pickTarget(shapes, targetId, at, opts.tol ?? 1.5);
  if (!picked) return noEdit('Клик мимо кривой.');
  const target = picked.paths[picked.nearest];
  const curve = samplePath(target);
  const hit = nearestOnSampled(curve, at);
  if (!hit) return noEdit('Клик мимо кривой.');
  const cut = cutAtSampled(curve, target.nodes, hit.index, hit.point);
  if (!cut) return noEdit('Кривая слишком короткая.');
  if (cut.t <= 1e-6 || cut.t >= 1 - 1e-6) {
    return noEdit('Точка клика совпадает с узлом — разрезать нечего (узлы правятся инструментом «Форма», F10).');
  }
  const pieces = splitPathAt(target, [cut]);
  if (!pieces.length) return noEdit('Не удалось разрезать кривую.');
  const add = pieces.map((p, i) => pieceShape(target, p, i, pieces.length));
  picked.paths.forEach((p, i) => { if (i !== picked.nearest) add.push(p); });
  return {
    ok: true,
    message: target.closed
      ? `Замкнутый контур разрезан в точке (${pieces.length} узел(ов) стало концами)`
      : `Кривая разрезана на ${pieces.length} части`,
    remove: [targetId],
    add,
  };
}

/** Продление конца кривой до ближайшей границы (по касательной). */
export function extendCurve(shapes: LaserShape[], targetId: string, at: Pt, opts: TrimOptions = {}): TrimEdit {
  const shape = shapes.find((s) => s.id === targetId);
  if (!shape) return noEdit('Объект не найден.');
  if (!trimmable(shape)) return noEdit('Этот объект нельзя продлить.');
  const picked = pickTarget(shapes, targetId, at, opts.tol ?? 2.5);
  if (!picked) return noEdit('Клик мимо кривой.');
  const target = picked.paths[picked.nearest];
  if (target.closed) return noEdit('Замкнутый контур продлевать некуда.');
  if (target.nodes.length < 2) return noEdit('Кривая из одного узла.');

  const nodes = target.nodes;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const dFirst = Math.hypot(first.x - at.x, first.y - at.y);
  const dLast = Math.hypot(last.x - at.x, last.y - at.y);
  const atStart = dFirst <= dLast;
  const end = atStart ? first : last;
  const prev = atStart ? nodes[1] : nodes[nodes.length - 2];
  const endHandle = atStart
    ? (end.cp1x !== undefined && end.cp1y !== undefined ? { x: end.cp1x, y: end.cp1y } : null)
    : (end.cp2x !== undefined && end.cp2y !== undefined ? { x: end.cp2x, y: end.cp2y } : null);
  const anchor = endHandle ?? { x: prev.x, y: prev.y };
  let dirX = end.x - anchor.x;
  let dirY = end.y - anchor.y;
  const dl = Math.hypot(dirX, dirY);
  if (dl < 1e-9) return noEdit('Не определена касательная на конце кривой.');
  dirX /= dl;
  dirY /= dl;

  const boundaries = boundaryPolylines(shapes, targetId, opts);
  if (!boundaries.length) return noEdit('На листе нет других кривых — продлевать не до чего.');
  const rayEnd = { x: end.x + dirX * EXTEND_MAX_MM, y: end.y + dirY * EXTEND_MAX_MM };
  let best: { p: Pt; d: number } | null = null;
  for (const pl of boundaries) {
    for (let i = 0; i < pl.length - 1; i++) {
      const p = segIntersect(end, rayEnd, pl[i], pl[i + 1], 0);
      if (!p) continue;
      const d = Math.hypot(p.x - end.x, p.y - end.y);
      if (d < 1e-4) continue;
      if (!best || d < best.d) best = { p, d };
    }
  }
  if (!best) return noEdit('Продлить не до чего: на пути конца кривой нет других объектов.');

  const grown = best.d;
  const k = endHandle && dl > 1e-9 ? (dl + grown) / dl : 1;
  const nextNodes = nodes.map((nd, i) => {
    const isEnd = atStart ? i === 0 : i === nodes.length - 1;
    if (!isEnd) return nd;
    const moved: PathNode = { ...nd, x: end.x + dirX * grown, y: end.y + dirY * grown };
    if (atStart) {
      if (nd.cp1x !== undefined && nd.cp1y !== undefined) {
        moved.cp1x = moved.x + (nd.cp1x - end.x) * k;
        moved.cp1y = moved.y + (nd.cp1y - end.y) * k;
      }
    } else if (nd.cp2x !== undefined && nd.cp2y !== undefined) {
      moved.cp2x = moved.x + (nd.cp2x - end.x) * k;
      moved.cp2y = moved.y + (nd.cp2y - end.y) * k;
    }
    return moved;
  });
  const updated: PathShape = { ...target, nodes: nextNodes };
  const add: LaserShape[] = [updated];
  picked.paths.forEach((p, i) => { if (i !== picked.nearest) add.push(p); });
  return {
    ok: true,
    message: `Кривая продлена на ${grown.toFixed(2)} мм до границы`,
    remove: [targetId],
    add,
  };
}

/** Разбить все указанные кривые по взаимным пересечениям (CAD «Split at intersections»). */
export function breakApartAtIntersections(
  shapes: LaserShape[],
  ids?: Set<string>,
  opts: TrimOptions = {}
): { shapes: LaserShape[]; added: number; split: number } {
  const list = shapes.filter((s) => trimmable(s) && (!ids || !ids.size || ids.has(s.id)));
  if (!list.length) return { shapes, added: 0, split: 0 };
  const replacements = new Map<string, LaserShape[]>();
  let added = 0;
  let split = 0;

  for (const target of list) {
    const paths = toPath(target).flatMap(explodePath);
    if (!paths.length) continue;
    const out: LaserShape[] = [];
    let touched = false;
    for (const path of paths) {
      const boundaries: Pt[][] = [];
      for (const other of shapes) {
        if (other.id === target.id) continue;
        if (!isBoundaryShape(other)) continue;
        if (opts.boundaryIds && opts.boundaryIds.size && !opts.boundaryIds.has(other.id) && !ids?.has(other.id)) continue;
        for (const pl of shapeToPolylines(other)) if (pl.length >= 2) boundaries.push(pl);
      }
      const cuts = findCuts(path, boundaries, { self: opts.self });
      if (!cuts.length) {
        if (path.id !== target.id) { out.push(path); touched = true; }
        else out.push(target);
        continue;
      }
      const pieces = splitPathAt(path, cuts);
      touched = true;
      split += 1;
      pieces.forEach((p, i) => {
        const ps = pieceShape(path, p, i, pieces.length);
        out.push(ps);
        added += 1;
      });
    }
    if (touched) replacements.set(target.id, out.length ? out : [target]);
  }

  if (!replacements.size) return { shapes, added: 0, split: 0 };
  const next = shapes.flatMap((s) => replacements.get(s.id) ?? [s]);
  return { shapes: next, added, split: replacements.size };
}

// ---------------- предпросмотр ----------------

export interface TrimPreview {
  /** Полилиния куска, который будет удалён / подсвечен. */
  pts: Pt[];
  mode: 'trim' | 'break' | 'extend';
  /** Для «продлить»: отрезок добора. */
  extra?: [Pt, Pt];
  /** Точки пересечений (маркеры на холсте). */
  cuts: Pt[];
  /** Подпись для статусной строки. */
  hint: string;
}

/** Что подсветить под курсором: кусок к удалению, место реза или добор. */
export function trimPreview(
  shapes: LaserShape[],
  targetId: string | null,
  at: Pt,
  mode: 'trim' | 'break' | 'extend',
  opts: TrimOptions = {}
): TrimPreview | null {
  if (!targetId) return null;
  const picked = pickTarget(shapes, targetId, at, opts.tol ?? (mode === 'extend' ? 2.5 : 1.5));
  if (!picked) return null;
  const target = picked.paths[picked.nearest];
  const curve = samplePath(target);
  const boundaries = boundaryPolylines(shapes, targetId, opts);

  if (mode === 'extend') {
    if (target.closed) return null;
    const nodes = target.nodes;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const atStart = Math.hypot(first.x - at.x, first.y - at.y) <= Math.hypot(last.x - at.x, last.y - at.y);
    const end = atStart ? first : last;
    const prev = atStart ? nodes[1] : nodes[nodes.length - 2];
    const handle = atStart
      ? (end.cp1x !== undefined && end.cp1y !== undefined ? { x: end.cp1x, y: end.cp1y } : null)
      : (end.cp2x !== undefined && end.cp2y !== undefined ? { x: end.cp2x, y: end.cp2y } : null);
    const anchor: Pt = handle ?? { x: prev.x, y: prev.y };
    const dl = Math.hypot(end.x - anchor.x, end.y - anchor.y);
    if (dl < 1e-9) return null;
    const dirX = (end.x - anchor.x) / dl, dirY = (end.y - anchor.y) / dl;
    const far = { x: end.x + dirX * EXTEND_MAX_MM, y: end.y + dirY * EXTEND_MAX_MM };
    let best: { p: Pt; d: number } | null = null;
    for (const pl of boundaries) {
      for (let i = 0; i < pl.length - 1; i++) {
        const p = segIntersect(end, far, pl[i], pl[i + 1], 0);
        if (!p) continue;
        const d = Math.hypot(p.x - end.x, p.y - end.y);
        if (d < 1e-4) continue;
        if (!best || d < best.d) best = { p, d };
      }
    }
    return {
      pts: curve.pts,
      mode,
      extra: [{ x: end.x, y: end.y }, best ? best.p : far],
      cuts: best ? [best.p] : [],
      hint: best ? `продлить на ${best.d.toFixed(2)} мм` : 'на пути нет границы',
    };
  }

  const cuts = findCuts(target, boundaries, { self: opts.self });
  if (mode === 'break') {
    const hit = nearestOnSampled(curve, at);
    if (!hit) return null;
    return {
      pts: curve.pts,
      mode,
      cuts: [hit.point],
      hint: target.closed ? 'разрезать замкнутый контур' : 'разрезать на две кривые',
    };
  }

  const need = target.closed ? 2 : 1;
  if (cuts.length < need) {
    return { pts: curve.pts, mode, cuts: cuts.map((c) => c.point), hint: 'нет пересечений — усекать нечем' };
  }
  const pieces = splitPathAt(target, cuts);
  const hit = nearestOnSampled(curve, at);
  if (!hit || pieces.length < 2) return null;
  const total = curve.length || 1;
  const victim = pickPiece(pieces, hit.s, total);
  if (victim < 0) return null;
  const piece = pieces[victim];
  const shape: PathShape = {
    id: 'preview', kind: 'path', layer: target.layer, name: 'preview',
    nodes: piece.nodes, closed: piece.closed, filled: false,
  };
  return {
    pts: shapeToPolylines(shape)[0] ?? [],
    mode,
    cuts: cuts.map((c) => c.point),
    hint: `удалить кусок ${(piece.to - piece.from).toFixed(1)} мм из ${pieces.length}`,
  };
}

/** Габарит кривой — для быстрой отсечки в предпросмотре. */
export function pathBBox(shape: PathShape): [number, number, number, number] {
  return shapeBBox(shape);
}
