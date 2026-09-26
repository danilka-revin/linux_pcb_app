import { expect, test, type Page } from '@playwright/test';
import type { Doc } from '../src/pcb/model';

const doc: Doc = { name: 'Auto-layout regression', w: 60, h: 40, entities: [
  ...[[10, 10], [50, 10], [10, 30], [50, 30]].map(([x, y], i) => ({
    id: `c${i}`, kind: 'comp' as const, name: `C${i}`, lib: '', x, y, rot: 0, side: 'top' as const,
    bl: [-3, -3, 3, 3] as [number, number, number, number],
    ents: [
      { id: 'pin', kind: 'pad' as const, x: 0, y: 0, size: 2, drill: 0.8, shape: 'round' as const },
      { id: 'body', kind: 'rect' as const, x: -3, y: -3, w: 6, h: 6, filled: false, th: 0.1, layer: 's1' as const },
    ],
  })),
], nets: [{ id: 'n1', name: 'Signal', pads: ['c0:0', 'c1:0'] }, { id: 'n2', name: 'Ground', pads: ['c2:0', 'c3:0'] }] };
const saved = (page: Page): Promise<Doc> => page.evaluate(() => JSON.parse(localStorage.getItem('lauaut.autosave')!));
async function open(page: Page) {
  await page.addInitScript(d => localStorage.setItem('lauaut.autosave', JSON.stringify(d)), doc);
  await page.goto('/');
  await expect(page.getByTitle('Автокомпоновка компонентов', { exact: true })).toBeVisible();
}
async function openRouting(page: Page) {
  await page.getByRole('toolbar', { name: 'Инструменты' }).getByRole('button', { name: /^Автотрассировка/ }).click();
  await page.getByRole('button', { name: 'Группы / вся плата', exact: true }).click();
  await page.getByRole('button', { name: 'Рассчитать 3 варианта', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Выберите вариант трассировки групп' })).toBeVisible();
}

test('placement: preview is non-destructive, cancel, parameter invalidation, apply and single undo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page);
  const button = page.getByTitle('Автокомпоновка компонентов', { exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: 'Автокомпоновка компонентов', exact: true });
  await dialog.getByRole('button', { name: 'Рассчитать компоновку', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Применить компоновку' })).toBeEnabled();
  await expect(dialog.getByRole('status')).toContainText('Перемещается: 4');
  expect(await saved(page)).toEqual(doc);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await saved(page)).toEqual(doc);
  await button.click();
  await dialog.getByRole('button', { name: 'Рассчитать компоновку', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Применить компоновку' })).toBeEnabled();
  await dialog.getByLabel('Зазор между корпусами, мм').fill('1');
  await expect(dialog.getByRole('button', { name: 'Применить компоновку' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Рассчитать компоновку', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Применить компоновку' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Применить компоновку' }).click();
  await expect.poll(async () => JSON.stringify((await saved(page)).entities)).not.toEqual(JSON.stringify(doc.entities));
  expect((await saved(page)).nets).toEqual(doc.nets);
  await page.keyboard.press('Control+z');
  await expect.poll(() => saved(page)).toEqual(doc);
  expect(errors).toEqual([]);
});

test('right settings pane scrolls to all routing options', async ({ page }) => {
  await open(page);
  await page.getByRole('toolbar', { name: 'Инструменты' }).getByRole('button', { name: /^Автотрассировка/ }).click();

  const pane = page.locator('.side.right > .pane-full');
  await expect(pane).toHaveCSS('overflow-y', 'auto');
  const before = await pane.evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  expect(before.height).toBeGreaterThan(before.client);

  await pane.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Настроить…', exact: true })).toBeInViewport();
});

test('group routing: three summaries, selection preview, cancel, apply chosen result, undo/redo', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page);
  await openRouting(page);
  const dialog = page.getByRole('dialog', { name: 'Выберите вариант трассировки групп' });
  await expect(dialog.getByRole('radio')).toHaveCount(3);
  await expect(dialog.getByText('Новых переходов', { exact: true })).toHaveCount(3);
  expect(await saved(page)).toEqual(doc);
  // Editor hotkeys must not mutate the board underneath the choice dialog.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  await expect(dialog.getByRole('img', { name: /^Предпросмотр варианта/ })).toHaveCount(3);
  await dialog.getByRole('radio').nth(2).check();
  await expect(dialog.getByRole('img', { name: 'Предпросмотр варианта 3' })).toBeVisible();
  expect(await saved(page)).toEqual(doc);
  await dialog.getByRole('button', { name: 'Отмена — оставить плату' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await saved(page)).toEqual(doc);
  await page.getByRole('button', { name: 'Рассчитать 3 варианта', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio').nth(1).check();
  await dialog.getByRole('button', { name: 'Применить вариант 2' }).click();
  await expect.poll(async () => (await saved(page)).entities.length).toBeGreaterThan(doc.entities.length);
  const applied = await saved(page);
  expect(applied.entities.slice(0, doc.entities.length)).toEqual(doc.entities);
  await page.keyboard.press('Control+z');
  await expect.poll(() => saved(page)).toEqual(doc);
  await page.keyboard.press('Control+y');
  await expect.poll(() => saved(page)).toEqual(applied);
  await page.getByRole('button', { name: 'Две точки', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Рассчитать 3 варианта', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('group calculation can be cancelled without changing the board', async ({ page }) => {
  await open(page);
  // Delay the result so the cancellation path is deterministic even on a tiny board.
  await page.evaluate(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      postMessage() { /* deliberately keep the calculation pending */ }
    };
  });
  await page.getByRole('toolbar', { name: 'Инструменты' }).getByRole('button', { name: /^Автотрассировка/ }).click();
  await page.getByRole('button', { name: 'Группы / вся плата', exact: true }).click();
  await page.getByRole('button', { name: 'Рассчитать 3 варианта', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Расчёт трёх вариантов трассировки групп' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await saved(page)).toEqual(doc);
});
