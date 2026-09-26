// Личная библиотека деталей: папки + сохранённые футпринты (localStorage).
//
// Макрос больше не «файл .lmk»: деталь создаёт генератор (gen.ts) или ручной
// примитив на плате, а здесь она лежит в папке, которую пользователь создал сам.
// Хранятся локальные сущности (Entity[]) с центром в (0,0) — их умеет ставить и
// разворачивать expand.ts, поэтому макрос не зависит от каталога.

import * as M from './model';

export type BBox = [number, number, number, number];

export interface Folder {
  id: string;
  name: string;
  /** null — корень библиотеки */
  parentId: string | null;
}

export interface Macro {
  id: string;
  name: string;
  folderId: string | null;
  /** локальные сущности (центр в 0,0) */
  ents: M.Entity[];
  /** bbox самих сущностей */
  bl: BBox;
  /** строка генератора, из которой деталь появилась (для «обновить») */
  query?: string;
  note?: string;
  createdAt: number;
}

export interface Store {
  v: 2;
  folders: Folder[];
  macros: Macro[];
}

const KEY = 'lay.macros.v2';
const OLD_KEY = 'lay.userMacros.v1';

export const emptyStore = (): Store => ({ v: 2, folders: [], macros: [] });

const nid = (p: string): string => p + M.uid().slice(1);

const cleanName = (s: string): string => s.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);

export const safeName = (s: string, fallback = 'Без имени'): string => cleanName(s) || fallback;

const ENT_KINDS = new Set(['pad', 'smd', 'track', 'via', 'hole', 'line', 'rect', 'circle', 'text', 'poly', 'comp']);

/** примитив платы: только заведомо известный kind — иначе entBBox/gerber упадут на битой записи */
const isEnt = (e: unknown): e is M.Entity =>
  !!e && typeof e === 'object' && ENT_KINDS.has((e as { kind?: unknown }).kind as string);

/** @internal — проверка формы сохранённых данных (используется и в тестах) */
export function normalizeStore(raw: unknown): Store {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const r = raw as Partial<Store> & { macros?: unknown; folders?: unknown };
  const folders: Folder[] = Array.isArray(r.folders)
    ? (r.folders as unknown[])
      .map((f) => f as Partial<Folder>)
      .filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string')
      .map((f) => ({ id: f.id as string, name: safeName(f.name as string, 'Папка'), parentId: f.parentId ?? null }))
    : [];
  const byId = new Set(folders.map((f) => f.id));
  const macros: Macro[] = Array.isArray(r.macros)
    ? (r.macros as unknown[])
      .map((m) => m as Partial<Macro>)
      .filter((m) => m && typeof m.name === 'string' && Array.isArray(m.ents) && m.ents.some(isEnt))
      .map((m, i) => {
        const ents = (m.ents as M.Entity[]).filter(isEnt);
        return {
          id: typeof m.id === 'string' && m.id ? m.id : `m${i + 1}`,
          name: safeName(m.name as string),
          folderId: typeof m.folderId === 'string' && byId.has(m.folderId) ? m.folderId : null,
          ents,
          bl: (Array.isArray(m.bl) && m.bl.length === 4 ? m.bl : M.unionBBox(ents.map((e) => M.entBBox(e)))) as BBox,
          query: typeof m.query === 'string' ? m.query : undefined,
          note: typeof m.note === 'string' ? m.note : undefined,
          createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
        };
      })
    : [];
  return { v: 2, folders, macros };
}

/** Перенос старых макросов «Папка/Имя» в древовидную библиотеку */
function migrateLegacy(list: unknown): Store | null {
  if (!Array.isArray(list) || !list.length) return null;
  const store = emptyStore();
  const folders = new Map<string, string>();
  const folderIdFor = (path: string): string => {
    const hit = folders.get(path.toLowerCase());
    if (hit) return hit;
    const parts = path.split('/').map(cleanName).filter(Boolean);
    let parentId: string | null = null;
    let acc = '';
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      const existing = store.folders.find(
        (f) => f.parentId === parentId && f.name.toLowerCase() === part.toLowerCase(),
      );
      if (existing) { parentId = existing.id; continue; }
      const f: Folder = { id: nid('f'), name: part, parentId };
      store.folders.push(f);
      parentId = f.id;
    }
    const id = parentId as string;
    folders.set(path.toLowerCase(), id);
    return id;
  };
  list.forEach((raw, i) => {
    const m = raw as { name?: string; folder?: string; ents?: unknown };
    if (!m || !Array.isArray(m.ents)) return;
    const ents = m.ents.filter(isEnt);
    if (!ents.length) return;
    const full = String(m.name ?? 'Макрос');
    const slash = full.lastIndexOf('/');
    const name = cleanName(slash >= 0 ? full.slice(slash + 1) : full) || `Макрос ${i + 1}`;
    const folderPath = cleanName(slash >= 0 ? full.slice(0, slash) : String(m.folder ?? ''));
    store.macros.push({
      id: nid('m'), name, folderId: folderPath ? folderIdFor(folderPath) : null,
      ents, bl: M.unionBBox(ents.map((e) => M.entBBox(e))) as BBox, createdAt: 0,
    });
  });
  return store.macros.length ? store : null;
}

const readJSON = (key: string): unknown => {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const storeKey = (userId?: string): string => userId ? `${KEY}.${userId}` : KEY;

/** В общем режиме библиотека локальна для данного аккаунта/браузера, но не общая между аккаунтами. */
export function loadStore(userId?: string): Store {
  const cur = readJSON(storeKey(userId));
  if (cur) return normalizeStore(cur);
  if (userId) return emptyStore(); // не показывать другому пользователю старые глобальные макросы
  const legacy = migrateLegacy(readJSON(OLD_KEY));
  if (legacy) {
    saveStore(legacy);
    return legacy;
  }
  return emptyStore();
}

export function saveStore(store: Store, userId?: string): void {
  try {
    globalThis.localStorage?.setItem(storeKey(userId), JSON.stringify(store));
  } catch {
    /* приватный режим/переполнение — библиотека останется только в памяти */
  }
}

// ------------------------------------------------------------------ папки

export function createFolder(store: Store, name: string, parentId: string | null = null): Store {
  const clean = safeName(name, 'Новая папка');
  if (store.folders.some((f) => f.parentId === parentId && f.name.toLowerCase() === clean.toLowerCase())) return store;
  return { ...store, folders: [...store.folders, { id: nid('f'), name: clean, parentId }] };
}

export function renameFolder(store: Store, id: string, name: string): Store {
  return { ...store, folders: store.folders.map((f) => (f.id === id ? { ...f, name: safeName(name, f.name) } : f)) };
}

/** Удалить папку: её содержимое поднимается на уровень выше (или удаляется вместе с ней) */
export function removeFolder(store: Store, id: string, withMacros = false): Store {
  const folder = store.folders.find((f) => f.id === id);
  if (!folder) return store;
  const subtree = new Set<string>([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const f of store.folders) {
      if (f.parentId && subtree.has(f.parentId) && !subtree.has(f.id)) { subtree.add(f.id); changed = true; }
    }
  }
  const macros = withMacros
    ? store.macros.filter((m) => !m.folderId || !subtree.has(m.folderId))
    : store.macros.map((m) => (m.folderId && subtree.has(m.folderId) ? { ...m, folderId: folder.parentId } : m));
  return { ...store, folders: store.folders.filter((f) => !subtree.has(f.id)), macros };
}

export const folderPath = (store: Store, id: string | null, sep = ' / '): string => {
  const parts: string[] = [];
  let cur = id;
  for (let guard = 0; cur && guard < 32; guard++) {
    const f = store.folders.find((x) => x.id === cur);
    if (!f) break;
    parts.unshift(f.name);
    cur = f.parentId;
  }
  return parts.join(sep);
};

export const folderLabel = (store: Store, id: string | null): string => folderPath(store, id) || 'Библиотека';

// ------------------------------------------------------------------ детали

/** Создать макрос из сущностей: центрирует на (0,0) и считает bbox */
export function makeMacro(name: string, ents: M.Entity[], extra: Partial<Macro> = {}): Macro {
  const src = ents.map((e) => JSON.parse(JSON.stringify(e)) as M.Entity);
  const bb = M.unionBBox(src.map((e) => M.entBBox(e)));
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const local = src.map((e) => { M.translateEnt(e, -cx, -cy); return e; });
  return {
    id: nid('m'),
    name: safeName(name),
    folderId: null,
    ents: local,
    bl: M.unionBBox(local.map((e) => M.entBBox(e))) as BBox,
    createdAt: Date.now(),
    ...extra,
  };
}

export function addMacro(store: Store, macro: Macro): Store {
  const name = safeName(macro.name);
  const key = `${macro.folderId ?? ''}|${name.toLowerCase()}`;
  const rest = store.macros.filter((m) => `${m.folderId ?? ''}|${m.name.toLowerCase()}` !== key);
  return { ...store, macros: [...rest, { ...macro, name }] };
}

export function updateMacro(store: Store, id: string, patch: Partial<Macro>): Store {
  return {
    ...store,
    macros: store.macros.map((m) => (m.id === id
      ? { ...m, ...patch, name: patch.name !== undefined ? safeName(patch.name, m.name) : m.name }
      : m)),
  };
}

export function removeMacro(store: Store, id: string): Store {
  return { ...store, macros: store.macros.filter((m) => m.id !== id) };
}

export const moveMacro = (store: Store, id: string, folderId: string | null): Store =>
  ({ ...store, macros: store.macros.map((m) => (m.id === id ? { ...m, folderId } : m)) });

// ------------------------------------------------------------------ дерево

export interface Tree {
  id: string | null;
  name: string;
  folders: Tree[];
  macros: Macro[];
}

/** Дерево папок с деталями; пустые папки остаются видимыми */
export function buildTree(store: Store, filter = ''): Tree {
  const q = filter.trim().toLowerCase();
  const node = (id: string | null, name: string): Tree => ({
    id,
    name,
    folders: store.folders
      .filter((f) => f.parentId === id)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
      .map((f) => node(f.id, f.name)),
    macros: store.macros
      .filter((m) => (m.folderId ?? null) === id)
      .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.query ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  });
  const prune = (t: Tree): Tree | null => {
    if (!q) return t;
    const folders = t.folders.map(prune).filter((x): x is Tree => !!x);
    return folders.length || t.macros.length ? { ...t, folders } : t.id === null ? { ...t, folders: [] } : null;
  };
  const root = node(null, 'Библиотека');
  const kept = q ? (prune(root) ?? root) : root;
  if (!q) return kept;
  // в корень — то, что не попало в отфильтрованные папки (любой глубины)
  const keptIds = new Set<string | null>();
  const walkIds = (t: Tree): void => {
    for (const f of t.folders) { keptIds.add(f.id); walkIds(f); }
  };
  walkIds(kept);
  const flat = store.macros
    .filter((m) => !keptIds.has(m.folderId))
    .filter((m) => m.name.toLowerCase().includes(q) || (m.query ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { ...kept, macros: m2root(store, flat) };
}

/** при поиске показываем все совпадения плоским списком в корне */
function m2root(store: Store, flat: Macro[]): Macro[] {
  if (!flat.length) return [];
  const seen = new Set(flat.map((m) => m.id));
  const walk = (id: string | null): Macro[] => {
    const here = store.macros.filter((m) => (m.folderId ?? null) === id && seen.has(m.id));
    return store.folders.filter((f) => f.parentId === id).flatMap((f) => walk(f.id)).concat(here);
  };
  return walk(null);
}

export const countMacros = (store: Store): number => store.macros.length;

// ------------------------------------------------------------------ бэкап

export function exportJSON(store: Store): string {
  return JSON.stringify({ app: 'lay-macros', ...store }, null, 1);
}

export type ImportResult = { ok: true; store: Store; added: number } | { ok: false; error: string };

/** Слияние: папки сопоставляются по имени, детали — по «папка + имя» */
export function importJSON(text: string, into: Store): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Файл не читается как JSON.' };
  }
  const src = normalizeStore(raw);
  if (!src.macros.length && !src.folders.length) return { ok: false, error: 'В файле нет деталей.' };
  let store: Store = { ...into, folders: [...into.folders], macros: [...into.macros] };
  const map = new Map<string, string | null>();
  const order = (id: string | null): string[] => {
    const chain: string[] = [];
    let cur = id;
    for (let g = 0; cur && g < 32; g++) {
      const f = src.folders.find((x) => x.id === cur);
      if (!f) break;
      chain.unshift(f.name.toLowerCase());
      cur = f.parentId;
    }
    return chain;
  };
  for (const f of src.folders) {
    const chain = order(f.id);
    const name = chain[chain.length - 1];
    const parentName = chain.length > 1 ? chain[chain.length - 2] : null;
    const parentId = parentName
      ? [...map.values()].find((id) => store.folders.find((x) => x.id === id)?.name.toLowerCase() === parentName) ?? null
      : null;
    const existing = store.folders.find((x) => x.parentId === parentId && x.name.toLowerCase() === name);
    if (existing) { map.set(f.id, existing.id); continue; }
    const created = createFolder(store, name, parentId);
    const fresh = created.folders[created.folders.length - 1];
    map.set(f.id, fresh?.id ?? null);
    store = created;
  }
  let added = 0;
  for (const m of src.macros) {
    store = addMacro(store, { ...m, id: nid('m'), folderId: m.folderId ? map.get(m.folderId) ?? null : null });
    added++;
  }
  return { ok: true, store, added };
}
