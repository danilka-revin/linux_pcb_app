// Правка дорожек как в Sprint-Layout: узлы-звенья, разрыв (зазор под амперметр)
// и обратная пайка концов. Чистая геометрия без React — покрыта test/trackedit.ts.

import type { Entity, Pt, Track } from './model';

const EPS = 1e-6;

export interface NearPt {
  /** индекс начала сегмента, на который упала проекция */
  seg: number;
  /** положение проекции на сегменте, 0..1 */
  t: number;
  /** точка проекции */
  pt: Pt;
  /** расстояние от исходной точки до проекции */
  dist: number;
}

/** Ближайшая точка на ломаной (closed — замкнутая, с ребром «последняя → первая») */
export function nearestOnPts(pts: Pt[], p: Pt, closed = false): NearPt | null {
  const n = closed ? pts.length : pts.length - 1;
  if (pts.length < 2 || n < 1) return null;
  let best: NearPt | null = null;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    let t = 0;
    if (L2 > 1e-12) t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (!best || d < best.dist) best = { seg: i, t, pt: q, dist: d };
  }
  return best;
}

/** Индекс узла под точкой p в радиусе tol (мм) — null, если рядом узлов нет. */
export function nodeUnder(pts: Pt[], p: Pt, tol: number): number | null {
  let best: number | null = null, bd = tol;
  pts.forEach((q, i) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d <= bd) { bd = d; best = i; }
  });
  return best;
}

/**
 * Что делает двойной клик по дорожке/полигону:
 *  • по существующему узлу — удалить его;
 *  • по звену (мимо узлов) — поставить новый узел в проекции точки клика;
 *  • мимо ломаной — ничего.
 * `justInserted` — узел, который поставил первый клик этого же двойного щелчка:
 * его второй клик не должен удалять (иначе узел появится и тут же исчезнет).
 */
export type NodeAction =
  | { kind: 'insert'; seg: number; pt: Pt }
  | { kind: 'delete'; idx: number }
  | { kind: 'keep'; idx: number };

export function nodeAction(
  pts: Pt[],
  p: Pt,
  o: { closed?: boolean; hitTol: number; nodeTol: number; justInserted?: number | null },
): NodeAction | null {
  const ni = nodeUnder(pts, p, o.nodeTol);
  if (ni != null) {
    if (o.justInserted != null && o.justInserted === ni) return { kind: 'keep', idx: ni };
    return { kind: 'delete', idx: ni };
  }
  const near = nearestOnPts(pts, p, o.closed ?? false);
  if (!near || !(near.dist <= o.hitTol)) return null;
  return { kind: 'insert', seg: near.seg, pt: near.pt };
}

/** Вставить узел в звено seg (после точки seg). Рядом с существующим узлом — не плодить. */
export function insertNode(pts: Pt[], seg: number, pt: Pt): { pts: Pt[]; idx: number } {
  const nx = pts.map((q) => ({ ...q }));
  for (let i = 0; i < nx.length; i++)
    if (Math.hypot(nx[i].x - pt.x, nx[i].y - pt.y) < EPS) return { pts: nx, idx: i };
  const at = Math.min(Math.max(seg + 1, 0), nx.length);
  nx.splice(at, 0, { ...pt });
  return { pts: nx, idx: at };
}

/** Удалить узел idx. null — удалять нельзя (у дорожки минимум 2 точки, у полигона 3). */
export function deleteNode(pts: Pt[], idx: number, closed: boolean): Pt[] | null {
  const min = closed ? 3 : 2;
  if (pts.length <= min || idx < 0 || idx >= pts.length) return null;
  return pts.filter((_, i) => i !== idx).map((q) => ({ ...q }));
}

/** Убрать подряд идущие дубликаты (следствие разреза ровно по узлу) */
function dedup(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const q of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last.x - q.x, last.y - q.y) > EPS) out.push({ ...q });
  }
  return out;
}

export interface TrackSplit {
  /** кусок от начала дорожки до зазора (null — зазор съел начало целиком) */
  left: Pt[] | null;
  /** кусок от зазора до конца (null — зазор съел конец целиком) */
  right: Pt[] | null;
}

/**
 * Разорвать дорожку в точке p: вырезать кусок длиной gap (мм) вдоль оси дорожки.
 * Длина отмеряется по ломаной, поэтому зазор корректно ложится и на изгиб.
 * null — резать нечего (зазор накрыл всю дорожку целиком).
 */
export function splitTrackAt(track: Track, p: Pt, gap: number): TrackSplit | null {
  const pts = track.pts;
  if (pts.length < 2 || !(gap > 0)) return null;
  const near = nearestOnPts(pts, p, false);
  if (!near) return null;
  // длины звеньев и полная длина
  const cum: number[] = [0];
  for (let i = 0; i < pts.length - 1; i++)
    cum.push(cum[i] + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  const total = cum[cum.length - 1];
  if (total < EPS) return null;
  if (gap >= total) return null;
  const segLen = cum[near.seg + 1] - cum[near.seg];
  const s0 = cum[near.seg] + segLen * near.t;
  const sA = Math.max(0, s0 - gap / 2), sB = Math.min(total, s0 + gap / 2);
  if (sB - sA < EPS) return null;
  const at = (s: number): Pt => {
    if (s <= 0) return { ...pts[0] };
    if (s >= total) return { ...pts[pts.length - 1] };
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < s) i++;
    const a = pts[i], b = pts[i + 1];
    const L = cum[i + 1] - cum[i];
    const t = L > 1e-12 ? (s - cum[i]) / L : 0;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  const idxA = (s: number): number => {
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] <= s + EPS) i++;
    return i;
  };
  let left: Pt[] | null = null, right: Pt[] | null = null;
  if (sA > EPS) {
    const cut = at(sA);
    const k = idxA(sA);
    const lp = [...pts.slice(0, k + 1), cut];
    const clean = dedup(lp);
    if (clean.length >= 2) left = clean;
  }
  if (sB < total - EPS) {
    const cut = at(sB);
    const k = idxA(sB);
    const rp = [cut, ...pts.slice(k + 1)];
    const clean = dedup(rp);
    if (clean.length >= 2) right = clean;
  }
  if (!left && !right) return null;
  return { left, right };
}

export interface TrackEnd {
  ent: Track;
  /** 0 — начало (pts[0]), 1 — конец (последняя точка) */
  end: 0 | 1;
  pt: Pt;
}

/**
 * Концы дорожек верхнего уровня рядом с точкой (кандидаты для пайки).
 * Отсортированы по удалению от точки — ближайшие первые.
 */
export function trackEndsNear(entities: Entity[], p: Pt, radius: number): TrackEnd[] {
  const out: TrackEnd[] = [];
  if (!(radius > 0)) return out;
  for (const e of entities) {
    if (e.kind !== 'track' || e.pts.length < 2) continue;
    const a = e.pts[0], b = e.pts[e.pts.length - 1];
    if (Math.hypot(p.x - a.x, p.y - a.y) <= radius) out.push({ ent: e, end: 0, pt: a });
    if (Math.hypot(p.x - b.x, p.y - b.y) <= radius) out.push({ ent: e, end: 1, pt: b });
  }
  out.sort(
    (m, n) => Math.hypot(p.x - m.pt.x, p.y - m.pt.y) - Math.hypot(p.x - n.pt.x, p.y - n.pt.y),
  );
  return out;
}

/**
 * Выбрать пару концов для пайки: два ближайших конца РАЗНЫХ дорожек
 * на одном слое меди. null — паять нечего (или слои разные).
 */
export function pickSolderPair(ends: TrackEnd[]): [TrackEnd, TrackEnd] | null {
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const a = ends[i], b = ends[j];
      if (a.ent.id !== b.ent.id && a.ent.layer === b.ent.layer) return [a, b];
    }
  }
  return null;
}

/** Склеить две дорожки концами в одну ломаную (порядок точек разворачивается при нужде) */
export function joinTrackPts(a: Track, aEnd: 0 | 1, b: Track, bEnd: 0 | 1): Pt[] {
  const pa = (aEnd === 1 ? a.pts : [...a.pts].reverse()).map((q) => ({ ...q }));
  const pb = (bEnd === 0 ? b.pts : [...b.pts].reverse()).map((q) => ({ ...q }));
  const pts = [...pa];
  for (const q of pb) {
    const last = pts[pts.length - 1];
    if (Math.hypot(last.x - q.x, last.y - q.y) > EPS) pts.push(q);
  }
  return pts;
}
