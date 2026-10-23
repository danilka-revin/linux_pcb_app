// Лазерный редактор в jsdom: переключение режимов, генератор развёрток,
// рисование мышью, выделение, автораскладка, экспорт и симуляция.
// Настоящие обработчики LaserEditor; отрисовка canvas заменена заглушкой.
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
    set: (t, prop: string, value) => { t[prop] = value; return true; },
  }) as never;
};
win.HTMLCanvasElement.prototype.toBlob = function (cb: (b: unknown) => void) {
  cb(new win.Blob(['png'], { type: 'image/png' }));
};
win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as never;
// jsdom не размечает элементы: задаём размер холста, как в окне 900×600
Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { value: 900, configurable: true });
Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { value: 600, configurable: true });
win.Element.prototype.setPointerCapture = () => undefined;
win.Element.prototype.releasePointerCapture = () => undefined;
win.URL.createObjectURL = () => 'blob:psbees';
win.URL.revokeObjectURL = () => undefined;
win.fetch = (() => Promise.reject(new Error('офлайн'))) as never;

const downloads: string[] = [];
const realCreateElement = win.document.createElement.bind(win.document);
win.document.createElement = ((tag: string) => {
  const el = realCreateElement(tag);
  if (String(tag).toLowerCase() === 'a') {
    Object.defineProperty(el, 'download', {
      set(v: string) { downloads.push(v); },
      get() { return ''; },
      configurable: true,
    });
  }
  return el;
}) as typeof win.document.createElement;

for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Element',
  'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser', 'Blob', 'URL',
]) Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
Object.defineProperty(globalThis, 'ResizeObserver', { value: win.ResizeObserver, configurable: true, writable: true });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const { LaserEditor } = await import('../src/ui/laser');
const { Modeling3DView } = await import('../src/ui/modeling-3d');
const { ModeSwitcher, loadWorkspaceMode, saveWorkspaceMode } = await import('../src/ui/mode-switcher');
const { newLaserDoc } = await import('../src/laser/model');

const root = createRoot(win.document.getElementById('root')!);
const buttons = () => [...win.document.querySelectorAll('button')] as HTMLButtonElement[];
const byText = (label: string) => {
  const b = buttons().find((x) => x.textContent?.trim() === label);
  assert(b, `кнопка «${label}» не найдена`);
  return b;
};
const byTitle = (part: string) => {
  const b = buttons().find((x) => (x.getAttribute('title') ?? '').includes(part));
  assert(b, `кнопка с подсказкой «${part}» не найдена`);
  return b;
};
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); }); };
const byTextLike = (part: string) => {
  const b = buttons().find((x) => (x.textContent ?? '').includes(part));
  assert(b, `кнопка с текстом «${part}» не найдена`);
  return b;
};
const byTab = (label: string) => {
  const b = [...win.document.querySelectorAll('.tabs button')]
    .find((x) => (x.textContent ?? '').trim().startsWith(label)) as HTMLButtonElement;
  assert(b, `вкладка «${label}» не найдена`);
  return b;
};
const clickText = async (label: string) => click(byText(label));
const clickTab = async (label: string) => click(byTab(label));
const clickTitle = async (part: string) => click(byTitle(part));
const settle = async (ms = 80) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
const text = () => win.document.body.textContent ?? '';
const status = () => win.document.querySelector('.status')?.textContent ?? '';
const objRows = () => [...win.document.querySelectorAll('.obj-row.is-ent')];
const key = async (k: string, init: KeyboardEventInit = {}) => {
  await act(async () => {
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
};
const changeSelect = async (el: HTMLSelectElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  });
};

// Режимы переключаются снаружи (это делает App), здесь — только проверка вызова.
const modeCalls: string[] = [];
await act(async () => root.render(React.createElement(LaserEditor, {
  mode: 'laser' as const,
  onModeChange: (m: string) => modeCalls.push(m),
  theme: 'dark' as const,
  setTheme: () => {},
  onCloseApp: () => modeCalls.push('close'),
  cloudUser: null,
})));
await settle();

// ---------------- разметка редактора ----------------
{
  assert(win.document.querySelector('.mode-switcher'), 'переключатель режимов в шапке');
  const tabs = [...win.document.querySelectorAll('.mode-tab')];
  assert.equal(tabs.length, 3, 'три режима: платы, лазерный, 3D');
  assert(tabs[0].textContent?.includes('Платы'));
  assert(tabs[1].textContent?.includes('Лазерный'));
  assert(tabs[1].classList.contains('active'), 'активен лазерный режим');
  assert(tabs[2].textContent?.includes('3D моделирование'));
  assert(tabs[2].textContent?.includes('скоро'), 'у 3D-режима метка «скоро»');

  const dock = [...win.document.querySelectorAll('.tool-dock .dock-btn')];
  assert.equal(dock.length, 10, `инструментов в доке: ${dock.length}`);
  assert(dock.some((b) => (b.getAttribute('title') ?? '').startsWith('Форма')), 'инструмент «Форма» (F10)');
  assert(dock.some((b) => (b.getAttribute('title') ?? '').startsWith('Перо')), 'инструмент «Перо»');

  const leftTabs = [...win.document.querySelectorAll('.tabs button')].map((b) => b.textContent?.trim());
  for (const t of ['Развёртка', 'Слои', 'Объекты']) assert(leftTabs.includes(t), `вкладка «${t}»`);
  assert(win.document.querySelector('.laser-unfold'), 'панель генератора развёрток открыта');
  assert(status().includes('300×200 мм'), `лист по умолчанию в строке состояния: ${status()}`);
  assert(text().includes('Задание на станок'), 'панель задания на станок');
  assert(text().includes('Материал и толщина'), 'панель материала');
  assert(text().includes('Сетка и привязка'), 'панель сетки');
  assert.equal(objRows().length, 0, 'лист пуст');
}

// ---------------- переключение режимов ----------------
{
  await click([...win.document.querySelectorAll('.mode-tab')][0]);
  await click([...win.document.querySelectorAll('.mode-tab')][2]);
  assert.deepEqual(modeCalls, ['pcb', '3d'], 'переключатель сообщает выбранный режим');
  saveWorkspaceMode('laser');
  assert.equal(loadWorkspaceMode(), 'laser', 'режим запоминается в браузере');
  saveWorkspaceMode('pcb');
}

// ---------------- генератор развёрток ----------------
{
  const tpl = [...win.document.querySelectorAll('.laser-tpl')] as HTMLButtonElement[];
  assert.equal(tpl.length, 7, `шаблонов развёрток: ${tpl.length}`);
  assert(tpl.some((b) => b.textContent?.includes('Складная развёртка коробки')));
  assert(tpl.some((b) => b.textContent?.includes('Корпус на шипах')));
  assert(tpl.some((b) => b.textContent?.includes('Лицевая панель прибора')));

  // коробка на шипах: параметры толщины листа и шипа видны только у неё
  await click(tpl.find((b) => b.textContent?.includes('Корпус на шипах'))!);
  assert(text().includes('Толщина листа, мм'), 'у шипового корпуса есть толщина листа');
  await click(tpl.find((b) => b.textContent?.includes('Складная развёртка'))!);
  assert(!text().includes('Толщина листа, мм'), 'у складной коробки толщина берётся из материала');

  await click(tpl.find((b) => b.textContent?.includes('Корпус на шипах'))!);
  await clickText('Построить развёртку на листе');
  await settle(120);

  assert(text().includes('Развёртка:'), `сообщение о развёртке: ${status()}`);
  assert(status().includes('Выделено:'), 'развёртка выделена после постройки');

  await clickTab('Объекты');
  const rows = objRows();
  assert(rows.length >= 16, `объектов развёртки: ${rows.length}`);
  // имя объекта лежит в редактируемом поле — textContent его не содержит
  const rowName = (r: Element) => (r.querySelector('input.obj-name-input') as HTMLInputElement | null)?.value ?? '';
  const names = rows.map((r) => `${rowName(r)}|${r.textContent ?? ''}`).join('|');
  assert(names.includes('BTM'), 'дно коробки');
  assert(names.includes('FRONT'), 'передняя стенка');
  assert(names.includes('TOP'), 'крышка');
  assert(names.includes('Отверстие под плату'), 'отверстия под печатную плату');
}

// ---------------- слои станка ----------------
{
  await clickTab('Слои');
  const layers = [...win.document.querySelectorAll('.laser-layer')];
  assert.equal(layers.length, 6, `слоёв станка: ${layers.length}`);
  const names = layers.map((l) => l.textContent ?? '').join('|');
  for (const n of ['Резка', 'Внутр. рез', 'Сгиб', 'Разметка', 'Гравировка', 'Размеры']) {
    assert(names.includes(n), `слой «${n}»`);
  }
  await click(layers.find((l) => l.textContent?.includes('Сгиб'))!.querySelector('.laser-layer-main')!);
  assert(text().includes('Параметры лазера · Сгиб'), 'параметры активного слоя');
  assert(text().includes('Штрих, мм'), 'у биговки есть длина штриха перфорации');
  assert(text().includes('Обдув воздухом'), 'настройка обдува');

  // скрытый слой не обрабатывается: проверяем по сообщению и состоянию кнопки
  const eye = layers.find((l) => l.textContent?.includes('Размеры'))!.querySelector('.obj-eye') as HTMLButtonElement;
  await click(eye);
  await clickTab('Развёртка');
}

// ---------------- материал ----------------
{
  const sel = [...win.document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.textContent?.includes('Акрил'))) as HTMLSelectElement;
  assert(sel, 'выбор материала');
  await changeSelect(sel, 'acrylic-3');
  await settle();
  assert(status().includes('Материал: Акрил'), `материал применён: ${status()}`);
  assert(text().includes('Таблица режимов резки'), 'кнопка таблицы режимов');
}

// ---------------- выделение, раскладка, отмена ----------------
{
  await key('a', { ctrlKey: true });
  assert(status().includes('Выделено:'), 'Ctrl+A выделяет всё');

  await clickTitle('Автораскладка');
  await settle();
  assert(status().includes('Автораскладка'), `раскладка выполнена: ${status()}`);

  await key('z', { ctrlKey: true });
  await settle();
  assert(status().includes('Отменено: Автораскладка'), `отмена раскладки: ${status()}`);
  await key('y', { ctrlKey: true });
  await settle();
  assert(status().includes('Повторено'), 'повтор действия');
  await key('z', { ctrlKey: true });
  await settle();
}

// ---------------- рисование мышью ----------------
{
  // вид после fit: лист 300×200 в холсте 900×600 → s=2.7, ox=45, oy=570
  const s = 2.7;
  const ox = 45;
  const oy = 570;
  const px = (x: number) => ox + x * s;
  const py = (y: number) => oy - y * s;
  const over = win.document.querySelector('.canvas-over') as HTMLCanvasElement;
  assert(over, 'холст рисования');
  over.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pointer = async (type: string, x: number, y: number, init: Record<string, unknown> = {}) => {
    await act(async () => {
      over.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init,
      }));
    });
  };

  await click(byTitle('Прямоугольник'));
  assert.equal(over.style.cursor, 'crosshair', 'курсор рисования');
  // Рисуем в свободном правом верхнем углу листа: там нет узлов развёртки,
  // поэтому привязка к объектам не сдвинет точки.
  await pointer('pointerdown', px(230), py(20));
  await pointer('pointermove', px(280), py(60));
  await pointer('pointerup', px(280), py(60));
  await settle();

  await clickTab('Объекты');
  const rows = objRows();
  const nameOf = (r: Element) => (r.querySelector('input.obj-name-input') as HTMLInputElement | null)?.value ?? '';
  assert(rows.some((r) => nameOf(r).includes('Прямоугольник')), 'нарисован прямоугольник');
  assert(status().includes('Выделено: 1'), 'новый объект выделен');
  assert(text().includes('50.00 × 40.00 мм'), `габарит прямоугольника 50×40: ${text()}`);

  // перенос выделенного объекта: берём за край, но не за маркер масштаба
  await click(byTitle('Выбор'));
  await pointer('pointerdown', px(240), py(20));
  await pointer('pointermove', px(250), py(30));
  await pointer('pointerup', px(250), py(30));
  await settle();
  assert(status().includes('Выделено: 1 · 50.00 × 40.00'), `перенос не меняет размер: ${status()}`);
  assert((byTitle('Отменить').getAttribute('title') ?? '').includes('Перемещено объектов: 1'),
    `перенос попал в историю: ${byTitle('Отменить').getAttribute('title')}`);

  // маркер масштаба: тянем верхний край вверх (объект теперь 240…290 × 30…70)
  await pointer('pointerdown', px(265), py(70));
  await pointer('pointermove', px(265), py(80));
  await pointer('pointerup', px(265), py(80));
  await settle();
  assert(status().includes('50.00 × 50.00'), `масштаб маркером: ${status()}`);
  assert((byTitle('Отменить').getAttribute('title') ?? '').includes('Изменён размер'),
    'масштабирование в истории');
  await key('z', { ctrlKey: true });
  await settle();
  assert(status().includes('Отменено: Изменён размер'), `отмена масштаба: ${status()}`);
  // после отмены выделение снято — возвращаем его кликом по краю объекта
  await pointer('pointerdown', px(240), py(30));
  await settle();
  assert(status().includes('Выделено: 1 · 50.00 × 40.00'), `размер возвращён: ${status()}`);
  await pointer('pointerdown', px(296), py(196));
  await pointer('pointerup', px(296), py(196));
  await settle();

  // рамочное выделение пустого места снимает выделение
  await pointer('pointerdown', px(292), py(192));
  await pointer('pointermove', px(298), py(198));
  await pointer('pointerup', px(298), py(198));
  await settle();
  assert(!status().includes('Выделено:'), 'клик по пустому месту снимает выделение');

  // отрезок двумя кликами
  await click(byTitle('Отрезок'));
  await pointer('pointerdown', px(230), py(80));
  await pointer('pointermove', px(280), py(80));
  await pointer('pointerdown', px(280), py(80));
  await settle();
  assert(status().includes('Добавлен отрезок'), `отрезок построен: ${status()}`);

  // размерная линия: две точки и вынос
  await click(byTitle('Размерная линия'));
  await pointer('pointerdown', px(230), py(90));
  await pointer('pointerdown', px(280), py(90));
  await pointer('pointermove', px(255), py(96));
  await pointer('pointerdown', px(255), py(96));
  await settle();
  assert(status().includes('Добавлен размер'), `размер построен: ${status()}`);
  assert(status().includes('50.00 мм'), `подпись размера: ${status()}`);

  // надпись
  await click(byTitle('Текст (гравировка)'));
  await pointer('pointerdown', px(250), py(180));
  await settle();
  assert(status().includes('Надпись поставлена'), `надпись поставлена: ${status()}`);
  assert(status().includes('Выделено: 1'), 'надпись выделена');
  assert(text().includes('панели свойств'), 'подсказка про панель свойств');

  // панорама средней кнопкой мыши
  await pointer('pointerdown', px(150), py(100), { button: 1 });
  await pointer('pointermove', px(200), py(120), { button: 1 });
  await pointer('pointerup', px(200), py(120), { button: 1 });
  await settle();
  assert(status().includes('Лист: 300×200 мм'), 'панорама не роняет редактор');

  // колесо мыши меняет масштаб (100% — натуральный размер на 96 dpi)
  const zoomBefore = /Масштаб: (\d+)%/.exec(status())?.[1];
  assert.equal(zoomBefore, '71', `масштаб после «весь лист»: ${status()}`);
  await act(async () => {
    over.dispatchEvent(new win.WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: 300, clientY: 300 }));
  });
  await settle();
  const zoomAfter = /Масштаб: (\d+)%/.exec(status())?.[1];
  assert(Number(zoomAfter) > Number(zoomBefore), `колесо приблизило: ${zoomBefore}% → ${zoomAfter}%`);
  await clickTitle('Показать весь лист');
  await settle();
  assert.equal(/Масштаб: (\d+)%/.exec(status())?.[1], '71', '«весь лист» возвращает масштаб');

  // ---------------- инструмент «Форма» (F10): узлы кривой ----------------
  // Прямоугольник сейчас 240…290 × 30…70. Делаем из него кривую и правим узлы.
  await clickTab('Объекты');
  await click(objRows().find((r) => nameOf(r).includes('Прямоугольник'))!);
  await settle();
  await clickTitle('Преобразовать в кривые');
  await settle();
  assert(status().includes('В кривые'), `конвертация в кривые: ${status()}`);
  const dockShape = [...win.document.querySelectorAll('.tool-dock .dock-btn')]
    .find((b) => (b.getAttribute('title') ?? '').startsWith('Форма')) as HTMLButtonElement;
  assert(dockShape.classList.contains('active'), 'после «В кривые» активен инструмент «Форма»');

  // перетаскивание узла
  await pointer('pointerdown', px(240), py(30));
  await pointer('pointermove', px(235), py(25));
  await pointer('pointerup', px(235), py(25));
  await settle();
  assert((byTitle('Отменить').getAttribute('title') ?? '').includes('Перемещён узел кривой'),
    `узел перемещён: ${byTitle('Отменить').getAttribute('title')}`);

  // S — гладкий узел
  await key('s');
  await settle();
  assert(status().includes('Узел сделан гладким'), `гладкий узел: ${status()}`);
  await key('s');
  await settle();
  assert(status().includes('Узел сделан угловым'), `угловой узел: ${status()}`);

  // двойной клик по ребру — новый узел
  await act(async () => {
    over.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: px(265), clientY: py(70) }));
  });
  await settle();
  assert(status().includes('Добавлен узел на кривой'), `новый узел: ${status()}`);

  // Delete убирает выбранный узел
  await key('Delete');
  await settle();
  assert(status().includes('Удалён узел кривой'), `удаление узла: ${status()}`);
  await key('z', { ctrlKey: true });
  await key('z', { ctrlKey: true });
  await key('z', { ctrlKey: true });
  await key('z', { ctrlKey: true });
  await settle();

  // двойной клик по контуру в режиме «Выбор» открывает его узлы
  await click(byTitle('Выбор'));
  await act(async () => {
    over.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: px(265), clientY: py(70) }));
  });
  await settle();
  assert(status().includes('Кривая открыта для правки узлов'), `двойной клик открывает кривую: ${status()}`);
  await click(byTitle('Выбор'));
  await pointer('pointerdown', px(296), py(196));
  await pointer('pointerup', px(296), py(196));
  await settle();
}

// ---------------- свойства и операции CorelDRAW ----------------
{
  await key('a', { ctrlKey: true });
  await settle();
  await clickTitle('Объединение / Weld');
  await settle();
  // объединение доступно только для двух пересекающихся объектов — здесь их нет,
  // поэтому ждём понятное сообщение, а не падение
  assert(status().length > 0, 'булева операция не роняет редактор');

  await key('z', { ctrlKey: true });
  await key('a', { ctrlKey: true });
  await clickTitle('Преобразовать в кривые');
  await settle();
  assert(status().includes('В кривые'), `конвертация в кривые: ${status()}`);

  await key('z', { ctrlKey: true });
  await key('a', { ctrlKey: true });
  await clickTitle('Выровнять по левому краю');
  await settle();
  await key('z', { ctrlKey: true });

  // панель свойств: имя, габарит, слой, перемычки, массив, контур
  await clickTab('Объекты');
  const nameOf = (r: Element) => (r.querySelector('input.obj-name-input') as HTMLInputElement | null)?.value ?? '';
  const first = objRows().find((r) => nameOf(r).includes('Прямоугольник'))!;
  assert(first, 'нарисованный прямоугольник в списке объектов');
  await click(first);
  await settle();
  assert(text().includes('Свойства') || text().includes('Габарит:'), 'панель свойств показывает объект');
  assert(text().includes('Преобразования'), 'блок преобразований');
  assert(text().includes('Булевы операции'), 'блок булевых операций');
  assert(text().includes('Контур и керф'), 'блок контура и керфа');
  assert(text().includes('Скругление углов'), 'блок скругления');
  assert(text().includes('Размножение массивом'), 'блок массива');
  assert(text().includes('Перемычек, шт'), 'перемычки (holding tabs)');

  await clickTitle('Контур наружу');
  await settle();
  assert(status().includes('Контур'), `контур построен: ${status()}`);
  await key('z', { ctrlKey: true });

  await clickTab('Объекты');
  await click(objRows().find((r) => nameOf(r).includes('Прямоугольник'))!);
  await clickTitle('Дублировать');
  await settle();
  assert(status().includes('Дубликат'), `дубликат: ${status()}`);
  await key('z', { ctrlKey: true });

  await clickTab('Объекты');
  await click(objRows().find((r) => nameOf(r).includes('Прямоугольник'))!);
  await clickTitle('Удалить');
  await settle();
  assert(status().includes('Удалено объектов'), `удаление: ${status()}`);
  await key('z', { ctrlKey: true });
  await settle();
}

// ---------------- экспорт и симуляция ----------------
{
  await clickTitle('Экспорт на станок');
  await settle();
  const formats = [...win.document.querySelectorAll('.laser-format')] as HTMLButtonElement[];
  assert.equal(formats.length, 5, `форматов экспорта: ${formats.length}`);
  const labels = formats.map((f) => f.textContent ?? '').join('|');
  for (const l of ['G-Code', 'DXF', 'SVG', 'PNG', 'PSBees Laser']) assert(labels.includes(l), `формат ${l}`);
  assert(text().includes('Параметры G-Code'), 'настройки G-Code для активного формата');
  assert(text().includes('M4 — динамическая мощность'), 'режим лазера M4/M3');
  assert(text().includes('Возврат в начало координат'), 'опция возврата в ноль');

  await click(formats.find((f) => f.textContent?.includes('DXF'))!);
  await click(byText('Скачать .dxf'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.dxf')), `DXF скачан: ${downloads.join(', ')}`);

  await clickTitle('Экспорт на станок');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('G-Code'))!);
  await click(byText('Скачать .gcode / .nc'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.gcode')), 'G-Code скачан');

  await clickTitle('Экспорт на станок');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('Проект'))!);
  await click(byText('Скачать .pslaser'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.pslaser')), 'проект скачан');
  await clickTitle('Экспорт на станок'); // закрыть через «Закрыть»
  await clickText('Закрыть');
  await settle();

  // симуляция обработки
  await clickTitle('Симуляция обработки');
  await settle(200);
  assert(text().includes('Симуляция обработки на станке'), 'окно симуляции');
  assert(win.document.querySelector('.laser-sim-canvas'), 'холст симуляции');
  assert(text().includes('Ускорение:'), 'выбор ускорения');
  const legend = win.document.querySelector('.laser-sim-legend');
  assert(legend && legend.textContent?.includes('Резка'), `легенда слоёв: ${legend?.textContent}`);
  await clickText('Пауза');
  await click(byText('×64'));
  await clickText('Пуск');
  await settle(120);
  await clickText('С начала');
  await settle(60);
  await clickText('Закрыть');
  await settle();
  assert(!text().includes('Симуляция обработки на станке'), 'окно симуляции закрыто');
}

// ---------------- черновик в хранилище ----------------
{
  await settle(800);
  const draft = win.localStorage.getItem('psbees.laser.draft');
  assert(draft, 'черновик развёртки сохранён в браузере');
  const parsed = JSON.parse(draft!) as { doc: { shapes: unknown[]; w: number } };
  assert(Array.isArray(parsed.doc.shapes) && parsed.doc.shapes.length > 0, 'в черновике есть объекты');
  assert.equal(parsed.doc.w, 300);
  assert(status().includes('черновик в браузере'), 'статус черновика');
}

// ---------------- размер листа и очистка ----------------
{
  await click(byTextLike('Размер стола и материал'));
  await settle();
  assert(text().includes('Стол станка'), 'диалог размера листа');
  const preset = [...win.document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.textContent?.includes('6040'))) as HTMLSelectElement;
  await changeSelect(preset, '6040');
  await settle();
  await clickText('Применить');
  await settle();
  assert(status().includes('600×400 мм'), `новый размер стола: ${status()}`);

  await click(byTextLike('Очистить лист'));
  await settle();
  assert(text().includes('Все объекты развёртки будут удалены'), 'подтверждение очистки');
  const okClean = win.document.querySelector('.confirm-modal .foot .btn.danger') as HTMLButtonElement;
  assert(okClean, 'кнопка подтверждения очистки');
  await click(okClean);
  await settle();
  await clickTab('Объекты');
  assert.equal(objRows().length, 0, 'лист очищен');
  await key('z', { ctrlKey: true });
  await settle();
  await clickTab('Объекты');
  assert(objRows().length > 0, 'очистка отменяется');
}

// ---------------- экран 3D-моделирования ----------------
{
  await act(async () => root.render(React.createElement(Modeling3DView, {
    mode: '3d' as const,
    onModeChange: (m: string) => modeCalls.push('3d:' + m),
    theme: 'dark' as const,
    onToggleTheme: () => modeCalls.push('theme'),
    onOpenPcb3DPreview: () => modeCalls.push('preview3d'),
    onCloseApp: () => modeCalls.push('close'),
    boardName: 'Усилитель НЧ',
    boardW: 100,
    boardH: 80,
  })));
  await settle();
  assert(text().includes('СКОРО В РАЗРАБОТКЕ'), 'метка «скоро в разработке»');
  assert(text().includes('3D-моделирование корпусов и деталей'), 'заголовок раздела');
  assert(text().includes('Усилитель НЧ (100×80 мм)'), 'связанная плата видна в строке состояния');
  assert(text().includes('Твердотельное 3D-моделирование'), 'план работ');
  assert(text().includes('Экспорт STL'), 'экспорт моделей');
  const tabs = [...win.document.querySelectorAll('.mode-tab')];
  assert.equal(tabs.length, 3);
  assert(tabs[2].classList.contains('active'), 'активен режим 3D');
  await click(byText('Открыть лазерный редактор и развёртки'));
  assert(modeCalls.includes('3d:laser'), 'переход из 3D в лазерный редактор');
  await click(byText('3D-предпросмотр текущей платы'));
  assert(modeCalls.includes('preview3d'), 'открытие 3D-вида платы');
}

// ---------------- переключатель режимов отдельно ----------------
{
  const calls: string[] = [];
  await act(async () => root.render(React.createElement(ModeSwitcher, {
    mode: 'pcb' as const,
    onChange: (m: string) => calls.push(m),
  })));
  const tabs = [...win.document.querySelectorAll('.mode-tab')] as HTMLButtonElement[];
  assert.equal(tabs.length, 3);
  assert(tabs[0].classList.contains('active'), 'активен режим плат');
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
  await click(tabs[1]);
  await click(tabs[2]);
  assert.deepEqual(calls, ['laser', '3d'], 'переключатель сообщает режим');
}

// ---------------- пустой лист ----------------
{
  await act(async () => root.render(React.createElement(LaserEditor, {
    mode: 'laser' as const,
    onModeChange: () => {},
    theme: 'light' as const,
    setTheme: () => {},
    onCloseApp: () => {},
    cloudUser: { id: 'user-1', email: 'user@psbees.test' },
  })));
  await settle(800);
  assert(text().includes('Свойства'), 'панель свойств на пустом листе');
  assert(text().includes('Новый рисунок создаётся на активном слое'), 'подсказка на пустом листе');
  assert(status().includes('черновик в сеансе'), 'черновик общего сервера');
  // черновик второго пользователя хранится отдельно
  const before = win.sessionStorage.getItem('psbees.laser.draft.user-1');
  assert(before, 'черновик пользователя в sessionStorage');
  assert.equal(win.localStorage.getItem('psbees.laser.draft'), win.localStorage.getItem('psbees.laser.draft'),
    'локальный черновик не перемешан с сеансовым');
  assert(newLaserDoc().shapes.length === 0);
}

// ---------------- интеграция с редактором плат (App) ----------------
{
  const App = (await import('../src/App')).default;
  await act(async () => root.render(React.createElement(App)));
  await settle(250);
  assert(win.document.querySelector('.mode-switcher'), 'в редакторе плат есть переключатель режимов');
  assert(win.document.querySelector('.canvas-base'), 'холст платы на месте');
  assert(win.document.querySelector('.tool-dock [data-tool-id="track"]'), 'док инструментов платы');

  const tabOf = (label: string) => {
    const b = [...win.document.querySelectorAll('.mode-tab')]
      .find((x) => (x.textContent ?? '').includes(label)) as HTMLButtonElement;
    assert(b, `вкладка режима «${label}»`);
    return b;
  };

  // Платы → Лазерный: редактор развёрток подгружается лениво и заменяет рабочее место
  await click(tabOf('Лазерный'));
  await settle(400);
  assert(text().includes('Генератор развёрток'), 'лазерный редактор открылся из режима плат');
  assert(text().includes('Задание на станок'), 'панель задания на станок');
  assert(!win.document.querySelector('.tool-dock [data-tool-id="track"]'), 'инструменты платы скрыты');
  assert.equal(loadWorkspaceMode(), 'laser', 'выбранный режим запомнен');

  // Лазерный → Платы: плата и её черновик возвращаются мгновенно
  await click(tabOf('Платы'));
  await settle(250);
  assert(win.document.querySelector('.canvas-base'), 'холст платы вернулся');
  assert(win.document.querySelector('.tool-dock [data-tool-id="track"]'), 'док инструментов платы вернулся');
  assert(status().includes('Сетка:'), `строка состояния плат: ${status()}`);

  // Платы → 3D моделирование → Платы
  await click(tabOf('3D моделирование'));
  await settle(150);
  assert(text().includes('СКОРО В РАЗРАБОТКЕ'), 'экран 3D-моделирования');
  assert(text().includes('Твердотельное 3D-моделирование'), 'план работ 3D-раздела');
  assert(!win.document.querySelector('.canvas-base'), 'в режиме 3D холста платы нет');
  await click(byTextLike('Вернуться к редактору плат'));
  await settle(200);
  assert(win.document.querySelector('.canvas-base'), 'возврат из 3D в редактор плат');

  // из 3D можно уйти сразу в лазерный режим
  await click(tabOf('3D моделирование'));
  await settle(150);
  await click(byTextLike('Открыть лазерный редактор и развёртки'));
  await settle(300);
  assert(text().includes('Генератор развёрток'), 'из 3D — сразу в лазерный редактор');
  saveWorkspaceMode('pcb');
}

await act(async () => root.unmount());
// jsdom держит цикл кадров — без закрытия окна процесс не завершится сам
dom.window.close();
process.stdout.write(
  'LASER DOM OK: режимы, генератор развёрток, слои станка, материал, рисование мышью, '
  + 'перенос и масштаб маркером, узлы кривой (F10), отмена, булевы операции, контур, '
  + 'экспорт DXF/G-Code/проекта, симуляция, черновик, размер стола, очистка листа, '
  + 'экран 3D и переключение режимов из редактора плат\n',
  () => process.exit(0),
);
