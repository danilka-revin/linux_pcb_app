// Настройка станка, асинхронный CAM и проверка траекторий перед скачиванием.
// Рядом с каждой группой параметров — интерактивная схема «что за что отвечает»
// (те же схемы вшиваются в ZIP как 00b_SHEMY_PARAMETROV.svg); построение и
// проверка показываются интерактивными полосами прогресса.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc, Pt } from '../pcb/model';
import type { CncJob, CncStage } from '../pcb/cnc';
import { DEFAULT_CNC_SETTINGS, validateCncSettings, type CncSettings } from '../pcb/cnc-settings';
import { drillScheme, filesScheme, flipScheme, isolationScheme, outlineScheme, workZeroScheme } from '../pcb/cnc-schemes';
import { download, makeZip } from '../pcb/zip';
import { Modal, NI } from './widgets';
import { ProgressBar, type PbStep } from './progress';
import { Scheme } from './cnc-schemes';

const KEY = 'psbees.cnc.settings';
const n = (v: number) => String(Number(v.toFixed(3)));

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

function svgPath(paths: Pt[][]): string {
  return paths.map((path) => `M${path.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}Z`).join('');
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
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  useEffect(() => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setBp(null); setSeenSides({ top: false, bottom: false });
  }, [doc]);

  const invalidate = () => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setBp(null); setSeenSides({ top: false, bottom: false }); setError('');
  };
  const change = <K extends keyof CncSettings>(key: K, value: CncSettings[K]) => {
    invalidate();
    setSettings((old) => ({ ...old, [key]: value }));
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

  const loops = previewSide === 'top' ? job?.preview.top : job?.preview.bottom;
  const copper = previewSide === 'top' ? job?.preview.copperTop : job?.preview.copperBottom;
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
      hint: 'Сверьте жёлтую медь, светлый контур фрезы и красные отверстия с чертежом.',
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

  return <Modal title="ЧПУ: фрезеровка и сверловка (G-code / GRBL)" className="cnc-modal" onClose={onClose}
    foot={<>
      <button className="btn" onClick={onClose}>Закрыть</button>
      <button className="btn" disabled={building} onClick={build}>{building ? 'Строим траектории…' : 'Построить и проверить'}</button>
      <button className="btn primary" disabled={!job || !reviewed || !seenAll || building} onClick={save}>Скачать CNC ZIP</button>
    </>}>
    <p className="cnc-intro">Плата «{doc.name}», {n(doc.w)} × {n(doc.h)} мм. Отдельные программы верхней/зеркальной нижней меди,
      отдельная программа для каждого сверла. Под каждой группой параметров — <b>схема «что за что отвечает»</b>
      (наведите на подпись или узел чертежа); те же схемы лежат в ZIP файлом <code>00b_SHEMY_PARAMETROV.svg</code>.
      Настройки ниже — <b>пример, а не проверенный режим вашего станка</b>.</p>

    {building && <ProgressBar
      label="Построение траекторий ЧПУ…"
      pct={buildPct} live steps={buildSteps}
      meta={bp ? `сейчас: ${STAGES.find((s) => s.id === bp.stage)?.label ?? ''}` : 'подготовка'}
    />}

    <div className="cnc-settings">
      <section>
        <h3>1. Рабочий ноль и безопасный подъём</h3>
        <p>Ноль X/Y — нижний левый угол заготовки (вид на обрабатываемую сторону). Плата начинается с указанного отступа.
          Ноль Z — поверхность текущей стороны платы, после каждой смены инструмента выставить заново.</p>
        <Scheme built={schemes.zero} />
        <div className="cnc-fields">
          <NI label="Отступ платы X, мм" value={settings.originX} on={(v) => change('originX', v)} min={0} max={50} />
          <NI label="Отступ платы Y, мм" value={settings.originY} on={(v) => change('originY', v)} min={0} max={50} />
          <NI label="Безопасный Z, мм" value={settings.safeZ} on={(v) => change('safeZ', v)} min={0.5} max={50} />
        </div>
        <p>Заготовка от {n(doc.w + 2 * settings.originX)} × {n(doc.h + 2 * settings.originY)} мм; зажимы должны быть <b>ниже безопасного Z</b>.</p>
      </section>

      <section>
        <h3>2. Изоляция меди — одна фреза для K1 и K2</h3>
        <p>Обход объединённой меди снаружи на радиус фрезы + зазор. Это не сплошная очистка меди.
          Для V-фрезы укажите <b>фактическую ширину реза на глубине</b>.</p>
        <Scheme built={schemes.iso} />
        <div className="cnc-fields">
          <NI label="Диаметр фрезы, мм" value={settings.toolDiameter} on={(v) => change('toolDiameter', v)} min={0.1} max={6} step={0.05} />
          <NI label="Зазор до меди, мм" value={settings.clearance} on={(v) => change('clearance', v)} min={0} max={2} step={0.05} />
          <NI label="Глубина реза, мм" value={settings.isolationDepth} on={(v) => change('isolationDepth', v)} min={0.01} max={2} step={0.01} />
          <NI label="Подача XY, мм/мин" value={settings.isolationFeed} on={(v) => change('isolationFeed', v)} min={1} max={5000} step={10} />
          <NI label="Врезание Z, мм/мин" value={settings.isolationPlunge} on={(v) => change('isolationPlunge', v)} min={1} max={5000} step={10} />
          <NI label="Обороты S, об/мин" value={settings.isolationRpm} on={(v) => change('isolationRpm', v)} min={100} max={60000} step={100} />
        </div>
      </section>

      <section>
        <h3>3. Сверловка — отдельный .nc на каждый диаметр</h3>
        <p>Смена сверла <b>вручную между файлами</b> (M6 нет). По умолчанию сверлить сверху до переворота.
          Выберите низ, только если сверлите с перевёрнутой платы.</p>
        <Scheme built={schemes.drill} />
        <div className="radio-row">
          <label><input type="radio" checked={settings.drillSide === 'top'} onChange={() => change('drillSide', 'top')} />Сверлить сверху</label>
          <label><input type="radio" checked={settings.drillSide === 'bottom'} onChange={() => change('drillSide', 'bottom')} />Сверлить снизу (зеркало X)</label>
        </div>
        <div className="cnc-fields">
          <NI label="Глубина сверления, мм" value={settings.drillDepth} on={(v) => change('drillDepth', v)} min={0.1} max={10} step={0.1} />
          <NI label="Шаг по Z, мм" value={settings.drillStep} on={(v) => change('drillStep', v)} min={0.1} max={10} step={0.1} />
          <NI label="Подача Z, мм/мин" value={settings.drillFeed} on={(v) => change('drillFeed', v)} min={1} max={5000} step={10} />
          <NI label="Обороты S, об/мин" value={settings.drillRpm} on={(v) => change('drillRpm', v)} min={100} max={60000} step={100} />
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
      <svg className="cnc-preview" viewBox={`${-settings.originX} ${-settings.originY} ${doc.w + 2 * settings.originX} ${doc.h + 2 * settings.originY}`}
        role="img" aria-label={`Вид сверху на ${previewSide === 'top' ? 'верх' : 'зеркальную нижнюю сторону'} платы: медь, изоляция и отверстия`}>
        <g transform={`translate(0 ${doc.h}) scale(1 -1)`}>
          <rect x={0} y={0} width={doc.w} height={doc.h} className="cnc-preview-board" />
          {copper && <path d={svgPath(copper)} fillRule="evenodd" className="cnc-preview-copper" />}
          {loops && <path d={svgPath(loops)} className="cnc-preview-path" />}
          {settings.drillSide === previewSide && job.preview.drills.map((p, i) =>
            <circle key={i} cx={p.x} cy={p.y} r={Math.max(0.2, Math.min(doc.w, doc.h) / 120)} className="cnc-preview-hole" />)}
        </g>
      </svg>
      <div className="cnc-preview-legend">Медь — жёлтая; центр фрезы — светлая линия; отверстия — красные точки. Внешняя рамка — плата, отступы — заготовка.</div>
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
