// Практика «Твоя первая дорожка»: полный путь новичка в реальном App (jsdom).
// Оверлей сам появляется, указывает на инструмент, ведёт по кликам и
// отмечает прохождение в localStorage. Canvas-отрисовка заглушена.
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
const { FIRST_TRACK_KEY, firstTrackDone } = await import('../src/ui/first-track');

assert.equal(firstTrackDone(), false, 'до обучения флаг не стоит');

const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(App)); });

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const doc = win.document;
const bubble = () => doc.querySelector('.coach-bubble') as HTMLElement | null;
const bubbleText = () => (bubble()?.textContent ?? '').replace(/\s+/g, ' ');
const canvasClick = async (x: number, y: number, button = 0) => {
  await act(async () => {
    doc.querySelector('.canvas-over')!.dispatchEvent(
      new win.MouseEvent('pointerdown', { clientX: x, clientY: y, button, bubbles: true, cancelable: true }),
    );
  });
};

// 1. До автозапуска оверлея нет, кнопка инструмента размечена для подсветки.
assert.equal(doc.querySelector('.coach-root'), null, 'сразу после старта оверлея нет');
assert.ok(doc.querySelector('[data-tool-id="track"]'), 'кнопка «Дорожка» размечена data-tool-id');

// 2. Автозапуск для новичка: оверлей указывает на инструмент.
await sleep(1000);
assert.ok(doc.querySelector('.coach-root'), 'оверлей появился сам');
assert.ok(bubbleText().includes('Дорожка'), 'подсказка указывает на инструмент «Дорожка»');
assert.ok(doc.querySelector('.coach-spot'), 'цель подсвечена');

// 3. Клик по инструменту — подсказка ведёт на холст.
await act(async () => { (doc.querySelector('[data-tool-id="track"]') as HTMLButtonElement).click(); });
await sleep(50);
assert.ok(bubbleText().includes('Кликни'), 'после выбора инструмента зовём кликнуть по холсту');
assert.ok(doc.querySelector('.coach-marker'), 'на холсте горит огонёк-мишень');

// 4. Первый клик — начало дорожки.
await canvasClick(120, 120);
assert.ok(bubbleText().includes('кликни ещё раз'), 'просим второй клик');

// 5. Второй клик — дорожка почти готова.
await canvasClick(260, 200);
assert.ok(/ПКМ|Esc/.test(bubbleText()), 'подсказываем завершить ПКМ или Esc');

// 6. ПКМ фиксирует дорожку — успех и конфетти.
await canvasClick(260, 200, 2);
assert.ok(doc.querySelector('.coach-card'), 'карточка успеха показана');
assert.ok(doc.querySelector('.coach-confetti'), 'конфетти на финише');

// 7. «Рисовать дальше» закрывает обучение и запоминает прохождение.
await act(async () => { (doc.querySelector('.coach-card .btn') as HTMLButtonElement).click(); });
assert.equal(doc.querySelector('.coach-root'), null, 'оверлей закрыт');
assert.equal(win.localStorage.getItem(FIRST_TRACK_KEY), '1', 'прохождение отмечено');
assert.equal(firstTrackDone(), true, 'флаг чтения из localStorage');

// 8. Пропуск тоже гасит оверлей и больше не навязывается.
// Новый маунт: корень размонтируем и рендерим заново (эффект автозапуска — на маунт).
await act(async () => { root.unmount(); });
win.localStorage.removeItem(FIRST_TRACK_KEY);
const root2 = createRoot(win.document.getElementById('root')!);
await act(async () => { root2.render(React.createElement(App)); });
await sleep(1000);
assert.ok(doc.querySelector('.coach-root'), 'без флага оверлей снова появляется');
await act(async () => { (doc.querySelector('.coach-skip') as HTMLButtonElement).click(); });
assert.equal(doc.querySelector('.coach-root'), null, 'пропуск закрывает оверлей');
assert.equal(win.localStorage.getItem(FIRST_TRACK_KEY), '1', 'после пропуска не показываем снова');

// 9. Повторный запуск из Настройки → Обучение работает даже с флагом.
const settingsBtn = [...doc.querySelectorAll('.toolbar button')]
  .find((b) => (b.getAttribute('title') ?? '').startsWith('Настройки программы')) as HTMLButtonElement;
assert.ok(settingsBtn, 'кнопка настроек в шапке');
await act(async () => { settingsBtn.click(); });
assert.ok(doc.querySelector('.set-win'), 'окно настроек открылось');
const practiceBtn = doc.querySelector('.learn-practice') as HTMLButtonElement;
assert.ok(practiceBtn, 'кнопка практики видна в разделе «Обучение»');
await act(async () => { practiceBtn.click(); });
assert.equal(doc.querySelector('.set-win'), null, 'настройки закрылись при запуске практики');
assert.ok(doc.querySelector('.coach-root'), 'практика запустилась повторно поверх редактора');
await act(async () => { (doc.querySelector('.coach-skip') as HTMLButtonElement).click(); });
assert.equal(doc.querySelector('.coach-root'), null, 'повторную практику можно пропустить');

process.stdout.write('FIRST-TRACK DOM OK: автозапуск, указание на инструмент, клики по холсту, завершение ПКМ, успех, пропуск, флаг в localStorage\n', () => process.exit(0));
