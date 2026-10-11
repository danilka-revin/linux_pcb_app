// Панель объектов: дерево всего, что лежит на плате, — «как список слоёв».
// Чистая логика без React: построение дерева по документу, подписи объектов,
// поиск по дереву и вспомогательные функции для скрытия/блокировки.
//
// Дерево повторяет порядок отрисовки и структуру платы:
//   • Детали — каждая деталь отдельной строкой со своими примитивами внутри;
//   • Сквозные — площадки, переходы и монтажные отверстия (они есть на обеих
//     сторонах платы, поэтому не принадлежат одному слою меди);
//   • слои K1/K2/Ш1/Ш2/Контур — группы по типу объекта, внутри — сами объекты.
//
// Строка объекта знает свои id верхнего уровня (ids): по ним панель выделяет,
// скрывает и блокирует. У детали внутри всё единое целое — примитивы компонента
// выбираются и прячутся только вместе с ним (как и на холсте).

import { LAYERS, entBBox, fmt, type Doc, type Entity, type LayerId, type Pt } from './model';
import { expandComp } from './expand';
import { polylineLength } from './trackcalc';

/** Габарит в мм: [x1, y1, x2, y2] */
export type Box = [number, number, number, number];

/** Разделы верхнего уровня: детали, сквозные объекты и слои платы. */
export type ObjSectionId = 'comp' | 'through' | LayerId;

/** Цвет точки строки: слой меди/шелкографии, «сквозной» объект или деталь. */
export type ObjTone = LayerId | 'both' | 'comp';

export interface ObjNode {
  /** ключ строки — стабилен между перестройками дерева */
  id: string;
  /** section — раздел/слой, group — тип объектов, ent — сам объект */
  kind: 'section' | 'group' | 'ent';
  label: string;
  detail?: string;
  tone: ObjTone;
  /** имя иконки из ui/icons */
  icon: string;
  /** id примитивов верхнего уровня: что выделять, скрывать и блокировать */
  ids: string[];
  /** сколько объектов в поддереве */
  count: number;
  /** габарит поддерева — панель переводит к нему вид */
  box: Box | null;
  children?: ObjNode[];
  /** текст для поиска (подпись + пояснение + синонимы типа) */
  hay: string;
}

/** Русские названия типов для подписей строк и поиска. */
export const KIND_RU: Record<Entity['kind'], string> = {
  pad: 'площадка пятачок вывод контактная',
  smd: 'smd планарная площадка контактная',
  track: 'дорожка провод трасса',
  via: 'переход переходное отверстие',
  hole: 'отверстие монтажное крепёж',
  line: 'линия отрезок',
  circle: 'окружность круг',
  rect: 'прямоугольник квадрат рамка',
  text: 'текст надпись обозначение',
  poly: 'полигон заливка земля',
  dim: 'размер размерная линия',
  comp: 'деталь компонент корпус',
};

/** Подпись группы типов (множественное число) — для строк-групп в дереве. */
export const KIND_NOUN: Record<Entity['kind'], string> = {
  pad: 'Площадки',
  smd: 'SMD-площадки',
  track: 'Дорожки',
  via: 'Переходы',
  hole: 'Отверстия',
  line: 'Линии',
  circle: 'Окружности',
  rect: 'Прямоугольники',
  text: 'Тексты',
  poly: 'Полигоны',
  dim: 'Размеры',
  comp: 'Детали',
};

/** Подпись одного объекта в единственном числе — для истории правок. */
export const KIND_ONE: Record<Entity['kind'], string> = {
  pad: 'площадка',
  smd: 'SMD-площадка',
  track: 'дорожка',
  via: 'переход',
  hole: 'отверстие',
  line: 'линия',
  circle: 'окружность',
  rect: 'прямоугольник',
  text: 'текст',
  poly: 'полигон',
  dim: 'размер',
  comp: 'деталь',
};

/**
 * Подпись операции «добавлены объекты» для списка истории: у одиночного объекта
 * называем тип («Добавлена площадка»), у набора — просто количество.
 */
export function newEntsLabel(ents: Entity[]): string {
  if (!ents.length) return 'Добавлены объекты';
  const kinds = new Set(ents.map((e) => e.kind));
  if (ents.length === 1) return `Добавлен объект: ${KIND_ONE[ents[0].kind]}`;
  if (kinds.size === 1) return `Добавлено объектов: ${ents.length} (${KIND_NOUN[ents[0].kind].toLowerCase()})`;
  return `Добавлено объектов: ${ents.length}`;
}

/** Иконка типа объекта (совпадает с инструментами редактора). */
export const KIND_ICON: Record<Entity['kind'], string> = {
  pad: 'pad', smd: 'smd', track: 'track', via: 'via', hole: 'hole',
  line: 'line', circle: 'circle', rect: 'rect', text: 'text', poly: 'fill',
  dim: 'ruler', comp: 'comp',
};

/** Порядок групп внутри каждого раздела. */
const GROUP_ORDER: Record<ObjSectionId, Entity['kind'][]> = {
  comp: ['comp'],
  through: ['pad', 'via', 'hole'],
  k1: ['track', 'poly', 'smd', 'rect', 'circle', 'line', 'text', 'dim'],
  k2: ['track', 'poly', 'smd', 'rect', 'circle', 'line', 'text', 'dim'],
  s1: ['rect', 'poly', 'circle', 'line', 'text', 'dim'],
  s2: ['rect', 'poly', 'circle', 'line', 'text', 'dim'],
  outline: ['rect', 'poly', 'line', 'circle', 'dim'],
};

export const SECTION_TITLE: Record<ObjSectionId, string> = {
  comp: 'Детали',
  through: 'Сквозные',
  k1: 'Верхняя медь (K1)',
  k2: 'Нижняя медь (K2)',
  s1: 'Шелкография верх (Ш1)',
  s2: 'Шелкография низ (Ш2)',
  outline: 'Контур платы',
};

export const SECTION_HINT: Record<ObjSectionId, string> = {
  comp: 'компоненты целиком: площадки, шелкография и отверстия внутри',
  through: 'площадки, переходы и монтажные отверстия на обеих сторонах',
  k1: 'дорожки, заливки и SMD верхней стороны',
  k2: 'дорожки, заливки и SMD нижней стороны',
  s1: 'линии, фигуры и надписи верхней стороны',
  s2: 'линии, фигуры и надписи нижней стороны',
  outline: 'контур и вырезы платы',
};

/** Разделы в порядке показа: детали, сквозные, затем слои. */
export const SECTION_ORDER: ObjSectionId[] = ['comp', 'through', 'k1', 'k2', 's1', 's2', 'outline'];

const SECTION_TONE: Record<ObjSectionId, ObjTone> = {
  comp: 'comp', through: 'both', k1: 'k1', k2: 'k2', s1: 's1', s2: 's2', outline: 'outline',
};

const SECTION_ICON: Record<ObjSectionId, string> = {
  comp: 'comp', through: 'via', k1: 'layers', k2: 'layers', s1: 'layers', s2: 'layers', outline: 'layers',
};

const nf = (v: number, d = 2): string => fmt(v, d).replace('.', ',');

/** Короткая строка текста для подписи: без переводов строк и с многоточием. */
const clip = (s: string, n = 28): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Подпись объекта в дереве. */
export function entLabel(e: Entity): string {
  switch (e.kind) {
    case 'pad': return `Площадка ⌀${nf(e.size)} мм` + (e.drill > 0 ? ` · отв. ${nf(e.drill)}` : '');
    case 'smd': return `SMD ${nf(e.w)}×${nf(e.h)} мм`;
    case 'track': {
      const len = polylineLength(e.pts);
      return `Дорожка ${nf(e.w)} мм · ${len >= 100 ? fmt(len, 1) : nf(len, 1)} мм · узлов ${e.pts.length}`;
    }
    case 'via': return `Переход ⌀${nf(e.size)} / ${nf(e.drill)} мм`;
    case 'hole': return `Отверстие ⌀${nf(e.d)} мм`;
    case 'line': {
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      return `Линия ${nf(len, 1)} мм · ${nf(e.w)} мм`;
    }
    case 'circle': return `Окружность R${nf(e.r)} мм · ${nf(e.w)} мм`;
    case 'rect': return `Прямоугольник ${nf(e.w)}×${nf(e.h)} мм${e.filled ? ' · залитый' : ''}`;
    case 'text': return `Текст «${clip(e.text || '—', 24)}»`;
    case 'poly': return `Полигон: ${e.pts.length} верш.${e.holes?.length ? ` · дырок ${e.holes.length}` : ''}`;
    case 'dim': {
      const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
      return `Размер ${nf(len, 2)} мм${e.text ? ` · «${clip(e.text, 16)}»` : ''}`;
    }
    case 'comp': return `${e.name || 'Деталь'} · ${e.side === 'bottom' ? 'снизу' : 'сверху'}`;
  }
}

/** Центр объекта для подписи «где он лежит». */
function entCenter(e: Entity): Pt {
  if (e.kind === 'pad' || e.kind === 'via' || e.kind === 'hole' || e.kind === 'smd'
    || e.kind === 'text' || e.kind === 'circle' || e.kind === 'comp') return { x: e.x, y: e.y };
  if (e.kind === 'line' || e.kind === 'dim') return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
  if (e.kind === 'rect') return { x: e.x + e.w / 2, y: e.y + e.h / 2 };
  const b = entBBox(e);
  return { x: (b[0] + b[2]) / 2, y: (b[1] + b[3]) / 2 };
}

/** Пояснение строки объекта: координаты центра и, если есть, имя группы. */
export function entDetail(e: Entity, groupNames: string[] = []): string {
  const c = entCenter(e);
  const coord = `x ${nf(c.x, 1)}; y ${nf(c.y, 1)} мм`;
  const layer = e.kind === 'comp' ? '' : layerTag(e);
  const parts = [coord];
  if (layer) parts.push(layer);
  if (e.kind === 'comp') parts[0] = `${(e.ents ?? []).length} прим. · ${coord}`;
  if (groupNames.length) parts.push(`группа «${clip(groupNames[0], 18)}»`);
  return parts.join(' · ');
}

/** Подпись слоя для сквозных объектов и деталей. */
function layerTag(e: Entity): string {
  const l = (e as { layer?: LayerId }).layer;
  if (!l) return '';
  const info = LAYERS.find((x) => x.id === l);
  return info ? info.short : l;
}

/** Все id групп, в которые входят элементы (для подписи строки). */
function groupNamesOf(doc: Doc): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of doc.groups ?? []) {
    for (const id of g.ids) {
      const list = out.get(id) ?? [];
      list.push(g.name);
      out.set(id, list);
    }
  }
  return out;
}

/** Раздел, к которому относится примитив верхнего уровня. */
export function sectionOf(e: Entity): ObjSectionId {
  if (e.kind === 'comp') return 'comp';
  if (e.kind === 'pad' || e.kind === 'via' || e.kind === 'hole') return 'through';
  const l = (e as { layer?: LayerId }).layer;
  return l ?? 'outline';
}

function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    if (b[0] < x1) x1 = b[0];
    if (b[1] < y1) y1 = b[1];
    if (b[2] > x2) x2 = b[2];
    if (b[3] > y2) y2 = b[3];
  }
  return [x1, y1, x2, y2];
}

/** Текст строки для поиска: подпись, пояснение, синонимы типа, координаты. */
function haystack(parts: string[]): string {
  const raw = parts.filter(Boolean).join(' ').toLowerCase();
  // координаты ищут и с точкой, и с запятой: «12.5» и «12,5» — одно и то же
  return raw.includes(',') ? raw + ' ' + raw.replace(/,/g, '.') : raw;
}

/**
 * Дерево объектов документа. Тяжёлая часть — перебор примитивов и раскрытие
 * компонентов — выполняется один раз на изменение платы (панель вызывает
 * построение через useMemo).
 */
export function buildObjectTree(doc: Doc): ObjNode[] {
  const groups = groupNamesOf(doc);
  const buckets = new Map<ObjSectionId, Map<Entity['kind'], Entity[]>>();
  for (const e of doc.entities) {
    const sec = sectionOf(e);
    let kinds = buckets.get(sec);
    if (!kinds) { kinds = new Map(); buckets.set(sec, kinds); }
    const list = kinds.get(e.kind) ?? [];
    list.push(e);
    kinds.set(e.kind, list);
  }

  const sections: ObjNode[] = [];
  for (const sec of SECTION_ORDER) {
    const kinds = buckets.get(sec);
    if (!kinds || !kinds.size) continue;
    const groupsNodes: ObjNode[] = [];
    const order = GROUP_ORDER[sec];
    const kindsSorted = [...kinds.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    for (const kind of kindsSorted) {
      const list = kinds.get(kind)!;
      const nodes: ObjNode[] = [];
      const boxes: Box[] = [];
      for (const e of list) {
        const box = entBBox(e);
        boxes.push(box);
        const detail = entDetail(e, groups.get(e.id));
        if (e.kind === 'comp') {
          // внутри детали — её примитивы по типам: выбрать можно только деталь целиком
          const inner = innerGroups(e);
          nodes.push({
            id: 'ent:' + e.id,
            kind: 'ent',
            label: entLabel(e),
            detail,
            tone: 'comp',
            icon: KIND_ICON.comp,
            ids: [e.id],
            count: 1,
            box,
            children: inner,
            hay: haystack([entLabel(e), detail, KIND_RU.comp, e.lib ?? '', ...inner.map((n) => n.hay)]),
          });
          continue;
        }
        nodes.push({
          id: 'ent:' + e.id,
          kind: 'ent',
          label: entLabel(e),
          detail,
          tone: sec === 'through' ? 'both' : SECTION_TONE[sec],
          icon: KIND_ICON[kind],
          ids: [e.id],
          count: 1,
          box,
          hay: haystack([entLabel(e), detail, KIND_RU[kind], SECTION_TITLE[sec]]),
        });
      }
      // В разделе «Детали» группа ровно одна и называлась бы так же, как раздел, —
      // детали идут прямо в разделе, без лишнего уровня.
      if (sec === 'comp') groupsNodes.push(...nodes);
      else groupsNodes.push({
        id: `group:${sec}:${kind}`,
        kind: 'group',
        label: KIND_NOUN[kind],
        detail: `${nodes.length}`,
        tone: sec === 'through' ? 'both' : SECTION_TONE[sec],
        icon: KIND_ICON[kind],
        ids: list.map((e) => e.id),
        count: nodes.length,
        box: unionBox(boxes),
        children: nodes,
        hay: haystack([KIND_NOUN[kind], KIND_RU[kind], SECTION_TITLE[sec], SECTION_HINT[sec]]),
      });
    }
    sections.push({
      id: 'section:' + sec,
      kind: 'section',
      label: SECTION_TITLE[sec],
      detail: SECTION_HINT[sec],
      tone: SECTION_TONE[sec],
      icon: SECTION_ICON[sec],
      ids: groupsNodes.flatMap((g) => g.ids),
      count: groupsNodes.reduce((s, g) => s + g.count, 0),
      box: unionBox(groupsNodes.map((g) => g.box).filter((b): b is Box => !!b)),
      children: groupsNodes,
      hay: haystack([SECTION_TITLE[sec], SECTION_HINT[sec], ...groupsNodes.map((g) => g.hay)]),
    });
  }
  return sections;
}

/** Примитивы внутри детали, сгруппированные по типу (только для показа). */
function innerGroups(c: Entity): ObjNode[] {
  if (c.kind !== 'comp') return [];
  const subs = expandComp(c);
  if (!subs.length) return [];
  const byKind = new Map<Entity['kind'], Entity[]>();
  for (const s of subs) {
    const list = byKind.get(s.kind) ?? [];
    list.push(s);
    byKind.set(s.kind, list);
  }
  const order: Entity['kind'][] = ['pad', 'via', 'hole', 'smd', 'track', 'poly', 'rect', 'circle', 'line', 'text', 'dim'];
  return [...byKind.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([kind, list]) => ({
      id: `${c.id}:${kind}`,
      kind: 'group' as const,
      label: KIND_NOUN[kind],
      detail: `${list.length}`,
      tone: 'comp' as const,
      icon: KIND_ICON[kind],
      ids: [c.id],
      count: list.length,
      box: unionBox(list.map(entBBox)),
      // в поисковый текст попадают и подписи примитивов: надпись на шелкографии
      // внутри детали ищется по своему тексту («GND»), а не только по типу
      hay: haystack([KIND_NOUN[kind], KIND_RU[kind], ...list.map(entLabel)]),
    }));
}

/**
 * Фильтр дерева по запросу: строка остаётся, если совпала сама (тогда видно всё
 * её поддерево) или совпал кто-то из детей. Счётчики пересчитываются по тому,
 * что видно, — в панели числа совпадают с показанным.
 */
export function filterObjectTree(nodes: ObjNode[], query: string): ObjNode[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return nodes;
  const keep = (n: ObjNode): ObjNode | null => {
    if (terms.every((t) => n.hay.includes(t))) return n;
    const kids = (n.children ?? []).map(keep).filter((x): x is ObjNode => !!x);
    if (!kids.length) return null;
    return { ...n, children: kids, count: kids.reduce((s, k) => s + k.count, 0) };
  };
  return nodes.map(keep).filter((x): x is ObjNode => !!x);
}

/**
 * Состояние флага (скрыт/заблокирован) для строки: ни одного, все или часть.
 * Панель по этому значению рисует кнопку: обычную, погашенную или «частично».
 */
export function flagState(ids: string[], set: Set<string>): 'none' | 'all' | 'mixed' {
  if (!ids.length) return 'none';
  let n = 0;
  for (const id of ids) if (set.has(id)) n++;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'mixed';
}

/** Сколько объектов в списке строк (для подписи панели). */
export function countNodes(nodes: ObjNode[]): number {
  return nodes.reduce((s, n) => s + n.count, 0);
}
