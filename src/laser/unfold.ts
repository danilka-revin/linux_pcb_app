// Параметрический генератор развёрток и технических деталей для лазерного станка.
// Генерирует контуры резки (cut), внутренние вырезы (inner), линии сгиба/биговки (fold),
// разметку (score) и размерные линии (guide).

import {
  luid,
  selectionBBox,
  shapeBBox,
  translateShape,
  type LaserGroup,
  type LaserShape,
  type PathNode,
  type Pt,
} from './model';
import { buildBox, layoutBoxParts } from './boxes';

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
 * 2. Корпус на шипах (Finger-Joint Box) для лазерной резки из фанеры или акрила.
 *
 * Геометрию считает общий движок коробок (src/laser/boxes.ts) — те же замки
 * шип-паз с подрезкой углов, что и в каталоге «Генератор коробок». Параметры
 * берутся из настроек развёртки. Раньше здесь жил свой раскрой на ~200 строк.
 */
function buildFingerBox(
  p: UnfoldParams,
  ox = 12,
  oy = 12,
  sheetW = 0,
  sheetH = 0
): { shapes: LaserShape[]; groups: LaserGroup[] } {
  const t = Math.max(1, p.thickness);
  const built = buildBox('universal', {
    x: Math.max(25, p.length),
    y: Math.max(25, p.width),
    h: Math.max(15, p.height),
    thickness: t,
    finger: Math.max(5, p.fingerWidth),
    play: Math.max(0, Math.min(1, p.clearance || 0)),
    outside: false,
    floor: true,
    lid: !p.openTop,
    bottomEdge: 'male',
    topEdge: p.openTop ? 'flat' : 'male',
    labels: true,
    reference: false,
  });

  const gap = Math.max(6, t * 2 + 4);
  // Раскладку полками делаем под реальный стол, если он известен; иначе —
  // в компактный блок примерно в полтора корня из общей площади деталей.
  const areaOf = (q: Pt[]) => {
    let a = 0;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) a += (q[j].x + q[i].x) * (q[j].y - q[i].y);
    return Math.abs(a / 2);
  };
  const total = built.parts.reduce((sum, q) => sum + areaOf(q.outline) * Math.max(1, q.count ?? 1), 0);
  const widest = built.parts.reduce((m, q) => {
    const xs = q.outline.map((v) => v.x), ys = q.outline.map((v) => v.y);
    return Math.max(m, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  }, 0);
  const rowW = sheetW > ox * 2 ? sheetW - ox : Math.max(widest + gap, Math.sqrt(Math.max(1, total)) * 1.6);
  const rowH = sheetH > oy * 2 ? sheetH - oy : 1e5;
  const { shapes, groups } = layoutBoxParts(built.parts, { sheetW: rowW, sheetH: rowH, gap, margin: 0 });

  // Раскладка начинается от нуля — переносим её в заданную точку листа
  const bb = selectionBBox(shapes);
  if (bb) {
    const dx = ox - bb[0];
    const dy = oy - bb[1];
    for (let i = 0; i < shapes.length; i++) shapes[i] = translateShape(shapes[i], dx, dy);
  }

  // Стойки под печатную плату размечаем на дне, как в прежнем генераторе
  if (p.pcbMount) {
    const floor = groups.find((g) => g.name === 'Дно');
    const outline = shapes.find((s) => s.groupId === floor?.id && s.layer === 'cut');
    if (floor && outline) {
      const b = shapeBBox(outline);
      const cx = (b[0] + b[2]) / 2;
      const cy = (b[1] + b[3]) / 2;
      const dx = Math.min(b[2] - b[0] - 8, p.pcbHoleDistX) / 2;
      const dy = Math.min(b[3] - b[1] - 8, p.pcbHoleDistY) / 2;
      const r = Math.max(0.8, p.holeD / 2);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
        shapes.push({
          id: luid('hole'), kind: 'ellipse', layer: 'inner', name: 'Отверстие под плату', groupId: floor.id,
          cx: cx + sx * dx, cy: cy + sy * dy, rx: r, ry: r, rot: 0, startAngle: 0, endAngle: 360, filled: false,
        });
      }
    }
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

export function generateUnfolding(
  params: UnfoldParams,
  ox = 15,
  oy = 15,
  sheetW = 0,
  sheetH = 0
): { shapes: LaserShape[]; groups: LaserGroup[] } {
  switch (params.template) {
    case 'folded-box':
      return buildFoldedBox(params, ox, oy);
    case 'finger-box':
      return buildFingerBox(params, ox, oy, sheetW, sheetH);
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
