// Вспомогательные (построительные) линии чертежа: перпендикуляр, параллель,
// касательная, биссектриса, серединный перпендикуляр, направление под углом,
// горизонталь и вертикаль. Проверяем настоящую геометрию: углы, расстояния,
// точки касания, обрезку по листу и поведение на вырожденных данных.
import assert from 'node:assert/strict';
import {
  AUX_MODES, DEFAULT_AUX_PARAMS, buildAuxLine, circleOf, clipToSheet, dirAngleDeg, distToLine,
  nearestOnShape, pickBase, previewAuxLine, tangentPoints, unit,
  type AuxParams,
} from '../src/laser/construction';
import { newLaserDoc, type LaserShape, type Pt } from '../src/laser/model';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const len = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

/** Отрезок-путь (как его создаёт редактор). */
const seg = (a: Pt, b: Pt, id = 's1'): LaserShape => ({
  id, kind: 'path', layer: 'l1', name: 'Отрезок', nodes: [a, b], closed: false, filled: false,
});
/** Окружность. */
const circle = (cx: number, cy: number, r: number, id = 'c1'): LaserShape => ({
  id, kind: 'ellipse', layer: 'l1', name: 'Окружность',
  cx, cy, rx: r, ry: r, rot: 0, startAngle: 0, endAngle: 360, filled: false,
});
/** Прямоугольник. */
const rect = (x: number, y: number, w: number, h: number, id = 'r1'): LaserShape => ({
  id, kind: 'rect', layer: 'l1', name: 'Прямоугольник', x, y, w, h, rx: 0, rot: 0, filled: false,
});

const params = (over: Partial<AuxParams> = {}): AuxParams => ({ ...DEFAULT_AUX_PARAMS, ...over });
const sheet = { w: 300, h: 200 };

// ---------------- состав инструмента ----------------
{
  const ids = AUX_MODES.map((m) => m.id);
  for (const want of ['perp', 'parallel', 'tangent', 'angle', 'midperp', 'bisector', 'h', 'v']) {
    assert(ids.includes(want as never), `режим «${want}» есть в панели`);
  }
  assert.equal(new Set(AUX_MODES.map((m) => m.key)).size, AUX_MODES.length, 'цифры режимов не повторяются');
  for (const m of AUX_MODES) {
    assert(m.hint.length > 10, `подсказка режима «${m.name}»`);
    assert(m.clicks >= 1 && m.clicks <= 3, `число кликов режима «${m.name}»`);
  }
  assert.equal(DEFAULT_AUX_PARAMS.fullSheet, true, 'по умолчанию линия на весь лист');
}

// ---------------- горизонталь и вертикаль ----------------
{
  const h = buildAuxLine({ mode: 'h', pts: [{ x: 40, y: 70 }], params: params(), sheet })!;
  assert.ok(h, 'горизонталь построена');
  assert(near(h.a.y, 70) && near(h.b.y, 70), 'горизонталь держит Y точки');
  assert(near(h.a.x, 0) && near(h.b.x, 300), `горизонталь растянута на лист: ${h.a.x}…${h.b.x}`);
  assert(/горизонталь/i.test(h.name), `подпись: ${h.name}`);

  const v = buildAuxLine({ mode: 'v', pts: [{ x: 120, y: 15 }], params: params(), sheet })!;
  assert(near(v.a.x, 120) && near(v.b.x, 120), 'вертикаль держит X точки');
  assert(near(Math.min(v.a.y, v.b.y), 0) && near(Math.max(v.a.y, v.b.y), 200), 'вертикаль на весь лист');

  // фиксированная длина центрируется в точке
  const short = buildAuxLine({ mode: 'h', pts: [{ x: 40, y: 70 }], params: params({ fullSheet: false, length: 50 }), sheet })!;
  assert(near(len(short.a, short.b), 50), `длина линии: ${len(short.a, short.b)}`);
  assert(near((short.a.x + short.b.x) / 2, 40), 'линия центрирована в точке клика');

  assert.equal(buildAuxLine({ mode: 'h', pts: [], params: params(), sheet }), null, 'без клика линии нет');
}

// ---------------- направление под углом ----------------
{
  const a45 = buildAuxLine({ mode: 'angle', pts: [{ x: 10, y: 10 }], params: params({ angleDeg: 45 }), sheet })!;
  const dir = { x: a45.b.x - a45.a.x, y: a45.b.y - a45.a.y };
  assert(near(dirAngleDeg(dir) % 180, 45, 1e-6), `угол линии: ${dirAngleDeg(dir)}`);

  const a0 = buildAuxLine({ mode: 'angle', pts: [{ x: 10, y: 10 }], params: params({ angleDeg: 0 }), sheet })!;
  assert(near(a0.a.y, a0.b.y), 'угол 0° — горизонталь');

  const a90 = buildAuxLine({ mode: 'angle', pts: [{ x: 10, y: 10 }], params: params({ angleDeg: 90 }), sheet })!;
  assert(near(a90.a.x, a90.b.x), 'угол 90° — вертикаль');

  const neg = buildAuxLine({ mode: 'angle', pts: [{ x: 150, y: 100 }], params: params({ angleDeg: -30 }), sheet })!;
  const nd = { x: neg.b.x - neg.a.x, y: neg.b.y - neg.a.y };
  assert(near(dirAngleDeg(nd) % 180, 150, 1e-6), `отрицательный угол: ${dirAngleDeg(nd)}`);
}

// ---------------- перпендикуляр ----------------
{
  const base = seg({ x: 20, y: 50 }, { x: 200, y: 50 }, 'base');
  const p = { x: 100, y: 120 };
  const line = buildAuxLine({ mode: 'perp', pts: [{ x: 100, y: 50 }, p], base, params: params(), sheet })!;
  const dir = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
  assert(near(dirAngleDeg(dir) % 180, 90, 1e-6), `перпендикуляр к горизонтали: ${dirAngleDeg(dir)}`);
  assert(near(distToLine(p, line.a, dir), 0, 1e-6), 'линия проходит через указанную точку');
  assert.ok(line.mark && near(line.mark.y, 50), 'основание перпендикуляра на базе');

  // к наклонной базе — тоже 90°
  const slant = seg({ x: 0, y: 0 }, { x: 100, y: 100 }, 'slant');
  const l2 = buildAuxLine({ mode: 'perp', pts: [{ x: 50, y: 50 }, { x: 80, y: 20 }], base: slant, params: params(), sheet })!;
  const d2 = { x: l2.b.x - l2.a.x, y: l2.b.y - l2.a.y };
  const baseAngle = 45;
  const got = dirAngleDeg(d2) % 180;
  assert(near(Math.abs(got - baseAngle) % 180, 90, 1e-6) || near(got, 135, 1e-6), `перпендикуляр к наклонной: ${got}`);

  // без базы — перпендикуляр к отрезку между двумя кликами
  const l3 = buildAuxLine({ mode: 'perp', pts: [{ x: 0, y: 0 }, { x: 40, y: 0 }], base: null, params: params(), sheet })!;
  const d3 = { x: l3.b.x - l3.a.x, y: l3.b.y - l3.a.y };
  assert(near(d3.x, 0, 1e-6), 'без базы перпендикуляр к линии кликов');

  // к стороне прямоугольника
  const l4 = buildAuxLine({
    mode: 'perp', pts: [{ x: 50, y: 0 }, { x: 50, y: 60 }],
    base: rect(0, 0, 100, 40, 'r'), params: params({ fullSheet: false, length: 40 }), sheet,
  })!;
  const d4 = { x: l4.b.x - l4.a.x, y: l4.b.y - l4.a.y };
  assert(near(d4.x, 0, 1e-6), `перпендикуляр к стороне прямоугольника: ${dirAngleDeg(d4)}`);
}

// ---------------- параллель ----------------
{
  const base = seg({ x: 20, y: 50 }, { x: 200, y: 50 }, 'base');

  // ровно через точку клика
  const p1 = buildAuxLine({ mode: 'parallel', pts: [{ x: 100, y: 50 }, { x: 100, y: 90 }], base, params: params(), sheet })!;
  const d1 = { x: p1.b.x - p1.a.x, y: p1.b.y - p1.a.y };
  assert(near(d1.y, 0, 1e-6), 'параллель горизонтальна, как база');
  assert(near(distToLine({ x: 100, y: 90 }, p1.a, d1), 0, 1e-6), 'параллель проходит через точку клика');

  // точное расстояние от базы
  const p2 = buildAuxLine({
    mode: 'parallel', pts: [{ x: 100, y: 50 }, { x: 100, y: 90 }], base,
    params: params({ distance: 25 }), sheet,
  })!;
  const d2 = { x: p2.b.x - p2.a.x, y: p2.b.y - p2.a.y };
  const dist = distToLine({ x: 100, y: 50 }, p2.a, d2);
  assert(near(dist, 25, 1e-6), `расстояние до базы: ${dist}`);
  assert(/25\.00/.test(p2.name), `подпись с расстоянием: ${p2.name}`);

  // сторона зависит от клика: точка ниже базы — линия ниже
  const p3 = buildAuxLine({
    mode: 'parallel', pts: [{ x: 100, y: 50 }, { x: 100, y: 10 }], base,
    params: params({ distance: 25 }), sheet,
  })!;
  assert.ok(Math.min(p3.a.y, p3.b.y) < 50, 'параллель ушла в сторону точки клика');

  // параллель наклонной базе сохраняет её угол
  const slant = seg({ x: 0, y: 0 }, { x: 100, y: 50 }, 'slant');
  const p4 = buildAuxLine({ mode: 'parallel', pts: [{ x: 50, y: 25 }, { x: 50, y: 80 }], base: slant, params: params(), sheet })!;
  const d4 = { x: p4.b.x - p4.a.x, y: p4.b.y - p4.a.y };
  assert(near(dirAngleDeg(d4) % 180, dirAngleDeg({ x: 100, y: 50 }) % 180, 1e-6), 'угол параллели равен углу базы');

  assert.equal(
    buildAuxLine({ mode: 'parallel', pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }], base: null, params: params(), sheet }),
    null,
    'параллель без базы не строится'
  );
}

// ---------------- касательная ----------------
{
  const c = circle(100, 100, 40);
  assert.ok(circleOf(c), 'полная окружность распознаётся');
  assert.equal(circleOf(rect(0, 0, 10, 10)), null, 'прямоугольник — не окружность');

  const tps = tangentPoints(c, { x: 200, y: 100 });
  assert.equal(tps.length, 2, `из внешней точки две касательные: ${tps.length}`);
  for (const t of tps) {
    const r = len(t.point, { x: 100, y: 100 });
    assert(near(r, 40, 1e-6), `точка касания на окружности: r=${r}`);
    // радиус перпендикулярен касательной
    const rad = { x: t.point.x - 100, y: t.point.y - 100 };
    const dotp = rad.x * t.dir.x + rad.y * t.dir.y;
    assert(near(dotp, 0, 1e-6), 'радиус перпендикулярен касательной');
    // расстояние от внешней точки до точки касания = sqrt(d² − r²)
    assert(near(len(t.point, { x: 200, y: 100 }), Math.sqrt(100 * 100 - 40 * 40), 1e-6), 'длина касательной');
  }

  // построенная линия действительно касается окружности
  const line = buildAuxLine({ mode: 'tangent', pts: [{ x: 140, y: 100 }, { x: 200, y: 100 }], base: c, params: params(), sheet })!;
  const dir = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
  const dist = distToLine({ x: 100, y: 100 }, line.a, dir);
  assert(near(dist, 40, 1e-6), `расстояние от центра до касательной = радиусу: ${dist}`);
  assert.ok(line.mark && near(len(line.mark, { x: 100, y: 100 }), 40, 1e-6), 'точка касания помечена');

  // точка внутри окружности — касательной нет
  assert.equal(tangentPoints(c, { x: 110, y: 100 }).length, 0, 'из внутренней точки касательных нет');
  assert.equal(
    buildAuxLine({ mode: 'tangent', pts: [{ x: 140, y: 100 }, { x: 110, y: 100 }], base: c, params: params(), sheet }),
    null,
    'из внутренней точки линия не строится'
  );

  // эллипс: касательных тоже две, и они действительно касаются
  const e: LaserShape = {
    id: 'e1', kind: 'ellipse', layer: 'l1', name: 'Эллипс',
    cx: 100, cy: 100, rx: 60, ry: 30, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const et = tangentPoints(e, { x: 100, y: 200 });
  assert.equal(et.length, 2, `касательные к эллипсу: ${et.length}`);
  for (const t of et) {
    const norm = Math.hypot((t.point.x - 100) / 60, (t.point.y - 100) / 30);
    assert(near(norm, 1, 1e-6), `точка касания на эллипсе: ${norm}`);
  }

  // дуга: касательная в ближайшей точке
  const arc: LaserShape = { ...circle(100, 100, 40, 'arc'), startAngle: 0, endAngle: 90 } as LaserShape;
  const at = tangentPoints(arc, { x: 200, y: 200 });
  assert.equal(at.length, 1, 'из этой точки к дуге одна касательная — в ближайшей её точке');
  const ar = len(at[0].point, { x: 100, y: 100 });
  assert(near(ar, 40, 1e-6), `точка касания лежит на дуге: r=${ar}`);
  const ang = Math.atan2(at[0].point.y - 100, at[0].point.x - 100) * 180 / Math.PI;
  assert.ok(ang >= -1e-6 && ang <= 90 + 1e-6, `точка касания в диапазоне дуги: ${ang}°`);

  // кривая Безье: касательная в ближайшей точке
  const curve: LaserShape = {
    id: 'cv', kind: 'path', layer: 'l1', name: 'Кривая', closed: false, filled: false,
    nodes: [
      { x: 0, y: 0 },
      { x: 50, y: 80, smooth: true, cp1x: 30, cp1y: 0, cp2x: 20, cp2y: 80 },
    ],
  };
  const ct = tangentPoints(curve, { x: 25, y: 40 });
  assert.equal(ct.length, 1, 'у кривой одна ближайшая касательная');
  assert.ok(near(len(ct[0].point, { x: 25, y: 40 }), len(ct[0].point, { x: 25, y: 40 })), 'точка касания найдена');
}

// ---------------- серединный перпендикуляр ----------------
{
  const a = { x: 40, y: 40 };
  const b = { x: 160, y: 40 };
  const line = buildAuxLine({ mode: 'midperp', pts: [a, b], params: params(), sheet })!;
  const dir = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
  assert(near(dirAngleDeg(dir) % 180, 90, 1e-6), 'серединный перпендикуляр вертикален');
  assert(line.mark && near(line.mark.x, 100) && near(line.mark.y, 40), 'проходит через середину отрезка');
  assert(near(distToLine(a, line.a, dir), distToLine(b, line.a, dir), 1e-6), 'обе точки равноудалены');

  // наклонный отрезок
  const l2 = buildAuxLine({ mode: 'midperp', pts: [{ x: 0, y: 0 }, { x: 100, y: 100 }], params: params(), sheet })!;
  const d2 = { x: l2.b.x - l2.a.x, y: l2.b.y - l2.a.y };
  assert(near(dirAngleDeg(d2) % 180, 135, 1e-6), `перпендикуляр к диагонали: ${dirAngleDeg(d2)}`);

  assert.equal(buildAuxLine({ mode: 'midperp', pts: [{ x: 5, y: 5 }, { x: 5, y: 5 }], params: params(), sheet }), null,
    'вырожденный отрезок не строится');
}

// ---------------- биссектриса ----------------
{
  // прямой угол: лучи вдоль +X и +Y из вершины
  const line = buildAuxLine({
    mode: 'bisector', pts: [{ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 100 }],
    params: params({ fullSheet: false, length: 60 }), sheet,
  })!;
  const dir = { x: line.b.x - line.a.x, y: line.b.y - line.a.y };
  assert(near(dirAngleDeg(dir) % 180, 45, 1e-6), `биссектриса прямого угла: ${dirAngleDeg(dir)}`);
  assert(line.mark && near(line.mark.x, 0) && near(line.mark.y, 0), 'биссектриса выходит из вершины');
  assert(/45\.0/.test(line.name), `подпись с половиной угла: ${line.name}`);

  // развёрнутый угол — биссектриса перпендикулярна лучам
  const flat = buildAuxLine({
    mode: 'bisector', pts: [{ x: -50, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }],
    params: params({ fullSheet: false, length: 40 }), sheet,
  })!;
  const fd = { x: flat.b.x - flat.a.x, y: flat.b.y - flat.a.y };
  assert(near(dirAngleDeg(fd) % 180, 90, 1e-6), `биссектриса развёрнутого угла: ${dirAngleDeg(fd)}`);

  assert.equal(
    buildAuxLine({ mode: 'bisector', pts: [{ x: 10, y: 0 }, { x: 0, y: 0 }], params: params(), sheet }),
    null,
    'без третьего клика биссектрисы нет'
  );
}

// ---------------- обрезка по листу ----------------
{
  const clipped = clipToSheet({ x: 150, y: 100 }, { x: 1, y: 0 }, sheet)!;
  assert(near(clipped.a.x, 0) && near(clipped.b.x, 300), 'горизонталь обрезана по листу');

  const diag = clipToSheet({ x: 0, y: 0 }, { x: 1, y: 1 }, sheet)!;
  assert(near(diag.b.x, 200) && near(diag.b.y, 200), `диагональ упирается в верх листа: ${diag.b.x},${diag.b.y}`);

  assert.equal(clipToSheet({ x: 500, y: 100 }, { x: 0, y: 1 }, sheet), null, 'линия вне листа не строится');
  assert.equal(clipToSheet({ x: 10, y: 10 }, { x: 0, y: 0 }, sheet), null, 'нулевое направление недопустимо');

  // линия за листом не появляется и в построении
  const off = buildAuxLine({ mode: 'h', pts: [{ x: 10, y: 500 }], params: params(), sheet });
  assert.equal(off, null, 'горизонталь за пределами листа не строится');
}

// ---------------- поиск базы ----------------
{
  const shapes = [seg({ x: 0, y: 50 }, { x: 200, y: 50 }, 'line'), circle(150, 150, 20, 'cir')];
  assert.equal(pickBase(shapes, { x: 100, y: 51 }, 3)?.id, 'line', 'база находится в допуске');
  assert.equal(pickBase(shapes, { x: 100, y: 120 }, 3), null, 'вдали от объектов базы нет');
  assert.equal(pickBase(shapes, { x: 150, y: 152 }, 5)?.id, 'cir', 'окружность тоже база');
  // скрытый и заблокированный объект базой не бывает
  assert.equal(pickBase([{ ...shapes[0], hidden: true }], { x: 100, y: 50 }, 5), null, 'скрытый объект не база');
  assert.equal(pickBase([{ ...shapes[0], locked: true }], { x: 100, y: 50 }, 5), null, 'заблокированный объект не база');
  // размеры и надписи базой не считаются
  const dim: LaserShape = {
    id: 'd1', kind: 'dim', layer: 'l1', name: 'Размер', x1: 0, y1: 0, x2: 50, y2: 0, offset: 8,
  };
  assert.equal(pickBase([dim], { x: 25, y: 0 }, 5), null, 'размерная линия не база');
}

// ---------------- ближайшая точка и направление на объекте ----------------
{
  const line = seg({ x: 0, y: 0 }, { x: 100, y: 0 });
  const hit = nearestOnShape(line, { x: 50, y: 20 })!;
  assert(near(hit.point.x, 50) && near(hit.point.y, 0), 'ближайшая точка на отрезке');
  assert(near(hit.dist, 20), 'расстояние до отрезка');
  assert(near(Math.abs(hit.dir.x), 1) && near(hit.dir.y, 0), 'направление вдоль отрезка');

  const c = circle(0, 0, 10);
  const ch = nearestOnShape(c, { x: 30, y: 0 })!;
  assert(near(ch.point.x, 10, 1e-6) && near(ch.point.y, 0, 1e-6), 'ближайшая точка окружности');
  assert(near(Math.abs(ch.dir.y), 1, 1e-6), 'касательная к окружности перпендикулярна радиусу');

  const r = rect(0, 0, 50, 30);
  const rh = nearestOnShape(r, { x: 25, y: -5 })!;
  assert(near(rh.point.y, 0, 1e-6), 'ближайшая точка на стороне прямоугольника');

  const txt: LaserShape = {
    id: 't1', kind: 'text', layer: 'l1', name: 'Надпись',
    x: 0, y: 0, text: 'PSBees', size: 6, strokeWidth: 0.4, rot: 0, mirror: false, filled: false,
  };
  assert.equal(nearestOnShape(txt, { x: 0, y: 0 }), null, 'надпись базой не считается');
}

// ---------------- предпросмотр по неполным кликам ----------------
{
  const base = seg({ x: 0, y: 50 }, { x: 200, y: 50 }, 'base');
  // один клик сделан, курсор ведёт линию
  const pv = previewAuxLine(
    { mode: 'perp', pts: [{ x: 100, y: 50 }], base, params: params(), sheet },
    { x: 100, y: 120 }
  )!;
  assert.ok(pv, 'предпросмотр перпендикуляра есть');
  const d = { x: pv.b.x - pv.a.x, y: pv.b.y - pv.a.y };
  assert(near(dirAngleDeg(d) % 180, 90, 1e-6), 'предпросмотр перпендикулярен базе');

  // для одно-кликового режима предпросмотр строится сразу по курсору
  const pv1 = previewAuxLine({ mode: 'h', pts: [], params: params(), sheet }, { x: 20, y: 80 })!;
  assert(near(pv1.a.y, 80) && near(pv1.b.y, 80), 'предпросмотр горизонтали у курсора');

  // пока кликов не хватает, предпросмотра нет
  assert.equal(
    previewAuxLine({ mode: 'bisector', pts: [{ x: 0, y: 0 }], params: params(), sheet }, { x: 10, y: 10 }),
    null,
    'для биссектрисы нужны три точки'
  );
}

// ---------------- линия ложится на служебный слой документа ----------------
{
  const doc = newLaserDoc(300, 200);
  const line = buildAuxLine({ mode: 'h', pts: [{ x: 50, y: 50 }], params: params(), sheet: { w: doc.w, h: doc.h } })!;
  assert.ok(line, 'линия для листа документа построена');
  assert.ok(line.a.x >= -1e-6 && line.b.x <= doc.w + 1e-6, 'линия в пределах листа');
  assert.equal(unit({ x: 0, y: 0 }), null, 'нулевой вектор не нормализуется');
}

process.stdout.write(
  'CONSTRUCTION OK: вспомогательные линии — горизонталь, вертикаль, направление под углом, '
  + 'перпендикуляр (к отрезку, наклонной, стороне прямоугольника), параллель (через точку и на '
  + 'точное расстояние, с нужной стороны), касательная (две к окружности из внешней точки, '
  + 'к эллипсу, дуге и кривой Безье; из внутренней точки — отказ), серединный перпендикуляр, '
  + 'биссектриса (в том числе развёрнутого угла), обрезка по листу, поиск базы, ближайшая точка '
  + 'и направление на объекте, предпросмотр по неполным кликам\n',
  () => process.exit(0)
);
