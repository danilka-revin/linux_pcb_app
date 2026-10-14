// Многопользовательский режим PSBees. Данные — SQLite в отдельном каталоге,
// который НЕ раздаётся веб-сервером. Требуется Node.js >= 22 (node:sqlite).
// Модуль загружается только при включённом --cloud; локальный Electron/Node 18
// по-прежнему работают без базы данных.
import { randomBytes, randomUUID, randomInt, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mergeDocuments, documentsEqual } from './document-merge.mjs';
import { promisify } from 'node:util';
import { mkdir, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';

const scrypt = promisify(scryptCb);
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const AUTH_CODE_MS = 10 * 60 * 1000;
const AUTH_CODE_ATTEMPTS = 5;
const AUTH_RESEND_MS = 60 * 1000;
const PRESENCE_MS = 45 * 1000;
const COOKIE = 'psbees_session';
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 250 * 1024 * 1024;
const MAX_PROJECTS = 1000;
// Общая библиотека хранится в той же закрытой SQLite, но отдельно от пользовательских проектов.
const MAX_LIBRARY_ENTRY_BYTES = 512 * 1024;
const MAX_LIBRARY_BATCH = 20;
const MAX_LIBRARY_PER_USER = 1000;
const MAX_LIBRARY_PER_USER_BYTES = 32 * 1024 * 1024;
const MAX_LIBRARY_ENTRIES = 10_000;
const MAX_LIBRARY_TOTAL_BYTES = 512 * 1024 * 1024;
const LIBRARY_ENTITY_KINDS = new Set(['pad', 'smd', 'track', 'via', 'hole', 'line', 'rect', 'circle', 'text', 'poly', 'dim', 'comp']);
const LIBRARY_LAYERS = new Set(['k1', 'k2', 's1', 's2', 'outline']);
// Совместная плата: владелец + один приглашённый редактор (всего двое).
const MAX_PROJECT_MEMBERS = 1;
// Именованные версии (снимки) одного проекта. Автоматически не удаляются: их решает пользователь.
const MAX_VERSIONS = 50;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const publicUser = (row) => ({
  id: row.id, email: row.email, role: row.role, createdAt: row.created_at,
  mustChangePassword: !!row.must_change_password,
});

function emailOf(value) {
  if (typeof value !== 'string') fail(400, 'Введите корректный адрес электронной почты.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(400, 'Введите корректный адрес электронной почты.');
  return email;
}
function loginOf(value) {
  if (typeof value !== 'string') fail(400, 'Введите имя пользователя (ник).');
  const login = value.trim();
  if (!login || login.length > 254 || /[\x00-\x1f\x7f]/u.test(login)) {
    fail(400, 'Имя пользователя (ник): от 1 до 120 символов без управляющих знаков.');
  }
  if (login.includes('@')) return emailOf(login);
  if (login.length > 120) fail(400, 'Имя пользователя (ник): от 1 до 120 символов.');
  return login;
}
function passwordOf(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128 || Buffer.byteLength(value) > 256) {
    fail(400, 'Пароль должен содержать от 10 до 128 символов.');
  }
  return value;
}
async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [, salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const key = await scrypt(password, Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === key.length && timingSafeEqual(key, expected);
}
const authCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const maskedEmail = (email) => {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  return `${Array.from(local).slice(0, 1).join('')}•••${email.slice(at)}`;
};

/**
 * Create the mandatory email one-time-code sender. The deployment must provide
 * authenticated SMTP (or a trusted IP-allowlisted relay). Tests may inject a
 * mailer with sendOtp() without opening network connections.
 */
export async function createOtpMailer(options = {}) {
  if (options.mailer?.sendOtp) return options.mailer;
  const host = String(process.env.PSBEES_SMTP_HOST ?? '').trim();
  const port = Number(process.env.PSBEES_SMTP_PORT ?? 587);
  const from = String(process.env.PSBEES_SMTP_FROM ?? '').trim();
  const user = String(process.env.PSBEES_SMTP_USER ?? '').trim();
  const pass = String(process.env.PSBEES_SMTP_PASS ?? '');
  const secureValue = process.env.PSBEES_SMTP_SECURE;
  const secure = secureValue === undefined ? port === 465 : secureValue === '1';
  if ((secureValue !== undefined && secureValue !== '0' && secureValue !== '1')
    || !host || host.length > 253 || /[\s/\\]/u.test(host)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || !from || from.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(from)
    || ((user && !pass) || (!user && pass))) {
    throw new Error('Для обязательной email-2FA настройте PSBEES_SMTP_HOST, PSBEES_SMTP_PORT, PSBEES_SMTP_FROM и (при необходимости) обе SMTP-учётные переменные.');
  }
  const imported = await import('nodemailer');
  const nodemailer = imported.default ?? imported;
  const transport = nodemailer.createTransport({
    host, port, secure, requireTLS: !secure,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    ...(user ? { auth: { user, pass } } : {}),
  });
  return {
    async sendOtp({ to, code, purpose }) {
      const subject = purpose === 'register' ? 'Подтверждение регистрации PSBees' : 'Код входа в PSBees';
      const action = purpose === 'register' ? 'подтверждения адреса и завершения регистрации' : 'входа в рабочее пространство';
      await transport.sendMail({
        from, to, subject,
        text: `Код для ${action}: ${code}\n\nКод действует 10 минут. Если вы не запрашивали его, просто проигнорируйте письмо.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#20242c"><h2>PSBees</h2><p>Введите этот код для ${action}:</p><div style="font-size:30px;font-weight:700;letter-spacing:8px;padding:16px 0">${code}</div><p>Код действует 10 минут. Если вы не запрашивали его, проигнорируйте письмо.</p></div>`,
      });
    },
    verify: () => transport.verify(),
  };
}
function projectName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/u.test(value)) {
    fail(400, 'Название проекта: от 1 до 120 символов без управляющих символов.');
  }
  return value.trim();
}
function parseDocument(document, name, maxBytes) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || !Number.isFinite(document.w) || !Number.isFinite(document.h)
    || document.w <= 0 || document.h <= 0 || document.w > 1e6 || document.h > 1e6
    || !Array.isArray(document.entities) || document.entities.length > 200_000
    || document.entities.some((e) => !e || typeof e !== 'object' || Array.isArray(e)
      || typeof e.kind !== 'string' || typeof e.id !== 'string')
    || (document.nets !== undefined && !Array.isArray(document.nets))) {
    fail(400, 'Некорректный формат платы. Ожидается проект PSBees (.laypcb.json).');
  }
  const text = JSON.stringify({ ...document, name });
  const bytes = Buffer.byteLength(text);
  if (bytes > maxBytes) fail(413, `Проект слишком большой (максимум ${Math.floor(maxBytes / 1048576)} МиБ).`);
  return { text, bytes, entityCount: document.entities.length };
}
function libraryText(value, label, maxLength, { optional = false, multiline = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return '';
    fail(400, `${label}: обязательное текстовое поле.`);
  }
  if (typeof value !== 'string') fail(400, `${label}: ожидается текст.`);
  const text = value.trim();
  const controls = multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u;
  if ((!optional && !text) || text.length > maxLength || controls.test(text)) {
    fail(400, `${label}: допустимо от ${optional ? '0' : '1'} до ${maxLength} символов без управляющих знаков.`);
  }
  return text;
}
function libraryNumber(entity, key, { min = -1_000_000, max = 1_000_000 } = {}) {
  const value = entity[key];
  if (!Number.isFinite(value) || value < min || value > max) fail(400, 'У элемента библиотеки некорректная геометрия.');
  return value;
}
function libraryLayer(entity, copperOnly = false) {
  const value = entity.layer;
  if (!(copperOnly ? value === 'k1' || value === 'k2' : LIBRARY_LAYERS.has(value))) {
    fail(400, 'У элемента библиотеки указан неизвестный слой.');
  }
}
function libraryPoints(value, minLength, state) {
  if (!Array.isArray(value) || value.length < minLength || value.length > 12_000) {
    fail(400, 'У элемента библиотеки некорректный список точек.');
  }
  for (const point of value) {
    if (!point || typeof point !== 'object' || Array.isArray(point)) fail(400, 'У элемента библиотеки некорректная точка.');
    libraryNumber(point, 'x'); libraryNumber(point, 'y');
  }
  state.points += value.length;
  if (state.points > 24_000) fail(413, 'В элементе библиотеки слишком много точек.');
}
function validateLibraryJson(value, state = { nodes: 0 }, depth = 0) {
  if (depth > 32) fail(400, 'Структура элемента библиотеки слишком глубоко вложена.');
  state.nodes++;
  if (state.nodes > 100_000) fail(413, 'Элемент библиотеки слишком сложный.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > 32_000) fail(413, 'В элементе библиотеки слишком длинная строка.');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) fail(400, 'В элементе библиотеки есть некорректное число.');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 50_000) fail(413, 'В элементе библиотеки слишком большой список.');
    for (const item of value) validateLibraryJson(item, state, depth + 1);
    return;
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(400, 'Элемент библиотеки должен содержать только обычные JSON-данные.');
  }
  const keys = Object.keys(value);
  if (keys.length > 256) fail(413, 'В элементе библиотеки слишком много свойств.');
  for (const key of keys) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail(400, 'Элемент библиотеки содержит запрещённое свойство.');
    validateLibraryJson(value[key], state, depth + 1);
  }
}
function validateLibraryEntities(entities, state, depth = 0) {
  if (depth > 12) fail(400, 'Компоненты в элементе библиотеки вложены слишком глубоко.');
  if (!Array.isArray(entities) || (depth === 0 && !entities.length) || entities.length > 12_000) {
    fail(400, 'Деталь должна содержать от 1 до 12 000 примитивов.');
  }
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)
      || !LIBRARY_ENTITY_KINDS.has(entity.kind) || typeof entity.id !== 'string'
      || !entity.id || entity.id.length > 160 || state.ids.has(entity.id)) {
      fail(400, 'В элементе библиотеки есть примитив с неизвестным типом или повторяющимся ID.');
    }
    state.ids.add(entity.id);
    state.entities++;
    if (state.entities > 12_000) fail(413, 'В элементе библиотеки слишком много примитивов.');
    const n = (key, options) => libraryNumber(entity, key, options);
    switch (entity.kind) {
      case 'pad':
        n('x'); n('y'); n('size', { min: Number.MIN_VALUE }); n('drill', { min: 0 });
        if (!['round', 'square', 'oct'].includes(entity.shape)) fail(400, 'У площадки неизвестная форма.');
        break;
      case 'smd':
        n('x'); n('y'); n('w', { min: Number.MIN_VALUE }); n('h', { min: Number.MIN_VALUE }); n('rot'); libraryLayer(entity, true);
        break;
      case 'track':
        libraryPoints(entity.pts, 2, state); n('w', { min: Number.MIN_VALUE }); libraryLayer(entity, true);
        break;
      case 'via':
        n('x'); n('y'); n('size', { min: Number.MIN_VALUE }); n('drill', { min: 0 });
        break;
      case 'hole':
        n('x'); n('y'); n('d', { min: Number.MIN_VALUE });
        break;
      case 'line':
        n('x1'); n('y1'); n('x2'); n('y2'); n('w', { min: Number.MIN_VALUE }); libraryLayer(entity);
        break;
      case 'circle':
        n('x'); n('y'); n('r', { min: Number.MIN_VALUE }); n('w', { min: Number.MIN_VALUE }); libraryLayer(entity);
        break;
      case 'rect':
        n('x'); n('y'); n('w', { min: Number.MIN_VALUE }); n('h', { min: Number.MIN_VALUE });
        n('th', { min: 0 }); libraryLayer(entity);
        if (typeof entity.filled !== 'boolean') fail(400, 'У прямоугольника не указан тип заливки.');
        break;
      case 'text':
        n('x'); n('y'); n('size', { min: Number.MIN_VALUE }); n('th', { min: Number.MIN_VALUE }); n('rot'); libraryLayer(entity);
        if (typeof entity.text !== 'string' || entity.text.length > 10_000 || typeof entity.mirror !== 'boolean') {
          fail(400, 'У текстового примитива некорректные параметры.');
        }
        break;
      case 'poly':
        libraryPoints(entity.pts, 3, state); libraryLayer(entity);
        if (entity.holes !== undefined) {
          if (!Array.isArray(entity.holes) || entity.holes.length > 1000) fail(400, 'У полигона некорректные отверстия.');
          for (const hole of entity.holes) libraryPoints(hole, 3, state);
        }
        break;
      case 'dim':
        n('x1'); n('y1'); n('x2'); n('y2'); n('off'); n('th', { min: Number.MIN_VALUE }); n('size', { min: Number.MIN_VALUE }); libraryLayer(entity);
        if (!['aligned', 'horiz', 'vert'].includes(entity.mode)) fail(400, 'У размера неизвестный режим.');
        if (entity.text !== undefined && (typeof entity.text !== 'string' || entity.text.length > 10_000)) fail(400, 'У размера слишком длинная подпись.');
        break;
      case 'comp': {
        n('x'); n('y'); n('rot');
        if (typeof entity.lib !== 'string' || entity.lib.length > 500
          || typeof entity.name !== 'string' || !entity.name.trim() || entity.name.length > 500
          || !['top', 'bottom'].includes(entity.side)) fail(400, 'У компонента некорректные параметры.');
        if (!Array.isArray(entity.bl) || entity.bl.length !== 4
          || entity.bl.some((v) => !Number.isFinite(v) || Math.abs(v) > 1_000_000)
          || entity.bl[0] > entity.bl[2] || entity.bl[1] > entity.bl[3]) fail(400, 'У компонента некорректный габарит.');
        for (const key of ['ref', 'value', 'footprint', 'manufacturer', 'mpn', 'datasheet']) {
          if (entity[key] !== undefined && (typeof entity[key] !== 'string' || entity[key].length > 2000)) {
            fail(400, 'У компонента слишком длинные текстовые данные.');
          }
        }
        if (entity.ents !== undefined) validateLibraryEntities(entity.ents, state, depth + 1);
        break;
      }
    }
  }
}
function parseLibraryEntryInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Некорректные данные элемента библиотеки.');
  const name = libraryText(body.name, 'Название детали', 60);
  const category = libraryText(body.category, 'Папка', 120, { optional: true });
  const query = libraryText(body.query, 'Строка генератора', 500, { optional: true });
  const note = libraryText(body.note, 'Описание', 4000, { optional: true, multiline: true });
  if (!Array.isArray(body.bl) || body.bl.length !== 4
    || body.bl.some((v) => !Number.isFinite(v) || Math.abs(v) > 1_000_000)
    || body.bl[0] > body.bl[2] || body.bl[1] > body.bl[3]) {
    fail(400, 'У детали некорректный габарит.');
  }
  const state = { ids: new Set(), entities: 0, points: 0 };
  validateLibraryJson(body.ents);
  validateLibraryEntities(body.ents, state);
  const bl = body.bl.slice();
  const nameKey = name.normalize('NFKC').toLowerCase();
  const categoryKey = category.normalize('NFKC').toLowerCase();
  return { name, nameKey, category, categoryKey, ents: body.ents, bl, query, note, entityCount: state.entities };
}
function thumbnailOf(value) {
  // Только JPEG из data-URL, созданный редактором: около 360×225 px, ≤ 120 КБ.
  if (typeof value !== 'string' || value.length > 120_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail(400, 'Некорректное превью платы.');
  }
  return value;
}
function versionNameOf(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f\x7f]/u.test(value)) {
    fail(400, 'Название версии: от 1 до 120 символов без управляющих символов.');
  }
  return value.trim();
}
function versionOf(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Не указана версия проекта. Обновите список проектов.');
  return value;
}
function pageOf(url) {
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
    fail(400, 'Некорректная страница списка.');
  }
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length > 120) fail(400, 'Слишком длинный поисковый запрос.');
  return { limit, offset, q: `%${q.replace(/[\\%_]/g, '\\$&')}%` };
}
function json(res, status, obj, extra = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extra });
  res.end(JSON.stringify(obj));
}
function cookieHeader(req, token) {
  // HTTPS при прямом TLS или за обратным прокси. На HTTP в локальной сети
  // браузер примет cookie без Secure; используйте TLS для реальной эксплуатации.
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.PSBEES_SECURE_COOKIES === '1';
  return `${COOKIE}=${token ?? ''}; HttpOnly; SameSite=Lax; Path=/api/cloud; ${secure ? 'Secure; ' : ''}Max-Age=${token ? SESSION_MS / 1000 : 0}`;
}
function bearerCookie(req) {
  const match = /(?:^|;\s*)psbees_session=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '');
  return match?.[1] ?? null;
}
function requireWriteRequest(req) {
  if (req.headers['x-psbees-request'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site') {
    fail(403, 'Запрос отклонён (защита от поддельных запросов).');
  }
  // Origin соответствует внешнему Host. Прокси могут переписать Host на адрес
  // backend; тогда сравниваем с X-Forwarded-Host. Наличие обязательного
  // нестандартного заголовка + SameSite и запрет CORS защищают от CSRF.
  if (req.headers.origin) {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { fail(403, 'Некорректный Origin.'); }
    const hosts = [req.headers.host, String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim()];
    if (!['http:', 'https:'].includes(origin.protocol)
      || !hosts.some((host) => host && origin.host.toLowerCase() === host.toLowerCase())) {
      fail(403, 'Запрос отправлен с другого сайта.');
    }
  }
}
async function readJson(req, maxBytes = MAX_PROJECT_BYTES + 1024 * 1024) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) fail(415, 'Ожидается application/json.');
  if (Number(req.headers['content-length']) > maxBytes) fail(413, 'Запрос слишком большой.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) fail(413, 'Запрос слишком большой.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* некорректный JSON */ }
  fail(400, 'Некорректный JSON.');
}

/** Открыть базу данных для API и локальной CLI-команды создания администратора. */
export async function openCloudStore(dataDir, opts = {}) {
  if (!dataDir) throw new Error('Укажите PSBEES_DATA_DIR (постоянный каталог для базы данных).');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error('Для облачного режима нужен Node.js 22.13+ (рекомендуется 24) с node:sqlite.');
  }
  // SQLite создаёт рядом с базой WAL/SHM. Они тоже должны быть закрыты от других пользователей ОС.
  process.umask(0o077);
  const dir = resolve(dataDir);
  // Не делаем chmod на существующий путь: при опечатке вроде «/var/lib» это
  // сломало бы права системного каталога. Лучше явно отказать в запуске.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = await stat(dir);
  if (!folder.isDirectory() || (process.platform !== 'win32' && (folder.mode & 0o077))) {
    throw new Error(`Каталог данных должен быть закрыт от других пользователей ОС (chmod 700 "${dir}").`);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const dbPath = join(dir, 'psbees.sqlite');
  const db = new DatabaseSync(dbPath);
  await chmod(dbPath, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','admin')), disabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, last_login INTEGER, email_verified_at INTEGER,
      must_change_password INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS auth_challenges (
      id_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('register','login')),
      email TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT, code_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      resend_at INTEGER NOT NULL, resend_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS auth_challenges_expiry ON auth_challenges(expires_at);
    CREATE INDEX IF NOT EXISTS auth_challenges_email ON auth_challenges(email, purpose);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, document TEXT NOT NULL, bytes INTEGER NOT NULL, entity_count INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS projects_recent ON projects(updated_at DESC);
    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'editor' CHECK(role='editor'),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY(project_id,user_id)
    );
    CREATE INDEX IF NOT EXISTS project_members_user ON project_members(user_id, project_id);
    CREATE TABLE IF NOT EXISTS project_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
      document TEXT NOT NULL, bytes INTEGER NOT NULL, entity_count INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_versions_project ON project_versions(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS project_versions_owner ON project_versions(owner_id);
    CREATE TABLE IF NOT EXISTS community_library (
      id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL, name_key TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', category_key TEXT NOT NULL DEFAULT '',
      macro_json TEXT NOT NULL, bytes INTEGER NOT NULL, entity_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(owner_id,name_key,category_key)
    );
    CREATE INDEX IF NOT EXISTS community_library_recent ON community_library(updated_at DESC);
    CREATE INDEX IF NOT EXISTS community_library_owner ON community_library(owner_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_open', '1');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_recent ON audit(at DESC);
  `);
  // Additive migration for servers created by earlier PSBees releases.
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at INTEGER');
  }
  if (!userColumns.some((column) => column.name === 'must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }
  const projectColumns = db.prepare('PRAGMA table_info(projects)').all();
  if (!projectColumns.some((column) => column.name === 'thumbnail')) {
    db.exec('ALTER TABLE projects ADD COLUMN thumbnail TEXT');
  }
  if (!projectColumns.some((column) => column.name === 'thumbnail_version')) {
    db.exec('ALTER TABLE projects ADD COLUMN thumbnail_version INTEGER');
  }

  const quotaBytes = opts.quotaBytes ?? DEFAULT_QUOTA_BYTES;
  const maxProjectBytes = opts.maxProjectBytes ?? MAX_PROJECT_BYTES;
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < maxProjectBytes || !Number.isSafeInteger(maxProjectBytes) || maxProjectBytes < 1) {
    db.close();
    throw new Error('Некорректная квота проектов.');
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const audit = (actor, action, target, detail = '') => {
    const result = run('INSERT INTO audit(actor_id, action, target_id, detail, at) VALUES(?,?,?,?,?)',
      actor, action, target, detail.slice(0, 200), Date.now());
    // Автосохранения могут идти годами с сотен машин: журнал ограничен 20 000 записями.
    const id = Number(result.lastInsertRowid);
    if (id % 100 === 0) run('DELETE FROM audit WHERE id<?', id - 20_000);
  };
  const registrationOpen = () => get("SELECT value FROM settings WHERE key='registration_open'").value === '1';
  const findUser = (login) => {
    const exact = get('SELECT * FROM users WHERE email=?', login);
    if (exact) return exact;
    const lower = String(login).toLocaleLowerCase();
    const byLower = get('SELECT * FROM users WHERE email=?', lower);
    if (byLower) return byLower;
    return all('SELECT * FROM users').find((u) => String(u.email).toLocaleLowerCase() === lower) ?? undefined;
  };
  const session = (token) => {
    if (!token) return null;
    const row = get(`SELECT u.*, s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0`, hashToken(token), Date.now());
    return row ?? null;
  };
  const newSession = (userId) => {
    const token = randomBytes(32).toString('base64url');
    run('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)',
      hashToken(token), userId, Date.now(), Date.now() + SESSION_MS);
    return token;
  };
  const versionMeta = (row) => ({
    id: row.id, projectId: row.project_id, name: row.name, bytes: row.bytes,
    entityCount: row.entity_count, createdAt: row.created_at,
  });
  const libraryMeta = (row, userId, isAdmin = false) => ({
    id: row.id, name: row.name, category: row.category,
    entityCount: row.entity_count, bytes: row.bytes,
    createdAt: row.created_at, updatedAt: row.updated_at,
    isOwner: row.owner_id === userId,
    canDelete: row.owner_id === userId || isAdmin,
  });
  const projectMeta = (row) => ({
    id: row.id, ownerId: row.owner_id, name: row.name, version: row.version,
    bytes: row.bytes, entityCount: row.entity_count, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.owner_email ? { ownerEmail: row.owner_email } : {}),
    ...(row.access_role ? { accessRole: row.access_role } : {}),
  });
  // Миниатюра (JPEG-превью всей платы) отдаётся только в списке проектов.
  const projectCard = (row) => ({
    ...projectMeta(row),
    thumbnail: row.thumbnail ?? null,
    thumbnailVersion: row.thumbnail_version ?? null,
  });
  const ownProject = (id, userId) => {
    const row = get('SELECT * FROM projects WHERE id=? AND owner_id=?', id, userId);
    if (!row) fail(404, 'Проект не найден.');
    return row;
  };
  const accessibleProject = (id, userId) => {
    const row = get(`SELECT p.*, owner.email AS owner_email,
      CASE WHEN p.owner_id=? THEN 'owner' ELSE 'editor' END AS access_role
      FROM projects p JOIN users owner ON owner.id=p.owner_id
      WHERE p.id=? AND (p.owner_id=? OR EXISTS (
        SELECT 1 FROM project_members m JOIN users member ON member.id=m.user_id
        WHERE m.project_id=p.id AND m.user_id=? AND member.disabled=0
      ))`, userId, id, userId, userId);
    if (!row) fail(404, 'Проект не найден или доступ к нему отозван.');
    return row;
  };
  // Квота общая: проекты и их версии занимают одно место.
  const usedBytes = (ownerId) => get(`SELECT (SELECT COALESCE(SUM(bytes),0) FROM projects WHERE owner_id=?)
    + (SELECT COALESCE(SUM(bytes),0) FROM project_versions WHERE owner_id=?) AS bytes`, ownerId, ownerId).bytes;
  const ensureQuota = (ownerId, nextBytes, oldBytes = 0) => {
    const used = usedBytes(ownerId);
    if (used - oldBytes + nextBytes > quotaBytes) fail(413, 'Квота проектов исчерпана. Скачайте или удалите ненужные проекты.');
  };
  const activeSessions = () => get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at>?', Date.now()).n;
  const issueChallenge = async ({ purpose, email, userId = null, userPasswordHash = null }) => {
    const id = randomBytes(32).toString('base64url');
    const code = authCode();
    const codeHash = await passwordHash(code);
    const now = Date.now();
    tx(() => {
      run('DELETE FROM auth_challenges WHERE expires_at<?', now);
      if (purpose === 'register') {
        if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
        if (findUser(email)) fail(409, 'Этот адрес уже зарегистрирован.');
        run("DELETE FROM auth_challenges WHERE email=? AND purpose='register'", email);
      } else if (!get('SELECT id FROM users WHERE id=? AND disabled=0', userId)) {
        fail(401, 'Учётная запись отключена. Войдите снова.');
      }
      run(`INSERT INTO auth_challenges(id_hash,purpose,email,user_id,password_hash,code_hash,created_at,expires_at,resend_at)
        VALUES(?,?,?,?,?,?,?,?,?)`, hashToken(id), purpose, email, userId, userPasswordHash, codeHash,
      now, now + AUTH_CODE_MS, now + AUTH_RESEND_MS);
    });
    return { challengeId: id, email, code, expiresAt: now + AUTH_CODE_MS, resendAt: now + AUTH_RESEND_MS };
  };
  const verifyChallenge = async (challengeId, purpose, codeInput) => {
    if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challengeId)) fail(400, 'Код подтверждения устарел. Запросите новый.');
    const idHash = hashToken(challengeId);
    const row = get('SELECT * FROM auth_challenges WHERE id_hash=? AND purpose=?', idHash, purpose);
    if (!row) fail(401, 'Код подтверждения неверный или срок действия истёк. Запросите новый.');
    if (row.expires_at <= Date.now()) {
      run('DELETE FROM auth_challenges WHERE id_hash=?', idHash);
      fail(401, 'Срок действия кода истёк. Запросите новый.');
    }
    if (row.attempts >= AUTH_CODE_ATTEMPTS) {
      run('DELETE FROM auth_challenges WHERE id_hash=?', idHash);
      fail(429, 'Слишком много неверных кодов. Запросите новый.');
    }
    const codeText = typeof codeInput === 'string' ? codeInput : '';
    const valid = /^\d{6}$/.test(codeText) && await checkPassword(codeText, row.code_hash);
    if (!valid) {
      const result = tx(() => {
        const fresh = get('SELECT * FROM auth_challenges WHERE id_hash=? AND purpose=?', idHash, purpose);
        if (!fresh || fresh.expires_at <= Date.now() || fresh.code_hash !== row.code_hash) return 'expired';
        const attemptsLeft = AUTH_CODE_ATTEMPTS - fresh.attempts - 1;
        if (attemptsLeft <= 0) run('DELETE FROM auth_challenges WHERE id_hash=?', idHash);
        else run('UPDATE auth_challenges SET attempts=attempts+1 WHERE id_hash=?', idHash);
        return attemptsLeft;
      });
      if (result === 'expired') fail(401, 'Код подтверждения устарел. Запросите новый.');
      if (result <= 0) fail(429, 'Слишком много неверных кодов. Запросите новый.');
      fail(401, `Неверный код. Осталось попыток: ${result}.`);
    }
    return tx(() => {
      const fresh = get('SELECT * FROM auth_challenges WHERE id_hash=? AND purpose=?', idHash, purpose);
      if (!fresh || fresh.expires_at <= Date.now() || fresh.code_hash !== row.code_hash || fresh.attempts >= AUTH_CODE_ATTEMPTS) {
        fail(401, 'Код подтверждения устарел или уже использован. Запросите новый.');
      }
      const consumed = run('DELETE FROM auth_challenges WHERE id_hash=? AND expires_at>? AND attempts<?',
        idHash, Date.now(), AUTH_CODE_ATTEMPTS);
      if (!consumed.changes) fail(401, 'Код подтверждения устарел или уже использован. Запросите новый.');
      const now = Date.now();
      let user;
      if (purpose === 'register') {
        if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
        if (findUser(fresh.email)) fail(409, 'Этот адрес уже зарегистрирован.');
        const id = randomUUID();
        run("INSERT INTO users(id,email,password_hash,role,created_at,last_login,email_verified_at) VALUES(?,?,?,'user',?,?,?)",
          id, fresh.email, fresh.password_hash, now, now, now);
        user = publicUser({ id, email: fresh.email, role: 'user', created_at: now });
        audit(id, 'user.register', id, fresh.email);
      } else {
        const rowUser = get('SELECT * FROM users WHERE id=? AND disabled=0', fresh.user_id);
        if (!rowUser) fail(401, 'Учётная запись отключена. Войдите снова.');
        run('DELETE FROM sessions WHERE expires_at<?', now);
        run('UPDATE users SET last_login=?,email_verified_at=COALESCE(email_verified_at,?) WHERE id=?', now, now, rowUser.id);
        user = publicUser(rowUser);
        audit(rowUser.id, 'user.login', rowUser.id);
      }
      return { user, token: newSession(user.id) };
    });
  };

  return {
    dir, dbPath, quotaBytes, maxProjectBytes, close: () => db.close(),
    registrationOpen, session, findUser, activeSessions,
    auditEvent(actorId, action, detail = '') { audit(actorId, action, null, detail); },
    async registerByNickname(loginInput, passwordInput) {
      const login = loginOf(loginInput);
      // В режиме ника пароль обязателен при регистрации: без него учётная запись не создаётся.
      const hashed = await passwordHash(passwordOf(passwordInput));
      return tx(() => {
        if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
        if (findUser(login)) fail(409, 'Это имя (ник) уже занято. Войдите под ним или выберите другое.');
        const hasAdmin = get("SELECT COUNT(*) AS n FROM users WHERE role='admin'").n > 0;
        const role = hasAdmin ? 'user' : 'admin';
        const id = randomUUID(), now = Date.now();
        run('INSERT INTO users(id,email,password_hash,role,created_at,last_login,email_verified_at) VALUES(?,?,?,?,?,?,?)',
          id, login, hashed, role, now, now, now);
        if (!hasAdmin) audit(id, 'admin.bootstrap', id, login);
        audit(id, 'user.register', id, login);
        const user = publicUser({ id, email: login, role, created_at: now });
        return { user, token: newSession(id), created: true };
      });
    },
    async loginByNickname(loginInput, passwordInput) {
      const login = loginOf(loginInput);
      const hasPassword = typeof passwordInput === 'string' && passwordInput !== '';
      const existing = findUser(login);
      if (!existing) {
        // Свободный ник: вход и создание учётной записи — одно действие, и пароль задаётся сразу.
        if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
        if (!hasPassword) fail(400, 'Ник свободен. Придумайте пароль (от 10 до 128 символов), чтобы создать учётную запись.');
        return this.registerByNickname(login, passwordInput);
      }
      if (existing.disabled) fail(401, 'Учётная запись отключена администратором.');
      // Учётные записи, созданные до обязательного пароля (без хеша), входят только по нику.
      if (existing.password_hash && existing.password_hash !== 'none') {
        if (!hasPassword) fail(401, 'Введите пароль от этого ника.');
        const valid = await checkPassword(passwordInput, existing.password_hash);
        if (!valid) fail(401, 'Неверный пароль.');
      }
      return tx(() => {
        const fresh = get('SELECT * FROM users WHERE id=? AND disabled=0', existing.id);
        if (!fresh) fail(401, 'Учётная запись отключена администратором.');
        const now = Date.now();
        run('DELETE FROM sessions WHERE expires_at<?', now);
        run('UPDATE users SET last_login=?,email_verified_at=COALESCE(email_verified_at,?) WHERE id=?', now, now, fresh.id);
        audit(fresh.id, 'user.login', fresh.id);
        return { user: publicUser(fresh), token: newSession(fresh.id), created: false };
      });
    },
    async beginRegistration(emailInput, passwordInput) {
      const email = emailOf(emailInput), password = passwordOf(passwordInput);
      if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
      const hashed = await passwordHash(password);
      return issueChallenge({ purpose: 'register', email, userPasswordHash: hashed });
    },
    async beginLogin(emailInput, passwordInput) {
      const email = emailOf(emailInput);
      if (typeof passwordInput !== 'string' || passwordInput.length > 128) fail(401, 'Неверная почта или пароль.');
      const row = findUser(email);
      // Похожее время ответа для несуществующего адреса (не выдаём список аккаунтов).
      const dummy = 'scrypt:33c3b95fbd1599e57990d60eab9a4369:' + '00'.repeat(64);
      const valid = await checkPassword(passwordInput, row?.password_hash ?? dummy);
      if (!row || !valid || row.disabled) fail(401, 'Неверная почта или пароль либо учётная запись отключена.');
      return issueChallenge({ purpose: 'login', email: row.email, userId: row.id });
    },
    verifyAuthChallenge(challengeId, purpose, code) { return verifyChallenge(challengeId, purpose, code); },
    cancelAuthChallenge(challengeId) {
      if (typeof challengeId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(challengeId)) run('DELETE FROM auth_challenges WHERE id_hash=?', hashToken(challengeId));
    },
    async resendAuthChallenge(challengeId, expectedPurpose) {
      if (typeof challengeId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challengeId)) fail(400, 'Сеанс подтверждения не найден. Начните вход или регистрацию заново.');
      const idHash = hashToken(challengeId);
      const row = get('SELECT * FROM auth_challenges WHERE id_hash=?', idHash);
      if (!row || row.expires_at <= Date.now()) fail(401, 'Сеанс подтверждения истёк. Начните заново.');
      if (expectedPurpose && row.purpose !== expectedPurpose) fail(400, 'Не совпадает тип подтверждения. Начните заново.');
      if (row.resend_count >= 5) fail(429, 'Достигнут предел повторной отправки кода. Начните заново.');
      if (row.resend_at > Date.now()) fail(429, 'Подождите минуту перед повторной отправкой.');
      if (row.purpose === 'register' && !registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
      const code = authCode();
      const codeHash = await passwordHash(code);
      const now = Date.now();
      const changed = tx(() => {
        const fresh = get('SELECT * FROM auth_challenges WHERE id_hash=?', idHash);
        if (!fresh || fresh.expires_at <= now || fresh.code_hash !== row.code_hash) fail(401, 'Сеанс подтверждения истёк. Начните заново.');
        if (fresh.resend_at > now || fresh.resend_count >= 5) fail(429, 'Подождите перед повторной отправкой кода.');
        if (fresh.purpose === 'login' && !get('SELECT id FROM users WHERE id=? AND disabled=0', fresh.user_id)) fail(401, 'Учётная запись отключена.');
        run('UPDATE auth_challenges SET code_hash=?,created_at=?,expires_at=?,attempts=0,resend_at=?,resend_count=resend_count+1 WHERE id_hash=?',
          codeHash, now, now + AUTH_CODE_MS, now + AUTH_RESEND_MS, idHash);
        return { purpose: fresh.purpose, email: fresh.email };
      });
      return { challengeId, ...changed, code, expiresAt: now + AUTH_CODE_MS, resendAt: now + AUTH_RESEND_MS };
    },
    async createAdmin(emailInput, passwordInput) {
      const email = loginOf(emailInput);
      const hashed = passwordInput === undefined || passwordInput === ''
        ? 'none'
        : await passwordHash(passwordOf(passwordInput));
      return tx(() => {
        if (get("SELECT COUNT(*) AS n FROM users WHERE role='admin'").n) fail(409, 'Администратор уже создан. Для восстановления используйте reset-admin-password.');
        if (findUser(email)) fail(409, 'Этот адрес уже зарегистрирован. Укажите другой адрес администратора.');
        const id = randomUUID(), now = Date.now();
        run("INSERT INTO users(id,email,password_hash,role,created_at,email_verified_at) VALUES(?,?,?,'admin',?,?)", id, email, hashed, now, now);
        audit(id, 'admin.bootstrap', id, email);
        return publicUser({ id, email, role: 'admin', created_at: now });
      });
    },
    async resetAdminPassword(emailInput, passwordInput) {
      const email = loginOf(emailInput), password = passwordOf(passwordInput);
      const hashed = await passwordHash(password);
      tx(() => {
        const user = findUser(email);
        if (!user || user.role !== 'admin') fail(404, 'Администратор не найден.');
        run('UPDATE users SET password_hash=?, disabled=0 WHERE id=?', hashed, user.id);
        run('DELETE FROM sessions WHERE user_id=?', user.id);
        run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", user.id);
        audit(user.id, 'admin.password_reset_cli', user.id, email);
      });
    },
    async resetUserPassword(emailInput, passwordInput) {
      const email = loginOf(emailInput), password = passwordOf(passwordInput);
      const hashed = await passwordHash(password);
      tx(() => {
        const user = findUser(email);
        if (!user || user.role !== 'user') fail(404, 'Пользователь не найден.');
        run('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?', hashed, user.id);
        run('DELETE FROM sessions WHERE user_id=?', user.id);
        run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", user.id);
        audit(null, 'user.password_reset_cli', user.id, email);
      });
    },
    logout(token) { if (token) run('DELETE FROM sessions WHERE token_hash=?', hashToken(token)); },
    async changePassword(userId, next) {
      // Смена пароля доступна любому вошедшему пользователю без ввода текущего пароля.
      const password = passwordOf(next);
      const row = get('SELECT password_hash,must_change_password FROM users WHERE id=?', userId);
      if (!row) fail(401, 'Учётная запись не найдена.');
      const hashed = await passwordHash(password);
      return tx(() => {
        if (get('SELECT disabled FROM users WHERE id=?', userId)?.disabled) fail(401, 'Учётная запись отключена.');
        // Не меняем пароль поверх параллельной смены из другой сессии.
        const result = run('UPDATE users SET password_hash=?,must_change_password=0 WHERE id=? AND password_hash=?', hashed, userId, row.password_hash);
        if (!result.changes) fail(409, 'Пароль уже был изменён в другой сессии.');
        run('DELETE FROM sessions WHERE user_id=?', userId);
        run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", userId);
        const token = newSession(userId);
        audit(userId, 'user.password_change', userId);
        return token;
      });
    },
    listProjects(userId) {
      // Документ плат не нужен для списка: читаем только метаданные и превью.
      const columns = `p.id,p.owner_id,p.name,p.version,p.bytes,p.entity_count,p.created_at,p.updated_at,
        p.thumbnail,p.thumbnail_version`;
      const rows = all(`SELECT ${columns},owner.email AS owner_email,'owner' AS access_role
        FROM projects p JOIN users owner ON owner.id=p.owner_id WHERE p.owner_id=?
        UNION ALL
        SELECT ${columns},owner.email AS owner_email,'editor' AS access_role
        FROM project_members m JOIN projects p ON p.id=m.project_id JOIN users owner ON owner.id=p.owner_id
        WHERE m.user_id=? ORDER BY updated_at DESC`, userId, userId);
      return { projects: rows.map(projectCard), usedBytes: usedBytes(userId), quotaBytes };
    },
    setProjectThumbnail(projectId, userId, version, image) {
      const row = accessibleProject(projectId, userId);
      const checked = thumbnailOf(image);
      // Превью относится к конкретной версии: если плату уже изменили, оно устарело.
      if (row.version !== version) fail(409, 'Плата уже изменилась. Превью будет обновлено позже.');
      run('UPDATE projects SET thumbnail=?, thumbnail_version=? WHERE id=? AND version=?', checked, version, projectId, version);
      return { thumbnailVersion: version };
    },
    listLibrary(userId, isAdmin, url) {
      const { limit, offset } = pageOf(url);
      const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
      const rows = all(`SELECT id,owner_id,name,category,bytes,entity_count,created_at,updated_at
        FROM community_library ORDER BY updated_at DESC,name COLLATE NOCASE`);
      const matches = query
        ? rows.filter((row) => `${row.name} ${row.category}`.toLocaleLowerCase().includes(query))
        : rows;
      return { total: matches.length, entries: matches.slice(offset, offset + limit).map((row) => libraryMeta(row, userId, isAdmin)) };
    },
    getLibraryEntry(id, userId, isAdmin = false) {
      const row = get('SELECT * FROM community_library WHERE id=?', id);
      if (!row) fail(404, 'Общий элемент не найден.');
      return { ...libraryMeta(row, userId, isAdmin), macro: JSON.parse(row.macro_json) };
    },
    publishLibraryEntries(userId, rawEntries) {
      if (!Array.isArray(rawEntries) || rawEntries.length < 1 || rawEntries.length > MAX_LIBRARY_BATCH) {
        fail(400, `За один запрос можно опубликовать от 1 до ${MAX_LIBRARY_BATCH} деталей.`);
      }
      const entries = rawEntries.map(parseLibraryEntryInput);
      const batchKeys = new Set();
      for (const entry of entries) {
        const key = entry.nameKey + String.fromCharCode(0) + entry.categoryKey;
        if (batchKeys.has(key)) fail(400, 'В одной отправке повторяются название и папка детали.');
        batchKeys.add(key);
      }
      const now = Date.now();
      return tx(() => {
        let userCount = get('SELECT COUNT(*) AS n FROM community_library WHERE owner_id=?', userId).n;
        let userBytes = get('SELECT COALESCE(SUM(bytes),0) AS bytes FROM community_library WHERE owner_id=?', userId).bytes;
        let totalCount = get('SELECT COUNT(*) AS n FROM community_library').n;
        let totalBytes = get('SELECT COALESCE(SUM(bytes),0) AS bytes FROM community_library').bytes;
        const prepared = entries.map((entry) => {
          const existing = get(`SELECT * FROM community_library
            WHERE owner_id=? AND name_key=? AND category_key=?`, userId, entry.nameKey, entry.categoryKey);
          const id = existing?.id ?? randomUUID();
          const createdAt = existing?.created_at ?? now;
          const macro = {
            id, name: entry.name, folderId: null, ents: entry.ents, bl: entry.bl,
            ...(entry.query ? { query: entry.query } : {}), ...(entry.note ? { note: entry.note } : {}),
            createdAt,
          };
          const macroJson = JSON.stringify(macro);
          const bytes = Buffer.byteLength(macroJson) + Buffer.byteLength(entry.category);
          if (bytes > MAX_LIBRARY_ENTRY_BYTES) fail(413, `«${entry.name}» слишком велика (максимум ${Math.floor(MAX_LIBRARY_ENTRY_BYTES / 1024)} КиБ).`);
          return { ...entry, id, createdAt, existing, macroJson, bytes, updatedAt: now };
        });
        for (const entry of prepared) {
          const delta = entry.bytes - (entry.existing?.bytes ?? 0);
          userBytes += delta; totalBytes += delta;
          if (!entry.existing) { userCount++; totalCount++; }
        }
        if (userCount > MAX_LIBRARY_PER_USER || userBytes > MAX_LIBRARY_PER_USER_BYTES) {
          fail(413, `Лимит общей библиотеки: до ${MAX_LIBRARY_PER_USER} деталей и ${Math.floor(MAX_LIBRARY_PER_USER_BYTES / 1048576)} МиБ на пользователя.`);
        }
        if (totalCount > MAX_LIBRARY_ENTRIES || totalBytes > MAX_LIBRARY_TOTAL_BYTES) {
          fail(413, 'Общая библиотека сервера достигла лимита. Обратитесь к администратору.');
        }
        const result = prepared.map((entry) => {
          if (entry.existing) {
            run(`UPDATE community_library SET name=?,name_key=?,category=?,category_key=?,macro_json=?,bytes=?,entity_count=?,updated_at=?
              WHERE id=? AND owner_id=?`, entry.name, entry.nameKey, entry.category, entry.categoryKey,
            entry.macroJson, entry.bytes, entry.entityCount, entry.updatedAt, entry.id, userId);
          } else {
            run(`INSERT INTO community_library(id,owner_id,name,name_key,category,category_key,macro_json,bytes,entity_count,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`, entry.id, userId, entry.name, entry.nameKey, entry.category, entry.categoryKey,
            entry.macroJson, entry.bytes, entry.entityCount, entry.createdAt, entry.updatedAt);
          }
          audit(userId, entry.existing ? 'library.update' : 'library.publish', entry.id, entry.name);
          const row = {
            id: entry.id, owner_id: userId, name: entry.name, category: entry.category,
            bytes: entry.bytes, entity_count: entry.entityCount,
            created_at: entry.createdAt, updated_at: entry.updatedAt,
          };
          return { entry: libraryMeta(row, userId), created: !entry.existing };
        });
        return result;
      });
    },
    deleteLibraryEntry(id, actorId, isAdmin = false) {
      return tx(() => {
        const row = get('SELECT * FROM community_library WHERE id=?', id);
        if (!row) fail(404, 'Общий элемент не найден.');
        if (row.owner_id !== actorId && !isAdmin) fail(403, 'Удалить общий элемент может только его автор или администратор.');
        run('DELETE FROM community_library WHERE id=?', id);
        audit(actorId, 'library.delete', id, row.name);
      });
    },
    listMembers(projectId, userId) {
      const project = accessibleProject(projectId, userId);
      const members = all(`SELECT u.id,u.email,'editor' AS role,m.joined_at
        FROM project_members m JOIN users u ON u.id=m.user_id
        WHERE m.project_id=? ORDER BY m.joined_at`, projectId)
        .map((row) => ({ id: row.id, email: row.email, role: row.role, joinedAt: row.joined_at }));
      return { members: [
        { id: project.owner_id, email: project.owner_email, role: 'owner', joinedAt: project.created_at },
        ...members,
      ] };
    },
    addMember(projectId, actorId, emailInput) {
      const email = loginOf(emailInput);
      return tx(() => {
        const project = ownProject(projectId, actorId);
        const member = findUser(email);
        if (!member || member.disabled) fail(404, 'Пользователь с таким именем (ником) или почтой не найден либо отключён. Попросите его войти на сервер и повторите.');
        if (member.id === actorId) fail(400, 'Вы уже владелец этой платы.');
        if (get('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?', projectId, member.id)) fail(409, 'Этот пользователь уже имеет доступ.');
        if (get('SELECT COUNT(*) AS n FROM project_members WHERE project_id=?', projectId).n >= MAX_PROJECT_MEMBERS) {
          fail(409, 'У платы может быть один приглашённый редактор: владелец и ещё один участник. Сначала удалите текущего участника.');
        }
        run("INSERT INTO project_members(project_id,user_id,invited_by,role,joined_at) VALUES(?,?,?,'editor',?)",
          projectId, member.id, actorId, Date.now());
        audit(actorId, 'project.member.add', projectId, `${project.name}: ${member.email}`);
        return { member: { id: member.id, email: member.email, role: 'editor' } };
      });
    },
    removeMember(projectId, actorId, memberId) {
      tx(() => {
        const project = ownProject(projectId, actorId);
        const member = get('SELECT u.email FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND m.user_id=?', projectId, memberId);
        if (!member) fail(404, 'Участник проекта не найден.');
        run('DELETE FROM project_members WHERE project_id=? AND user_id=?', projectId, memberId);
        audit(actorId, 'project.member.remove', projectId, `${project.name}: ${member.email}`);
      });
    },
    listVersions(projectId, userId) {
      accessibleProject(projectId, userId);
      const rows = all('SELECT id,project_id,name,bytes,entity_count,created_at FROM project_versions WHERE project_id=? ORDER BY created_at DESC', projectId);
      return { versions: rows.map(versionMeta) };
    },
    getVersion(projectId, versionId, userId) {
      accessibleProject(projectId, userId);
      const row = get('SELECT * FROM project_versions WHERE id=? AND project_id=?', versionId, projectId);
      if (!row) fail(404, 'Версия не найдена.');
      return { ...versionMeta(row), document: JSON.parse(row.document) };
    },
    createVersion(projectId, userId, nameInput, document) {
      const name = versionNameOf(nameInput);
      return tx(() => {
        const project = accessibleProject(projectId, userId);
        // Имя документа в снимке совпадает с названием проекта, как и при сохранении.
        const parsed = parseDocument(document, project.name, maxProjectBytes);
        if (get('SELECT COUNT(*) AS n FROM project_versions WHERE project_id=?', projectId).n >= MAX_VERSIONS) {
          fail(413, `У проекта уже ${MAX_VERSIONS} версий. Удалите ненужные, чтобы сохранить новую.`);
        }
        ensureQuota(project.owner_id, parsed.bytes);
        const id = randomUUID(), now = Date.now();
        run('INSERT INTO project_versions(id,project_id,owner_id,name,document,bytes,entity_count,created_at) VALUES(?,?,?,?,?,?,?,?)',
          id, projectId, project.owner_id, name, parsed.text, parsed.bytes, parsed.entityCount, now);
        audit(userId, 'version.create', projectId, `${project.name}: ${name}`);
        return versionMeta({ id, project_id: projectId, name, bytes: parsed.bytes, entity_count: parsed.entityCount, created_at: now });
      });
    },
    deleteVersion(projectId, versionId, userId) {
      tx(() => {
        const project = accessibleProject(projectId, userId);
        const result = run('DELETE FROM project_versions WHERE id=? AND project_id=?', versionId, projectId);
        if (!result.changes) fail(404, 'Версия не найдена.');
        audit(userId, 'version.delete', projectId, project.name);
      });
    },
    getProject(id, userId) {
      const row = accessibleProject(id, userId);
      return { ...projectMeta(row), document: JSON.parse(row.document) };
    },
    createProject(userId, nameInput, document) {
      const name = projectName(nameInput), parsed = parseDocument(document, name, maxProjectBytes);
      return tx(() => {
        if (get('SELECT COUNT(*) AS n FROM projects WHERE owner_id=?', userId).n >= MAX_PROJECTS) fail(413, 'Достигнут предел: 1000 проектов на пользователя.');
        ensureQuota(userId, parsed.bytes);
        const id = randomUUID(), now = Date.now();
        run('INSERT INTO projects(id,owner_id,name,document,bytes,entity_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
          id, userId, name, parsed.text, parsed.bytes, parsed.entityCount, now, now);
        audit(userId, 'project.create', id, name);
        return projectMeta({ id, owner_id: userId, name, version: 1, bytes: parsed.bytes, entity_count: parsed.entityCount, created_at: now, updated_at: now });
      });
    },
    syncProject(id, userId, baseVersionInput, baseDocument, document) {
      const baseVersion = versionOf(baseVersionInput);
      return tx(() => {
        const row = accessibleProject(id, userId);
        if (baseVersion > row.version) fail(409, 'Клиентская версия новее сервера. Перезагрузите плату.');
        const baseParsed = parseDocument(baseDocument, row.name, maxProjectBytes);
        const localParsed = parseDocument(document, row.name, maxProjectBytes);
        const base = JSON.parse(baseParsed.text), local = JSON.parse(localParsed.text);
        const remote = JSON.parse(row.document);
        if (baseVersion === row.version && !documentsEqual(base, remote)) {
          fail(409, 'Базовая версия платы не совпадает с сервером. Загрузите актуальную плату и повторите.');
        }
        const merge = mergeDocuments(base, local, remote);
        if (!merge.ok) {
          const details = merge.conflicts.slice(0, 6).join(', ');
          fail(409, `Одновременные изменения конфликтуют (${details}). Скачайте свою копию или загрузите версию с сервера.`);
        }
        const parsed = parseDocument(merge.document, row.name, maxProjectBytes);
        const canonical = JSON.parse(parsed.text);
        if (documentsEqual(canonical, remote)) {
          return { ...projectMeta(row), document: remote, changed: false };
        }
        ensureQuota(row.owner_id, parsed.bytes, row.bytes);
        const now = Date.now();
        run('UPDATE projects SET document=?,bytes=?,entity_count=?,version=version+1,updated_at=? WHERE id=? AND version=?',
          parsed.text, parsed.bytes, parsed.entityCount, now, id, row.version);
        audit(userId, 'project.sync', id, row.name);
        return { ...projectMeta({ ...row, bytes: parsed.bytes, entity_count: parsed.entityCount, version: row.version + 1, updated_at: now }),
          document: canonical, changed: true };
      });
    },
    updateProject(id, userId, nameInput, document, versionInput) {
      const name = projectName(nameInput), version = versionOf(versionInput);
      const parsed = parseDocument(document, name, maxProjectBytes);
      return tx(() => {
        const row = accessibleProject(id, userId);
        if (row.version !== version) fail(409, 'Проект изменён в другой вкладке или на другом компьютере. Сохраните копию либо откройте новую версию.');
        ensureQuota(row.owner_id, parsed.bytes, row.bytes);
        const now = Date.now();
        run('UPDATE projects SET name=?, document=?, bytes=?, entity_count=?, version=version+1, updated_at=? WHERE id=?',
          name, parsed.text, parsed.bytes, parsed.entityCount, now, id);
        audit(userId, 'project.save', id, name);
        return projectMeta({ ...row, name, bytes: parsed.bytes, entity_count: parsed.entityCount, version: row.version + 1, updated_at: now });
      });
    },
    renameProject(id, userId, nameInput, versionInput) {
      const name = projectName(nameInput), version = versionOf(versionInput);
      return tx(() => {
        const row = ownProject(id, userId);
        if (row.version !== version) fail(409, 'Проект уже изменён. Обновите список.');
        const parsed = parseDocument(JSON.parse(row.document), name, maxProjectBytes);
        ensureQuota(userId, parsed.bytes, row.bytes);
        const now = Date.now();
        run('UPDATE projects SET name=?,document=?,bytes=?,version=version+1,updated_at=? WHERE id=?', name, parsed.text, parsed.bytes, now, id);
        audit(userId, 'project.rename', id, name);
        return projectMeta({ ...row, name, bytes: parsed.bytes, version: row.version + 1, updated_at: now });
      });
    },
    deleteProject(id, userId, versionInput) {
      const version = versionOf(versionInput);
      tx(() => {
        const row = ownProject(id, userId);
        if (row.version !== version) fail(409, 'Проект уже изменён. Обновите список.');
        run('DELETE FROM projects WHERE id=?', id);
        audit(userId, 'project.delete', id, row.name);
      });
    },
    adminOverview() {
      const users = get(`SELECT COUNT(*) AS total, COALESCE(SUM(disabled),0) AS disabled,
        COALESCE(SUM(email_verified_at IS NOT NULL),0) AS verified,
        COALESCE(SUM(must_change_password),0) AS must_change_password FROM users`);
      const projects = get('SELECT COUNT(*) AS total, COALESCE(SUM(bytes),0) AS bytes FROM projects');
      // версии входят в общий объём хранения (как и в квоту пользователя)
      const versions = get('SELECT COUNT(*) AS total, COALESCE(SUM(bytes),0) AS bytes FROM project_versions');
      return { users: users.total, disabledUsers: users.disabled, verifiedUsers: users.verified,
        unverifiedUsers: users.total - users.verified, usersMustChangePassword: users.must_change_password,
        projects: projects.total, versions: versions.total, bytes: projects.bytes + versions.bytes,
        projectBytes: projects.bytes, activeSessions: activeSessions(), registrationOpen: registrationOpen(),
        quotaBytes, maxProjectBytes };
    },
    adminUsers(url) {
      const { limit, offset, q } = pageOf(url);
      const where = 'WHERE u.email LIKE ? ESCAPE \'\\\'';
      const total = get(`SELECT COUNT(*) AS n FROM users u ${where}`, q).n;
      const rows = all(`SELECT u.id,u.email,u.role,u.disabled,u.created_at,u.last_login,u.email_verified_at,u.must_change_password,
        COUNT(p.id) AS project_count,
        COALESCE(SUM(p.bytes),0) + COALESCE((SELECT SUM(v.bytes) FROM project_versions v WHERE v.owner_id=u.id),0) AS bytes,
        (SELECT COUNT(*) FROM project_members m WHERE m.user_id=u.id) AS shared_project_count,
        (SELECT COUNT(*) FROM project_versions v WHERE v.owner_id=u.id) AS version_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS active_sessions
        FROM users u LEFT JOIN projects p ON p.owner_id=u.id ${where}
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, Date.now(), q, limit, offset);
      return { total, users: rows.map((row) => ({ id: row.id, email: row.email, role: row.role,
        disabled: !!row.disabled, createdAt: row.created_at, lastLogin: row.last_login,
        emailVerifiedAt: row.email_verified_at, mustChangePassword: !!row.must_change_password,
        projectCount: row.project_count, sharedProjectCount: row.shared_project_count,
        versionCount: row.version_count, activeSessions: row.active_sessions, bytes: row.bytes })) };
    },
    adminUserDetail(targetId, actorId) {
      const row = get(`SELECT id,email,role,disabled,created_at,last_login,email_verified_at,must_change_password
        FROM users WHERE id=?`, targetId);
      if (!row) fail(404, 'Пользователь не найден.');
      audit(actorId, 'admin.user.view', targetId, row.email);
      const ownedProjects = all(`SELECT p.*,owner.email AS owner_email,'owner' AS access_role
        FROM projects p JOIN users owner ON owner.id=p.owner_id WHERE p.owner_id=? ORDER BY p.updated_at DESC`, targetId)
        .map(projectMeta);
      const sharedProjects = all(`SELECT p.*,owner.email AS owner_email,'editor' AS access_role
        FROM project_members m JOIN projects p ON p.id=m.project_id JOIN users owner ON owner.id=p.owner_id
        WHERE m.user_id=? ORDER BY p.updated_at DESC`, targetId).map(projectMeta);
      const shared = get(`SELECT COUNT(*) AS projects,COALESCE(SUM(p.bytes),0) AS bytes
        FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.user_id=?`, targetId);
      const active = all('SELECT created_at,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC', targetId, Date.now())
        .map((session) => ({ createdAt: session.created_at, expiresAt: session.expires_at }));
      const actionCount = get('SELECT COUNT(*) AS n FROM audit WHERE actor_id=?', targetId).n;
      const recentEvents = all(`SELECT a.id,a.actor_id,a.action,a.target_id,a.detail,a.at,u.email AS actor_email
        FROM audit a LEFT JOIN users u ON u.id=a.actor_id
        WHERE a.actor_id=? OR a.target_id=? ORDER BY a.id DESC LIMIT 20`, targetId, targetId)
        .map((event) => ({ id: event.id, actorId: event.actor_id, actorEmail: event.actor_email,
          action: event.action, targetId: event.target_id, detail: event.detail, at: event.at }));
      return { user: { id: row.id, email: row.email, role: row.role, disabled: !!row.disabled,
        createdAt: row.created_at, lastLogin: row.last_login, emailVerifiedAt: row.email_verified_at,
        mustChangePassword: !!row.must_change_password }, twoFactorRequired: true,
        ownedProjects, sharedProjects, projectCount: ownedProjects.length, sharedProjectCount: shared.projects,
        versionCount: get('SELECT COUNT(*) AS n FROM project_versions WHERE owner_id=?', targetId).n,
        bytes: usedBytes(targetId), sharedBytes: shared.bytes, quotaBytes,
        activeSessions: active, actionCount, recentEvents };
    },
    async adminResetUserPassword(actorId, targetId, authorize = () => {}) {
      const temporaryPassword = randomBytes(24).toString('base64url');
      const hashed = await passwordHash(temporaryPassword);
      return tx(() => {
        authorize();
        const user = get('SELECT id,email,role FROM users WHERE id=?', targetId);
        if (!user) fail(404, 'Пользователь не найден.');
        if (targetId === actorId) fail(403, 'Нельзя сбросить собственный пароль в админ-панели.');
        run('UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?', hashed, targetId);
        run('DELETE FROM sessions WHERE user_id=?', targetId);
        run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", targetId);
        audit(actorId, 'admin.user.password_reset', targetId, user.email);
        return { temporaryPassword };
      });
    },
    adminProjects(url) {
      const { limit, offset, q } = pageOf(url);
      const ownerId = url.searchParams.get('ownerId') ?? '';
      if (ownerId && !/^[0-9a-f-]{36}$/i.test(ownerId)) fail(400, 'Некорректный ID владельца.');
      const where = `WHERE (p.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\') AND (?='' OR p.owner_id=?)`;
      const args = [q, q, ownerId, ownerId];
      const total = get(`SELECT COUNT(*) AS n FROM projects p JOIN users u ON u.id=p.owner_id ${where}`, ...args).n;
      const rows = all(`SELECT p.id,p.owner_id,p.name,p.version,p.bytes,p.entity_count,p.created_at,p.updated_at,u.email AS owner_email
        FROM projects p JOIN users u ON u.id=p.owner_id ${where}
        ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
      return { total, projects: rows.map(projectMeta) };
    },
    adminGetProject(id, actorId) {
      const row = get(`SELECT p.*,u.email AS owner_email FROM projects p JOIN users u ON u.id=p.owner_id WHERE p.id=?`, id);
      if (!row) fail(404, 'Проект не найден.');
      audit(actorId, 'admin.project.download', id, `${row.owner_email}: ${row.name}`);
      return { ...projectMeta(row), document: JSON.parse(row.document) };
    },
    adminEvents(url) {
      const { limit, offset } = pageOf(url);
      const total = get('SELECT COUNT(*) AS n FROM audit').n;
      return { total, events: all(`SELECT a.id,a.actor_id,a.action,a.target_id,a.detail,a.at,u.email AS actor_email
        FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT ? OFFSET ?`, limit, offset)
        .map((row) => ({ id: row.id, actorId: row.actor_id, actorEmail: row.actor_email,
          action: row.action, targetId: row.target_id, detail: row.detail, at: row.at })) };
    },
    adminUpdateUser(actorId, targetId, patch) {
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)
        || Object.keys(patch).length !== 1
        || !('disabled' in patch || 'role' in patch)) fail(400, 'Измените статус или роль пользователя.');
      return tx(() => {
        const user = get('SELECT * FROM users WHERE id=?', targetId);
        if (!user) fail(404, 'Пользователь не найден.');
        if (targetId === actorId) fail(403, 'Нельзя менять собственную роль или блокировать себя.');
        if ('disabled' in patch) {
          if (typeof patch.disabled !== 'boolean') fail(400, 'Некорректный статус пользователя.');
          if (user.role === 'admin' && patch.disabled && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n <= 1)
            fail(409, 'Нельзя отключить последнего активного администратора.');
          run('UPDATE users SET disabled=? WHERE id=?', Number(patch.disabled), targetId);
          if (patch.disabled) {
            run('DELETE FROM sessions WHERE user_id=?', targetId);
            run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", targetId);
          }
          audit(actorId, patch.disabled ? 'admin.user.disable' : 'admin.user.enable', targetId, user.email);
        } else {
          if (!['user', 'admin'].includes(patch.role)) fail(400, 'Некорректная роль.');
          if (user.role === 'admin' && patch.role === 'user' && !user.disabled
            && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n <= 1)
            fail(409, 'Нельзя снять роль с последнего активного администратора.');
          run('UPDATE users SET role=? WHERE id=?', patch.role, targetId);
          run('DELETE FROM sessions WHERE user_id=?', targetId);
          run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", targetId);
          audit(actorId, 'admin.user.role', targetId, `${user.email} → ${patch.role}`);
        }
        return { id: targetId, disabled: 'disabled' in patch ? patch.disabled : !!user.disabled,
          role: 'role' in patch ? patch.role : user.role };
      });
    },
    adminRevokeSessions(actorId, targetId) {
      tx(() => {
        const user = get('SELECT email FROM users WHERE id=?', targetId);
        if (!user) fail(404, 'Пользователь не найден.');
        run('DELETE FROM sessions WHERE user_id=?', targetId);
        run("DELETE FROM auth_challenges WHERE user_id=? AND purpose='login'", targetId);
        audit(actorId, 'admin.user.sessions_revoked', targetId, user.email);
      });
    },
    adminDeleteUser(actorId, targetId) {
      tx(() => {
        const user = get('SELECT * FROM users WHERE id=?', targetId);
        if (!user) fail(404, 'Пользователь не найден.');
        if (targetId === actorId) fail(403, 'Нельзя удалить собственную учётную запись.');
        if (user.role === 'admin' && !user.disabled
          && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n <= 1)
          fail(409, 'Нельзя удалить последнего активного администратора.');
        const count = get('SELECT COUNT(*) AS n FROM projects WHERE owner_id=?', targetId).n;
        run('DELETE FROM users WHERE id=?', targetId); // CASCADE: проекты и сеансы
        audit(actorId, 'admin.user.delete', targetId, `${user.email}; проектов: ${count}`);
      });
    },
    adminDeleteProject(actorId, projectId) {
      tx(() => {
        const row = get('SELECT name FROM projects WHERE id=?', projectId);
        if (!row) fail(404, 'Проект не найден.');
        run('DELETE FROM projects WHERE id=?', projectId);
        audit(actorId, 'admin.project.delete', projectId, row.name);
      });
    },
    adminSetRegistration(actorId, open) {
      if (typeof open !== 'boolean') fail(400, 'Некорректная настройка регистрации.');
      tx(() => {
        run("UPDATE settings SET value=? WHERE key='registration_open'", open ? '1' : '0');
        audit(actorId, 'admin.registration', null, open ? 'открыта' : 'закрыта');
      });
    },
  };
}

// Небольшие лимиты на вход/регистрацию по IP и адресу (в памяти одного процесса).
const attempts = new Map();
function checkAttempt(key, max) {
  const entry = attempts.get(key);
  if (entry && entry.until > Date.now() && entry.count >= max) fail(429, 'Слишком много попыток. Повторите позже.');
}
function recordAttempt(key, interval) {
  const now = Date.now();
  if (attempts.size > 20_000) {
    for (const [k, entry] of attempts) if (entry.until < now) attempts.delete(k);
    // Случайные адреса не должны безгранично заполнять память сервера.
    while (attempts.size > 20_000) attempts.delete(attempts.keys().next().value);
  }
  const entry = attempts.get(key);
  attempts.set(key, { until: entry?.until > now ? entry.until : now + interval, count: (entry?.until > now ? entry.count : 0) + 1 });
}
function limitAttempt(key, max, interval) { checkAttempt(key, max); recordAttempt(key, interval); }
function clientIp(req) {
  // Доверять X-Forwarded-For можно только за настроенным администратором прокси.
  if (process.env.PSBEES_TRUST_PROXY === '1') {
    const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (isIP(first)) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** HTTP-маршруты /api/cloud/*; не раздавайте этот префикс как SPA. */
export async function createCloudService(dataDir, opts = {}) {
  // updater(req, res, cmd, url) — обработчик обновления программы из GitHub (передаёт server.mjs).
  const updater = typeof opts.updater === 'function' ? opts.updater : null;
  // По умолчанию сервер работает в простом режиме входа/регистрации по нику (без SMTP и пароля).
  // Если передан mailer или задан PSBEES_SMTP_HOST, включается двухфакторный режим по почте.
  const hasSmtp = Boolean(opts.mailer?.sendOtp || String(process.env.PSBEES_SMTP_HOST ?? '').trim());
  const mailer = hasSmtp ? await createOtpMailer(opts) : null;
  const twoFactorRequired = Boolean(mailer);
  const store = await openCloudStore(dataDir, opts);
  const projectWaiters = new Map();
  const presence = new Map();
  const presenceCleanup = setInterval(() => {
    const now = Date.now();
    for (const [projectId, people] of presence) {
      for (const [id, item] of people) if (now - item.lastSeen > PRESENCE_MS) people.delete(id);
      if (!people.size) presence.delete(projectId);
    }
  }, PRESENCE_MS);
  presenceCleanup.unref?.();

  const sendChallenge = async (challenge) => {
    try {
      await mailer.sendOtp({ to: challenge.email, code: challenge.code, purpose: challenge.purpose });
    } catch (error) {
      store.cancelAuthChallenge(challenge.challengeId);
      // Не пишем адрес, содержимое письма, SMTP-конфигурацию или OTP в журнал.
      console.error('[cloud] Не удалось отправить письмо с кодом:', String(error?.code || error?.name || 'SMTP error').slice(0, 80));
      fail(503, 'Не удалось отправить код на почту. Проверьте SMTP-настройки сервера и повторите позже.');
    }
    return {
      challengeId: challenge.challengeId,
      email: maskedEmail(challenge.email),
      expiresAt: challenge.expiresAt,
      resendAfterSeconds: Math.ceil(AUTH_RESEND_MS / 1000),
    };
  };
  const wakeProject = (projectId) => {
    const waiting = projectWaiters.get(projectId);
    if (waiting) for (const notify of [...waiting]) notify();
  };
  const wakeAll = () => {
    for (const waiting of projectWaiters.values()) for (const notify of [...waiting]) notify();
  };
  const touchPresence = (projectId, actor) => {
    let people = presence.get(projectId);
    if (!people) { people = new Map(); presence.set(projectId, people); }
    people.set(actor.id, { email: actor.email, lastSeen: Date.now() });
  };
  const participantsFor = (projectId, actorId) => {
    const people = presence.get(projectId);
    const now = Date.now();
    if (people) {
      for (const [id, item] of people) if (now - item.lastSeen > PRESENCE_MS) people.delete(id);
      if (!people.size) presence.delete(projectId);
    }
    const active = presence.get(projectId) ?? new Map();
    return store.listMembers(projectId, actorId).members.map((member) => ({
      id: member.id, email: member.email, role: member.role,
      online: !!active.get(member.id) && now - active.get(member.id).lastSeen <= PRESENCE_MS,
    }));
  };
  const waitForProject = async (res, projectId, userId, since, timeoutMs) => {
    const current = store.getProject(projectId, userId);
    if (current.version > since || timeoutMs <= 0) return current.version > since ? current : null;
    return new Promise((resolveWait, rejectWait) => {
      let finished = false;
      let timer;
      const waiting = projectWaiters.get(projectId) ?? new Set();
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        waiting.delete(onChange);
        if (!waiting.size) projectWaiters.delete(projectId);
        res.off('close', onClose);
      };
      const onClose = () => { cleanup(); resolveWait(null); };
      const onChange = () => {
        if (finished) return;
        try {
          const latest = store.getProject(projectId, userId);
          if (latest.version <= since) return;
          cleanup();
          resolveWait(latest);
        } catch (error) {
          cleanup();
          rejectWait(error);
        }
      };
      waiting.add(onChange);
      projectWaiters.set(projectId, waiting);
      timer = setTimeout(() => { cleanup(); resolveWait(null); }, timeoutMs);
      res.once('close', onClose);
      // Covers a project update that landed immediately before the waiter was registered.
      onChange();
    });
  };

  const respond = async (req, res, url) => {
    const path = url.pathname.slice('/api/cloud'.length);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') requireWriteRequest(req);
    if (path === '/config' && method === 'GET') return json(res, 200, {
      ok: true, enabled: true, registrationOpen: store.registrationOpen(),
      twoFactorRequired,
      passwordRequired: true,
      authMode: twoFactorRequired ? 'email-otp' : 'nickname',
      maxProjectBytes: store.maxProjectBytes, quotaBytes: store.quotaBytes,
    });
    if (path === '/register' && method === 'POST') {
      const body = await readJson(req, 2048);
      if (!twoFactorRequired) {
        limitAttempt('reg:' + clientIp(req), 30, 15 * 60_000);
        const rawLogin = body.name ?? body.login ?? body.nickname ?? body.email;
        const result = await store.registerByNickname(rawLogin, body.password);
        return json(res, 200, { ok: true, user: result.user, created: true }, { 'set-cookie': cookieHeader(req, result.token) });
      }
      limitAttempt('reg:' + clientIp(req), 8, 60 * 60_000);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (email) limitAttempt('reg-email:' + email, 5, 60 * 60_000);
      const challenge = await store.beginRegistration(body.email, body.password);
      return json(res, 202, { ok: true, ...await sendChallenge(challenge) });
    }
    if (path === '/register/verify' && method === 'POST') {
      const body = await readJson(req, 2048);
      limitAttempt('otp-verify:' + clientIp(req), 60, 15 * 60_000);
      const result = await store.verifyAuthChallenge(body.challengeId, 'register', body.code);
      return json(res, 200, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(req, result.token) });
    }
    if (path === '/login' && method === 'POST') {
      const body = await readJson(req, 2048);
      if (!twoFactorRequired) {
        limitAttempt('login:' + clientIp(req), 60, 15 * 60_000);
        const rawLogin = body.name ?? body.login ?? body.nickname ?? body.email;
        const result = await store.loginByNickname(rawLogin, body.password);
        return json(res, 200, { ok: true, user: result.user, created: result.created }, { 'set-cookie': cookieHeader(req, result.token) });
      }
      const ipKey = 'login:' + clientIp(req);
      const emailKey = typeof body.email === 'string' && body.email.length < 255
        ? 'login-email:' + body.email.trim().toLowerCase() : null;
      const sendIpKey = 'otp-send:' + clientIp(req);
      const sendEmailKey = emailKey ? 'otp-send-email:' + emailKey.slice('login-email:'.length) : null;
      checkAttempt(ipKey, 30);
      if (emailKey) checkAttempt(emailKey, 15);
      checkAttempt(sendIpKey, 12);
      if (sendEmailKey) checkAttempt(sendEmailKey, 8);
      let challenge;
      try { challenge = await store.beginLogin(body.email, body.password); }
      catch (error) {
        if (error?.status === 401 || error?.status === 400) {
          recordAttempt(ipKey, 15 * 60_000);
          if (emailKey) recordAttempt(emailKey, 15 * 60_000);
        }
        throw error;
      }
      if (emailKey) attempts.delete(emailKey);
      try {
        limitAttempt(sendIpKey, 12, 15 * 60_000);
        if (sendEmailKey) limitAttempt(sendEmailKey, 8, 15 * 60_000);
      } catch (error) {
        store.cancelAuthChallenge(challenge.challengeId);
        throw error;
      }
      return json(res, 202, { ok: true, ...await sendChallenge(challenge) });
    }
    if (path === '/login/verify' && method === 'POST') {
      const body = await readJson(req, 2048);
      limitAttempt('otp-verify:' + clientIp(req), 60, 15 * 60_000);
      const result = await store.verifyAuthChallenge(body.challengeId, 'login', body.code);
      return json(res, 200, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(req, result.token) });
    }
    if ((path === '/login/resend' || path === '/register/resend') && method === 'POST') {
      const body = await readJson(req, 2048);
      limitAttempt('otp-resend:' + clientIp(req), 12, 60 * 60_000);
      const expected = path.startsWith('/login') ? 'login' : 'register';
      const challenge = await store.resendAuthChallenge(body.challengeId, expected);
      return json(res, 200, { ok: true, ...await sendChallenge(challenge) });
    }

    const token = bearerCookie(req);
    const actor = store.session(token);
    const stillAuthorized = (admin = false) => {
      const fresh = store.session(token);
      if (!fresh) fail(401, 'Сеанс завершён. Войдите снова.');
      if (admin && fresh.role !== 'admin') fail(403, 'Доступно только администратору.');
      return fresh;
    };
    if (path === '/logout' && method === 'POST') {
      store.logout(token);
      return json(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, null) });
    }
    if (!actor) fail(401, 'Войдите в учётную запись.');
    if (actor.must_change_password && !['/me', '/password'].includes(path)) {
      fail(403, 'Сначала задайте новый пароль для продолжения работы.');
    }
    if (path === '/me' && method === 'GET') return json(res, 200, { ok: true, user: publicUser(actor) });
    if (path === '/password' && method === 'POST') {
      const body = await readJson(req, 2048);
      stillAuthorized();
      const nextToken = await store.changePassword(actor.id, body.newPassword);
      return json(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, nextToken) });
    }
    if (path === '/projects' && method === 'GET') return json(res, 200, { ok: true, ...store.listProjects(actor.id) });
    if (path === '/projects' && method === 'POST') {
      const body = await readJson(req);
      stillAuthorized();
      return json(res, 201, { ok: true, project: store.createProject(actor.id, body.name, body.document) });
    }
    if (path === '/library' && method === 'GET') {
      stillAuthorized();
      return json(res, 200, { ok: true, ...store.listLibrary(actor.id, actor.role === 'admin', url) });
    }
    if (path === '/library' && method === 'POST') {
      const body = await readJson(req, MAX_LIBRARY_ENTRY_BYTES + 32 * 1024);
      const fresh = stillAuthorized();
      const [result] = store.publishLibraryEntries(fresh.id, [body]);
      return json(res, result.created ? 201 : 200, { ok: true, ...result });
    }
    if (path === '/library/batch' && method === 'POST') {
      const body = await readJson(req, MAX_LIBRARY_BATCH * MAX_LIBRARY_ENTRY_BYTES + 2 * 1024 * 1024);
      const fresh = stillAuthorized();
      if (!Array.isArray(body.entries)) fail(400, 'Для публикации передайте список деталей.');
      return json(res, 200, { ok: true, results: store.publishLibraryEntries(fresh.id, body.entries) });
    }
    const libraryEntry = /^\/library\/([0-9a-f-]{36})$/i.exec(path);
    if (libraryEntry && method === 'GET') {
      stillAuthorized();
      return json(res, 200, { ok: true, entry: store.getLibraryEntry(libraryEntry[1], actor.id, actor.role === 'admin') });
    }
    if (libraryEntry && method === 'DELETE') {
      const fresh = stillAuthorized();
      store.deleteLibraryEntry(libraryEntry[1], fresh.id, fresh.role === 'admin');
      return json(res, 200, { ok: true });
    }

    const presenceRoute = /^\/projects\/([0-9a-f-]{36})\/presence$/i.exec(path);
    if (presenceRoute && method === 'POST') {
      await readJson(req, 2048);
      const fresh = stillAuthorized();
      store.getProject(presenceRoute[1], fresh.id);
      touchPresence(presenceRoute[1], fresh);
      return json(res, 200, { ok: true, participants: participantsFor(presenceRoute[1], fresh.id), presenceMs: PRESENCE_MS });
    }
    const syncRoute = /^\/projects\/([0-9a-f-]{36})\/sync$/i.exec(path);
    if (syncRoute && method === 'GET') {
      const id = syncRoute[1];
      const since = Number(url.searchParams.get('since'));
      const wait = Number(url.searchParams.get('wait') ?? 20);
      if (!Number.isSafeInteger(since) || since < 1 || !Number.isInteger(wait) || wait < 0 || wait > 25) {
        fail(400, 'Некорректная версия синхронизации.');
      }
      stillAuthorized();
      const project = await waitForProject(res, id, actor.id, since, wait * 1000);
      if (res.destroyed) return;
      stillAuthorized();
      return json(res, 200, {
        ok: true, project, participants: participantsFor(id, actor.id),
        changed: !!project, serverTime: Date.now(),
      });
    }
    if (syncRoute && method === 'POST') {
      const body = await readJson(req, MAX_PROJECT_BYTES * 2 + 2 * 1024 * 1024);
      stillAuthorized();
      const project = store.syncProject(syncRoute[1], actor.id, body.baseVersion, body.baseDocument, body.document);
      if (project.changed) wakeProject(syncRoute[1]);
      return json(res, 200, { ok: true, project });
    }

    const thumbnailRoute = /^\/projects\/([0-9a-f-]{36})\/thumbnail$/i.exec(path);
    if (thumbnailRoute && method === 'POST') {
      const body = await readJson(req, 160 * 1024);
      const fresh = stillAuthorized();
      const result = store.setProjectThumbnail(thumbnailRoute[1], fresh.id, body.version, body.image);
      return json(res, 200, { ok: true, ...result });
    }

    const members = /^\/projects\/([0-9a-f-]{36})\/members$/i.exec(path);
    if (members) {
      if (method === 'GET') return json(res, 200, { ok: true, ...store.listMembers(members[1], actor.id) });
      if (method === 'POST') {
        const body = await readJson(req, 2048);
        stillAuthorized();
        const result = store.addMember(members[1], actor.id, body.email);
        wakeProject(members[1]);
        return json(res, 201, { ok: true, ...result });
      }
    }
    const member = /^\/projects\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i.exec(path);
    if (member && method === 'DELETE') {
      stillAuthorized();
      store.removeMember(member[1], actor.id, member[2]);
      wakeProject(member[1]);
      return json(res, 200, { ok: true });
    }

    const project = /^\/projects\/([0-9a-f-]{36})$/i.exec(path);
    if (project) {
      const id = project[1];
      if (method === 'GET') return json(res, 200, { ok: true, project: store.getProject(id, actor.id) });
      const body = await readJson(req, method === 'PUT' ? undefined : 2048);
      stillAuthorized();
      if (method === 'PUT') {
        const updated = store.updateProject(id, actor.id, body.name, body.document, body.version);
        wakeProject(id);
        return json(res, 200, { ok: true, project: updated });
      }
      if (method === 'PATCH') {
        const updated = store.renameProject(id, actor.id, body.name, body.version);
        wakeProject(id);
        return json(res, 200, { ok: true, project: updated });
      }
      if (method === 'DELETE') {
        store.deleteProject(id, actor.id, body.version);
        wakeProject(id);
        return json(res, 200, { ok: true });
      }
    }
    const versions = /^\/projects\/([0-9a-f-]{36})\/versions$/i.exec(path);
    if (versions) {
      if (method === 'GET') return json(res, 200, { ok: true, ...store.listVersions(versions[1], actor.id) });
      if (method === 'POST') {
        const body = await readJson(req);
        stillAuthorized();
        return json(res, 201, { ok: true, version: store.createVersion(versions[1], actor.id, body.name, body.document) });
      }
    }
    const version = /^\/projects\/([0-9a-f-]{36})\/versions\/([0-9a-f-]{36})$/i.exec(path);
    if (version) {
      if (method === 'GET') return json(res, 200, { ok: true, version: store.getVersion(version[1], version[2], actor.id) });
      if (method === 'DELETE') {
        stillAuthorized();
        store.deleteVersion(version[1], version[2], actor.id);
        return json(res, 200, { ok: true });
      }
    }
    if (path.startsWith('/admin/update/')) {
      // Обновление программы из GitHub: только администратор; логика живёт в server.mjs.
      if (actor.role !== 'admin') fail(403, 'Доступно только администратору.');
      if (!updater) fail(501, 'Обновление из GitHub недоступно в этом режиме запуска.');
      const cmd = path.slice('/admin/update/'.length);
      const expected = cmd === 'run' || cmd === 'cancel' ? 'POST' : 'GET';
      if (!['check', 'status', 'run', 'cancel'].includes(cmd)) fail(404, 'Неизвестная команда обновления.');
      if (method !== expected) fail(405, 'Метод не поддерживается.');
      const fresh = stillAuthorized(true);
      if (cmd === 'run') store.auditEvent(fresh.id, 'admin.update.run', fresh.email);
      return updater(req, res, cmd, url);
    }
    if (path.startsWith('/admin')) {
      if (actor.role !== 'admin') fail(403, 'Доступно только администратору.');
      if (path === '/admin/overview' && method === 'GET') return json(res, 200, { ok: true, ...store.adminOverview() });
      if (path === '/admin/users' && method === 'GET') return json(res, 200, { ok: true, ...store.adminUsers(url) });
      if (path === '/admin/projects' && method === 'GET') return json(res, 200, { ok: true, ...store.adminProjects(url) });
      if (path === '/admin/events' && method === 'GET') return json(res, 200, { ok: true, ...store.adminEvents(url) });
      if (path === '/admin/settings' && method === 'PATCH') {
        const body = await readJson(req, 2048);
        stillAuthorized(true);
        store.adminSetRegistration(actor.id, body.registrationOpen);
        return json(res, 200, { ok: true, registrationOpen: body.registrationOpen });
      }
      const userSessions = /^\/admin\/users\/([0-9a-f-]{36})\/sessions$/i.exec(path);
      if (userSessions && method === 'DELETE') {
        stillAuthorized(true);
        store.adminRevokeSessions(actor.id, userSessions[1]);
        return json(res, 200, { ok: true });
      }
      const userPasswordReset = /^\/admin\/users\/([0-9a-f-]{36})\/password$/i.exec(path);
      if (userPasswordReset && method === 'POST') {
        const body = await readJson(req, 2048);
        if (Object.keys(body).length) fail(400, 'Сброс пароля не принимает пользовательский пароль.');
        stillAuthorized(true);
        return json(res, 200, { ok: true, ...await store.adminResetUserPassword(actor.id, userPasswordReset[1], () => stillAuthorized(true)) });
      }
      const user = /^\/admin\/users\/([0-9a-f-]{36})$/i.exec(path);
      if (user) {
        if (method === 'GET') return json(res, 200, { ok: true, ...store.adminUserDetail(user[1], actor.id) });
        if (method === 'PATCH') {
          const body = await readJson(req, 2048);
          stillAuthorized(true);
          return json(res, 200, { ok: true, user: store.adminUpdateUser(actor.id, user[1], body) });
        }
        if (method === 'DELETE') {
          store.adminDeleteUser(actor.id, user[1]);
          wakeAll();
          return json(res, 200, { ok: true });
        }
      }
      const adminProject = /^\/admin\/projects\/([0-9a-f-]{36})$/i.exec(path);
      if (adminProject) {
        if (method === 'GET') return json(res, 200, { ok: true, project: store.adminGetProject(adminProject[1], actor.id) });
        if (method === 'DELETE') {
          store.adminDeleteProject(actor.id, adminProject[1]);
          wakeProject(adminProject[1]);
          return json(res, 200, { ok: true });
        }
      }
    }
    fail(404, 'Неизвестная команда облачного сервера.');
  };
  return {
    close() {
      clearInterval(presenceCleanup);
      for (const waiting of projectWaiters.values()) for (const notify of [...waiting]) notify();
      store.close();
    },
    async handle(req, res, url) {
      try { await respond(req, res, url); }
      catch (error) {
        if (!error?.status) console.error('[cloud] запрос завершился ошибкой:', error);
        if (!res.headersSent && !res.destroyed) json(res, error?.status ?? 500,
          { ok: false, error: error?.status ? error.message : 'Внутренняя ошибка сервера.' });
      }
    },
  };
}
