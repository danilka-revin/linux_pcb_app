// Конфигурация интерфейса: какие кнопки и панели показывать и в каком порядке.
// Общий модуль для редактора (src/App.tsx) и окна настроек (src/ui/settings.tsx) —
// обе точки меняют одну и ту же сохранённую конфигурацию.
/**
 * Вкладки левой колонки: «Слои», «Объекты» (дерево всего на плате с поиском,
 * скрытием и блокировкой), «Детали» (генератор + библиотека) и «Группы».
 */
export type LeftTabId = 'layers' | 'objects' | 'lib' | 'groups';

/** Вкладки левой колонки с подписями. */
export const LEFT_TABS: { id: LeftTabId; label: string }[] = [
  { id: 'layers', label: 'Слои' },
  { id: 'objects', label: 'Объекты' },
  { id: 'lib', label: 'Детали' },
  { id: 'groups', label: 'Группы' },
];

export const LEFT_TAB_NAMES: Record<string, string> =
  Object.fromEntries(LEFT_TABS.map((t) => [t.id, t.label]));

/** Настройки боковых колонок. */
export interface SidesConf {
  /** ширина левой колонки, px */
  leftW: number;
  /** ширина правой колонки, px */
  rightW: number;
  /** какие вкладки есть в левой колонке (порядок = порядок вкладок) */
  leftTabs: LeftTabId[];
  /** показывать ли правую колонку («Свойства») */
  showRight: boolean;
}

export const DEFAULT_SIDES: SidesConf = {
  leftW: 250, rightW: 274, leftTabs: ['layers', 'objects', 'lib', 'groups'], showRight: true,
};

export const clampW = (w: number): number => Math.max(160, Math.min(650, Math.round(w) || 250));

/**
 * Версия сохранённой конфигурации: 2 — появилась вкладка «Объекты».
 * Нужна, чтобы вкладка добавилась тем, у кого конфигурация сохранена старой
 * версией, но при этом не возвращалась тем, кто её уже скрыл сам.
 */
export const UI_REV = 2;

export const normalizeSides = (s?: Partial<SidesConf>, rev = UI_REV): SidesConf => {
  const known = (s?.leftTabs ?? DEFAULT_SIDES.leftTabs).filter((t) => LEFT_TABS.some((x) => x.id === t));
  // Конфигурация из версии до появления «Объектов»: дописываем вкладку один раз.
  // С rev 2 набор вкладок — ровно такой, каким его оставил пользователь
  // (вернуть скрытую вкладку можно в «Конструкторе интерфейса»).
  const add = rev < UI_REV ? DEFAULT_SIDES.leftTabs.filter((t) => !known.includes(t)) : [];
  return {
    leftW: clampW(s?.leftW ?? DEFAULT_SIDES.leftW),
    rightW: clampW(s?.rightW ?? DEFAULT_SIDES.rightW),
    leftTabs: [...known, ...add],
    showRight: s?.showRight ?? DEFAULT_SIDES.showRight,
  };
};

/** Сохранённая конфигурация интерфейса. */
export interface UiState {
  /** порядок групп тулбара */
  ids: string[];
  /** скрытые группы тулбара */
  hidden: string[];
  /** боковые панели */
  sides?: SidesConf;
  /** версия конфигурации (см. UI_REV) */
  rev?: number;
}

export const UI_KEY = 'lauaut.ui';

export const DEFAULT_UI: UiState = { ids: [], hidden: [], sides: normalizeSides(), rev: UI_REV };

/**
 * Читает конфигурацию интерфейса из localStorage.
 * @param knownIds  известные группы кнопок: чужие id из старых версий отбрасываются
 * @param pinned    группы, которые нельзя скрыть (в них вход в настройки)
 */
export function loadUi(knownIds: string[], pinned: string[] = []): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.ids) && Array.isArray(d.hidden)) {
        return {
          ids: d.ids.filter((id: string) => knownIds.includes(id)),
          hidden: d.hidden
            .filter((id: string) => knownIds.includes(id))
            .filter((id: string) => !pinned.includes(id)),
          // старые сохранения (без rev) — это rev 1: вкладку «Объекты» допишем
          sides: normalizeSides(d.sides, Number(d.rev) || 1),
          rev: UI_REV,
        };
      }
    }
  } catch { /* приватный режим / битые данные */ }
  return { ...DEFAULT_UI, sides: normalizeSides() };
}

export const saveUi = (c: UiState): void => {
  try { localStorage.setItem(UI_KEY, JSON.stringify(c)); } catch { /* ignore */ }
};
