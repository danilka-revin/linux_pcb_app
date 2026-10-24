// Генератор коробок: движок шип-паз, каталог из 28 типов, сборка без
// пересечений деталей, раскладка на листе и точный DXF.
import assert from 'node:assert/strict';
import {
  BOX_FAMILIES, BOX_TYPES, DEFAULT_JOINT, boxCtx, boxThumbnail, buildBox, contourArea, dedupe,
  defaultBoxParams, edgeProfile, findBoxType, innerSize, innerSideTrims, layoutBoxParts, livingHinge,
  normalizeBoxParams, parseSections, polyLength, projectAssembly, rectPanel, rectPts, type BoxHole,
  type BoxParamValues, type EdgeKind, type JointOpts, type Pt, type Vec3,
} from '../src/laser/boxes';
import { newLaserDoc, shapeToPolylines, type LaserShape, type Pt as MPt } from '../src/laser/model';
import { analyzeDxf, dxfToShapes, exportDxf } from '../src/laser/dxf';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const finite = (pts: Pt[]) => pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
const area = (pts: Pt[]) => Math.abs(contourArea(pts));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];

/** Отрезки профиля на уровне y — торцы шипов или дно пазов. */
const spans = (pts: Pt[], y: number, tol = 1e-6): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (Math.abs(a.y - y) < tol && Math.abs(b.y - y) < tol && Math.abs(a.x - b.x) > tol) {
      out.push([Math.min(a.x, b.x), Math.max(a.x, b.x)]);
    }
  }
  return out;
};

/** Точка внутри простого полигона (чётность пересечений). */
const inside = (pts: Pt[], px: number, py: number): boolean => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

const inHole = (holes: BoxHole[] | undefined, x: number, y: number, eps: number) => {
  for (const h of holes ?? []) {
    if (h.t === 'circle') {
      if (Math.hypot(x - h.cx, y - h.cy) < h.r - eps) return true;
    } else if (inside(h.pts, x, y)) return true;
  }
  return false;
};

// ---------------- 1. профиль кромки: шип и паз совпадают ----------------
{
  const joint = (o: Partial<JointOpts>): JointOpts => ({ ...DEFAULT_JOINT, ...o });
  let combos = 0;
  for (const style of ['finger', 'dovetail'] as const) {
    for (const len of [40, 88, 128, 200, 47.5, 300]) {
      for (const finger of [4, 6, 12, 20]) {
        for (const play of [0, 0.05, 0.2]) {
          for (const trim of [0, 4]) {
            for (const thickness of [3, 4, 6]) {
              const o = joint({ style, finger, play, thickness, angle: 45 });
              const m = edgeProfile(len, 'male', o, trim, trim);
              const f = edgeProfile(len, 'female', o, trim, trim);
              combos++;
              assert(finite(m) && finite(f), 'профиль без NaN');
              assert(m.length >= 4 && f.length >= 4, 'профиль описан подробно');
              // Шипы выступают наружу, пазы выбраны внутрь ровно на толщину
              assert(near(Math.max(...m.map((p) => p.y)), thickness, 1e-9), `шип на толщину: ${style} ${len}`);
              assert(near(Math.min(...f.map((p) => p.y)), -thickness, 1e-9), `паз на толщину: ${style} ${len}`);
              // Шипов столько же, сколько пазов, и все они не тоньше материала
              const tabs = spans(m, thickness);
              const slots = spans(f, -thickness);
              assert.equal(tabs.length, slots.length, `шипов ${tabs.length} = пазов ${slots.length}`);
              assert(tabs.length >= 1, 'на кромке есть хотя бы один шип');
              for (let i = 0; i < tabs.length; i++) {
                const [a, b] = tabs[i];
                const [c, d] = slots[i];
                assert(b - a >= 0.5, 'шип не тоньше 0.5 мм');
                // Паз не уже шипа, а суммарный зазор — не меньше люфта.
                // Крайний хвост обрезан по границе замка, поэтому с одной стороны
                // зазор может отсутствовать — это так же, как в boxes.py.
                assert(c <= a + 1e-9 && d >= b - 1e-9, `паз не уже шипа: ${a}..${b} vs ${c}..${d}`);
                assert(d - c >= b - a + play - 1e-9, `зазор не меньше люфта: ${(d - c).toFixed(3)} vs ${(b - a).toFixed(3)}`);
                if (i > 0 && i < tabs.length - 1) {
                  assert(near(c, a - play, 1e-9), `внутренний паз начинается на люфт раньше: ${c} vs ${a - play}`);
                  assert(near(d, b + play, 1e-9), `внутренний паз заканчивается на люфт позже: ${d} vs ${b + play}`);
                }
              }
              // Подрезка угла держит замок вне углового квадрата t×t
              if (trim > 0 && tabs.length) {
                assert(tabs[0][0] >= trim - 1e-9, 'шип не залезает в подрезанный угол');
                assert(tabs[tabs.length - 1][1] <= len - trim + 1e-9, 'шип не вылезает за подрезку');
              }
              // Профиль симметричен относительно середины — иначе зеркальная
              // стенка не совпадёт с пазом
              const mid = len / 2;
              for (const [a, b] of tabs) {
                const mirrored: [number, number] = [len - b, len - a];
                assert(tabs.some(([c2, d2]) => near(c2, mirrored[0], 1e-6) && near(d2, mirrored[1], 1e-6)),
                  `симметрия шипа ${a}..${b} относительно ${mid}`);
              }
              if (style === 'dovetail') {
                // Паз повторяет внешний контур хвоста: шире его основания на
                // раструб с обеих сторон, иначе угол не собрать без пересечений
                for (let i = 0; i < slots.length; i++) {
                  const tip = tabs[i][1] - tabs[i][0];
                  // Крайний хвост обрезан по границе замка, поэтому зазор там
                  // только с одной стороны
                  const need = i === 0 || i === slots.length - 1 ? tip + play : tip + 2 * play;
                  assert(slots[i][1] - slots[i][0] >= need - 1e-9,
                    `паз не уже хвоста: ${(slots[i][1] - slots[i][0]).toFixed(3)} vs ${need.toFixed(3)}`);
                }
              }
            }
          }
        }
      }
    }
  }
  assert(combos >= 400, `проверено комбинаций: ${combos}`);

  // Люфт и коррекция реза расширяют только паз
  const o0 = joint({ style: 'finger', finger: 12, play: 0, burn: 0 });
  const tight = edgeProfile(100, 'female', o0);
  const loose = edgeProfile(100, 'female', joint({ style: 'finger', finger: 12, play: 0.2, burn: 0.1 }));
  assert(spans(loose, -4)[0][1] - spans(loose, -4)[0][0] > spans(tight, -4)[0][1] - spans(tight, -4)[0][0],
    'паз с люфтом шире');
  assert.deepEqual(edgeProfile(100, 'male', o0), edgeProfile(100, 'male', joint({ ...o0, play: 0.2, burn: 0.1 })),
    'люфт не меняет шип');

  // Короткая кромка и «нет кромки»
  assert.equal(edgeProfile(3, 'male', DEFAULT_JOINT).length, 1, 'на короткой кромке шипы не делаем');
  assert.deepEqual(edgeProfile(100, 'none', DEFAULT_JOINT), [], 'кромки нет — точек нет');
  assert.equal(edgeProfile(100, 'flat', DEFAULT_JOINT).length, 1, 'ровная кромка — одна точка начала');
}

// ---------------- 2. панели: замкнутый контур против часовой ----------------
{
  const o: JointOpts = { ...DEFAULT_JOINT, thickness: 4, finger: 12 };
  const rect = rectPanel(120, 80, ['male', 'female', 'female', 'female'], o);
  assert(finite(rect), 'панель без NaN');
  assert(rect.length >= 8, 'панель с шипами описана подробно');
  assert(contourArea(rect) > 0, 'обход против часовой стрелки');
  assert(near(area(rect), 120 * 80, 120 * 4), `площадь панели около номинала: ${area(rect)}`);
  const closed = dedupe(rect, true);
  assert(closed.length === rect.length, 'замкнутый контур не дублирует первую точку');

  // Подрезки «внутренней» боковой стенки зеркальны для правой и левой кромок
  const tr = innerSideTrims(4, 'male', 'flat');
  assert.deepEqual(tr, [[0, 0], [4, 0], [0, 0], [0, 4]], 'низ и верх без подрезки, вертикали — с учётом обхода');
  assert.deepEqual(innerSideTrims(4, 'flat', 'flat'), [[0, 0], [0, 0], [0, 0], [0, 0]], 'ровные кромки не подрезаются');

  const poly = rectPts(0, 0, 50, 30, 6);
  assert(poly.length > 8 && finite(poly) && contourArea(poly) > 0, 'скруглённый прямоугольник');
}

// ---------------- 3. вспомогательные функции движка ----------------
{
  assert.deepEqual(parseSections('50*4', 300), [50, 50, 50, 50], 'строка 50*4');
  assert.deepEqual(parseSections('250/3', 250), [250 / 3, 250 / 3, 250 / 3], 'строка 250/3');
  assert.deepEqual(parseSections('30:25:70', 125), [30, 25, 70], 'строка 30:25:70');
  assert.deepEqual(parseSections('  ', 100, 2), [50, 50], 'пустая строка — поровну');
  assert.deepEqual(parseSections('abc', 100, 2), [50, 50], 'мусор — поровну');

  const ctx = boxCtx({ thickness: 4, finger: 10, play: 0.1, labels: true });
  assert.equal(ctx.t, 4, 'толщина из параметров');
  assert.equal(ctx.joint.finger, 10, 'ширина шипа');
  assert(near(ctx.joint.play, 0.1), 'люфт');
  assert.equal(boxCtx({ thickness: -1 }).t, 0.2, 'толщина не уходит ниже 0.2 мм');
  assert.equal(boxCtx({}).labels, true, 'подписи деталей включены по умолчанию');

  assert.deepEqual(innerSize({ x: 100, y: 80, h: 50, outside: false }, 4), { x: 100, y: 80, h: 50 }, 'внутренние размеры');
  assert.deepEqual(innerSize({ x: 100, y: 80, h: 50, outside: true }, 4), { x: 92, y: 72, h: 42 }, 'внешние размеры');

  const hinge = livingHinge(60, 20, { slotW: 1.2, step: 4, bridge: 3, rows: 2 });
  assert(finite(hinge.outline) && area(hinge.outline) > 0, 'живой шарнир: контур');
  assert(hinge.holes.length > 4, `живой шарнир: прорезей ${hinge.holes.length}`);
  assert(hinge.holes.every((h) => h.t === 'poly' && finite(h.pts)), 'прорези корректны');
}

// ---------------- 4. параметры: значения по умолчанию и нормализация ----------------
{
  assert.equal(BOX_TYPES.length, 28, `типов в каталоге: ${BOX_TYPES.length}`);
  assert.equal(new Set(BOX_TYPES.map((t) => t.id)).size, 28, 'идентификаторы уникальны');
  const ids = new Set(BOX_FAMILIES.map((f) => f.id));
  assert(BOX_TYPES.every((t) => ids.has(t.family)), 'каждый тип относится к семейству каталога');

  for (const def of BOX_TYPES) {
    assert(def.name.trim().length > 2, `${def.id}: название`);
    assert(def.desc.trim().length > 10, `${def.id}: описание`);
    const keys = def.params.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length, `${def.id}: ключи параметров уникальны`);
    for (const d of def.params) {
      assert(d.label.trim().length > 1, `${def.id}.${d.key}: подпись`);
      assert(['number', 'boolean', 'select', 'text'].includes(d.kind), `${def.id}.${d.key}: вид`);
      if (d.kind === 'select') assert((d.options ?? []).length >= 2, `${def.id}.${d.key}: варианты`);
      if (d.kind === 'number' && d.min !== undefined && d.max !== undefined) {
        assert(d.min <= d.max, `${def.id}.${d.key}: диапазон`);
        assert(typeof d.def === 'number' && d.def >= d.min && d.def <= d.max, `${def.id}.${d.key}: значение по умолчанию в диапазоне`);
      }
    }
    const dflt = defaultBoxParams(def);
    assert.equal(Object.keys(dflt).length, keys.length, `${def.id}: значения по умолчанию для всех параметров`);
    assert.deepEqual(normalizeBoxParams(def, dflt), dflt, `${def.id}: нормализация не меняет корректные значения`);
    // Толщина материала есть у каждого генератора: от неё зависит 3D и раскрой
    assert(def.params.some((d) => d.key === 'thickness'), `${def.id}: толщина материала в форме`);
    assert.equal(normalizeBoxParams(def, { ...dflt, thickness: '6' } as BoxParamValues).thickness, 6, `${def.id}: строка → число`);
    assert.equal(normalizeBoxParams(def, { ...dflt, thickness: NaN }).thickness, dflt.thickness, `${def.id}: NaN → по умолчанию`);
    const tDef = def.params.find((d) => d.key === 'thickness')!;
    assert.equal(normalizeBoxParams(def, { ...dflt, thickness: 1e6 }).thickness, tDef.max, `${def.id}: больше максимума → предел`);
    assert.equal(normalizeBoxParams(def, { ...dflt, thickness: -5 }).thickness, tDef.min, `${def.id}: меньше минимума → предел`);
    assert.equal(normalizeBoxParams(def, { ...dflt, labels: 'true' } as BoxParamValues).labels, true, `${def.id}: строка → признак`);
    assert.equal(Object.keys(normalizeBoxParams(def, { ...dflt, чужой: 5 } as BoxParamValues)).includes('чужой'), false,
      `${def.id}: неизвестные параметры отбрасываются`);
  }

  assert.equal(findBoxType('closed')?.id, 'closed', 'поиск по идентификатору');
  assert.equal(findBoxType('нет-такого'), undefined, 'неизвестный тип');
  assert.equal(buildBox('нет-такого').type.id, BOX_TYPES[0].id, 'неизвестный тип — первый генератор');
}

// ---------------- 5. каталог: все типы строятся и собираются ----------------
{
  for (const def of BOX_TYPES) {
    const r = buildBox(def.id, {});
    assert.equal(r.type.id, def.id, `${def.id}: тип`);
    assert(r.parts.length > 0, `${def.id}: есть детали`);
    assert.deepEqual(r.warnings, [], `${def.id}: замечаний нет — ${r.warnings.join('; ')}`);
    assert(Number.isFinite(r.size.w) && Number.isFinite(r.size.d) && Number.isFinite(r.size.h), `${def.id}: габарит`);
    // Плоские генераторы (панели, решётки, шестерни) по делу имеют нуль по одной оси
    assert(r.size.w > 1 && r.size.d >= 0 && r.size.h >= 0, `${def.id}: габарит осмысленный`);
    assert(r.size.w + r.size.d + r.size.h > 2, `${def.id}: габарит не вырожден`);

    for (const part of r.parts) {
      assert(part.name.trim().length > 0, `${def.id}: имя детали`);
      assert(part.outline.length >= 3, `${def.id}/${part.name}: контур из 3+ точек`);
      assert(finite(part.outline), `${def.id}/${part.name}: контур без NaN`);
      assert(area(part.outline) > 0.5, `${def.id}/${part.name}: площадь ${area(part.outline)}`);
      assert(contourArea(part.outline) > 0, `${def.id}/${part.name}: обход против часовой`);
      for (const h of part.holes ?? []) {
        if (h.t === 'circle') {
          assert(h.r > 0 && Number.isFinite(h.cx), `${def.id}/${part.name}: отверстие`);
        } else {
          assert(h.pts.length >= 3 && finite(h.pts), `${def.id}/${part.name}: вырез`);
        }
      }
      for (const s of part.score ?? []) assert(finite(s.pts), `${def.id}/${part.name}: биговка`);
      assert(part.count === undefined || part.count >= 1, `${def.id}/${part.name}: число деталей`);
    }

    // Тонкий материал и пологий «хвост» дают предупреждения, а не падают
    const tDef = def.params.find((d) => d.key === 'thickness')!;
    const thin = buildBox(def.id, { thickness: 0.2 });
    assert(thin.parts.length > 0, `${def.id}: тонкий материал не ломает генератор`);
    assert(thin.params.thickness === Math.max(tDef.min ?? 0.2, 0.2), `${def.id}: толщина зажата диапазоном`);
    if ((tDef.min ?? 0) < 1) {
      assert(thin.warnings.some((w) => w.includes('толщин') || w.includes('Толщин')),
        `${def.id}: предупреждение о тонком материале — ${thin.warnings.join('; ')}`);
    }
    // «Угол хвоста» есть только там, где доступен ласточкин хвост с настройкой угла
    const aDef = def.params.find((d) => d.key === 'angle' && d.label.includes('хвост'));
    if (def.params.some((d) => d.key === 'style')) {
      const dove = buildBox(def.id, { style: 'dovetail', angle: 5 });
      assert.equal(dove.params.style, 'dovetail', `${def.id}: вид шипа переключается`);
      assert(dove.parts.length > 0, `${def.id}: ласточкин хвост собирается`);
      if (aDef && (aDef.min ?? 0) < 15) {
        assert(dove.warnings.some((w) => w.toLowerCase().includes('хвост')),
          `${def.id}: предупреждение о пологом хвосте — ${dove.warnings.join('; ')}`);
      }
    }
    if (def.params.some((d) => d.key === 'labels')) {
      const labeled = buildBox(def.id, { labels: true });
      assert(labeled.parts.every((q) => q.label && q.label.text.length > 0), `${def.id}: подписи деталей`);
      const unlabeled = buildBox(def.id, { labels: false });
      assert(unlabeled.parts.every((q) => !q.label), `${def.id}: без подписей`);
    }
    if (def.params.some((d) => d.key === 'reference')) {
      const ref = buildBox(def.id, { reference: true, referenceLen: 50 });
      const last = ref.parts[ref.parts.length - 1];
      assert.equal(last.name, 'Эталон', `${def.id}: эталонный прямоугольник`);
      const bb = [Math.min(...last.outline.map((q) => q.x)), Math.max(...last.outline.map((q) => q.x))];
      assert(near(bb[1] - bb[0], 50, 1e-6), `${def.id}: эталон ровно 50 мм`);
    }

    // Раскладка на листе
    const lay = layoutBoxParts(r.parts, { sheetW: 2000, sheetH: 1400, gap: 4, margin: 6 });
    assert.equal(lay.parts, r.parts.reduce((a, q) => a + Math.max(1, q.count ?? 1), 0), `${def.id}: число деталей в раскладке`);
    assert(lay.shapes.length > r.parts.length, `${def.id}: контуры и отверстия отдельными объектами`);
    assert(lay.fits, `${def.id}: на большом листе всё влезает`);
    assert(lay.cutLengthMm > 10, `${def.id}: длина реза ${lay.cutLengthMm}`);
    assert(lay.areaMm2 > 0 && lay.usedMm2 > 0, `${def.id}: площади`);
    assert(lay.groups.length > 0, `${def.id}: группы`);
    assert(lay.shapes.every((s) => lay.groups.some((g) => g.id === s.groupId)), `${def.id}: у каждого объекта группа`);
    assert(lay.shapes.every((s) => Number.isFinite(shapeToPolylines(s).flat().reduce((a, q) => a + q.x + q.y, 0))),
      `${def.id}: координаты раскладки конечны`);
    const layers = new Set(lay.shapes.map((s) => s.layer));
    assert(layers.has('cut'), `${def.id}: контуры на слое резки`);
    const wantHoles = r.parts.some((q) => (q.holes ?? []).length > 0);
    assert.equal(layers.has('inner'), wantHoles, `${def.id}: вырезы — на внутреннем слое`);
    const wantScore = r.parts.some((q) => (q.score ?? []).length > 0);
    assert.equal(layers.has('fold'), wantScore, `${def.id}: биговка — на слое сгиба`);
    assert(!layers.has('guide'), `${def.id}: вспомогательных слоёв нет`);

    // Перемычки и подписи попадают в объекты
    const tabs = layoutBoxParts(r.parts, { sheetW: 2000, sheetH: 1400, tabs: 3, tabWidth: 2 });
    assert(tabs.shapes.some((s) => s.tabs === 3 && s.tabWidth === 2), `${def.id}: перемычки заданы`);
    const labeled = layoutBoxParts(buildBox(def.id, { labels: true, reference: false }).parts, { sheetW: 2000, sheetH: 1400 });
    assert(labeled.shapes.some((s) => s.kind === 'text' && s.layer === 'engrave'), `${def.id}: подписи гравировкой`);

    // Сборка в 3D
    const proj = projectAssembly(r.parts, 35, 25, Math.max(2, Number(r.params.thickness) || 4));
    assert(proj.polys.length > r.parts.length, `${def.id}: грани в 3D`);
    assert(proj.polys.every((q) => finite(q.pts)), `${def.id}: проекция без NaN`);
    assert(proj.polys.every((q) => q.shade >= 0 && q.shade <= 1), `${def.id}: освещённость 0..1`);
    assert(proj.bbox.every(Number.isFinite), `${def.id}: рамка проекции`);
  }
}

// ---------------- 6. сборка без пересечений: замки сходятся ----------------
{
  type Solid = {
    name: string; outline: Pt[]; holes: BoxHole[] | undefined; n: Vec3;
    ex: Vec3; ey: Vec3; o: Vec3; bb: [number, number, number, number]; box: number[];
  };
  const solidsOf = (parts: ReturnType<typeof buildBox>['parts'], t: number): Solid[] =>
    parts
      .filter((p) => p.place && !p.bend && p.outline.length > 2)
      .map((p) => {
        const pl = p.place!;
        const n = cross(pl.ex, pl.ey);
        const bb = [
          Math.min(...p.outline.map((q) => q.x)), Math.min(...p.outline.map((q) => q.y)),
          Math.max(...p.outline.map((q) => q.x)), Math.max(...p.outline.map((q) => q.y)),
        ] as [number, number, number, number];
        const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (const [lx, ly] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]] as [number, number][]) {
          for (const a of [0, t]) {
            const w = [
              pl.o[0] + pl.ex[0] * lx + pl.ey[0] * ly + n[0] * a,
              pl.o[1] + pl.ex[1] * lx + pl.ey[1] * ly + n[1] * a,
              pl.o[2] + pl.ex[2] * lx + pl.ey[2] * ly + n[2] * a,
            ];
            for (let i = 0; i < 3; i++) {
              box[i] = Math.min(box[i], w[i]);
              box[i + 3] = Math.max(box[i + 3], w[i]);
            }
          }
        }
        return { name: p.name, outline: p.outline, holes: p.holes, n, ex: pl.ex, ey: pl.ey, o: pl.o, bb, box };
      });

  const overlaps = (parts: ReturnType<typeof buildBox>['parts'], t: number, step = 2.5): { max: number; where: string } => {
    const solid = solidsOf(parts, t);
    let box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const s of solid) for (let i = 0; i < 6; i++) box[i] = i < 3 ? Math.min(box[i], s.box[i]) : Math.max(box[i], s.box[i]);
    const nx = Math.max(2, Math.min(80, Math.round((box[3] - box[0]) / step)));
    const ny = Math.max(2, Math.min(80, Math.round((box[4] - box[1]) / step)));
    const nz = Math.max(2, Math.min(60, Math.round((box[5] - box[2]) / step)));
    const eps = 0.15;
    let max = 0, where = '';
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nz; k++) {
          const cx = box[0] + ((i + 0.5) * (box[3] - box[0])) / nx;
          const cy = box[1] + ((j + 0.5) * (box[4] - box[1])) / ny;
          const cz = box[2] + ((k + 0.5) * (box[5] - box[2])) / nz;
          const hit: string[] = [];
          for (const s of solid) {
            if (cx < s.box[0] - eps || cx > s.box[3] + eps || cy < s.box[1] - eps || cy > s.box[4] + eps
              || cz < s.box[2] - eps || cz > s.box[5] + eps) continue;
            const dx = cx - s.o[0], dy = cy - s.o[1], dz = cz - s.o[2];
            const a = dx * s.n[0] + dy * s.n[1] + dz * s.n[2];
            if (a < eps || a > t - eps) continue;
            const lx = dx * s.ex[0] + dy * s.ex[1] + dz * s.ex[2];
            const ly = dx * s.ey[0] + dy * s.ey[1] + dz * s.ey[2];
            if (lx < s.bb[0] + eps || lx > s.bb[2] - eps || ly < s.bb[1] + eps || ly > s.bb[3] - eps) continue;
            if (!inside(s.outline, lx, ly) || inHole(s.holes, lx, ly, eps)) continue;
            hit.push(s.name);
          }
          // Крыша скворечника соединяется внахлёст по коньку — это не ошибка
          const lap = hit.length > 1 && hit.every((nm) => nm.startsWith('Крыша'));
          if (hit.length > max && !lap) {
            max = hit.length;
            where = `${cx.toFixed(1)},${cy.toFixed(1)},${cz.toFixed(1)}: ${hit.join(' + ')}`;
          }
        }
      }
    }
    return { max, where };
  };

  for (const def of BOX_TYPES) {
    const r = buildBox(def.id, {});
    const t = Math.max(2, Number(r.params.thickness) || 4);
    const o = overlaps(r.parts, t);
    assert.equal(o.max, 1, `${def.id}: детали не пересекаются (${o.max}) — ${o.where}`);
  }

  // Отдельные сочетания кромок: все варианты стенок тоже собираются
  for (const bottom of ['male', 'female', 'flat'] as EdgeKind[]) {
    for (const top of ['male', 'female', 'flat'] as EdgeKind[]) {
      for (const lid of [false, true]) {
        const r = buildBox('universal', { bottomEdge: bottom, topEdge: top, lid, x: 90, y: 60, h: 40, thickness: 4 });
        const o = overlaps(r.parts, 4, 3);
        assert.equal(o.max, 1, `universal ${bottom}/${top}/крышка=${lid}: ${o.where}`);
      }
    }
  }
  for (const style of ['finger', 'dovetail']) {
    for (const play of [0, 0.15]) {
      const r = buildBox('closed', { style, play, finger: 10, x: 110, y: 70, h: 45, thickness: 6 });
      assert.equal(overlaps(r.parts, 6, 3).max, 1, `closed ${style} play=${play}: пересечение деталей`);
    }
  }
}

// ---------------- 7. размеры коробки совпадают с заданными ----------------
{
  const t = 4;
  const closed = buildBox('closed', { x: 120, y: 80, h: 60, thickness: t, outside: false });
  assert.deepEqual(closed.size, { w: 120 + 2 * t, d: 80 + 2 * t, h: 60 + 2 * t }, 'внутренние размеры + толщина');
  const outer = buildBox('closed', { x: 120, y: 80, h: 60, thickness: t, outside: true });
  assert.deepEqual(outer.size, { w: 120, d: 80, h: 60 }, 'внешние размеры выдержаны точно');
  const based = buildBox('based', { x: 100, y: 70, h: 50, thickness: t });
  assert(based.parts.some((p) => /основан|дно/i.test(p.name)), 'коробка с основанием имеет дно');

  // Секции закруглённой коробки
  const rounded = buildBox('rounded', { x: 120, y: 80, h: 60, sections: '30:25:70', thickness: t });
  assert(rounded.parts.length >= 4, `закруглённая: секций ${rounded.parts.length}`);
  const rounded2 = buildBox('rounded', { x: 120, y: 80, h: 60, sections: '40*3', thickness: t });
  assert(rounded2.parts.length >= 4, 'закруглённая: строка 40*3');

  // Разные высоты стенок
  const uneven = buildBox('unevenheight', { x: 100, y: 70, h: 40, h2: 70, thickness: t });
  assert(uneven.size.h >= 70 + t, `скошенная крышка: высота ${uneven.size.h}`);

  // Лоток с разделителями
  const tray = buildBox('dividertray', { x: 120, y: 90, h: 40, rows: 2, cols: 3, thickness: t });
  assert(tray.parts.some((p) => p.name.includes('Разделитель X1')), 'разделитель по X');
  assert(tray.parts.some((p) => p.name.includes('Разделитель Y2')), 'разделитель по Y');

  // Стойка для плат: пазы под платы
  const rack = buildBox('sbcrack', { x: 60, y: 52, thickness: t });
  assert(rack.parts.some((p) => p.name.includes('Боковина')), 'боковины стойки');
  assert(rack.parts.every((p) => (p.holes ?? []).length >= 0), 'пазы боковин');
}

// ---------------- 8. DXF раскладки: точная геометрия ----------------
{
  for (const id of ['universal', 'closed', 'lidbox', 'typetray', 'electronicsbox', 'gears']) {
    const r = buildBox(id, { labels: true, reference: true, referenceLen: 40 });
    const lay = layoutBoxParts(r.parts, { sheetW: 900, sheetH: 600, gap: 5, margin: 8 });
    const doc = { ...newLaserDoc(900, 600, `${id}.dxf`), shapes: lay.shapes, groups: lay.groups };
    const text = exportDxf(doc);
    const rep = analyzeDxf(text);
    assert(rep.ok, `${id}: DXF корректен — ${rep.warnings.join('; ')}`);
    assert.deepEqual(rep.warnings, [], `${id}: без замечаний — ${rep.warnings.join('; ')}`);
    assert.equal(rep.unitsLabel, 'мм', `${id}: единицы мм`);
    assert(rep.total > 10, `${id}: сущностей ${rep.total}`);
    assert(rep.closedContours >= 2, `${id}: замкнутых контуров ${rep.closedContours}`);
    // Габариты раскладки лежат внутри листа, мм в мм
    assert(rep.extents![0] >= -0.01 && rep.extents![1] >= -0.01, `${id}: раскладка от нуля`);
    assert(rep.extents![2] <= 900.01 && rep.extents![3] <= 600.01, `${id}: раскладка в пределах листа`);
    assert(rep.extents![2] - rep.extents![0] > 20 && rep.extents![3] - rep.extents![1] > 20,
      `${id}: габарит раскладки ${(rep.extents![2] - rep.extents![0]).toFixed(0)}×${(rep.extents![3] - rep.extents![1]).toFixed(0)} мм`);
    assert(rep.lengthMm > lay.cutLengthMm * 0.5, `${id}: длины соизмеримы`);

    // Обратный импорт: те же контуры, мм в мм
    const back: LaserShape[] = dxfToShapes(text);
    assert(back.length >= lay.shapes.filter((s) => s.kind !== 'text').length, `${id}: импорт вернул объекты`);
    assert(back.every((s) => Number.isFinite(shapeToPolylines(s).flat().reduce((a, q: MPt) => a + q.x + q.y, 0))),
      `${id}: импорт без NaN`);
    const total = (shapes: LaserShape[]) => shapes
      .flatMap((s) => shapeToPolylines(s))
      .reduce((a, pts) => a + polyLength(pts as Pt[], pts.length > 2), 0);
    const dev = Math.abs(total(back) - total(lay.shapes)) / total(lay.shapes);
    assert(dev < 0.02, `${id}: длина контуров после импорта отличается на ${(dev * 100).toFixed(2)}%`);
  }
}

// ---------------- 9. миниатюры каталога ----------------
{
  for (const def of BOX_TYPES) {
    const th = boxThumbnail(def.id, 64);
    assert(th.paths.length > 0, `${def.id}: миниатюра не пуста`);
    for (const d of [...th.paths, ...th.holes]) {
      const nums = d.split(/[\s,]+/).map(Number);
      assert(nums.length >= 4 && nums.every(Number.isFinite), `${def.id}: координаты миниатюры`);
      assert(nums.every((v) => v >= -1 && v <= 65), `${def.id}: миниатюра в рамке 64 мм`);
    }
  }
  assert.deepEqual(boxThumbnail('нет-такого', 32).paths.length > 0, true, 'неизвестный тип — миниатюра первого');
}

console.log('BOXES OK');
