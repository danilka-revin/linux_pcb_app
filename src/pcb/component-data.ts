// BOM, обозначения компонентов, pick-and-place и сборочный чертёж.
import type { Comp, Doc, Entity, Pt } from './model';
import { boardShape } from './board-shape';

export interface ComponentRow {
  id: string;
  ref: string;
  value: string;
  footprint: string;
  manufacturer: string;
  mpn: string;
  datasheet: string;
  x: number;
  y: number;
  rotation: number;
  side: 'top' | 'bottom';
  source: Comp;
}
export interface BomRow {
  value: string;
  footprint: string;
  manufacturer: string;
  mpn: string;
  quantity: number;
  references: string[];
  datasheets: string[];
}

export function componentPrefix(name: string): string {
  const s = name.toLocaleLowerCase();
  if (/(?:resistor|res|резистор|резист)|^r\d/.test(s)) return 'R';
  if (/(?:capacitor|cap|конденсатор|конденс)|^c\d/.test(s)) return 'C';
  if (/(?:led|diode|диод|светодиод)|^d\d/.test(s)) return 'D';
  if (/(?:inductor|coil|катушка|дроссел)|^l\d/.test(s)) return 'L';
  if (/(?:connector|conn|header|terminal|разъ[её]м|клеммник|гнездо)|^j\d/.test(s)) return 'J';
  if (/(?:switch|button|кнопка|переключатель)|^sw\d/.test(s)) return 'SW';
  if (/(?:transistor|mosfet|транзистор)|^q\d/.test(s)) return 'Q';
  if (/(?:fuse|предохранител)|^f\d/.test(s)) return 'F';
  if (/(?:crystal|quartz|кварц|резонатор)|^y\d/.test(s)) return 'Y';
  if (/(?:testpoint|test point|контрольная точка)|^tp\d/.test(s)) return 'TP';
  return 'U';
}

function usedReferences(entities: Entity[], skipId?: string): Set<string> {
  return new Set(entities.filter((e): e is Comp => e.kind === 'comp' && e.id !== skipId && !!e.ref)
    .map((e) => e.ref!.trim().toLocaleUpperCase()));
}

export function nextReference(name: string, entities: Entity[], skipId?: string): string {
  const prefix = componentPrefix(name);
  const used = usedReferences(entities, skipId);
  for (let i = 1; i < 100_000; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}${Date.now().toString(36)}`;
}

/** Stable references are calculated for legacy components, but not written until user saves metadata. */
export function componentRows(doc: Doc): ComponentRow[] {
  const comps = doc.entities.filter((e): e is Comp => e.kind === 'comp');
  const used = new Set<string>();
  const next = new Map<string, number>();
  return comps.map((comp) => {
    const prefix = componentPrefix(comp.name);
    let ref = (comp.ref ?? '').trim();
    if (!ref || used.has(ref.toLocaleUpperCase())) {
      let n = next.get(prefix) ?? 1;
      while (used.has(`${prefix}${n}`.toLocaleUpperCase())) n++;
      ref = `${prefix}${n}`;
      next.set(prefix, n + 1);
    }
    used.add(ref.toLocaleUpperCase());
    return {
      id: comp.id,
      ref,
      value: comp.value ?? comp.name,
      footprint: comp.footprint ?? comp.name,
      manufacturer: comp.manufacturer ?? '',
      mpn: comp.mpn ?? '',
      datasheet: comp.datasheet ?? '',
      x: comp.x, y: comp.y,
      rotation: comp.side === 'bottom' ? ((360 - comp.rot) % 360 + 360) % 360 : ((comp.rot % 360) + 360) % 360,
      side: comp.side,
      source: comp,
    };
  });
}

const compareText = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const groupKey = (r: ComponentRow): string => [r.value, r.footprint, r.manufacturer, r.mpn].join('\u001f');

export function buildBom(rows: ComponentRow[]): BomRow[] {
  const map = new Map<string, BomRow>();
  for (const row of rows) {
    const key = groupKey(row);
    const entry = map.get(key) ?? {
      value: row.value, footprint: row.footprint, manufacturer: row.manufacturer, mpn: row.mpn,
      quantity: 0, references: [], datasheets: [],
    };
    entry.quantity++;
    entry.references.push(row.ref);
    if (row.datasheet && !entry.datasheets.includes(row.datasheet)) entry.datasheets.push(row.datasheet);
    map.set(key, entry);
  }
  return [...map.values()].map((row) => ({
    ...row, references: row.references.sort(compareText), datasheets: row.datasheets.sort(compareText),
  })).sort((a, b) => compareText(a.value, b.value) || compareText(a.footprint, b.footprint));
}

export function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const csv = (rows: unknown[][]): string => rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
export function bomCsv(rows: ComponentRow[]): string {
  return csv([
    ['Designator', 'Value', 'Footprint', 'Quantity', 'Manufacturer', 'MPN', 'Datasheet'],
    ...buildBom(rows).map((r) => [r.references.join(' '), r.value, r.footprint, r.quantity,
      r.manufacturer, r.mpn, r.datasheets.join(' ') ]),
  ]);
}
export function pickPlaceCsv(rows: ComponentRow[]): string {
  return csv([
    ['Designator', 'Value', 'Package', 'X (mm)', 'Y (mm)', 'Rotation (deg)', 'Side'],
    ...rows.slice().sort((a, b) => compareText(a.ref, b.ref)).map((r) => [
      r.ref, r.value, r.footprint, r.x.toFixed(4), r.y.toFixed(4), r.rotation.toFixed(1), r.side.toUpperCase(),
    ]),
  ]);
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
const fmt = (v: number): string => Number(v.toFixed(4)).toString();

/** A lightweight SVG assembly drawing; units are mm and the board origin is bottom-left. */
export function assemblySvg(doc: Doc, rows: ComponentRow[], side: 'top' | 'bottom'): string {
  const shape = boardShape(doc);
  const [x1, y1, x2, y2] = shape.bounds;
  const width = Math.max(1, x2 - x1), height = Math.max(1, y2 - y1);
  const margin = Math.max(3, Math.max(width, height) * 0.06);
  const sideRows = rows.filter((r) => r.side === side);
  const loops = shape.loops.map((loop) => loop.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x - x1)},${fmt(y2 - p.y)}`).join(' ') + ' Z').join(' ');
  const marks = sideRows.map((row) => {
    const px = row.x - x1, py = y2 - row.y;
    const comp = row.source;
    const dx = Math.abs(comp.bl[2] - comp.bl[0]), dy = Math.abs(comp.bl[3] - comp.bl[1]);
    const radius = Math.max(0.7, Math.min(2.5, Math.max(dx, dy) / 2 || 1));
    return `<g transform="translate(${fmt(px)} ${fmt(py)})"><circle r="${fmt(radius)}" fill="#f5b83d" fill-opacity=".14" stroke="#b97900" stroke-width=".18"/><text x="0" y="-.4" text-anchor="middle" font-family="sans-serif" font-size="1.3" font-weight="700">${esc(row.ref)}</text><text x="0" y="1.2" text-anchor="middle" font-family="sans-serif" font-size=".9">${esc(row.value)}</text></g>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width + margin * 2)}mm" height="${fmt(height + margin * 2)}mm" viewBox="${fmt(-margin)} ${fmt(-margin)} ${fmt(width + margin * 2)} ${fmt(height + margin * 2)}">\n<title>${esc(doc.name)} · сборка · ${side === 'top' ? 'верх' : 'низ'}</title>\n<g transform="translate(0 ${fmt(height)}) scale(1 -1)"><path d="${loops}" fill="#6e9a71" fill-opacity=".12" fill-rule="evenodd" stroke="#343b45" stroke-width=".22"/>\n${marks}</g>\n<text x="${fmt(margin)}" y="${fmt(height + margin + 1)}" font-family="sans-serif" font-size="1.8">${esc(doc.name)} · сторона ${side === 'top' ? 'верх' : 'низ'} · ${sideRows.length} компонентов · координаты мм, начало внизу слева</text>\n</svg>\n`;
}

export function metadataPatch(row: ComponentRow): Pick<Comp, 'ref' | 'value' | 'footprint' | 'manufacturer' | 'mpn' | 'datasheet'> {
  return {
    ref: row.ref.trim(), value: row.value.trim(), footprint: row.footprint.trim(),
    manufacturer: row.manufacturer.trim(), mpn: row.mpn.trim(), datasheet: row.datasheet.trim(),
  };
}

export function componentPinIds(comp: Comp): Map<string, string> {
  const out = new Map<string, string>();
  (comp.ents ?? []).forEach((e, index) => {
    if ((e.kind === 'pad' || e.kind === 'smd') && e.pin && !out.has(e.pin)) out.set(e.pin, `${comp.id}:${index}`);
  });
  return out;
}

export function componentAnchor(comp: Comp): Pt { return { x: comp.x, y: comp.y }; }
