// Диалоги редактора чертежей: новый лист и его размер, экспорт чертежа
// (параметры DXF, план файла, контроль точности, разбивка по слоям),
// симуляция обработки (станочная часть, под флагом MACHINE_UI) и векторизация
// изображения (аналог PowerTRACE).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, NI, SI, TI } from './widgets';
import { Ic } from './icons';
import { ProgressBar } from './progress';
import {
  DEFAULT_GCODE_OPTIONS,
  buildLaserSimulation,
  type GCodeExportOptions,
  type LaserSimulation,
} from '../laser/export';
import {
  DXF_LAYER_NAMES, dxfLayerPlan, exportDxf, measureDxfAccuracy, normalizeDxfOptions, visibleShapes,
  type DxfAccuracy, type DxfOptions,
} from '../laser/dxf';
import {
  LASER_LAYER_ORDER,
  MATERIAL_PRESETS,
  docContourLength,
  luid,
  type LaserDoc,
  type LaserLayerId,
  type LaserShape,
  type Pt,
} from '../laser/model';
import { MACHINE_UI } from '../laser/features';
import { DEFAULT_VECTOR_OPTIONS, PLT_PENS, type VectorExportOptions } from '../laser/corel';
import { toScreen, type LaserView } from '../laser/render';
import { facesToPolys, traceImage, type BitmapImage, type TraceResult } from '../pcb/imagetrace';

export type LaserExportFormat = 'gcode' | 'svg' | 'dxf' | 'png' | 'project' | 'pdf' | 'eps' | 'plt';

/** Как отдавать DXF: одним файлом или отдельными файлами по слоям (архивом ZIP). */
export type LaserDxfSplit = 'single' | 'layers';

/** Порог числа объектов, выше которого живая проверка точности в диалоге не гоняется. */
const DXF_ACCURACY_LIMIT = 4000;

const SHEET_PRESETS: { id: string; name: string; w: number; h: number }[] = [
  { id: 'k40', name: 'K40 CO₂ (320×220 мм)', w: 320, h: 220 },
  { id: '6040', name: '6040 CO₂ (600×400 мм)', w: 600, h: 400 },
  { id: '9060', name: '9060 CO₂ (900×600 мм)', w: 900, h: 600 },
  { id: '1390', name: '1390 CO₂ (1300×900 мм)', w: 1300, h: 900 },
  { id: 'diode-a4', name: 'Диодный A4 (300×200 мм)', w: 300, h: 200 },
  { id: 'diode-a3', name: 'Диодный A3 (420×300 мм)', w: 420, h: 300 },
  { id: 'custom', name: 'Свой размер листа', w: 0, h: 0 },
];

// ---------------- новый лист / размер стола ----------------

export function LaserSheetDialog({
  doc,
  title,
  onOk,
  onClose,
}: {
  doc: LaserDoc;
  title: string;
  onOk: (next: { name: string; w: number; h: number; thickness: number; materialId: string }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(doc.name);
  const [preset, setPreset] = useState(
    SHEET_PRESETS.find((p) => p.w === doc.w && p.h === doc.h)?.id ?? 'custom'
  );
  const [w, setW] = useState(doc.w);
  const [h, setH] = useState(doc.h);
  const [thickness, setThickness] = useState(doc.materialThickness);
  const [materialId, setMaterialId] = useState(doc.materialPresetId);

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = SHEET_PRESETS.find((x) => x.id === id);
    if (p && p.w > 0) {
      setW(p.w);
      setH(p.h);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      className="laser-sheet-dialog"
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button
            type="button"
            className="btn primary"
            disabled={!name.trim() || w < 20 || h < 20}
            onClick={() => onOk({ name: name.trim(), w, h, thickness, materialId })}
          >
            Применить
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="laser-doc-name">Название</label>
        <input
          id="laser-doc-name"
          className="txt"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например: Корпус прибора 120×80"
        />
      </div>
      <SI label={MACHINE_UI ? 'Стол станка' : 'Формат листа'} value={preset} on={applyPreset}
        options={SHEET_PRESETS.map((p) => [p.id, p.name] as [string, string])} />
      <div className="laser-grid2">
        <NI label="Ширина X, мм" value={w} min={20} max={3000} step={1} on={setW} />
        <NI label="Глубина Y, мм" value={h} min={20} max={3000} step={1} on={setH} />
      </div>
      {MACHINE_UI && (
        <SI label="Материал" value={materialId} on={setMaterialId}
          options={MATERIAL_PRESETS.map((m) => [m.id, `${m.name} (${m.thicknessMm} мм)`] as [string, string])} />
      )}
      <NI label="Толщина, мм" value={thickness} min={0.1} max={50} step={0.1} on={setThickness} />
      <p className="sub">
        {MACHINE_UI
          ? 'Размер стола задаёт рабочее поле: объекты за его пределами станок не обработает. '
            + 'Толщина материала используется генератором развёрток (шип-паз, клапаны, зазоры посадки).'
          : 'Размер листа задаёт границы чертежа: объекты за его пределами не попадут в раскладку. '
            + 'Толщина листа используется генератором развёрток и коробок (шип-паз, клапаны, зазоры посадки).'}
      </p>
    </Modal>
  );
}

// ---------------- экспорт чертежа ----------------

export function LaserExportDialog({
  doc,
  sim,
  gcode,
  onGcodeChange,
  dxf,
  onDxfChange,
  dxfSplit,
  onDxfSplitChange,
  vec,
  onVecChange,
  onExport,
  onClose,
}: {
  doc: LaserDoc;
  sim: LaserSimulation | null;
  gcode: GCodeExportOptions;
  onGcodeChange: (patch: Partial<GCodeExportOptions>) => void;
  dxf: DxfOptions;
  onDxfChange: (patch: Partial<DxfOptions>) => void;
  dxfSplit: LaserDxfSplit;
  onDxfSplitChange: (split: LaserDxfSplit) => void;
  vec: VectorExportOptions;
  onVecChange: (patch: Partial<VectorExportOptions>) => void;
  onExport: (format: LaserExportFormat) => void;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<LaserExportFormat>(MACHINE_UI ? 'gcode' : 'dxf');
  const contourMm = useMemo(() => docContourLength(doc), [doc]);
  const perLayer = useMemo(
    () =>
      LASER_LAYER_ORDER.map((id) => ({
        id,
        cfg: doc.layers[id],
        count: doc.shapes.filter((s) => s.layer === id && !s.hidden).length,
      })).filter((r) => r.count > 0),
    [doc.shapes, doc.layers]
  );

  // ---------------- DXF: план файла и живая проверка точности ----------------

  const dxfOpts = useMemo(() => normalizeDxfOptions(dxf), [dxf]);
  const dxfShapes = useMemo(() => visibleShapes(doc, dxfOpts), [doc, dxfOpts]);
  const dxfPlan = useMemo(() => dxfLayerPlan(doc, dxfOpts, dxfShapes), [doc, dxfOpts, dxfShapes]);
  /** Слои, которые станут отдельными файлами архива. */
  const dxfFiles = useMemo(
    () =>
      LASER_LAYER_ORDER
        .filter((id) => (id !== 'guide' || dxfOpts.includeGuide))
        .filter((id) => dxfShapes.some((s) => s.layer === id))
        .map((id) => ({ id, name: `${DXF_LAYER_NAMES[id]}.dxf`, count: dxfShapes.filter((s) => s.layer === id).length })),
    [dxfShapes, dxfOpts.includeGuide]
  );
  const [acc, setAcc] = useState<DxfAccuracy | null>(null);
  const [accState, setAccState] = useState<'idle' | 'busy' | 'skip'>('idle');
  // Комментарий на геометрию не влияет — из-за него дорогую проверку не перезапускаем.
  const accKey = useMemo(() => JSON.stringify({ ...dxfOpts, comment: '' }), [dxfOpts]);

  // Проверка дорогая (файл пишется и читается обратно), поэтому с задержкой
  // и только пока открыта вкладка DXF.
  useEffect(() => {
    if (format !== 'dxf') return;
    if (dxfShapes.length > DXF_ACCURACY_LIMIT) {
      setAcc(null);
      setAccState('skip');
      return;
    }
    let dead = false;
    setAccState('busy');
    const t = setTimeout(() => {
      try {
        setAcc(measureDxfAccuracy(doc, exportDxf(doc, dxfOpts), dxfOpts));
        if (!dead) setAccState('idle');
      } catch {
        if (!dead) { setAcc(null); setAccState('idle'); }
      }
    }, 260);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dxfOpts входит в accKey
  }, [format, doc, accKey, dxfShapes.length]);

  const formats: { id: LaserExportFormat; name: string; ext: string; desc: string; icon: string }[] = [
    {
      id: 'gcode',
      name: 'G-Code для станка',
      ext: '.gcode / .nc',
      icon: 'cnc',
      desc: 'Управляющая программа GRBL / LightBurn / LaserGRBL: слои, мощность S, скорость F, проходы, обдув M8/M9, оптимизация холостых переездов.',
    },
    {
      id: 'dxf',
      name: 'AutoCAD DXF',
      ext: dxfSplit === 'layers' ? `.zip (${dxfFiles.length} × .dxf)` : '.dxf',
      icon: 'gerber',
      desc: 'Точный векторный чертёж 1:1 в миллиметрах по слоям CUT / INNER / FOLD / SCORE / ENGRAVE — открывается в CorelDRAW, AutoCAD, Adobe Illustrator, Inkscape и Компас-3D. Версию, сущности, слои, допуски и разбивку по файлам можно настроить ниже.',
    },
    {
      id: 'pdf',
      name: 'PDF 1:1 мм',
      ext: '.pdf',
      icon: 'layers',
      desc: 'Векторный PDF в масштабе 1:1 (1 мм = 2.8346 пт): кривые Безье без аппроксимации, цвета и пунктир слоёв, а слои чертежа становятся слоями PDF (OCG). CorelDRAW, Illustrator, Inkscape и Acrobat разбирают такой файл по слоям и читают его обратно.',
    },
    {
      id: 'eps',
      name: 'EPS / PostScript',
      ext: '.eps',
      icon: 'bezier',
      desc: 'EPS 3.0 для CorelDRAW и Illustrator: точные кривые, цвета и пунктир слоёв, %%BoundingBox по размеру листа. Слои помечены комментарием %PSBeesLayer — по нему же обратный импорт возвращает объекты на свои слои.',
    },
    {
      id: 'plt',
      name: 'PLT (HPGL/2)',
      ext: '.plt',
      icon: 'grid',
      desc: 'Формат плоттеров: 40 юнитов на миллиметр (1 юнит = 0.025 мм), своё перо на каждый слой, пунктир биговки — настоящими пропусками пера. CorelDRAW и Illustrator открывают PLT как кривые, перья превращаются в слои.',
    },
    {
      id: 'svg',
      name: 'SVG 1:1 мм',
      ext: '.svg',
      icon: 'png',
      desc: 'Масштаб 1:1 в миллиметрах, группы по слоям, пунктир биговки. Для CorelDRAW, Inkscape, Illustrator и просмотра в браузере.',
    },
    {
      id: 'png',
      name: 'PNG-чертёж',
      ext: '.png',
      icon: 'png',
      desc: 'Растровый чертёж развёртки в масштабе (для документации, согласования и печати на бумаге 1:1).',
    },
    {
      id: 'project',
      name: 'Проект PSBees',
      ext: '.psdraw',
      icon: 'save',
      desc: 'Полный проект: лист, слои, толщина, объекты и группы. Открывается обратно в этом редакторе; прежние файлы .pslaser тоже читаются.',
    },
  ];

  // G-Code и PNG-чертёж — станочные форматы: в составе «рисовалки» их нет.
  const shown = MACHINE_UI ? formats : formats.filter((f) => f.id !== 'gcode' && f.id !== 'png');
  const active = shown.find((f) => f.id === format) ?? shown[0];

  return (
    <Modal
      title={MACHINE_UI ? 'Экспорт развёртки на лазерный станок' : 'Экспорт чертежа'}
      onClose={onClose}
      className="laser-export-dialog"
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>Закрыть</button>
          <button type="button" className="btn primary" onClick={() => onExport(active.id)}>
            <Ic n="gerber" size={15} />
            <span>Скачать {active.ext}</span>
          </button>
        </>
      }
    >
      <div className="laser-export-formats">
        {shown.map((f) => (
          <button
            key={f.id}
            type="button"
            className={'laser-format' + (format === f.id ? ' active' : '')}
            onClick={() => setFormat(f.id)}
          >
            <Ic n={f.icon} size={17} />
            <span className="laser-format-name">{f.name}</span>
            <span className="laser-format-ext">{f.ext}</span>
          </button>
        ))}
      </div>
      <p className="sub">{active.desc}</p>

      {!MACHINE_UI && (
        <p className="hint laser-corel-hint">
          Обмен с CorelDRAW: экспорт в DXF, PDF, EPS, PLT и SVG, импорт — из DXF, PDF, EPS/AI, PLT и SVG.
          Родной формат <b>.cdr закрытый</b> (двоичный, без публичной спецификации), поэтому в CorelDRAW
          сохраняйте чертёж через «Файл → Опубликовать в PDF» или «Файл → Экспорт» в EPS, SVG, DXF или PLT —
          редактор прочитает любой из них и вернёт объекты на слои.
        </p>
      )}

      {(format === 'pdf' || format === 'eps' || format === 'plt' || format === 'svg') && (
        <div className="props laser-vec-opts">
          <h3>Параметры векторного файла</h3>
          <NI
            label="Толщина линии, мм"
            value={vec.strokeWidthMm}
            min={0}
            max={2}
            step={0.05}
            on={(v) => onVecChange({ strokeWidthMm: v })}
          />
          {format === 'plt' && (
            <NI
              label="Допуск аппроксимации кривых, мм"
              value={vec.tolerance}
              min={0.001}
              max={1}
              step={0.005}
              on={(v) => onVecChange({ tolerance: v })}
            />
          )}
          <div className="laser-dxf-checks">
            {format === 'pdf' && (
              <label className="laser-check">
                <input
                  type="checkbox"
                  checked={vec.pdfLayers}
                  onChange={(e) => onVecChange({ pdfLayers: e.target.checked })}
                />
                Слои чертежа как слои PDF (OCG)
              </label>
            )}
            {format === 'plt' && (
              <label className="laser-check">
                <input
                  type="checkbox"
                  checked={vec.pltPensPerLayer}
                  onChange={(e) => onVecChange({ pltPensPerLayer: e.target.checked })}
                />
                Отдельное перо на каждый слой
              </label>
            )}
            {format !== 'svg' && (
              <>
                <label className="laser-check">
                  <input
                    type="checkbox"
                    checked={vec.includeGuide}
                    onChange={(e) => onVecChange({ includeGuide: e.target.checked })}
                  />
                  Служебный слой (размеры и направляющие)
                </label>
                <label className="laser-check">
                  <input
                    type="checkbox"
                    checked={vec.includeHidden}
                    onChange={(e) => onVecChange({ includeHidden: e.target.checked })}
                  />
                  Скрытые объекты
                </label>
              </>
            )}
          </div>
          <p className="sub">
            {format === 'pdf'
              ? 'Масштаб 1:1: 1 мм листа = 2.8346 пункта PDF, ось Y вверх, как в чертеже. Слои CUT, INNER, FOLD, SCORE, ENGRAVE становятся слоями PDF — в CorelDRAW и Acrobat их можно включать и выключать по отдельности.'
              : format === 'eps'
                ? 'Масштаб 1:1 в пунктах PostScript, начало координат — левый нижний угол листа. Каждый слой помечен комментарием %PSBeesLayer, поэтому обратный импорт возвращает объекты на свои слои.'
                : format === 'plt'
                  ? `Масштаб 1:1: 40 юнитов HPGL на миллиметр. Перья: ${PLT_PENS.cut} — CUT, ${PLT_PENS.inner} — INNER, ${PLT_PENS.fold} — FOLD, ${PLT_PENS.score} — SCORE, ${PLT_PENS.engrave} — ENGRAVE, ${PLT_PENS.guide} — GUIDE. Кривые раскладываются полилинией с заданным допуском: HPGL не знает Безье.`
                  : 'Масштаб 1:1 в миллиметрах, группы по слоям, пунктир биговки свойством stroke-dasharray.'}
          </p>
        </div>
      )}

      <div className="laser-export-summary">
        <div><span>Проект</span><b>{doc.name}</b></div>
        <div><span>Лист</span><b>{doc.w} × {doc.h} мм</b></div>
        <div><span>Толщина</span><b>{doc.materialThickness} мм</b></div>
        <div><span>Объектов</span><b>{doc.shapes.filter((s) => !s.hidden).length}</b></div>
        {MACHINE_UI ? (
          <>
            <div><span>Длина реза</span><b>{sim ? `${sim.cutLengthMm.toFixed(1)} мм` : 'не рассчитано'}</b></div>
            <div><span>Время</span><b>{sim ? `${Math.round(sim.totalTimeSec)} с` : 'не рассчитано'}</b></div>
          </>
        ) : (
          <div><span>Длина контуров</span><b>{contourMm.toFixed(1)} мм</b></div>
        )}
      </div>

      <div className="laser-export-layers">
        {perLayer.map((r) => (
          <div key={r.id} className="laser-job-layer">
            <span className="laser-layer-swatch" style={{ background: r.cfg.color }} />
            <span className="laser-job-layer-name">{r.cfg.short}</span>
            <span>{r.count} объ.</span>
            {MACHINE_UI && (
              <>
                <span>{r.cfg.power}% / {r.cfg.speed} мм/с</span>
                <span>{r.cfg.passes} прох.</span>
                {r.cfg.kerf > 0 && <span>керф {r.cfg.kerf}</span>}
              </>
            )}
          </div>
        ))}
        {!perLayer.length && <div className="hint">На листе нет видимых объектов — экспорт будет пустым.</div>}
      </div>

      {MACHINE_UI && format === 'gcode' && (
        <div className="props laser-gcode-opts">
          <h3>Параметры G-Code</h3>
          <SI
            label="Режим лазера"
            value={gcode.laserMode}
            on={(v) => onGcodeChange({ laserMode: v as GCodeExportOptions['laserMode'] })}
            options={[
              ['M4', 'M4 — динамическая мощность (GRBL 1.1)'],
              ['M3', 'M3 — постоянная мощность'],
            ]}
          />
          <NI label="Макс. S (ШИМ)" value={gcode.maxS} min={1} max={32000} step={1}
            on={(v) => onGcodeChange({ maxS: Math.round(v) })} />
          <NI label="Холостой ход, мм/мин" value={gcode.rapidFeedMmMin} min={100} max={30000} step={100}
            on={(v) => onGcodeChange({ rapidFeedMmMin: Math.round(v) })} />
          <label className="laser-check">
            <input type="checkbox" checked={gcode.returnOrigin}
              onChange={(e) => onGcodeChange({ returnOrigin: e.target.checked })} />
            Возврат в начало координат (G0 X0 Y0) после работы
          </label>
          <p className="sub">
            Порядок слоёв в программе: гравировка → разметка → биговка → внутренние вырезы → внешний контур.
            Начало координат (0;0) — левый нижний угол листа, как на столе станка.
          </p>
        </div>
      )}

      {format === 'dxf' && (
        <div className="props laser-dxf-opts">
          <h3>Параметры DXF</h3>

          <div className="laser-split" role="group">
            <button
              type="button"
              data-dxf-split="single"
              className={'laser-split-btn' + (dxfSplit === 'single' ? ' active' : '')}
              onClick={() => onDxfSplitChange('single')}
            >
              <Ic n="gerber" size={14} />
              <span>Один файл</span>
              <em>.dxf</em>
            </button>
            <button
              type="button"
              data-dxf-split="layers"
              className={'laser-split-btn' + (dxfSplit === 'layers' ? ' active' : '')}
              onClick={() => onDxfSplitChange('layers')}
            >
              <Ic n="layers" size={14} />
              <span>Файлы по слоям</span>
              <em>.zip · {dxfFiles.length}</em>
            </button>
          </div>
          <p className="sub">
            {dxfSplit === 'layers'
              ? 'Каждый слой чертежа — отдельный DXF внутри архива: в CorelDRAW и CAD-программах файлы заводятся по одному, цвета и типы линий сохраняются, ничего не теряется при импорте.'
              : 'Все слои в одном файле: слои CUT, INNER, FOLD, SCORE, ENGRAVE становятся слоями DXF со своими цветами и типами линий.'}
          </p>

          <div className="laser-grid2">
            <SI
              label="Версия"
              value={dxf.version}
              on={(v) => onDxfChange({ version: v as DxfOptions['version'] })}
              options={[
                ['R2000', 'R2000 (AC1015) — полный DXF'],
                ['R12', 'R12 (AC1009) — для старых CAM'],
              ]}
            />
            <SI
              label="Сущности"
              value={dxf.entities}
              on={(v) => onDxfChange({ entities: v as DxfOptions['entities'] })}
              options={[
                ['auto', 'Авто — дуги и сплайны, где возможно'],
                ['exact', 'Точно — ARC, CIRCLE, ELLIPSE, SPLINE'],
                ['polyline', 'Полилинии LWPOLYLINE'],
                ['lines', 'Только отрезки LINE'],
              ]}
            />
            <SI
              label="Единицы"
              value={dxf.units}
              on={(v) => onDxfChange({ units: v as DxfOptions['units'] })}
              options={[['mm', 'Миллиметры'], ['inch', 'Дюймы']]}
            />
            <SI
              label="Ноль координат"
              value={dxf.origin}
              on={(v) => onDxfChange({ origin: v as DxfOptions['origin'] })}
              options={[
                ['sheet', 'Угол листа — (0;0) чертежа'],
                ['bbox', 'Левый нижний угол деталей'],
                ['center', 'Центр габарита деталей'],
                ['zero', 'Координаты чертежа без сдвига'],
              ]}
            />
            <SI
              label="Слои"
              value={dxf.layers}
              on={(v) => onDxfChange({ layers: v as DxfOptions['layers'] })}
              options={[
                ['laser', 'Слои чертежа (CUT, INNER, FOLD…)'],
                ['single', 'Один слой для всего'],
                ['objects', 'Слой на каждый объект'],
              ]}
            />
            {dxf.layers === 'single' && (
              <TI label="Имя слоя" value={dxf.singleLayer} on={(v) => onDxfChange({ singleLayer: v })} />
            )}
            <SI
              label="Цвета"
              value={dxf.colors}
              on={(v) => onDxfChange({ colors: v as DxfOptions['colors'] })}
              options={[
                ['aci', 'Индекс AutoCAD (ACI)'],
                ['truecolor', 'Точный RGB (код 420)'],
                ['bylayer', 'ByLayer — цветом слоя'],
              ]}
            />
            <SI
              label="Пунктир сгиба"
              value={dxf.foldDash}
              on={(v) => onDxfChange({ foldDash: v as DxfOptions['foldDash'] })}
              options={[
                ['segments', 'Физические штрихи'],
                ['linetype', 'Тип линии DASHED'],
                ['solid', 'Сплошная линия'],
              ]}
            />

            <NI label="Допуск, мм" value={dxf.tolerance} min={0.0005} max={2} step={0.005}
              on={(v) => onDxfChange({ tolerance: v })} />
            <NI label="Точность, знаков" value={dxf.precision} min={1} max={9} step={1}
              on={(v) => onDxfChange({ precision: Math.round(v) })} />
            <NI label="Масштаб" value={dxf.scale} min={0.01} max={100} step={0.1}
              on={(v) => onDxfChange({ scale: v })} />
            <NI label="Сварка, мм" value={dxf.weld} min={0} max={2} step={0.005}
              on={(v) => onDxfChange({ weld: Math.max(0, v) })} />
          </div>

          <div className="laser-dxf-checks">
            <label className="laser-check">
              <input type="checkbox" checked={dxf.kerf}
                onChange={(e) => onDxfChange({ kerf: e.target.checked })} />
              Компенсация толщины инструмента (керф): контур смещается на половину толщины
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.tabs}
                onChange={(e) => onDxfChange({ tabs: e.target.checked })} />
              Удерживающие перемычки (разрывы контура)
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.flipY}
                onChange={(e) => onDxfChange({ flipY: e.target.checked })} />
              Инверсия Y — для программ с отсчётом сверху
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.textAsEntity}
                onChange={(e) => onDxfChange({ textAsEntity: e.target.checked })} />
              Текст объектом TEXT (иначе — штриховыми контурами)
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.blocks}
                onChange={(e) => onDxfChange({ blocks: e.target.checked })} />
              Повторяющиеся детали — блоки BLOCK / INSERT
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.includeHidden}
                onChange={(e) => onDxfChange({ includeHidden: e.target.checked })} />
              Включить скрытые объекты
            </label>
            <label className="laser-check">
              <input type="checkbox" checked={dxf.includeGuide}
                onChange={(e) => onDxfChange({ includeGuide: e.target.checked })} />
              Включить слой «Размеры» (направляющие, не режется)
            </label>
          </div>
          <TI label="Комментарий в шапке" value={dxf.comment} on={(v) => onDxfChange({ comment: v })} />

          <div className="laser-dxf-plan">
            <h4>{dxfSplit === 'layers' ? 'Файлы архива' : 'Слои файла'}</h4>
            {dxfSplit === 'layers'
              ? dxfFiles.map((f) => (
                <div key={f.id} className="laser-dxf-row">
                  <Ic n="gerber" size={13} />
                  <b>{f.name}</b>
                  <span>{doc.layers[f.id]?.short}</span>
                  <span>{f.count} объ.</span>
                </div>
              ))
              : dxfPlan.map((p) => (
                <div key={p.name} className="laser-dxf-row">
                  <span className="laser-layer-swatch" style={{ background: p.color }} />
                  <b>{p.name}</b>
                  <span>ACI {p.aci}</span>
                  <span>{p.linetype === 'DASHED' ? 'DASHED' : 'CONTINUOUS'}</span>
                  <span>{p.shapes} объ.</span>
                </div>
              ))}
            {!dxfShapes.length && <div className="hint">Нет видимых объектов — файл будет пустым.</div>}
          </div>

          <div className={'laser-dxf-acc' + (acc && !acc.ok ? ' bad' : '')}>
            <Ic n={acc && acc.ok ? 'check' : 'ruler'} size={13} />
            {accState === 'busy' && <span>Контроль точности файла…</span>}
            {accState === 'skip' && (
              <span>Объектов слишком много ({dxfShapes.length}) — контроль точности пропущен.</span>
            )}
            {accState !== 'busy' && accState !== 'skip' && (acc ? (
              <span>
                Контроль точности: {dxfShapes.length} объ., отклонение до <b>{acc.maxDeviationMm.toFixed(4)} мм</b>,
                габарит <b>{acc.bboxDeviationMm.toFixed(4)} мм</b>, длина контуров <b>{acc.lengthDeviationPct.toFixed(3)}%</b>
                {' — '}
                {acc.ok ? 'в допуске' : 'вне допуска'}
              </span>
            ) : (
              <span>Контроль точности не выполнен.</span>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------- симуляция обработки ----------------

const SIM_SPEEDS = [1, 4, 16, 64, 256];

export function LaserSimDialog({
  doc,
  onClose,
}: {
  doc: LaserDoc;
  onClose: () => void;
}) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(true);
  const [sim, setSim] = useState<LaserSimulation | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speedIdx, setSpeedIdx] = useState(2);
  const [elapsed, setElapsed] = useState(0);
  const [size, setSize] = useState({ w: 720, h: 420 });
  const rafRef = useRef(0);
  const startRef = useRef(0);
  const accRef = useRef(0);

  // Расчёт траектории (тяжёлая геометрия) — сразу после открытия окна
  useEffect(() => {
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      try {
        const result = buildLaserSimulation(doc);
        if (alive) setSim(result);
      } catch {
        if (alive) setSim(null);
      } finally {
        if (alive) setBusy(false);
      }
    }, 30);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [doc]);

  const view: LaserView = useMemo(() => {
    const pad = 34;
    const s = Math.min((size.w - pad * 2) / Math.max(doc.w, 1), (size.h - pad * 2) / Math.max(doc.h, 1));
    return {
      s,
      ox: (size.w - doc.w * s) / 2,
      oy: (size.h + doc.h * s) / 2,
    };
  }, [doc.w, doc.h, size.w, size.h]);

  // Кумулятивное время по сегментам — для поиска текущей позиции головки
  const cum = useMemo(() => {
    if (!sim) return [] as number[];
    const arr: number[] = new Array(sim.segments.length);
    let t = 0;
    for (let i = 0; i < sim.segments.length; i++) {
      t += sim.segments[i].durationSec;
      arr[i] = t;
    }
    return arr;
  }, [sim]);

  const total = sim?.totalTimeSec ?? 0;

  const draw = useCallback(
    (tNow: number) => {
      const cv = cvRef.current;
      if (!cv || !sim) return;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
      if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
      cv.style.width = `${size.w}px`;
      cv.style.height = `${size.h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      // лист
      const tl = toScreen(view, 0, doc.h);
      const br = toScreen(view, doc.w, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(tl.px, tl.py, br.px - tl.px, br.py - tl.py);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(tl.px + 0.5, tl.py + 0.5, br.px - tl.px - 1, br.py - tl.py - 1);

      // бинарный поиск текущего сегмента
      let lo = 0;
      let hi = cum.length - 1;
      let idx = cum.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= tNow) lo = mid + 1;
        else {
          idx = mid;
          hi = mid - 1;
        }
      }

      // пройденная траектория — ярко, будущая — тускло
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (let pass = 0; pass < 2; pass++) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < sim.segments.length; i++) {
          const seg = sim.segments[i];
          const done = i < idx;
          if ((pass === 0) !== done) continue;
          if (seg.rapid) {
            started = false;
            continue;
          }
          const a = toScreen(view, seg.from.x, seg.from.y);
          const b = toScreen(view, seg.to.x, seg.to.y);
          if (!started) {
            ctx.moveTo(a.px, a.py);
            started = true;
          }
          ctx.lineTo(b.px, b.py);
          const color = doc.layers[seg.layer]?.color ?? '#ffc233';
          ctx.strokeStyle = pass === 0 ? color : 'rgba(255,255,255,0.10)';
          ctx.lineWidth = pass === 0 ? 1.6 : 1;
          ctx.stroke();
          ctx.beginPath();
          started = false;
        }
      }

      // головка лазера
      let head: Pt | null = null;
      if (idx > 0 && idx <= sim.segments.length) {
        const seg = sim.segments[Math.min(idx, sim.segments.length) - 1];
        const prev = cum[idx - 2] ?? 0;
        const span = Math.max(1e-6, (cum[idx - 1] ?? 0) - prev);
        const k = Math.max(0, Math.min(1, (tNow - prev) / span));
        head = {
          x: seg.from.x + (seg.to.x - seg.from.x) * k,
          y: seg.from.y + (seg.to.y - seg.from.y) * k,
        };
      } else if (sim.segments.length) {
        head = sim.segments[0].from;
      }
      if (head) {
        const p = toScreen(view, head.x, head.y);
        const segNow = sim.segments[Math.min(idx, sim.segments.length - 1)];
        const hot = segNow && !segNow.rapid;
        ctx.beginPath();
        ctx.arc(p.px, p.py, hot ? 9 : 6, 0, Math.PI * 2);
        ctx.fillStyle = hot ? 'rgba(255,69,58,0.28)' : 'rgba(255,255,255,0.16)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.px, p.py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = hot ? (doc.layers[segNow.layer]?.color ?? '#ff453a') : '#ffffff';
        ctx.fill();
        // перекрестие головки
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.px - 12, p.py);
        ctx.lineTo(p.px + 12, p.py);
        ctx.moveTo(p.px, p.py - 12);
        ctx.lineTo(p.px, p.py + 12);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `Сегмент ${Math.min(idx + 1, sim.segments.length)} из ${sim.segments.length} · X ${head ? head.x.toFixed(1) : '—'} Y ${head ? head.y.toFixed(1) : '—'} мм`,
        10,
        8
      );
    },
    [sim, cum, view, size.w, size.h, doc.w, doc.h, doc.layers]
  );

  // Проигрывание: rAF с учётом выбранного ускорения
  useEffect(() => {
    if (!sim || busy) return;
    if (!playing) {
      draw(elapsed);
      return;
    }
    startRef.current = performance.now();
    const base = elapsed;
    const mul = SIM_SPEEDS[speedIdx] ?? 1;
    const tick = (now: number) => {
      const t = base + ((now - startRef.current) / 1000) * mul;
      if (t >= total) {
        setElapsed(total);
        draw(total);
        setPlaying(false);
        return;
      }
      accRef.current = t;
      setElapsed(t);
      draw(t);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speedIdx, sim, busy, draw, total]);

  const fmtTime = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s} с`;
    const m = Math.floor(s / 60);
    return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
  };

  const pct = total > 0 ? (elapsed / total) * 100 : 0;

  return (
    <Modal
      title="Симуляция обработки на станке"
      onClose={onClose}
      className="laser-sim-dialog"
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>Закрыть</button>
          <button
            type="button"
            className="btn"
            disabled={!sim || busy}
            onClick={() => {
              setElapsed(0);
              accRef.current = 0;
              setPlaying(true);
            }}
          >
            <Ic n="update" size={14} />
            <span>С начала</span>
          </button>
          <button type="button" className="btn primary" disabled={!sim || busy} onClick={() => setPlaying((p) => !p)}>
            <Ic n={playing ? 'pause' : 'play'} size={14} />
            <span>{playing ? 'Пауза' : 'Пуск'}</span>
          </button>
        </>
      }
    >
      {busy && <ProgressBar label="Считаем траекторию лазерной головки…" indeterminate live
        meta="компенсация керфа, перфорация сгибов, оптимизация холостых переездов" />}
      {!busy && !sim && (
        <div className="hint">Не удалось построить траекторию: на листе нет объектов или геометрия слишком сложная.</div>
      )}
      {!busy && sim && (
        <>
          <div className="laser-sim-toolbar">
            <span>Ускорение:</span>
            {SIM_SPEEDS.map((s, i) => (
              <button
                key={s}
                type="button"
                className={'btn tiny' + (i === speedIdx ? ' primary' : '')}
                onClick={() => {
                  accRef.current = elapsed;
                  setSpeedIdx(i);
                }}
              >
                ×{s}
              </button>
            ))}
            <span className="laser-sim-time">
              {fmtTime(elapsed)} / {fmtTime(total)}
            </span>
          </div>
          <ProgressBar pct={pct} label="Обработка листа" live
            meta={`рез ${sim.cutLengthMm.toFixed(1)} мм · холостой ход ${sim.rapidLengthMm.toFixed(1)} мм · сегментов ${sim.segments.length}`} />
          <div className="laser-sim-canvas-wrap">
            <canvas ref={cvRef} className="laser-sim-canvas" />
          </div>
          <div className="laser-sim-legend">
            {LASER_LAYER_ORDER.map((id: LaserLayerId) => {
              const cfg = doc.layers[id];
              const row = sim.byLayer[id];
              if (!cfg || (!row.count && !row.lengthMm)) return null;
              return (
                <span key={id} className="laser-sim-legend-item">
                  <span className="laser-layer-swatch" style={{ background: cfg.color }} />
                  {cfg.short}: {row.lengthMm.toFixed(1)} мм · {fmtTime(row.timeSec)}
                </span>
              );
            })}
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------- векторизация изображения (PowerTRACE) ----------------

const MAX_TRACE_SIDE = 1024;

function loadBitmapFile(file: File): Promise<{ bitmap: BitmapImage; name: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, MAX_TRACE_SIDE / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * k));
      cv.height = Math.max(1, Math.round(img.height * k));
      const ctx = cv.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('canvas недоступен'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve({ bitmap: { width: data.width, height: data.height, data: data.data }, name: file.name });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('не удалось прочитать изображение'));
    };
    img.src = url;
  });
}

export function LaserTraceDialog({
  layer,
  defaultWidthMm,
  onInsert,
  onClose,
}: {
  layer: LaserLayerId;
  defaultWidthMm: number;
  onInsert: (shapes: LaserShape[], info: string) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cvRef = useRef<HTMLCanvasElement>(null);
  const [bitmap, setBitmap] = useState<BitmapImage | null>(null);
  const [fileName, setFileName] = useState('');
  const [threshold, setThreshold] = useState(128);
  const [invert, setInvert] = useState(false);
  const [widthMm, setWidthMm] = useState(defaultWidthMm);
  const [minArea, setMinArea] = useState(0.5);
  const [simplify, setSimplify] = useState(0.08);
  const [result, setResult] = useState<TraceResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = useCallback(() => {
    if (!bitmap) return;
    setBusy(true);
    setError('');
    window.setTimeout(() => {
      try {
        const res = traceImage(bitmap, {
          threshold,
          invert,
          widthMm,
          minAreaMm2: minArea,
          simplifyMm: simplify,
          maxPixels: 512,
        });
        setResult(res);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Не удалось векторизовать изображение.');
        setResult(null);
      } finally {
        setBusy(false);
      }
    }, 20);
  }, [bitmap, threshold, invert, widthMm, minArea, simplify]);

  useEffect(() => {
    if (bitmap) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bitmap, threshold, invert, widthMm, minArea, simplify]);

  // Предпросмотр векторного результата
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = 320;
    const h = 220;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!result || !result.faces.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const f of result.faces) {
      for (const p of f.outer) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
    }
    const bw = Math.max(x1 - x0, 0.01);
    const bh = Math.max(y1 - y0, 0.01);
    const k = Math.min((w - 16) / bw, (h - 16) / bh);
    const ox = (w - bw * k) / 2;
    const oy = (h - bh * k) / 2;
    const X = (x: number) => ox + (x - x0) * k;
    const Y = (y: number) => oy + (y1 - y) * k;
    ctx.beginPath();
    for (const f of result.faces) {
      const ring = (pts: Pt[]) => {
        pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
        ctx.closePath();
      };
      ring(f.outer);
      for (const hole of f.holes) ring(hole);
    }
    ctx.fillStyle = 'rgba(255,194,51,0.22)';
    ctx.fill('evenodd');
    ctx.strokeStyle = '#ffc233';
    ctx.lineWidth = 1;
    ctx.stroke();
  }, [result]);

  const insert = () => {
    if (!result || !result.faces.length) return;
    const polys = facesToPolys(result.faces, 'k1' as never, () => luid('trace'));
    const shapes: LaserShape[] = polys.map((p) => ({
      id: luid('trace'),
      kind: 'path',
      layer,
      name: fileName ? `Трассировка ${fileName}` : 'Трассировка изображения',
      nodes: p.pts.map((pt) => ({ x: pt.x, y: pt.y })),
      holes: p.holes?.map((hole) => hole.map((pt) => ({ x: pt.x, y: pt.y }))),
      closed: true,
      filled: true,
    }));
    onInsert(
      shapes,
      `Векторизовано: ${result.faces.length} контуров · ${result.widthMm.toFixed(1)}×${result.heightMm.toFixed(1)} мм · отброшено пятен: ${result.dropped}`
    );
  };

  return (
    <Modal
      title="Векторизация изображения (трассировка в контуры)"
      onClose={onClose}
      className="laser-trace-dialog"
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="button" className="btn primary" disabled={!result || !result.faces.length} onClick={insert}>
            <Ic n="spark" size={15} />
            <span>Вставить контуры на лист</span>
          </button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          loadBitmapFile(f)
            .then(({ bitmap: bmp, name }) => {
              setBitmap(bmp);
              setFileName(name);
              setError('');
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Ошибка чтения файла'))
            .finally(() => setBusy(false));
        }}
      />
      <div className="laser-trace-top">
        <button type="button" className="btn primary" onClick={() => fileRef.current?.click()}>
          <Ic n="png" size={15} />
          <span>{bitmap ? 'Выбрать другое изображение…' : 'Выбрать изображение (PNG, JPG)…'}</span>
        </button>
        {fileName && <span className="laser-trace-file">{fileName}</span>}
      </div>
      {busy && <ProgressBar label="Обрабатываем изображение…" indeterminate live meta="порог яркости, упрощение контуров" />}
      {error && <div className="cloud-error" role="alert">{error}</div>}

      <div className="laser-trace-body">
        <div className="props">
          <NI label="Порог яркости" value={threshold} min={1} max={254} step={1} on={(v) => setThreshold(Math.round(v))} />
          <label className="laser-check">
            <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />
            Инверсия (светлый рисунок на тёмном фоне)
          </label>
          <NI label="Ширина, мм" value={widthMm} min={2} max={600} step={1} on={setWidthMm} />
          <NI label="Мин. пятно, мм²" value={minArea} min={0} max={100} step={0.1} on={setMinArea} />
          <NI label="Упрощение, мм" value={simplify} min={0} max={3} step={0.01} on={setSimplify} />
          <p className="sub">
            Контур строится по границе пикселей, упрощается и превращается в замкнутые кривые с отверстиями
            (буквы «О», «А» и т.п.). Результат можно править инструментом «Форма» (F10) как обычную кривую.
          </p>
        </div>
        <div className="laser-trace-preview">
          <canvas ref={cvRef} className="laser-trace-canvas" />
          <div className="hint">
            {result
              ? `Контуров: ${result.faces.length} · размер ${result.widthMm.toFixed(1)} × ${result.heightMm.toFixed(1)} мм · отброшено мелких пятен: ${result.dropped}`
              : bitmap
                ? 'Векторизуем…'
                : 'Выберите изображение — оно превратится в векторные контуры чертежа.'}
          </div>
        </div>
      </div>
    </Modal>
  );
}
