// Инструмент «Форма» (Shape Tool, F10) — чистая логика правки узлов кривой:
// поиск ближайшего узла/сегмента, добавление и удаление узлов, гладкость (Bézier).

import { distToSegment, type PathNode, type PathShape, type Pt } from './model';

/** Расстояние от точки до кривой (по полилинии узлов) с индексом ближайшего сегмента. */
export function nearestOnCurve(
  shape: PathShape,
  p: Pt
): { dist: number; seg: number; t: number; point: Pt } | null {
  const nodes = shape.nodes;
  if (nodes.length < 2) return null;
  const segCount = shape.closed ? nodes.length : nodes.length - 1;
  let best = { dist: Infinity, seg: -1, t: 0, point: { x: 0, y: 0 } as Pt };
  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { dist: d, seg: i, t, point: q };
  }
  return best.seg < 0 ? null : best;
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
      const len = Math.hypot((n.cp1x ?? n.x) - n.x, (n.cp1y ?? n.y) - n.y);
      const dx = to.x - n.x;
      const dy = to.y - n.y;
      const l = Math.hypot(dx, dy) || 1;
      n.cp1x = n.x - (dx / l) * len;
      n.cp1y = n.y - (dy / l) * len;
    } else {
      n.cp1x = n.cp1x ?? n.x;
      n.cp1y = n.cp1y ?? n.y;
    }
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
    } else {
      n.cp2x = n.cp2x ?? n.x;
      n.cp2y = n.cp2y ?? n.y;
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

/** Добавление узла на ближайший сегмент (двойной клик по кривой). */
export function insertNode(shape: PathShape, p: Pt): { shape: PathShape; index: number } | null {
  const hit = nearestOnCurve(shape, p);
  if (!hit) return null;
  const idx = hit.seg + 1;
  const a = shape.nodes[hit.seg];
  const b = shape.nodes[(hit.seg + 1) % shape.nodes.length];
  const node: PathNode = { x: hit.point.x, y: hit.point.y };
  // если сегмент был кривым — сохраняем форму, деля рычаги пропорционально
  const hasCurve =
    (a.cp2x !== undefined && a.cp2y !== undefined) || (b.cp1x !== undefined && b.cp1y !== undefined);
  if (hasCurve) {
    const ax = a.cp2x ?? a.x, ay = a.cp2y ?? a.y;
    const bx = b.cp1x ?? b.x, by = b.cp1y ?? b.y;
    const t = hit.t;
    node.cp1x = ax + (bx - ax) * t;
    node.cp1y = ay + (by - ay) * t;
    node.cp2x = ax + (bx - ax) * t;
    node.cp2y = ay + (by - ay) * t;
    node.smooth = true;
  }
  const nodes = shape.nodes.slice();
  nodes.splice(idx, 0, node);
  return { shape: { ...shape, nodes }, index: idx };
}

/** Удаление узла (двойной клик по узлу или Delete). */
export function deleteNode(shape: PathShape, idx: number): PathShape | null {
  const min = shape.closed ? 3 : 2;
  if (shape.nodes.length <= min) return null;
  const nodes = shape.nodes.slice();
  nodes.splice(idx, 1);
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

/** Точка привязки к объектам: узлы, центры габаритов и середины сегментов. */
export function objectSnapPoints(shapes: { nodes?: PathNode[] }[], extra: Pt[] = []): Pt[] {
  const out: Pt[] = [...extra];
  for (const s of shapes) {
    for (const n of s.nodes ?? []) out.push({ x: n.x, y: n.y });
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
