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

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('server OK', url);
