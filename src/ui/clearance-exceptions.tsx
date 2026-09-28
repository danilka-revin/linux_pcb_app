import type { TrackClearanceViolation } from '../pcb/track-clearance';
import { activeClearance } from '../pcb/track-clearance';
import { fmt } from '../pcb/model';

export function ClearanceExceptions({ violations, ignored, onChange, onLocate }: {
  violations: TrackClearanceViolation[];
  ignored: string[];
  onChange: (keys: string[]) => void;
  onLocate: (violation: TrackClearanceViolation) => void;
}) {
  const unique = [...new Map(violations.map(v => [v.key, v])).values()];
  const active = activeClearance(unique, ignored);
  const excluded = unique.filter(v => ignored.includes(v.key));
  const row = (v: TrackClearanceViolation, restore: boolean) => <li key={v.key}>
    <button className="clearance-location" title="Показать на плате" onClick={() => onLocate(v)}>
      <b>{v.layer.toUpperCase()} · {v.gap < 0 ? 'Пересечение' : `${fmt(v.gap)} мм`}</b>
      <span>X {fmt((v.a.x + v.b.x) / 2)} · Y {fmt((v.a.y + v.b.y) / 2)}</span>
    </button>
    <button className="btn" title={restore ? 'Вернуть предупреждение' : 'Считать это сближение допустимым'}
      onClick={() => onChange(restore ? ignored.filter(key => key !== v.key) : [...new Set([...ignored, v.key])])}>
      {restore ? 'Вернуть' : 'Игнорировать'}
    </button>
  </li>;
  return <div className="clearance-exceptions">
    <details open={active.length > 0}>
      <summary>Сближения · {active.length}</summary>
      <ul className="clearance-list">{active.map(v => row(v, false))}</ul>
    </details>
    {ignored.length > 0 && <details>
      <summary>Исключения · {ignored.length}</summary>
      <ul className="clearance-list">{excluded.map(v => row(v, true))}</ul>
      <button className="btn" onClick={() => onChange([])}>Вернуть все предупреждения</button>
    </details>}
  </div>;
}
