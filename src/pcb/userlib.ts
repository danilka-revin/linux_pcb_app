// Пользовательская библиотека макросов (хранится в localStorage).
// Макрос = набор примитивов с центром в (0,0) + имя; папка — для группировки
// (задаётся как «Папка/Имя» при сохранении или берётся из структуры ZIP при импорте).

import * as M from './model';

export interface UserMacro {
  name: string;
  folder?: string; // папка в библиотеке (нет/пусто — корень «Мои макросы»)
  ents: M.Entity[];
  bl: [number, number, number, number]; // локальный bbox
}

const KEY = 'lay.userMacros.v1';

/** Ключ макроса: «Папка/Имя» либо просто «Имя» (уникален в пределах библиотеки) */
export const macroKey = (m: { name: string; folder?: string }): string =>
  m.folder ? m.folder + '/' + m.name : m.name;

const cleanPart = (s: string): string => s.replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60);

/** Разбирает «Папка/Имя» (папка необязательна) */
export function splitMacroName(full: string): { name: string; folder?: string } {
  const parts = full.split('/').map(cleanPart).filter(Boolean);
  if (parts.length >= 2) return { name: parts[parts.length - 1], folder: parts.slice(0, -1).join('/') };
  return { name: parts[0] || 'Макрос' };
}

export function loadUserMacros(): UserMacro[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as UserMacro[];
    return Array.isArray(list) ? list.filter((m) => m && Array.isArray(m.ents) && m.ents.length) : [];
  } catch {
    return [];
  }
}

export function saveUserMacros(list: UserMacro[]): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list));
  } catch {
    /* переполнение/приватный режим — молча пропускаем */
  }
}

/** Центрирует примитивы на центр bbox и возвращает макрос (имя «Папка/Имя» разбирается на папку) */
export function makeMacro(name: string, ents: M.Entity[], folder?: string): UserMacro {
  const bb = M.unionBBox(ents.map((e) => M.entBBox(e)));
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const local = ents.map((e) => {
    const c = JSON.parse(JSON.stringify(e)) as M.Entity;
    M.translateEnt(c, -cx, -cy);
    return c;
  });
  const bl = M.unionBBox(local.map((e) => M.entBBox(e)));
  const named = folder !== undefined
    ? { name: cleanPart(name) || 'Макрос', folder: cleanPart(folder) || undefined }
    : splitMacroName(name);
  return { ...named, ents: local, bl };
}

export function addUserMacro(list: UserMacro[], macro: UserMacro): UserMacro[] {
  const name = cleanPart(macro.name) || 'Макрос';
  const folder = macro.folder ? cleanPart(macro.folder) : undefined;
  const m: UserMacro = { ...macro, name, folder: folder || undefined };
  return [...list.filter((x) => macroKey(x) !== macroKey(m)), m];
}
