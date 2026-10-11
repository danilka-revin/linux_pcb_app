// Дерево объектов (src/pcb/objtree.ts): разделы по слоям, подписи, поиск.
// Логика чистая — проверяется без React и без холста.
import assert from 'node:assert/strict';
import {
  KIND_ICON, KIND_ONE, buildObjectTree, countNodes, entDetail, entLabel, filterObjectTree,
  flagState, newEntsLabel, sectionOf, type ObjNode,
} from '../src/pcb/objtree';
import type { Doc, Entity } from '../src/pcb/model';
import { ICONS } from '../src/ui/icons';

const ents: Entity[] = [
  { id: 'p1', kind: 'pad', x: 10, y: 10, shape: 'round', size: 1.9, drill: 0.9 },
  { id: 'p2', kind: 'pad', x: 12.5, y: 10, shape: 'round', size: 1.9, drill: 0.9 },
  { id: 'v1', kind: 'via', x: 20, y: 10, size: 0.8, drill: 0.4 },
  { id: 'h1', kind: 'hole', x: 30, y: 10, d: 3 },
  { id: 't1', kind: 'track', pts: [{ x: 10, y: 20 }, { x: 20, y: 20 }], w: 0.5, layer: 'k1' },
  { id: 's1', kind: 'smd', x: 40, y: 20, w: 1.2, h: 0.8, rot: 0, layer: 'k2' },
  { id: 'x1', kind: 'text', x: 10, y: 40, size: 2, th: 0.3, rot: 0, text: 'GND', mirror: false, layer: 's1' },
  { id: 'r1', kind: 'rect', x: 0, y: 0, w: 60, h: 50, filled: false, th: 0.2, layer: 'outline' },
  {
    id: 'c1', kind: 'comp', lib: '', name: 'R1', x: 50, y: 40, rot: 0, side: 'top',
    bl: [-1, -1, 1, 1],
    ents: [
      { id: 'l0', kind: 'pad', x: -0.5, y: 0, shape: 'round', size: 1.5, drill: 0.8 },
      { id: 'l1', kind: 'pad', x: 0.5, y: 0, shape: 'round', size: 1.5, drill: 0.8 },
      { id: 'l2', kind: 'text', x: -1, y: 1, size: 1, th: 0.2, rot: 0, text: '10k', mirror: false, layer: 's1' },
    ],
  },
];

const doc: Doc = {
  name: 'Тест дерева', w: 100, h: 80, entities: ents,
  groups: [{ id: 'g1', name: 'Питание', ids: ['p1', 'p2'] }],
};

const tree = buildObjectTree(doc);
const titles = tree.map((n) => n.label);
assert.deepEqual(titles, ['Детали', 'Сквозные', 'Верхняя медь (K1)', 'Нижняя медь (K2)', 'Шелкография верх (Ш1)', 'Контур платы'],
  `разделы дерева: ${titles.join(' | ')}`);

const find = (list: ObjNode[], label: string): ObjNode | undefined => list.find((n) => n.label === label);
const section = (label: string) => find(tree, label)!;
const group = (secLabel: string, groupLabel: string) => find(section(secLabel).children ?? [], groupLabel)!;
const ent = (secLabel: string, groupLabel: string, id: string) =>
  (group(secLabel, groupLabel).children ?? []).find((n) => n.ids.includes(id))!;
/** Строка прямо в разделе (детали идут без группы-прослойки). */
const inSection = (secLabel: string, id: string) =>
  (section(secLabel).children ?? []).find((n) => n.ids.includes(id))!;

// --- 1. состав разделов ----------------------------------------------------
assert.equal(section('Сквозные').count, 4, 'сквозные: 2 площадки, переход и отверстие');
assert.deepEqual(section('Сквозные').ids, ['p1', 'p2', 'v1', 'h1'], 'id сквозных объектов');
assert.equal(group('Сквозные', 'Площадки').count, 2, 'площадок две');
assert.equal(group('Сквозные', 'Отверстия').count, 1, 'отверстие одно');
assert.equal(section('Верхняя медь (K1)').count, 1, 'на K1 одна дорожка');
assert.equal(section('Нижняя медь (K2)').count, 1, 'на K2 один SMD');
assert.equal(section('Шелкография верх (Ш1)').count, 1, 'на Ш1 один текст');
assert.equal(section('Контур платы').count, 1, 'в контуре прямоугольник');
assert.equal(section('Детали').count, 1, 'одна деталь');
assert.equal(sectionOf(ents[0]), 'through', 'площадка — сквозной объект');
assert.equal(sectionOf(ents[4]), 'k1', 'дорожка — на своём слое');
assert.equal(sectionOf(ents[8]), 'comp', 'компонент — в деталях');

// --- 2. подписи и пояснения ------------------------------------------------
assert.match(entLabel(ents[0]), /^Площадка ⌀1,9 мм/, `подпись площадки: ${entLabel(ents[0])}`);
assert.match(entLabel(ents[4]), /^Дорожка 0,5 мм · 10 мм · узлов 2$/, `подпись дорожки: ${entLabel(ents[4])}`);
assert.match(entLabel(ents[6]), /^Текст «GND»$/, 'подпись текста');
assert.match(entLabel(ents[8]), /^R1 · сверху$/, 'подпись детали');
assert.match(entDetail(ents[0]), /x 10; y 10 мм/, `координаты в пояснении: ${entDetail(ents[0])}`);
assert.match(entDetail(ents[1]), /x 12,5; y 10 мм/, `дробные координаты: ${entDetail(ents[1])}`);
assert.match(entDetail(ents[0], ['Питание']), /группа «Питание»/, 'в пояснении видно группу');

// --- 3. детали: примитивы внутри, но выбор — деталь целиком ---------------
const comp = inSection('Детали', 'c1');
assert.equal(comp.ids[0], 'c1', 'строка детали выбирает саму деталь');
assert.ok(comp.children?.length, 'у детали есть примитивы внутри');
assert.deepEqual((comp.children ?? []).map((n) => n.label), ['Площадки', 'Тексты'], 'примитивы детали по типам');
assert.deepEqual((comp.children ?? [])[0].ids, ['c1'], 'примитив внутри детали выбирает деталь, а не себя');

// --- 4. иконки строк существуют -------------------------------------------
for (const node of [comp, section('Сквозные'), group('Сквозные', 'Площадки'), ent('Сквозные', 'Площадки', 'p1')]) {
  assert.ok(ICONS[node.icon], `иконка «${node.icon}» есть в наборе (${node.label})`);
}
for (const kind of Object.keys(KIND_ICON) as (keyof typeof KIND_ICON)[]) {
  assert.ok(ICONS[KIND_ICON[kind]], `иконка типа «${kind}» есть в наборе`);
  assert.ok(KIND_ONE[kind], `подпись типа «${kind}» есть`);
}

// --- 5. поиск --------------------------------------------------------------
const rows = (list: ObjNode[]): string[] => list.flatMap((n) => [n.label, ...(n.children ? rows(n.children) : [])]);
const search = (q: string) => rows(filterObjectTree(tree, q));

assert.deepEqual(search('R1'), ['Детали', 'R1 · сверху', 'Площадки', 'Тексты'],
  `поиск по детали: ${search('R1').join(' | ')}`);
assert.ok(search('дорожка').includes('Дорожка 0,5 мм · 10 мм · узлов 2'), 'поиск по типу объекта');
assert.ok(search('GND').includes('Текст «GND»'), 'поиск по надписи');
assert.ok(search('K2').includes('SMD 1,2×0,8 мм'), 'поиск по слою');
assert.ok(search('питание').some((l) => l.startsWith('Площадка ⌀1,9 мм')), 'поиск по имени группы');
assert.ok(search('10,5').length === 0, 'свободный запрос ничего не находит');

// координаты ищутся и с запятой, и с точкой
const pad = ent('Сквозные', 'Площадки', 'p2');
assert.ok(pad.hay.includes('12,5') && pad.hay.includes('12.5'), 'в поиске обе записи координат');
assert.deepEqual(search('12.5'), ['Сквозные', 'Площадки', 'Площадка ⌀1,9 мм · отв. 0,9'], 'поиск по координате с точкой');
assert.deepEqual(search('12,5'), search('12.5'), 'запятая и точка равнозначны');
// запрос из нескольких слов: все должны найтись
// совпала сама деталь — показывается всё её поддерево (видны и площадки)
assert.deepEqual(search('текст 10k'), ['Детали', 'R1 · сверху', 'Площадки', 'Тексты'], 'поиск по нескольким словам');
// регистр не важен
assert.deepEqual(search('gnd'), search('GND'), 'регистр не важен');
// найденный раздел показывает всё своё поддерево
const byText = filterObjectTree(tree, 'GND');
assert.equal(byText.length, 1, 'надпись GND лежит только на верхней шелкографии');
assert.equal(byText[0].label, 'Шелкография верх (Ш1)', 'найдён раздел верхней шелкографии');
assert.equal(byText[0].count, 1, 'счётчик найденного раздела');
// запрос по имени слоя показывает слой целиком; подсказка раздела тоже ищется
const byLayer = filterObjectTree(tree, 'шелкография');
assert.deepEqual(byLayer.map((n) => n.label), ['Детали', 'Шелкография верх (Ш1)'],
  'слой ищется по названию, а «Детали» — по подсказке «шелкография внутри»');

// --- 6. флаги строк --------------------------------------------------------
assert.equal(flagState(['a', 'b'], new Set()), 'none', 'ничего не скрыто');
assert.equal(flagState(['a', 'b'], new Set(['a'])), 'mixed', 'скрыта часть');
assert.equal(flagState(['a', 'b'], new Set(['a', 'b'])), 'all', 'скрыто всё');
assert.equal(countNodes(tree), 9, 'всего объектов в дереве');
assert.equal(section('Детали').children!.length, 1, 'в разделе «Детали» — сами детали, без группы');

// --- 7. подпись операции «добавлены объекты» -------------------------------
assert.equal(newEntsLabel([ents[4]]), 'Добавлен объект: дорожка', newEntsLabel([ents[4]]));
assert.equal(newEntsLabel([ents[0], ents[1]]), 'Добавлено объектов: 2 (площадки)', newEntsLabel([ents[0], ents[1]]));
assert.equal(newEntsLabel([ents[0], ents[4]]), 'Добавлено объектов: 2', newEntsLabel([ents[0], ents[4]]));

console.log('objtree: разделы, подписи, детали, поиск и флаги OK');
