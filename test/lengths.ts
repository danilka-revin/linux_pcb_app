// Длины цепей, шины выравнивания и змейки (meander).
import assert from 'node:assert/strict';
import { busSummaries, alignBus, lengthenNet, netLengths, LENGTH_TOLERANCE, type MeanderOpts } from '../src/pcb/lengths';
import { copperComponents, netMissing } from '../src/pcb/netroute';
import { copperShapes, shapeShapeDist } from '../src/pcb/autoroute';
import { trackClearance } from '../src/pcb/track-clearance';
import { expandDoc } from '../src/pcb/expand';
import type { Doc, Entity, Net, Track } from '../src/pcb/model';

const pad = (id: string, x: number, y: number): Entity => ({ kind: 'pad', id, x, y, shape: 'round', size: 1.6, drill: 0.8 });
const track = (id: string, pts: [number, number][], w = 0.3): Track => ({
  kind: 'track', id, w, layer: 'k1', pts: pts.map(([x, y]) => ({ x, y })),
});
const opts: MeanderOpts = { trackW: 0.3, clearance: 0.2, maxHeight: 1.5 };
const len = (doc: Doc, netId: string): number => netLengths(doc.entities, doc.nets ?? []).get(netId)!.length;

// ----------------------------------------------------------- длины и шины
{
  const doc: Doc = {
    name: 'Шины', w: 100, h: 80, entities: [
      pad('a1', 10, 10), pad('a2', 60, 10), track('ta', [[10, 10], [60, 10]]),   // 50 мм
      pad('b1', 10, 30), pad('b2', 40, 30), track('tb', [[10, 30], [40, 30]]),   // 30 мм
      pad('c1', 10, 50), pad('c2', 20, 50), track('tc', [[10, 50], [20, 50]]),   // 10 мм, другая шина
      pad('d1', 10, 70), pad('d2', 30, 70),                                        // без дорожек
    ],
    nets: [
      { id: 'A', name: 'DQ0', pads: ['a1', 'a2'], bus: 'DDR' },
      { id: 'B', name: 'DQ1', pads: ['b1', 'b2'], bus: 'DDR' },
      { id: 'C', name: 'SCK', pads: ['c1', 'c2'], bus: 'SPI' },
      { id: 'D', name: 'Без трассы', pads: ['d1', 'd2'] },
    ],
  };
  const rows = netLengths(doc.entities, doc.nets!);
  assert.equal(rows.get('A')!.length, 50, 'длина цепи — сумма дорожек');
  assert.equal(rows.get('A')!.tracks, 1);
  assert.equal(rows.get('B')!.length, 30);
  assert.equal(rows.get('D')!.length, 0, 'цепь без дорожек — длина 0');
  assert.equal(rows.get('D')!.missing, 1, 'и она не соединена');
  assert.equal(rows.get('A')!.missing, 0);

  const sums = busSummaries(rows.values());
  assert.deepEqual(sums.map((s) => s.bus), ['DDR', 'SPI'], 'цепи без шины не попадают в итоги');
  const ddr = sums[0];
  assert.equal(ddr.min, 30);
  assert.equal(ddr.max, 50);
  assert.equal(ddr.skew, 20, 'разброс шины = max − min');
  assert.equal(ddr.total, 80, 'итог по шине — сумма длин');
  assert.deepEqual(ddr.nets.map((n) => n.name), ['DQ1', 'DQ0'], 'цепи шины сортируются от короткой к длинной');
}

// --------------------------------------------- змейка: точная длина и связность
{
  const base: Entity[] = [pad('a1', 10, 10), pad('a2', 60, 10), track('ta', [[10, 10], [60, 10]])];
  const nets: Net[] = [{ id: 'A', name: 'DQ0', pads: ['a1', 'a2'] }];
  const snapshot = JSON.stringify(base);

  const res = lengthenNet(base, nets, 'A', 56.5, opts);
  assert.equal(JSON.stringify(base), snapshot, 'исходные примитивы не меняются');
  assert.equal(res.before, 50);
  assert.ok(res.complete, res.message);
  const after = netLengths(res.entities, nets).get('A')!.length;
  assert.ok(Math.abs(after - 56.5) < LENGTH_TOLERANCE, `длина после змейки ${after}, нужна 56.5`);
  assert.ok(res.teeth >= 1, 'добавлены зубцы');
  assert.equal(res.entities.length, base.length, 'примитивов столько же — меняется только дорожка');
  assert.equal(res.entities.find((e) => e.id === 'a1'), base[0], 'площадки остаются теми же объектами');

  const comp = copperComponents(res.entities);
  assert.equal(comp.get('a1'), comp.get('a2'), 'выводы остаются соединены дорожкой');
  assert.equal(netMissing(nets[0], comp), 0, 'связность цепи не потеряна');

  const t = res.entities.find((e) => e.id === 'ta') as Track;
  assert.ok(t.pts.length > 2, 'дорожка получила точки зубцов');
  assert.ok(t.pts.every((p) => Math.abs(p.y - 10) <= 1.5 + 1e-9), 'высота зубцов не больше maxHeight');
  assert.ok(t.pts[0].x === 10 && t.pts[t.pts.length - 1].x === 60, 'концы дорожки на месте');
}

// ------------------------- змейка не нарушает зазоры до чужой меди
{
  // соседняя дорожка другой цепи идёт параллельно на расстоянии, где зубцы тесниться не должны
  const ents: Entity[] = [
    pad('a1', 10, 10), pad('a2', 40, 10), track('ta', [[10, 10], [40, 10]]),
    pad('x1', 10, 12), pad('x2', 40, 12), track('tx', [[10, 12.2], [40, 12.2]]),
  ];
  const nets: Net[] = [
    { id: 'A', name: 'A', pads: ['a1', 'a2'] },
    { id: 'X', name: 'X', pads: ['x1', 'x2'] },
  ];
  const res = lengthenNet(ents, nets, 'A', 40, opts);
  const vio = trackClearance(res.entities, opts.clearance);
  assert.equal(vio.length, 0, 'змейка не создаёт нарушений зазора между дорожками');
  // зубцы не касаются чужой дорожки и чужих площадок
  const flat = expandDoc(res.entities);
  const mine = flat.find((e) => e.id === 'ta') as Track;
  // чужая медь: всё, кроме собственной дорожки и собственных площадок (они касаются её концов)
  const others = flat.filter((e) => e.id !== 'ta' && e.id !== 'a1' && e.id !== 'a2').flatMap((e) => copperShapes(e));
  // зубцы — это отрезки не на исходной оси y=10 (осевые куски продолжают саму дорожку)
  const teeth = [];
  for (let i = 0; i < mine.pts.length - 1; i++) {
    const p = mine.pts[i], q = mine.pts[i + 1];
    if (Math.abs(p.y - 10) < 1e-9 && Math.abs(q.y - 10) < 1e-9) continue;
    teeth.push({
      id: 'm', layers: ['k1' as const], r: mine.w / 2, bb: [0, 0, 0, 0] as [number, number, number, number],
      segs: [[p.x, p.y, q.x, q.y] as [number, number, number, number]],
    });
  }
  assert.ok(teeth.length >= 4, 'зубцы реально созданы');
  for (const m of teeth) for (const o of others) {
    if (!o.layers.includes('k1')) continue;
    assert.ok(shapeShapeDist(m, o) >= opts.clearance - 1e-6, 'зубец не подходит ближе зазора к чужой меди');
  }
  // сама цепь (после выравнивания) — как и раньше — корректна по связности
  assert.equal(netMissing(nets[0], copperComponents(res.entities)), 0);
  assert.equal(res.complete, true, res.message);
}

// ------------------------------------------ короткая дорожка: честный отказ
{
  const ents: Entity[] = [pad('a1', 10, 10), pad('a2', 12, 10), track('ta', [[10, 10], [12, 10]])];
  const nets: Net[] = [{ id: 'A', name: 'A', pads: ['a1', 'a2'] }];
  const res = lengthenNet(ents, nets, 'A', 60, opts);
  assert.equal(res.complete, false, 'на 2 мм нельзя добавить 58 мм');
  assert.ok(/место|дорожк/i.test(res.message), res.message);
  assert.equal(res.entities, ents, 'при неудаче список примитивов не меняется');
}

// ------------------------------------------- цепь без дорожек и уже длинная
{
  const ents: Entity[] = [pad('a1', 10, 10), pad('a2', 40, 10)];
  const nets: Net[] = [{ id: 'A', name: 'A', pads: ['a1', 'a2'] }];
  assert.equal(lengthenNet(ents, nets, 'A', 50, opts).complete, false, 'без дорожек змейку не сделать');
  const withTrack: Entity[] = [...ents, track('ta', [[10, 10], [40, 10]])];
  const same = lengthenNet(withTrack, nets, 'A', 25, opts);
  assert.equal(same.teeth, 0, 'цель короче текущей — ничего не меняется');
  assert.equal(same.complete, true);
}

// -------------------------------------------- выравнивание всей шины
{
  const ents: Entity[] = [
    pad('a1', 10, 10), pad('a2', 60, 10), track('ta', [[10, 10], [60, 10]]),
    pad('b1', 10, 30), pad('b2', 40, 30), track('tb', [[10, 30], [40, 30]]),
    pad('c1', 10, 50), pad('c2', 30, 50), track('tc', [[10, 50], [30, 50], [30, 60]]),
  ];
  const nets: Net[] = [
    { id: 'A', name: 'DQ0', pads: ['a1', 'a2'], bus: 'DDR' },
    { id: 'B', name: 'DQ1', pads: ['b1', 'b2'], bus: 'DDR' },
    { id: 'C', name: 'DQ2', pads: ['c1', 'c2'], bus: 'DDR' },
  ];
  const before = busSummaries(netLengths(ents, nets).values())[0];
  const res = alignBus(ents, nets, 'DDR', () => opts);
  assert.equal(res.target, 50, 'цель — самая длинная цепь шины');
  const after = busSummaries(netLengths(res.entities, nets).values())[0];
  assert.ok(after.skew <= LENGTH_TOLERANCE * 2, `разброс ${after.skew} мм после выравнивания`);
  assert.ok(res.aligned, res.message);
  assert.ok(before.skew > after.skew, 'разброс уменьшился');
  assert.equal(trackClearance(res.entities, opts.clearance).length, 0, 'шина без нарушений зазоров');
  for (const n of nets) assert.equal(netMissing(n, copperComponents(res.entities)), 0, `${n.name} соединена`);

  const empty = alignBus(ents, nets, 'NOPE', () => opts);
  assert.equal(empty.results.length, 0);
  assert.match(empty.message, /нет цепей/);
}

console.log('lengths: длины, шины, змейки, зазоры и связность OK');
