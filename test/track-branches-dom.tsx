// Ответвления: настоящие события редактора, связность, наследование и история.
// Реальные обработчики App в jsdom; отрисовка canvas заменена заглушкой.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { copperComponents } from '../src/pcb/netroute';
import { trackClearance } from '../src/pcb/track-clearance';
import type { Doc, Track } from '../src/pcb/model';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/', pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
win.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, {
  get: (_t, prop) => prop === 'measureText' ? () => ({ width: 24 })
    : prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern'
      ? () => ({ addColorStop: () => undefined }) : () => undefined,
}) as never;
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as never;
win.Element.prototype.setPointerCapture = () => undefined;
win.Element.prototype.releasePointerCapture = () => undefined;
win.fetch = (() => Promise.reject(new Error('офлайн'))) as never;
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser', 'Blob',
]) Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: win.ResizeObserver, configurable: true, writable: true });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const board: Doc = { name: 'Ветки', w: 100, h: 80, entities: [
  { id: 'trace', kind: 'track', w: .7, layer: 'k2',
    pts: [{ x: 20.13, y: 30.27 }, { x: 40.13, y: 30.27 }, { x: 60.13, y: 30.27 }] },
  { id: 'target', kind: 'smd', x: 70.19, y: 55.33, w: 2, h: 2, rot: 0, layer: 'k2' },
] };
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ snapOn: false, grid: 1, trackW: .2, angle: '45' }));
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const App = (await import('../src/App')).default;
const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(App)); });

const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
const over = () => win.document.querySelector('.canvas-over') as HTMLElement;
const status = () => [...win.document.querySelectorAll('.status > span')];
const cursor = () => ({
  x: Number(status()[0].querySelector('b')?.textContent),
  y: Number(status()[1].querySelector('b')?.textContent),
});
const pointerPx = async (x: number, y: number, type = 'pointermove', button = 0) => {
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent(type, { clientX: x, clientY: y, button, bubbles: true, cancelable: true }));
    await frame();
  });
};
await pointerPx(0, 0);
const a = cursor();
await pointerPx(100, 100);
const b = cursor();
const sx = (b.x - a.x) / 100, sy = (a.y - b.y) / 100;
assert.ok(sx > 0 && sy > 0);
const at = (wx: number, wy: number) => ({ clientX: (wx - a.x) / sx, clientY: (a.y - wy) / sy });
const pointer = async (type: string, wx: number, wy: number, button = 0) => {
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent(type, { ...at(wx, wy), button, bubbles: true, cancelable: true }));
    await frame();
  });
};
const click = async (x: number, y: number) => {
  await pointer('pointerdown', x, y);
  await pointer('pointerup', x, y);
};
const dbl = async (x: number, y: number) => {
  await click(x, y);
  await click(x, y);
  await pointer('dblclick', x, y);
};
const key = async (code: string, ctrlKey = false) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code, ctrlKey, bubbles: true, cancelable: true }));
    await frame();
  });
};
const saved = async () => {
  await act(async () => { await new Promise(r => setTimeout(r, 520)); });
  return JSON.parse(win.localStorage.getItem('lauaut.autosave')!) as Doc;
};
const points = async () => (await saved()).entities.find(e => e.id === 'trace') as Track | undefined;

const pressButton = async (name: string) => {
  const btn = [...win.document.querySelectorAll('button')].find(b => b.textContent === name);
  assert(btn, name);
  await act(async () => { btn!.click(); await frame(); });
};
const branches = (d: Doc) => d.entities.filter((e): e is Track => e.kind === 'track' && e.id !== 'trace');
const assertBranch = (d: Doc, node: number) => {
  const branch = branches(d)[branches(d).length - 1];
  assert(branch);
  assert.equal(branch.layer, 'k2'); assert.equal(branch.w, .7);
  assert.deepEqual(branch.pts[0], (board.entities[0] as Track).pts[node]);
  const net = copperComponents(d.entities);
  assert.equal(net.get(branch.id), net.get('trace'));
  assert.deepEqual(d.entities.find(e => e.id === 'trace'), board.entities[0], 'trunk not split or modified');
  return branch;
};

// Select any interior node and start through the explicit action.
await click(40.13, 30.27); // select track
await click(40.13, 30.27); // select node
await pressButton('Ответвление от узла');
assert.match(win.document.querySelector('.status')?.textContent ?? '', /Дорожка/);
assert.equal((await saved()).entities.length, 2, 'starting a branch does not yet mutate the document');
await click(70.19, 55.33); // exact off-grid SMD, requires a 45-degree bend
await key('Escape');
let d = await saved();
let branch = assertBranch(d, 1);
assert.deepEqual(branch.pts[branch.pts.length - 1], { x: 70.19, y: 55.33 });
assert.equal(branch.pts.length, 3, 'bend reaches the destination exactly');
assert.equal(trackClearance(d.entities, .2).length, 0);
assert.equal(copperComponents(d.entities).get(branch.id), copperComponents(d.entities).get('target'));
await key('KeyZ', true);
assert.equal(branches(await saved()).length, 0, 'single undo removes the entire branch');
await key('KeyY', true);
assert.equal(branches(await saved()).length, 1, 'redo restores branch');

// Drag the shared vertex: both the original and branch remain attached.
await key('Digit1');
await click(30, 30.27); // select trunk away from branch
await pointer('pointerdown', 40.13, 30.27);
await pointer('pointermove', 43, 32);
await pointer('pointerup', 43, 32);
d = await saved(); branch = branches(d)[0];
const moved = (d.entities.find(e => e.id === 'trace') as Track).pts[1];
assert(Math.hypot(moved.x - 43, moved.y - 32) < .01);
assert.deepEqual(branch.pts[0], moved, 'moving shared node keeps the branch attached');
await key('KeyZ', true);
assertBranch(await saved(), 1);

// Numeric vertex edits preserve the junction as well.
await click(40.13, 30.27);
const yField = win.document.querySelector('input[aria-label="Y узла, мм"]') as HTMLInputElement;
assert(yField);
await act(async () => {
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(yField, '31.5');
  yField.dispatchEvent(new win.Event('input', { bubbles: true }));
});
await act(async () => { yField.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true })); });
d = await saved();
assert.deepEqual(branches(d)[0].pts[0], { x: 40.13, y: 31.5 });
assert.deepEqual((d.entities.find(e => e.id === 'trace') as Track).pts[1], { x: 40.13, y: 31.5 });
await key('KeyZ', true);
assertBranch(await saved(), 1);

// The existing track tool starts from any vertex, even near an off-grid node.
await key('Digit2');
await click(20.18, 30.30); // within pick radius, not exactly on the source node
await click(20.13, 18.27);
await key('Escape');
d = await saved();
assert.equal(branches(d).length, 2);
assertBranch(d, 0);

// A one-point draft can be cancelled without a phantom track or history entry.
await click(60.13, 30.27);
await key('Escape');
assert.equal(branches(await saved()).length, 2);
await key('KeyZ', true);
assert.equal(branches(await saved()).length, 1, 'cancelled start added no undo step');
await key('KeyY', true);
assert.equal(branches(await saved()).length, 2);

// Finish on a track vertex: terminalPath must reach the exact copper, not project away.
await click(80, 17);
await click(60.17, 30.30);
await key('Escape');
d = await saved();
const last = branches(d)[2];
assert.deepEqual(last.pts[last.pts.length - 1], { x: 60.13, y: 30.27 });
assert.equal(copperComponents(d.entities).get(last.id), copperComponents(d.entities).get('trace'));

// Electrical chain highlighting includes the branches, not only the trunk.
await key('Digit0');
await click(30, 30.27);
assert.match(win.document.querySelector('.probe-info')?.textContent ?? '', /4 дорожки/);
await act(async () => root.render(null));
await act(async () => { root.render(React.createElement(App)); });
d = await saved();
assert.equal(branches(d).length, 3, 'autosave/reload retains branches');
const net = copperComponents(d.entities);
for (const b of branches(d)) assert.equal(net.get(b.id), net.get('trace'));
await act(async () => root.unmount());
dom.window.close();
process.stdout.write('TRACK BRANCH DOM OK: node action, manual tool, exact terminals, inheritance, junction drag, undo/redo, probe and reload\n', () => process.exit(0));
