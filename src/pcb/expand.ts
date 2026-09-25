// Развёртка компонентов (Comp) в список примитивов для отрисовки/экспорта.

import type { Comp, Entity, LayerId, Pt } from './model';
import { bboxOf, type LibEl } from './footprint';

/**
 * Примитивы генератора (LibEl, локальные мм) → сущности компонента (Entity).
 * Так сгенерированная деталь становится самодостаточной: она ставится на плату,
 * сохраняется в библиотеку и экспортируется без всякого каталога.
 */
export function libElsToEnts(els: LibEl[]): Entity[] {
  const out: Entity[] = [];
  els.forEach((el, i) => {
    const id = `l${i}`;
    switch (el.kind) {
      case 'pad': out.push({ kind: 'pad', id, x: el.x, y: el.y, shape: el.shape, size: el.size, drill: el.drill }); break;
      case 'smd': out.push({ kind: 'smd', id, x: el.x, y: el.y, w: el.w, h: el.h, rot: ((el.rot % 180) + 180) % 180, layer: el.layer }); break;
      case 'hole': out.push({ kind: 'hole', id, x: el.x, y: el.y, d: el.d }); break;
      case 'line': out.push({ kind: 'line', id, x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2, w: el.w, layer: el.layer }); break;
      case 'rect': out.push({ kind: 'rect', id, x: el.x, y: el.y, w: el.w, h: el.h, filled: false, th: el.th, layer: el.layer }); break;
      case 'circle': out.push({ kind: 'circle', id, x: el.x, y: el.y, r: el.r, w: el.w, layer: el.layer }); break;
      case 'text': out.push({
        kind: 'text', id, x: el.x, y: el.y, size: el.size, th: el.th,
        rot: ((el.rot % 360) + 360) % 360, text: el.text, mirror: el.mirror, layer: el.layer,
      }); break;
      default: break;
    }
  });
  return out;
}

/** Трансформация локальных координат компонента в мировые */
export function compTF(c: Comp): (p: Pt) => Pt {
  const a = (c.rot * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const m = c.side === 'bottom' ? -1 : 1;
  return (p: Pt) => {
    const x = p.x * m;
    return { x: c.x + x * ca - p.y * sa, y: c.y + x * sa + p.y * ca };
  };
}

function remapLayer(l: string, side: 'top' | 'bottom'): string {
  if (side === 'top') return l;
  if (l === 'k1') return 'k2';
  if (l === 's1') return 's2';
  return l;
}

/** Преобразование примитива, встроенного в компонент (локальные координаты → плата) */
function xformEmbedded(e: Entity, c: Comp, tf: (p: Pt) => Pt, idx: string): Entity[] {
  const bottom = c.side === 'bottom';
  const rl = (l: LayerId) => remapLayer(l, c.side) as LayerId;
  const rc = (l: LayerId): 'k1' | 'k2' => (remapLayer(l, c.side) === 'k2' ? 'k2' : 'k1');
  switch (e.kind) {
    case 'pad': { const p = tf(e); return [{ ...e, id: idx, x: p.x, y: p.y }]; }
    case 'via': { const p = tf(e); return [{ ...e, id: idx, x: p.x, y: p.y }]; }
    case 'hole': { const p = tf(e); return [{ ...e, id: idx, x: p.x, y: p.y }]; }
    case 'smd': {
      const p = tf(e);
      return [{ ...e, id: idx, x: p.x, y: p.y, rot: (e.rot + c.rot + 360) % 180, layer: rl(e.layer) as 'k1' | 'k2' }];
    }
    case 'line': {
      const a = tf({ x: e.x1, y: e.y1 }), b = tf({ x: e.x2, y: e.y2 });
      return [{ ...e, id: idx, x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: rl(e.layer) }];
    }
    case 'rect': {
      // поворот на не-кратный 90° — разворачиваем в линии/полигон
      if (Math.abs(c.rot % 90) < 0.001) {
        const a = tf({ x: e.x, y: e.y }), b = tf({ x: e.x + e.w, y: e.y + e.h });
        return [{ ...e, id: idx, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), layer: rl(e.layer) }];
      }
      const cs = [{ x: e.x, y: e.y }, { x: e.x + e.w, y: e.y }, { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h }];
      if (e.filled) return [{ kind: 'poly', id: idx, pts: cs.map(tf), layer: rc(e.layer) }];
      return cs.map((p, i) => {
        const b = tf(cs[(i + 1) % 4]);
        return { kind: 'line', id: `${idx}.${i}`, x1: tf(p).x, y1: tf(p).y, x2: b.x, y2: b.y, w: e.th, layer: rl(e.layer) } as Entity;
      });
    }
    case 'circle': { const p = tf(e); return [{ ...e, id: idx, x: p.x, y: p.y, layer: rl(e.layer) }]; }
    case 'text': {
      const p = tf(e);
      const rot = ((bottom ? c.rot - e.rot : c.rot + e.rot) % 360 + 360) % 360;
      return [{ ...e, id: idx, x: p.x, y: p.y, rot, mirror: bottom ? !e.mirror : e.mirror, layer: rl(e.layer) }];
    }
    case 'track': return [{ ...e, id: idx, pts: e.pts.map(tf), layer: rc(e.layer) }];
    case 'poly': return [{ ...e, id: idx, pts: e.pts.map(tf), layer: rc(e.layer) }];
    case 'comp': return []; // вложенные компоненты не поддерживаем
    default: return [];
  }
}

/** Компонент -> примитивы (id вида "compId:idx") */
export function expandComp(c: Comp): Entity[] {
  if (c.ents && c.ents.length) {
    const tf = compTF(c);
    return c.ents.flatMap((e, i) => xformEmbedded(e, c, tf, c.id + ':' + i));
  }
  return []; // каталога макросов больше нет: деталь хранит свои примитивы
}

/** Весь документ -> плоский список примитивов */
export function expandDoc(entities: Entity[]): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    if (e.kind === 'comp') out.push(...expandComp(e));
    else out.push(e);
  }
  return out;
}

/** Локальный габарит примитивов генератора (одна математика с model.entBBox) */
export const libBBox = bboxOf;
