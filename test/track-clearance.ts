import assert from 'node:assert/strict';
import { activeClearance, trackClearance } from '../src/pcb/track-clearance';
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

const near = t([[0, .5], [10, .5]]);
const violations = trackClearance([a, near], .2);
const ignored = [violations[0].key];
assert.equal(activeClearance(violations, ignored).length, 0);
assert.equal(activeClearance(violations, []).length, 1, 'restore');
assert.equal(activeClearance(trackClearance([near, a], .2), ignored).length, 0, 'entity order does not invalidate exception');
assert.equal(activeClearance(trackClearance(JSON.parse(JSON.stringify([a, near])), .2), ignored).length, 0, 'save/reload');
assert.equal(activeClearance(trackClearance([a, { ...near, w: .45 }], .2), ignored).length, 1, 'width edit rechecks');
assert.equal(activeClearance(trackClearance([a, { ...near, pts: [{ x: 0, y: .4 }, { x: 10, y: .4 }] }], .2), ignored).length, 1, 'geometry edit rechecks');
assert.equal(activeClearance(trackClearance([a, near], .3), ignored).length, 1, 'changed rule rechecks');
const extra = t([[0, -.5], [10, -.5]]);
assert.equal(activeClearance(trackClearance([a, near, extra], .2), ignored).length, 1, 'other violations stay visible');
assert.equal(activeClearance(trackClearance([a, { ...near, id: 'copy' }], .2), ignored).length, 1, 'new entities do not inherit exceptions');
console.log('DRC exceptions: selective, persistent, reversible, geometry- and rule-bound OK');
