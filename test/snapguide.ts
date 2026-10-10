// Привязки к объектам: пересечения, типы точек, направляющие выравнивания.
import assert from 'node:assert/strict';
import {
  alignSnap, collectIntersections, collectSnapTagged, nearestSnap, selBBox,
} from '../src/pcb/snapguide';
import type { Entity, LineE, Track } from '../src/pcb/model';

const line = (id: string, x1: number, y1: number, x2: number, y2: number): LineE =>
  ({ id, kind: 'line', x1, y1, x2, y2, w: 0.2, layer: 's1' });
const track = (id: string, pts: [number, number][], layer: 'k1' | 'k2' = 'k1'): Track =>
  ({ id, kind: 'track', pts: pts.map(([x, y]) => ({ x, y })), w: 0.3, layer });

// ------------------------------------------------------------- пересечения
{
  // крест из двух линий
  const ents: Entity[] = [line('a', 0, 5, 10, 5), line('b', 5, 0, 5, 10)];
  const xs = collectIntersections(ents);
  assert.equal(xs.length, 1, 'две пересекающиеся линии — одно пересечение');
  assert(Math.abs(xs[0].x - 5) < 1e-6 && Math.abs(xs[0].y - 5) < 1e-6, 'точка в центре креста');
}
{
  // соседние сегменты одной ломаной общей вершиной не считаются пересечением
  const ents: Entity[] = [track('t', [[0, 0], [5, 0], [5, 5]])];
  assert.equal(collectIntersections(ents).length, 0, 'общая вершина — не пересечение');
}
{
  // параллельные линии не пересекаются
  const ents: Entity[] = [line('a', 0, 0, 10, 0), line('b', 0, 5, 10, 5)];
  assert.equal(collectIntersections(ents).length, 0);
}
{
  // T-образное: конец одной линии лежит на другой
  const ents: Entity[] = [line('a', 0, 0, 10, 0), line('b', 5, 0, 5, 8)];
  assert.equal(collectIntersections(ents).length, 1, 'T-пересечение найдено');
}

// ------------------------------------------------- характерные точки и типы
{
  const ents: Entity[] = [
    track('t', [[0, 0], [10, 0]]),
    line('l', 0, 5, 10, 5),
    { id: 'p', kind: 'pad', x: 3, y: 3, shape: 'round', size: 2, drill: 1 },
  ];
  const pts = collectSnapTagged(ents, false);
  const kinds = new Set(pts.map((p) => p.kind));
  assert(kinds.has('end'), 'концы есть');
  assert(kinds.has('mid'), 'середины есть');
  assert(kinds.has('center'), 'центры есть');
  assert(!kinds.has('cross'), 'пересечения выключены флагом');

  const withCross = collectSnapTagged(
    [line('a', 0, 5, 10, 5), line('b', 5, 0, 5, 10)],
    true,
  );
  assert(withCross.some((p) => p.kind === 'cross'), 'пересечения добавлены');
}

// ------------------------------------------------------------- nearestSnap
{
  const pts = collectSnapTagged([track('t', [[0, 0], [10, 0]])], false);
  const hit = nearestSnap(pts, { x: 0.1, y: 0.1 }, 1);
  assert(hit && hit.kind === 'end', 'ближе к концу — «конец»');
  const mid = nearestSnap(pts, { x: 5.1, y: -0.1 }, 1);
  assert(mid && mid.kind === 'mid', 'ближе к середине — «середина»');
  assert.equal(nearestSnap(pts, { x: 50, y: 50 }, 1), null, 'далеко — null');
  assert.equal(nearestSnap(null, { x: 0, y: 0 }, 1), null, 'нет точек — null');
}

// ------------------------------------------------- направляющие выравнивания
{
  // выделение (0..10, 0..10) тянется вправо; сосед имеет правый край на x=25
  const box: [number, number, number, number] = [0, 0, 10, 10];
  const statics = [{ x: 25, y: 100 }];
  // без сдвига правый край выделения (10+14.7) близко к 25? — возьмём точный сдвиг мимо
  const res = alignSnap(box, 14.7, 0, statics, 1);
  assert(Math.abs(res.dx - 15) < 1e-9, `край прилипает к соседу: dx=${res.dx}`);
  assert(res.guides.some((g) => g.axis === 'x' && Math.abs(g.at - 25) < 1e-9), 'есть направляющая по X');
}
{
  // центр выделения выравнивается по Y с чужим центром
  const box: [number, number, number, number] = [0, 0, 10, 10];
  const res = alignSnap(box, 0, 24.8, [{ x: 0, y: 35.2 }], 1);
  assert(Math.abs(res.dy - 25.2) < 1e-9, `центр по Y прилипает: dy=${res.dy}`);
}
{
  // далеко от всего — сдвиг не меняется
  const box: [number, number, number, number] = [0, 0, 10, 10];
  const res = alignSnap(box, 3, 4, [{ x: 100, y: 100 }], 1);
  assert.equal(res.dx, 3);
  assert.equal(res.dy, 4);
  assert.equal(res.guides.length, 0, 'без совпадений — без направляющих');
}
{
  // пустые соседи и нулевой допуск — безопасный выход
  const box: [number, number, number, number] = [0, 0, 1, 1];
  assert.equal(alignSnap(box, 5, 5, [], 1).dx, 5);
  assert.equal(alignSnap(box, 5, 5, [{ x: 0, y: 0 }], 0).dx, 5);
}

// ------------------------------------------------------------------ selBBox
{
  const ents: Entity[] = [line('a', 0, 0, 10, 0), line('b', 0, 5, 4, 9)];
  const b = selBBox(ents, new Set(['a', 'b']));
  assert(b && b[0] <= 0 && b[2] >= 10 && b[3] >= 9, 'габарит выделения');
  assert.equal(selBBox(ents, new Set()), null, 'пустое выделение — null');
}

console.log('snapguide: ok');
