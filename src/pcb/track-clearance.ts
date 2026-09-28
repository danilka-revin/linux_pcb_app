import type { Entity, Pt, Track } from './model';

export interface TrackClearanceViolation {
  /** Geometry-bound identity: editing a segment or the rule re-enables its warning. */
  key: string;
  a: Pt;
  b: Pt;
  gap: number;
  layer: Track['layer'];
}
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const at = (a: Pt, d: Pt, t: number): Pt => ({ x: a.x + d.x * t, y: a.y + d.y * t });
function project(p: Pt, a: Pt, b: Pt): Pt {
  const d = sub(b, a), l = dot(d, d);
  return at(a, d, l ? Math.max(0, Math.min(1, dot(sub(p, a), d) / l)) : 0);
}
/** Exact segment distance, including intersections and zero-length segments. */
function closest(a: Pt, b: Pt, c: Pt, d: Pt): [Pt, Pt] {
  const u = sub(b, a), v = sub(d, c), w = sub(c, a), den = cross(u, v);
  if (Math.abs(den) > 1e-12) {
    const t = cross(w, v) / den, s = cross(w, u) / den;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1) {
      const p = at(a, u, t); return [p, p];
    }
  }
  return ([[a, project(a, c, d)], [b, project(b, c, d)],
    [project(c, a, b), c], [project(d, a, b), d]] as [Pt, Pt][])
    .sort((p, q) => dist(...p) - dist(...q))[0];
}

/** Geometric track-only check. Exact shared endpoints are intentional junctions;
 * other overlaps are reported, even if copper connectivity would join the nets.
 * Pass expanded entities to include tracks inside components.
 * With candidates, only candidate-to-board pairs are checked (live routing).
 */
export function trackClearance(entities: Entity[], limit: number, candidates?: Track[]): TrackClearanceViolation[] {
  if (!Number.isFinite(limit) || limit < 0) return [];
  const tracks = entities.filter((e): e is Track => e.kind === 'track');
  if (!tracks.length) return [];
  const result: TrackClearanceViolation[] = [];

  // Быстрый путь для малого числа дорожек — без индекса
  const useIndex = tracks.length > 80 || (candidates && candidates.length > 0 && tracks.length > 40);

  if (!useIndex) {
    (candidates ?? tracks).forEach((a, i) => {
      for (let j = candidates ? 0 : i + 1; j < tracks.length; j++) {
        const b = tracks[j];
        if (a.layer !== b.layer || a === b) continue;
        const need = (a.w + b.w) / 2 + limit;
        for (let ai = 1; ai < a.pts.length; ai++) for (let bi = 1; bi < b.pts.length; bi++) {
          const p = a.pts[ai - 1], q = a.pts[ai], r = b.pts[bi - 1], s = b.pts[bi];
          if (Math.max(p.x, q.x) + need < Math.min(r.x, s.x) || Math.max(r.x, s.x) + need < Math.min(p.x, q.x)
            || Math.max(p.y, q.y) + need < Math.min(r.y, s.y) || Math.max(r.y, s.y) + need < Math.min(p.y, q.y)) continue;
          const junction = [p, q].some((x, xi) => [r, s].some((y, yi) => {
            if (dist(x, y) >= 1e-7) return false;
            const u = sub(xi ? p : q, x), v = sub(yi ? r : s, y);
            return !(Math.abs(cross(u, v)) < 1e-9 && dot(u, v) > 1e-9);
          }));
          if (junction) continue;
          const [x, y] = closest(p, q, r, s), distance = dist(x, y);
          const gap = distance - (a.w + b.w) / 2;
          if (gap >= limit - 1e-7) continue;
          const dir = distance ? sub(y, x) : { x: 0, y: 0 };
          const segmentKey = (t: Track, p: Pt, q: Pt) => JSON.stringify([t.id, t.w,
            ...[JSON.stringify(p), JSON.stringify(q)].sort()]);
          const key = JSON.stringify([a.layer, limit, ...[segmentKey(a, p, q), segmentKey(b, r, s)].sort()]);
          result.push({ key, a: at(x, dir, distance ? Math.min(a.w / 2 / distance, .5) : 0),
            b: at(y, dir, distance ? -Math.min(b.w / 2 / distance, .5) : 0), gap, layer: a.layer });
        }
      }
    });
    return result;
  }

  // Индекс по сетке для ускорения: O(n log n) вместо O(n²)
  type SegInfo = { track: Track; idx: number; a: Pt; b: Pt; bbox: [number, number, number, number] };
  // Предпосчитаем bbox треков и макс. ширину
  let maxW = 0;
  for (let i = 0; i < tracks.length; i++) if (tracks[i].w > maxW) maxW = tracks[i].w;
  if (candidates) for (let i = 0; i < candidates.length; i++) if (candidates[i].w > maxW) maxW = candidates[i].w;
  const searchExpand = maxW / 2 + limit + 0.5; // запас
  const cellSize = Math.max(8, searchExpand * 2.5);

  // bbox треков (расширенный для поиска)
  const trackBBoxes: [number, number, number, number][] = new Array(tracks.length);
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let k = 0; k < t.pts.length; k++) {
      const p = t.pts[k];
      if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y;
    }
    const m = t.w / 2;
    trackBBoxes[i] = [x1 - m - searchExpand, y1 - m - searchExpand, x2 + m + searchExpand, y2 + m + searchExpand];
  }

  // Построение сетки: cellKey -> track indices
  const grid = new Map<string, number[]>();
  const addToGrid = (bbox: [number, number, number, number], idx: number) => {
    const ix1 = Math.floor(bbox[0] / cellSize), ix2 = Math.floor(bbox[2] / cellSize);
    const iy1 = Math.floor(bbox[1] / cellSize), iy2 = Math.floor(bbox[3] / cellSize);
    for (let ix = ix1; ix <= ix2; ix++) for (let iy = iy1; iy <= iy2; iy++) {
      const key = ix + ':' + iy;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(idx);
    }
  };
  for (let i = 0; i < tracks.length; i++) addToGrid(trackBBoxes[i], i);

  const checkedPairs = new Set<string>();

  const processPair = (a: Track, b: Track) => {
    if (a.layer !== b.layer || a === b) return;
    const need = (a.w + b.w) / 2 + limit;
    // быстрый отсев по bbox треков (не расширенному, а реальному + need)
    // уже частично отсеяно сеткой, но оставим точный тест сегментов ниже
    for (let ai = 1; ai < a.pts.length; ai++) {
      const p = a.pts[ai - 1], q = a.pts[ai];
      const apMinX = p.x < q.x ? p.x : q.x, apMaxX = p.x > q.x ? p.x : q.x;
      const apMinY = p.y < q.y ? p.y : q.y, apMaxY = p.y > q.y ? p.y : q.y;
      for (let bi = 1; bi < b.pts.length; bi++) {
        const r = b.pts[bi - 1], s = b.pts[bi];
        if (apMaxX + need < (r.x < s.x ? r.x : s.x) || (r.x > s.x ? r.x : s.x) + need < apMinX
          || apMaxY + need < (r.y < s.y ? r.y : s.y) || (r.y > s.y ? r.y : s.y) + need < apMinY) continue;
        const junction = (dist(p, r) < 1e-7 || dist(p, s) < 1e-7 || dist(q, r) < 1e-7 || dist(q, s) < 1e-7)
          ? [p, q].some((x, xi) => [r, s].some((y, yi) => {
              if (dist(x, y) >= 1e-7) return false;
              const u = sub(xi ? p : q, x), v = sub(yi ? r : s, y);
              return !(Math.abs(cross(u, v)) < 1e-9 && dot(u, v) > 1e-9);
            }))
          : false;
        if (junction) continue;
        const [x, y] = closest(p, q, r, s), distance = dist(x, y);
        const gap = distance - (a.w + b.w) / 2;
        if (gap >= limit - 1e-7) continue;
        const dir = distance ? sub(y, x) : { x: 0, y: 0 };
        const segmentKey = (t: Track, p: Pt, q: Pt) => t.id + ':' + t.w + ':' + p.x.toFixed(3) + ',' + p.y.toFixed(3) + '-' + q.x.toFixed(3) + ',' + q.y.toFixed(3);
        const key = a.layer + ':' + limit + ':' + [segmentKey(a, p, q), segmentKey(b, r, s)].sort().join('|');
        result.push({ key, a: at(x, dir, distance ? Math.min(a.w / 2 / distance, .5) : 0),
          b: at(y, dir, distance ? -Math.min(b.w / 2 / distance, .5) : 0), gap, layer: a.layer });
      }
    }
  };

  if (candidates) {
    // candidates vs board
    for (let ci = 0; ci < candidates.length; ci++) {
      const a = candidates[ci];
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let k = 0; k < a.pts.length; k++) {
        const p = a.pts[k];
        if (p.x < x1) x1 = p.x; if (p.y < y1) y1 = p.y;
        if (p.x > x2) x2 = p.x; if (p.y > y2) y2 = p.y;
      }
      const m = a.w / 2;
      const cb: [number, number, number, number] = [x1 - m - searchExpand, y1 - m - searchExpand, x2 + m + searchExpand, y2 + m + searchExpand];
      const ix1 = Math.floor(cb[0] / cellSize), ix2 = Math.floor(cb[2] / cellSize);
      const iy1 = Math.floor(cb[1] / cellSize), iy2 = Math.floor(cb[3] / cellSize);
      const seen = new Set<number>();
      for (let ix = ix1; ix <= ix2; ix++) for (let iy = iy1; iy <= iy2; iy++) {
        const arr = grid.get(ix + ':' + iy);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const j = arr[k];
          if (seen.has(j)) continue;
          seen.add(j);
          processPair(a, tracks[j]);
        }
      }
    }
  } else {
    // all vs all, но только соседи по сетке
    for (let i = 0; i < tracks.length; i++) {
      const bbox = trackBBoxes[i];
      const ix1 = Math.floor(bbox[0] / cellSize), ix2 = Math.floor(bbox[2] / cellSize);
      const iy1 = Math.floor(bbox[1] / cellSize), iy2 = Math.floor(bbox[3] / cellSize);
      const seen = new Set<number>();
      for (let ix = ix1; ix <= ix2; ix++) for (let iy = iy1; iy <= iy2; iy++) {
        const arr = grid.get(ix + ':' + iy);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const j = arr[k];
          if (j <= i || seen.has(j)) continue;
          seen.add(j);
          const pairKey = i + ':' + j;
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);
          processPair(tracks[i], tracks[j]);
        }
      }
    }
  }
  return result;
}

export function activeClearance(violations: TrackClearanceViolation[], ignored: string[] = []): TrackClearanceViolation[] {
  const keys = new Set(ignored);
  return violations.filter(v => !keys.has(v.key));
}
