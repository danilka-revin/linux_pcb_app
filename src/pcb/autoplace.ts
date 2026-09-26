// Compact rectangular packing. Heuristic, not a proof of the global minimum.
import { entBBox, unionBBox, type Comp, type Doc, type Entity } from './model';
import { expandComp } from './expand';
import { copperComponents } from './netroute';

type Box = [number, number, number, number];
export interface PlacementOpts { gap: number; edge: number; rotate: boolean }
export interface PlacementResult {
  entities: Entity[];
  count: number;
  width: number;
  height: number;
  beforeWidth: number;
  beforeHeight: number;
  error?: string;
}
const EPS = 1e-7;
const validBox = (b: Box) => b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
const overlaps = (a: Box, b: Box) => a[0] < b[2] - EPS && a[2] > b[0] + EPS && a[1] < b[3] - EPS && a[3] > b[1] + EPS;
const contains = (a: Box, b: Box) => a[0] <= b[0] + EPS && a[1] <= b[1] + EPS && a[2] >= b[2] - EPS && a[3] >= b[3] - EPS;

/** Conservative visible bounds, including stroke width and arbitrary SMD rotation. */
function primitiveBBox(e: Entity): Box {
  if (e.kind === 'smd') {
    const angle = e.rot * Math.PI / 180;
    const w = Math.abs(Math.cos(angle)) * e.w + Math.abs(Math.sin(angle)) * e.h;
    const h = Math.abs(Math.sin(angle)) * e.w + Math.abs(Math.cos(angle)) * e.h;
    return [e.x - w / 2, e.y - h / 2, e.x + w / 2, e.y + h / 2];
  }
  const b = entBBox(e);
  const extra = e.kind === 'circle' ? e.w / 2 : e.kind === 'rect' && !e.filled ? e.th / 2 : e.kind === 'text' ? e.th / 2 : 0;
  return [b[0] - extra, b[1] - extra, b[2] + extra, b[3] + extra];
}

/** Include actual pads and silk, even when an imported component's cached bl is too small. */
export function placementBBox(c: Comp): Box {
  return unionBBox([entBBox(c), ...expandComp(c).map(primitiveBBox)]);
}

// MaxRects split: free rectangles may overlap each other, but never placed objects.
function subtract(free: Box[], used: Box): Box[] {
  const out: Box[] = [];
  for (const r of free) {
    if (!overlaps(r, used)) { out.push(r); continue; }
    if (used[0] > r[0] + EPS) out.push([r[0], r[1], used[0], r[3]]);
    if (used[2] < r[2] - EPS) out.push([used[2], r[1], r[2], r[3]]);
    if (used[1] > r[1] + EPS) out.push([r[0], r[1], r[2], used[1]]);
    if (used[3] < r[3] - EPS) out.push([r[0], used[3], r[2], r[3]]);
  }
  return out.filter((r, i) => !out.some((s, j) => j !== i && contains(s, r) && (!contains(r, s) || j < i)));
}

export function autoPlace(doc: Doc, selected: string[], opts: PlacementOpts): PlacementResult {
  const ids = new Set(selected);
  const comps = doc.entities.filter((e): e is Comp => e.kind === 'comp' && (!ids.size || ids.has(e.id)));
  const fail = (error: string): PlacementResult => ({ entities: doc.entities, count: comps.length, width: 0, height: 0, beforeWidth: 0, beforeHeight: 0, error });
  if (!Number.isFinite(opts.gap) || opts.gap < 0.1 || !Number.isFinite(opts.edge) || opts.edge < 0 || !Number.isFinite(doc.w) || !Number.isFinite(doc.h)) return fail('Проверьте зазор (не менее 0,1 мм), отступ и размеры платы.');
  if (comps.length < 2) return fail('Нужно минимум два компонента. Выделите детали или снимите выделение, чтобы собрать все компоненты.');
  const moving = new Set(comps.map((c) => c.id));
  const fixed = doc.entities.filter((e) => !moving.has(e.id));
  // Never detach a routed component from existing copper. Unrelated routes stay as obstacles.
  if (fixed.length) {
    const connectivity = copperComponents(doc.entities);
    const roots = new Set([...connectivity].filter(([id]) => moving.has(id.split(':')[0])).map(([, root]) => root));
    if ([...connectivity].some(([id, root]) => !moving.has(id.split(':')[0]) && roots.has(root))) {
      return fail('Компоненты уже соединены с неподвижной медью. Сначала удалите связанные дорожки или выполните компоновку до трассировки. Соединения не будут разорваны автоматически.');
    }
  }
  const originalBoxes = comps.map(placementBBox);
  if (originalBoxes.some((b) => !validBox(b))) return fail('У компонента некорректные габариты. Проверьте его корпус.');
  const before = unionBBox(originalBoxes);
  const bw = doc.w - 2 * opts.edge, bh = doc.h - 2 * opts.edge;
  if (bw <= 0 || bh <= 0) return fail('Отступ от края больше доступного размера платы.');
  const obstacles = fixed.filter((e) => !('layer' in e && e.layer === 'outline')).map((e) => e.kind === 'comp' ? placementBBox(e) : primitiveBBox(e));
  if (obstacles.some((b) => !b.every(Number.isFinite))) return fail('У неподвижного элемента некорректные координаты.');
  const shapes = comps.map((c) => (opts.rotate ? [c, { ...c, rot: (c.rot + 90) % 360 }] : [c]).map((comp) => {
    const box = placementBBox({ ...comp, x: 0, y: 0 });
    return { comp, box, w: box[2] - box[0], h: box[3] - box[1] };
  }));
  const order = shapes.map((_, i) => i);
  const orders = [
    [...order].sort((a, b) => shapes[b][0].w * shapes[b][0].h - shapes[a][0].w * shapes[a][0].h),
    [...order].sort((a, b) => Math.max(shapes[b][0].w, shapes[b][0].h) - Math.max(shapes[a][0].w, shapes[a][0].h)),
    [...order].sort((a, b) => shapes[b][0].h - shapes[a][0].h),
  ];
  const score = (cs: Comp[]) => {
    const b = unionBBox(cs.map(placementBBox));
    const w = b[2] - b[0], h = b[3] - b[1];
    return Math.max(w, h) + w * h / (doc.w * doc.h + 1) * 1e-3;
  };
  function trySize(side: number): Comp[] | null {
    const w = Math.min(side, bw), h = Math.min(side, bh);
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const cx = clamp((before[0] + before[2] - w) / 2, opts.edge, doc.w - opts.edge - w);
    const cy = clamp((before[1] + before[3] - h) / 2, opts.edge, doc.h - opts.edge - h);
    const anchors = [[cx, cy], [opts.edge, opts.edge], [doc.w - opts.edge - w, opts.edge],
      [opts.edge, doc.h - opts.edge - h], [doc.w - opts.edge - w, doc.h - opts.edge - h]];
    let best: Comp[] | null = null;
    const seen = new Set<string>();
    for (const [x, y] of anchors) {
      const key = `${x.toFixed(5)},${y.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let initial: Box[] = [[x, y, x + w + opts.gap, y + h + opts.gap]];
      for (const b of obstacles) initial = subtract(initial, [b[0], b[1], b[2] + opts.gap, b[3] + opts.gap]);
      for (const ord of orders) {
        let free = initial;
        const placed: Comp[] = [];
        for (const i of ord) {
          let choice: { shape: typeof shapes[number][number]; x: number; y: number; cost: number } | null = null;
          for (const r of free) for (const shape of shapes[i]) {
            const dw = r[2] - r[0] - shape.w - opts.gap, dh = r[3] - r[1] - shape.h - opts.gap;
            if (dw < -EPS || dh < -EPS) continue;
            const cost = Math.min(dw, dh) * (doc.w + doc.h + 1) + Math.max(dw, dh);
            if (!choice || cost < choice.cost) choice = { shape, x: r[0], y: r[1], cost };
          }
          if (!choice) break;
          const { shape, x: px, y: py } = choice;
          placed.push({ ...shape.comp, x: px - shape.box[0], y: py - shape.box[1] });
          free = subtract(free, [px, py, px + shape.w + opts.gap, py + shape.h + opts.gap]);
        }
        if (placed.length === comps.length && (!best || score(placed) < score(best) - EPS)) best = placed;
      }
    }
    return best;
  }
  let hi = Math.max(bw, bh), lo = 0;
  let best = trySize(hi);
  if (!best) return fail('Не удалось разместить компоненты без пересечений. Увеличьте плату, уменьшите зазор или освободите место.');
  // Bounded search keeps calculation predictable; every accepted result is collision-free.
  for (let i = 0; i < 14 && hi - lo > 0.02; i++) {
    const mid = (lo + hi) / 2;
    const placed = trySize(mid);
    if (placed) { hi = mid; if (score(placed) < score(best) - EPS) best = placed; }
    else lo = mid;
  }
  const byId = new Map(best.map((c) => [c.id, c]));
  const bounds = unionBBox(best.map(placementBBox));
  return {
    entities: doc.entities.map((e) => byId.get(e.id) ?? e), count: best.length,
    width: bounds[2] - bounds[0], height: bounds[3] - bounds[1],
    beforeWidth: before[2] - before[0], beforeHeight: before[3] - before[1],
  };
}
