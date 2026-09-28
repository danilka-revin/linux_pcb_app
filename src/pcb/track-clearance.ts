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
  const result: TrackClearanceViolation[] = [];
  (candidates ?? tracks).forEach((a, i) => {
    for (let j = candidates ? 0 : i + 1; j < tracks.length; j++) {
      const b = tracks[j];
      if (a.layer !== b.layer || a === b) continue;
      const need = (a.w + b.w) / 2 + limit;
      for (let ai = 1; ai < a.pts.length; ai++) for (let bi = 1; bi < b.pts.length; bi++) {
        const p = a.pts[ai - 1], q = a.pts[ai], r = b.pts[bi - 1], s = b.pts[bi];
        if (Math.max(p.x, q.x) + need < Math.min(r.x, s.x) || Math.max(r.x, s.x) + need < Math.min(p.x, q.x)
          || Math.max(p.y, q.y) + need < Math.min(r.y, s.y) || Math.max(r.y, s.y) + need < Math.min(p.y, q.y)) continue;
        // Only endpoint junctions, not arbitrary intersecting copper, are exempt.
        const junction = [p, q].some((x, xi) => [r, s].some((y, yi) => {
          if (dist(x, y) >= 1e-7) return false;
          const u = sub(xi ? p : q, x), v = sub(yi ? r : s, y);
          // Coincident runs are overlaps, not endpoint-only connections.
          return !(Math.abs(cross(u, v)) < 1e-9 && dot(u, v) > 1e-9);
        }));
        if (junction) continue;
        const [x, y] = closest(p, q, r, s), distance = dist(x, y);
        const gap = distance - (a.w + b.w) / 2;
        if (gap >= limit - 1e-7) continue;
        // Mark copper edges rather than centre lines when they do not overlap.
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

export function activeClearance(violations: TrackClearanceViolation[], ignored: string[] = []): TrackClearanceViolation[] {
  const keys = new Set(ignored);
  return violations.filter(v => !keys.has(v.key));
}
