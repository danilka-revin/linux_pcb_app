// Пресеты настроек: готовые темы оформления, технологии изготовления платы,
// режимы сетки, вид интерфейса, печать и размер новой платы. Плюс свои
// пресеты пользователя — сохранённые темы и полные профили настроек.
//
// Встроенные пресеты — просто «заплатки» (Partial<…>) поверх текущих значений:
// применить пресет = setDefs/setPrefs/setColors с этой заплаткой. Свои пресеты
// хранятся в localStorage под ключом psbees.presets и не трогаются сбросом
// настроек (их можно удалить вручную или перенести файлом настроек).
import type { ThemeId } from '../pcb/render';
import { isHex, type CustomColors } from './palette';
import type { Defs } from './panels';
import type { Prefs } from './prefs';
import type { SidesConf } from './uiconf';

export const PRESETS_KEY = 'psbees.presets';

// ------------------------------------------------------------------ темы

export interface ThemePreset {
  id: string;
  name: string;
  hint?: string;
  /** базовая тема: от неё берутся цвета слоёв, тени, состояния */
  theme: ThemeId;
  /** перекрытия цветов (пусто — чистая тема) */
  colors: CustomColors;
  /** сохранён пользователем (можно удалить) */
  user?: boolean;
}

/** Готовые темы оформления. Первые две — фирменные «пчелиные» без перекрытий. */
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'bee-dark', name: 'Пчела', hint: 'Фирменная тёмная: золото на графите', theme: 'dark', colors: {} },
  { id: 'bee-light', name: 'Пчела светлая', hint: 'Фирменная светлая — для печати и светлых помещений', theme: 'light', colors: {} },
  {
    id: 'midnight', name: 'Полночь', hint: 'Глубокий синий с голубым акцентом', theme: 'dark',
    colors: { accent: '#3fa9ff', page: '#0b1020', surface: '#111831', text: '#e6ecff' },
  },
  {
    id: 'nord', name: 'Nord', hint: 'Спокойная холодная палитра', theme: 'dark',
    colors: { accent: '#88c0d0', page: '#2e3440', surface: '#3b4252', text: '#eceff4' },
  },
  {
    id: 'dracula', name: 'Dracula', hint: 'Фиолетовый акцент на тёмно-сером', theme: 'dark',
    colors: { accent: '#bd93f9', page: '#1e1f29', surface: '#282a36', text: '#f8f8f2' },
  },
  {
    id: 'monokai', name: 'Monokai', hint: 'Классика редакторов кода', theme: 'dark',
    colors: { accent: '#a6e22e', page: '#1e1f1c', surface: '#272822', text: '#f8f8f2' },
  },
  {
    id: 'solar-dark', name: 'Solarized тёмная', hint: 'Мягкий контраст, меньше устают глаза', theme: 'dark',
    colors: { accent: '#b58900', page: '#002b36', surface: '#073642', text: '#eee8d5' },
  },
  {
    id: 'textolite', name: 'Текстолит', hint: 'Зелёная маска и золото — как настоящая плата', theme: 'dark',
    colors: { accent: '#e8c93e', page: '#06200f', surface: '#0b2e18', text: '#e6f2e8' },
  },
  {
    id: 'graphite', name: 'Графит', hint: 'Нейтральный серый с оранжевым акцентом', theme: 'dark',
    colors: { accent: '#ff8a3d', page: '#121212', surface: '#1c1c1c', text: '#ececec' },
  },
  {
    id: 'contrast', name: 'Высокий контраст', hint: 'Чёрный фон, белый текст, жёлтый акцент', theme: 'dark',
    colors: { accent: '#ffd400', page: '#000000', surface: '#0a0a0a', text: '#ffffff' },
  },
  {
    id: 'solar-light', name: 'Solarized светлая', hint: 'Тёплый светлый фон, синий акцент', theme: 'light',
    colors: { accent: '#268bd2', page: '#eee8d5', surface: '#fdf6e3', text: '#073642' },
  },
  {
    id: 'paper', name: 'Бумага', hint: 'Сепия: как чертёж на бумаге', theme: 'light',
    colors: { accent: '#b5651d', page: '#efe6d6', surface: '#fbf6ec', text: '#3b2f22' },
  },
  {
    id: 'sky', name: 'Небо', hint: 'Светлая с синим акцентом', theme: 'light',
    colors: { accent: '#1f6feb', page: '#eaf1fb', surface: '#ffffff', text: '#14243a' },
  },
  {
    id: 'mint', name: 'Мята', hint: 'Светлая с зелёным акцентом', theme: 'light',
    colors: { accent: '#12a37a', page: '#e8f4ef', surface: '#ffffff', text: '#17302a' },
  },
];

const COLOR_KEYS = ['accent', 'page', 'surface', 'text'] as const;

/** Только валидные hex-цвета, в нижнем регистре. */
export function cleanColors(c: unknown): CustomColors {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const out: CustomColors = {};
  for (const k of COLOR_KEYS) if (isHex(o[k])) out[k] = (o[k] as string).toLowerCase();
  return out;
}

/** Совпадает ли текущее оформление с пресетом темы. */
export function isThemeActive(p: ThemePreset, theme: ThemeId, colors: CustomColors): boolean {
  if (p.theme !== theme) return false;
  const a = cleanColors(p.colors), b = cleanColors(colors);
  return COLOR_KEYS.every((k) => (a[k] ?? '') === (b[k] ?? ''));
}

// ------------------------------------------------------------------ «заплатки» настроек

export interface PatchPreset<T> {
  id: string;
  name: string;
  hint: string;
  patch: Partial<T>;
}

/** Совпадают ли текущие значения с заплаткой (числа — с допуском). */
export function patchActive<T extends object>(cur: T, patch: Partial<T>): boolean {
  return (Object.keys(patch) as (keyof T)[]).every((k) => {
    const a = cur[k], b = patch[k];
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
    return a === b;
  });
}

/**
 * Технология изготовления: ширины дорожек, площадки, переходы, зазоры DRC и
 * автотрассировки. Значения — разумная отправная точка, а не гарантия:
 * перед заказом сверяйтесь с требованиями своего производства.
 */
export const TECH_PRESETS: PatchPreset<Defs>[] = [
  {
    id: 'std', name: 'Стандарт PSBees', hint: 'Значения по умолчанию: удобно для выводных деталей',
    patch: {
      trackW: 0.6, padSize: 1.9, padDrill: 0.9, viaSize: 1.8, viaDrill: 0.8, drcClear: 0.2,
      rtW: 0.8, rtClear: 0.4, rtHoleClear: 0.6, rtStep: 0.635, rtAllowTop: true, rtViaCost: 8,
    },
  },
  {
    id: 'lut', name: 'ЛУТ (утюг)', hint: 'Толстые дорожки и большие зазоры — переживут перенос тонера',
    patch: {
      trackW: 0.8, padSize: 2.0, padDrill: 0.8, viaSize: 2.0, viaDrill: 0.8, drcClear: 0.4,
      rtW: 0.8, rtClear: 0.45, rtHoleClear: 0.6, rtStep: 0.635, rtAllowTop: false, rtViaCost: 8,
    },
  },
  {
    id: 'photo', name: 'Фоторезист', hint: 'Тоньше, чем ЛУТ: 0.4–0.5 мм дорожки и 0.3 мм зазоры',
    patch: {
      trackW: 0.5, padSize: 1.8, padDrill: 0.8, viaSize: 1.4, viaDrill: 0.6, drcClear: 0.3,
      rtW: 0.5, rtClear: 0.3, rtHoleClear: 0.4, rtStep: 0.635, rtAllowTop: true, rtViaCost: 10,
    },
  },
  {
    id: 'cnc', name: 'Фрезеровка ЧПУ', hint: 'Односторонняя, зазор не меньше ширины гравера; перемычки — площадками',
    patch: {
      trackW: 0.6, padSize: 2.0, padDrill: 0.9, viaSize: 1.8, viaDrill: 0.8, drcClear: 0.35,
      rtW: 0.6, rtClear: 0.35, rtHoleClear: 0.5, rtStep: 0.635, rtAllowTop: false, rtAutoPad: true, rtViaCost: 8,
    },
  },
  {
    id: 'fab', name: 'Заводская (стандарт)', hint: 'Типовые 0.25 мм дорожки, 0.15–0.2 мм зазоры, переходы 0.6/0.3',
    patch: {
      trackW: 0.25, padSize: 1.6, padDrill: 0.8, viaSize: 0.6, viaDrill: 0.3, drcClear: 0.15,
      rtW: 0.25, rtClear: 0.2, rtHoleClear: 0.25, rtStep: 0.254, rtAllowTop: true, rtViaCost: 4,
    },
  },
  {
    id: 'fine', name: 'Плотный SMD', hint: 'Заводская плата с мелким шагом: 0.15 мм дорожки и зазоры',
    patch: {
      trackW: 0.15, padSize: 1.4, padDrill: 0.7, viaSize: 0.45, viaDrill: 0.25, drcClear: 0.127,
      smdW: 0.6, smdH: 1.0, rtW: 0.15, rtClear: 0.15, rtHoleClear: 0.2, rtStep: 0.127,
      rtAllowTop: true, rtViaCost: 4,
    },
  },
  {
    id: 'power', name: 'Силовая', hint: 'Широкие дорожки под ток, большие площадки и зазоры',
    patch: {
      trackW: 1.5, padSize: 2.6, padDrill: 1.2, viaSize: 2.0, viaDrill: 1.0, drcClear: 0.5,
      rtW: 1.5, rtClear: 0.6, rtHoleClear: 0.8, rtStep: 0.635, rtAllowTop: true, rtViaCost: 12,
    },
  },
];

/** Режимы сетки и привязки. */
export const GRID_MODE_PRESETS: PatchPreset<Defs>[] = [
  {
    id: 'thru', name: 'Выводные (шаг 2.54)', hint: 'Сетка 1.27 мм (50 mil), главные узлы каждые 2.54 мм',
    patch: { grid: 1.27, gridUnit: 'mil', gridStyle: 'dots', gridDiv: 1, gridMajor: 2, snapOn: true, snapObj: true, angle: '45' },
  },
  {
    id: 'smd', name: 'Мелкий SMD', hint: 'Сетка 0.635 мм (25 mil), подразбиение 1/2 и привязка к площадкам',
    patch: { grid: 0.635, gridUnit: 'mil', gridStyle: 'dots', gridDiv: 2, gridMajor: 5, snapOn: true, snapObj: true, angle: '45' },
  },
  {
    id: 'metric', name: 'Метрика 0.5 мм', hint: 'Линии каждые 0.5 мм, главные — каждые 5 мм',
    patch: { grid: 0.5, gridUnit: 'mm', gridStyle: 'lines', gridDiv: 1, gridMajor: 10, snapOn: true, snapObj: false, angle: '45' },
  },
  {
    id: 'mech', name: 'Корпус и контур', hint: 'Крупная сетка 1 мм, прямые углы — для контура и крепежа',
    patch: { grid: 1, gridUnit: 'mm', gridStyle: 'cross', gridDiv: 1, gridMajor: 10, snapOn: true, snapObj: true, angle: '90' },
  },
  {
    id: 'free', name: 'Свободно', hint: 'Без сетки — только привязка к объектам, любые углы',
    patch: { gridStyle: 'none', snapOn: false, snapObj: true, angle: 'free' },
  },
];

/** Вид интерфейса и холста. */
export const UI_PRESETS: PatchPreset<Prefs>[] = [
  {
    id: 'std', name: 'Стандартный', hint: 'Всё на месте: док, перекрестие, подсказки',
    patch: {
      compactUi: false, showDock: true, crosshair: true, cursorLabel: true, statusBar: true,
      statusHint: true, statusUnits: 'both', zoomStep: 1.28,
    },
  },
  {
    id: 'laptop', name: 'Ноутбук', hint: 'Компактные панели, координаты только в мм',
    patch: {
      compactUi: true, showDock: true, crosshair: true, cursorLabel: true, statusBar: true,
      statusHint: false, statusUnits: 'mm', zoomStep: 1.28,
    },
  },
  {
    id: 'minimal', name: 'Минимализм', hint: 'Ничего лишнего: без дока, перекрестия и подсказок',
    patch: {
      compactUi: true, showDock: false, crosshair: false, cursorLabel: false, statusBar: true,
      statusHint: false, statusUnits: 'mm', zoomStep: 1.28,
    },
  },
  {
    id: 'learn', name: 'Обучение', hint: 'Крупно, все подсказки, плавный зум и подтверждение удаления',
    patch: {
      compactUi: false, showDock: true, crosshair: true, cursorLabel: true, statusBar: true,
      statusHint: true, statusUnits: 'both', zoomStep: 1.15, confirmDelete: true,
    },
  },
];

/** Печать 1:1 (PNG): слой не меняется — только разрешение, зеркало и метки. */
export const PRINT_PRESETS: PatchPreset<Prefs>[] = [
  { id: 'lut', name: 'ЛУТ', hint: '600 dpi, зеркально, метки центров отверстий', patch: { pngDpi: 600, pngMirror: true, pngDrill: true } },
  { id: 'photo', name: 'Фотошаблон', hint: '1200 dpi, зеркально, метки отверстий', patch: { pngDpi: 1200, pngMirror: true, pngDrill: true } },
  { id: 'draft', name: 'Черновик', hint: '300 dpi, без зеркала — проверить разводку на бумаге', patch: { pngDpi: 300, pngMirror: false, pngDrill: true } },
];

/** Типовые размеры новой платы. */
export const BOARD_SIZE_PRESETS: { id: string; name: string; w: number; h: number }[] = [
  { id: 'half-euro', name: '½ Евро', w: 100, h: 80 },
  { id: 'euro', name: 'Евро', w: 160, h: 100 },
  { id: 'sq50', name: '50 × 50', w: 50, h: 50 },
  { id: 'sq100', name: '100 × 100', w: 100, h: 100 },
  { id: 'shield', name: 'Arduino Shield', w: 68.6, h: 53.3 },
  { id: 'small', name: 'Модуль 30 × 20', w: 30, h: 20 },
];

// ------------------------------------------------------------------ свои пресеты

/** Поля Prefs, которые не входят в профиль: геометрия окна настроек. */
const PREFS_SKIP = new Set<string>(['setSection', 'setW', 'setH', 'setX', 'setY', 'setMax']);

export interface ProfileUi { ids: string[]; hidden: string[]; sides: SidesConf }

/** Полный профиль настроек: оформление, программа, инструменты, интерфейс. */
export interface SettingsProfile {
  id: string;
  name: string;
  created: number;
  theme: ThemeId;
  colors: CustomColors;
  prefs: Partial<Prefs>;
  defs: Partial<Defs>;
  ui?: ProfileUi;
}

export interface UserPresets {
  themes: ThemePreset[];
  profiles: SettingsProfile[];
}

const EMPTY: UserPresets = { themes: [], profiles: [] };

const uid = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const str = (v: unknown, d: string): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : d);
const theme = (v: unknown): ThemeId => (v === 'light' ? 'light' : 'dark');
const obj = (v: unknown): Record<string, unknown> =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Профиль из текущих настроек (без геометрии окна настроек). */
export function makeProfile(
  name: string,
  cur: { theme: ThemeId; colors: CustomColors; prefs: Prefs; defs: Defs; ui?: ProfileUi },
): SettingsProfile {
  const prefs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cur.prefs)) if (!PREFS_SKIP.has(k)) prefs[k] = v;
  return {
    id: 'p-' + uid(),
    name: str(name, 'Мой профиль'),
    created: Date.now(),
    theme: cur.theme,
    colors: cleanColors(cur.colors),
    prefs: JSON.parse(JSON.stringify(prefs)),
    defs: JSON.parse(JSON.stringify(cur.defs)),
    ui: cur.ui ? JSON.parse(JSON.stringify(cur.ui)) : undefined,
  };
}

export function makeThemePreset(name: string, t: ThemeId, colors: CustomColors): ThemePreset {
  return { id: 't-' + uid(), name: str(name, 'Моя тема'), theme: t, colors: cleanColors(colors), user: true };
}

/** Отбросить битые записи (данные из localStorage или файла). */
export function normalizeUserPresets(raw: unknown): UserPresets {
  const o = obj(raw);
  const themes = (Array.isArray(o.themes) ? o.themes : []).map(obj)
    .filter((t) => typeof t.id === 'string')
    .map((t): ThemePreset => ({
      id: t.id as string, name: str(t.name, 'Моя тема'), theme: theme(t.theme),
      colors: cleanColors(t.colors), user: true,
    }));
  const profiles = (Array.isArray(o.profiles) ? o.profiles : []).map(obj)
    .filter((p) => typeof p.id === 'string')
    .map((p): SettingsProfile => {
      const ui = obj(p.ui);
      return {
        id: p.id as string,
        name: str(p.name, 'Мой профиль'),
        created: typeof p.created === 'number' ? p.created : 0,
        theme: theme(p.theme),
        colors: cleanColors(p.colors),
        prefs: obj(p.prefs) as Partial<Prefs>,
        defs: obj(p.defs) as Partial<Defs>,
        ui: Array.isArray(ui.ids) && Array.isArray(ui.hidden) && ui.sides
          ? { ids: ui.ids as string[], hidden: ui.hidden as string[], sides: ui.sides as SidesConf }
          : undefined,
      };
    });
  return { themes: themes.slice(0, 50), profiles: profiles.slice(0, 50) };
}

export function loadUserPresets(): UserPresets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (raw) return normalizeUserPresets(JSON.parse(raw));
  } catch { /* приватный режим / SSR */ }
  return EMPTY;
}

export function saveUserPresets(p: UserPresets): void {
  try {
    if (p.themes.length || p.profiles.length) localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
    else localStorage.removeItem(PRESETS_KEY);
  } catch { /* ignore */ }
}

/** Слить пресеты (импорт из файла): одинаковые id не дублируются. */
export function mergeUserPresets(a: UserPresets, b: UserPresets): UserPresets {
  const ids = (l: { id: string }[]) => new Set(l.map((x) => x.id));
  const ta = ids(a.themes), pa = ids(a.profiles);
  return {
    themes: [...a.themes, ...b.themes.filter((t) => !ta.has(t.id))].slice(0, 50),
    profiles: [...a.profiles, ...b.profiles.filter((p) => !pa.has(p.id))].slice(0, 50),
  };
}
