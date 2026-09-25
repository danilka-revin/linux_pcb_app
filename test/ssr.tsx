import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
import { LibraryPanel } from '../src/ui/panels';
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
  picked: 'dip8', onPick: () => {}, macros: [], onPickUser: () => {}, onDelUser: () => {},
  onImportLmk: () => {}, onImportZip: () => {},
}));
for (const m of ['DIP-8', 'SMD', '8 выводов', 'шаг 2.54']) {
  if (!lib.includes(m)) throw new Error(`панель библиотеки: не найдено «${m}»`);
}
console.log('SSR OK');
