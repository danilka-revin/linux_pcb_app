import assert from 'node:assert/strict';
import { copperComponents } from '../src/pcb/netroute';
import { computeThermal, thermalColor, thermalHot } from '../src/pcb/thermal';
import { ipc2221Current, ipc2221TempRise, trackResistance } from '../src/pcb/trackcalc';
import type { Entity } from '../src/pcb/model';

// Обратная формула согласована с прямой IPC-2221.
for (const rise of [5, 10, 25, 50]) {
  const i = ipc2221Current(0.5, 35, rise);
  assert.ok(i > 0, `current for ${rise}C`);
  const back = ipc2221TempRise(i, 0.5, 35);
  assert.ok(Math.abs(back - rise) < 0.5, `roundtrip ${rise}C: got ${back}`);
}
assert.equal(ipc2221TempRise(0, 0.5, 35), 0);
assert.equal(ipc2221TempRise(-1, 0.5, 35), 0);
assert.equal(ipc2221TempRise(1, 0, 35), 0);
assert.equal(ipc2221TempRise(1, 0.5, 0), 0);
assert.ok(ipc2221TempRise(2, 0.5, 35) > ipc2221TempRise(1, 0.5, 35), 'monotonic in current');
assert.ok(ipc2221TempRise(1, 0.25, 35) > ipc2221TempRise(1, 0.5, 35), 'narrower heats more');
assert.ok(ipc2221TempRise(1, 0.5, 18) > ipc2221TempRise(1, 0.5, 35), 'thinner copper heats more');
console.log('Thermal physics: IPC-2221 inverse roundtrip, monotonicity, edge zeros OK');

// Палитра и пороги.
assert.notEqual(thermalColor(0), thermalColor(1));
assert.ok(thermalColor(0).startsWith('hsl(240'), thermalColor(0));
assert.ok(thermalColor(1).startsWith('hsl(0'), thermalColor(1));
assert.equal(thermalColor(-5), thermalColor(0), 'clamp low');
assert.equal(thermalColor(5), thermalColor(1), 'clamp high');
assert.equal(thermalHot(5, 10), 0);
assert.equal(thermalHot(12, 10), 1);
assert.equal(thermalHot(35, 10), 2);
console.log('Thermal palette: blue-to-red, clamps, warm/hot thresholds OK');

// Расчёт цепи: площадка + две дорожки стык в стык.
const net: Entity[] = [
  { id: 'p1', kind: 'pad', x: 0, y: 0, shape: 'round', size: 2, drill: 1 },
  { id: 't1', kind: 'track', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], w: 0.5, layer: 'k2' },
  { id: 't2', kind: 'track', pts: [{ x: 10, y: 0 }, { x: 20, y: 0 }], w: 0.25, layer: 'k2' },
];
const comp = copperComponents(net);
assert.equal(comp.get('t1'), comp.get('t2'), 'tracks connected');
assert.equal(comp.get('p1'), comp.get('t1'), 'pad connected');
const keys = new Set([comp.get('t1')!]);
const r = computeThermal(net, comp, keys, 't1', 2, 35, 10);
assert.equal(r.tracks, 2);
assert.equal(r.pads, 1);
assert.equal(r.segs.length, 2);
const expectR = trackResistance(0.5, 10, 35) + trackResistance(0.25, 10, 35);
assert.ok(Math.abs(r.totalR - expectR) < 1e-12, `R total ${r.totalR}`);
assert.ok(Math.abs(r.totalDrop - 2 * expectR) < 1e-12, `drop ${r.totalDrop}`);
assert.ok(Math.abs(r.totalP - 4 * expectR) < 1e-12, `power ${r.totalP}`);
const narrow = r.segs.find((s) => s.id === 't2')!;
const wide = r.segs.find((s) => s.id === 't1')!;
assert.ok(narrow.dT > wide.dT, `narrow ${narrow.dT} > wide ${wide.dT}`);
assert.ok(narrow.t01 >= wide.t01, 'palette follows heat');
assert.equal(r.maxDT, narrow.dT);
// BFS от точки клика: кликнутая — hop 0, сосед — hop 1, направление — от клика.
assert.equal(wide.hop, 0);
assert.equal(narrow.hop, 1);
assert.equal(narrow.flip, false, 't2 already points away from click');
// Клик по дальнему концу разворачивает направление.
const r2 = computeThermal(net, comp, keys, 't2', 2, 35, 10);
const wide2 = r2.segs.find((s) => s.id === 't1')!;
assert.equal(wide2.hop, 1);
assert.equal(wide2.flip, true, 't1 must be drawn backwards from t2 click');
// Пустая цепь и нулевой ток.
assert.equal(computeThermal(net, comp, new Set(['nope']), 't1', 2, 35, 10).segs.length, 0);
assert.equal(computeThermal(net, comp, keys, 't1', 0, 35, 10).maxDT, 0);
console.log('Thermal net: totals, per-segment heat, BFS hops and flow direction OK');
