// Привязка к объектам платы: пересечения отрезков и «умные» направляющие
// при перетаскивании (выравнивание краёв и центров с соседями).

import { entBBox, type Entity, type Pt } from './model';
import { refPoints } from './grid';

export type SnapKind = 'end' | 'mid' | 'center' | 'corner' | 'cross';

export interface SnapPoint extends Pt {
  kind: SnapKind;
}

/** Ближайшая точка привязки с её типом (для маркера на холсте). */
export function nearestSnap(
  pts: readonly SnapPoint[] | null | undefined,
  p: Pt,
  tol: number,
): SnapPoint | null {
  if (!pts || !pts.length || !(tol > 0)) return null;
  let best: SnapPoint | null = null;
  let bestD2 = tol * tol;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i];
    const dx = q.x - p.x, dy = q.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) { bestD2 = d2; best = q; }
  }
  return best;
}

/** Характерные точки с подписью типа — для маркера привязки. */
export function collectSnapTagged(ents: Entity[], withCrossings = true): SnapPoint[] {
  const out: SnapPoint[] = [];
  for (const e of ents) {
    const pts = refPoints(e);
    for (let i = 0; i < pts.length; i++) {
      out.push({ x: pts[i].x, y: pts[i].y, kind: kindOf(e, i, pts.length) });
    }
  }
  if (withCrossings) {
    for (const p of collectIntersections(ents)) out.push({ x: p.x, y: p.y, kind: 'cross' });
  }
  return out;
}

function kindOf(e: Entity, idx: number, total: number): SnapKind {
  switch (e.kind) {
    case 'pad': case 'via': case 'hole': case 'comp': case 'text':
      return 'center';
    case 'smd':
      return idx === 0 ? 'center' : 'corner';
    case 'circle':
      return idx === 0 ? 'center' : 'corner';
    case 'rect':
      return idx === total - 1 ? 'center' : 'corner';
    case 'track': case 'poly': case 'line':
      return idx % 2 === 0 ? 'end' : 'mid';
    default:
      return 'end';
  }
}

/** Отрезки «графики» документа: дорожки, линии, стороны прямоугольников и колец полигонов. */
function collectSegs(ents: Entity[]): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];
  for (const e of ents) {
    switch (e.kind) {
      case 'track':
        for (let i = 0; i < e.pts.length - 1; i++)
          segs.push([e.pts[i].x, e.pts[i].y, e.pts[i + 1].x, e.pts[i + 1].y]);
        break;
      case 'poly': {
        const rings = [e.pts, ...(e.holes ?? [])];
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const a = ring[i], b = ring[(i + 1) % ring.length];
            segs.push([a.x, a.y, b.x, b.y]);
          }
        }
        break;
      }
      case 'line':
        segs.push([e.x1, e.y1, e.x2, e.y2]);
        break;
      case 'rect':
        segs.push(
          [e.x, e.y, e.x + e.w, e.y], [e.x + e.w, e.y, e.x + e.w, e.y + e.h],
          [e.x + e.w, e.y + e.h, e.x, e.y + e.h], [e.x, e.y + e.h, e.x, e.y],
        );
        break;
      default:
        break;
    }
  }
  return segs;
}

const EPS = 1e-9;

function segCross(a: [number, number, number, number], b: [number, number, number, number]): Pt | null {
  const r1x = a[2] - a[0], r1y = a[3] - a[1];
  const r2x = b[2] - b[0], r2y = b[3] - b[1];
  const den = r1x * r2y - r1y * r2x;
  if (Math.abs(den) < EPS) return null;
  const t = ((b[0] - a[0]) * r2y - (b[1] - a[1]) * r2x) / den;
  const u = ((b[0] - a[0]) * r1y - (b[1] - a[1]) * r1x) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a[0] + t * r1x, y: a[1] + t * r1y };
}

/**
 * Точки пересечения отрезков (развилки дорожек, кресты линий). Строится один раз
 * на изменение платы; при очень сложной геометрии возвращает пустой список —
 * привязка к концам/серединам продолжает работать.
 */
export function collectIntersections(ents: Entity[], maxSegs = 2500, maxPoints = 4000): Pt[] {
  const segs = collectSegs(ents);
  if (segs.length < 2 || segs.length > maxSegs) return [];
  const out: Pt[] = [];
  for (let i = 0; i < segs.length && out.length < maxPoints; i++) {
    const a = segs[i];
    for (let j = i + 1; j < segs.length && out.length < maxPoints; j++) {
      const b = segs[j];
      // быстрый отсев по габаритам
      if (Math.min(a[0], a[2]) > Math.max(b[0], b[2]) + EPS) continue;
      if (Math.min(b[0], b[2]) > Math.max(a[0], a[2]) + EPS) continue;
      if (Math.min(a[1], a[3]) > Math.max(b[1], b[3]) + EPS) continue;
      if (Math.min(b[1], b[3]) > Math.max(a[1], a[3]) + EPS) continue;
      const p = segCross(a, b);
      if (!p) continue;
      // общая вершина соседних сегментов — она уже есть в характерных точках
      const shared =
        (Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS) || (Math.hypot(a[0] - b[2], a[1] - b[3]) < EPS) ||
        (Math.hypot(a[2] - b[0], a[3] - b[1]) < EPS) || (Math.hypot(a[2] - b[2], a[3] - b[3]) < EPS);
      if (shared) continue;
      let dup = false;
      for (const q of out) {
        if (Math.abs(q.x - p.x) < 1e-4 && Math.abs(q.y - p.y) < 1e-4) { dup = true; break; }
      }
      if (!dup) out.push(p);
    }
  }
  return out;
}

// --------------------------------------------------------------- направляющие

export interface AlignGuide {
  axis: 'x' | 'y';
  /** координата направляющей (x для вертикальных линий, y для горизонтальных) */
  at: number;
  /** экранный диапазон вдоль оси — от края выделения до направляющей */
  from: number;
  to: number;
}

export interface AlignSnap {
  dx: number;
  dy: number;
  guides: AlignGuide[];
}

/**
 * Выравнивание перетаскиваемого габарита с точками соседей: если край или центр
 * выделения почти совпадает по X/Y с чьим-то краем/центром — сдвигаем точно
 * и возвращаем направляющие для отрисовки. tol — допуск, мм.
 */
export function alignSnap(
  box: [number, number, number, number],
  dx: number,
  dy: number,
  statics: readonly Pt[],
  tol: number,
): AlignSnap {
  if (!(tol > 0) || !statics.length) return { dx, dy, guides: [] };
  const fx = [box[0] + dx, (box[0] + box[2]) / 2 + dx, box[2] + dx];
  const fy = [box[1] + dy, (box[1] + box[3]) / 2 + dy, box[3] + dy];
  const guides: AlignGuide[] = [];

  const snapAxis = (
    features: number[], axis: 'x' | 'y', delta: number,
  ): number => {
    let best = delta, bestDist = tol + 1e-9, found = false;
    for (const s of statics) {
      const cand = axis === 'x' ? s.x : s.y;
      for (const f of features) {
        const dist = Math.abs(f - cand);
        if (dist <= tol) {
          if (!found || dist < bestDist) {
            bestDist = dist;
            // f уже включает delta — сдвигаем так, чтобы f совпало с cand
            best = delta + (cand - f);
            found = true;
          }
          if (guides.length < 6) {
            guides.push({ axis, at: cand, from: f, to: cand });
          }
        }
      }
    }
    return found ? best : delta;
  };

  const ndx = snapAxis(fx, 'x', dx);
  const ndy = snapAxis(fy, 'y', dy);
  return { dx: ndx, dy: ndy, guides };
}

/** Габарит выделенных примитивов (сгруппированных по id) или null. */
export function selBBox(ents: Entity[], sel: ReadonlySet<string>): [number, number, number, number] | null {
  let box: [number, number, number, number] | null = null;
  for (const e of ents) {
    if (!sel.has(e.id)) continue;
    const b = entBBox(e);
    box = box
      ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
      : [b[0], b[1], b[2], b[3]];
  }
  return box;
}
