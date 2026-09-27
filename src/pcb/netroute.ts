// Пакетная трассировка заданных пользователем электрических цепей.
//
// Конвейер по одной плате за проход:
//  1) группы сортируются «сначала толстые»: широкой дорожке труднее найти проход,
//     внутри одного порядка — короткие связи первыми (как раньше);
//  2) каждая связь ищется на разрешённых слоях; если прямой путь не вышел, ищется
//     ветка к уже проложенной меди той же группы (стволу) — это короткое подключение
//     вне площадки и часто без лишних переходов;
//  3) если связь всё равно не выходит, снимается та медь, которую в этом же прогоне
//     проложил сам автотрассировщик (медь пользователя не трогается никогда),
//     связь прокладывается заново, а задетые группы возвращаются в очередь;
//  4) проход принимается только если суммарно не стало хуже, иначе откатывается.
//
// Эвристика: несколько порядков цепей, сначала все связи без переходов,
// затем двухслойные обходы. Критерий: недостающие связи → переходы → длина.
import type { Doc, Entity, Net, Pt } from './model';
import { expandDoc } from './expand';
import {
  autoroute, copperShapes, endpointOf, netOf, shapeShapeDist,
  type RouteEnd, type RouteOpts, type RouteResult, type Shape,
} from './autoroute';

export interface NetRouteResult {
  ents: Entity[];
  vias: number;
  length: number;
  missing: number;
  unresolved: { name: string; missing: number }[];
  errors: string[];
  attempts: number;
  /** сколько дорожек этого же прогона пришлось снять и переложить (rip-up) */
  rips: number;
}

/** Флаги «умного» конвейера: тесты и отладка могут выключать отдельные шаги. */
export interface NetRouteFlags {
  /** разрешить снятие и перекладку собственной меди прогона (по умолчанию да) */
  rips?: boolean;
}

/** Физическая связность меди, включая ранее проложенные ручные дорожки. */
export function copperComponents(entities: Entity[]): Map<string, string> {
  const shapes = expandDoc(entities).flatMap(copperShapes).filter((s) => !s.hole);
  const comp = new Map<string, string>();
  for (const s of shapes) {
    if (comp.has(s.id)) continue;
    for (const id of netOf(shapes, new Set([s.id]))) comp.set(id, s.id);
  }
  return comp;
}

export function netMissing(net: Net, comp: Map<string, string>): number {
  return Math.max(0, new Set(net.pads.map((id) => comp.get(id) ?? id)).size - 1);
}

export function netConflicts(nets: Net[], comp: Map<string, string>): string[] {
  const owners = new Map<string, Net>();
  const errors = new Set<string>();
  for (const net of nets) for (const id of net.pads) {
    const key = comp.get(id) ?? id;
    const owner = owners.get(key);
    if (owner && owner.id !== net.id) errors.add(`Группы «${owner.name}» и «${net.name}» уже замкнуты общей площадкой или медью. Устраните соединение.`);
    owners.set(key, net);
  }
  return [...errors];
}

const totalMissing = (nets: Net[], comp: Map<string, string>): number =>
  nets.reduce((sum, n) => sum + netMissing(n, comp), 0);

const num = (v: number | undefined, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : null;

/**
 * Параметры трассировки конкретной группы: личные правила (ширина, зазор, переходы)
 * накладываются на общие настройки. Общий запрет верхнего слоя сильнее личного,
 * а зазор группы может только увеличить общий — чужое правило не нарушается.
 */
export function netRouteOpts(net: Net | undefined, opts: RouteOpts): RouteOpts {
  const r = net?.rules;
  if (!r) return opts;
  const o: RouteOpts = { ...opts };
  const w = num(r.w, 0.05, 5);
  if (w !== null) o.trackW = w;
  const clear = num(r.clear, 0.05, 3);
  if (clear !== null) o.clearance = Math.max(opts.clearance, clear);
  const viaSize = num(r.viaSize, 0.3, 6);
  if (viaSize !== null) o.viaSize = viaSize;
  const viaDrill = num(r.viaDrill, 0.1, 5);
  if (viaDrill !== null) o.viaDrill = Math.max(0.1, Math.min(viaDrill, o.viaSize - 0.2));
  if (typeof r.allowTop === 'boolean') o.allowTop = opts.allowTop && r.allowTop;
  return o;
}

/** Лучше ли новый прогон: связи важнее переходов, переходы — длины, затем снятий. */
function betterResult(a: NetRouteResult, b: NetRouteResult): boolean {
  if (a.missing !== b.missing) return a.missing < b.missing;
  if (a.vias !== b.vias) return a.vias < b.vias;
  if (a.length !== b.length) return a.length < b.length;
  return a.rips < b.rips;
}

export type RouteStrategy = 'few-vias' | 'short' | 'long-first';
export interface NetRouteVariant extends NetRouteResult {
  strategy: RouteStrategy;
  title: string;
  description: string;
  sameAs?: number;
}
export interface NetRouteVariants { variants: NetRouteVariant[]; errors: string[] }

// ---------------------------------------------------------------------------
// Состояние одного прогона: плата + всё, что успел проложить роутер.

interface Run {
  entities: Entity[];              // исходные + добавленная роутером медь
  added: Entity[];                 // медь, добавленная за этот прогон
  owner: Map<string, string>;      // id добавленной сущности → id группы
  comp: Map<string, string>;       // id примитива → корень связности
  rips: number;                    // сколько дорожек прогона пришлось снять
  locked: Set<string>;             // группы, которые в этом проходе уже переложили
}

interface Snap {
  entities: Entity[];
  added: Entity[];
  owner: Map<string, string>;
  comp: Map<string, string>;
  rips: number;
  locked: Set<string>;
}

interface Ctx {
  doc: Doc;
  nets: Net[];
  opts: RouteOpts;
  strategy?: RouteStrategy;
  progress: (text: string) => void;
  rips: boolean;
}

const snapshot = (r: Run): Snap =>
  ({ entities: r.entities, added: r.added, owner: new Map(r.owner), comp: r.comp, rips: r.rips, locked: new Set(r.locked) });

const restore = (r: Run, s: Snap): void => {
  r.entities = s.entities; r.added = s.added; r.owner = s.owner; r.comp = s.comp; r.rips = s.rips;
  r.locked = s.locked;
};

interface PairCand { a: RouteEnd; b: RouteEnd; d: number }

const trackLen = (t: Extract<Entity, { kind: 'track' }>): number => {
  let sum = 0;
  for (let i = 0; i < t.pts.length - 1; i++) sum += Math.hypot(t.pts[i + 1].x - t.pts[i].x, t.pts[i + 1].y - t.pts[i].y);
  return sum;
};

/** Недостающие связи группы: для «длинных первыми» — от дальних пар к ближним. */
function pairCandidates(net: Net, comp: Map<string, string>, ends: Map<string, RouteEnd>, strategy?: RouteStrategy): PairCand[] {
  const out: PairCand[] = [];
  for (let i = 0; i < net.pads.length; i++) for (let j = i + 1; j < net.pads.length; j++) {
    if (comp.get(net.pads[i]) === comp.get(net.pads[j])) continue;
    const a = ends.get(net.pads[i]), b = ends.get(net.pads[j]);
    if (!a || !b) continue;
    out.push({ a, b, d: Math.hypot(a.x - b.x, a.y - b.y) });
  }
  out.sort((p, q) => strategy === 'long-first' ? q.d - p.d : p.d - q.d);
  return out;
}

/** Ближайшая точка скелета медной фигуры к точке (x, y). */
function nearestOnShape(s: Shape, x: number, y: number): { p: Pt; d: number } | null {
  let best: Pt | null = null, bd = Infinity;
  for (const g of s.segs) {
    const dx = g[2] - g[0], dy = g[3] - g[1];
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((x - g[0]) * dx + (y - g[1]) * dy) / L2)) : 0;
    const px = g[0] + t * dx, py = g[1] + t * dy;
    const d = Math.hypot(px - x, py - y);
    if (d < bd) { bd = d; best = { x: px, y: py }; }
  }
  return best ? { p: best, d: bd } : null;
}

/**
 * Точки подключения к уже проложенной меди группы: площадки, переходы, SMD и
 * ближайшие точки дорожек/полигонов. Ветка к стволу короче подхода к площадке
 * и часто обходится без лишних переходов.
 */
function trunkEnds(
  entities: Entity[], o: RouteOpts, comp: Map<string, string>, root: string,
  from: RouteEnd, skipId: string | undefined, max: number,
): RouteEnd[] {
  const out: { end: RouteEnd; d: number }[] = [];
  for (const e of expandDoc(entities)) {
    if (e.id === skipId || comp.get(e.id) !== root) continue;
    const end = endpointOf(e);
    if (end) {
      out.push({ end, d: Math.max(0, Math.hypot(end.x - from.x, end.y - from.y) - end.r) });
      continue;
    }
    for (const s of copperShapes(e)) {
      if (s.hole || !s.segs.length) continue;
      if (!s.layers.some((l) => o.allowTop || l === 'k2')) continue;
      const near = nearestOnShape(s, from.x, from.y);
      if (near) out.push({ end: { x: near.p.x, y: near.p.y, layers: s.layers, r: s.r, entId: s.id }, d: Math.max(0, near.d - s.r) });
    }
  }
  out.sort((p, q) => p.d - q.d);
  return out.slice(0, max).map((p) => p.end);
}

/** Лучше ли новый результат прежнего по критерию выбранной стратегии. */
function better(strategy: RouteStrategy | undefined, r: RouteResult, best: RouteResult, o: RouteOpts): boolean {
  if (strategy === 'short') return r.length + r.vias * o.viaCost < best.length + best.vias * o.viaCost;
  return r.vias < best.vias || (r.vias === best.vias && r.length < best.length);
}

/** Одна связь: прямой путь, обратный (эвристика не симметрична), затем ветка к стволу. */
function tryPair(run: Run, ctx: Ctx, net: Net, o: RouteOpts, a: RouteEnd, b: RouteEnd): RouteResult | null {
  const go = (from: RouteEnd, to: RouteEnd): RouteResult =>
    autoroute(run.entities, ctx.doc.w, ctx.doc.h, from, to, o, net.pads);
  const done = (r: RouteResult): boolean => r.ok && r.drc === 0;
  let r = go(a, b);
  if (!done(r)) r = go(b, a);
  if (done(r)) return r;
  if (!b.entId) return null;
  const root = run.comp.get(b.entId);
  if (!root) return null;
  for (const to of trunkEnds(run.entities, o, run.comp, root, a, b.entId, 3)) {
    const t = go(a, to);
    if (done(t)) return t;
    const rev = go(to, a);
    if (done(rev)) return rev;
  }
  return null;
}

/** Подходящая связь из списка: перебор ограничен, ранний выход по «нулю переходов». */
function bestPlan(run: Run, ctx: Ctx, net: Net, o: RouteOpts, pairs: PairCand[]): RouteResult | null {
  let best: RouteResult | null = null;
  const limit = o.allowVias === false ? 24 : 6;
  for (const { a, b } of pairs.slice(0, limit)) {
    const plan = tryPair(run, ctx, net, o, a, b);
    if (plan && (!best || better(ctx.strategy, plan, best, o))) best = plan;
    if (best && best.vias === 0) break;
  }
  return best;
}

/** Принять проложенную трассу: проверить, что нет замыканий и появилась новая связь. */
function applyPlan(run: Run, ctx: Ctx, net: Net, r: RouteResult): boolean {
  const nextEntities = [...run.entities, ...r.ents];
  const nextComp = copperComponents(nextEntities);
  if (netConflicts(ctx.nets, nextComp).length) return false;
  if (netMissing(net, nextComp) >= netMissing(net, run.comp)) return false;
  run.entities = nextEntities;
  run.comp = nextComp;
  for (const e of r.ents) { run.added.push(e); run.owner.set(e.id, net.id); }
  return true;
}

/** Задевает ли новая трасса чужую медь так, что её надо снять (ближе зазора). */
function touches(ents: Entity[], b: Entity, o: RouteOpts): boolean {
  const sa = ents.flatMap(copperShapes);
  const sb = copperShapes(b);
  for (const x of sa) for (const y of sb) {
    if (!x.layers.some((l) => y.layers.includes(l))) continue;
    const need = x.drilled || y.drilled ? (o.holeClear ?? o.clearance) : o.clearance;
    if (x.bb[0] - need > y.bb[2] || x.bb[2] + need < y.bb[0] ||
      x.bb[1] - need > y.bb[3] || x.bb[3] + need < y.bb[1]) continue;
    if (shapeShapeDist(x, y) < need - 1e-6) return true;
  }
  return false;
}

const MAX_RIPS = 6;      // снятий меди прогона на одну попытку
const MAX_VISITS = 3;    // сколько раз группу можно пересобрать за проход

/**
 * Снять чужую медь, проложенную ЭТИМ ЖЕ прогоном, и проложить связь заново;
 * задетые группы возвращаются в очередь на досвязывание. Медь пользователя и
 * дорожки прошлых запусков не снимаются никогда.
 *
 * Группа, которую в этом проходе уже перекладывали, сама чужую медь не снимает:
 * иначе два встречных обхода снимали бы дорожки друг у друга по кругу.
 */
function tryRipUp(run: Run, ctx: Ctx, net: Net, o: RouteOpts, pairs: PairCand[], requeue: (id: string) => void): boolean {
  if (!ctx.rips || run.rips >= MAX_RIPS || run.locked.has(net.id)) return false;
  const foreign = run.added.filter((e) => run.owner.get(e.id) !== net.id);
  if (!foreign.length) return false;
  const drop = new Set(foreign.map((e) => e.id));
  const kept = run.entities.filter((e) => !drop.has(e.id));
  for (const { a, b } of pairs.slice(0, 3)) {
    const r = autoroute(kept, ctx.doc.w, ctx.doc.h, a, b, { ...o, allowVias: true }, net.pads);
    if (!r.ok || r.drc !== 0) continue;
    const hit = foreign.filter((e) => touches(r.ents, e, o));
    if (!hit.length || hit.length > 6) continue;   // слишком много снимать — не трогаем
    const hitIds = new Set(hit.map((e) => e.id));
    const candidate = [...kept.filter((e) => !hitIds.has(e.id)), ...r.ents];
    const comp = copperComponents(candidate);
    if (netConflicts(ctx.nets, comp).length) continue;
    if (netMissing(net, comp) >= netMissing(net, run.comp)) continue;
    const owners = new Set(hit.map((e) => run.owner.get(e.id)).filter((id): id is string => !!id));
    ctx.progress(`перекладка: снимаю ${hit.length} дорожек и веду «${net.name}» заново`);
    run.entities = candidate;
    run.comp = comp;
    run.added = [...run.added.filter((e) => !hitIds.has(e.id)), ...r.ents];
    for (const id of hitIds) run.owner.delete(id);
    for (const e of r.ents) run.owner.set(e.id, net.id);
    run.rips += hit.length;
    for (const id of owners) if (id !== net.id) { run.locked.add(id); requeue(id); }
    return true;
  }
  return false;
}

/** Досвязать одну группу: связи, ветки к стволам, при неудаче — перекладка чужой меди прогона. */
function connectNet(run: Run, ctx: Ctx, net: Net, o: RouteOpts, ends: Map<string, RouteEnd>, requeue: (id: string) => void): void {
  const w = o.trackW.toFixed(2);
  ctx.progress(`${net.name} · дорожка ${w} мм · зазор ${o.clearance.toFixed(2)} мм${o.allowVias === false ? '' : ' · с переходами'}`);
  let guard = 0;
  while (netMissing(net, run.comp) > 0 && guard++ < 40) {
    const pairs = pairCandidates(net, run.comp, ends, ctx.strategy);
    if (!pairs.length) break;
    const plan = bestPlan(run, ctx, net, o, pairs);
    if (plan && applyPlan(run, ctx, net, plan)) continue;
    if (tryRipUp(run, ctx, net, o, pairs, requeue)) continue;
    break;
  }
}

/** Один порядок групп: проход без переходов, затем проход с обходами. */
function attempt(ctx: Ctx, order: Net[], initial: Map<string, string>, ends: Map<string, RouteEnd>): Run {
  const run: Run = { entities: [...ctx.doc.entities], added: [], owner: new Map(), comp: initial, rips: 0, locked: new Set() };
  const byId = new Map(order.map((n) => [n.id, n]));
  // Проход «с переходами» нужен, только если хотя бы одной группе разрешён верх.
  const anyTop = order.some((n) => netRouteOpts(n, ctx.opts).allowTop);
  const passes: boolean[] = ctx.opts.allowTop && ctx.opts.allowVias !== false && anyTop
    ? (ctx.strategy === 'short' ? [true] : [false, true])
    : [false];
  for (const allowVias of passes) {
    run.locked = new Set();   // в новом проходе переложенным группам снова можно снимать медь
    const start = snapshot(run);
    const queue: string[] = order.map((n) => n.id);
    const visits = new Map<string, number>();
    let guard = 0;
    while (queue.length && guard++ < 200) {
      const id = queue.shift()!;
      const net = byId.get(id);
      if (!net) continue;
      visits.set(id, (visits.get(id) ?? 0) + 1);
      const o = netRouteOpts(net, ctx.opts);
      // личное правило группы может запретить верхний слой: тогда переходы не нужны
      const oo: RouteOpts = { ...o, allowVias: allowVias && o.allowTop };
      connectNet(run, ctx, net, oo, ends, (back) => {
        if ((visits.get(back) ?? 0) < MAX_VISITS) queue.push(back);
      });
    }
    // Разрывы допустимы только если связи удалось восстановить: иначе проход откатывается.
    if (totalMissing(ctx.nets, run.comp) > totalMissing(ctx.nets, start.comp)) restore(run, start);
  }
  return run;
}

export function routeNets(doc: Doc, opts: RouteOpts, progress: (text: string) => void = () => {}, strategy?: RouteStrategy, flags: NetRouteFlags = {}): NetRouteResult {
  const empty = (): NetRouteResult => ({ ents: [], vias: 0, length: 0, missing: 0, unresolved: [], errors: [], attempts: 0, rips: 0 });
  const nets = (doc.nets ?? []).map((n) => ({ ...n, pads: [...new Set(n.pads)] }));
  const flat = expandDoc(doc.entities);
  const ends = new Map<string, RouteEnd>();
  for (const e of flat) {
    const end = endpointOf(e);
    if (end) ends.set(e.id, end);
  }
  const errors: string[] = [];
  if (!nets.length) errors.push('Создайте хотя бы одну группу площадок.');
  for (const n of nets) {
    if (n.pads.length < 2) errors.push(`В группе «${n.name}» нужно минимум две площадки.`);
    for (const id of n.pads) if (!ends.has(id)) errors.push(`В группе «${n.name}» отсутствует площадка ${id}. Удалите её из группы или восстановите элемент.`);
  }
  const initial = copperComponents(doc.entities);
  errors.push(...netConflicts(nets, initial));
  if (errors.length) return { ...empty(), errors };

  const span = (n: Net) => {
    const ps = n.pads.map((id) => ends.get(id)!);
    return Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x)) + Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y));
  };
  // Сначала самые широкие дорожки: им труднее найти проход между чужой медью.
  // При одинаковой ширине порядок тот же, что раньше — по размаху группы.
  const width = new Map(nets.map((n) => [n.id, netRouteOpts(n, opts).trackW]));
  const base = [...nets].sort((a, b) => (width.get(b.id)! - width.get(a.id)!) || (span(a) - span(b)));
  const orders = strategy
    ? [strategy === 'long-first' ? [...base].reverse() : base]
    : [base, [...base].reverse(), [...base.slice(1), base[0]]];
  // Переходы в пакетном режиме сильно «дороже» длины: сначала на слоях контактов,
  // без переходов. Стратегия «короче дорожки» равноправна слоям. Зазор — самый
  // строгий из настроек и правил групп: одна группа не «подлезает» под чужое правило.
  const strictClear = Math.max(opts.clearance, ...nets.map((n) => num(n.rules?.clear, 0.05, 3) ?? 0));
  const tuned: RouteOpts = {
    ...opts,
    clearance: strictClear,
    ...(strategy === 'short' ? { topMul: 1 } : { viaCost: Math.max(opts.viaCost, (doc.w + doc.h) * 2) }),
  };
  const ctx: Ctx = { doc, nets, opts: tuned, strategy, progress, rips: flags.rips !== false };
  const seen = new Set<string>();
  let best: NetRouteResult | null = null;
  let attempts = 0;
  for (const order of orders) {
    const key = order.map((n) => n.id).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    attempts++;
    const local: Ctx = { ...ctx, progress: (text) => progress(`Вариант ${attempts}/${orders.length} · ${text}`) };
    const run = attempt(local, order, initial, ends);
    const ents = run.added;
    const vias = ents.reduce((n, e) => n + (e.kind === 'via' ? 1 : 0), 0);
    const length = ents.reduce((s, e) => s + (e.kind === 'track' ? trackLen(e) : 0), 0);
    const unresolved = nets.map((n) => ({ name: n.name, missing: netMissing(n, run.comp) })).filter((n) => n.missing > 0);
    const result: NetRouteResult = {
      ents, vias, length, rips: run.rips,
      unresolved, missing: unresolved.reduce((sum, n) => sum + n.missing, 0), errors: [], attempts: 0,
    };
    if (!best || betterResult(result, best)) best = result;
    // Ноль переходов и все цепи связаны: улучшать главный критерий уже некуда.
    if (best.missing === 0 && best.vias === 0) break;
  }
  return { ...best!, attempts };
}

/** Compare geometry, not random entity IDs or traversal direction. */
export function routeGeometryKey(entities: Entity[]): string {
  const point = (x: number, y: number) => `${x.toFixed(5)},${y.toFixed(5)}`;
  return entities.map((e) => {
    if (e.kind === 'track') {
      const ps = e.pts.map((p) => point(p.x, p.y));
      return `track:${e.layer}:${e.w}:${[ps.join(';'), ps.reverse().join(';')].sort()[0]}`;
    }
    if (e.kind === 'via') return `via:${point(e.x, e.y)}:${e.size}:${e.drill}`;
    const { id, ...geometry } = e;
    return JSON.stringify(geometry);
  }).sort().join('|');
}

/** Each strategy starts from the same untouched board; only the user's choice is applied. */
export function routeNetVariants(doc: Doc, opts: RouteOpts, progress: (text: string) => void = () => {}): NetRouteVariants {
  const profiles: Pick<NetRouteVariant, 'strategy' | 'title' | 'description'>[] = [
    { strategy: 'few-vias', title: 'Меньше переходов', description: 'Сначала короткие связи без переходов, затем обходы. Удобнее для пайки.' },
    { strategy: 'short', title: 'Короче дорожки', description: 'Оба разрешённых слоя равноправны; переходы допустимы сразу. Приоритет длине.' },
    { strategy: 'long-first', title: 'Длинные связи первыми', description: 'Сначала резервирует пути для протяжённых цепей и ветвей, затем соединяет короткие.' },
  ];
  const variants: NetRouteVariant[] = [];
  const keys: string[] = [];
  for (const [i, profile] of profiles.entries()) {
    progress(`Вариант ${i + 1}/3 · ${profile.title}`);
    const r = routeNets(doc, opts, (text) => progress(`Вариант ${i + 1}/3 · ${profile.title} · ${text.replace(/^Вариант \d+\/\d+ · /, '')}`), profile.strategy);
    if (r.errors.length) return { variants: [], errors: r.errors };
    const key = routeGeometryKey(r.ents);
    const sameAs = keys.indexOf(key);
    variants.push({ ...r, ...profile, ...(sameAs >= 0 ? { sameAs } : {}) });
    keys.push(key);
  }
  return { variants, errors: [] };
}
