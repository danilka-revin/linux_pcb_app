// Окно «История правок»: список операций над платой с возможностью отменить
// сразу до нужной операции, а не жать Ctrl+Z по одному шагу.
//
// Список идёт по порядку: строка 0 — состояние, с которого начали (открыли файл
// или создали плату), дальше — операции. Текущее состояние подсвечено, отменённые
// операции показаны серым: их можно вернуть, выбрав строку и нажав «Вернуть».

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { entityDelta, formatTime, stepHint, type HistRow } from '../pcb/history';
import { Modal } from './widgets';

export function HistoryDialog({
  rows, limit, onUndoTo, onRedoTo, onClose,
}: {
  /** состояния: прошлое, текущее и отменённое (см. historyRows) */
  rows: HistRow[];
  /** текущая глубина истории из настроек (сколько шагов хранится) */
  limit: number;
  /** отменить всё до состояния `step` включительно (вернуться к состоянию на нём) */
  onUndoTo: (step: number) => void;
  /** вернуть состояние `step`, которое было отменено */
  onRedoTo: (step: number) => void;
  onClose: () => void;
}) {
  const current = useMemo(() => Math.max(0, rows.findIndex((r) => r.state === 'current')), [rows]);
  const [pickedRaw, setPicked] = useState<number>(current);
  const list = useRef<HTMLDivElement>(null);

  // Окно открыто, а история тем временем меняется (отмена/повтор уже применены) —
  // держим выбор в границах и не даём ему «уехать» за конец списка.
  const last = Math.max(0, rows.length - 1);
  const picked = Math.min(pickedRaw, last);
  const row = rows[picked];

  // Открыли окно — показываем текущее состояние, а не начало списка.
  // scrollIntoView вызывается необязательно: в тестовой среде (jsdom) его нет.
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: 'center' });
  }, []);

  const back = picked < current;
  const forward = picked > current;

  const apply = (): void => {
    if (back) onUndoTo(rows[picked].step);
    else if (forward) onRedoTo(rows[picked].step);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setPicked(Math.min(last, picked + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setPicked(Math.max(0, picked - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setPicked(0); }
    else if (e.key === 'End') { e.preventDefault(); setPicked(last); }
    else if (e.key === 'Enter') { e.preventDefault(); apply(); }
  };

  const actionLabel = back ? `Отменить до операции ${row?.step}`
    : forward ? `Вернуть состояние ${row?.step}` : 'Ничего не выбрано';

  return (
    <Modal
      title="История правок"
      className="history-modal"
      onClose={onClose}
      foot={<>
        <span className="hist-foot-hint">
          {back ? `Будет отменено операций: ${current - picked}`
            : forward ? `Будет возвращено операций: ${picked - current}`
              : 'Выберите строку: «отменить до» или «вернуть»'}
        </span>
        <button
          type="button"
          className="btn primary"
          disabled={!back && !forward}
          onClick={apply}
          title={back ? 'Отменить операции после выбранной' : forward ? 'Вернуть отменённые операции' : ''}
        >
          {actionLabel}
        </button>
        <button type="button" className="btn" onClick={onClose}>Закрыть</button>
      </>}
    >
      <div className="hist-head">
        <span>
          Всего шагов: <b>{last}</b> из {limit}
          {' · '}сейчас состояние <b>{current}</b>
        </span>
        <span className="hist-keys">
          ↑ ↓ — выбрать · Enter — применить · Esc — закрыть
        </span>
      </div>
      <div className="hist-list" ref={list} role="listbox" aria-label="Список операций" tabIndex={0} onKeyDown={onKey}>
        {rows.map((r, i) => {
          const delta = entityDelta(rows, i);
          return (
            <div
              key={r.step + ':' + r.at + ':' + r.label}
              role="option"
              aria-selected={i === picked}
              className={'hist-row' + (r.state === 'current' ? ' current' : '')
                + (r.state === 'future' ? ' undone' : '')
                + (i === picked ? ' picked' : '')}
              title={stepHint(r, current)}
              onClick={() => setPicked(i)}
              onDoubleClick={() => {
                setPicked(i);
                if (i < current) onUndoTo(r.step);
                else if (i > current) onRedoTo(r.step);
              }}
            >
              <span className="hist-n">{r.step}</span>
              <span className="hist-label">
                {r.label}
                {r.state === 'current' && <small> · текущее состояние</small>}
                {r.state === 'future' && <small> · отменено</small>}
              </span>
              <span className="hist-time">{formatTime(r.at)}</span>
              <span className="hist-ent" title="Объектов на плате в этом состоянии">
                {r.entities}{delta && <small> {delta}</small>}
              </span>
            </div>
          );
        })}
      </div>
      <div className="hint hist-hint">
        История живёт в памяти окна: в файл проекта и в облако она не сохраняется.
        Глубину истории («Шагов отмены», 0 — автоматически) задают в «Настройках → Общие».
      </div>
    </Modal>
  );
}
