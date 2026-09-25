import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import { boardInventory } from '../src/pcb/inventory';
import { lay6ToDoc } from '../src/pcb/lay6';
import { generate } from '../src/pcb/gen';
import { libElsToEnts } from '../src/pcb/expand';
import * as M from '../src/pcb/model';
import { InventoryDialog } from '../src/ui/inventory';

const pad = (id: string, size = 2, drill = 0.8, shape: M.PadShape = 'round'): M.Pad => ({ id, kind: 'pad', x: 10, y: 10, size, drill, shape });
const d = M.newBoard();
d.entities.push(pad('a'), pad('b', 2.00000002, 0.80000001), pad('c', 2, 1), pad('solid', 2, 0),
  pad('square', 2, 0.8, 'square'), pad('oct', 2, 0.8, 'oct'), pad('different', 2.001, 0.8),
  { id: 'v', kind: 'via', x: 20, y: 20, size: 2, drill: 0.8 },
  { id: 'hole', kind: 'hole', x: 30, y: 30, d: 0.8 },
  { id: 'mount', kind: 'hole', x: 40, y: 30, d: 3 },
  { id: 's1', kind: 'smd', x: 20, y: 30, w: 1, h: 2, rot: 0, layer: 'k1' },
  { id: 's2', kind: 'smd', x: 20, y: 35, w: 2, h: 1, rot: 90, layer: 'k2' },
  { id: 'track', kind: 'track', pts: [{ x: 1, y: 1 }, { x: 5, y: 1 }], w: 2, layer: 'k1' },
  { id: 'circle', kind: 'circle', x: 25, y: 25, r: 2, w: 0.2, layer: 'outline' });
const before = JSON.stringify(d);
const stats = boardInventory(d.entities);
assert.equal(JSON.stringify(d), before, 'does not mutate the document');
assert.deepEqual(stats.totals, { pads: 7, smd: 2, vias: 1, holes: 9, mounting: 2 });
const round2 = stats.pads.find((p) => p.key === 'pad:round:2:2')!;
assert.equal(round2.count, 4, 'same pad size grouped regardless of drill, no duplicate layers');
assert.deepEqual(round2.drills, [{ diameter: 0, count: 1 }, { diameter: 0.8, count: 2 }, { diameter: 1, count: 1 }]);
assert.equal(stats.pads.filter((p) => p.kind === 'smd').length, 1);
assert.equal(stats.pads.find((p) => p.kind === 'smd')!.count, 2, 'rotation/side irrelevant');
assert.equal(stats.pads.length, 6, 'separate shapes, exact sizes and vias');
assert.deepEqual(stats.drills, [
  { diameter: 0.8, pads: 5, vias: 1, mounting: 1, count: 7 },
  { diameter: 1, pads: 1, vias: 0, mounting: 0, count: 1 },
  { diameter: 3, pads: 0, vias: 0, mounting: 1, count: 1 },
]);
assert.equal(boardInventory([]).totals.holes, 0);
assert.deepEqual(boardInventory([]).pads, []);

// Детали кладутся на плату со своими примитивами (генератор → comp.ents) и
// считаются ровно один раз, без двойного счёта вложенных выводов.
const dip8 = generate('dip 8');
const pins = (prefix: string): M.Entity[] =>
  libElsToEnts(dip8.els).filter((e) => e.kind === 'pad').map((e, i) => ({ ...e, id: `${prefix}${i}` }) as M.Entity);
const comps: M.Entity[] = [
  { id: 'macro', kind: 'comp', lib: '', name: 'Macro', x: 10, y: 10, rot: 90, side: 'bottom', bl: [0, 0, 10, 10], ents: [pad('x'), pad('y')] },
  { id: 'dip', kind: 'comp', lib: '', name: 'DIP-8', x: 30, y: 30, rot: 180, side: 'top', bl: dip8.bl, ents: pins('d') },
];
assert.equal(boardInventory(comps).totals.pads, 10);
assert.equal(boardInventory(comps).totals.holes, 10);
const { doc: imported } = lay6ToDoc(readFileSync('test/fixtures/test1.lay6'));
const fixture = boardInventory(imported.entities);
assert.equal(fixture.totals.pads, 180);
assert.equal(fixture.totals.mounting, 4);
assert.equal(fixture.totals.holes, 184);
assert.equal(fixture.pads.filter((p) => p.kind === 'pad' && p.w === 2).reduce((sum, p) => sum + p.count, 0), 149);
assert.equal(fixture.drills.reduce((sum, r) => sum + r.count, 0), 184);
// Recompute after edits/undo — inventory is derived, not stale cached document metadata.
const removed = d.entities.filter((e) => e.id !== 'a');
assert.equal(boardInventory(removed).totals.pads, 6);
assert.equal(boardInventory(JSON.parse(before).entities).totals.pads, 7);

const html = renderToString(createElement(InventoryDialog, { doc: d, onClose: () => {} }));
assert(html.includes('Перечень площадок и отверстий') && html.includes('role="dialog"'));
assert(html.includes('Ø2') && html.includes('Сверловка по диаметрам'));
const emptyHtml = renderToString(createElement(InventoryDialog, { doc: M.newBoard(), onClose: () => {} }));
assert(emptyHtml.includes('На плате пока нет площадок'));
console.log('INVENTORY OK: sizes, drills, shapes, SMD, vias, macros, DIP, lay6, edits, empty board, SSR');
