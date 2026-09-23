// Экспорт Gerber RS-274X (слои меди, шелкография, контур) и Excellon (сверловка).

import type { Doc, Entity, LayerId, Pt } from './model';
import { expandDoc } from './expand';
import { textPolylines } from './strokefont';

type Op =
  | { t: 'flash'; ap: string; x: number; y: number }
  | { t: 'path'; ap: string; pts: Pt[] }
  | { t: 'region'; pts: Pt[] }
  | { t: 'arc'; ap: string; cx: number; cy: number; r: number };

const f3 = (v: number): string => String(parseFloat(v.toFixed(4)));

function padAp(shape: string, size: number): string {
  if (shape === 'square') return `R,${f3(size)}X${f3(size)}`;
  if (shape === 'oct') return `P,${f3(size)}X8X22.5`;
  return `C,${f3(size)}`;
}

/** Собирает список графических операций для конкретного слоя */
function collectOps(doc: Doc, layer: LayerId): Op[] {
  const ops: Op[] = [];
  const isCu = layer === 'k1' || layer === 'k2';
  const isSilk = layer === 's1' || layer === 's2';

  const addText = (e: Extract<Entity, { kind: 'text' }>) => {
    const sc = e.size / 10;
    const a = (e.rot * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (const seg of textPolylines(e.text)) {
      const tp = seg.map((p) => {
        const mx = e.mirror ? -p.x : p.x;
        const x = mx * sc, y = p.y * sc;
        return { x: e.x + x * ca - y * sa, y: e.y + x * sa + y * ca };
      });
      ops.push({ t: 'path', ap: `C,${f3(e.th)}`, pts: tp });
    }
  };

  for (const e of expandDoc(doc.entities)) {
    switch (e.kind) {
      case 'pad':
        if (isCu) ops.push({ t: 'flash', ap: padAp(e.shape, e.size), x: e.x, y: e.y });
        break;
      case 'via':
        if (isCu) ops.push({ t: 'flash', ap: `C,${f3(e.size)}`, x: e.x, y: e.y });
        break;
      case 'smd':
        if (e.layer === layer) {
          const rot = ((Math.round(e.rot) % 180) + 180) % 180;
          const w = rot === 0 ? e.w : e.h;
          const h = rot === 0 ? e.h : e.w;
          ops.push({ t: 'flash', ap: `R,${f3(w)}X${f3(h)}`, x: e.x, y: e.y });
        }
        break;
      case 'track':
        if (e.layer === layer && e.pts.length > 1)
          ops.push({ t: 'path', ap: `C,${f3(e.w)}`, pts: e.pts });
        break;
      case 'line':
        if (e.layer === layer)
          ops.push({ t: 'path', ap: `C,${f3(e.w)}`, pts: [{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }] });
        break;
      case 'circle':
        if (e.layer === layer)
          ops.push({ t: 'arc', ap: `C,${f3(e.w)}`, cx: e.x, cy: e.y, r: e.r });
        break;
      case 'rect': {
        if (e.layer !== layer) break;
        const c: Pt[] = [
          { x: e.x, y: e.y }, { x: e.x + e.w, y: e.y },
          { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h },
        ];
        if (e.filled) ops.push({ t: 'region', pts: c });
        else ops.push({ t: 'path', ap: `C,${f3(e.th)}`, pts: [...c, c[0]] });
        break;
      }
      case 'poly':
        if (e.layer === layer && e.pts.length > 2) ops.push({ t: 'region', pts: e.pts });
        break;
      case 'text':
        if (e.layer === layer && isSilk) addText(e);
        break;
      default:
        break;
    }
  }

  // контур по умолчанию, если пользователь его удалил
  if (layer === 'outline' && !ops.length) {
    const c: Pt[] = [
      { x: 0, y: 0 }, { x: doc.w, y: 0 }, { x: doc.w, y: doc.h }, { x: 0, y: doc.h },
    ];
    ops.push({ t: 'path', ap: 'C,0.1', pts: [...c, c[0]] });
  }
  return ops;
}

export function gerberLayer(doc: Doc, layer: LayerId, title: string): string {
  const ops = collectOps(doc, layer);
  const apIds = new Map<string, number>();
  let next = 10;
  const apId = (ap: string): number => {
    if (!apIds.has(ap)) apIds.set(ap, next++);
    return apIds.get(ap)!;
  };
  for (const o of ops) if (o.t !== 'region') apId(o.ap);
  if (ops.some((o) => o.t === 'region')) apId('C,0.1');

  const N = (v: number): string => Math.round(v * 10000).toString();
  const out: string[] = [];
  out.push(`G04 ${title} *`);
  out.push('G04 LayOut (linux_pcb_app) RS-274X *');
  out.push('%FSLAX34Y34*%');
  out.push('%MOMM*%');
  out.push('%LPD*%');
  for (const [ap, id] of [...apIds.entries()].sort((a, b) => a[1] - b[1]))
    out.push(`%ADD${id}${ap}*%`);
  if (ops.some((o) => o.t === 'arc')) out.push('G75*%');
  out.push('G01*');

  let cur = 0;
  const sel = (id: number) => {
    if (id !== cur) { out.push(`D${id}*`); cur = id; }
  };
  const move = (p: Pt) => out.push(`X${N(p.x)}Y${N(p.y)}D02*`);
  const draw = (p: Pt) => out.push(`X${N(p.x)}Y${N(p.y)}D01*`);

  for (const o of ops) {
    if (o.t === 'flash') {
      sel(apId(o.ap));
      out.push(`X${N(o.x)}Y${N(o.y)}D03*`);
    } else if (o.t === 'path') {
      sel(apId(o.ap));
      move(o.pts[0]);
      for (let i = 1; i < o.pts.length; i++) draw(o.pts[i]);
    } else if (o.t === 'region') {
      sel(apId('C,0.1'));
      out.push('G36*');
      move(o.pts[0]);
      for (let i = 1; i < o.pts.length; i++) draw(o.pts[i]);
      draw(o.pts[0]);
      out.push('G37*');
    } else if (o.t === 'arc') {
      sel(apId(o.ap));
      move({ x: o.cx + o.r, y: o.cy });
      out.push(`G02X${N(o.cx + o.r)}Y${N(o.cy)}I${N(-o.r)}J${N(0)}D01*`);
    }
  }
  out.push('M02*');
  return out.join('\n') + '\n';
}

/** Сверловка Excellon: все отверстия (площадки, переходы, монтажные) */
export function excellon(doc: Doc): string {
  const holes: { d: number; x: number; y: number }[] = [];
  for (const e of expandDoc(doc.entities)) {
    if (e.kind === 'pad' && e.drill > 0) holes.push({ d: e.drill, x: e.x, y: e.y });
    else if (e.kind === 'via' && e.drill > 0) holes.push({ d: e.drill, x: e.x, y: e.y });
    else if (e.kind === 'hole') holes.push({ d: e.d, x: e.x, y: e.y });
  }
  const tools = [...new Set(holes.map((h) => Math.round(h.d * 100) / 100))].sort((a, b) => a - b);
  const out: string[] = [];
  out.push('M48');
  out.push('; LayOut Excellon drill file');
  out.push('METRIC,TZ');
  tools.forEach((d, i) => out.push(`T${i + 1}C${d.toFixed(3)}`));
  out.push('%');
  tools.forEach((d, i) => {
    out.push(`T${i + 1}`);
    for (const h of holes)
      if (Math.abs(h.d - d) < 0.005)
        out.push(`X${h.x.toFixed(3)}Y${h.y.toFixed(3)}`);
  });
  out.push('M30');
  return out.join('\n') + '\n';
}

/** Все файлы производства */
export function productionFiles(doc: Doc): { name: string; data: string }[] {
  const base = doc.name.replace(/[^\wа-яА-ЯёЁ-]+/g, '_') || 'board';
  return [
    { name: `${base}_K1_verh.gtl`, data: gerberLayer(doc, 'k1', 'Top copper (K1)') },
    { name: `${base}_K2_niz.gbl`, data: gerberLayer(doc, 'k2', 'Bottom copper (K2)') },
    { name: `${base}_SH1_verh.gto`, data: gerberLayer(doc, 's1', 'Top silkscreen (S1)') },
    { name: `${base}_SH2_niz.gbo`, data: gerberLayer(doc, 's2', 'Bottom silkscreen (S2)') },
    { name: `${base}_kontur.gm1`, data: gerberLayer(doc, 'outline', 'Board outline') },
    { name: `${base}_sverlovka.xln`, data: excellon(doc) },
  ];
}
