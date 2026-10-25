// Обмен чертежами с CorelDRAW и другими векторными редакторами.
//
// Родной формат CorelDRAW (.cdr) закрытый и двоичный: публичной спецификации нет,
// браузерных парсеров не существует (libcdr — это C++ библиотека). Поэтому обмен
// идёт через форматы, которые CorelDRAW читает и пишет сам:
//
//   экспорт — DXF и SVG (см. dxf.ts / export.ts) плюс PDF (векторный, 1:1 мм,
//             слои чертежа становятся слоями PDF — OCG), EPS (PostScript) и
//             PLT (HPGL/2 для плоттеров и станков);
//   импорт  — SVG, DXF, PLT/HPGL, EPS/PS/AI и PDF/AI (см. corel-parse.ts).
//
// Все форматы пишутся в масштабе 1:1 в миллиметрах: PDF и EPS переводят мм в
// пункты (72/25.4 ≈ 2.8346), PLT — в юниты HPGL (40 юнитов на мм, 1 юнит =
// 0.025 мм). Ось Y во всех трёх форматах направлена вверх, как в мире чертежа,
// поэтому геометрия не зеркалится и не смещается.
//
// Кривые везде остаются кубическими Безье (без аппроксимации полилинией) — тем
// же набором сегментов, что и в точном DXF-экспорте, поэтому PDF/EPS/SVG/DXF
// одного чертежа совпадают до 1e-9 мм. Исключение — PLT: HPGL не знает Безье,
// там кривая раскладывается полилинией с заданным допуском.

import { DXF_LAYER_NAMES, flattenNodes } from './dxf';
import {
  LASER_LAYER_ORDER, dashPolyline, shapeToPath,
  type LaserDoc, type LaserLayerId, type PathNode, type Pt,
} from './model';

/** Пунктов PostScript/PDF в одном миллиметре. */
export const PT_PER_MM = 72 / 25.4;
/** Миллиметров в одном пункте. */
export const MM_PER_PT = 25.4 / 72;
/** Юнитов HPGL в одном миллиметре (1 юнит = 0.025 мм). */
export const HPGL_UNITS_PER_MM = 40;

/** Перо HPGL на каждый слой чертежа: pen 1 = CUT, pen 6 = GUIDE. */
export const PLT_PENS: Record<LaserLayerId, number> = {
  cut: 1, inner: 2, fold: 3, score: 4, engrave: 5, guide: 6,
};

export interface VectorExportOptions {
  /** Толщина линии в файле, мм (в PDF/EPS переводится в пункты). */
  strokeWidthMm: number;
  /** PDF: раскладывать слои чертежа по слоям PDF (Optional Content Groups). */
  pdfLayers: boolean;
  /** PLT: отдельное перо на каждый слой (иначе всё в перо 1). */
  pltPensPerLayer: boolean;
  /** PLT: допуск аппроксимации кривых полилинией, мм. */
  tolerance: number;
  /** Включать скрытые объекты. */
  includeHidden: boolean;
  /** Включать служебный слой (размеры и направляющие). */
  includeGuide: boolean;
  /** Название файла внутри PDF/EPS (по умолчанию — имя проекта). */
  title?: string;
}

export const DEFAULT_VECTOR_OPTIONS: VectorExportOptions = {
  strokeWidthMm: 0.2,
  pdfLayers: true,
  pltPensPerLayer: true,
  tolerance: 0.02,
  includeHidden: false,
  includeGuide: false,
};

export function normalizeVectorOptions(o: Partial<VectorExportOptions> = {}): VectorExportOptions {
  const d = DEFAULT_VECTOR_OPTIONS;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
    return Math.max(min, Math.min(max, n));
  };
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    strokeWidthMm: num(o.strokeWidthMm, d.strokeWidthMm, 0, 10),
    pdfLayers: bool(o.pdfLayers, d.pdfLayers),
    pltPensPerLayer: bool(o.pltPensPerLayer, d.pltPensPerLayer),
    tolerance: num(o.tolerance, d.tolerance, 0.001, 2),
    includeHidden: bool(o.includeHidden, d.includeHidden),
    includeGuide: bool(o.includeGuide, d.includeGuide),
    title: typeof o.title === 'string' ? o.title : undefined,
  };
}

// ---------------- общая геометрия слоёв ----------------

/** Подпуть: цепочка узлов с рычагами Безье (как в модели чертежа). */
export interface VectorSubpath {
  nodes: PathNode[];
  closed: boolean;
}

/** Объект экспорта: внешний контур + отверстия, признак заливки. */
export interface VectorPath {
  subpaths: VectorSubpath[];
  fill: boolean;
}

export interface VectorLayerGeom {
  id: LaserLayerId;
  /** Имя слоя в файле: CUT / INNER / FOLD / SCORE / ENGRAVE / GUIDE. */
  name: string;
  /** Человекочитаемое имя слоя из документа. */
  title: string;
  /** #rrggbb */
  color: string;
  rgb: [number, number, number];
  /** [штрих, пропуск] в мм или null для сплошной линии. */
  dash: [number, number] | null;
  /** Толщина линии, мм. */
  width: number;
  paths: VectorPath[];
}

/** #rrggbb → [r, g, b] в диапазоне 0..1. */
export function hexToRgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * Геометрия чертежа по слоям в порядке LASER_LAYER_ORDER (сначала заливка и
 * разметка, в конце внешний контур и служебный слой) — тот же порядок, что в
 * DXF и G-Code, чтобы файлы разных форматов совпадали послойно.
 * Скрытые слои, скрытые объекты и служебный слой учитываются по опциям.
 */
export function collectVectorGeom(doc: LaserDoc, o: Partial<VectorExportOptions> = {}): VectorLayerGeom[] {
  const opts = normalizeVectorOptions(o);
  const out: VectorLayerGeom[] = [];
  for (const id of LASER_LAYER_ORDER) {
    const cfg = doc.layers[id];
    if (!cfg || !cfg.visible) continue;
    if (id === 'guide' && !opts.includeGuide) continue;
    const shapes = doc.shapes.filter((s) => s.layer === id && (opts.includeHidden || !s.hidden));
    if (!shapes.length) continue;
    const paths: VectorPath[] = [];
    for (const shape of shapes) {
      for (const p of shapeToPath(shape)) {
        const subpaths: VectorSubpath[] = [];
        if (p.nodes.length >= 2) subpaths.push({ nodes: p.nodes, closed: p.closed });
        for (const h of p.holes ?? []) {
          if (h.length >= 2) subpaths.push({ nodes: h, closed: true });
        }
        if (!subpaths.length) continue;
        paths.push({ subpaths, fill: Boolean(p.filled) || cfg.mode === 'fill' });
      }
    }
    if (!paths.length) continue;
    const dash = cfg.dashLen > 0 && cfg.gapLen > 0 ? [cfg.dashLen, cfg.gapLen] as [number, number] : null;
    out.push({
      id,
      name: DXF_LAYER_NAMES[id] ?? String(id).toUpperCase(),
      title: cfg.short || cfg.name || id,
      color: cfg.color,
      rgb: hexToRgb01(cfg.color),
      dash,
      width: opts.strokeWidthMm,
      paths,
    });
  }
  return out;
}

/**
 * Обход сегментов цепочки узлов тем же правилом, что и в DXF/SVG: если хотя бы
 * у одного из двух узлов есть рычаг — сегмент кубический, иначе прямой. Для
 * замкнутого контура добавляется замыкающий сегмент.
 */
export function walkSegments(
  nodes: PathNode[],
  closed: boolean,
  cb: (a: Pt, c1: Pt, c2: Pt, b: Pt, isCurve: boolean) => void,
): void {
  if (nodes.length < 2) return;
  const last = closed ? nodes.length : nodes.length - 1;
  for (let i = 0; i < last; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const hasCp =
      (a.cp2x !== undefined && a.cp2y !== undefined) || (b.cp1x !== undefined && b.cp1y !== undefined);
    if (!hasCp) {
      cb({ x: a.x, y: a.y }, { x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: b.x, y: b.y }, false);
      continue;
    }
    cb(
      { x: a.x, y: a.y },
      { x: a.cp2x ?? a.x, y: a.cp2y ?? a.y },
      { x: b.cp1x ?? b.x, y: b.cp1y ?? b.y },
      { x: b.x, y: b.y },
      true,
    );
  }
}

/** Габариты геометрии (по узлам и рычагам — с запасом), мм. */
export function vectorGeomBounds(layers: VectorLayerGeom[]): [number, number, number, number] | null {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const L of layers) {
    for (const p of L.paths) {
      for (const sp of p.subpaths) {
        for (const n of sp.nodes) {
          for (const [x, y] of [[n.x, n.y], [n.cp1x, n.cp1y], [n.cp2x, n.cp2y]] as [number | undefined, number | undefined][]) {
            if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
          }
        }
      }
    }
  }
  if (!Number.isFinite(minx)) return null;
  return [minx, miny, maxx, maxy];
}

// ---------------- служебные мелочи ----------------

/** Число для векторных форматов: 3 знака после точки, без «-0». */
export function vn(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Типографские символы, которые стоит сохранить в ASCII-заголовке файла. */
const SYMBOLS: Record<string, string> = {
  '×': 'x', '·': '-', '•': '-', '°': ' deg', '—': '-', '–': '-', '−': '-',
  '«': '"', '»': '"', '„': '"', '“': '"', '”': '"', '‘': "'", '’': "'",
  '№': 'No', '…': '...', '€': 'EUR', '²': '2', '³': '3', '≈': '~',
  '≤': '<=', '≥': '>=', '∅': 'D', '½': '1/2', '¼': '1/4',
};

/** ASCII-строка для DSC-комментариев EPS: кириллица транслитерируется. */
export function asciiText(s: string): string {
  return s
    .split('')
    .map((ch) => {
      const sym = SYMBOLS[ch];
      if (sym !== undefined) return sym;
      const low = ch.toLowerCase();
      const t = TRANSLIT[low];
      if (t !== undefined) return ch === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
      return ch;
    })
    .join('')
    // управляющие символы и не-ASCII ломают DSC-комментарий
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[%\\\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'Drawing';
}

/** Литеральная строка PDF: ASCII как есть, прочее — шестнадцатеричный UTF-16BE. */
function pdfString(s: string): string {
  const ascii = s.replace(/[^\x20-\x7e]/g, '');
  if (ascii === s) return `(${s.replace(/([\\()])/g, '\\$1')})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

// ---------------- векторный PDF ----------------

/**
 * Векторный PDF 1.7: одна страница размером с лист (мм → пункты), кривые
 * Безье, цвета и пунктир слоёв, слои чертежа как слои PDF (OCG) — CorelDRAW,
 * Illustrator и Inkscape при импорте раскладывают их по своим слоям.
 *
 * Файл собирается только из ASCII-символов (имя проекта кодируется UTF-16BE в
 * шестнадцатеричной строке), поэтому смещения в таблице xref равны длинам строк.
 */
export function exportVectorPdf(doc: LaserDoc, o: Partial<VectorExportOptions> = {}): string {
  const opts = normalizeVectorOptions(o);
  const layers = collectVectorGeom(doc, opts);
  const w = Math.max(1, doc.w) * PT_PER_MM;
  const h = Math.max(1, doc.h) * PT_PER_MM;
  const title = opts.title ?? doc.name ?? 'Drawing';

  const ocg = opts.pdfLayers && layers.length > 0;
  const ocgFirst = 5;
  const infoNum = ocgFirst + (ocg ? layers.length : 0);

  const body: string[] = [];
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    body.push('q');
    if (ocg) body.push(`/OC /MC${i} BDC`);
    body.push(`${vn(L.width * PT_PER_MM)} w`);
    body.push(`${vn(L.rgb[0])} ${vn(L.rgb[1])} ${vn(L.rgb[2])} RG`);
    body.push(`${vn(L.rgb[0])} ${vn(L.rgb[1])} ${vn(L.rgb[2])} rg`);
    body.push(L.dash ? `[${vn(L.dash[0] * PT_PER_MM)} ${vn(L.dash[1] * PT_PER_MM)}] 0 d` : '[] 0 d');
    body.push('1 J 1 j');
    for (const p of L.paths) {
      for (const sp of p.subpaths) {
        const nodes = sp.nodes;
        if (nodes.length < 2) continue;
        body.push(`${vn(nodes[0].x * PT_PER_MM)} ${vn(nodes[0].y * PT_PER_MM)} m`);
        walkSegments(nodes, sp.closed, (a, c1, c2, b, isCurve) => {
          if (isCurve) {
            body.push(
              `${vn(c1.x * PT_PER_MM)} ${vn(c1.y * PT_PER_MM)} `
              + `${vn(c2.x * PT_PER_MM)} ${vn(c2.y * PT_PER_MM)} `
              + `${vn(b.x * PT_PER_MM)} ${vn(b.y * PT_PER_MM)} c`,
            );
          } else {
            body.push(`${vn(b.x * PT_PER_MM)} ${vn(b.y * PT_PER_MM)} l`);
          }
        });
        if (sp.closed) body.push('h');
      }
      // B* — заливка вместе с обводкой по правилу чётности (отверстия вычитаются)
      body.push(p.fill ? 'B*' : 'S');
    }
    if (ocg) body.push('EMC');
    body.push('Q');
  }
  const content = body.join('\n');

  const props = ocg
    ? ` /Properties << ${layers.map((_, i) => `/MC${i} ${ocgFirst + i} 0 R`).join(' ')} >>`
    : '';
  const ocgRefs = layers.map((_, i) => `${ocgFirst + i} 0 R`).join(' ');

  const objs: string[] = [];
  objs[0] = `<< /Type /Catalog /Pages 2 0 R${
    ocg ? ` /OCProperties << /OCGs [${ocgRefs}] /D << /Order [${ocgRefs}] /OFF [] /BaseState /ON >> >>` : ''
  } >>`;
  objs[1] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${vn(w)} ${vn(h)}]`
    + ` /Resources <<${props} >> /Contents 4 0 R >>`;
  objs[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  if (ocg) {
    layers.forEach((L, i) => {
      objs[ocgFirst - 1 + i] = `<< /Type /OCG /Name (${L.name}) >>`;
    });
  }
  objs[infoNum - 1] = `<< /Title ${pdfString(title)} /Producer (PSBees) /Creator (PSBees) >>`;

  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\n`
    + `startxref\n${xref}\n%%EOF\n`;
  return out;
}

// ---------------- EPS (PostScript) ----------------

/**
 * EPS 3.0 для CorelDRAW, Illustrator и Inkscape: координаты в пунктах, ось Y
 * вверх, кривые Безье, цвет/толщина/пунктир на каждый слой. Слои помечаются
 * комментарием %PSBeesLayer — по нему же наш импорт EPS возвращает объекты на
 * исходные слои чертежа.
 */
export function exportVectorEps(doc: LaserDoc, o: Partial<VectorExportOptions> = {}): string {
  const opts = normalizeVectorOptions(o);
  const layers = collectVectorGeom(doc, opts);
  const w = Math.max(1, doc.w) * PT_PER_MM;
  const h = Math.max(1, doc.h) * PT_PER_MM;
  // габарит не обрезает геометрию, вышедшую за лист
  const gb = vectorGeomBounds(layers);
  const minx = Math.min(0, gb ? gb[0] * PT_PER_MM : 0);
  const miny = Math.min(0, gb ? gb[1] * PT_PER_MM : 0);
  const maxx = Math.max(w, gb ? gb[2] * PT_PER_MM : w);
  const maxy = Math.max(h, gb ? gb[3] * PT_PER_MM : h);

  const out: string[] = [];
  out.push('%!PS-Adobe-3.0 EPSF-3.0');
  out.push(`%%Title: ${asciiText(opts.title ?? doc.name ?? 'Drawing')}`);
  out.push('%%Creator: PSBees');
  out.push('%%Producer: PSBees vector editor');
  out.push(`%%BoundingBox: ${Math.floor(minx)} ${Math.floor(miny)} ${Math.ceil(maxx)} ${Math.ceil(maxy)}`);
  out.push(`%%HiResBoundingBox: ${vn(minx)} ${vn(miny)} ${vn(maxx)} ${vn(maxy)}`);
  out.push('%%LanguageLevel: 2');
  out.push('%%Pages: 1');
  out.push('%%DocumentData: Clean7Bit');
  out.push(`%%BeginComments`);
  out.push(`% ${asciiText(`Лист ${doc.w} x ${doc.h} мм, 1 мм = ${vn(PT_PER_MM)} pt`)}`);
  out.push(`%%EndComments`);
  out.push('%%BeginProlog');
  out.push('%%EndProlog');
  out.push('%%BeginSetup');
  out.push('%%EndSetup');
  out.push('%%Page: 1 1');
  out.push('%%BeginPageSetup');
  out.push('%%EndPageSetup');

  for (const L of layers) {
    out.push(`%PSBeesLayer: ${L.name}`);
    out.push('gsave');
    out.push(`${vn(L.width * PT_PER_MM)} setlinewidth`);
    out.push(`${vn(L.rgb[0])} ${vn(L.rgb[1])} ${vn(L.rgb[2])} setrgbcolor`);
    out.push(L.dash ? `[${vn(L.dash[0] * PT_PER_MM)} ${vn(L.dash[1] * PT_PER_MM)}] 0 setdash` : '[] 0 setdash');
    out.push('1 setlinecap');
    out.push('1 setlinejoin');
    for (const p of L.paths) {
      out.push('newpath');
      for (const sp of p.subpaths) {
        const nodes = sp.nodes;
        if (nodes.length < 2) continue;
        out.push(`${vn(nodes[0].x * PT_PER_MM)} ${vn(nodes[0].y * PT_PER_MM)} moveto`);
        walkSegments(nodes, sp.closed, (a, c1, c2, b, isCurve) => {
          if (isCurve) {
            out.push(
              `${vn(c1.x * PT_PER_MM)} ${vn(c1.y * PT_PER_MM)} `
              + `${vn(c2.x * PT_PER_MM)} ${vn(c2.y * PT_PER_MM)} `
              + `${vn(b.x * PT_PER_MM)} ${vn(b.y * PT_PER_MM)} curveto`,
            );
          } else {
            out.push(`${vn(b.x * PT_PER_MM)} ${vn(b.y * PT_PER_MM)} lineto`);
          }
        });
        if (sp.closed) out.push('closepath');
      }
      // заливка по правилу чётности (отверстия вычитаются), затем обводка
      out.push(p.fill ? 'gsave eofill grestore stroke' : 'stroke');
    }
    out.push('grestore');
  }

  out.push('%%Trailer');
  out.push('%%EOF');
  return out.join('\n');
}

// ---------------- PLT (HPGL/2) ----------------

/**
 * HPGL/2 для плоттеров, режущих станков и старых версий CorelDRAW: 40 юнитов
 * на мм, перо на каждый слой чертежа, пунктир биговки рисуется настоящими
 * пропусками пера (HPGL не знает штриховых типов линии одинаково во всех
 * реализациях). Кривые раскладываются полилинией с допуском opts.tolerance.
 *
 * Намеренно не пишем SC/PS/PW/RO: разные плоттеры трактуют их единицы
 * по-своему, а масштаб 1:1 в юнитах HPGL понимают все.
 */
export function exportVectorPlt(doc: LaserDoc, o: Partial<VectorExportOptions> = {}): string {
  const opts = normalizeVectorOptions(o);
  const layers = collectVectorGeom(doc, opts);
  const out: string[] = ['IN;', 'PA;'];
  for (const L of layers) {
    const pen = opts.pltPensPerLayer ? PLT_PENS[L.id] ?? 1 : 1;
    out.push(`SP${pen};`);
    for (const p of L.paths) {
      for (const sp of p.subpaths) {
        const pts = flattenNodes(sp.nodes, sp.closed, opts.tolerance);
        if (pts.length < 2) continue;
        // замкнутый контур плоттер должен пройти до начальной точки;
        // flattenNodes уже замыкает контуры из 3+ узлов, поэтому дубль не добавляем
        const first = pts[0];
        const lastPt = pts[pts.length - 1];
        const closedAlready = Math.hypot(lastPt.x - first.x, lastPt.y - first.y) < 1e-9;
        const line = sp.closed && !closedAlready ? [...pts, { x: first.x, y: first.y }] : pts;
        const runs: Pt[][] = L.dash ? dashPolyline(line, L.dash[0], L.dash[1]) : [line];
        for (const run of runs) {
          if (run.length < 2) continue;
          out.push(`PU${u(run[0].x)},${u(run[0].y)};`);
          out.push(`PD${run.slice(1).map((q) => `${u(q.x)},${u(q.y)}`).join(',')};`);
        }
      }
    }
  }
  out.push('SP0;');
  return out.join('\n');
}

/** Миллиметры → целые юниты HPGL. */
function u(mm: number): number {
  return Math.round((Number.isFinite(mm) ? mm : 0) * HPGL_UNITS_PER_MM);
}

// ---------------- подсказка по формату .cdr ----------------

export const CDR_MESSAGE =
  'Формат CorelDRAW (.cdr) закрытый: публичной спецификации нет, прочитать его в браузере нельзя. '
  + 'Сохраните чертёж из CorelDRAW в открытый формат — «Файл → Опубликовать в PDF», '
  + '«Файл → Экспорт» → EPS, SVG, DXF или PLT — и откройте полученный файл: '
  + 'редактор читает PDF, EPS/AI, SVG, DXF и PLT и возвращает объекты на слои чертежа.';
