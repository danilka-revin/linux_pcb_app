// DOM-проверка кнопки «Обновить»: фоновая проверка, подсветка и напоминание.
// jsdom + подставной fetch — без выхода в настоящий GitHub. Проверяется не
// копия логики, а сам хук src/ui/updater.tsx в настоящем React.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
const win = dom.window as unknown as Window & typeof globalThis & Record<string, any>;

for (const k of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event',
  'MouseEvent', 'KeyboardEvent', 'CustomEvent', 'localStorage', 'sessionStorage',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'DOMParser', 'Blob',
]) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true });
}
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// часы, которыми можно «перемотать» время: иначе фоновая проверка считает
// предыдущий ответ свежим и не переспрашивает сервер
let clockShift = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + clockShift;

// --- подставной сервер: сначала обновления нет, потом выходит новая версия ---
const LATEST = {
  ok: true, repo: 'danilka-revin/linux_pcb_app', branch: 'main',
  local: 'aaa1111', latest: 'bbb2222', latestSha: 'bbb2222cccc3333dddd4444',
  latestMsg: 'пчела стала быстрее', behind: 3,
  updateAvailable: true, tooling: { git: true, npm: true },
};
let mode: 'none' | 'new' | 'noserver' = 'none';
let checks = 0;
(globalThis as Record<string, unknown>).fetch = async (url: string | URL) => {
  const path = String(url);
  if (path.includes('/update/status')) {
    return { ok: true, text: async () => JSON.stringify({ status: 'idle', rev: 0, stages: [], output: '' }) } as never;
  }
  if (path.includes('/update/check')) {
    checks++;
    if (mode === 'noserver') return { ok: true, text: async () => '<!doctype html><title>vite</title>' } as never;
    if (mode === 'new') return { ok: true, text: async () => JSON.stringify(LATEST) } as never;
    return {
      ok: true,
      text: async () => JSON.stringify({ ...LATEST, latest: 'aaa1111', latestSha: 'aaa1111', behind: 0, updateAvailable: false }),
    } as never;
  }
  throw new Error('неожиданный запрос: ' + path);
};
win.fetch = (globalThis as Record<string, unknown>).fetch as never;

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useUpdater } = await import('../src/ui/updater');

/** Обёртка: настоящий хук обновления в настоящем React-дереве. */
function Harness() {
  const upd = useUpdater(null, true);
  return React.createElement(React.Fragment, null, upd.Button, upd.Dialog);
}

const btn = () => win.document.querySelector('button.upd-btn')!;
const toast = () => win.document.querySelector('.upd-toast');
const byText = (sel: string, text: string) =>
  [...win.document.querySelectorAll(sel)].find((el) => (el.textContent || '').trim() === text) as HTMLElement | undefined;

const root = createRoot(win.document.getElementById('root')!);
await act(async () => { root.render(React.createElement(Harness)); });

// 1. ничего не выходило — кнопка обычная, никакой подсветки
if (btn().className.includes('upd-avail')) throw new Error('без обновления кнопка не должна светиться');
if (!btn().getAttribute('title')!.includes('Обновить программу из ветки main')) throw new Error('подсказка кнопки изменилась');
if (toast()) throw new Error('напоминание не должно появляться без новой версии');

// 2. на GitHub вышла новая версия — вернулись в окно, фон проверил сам
mode = 'new';
checks = 0;
await act(async () => { win.dispatchEvent(new win.Event('focus')); });
if (checks === 0) throw new Error('фоновая проверка не спросила сервер при возврате в окно');
const cls = btn().className;
if (!cls.includes('upd-avail')) throw new Error('кнопка не подсветилась: ' + cls);
if (!cls.includes('upd-fresh')) throw new Error('кнопка не пульсирует для новой версии: ' + cls);
if (!btn().getAttribute('title')!.includes('Доступна новая версия bbb2222')) throw new Error('нет версии в подсказке');
if (!btn().textContent!.includes('+3')) throw new Error('не показан счётчик новых коммитов');
if (!toast()) throw new Error('нет напоминания о новой версии');
if (!toast()!.textContent!.includes('пчела стала быстрее')) throw new Error('в напоминании нет сообщения коммита');

// 3. «Позже» — убирает напоминание и пульсацию, точка остаётся до обновления
await act(async () => { byText('button', 'Позже')!.click(); });
if (toast()) throw new Error('«Позже» должно скрывать напоминание');
if (btn().className.includes('upd-fresh')) throw new Error('после «Позже» пульсация должна гаснуть');
if (!btn().className.includes('upd-avail')) throw new Error('подсветка обновления должна остаться');

// 4. перезапуск программы: про эту версию уже знаем — пульсации нет, точка на месте
await act(async () => { root.unmount(); });
const root2 = createRoot(win.document.getElementById('root')!);
await act(async () => { root2.render(React.createElement(Harness)); });
await act(async () => { win.dispatchEvent(new win.Event('focus')); });
if (!btn().className.includes('upd-avail')) throw new Error('после перезапуска подсветка потерялась');
if (btn().className.includes('upd-fresh')) throw new Error('про уже показанную версию не нужно пульсировать снова');
if (toast()) throw new Error('напоминание не должно возвращаться для той же версии');

// 5. обновились (прошло время, сервер теперь отвечает «актуальная версия») → подсветка гаснет
mode = 'none';
clockShift += 6 * 60_000;
await act(async () => { win.dispatchEvent(new win.Event('focus')); });
if (btn().className.includes('upd-avail')) throw new Error('после обновления кнопка должна погаснуть');

// 6. сервер без обновления (npm run dev) — молча ничего не подсвечиваем
mode = 'noserver';
clockShift += 6 * 60_000;
await act(async () => { win.dispatchEvent(new win.Event('focus')); });
if (btn().className.includes('upd-avail')) throw new Error('без /update кнопка не должна светиться');
if (toast()) throw new Error('без /update не должно быть напоминания');

await act(async () => { root2.unmount(); });
// jsdom держит цикл кадров — без закрытия окна процесс не завершится сам
dom.window.close();
process.stdout.write(
  'UPDATER DOM OK: фоновая проверка, подсветка кнопки, счётчик коммитов, напоминание и «Позже»\n',
  () => process.exit(0),
);
