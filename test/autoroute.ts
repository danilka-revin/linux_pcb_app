// Тест автотрассировки: вход в THT-площадки только по нижнему слою K2.
import * as M from '../src/pcb/model';
import { LIB } from '../src/pcb/library';
import { libBBox, expandDoc } from '../src/pcb/expand';
import { autoroute, pickEndpoint, copperShapes, type RouteOpts } from '../src/pcb/autoroute';

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
