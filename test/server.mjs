// Проверка локального сервера: экспорт startServer, /healthz, /version, без автозапуска при import.
import { startServer } from '../scripts/server.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('server OK', url);
