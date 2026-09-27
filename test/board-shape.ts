import assert from 'node:assert/strict';
import * as THREE from 'three';
import { boardShape, insideBoard } from '../src/pcb/board-shape';
import { cloneDoc, newBoard, translateEnt, type Doc, type Entity, type Pt } from '../src/pcb/model';
import { BOARD_GROUP, collectBoardHoles, createBoardGeometry, holeSegments } from '../src/ui/board-geometry-3d';
import { buildExportRoot } from '../src/ui/board-export-3d';
import { docToLay6, lay6ToDoc } from '../src/pcb/lay6';

const polygon = (pts: Pt[]): Entity[] => pts.map((a, i) => {
  const b = pts[(i + 1) % pts.length];
  return { id: `edge${i}`, kind: 'line', layer: 'outline', x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: 0.2 };
});
const rect = (x: number, y: number, w: number, h: number): Entity => ({ id: `${x},${y}`, kind: 'rect', layer: 'outline', x, y, w, h, th: .2, filled: false });
const base = newBoard(30, 20);
assert.deepEqual(boardShape(base).bounds, [0, 0, 30, 20]);
const resized = cloneDoc(base);
assert(resized.entities[0].kind === 'rect');
resized.entities[0].w = 12;
translateEnt(resized.entities[0], -8, 3);
assert.deepEqual(boardShape(resized).bounds, [-8, 3, 4, 23], 'entity, not doc.w/doc.h, controls shape');
assert.deepEqual(boardShape(base).bounds, [0, 0, 30, 20], 'undo snapshot preserves old shape');
const l: Doc = { ...base, entities: polygon([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 8 }, { x: 8, y: 8 }, { x: 8, y: 20 }, { x: 0, y: 20 }]) };
// Reverse both the drawing order and some segments.
l.entities.reverse();
for (let i = 0; i < l.entities.length; i += 2) {
  const e = l.entities[i];
  if (e.kind === 'line') [e.x1, e.y1, e.x2, e.y2] = [e.x2, e.y2, e.x1, e.y1];
}
const saved = JSON.stringify(l);
const shape = boardShape(l);
assert(!shape.fallback && shape.openChains === 0);
assert(insideBoard(shape, { x: 4, y: 12 }, 1));
assert(!insideBoard(shape, { x: 12, y: 12 }), 'concave missing corner is not substrate');
assert(!insideBoard(shape, { x: 7.8, y: 12 }, .3), 'edge clearance uses notch');
assert.equal(JSON.stringify(l), saved, 'shape calculation never edits document');
assert.deepEqual(boardShape(JSON.parse(saved)), shape, 'project reload');
const imported = lay6ToDoc(docToLay6(l, l.entities)).doc;
const importedShape = boardShape(imported);
const [dx, dy, maxX, maxY] = importedShape.bounds;
assert.deepEqual([maxX - dx, maxY - dy], [20, 20], 'Sprint outline keeps size (import recenters artwork)');
assert(!insideBoard(importedShape, { x: dx + 12, y: dy + 12 }));
const open = { ...l, entities: l.entities.slice(1) };
assert(boardShape(open).fallback && boardShape(open).openChains === 1, 'open chain is not silently closed');
assert.deepEqual(boardShape({ ...base, entities: [] }).bounds, [0, 0, 30, 20], 'legacy empty outline fallback');
const partial = { ...base, entities: [...base.entities, ...open.entities] };
assert(!boardShape(partial).fallback && boardShape(partial).openChains === 1, 'finished outline survives unfinished drawing');
const fork = { ...l, entities: [...l.entities, { id: 'branch', kind: 'line', layer: 'outline', x1: 0, y1: 0, x2: 2, y2: 2, w: .2 } as Entity] };
assert(boardShape(fork).fallback, 'ambiguous branch is rejected');
const nested = { ...base, entities: [rect(0, 0, 30, 20), rect(5, 5, 10, 10), rect(8, 8, 2, 2)] };
assert.equal(boardShape(nested).regions.length, 2);
const nestedReload = boardShape(lay6ToDoc(docToLay6(nested, nested.entities)).doc);
assert.equal(nestedReload.regions.length, 2, 'Sprint export retains outer frame when there are cutouts');
assert.equal(nestedReload.loops.length, 3);
assert(!insideBoard(boardShape(nested), { x: 6, y: 6 }));
assert(insideBoard(boardShape(nested), { x: 9, y: 9 }), 'island inside cutout');
const round: Doc = { ...base, entities: [{ id: 'circle', kind: 'circle', layer: 'outline', x: -5, y: 20, r: 10, w: 3 }] };
assert.deepEqual(boardShape(round).bounds, [-15, 10, 5, 30], 'stroke width is not board size');
const separate = { ...base, entities: [rect(-10, -10, 5, 5), rect(10, 10, 5, 5)] };
assert.equal(boardShape(separate).regions.length, 2);

function checkMesh(doc: Doc, expectedArea: number, tolerance = .002) {
  const s = boardShape(doc);
  const { geometry, holes } = createBoardGeometry(doc.w, doc.h, 1.6, collectBoardHoles(doc), s);
  const pos = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
  const ix = geometry.getIndex()!;
  let area = 0;
  const edges = new Map<string, number>();
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  for (let i = 0; i < pos.count; i++) {
    assert(Number.isFinite(pos.getX(i)) && Number.isFinite(pos.getY(i)));
    // Wall UVs deliberately encode arc length, unlike cap UVs.
  }
  for (const group of geometry.groups) for (let i = group.start; i < group.start + group.count; i += 3) {
    const ids = [ix.getX(i), ix.getX(i + 1), ix.getX(i + 2)];
    const [a, b, c] = ids.map(id => new THREE.Vector3().fromBufferAttribute(pos, id));
    const face = b.clone().sub(a).cross(c.clone().sub(a));
    assert(face.dot(new THREE.Vector3().fromBufferAttribute(normal, ids[0])) > 0, 'winding matches edge/cutout normal');
    if (group.materialIndex === BOARD_GROUP.top) {
      area += face.length() / 2;
      const center = a.clone().add(b).add(c).divideScalar(3);
      assert(insideBoard(s, center), 'no face across a cutout or concave corner');
      for (const id of ids) assert(uv.getX(id) >= -1e-6 && uv.getX(id) <= 1 + 1e-6 && uv.getY(id) >= -1e-6 && uv.getY(id) <= 1 + 1e-6, 'cap UVs use outline bounds');
    }
    for (let j = 0; j < 3; j++) {
      const k = [key(ids[j]), key(ids[(j + 1) % 3])].sort().join('|');
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const [edge, count] of edges) assert.equal(count, 2, `watertight: ${edge}`);
  const drilledArea = holes.reduce((sum, h) => {
    const n = holeSegments(h.r), r = h.r / Math.cos(Math.PI / n);
    return sum + n * r * r * Math.sin(2 * Math.PI / n) / 2;
  }, 0);
  assert(Math.abs(area - expectedArea + drilledArea) < tolerance, `top area ${area}, expected ${expectedArea - drilledArea}`);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  assert(Math.abs(box.min.x - s.bounds[0]) < 1e-5 && Math.abs(box.max.y - s.bounds[3]) < 1e-5);
  const board = new THREE.Mesh(geometry);
  const root = buildExportRoot(doc, board, null, 1);
  const center = new THREE.Box3().setFromObject(root).getCenter(new THREE.Vector3());
  assert(center.length() < 1e-5, 'export centered on actual board, including translated outline');
  geometry.dispose();
}
checkMesh(resized, 12 * 20);
checkMesh(l, 256);
checkMesh(nested, 504);
checkMesh(separate, 50);
checkMesh(round, Math.PI * 100, .3);
const drilled = { ...l, entities: [...l.entities,
  { id: 'yes', kind: 'hole', x: 4, y: 12, d: 1 } as Entity,
  { id: 'notch', kind: 'hole', x: 12, y: 12, d: 1 } as Entity,
  { id: 'edge', kind: 'hole', x: 7.8, y: 12, d: 1 } as Entity,
] };
assert.equal(collectBoardHoles(drilled).length, 1, 'drills respect the physical edge');
checkMesh(drilled, 256);
const cutoutDrills = { ...nested, entities: [...nested.entities,
  { id: 'cutout', kind: 'hole', x: 6, y: 6, d: .5 } as Entity,
  { id: 'island', kind: 'pad', x: 9, y: 9, drill: .5, size: 1, shape: 'round' } as Entity,
] };
assert.equal(collectBoardHoles(cutoutDrills).length, 1);
checkMesh(cutoutDrills, 504);
console.log('BOARD SHAPE OK: edited outlines, concave chains, circles, cutouts, islands, open chains, reload, watertight mesh, UVs, drills and export');
