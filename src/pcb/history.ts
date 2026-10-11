// История отмены: состояния документа списком, как в панели «История» графических
// редакторов. Отмена — это переход к состоянию на N операций назад, повтор — вперёд.
//
// Модель отличается от простой пары стеков «past/future» тем, что последний
// элемент списка — всегда текущее состояние платы. Поэтому в окне истории можно
// показать нумерованный список операций и «отменить до операции N» одним щелчком,
// а не жать Ctrl+Z десяток раз.
//
// Шаг хранит подпись: что именно произошло («Добавлена дорожка», «Перемещение
// 3 элементов») — по ней пользователь узнаёт операцию в списке.

import type { Doc } from './model';

export interface HistStep {
  /** состояние платы после операции */
  doc: Doc;
  /** что сделали, чтобы прийти в это состояние */
  label: string;
  /** момент времени, мс (Date.now) */
  at: number;
}

/** Строка списка истории для окна. */
export interface HistRow {
  /** номер состояния: 0 — исходное, N — после N операций */
  step: number;
  /** подпись операции, которая привела в это состояние */
  label: string;
  at: number;
  /** сколько примитивов верхнего уровня в этом состоянии */
  entities: number;
  /** past — уже отменено до сюда можно вернуться, current — сейчас, future — впереди */
  state: 'past' | 'current' | 'future';
}

/** Подпись шага по умолчанию: правки без собственного имени. */
export const DEFAULT_STEP_LABEL = 'Правка платы';

export const stepLabel = (label?: string): string => (label && label.trim() ? label.trim() : DEFAULT_STEP_LABEL);

/** Новый шаг истории. */
export function makeStep(doc: Doc, label?: string, at = Date.now()): HistStep {
  return { doc, label: stepLabel(label), at };
}

/**
 * Добавить состояние в историю, соблюдая лимит глубины.
 * Лимит — это число доступных отмен, а список хранит ещё и текущее состояние
 * (лимит + 1 позиция). Возвращает новый массив: мутация была бы незаметна
 * React-состоянию.
 */
export function pushStep(steps: HistStep[], step: HistStep, limit: number): HistStep[] {
  const out = [...steps, step];
  const max = Math.max(2, limit + 1);
  if (out.length > max) out.splice(0, out.length - max);
  return out;
}

/**
 * Новая история из одного состояния — открытие файла, новая плата, загрузка
 * проекта из облака.
 */
export function newHistory(doc: Doc, label = 'Открыта плата', at = Date.now()): HistStep[] {
  return [makeStep(doc, label, at)];
}

/** Номер операции у текущего состояния: он же — сколько отмен доступно. */
export const undoDepth = (steps: HistStep[]): number => Math.max(0, steps.length - 1);

/**
 * Список строк истории для окна: прошлое, текущее состояние и отменённое
 * (то, что можно вернуть повтором).
 */
export function historyRows(steps: HistStep[], future: HistStep[]): HistRow[] {
  const rows: HistRow[] = steps.map((s, i) => ({
    step: i,
    label: s.label,
    at: s.at,
    entities: s.doc.entities.length,
    state: i === steps.length - 1 ? 'current' : 'past',
  }));
  // future хранится «сверху вниз»: последний отменённый — первым к возврату
  for (let i = future.length - 1; i >= 0; i--) {
    const s = future[i];
    rows.push({
      step: rows.length,
      label: s.label,
      at: s.at,
      entities: s.doc.entities.length,
      state: 'future',
    });
  }
  return rows;
}

/** Разница в числе элементов с предыдущим состоянием: «+2», «−1» или пусто. */
export function entityDelta(rows: HistRow[], i: number): string {
  if (i <= 0) return '';
  const d = rows[i].entities - rows[i - 1].entities;
  if (!d) return '';
  return d > 0 ? `+${d}` : `−${-d}`;
}

/** Время шага «ЧЧ:ММ:СС» — в списке видно, что делали только что. */
export function formatTime(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Короткое пояснение к строке истории — что произойдёт по щелчку. */
export function stepHint(row: HistRow, current: number): string {
  if (row.state === 'current') return 'Текущее состояние платы';
  if (row.step < current) {
    const n = current - row.step;
    return `Отменить ${n} ${ops(n)} и вернуться к состоянию после операции ${row.step}`;
  }
  const n = row.step - current;
  return `Вернуть ${n} ${ops(n)} вперёд до состояния после операции ${row.step}`;
}

const ops = (n: number): string => (n % 10 === 1 && n % 100 !== 11 ? 'операцию'
  : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'операции' : 'операций');
