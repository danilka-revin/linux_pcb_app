// Строительные блоки посадочных мест (футпринтов).
//
// Здесь НЕТ каталога готовых макросов — только параметрические построители:
// каждый получает набор чисел (выводы, шаг, размеры площадок, корпус, крепёжные
// отверстия, подписи) и возвращает список примитивов `LibEl` в локальных
// координатах (мм, точка установки — (0;0)).
//
// Текст пользователя разбирается в src/pcb/gen.ts: он подбирает семейство и
// параметры, а геометрию считает этот файл.
//
// Общие правила (их контролирует test/library.ts на сгенерированных примерах):
//   • кольцо меди вокруг сверла — не меньше 0.15 мм;
//   • зазор медь-медь — не меньше 0.15 мм;
//   • шелкография — s1/s2, толщина линии ≥ 0.12 мм, высота подписей ≥ 0.55 мм;
//   • подписи не должны ложиться на медь.

import type { PadShape } from './model';

export type LibLayer = 's1' | 's2';

export type LibEl =
  | { kind: 'pad'; x: number; y: number; shape: PadShape; size: number; drill: number }
  | { kind: 'smd'; x: number; y: number; w: number; h: number; rot: number; layer: 'k1' | 'k2' }
  | { kind: 'hole'; x: number; y: number; d: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; layer: LibLayer }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; th: number; layer: LibLayer }
  | { kind: 'circle'; x: number; y: number; r: number; w: number; layer: LibLayer }
  | {
      kind: 'text'; x: number; y: number; text: string; size: number; th: number;
      rot: number; mirror: boolean; layer: LibLayer;
    };

/** Паспорт футпринта — характеристики, посчитанные построителем. */
export interface FpSpec {
  /** металлизированные (выводные) площадки */
  pins?: number;
  /** планарные площадки */
  smd?: number;
  /** неметаллизированные отверстия (в т. ч. крепёжные) */
  holes?: number;
  /** минимальный шаг между соседними выводами, мм */
  pitch?: number;
  /** сколько подписей выводов в футпринте */
  labels?: number;
  /** габарит W × H, мм */
  w?: number;
  h?: number;
  /** что построитель учёл/не учёл — показывается в интерфейсе */
  notes?: string[];
}

/** Обводка/подписи на нижней стороне (если пользователь попросил «низ») */
export type Silk = 's1' | 's2';

// ---------------------------------------------------------------- примитивы

export const P = (
  x: number, y: number, drill = 0.9, size = 1.8, shape: PadShape = 'round',
): LibEl => ({ kind: 'pad', x, y, drill, size, shape });

export const SM = (
  x: number, y: number, w: number, h: number, rot = 0, layer: 'k1' | 'k2' = 'k1',
): LibEl => ({ kind: 'smd', x, y, w, h, rot, layer });

export const SL = (
  x1: number, y1: number, x2: number, y2: number, w = 0.25, layer: LibLayer = 's1',
): LibEl => ({ kind: 'line', x1, y1, x2, y2, w, layer });

export const SR = (
  x: number, y: number, w: number, h: number, th = 0.25, layer: LibLayer = 's1',
): LibEl => ({ kind: 'rect', x, y, w, h, th, layer });

export const SC = (
  x: number, y: number, r: number, w = 0.25, layer: LibLayer = 's1',
): LibEl => ({ kind: 'circle', x, y, r, w, layer });

export const LT = (
  x: number, y: number, text: string, size = 1, th = 0.15, rot = 0,
  layer: LibLayer = 's1', mirror = false,
): LibEl => ({ kind: 'text', x, y, text, size, th, rot, mirror, layer });

/** Ширина строки в мм — как считает model.entBBox и рисует strokefont (0.8 × высота) */
export const textW = (t: string, size: number): number => t.length * size * 0.8;

/** Толщина штриха под размер шрифта (не меньше 0.12 мм — норма шелкографии) */
export const thFor = (size: number): number => Math.max(0.12, Math.round(size * 0.16 * 100) / 100);

/** Подпись, отцентрованная по X относительно точки */
export const lc = (
  cx: number, y: number, t: string, size = 1, rot = 0, layer: LibLayer = 's1',
): LibEl => LT(cx - textW(t, size) / 2, y, t, size, thFor(size), rot, layer);

/**
 * Габарит примитивов генератора (локальные мм) — тот же расчёт, что у
 * model.entBBox: подписи с учётом поворота, линии и рамки — с половиной штриха.
 */
export function bboxOf(els: LibEl[]): [number, number, number, number] {
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  const grow = (ax: number, ay: number): void => {
    x1 = Math.min(x1, ax); y1 = Math.min(y1, ay);
    x2 = Math.max(x2, ax); y2 = Math.max(y2, ay);
  };
  for (const el of els) {
    switch (el.kind) {
      case 'pad': grow(el.x - el.size / 2, el.y - el.size / 2); grow(el.x + el.size / 2, el.y + el.size / 2); break;
      case 'smd': {
        const rot = ((Math.round(el.rot) % 180) + 180) % 180;
        const w = rot === 0 ? el.w : el.h, h = rot === 0 ? el.h : el.w;
        grow(el.x - w / 2, el.y - h / 2); grow(el.x + w / 2, el.y + h / 2);
        break;
      }
      case 'hole': grow(el.x - el.d / 2, el.y - el.d / 2); grow(el.x + el.d / 2, el.y + el.d / 2); break;
      case 'line': {
        const m = el.w / 2;
        grow(Math.min(el.x1, el.x2) - m, Math.min(el.y1, el.y2) - m);
        grow(Math.max(el.x1, el.x2) + m, Math.max(el.y1, el.y2) + m);
        break;
      }
      case 'rect': grow(el.x - el.th / 2, el.y - el.th / 2); grow(el.x + el.w + el.th / 2, el.y + el.h + el.th / 2); break;
      case 'circle': grow(el.x - el.r - el.w / 2, el.y - el.r - el.w / 2); grow(el.x + el.r + el.w / 2, el.y + el.r + el.w / 2); break;
      case 'text': {
        const w = textW(el.text, el.size), h = el.size;
        const a = (el.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
        for (const [xx, yy] of [[0, 0], [w, 0], [w, h], [0, h]]) grow(el.x + xx * ca - yy * sa, el.y + xx * sa + yy * ca);
        break;
      }
    }
  }
  if (x1 > x2) return [-2.54, -2.54, 2.54, 2.54];
  return [r3(x1), r3(y1), r3(x2), r3(y2)];
}

/** Все подписи на другую сторону шелкографии (для «низ» в генераторе) */
export const onLayer = (els: LibEl[], layer: Silk): LibEl[] =>
  layer === 's1' ? els : els.map((e) =>
    (e.kind === 'line' || e.kind === 'rect' || e.kind === 'circle' || e.kind === 'text')
      ? { ...e, layer: 's2' } as LibEl
      : e,
  );

export interface LabelledPt {
  x: number;
  y: number;
  /** подпись вывода */
  t: string;
}

/**
 * Подписи вокруг площадок: `dir` — куда выносим текст, `padR` — радиус площадки
 * (чтобы подпись не легла на медь).
 */
export function labelsFor(
  pts: LabelledPt[], dir: 'up' | 'down' | 'left' | 'right', size = 0.9, padR = 0.9,
  layer: LibLayer = 's1',
): LibEl[] {
  const gap = padR + 0.35;
  return pts.map(({ x, y, t }) => {
    if (dir === 'up') return lc(x, y + padR + 0.2, t, size, 0, layer);
    if (dir === 'down') return lc(x, y - gap - size, t, size, 0, layer);
    if (dir === 'left') return LT(x - gap - textW(t, size), y - size * 0.36, t, size, thFor(size), 0, layer);
    return LT(x + gap, y - size * 0.36, t, size, thFor(size), 0, layer);
  });
}

/**
 * Подписи вдоль плотного ряда, повёрнутые на 90° (как на платах Arduino):
 * `above` — подписи сверху от ряда, иначе снизу.
 */
export function rowLabels(
  pts: LabelledPt[], size = 0.9, above = true, padR = 0.9, layer: LibLayer = 's1',
): LibEl[] {
  return pts.map(({ x, y, t }) => {
    const w = textW(t, size);
    const ax = x + size / 2; // «высота» строки при повороте 90° уходит влево
    const ay = above ? y + padR + 0.3 : y - padR - 0.3 - w;
    return LT(ax, ay, t, size, thFor(size), 90, layer);
  });
}

/** Подписи в шахматном порядке (когда ряд подписей плотнее текста) */
export function staggered(
  pts: LabelledPt[], dir: 'down' | 'up', size: number, padR: number, step = 1.0,
  layer: LibLayer = 's1',
): LibEl[] {
  return pts.flatMap(({ x, y, t }, i) => {
    const dy = i % 2 === 0 ? 0 : step;
    const yy = dir === 'down' ? y - padR - 0.35 - size - dy : y + padR + 0.35 + dy;
    return [lc(x, yy, t, size, 0, layer)];
  });
}

/** Ряд площадок с шагом pitch по горизонтали: первый — квадратный */
export function padRow(
  x0: number, y: number, count: number, pitch = 2.54, opts: {
    drill?: number; size?: number; shape?: PadShape; firstSquare?: boolean;
  } = {},
): LibEl[] {
  const { drill = 1.0, size = 1.8, shape = 'round', firstSquare = true } = opts;
  return Array.from({ length: count }, (_, i) => P(
    x0 + i * pitch, y, drill, size, firstSquare && i === 0 ? 'square' : shape,
  ));
}

/** Номера выводов: 1…n, но если подписей много — каждый `every`-й + первый и последний */
export function pinNames(n: number, every: number): (string | null)[] {
  if (every <= 1) return Array.from({ length: n }, (_, i) => String(i + 1));
  return Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return k === 1 || k === n || k % every === 0 ? String(k) : null;
  });
}

export const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Минимальный шаг между выводами — по факту построенной меди (площадки и SMD).
 * Используется и генератором, и тестом, чтобы паспорт никогда не расходился
 * с геометрией.
 */
export function minCopperPitch(els: LibEl[]): number | undefined {
  const pts: { x: number; y: number }[] = [];
  for (const e of els) if (e.kind === 'pad' || e.kind === 'smd') pts.push(e);
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d > 1e-6) min = Math.min(min, d);
    }
  }
  return isFinite(min) ? r3(min) : undefined;
}

/** Зазор, который оставляет медь вокруг подписи/корпуса */
const SILK_GAP = 0.25;

/** Толщина линии шелкографии по умолчанию */
export const silkTh = (big = false): number => (big ? 0.3 : 0.2);

// ---------------------------------------------------------------- крепёж

/** Металлизированное крепёжное отверстие с кольцом меди (под стойку) */
export function mountPad(x: number, y: number, d: number, pad: number): LibEl {
  return P(x, y, d, Math.max(pad, d + 0.6), 'round');
}

/**
 * Точки крепежа: `n` отверстий вдоль ряда (по X, за краями) или по углам
 * прямоугольника размером 2·hw × 2·hh.
 */
export function holeSpots(
  n: number, half: number, at: 'row' | 'corners', inset = 1.6, hh = 0,
): [number, number][] {
  if (n <= 0) return [];
  if (at === 'row') {
    // вне ряда меди можно встать только с двух краёв: между площадками
    // отверстие неминуемо зальёт медь, поэтому n>2 для ряда режем на 2
    const k = Math.max(1, Math.min(2, Math.round(n)));
    return k === 1 ? [[-half - inset, 0]] : [[-half - inset, 0], [half + inset, 0]];
  }
  return holeCorners(n, half, hh, inset);
}

/** Крепёжные/монтажные отверстия: голые или с металлизированным кольцом и пояском */
export function mountHoles(o: {
  n: number; d: number; pad?: number; ring?: number;
  at?: 'row' | 'corners'; half?: number; hh?: number; inset?: number;
}, layer: LibLayer = 's1'): LibEl[] {
  const pad = o.pad ?? 0;
  const ring = o.ring ?? 0;
  return holeSpots(Math.round(o.n), o.half ?? 0, o.at ?? 'row', o.inset, o.hh).flatMap(([x, y]) => {
    const out: LibEl[] = [];
    if (pad > 0) out.push(mountPad(x, y, o.d, pad));
    else out.push({ kind: 'hole', x, y, d: o.d });
    if (ring > 0) out.push(SC(x, y, Math.max(pad / 2, o.d / 2) + ring, silkTh(), layer));
    return out;
  });
}

/** 1…4 отверстия по углам прямоугольника 2·hw × 2·hh с отступом inset */
export function holeCorners(n: number, hw: number, hh: number, inset: number): [number, number][] {
  const all: [number, number][] = [
    [-hw + inset, -hh + inset],
    [hw - inset, -hh + inset],
    [hw - inset, hh - inset],
    [-hw + inset, hh - inset],
  ];
  if (n <= 1) return [all[0]];
  if (n === 2) return [all[0], all[2]];          // по диагонали
  if (n === 3) return [all[0], all[1], all[3]];
  return all;
}

// ---------------------------------------------------------------- корпуса с рядами

export interface DipOpts {
  pins: number;
  /** междурядье по центрам площадок, мм */
  rowW: number;
  pitch?: number;
  padSize?: number;
  drill?: number;
  socket?: boolean;
  labels?: number;         // шаг нумерации подписей (1 — все)
  labelSize?: number;
  silk?: boolean;
  layer?: LibLayer;
  /** имя корпуса в центр шелкографии */
  title?: string;
}

/** DIP-корпус (шаг 2.54): вывод 1 — верхний левый у ключа, далее вниз по левой, вверх по правой */
export function dipFootprint(o: DipOpts): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 2.54;
  const half = Math.max(1, Math.round(o.pins / 2));
  const padSize = o.padSize ?? (o.socket ? 1.8 : 1.6);
  const drill = o.drill ?? (o.socket ? 1.0 : 0.8);
  const layer = o.layer ?? 's1';
  const every = o.labels ?? 1;
  const lsize = o.labelSize ?? 0.9;
  const y0 = ((half - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  const names = pinNames(o.pins, every);
  for (let i = 0; i < half; i++) {
    const yl = y0 - i * pitch;
    els.push(P(-o.rowW / 2, yl, drill, padSize, i === 0 ? 'square' : 'round'));
    const t1 = names[i];
    if (t1) left.push({ x: -o.rowW / 2, y: yl, t: t1 });
    const yr = -y0 + i * pitch;
    els.push(P(o.rowW / 2, yr, drill, padSize));
    const t2 = names[o.pins - 1 - i];
    if (t2) right.push({ x: o.rowW / 2, y: yr, t: t2 });
  }
  els.push(...labelsFor(left, 'left', lsize, padSize / 2, layer));
  els.push(...labelsFor(right, 'right', lsize, padSize / 2, layer));
  if (o.silk !== false) {
    const bw = o.rowW - (o.rowW > 10 ? 1.5 : 1.27);
    const bh = (half - 1) * pitch + 2.54;
    els.push(SR(-bw / 2, -bh / 2, bw, bh, silkTh(), layer));
    els.push(SC(0, bh / 2, 0.95, silkTh(), layer));
    els.push(SL(-1.7, bh / 2 + 1.2, 1.7, bh / 2 + 1.2, 0.25, layer));
    if (o.socket) els.push(SR(-bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1.0, bh - 1.0, 0.15, layer));
    if (o.title && textW(o.title, 0.8) <= bw - 0.6) els.push(lc(0, -0.4, o.title, 0.8, 0, layer));
  }
  return {
    els,
    spec: {
      pins: o.pins, pitch: r3(pitch), labels: left.length + right.length,
      holes: 0,
    },
  };
}

export interface SoicOpts {
  pins: number;
  pitch?: number;
  /** расстояние между центрами площадок двух рядов */
  rowX: number;
  padLen?: number;
  padH?: number;
  bodyW?: number;
  layer?: LibLayer;
  labels?: boolean;
  labelSize?: number;
  title?: string;
  silk?: boolean;
}

/** Корпус с двумя рядами SMD-площадок (SOIC, SOP, TSSOP, MSOP, SC-70…) */
export function soicFootprint(o: SoicOpts): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 1.27;
  const half = Math.max(1, Math.round(o.pins / 2));
  const padLen = o.padLen ?? 1.8;
  // на мелком шаге площадки сужаем сами — иначе медь слипается (0.2 мм зазор)
  const padH = Math.min(o.padH ?? Math.max(0.35, pitch - 0.45), Math.max(0.2, pitch - 0.2));
  const bodyW = o.bodyW ?? o.rowX - 1.5;
  const layer = o.layer ?? 's1';
  const lsize = o.labelSize ?? Math.min(0.9, pitch * 0.75);
  const y0 = ((half - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < half; i++) {
    const yl = y0 - i * pitch;
    els.push(SM(-o.rowX / 2, yl, padLen, padH));
    left.push({ x: -o.rowX / 2, y: yl, t: String(i + 1) });
    const yr = -y0 + i * pitch;
    els.push(SM(o.rowX / 2, yr, padLen, padH));
    right.push({ x: o.rowX / 2, y: yr, t: String(o.pins - i) });
  }
  let labelCount = 0;
  if (o.labels !== false && pitch >= 0.8) {
    els.push(...labelsFor(left, 'left', lsize, padLen / 2, layer));
    els.push(...labelsFor(right, 'right', lsize, padLen / 2, layer));
    labelCount = o.pins;
  } else if (o.labels !== false) {
    els.push(lc(-o.rowX / 2 - padLen / 2 - 0.6, y0 + 0.9, `1-${half}`, 0.7, 0, layer));
    els.push(lc(o.rowX / 2 + padLen / 2 + 0.6, -y0 - 1.6, `${half + 1}-${o.pins}`, 0.7, 0, layer));
    labelCount = 2;
  }
  const bh = (half - 1) * pitch + Math.max(1.6, pitch * 1.6);
  if (o.silk !== false) {
    els.push(SR(-bodyW / 2, -bh / 2, bodyW, bh, 0.2, layer));
    els.push(SC(-bodyW / 2 - 0.5, bh / 2 + 0.4, 0.3, 0.2, layer));
    if (o.title && textW(o.title, 0.7) <= bodyW - 0.5) els.push(lc(0, -0.4, o.title, 0.7, 0, layer));
  }
  return {
    els,
    spec: { smd: o.pins, pitch: r3(pitch), labels: labelCount, holes: 0 },
  };
}

export interface QuadOpts {
  pins: number;
  pitch?: number;
  body: number;
  /** длина площадки, торчащей за корпус */
  padLen?: number;
  padW?: number;
  thermal?: boolean;
  thermalSize?: number;
  labelEvery?: number;
  layer?: LibLayer;
  title?: string;
  silk?: boolean;
}

const quadSides = (n: number): number => (n % 4 === 0 ? n / 4 : Math.ceil(n / 4));

/** Корпус с выводами на 4 стороны: QFN/DFN (плоские площадки, thermal) и QFP/LQFP (длиннее) */
export function quadFootprint(o: QuadOpts & { kind: 'qfn' | 'qfp' }): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 0.5;
  const per = quadSides(o.pins);
  const span = (per - 1) * pitch;
  const padC = o.body / 2 + (o.kind === 'qfn' ? 0.45 : 0.7);
  const padLen = o.padLen ?? (o.kind === 'qfn' ? 0.8 : 1.25);
  const pw = o.padW ?? (o.kind === 'qfn'
    ? Math.max(0.3, Math.min(0.55, pitch - 0.25))
    : Math.max(0.3, pitch - 0.2));
  const layer = o.layer ?? 's1';
  const every = o.labelEvery ?? 4;
  const els: LibEl[] = [];
  const labels: LibEl[] = [];
  let count = 0;
  for (let i = 0; i < per; i++) {
    const off = -span / 2 + i * pitch;
    const sides: { pt: [number, number]; w: number; h: number; num: number; pos: { x: number; y: number }; right?: boolean }[] = [
      { pt: [-padC, -off], w: padLen, h: pw, num: i + 1, pos: { x: -padC - padLen / 2 - 0.75, y: -off - 0.28 } },
      { pt: [off, -padC], w: pw, h: padLen, num: per + 1 + i, pos: { x: off, y: -padC - padLen / 2 - 1.0 } },
      { pt: [padC, off], w: padLen, h: pw, num: per * 2 + 1 + i, pos: { x: padC + padLen / 2 + 0.3, y: off - 0.28 }, right: true },
      { pt: [-off, padC], w: pw, h: padLen, num: per * 3 + 1 + i, pos: { x: -off, y: padC + padLen / 2 + 0.3 } },
    ];
    for (const s of sides) {
      if (s.num > o.pins) continue;
      els.push(SM(s.pt[0], s.pt[1], s.w, s.h));
      count++;
      if (s.num === 1 || s.num === o.pins || (every > 1 && s.num % every === 0)) {
        labels.push(s.right
          ? LT(s.pos.x, s.pos.y, String(s.num), 0.7, thFor(0.7), 0, layer)
          : lc(s.pos.x, s.pos.y, String(s.num), 0.7, 0, layer));
      }
    }
  }
  if (o.kind === 'qfn' && o.thermal !== false) {
    const ts = o.thermalSize ?? o.body * 0.62;
    els.push(SM(0, 0, ts, ts));
  }
  if (o.silk !== false) {
    els.push(SR(-o.body / 2, -o.body / 2, o.body, o.body, 0.15, layer));
    els.push(SC(-o.body / 2 - 0.35, o.body / 2 + 0.35, 0.25, 0.15, layer));
    if (o.title && textW(o.title, 0.7) <= o.body - 0.6) els.push(lc(0, -0.4, o.title, 0.7, 0, layer));
  }
  els.push(...labels);
  return {
    els,
    spec: { smd: count, pitch: r3(pitch), labels: labels.length, holes: 0 },
  };
}

// ---------------------------------------------------------------- два вывода

export type Polarity = 'none' | 'diode' | 'led' | 'cap' | 'tant';

export interface TwoLeadOpts {
  pitch: number;
  /** габарит корпуса, мм */
  bodyL: number;
  bodyW: number;
  round?: boolean;       // корпус — окружность (керамика, электролит)
  polarity?: Polarity;
  padSize?: number;
  drill?: number;
  value?: string;        // номинал в центр корпуса
  layer?: LibLayer;
  silk?: boolean;
}

/** Осевой THT-компонент: резистор, диод, LED, конденсатор, катушка… */
export function twoLeadFootprint(o: TwoLeadOpts): { els: LibEl[]; spec: FpSpec } {
  const size = o.padSize ?? 1.8;
  const drill = o.drill ?? Math.min(0.9, size * 0.5);
  const layer = o.layer ?? 's1';
  const pol = o.polarity ?? 'none';
  const els: LibEl[] = [
    P(-o.pitch / 2, 0, drill, size, 'round'),
    P(o.pitch / 2, 0, drill, size, pol === 'none' ? 'round' : 'square'),
  ];
  if (o.silk !== false) {
    if (o.round) {
      const r = Math.max(o.bodyL, o.bodyW) / 2;
      els.push(SC(0, 0, r, silkTh(), layer));
      // выводы видны из-под корпуса: короткие «ножки» от площадки до края
      if (o.pitch / 2 > r) {
        els.push(SL(-o.pitch / 2, 0, -r, 0, 0.3, layer));
        els.push(SL(r, 0, o.pitch / 2, 0, 0.3, layer));
      }
    } else {
      els.push(SR(-o.bodyL / 2, -o.bodyW / 2, o.bodyL, o.bodyW, silkTh(), layer));
      els.push(SL(-o.pitch / 2, 0, -o.bodyL / 2, 0, 0.3, layer));
      els.push(SL(o.bodyL / 2, 0, o.pitch / 2, 0, 0.3, layer));
    }
  }
  const cw = o.bodyW / 2;
  if (o.silk !== false) {
    if (pol === 'diode' || pol === 'led') {
      if (!o.round) els.push(SL(o.bodyL / 2 - Math.min(1.1, o.bodyL * 0.2), -cw, o.bodyL / 2 - Math.min(1.1, o.bodyL * 0.2), cw, 0.5, layer));
      els.push(lc(-o.pitch / 2, -Math.max(cw, size / 2) - 1.55, 'A', 0.9, 0, layer));
      els.push(lc(o.pitch / 2, Math.max(cw, size / 2) + 0.65, 'K', 0.9, 0, layer));
    }
    if (pol === 'cap') {
      els.push(lc(-o.pitch / 2, -2.0, '+', 1.0, 0, layer));
      els.push(SL(-o.pitch / 2 - 0.45, 1.6, -o.pitch / 2 + 0.45, 1.6, 0.4, layer));
      els.push(SL(-o.pitch / 2, 1.15, -o.pitch / 2, 2.05, 0.4, layer));
    }
    if (pol === 'tant') {
      els.push(lc(-o.pitch / 2, -Math.max(cw, size / 2) - 1.6, '+', 0.9, 0, layer));
    }
    if (o.value && textW(o.value, 0.9) <= Math.min(o.bodyL - 0.4, o.pitch - size - 0.4)) {
      els.push(lc(0, -0.45, o.value, 0.9, 0, layer));
    }
  }
  return { els, spec: { pins: 2, pitch: r3(o.pitch), holes: 0, labels: pol === 'none' ? 0 : 2 } };
}

export interface ChipSmdOpts {
  /** расстояние между центрами площадок */
  gap: number;
  padW: number;
  padH: number;
  bodyW: number;
  bodyH: number;
  layer?: LibLayer;
  cu?: 'k1' | 'k2';
  value?: string;
  polarity?: 'none' | 'diode';
  silk?: boolean;
}

/** Планарный двухвыводник: 0402…2512, SOD, SMA, конденсатор SMD */
export function chipSmdFootprint(o: ChipSmdOpts): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const cu = o.cu ?? 'k1';
  // площадки не должны слипаться: зазор между ними не меньше 0.2 мм
  const padW = Math.min(o.padW, Math.max(0.2, o.gap - 0.2));
  const els: LibEl[] = [
    SM(-o.gap / 2, 0, padW, o.padH, 0, cu),
    SM(o.gap / 2, 0, padW, o.padH, 0, cu),
  ];
  if (o.silk !== false) {
    els.push(SR(-o.bodyW / 2, -o.bodyH / 2, o.bodyW, o.bodyH, 0.15, layer));
    if (o.polarity === 'diode') {
      els.push(SL(o.bodyW / 2 - 0.5, -o.bodyH / 2, o.bodyW / 2 - 0.5, o.bodyH / 2, 0.35, layer));
      els.push(lc(-o.gap / 2 - o.padW / 2 - 0.45, -0.4, 'A', 0.7, 0, layer));
      els.push(lc(o.gap / 2 + o.padW / 2 + 0.45, -0.4, 'K', 0.7, 0, layer));
    }
    if (o.value) {
      const w = textW(o.value, 0.7);
      // влезает между площадками — пишем на корпусе, иначе — над ним
      if (w <= o.bodyW - 0.3 && w <= o.gap - padW - 0.3) els.push(lc(0, -0.35, o.value, 0.7, 0, layer));
      else els.push(lc(0, Math.max(o.bodyH, o.padH) / 2 + 0.5, o.value, 0.7, 0, layer));
    }
  }
  return {
    els,
    spec: { smd: 2, pitch: r3(o.gap), holes: 0, labels: o.polarity === 'diode' ? 2 : 0 },
  };
}

// ---------------------------------------------------------------- ряды и сетки

export interface RowOpts {
  n: number;
  rows?: number;
  pitch?: number;
  pitchY?: number;
  padSize?: number;
  drill?: number;
  shape?: PadShape;
  /** прямоугольник корпуса вокруг рядов (w×h), 0 — без корпуса */
  bodyW?: number;
  bodyH?: number;
  bodyDY?: number;
  socket?: boolean;
  labels?: number;
  labelSize?: number;
  /** подписи: только числа или именные списки */
  names?: string[];
  layer?: LibLayer;
  title?: string;
  numbering?: 'rows' | 'cols';
  /** крепёжные отверстия по краям ряда */
  holes?: { n: number; d: number; pad?: number };
  silk?: boolean;
  vertical?: boolean;
  firstSquare?: boolean;
  /** линия-ограничитель Plastic-Body по краю (как у штырей) */
  endLines?: boolean;
}

/**
 * Универсальный ряд/сетка площадок: штыри, гребёнки, IDC, панельки,
 * «произвольный разъём n выводов с шагом x».
 */
export function rowFootprint(o: RowOpts): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 2.54;
  const rows = Math.max(1, o.rows ?? 1);
  const size = o.padSize ?? (o.socket ? 1.8 : 1.7);
  const drill = o.drill ?? (o.socket ? 1.0 : 0.9);
  const layer = o.layer ?? 's1';
  const pitchY = o.pitchY ?? pitch;
  const every = o.labels ?? 1;
  const lsize = o.labelSize ?? Math.min(0.85, pitch * 0.42);
  const cols = o.n;
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  const total = cols * rows;
  const x0 = -((cols - 1) * pitch) / 2;
  const y0 = ((rows - 1) * pitchY) / 2;
  const positions: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * pitch;
      const y = y0 - r * pitchY;
      positions.push([x, y]);
      els.push(P(x, y, drill, size, o.firstSquare !== false && r === 0 && c === 0 ? 'square' : (o.shape ?? 'round')));
    }
  }
  const names = o.names?.length === total ? o.names : null;
  const nums = pinNames(total, every);
  positions.forEach(([x, y], i) => {
    const t = names ? names[i] : nums[i];
    if (t) pts.push({ x, y, t });
  });
  let drawnLabels = 0;
  if (pts.length) {
    if (rows === 1) {
      els.push(...labelsFor(pts, 'down', lsize, size / 2, layer));
      drawnLabels = pts.length;
    } else {
      // между рядами 2.54 мм подпись не помещается — выводим её наружу;
      // средние ряды (3+ рядов) остаются без нумерации
      const topY = y0, botY = y0 - (rows - 1) * pitchY;
      const upper = pts.filter((pt) => Math.abs(pt.y - topY) < 1e-6);
      const lower = rows > 2 ? [] : pts.filter((pt) => Math.abs(pt.y - botY) < 1e-6);
      els.push(...labelsFor(upper, 'up', lsize, size / 2, layer));
      els.push(...labelsFor(lower, 'down', lsize, size / 2, layer));
      drawnLabels = upper.length + lower.length;
    }
  }
  const bodyW = o.bodyW ?? 0;
  const bodyH = o.bodyH ?? 0;
  if (o.silk !== false && (bodyW > 0 || bodyH > 0)) {
    const dy = o.bodyDY ?? 0;
    els.push(SR(-bodyW / 2, -bodyH / 2 + dy, bodyW, bodyH, silkTh(), layer));
  }
  if (o.silk !== false && rows === 1 && o.endLines !== false && cols > 1) {
    const w = (cols - 1) * pitch + size + 0.3;
    els.push(SR(-w / 2, -size / 2 - 0.35, w, size + 0.7, 0.15, layer));
  }
  let rowHoles = 0;
  if (o.holes && o.holes.n > 0) {
    const half = (cols - 1) * pitch / 2 + size / 2;
    for (const [x, y] of holeSpots(o.holes.n, half, 'row', (o.holes.pad ?? 0) / 2 + o.holes.d / 2 + 0.45)) {
      rowHoles++;
      if (o.holes.pad && o.holes.pad > 0) els.push(mountPad(x, y, o.holes.d, o.holes.pad));
      else els.push({ kind: 'hole', x, y, d: o.holes.d });
    }
  }
  if (o.title && bodyW > textW(o.title, 0.8) + 0.6) {
    els.push(lc(0, -0.4, o.title, 0.8, 0, layer));
  }
  return {
    els,
    spec: {
      pins: total, pitch: r3(Math.min(pitch, pitchY)),
      labels: drawnLabels, holes: rowHoles,
    },
  };
}

/** Разъём 2×N (IDC, гребёнка, «мама» 2 ряда): нумерация 1,2 / 3,4 / … */
export function dualFootprint(o: RowOpts & { rowGap?: number }): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 2.54;
  const rows = 2;
  return rowFootprint({
    ...o,
    rows,
    n: o.n,
    pitchY: o.rowGap ?? pitch,
    numbering: 'rows',
  });
}

/** Винтовой клеммник: ряд площадок + корпус сверху + подписи над выводами */
export function terminalFootprint(o: {
  n: number; pitch?: number; padSize?: number; drill?: number;
  bodyH?: number; labels?: number; layer?: LibLayer; title?: string;
}): { els: LibEl[]; spec: FpSpec } {
  const pitch = o.pitch ?? 5.08;
  const size = o.padSize ?? 2.6;
  const drill = o.drill ?? 1.3;
  const layer = o.layer ?? 's1';
  const x0 = -((o.n - 1) * pitch) / 2;
  const els: LibEl[] = Array.from({ length: o.n }, (_, i) =>
    P(x0 + i * pitch, 0, drill, size, i === 0 ? 'square' : 'round'));
  const w = o.n * pitch;
  const bodyH = o.bodyH ?? (pitch >= 5 ? 10 : 8);
  els.push(SR(-w / 2 + 0.4, -bodyH / 2 + 1.6, w - 0.8, bodyH, silkTh(), layer));
  els.push(...labelsFor(
    pinNames(o.n, o.labels ?? 1).map((t, i) => ({ x: x0 + i * pitch, y: 0, t }))
      .filter((p): p is LabelledPt => p.t !== null),
    'up', 1.0, size / 2, layer,
  ));
  if (o.title) els.push(lc(0, bodyH / 2 + 1.0, o.title, 0.8, 0, layer));
  return { els, spec: { pins: o.n, pitch: r3(pitch), labels: o.n, holes: 0 } };
}

/** Тактовая кнопка: 4 вывода по углам + корпус */
export function tactFootprint(o: {
  px?: number; py?: number; body?: number; bodyY?: number; padSize?: number; drill?: number;
  layer?: LibLayer; round?: boolean;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const px = o.px ?? 6.0;
  const py = o.py ?? 6.0;
  const size = o.padSize ?? 1.6;
  const drill = o.drill ?? 0.8;
  const body = o.body ?? 6;
  const bodyY = o.bodyY ?? 6;
  const xs = [-px / 2, px / 2];
  const ys = [-py / 2, py / 2];
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  let k = 1;
  for (const y of ys) for (const x of xs) {
    els.push(P(x, y, drill, size, k === 1 ? 'square' : 'round'));
    pts.push({ x, y, t: String(k++) });
  }
  if (o.round) els.push(SC(0, 0, Math.max(body, bodyY) / 2, silkTh(), layer));
  else els.push(SR(-body / 2, -bodyY / 2, body, bodyY, silkTh(), layer));
  els.push(SC(0, 0, Math.min(body, bodyY) * 0.18, 0.2, layer));
  els.push(...labelsFor(pts, 'right', 0.75, size / 2, layer));
  return { els, spec: { pins: 4, pitch: r3(Math.min(px, py)), labels: 4, holes: 0 } };
}

/** TO-92 / TO-126 / TO-220: 3 вывода (линия или треугольник) + отверстие под винт */
export function packFootprint(o: {
  pitch?: number; padSize?: number; drill?: number;
  bodyW?: number; bodyH?: number;
  holeD?: number; holeY?: number;
  triangle?: boolean; names?: string[]; layer?: LibLayer;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const pitch = o.pitch ?? 1.7;
  const size = o.padSize ?? 1.6;
  const drill = o.drill ?? 0.9;
  const names = o.names ?? ['1', '2', '3'];
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  if (o.triangle) {
    const pos: [number, number][] = [[-pitch, -1.6], [pitch, -1.6], [0, 1.6]];
    pos.forEach(([x, y], i) => {
      els.push(P(x, y, drill, size, i === 0 ? 'square' : 'round'));
      pts.push({ x, y, t: names[i] ?? String(i + 1) });
    });
    const r = Math.max(2.35, pitch + 0.9);
    els.push(SC(0, 0, r, silkTh(), layer));
    els.push(SL(-r + 0.45, r * 0.62, r - 0.45, r * 0.62, 0.3, layer));
  } else {
    const xs = [-pitch, 0, pitch];
    xs.forEach((x, i) => {
      els.push(P(x, 0, drill, size, i === 0 ? 'square' : 'round'));
      pts.push({ x, y: 0, t: names[i] ?? String(i + 1) });
    });
    const bodyW = o.bodyW ?? 4.8;
    const bodyH = o.bodyH ?? 5.2;
    els.push(SC(0, 3.3, bodyW / 2 + 0.1, silkTh(), layer));
    els.push(SL(-bodyW / 2 + 0.45, 3.3 + bodyW / 2 - 0.75, bodyW / 2 - 0.45, 3.3 + bodyW / 2 - 0.75, 0.3, layer));
    void bodyH;
    if (o.holeD && o.holeD > 0) {
      const hy = o.holeY ?? 10.0;
      els.push({ kind: 'hole', x: 0, y: hy, d: o.holeD });
      els.push(SC(0, hy, o.holeD / 2 + 1.2, 0.3, layer));
    }
  }
  els.push(...labelsFor(pts, 'down', 0.9, size / 2, layer));
  return {
    els,
    spec: {
      pins: 3, pitch: r3(pitch), labels: 3,
      holes: o.triangle ? 0 : (o.holeD && o.holeD > 0 ? 1 : 0),
    },
  };
}

/** SOT-23 / SOT-89 / SOT-223 / DPAK: 2+1 (или 2+n) планарных площадок + вывод-теплоотвод */
export function sotFootprint(o: {
  pins?: number; pitch?: number; padW?: number; padH?: number;
  rowX?: number; bodyW?: number; bodyH?: number; tabW?: number; tabH?: number;
  layer?: LibLayer; cu?: 'k1' | 'k2'; names?: string[];
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const cu = o.cu ?? 'k1';
  const pins = o.pins ?? 3;
  const pitch = o.pitch ?? 0.95;
  const rowX = o.rowX ?? 1.9;
  const padW = o.padW ?? 0.6;
  const padH = o.padH ?? 1.2;
  const bodyW = o.bodyW ?? 2.9;
  const bodyH = o.bodyH ?? 2.4;
  const half = Math.ceil(pins / 2);
  // вдоль ряда площадка не длиннее шага минус зазор
  const along = Math.min(padH, Math.max(0.3, pitch - 0.2));
  const tab = o.tabW && o.tabH ? { w: o.tabW, h: o.tabH } : null;
  const els: LibEl[] = [];
  const btm: LabelledPt[] = [];
  const topPts: LabelledPt[] = [];
  const names = o.names ?? Array.from({ length: pins }, (_, i) => String(i + 1));
  const x0 = -((half - 1) * pitch) / 2;
  for (let i = 0; i < half; i++) {
    els.push(SM(x0 + i * pitch, -rowX / 2, along, padW, 0, cu));
    btm.push({ x: x0 + i * pitch, y: -rowX / 2, t: names[i] });
  }
  const top = pins - half;
  for (let i = 0; i < top; i++) {
    const x = top === 1 ? 0 : -((top - 1) * pitch) / 2 + i * pitch;
    els.push(SM(x, rowX / 2, along, padW, 0, cu));
    topPts.push({ x, y: rowX / 2, t: names[half + i] });
  }
  if (tab) els.push(SM(0, rowX / 2 + padW / 2 + tab.h / 2 + 0.25, tab.w, tab.h, 0, cu));
  els.push(SR(-bodyW / 2, -bodyH / 2, bodyW, bodyH, 0.15, layer));
  els.push(SC(-bodyW / 2 - 0.35, -bodyH / 2 - 0.35, 0.22, 0.15, layer));
  els.push(...labelsFor(btm, 'down', 0.6, padW / 2 + 0.25, layer));
  // подписки верхнего ряда уходят за тепловую площадку, если она есть
  els.push(...labelsFor(topPts, 'up', 0.6, padW / 2 + 0.25 + (tab ? tab.h + 0.3 : 0), layer));
  const smd = els.filter((e) => e.kind === 'smd').length;
  return { els, spec: { smd, pitch: r3(pitch), labels: btm.length + topPts.length, holes: 0 } };
}

// ---------------------------------------------------------------- модули и плата

export interface ModuleOpts {
  /** имена выводов левого ряда (снизу вверх — как в даташитах Arduino) */
  left?: string[];
  right?: string[];
  /** число выводов, если имена не заданы */
  n?: number;
  rows?: number;
  pitch?: number;
  rowW?: number;
  padSize?: number;
  drill?: number;
  socket?: boolean;
  bodyW?: number;
  bodyH?: number;
  holes?: { n: number; d: number; inset?: number; pad?: number };
  /** подписать размеры модуля на шелкографии (по умолчанию — да) */
  dim?: boolean;
  title?: string;
  layer?: LibLayer;
}

/** Модуль на двух штыревых рядах (Nano, Pico, DevKit…) + крепёжные отверстия */
export function moduleFootprint(o: ModuleOpts): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const pitch = o.pitch ?? 2.54;
  const rowW = o.rowW ?? 15.24;
  const padSize = o.padSize ?? (o.socket ? 1.8 : 1.7);
  const drill = o.socket ? 1.0 : 0.9;
  const left = o.left ?? Array.from({ length: o.n ?? 15 }, (_, i) => String(i + 1));
  const right = o.right ?? Array.from({ length: (o.n ?? 15) }, (_, i) => String((o.n ?? 15) + i));
  const n = Math.max(left.length, right.length);
  const y0 = ((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const lp: LabelledPt[] = [];
  const rp: LabelledPt[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 - i * pitch;
    if (left[i] !== undefined) {
      els.push(P(-rowW / 2, y, drill, padSize, i === 0 ? 'square' : 'round'));
      lp.push({ x: -rowW / 2, y, t: left[i] });
    }
    if (right[i] !== undefined) {
      els.push(P(rowW / 2, y, drill, padSize));
      rp.push({ x: rowW / 2, y, t: right[i] });
    }
  }
  els.push(...labelsFor(lp, 'left', 0.8, padSize / 2, layer));
  els.push(...labelsFor(rp, 'right', 0.8, padSize / 2, layer));
  const bw = o.bodyW ?? rowW + 2.5;
  const bh = o.bodyH ?? (n - 1) * pitch + 5.08;
  els.push(SR(-bw / 2, -bh / 2, bw, bh, silkTh(), layer));
  let holes = 0;
  if (o.holes && o.holes.n > 0) {
    const d = o.holes.d;
    // крепёж модуля — СНАРУЖИ штыревых рядов (между рядами меди нет места под кольцо)
    const hx = rowW / 2 + padSize / 2 + d / 2 + (o.holes.inset ?? 0.45);
    const hy = Math.min(y0, bh / 2 - d / 2 - 0.4);
    const k = Math.max(1, Math.min(4, Math.round(o.holes.n)));
    const pts: [number, number][] = k === 1 ? [[hx, 0]]
      : k === 2 ? [[-hx, 0], [hx, 0]]
      : k === 3 ? [[-hx, 0], [hx, -hy], [hx, hy]]
      : [[-hx, -hy], [-hx, hy], [hx, -hy], [hx, hy]];
    for (const [x, y] of pts) {
      holes++;
      if (o.holes.pad && o.holes.pad > 0) els.push(mountPad(x, y, d, o.holes.pad));
      else els.push({ kind: 'hole', x, y, d });
    }
  }
  if (o.dim !== false) {
    els.push(lc(0, bh / 2 + 0.6, `${r3(bw)}x${r3(bh)}`, 0.9, 0, layer));
  }
  if (o.title) els.push(lc(0, -bh / 2 - 1.6, o.title, 0.9, 0, layer));
  return {
    els,
    spec: { pins: lp.length + rp.length, pitch: r3(pitch), labels: lp.length + rp.length, holes, w: r3(bw), h: r3(bh) },
  };
}

export interface BoardOpts {
  w: number;
  h: number;
  /** контур: true — линия по контуру */
  outline?: boolean;
  /** крепёжные отверстия */
  holes?: number;
  holeD?: number;
  holeInset?: number;
  holePad?: number;
  holeRing?: boolean;
  /** сетка/рамка silk вокруг */
  cornerMarks?: boolean;
  /** подписать размеры на шелкографии */
  dim?: boolean;
  /** переходные отверстия-сетка (не для платы — просто поле площадок) */
  fiducials?: number;
  title?: string;
  layer?: LibLayer;
}

/** Плата/основание: контур заданного размера + крепёжные отверстия + подписи размеров */
export function boardFootprint(o: BoardOpts): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const els: LibEl[] = [];
  const hw = o.w / 2, hh = o.h / 2;
  if (o.outline !== false) els.push(SR(-hw, -hh, o.w, o.h, 0.25, layer));
  let holes = 0;
  const n = o.holes ?? 0;
  if (n > 0) {
    const inset = o.holeInset ?? Math.min(3.5, Math.min(hw, hh) * 0.4);
    const d = o.holeD ?? 3.2;
    for (const [x, y] of holeCorners(n, hw, hh, inset)) {
      holes++;
      if (o.holePad && o.holePad > 0) els.push(mountPad(x, y, d, o.holePad));
      else els.push({ kind: 'hole', x, y, d });
      if (o.holeRing) els.push(SC(x, y, Math.max(d / 2, (o.holePad ?? 0) / 2) + 1.0, 0.2, layer));
    }
  }
  if (o.fiducials) {
    for (const [x, y] of holeCorners(Math.min(2, o.fiducials), hw, hh, (o.holeInset ?? 3.5) + 3)) {
      els.push(P(x, y, 0, 1.0, 'round'));
      els.push(SC(x, y, 1.6, 0.15, layer));
    }
  }
  if (o.cornerMarks) {
    const s = Math.min(3, Math.min(hw, hh) * 0.3);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
      els.push(SL(sx * hw, sy * hh - sy * s, sx * hw - sx * s, sy * hh, 0.2, layer));
    }
  }
  if (o.dim !== false) {
    els.push(lc(0, hh + 0.9, `${r3(o.w)} x ${r3(o.h)} мм`, 1.0, 0, layer));
  }
  if (o.title) els.push(lc(0, -hh - 2.2, o.title, 1.2, 0, layer));
  return { els, spec: { holes, w: r3(o.w), h: r3(o.h), labels: 0 } };
}

// ---------------------------------------------------------------- мелочёвка

/** Одиночное крепёжное отверстие (или несколько в линию) */
export function holeFootprint(o: {
  d?: number; n?: number; pitch?: number; pad?: number; ring?: boolean; label?: string;
  layer?: LibLayer;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const n = Math.max(1, Math.round(o.n ?? 1));
  const d = o.d ?? 3.2;
  // несколько отверстий без шага раздвигаем сами — иначе они лягут друг на друга
  const pitch = (o.pitch ?? 0) > 0 ? (o.pitch as number) : (n > 1 ? Math.max(3 * d + 2, 8) : 0);
  const x0 = -((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + i * pitch;
    if (o.pad && o.pad > 0) els.push(P(x, 0, d, o.pad, 'round'));
    else els.push({ kind: 'hole', x, y: 0, d });
    if (o.ring) els.push(SC(x, 0, Math.max(o.pad ?? 0, d) / 2 + 1.0, 0.2, layer));
  }
  if (o.label) els.push(lc(x0, -d / 2 - 1.7, o.label, 0.9, 0, layer));
  return { els, spec: { holes: o.pad ? 0 : n, pins: o.pad ? n : 0, pitch: n > 1 ? r3(pitch) : undefined } };
}

/** Площадка / контрольная точка */
export function padFootprint(o: {
  size?: number; drill?: number; shape?: PadShape; n?: number; pitch?: number;
  ring?: number; smd?: boolean; label?: string; layer?: LibLayer; cu?: 'k1' | 'k2';
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const n = Math.max(1, Math.round(o.n ?? 1));
  const pitch = o.pitch ?? 2.54;
  const x0 = -((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++) {
    const x = x0 + i * pitch;
    if (o.smd) els.push(SM(x, 0, o.size ?? 1.5, o.size ?? 1.5, 0, o.cu ?? 'k1'));
    else els.push(P(x, 0, o.drill ?? 1.0, o.size ?? 1.7, o.shape ?? 'round'));
    if (o.ring) els.push(SC(x, 0, (o.ring ?? 0) / 2, 0.15, layer));
  }
  if (o.label) els.push(lc(x0, -((o.size ?? 1.7)) / 2 - 1.6, o.label, 0.9, 0, layer));
  return {
    els,
    spec: {
      pins: o.smd ? 0 : n, smd: o.smd ? n : 0,
      pitch: n > 1 ? r3(pitch) : undefined, labels: o.label ? 1 : 0,
    },
  };
}

/** Метка совмещения (fiducial): площадка без отверстия + поясок */
export function fiducialFootprint(o: { d?: number; ring?: number; layer?: LibLayer }): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const d = o.d ?? 1.0;
  const ring = o.ring ?? d * 1.6 + 0.6;
  return {
    els: [P(0, 0, 0, d, 'round'), SC(0, 0, ring / 2, 0.15, layer)],
    spec: { pins: 1, labels: 0 },
  };
}

/** Кварц/резонатор: HC-49 (2 вывода) или SMD-корпус (2/4 площадки) */
export function crystalFootprint(o: {
  smd?: boolean; pitch?: number; bodyL?: number; bodyW?: number; pads?: number;
  layer?: LibLayer; title?: string;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  if (!o.smd) {
    const pitch = o.pitch ?? 4.88;
    return {
      els: [
        P(-pitch / 2, 0, 0.9, o.bodyW ?? 2.0, 'round'),
        P(pitch / 2, 0, 0.9, o.bodyW ?? 2.0, 'round'),
        SR(-(pitch / 2 + 3.3), -1.1, pitch + 6.6 + 1.2, 4.8, silkTh(), layer),
        lc(-pitch / 2, -3.4, '1', 0.9, 0, layer),
        lc(pitch / 2, 1.3, '2', 0.9, 0, layer),
      ],
      spec: { pins: 2, pitch: r3(pitch), labels: 2 },
    };
  }
  const pads = o.pads === 4 ? 4 : 2;
  const bl = o.bodyL ?? 3.2;
  const bw = o.bodyW ?? 2.5;
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  const pw = 1.4, ph = Math.min(1.2, Math.max(0.4, (o.bodyW ?? 2.5) - 1.4));
  if (pads === 2) {
    els.push(SM(-bl / 2 + 0.4, 0, 1.0, bw - 0.4, 0, 'k1'));
    els.push(SM(bl / 2 - 0.4, 0, 1.0, bw - 0.4, 0, 'k1'));
  } else {
    const ox = bl / 2 - 0.55, oy = bw / 2 - 0.6;
    els.push(SM(-ox, oy, pw, ph, 0, 'k1'), SM(ox, oy, pw, ph, 0, 'k1'),
      SM(ox, -oy, pw, ph, 0, 'k1'), SM(-ox, -oy, pw, ph, 0, 'k1'));
    pts.push({ x: -ox, y: oy, t: '1' }, { x: ox, y: oy, t: '2' }, { x: ox, y: -oy, t: '3' }, { x: -ox, y: -oy, t: '4' });
  }
  els.push(SR(-bl / 2, -bw / 2, bl, bw, 0.15, layer));
  // подписи рядов — наружу, иначе они ложатся на площадки соседнего ряда
  els.push(...labelsFor(pts.filter((pt) => pt.y > 0), 'up', 0.6, ph / 2 + 0.25, layer));
  els.push(...labelsFor(pts.filter((pt) => pt.y <= 0), 'down', 0.6, ph / 2 + 0.25, layer));
  if (o.title) els.push(lc(0, -bw / 2 - 1.4, o.title, 0.7, 0, layer));
  return { els, spec: { smd: pads, labels: pads } };
}

/** Реле: 4/5 выводов + корпус + подписи (катушка/контакты) */
export function relayFootprint(o: {
  pins?: number; pitch?: number; rows?: number; bodyW?: number; bodyH?: number;
  padSize?: number; drill?: number; names?: string[]; layer?: LibLayer;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const pins = o.pins ?? 5;
  const pitch = o.pitch ?? 5.0;
  const names = o.names ?? (pins === 4 ? ['A', 'K', 'COM', 'NO'] : ['A', 'K', 'COM', 'NO', 'NC']);
  const size = o.padSize ?? 2.2;
  const drill = o.drill ?? 1.1;
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  if (pins <= 5) {
    const x0 = -((pins - 1) * pitch) / 2;
    for (let i = 0; i < pins; i++) {
      els.push(P(x0 + i * pitch, 0, drill, size, i === 0 ? 'square' : 'round'));
      pts.push({ x: x0 + i * pitch, y: 0, t: names[i] ?? String(i + 1) });
    }
    const bw = o.bodyW ?? pins * pitch + 2;
    const bh = o.bodyH ?? 14;
    els.push(SR(-bw / 2, -bh / 2 + 4, bw, bh, silkTh(), layer));
  } else {
    const per = Math.ceil(pins / 2);
    const x0 = -((per - 1) * pitch) / 2;
    for (let i = 0; i < pins; i++) {
      const r = i < per ? 0 : 1;
      const c = r === 0 ? i : i - per;
      const x = r === 0 ? x0 + c * pitch : x0 + (per - 1 - c) * pitch;
      const y = r === 0 ? -pitch : pitch;
      els.push(P(x, y, drill, size, i === 0 ? 'square' : 'round'));
      pts.push({ x, y, t: names[i] ?? String(i + 1) });
    }
    els.push(SR(-(o.bodyW ?? 20) / 2, -9, o.bodyW ?? 20, o.bodyH ?? 18, silkTh(), layer));
  }
  els.push(...labelsFor(pts, 'down', 0.8, size / 2, layer));
  return { els, spec: { pins, pitch: r3(pitch), labels: pins } };
}

/** DIP-переключатель: n секций по 2 вывода */
export function dipSwitchFootprint(o: { n?: number; pitch?: number; rowW?: number; padSize?: number; layer?: LibLayer }): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const n = Math.max(1, Math.round(o.n ?? 4));
  const pitch = o.pitch ?? 2.54;
  const rowW = o.rowW ?? 7.62;
  const size = o.padSize ?? 1.7;
  const y0 = ((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const lp: LabelledPt[] = [];
  const rp: LabelledPt[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 - i * pitch;
    els.push(P(-rowW / 2, y, 0.9, size, i === 0 ? 'square' : 'round'));
    els.push(P(rowW / 2, y, 0.9, size));
    lp.push({ x: -rowW / 2, y, t: String(i + 1) });
    rp.push({ x: rowW / 2, y, t: String(n * 2 - i) });
  }
  els.push(SR(-rowW / 2 + 0.6, -y0 - 1.3, rowW - 1.2, (n - 1) * pitch + 2.6, 0.2, layer));
  els.push(...labelsFor(lp, 'left', 0.75, size / 2, layer));
  els.push(...labelsFor(rp, 'right', 0.75, size / 2, layer));
  return { els, spec: { pins: n * 2, pitch: r3(pitch), labels: n * 2 } };
}

/** Электролитический конденсатор: корпус Ød, полярность «+», крупные — с крепёжным отверстием */
export function electroFootprint(o: {
  d?: number; pitch?: number; padSize?: number; drill?: number; hole?: number;
  layer?: LibLayer; value?: string;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const d = o.d ?? 8;
  const pitch = o.pitch ?? Math.max(2.0, Math.min(5.0, d * 0.45));
  const size = o.padSize ?? 1.8;
  const drill = o.drill ?? 0.9;
  const r = d / 2;
  const els: LibEl[] = [
    P(-pitch / 2, 0, drill, size, 'square'), P(pitch / 2, 0, drill, size, 'round'),
    SC(0, 0, r, silkTh(), layer),
  ];
  if (r > size / 2 + 0.6) {
    els.push(SL(-r - 1.5, 0, -Math.max(r * 0.6, size / 2 + 0.4), 0, 0.3, layer));
    els.push(SL(Math.max(r * 0.6, size / 2 + 0.4), 0, r, 0, 0.3, layer));
  }
  els.push(SL(-r - 1.4, 0, -r - 0.4, 0, 0.4, layer));
  els.push(SL(-r - 0.9, -0.55, -r - 0.9, 0.55, 0.4, layer));
  els.push(lc(r + 1.3, -0.55, '-', 1.1, 0, layer));
  els.push(lc(-pitch / 2, -Math.max(r, size) - 1.1, '+', 1.0, 0, layer));
  if (o.value && textW(o.value, 0.9) <= d - 1) els.push(lc(0, -0.45, o.value, 0.9, 0, layer));
  let holes = 0;
  if (o.hole && o.hole > 0) {
    els.push({ kind: 'hole', x: 0, y: -(r + o.hole / 2 + 1.6), d: o.hole });
    holes = 1;
  }
  return { els, spec: { pins: 2, pitch: r3(pitch), holes, labels: 1, w: r3(d), h: r3(d) } };
}

/** Катушка/дроссель/предохранитель/бусина — корпус + 2 вывода, всё то же, что и у резистора */
export function coilFootprint(o: { d?: number; pitch?: number; round?: boolean; padSize?: number; drill?: number; layer?: LibLayer; value?: string }): { els: LibEl[]; spec: FpSpec } {
  return twoLeadFootprint({
    pitch: o.pitch ?? 7.62,
    bodyL: o.d ?? 8,
    bodyW: o.d ?? 8,
    round: o.round !== false,
    padSize: o.padSize,
    drill: o.drill,
    value: o.value,
    layer: o.layer,
  });
}

/**
 * Shield-разъёмы Arduino Uno R3: 4 ряда с именами сигналов, крепёжные отверстия
 * и контур платы 68.58 × 53.34 мм. Координаты — от центра платы.
 */
export function shieldFootprint(o: {
  w?: number; h?: number; holeD?: number; padSize?: number; drill?: number;
  labels?: boolean; layer?: LibLayer; title?: string;
}): { els: LibEl[]; spec: FpSpec } {
  const layer = o.layer ?? 's1';
  const bw = o.w ?? 68.58, bh = o.h ?? 53.34;
  const padSize = o.padSize ?? 1.8, drill = o.drill ?? 1.0;
  const x = (v: number): number => v - bw / 2;
  const y = (v: number): number => v - bh / 2;
  const top = ['SCL', 'SDA', 'AREF', 'GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
  const top2 = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'TX1', 'RX0'];
  const bot = ['NC', 'IOREF', 'RST', '3V3', '5V', 'GND', 'GND', 'VIN'];
  const ana = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
  const els: LibEl[] = [];
  let pins = 0;
  const mk = (px: number, py: number, names: string[], above: boolean): void => {
    names.forEach((t, i) => {
      pins++;
      els.push(P(x(px + i * 2.54), y(py), drill, padSize, i === 0 ? 'square' : 'round'));
    });
    if (o.labels !== false) {
      els.push(...rowLabels(
        names.map((t, i) => ({ x: x(px + i * 2.54), y: y(py), t })), 0.75, above, padSize / 2, layer,
      ));
    }
  };
  mk(18.796, 50.8, top, true);
  mk(45.72, 50.8, top2, true);
  mk(30.48, 2.54, bot, true);
  mk(53.34, 2.54, ana, true);
  let holes = 0;
  if (o.holeD && o.holeD > 0) {
    for (const [px, py] of [[13.97, 2.54], [15.24, 50.8], [66.04, 7.62], [66.04, 35.56]] as [number, number][]) {
      els.push({ kind: 'hole', x: x(px), y: y(py), d: o.holeD });
      holes++;
    }
  }
  els.push(SR(x(0), y(0), bw, bh, 0.25, layer));
  if (o.title) els.push(lc(0, y(27.94), o.title, 1.0, 0, layer));
  return {
    els,
    spec: { pins, pitch: 2.54, holes, labels: o.labels === false ? 0 : pins, w: r3(bw), h: r3(bh) },
  };
}
