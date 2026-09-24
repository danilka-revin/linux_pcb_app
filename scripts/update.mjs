#!/usr/bin/env node
// Автообновление ЛайАут из GitHub при запуске.
//
//   node scripts/update.mjs --app-dir <каталог установленной программы>
//
// Сценарий:
//   1. читаем repo.txt (URL репозитория, по умолчанию — GitHub danilka-revin)
//      и version.txt (SHA текущей установленной версии);
//   2. спрашиваем GitHub, какой последний коммит в ветке (по умолчанию main);
//   3. если он новее — скачиваем исходники (tar.gz), собираем (npm ci + build),
//      и только успешную сборку ставим в <app-dir>/dist, обновляем server.mjs
//      и version.txt. Старая версия остаётся в dist.old на случай отката.
//   4. если нет сети или что-то пошло не так — тихо остаёмся на текущей версии.
//
// Кода выхода: 0 — ничего не менялось; 10 — обновлено (вызывающему нужно
// перезапустить сервер); 1 — ошибка обновления (запуск продолжится как есть).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO = 'https://github.com/danilka-revin/linux_pcb_app.git';

function fail(msg) {
  console.error('автообновление: ' + msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const appDirRaw = args[args.indexOf('--app-dir') + 1];
if (!appDirRaw) fail('нужен аргумент --app-dir <каталог>');
const APP_DIR = resolve(appDirRaw);
if (!existsSync(APP_DIR)) fail('нет каталога приложения: ' + APP_DIR);

const read = (name, dflt) => {
  try {
    const s = readFileSync(join(APP_DIR, name), 'utf8').trim();
    return s || dflt;
  } catch {
    return dflt;
  }
};
const repoUrl = read('repo.txt', DEFAULT_REPO);
const branch = process.env.PCB_APP_BRANCH || read('branch.txt', 'main');
const currentSha = read('version.txt', '');

// owner/repo из URL: https://github.com/OWNER/NAME(.git)
const m = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(repoUrl);
if (!m) fail('не удалось разобрать URL репозитория: ' + repoUrl);
const [ , owner, name ] = m;

const log = (s) => console.log('автообновление: ' + s);

const hasCmd = (c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0;
const gitOk = hasCmd('git');
const npmOk = hasCmd('npm');
if (!npmOk) { log('npm не найден — обновление невозможно, остаёмся на текущей версии'); process.exit(0); }

// --- 1. последний коммит ветки в GitHub ---
const getCommit = async (ref) => {
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${name}/commits/${encodeURIComponent(ref)}`,
    { signal: AbortSignal.timeout(15000), headers: { accept: 'application/vnd.github+json' } },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
let latest;
try {
  latest = await getCommit(branch);
} catch (e) {
  log('нет связи с GitHub (' + (e?.message || e) + ') — остаёмся на текущей версии');
  process.exit(0);
}
if (!latest) fail('GitHub не вернул коммит ветки ' + branch);
const short = (s) => (s || '').slice(0, 7);
const latestDate = latest.commit?.committer?.date || '';
if (currentSha && currentSha === latest.sha) {
  log('актуальная версия ' + short(currentSha) + ' — обновляться не нужно');
  process.exit(0);
}
// версия может быть установлена из ветки разработки (новее main) или быть
// локальной (не в GitHub): не откатываем назад
if (currentSha && currentSha !== latest.sha) {
  let cur;
  try {
    cur = await getCommit(currentSha);
  } catch {
    log('не удалось проверить текущую версию — остаёмся на ней');
    process.exit(0);
  }
  const curDate = cur?.commit?.committer?.date || '';
  if (!cur || (curDate && curDate >= latestDate)) {
    log('установленная версия не старше ' + branch + ' — обновляться не нужно');
    process.exit(0);
  }
}
log('найдена новая версия: ' + short(latest.sha) + (currentSha ? ' (текущая ' + short(currentSha) + ')' : ' (версия не зафиксирована)'));

// --- 2. скачивание и сборка ---
let work;
try {
  work = mkdtempSync(join(tmpdir(), 'layaut-upd-'));
  const ball = join(work, 'src.tar.gz');
  const dl = await fetch(`https://codeload.github.com/${owner}/${name}/tar.gz/${latest.sha}`, {
    signal: AbortSignal.timeout(120000),
  });
  if (!dl.ok) throw new Error('скачивание HTTP ' + dl.status);
  writeFileSync(ball, Buffer.from(await dl.arrayBuffer()));
  const src = join(work, 'src');
  mkdirSync(src);
  const ex = spawnSync('tar', ['-xzf', ball, '--strip-components=1', '-C', src], { stdio: 'pipe' });
  if (ex.status !== 0) throw new Error('tar: ' + ex.stderr.toString().slice(0, 200));
  if (!existsSync(join(src, 'package.json'))) throw new Error('в архиве нет package.json');

  log('установка зависимостей (npm ci)…');
  const ci = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'], {
    cwd: src, stdio: 'pipe', env: process.env, timeout: 900000,
  });
  if (ci.status !== 0) throw new Error('npm ci: ' + ci.stderr.toString().slice(-300));

  log('сборка новой версии…');
  const bd = spawnSync('npm', ['run', 'build', '--no-update-notifier'], {
    cwd: src, stdio: 'pipe', env: process.env, timeout: 900000,
  });
  if (bd.status !== 0) throw new Error('build: ' + (bd.stderr.toString() || bd.stdout.toString()).slice(-300));
  if (!existsSync(join(src, 'dist', 'index.html'))) throw new Error('сборка не создала dist/index.html');

  // --- 3. установка: новая сборка заменяет старую только целиком ---
  const newDist = join(src, 'dist');
  cpSync(newDist, join(APP_DIR, 'dist.new'), { recursive: true });
  rmSync(join(APP_DIR, 'dist.old'), { recursive: true, force: true });
  if (existsSync(join(APP_DIR, 'dist'))) {
    renameMove(join(APP_DIR, 'dist'), join(APP_DIR, 'dist.old'));
  }
  renameMove(join(APP_DIR, 'dist.new'), join(APP_DIR, 'dist'));
  for (const f of ['server.mjs', 'icon.svg']) {
    const from = join(src, 'scripts', f);
    if (existsSync(from)) cpSync(from, join(APP_DIR, f));
  }
  writeFileSync(join(APP_DIR, 'version.txt'), latest.sha + '\n');
  writeFileSync(join(APP_DIR, 'update.log'),
    new Date().toISOString() + ' обновлено до ' + short(latest.sha) + ' (' + branch + ')\n');
  log('готово: установлена версия ' + short(latest.sha));
  rmSync(work, { recursive: true, force: true });
  process.exit(10);
} catch (e) {
  log('обновление не удалось, остаёмся на текущей версии (' + (e?.message || e) + ')');
  if (work) rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// rename между каталогами: mv (атомарно на одной ФС)
function renameMove(from, to) {
  const r = spawnSync('mv', [from, to], { stdio: 'pipe' });
  if (r.status !== 0) throw new Error('mv ' + from + ': ' + r.stderr.toString().slice(0, 200));
}
