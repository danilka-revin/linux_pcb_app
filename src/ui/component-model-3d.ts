// Автономные параметрические модели: никаких CDN и внешних файлов.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Comp, Pad, Smd, RectE, Circ } from '../pcb/model';

export type Package3D = 'ic' | 'resistor' | 'capacitor' | 'diode' | 'led' | 'electrolytic'
  | 'transistor' | 'header' | 'socket' | 'terminal' | 'button' | 'switch' | 'crystal'
  | 'relay' | 'module' | 'inductor' | 'footprint' | 'generic';

/** Имена генератора, импортированных библиотек и стандартные refdes. */
export function componentPackage(e: Comp): Package3D {
  const text = `${e.lib} ${e.name} ${(e.ents || []).filter(p => p.kind === 'text').map(p => p.text).join(' ')}`.toLowerCase();
  if (/^(отверстие|крепёжное отверстие|площадка|метка|тестпоинт)(?:\s|$)/iu.test(e.name)) return 'footprint';
  const rules: [Package3D, RegExp][] = [
    ['footprint', /fiducial|mounting.?hole|test.?point/],
    ['module', /arduino|esp[-\s]?\d|nodemcu|pico|wemos|модуль|module|shield|плата|основание|blue pill/],
    ['switch', /dip.?switch|переключатель/],
    ['socket', /гнездо|панельк|socket/],
    ['terminal', /клемм|terminal/],
    ['header', /штыри|разъ[её]м|header|connector|pin.?row/],
    ['button', /кнопк|tact|push.?button/],
    ['relay', /реле|relay/],
    ['crystal', /кварц|резонатор|crystal|hc.?49/],
    ['electrolytic', /электролит|electroly|тантал|capacitor.*radial|cp_radial/],
    ['led', /светодиод|\bled\b/],
    ['transistor', /транзистор|transistor|\bto[- _]?(92|126|220|247)|to-корпус|sot[- _]?\d|dpak/],
    ['diode', /диод|diode|\bdo[- _]?\d/],
    ['resistor', /резистор|resistor|\b[rc]?_?axial\b/],
    ['capacitor', /конденсатор|capacitor/],
    ['inductor', /дроссел|катушк|inductor|coil/],
    ['ic', /\b(dip|soic|sop|tssop|msop|qfn|dfn|lqfp|tqfp|qfp|bga)[- _]?\d/],
  ];
  for (const [kind, pattern] of rules) if (pattern.test(text)) return kind;
  const ref = e.name.trim().toUpperCase();
  if (/^LED\d/.test(ref)) return 'led';
  for (const [prefix, kind] of Object.entries({ R: 'resistor', C: 'capacitor', D: 'diode', Q: 'transistor', U: 'ic', J: 'header', L: 'inductor', Y: 'crystal', K: 'relay', SW: 'button' })) {
    if (new RegExp(`^${prefix}\\d`).test(ref)) return kind as Package3D;
  }
  const pins = (e.ents || []).filter(p => p.kind === 'pad' || p.kind === 'smd');
  if (/чип|\b(0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/.test(text)) return 'resistor';
  return pins.length > 3 ? 'ic' : 'generic';
}

/** Детерминированная микротекстура и маркировка, без случайного шума между кадрами. */
export function createPackageTexture(kind: Package3D, label: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Не удалось создать текстуру корпуса.');
  const colors: Partial<Record<Package3D, string>> = {
    resistor: '#b69b70', capacitor: '#bb8448', diode: '#24252a', electrolytic: '#253845',
    led: '#dd2734', terminal: '#1876ad', header: '#25262b', socket: '#25262b',
    module: '#17694c', relay: '#20578d', crystal: '#bfc5ca', button: '#929aa1',
    switch: '#a62626', inductor: '#393b40', footprint: '#bd9956',
  };
  ctx.fillStyle = colors[kind] || '#303239'; ctx.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(255,255,255,.045)' : 'rgba(0,0,0,.06)';
    ctx.fillRect((i * 73) % 256, (i * 41 + Math.floor(i / 256) * 17) % 128, 1, 1);
  }
  if (kind === 'diode' || kind === 'electrolytic') {
    ctx.fillStyle = '#d5d8cc'; ctx.fillRect(16, 0, 24, 128);
    ctx.fillStyle = '#30343b'; ctx.font = 'bold 22px sans-serif'; ctx.fillText('−', 18, 35); ctx.fillText('−', 18, 100);
  }
  ctx.fillStyle = kind === 'crystal' || kind === 'resistor' || kind === 'button' ? '#26272b' : '#e1e3d9';
  ctx.font = 'bold 19px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label.trim().slice(0, 28) || 'PCB', 142, 63, 195);
  if (kind === 'ic' || kind === 'generic') { ctx.beginPath(); ctx.arc(18, 20, 6, 0, Math.PI * 2); ctx.fill(); }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Локальные X/Y совпадают с footprint; +Z всегда наружу от платы. */
export function createComponentModel(e: Comp, thickness: number): THREE.Group {
  const group = new THREE.Group();
  const kind = componentPackage(e);
  group.name = e.name || e.id;
  group.userData.package = kind;
  group.userData.approximate = true;
  group.position.set(e.x, e.y, (e.side === 'bottom' ? -1 : 1) * thickness / 2);
  group.rotation.z = THREE.MathUtils.degToRad(e.rot);
  // Поворот вокруг Y зеркалит локальный X и переворачивает Z, не меняя winding.
  if (e.side === 'bottom') group.rotateY(Math.PI);
  const pins = (e.ents || []).filter((p): p is Pad | Smd => p.kind === 'pad' || p.kind === 'smd');
  const rects = (e.ents || []).filter((p): p is RectE => p.kind === 'rect' && (p.layer === 's1' || p.layer === 's2'));
  const rect = rects.filter((p): p is RectE => p.kind === 'rect' && p.w > 0 && p.h > 0).sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const circles = (e.ents || []).filter((p): p is Circ => p.kind === 'circle' && (p.layer === 's1' || p.layer === 's2'));
  const circle = circles.sort((a, b) => b.r - a.r)[0];
  // Не используем подписи при определении габаритов корпуса.
  const bounds = pins.length ? [Math.min(...pins.map(p => p.x)), Math.min(...pins.map(p => p.y)), Math.max(...pins.map(p => p.x)), Math.max(...pins.map(p => p.y))] : e.bl;
  let cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
  let w = Math.max(1, bounds[2] - bounds[0]), h = Math.max(1, bounds[3] - bounds[1]);
  if (rect) { cx = rect.x + rect.w / 2; cy = rect.y + rect.h / 2; w = rect.w; h = rect.h; }
  else if (circle && ['led', 'electrolytic', 'capacitor', 'inductor'].includes(kind)) { cx = circle.x; cy = circle.y; w = h = circle.r * 2; }
  else if (pins.length > 3 && kind === 'ic') { w *= .7; h *= .85; }
  w = Math.max(.4, w); h = Math.max(.4, h);
  const metal = new THREE.MeshStandardMaterial({ color: '#bac2cb', metalness: .75, roughness: .27 });
  const gold = new THREE.MeshStandardMaterial({ color: '#d6ad51', metalness: .7, roughness: .3 });
  const dark = new THREE.MeshStandardMaterial({ color: '#20232a', roughness: .8 });
  const body = new THREE.MeshStandardMaterial({ roughness: .65 });
  // Создаём текстуру только после присоединения материала к геометрии ниже.
  const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
    const object = new THREE.Mesh(geometry, material); object.position.set(x, y, z); group.add(object); return object;
  };
  const box = (bw: number, bh: number, d: number, mat: THREE.Material, x = cx, y = cy, z = d / 2 + .15) =>
    mesh(new RoundedBoxGeometry(bw, bh, d, 2, Math.min(bw, bh, d) * .1), mat, x, y, z);
  const cylinder = (r: number, d: number, mat: THREE.Material, x = cx, y = cy, z = d / 2 + .15, segments = 32) => {
    const result = mesh(new THREE.CylinderGeometry(r, r, d, segments), mat, x, y, z);
    result.rotation.x = Math.PI / 2; return result;
  };
  const wire = (a: THREE.Vector3, b: THREE.Vector3, radius: number, material = metal) => {
    const delta = b.clone().sub(a);
    if (delta.lengthSq() < 1e-10) return;
    const object = mesh(new THREE.CylinderGeometry(radius, radius, delta.length(), 8), material, 0, 0, 0);
    object.position.copy(a).add(b).multiplyScalar(.5);
    object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  };
  const smd = pins.length > 0 && pins.every(p => p.kind === 'smd');
  const height = Math.max(.5, Math.min(3, Math.min(w, h) * .45));
  if (kind === 'footprint') {
    // Отверстия и метки — не электронные корпуса. Не закрываем их заглушкой.
  } else if (kind === 'electrolytic' || kind === 'led' || (kind === 'capacitor' && !smd)) {
    const r = Math.min(w, h) / 2;
    const d = kind === 'electrolytic' ? Math.max(4, r * 3) : Math.max(1, r * 1.6);
    cylinder(r, d, body);
    if (kind === 'led') {
      body.roughness = .22;
      const dome = mesh(new THREE.SphereGeometry(r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), body, cx, cy, d + .15);
      dome.rotation.x = Math.PI / 2;
      cylinder(r * 1.1, .35, body);
    } else if (kind === 'electrolytic') {
      cylinder(r * .92, .12, metal, cx, cy, d + .2);
      box(r * 1.25, .07, .025, dark, cx, cy, d + .27);
      box(.07, r * 1.25, .025, dark, cx, cy, d + .27);
    }
  } else if ((kind === 'resistor' || kind === 'diode') && !smd && pins.length === 2) {
    const a = new THREE.Vector3(pins[0].x, pins[0].y, 1.3), b = new THREE.Vector3(pins[1].x, pins[1].y, 1.3);
    const delta = b.clone().sub(a), length = delta.length();
    wire(a, b, .18);
    const axial = mesh(new THREE.CylinderGeometry(.7, .7, Math.max(.5, length * .58), 24), body, (a.x + b.x) / 2, (a.y + b.y) / 2, 1.3);
    axial.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
    // Не выдумываем номинал цветными полосами: на корпусе текстовая маркировка.
  } else if (kind === 'header' || kind === 'socket' || kind === 'terminal') {
    box(w + (rect ? 0 : 1.8), h + (rect ? 0 : 1.8), kind === 'terminal' ? 5 : 2.2, body);
    for (const pin of pins) {
      if (kind === 'header') box(.55, .55, 5.5, gold, pin.x, pin.y, 3);
      else if (kind === 'socket') { box(1.1, 1.1, .08, gold, pin.x, pin.y, 2.4); box(.7, .7, .1, dark, pin.x, pin.y, 2.46); }
      else { cylinder(.7, .2, metal, pin.x, pin.y, 5.25); box(.95, .12, .04, dark, pin.x, pin.y, 5.37); }
    }
  } else if (kind === 'button' || kind === 'switch') {
    box(w, h, 1.8, body);
    if (kind === 'button') cylinder(Math.min(w, h) * .24, 1.4, dark, cx, cy, 2.5);
    else {
      const n = Math.max(1, Math.floor(pins.length / 2));
      for (let i = 0; i < n; i++) box(w * .55, h / n * .5, .6, metal, cx, cy - h / 2 + (i + .5) * h / n, 2.1);
    }
  } else if (kind === 'module') {
    box(w, h, .9, body);
    box(w * .42, h * .35, 1.3, dark, cx, cy, 1.65);
    box(w * .3, h * .18, 1.5, metal, cx, cy + h * .32, 1.8);
  } else if (kind === 'inductor') {
    box(w, h, height, body);
    const copper = new THREE.MeshStandardMaterial({ color: '#b77535', metalness: .65, roughness: .3 });
    mesh(new THREE.TorusGeometry(Math.min(w, h) * .3, Math.min(w, h) * .13, 12, 32), copper, cx, cy, height + .15);
  } else if (kind === 'transistor' && !smd) {
    box(w, Math.max(1.3, h * .55), Math.max(4, w * .8), body);
    if (!/to[- ]?92/i.test(e.name)) box(w * .9, .3, Math.max(2, w * .4), metal, cx, cy + h * .27, Math.max(4, w * .8));
  } else {
    const d = kind === 'relay' ? Math.max(4, Math.min(w, h) * .9) : kind === 'crystal' ? 2 : height;
    box(w, h, d, body);
    if (kind === 'crystal') { body.metalness = .65; body.roughness = .32; box(w * 1.05, h * 1.05, .2, metal); }
  }
  // Реальные позиции площадок, а не равномерно придуманные выводы.
  for (const pin of pins) {
    if (pin.kind === 'pad') {
      const radius = Math.max(.08, Math.min(.3, pin.drill * .36));
      wire(new THREE.Vector3(pin.x, pin.y, -thickness - .45), new THREE.Vector3(pin.x, pin.y, kind === 'footprint' ? .08 : 1.3), radius);
      if (!['header', 'socket', 'terminal', 'footprint'].includes(kind)) {
        wire(new THREE.Vector3(pin.x, pin.y, 1.3), new THREE.Vector3(THREE.MathUtils.clamp(pin.x, cx - w / 2, cx + w / 2), THREE.MathUtils.clamp(pin.y, cy - h / 2, cy + h / 2), 1.3), radius);
      }
    } else {
      const lead = box(Math.max(.1, pin.w * .85), Math.max(.1, pin.h * .85), .22, metal, pin.x, pin.y, .13);
      lead.rotation.z = THREE.MathUtils.degToRad(pin.rot);
    }
  }
  try {
    if (kind !== 'footprint') body.map = createPackageTexture(kind, e.name || e.lib);
  } catch (error) {
    const materials = new Set<THREE.Material>([metal, gold, dark, body]);
    group.traverse(o => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
      }
    });
    materials.forEach(m => m.dispose());
    throw error;
  }
  // Материалы без геометрии не содержат GPU-ресурсов, но явно освобождаем их.
  const used = new Set<THREE.Material>();
  group.traverse(o => { if (o instanceof THREE.Mesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) used.add(m); });
  for (const m of [metal, gold, dark, body]) if (!used.has(m)) m.dispose();
  return group;
}
