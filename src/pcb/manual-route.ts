import type { Entity, LayerId, Pt, Track } from './model';
import type { Cu } from './autoroute';

/** Reach a terminal exactly, adding a bend instead of projecting away from it. */
export function terminalPath(from: Pt, to: Pt, angle: 'free' | '45' | '90'): Pt[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return [];
  if (angle === 'free' || Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6) return [to];
  let bend: Pt;
  if (angle === '90') bend = { x: to.x, y: from.y };
  else {
    if (Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6) return [to];
    const diagonal = Math.min(Math.abs(dx), Math.abs(dy));
    bend = { x: from.x + Math.sign(dx) * diagonal, y: from.y + Math.sign(dy) * diagonal };
  }
  return [bend, to];
}

/** A real vertex, not a grid approximation or a projection onto a segment. */
export interface TrackNodeTerminal extends Pt {
  kind: 'track';
  entId: string;
  node: number;
  layers: Cu[];
  r: number;
  width: number;
}

/** Pass expanded primitives to include component tracks. Ties prefer the active layer. */
export function pickTrackNode(entities: Entity[], p: Pt, tolerance: number, options: {
  layer?: Cu;
  preferredLayer?: Cu;
  hidden?: ReadonlySet<LayerId>;
} = {}): TrackNodeTerminal | null {
  let best: TrackNodeTerminal | null = null, distance = tolerance;
  for (const e of entities) {
    if (e.kind !== 'track' || options.hidden?.has(e.layer) || (options.layer && e.layer !== options.layer)) continue;
    e.pts.forEach((point, node) => {
      const d = Math.hypot(point.x - p.x, point.y - p.y);
      if (d > tolerance) return;
      if (!best || d < distance - 1e-9 || (Math.abs(d - distance) <= 1e-9
        && e.layer === options.preferredLayer && best.layers[0] !== options.preferredLayer)) {
        distance = d;
        best = trackNodeTerminal(e, node);
      }
    });
  }
  return best;
}

export function trackNodeTerminal(track: Track, node: number): TrackNodeTerminal {
  const p = track.pts[node];
  return { x: p.x, y: p.y, kind: 'track', entId: track.id, node, layers: [track.layer], r: track.w / 2, width: track.w };
}
