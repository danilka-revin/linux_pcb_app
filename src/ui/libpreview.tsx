// Мини-предпросмотр макроса в панели библиотеки: сразу видно площадки,
// контур корпуса и подписи выводов.
import { useEffect, useRef } from 'react';
import { COLORS, drawDoc, type View } from '../pcb/render';
import { libBBox } from '../pcb/expand';
import type { Comp, Doc } from '../pcb/model';
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

export function LibPreview({ els, ents, bl, libKey, height = 132, pad = 1.5 }: LibPreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const draw = (): void => {
      const w = cv.clientWidth || 240;
      const h = height;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
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
      const s = Math.min((w - 16) / (bw + 2 * pad), (h - 16) / (bh + 2 * pad));
      const view: View = {
        s, ox: w / 2 - ((x1 + x2) / 2) * s, oy: h / 2 + ((y1 + y2) / 2) * s, mir: false,
      };
      const doc: Doc = { name: '', w: bw, h: bh, entities: [comp] };
      drawDoc(ctx, view, doc, new Set());
      // масштабная линейка: 5 мм, если влезает
      const bar = 5;
      if (bar * s < w * 0.4) {
        ctx.strokeStyle = COLORS.gridMajor;
        ctx.fillStyle = COLORS.gridMajor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(8, h - 8);
        ctx.lineTo(8 + bar * s, h - 8);
        ctx.stroke();
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`${bar} мм`, 8, h - 12);
      }
    };
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [els, ents, bl, libKey, height, pad]);

  return <canvas ref={ref} className="lib-preview" style={{ width: '100%', height }} />;
}
