// Проверка всех макросов библиотеки: геометрия, выводы, подписи.
//
// Что контролируется у каждого макроса:
//   • собирается без ошибок и детерминированно (build() дважды даёт одно и то же);
//   • все координаты конечны, рисунок лежит на слоях s1/s2, толщины > 0;
//   • площадки: размер ≥ 0.8 мм, сверло ≥ 0.6 мм, кольцо меди (size-drill)/2 ≥ 0.15;
//   • медь не слипается: зазор между любыми площадками/SMD/отверстиями ≥ 0.15 мм;
//   • совпадает с паспортом макроса (LibSpec): число выводов, SMD, отверстий, шаг;
//   • у макроса есть подписи выводов (не меньше указанного в LibSpec);
//   • подписи не лежат на меди, высота ≥ 0.55 мм, штрих ≥ 0.12 мм;
//   • имя, ключ и категория корректны, дублей ключей нет.

import {
  CATS, LIB, LIB_DUPS, LIB_LIST, type LibEl, type LibEntry,
} from '../src/pcb/library';
import { expandComp, libBBox } from '../src/pcb/expand';
import { missingGlyphs } from '../src/pcb/strokefont';
import * as M from '../src/pcb/model';

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
  /** полуразмеры: для круга half === halfY */
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
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) fail(`${who}: площадка с нечисловой координатой`);
      if (el.drill > 0 && el.drill < 0.6) fail(`${who}: сверло ${r3(el.drill)} мм < 0.6 мм`);
      if (el.size < 0.8) fail(`${who}: площадка ${r3(el.size)} мм < 0.8 мм`);
      if (el.drill > 0 && (el.size - el.drill) / 2 < MIN_RING - EPS) {
        fail(`${who}: кольцо меди ${r3((el.size - el.drill) / 2)} мм у площадки ${r3(el.size)}/${r3(el.drill)}`);
      }
      if (!['round', 'square', 'oct'].includes(el.shape)) fail(`${who}: форма площадки «${String(el.shape)}»`);
      out.push({ kind: 'pad', x: el.x, y: el.y, half: el.size / 2, halfY: el.size / 2, round: true, at: `${r3(el.x)};${r3(el.y)}` });
    } else if (el.kind === 'smd') {
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) fail(`${who}: SMD с нечисловой координатой`);
      if (el.w < 0.3 || el.h < 0.25) fail(`${who}: SMD ${r3(el.w)}×${r3(el.h)} мм — слишком мал`);
      if (el.layer !== 'k1' && el.layer !== 'k2') fail(`${who}: SMD на слое «${String(el.layer)}»`);
      if (el.rot % 90 !== 0) fail(`${who}: SMD повёрнут на ${el.rot}° (нужно кратно 90°)`);
      const swap = el.rot % 180 !== 0;
      out.push({
        kind: 'smd', x: el.x, y: el.y,
        half: (swap ? el.h : el.w) / 2, halfY: (swap ? el.w : el.h) / 2, round: false,
        at: `${r3(el.x)};${r3(el.y)}`,
      });
    } else if (el.kind === 'hole') {
      if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) fail(`${who}: отверстие с нечисловой координатой`);
      if (el.d < 0.6 || el.d > 6) fail(`${who}: отверстие Ø${r3(el.d)} мм вне 0.6…6 мм`);
      out.push({ kind: 'hole', x: el.x, y: el.y, half: el.d / 2, halfY: el.d / 2, round: true, at: `${r3(el.x)};${r3(el.y)}` });
    }
  }
  return out;
}

/** Зазор между двумя элементами меди (отрицательный = наложение) */
function gapCu(a: Cu, b: Cu): number {
  if (a.round && b.round) return Math.hypot(a.x - b.x, a.y - b.y) - a.half - b.half;
  if (!a.round && !b.round) {
    const dx = Math.max(0, Math.abs(a.x - b.x) - a.half - b.half);
    const dy = Math.max(0, Math.abs(a.y - b.y) - a.halfY - b.halfY);
    return (dx === 0 && dy === 0) ? -1 : Math.max(dx, dy);
  }
  const c = a.round ? a : b;
  const r = a.round ? b : a;
  const dx = Math.max(0, Math.abs(c.x - r.x) - r.half);
  const dy = Math.max(0, Math.abs(c.y - r.y) - r.halfY);
  return Math.hypot(dx, dy) - c.half;
}

/** Зазор между подписью и элементом меди */
function gapText(t: Box, c: Cu): number {
  if (c.round) {
    const dx = Math.max(0, t[0] - c.x, c.x - t[2]);
    const dy = Math.max(0, t[1] - c.y, c.y - t[3]);
    return Math.hypot(dx, dy) - c.half;
  }
  const dx = Math.max(0, t[0] - (c.x + c.half), (c.x - c.half) - t[2]);
  const dy = Math.max(0, t[1] - (c.y + c.halfY), (c.y - c.halfY) - t[3]);
  return (dx === 0 && dy === 0) ? -1 : Math.max(dx, dy);
}

/** Прямоугольник подписи (как в entBBox: (x,y) — левый нижний угол) */
function textBox(el: TextEl): Box {
  const w = el.text.length * el.size * 0.8;
  const h = el.size;
  const a = (el.rot * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const cs = [[0, 0], [w, 0], [w, h], [0, h]]
    .map(([xx, yy]) => ({ x: xx * ca - yy * sa + el.x, y: xx * sa + yy * ca + el.y }));
  return [
    Math.min(...cs.map((p) => p.x)), Math.min(...cs.map((p) => p.y)),
    Math.max(...cs.map((p) => p.x)), Math.max(...cs.map((p) => p.y)),
  ];
}

// ------------------------------------------------------------------ прогон

const seenKeys = new Set<string>();
let totalPads = 0, totalSmd = 0, totalHoles = 0, totalText = 0, maxLabel = 0;
const byCat = new Map<string, number>();

for (const e of LIB_LIST as ReadonlyArray<LibEntry>) {
  const who = `${e.key} (${e.name})`;
  if (seenKeys.has(e.key)) fail(`${who}: ключ повторяется`);
  seenKeys.add(e.key);
  if (LIB[e.key] !== e) fail(`${who}: нет в LIB по ключу`);
  if (!CATS.includes(e.cat)) fail(`${who}: неизвестная категория «${e.cat}»`);
  if (typeof e.build !== 'function') { fail(`${who}: нет build()`); continue; }

  let els: LibEl[];
  try {
    els = e.build();
  } catch (err) {
    fail(`${who}: build() бросил ${String(err)}`);
    continue;
  }
  if (els.length === 0) { fail(`${who}: пустой макрос`); continue; }
  if (JSON.stringify(els) !== JSON.stringify(e.build())) { fail(`${who}: build() недетерминирован`); continue; }

  const cu = copper(els, who);
  const pads = cu.filter((c) => c.kind === 'pad').length;
  const smds = cu.filter((c) => c.kind === 'smd').length;
  const holes = cu.filter((c) => c.kind === 'hole').length;
  const texts = els.filter((el): el is TextEl => el.kind === 'text');
  totalPads += pads; totalSmd += smds; totalHoles += holes; totalText += texts.length;
  maxLabel = Math.max(maxLabel, texts.length);
  byCat.set(e.cat, (byCat.get(e.cat) ?? 0) + 1);

  // паспорт макроса
  const sp = e.spec;
  if (sp) {
    if (sp.pins !== undefined && sp.pins !== pads) fail(`${who}: выводов ${pads}, в паспорте ${sp.pins}`);
    if (sp.smd !== undefined && sp.smd !== smds) fail(`${who}: SMD-площадок ${smds}, в паспорте ${sp.smd}`);
    if (sp.holes !== undefined && sp.holes !== holes) fail(`${who}: отверстий ${holes}, в паспорте ${sp.holes}`);
  } else if (pads + smds + holes > 0) {
    fail(`${who}: нет паспорта (LibSpec)`);
  }

  // зазоры между медью
  for (let i = 0; i < cu.length; i++) {
    for (let j = i + 1; j < cu.length; j++) {
      const g = gapCu(cu[i], cu[j]);
      if (g < MIN_GAP - EPS) {
        fail(`${who}: медь слипается — ${cu[i].kind}(${cu[i].at}) и ${cu[j].kind}(${cu[j].at}), зазор ${r3(g)} мм`);
      }
    }
  }

  // минимальный шаг между выводами (паспортный)
  if (sp?.pitch !== undefined && cu.length > 1) {
    let min = Infinity;
    for (let i = 0; i < cu.length; i++) {
      for (let j = i + 1; j < cu.length; j++) {
        if (cu[i].kind === 'hole' || cu[j].kind === 'hole') continue;
        min = Math.min(min, Math.hypot(cu[i].x - cu[j].x, cu[i].y - cu[j].y));
      }
    }
    if (!(Math.abs(min - sp.pitch) < 0.02)) fail(`${who}: шаг выводов ${r3(min)} мм, в паспорте ${sp.pitch}`);
  }

  // подписи выводов
  const need = sp?.labels ?? (pads + smds >= 4 ? 2 : 0);
  if (texts.length < need) fail(`${who}: подписей ${texts.length}, ожидается не меньше ${need}`);
  for (const t of texts) {
    if (!t.text) fail(`${who}: пустая подпись`);
    if (t.size < 0.55) fail(`${who}: подпись «${t.text}» высотой ${r3(t.size)} мм — нечитаема`);
    if (t.th < 0.119) fail(`${who}: подпись «${t.text}» толщина ${r3(t.th)} мм < 0.12 мм`);
    if (t.layer !== 's1' && t.layer !== 's2') fail(`${who}: подпись «${t.text}» на слое «${String(t.layer)}»`);
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) fail(`${who}: подпись «${t.text}» без координат`);
    // символы без начертания печатаются квадратами — в гербере и на шелкографии
    const bad = missingGlyphs(t.text);
    if (bad.length) fail(`${who}: в подписи «${t.text}» нет начертаний для ${bad.map((c) => `«${c}»`).join(', ')}`);
    const box = textBox(t);
    for (const c of cu) {
      if (gapText(box, c) < 0.02) {
        fail(`${who}: подпись «${t.text}» на меди (${c.kind} в ${c.at})`);
        break;
      }
    }
  }

  // шелкография: слои и толщины
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

  // габарит
  const bb = libBBox(els);
  if (!bb.every(Number.isFinite) || bb[2] - bb[0] <= 0 || bb[3] - bb[1] <= 0) {
    fail(`${who}: пустой габарит ${JSON.stringify(bb)}`);
  }
}

// ------------------------------------------------------------------ каталог

if (LIB_DUPS.length) fail(`повторяющиеся ключи в каталоге: ${LIB_DUPS.join(', ')}`);
if (Object.keys(LIB).length !== LIB_LIST.length) fail('LIB и LIB_LIST разошлись');
for (const cat of CATS) if (!byCat.get(cat)) fail(`категория без макросов: ${cat}`);
if (LIB_LIST.length < 150) fail(`макросов всего ${LIB_LIST.length} — ожидается больше 150`);

if (fails.length) {
  console.error(`LIBRARY FAIL (${fails.length}${fails.length >= 40 ? '+' : ''}):`);
  for (const f of fails) console.error('  •', f);
  process.exit(1);
}

console.log(`LIBRARY OK: ${LIB_LIST.length} макросов, ${CATS.length} категорий`);
console.log(`  выводов: ${totalPads}, SMD-площадок: ${totalSmd}, отверстий: ${totalHoles}, подписей: ${totalText} (макс. у одного макроса: ${maxLabel})`);
for (const cat of CATS) console.log(`  • ${cat}: ${byCat.get(cat)}`);

// ------------------------------------------------ развёртка макроса на плату

// Подписи выводов должны доезжать до платы: у DIP-8 — ровно 8 номеров,
// при повороте и переносе на низ подписи поворачиваются вместе с компонентом.
{
  const comp = (rot: number, side: 'top' | 'bottom'): M.Comp => ({
    id: 'ck', kind: 'comp', lib: 'dip8', name: 'DIP-8', x: 10, y: 20, rot, side,
    bl: libBBox(LIB.dip8.build()),
  });
  const top = expandComp(comp(0, 'top'));
  const pads = top.filter((e) => e.kind === 'pad');
  const texts = top.filter((e): e is M.TextE => e.kind === 'text');
  if (pads.length !== 8) fail(`развёртка dip8: площадок ${pads.length}, ожидается 8`);
  if (texts.length !== 8) fail(`развёртка dip8: подписей ${texts.length}, ожидается 8`);
  const nums = texts.map((t) => t.text).sort();
  const want = ['1', '2', '3', '4', '5', '6', '7', '8'];
  if (JSON.stringify(nums) !== JSON.stringify(want)) fail(`развёртка dip8: подписи ${nums.join(',')}`);
  if (texts.some((t) => t.layer !== 's1')) fail('развёртка dip8: подписи должны быть на Ш1');
  for (const t of texts) if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) fail('развёртка dip8: подпись без координат');

  // поворот на 90° — подписи едут вместе с площадками
  const rotated = expandComp(comp(90, 'top')).filter((e): e is M.TextE => e.kind === 'text');
  if (rotated.length !== 8) fail('развёртка dip8 при 90°: подписи потерялись');
  if (rotated.every((t) => t.rot === 0)) fail('развёртка dip8 при 90°: подписи не повернулись');

  // низ платы — подписи зеркалятся и уходят на Ш2
  const bottom = expandComp(comp(0, 'bottom')).filter((e): e is M.TextE => e.kind === 'text');
  if (bottom.some((t) => t.layer !== 's2')) fail('развёртка dip8 снизу: подписи должны быть на Ш2');
  if (bottom.some((t) => !t.mirror)) fail('развёртка dip8 снизу: подписи должны быть зеркальны');

  // габарит макроса покрывает всё, что развернулось (иначе не работает выделение)
  const worldBox = (c: M.Comp): [number, number, number, number] => {
    const [x1, y1, x2, y2] = c.bl;
    const a = (c.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
    const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([xx, yy]) => {
      const mx = c.side === 'bottom' ? -xx : xx;
      return { x: c.x + mx * co - yy * si, y: c.y + mx * si + yy * co };
    });
    return [
      Math.min(...pts.map((p) => p.x)), Math.min(...pts.map((p) => p.y)),
      Math.max(...pts.map((p) => p.x)), Math.max(...pts.map((p) => p.y)),
    ];
  };
  // сам габарит макроса покрывает все его примитивы (локальные координаты)
  {
    const bb = libBBox(LIB.dip8.build());
    for (const e of LIB.dip8.build()) {
      const [a, b, cc, d] = e.kind === 'line'
        ? [Math.min(e.x1, e.x2), Math.min(e.y1, e.y2), Math.max(e.x1, e.x2), Math.max(e.y1, e.y2)]
        : [e.x, e.y, e.x, e.y];
      if (a < bb[0] - 0.01 || b < bb[1] - 0.01 || cc > bb[2] + 0.01 || d > bb[3] + 0.01) {
        fail(`габарит dip8 не покрывает ${e.kind}`);
        break;
      }
    }
  }
  for (const rot of [0, 90, 180, 270]) {
    for (const side of ['top', 'bottom'] as const) {
      const c = comp(rot, side);
      const [wx1, wy1, wx2, wy2] = worldBox(c);
      const [mx1, my1, mx2, my2] = M.entBBox(c);
      if (Math.abs(wx1 - mx1) > 0.01 || Math.abs(wy1 - my1) > 0.01 ||
          Math.abs(wx2 - mx2) > 0.01 || Math.abs(wy2 - my2) > 0.01) {
        fail(`габарит компонента (${rot}°, ${side}) разошёлся с model.entBBox`);
      }
      for (const e of expandComp(c)) {
        const [a, b, cc, d] = M.entBBox(e);
        if (a < wx1 - 0.01 || b < wy1 - 0.01 || cc > wx2 + 0.01 || d > wy2 + 0.01) {
          fail(`габарит dip8 (${rot}°, ${side}) не покрывает ${e.kind} [${a};${b};${cc};${d}] вне [${wx1};${wy1};${wx2};${wy2}]`);
          break;
        }
      }
    }
  }
}

if (fails.length) {
  console.error(`LIBRARY FAIL (${fails.length}):`);
  for (const f of fails) console.error('  •', f);
  process.exit(1);
}
console.log('  развёртка на плату: подписи выводов, поворот, низ платы, габарит — OK');
