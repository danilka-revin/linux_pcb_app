// Отрисовка документа на canvas 2D.

import type { Doc, Entity, LayerId, Pt } from './model';
import { expandComp } from './expand';

export interface View {
  s: number;    // пикселей на мм
  ox: number;   // пиксель X нуля координат
  oy: number;   // пиксель Y нуля координат
  mir: boolean; // вид снизу (зеркально)
}

export type ThemeId = 'dark' | 'light';

/** Цвета холста. Функциональные цвета слоёв (k1/k2/s1/both) общие для обеих
 *  тем — это «реальные» цвета меди и шелкографии; фон/сетка/выделение
 *  переключаются вместе с темой (см. setCanvasTheme). Объект мутируется
 *  на месте, поэтому все импортировавшие его получают новые значения. */
export const COLORS = {
  bg: '#0f1115',
  k1: '#2f80ed',
  k2: '#35c46a',
  s1: '#e5484d',
  s2: '#e8c93e',
  outline: '#e9ecf1',
  both: '#f0a63c',
  holeFill: '#0f1115',
  holeRing: 'rgba(233,236,241,.35)',
  sel: '#ffc233',
  probe: '#ffd23f',
  grid: '#232830',
  axes: '#3a414d',
};

/** Сервисные цвета canvas-оверлеев (черновики, подписи, перекрестие). */
export const CANVAS_UI = {
  ink: '#ffffff',
  labelBg: 'rgba(13,16,20,.88)',
  labelInk: '#a7b0bc',
  crosshair: 'rgba(255,255,255,.14)',
};

const CANVAS_THEMES: Record<ThemeId, { colors: typeof COLORS; ui: typeof CANVAS_UI }> = {
  dark: {
    colors: {
      bg: '#0f1115', k1: '#2f80ed', k2: '#35c46a', s1: '#e5484d', s2: '#e8c93e',
      outline: '#e9ecf1', both: '#f0a63c', holeFill: '#0f1115',
      holeRing: 'rgba(233,236,241,.35)', sel: '#ffc233', probe: '#ffd23f',
      grid: '#232830', axes: '#3a414d',
    },
    ui: { ink: '#ffffff', labelBg: 'rgba(13,16,20,.88)', labelInk: '#a7b0bc', crosshair: 'rgba(255,255,255,.14)' },
  },
  light: {
    colors: {
      bg: '#eef1f4', k1: '#2f80ed', k2: '#2aa35c', s1: '#d93a3f', s2: '#c9930a',
      outline: '#232a34', both: '#e08e00', holeFill: '#eef1f4',
      holeRing: 'rgba(35,42,52,.45)', sel: '#e08e00', probe: '#d97706',
      grid: '#d7dce3', axes: '#c2c9d2',
    },
    ui: { ink: '#232a34', labelBg: 'rgba(255,255,255,.92)', labelInk: '#45505c', crosshair: 'rgba(20,30,40,.13)' },
  },
};

export function setCanvasTheme(theme: ThemeId): void {
  Object.assign(COLORS, CANVAS_THEMES[theme].colors);
  Object.assign(CANVAS_UI, CANVAS_THEMES[theme].ui);
}

export const toWorld = (v: View, px: number, py: number): Pt => ({
  x: ((px - v.ox) / v.s) * (v.mir ? -1 : 1),
  y: (v.oy - py) / v.s,
});
const SX = (v: View, x: number): number => v.ox + x * v.s * (v.mir ? -1 : 1);
const SY = (v: View, y: number): number => v.oy - y * v.s;

export interface DrawOpts {
  hidden?: Set<LayerId>;
  tint?: string;          // перекрасить всё в один цвет (выделение, печать)
  alpha?: number;
  passes?: Set<string>;   // ограничение "проходов" для печати
  drillMarks?: boolean;   // для печати: белые точки в центрах отверстий
}

function passOf(e: Entity): string {
  switch (e.kind) {
    case 'pad': case 'via': return 'both';
    case 'hole': return 'holes';
    default: return (e as { layer?: string }).layer ?? 'outline';
  }
}

export function layerColor(l: LayerId | 'both'): string {
  return l === 'k1' ? COLORS.k1 : l === 'k2' ? COLORS.k2 : l === 's1' ? COLORS.s1
    : l === 's2' ? COLORS.s2 : l === 'outline' ? COLORS.outline : COLORS.both;
}

/** Отрисовка одного примитива (компоненты разворачиваются рекурсивно) */
export function drawEnt(
  ctx: CanvasRenderingContext2D, v: View, e: Entity, o: DrawOpts,
): void {
  if (e.kind === 'comp') {
    for (const sub of expandComp(e)) drawEnt(ctx, v, sub, o);
    return;
  }

  const pass = passOf(e);
  if (o.passes && !o.passes.has(pass)) return;

  const hidden = o.hidden;
  const layerOf = (e as { layer?: LayerId }).layer;
  const visible =
    pass === 'both'
      ? !(hidden?.has('k1') && hidden?.has('k2'))
      : pass === 'holes'
        ? true
        : layerOf
          ? !hidden?.has(layerOf)
          : true;
  if (!visible) return;

  const s = v.s;
  const col = o.tint ?? (pass === 'both' ? COLORS.both : layerOf ? COLORS[layerOf] : COLORS.outline);

  ctx.save();
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;

  const pathPts = (pts: Pt[]) => {
    ctx.beginPath();
    ctx.moveTo(SX(v, pts[0].x), SY(v, pts[0].y));
    for (let i = 1; i < pts.length; i++) ctx.lineTo(SX(v, pts[i].x), SY(v, pts[i].y));
  };

  switch (e.kind) {
    case 'pad': {
      ctx.fillStyle = col;
      const px = SX(v, e.x), py = SY(v, e.y), r = (e.size / 2) * s;
      ctx.beginPath();
      if (e.shape === 'square') ctx.rect(px - r, py - r, r * 2, r * 2);
      else if (e.shape === 'oct') {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
          const x = px + r * Math.cos(a), y = py + r * Math.sin(a);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
      } else ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill();
      // отверстие
      if (e.drill > 0) {
        ctx.beginPath();
        ctx.fillStyle = o.drillMarks && o.tint ? '#ffffff' : COLORS.holeFill;
        ctx.arc(px, py, Math.max((e.drill / 2) * s, o.tint ? (0.4 * s) : 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'via': {
      ctx.fillStyle = col;
      const px = SX(v, e.x), py = SY(v, e.y);
      ctx.beginPath();
      ctx.arc(px, py, (e.size / 2) * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.fillStyle = o.drillMarks && o.tint ? '#ffffff' : COLORS.holeFill;
      ctx.arc(px, py, Math.max((e.drill / 2) * s, 0.7), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'smd': {
      const rot = ((Math.round(e.rot) % 180) + 180) % 180;
      const w = (rot === 0 ? e.w : e.h) * s;
      const h = (rot === 0 ? e.h : e.w) * s;
      ctx.fillStyle = col;
      ctx.fillRect(SX(v, e.x) - w / 2, SY(v, e.y) - h / 2, w, h);
      break;
    }
    case 'track': {
      if (e.pts.length < 2) break;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(e.w * s, 0.7);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      pathPts(e.pts);
      ctx.stroke();
      break;
    }
    case 'line': {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(e.w * s, 0.6);
      ctx.lineCap = 'round';
      pathPts([{ x: e.x1, y: e.y1 }, { x: e.x2, y: e.y2 }]);
      ctx.stroke();
      break;
    }
    case 'circle': {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(e.w * s, 0.6);
      ctx.beginPath();
      ctx.arc(SX(v, e.x), SY(v, e.y), e.r * s, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'rect': {
      const x1 = SX(v, e.x), y1 = SY(v, e.y + e.h);
      const wpx = e.w * s, hpx = e.h * s;
      if (e.filled) {
        ctx.fillStyle = col;
        ctx.fillRect(x1, y1, wpx, hpx);
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(e.th * s, 0.6);
        ctx.strokeRect(x1, y1, wpx, hpx);
      }
      break;
    }
    case 'poly': {
      if (e.pts.length < 3) break;
      ctx.fillStyle = col;
      pathPts(e.pts);
      ctx.closePath();
      ctx.fill();
      // тонкий контур для видимости краёв
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(0.1 * s, 0.5);
      ctx.stroke();
      break;
    }
    case 'text': {
      if (!e.text) break;
      ctx.save();
      ctx.translate(SX(v, e.x), SY(v, e.y));
      if (v.mir) ctx.scale(-1, 1);
      ctx.rotate(v.mir ? (e.rot * Math.PI) / 180 : (-e.rot * Math.PI) / 180);
      if (e.mirror) ctx.scale(-1, 1);
      const px = e.size * s;
      ctx.font = `${px}px 'Segoe UI', system-ui, sans-serif`;
      ctx.fillStyle = col;
      ctx.textBaseline = 'alphabetic';
      // масштаб: высота заглавной ~0.7em -> корректируем
      ctx.scale(1 / 0.72, 1 / 0.72);
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      break;
    }
    case 'hole': {
      const px = SX(v, e.x), py = SY(v, e.y), r = (e.d / 2) * s;
      ctx.beginPath();
      ctx.fillStyle = o.tint ? (o.drillMarks ? '#ffffff' : o.tint) : COLORS.holeFill;
      ctx.arc(px, py, Math.max(r, o.tint ? 0.4 * s : 0.9), 0, Math.PI * 2);
      ctx.fill();
      if (!o.tint) {
        ctx.beginPath();
        ctx.strokeStyle = COLORS.holeRing;
        ctx.lineWidth = Math.max(0.12 * s, 0.6);
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
  }
  ctx.restore();
}

/** Площадки и переходы («пяточки») — всегда верхним слоем,
 *  чтобы залитые полигоны/дорожки, созданные позже, их не закрывали */
function isFoot(e: Entity): boolean {
  return e.kind === 'pad' || e.kind === 'via';
}

export function zOrdered(doc: Doc): Entity[] {
  const under: Entity[] = [], over: Entity[] = [];
  for (const e of doc.entities) {
    const subs = e.kind === 'comp' ? expandComp(e) : [e];
    for (const s of subs) (isFoot(s) ? over : under).push(s);
  }
  return [...under, ...over];
}

/** Документ целиком */
export function drawDoc(
  ctx: CanvasRenderingContext2D, v: View, doc: Doc, hidden: Set<LayerId>,
): void {
  for (const e of zOrdered(doc)) drawEnt(ctx, v, e, { hidden });
}

/** Печатный вид 1:1 для ЛУТ/фотошаблона (чёрным по белому) */
export function renderPrint(
  doc: Doc,
  layer: 'k1' | 'k2' | 's1' | 's2' | 'outline',
  mirror: boolean,
  dpi: number,
  drillMarks: boolean,
): HTMLCanvasElement {
  const s = dpi / 25.4;
  const M = 2; // поле, мм
  const wpx = Math.ceil((doc.w + 2 * M) * s);
  const hpx = Math.ceil((doc.h + 2 * M) * s);

  const cv = document.createElement('canvas');
  cv.width = wpx;
  cv.height = hpx;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, wpx, hpx);

  const v: View = {
    s,
    ox: mirror ? (doc.w + M) * s : M * s,
    oy: (doc.h + M) * s,
    mir: mirror,
  };
  const passes = new Set<string>([layer]);
  if (layer === 'k1' || layer === 'k2') passes.add('both');
  if (drillMarks) passes.add('holes');
  // тот же порядок, что и в редакторе: площадки/переходы поверх залитой меди
  for (const e of zOrdered(doc))
    drawEnt(ctx, v, e, { tint: '#000000', passes, drillMarks });
  return cv;
}
