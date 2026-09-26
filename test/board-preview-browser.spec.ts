import { expect, test, type Page } from '@playwright/test';
import type { Doc } from '../src/pcb/model';

const doc: Doc = { name: '3D regression', w: 80, h: 40, entities: [
  { id: 'pad1', kind: 'pad', x: 15, y: 15, size: 3, drill: 1, shape: 'square' },
  { id: 'pad2', kind: 'pad', x: 60, y: 28, size: 3, drill: 1, shape: 'round' },
  { id: 'trace', kind: 'track', w: 1, layer: 'k1', pts: [{ x: 15, y: 15 }, { x: 47, y: 15 }, { x: 60, y: 28 }] },
  { id: 'back', kind: 'track', w: 1, layer: 'k2', pts: [{ x: 15, y: 15 }, { x: 15, y: 28 }, { x: 60, y: 28 }] },
  { id: 'text', kind: 'text', layer: 's1', x: 20, y: 30, rot: 0, size: 3, th: 0.2, mirror: false, text: 'TOP' },
  { id: 'comp', kind: 'comp', lib: '', name: 'U1', x: 35, y: 20, rot: 90, side: 'top', bl: [-5, -3, 5, 3], ents: [
    { id: 'smd', kind: 'smd', layer: 'k1', x: -6, y: 0, w: 2, h: 1, rot: 0 },
  ] },
] };
const canvas = (page: Page) => page.locator('.bp3d-canvas-wrap canvas');
const ready = async (page: Page) => {
  await expect(page.getByRole('button', { name: 'Вписать 3D', exact: true })).toBeEnabled();
  await expect(canvas(page)).toHaveCount(1);
  await expect(page.locator('.bp3d-message')).toHaveCount(0);
};
/** Единственная кнопка предпросмотра в шапке (правая узкая часть — выбор режима) */
const previewToggle = (page: Page) => page.getByTitle('Выбрать режим предпросмотра: 2D или 3D', { exact: true });
const previewMain = (page: Page) => page.locator('.toolbar .tb-split .tb-btn.split-main');
const previewItem = (page: Page, name: string) => page.getByRole('menuitem', { name, exact: true });
async function open3D(page: Page) {
  await page.addInitScript(d => localStorage.setItem('lauaut.autosave', JSON.stringify(d)), doc);
  await page.goto('/');
  await previewToggle(page).click();
  await previewItem(page, '3D предпросмотр — объёмная плата').click();
}

// Inspect the actual WebGL framebuffer immediately after drawing. A blank canvas
// or a constructor that failed after appending the canvas must not pass this test.
test('3D renders a model, supports orbit/zoom/pan and keeps one context for toggles', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.drawElements;
    WebGL2RenderingContext.prototype.drawElements = function (...args) {
      original.apply(this, args);
      const w = this.drawingBufferWidth, h = this.drawingBufferHeight;
      const pixel = new Uint8Array(4), bg = new Uint8Array(4);
      this.readPixels(Math.floor(w / 2), Math.floor(h / 2), 1, 1, this.RGBA, this.UNSIGNED_BYTE, pixel);
      this.readPixels(2, 2, 1, 1, this.RGBA, this.UNSIGNED_BYTE, bg);
      if (pixel.some((v, i) => Math.abs(v - bg[i]) > 10)) (this.canvas as HTMLCanvasElement).dataset.modelRendered = 'true';
    };
  });
  await open3D(page);
  await ready(page);
  await expect(canvas(page)).toHaveAttribute('data-model-rendered', 'true');
  const cv = canvas(page);
  await cv.evaluate(e => e.setAttribute('data-instance', 'original'));
  const before = await cv.screenshot();
  const box = (await cv.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 70, { steps: 10 });
  await page.mouse.up();
  expect(before.equals(await cv.screenshot())).toBe(false);
  const rotated = await cv.screenshot();
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => rotated.equals(await cv.screenshot())).toBe(false);
  const zoomed = await cv.screenshot();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 180, box.y + box.height / 2 + 110, { steps: 5 });
  await page.mouse.up({ button: 'right' });
  expect(zoomed.equals(await cv.screenshot())).toBe(false);
  await page.getByRole('button', { name: 'Вписать 3D', exact: true }).click();
  await page.getByLabel('Авто-вращение', { exact: true }).check();
  const rotating = await cv.screenshot();
  await expect.poll(async () => rotating.equals(await cv.screenshot())).toBe(false);
  await page.getByLabel('Авто-вращение', { exact: true }).uncheck();
  const withBody = await cv.screenshot();
  await page.getByLabel('Детали', { exact: true }).uncheck();
  expect(withBody.equals(await cv.screenshot())).toBe(false);
  await page.getByLabel('Каркас', { exact: true }).check();
  await expect(cv).toHaveAttribute('data-instance', 'original');
  await page.getByLabel('Тема 3D-платы').selectOption('blue');
  await ready(page);
  await expect(page.getByLabel('Каркас', { exact: true })).toBeChecked();
  await page.getByLabel('Толщина 3D-платы').selectOption('3');
  await ready(page);
  expect(errors).toEqual([]);
});

test('reopen, responsive sizing, context loss and retry', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open3D(page);
  await ready(page);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '2D · Sprint Layout', exact: true }).click();
    await expect(canvas(page)).toHaveCount(0);
    await page.getByRole('button', { name: '3D · Объёмный вид', exact: true }).click();
    await ready(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => {
    const box = (await canvas(page).boundingBox())!;
    return box.x >= 0 && box.x + box.width <= 390;
  }).toBe(true);
  await expect.poll(async () => page.locator('.board-preview-modal').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await canvas(page).evaluate(e => {
    const gl = (e as HTMLCanvasElement).getContext('webgl2')!;
    gl.getExtension('WEBGL_lose_context')!.loseContext();
  });
  await expect(page.getByRole('alert')).toContainText('потерял графический контекст');
  await page.getByRole('button', { name: 'Повторить запуск 3D' }).click();
  await ready(page);
  expect(errors).toEqual([]);
});

test('unavailable WebGL shows an actionable error, retry works and 2D stays available', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    let remainingFailures = 1;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type === 'webgl2' && remainingFailures-- > 0) return null;
      return original.call(this, type, ...args);
    } as typeof original;
  });
  await open3D(page);
  await expect(page.getByRole('alert')).toContainText('WebGL 2 недоступен');
  await expect(canvas(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Повторить запуск 3D' }).click();
  await ready(page);
  await page.getByRole('button', { name: '2D · Sprint Layout', exact: true }).click();
  await expect(page.locator('.bp2d-canvas-wrap canvas')).toBeVisible();
  expect(errors).toEqual([]);
});

// Три кнопки шапки (2D, 3D и меню) сведены в одну: у неё две зоны — открыть
// предпросмотр и выбрать режим.
test('toolbar keeps one preview button for 2D and 3D', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(d => localStorage.setItem('lauaut.autosave', JSON.stringify(d)), doc);
  await page.goto('/');
  const toolbar = page.locator('.toolbar');
  await expect(toolbar.locator('.tb-split')).toHaveCount(1);
  // отдельных кнопок 2D и 3D в шапке больше нет — режимы переехали в меню
  await expect(toolbar.locator('.tb-btn[title^="2D предпросмотр"]')).toHaveCount(0);
  await expect(toolbar.locator('.tb-btn[title^="3D предпросмотр"]')).toHaveCount(0);
  await expect(previewMain(page)).toHaveAttribute('title', 'Предпросмотр платы: 2D — Sprint Layout');
  // выбор 3D в переключателе открывает окно сразу в объёмном режиме
  await previewToggle(page).click();
  await previewItem(page, '3D предпросмотр — объёмная плата').click();
  await expect(page.getByRole('button', { name: '3D · Объёмный вид', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(page.locator('.board-preview-modal')).toHaveCount(0);
  // кнопка помнит режим: основная часть открывает последний выбранный
  await expect(previewMain(page)).toHaveAttribute('title', 'Предпросмотр платы: 3D — объёмная плата');
  await previewMain(page).click();
  await expect(page.getByRole('button', { name: '3D · Объёмный вид', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // переключение внутри окна тоже запоминается
  await page.getByRole('button', { name: '2D · Sprint Layout', exact: true }).click();
  await expect(page.locator('.bp2d-canvas-wrap canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await expect(previewMain(page)).toHaveAttribute('title', 'Предпросмотр платы: 2D — Sprint Layout');
  await previewMain(page).click();
  await expect(page.getByRole('button', { name: '2D · Sprint Layout', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});
