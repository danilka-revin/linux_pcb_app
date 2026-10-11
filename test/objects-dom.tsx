// DOM-проверка двух панелей: «Объекты» (дерево платы с поиском, скрытием и
// замком) и «История правок» (список операций и отмена сразу до нужной).
// Проверяются настоящие обработчики App, а не копия логики: jsdom не умеет
// canvas и ResizeObserver, поэтому они подменены заглушками (как в test/grid.ts).
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;

// фиктивный 2D-контекст: рисование в тесте не проверяется
const ctx2d = (): unknown => new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => {
    if (prop === 'measureText') return () => ({ width: 24 });
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient' || prop === 'createPattern')
      return () => ({ addColorStop: () => undefined });
    return () => undefined;
  },
  set: () => true,
});
win.HTMLCanvasElement.prototype.getContext = () => ctx2d() as never;
win.ResizeObserver = class { observe(): void {} unobserve(): void {} disconnect(): void {} } as never;
win.Element.prototype.setPointerCapture = (): void => undefined;
win.Element.prototype.releasePointerCapture = (): void => undefined;
win.fetch = (() => Promise.reject(new Error('офлайн'))) as never;

for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser', 'Blob',
]) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
}
Object.defineProperty(globalThis, 'ResizeObserver', { value: win.ResizeObserver, configurable: true, writable: true });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// --- плата: две площадки разного размера, дорожка и деталь с примитивами ---
const board = {
  name: 'Тест панели объектов', w: 100, h: 80,
  entities: [
    { id: 'p1', kind: 'pad', x: 20, y: 30, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p2', kind: 'pad', x: 40, y: 30, shape: 'round', size: 2.5, drill: 1.1 },
    { id: 't1', kind: 'track', pts: [{ x: 10, y: 60 }, { x: 60, y: 60 }], w: 0.5, layer: 'k1' },
    {
      id: 'c1', kind: 'comp', lib: '', name: 'R1', x: 50, y: 70, rot: 0, side: 'top',
      bl: [-2, -1.5, 2, 1.5],
      ents: [
        { id: 'l0', kind: 'pad', x: -1, y: 0, shape: 'round', size: 1.2, drill: 0.6 },
        { id: 'l1', kind: 'pad', x: 1, y: 0, shape: 'round', size: 1.2, drill: 0.6 },
      ],
    },
  ],
};
win.localStorage.setItem('lauaut.autosave', JSON.stringify(board));
win.localStorage.setItem('lauaut.defs', JSON.stringify({ snapOn: false, grid: 1 }));

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const App = (await import('../src/App')).default;

const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(App)); });

// --- помощники -------------------------------------------------------------
const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const over = () => win.document.querySelector('.canvas-over') as unknown as HTMLElement;
const q = (s: string) => win.document.querySelector(s);
const qa = (s: string) => [...win.document.querySelectorAll(s)] as unknown as HTMLElement[];
const header = () => q('.props h3')?.textContent ?? '';
const body = () => win.document.body.textContent ?? '';
const savedDoc = async () => {
  // автосохранение отложено на 600 мс — ждём дольше
  await act(async () => { await wait(750); });
  return JSON.parse(win.localStorage.getItem('lauaut.autosave')!) as typeof board;
};
const click = async (el: HTMLElement) => {
  await act(async () => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
};
/** ввод в поле поиска: React слушает событие input */
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    await frame();
  });
};
const cursor = () => {
  const spans = qa('.status > span');
  return {
    x: Number(spans[0].querySelectorAll('b')[0].textContent),
    y: Number(spans[1].querySelectorAll('b')[0].textContent),
  };
};
// калибровка «пиксели холста ↔ миллиметры» по строке состояния
let a = { x: 0, y: 0 }, sx = 1, sy = 1;
const calib = async () => {
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }));
    await frame();
  });
  const p0 = cursor();
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }));
    await frame();
  });
  const p1 = cursor();
  a = p0;
  sx = (p1.x - p0.x) / 100;
  sy = (p0.y - p1.y) / 100;
  return sx;
};
const pointer = async (type: string, wx: number, wy: number) => {
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent(type, {
      clientX: (wx - a.x) / sx, clientY: (a.y - wy) / sy, bubbles: true, cancelable: true,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
    }));
    await frame();
  });
};
const clickWorld = async (wx: number, wy: number) => {
  await pointer('pointerdown', wx, wy);
  await pointer('pointerup', wx, wy);
};
const key = async (code: string, opts: { ctrl?: boolean; shift?: boolean } = {}) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      code, bubbles: true, cancelable: true, ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift,
    }));
    await frame();
  });
};
const rows = () => qa('.obj-row');
const labelOf = (el: HTMLElement) => el.querySelector('.obj-label')?.textContent ?? '';
const rowStarting = (s: string) => rows().find((el) => labelOf(el).startsWith(s));
const rowExact = (s: string) => rows().find((el) => labelOf(el) === s);

const scale0 = await calib();
assert.ok(sx > 0 && sy > 0, 'строка состояния показывает координаты курсора');

// --- 1. вкладка «Объекты» и дерево платы -----------------------------------
{
  const tab = qa('.tabs button').find((el) => el.textContent === 'Объекты');
  assert.ok(tab, 'в левой колонке есть вкладка «Объекты»');
  await click(tab!);

  assert.ok(rowExact('Сквозные'), 'раздел «Сквозные» есть в дереве');
  assert.ok(rowExact('Верхняя медь (K1)'), 'раздел верхней меди есть в дереве');
  assert.ok(rowExact('Детали'), 'раздел «Детали» есть в дереве');
  assert.ok(rowStarting('Площадка ⌀1,9'), 'площадка видна в дереве');
  assert.ok(rowStarting('Дорожка 0,5'), 'дорожка видна в дереве');
  assert.ok(rowStarting('R1 · сверху'), 'деталь видна в дереве');
  assert.ok((q('.obj-status')?.textContent ?? '').includes('Объектов: 4'),
    `строка состояния дерева: ${q('.obj-status')?.textContent}`);
}

// --- 2. поиск: «R1» оставляет деталь, «12,5» — координату ------------------
{
  const input = q('.obj-search .txt') as unknown as HTMLInputElement;
  await type(input, 'R1');
  assert.ok(rowStarting('R1 · сверху'), 'деталь нашлась по имени');
  assert.ok(rowStarting('Площадки'), 'внутри детали видно её примитивы');
  assert.ok(!rowStarting('Площадка ⌀1,9'), 'площадка платы отфильтрована');
  assert.equal(rows().length, 3, `строк при поиске «R1»: ${rows().length}`);
  assert.ok((q('.obj-status')?.textContent ?? '').includes('Найдено объектов: 1'),
    'в строке состояния видно число найденного');

  await type(input, 'K1');
  assert.ok(rowExact('Верхняя медь (K1)'), 'слой ищется по имени');
  assert.ok(rowStarting('Дорожка 0,5'), 'на слое видна дорожка');
  assert.ok(!rowStarting('Площадка ⌀1,9'), 'сквозные площадки не на слое');

  await type(input, 'нет-такого');
  assert.equal(rows().length, 0, 'пустой запрос не оставляет строк');
  assert.ok((q('.obj-status')?.textContent ?? '').includes('Ничего не найдено'), 'сказали, что не нашли');
  await click(q('.obj-clear') as HTMLElement);
  assert.ok(rowStarting('Площадка ⌀1,9'), 'после сброса поиска дерево вернулось');
}

// --- 3. клик по строке: выделение и перевод вида ---------------------------
{
  const padRow = rowStarting('Площадка ⌀1,9 мм')!;
  await click(padRow);
  assert.match(header(), /^Выделено: 1/, `строка выбрала объект: ${header()}`);
  assert.ok(padRow.className.includes('active'), `строка помечена выделенной: ${padRow.className}`);
  assert.ok((rowExact('Сквозные')!.className).includes('active'), 'раздел с выделенным объектом тоже подсвечен');
  const scale1 = await calib();
  assert.ok(scale1 > scale0 * 1.5, `вид переведён к объекту: ${scale0.toFixed(2)} → ${scale1.toFixed(2)} px/мм`);

  // клик по разделу выделяет весь раздел
  await click(rowExact('Сквозные')!);
  assert.match(header(), /^Выделено: 2/, `раздел выделил обе площадки: ${header()}`);
  await calib();
  await clickWorld(80, 10);   // снимаем выделение
  assert.ok(!header().startsWith('Выделено'), `выделение снято: ${header()}`);
}

// --- 4. «глаз»: скрытый объект нельзя выбрать мышью ------------------------
{
  await calib();
  const padRow = rowStarting('Площадка ⌀1,9 мм')!;
  await click(padRow.querySelector('.obj-eye') as HTMLElement);
  assert.ok(padRow.className.includes('hidden'), `строка помечена скрытой: ${padRow.className}`);
  await clickWorld(20, 30);
  assert.ok(!header().startsWith('Выделено'), `скрытую площадку не выбрать: ${header()}`);
  // вторая площадка по-прежнему выбирается
  await clickWorld(40, 30);
  assert.match(header(), /^Выделено: 1/, `вторая площадка выбирается: ${header()}`);
  // «Показать всё» возвращает объект
  await click(qa('.obj-tools .btn')[0]);
  assert.ok(!rowStarting('Площадка ⌀1,9 мм')!.className.includes('hidden'), 'после «Показать всё» строка снова видима');
  await clickWorld(80, 10);
  await clickWorld(20, 30);
  assert.match(header(), /^Выделено: 1/, `показанную площадку снова можно выбрать: ${header()}`);
}

// --- 5. «замок»: объект виден, но не выбирается ---------------------------
{
  const lockBtn = rowStarting('Площадка ⌀2,5 мм')!.querySelector('.obj-lock') as HTMLElement;
  await click(lockBtn);
  assert.ok(lockBtn.className.includes('off'), `замок у строки включён: ${lockBtn.className}`);
  await clickWorld(80, 10);
  await clickWorld(40, 30);
  assert.ok(!header().startsWith('Выделено'), `заблокированную площадку не выбрать: ${header()}`);
  assert.ok(body().includes('Объект заблокирован'), 'подсказали, что объект под замком');
  // рамка тоже обходит замок: в неё попадает только незаблокированная площадка
  await pointer('pointerdown', 10, 25);
  await pointer('pointermove', 50, 35);
  await pointer('pointerup', 50, 35);
  assert.match(header(), /^Выделено: 1/, `рамка обошла замок: ${header()}`);
}

// --- 6. история правок: список операций и «отменить до операции N» --------
{
  // снимаем замок и двигаем площадку — в истории появляется операция
  await click(rowStarting('Площадка ⌀2,5 мм')!.querySelector('.obj-lock') as HTMLElement);
  await clickWorld(80, 10);
  await clickWorld(20, 30);
  assert.match(header(), /^Выделено: 1/, 'площадка выделена перед переносом');
  await pointer('pointerdown', 20, 30);
  await pointer('pointermove', 25, 30);
  await pointer('pointerup', 25, 30);
  const moved = await savedDoc();
  const at = (d: typeof board, id: string) => d.entities.find((e) => e.id === id) as { x: number; y: number };
  assert.ok(Math.abs(at(moved, 'p1').x - 25) < 0.01, `площадка переехала: ${JSON.stringify(at(moved, 'p1'))}`);

  await key('KeyH', { ctrl: true, shift: true });
  assert.ok(body().includes('История правок'), 'окно истории открылось по Ctrl+Shift+H');
  const hrs = () => qa('.hist-row');
  assert.equal(hrs().length, 2, `шагов в списке: ${hrs().length}`);
  assert.ok((hrs()[0].textContent ?? '').includes('Плата открыта'), 'первая строка — исходное состояние');
  assert.ok((hrs()[1].textContent ?? '').includes('Перемещение объекта'),
    `подпись операции в списке: ${hrs()[1].textContent}`);
  assert.ok(hrs()[1].className.includes('current'), 'текущее состояние подсвечено');
  assert.ok(body().includes('сейчас состояние 1'), 'в шапке видно, где мы находимся');

  // один щелчок — и отменяем сразу до первого состояния
  await click(hrs()[0]);
  const undoBtn = q('.modal .foot .btn.primary') as HTMLElement;
  assert.ok((undoBtn.textContent ?? '').includes('Отменить до операции 0'), `подпись кнопки: ${undoBtn.textContent}`);
  await click(undoBtn);
  const back = await savedDoc();
  assert.ok(Math.abs(at(back, 'p1').x - 20) < 0.01, `отмена вернула площадку: ${JSON.stringify(at(back, 'p1'))}`);
  assert.equal(hrs().length, 2, 'строки истории не потерялись');
  assert.ok(hrs()[1].className.includes('undone'), 'отменённая операция помечена как отменённая');
  assert.ok(body().includes('сейчас состояние 0'), 'мы вернулись к началу');

  // возвращаем отменённую операцию одним щелчком
  await click(hrs()[1]);
  const redoBtn = q('.modal .foot .btn.primary') as HTMLElement;
  assert.ok((redoBtn.textContent ?? '').includes('Вернуть состояние 1'), `подпись кнопки: ${redoBtn.textContent}`);
  await click(redoBtn);
  const fwd = await savedDoc();
  assert.ok(Math.abs(at(fwd, 'p1').x - 25) < 0.01, `повтор вернул операцию: ${JSON.stringify(at(fwd, 'p1'))}`);
  assert.ok(body().includes('сейчас состояние 1'), 'мы снова в конце списка');

  const closeBtn = qa('.modal .foot .btn').pop()!;
  await click(closeBtn);
  assert.ok(!body().includes('История правок'), 'окно истории закрылось');
}

await act(async () => { root.unmount(); });
// jsdom держит цикл кадров — без закрытия окна процесс не завершится сам
dom.window.close();
process.stdout.write(
  'OBJECTS DOM OK: дерево, поиск, выделение, скрытие, замок, история и отмена до операции\n',
  () => process.exit(0),
);
