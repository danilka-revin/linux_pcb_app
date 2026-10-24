// Инструмент «Усечь кривую» (Trim / Extend / Break): выбор кривой под курсором,
// поиск пересечений, деление сегментов Безье, сборка кусков, граница листа
// и предпросмотр. Всё считается по настоящей кривой, а не по хордам между узлами.
import assert from 'node:assert/strict';
import {
  newLaserDoc, shapeToPath, shapeToPolylines,
  type LaserDoc, type LaserShape, type PathShape,
} from '../src/laser/model';
import {
  breakApartAtIntersections, breakCurve, extendCurve, findCuts, isBoundaryShape,
  samplePath, splitPathAt, splitSegmentAt, trimCurve, trimPreview, trimmable,
} from '../src/laser/trim';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const doc = (): LaserDoc => newLaserDoc(300, 200);

const rect = (x: number, y: number, w: number, h: number, id = 'r1'): LaserShape => ({
  id, kind: 'rect', layer: 'cut', name: 'Прямоугольник', x, y, w, h, rx: 0, rot: 0, filled: false,
});
const line = (x1: number, y1: number, x2: number, y2: number, id = 'l1', extra: Partial<PathShape> = {}): LaserShape => ({
  id, kind: 'path', layer: 'cut', name: 'Отрезок',
  nodes: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false, filled: false, ...extra,
});
const circlePath = (cx: number, cy: number, r: number, id = 'c1'): PathShape => shapeToPath({
  id, kind: 'ellipse', layer: 'cut', name: 'Окружность',
  cx, cy, rx: r, ry: r, rot: 0, startAngle: 0, endAngle: 360, filled: false,
} as LaserShape)[0];
/** Суммарная длина всех полилиний объекта (по аппроксимации, как её видит станок). */
const polyLen = (s: LaserShape): number => {
  let L = 0;
  for (const pl of shapeToPolylines(s)) {
    for (let i = 1; i < pl.length; i++) L += Math.hypot(pl[i].x - pl[i - 1].x, pl[i].y - pl[i - 1].y);
  }
  return L;
};

// ---------------- аппроксимация кривой ----------------
{
  const c = samplePath(circlePath(0, 0, 25));
  const want = 2 * Math.PI * 25;
  // 16 отрезков на сегмент Безье: длина хордовой аппроксимации чуть меньше настоящей
  assert.ok(Math.abs(c.length - want) / want < 1e-3, `длина окружности: ${c.length} ≈ ${want}`);
  assert.equal(c.nodeS.length, 5, 'длина в каждом узле замкнутой кривой из 4 сегментов');
  assert.equal(c.closed, true);
  assert.ok(near(c.cum[c.cum.length - 1], c.length, 1e-6), 'кумулятивная длина сходится с итогом');

  const open = samplePath(line(0, 0, 30, 40) as PathShape);
  assert.equal(open.closed, false);
  assert.ok(near(open.length, 50, 1e-9), 'длина отрезка 3-4-5');

  // прямой сегмент делится линейно, кривой — по Безье
  const sp = splitSegmentAt({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.25);
  assert.ok(near(sp.mid.x, 2.5) && near(sp.mid.y, 0), 'деление прямого сегмента');
  assert.equal(sp.left.cp2x, undefined, 'у прямого куска не появляется рычагов');
}

// ---------------- усечь: отрезок через прямоугольник ----------------
{
  const shapes = [rect(50, 50, 100, 60), line(20, 80, 200, 80)];
  const res = trimCurve(shapes, 'l1', { x: 100, y: 80 }, { tol: 2 });
  assert.ok(res.ok, res.message);
  assert.deepEqual(res.remove, ['l1'], 'старый объект уходит');
  assert.equal(res.add.length, 2, 'остались два куска');
  const total = res.add.reduce((s, x) => s + polyLen(x), 0);
  assert.ok(near(total, 200 - 20 - 100, 0.02), `длина кусков ${total} = 80 мм`);
  assert.ok(res.message.includes('Усечено'), `сообщение: ${res.message}`);
  const ends = res.add.flatMap((s) => (s as PathShape).nodes.map((n) => n.x)).sort((a, b) => a - b);
  assert.ok(near(ends[0], 20, 1e-6) && near(ends[ends.length - 1], 200, 1e-6), 'края не сдвинулись');
  assert.ok(res.add.every((s) => near((s as PathShape).nodes.length, 2)), 'куски остались отрезками');
}

// ---------------- усечь: замкнутый контур режется линией ----------------
{
  const shapes = [rect(50, 50, 100, 60, 'r1'), line(80, 20, 80, 160, 'l1')];
  const res = trimCurve(shapes, 'r1', { x: 65, y: 50 }, { tol: 2 });
  assert.ok(res.ok, res.message);
  assert.equal(res.add.length, 1, 'кусок под курсором удалён, остался один');
  const p = res.add[0] as PathShape;
  assert.equal(p.closed, false, 'замкнутый контур стал открытым');
  assert.equal(p.layer, 'cut', 'слой сохранён');
  assert.equal(p.filled, false, 'открытый кусок не закрашен');
  assert.ok(p.name.includes('Прямоугольник'), `имя наследует исходное: ${p.name}`);
  assert.notEqual(p.id, 'r1', 'у куска новый id');
  assert.ok(!res.add.some((s) => s.id === 'l1'), 'граница не тронута');
}

// ---------------- усечь: дуга Безье делится точно ----------------
{
  const circle = circlePath(100, 100, 40);
  const chord = line(20, 100, 180, 100, 'l1');
  const before = polyLen(circle);
  const cuts = findCuts(circle, shapeToPolylines(chord));
  assert.equal(cuts.length, 2, 'два пересечения с хордой');
  const pieces = splitPathAt(circle, cuts);
  assert.equal(pieces.length, 2, 'две дуги');
  const sum = pieces.reduce((s, pc) => s + polyLen({
    id: 'x', kind: 'path', layer: 'cut', name: 'x', nodes: pc.nodes, closed: pc.closed, filled: false,
  }), 0);
  assert.ok(Math.abs(sum - before) / before < 5e-4, `длины дуг сохраняются: ${sum} vs ${before}`);
  for (const pc of pieces) {
    for (const nd of pc.nodes) {
      assert.ok(near(Math.hypot(nd.x - 100, nd.y - 100), 40, 1e-9), 'узлы точно на окружности');
    }
    assert.ok(pc.nodes.some((nd) => nd.cp2x !== undefined), 'дуга осталась Безье, а не ломаной');
  }
  const res = trimCurve([circle, chord], 'c1', { x: 100, y: 140 }, { tol: 2 });
  assert.ok(res.ok, `дуга усечена: ${res.message}`);
  assert.equal(res.add.length, 1, 'верхняя дуга удалена');
}

// ---------------- продлить до другого объекта ----------------
{
  const shapes = [rect(100, 50, 60, 60), line(10, 80, 60, 80)];
  const res = extendCurve(shapes, 'l1', { x: 60, y: 80 }, { tol: 3 });
  assert.ok(res.ok, res.message);
  const p = res.add[0] as PathShape;
  assert.ok(near(p.nodes[1].x, 100, 1e-6), `конец доведён до границы: ${p.nodes[1].x}`);
  assert.ok(near(p.nodes[0].x, 10, 1e-9), 'начало не сдвинуто');
  assert.ok(res.message.includes('продлена'), `сообщение: ${res.message}`);
  assert.ok(res.message.includes('40.00'), `в сообщении длина добора: ${res.message}`);
}

// ---------------- продлить до края листа ----------------
{
  const shapes = [line(100, 100, 200, 100)];
  const res = extendCurve(shapes, 'l1', { x: 200, y: 100 }, { tol: 3, sheet: { w: 300, h: 200 } });
  assert.ok(res.ok, `линия дотянута до стола: ${res.message}`);
  const p = res.add[0] as PathShape;
  assert.ok(near(p.nodes[1].x, 300, 1e-6), `конец на краю листа: ${p.nodes[1].x}`);
  // без края стола продлевать не до чего
  const none = extendCurve(shapes, 'l1', { x: 200, y: 100 }, { tol: 3 });
  assert.equal(none.ok, false, 'без других объектов продление отклонено');
}

// ---------------- усечь по краю листа ----------------
{
  const sheet = { w: 300, h: 200 };
  // хвост за левым краем стола отрезается одним кликом
  const res = trimCurve([line(-40, 100, 200, 100)], 'l1', { x: -20, y: 100 }, { tol: 2, sheet });
  assert.ok(res.ok, `линия обрезана по столу: ${res.message}`);
  assert.equal(res.add.length, 1, 'осталась одна кривая');
  const p = res.add[0] as PathShape;
  assert.ok(near(p.nodes[0].x, 0, 1e-6) && near(p.nodes[1].x, 200, 1e-6),
    `хвост вне листа удалён: ${p.nodes[0].x}…${p.nodes[1].x}`);
  // линия через весь стол: клик внутри листа убирает среднюю часть
  const both = trimCurve([line(-40, 100, 340, 100)], 'l1', { x: 150, y: 100 }, { tol: 2, sheet });
  assert.ok(both.ok, both.message);
  assert.equal(both.add.length, 2, 'остались два хвоста за краями стола');
  const xs = both.add.flatMap((s2) => (s2 as PathShape).nodes.map((n) => n.x)).sort((a, b) => a - b);
  assert.deepEqual(xs, [-40, 0, 300, 340], `края кусков: ${xs.join('/')}`);
}

// ---------------- разрезать в точке клика ----------------
{
  const shapes = [rect(50, 50, 100, 60)];
  const before = polyLen(shapes[0]);
  const res = breakCurve(shapes, 'r1', { x: 100, y: 110 }, { tol: 3 });
  assert.ok(res.ok, res.message);
  assert.equal(res.add.length, 1, 'замкнутый контур стал одной открытой кривой');
  const p = res.add[0] as PathShape;
  assert.equal(p.closed, false, 'контур разомкнут');
  const gap = Math.hypot(p.nodes[0].x - p.nodes[p.nodes.length - 1].x, p.nodes[0].y - p.nodes[p.nodes.length - 1].y);
  assert.ok(near(polyLen(p) + gap, before, 0.02), `длина контура сохранилась: ${polyLen(p) + gap} vs ${before}`);
  assert.ok(res.message.includes('разрезан'), `сообщение: ${res.message}`);

  // открытый отрезок режется на две кривые
  const two = breakCurve([line(0, 0, 100, 0)], 'l1', { x: 40, y: 0 }, { tol: 2 });
  assert.ok(two.ok, two.message);
  assert.equal(two.add.length, 2, 'две части');
  const xs = two.add.map((s) => (s as PathShape).nodes[1].x).sort((a, b) => a - b);
  assert.ok(near(xs[0], 40, 1e-6) && near(xs[1], 100, 1e-6), `разрез в точке клика: ${xs.join('/')}`);

  // клик ровно в узел — не разрез
  const node = breakCurve([line(0, 0, 100, 0)], 'l1', { x: 0, y: 0 }, { tol: 2 });
  assert.equal(node.ok, false, 'в узле резать нечего');
  assert.ok(node.message.includes('узлом'), `сообщение: ${node.message}`);
}

// ---------------- разбить по всем пересечениям ----------------
{
  const shapes = [rect(50, 50, 100, 60, 'r1'), line(20, 80, 200, 80, 'l1'), line(100, 20, 100, 160, 'l2')];
  const res = breakApartAtIntersections(shapes);
  assert.ok(res.shapes.length > shapes.length, 'кривых стало больше');
  assert.equal(res.split, 3, 'разбиты все три объекта');
  assert.ok(res.added > 0, 'добавлены новые объекты');
  for (const s of res.shapes) {
    for (const pl of shapeToPolylines(s)) {
      for (const p of pl) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), 'координаты конечны');
    }
  }
  // два параллельных отрезка не пересекаются — разбивать нечего
  const none = breakApartAtIntersections([line(0, 0, 50, 0, 'a'), line(0, 10, 50, 10, 'b')]);
  assert.equal(none.split, 0, 'без пересечений ничего не разбито');
  assert.equal(none.shapes.length, 2, 'состав листа не изменился');
  // ограничение по выделению
  const only = breakApartAtIntersections(shapes, new Set(['l1', 'l2']));
  assert.ok(only.split >= 1, 'разбиты только выделенные');
}

// ---------------- самопересечение (восьмёрка) ----------------
{
  const eight: PathShape = {
    id: 'e1', kind: 'path', layer: 'cut', name: 'Восьмёрка',
    nodes: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }],
    closed: true, filled: false,
  };
  const cuts = findCuts(eight, []);
  assert.ok(cuts.length >= 1, 'самопересечение найдено без других объектов');
  const res = trimCurve([eight], 'e1', { x: 25, y: 25 }, { tol: 2 });
  assert.ok(res.ok, `петля восьмёрки усечена: ${res.message}`);
  assert.ok(res.add.length >= 1, 'остался кусок');
}

// ---------------- контур с отверстием ----------------
{
  const outer: PathShape = {
    id: 'p1', kind: 'path', layer: 'cut', name: 'Панель',
    nodes: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    holes: [[{ x: 40, y: 20 }, { x: 60, y: 20 }, { x: 60, y: 40 }, { x: 40, y: 40 }]],
    closed: true, filled: true,
  };
  const res = trimCurve([outer, line(-20, 30, 120, 30, 'l1')], 'p1', { x: 50, y: 60 }, { tol: 2 });
  assert.ok(res.ok, res.message);
  const holes = res.add.filter((s) => (s as PathShape).closed && s.id !== 'p1');
  assert.ok(holes.length >= 1, 'отверстие сохранено отдельной кривой');
  assert.ok(holes.every((s) => s.name.includes('отверстие')), `имя отверстия: ${holes[0].name}`);
}

// ---------------- границы: только выделенные, служебные слои ----------------
{
  const shapes = [
    rect(50, 50, 100, 60, 'r1'),
    line(80, 20, 80, 160, 'l1'),
    line(120, 20, 120, 160, 'l2', { layer: 'guide' }),
  ];
  // направляющая не режет
  const byGuide = trimCurve(shapes, 'r1', { x: 65, y: 50 }, { tol: 2, boundaryIds: new Set(['l2']) });
  assert.equal(byGuide.ok, false, 'направляющая (guide) не считается границей');

  const sel = trimCurve(shapes, 'r1', { x: 65, y: 50 }, { tol: 2, boundaryIds: new Set(['l1']) });
  assert.ok(sel.ok, 'выделенная граница работает');

  assert.equal(isBoundaryShape({ ...shapes[0], hidden: true }), false, 'скрытый объект не граница');
  assert.equal(isBoundaryShape({ ...shapes[0], locked: true }), false, 'заблокированный объект не граница');
  assert.equal(isBoundaryShape({ ...shapes[2] }), false, 'слой направляющих не граница');
  assert.equal(trimmable({
    id: 't1', kind: 'text', layer: 'engrave', name: 'Текст',
    x: 0, y: 0, text: 'PSBees', size: 8, strokeWidth: 0.4, rot: 0, mirror: false, filled: false,
  } as LaserShape), false, 'текст не усекается');

  // заблокированная цель не режется
  const locked = trimCurve([{ ...shapes[0], locked: true }, shapes[1]], 'r1', { x: 65, y: 50 }, { tol: 2 });
  assert.equal(locked.ok, false, 'заблокированный объект не усекать');
}

// ---------------- касание концом: резать нечего ----------------
{
  // горизонталь упирается концом в вертикаль и началом — в край стола
  const shapes = [line(0, 60, 150, 60, 'l1'), line(150, 20, 150, 120, 'l2')];
  const res = trimCurve(shapes, 'l1', { x: 75, y: 60 }, { tol: 2, sheet: { w: 300, h: 200 } });
  assert.equal(res.ok, false, 'концы лишь касаются границ — усекать нечего');
  assert.deepEqual(res.remove, [], 'объект не удалён');
  assert.deepEqual(res.add, [], 'нулевые куски не появляются');
  // та же геометрия без края листа: одно касание в конце
  const touch = trimCurve([line(20, 60, 150, 60, 'l1'), line(150, 20, 150, 120, 'l2')],
    'l1', { x: 75, y: 60 }, { tol: 2 });
  assert.equal(touch.ok, false, 'касание в одной точке не считается пересечением');
  // вертикаль при этом режется честно: пересечение у неё в середине
  const cross = trimCurve(shapes, 'l2', { x: 150, y: 80 }, { tol: 2, sheet: { w: 300, h: 200 } });
  assert.ok(cross.ok, `вертикаль усечена: ${cross.message}`);
  assert.equal(cross.add.length, 1, 'нижний кусок удалён');
  assert.ok(near((cross.add[0] as PathShape).nodes[1].y, 60, 1e-6), 'конец доведён до горизонтали');
}

// ---------------- отказы и крайние случаи ----------------
{
  const shapes = [rect(50, 50, 100, 60, 'r1'), line(20, 200, 200, 200, 'l1')];
  assert.equal(trimCurve(shapes, 'nope', { x: 0, y: 0 }).ok, false, 'несуществующий объект');
  const miss = trimCurve(shapes, 'r1', { x: 5, y: 5 }, { tol: 2 });
  assert.equal(miss.ok, false, 'клик мимо кривой отклонён');
  assert.ok(miss.message.includes('мимо'), `сообщение: ${miss.message}`);
  const noCut = trimCurve(shapes, 'r1', { x: 65, y: 50 }, { tol: 2 });
  assert.equal(noCut.ok, false, 'замкнутому контуру нужно минимум два пересечения');
  const closedExtend = extendCurve([rect(50, 50, 100, 60)], 'r1', { x: 65, y: 50 }, { tol: 2 });
  assert.equal(closedExtend.ok, false, 'замкнутый контур продлевать некуда');
  // пустой лист: документ создаётся, но резать нечего
  assert.equal(doc().shapes.length, 0, 'новый лист пуст');
}

// ---------------- предпросмотр под курсором ----------------
{
  const shapes = [rect(50, 50, 100, 60, 'r1'), line(20, 80, 200, 80, 'l1')];
  const pv = trimPreview(shapes, 'l1', { x: 100, y: 80 }, 'trim', { tol: 2 });
  assert.ok(pv, 'предпросмотр построен');
  assert.equal(pv!.mode, 'trim');
  assert.equal(pv!.cuts.length, 2, 'две точки пересечения подсвечены');
  assert.ok(pv!.pts.length >= 2, 'кусок к удалению отрисован');
  assert.ok(pv!.hint.includes('удалить кусок'), `подсказка: ${pv!.hint}`);

  const extShapes = [rect(100, 50, 60, 60, 'r1'), line(10, 80, 60, 80, 'l2')];
  const ext = trimPreview(extShapes, 'l2', { x: 60, y: 80 }, 'extend', { tol: 3 });
  assert.ok(ext && ext.extra, 'для продления показан отрезок добора');
  assert.ok(near(ext!.extra![1].x, 100, 1e-6), `добор до границы: ${ext!.extra![1].x}`);
  assert.ok(ext!.hint.includes('продлить на 40'), `подсказка: ${ext!.hint}`);
  // в другую сторону границы нет — подсказка честно об этом говорит
  const extNone = trimPreview(extShapes, 'l2', { x: 10, y: 80 }, 'extend', { tol: 3 });
  assert.ok(extNone && extNone.cuts.length === 0, 'нет точки добора');
  assert.ok(extNone!.hint.includes('нет границы'), `подсказка: ${extNone!.hint}`);
  // край листа тоже годится границей добора
  const extSheet = trimPreview([line(10, 80, 60, 80, 'l2')], 'l2', { x: 60, y: 80 }, 'extend',
    { tol: 3, sheet: { w: 300, h: 200 } });
  assert.ok(extSheet && near(extSheet.extra![1].x, 300, 1e-6), `добор до края стола: ${extSheet!.extra![1].x}`);

  const brk = trimPreview(shapes, 'l1', { x: 100, y: 80 }, 'break', { tol: 2 });
  assert.ok(brk && brk.cuts.length === 1, 'в режиме «разрезать» одна точка клика');
  assert.ok(brk!.hint.includes('разрезать'), `подсказка: ${brk!.hint}`);

  assert.equal(trimPreview(shapes, null, { x: 0, y: 0 }, 'trim'), null, 'без цели предпросмотра нет');
  assert.equal(trimPreview(shapes, 'l1', { x: 5, y: 5 }, 'trim', { tol: 1 }), null, 'мимо кривой — ничего');
}

console.log('TRIM OK');
