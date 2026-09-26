// Геометрия подложки для 3D: сквозные отверстия сверловки с металлизированными стенками.
import * as THREE from 'three';
import type { Doc, Entity } from '../pcb/model';
import { zOrdered } from '../pcb/render';

/** Отверстие сверловки в мировых координатах платы, мм. */
export interface BoardHole {
  x: number;
  y: number;
  r: number;
  /** Металлизированное (площадка/переходное) или голое (крепёжное, noPlate). */
  plated: boolean;
}

/** Порядок групп материалов в геометрии платы. */
export const BOARD_GROUP = { top: 0, bottom: 1, edge: 2, plated: 3 } as const;

/** Минимальная перемычка между отверстиями и до края платы. */
const GAP = 0.05;
/** Лист разбиения: earcut квадратичен по числу отверстий, держим его маленьким. */
const LEAF_HOLES = 24;

/**
 * Все отверстия (площадки, переходные, монтажные, в т.ч. из компонентов).
 * Пересекающиеся и вылезающие за край пропускаются: они остаются на текстуре,
 * а сетка платы гарантированно корректна.
 */
export function collectBoardHoles(doc: Doc, flat: Entity[] = zOrdered(doc)): BoardHole[] {
  const candidates: BoardHole[] = [];
  for (const e of flat) {
    let d = 0, plated = false;
    if (e.kind === 'hole') d = e.d;
    else if (e.kind === 'via') { d = e.drill; plated = true; }
    else if (e.kind === 'pad') { d = e.drill; plated = !e.noPlate; }
    else continue;
    if (!(d > 0) || !Number.isFinite(d) || !Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    candidates.push({ x: e.x, y: e.y, r: d / 2, plated });
  }
  // Крупные первыми: совпавшее переходное внутри площадки не порвёт сетку.
  candidates.sort((a, b) => b.r - a.r || Number(b.plated) - Number(a.plated));
  const maxR = candidates.length ? candidates[0].r : 0;
  const cell = Math.max(0.5, 2 * maxR + GAP);
  const grid = new Map<string, BoardHole[]>();
  const accepted: BoardHole[] = [];
  for (const h of candidates) {
    if (h.x - h.r < GAP || h.y - h.r < GAP || h.x + h.r > doc.w - GAP || h.y + h.r > doc.h - GAP) continue;
    const gx = Math.floor(h.x / cell), gy = Math.floor(h.y / cell);
    let clash = false;
    for (let ix = gx - 1; ix <= gx + 1 && !clash; ix++) for (let iy = gy - 1; iy <= gy + 1 && !clash; iy++) {
      for (const o of grid.get(`${ix},${iy}`) || []) {
        if (Math.hypot(o.x - h.x, o.y - h.y) < o.r + h.r + GAP) {
          // Совпавшие отверстия: металлизация любого из них делает стенку медной.
          if (h.plated && Math.hypot(o.x - h.x, o.y - h.y) < 1e-6) o.plated = true;
          clash = true; break;
        }
      }
    }
    if (clash) continue;
    const key = `${gx},${gy}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(h); else grid.set(key, [h]);
    accepted.push(h);
  }
  return accepted;
}

/** Число граней окружности: ~0.2 мм на грань, но не угловато на мелких. */
export function holeSegments(r: number): number {
  return Math.max(16, Math.min(40, Math.round(2 * Math.PI * r / 0.2)));
}

interface HolePoly { hole: BoardHole; pts: THREE.Vector2[]; R: number }
interface Region { x0: number; y0: number; x1: number; y1: number; holes: HolePoly[] }

/** Описанный многоугольник: грани не заходят внутрь нарисованного на текстуре круга. */
function holePolygon(hole: BoardHole): HolePoly {
  const n = holeSegments(hole.r);
  const R = hole.r / Math.cos(Math.PI / n);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector2(hole.x + R * Math.cos(a), hole.y + R * Math.sin(a)));
  }
  return { hole, pts, R };
}

/** Гильотинное разбиение по свободным от отверстий полосам. */
function partition(region: Region, out: Region[]): void {
  if (region.holes.length <= LEAF_HOLES) { out.push(region); return; }
  let best: { axis: 'x' | 'y'; cut: number; score: number } | null = null;
  for (const axis of ['x', 'y'] as const) {
    const lo = axis === 'x' ? region.x0 : region.y0, hi = axis === 'x' ? region.x1 : region.y1;
    const spans = region.holes.map(p => {
      const c = axis === 'x' ? p.hole.x : p.hole.y;
      return [c - p.R, c + p.R] as const;
    }).sort((a, b) => a[0] - b[0]);
    let reach = -Infinity, before = 0;
    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (i > 0 && a - reach > GAP) {
        const cut = (a + reach) / 2;
        if (cut > lo && cut < hi) {
          const score = Math.max(before, spans.length - before);
          if (!best || score < best.score) best = { axis, cut, score };
        }
      }
      reach = Math.max(reach, b);
      before = i + 1;
    }
  }
  if (!best) { out.push(region); return; }
  const { axis, cut } = best;
  const key = axis === 'x' ? 'x' : 'y';
  const a: Region = { ...region, holes: region.holes.filter(p => p.hole[key] < cut) };
  const b: Region = { ...region, holes: region.holes.filter(p => p.hole[key] >= cut) };
  if (axis === 'x') { a.x1 = cut; b.x0 = cut; } else { a.y1 = cut; b.y0 = cut; }
  partition(a, out);
  partition(b, out);
}

/** Точки на периметре прямоугольника против часовой стрелки, включая Т-стыки соседей. */
function perimeter(r: { x0: number; y0: number; x1: number; y1: number }, points: THREE.Vector2[]): THREE.Vector2[] {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const param = (p: THREE.Vector2): number => {
    if (p.y === r.y0) return p.x - r.x0;
    if (p.x === r.x1) return w + (p.y - r.y0);
    if (p.y === r.y1) return w + h + (r.x1 - p.x);
    return 2 * w + h + (r.y1 - p.y);
  };
  const seen = new Set<string>();
  const on: { t: number; p: THREE.Vector2 }[] = [];
  const corners = [new THREE.Vector2(r.x0, r.y0), new THREE.Vector2(r.x1, r.y0), new THREE.Vector2(r.x1, r.y1), new THREE.Vector2(r.x0, r.y1)];
  for (const p of [...corners, ...points]) {
    const inX = p.x >= r.x0 && p.x <= r.x1, inY = p.y >= r.y0 && p.y <= r.y1;
    const onEdge = (inX && (p.y === r.y0 || p.y === r.y1)) || (inY && (p.x === r.x0 || p.x === r.x1));
    const k = `${p.x},${p.y}`;
    if (!onEdge || seen.has(k)) continue;
    seen.add(k);
    on.push({ t: param(p), p });
  }
  return on.sort((a, b) => a.t - b.t).map(o => o.p);
}

const area2 = (pts: THREE.Vector2[]) => {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
};

export interface BoardGeometryResult {
  geometry: THREE.BufferGeometry;
  /** Отверстия, реально прорезанные в сетке. */
  holes: BoardHole[];
}

/**
 * Подложка w×h×t с центром по толщине в z=0 (как прежний BoxGeometry, но с углом в 0,0).
 * Группы: верх (UV 0..1 как у текстуры), низ (UV зеркален по X), торец и голые стенки,
 * металлизированные стенки.
 */
export function createBoardGeometry(w: number, h: number, t: number, input: BoardHole[]): BoardGeometryResult {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [];
  const idx: number[][] = [[], [], [], []];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(u, v);
    return pos.length / 3 - 1;
  };
  const zt = t / 2, zb = -t / 2;

  const leaves: Region[] = [];
  partition({ x0: 0, y0: 0, x1: w, y1: h, holes: input.map(holePolygon) }, leaves);
  const corners = leaves.flatMap(r => [new THREE.Vector2(r.x0, r.y0), new THREE.Vector2(r.x1, r.y0), new THREE.Vector2(r.x1, r.y1), new THREE.Vector2(r.x0, r.y1)]);
  const cut: HolePoly[] = [];

  for (const leaf of leaves) {
    const contour = perimeter(leaf, corners);
    let holes = leaf.holes;
    let faces = holes.length ? THREE.ShapeUtils.triangulateShape(contour, holes.map(p => p.pts)) : THREE.ShapeUtils.triangulateShape(contour, []);
    let all = [...contour, ...holes.flatMap(p => p.pts)];
    const expected = Math.abs(area2(contour)) - holes.reduce((s, p) => s + Math.abs(area2(p.pts)), 0);
    const got = faces.reduce((s, [a, b, c]) => s + Math.abs(area2([all[a], all[b], all[c]])), 0);
    if (Math.abs(got - expected) > 1e-6 * Math.max(1, Math.abs(area2(contour)))) {
      // Вырожденный случай earcut: сплошной кусок лучше дыр в плате.
      holes = [];
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
      all = contour;
    }
    cut.push(...holes);
    const top = all.map(p => vert(p.x, p.y, zt, 0, 0, 1, p.x / w, p.y / h));
    const bottom = all.map(p => vert(p.x, p.y, zb, 0, 0, -1, 1 - p.x / w, p.y / h));
    for (const [a, b, c] of faces) {
      const ccw = area2([all[a], all[b], all[c]]) > 0;
      const [p, q] = ccw ? [b, c] : [c, b];
      idx[BOARD_GROUP.top].push(top[a], top[p], top[q]);
      idx[BOARD_GROUP.bottom].push(bottom[a], bottom[q], bottom[p]);
    }
  }

  // Торец платы: по тем же точкам периметра, что и крышки, — без Т-стыков.
  const outline = perimeter({ x0: 0, y0: 0, x1: w, y1: h }, corners);
  let run = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const len = a.distanceTo(b);
    if (len === 0) continue;
    const nx = (b.y - a.y) / len, ny = -(b.x - a.x) / len;
    const a0 = vert(a.x, a.y, zb, nx, ny, 0, run, 0), b0 = vert(b.x, b.y, zb, nx, ny, 0, run + len, 0);
    const b1 = vert(b.x, b.y, zt, nx, ny, 0, run + len, 1), a1 = vert(a.x, a.y, zt, nx, ny, 0, run, 1);
    idx[BOARD_GROUP.edge].push(a0, b0, b1, a0, b1, a1);
    run += len;
  }

  // Стенки отверстий: нормали внутрь, к оси сверла.
  for (const { hole, pts } of cut) {
    const group = idx[hole.plated ? BOARD_GROUP.plated : BOARD_GROUP.edge];
    const n = pts.length;
    const ring: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const p = pts[i % n];
      const nx = (hole.x - p.x) / (p.distanceTo(new THREE.Vector2(hole.x, hole.y)) || 1);
      const ny = (hole.y - p.y) / (p.distanceTo(new THREE.Vector2(hole.x, hole.y)) || 1);
      ring.push([vert(p.x, p.y, zb, nx, ny, 0, i / n, 0), vert(p.x, p.y, zt, nx, ny, 0, i / n, 1)]);
    }
    for (let i = 0; i < n; i++) {
      const [a0, a1] = ring[i], [b0, b1] = ring[i + 1];
      group.push(a0, a1, b1, a0, b1, b0);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const index: number[] = [];
  idx.forEach((list, material) => {
    geometry.addGroup(index.length, list.length, material);
    for (const i of list) index.push(i);
  });
  geometry.setIndex(index);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, holes: cut.map(p => p.hole) };
}
