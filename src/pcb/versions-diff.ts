// Сравнение двух версий платы (снимков облачного проекта или текущей платы).
// Примитивы сопоставляются по id: правка детали или дорожки сохраняет id, поэтому
// сравнение показывает, что добавлено, удалено и изменено. Сами документы не меняются.

import type { Doc, Entity, Net } from './model';
import { entBBox } from './model';
import { polylineLength } from './trackcalc';

export type ChangeType = 'added' | 'removed' | 'changed';

export interface EntityChange {
  type: ChangeType;
  id: string;
  kind: Entity['kind'];
  /** человекочитаемое имя: «деталь R1», «дорожка K1» … */
  label: string;
  /** точка для перехода: центр примитива в той версии, где он есть (мм) */
  x: number;
  y: number;
}

export interface KindCount { added: number; removed: number; changed: number }

export interface NetChange {
  type: ChangeType;
  name: string;
  /** изменились площадки, имя или шина */
  detail: string;
}

export interface VersionDiff {
  /** всего изменений по типам */
  added: number;
  removed: number;
  changed: number;
  /** по видам примитивов */
  byKind: Partial<Record<Entity['kind'], KindCount>>;
  /** суммарная длина дорожек в каждой версии, мм */
  trackLength: { before: number; after: number };
  /** размер платы поменялся */
  sizeChanged: boolean;
  nets: NetChange[];
  /** список изменений (ограничен, чтобы большой диф не забивал окно) */
  changes: EntityChange[];
  /** изменений всего, даже если в списке показаны не все */
  truncated: boolean;
}

const KIND_LABEL: Record<Entity['kind'], string> = {
  pad: 'площадка', smd: 'SMD', track: 'дорожка', via: 'переход', hole: 'отверстие',
  line: 'линия', circle: 'окружность', rect: 'прямоугольник', text: 'текст',
  poly: 'полигон', dim: 'размер', comp: 'деталь',
};

const LIST_LIMIT = 300;

const labelOf = (e: Entity): string => {
  if (e.kind === 'comp') return `деталь ${e.name || e.id}`;
  if (e.kind === 'text') return `текст «${e.text.slice(0, 24)}»`;
  if (e.kind === 'track') return `дорожка ${e.layer.toUpperCase()}`;
  return KIND_LABEL[e.kind];
};

const centerOf = (e: Entity): { x: number; y: number } => {
  const b = entBBox(e);
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
};

/** Сравнение без учёта порядка ключей: одинаковые по смыслу примитивы считаются равными. */
const same = (a: unknown, b: unknown): boolean => {
  return stable(a) === stable(b);
};
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + stable((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

const trackLen = (doc: Doc): number => {
  let sum = 0;
  for (const e of doc.entities) if (e.kind === 'track') sum += polylineLength(e.pts);
  return sum;
};

const netSig = (n: Net): string => stable({ name: n.name, pads: [...n.pads].sort(), bus: n.bus ?? '' });

/** Сравнение: «было» — a, «стало» — b. */
export function diffDocs(a: Doc, b: Doc): VersionDiff {
  const byIdA = new Map(a.entities.map((e) => [e.id, e] as const));
  const byIdB = new Map(b.entities.map((e) => [e.id, e] as const));
  const out: VersionDiff = {
    added: 0, removed: 0, changed: 0, byKind: {},
    trackLength: { before: trackLen(a), after: trackLen(b) },
    sizeChanged: a.w !== b.w || a.h !== b.h,
    nets: [], changes: [], truncated: false,
  };
  const bump = (kind: Entity['kind'], type: ChangeType): void => {
    const row = out.byKind[kind] ?? (out.byKind[kind] = { added: 0, removed: 0, changed: 0 });
    row[type]++;
    out[type]++;
  };
  const push = (c: EntityChange): void => {
    if (out.changes.length < LIST_LIMIT) out.changes.push(c);
    else out.truncated = true;
  };

  for (const e of b.entities) {
    const old = byIdA.get(e.id);
    if (!old) {
      bump(e.kind, 'added');
      push({ type: 'added', id: e.id, kind: e.kind, label: labelOf(e), ...centerOf(e) });
    } else if (!same(old, e)) {
      bump(e.kind, 'changed');
      push({ type: 'changed', id: e.id, kind: e.kind, label: labelOf(e), ...centerOf(e) });
    }
  }
  for (const e of a.entities) {
    if (byIdB.has(e.id)) continue;
    bump(e.kind, 'removed');
    push({ type: 'removed', id: e.id, kind: e.kind, label: labelOf(e), ...centerOf(e) });
  }

  // Цепи сопоставляются по id: переименование или смена площадок — «изменена».
  const netA = new Map((a.nets ?? []).map((n) => [n.id, n] as const));
  const netB = new Map((b.nets ?? []).map((n) => [n.id, n] as const));
  for (const n of b.nets ?? []) {
    const old = netA.get(n.id);
    if (!old) out.nets.push({ type: 'added', name: n.name, detail: `площадок: ${n.pads.length}` });
    else if (netSig(old) !== netSig(n)) {
      const parts: string[] = [];
      if (old.name !== n.name) parts.push(`имя «${old.name}» → «${n.name}»`);
      if (old.pads.length !== n.pads.length) parts.push(`площадок ${old.pads.length} → ${n.pads.length}`);
      if ((old.bus ?? '') !== (n.bus ?? '')) parts.push(`шина «${old.bus ?? ''}» → «${n.bus ?? ''}»`);
      if (!parts.length) parts.push('состав площадок');
      out.nets.push({ type: 'changed', name: n.name, detail: parts.join(', ') });
    }
  }
  for (const n of a.nets ?? []) {
    if (!netB.has(n.id)) out.nets.push({ type: 'removed', name: n.name, detail: '' });
  }
  return out;
}

/** Текст сводки для строки под результатом сравнения. */
export function diffSummary(d: VersionDiff): string {
  const total = d.added + d.removed + d.changed;
  if (!total && !d.nets.length && !d.sizeChanged) return 'Версии совпадают: различий нет.';
  const parts: string[] = [];
  if (d.added) parts.push(`добавлено ${d.added}`);
  if (d.removed) parts.push(`удалено ${d.removed}`);
  if (d.changed) parts.push(`изменено ${d.changed}`);
  if (d.nets.length) parts.push(`цепей: ${d.nets.length}`);
  return parts.join(', ');
}
