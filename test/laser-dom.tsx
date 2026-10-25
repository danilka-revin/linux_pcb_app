// Редактор чертежей в jsdom: переключение режимов, генератор развёрток и коробок,
// рисование мышью, выделение, автораскладка, усечение кривых, экспорт и симуляция.
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
const tbGroupLabels = () => [...win.document.querySelectorAll('.tb-group')].map((g) => g.getAttribute('aria-label') ?? '');
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
  assert.equal(tabs.length, 3, 'три режима: платы, чертежи, 3D');
  assert(tabs[0].textContent?.includes('Платы'));
  assert(tabs[1].textContent?.includes('Чертежи'), 'режим векторного редактора называется «Чертежи»');
  assert(tabs[1].classList.contains('active'), 'активен режим чертежей');
  assert(tabs[2].textContent?.includes('3D моделирование'));
  assert(tabs[2].textContent?.includes('скоро'), 'у 3D-режима метка «скоро»');

  const dock = [...win.document.querySelectorAll('.tool-dock .dock-btn')];
  assert.equal(dock.length, 12, `инструментов в доке: ${dock.length}`);
  assert(dock.some((b) => (b.getAttribute('title') ?? '').startsWith('Форма')), 'инструмент «Форма» (F10)');
  assert(dock.some((b) => (b.getAttribute('title') ?? '').startsWith('Перо')), 'инструмент «Перо»');
  const dockAux = win.document.querySelector('.tool-dock [data-tool-id="aux"]');
  assert(dockAux, 'инструмент «Вспомогательная линия» в доке');
  assert((dockAux!.getAttribute('title') ?? '').startsWith('Вспомогательная линия (A)'),
    `подсказка инструмента вспомогательных линий: ${dockAux!.getAttribute('title')}`);
  for (const want of ['перпендикуляр', 'параллель', 'касательная', 'биссектриса']) {
    assert((dockAux!.getAttribute('title') ?? '').toLowerCase().includes(want),
      `в подсказке вспомогательных линий упомянут «${want}»`);
  }
  assert(!win.document.querySelector('.laser-auxbar'), 'панель построения показывается только с инструментом');
  const dockTrim = win.document.querySelector('.tool-dock [data-tool-id="trim"]');
  assert(dockTrim, 'инструмент «Усечь кривую» в доке');
  assert((dockTrim!.getAttribute('title') ?? '').startsWith('Усечь кривую'),
    `подсказка инструмента усечения: ${dockTrim!.getAttribute('title')}`);
  assert(!win.document.querySelector('.laser-trimbar'), 'панель режимов усечения показывается только с инструментом');

  const leftTabs = [...win.document.querySelectorAll('.tabs button')].map((b) => b.textContent?.trim());
  // у вкладок может быть счётчик: «Слои (1)» — сравниваем имена без него
  assert.deepEqual(leftTabs.map((t) => (t ?? '').split(' (')[0]), ['Объекты', 'Слои'],
    `вкладки левой панели: ${leftTabs}`);
  assert(win.document.querySelector('.obj-tree'), 'по умолчанию открыта вкладка «Объекты»');
  // генератор развёрток вынесен из левой панели в отдельное окно тулбара
  assert(!win.document.querySelector('.laser-unfold'), 'панели развёрток в левой панели нет');
  // кнопки слоя в шапке больше нет: слой выбирают во вкладке «Слои»
  assert(!win.document.querySelector('.tb-btn.cu'), 'в шапке нет кнопки активного слоя');
  assert(!tbGroupLabels().includes('Активный слой'), 'подписи активного слоя в шапке нет');
  const tbTitles = buttons().map((b) => b.getAttribute('title') ?? '');
  assert(tbTitles.some((t) => t.startsWith('Генератор развёрток')), 'кнопка генератора развёрток в тулбаре');
  assert(tbTitles.some((t) => t.startsWith('Генератор коробок')), 'кнопка генератора коробок в тулбаре');
  // генераторы подписаны текстом, а коробки живут в собственной группе тулбара
  const boxesBtn = buttons().find((b) => b.dataset.action === 'boxes');
  assert(boxesBtn, 'кнопка коробок помечена data-action="boxes"');
  assert(boxesBtn!.textContent?.includes('Коробки'), `подпись кнопки коробок: ${boxesBtn!.textContent}`);
  assert(boxesBtn!.closest('.tb-group')?.getAttribute('aria-label') === 'Генератор коробок',
    'коробки — отдельная группа тулбара');
  const unfoldBtn = buttons().find((b) => b.dataset.action === 'unfold');
  assert(unfoldBtn!.textContent?.includes('Развёртка'), `подпись кнопки развёрток: ${unfoldBtn!.textContent}`);
  // строка состояния чертёжного редактора: формат, объекты, слой и длина — без станочных чисел
  assert(status().includes('Слой: Слой 1'), `активный слой в строке состояния: ${status()}`);
  assert(!status().includes('мм/с'), `в строке состояния нет скорости: ${status()}`);
  assert(status().includes('300×200 мм'), `лист по умолчанию в строке состояния: ${status()}`);
  assert(text().includes('Лист и чертёж'), 'панель листа и чертежа');
  assert(text().includes('Длина контуров'), 'в сводке листа длина контуров чертежа');
  assert(text().includes('Сетка и привязка'), 'панель сетки');
  // станочная часть интерфейса скрыта (см. src/laser/features.ts)
  assert(!text().includes('Задание на станок'), 'панель задания на станок скрыта');
  assert(!text().includes('Материал и толщина'), 'таблица материалов скрыта');
  assert(!buttons().some((b) => (b.getAttribute('title') ?? '').includes('Симуляция')),
    'кнопка симуляции обработки скрыта');
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

// ---------------- генератор развёрток (отдельное окно) ----------------
{
  await clickTitle('Генератор развёрток');
  await settle(150);
  assert(win.document.querySelector('.unfold-win'), 'окно генератора развёрток открылось');
  assert(win.document.querySelector('.unfold-win .laser-unfold'), 'параметры развёртки внутри окна');

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
  await settle(200);
  assert(win.document.querySelector('.unfold-win-preview svg'), 'в окне показан предпросмотр развёртки');
  const statsText = win.document.querySelector('.unfold-win-stats')?.textContent ?? '';
  assert(statsText.includes('Объектов') && statsText.includes('Длина контуров'),
    `сводка развёртки в окне: ${statsText}`);

  await clickText('Перенести на лист');
  await settle(200);
  assert(!win.document.querySelector('.unfold-win'), 'окно закрылось после переноса');
  assert(status().includes('помещена на лист'), `сообщение о развёртке: ${status()}`);
  assert(status().includes('Выделено:'), 'развёртка выделена после постройки');

  await clickTab('Объекты');
  const rows = objRows();
  assert(rows.length >= 16, `объектов развёртки: ${rows.length}`);
  // имя объекта лежит в редактируемом поле — textContent его не содержит
  const rowName = (r: Element) => (r.querySelector('input.obj-name-input') as HTMLInputElement | null)?.value ?? '';
  const names = rows.map((r) => `${rowName(r)}|${r.textContent ?? ''}`).join('|');
  // Шиповой корпус строит общий движок коробок — детали подписаны по-русски
  assert(names.includes('Дно'), 'дно коробки');
  assert(names.includes('Стенка передняя'), 'передняя стенка');
  assert(names.includes('Крышка'), 'крышка');
  assert(names.includes('подпись'), 'детали подписаны гравировкой');
  assert(names.includes('Отверстие под плату'), 'отверстия под печатную плату');
}

// ---------------- свои слои чертежа ----------------
{
  await clickTab('Слои');
  assert(text().includes('Слои чертежа'), 'панель слоёв чертежа');
  // имя слоя теперь в редактируемом поле — textContent строки его не содержит
  const layerName = (l: Element) =>
    (l.querySelector('input.laser-layer-name') as HTMLInputElement | null)?.value ?? '';
  const rowsOf = () => [...win.document.querySelectorAll('.laser-layer')];
  const byName = (n: string) => rowsOf().find((l) => layerName(l) === n);

  assert(rowsOf().length >= 2, `слоёв чертежа: ${rowsOf().length}`);
  const names = rowsOf().map(layerName).join('|');
  assert(names.includes('Слой 1'), 'первый слой по умолчанию «Слой 1»');
  // развёртка принесла свои слои: линии сгиба и подписи легли на новые слои
  assert(names.includes('Слой 2'), `слой линий сгиба из развёртки: ${names}`);
  // имя служебного слоя для проверки видимости берём из фактического списка
  const otherName = layerName(rowsOf()[rowsOf().length - 1]!);

  await click(byName('Слой 1')!);
  assert(text().includes('Слой · Слой 1'), 'свойства активного слоя');
  assert(text().includes('Тип линии'), 'тип линии слоя');
  assert(text().includes('Цвет слоя'), 'палитра цвета слоя');
  assert(win.document.querySelectorAll('.laser-swatch').length >= 6, 'образцы цвета слоя');
  // мощность, скорость, проходы, керф и обдув — станочные параметры, они скрыты
  for (const gone of ['Параметры лазера', 'Мощность, %', 'Скорость, мм/с', 'Проходов', 'Керф, мм', 'Обдув воздухом']) {
    assert(!text().includes(gone), `станочный параметр слоя «${gone}» скрыт`);
  }

  // свой слой: добавить, назвать, удалить
  const before = rowsOf().length;
  await click(byText('Слой'));
  await settle();
  assert.equal(rowsOf().length, before + 1, 'кнопка «Слой» добавила слой');
  const added = rowsOf()[rowsOf().length - 1]!;
  assert.equal(layerName(added), `Слой ${before + 1}`, 'новый слой получил имя по порядку');
  const nameInput = added.querySelector('input.laser-layer-name') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'Отверстия');
  nameInput.dispatchEvent(new win.Event('input', { bubbles: true }));
  await settle();
  assert.equal(layerName(rowsOf()[rowsOf().length - 1]!), 'Отверстия', 'свой слой переименован');
  await click(rowsOf()[rowsOf().length - 1]!.querySelector('.obj-del') as HTMLButtonElement);
  await settle();
  assert.equal(rowsOf().length, before, 'свой слой удалён');
  assert(!rowsOf().map(layerName).includes('Отверстия'), 'удалённого слоя в списке нет');
  // последний слой удалить нельзя — кнопка неактивна только в этом случае
  assert(!(rowsOf()[0]!.querySelector('.obj-del') as HTMLButtonElement).disabled,
    'удаление слоя доступно, пока слоёв больше одного');

  // видимость слоя переключается и видна в списке
  const eyeOf = () => byName(otherName)!.querySelector('.obj-eye') as HTMLButtonElement;
  await click(eyeOf());
  await settle();
  assert(eyeOf().className.includes('off'), 'скрытый слой помечен в списке');
  await click(byText('Показать все'));
  await settle();
  assert(!eyeOf().className.includes('off'), '«Показать все» вернула видимость слою');
  await clickTab('Объекты');
}

// ---------------- толщина материала ----------------
{
  // Пресеты режимов резки скрыты, но толщина нужна генераторам развёрток и коробок.
  const th = [...win.document.querySelectorAll('.field')].find((f) =>
    f.querySelector('label')?.textContent?.trim() === 'Толщина, мм');
  assert(th, 'поле толщины материала в панели «Лист и чертёж»');
  const input = th!.querySelector('input') as HTMLInputElement;
  assert.ok(Number(input.value) > 0, `толщина материала задана: ${input.value}`);
  assert(!text().includes('Таблица режимов резки'), 'таблица режимов резки скрыта');
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

  // инструмент не выключается сам: можно рисовать подряд, V или Esc — к выбору
  const rectBtn = () => win.document.querySelector('.tool-dock [data-tool-id="rect"]') as HTMLButtonElement;
  assert(rectBtn().classList.contains('active'), 'после фигуры инструмент «Прямоугольник» остался активным');

  // клик без протяжки создаёт объект заданного по умолчанию размера, а не «ничего»
  await pointer('pointerdown', px(60), py(40));
  await pointer('pointerup', px(60), py(40));
  await settle();
  assert(status().includes('Добавлен объект: Прямоугольник'), `клик без протяжки создал объект: ${status()}`);
  // у нового объекта свой id: он не «слипается» с уже нарисованным прямоугольником
  assert(status().includes('Выделено: 1 · 20.00 × 20.00'),
    `выделен ровно новый квадрат 20×20: ${status()}`);
  await key('z', { ctrlKey: true });
  await settle();
  assert(status().includes('Отменено: Добавлен объект'), `отмена убрала проверочный квадрат: ${status()}`);
  // отмена снимает выделение — возвращаем его первому прямоугольнику.
  // Кликаем по его нижнему краю: у незаполненной фигуры попадание считается
  // по контуру, а не по площади.
  await click(byTitle('Выбор'));
  await pointer('pointerdown', px(240), py(20));
  await pointer('pointerup', px(240), py(20));
  await settle();
  assert(status().includes('Выделено: 1 · 50.00 × 40.00'), `выделение возвращено: ${status()}`);

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
  await click(byTitle('Текст (надпись)'));
  await pointer('pointerdown', px(250), py(180));
  await settle();
  assert(status().includes('Надпись поставлена'), `надпись поставлена: ${status()}`);
  assert(status().includes('Выделено: 1'), 'надпись выделена');
  assert(text().includes('панели свойств'), 'подсказка про панель свойств');

  // ---------------- вспомогательные линии ----------------
  // Координаты кликов держим точными: Alt временно отключает привязку, иначе
  // узлы развёртки сдвинут точки и геометрию построения не проверить.
  const noSnap = { altKey: true };

  // окружность одним кликом: 20 мм с центром в точке клика (260; 15)
  await click(byTitle('Эллипс / дуга'));
  await pointer('pointerdown', px(260), py(15), noSnap);
  await pointer('pointerup', px(260), py(15), noSnap);
  await settle();
  assert(status().includes('Добавлен объект: Эллипс'), `окружность по клику: ${status()}`);
  assert(status().includes('Выделено: 1 · 20.00 × 20.00'), `окружность 20×20: ${status()}`);

  await click(byTitle('Вспомогательная линия'));
  await settle();
  assert(win.document.querySelector('.laser-auxbar'), 'панель построения вспомогательных линий');
  const auxModes = [...win.document.querySelectorAll('.laser-auxbar button[data-aux-mode]')] as HTMLButtonElement[];
  assert.equal(auxModes.length, 8, `режимов построения: ${auxModes.length}`);
  const auxNames = auxModes.map((b) => b.textContent ?? '').join('|');
  for (const want of ['Перпендикуляр', 'Параллель', 'Касательная', 'По углу', 'Серединный перпендикуляр',
    'Биссектриса', 'Горизонталь', 'Вертикаль']) {
    assert(auxNames.includes(want), `режим «${want}» в панели построения`);
  }
  const auxBtn = (id: string) => win.document.querySelector(`.laser-auxbar button[data-aux-mode="${id}"]`) as HTMLButtonElement;
  const auxOn = () => auxBtn(auxOnId()).dataset.auxMode;
  const auxOnId = () => (win.document.querySelector('.laser-auxbar button[data-aux-mode].on') as HTMLButtonElement).dataset.auxMode ?? '';
  assert.equal(auxOn(), 'perp', 'по умолчанию выбран перпендикуляр');
  assert(win.document.querySelector('.aux-field input.txt'), 'поле параметров построения');
  assert(text().includes('на весь лист'), 'режим «на весь лист»');
  assert(text().includes('Длина, мм'), 'длина вспомогательной линии настраивается');

  // касательной без объекта не бывает — редактор объясняет, что делать
  await click(auxBtn('tangent'));
  await pointer('pointerdown', px(295), py(195), noSnap);
  await settle();
  assert(status().includes('объект-базу'), `понятная подсказка про базу: ${status()}`);

  // касательная к окружности: клик по верхней точке обвода, затем внешняя точка
  await pointer('pointerdown', px(260), py(25), noSnap);
  await settle();
  assert(status().includes('База — «Эллипс»'), `окружность принята за базу: ${status()}`);
  await pointer('pointermove', px(295), py(25), noSnap);
  await pointer('pointerdown', px(295), py(25), noSnap);
  await settle();
  assert(status().includes('Вспомогательная: касательная от «Эллипс»'), `касательная построена: ${status()}`);
  const tanBox = /Выделено: 1 · ([\d.]+) × ([\d.]+) мм/.exec(status());
  assert(tanBox, `габарит касательной в статусе: ${status()}`);
  assert.equal(tanBox![1], '300.00', 'касательная растянута на всю ширину листа');
  assert(Number(tanBox![2]) < 10, `касательная идёт почти вдоль клика, а не наискосок: ${tanBox![2]} мм`);

  // горизонталь одним кликом
  await click(auxBtn('h'));
  await pointer('pointerdown', px(250), py(170), noSnap);
  await settle();
  assert(status().includes('Вспомогательная: горизонталь'), `горизонталь построена: ${status()}`);
  assert(status().includes('300.00 × 0.00'), `горизонталь на весь лист: ${status()}`);

  // перпендикуляр без базы — к отрезку между двумя кликами
  await click(auxBtn('perp'));
  await pointer('pointerdown', px(240), py(10), noSnap);
  await settle();
  assert(status().includes('База не найдена'), `подсказка, когда базы нет: ${status()}`);
  await pointer('pointermove', px(270), py(10), noSnap);
  await pointer('pointerdown', px(270), py(10), noSnap);
  await settle();
  assert(status().includes('Вспомогательная: перпендикуляр'), `перпендикуляр построен: ${status()}`);
  assert(status().includes('0.00 × 200.00'), `перпендикуляр — вертикаль на весь лист: ${status()}`);

  // цифры переключают режимы, Esc отменяет незаконченное построение
  await key('2');
  await settle();
  assert.equal(auxOn(), 'parallel', 'клавиша 2 включила режим «Параллель»');
  assert(text().includes('Расстояние, мм'), 'у параллели задаётся расстояние');
  await key('5');
  await settle();
  assert.equal(auxOn(), 'midperp', 'клавиша 5 включила серединный перпендикуляр');
  await pointer('pointerdown', px(200), py(100), noSnap);
  await settle();
  assert(win.document.querySelector('.laser-auxbar .btn.tiny'), 'кнопка отмены незаконченного построения');
  assert(text().includes('2 клика: 1 сделано'), `панель показывает, сколько кликов сделано: ${text().match(/\d клика[^A-Z]*/)?.[0]}`);
  await key('Escape');
  await settle();
  assert(status().includes('Построение вспомогательной линии отменено'), `Esc отменил построение: ${status()}`);

  // вспомогательные линии живут на своём служебном слое и не идут в экспорт
  await clickTab('Слои');
  const layerNames = () => [...win.document.querySelectorAll('.laser-layer input.laser-layer-name')]
    .map((i) => (i as HTMLInputElement).value);
  const auxRow = [...win.document.querySelectorAll('.laser-layer')]
    .find((l) => (l.querySelector('input.laser-layer-name') as HTMLInputElement)?.value === 'Вспомогательные');
  assert(auxRow, `служебный слой вспомогательных линий: ${layerNames().join(', ')}`);
  await click(auxRow!);
  await settle();
  assert(text().includes('Служебная'), 'слой вспомогательных линий — служебный, в файлы не выводится');
  // клик по строке слоя делает его активным — возвращаем рабочий слой, иначе
  // новые объекты попали бы на служебный
  const workRow = [...win.document.querySelectorAll('.laser-layer')]
    .find((l) => (l.querySelector('input.laser-layer-name') as HTMLInputElement)?.value === 'Слой 1');
  assert(workRow, 'рабочий слой «Слой 1» на месте');
  await click(workRow!);
  await settle();
  assert(status().includes('Слой: Слой 1'), `рабочий слой снова активен: ${status()}`);
  await clickTab('Объекты');
  await click(byTitle('Выбор'));
  await settle();

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

// ---------------- инструмент «Усечь кривую» (X) ----------------
{
  // вид не менялся: лист 300×200 в холсте 900×600 → s=2.7, ox=45, oy=570
  const s = 2.7;
  const ox = 45;
  const oy = 570;
  const px = (x: number) => ox + x * s;
  const py = (y: number) => oy - y * s;
  const over = win.document.querySelector('.canvas-over') as HTMLCanvasElement;
  over.getBoundingClientRect = () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  const pointer = async (type: string, x: number, y: number, init: Record<string, unknown> = {}) => {
    await act(async () => {
      over.dispatchEvent(new win.MouseEvent(type, {
        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y, ...init,
      }));
    });
  };
  // Кнопки ищем по data-tool-id: в подсказке «Отменить» встречается текст последнего
  // действия («…Отрезок · часть 1»), и поиск по заголовку задел бы его.
  const dockTool = (id: string) => {
    const b = win.document.querySelector(`.tool-dock [data-tool-id="${id}"]`) as HTMLButtonElement;
    assert(b, `инструмент «${id}» в доке`);
    return b;
  };
  const drawLine = async (x1: number, y1: number, x2: number, y2: number) => {
    await click(dockTool('line'));
    await pointer('pointerdown', px(x1), py(y1));
    await pointer('pointermove', px(x2), py(y2));
    await pointer('pointerdown', px(x2), py(y2));
    await settle();
  };
  const trimModeBtn = (mode: string) =>
    win.document.querySelector(`.laser-trimbar [data-trim-mode="${mode}"]`) as HTMLButtonElement;

  await clickTab('Объекты');
  const restored = objRows().length;
  assert(restored > 0, 'перед проверкой усечения на листе есть объекты');

  // Чистим лист: резать нужно предсказуемую геометрию. Очистка отменяется,
  // в конце блока всё возвращается назад.
  await click(byTextLike('Очистить лист'));
  await settle();
  await click(win.document.querySelector('.confirm-modal .foot .btn.danger')!);
  await settle();
  assert.equal(objRows().length, 0, 'лист очищен');

  // Крест из двух отрезков: горизонталь y=60 от 20 до 280, вертикаль x=150 от 20 до 180.
  await drawLine(20, 60, 280, 60);
  await drawLine(150, 20, 150, 180);
  assert.equal(objRows().length, 2, 'нарисованы два отрезка');

  // включаем инструмент усечения (горячая клавиша X)
  await key('x');
  await settle();
  assert(win.document.querySelector('.tool-dock [data-tool-id="trim"].active'), 'инструмент «Усечь кривую» активен');
  assert(win.document.querySelector('.laser-trimbar'), 'панель режимов усечения видна');
  assert.equal(win.document.querySelectorAll('.laser-trimbar [data-trim-mode]').length, 3, 'три режима');
  assert(trimModeBtn('trim').classList.contains('on'), 'по умолчанию режим «Усечь»');
  const hint = () => win.document.querySelector('.laser-tool-hint')?.textContent ?? '';
  assert(hint().includes('Усечь кривую'), `подсказка инструмента: ${hint()}`);
  assert(hint().includes('режется по пересечениям'), `подсказка режима «Усечь»: ${hint()}`);

  // предпросмотр под курсором: подсвечен кусок и точки пересечений
  await pointer('pointermove', px(220), py(60));
  await settle();

  // клик справа от пересечения — правый кусок горизонтали уходит
  await pointer('pointerdown', px(220), py(60));
  await pointer('pointerup', px(220), py(60));
  await settle();
  assert(status().includes('Усечено'), `усечение выполнено: ${status()}`);
  assert(status().includes('130.00'), `остался кусок 20…150 мм: ${status()}`);
  assert.equal(objRows().length, 2, 'один отрезок заменён одним куском');
  assert((byTitle('Отменить').getAttribute('title') ?? '').includes('Усечено'),
    `усечение попало в историю: ${byTitle('Отменить').getAttribute('title')}`);

  // режим «Продлить» (клавиша 2): конец кривой дотягивается до края стола
  await key('2');
  await settle();
  assert(trimModeBtn('extend').classList.contains('on'), 'режим «Продлить» включён');
  assert(hint().includes('дотягивается до границы'), `подсказка режима «Продлить»: ${hint()}`);
  await pointer('pointerdown', px(20), py(60));
  await pointer('pointerup', px(20), py(60));
  await settle();
  assert(status().includes('продлена на 20.00'), `добор до края листа: ${status()}`);
  assert(status().includes('150.00'), `кривая теперь 0…150 мм: ${status()}`);

  // режим «Разрезать» (клавиша 3): вертикаль делится в точке клика
  await click(trimModeBtn('break'));
  await settle();
  assert(trimModeBtn('break').classList.contains('on'), 'режим «Разрезать» включён');
  assert(hint().includes('делится в точке клика'), `подсказка режима «Разрезать»: ${hint()}`);
  await pointer('pointerdown', px(150), py(120));
  await pointer('pointerup', px(150), py(120));
  await settle();
  assert(status().includes('разрезана на 2'), `кривая разрезана: ${status()}`);
  assert.equal(objRows().length, 3, 'стало три объекта');

  // «границы — выделенные»: режем только по выделенным объектам
  await key('1');
  await settle();
  assert(trimModeBtn('trim').classList.contains('on'), 'режим «Усечь» вернулся');
  await key('v');
  await settle();
  // после разреза выделены оба куска: снимаем выделение кликом по пустому месту
  await pointer('pointerdown', px(250), py(150));
  await pointer('pointerup', px(250), py(150));
  await settle();
  assert(!status().includes('Выделено:'), `выделение снято: ${status()}`);
  // нижний кусок вертикали пересекает горизонталь в середине — им и займёмся
  await pointer('pointerdown', px(150), py(80));
  await pointer('pointerup', px(150), py(80));
  await settle();
  assert(status().includes('Выделено: 1 · 0.00 × 100.00'), `кусок вертикали выделен: ${status()}`);

  await key('x');
  await settle();
  const onlySel = win.document.querySelector('.laser-trimbar .laser-check input') as HTMLInputElement;
  assert(onlySel, 'переключатель «границы — выделенные»');
  await click(onlySel);
  await settle();
  assert(onlySel.checked, 'ограничение границ включено');
  await pointer('pointerdown', px(150), py(80));
  await pointer('pointerup', px(150), py(80));
  await settle();
  assert(status().includes('усекать нечем'), `границы ограничены выделением: ${status()}`);
  assert.equal(objRows().length, 3, 'объекты не изменились');

  // сняли ограничение — тот же клик режет кусок по горизонтали
  await click(onlySel);
  await settle();
  assert(!onlySel.checked, 'ограничение границ снято');
  await pointer('pointerdown', px(150), py(80));
  await pointer('pointerup', px(150), py(80));
  await settle();
  assert(status().includes('Усечено'), `усечение по всем границам: ${status()}`);
  assert(status().includes('40.00'), `остался кусок 20…60 мм: ${status()}`);

  // клик мимо кривой ничего не ломает
  await pointer('pointerdown', px(250), py(150));
  await pointer('pointerup', px(250), py(150));
  await settle();
  assert(status().includes('Кликните по кривой'), `подсказка при промахе: ${status()}`);
  assert(status().includes('Лист: 300×200 мм'), 'редактор жив');

  // «Разбить по пересечениям» — Ctrl+Shift+X по всему листу
  await drawLine(60, 20, 60, 180);
  assert.equal(objRows().length, 4, 'добавлена пересекающая вертикаль');
  // инструмент рисования больше не выключается сам — к выбору возвращаемся V
  assert(win.document.querySelector('.tool-dock [data-tool-id="line"].active'),
    'после отрезка инструмент «Отрезок» остался активным');
  await key('v');
  await settle();
  await pointer('pointerdown', px(250), py(150));
  await pointer('pointerup', px(250), py(150));
  await settle();
  assert(!status().includes('Выделено:'), 'выделение снято — разбивается весь лист');
  await key('X', { ctrlKey: true, shiftKey: true });
  await settle();
  assert(status().includes('Разбито по пересечениям: 2'), `разбивка по пересечениям: ${status()}`);
  assert.equal(objRows().length, 6, 'две пересекающиеся кривые дали четыре');

  // возвращаем лист: отменяем всё, что сделали в этом блоке
  for (let i = 0; i < 16 && objRows().length !== restored; i++) {
    await key('z', { ctrlKey: true });
    await settle(10);
  }
  assert.equal(objRows().length, restored, `лист восстановлен отменой: ${objRows().length} из ${restored}`);
  await click(dockTool('select'));
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
  assert(text().includes('Контур (Contour)'), 'блок контура');
  assert(text().includes('Скругление углов'), 'блок скругления');
  assert(text().includes('Усечь кривую (Trim)'), 'блок инструмента усечения');
  assert(buttons().some((b) => b.textContent?.trim() === 'Разбить по пересечениям'), 'кнопка разбивки по пересечениям');
  assert(text().includes('Размножение массивом'), 'блок массива');
  // удерживающие перемычки и керф — станочные поля, в чертёжном редакторе их нет
  assert(!text().includes('Перемычек, шт'), 'поле перемычек скрыто');
  assert(!text().includes('Керф, мм'), 'поле керфа скрыто');

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

// ---------------- экспорт чертежа ----------------
{
  await clickTitle('Экспорт чертежа');
  await settle();
  assert(text().includes('Экспорт чертежа'), 'диалог экспорта чертежа');
  const formats = [...win.document.querySelectorAll('.laser-format')] as HTMLButtonElement[];
  assert.equal(formats.length, 6, `форматов экспорта: ${formats.length}`);
  const labels = formats.map((f) => f.textContent ?? '').join('|');
  for (const l of ['DXF', 'PDF 1:1 мм', 'EPS / PostScript', 'PLT (HPGL/2)', 'SVG', 'Проект PSBees']) {
    assert(labels.includes(l), `формат ${l}`);
  }
  // станочные форматы из диалога убраны
  assert(!labels.includes('G-Code'), 'G-Code скрыт');
  assert(!labels.includes('PNG'), 'PNG-чертёж скрыт');
  // обмен с CorelDRAW объяснён прямо в диалоге
  assert(text().includes('Обмен с CorelDRAW'), 'подсказка про обмен с CorelDRAW');
  assert(text().includes('.cdr закрытый'), 'объяснение, почему .cdr не читается');
  assert(!text().includes('Параметры G-Code'), 'настроек G-Code в диалоге нет');
  assert(text().includes('Длина контуров'), 'в сводке экспорта длина контуров, а не время обработки');
  assert(!text().includes('Время'), 'станочное время в сводке не показывается');

  // DXF — основной формат вывода и открыт по умолчанию: настройки, план, контроль
  await settle();
  assert(text().includes('Параметры DXF'), 'панель настроек DXF в диалоге экспорта');
  const splits = [...win.document.querySelectorAll('[data-dxf-split]')] as HTMLButtonElement[];
  assert.equal(splits.length, 2, 'режимы вывода DXF: один файл и архив по слоям');
  assert(splits[0].className.includes('active'), 'по умолчанию DXF одним файлом');
  const planRows = () => [...win.document.querySelectorAll('.laser-dxf-row')]
    .map((r) => (r.querySelector('b')?.textContent ?? '').trim());
  assert.ok(planRows().length >= 1, `план слоёв DXF: ${planRows().length}`);
  // в плане свои слои чертежа: имена транслитом, как их примет AutoCAD
  assert.ok(planRows().includes('SLOY_1'), `в плане свой слой чертежа: ${planRows().join(', ')}`);
  assert.ok(planRows().every((t) => /^[A-Z0-9_]+$/.test(t)),
    `имена слоёв DXF латиницей и без пробелов: ${planRows().join(', ')}`);
  const dxfField = (label: string) => {
    const f = [...win.document.querySelectorAll('.laser-dxf-opts .field')]
      .find((x) => x.querySelector('label')?.textContent === label);
    assert(f, `поле «${label}» в параметрах DXF`);
    return f!.querySelector('select') as HTMLSelectElement;
  };
  await changeSelect(dxfField('Версия'), 'R12');
  await changeSelect(dxfField('Сущности'), 'lines');
  await changeSelect(dxfField('Ноль координат'), 'bbox');
  await settle(420);
  assert(text().includes('Контроль точности'), 'живой контроль точности DXF');
  assert(/отклонение до \d/.test(text()), 'в контроле показано отклонение в мм');
  const footBtn = () => win.document.querySelector('.laser-export-dialog .foot .btn.primary') as HTMLButtonElement;
  assert.equal(footBtn().textContent?.trim(), 'Скачать .dxf', `кнопка скачивания: ${footBtn().textContent}`);
  await click(footBtn());
  await settle();
  assert(downloads.some((d) => d.endsWith('.dxf')), `DXF скачан: ${downloads.join(', ')}`);

  // тот же чертёж отдельными файлами по слоям — архивом ZIP
  await clickTitle('Экспорт чертежа');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('DXF'))!);
  await settle();
  assert.equal(dxfField('Версия').value, 'R12', 'настройки DXF сохранены между открытиями');
  await click(win.document.querySelector('[data-dxf-split="layers"]')!);
  await settle();
  const fileRows = [...win.document.querySelectorAll('.laser-dxf-row')]
    .map((r) => (r.querySelector('b')?.textContent ?? '').trim());
  assert.ok(fileRows.every((t) => t.endsWith('.dxf')) && fileRows.length >= 1,
    `список файлов архива: ${fileRows.join(', ')}`);
  assert(/^Скачать \.zip \(\d+ × \.dxf\)$/.test((footBtn().textContent ?? '').trim()),
    `кнопка архива: ${footBtn().textContent}`);
  await click(footBtn());
  await settle();
  assert(downloads.some((d) => d.endsWith('.zip')), `архив DXF по слоям скачан: ${downloads.join(', ')}`);
  assert(status().includes('DXF по слоям'), `сообщение о разбивке: ${status()}`);
  // возвращаем режим «один файл», чтобы следующие проверки скачивали именно .dxf
  await clickTitle('Экспорт чертежа');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('DXF'))!);
  await click(win.document.querySelector('[data-dxf-split="single"]')!);
  await settle();
  assert.equal(footBtn().textContent?.trim(), 'Скачать .dxf', 'режим одного файла возвращён');

  await clickTitle('Экспорт чертежа');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('SVG'))!);
  await settle();
  assert(!text().includes('Параметры DXF'), 'панель настроек DXF показана только для DXF');
  await click(byText('Скачать .svg'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.svg')), `SVG скачан: ${downloads.join(', ')}`);

  // форматы обмена с CorelDRAW: PDF, EPS и PLT — тот же чертёж в масштабе 1:1
  const fmtCard = (t: string) => {
    const f = [...win.document.querySelectorAll('.laser-format')]
      .find((x) => (x.textContent ?? '').includes(t)) as HTMLButtonElement;
    assert(f, `карточка формата «${t}»`);
    return f;
  };

  await clickTitle('Экспорт чертежа');
  await settle();
  await click(fmtCard('PDF 1:1 мм'));
  await settle();
  assert(text().includes('Параметры векторного файла'), 'параметры векторных форматов');
  assert(text().includes('Слои чертежа как слои PDF (OCG)'), 'опция слоёв PDF');
  assert(!text().includes('Параметры DXF'), 'настройки DXF не показываются для PDF');
  await click(byText('Скачать .pdf'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.pdf')), `PDF скачан: ${downloads.join(', ')}`);
  assert(status().includes('PDF сохранён'), `сообщение о PDF: ${status()}`);
  assert(status().includes('слоями PDF'), 'в сообщении упомянуты слои PDF');

  await clickTitle('Экспорт чертежа');
  await settle();
  await click(fmtCard('EPS / PostScript'));
  await settle();
  await click(byText('Скачать .eps'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.eps')), `EPS скачан: ${downloads.join(', ')}`);
  assert(status().includes('EPS сохранён'), `сообщение о EPS: ${status()}`);

  await clickTitle('Экспорт чертежа');
  await settle();
  await click(fmtCard('PLT (HPGL/2)'));
  await settle();
  assert(text().includes('Допуск аппроксимации кривых'), 'допуск аппроксимации для PLT');
  assert(text().includes('Отдельное перо на каждый слой'), 'перья плоттера для PLT');
  assert(text().includes('40 юнитов HPGL на миллиметр'), 'единицы HPGL объяснены');
  await click(byText('Скачать .plt'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.plt')), `PLT скачан: ${downloads.join(', ')}`);
  assert(status().includes('HPGL/2'), `сообщение о PLT: ${status()}`);

  await clickTitle('Экспорт чертежа');
  await settle();
  await click([...win.document.querySelectorAll('.laser-format')].find((f) => f.textContent?.includes('Проект'))!);
  await click(byText('Скачать .psdraw'));
  await settle();
  assert(downloads.some((d) => d.endsWith('.psdraw')), 'проект скачан как .psdraw');
  await clickTitle('Экспорт чертежа'); // закрыть через «Закрыть»
  await clickText('Закрыть');
  await settle();

  // станочная симуляция в интерфейс не выводится
  assert(!buttons().some((b) => (b.getAttribute('title') ?? '').includes('Симуляция обработки')),
    'кнопки симуляции обработки нет');
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
  await click(byTextLike('Размер листа и название'));
  await settle();
  assert(text().includes('Формат листа'), 'диалог размера листа');
  assert(!text().includes('Материал'), 'выбор станочного материала в диалоге скрыт');
  // в чертёжном режиме пресеты — форматы листа (A4…A1 и свои размеры), а не столы станков
  const preset = [...win.document.querySelectorAll('select')].find((s) =>
    [...s.options].some((o) => o.value === '600x400')) as HTMLSelectElement;
  assert(preset, 'в диалоге есть выбор формата листа');
  assert(!text().includes('6040'), 'станочных столов в списке форматов нет');
  await changeSelect(preset, '600x400');
  await settle();
  await clickText('Применить');
  await settle();
  assert(status().includes('600×400 мм'), `новый размер листа: ${status()}`);

  await click(byTextLike('Очистить лист'));
  await settle();
  assert(text().includes('Все объекты чертежа будут удалены'), 'подтверждение очистки');
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

// ---------------- студия коробок (каталог генераторов) ----------------
{
  await clickTab('Объекты');
  const before = objRows().length;

  await click(byTitle('Генератор коробок'));
  await settle(250);
  assert(win.document.querySelector('.box-studio'), 'модальное окно студии коробок');
  assert(text().includes('Универсальная коробка'), 'первый генератор каталога');

  // каталог: карточки с миниатюрами и фильтр по семействам
  const cards = [...win.document.querySelectorAll('.bs-card')] as HTMLButtonElement[];
  assert.equal(cards.length, 28, `карточек каталога: ${cards.length}`);
  assert(cards.every((c) => c.querySelector('svg polyline')), 'у каждой карточки миниатюра');
  assert(cards.some((c) => c.classList.contains('active')), 'выбранный тип подсвечен');

  const families = [...win.document.querySelectorAll('.bs-families button')] as HTMLButtonElement[];
  assert(families.length >= 7, `фильтров семейства: ${families.length}`);
  await click(families.find((b) => b.textContent?.includes('Лотки'))!);
  await settle(80);
  const trays = [...win.document.querySelectorAll('.bs-card')] as HTMLButtonElement[];
  assert(trays.length >= 3 && trays.length < cards.length, `в семействе «Лотки» ${trays.length} генераторов`);

  // поиск по каталогу
  const search = win.document.querySelector('.bs-search') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(search, 'ящик');
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
  await settle(80);
  const found = [...win.document.querySelectorAll('.bs-card')] as HTMLButtonElement[];
  assert(found.length >= 1 && found.length < trays.length, `поиск «ящик»: ${found.length}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!.call(search, '');
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
  });
  await settle(80);

  // выбираем выдвижной ящик: форма параметров и 3D-сборка пересчитываются
  const drawer = ([...win.document.querySelectorAll('.bs-card')] as HTMLButtonElement[])
    .find((c) => c.textContent?.includes('Выдвижной ящик'))!;
  assert(drawer, 'генератор выдвижного ящика');
  await click(drawer);
  await settle(200);
  assert(win.document.querySelector('.bs-canvas svg polygon'), '3D-сборка отрисована');
  assert(win.document.querySelectorAll('.bs-group').length >= 2, 'параметры разбиты по разделам');
  assert(text().includes('Деталей'), 'статистика раскладки');
  assert(text().includes('Рез'), 'длина реза в статистике');

  // тонкие настройки раскрываются
  const more = win.document.querySelector('.bs-more') as HTMLButtonElement | null;
  if (more) {
    const groupsBefore = win.document.querySelectorAll('.bs-group').length;
    await click(more);
    await settle(120);
    assert(win.document.querySelectorAll('.bs-group').length >= groupsBefore, 'тонкие настройки добавили разделы');
  }

  // переключение на раскладку 2D
  await click([...win.document.querySelectorAll('.bs-viewswitch button')].find((b) => b.textContent?.includes('Раскладка'))!);
  await settle(150);
  assert(win.document.querySelector('.bs-canvas svg polyline'), '2D-раскладка отрисована');
  assert(win.document.querySelector('.bs-canvas svg .bs-sheet'), 'контур листа в раскладке');

  // DXF скачивается прямо из студии, без помещения на лист
  const foot = [...win.document.querySelectorAll('.box-studio .foot .btn')] as HTMLButtonElement[];
  const dxfBtn = foot.find((b) => b.textContent?.includes('DXF'))!;
  assert(dxfBtn, 'кнопка DXF в студии');
  downloads.length = 0;
  await click(dxfBtn);
  await settle(250);
  assert(downloads.some((d) => d.endsWith('.dxf')), `DXF скачан: ${downloads.join(', ')}`);
  assert(status().includes('DXF сохранён'), `сообщение об экспорте: ${status()}`);

  // помещаем раскладку на лист
  await click(foot.find((b) => b.textContent?.includes('Поместить на лист'))!);
  await settle(300);
  assert(!win.document.querySelector('.box-studio'), 'студия закрылась после применения');
  await clickTab('Объекты');
  assert(objRows().length > before, `детали коробки на листе: ${objRows().length} против ${before}`);
  assert(status().includes('помещены на лист'), `сообщение о применении: ${status()}`);

  // открывается с клавиатуры и закрывается по Esc
  await key('b', { ctrlKey: true });
  await settle(200);
  assert(win.document.querySelector('.box-studio'), 'студия открывается по Ctrl+B');
  await key('Escape');
  await settle(150);
  assert(!win.document.querySelector('.box-studio'), 'Esc закрывает студию');

  await click(byTextLike('Очистить лист'));
  await settle();
  await click(win.document.querySelector('.confirm-modal .foot .btn.danger') as HTMLButtonElement);
  await settle(120);
}

// ---------------- генератор коробок в отдельном окне ----------------
{
  // Окно открывается из шапки программы и работает со своим листом: коробку
  // можно собрать и забрать в DXF, не заходя в редактор чертежей. Закрывает
  // окно и принимает раскладку хозяин (App), поэтому проверяем его вызовы.
  const { BoxWindow } = await import('../src/ui/box-window');
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  const boxRoot = createRoot(host);
  const placed: { shapes: unknown[]; title: string }[] = [];
  let closeCalls = 0;
  await act(async () => boxRoot.render(React.createElement(BoxWindow, {
    onPlace: (p: { shapes: unknown[]; title: string }) => { placed.push(p); },
    onClose: () => { closeCalls += 1; },
  })));
  await settle(300);
  assert(win.document.querySelector('.box-studio'), 'окно генератора коробок открылось');
  assert.equal([...win.document.querySelectorAll('.bs-card')].length, 28, 'каталог окна: 28 генераторов');
  const foot = () => [...win.document.querySelectorAll('.box-studio .foot .btn')] as HTMLButtonElement[];
  assert(foot().some((b) => b.textContent?.includes('Перенести в рисовалку')), 'кнопка переноса в рисовалку');

  downloads.length = 0;
  await click(foot().find((b) => b.textContent?.trim() === 'DXF')!);
  await settle(300);
  assert(downloads.some((d) => d.endsWith('.dxf')), `DXF из отдельного окна: ${downloads.join(', ')}`);
  assert(win.document.querySelector('.box-win-msg'), 'сообщение окна показано своей плашкой');

  await click(foot().find((b) => b.textContent?.includes('Перенести в рисовалку'))!);
  await settle(250);
  assert.equal(placed.length, 1, 'раскладка передана хозяину окна');
  assert(placed[0].shapes.length > 0, 'в раскладке есть детали');
  assert.equal(closeCalls, 1, 'окно просит хозяина закрыться после переноса');

  await click(foot().find((b) => b.textContent?.trim() === 'Закрыть')!);
  await settle(120);
  assert.equal(closeCalls, 2, 'кнопка «Закрыть» сообщает хозяину окна');

  await act(async () => boxRoot.unmount());
  host.remove();
  assert(!win.document.querySelector('.box-studio'), 'окно убрано из DOM');
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
  await click(byText('Открыть редактор чертежей и развёртки'));
  assert(modeCalls.includes('3d:laser'), 'переход из 3D в редактор чертежей');
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

  // Платы → Чертежи: векторный редактор подгружается лениво и заменяет рабочее место
  await click(tabOf('Чертежи'));
  await settle(400);
  // подпись генератора развёрток живёт в подсказке кнопки тулбара: сама панель
  // вынесена в отдельное окно и в тексте страницы её больше нет
  assert(buttons().some((b) => (b.getAttribute('title') ?? '').includes('Генератор развёрток')),
    'редактор чертежей открылся из режима плат');
  assert(win.document.querySelector('[data-action="unfold"]'), 'кнопка генератора развёрток в тулбаре чертежей');
  assert(text().includes('Лист и чертёж'), 'панель листа и чертежа');
  assert(!text().includes('Задание на станок'), 'станочное задание не показывается');
  assert(!win.document.querySelector('.tool-dock [data-tool-id="track"]'), 'инструменты платы скрыты');
  assert.equal(loadWorkspaceMode(), 'laser', 'выбранный режим запомнен');

  // Чертежи → Платы: плата и её черновик возвращаются мгновенно
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

  // из 3D можно уйти сразу в режим чертежей
  await click(tabOf('3D моделирование'));
  await settle(150);
  await click(byTextLike('Открыть редактор чертежей и развёртки'));
  await settle(300);
  assert(buttons().some((b) => (b.getAttribute('title') ?? '').includes('Генератор развёрток')),
    'из 3D — сразу в редактор чертежей');

  // окно коробок открывается из тулбара рисовалки и переносит раскладку на лист
  const boxFoot = () => [...win.document.querySelectorAll('.box-studio .foot .btn')] as HTMLButtonElement[];
  await click(byTitle('Генератор коробок'));
  await settle(400);
  assert(win.document.querySelector('.box-studio'), 'окно коробок открылось из рисовалки');
  assert(boxFoot().some((b) => b.textContent?.includes('Перенести в рисовалку')), 'кнопка переноса в окне');
  await click(boxFoot().find((b) => b.textContent?.includes('Перенести в рисовалку'))!);
  await settle(500);
  assert(!win.document.querySelector('.box-studio'), 'окно закрылось после переноса');
  assert(status().includes('помещены на лист'), `раскладка из окна на листе: ${status()}`);
  await clickTab('Объекты');
  assert(objRows().length > 0, `детали коробки в дереве объектов: ${objRows().length}`);

  // в шапке редактора плат кнопки «Коробки» нет: генератор открывается только
  // из тулбара редактора чертежей и там же переносит раскладку на лист
  await click(tabOf('Платы'));
  await settle(300);
  assert(win.document.querySelector('.canvas-base'), 'вернулись в редактор плат');
  const boxesInToolbar = buttons().find((b) => (b.getAttribute('title') ?? '').includes('Генератор коробок'));
  assert(!boxesInToolbar, 'в тулбаре редактора плат нет кнопки «Коробки»');
  assert(!win.document.querySelector('.box-studio'), 'окно коробок в режиме плат закрыто');
  assert(!text().includes('>Коробки<'), 'подписи «Коробки» в шапке плат нет');
  saveWorkspaceMode('pcb');
}

await act(async () => root.unmount());
// jsdom держит цикл кадров — без закрытия окна процесс не завершится сам
dom.window.close();
process.stdout.write(
  'LASER DOM OK: режимы (платы / чертежи / 3D), отдельные окна генераторов развёрток и коробок, '
  + 'свои слои чертежа (добавить, назвать, удалить, видимость, цвет), толщина листа, '
  + 'рисование мышью, '
  + 'перенос и масштаб маркером, узлы кривой (F10), усечение кривых (X: усечь/продлить/разрезать, '
  + 'границы по выделению, разбивка по пересечениям), отмена, булевы операции, контур, '
  + 'экспорт: настройки DXF в диалоге (версия, сущности, ноль координат), план слоёв файла, '
  + 'контроль точности, разбивка по слоям в ZIP, форматы обмена с CorelDRAW (PDF, EPS, PLT), '
  + 'SVG и проект .psdraw, черновик, '
  + 'отдельное окно генератора коробок (кнопка в тулбаре редактора чертежей, в шапке плат её нет, '
  + 'перенос раскладки на лист), '
  + 'размер листа, очистка листа, '
  + 'студия коробок (каталог 28 типов, поиск, 3D-сборка, раскладка, DXF, помещение на лист), '
  + 'экран 3D и переключение режимов из редактора плат\n',
  () => process.exit(0),
);
