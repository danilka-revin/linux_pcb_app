// Многопользовательский режим PSBees. Данные — SQLite в отдельном каталоге,
// который НЕ раздаётся веб-сервером. Требуется Node.js >= 22 (node:sqlite).
// Модуль загружается только при включённом --cloud; локальный Electron/Node 18
// по-прежнему работают без базы данных.
import { randomBytes, randomUUID, createHash, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';

const scrypt = promisify(scryptCb);
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const COOKIE = 'psbees_session';
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const DEFAULT_QUOTA_BYTES = 250 * 1024 * 1024;
const MAX_PROJECTS = 1000;
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
});

function emailOf(value) {
  if (typeof value !== 'string') fail(400, 'Введите корректный адрес электронной почты.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) fail(400, 'Введите корректный адрес электронной почты.');
  return email;
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
      created_at INTEGER NOT NULL, last_login INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, document TEXT NOT NULL, bytes INTEGER NOT NULL, entity_count INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS projects_owner ON projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS projects_recent ON projects(updated_at DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('registration_open', '1');
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
      target_id TEXT, detail TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_recent ON audit(at DESC);
  `);

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
  const findUser = (email) => get('SELECT * FROM users WHERE email=?', email);
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
  const projectMeta = (row) => ({
    id: row.id, ownerId: row.owner_id, name: row.name, version: row.version,
    bytes: row.bytes, entityCount: row.entity_count, createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.owner_email ? { ownerEmail: row.owner_email } : {}),
  });
  const ownProject = (id, userId) => {
    const row = get('SELECT * FROM projects WHERE id=? AND owner_id=?', id, userId);
    if (!row) fail(404, 'Проект не найден.');
    return row;
  };
  const ensureQuota = (ownerId, nextBytes, oldBytes = 0) => {
    const used = get('SELECT COALESCE(SUM(bytes),0) AS bytes FROM projects WHERE owner_id=?', ownerId).bytes;
    if (used - oldBytes + nextBytes > quotaBytes) fail(413, 'Квота проектов исчерпана. Скачайте или удалите ненужные проекты.');
  };
  const activeSessions = () => get('SELECT COUNT(*) AS n FROM sessions WHERE expires_at>?', Date.now()).n;

  return {
    dir, dbPath, quotaBytes, maxProjectBytes, close: () => db.close(),
    registrationOpen, session, findUser, activeSessions,
    async createAdmin(emailInput, passwordInput) {
      const email = emailOf(emailInput), password = passwordOf(passwordInput);
      const hashed = await passwordHash(password);
      return tx(() => {
        if (get("SELECT COUNT(*) AS n FROM users WHERE role='admin'").n) fail(409, 'Администратор уже создан. Для восстановления используйте reset-admin-password.');
        if (findUser(email)) fail(409, 'Этот адрес уже зарегистрирован. Укажите другой адрес администратора.');
        const id = randomUUID(), now = Date.now();
        run("INSERT INTO users(id,email,password_hash,role,created_at) VALUES(?,?,?,'admin',?)", id, email, hashed, now);
        audit(id, 'admin.bootstrap', id, email);
        return publicUser({ id, email, role: 'admin', created_at: now });
      });
    },
    async resetAdminPassword(emailInput, passwordInput) {
      const email = emailOf(emailInput), password = passwordOf(passwordInput);
      const hashed = await passwordHash(password);
      tx(() => {
        const user = findUser(email);
        if (!user || user.role !== 'admin') fail(404, 'Администратор не найден.');
        run('UPDATE users SET password_hash=?, disabled=0 WHERE id=?', hashed, user.id);
        run('DELETE FROM sessions WHERE user_id=?', user.id);
        audit(user.id, 'admin.password_reset_cli', user.id, email);
      });
    },
    async resetUserPassword(emailInput, passwordInput) {
      const email = emailOf(emailInput), password = passwordOf(passwordInput);
      const hashed = await passwordHash(password);
      tx(() => {
        const user = findUser(email);
        if (!user || user.role !== 'user') fail(404, 'Пользователь не найден.');
        run('UPDATE users SET password_hash=? WHERE id=?', hashed, user.id);
        run('DELETE FROM sessions WHERE user_id=?', user.id);
        audit(null, 'user.password_reset_cli', user.id, email);
      });
    },
    async register(emailInput, passwordInput) {
      const email = emailOf(emailInput), password = passwordOf(passwordInput);
      if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
      const hashed = await passwordHash(password);
      return tx(() => {
        if (!registrationOpen()) fail(403, 'Самостоятельная регистрация отключена администратором.');
        if (findUser(email)) fail(409, 'Этот адрес уже зарегистрирован.');
        const id = randomUUID(), now = Date.now();
        run("INSERT INTO users(id,email,password_hash,role,created_at,last_login) VALUES(?,?,?,'user',?,?)", id, email, hashed, now, now);
        const token = newSession(id);
        audit(id, 'user.register', id, email);
        return { user: publicUser({ id, email, role: 'user', created_at: now }), token };
      });
    },
    async login(emailInput, passwordInput) {
      const email = emailOf(emailInput);
      if (typeof passwordInput !== 'string' || passwordInput.length > 128) fail(401, 'Неверная почта или пароль.');
      const row = findUser(email);
      // Похожее время ответа для несуществующего адреса (не выдаём список аккаунтов).
      const dummy = 'scrypt:33c3b95fbd1599e57990d60eab9a4369:' + '00'.repeat(64);
      const valid = await checkPassword(passwordInput, row?.password_hash ?? dummy);
      if (!row || !valid || row.disabled) fail(401, 'Неверная почта или пароль либо учётная запись отключена.');
      return tx(() => {
        // Админ мог отключить пользователя, пока вычислялся хэш.
        if (get('SELECT disabled FROM users WHERE id=?', row.id)?.disabled) fail(401, 'Учётная запись отключена.');
        run('DELETE FROM sessions WHERE expires_at<?', Date.now());
        run('UPDATE users SET last_login=? WHERE id=?', Date.now(), row.id);
        const token = newSession(row.id);
        audit(row.id, 'user.login', row.id);
        return { user: publicUser(row), token };
      });
    },
    logout(token) { if (token) run('DELETE FROM sessions WHERE token_hash=?', hashToken(token)); },
    async changePassword(userId, current, next) {
      const password = passwordOf(next);
      const row = get('SELECT password_hash FROM users WHERE id=?', userId);
      if (!row || typeof current !== 'string' || !await checkPassword(current, row.password_hash)) fail(401, 'Текущий пароль неверный.');
      const hashed = await passwordHash(password);
      return tx(() => {
        if (get('SELECT disabled FROM users WHERE id=?', userId)?.disabled) fail(401, 'Учётная запись отключена.');
        // Не меняем пароль поверх параллельной смены из другой сессии.
        const result = run('UPDATE users SET password_hash=? WHERE id=? AND password_hash=?', hashed, userId, row.password_hash);
        if (!result.changes) fail(409, 'Пароль уже был изменён в другой сессии.');
        run('DELETE FROM sessions WHERE user_id=?', userId);
        const token = newSession(userId);
        audit(userId, 'user.password_change', userId);
        return token;
      });
    },
    listProjects(userId) {
      const rows = all('SELECT id,owner_id,name,version,bytes,entity_count,created_at,updated_at FROM projects WHERE owner_id=? ORDER BY updated_at DESC', userId);
      return { projects: rows.map(projectMeta), usedBytes: rows.reduce((n, row) => n + row.bytes, 0), quotaBytes };
    },
    getProject(id, userId) {
      const row = ownProject(id, userId);
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
    updateProject(id, userId, nameInput, document, versionInput) {
      const name = projectName(nameInput), version = versionOf(versionInput);
      const parsed = parseDocument(document, name, maxProjectBytes);
      return tx(() => {
        const row = ownProject(id, userId);
        if (row.version !== version) fail(409, 'Проект изменён в другой вкладке или на другом компьютере. Сохраните копию либо откройте новую версию.');
        ensureQuota(userId, parsed.bytes, row.bytes);
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
      const users = get('SELECT COUNT(*) AS total, COALESCE(SUM(disabled),0) AS disabled FROM users');
      const projects = get('SELECT COUNT(*) AS total, COALESCE(SUM(bytes),0) AS bytes FROM projects');
      return { users: users.total, disabledUsers: users.disabled, projects: projects.total, bytes: projects.bytes,
        activeSessions: activeSessions(), registrationOpen: registrationOpen(), quotaBytes, maxProjectBytes };
    },
    adminUsers(url) {
      const { limit, offset, q } = pageOf(url);
      const where = 'WHERE u.email LIKE ? ESCAPE \'\\\'';
      const total = get(`SELECT COUNT(*) AS n FROM users u ${where}`, q).n;
      const rows = all(`SELECT u.id,u.email,u.role,u.disabled,u.created_at,u.last_login,
        COUNT(p.id) AS project_count, COALESCE(SUM(p.bytes),0) AS bytes
        FROM users u LEFT JOIN projects p ON p.owner_id=u.id ${where}
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, q, limit, offset);
      return { total, users: rows.map((row) => ({ id: row.id, email: row.email, role: row.role,
        disabled: !!row.disabled, createdAt: row.created_at, lastLogin: row.last_login,
        projectCount: row.project_count, bytes: row.bytes })) };
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
          if (patch.disabled) run('DELETE FROM sessions WHERE user_id=?', targetId);
          audit(actorId, patch.disabled ? 'admin.user.disable' : 'admin.user.enable', targetId, user.email);
        } else {
          if (!['user', 'admin'].includes(patch.role)) fail(400, 'Некорректная роль.');
          if (user.role === 'admin' && patch.role === 'user' && !user.disabled
            && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n <= 1)
            fail(409, 'Нельзя снять роль с последнего активного администратора.');
          run('UPDATE users SET role=? WHERE id=?', patch.role, targetId);
          run('DELETE FROM sessions WHERE user_id=?', targetId);
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
  const store = await openCloudStore(dataDir, opts);
  const respond = async (req, res, url) => {
    const path = url.pathname.slice('/api/cloud'.length);
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') requireWriteRequest(req);
    if (path === '/config' && method === 'GET') return json(res, 200, {
      ok: true, enabled: true, registrationOpen: store.registrationOpen(),
      maxProjectBytes: store.maxProjectBytes, quotaBytes: store.quotaBytes,
    });
    if (path === '/register' && method === 'POST') {
      const body = await readJson(req, 2048);
      limitAttempt('reg:' + clientIp(req), 8, 60 * 60_000);
      const { user, token } = await store.register(body.email, body.password);
      return json(res, 201, { ok: true, user }, { 'set-cookie': cookieHeader(req, token) });
    }
    if (path === '/login' && method === 'POST') {
      const body = await readJson(req, 2048);
      const ipKey = 'login:' + clientIp(req);
      const emailKey = typeof body.email === 'string' && body.email.length < 255
        ? 'login-email:' + body.email.trim().toLowerCase() : null;
      checkAttempt(ipKey, 30);
      if (emailKey) checkAttempt(emailKey, 15); // распределённый перебор одного адреса
      let result;
      try { result = await store.login(body.email, body.password); }
      catch (e) {
        if (e?.status === 401 || e?.status === 400) {
          recordAttempt(ipKey, 15 * 60_000);
          if (emailKey) recordAttempt(emailKey, 15 * 60_000);
        }
        throw e;
      }
      // Успешные входы (например, с нескольких ПК) не исчерпывают лимит.
      if (emailKey) attempts.delete(emailKey);
      return json(res, 200, { ok: true, user: result.user }, { 'set-cookie': cookieHeader(req, result.token) });
    }

    const token = bearerCookie(req);
    const actor = store.session(token);
    const stillAuthorized = (admin = false) => {
      const fresh = store.session(token);
      if (!fresh) fail(401, 'Сеанс завершён. Войдите снова.');
      if (admin && fresh.role !== 'admin') fail(403, 'Доступно только администратору.');
    };
    if (path === '/logout' && method === 'POST') {
      store.logout(token);
      return json(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, null) });
    }
    if (!actor) fail(401, 'Войдите в учётную запись.');
    if (path === '/me' && method === 'GET') return json(res, 200, { ok: true, user: publicUser(actor) });
    if (path === '/password' && method === 'POST') {
      const body = await readJson(req, 2048);
      stillAuthorized();
      const nextToken = await store.changePassword(actor.id, body.currentPassword, body.newPassword);
      return json(res, 200, { ok: true }, { 'set-cookie': cookieHeader(req, nextToken) });
    }
    if (path === '/projects' && method === 'GET') return json(res, 200, { ok: true, ...store.listProjects(actor.id) });
    if (path === '/projects' && method === 'POST') {
      const body = await readJson(req);
      stillAuthorized();
      return json(res, 201, { ok: true, project: store.createProject(actor.id, body.name, body.document) });
    }
    const project = /^\/projects\/([0-9a-f-]{36})$/i.exec(path);
    if (project) {
      const id = project[1];
      if (method === 'GET') return json(res, 200, { ok: true, project: store.getProject(id, actor.id) });
      const body = await readJson(req, method === 'PUT' ? undefined : 2048);
      stillAuthorized();
      if (method === 'PUT') return json(res, 200, { ok: true, project: store.updateProject(id, actor.id, body.name, body.document, body.version) });
      if (method === 'PATCH') return json(res, 200, { ok: true, project: store.renameProject(id, actor.id, body.name, body.version) });
      if (method === 'DELETE') { store.deleteProject(id, actor.id, body.version); return json(res, 200, { ok: true }); }
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
        store.adminRevokeSessions(actor.id, userSessions[1]); return json(res, 200, { ok: true });
      }
      const user = /^\/admin\/users\/([0-9a-f-]{36})$/i.exec(path);
      if (user) {
        if (method === 'PATCH') {
          const body = await readJson(req, 2048);
          stillAuthorized(true);
          return json(res, 200, { ok: true, user: store.adminUpdateUser(actor.id, user[1], body) });
        }
        if (method === 'DELETE') { store.adminDeleteUser(actor.id, user[1]); return json(res, 200, { ok: true }); }
      }
      const adminProject = /^\/admin\/projects\/([0-9a-f-]{36})$/i.exec(path);
      if (adminProject) {
        if (method === 'GET') return json(res, 200, { ok: true, project: store.adminGetProject(adminProject[1], actor.id) });
        if (method === 'DELETE') { store.adminDeleteProject(actor.id, adminProject[1]); return json(res, 200, { ok: true }); }
      }
    }
    fail(404, 'Неизвестная команда облачного сервера.');
  };
  return {
    close: () => store.close(),
    async handle(req, res, url) {
      try { await respond(req, res, url); }
      catch (e) {
        if (!e?.status) console.error('[cloud] запрос завершился ошибкой:', e);
        if (!res.headersSent && !res.destroyed) json(res, e?.status ?? 500,
          { ok: false, error: e?.status ? e.message : 'Внутренняя ошибка сервера.' });
      }
    },
  };
}
