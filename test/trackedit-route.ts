// Узлы работают с автотрассировкой: дорожки, проложенные роутером, — обычные
// Track-примитивы, их можно гнуть узлами, резать и паять обратно.
import assert from 'node:assert/strict';
import * as M from '../src/pcb/model';
import { autoroute, pickEndpoint, type RouteOpts } from '../src/pcb/autoroute';
import { copperComponents, netMissing, routeNets } from '../src/pcb/netroute';
import {
  deleteNode, insertNode, joinTrackPts, pickSolderPair, splitTrackAt, trackEndsNear,
} from '../src/pcb/trackedit';

const O: RouteOpts = {
  trackW: 0.6, clearance: 0.3, holeClear: 0.6, viaSize: 1.6, viaDrill: 0.7,
  step: 0.635, viaCost: 6, topMul: 1.6, allowTop: true, angle: '45',
};
const pad = (id: string, x: number, y: number): M.Pad =>
  ({ id, kind: 'pad', x, y, size: 1.9, drill: 0.9, shape: 'round' });

const xy = (pts: { x: number; y: number }[]): [number, number][] =>
  pts.map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]);

/** Примитивы дорожки пригодны для правки узлами: вставка и удаление узла обратимы. */
function checkNodeRoundTrip(t: M.Track): void {
  assert.ok(t.pts.length >= 2, 'routed track has points');
  // самое длинное звено — вставляем узел в его середину
  let seg = 0, best = -1;
  for (let i = 0; i < t.pts.length - 1; i++) {
    const d = Math.hypot(t.pts[i + 1].x - t.pts[i].x, t.pts[i + 1].y - t.pts[i].y);
    if (d > best) { best = d; seg = i; }
  }
  const mid = { x: (t.pts[seg].x + t.pts[seg + 1].x) / 2, y: (t.pts[seg].y + t.pts[seg + 1].y) / 2 };
  const ins = insertNode(t.pts, seg, mid);
  assert.equal(ins.pts.length, t.pts.length + 1, 'node inserted');
  assert.deepEqual(deleteNode(ins.pts, ins.idx, false), t.pts, 'node delete restores track');
}

/**
 * Разрыв с обратной пайкой: разрезаем посередине самого длинного звена,
 * паяем концы — крайние точки и слой на месте.
 */
function checkCutSolderRoundTrip(t: M.Track, gap: number): boolean {
  let seg = 0, best = -1;
  for (let i = 0; i < t.pts.length - 1; i++) {
    const d = Math.hypot(t.pts[i + 1].x - t.pts[i].x, t.pts[i + 1].y - t.pts[i].y);
    if (d > best) { best = d; seg = i; }
  }
  if (best < gap + 0.5) return false; // слишком короткое звено — нечего резать
  const click = { x: (t.pts[seg].x + t.pts[seg + 1].x) / 2, y: (t.pts[seg].y + t.pts[seg + 1].y) / 2 };
  const parts = splitTrackAt(t, click, gap);
  assert.ok(parts?.left && parts.right, 'cut splits track in two');
  const left: M.Track = { ...t, id: 'cut-L', pts: parts.left };
  const right: M.Track = { ...t, id: 'cut-R', pts: parts.right };
  const pair = pickSolderPair(trackEndsNear([left, right], click, Math.max(3, gap)));
  assert.ok(pair, 'solder finds both cut ends');
  const back = joinTrackPts(pair[0].ent, pair[0].end, pair[1].ent, pair[1].end);
  // порядок точек может развернуться — важно множество концов
  const byXY = (p: [number, number], q: [number, number]) => p[0] - q[0] || p[1] - q[1];
  assert.deepEqual(
    xy([back[0], back[back.length - 1]]).sort(byXY),
    xy([t.pts[0], t.pts[t.pts.length - 1]]).sort(byXY),
    'solder restores endpoints',
  );
  return true;
}

// 1) связь двух точек: вставленный/удалённый узел не рвёт цепь,
//    а разрезанная и запаянная дорожка соединяет те же площадки.
{
  const doc = M.newBoard(60, 40);
  doc.entities.push(pad('a', 10, 20), pad('b', 50, 20));
  const A = pickEndpoint(doc.entities, { x: 10.2, y: 20 }, 0.3)!;
  const B = pickEndpoint(doc.entities, { x: 50, y: 20.1 }, 0.3)!;
  const r = autoroute(doc.entities, doc.w, doc.h, A, B, O);
  assert.ok(r.ok, 'pair routed: ' + r.msg);
  const tracks = r.ents.filter((e): e is M.Track => e.kind === 'track');
  assert.ok(tracks.length > 0, 'router produced tracks');
  let soldered = 0;
  for (const t of tracks) {
    checkNodeRoundTrip(t);
    // правка «вставка + удаление» — геометрический ноль: цепь цела
    const comp = copperComponents([...doc.entities, ...r.ents]);
    assert.equal(comp.get('a'), comp.get('b'), 'pads stay connected');
    if (checkCutSolderRoundTrip(t, 2)) soldered++;
  }
  assert.ok(soldered > 0, 'at least one routed track cut and soldered back');
}

// 2) разводка групп: все проложенные дорожки правятся узлами,
//    разрыв+пайка не разрывают ни одну группу.
{
  const d = M.newBoard(50, 40);
  d.entities.push(
    pad('a', 7, 8), pad('b', 25, 8), pad('c', 38, 16),
    pad('d', 8, 30), pad('e', 25, 30), pad('f', 40, 30),
  );
  d.nets = [
    { id: 'signal', name: 'signal', pads: ['a', 'b', 'c'] },
    { id: 'ground', name: 'ground', pads: ['d', 'e', 'f'] },
  ];
  const r = routeNets(M.cloneDoc(d), O);
  assert.deepEqual(r.errors, []);
  assert.equal(r.missing, 0);
  const tracks = r.ents.filter((e): e is M.Track => e.kind === 'track');
  assert.ok(tracks.length > 0, 'nets routing produced tracks');
  let soldered = 0;
  for (const t of tracks) {
    checkNodeRoundTrip(t);
    if (!checkCutSolderRoundTrip(t, 1.5)) continue;
    soldered++;
    // та же операция на живой плате: заменить дорожку на «разрезанную и запаянную»
    const seg = (() => {
      let s = 0, best = -1;
      for (let i = 0; i < t.pts.length - 1; i++) {
        const dd = Math.hypot(t.pts[i + 1].x - t.pts[i].x, t.pts[i + 1].y - t.pts[i].y);
        if (dd > best) { best = dd; s = i; }
      }
      return s;
    })();
    const click = { x: (t.pts[seg].x + t.pts[seg + 1].x) / 2, y: (t.pts[seg].y + t.pts[seg + 1].y) / 2 };
    const parts = splitTrackAt(t, click, 1.5)!;
    const left: M.Track = { ...t, id: M.uid(), pts: parts.left! };
    const right: M.Track = { ...t, id: M.uid(), pts: parts.right! };
    const pair = pickSolderPair(trackEndsNear([left, right], click, 3))!;
    const joined: M.Track = { ...t, id: M.uid(), pts: joinTrackPts(pair[0].ent, pair[0].end, pair[1].ent, pair[1].end) };
    const live = [...d.entities, ...r.ents.filter((e) => e.id !== t.id), joined];
    for (const n of d.nets) assert.equal(netMissing(n, copperComponents(live)), 0, `${n.name} stays connected after cut+solder`);
  }
  assert.ok(soldered > 0, 'at least one net track cut and soldered back');
}

console.log('Track edit x autoroute: routed tracks accept nodes, cut and solder OK');
