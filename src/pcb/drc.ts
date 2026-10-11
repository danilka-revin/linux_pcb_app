// Полная геометрическая проверка платы перед производством.
// Это не замена электрической симуляции и не сертифицированный CAM; правила
// видны пользователю, а каждый результат привязан к координате на плате.
import type { Doc, Entity, Pt } from './model';
import { expandDoc } from './expand';
import { boardShape, insideBoard } from './board-shape';
import { copperShapes, shapeDist, shapeShapeDist, type Shape } from './autoroute';
import { trackClearance } from './track-clearance';
import { copperComponents, netMissing } from './netroute';

export type DrcSeverity = 'error' | 'warning';
export interface DrcRules {
  minClearance: number;
  minTrackWidth: number;
  minDrill: number;
  minAnnularRing: number;
  minBoardEdge: number;
  minDrillEdge: number;
  minSilkWidth: number;
}
export interface DrcViolation {
  id: string;
  rule: string;
  severity: DrcSeverity;
  message: string;
  x: number;
  y: number;
  actual?: number;
  required?: number;
  entities?: string[];
  layer?: string;
}

export const DRC_PRESETS: Record<'factory' | 'cnc' | 'lut', { name: string; rules: DrcRules }> = {
  factory: { name: 'Заводская плата', rules: {
    minClearance: 0.20, minTrackWidth: 0.15, minDrill: 0.30,
    minAnnularRing: 0.15, minBoardEdge: 0.25, minDrillEdge: 0.25, minSilkWidth: 0.12,
  } },
  cnc: { name: 'Фрезеровка ЧПУ', rules: {
    minClearance: 0.35, minTrackWidth: 0.35, minDrill: 0.80,
    minAnnularRing: 0.20, minBoardEdge: 1.00, minDrillEdge: 1.00, minSilkWidth: 0.20,
  } },
  lut: { name: 'ЛУТ / фотошаблон', rules: {
    minClearance: 0.30, minTrackWidth: 0.25, minDrill: 0.40,
    minAnnularRing: 0.20, minBoardEdge: 0.40, minDrillEdge: 0.40, minSilkWidth: 0.15,
  } },
};
export const DEFAULT_DRC_RULES = DRC_PRESETS.factory.rules;

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const finite = (n: number): boolean => Number.isFinite(n);
const distPointSeg = (p: Pt, a: Pt, b: Pt): number => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const q = dx * dx + dy * dy;
  const t = q ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / q)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
};
const segmentDistance = (a: Pt, b: Pt, c: Pt, d: Pt): number => {
  const cross = (u: Pt, v: Pt) => u.x * v.y - u.y * v.x;
  const ab = { x: b.x - a.x, y: b.y - a.y }, cd = { x: d.x - c.x, y: d.y - c.y };
  const ac = { x: c.x - a.x, y: c.y - a.y };
  const den = cross(ab, cd);
  if (Math.abs(den) > 1e-12) {
    const t = cross(ac, cd) / den, u = cross(ac, ab) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
  }
  return Math.min(distPointSeg(a, c, d), distPointSeg(b, c, d), distPointSeg(c, a, b), distPointSeg(d, a, b));
};
const shapePoints = (s: Shape): Pt[] => {
  const out: Pt[] = [];
  for (const seg of s.segs) {
    out.push({ x: seg[0], y: seg[1] }, { x: seg[2], y: seg[3] });
  }
  return out;
};
const shapeCenter = (s: Shape): Pt => ({ x: (s.bb[0] + s.bb[2]) / 2, y: (s.bb[1] + s.bb[3]) / 2 });

function push(out: DrcViolation[], item: Omit<DrcViolation, 'id'>): void {
  const ids = (item.entities ?? []).slice().sort().join('|');
  const id = `${item.rule}:${ids}:${item.x.toFixed(3)},${item.y.toFixed(3)}`;
  if (out.some((v) => v.id === id)) return;
  out.push({ ...item, id });
}

/** Сканирует механические сверления (включая отверстия PTH и переходов). */
function drillList(flat: Entity[]): { id: string; x: number; y: number; d: number; kind: string }[] {
  const out: { id: string; x: number; y: number; d: number; kind: string }[] = [];
  for (const e of flat) {
    if (e.kind === 'pad' && e.drill > 0) out.push({ id: e.id, x: e.x, y: e.y, d: e.drill, kind: 'площадка' });
    else if (e.kind === 'via' && e.drill > 0) out.push({ id: e.id, x: e.x, y: e.y, d: e.drill, kind: 'переход' });
    else if (e.kind === 'hole' && e.d > 0) out.push({ id: e.id, x: e.x, y: e.y, d: e.d, kind: 'монтажное отверстие' });
  }
  return out;
}

/**
 * Проверка размеров, сверловки, контура, медных зазоров, края платы и цепей.
 * Нулевое расстояние медь-медь трактуется как возможное соединение: без связанной
 * схемы нельзя надёжно отличить короткое замыкание от намеренного стыка.
 */
export function runBoardDrc(doc: Doc, rawRules: Partial<DrcRules> = {}): DrcViolation[] {
  const rules: DrcRules = { ...DEFAULT_DRC_RULES, ...rawRules };
  for (const [key, value] of Object.entries(rules)) {
    if (!finite(value) || value < 0) throw new Error(`Некорректное значение правила DRC «${key}».`);
  }
  const out: DrcViolation[] = [];
  const flat = expandDoc(doc.entities);
  const board = boardShape(doc, flat);

  // Breakaway tabs deliberately leave panel contours open; this is an expected
  // manufacturing profile, not a missing board outline. The open-chain warning
  // below carries the review reminder, and edge checks are done before panelizing.
  if (board.fallback && !(doc.panelInfo?.breakawayTabs && board.openChains > 0)) push(out, {
    rule: 'outline-missing', severity: 'error', message: 'Не найден замкнутый контур платы: используется прямоугольник рабочего поля.',
    x: doc.w / 2, y: doc.h / 2,
  });
  if (board.openChains) push(out, {
    rule: 'outline-open', severity: doc.panelInfo?.breakawayTabs ? 'warning' : 'error',
    message: doc.panelInfo?.breakawayTabs
      ? `В панели есть открытые участки контуров (${board.openChains}) — это могут быть технологические tabs; проверьте Gerber и mouse-bites.`
      : `Контур содержит незамкнутые или неоднозначные цепочки: ${board.openChains}.`,
    x: (board.bounds[0] + board.bounds[2]) / 2, y: (board.bounds[1] + board.bounds[3]) / 2,
  });

  for (const e of flat) {
    if (e.kind === 'track' && e.w < rules.minTrackWidth - 1e-8) push(out, {
      rule: 'track-width', severity: 'error', message: `Дорожка уже минимума: ${e.w.toFixed(3)} мм < ${rules.minTrackWidth.toFixed(3)} мм.`,
      x: e.pts[0]?.x ?? 0, y: e.pts[0]?.y ?? 0, actual: e.w, required: rules.minTrackWidth,
      entities: [e.id], layer: e.layer.toUpperCase(),
    });
    if (e.kind === 'line' && e.layer !== 'outline' && e.w < rules.minSilkWidth - 1e-8) push(out, {
      rule: 'silk-width', severity: 'warning', message: `Линия тоньше выбранного минимума: ${e.w.toFixed(3)} мм < ${rules.minSilkWidth.toFixed(3)} мм.`,
      x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, actual: e.w, required: rules.minSilkWidth,
      entities: [e.id], layer: e.layer.toUpperCase(),
    });
    if (e.kind === 'circle' && e.layer !== 'outline' && e.w < rules.minSilkWidth - 1e-8) push(out, {
      rule: 'silk-width', severity: 'warning', message: `Окружность тоньше выбранного минимума: ${e.w.toFixed(3)} мм < ${rules.minSilkWidth.toFixed(3)} мм.`,
      x: e.x, y: e.y, actual: e.w, required: rules.minSilkWidth, entities: [e.id], layer: e.layer.toUpperCase(),
    });
  }

  const drills = drillList(flat);
  for (const d of drills) {
    if (d.d < rules.minDrill - 1e-8) push(out, {
      rule: 'drill-size', severity: 'warning', message: `Сверло ${d.kind} меньше минимума: Ø${d.d.toFixed(3)} мм < Ø${rules.minDrill.toFixed(3)} мм.`,
      x: d.x, y: d.y, actual: d.d, required: rules.minDrill, entities: [d.id],
    });
  }
  for (const e of flat) {
    if (e.kind === 'pad' && e.drill > 0) {
      const ring = (e.size - e.drill) / 2;
      if (ring < rules.minAnnularRing - 1e-8) push(out, {
        rule: 'annular-ring', severity: 'error', message: `Кольцо меди вокруг сверла площадки слишком узкое: ${ring.toFixed(3)} мм < ${rules.minAnnularRing.toFixed(3)} мм.`,
        x: e.x, y: e.y, actual: ring, required: rules.minAnnularRing, entities: [e.id],
      });
    } else if (e.kind === 'via' && e.drill > 0) {
      const ring = (e.size - e.drill) / 2;
      if (ring < rules.minAnnularRing - 1e-8) push(out, {
        rule: 'annular-ring', severity: 'error', message: `Кольцо меди вокруг сверла перехода слишком узкое: ${ring.toFixed(3)} мм < ${rules.minAnnularRing.toFixed(3)} мм.`,
        x: e.x, y: e.y, actual: ring, required: rules.minAnnularRing, entities: [e.id],
      });
    }
  }

  // Дорожка–дорожка: используем существующий точный пространственный индекс.
  for (const v of trackClearance(flat, rules.minClearance)) push(out, {
    rule: 'copper-clearance', severity: 'error', message: `Зазор дорожек ${v.gap.toFixed(3)} мм меньше ${rules.minClearance.toFixed(3)} мм (${v.layer.toUpperCase()}).`,
    x: (v.a.x + v.b.x) / 2, y: (v.a.y + v.b.y) / 2, actual: v.gap, required: rules.minClearance,
    entities: [v.aId, v.bId], layer: v.layer.toUpperCase(),
  });

  // Зазор между дорожками, площадками, переходами и медными полигонами.
  const copper: { entity: Entity; shape: Shape; layer: string }[] = [];
  for (const e of flat) for (const s of copperShapes(e)) {
    if (s.hole) continue;
    for (const layer of s.layers) copper.push({ entity: e, shape: s, layer });
  }
  copper.sort((a, b) => a.shape.bb[0] - b.shape.bb[0]);
  const compMap = copperComponents(doc.entities);
  const netOwner = new Map<string, Set<string>>();
  for (const net of doc.nets ?? []) for (const pad of net.pads) {
    const root = compMap.get(pad) ?? pad;
    let names = netOwner.get(root);
    if (!names) { names = new Set(); netOwner.set(root, names); }
    names.add(net.name);
  }
  for (let i = 0; i < copper.length; i++) {
    const a = copper[i];
    for (let j = i + 1; j < copper.length; j++) {
      const b = copper[j];
      if (b.shape.bb[0] > a.shape.bb[2] + rules.minClearance) break;
      if (a.layer !== b.layer || a.shape.id === b.shape.id || a.entity.id === b.entity.id) continue;
      if (b.shape.bb[1] > a.shape.bb[3] + rules.minClearance || b.shape.bb[3] < a.shape.bb[1] - rules.minClearance) continue;
      // Треки уже имеют более точные и понятные сообщения выше.
      if (a.entity.kind === 'track' && b.entity.kind === 'track') continue;
      const gap = shapeShapeDist(a.shape, b.shape);
      if (gap < 1e-6) {
        const na = netOwner.get(compMap.get(a.shape.id) ?? a.shape.id);
        const nb = netOwner.get(compMap.get(b.shape.id) ?? b.shape.id);
        const namesA = na ? [...na] : [], namesB = nb ? [...nb] : [];
        const conflict = namesA.some((n) => namesB.some((m) => m !== n));
        if (conflict) {
          const p = midpoint(shapeCenter(a.shape), shapeCenter(b.shape));
          push(out, { rule: 'net-short', severity: 'error',
            message: `Медь цепей «${namesA.join(', ')}» и «${namesB.join(', ')}» соприкасается (${a.layer.toUpperCase()}).`,
            x: p.x, y: p.y, actual: gap, required: rules.minClearance,
            entities: [a.entity.id, b.entity.id], layer: a.layer.toUpperCase(),
          });
        }
        continue;
      }
      if (gap >= rules.minClearance - 1e-7) continue;
      const p = midpoint(shapeCenter(a.shape), shapeCenter(b.shape));
      push(out, { rule: 'copper-clearance', severity: 'error',
        message: `Зазор меди ${gap.toFixed(3)} мм меньше ${rules.minClearance.toFixed(3)} мм (${a.layer.toUpperCase()}).`,
        x: p.x, y: p.y, actual: gap, required: rules.minClearance,
        entities: [a.entity.id, b.entity.id], layer: a.layer.toUpperCase(),
      });
    }
  }

  // Реперы, mouse-bites и оснастка за границей отдельных плат — ожидаемые panel features.
  const panelFeatures = new Set(doc.panelInfo?.featureIds ?? []);
  // При tabs профиль борта намеренно открыт: локальную проверку edge clearance следует делать до панелизации.
  // Центр линии/пятачка должен находиться внутри контура с учётом половины размера.
  for (const item of copper) {
    if (doc.panelInfo?.breakawayTabs || panelFeatures.has(item.entity.id)) continue;
    const s = item.shape;
    if (!s.layers.includes(item.layer as 'k1' | 'k2')) continue;
    const points = shapePoints(s);
    if (!points.length) continue;
    const edgeMargin = rules.minBoardEdge + s.r;
    const unique: Pt[] = [];
    for (const p of points) if (!unique.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-7)) unique.push(p);
    const outside = unique.find((p) => !insideBoard(board, p, edgeMargin));
    let closestEdge: { p: Pt; gap: number } | null = null;
    for (const seg of s.segs) for (const loop of board.loops) for (let i = 0; i < loop.length; i++) {
      const a = { x: seg[0], y: seg[1] }, b = { x: seg[2], y: seg[3] };
      const c = loop[i], d = loop[(i + 1) % loop.length];
      const gap = segmentDistance(a, b, c, d) - s.r;
      if (!closestEdge || gap < closestEdge.gap) closestEdge = { p: midpoint(a, b), gap };
    }
    const tooClose = closestEdge && closestEdge.gap < rules.minBoardEdge - 1e-7;
    if (outside || tooClose) {
      const p = outside ?? closestEdge!.p;
      push(out, {
        rule: 'copper-edge', severity: 'error',
        message: `Медь ближе ${rules.minBoardEdge.toFixed(3)} мм к краю платы или выходит за контур (${item.layer.toUpperCase()}).`,
        x: p.x, y: p.y, actual: closestEdge?.gap, required: rules.minBoardEdge, entities: [item.entity.id], layer: item.layer.toUpperCase(),
      });
    }
  }

  // От сверла до границы платы измеряем расстояние от окружности сверла.
  for (const d of drills) {
    if (doc.panelInfo?.breakawayTabs || panelFeatures.has(d.id)) continue;
    const p = { x: d.x, y: d.y };
    const min = Math.min(...board.loops.flatMap((loop) => loop.map((a, i) => distPointSeg(p, a, loop[(i + 1) % loop.length]))));
    const inside = insideBoard(board, p, 0);
    const actual = min - d.d / 2;
    if (!inside || actual < rules.minDrillEdge - 1e-7) push(out, {
      rule: 'drill-edge', severity: 'error',
      message: !inside ? `Сверление ${d.kind} расположено вне платы.`
        : `Сверло ${d.kind} слишком близко к краю: ${actual.toFixed(3)} мм < ${rules.minDrillEdge.toFixed(3)} мм.`,
      x: d.x, y: d.y, actual, required: rules.minDrillEdge, entities: [d.id],
    });
  }

  // Сверло не должно попадать в медь других элементов; собственное кольцо PTH/via исключаем.
  for (const d of drills) for (const c of copper) {
    if (c.entity.id === d.id || !c.shape.layers.length) continue;
    const gap = shapeDist(c.shape, d.x, d.y) - d.d / 2;
    if (gap < rules.minClearance - 1e-7) push(out, {
      rule: 'drill-clearance', severity: 'error',
      message: `Сверло Ø${d.d.toFixed(3)} мм ближе ${rules.minClearance.toFixed(3)} мм к меди (${c.layer.toUpperCase()}).`,
      x: d.x, y: d.y, actual: gap, required: rules.minClearance,
      entities: [d.id, c.entity.id], layer: c.layer.toUpperCase(),
    });
  }

  // Силкскринный штрих на меди — проверка по расстоянию до ограничивающих прямоугольников.
  // Это намеренно предупреждение: геометрия векторного текста аппроксимируется bbox.
  const silk = flat.filter((e) => 'layer' in e && (e.layer === 's1' || e.layer === 's2'));
  const cuEnts = flat.filter((e) => e.kind === 'pad' || e.kind === 'smd' || e.kind === 'via' || e.kind === 'track');
  for (const s of silk) {
    if (s.kind !== 'text' && s.kind !== 'line' && s.kind !== 'circle' && s.kind !== 'rect' && s.kind !== 'dim') continue;
    const layer = s.layer === 's1' ? 'k1' : 'k2';
    const sb = entBox(s);
    for (const c of cuEnts) {
      const shapes = copperShapes(c).filter((sh) => sh.layers.includes(layer as 'k1' | 'k2'));
      const cb = entBox(c);
      if (sb[0] <= cb[2] && sb[2] >= cb[0] && sb[1] <= cb[3] && sb[3] >= cb[1]) {
        push(out, { rule: 'silk-over-copper', severity: 'warning',
          message: `Шелкография может перекрывать медь (${layer.toUpperCase()}); проверьте надпись/графику.`,
          x: Math.max(sb[0], Math.min(cb[2], (sb[0] + sb[2]) / 2)),
          y: Math.max(sb[1], Math.min(cb[3], (sb[1] + sb[3]) / 2)),
          entities: [s.id, c.id], layer: s.layer.toUpperCase(),
        });
        break;
      }
      void shapes;
    }
  }

  // Все назначенные электрические цепи должны иметь физически соединённые выводы.
  for (const net of doc.nets ?? []) {
    const missing = netMissing(net, compMap);
    if (missing > 0) push(out, { rule: 'unconnected-net', severity: 'warning',
      message: `Цепь «${net.name}»: не хватает связей — ${missing}.`,
      x: doc.w / 2, y: doc.h / 2, entities: net.pads,
    });
  }

  // На больших платах список не должен раздуваться до миллионов сообщений.
  return out.slice(0, 5000);
}

function entBox(e: Entity): [number, number, number, number] {
  if (e.kind === 'track') {
    const xs = e.pts.map((p) => p.x), ys = e.pts.map((p) => p.y), r = e.w / 2;
    return [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r];
  }
  if (e.kind === 'line') return [Math.min(e.x1, e.x2) - e.w / 2, Math.min(e.y1, e.y2) - e.w / 2, Math.max(e.x1, e.x2) + e.w / 2, Math.max(e.y1, e.y2) + e.w / 2];
  if (e.kind === 'pad' || e.kind === 'via') { const r = e.size / 2; return [e.x - r, e.y - r, e.x + r, e.y + r]; }
  if (e.kind === 'smd') return [e.x - e.w / 2, e.y - e.h / 2, e.x + e.w / 2, e.y + e.h / 2];
  if (e.kind === 'hole') return [e.x - e.d / 2, e.y - e.d / 2, e.x + e.d / 2, e.y + e.d / 2];
  if (e.kind === 'circle') { const r = e.r + e.w / 2; return [e.x - r, e.y - r, e.x + r, e.y + r]; }
  if (e.kind === 'rect') return [e.x - e.th / 2, e.y - e.th / 2, e.x + e.w + e.th / 2, e.y + e.h + e.th / 2];
  if (e.kind === 'text') return [e.x, e.y, e.x + e.text.length * e.size * 0.8, e.y + e.size];
  if (e.kind === 'dim') return [Math.min(e.x1, e.x2) - Math.abs(e.off), Math.min(e.y1, e.y2) - Math.abs(e.off), Math.max(e.x1, e.x2) + Math.abs(e.off), Math.max(e.y1, e.y2) + Math.abs(e.off)];
  if (e.kind === 'poly' && e.pts.length) return [Math.min(...e.pts.map((p) => p.x)), Math.min(...e.pts.map((p) => p.y)), Math.max(...e.pts.map((p) => p.x)), Math.max(...e.pts.map((p) => p.y))];
  return [0, 0, 0, 0];
}
