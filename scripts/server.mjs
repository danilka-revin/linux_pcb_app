#!/usr/bin/env node
// Лёгкий статический сервер для ЛайАут (без внешних зависимостей).
// Использование: node server.mjs [порт] [корень] — по умолчанию 8080 и ./dist рядом.
// Также: import { startServer } from './server.mjs' (окно Electron на Windows).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

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

/**
 * Поднять статический сервер.
 * @param {{ port?: number, host?: string, root?: string, fallbackPorts?: number }} [opts]
 * @returns {Promise<{ port: number, host: string, root: string, url: string, server: import('node:http').Server }>}
 */
export async function startServer(opts = {}) {
  const preferred = Number(opts.port ?? process.env.PORT ?? process.argv[2] ?? 8080);
  const HOST = opts.host || process.env.HOST || '0.0.0.0';
  const ROOT = resolve(opts.root || process.argv[3] || process.env.WWW_ROOT || (await pickRoot()));
  const fallback = opts.fallbackPorts ?? 0;

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
  console.log(`ЛайАут: ${url}  (корень: ${ROOT})`);
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
