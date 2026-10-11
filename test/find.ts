// Поиск по плате: обозначения, номиналы, цепи и подсветка их меди.
import assert from 'node:assert/strict';
import { findOnBoard, queryTerms } from '../src/pcb/find';
import type { Comp, Doc, Entity } from '../src/pcb/model';

const comp = (id: string, name: string, x: number, y: number, ents: Entity[] = [], side: 'top' | 'bottom' = 'top'): Comp => ({
  kind: 'comp', id, lib: '', name, x, y, rot: 0, side, bl: [-2, -2, 2, 2], ents,
});
const label = (id: string, text: string, x: number, y: number): Entity => ({
  kind: 'text', id, x, y, size: 1, th: 0.15, rot: 0, text, mirror: false, layer: 's1',
});
const pad = (id: string, x: number, y: number): Entity => ({ kind: 'pad', id, x, y, shape: 'round', size: 1.6, drill: 0.8 });

const doc: Doc = {
  name: 'Поиск', w: 100, h: 80, entities: [
    comp('R1', 'Резистор 0805 10k', 20, 20, [
      pad('R1p1', 0, -1), pad('R1p2', 0, 1), label('R1lbl', 'R1', 0, 2.5),
    ]),
    comp('C7', 'Конденсатор 0603 100n', 40, 20, [pad('C7p1', -1, 0), pad('C7p2', 1, 0)]),
    comp('U2', 'Микросхема SOIC-8', 60, 40, [pad('U2p1', -2, 0), pad('U2p2', 2, 0)], 'bottom'),
    label('boardText', 'Версия 2.1', 80, 10),
    // GND: две площадки, соединённые дорожкой
    { kind: 'track', id: 'gndTr', layer: 'k1', w: 0.3, pts: [{ x: 20, y: 19 }, { x: 39, y: 19 }, { x: 39, y: 20 }] },
    { kind: 'track', id: 'vccTr', layer: 'k1', w: 0.3, pts: [{ x: 58, y: 40 }, { x: 62, y: 40 }] },
  ],
  nets: [
    { id: 'n-gnd', name: 'GND', pads: ['R1:0', 'C7:0'] },  // id развёрнутых примитивов: «деталь:индекс»
    { id: 'n-vcc', name: 'VCC_3V3', pads: ['U2:0', 'U2:1'] },
  ],
};

// ------------------------------------------------- пустой и пробельный запрос
assert.deepEqual(findOnBoard(doc, ''), []);
assert.deepEqual(findOnBoard(doc, '   '), []);
assert.deepEqual(queryTerms('  R1   10K '), ['r1', '10k']);

// -------------------------------------------------------------- обозначения
{
  const hits = findOnBoard(doc, 'R1');
  const r = hits.find((h) => h.kind === 'text' && h.title === 'R1');
  assert.ok(r, 'надпись «R1» внутри детали найдена');
  assert.equal(r!.topId, 'R1', 'надпись ведёт к своей детали');
  assert.ok(Math.abs(r!.x - 20) < 1 && Math.abs(r!.y - 22.5) < 0.8, `центр надписи рядом с деталью: ${r!.x};${r!.y}`);
  assert.equal(hits[0].title, 'R1', 'точное совпадение — первым');
}

// ---------------------------------------------------------- номиналы и имена
{
  const hits = findOnBoard(doc, '10k');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, 'comp', 'номинал в имени детали');
  assert.equal(hits[0].topId, 'R1');
  assert.equal(hits[0].detail, 'деталь · верх');
  const bottom = findOnBoard(doc, 'soic');
  assert.equal(bottom[0].topId, 'U2');
  assert.equal(bottom[0].detail, 'деталь · низ', 'нижняя сторона — отмечена');
  assert.equal(findOnBoard(doc, 'микросхема')[0].topId, 'U2');
}

// ----------------------------------------------------- несколько слов и регистр
{
  assert.equal(findOnBoard(doc, 'конденсатор 100N')[0].topId, 'C7', 'все слова должны совпасть, регистр не важен');
  assert.equal(findOnBoard(doc, 'конденсатор 10k').length, 0, 'если одного слова нет — деталь не найдена');
  assert.equal(findOnBoard(doc, 'gnd')[0].title, 'GND', 'цепь — без учёта регистра');
  assert.equal(findOnBoard(doc, 'версия 2.1')[0].title, 'Версия 2.1', 'текст платы');
}

// ----------------------------------------------------------- цепи и их медь
{
  const gnd = findOnBoard(doc, 'GND').find((h) => h.kind === 'net');
  assert.ok(gnd, 'цепь GND найдена');
  assert.match(gnd!.detail, /цепь · 2 площадки/);
  assert.ok(gnd!.ids.includes('gndTr'), 'подсветка включает дорожку цепи');
  assert.ok(gnd!.ids.includes('R1:0') && gnd!.ids.includes('C7:0'), 'и её площадки');
  assert.ok(!gnd!.ids.includes('vccTr'), 'чужая дорожка не подсвечивается');
  assert.ok(gnd!.box[0] <= 19.2 + 1e-6 && gnd!.box[2] >= 39.8 - 1e-6, 'габарит цепи охватывает её медь');

  const vcc = findOnBoard(doc, 'vcc').find((h) => h.kind === 'net');
  assert.ok(vcc && vcc.ids.includes('vccTr') && !vcc.ids.includes('gndTr'), 'VCC — только своя медь');
}

// ------------------------------------------------- ограничение и порядок
{
  // точное совпадение, затем «начинается с», затем вхождение
  const ordered: Doc = { ...doc, nets: [
    { id: 'x', name: 'XLED', pads: [] },
    { id: 'o', name: 'LEDON', pads: [] },
    { id: 'e', name: 'LED', pads: [] },
  ] };
  assert.deepEqual(findOnBoard(ordered, 'led').map((h) => h.title), ['LED', 'LEDON', 'XLED'], 'порядок по близости к запросу');
  assert.equal(findOnBoard(doc, 'c', 1).length, 1, 'лимит результатов');
  assert.ok(findOnBoard(doc, 'c').length > 1);
  assert.deepEqual(findOnBoard(doc, 'нет-такого-слова'), [], 'пустой результат');
}

// ---------------------------------------------- документ не меняется
{
  const before = JSON.stringify(doc);
  findOnBoard(doc, 'GND 10k R1');
  assert.equal(JSON.stringify(doc), before, 'поиск не меняет плату');
}

// подсветка детали — все её примитивы, а не сама запись компонента
{
  const r = findOnBoard(doc, '10k').find((h) => h.kind === 'comp');
  assert.ok(r && r.ids.includes('R1:0') && r.ids.includes('R1:1') && r.ids.includes('R1:2'), 'подсвечиваются все примитивы детали');
  assert.ok(!r!.ids.includes('R1'), 'сама запись компонента не в списке подсветки');
}

console.log('find: обозначения, номиналы, цепи с медью, регистр, порядок OK');
