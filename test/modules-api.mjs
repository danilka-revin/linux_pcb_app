import assert from 'node:assert/strict';
import { handleModules } from '../scripts/modules-api.mjs';
import { createServer } from 'node:http';
const name = 'Arduino_Nano.kicad_mod';
const id = Buffer.from(name).toString('hex');
const raw = '(footprint "Arduino_Nano" (layer "F.Cu") (pad "1" thru_hole circle (at 0 0) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask")))';
let calls = 0;
const fakeFetch = async (url) => {
  calls++;
  assert.ok(url.startsWith('https://api.github.com/repos/KiCad/kicad-footprints/contents/Module.pretty'));
  return new Response(JSON.stringify(url.endsWith('Module.pretty')
    ? [{ name, type: 'file' }, { name: 'README.md', type: 'file' }]
    : { encoding: 'base64', content: Buffer.from(raw).toString('base64'), sha: 'test-sha' }));
};
const server = createServer(async (req, res) => {
  await handleModules(req, res, new URL(req.url, 'http://test'), fakeFetch);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/modules`;
try {
  assert.equal((await fetch(`${base}/search`)).status, 400);
  assert.equal((await fetch(`${base}/search?q=Arduino`, { method: 'POST' })).status, 405);
  const result = await (await fetch(`${base}/search?q=Arduino&category=modules`)).json();
  assert.equal(result.count, 1);
  assert.equal(result.results[0].id, id);
  assert.equal((await (await fetch(`${base}/search?q=Arduino&verified=true`)).json()).count, 0);
  const detail = await (await fetch(`${base}/detail/${id}`)).json();
  assert.equal(detail.license, 'CC-BY-SA-4.0 WITH KiCad-libraries-exception');
  assert.equal(await (await fetch(base.replace('/api/modules', '') + detail.files.footprint)).text(), raw);
  assert.equal(calls, 2, 'index and file are cached');
  const bad = Buffer.from('../secret.kicad_mod').toString('hex');
  assert.equal((await fetch(`${base}/raw/${bad}`)).status, 400);
  assert.equal(calls, 2, 'invalid paths never reach upstream');
  console.log('Modules API OK: search, filters, detail, raw, cache, path validation');
} finally { await new Promise(resolve => server.close(resolve)); }
