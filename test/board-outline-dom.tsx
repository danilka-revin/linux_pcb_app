// Перерисовка контура через настоящие обработчики редактора, отмена и повтор.
// Реальные обработчики App в jsdom; отрисовка canvas заменена заглушкой.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { boardShape, insideBoard } from '../src/pcb/board-shape';
import type { Doc, Pt } from '../src/pcb/model';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/', pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
let substratePath: Pt[] = [];
win.HTMLCanvasElement.prototype.getContext = function () {
  const state: Record<string, unknown> = {};
  let path: Pt[] = [];
  return new Proxy(state, {
    get: (t, prop: string) => {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 24 });
      if (prop.startsWith('create')) return () => ({ addColorStop: () => undefined });
      if (prop === 'beginPath') return () => { path = []; };
      if (prop === 'moveTo' || prop === 'lineTo') return (x: number, y: number) => path.push({ x, y });
      if (prop === 'fill') return (rule: string) => {
        if (this.className === 'canvas-base' && rule === 'evenodd') substratePath = path.slice();
      };
      return () => undefined;
    },
  }) as never;
};
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

const board: Doc = { name: 'Контур', w: 100, h: 80, entities: [{
  id: 'outline', kind: 'rect', x: 0, y: 0, w: 100, h: 80, filled: false, th: .2, layer: 'outline',
}] };
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ snapOn: true, grid: 1, lineLayer: 'outline' }));
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
const key = async (code: string, ctrlKey = false) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code, ctrlKey, bubbles: true, cancelable: true }));
    await frame();
  });
};
const saved = async () => {
  // Автосохранение отложено на 600 мс — ждём дольше.
  await act(async () => { await new Promise(r => setTimeout(r, 750)); });
  return JSON.parse(win.localStorage.getItem('lauaut.autosave')!) as Doc;
};
const tool = async (label: string) => {
  const button = [...win.document.querySelectorAll('.tool-dock button')].find(b => b.getAttribute('title')?.startsWith(label));
  assert(button, label);
  await act(async () => { button.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
};
const renderedShape = () => boardShape({ ...board, entities: substratePath.map((p, i) => {
  const q = substratePath[(i + 1) % substratePath.length];
  return { id: `r${i}`, kind: 'line', layer: 'outline', w: .2,
    x1: a.x + p.x * sx, y1: a.y - p.y * sy, x2: a.x + q.x * sx, y2: a.y - q.y * sy };
}) });
assert(insideBoard(renderedShape(), { x: 70, y: 70 }));
await click(50, 0);
await key('Delete');
assert.equal((await saved()).entities.length, 0, 'old frame removed');
await tool('Линия');
const pts = [{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 40 }, { x: 10, y: 40 }];
for (let i = 0; i < pts.length; i++) {
  const a = pts[i], b = pts[(i + 1) % pts.length];
  await click(a.x, a.y); await click(b.x, b.y);
  if (i === 0) assert(win.document.body.textContent?.includes('Контур не замкнут'), 'unfinished outline warning');
}
const drawn = await saved();
assert.equal(drawn.entities.length, 6);
assert(!boardShape(drawn).fallback);
assert(!win.document.body.textContent?.includes('Контур не замкнут'), 'closing last line clears warning');
assert(insideBoard(renderedShape(), { x: 15, y: 30 }));
assert(!insideBoard(renderedShape(), { x: 30, y: 30 }), 'actual editor substrate follows the drawn notch');
assert(win.document.body.textContent?.includes('Плата: 30 × 30 мм'), 'actual dimensions, not workspace size');
await key('KeyZ', true);
assert(boardShape(await saved()).fallback, 'undo opens the loop');
assert(win.document.body.textContent?.includes('Контур не замкнут'));
await key('KeyY', true);
assert(!boardShape(await saved()).fallback, 'redo restores closure');
assert(!insideBoard(renderedShape(), { x: 30, y: 30 }), 'redo redraws substrate');
await act(async () => { root.unmount(); });
dom.window.close();
process.stdout.write('BOARD OUTLINE DOM OK: delete frame, redraw concave outline, live substrate, dimensions, warning, undo/redo, autosave\n', () => process.exit(0));
