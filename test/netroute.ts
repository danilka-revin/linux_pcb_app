import assert from 'node:assert/strict';
import * as M from '../src/pcb/model';
import { expandDoc } from '../src/pcb/expand';
import { copperShapes, shapeDist, type RouteOpts } from '../src/pcb/autoroute';
import { copperComponents, netConflicts, netMissing, routeNets } from '../src/pcb/netroute';

const O: RouteOpts = { trackW: 0.4, clearance: 0.3, holeClear: 0.6, viaSize: 1.4, viaDrill: 0.6, step: 0.5, viaCost: 5, topMul: 1.5, allowTop: true, angle: '45' };
const pad = (id: string, x: number, y: number): M.Pad => ({ id, kind: 'pad', x, y, size: 2, drill: 0.8, shape: 'round' });
const net = (id: string, pads: string[]): M.Net => ({ id, name: id, pads });
const applied = (d: M.Doc, ents: M.Entity[]) => ({ ...d, entities: [...d.entities, ...ents] });
function check(d: M.Doc, ents: M.Entity[]) {
  const comp = copperComponents([...d.entities, ...ents]);
  assert.deepEqual(netConflicts(d.nets!, comp), []);
  for (const n of d.nets!) assert.equal(netMissing(n, comp), 0, `${n.name}: disconnected`);
  // New upper tracks must stay away from EVERY own THT pad, not only pair endpoints.
  for (const e of ents) if (e.kind === 'track' && e.layer === 'k1') {
    const sh = copperShapes(e)[0];
    for (const p of expandDoc(d.entities)) if (p.kind === 'pad' && p.drill > 0) assert(shapeDist(sh, p.x, p.y) >= p.size / 2 + O.holeClear - 1e-3, 'upper track touches THT');
  }
}

// Multiple independent groups, branch at a shared pad, zero transitions, persistence and rerun.
{
  const d = M.newBoard(50, 40);
  d.entities.push(pad('a', 7, 8), pad('b', 25, 8), pad('c', 38, 16), pad('d', 8, 30), pad('e', 25, 30), pad('f', 40, 30));
  d.nets = [net('signal', ['a', 'b', 'c']), net('ground', ['d', 'e', 'f'])];
  const copy = M.cloneDoc(d);
  assert.deepEqual(copy.nets, d.nets);
  const before = JSON.stringify(d);
  const r = routeNets(copy, O);
  assert.deepEqual(r.errors, []);
  assert.equal(r.missing, 0);
  assert.equal(r.vias, 0);
  assert(r.ents.length > 0);
  assert.equal(JSON.stringify(d), before, 'input mutated');
  check(d, r.ents);
  const again = routeNets(applied(d, r.ents), O);
  assert.equal(again.missing, 0);
  assert.equal(again.ents.length, 0, 'rerun duplicates routes');
  console.log('NETS: two groups of three; all connected on K2; rerun is idempotent');
}

// Barrier on bottom: no illegal partial successes; two vias suffice for the whole group.
{
  const d = M.newBoard(50, 40);
  d.entities.push(pad('a', 8, 12), pad('b', 40, 12), pad('c', 40, 28),
    { id: 'wall', kind: 'track', w: 1, layer: 'k2', pts: [{ x: 25, y: 0 }, { x: 25, y: 40 }] });
  d.nets = [net('bus', ['a', 'b', 'c'])];
  const lower = routeNets(d, { ...O, allowTop: false });
  assert(lower.missing > 0);
  assert.equal(lower.vias, 0);
  assert(lower.unresolved.some((n) => n.name === 'bus'));
  const r = routeNets(d, O);
  assert.equal(r.missing, 0);
  assert.equal(r.vias, 2, 'expected one top bridge, not a bridge per pair');
  check(d, r.ents);
  console.log('NETS: blocked on K2; one bridge/two vias joins three pads');
}

// Explicit shorts through existing copper must abort, not absorb another net as own copper.
{
  const d = M.newBoard(40, 30);
  d.entities.push(pad('a', 5, 8), pad('b', 35, 8), pad('c', 5, 22), pad('d', 35, 22),
    { id: 'short', kind: 'track', w: 0.4, layer: 'k2', pts: [{ x: 5, y: 8 }, { x: 5, y: 22 }] });
  d.nets = [net('one', ['a', 'b']), net('two', ['c', 'd'])];
  const r = routeNets(d, O);
  assert(r.errors.some((e) => e.includes('замкнуты')));
  assert.equal(r.ents.length, 0);
  d.entities = d.entities.filter((e) => e.id !== 'short');
  d.nets[1].pads.push('a');
  assert(routeNets(d, O).errors.length > 0, 'duplicate membership');
  d.nets = [net('lost', ['a', 'deleted'])];
  assert(routeNets(d, O).errors.some((e) => e.includes('отсутствует')));
  d.nets = [net('one', ['a'])];
  assert(routeNets(d, O).errors.some((e) => e.includes('минимум две')));
  d.nets = [];
  assert(routeNets(d, O).errors.length > 0);
  console.log('NETS: pre-existing shorts, duplicate membership, stale references, invalid groups rejected');
}

// Stable component-pad IDs, including rotation and a native JSON save/open roundtrip.
{
  const d = M.newBoard(60, 40);
  d.entities.push({ id: 'comp', kind: 'comp', x: 20, y: 20, rot: 90, side: 'top', lib: '', name: 'custom', ents: [pad('local1', -5, 0), pad('local2', 5, 0)] }, pad('a', 45, 20));
  d.nets = [net('pins', ['comp:0', 'comp:1', 'a'])];
  const loaded = JSON.parse(JSON.stringify(d));
  const r = routeNets(loaded, O);
  assert.deepEqual(r.errors, []);
  assert.equal(r.missing, 0);
  check(loaded, r.ents);
  // Moving a component keeps the net membership attached to the same pins.
  (d.entities.find((e) => e.id === 'comp') as M.Comp).rot = 180;
  assert.equal(routeNets(d, O).missing, 0);
  console.log('NETS: component pin IDs survive rotation and JSON roundtrip');
}

// Crossing nets: independent groups, alternatives explored, all connected without shorts.
{
  const d = M.newBoard(40, 40);
  d.entities.push(pad('a', 2, 20), pad('b', 38, 20), pad('c', 20, 2), pad('d', 20, 38));
  d.nets = [net('horizontal', ['a', 'b']), net('vertical', ['c', 'd'])];
  const r = routeNets(d, { ...O, holeClear: 1 });
  assert.equal(r.missing, 0);
  assert.equal(r.vias, 2);
  assert(r.attempts > 1, 'must compare alternative net orders');
  check(d, r.ents);
  console.log('NETS: crossing groups use two vias; multiple orders compared');
}
// Mixed through-hole/SMD endpoints: one via, correct entry side, obstacle clearances.
{
  const d = M.newBoard(50, 40);
  d.entities.push(pad('a', 6, 20), pad('b', 6, 30),
    { id: 'smd', kind: 'smd', x: 44, y: 20, w: 2, h: 2, rot: 0, layer: 'k1' },
    { id: 'hole', kind: 'hole', x: 25, y: 20, d: 5 });
  d.nets = [net('mixed', ['a', 'b', 'smd'])];
  const r = routeNets(d, O);
  assert.equal(r.missing, 0);
  assert.equal(r.vias, 1);
  check(d, r.ents);
  for (const e of r.ents) {
    const sh = copperShapes(e)[0];
    assert(shapeDist(sh, 25, 20) >= 2.5 + O.holeClear! - 1e-3, 'hole clearance violated');
  }
  console.log('NETS: mixed SMD/THT, one via, mounting-hole clearance retained');
}
console.log('NETROUTE OK');

// Imported SMDs remain terminals inside mirrored/rotated catalog components.
{
  const { parseKicadFootprint } = await import('../src/pcb/kicad-footprint');
  const { libElsToEnts } = await import('../src/pcb/expand');
  const fp = parseKicadFootprint(`(footprint "catalog-smd"
    (pad "1" smd rect (at 0 0) (size 2 1) (layers "F.Cu"))
    (pad "2" connect rect (at 6 0) (size 2 1) (layers "F.Cu")))`);
  for (const side of ['top', 'bottom'] as const) for (const rot of [0, 90, 180, 270]) {
    const d = M.newBoard(30, 30);
    d.entities.push({ id: 'catalog', kind: 'comp', lib: '', name: fp.name, x: 15, y: 15, side, rot, ents: libElsToEnts(fp.els), bl: fp.bbox });
    d.nets = [net('smd', ['catalog:0', 'catalog:1'])];
    const r = routeNets(d, O);
    assert.deepEqual(r.errors, []);
    assert.equal(r.missing, 0, `${side}/${rot}: SMD group disconnected`);
    assert.equal(r.vias, 0, 'same-layer SMD must not require vias');
    assert(r.ents.every(e => e.kind === 'track' && e.layer === (side === 'top' ? 'k1' : 'k2')));
    check(d, r.ents);
    assert.equal(routeNets(applied(d, r.ents), O).ents.length, 0);
  }
  console.log('NETS: catalog SMD/connect terminals, both sides/all rotations, no vias, rerun OK');
}
