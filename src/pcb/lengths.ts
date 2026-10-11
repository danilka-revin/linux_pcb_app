// Длины цепей, шины выравнивания и генерация «змейки» (meander).
//
// Длина цепи — суммарная длина всех дорожек, электрически связанных с её
// площадками (включая ответвления). Для двухточечной цепи без ответвлений это
// длина пути между выводами; для разветвлённых цепей это общая длина меди.
//
// Змейка вставляется внутрь существующей дорожки: отрезок A→B заменяется
// ломаной «зубцов» (вверх на h, поперёк на wT, вниз на h, зазор g вдоль отрезка).
// Каждый зубец добавляет ровно 2h к длине. Перед фиксацией каждая змейка
// проверяется на зазоры до чужой меди и до собственных неприлегающих отрезков;
// если места нет — пробуется другая сторона или другой отрезок.

import type { Entity, Net, Pt, Track } from './model';
import { fmt } from './model';
import { expandDoc } from './expand';
import { copperComponents, netMissing } from './netroute';
import { copperShapes, shapeShapeDist, type Shape } from './autoroute';
import { polylineLength } from './trackcalc';

/** Допуск по длине, мм: разница меньше него считается выравниванием. */
export const LENGTH_TOLERANCE = 0.05;
/** Минимальная высота зубца, мм. */
const MIN_HEIGHT = 0.1;

export interface NetLength {
  netId: string;
  name: string;
  /** шина выравнивания; пусто — цепь вне шин */
  bus: string;
  /** суммарная длина дорожек цепи, мм */
  length: number;
  /** число дорожек цепи */
  tracks: number;
  /** число переходов цепи */
  vias: number;
  /** сколько связей ещё не проложено (0 — цепь соединена) */
  missing: number;
}

/** Длины всех групп соединений. Дорожка относится к цепи, если её медь связана с площадками цепи. */
export function netLengths(
  entities: Entity[],
  nets: readonly Net[],
  comp: Map<string, string> = copperComponents(entities),
): Map<string, NetLength> {
  const owner = new Map<string, string>(); // корень связности → id группы
  const rows = new Map<string, NetLength>();
  for (const net of nets) {
    rows.set(net.id, {
      netId: net.id, name: net.name, bus: (net.bus ?? '').trim(),
      length: 0, tracks: 0, vias: 0, missing: netMissing(net, comp),
    });
    for (const id of net.pads) {
      const root = comp.get(id) ?? id;
      if (!owner.has(root)) owner.set(root, net.id);
    }
  }
  for (const e of entities) {
    if (e.kind !== 'track' && e.kind !== 'via') continue;
    const netId = owner.get(comp.get(e.id) ?? e.id);
    if (!netId) continue;
    const row = rows.get(netId)!;
    if (e.kind === 'via') { row.vias++; continue; }
    const len = polylineLength(e.pts);
    if (len <= 0) continue;
    row.length += len;
    row.tracks++;
  }
  return rows;
}

export interface BusSummary {
  bus: string;
  nets: NetLength[];
  /** самая короткая и самая длинная цепь шины, мм */
  min: number;
  max: number;
  /** разброс: max − min, мм */
  skew: number;
  /** сумма длин всех цепей шины, мм */
  total: number;
}

/** Итоги по шинам выравнивания. Шины без цепей не попадают. */
export function busSummaries(rows: Iterable<NetLength>): BusSummary[] {
  const byBus = new Map<string, NetLength[]>();
  for (const r of rows) {
    if (!r.bus) continue;
    const list = byBus.get(r.bus) ?? [];
    list.push(r);
    byBus.set(r.bus, list);
  }
  const out: BusSummary[] = [];
  for (const [bus, list] of byBus) {
    const lens = list.map((r) => r.length);
    const min = Math.min(...lens), max = Math.max(...lens);
    out.push({
      bus, nets: list.sort((a, b) => a.length - b.length || a.name.localeCompare(b.name)),
      min, max, skew: max - min, total: lens.reduce((s, v) => s + v, 0),
    });
  }
  return out.sort((a, b) => a.bus.localeCompare(b.bus));
}

export interface MeanderOpts {
  /** ширина дорожек цепи, мм */
  trackW: number;
  /** зазор до чужой меди (край до края), мм */
  clearance: number;
  /** наибольшая высота зубца, мм */
  maxHeight: number;
}

export interface LengthenResult {
  /** новый список примитивов (изменены только дорожки цепи) */
  entities: Entity[];
  before: number;
  after: number;
  /** добавлено зубцов */
  teeth: number;
  /** достигнута ли целевая длина (с допуском) */
  complete: boolean;
  message: string;
}

/** Геометрия зубцов по параметрам правил. */
function meanderGeometry(o: MeanderOpts) {
  const gap = Math.max(o.trackW + 2 * o.clearance, 0.3);     // зазор между соседними зубцами, центр-центр
  const run = Math.max(2 * gap, 1);                         // поперечная ширина зубца вдоль отрезка
  const margin = Math.max(1, 2 * (o.trackW + o.clearance)); // отступ от концов отрезка
  return { gap, run, pitch: run + gap, margin, minSeg: 2 * margin + run };
}

/** Точки зубцов для отрезка длиной L: без концов A и B. */
function teethPath(A: Pt, u: Pt, n: Pt, L: number, geo: ReturnType<typeof meanderGeometry>,
  teeth: number, h: number, side: 1 | -1): Pt[] {
  const span = (teeth - 1) * geo.pitch + geo.run;
  const a0 = (L - span) / 2;
  const at = (a: number, b: number): Pt => ({ x: A.x + u.x * a + n.x * b, y: A.y + u.y * a + n.y * b });
  const out: Pt[] = [];
  for (let k = 0; k < teeth; k++) {
    const x0 = a0 + k * geo.pitch;
    out.push(at(x0, 0), at(x0, side * h), at(x0 + geo.run, side * h), at(x0 + geo.run, 0));
  }
  return out;
}

/** Фигуры отрезков ломаной (как скелет меди с радиусом w/2). */
function segShapes(id: string, layer: Track['layer'], pts: Pt[], r: number): Shape[] {
  const out: Shape[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push({
      id, layers: [layer], segs: [[a.x, a.y, b.x, b.y]], r,
      bb: [Math.min(a.x, b.x) - r, Math.min(a.y, b.y) - r, Math.max(a.x, b.x) + r, Math.max(a.y, b.y) + r],
    });
  }
  return out;
}

/** Ломаная дорожки с уже запланированными змейками (индекс — номер отрезка в исходном pts). */
function currentPts(t: Track, planned: Map<number, Pt[]> | undefined): Pt[] {
  if (!planned || !planned.size) return t.pts;
  const out: Pt[] = [t.pts[0]];
  for (let i = 0; i < t.pts.length - 1; i++) {
    const inner = planned.get(i);
    if (inner) out.push(...inner);
    out.push(t.pts[i + 1]);
  }
  return out;
}

interface Candidate { track: Track; seg: number; L: number; maxTeeth: number; A: Pt; B: Pt }

/**
 * Цепь удлиняется до target (мм) вставкой змеек в её дорожки.
 * Исходные примитивы не мутируются: возвращается новый список.
 */
export function lengthenNet(
  entities: Entity[], nets: readonly Net[], netId: string, target: number, opts: MeanderOpts,
): LengthenResult {
  const net = nets.find((n) => n.id === netId);
  const comp = copperComponents(entities);
  const row = netLengths(entities, nets, comp).get(netId);
  if (!net || !row) return { entities, before: 0, after: 0, teeth: 0, complete: false, message: 'Группа не найдена.' };
  const before = row.length;
  const need = target - before;
  if (need <= LENGTH_TOLERANCE) {
    return { entities, before, after: before, teeth: 0, complete: true, message: `Длина уже ${fmt(before, 2)} мм — не короче целевой.` };
  }
  const roots = new Set(net.pads.map((id) => comp.get(id) ?? id));
  const tracks = entities.filter((e): e is Track => e.kind === 'track'
    && e.pts.length >= 2 && roots.has(comp.get(e.id) ?? e.id));
  if (!tracks.length) {
    return { entities, before, after: before, teeth: 0, complete: false, message: 'У цепи нет дорожек: сначала проложите её.' };
  }

  const geo = meanderGeometry(opts);
  const hMax = Math.max(opts.maxHeight, MIN_HEIGHT);
  const cands: Candidate[] = [];
  for (const t of tracks) {
    for (let i = 0; i < t.pts.length - 1; i++) {
      const A = t.pts[i], B = t.pts[i + 1];
      const L = Math.hypot(B.x - A.x, B.y - A.y);
      if (L < geo.minSeg) continue;
      const maxTeeth = Math.floor((L - 2 * geo.margin - geo.run) / geo.pitch) + 1;
      if (maxTeeth >= 1) cands.push({ track: t, seg: i, L, maxTeeth, A, B });
    }
  }
  if (!cands.length) {
    return { entities, before, after: before, teeth: 0, complete: false, message: 'Нет прямого участка для змейки: дорожки цепи слишком короткие.' };
  }
  cands.sort((x, y) => y.L - x.L);

  // Препятствия: вся медь, кроме дорожек (дорожки учитываются по текущей геометрии).
  const flat = expandDoc(entities);
  const others: Shape[] = [];
  for (const e of flat) if (e.kind !== 'track') others.push(...copperShapes(e));

  const planned = new Map<string, Map<number, Pt[]>>();
  const trackShapesFor = (skipTrack?: string, skipSeg?: number): Shape[] => {
    const out: Shape[] = [];
    for (const t of tracks) {
      const pl = planned.get(t.id);
      const r = t.w / 2;
      for (let i = 0; i < t.pts.length - 1; i++) {
        if (t.id === skipTrack && skipSeg !== undefined && Math.abs(i - skipSeg) <= 1) continue;
        const inner = pl?.get(i);
        const seq = inner ? [t.pts[i], ...inner, t.pts[i + 1]] : [t.pts[i], t.pts[i + 1]];
        out.push(...segShapes(t.id, t.layer, seq, r));
      }
    }
    return out;
  };

  /** Проверка зубцов против меди: край до края не меньше зазора. */
  const clears = (track: Track, path: Pt[], u: Pt, obstacles: Shape[]): boolean => {
    const limit = opts.clearance - 1e-6;
    const mine = segShapes(track.id + '#m', track.layer, path, track.w / 2)
      // осевые отрезки продолжают уже существующую дорожку — их не проверяем
      .filter((m) => {
        const [x1, y1, x2, y2] = m.segs[0];
        const dx = x2 - x1, dy = y2 - y1;
        return Math.abs(dx * u.y - dy * u.x) > 1e-9 * Math.hypot(dx, dy);
      });
    for (const m of mine) {
      for (const o of obstacles) {
        if (!o.layers.includes(track.layer)) continue;
        if (o.bb[0] > m.bb[2] + limit || o.bb[2] < m.bb[0] - limit
          || o.bb[1] > m.bb[3] + limit || o.bb[3] < m.bb[1] - limit) continue;
        if (shapeShapeDist(m, o) < limit) return false;
      }
    }
    return true;
  };
  const obstaclesFor = (track: Track, seg: number): Shape[] => {
    const own = trackShapesFor(track.id, seg);
    return others.concat(own);
  };

  const plan = (cand: Candidate, teeth: number, h: number): { inner: Pt[]; added: number } | null => {
    const Lc = cand.L;
    const u = { x: (cand.B.x - cand.A.x) / Lc, y: (cand.B.y - cand.A.y) / Lc };
    const n = { x: -u.y, y: u.x };
    const obstacles = obstaclesFor(cand.track, cand.seg);
    for (const side of [1, -1] as const) {
      const inner = teethPath(cand.A, u, n, Lc, geo, teeth, h, side);
      const path = [cand.A, ...inner, cand.B];
      if (!clears(cand.track, path, u, obstacles)) continue;
      return { inner, added: 2 * teeth * h };
    }
    return null;
  };

  let rem = need;
  let teethTotal = 0;
  const used = new Set<string>();
  const place = (cand: Candidate, teeth: number, h: number, inner: Pt[]): void => {
    const key = cand.track.id + '#' + cand.seg;
    used.add(key);
    let pl = planned.get(cand.track.id);
    if (!pl) { pl = new Map(); planned.set(cand.track.id, pl); }
    pl.set(cand.seg, inner);
    teethTotal += teeth;
    rem -= 2 * teeth * h;
  };
  // Сначала — полная змейка в одном отрезке (как можно выше зубцы); потом — частичные.
  for (const pass of ['full', 'partial'] as const) {
    for (const cand of cands) {
      if (rem <= LENGTH_TOLERANCE) break;
      const key = cand.track.id + '#' + cand.seg;
      if (used.has(key)) continue;
      // зубцов не больше, чем нужно по остатку: длина не перелетает цель
      const wanted = Math.max(1, Math.ceil(rem / (2 * hMax)));
      if (pass === 'full' && wanted > cand.maxTeeth) continue;
      const teeth = Math.min(cand.maxTeeth, wanted);
      const h = Math.min(hMax, rem / (2 * teeth));
      const res = plan(cand, teeth, h);
      if (res) place(cand, teeth, h, res.inner);
      else used.add(key); // на этом отрезке место занято — не пробуем его снова
    }
  }

  if (!teethTotal) {
    return { entities, before, after: before, teeth: 0, complete: false, message: 'Нет места для змейки: не хватает свободного пространства рядом с дорожками и медью.' };
  }

  const out = entities.map((e) => {
    if (e.kind !== 'track') return e;
    const pl = planned.get(e.id);
    if (!pl) return e;
    return { ...e, pts: currentPts(e, pl) } as Track;
  });
  const after = netLengths(out, nets).get(netId)?.length ?? before;
  const complete = after >= target - LENGTH_TOLERANCE;
  const message = complete
    ? `Змейки: +${fmt(after - before, 2)} мм, зубцов ${teethTotal}. Длина ${fmt(after, 2)} мм.`
    : `Места не хватило: длина ${fmt(after, 2)} мм из ${fmt(target, 2)} мм. Уменьшите цель или дайте больше места.`;
  return { entities: out, before, after, teeth: teethTotal, complete, message };
}

export interface BusAlignResult {
  entities: Entity[];
  target: number;
  results: { netId: string; name: string; before: number; after: number; complete: boolean }[];
  message: string;
  /** все цепи шины выровнены в пределах допуска */
  aligned: boolean;
}

/** Выровнять шину: все цепи доводятся до длины самой длинной цепи шины. */
export function alignBus(
  entities: Entity[], nets: readonly Net[], bus: string,
  optsFor: (net: Net) => MeanderOpts,
): BusAlignResult {
  const rows = [...netLengths(entities, nets).values()].filter((r) => r.bus === bus);
  if (!rows.length) {
    return { entities, target: 0, results: [], aligned: false, message: `В шине «${bus}» нет цепей.` };
  }
  const target = Math.max(...rows.map((r) => r.length));
  let ents = entities;
  const results: BusAlignResult['results'] = [];
  for (const r of rows.sort((a, b) => a.length - b.length)) {
    if (r.length >= target - LENGTH_TOLERANCE) continue;
    const net = nets.find((n) => n.id === r.netId);
    if (!net) continue;
    const res = lengthenNet(ents, nets, r.netId, target, optsFor(net));
    ents = res.entities;
    results.push({ netId: r.netId, name: r.name, before: res.before, after: res.after, complete: res.complete });
  }
  const after = [...netLengths(ents, nets).values()].filter((r) => r.bus === bus);
  const aligned = after.every((r) => r.length >= target - LENGTH_TOLERANCE)
    && busSummaries(after)[0]?.skew <= LENGTH_TOLERANCE * 2;
  const failed = results.filter((r) => !r.complete).map((r) => r.name);
  const message = !results.length
    ? `Шина «${bus}» уже выровнена: цель ${fmt(target, 2)} мм.`
    : failed.length
      ? `Шина «${bus}»: не удалось довести ${failed.join(', ')} до ${fmt(target, 2)} мм — не хватило места.`
      : `Шина «${bus}» выровнена по ${fmt(target, 2)} мм.`;
  return { entities: ents, target, results, aligned, message };
}

