// Полный список проверок DRC и настраиваемые производственные профили.
import { useMemo, useState } from 'react';
import type { Doc } from '../pcb/model';
import { DEFAULT_DRC_RULES, DRC_PRESETS, runBoardDrc, type DrcRules, type DrcViolation } from '../pcb/drc';
import { download } from '../pcb/zip';
import { Modal } from './widgets';

const fmt = (n: number): string => Number(n.toFixed(3)).toString().replace('.', ',');
const csv = (items: DrcViolation[]): string => {
  const cell = (v: unknown) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [['Severity', 'Rule', 'Message', 'X (mm)', 'Y (mm)', 'Actual (mm)', 'Required (mm)', 'Layer', 'Entity IDs'],
    ...items.map((v) => [v.severity, v.rule, v.message, v.x, v.y, v.actual ?? '', v.required ?? '', v.layer ?? '', (v.entities ?? []).join(' ')])]
    .map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
};

const RULE_FIELDS: [keyof DrcRules, string, number][] = [
  ['minClearance', 'Минимальный зазор меди, мм', 0.01],
  ['minTrackWidth', 'Минимальная ширина дорожки, мм', 0.01],
  ['minDrill', 'Минимальный диаметр сверла, мм', 0.05],
  ['minAnnularRing', 'Минимальное кольцо меди, мм', 0.01],
  ['minBoardEdge', 'Медь до края платы, мм', 0.01],
  ['minDrillEdge', 'Сверло до края платы, мм', 0.01],
  ['minSilkWidth', 'Минимальная толщина шелкографии, мм', 0.01],
];

export function DrcDialog({ doc, onLocate, onClose }: { doc: Doc; onLocate: (x: number, y: number) => void; onClose: () => void }) {
  const [rules, setRules] = useState<DrcRules>({ ...DEFAULT_DRC_RULES });
  const [profile, setProfile] = useState('factory');
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');
  const [limit, setLimit] = useState(120);
  const result = useMemo(() => runBoardDrc(doc, rules), [doc, rules]);
  const errors = result.filter((v) => v.severity === 'error').length;
  const warnings = result.length - errors;
  const visible = result.filter((v) => filter === 'all' || v.severity === filter);
  const setRule = (key: keyof DrcRules, val: number): void => {
    setProfile('custom'); setRules((old) => ({ ...old, [key]: Math.max(0, Number.isFinite(val) ? val : 0) }));
  };
  const exportReport = (): void => download(`${doc.name.replace(/[^\wа-яА-ЯёЁ-]+/g, '_') || 'board'}_DRC.csv`,
    new Blob(['\ufeff', csv(result)], { type: 'text/csv;charset=utf-8' }));
  return <Modal title="Проверка перед производством · DRC" className="drc-modal" onClose={onClose}
    foot={<><button className="btn" onClick={exportReport}>Скачать отчёт CSV</button><button className="btn primary" onClick={onClose}>Готово</button></>}>
    <p>Проверяются геометрические зазоры, ширины, отверстия, кольца меди, край платы, цепи и контур. Красные ошибки лучше исправить до экспорта; жёлтые предупреждения требуют ручной оценки.</p>
    <div className="drc-summary" role="status"><div className={errors ? 'bad' : 'ok'}><b>{errors}</b><span>ошибок</span></div><div className={warnings ? 'warn' : 'ok'}><b>{warnings}</b><span>предупреждений</span></div><div><b>{result.length}</b><span>всего проверок</span></div></div>
    <div className="drc-rules-head"><label>Профиль
      <select className="txt" value={profile} onChange={(e) => {
        setProfile(e.target.value);
        if (e.target.value !== 'custom') setRules({ ...DRC_PRESETS[e.target.value as keyof typeof DRC_PRESETS].rules });
      }}>
        {Object.entries(DRC_PRESETS).map(([id, preset]) => <option key={id} value={id}>{preset.name}</option>)}
        <option value="custom">Свои правила</option>
      </select>
    </label>
    <label>Показывать
      <select className="txt" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
        <option value="all">Все</option><option value="error">Только ошибки</option><option value="warning">Только предупреждения</option>
      </select>
    </label></div>
    <div className="drc-rule-grid">{RULE_FIELDS.map(([key, label, step]) => <label key={key}>{label}
      <input className="txt" type="number" min="0" step={step} value={rules[key]} onChange={(e) => setRule(key, Number(e.target.value))} />
    </label>)}</div>
    <div className="drc-list" role="list" aria-label="Найденные нарушения">
      {!visible.length && <div className="empty-state">Нарушений по выбранным правилам не найдено.</div>}
      {visible.slice(0, limit).map((item) => <button type="button" key={item.id} className={'drc-item ' + item.severity} role="listitem"
        onClick={() => { onClose(); onLocate(item.x, item.y); }} title="Перейти к проблеме на плате">
        <span className="drc-severity">{item.severity === 'error' ? 'ОШИБКА' : 'ПРОВЕРИТЬ'}</span>
        <span className="drc-copy"><b>{item.rule}</b><span>{item.message}</span><small>X {fmt(item.x)} · Y {fmt(item.y)} мм{item.layer ? ` · ${item.layer}` : ''}</small></span>
        <span aria-hidden="true">↗</span>
      </button>)}
      {visible.length > limit && <button className="btn" onClick={() => setLimit((n) => n + 120)}>Показать ещё {Math.min(120, visible.length - limit)}</button>}
    </div>
    <div className="hint">Проверка намеренно консервативна. Контакт меди в одной точке может быть ожидаемым соединением; без достоверной netlist-метки невозможна полная проверка коротких замыканий. Для панели с breakaway-tabs edge clearance проверяйте на исходной плате до панелизации.</div>
  </Modal>;
}
