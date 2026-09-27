// DOM-проверка группировки: клики, рамка и клавиши проходят через настоящие
// обработчики App (не через копию логики). jsdom не умеет canvas и
// ResizeObserver — они подменяются заглушками, как фиктивный 2D-контекст в
// test/grid.ts: проверяется поведение редактора, а не отрисовка.
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

// navigator в Node доступен только на чтение — поэтому defineProperty
for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser', 'Blob',
]) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
}
// App обращается к ResizeObserver как к глобальному имени — он нужен и в globalThis
Object.defineProperty(globalThis, 'ResizeObserver', { value: win.ResizeObserver, configurable: true, writable: true });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// --- плата с тремя площадками; привязка к сетке выключена, шаг 1 мм ---
const board = {
  name: 'Тест групп', w: 100, h: 80,
  entities: [
    { id: 'p1', kind: 'pad', x: 20, y: 30, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p2', kind: 'pad', x: 40, y: 30, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p3', kind: 'pad', x: 60, y: 60, shape: 'round', size: 1.9, drill: 0.9 },
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
/** сохранённая автосейвом плата (App пишет черновик через 400 мс) */
const savedDoc = async () => {
  await act(async () => { await wait(520); });
  return JSON.parse(win.localStorage.getItem('lauaut.autosave')!) as typeof board & {
    groups?: { id: string; name: string; ids: string[] }[];
  };
};
const cursor = () => {
  const spans = qa('.status > span');
  return {
    x: Number(spans[0].querySelectorAll('b')[0].textContent),
    y: Number(spans[1].querySelectorAll('b')[0].textContent),
  };
};

// калибруем соответствие «пиксели холста ↔ миллиметры» по строке состояния:
// вид подгоняется под плату при старте, поэтому считать его руками не нужно
await act(async () => {
  over().dispatchEvent(new win.MouseEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }));
  await frame();
});
const a = cursor();
await act(async () => {
  over().dispatchEvent(new win.MouseEvent('pointermove', { clientX: 100, clientY: 100, bubbles: true }));
  await frame();
});
const b = cursor();
assert.ok(Math.abs(b.x - a.x) > 1, 'строка состояния показывает координаты курсора');
const sx = (b.x - a.x) / 100;      // мм на пиксель по X
const sy = (a.y - b.y) / 100;      // мм на пиксель по Y (ось вверх)
const pxOf = (wx: number) => (wx - a.x) / sx;
const pyOf = (wy: number) => (a.y - wy) / sy;

const pointer = async (
  type: string, wx: number, wy: number, opts: { shift?: boolean; button?: number } = {},
) => {
  await act(async () => {
    over().dispatchEvent(new win.MouseEvent(type, {
      clientX: pxOf(wx), clientY: pyOf(wy), bubbles: true, cancelable: true,
      button: opts.button ?? 0, buttons: type === 'pointerup' ? 0 : 1, shiftKey: !!opts.shift,
    }));
    await frame();
  });
};
const key = async (code: string, opts: { ctrl?: boolean; shift?: boolean } = {}) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', {
      code, bubbles: true, cancelable: true, ctrlKey: !!opts.ctrl, shiftKey: !!opts.shift,
    }));
    await frame();
  });
};

// --- 1. обычный клик выбирает один элемент --------------------------------
await pointer('pointerdown', 20, 30);
await pointer('pointerup', 20, 30);
assert.match(header(), /^Выделено: 1/, `клик по площадке: ${header()}`);
assert.ok(body().includes('Форма'), 'в свойствах видна площадка');

// --- 2. Shift+клик добавляет второй элемент -------------------------------
await pointer('pointerdown', 40, 30, { shift: true });
await pointer('pointerup', 40, 30, { shift: true });
assert.match(header(), /^Выделено: 2/, `Shift+клик: ${header()}`);
assert.ok(body().includes('Сгруппировать'), 'кнопка группировки доступна');

// --- 3. Ctrl+Shift+G создаёт группу --------------------------------------
await key('KeyG', { ctrl: true, shift: true });
assert.match(header(), /^Выделено: 2 · Группа 1/, `после группировки: ${header()}`);
assert.ok(body().includes('Разгруппировать'), 'появилась кнопка разгруппировки');
assert.ok(body().includes('связаны в группу'), 'пояснили, что такое группа');
{
  const d = await savedDoc();
  assert.equal(d.groups?.length, 1, 'группа сохранена в проект');
  assert.deepEqual(d.groups![0].ids, ['p1', 'p2'], 'в группе два выделенных элемента');
}

// --- 4. клик по одному элементу группы выбирает всю группу ----------------
await pointer('pointerdown', 20, 30);
await pointer('pointerup', 20, 30);
assert.match(header(), /^Выделено: 2 · Группа 1/, `клик по элементу группы: ${header()}`);

// --- 5. перетаскивание двигает группу целиком -----------------------------
await pointer('pointerdown', 20, 30);
await pointer('pointermove', 25, 33);
await pointer('pointerup', 25, 33);
{
  const d = await savedDoc();
  const at = (id: string) => d.entities.find((e) => e.id === id) as { x: number; y: number };
  assert.ok(Math.abs(at('p1').x - 25) < 0.01 && Math.abs(at('p1').y - 33) < 0.01,
    `первая площадка переехала: ${JSON.stringify(at('p1'))}`);
  assert.ok(Math.abs(at('p2').x - 45) < 0.01 && Math.abs(at('p2').y - 33) < 0.01,
    `вторая площадка группы переехала вместе с ней: ${JSON.stringify(at('p2'))}`);
  assert.deepEqual({ x: at('p3').x, y: at('p3').y }, { x: 60, y: 60 },
    'площадка вне группы осталась на месте');
}

// --- 6. вкладка «Группы»: список, выделение и роспуск ---------------------
{
  const tab = qa('.tabs button').find((el) => el.textContent === 'Группы');
  assert.ok(tab, 'вкладка «Группы» есть в левой колонке');
  await act(async () => { tab!.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
  assert.ok(body().includes('Группа 1'), 'в списке видна группа');
  assert.ok(body().includes('2 элемента'), 'в списке видно число элементов');

  // разгруппировать кнопкой в строке группы
  const undo = q('.grp .eye') as unknown as HTMLElement;
  assert.ok(undo, 'в строке группы есть кнопка разгруппировки');
  await act(async () => { undo.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); await frame(); });
  assert.ok(body().includes('Групп пока нет'), 'после роспуска список пуст');
  const d = await savedDoc();
  assert.equal(d.groups?.length ?? 0, 0, 'групп в проекте не осталось');
}

// --- 7. после роспуска клик выбирает один элемент -------------------------
// клик по уже выделенному сохраняет выделение (им начинают двигать) —
// поэтому сначала снимаем выделение щелчком в пустое место
await pointer('pointerdown', 80, 10);
await pointer('pointerup', 80, 10);
assert.ok(!header().startsWith('Выделено'), `выделение снято: ${header()}`);
await pointer('pointerdown', 25, 33);
await pointer('pointerup', 25, 33);
assert.match(header(), /^Выделено: 1/, `после разгруппировки: ${header()}`);

// --- 8. группировка рамкой и Ctrl+Shift+U --------------------------------
await pointer('pointerdown', 10, 20);
await pointer('pointermove', 55, 40);
await pointer('pointerup', 55, 40);
assert.match(header(), /^Выделено: 2/, `рамка вокруг двух площадок: ${header()}`);
await key('KeyG', { ctrl: true, shift: true });
assert.match(header(), /· Группа 1/, `рамка + группировка: ${header()}`);

// рамка, задевшая один элемент группы, выбирает группу целиком
await pointer('pointerdown', 80, 10);
await pointer('pointerup', 80, 10);
assert.ok(!header().startsWith('Выделено'), `выделение снято: ${header()}`);
await pointer('pointerdown', 20, 28);
await pointer('pointermove', 30, 38);
await pointer('pointerup', 30, 38);
assert.match(header(), /^Выделено: 2 · Группа 1/, `рамка задела один элемент группы: ${header()}`);

await key('KeyU', { ctrl: true, shift: true });
assert.ok(!header().includes('Группа 1'), `Ctrl+Shift+U распустил группу: ${header()}`);
assert.match(header(), /^Выделено: 2/, 'выделение после роспуска сохранено');

// --- 9. удаление элемента распускает группу из двух ----------------------
await key('KeyG', { ctrl: true, shift: true });
assert.match(header(), /· Группа 1/, 'группа собрана заново');
await key('Delete');
{
  const d = await savedDoc();
  assert.equal(d.groups?.length ?? 0, 0, 'группа из двух распалась после удаления элемента');
  assert.equal(d.entities.filter((e) => e.id === 'p1' || e.id === 'p2').length, 0, 'обе площадки удалены');
  assert.ok(d.entities.some((e) => e.id === 'p3'), 'площадка вне группы цела');
}

await act(async () => { root.unmount(); });
// jsdom держит цикл кадров — без закрытия окна процесс не завершится сам
dom.window.close();
process.stdout.write(
  'GROUP DOM OK: клик/рамка, Ctrl+Shift+G, перенос группы, вкладка «Группы», Ctrl+Shift+U, удаление\n',
  () => process.exit(0),
);
