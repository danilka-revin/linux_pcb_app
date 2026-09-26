import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
// Independent KiCad Module.pretty provider. Only fixed GitHub repository paths
// are fetched; clients cannot supply an upstream URL.
import { parsePartReelIndex, searchPartReel } from './partreel-search.mjs';
const base = 'https://api.github.com/repos/KiCad/kicad-footprints/contents/Module.pretty';
const cache = new Map();
async function github(path, fetcher) {
  const hit = cache.get(path);
  if (hit && hit.until > Date.now()) return hit.promise;
  const promise = (async () => {
    let response;
    try { response = await fetcher(base + path, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'PSBees-PCB' },
      signal: AbortSignal.timeout(25000),
    }); } catch (error) {
      // Match the main server's fallback for installations where Node cannot
      // access system certificates/proxies. URL is constructed above, never user-supplied.
      if (fetcher !== fetch) throw error;
      const { stdout } = await execFileAsync('curl', ['-sS', '--fail', '--max-time', '25', '--max-filesize', '4194304', '-H', 'Accept: application/vnd.github+json', '-A', 'PSBees-PCB', base + path], { timeout: 28000, maxBuffer: 4194304 });
      response = new Response(stdout);
    }
    if (!response.ok) throw new Error(`KiCad / GitHub HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('Ответ KiCad слишком большой.');
    return JSON.parse(text);
  })();
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(path, { promise, until: Date.now() + 3600000 });
  try { return await promise; } catch (e) { cache.delete(path); throw e; }
}
export async function handleModules(req, res, url, fetcher = fetch) {
  if (!url.pathname.startsWith('/api/modules/')) return false;
  const send = (status, data, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    return true;
  };
  if (req.method !== 'GET') return send(405, { error: 'Каталог поддерживает только GET.' });
  try {
    if (url.pathname === '/api/modules/search') {
      const query = (url.searchParams.get('q') || '').trim();
      if (!query || query.length > 120) return send(400, { error: 'Введите запрос длиной до 120 символов.' });
      const rows = await github('', fetcher);
      if (!Array.isArray(rows)) throw new Error('Некорректный индекс KiCad.');
      const parts = rows.filter(r => r.type === 'file' && Buffer.byteLength(r.name) <= 60 && /^[\w.+-]+\.kicad_mod$/.test(r.name)).map(r => ({
        id: Buffer.from(r.name).toString('hex'), name: r.name.replace('.kicad_mod', '').replaceAll('_', ' '),
        category: 'module', family: 'KiCad Module.pretty', manufacturer: '',
        keywords: `module breakout модули ${/Arduino/i.test(r.name) ? 'ардуино' : ''}`, verified: false,
      }));
      const index = parsePartReelIndex(parts);
      return send(200, searchPartReel(index, {
        query, category: url.searchParams.get('category') || 'all', verifiedOnly: url.searchParams.get('verified') === 'true',
      }));
    }
    const match = /^\/api\/modules\/(detail|raw)\/([a-f0-9]{2,120})$/.exec(url.pathname);
    if (!match) return send(404, { error: 'Неизвестный маршрут модулей.' });
    const name = Buffer.from(match[2], 'hex').toString('utf8');
    if (Buffer.from(name).toString('hex') !== match[2] || !/^[\w.+-]+\.kicad_mod$/.test(name) || name.includes('..')) return send(400, { error: 'Некорректное имя модуля.' });
    const data = await github('/' + encodeURIComponent(name), fetcher);
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('Файл модуля не найден.');
    const source = Buffer.from(data.content, 'base64').toString('utf8');
    if (match[1] === 'raw') return send(200, source, 'text/plain; charset=utf-8');
    return send(200, {
      name: name.replace('.kicad_mod', ''), source: 'KiCad', verified: false,
      license: 'CC-BY-SA-4.0 WITH KiCad-libraries-exception',
      page: `https://github.com/KiCad/kicad-footprints/blob/master/Module.pretty/${encodeURIComponent(name)}`,
      dimensions_source: `KiCad Module.pretty; blob ${data.sha}`,
      files: { footprint: `/api/modules/raw/${match[2]}` },
    });
  } catch (e) { return send(502, { error: e.message || 'KiCad недоступен.' }); }
}
