// Горячие клавиши: описание действий, разбор сочетаний и их настройка.
//
// Редактор больше не хранит клавиши в своём switch: он спрашивает у этого
// модуля, какое действие стоит за нажатым сочетанием. Пользователь меняет
// привязку в окне настроек (раздел «Горячие клавиши»), и она тут же
// начинает работать — перезапуск не нужен.
//
// Сочетание — строка вида «Ctrl+Shift+Z»:
//   • модификаторы всегда в порядке Ctrl, Alt, Shift («Ctrl» = Ctrl или ⌘);
//   • дальше — имя клавиши: буква, цифра, знак (= - , . / ; ' [ ] \) или слово
//     (Esc, Del, Backspace, Enter, Tab, Space, Up, Down, Left, Right, F1…F12,
//     NumPlus, NumMinus);
//   • у одного действия может быть несколько сочетаний, у сочетания — только
//     одно действие (новое назначение снимает его с предыдущего действия).

export type HotkeyMap = Record<string, string[]>;

export interface HotkeyDef {
  id: string;
  title: string;
  group: string;
  /** сочетания по умолчанию; пусто — клавиши нет, её можно назначить */
  def: string[];
  hint?: string;
}

/** Порядок групп в окне настроек. */
export const HOTKEY_GROUP_ORDER = ['Файл', 'Правка', 'Инструменты', 'Вид', 'Окна и программа'];

export const HOTKEYS: HotkeyDef[] = [
  // ---------------- Файл ----------------
  { id: 'file.new', group: 'Файл', title: 'Новая плата…', def: [] },
  { id: 'file.open', group: 'Файл', title: 'Открыть файл…', def: ['Ctrl+O'] },
  { id: 'file.save', group: 'Файл', title: 'Сохранить (в облаке — на сервер)', def: ['Ctrl+S'] },
  { id: 'file.export', group: 'Файл', title: 'Экспорт Gerber / PNG / ЧПУ…', def: ['Ctrl+E'] },
  { id: 'file.panelize', group: 'Файл', title: 'Размножить плату (панелизация)…', def: [] },
  { id: 'file.autoplace', group: 'Файл', title: 'Автокомпоновка компонентов…', def: [] },
  { id: 'file.cnc', group: 'Файл', title: 'G-code для станка (ЧПУ)…', def: [] },
  { id: 'file.inventory', group: 'Файл', title: 'Перечень площадок и отверстий…', def: [] },
  { id: 'file.stats', group: 'Файл', title: 'Статистика платы…', def: [] },
  { id: 'file.imgimport', group: 'Файл', title: 'Изображение → шелкография…', def: [] },

  // ---------------- Правка ----------------
  { id: 'edit.undo', group: 'Правка', title: 'Отменить', def: ['Ctrl+Z'] },
  { id: 'edit.redo', group: 'Правка', title: 'Повторить', def: ['Ctrl+Y', 'Ctrl+Shift+Z'] },
  { id: 'edit.selectAll', group: 'Правка', title: 'Выделить всё', def: ['Ctrl+A'] },
  { id: 'edit.copy', group: 'Правка', title: 'Копировать', def: ['Ctrl+C'] },
  { id: 'edit.paste', group: 'Правка', title: 'Вставить', def: ['Ctrl+V'] },
  { id: 'edit.duplicate', group: 'Правка', title: 'Дублировать', def: ['Ctrl+D'] },
  { id: 'edit.delete', group: 'Правка', title: 'Удалить выделенное (или узел дорожки)', def: ['Del', 'Backspace'] },
  { id: 'edit.rotate', group: 'Правка', title: 'Повернуть (или деталь при установке)', def: ['R'] },
  { id: 'edit.mirror', group: 'Правка', title: 'На другую сторону платы', def: ['M'] },
  { id: 'edit.side', group: 'Правка', title: 'Сторона детали при установке', def: ['Q'] },
  { id: 'edit.group', group: 'Правка', title: 'Сгруппировать выделенное', def: ['Ctrl+Shift+G'] },
  { id: 'edit.ungroup', group: 'Правка', title: 'Разгруппировать', def: ['Ctrl+Shift+U'] },
  { id: 'edit.nudgeLeft', group: 'Правка', title: 'Сдвинуть влево (Shift — ×10, Alt — ÷10)', def: ['Left'] },
  { id: 'edit.nudgeRight', group: 'Правка', title: 'Сдвинуть вправо (Shift — ×10, Alt — ÷10)', def: ['Right'] },
  { id: 'edit.nudgeUp', group: 'Правка', title: 'Сдвинуть вверх (Shift — ×10, Alt — ÷10)', def: ['Up'] },
  { id: 'edit.nudgeDown', group: 'Правка', title: 'Сдвинуть вниз (Shift — ×10, Alt — ÷10)', def: ['Down'] },

  // ---------------- Инструменты ----------------
  { id: 'tool.select', group: 'Инструменты', title: 'Выбор', def: ['1'] },
  { id: 'tool.track', group: 'Инструменты', title: 'Дорожка', def: ['2'] },
  { id: 'tool.pad', group: 'Инструменты', title: 'Площадка', def: ['3'] },
  { id: 'tool.via', group: 'Инструменты', title: 'Переход', def: ['4'] },
  { id: 'tool.hole', group: 'Инструменты', title: 'Отверстие', def: ['5'] },
  { id: 'tool.line', group: 'Инструменты', title: 'Линия', def: ['6'] },
  { id: 'tool.text', group: 'Инструменты', title: 'Текст', def: ['7'] },
  { id: 'tool.ruler', group: 'Инструменты', title: 'Линейка', def: ['8'] },
  { id: 'tool.dim', group: 'Инструменты', title: 'Размер (размерная линия)', def: ['U'] },
  { id: 'tool.route', group: 'Инструменты', title: 'Автотрассировка', def: ['9'] },
  { id: 'tool.probe', group: 'Инструменты', title: 'Тест цепи', def: ['0'] },
  { id: 'tool.cut', group: 'Инструменты', title: 'Разрыв дорожки', def: ['X'] },
  { id: 'tool.solder', group: 'Инструменты', title: 'Пайка', def: ['S'] },
  { id: 'tool.smd', group: 'Инструменты', title: 'SMD-площадка', def: [] },
  { id: 'tool.rect', group: 'Инструменты', title: 'Прямоугольник', def: [] },
  { id: 'tool.circle', group: 'Инструменты', title: 'Окружность', def: [] },
  { id: 'tool.fill', group: 'Инструменты', title: 'Полигон (земля)', def: [] },
  { id: 'tool.comp', group: 'Инструменты', title: 'Установка компонента', def: [] },

  // ---------------- Вид ----------------
  { id: 'view.fit', group: 'Вид', title: 'Показать всю плату', def: ['F'] },
  { id: 'view.zoomIn', group: 'Вид', title: 'Приблизить', def: ['=', 'NumPlus'] },
  { id: 'view.zoomOut', group: 'Вид', title: 'Отдалить', def: ['-', 'NumMinus'] },
  { id: 'view.mirrorView', group: 'Вид', title: 'Вид сверху / снизу', def: [] },
  { id: 'view.layer', group: 'Вид', title: 'Сменить слой меди (K1/K2)', def: ['L'] },
  { id: 'view.gridNext', group: 'Вид', title: 'Сетка: следующий шаг', def: ['G'] },
  { id: 'view.gridPrev', group: 'Вид', title: 'Сетка: предыдущий шаг', def: ['H'] },
  { id: 'view.snapToggle', group: 'Вид', title: 'Привязка к сетке вкл./выкл.', def: ['Shift+G'] },
  { id: 'view.drc', group: 'Вид', title: 'Подсветка нарушений зазоров вкл./выкл.', def: [] },

  // ---------------- Окна и программа ----------------
  { id: 'gen.focus', group: 'Окна и программа', title: 'Строка генератора деталей', def: ['I'] },
  { id: 'app.preview', group: 'Окна и программа', title: 'Предпросмотр платы (последний режим)', def: [] },
  { id: 'app.preview2d', group: 'Окна и программа', title: 'Предпросмотр 2D', def: [] },
  { id: 'app.preview3d', group: 'Окна и программа', title: 'Предпросмотр 3D', def: [] },
  { id: 'app.theme', group: 'Окна и программа', title: 'Сменить тему (тёмная/светлая)', def: [] },
  { id: 'app.colors', group: 'Окна и программа', title: 'Цвета интерфейса…', def: [] },
  { id: 'app.uib', group: 'Окна и программа', title: 'Конструктор интерфейса…', def: [] },
  { id: 'app.about', group: 'Окна и программа', title: 'О программе', def: [] },
  { id: 'app.tour', group: 'Окна и программа', title: 'Обучение — Настройки → Обучение', def: [] },
  { id: 'app.settings', group: 'Окна и программа', title: 'Настройки (это окно)', def: ['Ctrl+,'] },
  { id: 'app.cancel', group: 'Окна и программа', title: 'Отменить действие / снять выбор', def: ['Esc'] },
];

export const DEFAULT_HOTKEYS: HotkeyMap = Object.fromEntries(HOTKEYS.map((h) => [h.id, [...h.def]]));

/** id действия → его описание (для подписей в окне настроек). */
export const HOTKEY_BY_ID: Record<string, HotkeyDef> = Object.fromEntries(HOTKEYS.map((h) => [h.id, h]));

const MODS = ['Ctrl', 'Alt', 'Shift'];
const PUNCT = ['=', '-', ',', '.', '/', ';', "'", '[', ']', '\\', '`'];

/** Имя клавиши из события: по физическому коду, чтобы не зависеть от раскладки. */
const KEY_NAMES: Record<string, string> = {
  Escape: 'Esc', Delete: 'Del', Backspace: 'Backspace', Enter: 'Enter', Tab: 'Tab', Space: 'Space',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert',
  NumpadAdd: 'NumPlus', NumpadSubtract: 'NumMinus', NumpadMultiply: 'NumMult', NumpadDivide: 'NumDiv',
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
};

/** Проверка строки сочетания (отвергает мусор из настроек и старых версий). */
export function isCombo(s: string): boolean {
  if (typeof s !== 'string' || !s) return false;
  const parts = s.split('+');
  const key = parts.pop();
  if (!key) return false;
  if (parts.some((m) => !MODS.includes(m))) return false;
  if (new Set(parts).size !== parts.length) return false;
  if (!/^[A-Za-z0-9]{1,12}$/.test(key) && !PUNCT.includes(key)) return false;
  return true;
}

/** Сочетание из события клавиатуры: «Ctrl+Shift+Z». */
export function comboOf(e: {
  code?: string; key?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean;
}): string {
  const code = e.code ?? '';
  let key = code;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (KEY_NAMES[code]) key = KEY_NAMES[code];
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  if (!key || key === '+' || key.length > 12) return '';
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

/** Красивая подпись сочетания для интерфейса. */
export function comboLabel(combo: string): string {
  return combo
    .replace(/^Ctrl\+/, 'Ctrl+')
    .replace('NumPlus', 'Num +')
    .replace('NumMinus', 'Num −')
    .replace('NumMult', 'Num *')
    .replace('NumDiv', 'Num /');
}

/** Сочетания, которые браузер или ОС обычно забирают себе. */
const RESERVED = new Set([
  'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Q', 'Ctrl+Shift+W',
  'Ctrl+P', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+F', 'F5', 'Ctrl+Shift+I', 'Ctrl+Shift+J',
  'Ctrl+Shift+C', 'Ctrl+Shift+Delete', 'Ctrl+Tab', 'F11', 'F12',
]);

export const isReservedCombo = (combo: string): boolean => RESERVED.has(combo);

/** «сочетание → действие»: ищется один раз на изменение настроек. */
export function reverseHotkeys(map: HotkeyMap): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (isCombo(c) && !out.has(c)) out.set(c, id);
    }
  }
  return out;
}

const dedupe = (list: string[]): string[] => [...new Set(list.filter(isCombo))];

/**
 * Слить сохранённые привязки с defaults: неизвестные действия и мусор
 * отбрасываются, новые действия (из свежей версии) получают свои клавиши.
 * Пустой список — «клавиши нет», это нормальное состояние, а не пропуск.
 */
export function normalizeHotkeys(raw: unknown): HotkeyMap {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: HotkeyMap = {};
  for (const d of HOTKEYS) {
    const v = src[d.id];
    out[d.id] = Array.isArray(v) ? dedupe(v.filter((x): x is string => typeof x === 'string')) : [...d.def];
  }
  return out;
}

/** Копия карты со снятым с чужих действий сочетанием. */
function strip(map: HotkeyMap, combo: string, except: string): HotkeyMap {
  const out: HotkeyMap = {};
  for (const [key, list] of Object.entries(map)) {
    const cur = Array.isArray(list) ? list : [];
    out[key] = key === except ? [...cur] : cur.filter((c) => c !== combo);
  }
  return out;
}

/** Очистить все привязки действия. */
export function clearHotkey(map: HotkeyMap, id: string): HotkeyMap {
  const out: HotkeyMap = {};
  for (const [key, list] of Object.entries(map)) out[key] = Array.isArray(list) ? [...list] : [];
  out[id] = [];
  return out;
}

/**
 * Назначить действие на сочетание, заменив его прежние клавиши.
 * Сочетание снимается с любого другого действия (у двух действий оно не живёт).
 */
export function assignHotkey(map: HotkeyMap, id: string, combo: string): HotkeyMap {
  const out = strip(map, combo, id);
  out[id] = [combo];
  return out;
}

/** Добавить действию ещё одно сочетание (прежние остаются). */
export function addHotkey(map: HotkeyMap, id: string, combo: string): HotkeyMap {
  const out = strip(map, combo, id);
  const cur = Array.isArray(out[id]) ? out[id] : [];
  out[id] = cur.includes(combo) ? cur : [...cur, combo];
  return out;
}

/** Снять одно сочетание у действия (остальные остаются). */
export function removeHotkey(map: HotkeyMap, id: string, combo: string): HotkeyMap {
  const out: HotkeyMap = {};
  for (const [key, list] of Object.entries(map)) out[key] = Array.isArray(list) ? [...list] : [];
  if (out[id]) out[id] = out[id].filter((c) => c !== combo);
  return out;
}

/** Какие действия потеряли клавишу из-за нового назначения (для подсказки). */
export function hotkeyOwners(map: HotkeyMap, combo: string): string[] {
  return Object.entries(map)
    .filter(([, list]) => Array.isArray(list) && list.includes(combo))
    .map(([id]) => id);
}
