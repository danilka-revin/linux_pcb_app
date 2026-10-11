import { useEffect, useMemo, useState } from 'react';
import type { Net, NetRules } from '../pcb/model';
import { fmt } from '../pcb/model';
import type { RouteEnd } from '../pcb/autoroute';
import { netMissing } from '../pcb/netroute';
import { busSummaries, LENGTH_TOLERANCE, type NetLength } from '../pcb/lengths';
import { NIO, SI } from './widgets';

export const NET_COLORS = ['#64ceff', '#ffa86b', '#d99dff', '#f4db67', '#80e5b1', '#ff8fad'];

/** Общие настройки автотрассировки: значения по умолчанию для групп без правил. */
export interface NetDefaults {
  w: number;
  clear: number;
  viaSize: number;
  viaDrill: number;
  allowTop: boolean;
}

/** Пустые поля в rules не храним: так они и значат «как у всех». */
function cleanRules(r: NetRules): NetRules | undefined {
  const out: NetRules = {};
  if (r.w !== undefined) out.w = r.w;
  if (r.clear !== undefined) out.clear = r.clear;
  if (r.viaSize !== undefined) out.viaSize = r.viaSize;
  if (r.viaDrill !== undefined) out.viaDrill = r.viaDrill;
  if (r.allowTop !== undefined) out.allowTop = r.allowTop;
  return Object.keys(out).length ? out : undefined;
}

/** Ширина дорожек группы прямо в строке списка: пусто — общая настройка. */
function WidthCell({ name, value, fallback, on }: {
  name: string;
  value: number | undefined;
  fallback: number;
  on: (v: number | undefined) => void;
}) {
  const show = (v: number | undefined): string => (v === undefined ? '' : fmt(v));
  const [s, setS] = useState(show(value));
  useEffect(() => setS(show(value)), [value]);
  const commit = () => {
    const t = s.trim().replace(',', '.');
    if (!t) { if (value !== undefined) on(undefined); setS(''); return; }
    const v = parseFloat(t);
    if (!isFinite(v)) { setS(show(value)); return; }
    const r = Math.max(0.05, v);
    on(r);
    setS(fmt(r));
  };
  return (
    <label className="net-w" title={`Ширина дорожек этой группы, мм. Пусто — общая: ${fmt(fallback)} мм`}>
      <input
        className="txt"
        value={s}
        placeholder={fmt(fallback)}
        aria-label={`Ширина дорожки группы ${name}, мм`}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setS(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        }}
      />
      <span>мм</span>
    </label>
  );
}

/** Число для интерфейса: десятичная запятая, фиксированное число знаков. */
const num = (v: number, d = 1): string => v.toFixed(d).replace('.', ',');

export function NetsPanel({ nets, active, setActive, onChange, onNew, onRoute, ends, comp, info, defaults, lengths, lenInfo, onLengthen, onAlignBus }: {
  info: { msg: string; ok: boolean | null };
  nets: Net[];
  active: string | null;
  setActive: (id: string | null) => void;
  onChange: (nets: Net[]) => void;
  onNew: () => void;
  onRoute: () => void;
  ends: Map<string, RouteEnd>;
  comp: Map<string, string>;
  defaults: NetDefaults;
  /** длины цепей (см. netLengths в pcb/lengths) */
  lengths: Map<string, NetLength>;
  lenInfo: { msg: string; ok: boolean | null };
  /** змейка: цепь, целевая длина мм, высота зубца мм */
  onLengthen: (netId: string, target: number, height: number) => void;
  /** выровнять шину по самой длинной цепи */
  onAlignBus: (bus: string, height: number) => void;
}) {
  const [height, setHeight] = useState('1,2');
  const [target, setTarget] = useState('');
  const selected = nets.find((n) => n.id === active);
  const selLen = selected ? lengths.get(selected.id) : undefined;
  const summaries = useMemo(() => busSummaries(lengths.values()), [lengths]);
  const buses = useMemo(() => [...new Set(nets.map((n) => (n.bus ?? '').trim()).filter(Boolean))].sort(), [nets]);
  const heightValue = parseFloat(height.replace(',', '.'));
  const heightOk = isFinite(heightValue) && heightValue >= 0.1 && heightValue <= 5;
  // цель по умолчанию: самая длинная цепь шины или текущая длина, округлённая вверх до 0,1 мм
  const busMax = selLen?.bus ? summaries.find((s) => s.bus === selLen.bus)?.max ?? 0 : 0;
  const suggested = Math.ceil(Math.max(busMax, selLen?.length ?? 0) * 10 + 1e-9) / 10;
  useEffect(() => { setTarget(suggested ? num(suggested) : ''); }, [selected?.id, suggested]);
  const targetValue = parseFloat(target.replace(',', '.'));
  const targetOk = isFinite(targetValue) && targetValue > (selLen?.length ?? 0) + LENGTH_TOLERANCE;
  const setRules = (id: string, patch: Partial<NetRules>) => onChange(nets.map((n) => n.id === id
    ? { ...n, rules: cleanRules({ ...(n.rules ?? {}), ...patch }) }
    : n));
  const layerMode = selected?.rules?.allowTop === undefined ? 'auto' : selected.rules.allowTop ? 'top' : 'k2';
  return <section className="props nets-panel">
    <h3>Группы соединений</h3>
    <div className="hint">Одна группа — одна электрическая цепь. Выберите группу и кликайте по её контактам на плате: PTH, SMD и переходам, включая выводы компонентов. Повторный клик убирает площадку. У каждой группы может быть <b>своя ширина дорожки</b> (поле «мм» в строке) и свои зазоры.</div>
    <div className="row">
      <button className="btn" onClick={onNew}>+ Новая группа</button>
      <button className="btn" disabled={!selected} onClick={() => setActive(null)}>Готово</button>
    </div>
    <div className="net-list">
      {nets.map((net, i) => {
        const missingPads = net.pads.filter((id) => !ends.has(id)).length;
        const missing = netMissing(net, comp);
        const w = net.rules?.w;
        return <div className={'net-row' + (active === net.id ? ' active' : '')} key={net.id}>
          <button className="net-pick" onClick={() => setActive(net.id)} aria-pressed={active === net.id}>
            <span style={{ color: NET_COLORS[i % NET_COLORS.length] }}>●</span>
            <span>{net.name}<small>{net.pads.length} площадок · {missingPads ? `потеряно: ${missingPads}` : net.pads.length < 2 ? 'добавьте площадки' : missing ? `осталось связей: ${missing}` : 'соединена'}{w !== undefined ? ` · дорожка ${fmt(w)} мм` : ''}{lengths.get(net.id)?.tracks ? ` · ${num(lengths.get(net.id)!.length)} мм` : ''}{net.bus ? ` · шина ${net.bus}` : ''}</small></span>
          </button>
          <WidthCell name={net.name} value={w} fallback={defaults.w} on={(v) => setRules(net.id, { w: v })} />
          <button className="btn tiny danger" title={`Удалить группу ${net.name} (дорожки останутся)`} aria-label={`Удалить группу ${net.name}`} onClick={() => onChange(nets.filter((n) => n.id !== net.id))}>×</button>
        </div>;
      })}
    </div>
    <div className="net-length">
      <h4>Длины и шины</h4>
      <div className="hint">Длина цепи — сумма её дорожек, а не путь от источника до приёмника (для ветвистых цепей это важно). Шина — группа цепей одной длины (например, DDR DQ или SPI). «Выровнять» добавляет змейки самым коротким цепям шины.</div>
      {!summaries.length && <div className="hint">Назначьте цепям шину (поле «Шина» у выбранной группы), чтобы сравнить их длины.</div>}
      {summaries.map((bus) => <div className="bus-card" key={bus.bus}>
        <div className="bus-head"><strong>{bus.bus}</strong><span>{bus.nets.length} {bus.nets.length === 1 ? 'цепь' : bus.nets.length < 5 ? 'цепи' : 'цепей'}</span></div>
        <div className="bus-stats">
          <span>мин {num(bus.min)} мм</span><span>макс {num(bus.max)} мм</span>
          <span className={bus.skew <= LENGTH_TOLERANCE * 2 ? 'bus-ok' : 'bus-warn'}>разброс {num(bus.skew, 2)} мм</span>
          <span>итог {num(bus.total)} мм</span>
        </div>
        <ul className="bus-nets">{bus.nets.map((n) => <li key={n.netId}>
          <span>{n.name}</span><span>{n.tracks ? `${num(n.length, 2)} мм` : 'нет дорожек'}{n.missing ? ' · не соединена' : ''}</span>
        </li>)}</ul>
        <div className="row">
          <button className="btn tiny" disabled={bus.skew <= LENGTH_TOLERANCE * 2 || !heightOk || bus.nets.some((n) => !n.tracks)}
            title={bus.nets.some((n) => !n.tracks) ? 'Сначала проложите дорожки всем цепям шины' : 'Добавить змейки самым коротким цепям'}
            onClick={() => onAlignBus(bus.bus, heightValue)}>Выровнять по самой длинной</button>
        </div>
      </div>)}
      <div className="field"><label htmlFor="len-height">Высота зубца, мм</label><input className="txt" id="len-height" inputMode="decimal" value={height} aria-invalid={!heightOk} onChange={(e) => setHeight(e.target.value)} /></div>
      {!heightOk && <div className="hint bus-warn">Высота — от 0,1 до 5 мм.</div>}
      {selected && selLen?.tracks ? <div className="net-lengthen">
        <div className="field"><label htmlFor="len-target">Цель для «{selected.name}», мм</label><input className="txt" id="len-target" inputMode="decimal" value={target} aria-invalid={!targetOk} onChange={(e) => setTarget(e.target.value)} /></div>
        <div className="hint">Сейчас {num(selLen.length, 2)} мм. Змейка вставляется в прямые участки дорожек цепи и не должна касаться чужой меди.</div>
        <div className="row"><button className="btn" disabled={!targetOk || !heightOk} onClick={() => onLengthen(selected.id, targetValue, heightValue)}>Добавить змейку</button></div>
      </div> : selected ? <div className="hint">У «{selected.name}» пока нет дорожек: змейка добавляется к проложенным дорожкам.</div> : null}
      {lenInfo.msg && <div role="status" className={'route-msg ' + (lenInfo.ok === false ? 'bad' : lenInfo.ok ? 'ok' : '')}>{lenInfo.msg}</div>}
    </div>
    {selected && <div className="net-rules">
      <div className="field"><label htmlFor="net-name">Имя группы</label><input className="txt" id="net-name" aria-label="Имя группы" value={selected.name} onChange={(e) => onChange(nets.map((n) => n.id === active ? { ...n, name: e.target.value } : n))} /></div>
      <div className="field"><label htmlFor="net-bus">Шина</label><input className="txt" id="net-bus" list="net-bus-list" aria-label="Шина выравнивания длин" placeholder="например DDR_DQ — пусто, если не нужна" value={selected.bus ?? ''} onChange={(e) => onChange(nets.map((n) => n.id === active ? { ...n, bus: e.target.value.trim() ? e.target.value : undefined } : n))} /></div>
      <datalist id="net-bus-list">{buses.map((b) => <option key={b} value={b} />)}</datalist>
      <h4>Правила группы</h4>
      <div className="hint" style={{ padding: '0 0 4px' }}>Пустое поле — значение из общих настроек справа. Своя ширина пригодится силовым цепям и «земле», свой зазор — цепям, которым нужен запас.</div>
      <NIO label="Ширина дорожки" value={selected.rules?.w} fallback={defaults.w} min={0.05} max={5}
        on={(v) => setRules(selected.id, { w: v })} />
      <NIO label="Зазор до меди" value={selected.rules?.clear} fallback={defaults.clear} min={0.05} max={3}
        on={(v) => setRules(selected.id, { clear: v })} />
      <NIO label="Переход: Ø, мм" value={selected.rules?.viaSize} fallback={defaults.viaSize} min={0.3} max={6}
        on={(v) => setRules(selected.id, { viaSize: v })} />
      <NIO label="Переход: сверло" value={selected.rules?.viaDrill} fallback={defaults.viaDrill} min={0.1} max={5}
        on={(v) => setRules(selected.id, { viaDrill: v })} />
      <SI label="Слои группы" value={layerMode}
        options={[['auto', 'Как в общих настройках'], ['k2', 'Только K2, без переходов'], ['top', 'Разрешить верх (K1)']]}
        on={(v) => setRules(selected.id, { allowTop: v === 'auto' ? undefined : v === 'top' })} />
      {layerMode === 'top' && !defaults.allowTop && (
        <div className="hint" style={{ padding: '2px 0 0' }}>Верхний слой запрещён общей настройкой «Разрешить верх (K1) и переходы» — группа пойдёт по K2.</div>
      )}
      {selected.rules && <div className="row">
        <button className="btn tiny" title="Вернуть группе общие настройки" onClick={() => setRules(selected.id, { w: undefined, clear: undefined, viaSize: undefined, viaDrill: undefined, allowTop: undefined })}>Как у всех</button>
      </div>}
      <div className="hint">Добавление в «{selected.name}»: выберите площадки на холсте. Голые крепёжные отверстия без меди не подключаются.</div>
      <div className="net-members">{selected.pads.map((id, i) => {
        const p = ends.get(id);
        return <div key={id}><span title={id}>{i + 1}. {p ? `${p.kind === 'smd' ? 'SMD' : p.tht ? 'PTH' : 'Контакт'} · ${p.layers.join('/').toUpperCase()} · ${p.x.toFixed(2)}; ${p.y.toFixed(2)} мм` : `Удалённая площадка (${id})`}</span><button className="btn tiny" aria-label={`Убрать площадку ${i + 1}`} onClick={() => onChange(nets.map((n) => n.id === active ? { ...n, pads: n.pads.filter((p) => p !== id) } : n))}>×</button></div>;
      })}</div>
    </div>}
    <button className="btn primary net-run" disabled={!nets.length || nets.some((n) => n.pads.length < 2)} onClick={onRoute}>Рассчитать 3 варианта</button>
    {info.msg && <div role="status" className={'route-msg ' + (info.ok === false ? 'bad' : info.ok ? 'ok' : '')}>{info.msg}</div>}
    <details className="hint"><summary>Переходы, перекладка и сохранение проекта</summary>
    <div className="hint">Три стратегии: меньше переходов, короче дорожки и длинные связи первыми. После расчёта сравните сводки и предпросмотр, затем примените один вариант. Совпавшие результаты отмечаются. Трассировка двух точек работает как раньше. Абсолютный минимум не гарантируется.</div>
    <div className="hint">Умный конвейер: сначала прокладываются группы с широкой дорожкой, связь может подключаться ветвью к уже проложенному стволу своей группы, а если путь перекрыт — автотрассировщик снимает собственные дорожки текущего запуска (медь пользователя не трогается), освобождает проход и перекладывает задетые группы. Зазор соблюдается по самому строгому правилу среди групп.</div>
    <div className="hint">Существующая медь сохраняется. Повторный запуск добавляет недостающие связи. Группы вместе с их правилами сохраняются в проекте JSON; в .lay6 — только медь.</div>
    </details>
  </section>;
}
