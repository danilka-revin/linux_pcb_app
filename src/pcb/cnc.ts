// Изоляционная фрезеровка платы и сверловка: самостоятельные программы G-code для GRBL.
// Геометрия считается в целых единицах 0,0001 мм. ВАЖНО: сначала объединяем медь,
// потом отступаем от неё на радиус инструмента + требуемый зазор. Обходить каждый
// примитив по отдельности нельзя: фреза прорежет соединение дорожки с площадкой.
import * as Clipper from 'clipper-lib';
import type { Doc, Entity, Pt } from './model';
import { expandDoc } from './expand';
import { textPolylines } from './strokefont';
import type { ZipFile } from './zip';
import { cncRange, validateCncSettings, type CncBoardAnalysis, type CncSettings, type CncSide } from './cnc-settings';
import { cncSchemesSvg } from './cnc-schemes';
export { DEFAULT_CNC_SETTINGS, validateCncSettings, type CncBoardAnalysis, type CncSettings } from './cnc-settings';

const SCALE = 10000;
const ARC_TOLERANCE = 0.005 * SCALE;
const MAX_POINTS = 250000;
const N = (x: number) => String(Number(x.toFixed(4)));
const mm = (x: number) => Math.round(x * SCALE);
const coord = (p: Pt): Clipper.IntPoint => ({ X: mm(p.x), Y: mm(p.y) });
const model = (p: Clipper.IntPoint): Pt => ({ x: p.X / SCALE, y: p.Y / SCALE });
const rounded = (n: number) => Math.round(n * 1000) / 1000;

export interface CncJob {
  files: ZipFile[];
  /** Координаты относительно угла платы (без припуска), вид сверху на обрабатываемую сторону. */
  preview: { top: Pt[][]; bottom: Pt[][]; copperTop: Pt[][]; copperBottom: Pt[][]; drills: Pt[] };
  topLoops: number;
  bottomLoops: number;
  drills: { diameter: number; count: number; filename: string }[];
  outlinePasses: number;
}

/** Этапы расчёта — для полосы прогресса в диалоге. */
export type CncStage = 'copper-top' | 'copper-bottom' | 'isolation' | 'drills' | 'gcode' | 'docs';
export type CncProgressFn = (stage: CncStage, frac: number) => void;

function checkPoint(p: Pt, id: string): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 2000 || Math.abs(p.y) > 2000)
    throw new Error(`Некорректные координаты объекта «${id}».`);
}

function positive(n: number, id: string): void {
  if (!Number.isFinite(n) || n <= 0 || n > 2000)
    throw new Error(`Некорректный размер объекта «${id}».`);
}

function polygon(pts: Pt[], id: string): Clipper.Path {
  pts.forEach((p) => checkPoint(p, id));
  const path = pts.map(coord);
  // У Clipper положительная ориентация у внешнего контура; так ни один
  // отрицательно ориентированный пользовательский полигон не станет отверстием.
  if (path.length < 3 || Math.abs(Clipper.Clipper.Area(path)) < 1)
    throw new Error(`Вырожденный медный полигон «${id}».`);
  if (!Clipper.Clipper.Orientation(path)) path.reverse();
  return path;
}

function circle(x: number, y: number, r: number, id: string): Clipper.Path {
  checkPoint({ x, y }, id);
  positive(r, id);
  // Аппроксимация окружности с ошибкой хорды не более 0,005 мм.
  const count = Math.max(24, Math.min(512, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - 0.005 / r)))));
  return polygon(Array.from({ length: count }, (_, i) => ({
    x: x + r * Math.cos(2 * Math.PI * i / count),
    y: y + r * Math.sin(2 * Math.PI * i / count),
  })), id);
}

function rect(x: number, y: number, w: number, h: number, id: string): Clipper.Path {
  checkPoint({ x, y }, id);
  positive(w, id); positive(h, id);
  return polygon([{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], id);
}

function stroked(pts: Pt[], width: number, id: string, closed = false): Clipper.Paths {
  positive(width, id);
  pts.forEach((p) => checkPoint(p, id));
  if (!pts.length) throw new Error(`Пустая медная линия «${id}».`);
  if (pts.length === 1 || (pts.length === 2 && mm(pts[0].x) === mm(pts[1].x) && mm(pts[0].y) === mm(pts[1].y)))
    return [circle(pts[0].x, pts[0].y, width / 2, id)];
  const off = new Clipper.ClipperOffset(2, ARC_TOLERANCE);
  off.AddPath(pts.map(coord), Clipper.JoinType.jtRound, closed ? Clipper.EndType.etClosedLine : Clipper.EndType.etOpenRound);
  const result: Clipper.Paths = [];
  off.Execute(result, mm(width / 2));
  if (!result.length) throw new Error(`Не удалось построить медную линию «${id}».`);
  return result;
}

function copperShapes(e: Entity): Clipper.Paths {
  switch (e.kind) {
    case 'pad': {
      if (e.shape === 'round') return [circle(e.x, e.y, e.size / 2, e.id)];
      if (e.shape === 'square') return [rect(e.x - e.size / 2, e.y - e.size / 2, e.size, e.size, e.id)];
      positive(e.size, e.id);
      return [polygon(Array.from({ length: 8 }, (_, i) => {
        const a = (22.5 + i * 45) * Math.PI / 180;
        return { x: e.x + e.size / 2 * Math.cos(a), y: e.y + e.size / 2 * Math.sin(a) };
      }), e.id)];
    }
    case 'via': return [circle(e.x, e.y, e.size / 2, e.id)];
    case 'smd': {
      // Та же геометрия, что на экране и в Gerber: вращение площадки на 0/90°.
      if (!Number.isFinite(e.rot)) throw new Error(`Некорректный поворот «${e.id}».`);
      const rot = ((Math.round(e.rot) % 180) + 180) % 180;
      return [rect(e.x - (rot ? e.h : e.w) / 2, e.y - (rot ? e.w : e.h) / 2,
        rot ? e.h : e.w, rot ? e.w : e.h, e.id)];
    }
    case 'track': return e.pts.length > 1 ? stroked(e.pts, e.w, e.id) : [];
    case 'line': return stroked([{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }], e.w, e.id);
    case 'circle': return stroked(circle(e.x, e.y, e.r, e.id).map(model), e.w, e.id, true);
    case 'rect': {
      const path = rect(e.x, e.y, e.w, e.h, e.id);
      return e.filled ? [path] : stroked(path.map(model), e.th, e.id, true);
    }
    case 'poly': return [polygon(e.pts, e.id)];
    case 'text': {
      checkPoint(e, e.id);
      positive(e.size, e.id); positive(e.th, e.id);
      if (!Number.isFinite(e.rot)) throw new Error(`Некорректный поворот «${e.id}».`);
      const a = e.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const segments = textPolylines(e.text).map((seg) => seg.map((p) => {
        const x = (e.mirror ? -p.x : p.x) * e.size / 10, y = p.y * e.size / 10;
        return { x: e.x + x * ca - y * sa, y: e.y + x * sa + y * ca };
      }));
      return segments.flatMap((s) => stroked(s, e.th, e.id));
    }
    default: return [];
  }
}

function countPoints(paths: Clipper.Paths): void {
  if (paths.reduce((sum, p) => sum + p.length, 0) > MAX_POINTS)
    throw new Error('Слишком сложная геометрия для ЧПУ (>250 000 точек). Разделите плату или упростите рисунок.');
}

function unionCopper(entities: Entity[], layer: 'k1' | 'k2'): Clipper.Paths {
  const paths: Clipper.Paths = [];
  for (const e of entities) {
    if (e.kind === 'pad' || e.kind === 'via' || ('layer' in e && e.layer === layer)) {
      const shapes = copperShapes(e);
      paths.push(...shapes);
      // Не даём импорту неограниченного числа сегментов заблокировать интерфейс.
      if (paths.length > MAX_POINTS) countPoints(paths);
    }
  }
  countPoints(paths);
  if (!paths.length) return [];
  const clip = new Clipper.Clipper();
  clip.AddPaths(paths, Clipper.PolyType.ptSubject, true);
  const result: Clipper.Paths = [];
  clip.Execute(Clipper.ClipType.ctUnion, result, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
  countPoints(result);
  return result;
}

function topology(paths: Clipper.Paths): [number, number] {
  let outer = 0, holes = 0;
  for (const p of paths) {
    const a = Clipper.Clipper.Area(p);
    if (a > 0) outer++;
    else if (a < 0) holes++;
  }
  return [outer, holes];
}

function offsetCopper(copper: Clipper.Paths, deltaMm: number): Clipper.Paths {
  const offset = new Clipper.ClipperOffset(2, ARC_TOLERANCE);
  offset.AddPaths(copper, Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon);
  const result: Clipper.Paths = [];
  offset.Execute(result, mm(deltaMm));
  return result;
}

function isolationPaths(copper: Clipper.Paths, s: CncSettings, side: CncSide): Clipper.Paths {
  if (!copper.length) return [];
  const result = offsetCopper(copper, s.toolDiameter / 2 + s.clearance);
  countPoints(result);
  // Если два отдельных островка слились или закрылась внутренняя прорезь,
  // выбранной фрезой с заданным зазором нельзя отделить эту медь.
  const [outer, holes] = topology(copper);
  const [newOuter, newHoles] = topology(result);
  if (newOuter < outer || newHoles < holes)
    throw new Error(`${side === 'top' ? 'Верхняя' : 'Нижняя'} медь: фреза с зазором не проходит между элементами или во внутреннее окно. Уменьшите диаметр фрезы/зазор либо измените разводку.`);
  return result;
}

function maxOffsetFor(copper: Clipper.Paths): number {
  if (!copper.length) return Infinity;
  const [outer, holes] = topology(copper);
  if (outer <= 1 && holes === 0) return Infinity;
  const fits = (off: number) => {
    const [o, h] = topology(offsetCopper(copper, off));
    return o >= outer && h >= holes;
  };
  // 5 мм с запасом покрывает любую бытовую фрезу изоляции.
  if (fits(5)) return Infinity;
  let lo = 0, hi = 5;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 1000) / 1000;
}

function copperBounds(paths: Clipper.Paths): CncBoardAnalysis['copper'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) for (const p of path) {
    const v = model(p);
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function mergeBounds(a: CncBoardAnalysis['copper'], b: CncBoardAnalysis['copper']): CncBoardAnalysis['copper'] {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Щели и габарит меди — чтобы подобрать фрезу/запас под эту плату, ещё до G-code. */
export function analyzeCncBoard(doc: Doc): CncBoardAnalysis {
  cncRange('Ширина платы', doc.w, 1, 1000);
  cncRange('Высота платы', doc.h, 1, 1000);
  if (!Array.isArray(doc.entities)) throw new Error('Не найдены объекты платы.');
  const entities = expandDoc(doc.entities);
  const topCopper = unionCopper(entities, 'k1');
  const bottomCopper = unionCopper(entities, 'k2');
  const [topIslands, topHoles] = topology(topCopper);
  const [bottomIslands, bottomHoles] = topology(bottomCopper);
  const maxOffset = Math.min(maxOffsetFor(topCopper), maxOffsetFor(bottomCopper));
  return {
    maxOffset,
    minGap: Number.isFinite(maxOffset) ? Math.round(2 * maxOffset * 1000) / 1000 : Infinity,
    topIslands, bottomIslands, topHoles, bottomHoles,
    copper: mergeBounds(copperBounds(topCopper), copperBounds(bottomCopper)),
  };
}

/** XY рабочего нуля: модель X для верха, (ширина - X) для перевёрнутого низа. */
function machinePoint(p: Pt, side: CncSide, doc: Doc, s: CncSettings): Pt {
  const x = s.originX + (side === 'bottom' ? doc.w - p.x : p.x);
  const y = s.originY + p.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) ||
    x < -0.00005 || x > doc.w + 2 * s.originX + 0.00005 ||
    y < -0.00005 || y > doc.h + 2 * s.originY + 0.00005)
    throw new Error('Траектория выходит за пределы заготовки с указанными отступами X/Y. Увеличьте отступ или исправьте объекты вне платы.');
  return { x, y };
}

function transformed(paths: Clipper.Paths, side: CncSide, doc: Doc, s: CncSettings): Pt[][] {
  return paths.map((path) => path.map((p) => machinePoint(model(p), side, doc, s)));
}

function displayed(paths: Clipper.Paths, side: CncSide, w: number): Pt[][] {
  return paths.map((path) => path.map((p) => {
    const v = model(p);
    return { x: side === 'bottom' ? w - v.x : v.x, y: v.y };
  }));
}

function gcodeStart(label: string, rpm: number, safeZ: number): string[] {
  return [`(PSBees CNC - ${label})`, '(VERIFY XY ZERO, Z ZERO, TOOL AND CLAMPS)',
    'G21 G90 G17 G94', `G0 Z${N(safeZ)}`, `M3 S${N(rpm)}`, 'G4 P2'];
}

function gcodeEnd(safeZ: number): string[] { return [`G0 Z${N(safeZ)}`, 'M5', 'M2', '']; }

function millLoops(paths: Pt[][], depth: number, feed: number, plunge: number, rpm: number, safeZ: number, label: string): string {
  const out = gcodeStart(label, rpm, safeZ);
  for (const path of paths) {
    if (path.length < 3) throw new Error('Пустой/вырожденный контур фрезеровки.');
    out.push(`G0 X${N(path[0].x)} Y${N(path[0].y)}`, `G1 Z-${N(depth)} F${N(plunge)}`, `G1 F${N(feed)}`);
    for (let i = 1; i < path.length; i++) out.push(`G1 X${N(path[i].x)} Y${N(path[i].y)}`);
    out.push(`G1 X${N(path[0].x)} Y${N(path[0].y)}`, `G0 Z${N(safeZ)}`);
  }
  return [...out, ...gcodeEnd(safeZ)].join('\n');
}

function passDepths(depth: number, step: number): number[] {
  return Array.from({ length: Math.ceil(depth / step) }, (_, i) => Math.min(depth, (i + 1) * step));
}

type DrillHole = { point: Pt; diameter: number };

function holesOf(entities: Entity[], doc: Doc): DrillHole[] {
  const holes = new Map<string, DrillHole>();
  for (const e of entities) {
    if (e.kind !== 'pad' && e.kind !== 'via' && e.kind !== 'hole') continue;
    const d = e.kind === 'hole' ? e.d : e.drill;
    if (d === 0) continue;
    positive(d, e.id);
    checkPoint(e, e.id);
    if (e.x < 0 || e.x > doc.w || e.y < 0 || e.y > doc.h)
      throw new Error(`Отверстие «${e.id}» находится вне платы; проверьте координаты.`);
    const diameter = rounded(d);
    if (diameter <= 0) throw new Error(`Сверло «${e.id}» меньше 0,001 мм.`);
    const key = `${N(e.x)}:${N(e.y)}`;
    const prev = holes.get(key);
    if (prev) {
      if (prev.diameter !== diameter)
        throw new Error(`В точке (${N(e.x)}, ${N(e.y)}) совпали отверстия разных диаметров. Исправьте плату перед сверловкой.`);
      continue; // одна физическая точка, даже если в документе она повторена
    }
    holes.set(key, { point: { x: e.x, y: e.y }, diameter });
  }
  return [...holes.values()];
}

function drillProgram(holes: Pt[], diameter: number, doc: Doc, s: CncSettings): string {
  const out = gcodeStart(`DRILL ${N(diameter)}mm ${s.drillSide.toUpperCase()} ${holes.length} HOLES`, s.drillRpm, s.safeZ);
  const depths = passDepths(s.drillDepth, s.drillStep);
  for (const h of holes) {
    const p = machinePoint(h, s.drillSide, doc, s);
    if (p.x - diameter / 2 < 0 || p.x + diameter / 2 > doc.w + 2 * s.originX ||
        p.y - diameter / 2 < 0 || p.y + diameter / 2 > doc.h + 2 * s.originY)
      throw new Error(`Сверло Ø${N(diameter)} мм выходит за указанную заготовку. Увеличьте отступ рабочего нуля X/Y.`);
    out.push(`G0 X${N(p.x)} Y${N(p.y)}`);
    for (const depth of depths) out.push(`G1 Z-${N(depth)} F${N(s.drillFeed)}`, `G0 Z${N(s.safeZ)}`);
  }
  return [...out, ...gcodeEnd(s.safeZ)].join('\n');
}

function outlineProgram(doc: Doc, s: CncSettings): { code: string; passes: number } {
  const outlines = doc.entities.filter((e) => 'layer' in e && e.layer === 'outline');
  if (outlines.length && (outlines.length !== 1 || outlines[0].kind !== 'rect' ||
    Math.abs(outlines[0].x) > 0.0001 || Math.abs(outlines[0].y) > 0.0001 ||
    Math.abs(outlines[0].w - doc.w) > 0.0001 || Math.abs(outlines[0].h - doc.h) > 0.0001))
    throw new Error('Вырезание поддерживает только один прямоугольный контур платы. Для сложной формы используйте Gerber и проверенный CAM.');
  const path = rect(0, 0, doc.w, doc.h, 'outline');
  const off = new Clipper.ClipperOffset(2, ARC_TOLERANCE);
  off.AddPath(path, Clipper.JoinType.jtMiter, Clipper.EndType.etClosedPolygon);
  const result: Clipper.Paths = [];
  off.Execute(result, mm(s.outlineDiameter / 2));
  if (result.length !== 1) throw new Error('Не удалось построить траекторию контура платы.');
  const loops = transformed(result, 'top', doc, s);
  const depths = passDepths(s.outlineDepth, s.outlineStep);
  const out = gcodeStart('OUTLINE LAST - NO TABS - SECURE BOARD', s.outlineRpm, s.safeZ);
  const loop = loops[0];
  for (const depth of depths) {
    out.push(`G0 X${N(loop[0].x)} Y${N(loop[0].y)}`, `G1 Z-${N(depth)} F${N(s.isolationPlunge)}`, `G1 F${N(s.outlineFeed)}`);
    for (let i = 1; i < loop.length; i++) out.push(`G1 X${N(loop[i].x)} Y${N(loop[i].y)}`);
    out.push(`G1 X${N(loop[0].x)} Y${N(loop[0].y)}`, `G0 Z${N(s.safeZ)}`);
  }
  return { code: [...out, ...gcodeEnd(s.safeZ)].join('\n'), passes: depths.length };
}

function setupText(doc: Doc, s: CncSettings, job: CncJob): string {
  return [
    `PSBees - инструкции для ЧПУ: ${doc.name.replace(/[\r\n]/g, ' ')}`,
    `Плата: ${N(doc.w)} x ${N(doc.h)} мм. Заготовка: не меньше ${N(doc.w + 2 * s.originX)} x ${N(doc.h + 2 * s.originY)} мм.`,
    `Рабочий ноль G-code (X0 Y0) — нижний левый угол ЗАГОТОВКИ при взгляде сверху на обрабатываемую сторону.`,
    `Угол ПЛАТЫ: X${N(s.originX)} Y${N(s.originY)}. Верх: X=${N(s.originX)}+x, Y=${N(s.originY)}+y.`,
    `Низ после переворота вокруг оси Y (лево/право): X=${N(s.originX)}+${N(doc.w)}-x, Y=${N(s.originY)}+y.`,
    `Сохраняйте ту же привязку X/Y в станке и положении платы при перевороте; Z0 заново от поверхности каждой стороны/после смены инструмента.`,
    `Z безопасности: +${N(s.safeZ)} мм; режущие глубины отрицательные. Убедитесь, что подъём выше зажимов.`,
    '',
    'Файлы и порядок (НЕ запускайте весь ZIP как одну программу):',
    '  00_PROCHTITE_PERED_ZAPUSKOM.txt — этот файл: нули, инструменты, порядок и предупреждения.',
    '  00b_SHEMY_PARAMETROV.svg — схемы «что за что отвечает»: ноль, изоляция, сверловка, переворот, контур, файлы.',
    ...(job.drills.length && s.drillSide === 'top' ? job.drills.map((d) => `  ${d.filename} — сверло Ø${N(d.diameter)} мм, ${d.count} отв.`) : []),
    ...(job.topLoops ? [`  01_verh_k1.nc — изоляция верхней меди, ${job.topLoops} замкнутых контуров.`] : []),
    ...(job.bottomLoops ? [`  02_niz_k2_zerkalo_x.nc — ПОСЛЕ ПЕРЕВОРОТА, изоляция нижней меди, ${job.bottomLoops} контуров.`] : []),
    ...(job.drills.length && s.drillSide === 'bottom' ? job.drills.map((d) => `  ${d.filename} — сверло Ø${N(d.diameter)} мм, ${d.count} отв., ПОСЛЕ ПЕРЕВОРОТА.`) : []),
    ...(job.outlinePasses ? [`  99_kontur_poslednim.nc — ПОСЛЕДНИМ, ${job.outlinePasses} проходов, БЕЗ ПЕРЕМЫЧЕК: закрепите плату!`] : []),
    '',
    'Перед КАЖДЫМ файлом вручную установите нужный инструмент (M6/T-команд нет), проверьте диаметр и выставьте Z0.',
    `Изоляция: Ø${N(s.toolDiameter)} мм + запас ${N(s.clearance)} мм, разделение меди ${N(s.toolDiameter + 2 * s.clearance)} мм; Z-${N(s.isolationDepth)}, F${N(s.isolationFeed)}, врезание F${N(s.isolationPlunge)}, S${N(s.isolationRpm)}.`,
    `Сверловка (${s.drillSide === 'top' ? 'сверху' : 'снизу, координаты зеркальны'}): Z-${N(s.drillDepth)}, шаг ${N(s.drillStep)}, F${N(s.drillFeed)}, S${N(s.drillRpm)}.`,
    ...(s.cutOutline ? [`Контур: Ø${N(s.outlineDiameter)} мм; Z-${N(s.outlineDepth)}, шаг ${N(s.outlineStep)}, F${N(s.outlineFeed)}, врезание F${N(s.isolationPlunge)}, S${N(s.outlineRpm)}.`] : []),
    '',
    'Диалект: GRBL-совместимый G-code, G21 G90 G17 G94, M3/M5, G4 P2 (пауза 2 с), G0/G1; без G28, G92 и смены инструмента.',
    'Это ОДНА изоляционная дорожка вокруг объединённой меди, а не полное удаление меди; оставшаяся фольга требует отдельной зачистки.',
    'Ширина V-образного резца — эффективная ширина на выбранной глубине, не диаметр хвостовика.',
    'ПРОВЕРЬТЕ программу в симуляторе вашего контроллера, направление осей, отражение низа, ноль, подачу и обороты.',
    'Первый пуск — холостой проход с Z выше платы и включённой защитой; сверяйте контуры и все отверстия с чертежом.',
    'Дополнительно: CNC_EXPORT.md в репозитории PSBees описывает базирование, ограничения и безопасность.',
    '',
  ].join('\n');
}

/** Не изменяет документ. В архиве только программы с реальными операциями, инструкция и схемы. */
export function buildCncJob(doc: Doc, s: CncSettings, onProgress: CncProgressFn = () => {}): CncJob {
  validateCncSettings(s);
  cncRange('Ширина платы', doc.w, 1, 1000);
  cncRange('Высота платы', doc.h, 1, 1000);
  if (!Array.isArray(doc.entities)) throw new Error('Не найдены объекты платы.');
  const entities = expandDoc(doc.entities);
  onProgress('copper-top', 0);
  const topCopper = unionCopper(entities, 'k1');
  onProgress('copper-top', 1);
  onProgress('copper-bottom', 0);
  const bottomCopper = unionCopper(entities, 'k2');
  onProgress('copper-bottom', 1);
  onProgress('isolation', 0);
  const top = isolationPaths(topCopper, s, 'top');
  onProgress('isolation', 0.5);
  const bottom = isolationPaths(bottomCopper, s, 'bottom');
  onProgress('isolation', 1);
  onProgress('drills', 0);
  const found = holesOf(entities, doc);
  const groups = new Map<number, Pt[]>();
  for (const hole of found) {
    const pts = groups.get(hole.diameter) ?? [];
    pts.push(hole.point);
    groups.set(hole.diameter, pts);
  }
  onProgress('drills', 1);
  onProgress('gcode', 0);
  const planned = (top.length ? 1 : 0) + (bottom.length ? 1 : 0) + groups.size + (s.cutOutline ? 1 : 0);
  const files: ZipFile[] = [];
  const tickGcode = () => onProgress('gcode', planned ? files.length / planned : 1);
  if (top.length) { files.push({ name: '01_verh_k1.nc', data: millLoops(transformed(top, 'top', doc, s),
    s.isolationDepth, s.isolationFeed, s.isolationPlunge, s.isolationRpm, s.safeZ, 'TOP K1 ISOLATION') }); tickGcode(); }
  if (bottom.length) { files.push({ name: '02_niz_k2_zerkalo_x.nc', data: millLoops(transformed(bottom, 'bottom', doc, s),
    s.isolationDepth, s.isolationFeed, s.isolationPlunge, s.isolationRpm, s.safeZ, 'BOTTOM K2 MIRROR X ISOLATION') }); tickGcode(); }

  const drills: CncJob['drills'] = [];
  for (const [diameter, points] of [...groups].sort((a, b) => a[0] - b[0])) {
    const filename = `sverlo_${N(diameter).replace('.', 'p')}mm_${s.drillSide === 'bottom' ? 'niz_zerkalo_x' : 'verh'}.nc`;
    files.push({ name: filename, data: drillProgram(points, diameter, doc, s) });
    drills.push({ diameter, count: points.length, filename });
    tickGcode();
  }

  let outlinePasses = 0;
  if (s.cutOutline) {
    const outline = outlineProgram(doc, s);
    outlinePasses = outline.passes;
    files.push({ name: '99_kontur_poslednim.nc', data: outline.code });
    tickGcode();
  }
  if (!files.length) throw new Error('На плате нет меди, отверстий и выбранного контура для экспорта ЧПУ.');
  const job: CncJob = {
    files, topLoops: top.length, bottomLoops: bottom.length, drills, outlinePasses,
    preview: {
      top: displayed(top, 'top', doc.w), bottom: displayed(bottom, 'bottom', doc.w),
      copperTop: displayed(topCopper, 'top', doc.w), copperBottom: displayed(bottomCopper, 'bottom', doc.w),
      drills: found.map((h) => ({ x: s.drillSide === 'bottom' ? doc.w - h.point.x : h.point.x, y: h.point.y })),
    },
  };
  onProgress('docs', 0);
  // Схемы «что за что отвечает» — рядом с инструкцией, чтобы у станка не гадать.
  files.push({ name: '00b_SHEMY_PARAMETROV.svg', data: cncSchemesSvg(doc, s, job) });
  files.push({ name: '00_PROCHTITE_PERED_ZAPUSKOM.txt', data: setupText(doc, s, job) });
  onProgress('docs', 1);
  return job;
}
