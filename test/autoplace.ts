import assert from 'node:assert/strict';
import { autoPlace, placementBBox } from '../src/pcb/autoplace';
import { expandDoc } from '../src/pcb/expand';
import { entBBox, newBoard, type Comp, type Doc } from '../src/pcb/model';

const component = (id: string, x: number, y: number, w = 10, h = 10): Comp => ({
  id, kind: 'comp', name: id, lib: '', x, y, rot: 0, side: 'top', bl: [-w / 2, -h / 2, w / 2, h / 2],
  ents: [{ id: 'p', kind: 'pad', x: 0, y: 0, size: 2, drill: 0.8, shape: 'round' }],
});
const opts = { gap: 0.5, edge: 1, rotate: true };
function check(d: Doc, selected: string[] = [], o = opts) {
  const before = JSON.stringify(d);
  const r = autoPlace(d, selected, o);
  assert.equal(r.error, undefined);
  assert.equal(JSON.stringify(d), before, 'input is immutable');
  assert.deepEqual(r.entities.map(e => e.id), d.entities.map(e => e.id), 'IDs/order preserved');
  const moved = r.entities.filter((e): e is Comp => e.kind === 'comp' && (!selected.length || selected.includes(e.id)));
  for (const c of moved) {
    const a = placementBBox(c);
    assert(a[0] >= o.edge - 1e-6 && a[1] >= o.edge - 1e-6 && a[2] <= d.w - o.edge + 1e-6 && a[3] <= d.h - o.edge + 1e-6, 'inside board');
    for (const e of r.entities) {
      if (e.id === c.id || ('layer' in e && e.layer === 'outline')) continue;
      const b = e.kind === 'comp' ? placementBBox(e) : entBBox(e);
      assert(a[2] + o.gap <= b[0] + 1e-6 || b[2] + o.gap <= a[0] + 1e-6 || a[3] + o.gap <= b[1] + 1e-6 || b[3] + o.gap <= a[1] + 1e-6, `${c.id} overlaps ${e.id}`);
    }
  }
  return r;
}
{
  const d = newBoard(100, 80);
  d.entities = [component('a', 10, 10), component('b', 90, 10), component('c', 90, 70), component('d', 10, 70)];
  d.nets = [{ id: 'net', name: 'net', pads: ['a:0', 'b:0', 'c:0', 'd:0'] }];
  const r = check(d);
  assert(Math.abs(r.width - 20.5) < 0.03 && Math.abs(r.height - 20.5) < 0.03, 'four equal components form minimal square');
  const ends = new Set(expandDoc(r.entities).map(e => e.id));
  assert(d.nets[0].pads.every(id => ends.has(id)), 'net references survive');
  assert.deepEqual(autoPlace(d, [], opts), r, 'deterministic');
}
{
  const d = newBoard(70, 50);
  d.entities = [component('a', 10, 10, 7, 10), component('b', 50, 30, 9, 4), component('fixed', 30, 25, 15, 20),
    { id: 'hole', kind: 'hole', x: 12, y: 25, d: 6 },
    { id: 'trace', kind: 'track', layer: 'k2', w: 1, pts: [{ x: 45, y: 10 }, { x: 65, y: 10 }] }];
  const r = check(d, ['a', 'b']);
  for (let i = 2; i < d.entities.length; i++) assert.equal(r.entities[i], d.entities[i], 'fixed objects unchanged');
}
{
  const d = newBoard(12, 24);
  d.entities = [component('a', 20, 20, 18, 4), component('b', 40, 40, 18, 4)];
  assert(autoPlace(d, [], { ...opts, rotate: false }).error);
  const r = check(d);
  assert(r.entities.every(e => e.kind !== 'comp' || e.rot === 90), 'rotation allows fit');
}
{
  const d = newBoard(100, 80);
  const a = component('a', 10, 10), b = component('b', 70, 60);
  a.rot = 270; a.side = 'bottom'; a.bl = [-2, -1, 2, 1];
  a.ents!.push({ id: 'large-pad', kind: 'smd', layer: 'k1', x: 9, y: 0, w: 5, h: 4, rot: 0 });
  d.entities = [a, b];
  const r = check(d);
  assert.equal((r.entities[0] as Comp).side, 'bottom');
  assert(placementBBox(a)[3] - placementBBox(a)[1] > 10, 'embedded geometry expands stale bbox');
  const tooSmall = { ...d, w: 3, h: 3 };
  assert(autoPlace(tooSmall, [], opts).error);
  assert.equal(autoPlace(tooSmall, [], opts).entities, tooSmall.entities, 'failure never applies partial placement');
  assert(autoPlace(d, ['a'], opts).error);
  assert(autoPlace(d, ['unknown'], opts).error);
  assert(autoPlace(d, [], { ...opts, gap: NaN }).error);
  assert(autoPlace(d, [], { ...opts, edge: -1 }).error);
}
{
  const d = newBoard(100, 80);
  d.entities = [component('a', 10, 10), component('b', 70, 60),
    { id: 'connected', kind: 'track', layer: 'k2', w: 0.5, pts: [{ x: 10, y: 10 }, { x: 20, y: 10 }] }];
  const r = autoPlace(d, [], opts);
  assert(r.error?.includes('неподвижной медью'), 'must not detach routed components');
  assert.equal(r.entities, d.entities);
}
// Mixed sizes, rotations and opposite sides: verify every accepted layout, not only its area.
{
  let seed = 1337;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let t = 0; t < 12; t++) {
    const d = newBoard(100, 80);
    d.entities = Array.from({ length: 24 }, (_, i) => ({ ...component(`c${i}`, rand() * 100, rand() * 80, 3 + rand() * 12, 3 + rand() * 12), rot: i % 4 * 90, side: i % 2 ? 'top' as const : 'bottom' as const }));
    check(d);
  }
}
console.log('AUTOPLACE OK: compact square, obstacles, rotation, bounds, IDs, immutability and wired-board protection');
