// Интеграционный тест общего сервера: реальные HTTP/cookie/SQLite, без сети и npm-зависимостей.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCloudStore } from '../scripts/cloud.mjs';
import { startServer } from '../scripts/server.mjs';

const temp = mkdtempSync(join(tmpdir(), 'psbees-cloud-'));
const root = join(temp, 'dist');
const data = join(temp, 'data');
mkdirSync(root);
writeFileSync(join(root, 'index.html'), '<!doctype html><title>PSBees test</title>');
let store = await openCloudStore(data);
await store.createAdmin('admin@work.test', 'admin-long-password');
store.close();
await assert.rejects(() => startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: join(root, 'leak') }), /вне WWW_ROOT/);
if (process.platform !== 'win32') {
  const insecure = join(temp, 'world-readable');
  mkdirSync(insecure); chmodSync(insecure, 0o755);
  await assert.rejects(() => openCloudStore(insecure), /chmod 700/);
}
let server;
try {
  let started = await startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: data });
  server = started.server;
  let base = started.url;
  const alice = { cookie: '' }, bob = { cookie: '' }, admin = { cookie: '' };
  async function api(person, path, method = 'GET', body, status = 200, headers = {}) {
    const res = await fetch(base + '/api/cloud' + path, {
      method,
      headers: {
        ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-psbees-request': '1', origin: base } : {}),
        ...(person?.cookie ? { cookie: person.cookie } : {}), ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(res.status, status, `${method} ${path}: ${res.status} ${await res.clone().text()}`);
    const set = res.headers.get('set-cookie');
    if (set && person) person.cookie = set.split(';')[0];
    return { data: await res.json(), res };
  }

  assert.equal((await api(null, '/config')).data.enabled, true);
  assert.equal((await api(null, '/projects', 'GET', undefined, 401)).data.ok, false);
  assert.equal((await api(null, '/admin/overview', 'GET', undefined, 401)).data.ok, false);
  const adminLogin = await api(admin, '/login', 'POST', { email: 'admin@work.test', password: 'admin-long-password' });
  assert.equal(adminLogin.data.user.role, 'admin');
  assert.match(adminLogin.res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/api\/cloud/);
  assert.equal((await api(alice, '/register', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 201)).data.user.role, 'user');
  await api(bob, '/register', 'POST', { email: 'bob@work.test', password: 'bobs-long-password' }, 201);
  assert.equal((await api(null, '/register', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 409)).data.ok, false);
  assert.equal((await api(null, '/register', 'POST', { email: 'short@work.test', password: 'short' }, 400)).data.ok, false);
  assert.equal((await api(null, '/login', 'POST', { email: 'alice@work.test', password: 'wrong' }, 401)).data.ok, false);
  await api(null, '/register', 'POST', { email: 'mallory@work.test', password: 'a-good-password' }, 403, { origin: 'https://attacker.test' });
  await api(null, '/login', 'POST', { email: 'no-such-user@work.test', password: 'wrong' }, 401,
    { origin: 'https://public.example', 'x-forwarded-host': 'public.example' }); // прокси переписал Host
  await api(null, '/register', 'POST', { email: 'mallory@work.test', password: 'a-good-password' }, 403, { 'x-psbees-request': '' });
  assert.equal((await api(alice, '/admin/users', 'GET', undefined, 403)).data.ok, false);

  const doc = { name: 'Моя плата', w: 100, h: 80, entities: [{ id: 'p1', kind: 'pad', x: 10, y: 20, size: 2, drill: 1 }] };
  const created = (await api(alice, '/projects', 'POST', { name: doc.name, document: doc }, 201)).data.project;
  assert.equal(created.version, 1);
  assert.equal((await api(alice, '/projects')).data.projects.length, 1);
  assert.equal((await api(bob, '/projects')).data.projects.length, 0);
  const path = '/projects/' + created.id;
  assert.equal((await api(bob, path, 'GET', undefined, 404)).data.ok, false);
  await api(bob, path, 'PUT', { name: 'взлом', document: doc, version: 1 }, 404);
  await api(bob, path, 'DELETE', { version: 1 }, 404);
  assert.deepEqual((await api(alice, path)).data.project.document, doc);
  const edited = { ...doc, entities: [...doc.entities, { id: 't1', kind: 'track', layer: 'k1', pts: [], w: 1 }] };
  assert.equal((await api(alice, path, 'PUT', { name: doc.name, document: edited, version: 1 })).data.project.version, 2);
  assert.equal((await api(alice, path, 'PUT', { name: doc.name, document: doc, version: 1 }, 409)).data.ok, false);
  assert.deepEqual((await api(alice, path)).data.project.document, edited);
  const renamed = (await api(alice, path, 'PATCH', { name: 'Новая плата', version: 2 })).data.project;
  assert.equal(renamed.version, 3);
  assert.equal((await api(alice, path)).data.project.document.name, 'Новая плата');
  await api(alice, path, 'DELETE', { version: 2 }, 409);
  await api(alice, '/projects', 'POST', { name: '', document: doc }, 400);
  await api(alice, '/projects', 'POST', { name: 'нет', document: { name: 'нет', w: 1, h: 2, entities: 'bad' } }, 400);
  await api(alice, '/projects', 'POST', { name: 'большой', document: { ...doc, big: 'x'.repeat(8 * 1024 * 1024) } }, 413);

  const overview = (await api(admin, '/admin/overview')).data;
  assert.equal(overview.users, 3);
  assert.equal(overview.projects, 1);
  const users = (await api(admin, '/admin/users?q=alice')).data;
  assert.equal(users.total, 1);
  assert.equal(users.users[0].projectCount, 1);
  const aliceId = users.users[0].id;
  const adminId = adminLogin.data.user.id;
  assert.equal((await api(admin, '/admin/projects?q=%D0%9D%D0%BE%D0%B2%D0%B0%D1%8F')).data.total, 1);
  assert.equal((await api(admin, '/admin/projects?ownerId=' + aliceId)).data.projects[0].ownerEmail, 'alice@work.test');
  assert.equal((await api(admin, '/admin/projects/' + created.id)).data.project.document.name, 'Новая плата');
  await api(admin, '/admin/users/' + adminId, 'PATCH', { disabled: true }, 403);
  await api(admin, '/admin/users/' + aliceId, 'PATCH', { disabled: true });
  await api(alice, '/me', 'GET', undefined, 401);
  await api(null, '/login', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 401);
  await api(admin, '/admin/users/' + aliceId, 'PATCH', { disabled: false });
  await api(alice, '/login', 'POST', { email: 'alice@work.test', password: 'alice-long-password' });
  await api(admin, '/admin/users/' + aliceId + '/sessions', 'DELETE');
  await api(alice, '/me', 'GET', undefined, 401);
  await api(alice, '/login', 'POST', { email: 'alice@work.test', password: 'alice-long-password' });
  await api(alice, '/password', 'POST', { currentPassword: 'wrong', newPassword: 'brand-new-long-password' }, 401);
  await api(alice, '/password', 'POST', { currentPassword: 'alice-long-password', newPassword: 'brand-new-long-password' });
  assert.equal((await api(alice, '/me')).data.user.email, 'alice@work.test');
  await api(admin, '/admin/settings', 'PATCH', { registrationOpen: false });
  assert.equal((await api(null, '/config')).data.registrationOpen, false);
  await api(null, '/register', 'POST', { email: 'third@work.test', password: 'good-long-password' }, 403);
  await api(admin, '/admin/settings', 'PATCH', { registrationOpen: true });
  const events = (await api(admin, '/admin/events?limit=5')).data;
  assert.equal(events.events.length, 5);
  assert.ok(events.total > 5);
  assert.equal((await api(admin, '/admin/users?q=%25')).data.total, 0); // wildcard экранируется
  assert.equal((await fetch(base + '/update/run', { method: 'POST' })).status, 403);
  assert.equal((await fetch(base + '/api/cloud/no-such-api')).headers.get('content-type').includes('json'), true);
  assert.equal((await fetch(base + '/')).status, 200);
  // файл базы не отдаётся: путь с расширением не подменяется index.html (см. test/server.mjs)
  const dbRequest = await fetch(base + '/psbees.sqlite');
  assert.equal(dbRequest.status, 404);
  assert.ok(!(await dbRequest.text()).includes('SQLite format'));
  assert.ok(!readFileSync(join(data, 'psbees.sqlite')).includes(Buffer.from('alice-long-password')));
  const cli = await openCloudStore(data); // администратор ОС восстанавливает обычного пользователя
  await cli.resetUserPassword('bob@work.test', 'bobs-brand-new-password');
  cli.close();
  await api(bob, '/me', 'GET', undefined, 401);
  await api(bob, '/login', 'POST', { email: 'bob@work.test', password: 'bobs-long-password' }, 401);
  await api(bob, '/login', 'POST', { email: 'bob@work.test', password: 'bobs-brand-new-password' });

  // перезапуск Node-сервера сохраняет проекты, учётные записи, настройки.
  await new Promise((done) => server.close(done));
  server = null;
  started = await startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: data });
  server = started.server;
  base = started.url;
  assert.equal((await api(alice, '/projects')).data.projects[0].version, 3);
  await api(admin, '/admin/projects/' + created.id, 'DELETE');
  assert.equal((await api(alice, '/projects')).data.projects.length, 0);
  await api(alice, '/projects', 'POST', { name: 'Будет удалён вместе с владельцем', document: doc }, 201);
  await api(admin, '/admin/users/' + aliceId, 'DELETE');
  assert.equal((await api(alice, '/me', 'GET', undefined, 401)).data.ok, false);
  assert.equal((await api(admin, '/admin/overview')).data.users, 2);
  assert.equal((await api(admin, '/admin/projects')).data.total, 0);
  await api(admin, '/logout', 'POST');
  await api(admin, '/admin/overview', 'GET', undefined, 401);
  console.log('cloud HTTP/SQLite OK');
} finally {
  if (server) await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
}
