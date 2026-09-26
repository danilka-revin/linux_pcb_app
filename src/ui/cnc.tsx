// Настройка станка, асинхронный CAM и проверка траекторий перед скачиванием.
import { useEffect, useRef, useState } from 'react';
import type { Doc, Pt } from '../pcb/model';
import type { CncJob } from '../pcb/cnc';
import { DEFAULT_CNC_SETTINGS, validateCncSettings, type CncSettings } from '../pcb/cnc-settings';
import { download, makeZip } from '../pcb/zip';
import { Modal, NI } from './widgets';

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

export function CncDialog({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const [settings, setSettings] = useState(loadSettings);
  const [job, setJob] = useState<CncJob | null>(null);
  const [error, setError] = useState('');
  const [building, setBuilding] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [previewSide, setPreviewSide] = useState<'top' | 'bottom'>('top');
  const [seenSides, setSeenSides] = useState({ top: false, bottom: false });
  const worker = useRef<Worker | null>(null);

  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  useEffect(() => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setSeenSides({ top: false, bottom: false });
  }, [doc]);

  const invalidate = () => {
    worker.current?.terminate(); worker.current = null;
    setJob(null); setReviewed(false); setBuilding(false); setSeenSides({ top: false, bottom: false }); setError('');
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
      next.onmessage = (event: MessageEvent<{ ok: true; job: CncJob } | { ok: false; error: string }>) => {
        if (worker.current !== next) return;
        worker.current = null; next.terminate(); setBuilding(false);
        if (event.data.ok) {
          setJob(event.data.job);
          setSeenSides({ top: previewSide === 'top', bottom: previewSide === 'bottom' });
        } else setError(event.data.error);
      };
      next.onerror = () => {
        if (worker.current !== next) return;
        worker.current = null; next.terminate(); setBuilding(false);
        setError('Не удалось построить траектории ЧПУ. Проверьте плату и попробуйте ещё раз.');
      };
      next.postMessage({ doc, settings });
    } catch (e) {
      setBuilding(false);
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

  return <Modal title="ЧПУ: фрезеровка и сверловка (G-code / GRBL)" className="cnc-modal" onClose={onClose}
    foot={<>
      <button className="btn" onClick={onClose}>Закрыть</button>
      <button className="btn" disabled={building} onClick={build}>{building ? 'Строим траектории…' : 'Построить и проверить'}</button>
      <button className="btn primary" disabled={!job || !reviewed || !seenAll || building} onClick={save}>Скачать CNC ZIP</button>
    </>}>
    <p className="cnc-intro">Плата «{doc.name}», {n(doc.w)} × {n(doc.h)} мм. Отдельные программы верхней/зеркальной нижней меди,
      отдельная программа для каждого сверла. Настройки ниже — <b>пример, а не проверенный режим вашего станка</b>.</p>

    <div className="cnc-settings">
      <section>
        <h3>1. Рабочий ноль и безопасный подъём</h3>
        <p>Ноль X/Y — нижний левый угол заготовки (вид на обрабатываемую сторону). Плата начинается с указанного отступа.
          Ноль Z — поверхность текущей стороны платы, после каждой смены инструмента выставить заново.</p>
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
        <label className="chk"><input type="checkbox" checked={settings.cutOutline} onChange={(e) => change('cutOutline', e.target.checked)} />
          <b>4. Дополнительно: вырезать прямоугольный контур ПОСЛЕДНИМ</b></label>
        <p>По умолчанию выключено: вырезается БЕЗ перемычек, плату надо закрепить до конца обработки.
          Сложный контур не поддерживается — нужен CAM для Gerber.</p>
        {settings.cutOutline && <div className="cnc-fields">
          <NI label="Диаметр фрезы, мм" value={settings.outlineDiameter} on={(v) => change('outlineDiameter', v)} min={0.1} max={10} />
          <NI label="Глубина реза, мм" value={settings.outlineDepth} on={(v) => change('outlineDepth', v)} min={0.1} max={10} step={0.1} />
          <NI label="Шаг прохода, мм" value={settings.outlineStep} on={(v) => change('outlineStep', v)} min={0.1} max={10} step={0.1} />
          <NI label="Подача XY, мм/мин" value={settings.outlineFeed} on={(v) => change('outlineFeed', v)} min={1} max={5000} step={10} />
          <NI label="Обороты S, об/мин" value={settings.outlineRpm} on={(v) => change('outlineRpm', v)} min={100} max={60000} step={100} />
        </div>}
      </section>
    </div>

    {error && <p role="alert" className="cnc-error">{error}</p>}
    {building && <p role="status">Построение медных контуров, компенсация диаметра инструмента и проверка зазоров…</p>}
    {job && <section className="cnc-result">
      <h3>5. Проверьте траектории перед загрузкой в станок</h3>
      <p>Верх K1: <b>{job.topLoops}</b> замкнутых контуров; низ K2 (зеркало X): <b>{job.bottomLoops}</b>;
        сверла: <b>{job.drills.length}</b> отдельных файлов; {job.drills.reduce((sum, d) => sum + d.count, 0)} отверстий
        {job.outlinePasses ? `; контур: ${job.outlinePasses} проходов` : ''}.</p>
      {job.drills.length > 0 && <p>Свёрла: {job.drills.map((d) => `Ø${n(d.diameter)} — ${d.count} шт.`).join('; ')}.</p>}
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
    </section>}
    <div className="hint cnc-warning">Перед запуском прочитайте инструкцию в ZIP. Не запускайте файлы подряд без ручной смены сверла и настройки Z0.
      Контроллер должен поддерживать GRBL-совместимый G-code. Параметры этого компьютера сохраняются после скачивания.</div>
  </Modal>;
}
