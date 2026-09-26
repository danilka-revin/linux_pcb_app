import { handleModules } from './scripts/modules-api.mjs';
import { defineConfig, type Plugin, type PreviewServer, type ProxyOptions, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parsePartReelIndex, searchPartReel } from './scripts/partreel-search.mjs';

let devIndexPromise: ReturnType<typeof fetchDevIndex> | null = null;
async function fetchDevIndex() {
  const response = await fetch('https://partreel.com/api/v1/parts.json', {
    headers: { accept: 'application/json', 'user-agent': 'PSBees-PCB/0.1' },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`PartReel HTTP ${response.status}`);
  const raw: unknown = await response.json();
  return parsePartReelIndex(raw);
}

function installPartReelSearch(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://vite.local');
    if (!url.pathname.startsWith('/api/modules/')) return next();
    void handleModules(req, res, url).catch(next);
  });
  server.middlewares.use('/api/footprints/search', (req, res) => {
    const request = req as unknown as { method?: string; url?: string };
    if (request.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Каталог поддерживает только GET.' }));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://vite.local');
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query || query.length > 120) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: 'Введите поисковый запрос длиной до 120 символов.' }));
      return;
    }
    if (!devIndexPromise) {
      devIndexPromise = fetchDevIndex().catch((error) => {
        devIndexPromise = null;
        throw error;
      });
    }
    const category = ['all', 'smd', 'modules'].includes(url.searchParams.get('category') ?? '')
      ? url.searchParams.get('category')! : 'all';
    const verifiedOnly = url.searchParams.get('verified') === 'true';
    void devIndexPromise.then((index) => {
      const result = searchPartReel(index, { query, category, verifiedOnly, limit: 40 });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(result));
    }).catch((error: unknown) => {
      res.statusCode = 502;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'PartReel недоступен.' }));
    });
  });
}

const partReelSearch: Plugin = {
  name: 'partreel-catalog-search',
  configureServer: installPartReelSearch,
  configurePreviewServer: installPartReelSearch,
};

// В dev-режиме без общего сервера интерфейс остаётся офлайн. При необходимости
// PSBEES_CLOUD_BACKEND=http://127.0.0.1:8080 проксирует API того же происхождения.
const cloudBackend = process.env.PSBEES_CLOUD_BACKEND;
const offlineCloud: Plugin = {
  name: 'cloud-offline-config',
  configureServer(server) {
    if (!cloudBackend) server.middlewares.use('/api/cloud', (req, res) => {
      res.statusCode = req.method === 'GET' && req.url === '/config' ? 200 : 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(res.statusCode === 200
        ? { ok: true, enabled: false }
        : { ok: false, error: 'Облачный сервер не подключён.' }));
    });
  },
  configurePreviewServer(server) {
    if (!cloudBackend) server.middlewares.use('/api/cloud', (req, res) => {
      res.statusCode = req.method === 'GET' && req.url === '/config' ? 200 : 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(res.statusCode === 200
        ? { ok: true, enabled: false }
        : { ok: false, error: 'Облачный сервер не подключён.' }));
    });
  },
};

const footprintProxy: ProxyOptions = {
  target: 'https://partreel.com',
  changeOrigin: true,
  secure: true,
  rewrite(path) {
    const detail = /^\/api\/footprints\/detail\/([^/?#]+)$/.exec(path);
    if (detail && /^[A-Za-z0-9_-]{1,120}$/.test(decodeURIComponent(detail[1]))) {
      return `/api/v1/parts/${encodeURIComponent(decodeURIComponent(detail[1]))}.json`;
    }
    if (path.startsWith('/api/footprints/raw')) {
      const u = new URL(path, 'http://vite.local');
      const raw = u.searchParams.get('path') ?? '';
      if (/^\/library\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+\.kicad_mod$/.test(raw) && !raw.includes('..')) return raw;
    }
    return '/__psbees_invalid_footprint_request__';
  },
};

export default defineConfig({
  plugins: [react(), partReelSearch, offlineCloud],
  server: {
    host: true,
    port: 5173,
    allowedHosts: true,
    proxy: {
      '^/api/footprints/(detail/|raw)': footprintProxy,
      ...(cloudBackend ? { '^/api/cloud': { target: cloudBackend, changeOrigin: false } } : {}),
    },
  },
  preview: {
    host: true,
    port: 4173,
    allowedHosts: true,
    proxy: {
      '^/api/footprints/(detail/|raw)': footprintProxy,
      ...(cloudBackend ? { '^/api/cloud': { target: cloudBackend, changeOrigin: false } } : {}),
    },
  },
});
