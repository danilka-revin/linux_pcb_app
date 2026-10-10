// Размерные линии (размеры чертежа): геометрия для отрисовки, экспорта и
// попадания мышью. Размер живёт как обычный примитив DimE (см. model.ts) и
// рисуется на своём слое (шелкография/контур), поэтому попадает в печать PNG
// и Gerber вместе с остальной графикой слоя.

import type { DimE, Pt } from './model';

export type DimMode = DimE['mode'];

export interface DimGeom {
  /** измеряемые точки */
  a: Pt;
  b: Pt;
  /** точки размерной линии (с учётом смещения off) */
  da: Pt;
  db: Pt;
  /** единичный вектор вдоль размера и нормаль (сторона смещения) */
  dir: Pt;
  n: Pt;
  /** измеренное значение, мм */
  value: number;
  /** готовая подпись */
  label: string;
  /** точка привязки текста (середина размерной линии) */
  mid: Pt;
  /** угол текста, градусы (повёрнут так, чтобы читалось сверху) */
  textAngle: number;
}

const F = (v: number, d = 3): string => String(parseFloat(v.toFixed(d)));

/** Подпись размера: свой текст или «12,7 мм». */
export function dimLabel(d: Pick<DimE, 'x1' | 'y1' | 'x2' | 'y2' | 'mode' | 'text'>): string {
  const custom = (d.text ?? '').trim();
  if (custom) return custom;
  const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
  const value = d.mode === 'horiz' ? Math.abs(dx) : d.mode === 'vert' ? Math.abs(dy) : Math.hypot(dx, dy);
  return `${F(value, 3).replace('.', ',')} мм`;
}

export function dimValue(d: Pick<DimE, 'x1' | 'y1' | 'x2' | 'y2' | 'mode'>): number {
  const dx = d.x2 - d.x1, dy = d.y2 - d.y1;
  return d.mode === 'horiz' ? Math.abs(dx) : d.mode === 'vert' ? Math.abs(dy) : Math.hypot(dx, dy);
}

/** Полная геометрия размера. */
export function dimGeom(d: DimE): DimGeom {
  const a = { x: d.x1, y: d.y1 };
  const b = { x: d.x2, y: d.y2 };
  let dir: Pt, n: Pt, da: Pt, db: Pt;
  const off = d.off ?? 0;
  if (d.mode === 'horiz') {
    const s = b.x >= a.x ? 1 : -1;
    dir = { x: s, y: 0 };
    n = { x: 0, y: 1 };
    const y = (a.y + b.y) / 2 + off;
    da = { x: a.x, y };
    db = { x: b.x, y };
  } else if (d.mode === 'vert') {
    const s = b.y >= a.y ? 1 : -1;
    dir = { x: 0, y: s };
    n = { x: 1, y: 0 };
    const x = (a.x + b.x) / 2 + off;
    da = { x, y: a.y };
    db = { x, y: b.y };
  } else {
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    n = { x: -dir.y, y: dir.x };
    da = { x: a.x + n.x * off, y: a.y + n.y * off };
    db = { x: b.x + n.x * off, y: b.y + n.y * off };
  }
  const mid = { x: (da.x + db.x) / 2, y: (da.y + db.y) / 2 };
  let textAngle = (Math.atan2(dir.y, dir.x) * 180) / Math.PI;
  if (textAngle > 90 || textAngle < -90) textAngle += 180;
  if (textAngle > 90) textAngle -= 360; // нормализация после переворота (360 → 0)
  return { a, b, da, db, dir, n, value: dimValue(d), label: dimLabel(d), mid, textAngle };
}

/** Все отрезки размера: выносные линии + размерная. */
export function dimSegments(d: DimE): [Pt, Pt][] {
  const g = dimGeom(d);
  return [
    [g.a, g.da],
    [g.b, g.db],
    [g.da, g.db],
  ];
}

/**
 * Стрелки на концах размерной линии: два треугольника. len — длина стрелки, мм.
 * dirStr возвращает направление «внутрь» размера.
 */
export function dimArrows(d: DimE, len?: number): Pt[][] {
  const g = dimGeom(d);
  const L = len ?? Math.max(1.2, Math.min(3.5, (d.size || 2.5) * 1.1));
  const w = L * 0.32;
  const arrow = (tip: Pt, sign: number): Pt[] => {
    const back = { x: tip.x - g.dir.x * L * sign, y: tip.y - g.dir.y * L * sign };
    const p1 = { x: back.x + g.n.x * w, y: back.y + g.n.y * w };
    const p2 = { x: back.x - g.n.x * w, y: back.y - g.n.y * w };
    return [tip, p1, p2];
  };
  return [arrow(g.da, 1), arrow(g.db, -1)];
}
