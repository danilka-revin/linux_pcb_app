// SSR-проверка интерфейса общего режима без браузера/сети (кнопки, защита офлайн-режима).
import { createElement } from 'react';
import { renderToString } from 'react-dom/server.browser';
import App from '../src/App';
import AdminApp, { UserProfilePanel } from '../src/cloud/admin';
import { CloudProjectsDialog } from '../src/cloud/projects';
import { discoverCloud, ForcedPasswordChange } from '../src/cloud/Workspace';
import { emptyStore, loadStore, saveStore } from '../src/pcb/userlib';
import type { CloudUser } from '../src/cloud/api';

const user: CloudUser = { id: '11111111-2222-4333-8444-555555555555', email: 'alice@work.test', role: 'admin', createdAt: Date.now() };
const html = renderToString(createElement(App, { cloudUser: user, onLogout: async () => {} }));
for (const text of ['Облачное хранилище', 'Проекты', 'alice', 'Облако · черновик', 'Сохранить на сервере']) {
  if (!html.includes(text)) throw new Error(`Нет кнопки/статуса общего режима: ${text}`);
}
if (html.includes('Обновить программу из ветки main')) throw new Error('HTTP-обновление не должно быть доступно на общем сервере');
if (html.includes('локально · офлайн')) throw new Error('Статус локального режима показан вместо общего');
const admin = renderToString(createElement(AdminApp, { user, onLogout: async () => {} }));
for (const text of ['Администрирование', 'Пользователи', 'Проекты', 'Журнал действий', 'Регистрация по почте', 'Сброс пароля', 'временный пароль']) {
  if (!admin.includes(text)) throw new Error(`В админ-приложении отсутствует: ${text}`);
}
const forcedChange = renderToString(createElement(ForcedPasswordChange, {
  email: 'bob@work.test', onChanged: () => {}, onLogout: async () => {},
}));
for (const text of ['Задайте новый пароль', 'bob@work.test', 'Повторите новый пароль', 'Сохранить новый пароль']) {
  if (!forcedChange.includes(text)) throw new Error(`В экране обязательной смены пароля отсутствует: ${text}`);
}
if (forcedChange.includes('Текущий пароль')) throw new Error('После входа по временному паролю не нужно повторно вводить старый пароль');
const profile = renderToString(createElement(UserProfilePanel, {
  profile: {
    user: { id: '22222222-2222-4333-8444-555555555555', email: 'bob@work.test', role: 'user', createdAt: 1,
      lastLogin: 2, emailVerifiedAt: 2, mustChangePassword: false, disabled: false,
      projectCount: 1, sharedProjectCount: 0, versionCount: 3, activeSessions: 1, bytes: 512 },
    twoFactorRequired: true,
    ownedProjects: [{ id: '33333333-2222-4333-8444-555555555555', ownerId: '22222222-2222-4333-8444-555555555555',
      name: 'Тестовая плата', version: 4, bytes: 512, entityCount: 8, createdAt: 1, updatedAt: 2 }],
    sharedProjects: [], projectCount: 1, sharedProjectCount: 0, versionCount: 3,
    bytes: 512, sharedBytes: 0, quotaBytes: 1024, activeSessions: [{ createdAt: 2, expiresAt: 3 }],
    actionCount: 4, recentEvents: [],
  }, loading: false, error: '', busy: false, isCurrentUser: false,
  onResetPassword: () => {}, onRevokeSessions: () => {}, onShowOwnerProjects: () => {},
}));
for (const text of ['Проекты владельца', 'Тестовая плата', 'Код требуется при каждом входе', 'Выдать временный пароль', 'scrypt-хеш']) {
  if (!profile.includes(text)) throw new Error(`В полной сводке пользователя отсутствует: ${text}`);
}
const dialog = renderToString(createElement(CloudProjectsDialog, {
  current: null, userId: user.id, docName: 'Плата', status: 'local', statusMessage: '',
  onClose: () => {}, onCreate: async () => {}, onOpen: async () => true,
  onSave: async () => {}, onReload: async () => true, onRename: async () => {},
  onDelete: async () => {}, onSaveFile: () => {},
}));
for (const text of ['Облачные проекты', 'Сохранить текущую плату как новый проект', 'Мои проекты', 'пригласите второго пользователя']) {
  if (!dialog.includes(text)) throw new Error(`В списке проектов отсутствует: ${text}`);
}
// Локальная библиотека разных аккаунтов на одном компьютере не смешивается.
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
};
saveStore({ ...emptyStore(), folders: [{ id: 'f1', name: 'Моя папка', parentId: null }] }, user.id);
if (loadStore(user.id).folders.length !== 1 || loadStore('another-account').folders.length !== 0
  || loadStore().folders.length !== 0) throw new Error('Личная библиотека попала в другой аккаунт');
delete (globalThis as any).localStorage;
// Публикация dist/ на обычном статическом сервере не должна заставлять логиниться.
const oldFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if ((await discoverCloud()).enabled) throw new Error('Статический сервер принят за облачный');
  globalThis.fetch = async () => new Response('', { status: 404 });
  if ((await discoverCloud()).enabled) throw new Error('404 принят за облачный сервер');
} finally { globalThis.fetch = oldFetch; }
console.log('cloud UI SSR OK');
