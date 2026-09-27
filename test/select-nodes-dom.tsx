// Узлы дорожки создаются и удаляются в инструменте «Выбор» — без отдельного режима.
// Реальные обработчики App в jsdom; отрисовка canvas заменена заглушкой.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
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

const board: Doc = { name: 'Узлы', w: 100, h: 80, entities: [{
  id: 'trace', kind: 'track', w: 0.6, layer: 'k1',
  pts: [{ x: 20, y: 30 }, { x: 40, y: 30 }, { x: 60, y: 30 }],
}] };
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ snapOn: false, grid: 1 }));
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

assert.equal([...win.document.querySelectorAll('.tool-dock button')].filter(b => b.getAttribute('title')?.startsWith('Узлы')).length, 0);
await key('KeyE'); // прежняя горячая клавиша больше не переключает инструмент
assert.match(win.document.querySelector('.status')?.textContent ?? '', /Выбор/);

await dbl(30, 30); // первый клик выбирает дорожку, второй + dblclick вставляют узел
assert.equal((await points())?.pts.length, 4, 'двойной клик по звену добавляет узел');
assert.ok(win.document.body.textContent?.includes('Удалить узел'), 'выбранный узел доступен в свойствах');
assert.ok(win.document.body.textContent?.includes('X узла'), 'координаты узла видны в свойствах');
await key('Delete');
assert.equal((await points())?.pts.length, 3, 'Del удаляет узел, а не дорожку');
await key('KeyZ', true);
assert.equal((await points())?.pts.length, 4, 'удаление узла отменяется');

await click(30, 30);
const removeNode = [...win.document.querySelectorAll('.props button')]
  .find(b => b.textContent?.trim() === 'Удалить узел');
assert.ok(removeNode, 'кнопка удаления узла видна в свойствах');
await act(async () => { removeNode!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
assert.equal((await points())?.pts.length, 3, 'кнопка в свойствах удаляет только узел');
await key('KeyZ', true);

await pointer('pointerdown', 30, 30, 2);
assert.equal((await points())?.pts.length, 3, 'ПКМ по узлу удаляет его в «Выборе»');
await key('KeyZ', true);
await dbl(30, 30);
assert.equal((await points())?.pts.length, 3, 'двойной клик по узлу удаляет его');

await click(40, 30); // выбрали существующий узел
await key('Escape');  // снять выбор узла, оставив дорожку выбранной
await key('Delete');
assert.equal((await saved()).entities.length, 0, 'Del без выбранного узла удаляет дорожку целиком');
await key('KeyZ', true);
assert.equal((await points())?.pts.length, 3);

const probe = [...win.document.querySelectorAll('.tool-dock button')].find(b => b.getAttribute('title')?.startsWith('Тест цепи'))!;
await act(async () => { probe.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
await dbl(30, 30);
assert.equal((await points())?.pts.length, 3, 'в другом инструменте узлы не создаются');

await act(async () => { root.unmount(); });
dom.window.close();
process.stdout.write('SELECT NODES DOM OK: создание, Del/ПКМ/двойной клик, Esc, отмена, другой инструмент\n', () => process.exit(0));
