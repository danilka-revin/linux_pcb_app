// Отрисовка холста лазерного редактора: лист станка, сетка, фигуры по слоям,
// выделение с маркерами трансформации, узлы кривых (режим «Форма»), габариты.
// Система координат — миллиметры листа, Y вверх (как у станка); экранная Y вниз.

import {
  shapeToPolylines,
  type LaserDoc,
  type LaserLayerId,
  type LaserShape,
  type Pt,
} from './model';

export interface LaserView {
  /** Масштаб: пикселей на миллиметр */
  s: number;
  /** Экранная позиция начала координат листа (мм 0;0) */
  ox: number;
  oy: number;
}

export interface LaserTheme {
  bg: string;
  sheet: string;
  sheetEdge: string;
  grid: string;
  gridMajor: string;
  text: string;
  muted: string;
  sel: string;
  selFill: string;
  handle: string;
  handleEdge: string;
  node: string;
  nodeSmooth: string;
  dim: string;
  origin: string;
}

export const LASER_THEME: Record<'dark' | 'light', LaserTheme> = {
  dark: {
    bg: '#0b0e13',
    sheet: '#171b22',
    sheetEdge: '#3a434f',
    grid: 'rgba(255,255,255,0.05)',
    gridMajor: 'rgba(255,255,255,0.11)',
    text: '#edf0f4',
    muted: '#8b95a1',
    sel: '#ffc233',
    selFill: 'rgba(255,194,51,0.10)',
    handle: '#ffc233',
    handleEdge: '#1d1602',
    node: '#22d3ee',
    nodeSmooth: '#4ade80',
    dim: '#94a3b8',
    origin: '#ff453a',
  },
  light: {
    bg: '#e9ecf1',
    sheet: '#ffffff',
    sheetEdge: '#b9c1cc',
    grid: 'rgba(20,30,45,0.07)',
    gridMajor: 'rgba(20,30,45,0.15)',
    text: '#1c232c',
    muted: '#5c6773',
    sel: '#b26e00',
    selFill: 'rgba(224,142,0,0.10)',
    handle: '#e08e00',
    handleEdge: '#ffffff',
    node: '#0e7490',
    nodeSmooth: '#15803d',
    dim: '#64748b',
    origin: '#cf4438',
  },
};
export function laserTheme(mode: 'dark' | 'light'): LaserTheme {
  return LASER_THEME[mode] ?? LASER_THEME.dark;
}

/** мм → пиксели экрана */
export function toScreen(v: LaserView, x: number, y: number): { px: number; py: number } {
  return { px: v.ox + x * v.s, py: v.oy - y * v.s };
}

/** пиксели экрана → мм */
export function toWorld(v: LaserView, px: number, py: number): Pt {
  return { x: (px - v.ox) / v.s, y: (v.oy - py) / v.s };
}

/** Привязка к сетке (в мм) */
export function snapToGrid(p: Pt, step: number, on: boolean): Pt {
  if (!on || !(step > 0)) return { x: p.x, y: p.y };
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

export interface LaserGridConf {
  step: number;
  major: number;
  on: boolean;
  style: 'lines' | 'dots';
}

export function drawLaserGrid(
  ctx: CanvasRenderingContext2D,
  view: LaserView,
  w: number,
  h: number,
  grid: LaserGridConf,
  theme: LaserTheme
): void {
  if (!grid.on || grid.step <= 0) return;
  const stepPx = grid.step * view.s;
  if (stepPx < 4) return; // слишком плотно — сетку не рисуем
  const majorEvery = Math.max(2, Math.round(grid.major));
  const x0 = Math.floor(toWorld(view, 0, 0).x / grid.step) * grid.step;
  const x1 = toWorld(view, w, 0).x;
  const y1 = toWorld(view, 0, 0).y;
  const y0 = Math.floor(toWorld(view, 0, h).y / grid.step) * grid.step;

  ctx.lineWidth = 1;
  let i = 0;
  for (let x = x0; x <= x1 + 1e-6; x += grid.step, i++) {
    const { px } = toScreen(view, x, 0);
    const major = Math.round(x / grid.step) % majorEvery === 0;
    ctx.strokeStyle = major ? theme.gridMajor : theme.grid;
    if (grid.style === 'dots' && !major) {
      for (let y = y0; y <= y1 + 1e-6; y += grid.step * majorEvery) {
        const q = toScreen(view, x, y);
        ctx.fillStyle = theme.grid;
        ctx.fillRect(q.px - 0.5, q.py - 0.5, 1, 1);
      }
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, h);
    ctx.stroke();
  }
  for (let y = y0; y <= y1 + 1e-6; y += grid.step) {
    const { py } = toScreen(view, 0, y);
    const major = Math.round(y / grid.step) % majorEvery === 0;
    ctx.strokeStyle = major ? theme.gridMajor : theme.grid;
    if (grid.style === 'dots' && !major) continue;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(py) + 0.5);
    ctx.lineTo(w, Math.round(py) + 0.5);
    ctx.stroke();
  }
}

/** Лист рабочего поля станка + начало координат (угол стола) */
export function drawLaserSheet(
  ctx: CanvasRenderingContext2D,
  doc: LaserDoc,
  view: LaserView,
  w: number,
  h: number,
  theme: LaserTheme
): void {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  const tl = toScreen(view, 0, doc.h);
  const br = toScreen(view, doc.w, 0);
  ctx.fillStyle = theme.sheet;
  ctx.fillRect(tl.px, tl.py, br.px - tl.px, br.py - tl.py);
  ctx.strokeStyle = theme.sheetEdge;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tl.px + 0.5, tl.py + 0.5, br.px - tl.px - 1, br.py - tl.py - 1);

  // Начало координат станка (левый нижний угол листа)
  const o = toScreen(view, 0, 0);
  ctx.strokeStyle = theme.origin;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(o.px, o.py);
  ctx.lineTo(o.px + 16, o.py);
  ctx.moveTo(o.px, o.py);
  ctx.lineTo(o.px, o.py - 16);
  ctx.stroke();
  ctx.fillStyle = theme.origin;
  ctx.beginPath();
  ctx.arc(o.px, o.py, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // Подпись размера листа
  ctx.fillStyle = theme.muted;
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${doc.w} × ${doc.h} мм · ${doc.materialThickness} мм`, tl.px + 8, tl.py + 6);
}

/** Маркеры перемычек (tabs) на контуре — маленькие квадраты в точках удержания */
function drawTabs(ctx: CanvasRenderingContext2D, pts: Pt[], count: number, tabWidth: number, view: LaserView, theme: LaserTheme): void {
  if (!count || pts.length < 2) return;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  const pitch = total / count;
  let acc = 0;
  let placed = 0;
  for (let i = 0; i < pts.length - 1 && placed < count; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    while (acc + segLen >= pitch * (placed + 0.5) && placed < count) {
      const target = pitch * (placed + 0.5);
      const t = (target - acc) / segLen;
      if (t >= 0 && t <= 1) {
        const p = toScreen(view, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
        const r = Math.max(2, (tabWidth / 2) * view.s);
        ctx.fillStyle = theme.handleEdge;
        ctx.strokeStyle = theme.sel;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.rect(p.px - r, p.py - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
        placed++;
      } else break;
    }
    acc += segLen;
  }
}

export interface DrawShapeOpts {
  selected?: boolean;
  draft?: boolean;
  ghost?: boolean;
}

/** Отрисовка одной фигуры в цвете её слоя */
export function drawLaserShape(
  ctx: CanvasRenderingContext2D,
  shape: LaserShape,
  view: LaserView,
  color: string,
  opts: DrawShapeOpts = {}
): void {
  const polylines = shapeToPolylines(shape);
  if (!polylines.length) return;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = opts.ghost ? 1 : opts.selected ? 2.3 : 1.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (opts.draft) ctx.setLineDash([5, 4]);
  else if (opts.ghost) ctx.setLineDash([3, 3]);

  const trace = (pts: Pt[]) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = toScreen(view, pts[i].x, pts[i].y);
      if (i === 0) ctx.moveTo(p.px, p.py);
      else ctx.lineTo(p.px, p.py);
    }
    if (shape.kind === 'path' && shape.closed) ctx.closePath();
  };

  // Заливка: у гравировки — плотная, у прочих залитых фигур — полупрозрачная
  const filled = shape.kind === 'dim' ? false : ('filled' in shape ? shape.filled : false);
  if (filled) {
    ctx.beginPath();
    for (const pl of polylines) {
      if (pl.length < 2) continue;
      for (let i = 0; i < pl.length; i++) {
        const p = toScreen(view, pl[i].x, pl[i].y);
        if (i === 0) ctx.moveTo(p.px, p.py);
        else ctx.lineTo(p.px, p.py);
      }
      if (shape.kind === 'path' && shape.closed) ctx.closePath();
    }
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
  }

  for (const pl of polylines) {
    trace(pl);
    ctx.stroke();
  }

  // Размерные линии: стрелки и подпись
  if (shape.kind === 'dim') {
    const pls = polylines;
    const main = pls[pls.length - 1];
    if (main && main.length === 2) {
      const a = toScreen(view, main[0].x, main[0].y);
      const b = toScreen(view, main[1].x, main[1].y);
      const ang = Math.atan2(b.py - a.py, b.px - a.px);
      const arrow = 7;
      ctx.fillStyle = color;
      for (const [px, py, dir] of [[a.px, a.py, 1], [b.px, b.py, -1]] as [number, number, number][]) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(ang + 0.4) * arrow * dir, py + Math.sin(ang + 0.4) * arrow * dir);
        ctx.lineTo(px + Math.cos(ang - 0.4) * arrow * dir, py + Math.sin(ang - 0.4) * arrow * dir);
        ctx.closePath();
        ctx.fill();
      }
      const dxMm = shape.x2 - shape.x1;
      const dyMm = shape.y2 - shape.y1;
      const lenMm = Math.hypot(dxMm, dyMm);
      const label = shape.label || `${lenMm.toFixed(2)} мм`;
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const mx = (a.px + b.px) / 2;
      const my = (a.py + b.py) / 2;
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = opts.ghost ? 'transparent' : '#0b0e13';
      ctx.globalAlpha = 0.75;
      ctx.fillRect(mx - tw / 2, my - 15, tw, 14);
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fillText(label, mx, my - 2);
    }
  }

  ctx.restore();

  if (shape.tabs && shape.tabs > 0 && polylines[0]) {
    drawTabs(ctx, polylines[0], shape.tabs, shape.tabWidth ?? 1.8, view, {
      ...({} as LaserTheme),
      sel: color,
      handleEdge: '#0b0e13',
    } as LaserTheme);
  }
}

/** Узлы кривой (режим «Форма» / Shape Tool): квадраты с рычагами Безье */
export function drawPathNodes(
  ctx: CanvasRenderingContext2D,
  shape: LaserShape,
  view: LaserView,
  theme: LaserTheme,
  activeNode: number | null
): { x: number; y: number; idx: number }[] {
  if (shape.kind !== 'path') return [];
  const handles: { x: number; y: number; idx: number }[] = [];
  ctx.save();
  shape.nodes.forEach((n, idx) => {
    const p = toScreen(view, n.x, n.y);
    handles.push({ x: p.px, y: p.py, idx });
    // рычаги
    if (n.cp1x !== undefined && n.cp1y !== undefined) {
      const c = toScreen(view, n.cp1x, n.cp1y);
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(c.px, c.py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.muted;
      ctx.beginPath();
      ctx.arc(c.px, c.py, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    if (n.cp2x !== undefined && n.cp2y !== undefined) {
      const c = toScreen(view, n.cp2x, n.cp2y);
      ctx.strokeStyle = theme.muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(c.px, c.py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.muted;
      ctx.beginPath();
      ctx.arc(c.px, c.py, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  // сами узлы рисуем поверх рычагов
  shape.nodes.forEach((n, idx) => {
    const p = toScreen(view, n.x, n.y);
    const r = idx === activeNode ? 5 : 3.6;
    ctx.fillStyle = n.smooth ? theme.nodeSmooth : theme.node;
    ctx.strokeStyle = theme.handleEdge;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.rect(p.px - r, p.py - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();
  return handles;
}

export const SELECTION_HANDLE_IDS = ['sw', 'se', 'ne', 'nw', 's', 'e', 'n', 'w'] as const;
export type SelectionHandleId = (typeof SELECTION_HANDLE_IDS)[number];

/** Экранные позиции 8 маркеров выделения (нужны и для рисования, и для hit-теста) */
export function selectionHandlePoints(
  bb: [number, number, number, number],
  view: LaserView,
  rotDeg = 0
): { px: number; py: number; id: SelectionHandleId }[] {
  const [x0, y0, x1, y1] = bb;
  const c = toScreen(view, (x0 + x1) / 2, (y0 + y1) / 2);
  const corners: [number, number][] = [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1],
    [(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2],
  ];
  const a = (-rotDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  return corners.map(([x, y], i) => {
    const p = toScreen(view, x, y);
    const dx = p.px - c.px, dy = p.py - c.py;
    return {
      px: c.px + dx * ca - dy * sa,
      py: c.py + dx * sa + dy * ca,
      id: SELECTION_HANDLE_IDS[i],
    };
  });
}

/** Маркеры выделения (8 ручек масштаба + рамка) — как в CorelDRAW */
export function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  bb: [number, number, number, number],
  view: LaserView,
  theme: LaserTheme,
  rotDeg = 0
): { px: number; py: number; id: SelectionHandleId }[] {
  const pts = selectionHandlePoints(bb, view, rotDeg);

  ctx.save();
  ctx.strokeStyle = theme.sel;
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(pts[0].px, pts[0].py);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].px, pts[i].py);
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = theme.handle;
  ctx.strokeStyle = theme.handleEdge;
  ctx.lineWidth = 1;
  pts.forEach((p) => {
    ctx.beginPath();
    ctx.rect(p.px - 3.5, p.py - 3.5, 7, 7);
    ctx.fill();
    ctx.stroke();
  });
  ctx.restore();

  return pts;
}

/** Рамка группового выделения (маркиз) */
export function drawMarquee(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  view: LaserView,
  theme: LaserTheme
): void {
  const p1 = toScreen(view, a.x, a.y);
  const p2 = toScreen(view, b.x, b.y);
  ctx.save();
  ctx.strokeStyle = theme.sel;
  ctx.fillStyle = theme.selFill;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.rect(Math.min(p1.px, p2.px), Math.min(p1.py, p2.py), Math.abs(p2.px - p1.px), Math.abs(p2.py - p1.py));
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Габаритная подпись выделения (ширина × высота в мм) */
export function drawSelectionLabel(
  ctx: CanvasRenderingContext2D,
  bb: [number, number, number, number],
  view: LaserView,
  theme: LaserTheme,
  extra?: string
): void {
  const p = toScreen(view, bb[0], bb[3]);
  const label = `${(bb[2] - bb[0]).toFixed(2)} × ${(bb[3] - bb[1]).toFixed(2)} мм${extra ? ' · ' + extra : ''}`;
  ctx.save();
  ctx.font = '11px Inter, system-ui, sans-serif';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillStyle = theme.selFill;
  ctx.strokeStyle = theme.sel;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(p.px, p.py - 20, tw, 16, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = theme.sel;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, p.px + 5, p.py - 12);
  ctx.restore();
}

/** Цвет слоя для отрисовки (скрытые слои не рисуются) */
export function layerColor(doc: LaserDoc, layer: LaserLayerId): string {
  return doc.layers[layer]?.color ?? '#ffc233';
}

export function isLayerVisible(doc: LaserDoc, layer: LaserLayerId): boolean {
  return doc.layers[layer]?.visible !== false;
}
