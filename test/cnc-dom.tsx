// Перерисовка контура через настоящие обработчики редактора, отмена и повтор.
// Реальные обработчики App в jsdom; отрисовка canvas заменена заглушкой.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildCncJob, analyzeCncBoard } from '../src/pcb/cnc';
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

// Workers are driven manually to exercise cancellation and stale responses.
class CamWorker {
  static instances: CamWorker[] = [];
  request: any;
  onmessage?: (event: { data: any }) => void;
  onerror?: () => void;
  terminated = false;
  constructor() { CamWorker.instances.push(this); }
  postMessage(request: any) { this.request = request; }
  terminate() { this.terminated = true; }
  finish() {
    const r = this.request;
    this.onmessage?.({ data: r.op === 'analyze' ? { type: 'analysis', analysis: analyzeCncBoard(r.doc) }
      : { ok: true, job: buildCncJob(r.doc, r.settings) } });
  }
}
Object.defineProperty(globalThis, 'Worker', { value: CamWorker, configurable: true });
const board: Doc = { name: 'CAM DOM', w: 40, h: 30, entities: [
  { id: 'outline', kind: 'rect', x: 0, y: 0, w: 40, h: 30, filled: false, th: .2, layer: 'outline' },
  { id: 'pad', kind: 'pad', x: 5, y: 5, size: 2, drill: .8, shape: 'round' },
  { id: 'a', kind: 'track', pts: [{ x: 10, y: 10 }, { x: 20, y: 10 }], w: .4, layer: 'k1' },
  { id: 'b', kind: 'track', pts: [{ x: 10, y: 10.5 }, { x: 20, y: 10.5 }], w: .4, layer: 'k1' },
] };
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { CncDialog } = await import('../src/ui/cnc');
const root = createRoot(win.document.getElementById('root')!);
const buttons = () => [...win.document.querySelectorAll('button')];
const button = (label: string) => {
  const btn = buttons().find(b => b.textContent?.trim() === label) as HTMLButtonElement;
  assert(btn, `button ${label}`); return btn;
};
const click = async (label: string) => { await act(async () => button(label).click()); };
const changeInput = async (element: HTMLInputElement | HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new win.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
};
const latestWorker = () => CamWorker.instances[CamWorker.instances.length - 1];
const cncBoard = { ...board, entities: board.entities.filter(e => e.id !== 'b') };
await act(async () => root.render(React.createElement(CncDialog, { doc: cncBoard, onClose() {} })));
await act(async () => latestWorker().finish());
assert.equal(button('Скачать CNC ZIP').disabled, true);
await changeInput(win.document.querySelector('#cnc-pass-count') as HTMLInputElement, '3');
assert.equal((win.document.querySelector('#cnc-pass-count') as HTMLInputElement).value, '3');
await click('Отверстия');
assert.equal((win.document.querySelector('#cnc-pass-count') as HTMLInputElement).value, '3');
await changeInput(win.document.querySelector('#cnc-pass-count') as HTMLInputElement, '6');
await click('Контур');
const cut = win.document.querySelector('.cnc-outline-toggle input') as HTMLInputElement;
await act(async () => cut.click());
await changeInput(win.document.querySelector('#cnc-pass-count') as HTMLInputElement, '4');
await click('Построить траектории');
const first = latestWorker();
assert.equal(first.request.settings.isolationPasses, 3);
assert.equal(first.request.settings.drillPasses, 6);
assert.equal(first.request.settings.outlinePasses, 4);
await click('Отменить расчёт');
assert(first.terminated);
await act(async () => first.finish());
assert.equal(button('Скачать CNC ZIP').disabled, true, 'stale worker result rejected');
await click('Построить траектории');
await act(async () => latestWorker().finish());
assert.equal(button('Скачать CNC ZIP').disabled, false);
assert(win.document.querySelector('.cnc-preview'));
const operation = win.document.querySelector('select[aria-label="Операция предпросмотра"]') as HTMLSelectElement;
assert.equal(operation.options.length, 4, 'top, bottom, drill and contour');
await changeInput(operation, 'sverlo_0p8mm_verh.nc');
assert(win.document.querySelector('.cnc-preview-stats')?.textContent?.includes('/ 6'));
const scrub = win.document.querySelector('[aria-label="Ход демонстрации"]') as HTMLInputElement;
await changeInput(scrub, '1000');
assert(win.document.querySelector('.cnc-preview-stats')?.textContent?.includes('Готово'));
assert(win.document.querySelector('.cnc-preview-stats')?.textContent?.includes('3 мм'));
await click('Сначала');
assert.equal(scrub.value, '0');
await click('▶ Демонстрация');
assert(button('Пауза'));
await click('Пауза');
await click('Медь');
await changeInput(win.document.querySelector('#cnc-pass-count') as HTMLInputElement, '2');
assert.equal(button('Скачать CNC ZIP').disabled, true, 'parameter change invalidates export');
assert.equal(win.document.querySelector('.cnc-preview'), null, 'old preview removed');
await click('Построить траектории');
const pending = latestWorker();
await act(async () => root.render(null));
assert(pending.terminated, 'closing dialog terminates CAM');

// Exercise real editor state, undo/redo and autosave for DRC exceptions.
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ drcEnabled: true, drcClear: .2 }));
const App = (await import('../src/App')).default;
await act(async () => root.render(React.createElement(App)));
assert(button('Игнорировать'));
await click('Игнорировать');
assert.equal(buttons().filter(b => b.textContent === 'Игнорировать').length, 0);
assert(win.document.querySelector('.clearance-exceptions')?.textContent?.includes('Исключения · 1'));
const key = async (code: string, shiftKey = false) => {
  await act(async () => win.dispatchEvent(new win.KeyboardEvent('keydown', { code, ctrlKey: true, shiftKey, bubbles: true, cancelable: true })));
};
await key('KeyZ');
assert(button('Игнорировать'), 'undo restores warning');
await key('KeyZ', true);
assert.equal(buttons().filter(b => b.textContent === 'Игнорировать').length, 0, 'redo suppresses warning');
await act(async () => { await new Promise(r => setTimeout(r, 750)); });
const saved = JSON.parse(win.localStorage.getItem('lauaut.autosave')!);
assert.equal(saved.ignoredClearance.length, 1);
await act(async () => root.render(null));
await act(async () => root.render(React.createElement(App)));
assert.equal(buttons().filter(b => b.textContent === 'Игнорировать').length, 0, 'reload retains exception');
await click('Вернуть');
assert(button('Игнорировать'));
await click('Игнорировать');
await click('Вернуть все предупреждения');
assert(button('Игнорировать'));
await act(async () => root.unmount());
win.close();
process.stdout.write('CAM/DRC DOM OK: counts, operations, scrub, play/pause, stale jobs, cancellation, undo/redo, save/reload and restore\n', () => process.exit(0));
