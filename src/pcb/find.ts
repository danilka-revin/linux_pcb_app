// Поиск по плате: обозначения деталей, цепи (группы соединений), надписи (номиналы
// и обозначения, нарисованные текстом). Результат — место на плате и список
// примитивов для подсветки. Поиск не меняет документ.

import type { Doc, Entity } from './model';
import { entBBox } from './model';
import { expandDoc } from './expand';
import { copperComponents } from './netroute';

export type FindKind = 'comp' | 'net' | 'text';

export interface FindHit {
  /** уникальный ключ результата */
  key: string;
  kind: FindKind;
  /** что нашли: имя детали, цепи или текст надписи */
  title: string;
  /** пояснение: тип объекта, сторона, число площадок */
  detail: string;
  /** точка для перехода (центр объекта, мм) */
  x: number;
  y: number;
  /** габарит найденного, мм: [x1, y1, x2, y2] */
  box: [number, number, number, number];
  /** id примитивов для подсветки (после развёртки компонентов) */
  ids: string[];
  /** id верхнего уровня: деталь или надпись, которую можно выделить */
  topId?: string;
}

const KIND_RU: Record<FindKind, string> = { comp: 'деталь', net: 'цепь', text: 'надпись' };
export const FIND_KIND_RU = KIND_RU;

/** Слова запроса: все должны встретиться (без учёта регистра, порядок не важен). */
export function queryTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

const hasAll = (text: string, terms: string[]): boolean => {
  const low = text.toLowerCase();
  return terms.every((t) => low.includes(t));
};

/** Сортировка: точное совпадение, затем начало строки, затем вхождение. */
function rank(title: string, query: string): number {
  const t = title.trim().toLowerCase(), q = query.trim().toLowerCase();
  if (t === q) return 0;
  if (t.startsWith(q)) return 1;
  return 2;
}

const union = (boxes: [number, number, number, number][]): [number, number, number, number] => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1]);
    x2 = Math.max(x2, b[2]); y2 = Math.max(y2, b[3]);
  }
  return [x1, y1, x2, y2];
};

const centerOf = (b: [number, number, number, number]): { x: number; y: number } =>
  ({ x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 });

/** id верхнего уровня у развёрнутого примитива: «compId:idx» → compId. */
const topOf = (id: string): string => {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(0, i);
};

export function findOnBoard(doc: Doc, query: string, limit = 200): FindHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const hits: FindHit[] = [];
  const nets = doc.nets ?? [];

  // Развёртка нужна и деталям (подсветка их примитивов), и надписям, и цепям.
  const flat = expandDoc(doc.entities);
  const partsOf = new Map<string, string[]>();
  for (const e of flat) {
    const top = topOf(e.id);
    if (top === e.id) continue;
    const list = partsOf.get(top) ?? [];
    list.push(e.id);
    partsOf.set(top, list);
  }

  // Детали: имя (и библиотечное имя).
  for (const e of doc.entities) {
    if (e.kind !== 'comp') continue;
    const name = e.name || 'Деталь';
    if (!hasAll(`${e.name} ${e.lib ?? ''}`, terms)) continue;
    const box = entBBox(e);
    hits.push({
      key: 'c:' + e.id, kind: 'comp', title: name,
      detail: `${KIND_RU.comp} · ${e.side === 'bottom' ? 'низ' : 'верх'}`,
      x: e.x, y: e.y, box, ids: partsOf.get(e.id) ?? [e.id], topId: e.id,
    });
  }

  // Надписи: текст на шелкографии, в том числе внутри деталей (номиналы, обозначения).
  for (const e of flat) {
    if (e.kind !== 'text' || !e.text.trim()) continue;
    if (!hasAll(e.text, terms)) continue;
    const box = entBBox(e);
    const c = centerOf(box);
    const top = topOf(e.id);
    const owner = doc.entities.find((x) => x.id === top);
    hits.push({
      key: 't:' + e.id, kind: 'text', title: e.text.trim(),
      detail: owner?.kind === 'comp' ? `${KIND_RU.text} детали ${owner.name || ''}`.trim() : KIND_RU.text,
      x: c.x, y: c.y, box, ids: [e.id], topId: owner ? owner.id : e.id,
    });
  }

  // Цепи: все медные примитивы, связанные с площадками цепи. Тогда подсвечивается вся цепь.
  const named = nets.filter((n) => hasAll(n.name, terms));
  if (named.length) {
    const comp = copperComponents(doc.entities);
    const byId = new Map(flat.map((e) => [e.id, e] as const));
    for (const net of named) {
      const roots = new Set(net.pads.map((id) => comp.get(id) ?? id));
      const ids: string[] = [];
      const boxes: [number, number, number, number][] = [];
      for (const e of flat) {
        const root = comp.get(e.id);
        if (root === undefined || !roots.has(root)) continue;
        ids.push(e.id);
        boxes.push(entBBox(e));
      }
      const padBoxes = net.pads.map((id) => byId.get(id)).filter((e): e is Entity => !!e).map((e) => entBBox(e));
      const box = boxes.length ? union(boxes) : padBoxes.length ? union(padBoxes) : [0, 0, 0, 0] as [number, number, number, number];
      const c = centerOf(box);
      hits.push({
        key: 'n:' + net.id, kind: 'net', title: net.name,
        detail: `${KIND_RU.net} · ${net.pads.length} ${net.pads.length === 1 ? 'площадка' : net.pads.length < 5 ? 'площадки' : 'площадок'}`,
        x: c.x, y: c.y, box, ids,
      });
    }
  }

  hits.sort((a, b) => rank(a.title, query) - rank(b.title, query)
    || (a.kind === b.kind ? 0 : a.kind === 'comp' ? -1 : b.kind === 'comp' ? 1 : a.kind === 'net' ? -1 : 1)
    || a.title.localeCompare(b.title, 'ru'));
  return hits.slice(0, limit);
}
