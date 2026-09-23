#!/usr/bin/env node
// Лёгкий статический сервер для ЛайАут (без внешних зависимостей).
// Использование: node server.mjs [порт] [корень] — по умолчанию 8080 и ./dist рядом.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = process.env.HOST || '0.0.0.0';
// корень: argv[3] → env WWW_ROOT → ./dist рядом со скриптом/проектом
const ROOT = resolve(process.argv[3] || process.env.WWW_ROOT || (await pickRoot()));

async function pickRoot() {
  for (const p of [join(process.cwd(), 'dist'), join(here, 'dist'), join(here, '..', 'dist')]) {
    try {
      if ((await stat(p)).isDirectory()) return p;
    } catch { /* нет */ }
  }
  return join(here, 'dist');
}

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

createServer(async (req, res) => {
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
}).listen(PORT, HOST, () => {
  console.log(`ЛайАут: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}  (корень: ${ROOT})`);
  console.log(`http://localhost:${PORT}/healthz`);
});
