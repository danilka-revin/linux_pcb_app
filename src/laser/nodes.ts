// Инструмент «Форма» (Shape Tool, F10) — чистая логика правки узлов кривой:
// поиск ближайшего узла/сегмента, добавление и удаление узлов, гладкость (Bézier).

import {
  distToSegment, shapeBBox, shapeToPath,
  type LaserShape, type PathNode, type PathShape, type Pt,
} from './model';
import { cutAtSampled, nearestOnSampled, samplePath, splitSegmentAt } from './trim';

/**
 * Расстояние от точки до кривой — по настоящей кривой Безье (аппроксимация),
 * а не по хордам между узлами: у дуги хорда уходит в сторону на миллиметры,
 * и узлы с резом вставали не туда, куда кликнули.
 */
export function nearestOnCurve(
  shape: PathShape,
  p: Pt
): { dist: number; seg: number; t: number; point: Pt; s: number } | null {
  const nodes = shape.nodes;
  if (nodes.length < 2) return null;
  const curve = samplePath(shape);
  const hit = nearestOnSampled(curve, p);
  if (!hit) return null;
  const cut = cutAtSampled(curve, nodes, hit.index, hit.point);
  return {
    dist: hit.dist,
    seg: cut ? cut.seg : 0,
    t: cut ? cut.t : 0,
    point: hit.point,
    s: hit.s,
  };
}

/** Индекс ближайшего узла в пределах допуска (мм); -1 если ничего нет. */
export function nearestNodeIndex(shape: PathShape, p: Pt, tolMm: number): number {
  let idx = -1;
  let best = tolMm;
  shape.nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= best) {
      best = d;
      idx = i;
    }
  });
  return idx;
}

/** Индекс ближайшего рычага Безье ('cp1' | 'cp2') у узла idx; null если рычагов нет. */
export function nearestHandle(
  shape: PathShape,
  idx: number,
  p: Pt,
  tolMm: number
): 'cp1' | 'cp2' | null {
  const n = shape.nodes[idx];
  if (!n) return null;
  if (n.cp1x !== undefined && n.cp1y !== undefined && Math.hypot(n.cp1x - p.x, n.cp1y - p.y) <= tolMm) return 'cp1';
  if (n.cp2x !== undefined && n.cp2y !== undefined && Math.hypot(n.cp2x - p.x, n.cp2y - p.y) <= tolMm) return 'cp2';
  return null;
}

/** Перемещение узла вместе с его рычагами (форма кривой сохраняется). */
export function moveNode(shape: PathShape, idx: number, to: Pt): PathShape {
  const nodes = shape.nodes.map((n, i) => {
    if (i !== idx) return n;
    const dx = to.x - n.x;
    const dy = to.y - n.y;
    return {
      ...n,
      x: to.x,
      y: to.y,
      cp1x: n.cp1x !== undefined ? n.cp1x + dx : undefined,
      cp1y: n.cp1y !== undefined ? n.cp1y + dy : undefined,
      cp2x: n.cp2x !== undefined ? n.cp2x + dx : undefined,
      cp2y: n.cp2y !== undefined ? n.cp2y + dy : undefined,
    };
  });
  return { ...shape, nodes };
}

/** Перемещение рычага Безье. При гладком узле второй рычаг остаётся коллинеарным. */
export function moveHandle(shape: PathShape, idx: number, which: 'cp1' | 'cp2', to: Pt): PathShape {
  const nodes = shape.nodes.slice();
  const n = { ...nodes[idx] };
  if (which === 'cp2') {
    n.cp2x = to.x;
    n.cp2y = to.y;
    if (n.smooth) {
      // второй рычаг остаётся коллинеарным и сохраняет свою длину
      const len = Math.hypot((n.cp1x ?? n.x) - n.x, (n.cp1y ?? n.y) - n.y);
      const dx = to.x - n.x;
      const dy = to.y - n.y;
      const l = Math.hypot(dx, dy) || 1;
      n.cp1x = n.x - (dx / l) * len;
      n.cp1y = n.y - (dy / l) * len;
    }
    // у углового узла cp1 не трогаем: иначе «нет рычага» превращается в нулевой рычаг
  } else {
    n.cp1x = to.x;
    n.cp1y = to.y;
    if (n.smooth) {
      const len = Math.hypot((n.cp2x ?? n.x) - n.x, (n.cp2y ?? n.y) - n.y);
      const dx = to.x - n.x;
      const dy = to.y - n.y;
      const l = Math.hypot(dx, dy) || 1;
      n.cp2x = n.x - (dx / l) * len;
      n.cp2y = n.y - (dy / l) * len;
    }
  }
  nodes[idx] = n;
  return { ...shape, nodes };
}

/** Переключение узла «гладкий / угловой» (CorelDRAW: Smooth / Cusp). */
export function toggleSmooth(shape: PathShape, idx: number): PathShape {
  const nodes = shape.nodes.slice();
  const n = nodes[idx];
  if (!n) return shape;
  if (n.smooth) {
    // угловой узел: рычаги снимаются, чтобы переключение было обратимым —
    // «гладкий → угловой» возвращает исходную ломаную, а не оставляет бугор
    nodes[idx] = { x: n.x, y: n.y, smooth: false };
    return { ...shape, nodes };
  }
  const hasPrev = shape.closed || idx > 0;
  const hasNext = shape.closed || idx < nodes.length - 1;
  const prev = hasPrev ? nodes[(idx - 1 + nodes.length) % nodes.length] : { x: n.x - 1, y: n.y };
  const next = hasNext ? nodes[(idx + 1) % nodes.length] : { x: n.x + 1, y: n.y };
  const d1 = Math.hypot(n.x - prev.x, n.y - prev.y) / 3;
  const d2 = Math.hypot(next.x - n.x, next.y - n.y) / 3;
  let ux = next.x - prev.x;
  let uy = next.y - prev.y;
  const l = Math.hypot(ux, uy) || 1;
  ux /= l;
  uy /= l;
  nodes[idx] = {
    x: n.x,
    y: n.y,
    smooth: true,
    cp1x: n.x - ux * d1,
    cp1y: n.y - uy * d1,
    cp2x: n.x + ux * d2,
    cp2y: n.y + uy * d2,
  };
  return { ...shape, nodes };
}

/**
 * Добавление узла на ближайший сегмент (двойной клик по кривой).
 * Сегмент Безье делится точно (де Кастельжо) — форма кривой не меняется.
 */
export function insertNode(shape: PathShape, p: Pt): { shape: PathShape; index: number } | null {
  const hit = nearestOnCurve(shape, p);
  if (!hit) return null;
  const seg = hit.seg;
  const nodes = shape.nodes;
  const a = nodes[seg];
  const bIdx = (seg + 1) % nodes.length;
  const b = nodes[bIdx];
  if (!a || !b) return null;
  if (!shape.closed && seg >= nodes.length - 1) return null;
  const { left, mid, right } = splitSegmentAt(a, b, hit.t);
  const next = nodes.slice();
  next[seg] = left;
  next[bIdx] = right;
  next.splice(seg + 1, 0, mid);
  return { shape: { ...shape, nodes: next }, index: seg + 1 };
}

/**
 * Удаление узла (двойной клик по узлу или Delete).
 * У открытого пути крайние рычаги смотрят «наружу» и не участвуют ни в одном
 * сегменте: после удаления крайнего узла их надо снять, иначе они рисуются
 * и тянутся мышью, но форму кривой не меняют.
 */
export function deleteNode(shape: PathShape, idx: number): PathShape | null {
  const min = shape.closed ? 3 : 2;
  if (shape.nodes.length <= min) return null;
  const nodes = shape.nodes.slice();
  nodes.splice(idx, 1);
  if (!shape.closed && nodes.length > 1) {
    const first = { ...nodes[0] };
    if (first.cp1x !== undefined || first.cp1y !== undefined) {
      first.cp1x = undefined;
      first.cp1y = undefined;
      nodes[0] = first;
    }
    const last = { ...nodes[nodes.length - 1] };
    if (last.cp2x !== undefined || last.cp2y !== undefined) {
      last.cp2x = undefined;
      last.cp2y = undefined;
      nodes[nodes.length - 1] = last;
    }
  }
  return { ...shape, nodes };
}

/** Ограничение угла отрезка шагом 15° (Shift при рисовании линии/пера). */
export function constrainAngle(from: Pt, to: Pt, stepDeg = 15): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { ...to };
  const ang = Math.atan2(dy, dx);
  const step = (stepDeg * Math.PI) / 180;
  const snapped = Math.round(ang / step) * step;
  return { x: from.x + Math.cos(snapped) * len, y: from.y + Math.sin(snapped) * len };
}

/**
 * Точки привязки к объектам: узлы кривых, вершины и середины прямых рёбер
 * примитивов, четверти окружностей и центры габаритов.
 * Примитивы (прямоугольник, эллипс, многоугольник) сначала превращаются в узлы —
 * иначе привязка к ним не работала вовсе: у них нет поля nodes.
 */
export function objectSnapPoints(shapes: LaserShape[], extra: Pt[] = []): Pt[] {
  const out: Pt[] = [...extra];
  const MAX = 20000;
  for (const s of shapes) {
    if (out.length > MAX) return out;
    if (s.kind === 'text') continue;
    if (s.kind === 'dim') {
      out.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      continue;
    }
    if (s.kind === 'path') {
      for (const n of s.nodes) out.push({ x: n.x, y: n.y });
      for (const hole of s.holes ?? []) for (const n of hole) out.push({ x: n.x, y: n.y });
    } else {
      for (const p of shapeToPath(s)) {
        const n = p.nodes;
        for (let i = 0; i < n.length; i++) {
          out.push({ x: n[i].x, y: n[i].y });
          if (i + 1 >= n.length && !p.closed) continue;
          const a = n[i];
          const b = n[(i + 1) % n.length];
          // середина — только у прямого ребра: у дуги хорда уходит внутрь
          const straight = a.cp2x === undefined && a.cp2y === undefined
            && b.cp1x === undefined && b.cp1y === undefined;
          if (straight) out.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
        }
      }
      if (s.kind === 'ellipse') out.push({ x: s.cx, y: s.cy });
    }
    const bb = shapeBBox(s);
    out.push({ x: (bb[0] + bb[2]) / 2, y: (bb[1] + bb[3]) / 2 });
  }
  return out;
}

/** Ближайшая точка привязки в пределах допуска (мм). */
export function nearestSnapPoint(points: Pt[], p: Pt, tolMm: number): Pt | null {
  let best: Pt | null = null;
  let bestD = tolMm;
  for (const q of points) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

/** Расстояние от точки до ближайшего сегмента кривой (для «клик по контуру»). */
export function distanceToShape(shape: PathShape, p: Pt): number {
  const hit = nearestOnCurve(shape, p);
  if (hit) return hit.dist;
  const nodes = shape.nodes;
  if (!nodes.length) return Infinity;
  let d = Infinity;
  for (let i = 0; i < nodes.length - 1; i++) {
    d = Math.min(d, distToSegment(p, nodes[i], nodes[i + 1]));
  }
  return d;
}
