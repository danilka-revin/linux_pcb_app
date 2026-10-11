// «Тепловизор»: оценка нагрева цепи постоянным током.
//
// Честная оговорка: точное распределение тока по разветвлённой цепи требует
// решателя, поэтому считаем консервативную прикидку «сверху» — каждый участок
// дорожки якобы несёт весь заданный ток. Нагрев — обратный IPC-2221,
// сопротивление — R = ρ·L/A при 20 °C. Переходы, площадки и теплоотвод
// в полигоны не учитываются: реальные цифры будут чуть лучше.

import { ipc2221TempRise, polylineLength, trackResistance } from './trackcalc';
import type { Entity, Track } from './model';

/** Один участок цепи (дорожка) с тепловым расчётом. */
export interface ThermalSeg {
  id: string;
  layer: 'k1' | 'k2';
  pts: { x: number; y: number }[];
  w: number;
  /** длина, мм */
  len: number;
  /** сопротивление, Ом */
  res: number;
  /** падение напряжения на участке при заданном токе, В */
  drop: number;
  /** нагрев участка, °C */
  dT: number;
  /** нагрев, нормированный 0..1 для палитры */
  t01: number;
  /** число «прыжков» от точки клика (для анимации тока) */
  hop: number;
  /** рисовать ли задом наперёд, чтобы ток тёк от точки клика */
  flip: boolean;
  /** 0 — холодный, 1 — тёплый, 2 — горячий */
  hot: 0 | 1 | 2;
}

export interface ThermalResult {
  segs: ThermalSeg[];
  /** суммарное сопротивление дорожек цепи, Ом */
  totalR: number;
  /** суммарное падение напряжения, В */
  totalDrop: number;
  /** рассеиваемая мощность, Вт */
  totalP: number;
  /** максимальный нагрев участка, °C */
  maxDT: number;
  tracks: number; pads: number; smd: number; vias: number;
  hotCount: number; warmCount: number;
}

/**
 * Палитра тепловизора: 0 — глубокий синий, 0.25 — циан, 0.5 — зелёный,
 * 0.75 — жёлтый, 1 — красный. Через HSL — гладко и без таблиц.
 */
export function thermalColor(t01: number): string {
  const t = Math.min(1, Math.max(0, t01));
  // 240° (синий) → 0° (красный), насыщенность и светлота с горбом в середине,
  // чтобы жёлто-зелёная середина читалась на тёмной плате
  const h = Math.round(240 * (1 - t));
  const l = Math.round(32 + 22 * Math.sin(Math.PI * Math.min(1, 0.15 + 0.85 * t)));
  return `hsl(${h},100%,${l}%)`;
}

/** Пороги «тёплый/горячий» относительно допустимого нагрева. */
export function thermalHot(dT: number, allowed: number): 0 | 1 | 2 {
  if (dT >= Math.max(allowed * 2, 30)) return 2;
  if (dT >= Math.max(allowed, 10)) return 1;
  return 0;
}

interface TouchNode {
  id: string;
  /** точки касания: концы дорожки или центр площадки/перехода */
  pts: { x: number; y: number }[];
  /** радиус «захвата» точки (площадки, переходы, SMD) */
  grab: number;
  /** отрезки дорожки — для Т-образных стыков */
  segs: { x1: number; y1: number; x2: number; y2: number }[];
}

const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

/** Точка на отрезке (с допуском)? */
function onSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number): boolean {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(px, py, x1, y1) < 1e-6;
  const t = ((px - x1) * dx + (py - y1) * dy) / len2;
  if (t < -1e-6 || t > 1 + 1e-6) return false;
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return dist(px, py, cx, cy) < 1e-6;
}

/** Касаются ли два узла (общий конец, Т-стык, конец в площадке)? */
function touches(a: TouchNode, b: TouchNode): boolean {
  for (const p of a.pts) {
    for (const q of b.pts) {
      if (dist(p.x, p.y, q.x, q.y) <= a.grab + b.grab + 1e-6) return true;
    }
    for (const s of b.segs) {
      if (onSeg(p.x, p.y, s.x1, s.y1, s.x2, s.y2)) return true;
    }
  }
  for (const q of b.pts) {
    for (const s of a.segs) {
      if (onSeg(q.x, q.y, s.x1, s.y1, s.x2, s.y2)) return true;
    }
  }
  return false;
}

/**
 * BFS от точки клика по графу касаний: hop — расстояние в «прыжках»,
 * flip — заходить ли в дорожку с конца (чтобы анимация тока шла от клика).
 * На больших цепях (>1500 узлов) граф не строим — всем hop 0.
 */
function bfsHops(net: Entity[], startId: string): Map<string, { hop: number; flip: boolean }> {
  const out = new Map<string, { hop: number; flip: boolean }>();
  if (net.length > 1500) return out;
  const nodes: TouchNode[] = [];
  for (const e of net) {
    if (e.kind === 'track') {
      const pts = e.pts;
      if (pts.length < 2) continue;
      const segs = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        segs.push({ x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y });
      }
      nodes.push({ id: e.id, pts: [pts[0], pts[pts.length - 1]], grab: 0, segs });
    } else if (e.kind === 'pad' || e.kind === 'via') {
      const r = Math.max(e.size / 2, e.drill / 2, 0.2);
      nodes.push({ id: e.id, pts: [{ x: e.x, y: e.y }], grab: r, segs: [] });
    } else if (e.kind === 'smd') {
      const r = Math.hypot(e.w, e.h) / 2;
      nodes.push({ id: e.id, pts: [{ x: e.x, y: e.y }], grab: Math.max(r, 0.2), segs: [] });
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // старт: кликнутый элемент или его родитель-компонент (id «comp:idx»)
  let start = byId.get(startId);
  if (!start && startId.includes(':')) start = byId.get(startId.split(':')[0]);
  if (!start) start = nodes[0];
  if (!start) return out;
  const adj = new Map<string, string[]>();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (!touches(nodes[i], nodes[j])) continue;
      const a = nodes[i].id, b = nodes[j].id;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a)!.push(b);
      adj.get(b)!.push(a);
    }
  }
  // BFS; для дорожек запоминаем, с какого конца вошли
  const hop = new Map<string, number>([[start.id, 0]]);
  const queue: string[] = [start.id];
  // входная точка в узел: откуда пришли
  const entry = new Map<string, { x: number; y: number }>();
  while (queue.length) {
    const cur = queue.shift()!;
    const curNode = byId.get(cur)!;
    const curHop = hop.get(cur)!;
    // точка, через которую ток входит в cur (для старта — его первая точка)
    const curEntry = entry.get(cur) ?? curNode.pts[0];
    for (const nb of adj.get(cur) ?? []) {
      if (hop.has(nb)) continue;
      hop.set(nb, curHop + 1);
      // точка касания cur↔nb — вход в nb: ближайшая к выходу из cur
      const nbNode = byId.get(nb)!;
      let best = nbNode.pts[0], bd = Infinity;
      const exits = curNode.pts.length > 1
        ? curNode.pts.reduce((f, p) => (dist(p.x, p.y, curEntry.x, curEntry.y) > dist(f.x, f.y, curEntry.x, curEntry.y) ? p : f))
        : curNode.pts[0];
      for (const p of nbNode.pts) {
        const d = dist(p.x, p.y, exits.x, exits.y);
        if (d < bd) { bd = d; best = p; }
      }
      entry.set(nb, best);
      queue.push(nb);
    }
  }
  for (const [id, h] of hop) {
    const n = byId.get(id);
    let flip = false;
    if (n && n.pts.length === 2) {
      const en = entry.get(id);
      // вошли со второго конца — рисуем задом наперёд
      if (en && dist(en.x, en.y, n.pts[1].x, n.pts[1].y) < dist(en.x, en.y, n.pts[0].x, n.pts[0].y)) flip = true;
    }
    out.set(id, { hop: h, flip });
  }
  return out;
}

/**
 * Тепловой расчёт цепи: keys — ключи связных компонентов меди (из
 * copperComponents), startId — id элемента под кликом.
 */
export function computeThermal(
  flat: Entity[], comp: Map<string, string>, keys: Set<string>,
  startId: string, currentA: number, thicknessUm: number, allowedRise: number,
): ThermalResult {
  const empty: ThermalResult = {
    segs: [], totalR: 0, totalDrop: 0, totalP: 0, maxDT: 0,
    tracks: 0, pads: 0, smd: 0, vias: 0, hotCount: 0, warmCount: 0,
  };
  const net = flat.filter((e) => {
    const k = comp.get(e.id);
    return k !== undefined && keys.has(k);
  });
  if (!net.length) return empty;
  const hops = bfsHops(net, startId);
  const segs: ThermalSeg[] = [];
  let tracks = 0, pads = 0, smd = 0, vias = 0;
  for (const e of net) {
    if (e.kind === 'pad') { pads++; continue; }
    if (e.kind === 'smd') { smd++; continue; }
    if (e.kind === 'via') { vias++; continue; }
    if (e.kind !== 'track') continue;
    tracks++;
    const len = polylineLength(e.pts);
    const res = trackResistance(e.w, len, thicknessUm);
    const dT = ipc2221TempRise(currentA, e.w, thicknessUm, true);
    const t = e as Track;
    segs.push({
      id: e.id, layer: t.layer, pts: t.pts, w: t.w, len, res,
      drop: currentA * res, dT, t01: 0,
      hop: hops.get(e.id)?.hop ?? 0, flip: hops.get(e.id)?.flip ?? false,
      hot: thermalHot(dT, allowedRise),
    });
  }
  let maxDT = 0;
  for (const s of segs) if (s.dT > maxDT) maxDT = s.dT;
  // шкала палитры: «горячий» порог — всегда красный
  const scale = Math.max(allowedRise * 2, 30, maxDT);
  let totalR = 0, hotCount = 0, warmCount = 0;
  for (const s of segs) {
    s.t01 = scale > 0 ? Math.min(1, s.dT / scale) : 0;
    totalR += s.res;
    if (s.hot === 2) hotCount++;
    else if (s.hot === 1) warmCount++;
  }
  return {
    segs, totalR, totalDrop: currentA * totalR, totalP: currentA * currentA * totalR,
    maxDT, tracks, pads, smd, vias, hotCount, warmCount,
  };
}
