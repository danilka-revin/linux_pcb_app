// Проверка локального сервера: экспорт startServer, /healthz, /version, без автозапуска при import.
// Плюс проверка установки: файлы программы, скопированные «плоско» (как в
// ~/.local/share/psbees), должны запускаться — иначе забытый модуль (partreel-search.mjs)
// снова превратится в ERR_MODULE_NOT_FOUND у пользователя.
import { startServer } from '../scripts/server.mjs';
import { runtimeFiles, missingRuntimeFiles } from '../scripts/runtime-files.mjs';
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof startServer !== 'function') throw new Error('startServer не экспортирован');

const dir = mkdtempSync(join(tmpdir(), 'layaut-srv-'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ok</title>');
writeFileSync(join(dir, 'version.json'), JSON.stringify({ sha: 'deadbeef', short: 'deadbee', built: '2026-01-01' }));

const { url, server, port } = await startServer({ port: 0, host: '127.0.0.1', root: dir });
if (!port || port < 1) throw new Error('ожидался выделенный порт, получено ' + port);

const health = await (await fetch(url + '/healthz')).json();
if (health.ok !== true) throw new Error('healthz: ' + JSON.stringify(health));

const ver = await (await fetch(url + '/version')).json();
if (ver.short !== 'deadbee') throw new Error('version: ' + JSON.stringify(ver));

const page = await (await fetch(url + '/')).text();
if (!page.includes('<title>ok</title>')) throw new Error('index не отдался');
const spa = await fetch(url + '/projects/123');
if (spa.status !== 200 || !(await spa.text()).includes('<title>ok</title>')) throw new Error('SPA-навигация должна возвращать index.html');
const missingAsset = await fetch(url + '/assets/missing.js');
if (missingAsset.status !== 404 || (await missingAsset.text()).includes('<title>ok</title>')) throw new Error('отсутствующий скрипт не должен маскироваться index.html');
const malformedPath = await fetch(url + '/%E0%A4');
if (malformedPath.status !== 400) throw new Error('некорректная URL-кодировка должна возвращать 400');
const config = await (await fetch(url + '/api/cloud/config')).json();
if (config.enabled !== false) throw new Error('обычный сервер не должен требовать учётные записи');
const noCloud = await fetch(url + '/api/cloud/projects');
if (noCloud.status !== 404 || !noCloud.headers.get('content-type').includes('json')) throw new Error('отключённый API не должен отдавать HTML');

// Каталог: поиск валидирует запрос до загрузки сети, а raw endpoint не становится SSRF-прокси.
const emptyCatalogSearch = await fetch(url + '/api/footprints/search');
if (emptyCatalogSearch.status !== 400) throw new Error('empty catalog search should be rejected locally');
const badPartPath = await fetch(url + '/api/footprints/raw?path=' + encodeURIComponent('https://example.com/secret.kicad_mod'));
if (badPartPath.status !== 400) throw new Error('raw endpoint должен отклонять внешние URL');
const badPartDetail = await fetch(url + '/api/footprints/detail/bad.part');
if (badPartDetail.status !== 404) throw new Error('detail endpoint должен отклонять некорректный id');

// обновление: статус (с номером ревизии для long-poll), отмена без запущенного обновления
const us = await (await fetch(url + '/update/status')).json();
if (us.status !== 'idle' || typeof us.rev !== 'number' || !Array.isArray(us.stages)) throw new Error('update/status: ' + JSON.stringify(us));
const t0 = Date.now();
const us2 = await (await fetch(url + '/update/status?since=' + (us.rev + 1))).json(); // ревизия уже другая — ответ сразу
if (Date.now() - t0 > 2000 || us2.rev !== us.rev) throw new Error('update/status long-poll не ответил сразу');
const cr = await fetch(url + '/update/cancel', { method: 'POST' });
if (cr.status !== 409) throw new Error('update/cancel без обновления должен вернуть 409, а вернул ' + cr.status);
// хэшированные ассеты кэшируются навсегда, index.html — нет
if ((await fetch(url + '/')).headers.get('cache-control') !== 'no-cache') throw new Error('index.html не должен кэшироваться');

// --- установка: плоская раскладка файлов программы ---
// Так программа лежит в ~/.local/share/psbees: server.mjs рядом со своими модулями.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = mkdtempSync(join(tmpdir(), 'layaut-app-'));

/** Запускает установленную копию сервера и ждёт адрес из её вывода. */
async function startInstalled(dir) {
  const child = spawn(process.execPath, [join(dir, 'server.mjs'), '--app-dir', dir, '0', dir], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const childUrl = await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('сервер установки не запустился: ' + out)), 20_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const found = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolvePromise(found[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('сервер установки завершился (код ' + code + '): ' + out));
    });
  });
  return { child, url: childUrl };
}

try {
  for (const rel of runtimeFiles(root)) copyFileSync(join(root, rel), join(appDir, basename(rel)));
  const gaps = missingRuntimeFiles(appDir);
  if (gaps.length) throw new Error('в установке не хватает модулей: ' + gaps.join(', '));

  // установщики должны брать список файлов из манифеста, а не перечислять модули руками:
  // ручной список уже один раз разошёлся с кодом (partreel-search.mjs)
  for (const rel of ['install-ubuntu.sh', 'scripts/update.mjs']) {
    if (!readFileSync(join(root, rel), 'utf8').includes('runtime-files.mjs')) {
      throw new Error(rel + ' не использует манифест scripts/runtime-files.mjs');
    }
  }

  const installed = await startInstalled(appDir);
  try {
    const health2 = await (await fetch(installed.url + '/healthz')).json();
    if (health2.ok !== true) throw new Error('установка: /healthz — ' + JSON.stringify(health2));
    const noQuery = await fetch(installed.url + '/api/footprints/search');
    if (noQuery.status !== 400) throw new Error('установка: пустой запрос каталога должен отклоняться без модуля, код ' + noQuery.status);
    // с запросом каталог доходит до загрузки индекса: без сети это ошибка PartReel,
    // но не «модуль не установлен» — значит partreel-search.mjs действительно загрузился
    const catalog = await fetch(installed.url + '/api/footprints/search?q=resistor');
    const catalogBody = await catalog.text();
    if (catalogBody.includes('не установлен')) throw new Error('установка: модуль каталога не скопирован — ' + catalogBody);
  } finally {
    installed.child.kill('SIGTERM');
  }

  // Неполная установка (старый установщик не скопировал partreel-search.mjs) не должна
  // ронять сервер при запуске: каталог отвечает понятной ошибкой, программа работает.
  rmSync(join(appDir, 'partreel-search.mjs'), { force: true });
  if (!missingRuntimeFiles(appDir).includes('partreel-search.mjs')) throw new Error('проверка установки не заметила отсутствующий модуль');
  const broken = await startInstalled(appDir);
  try {
    const health3 = await (await fetch(broken.url + '/healthz')).json();
    if (health3.ok !== true) throw new Error('неполная установка не запустилась: ' + JSON.stringify(health3));
    const catalog = await (await fetch(broken.url + '/api/footprints/search?q=resistor')).text();
    if (!catalog.includes('не установлен')) throw new Error('неполная установка: ожидалась подсказка про модуль каталога, получено ' + catalog.slice(0, 160));
  } finally {
    broken.child.kill('SIGTERM');
  }
} finally {
  rmSync(appDir, { recursive: true, force: true });
}

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('server OK', url);
