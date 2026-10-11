import { useEffect, useRef, type KeyboardEvent } from 'react';
import { FIND_KIND_RU, type FindHit } from '../pcb/find';

/**
 * Панель поиска по плате (Ctrl+Shift+F). Список результатов управляется
 * родителем: он переводит вид на найденное и подсвечивает его на холсте.
 * Клавиши внутри поля не уходят редактору (стрелки не сдвигают выделение).
 */
export function FindPanel({ query, onQuery, hits, active, onActive, onPick, onClose, hasQuery, focusKey }: {
  /** меняется при повторном открытии (Ctrl+Shift+F) — вернуть фокус в поле */
  focusKey: number;
  query: string;
  onQuery: (q: string) => void;
  hits: FindHit[];
  active: number;
  onActive: (i: number) => void;
  onPick: (hit: FindHit) => void;
  onClose: () => void;
  hasQuery: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusKey]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hits.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      onActive((active + step + hits.length) % hits.length);
      return;
    }
    if (e.key === 'Enter' && hits[active]) { e.preventDefault(); onPick(hits[active]); }
  };

  const status = !hasQuery ? 'Введите обозначение (R1), цепь (GND) или номинал (10k)'
    : hits.length ? `Найдено: ${hits.length}${hits.length >= 200 ? ' (показаны первые 200)' : ''}`
      : 'Ничего не найдено. Проверьте написание или введите только часть слова.';

  return (
    <div className="find-panel" role="search" aria-label="Поиск на плате">
      <div className="find-row">
        <input
          ref={input}
          className="txt find-input"
          value={query}
          placeholder="Обозначение, цепь, номинал…"
          aria-label="Что найти на плате"
          aria-controls="find-results"
          aria-activedescendant={hits[active] ? 'find-hit-' + active : undefined}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={onKey}
          onKeyUp={(e) => e.stopPropagation()}
        />
        <button type="button" className="btn tiny" onClick={onClose} aria-label="Закрыть поиск" title="Закрыть (Esc)">×</button>
      </div>
      <div className="find-status" role="status">{status}</div>
      {hits.length > 0 && <ul ref={list} id="find-results" role="listbox" className="find-list" aria-label="Результаты поиска">
        {hits.map((h, i) => (
          <li key={h.key} id={'find-hit-' + i} role="option" aria-selected={i === active}
            className={'find-hit' + (i === active ? ' active' : '')}
            onMouseEnter={() => onActive(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(h); }}>
            <span className={'find-kind find-kind-' + h.kind}>{FIND_KIND_RU[h.kind]}</span>
            <span className="find-text">
              <strong>{h.title}</strong>
              <small>{h.detail} · {h.x.toFixed(1).replace('.', ',')}; {h.y.toFixed(1).replace('.', ',')} мм</small>
            </span>
          </li>
        ))}
      </ul>}
      <div className="find-hint">↑ ↓ — выбрать · Enter — перейти и подсветить · Esc — закрыть. Подсветка остаётся, пока панель открыта.</div>
    </div>
  );
}
