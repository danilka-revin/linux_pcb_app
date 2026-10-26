import assert from 'node:assert/strict';
import { newBoard } from '../src/pcb/model';
import { excellon, gerberLayer, productionFiles } from '../src/pcb/gerber';
import { parseExcellon, parseGerber } from '../src/pcb/gerber-viewer';

const doc = newBoard(20, 10);
doc.name = 'cam-test';
doc.entities.push(
  { id: 'pad', kind: 'pad', x: 3.25, y: 4.5, size: 1.6, drill: .8, shape: 'round' },
  { id: 'via', kind: 'via', x: 8, y: 4, size: .8, drill: .4 },
  { id: 'track', kind: 'track', pts: [{ x: 3.25, y: 4.5 }, { x: 8, y: 4 }], w: .3, layer: 'k1' },
  { id: 'smd', kind: 'smd', x: 15, y: 4, w: 2, h: 1, rot: 90, layer: 'k1' },
  { id: 'hole', kind: 'hole', x: 18, y: 8, d: 2 },
  { id: 'circle', kind: 'circle', x: 10, y: 5, r: 1.5, w: .2, layer: 's1' },
);
const copperText = gerberLayer(doc, 'k1', 'Top copper');
const copper = parseGerber(copperText);
assert(copper.primitives.some((p) => p.kind === 'flash' && p.points[0].x === 3.25));
assert(copper.primitives.some((p) => p.kind === 'path' && p.points.length === 2));
assert(copper.primitives.some((p) => p.kind === 'flash' && p.aperture.shape === 'R' && p.aperture.width === 1));
assert(copper.bounds[0] < 3 && copper.bounds[2] > 15, 'aperture bounds include pad dimensions');
const inchGerber = parseGerber('%FSLAX24Y24*%\n%MOIN*%\n%ADD10C,0.01*%\nD10*\nX010000Y005000D03*');
assert(Math.abs(inchGerber.primitives[0].points[0].x - 25.4) < 1e-6);
assert(Math.abs(inchGerber.primitives[0].aperture.width - .254) < 1e-6, 'inch coordinates and apertures convert to mm');
const silkscreen = parseGerber(gerberLayer(doc, 's1', 'Silk'));
assert(silkscreen.primitives.some((p) => p.kind === 'path' && p.points.length > 4), 'circular interpolation is tessellated for preview');
const outline = parseGerber(gerberLayer(doc, 'outline', 'Outline'));
assert(outline.primitives.filter((p) => p.kind === 'path').length >= 4, 'the outline is split into four preview strokes');
const drillText = excellon(doc);
const drills = parseExcellon(drillText);
assert.equal(drills.length, 3);
assert.deepEqual(drills.map((h) => h.diameter).sort((a, b) => a - b), [.4, .8, 2]);
assert(drills.some((h) => h.x === 3.25 && h.y === 4.5));
const inch = parseExcellon('M48\nINCH,TZ\nT01C0.031\n%\nT01\nX010000Y005000\nM30');
assert(Math.abs(inch[0].diameter - .7874) < .001 && Math.abs(inch[0].x - 25.4) < .001);
const files = productionFiles(doc);
assert.equal(files.length, 6);
assert(files.some((f) => f.name.endsWith('.xln')));
// Односторонняя плата: слоя K1 в производственном пакете нет вовсе.
const single = productionFiles({ ...doc, layers: 1 as const });
assert.equal(single.length, 5, 'у односторонней платы пять файлов: без верхней меди');
assert(!single.some((f) => /\.gtl$/i.test(f.name)), 'нет Gerber верхней меди');
assert(single.some((f) => /\.gbl$/i.test(f.name)), 'нижняя медь на месте');
const panel = { ...doc, panelInfo: { cols: 2, rows: 1, stepX: 25, stepY: 10, railBounds: { x: -5, y: -5, w: 55, h: 20 }, toolingHoles: [], fiducials: [], tabs: [], vCuts: [{ x1: 20, y1: 0, x2: 20, y2: 10 }] } };
const panelFiles = productionFiles(panel);
assert.equal(panelFiles.length, 7);
assert(panelFiles.some((f) => f.name.includes('V-CUT-guide')));
assert(parseGerber(panelFiles.find((f) => f.name.includes('V-CUT-guide'))!.data).primitives.some((p) => p.kind === 'path'));
assert(parseGerber(panelFiles.find((f) => f.name.endsWith('.gm1'))!.data).bounds[0] <= -5, 'rail perimeter is added to profile Gerber');
let rejected = false;
try { parseGerber('G04'.repeat(14 * 1024 * 1024)); } catch { rejected = true; }
assert(rejected, 'oversized CAM file rejected');
const denseGerber = parseGerber('%FSLAX34Y34*%%MOMM*%%ADD10C,0.1*%D10*' + 'X0Y0D03*'.repeat(250_001));
assert(denseGerber.truncated && denseGerber.primitives.length === 250_000, 'geometry cap protects preview from hostile dense input');
console.log('CAM: Gerber/Excellon export and parsing, apertures, arcs, drill conversion and panel guides OK');
