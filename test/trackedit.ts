// Тесты правки дорожек: узлы, разрыв под амперметр и пайка.
import assert from 'node:assert/strict';
import type { Entity, Track } from '../src/pcb/model';
import {
  deleteNode, insertNode, joinTrackPts, nearestOnPts, pickSolderPair,
  splitTrackAt, trackEndsNear,
} from '../src/pcb/trackedit';

const tr = (pts: [number, number][], layer: 'k1' | 'k2' = 'k1', w = 0.6): Track => ({
  id: `t${Math.random()}`, kind: 'track', pts: pts.map(([x, y]) => ({ x, y })), w, layer,
});
const xy = (pts: { x: number; y: number }[]): [number, number][] =>
  pts.map((p) => [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6]);

// --- nearestOnPts: середина, конец, замкнутая ломаная ---
{
  const n = nearestOnPts([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 4, y: 3 });
  assert.ok(n);
  assert.equal(n.seg, 0);
  assert.ok(Math.abs(n.t - 0.4) < 1e-9);
  assert.deepEqual(xy([n.pt]), [[4, 0]]);
  assert.ok(Math.abs(n.dist - 3) < 1e-9);
  // проекция за концом отрезка — прилипает к концу
  const e = nearestOnPts([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 14, y: 0 });
  assert.ok(e && e.t === 1 && e.dist === 4);
  // замкнутая: ребро «последняя → первая» участвует
  const c = nearestOnPts(
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    { x: -2, y: 5 }, true,
  );
  assert.ok(c);
  assert.equal(c.seg, 3);
  assert.deepEqual(xy([c.pt]), [[0, 5]]);
  assert.equal(nearestOnPts([{ x: 0, y: 0 }], { x: 1, y: 1 }), null);
}

// --- insertNode / deleteNode ---
{
  const base = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const ins = insertNode(base, 0, { x: 4, y: 0 });
  assert.deepEqual(xy(ins.pts), [[0, 0], [4, 0], [10, 0]]);
  assert.equal(ins.idx, 1);
  assert.equal(base.length, 2); // исходник не мутирует
  // рядом с существующим узлом — вернуть его, а не плодить
  const dup = insertNode(ins.pts, 0, { x: 4, y: 0 });
  assert.deepEqual(xy(dup.pts), [[0, 0], [4, 0], [10, 0]]);
  assert.equal(dup.idx, 1);

  assert.deepEqual(xy(deleteNode(ins.pts, 1, false)!), [[0, 0], [10, 0]]);
  assert.equal(deleteNode(base, 0, false), null); // у дорожки минимум 2 узла
  assert.equal(deleteNode(ins.pts, 0, true), null); // у полигона минимум 3
  assert.deepEqual(
    xy(deleteNode([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }], 2, true)!),
    [[0, 0], [5, 0], [0, 5]],
  );
  assert.equal(deleteNode(ins.pts, 9, false), null);
}

// --- splitTrackAt: ровный рез посередине ---
{
  const parts = splitTrackAt(tr([[0, 0], [10, 0]]), { x: 5, y: 0.1 }, 2)!;
  assert.deepEqual(xy(parts.left!), [[0, 0], [4, 0]]);
  assert.deepEqual(xy(parts.right!), [[6, 0], [10, 0]]);
}
// --- рез на изгибе: длина отмеряется вдоль ломаной, а не по прямой ---
{
  const parts = splitTrackAt(tr([[0, 0], [10, 0], [10, 10]]), { x: 10, y: 0 }, 4)!;
  assert.deepEqual(xy(parts.left!), [[0, 0], [8, 0]]);
  assert.deepEqual(xy(parts.right!), [[10, 2], [10, 10]]);
}
// --- рез у края укорачивает дорожку с одной стороны ---
{
  const parts = splitTrackAt(tr([[0, 0], [10, 0]]), { x: 0.5, y: 0 }, 2)!;
  assert.equal(parts.left, null);
  assert.deepEqual(xy(parts.right!), [[1.5, 0], [10, 0]]);
}
// --- дорожка короче зазора — резать нечего ---
{
  assert.equal(splitTrackAt(tr([[0, 0], [1, 0]]), { x: 0.5, y: 0 }, 2), null);
  assert.equal(splitTrackAt(tr([[0, 0], [1, 0]]), { x: 0.5, y: 0 }, 0), null);
  const one: Track = { id: 'x', kind: 'track', pts: [{ x: 0, y: 0 }], w: 0.5, layer: 'k1' };
  assert.equal(splitTrackAt(one, { x: 0, y: 0 }, 1), null);
}
// --- рез ровно по узлу не плодит дубликаты точек ---
{
  const parts = splitTrackAt(tr([[0, 0], [5, 0], [10, 0]]), { x: 5, y: 0 }, 2)!;
  assert.deepEqual(xy(parts.left!), [[0, 0], [4, 0]]);
  assert.deepEqual(xy(parts.right!), [[6, 0], [10, 0]]);
}

// --- trackEndsNear + pickSolderPair ---
{
  const a = tr([[0, 0], [4, 0]]); a.id = 'a';
  const b = tr([[6, 0], [10, 0]]); b.id = 'b';
  const c = tr([[20, 0], [30, 0]], 'k2'); c.id = 'c';
  const ents: Entity[] = [a, b, c];
  const ends = trackEndsNear(ents, { x: 5, y: 0 }, 3);
  assert.equal(ends.length, 2);
  // ближайшие первые
  assert.ok(Math.hypot(ends[0].pt.x - 5, ends[0].pt.y) <= Math.hypot(ends[1].pt.x - 5, ends[1].pt.y));
  const pair = pickSolderPair(ends)!;
  assert.deepEqual([pair[0].ent.id, pair[1].ent.id].sort(), ['a', 'b']);
  // дальние концы вне радиуса
  assert.equal(trackEndsNear(ents, { x: 5, y: 0 }, 0.5).length, 0);
  // концы одной дорожки парой не считаются
  assert.equal(pickSolderPair(trackEndsNear([a], { x: 2, y: 0 }, 9)), null);
  // разные слои не паяются
  const d = tr([[4.5, 0], [8, 0]], 'k2'); d.id = 'd';
  assert.equal(pickSolderPair(trackEndsNear([a, d], { x: 4.2, y: 0 }, 3)), null);
}

// --- joinTrackPts: все четыре ориентации дают непрерывную ломаную ---
{
  const a = tr([[0, 0], [4, 0]]); a.id = 'a';
  const b = tr([[6, 0], [10, 0]]); b.id = 'b';
  assert.deepEqual(xy(joinTrackPts(a, 1, b, 0)), [[0, 0], [4, 0], [6, 0], [10, 0]]);
  assert.deepEqual(xy(joinTrackPts(a, 0, b, 1)), [[4, 0], [0, 0], [10, 0], [6, 0]]);
  assert.deepEqual(xy(joinTrackPts(a, 1, b, 1)), [[0, 0], [4, 0], [10, 0], [6, 0]]);
  assert.deepEqual(xy(joinTrackPts(a, 0, b, 0)), [[4, 0], [0, 0], [6, 0], [10, 0]]);
  // стык встык без дубликата точки соединения
  const e = tr([[0, 0], [5, 0]]); e.id = 'e';
  const f = tr([[5, 0], [10, 0]]); f.id = 'f';
  assert.deepEqual(xy(joinTrackPts(e, 1, f, 0)), [[0, 0], [5, 0], [10, 0]]);
}

// --- разрыв + пайка туда-обратно: геометрия восстанавливается ---
{
  const src = tr([[0, 0], [10, 0], [10, 6]]);
  const parts = splitTrackAt(src, { x: 10, y: 1 }, 2)!;
  assert.ok(parts.left && parts.right);
  const left: Track = { ...src, id: 'l', pts: parts.left };
  const right: Track = { ...src, id: 'r', pts: parts.right };
  const pair = pickSolderPair(trackEndsNear([left, right], { x: 10, y: 1 }, 3))!;
  const back = joinTrackPts(pair[0].ent, pair[0].end, pair[1].ent, pair[1].end);
  // перемычка перекрывает зазор, концы на месте, длина меди восстановлена
  assert.deepEqual(xy([back[0], back[back.length - 1]]), [[0, 0], [10, 6]]);
  const len = (pts: { x: number; y: number }[]) =>
    pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);
  assert.ok(Math.abs(len(back) - len(src.pts)) < 1e-6);
}

console.log('Track edit: nodes, cut gap and solder OK');
