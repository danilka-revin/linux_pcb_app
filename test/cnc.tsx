import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import { analyzeCncBoard, buildCncJob, DEFAULT_CNC_SETTINGS, type CncSettings } from '../src/pcb/cnc';
import {
  autoFitGaps, isolationFits, isolationNeed, isolationOffset, pickForBoard, suggestIsolation,
} from '../src/pcb/cnc-settings';
import type { Doc, Pt } from '../src/pcb/model';
import { newBoard } from '../src/pcb/model';
import { CncDialog } from '../src/ui/cnc';
import { cncMotion, sampleCncMotion } from '../src/pcb/cnc-motion';
import { CncPreview } from '../src/ui/cnc-preview';
import { ExportDialog } from '../src/ui/dialogs';
import { makeZip, unzip } from '../src/pcb/zip';

const settings = (v: Partial<CncSettings> = {}): CncSettings => ({ ...DEFAULT_CNC_SETTINGS, ...v });
const text = (file: { data: string | Uint8Array }) => String(file.data);
const close = (a: number, b: number, tolerance = .012) => assert(Math.abs(a - b) < tolerance, `expected ${a} ≈ ${b}`);
const bounds = (paths: Pt[][]) => {
  const points = paths.flat();
  return [Math.min(...points.map((p) => p.x)), Math.min(...points.map((p) => p.y)),
    Math.max(...points.map((p) => p.x)), Math.max(...points.map((p) => p.y))];
};

const doc = newBoard(50, 30, 'CNC TEST');
doc.entities.push(
  { kind: 'pad', id: 'pad', x: 10, y: 8, shape: 'round', size: 2, drill: .800000001 },
  { kind: 'track', id: 'track', pts: [{ x: 10, y: 8 }, { x: 20, y: 8 }], w: .6, layer: 'k1' },
  { kind: 'smd', id: 'smd', x: 35, y: 20, w: 2, h: 1, rot: 90, layer: 'k2' },
  { kind: 'via', id: 'via', x: 20, y: 20, size: 2, drill: .8 },
  { kind: 'hole', id: 'hole', x: 25, y: 15, d: 1 },
  { kind: 'hole', id: 'duplicate', x: 25, y: 15, d: 1 },
  { kind: 'pad', id: 'zero', x: 40, y: 5, shape: 'square', size: 2, drill: 0 },
);
const before = JSON.stringify(doc);
const job = buildCncJob(doc, settings());
assert.equal(JSON.stringify(doc), before, 'CAM does not mutate the board');
assert.deepEqual(job.drills.map(({ diameter, count }) => [diameter, count]), [[.8, 2], [1, 1]]);
assert.equal(job.topLoops, 3, 'one continuous trace+pad, plus via and standalone square pad');
assert.equal(job.bottomLoops, 4, 'SMD only on bottom, pads/via on both layers');
assert.equal(job.files.length, 6, 'two sides + two distinct drills + schemes + instructions, no empty contour');
assert.equal(job.outlinePasses, 0);
assert.equal(job.files[0].name, '01_verh_k1.nc');
assert.equal(job.files[1].name, '02_niz_k2_zerkalo_x.nc');
assert.deepEqual(job.files.slice(2, 4).map((f) => f.name), ['sverlo_0p8mm_verh.nc', 'sverlo_1mm_verh.nc']);
assert.equal(job.files[4].name, '00b_SHEMY_PARAMETROV.svg', 'схемы «что за что отвечает» в архиве');
assert.equal(job.files[5].name, '00_PROCHTITE_PERED_ZAPUSKOM.txt');
assert(text(job.files[5]).includes('50') && text(job.files[5]).includes('Z0 заново') && text(job.files[5]).includes('Ноль'));
const schemes = text(job.files[4]);
assert(schemes.startsWith('<svg') && schemes.includes('что за что отвечает'), 'svg со схемами пригоден для печати у станка');
assert(schemes.includes('01_verh_k1.nc') && schemes.includes('00b_SHEMY_PARAMETROV.svg') && schemes.includes('sverlo_0p8mm_verh.nc'),
  'схема файлов перечисляет реальные программы архива');
assert(schemes.includes('Ø 0.4') && schemes.includes('Z-0.12') && (schemes.includes('a = 5 мм') || schemes.includes('X0=5')),
  'на схемах подставлены значения именно этой платы');
assert(schemes.includes('разделение') && schemes.includes('0.7'),
  'схема изоляции показывает зазор разделения меди');
assert(text(job.files[5]).includes('разделение меди 0.7'), 'инструкция содержит зазор разделения');
assert(schemes.includes('лево/право') && schemes.includes('вокруг оси Y') && schemes.includes('БЕЗ удерживающих перемычек'),
  'схемы объясняют переворот и вырез без перемычек');

// Объединённые площадка + дорожка имеют единственный внешний обход: фреза не
// пройдёт через их стык. Изоляция компенсирует радиус инструмента и зазор.
const topPadTrack = job.preview.top.find((path) => path.some((p) => p.x > 18 && p.x < 21 && p.y > 7 && p.y < 9))!;
assert(topPadTrack && job.preview.top.length === 3);
close(bounds([topPadTrack])[0], 10 - 1 - .4 / 2 - .15);
close(bounds([topPadTrack])[2], 20 + .6 / 2 + .4 / 2 + .15);
// Две стороны имеют одинаковые реальные отверстия, но разные координаты фрезеровки.
close(bounds(job.preview.top)[0], 10 - 1 - .35);
close(bounds(job.preview.bottom)[0], 50 - (40 + 1 + .35));
const bottomSmd = job.preview.bottom.find((path) => path.some((p) => p.x > 14 && p.x < 16 && p.y > 18 && p.y < 22))!;
assert(bottomSmd, 'SMD K2 included in mirrored face');
close(bounds([bottomSmd])[0], 15 - .5 - .35);
close(bounds([bottomSmd])[3], 20 + 1 + .35);
const top = text(job.files[0]);
const bottom = text(job.files[1]);
const drill08 = text(job.files[2]);
assert(!job.preview.top.some((path) => path.some((p) => p.x > 34 && p.x < 36 && p.y > 19 && p.y < 21)), 'SMD K2 not added to K1');
assert(bottom.includes('BOTTOM K2 MIRROR X'));
assert(!/\bM6\b|\bT\d+\b/.test([...job.files.slice(0, 4).map(text)].join('\n')));
assert(drill08.includes('G0 X15 Y13'), 'non-mirrored drill pad at (10,8) + offset (5,5)');
assert(drill08.includes('G0 X25 Y25'), 'via in same drill file');
assert(!drill08.includes('X30 Y20'), 'different drill diameter not in this program');
assert.equal((drill08.match(/G0 X/g) ?? []).length, 2);
assert(drill08.includes('G1 Z-0.6 F80') && drill08.includes('G1 Z-1.2 F80') && drill08.includes('G1 Z-1.8 F80'), 'peck drilling');
assert(!drill08.includes('Z-2.4'), 'depth not exceeded');
assert(text(job.files[3]).includes('G0 X30 Y20'), '1mm hole is in its own file');

// Во всех файлах XY холостой ход разрешён только после безопасного подъёма Z.
for (const { name, data } of job.files.filter((f) => f.name.endsWith('.nc'))) {
  const program = text({ data });
  assert(program.includes('G21 G90 G17 G94') && program.includes('M3 S') && program.includes('G4 P2'));
  assert(program.endsWith('M5\nM2\n') && !program.includes('NaN') && !program.includes('Infinity'));
  let z = Infinity;
  for (const line of program.split('\n')) {
    if (/^G0 X/.test(line)) assert(z >= 3, `${name}: rapid XY at unsafe Z=${z}`);
    if (/^G1 X/.test(line)) assert(z < 0, `${name}: cutting XY above stock`);
    const m = /^(?:G0|G1) Z(-?[0-9.]+)/.exec(line);
    if (m) z = Number(m[1]);
  }
  assert(z === 3, `${name}: final retract to safeZ`);
}

// Поворот платы по X, а не по Y, влияет на нижнюю сверловку и имя файла.
const flipped = buildCncJob(doc, settings({ drillSide: 'bottom' }));
assert.equal(flipped.drills[0].filename, 'sverlo_0p8mm_niz_zerkalo_x.nc');
assert(text(flipped.files.find((f) => f.name === flipped.drills[0].filename)!).includes('G0 X45 Y13'));
assert(text(flipped.files.find((f) => f.name === flipped.drills[0].filename)!).includes('G0 X35 Y25'));
assert.deepEqual(flipped.preview.drills[0], { x: 40, y: 8 });

// Диаметр фрезы реально влияет на смещение, плотные островки сливаются — экспорт
// должен ОТКАЗАТЬ, а не тихо оставить электрическое короткое замыкание.
const onePad = newBoard(30, 30);
onePad.entities.push({ kind: 'pad', id: 'p', x: 12, y: 12, size: 2, shape: 'round', drill: 0 });
const smallTool = buildCncJob(onePad, settings({ toolDiameter: .2, clearance: .1 }));
const wideTool = buildCncJob(onePad, settings({ toolDiameter: .6, clearance: .1 }));
close(bounds([smallTool.preview.top[0]])[0], 10.8);
close(bounds([wideTool.preview.top[0]])[0], 10.6);
const dense = newBoard(20, 20);
dense.entities.push(
  { kind: 'smd', id: 'a', x: 8, y: 8, w: .6, h: .6, rot: 0, layer: 'k1' },
  { kind: 'smd', id: 'b', x: 9.1, y: 8, w: .6, h: .6, rot: 0, layer: 'k1' },
);
assert.throws(() => buildCncJob(dense, settings({ toolDiameter: .6, clearance: .1 })), /не проходит между элементами/);
assert.equal(buildCncJob(dense, settings({ toolDiameter: .2, clearance: .05 })).topLoops, 2);

assert.equal(isolationNeed(settings()), .7);
assert.equal(isolationOffset(settings()), .35);
const roomy = analyzeCncBoard(doc);
assert(roomy.topIslands >= 1 && roomy.bottomIslands >= 1);
assert(!Number.isFinite(roomy.minGap) || roomy.minGap > 1, 'на тестовой плате щели шире 1 мм');
assert(isolationFits(settings(), roomy));
assert.equal(autoFitGaps(settings(), roomy, doc), null, 'дефолты уже проходят по просторной плате');

const denseFit = analyzeCncBoard(dense);
close(denseFit.minGap, .5, .08);
assert(!isolationFits(settings({ toolDiameter: .6, clearance: .1 }), denseFit));
const picked = pickForBoard(settings({ toolDiameter: .6, clearance: .1 }), denseFit, dense);
assert(isolationFits(picked, denseFit), 'подбор под плату даёт проходящую фрезу');
assert.equal(buildCncJob(dense, picked).topLoops, 2);
const shrunk = autoFitGaps(settings({ toolDiameter: .2, clearance: .4 }), denseFit, dense);
assert(shrunk && shrunk.settings.clearance < .4 && isolationFits(shrunk.settings, denseFit),
  'запас сам уменьшается, если текущая фреза ещё проходит');
const lonely = newBoard(30, 30);
lonely.entities.push({ kind: 'pad', id: 'p', x: 12, y: 12, size: 2, shape: 'round', drill: 0 });
assert.equal(analyzeCncBoard(lonely).minGap, Infinity);
assert.deepEqual(suggestIsolation(Infinity), { toolDiameter: .4, clearance: .15 });
const edge = newBoard(20, 20);
edge.entities.push({ kind: 'pad', id: 'edge', x: 1, y: 1, size: 2, shape: 'round', drill: 0 });
const edgeA = analyzeCncBoard(edge);
const edgeFit = autoFitGaps(settings({ originX: 0, originY: 0 }), edgeA, edge);
assert(edgeFit && edgeFit.settings.originX > 0 && edgeFit.settings.originY > 0,
  'отступы стола поднимаются, если медь у края');

// Окно внутри медной окружности даёт второй замкнутый проход с внутренней стороны.
const ring = newBoard(30, 30);
ring.entities.push({ kind: 'circle', id: 'ring', x: 12, y: 12, r: 2, w: .4, layer: 'k1' });
const ringJob = buildCncJob(ring, settings());
assert.equal(ringJob.topLoops, 2);
assert.equal(ringJob.preview.copperTop.length, 2);
const ringBoxes = ringJob.preview.top.map((p) => bounds([p])).sort((a, b) => a[0] - b[0]);
close(ringBoxes[0][0], 12 - (2 + .4 / 2 + .35)); // фреза снаружи кольца
close(ringBoxes[1][0], 12 - (2 - .4 / 2 - .35)); // фреза изнутри кольца
ring.entities[1] = { kind: 'circle', id: 'tiny', x: 12, y: 12, r: .4, w: .5, layer: 'k1' };
assert.throws(() => buildCncJob(ring, settings()), /внутреннее окно/);

const clockwise = newBoard(30, 30);
clockwise.entities.push({ kind: 'poly', id: 'poly', layer: 'k1', pts: [
  { x: 5, y: 5 }, { x: 5, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 5 },
] });
assert.equal(buildCncJob(clockwise, settings()).topLoops, 1, 'clockwise copper poly accepted');
const shapes = newBoard(60, 40);
shapes.entities.push(
  { kind: 'rect', id: 'frame', x: 5, y: 5, w: 10, h: 10, th: .4, filled: false, layer: 'k1' },
  { kind: 'line', id: 'bottom-line', x1: 20, y1: 20, x2: 25, y2: 20, w: .5, layer: 'k2' },
  { kind: 'rect', id: 'filled', x: 30, y: 20, w: 4, h: 5, th: .2, filled: true, layer: 'k2' },
  { kind: 'text', id: 'copper-label', x: 20, y: 5, size: 3, th: .3, rot: 0, text: 'I', mirror: false, layer: 'k1' },
);
const shapeJob = buildCncJob(shapes, settings());
assert.equal(shapeJob.topLoops, 3, 'copper frame outer+inner and copper text');
assert.equal(shapeJob.bottomLoops, 2, 'copper line and filled rectangle');
// Вложенная SMD-площадка развернулась и сменила слой; пад — физически обе стороны.
const embedded = newBoard(30, 30);
embedded.entities.push({ kind: 'comp', id: 'c', name: 'part', lib: '', x: 10, y: 10, rot: 0, side: 'bottom', bl: [0, 0, 3, 3], ents: [
  { kind: 'smd', id: 's', x: 2, y: 0, w: 1, h: 1, rot: 0, layer: 'k1' },
  { kind: 'pad', id: 'p', x: -2, y: 0, size: 1, shape: 'square', drill: .6 },
] });
const eJob = buildCncJob(embedded, settings());
assert.equal(eJob.topLoops, 1);
assert.equal(eJob.bottomLoops, 2);
assert.equal(eJob.drills[0].count, 1);

const cutting = buildCncJob(doc, settings({ cutOutline: true, outlineDepth: 1.7, outlineStep: .6 }));
assert.equal(cutting.outlinePasses, 3);
const outline = text(cutting.files.find((f) => f.name === '99_kontur_poslednim.nc')!);
assert(outline.includes('G1 Z-0.6') && outline.includes('G1 Z-1.2') && outline.includes('G1 Z-1.7'));
assert(outline.includes('X4.5') && outline.includes('Y4.5'), 'outline center outside board by half of 1mm bit');
assert(!outline.includes('G1 Z-2.4'));
const odd: Doc = { ...doc, entities: [...doc.entities, { kind: 'circle', id: 'extra', x: 25, y: 15, r: 4, w: .2, layer: 'outline' }] };
assert.throws(() => buildCncJob(odd, settings({ cutOutline: true })), /только один прямоугольный контур/);
assert(!buildCncJob(odd, settings()).files.some((f) => f.name.includes('kontur')), 'Gerber custom outline unaffected if cut disabled');

// Валидация: никаких файлов с NaN, недостающими нулями, дублирующимися разными
// свёрлами в одной точке или дорогой фрезой, выходящей за заготовку.
assert.throws(() => buildCncJob(doc, settings({ safeZ: NaN })), /Безопасная высота/);
const copperAtEdge = newBoard(30, 30);
copperAtEdge.entities.push({ kind: 'pad', id: 'edge', x: 0, y: 0, size: 2, shape: 'round', drill: 0 });
assert.throws(() => buildCncJob(copperAtEdge, settings({ originX: 0, originY: 0 })), /выходит за пределы заготовки/);
assert.throws(() => buildCncJob(newBoard(), settings()), /нет меди, отверстий/);
const conflict = newBoard(30, 30);
conflict.entities.push({ kind: 'pad', id: 'p', x: 5, y: 5, size: 1.6, shape: 'round', drill: .8 },
  { kind: 'hole', id: 'h', x: 5, y: 5, d: 1 });
assert.throws(() => buildCncJob(conflict, settings()), /разных диаметров/);
const offboard = newBoard(30, 30);
offboard.entities.push({ kind: 'hole', id: 'h', x: 40, y: 5, d: 1 });
assert.throws(() => buildCncJob(offboard, settings()), /вне платы/);

const archive = await unzip(await makeZip(job.files).arrayBuffer());
assert.deepEqual([...archive.keys()], job.files.map((f) => f.name));
assert(new TextDecoder().decode(archive.get('00_PROCHTITE_PERED_ZAPUSKOM.txt')).includes('Зеркало') ||
  new TextDecoder().decode(archive.get('00_PROCHTITE_PERED_ZAPUSKOM.txt')).includes('Низ после переворота'));
assert.equal(new TextDecoder().decode(archive.get('sverlo_0p8mm_verh.nc')), drill08);

const ui = renderToString(createElement(CncDialog, { doc, onClose: () => {} }));
assert(ui.includes('Проходов по глубине') && ui.includes('Построить траектории'));
assert(ui.includes('Демонстрация обработки') && ui.includes('Скачать CNC ZIP'));
assert(!ui.includes('scheme-chip') && !ui.includes('что за что отвечает'), 'no explanatory diagrams in export UI');
assert(ui.includes('Подобрать фрезу') && ui.includes('Подачи и обороты'));
const preview = renderToString(createElement(CncPreview, { doc, settings: settings(), job, side: 'top' }));
assert(preview.includes('cnc-walk') && preview.includes('Демонстрация'), 'inline simulation');
assert(preview.includes('cnc-preview-kerf') && preview.includes('cnc-walk-tool'), 'kerf and tool');
assert(preview.includes('Ход демонстрации') && preview.includes('cnc-depth'), 'scrubbing and depth view');
assert(preview.includes('sverlo_0p8mm_verh.nc') && preview.includes('02_niz_k2_zerkalo_x.nc'), 'all operations selectable');

const multipass = buildCncJob(doc, settings({ isolationDepth: .12, isolationPasses: 3,
  drillDepth: 1.8, drillPasses: 6, cutOutline: true, outlineDepth: 1.7, outlinePasses: 4 }));
const isoProgram = text(multipass.files[0]);
for (const depth of ['0.04', '0.08', '0.12']) {
  assert.equal(isoProgram.split(`G1 Z-${depth} F`).length - 1, multipass.topLoops);
}
assert.equal(multipass.outlinePasses, 4);
for (const file of multipass.files.filter(f => f.name.endsWith('.nc'))) {
  const program = text(file), motion = cncMotion(program, 3);
  const drilling = file.name.startsWith('sverlo_'), outline = file.name.startsWith('99_');
  const count = drilling ? 6 : outline ? 4 : 3;
  assert.equal(motion.depths.length, count, file.name);
  assert.equal(Math.min(...motion.moves.map(m => m.to.z)), drilling ? -1.8 : outline ? -1.7 : -.12);
  for (const m of motion.moves) {
    if (m.rapid && (m.from.x !== m.to.x || m.from.y !== m.to.y)) assert(m.from.z >= 3 && m.to.z >= 3);
    assert(Number.isFinite(m.end) && m.end > m.start);
  }
  const last = sampleCncMotion(motion, 1)!;
  assert.equal(last.position.z, 3, 'completion stays at final retract, not first frame');
  assert.deepEqual(last.position, motion.moves[motion.moves.length - 1].to);
  const plunge = motion.moves.find(m => m.to.z < 0)!;
  const during = sampleCncMotion(motion, ((plunge.start + plunge.end) / 2) / motion.duration)!;
  assert.equal(during.move.pass, 1);
  close(during.position.z, (plunge.from.z + plunge.to.z) / 2);
}
for (const key of ['isolationPasses', 'isolationWidthPasses', 'drillPasses', 'outlinePasses'] as const) {
  for (const value of [0, -1, 1.5, 101, NaN, Infinity]) {
    assert.throws(() => buildCncJob(doc, settings({ [key]: value })), /Проходы/);
  }
}
const onePass = buildCncJob(doc, settings({ isolationPasses: 1, drillPasses: 1, cutOutline: true, outlinePasses: 1 }));
assert.equal(onePass.outlinePasses, 1);
assert.deepEqual(cncMotion(text(onePass.files[2]), 3).depths, [1.8]);
assert.deepEqual(cncMotion('G21 G90 G17 G94\nG1 F120\nM2', 3).moves, []);
assert.equal(sampleCncMotion(cncMotion('', 3), .5), null);
const exportUi = renderToString(createElement(ExportDialog, {
  onGerber: () => {}, onPng: () => {}, onLay6: () => {}, onCnc: () => {}, onClose: () => {},
}));
assert(exportUi.includes('Настроить и скачать CNC ZIP') && exportUi.includes('НЕ G-code'));
console.log('CNC OK: copper union + offsets, mirrored K2 and drills, diameter files, pecks, safety, contour, ZIP, UI');

// XY widening is independent of Z passes, on both sides (including mirrored K2).
const widened = buildCncJob(doc, settings({ isolationWidthPasses: 3 }));
assert.equal(widened.topLoops, job.topLoops * 3);
assert.equal(widened.bottomLoops, job.bottomLoops * 3);
for (const side of ['top', 'bottom'] as const) {
  const original = job.preview[side], wide = widened.preview[side];
  for (const path of original) assert(wide.some(p => JSON.stringify(p) === JSON.stringify(path)));
  close(bounds(wide)[0], bounds(original)[0] - .64);
}
for (const file of widened.files.filter(f => /^0[12]_/.test(f.name))) {
  assert.deepEqual(cncMotion(text(file), 3).depths, [.12], 'width does not add Z levels');
}
const combined = buildCncJob(doc, settings({ isolationWidthPasses: 3, isolationPasses: 2 }));
assert.deepEqual(cncMotion(text(combined.files[0]), 3).depths, [.06, .12]);
assert.deepEqual(buildCncJob(doc, settings({ isolationWidthPasses: undefined })).preview, job.preview,
  'legacy settings keep a single XY pass');
assert(renderToString(createElement(CncDialog, { doc, onClose: () => {} })).includes('Проходов по ширине'));
