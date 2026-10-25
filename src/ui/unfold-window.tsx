// Генератор развёрток — отдельное окно редактора чертежей.
//
// Открывается кнопкой «Развёртка» в тулбаре и работает как окно коробок:
// параметры слева, предпросмотр раскладки справа, готовые объекты уезжают на
// лист чертежа одной кнопкой. Слои для развёртки создаются автоматически
// (сплошные контуры, штриховые линии сгиба, заливка маркировки, служебный слой
// размеров) — редактор раскладывает их по своим слоям через `adoptShapes`.

import { useCallback, useMemo, useState } from 'react';
import { Modal } from './widgets';
import { Ic } from './icons';
import { UnfoldPanel } from './laser-panels';
import {
  DEFAULT_UNFOLD_PARAMS,
  UNFOLD_TEMPLATES,
  generateUnfolding,
  type UnfoldParams,
} from '../laser/unfold';
import {
  DEFAULT_LASER_LAYERS,
  docContourLength,
  newLaserDoc,
  selectionBBox,
  shapeToPolylines,
  type LaserDoc,
  type LaserGroup,
  type LaserShape,
} from '../laser/model';

/** Что окно отдаёт хозяину: объекты, группы и подпись для истории правок. */
export interface UnfoldApplyPayload {
  shapes: LaserShape[];
  groups: LaserGroup[];
  title: string;
}

export function UnfoldWindow({
  doc,
  onApply,
  onClose,
  onMsg,
}: {
  /** Документ редактора: нужны размер листа и толщина материала. */
  doc: LaserDoc;
  onApply: (p: UnfoldApplyPayload) => void;
  onClose: () => void;
  onMsg: (m: { text: string; ok: boolean }) => void;
}) {
  const [params, setParams] = useState<UnfoldParams>({
    ...DEFAULT_UNFOLD_PARAMS,
    thickness: doc.materialThickness || DEFAULT_UNFOLD_PARAMS.thickness,
  });
  const [busy, setBusy] = useState(false);
  const [built, setBuilt] = useState<UnfoldApplyPayload | null>(null);

  const generate = useCallback(() => {
    setBusy(true);
    window.setTimeout(() => {
      try {
        const full: UnfoldParams = {
          ...params,
          thickness: doc.materialThickness || params.thickness,
        };
        const { shapes, groups } = generateUnfolding(full, 12, 12, doc.w, doc.h);
        if (!shapes.length) {
          setBuilt(null);
          onMsg({ text: 'Развёртка не построена: проверьте размеры.', ok: false });
          return;
        }
        const tpl = UNFOLD_TEMPLATES.find((t) => t.id === full.template);
        setBuilt({ shapes, groups, title: tpl?.name ?? full.template });
        const bb = selectionBBox(shapes);
        const over = bb && (bb[2] - bb[0] > doc.w + 0.5 || bb[3] - bb[1] > doc.h + 0.5);
        onMsg({
          text: over
            ? `Развёртка ${(bb![2] - bb![0]).toFixed(0)}×${(bb![3] - bb![1]).toFixed(0)} мм больше листа `
              + `${doc.w}×${doc.h} мм — увеличьте лист или уменьшите деталь.`
            : `Развёртка построена: ${shapes.length} объектов, ${(bb![2] - bb![0]).toFixed(0)}×${(bb![3] - bb![1]).toFixed(0)} мм.`,
          ok: !over,
        });
      } catch (e) {
        setBuilt(null);
        onMsg({ text: e instanceof Error ? e.message : 'Ошибка генератора развёрток.', ok: false });
      } finally {
        setBusy(false);
      }
    }, 20);
  }, [params, doc.w, doc.h, doc.materialThickness, onMsg]);

  const apply = useCallback(() => {
    if (!built) {
      onMsg({ text: 'Сначала постройте развёртку.', ok: false });
      return;
    }
    onApply(built);
    onClose();
  }, [built, onApply, onClose, onMsg]);

  // ---------------- предпросмотр раскладки ----------------

  const bb = useMemo(() => (built ? selectionBBox(built.shapes) : null), [built]);
  const view = useMemo(() => {
    if (!built || !bb) return null;
    const pad = 6;
    const x0 = bb[0] - pad, y0 = bb[1] - pad;
    const w = Math.max(1, bb[2] - bb[0] + pad * 2);
    const h = Math.max(1, bb[3] - bb[1] + pad * 2);
    const lines = built.shapes.map((s) => ({
      color: DEFAULT_LASER_LAYERS[s.layer]?.color ?? '#ffc233',
      dash: s.layer === 'fold' ? '4 2' : undefined,
      polys: shapeToPolylines(s).filter((pl) => pl.length > 1),
    }));
    return { x0, y0, w, h, lines };
  }, [built, bb]);

  /** Длина контуров построенной развёртки — как в статус-баре редактора. */
  const stats = useMemo(() => {
    if (!built) return null;
    const tmp: LaserDoc = { ...newLaserDoc(doc.w, doc.h, built.title), shapes: built.shapes };
    return {
      count: built.shapes.length,
      lengthMm: docContourLength(tmp),
      sizeMm: bb ? `${(bb[2] - bb[0]).toFixed(1)} × ${(bb[3] - bb[1]).toFixed(1)}` : '—',
      fits: bb ? bb[2] - bb[0] <= doc.w + 0.5 && bb[3] - bb[1] <= doc.h + 0.5 : true,
    };
  }, [built, bb, doc.w, doc.h]);

  return (
    <Modal
      title="Генератор развёрток"
      className="unfold-win"
      onClose={onClose}
      foot={
        <>
          <span className="unfold-win-hint">
            Развёртка строится по толщине листа ({(doc.materialThickness || params.thickness).toFixed(1)} мм)
            и добавляется на лист чертежа {doc.w}×{doc.h} мм.
          </span>
          <button type="button" className="btn" onClick={onClose}>Закрыть</button>
          <button type="button" className="btn primary" onClick={apply} disabled={!built}>
            <Ic n="unfold" size={14} />
            <span>Перенести на лист</span>
          </button>
        </>
      }
    >
      <div className="unfold-win-body">
        <div className="unfold-win-params">
          <UnfoldPanel
            params={params}
            onParams={(patch) => setParams((p) => ({ ...p, ...patch }))}
            onGenerate={generate}
            busy={busy}
          />
        </div>
        <div className="unfold-win-preview">
          <h3>Предпросмотр</h3>
          {view ? (
            <svg
              className="unfold-win-svg"
              viewBox={`${view.x0} ${-view.y0 - view.h} ${view.w} ${view.h}`}
              preserveAspectRatio="xMidYMid meet"
            >
              {view.lines.map((l, i) =>
                l.polys.map((pl, k) => (
                  <polyline
                    key={`${i}-${k}`}
                    points={pl.map((p) => `${p.x},${-p.y}`).join(' ')}
                    fill="none"
                    stroke={l.color}
                    strokeDasharray={l.dash}
                    strokeWidth={Math.max(view.w, view.h) / 400}
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ))
              )}
            </svg>
          ) : (
            <p className="sub">
              Выберите шаблон, задайте размеры и нажмите «Построить развёртку на листе» —
              здесь появится раскладка, а объекты можно перенести на лист чертежа.
            </p>
          )}
          {stats && (
            <div className="unfold-win-stats">
              <div><span>Объектов</span><b>{stats.count}</b></div>
              <div><span>Габарит, мм</span><b>{stats.sizeMm}</b></div>
              <div><span>Длина контуров</span><b>{stats.lengthMm.toFixed(1)} мм</b></div>
              <div><span>Лист</span><b>{stats.fits ? 'влезает' : 'не влезает'}</b></div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
