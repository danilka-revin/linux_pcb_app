// Экспорт развёртки на лазерный станок (SVG 1:1 мм, AutoCAD DXF R12/R14, G-Code GRBL/LightBurn),
// импорт SVG/DXF и расчёт симуляции траектории лазерной головки.

import {
  applyTabs,
  dashPolyline,
  fmtMm,
  isClosedRing,
  kerfShapes,
  LASER_LAYER_ORDER,
  luid,
  shapeToPath,
  shapeToPolylines,
  type LaserDoc,
  type LaserLayerId,
  type LaserShape,
  type PathNode,
  type Pt,
} from './model';
import { dxfToShapes, exportDxf, type DxfOptions } from './dxf';

// Пунктир и перемычки теперь считаются в model.ts — одном месте для экрана, DXF, SVG
// и G-Code. Ре-экспорт оставлен ради совместимости со старыми импортами.
export { dashPolyline } from './model';

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
          ? kerfShapes(s, layerId === 'inner' ? -cfg.kerf / 2 : cfg.kerf / 2)
          : [s];

      for (const ts of targetShapes) {
        const pls = shapeToPolylines(ts);
        for (const pl of pls) {
          if (layerId === 'fold' && cfg.dashLen > 0 && cfg.gapLen > 0) {
            rawPolylines.push(...dashPolyline(pl, cfg.dashLen, cfg.gapLen));
          } else if (s.tabs && s.tabs > 0) {
            rawPolylines.push(...applyTabs(pl, s.tabs, s.tabWidth ?? 1.8, isClosedRing(pl)));
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
          ? kerfShapes(s, layerId === 'inner' ? -cfg.kerf / 2 : cfg.kerf / 2)
          : [s];
      for (const ts of targetShapes) {
        const pls = shapeToPolylines(ts);
        for (const pl of pls) {
          if (layerId === 'fold' && cfg.dashLen > 0 && cfg.gapLen > 0) {
            rawPolylines.push(...dashPolyline(pl, cfg.dashLen, cfg.gapLen));
          } else if (s.tabs && s.tabs > 0) {
            rawPolylines.push(...applyTabs(pl, s.tabs, s.tabWidth ?? 1.8, isClosedRing(pl)));
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

/** Матрица SVG: [a b c d e f], x' = a·x + c·y + e, y' = b·x + d·y + f. */
type SvgMat = [number, number, number, number, number, number];
const SVG_IDENTITY: SvgMat = [1, 0, 0, 1, 0, 0];
const DEG = Math.PI / 180;

/** Композиция матриц: сначала применяется n, потом m. */
const mulMat = (m: SvgMat, n: SvgMat): SvgMat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const applyMat = (m: SvgMat, x: number, y: number): Pt => ({
  x: m[0] * x + m[2] * y + m[4],
  y: m[1] * x + m[3] * y + m[5],
});

/** Чистый перенос: примитив можно оставить «прямоугольником» или «окружностью». */
const isTranslate = (m: SvgMat): boolean =>
  Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[3] - 1) < 1e-9
  && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;

/**
 * Разбор transform="…": matrix/translate/scale/rotate/skewX/skewY,
 * несколько функций подряд. Без этого импорт из Inkscape/CorelDRAW приезжает
 * не туда: группы там почти всегда сдвинуты или повёрнуты.
 */
export function parseSvgTransform(value: string): SvgMat {
  let out: SvgMat = SVG_IDENTITY;
  if (!value) return out;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const fn = m[1].toLowerCase();
    const n = (m[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    let t: SvgMat = SVG_IDENTITY;
    if (fn === 'matrix' && n.length >= 6) {
      t = [n[0], n[1], n[2], n[3], n[4], n[5]];
    } else if (fn === 'translate') {
      t = [1, 0, 0, 1, n[0] || 0, n[1] || 0];
    } else if (fn === 'scale') {
      const sx = n.length ? n[0] : 1;
      t = [sx, 0, 0, n.length > 1 ? n[1] : sx, 0, 0];
    } else if (fn === 'rotate') {
      const a = (n[0] || 0) * DEG;
      const c = Math.cos(a);
      const s = Math.sin(a);
      t = [c, s, -s, c, 0, 0];
      if (n.length >= 3) {
        // rotate(a, cx, cy) = T(cx,cy) · R(a) · T(-cx,-cy)
        t = mulMat(mulMat([1, 0, 0, 1, n[1], n[2]], t), [1, 0, 0, 1, -n[1], -n[2]]);
      }
    } else if (fn === 'skewx') {
      t = [1, 0, Math.tan((n[0] || 0) * DEG), 1, 0, 0];
    } else if (fn === 'skewy') {
      t = [1, Math.tan((n[0] || 0) * DEG), 0, 1, 0, 0];
    }
    out = mulMat(out, t);
  }
  return out;
}

/**
 * Эллиптическая дуга SVG (команда A) → кубические Безье по алгоритму из
 * спецификации SVG (F.6). Дуга делится на сегменты не больше 90°, каждый
 * аппроксимируется кубикой с коэффициентом 4/3·tan(Δθ/4).
 */
export function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, rotDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number
): [Pt, Pt, Pt, Pt][] {
  const out: [Pt, Pt, Pt, Pt][] = [];
  if ((Math.abs(x1 - x2) < 1e-12 && Math.abs(y1 - y2) < 1e-12) || !rxIn || !ryIn) return out;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = rotDeg * DEG;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // радиусов может не хватить — масштабируем их (SVG F.6.6)
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = den > 1e-12 ? sign * Math.sqrt(Math.max(0, num / den)) : 0;
  const cxp = co * (rx * y1p) / ry;
  const cyp = co * (-ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const d = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    let a = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dtheta = angle(ux, uy, vx, vy);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;

  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  const point = (t: number): Pt => {
    const xr = rx * Math.cos(t);
    const yr = ry * Math.sin(t);
    return { x: cosPhi * xr - sinPhi * yr + cx, y: sinPhi * xr + cosPhi * yr + cy };
  };
  const tangent = (t: number): Pt => {
    const dxr = -rx * Math.sin(t);
    const dyr = ry * Math.cos(t);
    return { x: cosPhi * dxr - sinPhi * dyr, y: sinPhi * dxr + cosPhi * dyr };
  };
  for (let n = 0; n < segs; n++) {
    const t0 = theta1 + n * delta;
    const t1 = t0 + delta;
    const p0 = point(t0);
    const p3 = point(t1);
    const d0 = tangent(t0);
    const d1 = tangent(t1);
    out.push([
      p0,
      { x: p0.x + k * d0.x, y: p0.y + k * d0.y },
      { x: p3.x - k * d1.x, y: p3.y - k * d1.y },
      p3,
    ]);
  }
  return out;
}

/**
 * Разбор атрибута d="…" в пространстве SVG (Y вниз, без переворота).
 * Поддержаны все команды контура: M L H V C S Q T A Z, строчные — относительные.
 * Квадратичные (Q/T) переводятся в кубические точно, дуги (A) — кусками Безье.
 */
export function parseSvgPathData(d: string): { nodes: PathNode[]; closed: boolean }[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const subpaths: { nodes: PathNode[]; closed: boolean }[] = [];
  let cur: PathNode[] = [];
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let i = 0;
  let cmd = 'M';
  let prev = '';
  // последние управляющие точки для гладких команд S и T
  let lastC2: Pt | null = null;
  let lastQ: Pt | null = null;

  const nextNum = (): number => {
    const v = Number(tokens[i++]);
    return Number.isFinite(v) ? v : 0;
  };
  /** Кубический сегмент: рычаг предыдущего узла наружу, у нового узла — входящий. */
  const pushCubic = (c1: Pt, c2: Pt, end: Pt) => {
    if (cur.length > 0) {
      cur[cur.length - 1].cp2x = c1.x;
      cur[cur.length - 1].cp2y = c1.y;
    }
    cur.push({ x: end.x, y: end.y, cp1x: c2.x, cp1y: c2.y, smooth: true });
    cx = end.x;
    cy = end.y;
  };
  const flush = (closed: boolean) => {
    if (cur.length >= 2) subpaths.push({ nodes: cur, closed });
    cur = [];
  };

  while (i < tokens.length) {
    const tok = tokens[i];
    if (/^[a-zA-Z]$/.test(tok)) {
      cmd = tok;
      i++;
    }
    const rel = cmd === cmd.toLowerCase();
    const abs = (x: number, y: number): Pt => (rel ? { x: cx + x, y: cy + y } : { x, y });

    if (cmd === 'M' || cmd === 'm') {
      flush(false);
      const p = abs(nextNum(), nextNum());
      cx = p.x;
      cy = p.y;
      startX = cx;
      startY = cy;
      cur.push({ x: cx, y: cy });
      cmd = rel ? 'l' : 'L';
    } else if (cmd === 'L' || cmd === 'l') {
      const p = abs(nextNum(), nextNum());
      cx = p.x;
      cy = p.y;
      if (!cur.length) cur.push({ x: startX, y: startY });
      cur.push({ x: cx, y: cy });
    } else if (cmd === 'H' || cmd === 'h') {
      cx = rel ? cx + nextNum() : nextNum();
      cur.push({ x: cx, y: cy });
    } else if (cmd === 'V' || cmd === 'v') {
      cy = rel ? cy + nextNum() : nextNum();
      cur.push({ x: cx, y: cy });
    } else if (cmd === 'C' || cmd === 'c') {
      const c1 = abs(nextNum(), nextNum());
      const c2 = abs(nextNum(), nextNum());
      const p = abs(nextNum(), nextNum());
      pushCubic(c1, c2, p);
      lastC2 = c2;
    } else if (cmd === 'S' || cmd === 's') {
      // гладкая кубика: первый рычаг — отражение последнего второго рычага
      const c1: Pt = (lastC2 && /[CcSs]/.test(prev))
        ? { x: 2 * cx - lastC2.x, y: 2 * cy - lastC2.y }
        : { x: cx, y: cy };
      const c2 = abs(nextNum(), nextNum());
      const p = abs(nextNum(), nextNum());
      pushCubic(c1, c2, p);
      lastC2 = c2;
    } else if (cmd === 'Q' || cmd === 'q') {
      const q = abs(nextNum(), nextNum());
      const p = abs(nextNum(), nextNum());
      // квадратичная → кубическая: управляющая точка на 2/3 пути к вершине
      pushCubic(
        { x: cx + (q.x - cx) * 2 / 3, y: cy + (q.y - cy) * 2 / 3 },
        { x: p.x + (q.x - p.x) * 2 / 3, y: p.y + (q.y - p.y) * 2 / 3 },
        p,
      );
      lastQ = q;
    } else if (cmd === 'T' || cmd === 't') {
      const q: Pt = (lastQ && /[QqTt]/.test(prev))
        ? { x: 2 * cx - lastQ.x, y: 2 * cy - lastQ.y }
        : { x: cx, y: cy };
      const p = abs(nextNum(), nextNum());
      pushCubic(
        { x: cx + (q.x - cx) * 2 / 3, y: cy + (q.y - cy) * 2 / 3 },
        { x: p.x + (q.x - p.x) * 2 / 3, y: p.y + (q.y - p.y) * 2 / 3 },
        p,
      );
      lastQ = q;
    } else if (cmd === 'A' || cmd === 'a') {
      const rx = nextNum();
      const ry = nextNum();
      const rot = nextNum();
      const large = nextNum() !== 0;
      const sweep = nextNum() !== 0;
      const p = abs(nextNum(), nextNum());
      const cubics = arcToCubics(cx, cy, rx, ry, rot, large, sweep, p.x, p.y);
      if (!cubics.length) {
        cur.push({ x: p.x, y: p.y });
        cx = p.x;
        cy = p.y;
      } else {
        for (const [p0, c1, c2, p3] of cubics) {
          if (!cur.length) cur.push({ x: p0.x, y: p0.y });
          pushCubic(c1, c2, p3);
        }
      }
    } else if (cmd === 'Z' || cmd === 'z') {
      flush(true);
      cx = startX;
      cy = startY;
      cur = [];
    } else {
      i++;
      continue;
    }
    if (!/[Zz]/.test(cmd)) {
      if (!/[CcSs]/.test(cmd)) lastC2 = null;
      if (!/[QqTt]/.test(cmd)) lastQ = null;
    }
    prev = cmd;
  }
  flush(false);
  return subpaths;
}

/** Узлы и рычаги из пространства SVG в мир: матрица группы, затем переворот Y. */
function xformNodes(nodes: PathNode[], m: SvgMat, flipH: number): PathNode[] {
  const pt = (x: number, y: number): Pt => {
    const q = applyMat(m, x, y);
    return { x: q.x, y: flipH - q.y };
  };
  return nodes.map((n) => {
    const p = pt(n.x, n.y);
    const out: PathNode = { x: p.x, y: p.y };
    if (n.cp1x !== undefined && n.cp1y !== undefined) {
      const c = pt(n.cp1x, n.cp1y);
      out.cp1x = c.x;
      out.cp1y = c.y;
    }
    if (n.cp2x !== undefined && n.cp2y !== undefined) {
      const c = pt(n.cp2x, n.cp2y);
      out.cp2x = c.x;
      out.cp2y = c.y;
    }
    if (n.smooth) out.smooth = true;
    return out;
  });
}

/**
 * Высота области SVG в миллиметрах: по viewBox, затем по height="…мм/см/дюйм/pt".
 * Переворот Y делается относительно неё, а не относительно высоты нашего листа —
 * иначе чужой файл приезжает смещённым или обрезанным по низу.
 */
export function svgHeightMm(svg: string, fallback: number): number {
  const head = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const vb = /viewBox\s*=\s*["']\s*([-+.\d\seE,]+)["']/i.exec(head);
  if (vb) {
    const n = (vb[1].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    if (n.length >= 4 && Number.isFinite(n[3]) && n[3] > 0) return n[3];
  }
  const h = /\bheight\s*=\s*["']\s*([-+.\d]+)\s*(mm|cm|in|pt|px|pc)?\s*["']/i.exec(head);
  if (h) {
    const v = parseFloat(h[1]);
    if (Number.isFinite(v) && v > 0) {
      const unit = (h[2] ?? '').toLowerCase();
      if (unit === 'cm') return v * 10;
      if (unit === 'in') return v * 25.4;
      if (unit === 'pt') return v * 25.4 / 72;
      if (unit === 'pc') return v * 25.4 / 6;
      if (unit === 'px') return v * 25.4 / 96;
      return v; // мм или единицы пользователя — считаем миллиметрами
    }
  }
  return fallback;
}

/** Окружность/эллипс/дуга SVG → узлы Безье (та же аппроксимация, что и в редакторе). */
function ellipseNodes(cx: number, cy: number, rx: number, ry: number): PathNode[] {
  const tmp: LaserShape = {
    id: 'svg-ellipse', kind: 'ellipse', layer: 'cut', name: 'tmp',
    cx, cy, rx, ry, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  return shapeToPath(tmp)[0]?.nodes ?? [];
}

export function importVectorFile(content: string, filename: string, docH = 200): LaserShape[] {
  const lower = filename.toLowerCase();
  // DXF узнаём по имени или по разделу ENTITIES на отдельной строке —
  // слово в комментарии SVG не должно переключать парсер
  if (lower.endsWith('.dxf') || /^\s*ENTITIES\s*$/mi.test(content)) {
    return parseDxfContent(content);
  }
  return parseSvgContent(content, docH);
}

/**
 * Чтение SVG без DOM-парсера: теги сканируются по порядку, атрибуты группы <g>
 * (слой и transform) наследуются вложенными фигурами. Слой определяется по id
 * группы (id="layer-fold"), по data-layer или по пунктиру stroke-dasharray (биговка).
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
  /**
   * Слой, заданный явно: id="layer-fold", data-layer="fold" или пунктир
   * stroke-dasharray (биговка). null — слой не указан, берём у группы выше.
   */
  const layerOf = (attrs: string): LaserLayerId | null => {
    const id = attr(attrs, 'id').toLowerCase();
    const known = id.match(/layer-(cut|inner|fold|score|engrave|guide)/);
    if (known) return known[1] as LaserLayerId;
    const dataLayer = attr(attrs, 'data-layer').toLowerCase();
    if (/^(cut|inner|fold|score|engrave|guide)$/.test(dataLayer)) return dataLayer as LaserLayerId;
    if (attr(attrs, 'stroke-dasharray')) return 'fold';
    return null;
  };
  const flipH = svgHeightMm(svg, docH);

  // Стек групп: фигура берёт слой и матрицу ближайших групп, где они заданы
  const layerStack: (LaserLayerId | null)[] = [];
  const matStack: SvgMat[] = [];
  const tagRe = /<(\/?)(g|rect|circle|ellipse|line|polyline|polygon|path)\b([^>]*?)(\/?)>/gi;
  let m: RegExpExecArray | null;

  /** Кривая из узлов SVG-пространства: матрица, переворот Y, слой и имя. */
  const emit = (nodes: PathNode[], closed: boolean, mat: SvgMat, layer: LaserLayerId, name: string, dataName: string) => {
    if (nodes.length < 2) return;
    shapes.push({
      id: luid('svg'),
      kind: 'path',
      layer,
      name: dataName || name,
      nodes: xformNodes(nodes, mat, flipH),
      closed,
      filled: false,
    });
  };

  while ((m = tagRe.exec(svg)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const attrs = m[3];

    if (tag === 'g') {
      if (closing) {
        layerStack.pop();
        matStack.pop();
      } else {
        layerStack.push(layerOf(attrs));
        const parent = matStack[matStack.length - 1] ?? SVG_IDENTITY;
        matStack.push(mulMat(parent, parseSvgTransform(attr(attrs, 'transform'))));
      }
      continue;
    }
    if (closing) continue;

    const own = layerOf(attrs);
    const inherited = [...layerStack].reverse().find((x) => x !== null && x !== undefined) ?? null;
    const layer: LaserLayerId = own ?? inherited ?? 'cut';
    const parentMat = matStack[matStack.length - 1] ?? SVG_IDENTITY;
    const mat = mulMat(parentMat, parseSvgTransform(attr(attrs, 'transform')));
    const dataName = attr(attrs, 'data-name');

    if (tag === 'rect') {
      const w = numAttr(attrs, 'width');
      const h = numAttr(attrs, 'height');
      if (w <= 0 || h <= 0) continue;
      const x = numAttr(attrs, 'x');
      const y = numAttr(attrs, 'y');
      if (isTranslate(mat)) {
        // простой перенос: оставляем редактируемый прямоугольник
        shapes.push({
          id: luid('svg'), kind: 'rect', layer,
          name: dataName || 'Импорт прямоугольник',
          x: x + mat[4], y: flipH - (y + mat[5]) - h, w, h,
          rx: numAttr(attrs, 'rx'), rot: 0, filled: false,
        });
      } else {
        const rx = Math.min(numAttr(attrs, 'rx'), w / 2, h / 2);
        const corners: PathNode[] = rx > 0
          ? shapeToPath({
            id: 'svg-rect', kind: 'rect', layer: 'cut', name: 'tmp', x, y, w, h, rx, rot: 0, filled: false,
          } as LaserShape)[0]?.nodes ?? []
          : [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
        emit(corners, true, mat, layer, 'Импорт прямоугольник', dataName);
      }
    } else if (tag === 'circle' || tag === 'ellipse') {
      const r = numAttr(attrs, 'r');
      const rx = tag === 'circle' ? r : numAttr(attrs, 'rx');
      const ry = tag === 'circle' ? r : numAttr(attrs, 'ry');
      if (rx <= 0 || ry <= 0) continue;
      const cx = numAttr(attrs, 'cx');
      const cy = numAttr(attrs, 'cy');
      if (isTranslate(mat)) {
        shapes.push({
          id: luid('svg'), kind: 'ellipse', layer,
          name: dataName || 'Импорт окружность',
          cx: cx + mat[4], cy: flipH - (cy + mat[5]), rx, ry,
          rot: 0, startAngle: 0, endAngle: 360, filled: false,
        });
      } else {
        emit(ellipseNodes(cx, cy, rx, ry), true, mat, layer, 'Импорт окружность', dataName);
      }
    } else if (tag === 'line') {
      emit([
        { x: numAttr(attrs, 'x1'), y: numAttr(attrs, 'y1') },
        { x: numAttr(attrs, 'x2'), y: numAttr(attrs, 'y2') },
      ], false, mat, layer, 'Импорт линия', dataName);
    } else if (tag === 'polyline' || tag === 'polygon') {
      const nums = attr(attrs, 'points').trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
      const nodes: PathNode[] = [];
      for (let i2 = 0; i2 + 1 < nums.length; i2 += 2) nodes.push({ x: nums[i2], y: nums[i2 + 1] });
      emit(nodes, tag === 'polygon', mat, layer,
        tag === 'polygon' ? 'Импорт полигон' : 'Импорт ломаная', dataName);
    } else if (tag === 'path') {
      const d = attr(attrs, 'd');
      if (!d) continue;
      for (const sp of parseSvgPathData(d)) {
        emit(sp.nodes, sp.closed, mat, layer, 'Импорт контур', dataName);
      }
    }
  }
  return shapes;
}

/** Импорт DXF: сущности LINE/CIRCLE/ARC/ELLIPSE/LWPOLYLINE/POLYLINE/SPLINE/TEXT/INSERT */
function parseDxfContent(dxf: string): LaserShape[] {
  return dxfToShapes(dxf);
}
