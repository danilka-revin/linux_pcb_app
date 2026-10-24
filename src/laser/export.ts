// Экспорт развёртки на лазерный станок (SVG 1:1 мм, AutoCAD DXF R12/R14, G-Code GRBL/LightBurn),
// импорт SVG/DXF и расчёт симуляции траектории лазерной головки.

import {
  fmtMm,
  LASER_LAYER_ORDER,
  luid,
  offsetShape,
  shapeToPolylines,
  type LaserDoc,
  type LaserLayerId,
  type LaserShape,
  type PathNode,
  type Pt,
} from './model';
import { dxfToShapes, exportDxf, type DxfOptions } from './dxf';

export interface SimSegment {
  from: Pt;
  to: Pt;
  rapid: boolean;
  layer: LaserLayerId;
  power: number;
  speed: number;
  lengthMm: number;
  durationSec: number;
}

export interface LaserSimulation {
  segments: SimSegment[];
  cutLengthMm: number;
  rapidLengthMm: number;
  totalTimeSec: number;
  byLayer: Record<LaserLayerId, { count: number; lengthMm: number; timeSec: number }>;
}

/** Разбиение полилинии на пунктирные штрихи (для перфорации по линии сгиба и перемычек) */
export function dashPolyline(pts: Pt[], dashLen: number, gapLen: number): Pt[][] {
  if (pts.length < 2 || dashLen <= 0 || gapLen <= 0) return [pts];
  const out: Pt[][] = [];
  let cur: Pt[] = [{ ...pts[0] }];
  let drawing = true;
  let rem = dashLen;

  for (let i = 0; i < pts.length - 1; i++) {
    let a = pts[i];
    const b = pts[i + 1];
    let segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 1e-6) continue;
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;

    while (segLen > 1e-5) {
      if (segLen <= rem) {
        if (drawing) cur.push({ ...b });
        rem -= segLen;
        segLen = 0;
        if (rem <= 1e-5) {
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

/** Добавление удерживающих перемычек (holding tabs) на замкнутом контуре резки */
function applyHoldingTabs(pts: Pt[], tabsCount: number, tabWidth = 1.8): Pt[][] {
  if (!tabsCount || tabsCount <= 0 || pts.length < 2) return [pts];
  let totalLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    totalLen += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  const pitch = totalLen / tabsCount;
  if (pitch <= tabWidth * 1.5) return [pts];
  return dashPolyline(pts, pitch - tabWidth, tabWidth);
}

/** Упорядочивание полилиний методом ближайшего соседа (минимизация холостых переездов G0) */
function optimizePolylinesOrder(polylines: Pt[][], startPt: Pt): { ordered: Pt[][]; endPt: Pt } {
  const pool = polylines.filter((pl) => pl.length >= 2).map((pl) => pl.slice());
  const ordered: Pt[][] = [];
  let cur = { ...startPt };

  while (pool.length > 0) {
    let bestIdx = 0;
    let bestRev = false;
    let bestDist = Infinity;

    for (let i = 0; i < pool.length; i++) {
      const pl = pool[i];
      const pStart = pl[0];
      const pEnd = pl[pl.length - 1];
      const dStart = Math.hypot(pStart.x - cur.x, pStart.y - cur.y);
      if (dStart < bestDist) {
        bestDist = dStart;
        bestIdx = i;
        bestRev = false;
      }
      const dEnd = Math.hypot(pEnd.x - cur.x, pEnd.y - cur.y);
      if (dEnd < bestDist) {
        bestDist = dEnd;
        bestIdx = i;
        bestRev = true;
      }
    }

    const chosen = pool.splice(bestIdx, 1)[0];
    if (bestRev) chosen.reverse();
    ordered.push(chosen);
    cur = chosen[chosen.length - 1];
  }

  return { ordered, endPt: cur };
}

/** Построение полной траектории лазера и расчёт времени обработки */
export function buildLaserSimulation(doc: LaserDoc, rapidSpeedMmSec = 180): LaserSimulation {
  const segments: SimSegment[] = [];
  let cutLengthMm = 0;
  let rapidLengthMm = 0;
  let totalTimeSec = 0;

  const byLayer: Record<LaserLayerId, { count: number; lengthMm: number; timeSec: number }> = {
    engrave: { count: 0, lengthMm: 0, timeSec: 0 },
    score: { count: 0, lengthMm: 0, timeSec: 0 },
    fold: { count: 0, lengthMm: 0, timeSec: 0 },
    inner: { count: 0, lengthMm: 0, timeSec: 0 },
    cut: { count: 0, lengthMm: 0, timeSec: 0 },
    guide: { count: 0, lengthMm: 0, timeSec: 0 },
  };

  let head: Pt = { x: 0, y: 0 };

  // Порядок слоёв: сначала гравировка и разметка, затем сгибы, затем внутренние отверстия и в самом конце внешний рез
  const activeOrder: LaserLayerId[] = ['engrave', 'score', 'fold', 'inner', 'cut'];

  for (const layerId of activeOrder) {
    const cfg = doc.layers[layerId];
    if (!cfg || !cfg.visible || cfg.passes <= 0) continue;

    const layerShapes = doc.shapes.filter((s) => s.layer === layerId && !s.hidden);
    if (!layerShapes.length) continue;

    const rawPolylines: Pt[][] = [];
    for (const s of layerShapes) {
      // Компенсация толщины реза (kerf) для слоёв резки
      const targetShapes =
        cfg.kerf > 0 && (layerId === 'cut' || layerId === 'inner')
          ? offsetShape(s, layerId === 'inner' ? -cfg.kerf / 2 : cfg.kerf / 2)
          : [s];

      for (const ts of targetShapes) {
        const pls = shapeToPolylines(ts);
        for (const pl of pls) {
          if (layerId === 'fold' && cfg.dashLen > 0 && cfg.gapLen > 0) {
            rawPolylines.push(...dashPolyline(pl, cfg.dashLen, cfg.gapLen));
          } else if (s.tabs && s.tabs > 0) {
            rawPolylines.push(...applyHoldingTabs(pl, s.tabs, s.tabWidth ?? 1.8));
          } else {
            rawPolylines.push(pl);
          }
        }
      }
    }

    const { ordered } = optimizePolylinesOrder(rawPolylines, head);
    const workSpeed = Math.max(1, cfg.speed);

    for (let pass = 0; pass < cfg.passes; pass++) {
      for (const pl of ordered) {
        if (pl.length < 2) continue;
        const start = pl[0];
        const rapidDist = Math.hypot(start.x - head.x, start.y - head.y);
        if (rapidDist > 0.01) {
          const rTime = rapidDist / rapidSpeedMmSec;
          segments.push({
            from: { ...head },
            to: { ...start },
            rapid: true,
            layer: layerId,
            power: 0,
            speed: rapidSpeedMmSec,
            lengthMm: rapidDist,
            durationSec: rTime,
          });
          rapidLengthMm += rapidDist;
          totalTimeSec += rTime;
        }
        head = { ...start };

        for (let i = 0; i < pl.length - 1; i++) {
          const a = pl[i];
          const b = pl[i + 1];
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d < 1e-4) continue;
          const dt = d / workSpeed;
          segments.push({
            from: a,
            to: b,
            rapid: false,
            layer: layerId,
            power: cfg.power,
            speed: workSpeed,
            lengthMm: d,
            durationSec: dt,
          });
          cutLengthMm += d;
          totalTimeSec += dt;
          byLayer[layerId].lengthMm += d;
          byLayer[layerId].timeSec += dt;
        }
        head = { ...pl[pl.length - 1] };
        byLayer[layerId].count += 1;
      }
    }
  }

  return {
    segments,
    cutLengthMm,
    rapidLengthMm,
    totalTimeSec,
    byLayer,
  };
}

export interface GCodeExportOptions {
  /** Режим лазера: M4 (динамическая мощность GRBL 1.1) или M3 (постоянная) */
  laserMode: 'M4' | 'M3';
  /** Максимальное значение ШИМ S (обычно 1000 в GRBL) */
  maxS: number;
  /** Скорость холостых переездов G0, мм/мин */
  rapidFeedMmMin: number;
  /** Возврат в (0;0) после завершения */
  returnOrigin: boolean;
}

export const DEFAULT_GCODE_OPTIONS: GCodeExportOptions = {
  laserMode: 'M4',
  maxS: 1000,
  rapidFeedMmMin: 9000,
  returnOrigin: true,
};

/** Генерация управляющей программы G-Code (.gcode / .nc) для лазерного станка (GRBL / LightBurn / LaserGRBL) */
export function exportLaserGCode(doc: LaserDoc, opts: GCodeExportOptions = DEFAULT_GCODE_OPTIONS): string {
  const lines: string[] = [];
  const f4 = (n: number) => Number(n.toFixed(3));
  lines.push(`; PSBees Laser CAM — Управляющая программа для лазерного станка`);
  lines.push(`; Проект: ${doc.name} (${doc.w} x ${doc.h} мм)`);
  lines.push(`; Толщина материала: ${doc.materialThickness} мм`);
  lines.push(`G21 ; Единицы — миллиметры`);
  lines.push(`G90 ; Абсолютные координаты`);
  lines.push(`M5 S0 ; Лазер выключен`);
  lines.push('');

  const activeOrder: LaserLayerId[] = ['engrave', 'score', 'fold', 'inner', 'cut'];
  let head: Pt = { x: 0, y: 0 };
  let airOn = false;

  for (const layerId of activeOrder) {
    const cfg = doc.layers[layerId];
    if (!cfg || !cfg.visible || cfg.passes <= 0) continue;
    const layerShapes = doc.shapes.filter((s) => s.layer === layerId && !s.hidden);
    if (!layerShapes.length) continue;

    lines.push(`; === Слой: ${cfg.name} (Мощность ${cfg.power}%, Скорость ${cfg.speed} мм/с, Проходов: ${cfg.passes}) ===`);
    if (cfg.airAssist && !airOn) {
      lines.push(`M8 ; Включить обдув (Air Assist)`);
      airOn = true;
    } else if (!cfg.airAssist && airOn) {
      lines.push(`M9 ; Выключить обдув`);
      airOn = false;
    }

    const rawPolylines: Pt[][] = [];
    for (const s of layerShapes) {
      const targetShapes =
        cfg.kerf > 0 && (layerId === 'cut' || layerId === 'inner')
          ? offsetShape(s, layerId === 'inner' ? -cfg.kerf / 2 : cfg.kerf / 2)
          : [s];
      for (const ts of targetShapes) {
        const pls = shapeToPolylines(ts);
        for (const pl of pls) {
          if (layerId === 'fold' && cfg.dashLen > 0 && cfg.gapLen > 0) {
            rawPolylines.push(...dashPolyline(pl, cfg.dashLen, cfg.gapLen));
          } else if (s.tabs && s.tabs > 0) {
            rawPolylines.push(...applyHoldingTabs(pl, s.tabs, s.tabWidth ?? 1.8));
          } else {
            rawPolylines.push(pl);
          }
        }
      }
    }

    const { ordered } = optimizePolylinesOrder(rawPolylines, head);
    const sVal = Math.round((Math.max(0, Math.min(100, cfg.power)) / 100) * opts.maxS);
    const feedMmMin = Math.round(Math.max(1, cfg.speed) * 60);

    for (let pass = 1; pass <= cfg.passes; pass++) {
      if (cfg.passes > 1) lines.push(`; Проход ${pass} из ${cfg.passes}`);
      for (const pl of ordered) {
        if (pl.length < 2) continue;
        const p0 = pl[0];
        lines.push(`M5`);
        lines.push(`G0 X${f4(p0.x)} Y${f4(p0.y)} F${opts.rapidFeedMmMin}`);
        lines.push(`${opts.laserMode} S${sVal}`);
        for (let i = 1; i < pl.length; i++) {
          const p = pl[i];
          lines.push(`G1 X${f4(p.x)} Y${f4(p.y)}${i === 1 ? ` F${feedMmMin}` : ''}`);
        }
        head = { ...pl[pl.length - 1] };
      }
    }
    lines.push(`M5 S0`);
    lines.push('');
  }

  if (airOn) lines.push(`M9 ; Выключить обдув`);
  if (opts.returnOrigin) {
    lines.push(`G0 X0 Y0 F${opts.rapidFeedMmMin} ; Возврат в начало координат`);
  }
  lines.push(`M2 ; Конец программы`);
  return lines.join('\n') + '\n';
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Экспорт в SVG (масштаб 1:1 в миллиметрах — для CorelDRAW, LightBurn, Inkscape) */
export function exportLaserSvg(doc: LaserDoc): string {
  const W = doc.w;
  const H = doc.h;
  const flipY = (y: number) => Number((H - y).toFixed(3));
  const fx = (x: number) => Number(x.toFixed(3));

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${fmtMm(W)}mm" height="${fmtMm(H)}mm" viewBox="0 0 ${fmtMm(W)} ${fmtMm(H)}">`
  );
  out.push(`  <title>${escapeXml(doc.name)}</title>`);
  out.push(`  <desc>PSBees Laser Vector &amp; Unfolding Editor (${fmtMm(W)}x${fmtMm(H)} mm)</desc>`);

  for (const layerId of LASER_LAYER_ORDER) {
    if (layerId === 'guide') continue;
    const cfg = doc.layers[layerId];
    if (!cfg || !cfg.visible) continue;
    const shapes = doc.shapes.filter((s) => s.layer === layerId && !s.hidden);
    if (!shapes.length) continue;

    const dashAttr =
      layerId === 'fold' && cfg.dashLen > 0 && cfg.gapLen > 0
        ? ` stroke-dasharray="${fmtMm(cfg.dashLen)} ${fmtMm(cfg.gapLen)}"`
        : '';

    out.push(
      `  <g id="layer-${layerId}" data-layer-name="${escapeXml(cfg.short)}" stroke="${cfg.color}" stroke-width="0.2" fill="none" stroke-linecap="round" stroke-linejoin="round"${dashAttr}>`
    );

    for (const s of shapes) {
      const fillAttr =
        ('filled' in s && s.filled) || layerId === 'engrave'
          ? ` fill="${cfg.color}" fill-opacity="0.25"`
          : '';
      const pls = shapeToPolylines(s);
      if (!pls.length) continue;
      const dParts: string[] = [];
      for (const pl of pls) {
        if (pl.length < 2) continue;
        const cmds = pl.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${fx(p.x)} ${flipY(p.y)}`);
        dParts.push(cmds.join(' '));
      }
      if (dParts.length) {
        out.push(`    <path id="${escapeXml(s.id)}" data-name="${escapeXml(s.name)}" d="${dParts.join(' ')}"${fillAttr} />`);
      }
    }
    out.push(`  </g>`);
  }

  out.push(`</svg>`);
  return out.join('\n') + '\n';
}

/**
 * Экспорт в AutoCAD DXF — основной формат вывода для лазерных станков.
 * Полноценная реализация (R12/R2000, точные CIRCLE/ARC/ELLIPSE/SPLINE, блоки,
 * слои, единицы, контроль отклонений) находится в `./dxf`.
 */
export function exportLaserDxf(doc: LaserDoc, opts?: Partial<DxfOptions>): string {
  return exportDxf(doc, opts);
}


// ---------------- Импорт векторных файлов SVG и DXF ----------------

function parseSvgPathData(d: string, docH: number): { nodes: PathNode[]; closed: boolean }[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subpaths: { nodes: PathNode[]; closed: boolean }[] = [];
  let cur: PathNode[] = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  let i = 0;
  let cmd = 'M';

  const nextNum = () => Number(tokens[i++]);
  const toY = (svgY: number) => Math.max(0, docH - svgY);

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[a-zA-Z]$/.test(tok)) {
      cmd = tok;
      i++;
    }
    if (cmd === 'M' || cmd === 'm') {
      if (cur.length >= 2) subpaths.push({ nodes: cur, closed: false });
      cur = [];
      const x = nextNum();
      const y = nextNum();
      cx = cmd === 'm' ? cx + x : x;
      cy = cmd === 'm' ? cy + y : y;
      startX = cx;
      startY = cy;
      cur.push({ x: cx, y: toY(cy) });
      cmd = cmd === 'm' ? 'l' : 'L';
    } else if (cmd === 'L' || cmd === 'l') {
      const x = nextNum();
      const y = nextNum();
      cx = cmd === 'l' ? cx + x : x;
      cy = cmd === 'l' ? cy + y : y;
      cur.push({ x: cx, y: toY(cy) });
    } else if (cmd === 'H' || cmd === 'h') {
      const x = nextNum();
      cx = cmd === 'h' ? cx + x : x;
      cur.push({ x: cx, y: toY(cy) });
    } else if (cmd === 'V' || cmd === 'v') {
      const y = nextNum();
      cy = cmd === 'v' ? cy + y : y;
      cur.push({ x: cx, y: toY(cy) });
    } else if (cmd === 'C' || cmd === 'c') {
      const x1 = nextNum(), y1 = nextNum();
      const x2 = nextNum(), y2 = nextNum();
      const x = nextNum(), y = nextNum();
      const cp1x = cmd === 'c' ? cx + x1 : x1;
      const cp1y = cmd === 'c' ? cy + y1 : y1;
      const cp2x = cmd === 'c' ? cx + x2 : x2;
      const cp2y = cmd === 'c' ? cy + y2 : y2;
      cx = cmd === 'c' ? cx + x : x;
      cy = cmd === 'c' ? cy + y : y;
      if (cur.length > 0) {
        cur[cur.length - 1].cp2x = cp1x;
        cur[cur.length - 1].cp2y = toY(cp1y);
      }
      cur.push({ x: cx, y: toY(cy), cp1x: cp2x, cp1y: toY(cp2y), smooth: true });
    } else if (cmd === 'Z' || cmd === 'z') {
      if (cur.length >= 2) {
        subpaths.push({ nodes: cur, closed: true });
        cur = [];
      }
      cx = startX;
      cy = startY;
    } else {
      i++;
    }
  }
  if (cur.length >= 2) subpaths.push({ nodes: cur, closed: false });
  return subpaths;
}

export function importVectorFile(content: string, filename: string, docH = 200): LaserShape[] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.dxf') || content.includes('ENTITIES')) {
    return parseDxfContent(content);
  }
  return parseSvgContent(content, docH);
}

/**
 * Чтение SVG без DOM-парсера: теги сканируются по порядку, атрибуты группы <g>
 * наследуются вложенными фигурами. Слой определяется по id группы
 * (id="layer-fold"), по data-layer или по пунктиру stroke-dasharray (биговка).
 */
function parseSvgContent(svg: string, docH: number): LaserShape[] {
  const shapes: LaserShape[] = [];
  const attr = (attrs: string, name: string): string => {
    const r = new RegExp(`\\b${name}\\s*=\\s*["\']([^"\']*)["\']`, 'i').exec(attrs);
    return r ? r[1] : '';
  };
  const numAttr = (attrs: string, name: string, def = 0): number => {
    const v = parseFloat(attr(attrs, name));
    return Number.isFinite(v) ? v : def;
  };
  const layerOf = (attrs: string): LaserLayerId => {
    const id = attr(attrs, 'id').toLowerCase();
    const known = id.match(/layer-(cut|inner|fold|score|engrave|guide)/);
    if (known) return known[1] as LaserLayerId;
    const dataLayer = attr(attrs, 'data-layer').toLowerCase();
    if (/^(cut|inner|fold|score|engrave|guide)$/.test(dataLayer)) return dataLayer as LaserLayerId;
    if (attr(attrs, 'stroke-dasharray')) return 'fold';
    return 'cut';
  };

  // Стек групп: каждая фигура берёт слой ближайшей группы, где он задан
  const stack: (LaserLayerId | null)[] = [];
  const tagRe = /<(\/?)(g|rect|circle|ellipse|line|polyline|polygon|path)\b([^>]*?)(\/?)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(svg)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];

    if (tag === 'g') {
      if (closing) stack.pop();
      else stack.push(layerOf(attrs));
      continue;
    }
    if (closing) continue;

    const own = layerOf(attrs);
    const inherited = [...stack].reverse().find((x) => x !== null && x !== undefined) ?? null;
    const layer: LaserLayerId = own !== 'cut' ? own : (inherited ?? 'cut');

    if (tag === 'rect') {
      const w = numAttr(attrs, 'width');
      const h = numAttr(attrs, 'height');
      if (w > 0 && h > 0) {
        const ySvg = numAttr(attrs, 'y');
        shapes.push({
          id: luid('svg'),
          kind: 'rect',
          layer,
          name: attr(attrs, 'data-name') || 'Импорт прямоугольник',
          x: numAttr(attrs, 'x'),
          y: Math.max(0, docH - ySvg - h),
          w,
          h,
          rx: numAttr(attrs, 'rx'),
          rot: 0,
          filled: false,
        });
      }
    } else if (tag === 'circle' || tag === 'ellipse') {
      const r = numAttr(attrs, 'r');
      const rx = tag === 'circle' ? r : numAttr(attrs, 'rx');
      const ry = tag === 'circle' ? r : numAttr(attrs, 'ry');
      if (rx > 0 && ry > 0) {
        shapes.push({
          id: luid('svg'),
          kind: 'ellipse',
          layer,
          name: 'Импорт окружность',
          cx: numAttr(attrs, 'cx'),
          cy: Math.max(0, docH - numAttr(attrs, 'cy')),
          rx,
          ry,
          rot: 0,
          startAngle: 0,
          endAngle: 360,
          filled: false,
        });
      }
    } else if (tag === 'line') {
      shapes.push({
        id: luid('svg'),
        kind: 'path',
        layer,
        name: 'Импорт линия',
        nodes: [
          { x: numAttr(attrs, 'x1'), y: Math.max(0, docH - numAttr(attrs, 'y1')) },
          { x: numAttr(attrs, 'x2'), y: Math.max(0, docH - numAttr(attrs, 'y2')) },
        ],
        closed: false,
        filled: false,
      });
    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums = attr(attrs, 'points').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      const nodes: PathNode[] = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        nodes.push({ x: nums[i], y: Math.max(0, docH - nums[i + 1]) });
      }
      if (nodes.length >= 2) {
        shapes.push({
          id: luid('svg'),
          kind: 'path',
          layer,
          name: tag === 'polygon' ? 'Импорт полигон' : 'Импорт ломаная',
          nodes,
          closed: tag === 'polygon',
          filled: false,
        });
      }
    } else if (tag === 'path') {
      const d = attr(attrs, 'd');
      if (d) {
        for (const sp of parseSvgPathData(d, docH)) {
          shapes.push({
            id: luid('svg'),
            kind: 'path',
            layer,
            name: attr(attrs, 'data-name') || 'Импорт контур',
            nodes: sp.nodes,
            closed: sp.closed,
            filled: false,
          });
        }
      }
    }
  }
  return shapes;
}

/** Импорт DXF: сущности LINE/CIRCLE/ARC/ELLIPSE/LWPOLYLINE/POLYLINE/SPLINE/TEXT/INSERT */
function parseDxfContent(dxf: string): LaserShape[] {
  return dxfToShapes(dxf);
}
