// Лазерный редактор: модель, трансформации, булевы операции, керф, генератор
// развёрток, CAM-экспорт (G-Code/DXF/SVG), симуляция и файл проекта.
import assert from 'node:assert/strict';
import {
  DEFAULT_LASER_LAYERS, LASER_LAYER_ORDER, MATERIAL_PRESETS, addLaserLayer, adoptShapes, alignShapes,
  arrayShapes, autoNestShapes, booleanShapes, ensureRoleLayer, filletShapeCorners, fmtMm, hitShape,
  layerIds, layerOf, luid, mirrorShape, newLaserDoc, newMachineDoc, nodesToPts,
  offsetShape, removeLaserLayer, rotateShape, rotPt, scaleShape, selectionBBox, shapeBBox, shapeToPath,
  shapeToPolylines, translateShape,
  type LaserDoc, type LaserShape, type PathShape, type Pt,
} from '../src/laser/model';
import {
  DEFAULT_UNFOLD_PARAMS, UNFOLD_TEMPLATES, generateUnfolding, type UnfoldParams,
} from '../src/laser/unfold';
import {
  DEFAULT_GCODE_OPTIONS, buildLaserSimulation, dashPolyline, exportLaserDxf, exportLaserGCode,
  exportLaserSvg, importVectorFile, parseSvgPathData, svgHeightMm,
} from '../src/laser/export';
import {
  constrainAngle, deleteNode, insertNode, moveHandle, moveNode, nearestHandle, nearestNodeIndex,
  nearestOnCurve, nearestSnapPoint, objectSnapPoints, toggleSmooth,
} from '../src/laser/nodes';
import {
  laserDraftKey, normalizeLaserDoc, parseLaserProject, safeFileName, serializeLaserProject,
} from '../src/laser/project';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const ringArea = (pts: Pt[]) => {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a / 2);
};
const pathArea = (s: PathShape) => {
  const outer = ringArea(nodesToPts(s.nodes, true));
  const holes = (s.holes ?? []).reduce((sum, h) => sum + ringArea(nodesToPts(h, true)), 0);
  return outer - holes;
};

// ---------------- документ и слои ----------------
{
  const doc = newLaserDoc(400, 300, 'Тестовый лист');
  assert.equal(doc.w, 400);
  assert.equal(doc.h, 300);
  assert.equal(doc.name, 'Тестовый лист');
  assert.equal(doc.shapes.length, 0);
  assert.equal(doc.materialThickness, 3.0);

  // Новый чертёж начинается с одного своего слоя
  assert.deepEqual(layerIds(doc), ['l1'], 'у нового чертежа один слой');
  assert.equal(doc.layers.l1.short, 'Слой 1');
  assert.equal(doc.layers.l1.mode, 'cut', 'по умолчанию сплошная линия');
  assert.equal(doc.layers.l1.visible, true);
  assert.equal(doc.layers.l1.locked, false);

  // Свои слои добавляются, переименовываются и удаляются
  const grown = addLaserLayer(doc);
  assert.deepEqual(layerIds(grown.doc), ['l1', grown.id], 'новый слой добавлен в конец');
  assert.equal(grown.doc.layers[grown.id].short, 'Слой 2', 'имя следующего слоя');
  assert.notEqual(grown.doc.layers[grown.id].color, doc.layers.l1.color, 'цвет нового слоя отличается');
  const renamed = addLaserLayer(grown.doc, 'Оси');
  assert.equal(renamed.doc.layers[renamed.id].short, 'Оси', 'своё имя слоя');
  assert.deepEqual(layerIds(removeLaserLayer(renamed.doc, renamed.id)), ['l1', grown.id], 'слой удалён');
  assert.equal(layerIds(removeLaserLayer(doc, 'l1')).length, 1, 'последний слой не удаляется');

  // Объекты удалённого слоя переходят на оставшийся
  const withShapes: LaserDoc = {
    ...grown.doc,
    shapes: [{ id: 's1', kind: 'rect', layer: grown.id, name: 'Деталь', x: 0, y: 0, w: 5, h: 5, rx: 0, rot: 0, filled: false }],
  };
  const afterDelete = removeLaserLayer(withShapes, grown.id);
  assert.equal(afterDelete.shapes[0].layer, 'l1', 'объект перенесён на оставшийся слой');

  // Тип линии слоя: сплошная, штриховая, заливка, служебная
  const dashed = addLaserLayer(doc, 'Штрихи', { mode: 'fold' });
  assert(dashed.doc.layers[dashed.id].dashLen > 0 && dashed.doc.layers[dashed.id].gapLen > 0,
    'у штриховой линии есть штрих и пропуск');
  const guide = ensureRoleLayer(doc, 'guide');
  assert.equal(guide.doc.layers[guide.id].mode, 'guide', 'служебный слой для размеров');
  assert.equal(ensureRoleLayer(guide.doc, 'guide').id, guide.id, 'второй служебный слой не создаётся');

  // Объекты генераторов раскладываются по своим слоям чертежа
  const adopted = adoptShapes(doc, [
    { id: 'a', kind: 'rect', layer: 'cut', name: 'Контур', x: 0, y: 0, w: 10, h: 10, rx: 0, rot: 0, filled: false },
    { id: 'b', kind: 'path', layer: 'fold', name: 'Сгиб', nodes: [{ x: 0, y: 0 }, { x: 5, y: 0 }], closed: false, filled: false },
    { id: 'c', kind: 'rect', layer: 'inner', name: 'Отверстие', x: 1, y: 1, w: 2, h: 2, rx: 0, rot: 0, filled: false },
  ] as LaserShape[]);
  assert.equal(adopted.shapes[0].layer, adopted.shapes[2].layer, 'сплошные контуры на одном слое');
  assert.notEqual(adopted.shapes[0].layer, adopted.shapes[1].layer, 'штриховые линии на своём слое');
  assert.equal(layerIds(adopted.doc).length, 2, 'слоев ровно столько, сколько нужно');
  assert(adopted.shapes.every((s) => !!adopted.doc.layers[s.layer]), 'каждый объект на существующем слое');

  // Имя слоя из файла становится слоем чертежа
  const byName = adoptShapes(doc, [
    { id: 'x', kind: 'rect', layer: 'cut', layerName: 'OUTLINE', name: 'Контур', x: 0, y: 0, w: 4, h: 4, rx: 0, rot: 0, filled: false },
    { id: 'y', kind: 'rect', layer: 'cut', layerName: 'OUTLINE', name: 'Контур 2', x: 6, y: 0, w: 4, h: 4, rx: 0, rot: 0, filled: false },
  ] as LaserShape[]);
  const names = layerIds(byName.doc).map((id) => byName.doc.layers[id].short);
  assert(names.includes('OUTLINE'), `слой из файла создан: ${names}`);
  assert.equal(byName.shapes[0].layer, byName.shapes[1].layer, 'одно имя файла — один слой');
  assert.equal((byName.shapes[0] as { layerName?: string }).layerName, undefined, 'служебное имя слоя снято');

  // Объект на неизвестном слое не теряется: конфигурация берётся с запасом
  assert.equal(layerOf(doc, 'несуществующий').mode, 'cut', 'запасной слой для неизвестного');

  // Станочный набор слоёв сохранён целиком (нужен при MACHINE_UI)
  assert.deepEqual(LASER_LAYER_ORDER, ['engrave', 'score', 'fold', 'inner', 'cut', 'guide']);
  const machine = newMachineDoc(400, 300, 'Станок');
  for (const id of LASER_LAYER_ORDER) {
    const cfg = machine.layers[id];
    assert(cfg, `слой ${id} отсутствует`);
    assert.equal(cfg.id, id);
    assert.equal(cfg.visible, true);
    assert.equal(cfg.locked, false);
  }
  assert(machine.layers.cut.power > machine.layers.fold.power, 'мощность контура больше сгиба');
  assert(machine.layers.cut.speed < machine.layers.fold.speed, 'контур медленнее сгиба');
  assert.equal(machine.layers.guide.passes, 0, 'служебный слой не обрабатывается');
  assert(machine.layers.fold.dashLen > 0 && machine.layers.fold.gapLen > 0, 'сгиб — перфорация');
  assert(MATERIAL_PRESETS.length >= 6, 'набор материалов');
  assert(MATERIAL_PRESETS.every((m) => m.cutSpeed > 0 && m.cutPower > 0), 'режимы материалов заполнены');
  assert.equal(fmtMm(1.006, 2), '1.01');
  assert.equal(fmtMm(2.5), '2.5');
  assert.equal(fmtMm(-0), '0');
  assert(luid('x') !== luid('x'), 'идентификаторы уникальны');
}

// ---------------- геометрия примитивов ----------------
{
  const rect: LaserShape = {
    id: 'r', kind: 'rect', layer: 'cut', name: 'Прямоугольник',
    x: 10, y: 20, w: 30, h: 15, rx: 0, rot: 0, filled: false,
  };
  const pl = shapeToPolylines(rect);
  assert.equal(pl.length, 1);
  assert.equal(pl[0].length, 5, 'прямоугольник замкнут повтором первой точки');
  const bb = shapeBBox(rect);
  assert.deepEqual(bb, [10, 20, 40, 35]);

  const rounded: LaserShape = { ...rect, rx: 3 };
  const rpl = shapeToPolylines(rounded)[0];
  assert(rpl.length > 20, `скруглённый прямоугольник аппроксимируется дурами: ${rpl.length} точек`);
  assert.deepEqual(shapeBBox(rounded), bb, 'скругление не меняет габарит');

  const circle: LaserShape = {
    id: 'c', kind: 'ellipse', layer: 'inner', name: 'Отверстие',
    cx: 0, cy: 0, rx: 5, ry: 5, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const cpl = shapeToPolylines(circle)[0];
  assert(cpl.length >= 37, 'окружность: не менее 36 сегментов');
  const cbb = shapeBBox(circle);
  assert(near(cbb[0], -5, 0.02) && near(cbb[2], 5, 0.02), `габарит окружности ${cbb}`);
  // 36-угольник чуть меньше круга: допуск на аппроксимацию
  assert(near(ringArea(cpl), Math.PI * 25, 0.5), `площадь круга ≈ πr²: ${ringArea(cpl)}`);

  const arc: LaserShape = { ...circle, startAngle: 0, endAngle: 90 };
  const abb = shapeBBox(arc);
  assert(near(abb[0], 0, 0.01) && near(abb[1], 0, 0.01), 'дуга 0…90° в первом квадранте');

  const hex: LaserShape = {
    id: 'h', kind: 'polygon', layer: 'cut', name: 'Шестигранник',
    cx: 0, cy: 0, r: 10, sides: 6, star: false, innerRatio: 0.45, rot: 0, filled: false,
  };
  assert.equal(shapeToPolylines(hex)[0].length, 7, 'шестиугольник: 6 углов + замыкание');
  const star: LaserShape = { ...hex, star: true };
  assert.equal(shapeToPolylines(star)[0].length, 13, 'звезда: 12 лучей + замыкание');
  assert(shapeBBox(star)[2] <= shapeBBox(hex)[2] + 1e-9, 'звезда не выходит за описанную окружность');

  const curve: LaserShape = {
    id: 'p', kind: 'path', layer: 'cut', name: 'Кривая',
    nodes: [
      { x: 0, y: 0, cp2x: 3, cp2y: 10 },
      { x: 10, y: 0, cp1x: 7, cp1y: 10 },
    ],
    closed: false, filled: false,
  };
  const cpts = shapeToPolylines(curve)[0];
  assert(cpts.length > 10, `кривая Безье сэмплируется: ${cpts.length} точек`);
  assert(near(cpts[0].x, 0) && near(cpts[0].y, 0), 'кривая начинается в первом узле');
  assert(near(cpts[cpts.length - 1].x, 10) && near(cpts[cpts.length - 1].y, 0), 'кривая кончается в последнем узле');
  assert(cpts.some((q) => q.y > 6), `кривая уходит вверх за счёт рычагов: max ${Math.max(...cpts.map((q) => q.y))}`);
  assert(near(Math.max(...cpts.map((q) => q.y)), 7.5, 0.2), 'вершина дуги ≈ 3/4 высоты рычагов');

  const txt: LaserShape = {
    id: 't', kind: 'text', layer: 'engrave', name: 'Надпись',
    x: 0, y: 0, text: 'A1', size: 10, strokeWidth: 0.4, rot: 0, mirror: false, filled: true,
  };
  const tpl = shapeToPolylines(txt);
  assert(tpl.length >= 2, `штриховой шрифт даёт несколько сегментов: ${tpl.length}`);

  const dim: LaserShape = {
    id: 'd', kind: 'dim', layer: 'guide', name: 'Размер',
    x1: 0, y1: 0, x2: 50, y2: 0, offset: 10,
  };
  const dpl = shapeToPolylines(dim);
  assert.equal(dpl.length, 3, 'размер: две выносные линии и размерная');
  assert(near(dpl[2][0].y, 10) && near(dpl[2][1].y, 10), 'размерная линия вынесена на offset');

  // поворот прямоугольника вокруг собственного центра: x/y не меняются, габарит разворачивается
  const rotRect = rotateShape(rect, 25, 27.5, 90) as typeof rect;
  assert(near(rotRect.rot, 90));
  assert(near(rotRect.x, 10) && near(rotRect.y, 20), `поворот вокруг центра: ${rotRect.x},${rotRect.y}`);
  assert.deepEqual(shapeBBox(rotRect), [17.5, 12.5, 32.5, 42.5], 'габарит повёрнутого прямоугольника');
  // поворот вокруг начала координат переносит объект
  const rotOrigin = rotateShape(rect, 0, 0, 90) as typeof rect;
  assert(near(rotOrigin.x, -42.5) && near(rotOrigin.y, 17.5), `поворот вокруг (0;0): ${rotOrigin.x},${rotOrigin.y}`);
  assert(near(rotPt({ x: 1, y: 0 }, 0, 0, 90).y, 1), 'rotPt: (1;0) → (0;1)');
}

// ---------------- попадание курсора ----------------
{
  const filledRect: LaserShape = {
    id: 'fr', kind: 'rect', layer: 'cut', name: 'Залитый',
    x: 0, y: 0, w: 40, h: 20, rx: 0, rot: 0, filled: true,
  };
  const outlineRect: LaserShape = { ...filledRect, id: 'or', filled: false };
  assert.equal(hitShape(filledRect, { x: 20, y: 10 }), true, 'клик внутри залитой фигуры');
  assert.equal(hitShape(outlineRect, { x: 20, y: 10 }), false, 'клик внутри контурной фигуры — мимо');
  assert.equal(hitShape(outlineRect, { x: 20, y: 0.2 }, 0.5), true, 'клик по линии контура');
  assert.equal(hitShape(outlineRect, { x: 200, y: 200 }), false, 'клик далеко за габаритом');
  const circle: LaserShape = {
    id: 'hc', kind: 'ellipse', layer: 'cut', name: 'Круг',
    cx: 10, cy: 10, rx: 6, ry: 6, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  assert.equal(hitShape(circle, { x: 16, y: 10 }, 0.5), true, 'попадание в край окружности');
  assert.equal(hitShape(circle, { x: 10, y: 10 }, 0.5), false, 'центр пустой окружности не ловится');
}

// ---------------- трансформации ----------------
{
  const rect: LaserShape = {
    id: 'r', kind: 'rect', layer: 'cut', name: 'R', x: 10, y: 10, w: 20, h: 10, rx: 0, rot: 0, filled: false,
  };
  const moved = translateShape(rect, 5, -3);
  assert.deepEqual(shapeBBox(moved), [15, 7, 35, 17]);

  const scaled = scaleShape(rect, 10, 10, 2, 3);
  assert.deepEqual(shapeBBox(scaled), [10, 10, 50, 40], 'масштаб от левого нижнего угла');

  const mirrored = mirrorShape(rect, 40, 15, 'h');
  assert.deepEqual(shapeBBox(mirrored), [50, 10, 70, 20], 'зеркало по вертикальной оси x=40');
  const mirroredV = mirrorShape(rect, 20, 30, 'v');
  assert.deepEqual(shapeBBox(mirroredV), [10, 40, 30, 50], 'зеркало по горизонтальной оси y=30');

  const txt: LaserShape = {
    id: 't', kind: 'text', layer: 'engrave', name: 'T',
    x: 30, y: 5, text: 'PSB', size: 6, strokeWidth: 0.3, rot: 0, mirror: false, filled: true,
  };
  const tm = mirrorShape(txt, 30, 0, 'h') as typeof txt;
  assert.equal(tm.mirror, true, 'зеркало текста инвертирует надпись, а не переносит её');
  assert.equal(tm.x, 30, 'текст на оси зеркала остаётся на месте');

  const curve: LaserShape = {
    id: 'cv', kind: 'path', layer: 'cut', name: 'C',
    nodes: [{ x: 0, y: 0, cp2x: 4, cp2y: 4 }, { x: 10, y: 0, cp1x: 6, cp1y: 4 }],
    closed: false, filled: false,
  };
  const cm = translateShape(curve, 2, 3) as PathShape;
  assert.equal(cm.nodes[0].x, 2);
  assert.equal(cm.nodes[0].y, 3);
  assert.equal(cm.nodes[0].cp2x, 6, 'перенос двигает исходящий рычаг');
  assert.equal(cm.nodes[0].cp2y, 7);
  assert.equal(cm.nodes[1].cp1x, 8, 'перенос двигает входящий рычаг');
  const cs = scaleShape(curve, 0, 0, 2, 1) as PathShape;
  assert.equal(cs.nodes[1].x, 20, 'масштаб кривой двигает узлы');
  assert.equal(cs.nodes[0].cp2x, 8, 'масштаб кривой двигает рычаги');

  const grouped = selectionBBox([rect, txt])!;
  assert(near(grouped[0], 10), `габарит выделения слева: ${grouped[0]}`);
  assert(grouped[2] > 30, `надпись расширяет выделение вправо: ${grouped[2]}`);
  assert(grouped[1] <= 5 && grouped[3] >= 20, 'габарит охватывает оба объекта');
  assert.equal(selectionBBox([]), null);
}

// ---------------- «В кривые» (Convert to Curves) ----------------
{
  const rect: LaserShape = {
    id: 'r', kind: 'rect', layer: 'cut', name: 'R', x: 0, y: 0, w: 20, h: 10, rx: 0, rot: 0, filled: false,
  };
  const [curve] = shapeToPath(rect);
  assert.equal(curve.kind, 'path');
  assert.equal(curve.nodes.length, 4, 'прямоугольник → 4 узла');
  assert.equal(curve.closed, true);
  assert.deepEqual(shapeBBox(curve), shapeBBox(rect), 'габарит после конвертации не меняется');

  const circle: LaserShape = {
    id: 'c', kind: 'ellipse', layer: 'cut', name: 'C',
    cx: 0, cy: 0, rx: 10, ry: 10, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const [cc] = shapeToPath(circle);
  assert.equal(cc.nodes.length, 4, 'окружность → 4 узла с рычагами');
  assert(cc.nodes.every((n) => n.smooth && n.cp1x !== undefined && n.cp2x !== undefined), 'все узлы гладкие');
  const approx = ringArea(nodesToPts(cc.nodes, true));
  assert(near(approx, Math.PI * 100, 0.6), `площадь кривой окружности ≈ πr²: ${approx}`);

  const arc: LaserShape = { ...circle, endAngle: 180 };
  const [ac] = shapeToPath(arc);
  assert.equal(ac.closed, false, 'дуга остаётся разомкнутой');

  const hex: LaserShape = {
    id: 'h', kind: 'polygon', layer: 'cut', name: 'H',
    cx: 0, cy: 0, r: 8, sides: 6, star: false, innerRatio: 0.5, rot: 0, filled: true,
  };
  const [hc] = shapeToPath(hex);
  assert.equal(hc.nodes.length, 6, 'шестиугольник → 6 узлов');
  assert.equal(hc.filled, true, 'заливка сохраняется');

  const txt: LaserShape = {
    id: 't', kind: 'text', layer: 'engrave', name: 'T',
    x: 0, y: 0, text: 'AB', size: 10, strokeWidth: 0.4, rot: 0, mirror: false, filled: false,
  };
  const curves = shapeToPath(txt);
  assert(curves.length >= 2 && curves.every((c) => c.kind === 'path'), 'текст → набор кривых');
  assert.equal(shapeToPath(curves[0]).length, 1, 'кривая остаётся собой');
}

// ---------------- булевы операции и керф ----------------
{
  const a: LaserShape = {
    id: 'a', kind: 'rect', layer: 'cut', name: 'A', x: 0, y: 0, w: 20, h: 20, rx: 0, rot: 0, filled: false,
  };
  const b: LaserShape = { ...a, id: 'b', name: 'B', x: 10, y: 10 };

  const union = booleanShapes([a, b], 'union');
  assert.equal(union.length, 1, 'объединение даёт один контур');
  assert(near(pathArea(union[0]), 20 * 20 + 20 * 20 - 10 * 10, 0.5), `площадь объединения ${pathArea(union[0])}`);
  assert.deepEqual(shapeBBox(union[0]), [0, 0, 30, 30]);

  const trim = booleanShapes([a, b], 'subtract');
  assert.equal(trim.length, 1);
  assert(near(pathArea(trim[0]), 300, 0.5), 'вычитание оставляет 300 мм²');

  const inter = booleanShapes([a, b], 'intersect');
  assert.equal(inter.length, 1);
  assert(near(pathArea(inter[0]), 100, 0.5), 'пересечение 10×10 = 100 мм²');

  const xor = booleanShapes([a, b], 'xor');
  assert.equal(xor.length, 2, `исключение даёт два контура, получено ${xor.length}`);
  const xorArea = xor.reduce((s, x) => s + pathArea(x), 0);
  assert(near(xorArea, 300 + 300, 1), `исключение: 300 + 300 мм², получено ${xorArea}`);

  // дырка от вычитания вложенного прямоугольника
  const hole = booleanShapes([a, { ...b, x: 5, y: 5, w: 5, h: 5 }], 'subtract');
  assert.equal(hole.length, 1);
  assert(hole[0].holes?.length === 1, 'вложенный объект становится отверстием');
  assert(near(pathArea(hole[0]), 400 - 25, 0.5), 'площадь с отверстием');

  assert.deepEqual(booleanShapes([a], 'union'), [], 'для булевых операций нужно два объекта');

  // керф: наружу контур растёт, внутрь — уменьшается
  const out = offsetShape(a, 0.5, 'cut');
  assert.equal(out.length, 1);
  assert.deepEqual(shapeBBox(out[0]), [-0.5, -0.5, 20.5, 20.5], 'контур наружу на 0,5 мм');
  assert.equal(out[0].layer, 'cut', 'контур перенесён на выбранный слой');
  const inn = offsetShape(a, -0.5, 'inner');
  assert.deepEqual(shapeBBox(inn[0]), [0.5, 0.5, 19.5, 19.5], 'контур внутрь на 0,5 мм');
  const same = offsetShape(a, 0);
  assert.deepEqual(shapeBBox(same[0]), shapeBBox(a), 'нулевой отступ не меняет габарит');
  const gone = offsetShape(a, -20);
  assert.equal(gone.length, 0, 'слишком большой внутренний отступ уничтожает контур');

  // скругление углов
  const filleted = filletShapeCorners(a, 3) as typeof a;
  assert.equal(filleted.kind, 'rect');
  assert.equal(filleted.rx, 3, 'прямоугольник скругляется параметром rx');
  const tri: PathShape = {
    id: 'tri', kind: 'path', layer: 'cut', name: 'Треугольник',
    nodes: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 10, y: 18 }], closed: true, filled: false,
  };
  const triF = filletShapeCorners(tri, 2) as PathShape;
  assert.equal(triF.kind, 'path');
  assert(triF.nodes.length > tri.nodes.length, `скругление добавляет точки: ${triF.nodes.length}`);
  const triBB0 = shapeBBox(tri);
  const triBB1 = shapeBBox(triF);
  assert(triBB1[2] - triBB1[0] <= triBB0[2] - triBB0[0] + 1e-6, 'скругление не увеличивает габарит');
}

// ---------------- выравнивание, массивы, автораскладка ----------------
{
  const mk = (id: string, x: number, y: number, w: number, h: number): LaserShape => ({
    id, kind: 'rect', layer: 'cut', name: id, x, y, w, h, rx: 0, rot: 0, filled: false,
  });
  const shapes = [mk('a', 0, 0, 10, 10), mk('b', 30, 20, 20, 5), mk('c', 5, 40, 8, 8)];

  const left = alignShapes(shapes, new Set(['a', 'b', 'c']), 'left', 200, 200);
  assert(left.every((s) => near(shapeBBox(s)[0], 0)), 'выравнивание по левому краю');

  const bottom = alignShapes(shapes, new Set(['a', 'b', 'c']), 'bottom', 200, 200);
  assert(bottom.every((s) => near(shapeBBox(s)[1], 0)), 'выравнивание по нижнему краю');

  const centerX = alignShapes(shapes, new Set(['a', 'b', 'c']), 'center-x', 200, 200);
  const centers = centerX.map((s) => {
    const bb = shapeBBox(s);
    return (bb[0] + bb[2]) / 2;
  });
  assert(centers.every((c) => near(c, centers[0], 1e-6)), 'центры по X совпадают');

  const page = alignShapes(shapes, new Set(['a', 'b', 'c']), 'page-center', 100, 80);
  const pbb = selectionBBox(page)!;
  assert(near((pbb[0] + pbb[2]) / 2, 50, 1e-6) && near((pbb[1] + pbb[3]) / 2, 40, 1e-6), 'центр по листу');

  const distX = alignShapes(shapes, new Set(['a', 'b', 'c']), 'distribute-x', 200, 200);
  const cx = distX.map((s) => {
    const bb = shapeBBox(s);
    return (bb[0] + bb[2]) / 2;
  }).sort((p, q) => p - q);
  assert(near(cx[1] - cx[0], cx[2] - cx[1], 1e-6), 'равные промежутки по X');

  const distY = alignShapes(shapes, new Set(['a', 'b', 'c']), 'distribute-y', 200, 200);
  const cy = distY.map((s) => {
    const bb = shapeBBox(s);
    return (bb[1] + bb[3]) / 2;
  }).sort((p, q) => p - q);
  assert(near(cy[1] - cy[0], cy[2] - cy[1], 1e-6), 'равные промежутки по Y');

  const arr = arrayShapes([shapes[0]], 3, 4, 2, 3);
  assert.equal(arr.length, 11, 'массив 3×4 добавляет 11 копий');
  assert(arr.every((s) => s.id !== shapes[0].id), 'копии получают новые идентификаторы');
  const abb = selectionBBox([shapes[0], ...arr])!;
  assert(near(abb[2] - abb[0], 4 * 10 + 3 * 2, 1e-6), 'ширина массива: 4 детали + 3 зазора');
  assert(near(abb[3] - abb[1], 3 * 10 + 2 * 3, 1e-6), 'высота массива');
  assert.deepEqual(arrayShapes([], 2, 2, 1, 1), [], 'пустое выделение не размножается');

  // автораскладка: детали не пересекаются и остаются на листе
  const doc = newLaserDoc(200, 150, 'Раскладка');
  doc.shapes = [
    mk('p1', 300, 300, 40, 40),
    mk('p2', -50, 10, 30, 60),
    mk('p3', 10, 200, 25, 25),
    { id: 'hole', kind: 'ellipse', layer: 'inner', name: 'Отверстие в p1', cx: 320, cy: 320, rx: 4, ry: 4, rot: 0, startAngle: 0, endAngle: 360, filled: false },
  ];
  const nested = autoNestShapes(doc.shapes, doc.w, doc.h, 5, 3);
  assert.equal(nested.length, doc.shapes.length, 'число объектов сохранено');
  for (const s of nested) {
    const bb = shapeBBox(s);
    assert(bb[0] >= 4.5 && bb[1] >= 4.5, `деталь ${s.id} в пределах отступа: ${bb}`);
    assert(bb[2] <= doc.w + 0.5 && bb[3] <= doc.h + 0.5, `деталь ${s.id} на листе: ${bb}`);
  }
  // вложенное отверстие переехало вместе со своей панелью
  const panel = nested.find((s) => s.id === 'p1')!;
  const holeShape = nested.find((s) => s.id === 'hole')!;
  const panelBB = shapeBBox(panel);
  const holeBB = shapeBBox(holeShape);
  assert(holeBB[0] >= panelBB[0] - 0.5 && holeBB[2] <= panelBB[2] + 0.5
    && holeBB[1] >= panelBB[1] - 0.5 && holeBB[3] <= panelBB[3] + 0.5,
    'отверстие осталось внутри панели после раскладки');
  // наружные детали не пересекаются
  const big = nested.filter((s) => s.id !== 'hole');
  for (let i = 0; i < big.length; i++) {
    for (let j = i + 1; j < big.length; j++) {
      const A = shapeBBox(big[i]);
      const B = shapeBBox(big[j]);
      const overlap = !(A[2] <= B[0] + 0.01 || B[2] <= A[0] + 0.01 || A[3] <= B[1] + 0.01 || B[3] <= A[1] + 0.01);
      assert.equal(overlap, false, `детали ${big[i].id} и ${big[j].id} не пересекаются`);
    }
  }
}

// ---------------- инструмент «Форма»: узлы кривой ----------------
{
  const curve: PathShape = {
    id: 'c', kind: 'path', layer: 'cut', name: 'Кривая',
    nodes: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 }],
    closed: true, filled: false,
  };
  assert.equal(nearestNodeIndex(curve, { x: 0.4, y: 0.2 }, 1), 0, 'ближайший узел');
  assert.equal(nearestNodeIndex(curve, { x: 50, y: 50 }, 1), -1, 'узлов рядом нет');

  const hit = nearestOnCurve(curve, { x: 10, y: 1 })!;
  assert.equal(hit.seg, 0);
  assert(near(hit.dist, 1), 'расстояние до нижнего ребра');
  assert(near(hit.point.x, 10) && near(hit.point.y, 0), 'проекция точки на ребро');

  const ins = insertNode(curve, { x: 10, y: 1 })!;
  assert.equal(ins.index, 1, 'узел вставлен после первого сегмента');
  assert.equal(ins.shape.nodes.length, 5);
  assert(near(ins.shape.nodes[1].x, 10) && near(ins.shape.nodes[1].y, 0), 'узел на кривой');

  const del = deleteNode(curve, 1)!;
  assert.equal(del.nodes.length, 3);
  assert.equal(deleteNode({ ...curve, nodes: curve.nodes.slice(0, 3) }, 0), null, 'треугольник нельзя уменьшить');

  const smooth = toggleSmooth(curve, 1);
  assert.equal(smooth.nodes[1].smooth, true, 'узел стал гладким');
  assert(smooth.nodes[1].cp1x !== undefined && smooth.nodes[1].cp2x !== undefined, 'появились рычаги');
  const cusp = toggleSmooth(smooth, 1);
  assert.equal(cusp.nodes[1].smooth, false, 'узел снова угловой');
  assert.equal(cusp.nodes[1].cp1x, undefined, 'рычаги убраны');

  const moved = moveNode(curve, 1, { x: 25, y: 5 });
  assert.equal(moved.nodes[1].x, 25);
  assert.equal(moved.nodes[0].x, 0, 'соседние узлы не двигаются');

  const withHandles: PathShape = {
    ...curve,
    nodes: [{ x: 0, y: 0, cp2x: 5, cp2y: 5 }, { x: 20, y: 0, cp1x: 15, cp1y: 5, smooth: true }],
  };
  assert.equal(nearestHandle(withHandles, 0, { x: 5, y: 5 }, 0.5), 'cp2', 'рычаг cp2 найден');
  assert.equal(nearestHandle(withHandles, 1, { x: 15, y: 5 }, 0.5), 'cp1', 'рычаг cp1 найден');
  assert.equal(nearestHandle(withHandles, 0, { x: 50, y: 50 }, 0.5), null);
  const h = moveHandle(withHandles, 1, 'cp1', { x: 10, y: 8 });
  assert.equal(h.nodes[1].cp1x, 10, 'рычаг перемещён');
  assert(h.nodes[1].cp2x !== 15, 'гладкий узел двигает второй рычаг симметрично');

  const c45 = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 3 }, 15);
  const ang = (Math.atan2(c45.y, c45.x) * 180) / Math.PI;
  assert(near(ang / 15, Math.round(ang / 15), 1e-9), `угол кратен 15°: ${ang}`);
  assert.equal(Math.round(ang / 15) * 15, 15, 'исходные 16,7° snapped до 15°');
  assert(near(Math.hypot(c45.x, c45.y), Math.hypot(10, 3), 1e-9), 'длина сохранена');

  const snaps = [{ x: 1, y: 1 }, { x: 9, y: 9 }];
  assert.deepEqual(nearestSnapPoint(snaps, { x: 1.2, y: 0.9 }, 0.5), { x: 1, y: 1 }, 'привязка к узлу');
  assert.equal(nearestSnapPoint(snaps, { x: 5, y: 5 }, 0.5), null, 'вне допуска привязки нет');

  // угловой узел: перетаскивание одного рычага не создаёт второй из ничего
  const cuspCurve: PathShape = {
    ...curve,
    nodes: [{ x: 0, y: 0 }, { x: 20, y: 0, cp2x: 30, cp2y: 5 }],
  };
  const movedCp = moveHandle(cuspCurve, 1, 'cp2', { x: 25, y: 10 });
  assert.equal(movedCp.nodes[1].cp2x, 25, 'рычаг перемещён');
  assert.equal(movedCp.nodes[1].cp1x, undefined, 'у углового узла второй рычаг не появляется');

  // удаление крайнего узла открытой кривой снимает рычаги, которые больше не работают
  const openCurve: PathShape = {
    id: 'o', kind: 'path', layer: 'cut', name: 'Открытая',
    nodes: [
      { x: 0, y: 0, cp1x: -5, cp1y: 0 },
      { x: 10, y: 0, cp1x: 5, cp1y: 5, cp2x: 15, cp2y: 5 },
      { x: 20, y: 0, cp2x: 25, cp2y: 0 },
    ],
    closed: false, filled: false,
  };
  const noFirst = deleteNode(openCurve, 0)!;
  assert.equal(noFirst.nodes.length, 2, 'узел удалён');
  assert.equal(noFirst.nodes[0].cp1x, undefined, 'висячий входящий рычаг снят');
  assert.equal(noFirst.nodes[0].cp2x, 15, 'рабочий исходящий рычаг остался');
  const noLast = deleteNode(openCurve, 2)!;
  assert.equal(noLast.nodes[1].cp2x, undefined, 'висячий исходящий рычаг снят');
  assert.equal(noLast.nodes[1].cp1x, 5, 'рабочий входящий рычаг остался');
  const mid = deleteNode(openCurve, 1)!;
  assert.equal(mid.nodes.length, 2, 'средний узел удалён');
  assert.equal(mid.nodes[0].cp1x, undefined, 'новая первая точка потеряла висячий рычаг');
  assert.equal(mid.nodes[1].cp2x, undefined, 'новая последняя точка потеряла висячий рычаг');
  // у замкнутой кривой «крайних» узлов нет: рычаги работают все, снимать их нельзя
  const closedCurve: PathShape = {
    id: 'cl', kind: 'path', layer: 'cut', name: 'Замкнутая',
    nodes: [...openCurve.nodes, { x: 20, y: 10 }],
    closed: true, filled: false,
  };
  const closedDel = deleteNode(closedCurve, 3)!;
  assert.equal(closedDel.nodes.length, 3, 'у замкнутой кривой минимум три узла');
  assert.equal(closedDel.nodes[0].cp1x, -5, 'входящий рычаг замыкания остался');
  assert.equal(closedDel.nodes[2].cp2x, 25, 'исходящий рычаг замыкания остался');
  assert.equal(deleteNode({ ...closedCurve, nodes: closedCurve.nodes.slice(0, 3) }, 0), null,
    'замкнутый треугольник уменьшить нельзя');

  // привязка к объектам видит примитивы, а не только кривые с полем nodes
  const snapRect: LaserShape = {
    id: 'sr', kind: 'rect', layer: 'cut', name: 'Прямоугольник',
    x: 0, y: 0, w: 40, h: 20, rx: 0, rot: 0, filled: false,
  };
  const snapCircle: LaserShape = {
    id: 'sc', kind: 'ellipse', layer: 'cut', name: 'Окружность',
    cx: 100, cy: 100, rx: 25, ry: 25, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const snapDim: LaserShape = {
    id: 'sd', kind: 'dim', layer: 'dim', name: 'Размер',
    x1: 0, y1: -10, x2: 40, y2: -10, offset: 5,
  };
  const pts = objectSnapPoints([snapRect, snapCircle, snapDim]);
  const has = (x: number, y: number) => pts.some((p) => near(p.x, x, 1e-9) && near(p.y, y, 1e-9));
  assert(has(0, 0) && has(40, 20), 'углы прямоугольника доступны для привязки');
  assert(has(20, 0) && has(0, 10), 'середины прямых рёбер');
  assert(has(20, 10), 'центр габарита');
  assert(has(75, 100) && has(100, 125) && has(125, 100), 'четверти окружности');
  assert(has(100, 100), 'центр окружности');
  assert(has(0, -10) && has(40, -10), 'концы размерной линии');
  assert(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), 'привязки без NaN');
  assert.deepEqual(objectSnapPoints([], [{ x: 3, y: 4 }]), [{ x: 3, y: 4 }], 'свои точки не теряются');
}

// ---------------- генератор развёрток ----------------
{
  const base: UnfoldParams = { ...DEFAULT_UNFOLD_PARAMS, length: 100, width: 70, height: 40, thickness: 3 };
  const byLayer = (shapes: LaserShape[], layer: string) => shapes.filter((s) => s.layer === layer);

  for (const tpl of UNFOLD_TEMPLATES) {
    const { shapes, groups } = generateUnfolding({ ...base, template: tpl.id }, 12, 12);
    assert(shapes.length > 0, `${tpl.id}: развёртка не пуста`);
    assert(byLayer(shapes, 'cut').length > 0, `${tpl.id}: есть контуры резки`);
    assert(shapes.every((s) => Number.isFinite(shapeBBox(s)[0])), `${tpl.id}: координаты конечны`);
    assert(groups.length > 0, `${tpl.id}: детали объединены в группы`);
    assert(shapes.every((s) => groups.some((g) => g.id === s.groupId)), `${tpl.id}: у каждого объекта есть группа`);
    const bb = selectionBBox(shapes)!;
    assert(bb[0] >= 0 && bb[1] >= 0, `${tpl.id}: развёртка начинается от (0;0): ${bb}`);
  }

  // 1. Складная коробка: единый контур + линии сгиба + отверстия под плату + размеры
  {
    const { shapes } = generateUnfolding({ ...base, template: 'folded-box', pcbMount: true, openTop: false }, 15, 15);
    const outline = byLayer(shapes, 'cut');
    assert.equal(outline.length, 1, 'складная коробка — один внешний контур');
    assert((outline[0] as PathShape).closed, 'контур замкнут');
    assert((outline[0] as PathShape).nodes.length >= 16, 'контур с клапанами');
    assert(byLayer(shapes, 'fold').length >= 8, `линии сгиба: ${byLayer(shapes, 'fold').length}`);
    assert.equal(byLayer(shapes, 'inner').length, 4, 'четыре отверстия под стойки платы');
    assert(byLayer(shapes, 'guide').length >= 2, 'размерные линии');
    assert(byLayer(shapes, 'score').length >= 1, 'маркировка');
    const openVariants = generateUnfolding({ ...base, template: 'folded-box', openTop: true }, 15, 15).shapes;
    assert(
      byLayer(openVariants, 'fold').length < byLayer(shapes, 'fold').length,
      'без крышки линий сгиба меньше'
    );
  }

  // 2. Шиповой корпус: 6 панелей общего движка коробок, габариты наружные
  {
    const p: UnfoldParams = {
      ...base, template: 'finger-box', length: 90, width: 60, height: 35, thickness: 3,
      fingerWidth: 12, clearance: 0, openTop: false, pcbMount: false,
    };
    const { shapes, groups } = generateUnfolding(p, 12, 12);
    const panels = byLayer(shapes, 'cut');
    assert.equal(panels.length, 6, `закрытая коробка: 6 панелей, получено ${panels.length}`);
    const dims = (s: LaserShape): [number, number] => {
      const b = shapeBBox(s);
      return [b[2] - b[0], b[3] - b[1]].sort((a, c) => a - c) as [number, number];
    };

    const btm = panels.find((s) => s.name === 'Дно')! as PathShape;
    const bb = shapeBBox(btm);
    // Дно и крышка — внешние панели: габарит равен наружному размеру коробки
    assert.deepEqual(dims(btm), [66, 96], 'дно (90+2·3)×(60+2·3) мм');
    assert(btm.nodes.some((n) => near(n.y, bb[1] + 3, 0.05)), 'пазы дна выбраны внутрь на толщину листа');

    const front = panels.find((s) => s.name === 'Стенка передняя')! as PathShape;
    const fb = shapeBBox(front);
    assert.deepEqual(dims(front), [41, 96], 'передняя стенка: наружная ширина, высота с шипами низа и верха');
    assert(front.nodes.some((n) => near(n.y, fb[1] + 3, 0.05)), 'основание шипов на толщину выше торцов');
    assert(front.nodes.length > 20, 'кромки с шипами описаны подробно');

    const side = panels.find((s) => s.name === 'Стенка левая')! as PathShape;
    assert.deepEqual(dims(side), [41, 66], 'боковая стенка короче дна на две толщины, шипы по торцам');

    const openShapes = generateUnfolding({ ...p, openTop: true }, 12, 12).shapes;
    assert.equal(byLayer(openShapes, 'cut').length, 5, 'открытая коробка: 5 панелей');
    const openFront = byLayer(openShapes, 'cut').find((s) => s.name === 'Стенка передняя')! as PathShape;
    assert.deepEqual(dims(openFront), [38, 96], 'без крышки шипы только на нижнем торце');

    // Зазор посадки расширяет пазы, но габарит детали остаётся точным
    const loose = generateUnfolding({ ...p, clearance: 0.3 }, 12, 12).shapes;
    const looseFront = byLayer(loose, 'cut').find((s) => s.name === 'Стенка передняя')! as PathShape;
    assert.deepEqual(dims(looseFront), dims(front), 'зазор не меняет габарит стенки');
    assert(looseFront.nodes.length >= front.nodes.length, 'пазы с зазором описаны подробнее');

    const withPcb = generateUnfolding({ ...p, pcbMount: true, pcbHoleDistX: 70, pcbHoleDistY: 45, holeD: 3.2 }, 12, 12).shapes;
    assert(byLayer(withPcb, 'inner').length >= 4, 'отверстия под печатную плату');
    assert.equal(groups.length, 6, 'каждая панель — своя группа');
    assert(shapes.some((s) => s.layer === 'engrave'), 'детали подписаны');
  }

  // 3. П-образное шасси: контур, две линии гиба, вентиляция, отверстия платы
  {
    const { shapes } = generateUnfolding({ ...base, template: 'bent-case', pcbMount: true }, 15, 15);
    assert.equal(byLayer(shapes, 'cut').length, 1, 'один внешний контур шасси');
    assert.equal(byLayer(shapes, 'fold').length, 2, 'две линии гиба бортов');
    const inner = byLayer(shapes, 'inner');
    assert(inner.length >= 4, `отверстия платы и вентиляция: ${inner.length}`);
    assert(inner.some((s) => s.name.startsWith('Вент')), 'вентиляционные пазы');
    const outline = byLayer(shapes, 'cut')[0];
    assert.equal(outline.kind, 'rect');
    assert(near((outline as { w: number }).w, 100 + 2 * 40, 1e-6), 'развёртка: база + два борта');
  }

  // 4. Цилиндр и конус
  {
    const cyl = generateUnfolding({ ...base, template: 'cylinder-cone', length: 60, topDiameter: 60, height: 40, fingerWidth: 10 }, 15, 15).shapes;
    const side = byLayer(cyl, 'cut').find((s) => s.name.includes('цилиндра'))!;
    assert.equal(side.kind, 'rect', 'цилиндр разворачивается в прямоугольник');
    assert(near((side as { w: number }).w, Math.PI * 60 + 10, 0.01), 'ширина боковой развёртки = πD + клапан');
    assert(near((side as { h: number }).h, 40, 0.01), 'высота развёртки');
    assert.equal(byLayer(cyl, 'fold').length, 1, 'линия сгиба шва');
    assert(byLayer(cyl, 'cut').some((s) => s.name.startsWith('Нижнее дно')), 'дно цилиндра');

    const cone = generateUnfolding({ ...base, template: 'cylinder-cone', length: 80, topDiameter: 40, height: 50 }, 15, 15).shapes;
    const coneSide = byLayer(cone, 'cut').find((s) => s.name.includes('конуса'))! as PathShape;
    assert.equal(coneSide.kind, 'path', 'конус разворачивается в круговой сектор');
    assert(coneSide.closed, 'сектор замкнут');
    const cbb = shapeBBox(coneSide);
    assert(cbb[2] - cbb[0] > 10 && cbb[3] - cbb[1] > 10, 'сектор не вырожден');
  }

  // 5. Лицевая панель
  {
    const { shapes } = generateUnfolding({
      ...base, template: 'front-panel', length: 140, width: 70, displayW: 60, displayH: 28,
      controlsCount: 3, titleText: 'PSBEES', holeD: 3.2,
    }, 20, 20);
    assert.equal(byLayer(shapes, 'cut').length, 1, 'контур панели');
    const inner = byLayer(shapes, 'inner');
    assert(inner.some((s) => s.name.includes('дисплея')), 'окно дисплея');
    assert.equal(inner.filter((s) => s.name.startsWith('Отверстие регулятора')).length, 3, 'три регулятора');
    assert.equal(inner.filter((s) => s.name.includes('Крепёжное')).length, 4, 'четыре крепёжных отверстия');
    assert(byLayer(shapes, 'engrave').some((s) => s.kind === 'text'), 'гравировка надписи');
    assert(byLayer(shapes, 'score').some((s) => s.name.includes('Шкала')), 'шкалы регуляторов');
  }

  // 6. Гибкий рез
  {
    const { shapes } = generateUnfolding({ ...base, template: 'living-hinge', length: 120, width: 60, height: 40 }, 20, 20);
    assert.equal(byLayer(shapes, 'cut').length, 1, 'внешний контур');
    const kerfs = byLayer(shapes, 'inner');
    assert(kerfs.length >= 5, `прорези шарнира: ${kerfs.length}`);
    assert(kerfs.every((s) => s.kind === 'path' && !(s as PathShape).closed), 'прорези — разомкнутые линии');
    for (const k of kerfs) {
      const bb = shapeBBox(k);
      assert(bb[0] >= 20 && bb[2] <= 20 + 120, 'прорези внутри детали');
    }
  }

  // 7. Шестерня
  {
    const Z = 20;
    const m = 2;
    const { shapes } = generateUnfolding({ ...base, template: 'gear', gearTeeth: Z, gearModule: m, holeD: 5 }, 20, 20);
    const gear = byLayer(shapes, 'cut').find((s) => s.name.includes('Венец'))! as PathShape;
    assert.equal(gear.nodes.length, Z * 5, `профиль зуба: 5 точек на зуб, всего ${gear.nodes.length}`);
    assert(gear.closed, 'венец замкнут');
    const bb = shapeBBox(gear);
    const pitchR = (m * Z) / 2;
    assert(near((bb[2] - bb[0]) / 2, pitchR + m, 0.6), 'радиус вершин = r + m');
    assert(byLayer(shapes, 'inner').some((s) => s.name.includes('Отверстие вала')), 'отверстие под вал');
    assert(byLayer(shapes, 'score').some((s) => s.name.includes('Делительная')), 'делительная окружность');
  }
}

// ---------------- CAM: пунктир, траектория, G-Code ----------------
{
  const doc = newMachineDoc(300, 200, 'CAM тест');
  doc.materialThickness = 3;
  const panel: LaserShape = {
    id: 'panel', kind: 'rect', layer: 'cut', name: 'Панель',
    x: 20, y: 20, w: 100, h: 60, rx: 0, rot: 0, filled: false, tabs: 2, tabWidth: 2,
  };
  const hole: LaserShape = {
    id: 'hole', kind: 'ellipse', layer: 'inner', name: 'Отверстие',
    cx: 50, cy: 50, rx: 5, ry: 5, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const fold: LaserShape = {
    id: 'fold', kind: 'path', layer: 'fold', name: 'Сгиб',
    nodes: [{ x: 20, y: 50 }, { x: 120, y: 50 }], closed: false, filled: false,
  };
  const engrave: LaserShape = {
    id: 'engrave', kind: 'text', layer: 'engrave', name: 'Надпись',
    x: 30, y: 70, text: 'PSB', size: 8, strokeWidth: 0.4, rot: 0, mirror: false, filled: true,
  };
  const dim: LaserShape = {
    id: 'dim', kind: 'dim', layer: 'guide', name: 'Размер',
    x1: 20, y1: 20, x2: 120, y2: 20, offset: -8,
  };
  doc.shapes = [engrave, fold, hole, panel, dim];

  // пунктир биговки
  const dashed = dashPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], 4, 2);
  const totalDash = dashed.reduce((s, pl) => s + Math.hypot(pl[pl.length - 1].x - pl[0].x, pl[pl.length - 1].y - pl[0].y), 0);
  assert(dashed.length >= 16, `перфорация делит линию на штрихи: ${dashed.length}`);
  assert(near(totalDash, 100 * (4 / 6), 4), 'суммарная длина штрихов ≈ 2/3 линии');
  assert.deepEqual(dashPolyline([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0, 0).length, 1, 'без пунктира линия целая');

  // симуляция траектории
  const sim = buildLaserSimulation(doc);
  assert(sim.segments.length > 10, `сегментов траектории: ${sim.segments.length}`);
  assert(sim.cutLengthMm > 0 && sim.rapidLengthMm > 0, 'есть и рез, и холостой ход');
  assert(sim.totalTimeSec > 0, 'время обработки посчитано');
  assert(sim.byLayer.cut.lengthMm > 0, 'слой резки обработан');
  assert.equal(sim.byLayer.guide.count, 0, 'слой размеров не режется');
  // порядок слоёв: гравировка раньше резки
  const firstEngrave = sim.segments.findIndex((s) => s.layer === 'engrave' && !s.rapid);
  const firstCut = sim.segments.findIndex((s) => s.layer === 'cut' && !s.rapid);
  assert(firstEngrave >= 0 && firstCut >= 0 && firstEngrave < firstCut, 'гравировка до внешнего реза');
  const firstInner = sim.segments.findIndex((s) => s.layer === 'inner' && !s.rapid);
  assert(firstInner < firstCut, 'внутренние вырезы до внешнего контура');
  // перемычки: контур панели режется участками, между ними холостые переезды
  const cutSegs = sim.segments.filter((s) => s.layer === 'cut' && !s.rapid);
  const panelPerimeter = 2 * (100 + 60);
  assert(sim.byLayer.cut.lengthMm < panelPerimeter, `перемычки сокращают рез: ${sim.byLayer.cut.lengthMm} < ${panelPerimeter}`);
  assert(cutSegs.length > 4, 'контур с перемычками разбит на участки');
  // скрытые объекты и выключенные слои не обрабатываются
  const hiddenDoc: LaserDoc = { ...doc, shapes: doc.shapes.map((s) => ({ ...s, hidden: true })) };
  assert.equal(buildLaserSimulation(hiddenDoc).segments.length, 0, 'скрытые объекты не режутся');
  const offLayer: LaserDoc = {
    ...doc,
    layers: { ...doc.layers, cut: { ...doc.layers.cut, visible: false } },
  };
  assert.equal(buildLaserSimulation(offLayer).byLayer.cut.count, 0, 'выключенный слой пропускается');

  // G-Code
  const gcode = exportLaserGCode(doc);
  for (const must of ['G21', 'G90', 'M5 S0', 'M8', 'M9', 'M4', 'G0 X', 'G1 X', 'M2', 'X0 Y0']) {
    assert(gcode.includes(must), `в G-Code нет ${must}`);
  }
  assert(gcode.includes('; PSBees Laser CAM'), 'заголовок программы');
  assert(gcode.indexOf('Слой: Заливка области') < gcode.indexOf('Слой: Основной контур') === false
    || gcode.indexOf('Заливка области') < gcode.indexOf('Основной контур'), 'порядок слоёв в программе');
  assert(gcode.indexOf('Заливка области') < gcode.indexOf('Основной контур'),
    'заливка раньше внешнего контура в файле');
  assert(gcode.indexOf('Внутренние контуры') < gcode.indexOf('Основной контур'),
    'отверстия раньше внешнего контура');
  assert(!gcode.includes('Направляющие и размеры'), 'слой размеров не попадает в программу');
  // мощность в S пропорциональна проценту
  const sCut = /M4 S(\d+)/g;
  const sValues = [...gcode.matchAll(sCut)].map((m) => Number(m[1]));
  assert(sValues.includes(Math.round((doc.layers.cut.power / 100) * DEFAULT_GCODE_OPTIONS.maxS)), 'S для слоя резки');
  assert(sValues.includes(Math.round((doc.layers.engrave.power / 100) * DEFAULT_GCODE_OPTIONS.maxS)), 'S для гравировки');
  // несколько проходов
  const multi = exportLaserGCode(doc, { ...DEFAULT_GCODE_OPTIONS });
  const doc2: LaserDoc = {
    ...doc,
    layers: { ...doc.layers, cut: { ...doc.layers.cut, passes: 3 } },
  };
  const g3 = exportLaserGCode(doc2);
  assert(g3.includes('Проход 3 из 3'), 'три прохода резки');
  assert(g3.length > multi.length, 'больше проходов — длиннее программа');
  // режим M3 и без возврата в ноль
  const g3m = exportLaserGCode(doc, { ...DEFAULT_GCODE_OPTIONS, laserMode: 'M3', returnOrigin: false });
  assert(g3m.includes('M3 S'), 'режим M3');
  assert(!g3m.includes('X0 Y0'), 'без возврата в начало координат');

  // SVG
  const svg = exportLaserSvg(doc);
  assert(svg.startsWith('<?xml'), 'SVG с заголовком');
  assert(svg.includes('width="300mm"') && svg.includes('height="200mm"'), 'размер в миллиметрах 1:1');
  assert(svg.includes('id="layer-cut"') && svg.includes('id="layer-fold"'), 'группы слоёв');
  assert(svg.includes('stroke-dasharray="4 2"'), 'пунктир биговки');
  assert(!svg.includes('id="layer-guide"'), 'слой размеров не экспортируется');
  assert(svg.includes('data-name="Панель"'), 'имена объектов сохраняются');

  // DXF — основной формат вывода: точные сущности, миллиметры, R2000 по умолчанию
  const dxf = exportLaserDxf(doc);
  for (const must of ['$ACADVER', 'AC1015', '$INSUNITS', '$EXTMIN', '$EXTMAX', 'TABLES', 'LAYER', 'ENTITIES', 'LINE', 'CIRCLE', 'CUT', 'INNER', 'FOLD', 'EOF']) {
    assert(dxf.includes(must), `в DXF нет ${must}`);
  }
  assert(!dxf.includes('GUIDE'), 'служебный слой не попадает в DXF');
  const lineCount = (dxf.match(/\r\nLINE\r\n/g) ?? []).length;
  assert(lineCount > 20, `отрезков в DXF: ${lineCount}`);
  assert(dxf.includes('$DWGCODEPAGE'), 'кодовая страница для кириллицы в именах слоёв');
  // R12 для старых CAM-программ остаётся доступен
  const dxf12 = exportLaserDxf(doc, { version: 'R12' });
  assert(dxf12.includes('AC1009'), 'R12 = AC1009');
  assert(dxf12.includes('POLYLINE'), 'в R12 полилинии классические POLYLINE/VERTEX');
  assert(!dxf12.includes('LWPOLYLINE'), 'в R12 нет LWPOLYLINE');

  // керф меняет геометрию программы
  const kerfDoc: LaserDoc = {
    ...doc,
    layers: { ...doc.layers, cut: { ...doc.layers.cut, kerf: 0.4, passes: 1 } },
    shapes: doc.shapes.filter((s) => s.layer === 'cut').map((s) => ({ ...s, tabs: 0 })),
  };
  const noKerf: LaserDoc = {
    ...kerfDoc,
    layers: { ...kerfDoc.layers, cut: { ...kerfDoc.layers.cut, kerf: 0 } },
  };
  const withKerf = buildLaserSimulation(kerfDoc).byLayer.cut.lengthMm;
  const withoutKerf = buildLaserSimulation(noKerf).byLayer.cut.lengthMm;
  assert(withKerf > withoutKerf, `керф увеличивает контур: ${withKerf} > ${withoutKerf}`);
}

// ---------------- импорт векторных файлов ----------------
{
  const doc = newMachineDoc(200, 150, 'Импорт');
  doc.shapes = [
    {
      id: 'r1', kind: 'rect', layer: 'cut', name: 'Прямоугольник',
      x: 10, y: 20, w: 50, h: 30, rx: 2, rot: 0, filled: false,
    },
    {
      id: 'c1', kind: 'ellipse', layer: 'inner', name: 'Круг',
      cx: 100, cy: 80, rx: 12, ry: 12, rot: 0, startAngle: 0, endAngle: 360, filled: false,
    },
    {
      id: 'f1', kind: 'path', layer: 'fold', name: 'Сгиб',
      nodes: [{ x: 10, y: 100 }, { x: 90, y: 100 }], closed: false, filled: false,
    },
  ];

  // SVG: 1:1 мм, Y вверх → вниз, слои и пунктир сохраняются.
  // Наш SVG пишет всё контурами (<path>), поэтому проверяем геометрию, а не тип.
  const svg = exportLaserSvg(doc);
  const back = importVectorFile(svg, 'test.svg', doc.h);
  assert(back.length >= 3, `из SVG прочитано объектов: ${back.length}`);
  const importedRect = back.find((s) => {
    const bb = shapeBBox(s);
    return near(bb[0], 10, 0.02) && near(bb[1], 20, 0.02) && near(bb[2] - bb[0], 50, 0.02);
  });
  assert(importedRect, `прямоугольник прочитан обратно: ${JSON.stringify(back.map(shapeBBox))}`);
  const rbb = shapeBBox(importedRect);
  assert(near(rbb[3] - rbb[1], 30, 0.02), `высота прямоугольника: ${rbb}`);
  const importedCircle = back.find((s) => {
    const bb = shapeBBox(s);
    return near((bb[0] + bb[2]) / 2, 100, 0.05) && near((bb[1] + bb[3]) / 2, 80, 0.05)
      && near(bb[2] - bb[0], 24, 0.5);
  });
  assert(importedCircle, 'круг прочитан обратно');
  assert(back.some((s) => s.layer === 'fold'), 'пунктир распознан как слой сгиба');
  assert(back.every((s) => s.kind === 'path'), 'весь импорт SVG — кривые');

  // DXF: слои по именам, геометрия отрезками и окружностями
  const dxf = exportLaserDxf(doc);
  const fromDxf = importVectorFile(dxf, 'test.dxf');
  assert(fromDxf.length > 10, `из DXF прочитано объектов: ${fromDxf.length}`);
  assert(fromDxf.some((s) => s.layer === 'inner'), 'слой INNER распознан');
  assert(fromDxf.some((s) => s.layer === 'fold'), 'слой FOLD распознан');
  const dxfBB = selectionBBox(fromDxf)!;
  const srcBB = selectionBBox(doc.shapes)!;
  assert(near(dxfBB[0], srcBB[0], 0.6) && near(dxfBB[2], srcBB[2], 0.6), `габарит по X: ${dxfBB} vs ${srcBB}`);
  assert(near(dxfBB[1], srcBB[1], 0.6) && near(dxfBB[3], srcBB[3], 0.6), `габарит по Y: ${dxfBB} vs ${srcBB}`);

  // произвольный SVG из внешнего редактора (CorelDRAW/Inkscape)
  const external = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
    <path d="M10 10 L 90 10 L 90 90 Z" />
    <polyline points="5,5 20,5 20,20" />
    <polygon points="40,40 60,40 60,60 40,60" />
    <line x1="0" y1="0" x2="10" y2="10" />
    <path d="M5 50 C 15 40, 25 60, 35 50" />
  </svg>`;
  const ext = importVectorFile(external, 'corel.svg', 100);
  assert(ext.length >= 5, `внешний SVG: ${ext.length} объектов`);
  const curve = ext.find((s) => s.kind === 'path' && (s as PathShape).nodes.some((n) => n.cp1x !== undefined));
  assert(curve, 'кривые Безье из SVG сохраняют рычаги');
  const poly = ext.find((s) => s.name === 'Импорт полигон')! as PathShape;
  assert.equal(poly.closed, true, 'polygon замкнут');
  assert.equal(poly.nodes.length, 4);

  assert.deepEqual(importVectorFile('<svg></svg>', 'empty.svg'), [], 'пустой SVG не даёт объектов');
}

// ---------------- импорт SVG: дуги, кривые, трансформации ----------------
{
  // высота области SVG берётся из viewBox/height, а не из размера нашего листа
  assert(near(svgHeightMm('<svg viewBox="0 0 300 150"></svg>', 200), 150, 1e-9), 'viewBox важнее листа');
  assert(near(svgHeightMm('<svg height="50mm"></svg>', 200), 50, 1e-9), 'height в миллиметрах');
  assert(near(svgHeightMm('<svg height="2in"></svg>', 200), 50.8, 1e-9), 'дюймы переводятся в мм');
  assert(near(svgHeightMm('<svg height="96px"></svg>', 200), 25.4, 1e-9), 'пиксели — 96 на дюйм');
  assert(near(svgHeightMm('<svg height="10cm"></svg>', 200), 100, 1e-9), 'сантиметры переводятся в мм');
  assert(near(svgHeightMm('<svg></svg>', 200), 200, 1e-9), 'без размеров — высота листа');

  const bb = (shapes: LaserShape[]) => selectionBBox(shapes)!;
  const ptsOf = (s: LaserShape) => shapeToPolylines(s).flat();

  // дуга (A): половина окружности становится кусками Безье точно на радиусе
  const arc = importVectorFile(
    '<svg viewBox="0 0 200 100"><path d="M50 50 A25 25 0 0 1 100 50"/></svg>', 'arc.svg', 200);
  assert.equal(arc.length, 1, 'дуга прочитана');
  const arcPath = arc[0] as PathShape;
  assert.equal(arcPath.kind, 'path');
  assert.ok(arcPath.nodes.some((n) => n.cp1x !== undefined), 'дуга осталась кривой Безье');
  for (const p of ptsOf(arcPath)) {
    assert.ok(Math.abs(Math.hypot(p.x - 75, p.y - 50) - 25) < 0.05,
      `точка дуги на окружности r=25: ${p.x.toFixed(3)},${p.y.toFixed(3)}`);
  }
  assert.ok(near(bb(arc)[3], 75, 0.05), `дуга выгнута вверх по миру: ${bb(arc)}`);

  // квадратичная кривая (Q) переводится в кубическую точно: вершина на месте
  const quad = importVectorFile(
    '<svg viewBox="0 0 100 100"><path d="M0 0 Q50 100 100 0"/></svg>', 'q.svg', 100);
  const quadPts = ptsOf(quad[0]);
  assert.ok(near(Math.min(...quadPts.map((p) => p.y)), 50, 0.5),
    `вершина квадратичной кривой: ${Math.min(...quadPts.map((p) => p.y))}`);

  // гладкое продолжение (T): управляющая точка отражается от предыдущей
  const smoothQ = importVectorFile(
    '<svg viewBox="0 0 100 100"><path d="M0 0 Q25 50 50 0 T100 0"/></svg>', 't.svg', 100);
  const tq = ptsOf(smoothQ[0]);
  assert.ok(near(Math.max(...tq.map((p) => p.y)), 125, 0.5),
    `вторая ветвь T отражена: ${Math.max(...tq.map((p) => p.y))}`);
  assert.equal((smoothQ[0] as PathShape).nodes.length, 3, 'две кривые — три узла');

  // гладкая кубика (S) тоже отражает рычаг
  const smoothC = parseSvgPathData('M0 0 C10 30 20 30 30 0 S50 -30 60 0');
  assert.equal(smoothC.length, 1, 'один контур');
  assert.equal(smoothC[0].nodes.length, 3, 'три узла');
  assert.ok(near(smoothC[0].nodes[1].cp2x!, 40, 1e-9), `рычаг S отражён: ${smoothC[0].nodes[1].cp2x}`);
  assert.ok(near(smoothC[0].nodes[1].cp2y!, -30, 1e-9), 'рычаг S по Y');

  // относительные команды и повторяющиеся наборы координат
  const rel = parseSvgPathData('m10 10 l10 0 0 10 -10 0 z');
  assert.equal(rel.length, 1, 'один замкнутый контур');
  assert.equal(rel[0].closed, true);
  assert.deepEqual(rel[0].nodes.map((n) => [n.x, n.y]), [[10, 10], [20, 10], [20, 20], [10, 20]],
    'относительные координаты считаются от предыдущей точки');

  // группа со сдвигом: прямоугольник остаётся прямоугольником, но уезжает куда надо
  const moved = importVectorFile(
    '<svg viewBox="0 0 100 100"><g transform="translate(10,20)">'
    + '<rect x="0" y="0" width="50" height="30"/></g></svg>', 'g.svg', 100);
  assert.equal(moved.length, 1, 'фигура в группе прочитана');
  assert.equal(moved[0].kind, 'rect', 'перенос не превращает прямоугольник в кривую');
  assert.deepEqual(bb(moved), [10, 50, 60, 80], `габарит после translate: ${bb(moved)}`);

  // поворот группы: примитив становится кривой с правильным габаритом
  const rotated = importVectorFile(
    '<svg viewBox="0 0 100 100"><g transform="rotate(90 50 50)">'
    + '<rect x="40" y="40" width="20" height="10"/></g></svg>', 'r.svg', 100);
  assert.equal(rotated.length, 1, 'повёрнутый прямоугольник прочитан');
  assert.equal(rotated[0].kind, 'path', 'поворот требует кривой');
  const rbb = bb(rotated);
  assert(near(rbb[0], 50, 0.01) && near(rbb[1], 40, 0.01) && near(rbb[2], 60, 0.01) && near(rbb[3], 60, 0.01),
    `габарит после rotate(90): ${rbb}`);

  // масштаб группы: окружность становится больше, переворот Y не ломает центр
  const scaled = importVectorFile(
    '<svg viewBox="0 0 100 100"><g transform="scale(2)"><circle cx="10" cy="10" r="5"/></g></svg>',
    's.svg', 100);
  const sbb = bb(scaled);
  assert(near(sbb[0], 10, 0.2) && near(sbb[2], 30, 0.2), `масштаб по X: ${sbb}`);
  assert(near(sbb[3] - sbb[1], 20, 0.2), `диаметр после scale(2): ${sbb[3] - sbb[1]}`);

  // вложенные группы: слой и матрица наследуются
  const nested = importVectorFile(
    '<svg viewBox="0 0 100 100"><g id="layer-fold"><g transform="translate(5,5)">'
    + '<path d="M0 0 L10 0"/></g></g></svg>', 'n.svg', 100);
  assert.equal(nested[0].layer, 'fold', 'слой группы унаследован');
  assert.deepEqual(bb(nested), [5, 95, 15, 95], `матрица вложенной группы: ${bb(nested)}`);

  // координаты вне листа больше не обрезаются нулём
  const outside = importVectorFile(
    '<svg viewBox="0 0 100 100"><path d="M-10 -5 L20 -5"/></svg>', 'neg.svg', 100);
  const obb = bb(outside);
  assert(near(obb[1], 105, 1e-9), `отрицательные Y не прижаты к нулю: ${obb}`);
  assert(near(obb[0], -10, 1e-9), `отрицательные X сохранены: ${obb}`);

  // stroke-width не подменяет геометрию, а DXF не путается с SVG
  assert.deepEqual(importVectorFile('<svg><path d="M0 0"/></svg>', 'one.svg', 100), [],
    'контур из одной точки не импортируется');
}

// ---------------- файл проекта и черновик ----------------
{
  const doc = newMachineDoc(250, 180, 'Корпус прибора');
  doc.shapes = [{
    id: 'p', kind: 'rect', layer: 'cut', name: 'Панель',
    x: 5, y: 5, w: 100, h: 60, rx: 3, rot: 0, filled: false, tabs: 4, tabWidth: 2,
  }];
  doc.groups = [{ id: 'g1', name: 'Корпус' }];
  doc.layers.cut.power = 77;

  const text = serializeLaserProject(doc);
  const parsed = parseLaserProject(text)!;
  assert(parsed, 'проект читается обратно');
  assert.equal(parsed.name, doc.name);
  assert.equal(parsed.w, 250);
  assert.equal(parsed.shapes.length, 1);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.layers.cut.power, 77, 'режимы слоёв сохраняются');

  assert.equal(parseLaserProject('{ broken'), null, 'битый JSON отклоняется');
  assert.equal(parseLaserProject('{"kind":"board"}'), null, 'чужой проект отклоняется');
  assert.equal(normalizeLaserDoc(null), null);
  assert.equal(normalizeLaserDoc({ name: 'x' }), null, 'без списка объектов — не проект');

  // неполные/повреждённые данные приводятся к рабочим значениям
  const patched = normalizeLaserDoc({
    name: '  ', w: 5, h: NaN, materialThickness: -3, materialPresetId: 'nope',
    layers: { cut: { power: 42 } },
    shapes: [{ id: 'a', kind: 'rect' }, null, { kind: 'rect' }, 'строка'],
    groups: 'не массив',
  })!;
  assert(patched, 'проект с ошибками восстанавливается');
  assert(patched.name.length > 0, 'пустое имя заменено');
  assert(patched.w >= 20 && patched.h >= 20, 'недопустимый размер листа заменён');
  assert.equal(patched.materialThickness, DEFAULT_LASER_LAYERS.cut.kerf >= 0 ? 3.0 : 3.0, 'толщина по умолчанию');
  assert.equal(patched.materialPresetId, 'plywood-3', 'неизвестный материал заменён');
  assert.equal(patched.layers.cut.power, 42, 'сохранённая мощность слоя применена');
  assert.equal(patched.layers.cut.speed, DEFAULT_LASER_LAYERS.cut.speed, 'остальные параметры слоя — по умолчанию');
  assert.equal(patched.shapes.length, 1, 'отбракованы повреждённые объекты');
  assert.deepEqual(patched.groups, []);

  assert.equal(laserDraftKey(), 'psbees.laser.draft');
  assert.equal(laserDraftKey('u1'), 'psbees.laser.draft.u1', 'черновики пользователей не смешиваются');
  assert.equal(safeFileName('Корпус /прибора: v2'), 'Корпус_прибора_v2');
  assert.equal(safeFileName('   '), 'razvyortka');
}

console.log('LASER OK');
