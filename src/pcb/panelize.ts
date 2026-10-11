// Производственная панелизация: повтор плат, рейки, оснастка, реперы,
// breakaway tabs с mouse-bites и отдельные линии V-cut.
import type { Doc, Entity, Group, Pt } from './model';
import { cloneDoc, uid, translateEnt } from './model';
import { boardShape } from './board-shape';
import { remapGroups } from './group';

export interface PanelizeOptions {
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  railWidth: number;
  toolingHoles: boolean;
  toolingHoleDia: number;
  fiducials: boolean;
  breakawayTabs: boolean;
  tabWidth: number;
  mouseBiteDia: number;
  mouseBitePitch: number;
  vCutColumns: boolean;
  vCutRows: boolean;
}
export interface PanelInfo {
  cols: number;
  rows: number;
  breakawayTabs: boolean;
  vCuts: { x1: number; y1: number; x2: number; y2: number }[];
}
export interface PanelizeResult { doc: Doc; warnings: string[] }

export const DEFAULT_PANELIZE_OPTIONS: PanelizeOptions = {
  cols: 2, rows: 1, stepX: 102, stepY: 82, railWidth: 5,
  toolingHoles: true, toolingHoleDia: 3.2, fiducials: true,
  breakawayTabs: false, tabWidth: 5, mouseBiteDia: 0.5, mouseBitePitch: 0.8,
  vCutColumns: false, vCutRows: false,
};
const clampInt = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(v)));
const finite = (v: number, fallback: number): number => Number.isFinite(v) ? v : fallback;
const distance = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

interface LoopSpec { points: Pt[]; hole: boolean }
const sourceLoops = (doc: Doc): LoopSpec[] => {
  const shape = boardShape(doc);
  return shape.regions.flatMap((region) => [
    { points: region.outer, hole: false }, ...region.holes.map((points) => ({ points, hole: true })),
  ]);
};

function copyEntity(e: Entity, dx: number, dy: number): Entity {
  const copy = cloneDoc({ name: 'copy', w: 1, h: 1, entities: [e] }).entities[0];
  copy.id = uid();
  translateEnt(copy, dx, dy);
  return copy;
}

type EdgeGap = [lo: number, hi: number, axis: 'x' | 'y', fixed: number];

function outlineLines(loop: Pt[], dx: number, dy: number, gaps: EdgeGap[] = []): Entity[] {
  const out: Entity[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const horiz = Math.abs(a.y - b.y) < 1e-6;
    const vert = Math.abs(a.x - b.x) < 1e-6;
    const axis = horiz ? 'x' : vert ? 'y' : null;
    const aCoord = axis === 'x' ? a.x : a.y;
    const bCoord = axis === 'x' ? b.x : b.y;
    let intervals: [number, number][] = [];
    if (axis) {
      const lo = Math.min(aCoord, bCoord), hi = Math.max(aCoord, bCoord);
      const fixed = axis === 'y' ? a.x : a.y;
      intervals = gaps.filter((g) => g[2] === axis && Math.abs(g[3] - fixed) < 1e-5
        && g[0] >= lo - 1e-6 && g[1] <= hi + 1e-6)
        .map((g): [number, number] => [Math.max(lo, g[0]), Math.min(hi, g[1])]).sort((u, v) => u[0] - v[0]);
    }
    const parts: [number, number][] = [];
    let from = 0;
    const span = axis ? Math.abs(bCoord - aCoord) : 0;
    for (const interval of intervals) {
      const t0 = span ? (interval[0] - Math.min(aCoord, bCoord)) / span : 0;
      const t1 = span ? (interval[1] - Math.min(aCoord, bCoord)) / span : 0;
      const cut0 = aCoord <= bCoord ? t0 : 1 - t1;
      const cut1 = aCoord <= bCoord ? t1 : 1 - t0;
      if (cut0 > from + 1e-7) parts.push([from, cut0]);
      from = Math.max(from, cut1);
    }
    if (from < 1 - 1e-7) parts.push([from, 1]);
    for (const [t0, t1] of parts) {
      const p = { x: a.x + (b.x - a.x) * t0 + dx, y: a.y + (b.y - a.y) * t0 + dy };
      const q = { x: a.x + (b.x - a.x) * t1 + dx, y: a.y + (b.y - a.y) * t1 + dy };
      if (distance(p, q) > 1e-6) out.push({ id: uid(), kind: 'line', x1: p.x, y1: p.y, x2: q.x, y2: q.y, w: 0.1, layer: 'outline' });
    }
  }
  return out;
}

function pushHole(out: Entity[], x: number, y: number, d: number, featureIds?: string[]): void {
  const hole = { id: uid(), kind: 'hole' as const, x, y, d };
  out.push(hole);
  featureIds?.push(hole.id);
}

/** Build a manufacturing panel. All dimensions are mm. */
export function panelizeDoc(source: Doc, input: Partial<PanelizeOptions> = {}): PanelizeResult {
  if (source.panelInfo) return {
    doc: cloneDoc(source), warnings: ['Документ уже панелизирован. Для новой панели откройте исходный проект платы.'],
  };
  const o: PanelizeOptions = { ...DEFAULT_PANELIZE_OPTIONS, ...input };
  o.cols = clampInt(finite(o.cols, 1), 1, 10);
  o.rows = clampInt(finite(o.rows, 1), 1, 10);
  o.stepX = Math.max(1, finite(o.stepX, source.w + 2));
  o.stepY = Math.max(1, finite(o.stepY, source.h + 2));
  o.railWidth = Math.max(0, Math.min(30, finite(o.railWidth, 0)));
  o.toolingHoleDia = Math.max(0.5, Math.min(10, finite(o.toolingHoleDia, 3.2)));
  o.tabWidth = Math.max(2, Math.min(20, finite(o.tabWidth, 5)));
  o.mouseBiteDia = Math.max(0.2, Math.min(2, finite(o.mouseBiteDia, 0.5)));
  o.mouseBitePitch = Math.max(o.mouseBiteDia + 0.1, Math.min(5, finite(o.mouseBitePitch, 0.8)));

  const outlines = sourceLoops(source);
  const board = boardShape(source);
  const [bx1, by1, bx2, by2] = board.bounds;
  const bw = bx2 - bx1, bh = by2 - by1;
  const gapX = o.stepX - bw, gapY = o.stepY - bh;
  const warnings: string[] = [];
  if (board.fallback) warnings.push('Не найден закрытый контур; панель построена по рабочему полю платы.');
  if (o.cols > 1 && gapX < -0.05) warnings.push(`Шаг X меньше габарита платы на ${(-gapX).toFixed(2)} мм: соседние платы перекрываются.`);
  if (o.rows > 1 && gapY < -0.05) warnings.push(`Шаг Y меньше габарита платы на ${(-gapY).toFixed(2)} мм: соседние платы перекрываются.`);
  if (o.breakawayTabs && ((o.cols > 1 && gapX <= 0.05) || (o.rows > 1 && gapY <= 0.05)))
    warnings.push('Для breakaway-tabs нужен положительный зазор между платами; увеличьте шаг X/Y.');
  if (o.breakawayTabs && ((o.cols > 1 && gapX > 0.05 && gapX < o.mouseBiteDia + 0.1)
    || (o.rows > 1 && gapY > 0.05 && gapY < o.mouseBiteDia + 0.1)))
    warnings.push('Зазор между платами слишком мал для выбранного диаметра mouse-bite; отверстия могут пересечь контур.');
  if (o.toolingHoles && o.railWidth > 0 && o.railWidth < o.toolingHoleDia + 0.8)
    warnings.push('Ширина рейки мала для выбранного диаметра отверстий оснастки; проверьте, помещаются ли сверления.');
  if (o.breakawayTabs && (o.vCutColumns || o.vCutRows))
    warnings.push('Breakaway-tabs и V-cut включены одновременно; не размещайте эти технологии на одной линии разделения.');
  if ((o.vCutColumns && o.cols > 1 && gapX > 0.5) || (o.vCutRows && o.rows > 1 && gapY > 0.5))
    warnings.push('V-cut обычно применяется при соприкасающихся платах; для заметного зазора линии V-cut не добавлены.');

  const next = cloneDoc(source);
  const sourceOutlineIds = new Set(source.entities.filter((e) => 'layer' in e && e.layer === 'outline').map((e) => e.id));
  next.entities = source.entities.filter((e) => !sourceOutlineIds.has(e.id));
  const baseEntities = next.entities.slice();
  const copyGroups: Group[] = [];
  for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.cols; c++) {
    if (r === 0 && c === 0) continue;
    const dx = c * o.stepX, dy = r * o.stepY;
    const idMap = new Map<string, string>();
    const tile = r * o.cols + c + 1;
    for (const entity of baseEntities) {
      const copy = copyEntity(entity, dx, dy);
      if (copy.kind === 'comp' && copy.ref) copy.ref = `${copy.ref}_P${tile}`;
      next.entities.push(copy);
      idMap.set(entity.id, copy.id);
    }
    copyGroups.push(...remapGroups(source.groups, idMap, ` · ячейка ${tile}`));
  }
  if (copyGroups.length) next.groups = [...(next.groups ?? []), ...copyGroups];

  // For tabbed panels omit short contour segments on aligned internal edges.
  for (let r = 0; r < o.rows; r++) for (let c = 0; c < o.cols; c++) {
    const gaps: EdgeGap[] = [];
    if (o.breakawayTabs && gapX > 0.05) {
      const centers = [1 / 3, 2 / 3].map((frac) => by1 + bh * frac);
      for (const center of centers) {
        if (c > 0) gaps.push([center - o.tabWidth / 2, center + o.tabWidth / 2, 'y', bx1]);
        if (c < o.cols - 1) gaps.push([center - o.tabWidth / 2, center + o.tabWidth / 2, 'y', bx2]);
      }
    }
    if (o.breakawayTabs && gapY > 0.05) {
      const centers = [1 / 3, 2 / 3].map((frac) => bx1 + bw * frac);
      for (const center of centers) {
        if (r > 0) gaps.push([center - o.tabWidth / 2, center + o.tabWidth / 2, 'x', by1]);
        if (r < o.rows - 1) gaps.push([center - o.tabWidth / 2, center + o.tabWidth / 2, 'x', by2]);
      }
    }
    for (const spec of outlines) {
      // Вырезы остаются целыми; tabs ставятся только на внешней границе материала.
      next.entities.push(...outlineLines(spec.points, c * o.stepX, r * o.stepY, spec.hole ? [] : gaps));
    }
  }

  const panelMinX = bx1, panelMinY = by1;
  const panelMaxX = bx2 + (o.cols - 1) * o.stepX, panelMaxY = by2 + (o.rows - 1) * o.stepY;
  const railBounds = o.railWidth > 0 ? {
    x: panelMinX - o.railWidth, y: panelMinY - o.railWidth,
    w: panelMaxX - panelMinX + 2 * o.railWidth, h: panelMaxY - panelMinY + 2 * o.railWidth,
  } : undefined;
  const panelFeatureIds: string[] = [];

  // Two tabs on each horizontal/vertical seam, with a row of drill bites in each tab.
  if (o.breakawayTabs && gapX > 0.05) for (let c = 0; c < o.cols - 1; c++) for (const frac of [1 / 3, 2 / 3]) {
    const centerY = by1 + bh * frac;
    const holes = Math.max(2, Math.floor(o.tabWidth / o.mouseBitePitch) + 1);
    for (let i = 0; i < holes; i++) pushHole(next.entities,
      bx2 + c * o.stepX + gapX / 2,
      centerY - o.tabWidth / 2 + (holes === 1 ? 0 : i * o.tabWidth / (holes - 1)), o.mouseBiteDia, panelFeatureIds);
  }
  if (o.breakawayTabs && gapY > 0.05) for (let r = 0; r < o.rows - 1; r++) for (const frac of [1 / 3, 2 / 3]) {
    const centerX = bx1 + bw * frac;
    const holes = Math.max(2, Math.floor(o.tabWidth / o.mouseBitePitch) + 1);
    for (let i = 0; i < holes; i++) pushHole(next.entities,
      centerX - o.tabWidth / 2 + (holes === 1 ? 0 : i * o.tabWidth / (holes - 1)),
      by2 + r * o.stepY + gapY / 2, o.mouseBiteDia, panelFeatureIds);
  }

  if (o.toolingHoles && o.railWidth > 0) {
    const offset = Math.min(o.railWidth / 2, Math.max(o.toolingHoleDia / 2 + 0.4, 1.5));
    for (const [x, y] of [
      [panelMinX - offset, panelMinY - offset], [panelMaxX + offset, panelMinY - offset],
      [panelMaxX + offset, panelMaxY + offset], [panelMinX - offset, panelMaxY + offset],
    ]) pushHole(next.entities, x, y, o.toolingHoleDia, panelFeatureIds);
  }
  if (o.fiducials && o.railWidth > 0) {
    const inset = Math.min(o.railWidth / 2, 2.2);
    const spots: Pt[] = [
      { x: panelMinX - inset, y: panelMaxY + inset },
      { x: panelMaxX + inset, y: panelMaxY + inset },
      { x: panelMinX - inset, y: panelMinY - inset },
    ];
    for (const p of spots) {
      const fid = { id: uid(), kind: 'pad' as const, x: p.x, y: p.y, shape: 'round' as const, size: 1, drill: 0 };
      const silk = { id: uid(), kind: 'circle' as const, x: p.x, y: p.y, r: 1.6, w: 0.12, layer: 's1' as const };
      next.entities.push(fid, silk);
      panelFeatureIds.push(fid.id, silk.id);
    }
  }

  const vCuts: PanelInfo['vCuts'] = [];
  if (o.vCutColumns && o.cols > 1 && gapX <= 0.5) for (let c = 0; c < o.cols - 1; c++) {
    const x = (bx2 + c * o.stepX + bx1 + (c + 1) * o.stepX) / 2;
    vCuts.push({ x1: x, y1: panelMinY - o.railWidth, x2: x, y2: panelMaxY + o.railWidth });
  }
  if (o.vCutRows && o.rows > 1 && gapY <= 0.5) for (let r = 0; r < o.rows - 1; r++) {
    const y = (by2 + r * o.stepY + by1 + (r + 1) * o.stepY) / 2;
    vCuts.push({ x1: panelMinX - o.railWidth, y1: y, x2: panelMaxX + o.railWidth, y2: y });
  }
  next.panelInfo = {
    cols: o.cols, rows: o.rows,
    breakawayTabs: o.breakawayTabs && ((o.cols > 1 && gapX > 0.05) || (o.rows > 1 && gapY > 0.05)),
    vCuts, ...(railBounds ? { railBounds } : {}), featureIds: panelFeatureIds,
  };
  next.name = `${source.name} · панель ${o.cols}×${o.rows}`;
  next.w = Math.max(source.w, panelMaxX - panelMinX + 2 * o.railWidth);
  next.h = Math.max(source.h, panelMaxY - panelMinY + 2 * o.railWidth);
  return { doc: next, warnings };
}
