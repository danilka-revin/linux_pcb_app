// SSR-дым: приложение и панель деталей собираются на сервере без ошибок.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
import { GenPanel, MacroTree, genSpecText } from '../src/ui/genpanel';
import { addMacro, buildTree, createFolder, emptyStore, makeMacro } from '../src/pcb/userlib';
import { generate } from '../src/pcb/gen';
import { LibPreviewDialog } from '../src/ui/libpreview';

const html = renderToString(createElement(App));
console.log('SSR длина:', html.length);
if (!html.includes('toolbar') || !html.includes('status')) throw new Error('layout not rendered');
if (!html.includes('Bees')) throw new Error('brand not rendered');
if (!html.includes('logo.png')) throw new Error('bee logo not rendered');
if (!html.includes('светлую тему') && !html.includes('тёмную тему')) throw new Error('theme toggle not rendered');
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

// хвост шапки (тема, «Обновить», меню «Интерфейс и справка») живёт в последней
// группе и первым упирается в край окна: следим, чтобы он не обрезался
for (const m of ['Интерфейс и справка', 'upd-btn', 'Обновить']) {
  if (!html.includes(m)) throw new Error(`шапка: не найдено «${m}» — группа «about» пропала из тулбара`);
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

// Сохранённая в браузере конфигурация интерфейса не должна отнимать вход в сам
// конструктор: старая запись (порядок без «about» + попытка спрятать хвост) —
// именно так «кнопки не появлялись» после обновления.
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
    ids: ['file', 'grid', 'view'],   // порядок из версии, где «about» ещё не было
    hidden: ['about'],               // и вдобавок попытка спрятать хвост шапки
  }));
  const html2 = renderToString(createElement(App));
  for (const m of ['Интерфейс и справка', 'upd-btn', 'Обновить']) {
    if (!html2.includes(m)) throw new Error(`старые настройки спрятали «${m}» — в конструктор интерфейса не вернуться`);
  }
  // группы, появившиеся в новой версии, дописываются в конец (а не пропадают)
  for (const m of ['Активный слой: верхняя медь', 'Генератор деталей (I)']) {
    if (!html2.includes(m)) throw new Error(`старый порядок групп спрятал новую группу: ${m}`);
  }
  delete (globalThis as any).localStorage;
}

// «⋯ → Интерфейс и справка» — единственный вход в конструктор интерфейса и цвета:
// следим, чтобы его пункты не потерялись (меню рендерится только по клику)
{
  const app = readFileSync('src/App.tsx', 'utf8');
  for (const m of ['Конструктор интерфейса…', 'Цвета интерфейса…']) {
    if (!app.includes(m)) throw new Error(`меню «Интерфейс и справка»: пропал пункт «${m}»`);
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
console.log('SSR OK');
