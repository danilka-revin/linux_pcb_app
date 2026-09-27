// Группировка элементов платы.
// Группа — это связь между уже существующими примитивами: выделение, перенос,
// поворот, зеркало и удаление действуют на группу целиком. Логика чистая и не
// зависит от React, поэтому её покрывает тест test/group.ts.
//
// Правила:
// • в группе минимум два элемента;
// • группы не пересекаются — элемент входит не более чем в одну группу,
//   поэтому новая группировка «втягивает» прежние группы выделенных элементов;
// • ссылки на удалённые элементы вычищаются (pruneGroups).

import { cloneDoc, entBBox, unionBBox, uid, type Doc, type Group } from './model';

/** Индекс «id элемента → его группа» — строится один раз на изменение платы. */
export function groupIndex(groups: readonly Group[] | undefined): Map<string, Group> {
  const m = new Map<string, Group>();
  for (const g of groups ?? []) for (const id of g.ids) m.set(id, g);
  return m;
}

/** Группа, в которую входит элемент (или undefined). */
export function groupOf(groups: readonly Group[] | undefined, entId: string): Group | undefined {
  for (const g of groups ?? []) if (g.ids.includes(entId)) return g;
  return undefined;
}

/**
 * Расширить выделение до целых групп: если выбран хотя бы один элемент группы,
 * выбирается вся группа. Элементы вне групп остаются как есть.
 */
export function expandSelection(
  groups: readonly Group[] | undefined, sel: Iterable<string>,
): Set<string> {
  const out = new Set(sel);
  const idx = groupIndex(groups);
  for (const id of [...out]) {
    const g = idx.get(id);
    if (g) for (const m of g.ids) out.add(m);
  }
  return out;
}

/** Свободное имя по порядку: «Группа 1», «Группа 2», … */
export function nextGroupName(groups: readonly Group[] | undefined): string {
  const used = new Set((groups ?? []).map((g) => g.name));
  let i = 1;
  while (used.has(`Группа ${i}`)) i++;
  return `Группа ${i}`;
}

/**
 * Почистить группы: убрать id отсутствующих на плате элементов и распустить
 * группы, в которых осталось меньше двух элементов. Возвращает новый массив.
 */
export function pruneGroups(
  groups: readonly Group[] | undefined, alive: ReadonlySet<string>,
): Group[] {
  const out: Group[] = [];
  for (const g of groups ?? []) {
    const ids = [...new Set(g.ids.filter((id) => alive.has(id)))];
    if (ids.length >= 2) out.push({ ...g, ids });
  }
  return out;
}

export interface Grouped {
  /** копия документа с обновлённым списком групп */
  doc: Doc;
  /** получившаяся группа */
  group: Group;
  /** сколько прежних групп вошло в новую (растворилось) */
  merged: number;
}

/**
 * Сгруппировать выделенное. Если в выделение попали элементы прежних групп,
 * эти группы целиком переходят в новую; прежняя группа остаётся, только когда
 * в ней ещё есть минимум два элемента. Имя и id единственной полностью
 * поглощённой группы сохраняются — иначе выдаётся следующее свободное имя.
 *
 * null — группировать нечего (меньше двух элементов на плате).
 */
export function groupSelection(doc: Doc, sel: Iterable<string>, name?: string): Grouped | null {
  const alive = new Set(doc.entities.map((e) => e.id));
  const picked = [...new Set([...sel].filter((id) => alive.has(id)))];
  if (picked.length < 2) return null;

  const old = pruneGroups(doc.groups, alive);
  const seed = new Set(picked);
  const merged = old.filter((g) => g.ids.some((id) => seed.has(id)));
  const mergedIds = new Set(merged.map((g) => g.id));
  const kept = old.filter((g) => !mergedIds.has(g.id));

  const members = new Set(seed);
  for (const g of merged) for (const id of g.ids) members.add(id);
  // порядок элементов в группе — как на плате
  const ids = doc.entities.filter((e) => members.has(e.id)).map((e) => e.id);

  const absorbed = merged.length === 1 && merged[0].ids.every((id) => seed.has(id)) ? merged[0] : null;
  const clean = (name ?? '').trim();
  const group: Group = {
    id: absorbed ? absorbed.id : uid(),
    name: clean || (absorbed ? absorbed.name : nextGroupName(kept)),
    ids,
  };
  return { doc: { ...cloneDoc(doc), groups: [...kept, group] }, group, merged: merged.length };
}

export interface Ungrouped {
  doc: Doc;
  /** имена распущенных групп */
  names: string[];
}

/** Разгруппировать: распустить все группы, в которые входит выделенное. */
export function ungroupSelection(doc: Doc, sel: Iterable<string>): Ungrouped | null {
  const alive = new Set(doc.entities.map((e) => e.id));
  const s = new Set([...sel].filter((id) => alive.has(id)));
  if (!s.size) return null;
  const old = pruneGroups(doc.groups, alive);
  const hit = old.filter((g) => g.ids.some((id) => s.has(id)));
  if (!hit.length) return null;
  const hitIds = new Set(hit.map((g) => g.id));
  return { doc: { ...cloneDoc(doc), groups: old.filter((g) => !hitIds.has(g.id)) }, names: hit.map((g) => g.name) };
}

/** Разгруппировать всё на плате. */
export function ungroupAll(doc: Doc): Ungrouped | null {
  const old = pruneGroups(doc.groups, new Set(doc.entities.map((e) => e.id)));
  if (!old.length) return null;
  return { doc: { ...cloneDoc(doc), groups: [] }, names: old.map((g) => g.name) };
}

/** Переименовать группу (пустое имя игнорируется). */
export function renameGroup(doc: Doc, groupId: string, name: string): Doc | null {
  const clean = name.trim();
  if (!clean) return null;
  const old = doc.groups ?? [];
  if (!old.some((g) => g.id === groupId)) return null;
  return { ...cloneDoc(doc), groups: old.map((g) => (g.id === groupId ? { ...g, name: clean } : g)) };
}

/** Габарит группы: для рамки на холсте и для подписи. */
export function groupBBox(doc: Doc, g: Group): [number, number, number, number] | null {
  const wanted = new Set(g.ids);
  const list = doc.entities.filter((e) => wanted.has(e.id)).map(entBBox);
  return list.length ? unionBBox(list) : null;
}

/**
 * Копии групп при дублировании и вставке: id элементов заменяются по карте
 * «старый → новый». Берутся только группы, целиком попавшие в копируемое.
 * suffix добавляется к имени, чтобы копия отличалась от оригинала.
 */
export function remapGroups(
  groups: readonly Group[] | undefined, idMap: ReadonlyMap<string, string>, suffix = '',
): Group[] {
  const out: Group[] = [];
  for (const g of groups ?? []) {
    const ids = g.ids.map((id) => idMap.get(id));
    if (ids.some((id) => !id)) continue;
    out.push({ id: uid(), name: g.name + suffix, ids: ids as string[] });
  }
  return out;
}

/** Русская форма: plural(3) → «3 элемента». */
export const groupCountLabel = (n: number): string => {
  const a = Math.abs(n) % 100, d = Math.abs(n) % 10;
  const w = a > 10 && a < 20 ? 'элементов' : d === 1 ? 'элемент' : d >= 2 && d <= 4 ? 'элемента' : 'элементов';
  return `${n} ${w}`;
};

/** Русская форма: plural(2) → «2 группы». */
export const groupWord = (n: number): string => {
  const a = Math.abs(n) % 100, d = Math.abs(n) % 10;
  const w = a > 10 && a < 20 ? 'групп' : d === 1 ? 'группа' : d >= 2 && d <= 4 ? 'группы' : 'групп';
  return `${n} ${w}`;
};
