// Модель документа печатной платы и геометрические утилиты.
// Все координаты — миллиметры, ось Y направлена вверх (как в Gerber).

export type LayerId = 'k1' | 'k2' | 's1' | 's2' | 'outline';

export interface Pt {
  x: number;
  y: number;
}

let idc = 1;
export const uid = (): string =>
  'e' + (idc++).toString(36) + Math.random().toString(36).slice(2, 7);

export type PadShape = 'round' | 'square' | 'oct';

interface Base {
  id: string;
}

/** Контактная площадка с металлизацией — существует на обоих слоях меди */
export interface Pad extends Base {
  kind: 'pad';
  x: number; y: number;
  shape: PadShape;
  size: number;   // диаметр / сторона, мм
  drill: number;  // диаметр отверстия, мм (0 = без отверстия)
  noPlate?: boolean; // без металлизации отверстия (типично для самодельных плат Sprint-Layout)
}

/** Планарная (SMD) площадка — только на одном слое меди */
export interface Smd extends Base {
  kind: 'smd';
  x: number; y: number;
  w: number; h: number;
  rot: number;    // 0 или 90
  layer: 'k1' | 'k2';
}

/** Дорожка (полилиния с шириной) */
export interface Track extends Base {
  kind: 'track';
  pts: Pt[];
  w: number;
  layer: 'k1' | 'k2';
}

/** Переходное отверстие */
export interface Via extends Base {
  kind: 'via';
  x: number; y: number;
  size: number;
  drill: number;
}

/** Неметаллизированное монтажное отверстие */
export interface Hole extends Base {
  kind: 'hole';
  x: number; y: number;
  d: number;
}

/** Линия (шелкография/контур) */
export interface LineE extends Base {
  kind: 'line';
  x1: number; y1: number; x2: number; y2: number;
  w: number;
  layer: LayerId;
}

/** Окружность (обводка) */
export interface Circ extends Base {
  kind: 'circle';
  x: number; y: number; r: number;
  w: number;
  layer: LayerId;
}

/** Прямоугольник: обводка или залитый (слой меди = сплошной полигон) */
export interface RectE extends Base {
  kind: 'rect';
  x: number; y: number; w: number; h: number;
  filled: boolean;
  th: number; // толщина обводки, если не залит
  layer: LayerId;
}

/** Текст */
export interface TextE extends Base {
  kind: 'text';
  x: number; y: number;
  size: number;   // высота, мм
  th: number;     // толщина штриха, мм
  rot: number;    // 0/90/180/270
  text: string;
  mirror: boolean;
  layer: LayerId;
}

/** Залитый полигон (земляной полигон на слое меди) */
export interface Poly extends Base {
  kind: 'poly';
  pts: Pt[];
  layer: 'k1' | 'k2';
}

/** Компонент из библиотеки (экземпляр макроса) */
export interface Comp extends Base {
  kind: 'comp';
  lib: string; // пусто, если заданы встроенные ents (пользовательский макрос)
  name: string;
  x: number; y: number;
  rot: number;
  side: 'top' | 'bottom';
  bl: [number, number, number, number]; // локальный bbox
  ents?: Entity[]; // встроенные примитивы (макрос .lmk, вставленный из файла)
}

export type Entity =
  | Pad | Smd | Track | Via | Hole | LineE | Circ | RectE | TextE | Poly | Comp;

/** Группа электрически связанных площадок; ссылки на ID развёрнутых примитивов. */
export interface Net {
  id: string;
  name: string;
  pads: string[];
}

export interface Doc {
  name: string;
  w: number; // ширина платы, мм
  h: number; // высота платы, мм
  entities: Entity[];
  nets?: Net[]; // сохраняются в проекте JSON, не в Sprint-Layout
}

export const LAYERS: { id: LayerId; ru: string; short: string; color: string }[] = [
  { id: 'k1', ru: 'Верхняя медь', short: 'K1', color: '#e5484d' },
  { id: 'k2', ru: 'Нижняя медь', short: 'K2', color: '#35c46a' },
  { id: 's1', ru: 'Шелкография верх', short: 'Ш1', color: '#e8c93e' },
  { id: 's2', ru: 'Шелкография низ', short: 'Ш2', color: '#a8b0b8' },
  { id: 'outline', ru: 'Контур платы', short: 'Контур', color: '#e9ecf1' },
];

export function newBoard(w = 100, h = 80, name = 'Плата'): Doc {
  return {
    name, w, h,
    entities: [
      { id: uid(), kind: 'rect', x: 0, y: 0, w, h, filled: false, th: 0.2, layer: 'outline' },
    ],
  };
}

export const cloneDoc = (d: Doc): Doc => JSON.parse(JSON.stringify(d)) as Doc;
export const snap = (v: number, g: number): number => Math.round(v / g) * g;
export const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
export const fmt = (v: number, d = 3): string => String(parseFloat(v.toFixed(d)));
export const mm2mil = (v: number): number => v / 0.0254;

export const swapLayer = (l: LayerId): LayerId =>
  l === 'k1' ? 'k2' : l === 'k2' ? 'k1' : l === 's1' ? 's2' : l === 's2' ? 's1' : 'outline';

export function rotPt(x: number, y: number, cx: number, cy: number, deg: number): Pt {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

export function translateEnt(e: Entity, dx: number, dy: number): void {
  switch (e.kind) {
    case 'pad': case 'via': case 'hole': case 'smd':
    case 'text': case 'circle': case 'comp':
      e.x += dx; e.y += dy; break;
    case 'track': case 'poly':
      e.pts.forEach((p) => { p.x += dx; p.y += dy; }); break;
    case 'line':
      e.x1 += dx; e.y1 += dy; e.x2 += dx; e.y2 += dy; break;
    case 'rect':
      e.x += dx; e.y += dy; break;
  }
}

/** Поворот на 90° против часовой вокруг точки */
export function rotateEnt90(e: Entity, cx: number, cy: number): void {
  const R = (p: Pt): Pt => rotPt(p.x, p.y, cx, cy, 90);
  switch (e.kind) {
    case 'pad': case 'via': case 'hole': case 'circle': {
      const p = R(e); e.x = p.x; e.y = p.y; break;
    }
    case 'smd': {
      const p = R(e); e.x = p.x; e.y = p.y; e.rot = (e.rot + 90) % 180; break;
    }
    case 'track': case 'poly': e.pts = e.pts.map(R); break;
    case 'line': {
      const a = R({ x: e.x1, y: e.y1 }), b = R({ x: e.x2, y: e.y2 });
      e.x1 = a.x; e.y1 = a.y; e.x2 = b.x; e.y2 = b.y; break;
    }
    case 'rect': {
      const a = R({ x: e.x, y: e.y }), b = R({ x: e.x + e.w, y: e.y + e.h });
      e.x = Math.min(a.x, b.x); e.y = Math.min(a.y, b.y);
      e.w = Math.abs(a.x - b.x); e.h = Math.abs(a.y - b.y); break;
    }
    case 'text': {
      const p = R(e); e.x = p.x; e.y = p.y; e.rot = (e.rot + 90) % 360; break;
    }
    case 'comp': {
      const p = R(e); e.x = p.x; e.y = p.y; e.rot = (e.rot + 90) % 360; break;
    }
  }
}

/** Перенос на другую сторону платы (зеркало по вертикали через cx) */
export function mirrorEnt(e: Entity, cx: number): void {
  const F = (x: number): number => 2 * cx - x;
  switch (e.kind) {
    case 'pad': case 'via': case 'hole':
      e.x = F(e.x); break;
    case 'smd':
      e.x = F(e.x); e.layer = e.layer === 'k1' ? 'k2' : 'k1'; e.rot = (180 - e.rot) % 180; break;
    case 'circle':
      e.x = F(e.x); e.layer = swapLayer(e.layer); break;
    case 'track':
      e.pts = e.pts.map((p) => ({ x: F(p.x), y: p.y }));
      e.layer = e.layer === 'k1' ? 'k2' : 'k1'; break;
    case 'poly':
      e.pts = e.pts.map((p) => ({ x: F(p.x), y: p.y }));
      e.layer = e.layer === 'k1' ? 'k2' : 'k1'; break;
    case 'line':
      e.x1 = F(e.x1); e.x2 = F(e.x2); e.layer = swapLayer(e.layer); break;
    case 'rect':
      e.x = F(e.x + e.w); e.layer = swapLayer(e.layer); break;
    case 'text': {
      e.x = F(e.x);
      e.mirror = !e.mirror;
      e.rot = (360 - e.rot) % 360;
      e.layer = swapLayer(e.layer);
      if (e.layer === 'outline') e.layer = 's2';
      break;
    }
    case 'comp':
      e.x = F(e.x);
      e.side = e.side === 'top' ? 'bottom' : 'top';
      e.rot = (360 - e.rot) % 360;
      break;
  }
}

export function entBBox(e: Entity): [number, number, number, number] {
  switch (e.kind) {
    case 'pad': { const r = e.size / 2; return [e.x - r, e.y - r, e.x + r, e.y + r]; }
    case 'via': { const r = e.size / 2; return [e.x - r, e.y - r, e.x + r, e.y + r]; }
    case 'hole': { const r = Math.max(e.d / 2, 0.5); return [e.x - r, e.y - r, e.x + r, e.y + r]; }
    case 'smd': {
      const rot = (((Math.round(e.rot) % 180) + 180) % 180);
      const w = rot === 0 ? e.w : e.h;
      const h = rot === 0 ? e.h : e.w;
      return [e.x - w / 2, e.y - h / 2, e.x + w / 2, e.y + h / 2];
    }
    case 'circle': return [e.x - e.r, e.y - e.r, e.x + e.r, e.y + e.r];
    case 'track': case 'poly': {
      let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
      for (const p of e.pts) {
        x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y);
        x2 = Math.max(x2, p.x); y2 = Math.max(y2, p.y);
      }
      const m = e.kind === 'track' ? e.w / 2 : 0;
      return [x1 - m, y1 - m, x2 + m, y2 + m];
    }
    case 'line': {
      const m = e.w / 2;
      return [Math.min(e.x1, e.x2) - m, Math.min(e.y1, e.y2) - m,
              Math.max(e.x1, e.x2) + m, Math.max(e.y1, e.y2) + m];
    }
    case 'rect': return [e.x, e.y, e.x + e.w, e.y + e.h];
    case 'text': {
      const w = e.text.length * e.size * 0.62, h = e.size;
      const cs = [[0, 0], [w, 0], [w, h], [0, h]].map(([xx, yy]) => rotPt(xx, yy, 0, 0, e.rot));
      const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
      return [Math.min(...xs) + e.x, Math.min(...ys) + e.y, Math.max(...xs) + e.x, Math.max(...ys) + e.y];
    }
    case 'comp': {
      const [x1, y1, x2, y2] = e.bl;
      const a = (e.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([xx, yy]) => {
        const mx = e.side === 'bottom' ? -xx : xx;
        return { x: e.x + mx * c - yy * s, y: e.y + mx * s + yy * c };
      });
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    }
  }
}

export function unionBBox(bs: [number, number, number, number][]): [number, number, number, number] {
  return [
    Math.min(...bs.map((b) => b[0])), Math.min(...bs.map((b) => b[1])),
    Math.max(...bs.map((b) => b[2])), Math.max(...bs.map((b) => b[3])),
  ];
}

export function docBBox(d: Doc): [number, number, number, number] {
  const list = d.entities.map(entBBox);
  if (!list.length) return [0, 0, d.w, d.h];
  return unionBBox(list);
}

export function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy;
  if (!L2) return Math.hypot(px - x1, py - y1);
  const t = clamp(((px - x1) * dx + (py - y1) * dy) / L2, 0, 1);
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function pointInPoly(pts: Pt[], x: number, y: number): boolean {
  let ins = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) ins = !ins;
  }
  return ins;
}

/** Точное попадание точки в примитив (для клика) */
export function hitEnt(e: Entity, p: Pt, tol: number): boolean {
  switch (e.kind) {
    case 'pad': case 'via':
      return Math.hypot(p.x - e.x, p.y - e.y) <= e.size / 2 + tol;
    case 'hole':
      return Math.hypot(p.x - e.x, p.y - e.y) <= Math.max(e.d / 2 + tol, 0.6);
    case 'smd': case 'text': case 'comp': {
      const b = entBBox(e);
      return p.x >= b[0] - tol && p.x <= b[2] + tol && p.y >= b[1] - tol && p.y <= b[3] + tol;
    }
    case 'circle':
      return Math.abs(Math.hypot(p.x - e.x, p.y - e.y) - e.r) <= e.w / 2 + tol;
    case 'track': {
      for (let i = 0; i < e.pts.length - 1; i++)
        if (distToSeg(p.x, p.y, e.pts[i].x, e.pts[i].y, e.pts[i + 1].x, e.pts[i + 1].y) <= e.w / 2 + tol) return true;
      return false;
    }
    case 'poly': {
      if (pointInPoly(e.pts, p.x, p.y)) return true;
      for (let i = 0; i < e.pts.length; i++) {
        const a = e.pts[i], b = e.pts[(i + 1) % e.pts.length];
        if (distToSeg(p.x, p.y, a.x, a.y, b.x, b.y) <= tol + 0.15) return true;
      }
      return false;
    }
    case 'line':
      return distToSeg(p.x, p.y, e.x1, e.y1, e.x2, e.y2) <= e.w / 2 + tol;
    case 'rect': {
      if (e.filled) {
        const b = entBBox(e);
        return p.x >= b[0] - tol && p.x <= b[2] + tol && p.y >= b[1] - tol && p.y <= b[3] + tol;
      }
      const edges: [number, number, number, number][] = [
        [e.x, e.y, e.x + e.w, e.y], [e.x + e.w, e.y, e.x + e.w, e.y + e.h],
        [e.x + e.w, e.y + e.h, e.x, e.y + e.h], [e.x, e.y + e.h, e.x, e.y],
      ];
      return edges.some((s) => distToSeg(p.x, p.y, s[0], s[1], s[2], s[3]) <= Math.max(e.th / 2, 0.2) + tol);
    }
  }
}
