// Настройка дифференциальных пар, приблизительный импеданс и выравнивание длин.
import { useMemo, useState } from 'react';
import type { DifferentialPair, Doc } from '../pcb/model';
import { netLengths } from '../pcb/lengths';
import { differentialImpedance, solveDifferentialWidth, type MicrostripStackup } from '../pcb/impedance';
import { fmt } from '../pcb/model';
import { Modal } from './widgets';

const nfmt = (n: number, digits = 1): string => n.toFixed(digits).replace('.', ',');
const fieldNum = (s: string, fallback: number): number => {
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) ? v : fallback;
};

export function DifferentialPairsDialog({ doc, onApply, onAlignBus, onClose }: {
  doc: Doc;
  onApply: (pairs: DifferentialPair[]) => void;
  onAlignBus: (bus: string) => void;
  onClose: () => void;
}) {
  const nets = doc.nets ?? [];
  const lengths = useMemo(() => netLengths(doc.entities, nets), [doc.entities, nets]);
  const [pairs, setPairs] = useState<DifferentialPair[]>(() => (doc.diffPairs ?? []).map((p) => ({ ...p })));
  const [pos, setPos] = useState(nets[0]?.id ?? '');
  const [neg, setNeg] = useState(nets[1]?.id ?? '');
  const [target, setTarget] = useState('90');
  const [width, setWidth] = useState('0,2');
  const [gap, setGap] = useState('0,2');
  const [maxSkew, setMaxSkew] = useState('0,25');
  const [stack, setStack] = useState<MicrostripStackup>({ dielectricMm: 0.18, dielectricEr: 4.2, copperUm: 35 });
  const [saved, setSaved] = useState(false);
  const stackField = (key: keyof MicrostripStackup, value: number) => setStack((s) => ({ ...s, [key]: value }));
  const add = (): void => {
    if (!pos || !neg || pos === neg) return;
    const p = nets.find((n) => n.id === pos), n = nets.find((x) => x.id === neg);
    const pair: DifferentialPair = {
      id: `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `${p?.name ?? 'D+'} / ${n?.name ?? 'D-'}`,
      positiveNetId: pos, negativeNetId: neg,
      targetOhm: Math.max(1, fieldNum(target, 90)), widthMm: Math.max(0.03, fieldNum(width, 0.2)),
      gapMm: Math.max(0, fieldNum(gap, 0.2)), maxSkewMm: Math.max(0, fieldNum(maxSkew, 0.25)),
    };
    setSaved(false); setPairs((old) => [...old.filter((x) => ![x.positiveNetId, x.negativeNetId].some((id) => id === pos || id === neg)), pair]);
  };
  const patch = (id: string, values: Partial<DifferentialPair>): void => {
    setSaved(false); setPairs((old) => old.map((p) => p.id === id ? { ...p, ...values } : p));
  };
  const zResult = differentialImpedance(fieldNum(width, 0.2), fieldNum(gap, 0.2), stack);
  const solvedWidth = solveDifferentialWidth(fieldNum(target, 90), fieldNum(gap, 0.2), stack);
  const save = (): void => { onApply(pairs); setSaved(true); };

  return <Modal title="Дифференциальные пары и импеданс" className="diff-pairs-modal" onClose={onClose}
    foot={<><button className="btn" onClick={onClose}>Закрыть</button><button className="btn primary" onClick={save}>Сохранить пары и правила</button></>}>
    <p>Укажите две цепи, ширину и зазор. Приближённый микрополосковый расчёт помогает подобрать геометрию; фактический импеданс зависит от стека и технологии конкретного завода.</p>
    <div className="diff-stackup">
      <label>Диэлектрик до опорного слоя, мм<input className="txt" inputMode="decimal" value={nfmt(stack.dielectricMm, 3)} onChange={(e) => stackField('dielectricMm', fieldNum(e.target.value, stack.dielectricMm))} /></label>
      <label>Относительная εr<input className="txt" inputMode="decimal" value={nfmt(stack.dielectricEr, 2)} onChange={(e) => stackField('dielectricEr', fieldNum(e.target.value, stack.dielectricEr))} /></label>
      <label>Медь, мкм<input className="txt" inputMode="decimal" value={nfmt(stack.copperUm, 0)} onChange={(e) => stackField('copperUm', fieldNum(e.target.value, stack.copperUm))} /></label>
    </div>
    <div className="diff-calculator">
      <label>Целевой Zdiff, Ом<input className="txt" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
      <label>Ширина, мм<input className="txt" inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} /></label>
      <label>Зазор, мм<input className="txt" inputMode="decimal" value={gap} onChange={(e) => setGap(e.target.value)} /></label>
      <label>Допуск разности длин, мм<input className="txt" inputMode="decimal" value={maxSkew} onChange={(e) => setMaxSkew(e.target.value)} /></label>
      <div className="diff-result"><b>{zResult.differentialOhm.toFixed(1)} Ω diff</b><span>Однопроводный: {zResult.singleEndedOhm.toFixed(1)} Ω</span>
        {solvedWidth ? <button className="btn tiny" onClick={() => setWidth(nfmt(solvedWidth, 3))}>Ширина для цели: {nfmt(solvedWidth, 3)} мм</button>
          : <small>Цель вне диапазона расчётной модели</small>}</div>
    </div>

    <div className="diff-create">
      <label>Положительная цепь<select className="txt" value={pos} onChange={(e) => setPos(e.target.value)}>
        {nets.map((net) => <option key={net.id} value={net.id}>{net.name}</option>)}</select></label>
      <label>Отрицательная цепь<select className="txt" value={neg} onChange={(e) => setNeg(e.target.value)}>
        {nets.map((net) => <option key={net.id} value={net.id}>{net.name}</option>)}</select></label>
      <button className="btn" disabled={!nets.length || !pos || !neg || pos === neg} onClick={add}>Добавить пару</button>
    </div>
    {!nets.length && <div className="hint">Сначала создайте группы вручную или импортируйте netlist KiCad.</div>}
    <div className="diff-list">
      {pairs.map((pair) => {
        const p = nets.find((n) => n.id === pair.positiveNetId), n = nets.find((x) => x.id === pair.negativeNetId);
        const lp = lengths.get(pair.positiveNetId)?.length ?? 0, ln = lengths.get(pair.negativeNetId)?.length ?? 0;
        const skew = Math.abs(lp - ln);
        const z = differentialImpedance(pair.widthMm, pair.gapMm, stack);
        return <article className="diff-pair-card" key={pair.id}>
          <header><strong>{pair.name}</strong><button className="btn tiny danger" onClick={() => { setSaved(false); setPairs((old) => old.filter((x) => x.id !== pair.id)); }}>Удалить</button></header>
          <div className="diff-pair-meta"><span>+ {p?.name ?? 'цепь удалена'} · {fmt(lp, 2)} мм</span><span>− {n?.name ?? 'цепь удалена'} · {fmt(ln, 2)} мм</span>
            <b className={skew <= pair.maxSkewMm ? 'bus-ok' : 'bus-warn'}>Δ {fmt(skew, 2)} мм / лимит {fmt(pair.maxSkewMm, 2)} мм</b>
            <span>Расчёт: ~{z.differentialOhm.toFixed(1)} Ω diff</span></div>
          <div className="diff-pair-fields">
            <label>Цель, Ω<input className="txt" value={nfmt(pair.targetOhm, 1)} onChange={(e) => patch(pair.id, { targetOhm: Math.max(1, fieldNum(e.target.value, pair.targetOhm)) })} /></label>
            <label>Ширина, мм<input className="txt" value={nfmt(pair.widthMm, 3)} onChange={(e) => patch(pair.id, { widthMm: Math.max(0.03, fieldNum(e.target.value, pair.widthMm)) })} /></label>
            <label>Зазор, мм<input className="txt" value={nfmt(pair.gapMm, 3)} onChange={(e) => patch(pair.id, { gapMm: Math.max(0, fieldNum(e.target.value, pair.gapMm)) })} /></label>
            <label>Макс. skew, мм<input className="txt" value={nfmt(pair.maxSkewMm, 3)} onChange={(e) => patch(pair.id, { maxSkewMm: Math.max(0, fieldNum(e.target.value, pair.maxSkewMm)) })} /></label>
          </div>
          <button className="btn tiny" disabled={p?.bus !== pair.name || n?.bus !== pair.name} onClick={() => onAlignBus(pair.name)}>Выровнять длины змейками</button>
          {p?.bus !== pair.name || n?.bus !== pair.name ? <small className="hint">Сохраните пары, чтобы назначить цепям общую шину, затем выравнивание станет доступно.</small> : null}
        </article>;
      })}
    </div>
    <div className="hint diff-warning">Программа сохраняет пару, считает оценочный импеданс и контролирует skew. Текущий автотрассировщик не ведёт две дорожки совместно с постоянным зазором; проверяйте геометрию пары отдельно.</div>
    {saved && <div className="cloud-success" role="status">Пары и общие шины сохранены в проекте.</div>}
  </Modal>;
}
