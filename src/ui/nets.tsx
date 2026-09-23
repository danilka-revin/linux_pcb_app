import type { Net } from '../pcb/model';
import type { RouteEnd } from '../pcb/autoroute';
import { netMissing } from '../pcb/netroute';

export const NET_COLORS = ['#64ceff', '#ffa86b', '#d99dff', '#f4db67', '#80e5b1', '#ff8fad'];

export function NetsPanel({ nets, active, setActive, onChange, onNew, onRoute, ends, comp, info }: {
  info: { msg: string; ok: boolean | null };
  nets: Net[];
  active: string | null;
  setActive: (id: string | null) => void;
  onChange: (nets: Net[]) => void;
  onNew: () => void;
  onRoute: () => void;
  ends: Map<string, RouteEnd>;
  comp: Map<string, string>;
}) {
  const selected = nets.find((n) => n.id === active);
  return <section className="props nets-panel">
    <h3>Группы соединений</h3>
    <div className="hint">Одна группа — одна электрическая цепь. Выберите группу и кликайте по её площадкам на плате. Повторный клик убирает площадку.</div>
    <div className="row">
      <button className="btn" onClick={onNew}>+ Новая группа</button>
      <button className="btn" disabled={!selected} onClick={() => setActive(null)}>Готово</button>
    </div>
    <div className="net-list">
      {nets.map((net, i) => {
        const missingPads = net.pads.filter((id) => !ends.has(id)).length;
        const missing = netMissing(net, comp);
        return <div className={'net-row' + (active === net.id ? ' active' : '')} key={net.id}>
          <button className="net-pick" onClick={() => setActive(net.id)} aria-pressed={active === net.id}>
            <span style={{ color: NET_COLORS[i % NET_COLORS.length] }}>●</span>
            <span>{net.name}<small>{net.pads.length} площадок · {missingPads ? `потеряно: ${missingPads}` : net.pads.length < 2 ? 'добавьте площадки' : missing ? `осталось связей: ${missing}` : 'соединена'}</small></span>
          </button>
          <button className="btn tiny danger" title={`Удалить группу ${net.name} (дорожки останутся)`} aria-label={`Удалить группу ${net.name}`} onClick={() => onChange(nets.filter((n) => n.id !== net.id))}>×</button>
        </div>;
      })}
    </div>
    {selected && <>
      <div className="field"><label htmlFor="net-name">Имя группы</label><input className="txt" id="net-name" aria-label="Имя группы" value={selected.name} onChange={(e) => onChange(nets.map((n) => n.id === active ? { ...n, name: e.target.value } : n))} /></div>
      <div className="hint">Добавление в «{selected.name}»: выберите площадки на холсте. Голые крепёжные отверстия без меди не подключаются.</div>
      <div className="net-members">{selected.pads.map((id, i) => {
        const p = ends.get(id);
        return <div key={id}><span title={id}>{i + 1}. {p ? `${p.x.toFixed(2)}; ${p.y.toFixed(2)} мм` : `Удалённая площадка (${id})`}</span><button className="btn tiny" aria-label={`Убрать площадку ${i + 1}`} onClick={() => onChange(nets.map((n) => n.id === active ? { ...n, pads: n.pads.filter((p) => p !== id) } : n))}>×</button></div>;
      })}</div>
    </>}
    <button className="btn primary net-run" disabled={!nets.length || nets.some((n) => n.pads.length < 2)} onClick={onRoute}>Развести всю плату</button>
    {info.msg && <div role="status" className={'route-msg ' + (info.ok === false ? 'bad' : info.ok ? 'ok' : '')}>{info.msg}</div>}
    <details className="hint"><summary>Переходы и сохранение проекта</summary>
    <div className="hint">Сначала низ K2, затем обходы через верх. Сравниваются до 3 порядков разводки: больше готовых связей, меньше переходов, короче дорожки. Абсолютный минимум не гарантируется.</div>
    <div className="hint">Существующая медь сохраняется. Повторный запуск добавляет недостающие связи. Группы сохраняются в проекте JSON; в .lay6 — только медь.</div>
    </details>
  </section>;
}
