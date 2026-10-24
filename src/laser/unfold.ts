// Параметрический генератор развёрток и технических деталей для лазерного станка.
// Генерирует контуры резки (cut), внутренние вырезы (inner), линии сгиба/биговки (fold),
// разметку (score) и размерные линии (guide).

import {
  luid,
  type LaserGroup,
  type LaserShape,
  type PathNode,
  type Pt,
} from './model';

export type UnfoldTemplateId =
  | 'folded-box'
  | 'finger-box'
  | 'bent-case'
  | 'cylinder-cone'
  | 'front-panel'
  | 'living-hinge'
  | 'gear';

export interface UnfoldParams {
  template: UnfoldTemplateId;
  /** Длина X (мм) */
  length: number;
  /** Ширина Y (мм) */
  width: number;
  /** Высота Z (мм) */
  height: number;
  /** Толщина листового материала (мм) */
  thickness: number;
  /** Ширина шипа (для шиповой коробки) или клапана склейки (мм) */
  fingerWidth: number;
  /** Зазор/компенсация плотной посадки (мм) */
  clearance: number;
  /** Открытый верх (без крышки) */
  openTop: boolean;
  /** Крепёжные отверстия под печатную плату */
  pcbMount: boolean;
  /** Размер платы по отверстиям X (мм) */
  pcbHoleDistX: number;
  /** Размер платы по отверстиям Y (мм) */
  pcbHoleDistY: number;
  /** Диаметр крепёжных отверстий (мм) */
  holeD: number;
  /** Для цилиндра/конуса: верхний диаметр (мм) */
  topDiameter: number;
  /** Для лицевой панели: ширина и высота окна экрана (мм) */
  displayW: number;
  displayH: number;
  /** Число отверстий под кнопки/энкодеры */
  controlsCount: number;
  /** Надпись для гравировки */
  titleText: string;
  /** Для шестерни: модуль (мм) и число зубьев */
  gearModule: number;
  gearTeeth: number;
}

export const DEFAULT_UNFOLD_PARAMS: UnfoldParams = {
  template: 'folded-box',
  length: 90,
  width: 65,
  height: 35,
  thickness: 3.0,
  fingerWidth: 12,
  clearance: 0.0,
  openTop: false,
  pcbMount: true,
  pcbHoleDistX: 72,
  pcbHoleDistY: 52,
  holeD: 3.2,
  topDiameter: 50,
  displayW: 48,
  displayH: 24,
  controlsCount: 3,
  titleText: 'PSBEES CTRL UNIT',
  gearModule: 2.0,
  gearTeeth: 24,
};

export interface UnfoldTemplateMeta {
  id: UnfoldTemplateId;
  name: string;
  subtitle: string;
  badge: string;
}

export const UNFOLD_TEMPLATES: UnfoldTemplateMeta[] = [
  {
    id: 'folded-box',
    name: 'Складная развёртка коробки',
    subtitle: 'Единый раскрой с линиями биговки/сгиба, клапанами и откидной крышкой',
    badge: 'Развёртка + Сгиб',
  },
  {
    id: 'finger-box',
    name: 'Корпус на шипах (Фанера / Акрил)',
    subtitle: 'Все 6 стенок с расчётом шип-паз под толщину материала и стойками под плату',
    badge: 'Шип-паз ЧПУ',
  },
  {
    id: 'bent-case',
    name: 'П-образное шасси прибора',
    subtitle: 'Листовая развёртка корпуса под печатную плату с вентиляцией и линиями гиба',
    badge: 'Корпус платы',
  },
  {
    id: 'cylinder-cone',
    name: 'Развёртка цилиндра / конуса',
    subtitle: 'Точный геометрический раскрой боковой поверхности, клапана шва и донышек',
    badge: 'Геометрия',
  },
  {
    id: 'front-panel',
    name: 'Лицевая панель прибора',
    subtitle: 'Панель с окном дисплея, отверстиями энкодеров, шкалами и гравировкой',
    badge: 'Приборостроение',
  },
  {
    id: 'living-hinge',
    name: 'Гибкий рез (Живой шарнир)',
    subtitle: 'Паттерн прорезей для плавного изгиба фанеры или акрила на 90°–180°',
    badge: 'Гибкая фанера',
  },
  {
    id: 'gear',
    name: 'Зубчатое колесо (Шестерня)',
    subtitle: 'Эвольвентный профиль зуба по модулю m и числу зубьев Z с окнами облегчения',
    badge: 'Механика',
  },
];

function ptNodes(pts: Pt[]): PathNode[] {
  return pts.map((p) => ({ x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) }));
}

function makeFoldLine(x1: number, y1: number, x2: number, y2: number, name: string, groupId?: string): LaserShape {
  return {
    id: luid('fold'),
    kind: 'path',
    layer: 'fold',
    name,
    groupId,
    closed: false,
    filled: false,
    nodes: ptNodes([{ x: x1, y: y1 }, { x: x2, y: y2 }]),
  };
}

/**
 * 1. Складная развёртка коробки из одного листа (с линиями сгиба/биговки и клапанами).
 */
function buildFoldedBox(p: UnfoldParams, ox = 15, oy = 15): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const L = Math.max(15, p.length);
  const W = Math.max(15, p.width);
  const H = Math.max(10, p.height);
  const flap = Math.max(6, Math.min(25, p.fingerWidth));
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `Развёртка коробки ${L}×${W}×${H}` }];
  const shapes: LaserShape[] = [];

  // Раскладка по горизонтали: [Левая стенка H] [Дно L] [Правая стенка H]
  // По вертикали: [Нижняя стенка H] [Дно W] [Верхняя стенка H] [Крышка W (если !openTop)] [Язычок крышки flap]
  const x0 = ox + flap;
  const x1 = x0 + H;
  const x2 = x1 + L;
  const x3 = x2 + H;

  const y0 = oy + flap;
  const y1 = y0 + H;
  const y2 = y1 + W;
  const y3 = y2 + H;
  const y4 = p.openTop ? y3 : y3 + W;
  const y5 = p.openTop ? y3 : y4 + flap;

  const bevel = Math.min(5, flap * 0.45);

  // Внешний единый контур развёртки (против часовой стрелки)
  const outline: Pt[] = [
    // Нижний торец центральной колонки
    { x: x1, y: y0 },
    { x: x2, y: y0 },
    // Правый нижний клапан склейки
    { x: x2 + flap, y: y0 + bevel },
    { x: x2 + flap, y: y1 - bevel },
    { x: x2, y: y1 },
    // Правое крыло (правая стенка)
    { x: x3, y: y1 },
    { x: x3, y: y2 },
    { x: x2, y: y2 },
    // Правый верхний клапан склейки
    { x: x2 + flap, y: y2 + bevel },
    { x: x2 + flap, y: y3 - bevel },
    { x: x2, y: y3 },
  ];

  if (!p.openTop) {
    // Боковые пыльники крышки + сама крышка + замковый язычок
    outline.push(
      { x: x2 + flap, y: y3 + bevel },
      { x: x2 + flap, y: y4 - bevel },
      { x: x2, y: y4 },
      { x: x2 - bevel, y: y5 },
      { x: x1 + bevel, y: y5 },
      { x: x1, y: y4 },
      { x: x1 - flap, y: y4 - bevel },
      { x: x1 - flap, y: y3 + bevel },
      { x: x1, y: y3 }
    );
  } else {
    outline.push({ x: x1, y: y3 });
  }

  // Левая сторона сверху вниз
  outline.push(
    { x: x1 - flap, y: y3 - bevel },
    { x: x1 - flap, y: y2 + bevel },
    { x: x1, y: y2 },
    { x: x0, y: y2 },
    { x: x0, y: y1 },
    { x: x1, y: y1 },
    { x: x1 - flap, y: y1 - bevel },
    { x: x1 - flap, y: y0 + bevel }
  );

  shapes.push({
    id: luid('cut'),
    kind: 'path',
    layer: 'cut',
    name: 'Внешний контур развёртки',
    groupId: grpId,
    closed: true,
    filled: false,
    nodes: ptNodes(outline),
  });

  // Линии сгиба (биговки) вокруг дна
  shapes.push(
    makeFoldLine(x1, y1, x2, y1, 'Сгиб передней стенки', grpId),
    makeFoldLine(x1, y2, x2, y2, 'Сгиб задней стенки', grpId),
    makeFoldLine(x1, y1, x1, y2, 'Сгиб левой стенки', grpId),
    makeFoldLine(x2, y1, x2, y2, 'Сгиб правой стенки', grpId),
    // Сгибы угловых клапанов
    makeFoldLine(x1, y0, x1, y1, 'Сгиб клапана ПЛ', grpId),
    makeFoldLine(x2, y0, x2, y1, 'Сгиб клапана ПП', grpId),
    makeFoldLine(x1, y2, x1, y3, 'Сгиб клапана ЗЛ', grpId),
    makeFoldLine(x2, y2, x2, y3, 'Сгиб клапана ЗП', grpId)
  );

  if (!p.openTop) {
    shapes.push(
      makeFoldLine(x1, y3, x2, y3, 'Сгиб крышки', grpId),
      makeFoldLine(x1, y4, x2, y4, 'Сгиб язычка крышки', grpId),
      makeFoldLine(x1, y3, x1, y4, 'Сгиб левого клапана крышки', grpId),
      makeFoldLine(x2, y3, x2, y4, 'Сгиб правого клапана крышки', grpId)
    );
  }

  // Отверстия под плату в дне, если включены
  if (p.pcbMount) {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    const dx = Math.min(L - 6, p.pcbHoleDistX) / 2;
    const dy = Math.min(W - 6, p.pcbHoleDistY) / 2;
    const r = Math.max(0.8, p.holeD / 2);
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      shapes.push({
        id: luid('hole'),
        kind: 'ellipse',
        layer: 'inner',
        name: 'Отверстие стойки платы',
        groupId: grpId,
        cx: cx + sx * dx,
        cy: cy + sy * dy,
        rx: r,
        ry: r,
        rot: 0,
        startAngle: 0,
        endAngle: 360,
        filled: false,
      });
    }
  }

  // Маркировка на дне и размерные линии
  shapes.push(
    {
      id: luid('txt'),
      kind: 'text',
      layer: 'score',
      name: 'Маркировка дна',
      groupId: grpId,
      x: x1 + 6,
      y: (y1 + y2) / 2 - 2,
      text: `${L}x${W}x${H} MM`,
      size: 4.5,
      strokeWidth: 0.3,
      rot: 0,
      mirror: false,
      filled: false,
    },
    {
      id: luid('dim'),
      kind: 'dim',
      layer: 'guide',
      name: 'Габарит длины L',
      groupId: grpId,
      x1,
      y1: y0,
      x2,
      y2: y0,
      offset: -8,
    },
    {
      id: luid('dim'),
      kind: 'dim',
      layer: 'guide',
      name: 'Габарит ширины W',
      groupId: grpId,
      x1: x0,
      y1,
      x2: x0,
      y2,
      offset: -8,
    }
  );

  return { shapes, groups };
}

/**
 * Построение зубчатого ребра для шипового соединения (Finger Joint) между точками A и B.
 * mode = 'male'   — шипы выступают наружу на толщину листа;
 * mode = 'female' — пазы выбраны внутрь на толщину листа (ответные шипам);
 * mode = 'flat'   — прямой край (например, верх стенки при открытой крышке).
 * clearance — зазор плотной посадки: пазы расширяются вдоль края, чтобы
 * собирать корпус без шлифовки (на шипы не влияет — размер детали остаётся точным).
 */
function fingerEdge(
  a: Pt,
  b: Pt,
  thickness: number,
  targetFingerW: number,
  mode: 'male' | 'female' | 'flat',
  clearance = 0,
  cornerTrimStart = false,
  cornerTrimEnd = false
): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (mode === 'flat' || len < thickness * 3) return [{ ...a }, { ...b }];

  const ux = dx / len, uy = dy / len;
  // Нормаль наружу: при обходе контура против часовой стрелки — справа от вектора AB
  const nx = uy, ny = -ux;

  // Нечётное число сегментов ≥ 3: углы всегда остаются «полными»
  let count = Math.max(3, Math.round(len / Math.max(4, targetFingerW)));
  if (count % 2 === 0) count += 1;

  const startOffset = cornerTrimStart ? thickness : 0;
  const endOffset = cornerTrimEnd ? thickness : 0;
  const innerLen = Math.max(thickness, len - startOffset - endOffset);
  const segW = innerLen / count;
  const clear = Math.max(0, Math.min(clearance, segW * 0.4));
  // Знак высоты: шипы наружу (+), пазы внутрь (−)
  const tabH = mode === 'male' ? thickness : -thickness;
  const isTabAt = (i: number) => (mode === 'male' ? i % 2 === 1 : i % 2 === 0);

  const at = (d: number, h: number): Pt => ({
    x: a.x + ux * d + nx * h,
    y: a.y + uy * d + ny * h,
  });

  const pts: Pt[] = [at(startOffset, 0)];
  for (let i = 0; i < count; i++) {
    const d0 = startOffset + i * segW;
    const d1 = startOffset + (i + 1) * segW;
    if (!isTabAt(i)) {
      pts.push(at(d1, 0));
      continue;
    }
    // паз расширяется зазором посадки, шип остаётся номинальным
    const s0 = mode === 'female' ? Math.max(startOffset, d0 - clear / 2) : d0;
    const s1 = mode === 'female' ? Math.min(startOffset + innerLen, d1 + clear / 2) : d1;
    pts.push(at(s0, 0), at(s0, tabH), at(s1, tabH), at(s1, 0));
  }
  const endD = startOffset + innerLen;
  if (Math.abs(endD - len) > 1e-6) pts.push(at(len - endOffset, 0));
  return pts;
}

/** Панель корпуса: четыре ребра (низ, право, верх, лево) собираются в замкнутый контур. */
function buildFingerPanel(
  ox: number,
  oy: number,
  w: number,
  h: number,
  t: number,
  fw: number,
  clearance: number,
  edges: [
    'male' | 'female' | 'flat',
    'male' | 'female' | 'flat',
    'male' | 'female' | 'flat',
    'male' | 'female' | 'flat',
  ],
  trimCorners: boolean
): Pt[] {
  const c0 = { x: ox, y: oy };
  const c1 = { x: ox + w, y: oy };
  const c2 = { x: ox + w, y: oy + h };
  const c3 = { x: ox, y: oy + h };
  const trimTop = trimCorners && edges[2] !== 'flat';

  const eBottom = fingerEdge(c0, c1, t, fw, edges[0], clearance, trimCorners, trimCorners);
  const eRight = fingerEdge(c1, c2, t, fw, edges[1], clearance, trimCorners, trimTop);
  const eTop = fingerEdge(c2, c3, t, fw, edges[2], clearance, trimTop, trimTop);
  const eLeft = fingerEdge(c3, c0, t, fw, edges[3], clearance, trimTop, trimCorners);

  const all = [...eBottom, ...eRight, ...eTop, ...eLeft];
  // Соседние рёбра дают общую угловую точку — убираем дубликаты
  const clean: Pt[] = [];
  for (const p of all) {
    if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 0.02) {
      clean.push(p);
    }
  }
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (clean.length > 2 && first && last && Math.hypot(first.x - last.x, first.y - last.y) < 0.02) clean.pop();
  return clean;
}

/**
 * 2. Корпус на шипах (Finger-Joint Box) для лазерной резки из фанеры или акрила.
 */
function buildFingerBox(p: UnfoldParams, ox = 12, oy = 12): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const L = Math.max(25, p.length);
  const W = Math.max(25, p.width);
  const H = Math.max(15, p.height);
  const t = Math.max(1, p.thickness);
  const fw = Math.max(5, p.fingerWidth);
  const gap = Math.max(6, t * 2 + 4);
  // Зазор посадки: 0 — плотная сборка (фанера), 0.1…0.3 мм — под покраску/акрил
  const clearance = Math.max(0, Math.min(1, p.clearance || 0));

  const shapes: LaserShape[] = [];
  const groups: LaserGroup[] = [];

  const addPanel = (
    px: number,
    py: number,
    pw: number,
    ph: number,
    title: string,
    edges: ['male' | 'female' | 'flat', 'male' | 'female' | 'flat', 'male' | 'female' | 'flat', 'male' | 'female' | 'flat'],
    trim: boolean,
    withPcbHoles = false
  ) => {
    const gId = luid('grp');
    groups.push({ id: gId, name: title });
    const pts = buildFingerPanel(px, py, pw, ph, t, fw, clearance, edges, trim);
    shapes.push({
      id: luid('panel'),
      kind: 'path',
      layer: 'cut',
      name: title,
      groupId: gId,
      closed: true,
      filled: false,
      nodes: ptNodes(pts),
    });
    shapes.push({
      id: luid('lbl'),
      kind: 'text',
      layer: 'score',
      name: `Маркировка: ${title}`,
      groupId: gId,
      x: px + 6,
      y: py + ph / 2 - 1.5,
      text: title.toUpperCase(),
      size: 3.5,
      strokeWidth: 0.25,
      rot: 0,
      mirror: false,
      filled: false,
    });
    if (withPcbHoles && p.pcbMount) {
      const cx = px + pw / 2;
      const cy = py + ph / 2;
      const dx = Math.min(pw - 8, p.pcbHoleDistX) / 2;
      const dy = Math.min(ph - 8, p.pcbHoleDistY) / 2;
      const r = Math.max(0.8, p.holeD / 2);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        shapes.push({
          id: luid('hole'),
          kind: 'ellipse',
          layer: 'inner',
          name: 'Отверстие под плату',
          groupId: gId,
          cx: cx + sx * dx,
          cy: cy + sy * dy,
          rx: r,
          ry: r,
          rot: 0,
          startAngle: 0,
          endAngle: 360,
          filled: false,
        });
      }
    }
  };

  // Ряд 1: Дно (L×W), Передняя стенка (L×H), Задняя стенка (L×H)
  addPanel(ox, oy, L, W, 'BTM (Дно)', ['male', 'male', 'male', 'male'], false, true);
  const topEdge: 'male' | 'female' | 'flat' = p.openTop ? 'flat' : 'female';
  addPanel(ox + L + gap, oy, L, H, 'FRONT (Перед)', ['female', 'male', topEdge, 'male'], false, false);
  addPanel(ox + L + gap, oy + H + gap, L, H, 'BACK (Тыл)', ['female', 'male', topEdge, 'male'], false, false);

  // Ряд 2: Левая стенка (W×H), Правая стенка (W×H), и Крышка (если !openTop)
  const row2Y = oy + Math.max(W, H * 2 + gap) + gap;
  addPanel(ox, row2Y, W, H, 'LEFT (Лево)', ['female', 'female', topEdge, 'female'], true, false);
  addPanel(ox + W + gap, row2Y, W, H, 'RIGHT (Право)', ['female', 'female', topEdge, 'female'], true, false);
  if (!p.openTop) {
    addPanel(ox + (W + gap) * 2, row2Y, L, W, 'TOP (Крышка)', ['male', 'male', 'male', 'male'], false, false);
  }

  return { shapes, groups };
}

/**
 * 3. П-образное шасси / корпус для печатной платы с вентиляцией и линиями сгиба.
 */
function buildBentCase(p: UnfoldParams, ox = 15, oy = 15): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const W = Math.max(30, p.length);
  const D = Math.max(30, p.width);
  const H = Math.max(12, p.height);
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `П-образное шасси ${W}×${D}×${H}` }];
  const shapes: LaserShape[] = [];

  const totalW = W + 2 * H;
  const r = 3; // скругление углов

  // Внешний контур шасси с угловыми вырезами под гиб
  shapes.push({
    id: luid('case'),
    kind: 'rect',
    layer: 'cut',
    name: 'Внешний контур П-корпуса',
    groupId: grpId,
    x: ox,
    y: oy,
    w: totalW,
    h: D,
    rx: r,
    rot: 0,
    filled: false,
  });

  // Линии гиба левого и правого борта
  shapes.push(
    makeFoldLine(ox + H, oy, ox + H, oy + D, 'Линия гиба левого борта', grpId),
    makeFoldLine(ox + H + W, oy, ox + H + W, oy + D, 'Линия гиба правого борта', grpId)
  );

  // Отверстия крепления платы в центральной базе
  const cx = ox + H + W / 2;
  const cy = oy + D / 2;
  const dx = Math.min(W - 8, p.pcbHoleDistX) / 2;
  const dy = Math.min(D - 8, p.pcbHoleDistY) / 2;
  const hr = Math.max(0.8, p.holeD / 2);
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    shapes.push({
      id: luid('hole'),
      kind: 'ellipse',
      layer: 'inner',
      name: 'Отверстие стойки платы M3',
      groupId: grpId,
      cx: cx + sx * dx,
      cy: cy + sy * dy,
      rx: hr,
      ry: hr,
      rot: 0,
      startAngle: 0,
      endAngle: 360,
      filled: false,
    });
  }

  // Вентиляционные пазы на боковых стенках
  const slotCount = Math.max(3, Math.min(10, Math.floor((D - 16) / 7)));
  const slotW = Math.max(4, H * 0.55);
  const slotH = 2.5;
  for (let i = 0; i < slotCount; i++) {
    const sy = oy + 10 + (i * (D - 20 - slotH)) / Math.max(1, slotCount - 1);
    // Левый борт
    shapes.push({
      id: luid('vent'),
      kind: 'rect',
      layer: 'inner',
      name: `Вент. паз Л-${i + 1}`,
      groupId: grpId,
      x: ox + (H - slotW) / 2,
      y: sy,
      w: slotW,
      h: slotH,
      rx: slotH / 2,
      rot: 0,
      filled: false,
    });
    // Правый борт
    shapes.push({
      id: luid('vent'),
      kind: 'rect',
      layer: 'inner',
      name: `Вент. паз П-${i + 1}`,
      groupId: grpId,
      x: ox + H + W + (H - slotW) / 2,
      y: sy,
      w: slotW,
      h: slotH,
      rx: slotH / 2,
      rot: 0,
      filled: false,
    });
  }

  shapes.push({
    id: luid('dim'),
    kind: 'dim',
    layer: 'guide',
    name: 'Ширина базы W',
    groupId: grpId,
    x1: ox + H,
    y1: oy,
    x2: ox + H + W,
    y2: oy,
    offset: -7,
  });

  return { shapes, groups };
}

/**
 * 4. Развёртка цилиндра или усечённого конуса с клапаном шва и донышками.
 */
function buildCylinderCone(p: UnfoldParams, ox = 15, oy = 15): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const D1 = Math.max(15, p.length);
  const D2 = Math.max(10, p.topDiameter);
  const H = Math.max(15, p.height);
  const tab = Math.max(5, Math.min(20, p.fingerWidth));
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `Развёртка цилиндра/конуса Ø${D1}/${D2}×${H}` }];
  const shapes: LaserShape[] = [];

  const r1 = D1 / 2;
  const r2 = D2 / 2;

  if (Math.abs(r1 - r2) < 0.5) {
    // Цилиндр: прямоугольная боковая развёртка π*D1 × H + клапан склейки
    const circ = Math.PI * D1;
    shapes.push({
      id: luid('cyl'),
      kind: 'rect',
      layer: 'cut',
      name: 'Боковая развёртка цилиндра',
      groupId: grpId,
      x: ox,
      y: oy,
      w: circ + tab,
      h: H,
      rx: 0,
      rot: 0,
      filled: false,
    });
    shapes.push(makeFoldLine(ox + circ, oy, ox + circ, oy + H, 'Линия сгиба шва цилиндра', grpId));
    // Нижнее и верхнее донышки
    const capY = oy + H + r1 + 10;
    shapes.push({
      id: luid('cap1'),
      kind: 'ellipse',
      layer: 'cut',
      name: `Нижнее дно Ø${D1}`,
      groupId: grpId,
      cx: ox + r1,
      cy: capY,
      rx: r1,
      ry: r1,
      rot: 0,
      startAngle: 0,
      endAngle: 360,
      filled: false,
    });
    if (!p.openTop) {
      shapes.push({
        id: luid('cap2'),
        kind: 'ellipse',
        layer: 'cut',
        name: `Верхняя крышка Ø${D1}`,
        groupId: grpId,
        cx: ox + r1 * 3 + 10,
        cy: capY,
        rx: r1,
        ry: r1,
        rot: 0,
        startAngle: 0,
        endAngle: 360,
        filled: false,
      });
    }
  } else {
    // Усечённый конус: круговой сектор
    const bigR = Math.max(r1, r2);
    const smallR = Math.min(r1, r2);
    const slant = Math.hypot(H, bigR - smallR);
    const R_outer = (bigR * slant) / (bigR - smallR);
    const R_inner = R_outer - slant;
    const theta = (2 * Math.PI * bigR) / R_outer; // угол сектора в радианах
    const segs = 48;
    const aStart = Math.PI / 2 - theta / 2;
    const aEnd = Math.PI / 2 + theta / 2;
    const apexX = ox + R_outer * Math.sin(theta / 2) + 15;
    const apexY = oy + 10;

    const pts: Pt[] = [];
    for (let i = 0; i <= segs; i++) {
      const a = aStart + ((aEnd - aStart) * i) / segs;
      pts.push({ x: apexX + R_outer * Math.cos(a), y: apexY + R_outer * Math.sin(a) });
    }
    for (let i = segs; i >= 0; i--) {
      const a = aStart + ((aEnd - aStart) * i) / segs;
      pts.push({ x: apexX + R_inner * Math.cos(a), y: apexY + R_inner * Math.sin(a) });
    }

    shapes.push({
      id: luid('cone'),
      kind: 'path',
      layer: 'cut',
      name: 'Боковая развёртка усечённого конуса',
      groupId: grpId,
      closed: true,
      filled: false,
      nodes: ptNodes(pts),
    });

    // Донышки
    shapes.push({
      id: luid('cap1'),
      kind: 'ellipse',
      layer: 'cut',
      name: `Основание Ø${D1}`,
      groupId: grpId,
      cx: ox + r1 + 10,
      cy: apexY + R_outer + r1 + 12,
      rx: r1,
      ry: r1,
      rot: 0,
      startAngle: 0,
      endAngle: 360,
      filled: false,
    });
  }

  return { shapes, groups };
}

/**
 * 5. Лицевая панель прибора с окном дисплея, отверстиями регуляторов, шкалами и гравировкой.
 */
function buildFrontPanel(p: UnfoldParams, ox = 20, oy = 20): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const W = Math.max(40, p.length);
  const H = Math.max(30, p.width);
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `Лицевая панель ${W}×${H}` }];
  const shapes: LaserShape[] = [];

  // Внешний контур панели со скруглением
  shapes.push({
    id: luid('panel'),
    kind: 'rect',
    layer: 'cut',
    name: 'Контур лицевой панели',
    groupId: grpId,
    x: ox,
    y: oy,
    w: W,
    h: H,
    rx: 4,
    rot: 0,
    filled: false,
  });

  // 4 угловых крепёжных отверстия
  const inset = 5;
  const hr = Math.max(1.0, p.holeD / 2);
  for (const [hx, hy] of [
    [ox + inset, oy + inset],
    [ox + W - inset, oy + inset],
    [ox + W - inset, oy + H - inset],
    [ox + inset, oy + H - inset],
  ]) {
    shapes.push({
      id: luid('mhole'),
      kind: 'ellipse',
      layer: 'inner',
      name: 'Крепёжное отверстие панели',
      groupId: grpId,
      cx: hx,
      cy: hy,
      rx: hr,
      ry: hr,
      rot: 0,
      startAngle: 0,
      endAngle: 360,
      filled: false,
    });
  }

  // Окно дисплея
  const dw = Math.min(W - 20, Math.max(12, p.displayW));
  const dh = Math.min(H * 0.45, Math.max(8, p.displayH));
  const dx = ox + (W - dw) / 2;
  const dy = oy + H - dh - 12;
  shapes.push({
    id: luid('disp'),
    kind: 'rect',
    layer: 'inner',
    name: 'Вырез окна дисплея',
    groupId: grpId,
    x: dx,
    y: dy,
    w: dw,
    h: dh,
    rx: 1.5,
    rot: 0,
    filled: false,
  });

  // Декоративная рамка вокруг дисплея (разметка лазером)
  shapes.push({
    id: luid('frame'),
    kind: 'rect',
    layer: 'score',
    name: 'Рамка дисплея (гравировка)',
    groupId: grpId,
    x: dx - 2,
    y: dy - 2,
    w: dw + 4,
    h: dh + 4,
    rx: 2.5,
    rot: 0,
    filled: false,
  });

  // Отверстия под энкодеры/потенциометры со шкалой делений
  const nCtrl = Math.max(1, Math.min(6, Math.round(p.controlsCount)));
  const ctrlY = oy + Math.max(12, (dy - oy) * 0.5);
  for (let i = 0; i < nCtrl; i++) {
    const cx = ox + ((i + 1) * W) / (nCtrl + 1);
    shapes.push({
      id: luid('pot'),
      kind: 'ellipse',
      layer: 'inner',
      name: `Отверстие регулятора #${i + 1}`,
      groupId: grpId,
      cx,
      cy: ctrlY,
      rx: 3.5,
      ry: 3.5,
      rot: 0,
      startAngle: 0,
      endAngle: 360,
      filled: false,
    });
    // Дуга шкалы вокруг регулятора
    shapes.push({
      id: luid('scale'),
      kind: 'ellipse',
      layer: 'score',
      name: `Шкала регулятора #${i + 1}`,
      groupId: grpId,
      cx,
      cy: ctrlY,
      rx: 6.2,
      ry: 6.2,
      rot: 0,
      startAngle: -45,
      endAngle: 225,
      filled: false,
    });
  }

  // Заголовок прибора
  if (p.titleText.trim()) {
    shapes.push({
      id: luid('title'),
      kind: 'text',
      layer: 'engrave',
      name: 'Надпись на панели',
      groupId: grpId,
      x: ox + 12,
      y: oy + H - 8,
      text: p.titleText.trim(),
      size: 3.8,
      strokeWidth: 0.35,
      rot: 0,
      mirror: false,
      filled: true,
    });
  }

  return { shapes, groups };
}

/**
 * 6. Гибкий рез (Living Hinge) для плавного сгибания фанеры/акрила.
 */
function buildLivingHinge(p: UnfoldParams, ox = 20, oy = 20): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const L = Math.max(40, p.length);
  const W = Math.max(25, p.width);
  const hingeW = Math.max(12, Math.min(L * 0.6, p.height));
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `Развёртка с гибким резом ${L}×${W}` }];
  const shapes: LaserShape[] = [];

  shapes.push({
    id: luid('outer'),
    kind: 'rect',
    layer: 'cut',
    name: 'Внешний контур детали',
    groupId: grpId,
    x: ox,
    y: oy,
    w: L,
    h: W,
    rx: 3,
    rot: 0,
    filled: false,
  });

  const hx0 = ox + (L - hingeW) / 2;
  const cols = Math.max(5, Math.min(25, Math.round(hingeW / 2.2)));
  const dx = hingeW / (cols + 1);
  const bridge = 3.0;

  for (let c = 1; c <= cols; c++) {
    const x = hx0 + c * dx;
    if (c % 2 === 1) {
      // Два паза от краёв к центру, перемычка посередине
      shapes.push(
        {
          id: luid('kerf'),
          kind: 'path',
          layer: 'inner',
          name: `Прорезь шарнира ${c}А`,
          groupId: grpId,
          closed: false,
          filled: false,
          nodes: ptNodes([{ x, y: oy }, { x, y: oy + W / 2 - bridge / 2 }]),
        },
        {
          id: luid('kerf'),
          kind: 'path',
          layer: 'inner',
          name: `Прорезь шарнира ${c}Б`,
          groupId: grpId,
          closed: false,
          filled: false,
          nodes: ptNodes([{ x, y: oy + W / 2 + bridge / 2 }, { x, y: oy + W }]),
        }
      );
    } else {
      // Один длинный паз по центру, перемычки у краёв
      shapes.push({
        id: luid('kerf'),
        kind: 'path',
        layer: 'inner',
        name: `Прорезь шарнира ${c}`,
        groupId: grpId,
        closed: false,
        filled: false,
        nodes: ptNodes([{ x, y: oy + bridge }, { x, y: oy + W - bridge }]),
      });
    }
  }

  return { shapes, groups };
}

/**
 * 7. Эвольвентное зубчатое колесо (Шестерня) для лазерной резки.
 */
function buildGear(p: UnfoldParams, ox = 60, oy = 60): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const m = Math.max(0.8, Math.min(10, p.gearModule || 2));
  const Z = Math.max(6, Math.min(80, Math.round(p.gearTeeth || 24)));
  const boreR = Math.max(1.5, p.holeD / 2);

  const pitchR = (m * Z) / 2;
  const addendumR = pitchR + m;
  const dedendumR = Math.max(boreR + 2, pitchR - 1.25 * m);

  const cx = ox + addendumR + 10;
  const cy = oy + addendumR + 10;
  const grpId = luid('grp');
  const groups: LaserGroup[] = [{ id: grpId, name: `Шестерня Z=${Z} m=${m}` }];
  const shapes: LaserShape[] = [];

  const pts: Pt[] = [];
  const stepAngle = (2 * Math.PI) / Z;
  for (let i = 0; i < Z; i++) {
    const a0 = i * stepAngle;
    const a1 = a0 + stepAngle * 0.18;
    const a2 = a0 + stepAngle * 0.34;
    const a3 = a0 + stepAngle * 0.52;
    const a4 = a0 + stepAngle * 0.68;
    pts.push(
      { x: cx + dedendumR * Math.cos(a0), y: cy + dedendumR * Math.sin(a0) },
      { x: cx + pitchR * Math.cos(a1), y: cy + pitchR * Math.sin(a1) },
      { x: cx + addendumR * Math.cos(a2), y: cy + addendumR * Math.sin(a2) },
      { x: cx + addendumR * Math.cos(a3), y: cy + addendumR * Math.sin(a3) },
      { x: cx + pitchR * Math.cos(a4), y: cy + pitchR * Math.sin(a4) }
    );
  }

  shapes.push({
    id: luid('gear'),
    kind: 'path',
    layer: 'cut',
    name: `Венец шестерни Z=${Z}`,
    groupId: grpId,
    closed: true,
    filled: false,
    nodes: ptNodes(pts),
  });

  // Центральное отверстие под вал
  shapes.push({
    id: luid('bore'),
    kind: 'ellipse',
    layer: 'inner',
    name: `Отверстие вала Ø${p.holeD}`,
    groupId: grpId,
    cx,
    cy,
    rx: boreR,
    ry: boreR,
    rot: 0,
    startAngle: 0,
    endAngle: 360,
    filled: false,
  });

  // Делительная окружность на слое разметки
  shapes.push({
    id: luid('pitch'),
    kind: 'ellipse',
    layer: 'score',
    name: `Делительная окружность Ø${(pitchR * 2).toFixed(1)}`,
    groupId: grpId,
    cx,
    cy,
    rx: pitchR,
    ry: pitchR,
    rot: 0,
    startAngle: 0,
    endAngle: 360,
    filled: false,
  });

  return { shapes, groups };
}

export function generateUnfolding(params: UnfoldParams, ox = 15, oy = 15): { shapes: LaserShape[]; groups: LaserGroup[] } {
  switch (params.template) {
    case 'folded-box':
      return buildFoldedBox(params, ox, oy);
    case 'finger-box':
      return buildFingerBox(params, ox, oy);
    case 'bent-case':
      return buildBentCase(params, ox, oy);
    case 'cylinder-cone':
      return buildCylinderCone(params, ox, oy);
    case 'front-panel':
      return buildFrontPanel(params, ox, oy);
    case 'living-hinge':
      return buildLivingHinge(params, ox, oy);
    case 'gear':
      return buildGear(params, ox, oy);
  }
}
