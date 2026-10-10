// Размерные линии: геометрия, подпись, трансформации, попадание мышью.
import assert from 'node:assert/strict';
import { dimArrows, dimGeom, dimLabel, dimSegments, dimValue } from '../src/pcb/dim';
import {
  entBBox, hitEnt, mirrorEnt, rotateEnt90, translateEnt,
  type DimE,
} from '../src/pcb/model';

const mk = (p: Partial<DimE> = {}): DimE => ({
  id: 'd1', kind: 'dim',
  x1: 0, y1: 0, x2: 10, y2: 0,
  off: 3, th: 0.15, size: 2.5,
  mode: 'aligned', layer: 's1',
  ...p,
});

// ----------------------------------------------------------------- значения
assert.equal(dimValue({ x1: 0, y1: 0, x2: 10, y2: 0, mode: 'aligned' }), 10);
assert.equal(dimValue({ x1: 0, y1: 0, x2: 3, y2: 4, mode: 'aligned' }), 5);
assert.equal(dimValue({ x1: 0, y1: 0, x2: 3, y2: 4, mode: 'horiz' }), 3);
assert.equal(dimValue({ x1: 0, y1: 0, x2: 3, y2: 4, mode: 'vert' }), 4);
assert.equal(dimLabel({ x1: 0, y1: 0, x2: 10, y2: 0, mode: 'aligned' }), '10 мм');
assert.equal(dimLabel({ x1: 0, y1: 0, x2: 2.5, y2: 0, mode: 'aligned' }), '2,5 мм');
assert.equal(dimLabel({ x1: 0, y1: 0, x2: 10, y2: 0, mode: 'aligned', text: 'ширина' }), 'ширина');

// ------------------------------------------------------------------ геометрия
{
  const g = dimGeom(mk());
  assert.equal(g.value, 10);
  // нормаль к (1;0) — (0;1): размерная линия на y = 3
  assert(Math.abs(g.da.y - 3) < 1e-9 && Math.abs(g.db.y - 3) < 1e-9, 'смещение вдоль нормали');
  assert(Math.abs(g.mid.x - 5) < 1e-9 && Math.abs(g.mid.y - 3) < 1e-9, 'текст в середине');
  assert.equal(g.textAngle, 0);
}
{
  // вертикальный размер: текст поворачивается на 90°, но остаётся «читаемым»
  const g = dimGeom(mk({ x1: 0, y1: 0, x2: 0, y2: 8, mode: 'vert' }));
  assert.equal(g.value, 8);
  assert(Math.abs(g.da.x - 3) < 1e-9, 'vert: смещение по X');
}
{
  const g = dimGeom(mk({ x1: 10, y1: 0, x2: 0, y2: 0 })); // справа налево
  assert.equal(g.textAngle, 0, 'текст не переворачивается вверх ногами');
}
{
  const segs = dimSegments(mk());
  assert.equal(segs.length, 3, 'две выносные + размерная');
  const arrows = dimArrows(mk());
  assert.equal(arrows.length, 2, 'две стрелки');
  for (const tri of arrows) assert.equal(tri.length, 3, 'стрелка — треугольник');
}

// ------------------------------------------------------------- трансформации
{
  const d = mk();
  translateEnt(d, 5, -2);
  assert.equal(d.x1, 5); assert.equal(d.y1, -2);
  assert.equal(d.x2, 15); assert.equal(d.y2, -2);
}
{
  const d = mk({ x1: 10, y1: 10, x2: 20, y2: 10, off: 3, mode: 'horiz' });
  rotateEnt90(d, 0, 0); // против часовой: (10;10)→(-10;10), (20;10)→(-10;20)
  assert(Math.abs(d.x1 + 10) < 1e-9 && Math.abs(d.y1 - 10) < 1e-9);
  assert(Math.abs(d.x2 + 10) < 1e-9 && Math.abs(d.y2 - 20) < 1e-9);
  assert.equal(d.mode, 'vert', 'горизонтальный размер становится вертикальным');
  assert(Math.abs(d.off + 3) < 1e-9, 'знак смещения меняется при horiz↔vert');
}
{
  const d = mk({ x1: 2, y1: 0, x2: 8, y2: 0, mode: 'aligned', off: 3 });
  rotateEnt90(d, 0, 0);
  assert.equal(d.mode, 'aligned', 'aligned не меняет направление');
  assert(Math.abs(d.off - 3) < 1e-9, 'aligned сохраняет смещение');
}
{
  const d = mk({ x1: 2, y1: 0, x2: 8, y2: 0 });
  mirrorEnt(d, 0);
  assert(Math.abs(d.x1 + 2) < 1e-9 && Math.abs(d.x2 + 8) < 1e-9, 'зеркало по X');
  assert.equal(d.layer, 's2', 'шелкография меняет сторону');
}

// ------------------------------------------------------------------ hit/BBox
{
  const d = mk(); // от (0;0) до (10;0), линия на y=3
  assert(hitEnt(d, { x: 5, y: 3 }, 0.1), 'попадание в размерную линию');
  assert(hitEnt(d, { x: 0, y: 1.5 }, 0.1), 'попадание в выносную линию');
  assert(hitEnt(d, { x: 5, y: 3.8 }, 0.6), 'попадание в подпись');
  assert(!hitEnt(d, { x: 5, y: 8 }, 0.1), 'мимо — нет');
  const b = entBBox(d);
  assert(b[0] <= 0 && b[2] >= 10 && b[1] <= 0 && b[3] >= 3, 'габарит покрывает точки и линию');
}

console.log('dim: ok');
