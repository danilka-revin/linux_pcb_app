// Развёртка компонентов (Comp) в список примитивов для отрисовки/экспорта.

import type { Comp, Entity, LayerId, Pt } from './model';
import { LIB, type LibEl } from './library';

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

/** Преобразование встроенного примитива компонента (макрос) */
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
  const entry = LIB[c.lib];
  if (!entry) return [];
  const tf = compTF(c);
  const out: Entity[] = [];
  entry.build().forEach((el, i) => {
    const id = c.id + ':' + i;
    switch (el.kind) {
      case 'pad': {
        const p = tf(el);
        out.push({ kind: 'pad', id, x: p.x, y: p.y, shape: el.shape, size: el.size, drill: el.drill });
        break;
      }
      case 'smd': {
        const p = tf(el);
        out.push({
          kind: 'smd', id, x: p.x, y: p.y, w: el.w, h: el.h,
          rot: (el.rot + c.rot + 360) % 180,
          layer: remapLayer(el.layer, c.side) as 'k1' | 'k2',
        });
        break;
      }
      case 'hole': {
        const p = tf(el);
        out.push({ kind: 'hole', id, x: p.x, y: p.y, d: el.d });
        break;
      }
      case 'line': {
        const a = tf({ x: el.x1, y: el.y1 }), b = tf({ x: el.x2, y: el.y2 });
        out.push({ kind: 'line', id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: el.w, layer: remapLayer(el.layer, c.side) as LayerId });
        break;
      }
      case 'rect': {
        const a = tf({ x: el.x, y: el.y }), b = tf({ x: el.x + el.w, y: el.y + el.h });
        out.push({
          kind: 'rect', id,
          x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
          w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y),
          filled: false, th: el.th, layer: remapLayer(el.layer, c.side) as LayerId,
        });
        break;
      }
      case 'circle': {
        const p = tf(el);
        out.push({ kind: 'circle', id, x: p.x, y: p.y, r: el.r, w: el.w, layer: remapLayer(el.layer, c.side) as LayerId });
        break;
      }
    }
  });
  return out;
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

/** Локальный bbox элементов макроса */
export function libBBox(els: LibEl[]): [number, number, number, number] {
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  const grow = (ax: number, ay: number) => {
    x1 = Math.min(x1, ax); y1 = Math.min(y1, ay);
    x2 = Math.max(x2, ax); y2 = Math.max(y2, ay);
  };
  for (const el of els) {
    switch (el.kind) {
      case 'pad': grow(el.x - el.size / 2, el.y - el.size / 2); grow(el.x + el.size / 2, el.y + el.size / 2); break;
      case 'smd': grow(el.x - el.w / 2, el.y - el.h / 2); grow(el.x + el.w / 2, el.y + el.h / 2); break;
      case 'hole': grow(el.x - el.d / 2, el.y - el.d / 2); grow(el.x + el.d / 2, el.y + el.d / 2); break;
      case 'line': {
        const m = el.w / 2;
        grow(Math.min(el.x1, el.x2) - m, Math.min(el.y1, el.y2) - m);
        grow(Math.max(el.x1, el.x2) + m, Math.max(el.y1, el.y2) + m);
        break;
      }
      case 'rect': grow(el.x, el.y); grow(el.x + el.w, el.y + el.h); break;
      case 'circle': grow(el.x - el.r, el.y - el.r); grow(el.x + el.r, el.y + el.r); break;
    }
  }
  if (x1 > x2) return [-2.54, -2.54, 2.54, 2.54];
  return [x1, y1, x2, y2];
}
