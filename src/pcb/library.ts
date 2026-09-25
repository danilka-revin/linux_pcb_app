// Библиотека компонентов (макросов) в стиле Sprint-Layout.
//
// Все элементы заданы в локальных координатах (мм), начало — точка установки.
// Размеры взяты из даташитов/JEDEC (номинальные посадочные места) и из практики
// ЛУТ/фотошаблона: шаг выводов, диаметры площадок и сверла, контуры корпусов.
// У каждого макроса с выводами есть подписи («1», «2», …, «GND», «IO12», «K», «+»),
// поэтому при установке сразу видно, где какой вывод.
//
// Структура файла:
//   1. язык описания элементов (LibEl) и строительные помощники;
//   2. построители семейств корпусов (DIP, SOIC, QFN, модули и т. д.);
//   3. каталог LIB — список готовых макросов с описанием для проверок (LibSpec).
//
// Проверка всех макросов — test/library.ts (`npm run test:lib`): шаг выводов,
// отсутствие слипшихся площадок, кольцо меди, подписи, слои.

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

/** Ожидаемые характеристики макроса — по ним макросы проверяются тестом. */
export interface LibSpec {
  /** металлизированные (выводные) площадки */
  pins?: number;
  /** планарные площадки */
  smd?: number;
  /** неметаллизированные отверстия */
  holes?: number;
  /** минимальный шаг между соседними выводами, мм */
  pitch?: number;
  /** сколько подписей выводов обязано быть в макросе */
  labels?: number;
  /** особенности/допущения по геометрии */
  note?: string;
}

export interface LibEntry {
  key: string;
  name: string;
  cat: string;
  spec?: LibSpec;
  build: () => LibEl[];
}

// ---------------------------------------------------------------- помощники

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
  x: number, y: number, text: string, size = 1, th = 0.15, rot = 0, layer: LibLayer = 's1',
): LibEl => ({ kind: 'text', x, y, text, size, th, rot, mirror: false, layer });

/** Ширина строки в мм — как считает model.entBBox и рисует strokefont (0.8 × высота) */
export const textW = (t: string, size: number): number => t.length * size * 0.8;

/** Толщина штриха под размер шрифта (не меньше 0.12 мм — норма шелкографии) */
export const thFor = (size: number): number => Math.max(0.12, Math.round(size * 0.16 * 100) / 100);

/** Подпись, отцентрованная по X относительно точки */
export const lc = (
  cx: number, y: number, t: string, size = 1, rot = 0, layer: LibLayer = 's1',
): LibEl => LT(cx - textW(t, size) / 2, y, t, size, thFor(size), rot, layer);

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
): LibEl[] {
  const gap = padR + 0.35;
  return pts.map(({ x, y, t }) => {
    if (dir === 'up') return lc(x, y + padR + 0.2, t, size);
    if (dir === 'down') return lc(x, y - gap - size, t, size);
    if (dir === 'left') return LT(x - gap - textW(t, size), y - size * 0.36, t, size, thFor(size));
    return LT(x + gap, y - size * 0.36, t, size, thFor(size));
  });
}

/**
 * Подписи вдоль плотного ряда, повёрнутые на 90° (как на платах Arduino):
 * `above` — подписи сверху от ряда, иначе снизу.
 */
export function rowLabels(
  pts: LabelledPt[], size = 0.9, above = true, padR = 0.9,
): LibEl[] {
  return pts.map(({ x, y, t }) => {
    const w = textW(t, size);
    const ax = x + size / 2; // «высота» строки при повороте 90° уходит влево
    const ay = above ? y + padR + 0.3 : y - padR - 0.3 - w;
    return LT(ax, ay, t, size, thFor(size), 90);
  });
}

/** Подписи в шахматном порядке (когда ряд подписей плотнее текста) */
export function staggered(
  pts: LabelledPt[], dir: 'down' | 'up', size: number, padR: number, step = 1.0,
): LibEl[] {
  return pts.flatMap(({ x, y, t }, i) => {
    const dy = i % 2 === 0 ? 0 : step;
    const yy = dir === 'down' ? y - padR - 0.35 - size - dy : y + padR + 0.35 + dy;
    return [lc(x, yy, t, size)];
  });
}

/** Ряд площадок с шагом pitch по горизонтали: первый — квадратный */
function row(x0: number, y: number, labels: string[], pitch = 2.54, opts: {
  drill?: number; size?: number; firstSquare?: boolean;
} = {}): LibEl[] {
  const { drill = 1.0, size = 1.8, firstSquare = true } = opts;
  return labels.map((_, i) => P(
    x0 + i * pitch, y, drill, size, firstSquare && i === 0 ? 'square' : 'round',
  ));
}

// ---------------------------------------------------------------- DIP

/**
 * DIP-корпус (шаг 2.54). Нумерация как в даташите: вывод 1 — верхний левый
 * (у ключа), далее вниз по левой стороне и вверх по правой.
 * rowW — расстояние между рядами (7.62 = 300 mil, 15.24 = 600 mil).
 */
export function dip(n: number, rowW: number, kind: 'chip' | 'socket' = 'chip'): LibEl[] {
  const half = n / 2;
  const pitch = 2.54;
  const padSize = kind === 'socket' ? 1.8 : 1.6;
  const drill = kind === 'socket' ? 1.0 : 0.8;
  const y0 = ((half - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < half; i++) {
    const yl = y0 - i * pitch;
    els.push(P(-rowW / 2, yl, drill, padSize, i === 0 ? 'square' : 'round'));
    left.push({ x: -rowW / 2, y: yl, t: String(i + 1) });
    const yr = -y0 + i * pitch;
    els.push(P(rowW / 2, yr, drill, padSize));
    right.push({ x: rowW / 2, y: yr, t: String(n - i) });
  }
  els.push(...labelsFor(left, 'left', 0.9, padSize / 2));
  els.push(...labelsFor(right, 'right', 0.9, padSize / 2));
  const bw = rowW - (rowW > 10 ? 1.5 : 1.27);
  const bh = (half - 1) * pitch + 2.54;
  els.push(SR(-bw / 2, -bh / 2, bw, bh));
  els.push(SC(0, bh / 2, 0.95, 0.3));                        // ключ
  els.push(SL(-1.7, bh / 2 + 1.2, 1.7, bh / 2 + 1.2, 0.25)); // метка первого вывода
  if (kind === 'socket') els.push(SR(-bw / 2 + 0.5, -bh / 2 + 0.5, bw - 1.0, bh - 1.0, 0.15));
  return els;
}

// ---------------------------------------------------------------- SMD корпуса

/** Двухвыводный SMD-компонент (резистор/конденсатор/светодиод) */
export function smdRC(pitch: number, pw: number, ph: number, bw: number, bh: number): LibEl[] {
  return [
    SM(-pitch / 2, 0, pw, ph), SM(pitch / 2, 0, pw, ph),
    SR(-bw / 2, -bh / 2, bw, bh, 0.15),
  ];
}

/** Корпус с двумя рядами SMD-площадок (SOIC, SC-70, MSOP) */
export function soicLike(
  n: number, pitch: number, rowX: number, padLen: number, padH: number, bodyW: number,
  title?: string,
): LibEl[] {
  const half = n / 2;
  const y0 = ((half - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < half; i++) {
    const yl = y0 - i * pitch;
    els.push(SM(-rowX / 2, yl, padLen, padH));
    left.push({ x: -rowX / 2, y: yl, t: String(i + 1) });
    const yr = -y0 + i * pitch;
    els.push(SM(rowX / 2, yr, padLen, padH));
    right.push({ x: rowX / 2, y: yr, t: String(n - i) });
  }
  // подписи только там, где шаг позволяет их разместить без наложения
  const size = Math.min(0.9, pitch * 0.75);
  if (pitch >= 0.8) {
    els.push(...labelsFor(left, 'left', size, padLen / 2));
    els.push(...labelsFor(right, 'right', size, padLen / 2));
  } else {
    els.push(lc(-rowX / 2 - padLen / 2 - 0.6, y0 + 0.9, `1-${n / 2}`, 0.7));
    els.push(lc(rowX / 2 + padLen / 2 + 0.6, -y0 - 1.6, `${n / 2 + 1}-${n}`, 0.7));
  }
  const bh = (half - 1) * pitch + Math.max(1.6, pitch * 1.6);
  els.push(SR(-bodyW / 2, -bh / 2, bodyW, bh, 0.2));
  els.push(SC(-bodyW / 2 - 0.5, bh / 2 + 0.4, 0.3, 0.2)); // метка первого вывода
  if (title && textW(title, 0.7) <= bodyW - 0.5) els.push(lc(0, -0.4, title, 0.7));
  return els;
}

/** SOIC: шаг 1.27, rowX — междурядье по центрам площадок (5.4 узкий / 9.4 широкий) */
export function soic(n: number, rowX = 5.4, padLen = 1.8): LibEl[] {
  return soicLike(n, 1.27, rowX, padLen, 0.6, rowX === 5.4 ? 3.9 : 7.5);
}

/** TSSOP/SSOP: мелкий шаг, узкий корпус */
export function tssop(n: number, pitch: number, rowX: number, bodyW: number): LibEl[] {
  return soicLike(n, pitch, rowX, 1.4, pitch - 0.2, bodyW, `${n}x${pitch}`);
}

/** Сколько номеров выводов будет подписано: 1-й, последний и каждый every-й */
export const labelCount = (n: number, every = 4): number => {
  let c = 0;
  for (let k = 1; k <= n; k++) if (k === 1 || k === n || k % every === 0) c++;
  return c;
};

/** QFN: n выводов по 4 сторонам + тепловая площадка в центре.
 *  Нумерация как в JEDEC: 1 — верхний левый вывод, далее вниз по левой стороне,
 *  по нижней слева направо, вверх по правой и по верхней справа налево. */
export function qfn(n: number, pitch: number, body: number, labelEvery = 4): LibEl[] {
  const per = n / 4;
  const span = (per - 1) * pitch;
  const padC = body / 2 + 0.45;   // центр площадки за краем корпуса
  const padLen = 0.8;
  const padW = Math.max(0.3, Math.min(0.55, pitch - 0.25));    // 0.3 мм — при 0.5 мм шаге
  const els: LibEl[] = [];
  const labels: LibEl[] = [];
  for (let i = 0; i < per; i++) {
    const o = -span / 2 + i * pitch;
    els.push(SM(-padC, -o, padLen, padW));    // левая: сверху вниз → 1…per
    els.push(SM(o, -padC, padW, padLen));     // нижняя: слева направо → per+1…2per
    els.push(SM(padC, o, padLen, padW));      // правая: снизу вверх → 2per+1…3per
    els.push(SM(-o, padC, padW, padLen));     // верхняя: справа налево → 3per+1…n
    const nums = [i + 1, per + 1 + i, per * 2 + 1 + i, per * 3 + 1 + i];
    const pos = [
      { x: -padC - padLen / 2 - 0.75, y: -o - 0.28 },  // слева
      { x: o, y: -padC - padLen / 2 - 1.0 },           // снизу
      { x: padC + padLen / 2 + 0.3, y: o - 0.28 },     // справа
      { x: -o, y: padC + padLen / 2 + 0.3 },           // сверху
    ];
    for (let sSide = 0; sSide < 4; sSide++) {
      const num = nums[sSide];
      if (num === 1 || num === n || num % labelEvery === 0) {
        labels.push(sSide === 2
          ? LT(pos[sSide].x, pos[sSide].y, String(num), 0.7, thFor(0.7))
          : lc(pos[sSide].x, pos[sSide].y, String(num), 0.7));
      }
    }
  }
  els.push(SM(0, 0, body * 0.62, body * 0.62)); // тепловая площадка
  els.push(SR(-body / 2, -body / 2, body, body, 0.15));
  els.push(SC(-body / 2 - 0.35, body / 2 + 0.35, 0.25, 0.15));
  els.push(...labels);
  return els;
}

/** LQFP: n выводов с шагом pitch, корпус body×body (нумерация как у QFN) */
export function lqfp(n: number, pitch: number, body: number, labelEvery = 4): LibEl[] {
  const per = n / 4;
  const span = (per - 1) * pitch;
  const padC = body / 2 + 0.45;
  const padLen = 1.25;
  const pw = Math.max(0.3, pitch - 0.2);
  const els: LibEl[] = [];
  const labels: LibEl[] = [];
  for (let i = 0; i < per; i++) {
    const o = -span / 2 + i * pitch;
    els.push(SM(-padC, -o, padLen, pw));    // левая: сверху вниз → 1…per
    els.push(SM(o, -padC, pw, padLen));     // нижняя: слева направо → per+1…2per
    els.push(SM(padC, o, padLen, pw));      // правая: снизу вверх → 2per+1…3per
    els.push(SM(-o, padC, pw, padLen));     // верхняя: справа налево → 3per+1…n
    const nums = [i + 1, per + 1 + i, per * 2 + 1 + i, per * 3 + 1 + i];
    const pos = [
      { x: -padC - padLen / 2 - 0.85, y: -o - 0.28 },
      { x: o, y: -padC - padLen / 2 - 1.1 },
      { x: padC + padLen / 2 + 0.35, y: o - 0.28 },
      { x: -o, y: padC + padLen / 2 + 0.35 },
    ];
    for (let sSide = 0; sSide < 4; sSide++) {
      const num = nums[sSide];
      if (num === 1 || num === n || num % labelEvery === 0) {
        labels.push(sSide === 2
          ? LT(pos[sSide].x, pos[sSide].y, String(num), 0.7, thFor(0.7))
          : lc(pos[sSide].x, pos[sSide].y, String(num), 0.7));
      }
    }
  }
  els.push(SR(-body / 2, -body / 2, body, body, 0.2));
  els.push(SC(-body / 2 - 0.6, body / 2 + 0.6, 0.35, 0.2));
  els.push(...labels);
  return els;
}

// ---------------------------------------------------------------- выводные корпуса

/** Осевой резистор: pitch между площадками, корпус bodyL×bodyW */
export function resistor(pitch: number, bodyL: number, bodyW: number): LibEl[] {
  return [
    P(-pitch / 2, 0), P(pitch / 2, 0),
    SR(-bodyL / 2, -bodyW / 2, bodyL, bodyW),
    SL(-pitch / 2, 0, -bodyL / 2, 0, 0.3),
    SL(bodyL / 2, 0, pitch / 2, 0, 0.3),
  ];
}

/** Диод: кольцо катода у вывода 2 (K) */
export function diode(pitch: number, bodyL: number, bodyW: number): LibEl[] {
  const cw = bodyW / 2;
  return [
    P(-pitch / 2, 0, 0.8), P(pitch / 2, 0, 0.8, 1.8, 'square'),
    SR(-bodyL / 2, -bodyW / 2, bodyL, bodyW),
    SL(bodyL / 2 - 1.1, -cw, bodyL / 2 - 1.1, cw, 0.5),
    SL(-pitch / 2, 0, -bodyL / 2, 0, 0.3),
    SL(bodyL / 2, 0, pitch / 2, 0, 0.3),
    lc(-pitch / 2, -1.9, 'A', 0.9),
    lc(pitch / 2, 1.1, 'K', 0.9),
  ];
}

/** Светодиод: корпус Ød, катод (вывод 2) помечен буквой K */
export function led(d: number): LibEl[] {
  return [
    P(-1.27, 0, 0.9, 1.8), P(1.27, 0, 0.9, 1.8, 'square'),
    SC(0, 0, d / 2),
    SL(-1.27, 0, -d / 2, 0, 0.3),
    SL(d / 2, 0, 1.27, 0, 0.3),
    SL(d / 2 - d * 0.22, -d * 0.34, d / 2 - d * 0.22, d * 0.34, 0.4), // срез катода
    lc(-1.27, -1.9, 'A', 0.9),
    lc(1.27, 1.1, 'K', 0.9),
  ];
}

/** Керамический конденсатор: корпус Ø2r, шаг pitch */
export function capCer(r: number, pitch: number): LibEl[] {
  return [
    P(-pitch / 2, 0, 0.8), P(pitch / 2, 0, 0.8),
    SC(0, 0, r),
    SL(-pitch / 2, 0, -r * 0.55, 0, 0.3),
    SL(r * 0.55, 0, pitch / 2, 0, 0.3),
  ];
}

/** Электролит: корпус Ød, шаг pitch, «+» у первого вывода */
export function capElec(d: number, pitch: number): LibEl[] {
  const r = d / 2;
  return [
    P(-pitch / 2, 0, 0.9, 1.8, 'square'), P(pitch / 2, 0, 0.9),
    SC(0, 0, r),
    SL(-r - 1.5, 0, -r - 0.4, 0, 0.4),
    SL(-r - 0.95, -0.55, -r - 0.95, 0.55, 0.4),
    lc(r + 1.3, -0.55, '-', 1.1),
    lc(-pitch / 2, -2.0, '+', 1.0),
  ];
}

/** Тантал (капля) THT: корпус Ømax(w,h), шаг pitch, «+» у первого вывода */
export function tantTHT(pitch: number, w: number, h: number): LibEl[] {
  const r = Math.max(w, h) / 2;
  return [
    P(-pitch / 2, 0, 0.8, 1.6, 'square'), P(pitch / 2, 0, 0.8, 1.6),
    SC(0, 0, r, 0.25),
    SL(-pitch / 2, -r - 1.0, -pitch / 2 + 0.8, -r - 1.0, 0.3),
    lc(-pitch / 2, -r - 1.9, '+', 0.9),
  ];
}

/** Плёночный конденсатор (К73-17): шаг pitch, корпус bodyL×bodyW */
export function capFilm(pitch: number, bodyL: number, bodyW: number): LibEl[] {
  return [
    P(-pitch / 2, 0, 0.9, 1.7), P(pitch / 2, 0, 0.9, 1.7),
    SR(-bodyL / 2, -bodyW / 2, bodyL, bodyW),
    SL(-pitch / 2, 0, -bodyL / 2, 0, 0.3),
    SL(bodyL / 2, 0, pitch / 2, 0, 0.3),
  ];
}

/** TO-92: три вывода в линию, корпус — круг с плоской гранью сверху */
export function to92(pitch = 1.27, padSize = 1.1, drill = 0.7): LibEl[] {
  const r = 2.35;
  const y0 = 3.3; // центр корпуса выше ряда выводов
  return [
    P(-pitch, 0, drill, padSize, 'square'), P(0, 0, drill, padSize), P(pitch, 0, drill, padSize),
    SC(0, y0, r),
    SL(-r + 0.45, y0 + 1.65, r - 0.45, y0 + 1.65, 0.3), // плоская грань
    ...labelsFor([
      { x: -pitch, y: 0, t: '1' }, { x: 0, y: 0, t: '2' }, { x: pitch, y: 0, t: '3' },
    ], 'down', 0.85, padSize / 2),
  ];
}

/** TO-126 / TO-220: три вывода с шагом 2.54 + отверстие под винт */
export function toPack(
  bodyW: number, bodyH: number, holeY: number, holeD: number, padSize: number, names = ['1', '2', '3'],
): LibEl[] {
  const xs = [-2.54, 0, 2.54];
  return [
    ...xs.map((x) => P(x, 0, 1.1, padSize)),
    SR(-bodyW / 2, 1.3, bodyW, bodyH),
    SL(-bodyW / 2, 1.3 + bodyH, bodyW / 2, 1.3 + bodyH, 0.4),
    { kind: 'hole', x: 0, y: holeY, d: holeD },
    SC(0, holeY, holeD / 2 + 1.2, 0.3),
    ...labelsFor(xs.map((x, i) => ({ x, y: 0, t: names[i] })), 'down', 0.9, padSize / 2),
  ];
}

/** Штыревая линейка PLS, шаг 2.54: первый вывод квадратный, выводы подписаны */
export function pls(n: number, padSize = 1.8, drill = 1.0): LibEl[] {
  const labels = Array.from({ length: n }, (_, i) => String(i + 1));
  const x0 = -((n - 1) * 2.54) / 2;
  const els = row(x0, 0, labels, 2.54, { drill, size: padSize, firstSquare: true });
  els.push(SR(-n * 1.27 + 0.15, -1.35, n * 2.54 - 0.3, 2.7));
  const pts = labels.map((t, i) => ({ x: x0 + i * 2.54, y: 0, t }));
  const show = pts.filter((p) => n <= 20 || p.t === '1' || Number(p.t) % 5 === 0 || Number(p.t) === n);
  els.push(...labelsFor(show, 'down', 0.85, padSize / 2));
  return els;
}

/** Винтовой клеммник, шаг pitch (5.08 или 3.5 мм) */
export function klem(n: number, pitch = 5.08, padSize = 2.6, drill = 1.3): LibEl[] {
  const w = n * pitch;
  const labels = Array.from({ length: n }, (_, i) => String(i + 1));
  const x0 = -((n - 1) * pitch) / 2;
  const bodyH = pitch >= 5 ? 10.0 : 8.0;
  const els = labels.map((_, i) => P(x0 + i * pitch, 0, drill, padSize, i === 0 ? 'square' : 'round'));
  els.push(SR(-w / 2 + 0.4, -bodyH / 2 + 1.6, w - 0.8, bodyH));
  els.push(...labelsFor(labels.map((t, i) => ({ x: x0 + i * pitch, y: 0, t })), 'up', 1.0, padSize / 2));
  return els;
}

/** Кварц HC-49S: выводы через 4.88 мм */
export function hc49(): LibEl[] {
  return [
    P(-2.44, 0, 0.9, 2.0), P(2.44, 0, 0.9, 2.0),
    SR(-5.75, -2.4, 11.5, 4.8),
    lc(-2.44, -3.4, '1', 0.9),
    lc(2.44, 1.3, '2', 0.9),
  ];
}

/** Модуль на двух штыревых рядах (Nano, DevKit, NodeMCU…) с подписями выводов */
export function dualRow(
  leftNames: string[], rightNames: string[], rowSpan: number, bw: number, bh: number,
  padSize = 1.7, drill = 0.9,
): LibEl[] {
  const n = Math.max(leftNames.length, rightNames.length);
  const y0 = ((n - 1) * 2.54) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 - i * 2.54;
    if (leftNames[i] !== undefined) {
      els.push(P(-rowSpan / 2, y, drill, padSize, i === 0 ? 'square' : 'round'));
      left.push({ x: -rowSpan / 2, y, t: leftNames[i] });
    }
    if (rightNames[i] !== undefined) {
      els.push(P(rowSpan / 2, y, drill, padSize));
      right.push({ x: rowSpan / 2, y, t: rightNames[i] });
    }
  }
  els.push(...labelsFor(left, 'left', 0.8, padSize / 2));
  els.push(...labelsFor(right, 'right', 0.8, padSize / 2));
  els.push(SR(-bw / 2, -bh / 2, bw, bh));
  return els;
}

/** Штыревой разъём 2×N (IDC/гребёнка), нумерация 1,2 / 3,4 / … */
export function dualHeader(n: number, pitch = 2.54, padSize = 1.8, drill = 1.0): LibEl[] {
  const y0 = ((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 - i * pitch;
    els.push(P(-pitch / 2, y, drill, padSize, i === 0 ? 'square' : 'round'));
    els.push(P(pitch / 2, y, drill, padSize));
    left.push({ x: -pitch / 2, y, t: String(i * 2 + 1) });
    right.push({ x: pitch / 2, y, t: String(i * 2 + 2) });
  }
  els.push(...labelsFor(left, 'left', 0.8, padSize / 2));
  els.push(...labelsFor(right, 'right', 0.8, padSize / 2));
  els.push(SR(-pitch - 0.4, -y0 - pitch / 2 - 0.3, pitch * 2 + 0.8, (n - 1) * pitch + pitch + 0.6));
  return els;
}

/** Штыревой разъём 1×N для SMD-монтажа */
export function headerSMD(n: number, pitch = 2.54): LibEl[] {
  const x0 = -((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++) els.push(SM(x0 + i * pitch, 0, 1.6, 2.0));
  els.push(SR(-n * pitch / 2 + 0.3, -1.1, n * pitch - 0.6, 2.2, 0.2));
  els.push(...labelsFor(
    Array.from({ length: n }, (_, i) => ({ x: x0 + i * pitch, y: 0, t: String(i + 1) })),
    'down', 0.8, 1.0,
  ));
  return els;
}

/** Разъём с одним рядом мелкого шага (JST и подобные) */
export function smallCon(
  n: number, pitch: number, pw: number, ph: number, bodyW: number, bodyH: number,
): LibEl[] {
  const x0 = -((n - 1) * pitch) / 2;
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++) els.push(P(x0 + i * pitch, 0, 0.8, pw, i === 0 ? 'square' : 'round'));
  els.push(SR(-bodyW / 2, -bodyH / 2, bodyW, bodyH));
  els.push(...labelsFor(
    Array.from({ length: n }, (_, i) => ({ x: x0 + i * pitch, y: 0, t: String(i + 1) })),
    'down', Math.min(0.8, ph * 0.7), pw / 2,
  ));
  return els;
}

/** Кнопка тактовая: 4 вывода по углам */
export function tact(px: number, py: number, body: number, bodyY: number, padSize = 1.6): LibEl[] {
  const xs = [-px / 2, px / 2];
  const ys = [-py / 2, py / 2];
  const els: LibEl[] = [];
  const pts: LabelledPt[] = [];
  let k = 1;
  for (const y of ys) for (const x of xs) {
    els.push(P(x, y, 0.8, padSize, k === 1 ? 'square' : 'round'));
    pts.push({ x, y, t: String(k++) });
  }
  els.push(SR(-body / 2, -bodyY / 2, body, bodyY));
  els.push(SC(0, 0, Math.min(body, bodyY) * 0.18, 0.2));
  els.push(...labelsFor(pts, 'right', 0.75, padSize / 2));
  return els;
}

/** DIP-переключатель: n секций по 2 вывода (шаг 2.54) */
export function dipSw(n: number): LibEl[] {
  const els: LibEl[] = [];
  const y0 = ((n - 1) * 2.54) / 2;
  const left: LabelledPt[] = [];
  const right: LabelledPt[] = [];
  for (let i = 0; i < n; i++) {
    const y = y0 - i * 2.54;
    els.push(P(-3.81, y, 0.9, 1.7, i === 0 ? 'square' : 'round'));
    els.push(P(3.81, y, 0.9, 1.7));
    left.push({ x: -3.81, y, t: String(i + 1) });
    right.push({ x: 3.81, y, t: String(n * 2 - i) });
  }
  els.push(SR(-3.2, -y0 - 1.3, 6.4, (n - 1) * 2.54 + 2.6, 0.2));
  els.push(...labelsFor(left, 'left', 0.75, 0.85));
  els.push(...labelsFor(right, 'right', 0.75, 0.85));
  for (let i = 0; i < n; i++) els.push(lc(0, y0 - i * 2.54 - 0.4, `S${i + 1}`, 0.7));
  return els;
}

/** Гребёнка Raspberry Pi 40-pin (HAT) с именами сигналов */
export function rpi40(): LibEl[] {
  const left = ['3V3', 'IO2', 'IO3', 'IO4', 'GND', 'IO17', 'IO27', 'IO22', '3V3', 'MOSI', 'MISO', 'SCLK', 'GND', 'ID_SD', 'IO5', 'IO6', 'IO13', 'IO19', 'IO26', 'GND'];
  const right = ['5V', '5V', 'GND', 'IO14', 'IO15', 'IO18', 'GND', 'IO23', 'IO24', 'GND', 'IO25', 'IO8', 'IO7', 'ID_SC', 'GND', 'IO12', 'GND', 'IO16', 'IO20', 'IO21'];
  const els: LibEl[] = [];
  const y0 = (19 * 2.54) / 2;
  const lpts: LabelledPt[] = [];
  const rpts: LabelledPt[] = [];
  for (let i = 0; i < 20; i++) {
    const y = y0 - i * 2.54;
    els.push(P(-1.27, y, 1.0, 1.8, i === 0 ? 'square' : 'round'));
    els.push(P(1.27, y, 1.0, 1.8));
    lpts.push({ x: -1.27, y, t: left[i] });
    rpts.push({ x: 1.27, y, t: right[i] });
  }
  els.push(SR(-2.9, -y0 - 1.3, 5.8, 19 * 2.54 + 2.6, 0.2));
  els.push(...labelsFor(lpts, 'left', 0.75, 0.9));
  els.push(...labelsFor(rpts, 'right', 0.75, 0.9));
  return els;
}

/** Arduino Uno R3: разъёмы шилда с подписями + 4 крепёжных отверстия */
export function unoShield(): LibEl[] {
  const x = (v: number): number => v - 34.29; // плата 68.58×53.34
  const y = (v: number): number => v - 26.67;
  const top = ['SCL', 'SDA', 'AREF', 'GND', 'D13', 'D12', 'D11', 'D10', 'D9', 'D8'];
  const top2 = ['D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'TX1', 'RX0'];
  const bot = ['NC', 'IOREF', 'RST', '3V3', '5V', 'GND', 'GND', 'VIN'];
  const ana = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5'];
  const els: LibEl[] = [];
  const mk = (xs: number, yy: number, names: string[]): void => {
    names.forEach((_, i) => els.push(P(x(xs + i * 2.54), y(yy), 1.0, 1.8, i === 0 ? 'square' : 'round')));
  };
  mk(18.796, 50.8, top);
  mk(45.72, 50.8, top2);
  mk(30.48, 2.54, bot);
  mk(53.34, 2.54, ana);
  const lab = (xs: number, yy: number, names: string[], above: boolean): void => {
    els.push(...rowLabels(
      names.map((t, i) => ({ x: x(xs + i * 2.54), y: y(yy), t })), 0.75, above,
    ));
  };
  lab(18.796, 50.8, top, true);
  lab(45.72, 50.8, top2, true);
  lab(30.48, 2.54, bot, true);
  lab(53.34, 2.54, ana, true);
  els.push({ kind: 'hole', x: x(13.97), y: y(2.54), d: 3.2 });
  els.push({ kind: 'hole', x: x(15.24), y: y(50.8), d: 3.2 });
  els.push({ kind: 'hole', x: x(66.04), y: y(7.62), d: 3.2 });
  els.push({ kind: 'hole', x: x(66.04), y: y(35.56), d: 3.2 });
  els.push(SR(x(0), y(0), 68.58, 53.34));
  return els;
}

/** Arduino Pro Mini: два ряда 2×12 + разъём FTDI 1×6 */
export function proMini(): LibEl[] {
  const leftNames = ['TX0', 'RX1', 'RST', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'];
  const rightNames = ['RAW', 'GND', 'RST', 'VCC', 'A3', 'A2', 'A1', 'A0', 'D13', 'D12', 'D11', 'D10'];
  const els: LibEl[] = [];
  const lpts: LabelledPt[] = [];
  const rpts: LabelledPt[] = [];
  for (let i = 0; i < 12; i++) {
    const y = 13.97 - i * 2.54;
    els.push(P(-7.62, y, 0.8, 1.7, i === 0 ? 'square' : 'round'));
    els.push(P(7.62, y, 0.8, 1.7));
    lpts.push({ x: -7.62, y, t: leftNames[i] });
    rpts.push({ x: 7.62, y, t: rightNames[i] });
  }
  els.push(...labelsFor(lpts, 'left', 0.75, 0.85));
  els.push(...labelsFor(rpts, 'right', 0.75, 0.85));
  const ftdi = ['GND', 'CTS', 'VCC', 'TX', 'RX', 'DTR'];
  ftdi.forEach((_, i) => els.push(P(-6.35 + i * 2.54, -16.51, 0.8, 1.7, i === 0 ? 'square' : 'round')));
  els.push(...rowLabels(ftdi.map((t, i) => ({ x: -6.35 + i * 2.54, y: -16.51, t })), 0.75, true));
  els.push(SR(-8.89, -16.51, 17.78, 33.02));
  return els;
}

/** ESP-12F/ESP-07: площадки по краям модуля с подписями */
export function esp12(left: string[], right: string[]): LibEl[] {
  const els: LibEl[] = [];
  for (let i = 0; i < 8; i++) {
    const y = 7.62 - i * 2.0;
    els.push(SM(-8.0, y, 2.0, 0.9));
    els.push(SM(8.0, -y, 2.0, 0.9));
  }
  els.push(SR(-8.0, -8.5, 16.0, 17.0, 0.15));
  els.push(...labelsFor(left.map((t, i) => ({ x: -8.0, y: 7.62 - i * 2.0, t })), 'left', 0.7, 1.0));
  els.push(...labelsFor(right.map((t, i) => ({ x: 8.0, y: -7.62 + i * 2.0, t })), 'right', 0.7, 1.0));
  return els;
}

// ---------------------------------------------------------------- каталог

export const CATS = [
  'Резисторы и диоды',
  'Конденсаторы',
  'Микросхемы (DIP)',
  'SMD',
  'Транзисторы',
  'Разъёмы',
  'Arduino',
  'ESP32 / ESP8266',
  'Катушки и реле',
  'Прочее',
  'Крепёж и площадки',
];

const E = (
  key: string, name: string, cat: string, build: () => LibEl[], spec?: LibSpec,
): [string, LibEntry] => [key, { key, name, cat, spec, build }];

const dipEntry = (n: number, rowW: number, name: string): [string, LibEntry] =>
  E('dip' + n + (rowW > 10 ? 'w' : ''), name, 'Микросхемы (DIP)', () => dip(n, rowW), {
    pins: n, pitch: 2.54, labels: n,
    note: `междурядье ${rowW} мм, площадка 1.6/0.8 мм`,
  });

const socketEntry = (n: number, rowW: number): [string, LibEntry] =>
  E('soc' + n + (rowW > 10 ? 'w' : ''), `Панелька DIP-${n} (${rowW > 10 ? 600 : 300} mil)`,
    'Микросхемы (DIP)', () => dip(n, rowW, 'socket'),
    { pins: n, pitch: 2.54, labels: n, note: 'площадка 1.8/1.0 мм под панельку' });

const plsEntry = (n: number): [string, LibEntry] =>
  E('pls' + n, `Штыри PLS-${n} (2.54 мм)`, 'Разъёмы', () => pls(n), {
    pins: n, pitch: 2.54, labels: n <= 20 ? n : 1 + Math.floor(n / 5) + (n % 5 ? 1 : 0),
    note: n <= 20 ? 'подписаны все выводы' : 'подписаны 1-й, каждый 5-й и последний вывод',
  });

const LIST: Array<[string, LibEntry]> = [
  // ------------------------------------------------ Резисторы и диоды
  E('r0125', 'Резистор 0.125 Вт (7.62 мм)', 'Резисторы и диоды', () => resistor(7.62, 3.6, 1.8),
    { pins: 2, pitch: 7.62 }),
  E('r025', 'Резистор 0.25 Вт (10.16 мм)', 'Резисторы и диоды', () => resistor(10.16, 6.5, 2.3),
    { pins: 2, pitch: 10.16 }),
  E('r05', 'Резистор 0.5 Вт (12.7 мм)', 'Резисторы и диоды', () => resistor(12.7, 9.0, 3.2),
    { pins: 2, pitch: 12.7 }),
  E('r1', 'Резистор 1 Вт (15.24 мм)', 'Резисторы и диоды', () => resistor(15.24, 11.0, 3.5),
    { pins: 2, pitch: 15.24 }),
  E('r2', 'Резистор 2 Вт (20.32 мм)', 'Резисторы и диоды', () => resistor(20.32, 15.0, 4.5),
    { pins: 2, pitch: 20.32 }),
  E('do35', 'Диод DO-35 (1N4148/КД522)', 'Резисторы и диоды', () => diode(7.62, 4.0, 2.0),
    { pins: 2, pitch: 7.62, labels: 2 }),
  E('do41', 'Диод DO-41 (1N4007)', 'Резисторы и диоды', () => diode(10.16, 5.2, 2.5),
    { pins: 2, pitch: 10.16, labels: 2 }),
  E('do201', 'Диод DO-201 (1N5408)', 'Резисторы и диоды', () => diode(12.7, 9.5, 3.6),
    { pins: 2, pitch: 12.7, labels: 2 }),
  E('led3', 'Светодиод 3 мм', 'Резисторы и диоды', () => led(3), { pins: 2, pitch: 2.54, labels: 2 }),
  E('led5', 'Светодиод 5 мм', 'Резисторы и диоды', () => led(5), { pins: 2, pitch: 2.54, labels: 2 }),
  E('led10', 'Светодиод 10 мм', 'Резисторы и диоды', () => led(10), { pins: 2, pitch: 2.54, labels: 2 }),

  // ------------------------------------------------ Конденсаторы
  E('capc254', 'Керамический, шаг 2.54', 'Конденсаторы', () => capCer(1.4, 2.54),
    { pins: 2, pitch: 2.54 }),
  E('capc508', 'Керамический, шаг 5.08', 'Конденсаторы', () => capCer(2.2, 5.08),
    { pins: 2, pitch: 5.08 }),
  E('capc762', 'Керамический, шаг 7.62', 'Конденсаторы', () => capCer(2.8, 7.62),
    { pins: 2, pitch: 7.62 }),
  E('cape5', 'Электролит Ø5, шаг 2.0', 'Конденсаторы', () => capElec(5, 2.0),
    { pins: 2, pitch: 2.0, labels: 2 }),
  E('cape63', 'Электролит Ø6.3, шаг 2.5', 'Конденсаторы', () => capElec(6.3, 2.5),
    { pins: 2, pitch: 2.5, labels: 2 }),
  E('cape8', 'Электролит Ø8, шаг 3.5', 'Конденсаторы', () => capElec(8, 3.5),
    { pins: 2, pitch: 3.5, labels: 2 }),
  E('cape10', 'Электролит Ø10, шаг 5.0', 'Конденсаторы', () => capElec(10, 5.0),
    { pins: 2, pitch: 5.0, labels: 2 }),
  E('cape125', 'Электролит Ø12.5, шаг 5.0', 'Конденсаторы', () => capElec(12.5, 5.0),
    { pins: 2, pitch: 5.0, labels: 2 }),
  E('cape16', 'Электролит Ø16, шаг 7.5', 'Конденсаторы', () => capElec(16, 7.5),
    { pins: 2, pitch: 7.5, labels: 2 }),
  E('tantA', 'Тантал THT 4.5×4.5, шаг 2.5', 'Конденсаторы', () => tantTHT(2.5, 4.5, 4.5),
    { pins: 2, pitch: 2.5, labels: 1 }),
  E('tantB', 'Тантал THT 4.5×7.0, шаг 2.5', 'Конденсаторы', () => tantTHT(2.5, 4.5, 7.0),
    { pins: 2, pitch: 2.5, labels: 1 }),
  E('film10', 'Плёночный 10 мм (К73-17)', 'Конденсаторы', () => capFilm(10, 7.0, 5.0),
    { pins: 2, pitch: 10 }),
  E('film15', 'Плёночный 15 мм', 'Конденсаторы', () => capFilm(15, 10.0, 6.0),
    { pins: 2, pitch: 15 }),
  E('film225', 'Плёночный 22.5 мм', 'Конденсаторы', () => capFilm(22.5, 18.0, 8.0),
    { pins: 2, pitch: 22.5 }),

  // ------------------------------------------------ Микросхемы (DIP)
  dipEntry(4, 7.62, 'DIP-4 (оптрон PC817)'),
  dipEntry(6, 7.62, 'DIP-6 (оптрон MOC)'),
  dipEntry(8, 7.62, 'DIP-8 (NE555, ATtiny)'),
  dipEntry(14, 7.62, 'DIP-14'),
  dipEntry(16, 7.62, 'DIP-16'),
  dipEntry(18, 7.62, 'DIP-18'),
  dipEntry(20, 7.62, 'DIP-20'),
  dipEntry(24, 7.62, 'DIP-24 узкий (300 mil)'),
  dipEntry(28, 7.62, 'DIP-28 узкий (300 mil)'),
  dipEntry(28, 15.24, 'DIP-28 широкий (600 mil)'),
  dipEntry(32, 15.24, 'DIP-32 широкий (600 mil)'),
  dipEntry(40, 15.24, 'DIP-40 (ATmega, 600 mil)'),
  socketEntry(8, 7.62),
  socketEntry(14, 7.62),
  socketEntry(16, 7.62),
  socketEntry(28, 15.24),
  socketEntry(40, 15.24),

  // ------------------------------------------------ SMD
  E('r0402', 'Резистор/конд. 0402', 'SMD', () => smdRC(1.0, 0.6, 0.7, 1.0, 0.5), { smd: 2, pitch: 1.0 }),
  E('r0603', 'Резистор/конд. 0603', 'SMD', () => smdRC(1.6, 0.9, 0.95, 1.6, 0.8), { smd: 2, pitch: 1.6 }),
  E('r0805', 'Резистор/конд. 0805', 'SMD', () => smdRC(1.9, 1.0, 1.35, 2.0, 1.25), { smd: 2, pitch: 1.9 }),
  E('r1206', 'Резистор/конд. 1206', 'SMD', () => smdRC(3.0, 1.2, 1.8, 3.2, 1.6), { smd: 2, pitch: 3.0 }),
  E('r1210', 'Резистор/конд. 1210', 'SMD', () => smdRC(3.0, 1.2, 2.6, 3.2, 2.5), { smd: 2, pitch: 3.0 }),
  E('r2010', 'Резистор 2010 (0.75 Вт)', 'SMD', () => smdRC(4.4, 1.4, 2.9, 5.0, 2.5), { smd: 2, pitch: 4.4 }),
  E('r2512', 'Резистор 2512 (1 Вт)', 'SMD', () => smdRC(5.6, 1.5, 3.3, 6.3, 3.2), { smd: 2, pitch: 5.6 }),
  E('led0603', 'Светодиод SMD 0603', 'SMD', () => smdRC(1.6, 0.9, 0.95, 1.6, 0.8), { smd: 2, pitch: 1.6 }),
  E('led0805', 'Светодиод SMD 0805', 'SMD', () => smdRC(1.9, 1.0, 1.35, 2.0, 1.25), { smd: 2, pitch: 1.9 }),
  E('led1206', 'Светодиод SMD 1206', 'SMD', () => smdRC(3.0, 1.2, 1.8, 3.2, 1.6), { smd: 2, pitch: 3.0 }),
  E('sod123', 'Диод SOD-123', 'SMD', () => smdRC(2.8, 1.4, 1.0, 2.7, 1.3), { smd: 2, pitch: 2.8 }),
  E('sod323', 'Диод SOD-323', 'SMD', () => smdRC(1.9, 1.0, 0.7, 1.7, 0.9), { smd: 2, pitch: 1.9 }),
  E('sma', 'Диод SMA (DO-214AC)', 'SMD', () => smdRC(4.4, 2.0, 1.7, 4.3, 2.6), { smd: 2, pitch: 4.4 }),
  E('smb', 'Диод SMB (DO-214AA)', 'SMD', () => smdRC(4.7, 2.2, 1.9, 4.3, 3.6), { smd: 2, pitch: 4.7 }),
  E('smc', 'Диод SMC (DO-214AB)', 'SMD', () => smdRC(6.9, 2.6, 2.3, 6.0, 5.2), { smd: 2, pitch: 6.9 }),
  E('sot23', 'Транзистор SOT-23', 'SMD', () => [
    SM(-0.95, -1.1, 0.9, 1.0), SM(0.95, -1.1, 0.9, 1.0), SM(0, 1.1, 0.9, 1.0),
    SR(-0.7, -1.45, 1.4, 2.9, 0.15),
    lc(-0.95, -2.7, '1', 0.75), lc(0.95, -2.7, '2', 0.75), lc(0, 2.0, '3', 0.75),
  ], { smd: 3, pitch: 1.9, labels: 3, note: 'площадки 0.9×1.0 мм, междурядье 2.2 мм' }),
  E('sot235', 'SOT-23-5 (стабилизатор/LDO)', 'SMD', () => [
    SM(-0.95, -1.1, 0.6, 1.0), SM(0, -1.1, 0.6, 1.0), SM(0.95, -1.1, 0.6, 1.0),
    SM(-0.95, 1.1, 0.6, 1.0), SM(0.95, 1.1, 0.6, 1.0),
    SR(-1.55, -1.45, 3.1, 2.9, 0.15),
    lc(-0.95, -2.7, '1', 0.75), lc(0, -2.7, '2', 0.75), lc(0.95, -2.7, '3', 0.75),
    lc(-0.95, 2.0, '5', 0.75), lc(0.95, 2.0, '4', 0.75),
  ], { smd: 5, pitch: 0.95, labels: 5, note: 'площадки 0.6×1.0 мм при шаге 0.95 мм' }),
  E('sot236', 'SOT-23-6', 'SMD', () => [
    SM(-0.95, -1.1, 0.6, 1.0), SM(0, -1.1, 0.6, 1.0), SM(0.95, -1.1, 0.6, 1.0),
    SM(-0.95, 1.1, 0.6, 1.0), SM(0, 1.1, 0.6, 1.0), SM(0.95, 1.1, 0.6, 1.0),
    SR(-1.55, -1.45, 3.1, 2.9, 0.15),
    lc(-0.95, -2.7, '1', 0.75), lc(0, -2.7, '2', 0.75), lc(0.95, -2.7, '3', 0.75),
    lc(0.95, 2.0, '4', 0.75), lc(0, 2.0, '5', 0.75), lc(-0.95, 2.0, '6', 0.75),
  ], { smd: 6, pitch: 0.95, labels: 6, note: 'площадки 0.6×1.0 мм при шаге 0.95 мм' }),
  E('sc70', 'SC-70-6 (SOT-363)', 'SMD', () => soicLike(6, 0.65, 2.2, 1.0, 0.45, 1.25, '6×0.65'),
    { smd: 6, pitch: 0.65, labels: 2 }),
  E('sot89', 'SOT-89 (мощный)', 'SMD', () => [
    SM(-1.5, -2.1, 1.0, 1.8), SM(0, -2.1, 1.0, 1.8), SM(1.5, -2.1, 1.0, 1.8),
    SM(0, 1.8, 3.0, 2.0),
    SR(-2.25, -1.0, 4.5, 2.0, 0.15),
    lc(-1.5, -4.0, '1', 0.7), lc(0, -4.0, '2', 0.7), lc(1.5, -4.0, '3', 0.7), lc(0, 3.3, '4', 0.7),
  ], { smd: 4, pitch: 1.5, labels: 4, note: '1-3 выводы + таб 4 (общий)' }),
  E('sot223', 'SOT-223 (стабилизатор)', 'SMD', () => [
    SM(-2.3, -3.4, 1.4, 2.0), SM(0, -3.4, 1.4, 2.0), SM(2.3, -3.4, 1.4, 2.0),
    SM(0, 3.6, 3.6, 2.0),
    SR(-1.75, -2.4, 3.5, 4.6, 0.15),
    lc(-2.3, -5.5, '1', 0.8), lc(0, -5.5, '2', 0.8), lc(2.3, -5.5, '3', 0.8), lc(0, 5.1, '4', 0.8),
  ], { smd: 4, pitch: 2.3, labels: 4, note: 'выводы 1-3 + таб 4' }),
  E('dpak', 'DPAK (TO-252)', 'SMD', () => [
    SM(-2.28, -3.9, 1.0, 2.0), SM(2.28, -3.9, 1.0, 2.0), SM(0, 0.4, 5.8, 5.6),
    SR(-3.3, -3.4, 6.6, 6.2, 0.15),
    lc(-2.28, -6.0, 'G', 0.8), lc(2.28, -6.0, 'D', 0.8), lc(0, 4.0, 'D', 0.8),
  ], { smd: 3, pitch: 4.56, labels: 3, note: 'затвор, сток, таб' }),
  E('d2pak', 'D2PAK (TO-263)', 'SMD', () => [
    SM(-2.54, -5.3, 1.2, 2.0), SM(0, -5.3, 1.2, 2.0), SM(2.54, -5.3, 1.2, 2.0),
    SM(0, 0, 8.6, 7.6),
    SR(-5.0, -4.6, 10.0, 8.6, 0.15),
    lc(-2.54, -7.5, '1', 0.85), lc(0, -7.5, '2', 0.85), lc(2.54, -7.5, '3', 0.85),
  ], { smd: 4, pitch: 2.54, labels: 3 }),
  E('soic8', 'SOIC-8', 'SMD', () => soic(8), { smd: 8, pitch: 1.27, labels: 8 }),
  E('soic14', 'SOIC-14', 'SMD', () => soic(14), { smd: 14, pitch: 1.27, labels: 14 }),
  E('soic16', 'SOIC-16', 'SMD', () => soic(16), { smd: 16, pitch: 1.27, labels: 16 }),
  E('soic20w', 'SOIC-20 (широкий, 300 mil)', 'SMD', () => soic(20, 9.4, 1.9),
    { smd: 20, pitch: 1.27, labels: 20 }),
  E('soic28w', 'SOIC-28 (широкий, 300 mil)', 'SMD', () => soic(28, 9.4, 1.9),
    { smd: 28, pitch: 1.27, labels: 28 }),
  E('msop8', 'MSOP-8 (0.65 мм)', 'SMD', () => soicLike(8, 0.65, 4.1, 1.3, 0.45, 3.0, '8×0.65'),
    { smd: 8, pitch: 0.65, labels: 2 }),
  E('tssop8', 'TSSOP-8 (0.65 мм)', 'SMD', () => tssop(8, 0.65, 4.5, 3.0),
    { smd: 8, pitch: 0.65, labels: 2 }),
  E('tssop14', 'TSSOP-14 (0.65 мм)', 'SMD', () => tssop(14, 0.65, 5.4, 4.4),
    { smd: 14, pitch: 0.65, labels: 2 }),
  E('tssop16', 'TSSOP-16 (0.65 мм)', 'SMD', () => tssop(16, 0.65, 5.4, 4.4),
    { smd: 16, pitch: 0.65, labels: 2 }),
  E('tssop20', 'TSSOP-20 (0.65 мм)', 'SMD', () => tssop(20, 0.65, 5.4, 4.4),
    { smd: 20, pitch: 0.65, labels: 2 }),
  E('ssop20', 'SSOP-20 (0.65 мм)', 'SMD', () => tssop(20, 0.65, 7.0, 5.3),
    { smd: 20, pitch: 0.65, labels: 2 }),
  E('ssop28', 'SSOP-28 (0.65 мм)', 'SMD', () => tssop(28, 0.65, 8.0, 5.3),
    { smd: 28, pitch: 0.65, labels: 2 }),
  E('qfn16', 'QFN-16 (3×3, 0.5 мм)', 'SMD', () => qfn(16, 0.5, 3, 4),
    { smd: 17, pitch: 0.5, labels: 5, note: '16 выводов + тепловая площадка' }),
  E('qfn24', 'QFN-24 (4×4, 0.5 мм)', 'SMD', () => qfn(24, 0.5, 4, 4),
    { smd: 25, pitch: 0.5, labels: 7 }),
  E('qfn32', 'QFN-32 (5×5, 0.5 мм)', 'SMD', () => qfn(32, 0.5, 5, 4),
    { smd: 33, pitch: 0.5, labels: 9 }),
  E('lqfp32', 'LQFP-32 (7×7, 0.8 мм)', 'SMD', () => lqfp(32, 0.8, 7),
    { smd: 32, pitch: 0.8, labels: 9 }),
  E('lqfp44', 'LQFP-44 (10×10, 0.8 мм)', 'SMD', () => lqfp(44, 0.8, 10),
    { smd: 44, pitch: 0.8, labels: 11 }),
  E('lqfp48', 'LQFP-48 (7×7, 0.5 мм)', 'SMD', () => lqfp(48, 0.5, 7),
    { smd: 48, pitch: 0.5, labels: 12 }),
  E('lqfp64', 'LQFP-64 (10×10, 0.5 мм)', 'SMD', () => lqfp(64, 0.5, 10),
    { smd: 64, pitch: 0.5, labels: 16 }),
  E('xs3225', 'Кварц SMD 3.2×2.5 (4 вывода)', 'SMD', () => [
    SM(-1.1, -0.85, 1.3, 1.0), SM(1.1, -0.85, 1.3, 1.0),
    SM(-1.1, 0.85, 1.3, 1.0), SM(1.1, 0.85, 1.3, 1.0),
    SR(-1.6, -1.25, 3.2, 2.5, 0.15),
    lc(0, -2.35, '1 3', 0.7), lc(0, 2.1, '2 4', 0.7),
  ], { smd: 4, pitch: 1.7, labels: 2, note: '1-3 и 2-4 — пары выводов кварца' }),
  E('capeSmd', 'Электролит SMD Ø5, шаг 2.0', 'SMD', () => [
    SM(-1.0, 0, 1.6, 2.4), SM(1.0, 0, 1.6, 2.4),
    SC(0, 3.2, 2.5, 0.2),
    SL(-3.2, 3.2, -2.4, 3.2, 0.3), SL(-2.8, 2.8, -2.8, 3.6, 0.3),
  ], { smd: 2, pitch: 2.0, labels: 0, note: '«+» — у пометки рядом с корпусом' }),
  E('tantAsmd', 'Тантал SMD A (3216)', 'SMD', () => [
    SM(-1.4, 0, 1.2, 1.6), SM(1.4, 0, 1.2, 1.6), SR(-1.6, -0.8, 3.2, 1.6, 0.15),
    SL(-1.6, 1.0, -0.9, 1.0, 0.3),
  ], { smd: 2, pitch: 2.8 }),
  E('tantBsmd', 'Тантал SMD B (3528)', 'SMD', () => [
    SM(-1.5, 0, 1.2, 2.1), SM(1.5, 0, 1.2, 2.1), SR(-1.75, -1.4, 3.5, 2.8, 0.15),
    SL(-1.75, 1.6, -1.0, 1.6, 0.3),
  ], { smd: 2, pitch: 3.0 }),
  E('tantCsmd', 'Тантал SMD C (6032)', 'SMD', () => [
    SM(-2.3, 0, 1.6, 2.5), SM(2.3, 0, 1.6, 2.5), SR(-3.0, -1.6, 6.0, 3.2, 0.15),
    SL(-3.0, 1.8, -1.9, 1.8, 0.3),
  ], { smd: 2, pitch: 4.6 }),
  E('tact6smd', 'Кнопка тактовая SMD 6×6', 'SMD', () => [
    SM(-3.35, 0, 1.6, 2.2), SM(3.35, 0, 1.6, 2.2),
    SR(-3, -3, 6, 6, 0.2), SC(0, 0, 1.2, 0.2),
  ], { smd: 2, pitch: 6.7 }),
  E('jumperSmd', 'Перемычка SMD (2 площадки)', 'SMD', () => [
    SM(-0.95, 0, 1.0, 1.3), SM(0.95, 0, 1.0, 1.3), SR(-0.22, -0.65, 0.44, 1.3, 0.15),
  ], { smd: 2, pitch: 1.9, note: 'перерезаемая перемычка под пайку' }),

  // ------------------------------------------------ Транзисторы
  E('to92', 'TO-92 в линию (1.27 мм)', 'Транзисторы', () => to92(1.27, 1.1, 0.7),
    { pins: 3, pitch: 1.27, labels: 3, note: 'площадки Ø1.1/0.7 мм: при шаге 1.27 больше нельзя' }),
  E('to92w', 'TO-92 широкий (2.54 мм)', 'Транзисторы', () => to92(2.54, 1.8, 0.8),
    { pins: 3, pitch: 2.54, labels: 3 }),
  E('to126', 'TO-126 (КТ814/BD135)', 'Транзисторы', () => toPack(8.0, 7.0, 11.0, 3.2, 2.2),
    { pins: 3, pitch: 2.54, labels: 3, holes: 1, note: 'выводы 2.54 мм, отверстие Ø3.2 под винт' }),
  E('to220', 'TO-220 / КРЕН (вертикально)', 'Транзисторы', () => toPack(10.16, 8.0, 11.9, 3.6, 2.2,
    ['1', '2', '3']), { pins: 3, pitch: 2.54, labels: 3, holes: 1,
    note: 'площадки 2.2/1.1 мм, отверстие Ø3.6 мм ≈ 9.9 мм от ряда выводов' }),

  // ------------------------------------------------ Разъёмы
  plsEntry(1), plsEntry(2), plsEntry(3), plsEntry(4), plsEntry(5), plsEntry(6),
  plsEntry(8), plsEntry(10), plsEntry(12), plsEntry(16), plsEntry(20), plsEntry(40),
  E('soc1x4', 'Гнездо 1×4 (мама, 2.54)', 'Разъёмы', () => pls(4, 2.2, 1.2),
    { pins: 4, pitch: 2.54, labels: 4 }),
  E('soc1x8', 'Гнездо 1×8 (мама, 2.54)', 'Разъёмы', () => pls(8, 2.2, 1.2),
    { pins: 8, pitch: 2.54, labels: 8 }),
  E('klem2', 'Клеммник 5.08, 2 конт.', 'Разъёмы', () => klem(2), { pins: 2, pitch: 5.08, labels: 2 }),
  E('klem3', 'Клеммник 5.08, 3 конт.', 'Разъёмы', () => klem(3), { pins: 3, pitch: 5.08, labels: 3 }),
  E('klem4', 'Клеммник 5.08, 4 конт.', 'Разъёмы', () => klem(4), { pins: 4, pitch: 5.08, labels: 4 }),
  E('klem35_2', 'Клеммник 3.5, 2 конт.', 'Разъёмы', () => klem(2, 3.5, 2.2, 1.1),
    { pins: 2, pitch: 3.5, labels: 2 }),
  E('klem35_3', 'Клеммник 3.5, 3 конт.', 'Разъёмы', () => klem(3, 3.5, 2.2, 1.1),
    { pins: 3, pitch: 3.5, labels: 3 }),
  E('klem35_4', 'Клеммник 3.5, 4 конт.', 'Разъёмы', () => klem(4, 3.5, 2.2, 1.1),
    { pins: 4, pitch: 3.5, labels: 4 }),
  E('idc10', 'IDC-10 (2×5)', 'Разъёмы', () => dualHeader(5), { pins: 10, pitch: 2.54, labels: 10 }),
  E('idc16', 'IDC-16 (2×8)', 'Разъёмы', () => dualHeader(8), { pins: 16, pitch: 2.54, labels: 16 }),
  E('idc26', 'IDC-26 (2×13)', 'Разъёмы', () => dualHeader(13), { pins: 26, pitch: 2.54, labels: 26 }),
  E('jstxh2', 'JST-XH 2.5, 2 конт.', 'Разъёмы', () => smallCon(2, 2.5, 1.6, 1.6, 7.4, 6.0),
    { pins: 2, pitch: 2.5, labels: 2 }),
  E('jstxh3', 'JST-XH 2.5, 3 конт.', 'Разъёмы', () => smallCon(3, 2.5, 1.6, 1.6, 10.0, 6.0),
    { pins: 3, pitch: 2.5, labels: 3 }),
  E('jstxh4', 'JST-XH 2.5, 4 конт.', 'Разъёмы', () => smallCon(4, 2.5, 1.6, 1.6, 12.4, 6.0),
    { pins: 4, pitch: 2.5, labels: 4 }),
  E('jstph2', 'JST-PH 2.0, 2 конт.', 'Разъёмы', () => smallCon(2, 2.0, 1.2, 1.3, 6.0, 5.0),
    { pins: 2, pitch: 2.0, labels: 2 }),
  E('jstph3', 'JST-PH 2.0, 3 конт.', 'Разъёмы', () => smallCon(3, 2.0, 1.2, 1.3, 8.0, 5.0),
    { pins: 3, pitch: 2.0, labels: 3 }),
  E('hdrSmd4', 'Штыри SMD 1×4 (2.54)', 'Разъёмы', () => headerSMD(4), { smd: 4, pitch: 2.54, labels: 4 }),
  E('hdrSmd8', 'Штыри SMD 1×8 (2.54)', 'Разъёмы', () => headerSMD(8), { smd: 8, pitch: 2.54, labels: 8 }),
  E('usbMicro', 'Micro-USB (SMD)', 'Разъёмы', () => [
    ...[-1.3, -0.65, 0, 0.65, 1.3].map((x) => SM(x, -2.0, 0.4, 1.4)),
    SM(-3.7, 0.6, 2.0, 1.8), SM(3.7, 0.6, 2.0, 1.8),
    SR(-4.0, -1.6, 8.0, 4.0, 0.2),
    lc(-1.3, -5.4, 'VBUS', 0.65), lc(-0.65, -4.5, 'D-', 0.65), lc(0, -5.4, 'D+', 0.65),
    lc(0.65, -4.5, 'ID', 0.65), lc(1.3, -5.4, 'GND', 0.65),
  ], { smd: 7, pitch: 0.65, labels: 5, note: '5 контактов 0.65 мм + 2 площадки экрана' }),
  E('rj45', 'RJ45 (8P8C, THT)', 'Разъёмы', () => [
    ...Array.from({ length: 8 }, (_, i) => P(-4.445 + i * 1.27, 0, 0.7, 1.1, 'oct')),
    P(-4.45, -3.2, 1.4, 2.6), P(4.45, -3.2, 1.4, 2.6),
    SR(-8.0, -8.5, 16.0, 15.0),
    ...rowLabels(
      Array.from({ length: 8 }, (_, i) => ({ x: -4.445 + i * 1.27, y: 0, t: String(i + 1) })),
      0.8, true,
    ),
  ], { pins: 10, pitch: 1.27, labels: 8, note: '8 контактов 1.27 мм + 2 силовых вывода' }),
  E('db9', 'DB9 (DE-9, гнездо, THT)', 'Разъёмы', () => [
    ...[0, 1, 2, 3, 4].map((i) => P(-5.54 + i * 2.77, 0, 1.0, 2.0, i === 0 ? 'square' : 'round')),
    ...[0, 1, 2, 3].map((i) => P(-4.155 + i * 2.77, -2.84, 1.0, 2.0)),
    { kind: 'hole', x: -12.5, y: -3.5, d: 3.2 }, { kind: 'hole', x: 12.5, y: -3.5, d: 3.2 },
    SR(-15.4, -7.6, 30.8, 12.5),   // корпус DE-9: 30.8×12.6, по центру между рядами
    lc(-5.54, 6.2, '1', 0.8), lc(5.54, 6.2, '5', 0.8),
    lc(-4.155, -9.3, '6', 0.8), lc(4.155, -9.3, '9', 0.8),
  ], { pins: 9, holes: 2, pitch: 2.77, labels: 4,
    note: 'шаг 2.77 мм, междурядье 2.84 мм (нормальная плотность D-sub)' }),
  E('jackDc', 'Разъём питания DC-005 (5.5/2.1)', 'Разъёмы', () => [
    P(0, 0, 1.0, 1.8, 'square'), P(0, -6.0, 1.2, 2.4),
    SR(-4.5, -5.5, 9.0, 11.0),
    lc(0, 1.6, 'центр +', 0.8), lc(0, -8.4, 'корпус -', 0.8),
  ], { pins: 2, pitch: 6.0, labels: 2, note: 'центральный контакт и корпус' }),

  // ------------------------------------------------ Arduino
  E('uno3', 'Arduino Uno R3: разъёмы + отверстия', 'Arduino', unoShield, {
    pins: 32, holes: 4, pitch: 2.54, labels: 32,
    note: 'плата 68.58×53.34 мм, разъёмы шилда и 4 крепёжных отверстия',
  }),
  E('anano', 'Arduino Nano (2×15, 0.6″)', 'Arduino', () => dualRow(
    ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'],
    ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'RX0', 'TX1'],
    15.24, 17.78, 43.18,
  ), { pins: 30, pitch: 2.54, labels: 30, note: 'шаг 2.54 мм, ряды через 15.24 мм (0.6″)' }),
  E('ananoSoc', 'Гнездо 2×15 под Arduino Nano', 'Arduino', () => {
    const els: LibEl[] = [];
    const left: LabelledPt[] = [];
    const right: LabelledPt[] = [];
    for (let i = 0; i < 15; i++) {
      const y = 17.78 - i * 2.54;
      els.push(P(-7.62, y, 1.1, 2.2, i === 0 ? 'square' : 'round'));
      els.push(P(7.62, y, 1.1, 2.2));
      left.push({ x: -7.62, y, t: String(i + 1) });
      right.push({ x: 7.62, y, t: String(30 - i) });
    }
    els.push(...labelsFor(left, 'left', 0.8, 1.1));
    els.push(...labelsFor(right, 'right', 0.8, 1.1));
    els.push(SR(-8.89, -19.05, 17.78, 38.1, 0.2));
    return els;
  }, { pins: 30, pitch: 2.54, labels: 30, note: 'площадки 2.2/1.1 мм под штырьки модуля' }),
  E('apromini', 'Arduino Pro Mini (2×12 + FTDI)', 'Arduino', proMini,
    { pins: 30, pitch: 2.54, labels: 30 }),
  E('amicro', 'Arduino Micro (2×17)', 'Arduino', () => dualRow(
    ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'],
    ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'D1', 'D0', 'RST', 'GND', '5V', 'VIN'],
    15.24, 17.78, 48.26,
  ), { pins: 34, pitch: 2.54, labels: 34, note: 'правая колонка — зеркальный порядок (как на модуле)' }),
  E('apico', 'Raspberry Pi Pico (2×20, 0.1″)', 'Arduino', () => dualRow(
    ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15'],
    ['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 'VREF', 'GP28', 'AGND', 'GP27', 'GP26', 'GP22', 'GND', 'GP21', 'GP20', 'GP19', 'GP18', 'GND', 'GP17', 'GP16', 'GND'],
    22.86, 21.0, 51.0,
  ), { pins: 40, pitch: 2.54, labels: 40, note: 'плата 21×51 мм, ряды через 22.86 мм' }),
  E('argpio40', 'Raspberry Pi 40-pin GPIO (HAT)', 'Arduino', rpi40,
    { pins: 40, pitch: 2.54, labels: 40 }),

  // ------------------------------------------------ ESP32 / ESP8266
  E('esp-devkitc', 'ESP32-DevKitC 38 пин (2×19)', 'ESP32 / ESP8266', () => dualRow(
    ['3V3', 'EN', 'VP', 'VN', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12', 'GND', 'IO13', 'IO9', 'IO10', 'IO11', '5V'],
    ['GND', 'IO23', 'IO22', 'TX0', 'RX0', 'IO21', 'GND', 'IO19', 'IO18', 'IO5', 'IO17', 'IO16', 'IO4', 'IO0', 'IO2', 'IO15', 'IO8', 'IO7', 'IO6'],
    22.86, 25.4, 48.26,
  ), { pins: 38, pitch: 2.54, labels: 38, note: 'ряды через 22.86 мм (0.9″)' }),
  E('esp-dev30', 'ESP32 DevKit V1 30 пин (2×15)', 'ESP32 / ESP8266', () => dualRow(
    ['3V3', 'GND', 'IO15', 'IO2', 'IO4', 'RX2', 'TX2', 'IO5', 'IO18', 'IO19', 'IO21', 'RX0', 'TX0', 'IO22', 'IO23'],
    ['VIN', 'GND', 'IO13', 'IO12', 'IO14', 'IO27', 'IO26', 'IO25', 'IO33', 'IO32', 'IO35', 'IO34', 'VN', 'VP', 'EN'],
    25.4, 28.5, 51.4,
  ), { pins: 30, pitch: 2.54, labels: 30, note: 'ряды через 25.4 мм (1″)' }),
  E('nodemcu', 'NodeMCU V3 30 пин (2×15)', 'ESP32 / ESP8266', () => dualRow(
    ['A0', 'RSV', 'RSV', 'SD3', 'SD2', 'SD1', 'CMD', 'SD0', 'CLK', 'GND', '3V3', 'EN', 'RST', 'GND', 'VIN'],
    ['D0', 'D1', 'D2', 'D3', 'D4', '3V3', 'GND', 'D5', 'D6', 'D7', 'D8', 'RX', 'TX', 'GND', '3V3'],
    22.86, 26.0, 49.0,
  ), { pins: 30, pitch: 2.54, labels: 30 }),
  E('d1mini', 'Wemos D1 mini (2×8)', 'ESP32 / ESP8266', () => dualRow(
    ['RST', 'A0', 'D0', 'D5', 'D6', 'D7', 'D8', '3V3'],
    ['TX', 'RX', 'D1', 'D2', 'D3', 'D4', 'GND', '5V'],
    22.86, 25.6, 34.2,
  ), { pins: 16, pitch: 2.54, labels: 16 }),
  E('esp01', 'ESP-01 (ESP8266, гнездо 2×4)', 'ESP32 / ESP8266', () => {
    const els: LibEl[] = [];
    const topRow: LabelledPt[] = [];
    const botRow: LabelledPt[] = [];
    const names = ['GND', 'IO2', 'IO0', 'RXD'];
    const names2 = ['TXD', 'CHPD', 'RST', 'VCC'];
    names.forEach((t, i) => {
      els.push(P(-3.81 + i * 2.54, -9.4, 0.9, 1.7, i === 0 ? 'square' : 'round'));
      topRow.push({ x: -3.81 + i * 2.54, y: -9.4, t });
    });
    names2.forEach((_, i) => els.push(P(-3.81 + i * 2.54, -11.94, 0.9, 1.7)));
    names2.forEach((t, i) => botRow.push({ x: -3.81 + i * 2.54, y: -11.94, t }));
    els.push(SR(-7.15, -12.4, 14.3, 24.8));
    els.push(...labelsFor(topRow, 'up', 0.75, 0.85));
    els.push(...labelsFor(botRow, 'down', 0.75, 0.85));
    return els;
  }, { pins: 8, pitch: 2.54, labels: 8 }),
  E('esp12f', 'ESP-12F (ESP8266, SMD)', 'ESP32 / ESP8266', () => esp12(
    ['RST', 'ADC', 'CH_PD', 'IO16', 'IO14', 'IO12', 'IO13', 'VCC'],
    ['TX', 'RX', 'IO5', 'IO4', 'IO0', 'IO2', 'IO15', 'GND'],
  ), { smd: 16, pitch: 2.0, labels: 16, note: 'площадки по краям модуля, шаг 2.0 мм' }),
  E('wroom32', 'ESP32-WROOM-32 (SMD, 38 площадок)', 'ESP32 / ESP8266', () => {
    const left = ['GND', '3V3', 'EN', 'VP36', 'VN39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26', 'IO27', 'IO14', 'IO12'];
    const right = ['GND', 'IO13', 'IO9', 'IO10', 'IO11', 'IO6', 'IO7', 'IO8', 'IO15', 'IO2', 'IO0', 'IO4', 'IO5', 'IO16'];
    const els: LibEl[] = [];
    for (let i = 0; i < 14; i++) {
      const y = 8.255 - i * 1.27;
      els.push(SM(-7.9, y, 1.5, 0.9));
      els.push(SM(7.9, -y, 1.5, 0.9));
    }
    for (let i = 0; i < 10; i++) els.push(SM(-5.715 + i * 1.27, -11.6, 0.9, 1.5));
    els.push(SR(-9, -12.75, 18, 25.5, 0.15));
    els.push(SR(-9, 6.5, 18, 6.25, 0.15)); // зона антенны
    els.push(...labelsFor(left.map((t, i) => ({ x: -7.9, y: 8.255 - i * 1.27, t })), 'left', 0.65, 0.75));
    els.push(...labelsFor(right.map((t, i) => ({ x: 7.9, y: -8.255 + i * 1.27, t })), 'right', 0.65, 0.75));
    els.push(lc(0, -14.2, 'нижние 10 площадок: по даташиту', 0.7));
    return els;
  }, { smd: 38, pitch: 1.27, labels: 29,
    note: 'боковые площадки подписаны, зона антенны без меди, нижние 10 — без подписей' }),

  // ------------------------------------------------ Катушки и реле
  E('ind10', 'Катушка индуктивности 10 мм', 'Катушки и реле', () => [
    P(-5, 0, 0.9, 1.8), P(5, 0, 0.9, 1.8), SC(0, 0, 4.0),
    lc(-5, -2.5, '1', 0.8), lc(5, 1.4, '2', 0.8),
  ], { pins: 2, pitch: 10, labels: 2 }),
  E('indSmd', 'Дроссель SMD (CDRH 6×6)', 'Катушки и реле', () => [
    SM(-2.6, 0, 1.6, 2.4), SM(2.6, 0, 1.6, 2.4), SC(0, 0, 3.0, 0.2),
  ], { smd: 2, pitch: 5.2 }),
  E('ferrite', 'Ферритовая бусина (отверстие 3.5)', 'Катушки и реле', () => [
    P(0, 0, 3.5, 6.5), SC(0, 0, 4.0, 0.2),
  ], { pins: 1, note: 'одиночная площадка с отверстием под феррит' }),
  E('relaySrd', 'Реле SRD-05VDC (5 выводов)', 'Катушки и реле', () => [
    P(-10.16, 6.0, 1.1, 2.4, 'square'), P(-10.16, -6.0, 1.1, 2.4),
    P(10.16, -7.62, 1.1, 2.4), P(10.16, 0, 1.1, 2.4), P(10.16, 7.62, 1.1, 2.4),
    SR(-9.5, -9.5, 19.0, 19.0),
    lc(-10.16, 7.5, 'катушка', 0.8), lc(-10.16, -4.5, 'катушка', 0.8),
    lc(11.2, -5.8, 'NO', 0.8), lc(11.2, 1.7, 'COM', 0.8), lc(11.2, 9.4, 'NC', 0.8),
  ], { pins: 5, labels: 5, note: 'выводы катушки слева, контакты справа' }),
  E('relayHk', 'Реле HK4100 (малогабаритное)', 'Катушки и реле', () => [
    P(-5.08, 0, 0.9, 1.8, 'square'), P(5.08, 0, 0.9, 1.8), P(5.08, -5.08, 0.9, 1.8),
    SR(-7.5, -4.0, 15.0, 10.5),
    lc(-5.08, 1.5, 'K1', 0.8), lc(5.08, 1.5, 'K2', 0.8), lc(5.08, -7.2, 'COM', 0.75),
  ], { pins: 3, labels: 3 }),

  // ------------------------------------------------ Прочее
  E('hc49', 'Кварц HC-49S (через 4.88 мм)', 'Прочее', hc49, { pins: 2, pitch: 4.88, labels: 2 }),
  E('res3', 'Керамический резонатор, 3 вывода', 'Прочее', () => [
    P(-2.5, 0, 0.8, 1.6, 'square'), P(0, 0, 0.8, 1.6), P(2.5, 0, 0.8, 1.6),
    SR(-3.75, -1.75, 7.5, 3.5),
    lc(-2.5, -3.0, '1', 0.8), lc(0, 1.0, 'GND', 0.7), lc(2.5, -3.0, '3', 0.8),
  ], { pins: 3, pitch: 2.5, labels: 3 }),
  E('tact6', 'Кнопка тактовая 6×6 (THT)', 'Прочее', () => tact(6.5, 4.5, 6, 6),
    { pins: 4, pitch: 4.5, labels: 4 }),
  E('tact12', 'Кнопка тактовая 12×12 (THT)', 'Прочее', () => tact(5.0, 5.0, 12, 12, 2.0),
    { pins: 4, pitch: 5.0, labels: 4 }),
  E('tact3x6', 'Кнопка 3×6×4.3 (2 вывода)', 'Прочее', () => [
    P(-2.25, 0, 0.7, 1.4, 'square'), P(2.25, 0, 0.7, 1.4),
    SR(-3.0, -1.5, 6.0, 3.0),
    lc(-2.25, -2.6, '1', 0.75), lc(2.25, -2.6, '2', 0.75),
  ], { pins: 2, pitch: 4.5, labels: 2 }),
  E('dipsw4', 'DIP-переключатель 4 секции', 'Прочее', () => dipSw(4),
    { pins: 8, pitch: 2.54, labels: 12 }),
  E('dipsw8', 'DIP-переключатель 8 секций', 'Прочее', () => dipSw(8),
    { pins: 16, pitch: 2.54, labels: 24 }),
  E('pot3296', 'Подстроечник 3296W (многооборотный)', 'Прочее', () => [
    P(-2.54, 0, 0.9, 1.8, 'square'), P(0, 0, 0.9, 1.8), P(2.54, 0, 0.9, 1.8),
    SR(-5.0, 1.4, 10.0, 7.0),
    lc(-2.54, -2.4, '1', 0.75), lc(0, -2.4, '2 движок', 0.7), lc(2.54, -2.4, '3', 0.75),
  ], { pins: 3, pitch: 2.54, labels: 3 }),
  E('buzz12', 'Пьезоизлучатель 12 мм (шаг 7.6)', 'Прочее', () => [
    P(-3.8, 0, 0.9, 1.8, 'square'), P(3.8, 0, 0.9, 1.8), SC(0, 0, 6.0),
    lc(-3.8, -2.6, '+', 1.0), lc(3.8, 1.3, '-', 1.0),
  ], { pins: 2, pitch: 7.6, labels: 2 }),
  E('fuseSmd', 'Предохранитель SMD 1206', 'Прочее', () => smdRC(3.0, 1.2, 1.8, 3.2, 1.6),
    { smd: 2, pitch: 3.0 }),
  E('batt18650', 'Держатель 18650 (2 вывода)', 'Прочее', () => [
    P(-45.0, 0, 1.5, 3.0, 'square'), P(-36.0, 0, 1.5, 3.0),
    SR(-45.5, -10.5, 91.0, 21.0),
    lc(-45.0, -12.6, '-', 1.2), lc(-36.0, 12.0, '+', 1.2),
  ], { pins: 2, pitch: 9.0, labels: 2, note: 'габарит под элемент 65×18.5 мм' }),
  E('battCr2032', 'Держатель CR2032 (2 вывода)', 'Прочее', () => [
    P(-11.0, 0, 1.1, 2.4), P(11.0, 0, 1.1, 2.4), SC(0, 0, 10.0),
    lc(-11.0, -3.0, '+', 1.0), lc(11.0, 1.6, '-', 1.0),
  ], { pins: 2, pitch: 22.0, labels: 2 }),
  E('tp', 'Контрольная точка (THT)', 'Прочее', () => [P(0, 0, 0.9, 1.8)], { pins: 1 }),
  E('tpSmd', 'Контрольная точка (SMD)', 'Прочее', () => [
    SM(0, 0, 1.6, 1.6), SC(0, 0, 1.0, 0.15),
  ], { smd: 1 }),

  // ------------------------------------------------ Крепёж и площадки
  E('mh3', 'Отверстие M3 (неметаллизированное)', 'Крепёж и площадки', () => [
    { kind: 'hole', x: 0, y: 0, d: 3.2 },
  ], { holes: 1, note: 'Ø3.2 мм под винт M3' }),
  E('mh32', 'Монтажное отверстие 3.2 + площадка', 'Крепёж и площадки', () => [
    P(0, 0, 3.2, 6.0),
  ], { pins: 1, note: 'площадка 6.0 мм, сверло 3.2 мм' }),
  E('mh2', 'Отверстие M2 (2.2 мм)', 'Крепёж и площадки', () => [{ kind: 'hole', x: 0, y: 0, d: 2.2 }],
    { holes: 1 }),
  E('mh25', 'Отверстие M2.5 (2.7 мм)', 'Крепёж и площадки', () => [{ kind: 'hole', x: 0, y: 0, d: 2.7 }],
    { holes: 1 }),
  E('mh4', 'Отверстие M4 (4.3 мм)', 'Крепёж и площадки', () => [{ kind: 'hole', x: 0, y: 0, d: 4.3 }],
    { holes: 1 }),
  E('mhSt', 'Стойка M3: площадка + отверстие', 'Крепёж и площадки', () => [
    P(0, 0, 3.2, 6.5, 'oct'), SC(0, 0, 3.9, 0.2),
  ], { pins: 1, note: 'металлизированное отверстие под стойку' }),
  E('fiducial', 'Метка совмещения Ø1 мм', 'Крепёж и площадки', () => [
    P(0, 0, 0, 1.0), SC(0, 0, 1.6, 0.15),
  ], { pins: 1, note: 'площадка без отверстия + поясок шелкографии' }),
  E('fiducial3', 'Метка совмещения Ø3 мм', 'Крепёж и площадки', () => [
    P(0, 0, 0, 3.0), SC(0, 0, 4.0, 0.2),
  ], { pins: 1 }),
];

/** Макросы в порядке каталога (для панели библиотеки и тестов). */
export const LIB_LIST: ReadonlyArray<LibEntry> = LIST.map(([, e]) => e);

/** Ключ → макрос. */
export const LIB: Record<string, LibEntry> = {};
for (const [k, e] of LIST) LIB[k] = e;

/** Ключи, объявленные в каталоге дважды (в норме — пусто, проверяется тестом). */
export const LIB_DUPS: string[] = LIST.map(([k]) => k).filter((k, i, a) => a.indexOf(k) !== i);
