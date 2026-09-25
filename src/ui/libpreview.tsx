// Мини-предпросмотр макроса в панели библиотеки: компонент на фоне сетки,
// с точкой привязки (0;0), габаритной рамкой с размерами в мм и адаптивной
// масштабной линейкой. Перерисовка — по изменению входа, размера и темы.
import { useEffect, useRef } from 'react';
import { COLORS, drawDoc, type View } from '../pcb/render';
import { drawGrid, type GridConf } from '../pcb/grid';
import { libBBox } from '../pcb/expand';
import { fmt, type Comp, type Doc } from '../pcb/model';
import type { LibEl } from '../pcb/library';

export interface LibPreviewProps {
  /** макрос библиотеки (элементы строятся на месте) */
  els?: LibEl[];
  /** или сохранённый макрос пользователя */
  ents?: Comp['ents'];
  bl?: [number, number, number, number];
  /** ключ макроса библиотеки: компонент разворачивается через LIB */
  libKey?: string;
  height?: number;
  /** мм вокруг макроса */
  pad?: number;
}

/** «Красивый» шаг фоновой сетки: минимальный, дающий клетку ≥ 16 px */
function niceGridStep(worldSpan: number, scale: number): number {
  const steps = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500];
  for (const s of steps) if (s * scale >= 16) return s;
  return steps[steps.length - 1];
}

/** Длина масштабной линейки: 1/2/5 × 10^k мм, чтобы уложиться в ~38% ширины */
function niceBar(scale: number, maxPx: number): number | null {
  const cands = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  let best: number | null = null;
  for (const c of cands) if (c * scale <= maxPx) best = c;
  return best;
}

export function LibPreview({ els, ents, bl, libKey, height = 140, pad = 1.5 }: LibPreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const draw = (): void => {
      const w = cv.clientWidth || 240;
      const h = height;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) cv.width = Math.round(w * dpr);
      if (cv.height !== Math.round(h * dpr)) cv.height = Math.round(h * dpr);
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, w, h);

      const comp: Comp = {
        id: 'preview', kind: 'comp', lib: libKey ?? '', name: '',
        x: 0, y: 0, rot: 0, side: 'top',
        bl: bl ?? (els ? libBBox(els) : [-1, -1, 1, 1]),
        ...(ents ? { ents } : {}),
      };
      const [x1, y1, x2, y2] = comp.bl;
      const bw = Math.max(0.5, x2 - x1), bh = Math.max(0.5, y2 - y1);
      // поля: слева/снизу — линейка и размеры, сверху/справа — подпись габарита
      const m = 18;
      const s = Math.min((w - 2 * m) / (bw + 2 * pad), (h - 2 * m) / (bh + 2 * pad));
      if (!isFinite(s) || s <= 0) return;
      const view: View = {
        s, ox: w / 2 - ((x1 + x2) / 2) * s, oy: h / 2 + ((y1 + y2) / 2) * s, mir: false,
      };

      // ---- фон: сетка (как в редакторе, но мягче) ----
      const gs = niceGridStep(Math.max(bw, bh), s);
      const gconf: GridConf = {
        step: gs, unit: 'mm', style: 'lines', div: 1, major: 5,
        ox: 0, oy: 0, snap: false, snapObj: false, snapPx: 10,
      };
      ctx.save();
      ctx.globalAlpha = 0.75;
      drawGrid(ctx, gconf, view, w, h, {
        minor: COLORS.grid, major: COLORS.gridMajor, origin: COLORS.gridOrigin,
      }, dpr);
      ctx.restore();

      // ---- сам компонент ----
      const doc: Doc = { name: '', w: bw, h: bh, entities: [comp] };
      drawDoc(ctx, view, doc, new Set());

      // ---- габаритная рамка макроса (пунктир) ----
      const px1 = view.ox + x1 * s, px2 = view.ox + x2 * s;
      const py1 = view.oy - y1 * s, py2 = view.oy - y2 * s;
      ctx.save();
      ctx.strokeStyle = COLORS.gridOrigin;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(px1, px2) + 0.5, Math.min(py1, py2) + 0.5,
        Math.abs(px2 - px1), Math.abs(py1 - py2));
      ctx.restore();

      // ---- точка привязки (0;0): туда встанет курсор при установке ----
      const o = { px: view.ox, py: view.oy };
      ctx.save();
      ctx.strokeStyle = COLORS.sel;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(o.px - 5.5, o.py + 0.5); ctx.lineTo(o.px + 5.5, o.py + 0.5);
      ctx.moveTo(o.px + 0.5, o.py - 5.5); ctx.lineTo(o.px + 0.5, o.py + 5.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(o.px + 0.5, o.py + 0.5, 2.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // ---- подпись габарита (справа сверху) ----
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.gridOrigin;
      ctx.fillText(`${fmt(bw)} × ${fmt(bh)} мм`, w - 7, 13);
      ctx.textAlign = 'left';

      // ---- масштабная линейка (слева снизу): 1/2/5 × 10^k ----
      const bar = niceBar(s, w * 0.38);
      if (bar) {
        const bx = 8, by = h - 9, len = bar * s;
        ctx.strokeStyle = COLORS.gridMajor;
        ctx.fillStyle = COLORS.gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(bx + 0.5, by - 3.5); ctx.lineTo(bx + 0.5, by + 0.5);
        ctx.lineTo(bx + len, by + 0.5); ctx.lineTo(bx + len, by - 3.5);
        ctx.stroke();
        ctx.font = '9.5px system-ui, sans-serif';
        ctx.fillText(`${fmt(bar)} мм`, bx, by - 6);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    window.addEventListener('psbees:theme', draw);
    return () => {
      ro.disconnect();
      window.removeEventListener('psbees:theme', draw);
    };
  }, [els, ents, bl, libKey, height, pad]);

  return <canvas ref={ref} className="lib-preview" style={{ width: '100%', height }} />;
}
