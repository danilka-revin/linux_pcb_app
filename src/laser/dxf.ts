// Точный экспорт и импорт AutoCAD DXF для лазерного редактора.
//
// Задача модуля — сохранить геометрию развёртки в DXF без потерь:
//  · окружности и дуги остаются окружностями и дугами (CIRCLE / ARC), а не ломаными;
//  · скругления прямоугольников пишутся дугами через bulge (математически точно);
//  · кривые Безье — сплайном SPLINE с исходными контрольными точками (R2000)
//    либо адаптивной ломаной с заданным допуском отклонения (R12);
//  · единицы — миллиметры 1:1 ($INSUNITS=4, $MEASUREMENT=1), координаты с
//    задаваемой точностью и без экспоненциальной записи;
//  · слои станка (CUT/INNER/FOLD/SCORE/ENGRAVE) с цветами ACI, типами линий и
//    корректными $EXTMIN/$EXTMAX, чтобы файл открывался сразу в масштабе 1:1.
//
// Файл рассчитан на AutoCAD, CorelDRAW, RDWorks, CypCut, LightBurn, Inkscape и
// LibreCAD. Обратный импорт читает тот же набор примитивов, поэтому точность
// можно проверить круговым тестом (measureDxfAccuracy) прямо в интерфейсе.

import {
  LASER_LAYER_ORDER,
  applyTabs as applyTabsCore,
  dashPolyline,
  kerfShapes,
  rotPt,
  shapeToPolylines,
  type LaserDoc,
  type LaserLayerId,
  type LaserShape,
  type PathNode,
  type Pt,
} from './model';
import { textPolylines } from '../pcb/strokefont';

// ---------------- примитивы ----------------

export interface PolyPt {
  x: number;
  y: number;
  /** bulge = tan(угол/4): дуга от этой точки к следующей (0/undefined — отрезок) */
  b?: number;
}

export type DxfPrim =
  | { t: 'line'; a: Pt; b: Pt }
  | { t: 'circle'; c: Pt; r: number }
  | { t: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { t: 'ellipse'; c: Pt; rx: number; ry: number; rot: number; a0: number; a1: number }
  | { t: 'spline'; controls: Pt[]; knots: number[]; degree: number }
  | { t: 'poly'; pts: PolyPt[]; closed: boolean }
  | { t: 'text'; pos: Pt; height: number; value: string; rot: number };

export interface DxfGeom {
  layer: LaserLayerId;
  name: string;
  prims: DxfPrim[];
}

// ---------------- настройки экспорта ----------------

export type DxfVersion = 'R12' | 'R2000';
export type DxfEntityMode = 'auto' | 'exact' | 'polyline' | 'lines';
export type DxfOrigin = 'sheet' | 'bbox' | 'center' | 'zero';
export type DxfLayerMode = 'laser' | 'single' | 'objects';
export type DxfFoldDash = 'segments' | 'linetype' | 'solid';

export interface DxfOptions {
  /** Версия формата: R12 (AC1009) — максимум совместимости, R2000 (AC1015) — полный DXF */
  version: DxfVersion;
  /** Как писать геометрию: exact — дуги/сплайны, polyline — полилинии, lines — только отрезки */
  entities: DxfEntityMode;
  /** Единицы файла */
  units: 'mm' | 'inch';
  /** Знаков после запятой в координатах */
  precision: number;
  /** Масштаб вывода (1 = 1:1) */
  scale: number;
  /** Ноль координат: угол листа / габарит деталей / центр / (0;0) без сдвига */
  origin: DxfOrigin;
  /** Инверсия Y (для программ с отсчётом сверху) */
  flipY: boolean;
  /** Допуск аппроксимации кривых, мм (меньше — точнее и больше точек) */
  tolerance: number;
  /** Слои: слои станка / один слой / по именам объектов */
  layers: DxfLayerMode;
  /** Имя единственного слоя при layers='single' */
  singleLayer: string;
  /** Цвета: индекс AutoCAD (ACI) / точный RGB (код 420) / ByLayer */
  colors: 'aci' | 'truecolor' | 'bylayer';
  /** Пунктир слоя сгиба: физическими штрихами / типом линии DASHED / сплошной */
  foldDash: DxfFoldDash;
  /** Компенсация толщины луча (kerf) на слоях резки */
  kerf: boolean;
  /** Удерживающие перемычки (holding tabs) */
  tabs: boolean;
  /** Экспортировать скрытые объекты */
  includeHidden: boolean;
  /** Экспортировать служебный слой размеров и направляющих */
  includeGuide: boolean;
  /** Склеивать дубли точек в пределах допуска, мм (0 = не склеивать) */
  weld: number;
  /** Писать текст объектом TEXT (иначе — штриховыми контурами) */
  textAsEntity: boolean;
  /** Повторяющиеся детали оформлять блоками BLOCK/INSERT */
  blocks: boolean;
  /** Комментарий в шапке файла */
  comment: string;
}

export const DEFAULT_DXF_OPTIONS: DxfOptions = {
  version: 'R2000',
  entities: 'auto',
  units: 'mm',
  precision: 6,
  scale: 1,
  origin: 'sheet',
  flipY: false,
  tolerance: 0.01,
  layers: 'laser',
  singleLayer: 'LASER',
  colors: 'aci',
  foldDash: 'segments',
  kerf: false,
  tabs: true,
  includeHidden: false,
  includeGuide: false,
  weld: 0.001,
  textAsEntity: false,
  blocks: false,
  comment: '',
};

/** Нормализация настроек: защита от нуля, отрицательного масштаба и безумной точности. */
export function normalizeDxfOptions(o: Partial<DxfOptions> = {}): DxfOptions {
  const base: DxfOptions = { ...DEFAULT_DXF_OPTIONS, ...o };
  base.precision = Math.max(1, Math.min(9, Math.round(Number(base.precision) || 6)));
  base.scale = Number.isFinite(base.scale) && base.scale > 0 ? Math.min(1000, base.scale) : 1;
  base.tolerance = Number.isFinite(base.tolerance) ? Math.max(0.0005, Math.min(5, base.tolerance)) : 0.01;
  base.weld = Number.isFinite(base.weld) ? Math.max(0, Math.min(1, base.weld)) : 0.001;
  base.units = base.units === 'inch' ? 'inch' : 'mm';
  base.version = base.version === 'R12' ? 'R12' : 'R2000';
  return base;
}

// ---------------- цвета AutoCAD ----------------

/** Палитра AutoCAD Color Index (ACI): базовые цвета, цветовое колесо и серая шкала. */
const ACI_TABLE: [number, number, number, number][] = [
  [1, 255, 0, 0], [2, 255, 255, 0], [3, 0, 255, 0], [4, 0, 255, 255],
  [5, 0, 0, 255], [6, 255, 0, 255], [7, 255, 255, 255], [8, 66, 66, 66],
  [9, 128, 128, 128],
  [10, 255, 0, 0], [20, 255, 63, 63], [30, 255, 127, 127], [40, 255, 191, 191],
  [11, 255, 63, 0], [21, 255, 127, 63], [31, 255, 159, 127], [41, 255, 191, 159],
  [12, 255, 127, 0], [22, 255, 191, 63], [32, 255, 207, 127], [42, 255, 223, 159],
  [13, 255, 191, 0], [23, 255, 223, 63], [33, 255, 239, 127], [43, 255, 247, 159],
  [14, 255, 255, 0], [24, 255, 255, 63], [34, 255, 255, 127], [44, 255, 255, 159],
  [15, 191, 255, 0], [25, 223, 255, 63], [35, 239, 255, 127], [45, 247, 255, 159],
  [16, 127, 255, 0], [26, 191, 255, 63], [36, 223, 255, 127], [46, 239, 255, 159],
  [17, 63, 255, 0], [27, 159, 255, 63], [37, 207, 255, 127], [47, 223, 255, 159],
  [18, 0, 255, 0], [28, 63, 255, 63], [38, 127, 255, 127], [48, 159, 255, 159],
  [19, 0, 255, 63], [29, 63, 255, 127], [39, 127, 255, 159], [49, 159, 255, 191],
  [120, 0, 255, 127], [130, 63, 255, 159], [140, 0, 255, 191], [150, 63, 255, 223],
  [160, 0, 255, 255], [170, 63, 255, 255], [180, 0, 191, 255], [190, 63, 223, 255],
  [200, 0, 127, 255], [210, 63, 159, 255], [220, 0, 63, 255], [230, 63, 127, 255],
  [240, 0, 0, 255], [250, 63, 63, 255],
  [251, 51, 51, 51], [252, 91, 91, 91], [253, 132, 132, 132], [254, 173, 173, 173],
  [255, 214, 214, 214],
];

/** Ближайший индекс цвета AutoCAD (ACI) к цвету #rrggbb. */
export function hexToAci(hex: string): number {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return 7;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  let best = 7;
  let bestD = Infinity;
  for (const [aci, cr, cg, cb] of ACI_TABLE) {
    // Взвешенное расстояние: глаз чувствительнее к зелёному
    const d = 0.3 * (r - cr) ** 2 + 0.59 * (g - cg) ** 2 + 0.11 * (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = aci; }
  }
  return best;
}

/** Цвет как 24-битное значение для кода 420 (точный RGB в R2000). */
export function hexToTrueColor(hex: string): number {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return 0xffffff;
  return (parseInt(m[1], 16) << 16) | (parseInt(m[2], 16) << 8) | parseInt(m[3], 16);
}

/** Индексы ACI слоёв станка: красный — резка, как принято в RDWorks/CypCut. */
export const LAYER_ACI: Record<LaserLayerId, number> = {
  cut: 1,
  inner: 6,
  fold: 3,
  score: 5,
  engrave: 2,
  guide: 8,
};

export const DXF_LAYER_NAMES: Record<LaserLayerId, string> = {
  cut: 'CUT',
  inner: 'INNER',
  fold: 'FOLD',
  score: 'SCORE',
  engrave: 'ENGRAVE',
  guide: 'GUIDE',
};

/** Имя слоя DXF по слою станка (учитывает режим «один слой» и «по объектам»). */
export function sanitizeLayerName(name: string): string {
  const translit: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const ascii = name
    .toLowerCase()
    .split('')
    .map((ch) => (translit[ch] !== undefined ? translit[ch] : ch))
    .join('');
  const clean = ascii
    .replace(/[<>\/\\":;?*|=,`]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (clean || 'LAYER').slice(0, 64).toUpperCase();
}

// ---------------- математика кривых ----------------

const cubicAt = (p0: number, p1: number, p2: number, p3: number, t: number) => {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
};

/**
 * Адаптивная аппроксимация кубической кривой Безье: деление пополам, пока
 * отклонение средней точки кривой от хорды больше допуска tol (мм).
 * Возвращает точки без начальной.
 */
export function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, tol: number, depth = 0): Pt[] {
  // Отклонение проверяем в трёх точках (1/4, 1/2, 3/4): у симметричной S-кривой
  // середина совпадает с серединой хорды, и одна проверка дала бы прямую вместо кривой.
  const cx = p3.x - p0.x, cy = p3.y - p0.y;
  const chord2 = cx * cx + cy * cy || 1e-12;
  let dev = 0;
  for (const t of [0.25, 0.5, 0.75]) {
    const qx = cubicAt(p0.x, p1.x, p2.x, p3.x, t);
    const qy = cubicAt(p0.y, p1.y, p2.y, p3.y, t);
    const k = ((qx - p0.x) * cx + (qy - p0.y) * cy) / chord2;
    const d = Math.hypot(qx - (p0.x + cx * k), qy - (p0.y + cy * k));
    if (d > dev) dev = d;
  }
  if (depth >= 14 || dev <= tol) return [{ x: p3.x, y: p3.y }];
  // Де Кастельжо: деление кривой пополам
  const a = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const c = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
  const ab = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const bc = { x: (b.x + c.x) / 2, y: (b.y + c.y) / 2 };
  const m = { x: (ab.x + bc.x) / 2, y: (ab.y + bc.y) / 2 };
  return [...flattenCubic(p0, a, ab, m, tol, depth + 1), ...flattenCubic(m, bc, c, p3, tol, depth + 1)];
}

/** Адаптивная аппроксимация дуги эллипса (углы в радианах) с допуском tol, мм. */
export function flattenArc(
  c: Pt, rx: number, ry: number, rotDeg: number, a0: number, a1: number, tol: number, includeStart = false
): Pt[] {
  const sweep = Math.abs(a1 - a0);
  if (sweep < 1e-12) return [];
  const rMax = Math.max(Math.abs(rx), Math.abs(ry)) || 1e-6;
  const ratio = Math.max(-1, Math.min(1, 1 - Math.max(tol, 1e-7) / rMax));
  const stepMax = ratio >= 1 ? Math.PI / 4 : 2 * Math.acos(ratio);
  const n = Math.max(2, Math.min(4096, Math.ceil(sweep / Math.max(stepMax, 1e-5))));
  const pts: Pt[] = [];
  for (let i = includeStart ? 0 : 1; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    const p = { x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) };
    pts.push(rotDeg ? rotPt(p, c.x, c.y, rotDeg) : p);
  }
  return pts;
}

/** Цепочка узлов PathNode → точки с адаптивной точностью (кривые Безье). */
export function flattenNodes(nodes: PathNode[], closed: boolean, tol: number): Pt[] {
  if (!nodes.length) return [];
  if (nodes.length === 1) return [{ x: nodes[0].x, y: nodes[0].y }];
  const pts: Pt[] = [{ x: nodes[0].x, y: nodes[0].y }];
  const seg = (a: PathNode, b: PathNode) => {
    const hasCp =
      (a.cp2x !== undefined && a.cp2y !== undefined) || (b.cp1x !== undefined && b.cp1y !== undefined);
    if (!hasCp) {
      pts.push({ x: b.x, y: b.y });
      return;
    }
    pts.push(
      ...flattenCubic(
        { x: a.x, y: a.y },
        { x: a.cp2x ?? a.x, y: a.cp2y ?? a.y },
        { x: b.cp1x ?? b.x, y: b.cp1y ?? b.y },
        { x: b.x, y: b.y },
        tol
      )
    );
  };
  for (let i = 0; i < nodes.length - 1; i++) seg(nodes[i], nodes[i + 1]);
  if (closed && nodes.length > 2) seg(nodes[nodes.length - 1], nodes[0]);
  return pts;
}

/** Есть ли в цепочке узлов кривые Безье. */
function hasBezier(nodes: PathNode[], closed: boolean): boolean {
  const segCount = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    if (a.cp2x !== undefined || a.cp2y !== undefined || b.cp1x !== undefined || b.cp1y !== undefined) return true;
  }
  return false;
}

/** bulge дуги в 90° (скругление прямоугольника): tan(90°/4). */
export const BULGE_90 = Math.tan(Math.PI / 8);

/** Вектор узлов сплайна для цепочки из n кубических сегментов Безье (точное воспроизведение). */
export function bezierKnots(segments: number): number[] {
  const knots: number[] = [0, 0, 0, 0];
  for (let i = 1; i < segments; i++) knots.push(i, i, i);
  knots.push(segments, segments, segments, segments);
  return knots;
}

/**
 * Точное преобразование bulge → параметры дуги.
 * bulge = tan(θ/4), знак задаёт направление обхода (плюс — против часовой).
 */
export function bulgeToArc(a: Pt, b: Pt, bulge: number): { c: Pt; r: number; a0: number; a1: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(bulge) < 1e-12) return null;
  const theta = 4 * Math.atan(bulge);
  const rSigned = chord / (2 * Math.sin(theta / 2));
  const r = Math.abs(rSigned);
  const ux = dx / chord, uy = dy / chord;
  const nx = -uy, ny = ux; // левая нормаль к хорде
  const d = rSigned * Math.cos(theta / 2);
  const c = { x: (a.x + b.x) / 2 + nx * d, y: (a.y + b.y) / 2 + ny * d };
  const norm = (deg: number) => ((deg % 360) + 360) % 360;
  const ang = (p: Pt) => norm((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
  // DXF ARC всегда идёт против часовой: для «отрицательной» дуги меняем концы местами
  const from = bulge > 0 ? ang(a) : ang(b);
  const sweepDeg = (Math.abs(theta) * 180) / Math.PI;
  return { c, r, a0: from, a1: norm(from + sweepDeg) };
}

/** Приведение углов дуги к обходу против часовой (a1 > a0), как требует DXF. */
export function normalizeArcAngles(a0: number, a1: number): [number, number] {
  const from = ((a0 % 360) + 360) % 360;
  let to = ((a1 % 360) + 360) % 360;
  if (to <= from) to += 360;
  return [from, to];
}

/** Разворот полилинии с bulge в точки (дуги аппроксимируются с допуском tol). */
export function polyToPoints(pts: PolyPt[], closed: boolean, tol: number): Pt[] {
  if (!pts.length) return [];
  const out: Pt[] = [{ x: pts[0].x, y: pts[0].y }];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    if (!q) continue;
    if (p.b && Math.abs(p.b) > 1e-12) {
      const arc = bulgeToArc({ x: p.x, y: p.y }, { x: q.x, y: q.y }, p.b);
      if (arc) {
        const theta = 4 * Math.atan(p.b);
        const a0 = (Math.atan2(p.y - arc.c.y, p.x - arc.c.x));
        out.push(...flattenArc(arc.c, arc.r, arc.r, 0, a0, a0 + theta, Math.max(tol, 1e-4)));
        continue;
      }
    }
    out.push({ x: q.x, y: q.y });
  }
  return out;
}

// ---------------- извлечение геометрии ----------------

/** Прямоугольник (в т.ч. скруглённый) как полилиния с точными дугами углов. */
function rectPoly(shape: Extract<LaserShape, { kind: 'rect' }>): DxfPrim {
  const { x, y, w, h, rot } = shape;
  const r = Math.max(0, Math.min(shape.rx || 0, Math.min(Math.abs(w), Math.abs(h)) / 2));
  const cx = x + w / 2, cy = y + h / 2;
  let pts: PolyPt[];
  if (r <= 1e-6) {
    pts = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  } else {
    // Обход против часовой; bulge стоит на вершине, из которой начинается дуга
    pts = [
      { x: x + r, y },
      { x: x + w - r, y, b: BULGE_90 },
      { x: x + w, y: y + r },
      { x: x + w, y: y + h - r, b: BULGE_90 },
      { x: x + w - r, y: y + h },
      { x: x + r, y: y + h, b: BULGE_90 },
      { x, y: y + h - r },
      { x, y: y + r, b: BULGE_90 },
    ];
  }
  if (rot) pts = pts.map((p) => { const q = rotPt(p, cx, cy, rot); return { x: q.x, y: q.y, b: p.b }; });
  return { t: 'poly', pts, closed: true };
}

function ellipsePrims(shape: Extract<LaserShape, { kind: 'ellipse' }>, exact: boolean, tol: number): DxfPrim[] {
  const { cx, cy, rx, ry, rot } = shape;
  const deg0 = shape.startAngle ?? 0;
  const deg1 = shape.endAngle ?? 360;
  const full = Math.abs(Math.abs(deg1 - deg0) - 360) < 1e-6;
  const round = Math.abs(Math.abs(rx) - Math.abs(ry)) < 1e-9;
  if (round && full) return [{ t: 'circle', c: { x: cx, y: cy }, r: Math.abs(rx) }];
  if (round) return [{ t: 'arc', c: { x: cx, y: cy }, r: Math.abs(rx), a0: deg0 + rot, a1: deg1 + rot }];
  if (exact) {
    return [{ t: 'ellipse', c: { x: cx, y: cy }, rx: Math.abs(rx), ry: Math.abs(ry), rot, a0: deg0, a1: deg1 }];
  }
  const a0 = (deg0 * Math.PI) / 180;
  const a1 = (deg1 * Math.PI) / 180;
  const pts = flattenArc({ x: cx, y: cy }, rx, ry, rot, a0, full ? a0 + Math.PI * 2 : a1, tol, true);
  return [{ t: 'poly', pts: pts.map((p) => ({ x: p.x, y: p.y })), closed: full }];
}

function polygonPrim(shape: Extract<LaserShape, { kind: 'polygon' }>): DxfPrim {
  const pls = shapeToPolylines(shape);
  const pts = (pls[0] ?? []).map((p) => ({ x: p.x, y: p.y }));
  if (pts.length > 1) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) pts.pop();
  }
  return { t: 'poly', pts, closed: true };
}

/** Кривая Безье → SPLINE с исходными контрольными точками (точное представление). */
function pathSpline(nodes: PathNode[], closed: boolean): DxfPrim | null {
  const segCount = closed ? nodes.length : nodes.length - 1;
  if (segCount < 1) return null;
  const controls: Pt[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    if (i === 0) controls.push({ x: a.x, y: a.y });
    controls.push({ x: a.cp2x ?? a.x, y: a.cp2y ?? a.y });
    controls.push({ x: b.cp1x ?? b.x, y: b.cp1y ?? b.y });
    controls.push({ x: b.x, y: b.y });
  }
  return { t: 'spline', controls, knots: bezierKnots(segCount), degree: 3 };
}

function pathPrims(shape: Extract<LaserShape, { kind: 'path' }>, opts: DxfOptions, exact: boolean): DxfPrim[] {
  const out: DxfPrim[] = [];
  const chain = (nodes: PathNode[], closed: boolean) => {
    if (!nodes || nodes.length < 2) return;
    if (opts.entities === 'exact' && opts.version === 'R2000' && hasBezier(nodes, closed)) {
      const sp = pathSpline(nodes, closed);
      if (sp) { out.push(sp); return; }
    }
    const pts = flattenNodes(nodes, closed, opts.tolerance);
    if (pts.length < 2) return;
    out.push({ t: 'poly', pts: pts.map((p) => ({ x: p.x, y: p.y })), closed });
  };
  chain(shape.nodes, shape.closed);
  for (const h of shape.holes ?? []) chain(h, true);
  return out;
}

function textPrims(shape: Extract<LaserShape, { kind: 'text' }>, opts: DxfOptions): DxfPrim[] {
  if (opts.textAsEntity) {
    return [{
      t: 'text',
      pos: { x: shape.x, y: shape.y },
      height: Math.max(0.4, shape.size),
      value: shape.text || '',
      rot: shape.mirror ? 180 - (shape.rot || 0) : shape.rot || 0,
    }];
  }
  const a = ((shape.rot || 0) * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const prims: DxfPrim[] = [];
  for (const seg of textPolylines(shape.text || '')) {
    if (seg.length < 2) continue;
    const map = (p: { x: number; y: number }): Pt => {
      const lx = (shape.mirror ? -p.x : p.x) * (shape.size / 10);
      const ly = p.y * (shape.size / 10);
      return { x: shape.x + lx * ca - ly * sa, y: shape.y + lx * sa + ly * ca };
    };
    prims.push({ t: 'line', a: map(seg[0]), b: map(seg[seg.length - 1]) });
  }
  return prims;
}

function dimPrims(shape: Extract<LaserShape, { kind: 'dim' }>, opts: DxfOptions): DxfPrim[] {
  const { x1, y1, x2, y2, offset } = shape;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const p1 = { x: x1 + nx * offset, y: y1 + ny * offset };
  const p2 = { x: x2 + nx * offset, y: y2 + ny * offset };
  const prims: DxfPrim[] = [
    { t: 'line', a: { x: x1, y: y1 }, b: p1 },
    { t: 'line', a: { x: x2, y: y2 }, b: p2 },
    { t: 'line', a: p1, b: p2 },
  ];
  if (shape.label && opts.textAsEntity) {
    prims.push({
      t: 'text',
      pos: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
      height: Math.max(1.5, Math.min(4, len / 20)),
      value: shape.label,
      rot: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return prims;
}

/** Точные примитивы одного объекта (без kerf, перемычек и пунктира). */
export function shapePrims(shape: LaserShape, opts: DxfOptions): DxfPrim[] {
  const exact = opts.entities === 'exact' || opts.entities === 'auto';
  switch (shape.kind) {
    case 'rect': {
      if (opts.entities === 'exact' && (shape.rx || 0) <= 1e-6 && !shape.rot) {
        const { x, y, w, h } = shape;
        const c = [
          { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h },
        ];
        return [0, 1, 2, 3].map((i) => ({ t: 'line', a: c[i], b: c[(i + 1) % 4] }));
      }
      return [rectPoly(shape)];
    }
    case 'ellipse':
      return ellipsePrims(shape, exact && opts.version === 'R2000', opts.tolerance);
    case 'polygon':
      return [polygonPrim(shape)];
    case 'path':
      return pathPrims(shape, opts, exact && opts.entities !== 'lines');
    case 'text':
      return textPrims(shape, opts);
    case 'dim':
      return dimPrims(shape, opts);
  }
}

/** Любой примитив → ломаные (для kerf, перемычек, замеров и режима «только отрезки»). */
export function primToPolylines(prim: DxfPrim, tol: number): { pts: Pt[]; closed: boolean }[] {
  switch (prim.t) {
    case 'line':
      return [{ pts: [prim.a, prim.b], closed: false }];
    case 'circle': {
      const pts = flattenArc(prim.c, prim.r, prim.r, 0, 0, Math.PI * 2, tol, true);
      return [{ pts, closed: true }];
    }
    case 'arc': {
      const [d0, d1] = normalizeArcAngles(prim.a0, prim.a1);
      return [{
        pts: flattenArc(prim.c, prim.r, prim.r, 0, (d0 * Math.PI) / 180, (d1 * Math.PI) / 180, tol, true),
        closed: false,
      }];
    }
    case 'ellipse': {
      const full = Math.abs(Math.abs(prim.a1 - prim.a0) - 360) < 1e-6;
      const [d0, d1] = full ? [prim.a0, prim.a0 + 360] : normalizeArcAngles(prim.a0, prim.a1);
      return [{
        pts: flattenArc(prim.c, prim.rx, prim.ry, prim.rot, (d0 * Math.PI) / 180, (d1 * Math.PI) / 180, tol, true),
        closed: full,
      }];
    }
    case 'poly':
      return [{ pts: polyToPoints(prim.pts, prim.closed, tol), closed: prim.closed }];
    case 'spline': {
      const out: Pt[] = [];
      const n = Math.floor((prim.controls.length - 1) / 3);
      for (let s = 0; s < n; s++) {
        const p0 = prim.controls[s * 3];
        const p1 = prim.controls[s * 3 + 1];
        const p2 = prim.controls[s * 3 + 2];
        const p3 = prim.controls[s * 3 + 3];
        if (!p0 || !p1 || !p2 || !p3) continue;
        if (!out.length) out.push(p0);
        out.push(...flattenCubic(p0, p1, p2, p3, tol));
      }
      return [{ pts: out, closed: false }];
    }
    case 'text':
      return [];
  }
}

// ---------------- пунктир и перемычки ----------------
// Реализация общая с рендером, G-Code и симуляцией (model.ts): маркеры перемычек
// на холсте стоят ровно там, где станок оставит недорез.

/** Разбиение ломаной на штрихи (перфорация сгиба / удерживающие перемычки). */
export function dashPolylines(pts: Pt[], dashLen: number, gapLen: number): Pt[][] {
  return dashPolyline(pts, dashLen, gapLen);
}

/** Перемычки: замкнутый контур режется участками, между ними материал остаётся. */
export function applyTabs(pts: Pt[], count: number, width: number): Pt[][] {
  if (pts.length < 3) return [pts];
  return applyTabsCore(pts, count, width, true);
}

// ---------------- сборка геометрии документа ----------------

/** Объекты, которые попадут в файл (видимость слоёв, скрытые объекты, служебный слой). */
export function visibleShapes(doc: LaserDoc, opts: DxfOptions): LaserShape[] {
  return doc.shapes.filter((s) => {
    if (s.hidden && !opts.includeHidden) return false;
    const cfg = doc.layers[s.layer];
    if (!cfg?.visible) return false;
    if (s.layer === 'guide' && !opts.includeGuide) return false;
    return true;
  });
}

/** Сдвиг, масштаб и инверсия Y всех примитивов. */
function transformPrims(prims: DxfPrim[], dx: number, dy: number, k: number, flipY: boolean, frameH: number): DxfPrim[] {
  // Инверсия Y зеркалит геометрию относительно верха кадра (лист/габарит),
  // поэтому детали остаются в положительных координатах.
  const T = (p: Pt): Pt => ({ x: (p.x + dx) * k, y: (flipY ? frameH - (p.y + dy) : p.y + dy) * k });
  const out: DxfPrim[] = [];
  for (const pr of prims) {
    switch (pr.t) {
      case 'line': out.push({ t: 'line', a: T(pr.a), b: T(pr.b) }); break;
      case 'circle': out.push({ t: 'circle', c: T(pr.c), r: pr.r * k }); break;
      case 'arc':
        out.push({ t: 'arc', c: T(pr.c), r: pr.r * k, a0: flipY ? -pr.a1 : pr.a0, a1: flipY ? -pr.a0 : pr.a1 });
        break;
      case 'ellipse':
        out.push({
          t: 'ellipse', c: T(pr.c), rx: pr.rx * k, ry: pr.ry * k,
          rot: flipY ? -pr.rot : pr.rot, a0: flipY ? -pr.a1 : pr.a0, a1: flipY ? -pr.a0 : pr.a1,
        });
        break;
      case 'spline': out.push({ t: 'spline', controls: pr.controls.map(T), knots: pr.knots, degree: pr.degree }); break;
      case 'poly':
        out.push({
          t: 'poly',
          pts: pr.pts.map((p) => { const q = T(p); return { x: q.x, y: q.y, b: flipY ? -(p.b ?? 0) : p.b }; }),
          closed: pr.closed,
        });
        break;
      case 'text':
        out.push({ t: 'text', pos: T(pr.pos), height: pr.height * k, value: pr.value, rot: flipY ? -pr.rot : pr.rot });
        break;
    }
  }
  return out;
}

/** Габарит набора примитивов (с раскрытием дуг и сплайнов). */
export function primsBBox(prims: DxfPrim[], tol: number): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (p: Pt) => {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  };
  for (const pr of prims) {
    if (pr.t === 'text') {
      add(pr.pos);
      add({ x: pr.pos.x + pr.value.length * pr.height * 0.62, y: pr.pos.y + pr.height });
      continue;
    }
    if (pr.t === 'circle') {
      add({ x: pr.c.x - pr.r, y: pr.c.y - pr.r });
      add({ x: pr.c.x + pr.r, y: pr.c.y + pr.r });
      continue;
    }
    for (const pl of primToPolylines(pr, tol)) for (const q of pl.pts) add(q);
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || x1 < x0 || y1 < y0) return null;
  return [x0, y0, x1, y1];
}

export interface DxfLayerPlan {
  /** Имя слоя в DXF */
  name: string;
  /** Исходный слой станка (null в режиме «один слой») */
  id: LaserLayerId | null;
  color: string;
  aci: number;
  truecolor: number;
  linetype: 'CONTINUOUS' | 'DASHED';
  visible: boolean;
  /** Число объектов документа на этом слое */
  shapes: number;
}

/** План слоёв файла: какие слои будут в таблице LAYER и в каком порядке. */
export function dxfLayerPlan(doc: LaserDoc, opts: DxfOptions, shapes: LaserShape[]): DxfLayerPlan[] {
  const plan: DxfLayerPlan[] = [];
  if (opts.layers === 'single') {
    const color = doc.layers.cut?.color ?? '#ff453a';
    plan.push({
      name: sanitizeLayerName(opts.singleLayer || 'LASER'),
      id: null,
      color,
      aci: hexToAci(color),
      truecolor: hexToTrueColor(color),
      linetype: 'CONTINUOUS',
      visible: true,
      shapes: shapes.length,
    });
    return plan;
  }
  if (opts.layers === 'objects') {
    const seen = new Map<string, LaserLayerId>();
    for (const s of shapes) {
      const n = sanitizeLayerName(s.name);
      if (!seen.has(n)) seen.set(n, s.layer);
    }
    for (const [name, id] of seen) {
      const cfg = doc.layers[id];
      const color = cfg?.color ?? '#ffffff';
      plan.push({
        name,
        id,
        color,
        aci: LAYER_ACI[id] ?? hexToAci(color),
        truecolor: hexToTrueColor(color),
        linetype: 'CONTINUOUS',
        visible: cfg?.visible ?? true,
        shapes: shapes.filter((s) => sanitizeLayerName(s.name) === name).length,
      });
    }
    if (!plan.length) plan.push({
      name: '0', id: 'cut', color: '#ffffff', aci: 7, truecolor: 0xffffff,
      linetype: 'CONTINUOUS', visible: true, shapes: 0,
    });
    return plan;
  }
  for (const id of LASER_LAYER_ORDER) {
    if (id === 'guide' && !opts.includeGuide) continue;
    const cfg = doc.layers[id];
    if (!cfg) continue;
    const count = shapes.filter((s) => s.layer === id).length;
    if (!count) continue;
    plan.push({
      name: DXF_LAYER_NAMES[id],
      id,
      color: cfg.color,
      aci: LAYER_ACI[id],
      truecolor: hexToTrueColor(cfg.color),
      linetype: (id === 'fold' || id === 'score') && opts.foldDash === 'linetype' ? 'DASHED' : 'CONTINUOUS',
      visible: cfg.visible,
      shapes: count,
    });
  }
  if (!plan.length) plan.push({
    name: '0', id: null, color: '#ffffff', aci: 7, truecolor: 0xffffff,
    linetype: 'CONTINUOUS', visible: true, shapes: 0,
  });
  return plan;
}

export interface DxfGeometry {
  opts: DxfOptions;
  geoms: DxfGeom[];
  layers: DxfLayerPlan[];
  extents: [number, number, number, number] | null;
  /** Параметры переноса начала координат и масштаба */
  transform: { dx: number; dy: number; k: number; frameH: number };
  /** Сколько объектов документа попало в файл */
  shapeCount: number;
}

/**
 * Полная геометрия документа, готовая к записи: примитивы по объектам с учётом
 * kerf, перемычек, пунктира, видимости, единиц, масштаба и нуля координат.
 */
export function collectDxfGeometry(doc: LaserDoc, o: Partial<DxfOptions> = {}): DxfGeometry {
  const opts = normalizeDxfOptions(o);
  const shapes = visibleShapes(doc, opts);

  const raw: DxfGeom[] = [];
  for (const s of shapes) {
    const cfg = doc.layers[s.layer];
    let prims: DxfPrim[];
    const kerfDelta =
      opts.kerf && cfg && cfg.kerf > 0 && (s.layer === 'cut' || s.layer === 'inner')
        ? (s.layer === 'inner' ? -cfg.kerf / 2 : cfg.kerf / 2)
        : 0;
    if (Math.abs(kerfDelta) > 1e-4) {
      // Компенсация керфа — полигональным смещением замкнутых контуров
      // (точные дуги при этом раскрываются, открытые линии режутся как есть)
      prims = [];
      for (const off of kerfShapes(s, kerfDelta)) prims.push(...shapePrims(off, opts));
    } else {
      prims = shapePrims(s, opts);
    }

    // Перемычки и пунктир работают с ломаными — раскрываем нужные примитивы
    const dash =
      (s.layer === 'fold' || s.layer === 'score') && opts.foldDash === 'segments' && cfg && cfg.dashLen > 0 && cfg.gapLen > 0;
    const tabs = opts.tabs && (s.tabs ?? 0) > 0 && (s.layer === 'cut' || s.layer === 'inner');
    if (dash || tabs) {
      const split: DxfPrim[] = [];
      for (const pr of prims) {
        if (pr.t === 'text') { split.push(pr); continue; }
        for (const pl of primToPolylines(pr, opts.tolerance)) {
          let parts: Pt[][] = [pl.pts];
          if (dash && cfg) parts = parts.flatMap((pts) => dashPolylines(pts, cfg.dashLen, cfg.gapLen));
          if (tabs && pl.closed) parts = parts.flatMap((pts) => applyTabs(pts, s.tabs ?? 0, s.tabWidth ?? 1.8));
          for (const pts of parts) {
            if (pts.length >= 2) split.push({ t: 'poly', pts: pts.map((p) => ({ x: p.x, y: p.y })), closed: false });
          }
        }
      }
      prims = split;
    }

    if (prims.length) raw.push({ layer: s.layer, name: s.name, prims });
  }

  const k = opts.units === 'inch' ? opts.scale / 25.4 : opts.scale;
  const bb = primsBBox(raw.flatMap((g) => g.prims), opts.tolerance);
  let dx = 0, dy = 0;
  if (bb) {
    if (opts.origin === 'bbox') { dx = -bb[0]; dy = -bb[1]; }
    else if (opts.origin === 'center') { dx = -(bb[0] + bb[2]) / 2; dy = -(bb[1] + bb[3]) / 2; }
  }
  const frameH = opts.origin === 'sheet' ? doc.h : opts.origin === 'bbox' && bb ? bb[3] - bb[1] : 0;
  const geoms = raw.map((g) => ({ ...g, prims: transformPrims(g.prims, dx, dy, k, opts.flipY, frameH) }));
  const extents = primsBBox(geoms.flatMap((g) => g.prims), opts.tolerance);

  return { opts, geoms, layers: dxfLayerPlan(doc, opts, shapes), extents, transform: { dx, dy, k, frameH }, shapeCount: shapes.length };
}

// ---------------- писатель DXF ----------------

class DxfWriter {
  private lines: string[] = [];
  private handle = 0x20;
  private prec: number;

  constructor(precision: number) {
    this.prec = precision;
  }

  /** Число без экспоненциальной записи и лишних нулей (DXF такое не любит). */
  n(v: number): string {
    if (!Number.isFinite(v)) return '0.0';
    let s = v.toFixed(this.prec);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
    if (s === '-0.0' || s === '-0') s = s.slice(1);
    return s;
  }

  pair(code: number, value: number) {
    this.lines.push(String(code), this.n(value));
  }

  raw(code: number, value: string) {
    this.lines.push(String(code), value);
  }

  int(code: number, value: number) {
    this.lines.push(String(code), String(Math.round(value)));
  }

  /**
   * Безразмерный параметр (отношение осей эллипса, углы, бульдж, узлы сплайна).
   * Его округление усиливается радиусом, поэтому знаков даём больше, чем у координат.
   */
  dim(code: number, value: number) {
    if (!Number.isFinite(value)) { this.lines.push(String(code), '0.0'); return; }
    let t = value.toFixed(Math.min(15, this.prec + 9));
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '.0');
    if (t === '-0.0' || t === '-0') t = t.slice(1);
    this.lines.push(String(code), t);
  }

  nextHandle(): string {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }

  get maxHandle(): number {
    return this.handle;
  }

  get text(): string {
    return this.lines.join('\r\n') + '\r\n';
  }
}

/** Склеивание дублей точек подряд (частая причина «разорванных» контуров в CAM). */
function weldPoly(pts: PolyPt[], tol: number): PolyPt[] {
  if (tol <= 0 || pts.length < 2) return pts;
  const out: PolyPt[] = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const p = pts[i];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) <= tol) {
      if (p.b && !prev.b) prev.b = p.b;
      continue;
    }
    out.push({ ...p });
  }
  if (out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= tol) {
      if (b.b && !a.b) a.b = b.b;
      out.pop();
    }
  }
  return out;
}

interface EntityCtx {
  w: DxfWriter;
  opts: DxfOptions;
  layerName: string;
  aci: number;
  truecolor: number;
  linetype: 'CONTINUOUS' | 'DASHED';
  owner: string;
  r2000: boolean;
  modelSpace: string;
  paperSpace: string;
  blockHandles: Map<string, string>;
  blocks: Map<string, { prims: DxfPrim[]; uses: { pos: Pt }[]; layer: string }>;
}

function entityHeader(ctx: EntityCtx, type: string, subclass: string) {
  const { w } = ctx;
  w.raw(0, type);
  if (ctx.r2000) {
    w.raw(5, w.nextHandle());
    w.raw(330, ctx.owner);
    w.raw(100, 'AcDbEntity');
  }
  w.raw(8, ctx.layerName);
  if (ctx.linetype === 'DASHED') w.raw(6, 'DASHED');
  if (ctx.opts.colors === 'aci') w.int(62, ctx.aci);
  else if (ctx.opts.colors === 'truecolor') {
    w.int(62, ctx.aci);
    w.int(420, ctx.truecolor);
  }
  if (ctx.r2000) w.raw(100, subclass);
}

function writeLine(ctx: EntityCtx, a: Pt, b: Pt) {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) return;
  entityHeader(ctx, 'LINE', 'AcDbLine');
  ctx.w.pair(10, a.x); ctx.w.pair(20, a.y); ctx.w.pair(30, 0);
  ctx.w.pair(11, b.x); ctx.w.pair(21, b.y); ctx.w.pair(31, 0);
}

function writeArcEntity(ctx: EntityCtx, c: Pt, r: number, a0: number, a1: number) {
  if (r <= 1e-9) return;
  const { w } = ctx;
  entityHeader(ctx, 'ARC', 'AcDbCircle');
  w.pair(10, c.x); w.pair(20, c.y); w.pair(30, 0);
  w.pair(40, r);
  if (ctx.r2000) w.raw(100, 'AcDbArc');
  w.dim(50, a0);
  w.dim(51, a1);
}

/** Дуга между двумя точками по bulge (точно: без аппроксимации). */
function writeArcFromBulge(ctx: EntityCtx, a: PolyPt, b: PolyPt, bulge: number) {
  const arc = bulgeToArc({ x: a.x, y: a.y }, { x: b.x, y: b.y }, bulge);
  if (!arc) { writeLine(ctx, { x: a.x, y: a.y }, { x: b.x, y: b.y }); return; }
  writeArcEntity(ctx, arc.c, arc.r, arc.a0, arc.a1);
}

function writePolyEntity(ctx: EntityCtx, pts: PolyPt[], closed: boolean) {
  const { w, opts } = ctx;
  // У замкнутой полилинии флаг 70=1 сам замыкает контур, поэтому дубль первой
  // точки в конце не пишем — иначе CAM видит нулевой сегмент.
  let src = pts;
  if (closed && pts.length > 2) {
    const a = pts[0], b = pts[pts.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9) src = pts.slice(0, -1);
  }
  const clean = weldPoly(src, opts.weld);
  if (clean.length < 2) return;
  const mode =
    opts.entities === 'lines' ? 'lines'
      : opts.entities === 'polyline' || opts.version === 'R12' ? 'polyline'
        : 'lwpolyline';

  if (mode === 'lines') {
    // Чистые отрезки: дуги раскрываются с допуском аппроксимации
    const pts = polyToPoints(clean, closed, opts.tolerance);
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a && b) writeLine(ctx, a, b);
    }
    return;
  }

  // Двухточечная полилиния без дуг — обычный отрезок (короче файл, проще для CAM)
  if (!closed && clean.length === 2 && !clean.some((p) => p.b && Math.abs(p.b) > 1e-12)) {
    writeLine(ctx, { x: clean[0].x, y: clean[0].y }, { x: clean[1].x, y: clean[1].y });
    return;
  }

  const keepBulges = opts.entities !== 'polyline';
  const final: PolyPt[] = keepBulges
    ? clean
    : polyToPoints(clean, closed, opts.tolerance).map((p) => ({ x: p.x, y: p.y }));

  if (mode === 'lwpolyline') {
    entityHeader(ctx, 'LWPOLYLINE', 'AcDbPolyline');
    w.int(90, final.length);
    w.int(70, closed ? 1 : 0);
    w.pair(43, 0);
    for (const p of final) {
      w.pair(10, p.x);
      w.pair(20, p.y);
      if (p.b && Math.abs(p.b) > 1e-12) w.dim(42, p.b);
    }
    return;
  }

  // R12 (и режим polyline): POLYLINE + VERTEX + SEQEND
  w.raw(0, 'POLYLINE');
  if (ctx.r2000) {
    w.raw(5, w.nextHandle());
    w.raw(330, ctx.owner);
    w.raw(100, 'AcDbEntity');
  }
  w.raw(8, ctx.layerName);
  if (ctx.linetype === 'DASHED') w.raw(6, 'DASHED');
  if (opts.colors === 'aci') w.int(62, ctx.aci);
  else if (opts.colors === 'truecolor') { w.int(62, ctx.aci); w.int(420, ctx.truecolor); }
  if (ctx.r2000) w.raw(100, 'AcDb2dPolyline');
  w.int(66, 1);
  w.int(70, closed ? 1 : 0);
  w.pair(10, 0); w.pair(20, 0); w.pair(30, 0);
  for (const p of final) {
    w.raw(0, 'VERTEX');
    if (ctx.r2000) {
      w.raw(5, w.nextHandle());
      w.raw(330, ctx.owner);
      w.raw(100, 'AcDbEntity');
    }
    w.raw(8, ctx.layerName);
    if (ctx.r2000) w.raw(100, 'AcDbVertex');
    w.pair(10, p.x);
    w.pair(20, p.y);
    w.pair(30, 0);
    if (p.b && Math.abs(p.b) > 1e-12) w.dim(42, p.b);
  }
  w.raw(0, 'SEQEND');
  if (ctx.r2000) {
    w.raw(5, w.nextHandle());
    w.raw(330, ctx.owner);
    w.raw(100, 'AcDbEntity');
  }
  w.raw(8, ctx.layerName);
}

function writePrim(ctx: EntityCtx, prim: DxfPrim) {
  const { w, opts } = ctx;
  // Точные дуги/окружности доступны в любом режиме, кроме «полилинии» и «отрезки»;
  // ELLIPSE и SPLINE есть только в R2000.
  const analytic = opts.entities === 'exact' || opts.entities === 'auto';
  const exact = analytic && opts.version === 'R2000';
  switch (prim.t) {
    case 'line':
      writeLine(ctx, prim.a, prim.b);
      return;
    case 'circle':
      if (prim.r <= 1e-9) return;
      entityHeader(ctx, 'CIRCLE', 'AcDbCircle');
      w.pair(10, prim.c.x); w.pair(20, prim.c.y); w.pair(30, 0);
      w.pair(40, prim.r);
      return;
    case 'arc': {
      if (!analytic) {
        const [d0, d1] = normalizeArcAngles(prim.a0, prim.a1);
        const pts = flattenArc(prim.c, prim.r, prim.r, 0, (d0 * Math.PI) / 180, (d1 * Math.PI) / 180, opts.tolerance, true);
        writePolyEntity(ctx, pts.map((p) => ({ x: p.x, y: p.y })), false);
        return;
      }
      const [d0, d1] = normalizeArcAngles(prim.a0, prim.a1);
      writeArcEntity(ctx, prim.c, prim.r, d0, d1);
      return;
    }
    case 'ellipse': {
      const full = Math.abs(Math.abs(prim.a1 - prim.a0) - 360) < 1e-6;
      if (!exact) {
        const [d0, d1] = full ? [prim.a0, prim.a0 + 360] : normalizeArcAngles(prim.a0, prim.a1);
        const pts = flattenArc(prim.c, prim.rx, prim.ry, prim.rot, (d0 * Math.PI) / 180, (d1 * Math.PI) / 180, opts.tolerance, true);
        writePolyEntity(ctx, pts.map((p) => ({ x: p.x, y: p.y })), full);
        return;
      }
      const a = (prim.rot * Math.PI) / 180;
      entityHeader(ctx, 'ELLIPSE', 'AcDbEllipse');
      w.pair(10, prim.c.x); w.pair(20, prim.c.y); w.pair(30, 0);
      w.pair(11, Math.cos(a) * prim.rx); w.pair(21, Math.sin(a) * prim.rx); w.pair(31, 0);
      w.dim(40, prim.ry / (prim.rx || 1e-9));
      w.dim(41, (prim.a0 * Math.PI) / 180);
      w.dim(42, (prim.a1 * Math.PI) / 180);
      return;
    }
    case 'spline': {
      if (!exact || prim.controls.length < 4) {
        for (const pl of primToPolylines(prim, opts.tolerance)) {
          writePolyEntity(ctx, pl.pts.map((p) => ({ x: p.x, y: p.y })), pl.closed);
        }
        return;
      }
      entityHeader(ctx, 'SPLINE', 'AcDbSpline');
      w.int(70, 8);
      w.int(71, prim.degree);
      w.int(72, prim.knots.length);
      w.int(73, prim.controls.length);
      w.int(74, 0);
      w.dim(42, 1e-10);
      w.dim(43, 1e-10);
      for (const k of prim.knots) w.dim(40, k);
      for (const p of prim.controls) {
        w.pair(10, p.x); w.pair(20, p.y); w.pair(30, 0);
      }
      return;
    }
    case 'poly':
      writePolyEntity(ctx, prim.pts, prim.closed);
      return;
    case 'text':
      if (!opts.textAsEntity) return;
      entityHeader(ctx, 'TEXT', 'AcDbText');
      w.pair(10, prim.pos.x); w.pair(20, prim.pos.y); w.pair(30, 0);
      w.pair(40, prim.height);
      w.raw(1, prim.value);
      w.dim(50, prim.rot);
      w.raw(7, 'STANDARD');
      return;
  }
}

/** Подпись геометрии детали для поиска одинаковых (блоки INSERT). */
function primSignature(prims: DxfPrim[], tol: number): string {
  const key: string[] = [];
  for (const pr of prims) {
    for (const pl of primToPolylines(pr, Math.max(tol, 0.05))) {
      key.push(pl.pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|'));
    }
  }
  return key.join('#');
}

function shiftPrims(prims: DxfPrim[], dx: number, dy: number): DxfPrim[] {
  const T = (p: Pt): Pt => ({ x: p.x + dx, y: p.y + dy });
  return prims.map((pr) => {
    switch (pr.t) {
      case 'line': return { t: 'line', a: T(pr.a), b: T(pr.b) };
      case 'circle': return { t: 'circle', c: T(pr.c), r: pr.r };
      case 'arc': return { t: 'arc', c: T(pr.c), r: pr.r, a0: pr.a0, a1: pr.a1 };
      case 'ellipse': return { t: 'ellipse', c: T(pr.c), rx: pr.rx, ry: pr.ry, rot: pr.rot, a0: pr.a0, a1: pr.a1 };
      case 'spline': return { t: 'spline', controls: pr.controls.map(T), knots: pr.knots, degree: pr.degree };
      case 'poly': return { t: 'poly', pts: pr.pts.map((p) => ({ x: p.x + dx, y: p.y + dy, b: p.b })), closed: pr.closed };
      case 'text': return { t: 'text', pos: T(pr.pos), height: pr.height, value: pr.value, rot: pr.rot };
    }
  });
}

// ---------------- HEADER / TABLES / BLOCKS / OBJECTS ----------------

function writeHeader(w: DxfWriter, opts: DxfOptions, ext: [number, number, number, number] | null, doc: LaserDoc, handseed: number) {
  const e = ext ?? [0, 0, Math.max(doc.w, 1) * opts.scale, Math.max(doc.h, 1) * opts.scale];
  const r2000 = opts.version !== 'R12';
  w.raw(0, 'SECTION');
  w.raw(2, 'HEADER');
  w.raw(9, '$ACADVER');
  w.raw(1, r2000 ? 'AC1015' : 'AC1009');
  if (r2000) {
    w.raw(9, '$ACADMAINTVER');
    w.int(70, 6);
    w.raw(9, '$DWGCODEPAGE');
    w.raw(3, 'ANSI_1251');
  }
  w.raw(9, '$INSBASE');
  w.pair(10, 0); w.pair(20, 0); w.pair(30, 0);
  w.raw(9, '$EXTMIN');
  w.pair(10, e[0]); w.pair(20, e[1]); w.pair(30, 0);
  w.raw(9, '$EXTMAX');
  w.pair(10, e[2]); w.pair(20, e[3]); w.pair(30, 0);
  w.raw(9, '$LIMMIN');
  w.pair(10, Math.min(0, e[0])); w.pair(20, Math.min(0, e[1]));
  w.raw(9, '$LIMMAX');
  w.pair(10, Math.max(doc.w * opts.scale, e[2])); w.pair(20, Math.max(doc.h * opts.scale, e[3]));
  w.raw(9, '$ORTHOMODE');
  w.int(70, 0);
  w.raw(9, '$REGENMODE');
  w.int(70, 1);
  w.raw(9, '$FILLMODE');
  w.int(70, 1);
  w.raw(9, '$QTEXTMODE');
  w.int(70, 0);
  w.raw(9, '$MIRRTEXT');
  w.int(70, 0);
  w.raw(9, '$LTSCALE');
  w.pair(40, 1);
  w.raw(9, '$ATTMODE');
  w.int(70, 1);
  w.raw(9, '$TEXTSIZE');
  w.pair(40, 2.5);
  w.raw(9, '$TRACEWID');
  w.pair(40, 1);
  w.raw(9, '$TEXTSTYLE');
  w.raw(7, 'STANDARD');
  w.raw(9, '$CLAYER');
  w.raw(8, '0');
  w.raw(9, '$CELTYPE');
  w.raw(6, 'BYLAYER');
  w.raw(9, '$CECOLOR');
  w.int(62, 256);
  w.raw(9, '$DIMSCALE');
  w.pair(40, 1);
  w.raw(9, '$DIMASZ');
  w.pair(40, 2.5);
  w.raw(9, '$DIMEXO');
  w.pair(40, 0.625);
  w.raw(9, '$DIMDLI');
  w.pair(40, 3.75);
  w.raw(9, '$DIMTXT');
  w.pair(40, 2.5);
  w.raw(9, '$LUNITS');
  w.int(70, 2);
  w.raw(9, '$LUPREC');
  w.int(70, opts.precision);
  w.raw(9, '$AUNITS');
  w.int(70, 0);
  w.raw(9, '$AUPREC');
  w.int(70, 2);
  if (r2000) {
    w.raw(9, '$INSUNITS');
    w.int(70, opts.units === 'inch' ? 1 : 4);
    w.raw(9, '$MEASUREMENT');
    w.int(70, opts.units === 'inch' ? 0 : 1);
    w.raw(9, '$HANDSEED');
    w.raw(5, handseed.toString(16).toUpperCase());
  }
  w.raw(0, 'ENDSEC');
}

/**
 * Секция CLASSES (только R2000+): объявляет классы объектов, которых нет в
 * базовом наборе формата. Без неё строгие читалки ругаются на MLINESTYLE.
 */
function writeClasses(w: DxfWriter) {
  const classes: [string, string][] = [
    ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault'],
    ['ACDBPLACEHOLDER', 'AcDbPlaceHolder'],
    ['MLINESTYLE', 'AcDbMlineStyle'],
  ];
  w.raw(0, 'SECTION');
  w.raw(2, 'CLASSES');
  for (const [dxfName, cppName] of classes) {
    w.raw(0, 'CLASS');
    w.raw(1, dxfName);
    w.raw(2, cppName);
    w.raw(3, 'ObjectDBX Classes');
    w.int(90, 0);   // возможности прокси
    w.int(280, 0);  // флаг «был зомби»
    w.int(281, 0);  // флаг «является сущностью»
  }
  w.raw(0, 'ENDSEC');
}

function writeTables(w: DxfWriter, ctx: EntityCtx, layers: DxfLayerPlan[], needsDash: boolean) {
  const { w: wr, opts } = ctx;
  wr.raw(0, 'SECTION');
  wr.raw(2, 'TABLES');

  // VPORT — вид по содержимому файла
  wr.raw(0, 'TABLE');
  wr.raw(2, 'VPORT');
  if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
  wr.int(70, 1);
  wr.raw(0, 'VPORT');
  if (ctx.r2000) {
    wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
    wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbViewportTableRecord');
  }
  wr.raw(2, '*ACTIVE');
  wr.int(70, 0);
  wr.pair(10, 0); wr.pair(20, 0);
  wr.pair(11, 1); wr.pair(21, 1);
  wr.pair(12, 210); wr.pair(22, 148.5);
  wr.pair(13, 0); wr.pair(23, 0);
  wr.pair(14, 10); wr.pair(24, 10);
  wr.pair(15, 10); wr.pair(25, 10);
  wr.pair(16, 0); wr.pair(26, 0); wr.pair(36, 1);
  wr.pair(17, 0); wr.pair(27, 0); wr.pair(37, 0);
  wr.pair(40, 341); wr.pair(41, 1.24);
  wr.pair(42, 50); wr.pair(43, 0); wr.pair(44, 0);
  wr.pair(50, 0); wr.pair(51, 0);
  wr.int(71, 0); wr.int(72, 100); wr.int(73, 1); wr.int(74, 3);
  wr.int(75, 0); wr.int(76, 1); wr.int(77, 0); wr.int(78, 0);
  wr.raw(0, 'ENDTAB');

  // LTYPE — сплошная и пунктир для биговки
  wr.raw(0, 'TABLE');
  wr.raw(2, 'LTYPE');
  if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
  wr.int(70, needsDash ? 4 : 3);
  const ltype = (name: string, desc: string, pattern: number[]) => {
    wr.raw(0, 'LTYPE');
    if (ctx.r2000) {
      wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
      wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbLinetypeTableRecord');
    }
    wr.raw(2, name);
    wr.int(70, 0);
    wr.raw(3, desc);
    wr.int(72, 65);
    wr.int(73, pattern.length);
    wr.pair(40, pattern.reduce((s, v) => s + Math.abs(v), 0));
    for (const v of pattern) wr.pair(49, v);
  };
  ltype('BYBLOCK', '', []);
  ltype('BYLAYER', '', []);
  ltype('CONTINUOUS', 'Solid line', []);
  if (needsDash) ltype('DASHED', 'Dashed __ __ __', [8, -4]);
  wr.raw(0, 'ENDTAB');

  // LAYER — слои станка с цветами AutoCAD
  wr.raw(0, 'TABLE');
  wr.raw(2, 'LAYER');
  if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
  wr.int(70, layers.length + 1);
  const layerRow = (name: string, aci: number, truecolor: number, linetype: string, flags: number) => {
    wr.raw(0, 'LAYER');
    if (ctx.r2000) {
      wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
      wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbLayerTableRecord');
    }
    wr.raw(2, name);
    wr.int(70, flags);
    wr.int(62, aci);
    if (opts.colors === 'truecolor' && ctx.r2000) wr.int(420, truecolor);
    wr.raw(6, linetype);
    if (ctx.r2000) { wr.int(370, -3); wr.raw(390, ctx.modelSpace || '0'); }
  };
  layerRow('0', 7, 0xffffff, 'CONTINUOUS', 0);
  for (const l of layers) layerRow(l.name, l.aci, l.truecolor, l.linetype, l.visible ? 0 : 4);
  wr.raw(0, 'ENDTAB');

  // STYLE — текстовый стиль (для надписей объектом TEXT)
  wr.raw(0, 'TABLE');
  wr.raw(2, 'STYLE');
  if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
  wr.int(70, 1);
  wr.raw(0, 'STYLE');
  if (ctx.r2000) {
    wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
    wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbTextStyleTableRecord');
  }
  wr.raw(2, 'STANDARD');
  wr.int(70, 0);
  wr.pair(40, 0); wr.pair(41, 1); wr.pair(50, 0);
  wr.int(71, 0);
  wr.pair(42, 2.5);
  wr.raw(3, 'txt');
  wr.raw(4, '');
  wr.raw(0, 'ENDTAB');

  const emptyTable = (name: string) => {
    wr.raw(0, 'TABLE');
    wr.raw(2, name);
    if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
    wr.int(70, 0);
    wr.raw(0, 'ENDTAB');
  };
  emptyTable('VIEW');
  emptyTable('UCS');

  wr.raw(0, 'TABLE');
  wr.raw(2, 'APPID');
  if (ctx.r2000) { wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable'); }
  wr.int(70, 1);
  wr.raw(0, 'APPID');
  if (ctx.r2000) {
    wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
    wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbRegAppTableRecord');
  }
  wr.raw(2, 'ACAD');
  wr.int(70, 0);
  wr.raw(0, 'ENDTAB');

  wr.raw(0, 'TABLE');
  wr.raw(2, 'DIMSTYLE');
  if (ctx.r2000) {
    wr.raw(5, wr.nextHandle()); wr.raw(330, '0');
    wr.raw(100, 'AcDbSymbolTable'); wr.raw(100, 'AcDbDimStyleTable');
  }
  wr.int(70, 1);
  wr.raw(0, 'DIMSTYLE');
  if (ctx.r2000) {
    wr.raw(105, wr.nextHandle()); wr.raw(330, '0');
    wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbDimStyleTableRecord');
  }
  wr.raw(2, 'STANDARD');
  wr.int(70, 0);
  wr.raw(0, 'ENDTAB');

  // BLOCK_RECORD — только R2000
  if (ctx.r2000) {
    wr.raw(0, 'TABLE');
    wr.raw(2, 'BLOCK_RECORD');
    wr.raw(5, wr.nextHandle()); wr.raw(330, '0'); wr.raw(100, 'AcDbSymbolTable');
    wr.int(70, 2 + ctx.blocks.size);
    const br = (name: string): string => {
      const h = wr.nextHandle();
      wr.raw(0, 'BLOCK_RECORD');
      wr.raw(5, h); wr.raw(330, '0');
      wr.raw(100, 'AcDbSymbolTableRecord'); wr.raw(100, 'AcDbBlockTableRecord');
      wr.raw(2, name);
      return h;
    };
    ctx.modelSpace = br('*Model_Space');
    ctx.paperSpace = br('*Paper_Space');
    for (const name of ctx.blocks.keys()) ctx.blockHandles.set(name, br(name));
    wr.raw(0, 'ENDTAB');
  }

  wr.raw(0, 'ENDSEC');
}

function writeBlocksSection(w: DxfWriter, ctx: EntityCtx) {
  if (!ctx.r2000) return;
  w.raw(0, 'SECTION');
  w.raw(2, 'BLOCKS');
  const space = (name: string, brHandle: string) => {
    w.raw(0, 'BLOCK');
    w.raw(5, w.nextHandle()); w.raw(330, brHandle);
    w.raw(100, 'AcDbEntity');
    w.raw(8, '0');
    w.raw(100, 'AcDbBlockBegin');
    w.raw(2, name);
    w.int(70, 0);
    w.pair(10, 0); w.pair(20, 0); w.pair(30, 0);
    w.raw(3, name);
    w.raw(1, '');
    w.raw(0, 'ENDBLK');
    w.raw(5, w.nextHandle()); w.raw(330, brHandle);
    w.raw(100, 'AcDbEntity');
    w.raw(8, '0');
    w.raw(100, 'AcDbBlockEnd');
  };
  space('*Model_Space', ctx.modelSpace);
  space('*Paper_Space', ctx.paperSpace);

  for (const [name, blk] of ctx.blocks) {
    const brHandle = ctx.blockHandles.get(name) ?? ctx.modelSpace;
    w.raw(0, 'BLOCK');
    w.raw(5, w.nextHandle()); w.raw(330, brHandle);
    w.raw(100, 'AcDbEntity');
    w.raw(8, '0');
    w.raw(100, 'AcDbBlockBegin');
    w.raw(2, name);
    w.int(70, 0);
    w.pair(10, 0); w.pair(20, 0); w.pair(30, 0);
    w.raw(3, name);
    w.raw(1, '');
    const inner: EntityCtx = { ...ctx, owner: brHandle, layerName: blk.layer };
    for (const pr of blk.prims) writePrim(inner, pr);
    w.raw(0, 'ENDBLK');
    w.raw(5, w.nextHandle()); w.raw(330, brHandle);
    w.raw(100, 'AcDbEntity');
    w.raw(8, '0');
    w.raw(100, 'AcDbBlockEnd');
  }
  w.raw(0, 'ENDSEC');
}

function writeObjects(w: DxfWriter, ctx: EntityCtx) {
  if (!ctx.r2000) return;
  w.raw(0, 'SECTION');
  w.raw(2, 'OBJECTS');
  const root = w.nextHandle();
  w.raw(0, 'DICTIONARY');
  w.raw(5, root); w.raw(330, '0');
  w.raw(100, 'AcDbDictionary');
  w.int(281, 1);
  w.raw(3, 'ACAD_GROUP');
  const groupDict = w.nextHandle();
  w.raw(350, groupDict);
  w.raw(3, 'ACAD_MLINESTYLE');
  const mlineDict = w.nextHandle();
  w.raw(350, mlineDict);
  const dict = (h: string) => {
    w.raw(0, 'DICTIONARY');
    w.raw(5, h); w.raw(330, root);
    w.raw(100, 'AcDbDictionary');
    w.int(281, 1);
  };
  dict(groupDict);
  dict(mlineDict);
  w.raw(0, 'MLINESTYLE');
  w.raw(5, w.nextHandle()); w.raw(330, mlineDict);
  w.raw(100, 'AcDbMlineStyle');
  w.raw(2, 'STANDARD');
  w.int(70, 0);
  w.raw(3, '');
  w.int(62, 256);
  w.pair(51, 90); w.pair(52, 90);
  w.int(71, 2);
  w.pair(49, 0.5); w.int(62, 256); w.raw(6, 'BYLAYER');
  w.pair(49, -0.5); w.int(62, 256); w.raw(6, 'BYLAYER');
  w.raw(0, 'ENDSEC');
}

function layerNameFor(g: DxfGeom, layers: DxfLayerPlan[], opts: DxfOptions): string {
  if (opts.layers === 'single') return layers[0]?.name ?? '0';
  if (opts.layers === 'objects') {
    const n = sanitizeLayerName(g.name);
    return layers.some((l) => l.name === n) ? n : layers[0]?.name ?? '0';
  }
  return layers.find((l) => l.id === g.layer)?.name ?? DXF_LAYER_NAMES[g.layer];
}

/** Поиск одинаковых деталей для записи блоками (экономит размер файла и время CAM). */
function buildBlocks(
  geoms: DxfGeom[], layers: DxfLayerPlan[], opts: DxfOptions
): { blocks: Map<string, { prims: DxfPrim[]; uses: { pos: Pt }[]; layer: string }>; consumed: Set<number> } {
  const blocks = new Map<string, { prims: DxfPrim[]; uses: { pos: Pt }[]; layer: string }>();
  const consumed = new Set<number>();
  if (!opts.blocks || geoms.length < 2) return { blocks, consumed };

  const bySig = new Map<string, number[]>();
  geoms.forEach((g, idx) => {
    const bb = primsBBox(g.prims, opts.tolerance);
    if (!bb) return;
    const sig = primSignature(shiftPrims(g.prims, -bb[0], -bb[1]), opts.tolerance);
    if (!bySig.has(sig)) bySig.set(sig, []);
    bySig.get(sig)!.push(idx);
  });

  let n = 0;
  for (const [sig, idxs] of bySig) {
    if (idxs.length < 2 || !sig) continue;
    n += 1;
    const name = `PSB_PART_${n}`;
    const uses: { pos: Pt }[] = [];
    let basePrims: DxfPrim[] | null = null;
    for (const idx of idxs) {
      const bb = primsBBox(geoms[idx].prims, opts.tolerance);
      if (!bb) continue;
      if (!basePrims) basePrims = shiftPrims(geoms[idx].prims, -bb[0], -bb[1]);
      uses.push({ pos: { x: bb[0], y: bb[1] } });
      consumed.add(idx);
    }
    if (basePrims && uses.length >= 2) {
      blocks.set(name, { prims: basePrims, uses, layer: layerNameFor(geoms[idxs[0]], layers, opts) });
    }
  }
  return { blocks, consumed };
}

/** Сборка текста DXF-файла из подготовленной геометрии. */
function buildDxfText(
  doc: LaserDoc,
  opts: DxfOptions,
  geoms: DxfGeom[],
  layers: DxfLayerPlan[],
  ext: [number, number, number, number] | null
): string {
  const r2000 = opts.version !== 'R12';
  const { blocks, consumed } = buildBlocks(geoms, layers, opts);

  const body = new DxfWriter(opts.precision);
  const needsDash = layers.some((l) => l.linetype === 'DASHED');
  const ctx: EntityCtx = {
    w: body, opts, layerName: '0', aci: 7, truecolor: 0xffffff, linetype: 'CONTINUOUS',
    owner: '0', r2000, modelSpace: '', paperSpace: '', blockHandles: new Map(), blocks,
  };

  if (r2000) writeClasses(body);
  writeTables(body, ctx, layers, needsDash);
  ctx.owner = r2000 ? ctx.modelSpace : '0';
  writeBlocksSection(body, ctx);

  // ENTITIES
  body.raw(0, 'SECTION');
  body.raw(2, 'ENTITIES');

  // Вставки блоков (одинаковые детали)
  if (blocks.size) {
    for (const [name, blk] of blocks) {
      const plan = layers.find((l) => l.name === blk.layer) ?? layers[0];
      ctx.layerName = plan?.name ?? '0';
      ctx.aci = plan?.aci ?? 7;
      ctx.truecolor = plan?.truecolor ?? 0xffffff;
      ctx.linetype = plan?.linetype ?? 'CONTINUOUS';
      for (const use of blk.uses) {
        body.raw(0, 'INSERT');
        if (r2000) {
          body.raw(5, body.nextHandle());
          body.raw(330, ctx.owner);
          body.raw(100, 'AcDbEntity');
        }
        body.raw(8, ctx.layerName);
        if (opts.colors === 'aci') body.int(62, ctx.aci);
        if (r2000) body.raw(100, 'AcDbBlockReference');
        body.raw(2, name);
        body.pair(10, use.pos.x); body.pair(20, use.pos.y); body.pair(30, 0);
        body.dim(41, 1); body.dim(42, 1); body.dim(43, 1);
        body.dim(50, 0);
      }
    }
  }

  for (const l of layers) {
    ctx.layerName = l.name;
    ctx.aci = l.aci;
    ctx.truecolor = l.truecolor;
    ctx.linetype = l.linetype;
    geoms.forEach((g, idx) => {
      if (consumed.has(idx)) return;
      if (layerNameFor(g, layers, opts) !== l.name) return;
      for (const pr of g.prims) writePrim(ctx, pr);
    });
  }
  body.raw(0, 'ENDSEC');

  writeObjects(body, ctx);
  body.raw(0, 'EOF');

  // HEADER пишем первым, но $HANDSEED зависит от числа выданных дескрипторов
  const head = new DxfWriter(opts.precision);
  if (opts.comment.trim()) {
    head.raw(999, opts.comment.trim().slice(0, 200));
  }
  writeHeader(head, opts, ext, doc, body.maxHandle + 0x100);
  return head.text + body.text;
}

/** Экспорт документа в строку DXF. */
export function exportDxf(doc: LaserDoc, o: Partial<DxfOptions> = {}): string {
  const { opts, geoms, layers, extents } = collectDxfGeometry(doc, o);
  return buildDxfText(doc, opts, geoms, layers, extents);
}

export interface DxfFile {
  name: string;
  text: string;
}

/** Экспорт отдельными файлами по слоям станка (удобно для RDWorks/CypCut). */
export function exportDxfPerLayer(doc: LaserDoc, o: Partial<DxfOptions> = {}): DxfFile[] {
  const opts = normalizeDxfOptions(o);
  const files: DxfFile[] = [];
  for (const id of LASER_LAYER_ORDER) {
    if (id === 'guide' && !opts.includeGuide) continue;
    const sub: LaserDoc = { ...doc, shapes: doc.shapes.filter((s) => s.layer === id) };
    if (!visibleShapes(sub, opts).length) continue;
    files.push({ name: `${DXF_LAYER_NAMES[id]}.dxf`, text: exportDxf(sub, opts) });
  }
  return files;
}

// ---------------- разбор DXF ----------------

/** Разбор DXF на пары «групповой код / значение». */
export function parseDxfPairs(text: string): [number, string][] {
  const lines = text.split(/\r?\n/);
  const out: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    out.push([code, lines[i + 1]]);
  }
  return out;
}

function num(body: [number, string][], code: number): number {
  for (const [c, v] of body) if (c === code) return parseFloat(v);
  return 0;
}
function str(body: [number, string][], code: number): string {
  for (const [c, v] of body) if (c === code) return v;
  return '';
}
function nums(body: [number, string][], code: number): number[] {
  return body.filter((b) => b[0] === code).map((b) => parseFloat(b[1]));
}

interface ReadEntity {
  items: { layer: string; prims: DxfPrim[] }[];
  next: number;
}

function readEntity(type: string, body: [number, string][], pairs: [number, string][], next: number): ReadEntity | null {
  const layer = str(body, 8) || '0';
  switch (type) {
    case 'LINE':
      return {
        items: [{
          layer,
          prims: [{ t: 'line', a: { x: num(body, 10), y: num(body, 20) }, b: { x: num(body, 11), y: num(body, 21) } }],
        }],
        next,
      };
    case 'CIRCLE':
      return { items: [{ layer, prims: [{ t: 'circle', c: { x: num(body, 10), y: num(body, 20) }, r: Math.abs(num(body, 40)) }] }], next };
    case 'ARC':
      return {
        items: [{
          layer,
          prims: [{ t: 'arc', c: { x: num(body, 10), y: num(body, 20) }, r: Math.abs(num(body, 40)), a0: num(body, 50), a1: num(body, 51) }],
        }],
        next,
      };
    case 'ELLIPSE': {
      const mx = num(body, 11), my = num(body, 21);
      const rx = Math.hypot(mx, my);
      const ratio = num(body, 40) || 1;
      return {
        items: [{
          layer,
          prims: [{
            t: 'ellipse',
            c: { x: num(body, 10), y: num(body, 20) },
            rx, ry: Math.abs(rx * ratio),
            rot: (Math.atan2(my, mx) * 180) / Math.PI,
            a0: (num(body, 41) * 180) / Math.PI,
            a1: (num(body, 42) * 180) / Math.PI,
          }],
        }],
        next,
      };
    }
    case 'TEXT':
    case 'MTEXT':
      return {
        items: [{
          layer,
          prims: [{
            t: 'text', pos: { x: num(body, 10), y: num(body, 20) },
            height: num(body, 40) || 2.5, value: str(body, 1), rot: num(body, 50),
          }],
        }],
        next,
      };
    case 'SPLINE': {
      const xs = nums(body, 10), ys = nums(body, 20);
      return {
        items: [{
          layer,
          prims: [{ t: 'spline', controls: xs.map((x, i) => ({ x, y: ys[i] ?? 0 })), knots: nums(body, 40), degree: num(body, 71) || 3 }],
        }],
        next,
      };
    }
    case 'LWPOLYLINE': {
      const closed = (num(body, 70) & 1) === 1;
      // Вершина описывается тройкой 10/20 и необязательным bulge 42 сразу за ней
      const pts: PolyPt[] = [];
      for (const [c, v] of body) {
        if (c === 10) pts.push({ x: parseFloat(v), y: 0 });
        else if (c === 20 && pts.length) pts[pts.length - 1].y = parseFloat(v);
        else if (c === 42 && pts.length) {
          const b = parseFloat(v);
          if (Math.abs(b) > 1e-12) pts[pts.length - 1].b = b;
        }
      }
      return { items: [{ layer, prims: [{ t: 'poly', pts, closed }] }], next };
    }
    case 'POLYLINE': {
      const closed = (num(body, 70) & 1) === 1;
      const pts: PolyPt[] = [];
      let j = next;
      while (j < pairs.length) {
        const [c, v] = pairs[j];
        if (c !== 0) { j += 1; continue; }
        if (v === 'VERTEX') {
          const vb: [number, string][] = [];
          j += 1;
          while (j < pairs.length && pairs[j][0] !== 0) { vb.push(pairs[j]); j += 1; }
          pts.push({ x: num(vb, 10), y: num(vb, 20), b: num(vb, 42) || undefined });
          continue;
        }
        if (v === 'SEQEND') {
          j += 1;
          while (j < pairs.length && pairs[j][0] !== 0) j += 1;
          break;
        }
        break;
      }
      return { items: [{ layer, prims: [{ t: 'poly', pts, closed }] }], next: j };
    }
    default:
      return null;
  }
}

/** Определения блоков (для раскрытия INSERT при импорте). */
function readDxfBlocks(pairs: [number, string][]): Map<string, DxfPrim[]> {
  const map = new Map<string, DxfPrim[]>();
  let inBlocks = false;
  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 2 && val === 'BLOCKS') inBlocks = true;
    else if (code === 0 && val === 'ENDSEC' && inBlocks) break;
    if (!inBlocks || code !== 0 || val !== 'BLOCK') { i += 1; continue; }
    i += 1;
    const head: [number, string][] = [];
    while (i < pairs.length && pairs[i][0] !== 0) { head.push(pairs[i]); i += 1; }
    const name = str(head, 2);
    const prims: DxfPrim[] = [];
    while (i < pairs.length) {
      const [c, v] = pairs[i];
      if (c === 0 && v === 'ENDBLK') {
        i += 1;
        while (i < pairs.length && pairs[i][0] !== 0) i += 1;
        break;
      }
      if (c !== 0) { i += 1; continue; }
      const type = v;
      i += 1;
      const body: [number, string][] = [];
      while (i < pairs.length && pairs[i][0] !== 0) { body.push(pairs[i]); i += 1; }
      const rec = readEntity(type, body, pairs, i);
      if (rec) { for (const it of rec.items) prims.push(...it.prims); i = rec.next; }
    }
    if (name && prims.length && !name.startsWith('*')) map.set(name, prims);
  }
  return map;
}

/** Аффинное преобразование примитивов (для раскрытия блоков: масштаб, поворот, сдвиг). */
function affinePrims(prims: DxfPrim[], pos: Pt, sx: number, sy: number, rotDeg: number): DxfPrim[] {
  const a = (rotDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const T = (p: Pt): Pt => {
    const x = p.x * sx, y = p.y * sy;
    return { x: pos.x + x * ca - y * sa, y: pos.y + x * sa + y * ca };
  };
  const out: DxfPrim[] = [];
  for (const pr of prims) {
    switch (pr.t) {
      case 'line': out.push({ t: 'line', a: T(pr.a), b: T(pr.b) }); break;
      case 'circle': out.push({ t: 'circle', c: T(pr.c), r: pr.r * Math.abs(sx) }); break;
      case 'arc': out.push({ t: 'arc', c: T(pr.c), r: pr.r * Math.abs(sx), a0: pr.a0 + rotDeg, a1: pr.a1 + rotDeg }); break;
      case 'ellipse': out.push({ t: 'ellipse', c: T(pr.c), rx: pr.rx * Math.abs(sx), ry: pr.ry * Math.abs(sy), rot: pr.rot + rotDeg, a0: pr.a0, a1: pr.a1 }); break;
      case 'spline': out.push({ t: 'spline', controls: pr.controls.map(T), knots: pr.knots, degree: pr.degree }); break;
      case 'poly': out.push({ t: 'poly', pts: pr.pts.map((p) => { const q = T(p); return { x: q.x, y: q.y, b: p.b }; }), closed: pr.closed }); break;
      case 'text': out.push({ t: 'text', pos: T(pr.pos), height: pr.height * Math.abs(sy), value: pr.value, rot: pr.rot + rotDeg }); break;
    }
  }
  return out;
}

/** Разбор DXF в примитивы (с раскрытием блоков INSERT). */
export function readDxfPrims(text: string): { layer: string; prims: DxfPrim[] }[] {
  const pairs = parseDxfPairs(text);
  const blocks = readDxfBlocks(pairs);
  const out: { layer: string; prims: DxfPrim[] }[] = [];
  let inEntities = false;
  let i = 0;
  while (i < pairs.length) {
    const [code, val] = pairs[i];
    if (code === 2 && val === 'ENTITIES') { inEntities = true; i += 1; continue; }
    if (code === 0 && val === 'ENDSEC' && inEntities) break;
    if (!inEntities || code !== 0) { i += 1; continue; }
    const type = val;
    i += 1;
    const body: [number, string][] = [];
    while (i < pairs.length && pairs[i][0] !== 0) { body.push(pairs[i]); i += 1; }
    if (type === 'INSERT') {
      const name = str(body, 2);
      const def = blocks.get(name);
      if (def) {
        const placed = affinePrims(
          def,
          { x: num(body, 10), y: num(body, 20) },
          num(body, 41) || 1, num(body, 42) || 1, num(body, 50) || 0
        );
        out.push({ layer: str(body, 8) || '0', prims: placed });
      }
      continue;
    }
    const rec = readEntity(type, body, pairs, i);
    if (rec) { out.push(...rec.items); i = rec.next; }
    if (type === 'EOF') break;
  }
  return out;
}

export interface DxfReport {
  ok: boolean;
  version: string;
  /** Единицы файла как токен ($INSUNITS): mm / inch / cm */
  units: string;
  /** Единицы файла по-русски — для отчёта в интерфейсе */
  unitsLabel: string;
  bytes: number;
  lines: number;
  entities: Record<string, number>;
  total: number;
  layers: { name: string; entities: number }[];
  extents: [number, number, number, number] | null;
  closedContours: number;
  openContours: number;
  lengthMm: number;
  /** Замечания, из-за которых файл считается некорректным */
  warnings: string[];
  /** Справочные сообщения: не ошибка, но стоит знать (единицы, сплайны, блоки) */
  notes: string[];
}

/** Статистика и валидация DXF: структура, слои, контуры, длина, предупреждения. */
export function analyzeDxf(text: string): DxfReport {
  const pairs = parseDxfPairs(text);
  const warnings: string[] = [];
  const entities: Record<string, number> = {};
  const layerCount = new Map<string, number>();
  let inEntities = false;
  let version = '';
  let insunits = -1;
  let ext: [number, number, number, number] | null = null;
  let extMin: [number, number] | null = null;
  let extMax: [number, number] | null = null;

  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 999 && i === 0) continue;
    if (code === 9 && val === '$ACADVER') version = pairs[i + 1]?.[1] ?? '';
    if (code === 9 && val === '$INSUNITS') insunits = Number(pairs[i + 1]?.[1] ?? -1);
    if (code === 9 && (val === '$EXTMIN' || val === '$EXTMAX')) {
      // Координаты переменной идут парами 10/20/30 до следующей переменной (код 9)
      let x = 0, y = 0;
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 9 && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 10) x = Number(pairs[j][1]);
        else if (pairs[j][0] === 20) y = Number(pairs[j][1]);
      }
      if (val === '$EXTMIN') extMin = [x, y]; else extMax = [x, y];
      if (extMin && extMax) ext = [extMin[0], extMin[1], extMax[0], extMax[1]];
    }
    if (code === 2 && val === 'ENTITIES') inEntities = true;
    if (code === 0 && val === 'ENDSEC') inEntities = false;
    if (!inEntities || code !== 0) continue;
    if (['LINE', 'LWPOLYLINE', 'POLYLINE', 'CIRCLE', 'ARC', 'ELLIPSE', 'SPLINE', 'TEXT', 'MTEXT', 'INSERT', 'POINT'].includes(val)) {
      entities[val] = (entities[val] ?? 0) + 1;
      for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
        if (pairs[j][0] === 8) {
          layerCount.set(pairs[j][1], (layerCount.get(pairs[j][1]) ?? 0) + 1);
          break;
        }
      }
    }
  }

  const geoms = readDxfPrims(text);
  let lengthMm = 0;
  let closed = 0;
  let open = 0;
  for (const g of geoms) {
    for (const pr of g.prims) {
      if (pr.t === 'circle') { lengthMm += 2 * Math.PI * pr.r; closed += 1; continue; }
      if (pr.t === 'arc') {
        lengthMm += (((pr.a1 - pr.a0 + 360) % 360) * Math.PI * pr.r) / 180;
        open += 1;
        continue;
      }
      if (pr.t === 'poly') {
        if (pr.closed) closed += 1; else open += 1;
        const pts = polyToPoints(pr.pts, pr.closed, 0.02);
        for (let i = 0; i < pts.length - 1; i++) lengthMm += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        if (pr.closed && pts.length > 2) lengthMm += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
        continue;
      }
      for (const pl of primToPolylines(pr, 0.02)) {
        if (pl.closed) closed += 1; else open += 1;
        for (let i = 0; i < pl.pts.length - 1; i++) lengthMm += Math.hypot(pl.pts[i + 1].x - pl.pts[i].x, pl.pts[i + 1].y - pl.pts[i].y);
      }
    }
  }

  const notes: string[] = [];
  if (insunits === 1) notes.push('файл в дюймах — проверьте, что CAM читает его как дюймовый');
  if (version === 'AC1009' && insunits < 0) notes.push('в R12 единицы не указываются — по соглашению миллиметры');
  if ((entities.SPLINE ?? 0) > 0) notes.push('есть сплайны: часть CAM-программ режет их только после аппроксимации');
  if ((entities.INSERT ?? 0) > 0) notes.push('повторяющиеся детали оформлены блоками INSERT — при импорте раскрываются');
  if ((entities.ELLIPSE ?? 0) > 0) notes.push('есть эллипсы: поддерживаются с AutoCAD R13/R2000 и новее');

  if (!/EOF\s*$/.test(text)) warnings.push('нет маркера EOF в конце файла');
  if (!version) warnings.push('не определена версия ($ACADVER)');
  if (version === 'AC1015') {
    if (!text.includes('BLOCK_RECORD')) warnings.push('R2000 без таблицы BLOCK_RECORD');
    if (!/\r\n5\r\n[0-9A-F]+\r\n/.test(text)) warnings.push('R2000 без дескрипторов объектов (код 5)');
    if (!text.includes('AcDbEntity')) warnings.push('R2000 без маркеров подклассов (AcDbEntity)');
  }
  if (version === 'AC1015' && insunits < 0) warnings.push('не заданы единицы ($INSUNITS)');
  if (ext && (ext[2] < ext[0] || ext[3] < ext[1])) warnings.push('$EXTMIN/$EXTMAX заданы неверно');
  if (ext && Math.abs(ext[2] - ext[0]) > 100000) warnings.push('габарит больше 100 м — проверьте масштаб файла');
  if (closed === 0 && open > 0) warnings.push('все контуры разомкнуты — CAM может не распознать детали');
  if (!geoms.length) warnings.push('в файле нет геометрии');

  const total = Object.values(entities).reduce((s, n) => s + n, 0);
  return {
    ok: warnings.length === 0,
    version: version || 'unknown',
    units: insunits === 1 ? 'inch' : insunits === 4 ? 'mm' : insunits === 5 ? 'cm' : insunits > 0 ? `INSUNITS ${insunits}` : 'не заданы',
    unitsLabel: insunits === 1 ? 'дюймы' : insunits === 4 ? 'мм' : insunits === 5 ? 'см' : insunits > 0 ? 'неизвестные' : 'не заданы',
    bytes: text.length,
    lines: text.split(/\r?\n/).length,
    entities,
    total,
    layers: [...layerCount.entries()].map(([name, count]) => ({ name, entities: count })),
    extents: ext,
    closedContours: closed,
    openContours: open,
    lengthMm,
    warnings,
    notes,
  };
}

export interface DxfAccuracy {
  /** Максимальное отклонение геометрии файла от исходной, мм */
  maxDeviationMm: number;
  /** Среднее отклонение, мм */
  avgDeviationMm: number;
  /** Отклонение габарита, мм */
  bboxDeviationMm: number;
  /** Отклонение суммарной длины контуров, % */
  lengthDeviationPct: number;
  /** Число проверенных точек */
  samples: number;
  ok: boolean;
}

function samplePrimPoints(prims: DxfPrim[], tol: number, stepMm: number): Pt[] {
  const pts: Pt[] = [];
  for (const pr of prims) {
    for (const pl of primToPolylines(pr, tol)) {
      let acc = stepMm;
      for (let i = 0; i < pl.pts.length - 1; i++) {
        const a = pl.pts[i], b = pl.pts[i + 1];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (seg < 1e-9) continue;
        if (acc >= stepMm) { pts.push(a); acc = 0; }
        acc += seg;
      }
      if (pl.pts.length) pts.push(pl.pts[pl.pts.length - 1]);
    }
  }
  return pts;
}

/** Расстояние от точки до ближайшего примитива набора. */
export function distToPrimSet(p: Pt, prims: DxfPrim[], tol: number): number {
  let best = Infinity;
  for (const pr of prims) {
    if (pr.t === 'circle') {
      best = Math.min(best, Math.abs(Math.hypot(p.x - pr.c.x, p.y - pr.c.y) - pr.r));
      continue;
    }
    if (pr.t === 'arc') {
      const d = Math.hypot(p.x - pr.c.x, p.y - pr.c.y);
      const ang = (Math.atan2(p.y - pr.c.y, p.x - pr.c.x) * 180) / Math.PI;
      const span = ((pr.a1 - pr.a0) + 360) % 360;
      const rel = ((ang - pr.a0) + 360) % 360;
      if (rel <= span) { best = Math.min(best, Math.abs(d - pr.r)); continue; }
      const e0 = { x: pr.c.x + pr.r * Math.cos((pr.a0 * Math.PI) / 180), y: pr.c.y + pr.r * Math.sin((pr.a0 * Math.PI) / 180) };
      const e1 = { x: pr.c.x + pr.r * Math.cos((pr.a1 * Math.PI) / 180), y: pr.c.y + pr.r * Math.sin((pr.a1 * Math.PI) / 180) };
      best = Math.min(best, Math.hypot(p.x - e0.x, p.y - e0.y), Math.hypot(p.x - e1.x, p.y - e1.y));
      continue;
    }
    for (const pl of primToPolylines(pr, tol)) {
      for (let i = 0; i < pl.pts.length - 1; i++) {
        const a = pl.pts[i], b = pl.pts[i + 1];
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2)) : 0;
        best = Math.min(best, Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t)));
      }
    }
  }
  return best;
}

/** Суммарная длина всех примитивов, мм. */
export function lengthOfPrims(prims: DxfPrim[], tol: number): number {
  let len = 0;
  for (const pr of prims) {
    if (pr.t === 'circle') { len += 2 * Math.PI * pr.r; continue; }
    if (pr.t === 'arc') {
      len += ((((pr.a1 - pr.a0) + 360) % 360) * Math.PI * pr.r) / 180;
      continue;
    }
    for (const pl of primToPolylines(pr, tol)) {
      for (let i = 0; i < pl.pts.length - 1; i++) {
        len += Math.hypot(pl.pts[i + 1].x - pl.pts[i].x, pl.pts[i + 1].y - pl.pts[i].y);
      }
      if (pl.closed && pl.pts.length > 2) {
        len += Math.hypot(pl.pts[0].x - pl.pts[pl.pts.length - 1].x, pl.pts[0].y - pl.pts[pl.pts.length - 1].y);
      }
    }
  }
  return len;
}

/**
 * Проверка точности: сравнивает геометрию, подготовленную к экспорту, с той, что
 * реально прочиталась из DXF. Отклонение должно быть в пределах допуска
 * аппроксимации — это и есть гарантия «точного DXF».
 */
export function measureDxfAccuracy(doc: LaserDoc, text: string, o: Partial<DxfOptions> = {}): DxfAccuracy {
  const opts = normalizeDxfOptions(o);
  // Эталон строим с мелким допуском, иначе грубая аппроксимация сравнивалась бы
  // сама с собой и отклонение всегда было бы нулевым.
  const tol = Math.min(opts.tolerance, 0.002);
  const { geoms, extents } = collectDxfGeometry(doc, { ...opts, tolerance: tol });
  const srcPrims = geoms.flatMap((g) => g.prims);
  const backPrims = readDxfPrims(text).flatMap((g) => g.prims);
  const toMm = opts.units === 'inch' ? 25.4 : 1;

  const step = Math.max(0.5, tol * 100);
  let maxDev = 0;
  let sumDev = 0;
  let n = 0;
  for (const p of samplePrimPoints(srcPrims, tol, step)) {
    const d = distToPrimSet(p, backPrims, tol) * toMm;
    if (Number.isFinite(d)) { maxDev = Math.max(maxDev, d); sumDev += d; n += 1; }
  }
  for (const p of samplePrimPoints(backPrims, tol, step)) {
    const d = distToPrimSet({ x: p.x * toMm, y: p.y * toMm }, srcPrims, tol) * toMm;
    if (Number.isFinite(d)) { maxDev = Math.max(maxDev, d); sumDev += d; n += 1; }
  }

  const srcLen = lengthOfPrims(srcPrims, tol);
  const backLen = lengthOfPrims(backPrims, tol) * toMm;
  const bb = primsBBox(backPrims, tol);
  const bboxDev = bb && extents
    ? Math.max(
      Math.abs(bb[0] * toMm - extents[0]), Math.abs(bb[1] * toMm - extents[1]),
      Math.abs(bb[2] * toMm - extents[2]), Math.abs(bb[3] * toMm - extents[3])
    )
    : 0;

  return {
    maxDeviationMm: maxDev,
    avgDeviationMm: n ? sumDev / n : 0,
    bboxDeviationMm: bboxDev,
    lengthDeviationPct: srcLen > 0 ? (Math.abs(backLen - srcLen) / srcLen) * 100 : 0,
    samples: n,
    ok: n > 0 && maxDev <= Math.max(opts.tolerance * 4, 0.02) && bboxDev <= 0.05,
  };
}

/** Габарит геометрии, подготовленной к экспорту (в единицах файла). */
export function dxfExtents(doc: LaserDoc, o: Partial<DxfOptions> = {}): [number, number, number, number] | null {
  return collectDxfGeometry(doc, o).extents;
}

// ---------------- импорт DXF → объекты редактора ----------------

function layerIdFromName(name: string, aci?: number): LaserLayerId {
  const n = name.toLowerCase();
  if (n.includes('fold') || n.includes('bigov') || n.includes('crease')) return 'fold';
  if (n.includes('score') || n.includes('mark') || n.includes('razmet')) return 'score';
  if (n.includes('inner') || n.includes('hole') || n.includes('otverst')) return 'inner';
  if (n.includes('engrav') || n.includes('grav')) return 'engrave';
  if (n.includes('guide') || n.includes('dim') || n.includes('axis') || n.includes('razmer')) return 'guide';
  if (n.includes('cut') || n.includes('rez')) return 'cut';
  switch (aci) {
    case 1: return 'cut';
    case 2: return 'engrave';
    case 3: return 'fold';
    case 5: return 'score';
    case 6: return 'inner';
    case 8: return 'guide';
    default: return 'cut';
  }
}

/** Цвета слоёв из таблицы LAYER (для распознавания слоя по цвету). */
function aciOfLayerTable(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const pairs = parseDxfPairs(text);
  let inTables = false;
  for (let i = 0; i < pairs.length; i++) {
    const [code, val] = pairs[i];
    if (code === 2 && val === 'TABLES') inTables = true;
    if (code === 0 && val === 'ENDSEC' && inTables) inTables = false;
    if (!inTables || code !== 0 || val !== 'LAYER') continue;
    let name = '';
    let color = 7;
    for (let j = i + 1; j < pairs.length && pairs[j][0] !== 0; j++) {
      if (pairs[j][0] === 2) name = pairs[j][1];
      if (pairs[j][0] === 62) color = Number(pairs[j][1]);
    }
    if (name) map.set(name.toUpperCase(), color);
  }
  return map;
}

let idSeq = 1;
function dxfId(): string {
  return `dxf_${Date.now().toString(36)}_${(idSeq++).toString(36)}`;
}

/** Единицы файла: 1 = дюймы (переводим в мм), иначе миллиметры. */
export function dxfUnitsScale(text: string): number {
  const pairs = parseDxfPairs(text);
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      const u = Number(pairs[i + 1]?.[1] ?? 4);
      if (u === 1) return 25.4;
      if (u === 5) return 10;
      return 1;
    }
    if (pairs[i][0] === 0 && pairs[i][1] === 'SECTION' && pairs[i + 1]?.[1] === 'ENTITIES') break;
  }
  return 1;
}

/** Импорт DXF: примитивы → объекты редактора (слои по имени и цвету). */
export function dxfToShapes(text: string): LaserShape[] {
  const groups = readDxfPrims(text);
  const colors = aciOfLayerTable(text);
  const us = dxfUnitsScale(text);
  const shapes: LaserShape[] = [];

  for (const g of groups) {
    const aci = colors.get(g.layer.toUpperCase());
    const layer = layerIdFromName(g.layer, aci);
    for (const pr of g.prims) {
      if (pr.t === 'text') continue;
      if (pr.t === 'circle') {
        shapes.push({
          id: dxfId(), kind: 'ellipse', layer, name: 'DXF Окружность',
          cx: pr.c.x * us, cy: pr.c.y * us, rx: pr.r * us, ry: pr.r * us,
          rot: 0, startAngle: 0, endAngle: 360, filled: false,
        });
        continue;
      }
      const isFullEllipse = pr.t === 'ellipse' && Math.abs(Math.abs(pr.a1 - pr.a0) - 360) < 1e-6;
      if (isFullEllipse && pr.t === 'ellipse') {
        shapes.push({
          id: dxfId(), kind: 'ellipse', layer, name: 'DXF Эллипс',
          cx: pr.c.x * us, cy: pr.c.y * us, rx: pr.rx * us, ry: pr.ry * us,
          rot: pr.rot, startAngle: 0, endAngle: 360, filled: false,
        });
        continue;
      }
      const name =
        pr.t === 'arc' ? 'DXF Дуга'
          : pr.t === 'ellipse' ? 'DXF Эллипс'
            : pr.t === 'spline' ? 'DXF Сплайн'
              : pr.t === 'line' ? 'DXF Отрезок' : 'DXF Полилиния';
      for (const pl of primToPolylines(pr, 0.02)) {
        if (pl.pts.length < 2) continue;
        const nodes: PathNode[] = pl.pts.map((p) => ({ x: p.x * us, y: p.y * us }));
        shapes.push({ id: dxfId(), kind: 'path', layer, name, nodes, closed: pl.closed, filled: false });
      }
    }
  }
  return shapes;
}

/** Круговой тест: экспортировать и прочитать обратно (используется в проверке точности). */
export function dxfRoundTripShapes(doc: LaserDoc, o: Partial<DxfOptions> = {}): LaserShape[] {
  return dxfToShapes(exportDxf(doc, o));
}
