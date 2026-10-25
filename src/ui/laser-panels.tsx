// Панели редактора чертежей: слои, свойства объекта, дерево объектов,
// генератор развёрток, толщина листа и сводка задания (станочная часть под MACHINE_UI).
// Всё в общем стиле PSBees (виджеты NI/TI/SI, классы .props/.field/.btn).
// Станочные поля (мощность, скорость, проходы, керф, обдув) показываются только
// при MACHINE_UI — см. src/laser/features.ts.

import { useMemo, useState } from 'react';
import { NI, SI, TI, TIC } from './widgets';
import { Ic } from './icons';
import {
  LASER_LAYER_ORDER,
  MATERIAL_PRESETS,
  shapeBBox,
  type AlignMode,
  type BooleanOp,
  type LaserDoc,
  type LaserLayerConfig,
  type LaserLayerId,
  type LaserShape,
  type MaterialPreset,
} from '../laser/model';
import { UNFOLD_TEMPLATES, type UnfoldParams } from '../laser/unfold';
import { MACHINE_UI } from '../laser/features';
import type { TrimMode } from '../laser/trim';
import type { LaserSimulation } from '../laser/export';

/** Подсказка назначения слоя — для всплывающего текста в списке слоёв. */
const LAYER_HINT: Record<LaserLayerConfig['mode'], string> = {
  cut: 'внешний контур детали',
  fold: 'линия сгиба (пунктир)',
  score: 'тонкая разметка',
  fill: 'заливка области',
  guide: 'служебный, не выводится в файлы',
};

/** Названия слоёв для выпадающих списков (берём короткие имена из документа). */
export function layerOptions(doc: LaserDoc): [string, string][] {
  return LASER_LAYER_ORDER.map((id) => [id, doc.layers[id]?.short ?? id]);
}

// ---------------- слои чертежа ----------------

export function LaserLayersPanel({
  doc,
  active,
  onActive,
  onPatch,
  onToggleVisible,
  onToggleLock,
  onShowAll,
}: {
  doc: LaserDoc;
  active: LaserLayerId;
  onActive: (id: LaserLayerId) => void;
  onPatch: (id: LaserLayerId, patch: Partial<LaserLayerConfig>) => void;
  onToggleVisible: (id: LaserLayerId) => void;
  onToggleLock: (id: LaserLayerId) => void;
  onShowAll: () => void;
}) {
  const counts = useMemo(() => {
    const map = new Map<LaserLayerId, number>();
    for (const s of doc.shapes) {
      if (s.hidden) continue;
      map.set(s.layer, (map.get(s.layer) ?? 0) + 1);
    }
    return map;
  }, [doc.shapes]);

  const cfg = doc.layers[active];

  return (
    <>
      <h3>{MACHINE_UI ? 'Слои станка' : 'Слои чертежа'}</h3>
      <div className="laser-layers">
        {LASER_LAYER_ORDER.map((id) => {
          const l = doc.layers[id];
          if (!l) return null;
          const on = active === id;
          return (
            <div key={id} className={'laser-layer' + (on ? ' active' : '') + (l.locked ? ' locked' : '')}>
              <button
                type="button"
                className="laser-layer-main"
                title={MACHINE_UI
                  ? `${l.name}\nМощность ${l.power}% · ${l.speed} мм/с · проходов: ${l.passes}${l.kerf ? ` · керф ${l.kerf} мм` : ''}`
                  : `${l.name}\nСлой чертежа: ${LAYER_HINT[l.mode] ?? l.mode}`}
                onClick={() => onActive(id)}
              >
                <span className="laser-layer-swatch" style={{ background: l.color }} />
                <span className="laser-layer-name">{l.short}</span>
                <span className="laser-layer-n">{counts.get(id) ?? 0}</span>
              </button>
              <button
                type="button"
                className={'tb-btn obj-eye' + (l.visible ? '' : ' off')}
                title={l.visible ? 'Скрыть слой' : 'Показать слой'}
                onClick={() => onToggleVisible(id)}
              >
                <Ic n="eye" size={15} />
              </button>
              <button
                type="button"
                className={'tb-btn obj-lock' + (l.locked ? ' on' : '')}
                title={l.locked ? 'Разблокировать слой' : 'Заблокировать слой'}
                onClick={() => onToggleLock(id)}
              >
                <Ic n={l.locked ? 'lock' : 'unlock'} size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="layer-lock-tools">
        <span>Активный слой: <b>{cfg?.short}</b></span>
        <button type="button" className="btn tiny" onClick={onShowAll}>Показать все</button>
      </div>

      {cfg && (
        <div className="props laser-layer-props">
          <h3>{MACHINE_UI ? `Параметры лазера · ${cfg.short}` : `Слой · ${cfg.short}`}</h3>
          <SI label="Назначение" value={cfg.mode} on={(v) => onPatch(active, { mode: v as LaserLayerConfig['mode'] })}
            options={[
              ['cut', 'Внешний контур'],
              ['fold', 'Линия сгиба (биговка)'],
              ['score', 'Тонкая разметка'],
              ['fill', 'Заливка области'],
              ['guide', 'Служебный (не выводится)'],
            ]} />
          {MACHINE_UI && (
            <>
              <NI label="Мощность, %" value={cfg.power} min={0} max={100} step={1} on={(v) => onPatch(active, { power: v })} />
              <NI label="Скорость, мм/с" value={cfg.speed} min={1} max={2000} step={1} on={(v) => onPatch(active, { speed: v })} />
              <NI label="Проходов" value={cfg.passes} min={0} max={20} step={1} on={(v) => onPatch(active, { passes: Math.round(v) })} />
              <NI label="Керф, мм" value={cfg.kerf} min={0} max={2} step={0.01} on={(v) => onPatch(active, { kerf: v })} />
            </>
          )}
          {(cfg.mode === 'fold' || cfg.dashLen > 0 || cfg.gapLen > 0) && (
            <>
              <NI label="Штрих, мм" value={cfg.dashLen} min={0} max={200} step={0.5} on={(v) => onPatch(active, { dashLen: v })} />
              <NI label="Пропуск, мм" value={cfg.gapLen} min={0} max={200} step={0.5} on={(v) => onPatch(active, { gapLen: v })} />
            </>
          )}
          {MACHINE_UI && (
            <>
              <label className="laser-check">
                <input type="checkbox" checked={cfg.airAssist} onChange={(e) => onPatch(active, { airAssist: e.target.checked })} />
                Обдув воздухом (Air Assist, M8/M9)
              </label>
              <p className="sub">
                Керф — диаметр луча: контур реза автоматически смещается наружу на половину диаметра,
                чтобы деталь получилась точного размера. Для внутренних отверстий смещение идёт внутрь.
              </p>
            </>
          )}
          {!MACHINE_UI && (
            <p className="sub">
              Назначение слоя определяет его имя и тип линии в DXF, PDF, EPS и SVG: внешний контур,
              линия сгиба (пунктир), разметка, заливка и служебный слой размеров, который не выводится в файлы.
            </p>
          )}
        </div>
      )}
    </>
  );
}

// ---------------- материал ----------------

export function LaserMaterialPanel({
  doc,
  onApply,
  onThickness,
}: {
  doc: LaserDoc;
  onApply: (preset: MaterialPreset) => void;
  onThickness: (mm: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = MATERIAL_PRESETS.find((m) => m.id === doc.materialPresetId) ?? null;
  return (
    <div className="props">
      <h3>Материал и толщина</h3>
      <div className="field">
        <label>Лист</label>
        <select
          value={doc.materialPresetId}
          onChange={(e) => {
            const p = MATERIAL_PRESETS.find((m) => m.id === e.target.value);
            if (p) onApply(p);
          }}
        >
          {!current && <option value="">— свой режим —</option>}
          {MATERIAL_PRESETS.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      </div>
      <NI label="Толщина, мм" value={doc.materialThickness} min={0.1} max={50} step={0.1} on={onThickness} />
      {current && <p className="sub">{current.description}</p>}
      <button type="button" className="btn" onClick={() => setOpen((v) => !v)}>
        {open ? 'Скрыть таблицу режимов' : 'Таблица режимов резки'}
      </button>
      {open && (
        <div className="laser-material-table">
          <table>
            <thead>
              <tr><th>Материал</th><th>мм</th><th>Резка</th><th>Сгиб</th><th>Грав.</th></tr>
            </thead>
            <tbody>
              {MATERIAL_PRESETS.map((m) => (
                <tr key={m.id} className={m.id === doc.materialPresetId ? 'on' : ''}>
                  <td title={m.description}>{m.name}</td>
                  <td>{m.thicknessMm}</td>
                  <td>{m.cutPower}% / {m.cutSpeed} мм/с{m.cutPasses > 1 ? ` ×${m.cutPasses}` : ''}</td>
                  <td>{m.foldPower}% / {m.foldSpeed}</td>
                  <td>{m.engravePower}% / {m.engraveSpeed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------- генератор развёрток ----------------

export function UnfoldPanel({
  params,
  onParams,
  onGenerate,
  busy,
}: {
  params: UnfoldParams;
  onParams: (patch: Partial<UnfoldParams>) => void;
  onGenerate: () => void;
  busy: boolean;
}) {
  const tpl = UNFOLD_TEMPLATES.find((t) => t.id === params.template);
  const needs = {
    lwh: params.template !== 'gear',
    height: ['folded-box', 'finger-box', 'bent-case', 'cylinder-cone', 'living-hinge'].includes(params.template),
    finger: ['folded-box', 'finger-box', 'cylinder-cone'].includes(params.template),
    thickness: params.template === 'finger-box',
    pcb: ['folded-box', 'finger-box', 'bent-case'].includes(params.template),
    openTop: ['folded-box', 'finger-box', 'cylinder-cone'].includes(params.template),
    cone: params.template === 'cylinder-cone',
    panel: params.template === 'front-panel',
    gear: params.template === 'gear',
  };

  return (
    <div className="props laser-unfold">
      <h3>Генератор развёрток</h3>
      <div className="laser-tpl-list">
        {UNFOLD_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={'laser-tpl' + (params.template === t.id ? ' active' : '')}
            onClick={() => onParams({ template: t.id })}
            title={t.subtitle}
          >
            <span className="laser-tpl-name">{t.name}</span>
            <span className="laser-tpl-badge">{t.badge}</span>
          </button>
        ))}
      </div>
      {tpl && <p className="sub">{tpl.subtitle}</p>}

      {needs.lwh && (
        <>
          <NI label="Длина X, мм" value={params.length} min={10} max={1200} step={1} on={(v) => onParams({ length: v })} />
          <NI label="Ширина Y, мм" value={params.width} min={10} max={1200} step={1} on={(v) => onParams({ width: v })} />
        </>
      )}
      {needs.height && (
        <NI label={params.template === 'living-hinge' ? 'Ширина шарнира, мм' : 'Высота Z, мм'}
          value={params.height} min={5} max={600} step={1} on={(v) => onParams({ height: v })} />
      )}
      {needs.thickness && (
        <NI label="Толщина листа, мм" value={params.thickness} min={0.5} max={20} step={0.1}
          on={(v) => onParams({ thickness: v })} />
      )}
      {needs.finger && (
        <NI label={params.template === 'finger-box' ? 'Ширина шипа, мм' : 'Ширина клапана, мм'}
          value={params.fingerWidth} min={3} max={60} step={0.5} on={(v) => onParams({ fingerWidth: v })} />
      )}
      {needs.cone && (
        <NI label="Верхний Ø, мм" value={params.topDiameter} min={5} max={600} step={1}
          on={(v) => onParams({ topDiameter: v })} />
      )}
      {needs.gear && (
        <>
          <NI label="Модуль m, мм" value={params.gearModule} min={0.5} max={10} step={0.1}
            on={(v) => onParams({ gearModule: v })} />
          <NI label="Число зубьев Z" value={params.gearTeeth} min={6} max={80} step={1}
            on={(v) => onParams({ gearTeeth: Math.round(v) })} />
        </>
      )}
      {needs.panel && (
        <>
          <NI label="Окно: ширина, мм" value={params.displayW} min={5} max={400} step={1} on={(v) => onParams({ displayW: v })} />
          <NI label="Окно: высота, мм" value={params.displayH} min={5} max={300} step={1} on={(v) => onParams({ displayH: v })} />
          <NI label="Регуляторов, шт" value={params.controlsCount} min={0} max={6} step={1}
            on={(v) => onParams({ controlsCount: Math.round(v) })} />
          <TI label="Маркировка" value={params.titleText} on={(v) => onParams({ titleText: v })} />
        </>
      )}
      {needs.openTop && (
        <label className="laser-check">
          <input type="checkbox" checked={params.openTop} onChange={(e) => onParams({ openTop: e.target.checked })} />
          Открытый верх (без крышки)
        </label>
      )}
      {needs.pcb && (
        <>
          <label className="laser-check">
            <input type="checkbox" checked={params.pcbMount} onChange={(e) => onParams({ pcbMount: e.target.checked })} />
            Отверстия под печатную плату
          </label>
          {params.pcbMount && (
            <>
              <NI label="База платы X, мм" value={params.pcbHoleDistX} min={5} max={600} step={0.5}
                on={(v) => onParams({ pcbHoleDistX: v })} />
              <NI label="База платы Y, мм" value={params.pcbHoleDistY} min={5} max={600} step={0.5}
                on={(v) => onParams({ pcbHoleDistY: v })} />
              <NI label="Ø отверстия, мм" value={params.holeD} min={1} max={12} step={0.1}
                on={(v) => onParams({ holeD: v })} />
            </>
          )}
        </>
      )}
      {(needs.gear || needs.panel) && (
        <NI label="Ø отверстия, мм" value={params.holeD} min={1} max={20} step={0.1} on={(v) => onParams({ holeD: v })} />
      )}

      <button type="button" className="btn primary laser-unfold-go" disabled={busy} onClick={onGenerate}>
        <Ic n="unfold" size={15} />
        <span>{busy ? 'Строим развёртку…' : 'Построить развёртку на листе'}</span>
      </button>
      <p className="sub">
        Развёртка добавляется на лист отдельными слоями: внешний контур — «Контур», окна и отверстия — «Внутренний»,
        линии сгиба — «Сгиб» (перфорация), маркировка — «Разметка» и «Заливка», размеры — «Размеры» (в файлы не выводятся).
      </p>
    </div>
  );
}

// ---------------- свойства объекта ----------------

export interface PropsActions {
  onPatch: (patch: Partial<LaserShape>) => void;
  onGeometry: (patch: Record<string, number>) => void;
  onRotateStep: (deg: number) => void;
  onMirror: (axis: 'h' | 'v') => void;
  onAlign: (mode: AlignMode) => void;
  onBoolean: (op: BooleanOp) => void;
  onContour: (delta: number, layer?: LaserLayerId) => void;
  onToCurves: () => void;
  onFillet: (r: number) => void;
  /** Включить инструмент «Усечь кривую» (X), сразу в нужном режиме */
  onTrimTool: (mode?: TrimMode) => void;
  /** Разбить кривые по точкам пересечений (Ctrl+Shift+X) */
  onBreakApart: () => void;
  onArray: (rows: number, cols: number, gapX: number, gapY: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  onOrder: (cmd: 'front' | 'back' | 'forward' | 'backward') => void;
  onLayer: (layer: LaserLayerId) => void;
  onLock: (locked: boolean) => void;
  onHide: (hidden: boolean) => void;
}

const KIND_NAMES: Record<LaserShape['kind'], string> = {
  rect: 'Прямоугольник',
  ellipse: 'Эллипс / дуга',
  polygon: 'Многоугольник / звезда',
  path: 'Кривая (Bézier)',
  text: 'Текст',
  dim: 'Размерная линия',
};

export function LaserPropsPanel({
  doc,
  shapes,
  active,
  actions,
  arrayState,
  onArrayState,
  contourState,
  onContourState,
  msg,
}: {
  doc: LaserDoc;
  shapes: LaserShape[];
  active: LaserLayerId;
  actions: PropsActions;
  arrayState: { rows: number; cols: number; gapX: number; gapY: number };
  onArrayState: (patch: Partial<typeof arrayState>) => void;
  contourState: { delta: number; layer: LaserLayerId };
  onContourState: (patch: Partial<typeof contourState>) => void;
  msg: { text: string; ok: boolean | null } | null;
}) {
  const one = shapes.length === 1 ? shapes[0] : null;
  const bb = useMemo(() => {
    if (!shapes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of shapes) {
      const b = shapeBBox(s);
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    return [x0, y0, x1, y1] as [number, number, number, number];
  }, [shapes]);

  if (!shapes.length) {
    return (
      <div className="props">
        <h3>Свойства</h3>
        <p className="sub">
          Выделите объект на листе, чтобы изменить размер, поворот, слой и параметры реза.
          Новый рисунок создаётся на активном слое <b>{doc.layers[active]?.short}</b>.
        </p>
        {msg?.text && <div className={'laser-msg' + (msg.ok === false ? ' bad' : '')}>{msg.text}</div>}
      </div>
    );
  }

  return (
    <div className="props">
      <h3>
        {shapes.length === 1 ? KIND_NAMES[one!.kind] : `Выделено объектов: ${shapes.length}`}
      </h3>

      {one && (
        <TIC label="Имя" value={one.name} on={(v) => actions.onPatch({ name: v })} placeholder="Название объекта" />
      )}

      {bb && (
        <>
          <div className="laser-grid2">
            <NI label="X, мм" value={bb[0]} step={0.1} on={(v) => actions.onGeometry({ x: v })} />
            <NI label="Y, мм" value={bb[1]} step={0.1} on={(v) => actions.onGeometry({ y: v })} />
            <NI label="Ширина" value={bb[2] - bb[0]} min={0.2} step={0.1} on={(v) => actions.onGeometry({ w: v })} />
            <NI label="Высота" value={bb[3] - bb[1]} min={0.2} step={0.1} on={(v) => actions.onGeometry({ h: v })} />
          </div>
          <p className="sub laser-bb-hint">
            Габарит: {(bb[2] - bb[0]).toFixed(2)} × {(bb[3] - bb[1]).toFixed(2)} мм
            {' · '}центр {( ((bb[0] + bb[2]) / 2).toFixed(2) )}; {( ((bb[1] + bb[3]) / 2).toFixed(2) )}
          </p>
        </>
      )}

      {one && one.kind === 'rect' && (
        <>
          <NI label="Скругление, мм" value={one.rx} min={0} step={0.1} on={(v) => actions.onPatch({ rx: v } as Partial<LaserShape>)} />
          <NI label="Поворот, °" value={one.rot} step={1} on={(v) => actions.onPatch({ rot: v } as Partial<LaserShape>)} />
        </>
      )}
      {one && one.kind === 'ellipse' && (
        <>
          <NI label="Радиус X" value={one.rx} min={0.1} step={0.1} on={(v) => actions.onPatch({ rx: v } as Partial<LaserShape>)} />
          <NI label="Радиус Y" value={one.ry} min={0.1} step={0.1} on={(v) => actions.onPatch({ ry: v } as Partial<LaserShape>)} />
          <NI label="Начало, °" value={one.startAngle} step={1} on={(v) => actions.onPatch({ startAngle: v } as Partial<LaserShape>)} />
          <NI label="Конец, °" value={one.endAngle} step={1} on={(v) => actions.onPatch({ endAngle: v } as Partial<LaserShape>)} />
          <NI label="Поворот, °" value={one.rot} step={1} on={(v) => actions.onPatch({ rot: v } as Partial<LaserShape>)} />
        </>
      )}
      {one && one.kind === 'polygon' && (
        <>
          <NI label="Радиус, мм" value={one.r} min={0.5} step={0.5} on={(v) => actions.onPatch({ r: v } as Partial<LaserShape>)} />
          <NI label="Углов / лучей" value={one.sides} min={3} max={64} step={1} on={(v) => actions.onPatch({ sides: Math.round(v) } as Partial<LaserShape>)} />
          <label className="laser-check">
            <input type="checkbox" checked={one.star} onChange={(e) => actions.onPatch({ star: e.target.checked } as Partial<LaserShape>)} />
            Звезда (лучи)
          </label>
          {one.star && (
            <NI label="Внутр. радиус" value={one.innerRatio} min={0.1} max={0.95} step={0.05}
              on={(v) => actions.onPatch({ innerRatio: v } as Partial<LaserShape>)} />
          )}
          <NI label="Поворот, °" value={one.rot} step={1} on={(v) => actions.onPatch({ rot: v } as Partial<LaserShape>)} />
        </>
      )}
      {one && one.kind === 'text' && (
        <>
          <TI label="Текст" value={one.text} on={(v) => actions.onPatch({ text: v } as Partial<LaserShape>)} />
          <NI label="Кегль, мм" value={one.size} min={1} step={0.5} on={(v) => actions.onPatch({ size: v } as Partial<LaserShape>)} />
          <NI label="Толщина, мм" value={one.strokeWidth} min={0.05} step={0.05}
            on={(v) => actions.onPatch({ strokeWidth: v } as Partial<LaserShape>)} />
          <NI label="Поворот, °" value={one.rot} step={1} on={(v) => actions.onPatch({ rot: v } as Partial<LaserShape>)} />
          <label className="laser-check">
            <input type="checkbox" checked={one.mirror} onChange={(e) => actions.onPatch({ mirror: e.target.checked } as Partial<LaserShape>)} />
            Зеркально (для штампов)
          </label>
          <label className="laser-check">
            <input type="checkbox" checked={one.filled} onChange={(e) => actions.onPatch({ filled: e.target.checked } as Partial<LaserShape>)} />
            Заливка области
          </label>
        </>
      )}
      {one && one.kind === 'path' && (
        <>
          <label className="laser-check">
            <input type="checkbox" checked={one.closed} onChange={(e) => actions.onPatch({ closed: e.target.checked } as Partial<LaserShape>)} />
            Замкнутый контур
          </label>
          <p className="sub">Узлов: {one.nodes.length}{one.holes?.length ? ` · отверстий: ${one.holes.length}` : ''}</p>
        </>
      )}
      {one && (one.kind === 'rect' || one.kind === 'ellipse' || one.kind === 'polygon' || one.kind === 'path') && (
        <label className="laser-check">
          <input
            type="checkbox"
            checked={'filled' in one ? !!one.filled : false}
            onChange={(e) => actions.onPatch({ filled: e.target.checked } as Partial<LaserShape>)}
          />
          Заливка области
        </label>
      )}
      {one && (one.kind === 'rect' || one.kind === 'path' || one.kind === 'polygon' || one.kind === 'ellipse') && (
        <>
          <NI label="Перемычек, шт" value={one.tabs ?? 0} min={0} max={24} step={1}
            on={(v) => actions.onPatch({ tabs: Math.round(v) } as Partial<LaserShape>)} />
          {!!one.tabs && (
            <NI label="Ширина перемычки" value={one.tabWidth ?? 1.8} min={0.4} max={20} step={0.1}
              on={(v) => actions.onPatch({ tabWidth: v } as Partial<LaserShape>)} />
          )}
        </>
      )}

      <div className="field">
        <label>Слой</label>
        <select
          value={one ? one.layer : active}
          onChange={(e) => actions.onLayer(e.target.value as LaserLayerId)}
        >
          {layerOptions(doc).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
        </select>
      </div>

      <div className="laser-btnrow">
        <button type="button" className="btn tiny" onClick={() => actions.onLock(!(one?.locked ?? false))}
          disabled={shapes.length !== 1}>
          <Ic n={one?.locked ? 'unlock' : 'lock'} size={13} />
          {one?.locked ? 'Разблокировать' : 'Заблокировать'}
        </button>
        <button type="button" className="btn tiny" onClick={() => actions.onHide(!(one?.hidden ?? false))}
          disabled={shapes.length !== 1}>
          <Ic n="eye" size={13} />
          {one?.hidden ? 'Показать' : 'Скрыть'}
        </button>
      </div>

      {msg?.text && <div className={'laser-msg' + (msg.ok === false ? ' bad' : '')}>{msg.text}</div>}

      <h3>Преобразования</h3>
      <div className="laser-btnrow">
        <button type="button" className="btn tiny" title="Повернуть на 90° против часовой" onClick={() => actions.onRotateStep(90)}>↺ 90°</button>
        <button type="button" className="btn tiny" title="Повернуть на 90° по часовой" onClick={() => actions.onRotateStep(-90)}>↻ 90°</button>
        <button type="button" className="btn tiny" title="Отразить по горизонтали" onClick={() => actions.onMirror('h')}>
          <Ic n="mirror" size={13} /> Гориз.
        </button>
        <button type="button" className="btn tiny" title="Отразить по вертикали" onClick={() => actions.onMirror('v')}>Вертик.</button>
        <button type="button" className="btn tiny" title="Дублировать (Ctrl+D)" onClick={actions.onDuplicate}>Дубликат</button>
        <button type="button" className="btn tiny danger" title="Удалить (Del)" onClick={actions.onDelete}>Удалить</button>
      </div>

      <h3>Выравнивание</h3>
      <div className="laser-align">
        {([
          ['left', 'По левому краю'],
          ['center-x', 'По центру по X'],
          ['right', 'По правому краю'],
          ['bottom', 'По нижнему краю'],
          ['center-y', 'По центру по Y'],
          ['top', 'По верхнему краю'],
        ] as [AlignMode, string][]).map(([mode, title]) => (
          <button key={mode} type="button" className="btn tiny" title={title} onClick={() => actions.onAlign(mode)}>
            {title.replace('По ', '').replace(' краю', '').replace('центру по ', 'центр ')}
          </button>
        ))}
        <button type="button" className="btn tiny" title="По центру листа" onClick={() => actions.onAlign('page-center')}>Центр листа</button>
        <button type="button" className="btn tiny" title="Распределить по X (нужно 3+ объекта)"
          disabled={shapes.length < 3} onClick={() => actions.onAlign('distribute-x')}>Распред. X</button>
        <button type="button" className="btn tiny" title="Распределить по Y (нужно 3+ объекта)"
          disabled={shapes.length < 3} onClick={() => actions.onAlign('distribute-y')}>Распред. Y</button>
      </div>

      <h3>Порядок и группы</h3>
      <div className="laser-btnrow">
        <button type="button" className="btn tiny" onClick={() => actions.onOrder('front')} title="На передний план">Наверх</button>
        <button type="button" className="btn tiny" onClick={() => actions.onOrder('forward')} title="На один уровень вверх">+1 вверх</button>
        <button type="button" className="btn tiny" onClick={() => actions.onOrder('backward')} title="На один уровень вниз">+1 вниз</button>
        <button type="button" className="btn tiny" onClick={() => actions.onOrder('back')} title="На задний план">Вниз</button>
        <button type="button" className="btn tiny" onClick={actions.onGroup} disabled={shapes.length < 2}
          title="Сгруппировать (Ctrl+G)">
          <Ic n="group" size={13} /> Группа
        </button>
        <button type="button" className="btn tiny" onClick={actions.onUngroup} title="Разгруппировать (Ctrl+Shift+G)">
          <Ic n="ungroup" size={13} /> Разгрупп.
        </button>
      </div>

      <h3>Булевы операции (CorelDRAW)</h3>
      <div className="laser-btnrow">
        <button type="button" className="btn tiny" disabled={shapes.length < 2} onClick={() => actions.onBoolean('union')}
          title="Объединение (Weld) — первый объект поглощает остальные">
          <Ic n="weld" size={13} /> Объединить
        </button>
        <button type="button" className="btn tiny" disabled={shapes.length < 2} onClick={() => actions.onBoolean('subtract')}
          title="Вычитание (Trim) — из первого объекта вычитаются остальные">
          <Ic n="trim" size={13} /> Вычесть
        </button>
        <button type="button" className="btn tiny" disabled={shapes.length < 2} onClick={() => actions.onBoolean('intersect')}
          title="Пересечение (Intersect) — остаётся общая область">
          <Ic n="intersect" size={13} /> Пересечь
        </button>
        <button type="button" className="btn tiny" disabled={shapes.length < 2} onClick={() => actions.onBoolean('xor')}
          title="Исключение (Simplify/XOR) — общая область вырезается">
          Исключить
        </button>
      </div>

      <h3>Контур и керф</h3>
      <div className="laser-grid2">
        <NI label="Отступ, мм" value={contourState.delta} min={-50} max={50} step={0.05}
          on={(v) => onContourState({ delta: v })} />
        <div className="field">
          <label>Слой</label>
          <select value={contourState.layer} onChange={(e) => onContourState({ layer: e.target.value as LaserLayerId })}>
            {layerOptions(doc).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="laser-btnrow">
        <button type="button" className="btn tiny" onClick={() => actions.onContour(Math.abs(contourState.delta) || 0.1, contourState.layer)}
          title="Внешний контур (наружу) — как Contour в CorelDRAW">
          <Ic n="offset" size={13} /> Наружу
        </button>
        <button type="button" className="btn tiny" onClick={() => actions.onContour(-(Math.abs(contourState.delta) || 0.1), contourState.layer)}
          title="Внутренний контур (внутрь)">Внутрь</button>
        <button type="button" className="btn tiny" onClick={() => actions.onContour(doc.layers.cut.kerf / 2 || 0.05, 'cut')}
          title={`Компенсация толщины инструмента: +${((doc.layers.cut.kerf || 0) / 2).toFixed(3)} мм наружу по керфу слоя «Контур»`}>
          Керф наружу
        </button>
        <button type="button" className="btn tiny" onClick={() => actions.onContour(-(doc.layers.cut.kerf / 2 || 0.05), 'inner')}
          title="Компенсация толщины инструмента внутрь (отверстия становятся меньше на керф)">Керф внутрь</button>
      </div>

      <h3>Скругление углов (Fillet)</h3>
      <div className="laser-btnrow">
        {[1, 2, 3, 5].map((r) => (
          <button key={r} type="button" className="btn tiny" onClick={() => actions.onFillet(r)} title={`Скруглить углы радиусом ${r} мм`}>
            R{r}
          </button>
        ))}
        <button type="button" className="btn tiny" onClick={actions.onToCurves}
          title="Преобразовать в кривые (Ctrl+Q) — объект станет редактируемой кривой Безье">
          <Ic n="bezier" size={13} /> В кривые
        </button>
      </div>

      <h3>Усечь кривую (Trim)</h3>
      <div className="laser-btnrow">
        <button type="button" className="btn tiny" onClick={() => actions.onTrimTool('trim')}
          title="Инструмент «Усечь кривую» (X): клик по кривой отрезает кусок до пересечения с другими объектами. 1 — усечь, 2 — продлить, 3 — разрезать">
          <Ic n="cut-curve" size={13} /> Усечь (X)
        </button>
        <button type="button" className="btn tiny" onClick={() => actions.onTrimTool('extend')}
          title="Продлить ближайший конец кривой до границы по касательной (включает инструмент в режиме «Продлить»)">
          <Ic n="extend" size={13} /> Продлить
        </button>
        <button type="button" className="btn tiny" onClick={() => actions.onTrimTool('break')}
          title="Разрезать кривую в точке клика: замкнутый контур станет открытым">
          <Ic n="cut-curve" size={13} /> Разрезать
        </button>
        <button type="button" className="btn tiny" onClick={actions.onBreakApart}
          disabled={!shapes.length}
          title="Разбить выделенные кривые по всем точкам пересечений (Ctrl+Shift+X). Без выделения разбивается весь лист">
          <Ic n="detach" size={13} /> Разбить по пересечениям
        </button>
      </div>

      <h3>Размножение массивом (Step &amp; Repeat)</h3>
      <div className="laser-grid2">
        <NI label="Строк" value={arrayState.rows} min={1} max={40} step={1} on={(v) => onArrayState({ rows: Math.round(v) })} />
        <NI label="Столбцов" value={arrayState.cols} min={1} max={40} step={1} on={(v) => onArrayState({ cols: Math.round(v) })} />
        <NI label="Зазор X, мм" value={arrayState.gapX} min={0} max={200} step={0.5} on={(v) => onArrayState({ gapX: v })} />
        <NI label="Зазор Y, мм" value={arrayState.gapY} min={0} max={200} step={0.5} on={(v) => onArrayState({ gapY: v })} />
      </div>
      <button type="button" className="btn" onClick={() => actions.onArray(arrayState.rows, arrayState.cols, arrayState.gapX, arrayState.gapY)}>
        <Ic n="panel" size={14} />
        <span>Построить массив {arrayState.rows}×{arrayState.cols}</span>
      </button>
    </div>
  );
}

// ---------------- дерево объектов ----------------

export function LaserObjectsPanel({
  doc,
  sel,
  onPick,
  onToggleHidden,
  onToggleLocked,
  onShowAll,
  onRename,
  filter,
  onFilter,
}: {
  doc: LaserDoc;
  sel: Set<string>;
  onPick: (id: string, additive: boolean) => void;
  onToggleHidden: (id: string) => void;
  onToggleLocked: (id: string) => void;
  onShowAll: () => void;
  onRename: (id: string, name: string) => void;
  filter: string;
  onFilter: (v: string) => void;
}) {
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const list = q ? doc.shapes.filter((s) => s.name.toLowerCase().includes(q) || KIND_NAMES[s.kind].toLowerCase().includes(q)) : doc.shapes;
    return list.slice().reverse(); // верхние объекты первыми — как в CorelDRAW Object Manager
  }, [doc.shapes, q]);

  const groupRows = useMemo(() => {
    const map = new Map<string, { id: string; name: string; count: number; ids: string[] }>();
    for (const s of doc.shapes) {
      if (!s.groupId) continue;
      const g = map.get(s.groupId) ?? {
        id: s.groupId,
        name: doc.groups.find((x) => x.id === s.groupId)?.name ?? 'Группа',
        count: 0,
        ids: [],
      };
      g.count++;
      g.ids.push(s.id);
      map.set(s.groupId, g);
    }
    return [...map.values()];
  }, [doc.shapes, doc.groups]);

  return (
    <>
      <h3>Объекты на листе</h3>
      <div className="obj-search">
        <Ic n="search" size={14} />
        <input
          className="txt"
          type="text"
          placeholder="Поиск по имени объекта…"
          value={filter}
          onChange={(e) => onFilter(e.target.value)}
          aria-label="Поиск объекта"
        />
        {filter && (
          <button type="button" className="obj-clear" title="Очистить поиск" onClick={() => onFilter('')}>
            <Ic n="close" size={13} />
          </button>
        )}
      </div>
      <div className="obj-tools">
        <button type="button" className="btn tiny" onClick={onShowAll}>Показать все</button>
        <span className="obj-n">{doc.shapes.length} объектов · {groupRows.length} групп</span>
      </div>
      <div className="obj-tree">
        {groupRows.map((g) => (
          <div key={g.id} className="obj-row lvl0">
            <span className="obj-caret open"><Ic n="caret" size={12} /></span>
            <span className="obj-dot" style={{ background: 'var(--accent)' }} />
            <span className="obj-label">{g.name}</span>
            <span className="obj-n">{g.count}</span>
          </div>
        ))}
        {rows.map((s) => {
          const cfg = doc.layers[s.layer];
          return (
            <div
              key={s.id}
              className={'obj-row is-ent' + (sel.has(s.id) ? ' active' : '') + (s.hidden ? ' hidden' : '')}
              role="button"
              tabIndex={0}
              title={`${KIND_NAMES[s.kind]} · слой «${cfg?.short ?? s.layer}»${s.groupId ? ' · в группе' : ''}`}
              onClick={(e) => onPick(s.id, e.shiftKey || e.ctrlKey || e.metaKey)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(s.id, e.shiftKey); } }}
            >
              <span className="obj-dot" style={{ background: cfg?.color ?? '#888' }} />
              <input
                className="txt obj-name-input"
                value={s.name}
                aria-label={`Имя объекта ${s.name}`}
                onChange={(e) => onRename(s.id, e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              <span className="obj-n">{KIND_NAMES[s.kind].split(' ')[0]}</span>
              <button type="button" className={'tb-btn obj-eye' + (s.hidden ? ' off' : '')} title={s.hidden ? 'Показать' : 'Скрыть'}
                onClick={(e) => { e.stopPropagation(); onToggleHidden(s.id); }}>
                <Ic n="eye" size={14} />
              </button>
              <button type="button" className={'tb-btn obj-lock' + (s.locked ? ' on' : '')} title={s.locked ? 'Разблокировать' : 'Заблокировать'}
                onClick={(e) => { e.stopPropagation(); onToggleLocked(s.id); }}>
                <Ic n={s.locked ? 'lock' : 'unlock'} size={14} />
              </button>
            </div>
          );
        })}
        {!rows.length && <div className="obj-hint hint">Объектов нет. Начните рисунок инструментами слева или постройте развёртку.</div>}
      </div>
    </>
  );
}

// ---------------- сводка задания на станок ----------------

export function LaserJobPanel({
  doc,
  sim,
  onSimulate,
  onExport,
  onNest,
  busy,
}: {
  doc: LaserDoc;
  sim: LaserSimulation | null;
  onSimulate: () => void;
  onExport: () => void;
  onNest: () => void;
  busy: boolean;
}) {
  const fmtTime = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s} с`;
    const m = Math.floor(s / 60);
    return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
  };
  const visible = doc.shapes.filter((s) => !s.hidden);
  const perLayer = LASER_LAYER_ORDER
    .map((id) => ({ id, cfg: doc.layers[id], n: visible.filter((s) => s.layer === id).length }))
    .filter((r) => r.n > 0);

  return (
    <div className="props laser-job">
      <h3>Задание на станок</h3>
      <div className="laser-job-grid">
        <div><span>Объектов</span><b>{visible.length}</b></div>
        <div><span>Лист</span><b>{doc.w}×{doc.h}</b></div>
        <div><span>Материал</span><b>{doc.materialThickness} мм</b></div>
        <div><span>Время</span><b>{sim ? fmtTime(sim.totalTimeSec) : '—'}</b></div>
        <div><span>Рез, мм</span><b>{sim ? sim.cutLengthMm.toFixed(1) : '—'}</b></div>
        <div><span>Холостой ход</span><b>{sim ? sim.rapidLengthMm.toFixed(1) : '—'}</b></div>
      </div>
      {sim && (
        <div className="laser-job-layers">
          {LASER_LAYER_ORDER.map((id) => {
            const row = sim.byLayer[id];
            const cfg = doc.layers[id];
            if (!row || (!row.count && !row.lengthMm)) return null;
            return (
              <div key={id} className="laser-job-layer">
                <span className="laser-layer-swatch" style={{ background: cfg.color }} />
                <span className="laser-job-layer-name">{cfg.short}</span>
                <span>{row.lengthMm.toFixed(1)} мм</span>
                <span>{fmtTime(row.timeSec)}</span>
              </div>
            );
          })}
        </div>
      )}
      {!perLayer.length && <p className="sub">На листе пока нет объектов.</p>}
      <div className="laser-btnrow">
        <button type="button" className="btn" disabled={busy || !visible.length} onClick={onSimulate}>
          <Ic n="play" size={14} />
          <span>{busy ? 'Считаем траекторию…' : 'Рассчитать и симуляция'}</span>
        </button>
        <button type="button" className="btn" disabled={!visible.length} onClick={onNest}
          title="Автоматически разложить детали на листе без пересечений (Auto-Nesting)">
          <Ic n="panel" size={14} />
          <span>Автораскладка</span>
        </button>
        <button type="button" className="btn primary" disabled={!visible.length} onClick={onExport}>
          <Ic n="gerber" size={14} />
          <span>Экспорт на станок…</span>
        </button>
      </div>
      <p className="sub">
        Порядок обработки: гравировка → разметка → биговка → внутренние вырезы → внешний контур.
        Так деталь не выпадает из листа раньше времени.
      </p>
    </div>
  );
}
