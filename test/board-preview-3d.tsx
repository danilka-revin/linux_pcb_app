import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import * as THREE from 'three';
import { componentPackage, createComponentModel } from '../src/ui/component-model-3d';
import { EXAMPLES, FAMILY_HELP, generate } from '../src/pcb/gen';
import { compTF, libElsToEnts } from '../src/pcb/expand';
import type { Comp, Doc } from '../src/pcb/model';
import { BOARD_GROUP, collectBoardHoles, createBoardGeometry, holeSegments } from '../src/ui/board-geometry-3d';
import { BoardPreview3D, componentBody, createBoardTexture, disposePreviewScene } from '../src/ui/board-preview-3d';

const comp: Comp = { id: 'comp', kind: 'comp', lib: '', name: 'U1', x: 10, y: 20, rot: 90, side: 'top', bl: [0, 0, 4, 6], ents: [
  { id: 'pin', kind: 'pad', x: 2, y: 3, size: 2, drill: 0.6, shape: 'round' },
] };
const top = componentBody(comp, 1.6), bottom = componentBody({ ...comp, side: 'bottom' }, 1.6);
assert.deepEqual([top.w, top.h, top.x, top.y], [4, 6, 7, 22]);
assert.deepEqual([bottom.x, bottom.y], [7, 18]);
assert(Math.abs(top.z - top.depth / 2 - 1.6 / 2) < 1e-9, 'top body sits on board, not inside it');
assert(Math.abs(bottom.z + bottom.depth / 2 + 1.6 / 2) < 1e-9, 'bottom body sits on underside');

const doc: Doc = { name: '3D test', w: 80, h: 40, entities: [comp] };
const before = JSON.stringify(doc);
const calls: { name: string; args: unknown[] }[] = [];
const ctx = new Proxy({} as Record<string, unknown>, {
  get(target, name: string) { return name in target ? target[name] : (...args: unknown[]) => calls.push({ name, args }); },
  set(target, name: string, value) { target[name] = value; return true; },
});
const previousDocument = globalThis.document;
try {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } as unknown as Document;
  const texture = createBoardTexture(doc, 'green', 'top');
  assert.equal(texture.image.width, 2048);
  assert.equal(texture.image.height, 1024, 'rectangular board retains aspect ratio');
  assert.equal(texture.colorSpace, THREE.SRGBColorSpace);
  assert(calls.some(c => c.name === 'setTransform' && c.args[0] === 25.6 && c.args[3] === 25.6));
  assert(calls.some(c => c.name === 'arc' && c.args[0] === 7 && c.args[1] === 18 && c.args[2] === 1), 'rotated component pad at world coordinates');
  assert(calls.some(c => c.name === 'arc' && c.args[2] === 0.3), 'pad drill is present in texture');
  texture.dispose();
  calls.length = 0;
  const back = createBoardTexture(doc, 'green', 'bottom');
  assert(calls.some(c => c.name === 'scale' && c.args[0] === -1), 'back-face UV uses mirrored texture');
  back.dispose();
  // Every generator family, both board sides, non-zero rotation and local offsets.
  for (const query of new Set([...EXAMPLES.map(e => e.query), ...FAMILY_HELP.map(e => e.example)])) {
    const generated = generate(query);
    assert(generated.ok && generated.els && generated.bl, query);
    for (const side of ['top', 'bottom'] as const) {
      const component: Comp = { ...comp, name: generated.title!, ents: libElsToEnts(generated.els), bl: generated.bl, side, rot: 37 };
      const snapshot = JSON.stringify(component);
      const model = createComponentModel(component, 1.6);
      assert.equal(JSON.stringify(component), snapshot, 'model generation must not mutate the footprint');
      model.updateMatrixWorld(true);
      const point = model.localToWorld(new THREE.Vector3(2, 3, 1));
      const expected = compTF(component)({ x: 2, y: 3 });
      assert(Math.abs(point.x - expected.x) < 1e-8 && Math.abs(point.y - expected.y) < 1e-8, query);
      assert(Math.abs(point.z - (side === 'top' ? 1.8 : -1.8)) < 1e-8, 'body points away from board');
      let textured = 0;
      model.traverse(o => {
        if (!(o instanceof THREE.Mesh)) return;
        const positions = o.geometry.getAttribute('position');
        for (const value of positions.array) assert(Number.isFinite(value), query);
        const mat = o.material as THREE.MeshStandardMaterial;
        if (mat.map) { textured++; assert.equal(mat.map.colorSpace, THREE.SRGBColorSpace); }
      });
      if (model.userData.package !== 'footprint') assert(textured > 0, `${query}: missing textured body`);
      const resources = new THREE.Scene(); resources.add(model); disposePreviewScene(resources);
    }
  }
  for (const [name, kind] of [
    ['DIP-16', 'ic'], ['Резистор 10 мм', 'resistor'], ['Светодиод 5 мм', 'led'],
    ['Электролит Ø10', 'electrolytic'], ['TO-корпус · отверстие под винт', 'transistor'],
    ['Клеммник 3×5', 'terminal'], ['DIP-переключатель 8', 'switch'], ['Отверстие Ø3', 'footprint'],
    ['Arduino Nano', 'module'], ['Кварц HC-49S', 'crystal'], ['Гнездо 2×5', 'socket'],
    ['R17', 'resistor'], ['unknown-part', 'generic'],
  ]) assert.equal(componentPackage({ ...comp, name }), kind, name);
  const fallback = createComponentModel({ ...comp, name: 'unknown-part', ents: undefined }, 1.6);
  assert(fallback.children.length > 0, 'imported unknown component still has a textured model');
  const fallbackScene = new THREE.Scene(); fallbackScene.add(fallback); disposePreviewScene(fallbackScene);
  globalThis.document = { createElement: () => ({ getContext: () => null }) } as unknown as Document;
  assert.throws(() => createBoardTexture(doc, 'green', 'top'), /текстуру/);
  assert.throws(() => createComponentModel(comp, 1.6), /текстуру корпуса/);
} finally {
  if (previousDocument) globalThis.document = previousDocument;
  else Reflect.deleteProperty(globalThis, 'document');
}
assert.equal(JSON.stringify(doc), before);

// Shared materials/textures must be disposed once, including on partial init failure.
const scene = new THREE.Scene();
const geometry = new THREE.BoxGeometry(80, 40, 1.6);
const texture = new THREE.Texture();
const material = new THREE.MeshStandardMaterial({ map: texture });
const counts = { geometry: 0, material: 0, texture: 0 };
geometry.addEventListener('dispose', () => counts.geometry++);
material.addEventListener('dispose', () => counts.material++);
texture.addEventListener('dispose', () => counts.texture++);
scene.add(new THREE.Mesh(geometry, [material, material]));
scene.add(new THREE.Mesh(geometry, material));
disposePreviewScene(scene);
assert.deepEqual(counts, { geometry: 1, material: 1, texture: 1 });
assert.equal(scene.children.length, 0);
disposePreviewScene(scene);
assert.deepEqual(counts, { geometry: 1, material: 1, texture: 1 });

// Real through-holes: watertight mesh, no cap over drill, outward/inward normals, fast on big boards.
function checkBoard(w: number, h: number, t: number, holes: ReturnType<typeof collectBoardHoles>, label: string) {
  const started = performance.now();
  const { geometry, holes: cut } = createBoardGeometry(w, h, t, holes);
  const elapsed = performance.now() - started;
  const pos = geometry.getAttribute('position'), nrm = geometry.getAttribute('normal');
  const index = geometry.getIndex()!;
  const key = (i: number) => `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
  const edges = new Map<string, number>();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  let topArea = 0;
  const groupOf = (i: number) => geometry.groups.find(g => i >= g.start && i < g.start + g.count)!.materialIndex;
  for (let i = 0; i < index.count; i += 3) {
    const [i0, i1, i2] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (face.lengthSq() < 1e-18) continue;
    n.fromBufferAttribute(nrm, i0);
    assert(face.dot(n) > 0, `${label}: winding matches normal`);
    if (groupOf(i) === BOARD_GROUP.top) {
      topArea += face.length() / 2;
      assert(Math.abs(a.z - t / 2) < 1e-6 && n.z === 1, `${label}: top cap is flat`);
    }
    for (const [p, q] of [[i0, i1], [i1, i2], [i2, i0]]) {
      const [kp, kq] = [key(p), key(q)];
      const e = kp < kq ? `${kp}|${kq}` : `${kq}|${kp}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  for (const [e, count] of edges) assert.equal(count, 2, `${label}: open or T-junction edge ${e}`);
  const holeArea = cut.reduce((s, hole) => { const k = holeSegments(hole.r); const R = hole.r / Math.cos(Math.PI / k); return s + k * R * R * Math.sin(2 * Math.PI / k) / 2; }, 0);
  assert(Math.abs(topArea - (w * h - holeArea)) < 1e-3 * w * h / 1000 + 1e-6, `${label}: top area ${topArea} excludes drills`);
  geometry.dispose();
  return { cut, elapsed };
}
{
  const drilled: Doc = { name: 'holes', w: 30, h: 30, entities: [
    { id: 'p', kind: 'pad', x: 10, y: 10, size: 2, drill: 1, shape: 'round' },
    { id: 'v', kind: 'via', x: 10, y: 10, size: 0.8, drill: 0.4 },               // concentric with the pad
    { id: 'n', kind: 'pad', x: 20, y: 10, size: 2, drill: 0.8, shape: 'square', noPlate: true },
    { id: 'm', kind: 'hole', x: 5, y: 5, d: 3 },
    { id: 'edge', kind: 'hole', x: 0.5, y: 10, d: 3 },                           // crosses board edge
    { id: 'smd', kind: 'smd', x: 15, y: 15, w: 1, h: 1, rot: 0, layer: 'k1' },
    comp,
  ] };
  const holes = collectBoardHoles(drilled);
  assert.equal(holes.length, 4, 'pad, unplated pad, mounting hole and component pad; duplicate/edge skipped');
  assert.deepEqual(holes.find(h => h.x === 10 && h.y === 10), { x: 10, y: 10, r: 0.5, plated: true });
  assert.equal(holes.find(h => h.x === 20)!.plated, false, 'noPlate pad has bare wall');
  assert.equal(holes.find(h => h.x === 5)!.plated, false, 'mounting hole has bare wall');
  assert(holes.some(h => Math.abs(h.x - 7) < 1e-9 && Math.abs(h.y - 22) < 1e-9 && h.r === 0.3), 'component pad drilled at world position');
  const { cut } = checkBoard(drilled.w, drilled.h, 1.6, holes, 'basic');
  assert.equal(cut.length, 4);
  const { geometry } = createBoardGeometry(30, 30, 1.6, holes);
  assert.deepEqual(geometry.groups.map(g => g.materialIndex), [0, 1, 2, 3]);
  assert(geometry.groups[BOARD_GROUP.plated].count > 0, 'plated walls exist');
  geometry.computeBoundingBox();
  assert(geometry.boundingBox!.min.distanceTo(new THREE.Vector3(0, 0, -0.8)) < 1e-6, 'board corner at origin');
  assert(geometry.boundingBox!.max.distanceTo(new THREE.Vector3(30, 30, 0.8)) < 1e-6, 'board size and thickness');
  geometry.dispose();
  checkBoard(10, 10, 1, [], 'no holes');
  // 60×60 DIP-like grid (3600 holes): must use the partition, not one quadratic earcut.
  const grid: Doc = { name: 'grid', w: 160, h: 160, entities: [] };
  for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) grid.entities.push({ id: `g${i}_${j}`, kind: 'pad', x: 5 + i * 2.54, y: 5 + j * 2.54, size: 1.6, drill: 0.8, shape: 'round' });
  const big = checkBoard(160, 160, 1.6, collectBoardHoles(grid), 'grid');
  assert.equal(big.cut.length, 3600);
  assert(big.elapsed < 3000, `grid triangulation took ${big.elapsed.toFixed(0)} ms`);
  // Staggered holes whose projections overlap on both axes still triangulate.
  const stagger: Doc = { name: 'stagger', w: 40, h: 40, entities: [] };
  for (let i = 0; i < 400; i++) stagger.entities.push({ id: `s${i}`, kind: 'hole', x: 2 + (i % 20) * 1.8 + (Math.floor(i / 20) % 2) * 0.9, y: 2 + Math.floor(i / 20) * 1.8, d: 1.2 });
  checkBoard(40, 40, 1.6, collectBoardHoles(stagger), 'stagger');
}

const html = renderToString(createElement(BoardPreview3D, { doc }));
for (const text of ['Загрузка 3D-платы', 'aria-busy="true"', 'Вписать 3D', 'Каркас']) assert(html.includes(text));
console.log('3D PREVIEW OK: texture aspect, transformed components, drill marks, real through-holes, backside, disposal, SSR, all generated package models and textures');
