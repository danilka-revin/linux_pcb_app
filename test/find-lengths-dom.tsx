// Поиск (Ctrl+Shift+F) и панель длин/шин: реальные обработчики App в jsdom.
// Холст заменён заглушкой; проверяем DOM, состояния и сохранённую плату.
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

// Две цепи одной шины: GND ≈ 20 мм, VCC — короткая (4 мм).
const comp = (id: string, name: string, x: number, y: number, ents: any[], side: 'top' | 'bottom' = 'top') => ({
  kind: 'comp', id, lib: '', name, x, y, rot: 0, side, bl: [-2, -2, 2, 2], ents,
});
const board: Doc = {
  name: 'Поиск и шины', w: 100, h: 80, entities: [
    comp('R1', 'Резистор 0805 10k', 20, 20, [
      { kind: 'pad', id: 'R1p1', x: 0, y: -1, shape: 'round', size: 1.6, drill: 0.8 },
      { kind: 'pad', id: 'R1p2', x: 0, y: 1, shape: 'round', size: 1.6, drill: 0.8 },
      { kind: 'text', id: 'R1lbl', x: 0, y: 2.5, size: 1, th: 0.15, rot: 0, text: 'R1', mirror: false, layer: 's1' },
    ]),
    comp('C7', 'Конденсатор 0603 100n', 40, 20, [
      { kind: 'pad', id: 'C7p1', x: -1, y: 0, shape: 'round', size: 1.6, drill: 0.8 },
      { kind: 'pad', id: 'C7p2', x: 1, y: 0, shape: 'round', size: 1.6, drill: 0.8 },
    ]),
    { kind: 'track', id: 'gndTr', layer: 'k1', w: 0.3, pts: [{ x: 20, y: 19 }, { x: 39, y: 19 }, { x: 39, y: 20 }] },
    comp('U2', 'Микросхема SOIC-8', 60, 40, [
      { kind: 'pad', id: 'U2p1', x: -2, y: 0, shape: 'round', size: 1.6, drill: 0.8 },
      { kind: 'pad', id: 'U2p2', x: 2, y: 0, shape: 'round', size: 1.6, drill: 0.8 },
    ]),
    { kind: 'track', id: 'vccTr', layer: 'k1', w: 0.3, pts: [{ x: 58, y: 40 }, { x: 62, y: 40 }] },
  ],
  nets: [
    { id: 'n-gnd', name: 'GND', pads: ['R1:0', 'C7:0'], bus: 'DQ' },
    { id: 'n-vcc', name: 'VCC_3V3', pads: ['U2:0', 'U2:1'], bus: 'DQ' },
  ],
};
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ snapOn: false, grid: 1, trackW: .2, angle: '45' }));
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const App = (await import('../src/App')).default;
const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(App)); });

const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const keyOn = async (target: EventTarget, init: KeyboardEventInit) => {
  await act(async () => {
    target.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    await frame();
  });
};
const press = (code: string, extra: KeyboardEventInit = {}) => keyOn(win.document.body, { code, ...extra });
const buttonByText = (name: string) => [...win.document.querySelectorAll('button')].find((b) => b.textContent === name);
const clickButton = async (name: string) => {
  const btn = buttonByText(name);
  assert(btn, `кнопка «${name}»`);
  await act(async () => { btn!.click(); await frame(); });
};
const setInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    await frame();
  });
};
const saved = async () => {
  await wait(750); // автосохранение отложено на 600 мс
  return JSON.parse(win.localStorage.getItem('lauaut.autosave')!) as Doc;
};
const findInput = () => win.document.querySelector('input[aria-label="Что найти на плате"]') as HTMLInputElement | null;

// ------------------------------------------------------------------ поиск
assert.equal(findInput(), null, 'панель поиска закрыта по умолчанию');
await press('KeyF', { ctrlKey: true, shiftKey: true });
assert.ok(findInput(), 'Ctrl+Shift+F открывает поиск');
assert.equal(win.document.activeElement, findInput(), 'поле поиска получает фокус');
assert.match(win.document.querySelector('.find-status')?.textContent ?? '', /Введите/);

await setInput(findInput()!, 'R1');
const hits = [...win.document.querySelectorAll('.find-hit')];
assert.ok(hits.length >= 1, 'R1 найден');
assert.match(win.document.querySelector('.find-status')?.textContent ?? '', /Найдено: \d+/);
assert.match(hits[0].textContent ?? '', /R1/);

await setInput(findInput()!, 'zzzz');
assert.match(win.document.querySelector('.find-status')?.textContent ?? '', /Ничего не найдено/);
assert.equal(win.document.querySelectorAll('.find-hit').length, 0);

await setInput(findInput()!, 'gnd');
await keyOn(findInput()!, { key: 'Enter', code: 'Enter' });
assert.ok(win.document.querySelector('.canvas-find.is-active'), 'выбранный результат подсвечен');
assert.equal(win.document.querySelector('.canvas-find.is-active') && findInput() !== null, true, 'панель остаётся открытой');

// стрелки внутри поля выбирают результаты и не трогают плату
await keyOn(findInput()!, { key: 'ArrowDown', code: 'ArrowDown' });
assert.equal(win.document.querySelectorAll('.find-hit.active').length, 1);

await keyOn(findInput()!, { key: 'Escape', code: 'Escape' });
assert.equal(findInput(), null, 'Esc закрывает поиск');
assert.equal(win.document.querySelector('.canvas-find.is-active'), null, 'подсветка снята вместе с панелью');
assert.equal((await saved()).entities.length, board.entities.length, 'поиск не меняет плату');

// ------------------------------------------------------------ длины и шины
await press('Digit9'); // инструмент «Автотрассировка»
await clickButton('Группы / вся плата');
const card = [...win.document.querySelectorAll('.bus-card')].find((c) => c.querySelector('.bus-head')?.textContent?.includes('DQ'));
assert.ok(card, 'шина DQ показана');
assert.match(card!.querySelector('.bus-stats')?.textContent ?? '', /разброс 1[56],\d\d мм/, 'разброс = макс − мин по сумме дорожек');
assert.match(card!.textContent ?? '', /GND/);
assert.match(card!.textContent ?? '', /VCC_3V3/);

const align = [...card!.querySelectorAll('button')].find((b) => b.textContent === 'Выровнять по самой длинной');
assert.ok(align && !align.disabled, 'кнопка выравнивания доступна при разбросе');
await act(async () => { align!.click(); await frame(); });
const msg = win.document.querySelector(".net-length [role=\"status\"]");
assert.ok(msg && (msg.textContent ?? '').length > 0, 'результат выравнивания показан');
assert.match(msg!.className, /bad|ok/, 'результат помечен как успех или отказ');
// VCC — 4 мм прямой дорожки: 16 мм змейкой на ней не набрать, плата не портится
const after = await saved();
assert.equal((after.entities.find((e) => e.id === 'gndTr') as Track).pts.length, 3, 'GND не тронута');
assert.equal((after.entities.find((e) => e.id === 'vccTr') as Track).pts.length, 2, 'короткая цепь не получила змейку при отказе');

await act(async () => root.unmount());
dom.window.close();
process.stdout.write('find-lengths-dom: поиск, подсветка, Esc, шины и выравнивание OK\n', () => process.exit(0));
