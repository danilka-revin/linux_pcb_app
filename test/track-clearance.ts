import assert from 'node:assert/strict';
import { trackClearance } from '../src/pcb/track-clearance';
import type { Track } from '../src/pcb/model';
const t = (pts: number[][], w = .4, layer: Track['layer'] = 'k1'): Track => ({
  id: Math.random().toString(), kind: 'track', pts: pts.map(([x, y]) => ({ x, y })), w, layer,
});
const a = t([[0, 0], [10, 0]]);
assert.equal(trackClearance([a, t([[0, .6], [10, .6]])], .2).length, 0);
assert.equal(trackClearance([a, t([[0, .599], [10, .599]])], .2).length, 1);
assert.equal(trackClearance([a, t([[0, .61], [10, .61]])], .2).length, 0);
assert.equal(trackClearance([a, t([[5, -5], [5, 5]])], .2).length, 1);
assert.equal(trackClearance([a, t([[5, -5], [5, 5]], .4, 'k2')], .2).length, 0);
assert.equal(trackClearance([a, t([[10, 0], [12, 2]])], .2).length, 0);
assert.equal(trackClearance([a, t([[0, 0], [5, 0]])], .2).length, 1);
assert.equal(trackClearance([a, t([[2, 0], [5, 0]])], .2).length, 1);
assert.equal(trackClearance([a], .2, [t([[5, -5], [5, 5]])]).length, 1);
assert.equal(trackClearance([a, t([[5, .5], [5, .5]])], .2).length, 1);
assert.equal(trackClearance([a, t([[0, .7], [10, .7]], .8)], .2).length, 1);
assert.equal(trackClearance([a], NaN).length, 0);
const hit = trackClearance([a, t([[5, -5], [5, 5]])], .2)[0];
assert.deepEqual(hit.a, { x: 5, y: 0 });
assert.deepEqual(hit.b, { x: 5, y: 0 });
console.log('Track clearance: threshold, widths, crossing, layers, junctions, overlaps, live candidates OK');
