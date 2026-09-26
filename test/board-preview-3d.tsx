import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import * as THREE from 'three';
import { componentPackage, createComponentModel } from '../src/ui/component-model-3d';
import { EXAMPLES, FAMILY_HELP, generate } from '../src/pcb/gen';
import { compTF, libElsToEnts } from '../src/pcb/expand';
import type { Comp, Doc } from '../src/pcb/model';
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

const html = renderToString(createElement(BoardPreview3D, { doc }));
for (const text of ['Загрузка 3D-платы', 'aria-busy="true"', 'Вписать 3D', 'Каркас']) assert(html.includes(text));
console.log('3D PREVIEW OK: texture aspect, transformed components, drill marks, backside, disposal, SSR, all generated package models and textures');
