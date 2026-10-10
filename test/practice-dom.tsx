// Практическое обучение: добровольные уроки поверх редактора (полный путь в App, jsdom).
// Проверяем главное: редактор сам урок не навязывает — внизу висит полоса
// «Пройти обучение / Пропустить». Дальше оверлей ведёт за руку по настоящему
// интерфейсу, ждёт реальных действий, отмечает прохождение и предлагает
// следующий урок. Canvas-отрисовка заглушена.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

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
win.Element.prototype.scrollIntoView = () => undefined;
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
const coach = await import('../src/ui/coach');
const { PRACTICE_KEY, LEARN_ASKED_KEY } = coach;
const { PREFS_KEY } = await import('../src/ui/prefs');

const doc = win.document;
const $ = (sel: string) => doc.querySelector(sel) as HTMLElement | null;
const txt = (sel: string) => ($(sel)?.textContent ?? '').replace(/\s+/g, ' ');
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = async (el: Element | null, name = 'кнопка') => {
  assert.ok(el, `элемент найден: ${name}`);
  await act(async () => { (el as HTMLButtonElement).click(); });
};
const canvasClick = async (x: number, y: number, button = 0) => {
  await act(async () => {
    doc.querySelector('.canvas-over')!.dispatchEvent(
      new win.MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true, cancelable: true }),
    );
  });
};
const esc = () => act(async () => {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
const mount = async () => {
  const root = createRoot(doc.getElementById('root')!);
  await act(async () => { root.render(React.createElement(App)); });
  return root;
};
const doneList = (): string[] => {
  try { return JSON.parse(win.localStorage.getItem(PRACTICE_KEY) ?? '[]'); } catch { return []; }
};
const openSettings = async () => {
  const btn = [...doc.querySelectorAll('.toolbar button')]
    .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement;
  await click(btn, 'кнопка настроек');
  assert.ok($('.set-win'), 'окно настроек открылось');
};

assert.equal(coach.practiceDone('track'), false, 'до обучения отметки нет');
assert.equal(coach.nextPracticeId(), 'track', 'первый непройденный урок — про дорожку');

// ---------- 1. Полоса внизу, а не урок поверх редактора ----------
let root = await mount();
assert.equal($('.coach-root'), null, 'сразу после старта урока нет');
assert.ok($('.learn-bar'), 'под холстом появилась полоса про обучение');
assert.ok($('.learn-bar')!.parentElement === doc.getElementById('root'), 'полоса — часть макета, она ничего не перекрывает');
assert.ok(txt('.learn-bar').includes('Пройти обучение'), 'на полосе кнопка «Пройти обучение»');
assert.ok(txt('.learn-bar').includes('Пропустить'), 'и кнопка «Пропустить»');
assert.ok(txt('.learn-bar').includes('6 уроков'), 'полоса говорит, сколько уроков осталось');
assert.ok($('[data-tool-id="track"]'), 'кнопка «Дорожка» размечена для подсветки');
assert.ok($('[data-learn="cu-k2"]'), 'кнопки слоёв размечены для подсветки');

// ---------- 2. «Пройти обучение» → урок ведёт по «Дорожке» и кликам ----------
await click($('.learn-bar-go'), '«Пройти обучение»');
assert.equal($('.learn-bar'), null, 'пока урок идёт, полоса не мешает');
assert.ok($('.coach-root'), 'оверлей запущен');
assert.ok(txt('.coach-bubble').includes('Нажми «Дорожка»'), 'указываем на инструмент');
assert.ok($('.coach-spot'), 'цель подсвечена');

await click($('[data-tool-id="track"]'), '«Дорожка»');
await sleep(30);
assert.ok(txt('.coach-bubble').includes('Кликни'), 'зовём кликнуть по холсту');
assert.ok($('.coach-marker'), 'на холсте горит огонёк-мишень');

await canvasClick(120, 120);
assert.ok(txt('.coach-bubble').includes('кликни ещё раз'), 'просим второй клик');
await canvasClick(260, 200);
assert.ok(/ПКМ|Esc/.test(txt('.coach-bubble')), 'подсказываем завершить');

await canvasClick(260, 200, 2);
assert.ok($('.coach-card'), 'карточка успеха');
assert.ok($('.coach-confetti'), 'конфетти на финише');
assert.ok(txt('.coach-card').includes('Первая дорожка'), 'текст про дорожку');

// ---------- 3. «Следующий урок» — та же механика, другой интерфейс ----------
const nextBtn = [...(doc.querySelectorAll('.coach-card-btns .btn') as NodeListOf<HTMLButtonElement>)]
  .find((b) => !b.className.includes('primary'));
await click(nextBtn!, 'кнопка «следующий урок»');
assert.ok($('.coach-root'), 'второй урок стартовал');
assert.ok(txt('.coach-lesson').includes('генератора'), 'подпись урока — про генератор деталей');
assert.ok(
  txt('.coach-bubble').includes('dip 8') || txt('.coach-bubble').includes('Генератор'),
  'первый шаг нового урока про генератор',
);
// шаг можно пропустить — урок необязательный даже внутри
await click($('.coach-next'), '«пропустить шаг»');
await sleep(30);
assert.ok($('.coach-bubble'), 'после пропуска шага подсказка осталась');
// ✕ — закрыть весь урок: засчитывается как «больше не надо»
await click($('.coach-skip'), 'крестик');
assert.equal($('.coach-root'), null, 'урок закрыт');
assert.ok(doneList().includes('parts'), 'пропущенный урок больше не предлагается');
assert.equal(coach.nextPracticeId(), 'nav', 'следующий непройденный — про мышь и зум');

// полоса больше не возвращается: на неё уже ответили
await act(async () => { root.unmount(); });
root = await mount();
await sleep(30);
assert.equal($('.learn-bar'), null, 'после «Пройти обучение» полосу не показываем');
assert.equal($('.coach-root'), null, 'и урок сами не запускаем');

// ---------- 4. «Пропустить» убирает полосу навсегда ----------
win.localStorage.removeItem(LEARN_ASKED_KEY);
win.localStorage.removeItem(PRACTICE_KEY);
await act(async () => { root.unmount(); });
root = await mount();
assert.ok($('.learn-bar'), 'без ответа полоса снова видна');
await click($('.learn-bar-skip'), '«Пропустить»');
assert.equal($('.learn-bar'), null, 'полоса скрыта');
assert.equal(win.localStorage.getItem(LEARN_ASKED_KEY), '1', 'запомнили: человек отказался');
assert.deepEqual(doneList(), [], 'отметок о прохождении нет — обучение просто отвергли');
await act(async () => { root.unmount(); });
root = await mount();
await sleep(30);
assert.equal($('.learn-bar'), null, 'и при следующем запуске не напоминаем');

// ---------- 5. Настройки: список уроков, пропуски, диалог ----------
await openSettings();
assert.ok(doc.querySelectorAll('.practice-card').length >= 6, 'в разделе «Обучение» — список уроков');
assert.ok(txt('.learn-settings').includes('Полоса «пройти обучение» внизу окна'), 'там же переключатель самой полосы');
await click(doc.querySelectorAll('.practice-card')[3], 'карточка урока «Слои»');
assert.equal($('.set-win'), null, 'настройки закрылись при запуске урока');
assert.ok(txt('.coach-bubble').includes('K2'), 'первый шаг — переключить слой');
await click($('[data-learn="cu-k2"]'), 'кнопка K2');
await sleep(40);
assert.ok(txt('.coach-bubble').includes('шелкографию'), 'следующий шаг — глазик слоя');
await click($('[data-learn="layer-eye-s1"]'), 'глазик');
await sleep(40);
assert.ok(txt('.coach-bubble').includes('вернётся'), 'просим вернуть слой обратно');
await click($('.coach-skip'), 'крестик');
assert.ok(doneList().includes('layers'), 'урок про слои отмечен пройденным');

// открытый диалог: урок засыпает, но не закрывается; Esc — про диалог
await openSettings();
await click(doc.querySelectorAll('.practice-card')[2], 'урок «Мышь, зум»');
assert.ok($('.coach-root'), 'урок идёт');
await openSettings();
assert.equal($('.coach-root'), null, 'пока открыт диалог — оверлей прячется');
await esc();
assert.equal($('.set-win'), null, 'Esc закрыл настройки');
assert.ok($('.coach-root'), 'и не тронул урок');
await esc();
assert.equal($('.coach-root'), null, 'а без диалога Esc пропускает урок');

// тур → практика одной кнопкой
await openSettings();
assert.ok(txt('.tour-practice-chip').includes('дорожка'), 'на карточке тура видно, что к нему есть практика');
await click(doc.querySelector('.tour-card'), 'карточка тура');
assert.ok($('.tour-embedded'), 'тур открылся прямо в настройках');
assert.ok($('.tour-practice-btn'), 'внизу тура — кнопка практики');
await click($('.tour-practice-btn'), '«Практика ▶»');
assert.equal($('.set-win'), null, 'настройки закрылись');
assert.ok($('.coach-root'), 'урок из тура стартовал');
await click($('.coach-skip'), 'крестик');

// сброс прогресса убирает и ответ «не напоминать» — полоса вернётся
await openSettings();
assert.ok(
  txt('.learn-reset-row').includes(`Пройдено: ${doneList().length} из ${6}`),
  'в настройках видно, сколько уроков пройдено',
);
await click($('.learn-reset-row .tour-reset'), '«Сбросить» прогресс уроков');
assert.deepEqual(doneList(), [], 'отметки о прохождении стёрты');
assert.equal(win.localStorage.getItem(LEARN_ASKED_KEY), null, 'и отказ стёрт — полоса снова имеет право появиться');
await click($('.set-head-close'), 'закрыть настройки');

// ---------- 6. Режимы полосы: off — тишина, auto — урок сразу ----------
await openSettings();
const offBtn = [...(doc.querySelectorAll('.learn-offer-set .btn') as NodeListOf<HTMLButtonElement>)]
  .find((b) => b.textContent === 'Не показывать');
await click(offBtn!, 'режим «Не показывать»');
const saved = JSON.parse(win.localStorage.getItem(PREFS_KEY) ?? '{}');
assert.equal(saved.learnOnStart, 'off', 'настройка уехала в localStorage');
await click($('.set-head-close'), 'закрыть настройки');
win.localStorage.removeItem(PRACTICE_KEY);
win.localStorage.removeItem(LEARN_ASKED_KEY);
await act(async () => { root.unmount(); });
root = await mount();
await sleep(30);
assert.equal($('.learn-bar'), null, 'в режиме off полосы нет');
assert.equal($('.coach-root'), null, 'в режиме off не учим насильно');

await openSettings();
const autoBtn = [...(doc.querySelectorAll('.learn-offer-set .btn') as NodeListOf<HTMLButtonElement>)]
  .find((b) => b.textContent === 'Сразу показывать');
await click(autoBtn!, 'режим «Сразу показывать»');
await click($('.set-head-close'), 'закрыть настройки');
await act(async () => { root.unmount(); });
root = await mount();
await sleep(1000);
assert.ok($('.coach-root'), 'в режиме auto урок стартует сам');
assert.equal($('.learn-bar'), null, 'и полоса не нужна');
await click($('.coach-skip'), 'крестик');
await act(async () => { root.unmount(); });

process.stdout.write(
  'PRACTICE DOM OK: полоса «Пройти обучение / Пропустить» внизу, добровольность и режимы off/auto, '
  + 'уроки ведут по реальному интерфейсу, шаг и урок пропускаются, прогресс в localStorage\n',
  () => process.exit(0),
);
