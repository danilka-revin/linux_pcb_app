// Единая физическая форма подложки: замкнутые примитивы слоя «Контур платы».
// Размеры Doc — рабочее поле/запасной прямоугольник, а не замена нарисованного контура.
import * as Clipper from 'clipper-lib';
import { expandDoc } from './expand';
import { distToSeg, pointInPoly, type Doc, type Entity, type Pt } from './model';

const SCALE = 10000;
const key = (p: Pt) => `${Math.round(p.x * SCALE)},${Math.round(p.y * SCALE)}`;
const finite = (p: Pt) => Number.isFinite(p.x) && Number.isFinite(p.y);
export interface BoardRegion { outer: Pt[]; holes: Pt[][] }
export interface BoardShape {
  regions: BoardRegion[];
  loops: Pt[][];
  bounds: [number, number, number, number];
  fallback: boolean;
  /** Незамкнутые/неоднозначные цепочки не превращаются в случайные края платы. */
  openChains: number;
}

export function boardShape(doc: Doc, flat: Entity[] = expandDoc(doc.entities)): BoardShape {
  const loops: Pt[][] = [];
  const edges: [Pt, Pt][] = [];
  for (const e of flat) {
    if (!('layer' in e) || e.layer !== 'outline') continue;
    if (e.kind === 'rect' && e.w && e.h) {
      loops.push([{ x: e.x, y: e.y }, { x: e.x + e.w, y: e.y },
        { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h }]);
    } else if (e.kind === 'circle' && e.r > 0 && Number.isFinite(e.r)) {
      // Стрела аппроксимации ≤ 0.005 мм (с ограничением для огромных импортов).
      const n = Math.max(32, Math.min(2048, 4 * Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.005 / e.r)) / 4)));
      loops.push(Array.from({ length: n }, (_, i) => ({
        x: e.x + e.r * Math.cos(i * 2 * Math.PI / n), y: e.y + e.r * Math.sin(i * 2 * Math.PI / n),
      })));
    } else if (e.kind === 'line') {
      const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
      if (finite(a) && finite(b) && key(a) !== key(b)) edges.push([a, b]);
    }
  }
  // Направление и порядок рисования линий не имеют значения. В каждой вершине
  // замкнутой цепочки ровно два ребра; развилки и незаконченные цепочки игнорируем.
  const adjacent = new Map<string, number[]>();
  edges.forEach((edge, i) => edge.forEach(p => {
    const k = key(p); adjacent.set(k, [...(adjacent.get(k) || []), i]);
  }));
  const seen = new Set<number>();
  let openChains = 0;
  edges.forEach((_, start) => {
    if (seen.has(start)) return;
    const component: number[] = [], pending = [start];
    while (pending.length) {
      const i = pending.pop()!;
      if (seen.has(i)) continue;
      seen.add(i); component.push(i);
      for (const p of edges[i]) for (const j of adjacent.get(key(p))!) if (!seen.has(j)) pending.push(j);
    }
    if (component.some(i => edges[i].some(p => adjacent.get(key(p))!.length !== 2))) { openChains++; return; }
    const pts: Pt[] = [];
    let edge = start, p = edges[start][0];
    do {
      pts.push(p);
      const [a, b] = edges[edge];
      p = key(a) === key(p) ? b : a;
      edge = adjacent.get(key(p))!.find(i => i !== edge)!;
    } while (edge !== start && pts.length <= component.length);
    if (pts.length >= 3) loops.push(pts); else openChains++;
  });

  // Even-odd: вложенный контур — вырез, контур внутри выреза — отдельный остров.
  const paths = loops.filter(p => p.every(finite)).map(p => p.map(v => ({ X: Math.round(v.x * SCALE), Y: Math.round(v.y * SCALE) })));
  const clipper = new Clipper.Clipper();
  clipper.AddPaths(paths, Clipper.PolyType.ptSubject, true);
  const tree = new Clipper.PolyTree();
  clipper.Execute(Clipper.ClipType.ctUnion, tree, Clipper.PolyFillType.pftEvenOdd, Clipper.PolyFillType.pftEvenOdd);
  const regions: BoardRegion[] = [];
  const points = (n: Clipper.PolyNode) => n.Contour().map(p => ({ x: p.X / SCALE, y: p.Y / SCALE }));
  const visit = (node: Clipper.PolyNode) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) regions.push({ outer: points(child), holes: child.Childs().map(points) });
      visit(child);
    }
  };
  visit(tree);
  const fallback = !regions.length;
  if (fallback) regions.push({ outer: [{ x: 0, y: 0 }, { x: doc.w, y: 0 }, { x: doc.w, y: doc.h }, { x: 0, y: doc.h }], holes: [] });
  const boundaries = regions.flatMap(r => [r.outer, ...r.holes]);
  const bounds: BoardShape['bounds'] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const loop of boundaries) for (const p of loop) {
    bounds[0] = Math.min(bounds[0], p.x); bounds[1] = Math.min(bounds[1], p.y);
    bounds[2] = Math.max(bounds[2], p.x); bounds[3] = Math.max(bounds[3], p.y);
  }
  return { regions, loops: boundaries, bounds, fallback, openChains };
}

/** Внутри материала и не ближе margin к любому краю (включая вырезы). */
export function insideBoard(shape: BoardShape, p: Pt, margin = 0): boolean {
  if (!shape.regions.some(r => pointInPoly(r.outer, p.x, p.y) && !r.holes.some(h => pointInPoly(h, p.x, p.y)))) return false;
  return margin <= 0 || shape.loops.every(loop => loop.every((a, i) => {
    const b = loop[(i + 1) % loop.length];
    return distToSeg(p.x, p.y, a.x, a.y, b.x, b.y) >= margin;
  }));
}

export function boardPath(ctx: CanvasRenderingContext2D, shape: BoardShape, map: (p: Pt) => Pt): void {
  ctx.beginPath();
  for (const loop of shape.loops) {
    loop.forEach((p, i) => { const q = map(p); if (i) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); });
    ctx.closePath();
  }
}
