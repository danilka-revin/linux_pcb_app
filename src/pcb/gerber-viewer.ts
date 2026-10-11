// Минимальный CAM-парсер для RS-274X, создаваемого PSBees, и Excellon.
// Покрывает flash, линии, регионы, круговые интерполяции и V-CUT guide.
export interface GerberAperture {
  id: number;
  shape: 'C' | 'R' | 'P';
  width: number;
  height: number;
  vertices?: number;
  rotation?: number;
}
export interface GerberPrimitive {
  kind: 'path' | 'region' | 'flash';
  points: { x: number; y: number }[];
  aperture: GerberAperture;
  polarity: 'dark' | 'clear';
}
export interface GerberLayerData {
  primitives: GerberPrimitive[];
  bounds: [number, number, number, number];
  /** A geometry/vertex safety limit was reached while parsing an untrusted file. */
  truncated?: boolean;
}
export interface DrillHit { x: number; y: number; diameter: number }

const DEFAULT_APERTURE: GerberAperture = { id: 0, shape: 'C', width: 0.1, height: 0.1 };
const norm = (v: number): number => Number.isFinite(v) ? v : 0;
const pointAt = (x: number, y: number) => ({ x, y });

function coordinate(raw: string | undefined, scale: number, unitMm: number): number | null {
  if (raw === undefined) return null;
  if (raw.includes('.')) return Number(raw) * unitMm;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / scale * unitMm;
}
function parseAperture(token: string, unitMm: number): GerberAperture | null {
  const m = /%?ADD(\d+)([CRP]),([^%]+)/.exec(token);
  if (!m) return null;
  const args = m[3].replace(/\*+$/, '').split(/[Xx,]/).filter(Boolean).map(Number);
  const width = args[0] * unitMm;
  const height = m[2] === 'R' ? (args[1] ?? args[0]) * unitMm : width;
  if (!(width > 0) || !Number.isFinite(width) || !(height > 0) || !Number.isFinite(height)) return null;
  return {
    id: Number(m[1]), shape: m[2] as GerberAperture['shape'], width,
    height,
    ...(m[2] === 'P' ? { vertices: Math.max(3, Math.round(args[1] ?? 6)), rotation: args[2] ?? 0 } : {}),
  };
}
function arcPoints(start: { x: number; y: number }, end: { x: number; y: number }, i: number, j: number, clockwise: boolean): { x: number; y: number }[] {
  const cx = start.x + i, cy = start.y + j;
  const r = Math.hypot(start.x - cx, start.y - cy);
  if (!(r > 0) || !Number.isFinite(r)) return [start, end];
  const a0 = Math.atan2(start.y - cy, start.x - cx), a1 = Math.atan2(end.y - cy, end.x - cx);
  let sweep = a1 - a0;
  if (clockwise) { while (sweep >= 0) sweep -= Math.PI * 2; }
  else { while (sweep <= 0) sweep += Math.PI * 2; }
  if (Math.hypot(start.x - end.x, start.y - end.y) < 1e-7) sweep = clockwise ? -Math.PI * 2 : Math.PI * 2;
  const count = Math.max(4, Math.min(128, Math.ceil(Math.abs(sweep) * Math.max(1, r) * 10)));
  return Array.from({ length: count + 1 }, (_, index) => {
    const a = a0 + sweep * index / count;
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}
function geometryBounds(primitives: GerberPrimitive[]): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of primitives) for (const pt of p.points) {
    const rX = p.kind === 'flash' ? p.aperture.width / 2 : p.aperture.width / 2;
    const rY = p.kind === 'flash' ? p.aperture.height / 2 : p.aperture.width / 2;
    b[0] = Math.min(b[0], pt.x - rX); b[1] = Math.min(b[1], pt.y - rY);
    b[2] = Math.max(b[2], pt.x + rX); b[3] = Math.max(b[3], pt.y + rY);
  }
  return b[0] === Infinity ? [0, 0, 1, 1] : b;
}

/** Parse RS-274X commands. Unknown attributes/comments are ignored without execution. */
export function parseGerber(source: string): GerberLayerData {
  if (source.length > 40 * 1024 * 1024) throw new Error('Gerber-файл слишком большой (лимит 40 МБ).');
  const apertures = new Map<number, GerberAperture>();
  const primitives: GerberPrimitive[] = [];
  let remainingPoints = 1_000_000;
  let truncated = false;
  let currentAperture = DEFAULT_APERTURE;
  let x = 0, y = 0, scale = 10_000, unitMm = 1, polarity: 'dark' | 'clear' = 'dark';
  let inRegion = false;
  let region: { x: number; y: number }[] = [];
  let interpolation: 'linear' | 'cw' | 'ccw' = 'linear';
  const add = (item: GerberPrimitive): void => {
    if (primitives.length < 250_000 && item.points.length <= remainingPoints) {
      primitives.push(item); remainingPoints -= item.points.length;
    } else truncated = true;
  };
  const flushRegion = (): void => {
    if (region.length >= 3) add({ kind: 'region', points: region, aperture: currentAperture, polarity });
    region = [];
  };
  const tokens = source.replace(/\r/g, '').split('*');
  for (const raw of tokens) {
    // RS-274X extended blocks are written as `%COMMAND*%`; after splitting on
    // `*`, adjacent blocks can leave `%\n%` prefixes on the next token.
    const token = raw.trim().replace(/^[%\s]+|[%\s]+$/g, '');
    if (!token || token.startsWith('G04') || token.startsWith('M02')) continue;
    const format = /FSLAX\d(\d)Y\d(\d)/i.exec(token);
    if (format) { scale = 10 ** Number(format[2]); continue; }
    if (/MOMM/i.test(token)) { unitMm = 1; continue; }
    if (/MOIN/i.test(token)) { unitMm = 25.4; continue; }
    const aperture = parseAperture(token, unitMm);
    if (aperture) { apertures.set(aperture.id, aperture); continue; }
    if (/LPD/i.test(token)) { polarity = 'dark'; continue; }
    if (/LPC/i.test(token)) { polarity = 'clear'; continue; }
    if (/^G36/i.test(token)) { inRegion = true; region = []; continue; }
    if (/^G37/i.test(token)) { flushRegion(); inRegion = false; continue; }
    if (/^G0?1/i.test(token)) { interpolation = 'linear'; if (!/[XY]/i.test(token)) continue; }
    else if (/^G0?2/i.test(token)) { interpolation = 'cw'; if (!/[XY]/i.test(token)) continue; }
    else if (/^G0?3/i.test(token)) { interpolation = 'ccw'; if (!/[XY]/i.test(token)) continue; }
    if (/^G75/i.test(token)) continue;
    if (/^D\d+$/i.test(token)) {
      const d = Number(token.slice(1));
      if (d >= 10) currentAperture = apertures.get(d) ?? { ...DEFAULT_APERTURE, id: d };
      continue;
    }
    const cmd = /D(0?[123])\s*$/i.exec(token)?.[1];
    if (!cmd) continue;
    const mx = /X(-?\d+(?:\.\d+)?)/i.exec(token)?.[1];
    const my = /Y(-?\d+(?:\.\d+)?)/i.exec(token)?.[1];
    const mi = /I(-?\d+(?:\.\d+)?)/i.exec(token)?.[1];
    const mj = /J(-?\d+(?:\.\d+)?)/i.exec(token)?.[1];
    const nx = coordinate(mx, scale, unitMm) ?? x, ny = coordinate(my, scale, unitMm) ?? y;
    const next = pointAt(norm(nx), norm(ny));
    const op = Number(cmd);
    if (op === 2) {
      if (inRegion && region.length >= 3) flushRegion();
      if (inRegion) region = [next];
      x = next.x; y = next.y;
      continue;
    }
    if (op === 3) {
      add({ kind: 'flash', points: [next], aperture: currentAperture, polarity });
      x = next.x; y = next.y;
      continue;
    }
    if (inRegion) {
      if (region.length < 500_000) region.push(next);
      else truncated = true;
    } else {
      const start = pointAt(x, y);
      const points = interpolation === 'linear'
        ? [start, next]
        : arcPoints(start, next, coordinate(mi, scale, unitMm) ?? 0, coordinate(mj, scale, unitMm) ?? 0, interpolation === 'cw');
      add({ kind: 'path', points, aperture: currentAperture, polarity });
    }
    x = next.x; y = next.y;
  }
  if (inRegion) flushRegion();
  return { primitives, bounds: geometryBounds(primitives), ...(truncated ? { truncated: true } : {}) };
}

export function parseExcellon(source: string): DrillHit[] {
  if (source.length > 40 * 1024 * 1024) throw new Error('Excellon-файл слишком большой (лимит 40 МБ).');
  const tools = new Map<number, number>();
  const holes: DrillHit[] = [];
  let active = 0;
  let metric = true;
  let scale = 1000;
  for (const raw of source.replace(/\r/g, '').split(/\n|\*/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('M')) continue;
    if (/INCH/i.test(line)) { metric = false; scale = 10_000; continue; }
    if (/METRIC/i.test(line)) { metric = true; scale = 1000; continue; }
    const tool = /^T(\d+)(?:C([\d.]+))?/i.exec(line);
    if (tool) {
      active = Number(tool[1]);
      if (tool[2]) {
        const diameter = Number(tool[2]) * (metric ? 1 : 25.4);
        if (Number.isFinite(diameter) && diameter > 0) tools.set(active, diameter);
      }
      continue;
    }
    const xy = /^X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)/i.exec(line);
    if (!xy || !active) continue;
    const unit = metric ? 1 : 25.4;
    const x = xy[1].includes('.') ? Number(xy[1]) * unit : Number(xy[1]) / scale * unit;
    const y = xy[2].includes('.') ? Number(xy[2]) * unit : Number(xy[2]) / scale * unit;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (holes.length >= 500_000) throw new Error('В Excellon превышен безопасный лимит 500 000 отверстий.');
    holes.push({ x, y, diameter: tools.get(active) ?? 0.5 });
  }
  return holes;
}
