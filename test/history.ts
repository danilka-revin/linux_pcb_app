// История правок (src/pcb/history.ts): список состояний, лимит глубины и строки
// окна «История правок». Логика чистая — проверяется без React и холста.
import assert from 'node:assert/strict';
import {
  DEFAULT_STEP_LABEL, entityDelta, formatTime, historyRows, makeStep, newHistory,
  pushStep, stepHint, stepLabel, undoDepth, type HistStep,
} from '../src/pcb/history';
import type { Doc, Entity } from '../src/pcb/model';

const docOf = (n: number): Doc => ({
  name: 'Тест', w: 100, h: 80,
  entities: Array.from({ length: n }, (_, i): Entity => ({
    id: 'p' + i, kind: 'pad', x: i, y: 0, shape: 'round', size: 1.5, drill: 0.8,
  })),
});

// --- 1. шаг истории: подпись и время --------------------------------------
{
  const s = makeStep(docOf(1), '  Добавлена площадка  ');
  assert.equal(s.label, 'Добавлена площадка', 'подпись обрезается по краям');
  assert.ok(s.at > 0, 'у шага есть время');
  assert.equal(makeStep(docOf(1)).label, DEFAULT_STEP_LABEL, 'без подписи — общая подпись');
  assert.equal(makeStep(docOf(1), '   ').label, DEFAULT_STEP_LABEL, 'пробелы — та же общая подпись');
  assert.equal(stepLabel(undefined), DEFAULT_STEP_LABEL, 'stepLabel без подписи');
}

// --- 2. лимит глубины ------------------------------------------------------
{
  let steps: HistStep[] = newHistory(docOf(0), 'Плата открыта', 1000);
  assert.equal(steps.length, 1, 'новая история — одно состояние');
  assert.equal(undoDepth(steps), 0, 'отменять нечего');
  for (let i = 1; i <= 10; i++) steps = pushStep(steps, makeStep(docOf(i), `Шаг ${i}`, 1000 + i), 3);
  assert.equal(steps.length, 4, 'лимит 3 отмены + текущее состояние');
  assert.equal(undoDepth(steps), 3, 'доступно три отмены');
  assert.equal(steps[0].label, 'Шаг 7', 'старые состояния вытесняются');
  assert.equal(steps[3].label, 'Шаг 10', 'последний шаг — на месте');
  assert.equal(steps[3].doc.entities.length, 10, 'последний шаг — самая свежая плата');

  // исходный список не меняется: React-состоянию нужен новый массив
  const base = newHistory(docOf(1), 'Плата открыта', 1);
  const grown = pushStep(base, makeStep(docOf(2), 'Шаг', 2), 100);
  assert.equal(base.length, 1, 'исходная история не тронута');
  assert.equal(grown.length, 2, 'новая история длиннее');

  // лимит не может обнулить историю: минимум — текущее состояние и один шаг назад
  const tiny = pushStep(newHistory(docOf(0), 'Старт', 1), makeStep(docOf(1), 'Шаг', 2), 0);
  assert.equal(tiny.length, 2, 'даже при лимите 0 отмена на один шаг остаётся');
}

// --- 3. строки окна: прошлое, текущее и отменённое -------------------------
{
  const steps: HistStep[] = [
    makeStep(docOf(0), 'Плата открыта', 1000),
    makeStep(docOf(2), 'Добавлено объектов: 2', 2000),
    makeStep(docOf(3), 'Добавлена площадка', 3000),
  ];
  const future: HistStep[] = [
    makeStep(docOf(5), 'Вставлено объектов: 2', 5000),   // дальний
    makeStep(docOf(4), 'Добавлена дорожка', 4000),       // ближний к возврату
  ];
  const rows = historyRows(steps, future);
  assert.equal(rows.length, 5, 'три состояния и два отменённых');
  assert.deepEqual(rows.map((r) => r.state), ['past', 'past', 'current', 'future', 'future'],
    'состояния строк');
  assert.deepEqual(rows.map((r) => r.label),
    ['Плата открыта', 'Добавлено объектов: 2', 'Добавлена площадка', 'Добавлена дорожка', 'Вставлено объектов: 2'],
    'подписи строк, отменённое — от ближнего к дальнему');
  assert.deepEqual(rows.map((r) => r.entities), [0, 2, 3, 4, 5], 'число объектов в каждом состоянии');
  assert.deepEqual(rows.map((r) => r.step), [0, 1, 2, 3, 4], 'нумерация строк');
  assert.equal(rows[2].at, 3000, 'время шага сохраняется');

  // без отменённых строк список кончается текущим состоянием
  assert.equal(historyRows(steps, []).length, 3, 'без отменённых — три строки');
}

// --- 4. пояснения, разница и время -----------------------------------------
{
  const steps: HistStep[] = [makeStep(docOf(1), 'Старт', 1), makeStep(docOf(3), 'Шаг', 2)];
  const rows = historyRows(steps, []);
  assert.equal(entityDelta(rows, 0), '', 'у первой строки разницы нет');
  assert.equal(entityDelta(rows, 1), '+2', 'добавились два объекта');

  const three = historyRows([makeStep(docOf(0), 'A'), makeStep(docOf(0), 'B'), makeStep(docOf(0), 'C')], []);
  assert.equal(entityDelta(three, 1), '', 'без изменений — пусто');
  const less = historyRows([makeStep(docOf(0), 'A'), makeStep(docOf(5), 'B'), makeStep(docOf(4), 'C')], []);
  assert.equal(entityDelta(less, 2), '−1', 'минус один объект');

  const r = historyRows([makeStep(docOf(0), 'A', 1), makeStep(docOf(1), 'B', 2), makeStep(docOf(2), 'C', 3)], []);
  assert.match(stepHint(r[2], 2), /^Текущее состояние/, 'текущее состояние так и подписано');
  assert.match(stepHint(r[0], 2), /Отменить 2 операции/, `подсказка про отмену: ${stepHint(r[0], 2)}`);
  assert.match(stepHint(r[1], 2), /Отменить 1 операцию/, `одна операция: ${stepHint(r[1], 2)}`);
  const fut = historyRows([makeStep(docOf(0), 'A'), makeStep(docOf(1), 'B')], [makeStep(docOf(2), 'C')]);
  assert.match(stepHint(fut[2], 1), /^Вернуть 1 операцию/, `подсказка про возврат: ${stepHint(fut[2], 1)}`);

  assert.match(formatTime(new Date(2026, 0, 2, 3, 4, 5).getTime()), /^03:04:05$/, 'время в формате ЧЧ:ММ:СС');
}

console.log('history: шаги, лимит, строки окна и подсказки OK');
