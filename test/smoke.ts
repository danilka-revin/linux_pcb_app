// Дымовой тест чистой логики (модель, генератор деталей, развёртка, gerber, zip).
import * as M from '../src/pcb/model';
import { EXAMPLES, generate } from '../src/pcb/gen';
import { expandComp, expandDoc, libElsToEnts } from '../src/pcb/expand';
import { gerberLayer, excellon, productionFiles } from '../src/pcb/gerber';
import { makeZip, unzip } from '../src/pcb/zip';
import { lmkToEnts } from '../src/pcb/lay6';
import { readFileSync } from 'node:fs';
import { textPolylines } from '../src/pcb/strokefont';
import { zOrdered } from '../src/pcb/render';

const assert = (c: boolean, m: string): void => { if (!c) { console.error('FAIL:', m); process.exit(1); } };

/** Деталь из строки генератора — как её вставляет приложение (ents внутри comp) */
function compEnt(id: string, query: string, x: number, y: number, rot: number, side: M.Side): Omit<M.Comp, 'id'> {
  const g = generate(query);
  assert(g.ok, `генератор: «${query}» не собралось`);
  return { kind: 'comp', lib: '', name: g.title ?? query, x, y, rot, side, bl: g.bl, ents: libElsToEnts(g.els) };
}

const doc = M.newBoard(80, 60, 'Тест');
doc.entities.push(
  { id: 't1', kind: 'track', pts: [{ x: 5, y: 5 }, { x: 20, y: 5 }, { x: 20, y: 20 }], w: 0.6, layer: 'k1' },
  { id: 'p1', kind: 'pad', x: 10, y: 30, shape: 'oct', size: 1.9, drill: 0.9 },
  { id: 'p2', kind: 'pad', x: 12.54, y: 30, shape: 'square', size: 1.9, drill: 0.9 },
  { id: 'v1', kind: 'via', x: 25, y: 25, size: 1.8, drill: 0.8 },
  { id: 'h1', kind: 'hole', x: 4, y: 4, d: 3.2 },
  { id: 's1', kind: 'smd', x: 40, y: 40, w: 1.0, h: 1.3, rot: 0, layer: 'k2' },
  { id: 'x1', kind: 'text', x: 10, y: 50, size: 2.5, th: 0.3, rot: 90, text: 'Плата 12-А', mirror: false, layer: 's1' },
  { id: 'pg1', kind: 'poly', pts: [{ x: 50, y: 5 }, { x: 70, y: 5 }, { x: 70, y: 25 }, { x: 55, y: 25 }], layer: 'k2' },
  { id: 'c1', kind: 'circle', x: 60, y: 45, r: 6, w: 0.3, layer: 'outline' },
  { id: 'r1', kind: 'rect', x: 1, y: 1, w: 78, h: 58, filled: false, th: 0.2, layer: 'outline' },
  { id: 'k1comp', ...compEnt('k1comp', 'dip 8', 40, 30, 90, 'bottom') },
  { id: 'k2comp', ...compEnt('k2comp', 'soic 8 шаг 1.27', 60, 15, 0, 'top') },
  { id: 'k3comp', ...compEnt('k3comp', 'to-92', 15, 40, 270, 'top') },
);

// любая деталь генератора разворачивается в примитивы платы
for (const ex of EXAMPLES) {
  const g = generate(ex.query);
  assert(g.ok && g.els.length > 0, `генератор: «${ex.query}» не собралось`);
}

const flat = expandDoc(doc.entities);
console.log('Примитивов после развёртки:', flat.length);

for (const l of ['k1', 'k2', 's1', 's2', 'outline'] as const) {
  const g = gerberLayer(doc, l, 'test ' + l);
  console.log(l, 'gerber длина:', g.length, 'символов; начало:', g.split('\n')[4]);
}
const xln = excellon(doc);
console.log('Excellon:\n' + xln.split('\n').slice(0, 8).join('\n'));

const zip = makeZip(productionFiles(doc));
console.log('ZIP размер:', zip.size, 'байт');

const strokes = textPolylines('Шелк X2 100%');
console.log('Штрих шрифта (сегментов):', strokes.length);

// hit-тесты (entities[0] — контур платы, [1] — дорожка, [2] — площадка)
console.log('hit pad:', M.hitEnt(doc.entities[2] as M.Entity, { x: 10.2, y: 30.1 }, 0.1));
console.log('hit track:', M.hitEnt(doc.entities[1] as M.Entity, { x: 12, y: 5.2 }, 0.1));
// компонент со встроенными примитивами: развёртка с поворотом и переносом на низ
{
  const mc: M.Comp = {
    id: 'mc1', kind: 'comp', lib: '', name: 'Макрос', x: 10, y: 10, rot: 90, side: 'bottom',
    bl: [-1, -1, 1, 1],
    ents: [
      { id: 'a', kind: 'pad', x: 1, y: 0, shape: 'round', size: 2, drill: 0.8 },
      { id: 'b', kind: 'text', x: 0, y: 0, size: 2, th: 0.3, rot: 30, text: 'A', mirror: false, layer: 's1' },
    ],
  };
  const ex = expandComp(mc);
  assert(ex.length === 2, 'embedded: два примитива, получено ' + ex.length);
  const pad = ex.find((e) => e.kind === 'pad')!;
  // низ: зеркало по X, затем поворот 90° против часовой: (1,0) -> (0,-1)
  assert(Math.abs(pad.x - 10) < 1e-9 && Math.abs(pad.y - 9) < 1e-9, 'embedded: координата пада ' + pad.x + ',' + pad.y);
  const tx = ex.find((e) => e.kind === 'text') as M.TextE;
  assert(tx.rot === 60 && tx.mirror === true && tx.layer === 's2', 'embedded: текст (rot/mirror/слой): ' + tx.rot + '/' + tx.mirror + '/' + tx.layer);
}
// z-порядок: площадки и переходы всегда поверх остального (их не должна закрывать
// залитая медь, созданная позже — например, при автотрассировке)
{
  const isFoot = (e: M.Entity) => e.kind === 'pad' || e.kind === 'via';
  const zd = zOrdered(doc);
  assert(zd.length === flat.length, 'z-order: число элементов сохранено ' + zd.length);
  const firstFoot = zd.findIndex(isFoot);
  const lastNonFoot = [...zd.keys()].filter((i) => !isFoot(zd[i])).pop() ?? -1;
  assert(firstFoot >= 0 && firstFoot > lastNonFoot, 'z-order: все пяточки после прочих элементов (first=' + firstFoot + ', lastOther=' + lastNonFoot + ')');
}
// архив макросов: ZIP с .lmk — deflate и store, вложенные имена, регистр расширения
{
  const files = await unzip(readFileSync('test/fixtures/macros.zip'));
  assert(files.size === 4, 'zip: 4 файла, получено ' + files.size);
  const lmks = [...files.keys()].filter((n) => n.toLowerCase().endsWith('.lmk'));
  assert(lmks.length === 3, 'zip: 3 .lmk (остальные проигнорированы), получено ' + lmks.length);
  const r71 = lmkToEnts(files.get('R71.lmk')!);
  assert(r71.ents.length === 3, 'zip: R71.lmk — 3 примитива, получено ' + r71.ents.length);
  const led = lmkToEnts(files.get('macros/LED_red.lMK')!);
  assert(led.ents.length === 2, 'zip: вложенный файл с верхним регистром .lMK — 2 примитива, получено ' + led.ents.length);
  const st = lmkToEnts(files.get('macros/store_pad.lmk')!);
  assert(st.ents.length === 2, 'zip: store-сжатие — 2 примитива, получено ' + st.ents.length);
  // round-trip бинарных данных через наш же writer (store)
  const bin = new Uint8Array([1, 2, 250, 0]);
  const back = await unzip(await makeZip([{ name: 'a/b.bin', data: bin }]).arrayBuffer());
  const bd = back.get('a/b.bin')!;
  assert(bd.length === 4 && bd[0] === 1 && bd[2] === 250 && bd[3] === 0, 'zip: бинарный round-trip (store)');
  console.log('ZIP-архив макросов: deflate + store, вложенные пути — OK');
}
console.log('SMOKE OK');
