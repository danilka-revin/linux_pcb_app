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

export interface CommentChange {
  type: ChangeType;
  id: string;
  /** Короткое содержание заметки или причина изменения. */
  detail: string;
  x: number;
  y: number;
}

export interface DifferentialPairChange {
  type: ChangeType;
  name: string;
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
  /** производственные параметры панелизации изменились */
  panelChanged: boolean;
  nets: NetChange[];
  diffPairs: DifferentialPairChange[];
  /** заметки ревью сравниваются отдельно от производственной геометрии */
  comments: CommentChange[];
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
  if (e.kind === 'comp') return `деталь ${e.ref ? `${e.ref} · ` : ''}${e.value || e.name || e.id}`;
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

const netSig = (n: Net): string => stable({ name: n.name, pads: [...n.pads].sort(), bus: n.bus ?? '', rules: n.rules ?? {} });
const pairSig = (p: NonNullable<Doc['diffPairs']>[number]): string => stable({
  name: p.name, positiveNetId: p.positiveNetId, negativeNetId: p.negativeNetId,
  targetOhm: p.targetOhm, widthMm: p.widthMm, gapMm: p.gapMm, maxSkewMm: p.maxSkewMm,
});

/** Сравнение: «было» — a, «стало» — b. */
export function diffDocs(a: Doc, b: Doc): VersionDiff {
  const byIdA = new Map(a.entities.map((e) => [e.id, e] as const));
  const byIdB = new Map(b.entities.map((e) => [e.id, e] as const));
  const out: VersionDiff = {
    added: 0, removed: 0, changed: 0, byKind: {},
    trackLength: { before: trackLen(a), after: trackLen(b) },
    sizeChanged: a.w !== b.w || a.h !== b.h,
    panelChanged: stable(a.panelInfo ?? null) !== stable(b.panelInfo ?? null),
    nets: [], diffPairs: [], comments: [], changes: [], truncated: false,
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
      if (stable(old.rules ?? {}) !== stable(n.rules ?? {})) parts.push('правила трассировки изменены');
      if (!parts.length) parts.push('состав площадок');
      out.nets.push({ type: 'changed', name: n.name, detail: parts.join(', ') });
    }
  }
  for (const n of a.nets ?? []) {
    if (!netB.has(n.id)) out.nets.push({ type: 'removed', name: n.name, detail: '' });
  }

  const pairsA = new Map((a.diffPairs ?? []).map((pair) => [pair.id, pair] as const));
  const pairsB = new Map((b.diffPairs ?? []).map((pair) => [pair.id, pair] as const));
  for (const pair of b.diffPairs ?? []) {
    const old = pairsA.get(pair.id);
    if (!old) out.diffPairs.push({ type: 'added', name: pair.name, detail: `цель ${pair.targetOhm} Ω, ширина ${pair.widthMm} мм, зазор ${pair.gapMm} мм` });
    else if (pairSig(old) !== pairSig(pair)) {
      const changes: string[] = [];
      if (old.name !== pair.name) changes.push(`имя «${old.name}» → «${pair.name}»`);
      if (old.positiveNetId !== pair.positiveNetId || old.negativeNetId !== pair.negativeNetId) changes.push('состав цепей изменён');
      if (old.targetOhm !== pair.targetOhm) changes.push(`Zdiff ${old.targetOhm} → ${pair.targetOhm} Ω`);
      if (old.widthMm !== pair.widthMm) changes.push(`ширина ${old.widthMm} → ${pair.widthMm} мм`);
      if (old.gapMm !== pair.gapMm) changes.push(`зазор ${old.gapMm} → ${pair.gapMm} мм`);
      if (old.maxSkewMm !== pair.maxSkewMm) changes.push(`допуск skew ${old.maxSkewMm} → ${pair.maxSkewMm} мм`);
      out.diffPairs.push({ type: 'changed', name: pair.name, detail: changes.join(', ') });
    }
  }
  for (const pair of a.diffPairs ?? []) {
    if (!pairsB.has(pair.id)) out.diffPairs.push({ type: 'removed', name: pair.name, detail: '' });
  }

  // Заметки ревью — аннотации к рабочему файлу, но не примитивы платы.
  const commentsA = new Map((a.comments ?? []).map((comment) => [comment.id, comment] as const));
  const commentsB = new Map((b.comments ?? []).map((comment) => [comment.id, comment] as const));
  for (const comment of b.comments ?? []) {
    const old = commentsA.get(comment.id);
    if (!old) out.comments.push({ type: 'added', id: comment.id, detail: comment.text, x: comment.x, y: comment.y });
    else if (old.text !== comment.text || old.x !== comment.x || old.y !== comment.y
      || !!old.resolved !== !!comment.resolved) {
      const parts: string[] = [];
      if (old.text !== comment.text) parts.push('текст изменён');
      if (old.x !== comment.x || old.y !== comment.y) parts.push('метка перемещена');
      if (!!old.resolved !== !!comment.resolved) parts.push(comment.resolved ? 'отмечена выполненной' : 'снова открыта');
      out.comments.push({ type: 'changed', id: comment.id, detail: parts.join(', ') || 'изменена', x: comment.x, y: comment.y });
    }
  }
  for (const comment of a.comments ?? []) {
    if (!commentsB.has(comment.id)) out.comments.push({ type: 'removed', id: comment.id, detail: comment.text, x: comment.x, y: comment.y });
  }
  return out;
}

/** Текст сводки для строки под результатом сравнения. */
export function diffSummary(d: VersionDiff): string {
  const total = d.added + d.removed + d.changed;
  if (!total && !d.nets.length && !d.diffPairs.length && !d.comments.length && !d.sizeChanged && !d.panelChanged) return 'Версии совпадают: различий нет.';
  const parts: string[] = [];
  if (d.added) parts.push(`добавлено ${d.added}`);
  if (d.removed) parts.push(`удалено ${d.removed}`);
  if (d.changed) parts.push(`изменено ${d.changed}`);
  if (d.sizeChanged) parts.push('размер платы изменён');
  if (d.panelChanged) parts.push('параметры панелизации изменены');
  if (d.nets.length) parts.push(`цепей: ${d.nets.length}`);
  if (d.diffPairs.length) parts.push(`дифференциальных пар: ${d.diffPairs.length}`);
  if (d.comments.length) parts.push(`комментариев: ${d.comments.length}`);
  return parts.join(', ');
}
