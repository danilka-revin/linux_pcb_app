import { defineConfig } from '@playwright/test';
import preview from './preview.playwright.config';

export default defineConfig({
  ...preview,
  testMatch: 'auto-layout-browser.spec.ts',
  outputDir: '../node_modules/.cache/auto-layout-browser-results',
});
