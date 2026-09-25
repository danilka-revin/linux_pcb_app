import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
import { LibraryPanel } from '../src/ui/panels';
import { LIB } from '../src/pcb/library';
import { LibPreviewDialog } from '../src/ui/libpreview';
const html = renderToString(createElement(App));
console.log('SSR длина:', html.length);
if (!html.includes('toolbar') || !html.includes('status')) throw new Error('layout not rendered');
if (!html.includes('Bees')) throw new Error('brand not rendered');
if (!html.includes('logo.png')) throw new Error('bee logo not rendered');
if (!html.includes('светлую тему') && !html.includes('тёмную тему')) throw new Error('theme toggle not rendered');
// сетка и библиотека должны быть в разметке (проверка, что интерфейс подключён)
const must = [
  'Настроить сетку',        // выбор шага в тулбаре + диалог
  'Привязка',               // быстрая панель сетки
  '50 mil',                 // подписи шагов в двух системах
  'Библиотека',             // вкладка библиотеки компонентов
];
for (const m of must) if (!html.includes(m)) throw new Error(`не найдено в разметке: ${m}`);
const lib = renderToString(createElement(LibraryPanel, {
  picked: 'dip8', onPick: () => {}, onPreview: () => {}, macros: [], onPickUser: () => {},
  onDelUser: () => {}, onImportLmk: () => {}, onImportZip: () => {},
}));
for (const m of ['DIP-8', 'SMD', '8 выводов', 'шаг 2.54']) {
  if (!lib.includes(m)) throw new Error(`панель библиотеки: не найдено «${m}»`);
}
// Предпросмотр макроса больше не рисуется мини-канвасом внутри списка (он
// растягивался на весь экран и уезжал под холст платы): выбранный макрос
// показан строкой `.lib-sel`, а сам предпросмотр — всплывающим окном.
if (lib.includes('lib-preview')) throw new Error('в списке библиотеки остался мини-канвас предпросмотра');
if (!lib.includes('lib-sel') || !lib.includes('Предпросмотр и установка…')) {
  throw new Error('панель библиотеки: нет строки выбранного макроса');
}

const dip8 = LIB['dip8'];
const pv = renderToString(createElement(LibPreviewDialog, {
  title: dip8.name, spec: '8 выводов · шаг 2.54 мм', note: dip8.spec?.note,
  libKey: dip8.key, els: dip8.build(), onAdd: () => {}, onClose: () => {},
}));
for (const m of ['lib-preview', 'Добавить на плату', 'DIP-8', '0;0', 'точка привязки']) {
  if (!pv.includes(m)) throw new Error(`окно предпросмотра: не найдено «${m}»`);
}
console.log('SSR OK');
