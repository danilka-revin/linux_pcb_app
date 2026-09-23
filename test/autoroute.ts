// Тест автотрассировки: вход в THT-площадки только по нижнему слою K2.
import * as M from '../src/pcb/model';
import { LIB } from '../src/pcb/library';
import { libBBox, expandDoc } from '../src/pcb/expand';
import { autoroute, pickEndpoint, copperShapes, shapeDist, type RouteOpts } from '../src/pcb/autoroute';

const assert = (c: boolean, m: string): void => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const O: RouteOpts = {
  trackW: 0.6, clearance: 0.3, viaSize: 1.6, viaDrill: 0.7, step: 0.635,
  viaCost: 6, topMul: 1.6, bottomEntry: true, allowTop: true, angle: '45',
};

function checkEntry(ents: M.Entity[], x: number, y: number, name: string): void {
  // дорожки, касающиеся центра площадки, должны быть на K2
  const touching = ents.filter((e) => e.kind === 'track' && e.pts.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-6)) as M.Track[];
  assert(touching.length > 0, name + ': к площадке не подведена дорожка');
  assert(touching.every((t) => t.layer === 'k2'), name + ': вход в отверстие не по K2');
}

// 1) простая связь двух площадок
{
  const doc = M.newBoard(60, 40);
  doc.entities.push(
    { id: 'a', kind: 'pad', x: 10, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'b', kind: 'pad', x: 50, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
  );
  const A = pickEndpoint(doc.entities, { x: 10.2, y: 20 }, 0.3)!;
  const B = pickEndpoint(doc.entities, { x: 50, y: 20.1 }, 0.3)!;
  assert(!!A && !!B && A.tht === true, 'pickEndpoint');
  const r = autoroute(doc.entities, doc.w, doc.h, A, B, O);
  assert(r.ok, 'простая связь: ' + r.msg);
  assert(r.vias === 0 && r.ents.every((e) => e.kind !== 'track' || e.layer === 'k2'), 'простая связь должна быть целиком снизу');
  checkEntry(r.ents, 10, 20, 'A'); checkEntry(r.ents, 50, 20, 'B');
  console.log('1:', r.msg);
}

// 2) стена на K2 — обход через верх с переходами, вход всё равно снизу
{
  const doc = M.newBoard(60, 40);
  doc.entities.push(
    { id: 'a', kind: 'pad', x: 10, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'b', kind: 'pad', x: 50, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'wall', kind: 'track', pts: [{ x: 30, y: 0.5 }, { x: 30, y: 39.5 }], w: 1, layer: 'k2' },
  );
  const A = pickEndpoint(doc.entities, { x: 10, y: 20 }, 0.3)!;
  const B = pickEndpoint(doc.entities, { x: 50, y: 20 }, 0.3)!;
  const r = autoroute(doc.entities, doc.w, doc.h, A, B, O);
  assert(r.ok, 'стена: ' + r.msg);
  assert(r.vias >= 2, 'стена: ожидались переходы, получено ' + r.vias);
  assert(r.drc === 0, 'стена: нарушения зазора ' + r.drc);
  checkEntry(r.ents, 10, 20, 'A'); checkEntry(r.ents, 50, 20, 'B');
  // без верхнего слоя — невозможно
  const r2 = autoroute(doc.entities, doc.w, doc.h, A, B, { ...O, allowTop: false });
  assert(!r2.ok, 'стена без верха должна не находиться');
  console.log('2:', r.msg);
}

// 3) между DIP-8 и резистором, с чужими выводами на пути; зазоры соблюдены
{
  const doc = M.newBoard(80, 50);
  doc.entities.push(
    { id: 'u1', kind: 'comp', lib: 'dip8', name: 'DIP-8', x: 40, y: 25, rot: 0, side: 'top', bl: libBBox(LIB.dip8.build()) },
    { id: 'u2', kind: 'comp', lib: 'dip8', name: 'DIP-8', x: 20, y: 25, rot: 0, side: 'top', bl: libBBox(LIB.dip8.build()) },
  );
  const pads = expandDoc(doc.entities).filter((e) => e.kind === 'pad') as M.Pad[];
  const p1 = pads.find((p) => p.id.startsWith('u2'))!;
  const p2 = pads.filter((p) => p.id.startsWith('u1')).sort((a, b) => b.x - a.x || b.y - a.y)[0];
  const A = pickEndpoint(doc.entities, p1, 0.2)!;
  const B = pickEndpoint(doc.entities, p2, 0.2)!;
  const t0 = Date.now();
  const r = autoroute(doc.entities, doc.w, doc.h, A, B, O);
  assert(r.ok, 'DIP: ' + r.msg);
  assert(r.drc === 0, 'DIP: нарушения ' + r.drc);
  checkEntry(r.ents, p1.x, p1.y, 'DIP A'); checkEntry(r.ents, p2.x, p2.y, 'DIP B');
  // ни одна дорожка на K1 не касается THT-площадок цепи
  for (const e of r.ents) if (e.kind === 'track' && e.layer === 'k1') {
    const s = copperShapes(e)[0];
    for (const p of [p1, p2]) assert(s.segs.every((g) => Math.hypot(g[0] - p.x, g[1] - p.y) > 1), 'K1 касается площадки');
  }
  console.log('3:', r.msg, `(${Date.now() - t0} мс)`);
}
console.log('AUTOROUTE OK');

// 4) обход отверстий и дорожек с заданными зазорами
{
  const doc = M.newBoard(60, 40);
  doc.entities.push(
    { id: 'a', kind: 'pad', x: 10, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'b', kind: 'pad', x: 50, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'h', kind: 'hole', x: 25, y: 20, d: 3 },                                     // крепёжное
    { id: 'v', kind: 'via', x: 35, y: 20, size: 1.8, drill: 0.8 },                     // чужой переход
    { id: 'p', kind: 'pad', x: 42, y: 20, shape: 'round', size: 2, drill: 1 },         // чужая площадка
    { id: 't', kind: 'track', pts: [{ x: 30, y: 14 }, { x: 30, y: 26 }], w: 0.6, layer: 'k2' }, // чужая дорожка
  );
  const holeClear = 1.5, clearance = 0.5;
  const A = pickEndpoint(doc.entities, { x: 10, y: 20 }, 0.3)!;
  const B = pickEndpoint(doc.entities, { x: 50, y: 20 }, 0.3)!;
  const r = autoroute(doc.entities, doc.w, doc.h, A, B, { ...O, clearance, holeClear, step: 0.5 });
  assert(r.ok && r.drc === 0, 'обход: ' + r.msg);
  const obst = expandDoc(doc.entities).filter((e) => e.id !== 'a' && e.id !== 'b').flatMap(copperShapes);
  let minHole = Infinity, minTrack = Infinity;
  for (const e of r.ents) for (const s of copperShapes(e)) for (const ob of obst) {
    if (!s.layers.some((l) => ob.layers.includes(l))) continue;
    // выборка точек по скелету новой меди
    for (const g of s.segs) for (let t = 0; t <= 1; t += 0.005) {
      const d = shapeDist(ob, g[0] + (g[2] - g[0]) * t, g[1] + (g[3] - g[1]) * t) - s.r;
      if (ob.drilled) minHole = Math.min(minHole, d); else minTrack = Math.min(minTrack, d);
    }
  }
  assert(minHole >= holeClear - 1e-3, 'зазор до отверстий ' + minHole.toFixed(3));
  assert(minTrack >= clearance - 1e-3, 'зазор до дорожек ' + minTrack.toFixed(3));
  checkEntry(r.ents, 10, 20, 'A'); checkEntry(r.ents, 50, 20, 'B');
  console.log('4:', r.msg, `(до отверстий ${minHole.toFixed(2)} мм, до дорожек ${minTrack.toFixed(2)} мм)`);
}
console.log('AUTOROUTE HOLES OK');

// 5) узкий проход между двумя переходами: малый зазор — прямо, большой — в обход
{
  const doc = M.newBoard(60, 40);
  doc.entities.push(
    { id: 'a', kind: 'pad', x: 10, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'b', kind: 'pad', x: 50, y: 20, shape: 'round', size: 1.9, drill: 0.9 },
    // стена из переходов с одним просветом у y=20 (края пятачков на расстоянии 2.2 мм)
    ...[0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40].map((y) => (
      { id: 'w' + y, kind: 'via', x: 30, y, size: 1.8, drill: 0.8 } as M.Entity)),
  );
  const A = pickEndpoint(doc.entities, { x: 10, y: 20 }, 0.3)!;
  const B = pickEndpoint(doc.entities, { x: 50, y: 20 }, 0.3)!;
  const base = { ...O, step: 0.25, allowTop: false, clearance: 0.3 };
  const small = autoroute(doc.entities, doc.w, doc.h, A, B, { ...base, holeClear: 0.4 });
  assert(small.ok && small.drc === 0, 'узкий проход, малый зазор: ' + small.msg);
  const big = autoroute(doc.entities, doc.w, doc.h, A, B, { ...base, holeClear: 1.2 });
  assert(!big.ok, 'узкий проход при большом зазоре должен быть закрыт: ' + big.msg);
  console.log('5: малый зазор —', small.msg, '| большой —', big.msg);
}
console.log('AUTOROUTE GAP OK');

// 6) реальная плата Sprint-Layout: неметаллизированные площадки с кольцом — это площадки,
//    к ним можно трассировать с соблюдением зазоров
{
  const { readFileSync } = await import('node:fs');
  const { lay6ToDoc } = await import('../src/pcb/lay6');
  const { doc } = lay6ToDoc(readFileSync('test/fixtures/test1.lay6'));
  const flat = expandDoc(doc.entities);
  const pads = flat.filter((e) => e.kind === 'pad') as M.Pad[];
  assert(pads.length === 180, 'test1: площадок ' + pads.length);
  assert(flat.filter((e) => e.kind === 'hole').length === 4, 'test1: крепёжных отверстий 4');
  const shapes = flat.flatMap(copperShapes);
  const freeP = pads.filter((p) => !shapes.some((s) => s.id !== p.id && !s.drilled && shapeDist(s, p.x, p.y) < p.size / 2));
  const opt = { ...O, trackW: 0.3, clearance: 0.2, holeClear: 0.2, viaSize: 1.2, viaDrill: 0.6, step: 0.25 };
  let ok = 0;
  for (let i = 0; i < 3; i++) {
    const A = pickEndpoint(doc.entities, freeP[i], 0.05)!, B = pickEndpoint(doc.entities, freeP[freeP.length - 1 - i], 0.05)!;
    const r = autoroute(doc.entities, doc.w, doc.h, A, B, opt);
    assert(r.ok && r.drc === 0, 'test1 трасса ' + i + ': ' + r.msg);
    checkEntry(r.ents, A.x, A.y, 'test1 A'); checkEntry(r.ents, B.x, B.y, 'test1 B');
    ok++;
  }
  console.log('6: test1.lay6 — проложено', ok, 'трасс без нарушений зазоров');
}
console.log('AUTOROUTE REAL OK');
