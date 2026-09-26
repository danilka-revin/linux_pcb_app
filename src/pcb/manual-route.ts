import type { Pt } from './model';

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
