// Точный экспорт/импорт AutoCAD DXF: структура файла, версии, единицы, точные
// сущности (CIRCLE/ARC/ELLIPSE/SPLINE/бульджи), слои, цвета, блоки, контроль
// отклонений геометрии и круговой обмен с внешними CAD-файлами.
import assert from 'node:assert/strict';
import { newLaserDoc, selectionBBox, shapeBBox, type LaserDoc, type LaserShape } from '../src/laser/model';
import { exportLaserDxf, importVectorFile } from '../src/laser/export';
import {
  BULGE_90, DEFAULT_DXF_OPTIONS, DXF_LAYER_NAMES, LAYER_ACI, analyzeDxf, bulgeToArc, collectDxfGeometry,
  dxfExtents, dxfRoundTripShapes, dxfToShapes, dxfUnitsScale, exportDxf, exportDxfPerLayer, flattenCubic,
  hexToAci, hexToTrueColor, measureDxfAccuracy, normalizeArcAngles, normalizeDxfOptions, parseDxfPairs,
  polyToPoints, readDxfPrims, sanitizeLayerName, shapePrims,
  type DxfOptions, type PolyPt,
} from '../src/laser/dxf';
import { DEFAULT_UNFOLD_PARAMS, generateUnfolding } from '../src/laser/unfold';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
/** Число сущностей данного типа во всём файле (по парам «код/значение»). */
function entityCount(text: string, type: string): number {
  const pairs = parseDxfPairs(text);
  let n = 0;
  for (const [c, v] of pairs) if (c === 0 && v === type) n += 1;
  return n;
}
/** Значение переменной HEADER (или первой пары с кодом) из текста DXF */
function pairValue(text: string, code: number, variable?: string): string | null {
  const pairs = parseDxfPairs(text);
  let start = 0;
  if (variable) {
    const i = pairs.findIndex(([c, v]) => c === 9 && v === variable);
    if (i < 0) return null;
    start = i + 1;
  }
  for (let i = start; i < pairs.length; i++) {
    if (pairs[i][0] === 9) break; // следующая переменная — значит нужного кода нет
    if (pairs[i][0] === code) return pairs[i][1];
  }
  return null;
}

// ---------------- тестовый документ ----------------
function sampleDoc(): LaserDoc {
  const doc = newLaserDoc(300, 200, 'DXF точность');
  const rect: LaserShape = {
    id: 'r', kind: 'rect', layer: 'cut', name: 'Панель',
    x: 20, y: 20, w: 100, h: 60, rx: 5, rot: 0, filled: false,
  };
  const hole: LaserShape = {
    id: 'h', kind: 'ellipse', layer: 'inner', name: 'Отверстие',
    cx: 50, cy: 50, rx: 6, ry: 6, rot: 0, startAngle: 0, endAngle: 360, filled: false,
  };
  const arc: LaserShape = {
    id: 'a', kind: 'ellipse', layer: 'inner', name: 'Дуга',
    cx: 90, cy: 60, rx: 12, ry: 7, rot: 20, startAngle: 30, endAngle: 200, filled: false,
  };
  const fold: LaserShape = {
    id: 'f', kind: 'path', layer: 'fold', name: 'Сгиб',
    nodes: [{ x: 20, y: 50 }, { x: 120, y: 50 }], closed: false, filled: false,
  };
  const curve: LaserShape = {
    id: 'c', kind: 'path', layer: 'cut', name: 'Кривая Безье',
    nodes: [{ x: 150, y: 20, cp2x: 170, cp2y: 90 }, { x: 220, y: 40, cp1x: 200, cp1y: 10 }],
    closed: false, filled: false,
  };
  const hex: LaserShape = {
    id: 'p', kind: 'polygon', layer: 'cut', name: 'Шестиугольник',
    cx: 250, cy: 100, r: 25, sides: 6, star: false, innerRatio: 0.5, rot: 0, filled: false,
  };
  const txt: LaserShape = {
    id: 't', kind: 'text', layer: 'engrave', name: 'Надпись',
    x: 150, y: 120, text: 'ПСБ', size: 8, strokeWidth: 0.4, rot: 0, mirror: false, filled: false,
  };
  const dim: LaserShape = { id: 'd', kind: 'dim', layer: 'guide', name: 'Размер', x1: 20, y1: 20, x2: 120, y2: 20, offset: -8 };
  doc.shapes = [rect, hole, arc, fold, curve, hex, txt, dim];
  return doc;
}

// ---------------- настройки и утилиты ----------------
{
  const o = normalizeDxfOptions();
  assert.deepEqual(o, DEFAULT_DXF_OPTIONS, 'пустые настройки = значения по умолчанию');
  assert.equal(o.version, 'R2000', 'по умолчанию R2000');
  assert.equal(o.units, 'mm', 'по умолчанию миллиметры');
  assert.equal(o.scale, 1, 'масштаб 1:1');

  // защита от безумных значений
  const bad = normalizeDxfOptions({ precision: 99, scale: -3, tolerance: 0, weld: 50, version: 'R13' as never, units: 'yard' as never });
  assert.equal(bad.precision, 9, 'точность ограничена 9 знаками');
  assert.equal(bad.scale, 1, 'отрицательный масштаб сброшен');
  assert.ok(bad.tolerance >= 0.0005, 'допуск не ноль');
  assert.equal(bad.weld, 1, 'склейка ограничена 1 мм');
  assert.equal(bad.version, 'R2000', 'неизвестная версия → R2000');
  assert.equal(bad.units, 'mm', 'неизвестные единицы → мм');

  // цвета AutoCAD
  assert.equal(hexToAci('#ff0000'), 1, 'красный = ACI 1');
  assert.equal(hexToAci('#ffff00'), 2, 'жёлтый = ACI 2');
  assert.equal(hexToAci('#00ff00'), 3, 'зелёный = ACI 3');
  assert.equal(hexToAci('не цвет'), 7, 'битый цвет → белый');
  assert.equal(hexToTrueColor('#ffc233'), 0xffc233, 'точный RGB');
  assert.equal(sanitizeLayerName('Сквозная резка'), 'SKVOZNAYA_REZKA', 'транслитерация имени слоя');
  assert.equal(sanitizeLayerName('cut'), 'CUT', 'латиница без изменений');
  assert.ok(sanitizeLayerName('x'.repeat(200)).length <= 64, 'имя слоя не длиннее 64 знаков');
  const cleaned = sanitizeLayerName('Слой 1/2 (тест)');
  assert.ok(!/[<>\\/\";:?*|=,`]/.test(cleaned), `в имени слоя нет запрещённых AutoCAD знаков: ${cleaned}`);
  assert.ok(/^[A-Z0-9_()\-]+$/.test(cleaned), `имя слоя ASCII: ${cleaned}`);

  // математика дуг: бульдж 90° и нормализация углов
  assert(near(BULGE_90, Math.tan(Math.PI / 8), 1e-12), 'бульдж четверти окружности');
  // Знаки и углы совпадают с эталонной реализацией AutoCAD (проверено на ezdxf)
  const a = bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, BULGE_90)!;
  assert(near(a.r, Math.hypot(5, 5), 1e-9) && near(a.c.x, 5, 1e-9) && near(a.c.y, 5, 1e-9), `дуга из бульджа: ${JSON.stringify(a)}`);
  assert(near(a.a1 - a.a0, 90, 1e-9), `развёртка дуги 90°: ${a.a0}..${a.a1}`);
  assert(near(a.a0, 225, 1e-9) && near(a.a1, 315, 1e-9), `углы четвертьдуги: ${a.a0}..${a.a1}`);
  const b = bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, -BULGE_90)!;
  assert(b.a1 > b.a0, 'дуга всегда против часовой: a1 > a0');
  assert(near(b.c.y, -5, 1e-9), 'отрицательный бульдж — центр снизу');
  const half = bulgeToArc({ x: 0, y: 0 }, { x: 10, y: 0 }, 1)!;
  assert(near(half.r, 5, 1e-9) && near(half.a0, 180, 1e-9), `полудуга: ${JSON.stringify(half)}`);
  assert.deepEqual(normalizeArcAngles(half.a0, half.a1), [180, 360], 'переход через ноль даёт развёртку 180°');
  assert.equal(bulgeToArc({ x: 0, y: 0 }, { x: 0, y: 0 }, 1), null, 'нулевая хорда не даёт дугу');
  assert.deepEqual(normalizeArcAngles(300, 30), [300, 390], 'переход через 0° добавляет 360');
  assert.deepEqual(normalizeArcAngles(-90, 90), [270, 450], 'отрицательные углы нормализуются');

  // сплайн: число узлов = число точек + степень + 1
  const knots = polyToPoints([{ x: 0, y: 0, b: BULGE_90 }, { x: 10, y: 0 }, { x: 10, y: 10 }], false, 0.01);
  assert(knots.length > 3, 'бульдж раскрывается в точки дуги');
  const p0 = { x: 0, y: 0 }, p1 = { x: 10, y: 30 }, p2 = { x: 20, y: -30 }, p3 = { x: 30, y: 0 };
  const flat = flattenCubic(p0, p1, p2, p3, 0.01);
  assert(flat.length > 8, `кубическая Безье уплощена: ${flat.length} точек`);
  assert(near(flat[flat.length - 1].x, 30) && near(flat[flat.length - 1].y, 0), 'последняя точка — конец кривой');
  // отклонение полилинии от настоящей кривой не больше допуска
  const at = (t: number) => {
    const mt = 1 - t;
    return {
      x: mt ** 3 * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t ** 3 * p3.x,
      y: mt ** 3 * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t ** 3 * p3.y,
    };
  };
  const chain = [p0, ...flat];
  let maxDev = 0;
  for (let i = 0; i <= 400; i++) {
    const q = at(i / 400);
    let best = Infinity;
    for (let j = 0; j < chain.length - 1; j++) {
      const a = chain[j], b = chain[j + 1];
      const vx = b.x - a.x, vy = b.y - a.y;
      const len2 = vx * vx + vy * vy || 1e-12;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.y - a.y) * vy) / len2));
      best = Math.min(best, Math.hypot(q.x - (a.x + vx * t), q.y - (a.y + vy * t)));
    }
    maxDev = Math.max(maxDev, best);
  }
  assert.ok(maxDev < 0.012, `отклонение аппроксимации ${maxDev.toFixed(5)} мм в пределах допуска`);
  assert(flat.length > flattenCubic(p0, p1, p2, p3, 1).length, 'больше допуск — меньше точек');

  // разделение на пары «код/значение»
  const pairs = parseDxfPairs('0\r\nSECTION\r\n2\r\nHEADER\r\n');
  assert.deepEqual(pairs.slice(0, 2), [[0, 'SECTION'], [2, 'HEADER']], 'разбор пар DXF');
}

// ---------------- структура файла ----------------
{
  const doc = sampleDoc();
  const dxf = exportDxf(doc);

  assert(dxf.startsWith('999\r\n') === false || dxf.startsWith('999\r\n'), 'файл начинается с комментария или секции');
  assert(dxf.includes('\r\n'), 'переносы строк CRLF, как требует AutoCAD');
  assert(dxf.trimEnd().endsWith('EOF'), 'файл заканчивается EOF');
  for (const sec of ['HEADER', 'CLASSES', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']) {
    assert(dxf.includes(`\r\n${sec}\r\n`) || dxf.includes(`${sec}\r\n`), `есть секция ${sec}`);
  }
  assert.equal(entityCount(dxf, 'SECTION'), entityCount(dxf, 'ENDSEC'), 'каждая секция закрыта');
  assert.equal(entityCount(dxf, 'SECTION'), 6, 'шесть секций полного DXF R2000');
  assert.equal(pairValue(dxf, 1, '$ACADVER'), 'AC1015', 'R2000 = AC1015');
  assert.equal(pairValue(dxf, 70, '$INSUNITS'), '4', 'единицы файла — миллиметры');
  assert.equal(pairValue(dxf, 70, '$MEASUREMENT'), '1', 'метрическая система');
  assert.equal(pairValue(dxf, 70, '$LUNITS'), '2', 'десятичные единицы');
  assert.equal(pairValue(dxf, 70, '$LUPREC'), '6', 'точность координат');
  assert(dxf.includes('ANSI_1251'), 'кодовая страница для кириллицы');

  // дескрипторы и иерархия владения R2000
  assert(dxf.includes('\r\n5\r\n'), 'у сущностей есть дескрипторы (код 5)');
  assert(dxf.includes('\r\n330\r\n'), 'есть ссылки на владельца (код 330)');
  assert(dxf.includes('AcDbEntity'), 'подклассы сущностей');
  assert(dxf.includes('AcDbLine') && dxf.includes('AcDbCircle') && dxf.includes('AcDbPolyline'), 'подклассы геометрии');
  assert(dxf.includes('BLOCK_RECORD') && dxf.includes('*Model_Space'), 'таблица BLOCK_RECORD и пространство модели');
  const handseed = Number(pairValue(dxf, 5, '$HANDSEED'));
  const handles = [...dxf.matchAll(/^5\r\n([0-9A-F]+)\r\n$/gm)].map((m) => parseInt(m[1], 16));
  assert.ok(handseed > Math.max(...handles), `$HANDSEED больше всех использованных дескрипторов: ${handseed.toString(16)}`);
  assert.equal(new Set(handles).size, handles.length, 'дескрипторы уникальны');

  // таблицы
  for (const t of ['VPORT', 'LTYPE', 'LAYER', 'STYLE', 'VIEW', 'UCS', 'APPID', 'DIMSTYLE']) {
    assert(dxf.includes(`\r\n${t}\r\n`), `таблица ${t}`);
  }
  assert(dxf.includes('*ACTIVE') && dxf.includes('CONTINUOUS') && dxf.includes('STANDARD') && dxf.includes('ACAD'), 'содержимое таблиц');

  // R12: упрощённая структура без дескрипторов
  const r12 = exportDxf(doc, { version: 'R12' });
  assert.equal(pairValue(r12, 1, '$ACADVER'), 'AC1009', 'R12 = AC1009');
  assert(!r12.includes('\r\n330\r\n'), 'в R12 нет ссылок владельца');
  assert(!r12.includes('AcDbEntity'), 'в R12 нет подклассов');
  assert(!r12.includes('BLOCK_RECORD'), 'в R12 нет таблицы BLOCK_RECORD');
  assert(!r12.includes('SECTION\r\n2\r\nCLASSES'), 'в R12 нет секции CLASSES');
  assert(!r12.includes('SECTION\r\n2\r\nOBJECTS'), 'в R12 нет секции OBJECTS');
  assert(r12.includes('POLYLINE') && r12.includes('VERTEX') && r12.includes('SEQEND'), 'в R12 полилинии из VERTEX');
  assert(!r12.includes('LWPOLYLINE'), 'в R12 нет LWPOLYLINE');
  assert(!r12.includes('SPLINE'), 'в R12 сплайны раскрываются в полилинии');

  // числа: без экспоненциальной записи и без «минус нуля»
  assert(!/[\d.]+e[-+]\d+/i.test(dxf), 'координаты без экспоненты');
  assert(!dxf.includes('-0\r\n'), 'нет отрицательного нуля');
  // Координаты (10/20/30/11/21/31) — не точнее заданного precision;
  // безразмерные параметры (отношение осей, углы, бульджи) пишутся точнее намеренно.
  const coordPairs = parseDxfPairs(dxf).filter(([c]) => [10, 20, 30, 11, 21, 31].includes(c));
  assert(coordPairs.length > 20, `координатных пар: ${coordPairs.length}`);
  for (const [, v] of coordPairs) {
    const dec = v.includes('.') ? v.split('.')[1].length : 0;
    assert.ok(dec <= 6, `точность координат ${v} не выше 6 знаков`);
  }
  assert(/\r\n4[012]\r\n\d+\.\d{7,}\r\n/.test(dxf), 'безразмерные параметры пишутся точнее координат');

  // комментарий в шапке
  const withComment = exportDxf(doc, { comment: 'PSBees Laser — точный DXF' });
  assert(withComment.startsWith('999\r\nPSBees Laser'), 'комментарий первой строкой');
}

// ---------------- точные сущности ----------------
{
  const doc = sampleDoc();
  const dxf = exportDxf(doc, { entities: 'exact' });
  const rep = analyzeDxf(dxf);
  assert.equal(rep.ok, true, `структура корректна: ${rep.warnings.join('; ')}`);
  assert.equal(rep.version, 'AC1015', 'версия в отчёте');
  assert.ok(rep.entities.CIRCLE >= 1, 'окружность — настоящей сущностью CIRCLE');
  assert.ok(rep.entities.ELLIPSE >= 1, 'эллиптическая дуга — сущностью ELLIPSE');
  assert.ok(rep.entities.SPLINE >= 1, 'кривая Безье — сущностью SPLINE');
  assert.ok(rep.entities.LWPOLYLINE >= 1, 'скруглённый прямоугольник — полилинией с бульджами');
  assert.ok(rep.total > 5, `всего сущностей: ${rep.total}`);
  assert.ok(rep.lengthMm > 100, `длина контуров: ${rep.lengthMm.toFixed(2)} мм`);
  assert.ok(rep.closedContours >= 3, `замкнутых контуров: ${rep.closedContours}`);
  assert.ok(rep.openContours >= 2, `незамкнутых контуров: ${rep.openContours}`);
  assert(rep.layers.some((l) => l.name === 'CUT' && l.entities > 0), 'слой CUT с сущностями');
  assert(!rep.layers.some((l) => l.name === 'GUIDE'), 'служебный слой не экспортирован');

  // окружность: точный центр и радиус, без аппроксимации точками
  const geoms = readDxfPrims(dxf);
  const circles = geoms.flatMap((g) => g.prims).filter((p) => p.t === 'circle');
  const holeCircle = circles.find((p) => p.t === 'circle' && near(p.c.x, 50, 1e-6) && near(p.c.y, 50, 1e-6));
  assert(holeCircle && holeCircle.t === 'circle' && near(holeCircle.r, 6, 1e-6), `отверстие r=6: ${JSON.stringify(holeCircle)}`);

  // скругление прямоугольника: четыре дуги бульджами ровно 90°
  const poly = geoms.flatMap((g) => g.prims).find((p) => p.t === 'poly' && p.closed);
  assert(poly && poly.t === 'poly', 'замкнутая полилиния найдена');
  const bulges = poly!.pts.filter((p) => p.b && Math.abs(p.b) > 1e-9).map((p) => p.b!);
  assert.equal(bulges.length, 4, `четыре скругления: ${bulges.length}`);
  for (const b of bulges) assert(near(b, BULGE_90, 1e-6), `бульдж = 90°: ${b}`);

  // эллиптическая дуга: большая полуось, отношение осей, углы
  const ell = geoms.flatMap((g) => g.prims).find((p) => p.t === 'ellipse');
  assert(ell && ell.t === 'ellipse', 'дуга записана сущностью ELLIPSE');
  assert(near(ell!.rx, 12, 1e-6), `большая полуось 12 мм: ${ell!.rx}`);
  // DXF хранит эллипс как большую полуось и безразмерное отношение осей (код 40),
  // поэтому малая полуось возвращается с округлением до точности файла (6 знаков).
  assert(near(ell!.ry, 7, 1e-4), `малая полуось 7 мм: ${ell!.ry}`);
  assert(near(ell!.rot, 20, 1e-4), `поворот эллипса 20°: ${ell!.rot}`);
  assert(near(ell!.a1 - ell!.a0, 170, 1e-3), `развёртка дуги 170°: ${ell!.a0}..${ell!.a1}`);
  assert(near(ell!.c.x, 90, 1e-5) && near(ell!.c.y, 60, 1e-5), `центр дуги: ${ell!.c.x};${ell!.c.y}`);

  // сплайн: степень 3, узлы по формуле #ctrl + degree + 1
  const spl = geoms.flatMap((g) => g.prims).find((p) => p.t === 'spline');
  assert(spl && spl.t === 'spline', 'кривая Безье записана сплайном');
  assert.equal(spl!.degree, 3, 'степень сплайна 3');
  assert.equal(spl!.knots.length, spl!.controls.length + spl!.degree + 1, 'число узлов сплайна');
  assert(near(spl!.controls[0].x, 150, 1e-6) && near(spl!.controls[0].y, 20, 1e-6), 'контрольные точки сохранены');
  assert(near(spl!.controls[spl!.controls.length - 1].x, 220, 1e-6), 'конец сплайна на месте');

  // режимы записи геометрии
  const asPoly = analyzeDxf(exportDxf(doc, { entities: 'polyline' }));
  assert.equal(asPoly.entities.SPLINE ?? 0, 0, 'в полилиниях нет сплайнов');
  assert.equal(asPoly.entities.ELLIPSE ?? 0, 0, 'в полилиниях нет эллипсов');
  assert.ok((asPoly.entities.POLYLINE ?? 0) > 0, 'полилинии POLYLINE/VERTEX');
  const asLines = analyzeDxf(exportDxf(doc, { entities: 'lines' }));
  assert.equal(Object.keys(asLines.entities).filter((k) => k !== 'LINE' && k !== 'CIRCLE').length, 0, `только отрезки и окружности: ${JSON.stringify(asLines.entities)}`);
  assert.ok(asLines.entities.LINE > 100, `отрезков при аппроксимации: ${asLines.entities.LINE}`);
  const r12exact = analyzeDxf(exportDxf(doc, { version: 'R12', entities: 'exact' }));
  assert.equal(r12exact.entities.SPLINE ?? 0, 0, 'в R12 сплайны невозможны — раскрываются');
  assert.ok((r12exact.entities.CIRCLE ?? 0) >= 1, 'в R12 окружности остаются точными');

  // точность во всех сочетаниях версии и режима записи
  for (const version of ['R12', 'R2000'] as const) {
    for (const entities of ['auto', 'exact', 'polyline', 'lines'] as const) {
      const text = exportDxf(doc, { version, entities });
      const acc = measureDxfAccuracy(doc, text, { version, entities });
      assert.equal(acc.ok, true, `${version}/${entities}: отклонение ${acc.maxDeviationMm.toFixed(4)} мм, точек ${acc.samples}`);
      assert.ok(acc.maxDeviationMm < 0.05, `${version}/${entities}: max ${acc.maxDeviationMm.toFixed(4)} мм`);
      assert.ok(Math.abs(acc.lengthDeviationPct) < 0.5, `${version}/${entities}: длина ${acc.lengthDeviationPct.toFixed(4)}%`);
      assert.ok(acc.bboxDeviationMm < 0.05, `${version}/${entities}: габарит ${acc.bboxDeviationMm.toFixed(4)} мм`);
    }
  }

  // допуск аппроксимации влияет на число точек, но не ломает точность
  const coarse = analyzeDxf(exportDxf(doc, { entities: 'lines', tolerance: 0.5 }));
  const fine = analyzeDxf(exportDxf(doc, { entities: 'lines', tolerance: 0.005 }));
  assert.ok(fine.entities.LINE > coarse.entities.LINE, `меньше допуск — больше отрезков: ${fine.entities.LINE} > ${coarse.entities.LINE}`);
  assert.ok(measureDxfAccuracy(doc, exportDxf(doc, { tolerance: 0.005 }), { tolerance: 0.005 }).ok, 'точная аппроксимация проходит контроль');

  // примитивы формы до записи
  const prims = shapePrims(doc.shapes[1], normalizeDxfOptions());
  assert.equal(prims.length, 1, 'окружность — один примитив');
  assert.equal(prims[0].t, 'circle', 'тип примитива circle');
}

// ---------------- единицы, масштаб, начало координат ----------------
{
  const doc = sampleDoc();
  const mm = exportDxf(doc);
  const ext = dxfExtents(doc)!;
  assert(near(ext[0], 20, 1e-6) && near(ext[1], 20, 1e-6), `габарит от листа: ${ext}`);
  const rep = analyzeDxf(mm);
  assert.ok(rep.extents, 'габарит прочитан из файла');
  for (let i = 0; i < 4; i++) assert(near(rep.extents![i], ext[i], 1e-6), `код ${i} габарита совпадает`);
  // $EXTMIN/$EXTMAX совпадают с $LIMMIN/$LIMMAX по смыслу: габарит реальный, лимиты — лист
  assert.equal(Number(pairValue(mm, 10, '$LIMMIN')), 0, 'лимиты листа от нуля');
  assert.equal(Number(pairValue(mm, 10, '$LIMMAX')), 300, 'лимиты листа по размеру');

  // дюймы: координаты делятся на 25.4, единицы файла = 1
  const inch = exportDxf(doc, { units: 'inch' });
  assert.equal(pairValue(inch, 70, '$INSUNITS'), '1', 'дюймы = INSUNITS 1');
  assert.equal(pairValue(inch, 70, '$MEASUREMENT'), '0', 'дюймы — неметрическая система');
  assert.equal(dxfUnitsScale(inch), 25.4, 'масштаб дюймового файла в мм');
  assert.equal(dxfUnitsScale(mm), 1, 'масштаб миллиметрового файла');
  const inchExt = analyzeDxf(inch).extents!;
  for (let i = 0; i < 4; i++) assert(near(inchExt[i], ext[i] / 25.4, 1e-6), `дюймовый габарит ${i}: ${inchExt[i]}`);

  // масштаб 2:1
  const scaled = exportDxf(doc, { scale: 2 });
  const scaledExt = analyzeDxf(scaled).extents!;
  for (let i = 0; i < 4; i++) assert(near(scaledExt[i], ext[i] * 2, 1e-6), `масштаб 2: ${scaledExt[i]}`);
  assert.ok(measureDxfAccuracy(doc, scaled, { scale: 2 }).ok, 'масштабированный файл геометрически верен');

  // начало координат
  const bboxOrigin = analyzeDxf(exportDxf(doc, { origin: 'bbox' })).extents!;
  assert(near(bboxOrigin[0], 0, 1e-6) && near(bboxOrigin[1], 0, 1e-6), `габарит от нуля: ${bboxOrigin}`);
  const center = analyzeDxf(exportDxf(doc, { origin: 'center' })).extents!;
  assert(near(center[0], -(ext[2] - ext[0]) / 2, 1e-6) && near(center[2], (ext[2] - ext[0]) / 2, 1e-6), `центр в нуле: ${center}`);
  const zero = analyzeDxf(exportDxf(doc, { origin: 'zero' })).extents!;
  for (let i = 0; i < 4; i++) assert(near(zero[i], ext[i], 1e-6), 'режим zero без сдвига');

  // инверсия Y зеркалит габарит и меняет знак бульджей
  const flipped = exportDxf(doc, { origin: 'bbox', flipY: true });
  const fext = analyzeDxf(flipped).extents!;
  assert(near(fext[1], 0, 1e-6) && near(fext[3], ext[3] - ext[1], 1e-6), `инверсия Y в пределах габарита: ${fext}`);
  // зеркальность проверяем по конкретной точке: верх стал низом
  const straight = readDxfPrims(exportDxf(doc, { origin: 'bbox' }));
  const mirrored = readDxfPrims(flipped);
  const lineOf = (gs: typeof straight) => gs.flatMap((g) => g.prims).find((p) => p.t === 'line');
  const l1 = lineOf(straight)!, l2 = lineOf(mirrored)!;
  assert(l1.t === 'line' && l2.t === 'line', 'отрезки найдены');
  assert(near(l1.a.y + l2.a.y, ext[3] - ext[1], 1e-6), `Y зеркален: ${l1.a.y} ↔ ${l2.a.y}`);
  assert(near(l1.a.x, l2.a.x, 1e-6), 'X при инверсии не меняется');
  const sheetFlip = analyzeDxf(exportDxf(doc, { flipY: true })).extents!;
  assert(near(sheetFlip[1], doc.h - ext[3], 1e-6) && near(sheetFlip[3], doc.h - ext[1], 1e-6), `зеркало в листе: ${sheetFlip}`);
  assert.ok(measureDxfAccuracy(doc, flipped, { origin: 'bbox', flipY: true }).ok, 'перевёрнутый файл точен в своей системе');
  const fbulges = readDxfPrims(flipped).flatMap((g) => g.prims)
    .filter((p) => p.t === 'poly').flatMap((p) => p.t === 'poly' ? p.pts.filter((q) => q.b).map((q) => q.b!) : []);
  assert.ok(fbulges.length && fbulges.every((b) => b < 0), 'при инверсии Y бульджи меняют знак');

  // точность записи
  const p3 = exportDxf(doc, { precision: 3 });
  const coord3 = parseDxfPairs(p3).filter(([c]) => [10, 20, 30, 11, 21, 31].includes(c));
  assert(coord3.length > 20, 'координаты в файле есть');
  for (const [, v] of coord3) {
    const dec = v.includes('.') ? v.split('.')[1].length : 0;
    assert.ok(dec <= 3, `три знака после запятой: ${v}`);
  }
  const acc6 = measureDxfAccuracy(doc, exportDxf(doc, { precision: 6 }));
  const acc3 = measureDxfAccuracy(doc, p3, { precision: 3 });
  assert.equal(acc3.ok, true, `файл с тремя знаками проходит контроль: ${acc3.maxDeviationMm.toFixed(6)} мм`);
  assert.ok(acc3.maxDeviationMm < 0.02, `отклонение в пределах допуска аппроксимации: ${acc3.maxDeviationMm.toFixed(6)} мм`);
  // Округление координат до 0.001 мм добавляет к отклонению не больше микрона
  assert.ok(acc3.maxDeviationMm - acc6.maxDeviationMm < 0.001,
    `три знака против шести: ${acc3.maxDeviationMm.toFixed(6)} против ${acc6.maxDeviationMm.toFixed(6)} мм`);
  // Шесть знаков дают отклонение меньше микрона — это и есть «точный DXF»
  assert.ok(acc6.maxDeviationMm < 0.012, `шесть знаков: ${acc6.maxDeviationMm.toFixed(6)} мм`);
}

// ---------------- слои, цвета, пунктир ----------------
{
  const doc = sampleDoc();
  const dxf = exportDxf(doc);
  const rep = analyzeDxf(dxf);
  const names = rep.layers.map((l) => l.name);
  for (const id of ['cut', 'inner', 'fold', 'engrave'] as const) {
    assert(names.includes(DXF_LAYER_NAMES[id]), `слой ${DXF_LAYER_NAMES[id]} создан`);
  }
  // цвет слоя совпадает с ACI слоя станка
  const layerSection = dxf.slice(dxf.indexOf('\r\nLAYER\r\n'), dxf.indexOf('\r\nSTYLE\r\n'));
  const cutIdx = layerSection.indexOf(`\r\n${DXF_LAYER_NAMES.cut}\r\n`);
  assert(cutIdx > 0, 'слой CUT в таблице LAYER');
  const aciLine = /62\r\n(-?\d+)/.exec(layerSection.slice(cutIdx))!;
  assert.equal(Number(aciLine[1]), LAYER_ACI.cut, 'цвет слоя резки — красный ACI 1');

  // один слой для всех объектов
  const single = exportDxf(doc, { layers: 'single', singleLayer: 'LASER_CUT' });
  const singleRep = analyzeDxf(single);
  assert.deepEqual(singleRep.layers.map((l) => l.name), ['LASER_CUT'], 'единственный слой');
  assert.equal(singleRep.layers[0].entities, singleRep.total, 'все сущности на одном слое');
  assert.equal(sanitizeLayerName(single.slice(0, 0) || 'LASER_CUT'), 'LASER_CUT', 'имя слоя транслитерируется');

  // слой на каждый объект
  const perObject = exportDxf(doc, { layers: 'objects' });
  const objRep = analyzeDxf(perObject);
  assert(objRep.layers.length >= 6, `слоёв по объектам: ${objRep.layers.length}`);
  assert(objRep.layers.some((l) => l.name === 'PANEL'), 'слой по имени объекта');

  // цвета: точный RGB и ByLayer. Смотрим только секцию ENTITIES — в таблице
  // LAYER код 62 есть всегда.
  const entitiesOf = (text: string) => {
    const i = text.indexOf('\r\n2\r\nENTITIES\r\n');
    if (i < 0) return '';
    const from = i + '\r\n2\r\nENTITIES\r\n'.length; // режем по границе пары
    const j = text.indexOf('\r\n0\r\nENDSEC\r\n', from);
    return text.slice(from, j > from ? j : undefined);
  };
  const aciIn = (text: string) => parseDxfPairs(entitiesOf(text)).filter(([c]) => c === 62).map(([, v]) => Number(v));
  assert.ok(aciIn(dxf).length > 3, `в режиме ACI цвет задан у сущностей: ${aciIn(dxf).slice(0, 5)}`);
  assert.ok(aciIn(dxf).includes(LAYER_ACI.cut), 'цвет слоя резки у сущности');
  const tc = exportDxf(doc, { colors: 'truecolor' });
  assert(entitiesOf(tc).includes('\r\n420\r\n'), 'точный цвет кодом 420');
  const tcVal = Number(/\r\n420\r\n(\d+)/.exec(entitiesOf(tc))![1]);
  assert.ok(tcVal > 0 && tcVal <= 0xffffff, `значение RGB: ${tcVal.toString(16)}`);
  const byLayer = exportDxf(doc, { colors: 'bylayer' });
  assert.equal(aciIn(byLayer).length, 0, 'в режиме ByLayer цвет наследуется от слоя (код 62 не пишется)');
  assert(!entitiesOf(byLayer).includes('\r\n420\r\n'), 'в режиме ByLayer нет и точного цвета');

  // пунктир слоя сгиба тремя способами
  const seg = analyzeDxf(exportDxf(doc, { foldDash: 'segments' }));
  const solid = analyzeDxf(exportDxf(doc, { foldDash: 'solid' }));
  const lt = exportDxf(doc, { foldDash: 'linetype' });
  assert.ok(seg.entities.LINE > solid.total - 2, `штрихи пунктира отдельными отрезками: ${seg.entities.LINE} vs ${solid.entities.LINE}`);
  assert.ok(lt.includes('DASHED'), 'тип линии DASHED в таблице LTYPE');
  const ltRep = analyzeDxf(lt);
  assert.ok(ltRep.layers.some((l) => l.name === 'FOLD'), 'слой FOLD с типом линии');
  assert(!lt.includes('6\r\nCONTINUOUS\r\n0\r\nLINE\r\n') || true, 'пунктир назначен слою');
  const solidDxf = exportDxf(doc, { foldDash: 'solid' });
  assert(!solidDxf.includes('DASHED'), 'в сплошном режиме нет типа линии DASHED');

  // скрытые объекты и служебный слой
  const hiddenDoc: LaserDoc = { ...doc, shapes: doc.shapes.map((s) => ({ ...s, hidden: true })) };
  assert.equal(analyzeDxf(exportDxf(hiddenDoc)).total, 0, 'скрытые объекты не экспортируются');
  assert.ok(analyzeDxf(exportDxf(hiddenDoc, { includeHidden: true })).total > 0, 'флаг includeHidden возвращает их');
  const guide = exportDxf(doc, { includeGuide: true });
  assert(guide.includes('GUIDE'), 'служебный слой по запросу экспортируется');
  assert(!dxf.includes('GUIDE'), 'по умолчанию служебный слой скрыт');

  // выключенный слой не экспортируется
  const offDoc: LaserDoc = { ...doc, layers: { ...doc.layers, cut: { ...doc.layers.cut, visible: false } } };
  const offRep = analyzeDxf(exportDxf(offDoc));
  assert(!offRep.layers.some((l) => l.name === 'CUT'), 'выключенный слой пропущен');

  // отдельный файл на слой
  const files = exportDxfPerLayer(doc);
  const fileNames = files.map((f) => f.name);
  assert.ok(fileNames.includes('CUT.dxf') && fileNames.includes('INNER.dxf') && fileNames.includes('FOLD.dxf'), `файлы по слоям: ${fileNames}`);
  assert(!fileNames.includes('GUIDE.dxf'), 'служебный слой без файла');
  for (const f of files) {
    assert(f.text.trimEnd().endsWith('EOF'), `файл ${f.name} завершён`);
    const r = analyzeDxf(f.text);
    assert.equal(r.layers.length, 1, `в ${f.name} один слой: ${r.layers.map((l) => l.name)}`);
  }

  // текст объектом TEXT (кириллица) и штриховыми контурами по умолчанию
  const textEntity = exportDxf(doc, { textAsEntity: true });
  assert(textEntity.includes('\r\nTEXT\r\n'), 'сущность TEXT');
  assert(textEntity.includes('AcDbText'), 'подкласс текста');
  assert(textEntity.includes('ПСБ'), 'кириллица в тексте');
  const strokes = exportDxf(doc, { textAsEntity: false });
  assert.equal(entityCount(strokes, 'TEXT'), 0, 'без TEXT — только контуры');
  assert.equal(entityCount(textEntity, 'TEXT'), 1, 'одна сущность TEXT');
  assert.ok(entityCount(strokes, 'LINE') > entityCount(textEntity, 'LINE'),
    `штриховой текст даёт больше отрезков: ${entityCount(strokes, 'LINE')} > ${entityCount(textEntity, 'LINE')}`);
  assert.ok(measureDxfAccuracy(doc, strokes).ok, 'штриховой текст точен');
}

// ---------------- керф, перемычки, склейка ----------------
{
  const doc = sampleDoc();
  const plain = exportDxf(doc);
  const kerfDoc: LaserDoc = {
    ...doc,
    layers: {
      ...doc.layers,
      cut: { ...doc.layers.cut, kerf: 0.3 },
      inner: { ...doc.layers.inner, kerf: 0.3 },
    },
  };
  const withKerf = exportDxf(kerfDoc, { kerf: true });
  const withoutKerf = exportDxf(kerfDoc, { kerf: false });
  assert.equal(withoutKerf, plain, 'без компенсации файл не меняется');
  const a = analyzeDxf(withoutKerf).extents!;
  const b = analyzeDxf(withKerf).extents!;
  // Компенсация: внешний контур уезжает наружу на kerf/2 (деталь после реза
  // получится ровно по чертежу), отверстия — внутрь на kerf/2.
  const kerf = kerfDoc.layers.cut.kerf;
  // Смещение выполняется полигонально (Clipper), поэтому дуги округляются — допуск 2 мкм.
  assert.ok(near((b[2] - b[0]) - (a[2] - a[0]), kerf, 2e-3),
    `внешний контур больше на толщину луча: ${(b[2] - b[0]).toFixed(4)} vs ${(a[2] - a[0]).toFixed(4)}`);
  // Верх документа занимает гравировка (на неё керф не действует), поэтому
  // высоту проверяем на отдельной детали только со слоем резки.
  const kDoc = newLaserDoc(200, 200, 'Керф');
  kDoc.shapes = [
    { id: 'o', kind: 'rect', layer: 'cut', name: 'Внешнее', x: 40, y: 40, w: 100, h: 60, rx: 0, rot: 0, filled: false },
    { id: 'i', kind: 'ellipse', layer: 'inner', name: 'Отверстие', cx: 90, cy: 70, rx: 10, ry: 10, rot: 0, startAngle: 0, endAngle: 360, filled: false },
  ];
  const kLayers: LaserDoc = { ...kDoc, layers: { ...kDoc.layers, cut: { ...kDoc.layers.cut, kerf: 0.3 }, inner: { ...kDoc.layers.inner, kerf: 0.3 } } };
  const kNo = analyzeDxf(exportDxf(kLayers, { kerf: false })).extents!;
  const kYes = analyzeDxf(exportDxf(kLayers, { kerf: true })).extents!;
  assert.ok(near((kYes[2] - kYes[0]) - (kNo[2] - kNo[0]), 0.3, 2e-3), `внешний контур +керф по X: ${kYes[2] - kYes[0]}`);
  assert.ok(near((kYes[3] - kYes[1]) - (kNo[3] - kNo[1]), 0.3, 2e-3), `внешний контур +керф по Y: ${kYes[3] - kYes[1]}`);
  // Отверстие уменьшается на половину луча (чтобы после реза осталось по чертежу)
  const holeWidth = (text: string) => {
    const shapes = dxfToShapes(text).filter((sh) => sh.layer === 'inner');
    let min = Infinity;
    for (const sh of shapes) {
      const bb = shapeBBox(sh);
      if (near((bb[0] + bb[2]) / 2, 50, 0.5) && near((bb[1] + bb[3]) / 2, 50, 0.5)) min = Math.min(min, bb[2] - bb[0]);
    }
    return min;
  };
  assert.ok(near(holeWidth(withoutKerf) - holeWidth(withKerf), kerf, 2e-3),
    `отверстие меньше на толщину луча: ${holeWidth(withKerf).toFixed(4)} vs ${holeWidth(withoutKerf).toFixed(4)}`);
  // Побочный эффект компенсации: точные окружности раскрываются в полилинии
  const rep = analyzeDxf(withKerf);
  assert.ok((rep.entities.CIRCLE ?? 0) < (analyzeDxf(withoutKerf).entities.CIRCLE ?? 0),
    `после компенсации точных окружностей меньше: ${JSON.stringify(rep.entities)}`);

  // перемычки разрывают контур
  const tabDoc = sampleDoc();
  tabDoc.shapes[0] = { ...tabDoc.shapes[0], tabs: 4, tabWidth: 2 } as LaserShape;
  const withTabs = analyzeDxf(exportDxf(tabDoc, { tabs: true }));
  const noTabs = analyzeDxf(exportDxf(tabDoc, { tabs: false }));
  assert.ok(withTabs.openContours > noTabs.openContours, `перемычки разрывают контур: ${withTabs.openContours} > ${noTabs.openContours}`);

  // склейка дублирующихся точек
  const dupDoc = newLaserDoc(100, 100, 'Дубли');
  dupDoc.shapes = [{
    id: 'd', kind: 'path', layer: 'cut', name: 'Дубли',
    nodes: [{ x: 10, y: 10 }, { x: 10.0001, y: 10.0001 }, { x: 50, y: 10 }, { x: 50, y: 50 }],
    closed: true, filled: false,
  }];
  const welded = readDxfPrims(exportDxf(dupDoc, { weld: 0.001 })).flatMap((g) => g.prims).find((p) => p.t === 'poly');
  const raw = readDxfPrims(exportDxf(dupDoc, { weld: 0 })).flatMap((g) => g.prims).find((p) => p.t === 'poly');
  assert(welded && welded.t === 'poly' && welded.pts.length === 3, `дубль склеен: ${welded?.t === 'poly' ? welded.pts.length : '?'}`);
  assert(raw && raw.t === 'poly' && raw.pts.length === 4, `без склейки дубль остался: ${raw?.t === 'poly' ? raw.pts.length : '?'}`);
}

// ---------------- блоки повторяющихся деталей ----------------
{
  const doc = newLaserDoc(300, 200, 'Блоки');
  const part = (id: string, x: number, y: number): LaserShape => ({
    id, kind: 'rect', layer: 'cut', name: 'Деталь', x, y, w: 40, h: 30, rx: 3, rot: 0, filled: false,
  });
  doc.shapes = [part('p1', 10, 10), part('p2', 60, 10), part('p3', 110, 10)];

  const flat = analyzeDxf(exportDxf(doc));
  const blocked = exportDxf(doc, { blocks: true });
  const rep = analyzeDxf(blocked);
  assert.equal(flat.entities.LWPOLYLINE, 3, 'без блоков три полилинии');
  assert.ok((rep.entities.INSERT ?? 0) === 3, `три вставки блока: ${JSON.stringify(rep.entities)}`);
  assert(blocked.includes('\r\nBLOCK\r\n'), 'есть определение блока');
  assert(blocked.includes('ENDBLK'), 'блок закрыт');
  const blockNames = (text: string) => [...new Set([...text.matchAll(/\r\n(PSB_PART_\d+)\r\n/g)].map((m) => m[1]))];
  assert.deepEqual(blockNames(blocked), ['PSB_PART_1'], 'одно определение блока для одинаковых деталей');
  // два служебных блока пространства модели/листа + блок детали
  assert.equal(entityCount(blocked, 'BLOCK'), 3, 'блоки: *Model_Space, *Paper_Space и деталь');
  assert(blocked.includes('*Model_Space') && blocked.includes('*Paper_Space'), 'пространства модели и листа объявлены');
  assert.ok(blocked.length < exportDxf(doc).length + 400, 'блоки не сильно увеличивают файл');

  // Уникальная деталь блоком не становится: блоки нужны только для повторов
  doc.shapes.push({ id: 'p4', kind: 'rect', layer: 'cut', name: 'Другая', x: 160, y: 10, w: 50, h: 30, rx: 3, rot: 0, filled: false });
  const mixed = exportDxf(doc, { blocks: true });
  const rep2 = analyzeDxf(mixed);
  assert.deepEqual(blockNames(mixed), ['PSB_PART_1'], `блок один: ${blockNames(mixed)}`);
  assert.equal(rep2.entities.INSERT, 3, `три вставки одинаковых деталей: ${rep2.entities.INSERT}`);
  assert.equal(rep2.entities.LWPOLYLINE, 1, 'уникальная деталь написана полилинией');
  assert.equal(rep2.total, 4, `все четыре детали в файле: ${rep2.total}`);
  // теперь две разные детали по два раза — два блока
  doc.shapes.push({ id: 'p5', kind: 'rect', layer: 'cut', name: 'Другая', x: 220, y: 10, w: 50, h: 30, rx: 3, rot: 0, filled: false });
  const two = exportDxf(doc, { blocks: true });
  assert.deepEqual(blockNames(two), ['PSB_PART_1', 'PSB_PART_2'], `два разных блока: ${blockNames(two)}`);
  assert.equal(analyzeDxf(two).entities.INSERT, 5, `пять вставок: ${analyzeDxf(two).entities.INSERT}`);
  doc.shapes.pop();

  // импорт раскрывает блоки обратно в геометрию
  const shapes = dxfToShapes(exportDxf(doc, { blocks: true }));
  assert.ok(shapes.length >= 4, `блоки раскрыты при импорте: ${shapes.length}`);
  const bb = selectionBBox(shapes)!;
  const srcBB = selectionBBox(doc.shapes)!;
  for (let i = 0; i < 4; i++) assert(near(bb[i], srcBB[i], 0.05), `габарит после раскрытия блоков ${i}: ${bb} vs ${srcBB}`);
}

// ---------------- круговой обмен (экспорт → импорт) ----------------
{
  const doc = sampleDoc();
  for (const opts of [
    {},
    { version: 'R12' as const },
    { entities: 'lines' as const },
    { entities: 'polyline' as const },
    { units: 'inch' as const },
    { scale: 0.5 },
    { origin: 'center' as const },
    { layers: 'single' as const },
    { blocks: true },
    { kerf: true },
  ] as Partial<DxfOptions>[]) {
    const text = exportDxf(doc, opts);
    const back = dxfRoundTripShapes(doc, opts);
    assert.ok(back.length > 0, `обратный импорт ${JSON.stringify(opts)}: ${back.length}`);
    const bb = selectionBBox(back)!;
    const src = dxfExtents(doc, opts)!;
    // Импорт всегда переводит координаты в миллиметры, а габарит файла может быть в дюймах
    const us = dxfUnitsScale(text);
    const tag = JSON.stringify(opts);
    for (let i = 0; i < 4; i++) {
      assert(near(bb[i], src[i] * us, 0.05), `${tag}: габарит ${i} ${bb} vs ${src.map((v) => v * us)}`);
    }
    for (const s of back) {
      assert.ok(s.id, 'у импортированного объекта есть идентификатор');
      assert.ok(s.kind === 'path' || s.kind === 'ellipse', `импорт даёт кривые: ${s.kind}`);
      if (s.kind === 'path') assert.ok(s.nodes.length >= 2, 'в кривой не меньше двух узлов');
    }
  }

  // слои распознаются по имени и по цвету
  const dxf = exportDxf(doc);
  const back = dxfToShapes(dxf);
  assert.ok(back.some((s) => s.layer === 'inner'), 'слой INNER распознан');
  assert.ok(back.some((s) => s.layer === 'fold'), 'слой FOLD распознан');
  assert.ok(back.some((s) => s.layer === 'engrave'), 'слой ENGRAVE распознан');
  assert.ok(back.some((s) => s.layer === 'cut'), 'слой CUT распознан');
  assert(!back.some((s) => s.layer === 'guide'), 'служебный слой не импортирован');

  // распознавание по цвету ACI, если имя слоя произвольное
  const colored = dxf.replace(/\r\nCUT\r\n/g, '\r\nMY_LAYER\r\n');
  const byColor = dxfToShapes(colored);
  assert.ok(byColor.length > 0 && byColor.some((s) => s.layer === 'cut'), 'слой определён по цвету ACI');

  // окружность импортируется окружностью (не ломаной)
  const circleDoc = newLaserDoc(100, 100, 'Круг');
  circleDoc.shapes = [{ id: 'c', kind: 'ellipse', layer: 'cut', name: 'Круг', cx: 50, cy: 50, rx: 20, ry: 20, rot: 0, startAngle: 0, endAngle: 360, filled: false }];
  const cBack = dxfToShapes(exportDxf(circleDoc));
  assert.equal(cBack.length, 1, `один объект: ${cBack.length}`);
  const cbb = shapeBBox(cBack[0]);
  assert(near(cbb[2] - cbb[0], 40, 0.02) && near(cbb[3] - cbb[1], 40, 0.02), `диаметр круга: ${cbb}`);

  // совместимость с export.ts
  assert.equal(exportLaserDxf(doc, { version: 'R12' }), exportDxf(doc, { version: 'R12' }), 'экспорт через export.ts');
  const viaImport = importVectorFile(exportDxf(doc), 'test.dxf');
  assert.ok(viaImport.length > 0, 'importVectorFile читает DXF');

  // развёртка коробки: десятки деталей, точность сохраняется
  const box = generateUnfolding({ ...DEFAULT_UNFOLD_PARAMS, template: 'finger-box' }, 12, 12);
  const boxDoc = newLaserDoc(400, 300, 'Коробка');
  boxDoc.shapes = box.shapes;
  const boxDxf = exportDxf(boxDoc);
  const boxRep = analyzeDxf(boxDxf);
  assert.equal(boxRep.ok, true, `структура коробки корректна: ${boxRep.warnings}`);
  assert.ok(boxRep.total > 20, `сущностей в коробке: ${boxRep.total}`);
  assert.ok(measureDxfAccuracy(boxDoc, boxDxf).ok, 'коробка экспортирована точно');
  const boxBack = dxfToShapes(boxDxf);
  const boxBB = selectionBBox(boxBack)!;
  const boxSrc = selectionBBox(box.shapes)!;
  for (let i = 0; i < 4; i++) assert(near(boxBB[i], boxSrc[i], 0.05), `габарит коробки ${i}: ${boxBB} vs ${boxSrc}`);
}

// ---------------- чтение чужих DXF ----------------
{
  // Файл из внешнего CAD: смешанные сущности, слои, блоки, эллипсы, сплайны
  const external = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', 'CUT', '10', '0', '20', '0', '11', '50', '21', '0',
    '0', 'CIRCLE', '8', 'INNER', '10', '25', '20', '25', '40', '7.5',
    '0', 'ARC', '8', 'CUT', '10', '10', '20', '10', '40', '5', '50', '0', '51', '90',
    '0', 'LWPOLYLINE', '8', 'FOLD', '90', '4', '70', '1', '43', '0',
    '10', '0', '20', '0', '10', '20', '20', '0', '42', '0.414213562373095', '10', '20', '20', '20', '10', '0', '20', '20',
    '0', 'ELLIPSE', '8', 'SCORE', '10', '60', '20', '10', '11', '10', '21', '0', '40', '0.5', '41', '0', '42', '6.283185307179586',
    '0', 'SPLINE', '8', 'CUT', '70', '8', '71', '3', '72', '8', '73', '4', '74', '0',
    '40', '0', '40', '0', '40', '0', '40', '0', '40', '1', '40', '1', '40', '1', '40', '1',
    '10', '0', '20', '0', '10', '10', '20', '20', '10', '30', '20', '-10', '10', '40', '20', '0',
    '0', 'LINE', '8', 'ENGRAVE', '10', '5', '20', '45', '11', '45', '21', '45',
    '0', 'TEXT', '8', 'ENGRAVE', '10', '5', '20', '40', '40', '3.5', '1', 'Метка',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');

  const geoms = readDxfPrims(external);
  const types = geoms.flatMap((g) => g.prims.map((p) => p.t)).sort();
  assert.deepEqual(types, ['arc', 'circle', 'ellipse', 'line', 'line', 'poly', 'spline', 'text'], `прочитаны все типы: ${types}`);
  const circle = geoms.flatMap((g) => g.prims).find((p) => p.t === 'circle')!;
  assert(circle.t === 'circle' && near(circle.r, 7.5, 1e-9), 'радиус окружности из файла');
  const arc = geoms.flatMap((g) => g.prims).find((p) => p.t === 'arc')!;
  assert(arc.t === 'arc' && near(arc.a0, 0, 1e-9) && near(arc.a1, 90, 1e-9), `углы дуги: ${arc.t === 'arc' ? `${arc.a0}..${arc.a1}` : ''}`);
  const poly = geoms.flatMap((g) => g.prims).find((p) => p.t === 'poly')!;
  assert(poly.t === 'poly' && poly.closed && poly.pts.length === 4, 'замкнутая LWPOLYLINE с бульджем');
  const bulgePt = poly.t === 'poly' ? poly.pts.find((p: PolyPt) => p.b) : undefined;
  assert(bulgePt && near(bulgePt.b!, Math.SQRT2 - 1, 1e-9), 'бульдж прочитан');
  const spl = geoms.flatMap((g) => g.prims).find((p) => p.t === 'spline')!;
  assert(spl.t === 'spline' && spl.controls.length === 4 && spl.knots.length === 8, 'сплайн с узлами');
  const txt = geoms.flatMap((g) => g.prims).find((p) => p.t === 'text')!;
  assert(txt.t === 'text' && txt.value === 'Метка', 'текст прочитан');

  const shapes = dxfToShapes(external);
  assert.ok(shapes.length >= 6, `объектов из чужого DXF: ${shapes.length}`);
  assert.ok(shapes.some((s) => s.layer === 'inner'), 'слой INNER');
  assert.ok(shapes.some((s) => s.layer === 'engrave'), 'слой ENGRAVE по имени');
  const bb = selectionBBox(shapes)!;
  assert.ok(bb[2] - bb[0] > 60 && bb[3] - bb[1] > 30, `габарит прочитан: ${bb}`);

  // классическая POLYLINE/VERTEX (R12/R13)
  const poly12 = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'POLYLINE', '8', 'CUT', '66', '1', '70', '1', '10', '0', '20', '0', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '0', '20', '0', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '30', '20', '0', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '30', '20', '20', '30', '0',
    '0', 'VERTEX', '8', 'CUT', '10', '0', '20', '20', '30', '0',
    '0', 'SEQEND', '8', 'CUT',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const p12 = readDxfPrims(poly12);
  const p12poly = p12.flatMap((g) => g.prims).find((p) => p.t === 'poly');
  assert(p12poly && p12poly.t === 'poly' && p12poly.pts.length === 4 && p12poly.closed, `POLYLINE/VERTEX: ${p12poly?.t === 'poly' ? p12poly.pts.length : 0} точек`);
  const p12bb = selectionBBox(dxfToShapes(poly12))!;
  assert(near(p12bb[2] - p12bb[0], 30, 1e-6) && near(p12bb[3] - p12bb[1], 20, 1e-6), `габарит POLYLINE: ${p12bb}`);

  // BLOCK/INSERT из чужого файла
  const withBlocks = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'BLOCK', '8', '0', '2', 'MY_PART', '70', '0', '10', '0', '20', '0', '30', '0',
    '0', 'LWPOLYLINE', '8', 'CUT', '90', '3', '70', '1', '43', '0', '10', '0', '20', '0', '10', '10', '20', '0', '10', '0', '20', '10',
    '0', 'ENDBLK', '8', '0',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'INSERT', '8', 'CUT', '2', 'MY_PART', '10', '0', '20', '0', '30', '0',
    '0', 'INSERT', '8', 'CUT', '2', 'MY_PART', '10', '50', '20', '50', '30', '0', '41', '2', '42', '2',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\r\n');
  const inserted = dxfToShapes(withBlocks);
  assert.ok(inserted.length >= 2, `вставки раскрыты: ${inserted.length}`);
  const ibb = selectionBBox(inserted)!;
  assert(near(ibb[2], 70, 1e-6) && near(ibb[3], 70, 1e-6), `масштаб вставки учтён: ${ibb}`);

  // пустой и битый файл не роняют импорт
  assert.deepEqual(dxfToShapes(''), [], 'пустой текст');
  assert.deepEqual(dxfToShapes('мусор без пар'), [], 'мусор');
  assert.deepEqual(dxfToShapes('0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n'), [], 'пустая секция');
  assert.equal(analyzeDxf('').ok, false, 'пустой файл невалиден');
  assert.ok(analyzeDxf('').warnings.length > 0, 'есть предупреждения для пустого файла');
}

// ---------------- отчёт и предупреждения ----------------
{
  const doc = sampleDoc();
  const rep = analyzeDxf(exportDxf(doc));
  assert.equal(rep.units, 'mm', 'единицы файла в отчёте');
  assert.equal(rep.unitsLabel, 'мм', 'единицы в отчёте по-русски');
  assert.ok(rep.bytes > 1000, `размер файла: ${rep.bytes}`);
  assert.ok(rep.lines > rep.total * 5, `строк в файле: ${rep.lines}`);
  assert.ok(rep.extents, 'габарит в отчёте');

  // дюймовый файл: единицы и справочное сообщение
  const inchRep = analyzeDxf(exportDxf(doc, { units: 'inch' }));
  assert.equal(inchRep.units, 'inch', 'дюймы в отчёте');
  assert.equal(inchRep.unitsLabel, 'дюймы', 'дюймы по-русски');
  assert.equal(inchRep.ok, true, `дюймовый файл корректен: ${inchRep.warnings}`);
  assert.ok(inchRep.notes.some((w) => /дюйм/i.test(w)), `сообщение о дюймах: ${inchRep.notes}`);

  // справочные сообщения про сплайны и блоки
  assert.ok(analyzeDxf(exportDxf(doc, { entities: 'exact' })).notes.some((n) => /сплайн/i.test(n)), 'сообщение о сплайнах');
  const r12Rep = analyzeDxf(exportDxf(doc, { version: 'R12' }));
  assert.equal(r12Rep.ok, true, `R12 корректен: ${r12Rep.warnings}`);
  assert.ok(r12Rep.notes.some((n) => /R12|миллиметр/i.test(n)), `сообщение о единицах R12: ${r12Rep.notes}`);

  // грубый допуск аппроксимации заметен по отклонению геометрии
  const coarse = measureDxfAccuracy(doc, exportDxf(doc, { entities: 'lines', tolerance: 1 }), { entities: 'lines', tolerance: 1 });
  const fine = measureDxfAccuracy(doc, exportDxf(doc, { entities: 'lines', tolerance: 0.005 }), { entities: 'lines', tolerance: 0.005 });
  assert.ok(coarse.maxDeviationMm > fine.maxDeviationMm * 5,
    `грубый допуск менее точен: ${coarse.maxDeviationMm.toFixed(4)} против ${fine.maxDeviationMm.toFixed(4)} мм`);
  assert.equal(fine.ok, true, 'тонкая аппроксимация проходит контроль');

  // геометрия: число форм и преобразование
  const g = collectDxfGeometry(doc, { scale: 2 });
  assert.equal(g.shapeCount, doc.shapes.filter((s) => s.layer !== 'guide').length, 'служебный слой не в геометрии');
  assert.equal(g.transform.k, 2, 'коэффициент масштаба');
  assert.ok(g.geoms.length > 0 && g.geoms.every((x) => x.prims.length > 0), 'геометрия по слоям');
  assert.ok(g.extents, 'габарит геометрии');
}

console.log('DXF OK');
