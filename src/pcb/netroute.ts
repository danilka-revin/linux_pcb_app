// Пакетная трассировка заданных пользователем электрических цепей.
// Эвристика: несколько порядков цепей, сначала все связи без переходов,
// затем двухслойные обходы. Критерий: недостающие связи → переходы → длина.
import type { Doc, Entity, Net } from './model';
import { expandDoc } from './expand';
import { autoroute, copperShapes, endpointOf, netOf, type RouteEnd, type RouteOpts, type RouteResult } from './autoroute';

export interface NetRouteResult {
  ents: Entity[];
  vias: number;
  length: number;
  missing: number;
  unresolved: { name: string; missing: number }[];
  errors: string[];
  attempts: number;
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

export function routeNets(doc: Doc, opts: RouteOpts, progress: (text: string) => void = () => {}): NetRouteResult {
  const empty = (): NetRouteResult => ({ ents: [], vias: 0, length: 0, missing: 0, unresolved: [], errors: [], attempts: 0 });
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
  const sorted = [...nets].sort((a, b) => span(a) - span(b));
  const orders = [sorted, [...sorted].reverse(), [...nets.slice(1), nets[0]]];
  const seen = new Set<string>();
  let best: NetRouteResult | null = null;
  let attempts = 0;
  for (const order of orders) {
    const key = order.map((n) => n.id).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    attempts++;
    const result = empty();
    let entities = [...doc.entities];
    let comp = initial;
    // Приоритет пайки снизу обязателен в пакетном режиме.
    const o = { ...opts, bottomEntry: true, viaCost: Math.max(opts.viaCost, (doc.w + doc.h) * 2) };
    for (const allowTop of opts.allowTop ? [false, true] : [false]) {
      for (const net of order) {
        while (netMissing(net, comp) > 0) {
          progress(`Вариант ${attempts}/${orders.length} · ${allowTop ? 'обходы через верх' : 'нижний слой'} · ${net.name}`);
          const pairs: { a: RouteEnd; b: RouteEnd; d: number }[] = [];
          for (let i = 0; i < net.pads.length; i++) for (let j = i + 1; j < net.pads.length; j++) {
            if (comp.get(net.pads[i]) === comp.get(net.pads[j])) continue;
            const a = ends.get(net.pads[i])!, b = ends.get(net.pads[j])!;
            pairs.push({ a, b, d: Math.hypot(a.x - b.x, a.y - b.y) });
          }
          pairs.sort((a, b) => a.d - b.d);
          let chosen: RouteResult | null = null;
          // Ограниченный перебор альтернатив для большой цепи: это эвристика, не полный поиск.
          for (const { a, b } of pairs.slice(0, allowTop ? 6 : 24)) {
            const r = autoroute(entities, doc.w, doc.h, a, b, { ...o, allowTop }, net.pads);
            if (!r.ok || r.drc !== 0) continue;
            if (!chosen || r.vias < chosen.vias || (r.vias === chosen.vias && r.length < chosen.length)) chosen = r;
            if (r.vias === 0) break;
          }
          if (!chosen) break;
          const nextEntities = [...entities, ...chosen.ents];
          const nextComp = copperComponents(nextEntities);
          // Защита от короткого замыкания и ложного успеха (геометрическая связность).
          if (netConflicts(nets, nextComp).length || netMissing(net, nextComp) >= netMissing(net, comp)) break;
          entities = nextEntities;
          comp = nextComp;
          result.ents.push(...chosen.ents);
          result.length += chosen.length;
          result.vias += chosen.vias;
        }
      }
    }
    result.unresolved = nets.map((n) => ({ name: n.name, missing: netMissing(n, comp) })).filter((n) => n.missing > 0);
    result.missing = result.unresolved.reduce((sum, n) => sum + n.missing, 0);
    if (!best || result.missing < best.missing || (result.missing === best.missing && (result.vias < best.vias || (result.vias === best.vias && result.length < best.length)))) best = result;
    // Ноль переходов и все цепи связаны: улучшать главный критерий уже некуда.
    if (best.missing === 0 && best.vias === 0) break;
  }
  return { ...best!, attempts };
}
