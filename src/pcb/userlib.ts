// Пользовательская библиотека макросов (хранится в localStorage).
// Макрос = набор примитивов с центром в (0,0) + имя.

import * as M from './model';

export interface UserMacro {
  name: string;
  ents: M.Entity[];
  bl: [number, number, number, number]; // локальный bbox
}

const KEY = 'lay.userMacros.v1';

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

/** Центрирует примитивы на центр bbox и возвращает макрос */
export function makeMacro(name: string, ents: M.Entity[]): UserMacro {
  const bb = M.unionBBox(ents.map((e) => M.entBBox(e)));
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
  const local = ents.map((e) => {
    const c = JSON.parse(JSON.stringify(e)) as M.Entity;
    M.translateEnt(c, -cx, -cy);
    return c;
  });
  const bl = M.unionBBox(local.map((e) => M.entBBox(e)));
  return { name, ents: local, bl };
}

export function addUserMacro(list: UserMacro[], macro: UserMacro): UserMacro[] {
  const name = macro.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'Макрос';
  return [...list.filter((m) => m.name !== name), { ...macro, name }];
}
