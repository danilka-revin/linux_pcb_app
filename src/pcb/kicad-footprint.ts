// Конвертер KiCad .kicad_mod → примитивы платы PSBees.
// Поддерживает SMD/PTH/NPTH-площадки и графику line/rect/circle/arc/poly,
// без сторонних зависимостей. Непредставимые в модели PSBees свойства (например,
// номера pad, овальные PTH-площадки и маска/паста) аппроксимируются или отмечаются.

import type { LibEl, LibLayer } from './footprint';
import { bboxOf } from './footprint';

export interface KicadFootprintStats {
  smd: number;
  plated: number;
  holes: number;
  drawings: number;
}

export interface ParsedKicadFootprint {
  name: string;
  els: LibEl[];
  bbox: [number, number, number, number];
  stats: KicadFootprintStats;
  warnings: string[];
}

type SExpr = string | SExpr[];
const MAX_SOURCE = 4 * 1024 * 1024;
const MAX_NODES = 250_000;
const MAX_DEPTH = 256;
const MAX_ELEMENTS = 12_000;
const MAX_COORD = 1000;

/** Лексер KiCad S-expressions: скобки, quoted strings с escape-последовательностями и ; комментарии. */
function tokenize(source: string): string[] {
  if (source.length > MAX_SOURCE) throw new Error('Файл футпринта слишком большой (лимит 4 МБ).');
  const tokens: string[] = [];
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === ';') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    if (c === '(' || c === ')') { tokens.push(c); i++; continue; }
    if (c === '"') {
      i++;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const ch = source[i++];
        if (ch === '"') { closed = true; break; }
        if (ch === '\\' && i < source.length) {
          const next = source[i++];
          if (next === 'n') out += '\n';
          else if (next === 'r') out += '\r';
          else if (next === 't') out += '\t';
          else out += next;
        } else out += ch;
      }
      if (!closed) throw new Error('В .kicad_mod не закрыта строка в кавычках.');
      tokens.push(out);
    } else {
      const start = i;
      while (i < source.length && !/[\s();]/.test(source[i])) i++;
      if (i === start) throw new Error('Не удалось разобрать S-expression KiCad.');
      tokens.push(source.slice(start, i));
    }
    if (tokens.length > MAX_NODES) throw new Error('В .kicad_mod слишком много элементов.');
  }
  return tokens;
}

/** Без рекурсивных вызовов: защищает от чрезмерно глубоко вложенного файла. */
function parseTree(tokens: string[]): SExpr {
  const stack: SExpr[][] = [];
  let root: SExpr | null = null;
  let nodes = 0;
  for (const token of tokens) {
    if (token === '(') {
      if (stack.length >= MAX_DEPTH) throw new Error('Слишком глубокая структура .kicad_mod.');
      const list: SExpr[] = [];
      if (stack.length) stack[stack.length - 1].push(list);
      else if (root === null) root = list;
      else throw new Error('В .kicad_mod найдено больше одного корневого выражения.');
      stack.push(list);
    } else if (token === ')') {
      if (!stack.length) throw new Error('Лишняя закрывающая скобка в .kicad_mod.');
      stack.pop();
    } else {
      if (!stack.length) throw new Error('Текст вне корневого выражения .kicad_mod.');
      stack[stack.length - 1].push(token);
      nodes++;
      if (nodes > MAX_NODES) throw new Error('В .kicad_mod слишком много элементов.');
    }
  }
  if (stack.length || !root) throw new Error('Незавершённое выражение в .kicad_mod.');
  return root;
}

const list = (v: SExpr | undefined): SExpr[] | null => Array.isArray(v) ? v : null;
const atom = (v: SExpr | undefined): string | null => typeof v === 'string' ? v : null;
const tag = (v: SExpr): string => Array.isArray(v) ? atom(v[0]) ?? '' : '';
const child = (root: SExpr[], name: string): SExpr[] | null => {
  for (const item of root) {
    const x = list(item);
    if (x && atom(x[0]) === name) return x;
  }
  return null;
};
const number = (v: SExpr | undefined): number | null => {
  const s = atom(v);
  if (s === null || s.trim() === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const directNumbers = (expr: SExpr[] | null, from = 1): number[] => {
  if (!expr) return [];
  return expr.slice(from).map(number).filter((n): n is number => n !== null);
};
const point = (root: SExpr[], name: string): [number, number] | null => {
  const p = child(root, name);
  if (!p) return null;
  const x = number(p[1]), y = number(p[2]);
  if (x === null || y === null || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  return [x, y];
};
const at = (root: SExpr[]): { x: number; y: number; angle: number } | null => {
  const p = child(root, 'at');
  if (!p) return null;
  const x = number(p[1]), y = number(p[2]);
  const angle = number(p[3]) ?? 0;
  if (x === null || y === null || !Number.isFinite(angle)
    || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return null;
  return { x, y, angle };
};
const size = (root: SExpr[]): [number, number] | null => {
  const p = child(root, 'size');
  if (!p) return null;
  const w = number(p[1]), h = number(p[2]);
  if (w === null || h === null || w <= 0 || h <= 0 || w > MAX_COORD || h > MAX_COORD) return null;
  return [w, h];
};

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const world = (p: [number, number]): [number, number] => [p[0], -p[1]];

function drawingLayer(root: SExpr[]): LibLayer | null {
  const n = child(root, 'layer');
  const name = atom(n?.[1]);
  if (!name) return null;
  if (/^F\.(?:SilkS|Fab|CrtYd|Adhes|Dwgs\.User)$/i.test(name)) return 's1';
  if (/^B\.(?:SilkS|Fab|CrtYd|Adhes|Dwgs\.User)$/i.test(name)) return 's2';
  return null;
}

function strokeWidth(root: SExpr[]): number {
  const stroke = child(root, 'stroke');
  const value = number(child(stroke ?? [], 'width')?.[1])
    ?? number(child(root, 'width')?.[1]);
  return value !== null && value > 0 && value <= 10 ? value : 0.12;
}

function layersOf(root: SExpr[]): string[] {
  const layers = child(root, 'layers');
  if (!layers) return [];
  const out: string[] = [];
  const collect = (v: SExpr): void => {
    if (typeof v === 'string') out.push(v);
    else for (const c of v) collect(c);
  };
  for (const v of layers.slice(1)) collect(v);
  return out;
}

function drillSize(root: SExpr[]): [number, number] | null {
  const d = child(root, 'drill');
  if (!d) return null;
  // `oval` и вложенный offset не считаются диаметрами; читаем только числа верхнего уровня.
  const dims = directNumbers(d);
  if (!dims.length || dims[0] <= 0 || dims.some((n) => n > MAX_COORD)) return null;
  const x = dims[0], y = dims[1] ?? x;
  return [x, y];
}

function hiddenText(root: SExpr[]): boolean {
  const hide = child(child(root, 'effects') ?? [], 'hide');
  const value = atom(hide?.[1]);
  return value === 'yes' || value === 'true';
}

function textStyle(root: SExpr[]): { size: number; th: number; angle: number } {
  const a = at(root);
  const font = child(child(root, 'effects') ?? [], 'font') ?? [];
  const fontSize = child(font, 'size');
  const sx = number(fontSize?.[1]), sy = number(fontSize?.[2]);
  const th = number(child(font, 'thickness')?.[1]);
  return {
    size: Math.max(0.3, Math.min(20, sx ?? sy ?? 1)),
    th: th !== null && th > 0 ? Math.min(th, 5) : 0.15,
    angle: a?.angle ?? 0,
  };
}

function arcToLines(
  start: [number, number], mid: [number, number], end: [number, number],
): Array<[[number, number], [number, number]]> {
  const [ax, ay] = start, [bx, by] = mid, [cx, cy] = end;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-8) return [[start, end]];
  const aa = ax * ax + ay * ay, bb = bx * bx + by * by, cc = cx * cx + cy * cy;
  const ox = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / d;
  const oy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / d;
  const radius = Math.hypot(ax - ox, ay - oy);
  if (!Number.isFinite(radius) || radius <= 0 || radius > MAX_COORD) return [[start, end]];
  const a0 = Math.atan2(ay - oy, ax - ox);
  const am = Math.atan2(by - oy, bx - ox);
  const a1 = Math.atan2(cy - oy, cx - ox);
  const tau = Math.PI * 2;
  const positive = (v: number): number => ((v % tau) + tau) % tau;
  const totalCcw = positive(a1 - a0);
  const midCcw = positive(am - a0);
  const sweep = midCcw <= totalCcw + 1e-7 ? totalCcw : totalCcw - tau;
  const steps = Math.max(2, Math.min(120, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = a0 + sweep * i / steps;
    pts.push([ox + radius * Math.cos(angle), oy + radius * Math.sin(angle)]);
  }
  const out: Array<[[number, number], [number, number]]> = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i], pts[i + 1]]);
  return out;
}

/** Разбирает загруженный из каталога текст, не исполняя его и не включая внешние ссылки. */
export function parseKicadFootprint(source: string): ParsedKicadFootprint {
  const root = list(parseTree(tokenize(source)));
  if (!root || !['footprint', 'module'].includes(atom(root[0]) ?? '')) {
    throw new Error('Файл не похож на футпринт KiCad (.kicad_mod).');
  }
  const name = atom(root[1]) || 'Footprint';
  const els: LibEl[] = [];
  const warnings = new Set<string>();
  const stats: KicadFootprintStats = { smd: 0, plated: 0, holes: 0, drawings: 0 };
  let ignoredDrawing = 0;
  const add = (el: LibEl): void => {
    if (els.length >= MAX_ELEMENTS) throw new Error('Слишком сложный футпринт KiCad (более 12 000 примитивов).');
    els.push(el);
  };
  const addLine = (a: [number, number], b: [number, number], w: number, layer: LibLayer): void => {
    const [x1, y1] = world(a), [x2, y2] = world(b);
    add({ kind: 'line', x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2), w: r3(w), layer });
    stats.drawings++;
  };

  for (const raw of root.slice(2)) {
    const primitive = list(raw);
    if (!primitive) continue;
    const kind = tag(primitive);
    if (kind === 'pad') {
      const padType = atom(primitive[2]) ?? '';
      const padShape = atom(primitive[3]) ?? '';
      const position = at(primitive);
      const dims = size(primitive);
      if (!position || !dims) { warnings.add('Часть площадок пропущена: в записи нет корректных координат или размера.'); continue; }
      const [x, ky] = world([position.x, position.y]);
      if (padType === 'smd') {
        const layers = layersOf(primitive);
        const hasFront = layers.includes('F.Cu') || layers.includes('*.Cu');
        const hasBack = layers.includes('B.Cu') || layers.includes('*.Cu');
        const sides: ('k1' | 'k2')[] = hasFront && hasBack ? ['k1', 'k2'] : hasBack ? ['k2'] : ['k1'];
        let rotation = Math.round(position.angle / 90) * 90;
        rotation = ((rotation % 180) + 180) % 180;
        if (Math.abs(position.angle - Math.round(position.angle / 90) * 90) > 0.01) {
          warnings.add('Углы SMD-площадок, отличные от 0°/90°, округлены до ближайших 90°.');
        }
        for (const layer of sides) {
          add({ kind: 'smd', x: r3(x), y: r3(ky), w: r3(dims[0]), h: r3(dims[1]), rot: rotation, layer });
          stats.smd++;
        }
      } else if (padType === 'thru_hole' || padType === 'np_thru_hole') {
        const drill = drillSize(primitive);
        if (!drill) { warnings.add('Площадка без корректного сверла пропущена.'); continue; }
        const holeD = Math.max(drill[0], drill[1]);
        if (Math.abs(drill[0] - drill[1]) > 0.02) warnings.add('Овальные сверления представлены круглыми отверстиями увеличенного диаметра.');
        if (padType === 'np_thru_hole') {
          add({ kind: 'hole', x: r3(x), y: r3(ky), d: r3(holeD) });
          stats.holes++;
        } else {
          const diameter = Math.max(dims[0], dims[1]);
          const shape = padShape === 'circle' ? 'round' : padShape === 'octagon' ? 'oct' : 'square';
          add({ kind: 'pad', x: r3(x), y: r3(ky), size: r3(diameter), drill: r3(holeD), shape });
          stats.plated++;
          if (Math.abs(dims[0] - dims[1]) > 0.02 || ['oval', 'roundrect', 'custom', 'trapezoid'].includes(padShape)) {
            warnings.add('Овальные/скруглённые/нестандартные PTH-площадки приближены круглой или квадратной площадкой.');
          }
        }
      } else {
        warnings.add(`Тип площадки «${padType || 'неизвестный'}» не поддерживается и пропущен.`);
      }
      continue;
    }

    if (kind === 'fp_line') {
      const layer = drawingLayer(primitive), a = point(primitive, 'start'), b = point(primitive, 'end');
      if (!layer || !a || !b) { ignoredDrawing++; continue; }
      addLine(a, b, strokeWidth(primitive), layer);
      continue;
    }

    if (kind === 'fp_rect') {
      const layer = drawingLayer(primitive), a = point(primitive, 'start'), b = point(primitive, 'end');
      if (!layer || !a || !b) { ignoredDrawing++; continue; }
      const [ax, ay] = world(a), [bx, by] = world(b);
      const x1 = Math.min(ax, bx), y1 = Math.min(ay, by), x2 = Math.max(ax, bx), y2 = Math.max(ay, by);
      add({ kind: 'rect', x: r3(x1), y: r3(y1), w: r3(x2 - x1), h: r3(y2 - y1), th: r3(strokeWidth(primitive)), layer });
      stats.drawings++;
      continue;
    }

    if (kind === 'fp_circle') {
      const layer = drawingLayer(primitive), center = point(primitive, 'center'), end = point(primitive, 'end');
      if (!layer || !center || !end) { ignoredDrawing++; continue; }
      const [x, y] = world(center), radius = Math.hypot(center[0] - end[0], center[1] - end[1]);
      if (radius > 0 && radius <= MAX_COORD) {
        add({ kind: 'circle', x: r3(x), y: r3(y), r: r3(radius), w: r3(strokeWidth(primitive)), layer });
        stats.drawings++;
      }
      continue;
    }

    if (kind === 'fp_arc') {
      const layer = drawingLayer(primitive), start = point(primitive, 'start'), mid = point(primitive, 'mid'), end = point(primitive, 'end');
      if (!layer || !start || !end) { ignoredDrawing++; continue; }
      if (!mid) warnings.add('Дуга без средней точки KiCad приближена прямой линией.');
      for (const [a, b] of (mid ? arcToLines(start, mid, end) : [[start, end] as [[number, number], [number, number]]])) {
        addLine(a, b, strokeWidth(primitive), layer);
      }
      continue;
    }

    if (kind === 'fp_poly') {
      const layer = drawingLayer(primitive);
      const pts = primitive.flatMap((item) => {
        const p = list(item);
        if (!p || atom(p[0]) !== 'pts') return [];
        return p.slice(1).flatMap((xy) => {
          const q = list(xy);
          const x = number(q?.[1]), y = number(q?.[2]);
          return x !== null && y !== null && Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD
            ? [[x, y] as [number, number]] : [];
        });
      });
      if (!layer || pts.length < 2) { ignoredDrawing++; continue; }
      for (let i = 0; i < pts.length; i++) addLine(pts[i], pts[(i + 1) % pts.length], strokeWidth(primitive), layer);
      continue;
    }

    if (kind === 'fp_text') {
      const type = atom(primitive[1]) ?? '';
      // reference/value placeholders не нужны на плате; скрытый и не-silk текст — тоже.
      if (type !== 'user' || hiddenText(primitive)) continue;
      const content = atom(primitive[2]);
      const layer = drawingLayer(primitive), position = at(primitive);
      if (!content || !layer || !position) { ignoredDrawing++; continue; }
      const style = textStyle(primitive);
      const [x, y] = world([position.x, position.y]);
      add({ kind: 'text', x: r3(x), y: r3(y), text: content, size: style.size, th: style.th,
        rot: r3(-style.angle), mirror: false, layer });
      stats.drawings++;
      continue;
    }

    if (kind.startsWith('fp_')) ignoredDrawing++;
  }

  if (!els.length) throw new Error('В .kicad_mod нет поддерживаемых площадок, отверстий или линий.');
  if (ignoredDrawing) warnings.add(`${ignoredDrawing} графических элементов на неподдерживаемых слоях/типах пропущено.`);
  if (stats.plated || stats.smd) {
    // PSBees не хранит номера pad и отдельные слои пасты/маски.
    warnings.add('Номера выводов, паяльная маска и паста не импортируются; сверяйте .kicad_mod с библиотекой и даташитом.');
  }
  return { name, els, bbox: bboxOf(els), stats, warnings: [...warnings] };
}
