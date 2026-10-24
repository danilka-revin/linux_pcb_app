// Конструктор коробок для лазерной резки: компактный движок соединений
// (шип-паз и «ласточкин хвост»), каталог параметрических генераторов,
// раскладка деталей на лист и проекция сборки для 3D-просмотра.
//
// Модель параметров повторяет привычные онлайн-генераторы (boxes.py и подобные):
// x/y/h — внутренние размеры, thickness — толщина материала, finger/play/burn —
// посадка шипов, surroundings — чем начинается кромка, edge_width — отступ у края.
// Главное отличие — вывод в точный DXF (`./dxf`) и готовая 3D-сборка.

import { autoNestShapes, luid, type LaserGroup, type LaserShape, type Pt } from './model';
import { textPolylines } from '../pcb/strokefont';

export type Vec3 = [number, number, number];
/** Вид шипа: прямоугольный шип-паз или «ласточкин хвост» */
export type JointStyle = 'finger' | 'dovetail';
/** Как обработана кромка детали: шипы наружу, пазы внутрь, ровно, никак */
export type EdgeKind = 'male' | 'female' | 'flat' | 'none';

export interface JointOpts {
  /** Толщина материала, мм */
  thickness: number;
  /** Ширина шипа, мм */
  finger: number;
  /** Монтажный люфт: паз шире шипа на 2·play, мм */
  play: number;
  /** Вид шипа */
  style: JointStyle;
  /** Угол наклона стенки «ласточкина хвоста», град */
  angle: number;
  /** Отступ от края кромки до первого паза, мм */
  edgeWidth: number;
  /** Чем начинается кромка: шип или пробел (0/1) */
  surroundings: number;
  /** Удлинение шипа наружу под шлифовку обгорелых торцов, мм */
  extra: number;
  /** Коррекция реза: на столько расширяются пазы и отверстия, мм */
  burn: number;
}

export const DEFAULT_JOINT: JointOpts = {
  thickness: 4,
  finger: 12,
  play: 0.05,
  style: 'finger',
  angle: 45,
  edgeWidth: 0,
  surroundings: 0,
  extra: 0,
  burn: 0,
};

// ---------------- геометрия: мелкие помощники ----------------

const EPS = 0.02;

/** Убрать повторяющиеся соседние точки (и замыкающий дубль у контура). */
export function dedupe(pts: Pt[], closed = false): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > EPS) out.push({ x: p.x, y: p.y });
  }
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS) out.pop();
  }
  return out;
}

const ccwArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return a / 2;
};

/** Площадь контура (со знаком: минус — обход по часовой). */
export const contourArea = (pts: Pt[]) => Math.abs(ccwArea(pts));

/** Габарит набора точек. */
export function ptsBBox(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return [x0, y0, x1, y1];
}

/** Длина ломаной. */
export function polyLength(pts: Pt[], closed = false): number {
  let l = 0;
  for (let i = 0; i < pts.length - 1; i++) l += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  if (closed && pts.length > 2) l += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return l;
}

/** Окружность точками (для отверстий, которые нельзя дать кругом). */
export function circlePts(cx: number, cy: number, r: number, segs = 0): Pt[] {
  const n = segs > 2 ? Math.round(segs) : Math.max(24, Math.min(180, Math.ceil(r * 4)));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Прямоугольник, при r > 0 — со скруглёнными углами. */
export function rectPts(x: number, y: number, w: number, h: number, r = 0): Pt[] {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2 - 0.01));
  if (rr <= 0.01) return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  // Дуга угла шестью отрезками: для DXF этого достаточно при допуске 0.01 мм
  const seg = (cx: number, cy: number, a0: number): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 1; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
    }
    return pts;
  };
  return [
    { x: x + rr, y }, { x: x + w - rr, y },
    ...seg(x + w - rr, y + rr, -Math.PI / 2),
    { x: x + w, y: y + h - rr },
    ...seg(x + w - rr, y + h - rr, 0),
    { x: x + rr, y: y + h },
    ...seg(x + rr, y + h - rr, Math.PI / 2),
    { x, y: y + rr },
    ...seg(x + rr, y + rr, Math.PI),
  ];
}

/** Паз-«стадион» между двумя точками. */
export function slotPts(x1: number, y1: number, x2: number, y2: number, r: number): Pt[] {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return circlePts(x1, y1, r);
  const ux = dx / len, uy = dy / len;
  const nx = -uy, ny = ux;
  const arc = (cx: number, cy: number, a0: number): Pt[] => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = a0 + (i / 8) * Math.PI;
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
  };
  const a = Math.atan2(uy, ux);
  void nx; void ny;
  return dedupe([...arc(x2, y2, a), ...arc(x1, y1, a + Math.PI)], true);
}

/** Правильный многоугольник. */
export function polygonPts(cx: number, cy: number, r: number, sides: number, rot = 0): Pt[] {
  const n = Math.max(3, Math.round(sides));
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** Штриховая подпись (шрифт редактора, высота знака = size мм). */
export function labelStrokes(text: string, x: number, y: number, size = 5): Pt[][] {
  const k = size / 10;
  return textPolylines(text).map((s) => s.map((p) => ({ x: x + p.x * k, y: y + p.y * k })));
}

/** Сместить контур к центру/наружу простой «усадкой» к центроиду (для фасок). */
export function shrinkToCentroid(pts: Pt[], delta: number): Pt[] {
  if (!pts.length) return pts;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  return pts.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy) || 1e-9;
    const k = Math.max(0, (d - delta) / d);
    return { x: cx + dx * k, y: cy + dy * k };
  });
}

// ---------------- соединения: профиль кромки ----------------

/**
 * Профиль кромки в локальных координатах: от (0;0) до (len;0), материал со
 * стороны y < 0. Шипы выступают наружу (+y), пазы выбираются внутрь (−y).
 * Последняя точка (len;0) не возвращается — её добавит следующий участок.
 */
export function edgeProfile(len: number, kind: EdgeKind, o: JointOpts, trimStart = 0, trimEnd = 0): Pt[] {
  const t = Math.max(0.1, o.thickness);
  if (kind === 'flat' || kind === 'none' || len < t * 2) {
    return kind === 'none' ? [] : [{ x: 0, y: 0 }];
  }

  // Подрезка углов: в угловом квадрате t×t шипы не делаем, иначе они спорят
  // с шипами соседней кромки. Плюс отступ edgeWidth из настроек.
  const trim0 = Math.max(0, Math.min(trimStart, len / 3));
  const trim1 = Math.max(0, Math.min(trimEnd, len / 3));
  const edgeW = Math.max(0, Math.min(o.edgeWidth, len / 4));
  const inner = Math.max(t, len - 2 * edgeW - trim0 - trim1);
  const start = trim0 + (len - trim0 - trim1 - inner) / 2;
  const target = Math.max(t * 0.8, o.finger);

  // Число сегментов делаем нечётным, чтобы кромка была симметричной
  let n = Math.max(1, Math.round(inner / target));
  if (n % 2 === 0) n += 1;
  const seg = inner / n;
  // Шипы на нечётных сегментах; surroundings=1 сдвигает их на чётные
  const tabFirst = o.surroundings !== 1;

  // «Ласточкин хвост»: стенка шипа наклонена, поэтому к основанию он уже, чем к торцу
  const tanA = Math.tan((Math.max(5, Math.min(80, o.angle)) * Math.PI) / 180);
  const dove = o.style === 'dovetail' ? Math.min(seg * 0.35, t * tanA) : 0;

  const play = Math.max(0, o.play);
  const burn = Math.max(0, o.burn);
  const h = t + Math.max(0, o.extra);
  // Раструб «хвоста» не должен вылезать за пределы замка: в угловом квадрате
  // t×t уже стоит материал соседней детали. Так же поступают коробки boxes.py —
  // крайний хвост получается обрезанным по кромке.
  const lo = start;
  const hi = start + inner;
  const cl = (v: number) => Math.max(lo, Math.min(hi, v));
  const pts: Pt[] = [{ x: 0, y: 0 }];

  for (let i = 0; i < n; i++) {
    const x0 = start + i * seg;
    const x1 = start + (i + 1) * seg;
    const isTab = tabFirst ? i % 2 === 0 : i % 2 === 1;
    if (!isTab) { pts.push({ x: x1, y: 0 }); continue; }

    if (kind === 'male') {
      // Шип наружу: номинальная ширина, при «хвосте» — расширение к торцу
      pts.push(
        { x: cl(x0 + dove), y: 0 },
        { x: cl(x0 - dove), y: h },
        { x: cl(x1 + dove), y: h },
        { x: cl(x1 - dove), y: 0 }
      );
    } else {
      // Паз внутрь, шире шипа на люфт и коррекцию реза.
      // Для «ласточкина хвоста» паз идёт по внешнему контуру хвоста (без
      // сужения к зеву): у перпендикулярных деталей шип входит в паз по нормали
      // к кромке, и сужающийся паз физически не дал бы собрать угол. Хвост
      // при этом всё равно держит на отрыв там, где соединение собирается
      // сдвигом — U-образная коробка, выдвижной ящик, ласточкин хвост панели.
      const w = play * 2 + burn;
      pts.push(
        { x: cl(x0 - w / 2 - dove), y: 0 },
        { x: cl(x0 - w / 2 - dove), y: -h },
        { x: cl(x1 + w / 2 + dove), y: -h },
        { x: cl(x1 + w / 2 + dove), y: 0 }
      );
    }
    pts.push({ x: x1, y: 0 });
  }

  if (start + inner < len - EPS) pts.push({ x: len, y: 0 });
  return dedupe(pts);
}

/** Перенести локальный профиль на отрезок a→b; нормаль наружу — справа от хода. */
export function placeProfile(pts: Pt[], a: Pt, b: Pt): Pt[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return [];
  const ux = dx / len, uy = dy / len;
  const nx = uy, ny = -ux;
  return pts.map((p) => ({ x: a.x + ux * p.x + nx * p.y, y: a.y + uy * p.x + ny * p.y }));
}

/** Четыре кромки прямоугольной панели: низ, право, верх, лево. */
export type PanelEdges = [EdgeKind, EdgeKind, EdgeKind, EdgeKind];

/** Подрезка кромки с двух концов, мм: в углу t×t шипы не режутся. */
export type EdgeTrims = [number, number];

/** true — считать автоматически, false — без подрезки, массив — задать вручную. */
export type TrimSpec = boolean | EdgeTrims[];

/** Соединяется ли кромка шипами (нужен ли ответный профиль). */
export const jointedEdge = (k: EdgeKind) => k === 'male' || k === 'female';

const trimsOf = (spec: TrimSpec, i: number, n: number, kinds: EdgeKind[], t: number): EdgeTrims => {
  if (Array.isArray(spec)) return spec[i] ?? [0, 0];
  if (!spec) return [0, 0];
  return [
    jointedEdge(kinds[(i + n - 1) % n]) && jointedEdge(kinds[i]) ? t : 0,
    jointedEdge(kinds[i]) && jointedEdge(kinds[(i + 1) % n]) ? t : 0,
  ];
};

/**
 * Прямоугольная панель с соединениями по четырём сторонам.
 * Обход против часовой: материал внутри, шипы смотрят наружу.
 */
export function rectPanel(w: number, h: number, edges: PanelEdges, o: JointOpts, trim: TrimSpec = true): Pt[] {
  const c: Pt[] = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const t = Math.max(0.1, o.thickness);
  const out: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const len = i === 1 || i === 3 ? h : w;
    const [ts, te] = trimsOf(trim, i, 4, [...edges], t);
    out.push(...placeProfile(edgeProfile(len, edges[i], o, ts, te), a, b));
  }
  const clean = dedupe(out, true);
  // Гарантируем обход против часовой — от этого зависит «наружу» у шипов
  return ccwArea(clean) < 0 ? clean.reverse() : clean;
}

/** Панель произвольной формы (многоугольник) с соединениями по сторонам. */
export function polyPanel(corners: Pt[], edges: EdgeKind[], o: JointOpts, trim: TrimSpec = true): Pt[] {
  const t = Math.max(0.1, o.thickness);
  const kinds = corners.map((_, i) => edges[i] ?? ('flat' as EdgeKind));
  const out: Pt[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const [ts, te] = trimsOf(trim, i, corners.length, kinds, t);
    out.push(...placeProfile(edgeProfile(Math.hypot(b.x - a.x, b.y - a.y), kinds[i], o, ts, te), a, b));
  }
  const clean = dedupe(out, true);
  return ccwArea(clean) < 0 ? clean.reverse() : clean;
}

/** Живой шарнир: чередование прорезей, чтобы фанера гнулась. */
export function livingHinge(
  w: number,
  h: number,
  o: { slotW: number; step: number; bridge: number; rows?: number }
): { outline: Pt[]; holes: BoxHole[] } {
  const rows = Math.max(1, o.rows ?? Math.floor(h / Math.max(1, o.step)));
  const holes: BoxHole[] = [];
  for (let r = 0; r < rows; r++) {
    const y = ((r + 0.5) * h) / rows;
    const offset = r % 2 ? o.step / 2 : 0;
    for (let x = offset; x < w - o.slotW * 0.5; x += o.step) {
      const x0 = Math.max(o.bridge, x);
      const x1 = Math.min(w - o.bridge, x + o.slotW);
      if (x1 - x0 < 0.4) continue;
      holes.push({ t: 'poly', pts: rectPts(x0, y - 0.4, x1 - x0, 0.8, 0.4), closed: true });
    }
  }
  return { outline: rectPts(0, 0, w, h), holes };
}

// ---------------- детали и отверстия ----------------

/** Отверстие: точный круг (в DXF останется CIRCLE) или ломаная. */
export type BoxHole =
  | { t: 'circle'; cx: number; cy: number; r: number }
  | { t: 'poly'; pts: Pt[]; closed?: boolean };

/** Положение детали в сборке: начало координат и два базисных вектора. */
export interface Placement3D {
  o: Vec3;
  ex: Vec3;
  ey: Vec3;
}

export interface BoxPart {
  name: string;
  /** Замкнутый внешний контур в локальных координатах детали, мм */
  outline: Pt[];
  holes?: BoxHole[];
  /** Линии биговки/сгиба */
  score?: { pts: Pt[]; closed?: boolean }[];
  /** Гравировка (штрихи) */
  engrave?: Pt[][];
  /** Подпись детали (будет сущностью текста) */
  label?: { text: string; x: number; y: number; size: number };
  /** Где деталь стоит в собранном виде */
  place?: Placement3D;
  /** Сколько таких деталей нужно */
  count?: number;
  /** Деталь гнётся по биговке: в 3D показываем её плоской, это приближение */
  bend?: boolean;
  note?: string;
}

/** Деталь лежит в плоскости XY (дно, крышка). */
export const placeXY = (x: number, y: number, z: number): Placement3D => ({ o: [x, y, z], ex: [1, 0, 0], ey: [0, 1, 0] });
/** Деталь стоит в плоскости XZ (передняя/задняя стенка); mirror разворачивает вдоль X. */
export const placeXZ = (x: number, y: number, z: number, mirror = false): Placement3D => ({
  o: [x, y, z], ex: [mirror ? -1 : 1, 0, 0], ey: [0, 0, 1],
});
/** Деталь стоит в плоскости YZ (боковая стенка); mirror разворачивает вдоль Y. */
export const placeYZ = (x: number, y: number, z: number, mirror = false): Placement3D => ({
  o: [x, y, z], ex: [0, mirror ? -1 : 1, 0], ey: [0, 0, 1],
});

/** Сдвинуть все точки детали. */
export function shiftPts(pts: Pt[], dx: number, dy: number): Pt[] {
  return pts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

/** Габарит детали. */
export const partBBox = (p: BoxPart): [number, number, number, number] => {
  const bb = ptsBBox(p.outline);
  for (const h of p.holes ?? []) {
    if (h.t === 'poly') {
      const hb = ptsBBox(h.pts);
      bb[0] = Math.min(bb[0], hb[0]); bb[1] = Math.min(bb[1], hb[1]);
      bb[2] = Math.max(bb[2], hb[2]); bb[3] = Math.max(bb[3], hb[3]);
    } else {
      bb[0] = Math.min(bb[0], h.cx - h.r); bb[1] = Math.min(bb[1], h.cy - h.r);
      bb[2] = Math.max(bb[2], h.cx + h.r); bb[3] = Math.max(bb[3], h.cy + h.r);
    }
  }
  return bb;
};

/**
 * Подпись детали ставим в свободный угол: ищем точку внутри габарита,
 * максимально удалённую от контура (грубо — центр габарита, при неудаче угол).
 */
export function addLabel(part: BoxPart, on: boolean, text?: string): BoxPart {
  if (!on) return part;
  const bb = partBBox(part);
  const size = Math.max(3, Math.min(6, (bb[3] - bb[1]) / 12));
  const w = (text ?? part.name).length * size * 0.8;
  const x = Math.min(bb[0] + 4, Math.max(bb[0] + 1, (bb[0] + bb[2]) / 2 - w / 2));
  const y = bb[1] + 3;
  return { ...part, label: { text: text ?? part.name, x, y, size } };
}

// ---------------- параметры генераторов ----------------

export type BoxParamKind = 'number' | 'boolean' | 'select' | 'text';

export interface BoxParamDef {
  key: string;
  label: string;
  kind: BoxParamKind;
  def: number | boolean | string;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: { id: string; label: string }[];
  /** Раздел формы */
  group?: string;
  hint?: string;
  /** Показывать только в «дополнительных» настройках */
  advanced?: boolean;
}

export type BoxParamValues = Record<string, number | boolean | string>;

const num = (key: string, label: string, def: number, o: Omit<Partial<BoxParamDef>, 'kind' | 'key' | 'label' | 'def'> = {}): BoxParamDef => ({
  key, label, kind: 'number', def, ...o,
});
const bool = (key: string, label: string, def: boolean, o: Omit<Partial<BoxParamDef>, 'kind' | 'key' | 'label' | 'def'> = {}): BoxParamDef => ({
  key, label, kind: 'boolean', def, ...o,
});
const sel = (key: string, label: string, options: [string, string][], def: string, o: Omit<Partial<BoxParamDef>, 'kind' | 'key' | 'label' | 'def'> = {}): BoxParamDef => ({
  key, label, kind: 'select', def, options: options.map(([id, l]) => ({ id, label: l })), ...o,
});
const txt = (key: string, label: string, def: string, o: Omit<Partial<BoxParamDef>, 'kind' | 'key' | 'label' | 'def'> = {}): BoxParamDef => ({
  key, label, kind: 'text', def, ...o,
});

/** Общие параметры соединения (шип-паз / ласточкин хвост). */
export const JOINT_PARAMS: BoxParamDef[] = [
  num('thickness', 'Толщина материала', 4, { unit: 'мм', min: 0.5, max: 30, step: 0.1, group: 'Материал' }),
  sel('style', 'Вид шипа', [['finger', 'Шип-паз'], ['dovetail', 'Ласточкин хвост']], 'finger', { group: 'Соединение' }),
  num('finger', 'Ширина шипа', 12, { unit: 'мм', min: 2, max: 80, step: 0.5, group: 'Соединение' }),
  num('play', 'Люфт посадки', 0.05, { unit: 'мм', min: 0, max: 1, step: 0.01, group: 'Соединение', hint: 'Паз шире шипа на два люфта' }),
  num('angle', 'Угол хвоста', 45, { unit: '°', min: 10, max: 70, step: 1, group: 'Соединение', advanced: true }),
  num('edgeWidth', 'Отступ от края', 0, { unit: 'мм', min: 0, max: 40, step: 0.5, group: 'Соединение', advanced: true, hint: 'Сплошная полоса в начале и конце кромки' }),
  sel('surroundings', 'Начало кромки', [['0', 'С шипа'], ['1', 'С пробела']], '0', { group: 'Соединение', advanced: true }),
  num('extra', 'Удлинение шипа', 0, { unit: 'мм', min: 0, max: 5, step: 0.1, group: 'Соединение', advanced: true, hint: 'Выпуск под шлифовку обгорелых торцов' }),
  num('burn', 'Коррекция реза', 0, { unit: 'мм', min: 0, max: 1, step: 0.01, group: 'Соединение', advanced: true, hint: 'Расширяет пазы и отверстия: больше — свободнее посадка' }),
  bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
  bool('reference', 'Эталонный прямоугольник', false, { group: 'Вывод', advanced: true, hint: 'Добавить прямоугольник заданной длины для проверки масштаба' }),
  num('referenceLen', 'Длина эталона', 100, { unit: 'мм', min: 10, max: 500, step: 1, group: 'Вывод', advanced: true }),
];

/** Размеры коробки: x — ширина, y — глубина, h — высота. */
export const SIZE_PARAMS: BoxParamDef[] = [
  num('x', 'Ширина (X)', 120, { unit: 'мм', min: 10, max: 2000, step: 1, group: 'Размеры' }),
  num('y', 'Глубина (Y)', 80, { unit: 'мм', min: 10, max: 2000, step: 1, group: 'Размеры' }),
  num('h', 'Высота (H)', 60, { unit: 'мм', min: 5, max: 2000, step: 1, group: 'Размеры' }),
  bool('outside', 'Размеры внешние', false, { group: 'Размеры', hint: 'Иначе X/Y/H — внутренние размеры' }),
];

const EDGE_OPTIONS: [string, string][] = [
  ['male', 'Шипы'], ['female', 'Пазы'], ['flat', 'Ровно'], ['none', 'Без кромки'],
];

export interface BoxCtx {
  /** Толщина материала */
  t: number;
  /** Настройки соединения */
  joint: JointOpts;
  /** Подписывать детали */
  labels: boolean;
}

export const num0 = (v: unknown, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
export const str0 = (v: unknown, def = '') => (typeof v === 'string' ? v : def);
export const bool0 = (v: unknown, def = false) => (typeof v === 'boolean' ? v : def);

/** Собрать контекст генератора из значений параметров. */
export function boxCtx(p: BoxParamValues): BoxCtx {
  const t = Math.max(0.2, num0(p.thickness, DEFAULT_JOINT.thickness));
  return {
    t,
    labels: bool0(p.labels, true),
    joint: {
      thickness: t,
      finger: Math.max(1, num0(p.finger, DEFAULT_JOINT.finger)),
      play: Math.max(0, num0(p.play, DEFAULT_JOINT.play)),
      style: str0(p.style, 'finger') === 'dovetail' ? 'dovetail' : 'finger',
      angle: num0(p.angle, DEFAULT_JOINT.angle),
      edgeWidth: Math.max(0, num0(p.edgeWidth, 0)),
      surroundings: num0(p.surroundings, 0) === 1 ? 1 : 0,
      extra: Math.max(0, num0(p.extra, 0)),
      burn: Math.max(0, num0(p.burn, 0)),
    },
  };
}

/** Внутренние размеры из X/Y/H с учётом флага «размеры внешние». */
export function innerSize(p: BoxParamValues, t: number): { x: number; y: number; h: number } {
  const outside = bool0(p.outside, false);
  const raw = {
    x: Math.max(4, num0(p.x, 100)),
    y: Math.max(4, num0(p.y, 80)),
    h: Math.max(2, num0(p.h, 50)),
  };
  if (!outside) return raw;
  return {
    x: Math.max(4, raw.x - 2 * t),
    y: Math.max(4, raw.y - 2 * t),
    h: Math.max(2, raw.h - 2 * t),
  };
}

/**
 * Разбор строки секций в стиле «50*4», «250/3», «30:25:70».
 * Возвращает список длин секций в мм.
 */
export function parseSections(text: string, total: number, fallback = 2): number[] {
  const s = (text || '').trim();
  if (!s) return Array.from({ length: Math.max(1, fallback) }, () => total / Math.max(1, fallback));
  const mul = /^([\d.,]+)\s*[*xх]\s*(\d+)$/i.exec(s);
  if (mul) {
    const len = parseFloat(mul[1].replace(',', '.'));
    const n = Math.max(1, parseInt(mul[2], 10));
    if (Number.isFinite(len) && len > 0) return Array.from({ length: n }, () => len);
  }
  // «250/3» — разделить 250 мм на три равные секции
  const div = /^([\d.,]+)\s*\/\s*(\d+)$/.exec(s);
  if (div) {
    const len = parseFloat(div[1].replace(',', '.'));
    const n = Math.max(1, parseInt(div[2], 10));
    if (Number.isFinite(len) && len > 0) return Array.from({ length: n }, () => len / n);
  }
  const parts = s.split(/[:;,+\s]+/).map((v) => parseFloat(v.replace(',', '.'))).filter((v) => Number.isFinite(v) && v > 0);
  if (parts.length) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - total) > 0.5 && total > 0) return parts.map((v) => (v / sum) * total);
    return parts;
  }
  return Array.from({ length: Math.max(1, fallback) }, () => total / Math.max(1, fallback));
}

// ---------------- раскладка на лист и статистика ----------------

export interface BoxLayoutOptions {
  sheetW: number;
  sheetH: number;
  /** Зазор между деталями, мм */
  gap: number;
  /** Отступ от края листа, мм */
  margin: number;
  /** Перемычки на внешних контурах (0 = без перемычек) */
  tabs: number;
  tabWidth: number;
  /** Поворачивать детали на 90°, если так они помещаются лучше */
  rotate: boolean;
}

export const DEFAULT_LAYOUT: BoxLayoutOptions = {
  sheetW: 400, sheetH: 300, gap: 4, margin: 5, tabs: 0, tabWidth: 2, rotate: true,
};

export interface BoxLayout {
  shapes: LaserShape[];
  groups: LaserGroup[];
  /** Все детали поместились на лист */
  fits: boolean;
  /** Сколько листов занято (оценка по площади) */
  sheets: number;
  parts: number;
  cutLengthMm: number;
  scoreLengthMm: number;
  areaMm2: number;
  usedMm2: number;
}

/**
 * Детали → фигуры редактора с раскладкой на листе.
 * Контур идёт на слой резки, отверстия — на внутренние вырезы (круги остаются
 * точными окружностями и в DXF), биговка — на слой сгиба, подписи — гравировкой.
 */
export function layoutBoxParts(parts: BoxPart[], o: Partial<BoxLayoutOptions> = {}): BoxLayout {
  const opts: BoxLayoutOptions = { ...DEFAULT_LAYOUT, ...o };
  const shapes: LaserShape[] = [];
  const groups: LaserGroup[] = [];

  for (const part of parts) {
    const n = Math.max(1, Math.round(part.count ?? 1));
    for (let k = 0; k < n; k++) {
      const suffix = n > 1 ? ` ×${n}${k + 1 > 0 ? ` (${k + 1})` : ''}` : '';
      const gid = luid('bx');
      const name = `${part.name}${suffix}`;
      groups.push({ id: gid, name });

      const bb = ptsBBox(part.outline);
      // Раскладкой занимается autoNestShapes, поэтому ставим детали «вразброс»
      const ox = -bb[0], oy = -bb[1];
      const outline = shiftPts(part.outline, ox, oy);
      shapes.push({
        id: luid('bx'), kind: 'path', layer: 'cut', name, groupId: gid,
        nodes: outline.map((p) => ({ x: p.x, y: p.y })), closed: true, filled: false,
        tabs: opts.tabs, tabWidth: opts.tabWidth,
      });

      for (const h of part.holes ?? []) {
        if (h.t === 'circle') {
          shapes.push({
            id: luid('bx'), kind: 'ellipse', layer: 'inner', name: `${name}: отверстие`, groupId: gid,
            cx: h.cx + ox, cy: h.cy + oy, rx: h.r, ry: h.r, rot: 0,
            startAngle: 0, endAngle: 360, filled: false,
          });
        } else if (h.pts.length > 2) {
          shapes.push({
            id: luid('bx'), kind: 'path', layer: 'inner', name: `${name}: вырез`, groupId: gid,
            nodes: shiftPts(h.pts, ox, oy).map((p) => ({ x: p.x, y: p.y })), closed: h.closed !== false, filled: false,
          });
        }
      }

      for (const s of part.score ?? []) {
        if (s.pts.length < 2) continue;
        shapes.push({
          id: luid('bx'), kind: 'path', layer: 'fold', name: `${name}: биговка`, groupId: gid,
          nodes: shiftPts(s.pts, ox, oy).map((p) => ({ x: p.x, y: p.y })), closed: !!s.closed, filled: false,
        });
      }

      for (const st of part.engrave ?? []) {
        if (st.length < 2) continue;
        shapes.push({
          id: luid('bx'), kind: 'path', layer: 'engrave', name: `${name}: гравировка`, groupId: gid,
          nodes: shiftPts(st, ox, oy).map((p) => ({ x: p.x, y: p.y })), closed: false, filled: false,
        });
      }

      if (part.label) {
        shapes.push({
          id: luid('bx'), kind: 'text', layer: 'engrave', name: `${name}: подпись`, groupId: gid,
          x: part.label.x + ox, y: part.label.y + oy, text: part.label.text,
          size: part.label.size, strokeWidth: 0.4, rot: 0, mirror: false, filled: false,
        });
      }
    }
  }

  const nested = autoNestShapes(shapes, opts.sheetW, opts.sheetH, opts.margin, opts.gap);
  const usedBB = nested.length ? nestedBBox(nested) : null;
  const area = nested.reduce((s, sh) => s + shapeArea(sh), 0);
  const used = usedBB ? (usedBB[2] - usedBB[0]) * (usedBB[3] - usedBB[1]) : 0;
  const sheetArea = Math.max(1, opts.sheetW * opts.sheetH);

  return {
    shapes: nested,
    groups,
    fits: used > 0 && used <= sheetArea + 1e-6 && !!usedBB && usedBB[0] >= -0.5 && usedBB[1] >= -0.5
      && usedBB[2] <= opts.sheetW + 0.5 && usedBB[3] <= opts.sheetH + 0.5,
    sheets: Math.max(1, Math.ceil(used / sheetArea)),
    parts: parts.reduce((s, p) => s + Math.max(1, Math.round(p.count ?? 1)), 0),
    cutLengthMm: nested.reduce((s, sh) => s + shapeLength(sh, sh.layer === 'fold'), 0),
    scoreLengthMm: nested.filter((sh) => sh.layer === 'fold').reduce((s, sh) => s + shapeLength(sh, false), 0),
    areaMm2: area,
    usedMm2: used,
  };
}

function nestedBBox(shapes: LaserShape[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of shapes) {
    for (const p of shapePts(s)) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  return [x0, y0, x1, y1];
}

/** Точки фигуры без аппроксимации кривых (для габарита и длины). */
function shapePts(s: LaserShape): Pt[] {
  switch (s.kind) {
    case 'path': return s.nodes.map((n) => ({ x: n.x, y: n.y }));
    case 'rect': return rectPts(s.x, s.y, s.w, s.h, s.rx);
    case 'ellipse': return circlePts(s.cx, s.cy, Math.max(s.rx, s.ry), 24);
    case 'polygon': return polygonPts(s.cx, s.cy, s.r, s.sides, (s.rot * Math.PI) / 180);
    case 'text': return [{ x: s.x, y: s.y }, { x: s.x + s.text.length * s.size * 0.8, y: s.y + s.size }];
    case 'dim': return [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
  }
}

function shapeArea(s: LaserShape): number {
  switch (s.kind) {
    case 'ellipse': return Math.PI * s.rx * s.ry * (Math.abs(s.endAngle - s.startAngle) / 360);
    case 'rect': return s.w * s.h;
    default: return contourArea(shapePts(s));
  }
}

function shapeLength(s: LaserShape, closedOnly: boolean): number {
  const pts = shapePts(s);
  const closed = s.kind === 'path' ? s.closed : s.kind !== 'text' && s.kind !== 'dim';
  void closedOnly;
  return polyLength(pts, closed);
}

// ---------------- 3D-проекция сборки ----------------

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Точка детали в пространстве сборки. */
export function partPoint(pl: Placement3D, p: Pt, along = 0): Vec3 {
  const n = cross(pl.ex, pl.ey);
  return [
    pl.o[0] + pl.ex[0] * p.x + pl.ey[0] * p.y + n[0] * along,
    pl.o[1] + pl.ex[1] * p.x + pl.ey[1] * p.y + n[1] * along,
    pl.o[2] + pl.ex[2] * p.x + pl.ey[2] * p.y + n[2] * along,
  ];
}

export interface ProjectedPoly {
  pts: Pt[];
  /** Глубина для сортировки «дальние primero» */
  depth: number;
  /** 0..1 — освещённость грани */
  shade: number;
  name: string;
}

/**
 * Аксонометрическая проекция сборки: поворот вокруг Z (yaw) и наклон (pitch).
 * Для каждой детали рисуем лицевую грань и боковые стенки толщины материала,
 * сортируем по глубине — так получается честный вид без three.js.
 */
export function projectAssembly(
  parts: BoxPart[],
  yaw: number,
  pitch: number,
  thickness: number
): { polys: ProjectedPoly[]; bbox: [number, number, number, number] } {
  const cy = Math.cos((yaw * Math.PI) / 180), sy = Math.sin((yaw * Math.PI) / 180);
  const cp = Math.cos((pitch * Math.PI) / 180), sp = Math.sin((pitch * Math.PI) / 180);
  const light = norm([0.4, -0.65, 0.65]);
  // Направление на зрителя в мировых координатах: yaw — азимут, pitch — высота.
  // Положительный pitch — смотрим сверху (как в орбитальной камере).
  const cam: Vec3 = [-cp * sy, -cp * cy, sp];

  // Экранная Y направлена вниз (SVG и canvas), поэтому «вверх» детали идёт со
  // знаком минус: раньше сборка рисовалась перевёрнутой.
  // depth — расстояние от камеры (больше = дальше): сортировка «дальние первые»
  // рисует грани в правильном порядке, и коробка не вывернута наизнанку.
  const project = (v: Vec3): { p: Pt; depth: number } => {
    const xr = v[0] * cy - v[1] * sy;
    const yr = v[0] * sy + v[1] * cy;
    return {
      p: { x: xr, y: -(yr * sp + v[2] * cp) },
      depth: yr * cp - v[2] * sp,
    };
  };

  const polys: ProjectedPoly[] = [];
  for (const part of parts) {
    if (!part.place || part.outline.length < 3) continue;
    const n = norm(cross(part.place.ex, part.place.ey));
    const front = part.outline.map((p) => partPoint(part.place!, p));
    const back = front.map((v) => [v[0] + n[0] * thickness, v[1] + n[1] * thickness, v[2] + n[2] * thickness] as Vec3);

    // тыльные грани чуть темнее — сквозь полупрозрачную сборку видно глубину
    const facing = dot(n, cam) > 0 ? 1 : 0.62;
    const faceShade = Math.min(1, (0.45 + 0.55 * Math.max(0, Math.abs(dot(n, light)))) * facing);
    const pf = front.map(project);
    polys.push({
      pts: pf.map((q) => q.p),
      depth: pf.reduce((s, q) => s + q.depth, 0) / pf.length,
      shade: faceShade,
      name: part.name,
    });

    // Боковые стенки (торцы материала): только обращённые к зрителю.
    // Отсечка по свету оставляла дыры там, где грань смотрит в камеру, но не на свет.
    for (let i = 0; i < front.length; i++) {
      const j = (i + 1) % front.length;
      const edge = sub(front[j], front[i]);
      const sideN = norm(cross(edge, n));
      if (dot(sideN, cam) < -0.02) continue;
      const quad = [front[i], front[j], back[j], back[i]].map(project);
      polys.push({
        pts: quad.map((q) => q.p),
        depth: quad.reduce((s, q) => s + q.depth, 0) / quad.length + 0.01,
        shade: 0.3 + 0.5 * Math.max(0, dot(sideN, light)),
        name: part.name,
      });
    }
  }

  polys.sort((a, b) => b.depth - a.depth);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of polys) {
    for (const p of poly.pts) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
  }
  const bbox: [number, number, number, number] = Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0];
  return { polys, bbox };
}

// ---------------- общий строитель корпуса ----------------

/** Ответная кромка: шипам соответствуют пазы и наоборот. */
export const mateEdge = (k: EdgeKind): EdgeKind => (k === 'male' ? 'female' : k === 'female' ? 'male' : 'flat');

const asEdge = (v: unknown, def: EdgeKind = 'male'): EdgeKind => {
  const s = String(v ?? def);
  return s === 'male' || s === 'female' || s === 'flat' || s === 'none' ? s : def;
};

/** Выбор кромки из общего списка (male/female/flat/none). */
const edgeSel = (key: string, label: string, def: string, group = 'Кромки'): BoxParamDef => sel(key, label, EDGE_OPTIONS, def, { group });

/**
 * Размещения деталей в сборке.
 * Лицевая грань (along = 0) всегда смотрит наружу коробки, материал уходит
 * внутрь на толщину — так 3D-вид рисует внешние поверхности, а не изнанку.
 */
export const placeFloor = (x = 0, y = 0, z = 0): Placement3D => placeXY(x, y, z);
export const placeTop = (yEnd: number, zTop: number, x = 0): Placement3D => ({ o: [x, yEnd, zTop], ex: [1, 0, 0], ey: [0, -1, 0] });
export const placeFront = (xEnd: number, yFace: number, z: number): Placement3D => placeXZ(xEnd, yFace, z, true);
export const placeBack = (xFace: number, yFace: number, z: number): Placement3D => placeXZ(xFace, yFace, z);
export const placeLeft = (xFace: number, yStart: number, z: number): Placement3D => placeYZ(xFace, yStart, z);
export const placeRight = (xFace: number, yEnd: number, z: number): Placement3D => placeYZ(xFace, yEnd, z, true);

/**
 * Подрезки кромок боковой стенки.
 * Боковая стенка короче дна на две толщины, поэтому её низ и верх уже не
 * заходят в угловые квадраты — подрезка там не нужна. Вертикальные кромки
 * подрезаются так же, как у передней стенки, иначе замок не сойдётся.
 */
export const innerSideTrims = (t: number, bottom: EdgeKind, top: EdgeKind): EdgeTrims[] => {
  const b = jointedEdge(bottom) ? t : 0;
  const v = jointedEdge(top) ? t : 0;
  // Правая кромка обходит панель снизу вверх, левая — сверху вниз, поэтому
  // подрезки зеркальны: иначе замок разъедется на толщину материала.
  return [[0, 0], [b, v], [0, 0], [v, b]];
};

export interface ShellCfg {
  /** Внутренние размеры корпуса, мм */
  x: number;
  y: number;
  h: number;
  /** Кромка стенок снизу (male — шипы в дно) */
  bottom?: EdgeKind;
  /** Кромка стенок сверху */
  top?: EdgeKind;
  /** Ставить ли дно */
  floor?: boolean;
  /** Ставить ли крышку */
  lid?: boolean;
  /** Префикс имён деталей */
  prefix?: string;
}

/**
 * Корпус коробки: дно, четыре стенки и, опционально, крышка.
 * Передняя и задняя стенки идут во всю внешнюю ширину с пазами по вертикальным
 * кромкам, боковые встают между ними с шипами — угол собирается в замок,
 * квадрат t×t остаётся сплошным и детали не мешают друг другу.
 */
export function boxShell(cfg: ShellCfg, ctx: BoxCtx): BoxPart[] {
  const { t, joint, labels } = ctx;
  const bottom = cfg.bottom ?? 'male';
  const top = cfg.top ?? 'flat';
  const x = Math.max(t * 2, cfg.x);
  const y = Math.max(t * 2, cfg.y);
  const h = Math.max(t, cfg.h);
  const W = x + 2 * t;
  const D = y + 2 * t;
  const pre = cfg.prefix ? `${cfg.prefix}: ` : '';
  const parts: BoxPart[] = [];

  if (cfg.floor !== false) {
    const m = mateEdge(bottom);
    parts.push({ name: `${pre}Дно`, outline: rectPanel(W, D, [m, m, m, m], joint), place: placeFloor() });
  }

  const fb: PanelEdges = [bottom, 'female', top, 'female'];
  parts.push({ name: `${pre}Стенка передняя`, outline: rectPanel(W, h, fb, joint), place: placeFront(W, 0, t) });
  parts.push({ name: `${pre}Стенка задняя`, outline: rectPanel(W, h, fb, joint), place: placeBack(0, D, t) });

  const sd: PanelEdges = [bottom, 'male', top, 'male'];
  const st = innerSideTrims(t, bottom, top);
  parts.push({ name: `${pre}Стенка левая`, outline: rectPanel(y, h, sd, joint, st), place: placeLeft(0, t, t) });
  parts.push({ name: `${pre}Стенка правая`, outline: rectPanel(y, h, sd, joint, st), place: placeRight(W, D - t, t) });

  if (cfg.lid) {
    const m = mateEdge(top);
    parts.push({ name: `${pre}Крышка`, outline: rectPanel(W, D, [m, m, m, m], joint), place: placeTop(D, t + h + t) });
  }

  return parts.map((p) => addLabel(p, labels));
}

/** Съёмная крышка-насадка: плоский верх и четыре бортика без шипов. */
export function slipLid(W: number, D: number, lidH: number, ctx: BoxCtx, gap = 0.3, prefix = 'Крышка'): BoxPart[] {
  const { t, joint, labels } = ctx;
  const iw = Math.max(t * 2, W + 2 * gap);
  const id = Math.max(t * 2, D + 2 * gap);
  const Ow = iw + 2 * t;
  const Od = id + 2 * t;
  const st = innerSideTrims(t, 'flat', 'flat');
  const parts: BoxPart[] = [
    { name: `${prefix}: верх`, outline: rectPts(0, 0, Ow, Od), place: placeTop(Od, lidH + t) },
    { name: `${prefix}: борт передний`, outline: rectPanel(Ow, lidH, ['flat', 'female', 'flat', 'female'], joint), place: placeFront(Ow, 0, 0) },
    { name: `${prefix}: борт задний`, outline: rectPanel(Ow, lidH, ['flat', 'female', 'flat', 'female'], joint), place: placeBack(0, Od, 0) },
    { name: `${prefix}: борт левый`, outline: rectPanel(id, lidH, ['flat', 'male', 'flat', 'male'], joint, st), place: placeLeft(0, t, 0) },
    { name: `${prefix}: борт правый`, outline: rectPanel(id, lidH, ['flat', 'male', 'flat', 'male'], joint, st), place: placeRight(Ow, Od - t, 0) },
  ];
  return parts.map((p) => addLabel(p, labels));
}

/** Выступ сверху панели: захват под пальцы или ручка корзинки. */
export function bumpTop(len: number, h: number, w: number, bumpH: number, r = 0, steps = 12): Pt[] {
  if (w < 2 || bumpH < 1) return [{ x: 0, y: 0 }, { x: len, y: 0 }, { x: len, y: h }, { x: 0, y: h }];
  const half = Math.max(1, Math.min(w / 2, len / 2 - 0.5));
  const cx = len / 2;
  const hh = Math.max(1, bumpH);
  const pts: Pt[] = [{ x: 0, y: 0 }, { x: len, y: 0 }, { x: len, y: h }, { x: cx + half, y: h }];
  if (r > 0.5) {
    const rr = Math.min(r, half * 0.95, hh * 0.95);
    pts.push({ x: cx + half, y: h + hh - rr });
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI;
      pts.push({ x: cx + (half - rr) * Math.cos(a), y: h + hh - rr + rr * Math.sin(a) });
    }
    pts.push({ x: cx - half, y: h + hh - rr });
  } else {
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI;
      pts.push({ x: cx + half * Math.cos(a), y: h + hh * Math.sin(a) });
    }
  }
  pts.push({ x: cx - half, y: h }, { x: 0, y: h });
  return dedupe(pts, true);
}

/** Панель с выступом сверху: низ и бока в замок, выступ ровный. */
export function gripPanel(len: number, h: number, w: number, bumpH: number, r: number, o: JointOpts, bottom: EdgeKind = 'male'): Pt[] {
  const c = bumpTop(len, h, w, bumpH, r);
  const edges: EdgeKind[] = c.map(() => 'flat' as EdgeKind);
  edges[0] = bottom;
  edges[1] = 'female';
  edges[c.length - 1] = 'female';
  return polyPanel(c, edges, o);
}

/** Трапеция: низ и две вертикали в замок, верх — скос от hA к hB. */
export function slopePanel(len: number, hA: number, hB: number, o: JointOpts, bottom: EdgeKind = 'male'): Pt[] {
  const a = Math.max(0.5, hA);
  const b = Math.max(0.5, hB);
  const slope = Math.hypot(len, b - a);
  return dedupe([
    ...placeProfile(edgeProfile(len, bottom, o, 0, 0), { x: 0, y: 0 }, { x: len, y: 0 }),
    ...placeProfile(edgeProfile(b, 'male', o, o.thickness, 0), { x: len, y: 0 }, { x: len, y: b }),
    ...placeProfile(edgeProfile(slope, 'flat', o), { x: len, y: b }, { x: 0, y: a }),
    ...placeProfile(edgeProfile(a, 'male', o, 0, o.thickness), { x: 0, y: a }, { x: 0, y: 0 }),
  ], true);
}

/** Точки скруглённого прямоугольника, разбитого на секции заданной длины. */
function roundedPath(W: number, D: number, r: number, sections: number[]): { pts: Pt[]; lens: number[] } {
  const rr = Math.max(0, Math.min(r, Math.min(W, D) / 2 - 0.01));
  const path: Pt[] = [];
  if (rr <= 0.01) {
    path.push({ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: D }, { x: 0, y: D });
  } else {
    const arc = (cx: number, cy: number, a0: number) => {
      for (let i = 0; i <= 5; i++) {
        const a = a0 + (i / 5) * (Math.PI / 2);
        path.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
      }
    };
    path.push({ x: rr, y: 0 }, { x: W - rr, y: 0 });
    arc(W - rr, rr, -Math.PI / 2);
    path.push({ x: W, y: D - rr });
    arc(W - rr, D - rr, 0);
    path.push({ x: rr, y: D });
    arc(rr, D - rr, Math.PI / 2);
    path.push({ x: 0, y: rr });
    arc(rr, rr, Math.PI);
  }
  const total = polyLength(path, true);
  const want = sections.length ? sections : [total];
  const sum = want.reduce((a, b) => a + b, 0) || 1;
  const lens = want.map((l) => (l / sum) * total);
  // Целевые расстояния от начала пути — накопительным итогом
  const scaled: number[] = [];
  let cum = 0;
  for (const l of lens) {
    cum += l;
    scaled.push(cum);
  }
  const pts: Pt[] = [{ ...path[0] }];
  let acc = 0;
  let k = 0;
  for (let i = 0; i < path.length && k < scaled.length; i++) {
    let from = path[i];
    const to = path[(i + 1) % path.length];
    let rest = Math.hypot(to.x - from.x, to.y - from.y);
    while (k < scaled.length && acc + rest >= scaled[k] - 1e-9) {
      const q = (scaled[k] - acc) / (rest || 1e-9);
      const p = { x: from.x + (to.x - from.x) * q, y: from.y + (to.y - from.y) * q };
      pts.push(p);
      rest = Math.hypot(to.x - p.x, to.y - p.y);
      from = p;
      acc = scaled[k];
      k += 1;
    }
    acc += rest;
  }
  return { pts: dedupe(pts, true), lens };
}

// ---------------- каталог генераторов ----------------

export type BoxFamily = 'box' | 'lid' | 'tray' | 'device' | 'mech' | 'household' | 'workshop';

export const BOX_FAMILIES: { id: BoxFamily; label: string }[] = [
  { id: 'box', label: 'Коробки' },
  { id: 'lid', label: 'Крышки и петли' },
  { id: 'tray', label: 'Лотки и ящики' },
  { id: 'device', label: 'Приборные' },
  { id: 'mech', label: 'Механика' },
  { id: 'household', label: 'Бытовое' },
  { id: 'workshop', label: 'Мастерская' },
];

export interface BoxTypeDef {
  id: string;
  name: string;
  family: BoxFamily;
  desc: string;
  params: BoxParamDef[];
  build(p: BoxParamValues): BoxPart[];
}

/** Склеить наборы параметров в один список; первый одноимённый параметр побеждает. */
const P = (...defs: BoxParamDef[][]): BoxParamDef[] => {
  const seen = new Set<string>();
  const out: BoxParamDef[] = [];
  for (const d of defs.flat()) {
    if (seen.has(d.key)) continue;
    seen.add(d.key);
    out.push(d);
  }
  return out;
};

/** Только часть общих параметров соединения — для простых генераторов. */
const JOINT_LITE = JOINT_PARAMS.filter((d) =>
  ['thickness', 'style', 'finger', 'play', 'burn', 'labels', 'reference', 'referenceLen'].includes(d.key));

/** Профиль зубчатого колеса: один замкнутый контур, режется за проход. */
export function gearPts(pitchR: number, teeth: number): Pt[] {
  const z = Math.max(6, Math.round(teeth));
  const r = Math.max(2, pitchR);
  const ra = r + r / z;
  const rf = Math.max(1, r - (r / z) * 1.25);
  const pts: Pt[] = [];
  const step = (Math.PI * 2) / z;
  for (let i = 0; i < z; i++) {
    const a = i * step;
    pts.push(
      { x: rf * Math.cos(a), y: rf * Math.sin(a) },
      { x: ra * Math.cos(a + step * 0.18), y: ra * Math.sin(a + step * 0.18) },
      { x: ra * Math.cos(a + step * 0.42), y: ra * Math.sin(a + step * 0.42) },
      { x: rf * Math.cos(a + step * 0.6), y: rf * Math.sin(a + step * 0.6) }
    );
  }
  return dedupe(pts, true);
}

/** Регулярная сетка отверстий: круги, пазы или соты. */
export function holeGrid(
  W: number,
  H: number,
  o: { cols: number; rows: number; d: number; stepX?: number; stepY?: number; margin?: number; shape?: 'circle' | 'slot' | 'hex' }
): BoxHole[] {
  const holes: BoxHole[] = [];
  const cols = Math.max(1, Math.round(o.cols));
  const rows = Math.max(1, Math.round(o.rows));
  const r = Math.max(0.2, o.d / 2);
  const margin = Math.max(0, o.margin ?? r + 1);
  const shape = o.shape ?? 'circle';
  const sx = Math.max(o.d + 0.8, o.stepX || (W - 2 * margin) / cols);
  const sy = Math.max(o.d + 0.8, o.stepY || (H - 2 * margin) / rows);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const cx = margin + sx * (i + 0.5);
      const cy = margin + sy * (j + 0.5);
      if (cx + r > W - 0.2 || cy + r > H - 0.2 || cx - r < 0.2 || cy - r < 0.2) continue;
      if (shape === 'slot') holes.push({ t: 'poly', pts: rectPts(cx - r, cy - r * 0.45, r * 2, r * 0.9, r * 0.45), closed: true });
      else if (shape === 'hex') holes.push({ t: 'poly', pts: polygonPts(cx, cy, r, 6), closed: true });
      else holes.push({ t: 'circle', cx, cy, r });
    }
  }
  return holes;
}

/** Четыре крепёжных отверстия по углам панели. */
export function mountHoles(W: number, H: number, inset: number, d: number): BoxHole[] {
  if (d <= 0.2) return [];
  const r = d / 2;
  const ix = Math.min(Math.max(1, inset), W / 2 - r - 0.2);
  const iy = Math.min(Math.max(1, inset), H / 2 - r - 0.2);
  return [
    { t: 'circle', cx: ix, cy: iy, r },
    { t: 'circle', cx: W - ix, cy: iy, r },
    { t: 'circle', cx: ix, cy: H - iy, r },
    { t: 'circle', cx: W - ix, cy: H - iy, r },
  ];
}

export const BOX_TYPES: BoxTypeDef[] = [
  // ---------- коробки ----------
  {
    id: 'universal',
    name: 'Универсальная коробка',
    family: 'box',
    desc: 'Дно, четыре стенки и крышка; вид соединения выбирается для каждой кромки',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      edgeSel('bottomEdge', 'Низ стенок', 'male'),
      edgeSel('topEdge', 'Верх стенок', 'flat'),
      bool('floor', 'Дно', true, { group: 'Кромки' }),
      bool('lid', 'Крышка', false, { group: 'Кромки' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const s = innerSize(p, ctx.t);
      return boxShell(
        { x: s.x, y: s.y, h: s.h, bottom: asEdge(p.bottomEdge, 'male'), top: asEdge(p.topEdge, 'flat'), floor: bool0(p.floor, true), lid: bool0(p.lid, false) },
        ctx
      );
    },
  },
  {
    id: 'based',
    name: 'Коробка с основанием',
    family: 'box',
    desc: 'Открытый сверху ящик: дно и четыре стенки в замок',
    params: P(SIZE_PARAMS, JOINT_PARAMS),
    build(p) {
      const ctx = boxCtx(p);
      const s = innerSize(p, ctx.t);
      return boxShell({ x: s.x, y: s.y, h: s.h, bottom: 'male', top: 'flat' }, ctx);
    },
  },
  {
    id: 'closed',
    name: 'Закрытая коробка',
    family: 'box',
    desc: 'Шесть панелей: дно, крышка и четыре стенки, всё на шипах',
    params: P(SIZE_PARAMS, JOINT_PARAMS),
    build(p) {
      const ctx = boxCtx(p);
      const s = innerSize(p, ctx.t);
      return boxShell({ x: s.x, y: s.y, h: s.h, bottom: 'male', top: 'male', lid: true }, ctx);
    },
  },
  {
    id: 'rounded',
    name: 'Закруглённая коробка',
    family: 'box',
    desc: 'Скруглённый план: стенки набираются секциями заданной длины',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('radius', 'Радиус углов', 30, { unit: 'мм', min: 0, max: 400, step: 1, group: 'Секции' }),
      txt('sections', 'Секции', '40*8', { group: 'Секции', hint: '«50*4», «250/3» или «30:25:70»' }),
      bool('lid', 'Крышка', false, { group: 'Секции' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, ctx.t);
      const W = s.x + 2 * t;
      const D = s.y + 2 * t;
      const r = Math.max(0, num0(p.radius, 30));
      const perim = r > 0.5 ? 2 * (W + D) - 8 * r + 2 * Math.PI * r : 2 * (W + D);
      const path = roundedPath(W, D, r, parseSections(str0(p.sections, '40*8'), perim, 8));
      // Нечётное число секций не замыкается в замок — делим самую длинную пополам
      let pts = path.pts;
      if (pts.length % 2 === 1 && pts.length > 2) {
        let best = 0;
        let bestLen = -1;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          const l = Math.hypot(b.x - a.x, b.y - a.y);
          if (l > bestLen) { bestLen = l; best = i; }
        }
        const a = pts[best];
        const b = pts[(best + 1) % pts.length];
        pts = [...pts.slice(0, best + 1), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ...pts.slice(best + 1)];
      }
      const n = pts.length;
      const lid = bool0(p.lid, false);
      const top: EdgeKind = lid ? 'male' : 'flat';
      const leftOf = (i: number): EdgeKind => (i % 2 === 0 ? 'female' : 'male');
      const parts: BoxPart[] = [];

      const floorEdges: EdgeKind[] = pts.map(() => 'female');
      parts.push({ name: 'Дно', outline: polyPanel(pts, floorEdges, joint), place: placeFloor() });
      if (lid) parts.push({ name: 'Крышка', outline: polyPanel(pts, floorEdges, joint), place: placeXY(0, 0, t + s.h) });

      for (let i = 0; i < n; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len < t * 1.5) continue;
        parts.push({
          name: `Секция ${i + 1}`,
          outline: rectPanel(len, s.h, ['male', mateEdge(leftOf((i + 1) % n)), top, leftOf(i)], joint),
          place: { o: [a.x, a.y, t], ex: [dx / len, dy / len, 0], ey: [0, 0, 1] },
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'ubox',
    name: 'U-образная коробка',
    family: 'box',
    desc: 'Дно и две боковины — одна деталь с биговкой, торцы на шипах',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      bool('bend', 'Гнуть по биговке', true, { group: 'U-профиль', hint: 'Иначе дно и боковины — три отдельные детали' }),
      num('glue', 'Клапан склейки', 0, { unit: 'мм', min: 0, max: 30, step: 1, group: 'U-профиль', advanced: true }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, ctx.t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const L = 2 * h + x;
      const bend = bool0(p.bend, true);
      const parts: BoxPart[] = [];

      if (bend) {
        const corners: Pt[] = [
          { x: 0, y: 0 }, { x: h, y: 0 }, { x: h + x, y: 0 }, { x: L, y: 0 },
          { x: L, y }, { x: h + x, y }, { x: h, y }, { x: 0, y },
        ];
        parts.push({
          name: 'Дно с боковинами',
          outline: polyPanel(corners, ['female', 'female', 'female', 'flat', 'female', 'female', 'female', 'flat'], joint),
          score: [
            { pts: [{ x: h, y: 0 }, { x: h, y }] },
            { pts: [{ x: h + x, y: 0 }, { x: h + x, y }] },
          ],
          place: placeFloor(-h, 0, 0),
          bend: true,
          note: 'Гнётся по двум линиям биговки',
        });
      } else {
        parts.push({ name: 'Дно', outline: rectPanel(x + 2 * t, y + 2 * t, ['female', 'female', 'female', 'female'], joint), place: placeFloor(0, 0, 0) });
        parts.push({ name: 'Боковина левая', outline: rectPanel(y, h, ['male', 'female', 'flat', 'female'], joint, innerSideTrims(t, 'male', 'flat')), place: placeLeft(0, t, t) });
        parts.push({ name: 'Боковина правая', outline: rectPanel(y, h, ['male', 'female', 'flat', 'female'], joint, innerSideTrims(t, 'male', 'flat')), place: placeRight(x + 2 * t, y + t, t) });
      }

      // У гнутого варианта торцы встают между боковинами, у сборного — снаружи
      const endW = bend ? x : x + 2 * t;
      const endEdges: PanelEdges = ['male', 'male', 'flat', 'male'];
      parts.push({ name: 'Торец передний', outline: rectPanel(endW, h, endEdges, joint), place: bend ? placeFront(x, 0, t) : placeFront(endW, 0, t) });
      parts.push({ name: 'Торец задний', outline: rectPanel(endW, h, endEdges, joint), place: bend ? placeBack(0, y + t, t) : placeBack(0, y + 2 * t, t) });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'unevenheight',
    name: 'Коробка со скосом',
    family: 'box',
    desc: 'Четыре разные высоты стенок и наклонная крышка',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('h0', 'Высота спереди', 40, { unit: 'мм', min: 5, max: 600, step: 1, group: 'Скос' }),
      num('h1', 'Высота справа', 55, { unit: 'мм', min: 5, max: 600, step: 1, group: 'Скос' }),
      num('h2', 'Высота сзади', 70, { unit: 'мм', min: 5, max: 600, step: 1, group: 'Скос' }),
      num('h3', 'Высота слева', 55, { unit: 'мм', min: 5, max: 600, step: 1, group: 'Скос' }),
      bool('lid', 'Наклонная крышка', true, { group: 'Скос' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, ctx.t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const hs = [num0(p.h0, 40), num0(p.h1, 55), num0(p.h2, 70), num0(p.h3, 55)].map((v) => Math.max(t, v));
      const parts: BoxPart[] = [];

      parts.push({ name: 'Дно', outline: rectPanel(W, D, ['female', 'female', 'female', 'female'], joint), place: placeFloor() });
      parts.push({ name: 'Стенка передняя', outline: rectPanel(W, hs[0], ['male', 'female', 'flat', 'female'], joint), place: placeFront(W, 0, t) });
      parts.push({ name: 'Стенка задняя', outline: rectPanel(W, hs[2], ['male', 'female', 'flat', 'female'], joint), place: placeBack(0, D, t) });

      parts.push({ name: 'Стенка левая', outline: slopePanel(y, hs[0], hs[2], joint), place: placeLeft(0, t, t) });
      parts.push({ name: 'Стенка правая', outline: slopePanel(y, hs[2], hs[0], joint), place: placeRight(W, D - t, t) });

      if (bool0(p.lid, true)) {
        // Крышка лежит на верхних кромках боковых стенок, поэтому уклон считаем
        // по расстоянию между ними, а не по внешнему габариту.
        const dz = hs[2] - hs[0];
        const run = Math.max(t, D - 2 * t);
        const ang = Math.atan2(dz, run);
        const slopeLen = Math.hypot(run, dz);
        parts.push({
          name: 'Крышка наклонная',
          outline: rectPanel(W, slopeLen, ['flat', 'flat', 'flat', 'flat'], joint),
          place: { o: [W, t, t + hs[0] + t], ex: [-1, 0, 0], ey: [0, Math.cos(ang), Math.sin(ang)] },
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- крышки и петли ----------
  {
    id: 'twopiece',
    name: 'Крышка и низ',
    family: 'lid',
    desc: 'Две коробки: крышка-насадка надевается на низ с заданным зазором',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('lidH', 'Высота крышки', 25, { unit: 'мм', min: 3, max: 600, step: 1, group: 'Крышка' }),
      num('gap', 'Зазор', 0.4, { unit: 'мм', min: 0, max: 5, step: 0.05, group: 'Крышка' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t } = ctx;
      const s = innerSize(p, t);
      const gap = Math.max(0, num0(p.gap, 0.4));
      const base = boxShell({ x: s.x, y: s.y, h: s.h, bottom: 'male', top: 'flat', prefix: 'Низ' }, ctx);
      const lid = slipLid(s.x + 2 * t, s.y + 2 * t, Math.max(t, num0(p.lidH, 25)), ctx, gap, 'Крышка');
      const dz = t + s.h + gap;
      return [...base, ...lid.map((q) => (q.place ? { ...q, place: { ...q.place, o: [q.place.o[0], q.place.o[1], q.place.o[2] + dz] as Vec3 } } : q))];
    },
  },
  {
    id: 'lidbox',
    name: 'Коробка с бортиком',
    family: 'lid',
    desc: 'Крышка с внутренним бортиком: не съезжает и держит форму',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('lidH', 'Высота бортика', 15, { unit: 'мм', min: 3, max: 200, step: 1, group: 'Бортик' }),
      num('gap', 'Зазор бортика', 0.3, { unit: 'мм', min: 0, max: 3, step: 0.05, group: 'Бортик' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const gap = Math.max(0, num0(p.gap, 0.3));
      const lidH = Math.max(t, num0(p.lidH, 15));
      const parts = boxShell({ x, y, h, bottom: 'male', top: 'flat', prefix: 'Корпус' }, ctx);
      const zTop = t + h + t;
      const zRim = t + h - lidH;
      // Борта образуют коробочку (W - 2·gap) × (D - 2·gap): передний и задний
      // идут во всю ширину, боковые встают между ними — углы не пересекаются.
      const rw = Math.max(t * 2, x - 2 * gap);
      const rd = Math.max(t, y - 2 * gap - 2 * t);
      const rim: PanelEdges = ['flat', 'flat', 'flat', 'flat'];
      const rimTrim: EdgeTrims[] = [[0, 0], [0, 0], [0, 0], [0, 0]];

      parts.push({ name: 'Крышка: верх', outline: rectPts(0, 0, W, D), place: placeTop(D, zTop) });
      parts.push({ name: 'Крышка: борт передний', outline: rectPanel(rw, lidH, rim, joint, rimTrim), place: placeFront(W - t - gap, t + gap, zRim) });
      parts.push({ name: 'Крышка: борт задний', outline: rectPanel(rw, lidH, rim, joint, rimTrim), place: placeBack(t + gap, D - t - gap, zRim) });
      parts.push({ name: 'Крышка: борт левый', outline: rectPanel(rd, lidH, rim, joint, rimTrim), place: placeLeft(t + gap, t + gap + t, zRim) });
      parts.push({ name: 'Крышка: борт правый', outline: rectPanel(rd, lidH, rim, joint, rimTrim), place: placeRight(W - t - gap, D - t - gap - t, zRim) });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'hingebox',
    name: 'Коробка с петлями',
    family: 'lid',
    desc: 'Ушки под штифт: крышка откидывается, а не снимается',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('hinges', 'Петель', 2, { min: 1, max: 6, step: 1, group: 'Петля' }),
      num('eyesPerHinge', 'Ушек в петле', 3, { min: 2, max: 7, step: 1, group: 'Петля' }),
      num('bore', 'Диаметр штифта', 3, { unit: 'мм', min: 1, max: 12, step: 0.1, group: 'Петля' }),
      num('eyeH', 'Высота ушка', 10, { unit: 'мм', min: 3, max: 60, step: 0.5, group: 'Петля' }),
      num('spacing', 'Отступ от края', 12, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Петля' }),
      num('glue', 'Тело петли', 8, { unit: 'мм', min: 2, max: 60, step: 1, group: 'Петля', hint: 'Полоса, которая клеится к задней стенке' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const bore = Math.max(1, num0(p.bore, 3));
      const hinges = Math.max(1, Math.round(num0(p.hinges, 2)));
      const per = Math.max(2, Math.round(num0(p.eyesPerHinge, 3)));
      const spacing = Math.max(0, num0(p.spacing, 12));
      const glue = Math.max(t, num0(p.glue, 8));
      const eyeH = Math.max(bore * 1.8, t * 1.5, num0(p.eyeH, 10));
      const parts = boxShell({ x, y, h, bottom: 'male', top: 'flat', prefix: 'Корпус' }, ctx);

      const total = hinges * per;
      const usable = Math.max(total * (bore + t), W - 2 * spacing);
      const pitch = usable / total;
      const eyeW = Math.max(bore + t * 1.5, Math.min(pitch * 0.72, pitch - 1));

      /** Гребёнка ушек: тело высотой bodyH, выше — зубья с отверстиями под штифт. */
      const comb = (parity: number, bodyH: number): { outline: Pt[]; holes: BoxHole[] } => {
        const pts: Pt[] = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: bodyH }];
        const holes: BoxHole[] = [];
        for (let i = total - 1; i >= 0; i--) {
          if (i % 2 !== parity) continue;
          const x0 = spacing + i * pitch;
          if (x0 < 0.5 || x0 + eyeW > W - 0.5) continue;
          pts.push({ x: x0 + eyeW, y: bodyH }, { x: x0 + eyeW, y: bodyH + eyeH }, { x: x0, y: bodyH + eyeH }, { x: x0, y: bodyH });
          holes.push({ t: 'circle', cx: x0 + eyeW / 2, cy: bodyH + eyeH * 0.5, r: bore / 2 + joint.play });
        }
        pts.push({ x: 0, y: bodyH });
        return { outline: dedupe(pts, true), holes };
      };

      const lidComb = comb(0, t);
      parts.push({ name: 'Крышка', outline: rectPts(0, 0, W, D - t), place: placeTop(D - t, t + h + t) });
      parts.push({ name: 'Петля крышки', outline: lidComb.outline, holes: lidComb.holes, place: placeBack(0, D, t + h), note: 'Ушки крышки, клей к задней кромке крышки' });

      const boxComb = comb(1, glue + t);
      parts.push({ name: 'Петля корпуса', outline: boxComb.outline, holes: boxComb.holes, place: placeBack(0, D + t, t + h - glue), note: 'Ушки корпуса, клей снаружи задней стенки' });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'integratedhinge',
    name: 'Встроенные петли',
    family: 'lid',
    desc: 'Задняя стенка и крышка — одна деталь, сгиб по прорезям живого шарнира',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('slotW', 'Ширина прорези', 1.5, { unit: 'мм', min: 0.3, max: 6, step: 0.1, group: 'Шарнир' }),
      num('step', 'Шаг прорезей', 6, { unit: 'мм', min: 2, max: 40, step: 0.5, group: 'Шарнир' }),
      num('band', 'Ширина зоны шарнира', 8, { unit: 'мм', min: 2, max: 60, step: 0.5, group: 'Шарнир' }),
      num('bridge', 'Поля по краям', 4, { unit: 'мм', min: 0, max: 60, step: 0.5, group: 'Шарнир' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const slotW = Math.max(0.4, num0(p.slotW, 1.5));
      const step = Math.max(slotW + 1, num0(p.step, 6));
      const band = Math.max(slotW * 2, num0(p.band, 8));
      const bridge = Math.max(0, num0(p.bridge, 4));
      const slotLen = Math.max(1, band * 0.62);

      const hingeHoles: BoxHole[] = [];
      for (let row = 0; row < 2; row++) {
        const yy = h - band / 2 + (row ? band - slotLen : 0);
        for (let xx = bridge + (row ? step / 2 : 0); xx + slotW < W - bridge; xx += step) {
          hingeHoles.push({ t: 'poly', pts: rectPts(xx, yy, slotW, slotLen, slotW / 2), closed: true });
        }
      }

      const parts: BoxPart[] = [
        {
          name: 'Задняя стенка с крышкой',
          outline: rectPanel(W, h + D, ['male', 'flat', 'flat', 'flat'], joint, [[t, t], [0, 0], [0, 0], [0, 0]]),
          holes: hingeHoles,
          score: [{ pts: [{ x: 0, y: h }, { x: W, y: h }] }],
          place: placeBack(0, D, t),
          bend: true,
          note: 'Крышка отгибается по линии биговки через живой шарнир',
        },
        { name: 'Дно', outline: rectPanel(W, D, ['female', 'female', 'female', 'female'], joint), place: placeFloor() },
        { name: 'Стенка передняя', outline: rectPanel(W, h, ['male', 'female', 'flat', 'female'], joint), place: placeFront(W, 0, t) },
        { name: 'Стенка левая', outline: rectPanel(y, h, ['male', 'male', 'flat', 'male'], joint, innerSideTrims(t, 'male', 'flat')), place: placeLeft(0, t, t) },
        { name: 'Стенка правая', outline: rectPanel(y, h, ['male', 'male', 'flat', 'male'], joint, innerSideTrims(t, 'male', 'flat')), place: placeRight(W, D - t, t) },
      ];
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- лотки и ящики ----------
  {
    id: 'slidingdrawer',
    name: 'Выдвижной ящик',
    family: 'tray',
    desc: 'Обечайка и ящик, который ходит в ней с заданным люфтом',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('gap', 'Зазор ящика', 0.5, { unit: 'мм', min: 0, max: 5, step: 0.1, group: 'Ящик' }),
      num('handle', 'Ручка', 40, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Ящик' }),
      num('handleH', 'Высота ручки', 12, { unit: 'мм', min: 2, max: 60, step: 1, group: 'Ящик' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const gap = Math.max(0, num0(p.gap, 0.5));
      const shell = boxShell({ x, y, h, bottom: 'male', top: 'flat', prefix: 'Обечайка' }, ctx);

      const dx = Math.max(t * 2, x - 2 * gap - 2 * t);
      const dy = Math.max(t * 2, y - 2 * gap - 2 * t);
      const dh = Math.max(t, h - gap - 2 * t);
      const drawer = boxShell({ x: dx, y: dy, h: dh, bottom: 'male', top: 'flat', prefix: 'Ящик' }, ctx);
      const handle = Math.max(0, num0(p.handle, 40));
      const handleH = Math.max(1, num0(p.handleH, 12));
      const front = drawer.find((q) => q.name === 'Ящик: Стенка передняя');
      if (front && handle > 4) {
        const ow = dx + 2 * t;
        front.outline = gripPanel(ow, dh, handle, handleH, handle / 2, ctx.joint, 'male');
        front.holes = [{ t: 'poly', pts: rectPts(ow / 2 - handle * 0.3, dh + handleH * 0.35, handle * 0.6, Math.min(handleH * 0.4, t)), closed: true }];
      }
      const sh = t + gap;
      return [
        ...shell,
        ...drawer.map((q) => (q.place ? { ...q, place: { ...q.place, o: [q.place.o[0] + sh, q.place.o[1] + sh, q.place.o[2] + sh] as Vec3 } } : q)),
      ].map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'typetray',
    name: 'Лоток с захватами',
    family: 'tray',
    desc: 'Открытый лоток с вырезами под пальцы и ножками для штабелирования',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('gripH', 'Высота захвата', 15, { unit: 'мм', min: 0, max: 120, step: 1, group: 'Захваты' }),
      num('gripW', 'Ширина захвата', 50, { unit: 'мм', min: 0, max: 300, step: 1, group: 'Захваты' }),
      sel('gripSide', 'Захваты', [['both', 'С двух сторон'], ['front', 'Только спереди'], ['none', 'Без захватов']], 'front', { group: 'Захваты' }),
      bool('stackable', 'Ножки для штабелирования', true, { group: 'Ножки' }),
      num('footH', 'Высота ножек', 8, { unit: 'мм', min: 2, max: 60, step: 1, group: 'Ножки' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const gripH = Math.max(0, num0(p.gripH, 15));
      const gripW = Math.max(0, num0(p.gripW, 50));
      const side = str0(p.gripSide, 'front');
      const gw = side === 'none' ? 0 : gripW;
      const both = side === 'both';
      const parts: BoxPart[] = [];

      parts.push({ name: 'Дно', outline: rectPanel(W, D, ['female', 'female', 'female', 'female'], joint), place: placeFloor() });
      parts.push({ name: 'Стенка передняя', outline: gripPanel(W, h, gw, gripH, gw / 2, joint), place: placeFront(W, 0, t) });
      parts.push({ name: 'Стенка задняя', outline: gripPanel(W, h, both ? gw : 0, gripH, gw / 2, joint), place: placeBack(0, D, t) });
      const st = innerSideTrims(t, 'male', 'flat');
      parts.push({ name: 'Стенка левая', outline: rectPanel(y, h, ['male', 'male', 'flat', 'male'], joint, st), place: placeLeft(0, t, t) });
      parts.push({ name: 'Стенка правая', outline: rectPanel(y, h, ['male', 'male', 'flat', 'male'], joint, st), place: placeRight(W, D - t, t) });

      if (bool0(p.stackable, true)) {
        const fh = Math.max(t, num0(p.footH, 8));
        const inset = t * 1.5;
        const lw = Math.max(t, W - 2 * inset);
        const ld = Math.max(t, D - 2 * inset - 2 * t);
        parts.push({ name: 'Ножка передняя', outline: rectPts(0, 0, lw, fh), place: placeFront(W - inset, inset, -fh) });
        parts.push({ name: 'Ножка задняя', outline: rectPts(0, 0, lw, fh), place: placeBack(inset, D - inset, -fh) });
        parts.push({ name: 'Ножка левая', outline: rectPts(0, 0, ld, fh), place: placeLeft(inset + t, inset + t, -fh) });
        parts.push({ name: 'Ножка правая', outline: rectPts(0, 0, ld, fh), place: placeRight(W - inset, D - inset - t, -fh) });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'magazinefile',
    name: 'Лоток для бумаг',
    family: 'tray',
    desc: 'Вертикальный лоток со скошенным передом под журналы и документы',
    params: P([
      num('x', 'Ширина', 90, { unit: 'мм', min: 20, max: 600, step: 1, group: 'Размеры' }),
      num('y', 'Глубина', 250, { unit: 'мм', min: 40, max: 800, step: 1, group: 'Размеры' }),
      num('h', 'Высота', 300, { unit: 'мм', min: 40, max: 800, step: 1, group: 'Размеры' }),
      num('angle', 'Скос переда', 32, { unit: '°', min: 0, max: 70, step: 1, group: 'Размеры' }),
    ], JOINT_LITE, [
      num('gripW', 'Вырез под пальцы', 60, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Размеры' }),
      num('gripH', 'Глубина выреза', 12, { unit: 'мм', min: 0, max: 60, step: 1, group: 'Размеры' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const x = Math.max(t * 2, num0(p.x, 90));
      const y = Math.max(t * 2, num0(p.y, 250));
      const h = Math.max(t * 2, num0(p.h, 300));
      const ang = (Math.max(0, Math.min(70, num0(p.angle, 32))) * Math.PI) / 180;
      const frontH = Math.max(t * 2, h - Math.tan(ang) * y);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const gripW = Math.max(0, num0(p.gripW, 60));
      const gripH = Math.max(0, num0(p.gripH, 12));
      const parts: BoxPart[] = [];

      parts.push({ name: 'Дно', outline: rectPanel(W, D, ['female', 'female', 'female', 'female'], joint), place: placeFloor() });
      const back = gripPanel(W, h, gripW, gripH, gripW / 3, joint);
      parts.push({ name: 'Стенка передняя', outline: rectPanel(W, frontH, ['male', 'female', 'flat', 'female'], joint), place: placeFront(W, 0, t) });
      parts.push({ name: 'Стенка задняя', outline: back, place: placeBack(0, D, t) });
      parts.push({ name: 'Стенка левая', outline: slopePanel(y, frontH, h, joint), place: placeLeft(0, t, t) });
      parts.push({ name: 'Стенка правая', outline: slopePanel(y, h, frontH, joint), place: placeRight(W, D - t, t) });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'dividertray',
    name: 'Лоток с разделителями',
    family: 'tray',
    desc: 'Лоток и сетка разделителей с прорезями в половину высоты',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('rows', 'Отделений вдоль', 2, { min: 1, max: 12, step: 1, group: 'Разделители' }),
      num('cols', 'Отделений поперёк', 3, { min: 1, max: 12, step: 1, group: 'Разделители' }),
      sel('direction', 'Разделители', [['both', 'В обе стороны'], ['x', 'Только вдоль X'], ['y', 'Только вдоль Y']], 'both', { group: 'Разделители' }),
      num('depth', 'Высота разделителей', 0, { unit: 'мм', min: 0, max: 400, step: 1, group: 'Разделители', hint: '0 — почти во всю высоту стенок' }),
      num('slot', 'Ширина прорези', 4.2, { unit: 'мм', min: 1, max: 20, step: 0.1, group: 'Разделители', advanced: true }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const h = Math.max(t, s.h);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const rows = Math.max(1, Math.round(num0(p.rows, 2)));
      const cols = Math.max(1, Math.round(num0(p.cols, 3)));
      const dir = str0(p.direction, 'both');
      const slot = Math.max(t + 2 * joint.play + 0.05, num0(p.slot, t + 0.2));
      const dh = Math.max(t * 2, Math.min(num0(p.depth, 0) > 0 ? num0(p.depth, 0) : h - t * 2, h - t));
      const parts = boxShell({ x, y, h, bottom: 'male', top: 'flat' }, ctx);

      for (let i = 1; dir !== 'y' && i < rows; i++) {
        const yPos = t + (i * y) / rows + t / 2;
        parts.push({
          name: `Разделитель X${i}`,
          outline: rectPts(0, 0, x, dh),
          holes: Array.from({ length: Math.max(0, cols - 1) }, (_, j) => ({
            t: 'poly' as const,
            pts: rectPts(((j + 1) * x) / cols - slot / 2, 0, slot, dh / 2),
            closed: true,
          })),
          place: placeBack(t, yPos, t),
        });
      }
      for (let j = 1; dir !== 'x' && j < cols; j++) {
        const xPos = t + (j * x) / cols - t / 2;
        parts.push({
          name: `Разделитель Y${j}`,
          outline: rectPts(0, 0, y, dh),
          holes: Array.from({ length: Math.max(0, rows - 1) }, (_, i) => ({
            t: 'poly' as const,
            pts: rectPts(((i + 1) * y) / rows - slot / 2, dh / 2, slot, dh / 2),
            closed: true,
          })),
          place: placeLeft(xPos, t, t),
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- приборные ----------
  {
    id: 'electronicsbox',
    name: 'Монтажный короб',
    family: 'device',
    desc: 'Короб под электронику: треугольные стойки и крепёжные отверстия',
    params: P(SIZE_PARAMS, JOINT_PARAMS, [
      num('d1', 'Крепёж дна', 3.2, { unit: 'мм', min: 0, max: 20, step: 0.1, group: 'Монтаж' }),
      num('d2', 'Крепёж крышки', 4.5, { unit: 'мм', min: 0, max: 20, step: 0.1, group: 'Монтаж' }),
      num('d3', 'Крепёж стойки', 3.2, { unit: 'мм', min: 0, max: 20, step: 0.1, group: 'Монтаж' }),
      num('tri', 'Катет стойки', 12, { unit: 'мм', min: 0, max: 60, step: 0.5, group: 'Монтаж' }),
      num('margin', 'Отступ отверстий', 7, { unit: 'мм', min: 1, max: 60, step: 0.5, group: 'Монтаж' }),
      bool('vents', 'Вентиляция в крышке', true, { group: 'Монтаж' }),
      num('ventD', 'Отверстия вентиляции', 6, { unit: 'мм', min: 0, max: 30, step: 0.5, group: 'Монтаж' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, labels } = ctx;
      const s = innerSize(p, t);
      const x = Math.max(t * 2, s.x);
      const y = Math.max(t * 2, s.y);
      const W = x + 2 * t;
      const D = y + 2 * t;
      const parts = boxShell({ x, y, h: Math.max(t, s.h), bottom: 'male', top: 'male', lid: true }, ctx);
      const margin = Math.max(2, num0(p.margin, 7));
      const tri = Math.max(0, num0(p.tri, 12));
      const d1 = num0(p.d1, 3.2);
      const d2 = num0(p.d2, 4.5);
      const d3 = num0(p.d3, 3.2);

      const floor = parts.find((q) => q.name === 'Дно');
      if (floor && d1 > 0.2) floor.holes = mountHoles(W, D, margin, d1);
      const lidPart = parts.find((q) => q.name === 'Крышка');
      if (lidPart) {
        const holes: BoxHole[] = d2 > 0.2 ? mountHoles(W, D, margin, d2) : [];
        const vd = num0(p.ventD, 6);
        if (bool0(p.vents, true) && vd > 1) {
          holes.push(...holeGrid(W, D, { cols: Math.max(1, Math.round((W - 2 * margin) / (vd * 2.5))), rows: Math.max(1, Math.round((D - 2 * margin) / (vd * 2.5))), d: vd, margin: margin + vd, shape: 'circle' }));
        }
        lidPart.holes = holes;
      }

      if (tri > 2) {
        const inset = Math.min(margin, Math.max(2, Math.min(W, D) / 2 - tri - 1));
        const shapes: Pt[][] = [
          [{ x: 0, y: 0 }, { x: tri, y: 0 }, { x: 0, y: tri }],
          [{ x: 0, y: 0 }, { x: tri, y: 0 }, { x: tri, y: tri }],
          [{ x: tri, y: 0 }, { x: tri, y: tri }, { x: 0, y: tri }],
          [{ x: 0, y: 0 }, { x: tri, y: tri }, { x: 0, y: tri }],
        ];
        const at: [number, number][] = [[inset, inset], [W - inset - tri, inset], [W - inset - tri, D - inset - tri], [inset, D - inset - tri]];
        const holeAt: [number, number][] = [[tri * 0.28, tri * 0.28], [tri * 0.72, tri * 0.28], [tri * 0.72, tri * 0.72], [tri * 0.28, tri * 0.72]];
        at.forEach(([cx, cy], i) => {
          parts.push({
            name: `Стойка ${i + 1}`,
            outline: shapes[i],
            holes: d3 > 0.2 ? [{ t: 'circle', cx: holeAt[i][0], cy: holeAt[i][1], r: d3 / 2 }] : [],
            place: placeFloor(cx, cy, t),
            note: 'Клеится на дно, держит плату винтом',
          });
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'rackbox',
    name: 'Рэковый корпус 19"',
    family: 'device',
    desc: 'Корпус для стойки 19 дюймов: высота в юнитах, ушки и вентиляция спереди',
    params: P([
      num('units', 'Высота, U', 2, { min: 1, max: 8, step: 1, group: 'Размеры' }),
      num('depth', 'Глубина', 200, { unit: 'мм', min: 40, max: 800, step: 1, group: 'Размеры' }),
    ], JOINT_PARAMS, [
      num('earW', 'Ширина ушка', 15.9, { unit: 'мм', min: 5, max: 60, step: 0.1, group: 'Крепление' }),
      num('earHole', 'Отверстие ушка', 6.5, { unit: 'мм', min: 1, max: 20, step: 0.1, group: 'Крепление' }),
      num('ventCols', 'Столбцов вентиляции', 14, { min: 0, max: 60, step: 1, group: 'Вентиляция' }),
      num('ventD', 'Отверстие вентиляции', 7, { unit: 'мм', min: 0, max: 40, step: 0.5, group: 'Вентиляция' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const U = 44.45;
      const h = Math.max(t * 2, num0(p.units, 2) * U - 2);
      const W = 482.6;
      const D = Math.max(t * 2, num0(p.depth, 200));
      const parts = boxShell({ x: W - 2 * t, y: D - 2 * t, h, bottom: 'male', top: 'male', lid: true }, ctx);

      const front = parts.find((q) => q.name === 'Стенка передняя');
      const earW = Math.max(2, num0(p.earW, 15.9));
      const earHole = Math.max(0.5, num0(p.earHole, 6.5));
      if (front) {
        front.name = 'Панель передняя';
        const cols = Math.max(0, Math.round(num0(p.ventCols, 14)));
        const vd = Math.max(0, num0(p.ventD, 7));
        if (cols && vd > 1 && h > vd * 3) {
          front.holes = holeGrid(W, h, { cols, rows: Math.max(1, Math.round((h - 20) / (vd * 2.2))), d: vd, margin: 12, shape: 'circle' });
        }
      }
      // Ушки — отдельные накладки, они не ломают замки передней панели
      for (const [name, cx] of [['Ушко левое', -earW], ['Ушко правое', W]] as [string, number][]) {
        parts.push({
          name,
          outline: rectPts(0, 0, earW, h, Math.min(2, earW / 4)),
          holes: [{ t: 'circle', cx: earW / 2, cy: h / 2, r: earHole / 2 }],
          place: placeFloor(cx, 0, t),
          note: 'Крепится к передней панели и стойке',
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'frontpanel',
    name: 'Лицевая панель',
    family: 'device',
    desc: 'Панель прибора: окно, крепёж, скругления и вентиляционные отверстия',
    params: P([
      num('width', 'Ширина', 200, { unit: 'мм', min: 10, max: 1200, step: 1, group: 'Размеры' }),
      num('height', 'Высота', 80, { unit: 'мм', min: 10, max: 800, step: 1, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('cornerR', 'Радиус углов', 4, { unit: 'мм', min: 0, max: 60, step: 0.5, group: 'Размеры' }),
      num('winW', 'Окно ширина', 90, { unit: 'мм', min: 0, max: 800, step: 1, group: 'Окно' }),
      num('winH', 'Окно высота', 34, { unit: 'мм', min: 0, max: 400, step: 1, group: 'Окно' }),
      num('winX', 'Окно отступ X', 16, { unit: 'мм', min: 0, max: 800, step: 1, group: 'Окно' }),
      num('winY', 'Окно отступ Y', 0, { unit: 'мм', min: -400, max: 400, step: 1, group: 'Окно', hint: '0 — по центру высоты' }),
      num('mountD', 'Крепёж', 3.2, { unit: 'мм', min: 0, max: 20, step: 0.1, group: 'Крепление' }),
      num('mountInset', 'Отступ крепежа', 6, { unit: 'мм', min: 1, max: 80, step: 0.5, group: 'Крепление' }),
      num('vents', 'Рядов вентиляции', 0, { min: 0, max: 8, step: 1, group: 'Вентиляция' }),
      num('ventD', 'Отверстие вентиляции', 5, { unit: 'мм', min: 0, max: 30, step: 0.5, group: 'Вентиляция' }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const W = Math.max(6, num0(p.width, 200));
      const H = Math.max(6, num0(p.height, 80));
      const winW = Math.max(0, num0(p.winW, 90));
      const winH = Math.max(0, num0(p.winH, 34));
      const winX = Math.max(0, Math.min(W - winW - 2, num0(p.winX, 16)));
      const winY = num0(p.winY, 0);
      const holes: BoxHole[] = [];
      if (winW > 1 && winH > 1 && winH < H - 2) {
        const yy = winY > 0 ? Math.min(H - winH - 1, winY) : (H - winH) / 2;
        holes.push({ t: 'poly', pts: rectPts(winX, yy, winW, winH, Math.min(2, winH / 4)), closed: true });
      }
      holes.push(...mountHoles(W, H, Math.max(1.5, num0(p.mountInset, 6)), num0(p.mountD, 3.2)));
      const rows = Math.max(0, Math.round(num0(p.vents, 0)));
      const vd = Math.max(0, num0(p.ventD, 5));
      if (rows && vd > 1) {
        const x0 = winX + winW + 12;
        holes.push(...holeGrid(W, H, { cols: Math.max(1, Math.round((W - x0 - 8) / (vd * 2.2))), rows, d: vd, stepY: (H - 16) / (rows + 1), margin: Math.max(8, x0), shape: 'circle' }));
      }
      return [{
        name: 'Лицевая панель',
        outline: rectPts(0, 0, W, H, Math.max(0, num0(p.cornerR, 4))),
        holes,
        place: placeFront(W, 0, 0),
      }].map((q) => addLabel(q, ctx.labels));
    },
  },
  {
    id: 'holepattern',
    name: 'Перфорация',
    family: 'device',
    desc: 'Панель с регулярной сеткой отверстий: круги, пазы или соты',
    params: P([
      num('width', 'Ширина', 200, { unit: 'мм', min: 10, max: 1200, step: 1, group: 'Размеры' }),
      num('height', 'Высота', 150, { unit: 'мм', min: 10, max: 1200, step: 1, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('cols', 'Столбцов', 8, { min: 1, max: 100, step: 1, group: 'Сетка' }),
      num('rows', 'Строк', 6, { min: 1, max: 100, step: 1, group: 'Сетка' }),
      num('d', 'Диаметр', 10, { unit: 'мм', min: 0.5, max: 100, step: 0.5, group: 'Сетка' }),
      num('stepX', 'Шаг X', 0, { unit: 'мм', min: 0, max: 200, step: 0.5, group: 'Сетка', hint: '0 — равномерно по ширине' }),
      num('stepY', 'Шаг Y', 0, { unit: 'мм', min: 0, max: 200, step: 0.5, group: 'Сетка', hint: '0 — равномерно по высоте' }),
      num('margin', 'Поле', 8, { unit: 'мм', min: 0, max: 100, step: 0.5, group: 'Сетка' }),
      sel('shape', 'Форма', [['circle', 'Круг'], ['slot', 'Паз'], ['hex', 'Шестигранник']], 'circle', { group: 'Сетка' }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const W = Math.max(6, num0(p.width, 200));
      const H = Math.max(6, num0(p.height, 150));
      const shape = str0(p.shape, 'circle');
      return [{
        name: 'Перфорация',
        outline: rectPts(0, 0, W, H),
        holes: holeGrid(W, H, {
          cols: num0(p.cols, 8),
          rows: num0(p.rows, 6),
          d: num0(p.d, 10),
          stepX: num0(p.stepX, 0),
          stepY: num0(p.stepY, 0),
          margin: num0(p.margin, 8),
          shape: shape === 'slot' || shape === 'hex' ? (shape as 'slot' | 'hex') : 'circle',
        }),
        place: placeFloor(),
      }].map((q) => addLabel(q, ctx.labels));
    },
  },
  {
    id: 'sbcrack',
    name: 'Стойка для плат',
    family: 'device',
    desc: 'Вертикальное хранение плат: пазы в боковинах, дно и задний упор',
    params: P([
      num('slots', 'Плат', 4, { min: 1, max: 20, step: 1, group: 'Размеры' }),
      num('boardW', 'Толщина платы', 1.8, { unit: 'мм', min: 0.5, max: 10, step: 0.1, group: 'Размеры' }),
      num('boardH', 'Высота платы', 90, { unit: 'мм', min: 20, max: 400, step: 1, group: 'Размеры' }),
      num('boardD', 'Глубина платы', 60, { unit: 'мм', min: 20, max: 400, step: 1, group: 'Размеры' }),
      num('pitch', 'Шаг пазов', 20, { unit: 'мм', min: 4, max: 100, step: 0.5, group: 'Размеры' }),
      num('groove', 'Глубина паза', 8, { unit: 'мм', min: 2, max: 60, step: 0.5, group: 'Размеры' }),
      num('thickness', 'Толщина материала', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      bool('stop', 'Задний упор', true, { group: 'Размеры' }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const slots = Math.max(1, Math.round(num0(p.slots, 4)));
      const bw = Math.max(0.6, num0(p.boardW, 1.8)) + Math.max(0, joint.play) * 2;
      const bh = Math.max(t * 3, num0(p.boardH, 90));
      const bd = Math.max(t * 3, num0(p.boardD, 60));
      const pitch = Math.max(bw + 2, num0(p.pitch, 20));
      const groove = Math.max(t, Math.min(bh * 0.6, num0(p.groove, 8)));
      const margin = t + 2;
      const W = (slots - 1) * pitch + bw + 2 * margin + 2 * t;
      const parts: BoxPart[] = [];

      // Пазы под платы — прорези сверху боковины
      const sideGrooves = (wd: number, ht: number, mg: number, pt: number, sw: number, gr: number, n: number): BoxHole[] => {
        const out: BoxHole[] = [];
        for (let i = 0; i < n; i++) {
          const x0 = mg + t + i * pt;
          if (x0 + sw > wd - 0.5) break;
          out.push({ t: 'poly', pts: rectPts(x0, ht - gr, sw, gr), closed: true });
        }
        return out;
      };
      const stop = bool0(p.stop, true);
      // Низ боковин спереди не подрезается (дно там открыто), а сзади подрезка
      // нужна: в этот угловой квадрат входит шип заднего упора.
      // Передний край дна открыт, задний закрыт упором — подрезки несимметричны,
      // а у правой боковины обход идёт в обратную сторону, поэтому они зеркальны.
      const sideTrimL: EdgeTrims = [0, stop ? t : 0];
      const sideTrimR: EdgeTrims = [stop ? t : 0, 0];
      parts.push({
        name: 'Боковина левая',
        outline: rectPanel(bd, bh, ['male', 'flat', 'flat', 'flat'], joint, [sideTrimL, [0, 0], [0, 0], [0, 0]]),
        holes: sideGrooves(bd, bh, margin, pitch, bw, groove, slots),
        place: placeLeft(0, 0, t),
      });
      parts.push({
        name: 'Боковина правая',
        outline: rectPanel(bd, bh, ['male', 'flat', 'flat', 'flat'], joint, [sideTrimR, [0, 0], [0, 0], [0, 0]]),
        holes: sideGrooves(bd, bh, margin, pitch, bw, groove, slots),
        place: placeRight(W, bd, t),
      });
      const floorTrim: EdgeTrims[] = [[0, 0], [0, stop ? t : 0], [stop ? t : 0, stop ? t : 0], [stop ? t : 0, 0]];
      parts.push({
        name: 'Дно',
        outline: rectPanel(W, bd, ['flat', 'female', stop ? 'female' : 'flat', 'female'], joint, floorTrim),
        place: placeFloor(),
      });
      if (stop) {
        parts.push({
          name: 'Упор задний',
          outline: rectPanel(W - 2 * t, bh * 0.35, ['male', 'flat', 'flat', 'flat'], joint, [[0, 0], [0, 0], [0, 0], [0, 0]]),
          place: placeBack(t, bd, t),
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- механика ----------
  {
    id: 'nema',
    name: 'Крепление NEMA',
    family: 'mech',
    desc: 'Фланец под шаговый двигатель: центральное окно, крепёж по каталогу',
    params: P([
      sel('size', 'Типоразмер', [['11', 'NEMA 11 (28 мм)'], ['14', 'NEMA 14 (35 мм)'], ['17', 'NEMA 17 (42 мм)'], ['23', 'NEMA 23 (57 мм)'], ['34', 'NEMA 34 (86 мм)']], '17', { group: 'Двигатель' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('shaft', 'Отверстие вала', 22, { unit: 'мм', min: 0, max: 80, step: 0.5, group: 'Двигатель' }),
      num('margin', 'Поле вокруг', 8, { unit: 'мм', min: 0, max: 60, step: 0.5, group: 'Двигатель' }),
      num('cornerR', 'Радиус углов', 3, { unit: 'мм', min: 0, max: 30, step: 0.5, group: 'Двигатель' }),
      num('boltPlay', 'Люфт крепежа', 0.2, { unit: 'мм', min: 0, max: 1, step: 0.05, group: 'Двигатель', advanced: true }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      // [фланец, база отверстий, диаметр крепежа] — данные производителей
      const sizes: Record<string, [number, number, number]> = {
        '11': [28.2, 23, 2.6], '14': [35.2, 26, 3], '17': [42.3, 31, 3], '23': [56.9, 47.1, 5.1], '34': [86.3, 69.6, 6.6],
      };
      const key = str0(p.size, '17');
      const sz = sizes[key] ?? sizes['17'];
      const flange = sz[0];
      const bolt = sz[1];
      const boltD = sz[2];
      const margin = Math.max(0, num0(p.margin, 8));
      const W = flange + 2 * margin;
      const play = Math.max(0, num0(p.boltPlay, 0.2));
      const win = Math.max(0, num0(p.shaft, 22));
      const holes: BoxHole[] = [];
      if (win > 1) holes.push({ t: 'circle', cx: W / 2, cy: W / 2, r: win / 2 });
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as [number, number][]) {
        holes.push({ t: 'circle', cx: W / 2 + (sx * bolt) / 2, cy: W / 2 + (sy * bolt) / 2, r: boltD / 2 + play });
      }
      return [{
        name: `Фланец NEMA ${key}`,
        outline: rectPts(0, 0, W, W, Math.max(0, num0(p.cornerR, 3))),
        holes,
        place: placeFloor(),
      }].map((q) => addLabel(q, ctx.labels));
    },
  },
  {
    id: 'jointpanel',
    name: 'Панель соединения',
    family: 'mech',
    desc: 'Пробная пара шип-паз: проверить посадку до раскроя коробки',
    params: P(JOINT_PARAMS, [
      num('len', 'Длина кромки', 150, { unit: 'мм', min: 20, max: 800, step: 1, group: 'Панель' }),
      num('depth', 'Глубина панели', 60, { unit: 'мм', min: 10, max: 400, step: 1, group: 'Панель' }),
      num('pairs', 'Пар', 1, { min: 1, max: 6, step: 1, group: 'Панель' }),
      num('gap', 'Зазор между деталями', 8, { unit: 'мм', min: 2, max: 60, step: 1, group: 'Панель', advanced: true }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { joint, labels, t } = ctx;
      const len = Math.max(20, num0(p.len, 150));
      const depth = Math.max(10, num0(p.depth, 60));
      const pairs = Math.max(1, Math.round(num0(p.pairs, 1)));
      const gap = Math.max(2, num0(p.gap, 8));
      const parts: BoxPart[] = [];
      for (let i = 0; i < pairs; i++) {
        const y0 = i * (depth * 2 + gap + t);
        parts.push({ name: `Шипы ${i + 1}`, outline: rectPanel(len, depth, ['male', 'flat', 'flat', 'flat'], joint), place: placeFloor(0, y0, 0) });
        parts.push({ name: `Пазы ${i + 1}`, outline: rectPanel(len, depth, ['female', 'flat', 'flat', 'flat'], joint), place: placeFloor(0, y0 + depth + gap, t) });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'gears',
    name: 'Зубчатая пара',
    family: 'mech',
    desc: 'Две шестерни по модулю и числу зубьев, с отверстиями под валы',
    params: P([
      num('modulus', 'Модуль', 2, { unit: 'мм', min: 0.3, max: 10, step: 0.1, group: 'Колёса' }),
      num('teeth1', 'Зубьев 1', 24, { min: 6, max: 200, step: 1, group: 'Колёса' }),
      num('shaft1', 'Вал 1', 8, { unit: 'мм', min: 0, max: 80, step: 0.1, group: 'Колёса' }),
      num('teeth2', 'Зубьев 2', 12, { min: 6, max: 200, step: 1, group: 'Колёса' }),
      num('shaft2', 'Вал 2', 8, { unit: 'мм', min: 0, max: 80, step: 0.1, group: 'Колёса' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('web', 'Облегчение', 0, { unit: 'мм', min: 0, max: 60, step: 0.5, group: 'Колёса', hint: 'Диаметр окон в диске, 0 — сплошное колесо' }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { labels } = ctx;
      const m = Math.max(0.3, num0(p.modulus, 2));
      const web = Math.max(0, num0(p.web, 0));
      const parts: BoxPart[] = [];
      let ox = 0;
      const make = (teethRaw: number, shaft: number, idx: number): void => {
        const teeth = Math.max(6, Math.round(teethRaw));
        const r = (m * teeth) / 2;
        const holes: BoxHole[] = [];
        if (shaft > 0.5) holes.push({ t: 'circle', cx: r, cy: r, r: shaft / 2 + Math.max(0, ctx.joint.play) });
        if (web > 2 && r > web * 1.8) {
          for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2;
            holes.push({ t: 'circle', cx: r + (r - web) * 0.55 * Math.cos(a), cy: r + (r - web) * 0.55 * Math.sin(a), r: web / 2 });
          }
        }
        parts.push({ name: `Колесо Z${teeth}${idx > 1 ? ` (${idx})` : ''}`, outline: shiftPts(gearPts(r, teeth), r, r), holes, place: placeFloor(ox, 0, 0) });
        ox += r * 2 + m * 2.4;
      };
      make(num0(p.teeth1, 24), num0(p.shaft1, 8), 1);
      make(num0(p.teeth2, 12), num0(p.shaft2, 8), 2);
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- бытовое ----------
  {
    id: 'birdhouse',
    name: 'Скворечник',
    family: 'household',
    desc: 'Домик для птиц: леток, жёрдочка и двускатная крыша со свесом',
    params: P([
      num('x', 'Ширина', 150, { unit: 'мм', min: 60, max: 500, step: 1, group: 'Размеры' }),
      num('y', 'Глубина', 150, { unit: 'мм', min: 60, max: 500, step: 1, group: 'Размеры' }),
      num('h', 'Высота стенок', 220, { unit: 'мм', min: 60, max: 600, step: 1, group: 'Размеры' }),
      num('thickness', 'Толщина', 6, { unit: 'мм', min: 2, max: 25, step: 0.5, group: 'Материал' }),
      num('hole', 'Леток', 32, { unit: 'мм', min: 10, max: 120, step: 1, group: 'Леток' }),
      num('holeY', 'Леток от верха', 45, { unit: 'мм', min: 5, max: 400, step: 1, group: 'Леток' }),
      num('perch', 'Жёрдочка', 10, { unit: 'мм', min: 0, max: 40, step: 0.5, group: 'Леток' }),
      num('roofOver', 'Свес крыши', 20, { unit: 'мм', min: 0, max: 80, step: 1, group: 'Крыша' }),
      num('roofAngle', 'Уклон крыши', 14, { unit: '°', min: 0, max: 45, step: 1, group: 'Крыша' }),
    ], JOINT_LITE),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const x = Math.max(t * 2, num0(p.x, 150));
      const y = Math.max(t * 2, num0(p.y, 150));
      const h = Math.max(t * 2, num0(p.h, 220));
      const W = x + 2 * t;
      const D = y + 2 * t;
      const parts = boxShell({ x, y, h, bottom: 'male', top: 'flat' }, ctx);

      const holeD = Math.max(6, num0(p.hole, 32));
      const holeY = Math.max(holeD / 2 + t, num0(p.holeY, 45));
      const perch = Math.max(0, num0(p.perch, 10));
      const front = parts.find((q) => q.name === 'Стенка передняя');
      if (front) {
        const holes: BoxHole[] = [{ t: 'circle', cx: W / 2, cy: h - holeY, r: holeD / 2 }];
        if (perch > 2 && h - holeY - holeD / 2 - perch * 1.6 > t) {
          holes.push({ t: 'circle', cx: W / 2, cy: h - holeY - holeD / 2 - perch * 1.6, r: perch / 2 + joint.play });
        }
        front.holes = holes;
      }

      const over = Math.max(0, num0(p.roofOver, 20));
      const ang = (Math.max(0, Math.min(45, num0(p.roofAngle, 14))) * Math.PI) / 180;
      const roofW = W + 2 * over;
      const slope = (D / 2 + over) / Math.max(0.2, Math.cos(ang));
      parts.push({
        name: 'Крыша передняя',
        outline: rectPts(0, 0, roofW, slope),
        place: { o: [-over, -over, t + h], ex: [1, 0, 0], ey: [0, Math.cos(ang), Math.sin(ang)] },
      });
      parts.push({
        name: 'Крыша задняя',
        outline: rectPts(0, 0, roofW, slope),
        place: { o: [W + over, D + over, t + h], ex: [-1, 0, 0], ey: [0, -Math.cos(ang), Math.sin(ang)] },
      });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'silverware',
    name: 'Корзинка для приборов',
    family: 'household',
    desc: 'Открытая корзинка со скруглённым дном и прорезной ручкой',
    params: P([
      num('x', 'Длина', 220, { unit: 'мм', min: 40, max: 600, step: 1, group: 'Размеры' }),
      num('y', 'Ширина', 130, { unit: 'мм', min: 30, max: 400, step: 1, group: 'Размеры' }),
      num('h', 'Высота', 90, { unit: 'мм', min: 20, max: 400, step: 1, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('radius', 'Радиус углов дна', 20, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Размеры' }),
      num('handleH', 'Высота ручки', 45, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Ручка' }),
      num('handleW', 'Ширина ручки', 70, { unit: 'мм', min: 10, max: 300, step: 1, group: 'Ручка' }),
      num('handleR', 'Скругление ручки', 20, { unit: 'мм', min: 0, max: 100, step: 1, group: 'Ручка' }),
      num('gripHole', 'Прорезь в ручке', 40, { unit: 'мм', min: 0, max: 200, step: 1, group: 'Ручка' }),
    ], JOINT_LITE),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const x = Math.max(t * 2, num0(p.x, 220));
      const y = Math.max(t * 2, num0(p.y, 130));
      const h = Math.max(t * 2, num0(p.h, 90));
      const W = x + 2 * t;
      const D = y + 2 * t;
      const r = Math.max(0, Math.min(num0(p.radius, 20), Math.min(W, D) / 2 - t));
      const handleH = Math.max(0, num0(p.handleH, 45));
      const handleW = Math.max(6, num0(p.handleW, 70));
      const handleR = Math.max(0, num0(p.handleR, 20));
      const parts: BoxPart[] = [];

      parts.push({ name: 'Дно', outline: rectPts(0, 0, W, D, r), place: placeFloor() });
      const handled = gripPanel(W, h, handleW, handleH, handleR, joint, 'flat');
      const gripHole = Math.max(0, num0(p.gripHole, 40));
      const holes: BoxHole[] = [];
      if (gripHole > 4 && handleH > t * 2) {
        holes.push({ t: 'poly', pts: rectPts(W / 2 - gripHole / 2, h + handleH * 0.45, gripHole, Math.min(handleH * 0.35, t * 1.6), t * 0.8), closed: true });
      }
      parts.push({ name: 'Стенка длинная с ручкой', outline: handled, holes, place: placeFront(W, 0, t) });
      parts.push({ name: 'Стенка длинная', outline: rectPanel(W, h, ['flat', 'female', 'flat', 'female'], joint), place: placeBack(0, D, t) });
      const stw = innerSideTrims(t, 'flat', 'flat');
      const shortWall = rectPanel(y, h, ['flat', 'male', 'flat', 'male'], joint, stw);
      parts.push({ name: 'Стенка короткая левая', outline: shortWall, place: placeLeft(0, t, t) });
      parts.push({ name: 'Стенка короткая правая', outline: shortWall.map((q) => ({ ...q })), place: placeRight(W, D - t, t) });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'notesholder',
    name: 'Салфетница',
    family: 'household',
    desc: 'Настольная салфетница: две боковины с прорезью и упоры',
    params: P([
      num('x', 'Длина', 130, { unit: 'мм', min: 40, max: 400, step: 1, group: 'Размеры' }),
      num('y', 'Ширина', 130, { unit: 'мм', min: 40, max: 400, step: 1, group: 'Размеры' }),
      num('h', 'Высота', 70, { unit: 'мм', min: 20, max: 300, step: 1, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('slotW', 'Прорезь', 70, { unit: 'мм', min: 5, max: 300, step: 1, group: 'Прорезь' }),
      num('slotY', 'Прорезь от верха', 10, { unit: 'мм', min: 2, max: 200, step: 1, group: 'Прорезь' }),
      num('railH', 'Высота упоров', 0.55, { min: 0.1, max: 1, step: 0.05, group: 'Упоры', hint: 'Доля высоты стенок' }),
    ], JOINT_LITE),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const x = Math.max(t * 4, num0(p.x, 130));
      const y = Math.max(t * 4, num0(p.y, 130));
      const h = Math.max(t * 4, num0(p.h, 70));
      const W = x + 2 * t;
      const D = y + 2 * t;
      const slotW = Math.max(4, Math.min(x - 4 * t, num0(p.slotW, 70)));
      const slotY = Math.max(t, num0(p.slotY, 10));
      const railH = Math.max(t * 2, h * Math.max(0.1, Math.min(1, num0(p.railH, 0.55))));
      const parts: BoxPart[] = [];

      parts.push({ name: 'Основание', outline: rectPanel(W, D, ['female', 'female', 'female', 'female'], joint), place: placeFloor() });
      // Боковины выше упоров, поэтому вертикальные кромки у всех ровные — на клей
      const slot: BoxHole = { t: 'poly', pts: rectPts((W - slotW) / 2, h - slotY - t * 1.4, slotW, t * 1.4, t * 0.7), closed: true };
      const side = rectPanel(W, h, ['male', 'flat', 'flat', 'flat'], joint, [[t, t], [0, 0], [0, 0], [0, 0]]);
      parts.push({ name: 'Боковина передняя', outline: side, holes: [slot], place: placeFront(W, 0, t) });
      parts.push({ name: 'Боковина задняя', outline: side.map((q) => ({ ...q })), holes: [{ ...slot, pts: slot.pts.map((v) => ({ ...v })) }], place: placeBack(0, D, t) });
      const rail = rectPanel(y, railH, ['male', 'flat', 'flat', 'flat'], joint, [[0, 0], [0, 0], [0, 0], [0, 0]]);
      parts.push({ name: 'Упор левый', outline: rail, place: placeLeft(0, t, t) });
      parts.push({ name: 'Упор правый', outline: rail.map((q) => ({ ...q })), place: placeRight(W, D - t, t) });
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'spool',
    name: 'Катушка',
    family: 'household',
    desc: 'Катушка для ниток, проволоки или ленты: две щеки и обечайка',
    params: P([
      num('flangeD', 'Диаметр щёк', 120, { unit: 'мм', min: 20, max: 600, step: 1, group: 'Размеры' }),
      num('width', 'Ширина намотки', 60, { unit: 'мм', min: 5, max: 400, step: 1, group: 'Размеры' }),
      num('axle', 'Диаметр обечайки', 24, { unit: 'мм', min: 4, max: 200, step: 0.5, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('spokes', 'Окон в щеке', 6, { min: 0, max: 16, step: 1, group: 'Щёки' }),
      num('spokeD', 'Диаметр окон', 15, { unit: 'мм', min: 0, max: 120, step: 0.5, group: 'Щёки' }),
      num('shaft', 'Отверстие оси', 8, { unit: 'мм', min: 0, max: 80, step: 0.5, group: 'Щёки' }),
    ], JOINT_LITE),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const R = Math.max(6, num0(p.flangeD, 120) / 2);
      const width = Math.max(t, num0(p.width, 60));
      const axle = Math.max(2, num0(p.axle, 24));
      const shaft = Math.max(0, num0(p.shaft, 8));
      const spokes = Math.max(0, Math.round(num0(p.spokes, 6)));
      const spokeD = Math.max(0, num0(p.spokeD, 15));
      const parts: BoxPart[] = [];

      const holes: BoxHole[] = [];
      if (shaft > 0.5) holes.push({ t: 'circle', cx: R, cy: R, r: shaft / 2 });
      if (spokes && spokeD > 1 && R > spokeD * 1.5 + axle / 2) {
        const rr = (R + axle / 2) / 2;
        for (let i = 0; i < spokes; i++) {
          const a = (i / spokes) * Math.PI * 2;
          holes.push({ t: 'circle', cx: R + rr * Math.cos(a), cy: R + rr * Math.sin(a), r: spokeD / 2 });
        }
      }
      const segs = Math.max(48, Math.round(R * 1.5));
      parts.push({ name: 'Щека левая', outline: shiftPts(circlePts(0, 0, R, segs), R, R), holes, place: placeFloor(0, 0, 0) });
      parts.push({ name: 'Щека правая', outline: shiftPts(circlePts(0, 0, R, segs), R, R), holes: holes.map((q) => ({ ...q })), place: placeTop(2 * R, t + width + t) });
      parts.push({
        name: 'Обечайка',
        outline: rectPanel(Math.PI * axle, width, ['flat', 'flat', 'flat', 'flat'], joint),
        place: placeBack(R - (Math.PI * axle) / 2, R, t),
        note: 'Сворачивается в цилиндр и клеится в щёки',
      });
      return parts.map((q) => addLabel(q, labels));
    },
  },

  // ---------- мастерская ----------
  {
    id: 'concaveknob',
    name: 'Вогнутая ручка',
    family: 'workshop',
    desc: 'Наборная ручка-регулятор: диски с вогнутым профилем под пальцы',
    params: P([
      num('d', 'Диаметр', 60, { unit: 'мм', min: 15, max: 200, step: 1, group: 'Размеры' }),
      num('layers', 'Дисков', 6, { min: 2, max: 30, step: 1, group: 'Размеры' }),
      num('shaft', 'Отверстие вала', 6, { unit: 'мм', min: 1, max: 60, step: 0.1, group: 'Размеры' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('concave', 'Вогнутость', 0.25, { min: 0, max: 0.6, step: 0.05, group: 'Профиль', hint: 'Доля радиуса, на которую сужается середина' }),
      num('fingerR', 'Выемки под пальцы', 0, { unit: 'мм', min: 0, max: 40, step: 0.5, group: 'Профиль' }),
      bool('labels', 'Подписывать детали', true, { group: 'Вывод' }),
    ]),
    build(p) {
      const ctx = boxCtx(p);
      const { t, labels } = ctx;
      const R = Math.max(6, num0(p.d, 60) / 2);
      const layers = Math.max(2, Math.round(num0(p.layers, 6)));
      const shaft = Math.max(0.5, num0(p.shaft, 6));
      const concave = Math.max(0, Math.min(0.6, num0(p.concave, 0.25)));
      const fingerR = Math.max(0, num0(p.fingerR, 0));
      const parts: BoxPart[] = [];
      let ox = 0;
      for (let i = 0; i < layers; i++) {
        const mid = (layers - 1) / 2;
        const k = mid > 0 ? Math.abs(i - mid) / mid : 1;
        const r = Math.max(3, R * (1 - concave * (1 - k)));
        const holes: BoxHole[] = [{ t: 'circle', cx: r, cy: r, r: shaft / 2 }];
        if (fingerR > 1 && r > fingerR * 2) {
          for (let f = 0; f < 3; f++) {
            const a = (f / 3) * Math.PI * 2 + (i % 2 ? Math.PI / 3 : 0);
            holes.push({ t: 'circle', cx: r + (r - fingerR) * 0.68 * Math.cos(a), cy: r + (r - fingerR) * 0.68 * Math.sin(a), r: fingerR });
          }
        }
        parts.push({ name: `Диск ${i + 1}`, outline: shiftPts(circlePts(0, 0, r, Math.max(36, Math.round(r * 1.6))), r, r), holes, place: placeFloor(ox, 0, i * t) });
        ox += r * 2 + t;
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
  {
    id: 'wallholder',
    name: 'Настенный держатель',
    family: 'workshop',
    desc: 'Планка с крючками для ключей и инструмента, полка снизу',
    params: P([
      num('len', 'Длина планки', 400, { unit: 'мм', min: 60, max: 1500, step: 1, group: 'Размеры' }),
      num('height', 'Высота планки', 70, { unit: 'мм', min: 20, max: 300, step: 1, group: 'Размеры' }),
      num('hooks', 'Крючков', 5, { min: 1, max: 20, step: 1, group: 'Крючки' }),
      num('hookW', 'Ширина паза', 12, { unit: 'мм', min: 3, max: 60, step: 0.5, group: 'Крючки' }),
      num('hookD', 'Вылет крючка', 30, { unit: 'мм', min: 5, max: 150, step: 1, group: 'Крючки' }),
      num('thickness', 'Толщина', 4, { unit: 'мм', min: 0.5, max: 20, step: 0.1, group: 'Материал' }),
      num('mountD', 'Крепёж', 5, { unit: 'мм', min: 0, max: 20, step: 0.1, group: 'Крепление' }),
      num('shelfD', 'Глубина полки', 60, { unit: 'мм', min: 0, max: 300, step: 1, group: 'Полка' }),
    ], JOINT_LITE),
    build(p) {
      const ctx = boxCtx(p);
      const { t, joint, labels } = ctx;
      const len = Math.max(40, num0(p.len, 400));
      const height = Math.max(t * 6, num0(p.height, 70));
      const hooks = Math.max(1, Math.round(num0(p.hooks, 5)));
      const hookW = Math.max(2, num0(p.hookW, 12));
      const hookD = Math.max(4, num0(p.hookD, 30));
      const shelfD = Math.max(0, num0(p.shelfD, 60));
      const parts: BoxPart[] = [];

      const zHook = height - t * 2 - hookW;
      const holes: BoxHole[] = mountHoles(len, height, Math.max(5, num0(p.mountD, 5) * 1.6), num0(p.mountD, 5));
      for (let i = 0; i < hooks; i++) {
        const cx = ((i + 0.5) * len) / hooks;
        if (zHook > t * 2) holes.push({ t: 'poly', pts: rectPts(cx - hookW / 2, zHook, hookW, t + 2 * joint.play), closed: true });
      }
      if (shelfD > t * 2) holes.push({ t: 'poly', pts: rectPts(t, t * 2, len - 2 * t, t + 2 * joint.play), closed: true });
      parts.push({ name: 'Планка', outline: rectPts(0, 0, len, height, t), holes, place: placeBack(0, t, 0) });

      for (let i = 0; i < hooks; i++) {
        const cx = ((i + 0.5) * len) / hooks;
        const hw = Math.max(1.5, hookW - 2 * joint.play);
        parts.push({
          name: `Крючок ${i + 1}`,
          outline: rectPts(0, 0, hw, hookD),
          place: placeFloor(cx - hw / 2, t, zHook),
          note: 'Вставляется в паз планки',
        });
      }
      if (shelfD > t * 2) {
        // Шипы полки подрезаны на толщину, чтобы войти ровно в паз планки
        parts.push({
          name: 'Полка',
          outline: dedupe([
            ...placeProfile(edgeProfile(len, 'male', joint, t, t), { x: 0, y: 0 }, { x: len, y: 0 }),
            { x: len, y: shelfD },
            { x: 0, y: shelfD },
          ], true),
          place: placeFloor(0, t, t * 2),
        });
      }
      return parts.map((q) => addLabel(q, labels));
    },
  },
];

// ---------------- сборка по типу ----------------

/** Значения параметров типа по умолчанию. */
export function defaultBoxParams(def: BoxTypeDef): BoxParamValues {
  const out: BoxParamValues = {};
  for (const d of def.params) out[d.key] = d.def;
  return out;
}

/** Привести значения к схеме: числа в границы, select — к списку вариантов. */
export function normalizeBoxParams(def: BoxTypeDef, values: Partial<BoxParamValues>): BoxParamValues {
  const out = defaultBoxParams(def);
  for (const d of def.params) {
    const v = values[d.key];
    if (v === undefined || v === null || v === '') continue;
    if (d.kind === 'number') {
      let n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
      if (!Number.isFinite(n)) n = Number(d.def) || 0;
      if (d.min !== undefined) n = Math.max(d.min, n);
      if (d.max !== undefined) n = Math.min(d.max, n);
      out[d.key] = n;
    } else if (d.kind === 'boolean') {
      out[d.key] = typeof v === 'boolean' ? v : v === 'true' || v === '1' || v === 1;
    } else {
      const s = String(v);
      out[d.key] = d.kind === 'select' && d.options && !d.options.some((o) => o.id === s) ? d.def : s;
    }
  }
  return out;
}

export function findBoxType(id: string): BoxTypeDef | undefined {
  return BOX_TYPES.find((t) => t.id === id);
}

export interface BoxBuildResult {
  type: BoxTypeDef;
  params: BoxParamValues;
  parts: BoxPart[];
  /** Замечания генератора: тонкий материал, неудачные параметры, подсказки */
  warnings: string[];
  /** Габарит сборки, мм */
  size: { w: number; d: number; h: number };
}

/** Построить детали по типу и параметрам; добавляет эталонный прямоугольник. */
export function buildBox(typeId: string, values: Partial<BoxParamValues> = {}): BoxBuildResult {
  const def = findBoxType(typeId) ?? BOX_TYPES[0];
  const params = normalizeBoxParams(def, values);
  const warnings: string[] = [];
  const ctx = boxCtx(params);
  let parts: BoxPart[] = [];
  try {
    parts = def.build(params) ?? [];
  } catch (e) {
    warnings.push(`Генератор не смог построить детали: ${e instanceof Error ? e.message : String(e)}`);
  }
  parts = parts.filter((q) => q.outline.length >= 3 && Number.isFinite(ptsBBox(q.outline)[2]));

  if (bool0(params.reference, false)) {
    const len = Math.max(10, num0(params.referenceLen, 100));
    parts.push({
      name: 'Эталон',
      outline: rectPts(0, 0, len, Math.max(4, ctx.t * 3)),
      engrave: labelStrokes(`${len}`, len * 0.12, ctx.t * 0.6, ctx.t * 1.4),
      note: 'Проверка масштаба: измерьте эту сторону после реза',
    });
  }

  let w = 0;
  let d = 0;
  let hgt = 0;
  for (const q of parts) {
    if (!q.place) continue;
    const bb = ptsBBox(q.outline);
    const corners: Vec3[] = [
      partPoint(q.place, { x: bb[0], y: bb[1] }),
      partPoint(q.place, { x: bb[2], y: bb[1] }),
      partPoint(q.place, { x: bb[2], y: bb[3] }),
      partPoint(q.place, { x: bb[0], y: bb[3] }),
    ];
    for (const c of corners) {
      w = Math.max(w, c[0]);
      d = Math.max(d, c[1]);
      hgt = Math.max(hgt, c[2]);
    }
  }

  if (!parts.length) warnings.push('Ни одной детали не построено — проверьте параметры');
  if (ctx.t < 1) warnings.push('Толщина меньше 1 мм: материал может прогореть');
  if (ctx.joint.style === 'dovetail' && ctx.joint.angle < 15) warnings.push('Угол «ласточкина хвоста» меньше 15° — соединение колется');
  if (ctx.joint.finger < ctx.t) warnings.push('Ширина шипа меньше толщины материала — шипы сломаются');

  return { type: def, params, parts, warnings, size: { w, d, h: hgt } };
}

/** Миниатюра типа для каталога: упрощённая раскладка деталей в квадрат. */
export function boxThumbnail(typeId: string, size = 92): { paths: string[]; holes: string[] } {
  const built = buildBox(typeId, { labels: false, reference: false });
  const items: { pts: Pt[]; holes: Pt[][] }[] = [];
  for (const part of built.parts) {
    const bb = ptsBBox(part.outline);
    items.push({
      pts: shiftPts(part.outline, -bb[0], -bb[1]),
      holes: (part.holes ?? []).map((h) => (h.t === 'circle' ? circlePts(h.cx - bb[0], h.cy - bb[1], h.r, 16) : shiftPts(h.pts, -bb[0], -bb[1]))),
    });
  }
  const area = (it: { pts: Pt[] }) => {
    const bb = ptsBBox(it.pts);
    return (bb[2] - bb[0]) * (bb[3] - bb[1]);
  };
  items.sort((a, b) => area(b) - area(a));

  const gap = 5;
  const rowW = 360;
  const placed: { pts: Pt[]; holes: Pt[][]; x: number; y: number }[] = [];
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  for (const it of items.slice(0, 24)) {
    const bb = ptsBBox(it.pts);
    const w = bb[2] - bb[0];
    const h = bb[3] - bb[1];
    if (cx > 0 && cx + w > rowW) {
      cx = 0;
      cy += rowH + gap;
      rowH = 0;
    }
    placed.push({ pts: it.pts, holes: it.holes, x: cx, y: cy });
    cx += w + gap;
    rowH = Math.max(rowH, h);
  }

  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of placed) {
    for (const pt of q.pts) {
      x0 = Math.min(x0, pt.x + q.x);
      y0 = Math.min(y0, pt.y + q.y);
      x1 = Math.max(x1, pt.x + q.x);
      y1 = Math.max(y1, pt.y + q.y);
    }
  }
  if (!Number.isFinite(x0) || x1 - x0 < 1e-6 || y1 - y0 < 1e-6) return { paths: [], holes: [] };
  const k = (size * 0.9) / Math.max(x1 - x0, y1 - y0);
  const pad = size * 0.05;
  const tx = (pt: Pt, q: { x: number; y: number }) =>
    `${((pt.x + q.x - x0) * k + pad).toFixed(2)},${(size - pad - (pt.y + q.y - y0) * k).toFixed(2)}`;

  const paths: string[] = [];
  const holes: string[] = [];
  for (const q of placed) {
    paths.push(q.pts.map((pt) => tx(pt, q)).join(' '));
    for (const h of q.holes) if (h.length > 1) holes.push(h.map((pt) => tx(pt, q)).join(' '));
  }
  return { paths, holes };
}
