// Окно настроек: реальные обработчики редактора в jsdom.
// Проверяем, что настройки из отдельного окна доходят до редактора и сохраняются.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/', pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;
win.HTMLCanvasElement.prototype.getContext = function () {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get: (t, prop: string) => {
      if (prop in t) return t[prop];
      if (prop === 'measureText') return () => ({ width: 24 });
      if (prop.startsWith('create')) return () => ({ addColorStop: () => undefined });
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

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const App = (await import('../src/App')).default;

const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(App)); });

const doc = win.document;
const frame = () => new Promise((r) => win.requestAnimationFrame(() => r(null)));
const click = async (el: Element | null | undefined, init: MouseEventInit = {}) => {
  assert.ok(el, 'элемент не найден');
  await act(async () => {
    el!.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
    await frame();
  });
};
const key = async (code: string, ctrlKey = false) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { code, ctrlKey, bubbles: true, cancelable: true }));
    await frame();
  });
};
// React следит за value через свой setter: пишем напрямую в прототип, иначе
// onChange не сработает (React решит, что значение не изменилось).
const nativeValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    nativeValue.call(el, value);
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await frame();
  });
};
const byText = (sel: string, text: string): Element | undefined =>
  [...doc.querySelectorAll(sel)].find((el) => (el.textContent ?? '').trim().includes(text));
const prefs = (): Record<string, unknown> => JSON.parse(win.localStorage.getItem('psbees.prefs') ?? '{}');
const defs = (): Record<string, unknown> => JSON.parse(win.localStorage.getItem('lauaut.defs') ?? '{}');

// ---------------------------------------------------------------- окно открывается
const openBtn = () => [...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы'));
assert.ok(openBtn(), 'кнопка настроек в шапке');
await click(openBtn());
let winEl = doc.querySelector('.set-win');
assert.ok(winEl, 'окно настроек открылось кнопкой шапки');
assert.ok(doc.body.contains(winEl!), 'окно настроек вынесено в body (отдельное окно)');
// разделы
const navItems = () => [...doc.querySelectorAll('.set-nav-item')];
assert.equal(navItems().length, 11, 'все разделы настроек на месте');
assert.ok(navItems().some((b) => (b.textContent ?? '').includes('Сетка')), 'раздел сетки');
assert.ok(navItems().some((b) => (b.textContent ?? '').includes('Горячие клавиши')), 'раздел клавиш');

// ---------------------------------------------------------------- интерфейс: компактность
await click(byText('.set-nav-item', 'Интерфейс'));
assert.ok((doc.querySelector('.set-title')?.textContent ?? '').includes('Интерфейс'), 'раздел «Интерфейс»');
await click(byText('.set-chk', 'Компактный интерфейс')?.querySelector('input'));
assert.equal(doc.documentElement.dataset.compact, '1', 'компактный интерфейс включился');
assert.equal(prefs().compactUi, true, 'настройка записана в localStorage');

// ---------------------------------------------------------------- сетка правит редактор
await click(byText('.set-nav-item', 'Сетка и привязка'));
const gridSel = doc.querySelector('.set-content .set-sel') as HTMLSelectElement | null;
assert.ok(gridSel, 'список шагов сетки');
const before = defs().grid;
const opt = [...gridSel!.options].find((o) => o.value === '2.54');
assert.ok(opt, 'шаг 2.54 мм в списке');
await act(async () => {
  gridSel!.value = '2.54';
  gridSel!.dispatchEvent(new win.Event('change', { bubbles: true }));
  await frame();
});
assert.notEqual(defs().grid, before, 'шаг сетки изменился');
assert.equal(defs().grid, 2.54, 'шаг сетки применён к инструментам');
const statusGrid = [...doc.querySelectorAll('.status > span')]
  .find((s) => (s.textContent ?? '').includes('Сетка'));
assert.ok((statusGrid?.textContent ?? '').includes('2.54'), 'строка состояния показывает новый шаг');

// привязка к объектам
await click(byText('.set-chk', 'Привязка к объектам платы')?.querySelector('input'));
assert.equal(defs().snapObj, true, 'привязка к объектам включена');

// ---------------------------------------------------------------- холст: перекрестие
await click(byText('.set-nav-item', 'Холст и курсор'));
const cross = byText('.set-chk', 'Перекрестие по курсору')?.querySelector('input') as HTMLInputElement | null;
assert.ok(cross, 'галочка перекрестия');
await click(cross);
assert.equal(prefs().crosshair, false, 'перекрестие выключено');

// ---------------------------------------------------------------- трассировка (Defs)
await click(byText('.set-nav-item', 'Автотрассировка'));
const content = () => doc.querySelector('.set-content')!;
const numField = (labelText: string): HTMLInputElement | undefined => {
  const row = [...content().querySelectorAll('.set-row')]
    .find((r) => (r.querySelector('.set-row-label')?.textContent ?? '').includes(labelText));
  return row?.querySelector('input') as HTMLInputElement | undefined;
};
const clearInput = numField('Зазор до дорожек и меди');
assert.ok(clearInput, 'поле зазора трассировки');
await type(clearInput!, '0.75');
assert.equal(defs().rtClear, 0.75, 'зазор трассировки записан в настройки инструментов');

// ---------------------------------------------------------------- поиск по настройкам
const search = doc.querySelector('.set-search') as HTMLInputElement;
await act(async () => {
  nativeValue.call(search, 'горяч');
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  await frame();
});
assert.equal(navItems().length, 1, 'поиск оставил один раздел');
assert.ok((navItems()[0].textContent ?? '').includes('Горячие клавиши'));
await act(async () => {
  nativeValue.call(search, '');
  search.dispatchEvent(new win.Event('input', { bubbles: true }));
  await frame();
});

// ---------------------------------------------------------------- закрытие и Ctrl+,
const done = byText('.set-foot .btn', 'Готово');
await click(done);
assert.equal(doc.querySelector('.set-win'), null, 'окно настроек закрылось');

await key('Comma', true);
winEl = doc.querySelector('.set-win');
assert.ok(winEl, 'Ctrl+, открывает настройки');
assert.ok((winEl!.textContent ?? '').includes('Настройки'));

// Esc закрывает окно настроек
await act(async () => {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await frame();
});
assert.equal(doc.querySelector('.set-win'), null, 'Esc закрывает окно настроек');

// ---------------------------------------------------------------- глубина истории из настроек
await key('Comma', true);
await click(byText('.set-nav-item', 'Общие'));
const depth = numField('Шагов отмены');
assert.ok(depth, 'поле глубины истории');
await type(depth!, '7');
assert.equal(prefs().historyDepth, 7, 'глубина истории сохранена');

// ---------------------------------------------------------------- свои горячие клавиши
const hkRow = (title: string): Element | undefined =>
  [...doc.querySelectorAll('.set-hk')].find((r) => (r.querySelector('.set-hk-name')?.textContent ?? '').includes(title));
const hkKeys = (title: string): string[] =>
  [...(hkRow(title)?.querySelectorAll('.hk-chip') ?? [])].map((c) => (c.textContent ?? '').replace('×', '').trim());
const hkBtn = (title: string, name: string): Element | undefined =>
  [...(hkRow(title)?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').includes(name));

await click(byText('.set-nav-item', 'Горячие клавиши'));
assert.ok(doc.querySelector('.set-rec'), 'редактор горячих клавиш');
assert.ok(hkRow('Настройки (это окно)'), 'строка действия «Настройки»');
assert.ok(hkKeys('Настройки (это окно)').includes('Ctrl+,'), 'стандартная клавиша Ctrl+,');
assert.ok(hkRow('Дублировать'), 'строка действия «Дублировать»');

// назначаем Ctrl+J на открытие настроек
await click(hkBtn('Настройки (это окно)', 'Назначить'));
assert.ok(doc.querySelector('.set-rec.on'), 'режим записи включён');
await key('KeyJ', true);
assert.ok(hkKeys('Настройки (это окно)').includes('Ctrl+J'), 'новая клавиша показана в строке');
assert.equal((prefs().hotkeys as Record<string, string[]>)['app.settings'].join('|'), 'Ctrl+J',
  'привязка записана в настройки');

// новая клавиша работает, а старая — уже нет
await click(byText('.set-foot .btn', 'Готово'));
assert.equal(doc.querySelector('.set-win'), null, 'окно закрыто');
await key('Comma', true);
assert.equal(doc.querySelector('.set-win'), null, 'Ctrl+, больше не открывает настройки');
await key('KeyJ', true);
assert.ok(doc.querySelector('.set-win'), 'Ctrl+J открывает настройки');

// занятое сочетание снимается с предыдущего действия
await click(byText('.set-nav-item', 'Горячие клавиши'));
await click(hkBtn('Дублировать', 'Назначить'));
await key('KeyJ', true);
assert.ok(hkKeys('Дублировать').includes('Ctrl+J'), 'Ctrl+J перешло действию «Дублировать»');
assert.ok(!hkKeys('Настройки (это окно)').includes('Ctrl+J'), 'с предыдущего действия клавиша снята');

// сброс возвращает стандартные клавиши
await click(byText('.set-content .btn', 'Сбросить все клавиши'));
assert.ok(hkKeys('Настройки (это окно)').includes('Ctrl+,'), 'после сброса снова Ctrl+,');
assert.equal((prefs().hotkeys as Record<string, string[]>)['app.settings'].join('|'), 'Ctrl+,',
  'сброс записан в настройки');

// второе сочетание добавляется кнопкой «＋», а чип × его снимает
await click(hkBtn('Настройки (это окно)', '＋'));
await key('KeyJ', true);
assert.deepEqual((prefs().hotkeys as Record<string, string[]>)['app.settings'].sort(), ['Ctrl+,', 'Ctrl+J'].sort(),
  'второе сочетание добавлено');
await click(hkRow('Настройки (это окно)')?.querySelectorAll('.hk-chip')[1]?.querySelector('.hk-del'));
assert.equal((prefs().hotkeys as Record<string, string[]>)['app.settings'].join('|'), 'Ctrl+,',
  'чип × снимает одно сочетание');
await click(byText('.set-foot .btn', 'Готово'));

// стандартные клавиши инструментов работают через ту же карту
await key('Digit2');
const dockActive = () => (doc.querySelector('.tool-dock .tb-btn.active')?.getAttribute('title') ?? '');
assert.ok(dockActive().startsWith('Дорожка'), 'цифра 2 включает инструмент «Дорожка»: ' + dockActive());
await key('Digit1');
assert.ok(dockActive().startsWith('Выбор'), 'цифра 1 возвращает «Выбор»: ' + dockActive());

await act(async () => { root.unmount(); });
dom.window.close();
process.stdout.write('SETTINGS DOM OK: окно, разделы, поиск, сетка, привязка, перекрестие, трассировка, свои горячие клавиши, Ctrl+, и Esc\n', () => process.exit(0));
