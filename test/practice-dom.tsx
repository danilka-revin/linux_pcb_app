// Практическое обучение: добровольные уроки поверх редактора (полный путь в App, jsdom).
// Проверяем главное: редактор сам урок не навязывает — он спрашивает; Дальше
// оверлей ведёт за руку по реальному интерфейсу, ждёт настоящих действий,
// отмечает прохождение и предлагает следующий урок. Canvas-отрисовка заглушена.
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
const { PRACTICE_KEY, FIRST_TRACK_KEY, LEARN_ASKED_KEY } = coach;
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
const mount = async () => {
  const root = createRoot(doc.getElementById('root')!);
  await act(async () => { root.render(React.createElement(App)); });
  return root;
};
const doneList = (): string[] => {
  try { return JSON.parse(win.localStorage.getItem(PRACTICE_KEY) ?? '[]'); } catch { return []; }
};

// ---------- 1. Новичку НЕ навязываемся: сначала только вопрос ----------
assert.equal(coach.practiceDone('track'), false, 'до обучения отметки нет');
let root = await mount();

assert.equal($('.coach-root'), null, 'сразу после старта оверлея нет');
assert.ok($('[data-tool-id="track"]'), 'кнопка «Дорожка» размечена для подсветки');
assert.ok($('[data-learn="cu-k2"]'), 'кнопки слоёв размечены для подсветки');

await sleep(1000);
assert.ok($('.learn-offer'), 'появилась карточка-предложение урока');
assert.equal($('.coach-root'), null, 'без согласия пользователя урок не начинается');
assert.ok(txt('.learn-offer').includes('дорожку'), 'в карточке — про первую дорожку');

// «Не сейчас» — карточка уходит и больше не возвращается
await click(doc.querySelectorAll('.learn-offer-btns .btn')[1], '«Не сейчас»');
assert.equal($('.learn-offer'), null, 'карточка закрыта');
assert.equal(win.localStorage.getItem(LEARN_ASKED_KEY), '1', 'больше не спрашиваем');
assert.deepEqual(doneList(), [], 'прохождение не выставлено — урок просто отложили');

await act(async () => { root.unmount(); });
root = await mount();
await sleep(1000);
assert.equal($('.learn-offer'), null, 'после «не сейчас» не напоминаем');
assert.equal($('.coach-root'), null, 'и урок сами не запускаем');

// ---------- 2. Явно попросили: урок ведёт по «Дорожке» и кликам ----------
const settingsBtn = [...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement;
await click(settingsBtn, 'кнопка настроек');
assert.ok($('.set-win'), 'окно настроек открылось');
assert.ok(doc.querySelectorAll('.practice-card').length >= 6, 'в разделе «Обучение» — список уроков');
assert.ok(txt('.learn-settings').includes('только если хотите'), 'раздел объясняет, что обучение добровольное');
await click(doc.querySelectorAll('.practice-card')[0], 'карточка урока «Дорожка»');
assert.equal($('.set-win'), null, 'настройки закрылись при запуске урока');
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

// ---------- 4. Esc — быстрый выход ----------
await click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'снова настройки');
await click(doc.querySelectorAll('.practice-card')[2], 'карточка урока «Мышь, зум»');
assert.ok(txt('.coach-bubble').includes('колесо'), 'урок про навигацию ждёт колесо мыши');
await act(async () => {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
assert.equal($('.coach-root'), null, 'Esc закрыл урок');

// ---------- 4b. Урок про слои: указываем на настоящие кнопки шапки и панели ----------
await click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'настройки ради урока «Слои»');
await click(doc.querySelectorAll('.practice-card')[3], 'карточка урока «Слои»');
assert.ok(txt('.coach-bubble').includes('K2'), 'первый шаг — переключить слой');
await click($('[data-learn="cu-k2"]'), 'кнопка K2');
await sleep(40);
assert.ok(txt('.coach-bubble').includes('шелкографию'), 'следующий шаг — глазик слоя');
await click($('[data-learn="layer-eye-s1"]'), 'глазик');
await sleep(40);
assert.ok(txt('.coach-bubble').includes('вернётся'), 'просим вернуть слой обратно');
await click($('.coach-next'), 'пропустить шаг');
await click($('.coach-skip'), 'крестик');
assert.ok(doneList().includes('layers'), 'урок про слои отмечен пройденным');

// ---------- 4c. Открытый диалог: урок засыпает, но не закрывается ----------
await click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'открыть настройки');
await click(doc.querySelectorAll('.practice-card')[2], 'урок «Мышь, зум»');
assert.ok($('.coach-root'), 'урок идёт');
await click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'снова настройки поверх урока');
assert.ok($('.set-win'), 'настройки открылись');
assert.equal($('.coach-root'), null, 'пока открыт диалог — оверлей прячется');
await act(async () => {
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});
assert.equal($('.set-win'), null, 'Esc закрыл настройки');
assert.ok($('.coach-root'), 'и не тронул урок');
await click($('.coach-skip'), 'крестик');

// ---------- 4d. Тур → практика одной кнопкой ----------
const openSettings = async () => click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'настройки');
await openSettings();
assert.ok(txt('.tour-practice-chip').includes('дорожка'), 'на карточке тура видно, что к нему есть практика');
await click(doc.querySelector('.tour-card'), 'карточка тура');
assert.ok($('.tour-embedded'), 'тур открылся прямо в настройках');
assert.ok($('.tour-practice-btn'), 'внизу тура — кнопка практики');
await click($('.tour-practice-btn'), '«Практика ▶»');
assert.equal($('.set-win'), null, 'настройки закрылись');
assert.ok($('.coach-root'), 'урок из тура стартовал');
assert.ok(txt('.coach-lesson').includes('дорожка'), 'подпись урока — про первую дорожку');
await click($('.coach-skip'), 'крестик');

// ---------- 5. Пройденное помнится и в старом ключе (совместимость) ----------
assert.ok(win.localStorage.getItem(FIRST_TRACK_KEY) === '1' || doneList().includes('track'),
  'отметка «дорожку прошёл» стоит');

// ---------- 6. Настройки напоминания: off — тишина, auto — урок сам ----------
await click([...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement, 'настройки');
const offBtn = [...(doc.querySelectorAll('.learn-offer-set .btn') as NodeListOf<HTMLButtonElement>)]
  .find((b) => b.textContent === 'Не показывать');
await click(offBtn!, 'режим «Не показывать»');
const saved = JSON.parse(win.localStorage.getItem(PREFS_KEY) ?? '{}');
assert.equal(saved.learnOnStart, 'off', 'настройка уехала в localStorage');
await click($('.set-head-close'), 'закрыть настройки');
await act(async () => { root.unmount(); });
win.localStorage.removeItem(PRACTICE_KEY);
win.localStorage.removeItem(FIRST_TRACK_KEY);
win.localStorage.removeItem(LEARN_ASKED_KEY);
root = await mount();
await sleep(1000);
assert.equal($('.learn-offer'), null, 'в режиме off не предлагаем');
assert.equal($('.coach-root'), null, 'в режиме off не учим насильно');

win.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...saved, learnOnStart: 'auto' }));
await act(async () => { root.unmount(); });
root = await mount();
await sleep(1000);
assert.ok($('.coach-root'), 'в режиме auto урок стартует сам');
await click($('.coach-skip'), 'крестик');

await act(async () => { root.unmount(); });
process.stdout.write(
  'PRACTICE DOM OK: обучение добровольное (карточка-вопрос, «не сейчас», off/auto), '
  + 'уроки ведут по реальному интерфейсу, шаг и урок пропускаются, прогресс в localStorage\n',
  () => process.exit(0),
);
