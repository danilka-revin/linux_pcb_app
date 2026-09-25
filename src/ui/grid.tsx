// Интерфейс сетки: быстрый выбор шага в тулбаре, компактная панель быстрых
// настроек и полный диалог (пресеты, единицы, отображение, начало, привязка).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DIV_OPTIONS, GRID_GROUPS, GRID_STYLE_NAME, MAJOR_OPTIONS, drawGrid, fmtGridFull,
  fmtUnit, fromMm, gridPresets, gridSummary, isPresetStep, normalizeGrid, toMm,
  type GridConf, type GridStyle, type GridUnit,
} from '../pcb/grid';
import { COLORS } from '../pcb/render';
import { Modal, NI, SI } from './widgets';
import type { Defs } from './panels';

/** Настройки сетки из общих настроек инструментов */
export const gridOf = (d: Defs): GridConf => normalizeGrid({
  step: d.grid, unit: d.gridUnit, style: d.gridStyle, div: d.gridDiv, major: d.gridMajor,
  ox: d.gridOx, oy: d.gridOy, snap: d.snapOn, snapObj: d.snapObj, snapPx: d.snapPx,
});

/** Патч настроек: значения сетки раскладываются обратно в Defs */
export function gridPatch(c: Partial<GridConf>): Partial<Defs> {
  const p: Partial<Defs> = {};
  if (c.step !== undefined) p.grid = c.step;
  if (c.unit !== undefined) p.gridUnit = c.unit;
  if (c.style !== undefined) p.gridStyle = c.style;
  if (c.div !== undefined) p.gridDiv = c.div;
  if (c.major !== undefined) p.gridMajor = c.major;
  if (c.ox !== undefined) p.gridOx = c.ox;
  if (c.oy !== undefined) p.gridOy = c.oy;
  if (c.snap !== undefined) p.snapOn = c.snap;
  if (c.snapObj !== undefined) p.snapObj = c.snapObj;
  if (c.snapPx !== undefined) p.snapPx = c.snapPx;
  return p;
}

const STYLE_ORDER: GridStyle[] = ['dots', 'lines', 'cross', 'none'];
const STYLE_ICON: Record<GridStyle, string> = { dots: '⋮⋮', lines: '▦', cross: '┼', none: '∅' };

interface CommonProps {
  defs: Defs;
  setDefs: (p: Partial<Defs>) => void;
  onOpen: () => void;
  /** пикселей на мм — для предупреждения «сетка слишком мелкая» */
  scale?: number;
  /** текущая позиция курсора в мм (для «начало сетки по курсору») */
  cursor?: { x: number; y: number };
}

// ------------------------------------------------------------ тулбар

export function GridToolbar({ defs, setDefs, onOpen, scale }: CommonProps) {
  const unit = defs.gridUnit;
  const presets = useMemo(() => gridPresets(unit), [unit]);
  const known = isPresetStep(defs.grid);
  const groups = useMemo(() => {
    const g = new Map<string, { mm: number; label: string }[]>();
    for (const p of presets) {
      if (!g.has(p.group)) g.set(p.group, []);
      g.get(p.group)!.push(p);
    }
    return [...g.entries()];
  }, [presets]);
  const summary = gridSummary(normalizeGrid({ ...gridOf(defs) }), scale);

  return (
    <>
      <select
        className="tb-sel"
        style={{ maxWidth: 168 }}
        title={`Шаг сетки: ${fmtGridFull(defs.grid)}\nВсего вариантов: ${presets.length}. Ctrl+G — настройки сетки, G — следующий шаг.`}
        value={known ? String(defs.grid) : 'custom'}
        onChange={(e) => {
          if (e.target.value === 'open') { onOpen(); return; }
          setDefs({ grid: parseFloat(e.target.value) });
        }}
      >
        {!known && <option value="custom">Своя: {fmtUnit(defs.grid, unit)} {unit === 'mil' ? 'mil' : 'мм'}</option>}
        {groups.map(([g, items]) => (
          <optgroup key={g} label={g}>
            {items.map((p) => (
              <option key={p.mm} value={p.mm}>{p.label}</option>
            ))}
          </optgroup>
        ))}
        <option value="open">Настроить сетку… (Ctrl+G)</option>
      </select>
      <button
        className={'tb-btn' + (defs.gridStyle !== 'dots' ? ' active' : '')}
        title={`Сетка: ${summary}\nКлик — сменить вид сетки (${STYLE_ORDER.map((s) => GRID_STYLE_NAME[s]).join(' → ')})`}
        onClick={() => {
          const i = STYLE_ORDER.indexOf(defs.gridStyle);
          setDefs({ gridStyle: STYLE_ORDER[(i + 1) % STYLE_ORDER.length] });
        }}
      >
        <span className="tb-glyph">{STYLE_ICON[defs.gridStyle]}</span>
      </button>
      <button
        className={'tb-btn' + (defs.snapOn ? ' active' : '')}
        title={`Привязка к сетке: ${defs.snapOn ? 'вкл' : 'выкл'} (Shift+G)\nAlt — временно без привязки`}
        onClick={() => setDefs({ snapOn: !defs.snapOn })}
      >
        <IcGrid n="snap" />
      </button>
      <button
        className={'tb-btn' + (defs.snapObj ? ' active' : '')}
        title={defs.snapObj
          ? `Привязка к объектам платы: вкл (радиус ${defs.snapPx} px)\nТянет к центрам площадок, концам и серединам дорожек, углам`
          : 'Привязка к объектам платы: выкл — включить'}
        onClick={() => setDefs({ snapObj: !defs.snapObj, snapOn: defs.snapObj ? defs.snapOn : true })}
      >
        <IcGrid n="magnet" />
      </button>
      <button className="tb-btn" title="Настройки сетки (Ctrl+G)" onClick={onOpen}>
        <IcGrid n="grid" />
      </button>
      <button
        className={'tb-btn' + (defs.angle !== 'free' ? ' active' : '')}
        title={`Углы прокладки: ${defs.angle === '45' ? '45°' : defs.angle === '90' ? '90°' : 'свободно'}`}
        onClick={() => setDefs({ angle: defs.angle === '45' ? '90' : defs.angle === '90' ? 'free' : '45' })}
      >
        <IcGrid n={defs.angle === '45' ? 'angle45' : defs.angle === '90' ? 'angle90' : 'anglefree'} />
      </button>
    </>
  );
}

/** Свойства диалога сетки: закрытие и текущая позиция курсора */
export type GridDialogProps = Omit<CommonProps, 'onOpen'> & {
  onClose: () => void;
  cursor?: { x: number; y: number };
};

/** Мелкие глифы для кнопок сетки (без внешних ресурсов) */
function IcGrid({ n }: { n: string }) {
  const c = 'var(--text)';
  switch (n) {
    case 'snap':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.6">
          <path d="M12 2.5v19M2.5 12h19" />
          <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'magnet':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.6">
          <path d="M5 4v8a7 7 0 0014 0V4" />
          <path d="M5 4h4v4H5zM15 4h4v4h-4z" />
        </svg>
      );
    case 'grid':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.4">
          <path d="M4 4h16v16H4zM9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" />
        </svg>
      );
    case 'angle45':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.6">
          <path d="M4 20h16M4 20L16 4" />
        </svg>
      );
    case 'angle90':
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.6">
          <path d="M4 20h16M4 20V6" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke={c} strokeWidth="1.6">
          <path d="M4 20L18 6M4 20h5M4 20v-5" />
        </svg>
      );
  }
}

// ------------------------------------------------------------ компактная панель

export function GridQuickPanel({ defs, setDefs, onOpen, scale }: CommonProps) {
  const g = gridOf(defs);
  return (
    <div className="gq">
      <div className="gq-head">
        <span>Сетка</span>
        <button className="btn tiny" onClick={onOpen} title="Все настройки сетки (Ctrl+G)">Настроить…</button>
      </div>
      <div className="gq-row">
        <span className="gq-step" title={`${fmtGridFull(g.step)}`}>{fmtGridFull(g.step)}</span>
        <span className="gq-badge">{GRID_STYLE_NAME[g.style]}</span>
        {g.div > 1 && <span className="gq-badge">÷{g.div}</span>}
        {g.major > 1 && <span className="gq-badge">главные ×{g.major}</span>}
      </div>
      <div className="gq-row">
        <button
          className={'btn tiny' + (g.snap ? ' on' : '')}
          title="Привязка к сетке (Shift+G). Alt — временно без привязки"
          onClick={() => setDefs({ snapOn: !g.snap })}
        >сетка</button>
        <button
          className={'btn tiny' + (g.snapObj ? ' on' : '')}
          title="Привязка к центрам площадок, концам и серединам дорожек, углам"
          onClick={() => setDefs({ snapObj: !g.snapObj, snapOn: g.snapObj ? g.snap : true })}
        >объекты</button>
        <button
          className={'btn tiny' + (defs.showAxes ? ' on' : '')}
          title="Показывать оси координат и начало сетки"
          onClick={() => setDefs({ showAxes: !defs.showAxes })}
        >оси</button>
      </div>
      <div className="gq-row gq-styles">
        {STYLE_ORDER.map((s) => (
          <button
            key={s}
            className={'btn tiny' + (g.style === s ? ' on' : '')}
            title={`Отображение сетки: ${GRID_STYLE_NAME[s]}`}
            onClick={() => setDefs({ gridStyle: s })}
          >{STYLE_ICON[s]} {GRID_STYLE_NAME[s]}</button>
        ))}
      </div>
      {(g.ox !== 0 || g.oy !== 0) && (
        <div className="gq-note">
          начало сетки: X {g.ox} мм, Y {g.oy} мм
          <button className="btn tiny" onClick={() => setDefs({ gridOx: 0, gridOy: 0 })}>сбросить</button>
        </div>
      )}
      {scale !== undefined && <div className="gq-note">{gridSummary(g, scale)}</div>}
    </div>
  );
}

// ------------------------------------------------------------ диалог

export function GridDialog({ defs, setDefs, onClose, cursor }: GridDialogProps) {
  const g = gridOf(defs);
  const [stepText, setStepText] = useState(fmtUnit(g.step, g.unit));
  const [unit, setUnit] = useState<GridUnit>(g.unit);
  useEffect(() => setStepText(fmtUnit(g.step, unit)), [g.step, unit]);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const groups = useMemo(() => {
    const p = gridPresets(g.unit);
    const m = new Map<string, typeof p>();
    for (const it of p) {
      if (!m.has(it.group)) m.set(it.group, []);
      m.get(it.group)!.push(it);
    }
    return [...m.entries()];
  }, [g.unit]);

  // живой предпросмотр: столько клеток, сколько влезает, + подписи шага
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 320, h = 120;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, w, h);
    const cols = 12;
    const s = Math.min(80, w / (cols * g.step));
    drawGrid(ctx, g, { s, ox: w / 2, oy: h - 24, mir: false }, w, h, {
      minor: COLORS.grid, major: COLORS.gridMajor, origin: COLORS.gridOrigin,
    });
    ctx.fillStyle = COLORS.axes;
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${cols} клеток по ${fmtGridFull(g.step)}`, 8, 14);
  }, [g]);

  const applyStep = () => {
    const v = parseFloat(stepText.replace(',', '.'));
    if (isFinite(v) && v > 0) setDefs({ grid: toMm(v, unit), gridUnit: unit });
  };

  const reset = () => setDefs({
    grid: 1.27, gridUnit: 'mm', gridStyle: 'dots', gridDiv: 1, gridMajor: 5,
    gridOx: 0, gridOy: 0, snapOn: true, snapObj: false, snapPx: 10,
  });

  return (
    <Modal
      title="Сетка и привязка"
      className="grid-dlg"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={reset}>Сбросить настройки</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" onClick={onClose}>Готово</button>
        </>
      }
    >
      <canvas ref={previewRef} className="grid-preview" style={{ width: '100%', height: 120 }} />

      <div className="sect">
        <h3>Шаг сетки — {GRID_GROUPS.join(' · ')}: {gridPresets('mm').length} вариантов</h3>
        <div className="grid-presets">
          {groups.map(([group, items]) => (
            <div key={group} className="grid-preset-group">
              <div className="grid-preset-title">{group}</div>
              <div className="grid-preset-items">
                {items.map((p) => (
                  <button
                    key={p.mm}
                    className={'btn tiny' + (Math.abs(p.mm - g.step) < 1e-9 ? ' on' : '')}
                    title={`Шаг ${p.label}`}
                    onClick={() => setDefs({ grid: p.mm })}
                  >{p.label}</button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="sect">
        <h3>Своё значение</h3>
        <div className="row" style={{ alignItems: 'flex-end', gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Шаг</label>
            <input
              className="txt" value={stepText}
              onChange={(e) => setStepText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applyStep(); }}
            />
          </div>
          <div className="field" style={{ width: 110 }}>
            <label>Единицы</label>
            <select value={unit} onChange={(e) => setUnit(e.target.value as GridUnit)}>
              <option value="mm">мм</option>
              <option value="mil">mil (0.0254 мм)</option>
            </select>
          </div>
          <button className="btn primary" onClick={applyStep}>Применить</button>
        </div>
        <div className="hint">
          Сейчас: <b>{fmtGridFull(g.step)}</b>
          {isPresetStep(g.step) ? ' — стандартный шаг' : ' — своё значение (не из списка)'}.
          Ввод «100 mil» даст ровно 2.54 мм, «25 mil» — 0.635 мм.
        </div>
      </div>

      <div className="sect">
        <h3>Отображение</h3>
        <div className="row" style={{ gap: 6 }}>
          {STYLE_ORDER.map((s) => (
            <button
              key={s}
              className={'btn' + (g.style === s ? ' primary' : '')}
              onClick={() => setDefs({ gridStyle: s })}
            >{STYLE_ICON[s]} {GRID_STYLE_NAME[s]}</button>
          ))}
        </div>
        <SI
          label="Подразбиение (мелкие линии)"
          value={String(g.div)}
          options={DIV_OPTIONS.map((d) => [String(d), d === 1 ? 'без подразбиения' : `1/${d} шага`])}
          on={(v) => setDefs({ gridDiv: Number(v) })}
        />
        <SI
          label="«Главные» линии/точки"
          value={String(g.major)}
          options={MAJOR_OPTIONS.map((m) => [String(m), m === 1 ? 'нет' : `каждые ${m} узлов`])}
          on={(v) => setDefs({ gridMajor: Number(v) })}
        />
      </div>

      <div className="sect">
        <h3>Начало сетки</h3>
        <NI label="X0, мм" value={g.ox} step={g.step} on={(v) => setDefs({ gridOx: v })} />
        <NI label="Y0, мм" value={g.oy} step={g.step} on={(v) => setDefs({ gridOy: v })} />
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <button className="btn tiny" onClick={() => setDefs({ gridOx: 0, gridOy: 0 })}>В начало координат</button>
          <button
            className="btn tiny"
            disabled={!cursor}
            title="Привязать сетку к текущему положению курсора"
            onClick={() => cursor && setDefs({ gridOx: cursor.x, gridOy: cursor.y })}
          >По курсору{cursor ? ` (${fmtUnit(cursor.x, g.unit)}; ${fmtUnit(cursor.y, g.unit)})` : ''}</button>
        </div>
        <div className="hint">
          Смещение удобно, когда плата разведена от своего «нуля»: сетка привязывается к нему
          и дальше вся разводка идёт по ровным координатам.
        </div>
      </div>

      <div className="sect">
        <h3>Привязка</h3>
        <label className="chk">
          <input type="checkbox" checked={g.snap} onChange={(e) => setDefs({ snapOn: e.target.checked })} />
          Привязка к сетке (Alt — временно отключить)
        </label>
        <label className="chk">
          <input type="checkbox" checked={g.snapObj} onChange={(e) => setDefs({ snapObj: e.target.checked })} />
          Привязка к объектам платы (площадки, концы и середины дорожек, углы)
        </label>
        {g.snapObj && (
          <NI
            label="Радиус поиска объектов, px" value={g.snapPx} step={1} min={2} max={40}
            on={(v) => setDefs({ snapPx: Math.round(v) })}
          />
        )}
        <div className="hint">
          При включённой привязке к объектам курсор «прилипает» к ближайшей характерной точке,
          если она ближе радиуса поиска; иначе работает обычная привязка к сетке.
        </div>
      </div>
    </Modal>
  );
}
