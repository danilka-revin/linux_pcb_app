import assert from 'node:assert/strict';
import { copperShapes, shapeShapeDist } from '../src/pcb/autoroute';
import { canRepair, repairClearance } from '../src/pcb/drc-repair';
import { trackClearance } from '../src/pcb/track-clearance';
import type { Doc, Track, Via } from '../src/pcb/model';

const T = (id: string, pts: number[][], w = 0.5): Track => ({
  id, kind: 'track', pts: pts.map(([x, y]) => ({ x, y })), w, layer: 'k2',
});
const V = (id: string, x: number, y: number, size = 1.0, drill = 0.5): Via => ({
  id, kind: 'via', x, y, size, drill,
});

// --- Дорожка проходит вплотную к переходу: зазор 0,15 при норме 0,4 ---
const viaDoc: Doc = {
  name: 'via', w: 40, h: 20,
  entities: [T('a', [[0, 5], [30, 5]]), V('v1', 15, 5.9)],
};
assert.equal(canRepair(viaDoc, ['a', 'v1']), true, 'track+via repairable');
assert.equal(canRepair(viaDoc, ['v1']), false, 'no track — nothing to relay');
assert.equal(canRepair(viaDoc, ['c:0']), false, 'inside component — hands only');
assert.equal(canRepair(viaDoc, undefined), false);
assert.equal(canRepair(viaDoc, []), false);

const r = repairClearance({ doc: viaDoc, x: 15, y: 5.4, rule: 0.4, layer: 'k2' });
assert.equal(r.ok, true, r.msg);
assert.ok(r.doc, 'repaired doc returned');
assert.equal(r.trackId, 'a');
assert.ok((r.addedLen ?? 0) > 0, `detour adds length: ${r.addedLen}`);
const next = r.doc!.entities.find((e) => e.id === 'a') as Track;
assert.ok(next.pts.length > 2, 'detour has bends');
// Остальные объекты не тронуты — тот же объект по значению.
assert.deepEqual(r.doc!.entities.find((e) => e.id === 'v1'), viaDoc.entities[1]);
// Новый путь держит зазор от перехода по всей длине (якоря — в чистом месте).
let minGap = Infinity;
for (const sv of copperShapes(next)) {
  for (const so of copperShapes(viaDoc.entities[1])) {
    if (so.hole) continue;
    minGap = Math.min(minGap, shapeShapeDist(sv, so));
  }
}
assert.ok(minGap >= 0.4 - 1e-6, `gap to via ${minGap}`);
assert.equal(trackClearance(r.doc!.entities, 0.4).length, 0, 'no track-track violations');
console.log(`DRC repair track-vs-via: ok, +${r.addedLen!.toFixed(2)} mm, gap ${minGap.toFixed(3)} OK`);

// --- Пересечение дорожек чинится обходом вокруг конца препятствия ---
const crossDoc: Doc = {
  name: 'cross', w: 40, h: 20,
  entities: [T('a', [[0, 5], [30, 5]]), T('b', [[15, 0], [15, 10]])],
};
assert.equal(trackClearance(crossDoc.entities, 0.4).length, 1, 'crossing detected');
const rc = repairClearance({ doc: crossDoc, x: 15, y: 5, rule: 0.4, layer: 'k2' });
assert.equal(rc.ok, true, rc.msg);
assert.equal(trackClearance(rc.doc!.entities, 0.4).length, 0, 'crossing gone, nothing new');
console.log(`DRC repair crossing: ok, +${rc.addedLen!.toFixed(2)} mm OK`);

// --- Честные отказы: плата не меняется ---
const shortDoc: Doc = { name: 's', w: 10, h: 10, entities: [T('s', [[5, 5], [5.2, 5]])] };
const f1 = repairClearance({ doc: shortDoc, x: 5.1, y: 5, rule: 0.4 });
assert.equal(f1.ok, false);
assert.equal(f1.doc, undefined, 'failed repair returns no doc');
const cleanDoc: Doc = { name: 'c', w: 10, h: 10, entities: [T('c', [[0, 5], [10, 5]])] };
const f2 = repairClearance({ doc: cleanDoc, x: 5, y: 5, rule: 0.4 });
assert.equal(f2.ok, false, 'nothing to fix — refuse');
assert.equal(f2.doc, undefined);
const f3 = repairClearance({ doc: cleanDoc, x: 5, y: 5, rule: NaN });
assert.equal(f3.ok, false, 'bad rule — refuse');
console.log('DRC repair refusals: short track, clean board, bad rule OK');
