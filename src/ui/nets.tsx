import { useEffect, useState } from 'react';
import type { Net, NetRules } from '../pcb/model';
import { fmt } from '../pcb/model';
import type { RouteEnd } from '../pcb/autoroute';
import { netMissing } from '../pcb/netroute';
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

export function NetsPanel({ nets, active, setActive, onChange, onNew, onRoute, ends, comp, info, defaults }: {
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
}) {
  const selected = nets.find((n) => n.id === active);
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
            <span>{net.name}<small>{net.pads.length} площадок · {missingPads ? `потеряно: ${missingPads}` : net.pads.length < 2 ? 'добавьте площадки' : missing ? `осталось связей: ${missing}` : 'соединена'}{w !== undefined ? ` · дорожка ${fmt(w)} мм` : ''}</small></span>
          </button>
          <WidthCell name={net.name} value={w} fallback={defaults.w} on={(v) => setRules(net.id, { w: v })} />
          <button className="btn tiny danger" title={`Удалить группу ${net.name} (дорожки останутся)`} aria-label={`Удалить группу ${net.name}`} onClick={() => onChange(nets.filter((n) => n.id !== net.id))}>×</button>
        </div>;
      })}
    </div>
    {selected && <div className="net-rules">
      <div className="field"><label htmlFor="net-name">Имя группы</label><input className="txt" id="net-name" aria-label="Имя группы" value={selected.name} onChange={(e) => onChange(nets.map((n) => n.id === active ? { ...n, name: e.target.value } : n))} /></div>
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
