// Настройка станка, асинхронный CAM и проверка траекторий перед скачиванием.
// Зазоры подстраиваются под щели платы; превью показывает ход фрезы и разделение меди.
// Рядом с каждой группой параметров — интерактивная схема «что за что отвечает»
// (те же схемы вшиваются в ZIP как 00b_SHEMY_PARAMETROV.svg); построение и
// проверка показываются интерактивными полосами прогресса.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc } from '../pcb/model';
import type { CncJob, CncStage } from '../pcb/cnc';
import {
  DEFAULT_CNC_SETTINGS, autoFitGaps, isolationFits, isolationNeed, isolationOffset,
  pickForBoard, validateCncSettings, type CncBoardAnalysis, type CncSettings,
} from '../pcb/cnc-settings';
import { drillScheme, filesScheme, flipScheme, isolationScheme, outlineScheme, workZeroScheme } from '../pcb/cnc-schemes';
import { download, makeZip } from '../pcb/zip';
import { Modal, NI } from './widgets';
import { ProgressBar, type PbStep } from './progress';
import { Scheme } from './cnc-schemes';
import { CncPreview } from './cnc-preview';

const KEY = 'psbees.cnc.settings';
const n = (v: number) => String(Number(v.toFixed(3)));
const gapLabel = (g: number) => Number.isFinite(g) ? `${n(g)} мм` : 'широкие';

function loadSettings(): CncSettings {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (raw) {
      const saved = { ...DEFAULT_CNC_SETTINGS, ...JSON.parse(raw) } as CncSettings;
      validateCncSettings(saved);
      return saved;
    }
  } catch { /* при повреждённом сохранении — безопасные начальные параметры */ }
  return { ...DEFAULT_CNC_SETTINGS };
}

/** Этапы расчёта CAM: веса для общей полосы и подсказки «что считаем». */
const STAGES: { id: CncStage; label: string; weight: number; hint: string }[] = [
  { id: 'copper-top', label: 'Медь верха K1', weight: 2, hint: 'Дорожки и площадки верха объединяются в один контур — фреза не разрежет соединение.' },
  { id: 'copper-bottom', label: 'Медь низа K2', weight: 2, hint: 'То же для нижней меди.' },
  { id: 'isolation', label: 'Контуры изоляции', weight: 3, hint: 'Смещение на радиус фрезы + зазор и проверка, что фреза проходит между элементами.' },
  { id: 'drills', label: 'Сверловка', weight: 2, hint: 'Отверстия собираются по диаметрам, повторы в одной точке убираются.' },
  { id: 'gcode', label: 'Программы G-code', weight: 3, hint: 'Каждый инструмент — своя программа .nc с проверкой безопасности Z.' },
  { id: 'docs', label: 'Схемы и инструкция', weight: 1, hint: 'Схемы «что за что отвечает» и файл 00_PROCHTITE_PERED_ZAPUSKOM.txt.' },
];

export function CncDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [settings, setSettings] = useState(loadSettings);
  const [job, setJob] = useState<CncJob | null>(null);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);
  const [bp, setBp] = useState<{ stage: CncStage; frac: number } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [previewSide, setPreviewSide] = useState<'top' | 'bottom'>('top');
  const [seenSides, setSeenSides] = useState({ top: false, bottom: false });
  const [analysis, setAnalysis] = useState<CncBoardAnalysis | null>(null);
  const [fitNote, setFitNote] = useState('');
  const worker = useRef<Worker | null>(null);
  const fitDone = useRef(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  useEffect(() => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setBp(null); setSeenSides({ top: false, bottom: false });
    setAnalysis(null); setFitNote(''); fitDone.current = false;
    const w = new Worker(new URL('../pcb/cnc.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (event: MessageEvent<{ type?: string; analysis?: CncBoardAnalysis; error?: string }>) => {
      if (event.data?.type !== 'analysis') return;
      if (event.data.analysis) setAnalysis(event.data.analysis);
      else setFitNote(event.data.error || 'Не удалось оценить щели этой платы.');
      w.terminate();
    };
    w.onerror = () => { setFitNote('Не удалось оценить щели этой платы.'); w.terminate(); };
    w.postMessage({ op: 'analyze', doc });
    return () => w.terminate();
  }, [doc]);

  useEffect(() => {
    if (!analysis || fitDone.current) return;
    fitDone.current = true;
    const fitted = autoFitGaps(settingsRef.current, analysis, doc);
    if (fitted) {
      setSettings(fitted.settings);
      setFitNote(fitted.note);
    }
  }, [analysis, doc]);

  const invalidate = () => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setBp(null); setSeenSides({ top: false, bottom: false }); setError('');
  };
  const change = <K extends keyof CncSettings>(key: K, value: CncSettings[K]) => {
    invalidate();
    setSettings((old) => ({ ...old, [key]: value }));
  };
  const applyBoard = () => {
    if (!analysis) return;
    invalidate();
    const next = pickForBoard(settingsRef.current, analysis, doc);
    setSettings(next);
    setFitNote(`Подобрано под эту плату: фреза Ø${n(next.toolDiameter)} мм, запас ${n(next.clearance)} мм, разделение ${n(isolationNeed(next))} мм.`);
  };

  const build = () => {
    invalidate();
    try {
      validateCncSettings(settings);
      const next = new Worker(new URL('../pcb/cnc.worker.ts', import.meta.url), { type: 'module' });
      worker.current = next;
      setBuilding(true);
      setBp({ stage: 'copper-top', frac: 0 });
      next.onmessage = (event: MessageEvent<{ type?: string; stage?: CncStage; frac?: number } | { ok: true; job: CncJob } | { ok: false; error: string }>) => {
        if (worker.current !== next) return;
        if ('type' in event.data && event.data.type === 'progress') {
          setBp({ stage: event.data.stage ?? 'copper-top', frac: event.data.frac ?? 0 });
          return;
        }
        worker.current = null; next.terminate(); setBuilding(false); setBp(null);
        if ('ok' in event.data && event.data.ok) {
          setJob(event.data.job);
          setSeenSides({ top: previewSide === 'top', bottom: previewSide === 'bottom' });
        } else setError('error' in event.data ? event.data.error : 'Не удалось построить траектории ЧПУ.');
      };
      next.onerror = () => {
        if (worker.current !== next) return;
        worker.current = null; next.terminate(); setBuilding(false); setBp(null);
        setError('Не удалось построить траектории ЧПУ. Проверьте плату и попробуйте ещё раз.');
      };
      next.postMessage({ doc, settings });
    } catch (e) {
      setBuilding(false); setBp(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = () => {
    if (!job || !reviewed || !seenAll) return;
    const base = (doc.name || 'board').replace(/[^\wа-яА-ЯёЁ-]+/g, '_').slice(0, 100) || 'board';
    download(`${base}_cnc_grbl.zip`, makeZip(job.files));
    try { globalThis.localStorage?.setItem(KEY, JSON.stringify(settings)); }
    catch { /* приватный режим браузера */ }
  };

  const needTop = !!job && (job.topLoops > 0 || (job.drills.length > 0 && settings.drillSide === 'top'));
  const needBottom = !!job && (job.bottomLoops > 0 || (job.drills.length > 0 && settings.drillSide === 'bottom'));
  const seenAll = (!needTop || seenSides.top) && (!needBottom || seenSides.bottom);

  // Схемы пересчитываются вместе с параметрами: цифры на чертежах всегда живые.
  const schemes = useMemo(() => ({
    zero: workZeroScheme(doc, settings),
    iso: isolationScheme(settings),
    drill: drillScheme(settings),
    flip: flipScheme(doc, settings),
    out: outlineScheme(doc, settings),
    files: filesScheme(doc, settings, job ?? { topLoops: 0, bottomLoops: 0, drills: [], outlinePasses: 0 }),
  }), [doc, settings, job]);

  // Полоса прогресса расчёта с этапами и подсказками.
  const buildSteps: PbStep[] = (() => {
    const cur = bp ? STAGES.findIndex((x) => x.id === bp.stage) : -1;
    return STAGES.map((s, i) => ({
      id: s.id,
      label: s.label,
      hint: s.hint,
      state: !building && !bp ? 'wait' : i < cur ? 'done' : i === cur ? 'run' : 'wait',
      frac: i === cur ? bp?.frac ?? 0 : 0,
    }));
  })();
  const buildPct = (() => {
    if (!bp) return 0;
    const total = STAGES.reduce((a, s) => a + s.weight, 0);
    const idx = STAGES.findIndex((x) => x.id === bp.stage);
    const done = STAGES.slice(0, idx).reduce((a, s) => a + s.weight, 0);
    return ((done + bp.frac * (STAGES[idx]?.weight ?? 0)) / total) * 100;
  })();

  // Готовность к экспорту: сколько проверок уже выполнено (интерактивные шаги).
  const reviewSteps: PbStep[] = [
    { id: 'build', label: 'Построить траектории', state: job ? 'done' : 'wait', hint: 'Расчёт изоляции, сверловки и G-code в фоновом потоке.' },
    {
      id: 'top', label: 'Просмотреть верх K1', state: !job ? 'wait' : !needTop ? 'skip' : seenSides.top ? 'done' : 'wait',
      hint: 'Сверьте медь, канавку реза и нажмите «Старт — ход станка», чтобы увидеть, как пойдёт фреза.',
      onSelect: () => { setPreviewSide('top'); setSeenSides((v) => ({ ...v, top: true })); },
    },
    {
      id: 'bottom', label: 'Просмотреть низ K2 (зеркало)', state: !job ? 'wait' : !needBottom ? 'skip' : seenSides.bottom ? 'done' : 'wait',
      hint: 'Низ показан зеркально — как он выглядит после переворота лево/право.',
      onSelect: () => { setPreviewSide('bottom'); setSeenSides((v) => ({ ...v, bottom: true })); },
    },
    { id: 'confirm', label: 'Подтвердить проверку', state: reviewed ? 'done' : 'wait', hint: 'Галочка внизу: превью, нули, зажимы и инструменты проверены.' },
  ];
  const reviewDone = reviewSteps.filter((s) => s.state === 'done').length;
  const reviewPct = (reviewDone / reviewSteps.length) * 100;
  const need = isolationNeed(settings);
  const offset = isolationOffset(settings);
  const fits = analysis ? isolationFits(settings, analysis) : null;
  const pick = analysis ? pickForBoard(settings, analysis, doc) : null;

  return <Modal title="ЧПУ: фрезеровка и сверловка (G-code / GRBL)" className="cnc-modal" onClose={onClose}
    foot={<>
      <button className="btn" onClick={onClose}>Закрыть</button>
      <button className="btn" disabled={building} onClick={build}>{building ? 'Строим траектории…' : 'Построить и проверить'}</button>
      <button className="btn primary" disabled={!job || !reviewed || !seenAll || building} onClick={save}>Скачать CNC ZIP</button>
    </>}>
    <p className="cnc-intro">Плата «{doc.name}», {n(doc.w)} × {n(doc.h)} мм. Фреза обходит дорожки канавкой — это не зачистка всей фольги.
      Зазоры ниже <b>подстраиваются под щели этой платы</b>. После построения можно <b>смотреть, как пойдёт станок</b>.
      Под группами — схемы «что за что отвечает» (они же в ZIP: <code>00b_SHEMY_PARAMETROV.svg</code>).
      Числа — <b>пример, а не проверенный режим вашего станка</b>.</p>

    <div className={'cnc-fit' + (fits === false ? ' is-bad' : fits ? ' is-ok' : '')}>
      <div className="cnc-fit-grid">
        <div className="cnc-fit-gap">
          <b>Разделение меди</b>
          <strong>{n(need)} мм</strong>
          <small>рез Ø{n(settings.toolDiameter)} + запас {n(settings.clearance)} мм × 2</small>
        </div>
        <div>
          <b>Щели на этой плате</b>
          <strong>{analysis ? gapLabel(analysis.minGap) : 'считаем…'}</strong>
          <small>{fits === false ? 'фреза не пройдёт — подберите тоньше' : fits ? 'фрезе есть куда пройти' : 'смотрим дорожки платы'}</small>
        </div>
        <div>
          <b>Заготовка</b>
          <strong>{n(doc.w + 2 * settings.originX)} × {n(doc.h + 2 * settings.originY)}</strong>
          <small>отступы {n(settings.originX)} и {n(settings.originY)} мм, центр фрезы +{n(offset)} мм от меди</small>
        </div>
      </div>
      {fitNote && <p className="cnc-fit-note">{fitNote}</p>}
      {fits === false && pick && <p className="cnc-fit-note">Для этой платы подойдёт Ø{n(pick.toolDiameter)} мм и запас {n(pick.clearance)} мм (разделение {n(isolationNeed(pick))} мм).</p>}
      <button type="button" className="btn" disabled={!analysis} onClick={applyBoard}>Подобрать под эту плату</button>
    </div>

    {building && <ProgressBar
      label="Построение траекторий ЧПУ…"
      pct={buildPct} live steps={buildSteps}
      meta={bp ? `сейчас: ${STAGES.find((s) => s.id === bp.stage)?.label ?? ''}` : 'подготовка'}
    />}

    <div className="cnc-settings">
      <section>
        <h3>1. Где плата лежит на столе</h3>
        <p>Ноль X/Y — нижний левый угол заготовки (смотрите на ту сторону, которую сейчас режете). Отступы — воздух от нуля до края платы,
          чтобы фреза и зажимы не столкнулись. Ноль Z — поверхность этой стороны; после каждой смены инструмента выставьте заново.</p>
        <Scheme built={schemes.zero} />
        <div className="cnc-fields">
          <NI label="Отступ слева, мм" value={settings.originX} on={(v) => change('originX', v)} min={0} max={50} />
          <NI label="Отступ снизу, мм" value={settings.originY} on={(v) => change('originY', v)} min={0} max={50} />
          <NI label="Подъём над платой, мм" value={settings.safeZ} on={(v) => change('safeZ', v)} min={0.5} max={50} />
        </div>
        <p>Заготовка от {n(doc.w + 2 * settings.originX)} × {n(doc.h + 2 * settings.originY)} мм; зажимы должны быть <b>ниже подъёма</b>.</p>
      </section>

      <section>
        <h3>2. Как фреза обходит медь</h3>
        <p>Фреза идёт вокруг дорожек и вырезает канавку, чтобы они не коротнули с остальной фольгой.
          <b>Разделение меди {n(need)} мм</b> = ширина реза Ø{n(settings.toolDiameter)} + запас {n(settings.clearance)} мм с каждой стороны.
          Между двумя дорожками нужно столько свободного места. Для V-фрезы укажите <b>ширину реза на глубине</b>, не хвостовик.</p>
        <Scheme built={schemes.iso} />
        <div className="cnc-fields">
          <NI label="Ширина реза, мм" value={settings.toolDiameter} on={(v) => change('toolDiameter', v)} min={0.1} max={6} step={0.05} />
          <NI label="Запас до меди, мм" value={settings.clearance} on={(v) => change('clearance', v)} min={0} max={2} step={0.05} />
          <NI label="Глубина реза фольги, мм" value={settings.isolationDepth} on={(v) => change('isolationDepth', v)} min={0.01} max={2} step={0.01} />
          <NI label="Скорость по плате, мм/мин" value={settings.isolationFeed} on={(v) => change('isolationFeed', v)} min={1} max={5000} step={10} />
          <NI label="Скорость вниз, мм/мин" value={settings.isolationPlunge} on={(v) => change('isolationPlunge', v)} min={1} max={5000} step={10} />
          <NI label="Обороты шпинделя" value={settings.isolationRpm} on={(v) => change('isolationRpm', v)} min={100} max={60000} step={100} />
        </div>
      </section>

      <section>
        <h3>3. Сверление отверстий</h3>
        <p>Каждый диаметр — свой файл, отдельная программа для каждого сверла. Сверло меняете <b>руками между файлами</b> (команды смены нет).
          По умолчанию сверлим сверху, до переворота. «Снизу» — только если сверлите уже перевёрнутую плату.</p>
        <Scheme built={schemes.drill} />
        <div className="radio-row">
          <label><input type="radio" checked={settings.drillSide === 'top'} onChange={() => change('drillSide', 'top')} />Сверлить сверху</label>
          <label><input type="radio" checked={settings.drillSide === 'bottom'} onChange={() => change('drillSide', 'bottom')} />Сверлить снизу (зеркало X)</label>
        </div>
        <div className="cnc-fields">
          <NI label="Глубина, мм" value={settings.drillDepth} on={(v) => change('drillDepth', v)} min={0.1} max={10} step={0.1} />
          <NI label="Шаг вниз, мм" value={settings.drillStep} on={(v) => change('drillStep', v)} min={0.1} max={10} step={0.1} />
          <NI label="Скорость вниз, мм/мин" value={settings.drillFeed} on={(v) => change('drillFeed', v)} min={1} max={5000} step={10} />
          <NI label="Обороты шпинделя" value={settings.drillRpm} on={(v) => change('drillRpm', v)} min={100} max={60000} step={100} />
        </div>
      </section>

      <section>
        <h3>4. Переворот платы лево/право</h3>
        <p>Низ обрабатывается только после физического переворота в той же оснастке.
          X зеркалируется <b>один раз</b> — дополнительное отражение в УП станка не включать.</p>
        <Scheme built={schemes.flip} />
      </section>

      <section>
        <label className="chk"><input type="checkbox" checked={settings.cutOutline} onChange={(e) => change('cutOutline', e.target.checked)} />
          <b>5. Дополнительно: вырезать прямоугольный контур ПОСЛЕДНИМ</b></label>
        <p>По умолчанию выключено: вырезается БЕЗ перемычек, плату надо закрепить до конца обработки.
          Сложный контур не поддерживается — нужен CAM для Gerber.</p>
        {settings.cutOutline && <>
          <Scheme built={schemes.out} />
          <div className="cnc-fields">
            <NI label="Диаметр фрезы, мм" value={settings.outlineDiameter} on={(v) => change('outlineDiameter', v)} min={0.1} max={10} />
            <NI label="Глубина реза, мм" value={settings.outlineDepth} on={(v) => change('outlineDepth', v)} min={0.1} max={10} step={0.1} />
            <NI label="Шаг прохода, мм" value={settings.outlineStep} on={(v) => change('outlineStep', v)} min={0.1} max={10} step={0.1} />
            <NI label="Подача XY, мм/мин" value={settings.outlineFeed} on={(v) => change('outlineFeed', v)} min={1} max={5000} step={10} />
            <NI label="Обороты S, об/мин" value={settings.outlineRpm} on={(v) => change('outlineRpm', v)} min={100} max={60000} step={100} />
          </div>
        </>}
      </section>
    </div>

    {error && <p role="alert" className="cnc-error">{error}</p>}
    <section className="cnc-result">
      <h3>6. {job ? 'Проверьте траектории перед загрузкой в станок' : 'Готовность к экспорту'}</h3>
      <ProgressBar
        label="Готовность к экспорту"
        pct={reviewPct}
        tone={reviewDone === reviewSteps.length ? 'ok' : 'accent'}
        steps={reviewSteps}
        meta={reviewDone === reviewSteps.length ? 'Все проверки выполнены — можно скачивать ZIP.' : job ? 'Нажимайте на шаги: схема откроет нужную сторону превью.' : 'Нажмите «Построить и проверить» — расчёт идёт в фоне.'}
      />
      {job && <>
      <p>Верх K1: <b>{job.topLoops}</b> замкнутых контуров; низ K2 (зеркало X): <b>{job.bottomLoops}</b>;
        сверла: <b>{job.drills.length}</b> отдельных файлов; {job.drills.reduce((sum, d) => sum + d.count, 0)} отверстий
        {job.outlinePasses ? `; контур: ${job.outlinePasses} проходов` : ''}.</p>
      {job.drills.length > 0 && <p>Свёрла: {job.drills.map((d) => `Ø${n(d.diameter)} — ${d.count} шт.`).join('; ')}.</p>}
      <Scheme built={schemes.files} />
      <p>Самостоятельные файлы ZIP (запускайте только нужный файл после ручной установки инструмента):</p>
      <ul className="cnc-file-list">{job.files.map((f) => <li key={f.name}>{f.name}</li>)}</ul>
      <div className="radio-row" role="tablist" aria-label="Предпросмотр фрезеровки">
        <button className={'btn' + (previewSide === 'top' ? ' primary' : '')} role="tab" aria-selected={previewSide === 'top'} onClick={() => { setPreviewSide('top'); setSeenSides((v) => ({ ...v, top: true })); }}>Верх K1</button>
        <button className={'btn' + (previewSide === 'bottom' ? ' primary' : '')} role="tab" aria-selected={previewSide === 'bottom'} onClick={() => { setPreviewSide('bottom'); setSeenSides((v) => ({ ...v, bottom: true })); }}>Низ K2 — зеркально</button>
      </div>
      <CncPreview doc={doc} settings={settings} job={job} side={previewSide} />
      <p>Низ фрезеруется <b>только после физического переворота лево/право</b> в той же оснастке: X′ = ширина платы − X. X/Y не перенастраивать; Z0 выставить по поверхности низа.</p>
      {!seenAll && <p className="cnc-error">Просмотрите обе стороны с операциями, прежде чем подтверждать экспорт.</p>}
      <label className="chk cnc-confirm"><input type="checkbox" checked={reviewed} disabled={!seenAll} onChange={(e) => setReviewed(e.target.checked)} />
        Я проверил(а) превью обеих сторон, привязку нуля, зажимы и инструменты. Перед работой выполню холостой прогон и проверю параметры резания своего станка.</label>
      </>}
    </section>
    <div className="hint cnc-warning">Перед запуском прочитайте инструкцию и схемы в ZIP. Не запускайте файлы подряд без ручной смены сверла и настройки Z0.
      Контроллер должен поддерживать GRBL-совместимый G-code. Параметры этого компьютера сохраняются после скачивания.</div>
  </Modal>;
}
