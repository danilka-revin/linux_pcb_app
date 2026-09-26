import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'board-preview-browser.spec.ts',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: '../node_modules/.cache/preview-browser-results',
  use: {
    baseURL: process.env.PSBEES_TEST_URL || 'http://127.0.0.1:5174',
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      executablePath: process.env.PSBEES_TEST_BROWSER || undefined,
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: process.env.PSBEES_TEST_URL ? undefined : {
    command: 'npm run dev -- --host 0.0.0.0 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env.CI,
  },
});
