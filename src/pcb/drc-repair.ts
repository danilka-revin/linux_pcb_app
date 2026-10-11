// Автопочинка нарушений зазора: вырезать конфликтный кусок дорожки и проложить
// обход тем же A*-движком, что и автотрассировка — на том же слое, без
// переходов, не трогая геометрию остальных объектов. После обхода —
// «натяжка струны» (жадные спрямления с проверкой зазора), чтобы путь был
// гладким, а не лесенкой сетки. Чинится только если стало строго лучше:
// конфликт ушёл и новых нарушений нет, иначе плата не меняется.

import { autoroute, clearanceAt, copperShapes, shapeDist, shapeShapeDist, type RouteEnd, type Shape } from './autoroute';
import { expandDoc } from './expand';
import { trackClearance } from './track-clearance';
import { polylineLength } from './trackcalc';
import { uid, type Doc, type Entity, type Pt, type Track } from './model';

export interface RepairInput {
  doc: Doc;
  /** точка конфликта (середина между нарушителями) */
  x: number; y: number;
  /** требуемый зазор, мм */
  rule: number;
  /** слой конфликта — сузить поиск */
  layer?: 'k1' | 'k2';
  /** предпочесть эту дорожку-жертву (id верхнего уровня) */
  preferId?: string;
  /** шаг сетки обхода (по умолчанию 0,2) */
  step?: number;
  /** зазор до отверстий (по умолчанию rule + 0,2) */
  holeClear?: number;
}

export interface RepairResult {
  ok: boolean;
  /** новый документ (только при ok) — заменена одна дорожка */
  doc?: Doc;
  trackId?: string;
  /** насколько удлинилась дорожка, мм */
  addedLen?: number;
  msg: string;
}

/** Можно ли чинить: среди участников есть дорожка верхнего уровня. */
export function canRepair(doc: Doc, entities: string[] | undefined): boolean {
  if (!entities || !entities.length) return false;
  for (const id of entities) {
    if (id.includes(':')) continue; // внутри компонента — руками
    const e = doc.entities.find((x) => x.id === id);
    if (e && e.kind === 'track') return true;
  }
  return false;
}

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Проекция точки на ломаную: аркдлина s, точка и индекс сегмента. */
function projectOnTrack(t: Track, p: Pt): { s: number; idx: number } {
  let best = { s: 0, idx: 0 };
  let bd = Infinity, acc = 0;
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1], b = t.pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const tt = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const d = Math.hypot(p.x - (a.x + tt * dx), p.y - (a.y + tt * dy));
    const segLen = Math.sqrt(len2);
    if (d < bd) { bd = d; best = { s: acc + tt * segLen, idx: i }; }
    acc += segLen;
  }
  return best;
}

/** Точка ломаной на аркдлине s (s клампится к концам). */
function pointAt(t: Track, s: number): Pt {
  let acc = 0;
  for (let i = 1; i < t.pts.length; i++) {
    const a = t.pts[i - 1], b = t.pts[i];
    const len = dist(a, b);
    if (s <= acc + len || i === t.pts.length - 1) {
      const tt = len > 0 ? Math.max(0, Math.min(1, (s - acc) / len)) : 0;
      return { x: a.x + (b.x - a.x) * tt, y: a.y + (b.y - a.y) * tt };
    }
    acc += len;
  }
  return { ...t.pts[t.pts.length - 1] };
}

/** Куски ломаной [0..sA] и [sB..end] (якоря включены). */
function stubs(t: Track, sA: number, sB: number): { head: Pt[]; tail: Pt[] } {
  const head: Pt[] = [];
  const tail: Pt[] = [];
  let acc = 0;
  const pts = t.pts;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += dist(pts[i - 1], pts[i]);
    if (acc <= sA + 1e-9) head.push({ ...pts[i] });
    if (acc >= sB - 1e-9) tail.push({ ...pts[i] });
  }
  const a = pointAt(t, sA), b = pointAt(t, sB);
  if (!head.length || dist(head[head.length - 1], a) > 1e-9) head.push(a);
  if (!tail.length || dist(tail[0], b) > 1e-9) tail.unshift(b);
  return { head, tail };
}

/** Проверка новой середины: зазор выборкой каждые ~0,1 мм (отверстия — строже).
 * Окрестности якорей — стыки со старыми кусками, их пропускаем. Формы
 * предпосчитаны снаружи: сглаживание зовёт проверку на каждого кандидата. */
interface CleanCtx { shapes: Shape[]; w: number; rule: number; holeClear: number; layer: 'k1' | 'k2'; anchors: Pt[] }
function pathClean(ctx: CleanCtx, pts: Pt[]): boolean {
  const jR = ctx.w / 2 + Math.max(ctx.rule, ctx.holeClear) + 0.4;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = dist(a, b);
    const n = Math.max(1, Math.ceil(len / 0.1));
    for (let k = 0; k <= n; k++) {
      const px = a.x + (b.x - a.x) * (k / n), py = a.y + (b.y - a.y) * (k / n);
      if (ctx.anchors.some((c) => Math.hypot(px - c.x, py - c.y) < jR)) continue;
      for (const s of ctx.shapes) {
        if (!s.layers.includes(ctx.layer)) continue;
        const need = (s.drilled || s.hole) ? ctx.holeClear : ctx.rule;
        if (shapeDist(s, px, py) - ctx.w / 2 < need - 1e-6) return false;
      }
    }
  }
  return true;
}

/**
 * «Натяжка струны»: жадно заменяем куски пути прямыми отрезками, пока короче
 * и зазор держится. Убирает лесенку сетки — обход становится гладким.
 */
function smoothPath(ctx: CleanCtx, pts: Pt[]): Pt[] {
  let cur = pts.map((p) => ({ ...p }));
  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    for (let i = 0; i + 1 < cur.length && !improved; i++) {
      for (let j = cur.length - 1; j > i + 1; j--) {
        // длина куска i..j против прямого отрезка
        let segLen = 0;
        for (let k = i; k < j; k++) segLen += dist(cur[k], cur[k + 1]);
        if (dist(cur[i], cur[j]) >= segLen - 1e-6) continue;
        const cand = [...cur.slice(0, i + 1), ...cur.slice(j)];
        if (cand.length >= cur.length) continue;
        if (!pathClean(ctx, cand)) continue;
        cur = cand;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  return cur;
}

/** Точные нарушения жертвы против НЕ-дорожек (площадки, переходы, полигоны, отверстия). */
function shapeViolations(otherShapes: Shape[], victim: Track, rule: number, holeClear: number): number {
  let n = 0;
  for (const sv of copperShapes(victim)) {
    for (const so of otherShapes) {
      if (!so.layers.includes(victim.layer)) continue;
      const need = so.drilled ? holeClear : rule;
      const gap = shapeShapeDist(sv, so);
      if (gap < 1e-6) continue; // касание — стык или КЗ, но не нарушение зазора
      if (gap < need - 1e-7) n++;
    }
  }
  return n;
}

/** Попробовать починить одной конкретной жертвой. */
function tryVictim(
  doc: Doc, victim: Track, x: number, y: number, rule: number,
  step: number, holeClear: number, beforeCount: number,
): RepairResult {
  const fail = (msg: string): RepairResult => ({ ok: false, msg });
  const total = polylineLength(victim.pts);
  if (total < 0.5) return fail('Дорожка слишком короткая для обхода');
  const { s } = projectOnTrack(victim, { x, y });
  const others = doc.entities.filter((e) => e.id !== victim.id);
  const flatOthers = expandDoc(others);
  const otherShapes = flatOthers.filter((e) => e.kind !== 'track').flatMap(copperShapes).filter((s) => !s.hole);
  // чинить нечего — жертва чиста (устаревшая строка в диалоге)
  const beforeV = trackClearance(expandDoc(doc.entities), rule)
    .filter((v) => v.aId === victim.id || v.bId === victim.id).length
    + shapeViolations(otherShapes, victim, rule, holeClear);
  if (!beforeV) return fail('У этой дорожки нарушений нет — чинить нечего');
  // Якорь обязан держать и зазор до меди, и зазор до отверстий: роутер
  // стартует/финиширует строже (иначе вернёт blockA/blockB).
  const need0 = Math.max(rule, holeClear) + Math.max(0.08, rule * 0.2);
  const clearEnough = (p: Pt): boolean =>
    clearanceAt(others, p.x, p.y, victim.w / 2) >= need0 - 1e-6;
  // Якоря — точки стыка обхода со старыми кусками: обязаны строго держать
  // зазор (иначе роутер не сможет стартовать/финишировать). Ищем от конфликта
  // в обе стороны до чистого места, шаг 0,25 мм, до 25 мм.
  let sA = -1, sB = -1;
  for (let d = 0.25; d <= 25; d += 0.25) {
    if (sA < 0 && s - d > 0 && clearEnough(pointAt(victim, s - d))) sA = s - d;
    if (sB < 0 && s + d < total && clearEnough(pointAt(victim, s + d))) sB = s + d;
    if (sA >= 0 && sB >= 0) break;
  }
  if (sA < 0 || sB < 0) return fail('Не нашлось чистого места под стык обхода — раздвиньте дорожки вручную');
  if (sB - sA < 0.3) return fail('Дорожка слишком короткая для обхода');
  const anchorA = pointAt(victim, sA), anchorB = pointAt(victim, sB);
  const { head, tail } = stubs(victim, sA, sB);
  // сущности для роутера: жертва убрана, огрызки — «свои», к ним можно примыкать
  const routingEnts = [...others];
  const ownIds: string[] = [];
  if (head.length >= 2) {
    const id = uid();
    routingEnts.push({ id, kind: 'track', pts: head, w: victim.w, layer: victim.layer });
    ownIds.push(id);
  }
  if (tail.length >= 2) {
    const id = uid();
    routingEnts.push({ id, kind: 'track', pts: tail, w: victim.w, layer: victim.layer });
    ownIds.push(id);
  }
  const A: RouteEnd = { x: anchorA.x, y: anchorA.y, layers: [victim.layer], r: victim.w / 2 };
  const B: RouteEnd = { x: anchorB.x, y: anchorB.y, layers: [victim.layer], r: victim.w / 2 };
  const res = autoroute(routingEnts, doc.w, doc.h, A, B, {
    trackW: victim.w, clearance: rule + 0.05, holeClear: holeClear + 0.05, viaSize: 1.0, viaDrill: 0.5,
    step, viaCost: 1e9, topMul: 1, allowVias: false, allowTop: false,
    angle: '45', edge: rule, crowd: 0.5, shiftRetry: true,
  }, ownIds);
  if (!res.ok) return fail(res.msg || 'Обход не найден');
  const mid = res.ents.find((e): e is Track => e.kind === 'track');
  if (!mid || mid.pts.length < 2) return fail('Обход не найден');
  const anchors = [anchorA, anchorB];
  const ctx: CleanCtx = {
    shapes: expandDoc(routingEnts).flatMap(copperShapes),
    w: victim.w, rule, holeClear, layer: victim.layer, anchors,
  };
  if (!pathClean(ctx, mid.pts)) return fail('Обход упёрся в чужую медь');
  // сначала гладкий вариант, при неудаче — сырой путь роутера
  for (const midPts of [smoothPath(ctx, mid.pts), mid.pts]) {
    if (!pathClean(ctx, midPts)) continue; // чиста только новая середина; стыки — старая геометрия
    const full = [...head.slice(0, -1), ...midPts, ...tail.slice(1)];
    const dedup = full.filter((p, i) => i === 0 || dist(p, full[i - 1]) > 1e-9);
    if (dedup.length < 2) continue;
    const next: Track = { ...victim, pts: dedup };
    const candEnts = doc.entities.map((e) => (e.id === victim.id ? next : e));
    const tcAfter = trackClearance(expandDoc(candEnts), rule);
    const afterV = tcAfter.filter((v) => v.aId === victim.id || v.bId === victim.id).length
      + shapeViolations(otherShapes, next, rule, holeClear);
    // стало строго лучше у жертвы — и не хуже по плате в целом
    if (afterV < beforeV && tcAfter.length <= beforeCount) {
      const added = polylineLength(dedup) - total;
      return {
        ok: true, doc: { ...doc, entities: candEnts }, trackId: victim.id, addedLen: added,
        msg: `Готово: обход +${added.toFixed(1)} мм, нарушений у дорожки: ${beforeV} → ${afterV}`,
      };
    }
  }
  return fail('Обход не улучшил зазоры — плата не изменена');
}

/**
 * Починить нарушение зазора в точке (x, y): пробуем ближайшие дорожки-жертвы,
 * выбираем самый короткий удачный обход. Остальные объекты не трогаем.
 */
export function repairClearance(inp: RepairInput): RepairResult {
  const { doc, x, y, rule } = inp;
  if (!Number.isFinite(rule) || rule < 0) return { ok: false, msg: 'Неверный зазор' };
  const step = inp.step && inp.step >= 0.02 ? inp.step : 0.2;
  const holeClear = inp.holeClear ?? rule + 0.2;
  // ближайшие к конфликту — первые (обычно это и есть две стороны нарушения)
  const p = { x, y };
  const victims = doc.entities.filter((e): e is Track =>
    e.kind === 'track' && !e.id.includes(':') && (!inp.layer || e.layer === inp.layer) && e.pts.length >= 2)
    .map((t) => ({ t, d: projectOnTrack(t, p).s >= 0 ? dist(pointAt(t, projectOnTrack(t, p).s), p) : Infinity }))
    .sort((a, b) => (a.t.id === inp.preferId ? -1e9 + a.d : a.d) - (b.t.id === inp.preferId ? -1e9 + b.d : b.d))
    .slice(0, 3)
    .map((v) => v.t);
  if (!victims.length) return { ok: false, msg: 'Рядом нет дорожек, которые можно переложить' };
  const beforeCount = trackClearance(expandDoc(doc.entities), rule).length;
  let best: RepairResult | null = null;
  let lastFail = '';
  for (const v of victims) {
    const r = tryVictim(doc, v, x, y, rule, step, holeClear, beforeCount);
    if (r.ok && (!best || (r.addedLen ?? Infinity) < (best.addedLen ?? Infinity))) best = r;
    else if (!r.ok) lastFail = r.msg;
  }
  return best ?? { ok: false, msg: lastFail || 'Обход не найден' };
}
