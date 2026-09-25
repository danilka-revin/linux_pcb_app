// Проверка генератора деталей: геометрия, паспорт, разбор строки описания,
// развёртка на плату и хранилище личной библиотеки (папки).
//
// Заменяет test/library.ts: каталога макросов больше нет — футпринт现在
// собирается из свободной строки описания (src/pcb/gen.ts), поэтому здесь
// прогоняются все семейства на нескольких наборах фраз и контролируется то же
// самое, что контролировалось у каталога:
//   • координаты конечны, рисунок на слоях s1/s2, толщины > 0;
//   • площадки: размер ≥ 0.8 мм, сверло ≥ 0.6 мм, кольцо меди ≥ 0.15 мм;
//   • медь не слипается: зазор между площадками/SMD/отверстиями ≥ 0.15 мм;
//   • выводы/отверстия/подписи совпадают с паспортом (FpSpec);
//   • подписи не лежат на меди, читаемы, есть начертание каждого символа;
//   • строка разворачивается в то же самое повторно (детерминированность).

import {
  EXAMPLES, FAMILIES, FAMILY_HELP, bboxOf, describe, detectFamily, generate, setParamInQuery,
  type GenResult,
} from '../src/pcb/gen';
import type { LibEl } from '../src/pcb/footprint';
import { expandComp, expandDoc, libBBox, libElsToEnts } from '../src/pcb/expand';
import { missingGlyphs } from '../src/pcb/strokefont';
import * as M from '../src/pcb/model';
import {
  addMacro, buildTree, createFolder, emptyStore, exportJSON, folderPath, importJSON, loadStore,
  makeMacro, moveMacro, normalizeStore, removeFolder, removeMacro, renameFolder, saveStore, updateMacro,
  type Macro, type Store,
} from '../src/pcb/userlib';

const fails: string[] = [];
const fail = (m: string): void => { if (fails.length < 40) fails.push(m); };

const MIN_GAP = 0.15;        // минимальный зазор медь-медь, мм
const MIN_RING = 0.15;       // минимальное кольцо меди вокруг сверла, мм
const EPS = 1e-6;

type TextEl = Extract<LibEl, { kind: 'text' }>;
type Box = [number, number, number, number];

interface Cu {
  kind: 'pad' | 'smd' | 'hole';
  x: number;
  y: number;
  half: number;
  halfY: number;
  round: boolean;
  at: string;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function copper(els: LibEl[], who: string): Cu[] {
  const out: Cu[] = [];
  for (const el of els) {
    if (el.kind === 'pad') {
      if (!(el.size >= 0.8)) fail(`${who}: площадка ${r3(el.size)} мм < 0.8 мм`);
      if (el.drill < 0) fail(`${who}: отрицательное сверло`);
      else if (el.drill > 0 && el.drill < 0.6) fail(`${who}: сверло ${r3(el.drill)} мм < 0.6 мм`);
      else if (el.drill > 0 && (el.size - el.drill) / 2 < MIN_RING - EPS) {
        fail(`${who}: кольцо меди ${(el.size - el.drill) / 2} мм < ${MIN_RING} мм`);
      }
      out.push({
        kind: 'pad', x: el.x, y: el.y, half: el.size / 2, halfY: el.size / 2,
        round: el.shape !== 'square', at: `${r3(el.x)};${r3(el.y)}`,
      });
    } else if (el.kind === 'smd') {
      if (!(el.w > 0 && el.h > 0)) fail(`${who}: SMD-площадка ${r3(el.w)}×${r3(el.h)}`);
      // как в model.entBBox: поворот 90° меняет местами w и h
      const rot = (((Math.round(el.rot) % 180) + 180) % 180);
      const hx = (rot === 0 ? el.w : el.h) / 2;
      const hy = (rot === 0 ? el.h : el.w) / 2;
      out.push({ kind: 'smd', x: el.x, y: el.y, half: hx, halfY: hy, round: false, at: `${r3(el.x)};${r3(el.y)}` });
    } else if (el.kind === 'hole') {
      if (!(el.d > 0)) fail(`${who}: отверстие d=${el.d}`);
      out.push({ kind: 'hole', x: el.x, y: el.y, half: el.d / 2, halfY: el.d / 2, round: true, at: `${r3(el.x)};${r3(el.y)}` });
    }
  }
  return out;
}

/** Зазор между двумя элементами меди (отрицательный = наложение) */
function gapCu(a: Cu, b: Cu): number {
  const dx = Math.abs(a.x - b.x) - a.half - b.half;
  const dy = Math.abs(a.y - b.y) - a.halfY - b.halfY;
  if (a.round && b.round) return Math.hypot(a.x - b.x, a.y - b.y) - a.half - b.half;
  return Math.max(dx, dy);
}

/** Зазор между подписью и элементом меди */
function gapText(t: Box, c: Cu): number {
  const cx = Math.max(t[0], Math.min(c.x, t[2]));
  const cy = Math.max(t[1], Math.min(c.y, t[3]));
  return Math.max(Math.abs(c.x - cx) - c.half, Math.abs(c.y - cy) - c.halfY);
}

/** Прямоугольник подписи (как в entBBox: (x,y) — левый нижний угол) */
function textBox(el: TextEl): Box {
  const w = el.text.length * el.size * 0.8, h = el.size;
  const a = (el.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => ({ x: el.x + x * ca - y * sa, y: el.y + x * sa + y * ca }));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ------------------------------------------------------------- наборы фраз

/** Дополнительно к первому алиасу и примеру семейства */
const EXTRA: Record<string, string[]> = {
  dip: ['dip 14', 'dip 16 широкий, панелька', 'dip 8 2 крепёжных отверстия m3', 'dip8 шаг 2.54 без шелкографии'],
  soic: ['soic 16 шаг 1.27', 'tssop 20 шаг 0.65', 'soic 8 низ', 'soic 8 без подписей'],
  qfn: ['qfn 32 5x5 thermal', 'qfn 16 3x3 шаг 0.5', 'dfn 8'],
  qfp: ['lqfp 44 10x10 шаг 0.8', 'qfp 64 14x14 шаг 0.5'],
  two: ['резистор 10ком 0.25вт', 'резистор 1/4 вт', 'c1 100nf 5.08', 'светодиод 5 мм', 'd3'],
  chip: ['0805', '1206диод', 'smd 0402', 'конденсатор 0603'],
  row: ['header 2x40', 'гребёнка 1x3 90', 'idc 10 шаг 2.54', 'папа 40'],
  klem: ['клеммник 2 контакта 5.08 без шелкографии', 'клеммник 4', 'клеммник 3 контакта 3.5'],
  tact: ['tact 6x6 4pin', 'кнопка 12x12'],
  pack: ['to220', 'to-92', 'корпус TO-3P'],
  sot: ['sot-23', 'sot-89', 'транзистор smd'],
  elco: ['электролит 10 мм шаг 5', 'конденсатор 100нф шаг 5.08'],
  module: ['esp32 devkit', 'duino nano', 'raspberry pi pico', 'nodemcu'],
  shield: ['nano shield m3 крепёж', 'pro shield', 'arduino uno shield'],
  board: ['плата 60x40 4 m3', 'плата 100x80, отступ 4'],
  hole: ['крепёжное отверстие m3 x4 шаг 20', '2 отверстия 3.2'],
  pad: ['тестпоинт 1.8/1.0', 'площадка 2.5/1.0'],
  fiducial: ['метка совмещения 1'],
  crystal: ['кварц 3225', 'hc49'],
  relay: ['реле 5 выводов шаг 5'],
  dipsw: ['dip switch 8', 'переключатель 4'],
};

const queries: string[] = [];
for (const f of FAMILIES) {
  queries.push(f.aliases[0]);
  const help = FAMILY_HELP.find((h) => h.id === f.id);
  if (help?.example) queries.push(help.example);
  for (const q of EXTRA[f.id] ?? []) queries.push(q);
}
for (const e of EXAMPLES) queries.push(e.query);

// --------------------------------------------------------------- прогон

const run = new Map<string, GenResult>();
let checked = 0;
for (const q of queries) {
  if (run.has(q)) continue;
  const r = generate(q);
  run.set(q, r);
  const who = `«${q}»`;
  if (!r.ok || !r.els || !r.family) {
    fail(`${who}: не собралось — ${r.error ?? 'нет семейства'}`);
    continue;
  }
  checked++;
  const els = r.els;
  if (!els.length) { fail(`${who}: пусто`); continue; }
  if (JSON.stringify(els) !== JSON.stringify(generate(q).els)) fail(`${who}: недетерминированно`);
  if (!r.title) fail(`${who}: пустое название`);
  if (!describe(r)) fail(`${who}: пустое описание для предпросмотра`);
  const bb = bboxOf(els);
  if (r.bl && r.bl.some((v, i) => Math.abs(v - bb[i]) > 0.01)) fail(`${who}: bl разошёлся с bboxOf`);
  if (!bb.every(Number.isFinite) || bb[2] - bb[0] <= 0 || bb[3] - bb[1] <= 0) fail(`${who}: пустой габарит`);

  const cu = copper(els, who);
  const pads = cu.filter((c) => c.kind === 'pad').length;
  const smds = cu.filter((c) => c.kind === 'smd').length;
  const holes = cu.filter((c) => c.kind === 'hole').length;
  const texts = els.filter((el): el is TextEl => el.kind === 'text');

  // паспорт (FpSpec)
  const sp = r.spec;
  if (sp) {
    if (sp.pins !== undefined && sp.pins !== pads) fail(`${who}: выводов ${pads}, в паспорте ${sp.pins}`);
    // тепловая площадка QFN в «выводы» не входит
    if (sp.smd !== undefined && Math.abs(sp.smd - smds) > (smds > sp.smd ? 1 : 0)) fail(`${who}: SMD-площадок ${smds}, в паспорте ${sp.smd}`);
    if (sp.holes !== undefined && sp.holes !== holes) fail(`${who}: отверстий ${holes}, в паспорте ${sp.holes}`);
    if (sp.pins !== undefined && sp.pins < 0) fail(`${who}: отрицательное число выводов`);
    // spec.w/h — габарит КОРПУСА, а не рисунка (площадки и подписи шире)
    if (sp.w !== undefined && sp.w <= 0) fail(`${who}: нулевая ширина корпуса`);
    if (sp.h !== undefined && sp.h <= 0) fail(`${who}: нулевая высота корпуса`);
  } else if (pads + smds + holes > 0) {
    fail(`${who}: нет паспорта (FpSpec)`);
  }

  // зазоры меди
  for (let i = 0; i < cu.length; i++) {
    for (let j = i + 1; j < cu.length; j++) {
      const g = gapCu(cu[i], cu[j]);
      if (g < MIN_GAP - EPS) {
        fail(`${who}: медь слипается — ${cu[i].kind}(${cu[i].at}) и ${cu[j].kind}(${cu[j].at}), зазор ${r3(g)} мм`);
      }
    }
  }

  // подписи (сверловку под подписью не считаем ошибкой: это не медь)
  const cuNoHole = cu.filter((c) => c.kind !== 'hole');
  const need = sp?.labels ?? 0;
  if (texts.length < need) fail(`${who}: подписей ${texts.length}, ожидается не меньше ${need}`);
  for (const t of texts) {
    if (!t.text) fail(`${who}: пустая подпись`);
    if (t.size < 0.55) fail(`${who}: подпись «${t.text}» высотой ${r3(t.size)} мм — нечитаема`);
    if (t.th < 0.119) fail(`${who}: подпись «${t.text}» толщина ${r3(t.th)} мм < 0.12 мм`);
    if (t.layer !== 's1' && t.layer !== 's2') fail(`${who}: подпись «${t.text}» на слое «${String(t.layer)}»`);
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) fail(`${who}: подпись «${t.text}» без координат`);
    const bad = missingGlyphs(t.text);
    if (bad.length) fail(`${who}: в подписи «${t.text}» нет начертаний для ${bad.map((c) => `«${c}»`).join(', ')}`);
    const box = textBox(t);
    for (const c of cuNoHole) {
      if (gapText(box, c) < 0.02) { fail(`${who}: подпись «${t.text}» на меди (${c.kind} в ${c.at})`); break; }
    }
  }

  // шелкография
  for (const el of els) {
    if (el.kind === 'line' || el.kind === 'rect' || el.kind === 'circle') {
      if (el.layer !== 's1' && el.layer !== 's2') fail(`${who}: рисунок на слое «${String(el.layer)}»`);
      const th = el.kind === 'rect' ? el.th : el.w;
      if (!(th > 0)) fail(`${who}: нулевая толщина линии рисунка`);
    }
    const xs = el.kind === 'line' ? [el.x1, el.x2] : 'x' in el ? [el.x] : [];
    const ys = el.kind === 'line' ? [el.y1, el.y2] : 'y' in el ? [el.y] : [];
    for (const v of [...xs, ...ys]) if (!Number.isFinite(v)) fail(`${who}: нечисловая координата`);
  }
}

// ------------------------------------------------------------ разбор строки

const expect = (q: string, want: Record<string, unknown>): void => {
  const r = generate(q);
  if (!r.ok) { fail(`разбор «${q}»: не собралось (${r.error})`); return; }
  for (const [k, v] of Object.entries(want)) {
    const got = k === 'family' ? r.family?.id : k === 'title' ? r.title
      : k === 'specPins' ? r.spec?.pins : k === 'specSmd' ? r.spec?.smd : k === 'specHoles' ? r.spec?.holes : r.params[k];
    if (typeof v === 'number' && typeof got === 'number') {
      if (Math.abs(v - got) > 0.02) fail(`разбор «${q}»: ${k} = ${got}, ожидалось ${v}`);
    } else if (v !== got) fail(`разбор «${q}»: ${k} = ${JSON.stringify(got)}, ожидалось ${JSON.stringify(v)}`);
  }
};

expect('dip 8', { family: 'dip', pins: 8, pitch: 2.54, holes: 0 });
expect('dip 8 m3', { family: 'dip', pins: 8, holes: 2, holeD: 3.2 });   // Ø назвали — крепёж включился
expect('dip 8 2 крепёжных отверстия m3', { family: 'dip', pins: 8, holes: 2, holeD: 3.2 });
expect('dip 8 3 крепёжных отверстий', { family: 'dip', holes: 3 });
expect('dip 16 широкий', { family: 'dip', pins: 16, rowW: 15.24 });
expect('dip 8 площадка 1.8/0.8', { family: 'dip', padSize: 1.8, drill: 0.8 });
expect('dip 8 подписи каждые 2', { family: 'dip', pins: 8, labels: 2 });
expect('dip8 шаг 2.54 без шелкографии', { family: 'dip', pins: 8, silk: false });
expect('soic 8 шаг 1.27', { family: 'soic', pins: 8, pitch: 1.27 });
expect('soic 8 без подписей', { family: 'soic', pins: 8, labels: 0 });
expect('tssop 20 шаг 0.65', { family: 'soic', pins: 20, pitch: 0.65 });
expect('qfn 32 5x5 шаг 0.5', { family: 'qfn', pins: 32, body: 5, pitch: 0.5, thermal: true });
expect('lqfp 44 10x10 шаг 0.8', { family: 'qfp', pins: 44, body: 10, pitch: 0.8 });
expect('header 2x40', { family: 'row', n: 40, rows: 2, specPins: 80 });
expect('idc 10 шаг 2.54', { family: 'row', n: 10, specPins: 10 });
expect('клеммник 2 контакта 5.08', { family: 'klem', n: 2, pitch: 5.08 });
expect('клеммник 2 контакта 5.08 без шелкографии', { family: 'klem', n: 2, silk: false, specHoles: 0 });
expect('tact 6x6 4pin', { family: 'tact', px: 6, py: 6, specPins: 4 });
expect('to220', { family: 'pack', specHoles: 1 });
expect('sot-23', { family: 'sot', pins: 3, specSmd: 3 });
expect('smd 0603', { family: 'chip', code: '0603', specSmd: 2 });
expect('1206диод', { family: 'chip', code: '1206', diode: true });
expect('резистор 10ком 0.25вт', { family: 'two', value: '10K', pitch: 10.16 });
expect('c1 100nf 5.08', { family: 'two', pitch: 5.08, specPins: 2 });
expect('электролит 10 мм шаг 5', { family: 'elco', d: 10, pitch: 5 });
expect('esp32 devkit', { family: 'module', n: 19, holes: 2, holeD: 2.7 });
expect('duino nano', { family: 'module', n: 15, holes: 0 });
expect('raspberry pi pico', { family: 'module', n: 20, holes: 2 });
expect('nano shield m3 крепёж', { family: 'shield', holes: true, holeD: 3.2 });
expect('arduino uno shield', { family: 'shield', w: 68.58, h: 53.34 });
expect('плата 60x40 4 m3', { family: 'board', bw: 60, bh: 40, holes: 4, holeD: 3.2 });
expect('крепёжное отверстие m3 x4 шаг 20', { family: 'hole', n: 4, pitch: 20, holeD: 3.2, specHoles: 4 });
expect('тестпоинт 1.8/1.0', { family: 'pad', padSize: 1.8, drill: 1 });
expect('метка совмещения', { family: 'fiducial', d: 1 });
expect('кварц 3225', { family: 'crystal', smd: true, specSmd: 4 });
expect('реле 5 выводов шаг 5', { family: 'relay', pins: 5, pitch: 5 });
expect('dip switch 8', { family: 'dipsw', n: 8, specPins: 16 });
expect('buzzer', { family: 'two', round: true });   // круглый 2-выводной излучатель

// непонятная фраза — честный отказ, а не выдуманный футпринт
{
  const r = generate('что-то совершенно непонятное про кота');
  if (r.ok) fail('мусорная строка не должна собираться');
  if (!r.error) fail('у отказа должно быть объяснение');
}
// единицы: mil и см
{
  const a = generate('dip 8 шаг 100mil'), b = generate('dip 8 шаг 2.54');
  if (!a.ok || !b.ok) fail('mil/мм должны разбираться одинаково');
  else if (Math.abs((a.params.pitch as number) - (b.params.pitch as number)) > 0.02) {
    fail(`100 mil = ${a.params.pitch} мм, ожидалось 2.54`);
  }
}
// «не учтено» не должно терять разумные фразы
for (const [q, r] of run) {
  const ign = (r.ignored ?? []).filter((x) => x.length > 2);
  if (ign.length) fail(`«${q}»: не распознано ${ign.join(', ')}`);
}

// ------------------------------------------------------------- каталог семей
{
  const ids = new Set<string>();
  for (const f of FAMILIES) {
    if (ids.has(f.id)) fail(`дубль семейства ${f.id}`);
    ids.add(f.id);
    if (!f.aliases.length) fail(`${f.id}: нет алиасов`);
    if (!f.hint) fail(`${f.id}: нет подсказки`);
    if (!f.params.length) fail(`${f.id}: нет параметров`);
    for (const d of f.params) if (!d.key || !d.label) fail(`${f.id}: кривое описание параметра`);
  }
  if (FAMILIES.length < 18) fail(`семейств ${FAMILIES.length} — ожидается не меньше 18`);
  for (const h of FAMILY_HELP) if (!FAMILIES.some((f) => f.id === h.id)) fail(`справка о несуществующем семействе ${h.id}`);
  for (const h of FAMILY_HELP) if (!h.words || !h.example) fail(`справка ${h.id}: пусто`);
  if (EXAMPLES.length < 10) fail('мало примеров для состояния «не понимаю»');
  for (const e of EXAMPLES) if (!generate(e.query).ok) fail(`пример «${e.query}» не собирается`);
}

// ------------------------------------------------------ правка параметра

{
  for (const f of FAMILIES) {
    const q = f.aliases[0];
    for (const d of f.params) {
      if (d.kind !== 'int' && d.kind !== 'num') continue;
      const cur = (run.get(q)?.params ?? {})[d.key];
      if (typeof cur !== 'number') continue;
      const nv = Math.min(Math.max((d.min ?? 0.1) + 0.2, cur + (d.step ?? 1)), d.max ?? 1e6);
      const nq = setParamInQuery(q, f, d.key, d.kind === 'int' ? Math.round(nv) : nv);
      const r = generate(nq);
      if (!r.ok) { fail(`правка ${f.id}.${d.key}: «${nq}» не собралось`); continue; }
      const want = d.kind === 'int' ? Math.round(nv) : nv;
      const got = Number(r.params[d.key]);
      if (!(Math.abs(got - want) <= (d.kind === 'int' ? 0.51 : 0.02))) {
        fail(`правка ${f.id}.${d.key}: ${got}, ожидалось ${want} (строка «${nq}»)`);
      }
      if (r.ignored?.length) fail(`правка ${f.id}.${d.key}: «${nq}» — не распознано ${r.ignored.join(', ')}`);
    }
  }
  // логический параметр — словами, и слово должно читаться обратно
  const dip = FAMILIES.find((f) => f.id === 'dip')!;
  for (const v of [false, true]) {
    const q = setParamInQuery('dip 8 шаг 2.54', dip, 'silk', v);
    const r = generate(q);
    if (!r.ok) fail(`правка silk=${v}: «${q}» не собралось`);
    else if (r.params.silk !== v) fail(`правка silk=${v}: прочиталось как ${r.params.silk} (строка «${q}»)`);
    if (r.ignored?.length) fail(`правка silk=${v}: не распознано ${r.ignored.join(', ')} (строка «${q}»)`);
  }
  const q = setParamInQuery('dip 8', dip, 'silk', false);
  if (!/без шелкограф/i.test(q)) fail(`silk=false должно записываться по-русски, получилось «${q}»`);
  const r = generate(q);
  if (!r.ok || r.params.silk !== false) fail('после правки silk=выкл шелкографии нет');
  if (r.els && r.els.some((e) => e.kind !== 'pad' && e.kind !== 'text' && e.kind !== 'hole')) {
    fail('при отключённой шелкографии остались линии/окружности');
  }
}

// -------------------------------------------- развёртка сгенерированной детали

{
  const g = generate('dip 8');
  if (!g.ok || !g.els) fail('dip 8 не собралось');
  else {
    const els = g.els;
    const ents = libElsToEnts(els);
    if (ents.length !== els.length) fail(`libElsToEnts: ${ents.length} из ${els.length} примитивов потерялись`);
    if (ents.some((e) => !e.id)) fail('libElsToEnts: примитивы без id');
    const bl = libBBox(els);
    if (bl.some((v, i) => Math.abs(v - bboxOf(els)[i]) > 0.01)) fail('libBBox разошёлся с bboxOf');

    const comp = (rot: number, side: 'top' | 'bottom'): M.Comp => ({
      id: 'ck', kind: 'comp', lib: '', name: 'DIP-8', x: 10, y: 20, rot, side,
      bl: bl.map((v) => v) as [number, number, number, number], ents,
    });
    const top = expandComp(comp(0, 'top'));
    const pads = top.filter((e) => e.kind === 'pad');
    const texts = top.filter((e): e is M.Text & { id: string } => e.kind === 'text');
    if (pads.length !== 8) fail(`развёртка: площадок ${pads.length}, ожидалось 8`);
    if (texts.length !== 8) fail(`развёртка: подписей ${texts.length}, ожидалось 8`);
    const nums = texts.map((t) => t.text).sort((a, b) => Number(a) - Number(b));
    if (nums.join(',') !== '1,2,3,4,5,6,7,8') fail(`развёртка: подписи ${nums.join(',')}`);
    if (texts.some((t) => t.layer !== 's1')) fail('развёртка: подписи должны быть на Ш1');
    for (const t of texts) if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) fail('развёртка: подпись без координат');

    const rotated = expandComp(comp(90, 'top')).filter((e): e is M.Text & { id: string } => e.kind === 'text');
    if (rotated.length !== 8) fail('развёртка 90°: подписи потерялись');
    if (rotated.every((t) => t.rot === 0)) fail('развёртка 90°: подписи не повернулись');

    const bottom = expandComp(comp(0, 'bottom')).filter((e): e is M.Text & { id: string } => e.kind === 'text');
    if (bottom.some((t) => t.layer !== 's2')) fail('развёртка снизу: подписи должны быть на Ш2');
    if (bottom.some((t) => !t.mirror)) fail('развёртка снизу: подписи должны быть зеркальны');

    // габарит компонента покрывает всё, что развернулось (иначе не работает выделение)
    for (const rot of [0, 90, 180, 270]) {
      for (const side of ['top', 'bottom'] as const) {
        const c = comp(rot, side);
        const [mx1, my1, mx2, my2] = M.entBBox(c);
        for (const e of expandComp(c)) {
          const [a, b, cc, d] = M.entBBox(e);
          if (a < mx1 - 0.02 || b < my1 - 0.02 || cc > mx2 + 0.02 || d > my2 + 0.02) {
            fail(`габарит (${rot}°, ${side}) не покрывает ${e.kind} [${r3(a)};${r3(b)};${r3(cc)};${r3(d)}] вне [${r3(mx1)};${r3(my1)};${r3(mx2)};${r3(my2)}]`);
            break;
          }
        }
      }
    }
    // локальные примитивы целиком внутри bl
    for (const e of ents) {
      const [a, b, cc, d] = M.entBBox(e);
      if (a < bl[0] - 0.02 || b < bl[1] - 0.02 || cc > bl[2] + 0.02 || d > bl[3] + 0.02) {
        fail(`bl не покрывает локальный ${e.kind}`);
        break;
      }
    }
    // развёртка документа (путь гербера) видит площадки компонента
    const flat = expandDoc([comp(0, 'top'), { id: 't', kind: 'track', pts: [{ x: 1, y: 1 }, { x: 5, y: 1 }], w: 0.3, layer: 'k1' }]);
    if (flat.length !== top.length + 1) fail(`expandDoc: ${flat.length} примитивов, ожидалось ${top.length + 1}`);
    if (!flat.some((e) => e.kind === 'pad')) fail('expandDoc: площадок сгенерированной детали не видно');
  }
}

// ------------------------------------------------------------- библиотека

{
  let st: Store = emptyStore();
  st = createFolder(st, 'Корпуса');
  const bodies = st.folders[0].id;
  st = createFolder(st, 'SOP', bodies);
  const sop = st.folders[1].id;
  if (folderPath(st, sop) !== 'Корпуса / SOP') fail(`вложенная папка: ${folderPath(st, sop)}`);
  if (st.folders.length !== 2) fail('папки не создались');
  st = createFolder(st, 'Корпуса');
  if (st.folders.length !== 2) fail('одинаковые имена в одной папке должны схлопываться');

  const mk = (name: string, q: string, folderId: string | null): Macro => {
    const g = generate(q);
    if (!g.ok) throw new Error(`тест: «${q}» не генерируется`);
    return makeMacro(name, libElsToEnts(g.els ?? []), { folderId, query: q, note: g.notes.join(' ') });
  };
  const byName = (store: Store, name: string, folderId: string | null): Macro | undefined =>
    store.macros.find((m) => m.name === name && (m.folderId ?? null) === folderId);
  st = addMacro(st, mk('SOP-8', 'soic 8 шаг 1.27', sop));
  st = addMacro(st, mk('DIP-14', 'dip 14', null));
  if (st.macros.length !== 2) fail('детали не добавились');
  const sop8 = byName(st, 'SOP-8', sop);
  if (!sop8.ents.length || !sop8.bl.every(Number.isFinite)) fail('макрос без примитивов/габарита');
  if (sop8.query !== 'soic 8 шаг 1.27') fail('макрос потерял строку генератора');
  // центр в (0,0): габарит симметричен
  if (Math.abs((sop8.bl[0] + sop8.bl[2]) / 2) > 0.01 || Math.abs((sop8.bl[1] + sop8.bl[3]) / 2) > 0.01) {
    fail('макрос не отцентрован');
  }
  // то же имя в той же папке — замена, в другой — законно
  st = addMacro(st, mk('SOP-8', 'soic 8 шаг 1.27 низ', sop));
  if (st.macros.length !== 2) fail('одно имя в одной папке должно заменять деталь');
  st = addMacro(st, mk('SOP-8', 'soic 8', null));
  if (st.macros.length !== 3) fail('то же имя в другой папке — законно');

  const dip14 = st.macros.find((m) => m.name === 'DIP-14')!;
  st = moveMacro(st, dip14.id, sop);
  if (st.macros.find((m) => m.id === dip14.id)?.folderId !== sop) fail('перенос не сработал');
  const renamed = byName(st, 'SOP-8', sop)!;
  st = updateMacro(st, renamed.id, { name: 'совсем/другое:имя' });
  const clean = byName(st, 'совсем другое имя', sop);
  if (!clean) fail('переименование не сработало');
  else if (/[:*?"<>|]/.test(clean.name)) fail('в имени остались недопустимые символы');

  // дерево
  const tree = buildTree(st, '');
  if (tree.folders.length !== 1 || tree.folders[0].folders.length !== 1) fail('дерево папок кривое');
  if (tree.folders[0].folders[0].macros.length !== 2) fail('в SOP должно быть две детали');
  const collect = (t: ReturnType<typeof buildTree>): Macro[] => [...t.macros, ...t.folders.flatMap(collect)];
  const found = collect(buildTree(st, 'dip'));
  if (found.length !== 1 || !/DIP/i.test(found[0].name)) fail(`фильтр «dip»: ${found.map((m) => m.name).join(', ')}`);
  if (!collect(buildTree(st, 'другое')).length) fail('фильтр по имени не нашёл деталь');
  if (collect(buildTree(st, 'soic 8')).length < 1) fail('поиск должен работать и по строке генератора');
  if (removeMacro(st, dip14.id).macros.length !== st.macros.length - 1) fail('удаление детали');

  // удаление папки: содержимое поднимается на уровень выше
  const st2 = removeFolder(st, sop, false);
  if (st2.folders.length !== 1) fail('папка не удалилась');
  if (st2.macros.some((m) => m.folderId === sop)) fail('после удаления папки детали должны подняться');
  const st3 = removeFolder(st, sop, true);
  if (st3.macros.length >= st.macros.length) fail('удаление папки с деталями должно убирать детали');

  // переименование папки
  st = renameFolder(st, bodies, 'Корпуса THT');
  if (folderPath(st, sop).indexOf('Корпуса THT') !== 0) fail('переименование родителя не повлияло на путь');

  // резервная копия
  const json = exportJSON(st);
  const r = importJSON(json, emptyStore());
  if (!r.ok) { fail(`экспорт/импорт: ${r.error}`); }
  else {
    if (r.added !== st.macros.length) fail(`импорт: ${r.added} из ${st.macros.length}`);
    if (r.store.folders.length !== st.folders.length) fail('импорт: папки не восстановились');
    if (r.store.macros.some((m) => st.macros.some((o) => o.id === m.id))) fail('импорт должен выдавать новые id');
    const again = importJSON(json, r.store);
    if (!again.ok) fail('повторный импорт упал');
    else if (again.store.macros.length !== r.store.macros.length) {
      fail(`повторный импорт породил копии: ${again.store.macros.length} вместо ${r.store.macros.length}`);
    }
  }
  if (importJSON('{ "нет": "json" }', emptyStore()).ok) fail('мусор в файле надо отклонять');
  if (normalizeStore(null).macros.length) fail('normalizeStore(null)');
  if (normalizeStore({ macros: [{ name: 'битый', ents: [{ kind: 'нет' }] }] }).macros.length) fail('битые примитивы не отфильтровались');
}

// ------------------------------------------------- перенос старых «моих макросов»

{
  // макросы v1 лежали плоским списком с «Папкой/в имени» — их надо переложить в дерево
  const mem = new Map<string, string>();
  const ls = {
    getItem: (k: string): string | null => mem.get(k) ?? null,
    setItem: (k: string, v: string): void => { mem.set(k, v); },
    removeItem: (k: string): void => { mem.delete(k); },
  };
  const g = globalThis as { localStorage?: unknown };
  g.localStorage = ls;
  try {
    const ent = { kind: 'hole', id: 'a', x: 0, y: 0, d: 3 } as unknown as M.Entity;
    mem.set('lay.userMacros.v1', JSON.stringify([
      { name: 'Разъем/DIP-8', folder: undefined, ents: [ent] },
      { name: 'Просто', folder: 'Из .lmk', ents: [ent] },
    ]));
    const st0 = loadStore();
    if (st0.macros.length !== 2) fail(`миграция v1: деталей ${st0.macros.length}, ожидалось 2`);
    if (!st0.folders.some((f) => f.name === 'Разъем') || !st0.folders.some((f) => f.name === 'Из .lmk')) {
      fail('миграция v1: папки не создались');
    }
    const m0 = st0.macros.find((m) => m.name === 'DIP-8');
    if (!m0 || !st0.folders.some((f) => f.id === m0.folderId && f.name === 'Разъем')) fail('миграция v1: «Папка/Имя» не разобрано');
    if (!st0.macros.every((m) => m.bl.every(Number.isFinite))) fail('миграция v1: габарит не пересчитан');
    const st1 = loadStore();
    if (st1.macros.length !== 2) fail('миграция v1: второй запуск должен читать v2');
    st1.macros.push();
    saveStore(addMacro(st1, makeMacro('Новая', [ent])));
    if (loadStore().macros.length !== 3) fail('saveStore/loadStore не сошлись');
  } finally {
    delete g.localStorage;
  }
}

// ------------------------------------------------------------------ итог

if (fails.length) {
  console.error(`GEN FAIL (${fails.length}${fails.length >= 40 ? '+' : ''}):`);
  for (const f of fails) console.error('  •', f);
  process.exit(1);
}
console.log(`GEN OK: ${checked} строк → ${FAMILIES.length} семейств, развёртка и библиотека в порядке`);
console.log(`  проверено фраз: ${run.size}, примеров: ${EXAMPLES.length}, справок: ${FAMILY_HELP.length}`);
