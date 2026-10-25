// Обмен чертежами с CorelDRAW и соседними редакторами: векторный PDF, EPS
// (PostScript/AI) и PLT (HPGL/2). Проверяем единицы 1:1 мм, структуру PDF
// (таблица xref, слои OCG), DSC-заголовки EPS, юниты плоттера, круговой обмен
// «экспорт → импорт» и чтение чужих файлов: сжатые потоки PDF, формы XObject,
// объект-потоки PDF 1.5, матрицы PostScript, процедуры из пролога, дуги HPGL.
// Отдельно — что закрытый .cdr не глотается молча, а объясняет, что делать.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  newLaserDoc, polylineLength, selectionBBox, shapeToPolylines,
  type LaserDoc, type LaserShape,
} from '../src/laser/model';
import { exportLaserDxf } from '../src/laser/export';
import { dxfRoundTripShapes } from '../src/laser/dxf';
import {
  CDR_MESSAGE, DEFAULT_VECTOR_OPTIONS, HPGL_UNITS_PER_MM, MM_PER_PT, PLT_PENS, PT_PER_MM,
  asciiText, collectVectorGeom, exportVectorEps, exportVectorPdf, exportVectorPlt, hexToRgb01,
  normalizeVectorOptions, vectorGeomBounds, vn,
} from '../src/laser/corel';
import {
  importVectorData, layerByName, parsePdfVector, parsePlt, parsePostScript, sniffCorelFormat,
  tokenizePlt,
} from '../src/laser/corel-parse';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

/** Суммарная длина всех контуров набора фигур (мм). */
function totalLength(shapes: LaserShape[]): number {
  let sum = 0;
  for (const s of shapes) for (const pl of shapeToPolylines(s)) sum += polylineLength(pl);
  return sum;
}

/** Документ со всеми содержательными слоями: контур, отверстие, сгиб, заливка, размеры. */
function sampleDoc(): LaserDoc {
  const doc = newLaserDoc(300, 200, 'Коробка 120×80');
  doc.shapes = [
    {
      id: 'panel', kind: 'rect', layer: 'cut', name: 'Панель',
      x: 20, y: 20, w: 120, h: 80, rx: 0, rot: 0, filled: false,
    },
    {
      id: 'hole', kind: 'ellipse', layer: 'inner', name: 'Отверстие',
      cx: 60, cy: 60, rx: 10, ry: 10, rot: 0, startAngle: 0, endAngle: 360, filled: false,
    },
    {
      id: 'bend', kind: 'path', layer: 'fold', name: 'Сгиб',
      nodes: [{ x: 20, y: 60 }, { x: 140, y: 60 }], closed: false, filled: false,
    },
    {
      id: 'mark', kind: 'text', layer: 'engrave', name: 'Маркировка',
      x: 30, y: 85, text: 'PSB', size: 10, strokeWidth: 0.4, rot: 0, mirror: false, filled: true,
    },
    {
      id: 'size', kind: 'dim', layer: 'guide', name: 'Размер',
      x1: 20, y1: 20, x2: 140, y2: 20, offset: -10,
    },
    {
      id: 'ghost', kind: 'rect', layer: 'cut', name: 'Скрытый', hidden: true,
      x: 200, y: 150, w: 30, h: 20, rx: 0, rot: 0, filled: false,
    },
  ];
  return doc;
}

/** Фигуры документа, которые обязаны попасть в файл (без служебного слоя и скрытых). */
function exportedShapes(doc: LaserDoc): LaserShape[] {
  return doc.shapes.filter((s) => !s.hidden && s.layer !== 'guide');
}

const enc = new TextEncoder();

// ---------------- единицы и опции ----------------
{
  assert.ok(near(PT_PER_MM, 72 / 25.4), 'пунктов в миллиметре');
  assert.ok(near(PT_PER_MM * MM_PER_PT, 1, 1e-12), 'мм и пункты взаимно обратны');
  assert.equal(HPGL_UNITS_PER_MM, 40, 'юнитов HPGL в миллиметре (1 юнит = 0.025 мм)');

  const pens = Object.values(PLT_PENS);
  assert.equal(new Set(pens).size, pens.length, 'перья PLT не повторяются');
  assert.equal(PLT_PENS.cut, 1, 'внешний контур — перо 1');
  assert.equal(PLT_PENS.guide, 6, 'служебный слой — перо 6');

  const o = normalizeVectorOptions({ strokeWidthMm: -3, tolerance: 99, pdfLayers: 'yes' as unknown as boolean });
  assert.equal(o.strokeWidthMm, 0, 'толщина линии не бывает отрицательной');
  assert.equal(o.tolerance, 2, 'допуск аппроксимации ограничен сверху');
  assert.equal(o.pdfLayers, DEFAULT_VECTOR_OPTIONS.pdfLayers, 'не-булево значение заменяется умолчанием');
  assert.equal(DEFAULT_VECTOR_OPTIONS.pdfLayers, true, 'слои PDF включены по умолчанию');
  assert.equal(DEFAULT_VECTOR_OPTIONS.pltPensPerLayer, true, 'перо на слой включено по умолчанию');
  assert.equal(normalizeVectorOptions().strokeWidthMm, 0.2, 'толщина линии по умолчанию 0.2 мм');

  assert.deepEqual(hexToRgb01('#ff0000'), [1, 0, 0], 'красный в 0..1');
  assert.ok(near(hexToRgb01('#22c55e')[1], 0xc5 / 255), 'зелёный канал цвета слоя сгиба');
  assert.deepEqual(hexToRgb01('мусор'), [0, 0, 0], 'битый цвет не роняет экспорт');

  assert.equal(vn(1 / 3), '0.333', 'три знака после точки');
  assert.equal(vn(-0.00001), '0', 'без отрицательного нуля');
  assert.equal(vn(NaN), '0', 'NaN не попадает в файл');

  assert.equal(asciiText('Развёртка корпуса'), 'Razvertka korpusa', 'транслитерация заголовка');
  assert.equal(asciiText('  '), 'Drawing', 'пустой заголовок заменяется');
  assert.equal(asciiText('100% лист'), '100 list', 'процент не ломает DSC-комментарий');
}

// ---------------- общая геометрия слоёв ----------------
{
  const doc = sampleDoc();
  const layers = collectVectorGeom(doc);
  assert.deepEqual(layers.map((l) => l.name), ['ENGRAVE', 'FOLD', 'INNER', 'CUT'],
    'порядок слоёв как в LASER_LAYER_ORDER, служебный слой не выводится');
  assert.deepEqual(collectVectorGeom(doc, { includeGuide: true }).map((l) => l.name).slice(-1), ['GUIDE'],
    'служебный слой появляется по опции');

  const cut = layers.find((l) => l.id === 'cut')!;
  assert.equal(cut.paths.length, 1, 'скрытый объект не попал в геометрию');
  assert.ok(cut.paths.every((p) => !p.fill), 'контур панели не залит');
  assert.equal(cut.dash, null, 'сплошная линия у слоя резки');
  assert.ok(near(cut.width, 0.2), 'толщина линии из опций');
  assert.deepEqual(cut.rgb, hexToRgb01('#ff453a'), 'цвет слоя');

  const fold = layers.find((l) => l.id === 'fold')!;
  assert.deepEqual(fold.dash, [4, 2], 'пунктир биговки 4/2 мм');

  const inner = layers.find((l) => l.id === 'inner')!;
  const circle = inner.paths[0].subpaths[0];
  assert.equal(circle.nodes.length, 4, 'окружность — четыре кубических Безье');
  assert.equal(circle.closed, true, 'окружность замкнута');
  assert.ok(circle.nodes.every((n) => n.cp1x !== undefined && n.cp2x !== undefined),
    'у окружности есть рычаги — кривая не аппроксимирована полилинией');

  const engrave = layers.find((l) => l.id === 'engrave')!;
  assert.ok(engrave.paths.every((p) => p.fill), 'слой заливки экспортируется залитым');

  // скрытые объекты и невидимые слои
  assert.equal(collectVectorGeom(doc, { includeHidden: true }).find((l) => l.id === 'cut')!.paths.length, 2,
    'includeHidden возвращает скрытый объект');
  doc.layers.inner.visible = false;
  assert.ok(!collectVectorGeom(doc).some((l) => l.id === 'inner'), 'невидимый слой не выводится');
  doc.layers.inner.visible = true;

  const bb = vectorGeomBounds(layers)!;
  assert.ok(near(bb[0], 20, 1e-9) && near(bb[1], 20, 1e-9), 'габарит начинается у панели');
  assert.ok(near(bb[2], 140, 1e-9) && near(bb[3], 100, 1e-9), 'габарит заканчивается панелью');

  // дырки остаются отдельными подпутями — для even-odd заливки
  const donut: LaserDoc = newLaserDoc(100, 100, 'Пончик');
  donut.shapes = [{
    id: 'd', kind: 'path', layer: 'cut', name: 'Пончик',
    nodes: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
    holes: [[{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }]],
    closed: true, filled: true,
  }];
  const dp = collectVectorGeom(donut)[0].paths[0];
  assert.equal(dp.subpaths.length, 2, 'контур и отверстие — два подпути');
  assert.equal(dp.fill, true, 'заливка сохранена');
}

// ---------------- PDF: структура файла ----------------
{
  const doc = sampleDoc();
  const pdf = exportVectorPdf(doc);
  assert.ok(pdf.startsWith('%PDF-1.7'), 'версия PDF');
  assert.ok(pdf.endsWith('%%EOF\n'), 'файл заканчивается %%EOF');
  for (let i = 0; i < pdf.length; i++) {
    assert.ok(pdf.charCodeAt(i) < 128, `PDF только ASCII (иначе xref собьётся), позиция ${i}`);
  }

  // MediaBox в пунктах: 1 мм = 72/25.4 pt, лист 300×200
  const mb = /\/MediaBox \[([^\]]+)\]/.exec(pdf)!;
  const box = mb[1].split(/\s+/).map(Number);
  assert.deepEqual(box, [0, 0, 300 * PT_PER_MM, 200 * PT_PER_MM].map((v) => Number(vn(v))),
    'MediaBox = размер листа в пунктах, масштаб 1:1');

  // таблица xref: каждое смещение указывает ровно на начало своего объекта
  const startXref = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)![1]);
  assert.equal(pdf.slice(startXref, startXref + 4), 'xref', 'startxref указывает на таблицу xref');
  const xrefBody = pdf.slice(startXref);
  const header = /^xref\n(\d+) (\d+)\n/.exec(xrefBody)!;
  assert.equal(header[1], '0', 'нумерация xref с нуля');
  const count = Number(header[2]);
  const rows = xrefBody.slice(header[0].length).split('\n').slice(0, count);
  assert.equal(rows.length, count, 'в xref столько же записей, сколько объявлено');
  rows.forEach((row, i) => {
    // 20 байт на запись вместе с переводом строки, которым строки разделены
    assert.equal(row.length, 19, `запись xref ровно 20 байт: «${row}»`);
    assert.equal(row[10], ' ', 'разделитель смещения');
    assert.equal(row[16], ' ', 'разделитель поколения');
    assert.equal(row[18], ' ', 'двухбайтовый конец записи');
    const off = Number(row.slice(0, 10));
    if (i === 0) {
      assert.equal(row[17], 'f', 'нулевой объект свободный');
      assert.equal(row.slice(11, 16), '65535', 'поколение свободного объекта');
      assert.equal(off, 0, 'нулевой объект имеет нулевое смещение');
      return;
    }
    assert.equal(row[17], 'n', 'объект занят');
    assert.equal(pdf.slice(off, off + `${i} 0 obj`.length), `${i} 0 obj`,
      `смещение объекта ${i} точное`);
  });
  const trailer = /trailer\n<< \/Size (\d+) \/Root 1 0 R \/Info (\d+) 0 R >>/.exec(pdf)!;
  assert.equal(Number(trailer[1]), count, '/Size совпадает с числом записей xref');
  assert.ok(pdf.includes(`${trailer[2]} 0 obj`), 'объект Info существует');

  // /Length потока contents равен фактической длине
  const len = Number(/<< \/Length (\d+) >>\nstream\n/.exec(pdf)![1]);
  const from = pdf.indexOf('stream\n') + 'stream\n'.length;
  const data = pdf.slice(from, from + len);
  assert.equal(pdf.slice(from + len, from + len + '\nendstream'.length), '\nendstream',
    '/Length потока содержимого точный');
  assert.ok(data.includes(' m\n') || data.includes(' m'), 'в потоке есть построение пути');

  // слои PDF (OCG): имена, каталог, свойства страницы, marked content
  for (const name of ['ENGRAVE', 'FOLD', 'INNER', 'CUT']) {
    assert.ok(pdf.includes(`/Type /OCG /Name (${name})`), `слой ${name} объявлен как OCG`);
  }
  assert.ok(/\/OCProperties << \/OCGs \[([^\]]+)\]/.test(pdf), 'каталог ссылается на список OCG');
  const ocgs = /\/OCGs \[([^\]]+)\]/.exec(pdf)![1].match(/\d+ 0 R/g) ?? [];
  assert.equal(ocgs.length, 4, 'четыре слоя в /OCGs');
  const order = /\/Order \[([^\]]+)\]/.exec(pdf)![1].match(/\d+ 0 R/g) ?? [];
  assert.deepEqual(order, ocgs, 'порядок слоёв в /Order совпадает со списком OCG');
  assert.ok(/\/Properties << \/MC0 \d+ 0 R/.test(pdf), 'ресурсы страницы знают свойства слоёв');
  const bdc = (pdf.match(/\/OC \/MC\d+ BDC/g) ?? []).length;
  const emc = (pdf.match(/\bEMC\b/g) ?? []).length;
  assert.equal(bdc, 4, 'каждый слой обёрнут в marked content');
  assert.equal(emc, 4, 'каждый BDC закрыт');

  // живопись: обводка, заливка по чётности, пунктир, кубики
  assert.ok(/B\*/.test(data), 'залитые объекты рисуются B* (even-odd)');
  assert.ok(/\nS\n/.test(data), 'контуры обводятся S');
  assert.ok(data.includes(`[${vn(4 * PT_PER_MM)} ${vn(2 * PT_PER_MM)}] 0 d`), 'пунктир биговки в пунктах');
  assert.ok(/ c\n/.test(data), 'кривые Безье остаются кубиками');
  assert.ok(data.includes(`${vn(0.2 * PT_PER_MM)} w`), 'толщина линии в пунктах');
  assert.ok(data.includes('1 0.271 0.227 RG'), 'цвет слоя резки');

  // кириллическое имя проекта — hex-строка UTF-16BE с BOM
  assert.ok(/\/Title <FEFF041A043E0440/.test(pdf), 'заголовок в UTF-16BE, файл остаётся ASCII');

  // без слоёв PDF остаётся валидным, но без OCG
  const flat = exportVectorPdf(doc, { pdfLayers: false });
  assert.ok(!flat.includes('/OCProperties'), 'pdfLayers:false убирает слои');
  assert.ok(!flat.includes('BDC'), 'без слоёв нет marked content');
  assert.ok(flat.includes('%%EOF'), 'файл по-прежнему завершён');

  // пустой лист не роняет экспорт
  const empty = exportVectorPdf(newLaserDoc(50, 50, 'Пусто'));
  assert.ok(empty.startsWith('%PDF-1.7') && empty.includes('%%EOF'), 'пустой документ даёт валидный PDF');
}

// ---------------- PDF: круговой обмен ----------------
{
  const doc = sampleDoc();
  const pdf = exportVectorPdf(doc);
  const back = await parsePdfVector(enc.encode(pdf));
  assert.equal(back.kind, 'pdf', 'формат определён как PDF');
  assert.equal(back.pages, 1, 'одна страница');
  assert.ok(back.shapes.length >= 4, `фигуры вернулись: ${back.shapes.length}`);

  const srcBb = selectionBBox(exportedShapes(doc))!;
  const gotBb = selectionBBox(back.shapes)!;
  srcBb.forEach((v, i) => assert.ok(near(v, gotBb[i], 1e-3), `габарит PDF совпадает (${i}): ${srcBb} vs ${gotBb}`));

  const srcLen = totalLength(exportedShapes(doc));
  const gotLen = totalLength(back.shapes);
  assert.ok(Math.abs(srcLen - gotLen) / srcLen < 0.01,
    `длина контуров совпадает: ${srcLen.toFixed(3)} против ${gotLen.toFixed(3)} мм`);

  const layers = new Set(back.shapes.map((s) => s.layer));
  assert.deepEqual([...layers].sort(), ['cut', 'engrave', 'fold', 'inner'],
    'слои восстановлены по OCG');
  assert.ok(back.shapes.filter((s) => s.layer === 'fold').every((s) => !s.closed), 'сгиб остался отрезком');
  assert.ok(back.shapes.some((s) => s.layer === 'inner' && s.closed), 'отверстие замкнуто');
  assert.ok(back.shapes.every((s) => s.kind === 'path'), 'импорт возвращает кривые');
  assert.ok(back.notes.every((n) => !/текст/i.test(n)), 'в нашем PDF нет текста — предупреждений о тексте нет');

  // скрытый объект и служебный слой не возвращаются
  assert.ok(near(gotBb[2], 140, 1e-3), 'скрытый объект не импортирован');
}

// ---------------- PDF: чужие файлы ----------------
{
  /** Собрать PDF из частей: словарь + потоки, xref не обязателен (ищем по «N 0 obj»). */
  function buildPdf(parts: (string | Uint8Array)[]): Uint8Array {
    let total = 0;
    const bufs = parts.map((p) => {
      const b = typeof p === 'string' ? enc.encode(p) : p;
      total += b.length;
      return b;
    });
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of bufs) { out.set(b, off); off += b.length; }
    return out;
  }

  // 1) поток, сжатый FlateDecode (так保存яют CorelDRAW и Illustrator)
  const content = '10 10 m 190 10 l 190 90 l 10 90 l h S';
  const zipped = deflateSync(Buffer.from(content, 'latin1'));
  const flate = buildPdf([
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${zipped.length} /Filter /FlateDecode >>\nstream\n`,
    zipped,
    '\nendstream\nendobj\n',
    'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n',
  ]);
  const res = await parsePdfVector(flate);
  assert.equal(res.shapes.length, 1, 'сжатый поток распакован и прочитан');
  const bb = selectionBBox(res.shapes)!;
  assert.ok(near(bb[0], 10 * MM_PER_PT, 1e-3), 'координаты из пунктов переведены в мм');
  assert.ok(near(bb[2], 190 * MM_PER_PT, 1e-3), 'правая граница страницы');
  assert.equal(res.shapes[0].layer, 'cut', 'без OCG контур попадает на основной слой');
  assert.equal(res.shapes[0].closed, true, 'closepath замкнул контур');

  // 2) MediaBox со сдвигом: начало координат страницы вычитается
  const shifted = buildPdf([
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [100 50 400 250] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${'100 50 m 200 50 l 200 150 l S'.length} >>\nstream\n100 50 m 200 50 l 200 150 l S\nendstream\nendobj\n`,
    'trailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n',
  ]);
  const sh = await parsePdfVector(shifted);
  const sbb = selectionBBox(sh.shapes)!;
  assert.ok(near(sbb[0], 0, 1e-6) && near(sbb[1], 0, 1e-6), 'сдвиг MediaBox вычтен');
  assert.ok(near(sbb[2], 100 * MM_PER_PT, 1e-6), 'размер сохранён');

  // 3) форма XObject через Do с собственной матрицей
  const formStream = '0 0 m 50 0 l 50 50 l 0 50 l h S';
  const form = buildPdf([
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] '
      + '/Resources << /XObject << /Fm1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${'q 1 0 0 1 20 30 cm /Fm1 Do Q'.length} >>\nstream\nq 1 0 0 1 20 30 cm /Fm1 Do Q\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Length ${formStream.length} >>\nstream\n${formStream}\nendstream\nendobj\n`,
    'trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n',
  ]);
  const fx = await parsePdfVector(form);
  assert.equal(fx.shapes.length, 1, 'геометрия из формы XObject импортирована');
  const fbb = selectionBBox(fx.shapes)!;
  assert.ok(near(fbb[0], 20 * MM_PER_PT, 1e-6), 'матрица cm сдвинула форму');
  assert.ok(near(fbb[3], (30 + 50) * MM_PER_PT, 1e-6), 'высота формы учтена');

  // 4) PDF 1.5: страница лежит внутри сжатого потока объектов (ObjStm)
  const inner = '3 0 << /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>';
  const head = `${inner.length} `;
  const objStmBody = `3 ${head.length}${inner}`;
  const pageStream = '0 0 m 100 0 l 100 100 l S';
  const objStm = buildPdf([
    '%PDF-1.5\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    `4 0 obj\n<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream\nendobj\n`,
    `6 0 obj\n<< /Type /ObjStm /N 1 /First ${head.length} /Length ${objStmBody.length} >>\nstream\n${objStmBody}\nendstream\nendobj\n`,
    'trailer\n<< /Size 7 /Root 1 0 R >>\n%%EOF\n',
  ]);
  const os = await parsePdfVector(objStm);
  assert.equal(os.shapes.length, 1, 'страница из ObjStm найдена и прочитана');
  assert.ok(near(selectionBBox(os.shapes)![2], 100 * MM_PER_PT, 1e-6), 'геометрия страницы на месте');

  // 5) поворот страницы, несколько страниц, текст, неподдержанный фильтр — в примечания
  const notes = buildPdf([
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Rotate 90 /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 60 >>\nstream\nBT /F1 12 Tf (Привет) Tj ET\n0 0 m 50 0 l S\nendstream\nendobj\n',
    '7 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 8 0 R >>\nendobj\n',
    '8 0 obj\n<< /Length 10 /Filter /LZWDecode >>\nstream\n0 0 m 1 1 l S\nendstream\nendobj\n',
    'trailer\n<< /Size 9 /Root 1 0 R >>\n%%EOF\n',
  ]);
  const nt = await parsePdfVector(notes);
  assert.equal(nt.pages, 2, 'число страниц посчитано');
  assert.ok(nt.notes.some((n) => /повёрнута/.test(n)), 'поворот страницы отмечен');
  assert.ok(nt.notes.some((n) => /первая/.test(n)), 'импортирована только первая страница — с примечанием');
  assert.ok(nt.notes.some((n) => /Текст/.test(n)), 'текст без кривых отмечен подсказкой');
  assert.equal(nt.shapes.length, 1, 'вектор рядом с текстом импортирован');

  // 6) мусор вместо PDF не роняет парсер
  const junk = await parsePdfVector(enc.encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n'));
  assert.equal(junk.shapes.length, 0, 'пустой PDF без страниц');
  assert.ok(junk.notes.length > 0, 'про пустой PDF есть примечание');
}

// ---------------- EPS: структура ----------------
{
  const doc = sampleDoc();
  const eps = exportVectorEps(doc);
  assert.ok(eps.startsWith('%!PS-Adobe-3.0 EPSF-3.0'), 'заголовок EPS 3.0');
  assert.ok(eps.includes('%%BoundingBox: 0 0 851 567'), 'BoundingBox целыми пунктами (лист 300×200 мм)');
  assert.ok(eps.includes(`%%HiResBoundingBox: 0 0 ${vn(300 * PT_PER_MM)} ${vn(200 * PT_PER_MM)}`),
    'HiResBoundingBox точный');
  for (const dsc of ['%%Title: Korobka 120x80', '%%LanguageLevel: 2', '%%Pages: 1', '%%Page: 1 1', '%%EOF']) {
    assert.ok(eps.includes(dsc), `в EPS есть ${dsc}`);
  }
  assert.ok(!/[^\x20-\x7e\n]/.test(eps), 'EPS целиком ASCII — DSC-комментарии не ломаются');

  // слои помечены для обратного импорта
  for (const name of ['ENGRAVE', 'FOLD', 'INNER', 'CUT']) {
    assert.ok(eps.includes(`%PSBeesLayer: ${name}`), `слой ${name} помечен`);
  }
  assert.ok(eps.includes('curveto'), 'кривые Безье, а не полилиния');
  assert.ok(eps.includes('closepath'), 'замкнутые контуры закрыты');
  assert.ok(eps.includes(`[${vn(4 * PT_PER_MM)} ${vn(2 * PT_PER_MM)}] 0 setdash`), 'пунктир биговки');
  assert.ok(eps.includes('1 0.271 0.227 setrgbcolor'), 'цвет слоя');
  assert.ok(eps.includes('gsave eofill grestore stroke'), 'заливка с обводкой по чётности');
  // grestore встречается и внутри заливок («gsave eofill grestore stroke»),
  // поэтому обёртки слоёв считаем по отдельным строкам
  assert.equal((eps.match(/^gsave$/gm) ?? []).length, 4, 'каждый слой обёрнут gsave');
  assert.equal((eps.match(/^grestore$/gm) ?? []).length, 4, 'каждый слой закрыт grestore');

  // геометрия вне листа расширяет габарит
  const wide = newLaserDoc(100, 100, 'Вылет');
  wide.shapes = [{
    id: 'out', kind: 'path', layer: 'cut', name: 'Вылет',
    nodes: [{ x: -20, y: -10 }, { x: 150, y: 120 }], closed: false, filled: false,
  }];
  const weps = exportVectorEps(wide);
  assert.ok(weps.includes(`%%BoundingBox: ${Math.floor(-20 * PT_PER_MM)} ${Math.floor(-10 * PT_PER_MM)}`),
    'BoundingBox учитывает объекты вне листа');
}

// ---------------- EPS: круговой обмен ----------------
{
  const doc = sampleDoc();
  const back = parsePostScript(exportVectorEps(doc));
  assert.equal(back.kind, 'ps', 'формат определён');
  assert.equal(back.pages, 1, 'одна страница');
  const srcBb = selectionBBox(exportedShapes(doc))!;
  const gotBb = selectionBBox(back.shapes)!;
  srcBb.forEach((v, i) => assert.ok(near(v, gotBb[i], 1e-3), `габарит EPS совпадает (${i})`));
  const srcLen = totalLength(exportedShapes(doc));
  const gotLen = totalLength(back.shapes);
  assert.ok(Math.abs(srcLen - gotLen) / srcLen < 0.01,
    `длина контуров EPS совпадает: ${srcLen.toFixed(3)} против ${gotLen.toFixed(3)}`);
  assert.deepEqual([...new Set(back.shapes.map((s) => s.layer))].sort(), ['cut', 'engrave', 'fold', 'inner'],
    'слои восстановлены по меткам %PSBeesLayer');
  assert.ok(back.shapes.some((s) => s.layer === 'engrave' && s.filled), 'заливка передана');
}

// ---------------- PostScript: чужие файлы ----------------
{
  // матрицы: translate, scale, rotate, concat, gsave/grestore, относительные операторы
  const eps = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 200 200',
    '%%EndComments',
    '72 25.4 div dup scale',   // дальше координаты в миллиметрах
    'gsave',
    '10 20 translate',
    'newpath 0 0 moveto 30 0 rlineto 0 15 rlineto closepath stroke',
    'grestore',
    'gsave',
    '2 2 scale',
    'newpath 5 5 moveto 10 5 lineto 10 10 lineto stroke',
    'grestore',
    'gsave',
    '90 rotate',
    'newpath 0 40 moveto 0 60 lineto stroke',
    'grestore',
    '%%EOF',
  ].join('\n');
  const res = parsePostScript(eps);
  assert.equal(res.shapes.length, 3, 'три объекта из трёх gsave-блоков');

  const moved = selectionBBox([res.shapes[0]])!;
  assert.ok(near(moved[0], 10, 1e-6) && near(moved[1], 20, 1e-6), 'translate применён');
  assert.ok(near(moved[2], 40, 1e-6) && near(moved[3], 35, 1e-6), 'rlineto и масштаб 1 мм');
  assert.equal(res.shapes[0].closed, true, 'closepath');

  const scaled = selectionBBox([res.shapes[1]])!;
  assert.ok(near(scaled[0], 10, 1e-6) && near(scaled[2], 20, 1e-6), 'scale 2 применён');

  const rotated = selectionBBox([res.shapes[2]])!;
  // (0,40)→(-40,0) и (0,60)→(-60,0): поворот против часовой в системе с Y вверх
  assert.ok(near(rotated[0], -60, 1e-6) && near(rotated[2], -40, 1e-6), 'rotate 90° повернул отрезок');
  assert.ok(near(rotated[1], 0, 1e-6) && near(rotated[3], 0, 1e-6), 'после поворота отрезок лежит на оси X');

  // grestore вернул матрицу: четвёртый объект рисуется в исходной системе
  const after = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 100 100',
    '%%EndComments',
    'gsave 100 100 translate newpath 0 0 moveto 10 0 lineto stroke grestore',
    'newpath 0 0 moveto 10 0 lineto stroke',
    '%%EOF',
  ].join('\n'));
  const abb = selectionBBox(after.shapes)!;
  assert.ok(near(abb[0], 0, 1e-6), 'после grestore матрица восстановлена');

  // процедуры из пролога: так пишут gnuplot, matplotlib и старые версии CorelDRAW
  const prolog = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 100 100',
    '%%EndComments',
    '/M { moveto } def',
    '/L { lineto } def',
    '/CP { closepath } def',
    '/S2 { stroke } def',
    'newpath 5 5 M 45 5 L 45 25 L CP S2',
    '%%EOF',
  ].join('\n'));
  assert.equal(prolog.shapes.length, 1, 'процедуры пролога исполняются');
  const pbb = selectionBBox(prolog.shapes)!;
  assert.ok(near(pbb[0], 5 * MM_PER_PT, 1e-6) && near(pbb[2], 45 * MM_PER_PT, 1e-6),
    'координаты через процедуры правильные');

  // бинарное превью EPS не должно ломать разбор
  const withPreview = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 100 100',
    '%%BeginPreview: 8 8 1 8',
    '% (несбалансированные [ скобки { и << мусор >>',
    '% 00FF00FF ~> garbage',
    '%%EndPreview',
    '%%EndComments',
    'newpath 0 0 moveto 72 0 lineto 72 72 lineto stroke',
    '%%EOF',
  ].join('\n'));
  assert.equal(withPreview.shapes.length, 1, 'превью пропущено, геометрия прочитана');
  assert.ok(near(selectionBBox(withPreview.shapes)![2], 25.4, 1e-6), '72 пункта = 25.4 мм');

  // Illustrator-диалект: u/U, q/Q, cm, re, n, F, S
  const ai = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0',
    '%%BoundingBox: 0 0 300 300',
    '%%EndComments',
    'u',
    'q',
    '1 0 0 1 28.3465 28.3465 cm',
    '0 0 1 RG',
    '0 0 100 50 re',
    'S',
    'Q',
    'U',
    '%%EOF',
  ].join('\n'), 'AI');
  assert.equal(ai.shapes.length, 1, 'AI-операторы понятны');
  assert.equal(ai.shapes[0].name, 'AI Контур', 'подпись импортера в имени объекта');
  const abb2 = selectionBBox(ai.shapes)!;
  // cm сдвигает начало на 28.3465 пт = 10 мм, а сам прямоугольник задан в пунктах
  assert.ok(near(abb2[0], 28.3465 * MM_PER_PT, 1e-3), 'cm сдвинул начало на 10 мм');
  assert.ok(near(abb2[2], (28.3465 + 100) * MM_PER_PT, 1e-3), 're: ширина 100 пт');
  assert.ok(near(abb2[3], (28.3465 + 50) * MM_PER_PT, 1e-3), 're: высота 50 пт');
  assert.equal(ai.shapes[0].closed, true, 'прямоугольник замкнут');

  // определение слоя по цвету и по пунктиру
  const byColor = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0', '%%BoundingBox: 0 0 100 100', '%%EndComments',
    '0.133 0.773 0.369 setrgbcolor', // #22c55e — цвет слоя сгиба
    'newpath 0 0 moveto 100 0 lineto stroke',
    '0 0 0 setrgbcolor [ ] 0 setdash newpath 0 10 moveto 100 10 lineto stroke',
    '%%EOF',
  ].join('\n'));
  assert.equal(byColor.shapes[0].layer, 'fold', 'цвет слоя сгиба определён');
  assert.equal(byColor.shapes[1].layer, 'cut', 'чёрная сплошная линия — основной контур');

  const byDash = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0', '%%BoundingBox: 0 0 100 100', '%%EndComments',
    '[8 4] 0 setdash newpath 0 0 moveto 100 0 lineto stroke',
    '%%EOF',
  ].join('\n'));
  assert.equal(byDash.shapes[0].layer, 'fold', 'пунктир без метки слоя — линия сгиба');

  // дуги и скругления
  const arcs = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0', '%%BoundingBox: 0 0 200 200', '%%EndComments',
    'newpath 100 100 50 0 360 arc stroke',
    '%%EOF',
  ].join('\n'));
  assert.equal(arcs.shapes.length, 1, 'arc построен');
  const cbb = selectionBBox(arcs.shapes)!;
  assert.ok(near(cbb[0], (100 - 50) * MM_PER_PT, 1e-6), 'дуга: левая граница');
  assert.ok(near(cbb[3], (100 + 50) * MM_PER_PT, 1e-6), 'дуга: верхняя граница');
  const nodes = (arcs.shapes[0] as { nodes: { cp1x?: number }[] }).nodes;
  assert.ok(nodes.some((nd) => nd.cp1x !== undefined), 'дуга пришла кубиками, не полилинией');

  // текст без кривых и клип — в примечания
  const textish = parsePostScript([
    '%!PS-Adobe-3.0 EPSF-3.0', '%%BoundingBox: 0 0 100 100', '%%EndComments',
    '/Helvetica findfont 12 scalefont setfont 10 10 moveto (Привет) show',
    'newpath 0 0 moveto 100 0 lineto 100 100 lineto clip newpath',
    'newpath 5 5 moveto 20 5 lineto stroke',
    '%%EOF',
  ].join('\n'));
  assert.ok(textish.notes.some((n) => /Текст/.test(n)), 'текст отмечен подсказкой про кривые');
  assert.ok(textish.notes.some((n) => /обрезки/.test(n)), 'клип отмечен');
  assert.equal(textish.shapes.length, 1, 'геометрия под клипом импортирована');

  // многостраничный PS: берём первую страницу
  const multi = parsePostScript([
    '%!PS-Adobe-3.0', '%%Pages: 2', '%%BoundingBox: 0 0 100 100', '%%EndComments',
    '%%Page: 1 1', 'newpath 0 0 moveto 10 0 lineto stroke', 'showpage',
    '%%Page: 2 2', 'newpath 0 0 moveto 90 0 lineto stroke', 'showpage',
    '%%EOF',
  ].join('\n'));
  assert.equal(multi.shapes.length, 1, 'вторая страница не импортирована');
  assert.ok(near(selectionBBox(multi.shapes)![2], 10 * MM_PER_PT, 1e-6), 'геометрия первой страницы');

  // пустой и мусорный вход
  assert.equal(parsePostScript('').shapes.length, 0, 'пустой файл не роняет парсер');
  assert.ok(parsePostScript('%!PS-Adobe-3.0\n%%EOF\n').notes.length > 0, 'про пустой EPS есть примечание');
  const junkPs = parsePostScript('%!PS-Adobe-3.0\n' + 'гарbage '.repeat(500) + '\n%%EOF\n');
  assert.equal(junkPs.shapes.length, 0, 'мусор без операторов не даёт фигур');
}

// ---------------- PLT: экспорт ----------------
{
  const doc = sampleDoc();
  const plt = exportVectorPlt(doc);
  assert.ok(plt.startsWith('IN;\nPA;'), 'инициализация и абсолютные координаты');
  assert.ok(plt.trimEnd().endsWith('SP0;'), 'перо снято в конце');
  for (const bad of ['SC', 'PW', 'PS;', 'RO']) {
    assert.ok(!new RegExp(`(^|\\n)${bad}`).test(plt), `нет команды ${bad} — единицы трактуются однозначно`);
  }

  // 1 мм = 40 юнитов: панель 20..140 мм по X
  assert.ok(plt.includes(`PU${20 * HPGL_UNITS_PER_MM},${20 * HPGL_UNITS_PER_MM};`),
    'начало контура в юнитах HPGL (40/мм)');
  assert.ok(plt.includes(`${140 * HPGL_UNITS_PER_MM},${100 * HPGL_UNITS_PER_MM}`),
    'правый верхний угол панели');
  // замкнутый контур возвращается в начало
  const cutBlock = plt.slice(plt.indexOf(`SP${PLT_PENS.cut};`));
  assert.ok(cutBlock.includes(`${20 * HPGL_UNITS_PER_MM},${20 * HPGL_UNITS_PER_MM};`),
    'замкнутый контур возвращает перо в начало');

  // перья по слоям
  for (const [layer, pen] of Object.entries(PLT_PENS) as [string, number][]) {
    const has = plt.includes(`SP${pen};`);
    const need = layer !== 'guide' && layer !== 'score';
    assert.equal(has, need, `перо ${pen} для слоя ${layer}`);
  }
  assert.ok(plt.indexOf(`SP${PLT_PENS.engrave};`) < plt.indexOf(`SP${PLT_PENS.cut};`),
    'порядок перьев соответствует LASER_LAYER_ORDER');

  // пунктир биговки — настоящие пропуски пера
  const foldBlock = plt.slice(plt.indexOf(`SP${PLT_PENS.fold};`), plt.indexOf(`SP${PLT_PENS.inner};`));
  const dashes = (foldBlock.match(/PU/g) ?? []).length;
  assert.equal(dashes, 20, 'сгиб 120 мм штрихом 4/2 мм = 20 прогонов пера');

  // всё в одно перо по опции
  const one = exportVectorPlt(doc, { pltPensPerLayer: false });
  assert.equal((one.match(/SP\d+;/g) ?? []).filter((s) => s !== 'SP0;').every((s) => s === 'SP1;'), true,
    'pltPensPerLayer:false ведёт всё первым пером');

  // служебный слой и скрытые объекты
  assert.ok(!plt.includes(`SP${PLT_PENS.guide};`), 'служебный слой не выводится по умолчанию');
  assert.ok(exportVectorPlt(doc, { includeGuide: true }).includes(`SP${PLT_PENS.guide};`),
    'includeGuide добавляет служебный слой');
  assert.ok(!plt.includes(`${200 * HPGL_UNITS_PER_MM},`), 'скрытый объект не выводится');
}

// ---------------- PLT: круговой обмен ----------------
{
  const doc = sampleDoc();
  const back = parsePlt(exportVectorPlt(doc));
  assert.equal(back.kind, 'plt', 'формат определён');
  const srcBb = selectionBBox(exportedShapes(doc))!;
  const gotBb = selectionBBox(back.shapes)!;
  srcBb.forEach((v, i) => assert.ok(near(v, gotBb[i], 0.03),
    `габарит PLT совпадает с точностью юнита (${i}): ${srcBb} vs ${gotBb}`));
  // пунктир биговки в HPGL рисуется настоящими пропусками пера, поэтому
  // длина файла = длина чертежа без пропусков: штрих 4 мм из 6 мм периода
  const src = exportedShapes(doc);
  const srcLen = totalLength(src);
  const foldLen = totalLength(src.filter((sh) => sh.layer === 'fold'));
  const gap = doc.layers.fold.gapLen / (doc.layers.fold.dashLen + doc.layers.fold.gapLen);
  const wantLen = srcLen - foldLen * gap;
  const gotLen = totalLength(back.shapes);
  assert.ok(Math.abs(wantLen - gotLen) / wantLen < 0.02,
    `длина контуров PLT: ${gotLen.toFixed(3)} против ${wantLen.toFixed(3)} мм (без пропусков пунктира)`);
  assert.deepEqual([...new Set(back.shapes.map((s) => s.layer))].sort(), ['cut', 'engrave', 'fold', 'inner'],
    'перья вернули объекты на слои');
  assert.ok(back.shapes.some((s) => s.layer === 'cut' && s.closed), 'панель замкнута');
  assert.ok(back.shapes.filter((s) => s.layer === 'fold').length >= 20, 'пунктир биговки — отдельные штрихи');
}

// ---------------- PLT: чужие файлы ----------------
{
  // базовый HPGL: перо, полилинии, окружность, дуга, прямоугольник
  const basic = parsePlt([
    'IN;',
    'SP1;',
    'PU400,400;PD800,400;PD800,800;PD400,800;PD400,400;',   // квадрат 10×10 мм в 20..40 мм
    'SP2;',
    'CI600,600,200;',                                          // окружность r=5 мм
    'AA1000,1000,400,0,90;',                                   // дуга 90°
    'SP1;',
    'PU1600,800;',                                             // текущая точка (40, 20) мм
    'RA2000,1200;',                                            // прямоугольник до (50, 30) мм
    'SP0;',
  ].join('\n'));
  assert.ok(basic.shapes.length >= 4, `фигуры HPGL: ${basic.shapes.length}`);
  const square = basic.shapes.find((s) => s.name === 'PLT Полилиния')!;
  const sq = selectionBBox([square])!;
  assert.ok(near(sq[0], 10, 1e-6) && near(sq[2], 20, 1e-6), '400 юнитов = 10 мм');
  assert.equal(square.layer, 'cut', 'перо 1 — внешний контур');
  assert.equal(square.closed, true, 'контур замкнут в исходную точку');

  const circle = basic.shapes.find((s) => s.kind === 'ellipse' && s.name === 'PLT Окружность')!;
  assert.equal(circle.layer, 'inner', 'перо 2 — внутренний слой');
  if (circle.kind === 'ellipse') {
    assert.ok(near(circle.cx, 15, 1e-6) && near(circle.cy, 15, 1e-6), 'центр окружности в мм');
    assert.ok(near(circle.rx, 5, 1e-6), '200 юнитов = 5 мм');
    assert.equal(circle.endAngle - circle.startAngle, 360, 'окружность целиком');
  }

  const arc = basic.shapes.find((s) => s.name === 'PLT Полилиния' && s.layer === 'inner')!;
  const abb = selectionBBox([arc])!;
  // AA1000,1000,400,0,90 — центр (25, 25) мм, радиус 10 мм, от 0° до 90°
  assert.ok(near(abb[0], 25, 0.02) && near(abb[1], 25, 0.02), 'дуга AA: центр и начало');
  assert.ok(near(abb[2], 35, 0.02) && near(abb[3], 35, 0.02), 'дуга AA: габарит четверти круга 10 мм');

  const rect = basic.shapes.find((s) => s.kind === 'rect')!;
  assert.ok(rect, 'RA дал прямоугольник');
  if (rect.kind === 'rect') {
    assert.ok(near(rect.x, 40, 1e-6) && near(rect.y, 20, 1e-6), 'RA: нижний левый угол в мм');
    assert.ok(near(rect.x + rect.w, 50, 1e-6) && near(rect.y + rect.h, 30, 1e-6),
      'RA: противоположный угол (2000, 1200) юнитов = (50, 30) мм');
    assert.equal(rect.layer, 'cut', 'прямоугольник на слое текущего пера');
  }

  // относительные координаты PR
  const rel = parsePlt('IN;SP1;PU400,400;PD400,400;PR400,0;PR0,400;PR-400,0;PR0,-400;SP0;');
  const rbb = selectionBBox(rel.shapes)!;
  assert.ok(near(rbb[0], 10, 1e-6) && near(rbb[2], 20, 1e-6), 'PR рисует относительными парами');
  assert.equal(rel.shapes[0].closed, true, 'относительный контур замкнулся');

  // единицы IU (1016 на дюйм = 40 на мм) и масштаб SC с окном IP
  const iu = parsePlt('IN;IU1016,1016;SP1;PU0,0;PD1016,0;SP0;');
  assert.ok(near(selectionBBox(iu.shapes)![2], 25.4, 1e-6), 'IU: 1016 юнитов = 1 дюйм = 25.4 мм');

  const sc = parsePlt('IN;IP0,0,4000,4000;SC0,100,0,100;SP1;PU0,0;PD100,0;PD100,100;SP0;');
  const scbb = selectionBBox(sc.shapes)!;
  assert.ok(near(scbb[2], 100, 1e-6), 'SC+IP: пользовательские единицы растянуты на окно плоттера (100 мм)');
  assert.ok(near(scbb[3], 100, 1e-6), 'SC+IP: высота тоже масштабирована');
  assert.equal(sc.notes.length, 0, 'SC вместе с IP не даёт предупреждений');

  const scNoIp = parsePlt('IN;SC0,100,0,100;SP1;PU0,0;PD400,0;SP0;');
  assert.ok(scNoIp.notes.some((n) => /SC/.test(n)), 'SC без IP отмечен примечанием');

  // подписи LB не ломают числовые параметры
  const labeled = parsePlt('IN;SP1;LBРазмер 20 мм\x03PU0,0;PD400,0;SP0;');
  assert.equal(labeled.shapes.length, 1, 'подпись HPGL пропущена, геометрия прочитана');
  assert.ok(near(selectionBBox(labeled.shapes)![2], 10, 1e-6), 'координаты после подписи верные');

  // неизвестные команды считаются, а не роняют разбор
  const unknown = parsePlt('IN;ZZ1,2;SP1;PU0,0;PD400,0;QQ;SP0;');
  assert.equal(unknown.shapes.length, 1, 'неизвестные команды пропущены');
  assert.ok(unknown.notes.some((n) => /ZZ/.test(n) && /QQ/.test(n)), 'неизвестные команды перечислены');

  // команды без точек и пустой файл
  assert.equal(parsePlt('').shapes.length, 0, 'пустой PLT');
  assert.ok(parsePlt('IN;SP1;SP0;').notes.length > 0, 'про пустой PLT есть примечание');
  assert.equal(tokenizePlt('IN;PU1,2;PD3,4;').length, 3, 'токенайзер HPGL разбирает команды');
  assert.deepEqual(tokenizePlt('PD3,4;')[0].nums, [3, 4], 'параметры команды');
}

// ---------------- один чертёж в четырёх форматах ----------------
{
  const doc = sampleDoc();
  const modelLen = totalLength(exportedShapes(doc));
  const pdfLen = totalLength((await parsePdfVector(enc.encode(exportVectorPdf(doc)))).shapes);
  const epsLen = totalLength(parsePostScript(exportVectorEps(doc)).shapes);
  const pltLen = totalLength(parsePlt(exportVectorPlt(doc)).shapes);

  // PDF и EPS несут пунктир свойством линии, поэтому длина совпадает с моделью
  for (const [name, len] of [['PDF', pdfLen], ['EPS', epsLen]] as [string, number][]) {
    assert.ok(Math.abs(len - modelLen) / modelLen < 0.01,
      `${name}: длина контуров ${len.toFixed(3)} мм против ${modelLen.toFixed(3)} мм в модели`);
  }

  // DXF (пунктир штрихами) и PLT (пропуски пера) совпадают между собой
  const dxfLen = totalLength(dxfRoundTripShapes(doc));
  assert.ok(Math.abs(pltLen - dxfLen) / dxfLen < 0.01,
    `PLT и DXF рисуют пунктир штрихами одинаково: ${pltLen.toFixed(3)} против ${dxfLen.toFixed(3)} мм`);
  assert.ok(pltLen < modelLen, 'штриховой пунктир короче сплошной линии модели');

  // габарит один во всех форматах — масштаб везде 1:1 мм
  const modelBb = selectionBBox(exportedShapes(doc))!;
  const dxfBb = selectionBBox(dxfRoundTripShapes(doc))!;
  for (const [name, bb] of [['PDF', selectionBBox((await parsePdfVector(enc.encode(exportVectorPdf(doc)))).shapes)!],
    ['EPS', selectionBBox(parsePostScript(exportVectorEps(doc)).shapes)!],
    ['PLT', selectionBBox(parsePlt(exportVectorPlt(doc)).shapes)!],
    ['DXF', dxfBb]] as [string, number[]][]) {
    modelBb.forEach((v, i) => assert.ok(near(v, bb[i], 0.05), `${name}: габарит ${bb} против ${modelBb}`));
  }

  const dxf = exportLaserDxf(doc);
  assert.ok(dxf.includes('SECTION') && dxf.includes('CUT'), 'DXF по-прежнему экспортируется');
}

// ---------------- определение формата и диспетчер ----------------
{
  assert.equal(sniffCorelFormat('a.pdf', '%PDF-1.7\n'), 'pdf', 'сигнатура PDF важнее имени');
  assert.equal(sniffCorelFormat('a.ai', '%PDF-1.6\n'), 'pdf', 'свежий AI — это PDF');
  assert.equal(sniffCorelFormat('a.ai', '%!PS-Adobe-3.0 EPSF-3.0'), 'ps', 'старый AI — это EPS');
  assert.equal(sniffCorelFormat('a.eps', '%!PS-Adobe-3.0'), 'ps', 'EPS');
  assert.equal(sniffCorelFormat('a.cdr', 'мусор'), 'cdr', '.cdr по расширению');
  assert.equal(sniffCorelFormat('без-расширения', 'RIFF\x00\x00\x00\x00CDRXvrsn'), 'cdr', 'RIFF/CDR по сигнатуре');
  assert.equal(sniffCorelFormat('a.plt', 'IN;SP1;'), 'plt', 'PLT');
  assert.equal(sniffCorelFormat('без-расширения', 'IN;SP1;PU0,0;PD10,10;'), 'plt', 'HPGL без расширения');
  assert.equal(sniffCorelFormat('a.svg', '<svg xmlns="x">'), 'svg', 'SVG');
  assert.equal(sniffCorelFormat('a.dxf', '0\nSECTION\n'), 'dxf', 'DXF');
  assert.equal(sniffCorelFormat('a.pslaser', '{"psbees'), 'project', 'старый проект');
  assert.equal(sniffCorelFormat('a.psdraw', '{"psbees'), 'project', 'проект чертежа');
  assert.equal(sniffCorelFormat('a.bin', new Uint8Array([1, 2, 3, 4])), 'unknown', 'неизвестные байты');

  // .cdr: понятная подсказка, а не молчаливая ошибка
  await assert.rejects(
    () => importVectorData('коробка.cdr', enc.encode('RIFF....CDRXvrsn')),
    (e: Error) => e.message === CDR_MESSAGE && /PDF/.test(e.message) && /закрытый/i.test(e.message),
    '.cdr объясняет, в какие форматы пересохранить',
  );
  await assert.rejects(
    () => importVectorData('что-то.bin', enc.encode('случайные байты')),
    (e: Error) => /не распознан/i.test(e.message) && /PLT/.test(e.message),
    'неизвестный формат перечисляет поддерживаемые',
  );

  // делегирование в существующие парсеры SVG и DXF
  const svg = await importVectorData('лист.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50">'
    + '<g id="layer-cut"><path d="M10 10 L90 10 L90 40 Z" stroke="#f00" fill="none"/></g></svg>', 50);
  assert.equal(svg.kind, 'svg', 'SVG определён');
  assert.ok(svg.shapes.length >= 1, 'SVG импортирован существующим парсером');

  const dxfText = exportLaserDxf(sampleDoc());
  const dxfBack = await importVectorData('чертёж.dxf', dxfText, 200);
  assert.equal(dxfBack.kind, 'dxf', 'DXF определён');
  assert.ok(dxfBack.shapes.length >= 4, 'DXF импортирован');

  // PDF и EPS через единый вход
  const doc = sampleDoc();
  const viaPdf = await importVectorData('чертёж.pdf', exportVectorPdf(doc), 200);
  assert.equal(viaPdf.kind, 'pdf', 'диспетчер отправил PDF в PDF-парсер');
  assert.ok(viaPdf.shapes.length >= 4, 'PDF через диспетчер');
  const viaEps = await importVectorData('чертёж.eps', exportVectorEps(doc), 200);
  assert.equal(viaEps.kind, 'ps', 'диспетчер отправил EPS в PostScript-парсер');
  assert.ok(viaEps.shapes.length >= 4, 'EPS через диспетчер');
  const viaPlt = await importVectorData('чертёж.plt', exportVectorPlt(doc), 200);
  assert.equal(viaPlt.kind, 'plt', 'диспетчер отправил PLT в HPGL-парсер');
  assert.ok(viaPlt.shapes.length >= 4, 'PLT через диспетчер');
  const viaBytes = await importVectorData('чертёж.pdf', enc.encode(exportVectorPdf(doc)).buffer, 200);
  assert.ok(viaBytes.shapes.length >= 4, 'ArrayBuffer тоже принимается');

  // имена слоёв из чужих файлов
  assert.equal(layerByName('CUT'), 'cut', 'имя слоя DXF');
  assert.equal(layerByName('fold'), 'fold', 'регистр не важен');
  assert.equal(layerByName('Линия сгиба'), 'fold', 'русское имя сгиба');
  assert.equal(layerByName('Размеры'), 'guide', 'русское имя служебного слоя');
  assert.equal(layerByName('Слой 1'), null, 'неизвестное имя не угадывается');
}

console.log('COREL OK');
