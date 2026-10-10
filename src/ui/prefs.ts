// Общие настройки программы (настройки инструментов — в src/ui/panels.ts, Defs).
//
// Здесь живёт то, что относится к программе целиком: автосохранение, глубина
// отмены, вид курсора, строка состояния, параметры экспорта, окно настроек.
// Всё хранится в localStorage под ключом psbees.prefs и читается один раз
// при старте: правка любой настройки применяется сразу, перезапуск не нужен.
import { useCallback, useState } from 'react';
import { DEFAULT_HOTKEYS, normalizeHotkeys, type HotkeyMap } from './hotkeys';
import type { LearnOfferMode } from './coach';

export const PREFS_KEY = 'psbees.prefs';
export type { HotkeyMap };

/** Слой для печати 1:1 (совпадает с ExportPngOpts в src/ui/dialogs.tsx). */
export type PrintLayer = 'k1' | 'k2' | 's1' | 's2' | 'outline';

export interface Prefs {
  // ---------------- редактор ----------------
  /** открывать прошлую плату при запуске (иначе — чистая плата) */
  restoreDraft: boolean;
  /** автосохранение черновика */
  autosave: boolean;
  /** как часто писать черновик, мс */
  autosaveMs: number;
  /** сколько шагов держит отмена; 0 — считать автоматически по размеру платы */
  historyDepth: number;
  /** спрашивать подтверждение перед удалением выделенного (Del) */
  confirmDelete: boolean;

  // ---------------- холст и курсор ----------------
  /** перекрестие по курсору во всю ширину холста */
  crosshair: boolean;
  /** плашка с координатами рядом с курсором */
  cursorLabel: boolean;
  /** строка состояния внизу окна */
  statusBar: boolean;
  /** подсказка по текущему инструменту в строке состояния */
  statusHint: boolean;
  /** единицы координат в строке состояния */
  statusUnits: 'mm' | 'mil' | 'both';
  /** колесо мыши масштабирует вид */
  wheelZoom: boolean;
  /** инвертировать направление колеса */
  invertWheel: boolean;
  /** во сколько раз меняется масштаб за один щелчок колеса */
  zoomStep: number;

  // ---------------- интерфейс ----------------
  /** компактный интерфейс: плотнее шапка, панели и поля */
  compactUi: boolean;
  /** вертикальный док инструментов у холста */
  showDock: boolean;

  // ---------------- файлы и производство ----------------
  /** параметры новой платы по умолчанию */
  newName: string;
  newW: number;
  newH: number;
  /** параметры печати 1:1 (PNG) по умолчанию */
  pngLayer: PrintLayer;
  pngDpi: number;
  pngMirror: boolean;
  pngDrill: boolean;

  // ---------------- обновления ----------------
  /** проверять обновления при запуске */
  checkUpdates: boolean;

  // ---------------- обучение ----------------
  /**
   * Как вести себя с практическими уроками: «ask» — держать полосу «Пройти
   * обучение / Пропустить» под холстом, пока есть непройденные уроки (по
   * умолчанию), «auto» — сразу запускать первый непройденный урок, «off» —
   * не показывать ничего. Обучение добровольное: любой шаг пропускается.
   */
  learnOnStart: LearnOfferMode;

  // ---------------- горячие клавиши ----------------
  /** действие → список сочетаний (см. src/ui/hotkeys.ts) */
  hotkeys: HotkeyMap;

  // ---------------- окно настроек ----------------
  /** последний открытый раздел */
  setSection: string;
  /** размер окна настроек */
  setW: number;
  setH: number;
  /** положение окна (null — по центру) */
  setX: number | null;
  setY: number | null;
  /** развёрнуто на весь экран */
  setMax: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  restoreDraft: true,
  autosave: true,
  autosaveMs: 600,
  historyDepth: 0,
  confirmDelete: false,

  crosshair: true,
  cursorLabel: true,
  statusBar: true,
  statusHint: true,
  statusUnits: 'both',
  wheelZoom: true,
  invertWheel: false,
  zoomStep: 1.28,

  compactUi: false,
  showDock: true,

  newName: 'Плата',
  newW: 100,
  newH: 80,
  pngLayer: 'k2',
  pngDpi: 600,
  pngMirror: true,
  pngDrill: true,

  checkUpdates: true,

  learnOnStart: 'ask',

  hotkeys: DEFAULT_HOTKEYS,

  setSection: 'learn',
  setW: 900,
  setH: 620,
  setX: null,
  setY: null,
  setMax: false,
};

const PRINT_LAYERS: PrintLayer[] = ['k1', 'k2', 's1', 's2', 'outline'];

const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, d: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  if (!isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const pick = <T extends string>(v: unknown, list: T[], d: T): T =>
  typeof v === 'string' && (list as string[]).includes(v) ? (v as T) : d;
const maybeNum = (v: unknown): number | null =>
  typeof v === 'number' && isFinite(v) ? v : null;

/** Слить сохранённые настройки с defaults: чужие и битые поля отбрасываются. */
export const normalizePrefs = (p?: Partial<Prefs> | null): Prefs => {
  const s = (p ?? {}) as Record<string, unknown>;
  return {
    restoreDraft: bool(s.restoreDraft, DEFAULT_PREFS.restoreDraft),
    autosave: bool(s.autosave, DEFAULT_PREFS.autosave),
    autosaveMs: num(s.autosaveMs, DEFAULT_PREFS.autosaveMs, 200, 60_000),
    historyDepth: Math.round(num(s.historyDepth, DEFAULT_PREFS.historyDepth, 0, 1000)),
    confirmDelete: bool(s.confirmDelete, DEFAULT_PREFS.confirmDelete),

    crosshair: bool(s.crosshair, DEFAULT_PREFS.crosshair),
    cursorLabel: bool(s.cursorLabel, DEFAULT_PREFS.cursorLabel),
    statusBar: bool(s.statusBar, DEFAULT_PREFS.statusBar),
    statusHint: bool(s.statusHint, DEFAULT_PREFS.statusHint),
    statusUnits: pick(s.statusUnits, ['mm', 'mil', 'both'], DEFAULT_PREFS.statusUnits),
    wheelZoom: bool(s.wheelZoom, DEFAULT_PREFS.wheelZoom),
    invertWheel: bool(s.invertWheel, DEFAULT_PREFS.invertWheel),
    zoomStep: num(s.zoomStep, DEFAULT_PREFS.zoomStep, 1.02, 3),

    compactUi: bool(s.compactUi, DEFAULT_PREFS.compactUi),
    showDock: bool(s.showDock, DEFAULT_PREFS.showDock),

    newName: typeof s.newName === 'string' && s.newName.trim() ? s.newName : DEFAULT_PREFS.newName,
    newW: num(s.newW, DEFAULT_PREFS.newW, 5, 1000),
    newH: num(s.newH, DEFAULT_PREFS.newH, 5, 1000),
    pngLayer: pick(s.pngLayer, PRINT_LAYERS, DEFAULT_PREFS.pngLayer),
    pngDpi: [300, 600, 1200].includes(Number(s.pngDpi)) ? Number(s.pngDpi) : DEFAULT_PREFS.pngDpi,
    pngMirror: bool(s.pngMirror, DEFAULT_PREFS.pngMirror),
    pngDrill: bool(s.pngDrill, DEFAULT_PREFS.pngDrill),

    checkUpdates: bool(s.checkUpdates, DEFAULT_PREFS.checkUpdates),

    learnOnStart: pick(s.learnOnStart, ['ask', 'auto', 'off'] as LearnOfferMode[], DEFAULT_PREFS.learnOnStart),

    hotkeys: normalizeHotkeys(s.hotkeys),

    setSection: typeof s.setSection === 'string' ? s.setSection : DEFAULT_PREFS.setSection,
    setW: num(s.setW, DEFAULT_PREFS.setW, 520, 2400),
    setH: num(s.setH, DEFAULT_PREFS.setH, 360, 1600),
    setX: maybeNum(s.setX),
    setY: maybeNum(s.setY),
    setMax: bool(s.setMax, DEFAULT_PREFS.setMax),
  };
};

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return normalizePrefs(JSON.parse(raw));
  } catch { /* приватный режим / SSR */ }
  return normalizePrefs();
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Настройки программы + запись в localStorage при каждом изменении. */
export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => {
      const next = normalizePrefs({ ...prev, ...patch });
      savePrefs(next);
      return next;
    });
  }, []);
  return [prefs, setPrefs];
}
