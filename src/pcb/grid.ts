// Настраиваемая сетка и привязка.
//
// Возможности:
//  • шаг привязки в мм или mil (дюймовые значения — ровно 5/10/25/50/100 mil);
//  • набор готовых шагов (метрические, дюймовые, монтажные) + любое своё значение;
//  • отображение: точки, линии, перекрестия или выключено;
//  • подразбиение (1/2, 1/4, 1/5, 1/10) и «главные» линии каждые N узлов;
//  • своё начало сетки (смещение по X/Y) — сетка привязывается к удобной точке;
//  • привязка к объектам платы (центры площадок, концы/середины дорожек и т. п.).
//
// Модуль намеренно не тянет за собой canvas/React: математика отделена от
// отрисовки, чтобы её можно было проверять тестами (см. test/grid.ts).

import type { Entity, Pt } from './model';

export type GridUnit = 'mm' | 'mil';
export type GridStyle = 'dots' | 'lines' | 'cross' | 'none';

/** 1 mil = 0.0254 мм (ровно) */
export const MM_PER_MIL = 0.0254;

export const GRID_UNIT_NAME: Record<GridUnit, string> = { mm: 'мм', mil: 'mil' };
export const GRID_STYLE_NAME: Record<GridStyle, string> = {
  dots: 'точки', lines: 'линии', cross: 'перекрестия', none: 'выкл.',
};

export const toMm = (v: number, unit: GridUnit): number => (unit === 'mil' ? v * MM_PER_MIL : v);
export const fromMm = (mm: number, unit: GridUnit): number => (unit === 'mil' ? mm / MM_PER_MIL : mm);

/** Значение в текущих единицах, округлённое до разумного числа знаков */
export function fmtUnit(mm: number, unit: GridUnit): string {
  const v = fromMm(mm, unit);
  if (unit === 'mil') return String(Math.round(v * 100) / 100);
  return String(parseFloat(v.toFixed(4)));
}

/** «1.27 мм (50 mil)» — подпись шага сразу в двух системах */
export function fmtGridFull(mm: number): string {
  const mil = MmToMil(mm);
  const mmS = String(parseFloat(mm.toFixed(4)));
  return `${mmS} мм (${String(parseFloat(mil.toFixed(2)))} mil)`;
}

/** Перевод миллиметров в mil с удалением «мусора» плавающей точки (2.54 мм → 100 mil) */
export function MmToMil(mm: number): number {
  const m = mm / MM_PER_MIL;
  const r = Math.round(m);
  return Math.abs(m - r) < 1e-6 ? r : m;
}

// ------------------------------------------------------------------ пресеты

export interface GridPreset {
  /** шаг в мм */
  mm: number;
  /** короткая подпись («1.27 мм · 50 mil») */
  label: string;
  group: string;
}

export const GRID_GROUPS = [
  'Метрическая, мм',
  'Дюймовая (mil / шаг 2.54)',
  'Крупный шаг и монтаж',
] as const;

const metric = [
  0.02, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5,
  0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.5, 1.6, 1.75, 2, 2.2,
  2.25, 2.5, 2.8, 3, 3.2, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30,
];
const mils = [
  2.5, 3, 4, 5, 6.25, 8, 10, 12.5, 15, 20, 24, 25, 30, 31.25, 35, 40, 45, 50,
  60, 62.5, 75, 80, 90, 100, 120, 125, 150, 175, 200, 225, 250, 300, 400, 500, 600, 1000,
];
const large = [6.35, 7.62, 10.16, 12.5, 12.7, 15.24, 19.05, 22.86, 25.4, 30.48, 38.1, 50.8];

/** Ровно ли значение выражается в mil (2.54 мм = 100 mil → да) */
export const isExactMil = (mm: number): boolean => {
  const mil = mm / MM_PER_MIL;
  return Math.abs(mil - Math.round(mil)) < 1e-6;
};

const presetLabel = (mm: number, unit: GridUnit): string => {
  const mmS = String(parseFloat(mm.toFixed(4)));
  const milS = String(Math.round((mm / MM_PER_MIL) * 100) / 100);
  if (unit === 'mil') return `${milS} mil · ${mmS} мм`;
  return isExactMil(mm) ? `${mmS} мм · ${milS} mil` : `${mmS} мм`;
};

/** Все готовые шаги (по возрастанию, без дублей). */
export function gridPresets(unit: GridUnit = 'mm'): GridPreset[] {
  const all: { mm: number; group: string; inch: boolean }[] = [
    ...metric.map((mm) => ({ mm, group: GRID_GROUPS[0] as string, inch: false })),
    ...mils.map((m) => ({ mm: m * MM_PER_MIL, group: GRID_GROUPS[1] as string, inch: true })),
    ...large.map((mm) => ({ mm, group: GRID_GROUPS[2] as string, inch: false })),
  ];
  // одинаковые шаги (0.127 мм = 5 mil) оставляем один раз — в «своей» системе
  const seen = new Set<number>();
  const out: GridPreset[] = [];
  for (const p of all.sort((a, b) => a.mm - b.mm || Number(b.inch) - Number(a.inch))) {
    const key = Math.round(p.mm * 1e6);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mm: p.mm, label: presetLabel(p.mm, unit), group: p.group });
  }
  return out;
}

/** Плоский список шагов (мм), по возрастанию и без повторов */
export const GRID_STEPS_MM: number[] = gridPresets('mm').map((p) => p.mm);

/** Есть ли точное совпадение шага с пресетом */
export const isPresetStep = (mm: number): boolean =>
  GRID_STEPS_MM.some((p) => Math.abs(p - mm) < 1e-9);

/** Следующий/предыдущий пресет относительно текущего (циклично, клавиша G) */
export function cycleGrid(mm: number, dir: 1 | -1): number {
  const list = GRID_STEPS_MM;
  if (!list.length) return mm;
  const i = list.findIndex((p) => p >= mm - 1e-9);
  if (i < 0) return list[list.length - 1];
  const n = (i + dir + list.length) % list.length;
  return list[n];
}

// ------------------------------------------------------------------ настройки

export interface GridConf {
  /** шаг привязки, мм */
  step: number;
  /** единицы ввода/подписи */
  unit: GridUnit;
  /** как сетка рисуется */
  style: GridStyle;
  /** подразбиение отображения: 1 — без, 2/4/5/10 — мелкие линии */
  div: number;
  /** «главная» линия/точка каждые N узлов (1 — без) */
  major: number;
  /** начало сетки, мм */
  ox: number;
  oy: number;
  /** привязка к сетке включена */
  snap: boolean;
  /** привязка к объектам платы (площадки, концы дорожек, углы) */
  snapObj: boolean;
  /** радиус поиска объектов привязки, px экрана */
  snapPx: number;
}

export const DEFAULT_GRID: GridConf = {
  step: 1.27, unit: 'mm', style: 'dots', div: 1, major: 5,
  ox: 0, oy: 0, snap: true, snapObj: false, snapPx: 10,
};

export const DIV_OPTIONS: number[] = [1, 2, 4, 5, 10];
export const MAJOR_OPTIONS: number[] = [1, 2, 5, 10, 20];

/** Заполнить отсутствующие поля (загрузка старых сохранений) */
export const normalizeGrid = (g?: Partial<GridConf>): GridConf => ({
  ...DEFAULT_GRID,
  ...(g ?? {}),
  step: g?.step && g.step > 0 ? g.step : DEFAULT_GRID.step,
  div: DIV_OPTIONS.includes(Number(g?.div)) ? Number(g?.div) : DEFAULT_GRID.div,
  major: MAJOR_OPTIONS.includes(Number(g?.major)) ? Number(g?.major) : DEFAULT_GRID.major,
  snapPx: Math.max(2, Math.min(40, Number(g?.snapPx) || DEFAULT_GRID.snapPx)),
});

// ------------------------------------------------------------------ привязка

/** Округление к узлу сетки с учётом её начала; результат без «мусора» */
export function snapTo(v: number, step: number, origin = 0): number {
  if (!(step > 0)) return v;
  const k = Math.round((v - origin) / step);
  const r = origin + k * step;
  return Math.abs(r) < 1e-9 ? 0 : parseFloat(r.toFixed(6));
}

export function snapPoint(p: Pt, c: GridConf): Pt {
  if (!c.snap) return p;
  return { x: snapTo(p.x, c.step, c.ox), y: snapTo(p.y, c.step, c.oy) };
}

/**
 * Характерные точки примитива, к которым удобно привязываться:
 * центры площадок/переходов/отверстий, вершины и середины дорожек,
 * концы линий, углы прямоугольников, центр и квадранты окружностей.
 */
export function refPoints(e: Entity): Pt[] {
  switch (e.kind) {
    case 'pad': case 'via': case 'hole': case 'smd': case 'text':
      return [{ x: e.x, y: e.y }];
    case 'track':
      return withMids(e.pts, false);
    case 'poly':
      return withMids(e.pts, true);
    case 'line':
      return [
        { x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 },
        { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 },
      ];
    case 'rect':
      return [
        { x: e.x, y: e.y }, { x: e.x + e.w, y: e.y },
        { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h },
        { x: e.x + e.w / 2, y: e.y + e.h / 2 },
      ];
    case 'circle':
      return [
        { x: e.x, y: e.y },
        { x: e.x + e.r, y: e.y }, { x: e.x - e.r, y: e.y },
        { x: e.x, y: e.y + e.r }, { x: e.x, y: e.y - e.r },
      ];
    case 'comp':
      return [{ x: e.x, y: e.y }];
    default:
      return [];
  }
}

function withMids(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    const n = pts[(i + 1) % pts.length];
    if (!closed && i === pts.length - 1) break;
    out.push({ x: (pts[i].x + n.x) / 2, y: (pts[i].y + n.y) / 2 });
  }
  return out;
}

/**
 * Ближайшая характерная точка среди примитивов. tol — радиус поиска в мм.
 * Возвращает null, если рядом ничего нет.
 */
export function nearestRef(ents: Entity[], p: Pt, tol: number): Pt | null {
  if (!(tol > 0)) return null;
  let best: Pt | null = null;
  let bestD = tol;
  for (const e of ents) {
    for (const q of refPoints(e)) {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= bestD) { bestD = d; best = q; }
    }
  }
  return best;
}

// ------------------------------------------------------------------ отрисовка

export interface GridView {
  s: number;    // пикселей на мм
  ox: number;   // пиксель X нуля координат
  oy: number;   // пиксель Y нуля координат
  mir: boolean;
}

/** Минимальный шаг между видимыми узлами, px */
export const MIN_LATTICE_PX = 4.5;
export const MIN_SUB_PX = 7;

export interface GridSteps {
  /** видимый шаг решётки (всегда кратен шагу привязки) или null — сетку не рисуем */
  step: number | null;
  /** шаг подразбиения или null */
  sub: number | null;
  /** шаг «главных» линий/точек или null */
  major: number | null;
  /** во сколько раз видимый шаг крупнее базового */
  mult: number;
}

const MULTS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

/**
 * Какие шаги рисовать при текущем масштабе. Видимая решётка всегда кратна шагу
 * привязки (1×, 2×, 5×…), поэтому узлы привязки никогда не «съезжают» с картинки.
 */
export function displaySteps(c: GridConf, scale: number): GridSteps {
  const base = c.step > 0 ? c.step : 1;
  let mult = 1;
  let step: number | null = null;
  for (const m of MULTS) {
    if (base * m * scale >= MIN_LATTICE_PX) { step = base * m; mult = m; break; }
  }
  if (step === null) return { step: null, sub: null, major: null, mult: 1 };

  const div = Math.max(1, Math.round(c.div) || 1);
  let sub: number | null = div > 1 ? step / div : null;
  if (sub !== null && sub * scale < MIN_SUB_PX) sub = null;

  const maj = Math.max(1, Math.round(c.major) || 1);
  const major = maj > 1 ? step * maj : null;
  return { step, sub, major, mult };
}

export interface GridColors {
  minor: string;
  major: string;
  origin: string;
}

/**
 * Отрисовка сетки. Возвращает число нарисованных узлов (для тестов/отладки).
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  c: GridConf,
  v: GridView,
  wPx: number,
  hPx: number,
  col: GridColors,
): number {
  const X = (x: number): number => v.ox + x * v.s * (v.mir ? -1 : 1);
  const Y = (y: number): number => v.oy - y * v.s;
  const w1 = { x: ((0 - v.ox) / v.s) * (v.mir ? -1 : 1), y: (v.oy - 0) / v.s };
  const w2 = { x: ((wPx - v.ox) / v.s) * (v.mir ? -1 : 1), y: (v.oy - hPx) / v.s };
  const x1 = Math.min(w1.x, w2.x), x2 = Math.max(w1.x, w2.x);
  const y1 = Math.min(w1.y, w2.y), y2 = Math.max(w1.y, w2.y);

  // начало сетки (всегда видно — по нему понятно, куда «привязана» сетка)
  drawOrigin(ctx, X, Y, c, col);

  if (c.style === 'none') return 0;
  const st = displaySteps(c, v.s);
  if (st.step === null) return 0;

  const gridStep: number = st.step;
  const i0 = Math.floor((x1 - c.ox) / gridStep) - 1;
  const i1 = Math.ceil((x2 - c.ox) / gridStep) + 1;
  const j0 = Math.floor((y1 - c.oy) / gridStep) - 1;
  const j1 = Math.ceil((y2 - c.oy) / gridStep) + 1;
  if (i1 - i0 > 8000 || j1 - j0 > 8000) return 0; // страховка от зависания

  // «главный» узел — каждый major-й узел от начала сетки (major = step × N)
  const majorEvery = st.major !== null ? Math.max(1, Math.round(st.major / gridStep)) : 0;
  const isMajor = (i: number): boolean => majorEvery > 1 && i % majorEvery === 0;
  const vx = (i: number): number => X(c.ox + i * gridStep);
  const vy = (j: number): number => Y(c.oy + j * gridStep);

  let drawn = 0;
  if (c.style === 'lines') {
    // мелкое подразбиение
    if (st.sub !== null) {
      ctx.strokeStyle = col.minor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const si0 = Math.floor((x1 - c.ox) / st.sub) - 1, si1 = Math.ceil((x2 - c.ox) / st.sub) + 1;
      const sj0 = Math.floor((y1 - c.oy) / st.sub) - 1, sj1 = Math.ceil((y2 - c.oy) / st.sub) + 1;
      for (let i = si0; i <= si1; i++) {
        const px = Math.round(X(c.ox + i * st.sub)) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, hPx);
      }
      for (let j = sj0; j <= sj1; j++) {
        const py = Math.round(Y(c.oy + j * st.sub)) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(wPx, py);
      }
      ctx.stroke();
    }
    // решётка по шагу привязки
    ctx.strokeStyle = st.sub !== null ? col.major : col.minor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const px = Math.round(vx(i)) + 0.5;
      ctx.moveTo(px, 0); ctx.lineTo(px, hPx);
      drawn++;
    }
    for (let j = j0; j <= j1; j++) {
      const py = Math.round(vy(j)) + 0.5;
      ctx.moveTo(0, py); ctx.lineTo(wPx, py);
      drawn++;
    }
    ctx.stroke();
    // «главные» линии
    if (st.major !== null) {
      ctx.strokeStyle = col.major;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) if (isMajor(i)) {
        const px = Math.round(vx(i)) + 0.5;
        ctx.moveTo(px, 0); ctx.lineTo(px, hPx);
      }
      for (let j = j0; j <= j1; j++) if (isMajor(j)) {
        const py = Math.round(vy(j)) + 0.5;
        ctx.moveTo(0, py); ctx.lineTo(wPx, py);
      }
      ctx.stroke();
    }
    return drawn;
  }

  // точки и перекрестия
  ctx.fillStyle = col.minor;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const px = vx(i), py = vy(j);
      drawn++;
      const maj = isMajor(i) && isMajor(j);
      if (maj) {
        ctx.fillStyle = col.major;
        if (c.style === 'cross') {
          ctx.strokeStyle = col.major;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px - 3.5, py + 0.5); ctx.lineTo(px + 3.5, py + 0.5);
          ctx.moveTo(px + 0.5, py - 3.5); ctx.lineTo(px + 0.5, py + 3.5);
          ctx.stroke();
        } else {
          ctx.fillRect(px - 1, py - 1, 2, 2);
        }
        ctx.fillStyle = col.minor;
      } else if (c.style === 'dots') {
        ctx.fillRect(px - 0.6, py - 0.6, 1.2, 1.2);
      }
    }
  }
  return drawn;
}

function drawOrigin(
  ctx: CanvasRenderingContext2D,
  X: (x: number) => number,
  Y: (y: number) => number,
  c: GridConf,
  col: GridColors,
): void {
  const px = X(c.ox), py = Y(c.oy);
  ctx.save();
  ctx.strokeStyle = col.origin;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.moveTo(px - 7, py); ctx.lineTo(px - 2, py);
  ctx.moveTo(px + 2, py); ctx.lineTo(px + 7, py);
  ctx.moveTo(px, py - 7); ctx.lineTo(px, py - 2);
  ctx.moveTo(px, py + 2); ctx.lineTo(px, py + 7);
  ctx.stroke();
  ctx.restore();
}

/** Короткая подпись состояния сетки для строки состояния и панели свойств */
export function gridSummary(c: GridConf, scale?: number): string {
  const parts = [fmtGridFull(c.step)];
  if (c.ox !== 0 || c.oy !== 0) parts.push(`от X${fmtNum(c.ox)} Y${fmtNum(c.oy)}`);
  parts.push(GRID_STYLE_NAME[c.style]);
  if (c.div > 1) parts.push(`÷${c.div}`);
  if (c.major > 1) parts.push(`главные ×${c.major}`);
  parts.push(c.snap ? (c.snapObj ? 'привязка + объекты' : 'привязка вкл.') : 'привязка выкл.');
  if (scale && scale > 0) {
    const st = displaySteps(c, scale);
    if (st.step === null) parts.push('сетка скрыта (мелко)');
    else if (st.mult > 1) parts.push(`показана ×${st.mult}`);
  }
  return parts.join(' · ');
}

export const fmtNum = (v: number): string => String(parseFloat(v.toFixed(4)));
