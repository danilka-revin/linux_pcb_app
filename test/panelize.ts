import assert from 'node:assert/strict';
import { componentRows } from '../src/pcb/component-data';
import { newBoard } from '../src/pcb/model';
import { boardShape } from '../src/pcb/board-shape';
import { DEFAULT_PANELIZE_OPTIONS, panelizeDoc } from '../src/pcb/panelize';

const source = newBoard(20, 10, 'unit');
source.entities.push({ id: 'part', kind: 'comp', ref: 'R1', value: '10k', name: 'resistor', lib: '', x: 5, y: 5, rot: 0, side: 'top', bl: [4, 4, 6, 6], ents: [] });
source.groups = [{ id: 'g1', name: 'signal', ids: ['part'] }];
source.nets = [{ id: 'n1', name: 'GND', pads: ['pad-a', 'pad-b'] }];
const result = panelizeDoc(source, {
  ...DEFAULT_PANELIZE_OPTIONS, cols: 2, rows: 2, stepX: 25, stepY: 15, railWidth: 5,
  toolingHoles: true, fiducials: true, breakawayTabs: true, tabWidth: 5, mouseBiteDia: .5, mouseBitePitch: .8,
  vCutColumns: false, vCutRows: false,
});
const panel = result.doc;
assert.equal(panel.panelInfo?.cols, 2);
assert.equal(panel.panelInfo?.rows, 2);
assert.equal(panel.panelInfo?.breakawayTabs, true);
assert.deepEqual(panel.panelInfo?.railBounds, { x: -5, y: -5, w: 55, h: 35 });
assert.equal(panel.w, 55);
assert.equal(panel.h, 35);
assert.equal(panel.entities.filter((e) => e.kind === 'comp').length, 4);
assert.deepEqual(componentRows(panel).map((r) => r.ref), ['R1', 'R1_P2', 'R1_P3', 'R1_P4']);
assert.equal(panel.groups?.length, 4, 'component groups duplicate with each tile');
assert.equal(panel.nets?.length, 1, 'logical source netlist is retained');
assert(boardShape(panel).openChains > 0, 'breakaway tabs intentionally interrupt panel contours');
assert(result.warnings.length === 0, 'valid panel step has no warnings');
const holes = panel.entities.filter((e) => e.kind === 'hole');
assert.equal(holes.length, 32, 'mouse bites plus four tooling holes');
assert.equal(panel.panelInfo?.featureIds?.length, 38, 'mouse-bites, tooling holes and fiducials are tagged as panel features');
assert.equal(source.entities.filter((e) => e.kind === 'comp').length, 1, 'source board is unchanged');
const secondPanel = panelizeDoc(panel);
assert(secondPanel.warnings.some((w) => w.includes('уже панелизирован')));
assert.equal(secondPanel.doc.entities.length, panel.entities.length, 'nested panelization is rejected without changing the document');
const vcut = panelizeDoc(source, {
  ...DEFAULT_PANELIZE_OPTIONS, cols: 2, rows: 1, stepX: 20, stepY: 10, railWidth: 4,
  breakawayTabs: false, vCutColumns: true, vCutRows: false, toolingHoles: false, fiducials: false,
});
assert.equal(vcut.doc.panelInfo?.vCuts.length, 1);
assert.equal(vcut.doc.panelInfo?.vCuts[0].x1, 20);
const badTabs = panelizeDoc(source, { ...DEFAULT_PANELIZE_OPTIONS, cols: 2, stepX: 20, breakawayTabs: true });
assert(badTabs.warnings.some((w) => w.includes('положительный зазор')));
const badVcut = panelizeDoc(source, { ...DEFAULT_PANELIZE_OPTIONS, cols: 2, stepX: 25, vCutColumns: true });
assert(badVcut.warnings.some((w) => w.includes('заметного зазора')));
const overlap = panelizeDoc(source, { ...DEFAULT_PANELIZE_OPTIONS, cols: 2, stepX: 18, rows: 1 });
assert(overlap.warnings.some((w) => w.includes('перекрываются')));
const one = panelizeDoc(source, { ...DEFAULT_PANELIZE_OPTIONS, cols: 1, rows: 1, railWidth: 0, toolingHoles: true, fiducials: true });
assert.equal(one.doc.entities.filter((e) => e.kind === 'hole').length, 0, 'no tooling holes without rails');
console.log('Panelization: repeated boards, breakaway tabs/mouse-bites, rails, tooling, fiducials, V-cut, groups and unique assembly refs OK');
