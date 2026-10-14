// Интеграционный тест общего сервера: реальные HTTP/cookie/SQLite, без сети и npm-зависимостей.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCloudStore } from '../scripts/cloud.mjs';
import { mergeDocuments, documentsEqual } from '../scripts/document-merge.mjs';
import { startServer } from '../scripts/server.mjs';

const delivered = [];
const cloudMailer = { async sendOtp(message) { delivered.push(message); } };

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
  let started = await startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: data, cloudMailer });
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
  assert.equal((await api(null, '/config')).data.twoFactorRequired, true);
  assert.equal((await api(null, '/projects', 'GET', undefined, 401)).data.ok, false);
  assert.equal((await api(null, '/admin/overview', 'GET', undefined, 401)).data.ok, false);
  const brute = await api(null, '/register', 'POST', { email: 'nobody@work.test', password: 'nobody-long-password' }, 202);
  const badCode = delivered.at(-1).code === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++) {
    await api(null, '/register/verify', 'POST', { challengeId: brute.data.challengeId, code: badCode }, attempt === 4 ? 429 : 401);
  }
  async function register(person, email, password) {
    const begin = await api(person, '/register', 'POST', { email, password }, 202);
    assert.ok(begin.data.challengeId && begin.data.email.includes('•'));
    await api(null, '/login/resend', 'POST', { challengeId: begin.data.challengeId }, 400);
    await api(null, '/register/resend', 'POST', { challengeId: begin.data.challengeId }, 429);
    assert.equal(begin.res.headers.get('set-cookie'), null, 'no session before OTP confirmation');
    await api(person, '/me', 'GET', undefined, 401);
    const sent = delivered.at(-1);
    assert.equal(sent.to, email);
    assert.equal(JSON.stringify(begin.data).includes(sent.code), false, 'OTP is never returned by API');
    const wrong = sent.code === '000000' ? '000001' : '000000';
    await api(null, '/register/verify', 'POST', { challengeId: begin.data.challengeId, code: wrong }, 401);
    const verified = await api(person, '/register/verify', 'POST', { challengeId: begin.data.challengeId, code: sent.code });
    assert.equal(verified.data.user.role, 'user');
    await api(null, '/register/verify', 'POST', { challengeId: begin.data.challengeId, code: sent.code }, 401);
  }
  async function login(person, email, password) {
    const begin = await api(person, '/login', 'POST', { email, password }, 202);
    assert.equal(begin.res.headers.get('set-cookie'), null, 'password alone must not create a session');
    const sent = delivered.at(-1);
    assert.equal(sent.to, email);
    return api(person, '/login/verify', 'POST', { challengeId: begin.data.challengeId, code: sent.code });
  }
  const adminBegin = await api(null, '/login', 'POST', { email: 'admin@work.test', password: 'admin-long-password' }, 202);
  const adminOtp = delivered.at(-1);
  const adminLogin = await api(admin, '/login/verify', 'POST', { challengeId: adminBegin.data.challengeId, code: adminOtp.code });
  assert.equal(adminLogin.data.user.role, 'admin');
  assert.match(adminLogin.res.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Path=\/api\/cloud/);
  await register(alice, 'alice@work.test', 'alice-long-password');
  await register(bob, 'bob@work.test', 'bobs-long-password');
  assert.equal((await api(null, '/register', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 409)).data.ok, false);
  assert.equal((await api(null, '/register', 'POST', { email: 'short@work.test', password: 'short' }, 400)).data.ok, false);
  assert.equal((await api(null, '/login', 'POST', { email: 'alice@work.test', password: 'wrong' }, 401)).data.ok, false);
  await api(null, '/register', 'POST', { email: 'mallory@work.test', password: 'a-good-password' }, 403, { origin: 'https://attacker.test' });
  await api(null, '/login', 'POST', { email: 'no-such-user@work.test', password: 'wrong' }, 401,
    { origin: 'https://public.example', 'x-forwarded-host': 'public.example' }); // прокси переписал Host
  await api(null, '/register', 'POST', { email: 'mallory@work.test', password: 'a-good-password' }, 403, { 'x-psbees-request': '' });
  assert.equal((await api(alice, '/admin/users', 'GET', undefined, 403)).data.ok, false);
  assert.equal((await api(alice, '/admin/overview', 'GET', undefined, 403)).data.ok, false);

  // Общая библиотека читается всеми пользователями облачного сервера; публиковать
  // и удалять свои элементы можно после входа. Чужое удаление запрещено.
  await api(null, '/library', 'GET', undefined, 401);
  assert.equal((await api(alice, '/library')).data.total, 0);
  const communityMacro = {
    name: 'SOIC-8 общий', category: 'Микросхемы',
    ents: [
      { id: 'lib-pad-1', kind: 'pad', x: -2, y: 0, shape: 'round', size: 1.8, drill: 0.8 },
      { id: 'lib-smd-1', kind: 'smd', x: 2, y: 0, w: 1.4, h: 0.8, rot: 0, layer: 'k1' },
    ],
    bl: [-3, -1, 3, 1], query: 'soic-8 шаг 1.27', note: 'Общая тестовая деталь',
  };
  const published = await api(alice, '/library', 'POST', communityMacro, 201);
  const sharedId = published.data.entry.id;
  assert.equal(published.data.created, true);
  assert.equal(published.data.entry.isOwner, true);
  const bobLibrary = await api(bob, '/library?q=soic');
  assert.equal(bobLibrary.data.total, 1, 'другой аккаунт видит опубликованную деталь');
  assert.equal(bobLibrary.data.entries[0].canDelete, false);
  assert.equal(Object.hasOwn(bobLibrary.data.entries[0], 'macro'), false, 'список не отдаёт геометрию до выбора элемента');
  const sharedDetail = await api(bob, `/library/${sharedId}`);
  assert.equal(sharedDetail.data.entry.macro.name, communityMacro.name);
  assert.deepEqual(sharedDetail.data.entry.macro.ents, communityMacro.ents);
  await api(bob, `/library/${sharedId}`, 'DELETE', {}, 403);
  const republished = await api(alice, '/library', 'POST', { ...communityMacro, note: 'Обновлено автором' }, 200);
  assert.equal(republished.data.created, false, 'повторная публикация обновляет свою запись, а не плодит копию');
  assert.equal(republished.data.entry.id, sharedId);
  assert.equal((await api(bob, `/library/${sharedId}`)).data.entry.macro.note, 'Обновлено автором');
  const ownCommunityMacro = {
    name: 'Катушка общего пользования', category: 'Пассивные',
    ents: [{ id: 'lib-via-1', kind: 'via', x: 0, y: 0, size: 1.6, drill: 0.8 }],
    bl: [-1, -1, 1, 1],
  };
  const bobPublished = await api(bob, '/library', 'POST', ownCommunityMacro, 201);
  assert.equal(bobPublished.data.entry.canDelete, true);
  assert.equal((await api(bob, '/library?q=катушка')).data.total, 1, 'поиск работает и для кириллицы');
  const deletable = await api(bob, '/library', 'POST', { ...ownCommunityMacro, name: 'Деталь для удаления' }, 201);
  await api(bob, `/library/${deletable.data.entry.id}`, 'DELETE');
  assert.equal((await api(bob, '/library')).data.total, 2, 'автор может удалить свою публикацию');
  const batchPublished = await api(alice, '/library/batch', 'POST', { entries: [
    { ...communityMacro, name: 'Пакетная деталь 1', category: 'Импорт' },
    { ...communityMacro, name: 'Пакетная деталь 2', category: 'Импорт', ents: communityMacro.ents.map((e) => ({ ...e, id: e.id + '-2' })) },
  ] }, 200);
  assert.equal(batchPublished.data.results.length, 2);
  await api(alice, '/library/batch', 'POST', { entries: [communityMacro, communityMacro] }, 400);
  await api(alice, '/library', 'POST', { ...communityMacro, name: 'Пустая деталь', ents: [] }, 400);
  await api(alice, '/library', 'POST', { ...communityMacro, name: 'Неизвестная геометрия', ents: [{ id: 'bad', kind: 'unknown' }] }, 400);
  assert.equal((await api(bob, '/library')).data.total, 4, 'неудачные публикации не меняют библиотеку');

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

  // именованные версии проекта: снимок, доступ, лимиты и квота
  const vpath = path + '/versions';
  assert.equal((await api(alice, vpath)).data.versions.length, 0);
  const v1 = (await api(alice, vpath, 'POST', { name: 'До трассировки', document: edited }, 201)).data.version;
  assert.equal(v1.name, 'До трассировки');
  assert.equal(v1.entityCount, 2);
  assert.equal((await api(alice, vpath)).data.versions[0].id, v1.id);
  assert.deepEqual((await api(alice, vpath + '/' + v1.id)).data.version.document, { ...edited, name: 'Новая плата' }, 'снимок хранит документ с текущим названием проекта');
  assert.equal((await api(alice, path)).data.project.version, 3, 'создание версии не меняет текущий проект');
  await api(bob, vpath, 'GET', undefined, 404);
  await api(bob, vpath, 'POST', { name: 'чужая', document: edited }, 404);
  await api(bob, vpath + '/' + v1.id, 'GET', undefined, 404);
  await api(bob, vpath + '/' + v1.id, 'DELETE', undefined, 404);
  await api(alice, vpath, 'POST', { name: '   ', document: edited }, 400);
  await api(alice, vpath, 'POST', { name: 'плохой', document: { w: 1 } }, 400);
  await api(alice, vpath, 'POST', { name: 'большая', document: { ...edited, big: 'x'.repeat(8 * 1024 * 1024) } }, 413);
  await api(alice, '/projects/00000000-0000-4000-8000-000000000000/versions/' + v1.id, 'GET', undefined, 404);
  const usedWithVersion = (await api(alice, '/projects')).data.usedBytes;
  assert.ok(usedWithVersion > (await api(alice, path)).data.project.bytes, 'версии входят в квоту');
  for (let i = 2; i <= 50; i++) await api(alice, vpath, 'POST', { name: 'Версия ' + i, document: edited }, 201);
  await api(alice, vpath, 'POST', { name: 'Лишняя', document: edited }, 413); // предел 50 версий
  assert.equal((await api(alice, vpath)).data.versions.length, 50);
  const usedBeforeDelete = (await api(alice, '/projects')).data.usedBytes;
  await api(alice, vpath + '/' + v1.id, 'DELETE');
  await api(alice, vpath + '/' + v1.id, 'DELETE', undefined, 404);
  assert.equal((await api(alice, vpath)).data.versions.length, 49);
  assert.ok((await api(alice, '/projects')).data.usedBytes < usedBeforeDelete, 'удаление версии освобождает квоту');

  // Совместный доступ: владелец приглашает одного зарегистрированного редактора.
  const membersPath = path + '/members';
  await api(alice, membersPath, 'POST', { email: 'bob@work.test' }, 201);
  const bobProjects = (await api(bob, '/projects')).data.projects;
  assert.equal(bobProjects.length, 1);
  assert.equal(bobProjects[0].ownerEmail, 'alice@work.test');
  assert.equal(bobProjects[0].accessRole, 'editor');
  const bobAdminId = (await api(admin, '/admin/users?q=bob')).data.users[0].id;
  const bobSharedProfile = (await api(admin, '/admin/users/' + bobAdminId)).data;
  assert.equal(bobSharedProfile.sharedProjectCount, 1);
  assert.equal(bobSharedProfile.sharedProjects[0].ownerEmail, 'alice@work.test');
  assert.equal(bobSharedProfile.sharedBytes, bobProjects[0].bytes);
  assert.equal((await api(bob, path)).data.project.accessRole, 'editor');
  assert.equal((await api(bob, membersPath)).data.members.length, 2);
  await api(bob, membersPath, 'POST', { email: 'admin@work.test' }, 404);
  await api(bob, path, 'PATCH', { name: 'чужое имя', version: 3 }, 404);
  const syncBase = (await api(alice, path)).data.project;
  const aliceEdit = { ...syncBase.document, entities: syncBase.document.entities.map((e) => e.id === 'p1' ? { ...e, x: 11 } : e) };
  const bobEdit = { ...syncBase.document, entities: syncBase.document.entities.map((e) => e.id === 't1' ? { ...e, w: 2 } : e) };
  const aliceSync = await api(alice, path + '/sync', 'POST', {
    baseVersion: syncBase.version, baseDocument: syncBase.document, document: aliceEdit,
  });
  assert.equal(aliceSync.data.project.version, syncBase.version + 1);
  const bobSync = await api(bob, path + '/sync', 'POST', {
    baseVersion: syncBase.version, baseDocument: syncBase.document, document: bobEdit,
  });
  assert.equal(bobSync.data.project.version, syncBase.version + 2, 'stale independent edits merge without data loss');
  assert.equal(bobSync.data.project.document.entities.find((e) => e.id === 'p1').x, 11);
  assert.equal(bobSync.data.project.document.entities.find((e) => e.id === 't1').w, 2);
  const mergeCheck = mergeDocuments(syncBase.document, aliceEdit, bobEdit);
  assert.equal(mergeCheck.ok, true);
  assert.equal(documentsEqual(mergeCheck.document, bobSync.data.project.document), true);
  const specialBase = JSON.parse('{"w":100,"h":80,"entities":[],"meta":{"__proto__":{"kept":true},"left":0,"right":0}}');
  const specialLocal = structuredClone(specialBase), specialRemote = structuredClone(specialBase);
  specialLocal.meta.left = 1; specialRemote.meta.right = 2;
  const specialMerge = mergeDocuments(specialBase, specialLocal, specialRemote);
  assert.equal(specialMerge.ok, true);
  assert.equal(Object.getPrototypeOf(specialMerge.document), null);
  assert.equal(Object.hasOwn(specialMerge.document.meta, '__proto__'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(specialMerge.document)).meta.__proto__, { kept: true });
  assert.equal({}.kept, undefined, 'untrusted JSON keys cannot pollute prototypes');
  const live = (await api(alice, path)).data.project;
  const aliceSameObject = { ...live.document, entities: live.document.entities.map((e) => e.id === 'p1' ? { ...e, x: 13 } : e) };
  await api(alice, path + '/sync', 'POST', { baseVersion: live.version, baseDocument: live.document, document: aliceSameObject });
  // Длинный опрос просыпается сразу после новой ревизии; параллельная правка того же поля отклоняется.
  const poll = fetch(base + '/api/cloud' + path + `/sync?since=${live.version + 1}&wait=5`, { headers: { cookie: bob.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const latestBeforeWake = (await api(alice, path)).data.project;
  const nextAliceDoc = { ...latestBeforeWake.document, w: latestBeforeWake.document.w + 10 };
  await api(alice, path + '/sync', 'POST', {
    baseVersion: latestBeforeWake.version, baseDocument: latestBeforeWake.document, document: nextAliceDoc,
  });
  const pollResponse = await poll;
  assert.equal(pollResponse.status, 200);
  const pollData = await pollResponse.json();
  assert.equal(pollData.project.version, latestBeforeWake.version + 1);
  const bobConflict = { ...syncBase.document, entities: syncBase.document.entities.map((e) => e.id === 'p1' ? { ...e, x: 14 } : e) };
  await api(bob, path + '/sync', 'POST', {
    baseVersion: syncBase.version, baseDocument: syncBase.document, document: bobConflict,
  }, 409);
  assert.equal((await api(alice, path)).data.project.document.entities.find((e) => e.id === 'p1').x, 13);
  await api(alice, path + '/presence', 'POST', {});
  await api(bob, path + '/presence', 'POST', {});
  const active = (await api(alice, path + '/presence', 'POST', {})).data.participants;
  assert.equal(active.filter((person) => person.online).length, 2);
  await api(alice, membersPath + '/' + bobProjects[0].ownerId, 'DELETE', undefined, 404); // owner ID is not a member
  await api(alice, membersPath + '/' + (await api(alice, membersPath)).data.members.find((m) => m.role === 'editor').id, 'DELETE');
  assert.equal((await api(bob, path, 'GET', undefined, 404)).data.ok, false, 'revoking access blocks future reads');
  assert.equal((await api(bob, '/projects')).data.projects.length, 0);
  const overview = (await api(admin, '/admin/overview')).data;
  assert.equal(overview.users, 3);
  assert.equal(overview.projects, 1);
  assert.equal(overview.versions, 49, 'админ видит число версий');
  assert.ok(overview.bytes > overview.projectBytes, 'объём хранения включает версии');
  const users = (await api(admin, '/admin/users?q=alice')).data;
  assert.equal(users.total, 1);
  assert.equal(users.users[0].projectCount, 1);
  assert.equal(users.users[0].bytes, (await api(alice, '/projects')).data.usedBytes, 'объём пользователя включает версии');
  assert.equal(users.users[0].versionCount, 49);
  assert.ok(users.users[0].activeSessions > 0);
  assert.equal(users.users[0].emailVerifiedAt > 0, true);
  assert.equal(Object.hasOwn(users.users[0], 'password_hash'), false, 'admin user list never exposes password hashes');
  assert.equal((await api(alice, '/admin/users/' + users.users[0].id, 'GET', undefined, 403)).data.ok, false);
  const aliceId = users.users[0].id;
  const aliceProfile = (await api(admin, '/admin/users/' + aliceId)).data;
  assert.equal(aliceProfile.user.email, 'alice@work.test');
  assert.equal(aliceProfile.twoFactorRequired, true);
  assert.equal(aliceProfile.ownedProjects.length, 1);
  assert.equal(aliceProfile.versionCount, 49);
  assert.equal(aliceProfile.actionCount > 0, true);
  assert.equal(Object.hasOwn(aliceProfile.user, 'password_hash'), false);
  assert.equal(Object.hasOwn(aliceProfile.user, 'passwordHash'), false);
  assert.equal(JSON.stringify(aliceProfile).includes('scrypt:'), false, 'admin details never include password hashes');
  const adminId = adminLogin.data.user.id;
  assert.equal((await api(admin, '/admin/projects?q=%D0%9D%D0%BE%D0%B2%D0%B0%D1%8F')).data.total, 1);
  assert.equal((await api(admin, '/admin/projects?ownerId=' + aliceId)).data.projects[0].ownerEmail, 'alice@work.test');
  assert.equal((await api(admin, '/admin/projects/' + created.id)).data.project.document.name, 'Новая плата');
  await api(admin, '/admin/users/' + adminId, 'PATCH', { disabled: true }, 403);
  await api(admin, '/admin/users/' + aliceId, 'PATCH', { disabled: true });
  await api(alice, '/me', 'GET', undefined, 401);
  await api(null, '/login', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 401);
  await api(admin, '/admin/users/' + aliceId, 'PATCH', { disabled: false });
  await login(alice, 'alice@work.test', 'alice-long-password');
  await api(admin, '/admin/users/' + aliceId + '/sessions', 'DELETE');
  await api(alice, '/me', 'GET', undefined, 401);
  await login(alice, 'alice@work.test', 'alice-long-password');
  // Смена пароля без текущего: достаточно вошедшего сеанса, но новый пароль проверяется как обычно.
  await api(alice, '/password', 'POST', { newPassword: 'short' }, 400);
  await api(alice, '/password', 'POST', { currentPassword: 'wrong', newPassword: 'brand-new-long-password' });
  await api(null, '/login', 'POST', { email: 'alice@work.test', password: 'alice-long-password' }, 401);
  await login(alice, 'alice@work.test', 'brand-new-long-password');
  await api(alice, '/password', 'POST', { newPassword: 'alice-long-password' });
  await api(null, '/password', 'POST', { newPassword: 'anonymous-long-password' }, 401);
  await login(alice, 'alice@work.test', 'alice-long-password');
  assert.equal((await api(alice, '/me')).data.user.email, 'alice@work.test');

  await api(admin, '/admin/users/' + adminId + '/password', 'POST', {}, 403);
  const bobSummary = (await api(admin, '/admin/users?q=bob')).data.users[0];
  await api(alice, '/admin/users/' + bobSummary.id + '/password', 'POST', {}, 403);
  await api(admin, '/admin/users/' + bobSummary.id + '/password', 'POST', { password: 'must-not-be-accepted' }, 400);
  const reset = await api(admin, '/admin/users/' + bobSummary.id + '/password', 'POST', {});
  const temporaryPassword = reset.data.temporaryPassword;
  assert.equal(typeof temporaryPassword, 'string');
  assert.ok(temporaryPassword.length >= 32);
  assert.equal(readFileSync(join(data, 'psbees.sqlite')).includes(Buffer.from(temporaryPassword)), false, 'temporary plaintext is not persisted');
  const bobProfileAfterReset = (await api(admin, '/admin/users/' + bobSummary.id)).data;
  assert.equal(bobProfileAfterReset.user.mustChangePassword, true);
  assert.equal(bobProfileAfterReset.activeSessions.length, 0, 'admin reset revokes active sessions');
  await api(bob, '/me', 'GET', undefined, 401);
  await api(null, '/login', 'POST', { email: 'bob@work.test', password: 'bobs-long-password' }, 401);
  const bobTempLogin = await login(bob, 'bob@work.test', temporaryPassword);
  assert.equal(bobTempLogin.data.user.mustChangePassword, true);
  await api(bob, '/projects', 'GET', undefined, 403);
  await api(bob, '/admin/users', 'GET', undefined, 403);
  await api(bob, '/password', 'POST', { newPassword: 'bob-after-reset-password' });
  assert.equal((await api(bob, '/me')).data.user.mustChangePassword, false);
  await api(null, '/login', 'POST', { email: 'bob@work.test', password: temporaryPassword }, 401);
  await login(bob, 'bob@work.test', 'bob-after-reset-password');

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
  const bobCliLogin = await login(bob, 'bob@work.test', 'bobs-brand-new-password');
  assert.equal(bobCliLogin.data.user.mustChangePassword, true, 'server-side reset also requires a new password');
  await api(bob, '/projects', 'GET', undefined, 403);
  await api(bob, '/password', 'POST', { newPassword: 'bobs-after-cli-reset-password' });
  assert.equal((await api(bob, '/me')).data.user.mustChangePassword, false);

  // перезапуск Node-сервера сохраняет проекты, учётные записи, настройки.
  await new Promise((done) => server.close(done));
  server = null;
  started = await startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: data, cloudMailer });
  server = started.server;
  base = started.url;
  assert.equal((await api(alice, '/projects')).data.projects[0].version, 7);
  assert.equal((await api(alice, vpath)).data.versions.length, 49, 'версии переживают перезапуск');
  assert.equal((await api(bob, '/library')).data.total, 4, 'общая библиотека переживает перезапуск сервера');
  assert.deepEqual((await api(alice, `/library/${sharedId}`)).data.entry.macro.ents, communityMacro.ents);
  await api(admin, '/admin/projects/' + created.id, 'DELETE');
  assert.equal((await api(alice, '/projects')).data.projects.length, 0);
  assert.equal((await api(alice, '/projects')).data.usedBytes, 0, 'удаление проекта удаляет версии и освобождает квоту');
  await api(alice, vpath, 'GET', undefined, 404);
  await api(alice, '/projects', 'POST', { name: 'Будет удалён вместе с владельцем', document: doc }, 201);
  await api(admin, '/admin/users/' + aliceId, 'DELETE');
  assert.equal((await api(alice, '/me', 'GET', undefined, 401)).data.ok, false);
  assert.equal((await api(admin, '/admin/overview')).data.users, 2);
  assert.equal((await api(admin, '/admin/projects')).data.total, 0);
  const retainedLibrary = await api(bob, '/library?q=soic');
  assert.equal(retainedLibrary.data.total, 1, 'удаление аккаунта автора не удаляет полезный общий элемент');
  assert.equal(retainedLibrary.data.entries[0].canDelete, false, 'осиротевшую запись может удалить только администратор');
  const adminLibrary = await api(admin, '/library?q=soic');
  assert.equal(adminLibrary.data.entries[0].canDelete, true);
  await api(admin, `/library/${adminLibrary.data.entries[0].id}`, 'DELETE');
  assert.equal((await api(bob, '/library?q=soic')).data.total, 0, 'администратор может удалить осиротевшую публикацию');
  await api(admin, '/logout', 'POST');
  await api(admin, '/admin/overview', 'GET', undefined, 401);

  // Простой режим по умолчанию (без SMTP и пароля — вход/регистрация по имени/нику):
  await new Promise((done) => server.close(done));
  server = null;
  const nickData = join(temp, 'nick-data');
  started = await startServer({ port: 0, host: '127.0.0.1', root, cloudDataDir: nickData });
  server = started.server;
  base = started.url;
  const cfgNick = (await api(null, '/config')).data;
  assert.equal(cfgNick.enabled, true);
  assert.equal(cfgNick.twoFactorRequired, false);
  assert.equal(cfgNick.authMode, 'nickname');
  const danil = { cookie: '' }, alex = { cookie: '' };
  // В режиме ника пароль обязателен: без него учётная запись не создаётся.
  await api(danil, '/login', 'POST', { name: 'Данил' }, 400);
  await api(danil, '/register', 'POST', { name: 'Данил' }, 400);
  await api(danil, '/register', 'POST', { name: 'Данил', password: 'short' }, 400);
  // Первый вошедший по нику (с паролем) автоматически становится администратором
  const firstLogin = await api(danil, '/login', 'POST', { name: 'Данил', password: 'danil-nick-password' }, 200);
  assert.equal(firstLogin.data.user.email, 'Данил');
  assert.equal(firstLogin.data.user.role, 'admin');
  assert.equal(firstLogin.data.created, true);
  // Второй человек регистрируется ником и паролем
  await api(alex, '/register', 'POST', { name: 'Алексей' }, 400);
  const secondReg = await api(alex, '/register', 'POST', { name: 'Алексей', password: 'alex-nick-password' }, 200);
  assert.equal(secondReg.data.user.email, 'Алексей');
  assert.equal(secondReg.data.user.role, 'user');
  // Повторная регистрация занятого ника отклоняется; вход по нику требует пароль
  await api(null, '/register', 'POST', { name: 'данил', password: 'another-nick-password' }, 409);
  await api(null, '/login', 'POST', { name: 'данил' }, 401);
  await api(null, '/login', 'POST', { name: 'данил', password: 'wrong-nick-password' }, 401);
  const danilAgain = await api(danil, '/login', 'POST', { name: 'данил', password: 'danil-nick-password' }, 200);
  assert.equal(danilAgain.data.user.email, 'Данил');
  assert.equal(danilAgain.data.created, false);
  // Смена пароля без текущего: в сеансе достаточно нового пароля
  await api(danil, '/password', 'POST', { newPassword: 'danil-changed-password' });
  await api(null, '/login', 'POST', { name: 'Данил', password: 'danil-nick-password' }, 401);
  await api(danil, '/login', 'POST', { name: 'Данил', password: 'danil-changed-password' }, 200);
  await api(danil, '/password', 'POST', { newPassword: 'danil-nick-password' });
  await api(danil, '/login', 'POST', { name: 'Данил', password: 'danil-nick-password' }, 200);
  // Совместная работа с платой по нику (без email)
  const nickProject = (await api(danil, '/projects', 'POST', { name: 'Плата по нику', document: doc }, 201)).data.project;
  await api(danil, `/projects/${nickProject.id}/members`, 'POST', { email: 'алексей' }, 201);
  assert.equal((await api(alex, '/projects')).data.projects.length, 1);

  // Миниатюры проектов: автор и приглашённый редактор сохраняют превью; список отдаёт его вместе с версией.
  const jpegPreview = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  await api(danil, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: jpegPreview, version: nickProject.version }, 200);
  await api(danil, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: 'data:image/png;base64,AAAA', version: nickProject.version }, 400);
  await api(danil, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: '<svg></svg>', version: nickProject.version }, 400);
  await api(danil, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: jpegPreview, version: nickProject.version + 5 }, 409);
  await api(null, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: jpegPreview, version: nickProject.version }, 401);
  const cardOwner = (await api(danil, '/projects')).data.projects.find((p) => p.id === nickProject.id);
  assert.equal(cardOwner.thumbnail, jpegPreview);
  assert.equal(cardOwner.thumbnailVersion, nickProject.version);
  assert.equal(Object.hasOwn(cardOwner, 'document'), false, 'список не тянет документ платы');
  await api(alex, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: jpegPreview, version: nickProject.version }, 200);
  const stranger = { cookie: '' };
  await api(null, '/register', 'POST', { name: 'Посторонний', password: 'stranger-nick-password' }, 200);
  await api(stranger, '/login', 'POST', { name: 'Посторонний', password: 'stranger-nick-password' }, 200);
  await api(stranger, `/projects/${nickProject.id}/thumbnail`, 'POST', { image: jpegPreview, version: nickProject.version }, 404);

  // Обновление программы из админ-панели: только администратор, только через /api/cloud/admin/update/*.
  await api(alex, '/admin/update/status', 'GET', undefined, 403);
  await api(null, '/admin/update/status', 'GET', undefined, 401);
  const updState = (await api(danil, '/admin/update/status', 'GET', undefined, 200)).data;
  assert.equal(updState.status, 'idle');
  assert.equal(typeof updState.rev, 'number');
  await api(danil, '/admin/update/cancel', 'POST', {}, 409);
  await api(danil, '/admin/update/status', 'POST', {}, 405);
  await api(alex, '/admin/update/run', 'POST', {}, 403);
  await api(danil, '/admin/update/unknown', 'GET', undefined, 404);
  // обычный путь /update/* на общем сервере по-прежнему закрыт
  assert.equal((await fetch(base + '/update/status', { headers: { cookie: danil.cookie } })).status, 403);
  const adminEvents = (await api(danil, '/admin/events')).data.events;
  assert.equal(adminEvents.some((e) => e.action === 'user.register' && e.actorEmail === 'Алексей'), true);

  console.log('cloud HTTP/SQLite OK');
} finally {
  if (server) await new Promise((done) => server.close(done));
  rmSync(temp, { recursive: true, force: true });
}
