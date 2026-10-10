// SSR-дым: приложение и панель деталей собираются на сервере без ошибок.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
import { COLORS, setCanvasTheme } from '../src/pcb/render';
import { GenPanel, MacroTree, genSpecText } from '../src/ui/genpanel';
import { addMacro, buildTree, createFolder, emptyStore, makeMacro } from '../src/pcb/userlib';
import { generate } from '../src/pcb/gen';
import { LibPreviewDialog } from '../src/ui/libpreview';
import { PropsPanel, type Defs } from '../src/ui/panels';
import { GroupsPanel } from '../src/ui/groups';
import { AutoPlaceDialog, RouteVariantsDialog } from '../src/ui/auto-layout';
import { NetsPanel } from '../src/ui/nets';
import type { Doc, Entity } from '../src/pcb/model';

const html = renderToString(createElement(App));
console.log('SSR длина:', html.length);
if (!html.includes('toolbar') || !html.includes('status')) throw new Error('layout not rendered');
if (!html.includes('Bees')) throw new Error('brand not rendered');
if (!html.includes('logo.png')) throw new Error('bee logo not rendered');
if (!html.includes('светлую тему') && !html.includes('тёмную тему')) throw new Error('theme toggle not rendered');
// Тест цепи: отдельный прозрачный слой между платой и интерактивным оверлеем.
{
  const base = html.indexOf('class="canvas-base"');
  const probe = html.indexOf('class="canvas-probe"');
  const over = html.indexOf('class="canvas-over"');
  if (!(base >= 0 && base < probe && probe < over)) throw new Error('probe canvas stacking order');
  if (html.includes('canvas-probe is-active')) throw new Error('probe must not blink before selection');
  const css = readFileSync('src/styles.css', 'utf8');
  if (!/\.canvas-base, \.canvas-probe\s*\{\s*pointer-events: none/.test(css)) {
    throw new Error('probe canvas must not intercept pointer events');
  }
  if (!/\.canvas-probe\.is-active\s*\{\s*animation: probe-blink 1s steps\(1, end\) infinite/.test(css)) {
    throw new Error('probe must blink once per second');
  }
  if (!/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.canvas-probe\.is-active\s*\{\s*animation: none; opacity: 1/.test(css)) {
    throw new Error('reduced motion must keep the probe visible without blinking');
  }
  for (const [theme, color] of [['dark', '#c45cff'], ['light', '#9333ea']] as const) {
    setCanvasTheme(theme);
    if (COLORS.probe !== color || COLORS.probe === COLORS.sel) throw new Error(`${theme}: probe must be purple, not selection yellow`);
  }
  setCanvasTheme('dark');
}

// сетка и панель деталей должны быть в разметке (проверка, что интерфейс подключён)
const must = [
  'Настроить сетку',        // выбор шага в тулбаре + диалог
  'Привязка',               // быстрая панель сетки
  '50 mil',                 // подписи шагов в двух системах
  'Детали',                  // вкладка генератора и моей библиотеки
];
for (const m of must) if (!html.includes(m)) throw new Error(`не найдено в разметке: ${m}`);
// на сервере localStorage нет — панель не должна падать и не должна выдумывать детали
if (html.includes('gen-fail')) throw new Error('SSR: панель деталей ушла в состояние ошибки');

// быстрые действия стоят сразу после стрелок undo/redo, а кнопка закрытия закреплена справа
{
  const toolbarOrder = [
    'Отменить (Ctrl+Z)', 'Повторить (Ctrl+Y)', 'upd-btn',
    'Конструктор интерфейса', 'Настроить цвета интерфейса', 'Закрыть приложение / сайт',
  ];
  let prev = -1;
  for (const m of toolbarOrder) {
    const at = html.indexOf(m);
    if (at < 0 || at <= prev) throw new Error(`шапка: «${m}» отсутствует или стоит не после undo/redo`);
    prev = at;
  }
}
{
  const css = readFileSync('src/styles.css', 'utf8');
  const tbAt = css.indexOf('.toolbar {');
  const toolbar = css.slice(tbAt, css.indexOf('}', tbAt));
  if (/overflow:\s*hidden/.test(toolbar) || !/overflow-x:\s*auto/.test(toolbar)) {
    throw new Error('шапка: .toolbar снова режет себя overflow:hidden — кнопки в хвосте исчезнут');
  }
  const stick = css.slice(css.indexOf('.toolbar > .tb-group:last-child'), css.indexOf('}', css.indexOf('.toolbar > .tb-group:last-child')));
  if (!/position:\s*sticky/.test(stick)) throw new Error('шапка: хвост тулбара не прилипает к правому краю');
  const brAt = css.indexOf('.brand {');
  const brand = css.slice(brAt, css.indexOf('}', brAt));
  if (!/flex:\s*0 1 auto/.test(brand)) throw new Error('шапка: бренд не сжимается — при нехватке места пострадают кнопки');
}

// Старая конфигурация (порядок без undo/about и скрытая справка) не должна
// убирать новые быстрые кнопки: недостающие группы дописываются, undo закреплена.
{
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
  localStorage.setItem('lauaut.ui', JSON.stringify({
    ids: ['file', 'grid', 'view'],
    hidden: ['undo', 'about'],
  }));
  const html2 = renderToString(createElement(App));
  for (const m of ['upd-btn', 'Конструктор интерфейса', 'Настроить цвета интерфейса', 'Закрыть приложение / сайт']) {
    if (!html2.includes(m)) throw new Error(`старые настройки спрятали «${m}»`);
  }
  // группы, появившиеся в новой версии, дописываются в конец (а не пропадают)
  for (const m of ['Активный слой: верхняя медь', 'Генератор деталей (I)']) {
    if (!html2.includes(m)) throw new Error(`старый порядок групп спрятал новую группу: ${m}`);
  }
  delete (globalThis as any).localStorage;
}

// предпросмотр платы — одна кнопка в шапке, а не три: режимы 2D и 3D
// выбираются переключателем (правая узкая часть), окно общее
{
  const count = (needle: string) => html.split(needle).length - 1;
  if (count('tb-split') !== 1) throw new Error('в шапке должна быть одна кнопка-переключатель предпросмотра');
  for (const m of ['split-main', 'split-caret', 'Выбрать режим предпросмотра: 2D или 3D']) {
    if (!html.includes(m)) throw new Error(`кнопка предпросмотра: не найдено «${m}»`);
  }
  // режимы живут в меню переключателя — отдельных кнопок 2D/3D в шапке нет
  for (const m of ['title="2D предпросмотр — Sprint Layout"', 'title="3D предпросмотр — объёмная плата"']) {
    if (html.includes(m)) throw new Error(`в шапке осталась отдельная кнопка: ${m}`);
  }
  // подсказка основной части показывает режим, который откроется
  if (!html.includes('title="Предпросмотр платы: 2D — Sprint Layout"')) {
    throw new Error('кнопка предпросмотра не подсказывает текущий режим');
  }
  const css = readFileSync('src/styles.css', 'utf8');
  if (!/\.tb-split\s*\{[^}]*display:\s*flex/.test(css)) throw new Error('нет стилей кнопки-переключателя');
}

// быстрые кнопки — отдельные действия, а не пункты скрытого меню
{
  const app = readFileSync('src/App.tsx', 'utf8');
  for (const m of ['Конструктор интерфейса', 'Настроить цвета интерфейса', 'window.close()', 'window.psbees.closeApp()']) {
    if (!app.includes(m)) throw new Error(`не найдено действие тулбара: ${m}`);
  }
}

// панель генератора с готовой деталью и деревом папок
const gen = generate('dip 8 m3 подписи');
if (!gen.ok) throw new Error('SSR: dip 8 m3 подписи не собралось');
const folder = createFolder(emptyStore(), 'Корпуса');
const spec = genSpecText(gen);
const macro = makeMacro('DIP-8', gen.els, {
  query: 'dip 8 m3', spec, note: gen.notes.join(' '), folderId: folder.folders[0].id, bl: gen.bl,
});
const store = addMacro(folder, macro);
const pane = renderToString(createElement(GenPanel, {
  query: 'dip 8 m3', onQuery: () => {}, gen: generate('dip 8 m3'), store,
  onPlace: () => {}, onPreview: () => {}, onSave: () => {}, onNewFolder: () => {},
}));
for (const m of ['Опишите деталь', 'Поставить на плату', 'Справка', '+ папка', 'Параметры']) {
  if (!pane.includes(m)) throw new Error(`панель генератора: не найдено «${m}»`);
}
if (!pane.includes('lib-spec')) throw new Error('панель генератора: нет паспорта детали');

// дерево папок и деталей
const tree = renderToString(createElement(MacroTree, {
  store, tree: buildTree(store, ''), pickedId: null,
  onPick: () => {}, onPreview: () => {}, onEdit: () => {}, onRename: () => {}, onDelete: () => {},
  onMove: () => {}, onNewFolder: () => {}, onRenameFolder: () => {}, onDeleteFolder: () => {},
  collapsed: new Set<string>(), toggle: () => {}, filter: '', onFilter: () => {},
  onExport: () => {}, onImport: () => {},
}));
for (const m of ['Корпуса', 'DIP-8', 'mtree']) {
  if (!tree.includes(m)) throw new Error(`дерево библиотеки: не найдено «${m}»`);
}

// окно предпросмотра детали
const pv = renderToString(createElement(LibPreviewDialog, {
  title: 'DIP-8', spec: genSpecText(gen), note: 'ключ сверху слева', els: gen.els,
  onAdd: () => {}, onClose: () => {},
}));
for (const m of ['lib-preview', 'DIP-8', '0;0']) {
  if (!pv.includes(m)) throw new Error(`окно предпросмотра: не найдено «${m}»`);
}
// группировка элементов: кнопки в шапке, вкладка «Группы», горячие клавиши
{
  for (const m of ['Сгруппировать', 'Разгруппировать', 'Ctrl+Shift+G', 'Ctrl+Shift+U', 'Группы']) {
    if (!html.includes(m)) throw new Error(`группировка: в шапке/колонках не найдено «${m}»`);
  }
  const app = readFileSync('src/App.tsx', 'utf8');
  // клавиши задаются настройками (src/ui/hotkeys.ts): в редакторе осталась
  // только привязка сочетания к действию, а не жёстко прописанный switch
  for (const m of [
    "case 'edit.group': groupSel(); return;",
    "case 'edit.ungroup': ungroupSel(); return;",
    'expandSelection(doc.groups, ns)',
    'nd.groups = pruneGroups(nd.groups',
  ]) {
    if (!app.includes(m)) throw new Error(`группировка: в App.tsx нет «${m}»`);
  }
  const css = readFileSync('src/styles.css', 'utf8');
  for (const m of ['.groups-pane', '.grp {', '.grp-name', '.group-box']) {
    if (!css.includes(m)) throw new Error(`нет стилей группировки: ${m}`);
  }
}

// панель свойств: блок группы у выделенной группы и кнопка группировки без группы
{
  const ents: Entity[] = [
    { id: 'p1', kind: 'pad', x: 5, y: 5, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p2', kind: 'pad', x: 10, y: 5, shape: 'round', size: 1.9, drill: 0.9 },
  ];
  const doc: Doc = {
    name: 'Тест', w: 40, h: 30, entities: ents,
    groups: [{ id: 'g1', name: 'Узел А', ids: ['p1', 'p2'] }],
  };
  const base = {
    tool: 'select' as const, defs: { grid: 1.27 } as Defs, setDefs: () => {},
    activeCu: 'k1' as const, setActiveCu: () => {}, selEnts: ents, patchEnt: () => {},
    doRotate: () => {}, doMirror: () => {}, doDuplicate: () => {}, doDelete: () => {},
    doc, setDocSize: () => {}, placeRot: 0, placeSide: 'top' as const,
    setPlaceRot: () => {}, setPlaceSide: () => {}, cancelPlace: () => {},
    textRot: 0, setTextRot: () => {}, onRenameGroup: () => {},
  };
  const withGroup = renderToString(createElement(PropsPanel, {
    ...base, selGroup: doc.groups![0], onUngroup: () => {},
  }));
  // «Выделено: 2 · Узел А» — React разделяет текстовые узлы комментариями, поэтому без числа
  for (const m of ['Узел А', 'Разгруппировать', 'связаны в группу', 'Выделено: ']) {
    if (!withGroup.includes(m)) throw new Error(`панель свойств с группой: не найдено «${m}»`);
  }
  if (!withGroup.includes('group-box')) throw new Error('панель свойств: нет блока группы');

  const noGroup = renderToString(createElement(PropsPanel, { ...base, selGroup: null, onGroup: () => {} }));
  if (!noGroup.includes('Сгруппировать')) throw new Error('панель свойств: нет кнопки «Сгруппировать»');
  if (noGroup.includes('Разгруппировать')) throw new Error('панель свойств: разгруппировка без группы');

  const oneEnt = renderToString(createElement(PropsPanel, { ...base, selEnts: ents.slice(0, 1), selGroup: null }));
  if (oneEnt.includes('Сгруппировать')) throw new Error('панель свойств: группировка доступна для одного элемента');
}

// вкладка «Группы»: список с именами, числом элементов и разгруппировкой
{
  const groups = [
    { id: 'g1', name: 'Узел А', ids: ['p1', 'p2'] },
    { id: 'g2', name: 'Крепёж', ids: ['h1', 'h2', 'h3'] },
  ];
  const pane = renderToString(createElement(GroupsPanel, {
    groups, selGroup: groups[0], canGroup: true, canUngroup: true,
    onGroup: () => {}, onSelect: () => {}, onUngroup: () => {}, onUngroupAll: () => {}, onRename: () => {},
  }));
  for (const m of ['Узел А', 'Крепёж', '2 элемента', '3 элемента', '2 группы',
    'Сгруппировать выделенное', 'Разгруппировать', 'grp-name']) {
    if (!pane.includes(m)) throw new Error(`вкладка «Группы»: не найдено «${m}»`);
  }
  const empty = renderToString(createElement(GroupsPanel, {
    groups: [], selGroup: null, canGroup: false, canUngroup: false,
    onGroup: () => {}, onSelect: () => {}, onUngroup: () => {}, onUngroupAll: () => {}, onRename: () => {},
  }));
  if (!empty.includes('Групп пока нет')) throw new Error('вкладка «Группы»: нет подсказки пустого списка');
  if (!empty.includes('disabled')) throw new Error('вкладка «Группы»: кнопки не блокируются без выделения');
}

// Группы соединений: у каждой группы своё поле ширины дорожки и правила трассировки
{
  const nets = [{ id: 'n1', name: 'Питание', pads: ['p1', 'p2'], rules: { w: 1.5 } }, { id: 'n2', name: 'Сигнал', pads: ['p1'] }];
  const ends = new Map();
  const pane = renderToString(createElement(NetsPanel, {
    nets, active: 'n1', setActive: () => {}, onChange: () => {}, onNew: () => {}, onRoute: () => {},
    ends, comp: new Map(), info: { msg: '', ok: null },
    defaults: { w: 0.8, clear: 0.4, viaSize: 1.8, viaDrill: 0.8, allowTop: true },
  }));
  for (const m of ['Ширина дорожки группы Питание', 'Правила группы', 'Ширина дорожки', 'Зазор до меди',
    'Переход: Ø, мм', 'Переход: сверло', 'Слои группы', 'Как у всех', 'net-w', 'net-rules', '1.5']) {
    if (!pane.includes(m)) throw new Error(`группы соединений: не найдено «${m}»`);
  }
  const src = readFileSync('src/pcb/netroute.ts', 'utf8');
  for (const m of ['export function netRouteOpts', 'tryRipUp', 'trunkEnds', 'Сначала самые широкие дорожки']) {
    if (!src.includes(m)) throw new Error(`netroute.ts: нет «${m}»`);
  }
  const model = readFileSync('src/pcb/model.ts', 'utf8');
  if (!model.includes('export interface NetRules')) throw new Error('model.ts: нет NetRules');
  const css = readFileSync('src/styles.css', 'utf8');
  for (const m of ['.net-w', '.net-rules']) {
    if (!css.includes(m)) throw new Error(`нет стилей правил групп: ${m}`);
  }
}

// автокомпоновка: диалог стартует с параметрами и исходным размещением,
// после расчёта — три варианта с демонстрацией под каждым (как у трассировки)
{
  const doc = { name: 't', w: 60, h: 40, entities: [] };
  const dlg = renderToString(createElement(AutoPlaceDialog, {
    doc, selected: new Set<string>(), clearance: 0.4, onApply: () => {}, onClose: () => {},
  }));
  for (const m of ['Автокомпоновка компонентов', 'Рассчитать компоновку', 'Применить вариант',
    'Исходное размещение', 'Зазор между корпусами, мм', 'Отступ от края, мм']) {
    if (!dlg.includes(m)) throw new Error(`компоновка: не найдено «${m}»`);
  }
  const variants = (['compact', 'wide', 'tall'] as const).map((strategy, i) => ({
    ents: [], unresolved: [], missing: 0, length: 0, vias: 0, rips: 0, errors: [],
    strategy, title: `В${i + 1}`, description: 'd',
  }));
  const plc = renderToString(createElement(RouteVariantsDialog, {
    doc, variants: variants.map((v) => ({ ...v, strategy: 'few-vias' as const })), onApply: () => {}, onClose: () => {},
  }));
  for (const m of ['Выберите вариант трассировки групп', 'Предпросмотр варианта', 'Применить вариант',
    'name="route-variant"', 'Новых переходов']) {
    if (!plc.includes(m)) throw new Error(`варианты: не найдено «${m}»`);
  }
  if ((plc.match(/type="radio"/g) ?? []).length !== 3) throw new Error('вариантов должно быть три');
  const css = readFileSync('src/styles.css', 'utf8');
  if (!css.includes('.route-variant .layout-preview')) throw new Error('нет стилей демонстрации под вариантом');
}

console.log('SSR OK');
