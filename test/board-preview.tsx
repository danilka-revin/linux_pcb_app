// Regression tests for the layered preview. No WebGL/browser dependency.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import { BoardPreview2D, BOARD_2D_THEMES, drawBoard2D, previewVisible, previewBounds, type BoardPreviewOptions } from '../src/ui/board-preview-2d';
import { COLORS, drawEnt, zOrdered } from '../src/pcb/render';
import type { Doc, Entity, LayerId } from '../src/pcb/model';

type Call = { method: string; args: unknown[]; fill: unknown; stroke: unknown };
function recordingContext() {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const stack: Record<string, unknown>[] = [];
  const ctx = new Proxy(state, {
    get(target, key: string) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ method: key, args, fill: state.fillStyle, stroke: state.strokeStyle });
        if (key === 'save') stack.push({ ...state });
        if (key === 'restore') {
          for (const key of Object.keys(state)) delete state[key];
          Object.assign(state, stack.pop());
        }
      };
    },
    set(target, key: string, value) { target[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, stack };
}
const pad: Entity = { id: 'pad', kind: 'pad', x: 3, y: 4, shape: 'round', size: 2, drill: 0.3 };
const via: Entity = { id: 'via', kind: 'via', x: 5, y: 4, size: 1, drill: 0.2 };
const smd: Entity = { id: 'smd', kind: 'smd', x: 8, y: 5, w: 2, h: 1, rot: 90, layer: 'k1' };
const silk: Entity = { id: 'silk', kind: 'text', x: 2, y: 6, size: 1, th: 0.15, rot: 0, text: 'TOP', mirror: false, layer: 's1' };
const bottomSilk: Entity = { ...silk, id: 'bottomSilk', text: 'BOTTOM', layer: 's2' };
const doc: Doc = { name: 'Preview test', w: 20, h: 10, entities: [
  pad, via, smd, silk, bottomSilk,
  { id: 'top', kind: 'track', pts: [{ x: 3, y: 4 }, { x: 8, y: 5 }], w: 0.4, layer: 'k1' },
  { id: 'bottom', kind: 'track', pts: [{ x: 3, y: 4 }, { x: 5, y: 4 }], w: 0.4, layer: 'k2' },
  { id: 'hole', kind: 'hole', x: 15, y: 5, d: 2 },
  { id: 'outline', kind: 'rect', x: 1, y: 1, w: 18, h: 8, th: 0.1, filled: false, layer: 'outline' },
] };
const options: BoardPreviewOptions = { side: 'both', hidden: new Set(), showHoles: true, showMask: true, showGrid: false, scale: 10, offsetX: 40, offsetY: 40, width: 400, height: 240 };
const theme = BOARD_2D_THEMES.find(t => t.id === 'green')!;
assert.deepEqual(previewBounds(doc, [{ ...pad, x: -10 }]), [-11, 0, 20, 10]);
const before = JSON.stringify(doc), colorsBefore = JSON.stringify(COLORS);
const render = (overrides: Partial<BoardPreviewOptions> = {}) => {
  const recording = recordingContext();
  drawBoard2D(recording.ctx, doc, zOrdered(doc), theme, { ...options, ...overrides });
  assert.equal(recording.stack.length, 0, 'balanced canvas state');
  return recording.calls;
};

// Opposite-side silk is filtered just like copper. Pads follow visible copper.
assert(!previewVisible(bottomSilk, 'top', new Set()));
assert(!previewVisible(silk, 'bottom', new Set()));
assert(!previewVisible(pad, 'both', new Set(['k1', 'k2'])));
assert(!previewVisible(pad, 'top', new Set(['k1'])));
assert(previewVisible(pad, 'both', new Set(['k1'])));
assert(!previewVisible(smd, 'bottom', new Set()));
assert(!previewVisible(silk, 'both', new Set(['s1'])));
const calls = render();
const index = (method: string, color: string) => calls.findIndex(c => c.method === method && (method === 'stroke' ? c.stroke : c.fill) === color);
assert(index('stroke', theme.copperBottom) < index('stroke', theme.copperTop), 'bottom copper before top');
assert(index('stroke', theme.copperTop) < index('fillRect', theme.maskTop), 'mask over traces');
assert(index('fillRect', theme.maskTop) < index('fill', theme.copperBoth), 'pads stay exposed');
assert(index('fillRect', theme.maskTop) < index('fillRect', theme.copperTop), 'SMD stays exposed');
assert(index('fillText', theme.silkTop) < index('fill', theme.hole), 'drills are the last board pass');
assert(calls.some(c => c.method === 'arc' && c.args[2] === 1.5), 'real pad drill radius, not enlarged');
assert.equal(calls.filter(c => c.method === 'strokeRect' && c.stroke === theme.outline).length, 1, 'outline drawn only once');
assert(!render({ showHoles: false }).some(c => c.method === 'fill' && c.fill === theme.hole));
assert(!render({ showMask: false }).some(c => c.method === 'fillRect' && c.fill === theme.maskTop));
assert(!render({ side: 'top' }).some(c => c.method === 'fillText' && c.args[0] === 'BOTTOM'));
assert(!render({ side: 'bottom' }).some(c => c.method === 'fillText' && c.args[0] === 'TOP'));
const mirror = render({ side: 'bottom' });
assert(mirror.some(c => c.method === 'translate' && c.args[0] === 280));
assert(mirror.some(c => c.method === 'scale' && c.args[0] === -1), 'mirror the entire geometry');
const allLayers = new Set<LayerId>(['k1', 'k2', 's1', 's2', 'outline']);
assert(!render({ hidden: allLayers, showHoles: false, showMask: false }).some(c => c.method === 'stroke' || c.method === 'strokeRect' || c.method === 'arc'));
// Existing editor calls still render drills; opting out only removes drills.
for (const e of [pad, via]) {
  const a = recordingContext(), b = recordingContext();
  drawEnt(a.ctx, { s: 10, ox: 0, oy: 0, mir: false }, e, {});
  drawEnt(b.ctx, { s: 10, ox: 0, oy: 0, mir: false }, e, { omitDrills: true });
  assert.equal(a.calls.filter(c => c.method === 'arc').length, 2);
  assert.equal(b.calls.filter(c => c.method === 'arc').length, 1);
}
const componentDoc: Doc = { ...doc, entities: [{ id: 'comp', kind: 'comp', lib: '', name: 'Custom', x: 10, y: 0, rot: 0, side: 'top', bl: [0, 0, 5, 5], ents: [pad] }] };
const flat = zOrdered(componentDoc);
assert.equal(flat.length, 1);
assert.equal(flat[0].kind, 'pad');
assert('x' in flat[0] && flat[0].x === 13);
// Empty and very large boards, tiny scales and panning must stay bounded.
for (const empty of [{ ...doc, entities: [] }, { ...doc, w: 10000, h: 10000, entities: [] }]) {
  const r = recordingContext();
  drawBoard2D(r.ctx, empty, [], theme, { ...options, showGrid: true, scale: 0.01, offsetX: -5000 });
  assert(r.calls.length < 10000);
}
assert.equal(JSON.stringify(doc), before, 'preview does not edit document');
assert.equal(JSON.stringify(COLORS), colorsBefore, 'preview does not change editor palette');
const html = renderToString(createElement(BoardPreview2D, { doc }));
assert(html.includes('value="classic-dark" selected=""'), 'Sprint-style default');
for (const text of ['Все слои', 'Сетка', 'Сверловка', 'Вписать', 'Сторона платы']) assert(html.includes(text));
console.log('BOARD PREVIEW OK: layers, mask openings, drill passes, mirroring, canvas state, SSR');
