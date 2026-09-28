import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { unzip } from '../src/pcb/zip';
import type { Doc } from '../src/pcb/model';

const board: Doc = { name: 'CNC browser', w: 50, h: 30, entities: [
  { id: 'outline', kind: 'rect', x: 0, y: 0, w: 50, h: 30, th: .2, filled: false, layer: 'outline' },
  { id: 'p1', kind: 'pad', shape: 'round', x: 8, y: 7, size: 2, drill: .8 },
  { id: 'p2', kind: 'pad', shape: 'square', x: 35, y: 22, size: 2, drill: 1 },
  { id: 't1', kind: 'track', w: .6, layer: 'k1', pts: [{ x: 8, y: 7 }, { x: 20, y: 7 }, { x: 35, y: 22 }] },
  { id: 't2', kind: 'track', w: .6, layer: 'k2', pts: [{ x: 8, y: 7 }, { x: 8, y: 22 }, { x: 35, y: 22 }] },
] };

test('real CAM worker, every operation, animation, ZIP and responsive layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(d => localStorage.setItem('lauaut.autosave', JSON.stringify(d)), board);
  await page.goto('/');
  await page.locator('.canvas-over').waitFor();
  await page.keyboard.press('Control+e');
  await page.getByRole('button', { name: 'Настроить и скачать CNC ZIP…' }).click();
  await page.getByLabel('Проходов по глубине').fill('3');
  await page.getByRole('tab', { name: 'Отверстия' }).click();
  await page.getByLabel('Проходов по глубине').fill('6');
  await page.getByRole('tab', { name: 'Контур', exact: true }).click();
  await page.getByLabel('Вырезать контур', { exact: true }).check();
  await page.getByLabel('Проходов по глубине').fill('4');
  await page.getByRole('button', { name: 'Построить и показать' }).click();
  await expect(page.getByRole('button', { name: 'Скачать CNC ZIP' })).toBeEnabled();
  const operation = page.getByLabel('Операция предпросмотра');
  await expect(operation.locator('option')).toHaveCount(5);
  await page.getByRole('button', { name: '▶ Демонстрация' }).click();
  await expect.poll(async () => Number(await page.getByLabel('Ход демонстрации').inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Пауза', exact: true }).click();
  for (const [name, count] of [['02_niz_k2_zerkalo_x.nc', 3], ['sverlo_0p8mm_verh.nc', 6], ['99_kontur_poslednim.nc', 4]] as const) {
    await operation.selectOption(name);
    await page.getByLabel('Ход демонстрации').fill('1000');
    await expect(page.locator('.cnc-preview-stats')).toContainText(`Проход ${count} / ${count}`);
    await expect(page.locator('.cnc-preview-stats')).toContainText('Z 3 мм');
    await expect(page.locator('.cnc-preview-stats')).toContainText('Готово');
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Скачать CNC ZIP' }).click()]);
  expect(await download.failure()).toBeNull();
  const files = await unzip(await readFile((await download.path())!));
  const top = new TextDecoder().decode(files.get('01_verh_k1.nc'));
  expect(top).toContain('G1 Z-0.04'); expect(top).toContain('G1 Z-0.08'); expect(top).toContain('G1 Z-0.12');
  const drills = new TextDecoder().decode(files.get('sverlo_0p8mm_verh.nc'));
  expect(drills.match(/^G1 Z/gm)).toHaveLength(6);
  const outline = new TextDecoder().decode(files.get('99_kontur_poslednim.nc'));
  expect(outline.match(/^G1 Z/gm)).toHaveLength(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.cnc-modal').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Скачать CNC ZIP' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Скачать CNC ZIP' })).toBeInViewport();
  await page.getByLabel('Проходов по глубине').fill('5');
  await expect(page.getByRole('button', { name: 'Скачать CNC ZIP' })).toBeDisabled();
  await expect(page.locator('.cnc-preview')).toHaveCount(0);
  expect(errors).toEqual([]);
});
