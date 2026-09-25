// Мини-предпросмотр макроса: компонент на фоне сетки, с точкой привязки (0;0),
// габаритной рамкой с размерами в мм и адаптивной масштабной линейкой.
// Перерисовка — по изменению входа, размера и темы.
// LibPreviewDialog — тот же предпросмотр, но всплывающим окном поверх платы:
// ничего не перекрывается холстом, а «Добавить на плату» ставит макрос в центр
// вида — целиться курсором в список не нужно.
import { useEffect, useRef } from 'react';
import { COLORS, drawDoc, type View } from '../pcb/render';
import { drawGrid, type GridConf } from '../pcb/grid';
import { libBBox } from '../pcb/expand';
import { fmt, type Comp, type Doc } from '../pcb/model';
import type { LibEl } from '../pcb/library';
import { Modal, SI } from './widgets';

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
  /** поворот макроса при установке, ° (0/90/180/270) */
  rot?: number;
  /** сторона установки */
  side?: 'top' | 'bottom';
}

/**
 * Габарит макроса после поворота/переноса на другую сторону — та же формула,
 * что у compTF (expand.ts), но для четырёх углов рамки: предпросмотр кадрируем
 * по реально нарисованному компоненту.
 */
function rotBBox(
  bl: [number, number, number, number], rot: number, side: 'top' | 'bottom',
): [number, number, number, number] {
  const a = (rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const m = side === 'bottom' ? -1 : 1;
  const pts = [[bl[0], bl[1]], [bl[2], bl[1]], [bl[2], bl[3]], [bl[0], bl[3]]].map(([x, y]) => {
    const xx = x * m;
    return [xx * ca - y * sa, xx * sa + y * ca];
  });
  const xs = pts.map((p2) => p2[0]), ys = pts.map((p2) => p2[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
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

export function LibPreview({
  els, ents, bl, libKey, height = 140, pad = 1.5, rot = 0, side = 'top',
}: LibPreviewProps) {
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

      const localBL = bl ?? (els ? libBBox(els) : [-1, -1, 1, 1]);
      const comp: Comp = {
        id: 'preview', kind: 'comp', lib: libKey ?? '', name: '',
        x: 0, y: 0, rot, side,
        bl: localBL,
        ...(ents ? { ents } : {}),
      };
      // габарит — уже с учётом поворота и стороны: рамка, кадрирование и
      // подпись размеров совпадают с тем, что встанет на плату
      const [x1, y1, x2, y2] = rotBBox(localBL, rot, side);
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
  }, [els, ents, bl, libKey, height, pad, rot, side]);

  return <canvas ref={ref} className="lib-preview" style={{ width: '100%', height }} />;
}

export interface LibPreviewDialogProps extends LibPreviewProps {
  /** название макроса — в заголовок окна */
  title: string;
  /** характеристики строкой: «8 выводов · шаг 2.54 мм» */
  spec?: string;
  /** примечание к макросу (подписи выводов и т. п.) */
  note?: string;
  /** поставить макрос в центр видимой области платы */
  onAdd?: () => void;
  /** смена поворота/стороны будущей установки (клавиши R и Q прямо в окне) */
  onRot?: (rot: number) => void;
  onSide?: (side: 'top' | 'bottom') => void;
  onClose: () => void;
}

/**
 * Предпросмотр макроса отдельным окном поверх платы. Поворот (R) и сторону (Q)
 * видно прямо здесь, а «Добавить на плату» ставит макрос в центр вида — целиться
 * курсором мимо списка библиотеки больше не нужно.
 */
export function LibPreviewDialog({
  title, spec, note, onAdd, onRot, onSide, onClose,
  rot = 0, side = 'top', height = 340, ...pv
}: LibPreviewDialogProps) {
  // R/Q действуют, пока окно открыто (общий обработчик платы в это время спит)
  useEffect(() => {
    if (!onRot && !onSide) return;
    const h = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'KeyR' && onRot) { onRot((rot + 90) % 360); e.preventDefault(); }
      else if (e.code === 'KeyQ' && onSide) { onSide(side === 'top' ? 'bottom' : 'top'); e.preventDefault(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [rot, side, onRot, onSide]);

  return (
    <Modal
      title={title}
      className="libpv"
      onClose={onClose}
      foot={<>
        <button className="btn" onClick={onClose}>Закрыть</button>
        <span style={{ flex: 1 }} />
        {onAdd && (
          <button
            className="btn primary"
            onClick={onAdd}
            title="Поставить макрос в центр видимой области платы (с привязкой к сетке)"
          >
            Добавить на плату
          </button>
        )}
      </>}
    >
      <LibPreview {...pv} rot={rot} side={side} height={height} />
      {(onRot || onSide) && (
        <div className="row libpv-row">
          {onRot && (
            <SI
              label="Поворот"
              value={String(rot)}
              options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]}
              on={(v) => onRot((Number(v) + 360) % 360)}
            />
          )}
          {onSide && (
            <SI
              label="Сторона"
              value={side}
              options={[['top', 'Сверху (K1)'], ['bottom', 'Снизу (K2)']]}
              on={(v) => onSide(v === 'bottom' ? 'bottom' : 'top')}
            />
          )}
        </div>
      )}
      {spec && <div className="libpv-spec">{spec}</div>}
      {note && <div className="libpv-note">{note}</div>}
      <div className="libpv-note">
        Перекрестие — точка привязки макроса (0;0): за неё он «берётся» курсором при
        установке кликом. «Добавить на плату» ставит макрос в центр вида, после чего
        можно доставлять копии кликами по плате. <span className="kbd">R</span> — поворот,
        {' '}<span className="kbd">Q</span> — сторона, <span className="kbd">Esc</span> — закрыть.
      </div>
    </Modal>
  );
}
