#!/usr/bin/env node
// Лёгкий статический сервер для PSBees (без внешних зависимостей).
// Использование: node server.mjs [порт] [корень] — по умолчанию 8080 и ./dist рядом.
// Ключи:
//   --self                    — сервер запущен из клона репозитория (dev/песочница);
//   --app-dir <dir>           — установленная программа (каталог с dist/, repo.txt, update.mjs).
// Также: import { startServer } from './server.mjs' (окно Electron на Windows).
//
// Кнопка «Обновить с main» (HTTP):
//   GET  /update/check  — сверить установленную версию с веткой main на GitHub;
//   POST /update/run    — обновить (git fetch+merge+npm ci+build либо scripts/update.mjs);
//   GET  /update/status — ход выполнения.
// Установленная программа после обновления перезапускает сама себя (тот же порт);
// standalone-клон (--self) не перезапускается — страницу перезагружает браузер.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';

const here = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO = 'https://github.com/danilka-revin/linux_pcb_app.git';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.lay6': 'application/octet-stream',
  '.lmk': 'application/octet-stream',
};

async function pickRoot() {
  for (const p of [join(process.cwd(), 'dist'), join(here, 'dist'), join(here, '..', 'dist')]) {
    try {
      if ((await stat(p)).isDirectory()) return p;
    } catch { /* нет */ }
  }
  return join(here, 'dist');
}

function samePath(a, b) {
  const na = resolve(a), nb = resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function listen(server, port, host) {
  return new Promise((resolveP, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    server.listen(port, host, () => {
      server.off('error', onErr);
      resolveP();
    });
  });
}

// ---------- вспомогательное ----------
const execFileP = (cmd, args, opts = {}) => new Promise((resolveP) => {
  execFile(cmd, args, {
    ...opts,
    timeout: opts.timeout ?? 900000,
    windowsHide: true,
  }, (err, stdout, stderr) => {
    resolveP({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

const hasCmd = async (c) => {
  const { err } = await execFileP(c, ['--version']);
  return !err;
};

async function gitP(args, opts = {}) {
  const r = await execFileP('git', args, opts);
  if (r.err) throw new Error((r.stderr || r.err.message || 'ошибка git').trim());
  return r.stdout.trim();
}

const short = (s) => String(s || '').slice(0, 7);

const firstLine = (err, max = 260) => (String(err || '').trim().split('\n')[0] || '').slice(0, max);

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// owner/repo из URL: https://github.com/OWNER/NAME(.git)
function repoInfo(repoUrl) {
  const m = /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(repoUrl || '');
  if (!m) return null;
  return { owner: m[1], name: m[2], url: `https://github.com/${m[1]}/${m[2]}.git` };
}

async function githubJson(url, timeout = 15000) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'layaut-pcb' },
  });
  if (!r.ok) throw new Error('GitHub HTTP ' + r.status);
  return r.json();
}

/** Репозиторий: у клона — из git remote, у установленной программы — repo.txt. */
async function discoverRepo(appHome) {
  try {
    const u = await gitP(['remote', 'get-url', 'origin'], { cwd: appHome });
    if (u) return u;
  } catch { /* нет remote/не git */ }
  try {
    const s = (await readFile(join(appHome, 'repo.txt'), 'utf8')).trim();
    if (s) return s;
  } catch { /* нет файла */ }
  return DEFAULT_REPO;
}

/** Скачать содержимое файла dist/version.json (sha, short). */
async function versionFromRoot(root) {
  try {
    const v = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
    return { sha: String(v.sha || ''), short: String(v.short || short(v.sha)) };
  } catch {
    return { sha: '', short: '' };
  }
}

/**
 * Поднять статический сервер.
 * @param {{ port?: number, host?: string, root?: string, fallbackPorts?: number,
 *           self?: boolean, appDir?: string }} [opts]
 * @returns {Promise<{ port: number, host: string, root: string, url: string, server: import('node:http').Server }>}
 */
export async function startServer(opts = {}) {
  // разбор ключей командной строки: --self, --app-dir <dir>, затем [порт] [корень]
  const argv = process.argv.slice(2);
  const cli = { port: null, root: null, appDir: null, self: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app-dir' || a === '--appdir') { cli.appDir = argv[++i]; continue; }
    if (a === '--self') { cli.self = true; continue; }
    if (/^\d+$/.test(a)) { cli.port = a; continue; }
    cli.root = a;
  }

  const preferred = Number(opts.port ?? cli.port ?? process.env.PORT ?? 8080);
  const HOST = opts.host || process.env.HOST || '0.0.0.0';
  const ROOT = resolve(opts.root || cli.root || process.env.WWW_ROOT || (await pickRoot()));
  const fallback = opts.fallbackPorts ?? 0;
  const explicitAppDir = opts.appDir || cli.appDir;
  // каталог приложения: у установленной программы — явный; у клона — корень репозитория
  const APP_DIR = explicitAppDir ? resolve(explicitAppDir) : (opts.self || cli.self ? resolve(join(here, '..')) : resolve(ROOT, '..'));
  const IS_SELF = (!!opts.self || cli.self) && !explicitAppDir;

  // как устроен «каталог приложения»:
  //  • git-клон — обновляем через git fetch + merge --ff-only;
  //  • установленная программа (без .git) — обновляем через scripts/update.mjs (tar.gz).
  const isGitClone = async () => {
    const t = await execFileP('git', ['-C', APP_DIR, 'rev-parse', '--is-inside-work-tree']);
    return !t.err;
  };
  const hasUpdateScript = async () => {
    try { await stat(join(APP_DIR, 'update.mjs')); return true; } catch { return false; }
  };

  // ветка, за которой следим (branch.txt), всегда main по умолчанию
  const appBranch = async () => {
    try {
      const s = (await readFile(join(APP_DIR, 'branch.txt'), 'utf8')).trim();
      if (s) return s;
    } catch { /* нет файла */ }
    return 'main';
  };

  // последний коммит ветки на GitHub: git ls-remote работает и без локального клона
  const latestOfBranch = async (branch) => {
    const repo = repoInfo(await discoverRepo(APP_DIR));
    if (!repo) throw new Error('Не удалось определить репозиторий GitHub (нет repo.txt и git remote).');
    const ls = await execFileP('git', ['ls-remote', repo.url, `refs/heads/${branch}`]);
    if (ls.err) throw new Error('Не удалось связаться с GitHub: ' + firstLine(ls.stderr, 180));
    const line = (ls.stdout || '').split('\n').find((l) => l.trim().endsWith(`refs/heads/${branch}`));
    const sha = line ? line.trim().split(/\s+/)[0] : '';
    if (!sha) throw new Error('GitHub не вернул коммит ветки ' + branch + '.');
    // сообщение и дата коммита — из API (не обязательно: сеть/сертификаты могут быть недоступны)
    let msg = '', date = '';
    try {
      const c = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.name}/commits/${sha}`);
      date = (c.commit && c.commit.committer && c.commit.committer.date) || '';
      msg = ((c.commit && c.commit.message) || '').split('\n')[0];
    } catch { /* обойдёмся без сообщения */ }
    return { sha, msg, date, repo: `${repo.owner}/${repo.name}` };
  };

  // ---------- проверка обновлений ----------
  const checkUpdate = async (res) => {
    try {
      const [gitOk, npmOk] = await Promise.all([hasCmd('git'), hasCmd('npm')]);
      const local = await versionFromRoot(ROOT);
      const latest = await latestOfBranch(await appBranch()); // также проверит repo

      let behind = 0;
      if (!local.sha) {
        behind = 1;
      } else if (local.sha !== latest.sha) {
        // сколько коммитов отстаём — по возможности через локальный клон
        behind = 1;
        if (gitOk && await isGitClone()) {
          const count = await execFileP('git', ['rev-list', '--count', `${local.sha}..${latest.sha}`], { cwd: APP_DIR, timeout: 30000 });
          if (!count.err && Number.isFinite(Number(count.stdout.trim()))) {
            behind = Number(count.stdout.trim()) || 1;
          }
        }
      }

      return json(res, 200, {
        ok: true,
        repo: latest.repo,
        branch: 'main',
        local: short(local.sha),
        latest: short(latest.sha),
        latestSha: latest.sha,
        latestMsg: latest.msg,
        latestDate: latest.date,
        behind,
        updateAvailable: behind > 0,
        tooling: { git: gitOk, npm: npmOk },
      });
    } catch (e) {
      return json(res, 502, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  };

  // ---------- выполнение обновления ----------
  const runUpdate = async (res, upd) => {
    if (upd.state.status === 'busy') return json(res, 409, { ok: false, error: 'Обновление уже выполняется. Подождите.' });
    let repoLabel = 'GitHub';
    try {
      const ri = repoInfo(await discoverRepo(APP_DIR));
      repoLabel = ri ? `${ri.owner}/${ri.name}` : 'GitHub';
    } catch { /* не критично */ }
    const local = await versionFromRoot(ROOT);
    upd.update({
      status: 'busy', started: new Date().toISOString(), done: null,
      from: short(local.sha), to: '', changes: 0,
      phase: 'Проверка наличия обновлений…', output: '', error: '',
    });

    (async () => {
      const log = (s) => upd.update({ phase: s, output: upd.state.output + (upd.state.output ? '\n' : '') + s });
      const finish = (patch) => upd.update({ done: new Date().toISOString(), ...patch });
      let useClone = false;
      try {
        if (!(await hasCmd('npm'))) throw new Error('На этом компьютере не найден npm — установите Node.js и повторите.');
        if (!(await hasCmd('git'))) throw new Error('На этом компьютере не найден git — установите его (sudo apt install git) и повторите.');

        useClone = await isGitClone();
        let head = '';
        let newSha = '';
        let changes = 0;

        if (useClone) {
          // -------- обновление git-клона --------
          log('Скачивание изменений из GitHub (git fetch origin main)…');
          const fr = await execFileP('git', ['fetch', '--no-tags', '--quiet', 'origin', 'main'], { cwd: APP_DIR });
          if (fr.err) throw new Error('Не удалось скачать обновления: ' + firstLine(fr.stderr, 240));

          head = (await gitP(['rev-parse', 'HEAD'], { cwd: APP_DIR }));
          const remote = (await gitP(['rev-parse', 'origin/main'], { cwd: APP_DIR }));
          const countR = await execFileP('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: APP_DIR });
          changes = countR.err ? 0 : (Number(countR.stdout.trim()) || 0);
          if (head === remote || changes === 0) {
            return finish({ status: 'done', to: short(remote), changes: 0, phase: 'Уже актуальная версия — новых коммитов в main нет.' });
          }

          const stR = await execFileP('git', ['status', '--porcelain'], { cwd: APP_DIR });
          if (stR.stdout.trim()) throw new Error('В рабочей копии есть незакоммиченные изменения. Сохраните их (git stash) или обновитесь командой git pull.');

          log(`Найдено новых коммитов: ${changes}. Применяем (git merge --ff-only origin/main)…`);
          const mg = await execFileP('git', ['merge', '--ff-only', '--no-edit', 'origin/main'], { cwd: APP_DIR });
          if (mg.err) throw new Error('Не удалось применить обновление (локальная ветка не из main или впереди неё): ' + firstLine(mg.stderr, 200));

          log('Установка зависимостей (npm ci)…');
          const ci = await execFileP('npm', ['ci', '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel=error'], { cwd: APP_DIR });
          if (ci.err) throw new Error('npm ci: ' + firstLine(ci.stderr || ci.stdout, 400));

          log('Сборка приложения (npm run build)…');
          const bd = await execFileP('npm', ['run', 'build', '--no-update-notifier'], { cwd: APP_DIR });
          if (bd.err) throw new Error('Сборка не удалась: ' + firstLine(bd.stderr || bd.stdout, 400));

          newSha = (await gitP(['rev-parse', 'HEAD'], { cwd: APP_DIR }));
        } else if (await hasUpdateScript()) {
          // -------- обновление установленной программы (update.mjs, скачивает tar.gz) --------
          log('Скачивание и сборка новой версии (scripts/update.mjs)…');
          const updRun = await execFileP(process.execPath, [join(APP_DIR, 'update.mjs'), '--app-dir', APP_DIR]);
          const rc = updRun.err && typeof updRun.err.code === 'number' ? updRun.err.code : (updRun.err ? 1 : 0);
          // update.mjs: 0 — обновлений нет/нет сети; 10 — обновлено; иначе ошибка
          const tail = (updRun.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join('\n');
          if (rc === 1 || (rc > 0 && rc !== 10)) {
            const msg = (updRun.stderr || '').trim() || tail || 'ошибка обновления';
            return finish({ status: 'error', error: msg.split('\n').slice(-3).join('\n'), phase: 'Обновление не удалось — работаем на текущей версии.' });
          }
          if (rc === 0) {
            // уже актуальная версия (или нет сети — update.mjs сам решил остаться на текущей)
            return finish({ status: 'done', to: local.short, changes: 0, phase: tail || 'Актуальная версия — обновлений нет.' });
          }
          log(tail || 'новая версия собрана');
          newSha = await readFile(join(APP_DIR, 'version.txt'), 'utf8').then((s) => s.trim()).catch(() => '');
          changes = 1;
        } else {
          throw new Error('Не удалось определить способ обновления: каталог программы не клон git и нет update.mjs. Обновитесь вручную: git pull && bash install-ubuntu.sh');
        }

        finish({
          status: 'done', from: short(local.sha || head), to: short(newSha),
          changes, phase: IS_SELF
            ? 'Обновление установлено. Перезагрузите страницу.'
            : 'Обновление установлено. Перезапускаем сервер…',
        });

        if (IS_SELF) return; // страницу перезагрузит браузер

        // перезапускаем сервер (тот же скрипт и аргументы) на том же порту
        setTimeout(() => {
          execFileP(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
            cwd: APP_DIR, detached: true, stdio: 'ignore',
          }).then(() => process.exit(0)).catch(() => process.exit(0));
        }, 400);
      } catch (e) {
        finish({ status: 'error', error: e && e.message ? e.message : String(e), phase: 'Обновление не удалось — работаем на текущей версии.' });
      }
    })();

    return json(res, 202, { ok: true, ...upd.state });
  };

  const updateStore = (() => {
    const state = {
      status: 'idle', phase: '', started: null, done: null,
      from: '', to: '', changes: 0, output: '', error: '',
    };
    return { state, update: (patch) => Object.assign(state, patch) };
  })();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (url.pathname === '/version') {
        try {
          const v = JSON.parse(await readFile(join(ROOT, 'version.json')));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...v }));
        } catch {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true,"sha":"dev"}');
        }
        return;
      }

      if (url.pathname.startsWith('/update/')) {
        const cmd = url.pathname.slice('/update/'.length);
        if (cmd === 'status') return json(res, 200, updateStore.state);
        if (cmd === 'check') return await checkUpdate(res);
        if (cmd === 'run') return await runUpdate(res, updateStore);
        return json(res, 404, { ok: false, error: 'неизвестная команда обновления' });
      }

      let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
      if (!path || path.endsWith('/')) path = join(path, 'index.html');
      const full = join(ROOT, path);
      if (!full.startsWith(ROOT)) { // защита от ../
        res.writeHead(403).end('forbidden');
        return;
      }
      let data, type = MIME[extname(full).toLowerCase()];
      try {
        data = await readFile(full);
      } catch {
        // SPA-fallback на index.html
        data = await readFile(join(ROOT, 'index.html'));
        type = 'text/html; charset=utf-8';
      }
      res.writeHead(200, {
        'content-type': type || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(data);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });

  let port = preferred;
  for (let i = 0; i <= fallback; i++) {
    try {
      await listen(server, port, HOST);
      break;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE' && i < fallback) {
        port = preferred === 0 ? 0 : port + 1;
        continue;
      }
      throw e;
    }
  }

  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  const urlHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const url = `http://${urlHost}:${actual}`;
  console.log(`PSBees: ${url}  (корень: ${ROOT})`);
  console.log(`${url}/healthz`);
  return { port: actual, host: HOST, root: ROOT, url, server };
}

const launchedDirectly = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return samePath(fileURLToPath(import.meta.url), entry)
      || import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
})();

if (launchedDirectly) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
