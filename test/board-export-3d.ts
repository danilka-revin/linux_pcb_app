// Экспорт 3D-модели: GLB и OBJ+MTL+PNG, с текстурами платы и корпусов.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { Comp, Doc } from '../src/pcb/model';
import { generate } from '../src/pcb/gen';
import { libElsToEnts } from '../src/pcb/expand';
import { collectBoardHoles, createBoardGeometry } from '../src/ui/board-geometry-3d';
import { createBoardTexture } from '../src/ui/board-preview-3d';
import { createComponentModel } from '../src/ui/component-model-3d';
import { buildExportRoot, exportBaseName, exportGLB, exportOBJFiles, exportOBJZip } from '../src/ui/board-export-3d';

// --- Минимальная браузерная среда: canvas с toBlob и FileReader для GLTFExporter.
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let canvasId = 0;
const ctx = new Proxy({} as Record<string, unknown>, {
  get(target, name: string) { return name in target ? target[name] : () => undefined; },
  set(target, name: string, value) { target[name] = value; return true; },
});
class FakeCanvas {
  width = 0; height = 0; id = ++canvasId;
  getContext() { return ctx; }
  toBlob(cb: (b: Blob | null) => void, type?: string) {
    assert.equal(type, 'image/png');
    cb(new Blob([new Uint8Array([...PNG, this.id, this.width & 255, this.height & 255])], { type: 'image/png' }));
  }
}
class FakeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) { void blob.arrayBuffer().then(b => { this.result = b; this.onloadend?.(); }); }
  readAsDataURL(blob: Blob) { void blob.arrayBuffer().then(b => { this.result = 'data:application/octet-stream;base64,' + Buffer.from(b).toString('base64'); this.onloadend?.(); }); }
}
const g = globalThis as Record<string, unknown>;
g.HTMLCanvasElement = FakeCanvas;
g.FileReader = FakeFileReader;
g.document = { createElement: () => new FakeCanvas() };

assert.equal(exportBaseName('Плата: v1/2?'), 'Плата_ v1_2_');
assert.equal(exportBaseName('  '), 'board');
assert.equal(exportBaseName('..hidden'), 'hidden');

// --- Сцена как в BoardPreview3D: плата с отверстиями, текстуры, детали.
const dip = generate('DIP-8');
assert(dip.ok && dip.els && dip.bl);
const res = generate('Резистор 10 мм');
assert(res.ok && res.els && res.bl);
const comps: Comp[] = [
  { id: 'u1', kind: 'comp', lib: '', name: dip.title!, x: 20, y: 15, rot: 0, side: 'top', bl: dip.bl, ents: libElsToEnts(dip.els) },
  { id: 'r1', kind: 'comp', lib: '', name: res.title!, x: 40, y: 10, rot: 90, side: 'bottom', bl: res.bl, ents: libElsToEnts(res.els) },
];
const doc: Doc = { name: 'Экспорт/тест', w: 60, h: 30, entities: [...comps, { id: 'm', kind: 'hole', x: 5, y: 5, d: 3 }] };
const t = 1.6;
const scene = new THREE.Scene();
const topMat = new THREE.MeshStandardMaterial({ name: 'pcb_top' });
const bottomMat = new THREE.MeshStandardMaterial({ name: 'pcb_bottom' });
const edgeMat = new THREE.MeshStandardMaterial({ name: 'pcb_edge', color: '#d8c38c' });
const platedMat = new THREE.MeshStandardMaterial({ name: 'pcb_plating', color: '#c9a35a', metalness: .8, roughness: .35 });
const { geometry, holes } = createBoardGeometry(doc.w, doc.h, t, collectBoardHoles(doc));
assert(holes.length >= 9, 'DIP pins, resistor leads and mounting hole are drilled');
const board = new THREE.Mesh(geometry, [topMat, bottomMat, edgeMat, platedMat]);
board.name = 'board';
scene.add(board);
topMat.map = createBoardTexture(doc, 'green', 'top');
bottomMat.map = createBoardTexture(doc, 'green', 'bottom');
const components = new THREE.Group();
components.name = 'components';
for (const c of comps) components.add(createComponentModel(c, t));
scene.add(components);
const childCount = components.children.length;

// --- Корень экспорта: центр в нуле, Y вверх, общие ресурсы, сцена не тронута.
const root = buildExportRoot(doc, board, components, 1);
assert.equal(board.parent, scene, 'original board stays in the preview scene');
assert.equal(components.children.length, childCount);
const box = new THREE.Box3().setFromObject(root);
assert(Math.abs(box.min.x + 30) < 1e-4 && Math.abs(box.max.x - 30) < 1e-4, 'board width centred on X');
assert(Math.abs(box.min.z + 15) < 1e-4 && Math.abs(box.max.z - 15) < 1e-4, 'board depth centred on Z');
assert(box.max.y > t / 2 + 1 && box.min.y < -t / 2, 'top parts above, bottom part below: Y is up');
let sharedGeometry = false;
root.traverse(o => { if (o instanceof THREE.Mesh && o.geometry === geometry) sharedGeometry = true; });
assert(sharedGeometry, 'export clones nodes but shares geometry');
const onlyBoard = buildExportRoot(doc, board, Object.assign(components.clone(), { visible: false }), 1);
assert.equal(onlyBoard.children[0].children.length, 1, 'hidden components are not exported');

// --- OBJ + MTL + PNG.
const files = await exportOBJFiles(root, 'board');
const names = files.map(f => f.name);
assert.deepEqual(names.slice(0, 2), ['board.obj', 'board.mtl']);
assert(names.includes('textures/pcb_top.png') && names.includes('textures/pcb_bottom.png'), 'board textures in archive');
assert(names.some(n => /^textures\/body_ic/.test(n)), 'component body texture in archive');
for (const f of files.slice(2)) assert.deepEqual([...(f.data as Uint8Array).slice(0, 8)], PNG, `${f.name} is PNG`);
const objText = files[0].data as string, mtlText = files[1].data as string;
const lines = objText.split('\n');
const vs = lines.filter(l => l.startsWith('v ')).map(l => l.split(' ').slice(1).map(Number));
const vtCount = lines.filter(l => l.startsWith('vt ')).length, vnCount = lines.filter(l => l.startsWith('vn ')).length;
const faces = lines.filter(l => l.startsWith('f '));
assert(faces.length > 1000, 'triangles exported');
for (const f of faces) for (const ref of f.split(' ').slice(1)) {
  const [v, vt, vn] = ref.split('/').map(Number);
  assert(v >= 1 && v <= vs.length && vt >= 1 && vt <= vtCount && vn >= 1 && vn <= vnCount, `bad face ${f}`);
}
const loose = box.clone().expandByScalar(1e-3);
for (const [x, y, z] of vs) assert(loose.containsPoint(new THREE.Vector3(x, y, z)), 'vertex within model bounds');
const used = new Set(lines.filter(l => l.startsWith('usemtl ')).map(l => l.slice(7)));
const defined = new Set(mtlText.split('\n').filter(l => l.startsWith('newmtl ')).map(l => l.slice(7)));
for (const m of used) assert(defined.has(m), `material ${m} defined in MTL`);
for (const m of ['pcb_top', 'pcb_bottom', 'pcb_edge', 'pcb_plating', 'metal']) assert(used.has(m), `uses ${m}`);
for (const map of mtlText.split('\n').filter(l => l.startsWith('map_Kd '))) assert(names.includes(map.slice(7)), `${map} packed`);
assert(/newmtl pcb_plating\n(?:.*\n)*?Pm 0\.8/.test(mtlText), 'PBR metalness kept');
// Проверим, что верх платы реально с текстурой верха и смотрит вверх (+Y).
const topStart = lines.indexOf('usemtl pcb_top');
const topFace = lines[topStart + 1].split(' ').slice(1).map(r => Number(r.split('/')[0]) - 1);
for (const i of topFace) assert(Math.abs(vs[i][1] - t / 2) < 1e-5, 'pcb_top at +Y surface');
const zip = new Uint8Array(await (await exportOBJZip(root, 'board')).arrayBuffer());
assert.deepEqual([...zip.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'OBJ archive is ZIP');

// --- GLB: один файл, PNG внутри, метры, Y вверх.
const glb = new Uint8Array(await (await exportGLB(buildExportRoot(doc, board, components, 0.001))).arrayBuffer());
const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
assert.equal(view.getUint32(0, true), 0x46546c67, 'glTF magic');
assert.equal(view.getUint32(4, true), 2);
assert.equal(view.getUint32(8, true), glb.byteLength);
const jsonLength = view.getUint32(12, true);
assert.equal(view.getUint32(16, true), 0x4e4f534a, 'JSON chunk');
const gltf = JSON.parse(new TextDecoder().decode(glb.slice(20, 20 + jsonLength)));
assert.equal(view.getUint32(20 + jsonLength + 4, true), 0x004e4942, 'BIN chunk');
assert(gltf.images.length >= 3 && gltf.images.every((i: { mimeType: string; bufferView: number }) => i.mimeType === 'image/png' && Number.isInteger(i.bufferView)), 'embedded PNG textures');
const mats = new Map<string, { pbrMetallicRoughness: { baseColorTexture?: { index: number } } }>(gltf.materials.map((m: { name: string }) => [m.name, m]));
assert(mats.get('pcb_top')?.pbrMetallicRoughness.baseColorTexture, 'board top textured');
assert(mats.get('pcb_bottom')?.pbrMetallicRoughness.baseColorTexture, 'board bottom textured');
assert(mats.has('pcb_plating'), 'plated walls material');
assert.equal(gltf.extensionsUsed?.includes('KHR_lights_punctual') ?? false, false, 'no preview lights exported');
assert.equal(gltf.scenes[0].name, 'Экспорт_тест', 'scene named after the board');
const rootNode = gltf.nodes[gltf.scenes[0].nodes[0]];
const m = rootNode.matrix as number[];
assert(Math.abs(m[0] - 0.001) < 1e-9, 'millimetres → metres');
assert(Math.abs(m[9] - 0.001) < 1e-9 && Math.abs(m[6] + 0.001) < 1e-9, 'board Z-up → glTF Y-up');
const boardMesh = gltf.meshes.find((m: { primitives: unknown[] }) => m.primitives.length === 4);
assert(boardMesh, 'board mesh keeps 4 material groups');

console.log(`3D EXPORT OK: GLB (${(glb.byteLength / 1024).toFixed(0)} KB, ${gltf.images.length} PNG), OBJ (${faces.length} faces, ${files.length - 2} PNG), centred Y-up, units, materials`);
