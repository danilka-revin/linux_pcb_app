// Ядро векторного редактора развёрток и лазерной резки (в духе CorelDRAW + LightBurn).
// Все координаты в миллиметрах рабочего поля лазерного станка (0;0 — левый нижний угол листа).

import * as Clipper from 'clipper-lib';
import { textPolylines } from '../pcb/strokefont';

export interface Pt {
  x: number;
  y: number;
}

/**
 * Идентификатор слоя. Слои в редакторе чертежей свои: пользователь добавляет
 * «Слой 1», «Слой 2», … и переименовывает их как угодно. Исторические
 * идентификаторы ролей (cut/inner/fold/score/engrave/guide) остались в ядре —
 * их используют генераторы коробок и развёрток, а редактор раскладывает такие
 * объекты по своим слоям через `adoptShapes`.
 */
export type LaserLayerId = string;

/** Роли линий, которые понимают генераторы и импорт файлов. */
export type LaserLayerRole = 'cut' | 'inner' | 'fold' | 'score' | 'engrave' | 'guide';

/** Все роли по порядку — он же порядок слоёв в старых документах. */
export const LAYER_ROLES: LaserLayerRole[] = ['cut', 'inner', 'fold', 'score', 'engrave', 'guide'];

/** Режим линии по роли: сплошная, штриховая, тонкая, заливка, служебная. */
export const LAYER_ROLE_MODE: Record<LaserLayerRole, 'cut' | 'fold' | 'score' | 'fill' | 'guide'> = {
  cut: 'cut',
  inner: 'cut',
  fold: 'fold',
  score: 'score',
  engrave: 'fill',
  guide: 'guide',
};

export interface LaserLayerConfig {
  id: LaserLayerId;
  name: string;
  short: string;
  color: string;
  mode: 'cut' | 'fold' | 'score' | 'fill' | 'guide';
  /** Мощность лазера, % (0..100) */
  power: number;
  /** Скорость перемещения, мм/с */
  speed: number;
  /** Число проходов */
  passes: number;
  /** Компенсация толщины луча (kerf), мм */
  kerf: number;
  /** Длина штриха перфорации (для линии сгиба), мм (0 = сплошная) */
  dashLen: number;
  /** Пропуск между штрихами перфорации, мм */
  gapLen: number;
  /** Обдув воздухом (Air Assist) */
  airAssist: boolean;
  visible: boolean;
  locked: boolean;
}

export const DEFAULT_LASER_LAYERS: Record<string, LaserLayerConfig> = {
  cut: {
    id: 'cut',
    name: 'Основной контур (внешний)',
    short: 'Контур (Cut)',
    color: '#ff453a',
    mode: 'cut',
    power: 85,
    speed: 15,
    passes: 1,
    kerf: 0.1,
    dashLen: 0,
    gapLen: 0,
    airAssist: true,
    visible: true,
    locked: false,
  },
  inner: {
    id: 'inner',
    name: 'Внутренние контуры и отверстия',
    short: 'Внутренний (Inner)',
    color: '#c084fc',
    mode: 'cut',
    power: 85,
    speed: 14,
    passes: 1,
    kerf: 0.1,
    dashLen: 0,
    gapLen: 0,
    airAssist: true,
    visible: true,
    locked: false,
  },
  fold: {
    id: 'fold',
    name: 'Линия сгиба / Биговка / Перфорация',
    short: 'Сгиб (Fold)',
    color: '#22c55e',
    mode: 'fold',
    power: 35,
    speed: 45,
    passes: 1,
    kerf: 0,
    dashLen: 4,
    gapLen: 2,
    airAssist: true,
    visible: true,
    locked: false,
  },
  score: {
    id: 'score',
    name: 'Контурная разметка (тонкая линия)',
    short: 'Разметка (Score)',
    color: '#38bdf8',
    mode: 'score',
    power: 22,
    speed: 100,
    passes: 1,
    kerf: 0,
    dashLen: 0,
    gapLen: 0,
    airAssist: false,
    visible: true,
    locked: false,
  },
  engrave: {
    id: 'engrave',
    name: 'Заливка области (растр)',
    short: 'Заливка (Engrave)',
    color: '#ffc233',
    mode: 'fill',
    power: 30,
    speed: 240,
    passes: 1,
    kerf: 0,
    dashLen: 0,
    gapLen: 0,
    airAssist: false,
    visible: true,
    locked: false,
  },
  guide: {
    id: 'guide',
    name: 'Направляющие и размеры (не выводятся)',
    short: 'Размеры',
    color: '#94a3b8',
    mode: 'guide',
    power: 0,
    speed: 100,
    passes: 0,
    kerf: 0,
    dashLen: 0,
    gapLen: 0,
    airAssist: false,
    visible: true,
    locked: false,
  },
};

export const LASER_LAYER_ORDER: LaserLayerId[] = ['engrave', 'score', 'fold', 'inner', 'cut', 'guide'];

// ---------------- свои слои чертежа ----------------

/** Палитра цветов для новых слоёв (золото PSBees — первым). */
export const LAYER_PALETTE = [
  '#ffc233', '#38bdf8', '#22c55e', '#c084fc', '#ff453a', '#f472b6', '#facc15', '#94a3b8',
];

/**
 * Новый слой чертежа: имя задаёт пользователь, станочные параметры берутся
 * нейтральные (в интерфейсе чертежей они не показываются).
 */
export function makeLaserLayer(
  id: string,
  name: string,
  color = LAYER_PALETTE[0],
  mode: LaserLayerConfig['mode'] = 'cut'
): LaserLayerConfig {
  const clean = (name || '').trim().slice(0, 60) || `Слой`;
  return {
    id,
    name: clean,
    short: clean,
    color,
    mode,
    power: mode === 'guide' ? 0 : 85,
    speed: mode === 'fill' ? 240 : mode === 'score' ? 100 : mode === 'fold' ? 45 : 15,
    passes: mode === 'guide' ? 0 : 1,
    kerf: 0,
    dashLen: mode === 'fold' ? 4 : 0,
    gapLen: mode === 'fold' ? 2 : 0,
    airAssist: false,
    visible: true,
    locked: false,
  };
}

/**
 * Порядок слоёв документа: сначала свой список документа, затем исторические
 * роли (старые проекты и черновики), затем всё остальное.
 */
export function layerIds(doc: LaserDoc): string[] {
  const out: string[] = [];
  const push = (id: string) => {
    if (id && doc.layers[id] && !out.includes(id)) out.push(id);
  };
  for (const id of doc.layerOrder ?? []) push(id);
  for (const id of LAYER_ROLES) push(id);
  for (const id of Object.keys(doc.layers)) push(id);
  return out;
}

/**
 * Порядок слоёв для записи в файлы. У документов со своим списком слоёв он
 * совпадает с порядком в панели; у старых — исторический (сначала заливка и
 * разметка, контур в конце).
 */
export function exportLayerIds(doc: LaserDoc): string[] {
  if (doc.layerOrder?.length) return layerIds(doc);
  return LASER_LAYER_ORDER.filter((id) => doc.layers[id]);
}

/**
 * Конфигурация слоя с безопасным запасом: объект на неизвестном слое (старый
 * проект, файл генератора) не теряется при показе и экспорте.
 */
export function layerOf(doc: LaserDoc, id: string): LaserLayerConfig {
  const own = doc.layers[id];
  if (own) return own;
  const legacy = DEFAULT_LASER_LAYERS[id];
  if (legacy) return legacy;
  const first = layerIds(doc)[0];
  return (first && doc.layers[first]) || DEFAULT_LASER_LAYERS.cut;
}

/** Свободный идентификатор слоя: l1, l2, … */
export function uniqueLayerId(doc: LaserDoc, prefix = 'l'): string {
  let n = 1;
  while (doc.layers[`${prefix}${n}`]) n++;
  return `${prefix}${n}`;
}

/** Имя нового слоя — «Слой N» без повторов с уже существующими. */
export function nextLayerName(doc: LaserDoc): string {
  const ids = layerIds(doc);
  const used = new Set(ids.map((id) => (doc.layers[id].short || '').trim().toLowerCase()));
  let n = ids.length + 1;
  while (used.has(`слой ${n}`)) n++;
  return `Слой ${n}`;
}

/** Добавить слой в документ; возвращает новый документ и идентификатор слоя. */
export function addLaserLayer(
  doc: LaserDoc,
  name?: string,
  opts?: { mode?: LaserLayerConfig['mode']; color?: string }
): { doc: LaserDoc; id: string } {
  const ids = layerIds(doc);
  const id = uniqueLayerId(doc);
  const color = opts?.color ?? LAYER_PALETTE[ids.length % LAYER_PALETTE.length];
  const layer = makeLaserLayer(id, (name ?? '').trim() || nextLayerName(doc), color, opts?.mode ?? 'cut');
  return {
    doc: { ...doc, layers: { ...doc.layers, [id]: layer }, layerOrder: [...ids, id] },
    id,
  };
}

/** Удалить слой: его объекты переходят на первый оставшийся. */
export function removeLaserLayer(doc: LaserDoc, id: string): LaserDoc {
  const ids = layerIds(doc);
  if (ids.length <= 1 || !doc.layers[id]) return doc;
  const rest = ids.filter((x) => x !== id);
  const target = rest[0];
  const layers = { ...doc.layers };
  delete layers[id];
  return {
    ...doc,
    layers,
    layerOrder: rest,
    shapes: doc.shapes.map((s) => (s.layer === id ? { ...s, layer: target } : s)),
  };
}

/** Слой нужного режима: берём существующий или создаём свой. */
export function ensureModeLayer(
  doc: LaserDoc,
  mode: LaserLayerConfig['mode'],
  name?: string
): { doc: LaserDoc; id: string } {
  const hit = layerIds(doc).find((x) => doc.layers[x].mode === mode);
  if (hit) return { doc, id: hit };
  return addLaserLayer(doc, name, { mode });
}

/** Слой под роль линии генератора (контур, сгиб, заливка, размеры). */
export function ensureRoleLayer(doc: LaserDoc, role: LaserLayerRole): { doc: LaserDoc; id: string } {
  return ensureModeLayer(doc, LAYER_ROLE_MODE[role], role === 'guide' ? 'Размеры' : undefined);
}

/**
 * Раскладка «чужих» объектов по своим слоям документа.
 *
 * Генераторы (коробки, развёртки) и импорт файлов отдают объекты с ролями
 * cut/inner/fold/score/engrave/guide и, если файл содержал имена слоёв, с
 * полем `layerName`. Здесь роли и имена превращаются в слои чертежа: слой с
 * таким именем ищется или создаётся, иначе объект уходит на слой с подходящим
 * режимом линии. Поле `layerName` после этого снимается — в проекте оно не
 * хранится.
 */
export function adoptShapes(doc: LaserDoc, shapes: LaserShape[]): { doc: LaserDoc; shapes: LaserShape[] } {
  let d = doc;
  const byKey = new Map<string, string>();
  const out: LaserShape[] = [];
  for (const s of shapes) {
    const srcName = (s.layerName ?? '').trim().slice(0, 60);
    const role = (LAYER_ROLES as string[]).includes(s.layer) ? (s.layer as LaserLayerRole) : null;
    const key = srcName ? `n:${srcName.toLowerCase()}` : `r:${role ?? s.layer}`;
    let id = byKey.get(key);
    if (!id) {
      if (srcName) {
        const hit = layerIds(d).find((x) => (d.layers[x].short || '').trim().toLowerCase() === srcName.toLowerCase());
        if (hit) {
          id = hit;
        } else {
          const res = addLaserLayer(d, srcName, { mode: LAYER_ROLE_MODE[role ?? 'cut'] });
          d = res.doc;
          id = res.id;
        }
      } else {
        const res = ensureRoleLayer(d, role ?? 'cut');
        d = res.doc;
        id = res.id;
      }
      byKey.set(key, id);
    }
    const copy = { ...s, layer: id } as LaserShape;
    delete (copy as { layerName?: string }).layerName;
    out.push(copy);
  }
  return { doc: d, shapes: out };
}


export interface MaterialPreset {
  id: string;
  name: string;
  thicknessMm: number;
  description: string;
  cutPower: number;
  cutSpeed: number;
  cutPasses: number;
  foldPower: number;
  foldSpeed: number;
  scorePower: number;
  scoreSpeed: number;
  engravePower: number;
  engraveSpeed: number;
  kerf: number;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: 'plywood-3',
    name: 'Фанера берёзовая 3 мм',
    thicknessMm: 3.0,
    description: 'Универсальная фанера ФК 3 мм для корпусов, коробок на шипах и лицевых панелей',
    cutPower: 85, cutSpeed: 16, cutPasses: 1,
    foldPower: 40, foldSpeed: 50,
    scorePower: 22, scoreSpeed: 110,
    engravePower: 30, engraveSpeed: 250,
    kerf: 0.12,
  },
  {
    id: 'plywood-4',
    name: 'Фанера 4 мм',
    thicknessMm: 4.0,
    description: 'Фанера ФК 4 мм для силовых каркасов и приборных стоек',
    cutPower: 90, cutSpeed: 12, cutPasses: 1,
    foldPower: 45, foldSpeed: 40,
    scorePower: 24, scoreSpeed: 100,
    engravePower: 32, engraveSpeed: 240,
    kerf: 0.14,
  },
  {
    id: 'plywood-6',
    name: 'Фанера 6 мм',
    thicknessMm: 6.0,
    description: 'Толстая фанера 6 мм (рекомендуется 2 прохода с обдувом)',
    cutPower: 95, cutSpeed: 10, cutPasses: 2,
    foldPower: 55, foldSpeed: 35,
    scorePower: 25, scoreSpeed: 90,
    engravePower: 35, engraveSpeed: 220,
    kerf: 0.16,
  },
  {
    id: 'acrylic-3',
    name: 'Акрил (оргстекло) 3 мм',
    thicknessMm: 3.0,
    description: 'Прозрачный или цветной литой акрил 3 мм — глянцевый край реза',
    cutPower: 80, cutSpeed: 12, cutPasses: 1,
    foldPower: 35, foldSpeed: 45,
    scorePower: 18, scoreSpeed: 120,
    engravePower: 26, engraveSpeed: 280,
    kerf: 0.1,
  },
  {
    id: 'cardboard-1.5',
    name: 'Картон / Гофрокартон 1.5 мм',
    thicknessMm: 1.5,
    description: 'Упаковочный и макетный картон для складных развёрток с биговкой',
    cutPower: 45, cutSpeed: 45, cutPasses: 1,
    foldPower: 18, foldSpeed: 80,
    scorePower: 14, scoreSpeed: 140,
    engravePower: 20, engraveSpeed: 300,
    kerf: 0.08,
  },
  {
    id: 'mdf-3',
    name: 'МДФ / ХДФ 3 мм',
    thicknessMm: 3.0,
    description: 'Плита МДФ 3 мм для технических шасси и шаблонов',
    cutPower: 88, cutSpeed: 14, cutPasses: 1,
    foldPower: 42, foldSpeed: 45,
    scorePower: 25, scoreSpeed: 100,
    engravePower: 32, engraveSpeed: 230,
    kerf: 0.13,
  },
  {
    id: 'pet-0.8',
    name: 'ПЭТ / Пластик 0.8 мм',
    thicknessMm: 0.8,
    description: 'Гибкий листовой пластик для трафаретов паяльной пасты и гибких кожухов',
    cutPower: 38, cutSpeed: 50, cutPasses: 1,
    foldPower: 16, foldSpeed: 90,
    scorePower: 12, scoreSpeed: 150,
    engravePower: 18, engraveSpeed: 300,
    kerf: 0.06,
  },
];

/** Узел векторного контура (с поддержкой рычагов кривых Безье — как в CorelDRAW) */
export interface PathNode {
  x: number;
  y: number;
  /** Входящая контрольная точка (относительно предыдущего сегмента) */
  cp1x?: number;
  cp1y?: number;
  /** Исходящая контрольная точка (к следующему сегменту) */
  cp2x?: number;
  cp2y?: number;
  /** Гладкий узел (рычаги коллинеарны) или угловой (cusp) */
  smooth?: boolean;
}

interface BaseShape {
  id: string;
  layer: LaserLayerId;
  name: string;
  groupId?: string;
  locked?: boolean;
  hidden?: boolean;
  /**
   * Имя слоя из исходного файла (DXF, SVG, PDF, EPS). Ставится только при
   * импорте: `adoptShapes` создаёт по нему свой слой и снимает поле.
   */
  layerName?: string;
  /** Число перемычек (holding tabs) на контуре, чтобы деталь не выпадала */
  tabs?: number;
  /** Ширина перемычки, мм */
  tabWidth?: number;
}

export interface RectShape extends BaseShape {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Радиус скругления углов, мм */
  rx: number;
  rot: number;
  filled: boolean;
}

export interface EllipseShape extends BaseShape {
  kind: 'ellipse';
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rot: number;
  /** Начальный и конечный угол (град) — для дуг и секторов (0..360 = полный эллипс) */
  startAngle: number;
  endAngle: number;
  filled: boolean;
}

export interface PolygonShape extends BaseShape {
  kind: 'polygon';
  cx: number;
  cy: number;
  r: number;
  sides: number;
  star: boolean;
  /** Отношение внутреннего радиуса звезды (0.15..0.95) */
  innerRatio: number;
  rot: number;
  filled: boolean;
}

export interface PathShape extends BaseShape {
  kind: 'path';
  nodes: PathNode[];
  /** Внутренние отверстия (например, после булева вычитания или трассировки) */
  holes?: PathNode[][];
  closed: boolean;
  filled: boolean;
}

export interface TextShape extends BaseShape {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  size: number;
  strokeWidth: number;
  rot: number;
  mirror: boolean;
  filled: boolean;
}

export interface DimShape extends BaseShape {
  kind: 'dim';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  offset: number;
  label?: string;
}

export type LaserShape =
  | RectShape
  | EllipseShape
  | PolygonShape
  | PathShape
  | TextShape
  | DimShape;

export interface LaserGroup {
  id: string;
  name: string;
}

export interface LaserDoc {
  name: string;
  /** Ширина рабочего поля лазерного станка, мм */
  w: number;
  /** Высота рабочего поля лазерного станка, мм */
  h: number;
  /** Толщина материала (для генератора развёрток и расчёта шипов), мм */
  materialThickness: number;
  materialPresetId: string;
  layers: Record<LaserLayerId, LaserLayerConfig>;
  /** Порядок слоёв в панели и в файлах; у старых документов может отсутствовать */
  layerOrder?: string[];
  shapes: LaserShape[];
  groups: LaserGroup[];
}

let seq = 1;
export function luid(prefix = 'ls'): string {
  return `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;
}

export function fmtMm(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits);
  return String(Object.is(r, -0) ? 0 : r);
}

/**
 * Новый документ чертежа: чистый лист и один свой слой «Слой 1».
 * Остальные слои пользователь добавляет сам (кнопка «+ Слой» в панели слева),
 * а генераторы коробок и развёрток создают нужные слои автоматически.
 */
export function newLaserDoc(w = 300, h = 200, name = 'Новый чертёж'): LaserDoc {
  const id = 'l1';
  return {
    name,
    w,
    h,
    materialThickness: 3.0,
    materialPresetId: 'plywood-3',
    layers: { [id]: makeLaserLayer(id, 'Слой 1', LAYER_PALETTE[0], 'cut') },
    layerOrder: [id],
    shapes: [],
    groups: [],
  };
}

/**
 * Документ с полным набором исторических слоёв — для станочного интерфейса и
 * проверок CAM. Свой порядок слоёв (`layerOrder`) здесь намеренно не задан:
 * тогда в файлы слои пишутся в историческом порядке (заливка и разметка
 * первыми, внешний контур в конце), а в панели — в удобном для чтения.
 */
export function newMachineDoc(w = 300, h = 200, name = 'Новый чертёж'): LaserDoc {
  const layers: Record<string, LaserLayerConfig> = {};
  for (const id of LAYER_ROLES) layers[id] = { ...DEFAULT_LASER_LAYERS[id] };
  return {
    name,
    w,
    h,
    materialThickness: 3.0,
    materialPresetId: 'plywood-3',
    layers,
    shapes: [],
    groups: [],
  };
}

/** Поворот точки вокруг центра (cx, cy) на угол rotDeg (в градусах) */
export function rotPt(p: Pt, cx: number, cy: number, rotDeg: number): Pt {
  if (!rotDeg) return { x: p.x, y: p.y };
  const a = (rotDeg * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const dx = p.x - cx, dy = p.y - cy;
  return {
    x: cx + dx * ca - dy * sa,
    y: cy + dx * sa + dy * ca,
  };
}

/** Вычисление кубической кривой Безье между двумя узлами PathNode */
export function sampleBezierSegment(a: PathNode, b: PathNode, steps = 20): Pt[] {
  const hasCp = (a.cp2x !== undefined && a.cp2y !== undefined) || (b.cp1x !== undefined && b.cp1y !== undefined);
  if (!hasCp) return [{ x: b.x, y: b.y }];
  const p0x = a.x, p0y = a.y;
  const p1x = a.cp2x ?? a.x, p1y = a.cp2y ?? a.y;
  const p2x = b.cp1x ?? b.x, p2y = b.cp1y ?? b.y;
  const p3x = b.x, p3y = b.y;
  const pts: Pt[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const x = mt * mt * mt * p0x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * p3x;
    const y = mt * mt * mt * p0y + 3 * mt * mt * t * p1y + 3 * mt * t * t * p2y + t * t * t * p3y;
    pts.push({ x, y });
  }
  return pts;
}

/** Развёртка цепочки узлов PathNode[] в полилинию Pt[] */
export function nodesToPts(nodes: PathNode[], closed: boolean, steps = 20): Pt[] {
  if (!nodes.length) return [];
  if (nodes.length === 1) return [{ x: nodes[0].x, y: nodes[0].y }];
  const pts: Pt[] = [{ x: nodes[0].x, y: nodes[0].y }];
  for (let i = 0; i < nodes.length - 1; i++) {
    pts.push(...sampleBezierSegment(nodes[i], nodes[i + 1], steps));
  }
  // замыкающий сегмент нужен и для кривой из двух узлов (линза, две дуги)
  if (closed && nodes.length > 1) {
    pts.push(...sampleBezierSegment(nodes[nodes.length - 1], nodes[0], steps));
  }
  return pts;
}

/** Преобразование любого объекта LaserShape в набор полилиний Pt[][] (для рендера, лазера, DXF, булевых операций) */
export function shapeToPolylines(shape: LaserShape): Pt[][] {
  switch (shape.kind) {
    case 'rect': {
      const { x, y, w, h,rot } = shape;
      const cx = x + w / 2, cy = y + h / 2;
      const r = Math.max(0, Math.min(shape.rx || 0, Math.min(w, h) / 2));
      const pts: Pt[] = [];
      if (r <= 1e-4) {
        pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y });
      } else {
        const segs = 10;
        const corners: { cx: number; cy: number; a0: number; a1: number }[] = [
          { cx: x + w - r, cy: y + r, a0: -Math.PI / 2, a1: 0 },
          { cx: x + w - r, cy: y + h - r, a0: 0, a1: Math.PI / 2 },
          { cx: x + r, cy: y + h - r, a0: Math.PI / 2, a1: Math.PI },
          { cx: x + r, cy: y + r, a0: Math.PI, a1: (3 * Math.PI) / 2 },
        ];
        for (const c of corners) {
          for (let i = 0; i <= segs; i++) {
            const a = c.a0 + ((c.a1 - c.a0) * i) / segs;
            pts.push({ x: c.cx + r * Math.cos(a), y: c.cy + r * Math.sin(a) });
          }
        }
        if (pts.length) pts.push({ ...pts[0] });
      }
      return [pts.map((p) => rotPt(p, cx, cy, rot))];
    }

    case 'ellipse': {
      const { cx, cy, rx, ry, rot, startAngle = 0, endAngle = 360 } = shape;
      const span = Math.abs(endAngle - startAngle);
      const isFull = span >= 359.99;
      const segs = Math.max(36, Math.min(180, Math.ceil(Math.max(rx, ry) * 3)));
      const pts: Pt[] = [];
      const a0 = (startAngle * Math.PI) / 180;
      const a1 = isFull ? a0 + Math.PI * 2 : (endAngle * Math.PI) / 180;
      for (let i = 0; i <= segs; i++) {
        const a = a0 + ((a1 - a0) * i) / segs;
        const p = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
        pts.push(rotPt(p, cx, cy, rot));
      }
      return [pts];
    }

    case 'polygon': {
      const { cx, cy, r, sides, star, innerRatio, rot } = shape;
      const n = Math.max(3, Math.min(64, Math.round(sides)));
      const total = star ? n * 2 : n;
      const ir = r * Math.max(0.1, Math.min(0.95, innerRatio || 0.45));
      const pts: Pt[] = [];
      for (let i = 0; i <= total; i++) {
        const idx = i % total;
        const rad = star && idx % 2 === 1 ? ir : r;
        const a = Math.PI / 2 + (idx * Math.PI * 2) / total + (rot * Math.PI) / 180;
        pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
      }
      return [pts];
    }

    case 'path': {
      const main = nodesToPts(shape.nodes, shape.closed);
      const res: Pt[][] = main.length ? [main] : [];
      for (const h of shape.holes ?? []) {
        const hp = nodesToPts(h, true);
        if (hp.length) res.push(hp);
      }
      return res;
    }

    case 'text': {
      const a = (shape.rot * Math.PI) / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      const raw = textPolylines(shape.text || '');
      return raw.map((seg) =>
        seg.map((p) => {
          const lx = (shape.mirror ? -p.x : p.x) * (shape.size / 10);
          const ly = p.y * (shape.size / 10);
          return {
            x: shape.x + lx * ca - ly * sa,
            y: shape.y + lx * sa + ly * ca,
          };
        })
      );
    }

    case 'dim': {
      const { x1, y1, x2, y2, offset } = shape;
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const p1 = { x: x1 + nx * offset, y: y1 + ny * offset };
      const p2 = { x: x2 + nx * offset, y: y2 + ny * offset };
      return [
        [{ x: x1, y: y1 }, p1],
        [{ x: x2, y: y2 }, p2],
        [p1, p2],
      ];
    }
  }
}

/** Преобразовать любой примитив в редактируемую кривую (CorelDRAW Convert to Curves — Ctrl+Q) */
export function shapeToPath(shape: LaserShape): PathShape[] {
  if (shape.kind === 'path') return [shape];
  if (shape.kind === 'rect') {
    const poly = shapeToPolylines(shape)[0] ?? [];
    if (poly.length > 1) poly.pop(); // убрать дубликат первой точки
    return [{
      id: shape.id,
      kind: 'path',
      layer: shape.layer,
      name: `${shape.name} (кривая)`,
      groupId: shape.groupId,
      nodes: poly.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      filled: shape.filled,
      tabs: shape.tabs,
      tabWidth: shape.tabWidth,
    }];
  }
  if (shape.kind === 'ellipse') {
    const span = Math.abs((shape.endAngle ?? 360) - (shape.startAngle ?? 0));
    if (span >= 359.99) {
      // Точное представление эллипса 4 кубическими кривыми Безье (k ≈ 0.55228475)
      const k = 0.5522847498;
      const { cx, cy, rx, ry, rot } = shape;
      const rawNodes: PathNode[] = [
        { x: cx + rx, y: cy, cp1x: cx + rx, cp1y: cy - ry * k, cp2x: cx + rx, cp2y: cy + ry * k, smooth: true },
        { x: cx, y: cy + ry, cp1x: cx + rx * k, cp1y: cy + ry, cp2x: cx - rx * k, cp2y: cy + ry, smooth: true },
        { x: cx - rx, y: cy, cp1x: cx - rx, cp1y: cy + ry * k, cp2x: cx - rx, cp2y: cy - ry * k, smooth: true },
        { x: cx, y: cy - ry, cp1x: cx - rx * k, cp1y: cy - ry, cp2x: cx + rx * k, cp2y: cy - ry, smooth: true },
      ].map((n) => {
        const p = rotPt({ x: n.x, y: n.y }, cx, cy, rot);
        const c1 = rotPt({ x: n.cp1x!, y: n.cp1y! }, cx, cy, rot);
        const c2 = rotPt({ x: n.cp2x!, y: n.cp2y! }, cx, cy, rot);
        return { x: p.x, y: p.y, cp1x: c1.x, cp1y: c1.y, cp2x: c2.x, cp2y: c2.y, smooth: true };
      });
      return [{
        id: shape.id,
        kind: 'path',
        layer: shape.layer,
        name: `${shape.name} (кривая)`,
        groupId: shape.groupId,
        nodes: rawNodes,
        closed: true,
        filled: shape.filled,
        tabs: shape.tabs,
        tabWidth: shape.tabWidth,
      }];
    }
    const poly = shapeToPolylines(shape)[0] ?? [];
    return [{
      id: shape.id,
      kind: 'path',
      layer: shape.layer,
      name: `${shape.name} (дуга)`,
      groupId: shape.groupId,
      nodes: poly.map((p) => ({ x: p.x, y: p.y })),
      closed: false,
      filled: false,
    }];
  }
  if (shape.kind === 'polygon') {
    const poly = shapeToPolylines(shape)[0] ?? [];
    if (poly.length > 1) poly.pop();
    return [{
      id: shape.id,
      kind: 'path',
      layer: shape.layer,
      name: `${shape.name} (кривая)`,
      groupId: shape.groupId,
      nodes: poly.map((p) => ({ x: p.x, y: p.y })),
      closed: true,
      filled: shape.filled,
      tabs: shape.tabs,
      tabWidth: shape.tabWidth,
    }];
  }
  // Для текста или размера — каждая полилиния становится отдельной кривой
  const polylines = shapeToPolylines(shape);
  return polylines.filter((pl) => pl.length >= 2).map((pl, idx) => ({
    id: idx === 0 ? shape.id : luid('path'),
    kind: 'path',
    layer: shape.layer,
    name: `${shape.name} #${idx + 1}`,
    groupId: shape.groupId,
    nodes: pl.map((p) => ({ x: p.x, y: p.y })),
    closed: false,
    filled: false,
  }));
}

/** Габаритный прямоугольник фигуры [minX, minY, maxX, maxY] */
export function shapeBBox(shape: LaserShape): [number, number, number, number] {
  const pls = shapeToPolylines(shape);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of pls) {
    for (const p of pl) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  if (!Number.isFinite(x0)) return [0, 0, 0, 0];
  return [x0, y0, x1, y1];
}

export function selectionBBox(shapes: LaserShape[]): [number, number, number, number] | null {
  if (!shapes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) {
    const [sx0, sy0, sx1, sy1] = shapeBBox(s);
    if (sx0 < x0) x0 = sx0;
    if (sy0 < y0) y0 = sy0;
    if (sx1 > x1) x1 = sx1;
    if (sy1 > y1) y1 = sy1;
  }
  if (!Number.isFinite(x0)) return null;
  return [x0, y0, x1, y1];
}

/** Расстояние от точки p до отрезка AB */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x, yi = ring[i].y;
    const xj = ring[j].x, yj = ring[j].y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Проверка попадания курсора в фигуру */
export function hitShape(shape: LaserShape, pt: Pt, tolMm = 1.5): boolean {
  const [x0, y0, x1, y1] = shapeBBox(shape);
  if (pt.x < x0 - tolMm || pt.x > x1 + tolMm || pt.y < y0 - tolMm || pt.y > y1 + tolMm) return false;
  const pls = shapeToPolylines(shape);
  for (const pl of pls) {
    if (pl.length === 1 && Math.hypot(pt.x - pl[0].x, pt.y - pl[0].y) <= tolMm) return true;
    for (let i = 0; i < pl.length - 1; i++) {
      if (distToSegment(pt, pl[i], pl[i + 1]) <= tolMm) return true;
    }
  }
  if ('filled' in shape && shape.filled && pls.length > 0 && pls[0].length >= 3) {
    if (pointInPolygon(pt, pls[0])) {
      // у кривой полилинии после первой — это отверстия: клик в отверстие не попадает
      if (shape.kind === 'path') {
        for (let i = 1; i < pls.length; i++) {
          if (pls[i].length >= 3 && pointInPolygon(pt, pls[i])) return false;
        }
      }
      return true;
    }
  }
  return false;
}

/** Перемещение фигуры на (dx, dy) */
export function translateShape(shape: LaserShape, dx: number, dy: number): LaserShape {
  switch (shape.kind) {
    case 'rect':
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case 'ellipse':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case 'polygon':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
    case 'path':
      return {
        ...shape,
        nodes: shape.nodes.map((n) => ({
          ...n,
          x: n.x + dx,
          y: n.y + dy,
          cp1x: n.cp1x !== undefined ? n.cp1x + dx : undefined,
          cp1y: n.cp1y !== undefined ? n.cp1y + dy : undefined,
          cp2x: n.cp2x !== undefined ? n.cp2x + dx : undefined,
          cp2y: n.cp2y !== undefined ? n.cp2y + dy : undefined,
        })),
        holes: shape.holes?.map((h) =>
          h.map((n) => ({
            ...n,
            x: n.x + dx,
            y: n.y + dy,
            cp1x: n.cp1x !== undefined ? n.cp1x + dx : undefined,
            cp1y: n.cp1y !== undefined ? n.cp1y + dy : undefined,
            cp2x: n.cp2x !== undefined ? n.cp2x + dx : undefined,
            cp2y: n.cp2y !== undefined ? n.cp2y + dy : undefined,
          }))
        ),
      };
    case 'text':
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case 'dim':
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
  }
}

/** Масштабирование фигуры относительно точки (ox, oy) */
export function scaleShape(shape: LaserShape, ox: number, oy: number, sx: number, sy: number): LaserShape {
  const scX = (x: number) => ox + (x - ox) * sx;
  const scY = (y: number) => oy + (y - oy) * sy;
  const avgS = (Math.abs(sx) + Math.abs(sy)) / 2;
  switch (shape.kind) {
    case 'rect': {
      if (Math.abs(shape.rot % 180) > 1e-3) {
        const asPath = shapeToPath(shape)[0];
        return scaleShape(asPath, ox, oy, sx, sy);
      }
      const nx1 = scX(shape.x), ny1 = scY(shape.y);
      const nx2 = scX(shape.x + shape.w), ny2 = scY(shape.y + shape.h);
      return {
        ...shape,
        x: Math.min(nx1, nx2),
        y: Math.min(ny1, ny2),
        w: Math.max(0.2, Math.abs(nx2 - nx1)),
        h: Math.max(0.2, Math.abs(ny2 - ny1)),
        rx: shape.rx * avgS,
      };
    }
    case 'ellipse': {
      const span = Math.abs((shape.endAngle ?? 360) - (shape.startAngle ?? 0));
      const isFull = span >= 359.99;
      const ax = Math.abs(sx), ay = Math.abs(sy);
      const uniform = Math.abs(ax - ay) < 1e-9;
      const mirrored = sx < 0 || sy < 0;
      const rotated = Math.abs(shape.rot % 180) > 1e-6;
      if (!uniform && (rotated || !isFull)) {
        // повёрнутый эллипс или дугу нельзя масштабировать неоднородно,
        // не раскрыв их в кривую — иначе геометрия уезжает
        const asPath = shapeToPath(shape)[0];
        return asPath ? scaleShape(asPath, ox, oy, sx, sy) : shape;
      }
      if (mirrored && !isFull) {
        const asPath = shapeToPath(shape)[0];
        return asPath ? scaleShape(asPath, ox, oy, sx, sy) : shape;
      }
      let rot = shape.rot;
      if (sx < 0 && sy < 0) rot += 180;
      else if (sx < 0) rot = 180 - rot;
      else if (sy < 0) rot = -rot;
      return {
        ...shape,
        cx: scX(shape.cx),
        cy: scY(shape.cy),
        rx: Math.max(0.2, shape.rx * ax),
        ry: Math.max(0.2, shape.ry * ay),
        rot: ((rot % 360) + 360) % 360,
      };
    }
    case 'polygon':
      return {
        ...shape,
        cx: scX(shape.cx),
        cy: scY(shape.cy),
        r: Math.max(0.5, shape.r * avgS),
      };
    case 'path':
      return {
        ...shape,
        nodes: shape.nodes.map((n) => ({
          ...n,
          x: scX(n.x),
          y: scY(n.y),
          cp1x: n.cp1x !== undefined ? scX(n.cp1x) : undefined,
          cp1y: n.cp1y !== undefined ? scY(n.cp1y) : undefined,
          cp2x: n.cp2x !== undefined ? scX(n.cp2x) : undefined,
          cp2y: n.cp2y !== undefined ? scY(n.cp2y) : undefined,
        })),
        holes: shape.holes?.map((h) =>
          h.map((n) => ({
            ...n,
            x: scX(n.x),
            y: scY(n.y),
            cp1x: n.cp1x !== undefined ? scX(n.cp1x) : undefined,
            cp1y: n.cp1y !== undefined ? scY(n.cp1y) : undefined,
            cp2x: n.cp2x !== undefined ? scX(n.cp2x) : undefined,
            cp2y: n.cp2y !== undefined ? scY(n.cp2y) : undefined,
          }))
        ),
      };
    case 'text':
      return {
        ...shape,
        x: scX(shape.x),
        y: scY(shape.y),
        size: Math.max(1, shape.size * avgS),
      };
    case 'dim':
      return {
        ...shape,
        x1: scX(shape.x1),
        y1: scY(shape.y1),
        x2: scX(shape.x2),
        y2: scY(shape.y2),
      };
  }
}

/** Поворот фигуры вокруг точки (ox, oy) на dAngleDeg градусов */
export function rotateShape(shape: LaserShape, ox: number, oy: number, dAngleDeg: number): LaserShape {
  const norm = (a: number) => (((a % 360) + 360) % 360);
  switch (shape.kind) {
    case 'rect': {
      const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
      const nc = rotPt({ x: cx, y: cy }, ox, oy, dAngleDeg);
      return { ...shape, x: nc.x - shape.w / 2, y: nc.y - shape.h / 2, rot: norm(shape.rot + dAngleDeg) };
    }
    case 'ellipse': {
      const nc = rotPt({ x: shape.cx, y: shape.cy }, ox, oy, dAngleDeg);
      return { ...shape, cx: nc.x, cy: nc.y, rot: norm(shape.rot + dAngleDeg) };
    }
    case 'polygon': {
      const nc = rotPt({ x: shape.cx, y: shape.cy }, ox, oy, dAngleDeg);
      return { ...shape, cx: nc.x, cy: nc.y, rot: norm(shape.rot + dAngleDeg) };
    }
    case 'path': {
      const rn = (n: PathNode): PathNode => {
        const p = rotPt({ x: n.x, y: n.y }, ox, oy, dAngleDeg);
        const c1 = n.cp1x !== undefined && n.cp1y !== undefined ? rotPt({ x: n.cp1x, y: n.cp1y }, ox, oy, dAngleDeg) : undefined;
        const c2 = n.cp2x !== undefined && n.cp2y !== undefined ? rotPt({ x: n.cp2x, y: n.cp2y }, ox, oy, dAngleDeg) : undefined;
        return { ...n, x: p.x, y: p.y, cp1x: c1?.x, cp1y: c1?.y, cp2x: c2?.x, cp2y: c2?.y };
      };
      return {
        ...shape,
        nodes: shape.nodes.map(rn),
        holes: shape.holes?.map((h) => h.map(rn)),
      };
    }
    case 'text': {
      const nc = rotPt({ x: shape.x, y: shape.y }, ox, oy, dAngleDeg);
      return { ...shape, x: nc.x, y: nc.y, rot: norm(shape.rot + dAngleDeg) };
    }
    case 'dim': {
      const p1 = rotPt({ x: shape.x1, y: shape.y1 }, ox, oy, dAngleDeg);
      const p2 = rotPt({ x: shape.x2, y: shape.y2 }, ox, oy, dAngleDeg);
      return { ...shape, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }
  }
}

/** Отразить фигуру по горизонтали ('h') или вертикали ('v') относительно (ox, oy) */
export function mirrorShape(shape: LaserShape, ox: number, oy: number, axis: 'h' | 'v'): LaserShape {
  if (shape.kind === 'text' && axis === 'h') {
    return { ...shape, x: 2 * ox - shape.x, mirror: !shape.mirror };
  }
  return scaleShape(shape, ox, oy, axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
}

// ---------------- Булевы операции и Контур (ClipperLib — как в CorelDRAW) ----------------

const CLIP_SCALE = 10000;

function shapeToClipperPaths(shape: LaserShape): Clipper.Paths {
  const pls = shapeToPolylines(shape);
  const paths: Clipper.Paths = [];
  for (let idx = 0; idx < pls.length; idx++) {
    const pl = pls[idx];
    if (pl.length < 3) continue;
    const path: Clipper.Path = pl.map((p) => ({
      X: Math.round(p.x * CLIP_SCALE),
      Y: Math.round(p.y * CLIP_SCALE),
    }));
    if (Math.abs(Clipper.Clipper.Area(path)) < 10) continue;
    // отверстия бывают только у кривой (path): у текста и размеров каждая
    // полилиния — самостоятельный контур, иначе булевы операции их дырявят
    const isHole = shape.kind === 'path' && idx > 0;
    const orient = Clipper.Clipper.Orientation(path);
    if (!isHole && !orient) path.reverse();
    if (isHole && orient) path.reverse();
    paths.push(path);
  }
  return paths;
}

function polyTreeToShapes(tree: Clipper.PolyTree, base: LaserShape, opLabel: string): PathShape[] {
  const results: PathShape[] = [];
  const visitNode = (node: Clipper.PolyNode) => {
    if (!node.IsHole() && node.Contour().length >= 3) {
      const outer: PathNode[] = node.Contour().map((pt) => ({
        x: pt.X / CLIP_SCALE,
        y: pt.Y / CLIP_SCALE,
      }));
      const holes: PathNode[][] = [];
      for (const child of node.Childs()) {
        if (child.Contour().length >= 3) {
          holes.push(
            child.Contour().map((pt) => ({
              x: pt.X / CLIP_SCALE,
              y: pt.Y / CLIP_SCALE,
            }))
          );
        }
        for (const grandChild of child.Childs()) {
          visitNode(grandChild);
        }
      }
      results.push({
        id: results.length === 0 ? base.id : luid('bool'),
        kind: 'path',
        layer: base.layer,
        name: `${base.name} (${opLabel})`,
        nodes: outer,
        holes: holes.length ? holes : undefined,
        closed: true,
        filled: 'filled' in base ? base.filled : false,
        tabs: base.tabs,
        tabWidth: base.tabWidth,
      });
    } else {
      for (const child of node.Childs()) visitNode(child);
    }
  };
  for (const child of tree.Childs()) visitNode(child);
  return results;
}

export type BooleanOp = 'union' | 'subtract' | 'intersect' | 'xor';

/**
 * Булевы операции CorelDRAW:
 * - union: Объединение (Weld)
 * - subtract: Вычитание из первой фигуры всех последующих (Trim)
 * - intersect: Пересечение (Intersect)
 * - xor: Исключение (Simplify / XOR)
 */
export function booleanShapes(shapes: LaserShape[], op: BooleanOp): PathShape[] {
  if (shapes.length < 2) return [];
  const subj = shapeToClipperPaths(shapes[0]);
  if (!subj.length) return [];

  const clip: Clipper.Paths = [];
  for (let i = 1; i < shapes.length; i++) {
    clip.push(...shapeToClipperPaths(shapes[i]));
  }
  if (!clip.length) return [];

  const c = new Clipper.Clipper();
  c.AddPaths(subj, Clipper.PolyType.ptSubject, true);
  c.AddPaths(clip, Clipper.PolyType.ptClip, true);

  const clipType =
    op === 'union'
      ? Clipper.ClipType.ctUnion
      : op === 'subtract'
        ? Clipper.ClipType.ctDifference
        : op === 'intersect'
          ? Clipper.ClipType.ctIntersection
          : Clipper.ClipType.ctXor;

  const tree = new Clipper.PolyTree();
  c.Execute(clipType, tree, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);

  const label =
    op === 'union' ? 'объединение' : op === 'subtract' ? 'вычитание' : op === 'intersect' ? 'пересечение' : 'исключение';
  return polyTreeToShapes(tree, shapes[0], label);
}

/**
 * Построение эквидистанты / контура с отступом (CorelDRAW Contour + компенсация реза лазера Kerf).
 * Положительный deltaMm — наружу, отрицательный — внутрь.
 */
export function offsetShape(shape: LaserShape, deltaMm: number, targetLayer?: LaserLayerId): PathShape[] {
  if (Math.abs(deltaMm) < 1e-4) return shapeToPath(shape);
  const paths = shapeToClipperPaths(shape);
  if (!paths.length) return [];
  const co = new Clipper.ClipperOffset(2, 0.01 * CLIP_SCALE);
  co.AddPaths(paths, Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon);
  const tree = new Clipper.PolyTree();
  co.Execute(tree, Math.round(deltaMm * CLIP_SCALE));
  const res = polyTreeToShapes(tree, shape, `контур ${deltaMm > 0 ? '+' : ''}${fmtMm(deltaMm)} мм`);
  return res.map((s) => ({
    ...s,
    id: luid('cnt'),
    layer: targetLayer ?? shape.layer,
  }));
}

// ---------------- пунктир, перемычки и компенсация керфа ----------------
// Один и тот же код используют рендер, DXF, SVG и G-Code: маркеры перемычек на
// экране обязаны совпадать с тем, где станок реально оставит недорез.

/** Длина полилинии, мм. */
export function polylineLength(pts: Pt[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  return total;
}

/**
 * Суммарная длина видимых контуров документа в миллиметрах.
 *
 * Считает только то, что реально попадёт в чертёж: скрытые объекты и объекты
 * выключенных слоёв пропускаются. Используется там, где нужна оценка длины реза
 * без станочных режимов — в статус-баре редактора и в диалоге экспорта.
 */
export function docContourLength(doc: LaserDoc): number {
  let total = 0;
  for (const s of doc.shapes) {
    if (s.hidden) continue;
    if (!doc.layers[s.layer]?.visible) continue;
    for (const pl of shapeToPolylines(s)) total += polylineLength(pl);
  }
  return total;
}

/**
 * Разбиение полилинии на штрихи: dashLen режем, gapLen пропускаем.
 * offset — фаза (сколько миллиметров первого штриха уже «пройдено»).
 */
export function dashPolyline(pts: Pt[], dashLen: number, gapLen: number, offset = 0): Pt[][] {
  if (pts.length < 2 || dashLen <= 0 || gapLen <= 0) return [pts];
  const out: Pt[][] = [];
  let cur: Pt[] = [{ ...pts[0] }];
  let drawing = true;
  let rem = Math.max(1e-9, dashLen - Math.max(0, Math.min(dashLen - 1e-9, offset)));
  let guard = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    let a = pts[i];
    const b = pts[i + 1];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-9) continue;
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;
    while (segLen > 1e-9 && guard++ < 200000) {
      if (segLen <= rem) {
        if (drawing) cur.push({ ...b });
        rem -= segLen;
        segLen = 0;
        if (rem <= 1e-9) {
          if (drawing && cur.length >= 2) out.push(cur);
          drawing = !drawing;
          rem = drawing ? dashLen : gapLen;
          if (drawing) cur = [{ ...b }];
        }
      } else {
        const mid = { x: a.x + ux * rem, y: a.y + uy * rem };
        if (drawing) {
          cur.push(mid);
          if (cur.length >= 2) out.push(cur);
        }
        segLen -= rem;
        a = mid;
        drawing = !drawing;
        rem = drawing ? dashLen : gapLen;
        if (drawing) cur = [{ ...a }];
      }
    }
  }
  if (drawing && cur.length >= 2) out.push(cur);
  return out;
}

/**
 * Интервалы перемычек (участки, где рез прерывается) вдоль замкнутого контура.
 * Перемычки расставлены по центрам шагов — так же их рисует холст и режет станок.
 */
export function tabGaps(totalLen: number, count: number, width: number): { start: number; end: number }[] {
  if (!count || count <= 0 || totalLen <= 0) return [];
  const pitch = totalLen / count;
  if (pitch <= width * 1.5) return []; // перемычки не помещаются в шаг
  const half = width / 2;
  const gaps: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    const c = pitch * (i + 0.5);
    gaps.push({ start: c - half, end: c + half });
  }
  return gaps;
}

/** Замкнута ли полилиния (первая точка совпадает с последней). */
export function isClosedRing(pts: Pt[]): boolean {
  if (pts.length < 3) return false;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9;
}

/** Замкнуть полилинию, если концы не совпадают. */
export function ensureClosedRing(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) > 1e-9 ? [...pts, { ...a }] : pts;
}

/**
 * Перемычки (holding tabs) на контуре: возвращает участки реза.
 * Общая реализация для DXF, G-Code, симуляции и маркеров на холсте.
 */
export function applyTabs(pts: Pt[], count: number, width = 1.8, closed = true): Pt[][] {
  if (!count || count <= 0 || pts.length < 2) return [pts];
  const ring = closed ? ensureClosedRing(pts) : pts;
  const total = polylineLength(ring);
  const pitch = total / count;
  if (pitch <= width * 1.5) return [pts];
  return dashPolyline(ring, pitch - width, width, pitch / 2 - width / 2);
}

/** Замкнутый ли контур у фигуры (важно для компенсации керфа). */
export function isClosedShape(shape: LaserShape): boolean {
  switch (shape.kind) {
    case 'rect':
    case 'polygon':
      return true;
    case 'ellipse':
      return Math.abs((shape.endAngle ?? 360) - (shape.startAngle ?? 0)) >= 359.99;
    case 'path':
      return !!shape.closed;
    default:
      return false; // текст и размеры — открытые штрихи
  }
}

/**
 * Компенсация толщины луча (kerf). Открытые контуры смещать нельзя: эквидистанта
 * превращает отрезок в замкнутую «таблетку» (или вовсе его теряет), поэтому
 * линии режутся как есть, а замкнутые контуры — со сдвигом на половину керфа.
 */
export function kerfShapes(shape: LaserShape, deltaMm: number): LaserShape[] {
  if (Math.abs(deltaMm) < 1e-4 || !isClosedShape(shape)) return [shape];
  const out = offsetShape(shape, deltaMm);
  return out.length ? out : [shape];
}

/** Скругление углов контура (Fillet) заданным радиусом radiusMm */
export function filletShapeCorners(shape: LaserShape, radiusMm: number): LaserShape {
  const r = Math.max(0, radiusMm);
  if (shape.kind === 'rect') {
    return { ...shape, rx: r };
  }
  let pathShape = shapeToPath(shape)[0];
  if (!pathShape || pathShape.nodes.length < 3) return shape;
  // у кривой с рычагами Безье узлы не совпадают с контуром: сначала раскрываем
  // её в ломаную, иначе старые рычаги искривят скруглённый контур
  const curved = pathShape.nodes.some(
    (n) => n.cp1x !== undefined || n.cp1y !== undefined || n.cp2x !== undefined || n.cp2y !== undefined
  );
  if (curved) {
    const flat = nodesToPts(pathShape.nodes, pathShape.closed, 24);
    if (pathShape.closed && flat.length > 1) flat.pop();
    pathShape = { ...pathShape, nodes: flat.map((q) => ({ x: q.x, y: q.y })) };
  }
  if (pathShape.nodes.length < 3) return shape;
  const pts = pathShape.nodes;
  const n = pts.length;
  const out: PathNode[] = [];
  const segs = 6;
  for (let i = 0; i < n; i++) {
    if (!pathShape.closed && (i === 0 || i === n - 1)) {
      out.push({ ...pts[i] });
      continue;
    }
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];
    const v1x = prev.x - curr.x, v1y = prev.y - curr.y;
    const v2x = next.x - curr.x, v2y = next.y - curr.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-3 || l2 < 1e-3 || r <= 1e-3) {
      out.push({ ...curr });
      continue;
    }
    const u1x = v1x / l1, u1y = v1y / l1;
    const u2x = v2x / l2, u2y = v2y / l2;
    const dot = Math.max(-0.999, Math.min(0.999, u1x * u2x + u1y * u2y));
    const angle = Math.acos(dot);
    const tanHalf = Math.tan(angle / 2);
    if (tanHalf < 1e-3) {
      out.push({ ...curr });
      continue;
    }
    const cutDist = Math.min(r / tanHalf, l1 * 0.45, l2 * 0.45);
    const effR = cutDist * tanHalf;
    const pStart = { x: curr.x + u1x * cutDist, y: curr.y + u1y * cutDist };
    const pEnd = { x: curr.x + u2x * cutDist, y: curr.y + u2y * cutDist };
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const mt = 1 - t;
      // Квадратичная аппроксимация дуги через вершину с весом
      const bx = mt * mt * pStart.x + 2 * mt * t * curr.x + t * t * pEnd.x;
      const by = mt * mt * pStart.y + 2 * mt * t * curr.y + t * t * pEnd.y;
      if (effR > 0) out.push({ x: bx, y: by });
    }
  }
  return { ...pathShape, nodes: out };
}

export type AlignMode = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom' | 'page-center' | 'distribute-x' | 'distribute-y';

/** Выравнивание и распределение объектов (CorelDRAW Align & Distribute) */
export function alignShapes(
  shapes: LaserShape[],
  selectedIds: Set<string>,
  mode: AlignMode,
  sheetW: number,
  sheetH: number
): LaserShape[] {
  const sel = shapes.filter((s) => selectedIds.has(s.id));
  if (!sel.length) return shapes;

  if (mode === 'page-center') {
    const bb = selectionBBox(sel);
    if (!bb) return shapes;
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const dx = sheetW / 2 - cx, dy = sheetH / 2 - cy;
    return shapes.map((s) => (selectedIds.has(s.id) ? translateShape(s, dx, dy) : s));
  }

  const bb = sel.length === 1 ? [0, 0, sheetW, sheetH] as [number, number, number, number] : selectionBBox(sel)!;

  if (mode === 'distribute-x' && sel.length >= 3) {
    const items = sel.map((s) => {
      const b = shapeBBox(s);
      return { s, b, cx: (b[0] + b[2]) / 2 };
    }).sort((a, b) => a.cx - b.cx);
    const minC = items[0].cx, maxC = items[items.length - 1].cx;
    const step = (maxC - minC) / (items.length - 1);
    const deltaMap = new Map<string, number>();
    items.forEach((it, idx) => deltaMap.set(it.s.id, minC + idx * step - it.cx));
    return shapes.map((s) => (deltaMap.has(s.id) ? translateShape(s, deltaMap.get(s.id)!, 0) : s));
  }

  if (mode === 'distribute-y' && sel.length >= 3) {
    const items = sel.map((s) => {
      const b = shapeBBox(s);
      return { s, b, cy: (b[1] + b[3]) / 2 };
    }).sort((a, b) => a.cy - b.cy);
    const minC = items[0].cy, maxC = items[items.length - 1].cy;
    const step = (maxC - minC) / (items.length - 1);
    const deltaMap = new Map<string, number>();
    items.forEach((it, idx) => deltaMap.set(it.s.id, minC + idx * step - it.cy));
    return shapes.map((s) => (deltaMap.has(s.id) ? translateShape(s, 0, deltaMap.get(s.id)!) : s));
  }

  return shapes.map((s) => {
    if (!selectedIds.has(s.id)) return s;
    const sb = shapeBBox(s);
    let dx = 0, dy = 0;
    if (mode === 'left') dx = bb[0] - sb[0];
    else if (mode === 'right') dx = bb[2] - sb[2];
    else if (mode === 'center-x') dx = (bb[0] + bb[2]) / 2 - (sb[0] + sb[2]) / 2;
    else if (mode === 'bottom') dy = bb[1] - sb[1];
    else if (mode === 'top') dy = bb[3] - sb[3];
    else if (mode === 'center-y') dy = (bb[1] + bb[3]) / 2 - (sb[1] + sb[3]) / 2;
    return translateShape(s, dx, dy);
  });
}

/** Размножение массивом (Step & Repeat — сетка rows × cols с зазором gapX, gapY мм) */
export function arrayShapes(
  selected: LaserShape[],
  rows: number,
  cols: number,
  gapX: number,
  gapY: number
): LaserShape[] {
  const bb = selectionBBox(selected);
  if (!bb) return [];
  const w = bb[2] - bb[0], h = bb[3] - bb[1];
  const copies: LaserShape[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const dx = c * (w + gapX);
      const dy = r * (h + gapY);
      const newGroupId = selected.some((s) => s.groupId) ? luid('grp') : undefined;
      for (const s of selected) {
        const moved = translateShape(s, dx, dy);
        copies.push({
          ...moved,
          id: luid(s.kind),
          name: `${s.name} [${r + 1},${c + 1}]`,
          groupId: s.groupId ? newGroupId : undefined,
        });
      }
    }
  }
  return copies;
}

/**
 * Автоматическая компактная раскладка деталей на листе лазера (Auto-Nesting).
 * Группирует связанные элементы (или сгруппированные детали) и раскладывает
 * их на листе с отступом marginMm от края и зазором gapMm между деталями.
 */
export interface NestResult {
  shapes: LaserShape[];
  /** Все ли детали поместились на лист */
  fits: boolean;
  /** Насколько раскладка вышла за лист по X и Y, мм */
  overflowMm: [number, number];
  /** Сколько полок (рядов) заняла раскладка */
  rows: number;
}

export function autoNestShapesEx(
  shapes: LaserShape[],
  sheetW: number,
  sheetH: number,
  marginMm = 5,
  gapMm = 3
): NestResult {
  if (!shapes.length) return { shapes, fits: true, overflowMm: [0, 0], rows: 0 };
  // Объединяем фигуры по groupId (или с вложенными отверстиями внутри внешнего контура)
  const clusters: { ids: Set<string>; shapes: LaserShape[]; bb: [number, number, number, number] }[] = [];
  const assigned = new Set<string>();

  // 1. Сначала по groupId
  const byGroup = new Map<string, LaserShape[]>();
  for (const s of shapes) {
    if (s.groupId) {
      const list = byGroup.get(s.groupId) ?? [];
      list.push(s);
      byGroup.set(s.groupId, list);
      assigned.add(s.id);
    }
  }
  for (const [, list] of byGroup) {
    const bb = selectionBBox(list);
    if (bb) clusters.push({ ids: new Set(list.map((x) => x.id)), shapes: list, bb });
  }

  // 2. Оставшиеся фигуры: вложенные (например отверстия внутри панели) привязываем к внешнему контуру
  const remaining = shapes.filter((s) => !assigned.has(s.id));
  const remWithBB = remaining.map((s) => ({ s, bb: shapeBBox(s) }));
  remWithBB.sort((a, b) => (b.bb[2] - b.bb[0]) * (b.bb[3] - b.bb[1]) - (a.bb[2] - a.bb[0]) * (a.bb[3] - a.bb[1]));

  for (const item of remWithBB) {
    if (assigned.has(item.s.id)) continue;
    const parentCluster = clusters.find(
      (cl) =>
        item.bb[0] >= cl.bb[0] - 0.5 &&
        item.bb[1] >= cl.bb[1] - 0.5 &&
        item.bb[2] <= cl.bb[2] + 0.5 &&
        item.bb[3] <= cl.bb[3] + 0.5
    );
    if (parentCluster) {
      parentCluster.shapes.push(item.s);
      parentCluster.ids.add(item.s.id);
      assigned.add(item.s.id);
    } else {
      clusters.push({
        ids: new Set([item.s.id]),
        shapes: [item.s],
        bb: item.bb,
      });
      assigned.add(item.s.id);
    }
  }

  // Сортируем детали по высоте по убыванию (алгоритм Shelf Bin Packing)
  clusters.sort((a, b) => (b.bb[3] - b.bb[1]) - (a.bb[3] - a.bb[1]));

  let curX = marginMm;
  let curY = marginMm;
  let shelfH = 0;
  let rows = 1;
  let usedX = 0;
  let usedY = 0;
  const maxW = Math.max(marginMm * 2, sheetW - marginMm);

  const deltaById = new Map<string, Pt>();
  for (const cl of clusters) {
    const w = cl.bb[2] - cl.bb[0];
    const h = cl.bb[3] - cl.bb[1];
    if (curX > marginMm && curX + w > maxW) {
      curX = marginMm;
      curY += shelfH + gapMm;
      shelfH = 0;
      rows += 1;
    }
    const dx = curX - cl.bb[0];
    const dy = curY - cl.bb[1];
    for (const id of cl.ids) deltaById.set(id, { x: dx, y: dy });
    curX += w + gapMm;
    if (h > shelfH) shelfH = h;
    if (curX - gapMm > usedX) usedX = curX - gapMm;
    if (curY + shelfH > usedY) usedY = curY + shelfH;
  }

  const placed = shapes.map((s) => {
    const d = deltaById.get(s.id);
    return d ? translateShape(s, d.x, d.y) : s;
  });
  const overflowX = Math.max(0, usedX - (sheetW - marginMm));
  const overflowY = Math.max(0, usedY - (sheetH - marginMm));
  return { shapes: placed, fits: overflowX < 1e-6 && overflowY < 1e-6, overflowMm: [overflowX, overflowY], rows };
}

export function autoNestShapes(
  shapes: LaserShape[],
  sheetW: number,
  sheetH: number,
  marginMm = 5,
  gapMm = 3
): LaserShape[] {
  return autoNestShapesEx(shapes, sheetW, sheetH, marginMm, gapMm).shapes;
}
