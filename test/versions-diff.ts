// Сравнение версий платы: добавлено, удалено, изменено, длины и цепи.
import assert from 'node:assert/strict';
import { diffDocs, diffSummary } from '../src/pcb/versions-diff';
import type { Doc, Entity, Track } from '../src/pcb/model';

const pad = (id: string, x: number, y: number): Entity => ({ kind: 'pad', id, x, y, shape: 'round', size: 1.6, drill: 0.8 });
const track = (id: string, pts: [number, number][]): Track => ({
  kind: 'track', id, w: 0.3, layer: 'k1', pts: pts.map(([x, y]) => ({ x, y })),
});
const base = (): Doc => ({
  name: 'v', w: 100, h: 80,
  entities: [pad('p1', 10, 10), pad('p2', 40, 10), track('t1', [[10, 10], [40, 10]])],
  nets: [{ id: 'n1', name: 'GND', pads: ['p1', 'p2'] }],
});

// -------------------------------------------- одинаковые версии
{
  const d = diffDocs(base(), base());
  assert.equal(d.added + d.removed + d.changed, 0);
  assert.equal(diffSummary(d), 'Версии совпадают: различий нет.');
  assert.equal(d.trackLength.before, 30);
  assert.equal(d.trackLength.after, 30);
}

// ------------------------------------------ добавление, удаление, правка
{
  const a = base();
  const b = base();
  b.entities = [
    pad('p1', 10, 10),                                 // без изменений
    { ...pad('p2', 40, 10), x: 42 },                   // сдвинута — изменена
    track('t1', [[10, 10], [40, 10], [40, 20]]),       // дорожка удлинилась — изменена
    pad('p3', 60, 60),                                 // новая площадка
  ];
  const d = diffDocs(a, b);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 0);
  assert.equal(d.changed, 2);
  assert.deepEqual(d.byKind.pad, { added: 1, removed: 0, changed: 1 });
  assert.deepEqual(d.byKind.track, { added: 0, removed: 0, changed: 1 });
  const added = d.changes.find((c) => c.type === 'added');
  assert.ok(added && added.id === 'p3' && added.x === 60 && added.y === 60, 'точка для перехода — центр добавленного');
  assert.ok(d.trackLength.after > d.trackLength.before, 'длина дорожек выросла');
  assert.match(diffSummary(d), /добавлено 1, изменено 2/);

  // обратное сравнение: то же самое, но «удалено»
  const back = diffDocs(b, a);
  assert.equal(back.removed, 1);
  assert.equal(back.added, 0);
  assert.equal(back.changes.find((c) => c.type === 'removed')?.id, 'p3');
}

// --------------------------------- порядок ключей не создаёт ложных изменений
{
  const a = base();
  const b: Doc = JSON.parse(JSON.stringify(base()));
  b.entities = b.entities.map((e) => {
    const reversed: Record<string, unknown> = {};
    Object.keys(e).reverse().forEach((k) => { reversed[k] = (e as unknown as Record<string, unknown>)[k]; });
    return reversed as unknown as Entity;
  });
  assert.equal(diffDocs(a, b).changed, 0, 'одинаковые по смыслу примитивы — не изменены');
}

// --------------------------------------------------- комментарии ревью
{
  const a = base();
  a.comments = [
    { id: 'c1', x: 5, y: 6, text: 'Сузить дорожку?' },
    { id: 'c2', x: 10, y: 12, text: 'Старое замечание' },
  ];
  const b = base();
  b.comments = [
    { id: 'c1', x: 8, y: 6, text: 'Сузить дорожку?' },
    { id: 'c3', x: 40, y: 50, text: 'Проверить маску' },
  ];
  const d = diffDocs(a, b);
  assert.deepEqual(d.comments.map((c) => c.type), ['changed', 'added', 'removed']);
  assert.equal(d.comments[0].detail, 'метка перемещена');
  assert.ok(d.comments.some((c) => c.type === 'added' && c.detail === 'Проверить маску'));
  assert.ok(d.comments.some((c) => c.type === 'removed' && c.detail === 'Старое замечание'));
  assert.match(diffSummary(d), /комментариев: 3/);
  assert.equal(d.added + d.removed + d.changed, 0, 'аннотации не считаются геометрией платы');
}

// ------------------------------------------------ цепи и размер платы
{
  const a = base();
  const b = base();
  b.nets = [
    { id: 'n1', name: 'GND_PWR', pads: ['p1', 'p2'], bus: 'PWR' },  // переименована и с шиной
    { id: 'n2', name: 'VCC', pads: [] },                           // новая
  ];
  b.w = 120;
  const d = diffDocs(a, b);
  assert.equal(d.sizeChanged, true);
  const renamed = d.nets.find((n) => n.name === 'GND_PWR');
  assert.equal(renamed?.type, 'changed');
  assert.match(renamed!.detail, /имя «GND» → «GND_PWR»/);
  assert.match(renamed!.detail, /шина «» → «PWR»/);
  assert.equal(d.nets.find((n) => n.name === 'VCC')?.type, 'added');

  const dropped = diffDocs(b, a).nets.find((n) => n.type === 'removed');
  assert.equal(dropped?.name, 'VCC');
}

// -------------------------------------------- список изменений ограничен
{
  const a: Doc = { name: 'v', w: 10, h: 10, entities: [] };
  const b: Doc = { name: 'v', w: 10, h: 10, entities: Array.from({ length: 400 }, (_, i) => pad('q' + i, i % 10, 0)) };
  const d = diffDocs(a, b);
  assert.equal(d.added, 400, 'счётчик считает всё');
  assert.equal(d.changes.length, 300, 'в списке не больше 300 строк');
  assert.equal(d.truncated, true);
}

console.log('versions-diff: добавлено/удалено/изменено, цепи, длины и порядок ключей OK');
