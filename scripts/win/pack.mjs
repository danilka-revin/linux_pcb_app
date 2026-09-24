#!/usr/bin/env node
// Сборка Windows-приложения: PSBees.exe + установщик PSBees-Setup.exe.
// Запуск: npm run dist:win
//   • на Windows — NSIS-установщик и portable exe;
//   • на Linux без wine electron-builder не соберёт NSIS. Используйте
//     GitHub Actions (шаблон scripts/win/windows.yml) или машину с Windows.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'package.json'));

const ELECTRON_VER = '33.4.11';
const BUILDER_VER = '25.1.8';

function hasPkg(name) {
  try { require.resolve(name); return true; } catch { return false; }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  });
  if (r.status) process.exit(r.status);
}

if (!hasPkg('electron') || !hasPkg('electron-builder')) {
  console.log(`==> установка electron@${ELECTRON_VER} и electron-builder@${BUILDER_VER} (только для упаковки, в package.json не пишем)`);
  run('npm', [
    'install', '--no-save', '--no-audit', '--no-fund',
    `electron@${ELECTRON_VER}`, `electron-builder@${BUILDER_VER}`,
  ]);
}

const extra = process.argv.slice(2);
const targets = extra.length ? extra : ['--win', '--x64'];
if (process.platform !== 'win32') {
  console.log('Замечание: NSIS-установщик (.exe) собирается на Windows (GitHub Actions).');
}
console.log('==> electron-builder', targets.join(' '));
run('npx', ['electron-builder', ...targets]);
console.log('==> готово. Файлы — в каталоге release/: PSBees-Setup-*.exe и PSBees-portable-*.exe');
