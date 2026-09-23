// Перечень площадок и сверловки: считаем физические объекты, не слои меди.
import type { Entity, PadShape } from './model';
import { expandDoc } from './expand';

export interface PadStock {
  key: string;
  kind: 'pad' | 'via' | 'smd';
  shape: PadShape | 'smd';
  w: number;
  h: number;
  count: number;
  drills: { diameter: number; count: number }[]; // 0 — без сверления
}

export interface DrillStock {
  diameter: number;
  pads: number;
  vias: number;
  mounting: number;
  count: number;
}

export interface BoardInventory {
  pads: PadStock[];
  drills: DrillStock[];
  totals: { pads: number; smd: number; vias: number; holes: number; mounting: number };
}

// 1 мкм: как точность отображения размеров в редакторе. Убирает шум float из .lay6.
const mm = (n: number): number => Math.round(n * 1000) / 1000;

export function boardInventory(entities: Entity[]): BoardInventory {
  const pads = new Map<string, PadStock>();
  const drills = new Map<number, DrillStock>();
  const totals = { pads: 0, smd: 0, vias: 0, holes: 0, mounting: 0 };
  const addDrill = (diameter: number, kind: 'pads' | 'vias' | 'mounting') => {
    if (!(diameter > 0)) return;
    diameter = mm(diameter);
    let row = drills.get(diameter);
    if (!row) { row = { diameter, pads: 0, vias: 0, mounting: 0, count: 0 }; drills.set(diameter, row); }
    row[kind]++; row.count++; totals.holes++;
    if (kind === 'mounting') totals.mounting++;
  };
  for (const e of expandDoc(entities)) {
    if (e.kind === 'hole') { addDrill(e.d, 'mounting'); continue; }
    if (e.kind !== 'pad' && e.kind !== 'via' && e.kind !== 'smd') continue;
    // SMD 1×2 и повёрнутая 2×1 — один типоразмер, независимо от стороны платы.
    const w = mm(e.kind === 'smd' ? Math.min(e.w, e.h) : e.size);
    const h = mm(e.kind === 'smd' ? Math.max(e.w, e.h) : e.size);
    const shape = e.kind === 'smd' ? 'smd' : e.kind === 'via' ? 'round' : e.shape;
    const key = `${e.kind}:${shape}:${w}:${h}`;
    let row = pads.get(key);
    if (!row) { row = { key, kind: e.kind, shape, w, h, count: 0, drills: [] }; pads.set(key, row); }
    row.count++;
    totals[e.kind === 'pad' ? 'pads' : e.kind === 'via' ? 'vias' : 'smd']++;
    if (e.kind !== 'smd') {
      const diameter = mm(e.drill);
      const item = row.drills.find((d) => d.diameter === diameter);
      if (item) item.count++;
      else row.drills.push({ diameter, count: 1 });
      addDrill(e.drill, e.kind === 'pad' ? 'pads' : 'vias');
    }
  }
  const order = { pad: 0, smd: 1, via: 2 };
  const padRows = [...pads.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.w - b.w || a.h - b.h || a.shape.localeCompare(b.shape));
  padRows.forEach((p) => p.drills.sort((a, b) => a.diameter - b.diameter));
  return { pads: padRows, drills: [...drills.values()].sort((a, b) => a.diameter - b.diameter), totals };
}
