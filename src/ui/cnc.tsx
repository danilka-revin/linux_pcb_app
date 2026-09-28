import { useEffect, useRef, useState } from 'react';
import type { Doc } from '../pcb/model';
import type { CncJob, CncStage } from '../pcb/cnc';
import { DEFAULT_CNC_SETTINGS, cncDepths, isolationFits, pickForBoard, validateCncSettings,
  CNC_ORIGINS, CNC_ORIGIN_LABEL,
  type CncBoardAnalysis, type CncSettings, type CncOrigin } from '../pcb/cnc-settings';
import { download, makeZip } from '../pcb/zip';
import { Modal, NI } from './widgets';
import { CncPreview } from './cnc-preview';

const KEY = 'psbees.cnc.settings';
const n = (v: number) => String(Number(v.toFixed(3)));
const STAGES: CncStage[] = ['copper-top', 'copper-bottom', 'isolation', 'drills', 'gcode', 'docs'];
function loadSettings(): CncSettings {
  let settings = { ...DEFAULT_CNC_SETTINGS };
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // миграция старых сохранений без origin
      if (!parsed.origin) parsed.origin = 'bottom-left';
      const saved = { ...settings, ...parsed };
      validateCncSettings(saved); settings = saved;
    }
  } catch { /* invalid/legacy storage falls back to defaults */ }
  return { ...settings, isolationPasses: settings.isolationPasses ?? 1,
    drillPasses: cncDepths(settings.drillDepth, settings.drillStep, settings.drillPasses).length,
    outlinePasses: cncDepths(settings.outlineDepth, settings.outlineStep, settings.outlinePasses).length };
}

export function CncDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [settings, setSettings] = useState(loadSettings);
  const [operation, setOperation] = useState<'isolation' | 'drill' | 'outline'>('isolation');
  const [job, setJob] = useState<CncJob | null>(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [analysis, setAnalysis] = useState<CncBoardAnalysis | null>(null);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState(0);
  const worker = useRef<Worker | null>(null);
  const invalidate = () => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setBuilding(false); setProgress(0); setError('');
  };
  useEffect(() => {
    invalidate(); setAnalysis(null); setAnalyzing(true);
    const w = new Worker(new URL('../pcb/cnc.worker.ts', import.meta.url), { type: 'module' });
    let active = true;
    w.onmessage = e => {
      if (active && e.data.type === 'analysis') { setAnalysis(e.data.analysis ?? null); setAnalyzing(false); }
      w.terminate();
    };
    w.onerror = () => { if (active) setAnalyzing(false); w.terminate(); };
    w.postMessage({ op: 'analyze', doc });
    return () => { active = false; w.terminate(); worker.current?.terminate(); worker.current = null; };
  }, [doc]);
  const change = <K extends keyof CncSettings>(key: K, value: CncSettings[K]) => {
    invalidate(); setSettings(old => ({ ...old, [key]: value }));
  };
  const field = (label: string, key: keyof CncSettings, min: number, max: number, step = .1) =>
    <NI label={label} value={settings[key] as number} min={min} max={max} step={step} on={v => change(key, v)} />;
  const build = () => {
    invalidate();
    try {
      validateCncSettings(settings);
      const w = new Worker(new URL('../pcb/cnc.worker.ts', import.meta.url), { type: 'module' });
      worker.current = w; setBuilding(true);
      w.onmessage = e => {
        if (worker.current !== w) return;
        if (e.data.type === 'progress') {
          setProgress((STAGES.indexOf(e.data.stage) + e.data.frac) / STAGES.length * 100); return;
        }
        worker.current = null; w.terminate(); setBuilding(false);
        if (e.data.ok) setJob(e.data.job); else setError(e.data.error || 'Не удалось построить траектории.');
      };
      w.onerror = () => {
        if (worker.current !== w) return;
        worker.current = null; w.terminate(); setBuilding(false); setError('Ошибка расчёта. Попробуйте ещё раз.');
      };
      w.postMessage({ doc, settings });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBuilding(false); }
  };
  const save = () => {
    if (!job) return;
    const base = (doc.name || 'board').replace(/[^\wа-яА-ЯёЁ-]+/g, '_').slice(0, 100) || 'board';
    download(`${base}_cnc_grbl.zip`, makeZip(job.files));
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
  };
  const depth = operation === 'isolation' ? settings.isolationDepth : operation === 'drill' ? settings.drillDepth : settings.outlineDepth;
  const countKey = operation === 'isolation' ? 'isolationPasses' : operation === 'drill' ? 'drillPasses' : 'outlinePasses';
  const count = settings[countKey] ?? 1;
  const fits = analysis ? isolationFits(settings, analysis) : null;

  return <Modal title="Экспорт для ЧПУ" onClose={onClose} className="cnc-modal cnc-simple" foot={<>
    <button className="btn" onClick={onClose}>Закрыть</button>
    {building ? <button className="btn" onClick={invalidate}>Отменить расчёт</button>
      : <button className="btn" onClick={build}>{job ? 'Пересчитать' : 'Построить траектории'}</button>}
    <button className="btn primary" disabled={!job || building} onClick={save}>Скачать CNC ZIP</button>
  </>}>
    <div className="cnc-heading"><span>{doc.name} · {n(doc.w)} × {n(doc.h)} мм</span><span>GRBL · мм</span></div>
    <div className="cnc-workspace">
      <div className="cnc-setup">
        <div className="cnc-tabs" role="tablist" aria-label="Настройки операции">
          {(['isolation', 'drill', 'outline'] as const).map((op, i) => <button key={op} type="button" role="tab"
            aria-selected={operation === op} className={'btn' + (operation === op ? ' primary' : '')} onClick={() => setOperation(op)}>
            {['Медь', 'Отверстия', 'Контур'][i]}</button>)}
        </div>
        {operation === 'outline' && <label className="chk cnc-outline-toggle"><input type="checkbox" checked={settings.cutOutline}
          onChange={e => change('cutOutline', e.target.checked)} />Вырезать контур</label>}
        <fieldset className="cnc-operation" disabled={operation === 'outline' && !settings.cutOutline}>
          <div className="cnc-pass-card">
            <label htmlFor="cnc-pass-count">Проходов по глубине</label>
            <div className="cnc-counter">
              <button className="btn" aria-label="Уменьшить число проходов" disabled={count <= 1} onClick={() => change(countKey, count - 1)}>−</button>
              <input id="cnc-pass-count" type="number" min="1" max="100" step="1" value={count}
                onChange={e => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 1 && v <= 100) change(countKey, v); }} />
              <button className="btn" aria-label="Увеличить число проходов" disabled={count >= 100} onClick={() => change(countKey, count + 1)}>+</button>
            </div>
            <span>По {n(depth / count)} мм · до Z −{n(depth)} мм</span>
          </div>
          {operation === 'isolation' && <>
            {field('Ширина реза, мм', 'toolDiameter', .1, 6, .05)}
            {field('Запас до меди, мм', 'clearance', 0, 2, .05)}
            {field('Глубина, мм', 'isolationDepth', .01, 2, .01)}
          </>}
          {operation === 'drill' && <>
            <label className="cnc-program">Сторона<select className="txt" aria-label="Сторона сверления" value={settings.drillSide}
              onChange={e => change('drillSide', e.target.value as 'top' | 'bottom')}>
              <option value="top">Сверлить сверху</option><option value="bottom">Снизу · зеркало X</option>
            </select></label>
            {field('Глубина, мм', 'drillDepth', .1, 10)}
          </>}
          {operation === 'outline' && <>
            {field('Диаметр фрезы, мм', 'outlineDiameter', .1, 10)}
            {field('Глубина, мм', 'outlineDepth', .1, 10)}
            <div className="cnc-short-warning">Без перемычек · закрепите плату</div>
          </>}
          <details className="cnc-advanced"><summary>Подачи и обороты</summary>
            {operation === 'isolation' ? <>
              {field('Подача XY, мм/мин', 'isolationFeed', 1, 5000, 10)}
              {field('Подача Z, мм/мин', 'isolationPlunge', 1, 5000, 10)}
              {field('Шпиндель, об/мин', 'isolationRpm', 100, 60000, 100)}
            </> : operation === 'drill' ? <>
              {field('Подача Z, мм/мин', 'drillFeed', 1, 5000, 10)}
              {field('Шпиндель, об/мин', 'drillRpm', 100, 60000, 100)}
            </> : <>
              {field('Подача XY, мм/мин', 'outlineFeed', 1, 5000, 10)}
              {field('Подача Z, мм/мин', 'isolationPlunge', 1, 5000, 10)}
              {field('Шпиндель, об/мин', 'outlineRpm', 100, 60000, 100)}
            </>}
          </details>
        </fieldset>
        <details className="cnc-advanced" open><summary>Ноль и безопасная высота</summary>
          <label className="cnc-program">Положение нуля<select className="txt" aria-label="Положение нуля" value={settings.origin}
            onChange={e => change('origin', e.target.value as CncOrigin)}>
            {CNC_ORIGINS.map(o => <option key={o} value={o}>{CNC_ORIGIN_LABEL[o]}</option>)}
          </select></label>
          <div className="cnc-origin-grid" style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'4px', margin:'6px 0'}}>
            {CNC_ORIGINS.map(o => {
              const active = settings.origin === o;
              return <button key={o} type="button" className={'btn' + (active ? ' primary' : '')} style={{fontSize:'11px', padding:'4px 2px'}} onClick={() => change('origin', o as CncOrigin)}>{CNC_ORIGIN_LABEL[o]}</button>;
            })}
          </div>
          {field('Координата нуля X, мм', 'originX', -100, 500)}
          {field('Координата нуля Y, мм', 'originY', -100, 500)}
          {field('Безопасная Z, мм', 'safeZ', .5, 50)}
          <div style={{fontSize:'11px', opacity:0.7, marginTop:'4px'}}>Ноль — выбранная точка платы. При «по центру» плата уходит в отрицательные координаты, если X/Y=0. Установите X = W/2+запас, Y = H/2+запас, чтобы вся плата была в плюсе, или оставьте 0 для центрирования.</div>
        </details>
        <div className={'cnc-fit-compact' + (fits === false ? ' is-bad' : '')}>
          {analysis ? (fits ? 'Фреза проходит' : 'Фреза не проходит в зазор') : analyzing ? 'Проверка зазоров…' : 'Зазоры не проверены'}
          <button className="btn" disabled={!analysis} onClick={() => {
            if (analysis) { invalidate(); setSettings(pickForBoard(settings, analysis, doc)); }
          }}>Подобрать фрезу</button>
        </div>
      </div>
      <section className="cnc-demo" aria-label="Демонстрация обработки">
        <h3>Демонстрация обработки</h3>
        {building ? <div className="cnc-empty"><span>Расчёт траекторий · {Math.round(progress)}%</span><progress max="100" value={progress} /></div>
          : job ? <CncPreview doc={doc} settings={settings} job={job} />
          : <div className="cnc-empty"><span className="cnc-empty-symbol" aria-hidden="true">⌁</span><span>Траектории ещё не построены</span>
            <button className="btn primary" onClick={build}>Построить и показать</button></div>}
        {error && <p role="alert" className="cnc-error">{error}</p>}
        {job && <details className="cnc-advanced"><summary>Файлы · {job.files.filter(f => f.name.endsWith('.nc')).length} программ</summary>
          <ul className="cnc-file-list">{job.files.filter(f => f.name.endsWith('.nc')).map(f => <li key={f.name}>{f.name}</li>)}</ul>
        </details>}
      </section>
    </div>
    <div className="cnc-safety-line">Перед запуском: проверьте Z0, инструмент и крепление.</div>
  </Modal>;
}
