// Импорт векторных чертежей из форматов, которыми обменивается CorelDRAW:
// PLT/HPGL (плоттеры и станки), EPS/PS/AI (PostScript, включая EPS Illustrator)
// и PDF/AI (векторные потоки страниц — современный .ai это PDF внутри).
//
// Родной .cdr не читается: формат закрытый и двоичный, публичной спецификации
// нет. При попытке открыть .cdr выдаём подсказку, в какие форматы его
// пересохранить (см. CDR_MESSAGE в corel.ts).
//
// Все три парсера возвращают геометрию в миллиметрах с осью Y вверх — как в
// мире чертежа, поэтому ни переворота, ни масштабирования при импорте нет:
// PDF и EPS переводят пункты в мм (25.4/72), PLT — юниты HPGL в мм (1/40).

import {
  DEFAULT_LASER_LAYERS, LASER_LAYER_ORDER, luid,
  type LaserLayerId, type LaserShape, type PathNode, type Pt,
} from './model';
import { DXF_LAYER_NAMES } from './dxf';
import { CDR_MESSAGE, HPGL_UNITS_PER_MM, MM_PER_PT, hexToRgb01 } from './corel';
import { importVectorFile } from './export';

export type CorelFormat = 'svg' | 'dxf' | 'pdf' | 'ps' | 'plt' | 'cdr' | 'project' | 'unknown';

export interface VectorImportResult {
  shapes: LaserShape[];
  /** Что не удалось распознать: текст, растровые вставки, неподдержанные команды. */
  notes: string[];
  /** Число страниц в файле (для одностраничных EPS/PLT = 1). */
  pages: number;
  kind: CorelFormat;
}

/** Предел размера входного файла: парсер держит файл в памяти как строку. */
const MAX_BYTES = 64 * 1024 * 1024;
/** Предел числа точек, чтобы «взрослый» файл не подвесил вкладку. */
const MAX_NODES = 600_000;

// ---------------- матрицы (та же конвенция, что в SVG-импорте) ----------------

type Mat = [number, number, number, number, number, number];
const MAT_ID: Mat = [1, 0, 0, 1, 0, 0];
const DEG = Math.PI / 180;

/** Композиция матриц: сначала применяется n, потом m. */
function mulMat(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function applyMat(m: Mat, x: number, y: number): Pt {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

// ---------------- определение слоя ----------------

const LAYER_RGB = LASER_LAYER_ORDER.map((id) => ({ id, rgb: hexToRgb01(DEFAULT_LASER_LAYERS[id].color) }));

/** Имя слоя из файла (OCG в PDF, комментарий в EPS) → слой чертежа. */
export function layerByName(name: string | null | undefined): LaserLayerId | null {
  if (!name) return null;
  const up = name.trim().toUpperCase();
  for (const id of LASER_LAYER_ORDER) if (DXF_LAYER_NAMES[id] === up) return id;
  const low = name.toLowerCase();
  if (/inner|hole|внутр|отверст|окн/.test(low)) return 'inner';
  if (/fold|bend|crease|bi[gh]|сгиб|бигов|перфор|фальц/.test(low)) return 'fold';
  if (/score|mark|razm|размет|надрез|риц/.test(low)) return 'score';
  if (/engrav|fill|raster|гравир|залив|растр/.test(low)) return 'engrave';
  if (/guide|dim|size|размер|направ|служеб|осев/.test(low)) return 'guide';
  if (/cut|kontur|контур|рез|вырез|обрез/.test(low)) return 'cut';
  return null;
}

/** Ближайший цвет слоя чертежа, если расстояние до него маленькое. */
function layerByColor(rgb: [number, number, number] | null): LaserLayerId | null {
  if (!rgb) return null;
  let best: LaserLayerId | null = null;
  let dist = 0.2;
  for (const L of LAYER_RGB) {
    const d = Math.hypot(L.rgb[0] - rgb[0], L.rgb[1] - rgb[1], L.rgb[2] - rgb[2]);
    if (d < dist) { dist = d; best = L.id; }
  }
  return best;
}

// ---------------- токенизатор PostScript/PDF ----------------

export type Tok =
  | { t: 'num'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'name'; v: string }
  | { t: 'str'; v: string }
  | { t: 'arr'; items: Tok[] }
  | { t: 'dict'; items: Tok[] }
  | { t: 'proc'; items: Tok[] }
  | { t: 'op'; v: string }
  /** Маркер слоя из комментария (%PSBeesLayer: / %%BeginLayer / %%EndLayer). */
  | { t: 'layer'; v: string | null };

const WS = ' \t\r\n\f\0';
const DELIM = '()<>[]{}/%';

/** Комментарий DSC/Adobe, который несёт имя слоя. */
function layerMarker(line: string): string | null | undefined {
  let m = /^%*PSBeesLayer:\s*(.+)$/i.exec(line);
  if (m) return m[1].trim();
  m = /^%%BeginLayer:?\s*"?(.+?)"?\s*$/i.exec(line);
  if (m) return m[1].trim();
  if (/^%%EndLayer/i.test(line)) return null;
  return undefined;
}

/**
 * Разбор текста PostScript или контент-потока PDF на токены. Процедуры {...},
 * массивы [...] и словари <<...>> разбираются рекурсивно, строки (...) —
 * с учётом экранирования и вложенности скобок. Блоки %%BeginPreview и
 * %%BeginBinary (растровое превью в EPS) пропускаются целиком: внутри лежит
 * ASCII85/HEX-мусор, который иначе развалил бы поток токенов.
 */
export function tokenizePs(src: string): Tok[] {
  const n = src.length;
  let i = 0;

  const readString = (): string => {
    // i указывает на '('
    let depth = 0;
    let out = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') {
        const e = src[i + 1];
        i += 2;
        if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') { oct += src[i]; i += 1; }
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (e === '\n') { /* перенос строки внутри литерала */ }
        else out += e ?? '';
        continue;
      }
      if (c === '(') { depth += 1; out += c; i += 1; continue; }
      if (c === ')') {
        depth -= 1;
        i += 1;
        if (depth <= 0) return out;
        out += c;
        continue;
      }
      out += c;
      i += 1;
    }
    return out;
  };

  const readHex = (): string => {
    let out = '';
    while (i < n && src[i] !== '>') {
      if (!WS.includes(src[i])) out += src[i];
      i += 1;
    }
    i += 1;
    return out;
  };

  const readSeq = (stop: ']' | '}' | '>>'): Tok[] => {
    const items: Tok[] = [];
    while (i < n) {
      // пробелы пропускаем ДО проверки закрытия, иначе « }» не закрывает процедуру
      while (i < n && WS.includes(src[i])) i += 1;
      if (i >= n) break;
      if (stop === ']' && src[i] === ']') { i += 1; return items; }
      if (stop === '}' && src[i] === '}') { i += 1; return items; }
      if (stop === '>>' && src[i] === '>' && src[i + 1] === '>') { i += 2; return items; }
      const before = i;
      const tok = readToken();
      if (tok) items.push(tok);
      if (i === before) i += 1; // защита от застревания на мусоре
    }
    return items;
  };

  const readToken = (): Tok | null => {
    while (i < n && WS.includes(src[i])) i += 1;
    if (i >= n) return null;
    const c = src[i];
    if (c === '%') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      const line = src.slice(i + 1, j).trim();
      i = j + 1;
      if (/^%%?Begin(Preview|Binary)/i.test(line)) {
        const rest = src.slice(i);
        const m = /^%%?End(Preview|Binary)/im.exec(rest);
        i = m ? i + m.index + m[0].length : n;
        return null;
      }
      const mark = layerMarker(line);
      return mark === undefined ? null : { t: 'layer', v: mark };
    }
    if (c === '(') { i += 1; return { t: 'str', v: readString() }; }
    if (c === '<') {
      if (src[i + 1] === '<') { i += 2; return { t: 'dict', items: readSeq('>>') }; }
      i += 1;
      return { t: 'str', v: readHex() };
    }
    if (c === '[') { i += 1; return { t: 'arr', items: readSeq(']') }; }
    if (c === '{') { i += 1; return { t: 'proc', items: readSeq('}') }; }
    if (c === '/' || c === ']') {
      if (c === ']') { i += 1; return null; }
      i += 1;
      let j = i;
      while (j < n && !WS.includes(src[j]) && !DELIM.includes(src[j])) j += 1;
      const name = src.slice(i, j);
      i = j;
      return { t: 'name', v: name };
    }
    if (c === '}') { i += 1; return null; }
    const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(src.slice(i, i + 48));
    if (num && num[0].length && /^[-+.\d]/.test(c)) {
      i += num[0].length;
      return { t: 'num', v: parseFloat(num[0]) };
    }
    let j = i;
    while (j < n && !WS.includes(src[j]) && !DELIM.includes(src[j])) j += 1;
    if (j === i) { i += 1; return null; }
    const word = src.slice(i, j);
    i = j;
    if (word === 'true' || word === 'false') return { t: 'bool', v: word === 'true' };
    return { t: 'op', v: word };
  };

  const out: Tok[] = [];
  for (;;) {
    const before = i;
    const tok = readToken();
    if (tok) out.push(tok);
    if (i >= n) break;
    if (i === before) i += 1;
  }
  return out;
}

// ---------------- интерпретатор контура ----------------

interface Subpath { nodes: PathNode[]; closed: boolean }
interface GState {
  ctm: Mat;
  stroke: [number, number, number];
  fill: [number, number, number];
  dash: number[];
  width: number;
}

export interface PsRunOptions {
  /** Подпись импортера в именах объектов: 'EPS', 'AI', 'PDF'. */
  label: string;
  /** Миллиметров в одной единице устройства. */
  unitMm: number;
  /** Сдвиг начала координат страницы (llx, lly) в единицах устройства. */
  ox?: number;
  oy?: number;
  /** PDF: имена свойств страницы (/MC0 → имя слоя OCG). */
  props?: Record<string, string>;
  /** PDF: разбор Do — форма XObject по имени ресурса. */
  resolveDo?: (name: string) => { toks: Tok[]; matrix: Mat } | null;
  notes: string[];
  /** Останавливаться после первой страницы (showpage). */
  firstPageOnly?: boolean;
}

/**
 * Общий интерпретатор контент-потока: понимает и PostScript (moveto/lineto/
 * curveto/stroke/fill, gsave/grestore, concat, arc), и диалект PDF (m/l/c/v/y/h/
 * re/S/f/B/q/Q/cm/W), и приватные операторы Illustrator EPS (u/U/*u/*U/n/N/F/f/
 * S/s/B/b). Слои берутся из OCG (PDF) или из комментариев %PSBeesLayer /
 * %%BeginLayer, иначе определяются по пунктиру и цвету линии.
 */
export function runPsTokens(toks: Tok[], out: LaserShape[], opts: PsRunOptions): number {
  const unit = opts.unitMm;
  const ox = opts.ox ?? 0;
  const oy = opts.oy ?? 0;
  const label = opts.label;

  const stack: unknown[] = [];
  // процедуры и значения из пролога файла: «/L { lineto } def» встречается в EPS
  // gnuplot, matplotlib, CorelDRAW и Illustrator — без них геометрия теряется
  const defs = new Map<string, Tok>();
  const states: GState[] = [{ ctm: MAT_ID, stroke: [0, 0, 0], fill: [0, 0, 0], dash: [], width: 1 }];
  const layerMarks: (LaserLayerId | null)[] = [];
  // имена слоёв из файла (OCG в PDF, %%BeginLayer / %PSBeesLayer в EPS):
  // по ним редактор создаёт свои слои с теми же именами
  const layerNames: (string | null)[] = [];
  let gs: GState = states[0];
  let subs: Subpath[] = [];
  let cur: Pt | null = null;              // текущая точка в пользовательских единицах
  let subStart: Pt | null = null;         // начало текущего подпути (для closepath)
  let nodesTotal = 0;
  let pages = 1;
  let sawText = false;
  let sawImage = false;
  let sawClip = false;
  let textMode = false;
  let stopped = false;
  const unknown = new Map<string, number>();
  let budget = 4_000_000;
  let depth = 0;

  const toMm = (p: Pt): Pt => ({ x: (p.x - ox) * unit, y: (p.y - oy) * unit });

  const dev = (x: number, y: number): Pt => applyMat(gs.ctm, x, y);

  const pushNode = (p: Pt, cp1?: Pt, cp2prev?: Pt) => {
    const sub = subs[subs.length - 1];
    if (!sub) return;
    if (cp2prev && sub.nodes.length) {
      const last = sub.nodes[sub.nodes.length - 1];
      last.cp2x = cp2prev.x;
      last.cp2y = cp2prev.y;
    }
    const node: PathNode = { x: p.x, y: p.y };
    if (cp1) { node.cp1x = cp1.x; node.cp1y = cp1.y; }
    sub.nodes.push(node);
    nodesTotal += 1;
  };

  const currentLayer = (color: [number, number, number]): LaserLayerId => {
    for (let k = layerMarks.length - 1; k >= 0; k--) {
      if (layerMarks[k]) return layerMarks[k] as LaserLayerId;
    }
    if (gs.dash.some((v) => v > 0)) return 'fold';
    return layerByColor(color) ?? 'cut';
  };

  /** Имя слоя из файла: самый внутренний помеченный слой. */
  const currentLayerName = (): string | null => {
    for (let k = layerNames.length - 1; k >= 0; k--) {
      if (layerNames[k]) return layerNames[k];
    }
    return null;
  };

  const emit = (fill: boolean, stroke: boolean) => {
    const list = subs.filter((s) => s.nodes.length >= 2);
    subs = [];
    cur = null;
    subStart = null;
    if (!list.length) return;
    const layer = currentLayer(fill ? gs.fill : gs.stroke);
    const lname = currentLayerName();
    const conv = (nodes: PathNode[]): PathNode[] => nodes.map((nd) => {
      const p = toMm({ x: nd.x, y: nd.y });
      const res: PathNode = { x: p.x, y: p.y };
      if (nd.cp1x !== undefined && nd.cp1y !== undefined) {
        const c = toMm({ x: nd.cp1x, y: nd.cp1y });
        res.cp1x = c.x;
        res.cp1y = c.y;
      }
      if (nd.cp2x !== undefined && nd.cp2y !== undefined) {
        const c = toMm({ x: nd.cp2x, y: nd.cp2y });
        res.cp2x = c.x;
        res.cp2y = c.y;
      }
      return res;
    });
    const mk = (nodes: PathNode[], closed: boolean, holes: PathNode[][]): LaserShape => ({
      id: luid(label.toLowerCase()),
      kind: 'path',
      layer,
      layerName: lname ?? undefined,
      name: `${label} Контур`,
      nodes,
      holes: holes.length ? holes : undefined,
      closed,
      filled: fill,
    });
    if (fill && list.length > 1) {
      // заливка: первое подпуть — контур, остальные — отверстия (even-odd)
      const finite = (nds: PathNode[]) => nds.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
      if (finite(list[0].nodes)) {
        out.push(mk(conv(list[0].nodes), list[0].closed, list.slice(1).filter((s) => finite(s.nodes) && s.nodes.length >= 3).map((s) => conv(s.nodes))));
        return;
      }
    }
    if (stroke || !fill) {
      for (const s of list) {
        if (!s.nodes.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) continue;
        out.push(mk(conv(s.nodes), s.closed, []));
      }
      return;
    }
    for (const s of list) out.push(mk(conv(s.nodes), s.closed, []));
  };

  /**
   * Дуга с центром в (cx, cy): кубические Безье по сегментам не крупнее 90°.
   * sweepDeg signed — знак задаёт направление (против часовой положительный).
   * Как и PostScript, соединяет текущую точку с началом дуги прямой.
   */
  const appendArc = (cx: number, cy: number, r: number, a0deg: number, sweepDeg: number) => {
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(sweepDeg) || Math.abs(sweepDeg) < 1e-9) return;
    const a0 = a0deg * DEG;
    const sweep = sweepDeg * DEG;
    const pt = (a: number): Pt => ({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    const start = pt(a0);
    if (!subs.length) subs.push({ nodes: [], closed: false });
    const sub = subs[subs.length - 1];
    if (cur && sub.nodes.length) pushNode(dev(start.x, start.y));
    else if (!sub.nodes.length) {
      sub.nodes.push(devPt(start));
      nodesTotal += 1;
    }
    cur = start;
    const segs = Math.max(1, Math.min(64, Math.ceil(Math.abs(sweep) / (Math.PI / 2))));
    const step = sweep / segs;
    for (let s = 0; s < segs; s++) {
      const s0 = a0 + step * s;
      const s1 = s0 + step;
      const k = (4 / 3) * Math.tan(step / 4);
      const p0 = pt(s0);
      const p3 = pt(s1);
      // контрольные точки дуги: перпендикуляр к радиусу длиной k·r
      const c1 = { x: p0.x - k * r * Math.sin(s0), y: p0.y + k * r * Math.cos(s0) };
      const c2 = { x: p3.x + k * r * Math.sin(s1), y: p3.y - k * r * Math.cos(s1) };
      pushNode(dev(p3.x, p3.y), dev(c2.x, c2.y), dev(c1.x, c1.y));
      cur = p3;
    }
  };

  /** Знаковый разворот дуги: arc идёт против часовой, arcn — по часовой. */
  const arcSweep = (a0: number, a1: number, ccw: boolean): number => {
    const d = ((a1 - a0) % 360 + 360) % 360;
    if (ccw) return d === 0 ? 360 : d;
    return d === 0 ? -360 : d - 360;
  };

  /** Касательная дуга arct/arct2: прямая до точки касания + дуга до второй. */
  const appendArct = (x1: number, y1: number, x2: number, y2: number, r: number) => {
    if (!cur || !Number.isFinite(r) || r <= 0) return;
    const p0 = cur;
    const p1: Pt = { x: x1, y: y1 };
    const p2: Pt = { x: x2, y: y2 };
    const len = (v: Pt): number => Math.hypot(v.x, v.y) || 1;
    const u1: Pt = { x: (p0.x - p1.x) / len({ x: p0.x - p1.x, y: p0.y - p1.y }), y: (p0.y - p1.y) / len({ x: p0.x - p1.x, y: p0.y - p1.y }) };
    const u2: Pt = { x: (p2.x - p1.x) / len({ x: p2.x - p1.x, y: p2.y - p1.y }), y: (p2.y - p1.y) / len({ x: p2.x - p1.x, y: p2.y - p1.y }) };
    const cosT = Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y));
    const half = Math.acos(cosT) / 2;
    if (!Number.isFinite(half) || Math.sin(half) < 1e-9) {
      // вырожденный случай: точки на одной прямой — просто отрезок
      pushNode(dev(p1.x, p1.y));
      cur = p1;
      return;
    }
    const d = r / Math.tan(half);
    const t0: Pt = { x: p1.x + u1.x * d, y: p1.y + u1.y * d };
    const t1: Pt = { x: p1.x + u2.x * d, y: p1.y + u2.y * d };
    const bl = len({ x: u1.x + u2.x, y: u1.y + u2.y });
    const c: Pt = { x: p1.x + ((u1.x + u2.x) / bl) * (r / Math.sin(half)), y: p1.y + ((u1.y + u2.y) / bl) * (r / Math.sin(half)) };
    if (!subs.length) subs.push({ nodes: [], closed: false });
    pushNode(dev(t0.x, t0.y));
    cur = t0;
    const a0 = Math.atan2(t0.y - c.y, t0.x - c.x) / DEG;
    const a1 = Math.atan2(t1.y - c.y, t1.x - c.x) / DEG;
    appendArc(c.x, c.y, r, a0, arcSweep(a0, a1, true) > 180 ? arcSweep(a0, a1, false) : arcSweep(a0, a1, true));
  };

  const devPt = (p: Pt): PathNode => {
    const q = dev(p.x, p.y);
    return { x: q.x, y: q.y };
  };

  const nums = (k: number): number[] | null => {
    if (stack.length < k) return null;
    const res: number[] = [];
    for (let idx = stack.length - k; idx < stack.length; idx++) {
      const v = stack[idx];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      res.push(v);
    }
    stack.length -= k;
    return res;
  };

  /** Снять k операндов любого типа: текст и шрифты работают со строками, не с числами. */
  const popAny = (k: number) => {
    if (k > 0) stack.length = Math.max(0, stack.length - k);
  };

  const topName = (): string | null => {
    const v = stack[stack.length - 1];
    if (v && typeof v === 'object' && 't' in (v as Tok)) {
      const tok = v as Tok;
      if (tok.t === 'name') return tok.v;
    }
    return null;
  };

  const runProc = (items: Tok[]) => {
    if (depth > 48) return;
    depth += 1;
    exec(items);
    depth -= 1;
  };

  const exec = (list: Tok[]) => {
    for (let idx = 0; idx < list.length; idx++) {
      if (stopped || budget <= 0 || nodesTotal > MAX_NODES) { stopped = true; return; }
      budget -= 1;
      const tok = list[idx];
      switch (tok.t) {
        case 'num': case 'bool': case 'name': case 'str': case 'arr': case 'dict': case 'proc':
          stack.push(tok.t === 'num' ? tok.v : tok.t === 'bool' ? tok.v : tok);
          if (stack.length > 8192) stack.splice(0, stack.length - 4096);
          break;
        case 'layer':
          if (tok.v === null) {
            if (layerMarks.length) layerMarks.pop();
            if (layerNames.length) layerNames.pop();
          } else {
            layerMarks.push(layerByName(tok.v));
            layerNames.push(String(tok.v).trim().slice(0, 60) || null);
          }
          break;
        case 'op':
          runOp(tok.v);
          break;
        default:
          break;
      }
    }
  };

  const runOp = (op: string) => {
    // Определения из пролога файла важнее встроенных операторов: в PostScript
    // userdict просматривается раньше systemdict, а прологи EPS (gnuplot,
    // matplotlib, CorelDRAW, Illustrator) любят занимать однобуквенные имена,
    // которые совпадают с операторами PDF — /M /L /R /d /w /q.
    const defined = defs.get(op);
    if (defined) {
      if (defined.t === 'proc') runProc(defined.items);
      else if (defined.t === 'num') stack.push(defined.v);
      else if (defined.t === 'bool') stack.push(defined.v);
      else stack.push(defined);
      return;
    }
    // текстовый блок: геометрию шрифтов не читаем, но операнды разбираем
    if (textMode) {
      if (op === 'ET') { textMode = false; return; }
      const arity: Record<string, number> = {
        Tj: 1, TJ: 1, "'": 1, '"': 3, Tf: 2, Td: 2, TD: 2, Tm: 6, 'T*': 0, Tz: 1, Tw: 1, Tc: 1, TL: 1, Tr: 1, Ts: 1,
      };
      if (arity[op] !== undefined) { popAny(arity[op]); sawText = true; }
      return;
    }
    switch (op) {
      // ---- построение пути ----
      case 'moveto': case 'm': {
        const a = nums(2);
        if (!a) return;
        cur = { x: a[0], y: a[1] };
        subStart = cur;
        subs.push({ nodes: [devPt(cur)], closed: false });
        return;
      }
      case 'rmoveto': {
        const a = nums(2);
        if (!a || !cur) return;
        cur = { x: cur.x + a[0], y: cur.y + a[1] };
        if (!subs.length) subs.push({ nodes: [], closed: false });
        pushNode(dev(cur.x, cur.y));
        return;
      }
      case 'lineto': case 'l': {
        const a = nums(2);
        if (!a) return;
        if (!subs.length) subs.push({ nodes: [], closed: false });
        if (!cur) subs.push({ nodes: [devPt({ x: a[0], y: a[1] })], closed: false });
        else pushNode(dev(a[0], a[1]));
        cur = { x: a[0], y: a[1] };
        return;
      }
      case 'rlineto': {
        const a = nums(2);
        if (!a || !cur) return;
        cur = { x: cur.x + a[0], y: cur.y + a[1] };
        if (!subs.length) subs.push({ nodes: [], closed: false });
        pushNode(dev(cur.x, cur.y));
        return;
      }
      case 'curveto': case 'c': {
        const a = nums(6);
        if (!a) return;
        if (!subs.length) subs.push({ nodes: [], closed: false });
        if (!cur) subs.push({ nodes: [devPt({ x: a[0], y: a[1] })], closed: false });
        pushNode(dev(a[4], a[5]), dev(a[2], a[3]), dev(a[0], a[1]));
        cur = { x: a[4], y: a[5] };
        return;
      }
      case 'rcurveto': {
        const a = nums(6);
        if (!a || !cur) return;
        const p1 = { x: cur.x + a[0], y: cur.y + a[1] };
        const p2 = { x: cur.x + a[2], y: cur.y + a[3] };
        const p3 = { x: cur.x + a[4], y: cur.y + a[5] };
        if (!subs.length) subs.push({ nodes: [], closed: false });
        pushNode(dev(p3.x, p3.y), dev(p2.x, p2.y), dev(p1.x, p1.y));
        cur = p3;
        return;
      }
      case 'v': { // PDF: первая контрольная = текущая точка
        const a = nums(4);
        if (!a || !cur) return;
        if (!subs.length) subs.push({ nodes: [], closed: false });
        pushNode(dev(a[2], a[3]), dev(a[0], a[1]), dev(cur.x, cur.y));
        cur = { x: a[2], y: a[3] };
        return;
      }
      case 'y': { // PDF: вторая контрольная = конечная точка
        const a = nums(4);
        if (!a || !cur) return;
        if (!subs.length) subs.push({ nodes: [], closed: false });
        pushNode(dev(a[2], a[3]), dev(a[2], a[3]), dev(a[0], a[1]));
        cur = { x: a[2], y: a[3] };
        return;
      }
      case 'closepath': case 'h': {
        const sub = subs[subs.length - 1];
        if (sub) {
          sub.closed = true;
          if (subStart) cur = { x: subStart.x, y: subStart.y };
        }
        return;
      }
      case 're': { // PDF/AI прямоугольник
        const a = nums(4);
        if (!a) return;
        const [x, y, w, h] = a;
        subs.push({
          nodes: [devPt({ x, y }), devPt({ x: x + w, y }), devPt({ x: x + w, y: y + h }), devPt({ x, y: y + h })],
          closed: true,
        });
        cur = { x, y };
        subStart = cur;
        nodesTotal += 4;
        return;
      }
      case 'arc': case 'arcn': {
        const a = nums(5);
        if (!a) return;
        appendArc(a[0], a[1], Math.abs(a[2]), a[3], arcSweep(a[3], a[4], op === 'arc'));
        return;
      }
      case 'arct': case 'arct2': {
        const a = nums(5);
        if (!a) return;
        appendArct(a[0], a[1], a[2], a[3], Math.abs(a[4]));
        return;
      }
      case 'newpath': case 'n': case 'N':
        subs = [];
        cur = null;
        subStart = null;
        return;

      // ---- рисование ----
      case 'stroke': case 'S': case 's':
        if (op === 's' && subs.length) subs[subs.length - 1].closed = true;
        emit(false, true);
        return;
      case 'fill': case 'f': case 'F': case 'eofill': case 'f*':
        emit(true, false);
        return;
      case 'B': case 'B*': case 'b': case 'b*':
        if ((op === 'b' || op === 'b*') && subs.length) subs[subs.length - 1].closed = true;
        emit(true, true);
        return;
      case 'clip': case 'W': case 'W*': case 'eoclip':
        sawClip = true;
        subs = [];
        cur = null;
        return;
      case 'showpage': case 'copypage':
        if (opts.firstPageOnly) { stopped = true; return; }
        pages += 1;
        subs = [];
        cur = null;
        return;

      // ---- состояние ----
      case 'gsave': case 'q':
        states.push({ ...gs, ctm: [...gs.ctm] as Mat, stroke: [...gs.stroke] as [number, number, number], fill: [...gs.fill] as [number, number, number], dash: [...gs.dash] });
        gs = states[states.length - 1];
        return;
      case 'grestore': case 'Q': case 'grestoreall':
        if (states.length > 1) states.pop();
        gs = states[states.length - 1];
        return;
      case 'save':
        states.push({ ...gs, ctm: [...gs.ctm] as Mat, stroke: [...gs.stroke] as [number, number, number], fill: [...gs.fill] as [number, number, number], dash: [...gs.dash] });
        gs = states[states.length - 1];
        stack.push({ t: 'name', v: '__save__' });
        return;
      case 'restore':
        if (states.length > 1) states.pop();
        gs = states[states.length - 1];
        return;
      case 'initmatrix':
        gs.ctm = MAT_ID;
        return;
      case 'setmatrix': {
        const v = stack.pop();
        if (v && typeof v === 'object' && (v as Tok).t === 'arr') {
          const a = ((v as Tok & { t: 'arr' }).items).filter((q) => q.t === 'num').map((q) => (q as { v: number }).v);
          if (a.length >= 6) gs.ctm = [a[0], a[1], a[2], a[3], a[4], a[5]];
        }
        return;
      }
      case 'concat': case 'cm': {
        let a: number[] | null = null;
        if (op === 'cm') a = nums(6);
        else {
          const v = stack.pop();
          if (v && typeof v === 'object' && (v as Tok).t === 'arr') {
            a = ((v as Tok & { t: 'arr' }).items).filter((q) => q.t === 'num').map((q) => (q as { v: number }).v);
          }
        }
        if (a && a.length >= 6) gs.ctm = mulMat(gs.ctm, [a[0], a[1], a[2], a[3], a[4], a[5]]);
        return;
      }
      case 'translate': {
        const a = nums(2);
        if (a) gs.ctm = mulMat(gs.ctm, [1, 0, 0, 1, a[0], a[1]]);
        else stack.length = Math.max(0, stack.length - 1);
        return;
      }
      case 'scale': {
        const a = nums(2);
        if (!a) { stack.length = Math.max(0, stack.length - 1); return; }
        gs.ctm = mulMat(gs.ctm, [a[0], 0, 0, a[1], 0, 0]);
        return;
      }
      case 'rotate': {
        const a = nums(1);
        if (!a) return;
        const c = Math.cos(a[0] * DEG);
        const s = Math.sin(a[0] * DEG);
        gs.ctm = mulMat(gs.ctm, [c, s, -s, c, 0, 0]);
        return;
      }
      case 'setrgbcolor': case 'RG': case 'rg': {
        const a = nums(3);
        if (!a) return;
        const rgb: [number, number, number] = [clamp01(a[0]), clamp01(a[1]), clamp01(a[2])];
        if (op === 'RG') gs.stroke = rgb;
        else if (op === 'rg') gs.fill = rgb;
        else { gs.stroke = rgb; gs.fill = rgb; }
        return;
      }
      case 'setgray': case 'G': case 'g': {
        const a = nums(1);
        if (!a) return;
        const v = clamp01(a[0]);
        const rgb: [number, number, number] = [v, v, v];
        if (op === 'G') gs.stroke = rgb;
        else if (op === 'g') gs.fill = rgb;
        else { gs.stroke = rgb; gs.fill = rgb; }
        return;
      }
      case 'setcmykcolor': case 'K': case 'k': {
        const a = nums(4);
        if (!a) return;
        const rgb: [number, number, number] = [
          clamp01((1 - a[0]) * (1 - a[3])),
          clamp01((1 - a[1]) * (1 - a[3])),
          clamp01((1 - a[2]) * (1 - a[3])),
        ];
        if (op === 'K') gs.stroke = rgb;
        else if (op === 'k') gs.fill = rgb;
        else { gs.stroke = rgb; gs.fill = rgb; }
        return;
      }
      case 'setlinewidth': case 'w': {
        const a = nums(1);
        if (a) gs.width = a[0];
        return;
      }
      case 'setdash': case 'd': {
        const phase = stack.pop();
        const arr = stack.pop();
        const dash: number[] = [];
        if (arr && typeof arr === 'object' && (arr as Tok).t === 'arr') {
          for (const q of (arr as Tok & { t: 'arr' }).items) if (q.t === 'num') dash.push(q.v);
        }
        void phase;
        gs.dash = dash;
        return;
      }
      case 'setlinecap': case 'J': case 'setlinejoin': case 'j': case 'setmiterlimit': case 'M':
      case 'setflat': case 'setoverprint': case 'setstrokeadjust': case 'gs': case 'ri': case 'i':
        nums(1);
        return;
      case 'BDC': case 'BMC': {
        const props = stack.pop();
        const tag = stack.pop();
        const tagName = tag && typeof tag === 'object' && (tag as Tok).t === 'name' ? (tag as Tok & { t: 'name' }).v : '';
        let mark: LaserLayerId | null = null;
        let markName: string | null = null;
        if (tagName === 'OC' && props && typeof props === 'object') {
          const p = props as Tok;
          if (p.t === 'name' && opts.props) {
            const nm = opts.props[p.v];
            mark = layerByName(nm);
            markName = (nm || '').trim().slice(0, 60) || null;
          } else if (p.t === 'dict') {
            const name = dictString(p.items, 'Name');
            if (name) {
              mark = layerByName(name);
              markName = name.trim().slice(0, 60) || null;
            }
          }
        }
        layerMarks.push(mark);
        layerNames.push(markName);
        return;
      }
      case 'EMC':
        if (layerMarks.length) layerMarks.pop();
        if (layerNames.length) layerNames.pop();
        return;
      case 'Do': {
        const nm = topName();
        stack.length = Math.max(0, stack.length - 1);
        sawImage = true;
        if (!nm || !opts.resolveDo || depth > 6) return;
        const form = opts.resolveDo(nm);
        if (!form) return;
        states.push({ ...gs, ctm: mulMat(gs.ctm, form.matrix), stroke: [...gs.stroke] as [number, number, number], fill: [...gs.fill] as [number, number, number], dash: [...gs.dash] });
        const saved = gs;
        gs = states[states.length - 1];
        depth += 1;
        exec(form.toks);
        depth -= 1;
        states.pop();
        gs = saved;
        return;
      }
      case 'BT':
        textMode = true;
        sawText = true;
        return;
      // ---- текст PostScript: контуры шрифтов не читаем, но стек разбираем ----
      case 'show': case 'glyphshow':
        popAny(1);
        sawText = true;
        return;
      case 'ashow': case 'widthshow': case 'charpath': case 'stringwidth':
        popAny(op === 'ashow' ? 3 : 2);
        sawText = true;
        if (op === 'stringwidth') stack.push(0, 0);
        return;
      case 'awidthshow': case 'xshow': case 'yshow': case 'xyshow': case 'kshow':
        popAny(op === 'awidthshow' ? 4 : 2);
        sawText = true;
        return;
      case 'findfont': case 'currentfont': case 'fontDictionary':
        popAny(op === 'findfont' ? 1 : 0);
        stack.push({ t: 'dict', items: [] });
        return;
      case 'scalefont': case 'makefont': {
        nums(1);
        const font = stack.pop();
        stack.push(font ?? { t: 'dict', items: [] });
        return;
      }
      case 'setfont':
        popAny(1);
        return;
      case 'selectfont': case 'setcharwidth':
        popAny(2);
        return;
      case 'setcachedevice':
        popAny(6);
        return;
      case 'definefont': case 'undefinefont':
        popAny(2);
        stack.push({ t: 'dict', items: [] });
        return;
      case 'sh': case 'image': case 'imagemask': case 'colorimage':
        sawImage = true;
        stack.length = 0;
        return;
      // ---- стековые и служебные операторы (прологи EPS/AI) ----
      case 'dup': {
        const v = stack[stack.length - 1];
        if (v !== undefined) stack.push(v);
        return;
      }
      case 'exch': {
        const a = stack.pop();
        const b = stack.pop();
        if (a !== undefined) stack.push(a);
        if (b !== undefined) stack.push(b);
        return;
      }
      case 'currentpoint':
        if (cur) { stack.push(cur.x, cur.y); } else { stack.push(0, 0); }
        return;
      case 'pop': case 'pathbbox': case 'currentdash': case 'currentlinewidth':
      case 'currentgray': case 'currentrgbcolor': case 'currentcmykcolor': case 'currentmatrix':
      case 'currentlinecap': case 'currentlinejoin': case 'currentmiterlimit': case 'currentflat':
        stack.length = Math.max(0, stack.length - 1);
        return;
      case 'index': {
        const a = nums(1);
        if (!a) return;
        const k = Math.trunc(a[0]);
        const v = stack[stack.length - 1 - k];
        if (v !== undefined) stack.push(v);
        return;
      }
      case 'roll': {
        const a = nums(2);
        if (!a) return;
        const count = Math.trunc(a[0]);
        const shift = Math.trunc(a[1]);
        if (count <= 0 || count > stack.length) return;
        const tail = stack.splice(stack.length - count, count);
        const s = ((shift % count) + count) % count;
        stack.push(...tail.slice(count - s), ...tail.slice(0, count - s));
        return;
      }
      case 'copy': {
        const a = nums(1);
        if (!a) { stack.length = Math.max(0, stack.length - 2); return; }
        const count = Math.trunc(a[0]);
        if (count > 0 && count <= stack.length) stack.push(...stack.slice(stack.length - count));
        return;
      }
      case 'clear':
        stack.length = 0;
        return;
      case 'count':
        stack.push(stack.length);
        return;
      case 'add': case 'sub': case 'mul': case 'div': case 'idiv': case 'mod': case 'exp':
      case 'atan': case 'max': case 'min': {
        const a = nums(2);
        if (!a) return;
        const [x, y] = a;
        let r = 0;
        if (op === 'add') r = x + y;
        else if (op === 'sub') r = x - y;
        else if (op === 'mul') r = x * y;
        else if (op === 'div') r = y === 0 ? 0 : x / y;
        else if (op === 'idiv') r = y === 0 ? 0 : Math.trunc(x / y);
        else if (op === 'mod') r = y === 0 ? 0 : x % y;
        else if (op === 'exp') r = Math.pow(x, y);
        else if (op === 'atan') r = Math.atan2(x, y) / DEG;
        else if (op === 'max') r = Math.max(x, y);
        else r = Math.min(x, y);
        stack.push(r);
        return;
      }
      case 'neg': case 'abs': case 'sqrt': case 'ceiling': case 'floor': case 'round': case 'truncate':
      case 'sin': case 'cos': case 'log': case 'ln': {
        const a = nums(1);
        if (!a) return;
        const x = a[0];
        let r = x;
        if (op === 'neg') r = -x;
        else if (op === 'abs') r = Math.abs(x);
        else if (op === 'sqrt') r = Math.sqrt(Math.max(0, x));
        else if (op === 'ceiling') r = Math.ceil(x);
        else if (op === 'floor') r = Math.floor(x);
        else if (op === 'round') r = Math.round(x);
        else if (op === 'truncate') r = Math.trunc(x);
        else if (op === 'sin') r = Math.sin(x * DEG);
        else if (op === 'cos') r = Math.cos(x * DEG);
        else if (op === 'log') r = Math.log10(Math.max(1e-12, x));
        else r = Math.log(Math.max(1e-12, x));
        stack.push(r);
        return;
      }
      case 'eq': case 'ne': case 'lt': case 'gt': case 'le': case 'ge': case 'and': case 'or': case 'xor': {
        const a = nums(2);
        if (!a) { stack.length = Math.max(0, stack.length - 2); return; }
        const [x, y] = a;
        let r = false;
        if (op === 'eq') r = x === y;
        else if (op === 'ne') r = x !== y;
        else if (op === 'lt') r = x < y;
        else if (op === 'gt') r = x > y;
        else if (op === 'le') r = x <= y;
        else if (op === 'ge') r = x >= y;
        else if (op === 'and') r = (x !== 0) === (y !== 0);
        else if (op === 'or') r = (x !== 0) || (y !== 0);
        else r = (x !== 0) !== (y !== 0);
        stack.push(r);
        return;
      }
      case 'not': {
        const a = nums(1);
        stack.push(a ? a[0] === 0 : false);
        return;
      }
      case 'if': {
        const proc = stack.pop();
        const cond = stack.pop();
        if (cond === true && proc && typeof proc === 'object' && (proc as Tok).t === 'proc') {
          runProc((proc as Tok & { t: 'proc' }).items);
        }
        return;
      }
      case 'ifelse': {
        const p2 = stack.pop();
        const p1 = stack.pop();
        const cond = stack.pop();
        const pick = cond === true ? p1 : p2;
        if (pick && typeof pick === 'object' && (pick as Tok).t === 'proc') runProc((pick as Tok & { t: 'proc' }).items);
        return;
      }
      case 'repeat': {
        const proc = stack.pop();
        const a = nums(1);
        if (!a || !proc || typeof proc !== 'object' || (proc as Tok).t !== 'proc') return;
        const times = Math.min(50_000, Math.max(0, Math.trunc(a[0])));
        for (let k = 0; k < times && !stopped; k++) runProc((proc as Tok & { t: 'proc' }).items);
        return;
      }
      case 'for': {
        const proc = stack.pop();
        const a = nums(3);
        if (!a || !proc || typeof proc !== 'object' || (proc as Tok).t !== 'proc') return;
        const [init, incr, limit] = a;
        if (!incr) return;
        let v = init;
        let guard = 0;
        while ((incr > 0 ? v <= limit : v >= limit) && guard < 50_000 && !stopped) {
          stack.push(v);
          runProc((proc as Tok & { t: 'proc' }).items);
          v += incr;
          guard += 1;
        }
        return;
      }
      case 'forall': {
        const proc = stack.pop();
        const obj = stack.pop();
        if (!proc || typeof proc !== 'object' || (proc as Tok).t !== 'proc') return;
        const items = obj && typeof obj === 'object' && (obj as Tok).t === 'arr' ? (obj as Tok & { t: 'arr' }).items : [];
        let guard = 0;
        for (const it of items) {
          if (guard++ > 50_000 || stopped) break;
          stack.push(it.t === 'num' ? it.v : it);
          runProc((proc as Tok & { t: 'proc' }).items);
        }
        return;
      }
      case 'loop': {
        const proc = stack.pop();
        if (!proc || typeof proc !== 'object' || (proc as Tok).t !== 'proc') return;
        let guard = 0;
        while (guard++ < 50_000 && !stopped) runProc((proc as Tok & { t: 'proc' }).items);
        return;
      }
      case 'exec': {
        const v = stack.pop();
        if (v && typeof v === 'object' && (v as Tok).t === 'proc') runProc((v as Tok & { t: 'proc' }).items);
        return;
      }
      case 'exit': case 'stop': case 'quit':
        stopped = true;
        return;
      case 'def': case 'store': {
        const value = stack.pop();
        const key = stack.pop();
        if (key && typeof key === 'object' && (key as Tok).t === 'name' && value && typeof value === 'object') {
          defs.set((key as Tok & { t: 'name' }).v, value as Tok);
        }
        return;
      }
      case 'bind': case 'cvx': case 'cvn': case 'xcheck': case 'readonly': case 'executeonly':
      case 'noaccess':
        // значение остаётся на стеке как есть: исполняемость мы не моделируем
        return;
      case 'load': {
        const key = stack.pop();
        if (key && typeof key === 'object' && (key as Tok).t === 'name') {
          const v = defs.get((key as Tok & { t: 'name' }).v);
          if (v) { stack.push(v); return; }
        }
        return;
      }
      case 'undef': {
        const key = stack.pop();
        stack.length = Math.max(0, stack.length - 1);
        if (key && typeof key === 'object' && (key as Tok).t === 'name') defs.delete((key as Tok & { t: 'name' }).v);
        return;
      }
      case 'put': case 'known': case 'get': case 'where': case 'type':
        stack.length = Math.max(0, stack.length - (op === 'put' ? 2 : 1));
        return;
      case 'dict': case 'array': case 'string': case 'mark': {
        nums(1);
        stack.push({ t: 'arr', items: [] });
        return;
      }
      case 'begin': case 'end': case 'currentdict': case 'cleartomark': case 'counttomark':
      case 'length': case 'null': case 'true': case 'false':
        if (op === 'true') stack.push(true);
        else if (op === 'false') stack.push(false);
        else stack.length = Math.max(0, stack.length - 1);
        return;
      default:
        unknown.set(op, (unknown.get(op) ?? 0) + 1);
        return;
    }
  };

  exec(toks);

  if (subs.length) emit(false, true); // незакрытый путь в конце потока
  if (sawText) {
    opts.notes.push('Текст в файле не распознан: переведите надписи в кривые (в CorelDRAW — «Преобразовать в кривые», в Illustrator — Type → Create Outlines).');
  }
  if (sawImage) opts.notes.push('Растровые вставки и маски пропущены — импортируется только вектор.');
  if (sawClip) opts.notes.push('Области обрезки (clip) пропущены: геометрия внутри них импортирована целиком.');
  if (unknown.size) {
    const top = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`);
    opts.notes.push(`Пропущено неизвестных операторов: ${top.join(', ')}.`);
  }
  if (stopped && budget <= 0) opts.notes.push('Файл очень большой: разбор остановлен по лимиту операций.');
  if (nodesTotal > MAX_NODES) opts.notes.push('Достигнут предел числа точек — часть геометрии не импортирована.');
  return pages;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/** Строковое значение ключа из токенов словаря (для /Name (CUT)). */
function dictString(items: Tok[], key: string): string | null {
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];
    if (a.t === 'name' && a.v === key && b.t === 'str') return b.v;
  }
  return null;
}

// ---------------- EPS / PS / AI ----------------

/** Начало координат страницы из DSC-комментария (%%HiResBoundingBox / %%BoundingBox). */
function psOrigin(text: string): { x: number; y: number } {
  const hi = /%%HiResBoundingBox:\s*([-+.\d]+)\s+([-+.\d]+)/i.exec(text);
  if (hi) return { x: parseFloat(hi[1]), y: parseFloat(hi[2]) };
  const bb = /%%BoundingBox:\s*([-+.\d]+)\s+([-+.\d]+)/i.exec(text);
  if (bb) return { x: parseFloat(bb[1]), y: parseFloat(bb[2]) };
  return { x: 0, y: 0 };
}

/**
 * Импорт EPS/PS/AI: мини-интерпретатор PostScript с матрицами, цветами,
 * пунктиром и приватными операторами Illustrator. Координаты переводятся из
 * пунктов в миллиметры, начало отсчёта — левый нижний угол BoundingBox.
 */
export function parsePostScript(text: string, label = 'EPS'): VectorImportResult {
  const notes: string[] = [];
  const origin = psOrigin(text);
  const toks = tokenizePs(text);
  const shapes: LaserShape[] = [];
  const pages = runPsTokens(toks, shapes, {
    label,
    unitMm: MM_PER_PT,
    ox: origin.x,
    oy: origin.y,
    notes,
    firstPageOnly: true,
  });
  if (!shapes.length && !notes.length) notes.push('В файле не найдено векторных объектов.');
  return { shapes, notes, pages, kind: 'ps' };
}

// ---------------- PDF ----------------

interface PdfObject {
  num: number;
  dict: string;
  raw: Uint8Array | null;
}

/** Байты → строка latin1 (один байт = один символ), чтобы не потерять потоки. */
function latin1(bytes: Uint8Array): string {
  let out = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

type DecStream = new (format: string) => ReadableWritablePair<Uint8Array, Uint8Array>;

async function inflate(data: Uint8Array): Promise<Uint8Array | null> {
  const DS = (globalThis as Record<string, unknown>).DecompressionStream as DecStream | undefined;
  if (typeof DS !== 'function') return null;
  for (const fmt of ['deflate', 'deflate-raw', 'gzip']) {
    try {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DS(fmt));
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
      let len = 0;
      for (const c of chunks) len += c.length;
      if (!len) continue;
      const out = new Uint8Array(len);
      let p = 0;
      for (const c of chunks) { out.set(c, p); p += c.length; }
      return out;
    } catch { /* пробуем следующий формат обёртки zlib */ }
  }
  return null;
}

function ascii85Decode(src: string): Uint8Array {
  const clean = src.replace(/\s+/g, '').replace(/~>[\s\S]*$/, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of clean) {
    if (ch === 'z') { out.push(0, 0, 0, 0); continue; }
    const v = ch.charCodeAt(0) - 33;
    if (v < 0 || v > 84) continue;
    group.push(v);
    if (group.length === 5) {
      let acc = 0;
      for (const q of group) acc = acc * 85 + q;
      out.push((acc >>> 24) & 255, (acc >>> 16) & 255, (acc >>> 8) & 255, acc & 255);
      group = [];
    }
  }
  if (group.length) {
    while (group.length < 5) group.push(84);
    let acc = 0;
    for (const q of group) acc = acc * 85 + q;
    const bytes = [(acc >>> 24) & 255, (acc >>> 16) & 255, (acc >>> 8) & 255, acc & 255];
    out.push(...bytes.slice(0, group.length - 2));
  }
  return new Uint8Array(out);
}

function asciiHexDecode(src: string): Uint8Array {
  const clean = src.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return new Uint8Array(out);
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const len = data[i];
    if (len === 128) break;
    if (len < 128) {
      for (let k = 1; k <= len + 1; k++) out.push(data[i + k]);
      i += len + 1;
    } else {
      const next = data[i + 1];
      for (let k = 0; k < 257 - len; k++) out.push(next);
      i += 1;
    }
  }
  return new Uint8Array(out);
}

/** Числа из значения ключа словаря: «/MediaBox [0 0 100 200]» → [0,0,100,200]. */
function dictNums(dict: string, key: string): number[] | null {
  // массив в скобках берём целиком («/MediaBox [0 0 100 200]»), а голую
  // последовательность чисел («/Rotate 90») — до следующего ключа или конца
  // словаря; пробелы вокруг разделителей обязательны к учёту, иначе ключ «не находится»
  const arr = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`, 'i').exec(dict);
  const src = arr
    ? arr[1]
    : new RegExp(`/${key}\\s*((?:[-+]?\\d*\\.?\\d+\\s*)+?)(?=\\s*(?:/[A-Za-z]|>>|$))`, 'i').exec(dict)?.[1];
  if (src === undefined) return null;
  const nums = (src.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) ?? []).map(Number);
  return nums.length ? nums : null;
}

function dictRef(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`, 'i').exec(dict);
  return m ? parseInt(m[1], 10) : null;
}

function dictName(dict: string, key: string): string | null {
  const m = new RegExp(`/${key}\\s*/([A-Za-z0-9_.]+)`, 'i').exec(dict);
  return m ? m[1] : null;
}

/**
 * Значение-словарь ключа с учётом вложенности: /Resources << /Properties << … >> >>.
 * Обычный regex здесь врёт — он обрывается на первом закрытии вложенного словаря.
 */
function extractDict(src: string, key: string): string | null {
  const start = new RegExp(`/${key}\\s*<<`, 'i').exec(src);
  if (!start) return null;
  let depth = 1;
  let i = start.index + start[0].length;
  const from = i;
  while (i < src.length && depth > 0) {
    if (src[i] === '<' && src[i + 1] === '<') { depth += 1; i += 2; continue; }
    if (src[i] === '>' && src[i + 1] === '>') { depth -= 1; i += 2; continue; }
    i += 1;
  }
  return src.slice(from, Math.max(from, i - 2));
}

function dictFilters(dict: string): string[] {
  const arr = /\/Filter\s*\[([^\]]*)\]/i.exec(dict);
  if (arr) return (arr[1].match(/\/[A-Za-z0-9]+/g) ?? []).map((s) => s.slice(1));
  const one = /\/Filter\s*\/([A-Za-z0-9]+)/i.exec(dict);
  return one ? [one[1]] : [];
}

async function decodeStream(obj: PdfObject, notes: string[]): Promise<Uint8Array | null> {
  if (!obj.raw) return null;
  let data = obj.raw;
  for (const f of dictFilters(obj.dict)) {
    if (f === 'FlateDecode' || f === 'Fl') {
      const inf = await inflate(data);
      if (!inf) {
        notes.push('Поток сжат FlateDecode, но DecompressionStream недоступен — страница пропущена.');
        return null;
      }
      data = inf;
    } else if (f === 'ASCII85Decode' || f === 'A85') {
      data = ascii85Decode(latin1(data));
    } else if (f === 'ASCIIHexDecode' || f === 'AHx') {
      data = asciiHexDecode(latin1(data));
    } else if (f === 'RunLengthDecode' || f === 'RL') {
      data = runLengthDecode(data);
    } else {
      notes.push(`Фильтр /${f} не поддерживается — часть данных страницы пропущена.`);
      return null;
    }
  }
  return data;
}

/** Объекты PDF: словарь + сырой поток. Таблица xref не нужна — ищем по «N 0 obj». */
function scanPdfObjects(text: string, bytes: Uint8Array): Map<number, PdfObject> {
  const objs = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    const bodyStart = m.index + m[0].length;
    let end = text.indexOf('endobj', bodyStart);
    if (end < 0) end = text.length;
    const body = text.slice(bodyStart, end);
    const sIdx = body.search(/\bstream\b/);
    let dict = body;
    let raw: Uint8Array | null = null;
    if (sIdx >= 0) {
      dict = body.slice(0, sIdx);
      let dataStart = bodyStart + sIdx + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      const lenMatch = /\/Length\s+(\d+)(?!\s*\d+\s*R)/i.exec(dict);
      let dataEnd = -1;
      if (lenMatch) {
        const cand = dataStart + parseInt(lenMatch[1], 10);
        if (cand <= bodyStart + body.length) dataEnd = cand;
      }
      if (dataEnd < 0) {
        dataEnd = text.lastIndexOf('endstream', bodyStart + body.length);
        if (dataEnd < dataStart) dataEnd = bodyStart + body.length;
        while (dataEnd > dataStart && (text[dataEnd - 1] === '\n' || text[dataEnd - 1] === '\r')) dataEnd -= 1;
      }
      raw = bytes.subarray(dataStart, dataEnd);
    }
    if (!objs.has(num)) objs.set(num, { num, dict, raw });
    re.lastIndex = bodyStart + body.length;
  }
  return objs;
}

/** Распаковка /ObjStm (PDF 1.5): объекты-словари лежат внутри сжатого потока. */
async function expandObjStm(objs: Map<number, PdfObject>, notes: string[]): Promise<void> {
  const streams = [...objs.values()].filter((o) => /\/Type\s*\/ObjStm\b/i.test(o.dict));
  for (const o of streams) {
    const data = await decodeStream(o, notes);
    if (!data) continue;
    const text = latin1(data);
    const count = dictNums(o.dict, 'N')?.[0] ?? 0;
    const first = dictNums(o.dict, 'First')?.[0] ?? 0;
    const head = text.slice(0, first).match(/\d+/g) ?? [];
    for (let k = 0; k < count && k * 2 + 1 < head.length; k++) {
      const num = parseInt(head[k * 2], 10);
      const off = parseInt(head[k * 2 + 1], 10);
      const nextOff = k * 2 + 3 < head.length ? parseInt(head[k * 2 + 3], 10) : text.length - first;
      if (!Number.isFinite(num) || !Number.isFinite(off)) continue;
      const dict = text.slice(first + off, first + Math.max(off, nextOff));
      if (!objs.has(num)) objs.set(num, { num, dict, raw: null });
    }
  }
}

function kidsOf(dict: string): number[] {
  const m = /\/Kids\s*\[([^\]]*)\]/i.exec(dict);
  if (!m) return [];
  return (m[1].match(/(\d+)\s+\d+\s+R/g) ?? []).map((s) => parseInt(s, 10));
}

/**
 * Импорт векторного PDF (и современного .ai, который сохраняется как PDF):
 * первая страница, точные кривые Безье из контент-потока, слои из OCG.
 * Потоки FlateDecode распаковываются через DecompressionStream, поэтому
 * функция асинхронная.
 */
export async function parsePdfVector(bytes: Uint8Array): Promise<VectorImportResult> {
  const notes: string[] = [];
  if (bytes.length > MAX_BYTES) throw new Error('Файл больше 64 МБ — импорт PDF отменён.');
  const text = latin1(bytes);
  const objs = scanPdfObjects(text, bytes);
  await expandObjStm(objs, notes);

  // порядок страниц — из дерева /Pages, иначе по номерам объектов
  const pages: number[] = [];
  const walk = (num: number, depth: number) => {
    if (depth > 16) return;
    const o = objs.get(num);
    if (!o) return;
    if (/\/Type\s*\/Page\b(?!s)/i.test(o.dict)) { pages.push(num); return; }
    for (const k of kidsOf(o.dict)) walk(k, depth + 1);
  };
  const catalog = [...objs.values()].find((o) => /\/Type\s*\/Catalog\b/i.test(o.dict));
  const rootRef = catalog ? dictRef(catalog.dict, 'Pages') : null;
  if (rootRef) walk(rootRef, 0);
  if (!pages.length) {
    for (const o of objs.values()) if (/\/Type\s*\/Page\b(?!s)/i.test(o.dict)) pages.push(o.num);
    pages.sort((a, b) => a - b);
  }
  if (!pages.length) {
    notes.push('Страницы не найдены: возможно, PDF зашифрован или повреждён.');
    return { shapes: [], notes, pages: 0, kind: 'pdf' };
  }

  const pageObj = objs.get(pages[0]) as PdfObject;
  const pageDict = resolveInherited(pageObj.dict, objs, 'MediaBox');
  const mbox = dictNums(pageDict, 'MediaBox') ?? [0, 0, 0, 0];
  const rotate = dictNums(resolveInherited(pageObj.dict, objs, 'Rotate'), 'Rotate')?.[0] ?? 0;
  if (rotate) notes.push(`Страница повёрнута на ${rotate}° — поворот при импорте не применяется.`);

  // содержимое страницы: одна ссылка или массив потоков
  const contentsDict = /\/Contents\s*\[([^\]]*)\]/i.exec(pageObj.dict);
  const refs: number[] = contentsDict
    ? (contentsDict[1].match(/(\d+)\s+\d+\s+R/g) ?? []).map((s) => parseInt(s, 10))
    : (() => { const r = dictRef(pageObj.dict, 'Contents'); return r ? [r] : []; })();

  // ресурсы: свойства (OCG) и формы XObject
  const resNum = dictRef(pageObj.dict, 'Resources');
  const resDict = resNum ? (objs.get(resNum)?.dict ?? '') : (extractDict(pageObj.dict, 'Resources') ?? '');
  const props: Record<string, string> = {};
  const xobjects: Record<string, number> = {};
  const propBlock = extractDict(resDict, 'Properties');
  if (propBlock) {
    const pairs = propBlock.match(/\/([A-Za-z0-9_.]+)\s+(\d+)\s+\d+\s+R/g) ?? [];
    for (const p of pairs) {
      const m = /\/([A-Za-z0-9_.]+)\s+(\d+)\s+\d+\s+R/.exec(p);
      if (!m) continue;
      const ocg = objs.get(parseInt(m[2], 10));
      const name = ocg ? (/\/Name\s*\(([^)]*)\)/i.exec(ocg.dict)?.[1] ?? dictName(ocg.dict, 'Name')) : null;
      if (name) props[m[1]] = name;
    }
  }
  const xoBlock = extractDict(resDict, 'XObject');
  if (xoBlock) {
    const pairs = xoBlock.match(/\/([A-Za-z0-9_.]+)\s+(\d+)\s+\d+\s+R/g) ?? [];
    for (const p of pairs) {
      const m = /\/([A-Za-z0-9_.]+)\s+(\d+)\s+\d+\s+R/.exec(p);
      if (m) xobjects[m[1]] = parseInt(m[2], 10);
    }
  }

  const shapes: LaserShape[] = [];

  // формы XObject готовим заранее (распаковка потока асинхронная),
  // после чего интерпретатор ходит по ним синхронно через resolveDo
  const prepared = new Map<string, { toks: Tok[]; matrix: Mat }>();
  for (const [name, num] of Object.entries(xobjects)) {
    const o = objs.get(num);
    if (!o || !/\/Subtype\s*\/Form/i.test(o.dict)) continue;
    const data = await decodeStream(o, notes);
    if (!data) continue;
    const mx = dictNums(o.dict, 'Matrix');
    prepared.set(name, {
      toks: tokenizePs(stripInlineImages(latin1(data))),
      matrix: mx && mx.length >= 6 ? [mx[0], mx[1], mx[2], mx[3], mx[4], mx[5]] : MAT_ID,
    });
  }
  for (const ref of refs) {
    const o = objs.get(ref);
    if (!o) continue;
    const data = await decodeStream(o, notes);
    if (!data) continue;
    const toks = tokenizePs(stripInlineImages(latin1(data)));
    runPsTokens(toks, shapes, {
      label: 'PDF',
      unitMm: MM_PER_PT,
      ox: mbox[0] ?? 0,
      oy: mbox[1] ?? 0,
      props,
      resolveDo: (name: string) => prepared.get(name) ?? null,
      notes,
      firstPageOnly: false,
    });
  }

  if (pages.length > 1) notes.push(`В файле ${pages.length} страниц — импортирована первая.`);
  if (!shapes.length && !notes.length) notes.push('Векторных объектов на странице не найдено (возможно, страница растровая).');
  return { shapes, notes, pages: pages.length, kind: 'pdf' };
}

/** Значение ключа с учётом наследования от /Pages. */
function resolveInherited(dict: string, objs: Map<number, PdfObject>, key: string): string {
  if (new RegExp(`/${key}\\b`, 'i').test(dict)) return dict;
  const parent = dictRef(dict, 'Parent');
  if (parent) {
    const p = objs.get(parent);
    if (p) return resolveInherited(p.dict, objs, key);
  }
  return dict;
}

/** Инлайн-картинки BI … ID <двоичные данные> EI вырезаются: они ломают токены. */
function stripInlineImages(src: string): string {
  return src.replace(/\bBI\b[\s\S]{0,400000}?\bID\b[\s\S]{0,400000}?\bEI\b/g, ' ');
}

// ---------------- PLT / HPGL ----------------

const PEN_LAYER: LaserLayerId[] = ['cut', 'inner', 'fold', 'score', 'engrave', 'guide'];

interface PltCmd { cmd: string; nums: number[] }

/** Разбор команд HPGL: двухбуквенный код + числовые параметры до «;». */
export function tokenizePlt(text: string): PltCmd[] {
  const out: PltCmd[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && (WS.includes(text[i]) || text[i] === ';')) i += 1;
    if (i >= n) break;
    if (!/[A-Za-z]/.test(text[i])) { i += 1; continue; }
    const cmd = text.slice(i, i + 2).toUpperCase();
    i += 2;
    if (cmd === 'LB' || cmd === 'SM' || cmd === 'TD' || cmd === 'DT') {
      // текст подписи: до терминатора (ESC по умолчанию) или до ';'
      while (i < n && text[i] !== ';' && text.charCodeAt(i) !== 3) i += 1;
      i += 1;
      out.push({ cmd, nums: [] });
      continue;
    }
    let j = i;
    while (j < n && text[j] !== ';' && !/[A-Za-z]/.test(text[j])) j += 1;
    const raw = text.slice(i, j);
    const nums = (raw.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
    i = j < n && text[j] === ';' ? j + 1 : j;
    out.push({ cmd, nums });
  }
  return out;
}

/**
 * Импорт HPGL/PLT: полилинии PU/PD/PA/PR, дуги AA/AR, окружности CI,
 * прямоугольники RA/RR/EA, перо SP → слой чертежа, масштаб SC (если задан IP),
 * поворот RO и единицы IU. Координаты HPGL направлены так же, как мир чертежа
 * (Y вверх), поэтому переворота нет: 40 юнитов = 1 мм.
 */
export function parsePlt(text: string): VectorImportResult {
  const notes: string[] = [];
  const cmds = tokenizePlt(text);
  const shapes: LaserShape[] = [];
  let pen = 1;
  let dashLt = 0;
  let unitsPerMm = HPGL_UNITS_PER_MM;
  let p1: Pt = { x: 0, y: 0 };
  let p2: Pt | null = null;
  let sc: number[] | null = null;
  let rot = 0;
  let cur: Pt | null = null;      // мм
  let pts: Pt[] = [];             // текущая полилиния, мм
  let penDown = false;
  const unknown = new Map<string, number>();

  const toMm = (x: number, y: number): Pt => {
    let ux = x;
    let uy = y;
    if (sc && sc.length >= 4 && p2) {
      const [xmin, xmax, ymin, ymax] = sc;
      const kx = xmax - xmin !== 0 ? (p2.x - p1.x) / (xmax - xmin) : 1;
      const ky = ymax - ymin !== 0 ? (p2.y - p1.y) / (ymax - ymin) : 1;
      ux = p1.x + (x - xmin) * kx;
      uy = p1.y + (y - ymin) * ky;
    }
    if (rot) {
      const a = rot * DEG;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rx = ux * c - uy * s;
      const ry = ux * s + uy * c;
      ux = rx;
      uy = ry;
    }
    return { x: (ux - p1.x) / unitsPerMm, y: (uy - p1.y) / unitsPerMm };
  };

  const layerFor = (): LaserLayerId => {
    const id = PEN_LAYER[pen - 1];
    if (id) return id;
    return dashLt >= 2 ? 'fold' : 'cut';
  };

  const flush = () => {
    if (pts.length < 2) { pts = []; return; }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = Math.hypot(last.x - first.x, last.y - first.y) < 1e-9;
    const nodes: PathNode[] = (closed ? pts.slice(0, -1) : pts).map((q) => ({ x: q.x, y: q.y }));
    pts = [];
    if (nodes.length < 2) return;
    shapes.push({
      id: luid('plt'),
      kind: 'path',
      layer: layerFor(),
      name: 'PLT Полилиния',
      nodes,
      closed,
      filled: false,
    });
  };

  const addPairs = (nums: number[], relative: boolean) => {
    for (let k = 0; k + 1 < nums.length; k += 2) {
      let x = nums[k];
      let y = nums[k + 1];
      if (relative && cur) {
        // относительные координаты приходят в юнитах: переводим через текущую точку
        const base = toMm(p1.x, p1.y);
        x = (cur.x - base.x) * unitsPerMm + x;
        y = (cur.y - base.y) * unitsPerMm + y;
        const next = toMm(x + base.x, y + base.y);
        cur = next;
      } else {
        cur = toMm(x, y);
      }
      if (penDown) pts.push({ x: cur.x, y: cur.y });
    }
  };

  for (const { cmd, nums } of cmds) {
    switch (cmd) {
      case 'IN': case 'DF': case 'NR': case 'EC': case 'OE': case 'OO':
        if (cmd === 'IN') { flush(); cur = null; pts = []; penDown = false; }
        break;
      case 'IU':
        if (nums.length >= 1 && nums[0] > 0) unitsPerMm = nums[0] / 25.4;
        break;
      case 'IP':
        if (nums.length >= 4) { p1 = { x: nums[0], y: nums[1] }; p2 = { x: nums[2], y: nums[3] }; }
        else if (nums.length >= 2) { p1 = { x: nums[0], y: nums[1] }; }
        break;
      case 'SC':
        sc = nums.length >= 4 ? nums : null;
        if (nums.length >= 4 && !p2) notes.push('Масштаб SC задан без IP: координаты взяты как юниты плоттера (40/мм).');
        break;
      case 'RO':
        rot = nums.length ? nums[0] : 0;
        break;
      case 'SP':
        flush();
        pen = nums.length ? Math.round(nums[0]) : 1;
        break;
      case 'LT':
        dashLt = nums.length ? Math.round(nums[0]) : 1;
        break;
      case 'PU':
        flush();
        penDown = false;
        if (nums.length >= 2) addPairs(nums, false);
        break;
      case 'PD':
        if (!penDown && cur) { pts = [{ x: cur.x, y: cur.y }]; }
        penDown = true;
        addPairs(nums, false);
        break;
      case 'PA':
        if (penDown && !pts.length && cur) pts = [{ x: cur.x, y: cur.y }];
        if (!penDown) flush();
        addPairs(nums, false);
        break;
      case 'PR':
        if (penDown && !pts.length && cur) pts = [{ x: cur.x, y: cur.y }];
        if (!penDown) flush();
        addPairs(nums, true);
        break;
      case 'AA': case 'AR': {
        if (nums.length < 5) break;
        // дуга — самостоятельный контур: соединительная линия от хвоста прошлого
        // контура склеила бы разные фигуры в одну
        flush();
        const rel = cmd === 'AR';
        const cx = rel && cur ? cur.x * unitsPerMm + nums[0] : nums[0];
        const cy = rel && cur ? cur.y * unitsPerMm + nums[1] : nums[1];
        const r = Math.abs(nums[2]);
        const a0 = nums[3];
        const sweep = nums[4];
        const chord = nums.length > 5 && nums[5] > 0 ? nums[5] : 5;
        const c = toMm(cx, cy);
        const rm = r / unitsPerMm;
        const segs = Math.max(2, Math.min(720, Math.ceil(Math.abs(sweep) / chord)));
        for (let k = 0; k <= segs; k++) {
          const a = (a0 + (sweep * k) / segs) * DEG;
          const q = { x: c.x + rm * Math.cos(a), y: c.y + rm * Math.sin(a) };
          if (!pts.length) pts = [q];
          else pts.push(q);
          cur = q;
        }
        penDown = true;
        break;
      }
      case 'CI': {
        flush();
        const r = nums.length >= 3 ? Math.abs(nums[2]) : Math.abs(nums[0] ?? 0);
        const c = nums.length >= 3 ? toMm(nums[0], nums[1]) : cur;
        if (!c || r <= 0) break;
        shapes.push({
          id: luid('plt'),
          kind: 'ellipse',
          layer: layerFor(),
          name: 'PLT Окружность',
          cx: c.x, cy: c.y, rx: r / unitsPerMm, ry: r / unitsPerMm,
          rot: 0, startAngle: 0, endAngle: 360, filled: false,
        });
        break;
      }
      case 'RA': case 'RR': case 'EA': case 'EP': {
        if (nums.length < 2 || !cur) break;
        const rel = cmd === 'RR';
        const target: Pt = rel
          ? { x: cur.x + nums[0] / unitsPerMm, y: cur.y + nums[1] / unitsPerMm }
          : toMm(nums[0], nums[1]);
        const x = Math.min(cur.x, target.x);
        const y = Math.min(cur.y, target.y);
        const w = Math.abs(target.x - cur.x);
        const h = Math.abs(target.y - cur.y);
        flush();
        if (w < 1e-9 || h < 1e-9) break;
        shapes.push({
          id: luid('plt'),
          kind: 'rect',
          layer: layerFor(),
          name: 'PLT Прямоугольник',
          x, y, w, h, rx: 0, rot: 0, filled: false,
        });
        cur = target;
        break;
      }
      case 'PE':
        notes.push('Команда PE (полилиния в кодировке HPGL) не поддерживается — участок пропущен.');
        break;
      case 'WG': case 'EW': case 'FT': case 'PM': case 'FP': case 'EP2':
        notes.push('Заливки HPGL (WG/FT/PM) не поддерживаются — импортируются только контуры.');
        break;
      case 'VS': case 'PW': case 'PS': case 'IW': case 'NP': case 'PC': case 'PT': case 'CS':
      case 'CT': case 'MG': case 'MT': case 'NC': case 'OC': case 'OF': case 'OH': case 'OL':
      case 'OP': case 'OS': case 'OT': case 'OV': case 'SA': case 'SS': case 'ES': case 'SI':
      case 'SR': case 'SL': case 'DI': case 'DR': case 'LO': case 'AC': case 'AD': case 'CR':
      case 'LB': case 'SM': case 'TD': case 'DT': case 'PA0':
        break;
      default:
        unknown.set(cmd, (unknown.get(cmd) ?? 0) + 1);
        break;
    }
  }
  flush();

  if (unknown.size) {
    const top = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}×${v}`);
    notes.push(`Пропущено неизвестных команд HPGL: ${top.join(', ')}.`);
  }
  if (!shapes.length && !notes.length) notes.push('В PLT не найдено геометрии.');
  return { shapes, notes, pages: 1, kind: 'plt' };
}

// ---------------- определение формата и диспетчер ----------------

/** Формат файла по имени и первым байтам (магические подписи важнее расширения). */
export function sniffCorelFormat(name: string, head: Uint8Array | string): CorelFormat {
  const lower = name.toLowerCase();
  const text = typeof head === 'string' ? head : latin1(head.subarray(0, 1024));
  const trimmed = text.replace(/^\s+/, '');
  if (trimmed.startsWith('%PDF')) return 'pdf';
  if (trimmed.startsWith('%!PS') || trimmed.startsWith('%!PS-Adobe')) return 'ps';
  if (trimmed.startsWith('RIFF') && /CDR[XS]|cdr|CDRXvrsn/i.test(text.slice(0, 64))) return 'cdr';
  if (lower.endsWith('.cdr') || lower.endsWith('.cdt') || lower.endsWith('.cmx')) return 'cdr';
  if (lower.endsWith('.plt') || lower.endsWith('.hp') || lower.endsWith('.hpgl') || lower.endsWith('.hpg')) return 'plt';
  if (lower.endsWith('.eps') || lower.endsWith('.ps') || lower.endsWith('.ai')) return 'ps';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.svg') || /<svg[\s>]/i.test(trimmed)) return 'svg';
  if (lower.endsWith('.dxf') || /^\s*0\s*\r?\n\s*SECTION/i.test(text) || /^\s*999\s*\r?\n/i.test(text)) return 'dxf';
  if (lower.endsWith('.psdraw') || lower.endsWith('.pslaser') || lower.endsWith('.json')) return 'project';
  if (trimmed.startsWith('{') && /"(psbees|laser)/i.test(trimmed.slice(0, 200))) return 'project';
  if (/^\s*(IN|SP|PU|PD|PA|PR)\b/i.test(trimmed) && /[-\d]/.test(trimmed.slice(0, 200))) return 'plt';
  if (/^\s*ENTITIES\s*$/mi.test(trimmed)) return 'dxf';
  return 'unknown';
}

/**
 * Единая точка входа импорта из CorelDRAW и соседних редакторов:
 * PDF/AI, EPS/PS/AI, PLT/HPGL, а также SVG и DXF (через существующий
 * importVectorFile). Для .cdr возвращает понятную подсказку, в какие форматы
 * пересохранить файл.
 */
export async function importVectorData(
  name: string,
  data: ArrayBuffer | Uint8Array | string,
  docH = 200,
): Promise<VectorImportResult> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : (data instanceof Uint8Array ? data : new Uint8Array(data));
  if (bytes.length > MAX_BYTES) throw new Error('Файл больше 64 МБ — импорт отменён.');
  const kind = sniffCorelFormat(name, bytes);

  if (kind === 'cdr') {
    const err = new Error(CDR_MESSAGE);
    (err as Error & { kind?: CorelFormat }).kind = 'cdr';
    throw err;
  }

  // текстовые форматы читаем как latin1 для PS (внутри бывает двоичное превью)
  // и как UTF-8 для SVG/DXF/PLT
  const asText = (enc: 'utf-8' | 'latin1'): string => {
    if (enc === 'latin1') return latin1(bytes);
    return new TextDecoder('utf-8').decode(bytes);
  };

  if (kind === 'pdf') {
    const res = await parsePdfVector(bytes);
    return res;
  }
  if (kind === 'ps') {
    const label = /\.ai$/i.test(name) ? 'AI' : 'EPS';
    return parsePostScript(asText('latin1'), label);
  }
  if (kind === 'plt') return parsePlt(asText('utf-8'));
  if (kind === 'svg' || kind === 'dxf') {
    const shapes = importVectorFile(asText('utf-8'), name, docH);
    return { shapes, notes: [], pages: 1, kind };
  }
  if (kind === 'project') {
    return { shapes: [], notes: ['Это файл проекта — откройте его через «Открыть проект».'], pages: 1, kind };
  }
  throw new Error(
    'Формат не распознан. Поддерживаются: SVG, DXF, PDF, EPS/AI (PostScript), PLT (HPGL) и проект PSBees (.psdraw/.pslaser).',
  );
}
