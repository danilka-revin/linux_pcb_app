// Панель «Тепловизора»: ток цепи, итоги нагрева и список горячих участков.
import { COPPER_PRESETS, fmtOhm, fmtVolt } from '../pcb/trackcalc';
import { plural } from './panels';
import { thermalColor, type ThermalResult } from '../pcb/thermal';
import { NI, SI } from './widgets';

const fmtT = (v: number): string =>
  (v >= 10 ? v.toFixed(0) : v.toFixed(1)).replace('.', ',');

export function ThermalPanel({
  currentA, copperUm, tempRise, onParams, result, onLocate,
}: {
  currentA: number;
  copperUm: number;
  tempRise: number;
  onParams: (p: { currentA?: number; copperUm?: number; tempRise?: number }) => void;
  result: ThermalResult | null;
  onLocate: (x: number, y: number) => void;
}) {
  const cuOpts: [string, string][] = COPPER_PRESETS.some((c) => c.um === copperUm)
    ? COPPER_PRESETS.map((c): [string, string] => [String(c.um), c.label])
    : [[String(copperUm), `своё: ${copperUm} мкм`], ...COPPER_PRESETS.map((c): [string, string] => [String(c.um), c.label])];
  const hot = result ? [...result.segs].sort((a, b) => b.dT - a.dT) : [];
  const shown = hot.slice(0, 40);
  return (
    <div className="props thermal-panel">
      <h3>Тепловизор цепи</h3>
      <div className="sub">Кликните по дорожке, площадке или переходу — цепь раскрасится по нагреву, пунктир покажет ток.</div>
      <NI label="Ток цепи, А" value={currentA} min={0} step={0.1} on={(v) => onParams({ currentA: v })} />
      <SI label="Толщина меди" value={String(copperUm)} options={cuOpts} on={(v) => onParams({ copperUm: parseFloat(v) })} />
      <NI label="Допустимый нагрев, °C" value={tempRise} min={1} max={100} on={(v) => onParams({ tempRise: v })} />
      {!result && <div className="sub">Цепь не выбрана — кликните по меди на плате.</div>}
      {result && <>
        <div className={'thermal-verdict ' + (result.hotCount ? 'bad' : result.warmCount ? 'warn' : 'ok')}>
          {result.hotCount
            ? `Греется: ${result.hotCount} ${plural(result.hotCount, ['участок', 'участка', 'участков'])} — расширьте дорожку`
            : result.warmCount
              ? `На грани допуска: ${result.warmCount} ${plural(result.warmCount, ['участок', 'участка', 'участков'])}`
              : 'Всё холодное — запас есть'}
        </div>
        <div className="thermal-totals">
          <div><span>R цепи</span><b>{fmtOhm(result.totalR)}</b></div>
          <div><span>Падение</span><b>{fmtVolt(result.totalDrop)} В</b></div>
          <div><span>Мощность</span><b>{fmtVolt(result.totalP)} Вт</b></div>
          <div><span>Макс. нагрев</span><b>+{fmtT(result.maxDT)} °C</b></div>
        </div>
        <div className="sub">
          {result.tracks} дор. · {result.pads} площ. · {result.smd} SMD · {result.vias} перех.
        </div>
        {shown.length > 0 && <div className="thermal-list">
          {shown.map((s) => {
            const mid = s.pts[Math.floor(s.pts.length / 2)];
            return (
              <button key={s.id} className={'thermal-row' + (s.hot === 2 ? ' is-hot' : s.hot === 1 ? ' is-warm' : '')}
                title="Показать участок на плате"
                onClick={() => onLocate(mid.x, mid.y)}>
                <i style={{ background: thermalColor(s.t01) }} />
                <span>{s.w.toFixed(2).replace('.', ',')} мм · {s.len.toFixed(1).replace('.', ',')} мм</span>
                <b>+{fmtT(s.dT)} °C</b>
              </button>
            );
          })}
          {hot.length > shown.length && <div className="sub">…и ещё {hot.length - shown.length}</div>}
        </div>}
        <div className="sub thermal-note">
          Прикидка сверху: каждый участок якобы несёт весь ток. Переходы и теплоотвод в полигоны не учтены.
        </div>
      </>}
    </div>
  );
}
