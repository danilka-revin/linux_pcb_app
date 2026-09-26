import { useEffect, useMemo, useRef, useState } from 'react';
import type { Doc } from '../pcb/model';
import type { PlacementResult } from '../pcb/autoplace';
import type { NetRouteVariant } from '../pcb/netroute';
import { drawFlat, zOrdered } from '../pcb/render';
import { Modal } from './widgets';

/** Isolated preview: never changes the editor document, selection or undo stack. */
export function LayoutPreview({ doc, label }: { doc: Doc; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#161c23'; ctx.fillRect(0, 0, w, h);
    const s = Math.min((w - 32) / doc.w, (h - 32) / doc.h);
    const ox = (w - doc.w * s) / 2, oy = (h + doc.h * s) / 2;
    ctx.fillStyle = '#252e35'; ctx.fillRect(ox, oy - doc.h * s, doc.w * s, doc.h * s);
    ctx.strokeStyle = '#7f919d'; ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy - doc.h * s, doc.w * s, doc.h * s);
    drawFlat(ctx, { s, ox, oy, mir: false }, zOrdered(doc));
  }, [doc]);
  return <canvas ref={ref} className="layout-preview" width={1000} height={400} role="img" aria-label={label} />;
}

export function AutoPlaceDialog({ doc, selected, clearance, onApply, onClose }: {
  doc: Doc; selected: Set<string>; clearance: number;
  onApply: (r: PlacementResult) => void; onClose: () => void;
}) {
  const [gap, setGap] = useState(String(Math.max(0.5, clearance)));
  const [edge, setEdge] = useState('1');
  const [rotate, setRotate] = useState(true);
  const [result, setResult] = useState<PlacementResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  // Changing parameters invalidates the preview immediately and cancels old work.
  useEffect(() => {
    setResult(null); setError(''); setBusy(false);
    return () => { workerRef.current?.terminate(); workerRef.current = null; };
  }, [gap, edge, rotate, doc, selected]);
  const count = doc.entities.filter((e) => e.kind === 'comp' && (!selected.size || selected.has(e.id))).length;
  const gapValue = gap.trim() ? Number(gap.replace(',', '.')) : NaN;
  const edgeValue = edge.trim() ? Number(edge.replace(',', '.')) : NaN;
  const valid = Number.isFinite(gapValue) && gapValue >= 0.1 && Number.isFinite(edgeValue) && edgeValue >= 0;
  const calculate = () => {
    if (!valid || busy) return;
    setResult(null); setError(''); setBusy(true);
    try {
      const worker = new Worker(new URL('../pcb/autoplace.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const finish = () => { worker.terminate(); workerRef.current = null; setBusy(false); };
      worker.onmessage = (event: MessageEvent<{ result?: PlacementResult; error?: string }>) => {
        if (workerRef.current !== worker) return;
        finish();
        if (event.data.error) setError(event.data.error);
        else if (event.data.result?.error) setError(event.data.result.error);
        else setResult(event.data.result ?? null);
      };
      worker.onerror = () => { if (workerRef.current !== worker) return; finish(); setError('Не удалось рассчитать компоновку. Плата не изменена.'); };
      worker.postMessage({ doc, selected: [...selected], opts: { gap: gapValue, edge: edgeValue, rotate } });
    } catch {
      workerRef.current?.terminate(); workerRef.current = null; setBusy(false);
      setError('Не удалось запустить расчёт. Плата не изменена.');
    }
  };
  const preview = useMemo(() => result ? { ...doc, entities: result.entities } : doc, [doc, result]);
  return <Modal title="Автокомпоновка компонентов" className="auto-layout-modal" onClose={onClose} foot={<>
    <button className="btn" onClick={onClose}>Отмена</button>
    <button className="btn" disabled={count < 2 || !valid || busy} onClick={calculate}>{busy ? 'Расчёт…' : 'Рассчитать компоновку'}</button>
    <button className="btn primary" disabled={!result || busy} onClick={() => result && onApply(result)}>Применить компоновку</button>
  </>}>
    <p>{selected.size ? 'Выделенные компоненты' : 'Все компоненты'}: <b>{count}</b>. Собираем в компактную область, близкую к квадрату. Остальные элементы остаются на месте.</p>
    <div className="layout-settings">
      <label>Зазор между корпусами, мм<input className="txt" inputMode="decimal" value={gap} onChange={(e) => setGap(e.target.value)} /></label>
      <label>Отступ от края, мм<input className="txt" inputMode="decimal" value={edge} onChange={(e) => setEdge(e.target.value)} /></label>
      <label><input type="checkbox" checked={rotate} onChange={(e) => setRotate(e.target.checked)} /> Разрешить поворот на 90°</label>
    </div>
    {!valid && <p role="alert">Зазор — от 0,1 мм, отступ — неотрицательное число.</p>}
    {count < 2 && <p role="alert">Нужно минимум два компонента. Снимите выделение, чтобы собрать все детали.</p>}
    {error && <p role="alert" className="route-msg bad">{error}</p>}
    <div role="status">{busy ? 'Подбираем размеры и повороты в фоне…' : result
      ? `Габарит компонентов: ${result.beforeWidth.toFixed(1)} × ${result.beforeHeight.toFixed(1)} → ${result.width.toFixed(1)} × ${result.height.toFixed(1)} мм. Перемещается: ${result.count}.`
      : 'Исходная плата. Нажмите «Рассчитать компоновку» для предпросмотра.'}</div>
    <LayoutPreview doc={preview} label={result ? 'Предпросмотр автокомпоновки' : 'Исходное размещение'} />
    <p className="hint">Размер самой платы не меняется. Учитываются габариты корпусов, площадок и неподвижные препятствия. Уже подключённые к неподвижной меди детали не перемещаются. Это плотная эвристическая укладка, не гарантия абсолютного минимума или полной разводимости. Применение отменяется одним Ctrl+Z.</p>
  </Modal>;
}

export function RouteVariantsDialog({ doc, variants, onApply, onClose }: {
  doc: Doc; variants: NetRouteVariant[];
  onApply: (r: NetRouteVariant) => void; onClose: () => void;
}) {
  const [chosen, setChosen] = useState(0);
  const r = variants[chosen];
  const preview = useMemo(() => ({ ...doc, entities: [...doc.entities, ...r.ents] }), [doc, r]);
  const totalGroups = doc.nets?.length ?? 0;
  return <Modal title="Выберите вариант трассировки групп" className="auto-layout-modal route-choice-modal" onClose={onClose} foot={<>
    <button className="btn" onClick={onClose}>Отмена — оставить плату</button>
    <button className="btn primary" disabled={!r.ents.length} onClick={() => onApply(r)}>Применить вариант {chosen + 1}</button>
  </>}>
    <p>Три стратегии на одной исходной плате. Сравните результаты и выберите подходящий. До применения дорожки не добавляются.</p>
    <div className="route-variants" role="radiogroup" aria-label="Варианты трассировки">
      {variants.map((v, i) => <label key={v.strategy} className={'route-variant' + (i === chosen ? ' selected' : '')}>
        <strong><input type="radio" name="route-variant" checked={i === chosen} onChange={() => setChosen(i)} /> {i + 1}. {v.title}</strong>
        <span className="hint">{v.description}</span>
        <dl>
          <div><dt>Групп соединено</dt><dd>{totalGroups - v.unresolved.length} / {totalGroups}</dd></div>
          <div><dt>Осталось связей</dt><dd>{v.missing}</dd></div>
          <div><dt>Новые дорожки</dt><dd>{v.length.toFixed(1)} мм</dd></div>
          <div><dt>Новых переходов</dt><dd>{v.vias}</dd></div>
        </dl>
        <span className={'route-msg ' + (v.missing ? 'bad' : 'ok')}>{v.missing ? 'Частичная разводка' : 'Все группы соединены'}</span>
        <small className="variant-note">{v.sameAs !== undefined ? `Геометрия совпала с вариантом ${v.sameAs + 1}.` : 'Отдельный результат стратегии.'}</small>
      </label>)}
    </div>
    <LayoutPreview doc={preview} label={`Предпросмотр варианта ${chosen + 1}`} />
    <p className="hint">Вид сверху · K1 и K2 показаны цветами слоёв. Ширина, зазоры и запрет верхнего слоя соблюдаются во всех стратегиях. Минимум длины или переходов не гарантируется.</p>
    {r.unresolved.length > 0 && <p role="status">Не разведены: {r.unresolved.map((n) => `«${n.name}» — ${n.missing}`).join('; ')}. Можно применить частичный результат, затем изменить параметры и продолжить.</p>}
    {!r.ents.length && <p role="status">{r.missing ? 'Новых путей не найдено. Измените параметры трассировки или размещение.' : 'Ничего добавлять не нужно: группы уже соединены.'}</p>}
  </Modal>;
}
