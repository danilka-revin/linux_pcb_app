// Библиотека компонентов (макросов) в стиле Sprint-Layout.
// Все элементы заданы в локальных координатах (мм), начало — точка установки.

import type { PadShape } from './model';

export type LibEl =
  | { kind: 'pad'; x: number; y: number; shape: PadShape; size: number; drill: number }
  | { kind: 'smd'; x: number; y: number; w: number; h: number; rot: number; layer: 'k1' | 'k2' }
  | { kind: 'hole'; x: number; y: number; d: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; layer: 's1' | 's2' }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; th: number; layer: 's1' | 's2' }
  | { kind: 'circle'; x: number; y: number; r: number; w: number; layer: 's1' | 's2' };

export interface LibEntry {
  key: string;
  name: string;
  cat: string;
  build: () => LibEl[];
}

// --- строительные помощники ---
const P = (x: number, y: number, drill = 0.9, size = 1.8, shape: PadShape = 'round'): LibEl =>
  ({ kind: 'pad', x, y, drill, size, shape });
const SL = (x1: number, y1: number, x2: number, y2: number, w = 0.25, layer: 's1' | 's2' = 's1'): LibEl =>
  ({ kind: 'line', x1, y1, x2, y2, w, layer });
const SR = (x: number, y: number, w: number, h: number, th = 0.25, layer: 's1' | 's2' = 's1'): LibEl =>
  ({ kind: 'rect', x, y, w, h, th, layer });
const SC = (x: number, y: number, r: number, w = 0.25, layer: 's1' | 's2' = 's1'): LibEl =>
  ({ kind: 'circle', x, y, r, w, layer });
const SM = (x: number, y: number, w: number, h: number, layer: 'k1' | 'k2' = 'k1'): LibEl =>
  ({ kind: 'smd', x, y, w, h, rot: 0, layer });

// --- построители корпусов ---

/** DIP-корпус: n выводов, междурядье rowW */
function dip(n: number, rowW: number): LibEl[] {
  const half = n / 2;
  const els: LibEl[] = [];
  for (let i = 0; i < half; i++) {
    els.push(P(-rowW / 2, i * 2.54, 0.8, 1.75, i === 0 ? 'square' : 'round'));
    els.push(P(rowW / 2, (half - 1 - i) * 2.54, 0.8, 1.75));
  }
  const bw = rowW - 1.0;
  const bh = (half - 1) * 2.54 + 2.54;
  els.push(SR(-bw / 2, -1.27, bw, bh));
  els.push(SC(0, -1.27 + bh, 0.8)); // ключ у первого вывода
  return els;
}

/** Выводной резистор: расстояние между площадками dx, корпус bodyL×bodyW */
function resistor(dx: number, bodyL: number, bodyW: number): LibEl[] {
  return [
    P(-dx / 2, 0), P(dx / 2, 0),
    SR(-bodyL / 2, -bodyW / 2, bodyL, bodyW),
    SL(-dx / 2, 0, -bodyL / 2, 0, 0.3),
    SL(bodyL / 2, 0, dx / 2, 0, 0.3),
  ];
}

/** Диод: полоска катода справа */
function diode(dx: number, bw: number, bh: number): LibEl[] {
  return [
    P(-dx / 2, 0, 0.8), P(dx / 2, 0, 0.8, 1.8, 'square'),
    SR(-bw / 2, -bh / 2, bw, bh),
    SL(bw / 2 - 1.0, -bh / 2, bw / 2 - 1.0, bh / 2, 0.55),
    SL(-dx / 2, 0, -bw / 2, 0, 0.3),
    SL(bw / 2, 0, dx / 2, 0, 0.3),
  ];
}

/** Дисковый/керамический конденсатор */
function capCer(r: number, pitch: number): LibEl[] {
  return [
    P(-pitch / 2, 0, 0.8), P(pitch / 2, 0, 0.8),
    SC(0, 0, r),
    SL(-pitch / 2, 0, -r * 0.55, 0, 0.3),
    SL(r * 0.55, 0, pitch / 2, 0, 0.3),
  ];
}

/** Электролит: круг + знак «плюс» у первого вывода */
function capElec(d: number, pitch: number): LibEl[] {
  return [
    P(-pitch / 2, 0, 0.8), P(pitch / 2, 0, 0.8, 1.8, 'square'),
    SC(0, 0, d / 2),
    SL(-d / 2 - 2.0, 0, -d / 2 - 1.0, 0),
    SL(-d / 2 - 1.5, -0.5, -d / 2 - 1.5, 0.5),
  ];
}

/** Светодиод: скос у катода (справа) */
function led(d: number): LibEl[] {
  return [
    P(-1.27, 0, 0.9, 1.9), P(1.27, 0, 0.9, 1.9, 'square'),
    SC(0, 0, d / 2),
    SL(d / 2 - d * 0.25, -d / 2 + d * 0.25, d / 2 - d * 0.25, d / 2 - d * 0.25 + 0.001, 0.5),
    SL(-0.5, 0, -1.27, 0, 0.3),
    SL(0.5, 0, 1.27, 0, 0.3),
  ];
}

/** ТО-92: треугольник выводов на окружности, плоская грань сверху */
function to92(): LibEl[] {
  const R = 0.734;
  const pt = (deg: number) => ({ x: R * Math.cos((deg * Math.PI) / 180), y: R * Math.sin((deg * Math.PI) / 180) });
  const p1 = pt(90), p2 = pt(210), p3 = pt(330);
  return [
    P(p1.x, p1.y, 0.8), P(p2.x, p2.y, 0.8), P(p3.x, p3.y, 0.8),
    SC(0, 0.05, 1.85),
    SL(-1.42, 1.32, 1.42, 1.32),
  ];
}

/** ТО-220: 3 вывода с шагом 2.54 + контур корпуса */
function to220(): LibEl[] {
  return [
    P(-2.54, 0, 1.0, 2.0), P(0, 0, 1.0, 2.0), P(2.54, 0, 1.0, 2.0),
    SR(-5.1, -1.5, 10.2, 4.6),
    SL(-5.1, 3.1, 5.1, 3.1, 0.5),
  ];
}

/** Штыревая линейка PLS, шаг 2.54 */
function pls(n: number): LibEl[] {
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++)
    els.push(P(i * 2.54 - ((n - 1) * 2.54) / 2, 0, 0.9, 1.7, i === 0 ? 'square' : 'round'));
  const w = n * 2.54;
  els.push(SR(-w / 2, -1.27, w, 2.54));
  return els;
}

/** Винтовой клеммник, шаг 5.08 */
function klem(n: number): LibEl[] {
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++)
    els.push(P(i * 5.08 - ((n - 1) * 5.08) / 2, 0, 1.3, 2.6));
  const w = n * 5.08;
  els.push(SR(-w / 2 + 0.4, -3.0, w - 0.8, 7.0));
  return els;
}

/** Кварц HC-49 */
function hc49(): LibEl[] {
  return [
    P(-2.44, 0, 0.9, 2.0), P(2.44, 0, 0.9, 2.0),
    SR(-5.55, -2.25, 11.1, 4.5),
  ];
}

/** SMD двухвыводный (резистор/конденсатор) */
function smdRC(pitch: number, pw: number, ph: number, bw: number, bh: number): LibEl[] {
  return [
    SM(-pitch / 2, 0, pw, ph), SM(pitch / 2, 0, pw, ph),
    SR(-bw / 2, -bh / 2, bw, bh, 0.15),
  ];
}

/** SOIC: n выводов, шаг 1.27, междурядье 5.4 по центрам площадок */
function soic(n: number): LibEl[] {
  const half = n / 2;
  const els: LibEl[] = [];
  const ry = (half - 1) * 1.27;
  for (let i = 0; i < half; i++) {
    els.push(SM(-2.7, i * 1.27 - ry / 2, 2.0, 0.6));
    els.push(SM(2.7, ry / 2 - i * 1.27, 2.0, 0.6));
  }
  els.push(SR(-1.95, -(ry + 2.2) / 2, 3.9, ry + 2.2, 0.2));
  els.push(SC(-2.7 - 1.0, ry / 2 + 1.5, 0.35, 0.2));
  return els;
}

/** SOT-23 */
function sot23(): LibEl[] {
  return [
    SM(-1.1, 0.95, 1.0, 0.9), SM(-1.1, -0.95, 1.0, 0.9), SM(1.1, 0, 1.0, 0.9),
    SR(-0.8, -1.45, 1.6, 2.9, 0.15),
  ];
}

/** Тактовая кнопка 6×6 */
function tact(): LibEl[] {
  return [
    P(-3.25, 2.25, 0.7, 1.4), P(3.25, 2.25, 0.7, 1.4),
    P(-3.25, -2.25, 0.7, 1.4), P(3.25, -2.25, 0.7, 1.4),
    SR(-3, -3, 6, 6),
    SC(0, 0, 1.0, 0.2),
  ];
}

/** Штыревая линейка: n выводов от (x0,y0) с шагом (dx,dy); первый вывод квадратный */
function pinRun(x0: number, y0: number, n: number, dx = 0, dy = -2.54, drill = 1.0, size = 1.9): LibEl[] {
  const els: LibEl[] = [];
  for (let i = 0; i < n; i++)
    els.push(P(x0 + dx * i, y0 + dy * i, drill, size, i === 0 ? 'square' : 'round'));
  return els;
}

/**
 * Модуль на двух штыревых рядах (Nano, DevKit, NodeMCU…):
 * n выводов в ряду, расстояние между рядами rowSpan, контур bw×bh.
 */
function dualRow(n: number, rowSpan: number, bw: number, bh: number): LibEl[] {
  const y0 = ((n - 1) * 2.54) / 2;
  const right = pinRun(rowSpan / 2, y0, n, 0, -2.54).map((e) =>
    e.kind === 'pad' ? { ...e, shape: 'round' as PadShape } : e);
  return [...pinRun(-rowSpan / 2, y0, n, 0, -2.54), ...right, SR(-bw / 2, -bh / 2, bw, bh)];
}

/**
 * Arduino Uno R3 (разъёмы шилда + 4 крепёжных отверстия).
 * Разводка разъёмов — как в эталонных файлах Arduino (ось Y вверх, USB слева):
 * верхний ряд 10+8 с зазором 0.16″ между блоками, нижний 8+6, ряды через 1.9″.
 */
function unoShield(): LibEl[] {
  const x = (v: number) => v - 34.29; // относительно центра платы 68.58×53.34
  const y = (v: number) => v - 26.67;
  return [
    // верхний ряд: SCL,SDA,AREF,GND,D13..D8 | D7..D0
    ...pinRun(x(18.796), y(50.8), 10, 2.54, 0),
    ...pinRun(x(45.72), y(50.8), 8, 2.54, 0),
    // нижний ряд: NC,IOREF,RESET,3V3,5V,GND,GND,VIN | A0..A5
    ...pinRun(x(30.48), y(2.54), 8, 2.54, 0),
    ...pinRun(x(53.34), y(2.54), 6, 2.54, 0),
    // крепёжные отверстия
    { kind: 'hole', x: x(13.97), y: y(2.54), d: 3.2 },
    { kind: 'hole', x: x(15.24), y: y(50.8), d: 3.2 },
    { kind: 'hole', x: x(66.04), y: y(7.62), d: 3.2 },
    { kind: 'hole', x: x(66.04), y: y(35.56), d: 3.2 },
    SR(x(0), y(0), 68.58, 53.34),
  ];
}

/** Arduino Pro Mini: два ряда по 12 + разъём FTDI 1×6 в торце */
function proMini(): LibEl[] {
  return [
    ...pinRun(-7.62, 13.97, 12, 0, -2.54),
    ...pinRun(7.62, 13.97, 12, 0, -2.54, 0.8, 1.7).map((e) =>
      e.kind === 'pad' ? { ...e, shape: 'round' as PadShape } : e),
    ...pinRun(-6.35, 15.24, 6, 2.54, 0, 0.8, 1.7),
    SR(-8.89, -16.51, 17.78, 33.02),
  ];
}

/** ESP-01 (ESP8266): гнездо 2×4 с шагом 2.54 в торце модуля 14.3×24.8 */
function esp01(): LibEl[] {
  const els: LibEl[] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 4; c++)
      els.push(P(-3.81 + c * 2.54, -9.4 + r * 2.54, 0.9, 1.7, r + c === 0 ? 'square' : 'round'));
  els.push(SR(-7.15, -12.4, 14.3, 24.8));
  return els;
}

/**
 * ESP32-WROOM-32 (модуль, SMD, упрощённо): 2×14 боковых + 10 нижних площадок
 * (шаг 1.27, зазомбленные по краю корпуса 18×25.5) + зона антенны сверху.
 */
function wroom32(): LibEl[] {
  const els: LibEl[] = [];
  for (let i = 0; i < 14; i++) {
    const yy = 8.255 - i * 1.27;
    els.push(SM(-7.9, yy, 1.5, 0.9), SM(7.9, yy, 1.5, 0.9));
  }
  for (let i = 0; i < 10; i++) els.push(SM(-5.715 + i * 1.27, -11.6, 0.9, 1.5));
  els.push(SR(-9, -12.75, 18, 25.5, 0.15));
  els.push(SR(-9, 6.5, 18, 6.25, 0.15)); // зона антенны (без меди)
  return els;
}

// --- сам каталог ---
export const CATS = [
  'Резисторы и диоды',
  'Конденсаторы',
  'Микросхемы (DIP)',
  'SMD',
  'Транзисторы',
  'Разъёмы',
  'Arduino',
  'ESP32 / ESP8266',
  'Прочее',
];

const E = (key: string, name: string, cat: string, build: () => LibEl[]): [string, LibEntry] => [
  key, { key, name, cat, build },
];

export const LIB: Record<string, LibEntry> = Object.fromEntries([
  // Резисторы и диоды
  E('r0125', 'Резистор 0.125 Вт', 'Резисторы и диоды', () => resistor(7.62, 3.6, 1.8)),
  E('r025', 'Резистор 0.25 Вт', 'Резисторы и диоды', () => resistor(10.16, 6.5, 2.3)),
  E('r05', 'Резистор 0.5 Вт', 'Резисторы и диоды', () => resistor(12.7, 9.0, 3.2)),
  E('r1', 'Резистор 1 Вт', 'Резисторы и диоды', () => resistor(15.24, 11.0, 3.5)),
  E('do41', 'Диод DO-41', 'Резисторы и диоды', () => diode(10.16, 5.2, 2.3)),
  E('led3', 'Светодиод 3 мм', 'Резисторы и диоды', () => led(3)),
  E('led5', 'Светодиод 5 мм', 'Резисторы и диоды', () => led(5)),

  // Конденсаторы
  E('capc254', 'Керамический, шаг 2.54', 'Конденсаторы', () => capCer(1.9, 2.54)),
  E('capc5', 'Керамический, шаг 5.08', 'Конденсаторы', () => capCer(2.6, 5.08)),
  E('cape5', 'Электролит Ø5, шаг 2.54', 'Конденсаторы', () => capElec(5, 2.54)),
  E('cape8', 'Электролит Ø8, шаг 3.5', 'Конденсаторы', () => capElec(8, 3.5)),
  E('cape10', 'Электролит Ø10, шаг 5', 'Конденсаторы', () => capElec(10, 5.08)),

  // DIP
  E('dip4', 'DIP-4 (оптрон)', 'Микросхемы (DIP)', () => dip(4, 7.62)),
  E('dip8', 'DIP-8', 'Микросхемы (DIP)', () => dip(8, 7.62)),
  E('dip14', 'DIP-14', 'Микросхемы (DIP)', () => dip(14, 7.62)),
  E('dip16', 'DIP-16', 'Микросхемы (DIP)', () => dip(16, 7.62)),
  E('dip20', 'DIP-20', 'Микросхемы (DIP)', () => dip(20, 7.62)),
  E('dip28', 'DIP-28 (узкий/шир.)', 'Микросхемы (DIP)', () => dip(28, 15.24)),
  E('dip40', 'DIP-40', 'Микросхемы (DIP)', () => dip(40, 15.24)),

  // SMD
  E('r0805', 'Резистор/конд. 0805', 'SMD', () => smdRC(1.9, 1.0, 1.3, 2.2, 1.3)),
  E('r1206', 'Резистор/конд. 1206', 'SMD', () => smdRC(3.1, 1.0, 1.6, 3.4, 1.6)),
  E('sot23', 'SOT-23', 'SMD', sot23),
  E('soic8', 'SOIC-8', 'SMD', () => soic(8)),
  E('soic14', 'SOIC-14', 'SMD', () => soic(14)),
  E('soic16', 'SOIC-16', 'SMD', () => soic(16)),

  // Транзисторы
  E('to92', 'TO-92 (КТ3102/BC547)', 'Транзисторы', to92),
  E('to220', 'TO-220 (7805/КРЕН)', 'Транзисторы', to220),

  // Разъёмы
  E('pls2', 'Штыри PLS-2 (джампер)', 'Разъёмы', () => pls(2)),
  E('pls3', 'Штыри PLS-3', 'Разъёмы', () => pls(3)),
  E('pls4', 'Штыри PLS-4', 'Разъёмы', () => pls(4)),
  E('pls5', 'Штыри PLS-5', 'Разъёмы', () => pls(5)),
  E('pls6', 'Штыри PLS-6', 'Разъёмы', () => pls(6)),
  E('pls8', 'Штыри PLS-8', 'Разъёмы', () => pls(8)),
  E('pls10', 'Штыри PLS-10', 'Разъёмы', () => pls(10)),
  E('pls16', 'Штыри PLS-16', 'Разъёмы', () => pls(16)),
  E('pls20', 'Штыри PLS-20', 'Разъёмы', () => pls(20)),
  E('pls40', 'Штыри PLS-40', 'Разъёмы', () => pls(40)),
  E('klem2', 'Клеммник 5.08, 2 конт.', 'Разъёмы', () => klem(2)),
  E('klem3', 'Клеммник 5.08, 3 конт.', 'Разъёмы', () => klem(3)),

  // Arduino
  E('uno3', 'Arduino Uno R3: разъёмы + отверстия', 'Arduino', unoShield),
  E('anano', 'Arduino Nano (2×15, 0.6″)', 'Arduino', () => dualRow(15, 15.24, 17.78, 43.18)),
  E('apromini', 'Arduino Pro Mini (2×12 + FTDI)', 'Arduino', proMini),
  E('amicro', 'Arduino Micro (2×17, 0.6″)', 'Arduino', () => dualRow(17, 15.24, 17.78, 48.26)),

  // ESP32 / ESP8266
  E('esp-devkitc', 'ESP32-DevKitC 38 пин (2×19, 0.9″)', 'ESP32 / ESP8266', () => dualRow(19, 22.86, 25.4, 48.26)),
  E('esp-dev30', 'ESP32 DevKit V1 30 пин (2×15, 1″)', 'ESP32 / ESP8266', () => dualRow(15, 25.4, 28.5, 51.4)),
  E('nodemcu', 'NodeMCU 30 пин (2×15, 0.9″)', 'ESP32 / ESP8266', () => dualRow(15, 22.86, 26.0, 49.0)),
  E('d1mini', 'Wemos D1 mini / ESP32 mini (2×8)', 'ESP32 / ESP8266', () => dualRow(8, 22.86, 25.6, 34.2)),
  E('esp01', 'ESP-01 (ESP8266, гнездо 2×4)', 'ESP32 / ESP8266', esp01),
  E('wroom32', 'ESP32-WROOM-32 (модуль, SMD)', 'ESP32 / ESP8266', wroom32),

  // Прочее
  E('hc49', 'Кварц HC-49', 'Прочее', hc49),
  E('tact', 'Кнопка тактовая 6×6', 'Прочее', tact),
  E('tp', 'Контрольная точка', 'Прочее', () => [P(0, 0, 0.9, 1.6)]),
  E('mh32', 'Монтажн. отв. 3.2 + площадка', 'Прочее', () => [P(0, 0, 3.2, 6.0)]),
  E('mh3', 'Отверстие 3 мм (без металл.)', 'Прочее', () => [{ kind: 'hole', x: 0, y: 0, d: 3.0 }]),
]);
