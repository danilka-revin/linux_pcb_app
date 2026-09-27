// Группировка элементов: создание/роспуск групп, расширение выделения,
// чистка ссылок на удалённые элементы, копии групп (дублирование, вставка,
// панелизация) и сохранение групп в проекте.
import assert from 'node:assert/strict';
import * as M from '../src/pcb/model';
import * as Gr from '../src/pcb/group';

/** Плата с пятью элементами: две группы площадок, дорожка, переход и текст. */
function board(): M.Doc {
  const d = M.newBoard(60, 40, 'Группы');
  d.entities.push(
    { id: 'p1', kind: 'pad', x: 10, y: 10, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p2', kind: 'pad', x: 15, y: 10, shape: 'round', size: 1.9, drill: 0.9 },
    { id: 'p3', kind: 'pad', x: 30, y: 25, shape: 'square', size: 1.9, drill: 0.9 },
    { id: 'p4', kind: 'pad', x: 35, y: 25, shape: 'square', size: 1.9, drill: 0.9 },
    { id: 'p5', kind: 'pad', x: 40, y: 25, shape: 'square', size: 1.9, drill: 0.9 },
    { id: 't1', kind: 'track', pts: [{ x: 10, y: 10 }, { x: 30, y: 25 }], w: 0.6, layer: 'k1' },
    { id: 'v1', kind: 'via', x: 20, y: 20, size: 1.8, drill: 0.8 },
  );
  return d;
}

// ---------------------------------------------------------------- создание группы
const d0 = board();
const g1 = Gr.groupSelection(d0, ['p1', 'p2']);
assert(g1, 'два элемента группируются');
assert.equal(g1!.group.name, 'Группа 1', 'первая группа получает имя «Группа 1»');
assert.deepEqual(g1!.group.ids, ['p1', 'p2'], 'в группе только выделенное, в порядке платы');
assert.equal(g1!.merged, 0, 'старых групп не было');
assert.equal(g1!.doc.groups?.length, 1, 'группа записана в документ');
assert.equal(g1!.doc.entities.length, d0.entities.length, 'элементы не изменились');
assert.equal(d0.groups, undefined, 'исходный документ не мутируется');

// порядок элементов в группе — как на плате, а не как в выделении
const g1rev = Gr.groupSelection(d0, ['p2', 'p1']);
assert.deepEqual(g1rev!.group.ids, ['p1', 'p2'], 'порядок в группе — порядок платы');

// группировать нечего
assert.equal(Gr.groupSelection(d0, ['p1']), null, 'один элемент — не группа');
assert.equal(Gr.groupSelection(d0, []), null, 'пустое выделение — не группа');
assert.equal(Gr.groupSelection(d0, ['p1', 'нет-такого']), null, 'несуществующий элемент отбрасывается');

// своё имя
const named = Gr.groupSelection(d0, ['p3', 'p4', 'p5'], '  Блок питания  ');
assert.equal(named!.group.name, 'Блок питания', 'своё имя принимается, пробелы обрезаются');
assert.equal(Gr.groupSelection(d0, ['p3', 'p4'], '   ')!.group.name, 'Группа 1', 'пустое имя → автоимя');

// ---------------------------------------------------------------- вторая группа и имена
const two = Gr.groupSelection(named!.doc, ['p1', 'p2', 't1']);
// занято только «Блок питания», поэтому следующая свободная — «Группа 1»
assert.equal(two!.group.name, 'Группа 1', 'имя группы не пересекается с занятыми');
assert.deepEqual(two!.group.ids, ['p1', 'p2', 't1'], 'дорожка тоже входит в группу');
assert.equal(two!.doc.groups?.length, 2, 'две группы сосуществуют');
assert.equal(Gr.nextGroupName(two!.doc.groups), 'Группа 2', 'свободное имя ищется по занятым');
assert.equal(
  Gr.nextGroupName([{ id: 'a', name: 'Группа 1', ids: ['p1', 'p2'] }, { id: 'b', name: 'Группа 2', ids: ['p3', 'p4'] }]),
  'Группа 3', 'имена без дырок',
);

// ---------------------------------------------------------------- выделение целиком
const docA = two!.doc;
assert.deepEqual([...Gr.expandSelection(docA.groups, ['p1'])].sort(), ['p1', 'p2', 't1'],
  'клик по элементу выбирает всю группу');
assert.deepEqual([...Gr.expandSelection(docA.groups, ['v1'])], ['v1'], 'элемент вне группы выбирается один');
assert.deepEqual([...Gr.expandSelection(docA.groups, ['p1', 'p3'])].sort(), ['p1', 'p2', 'p3', 'p4', 'p5', 't1'],
  'рамка, задевшая две группы, выбирает обе целиком');
assert.deepEqual([...Gr.expandSelection(undefined, ['p1'])], ['p1'], 'без групп расширение ничего не меняет');
assert.equal(Gr.groupOf(docA.groups, 't1')?.id, two!.group.id, 'groupOf находит группу по элементу');
assert.equal(Gr.groupOf(docA.groups, 'v1'), undefined, 'groupOf: нет группы — undefined');
// 3 элемента «Блок питания» + 3 элемента «Группа 1»
assert.equal(Gr.groupIndex(docA.groups).size, 6, 'индекс покрывает все элементы групп');

// ---------------------------------------------------------------- объединение групп
// группы не пересекаются: новая группировка втягивает прежние целиком
const mergedDoc = Gr.groupSelection(docA, ['p1', 'p3']);
assert(mergedDoc, 'перегруппировка возможна');
assert.equal(mergedDoc!.merged, 2, 'обе прежние группы растворились в новой');
assert.equal(mergedDoc!.doc.groups?.length, 1, 'осталась одна группа');
assert.deepEqual(mergedDoc!.group.ids, ['p1', 'p2', 'p3', 'p4', 'p5', 't1'],
  'новая группа собрала элементы обеих прежних');
assert.equal(mergedDoc!.group.name, 'Группа 1', 'после слияния имя выдаётся заново');

// повторная группировка той же группы целиком сохраняет её имя и id
const again = Gr.groupSelection(docA, ['p3', 'p4', 'p5']);
assert.equal(again!.group.name, 'Блок питания', 'имя группы сохраняется');
assert.equal(again!.group.id, named!.group.id, 'id группы сохраняется');
assert.equal(again!.merged, 1, 'одна прежняя группа поглощена');

// ---------------------------------------------------------------- габарит группы
{
  const g = docA.groups![1];
  const b = Gr.groupBBox(docA, g)!;
  const manual = M.unionBBox(docA.entities.filter((e) => g.ids.includes(e.id)).map(M.entBBox));
  assert.deepEqual(b, manual, 'габарит группы = объединение габаритов элементов');
  // перенос всех элементов группы двигает и её габарит
  const moved = M.cloneDoc(docA);
  moved.entities.forEach((e) => { if (g.ids.includes(e.id)) M.translateEnt(e, 5, -3); });
  const b2 = Gr.groupBBox(moved, moved.groups![1])!;
  assert.ok(Math.abs(b2[0] - (b[0] + 5)) < 1e-9 && Math.abs(b2[1] - (b[1] - 3)) < 1e-9,
    'группа переехала вместе с элементами');
  // поворот вокруг центра группы не теряет элементы
  const rot = M.cloneDoc(docA);
  const c = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  rot.entities.forEach((e) => { if (g.ids.includes(e.id)) M.rotateEnt90(e, c[0], c[1]); });
  assert.deepEqual(rot.groups, docA.groups, 'поворот не меняет состав группы');
  assert.ok(Gr.groupBBox(rot, rot.groups![1]) !== null, 'габарит после поворота считается');
}

// ---------------------------------------------------------------- разгруппировка
{
  const one = Gr.ungroupSelection(docA, ['p2']);
  assert(one, 'разгруппировка по одному элементу группы');
  assert.deepEqual(one!.names, ['Группа 1'], 'распущена именно группа выделенного');
  assert.equal(one!.doc.groups?.length, 1, 'вторая группа не тронута');
  assert.equal(one!.doc.entities.length, docA.entities.length, 'элементы остались на плате');

  const both = Gr.ungroupSelection(docA, ['p1', 'p4']);
  assert.equal(both!.doc.groups?.length, 0, 'выделение в двух группах распускает обе');
  assert.deepEqual(both!.names, ['Блок питания', 'Группа 1'], 'имена распущенных групп');

  assert.equal(Gr.ungroupSelection(docA, ['v1']), null, 'выделение вне групп — нечего распускать');
  assert.equal(Gr.ungroupSelection(docA, []), null, 'пустое выделение — нечего распускать');

  const all = Gr.ungroupAll(docA);
  assert.equal(all!.doc.groups?.length, 0, 'разгруппировать всё');
  assert.equal(all!.names.length, 2, 'сообщаем о двух группах');
  assert.equal(Gr.ungroupAll(M.newBoard(10, 10)), null, 'на пустой плате групп нет');
}

// ---------------------------------------------------------------- переименование
{
  const r = Gr.renameGroup(docA, named!.group.id, '  Питание 5В ');
  assert.equal(r!.groups!.find((g) => g.id === named!.group.id)!.name, 'Питание 5В', 'имя обновлено');
  assert.equal(Gr.renameGroup(docA, named!.group.id, '   '), null, 'пустое имя игнорируется');
  assert.equal(Gr.renameGroup(docA, 'нет-такой', 'Имя'), null, 'неизвестная группа — null');
  assert.equal(docA.groups!.find((g) => g.id === named!.group.id)!.name, 'Блок питания', 'исходник не мутируется');
}

// ---------------------------------------------------------------- удаление элементов
{
  // из группы из трёх элементов удалили один — группа осталась
  const three = Gr.groupSelection(d0, ['p3', 'p4', 'p5'])!.doc;
  const kept = Gr.pruneGroups(three.groups, new Set(['p3', 'p4', 't1', 'v1']));
  assert.equal(kept.length, 1, 'группа из двух оставшихся живёт');
  assert.deepEqual(kept[0].ids, ['p3', 'p4'], 'ссылка на удалённый элемент вычищена');

  // из группы из двух удалили один — группы больше нет
  const pair = Gr.groupSelection(d0, ['p1', 'p2'])!.doc;
  assert.deepEqual(Gr.pruneGroups(pair.groups, new Set(['p1', 'p3'])), [], 'группа из одного элемента распускается');
  assert.deepEqual(Gr.pruneGroups(undefined, new Set(['p1'])), [], 'без групп — пустой список');
  // чистка убирает повторы id
  const dup = Gr.pruneGroups([{ id: 'g', name: 'Г', ids: ['p1', 'p1', 'p2'] }], new Set(['p1', 'p2']));
  assert.deepEqual(dup[0].ids, ['p1', 'p2'], 'дубликаты id схлопываются');
}

// ---------------------------------------------------------------- копии групп
{
  // дублирование: карта «старый id → новый», имя с пометкой копии
  const src = Gr.groupSelection(d0, ['p1', 'p2'])!.doc;
  const map = new Map([['p1', 'n1'], ['p2', 'n2'], ['p3', 'n3']]);
  const copies = Gr.remapGroups(src.groups, map, ' (копия)');
  assert.equal(copies.length, 1, 'копия группы создана');
  assert.deepEqual(copies[0].ids, ['n1', 'n2'], 'id заменены на новые');
  assert.equal(copies[0].name, 'Группа 1 (копия)', 'копия помечена');
  assert.notEqual(copies[0].id, src.groups![0].id, 'у копии свой id группы');
  // группа, попавшая в копию не целиком, не переносится
  const partial = Gr.remapGroups(src.groups, new Map([['p1', 'n1']]));
  assert.deepEqual(partial, [], 'частичная копия группы не создаётся');
  assert.deepEqual(Gr.remapGroups(undefined, map), [], 'без групп — нечего копировать');

  // вставка/панелизация: две копии одной платы дают две независимые группы
  const a = Gr.remapGroups(src.groups, new Map([['p1', 'a1'], ['p2', 'a2']]));
  const b = Gr.remapGroups(src.groups, new Map([['p1', 'b1'], ['p2', 'b2']]), ' · ячейка 2');
  const joined = [...src.groups!, ...a, ...b];
  assert.equal(joined.length, 3, 'три группы');
  assert.equal(new Set(joined.map((g) => g.id)).size, 3, 'id групп не пересекаются');
  assert.equal(b[0].name, 'Группа 1 · ячейка 2', 'копия панели подписана ячейкой');
}

// ---------------------------------------------------------------- сохранение в проекте
{
  const src = Gr.groupSelection(d0, ['p1', 'p2', 't1'], 'Узел А')!.doc;
  // проект сохраняется JSON'ом целиком — группы должны пережить round-trip
  const loaded = JSON.parse(JSON.stringify(src)) as M.Doc;
  assert.equal(loaded.groups?.length, 1, 'группы сохранились в JSON');
  assert.equal(loaded.groups![0].name, 'Узел А');
  assert.deepEqual(loaded.groups![0].ids, ['p1', 'p2', 't1']);
  // и клон документа (основа истории отмены) несёт группы
  const clone = M.cloneDoc(src);
  assert.deepEqual(clone.groups, src.groups, 'cloneDoc сохраняет группы');
  clone.groups![0].ids.push('p3');
  assert.equal(src.groups![0].ids.length, 3, 'клон не связан с оригиналом');
  // старый проект без групп открывается без ошибок
  const old: M.Doc = { name: 'старый', w: 10, h: 10, entities: [] };
  assert.equal(Gr.groupIndex(old.groups).size, 0, 'документ без групп — пустой индекс');
  assert.deepEqual(Gr.pruneGroups(old.groups, new Set()), [], 'документ без групп чистится в пустой список');
}

// ---------------------------------------------------------------- подписи
assert.equal(Gr.groupCountLabel(1), '1 элемент');
assert.equal(Gr.groupCountLabel(2), '2 элемента');
assert.equal(Gr.groupCountLabel(5), '5 элементов');
assert.equal(Gr.groupCountLabel(11), '11 элементов');
assert.equal(Gr.groupCountLabel(21), '21 элемент');
assert.equal(Gr.groupWord(1), '1 группа');
assert.equal(Gr.groupWord(3), '3 группы');
assert.equal(Gr.groupWord(12), '12 групп');

console.log('GROUP OK: группировка/разгруппировка, выделение целиком, слияние групп, чистка, копии, JSON');
