// Экспорт 3D-модели платы с текстурами: GLB (один файл) и OBJ+MTL+PNG (ZIP).
import * as THREE from 'three';
import type { Doc } from '../pcb/model';
import { makeZip, type ZipFile } from '../pcb/zip';

export type Model3DFormat = 'glb' | 'obj';

/** Имя файла без запрещённых в Windows/Linux символов. */
export function exportBaseName(name: string | undefined): string {
  const clean = (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return clean.slice(0, 80) || 'board';
}

/**
 * Корень экспорта: центр платы в начале координат, ось Y вверх (glTF/OBJ),
 * масштаб задаёт единицы (0.001 — метры для glTF, 1 — миллиметры для OBJ).
 * Узлы клонируются, геометрия и материалы общие со сценой — освобождать нельзя.
 */
export function buildExportRoot(doc: Doc, board: THREE.Object3D, components: THREE.Object3D | null, unit: number): THREE.Group {
  const root = new THREE.Group();
  root.name = exportBaseName(doc.name);
  root.rotation.x = -Math.PI / 2;   // Z-вверх платы → Y-вверх файла
  root.scale.setScalar(unit);
  const inner = new THREE.Group();
  inner.name = 'pcb';
  inner.position.set(-doc.w / 2, -doc.h / 2, 0);
  root.add(inner);
  inner.add(board.clone());
  if (components && components.visible && components.children.length) inner.add(components.clone());
  root.updateMatrixWorld(true);
  return root;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** PNG из canvas-текстуры (HTMLCanvasElement или OffscreenCanvas). */
export async function texturePng(texture: THREE.Texture): Promise<Uint8Array> {
  const image = texture.image as { toBlob?: (cb: (b: Blob | null) => void, type?: string) => void; convertToBlob?: (o: { type: string }) => Promise<Blob> } | null;
  if (image?.toBlob) {
    const blob = await new Promise<Blob | null>(resolve => image.toBlob!(resolve, 'image/png'));
    if (!blob) throw new Error('Не удалось сохранить текстуру в PNG.');
    return blobBytes(blob);
  }
  if (image?.convertToBlob) return blobBytes(await image.convertToBlob({ type: 'image/png' }));
  throw new Error('Текстура не является изображением canvas.');
}

/** glTF 2.0 binary: геометрия, PBR-материалы и PNG-текстуры внутри одного файла. */
export async function exportGLB(root: THREE.Object3D): Promise<Blob> {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  // Сцена с именем платы вместо безымянной «AuxScene».
  const scene = new THREE.Scene();
  scene.name = root.name;
  scene.add(root);
  let result: ArrayBuffer | { [key: string]: unknown };
  try {
    result = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true, maxTextureSize: 4096 });
  } finally {
    scene.remove(root);
  }
  if (!(result instanceof ArrayBuffer)) throw new Error('Экспорт GLB вернул неожиданный результат.');
  return new Blob([result], { type: 'model/gltf-binary' });
}

const num = (v: number) => {
  const s = (Math.abs(v) < 5e-7 ? 0 : v).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};
const ident = (s: string) => s.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'item';

function isVisible(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
}

/** Wavefront OBJ + MTL + текстуры PNG. Координаты уже в мировых единицах корня. */
export async function exportOBJFiles(root: THREE.Object3D, base: string): Promise<ZipFile[]> {
  root.updateMatrixWorld(true);
  const obj: string[] = ['# PSBees — 3D-модель платы', `mtllib ${base}.mtl`];
  const mtl: string[] = ['# PSBees — материалы платы'];
  const files: ZipFile[] = [];
  const matNames = new Map<THREE.Material, string>();
  const texNames = new Map<THREE.Texture, string>();
  const usedNames = new Set<string>();
  const unique = (name: string) => {
    let n = name, i = 2;
    while (usedNames.has(n)) n = `${name}_${i++}`;
    usedNames.add(n);
    return n;
  };
  const pending: Promise<void>[] = [];
  const materialName = (m: THREE.Material): string => {
    const known = matNames.get(m);
    if (known) return known;
    const name = unique(ident(m.name || 'material'));
    matNames.set(m, name);
    const std = m as THREE.MeshStandardMaterial;
    const rgb = { r: 1, g: 1, b: 1 };
    if (std.color) std.color.getRGB(rgb, THREE.SRGBColorSpace);
    const rough = typeof std.roughness === 'number' ? std.roughness : 1;
    const metal = typeof std.metalness === 'number' ? std.metalness : 0;
    mtl.push('', `newmtl ${name}`, `Ka 0 0 0`, `Kd ${num(rgb.r)} ${num(rgb.g)} ${num(rgb.b)}`,
      `Ks ${num(metal * rgb.r)} ${num(metal * rgb.g)} ${num(metal * rgb.b)}`,
      `Ns ${num(Math.max(1, (1 - rough) ** 2 * 1000))}`, `Pr ${num(rough)}`, `Pm ${num(metal)}`,
      `d ${num(m.opacity ?? 1)}`, 'illum 2');
    if (std.map) {
      let file = texNames.get(std.map);
      if (!file) {
        file = `textures/${name}.png`;
        texNames.set(std.map, file);
        const path = file;
        pending.push(texturePng(std.map).then(data => { files.push({ name: path, data }); }));
      }
      mtl.push(`map_Kd ${file}`);
    }
    return name;
  };

  let vBase = 1, tBase = 1, nBase = 1;
  const v = new THREE.Vector3(), n = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  const objectNames = new Set<string>();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh) || !isVisible(o)) return;
    const g = o.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position');
    if (!pos || pos.count === 0) return;
    const nrm = g.getAttribute('normal'), uv = g.getAttribute('uv');
    let name = ident(o.name || o.parent?.name || 'mesh'), k = 2;
    const stem = name;
    while (objectNames.has(name)) name = `${stem}_${k++}`;
    objectNames.add(name);
    obj.push(`o ${name}`);
    normalMatrix.getNormalMatrix(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      obj.push(`v ${num(v.x)} ${num(v.y)} ${num(v.z)}`);
    }
    if (uv) for (let i = 0; i < uv.count; i++) obj.push(`vt ${num(uv.getX(i))} ${num(uv.getY(i))}`);
    if (nrm) for (let i = 0; i < nrm.count; i++) {
      n.fromBufferAttribute(nrm, i).applyMatrix3(normalMatrix).normalize();
      obj.push(`vn ${num(n.x)} ${num(n.y)} ${num(n.z)}`);
    }
    const index = g.getIndex();
    const total = index ? index.count : pos.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    const materials = Array.isArray(o.material) ? o.material : [o.material];
    const ref = (i: number) => {
      const p = vBase + i, t = tBase + i, q = nBase + i;
      return uv && nrm ? `${p}/${t}/${q}` : uv ? `${p}/${t}` : nrm ? `${p}//${q}` : `${p}`;
    };
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material || !material.visible) continue;
      obj.push(`usemtl ${materialName(material)}`);
      const end = Math.min(total, group.start + group.count);
      for (let i = group.start; i + 2 < end; i += 3) {
        const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
        obj.push(`f ${ref(a)} ${ref(b)} ${ref(c)}`);
      }
    }
    vBase += pos.count;
    if (uv) tBase += uv.count;
    if (nrm) nBase += nrm.count;
  });
  await Promise.all(pending);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [{ name: `${base}.obj`, data: obj.join('\n') + '\n' }, { name: `${base}.mtl`, data: mtl.join('\n') + '\n' }, ...files];
}

export async function exportOBJZip(root: THREE.Object3D, base: string): Promise<Blob> {
  return makeZip(await exportOBJFiles(root, base));
}
