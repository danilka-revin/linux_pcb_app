// Read only the absolute G0/G1 dialect emitted by our CAM, not arbitrary user G-code.
export interface CncPosition { x: number; y: number; z: number }
export interface CncMove {
  from: CncPosition;
  to: CncPosition;
  rapid: boolean;
  pass: number;
  start: number;
  end: number;
}
export function cncMotion(program: string, safeZ: number) {
  let position: CncPosition = { x: 0, y: 0, z: safeZ };
  let feed = 100, time = 0, pass = 0;
  const depths = [...new Set([...program.matchAll(/^G1 Z-([\d.]+)/gm)].map(m => Number(m[1])))].sort((a, b) => a - b);
  const moves: CncMove[] = [];
  for (const line of program.split('\n')) {
    const command = /^G([01])\s/.exec(line);
    if (!command) continue;
    const f = /\bF([\d.]+)/.exec(line);
    if (f) feed = Number(f[1]);
    const to = { ...position };
    let changed = false;
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = new RegExp(`\\b${axis.toUpperCase()}(-?[\\d.]+)`).exec(line);
      if (value) { to[axis] = Number(value[1]); changed = true; }
    }
    if (!changed) continue;
    const distance = Math.hypot(to.x - position.x, to.y - position.y, to.z - position.z);
    if (!distance) continue;
    const rapid = command[1] === '0';
    if (!rapid && to.z < 0) pass = depths.indexOf(-to.z) + 1;
    // Rapids use a nominal speed for illustration, not a machine-time estimate.
    const duration = Math.max(.05, distance / (rapid ? 1000 : feed) * 60);
    moves.push({ from: position, to, rapid, pass, start: time, end: time + duration });
    time += duration;
    position = to;
  }
  return { moves, depths, duration: time };
}

export function sampleCncMotion(motion: ReturnType<typeof cncMotion>, progress: number) {
  if (!motion.moves.length) return null;
  const time = Math.max(0, Math.min(1, progress)) * motion.duration;
  let lo = 0, hi = motion.moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (motion.moves[mid].end < time) lo = mid + 1; else hi = mid;
  }
  const move = motion.moves[lo];
  const t = Math.max(0, Math.min(1, (time - move.start) / (move.end - move.start)));
  const position = {
    x: move.from.x + (move.to.x - move.from.x) * t,
    y: move.from.y + (move.to.y - move.from.y) * t,
    z: move.from.z + (move.to.z - move.from.z) * t,
  };
  return { move, position };
}
