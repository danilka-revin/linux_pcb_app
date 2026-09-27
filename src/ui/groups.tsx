// Вкладка «Группы» в левой колонке: список групп элементов и операции с ними.
import { useEffect, useState } from 'react';
import type { Group } from '../pcb/model';
import { groupCountLabel, groupWord } from '../pcb/group';
import { Ic } from './icons';

/** Имя группы в строке списка: правится на месте, фиксируется по Enter/фокусу. */
function NameCell({ name, on }: { name: string; on: (v: string) => void }) {
  const [s, setS] = useState(name);
  useEffect(() => setS(name), [name]);
  const commit = () => {
    const v = s.trim();
    if (v && v !== name) on(v);
    else setS(name);
  };
  return (
    <input
      className="grp-name"
      value={s}
      aria-label="Название группы"
      title="Название группы — кликните и отредактируйте"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setS(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

export function GroupsPanel({
  groups, selGroup, canGroup, canUngroup,
  onGroup, onSelect, onUngroup, onUngroupAll, onRename,
}: {
  groups: Group[];
  /** группа текущего выделения (если всё выделенное в одной группе) */
  selGroup: Group | null;
  /** выделено минимум два элемента — их можно связать в группу */
  canGroup: boolean;
  /** в выделении есть элементы какой-то группы — её можно распустить */
  canUngroup: boolean;
  onGroup: () => void;
  onSelect: (g: Group) => void;
  onUngroup: (g: Group) => void;
  onUngroupAll: () => void;
  onRename: (id: string, name: string) => void;
}) {
  return (
    <div className="groups-pane">
      <h3>Группы</h3>
      <div className="grp-actions">
        <button
          type="button"
          className={'btn' + (canGroup ? ' primary' : '')}
          disabled={!canGroup}
          title="Связать выделенные элементы в группу (Ctrl+Shift+G)"
          onClick={onGroup}
        >
          <Ic n="group" size={15} /> Сгруппировать выделенное
        </button>
        <button
          type="button"
          className="btn"
          disabled={!canUngroup}
          title="Распустить группу выделенного (Ctrl+Shift+U)"
          onClick={() => { if (selGroup) onUngroup(selGroup); else onUngroupAll(); }}
        >
          <Ic n="ungroup" size={15} /> {selGroup ? 'Разгруппировать' : 'Разгруппировать всё'}
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="hint" style={{ padding: '8px 12px' }}>
          Групп пока нет. Выделите рамкой или с Shift несколько элементов
          (дорожки, площадки, деталь целиком) и нажмите
          <span className="kbd"> Ctrl</span>+<span className="kbd">Shift</span>+<span className="kbd">G</span>.
          Группа выбирается кликом по любому её элементу и двигается целиком.
        </div>
      ) : (
        <>
          <div className="grp-head">{groupWord(groups.length)}</div>
          {groups.map((g) => (
            <div
              key={g.id}
              className={'grp' + (selGroup?.id === g.id ? ' active' : '')}
              role="button"
              tabIndex={0}
              title="Выделить всю группу"
              onClick={() => onSelect(g)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(g); } }}
            >
              <Ic n="group" size={15} />
              <NameCell name={g.name} on={(v) => onRename(g.id, v)} />
              <span className="grp-n" title="Элементов в группе">{groupCountLabel(g.ids.length)}</span>
              <button
                type="button"
                className="eye"
                title="Разгруппировать"
                aria-label={`Разгруппировать ${g.name}`}
                onClick={(e) => { e.stopPropagation(); onUngroup(g); }}
              >
                <Ic n="ungroup" size={15} />
              </button>
            </div>
          ))}
          <div className="hint" style={{ padding: '8px 12px' }}>
            Клик по группе — выделить целиком. Клик по любому элементу группы на плате
            выбирает всю группу; <span className="kbd">Ctrl</span>+<span className="kbd">Shift</span>+<span className="kbd">U</span> —
            распустить.
          </div>
        </>
      )}
    </div>
  );
}
