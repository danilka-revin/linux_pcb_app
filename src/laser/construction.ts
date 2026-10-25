// Вспомогательные (построительные) линии чертежа: перпендикуляр, параллель,
// касательная, биссектриса, серединный перпендикуляр, направление под углом,
// горизонталь и вертикаль. Как в CAD: линия строится по существующей геометрии
// и живёт на служебном слое — в файлы (DXF, PDF, EPS, PLT, SVG) не попадает.
//
// Всё в миллиметрах листа, Y направлен вверх, углы в градусах против часовой
// стрелки от оси +X. Модуль чистый: geometry in — geometry out, без DOM.

import {
  shapeToPolylines,
  type LaserShape,
  type Pt,
} from './model';

/** Режимы построения вспомогательной линии. */
export type AuxMode =
  | 'angle'      // из точки под заданным углом
  | 'h'          // горизонталь через точку
  | 'v'          // вертикаль через точку
  | 'perp'       // перпендикуляр к объекту (или к отрезку между кликами)
  | 'parallel'   // параллель объекту на расстоянии
  | 'tangent'    // касательная к окружности, дуге, эллипсу или кривой
  | 'bisector'   // биссектриса угла по трём точкам
  | 'midperp';   // серединный перпендикуляр к отрезку

/** Сколько кликов нужно режиму и чем он строится. */
export const AUX_MODES: {
  id: AuxMode;
  name: string;
  key: string;
  clicks: 1 | 2 | 3;
  needsBase: boolean;
  hint: string;
}[] = [
  {
    id: 'perp', name: 'Перпендикуляр', key: '1', clicks: 2, needsBase: true,
    hint: 'клик по объекту-базе, затем точка: линия через точку под 90° к базе',
  },
  {
    id: 'parallel', name: 'Параллель', key: '2', clicks: 2, needsBase: true,
    hint: 'клик по объекту-базе, затем точка: линия параллельно базе (расстояние — в поле или по клику)',
  },
  {
    id: 'tangent', name: 'Касательная', key: '3', clicks: 2, needsBase: true,
    hint: 'клик по окружности, дуге, эллипсу или кривой, затем внешняя точка: линия касается базы',
  },
  {
    id: 'angle', name: 'По углу', key: '4', clicks: 1, needsBase: false,
    hint: 'один клик: линия из точки под углом из поля «Угол, °» (Shift — шаг 15°)',
  },
  {
    id: 'midperp', name: 'Серединный перпендикуляр', key: '5', clicks: 2, needsBase: false,
    hint: 'два клика задают отрезок: линия через его середину под 90°',
  },
  {
    id: 'bisector', name: 'Биссектриса', key: '6', clicks: 3, needsBase: false,
    hint: 'три клика: точка — вершина — точка; линия делит угол пополам',
  },
  {
    id: 'h', name: 'Горизонталь', key: '7', clicks: 1, needsBase: false,
    hint: 'один клик: горизонтальная ось через точку',
  },
  {
    id: 'v', name: 'Вертикаль', key: '8', clicks: 1, needsBase: false,
    hint: 'один клик: вертикальная ось через точку',
  },
];

/** Параметры построения из панели инструмента. */
export interface AuxParams {
  /** Угол наклона, градусы — для режима «По углу». */
  angleDeg: number;
  /** Расстояние до параллели, мм. 0 — параллель ровно через точку клика. */
  distance: number;
  /** Длина вспомогательной линии, мм (центрируется в опорной точке). */
  length: number;
  /** Растянуть линию на весь лист вместо фиксированной длины. */
  fullSheet: boolean;
}

export const DEFAULT_AUX_PARAMS: AuxParams = {
  angleDeg: 45,
  distance: 0,
  length: 200,
  fullSheet: true,
};

/** Результат построения: отрезок линии и её подпись. */
export interface AuxLine {
  a: Pt;
  b: Pt;
  name: string;
  /** Точка касания или основание перпендикуляра — для маркера на листе. */
  mark?: Pt;
}

const EPS = 1e-9;

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const len = (a: Pt) => Math.hypot(a.x, a.y);
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x;

/** Единичный вектор; для нулевого возвращает null. */
export function unit(a: Pt): Pt | null {
  const l = len(a);
  return l > EPS ? { x: a.x / l, y: a.y / l } : null;
}

/** Поворот вектора на угол в градусах (против часовой стрелки). */
export function rotDeg(a: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Перпендикуляр к вектору (поворот на +90°). */
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });

/** Ближайшая точка и направление на отрезке. */
function nearestOnSegment(a: Pt, b: Pt, p: Pt): { point: Pt; dir: Pt; dist: number } | null {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 <= EPS) return null;
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const point = add(a, mul(ab, t));
  const d = unit(ab);
  if (!d) return null;
  return { point, dir: d, dist: len(sub(p, point)) };
}

interface NearHit {
  point: Pt;
  /** Единичное направление (касательная) в ближайшей точке. */
  dir: Pt;
  dist: number;
}

/** Точный эллипс/дуга: параметрическая точка и касательная. */
function ellipsePointDir(shape: LaserShape & { kind: 'ellipse' }, th: number): { point: Pt; dir: Pt } {
  const r = ((shape.rot ?? 0) * Math.PI) / 180;
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const px = shape.rx * Math.cos(th);
  const py = shape.ry * Math.sin(th);
  const dx = -shape.rx * Math.sin(th);
  const dy = shape.ry * Math.cos(th);
  return {
    point: { x: shape.cx + px * cr - py * sr, y: shape.cy + px * sr + py * cr },
    dir: { x: dx * cr - dy * sr, y: dx * sr + dy * cr },
  };
}

/** Диапазон углов эллипса в радианах (с учётом направления дуги). */
function ellipseRange(shape: LaserShape & { kind: 'ellipse' }): [number, number] {
  const a0 = ((shape.startAngle ?? 0) * Math.PI) / 180;
  const a1 = ((shape.endAngle ?? 360) * Math.PI) / 180;
  return a1 >= a0 ? [a0, a1] : [a1, a0];
}

/**
 * Ближайшая точка объекта и касательная в ней.
 *
 * Окружности, дуги и эллипсы считаются аналитически (точно), остальные
 * объекты — по полилиниям: для прямых рёбер это точно, для Безье — с
 * точностью аппроксимации, которой достаточно для вспомогательных линий.
 */
export function nearestOnShape(shape: LaserShape, p: Pt, steps = 512): NearHit | null {
  if (shape.kind === 'text' || shape.kind === 'dim') return null;

  if (shape.kind === 'ellipse' && shape.rx > EPS && shape.ry > EPS) {
    const [t0, t1] = ellipseRange(shape);
    let best: NearHit | null = null;
    const n = Math.max(64, steps);
    for (let i = 0; i <= n; i++) {
      const th = t0 + ((t1 - t0) * i) / n;
      const { point, dir } = ellipsePointDir(shape, th);
      const u = unit(dir);
      if (!u) continue;
      const d = len(sub(p, point));
      if (!best || d < best.dist) best = { point, dir: u, dist: d };
    }
    return best;
  }

  let best: NearHit | null = null;
  for (const pl of shapeToPolylines(shape)) {
    for (let i = 0; i + 1 < pl.length; i++) {
      const hit = nearestOnSegment(pl[i], pl[i + 1], p);
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
  }
  return best;
}

/** Центр и радиус полной окружности, если объект ей является. */
export function circleOf(shape: LaserShape): { c: Pt; r: number } | null {
  if (shape.kind !== 'ellipse') return null;
  if (Math.abs(shape.rx - shape.ry) > 1e-6) return null;
  const a0 = shape.startAngle ?? 0;
  const a1 = shape.endAngle ?? 360;
  if (Math.abs(Math.abs(a1 - a0) - 360) > 1e-6) return null;
  return { c: { x: shape.cx, y: shape.cy }, r: shape.rx };
}

/**
 * Точки касания из внешней точки: для окружности — аналитически (две),
 * для эллипса, дуги и кривой — поиском по параметру с уточнением.
 */
export function tangentPoints(shape: LaserShape, p: Pt): { point: Pt; dir: Pt }[] {
  const circle = circleOf(shape);
  if (circle) {
    const v = sub(p, circle.c);
    const d = len(v);
    if (d <= circle.r + EPS) return [];
    const u = mul(v, 1 / d);
    const alpha = Math.acos(Math.max(-1, Math.min(1, circle.r / d)));
    const out: { point: Pt; dir: Pt }[] = [];
    for (const sgn of [1, -1]) {
      const th = Math.atan2(u.y, u.x) + sgn * alpha;
      const point = add(circle.c, { x: circle.r * Math.cos(th), y: circle.r * Math.sin(th) });
      const dir = unit(perp(sub(point, circle.c)));
      if (dir) out.push({ point, dir });
    }
    return out;
  }

  if (shape.kind === 'ellipse' && shape.rx > EPS && shape.ry > EPS) {
    // Касательная в E(θ) проходит через точку P, когда P лежит на прямой
    // вдоль касательной: cross(P − E(θ), T(θ)) = 0. У внешней точки ровно два
    // таких корня, у внутренней — ни одного (касательных не существует).
    const [t0, t1] = ellipseRange(shape);
    const f = (th: number) => {
      const { point, dir } = ellipsePointDir(shape, th);
      return cross(sub(p, point), dir);
    };
    const span = t1 - t0;
    const roots: number[] = [];
    const push = (th: number) => {
      // стык диапазона (0 и 2π) и повторные попадания не должны плодить дубли
      if (roots.some((r) => {
        const d = Math.abs(r - th) % (span || 1);
        return Math.min(d, Math.abs(span) - d) < Math.abs(span) * 1e-4;
      })) return;
      roots.push(th);
    };
    const n = 1024;
    let prevTh = t0;
    let prev = f(t0);
    if (Math.abs(prev) < 1e-12) push(prevTh);
    for (let i = 1; i <= n; i++) {
      const th = t0 + (span * i) / n;
      const cur = f(th);
      if ((prev < 0 && cur > 0) || (prev > 0 && cur < 0)) {
        let lo = prevTh;
        let hi = th;
        for (let k = 0; k < 60; k++) {
          const mid = (lo + hi) / 2;
          if ((f(lo) < 0) === (f(mid) < 0)) lo = mid;
          else hi = mid;
        }
        push((lo + hi) / 2);
      } else if (Math.abs(cur) < 1e-12) {
        push(th);
      }
      prevTh = th;
      prev = cur;
    }
    if (roots.length) {
      return roots.map((th) => {
        const { point, dir } = ellipsePointDir(shape, th);
        const u = unit(dir) ?? { x: 1, y: 0 };
        return { point, dir: u };
      });
    }
    // У дуги касательной из этой точки может просто не существовать (обе
    // касательные полного круга лежат вне её диапазона). Тогда берём
    // касательную в ближайшей точке дуги — это тоже касательная к объекту.
    // Полный эллипс так не спасаем: из внутренней точки касательных нет вовсе.
    const isFull = Math.abs(Math.abs(span) - Math.PI * 2) < 1e-9;
    if (!isFull) {
      const near = nearestOnShape(shape, p);
      if (near) return [{ point: near.point, dir: near.dir }];
    }
    return [];
  }

  // Общий случай (кривая, прямоугольник, многоугольник): касательная в ближайшей точке.
  const near = nearestOnShape(shape, p);
  return near ? [{ point: near.point, dir: near.dir }] : [];
}

/** Точка внутри замкнутого кольца (для клика «внутри» контура). */
function insideRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Замкнутый контур объекта, если он есть. */
function closedRing(shape: LaserShape): Pt[] | null {
  if (shape.kind === 'rect' || shape.kind === 'polygon') return shapeToPolylines(shape)[0] ?? null;
  if (shape.kind === 'ellipse') {
    const a0 = shape.startAngle ?? 0;
    const a1 = shape.endAngle ?? 360;
    if (Math.abs(Math.abs(a1 - a0) - 360) < 1e-6) return shapeToPolylines(shape)[0] ?? null;
    return null;
  }
  if (shape.kind === 'path' && shape.closed) return shapeToPolylines(shape)[0] ?? null;
  return null;
}

/**
 * Объект-база под курсором.
 *
 * Сначала — ближайшее попадание в контур (так точнее для линий и кривых),
 * затем запасной вариант: клик внутри замкнутого контура. Иначе по
 * окружности пришлось бы целиться точно в её обвод, что на мелком масштабе
 * неудобно.
 */
export function pickBase(shapes: LaserShape[], p: Pt, tolMm: number): LaserShape | null {
  let best: { shape: LaserShape; dist: number } | null = null;
  for (const s of shapes) {
    if (s.hidden || s.locked) continue;
    if (s.kind === 'text' || s.kind === 'dim') continue;
    const near = nearestOnShape(s, p, 256);
    if (!near) continue;
    if (near.dist <= tolMm && (!best || near.dist < best.dist)) best = { shape: s, dist: near.dist };
  }
  if (best) return best.shape;

  // клик внутри замкнутого контура: берём верхний (последний в списке) объект
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i];
    if (s.hidden || s.locked || s.kind === 'text' || s.kind === 'dim') continue;
    const ring = closedRing(s);
    if (ring && ring.length >= 3 && insideRing(p, ring)) return s;
  }
  return null;
}

/** Пересечение прямой (точка + направление) с прямоугольником листа. */
export function clipToSheet(anchor: Pt, dir: Pt, sheet: { w: number; h: number }): { a: Pt; b: Pt } | null {
  const d = unit(dir);
  if (!d) return null;
  let tMin = -Infinity;
  let tMax = Infinity;
  // X
  if (Math.abs(d.x) > EPS) {
    const t1 = (0 - anchor.x) / d.x;
    const t2 = (sheet.w - anchor.x) / d.x;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (anchor.x < -EPS || anchor.x > sheet.w + EPS) {
    return null;
  }
  // Y
  if (Math.abs(d.y) > EPS) {
    const t1 = (0 - anchor.y) / d.y;
    const t2 = (sheet.h - anchor.y) / d.y;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
  } else if (anchor.y < -EPS || anchor.y > sheet.h + EPS) {
    return null;
  }
  if (!(tMax - tMin > EPS)) return null;
  return { a: add(anchor, mul(d, tMin)), b: add(anchor, mul(d, tMax)) };
}

/** Отрезок заданной длины с центром в опорной точке (или на весь лист). */
function span(anchor: Pt, dir: Pt, params: AuxParams, sheet?: { w: number; h: number }): { a: Pt; b: Pt } | null {
  const d = unit(dir);
  if (!d) return null;
  if (params.fullSheet && sheet) return clipToSheet(anchor, d, sheet);
  const half = Math.max(params.length, 0.1) / 2;
  return { a: add(anchor, mul(d, -half)), b: add(anchor, mul(d, half)) };
}

/** Вход построения: клики пользователя, база и параметры. */
export interface AuxInput {
  mode: AuxMode;
  /** Клики по порядку; для режимов с базой первый клик — объект-база. */
  pts: Pt[];
  /** Объект-база, если первый клик попал в объект. */
  base?: LaserShape | null;
  params: AuxParams;
  /** Размер листа для режима «на весь лист». */
  sheet?: { w: number; h: number };
}

/**
 * Построение вспомогательной линии.
 *
 * Возвращает null, если геометрия не позволяет построить линию (например,
 * точка внутри окружности для касательной) — вызывающая сторона показывает
 * понятное сообщение.
 */
export function buildAuxLine(input: AuxInput): AuxLine | null {
  const { mode, pts, base, params, sheet } = input;

  switch (mode) {
    case 'h':
    case 'v': {
      const p = pts[0];
      if (!p) return null;
      const dir = mode === 'h' ? { x: 1, y: 0 } : { x: 0, y: 1 };
      const seg = span(p, dir, params, sheet);
      if (!seg) return null;
      return { a: seg.a, b: seg.b, name: mode === 'h' ? 'Вспомогательная: горизонталь' : 'Вспомогательная: вертикаль' };
    }

    case 'angle': {
      const p = pts[0];
      if (!p) return null;
      const dir = rotDeg({ x: 1, y: 0 }, params.angleDeg);
      const seg = span(p, dir, params, sheet);
      if (!seg) return null;
      return {
        a: seg.a, b: seg.b,
        name: `Вспомогательная: угол ${Number(params.angleDeg.toFixed(2))}°`,
      };
    }

    case 'perp': {
      const [p1, p2] = pts;
      if (!p1 || !p2) return null;
      let dir: Pt | null = null;
      let mark: Pt | undefined;
      if (base) {
        const near = nearestOnShape(base, p2);
        if (near) {
          dir = perp(near.dir);
          mark = near.point;
        }
      }
      if (!dir) {
        // базы нет — перпендикуляр к отрезку между первым и вторым кликом
        const ab = unit(sub(p2, p1));
        if (!ab) return null;
        dir = perp(ab);
      }
      const seg = span(p2, dir, params, sheet);
      if (!seg) return null;
      return { a: seg.a, b: seg.b, mark, name: 'Вспомогательная: перпендикуляр' };
    }

    case 'parallel': {
      const [p1, p2] = pts;
      if (!p1 || !p2 || !base) return null;
      const near = nearestOnShape(base, p2);
      if (!near) return null;
      const dist = Math.abs(params.distance);
      if (dist > EPS) {
        // ровное расстояние от базы в сторону точки клика
        const n = perp(near.dir);
        const side = Math.sign(dot(sub(p2, near.point), n)) || 1;
        const anchor = add(near.point, mul(n, side * dist));
        const seg = span(anchor, near.dir, params, sheet);
        if (!seg) return null;
        return {
          a: seg.a, b: seg.b, mark: near.point,
          name: `Вспомогательная: параллель ${dist.toFixed(2)} мм`,
        };
      }
      const seg = span(p2, near.dir, params, sheet);
      if (!seg) return null;
      return { a: seg.a, b: seg.b, mark: near.point, name: 'Вспомогательная: параллель' };
    }

    case 'tangent': {
      const [p1, p2] = pts;
      if (!p1 || !p2 || !base) return null;
      const cands = tangentPoints(base, p2);
      if (!cands.length) return null;
      // из двух касательных берём ближайшую к первому клику (обычно он на базе)
      let best = cands[0];
      let bestD = len(sub(best.point, p1));
      for (const c of cands) {
        const d = len(sub(c.point, p1));
        if (d < bestD) { best = c; bestD = d; }
      }
      const dir = unit(sub(best.point, p2));
      if (!dir) return null;
      // линия идёт из внешней точки через точку касания и дальше на длину L
      const half = params.fullSheet && sheet
        ? null
        : Math.max(params.length, 0.1) / 2;
      if (half === null && sheet) {
        const seg = clipToSheet(p2, dir, sheet);
        if (!seg) return null;
        return { a: seg.a, b: seg.b, mark: best.point, name: 'Вспомогательная: касательная' };
      }
      const b = add(p2, mul(dir, half ?? Math.max(params.length, 0.1)));
      return { a: p2, b, mark: best.point, name: 'Вспомогательная: касательная' };
    }

    case 'midperp': {
      const [p1, p2] = pts;
      if (!p1 || !p2) return null;
      const ab = sub(p2, p1);
      const d = unit(ab);
      if (!d) return null;
      const mid = add(p1, mul(ab, 0.5));
      const seg = span(mid, perp(d), params, sheet);
      if (!seg) return null;
      return { a: seg.a, b: seg.b, mark: mid, name: 'Вспомогательная: серединный перпендикуляр' };
    }

    case 'bisector': {
      const [p1, p2, p3] = pts;
      if (!p1 || !p2 || !p3) return null;
      const u1 = unit(sub(p1, p2));
      const u2 = unit(sub(p3, p2));
      if (!u1 || !u2) return null;
      const dir = unit(add(u1, u2));
      if (!dir) {
        // развёрнутый угол: биссектриса — перпендикуляр к любому из лучей
        const seg0 = span(p2, perp(u1), params, sheet);
        if (!seg0) return null;
        return { a: seg0.a, b: seg0.b, mark: p2, name: 'Вспомогательная: биссектриса' };
      }
      const seg = span(p2, dir, params, sheet);
      if (!seg) return null;
      const half = Math.abs((Math.acos(Math.max(-1, Math.min(1, dot(u1, u2)))) * 180) / Math.PI / 2);
      return {
        a: seg.a, b: seg.b, mark: p2,
        name: `Вспомогательная: биссектриса ${half.toFixed(1)}°`,
      };
    }
  }
}

/**
 * Предпросмотр: та же линия, но по неполному набору кликов.
 *
 * Пока кликов меньше, чем нужно режиму, последний клик заменяется положением
 * курсора — поэтому линия «тянется» за мышью.
 */
export function previewAuxLine(input: AuxInput, cursor: Pt): AuxLine | null {
  const need = AUX_MODES.find((m) => m.id === input.mode)?.clicks ?? 2;
  const pts = input.pts.slice(0, Math.max(0, need - 1));
  if (pts.length < need - 1) return null;
  pts.push(cursor);
  return buildAuxLine({ ...input, pts });
}

/** Угол направления в градусах [0; 360). */
export function dirAngleDeg(dir: Pt): number {
  const a = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
}

/** Расстояние от точки до прямой, заданной точкой и направлением. */
export function distToLine(p: Pt, anchor: Pt, dir: Pt): number {
  const d = unit(dir);
  if (!d) return len(sub(p, anchor));
  return Math.abs(cross(sub(p, anchor), d));
}
