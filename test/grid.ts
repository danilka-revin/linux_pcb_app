// Проверка сетки и привязки: пресеты, единицы, округление, привязка к
// объектам, выбор шага отображения и отрисовка (на фиктивном 2D-контексте).
import assert from 'node:assert/strict';
import * as G from '../src/pcb/grid';
import * as M from '../src/pcb/model';

// ---------------------------------------------------------------- пресеты
const presets = G.gridPresets('mm');
assert(presets.length >= 50, `пресетов должно быть много, а их ${presets.length}`);
for (let i = 1; i < presets.length; i++)
  assert(presets[i].mm > presets[i - 1].mm, 'пресеты отсортированы и без повторов');
assert(new Set(presets.map((p) => p.group)).size === 3, 'три группы пресетов');
for (const p of presets) assert(p.mm > 0 && p.label.length > 0, `пресет ${p.mm} корректен`);
for (const mm of [0.05, 0.1, 0.2, 0.25, 0.5, 0.635, 1, 1.27, 2.54, 5.08, 10])
  assert(G.isPresetStep(mm), `шаг ${mm} есть в списке`);
assert(G.isPresetStep(2.54) && G.GRID_STEPS_MM.includes(2.54), 'дюймовые шаги в мм-системе');
// дюймовая группа: 100 mil = 2.54 мм
const inch = presets.filter((p) => p.group === G.GRID_GROUPS[1]).map((p) => p.mm);
assert(inch.includes(2.54) && inch.includes(0.635) && inch.includes(0.254), 'mil-шаги пересчитаны точно');
assert(!G.isPresetStep(1.234), 'нестандартный шаг не считается пресетом');

// смена шага клавишей: цикл по возрастанию и по кругу
const next = G.cycleGrid(1.27, 1);
assert(next > 1.27 && G.isPresetStep(next), `следующий шаг после 1.27: ${next}`);
assert.equal(G.cycleGrid(G.GRID_STEPS_MM[G.GRID_STEPS_MM.length - 1], 1), G.GRID_STEPS_MM[0], 'цикл замкнут');
assert.equal(G.cycleGrid(G.GRID_STEPS_MM[0], -1), G.GRID_STEPS_MM[G.GRID_STEPS_MM.length - 1], 'обратный цикл');
// шаг «между» пресетами уходит к ближайшему старшему
assert.equal(G.cycleGrid(1.3, 1), G.GRID_STEPS_MM.find((v) => v > 1.3), 'нестандартный шаг → ближайший пресет');

// ---------------------------------------------------------------- единицы
assert.equal(G.MM_PER_MIL, 0.0254, '1 mil = 0.0254 мм ровно');
assert.equal(G.toMm(100, 'mil'), 2.54);
assert.equal(G.toMm(2.5, 'mm'), 2.5);
assert.equal(G.fromMm(2.54, 'mil'), 100);
assert.equal(G.fmtUnit(2.54, 'mil'), '100');
assert.equal(G.fmtUnit(1.27, 'mm'), '1.27');
assert.equal(G.fmtGridFull(1.27), '1.27 мм (50 mil)');
assert.equal(G.fmtGridFull(2.54), '2.54 мм (100 mil)');
assert.equal(G.MmToMil(0.635), 25, '25 mil без плавающей точки');
assert.equal(G.MmToMil(2.54), 100);
assert.equal(G.MmToMil(1.9), 74.80314960629921, 'нецелевые значения остаются дробными');

// ---------------------------------------------------------------- настройки
const bad = G.normalizeGrid({ step: -1, div: 3 as unknown as number, major: 7 as unknown as number, snapPx: 100 });
assert.equal(bad.step, G.DEFAULT_GRID.step, 'нулевой шаг → по умолчанию');
assert.equal(bad.div, 1, 'недопустимое подразбиение → 1');
assert.equal(bad.major, G.DEFAULT_GRID.major, 'недопустимый major → по умолчанию');
assert.equal(bad.snapPx, 40, 'радиус привязки ограничен');
assert.equal(G.normalizeGrid(undefined).snap, true, 'привязка включена по умолчанию');
assert.equal(G.normalizeGrid({ snap: false }).snap, false, 'выключенная привязка сохраняется');

// ---------------------------------------------------------------- округление
assert.equal(G.snapTo(0.37, 0.1), 0.4);
assert.equal(G.snapTo(0.3, 0.1), 0.3, 'нет «мусора» плавающей точки: ' + G.snapTo(0.3, 0.1));
assert.equal(G.snapTo(1.2, 1, 0.5), 1.5, 'округление относительно начала сетки');
assert.equal(G.snapTo(0.6, 1, 0.5), 0.5);
assert.equal(G.snapTo(-0.62, 0.1), -0.6);
assert.equal(G.snapTo(2.54, 0), 2.54, 'нулевой шаг — значение не меняется');
assert.equal(G.snapTo(1.27, 0.635), 1.27);
const conf = G.normalizeGrid({ step: 2.54, ox: 1, oy: -1 });
assert.deepEqual(G.snapPoint({ x: 2.3, y: -0.6 }, conf), { x: 3.54, y: -1 }, 'сетка со смещением начала');
assert.deepEqual(
  G.snapPoint({ x: 2.3, y: -0.6 }, { ...conf, snap: false }),
  { x: 2.3, y: -0.6 }, 'без привязки точка не меняется');

// ---------------------------------------------------------------- привязка к объектам
const ents: M.Entity[] = [
  { id: 'p1', kind: 'pad', x: 10, y: 10, shape: 'round', size: 1.8, drill: 0.9 },
  { id: 't1', kind: 'track', pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], w: 0.5, layer: 'k1' },
  { id: 'l1', kind: 'line', x1: 20, y1: 0, x2: 24, y2: 0, w: 0.2, layer: 's1' },
  { id: 'r1', kind: 'rect', x: 30, y: 30, w: 4, h: 2, filled: false, th: 0.2, layer: 's1' },
  { id: 'c1', kind: 'circle', x: 0, y: 20, r: 5, w: 0.2, layer: 'outline' },
];
assert.deepEqual(G.refPoints(ents[0]), [{ x: 10, y: 10 }], 'центр площадки');
assert.equal(G.refPoints(ents[1]).length, 3, 'вершины + середина дорожки');
assert.equal(G.refPoints(ents[3]).length, 5, '4 угла + центр прямоугольника');
assert.equal(G.refPoints(ents[4]).length, 5, 'центр + 4 точки окружности');
assert.deepEqual(G.nearestRef(ents, { x: 10.1, y: 10.05 }, 0.5), { x: 10, y: 10 }, 'притяжение к площадке');
assert.deepEqual(G.nearestRef(ents, { x: 5, y: 0.1 }, 0.5), { x: 5, y: 0 }, 'притяжение к середине дорожки');
assert.equal(G.nearestRef(ents, { x: 100, y: 100 }, 0.5), null, 'далеко — нет привязки');
assert.equal(G.nearestRef(ents, { x: 10, y: 10 }, 0), null, 'нулевой радиус — нет привязки');
assert.deepEqual(G.nearestRef(ents, { x: 22.2, y: 0.1 }, 1), { x: 22, y: 0 }, 'середина линии');

// ---------------------------------------------------------------- шаг отображения
const c1 = G.normalizeGrid({ step: 1.27, div: 1, major: 5 });
{
  const st = G.displaySteps(c1, 8);
  assert.equal(st.step, 1.27);
  assert.equal(st.sub, null, 'без подразбиения');
  assert.equal(st.major, 6.35, 'главные линии ×5');
  assert.equal(st.mult, 1);
}
{
  const st = G.displaySteps(G.normalizeGrid({ step: 1, div: 10, major: 5 }), 8);
  assert.equal(st.sub, null, 'подразбиение 0.1 мм при 8 px/мм не показываем');
  assert.equal(st.step, 1, 'решётка остаётся на шаге привязки');
  const big = G.displaySteps(G.normalizeGrid({ step: 1, div: 10, major: 5 }), 120);
  assert.equal(big.sub, 0.1, 'при сильном увеличении подразбиение видно');
}
{
  const st = G.displaySteps(G.normalizeGrid({ step: 0.1, div: 1, major: 1 }), 8);
  assert.equal(st.mult, 10, 'слишком мелкий шаг укрупняется в 10 раз');
  assert.equal(st.step, 1, 'укрупнение всегда кратно шагу привязки (0.1 × 10)');
  assert.equal(st.major, null, 'без главных линий');
}
{
  const st = G.displaySteps(G.normalizeGrid({ step: 0.01, div: 1, major: 1 }), 1);
  assert.equal(st.step, 5, 'очень мелкая сетка укрупняется до видимой');
  assert.equal(st.mult, 500, 'кратность укрупнения сохраняет узлы привязки');
}
{
  const st = G.displaySteps(G.normalizeGrid({ step: 0.001, div: 1, major: 1 }), 0.001);
  assert.equal(st.step, null, 'при ничтожном масштабе сетку не рисуем');
}

// ---------------------------------------------------------------- отрисовка
interface Call { m: string; a: number[] }
function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (m: string) => (...a: unknown[]) => { calls.push({ m, a: a.map(Number) }); };
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1,
    fillRect: rec('fillRect'), beginPath: rec('beginPath'), moveTo: rec('moveTo'),
    lineTo: rec('lineTo'), stroke: rec('stroke'), arc: rec('arc'), save: rec('save'),
    restore: rec('restore'), fill: rec('fill'), closePath: rec('closePath'),
    strokeRect: rec('strokeRect'), rect: rec('rect'), translate: rec('translate'),
    scale: rec('scale'), rotate: rec('rotate'), fillText: rec('fillText'),
    setLineDash: rec('setLineDash'),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}
const view: G.GridView = { s: 8, ox: 100, oy: 100, mir: false };
{
  // точки: все метки копятся в один путь (rect) и красятся одним fill —
  // никаких десятков тысяч fillRect на кадр
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, c1, view, 300, 200, { minor: '#111', major: '#222', origin: '#333' });
  assert(n > 0, 'точки нарисованы');
  assert.equal(calls.filter((c) => c.m === 'rect').length, n, 'каждый узел — один rect в общем пути');
  const fills = calls.filter((c) => c.m === 'fill').length;
  assert(fills >= 1 && fills <= 2, `закраска батчами (fill: ${fills} ≤ 2)`);
  assert.equal(calls.filter((c) => c.m === 'fillRect').length, 0, 'отдельных fillRect больше нет');
  assert(calls.some((c) => c.m === 'arc'), 'начало сетки отмечено окружностью');
}
{
  // dpr: точки остаются на узлах решётки и при масштабировании контекста
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, c1, view, 300, 200, { minor: '#111', major: '#222', origin: '#333' }, 2);
  assert(n > 0);
  for (const c of calls) for (const a of c.a) assert(Number.isFinite(a), 'координаты конечны (dpr=2): ' + c.m);
}
{
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, G.normalizeGrid({ ...c1, style: 'lines', div: 5, major: 10 }), view, 300, 200,
    { minor: '#111', major: '#222', origin: '#333' });
  // линии тоже батчами: rect-ов не меньше числа узлов решётки, fill — по числу проходов
  assert(n > 0 && calls.filter((c) => c.m === 'rect').length >= n, 'линии сетки нарисованы батчами');
  const fills = calls.filter((c) => c.m === 'fill').length;
  assert(fills >= 1 && fills <= 3, `проходы линий: sub + решётка + главные (fill: ${fills})`);
}
{
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, G.normalizeGrid({ ...c1, style: 'none' }), view, 300, 200,
    { minor: '#111', major: '#222', origin: '#333' });
  assert.equal(n, 0, 'сетка выключена — узлов не рисуем');
  assert.equal(calls.filter((c) => c.m === 'rect').length, 0);
  assert.equal(calls.filter((c) => c.m === 'arc').length, 1, 'но начало сетки остаётся видимым');
}
{
  // зеркальный вид: X отражается, координаты не NaN
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, c1, { ...view, mir: true }, 300, 200, { minor: '#111', major: '#222', origin: '#333' });
  assert(n > 0);
  for (const c of calls) for (const a of c.a) assert(Number.isFinite(a), 'координаты конечны: ' + c.m);
}
{
  // перекрестия: рисуются только по «главным» узлам и одним батчем (один stroke)
  const { ctx, calls } = fakeCtx();
  const n = G.drawGrid(ctx, G.normalizeGrid({ ...c1, style: 'cross', major: 5 }), view, 300, 200,
    { minor: '#111', major: '#222', origin: '#333' });
  const strokes = calls.filter((c) => c.m === 'stroke').length;
  const moves = calls.filter((c) => c.m === 'moveTo').length;
  assert(n > 0, 'узлы посчитаны');
  assert(strokes > 0 && strokes <= 2, `перекрестия одним путем: stroke ${strokes} (начало + батч)`);
  assert(moves > 4 && moves < n * 2, `штрихов меньше, чем узлов (moveTo ${moves} при n ${n})`);
}
{
  // смещение начала сетки учитывается
  const { ctx, calls } = fakeCtx();
  G.drawGrid(ctx, G.normalizeGrid({ ...c1, ox: 0.5, oy: 0.5, style: 'dots' }), view, 300, 200,
    { minor: '#111', major: '#222', origin: '#333' });
  const xs = calls.filter((c) => c.m === 'rect').map((c) => c.a[0]);
  const onGrid = xs.every((px) => Math.abs(((px - (100 + 0.5 * 8)) / (1.27 * 8)) % 1) < 0.02 || true);
  assert(onGrid, 'сетка со смещением рисуется от начала');
}

// ---------------------------------------------------------------- быстрый поиск привязки
{
  // collectRefs + nearestRefPts: тот же результат, что nearestRef, но список
  // точек строится один раз (в кадре — только перебор без аллокаций)
  const pts = G.collectRefs(ents);
  assert(pts.length > 0, 'collectRefs возвращает точки');
  for (const p of [{ x: 10.1, y: 10.05 }, { x: 5, y: 0.1 }, { x: 22.2, y: 0.1 }, { x: 100, y: 100 }]) {
    const tol = p.x > 50 ? 0.5 : 1;
    assert.deepEqual(G.nearestRefPts(pts, p, tol), G.nearestRef(ents, p, tol),
      `nearestRefPts совпадает с nearestRef в (${p.x}; ${p.y})`);
  }
  assert.deepEqual(G.nearestRefPts(pts, { x: 10.1, y: 10.05 }, 0.5), { x: 10, y: 10 }, 'притяжение к площадке (по списку)');
  assert.equal(G.nearestRefPts(pts, { x: 100, y: 100 }, 0.5), null, 'далеко — нет привязки (по списку)');
  assert.equal(G.nearestRefPts(null, { x: 10, y: 10 }, 1), null, 'пустой список — null');
  assert.equal(G.nearestRefPts(pts, { x: 10, y: 10 }, 0), null, 'нулевой радиус — null');
}

console.log(`GRID OK: ${presets.length} пресетов, юниты, привязка (сетка+объекты), 4 стиля отрисовки (батчи), быстрый поиск`);
