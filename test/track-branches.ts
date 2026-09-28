import assert from 'node:assert/strict';
import { pickTrackNode, trackNodeTerminal, terminalPath } from '../src/pcb/manual-route';
import { moveTrackNode } from '../src/pcb/trackedit';
import { copperComponents } from '../src/pcb/netroute';
import { trackClearance } from '../src/pcb/track-clearance';
import { buildCncJob, DEFAULT_CNC_SETTINGS } from '../src/pcb/cnc';
import { expandComp } from '../src/pcb/expand';
import type { Entity, Track } from '../src/pcb/model';

const trunk: Track = { id: 'trunk', kind: 'track', layer: 'k2', w: .7,
  pts: [{ x: 10.13, y: 15.27 }, { x: 20.13, y: 15.27 }, { x: 30.13, y: 15.27 }] };
for (let node = 0; node < trunk.pts.length; node++) {
  const p = trunk.pts[node];
  const hit = pickTrackNode([trunk], { x: p.x + .05, y: p.y - .03 }, .1)!;
  assert.equal(hit.node, node, 'all vertices, not only endpoints');
  assert.equal(hit.entId, trunk.id);
  assert.deepEqual(hit.layers, ['k2']);
  assert.equal(hit.width, .7);
  assert.deepEqual({ x: hit.x, y: hit.y }, p, 'exact off-grid copper vertex');
}
assert.equal(pickTrackNode([trunk], { x: 15, y: 15.27 }, .1), null, 'not a segment projection');
assert.equal(pickTrackNode([trunk], trunk.pts[1], .1, { layer: 'k1' }), null, 'cannot end on other layer');
assert.equal(pickTrackNode([trunk], trunk.pts[1], .1, { hidden: new Set(['k2']) }), null);
const other: Track = { ...trunk, id: 'other', layer: 'k1', w: .3 };
assert.equal(pickTrackNode([trunk, other], trunk.pts[1], .1, { preferredLayer: 'k2' })?.entId, 'trunk');
assert.equal(pickTrackNode([trunk, other], trunk.pts[1], .1, { preferredLayer: 'k1' })?.entId, 'other');
const nested = expandComp({ id: 'component', kind: 'comp', name: 'embedded', lib: '', x: 4, y: 3, rot: 90,
  side: 'bottom', bl: [0, 0, 40, 40], ents: [trunk] });
const nestedTrack = nested.find((e): e is Track => e.kind === 'track')!;
const nestedHit = pickTrackNode(nested, nestedTrack.pts[1], .1)!;
assert.equal(nestedHit.entId, nestedTrack.id);
assert.deepEqual(nestedHit.layers, ['k1']);
assert.deepEqual({ x: nestedHit.x, y: nestedHit.y }, nestedTrack.pts[1]);

const start = trackNodeTerminal(trunk, 1);
for (const angle of ['free', '45', '90'] as const) {
  const end = { x: angle === '90' ? start.x : 24.63, y: 26.39 };
  const branch: Track = { id: 'branch', kind: 'track', layer: start.layers[0], w: start.width,
    pts: [{ x: start.x, y: start.y }, ...terminalPath(start, end, angle)] };
  const entities: Entity[] = [trunk, branch];
  const components = copperComponents(entities);
  assert.equal(components.get(trunk.id), components.get(branch.id), 'same electrical chain');
  assert.equal(trackClearance(entities, .2).length, 0, 'intentional junction is not a clearance error');
  assert.equal(buildCncJob({ name: 'Branch', w: 50, h: 40, entities }, DEFAULT_CNC_SETTINGS).bottomLoops, 1,
    'CAM treats branch and trunk as continuous copper');
  const reload: Entity[] = JSON.parse(JSON.stringify(entities));
  assert.equal(copperComponents(reload).get(trunk.id), copperComponents(reload).get(branch.id), 'connection survives reload');
}
const branch: Track = { id: 'branch', kind: 'track', layer: 'k2', w: .7,
  pts: [{ ...trunk.pts[1] }, { x: 20.13, y: 25.27 }] };
const nearby: Track = { ...branch, id: 'near', pts: [{ x: 20.14, y: 15.27 }, { x: 25, y: 25 }] };
const entities: Entity[] = JSON.parse(JSON.stringify([trunk, branch, other, nearby]));
const before = JSON.stringify(entities);
moveTrackNode(entities, 'branch', 0, { x: 22, y: 17 });
assert.deepEqual((entities[0] as Track).pts[1], { x: 22, y: 17 });
assert.deepEqual((entities[1] as Track).pts[0], { x: 22, y: 17 });
assert.deepEqual((entities[2] as Track).pts, other.pts, 'other copper layer unchanged');
assert.deepEqual((entities[3] as Track).pts, nearby.pts, 'nearby, noncoincident vertex unchanged');
assert.notEqual(JSON.stringify(entities), before);
assert.deepEqual(trunk.pts[1], { x: 20.13, y: 15.27 }, 'source snapshot not mutated');
console.log('TRACK BRANCHES OK: all vertices, exact snap, layers, width, components, DRC, CAM, persistence and shared node movement');
