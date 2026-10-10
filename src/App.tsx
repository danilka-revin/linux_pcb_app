import { NI } from './ui/widgets';
import { activeClearance, trackClearance, type TrackClearanceViolation } from './pcb/track-clearance';
import { ClearanceExceptions } from './ui/clearance-exceptions';
import { boardShape, boardPath } from './pcb/board-shape';
import { pickTrackNode, terminalPath, trackNodeTerminal, type TrackNodeTerminal } from './pcb/manual-route';
// PSBees — редактор печатных плат для Linux и Windows (аналог Sprint-Layout;
// фирменный стиль «пчелиный»: оса с молнией, золото на графите; тёмная и светлая темы).
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as M from './pcb/model';
import { expandComp, expandDoc, libElsToEnts } from './pcb/expand';
import { bboxOf as libBBox } from './pcb/footprint';
import { lay6ToDoc, docToLay6, hasLay6Magic, lmkToEnts } from './pcb/lay6';
import {
  addMacro, buildTree, createFolder, exportJSON, importJSON, loadStore, makeMacro,
  moveMacro, removeFolder, removeMacro, renameFolder, safeName, saveStore, updateMacro,
  type Macro, type Store,
} from './pcb/userlib';
import { generate } from './pcb/gen';
import {
  expandSelection, groupBBox, groupIndex, groupSelection,
  pruneGroups, remapGroups, renameGroup, ungroupAll, ungroupSelection,
} from './pcb/group';
import {
  bboxArray, CANVAS_UI, COLORS, drawEnt, drawFlat, renderPrint, setCanvasTheme, toWorld, zOrdered,
  type ThemeId, type View,
} from './pcb/render';
import { noteFrame, perfDpr } from './perf';
import { usePerfProfile } from './ui/perf';
import {
  cycleGrid, drawGrid, fmtGridFull, gridSummary, nearestRefPts, snapPoint,
  type GridConf,
} from './pcb/grid';
import { productionFiles } from './pcb/gerber';
import { autoroute, clearanceAt, pickEndpoint, endpointOf, type RouteEnd } from './pcb/autoroute';
import {
  deleteNode, insertNode, joinTrackPts, moveTrackNode, nearestOnPts, nodeAction, nodeUnder,
  pickSolderPair, splitTrackAt, trackEndsNear,
} from './pcb/trackedit';
import { copperComponents, type NetRouteVariants, type NetRouteVariant } from './pcb/netroute';
import { AutoPlaceDialog, RouteVariantsDialog } from './ui/auto-layout';
import { NetsPanel, NET_COLORS } from './ui/nets';
import { InventoryDialog } from './ui/inventory';
import { StatsDialog } from './ui/stats';
import { ImageImportDialog } from './ui/image-import';
import { alignSnap, collectSnapTagged, nearestSnap, selBBox, type AlignGuide, type SnapKind } from './pcb/snapguide';
import { download, makeZip } from './pcb/zip';

// ЧПУ открывают редко; CAM и его интерфейс загружаются по запросу, не при старте редактора.
const CncDialog = lazy(() => import('./ui/cnc').then((m) => ({ default: m.CncDialog })));
// Предпросмотр платы (2D и 3D) — тяжёлый (Three.js), грузим лениво.
const BoardPreviewDialog = lazy(() => import('./ui/board-preview').then((m) => ({ default: m.BoardPreviewDialog })));
import { Ic } from './ui/icons';
import {
  LayersPanel, PropsPanel, TOOLS,
  type Defs, type ToolId,
} from './ui/panels';
// Окно настроек: отдельное (перемещаемое) окно со всеми параметрами программы.
import { SettingsWindow } from './ui/settings';
// Общие настройки программы (автосохранение, вид, экспорт) и конфигурация интерфейса.
import { DEFAULT_PREFS, usePrefs } from './ui/prefs';
// Горячие клавиши настраиваются пользователем (окно настроек → «Горячие клавиши»).
import { comboOf, reverseHotkeys } from './ui/hotkeys';
import {
  DEFAULT_SIDES, LEFT_TAB_NAMES, LEFT_TABS, clampW, loadUi, normalizeSides, saveUi,
  type LeftTabId, type UiState,
} from './ui/uiconf';
import { GenPanel, MacroTree, genSpecText } from './ui/genpanel';
import { GroupsPanel } from './ui/groups';
import { FootprintCatalog, type CatalogSelection } from './ui/catalog';
import {
  AboutDialog, ColorsDialog, ExportDialog, NewBoardDialog, PanelizeDialog, type ExportPngOpts,
} from './ui/dialogs';
import { GridDialog, GridQuickPanel, GridToolbar, gridOf } from './ui/grid';
import { LibPreviewDialog } from './ui/libpreview';
import { applyCustomColors, canvasOverrides, loadCustomColors, saveCustomColors, type CustomColors } from './ui/palette';
import {
  loadUserPresets, mergeUserPresets, normalizeUserPresets, saveUserPresets, type UserPresets,
} from './ui/presets';
import { UiBuilderDialog, useUpdater } from './ui/updater';
import { TourDialog } from './ui/tour';
import { ConfirmDialog, MenuBtn, Modal, SplitBtn } from './ui/widgets';
import { ProgressBar } from './ui/progress';
import { cloudApi, cloudError, CloudError, type CloudProject, type CloudProjectDetail, type CloudUser } from './cloud/api';
import { CloudAccountDialog, CloudProjectsDialog, cloudSaveLabel, type CloudSaveState } from './cloud/projects';

declare global {
  interface Window {
    psbees?: {
      closeApp: () => void;
    };
  }
}

type ToolId2 = ToolId;

/** Живая полоса прогресса трассировки: процент по вариантам и прошедшее время. */
function RoutingProgress({ text }: { text: string }) {
  const start = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const m = /Вариант (\d+)\/(\d+)/.exec(text);
  const attempt = m ? Number(m[1]) : 0, total = m ? Number(m[2]) : 0;
  const pct = total ? ((attempt - 1) / total) * 100 : 0;
  const secs = Math.max(0, Math.round((now - start.current) / 1000));
  const time = secs < 60 ? `${secs} с` : `${Math.floor(secs / 60)} мин ${String(secs % 60).padStart(2, '0')} с`;
  return <ProgressBar
    label={text || 'Подготовка трассировки…'}
    pct={pct}
    indeterminate={!total}
    live
    steps={total ? [
      { id: 'prep', label: 'Подготовка сетки и связей', state: 'done' },
      { id: 'search', label: `Перебор вариантов (${attempt}/${total})`, state: 'run', frac: total ? (attempt - 1) / total : 0 },
      { id: 'apply', label: 'Применить разводку одним действием', state: 'wait' },
    ] : undefined}
    meta={<>{m ? `вариант ${attempt} из ${total}` : 'строим карту связей'} · прошло {time}</>}
  />;
}

/** Фирменный логотип (оса с молнией) — значок в шапке. */
function BeeMark({ size = 40 }: { size?: number }) {
  return <img src="/logo.png" alt="" width={size} height={size} draggable={false} />;
}

const THEME_KEY = 'psbees.theme';

function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch { /* приватный режим / SSR */ }
  return 'dark';
}

/** Русские формы множественного числа: [1, 2, 5] → «1 дорожка», «2 дорожки», «5 дорожек» */
function plur(n: number, w: [string, string, string]): string {
  const a = Math.abs(n) % 100, d = Math.abs(n) % 10;
  const f = a > 10 && a < 20 ? 2 : d === 1 ? 0 : d >= 2 && d <= 4 ? 1 : 2;
  return `${n} ${w[f]}`;
}

/** Общий пустой список нарушений: стабильная ссылка для memo-зависимостей. */
const EMPTY_MARKS: TrackClearanceViolation[] = [];

/**
 * Сколько шагов истории отмены хранить. Копия документа — это вся плата целиком,
 * поэтому на очень крупных платах (тысячи примитивов) сто копий съедали память
 * и роняли слабые устройства. Мелкие платы получают полные 100 шагов, крупные —
 * меньше (не ниже 12), чтобы отмена всегда работала и редактор не падал.
 * Значение из настроек («Шагов отмены») перекрывает расчёт; 0 — автоматически.
 */
function historyLimit(doc: M.Doc, depth = 0): number {
  if (depth > 0) return depth;
  const n = doc.entities.length;
  if (n <= 800) return 100;
  return Math.max(12, Math.round(80_000 / n));
}

/** Состояние курсора (пиксели холста, мировые координаты, привязка, модификаторы). */
type CursorState = {
  px: number; py: number; wx: number; wy: number; rx: number; ry: number; alt: boolean; sh: boolean;
};

/**
 * Курсор для «живых» подсказок (DRC под курсором). При ms <= 0 отдаём состояние
 * как есть — профиль «высокий» ничего не теряет. При ms > 0 значение обновляется
 * не чаще, чем раз в ms миллисекунд: подсказка догоняет курсор с задержкой, зато
 * тяжёлая проверка зазоров не выполняется на каждый кадр (важно для слабых машин).
 */
function useLiveCursor(mouse: CursorState, ms: number): CursorState {
  const latest = useRef(mouse);
  latest.current = mouse;
  const [slow, setSlow] = useState(mouse);
  useEffect(() => {
    if (ms <= 0) return;
    setSlow(latest.current);
    const t = window.setInterval(() => {
      setSlow((prev) => (prev === latest.current ? prev : latest.current));
    }, ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return ms > 0 ? slow : mouse;
}

type Draft =
  | { t: 'track'; pts: { x: number; y: number; layer: 'k1' | 'k2' }[] }
  | { t: 'poly'; pts: M.Pt[] }
  | { t: 'line'; p1: M.Pt }
  | { t: 'rect'; p1: M.Pt }
  | { t: 'circle'; c: M.Pt }
  | { t: 'ruler'; pts: M.Pt[] }
  | { t: 'dim'; p1: M.Pt; p2: M.Pt | null };

type Drag =
  | { mode: 'pan'; startPx: { x: number; y: number }; view0: View }
  | { mode: 'move'; startWorld: M.Pt; doc0: M.Doc; moved: boolean; dx: number; dy: number; guides?: AlignGuide[]; statics?: M.Pt[] }
  | { mode: 'marquee'; startWorld: M.Pt; curWorld: M.Pt }
  | { mode: 'node'; entId: string; idx: number; doc0: M.Doc; moved: boolean; startWorld: M.Pt; preview?: M.Pt; cache?: M.Entity };

/** Что писать справа после того, как узел поставлен двойным кликом. */
const NODE_HINT = 'Узел поставлен — тяните его мышью или задайте X/Y справа.';

const AUTOSAVE_KEY = 'lauaut.autosave';
const QUERY_KEY = 'lauaut.genQuery';
const queryKey = (userId?: string) => userId ? `${QUERY_KEY}.${userId}` : QUERY_KEY;
const loadQuery = (userId?: string): string => {
  try {
    return globalThis.localStorage?.getItem(queryKey(userId)) ?? 'dip 8';
  } catch {
    return 'dip 8';
  }
};
const saveQuery = (q: string, userId?: string): void => {
  try {
    globalThis.localStorage?.setItem(queryKey(userId), q);
  } catch {
    /* приватный режим — не страшно */
  }
};

/** Деталь, готовая к установке: сущности + габарит + откуда взялась */
interface Detail {
  name: string;
  ents: M.Entity[];
  bl: [number, number, number, number];
  spec?: string;
  note?: string;
  /** строка генератора, из которой деталь получилась */
  query?: string;
  /** id сохранённой детали (для «обновить») */
  macroId?: string;
}
const DEFS_KEY = 'lauaut.defs';

/** Группы кнопок тулбара, настраиваемые конструктором интерфейса. */
const GROUP_DEFS: { id: string; label: string }[] = [
  { id: 'file', label: 'Файл' },
  { id: 'gen', label: 'Генератор деталей' },
  { id: 'undo', label: 'Отмена / повтор' },
  { id: 'tools', label: 'Инструменты (вертикальный док у холста)' },
  { id: 'group', label: 'Группировка элементов' },
  { id: 'grid', label: 'Сетка и углы' },
  { id: 'layer', label: 'Слой K1 / K2' },
  { id: 'view', label: 'Вид' },
  { id: 'preview', label: 'Предпросмотр 2D/3D' },
  { id: 'about', label: 'Тема и справка' },
];
const GROUP_ORDER: string[] = GROUP_DEFS.map((g) => g.id);
const GROUP_NAMES: Record<string, string> = Object.fromEntries(GROUP_DEFS.map((g) => [g.id, g.label]));

/**
 * Группы, которые нельзя спрятать конструктором интерфейса.
 * Быстрые кнопки обновления и настроек добавляются сразу после undo/redo,
 * поэтому эта группа остаётся на панели даже при пользовательской настройке.
 */
const PINNED_GROUPS: string[] = ['undo'];

/**
 * Инструменты рисования вынесены из верхней панели в вертикальный док у холста
 * (как в Sprint-Layout/KiCad): верхняя панель остаётся в одну строку.
 * Группы дока разделены тонкими линиями: выбор и анализ → медь → графика → прочее.
 */
const TOOL_GROUPS: ToolId2[][] = [
  ['select'],
  ['route', 'probe'],
  ['track', 'cut', 'solder', 'pad', 'smd', 'via', 'hole'],
  ['line', 'rect', 'circle', 'fill', 'text'],
  ['ruler', 'dim', 'comp'],
];
/** Цифровые горячие клавиши инструментов (для подсказок) */
const TOOL_KEYS: Partial<Record<ToolId2, string>> = {
  select: '1', track: '2', pad: '3', via: '4', hole: '5',
  line: '6', text: '7', ruler: '8', route: '9', probe: '0',
  cut: 'X', solder: 'S', dim: 'U',
};

const DEFAULT_DEFS: Defs = {
  grid: 1.27,
  gridUnit: 'mm',
  gridStyle: 'dots',
  gridDiv: 1,
  gridMajor: 5,
  gridOx: 0,
  gridOy: 0,
  snapOn: true,
  snapObj: true,
  snapPx: 10,
  showAxes: true,
  angle: '45',
  trackW: 0.6,
  drcClear: 0.2,
  drcEnabled: true,
  cutGap: 2,
  cutPads: false,
  padShape: 'round',
  padSize: 1.9,
  padDrill: 0.9,
  viaSize: 1.8,
  viaDrill: 0.8,
  holeD: 1.0,
  smdW: 1.2,
  smdH: 2.2,
  lineW: 0.25,
  lineLayer: 's1',
  circleW: 0.25,
  circleLayer: 's1',
  rectLayer: 's1',
  rectFilled: false,
  rectTh: 0.25,
  text: 'Текст',
  textSize: 2.5,
  textTh: 0.3,
  textRot: 0,
  textMirror: false,
  textLayer: 's1',
  dimTh: 0.15,
  dimSize: 2.5,
  dimLayer: 's1',
  dimMode: 'aligned',
  copperUm: 35,
  tempRise: 10,
  rtW: 0.8,
  rtClear: 0.4,
  rtHoleClear: 0.6,
  rtStep: 0.635,
  rtViaCost: 8,
  rtTopMul: 1.5,
  rtAllowTop: true,
  rtAngle: '45',
  rtAutoPad: true,
};

function draftKey(userId?: string): string { return userId ? `psbees.cloud.draft.${userId}` : AUTOSAVE_KEY; }
function openCloudKey(userId: string): string { return `psbees.cloud.open.${userId}`; }
function rememberCloud(userId: string, project: CloudProject | null): void {
  try {
    if (project) sessionStorage.setItem(openCloudKey(userId), JSON.stringify({ id: project.id, version: project.version }));
    else sessionStorage.removeItem(openCloudKey(userId));
  } catch { /* недоступно хранилище вкладки */ }
}
function rememberDraft(userId: string, document: M.Doc): void {
  try { sessionStorage.setItem(draftKey(userId), JSON.stringify(document)); } catch { /* лимит браузера */ }
}

function loadDoc(userId?: string, restore = true): M.Doc {
  if (!restore) return M.newBoard(100, 80, 'Плата');
  try {
    // На общем сервере не пишем приватную плату в общий localStorage компьютера:
    // черновик живёт только в этой вкладке и удаляется при выходе из аккаунта.
    const raw = (userId ? sessionStorage : localStorage).getItem(draftKey(userId));
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.entities) && typeof d.w === 'number') {
        const nd = d as M.Doc;
        if (nd.groups?.length) nd.groups = pruneGroups(nd.groups, new Set(nd.entities.map((e) => e.id)));
        return nd;
      }
    }
  } catch { /* ignore */ }
  return M.newBoard(100, 80, 'Плата');
}

function loadDefs(): Defs {
  try {
    const raw = localStorage.getItem(DEFS_KEY);
    if (raw) return { ...DEFAULT_DEFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return DEFAULT_DEFS;
}

const baseId = (id: string): string => id.split(':')[0];

export default function App({ cloudUser, onLogout }: { cloudUser?: CloudUser; onLogout?: () => Promise<void> } = {}) {
  // ---------------- состояние ----------------
  // Общие настройки программы читаются первыми: от них зависит, восстанавливать
  // ли прошлую плату. Дальше к ним обращаются и обработчики мыши (через prefsRef),
  // поэтому объект настроек не должен попадать в списки зависимостей на каждый кадр.
  const [prefs, setPrefs] = usePrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [doc, setDoc] = useState<M.Doc>(() => loadDoc(cloudUser?.id, prefs.restoreDraft));
  const [activeCloud, setActiveCloud] = useState<CloudProject | null>(null);
  const activeCloudRef = useRef<CloudProject | null>(null);
  activeCloudRef.current = activeCloud;
  const syncedCloudDoc = useRef<M.Doc | null>(null);
  const savingCloud = useRef(false);
  const restoreGeneration = useRef(0);
  const [cloudStatus, setCloudStatus] = useState<CloudSaveState>('local');
  const [cloudMessage, setCloudMessage] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tool, setToolRaw] = useState<ToolId2>('select');
  // Выбранный узел одиночной дорожки/полигона в инструменте «Выбор».
  const [editNode, setEditNode] = useState<number | null>(null);
  // сообщения правки узлов / инструментов «Разрыв» и «Пайка» (показываются справа)
  const [trackMsg, setTrackMsg] = useState<{ msg: string; ok: boolean | null }>({ msg: '', ok: null });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<View>({ s: 8, ox: 80, oy: 500, mir: false });
  const [defs, setDefsState] = useState<Defs>(loadDefs);
  const [hidden, setHidden] = useState<Set<M.LayerId>>(new Set());
  const [activeCu, setActiveCu] = useState<'k1' | 'k2'>('k1');
  const [mouse, setMouse] = useState<CursorState>({ px: -100, py: -100, wx: 0, wy: 0, rx: 0, ry: 0, alt: false, sh: false });
  const [size, setSize] = useState({ w: 640, h: 480 });
  // Профиль качества (адаптивно под устройство, см. src/perf.ts). Смена уровня
  // перерисовывает холсты в другом разрешении и меняет частоту живых подсказок.
  const perfLevel = usePerfProfile();
  // --- генератор деталей и личная библиотека (папки + сохранённые футпринты) ---
  // «что ставим»: снапшот детали (чтобы правка строки не меняла призрак под курсором)
  const [place, setPlace] = useState<Detail | null>(null);
  // деталь, открытая крупным предпросмотром
  const [preview, setPreview] = useState<Detail | null>(null);
  const [query, setQueryRaw] = useState<string>(() => loadQuery(cloudUser?.id));
  const [store, setStore] = useState<Store>(() => loadStore(cloudUser?.id));
  const [libTab, setLibTab] = useState<'gen' | 'lib' | 'catalog'>('gen');
  const [libFilter, setLibFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // деталь из библиотеки, которую правим строкой генератора («Обновить»)
  const [editId, setEditId] = useState<string | null>(null);
  const patchStore = useCallback((fn: (s: Store) => Store) => {
    setStore((prev) => {
      const nx = fn(prev);
      saveStore(nx, cloudUser?.id);
      return nx;
    });
  }, [cloudUser]);
  const setQuery = useCallback((q: string) => {
    setQueryRaw(q);
    saveQuery(q, cloudUser?.id);
  }, [cloudUser]);
  // генерация — чистая функция строки: правка любого параметра = правка строки
  const gen = useMemo(() => generate(query), [query]);
  const tree = useMemo(() => buildTree(store, libFilter), [store, libFilter]);
  const detailFromGen = useCallback((macroId?: string): Detail | null => {
    if (!gen.ok || !gen.els || !gen.bl) return null;
    return {
      name: gen.title ?? gen.family?.title ?? 'Деталь',
      ents: libElsToEnts(gen.els),
      bl: gen.bl,
      spec: genSpecText(gen),
      note: gen.notes.join(' '),
      query: gen.query,
      macroId,
    };
  }, [gen]);
  const detailFromMacro = (m: Macro): Detail => ({
    name: m.name,
    ents: m.ents,
    bl: m.bl,
    spec: `${m.ents.length} прим.${m.query ? ' · строка: ' + m.query : ''}`,
    note: m.note,
    query: m.query,
    macroId: m.id,
  });
  const [placeRot, setPlaceRot] = useState(0);
  const [placeSide, setPlaceSide] = useState<'top' | 'bottom'>('top');
  const [pasteTpl, setPasteTpl] = useState<M.Entity[] | null>(null);
  // габарит буфера вставки: один раз на копирование, а не на каждый кадр мыши
  const pasteBB = useMemo(() => (pasteTpl ? M.unionBBox(pasteTpl.map(M.entBBox)) : null), [pasteTpl]);
  const [leftTab, setLeftTab] = useState<LeftTabId>('layers');
  // тема оформления: тёмная (по умолчанию) или светлая, переключается в шапке
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  // кастомные цвета интерфейса (акцент/фон/панели/текст), см. ui/palette
  const [colors, setColorsState] = useState<CustomColors>(loadCustomColors);
  const setColors = useCallback((c: CustomColors) => {
    setColorsState(c);
    saveCustomColors(c);
  }, []);
  // свои пресеты (темы и профили настроек), см. ui/presets
  const [userPresets, setUserPresetsState] = useState<UserPresets>(loadUserPresets);
  const setUserPresets = useCallback((p: UserPresets) => {
    setUserPresetsState(p);
    saveUserPresets(p);
  }, []);
  const [routeMode, setRouteMode] = useState<'pair' | 'nets'>('pair');
  const [activeNet, setActiveNet] = useState<string | null>(null);
  const [routing, setRouting] = useState<string | null>(null);
  const [routeVariants, setRouteVariants] = useState<{ snapshot: M.Doc; variants: NetRouteVariant[] } | null>(null);
  const routeWorker = useRef<Worker | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => () => {
    routeWorker.current?.terminate();
    cancelAnimationFrame(baseRaf.current);
    cancelAnimationFrame(overRaf.current);
    cancelAnimationFrame(moveRaf.current);
  }, []);
  // развёрнутый список примитивов — один раз на изменение doc.entities, переиспользуется везде
  const expanded = useMemo(() => expandDoc(doc.entities), [doc.entities]);
  const netGeometry = useMemo(() => {
    const ends = new Map<string, RouteEnd>();
    if (tool === 'route' && routeMode === 'nets') for (const e of expanded) {
      const end = endpointOf(e);
      if (end) ends.set(e.id, end);
    }
    return { ends, comp: ends.size ? copperComponents(doc.entities) : new Map<string, string>() };
  }, [expanded, doc.entities, tool, routeMode]);
  const [routeA, setRouteA] = useState<RouteEnd | null>(null);
  const [routeMsg, setRouteMsg] = useState<{ msg: string; ok: boolean | null }>({ msg: '', ok: null });
  const [dialog, setDialog] = useState<'new' | 'export' | 'cnc' | 'panelize' | 'about' | 'inventory' | 'stats' | 'imgimport' | 'uib' | 'colors' | 'grid' | 'close' | 'cloud' | 'account' | 'board-preview' | 'autoplace' | 'settings' | 'tour' | null>(null);
  // подтверждение опасного действия (удаление по настройке «Подтверждать удаление»)
  const [confirmAsk, setConfirmAsk] = useState<{ title: string; text: string; ok: string; onOk: () => void } | null>(null);
  const [boardPreviewTab, setBoardPreviewTab] = useState<'2d' | '3d'>('2d');
  const [uiConf, setUiConf] = useState<UiState>(() => loadUi(GROUP_ORDER, PINNED_GROUPS));
  // сохраняем конфигурацию интерфейса сразу (не autosave через таймаут)
  const persistUi = useCallback((c: UiState) => {
    setUiConf(c);
    saveUi(c);
  }, []);
  // версия сборки (сервер отдаёт /version из dist/version.json)
  const [appVer, setAppVer] = useState<string | null>(null);
  const upd = useUpdater(appVer, !cloudUser && prefs.checkUpdates);
  // «Тест цепи»: подсвеченная электрическая цепь (все связные пятки и дорожки)
  const [probe, setProbe] = useState<{
    entId: string; ents: Set<string>;
    pads: number; smd: number; vias: number; tracks: number;
  } | null>(null);
  // связность меди пересчитывается только в режиме «Тест цепи»
  const probeData = useMemo(() => {
    if (tool !== 'probe') return null;
    return { flat: expanded, comp: copperComponents(doc.entities) };
  }, [expanded, doc.entities, tool]);
  // если инструмент сменили напрямую (установка компонента, импорт макроса) — подсветку снять
  useEffect(() => { if (tool !== 'probe') setProbe(null); }, [tool]);
  useEffect(() => {
    fetch('/version')
      .then((r) => r.json())
      .then((v) => setAppVer(v && (v.short || v.sha) ? `${v.short}${v.built ? ' от ' + new Date(v.built).toLocaleDateString('ru-RU') : ''}` : null))
      .catch(() => setAppVer(null));
  }, []);

  const past = useRef<M.Doc[]>([]);
  const future = useRef<M.Doc[]>([]);
  const drag = useRef<Drag | null>(null);
  const [dragTick, setDragTick] = useState(0);
  const dragTickRef = useRef(0);
  dragTickRef.current = dragTick;
  const clipboard = useRef<M.Entity[]>([]);
  // группы, целиком попавшие в буфер обмена: вставляются вместе с элементами
  const clipboardGroups = useRef<M.Group[]>([]);
  // группы шаблона вставки (id совпадают с pasteTpl)
  const pasteGroups = useRef<M.Group[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  // слои холста: базовый (сетка + плата + выделение), тест цепи и оверлей (черновики,
  // фантомы, перекрестие). Движение мыши перерисовывает только лёгкий оверлей —
  // дорогая база обновляется, лишь когда меняются плата/вид/слои/выделение.
  const baseRef = useRef<HTMLCanvasElement>(null);
  const probeRef = useRef<HTMLCanvasElement>(null);
  const drcRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const baseRaf = useRef(0);
  const overRaf = useRef(0);
  // обработка pointermove не чаще кадра (rAF): мышь шлёт события до 125+ Гц
  const moveRaf = useRef(0);
  const moveData = useRef<{
    px: number; py: number; wx: number; wy: number; rx: number; ry: number; alt: boolean; sh: boolean;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const libFileRef = useRef<HTMLInputElement>(null);
  const genInputRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const selRef = useRef(sel);
  selRef.current = sel;

  const setDefs = useCallback((p: Partial<Defs>) => setDefsState((d) => ({ ...d, ...p })), []);

  // ---------------- группы элементов (см. src/pcb/group.ts) ----------------
  /** индекс «id элемента → группа»: клик по элементу выбирает всю его группу */
  const groupIdx = useMemo(() => groupIndex(doc.groups), [doc]);
  /** группы, которых касается текущее выделение */
  const selGroups = useMemo((): M.Group[] => {
    const out: M.Group[] = [];
    for (const id of sel) {
      const g = groupIdx.get(id);
      if (g && !out.some((x) => x.id === g.id)) out.push(g);
    }
    return out;
  }, [sel, groupIdx]);
  /** группа текущего выделения, если всё выделенное лежит в одной группе */
  const selGroup = selGroups.length === 1 ? selGroups[0] : null;
  /** выделено два элемента и больше — их можно связать в группу */
  const canGroupSel = sel.size >= 2;
  /** сколько групп на плате (для подписи в колонке «Слои») */
  const groupCount = (doc.groups ?? []).length;

  // ---------------- история ----------------
  const commit = useCallback((next: M.Doc) => {
    past.current.push(doc);
    if (past.current.length > historyLimit(doc, prefsRef.current.historyDepth)) past.current.shift();
    future.current = [];
    setDoc(next);
  }, [doc]);

  const pruneSel = useCallback((d: M.Doc) => {
    const ids = new Set(d.entities.map((e) => e.id));
    setSel((s) => new Set([...s].filter((id) => ids.has(id))));
  }, []);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(doc);
    const prev = past.current.pop()!;
    setDoc(prev);
    pruneSel(prev);
    setDraft(null);
    setRouteA(null); setRouteMsg({ msg: '', ok: null });
    // Индекс узла после отмены может указывать на другую геометрию.
    setEditNode(null);
    setTrackMsg({ msg: '', ok: null });
  }, [doc, pruneSel]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(doc);
    const next = future.current.pop()!;
    setDoc(next);
    pruneSel(next);
    setDraft(null);
    setRouteA(null); setRouteMsg({ msg: '', ok: null });
    setEditNode(null);
    setTrackMsg({ msg: '', ok: null });
  }, [doc, pruneSel]);

  // ---------------- автосохранение ----------------
  // Пишет черновик не сразу, а когда правки прекратились: интервал задаётся
  // в настройках («Интервал автосохранения»), выключить — там же.
  useEffect(() => {
    if (!prefs.autosave) return;
    const t = setTimeout(() => {
      if (docRef.current !== doc) return;
      const ric = (globalThis as any).requestIdleCallback as any;
      const save = () => {
        try { (cloudUser ? sessionStorage : localStorage).setItem(draftKey(cloudUser?.id), JSON.stringify(doc)); } catch { /* ignore */ }
      };
      if (ric) ric(save, { timeout: 1000 });
      else save();
    }, prefs.autosaveMs);
    return () => clearTimeout(t);
  }, [doc, cloudUser, prefs.autosave, prefs.autosaveMs]);
  useEffect(() => {
    try { localStorage.setItem(DEFS_KEY, JSON.stringify(defs)); } catch { /* ignore */ }
  }, [defs]);

  // применяем тему: CSS-переменные на <html> + палитра холста + пользовательские цвета
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // «Компактный интерфейс» — плотнее шапка, панели и поля (см. styles.css)
    document.documentElement.dataset.compact = prefs.compactUi ? '1' : '0';
    setCanvasTheme(theme, canvasOverrides(colors, theme));
    applyCustomColors(colors, theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme, colors, prefs.compactUi]);

  // ---------------- размер холста ----------------
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ---------------- fit ----------------
  const fit = useCallback((d?: M.Doc) => {
    const dd = d ?? doc;
    const w = Math.max(dd.w, 1), h = Math.max(dd.h, 1);
    const s = M.clamp(Math.min((size.w - 60) / w, (size.h - 60) / h), 0.2, 120);
    setView((v) => ({
      s,
      ox: v.mir ? (size.w + w * s) / 2 : (size.w - w * s) / 2,
      oy: (size.h + h * s) / 2,
      mir: v.mir,
    }));
  }, [doc, size]);

  useEffect(() => {
    if (!fitted.current && size.w > 100) { fitted.current = true; fit(); }
  }, [size, fit]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  // После обновления страницы безопасно восстанавливаем последний открытый
  // проект. При несовпадении с черновиком вкладки НЕ отправляем его на сервер
  // автоматически: это мог быть изменённый на другом компьютере проект.
  useEffect(() => {
    if (!cloudUser) return;
    let saved: { id: string; version: number } | null = null;
    try {
      const raw = sessionStorage.getItem(openCloudKey(cloudUser.id));
      if (raw) saved = JSON.parse(raw);
    } catch { /* хранилище недоступно */ }
    if (!saved || !/^[0-9a-f-]{36}$/i.test(saved.id)) return;
    const userId = cloudUser.id;
    const generation = restoreGeneration.current;
    let alive = true;
    void cloudApi<{ project: CloudProjectDetail }>(`/projects/${saved.id}`).then(({ project }) => {
      if (!alive || generation !== restoreGeneration.current || activeCloudRef.current) return;
      let hasDraft = false;
      try { hasDraft = !!sessionStorage.getItem(draftKey(userId)); } catch { /* ignore */ }
      const matches = !hasDraft || JSON.stringify(docRef.current) === JSON.stringify(project.document);
      syncedCloudDoc.current = project.document;
      activeCloudRef.current = project; setActiveCloud(project);
      rememberCloud(userId, project);
      if (matches) {
        setDoc(project.document); rememberDraft(userId, project.document);
        setCloudStatus('saved'); setCloudMessage('');
        setTimeout(() => fitRef.current(project.document), 50);
      } else {
        setCloudStatus('conflict');
        setCloudMessage('Черновик этой вкладки отличается от серверной платы. Сохраните копию или загрузите версию с сервера.');
      }
    }).catch((error: unknown) => {
      if (!alive || generation !== restoreGeneration.current) return;
      if (error instanceof CloudError && error.status === 404) rememberCloud(userId, null);
      else { setCloudStatus('error'); setCloudMessage(cloudError(error)); }
    });
    return () => { alive = false; };
  }, [cloudUser]);

  // ---------------- сетка и привязка ----------------
  // настройки сетки живут в общих настройках инструментов (defs), см. ui/grid.tsx
  const gridConf: GridConf = useMemo(() => gridOf(defs), [
    defs.grid, defs.gridUnit, defs.gridStyle, defs.gridDiv, defs.gridMajor,
    defs.gridOx, defs.gridOy, defs.snapOn, defs.snapObj, defs.snapPx,
  ]);
  // точки, к которым «прилипает» курсор при привязке к объектам: концы, середины,
  // центры и пересечения строятся один раз при изменении платы, а не на каждый кадр
  const snapPts = useMemo(
    () => (defs.snapOn && defs.snapObj ? collectSnapTagged(expanded) : null),
    [defs.snapOn, defs.snapObj, expanded],
  );

  const routePrimitives = expanded;
  const trackTerminal = useCallback((w: M.Pt, fine: boolean) => {
    if (fine) return null;
    const starting = draft?.t !== 'track';
    const tolerance = defs.snapPx / Math.max(view.s, 0.01);
    return pickTrackNode(routePrimitives, w, tolerance, {
      layer: starting ? undefined : activeCu, preferredLayer: activeCu, hidden,
    }) ?? pickEndpoint(routePrimitives, w, tolerance, starting ? undefined : activeCu);
  }, [routePrimitives, draft, activeCu, defs.snapPx, view.s, hidden]);

  const snapPt = useCallback((w: M.Pt, fine: boolean): M.Pt => {
    if (fine) return w;                       // Alt — временно без привязки
    if (!defs.snapOn) return w;
    if (snapPts && snapPts.length) {
      const hit = nearestRefPts(snapPts, w, defs.snapPx / Math.max(view.s, 0.01));
      if (hit) return hit;
    }
    return snapPoint(w, gridConf);
  }, [defs.snapOn, defs.snapPx, snapPts, gridConf, view.s]);

  const constrain = useCallback((from: M.Pt, to: M.Pt): M.Pt => {
    if (defs.angle === 'free') return to;
    const step = defs.angle === '45' ? Math.PI / 4 : Math.PI / 2;
    const dx = to.x - from.x, dy = to.y - from.y;
    const ang = Math.atan2(dy, dx);
    const k = Math.round(ang / step);
    const ux = Math.cos(k * step), uy = Math.sin(k * step);
    const len = dx * ux + dy * uy;
    return { x: from.x + ux * len, y: from.y + uy * len };
  }, [defs.angle]);

  const toPx = useCallback((x: number, y: number): { px: number; py: number } => ({
    px: view.ox + x * view.s * (view.mir ? -1 : 1),
    py: view.oy - y * view.s,
  }), [view]);

  const entVisible = useCallback((e: M.Entity): boolean => {
    if (e.kind === 'pad' || e.kind === 'via') return !(hidden.has('k1') && hidden.has('k2'));
    if (e.kind === 'hole') return true;
    if (e.kind === 'comp') return expandComp(e).some((c) => entVisible(c));
    return !hidden.has((e as { layer: M.LayerId }).layer);
  }, [hidden]);

  const hitAt = useCallback((p: M.Pt): string | null => {
    const tol = 3.5 / view.s + 0.05;
    const ents = doc.entities;
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i];
      if (!entVisible(e)) continue;
      if (e.kind === 'comp') {
        if (expandComp(e).some((c) => M.hitEnt(c, p, tol))) return e.id;
      } else if (M.hitEnt(e, p, tol)) return e.id;
    }
    return null;
  }, [doc, entVisible, view.s]);

  // ---------------- правка дорожек звеньями (как в Sprint-Layout) ----------------
  /** Узлы видны только у одиночной выбранной дорожки/полигона. */
  const editEnt = useMemo(() => {
    if (tool !== 'select' || sel.size !== 1) return null;
    const e = doc.entities.find((x) => sel.has(x.id));
    return e && (e.kind === 'track' || e.kind === 'poly') ? e : null;
  }, [doc, sel, tool]);
  const selectedNodeOwner = editEnt?.id ?? null;
  // Смена выделенной дорожки/полигона не должна оставлять индекс узла от предыдущего.
  useEffect(() => { setEditNode(null); }, [selectedNodeOwner]);

  /** индекс узла под курсором (квадратики ~7 px) — null, если рядом узлов нет */
  const findNode = useCallback((ent: M.Entity, p: M.Pt): number | null => {
    if (ent.kind !== 'track' && ent.kind !== 'poly') return null;
    return nodeUnder(ent.pts, p, 7 / view.s);
  }, [view.s]);

  /** допуск попадания в дорожку/полигон: половина ширины меди + несколько пикселей */
  const segTol = useCallback((ent: M.Track | M.Poly): number =>
    (ent.kind === 'track' ? ent.w / 2 : 0.15) + 3.5 / view.s + 0.05, [view.s]);

  /**
   * Поставить новый узел на звено: точка клика привязывается к сетке (Alt — без неё)
   * и проецируется на ломаную, поэтому узел всегда лежит ровно на дорожке.
   * Возвращает индекс узла и документ до/после — чтобы в истории это был один шаг.
   */
  const insertNodeAtEnt = useCallback((ent: M.Track | M.Poly, raw: M.Pt, alt: boolean) => {
    const closed = ent.kind === 'poly';
    const near = nearestOnPts(ent.pts, raw, closed);
    if (!near || near.dist > segTol(ent)) return null;
    // сам узел ставим в проекции привязанной точки — попадание проверяем по raw,
    // иначе при крупной сетке клик по дорожке перестал бы работать
    const sp = snapPt(raw, alt);
    const spot = nearestOnPts(ent.pts, sp, closed) ?? near;
    const ins = insertNode(ent.pts, spot.seg, spot.pt);
    const next = M.cloneDoc(doc);
    const t = next.entities.find((x) => x.id === ent.id);
    if (!t || (t.kind !== 'track' && t.kind !== 'poly')) return null;
    t.pts = ins.pts;
    return { idx: ins.idx, next, added: ins.pts.length !== ent.pts.length };
  }, [doc, snapPt, segTol]);

  /** удалить узел (двойной клик / ПКМ / Del / кнопка справа) — одним действием в истории */
  const deleteEditNode = useCallback((entId: string, idx: number) => {
    const ent = doc.entities.find((x) => x.id === entId);
    if (!ent || (ent.kind !== 'track' && ent.kind !== 'poly')) return;
    const nx = deleteNode(ent.pts, idx, ent.kind === 'poly');
    if (!nx) {
      setTrackMsg({
        msg: ent.kind === 'poly'
          ? 'У полигона минимум 3 вершины — дальше только удалять целиком.'
          : 'У дорожки минимум 2 узла — снимите выбор узла (Esc) и удалите дорожку (Del).',
        ok: false,
      });
      return;
    }
    const nd = M.cloneDoc(doc);
    const t = nd.entities.find((x) => x.id === entId);
    if (t && (t.kind === 'track' || t.kind === 'poly')) t.pts = nx;
    commit(nd);
    setEditNode(null);
    setTrackMsg({ msg: '', ok: null });
  }, [doc, commit]);

  /** двигать выбранный узел числами (поля справа) */
  const patchEditNode = useCallback((x: number, y: number) => {
    if (!editEnt || editNode == null) return;
    const nd = M.cloneDoc(doc);
    const t = nd.entities.find((e) => e.id === editEnt.id);
    if (!t || (t.kind !== 'track' && t.kind !== 'poly') || !t.pts[editNode]) return;
    if (t.kind === 'track') moveTrackNode(nd.entities, t.id, editNode, { x, y });
    else t.pts[editNode] = { x, y };
    commit(nd);
  }, [doc, commit, editEnt, editNode]);

  /** «Разрыв»: вырезать зазор под амперметр в точке клика */
  const cutAt = (w: M.Pt) => {
    const hitId = hitAt(w);
    const hit = hitId ? doc.entities.find((e) => e.id === hitId) : undefined;
    if (!hit || hit.kind !== 'track') {
      setTrackMsg({
        msg: !hit
          ? 'Кликните по дорожке — в этом месте появится зазор.'
          : hit.kind === 'comp'
            ? 'Это деталь: разрыв работает только с дорожками на плате.'
            : 'Разрывать можно только дорожки — кликните по дорожке.',
        ok: false,
      });
      return;
    }
    const gap = Math.max(0.2, defs.cutGap);
    const parts = splitTrackAt(hit, w, gap);
    if (!parts) {
      setTrackMsg({ msg: 'Дорожка короче зазора — резать нечего. Уменьшите зазор справа.', ok: false });
      return;
    }
    const nd = M.cloneDoc(doc);
    nd.entities = nd.entities.filter((e) => e.id !== hit.id);
    const born: M.Entity[] = [];
    const faces: M.Pt[] = [];
    if (parts.left) {
      born.push({ id: M.uid(), kind: 'track', pts: parts.left, w: hit.w, layer: hit.layer });
      faces.push(parts.left[parts.left.length - 1]);
    }
    if (parts.right) {
      born.push({ id: M.uid(), kind: 'track', pts: parts.right, w: hit.w, layer: hit.layer });
      faces.push(parts.right[0]);
    }
    // площадки под провода щупов — на обрезах, смотрящих в зазор
    if (defs.cutPads) for (const f of faces)
      born.push({ id: M.uid(), kind: 'pad', x: f.x, y: f.y, shape: 'round', size: defs.padSize, drill: defs.padDrill });
    nd.entities.push(...born);
    // куски наследуют группу разрезанной дорожки
    const bornTracks = born.filter((e) => e.kind === 'track').map((e) => e.id);
    if (nd.groups) nd.groups = nd.groups.map((g) => (g.ids.includes(hit.id)
      ? { ...g, ids: g.ids.flatMap((id) => (id === hit.id ? bornTracks : [id])) }
      : g));
    nd.groups = pruneGroups(nd.groups, new Set(nd.entities.map((e) => e.id)));
    commit(nd);
    setSel(new Set(born.map((e) => e.id)));
    setTrackMsg({
      msg: `Разрыв готов: зазор ${M.fmt(gap)} мм, кусков: ${bornTracks.length}. Цепляйте амперметр; запаять обратно — инструмент «Пайка» (S).`,
      ok: true,
    });
  };

  /** «Пайка»: соединить два ближайших конца разных дорожек на одном слое */
  const solderAt = (w: M.Pt) => {
    const radius = Math.max(3, defs.cutGap);
    const ends = trackEndsNear(doc.entities.filter(entVisible), w, radius);
    const pair = pickSolderPair(ends);
    if (!pair) {
      const layers = new Set(ends.map((e) => e.ent.layer));
      setTrackMsg({
        msg: ends.length < 2
          ? 'Рядом нет двух концов дорожек — кликните прямо по зазору.'
          : layers.size > 1
            ? 'Ближайшие концы на разных слоях (K1/K2) — спаять можно только один слой.'
            : 'Ближайшие концы принадлежат одной дорожке — нужны концы разных дорожек.',
        ok: false,
      });
      return;
    }
    const [a, b] = pair;
    const pts = joinTrackPts(a.ent, a.end, b.ent, b.end);
    const nd = M.cloneDoc(doc);
    const dead = new Set([a.ent.id, b.ent.id]);
    nd.entities = nd.entities.filter((e) => !dead.has(e.id));
    const merged: M.Track = { id: M.uid(), kind: 'track', pts, w: a.ent.w, layer: a.ent.layer };
    nd.entities.push(merged);
    // спаянная дорожка остаётся в группе, если куски были в группах
    if (nd.groups) {
      const ga = nd.groups.find((g) => g.ids.includes(a.ent.id));
      const gb = nd.groups.find((g) => g.ids.includes(b.ent.id));
      const keep = ga && gb && ga.id === gb.id ? ga.id : (ga ?? gb)?.id;
      nd.groups = nd.groups.map((g) => ({ ...g, ids: g.ids.filter((id) => !dead.has(id)) }));
      if (keep) nd.groups = nd.groups.map((g) => (g.id === keep ? { ...g, ids: [...g.ids, merged.id] } : g));
    }
    nd.groups = pruneGroups(nd.groups, new Set(nd.entities.map((e) => e.id)));
    commit(nd);
    setSel(new Set([merged.id]));
    const added = Math.hypot(a.pt.x - b.pt.x, a.pt.y - b.pt.y);
    setTrackMsg({ msg: `Запаяно: перемычка ${M.fmt(added)} мм на слое ${a.ent.layer.toUpperCase()}.`, ok: true });
  };

  const addEnts = useCallback((ents: M.Entity[], keepTool = true) => {
    const nd = M.cloneDoc(doc);
    nd.entities.push(...ents);
    commit(nd);
    void keepTool;
  }, [doc, commit]);

  // ---------------- черновики дорожек/полигонов ----------------
  const commitTrack = useCallback(() => {
    const d = draft;
    if (!d || d.t !== 'track') return;
    // убрать подряд идущие дубликаты (одинаковые координаты и слой)
    const pts: { x: number; y: number; layer: 'k1' | 'k2' }[] = [];
    for (const p of d.pts) {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6 && last.layer === p.layer) continue;
      pts.push(p);
    }
    if (pts.length >= 2) {
      const ents: M.Entity[] = [];
      // разбить по смене слоя, в точках смены — переходы
      const cuts: number[] = [];
      for (let i = 1; i < pts.length; i++)
        if (pts[i].layer !== pts[i - 1].layer) cuts.push(i);
      const bounds: [number, number][] = [];
      let from = 0;
      for (const c of cuts) { bounds.push([from, c]); from = c; }
      bounds.push([from, pts.length - 1]);
      for (const [a, b] of bounds) {
        const seg: M.Pt[] = [];
        for (let i = a; i <= b; i++) {
          const p = pts[i];
          if (!seg.length || Math.hypot(seg[seg.length - 1].x - p.x, seg[seg.length - 1].y - p.y) > 1e-6)
            seg.push({ x: p.x, y: p.y });
          }
        if (seg.length >= 2)
          ents.push({ id: M.uid(), kind: 'track', pts: seg, w: defs.trackW, layer: pts[a].layer });
      }
      for (const i of cuts)
        ents.push({ id: M.uid(), kind: 'via', x: pts[i].x, y: pts[i].y, size: defs.viaSize, drill: defs.viaDrill });
      if (ents.length) addEnts(ents);
    }
    setDraft(null);
  }, [draft, addEnts, defs.trackW, defs.viaSize, defs.viaDrill]);

  const commitPoly = useCallback(() => {
    const d = draft;
    if (!d || d.t !== 'poly') return;
    const pts: M.Pt[] = [];
    for (const p of d.pts) {
      const last = pts[pts.length - 1];
      if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) continue;
      pts.push(p);
    }
    if (pts.length >= 3)
      addEnts([{ id: M.uid(), kind: 'poly', pts, layer: activeCu }]);
    setDraft(null);
  }, [draft, addEnts, activeCu]);

  const finishOrCancel = useCallback(() => {
    if (editNode != null && tool === 'select') { setEditNode(null); setTrackMsg({ msg: '', ok: null }); return; }
    if (tool === 'route' && routeMode === 'nets' && activeNet) { setActiveNet(null); return; }
    if (routeA) { setRouteA(null); setRouteMsg({ msg: '', ok: null }); return; }
    if (draft?.t === 'track') { commitTrack(); return; }
    if (draft?.t === 'poly') { commitPoly(); return; }
    if (draft) { setDraft(null); return; }
    if (pasteTpl) { setPasteTpl(null); return; }
    if (place) { setPlace(null); return; }
    if (probe) { setProbe(null); return; }
    if (sel.size) { setSel(new Set()); }
    setTrackMsg({ msg: '', ok: null });
  }, [draft, commitTrack, commitPoly, pasteTpl, place, probe, sel.size, routeA, activeNet, routeMode, tool, editNode]);

  const setTool = useCallback((t: ToolId2) => {
    if (t !== tool) { finishOrCancel(); setToolRaw(t); }
    setEditNode(null);
    setTrackMsg({ msg: '', ok: null });
    if (t === 'route') setSel(new Set());
  }, [tool, finishOrCancel]);

  const startBranch = useCallback((node: TrackNodeTerminal) => {
    setToolRaw('track');
    setSel(new Set()); setEditNode(null); drag.current = null;
    setActiveCu(node.layers[0]);
    setDefs({ trackW: node.width });
    setDraft({ t: 'track', pts: [{ x: node.x, y: node.y, layer: node.layers[0] }] });
    setTrackMsg({ msg: '', ok: null });
  }, [setDefs]);

  const branchFromSelectedNode = useCallback(() => {
    if (editEnt?.kind === 'track' && editNode != null && editEnt.pts[editNode])
      startBranch(trackNodeTerminal(editEnt, editNode));
  }, [editEnt, editNode, startBranch]);

  // ---------------- операции с выделением ----------------
  const selBbox = useCallback((): [number, number, number, number] | null => {
    const list = doc.entities.filter((e) => selRef.current.has(e.id)).map(M.entBBox);
    return list.length ? M.unionBBox(list) : null;
  }, [doc]);

  const rotateSel = useCallback(() => {
    const b = selBbox();
    if (!b) return;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const nd = M.cloneDoc(doc);
    nd.entities.forEach((e) => { if (selRef.current.has(e.id)) M.rotateEnt90(e, cx, cy); });
    commit(nd);
  }, [doc, commit, selBbox]);

  const mirrorSel = useCallback(() => {
    const b = selBbox();
    if (!b) return;
    const cx = (b[0] + b[2]) / 2;
    const nd = M.cloneDoc(doc);
    nd.entities.forEach((e) => { if (selRef.current.has(e.id)) M.mirrorEnt(e, cx); });
    commit(nd);
  }, [doc, commit, selBbox]);

  const doDeleteSel = useCallback(() => {
    if (!selRef.current.size) return;
    const nd = M.cloneDoc(doc);
    nd.entities = nd.entities.filter((e) => !selRef.current.has(e.id));
    // группы теряют удалённые элементы; в группе меньше двух элементов смысла нет
    nd.groups = pruneGroups(nd.groups, new Set(nd.entities.map((e) => e.id)));
    commit(nd);
    setSel(new Set());
    setEditNode(null);
  }, [doc, commit]);

  const deleteSel = useCallback(() => {
    if (!selRef.current.size) return;
    // Настройка «Подтверждать удаление»: сначала вопрос, плату трогаем только
    // после ответа — история отмены не замусоривается лишними шагами.
    if (prefsRef.current.confirmDelete) {
      const n = selRef.current.size;
      setConfirmAsk({
        title: 'Удалить выделенное?',
        text: `Будет удалено элементов: ${n}. Действие можно отменить (Ctrl+Z).`,
        ok: 'Удалить',
        onOk: () => { setConfirmAsk(null); doDeleteSel(); },
      });
      return;
    }
    doDeleteSel();
  }, [doDeleteSel]);

  const duplicateSel = useCallback(() => {
    if (!selRef.current.size) return;
    const nd = M.cloneDoc(doc);
    const clones: M.Entity[] = [];
    const idMap = new Map<string, string>();
    for (const e of nd.entities) {
      if (selRef.current.has(e.id)) {
        const c = JSON.parse(JSON.stringify(e)) as M.Entity;
        c.id = M.uid();
        M.translateEnt(c, defs.grid * 2, defs.grid * 2);
        clones.push(c);
        idMap.set(e.id, c.id);
      }
    }
    nd.entities.push(...clones);
    // копия группы едет вместе с копией элементов
    const extra = remapGroups(doc.groups, idMap, ' (копия)');
    if (extra.length) nd.groups = [...(nd.groups ?? []), ...extra];
    commit(nd);
    setSel(new Set(clones.map((c) => c.id)));
  }, [doc, commit, defs.grid]);

  // ---------------- операции с группами ----------------
  /** Связать выделенное в группу (Ctrl+Shift+G). */
  const groupSel = useCallback((): string | null => {
    const r = groupSelection(doc, selRef.current);
    if (!r) return null;
    commit(r.doc);
    setSel(new Set(r.group.ids));
    return r.group.name;
  }, [doc, commit]);

  /** Распустить группу выделенного (Ctrl+Shift+U). */
  const ungroupSel = useCallback((): string[] | null => {
    const r = ungroupSelection(doc, selRef.current);
    if (!r) return null;
    commit(r.doc);
    return r.names;
  }, [doc, commit]);

  /** Распустить одну группу из списка слева. */
  const ungroupOne = useCallback((g: M.Group) => {
    const r = ungroupSelection(doc, g.ids);
    if (r) commit(r.doc);
  }, [doc, commit]);

  /** Распустить все группы на плате. */
  const ungroupAllGroups = useCallback(() => {
    const r = ungroupAll(doc);
    if (r) commit(r.doc);
  }, [doc, commit]);

  const renameGroupCb = useCallback((groupId: string, name: string) => {
    const nd = renameGroup(doc, groupId, name);
    if (nd) commit(nd);
  }, [doc, commit]);

  /** Выделить группу целиком (клик по строке в списке групп). */
  const selectGroup = useCallback((g: M.Group) => {
    const alive = new Set(doc.entities.map((e) => e.id));
    setSel(new Set(g.ids.filter((id) => alive.has(id))));
  }, [doc]);

  const nudge = useCallback((dx: number, dy: number) => {
    if (!selRef.current.size) return;
    const nd = M.cloneDoc(doc);
    nd.entities.forEach((e) => { if (selRef.current.has(e.id)) M.translateEnt(e, dx, dy); });
    commit(nd);
  }, [doc, commit]);

  const patchEnt = useCallback((id: string, patch: Record<string, unknown>) => {
    const nd = M.cloneDoc(doc);
    nd.entities = nd.entities.map((e) => (e.id === id ? ({ ...e, ...patch } as M.Entity) : e));
    commit(nd);
  }, [doc, commit]);

  const setDocSize = useCallback((w: number, h: number) => {
    const nd = M.cloneDoc(doc);
    const outline = nd.entities.find(
      (e) => e.kind === 'rect' && e.layer === 'outline' && !e.filled &&
        Math.abs(e.w - nd.w) < 0.001 && Math.abs(e.h - nd.h) < 0.001,
    );
    nd.w = w; nd.h = h;
    if (outline && outline.kind === 'rect') { outline.w = w; outline.h = h; }
    commit(nd);
  }, [doc, commit]);

  // ---------------- буфер обмена ----------------
  const copySel = useCallback(() => {
    if (!selRef.current.size) return;
    clipboard.current = doc.entities
      .filter((e) => selRef.current.has(e.id))
      .map((e) => JSON.parse(JSON.stringify(e)) as M.Entity);
    // в буфер уходит и группа, если она попала в выделение целиком
    const picked = new Set(clipboard.current.map((e) => e.id));
    clipboardGroups.current = (doc.groups ?? []).filter((g) => g.ids.every((id) => picked.has(id)));
  }, [doc]);

  const startPaste = useCallback(() => {
    if (!clipboard.current.length) return;
    const idMap = new Map<string, string>();
    const tpl = clipboard.current.map((e) => {
      const c = JSON.parse(JSON.stringify(e)) as M.Entity;
      c.id = M.uid();
      idMap.set(e.id, c.id);
      return c;
    });
    pasteGroups.current = remapGroups(clipboardGroups.current, idMap);
    setPasteTpl(tpl);
    setSel(new Set());
  }, []);

  const dropPaste = useCallback((at: M.Pt) => {
    if (!pasteTpl) return;
    const bb = M.unionBBox(pasteTpl.map(M.entBBox));
    const dx = at.x - bb[0], dy = at.y - bb[1];
    const clones: M.Entity[] = [];
    const idMap = new Map<string, string>();
    for (const e of pasteTpl) {
      const c = JSON.parse(JSON.stringify(e)) as M.Entity;
      c.id = M.uid();
      M.translateEnt(c, dx, dy);
      clones.push(c);
      idMap.set(e.id, c.id);
    }
    const nd = M.cloneDoc(doc);
    nd.entities.push(...clones);
    const extra = remapGroups(pasteGroups.current, idMap, ' (копия)');
    if (extra.length) nd.groups = [...(nd.groups ?? []), ...extra];
    commit(nd);
    setSel(new Set(clones.map((c) => c.id)));
    setPasteTpl(null);
  }, [pasteTpl, doc, commit]);

  // ---------------- файл/экспорт ----------------
  const saveFile = useCallback(() => {
    const snapshot = docRef.current;
    const blob = new Blob([JSON.stringify(snapshot, null, 1)], { type: 'application/json' });
    download(`${snapshot.name || 'board'}.laypcb.json`, blob);
  }, []);

  // На общем сервере локальный файл остаётся резервной копией. Новая плата,
  // импорт и открытие другого проекта ОТВЯЗЫВАЮТ текущий ID: иначе автосейв
  // тихо перезапишет чужую плату новым содержимым.
  const prepareReplace = useCallback((): boolean => {
    if (!cloudUser) return true;
    if (savingCloud.current) { alert('Дождитесь окончания сохранения на сервере.'); return false; }
    const current = activeCloudRef.current, snapshot = docRef.current;
    const localWork = !current && (snapshot.entities.length > 1 || snapshot.name !== 'Плата' || snapshot.w !== 100 || snapshot.h !== 80 || !!snapshot.nets?.length);
    if ((current && snapshot !== syncedCloudDoc.current) || localWork) {
      if (!window.confirm('Текущая плата ещё не сохранена в облаке. Скачать её локальную копию и продолжить?')) return false;
      saveFile();
    }
    restoreGeneration.current++;
    rememberCloud(cloudUser.id, null);
    setActiveCloud(null); activeCloudRef.current = null; syncedCloudDoc.current = null;
    setCloudStatus('local'); setCloudMessage('');
    return true;
  }, [cloudUser, saveFile]);

  const saveCloud = useCallback(async (): Promise<void> => {
    if (!cloudUser) return;
    const project = activeCloudRef.current;
    if (!project) { setDialog('cloud'); return; }
    if (cloudStatus === 'conflict') throw new CloudError('Сначала сохраните копию или откройте новую версию с сервера.', 409);
    if (savingCloud.current) throw new CloudError('Сохранение уже выполняется.', 409);
    const snapshot = docRef.current;
    if (snapshot === syncedCloudDoc.current) { setCloudStatus('saved'); return; }
    savingCloud.current = true; setCloudStatus('saving'); setCloudMessage('');
    try {
      const { project: updated } = await cloudApi<{ project: CloudProject }>(`/projects/${project.id}`, 'PUT', {
        name: project.name, document: snapshot, version: project.version,
      });
      syncedCloudDoc.current = snapshot;
      activeCloudRef.current = updated; setActiveCloud(updated);
      rememberCloud(cloudUser.id, updated);
      if (docRef.current === snapshot) rememberDraft(cloudUser.id, snapshot);
      setCloudStatus(docRef.current === snapshot ? 'saved' : 'dirty');
    } catch (error) {
      setCloudStatus(error instanceof CloudError && error.status === 409 ? 'conflict' : 'error');
      setCloudMessage(cloudError(error));
      throw error;
    } finally { savingCloud.current = false; }
  }, [cloudUser, cloudStatus]);

  // После привязки к проекту плата автоматически уходит на сервер через 1.8 с
  // после последнего изменения. Ошибки и конфликты НЕ скрываются и не затираются.
  useEffect(() => {
    if (!cloudUser || !activeCloud || doc === syncedCloudDoc.current || cloudStatus === 'error' || cloudStatus === 'conflict') return;
    if (!savingCloud.current && cloudStatus !== 'dirty') setCloudStatus('dirty');
    const timer = setTimeout(() => { if (!savingCloud.current) void saveCloud().catch(() => {}); }, 1800);
    return () => clearTimeout(timer);
  }, [cloudUser, activeCloud, doc, cloudStatus, saveCloud]);

  useEffect(() => {
    if (!cloudUser) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      rememberDraft(cloudUser.id, docRef.current);
      const hasLocalWork = !activeCloud && (doc.entities.length > 1 || doc.name !== 'Плата');
      if (savingCloud.current || (activeCloud && doc !== syncedCloudDoc.current) || hasLocalWork) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [cloudUser, activeCloud, doc]);

  const createCloud = useCallback(async (name: string): Promise<void> => {
    if (!cloudUser || savingCloud.current) throw new CloudError('Дождитесь окончания сохранения на сервере.', 409);
    restoreGeneration.current++;
    const snapshot = docRef.current;
    savingCloud.current = true; setCloudStatus('saving'); setCloudMessage('');
    try {
      const { project } = await cloudApi<{ project: CloudProject }>('/projects', 'POST', { name, document: snapshot });
      const updatedDoc = snapshot.name === project.name ? snapshot : { ...snapshot, name: project.name };
      syncedCloudDoc.current = updatedDoc;
      activeCloudRef.current = project; setActiveCloud(project);
      rememberCloud(cloudUser.id, project);
      if (docRef.current === snapshot) {
        if (updatedDoc !== snapshot) setDoc(updatedDoc);
        rememberDraft(cloudUser.id, updatedDoc);
      }
      setCloudStatus(docRef.current === snapshot ? 'saved' : 'dirty');
    } catch (error) {
      setCloudStatus('error'); setCloudMessage(cloudError(error)); throw error;
    } finally { savingCloud.current = false; }
  }, [cloudUser]);

  const loadCloud = useCallback(async (project: CloudProject): Promise<boolean> => {
    if (savingCloud.current) throw new CloudError('Дождитесь окончания сохранения на сервере.', 409);
    const { project: latest } = await cloudApi<{ project: CloudProjectDetail }>(`/projects/${project.id}`);
    if (!prepareReplace()) return false;
    past.current = []; future.current = [];
    setDoc(latest.document); syncedCloudDoc.current = latest.document;
    setActiveCloud(latest); activeCloudRef.current = latest;
    if (cloudUser) { rememberDraft(cloudUser.id, latest.document); rememberCloud(cloudUser.id, latest); }
    setCloudStatus('saved'); setCloudMessage('');
    setSel(new Set()); setDraft(null); setRouteA(null); setActiveNet(null);
    setTimeout(() => fit(latest.document), 50);
    return true;
  }, [prepareReplace, fit, cloudUser]);

  const reloadCloud = useCallback(async (): Promise<boolean> => {
    const project = activeCloudRef.current;
    if (!project) return false;
    return loadCloud(project);
  }, [loadCloud]);

  const renameCloud = useCallback(async (project: CloudProject, name: string): Promise<void> => {
    if (savingCloud.current) throw new CloudError('Дождитесь окончания сохранения на сервере.', 409);
    try {
      const { project: renamed } = await cloudApi<{ project: CloudProject }>(`/projects/${project.id}`, 'PATCH', { name, version: project.version });
      if (activeCloudRef.current?.id === project.id) {
        const currentDoc = docRef.current;
        const wasSynced = currentDoc === syncedCloudDoc.current;
        const nextDoc = { ...currentDoc, name: renamed.name };
        if (wasSynced) syncedCloudDoc.current = nextDoc;
        setDoc(nextDoc);
        activeCloudRef.current = renamed; setActiveCloud(renamed);
        if (cloudUser) { rememberCloud(cloudUser.id, renamed); rememberDraft(cloudUser.id, nextDoc); }
        setCloudStatus(wasSynced ? 'saved' : 'dirty');
      }
    } catch (error) {
      if (activeCloudRef.current?.id === project.id && error instanceof CloudError && error.status === 409) {
        setCloudStatus('conflict'); setCloudMessage(cloudError(error));
      }
      throw error;
    }
  }, [cloudUser]);

  const deleteCloud = useCallback(async (project: CloudProject): Promise<void> => {
    if (savingCloud.current) throw new CloudError('Дождитесь окончания сохранения на сервере.', 409);
    await cloudApi(`/projects/${project.id}`, 'DELETE', { version: project.version });
    if (activeCloudRef.current?.id === project.id) {
      if (docRef.current !== syncedCloudDoc.current) saveFile(); // сохранить несохранённую копию перед отвязкой
      if (cloudUser) { rememberCloud(cloudUser.id, null); rememberDraft(cloudUser.id, docRef.current); }
      setActiveCloud(null); activeCloudRef.current = null; syncedCloudDoc.current = null;
      setCloudStatus('local'); setCloudMessage('');
    }
  }, [saveFile, cloudUser]);

  const logoutCloud = useCallback(async () => {
    if (!onLogout) return;
    if (savingCloud.current) throw new CloudError('Дождитесь окончания сохранения на сервере.', 409);
    if ((activeCloud && doc !== syncedCloudDoc.current) || (!activeCloud && (doc.entities.length > 1 || doc.name !== 'Плата'))) {
      if (!window.confirm('Есть несохранённая плата. Скачать локальную копию и выйти?')) return;
      saveFile();
    }
    await onLogout();
    if (cloudUser) {
      rememberCloud(cloudUser.id, null);
      try { sessionStorage.removeItem(draftKey(cloudUser.id)); } catch { /* приватный режим */ }
    }
  }, [cloudUser, onLogout, activeCloud, doc, saveFile]);

  const openFile = useCallback((f: File) => {
    f.arrayBuffer().then((ab) => {
      try {
        if (hasLay6Magic(ab)) {
          // Sprint-Layout: .lay6 — плата. Макросы .lmk платой не хранятся:
          // деталь рисует генератор по строке описания (.lmk грузится в библиотеку)
          const { doc: nd, warnings } = lay6ToDoc(ab);
          if (!prepareReplace()) return;
          if (cloudUser) { past.current = []; future.current = []; setDoc(nd); rememberDraft(cloudUser.id, nd); }
          else commit(nd);
          setSel(new Set());
          setTimeout(() => fit(nd), 50);
          if (warnings.length)
            alert('Файл Sprint-Layout открыт с замечаниями:\n• ' + warnings.slice(0, 6).join('\n• ') + (warnings.length > 6 ? `\n…и ещё ${warnings.length - 6}` : ''));
          return;
        }
        const d = JSON.parse(new TextDecoder().decode(ab));
        if (!d || !Array.isArray(d.entities) || typeof d.w !== 'number')
          throw new Error('формат');
        const nd = d as M.Doc;
        nd.entities.forEach((e) => { if (!e.id) e.id = M.uid(); });
        // группы из чужого файла могут ссылаться на отсутствующие элементы
        if (nd.groups?.length) nd.groups = pruneGroups(nd.groups, new Set(nd.entities.map((e) => e.id)));
        if (!prepareReplace()) return;
        if (cloudUser) { past.current = []; future.current = []; setDoc(nd); rememberDraft(cloudUser.id, nd); }
        else commit(nd);
        setSel(new Set());
        setTimeout(() => fit(nd), 50);
      } catch {
        alert('Не удалось открыть файл: неверный формат проекта.');
      }
    });
  }, [commit, fit, cloudUser, prepareReplace]);

  const exportLay6 = useCallback(() => {
    const base = (doc.name || 'board').replace(/[^\wа-яА-ЯёЁ-]+/g, '_');
    download(`${base}.lay6`, new Blob([docToLay6(doc, expandDoc(doc.entities)).slice().buffer], { type: 'application/octet-stream' }));
  }, [doc]);

  // ---------- личная библиотека: сохранение выделенного, папки, резервная копия ----------

  /** выделенное на плате → деталь в библиотеке (по имени; «Папка/Имя» не нужен — папка выбирается) */
  const saveSelToLibrary = useCallback((name: string, folderId: string | null = null) => {
    const ents = doc.entities.filter((e) => selRef.current.has(e.id));
    if (!ents.length) return;
    const m = makeMacro(name, ents, { folderId });
    patchStore((st) => addMacro(st, m));
    setLibTab('lib');
    setEditId(m.id);
  }, [doc, patchStore]);

  /** то, что нарисовал генератор → деталь в библиотеке */
  const saveGenToLibrary = useCallback((name: string, folderId: string | null) => {
    const d = detailFromGen();
    if (!d) return;
    const m = makeMacro(name, d.ents, { folderId, query: gen.query, bl: d.bl });
    patchStore((st) => addMacro(st, m));
    setEditId(m.id);
    setPlace((prev) => (prev ? { ...prev, macroId: m.id } : prev));
  }, [detailFromGen, gen.query, patchStore]);

  /** «Обновить»: заменяем примитивы сохранённой детали текущей генерацией */
  const updateGenMacro = useCallback(() => {
    if (!editId) return;
    const d = detailFromGen(editId);
    if (!d) return;
    patchStore((st) => updateMacro(st, editId, { ents: d.ents, bl: d.bl, query: gen.query }));
    setPlace((prev) => (prev && prev.macroId === editId ? d : prev));
  }, [detailFromGen, editId, gen.query, patchStore]);

  const exportLibJson = useCallback(() => {
    download('library.json', new Blob([exportJSON(store)], { type: 'application/json' }));
  }, [store]);

  /**
   * Загрузка в свою библиотеку: JSON-бэкап (`library.json`) или макрос `.lmk`
   * из Sprint-Layout — он становится обычной деталью (её можно править и переименовывать).
   */
  const importLibJson = useCallback((f: File) => {
    if (/\.lmk$/i.test(f.name)) {
      f.arrayBuffer().then((ab) => {
        const { ents, warnings } = lmkToEnts(ab);
        if (!ents.length) { alert('В файле нет примитивов — пустой или чужой .lmk.'); return; }
        const name = safeName(f.name.replace(/\.[^.]+$/, ''), 'Деталь из .lmk');
        patchStore((st) => addMacro(st, makeMacro(name, ents, { note: 'импорт из .lmk' })));
        setLibTab('lib');
        alert(`«${name}» — добавлено ${ents.length} примитивов.`
          + (warnings.length ? `\nЗамечания: ${warnings.slice(0, 3).join('; ')}` : ''));
      }).catch(() => alert('Не удалось прочитать .lmk.'));
      return;
    }
    f.text().then((txt) => {
      const r = importJSON(txt, store);
      if (!r.ok) { alert(r.error); return; }
      setStore(r.store);
      saveStore(r.store, cloudUser?.id);
      setLibTab('lib');
      alert(`Загружено деталей: ${r.added}`);
    }).catch(() => alert('Не удалось прочитать файл.'));
  }, [store, patchStore, cloudUser]);

  const exportGerber = useCallback(() => {
    const base = (doc.name || 'board').replace(/[^\wа-яА-ЯёЁ-]+/g, '_');
    download(`${base}_gerber.zip`, makeZip(productionFiles(doc)));
  }, [doc]);

  const exportPng = useCallback((o: ExportPngOpts) => {
    const cv = renderPrint(doc, o.layer, o.mirror, o.dpi, o.drill);
    cv.toBlob((b) => {
      if (b) download(`${doc.name || 'board'}_${o.layer}${o.mirror ? '_зерк' : ''}_${o.dpi}dpi.png`, b);
    }, 'image/png');
  }, [doc]);

  const panelize = useCallback((cols: number, rows: number, gx: number, gy: number) => {
    const nd = M.cloneDoc(doc);
    const copies: M.Entity[] = [];
    const copyGroups: M.Group[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        const idMap = new Map<string, string>();
        for (const e of doc.entities) {
          const k = JSON.parse(JSON.stringify(e)) as M.Entity;
          k.id = M.uid();
          M.translateEnt(k, c * gx, r * gy);
          copies.push(k);
          idMap.set(e.id, k.id);
        }
        // группы размножаются вместе с платой: в каждой ячейке своя копия
        copyGroups.push(...remapGroups(doc.groups, idMap, ` · ячейка ${r * cols + c + 1}`));
      }
    }
    nd.entities.push(...copies);
    if (copyGroups.length) nd.groups = [...(nd.groups ?? []), ...copyGroups];
    nd.w = doc.w + (cols - 1) * gx;
    nd.h = doc.h + (rows - 1) * gy;
    commit(nd);
    setTimeout(() => fit(), 50);
  }, [doc, commit, fit]);

  const newBoardDlg = useCallback((name: string, w: number, h: number) => {
    if (!prepareReplace()) return;
    const next = M.newBoard(w, h, name);
    if (cloudUser) { past.current = []; future.current = []; setDoc(next); rememberDraft(cloudUser.id, next); }
    else commit(next);
    setSel(new Set()); setDraft(null); setRouteA(null);
    setDialog(null);
    setTimeout(() => fit(next), 50);
  }, [commit, fit, cloudUser, prepareReplace]);

  const savePrimary = useCallback(() => {
    if (!cloudUser) { saveFile(); return; }
    if (!activeCloudRef.current || cloudStatus === 'conflict') { setDialog('cloud'); return; }
    void saveCloud().catch(() => setDialog('cloud'));
  }, [cloudUser, cloudStatus, saveCloud, saveFile]);

  // ---------------- указатель ----------------
  const getPos = (e: { clientX: number; clientY: number }) => {
    const r = overRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      // диапазон шире, чем у fit() (0.2…120): иначе после «показать всю плату»
      // для крупной платы колесо вниз давало скачок к 100%
      const ns = M.clamp(v.s * factor, 0.05, 2000);
      const w = toWorld(v, px, py);
      return {
        s: ns,
        ox: px - w.x * ns * (v.mir ? -1 : 1),
        oy: py + w.y * ns,
        mir: v.mir,
      };
    });
  }, []);

  /** Поставить выбранную деталь в точку `at`; возвращает id компонента */
  const addComp = useCallback((at: M.Pt): string | null => {
    if (!place) return null;
    const comp: M.Comp = {
      id: M.uid(), kind: 'comp', lib: '', name: place.name,
      x: at.x, y: at.y, rot: placeRot, side: placeSide,
      bl: place.bl.map((v) => v) as [number, number, number, number],
      ents: place.ents.map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: M.uid() } as M.Entity)),
    };
    addEnts([comp]);
    return comp.id;
  }, [place, placeRot, placeSide, addEnts]);

  // «Добавить на плату» из окна предпросмотра: ставим деталь в центр видимой
  // области (с привязкой к сетке — как при обычном клике) и выделяем, чтобы
  // сразу было видно, куда она всталa.
  const addLibFromPreview = useCallback(() => {
    const id = addComp(snapPt(toWorld(view, size.w / 2, size.h / 2), false));
    if (id) setSel(new Set([id]));
    setPreview(null);
  }, [addComp, snapPt, view, size]);

  // установка из строки генератора: снапшот замирает, чтобы правка строки
  // не «поехала» под курсором
  const placeFromGen = useCallback(() => {
    const d = detailFromGen();
    if (!d) return;
    setPlace(d);
    setToolRaw('comp');
  }, [detailFromGen]);

  const detailFromCatalog = useCallback((selection: CatalogSelection): Detail => {
    const fp = selection.footprint;
    const sizeText = `${M.fmt(fp.bbox[2] - fp.bbox[0])} × ${M.fmt(fp.bbox[3] - fp.bbox[1])} мм`;
    const spec = [
      fp.stats.smd ? `${fp.stats.smd} SMD` : '',
      fp.stats.plated ? `${fp.stats.plated} PTH` : '',
      fp.stats.holes ? `${fp.stats.holes} отверстий` : '',
      sizeText,
    ].filter(Boolean).join(' · ');
    const note = [
      `Источник: ${selection.source || 'PartReel'} (${selection.pageUrl}).`,
      `Лицензия: ${selection.license}; атрибуция: ${selection.source || 'PartReel'}.`,
      selection.verified ? 'Источник помечает запись как verified.' : 'Запись не отмечена как verified.',
      selection.provenance ? `Происхождение: ${selection.provenance}.` : '',
      ...fp.warnings,
      'Проверьте размеры по даташиту перед изготовлением.',
    ].filter(Boolean).join(' ');
    return {
      name: selection.part.name || fp.name,
      ents: libElsToEnts(fp.els),
      bl: libBBox(fp.els),
      spec,
      note,
      query: `${selection.source || 'PartReel'}:${selection.part.id}`,
    };
  }, []);

  const placeFromCatalog = useCallback((selection: CatalogSelection) => {
    setDraft(null);
    setPasteTpl(null);
    setRouteA(null);
    setSel(new Set());
    setPlace(detailFromCatalog(selection));
    setPlaceRot(0);
    setPlaceSide('top');
    setToolRaw('comp');
    setPreview(null);
  }, [detailFromCatalog]);

  const saveCatalogToLibrary = useCallback((selection: CatalogSelection) => {
    const detail = detailFromCatalog(selection);
    const macro = makeMacro(detail.name, detail.ents, { note: detail.note });
    patchStore((st) => addMacro(st, macro));
    setLibTab('lib');
  }, [detailFromCatalog, patchStore]);

  /** деталь из дерева → ставим на плату */
  const pickMacro = useCallback((m: Macro) => {
    setPlace(detailFromMacro(m));
    setToolRaw('comp');
    setPreview(null);
  }, []);

  // имя детали из панели свойств: спрашиваем и складываем выделенное в библиотеку
  const saveSelFromProps = useCallback(() => {
    const n = (window.prompt('Имя детали для личной библиотеки:', 'Деталь') || '').trim();
    if (!n) return;
    const into = editId ? store.macros.find((m) => m.id === editId)?.folderId ?? null : null;
    saveSelToLibrary(n, into);
  }, [editId, saveSelToLibrary, store.macros]);

  /** деталь из дерева → правим строкой генератора (если она была сгенерирована) */
  const editMacro = useCallback((m: Macro) => {
    if (m.query) setQuery(m.query);
    setEditId(m.id);
    setLibTab('gen');
    setPreview(null);
  }, [setQuery]);

  // ---------------- автотрассировка ----------------
  const changeNets = useCallback((nets: M.Net[]) => {
    commit({ ...doc, nets });
    setRouteMsg({ msg: '', ok: null });
  }, [doc, commit]);
  const cancelRouting = useCallback(() => {
    routeWorker.current?.terminate();
    routeWorker.current = null;
    setRouting(null);
    setRouteMsg({ msg: 'Трассировка отменена. Плата не изменена.', ok: null });
  }, []);
  const routeAll = useCallback(() => {
    if (routeWorker.current) return;
    setRouteA(null);
    setActiveNet(null);
    setRouting('Подготовка трассировки…');
    const snapshot = doc;
    try {
      const worker = new Worker(new URL('./pcb/netroute.worker.ts', import.meta.url), { type: 'module' });
      routeWorker.current = worker;
      const finish = () => { worker.terminate(); routeWorker.current = null; setRouting(null); };
      worker.onerror = () => { if (routeWorker.current !== worker) return; finish(); setRouteMsg({ msg: 'Ошибка запуска трассировки. Плата не изменена.', ok: false }); };
      worker.onmessage = (event: MessageEvent) => {
        if (routeWorker.current !== worker) return;
        if (event.data.type === 'progress') { setRouting(event.data.text); return; }
        finish();
        if (event.data.type === 'error') { setRouteMsg({ msg: event.data.text, ok: false }); return; }
        if (docRef.current !== snapshot) { setRouteMsg({ msg: 'Плата была изменена во время расчёта. Запустите трассировку ещё раз.', ok: false }); return; }
        const r = event.data.result as NetRouteVariants;
        if (r.errors.length) { setRouteMsg({ msg: r.errors.join('\n'), ok: false }); return; }
        setRouteVariants({ snapshot, variants: r.variants });
      };
      worker.postMessage({ doc: snapshot, opts: {
        trackW: defs.rtW, clearance: defs.rtClear, holeClear: defs.rtHoleClear,
        viaSize: defs.viaSize, viaDrill: defs.viaDrill, step: defs.rtStep,
        viaCost: defs.rtViaCost, topMul: defs.rtTopMul,
        allowTop: defs.rtAllowTop, angle: defs.rtAngle,
      } });
    } catch {
      routeWorker.current?.terminate(); routeWorker.current = null; setRouting(null);
      setRouteMsg({ msg: 'Не удалось запустить фоновую трассировку. Плата не изменена.', ok: false });
    }
  }, [doc, defs]);
  const applyRouteVariant = (r: NetRouteVariant) => {
    if (!routeVariants) return;
    const { snapshot } = routeVariants;
    setRouteVariants(null);
    if (docRef.current !== snapshot) {
      setRouteMsg({ msg: 'Плата изменилась. Рассчитайте варианты заново.', ok: false }); return;
    }
    if (r.ents.length) commit({ ...snapshot, entities: [...snapshot.entities, ...r.ents] });
    setSel(new Set());
    const details = r.unresolved.map((n) => `«${n.name}»: ${n.missing}`).join('; ');
    const rip = r.rips ? ` Переложено дорожек: ${r.rips}.` : '';
    setRouteMsg({ msg: `«${r.title}». ${r.missing ? `Осталось связей: ${r.missing}.` : 'Все группы соединены.'} Добавлено: ${r.length.toFixed(1)} мм, переходов: ${r.vias}.${rip}` + (details ? `\nНе разведены: ${details}.` : ''), ok: r.missing === 0 });
  };
  const routeClick = useCallback((w: M.Pt, sp: M.Pt) => {
    const tol = defs.snapPx / Math.max(view.s, 0.01);
    let end = pickEndpoint(doc.entities, w, tol);
    if (routeMode === 'nets') {
      const nets = doc.nets ?? [];
      const net = nets.find((n) => n.id === activeNet);
      if (!net) { setRouteMsg({ msg: 'Создайте или выберите группу справа, затем кликните её площадки.', ok: null }); return; }
      if (!end?.entId) { setRouteMsg({ msg: 'Кликните по площадке с медью, SMD или переходу. Крепёжное отверстие не является контактом.', ok: false }); return; }
      const id = end.entId;
      const owner = nets.find((n) => n.id !== net.id && n.pads.includes(id));
      if (owner) { setRouteMsg({ msg: `Эта площадка уже в группе «${owner.name}». Сначала уберите её оттуда.`, ok: false }); return; }
      const pads = net.pads.includes(id) ? net.pads.filter((p) => p !== id) : [...net.pads, id];
      commit({ ...doc, nets: nets.map((n) => n.id === net.id ? { ...n, pads } : n) });
      setRouteMsg({ msg: `«${net.name}»: ${pads.length} площадок. Добавьте остальные или создайте следующую группу.`, ok: null });
      return;
    }
    let base = doc;
    let newPad: M.Pad | null = null;
    if (!end) {
      if (!defs.rtAutoPad) { setRouteMsg({ msg: 'Кликните по площадке, переходу или SMD', ok: false }); return; }
      if (clearanceAt(doc.entities, sp.x, sp.y, defs.padSize / 2) < Math.max(defs.rtClear, defs.rtHoleClear)) {
        setRouteMsg({ msg: 'Здесь нельзя поставить площадку: слишком близко к другой меди', ok: false });
        return;
      }
      newPad = { id: M.uid(), kind: 'pad', x: sp.x, y: sp.y, shape: defs.padShape, size: defs.padSize, drill: defs.padDrill };
      base = M.cloneDoc(doc);
      base.entities.push(newPad);
      end = { x: newPad.x, y: newPad.y, layers: ['k2'], r: newPad.size / 2, entId: newPad.id, tht: true };
    }
    if (!routeA) {
      if (newPad) commit(base);
      setRouteA(end);
      setRouteMsg({ msg: `Первый контакт (${end.kind === 'smd' ? 'SMD' : end.tht ? 'PTH' : 'переход'}, ${end.layers.join('/').toUpperCase()}): ` + M.fmt(end.x) + '; ' + M.fmt(end.y) + ' — выберите вторую', ok: null });
      return;
    }
    const r = autoroute(base.entities, base.w, base.h, routeA, end, {
      trackW: defs.rtW, clearance: defs.rtClear, holeClear: defs.rtHoleClear, viaSize: defs.viaSize, viaDrill: defs.viaDrill,
      step: defs.rtStep, viaCost: defs.rtViaCost, topMul: defs.rtTopMul,
      allowTop: defs.rtAllowTop, angle: defs.rtAngle,
    });
    if (!r.ok) {
      if (newPad) commit(base); // площадку всё равно оставляем
      setRouteMsg({ msg: r.msg, ok: false });
      setRouteA(null);
      return;
    }
    const nd = M.cloneDoc(base);
    nd.entities.push(...r.ents);
    commit(nd);
    setSel(new Set(r.ents.map((x) => x.id)));
    setRouteMsg({ msg: r.msg, ok: r.drc === 0 });
    setRouteA(null);
  }, [view.s, doc, defs, routeA, commit, routeMode, activeNet]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = getPos(e);
    if (e.button === 1) {
      e.preventDefault();
      drag.current = { mode: 'pan', startPx: { x: px, y: py }, view0: view };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const w = toWorld(view, px, py);
    const terminal = tool === 'track' ? trackTerminal(w, e.altKey) : null;
    const sp = terminal ? { x: terminal.x, y: terminal.y } : snapPt(w, e.altKey);

    if (e.button === 2) {
      // ПКМ по узлу выбранной дорожки удаляет узел; в остальных местах — отмена.
      if (editEnt) {
        const ni = findNode(editEnt, w);
        if (ni != null) { deleteEditNode(editEnt.id, ni); return; }
      }
      finishOrCancel(); return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pasteTpl) { dropPaste(sp); return; }

    switch (tool) {
      case 'select': {
        // Узел одиночной дорожки/полигона выбирается и тянется прямо здесь.
        if (editEnt && !e.shiftKey) {
          const ni = findNode(editEnt, w);
          if (ni != null) {
            setEditNode(ni);
            drag.current = { mode: 'node', entId: editEnt.id, idx: ni, doc0: M.cloneDoc(doc), moved: false, startWorld: w };
            break;
          }
        }
        setEditNode(null);
        setTrackMsg({ msg: '', ok: null });
        const hitId = hitAt(w);
        if (hitId) {
          // клик по элементу группы выбирает (и двигает) всю группу
          const grp = groupIdx.get(hitId);
          const members = grp ? grp.ids : [hitId];
          let ns: Set<string>;
          if (e.shiftKey) {
            ns = new Set(sel);
            const has = members.some((id) => ns.has(id));
            for (const id of members) { if (has) ns.delete(id); else ns.add(id); }
          } else {
            ns = sel.has(hitId) ? new Set(sel) : new Set(members);
          }
          setSel(ns);
          if (ns.has(hitId))
            drag.current = { mode: 'move', startWorld: w, doc0: M.cloneDoc(doc), moved: false, dx: 0, dy: 0 };
        } else {
          if (!e.shiftKey) setSel(new Set());
          drag.current = { mode: 'marquee', startWorld: w, curWorld: w };
        }
        break;
      }
      case 'cut': cutAt(w); break;
      case 'solder': solderAt(w); break;
      case 'track': {
        if (!draft || draft.t !== 'track') {
          if (terminal?.kind === 'track') { startBranch(terminal); break; }
          const layer = terminal && !terminal.layers.includes(activeCu) ? terminal.layers[0] : activeCu;
          setActiveCu(layer);
          setDraft({ t: 'track', pts: [{ ...sp, layer }] });
        } else {
          const last = draft.pts[draft.pts.length - 1];
          const next = terminal ? terminalPath(last, sp, defs.angle) : [constrain(last, sp)];
          const points = next.filter(p => Math.hypot(p.x - last.x, p.y - last.y) > 1e-6);
          setDraft({ ...draft, pts: [...draft.pts, ...points.map(p => ({ ...p, layer: activeCu }))] });
        }
        break;
      }
      case 'pad':
        addEnts([{ id: M.uid(), kind: 'pad', x: sp.x, y: sp.y, shape: defs.padShape, size: defs.padSize, drill: defs.padDrill }]);
        break;
      case 'smd':
        addEnts([{ id: M.uid(), kind: 'smd', x: sp.x, y: sp.y, w: defs.smdW, h: defs.smdH, rot: 0, layer: activeCu }]);
        break;
      case 'via':
        addEnts([{ id: M.uid(), kind: 'via', x: sp.x, y: sp.y, size: defs.viaSize, drill: defs.viaDrill }]);
        break;
      case 'hole':
        addEnts([{ id: M.uid(), kind: 'hole', x: sp.x, y: sp.y, d: defs.holeD }]);
        break;
      case 'line': {
        if (!draft || draft.t !== 'line') setDraft({ t: 'line', p1: sp });
        else {
          const p2 = constrain(draft.p1, sp);
          addEnts([{ id: M.uid(), kind: 'line', x1: draft.p1.x, y1: draft.p1.y, x2: p2.x, y2: p2.y, w: defs.lineW, layer: defs.lineLayer }]);
          setDraft(null);
        }
        break;
      }
      case 'rect': {
        if (!draft || draft.t !== 'rect') setDraft({ t: 'rect', p1: sp });
        else {
          const x = Math.min(draft.p1.x, sp.x), y = Math.min(draft.p1.y, sp.y);
          const w2 = Math.abs(sp.x - draft.p1.x), h2 = Math.abs(sp.y - draft.p1.y);
          if (w2 > 0.05 && h2 > 0.05)
            addEnts([{ id: M.uid(), kind: 'rect', x, y, w: w2, h: h2, filled: defs.rectFilled, th: defs.rectTh, layer: defs.rectLayer }]);
          setDraft(null);
        }
        break;
      }
      case 'circle': {
        if (!draft || draft.t !== 'circle') setDraft({ t: 'circle', c: sp });
        else {
          const r = Math.hypot(sp.x - draft.c.x, sp.y - draft.c.y);
          if (r > 0.1)
            addEnts([{ id: M.uid(), kind: 'circle', x: draft.c.x, y: draft.c.y, r, w: defs.circleW, layer: defs.circleLayer }]);
          setDraft(null);
        }
        break;
      }
      case 'fill': {
        setDraft((d) => {
          if (!d || d.t !== 'poly') return { t: 'poly', pts: [sp] };
          return { ...d, pts: [...d.pts, sp] };
        });
        break;
      }
      case 'text': {
        if (defs.text.trim())
          addEnts([{
            id: M.uid(), kind: 'text', x: sp.x, y: sp.y, size: defs.textSize, th: defs.textTh,
            rot: defs.textRot, text: defs.text, mirror: defs.textMirror, layer: defs.textLayer,
          }]);
        break;
      }
      case 'ruler': {
        setDraft((d) => {
          if (!d || d.t !== 'ruler' || d.pts.length >= 2) return { t: 'ruler', pts: [sp] };
          return { ...d, pts: [...d.pts, sp] };
        });
        break;
      }
      case 'dim': {
        // три клика: первая точка → вторая точка → смещение размерной линии
        const d = draft && draft.t === 'dim' ? draft : null;
        if (!d) { setDraft({ t: 'dim', p1: sp, p2: null }); break; }
        if (!d.p2) { setDraft({ ...d, p2: sp }); break; }
        const mode = defs.dimMode;
        let off: number;
        if (mode === 'horiz') off = sp.y - (d.p1.y + d.p2.y) / 2;
        else if (mode === 'vert') off = sp.x - (d.p1.x + d.p2.x) / 2;
        else {
          // смещение вдоль нормали к p1→p2
          const ddx = d.p2.x - d.p1.x, ddy = d.p2.y - d.p1.y;
          const L = Math.hypot(ddx, ddy) || 1;
          const nx = -ddy / L, ny = ddx / L;
          const mx = (d.p1.x + d.p2.x) / 2, my = (d.p1.y + d.p2.y) / 2;
          off = (sp.x - mx) * nx + (sp.y - my) * ny;
        }
        if (Math.hypot(d.p2.x - d.p1.x, d.p2.y - d.p1.y) > 0.01) {
          addEnts([{
            id: M.uid(), kind: 'dim',
            x1: d.p1.x, y1: d.p1.y, x2: d.p2.x, y2: d.p2.y,
            off, th: defs.dimTh, size: defs.dimSize, mode, layer: defs.dimLayer,
          }]);
        }
        setDraft({ t: 'dim', p1: sp, p2: null });
        break;
      }
      case 'comp': addComp(sp); break;
      case 'route': routeClick(w, sp); break;
      case 'probe': {
        // «Тест цепи»: подсветить всю электрически связанную медь под курсором
        const hitId = hitAt(w);
        if (!hitId) { setProbe(null); break; }
        const pd = probeData;
        if (!pd) break;
        // компоненты: id подэлементов вида «compId:idx»
        const keys = new Set<string>();
        for (const s of pd.flat) {
          if (s.id !== hitId && !s.id.startsWith(hitId + ':')) continue;
          const k = pd.comp.get(s.id);
          if (k) keys.add(k);
        }
        if (!keys.size) { setProbe(null); break; } // клик не по меди (шелкография, текст…)
        const ents = new Set<string>();
        let pads = 0, smd = 0, vias = 0, tracks = 0;
        for (const e of pd.flat) {
          const k = pd.comp.get(e.id);
          if (!k || !keys.has(k)) continue;
          ents.add(e.id);
          if (e.kind === 'pad') pads++;
          else if (e.kind === 'smd') smd++;
          else if (e.kind === 'via') vias++;
          else if (e.kind === 'track') tracks++;
        }
        setProbe({ entId: hitId, ents, pads, smd, vias, tracks });
        break;
      }
    }
  };

  // Применение последнего движения мыши: состояние курсора и drag-операции
  // обновляются одним пакетом не чаще раза в кадр (см. onPointerMove).
  const flushMove = useCallback(() => {
    moveRaf.current = 0;
    const m = moveData.current;
    if (!m) return;
    setMouse({ ...m });
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView({ ...d.view0, ox: d.view0.ox + (m.px - d.startPx.x), oy: d.view0.oy + (m.py - d.startPx.y) });
    } else if (d.mode === 'move') {
      const mdx = m.rx - d.startWorld.x, mdy = m.ry - d.startWorld.y;
      if (!d.moved && Math.hypot(mdx, mdy) * view.s < 4) return;
      let sdx = m.alt ? mdx : M.snap(mdx, defs.grid);
      let sdy = m.alt ? mdy : M.snap(mdy, defs.grid);
      if (!m.alt && defs.snapOn && defs.snapObj) {
        // «умные» направляющие: край/центр выделения прилипает к краям и центрам соседей
        if (!d.statics) {
          const others = d.doc0.entities.filter((e) => !selRef.current.has(e.id));
          d.statics = collectSnapTagged(others, false);
        }
        const box = selBBox(d.doc0.entities, selRef.current);
        if (box) {
          const tol = 8 / Math.max(view.s, 0.01);
          const res = alignSnap(box, sdx, sdy, d.statics, tol);
          sdx = res.dx; sdy = res.dy;
          d.guides = res.guides;
        }
      } else {
        d.guides = undefined;
      }
      const first = !d.moved;
      d.moved = true;
      d.dx = sdx; d.dy = sdy;
      if (first) {
        // первый сдвиг — прячем оригинал из базы, теперь рисуем только превью в оверлее
        setDragTick(t => t + 1);
      }
      // превью рисуется в оверлее, документ не клонируем каждый кадр — меньше фризов
    } else if (d.mode === 'node') {
      const mdx = m.rx - d.startWorld.x, mdy = m.ry - d.startWorld.y;
      if (!d.moved && Math.hypot(mdx, mdy) * view.s < 4) return;
      let target = snapPt({ x: m.rx, y: m.ry }, m.alt);
      if (m.sh) {
        const origin = d.doc0.entities.find((x) => x.id === d.entId);
        const start = origin && (origin.kind === 'track' || origin.kind === 'poly') ? origin.pts[d.idx] : null;
        if (start) target = Math.abs(mdx) >= Math.abs(mdy) ? { x: target.x, y: start.y } : { x: start.x, y: target.y };
      }
      const first = !d.moved;
      d.moved = true;
      d.preview = target;
      if (first) setDragTick(t => t + 1);
    }
  }, [view.s, defs.grid, snapPt]);

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = getPos(e);
    const w = toWorld(view, px, py);
    const terminal = tool === 'track' ? trackTerminal(w, e.altKey) : null;
    const sp = terminal ? { x: terminal.x, y: terminal.y } : snapPt(w, e.altKey);
    moveData.current = { px, py, wx: sp.x, wy: sp.y, rx: w.x, ry: w.y, alt: e.altKey, sh: e.shiftKey };
    const d = drag.current;
    // рамку выделения обновляем синхронно — её читает onPointerUp
    if (d && d.mode === 'marquee') d.curWorld = w;
    if (!moveRaf.current) moveRaf.current = requestAnimationFrame(flushMove);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // дожидаться кадра нельзя: применяем последнее движение сразу
    if (moveRaf.current) { cancelAnimationFrame(moveRaf.current); flushMove(); }
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'move' && d.moved) {
      past.current.push(d.doc0);
      if (past.current.length > historyLimit(d.doc0, prefsRef.current.historyDepth)) past.current.shift();
      future.current = [];
      // финальный коммит — только один раз, а не каждый кадр
      const nd = M.cloneDoc(d.doc0);
      nd.entities.forEach((ent) => {
        if (selRef.current.has(ent.id)) M.translateEnt(ent, d.dx, d.dy);
      });
      setDoc(nd);
      setDragTick(t => t + 1);
    } else if (d.mode === 'node' && d.moved && d.preview) {
      past.current.push(d.doc0);
      if (past.current.length > historyLimit(d.doc0, prefsRef.current.historyDepth)) past.current.shift();
      future.current = [];
      const nd = M.cloneDoc(d.doc0);
      const t = nd.entities.find((x) => x.id === d.entId);
      if (t && (t.kind === 'track' || t.kind === 'poly') && t.pts[d.idx]) {
        if (t.kind === 'track') moveTrackNode(nd.entities, t.id, d.idx, d.preview);
        else t.pts[d.idx] = d.preview;
        setDoc(nd);
      }
      setDragTick(t => t + 1);
    } else if (d.mode === 'marquee') {
      const x1 = Math.min(d.startWorld.x, d.curWorld.x), x2 = Math.max(d.startWorld.x, d.curWorld.x);
      const y1 = Math.min(d.startWorld.y, d.curWorld.y), y2 = Math.max(d.startWorld.y, d.curWorld.y);
      if ((x2 - x1) * view.s > 4 || (y2 - y1) * view.s > 4) {
        const ns = new Set<string>();
        for (const ent of doc.entities) {
          if (!entVisible(ent)) continue;
          const b = M.entBBox(ent);
          if (b[0] <= x2 && b[2] >= x1 && b[1] <= y2 && b[3] >= y1) ns.add(ent.id);
        }
        // группа попадает в рамку целиком: достаточно задеть один её элемент
        const full = expandSelection(doc.groups, ns);
        if (e.shiftKey) setSel((s) => new Set([...s, ...full]));
        else setSel(full);
      }
    }
  };

  /** Двойной клик по звену добавляет узел, по существующему узлу — удаляет. */
  const onDblClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (draft?.t === 'track') { commitTrack(); return; }
    if (draft?.t === 'poly') { commitPoly(); return; }
    if (tool !== 'select') return;

    const { px, py } = getPos(e);
    const p = toWorld(view, px, py);
    const isSeg = (en?: M.Entity | null): en is M.Track | M.Poly =>
      !!en && (en.kind === 'track' || en.kind === 'poly');
    const hitId = hitAt(p);
    const hit = hitId ? doc.entities.find((x) => x.id === hitId) : undefined;
    // Выбранная дорожка остаётся доступной даже под деталями на плате.
    const target: M.Track | M.Poly | null = isSeg(hit) ? hit : editEnt;
    if (!target || sel.size !== 1 || !sel.has(target.id)) return;

    const act = nodeAction(target.pts, p, {
      closed: target.kind === 'poly',
      hitTol: segTol(target),
      nodeTol: 7 / view.s,
    });
    if (!act) return;

    if (act.kind === 'delete') { deleteEditNode(target.id, act.idx); return; }
    if (act.kind !== 'insert') return;
    const ins = insertNodeAtEnt(target, p, e.altKey);
    if (!ins) return;
    setEditNode(ins.idx);
    if (ins.added) commit(ins.next);
    setTrackMsg({ msg: NODE_HINT, ok: true });
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    // Настройки: колесом можно не масштабировать, а инвертировать или сменить шаг.
    const p = prefsRef.current;
    if (!p.wheelZoom) return;
    const step = p.zoomStep > 1.01 ? p.zoomStep : 1.28;
    const up = p.invertWheel ? e.deltaY > 0 : e.deltaY < 0;
    const { px, py } = getPos(e);
    zoomAt(px, py, up ? step : 1 / step);
  };

  // ---------------- клавиатура ----------------
  /**
   * «сочетание → действие» из настроек. Пересобирается при смене привязок:
   * пользователь назначает клавишу в окне настроек — и она сразу работает.
   */
  const hotkeyIndex = useMemo(() => reverseHotkeys(prefs.hotkeys), [prefs.hotkeys]);

  const keyHandler = useCallback((e: KeyboardEvent) => {
    if (routeWorker.current) {
      if (e.code === 'Escape') { routeWorker.current.terminate(); routeWorker.current = null; setRouting(null); setRouteMsg({ msg: 'Трассировка отменена. Плата не изменена.', ok: null }); }
      e.preventDefault(); return;
    }
    if (dialog || preview || routeVariants) return;   // окно открыто — плату не трогаем
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;

    // Какое действие стоит за нажатым сочетанием — решает настройка
    // «Горячие клавиши» (окно настроек), а не жёстко прописанный switch.
    const combo = comboOf(e);
    if (!combo) return;
    const action = hotkeyIndex.get(combo);
    if (!action) return;
    e.preventDefault();

    // Инструменты: действие вида tool.<id> — просто переключает инструмент
    if (action.startsWith('tool.')) {
      const id = action.slice(5) as ToolId2;
      if (TOOLS.some((x) => x.id === id)) setTool(id);
      return;
    }

    // сдвиг стрелками: шаг сетки, Shift — в 10 раз больше, Alt — в 10 раз меньше
    const stepNudge = defs.grid * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    // шаг масштабирования — общая настройка (колесо мыши и клавиши ±)
    const zoomStep = prefsRef.current.zoomStep > 1.01 ? prefsRef.current.zoomStep : 1.3;
    const zoomBy = (f: number) => zoomAt(size.w / 2, size.h / 2, f);

    switch (action) {
      // ---------------- файл ----------------
      case 'file.new': setDialog('new'); return;
      case 'file.open': fileRef.current?.click(); return;
      case 'file.save': savePrimary(); return;
      case 'file.export': setDialog('export'); return;
      case 'file.panelize': setDialog('panelize'); return;
      case 'file.autoplace': setDialog('autoplace'); return;
      case 'file.cnc': setDialog('cnc'); return;
      case 'file.inventory': setDialog('inventory'); return;
      case 'file.stats': setDialog('stats'); return;
      case 'file.imgimport': setDialog('imgimport'); return;

      // ---------------- правка ----------------
      case 'edit.undo': undo(); return;
      case 'edit.redo': redo(); return;
      case 'edit.selectAll': setSel(new Set(doc.entities.map((en) => en.id))); return;
      case 'edit.copy': copySel(); return;
      case 'edit.paste': startPaste(); return;
      case 'edit.duplicate': duplicateSel(); return;
      case 'edit.delete':
        // В «Выборе» Del удаляет узел, если он выбран, иначе — элементы.
        if (tool === 'select' && editNode != null && editEnt) deleteEditNode(editEnt.id, editNode);
        else deleteSel();
        return;
      case 'edit.rotate':
        if (place) setPlaceRot((r) => (r + 90) % 360);
        else rotateSel();
        return;
      case 'edit.mirror': mirrorSel(); return;
      case 'edit.side': if (place) setPlaceSide((s) => (s === 'top' ? 'bottom' : 'top')); return;
      case 'edit.group': groupSel(); return;
      case 'edit.ungroup': ungroupSel(); return;
      case 'edit.nudgeLeft': nudge(-stepNudge, 0); return;
      case 'edit.nudgeRight': nudge(stepNudge, 0); return;
      case 'edit.nudgeUp': nudge(0, stepNudge); return;
      case 'edit.nudgeDown': nudge(0, -stepNudge); return;

      // ---------------- вид ----------------
      case 'view.fit': fit(); return;
      case 'view.zoomIn': zoomBy(zoomStep); return;
      case 'view.zoomOut': zoomBy(1 / zoomStep); return;
      case 'view.mirrorView': setView((v) => ({ ...v, mir: !v.mir })); return;
      case 'view.layer': {
        const other: 'k1' | 'k2' = activeCu === 'k1' ? 'k2' : 'k1';
        if (draft?.t === 'track') {
          // точка смены слоя на текущей позиции курсора
          setDraft((d2) => {
            if (!d2 || d2.t !== 'track') return d2;
            return { ...d2, pts: [...d2.pts, { x: mouse.wx, y: mouse.wy, layer: other }] };
          });
        }
        setActiveCu(other);
        return;
      }
      case 'view.gridNext': setDefs({ grid: cycleGrid(defs.grid, 1), gridUnit: defs.gridUnit }); return;
      case 'view.gridPrev': setDefs({ grid: cycleGrid(defs.grid, -1) }); return;
      case 'view.snapToggle': setDefs({ snapOn: !defs.snapOn }); return;
      case 'view.drc': setDefs({ drcEnabled: !defs.drcEnabled }); return;

      // ---------------- окна и программа ----------------
      // I — строка генератора: создать/поправить деталь, не снимая рук с клавиатуры
      case 'gen.focus':
        if (tool !== 'route') {
          setLeftTab('lib'); setLibTab('gen');
          const el = document.getElementById('gen-query') as HTMLInputElement | null;
          el?.focus(); el?.select();
        }
        return;
      case 'app.preview': setDialog('board-preview'); return;
      case 'app.preview2d': setBoardPreviewTab('2d'); setDialog('board-preview'); return;
      case 'app.preview3d': setBoardPreviewTab('3d'); setDialog('board-preview'); return;
      case 'app.theme': setTheme((t) => (t === 'dark' ? 'light' : 'dark')); return;
      case 'app.colors': setDialog('colors'); return;
      case 'app.uib': setDialog('uib'); return;
      case 'app.about': setDialog('about'); return;
      case 'app.tour': setDialog('tour'); return;
      case 'app.settings': setDialog('settings'); return;
      case 'app.cancel': finishOrCancel(); return;
      default: return;
    }
  }, [
    hotkeyIndex, dialog, routeVariants, doc, undo, redo, savePrimary, copySel, startPaste,
    duplicateSel, finishOrCancel, deleteSel, place, preview, rotateSel, mirrorSel, draft,
    activeCu, mouse.wx, mouse.wy, fit, zoomAt, size, nudge, defs.grid, defs.gridUnit,
    defs.snapOn, defs.drcEnabled, setDefs, setTool, groupSel, ungroupSel, tool, editEnt,
    editNode, deleteEditNode, setTheme,
  ]);

  const keyRef = useRef(keyHandler);
  keyRef.current = keyHandler;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---------------- отрисовка ----------------
  // zEnts — плоский список в порядке отрисовки, строится из уже развёрнутых примитивов
  const zEnts = useMemo(() => {
    const under: M.Entity[] = [], over: M.Entity[] = [];
    for (let i = 0; i < expanded.length; i++) {
      const e = expanded[i];
      if (e.kind === 'pad' || e.kind === 'via') over.push(e);
      else under.push(e);
    }
    return [...under, ...over];
  }, [expanded]);
  // Габариты всех примитивов одной таблицей: кадр больше не вызывает entBBox
  // на каждый элемент (см. drawFlat/bboxArray в pcb/render.ts).
  const zBoxes = useMemo(() => bboxArray(zEnts), [zEnts]);
  // Во время перетаскивания база рисует плату без выбранных/перетаскиваемых —
  // списки строятся один раз на начало перетаскивания, а не каждый кадр.
  const dragFilter = useMemo(() => {
    const d = drag.current;
    if (!d || d.mode === 'pan' || d.mode === 'marquee' || !d.moved) return null;
    if (d.mode === 'move') {
      const ids = selRef.current;
      return { mode: 'move' as const, ents: zEnts.filter(e => !ids.has(e.id) && !ids.has(e.id.split(':')[0])) };
    }
    if (d.mode === 'node') {
      return { mode: 'node' as const, ents: zEnts.filter(e => e.id !== d.entId && !e.id.startsWith(d.entId + ':')) };
    }
    return null;
    // dragTick меняется на старте/конце перетаскивания — этого достаточно
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zEnts, dragTick, sel]);

  // boardClearance — тяжёлая O(n²) проверка, не должна фризить UI при каждом движении.
  // Делаем её асинхронно с дебаунсом и храним в состоянии, а не в синхронном useMemo.
  const [boardClearance, setBoardClearance] = useState<TrackClearanceViolation[]>([]);
  useEffect(() => {
    if (!defs.drcEnabled) { setBoardClearance([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      // requestIdleCallback если есть, иначе сразу
      const run = () => {
        if (!alive) return;
        try {
          const res = trackClearance(expanded as any, defs.drcClear);
          if (alive) setBoardClearance(res);
        } catch { if (alive) setBoardClearance([]); }
      };
      const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, opts?: any) => number) | undefined;
      if (ric) ric(run, { timeout: 300 });
      else run();
    }, 180);
    return () => { alive = false; clearTimeout(t); };
  }, [expanded, defs.drcEnabled, defs.drcClear]);

  // «Живой» DRC под курсором — самая тяжёлая проверка в кадре. На среднем и
  // слабом профиле обновляем её реже (perfLevel.liveMs), а не каждый кадр
  // движения мыши: подсказка остаётся, но плата не «думает» 60 раз в секунду.
  // Троттлинг включается только когда живая подсказка действительно нужна —
  // в покое никаких таймеров (важно и для батареи, и для тестов).
  const liveNeeded = defs.drcEnabled && draft?.t === 'track' && draft.pts.length > 0;
  const liveCursor = useLiveCursor(mouse, liveNeeded ? perfLevel.liveMs : 0);
  const liveClearance = useMemo(() => {
    if (!defs.drcEnabled || draft?.t !== 'track' || !draft.pts.length) return EMPTY_MARKS;
    const pts = draft.pts, last = pts[pts.length - 1];
    const terminal = trackTerminal({ x: liveCursor.rx, y: liveCursor.ry }, liveCursor.alt);
    const target = terminal ?? { x: liveCursor.wx, y: liveCursor.wy };
    const next = terminal ? terminalPath(last, target, defs.angle) : [constrain(last, target)];
    const tracks: M.Track[] = pts.slice(1).map((p, i) => ({
      id: 'drc-draft', kind: 'track', pts: [pts[i], p], layer: pts[i].layer, w: defs.trackW,
    }));
    tracks.push({ id: 'drc-live', kind: 'track', pts: [last, ...next], layer: activeCu, w: defs.trackW });
    return trackClearance(expanded as any, defs.drcClear, tracks);
  }, [expanded, defs.drcEnabled, defs.drcClear, defs.trackW, defs.angle, draft,
    liveCursor.rx, liveCursor.ry, liveCursor.wx, liveCursor.wy, liveCursor.alt, trackTerminal, constrain, activeCu]);
  // Пустой список — всегда один и тот же объект: холст меток и оверлей не
  // перерисовываются впустую на каждое движение мыши, когда нарушений нет.
  const clearanceMarks = useMemo(() => {
    const list = [...activeClearance(boardClearance, doc.ignoredClearance), ...liveClearance]
      .filter(v => !hidden.has(v.layer));
    return list.length ? list : EMPTY_MARKS;
  }, [boardClearance, liveClearance, hidden, doc.ignoredClearance]);
  const hasClearanceMarks = clearanceMarks.length > 0;

  const outlineKey = useMemo(() => {
    // ключ только по контуру — плата не пересчитывается при движении дорожек
    const ol = zEnts.filter(e => (e as any).layer === 'outline');
    // быстрый хеш: id + координаты, без JSON.stringify всего doc
    let s = '' + ol.length + '|' + doc.w + '|' + doc.h + '|';
    for (let i = 0; i < ol.length; i++) {
      const e = ol[i] as any;
      s += e.id + ':' + (e.kind) + ':' + (e.x ?? '') + ',' + (e.y ?? '') + ',' + (e.x1 ?? '') + ',' + (e.y1 ?? '') + ',' + (e.x2 ?? '') + ',' + (e.y2 ?? '') + ',' + (e.w ?? '') + ',' + (e.h ?? '') + ',' + (e.r ?? '') + ';';
    }
    return s;
  }, [zEnts, doc.w, doc.h]);
  const substrate = useMemo(() => {
    const outlineEnts = zEnts.filter(e => (e as any).layer === 'outline');
    return boardShape(doc, outlineEnts as any);
  }, [outlineKey]);

  // ---------------- отрисовка: базовый слой (сетка + плата) ----------------
  // Перерисовывается только когда меняются плата/вид/слои/выделение/тема —
  // движение мыши базовый слой НЕ трогает (кроме старта/конца перетаскивания).
  // Во время перетаскивания выбранных элементов база рисует плату без них,
  // а превью — в оверлее: меньше клонирований doc и меньше фризов.
  useEffect(() => {
    const cv = baseRef.current;
    if (!cv) return;
    cancelAnimationFrame(baseRaf.current);
    baseRaf.current = requestAnimationFrame(() => {
      baseRaf.current = 0;
      const t0 = performance.now();
      const dpr = perfDpr();
      if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
      if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
      cv.style.width = size.w + 'px';
      cv.style.height = size.h + 'px';
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // фон
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, size.w, size.h);

      // Подложка следует контуру; объекты за краем не скрываем — их можно исправить.
      boardPath(ctx, substrate, p => { const q = toPx(p.x, p.y); return { x: q.px, y: q.py }; });
      ctx.fillStyle = COLORS.board;
      ctx.fill('evenodd');

      // сетка (шаг, вид, подразбиение, «главные» линии и начало — из настроек)
      drawGrid(ctx, gridConf, view, size.w, size.h, {
        minor: COLORS.grid, major: COLORS.gridMajor, origin: COLORS.gridOrigin,
      }, dpr);

      // оси начала координат
      if (defs.showAxes) {
        ctx.strokeStyle = COLORS.axes;
        ctx.lineWidth = 1;
        const o = toPx(0, 0);
        ctx.beginPath();
        if (o.px >= 0 && o.px <= size.w) { ctx.moveTo(o.px + 0.5, 0); ctx.lineTo(o.px + 0.5, size.h); }
        if (o.py >= 0 && o.py <= size.h) { ctx.moveTo(0, o.py + 0.5); ctx.lineTo(size.w, o.py + 0.5); }
        ctx.stroke();
      }

      // документ: примитивы вне видимого прямоугольника не рисуются
      const cA = toWorld(view, 0, 0), cB = toWorld(view, size.w, size.h);
      const clipPad = 4 / view.s + 2;
      const clip = {
        x1: Math.min(cA.x, cB.x) - clipPad, x2: Math.max(cA.x, cB.x) + clipPad,
        y1: Math.min(cA.y, cB.y) - clipPad, y2: Math.max(cA.y, cB.y) + clipPad,
      } as const;
      const dragNow = drag.current;
      if (dragNow?.mode === 'move' && dragNow.moved && dragFilter?.mode === 'move') {
        // во время перетаскивания не рисуем выбранное в базе — оно в оверлее
        drawFlat(ctx, view, dragFilter.ents, hidden, clip);
      } else if (dragNow?.mode === 'node' && dragNow.moved && dragFilter?.mode === 'node') {
        drawFlat(ctx, view, dragFilter.ents, hidden, clip);
      } else {
        drawFlat(ctx, view, zEnts, hidden, clip, zBoxes);
      }

      // выделение
      if (sel.size) {
        ctx.save();
        // один объект настроек на весь список: drawEnt не принимает Set по ссылке,
        // а создавать его для каждого выделенного элемента — лишний мусор в кадре
        const selDraw = { tint: COLORS.sel, alpha: 0.5, hidden: new Set<M.LayerId>() };
        for (const ent of doc.entities) {
          if (!sel.has(ent.id)) continue;
          drawEnt(ctx, view, ent, selDraw);
          const b = M.entBBox(ent);
          const p1 = toPx(b[0], b[1]), p2 = toPx(b[2], b[3]);
          ctx.strokeStyle = COLORS.sel;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.min(p1.px, p2.px) - 2.5, Math.min(p1.py, p2.py) - 2.5,
            Math.abs(p2.px - p1.px) + 5, Math.abs(p2.py - p1.py) + 5);
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // группы: рамка и подпись группы, которой касается выделение
      if (selGroups.length) {
        ctx.save();
        ctx.font = '11px sans-serif';
        for (const g of selGroups) {
          const b = groupBBox(doc, g);
          if (!b) continue;
          const p1 = toPx(b[0], b[1]), p2 = toPx(b[2], b[3]);
          const x = Math.min(p1.px, p2.px) - 7, y = Math.min(p1.py, p2.py) - 7;
          const w = Math.abs(p2.px - p1.px) + 14, h = Math.abs(p2.py - p1.py) + 14;
          ctx.strokeStyle = COLORS.sel;
          ctx.globalAlpha = 0.9;
          ctx.lineWidth = 1.2;
          ctx.setLineDash([7, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.setLineDash([]);
          // имя группы: над рамкой, а если там край холста — под ней
          const label = `${g.name} · ${g.ids.length}`;
          const tw = ctx.measureText(label).width;
          const baseline = y - 6 > 12 ? y - 6 : y + h + 15;
          ctx.globalAlpha = 1;
          ctx.fillStyle = CANVAS_UI.labelBg;
          ctx.fillRect(x, baseline - 11, tw + 10, 14);
          ctx.fillStyle = COLORS.sel;
          ctx.fillText(label, x + 5, baseline);
        }
        ctx.restore();
      }

      // автотрассировка: зоны зазора вокруг отверстий (ближе дорожка не подойдёт)
      if (tool === 'route' && defs.rtHoleClear > 0) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,180,60,.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        for (const e of zEnts) {
          let r = 0;
          if (e.kind === 'pad' && e.drill > 0) r = e.size / 2;
          else if (e.kind === 'via') r = e.size / 2;
          else if (e.kind === 'hole') r = e.d / 2;
          else continue;
          const q = toPx(e.x, e.y);
          const rr = (r + defs.rtHoleClear) * view.s;
          if (q.px < -rr || q.py < -rr || q.px > size.w + rr || q.py > size.h + rr) continue;
          ctx.beginPath(); ctx.arc(q.px, q.py, rr, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.restore();
      }

      // Цветные группы и воздушные связи; это подсказки, не медь.
      if (tool === 'route' && routeMode === 'nets') {
        ctx.save();
        ctx.font = '11px sans-serif';
        (doc.nets ?? []).forEach((net, i) => {
          const points = net.pads.map((id) => netGeometry.ends.get(id)).filter((p): p is RouteEnd => !!p);
          ctx.strokeStyle = ctx.fillStyle = NET_COLORS[i % NET_COLORS.length];
          ctx.globalAlpha = activeNet && activeNet !== net.id ? 0.45 : 0.95;
          ctx.lineWidth = activeNet === net.id ? 2 : 1;
          ctx.setLineDash([4, 5]);
          const first = points[0];
          if (first) for (const p of points.slice(1)) {
            if (netGeometry.comp.get(first.entId!) === netGeometry.comp.get(p.entId!)) continue;
            const a = toPx(first.x, first.y), b = toPx(p.x, p.y);
            ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
          }
          ctx.setLineDash([]);
          for (const p of points) {
            const q = toPx(p.x, p.y), r = Math.max(6, p.r * view.s + 3);
            ctx.beginPath(); ctx.arc(q.px, q.py, r, 0, Math.PI * 2); ctx.stroke();
            ctx.fillText(net.rules?.w !== undefined ? `${net.name} · ${M.fmt(net.rules.w)} мм` : net.name, q.px + r + 3, q.py - r);
          }
        });
        ctx.restore();
      }
      // Сообщаем профилю качества, сколько занял кадр: если стабильно тяжело,
      // уровень опустится сам (см. src/perf.ts).
      noteFrame(performance.now() - t0);
    });
  }, [
    doc, zEnts, substrate, view, hidden, sel, gridConf, defs.showAxes,
    defs.rtHoleClear, size, tool, routeMode, activeNet, netGeometry, theme, colors, toPx,
    selGroups, dragTick, perfLevel.level,
  ]);

  // «Тест цепи»: отдельный слой мигает через CSS, не перерисовывая плату
  // и не пересчитывая связность меди на каждом такте.
  useEffect(() => {
    const cv = probeRef.current;
    if (!cv) return;
    const dpr = perfDpr();
    if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
    if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
    cv.style.width = size.w + 'px';
    cv.style.height = size.h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (tool !== 'probe' || !probe || !probeData) return;
    for (const e of probeData.flat) {
      if (probe.ents.has(e.id)) drawEnt(ctx, view, e, { tint: COLORS.probe });
    }
  }, [probe, probeData, tool, view, size, theme, colors, perfLevel.level]);

  // Предупреждения DRC («зазор дорожек») — отдельный холст между платой и оверлеем.
  // Пересчёт меток идёт по простоям и при правке, а не каждый кадр, поэтому слой
  // перерисовывается только на изменение меток/вида, а мигание делает CSS-анимация
  // (.canvas-drc). Так движение мыши и таймер не гоняют React ради подсветки.
  // DRC — только редактор: в печать, Gerber и ЧПУ метки не попадают.
  useEffect(() => {
    const cv = drcRef.current;
    if (!cv) return;
    const dpr = perfDpr();
    if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
    if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
    cv.style.width = size.w + 'px';
    cv.style.height = size.h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    if (!clearanceMarks.length) return;
    ctx.strokeStyle = '#ff354f';
    ctx.lineWidth = 3;
    for (const mark of clearanceMarks) {
      const a = toPx(mark.a.x, mark.a.y), b = toPx(mark.b.x, mark.b.y);
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
      ctx.beginPath(); ctx.arc((a.px + b.px) / 2, (a.py + b.py) / 2, 8, 0, Math.PI * 2); ctx.stroke();
    }
  }, [clearanceMarks, hasClearanceMarks, view, size, theme, colors, toPx, perfLevel.level]);

  // ---------------- отрисовка: оверлей (черновики, фантомы, перекрестие) ----------------
  // Лёгкий слой поверх платы: обновляется при движении курсора и рисовании,
  // но это несколько штрихов — тяжёлая база при этом не перерисовывается.
  useEffect(() => {
    const cv = overRef.current;
    if (!cv) return;
    cancelAnimationFrame(overRaf.current);
    overRaf.current = requestAnimationFrame(() => {
      overRaf.current = 0;
      const t0 = performance.now();
      const dpr = perfDpr();
      if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
      if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
      cv.style.width = size.w + 'px';
      cv.style.height = size.h + 'px';
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      // Подсветка контакта, к которому привяжется дорожка (включая выводы макросов).
      if ((tool === 'track' || tool === 'route') && mouse.px >= 0 && mouse.py >= 0) {
        const at = { x: mouse.rx, y: mouse.ry };
        const terminal = tool === 'route'
          ? pickEndpoint(routePrimitives, at, defs.snapPx / Math.max(view.s, 0.01))
          : trackTerminal(at, mouse.alt);
        if (terminal) {
          const p = toPx(terminal.x, terminal.y);
          ctx.strokeStyle = COLORS.sel;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.px, p.py, Math.max(6, terminal.r * view.s + 3), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // черновик дорожки
      if (draft?.t === 'track' && draft.pts.length) {
        const pts = draft.pts;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 0; i < pts.length - 1; i++) {
          ctx.strokeStyle = pts[i].layer === 'k1' ? COLORS.k1 : COLORS.k2;
          ctx.lineWidth = Math.max(defs.trackW * view.s, 1);
          const a = toPx(pts[i].x, pts[i].y), b = toPx(pts[i + 1].x, pts[i + 1].y);
          ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
        }
        // резиновый сегмент к курсору
        const last = pts[pts.length - 1];
        const terminal = trackTerminal({ x: mouse.rx, y: mouse.ry }, mouse.alt);
        const target = terminal ?? { x: mouse.wx, y: mouse.wy };
        const next = terminal ? terminalPath(last, target, defs.angle) : [constrain(last, target)];
        const a = toPx(last.x, last.y);
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = Math.max(defs.trackW * view.s, 1);
        ctx.strokeStyle = activeCu === 'k1' ? COLORS.k1 : COLORS.k2;
        ctx.beginPath(); ctx.moveTo(a.px, a.py);
        for (const p of next) { const b = toPx(p.x, p.y); ctx.lineTo(b.px, b.py); }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = CANVAS_UI.ink;
        pts.forEach((p) => {
          const q = toPx(p.x, p.y);
          ctx.fillRect(q.px - 1.5, q.py - 1.5, 3, 3);
        });
      }

      // черновик полигона
      if (draft?.t === 'poly' && draft.pts.length) {
        const pts = [...draft.pts, { x: mouse.wx, y: mouse.wy }];
        ctx.beginPath();
        const p0 = toPx(pts[0].x, pts[0].y);
        ctx.moveTo(p0.px, p0.py);
        for (let i = 1; i < pts.length; i++) {
          const q = toPx(pts[i].x, pts[i].y);
          ctx.lineTo(q.px, q.py);
        }
        const col = activeCu === 'k1' ? COLORS.k1 : COLORS.k2;
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // черновики линий/прямоугольников/окружностей
      if (draft?.t === 'line') {
        const p2 = constrain(draft.p1, { x: mouse.wx, y: mouse.wy });
        const a = toPx(draft.p1.x, draft.p1.y), b = toPx(p2.x, p2.y);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = CANVAS_UI.ink;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (draft?.t === 'rect') {
        const a = toPx(draft.p1.x, draft.p1.y), b = toPx(mouse.wx, mouse.wy);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = CANVAS_UI.ink;
        ctx.strokeRect(Math.min(a.px, b.px), Math.min(a.py, b.py), Math.abs(b.px - a.px), Math.abs(b.py - a.py));
        ctx.setLineDash([]);
      }
      if (draft?.t === 'circle') {
        const a = toPx(draft.c.x, draft.c.y);
        const rr = Math.hypot(mouse.wx - draft.c.x, mouse.wy - draft.c.y);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = CANVAS_UI.ink;
        ctx.beginPath(); ctx.arc(a.px, a.py, rr * view.s, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = CANVAS_UI.labelInk;
        ctx.font = '11px monospace';
        ctx.fillText('R ' + M.fmt(rr), a.px + 10, a.py - 8);
      }

      // линейка
      if (draft?.t === 'ruler' && draft.pts.length) {
        const a0 = draft.pts[0];
        const b0 = draft.pts.length > 1 ? draft.pts[1] : { x: mouse.wx, y: mouse.wy };
        const a = toPx(a0.x, a0.y), b = toPx(b0.x, b0.y);
        ctx.strokeStyle = '#7ac0ff';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
        ctx.setLineDash([]);
        const dx = b0.x - a0.x, dy = b0.y - a0.y;
        const len = Math.hypot(dx, dy);
        const label = `${M.fmt(len)} мм (${M.fmt(M.mm2mil(len), 1)} mil)  Δx ${M.fmt(dx)} Δy ${M.fmt(dy)}`;
        ctx.font = '11px monospace';
        const tw = ctx.measureText(label).width;
        const lx = (a.px + b.px) / 2 + 12, ly = (a.py + b.py) / 2 - 10;
        ctx.fillStyle = CANVAS_UI.labelBg;
        ctx.fillRect(lx - 4, ly - 12, tw + 8, 17);
        ctx.fillStyle = '#7ac0ff';
        ctx.fillText(label, lx, ly);
        [[a.px, a.py], [b.px, b.py]].forEach(([x, y]) => {
          ctx.fillStyle = '#7ac0ff';
          ctx.fillRect(x - 2, y - 2, 4, 4);
        });
      }

      // размерная линия: черновик первых точек и превью готового размера
      if (draft?.t === 'dim') {
        const cur = { x: mouse.wx, y: mouse.wy };
        if (!draft.p2) {
          const a = toPx(draft.p1.x, draft.p1.y), b = toPx(cur.x, cur.y);
          ctx.setLineDash([5, 4]);
          ctx.strokeStyle = CANVAS_UI.ink;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
          ctx.setLineDash([]);
          const len = Math.hypot(cur.x - draft.p1.x, cur.y - draft.p1.y);
          ctx.fillStyle = CANVAS_UI.labelBg;
          ctx.fillRect(b.px + 8, b.py - 16, 74, 15);
          ctx.fillStyle = CANVAS_UI.labelInk;
          ctx.font = '11px monospace';
          ctx.fillText(`${M.fmt(len)} мм`, b.px + 12, b.py - 5);
        } else {
          const mode = defs.dimMode;
          let off: number;
          if (mode === 'horiz') off = cur.y - (draft.p1.y + draft.p2.y) / 2;
          else if (mode === 'vert') off = cur.x - (draft.p1.x + draft.p2.x) / 2;
          else {
            const dx = draft.p2.x - draft.p1.x, dy = draft.p2.y - draft.p1.y;
            const L = Math.hypot(dx, dy) || 1;
            const mx = (draft.p1.x + draft.p2.x) / 2, my = (draft.p1.y + draft.p2.y) / 2;
            off = (cur.x - mx) * (-dy / L) + (cur.y - my) * (dx / L);
          }
          drawEnt(ctx, view, {
            id: 'g', kind: 'dim',
            x1: draft.p1.x, y1: draft.p1.y, x2: draft.p2.x, y2: draft.p2.y,
            off, th: defs.dimTh, size: defs.dimSize, mode, layer: defs.dimLayer,
          }, { alpha: 0.8, hidden: new Set<M.LayerId>() });
        }
      }

      // маркер привязки к объектам: конец/середина/центр/угол/пересечение
      if (snapPts && mouse.px >= 0 && mouse.py >= 0 && !drag.current) {
        const hitSnap = nearestSnap(snapPts, { x: mouse.rx, y: mouse.ry }, defs.snapPx / Math.max(view.s, 0.01));
        if (hitSnap) {
          const q = toPx(hitSnap.x, hitSnap.y);
          const SNAP_LABEL: Record<SnapKind, string> = {
            end: 'конец', mid: 'середина', center: 'центр', corner: 'угол', cross: 'пересечение',
          };
          ctx.strokeStyle = '#7ac0ff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(q.px, q.py - 6); ctx.lineTo(q.px + 6, q.py);
          ctx.lineTo(q.px, q.py + 6); ctx.lineTo(q.px - 6, q.py);
          ctx.closePath();
          ctx.stroke();
          ctx.font = '10px monospace';
          const lbl = SNAP_LABEL[hitSnap.kind];
          const tw = ctx.measureText(lbl).width;
          ctx.fillStyle = CANVAS_UI.labelBg;
          ctx.fillRect(q.px + 9, q.py - 8, tw + 8, 14);
          ctx.fillStyle = '#7ac0ff';
          ctx.fillText(lbl, q.px + 13, q.py + 2);
        }
      }

      // автотрассировка: первая точка и резиновая линия
      if (tool === 'route' && routeA) {
        const a = toPx(routeA.x, routeA.y);
        ctx.strokeStyle = COLORS.sel;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(a.px, a.py, Math.max(routeA.r * view.s + 4, 8), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(mouse.px, mouse.py); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Узлы видны у одиночной выбранной дорожки/полигона в «Выборе».
      {
        const nodeEnt = editEnt;
        if (nodeEnt) {
          const closed = nodeEnt.kind === 'poly';
          // кружок-перекрестие в месте будущего узла, когда курсор над звеном
          if (mouse.px >= 0 && mouse.py >= 0 && !drag.current) {
            const cur = { x: mouse.rx, y: mouse.ry };
            const overNode = nodeEnt.pts.some((q) => Math.hypot(q.x - cur.x, q.y - cur.y) <= 7 / view.s);
            if (!overNode) {
              const near = nearestOnPts(nodeEnt.pts, cur, closed);
              const tol = (nodeEnt.kind === 'track' ? nodeEnt.w / 2 : 0.15) + 3.5 / view.s + 0.05;
              if (near && near.dist <= tol) {
                const q = toPx(near.pt.x, near.pt.y);
                ctx.strokeStyle = COLORS.sel;
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(q.px, q.py, 5, 0, Math.PI * 2); ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(q.px - 9, q.py); ctx.lineTo(q.px - 4, q.py);
                ctx.moveTo(q.px + 4, q.py); ctx.lineTo(q.px + 9, q.py);
                ctx.moveTo(q.px, q.py - 9); ctx.lineTo(q.px, q.py - 4);
                ctx.moveTo(q.px, q.py + 4); ctx.lineTo(q.px, q.py + 9);
                ctx.stroke();
              }
            }
          }
          nodeEnt.pts.forEach((p, i) => {
            const q = toPx(p.x, p.y);
            const isSel = i === editNode;
            const r = isSel ? 5 : 4;
            ctx.fillStyle = isSel ? COLORS.sel : CANVAS_UI.labelBg;
            ctx.strokeStyle = COLORS.sel;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.rect(q.px - r, q.py - r, r * 2, r * 2);
            ctx.fill(); ctx.stroke();
          });
        }
      }

      // «Разрыв»: красный зазор-превью под курсором
      if (tool === 'cut' && mouse.px >= 0 && mouse.py >= 0 && !drag.current) {
        const cur = { x: mouse.rx, y: mouse.ry };
        const id = hitAt(cur);
        const ent = id ? doc.entities.find((e) => e.id === id) : undefined;
        if (ent && ent.kind === 'track') {
          const gap = Math.max(0.2, defs.cutGap);
          const parts = splitTrackAt(ent, cur, gap);
          ctx.save();
          ctx.strokeStyle = '#ff5a5a';
          ctx.lineWidth = 2;
          if (parts && (parts.left || parts.right)) {
            const marks: M.Pt[] = [];
            if (parts.left) marks.push(parts.left[parts.left.length - 1]);
            if (parts.right) marks.push(parts.right[0]);
            for (const mpt of marks) {
              const q = toPx(mpt.x, mpt.y);
              ctx.beginPath(); ctx.arc(q.px, q.py, 4, 0, Math.PI * 2); ctx.stroke();
            }
            if (marks.length === 2) {
              const a = toPx(marks[0].x, marks[0].y), b = toPx(marks[1].x, marks[1].y);
              ctx.setLineDash([4, 3]);
              ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
              ctx.setLineDash([]);
            }
          } else {
            // резать нечего (дорожка короче зазора) — крест
            const q = toPx(cur.x, cur.y);
            ctx.beginPath();
            ctx.moveTo(q.px - 6, q.py - 6); ctx.lineTo(q.px + 6, q.py + 6);
            ctx.moveTo(q.px + 6, q.py - 6); ctx.lineTo(q.px - 6, q.py + 6);
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // «Пайка»: подсветить концы-кандидаты рядом с курсором
      if (tool === 'solder' && mouse.px >= 0 && mouse.py >= 0 && !drag.current) {
        const cur = { x: mouse.rx, y: mouse.ry };
        const radius = Math.max(3, defs.cutGap);
        const ends = trackEndsNear(doc.entities.filter(entVisible), cur, radius);
        const pair = pickSolderPair(ends);
        ctx.save();
        for (const e of ends.slice(0, 6)) {
          const q = toPx(e.pt.x, e.pt.y);
          const inPair = !!pair && (pair[0] === e || pair[1] === e);
          ctx.strokeStyle = inPair ? '#35c46a' : COLORS.sel;
          ctx.lineWidth = inPair ? 2 : 1.2;
          ctx.beginPath(); ctx.arc(q.px, q.py, inPair ? 7 : 5, 0, Math.PI * 2); ctx.stroke();
        }
        if (pair) {
          const a = toPx(pair[0].pt.x, pair[0].pt.y), b = toPx(pair[1].pt.x, pair[1].pt.y);
          ctx.strokeStyle = '#35c46a';
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.restore();
      }

      // превью перетаскивания выбранных элементов — рисуем в оверлее, а не клонируя doc каждый кадр
      const dragNow = drag.current;
      if (dragNow?.mode === 'move' && dragNow.moved) {
        // сдвиг задаём трансформацией холста: раньше каждый выбранный примитив
        // глубоко клонировался (structuredClone/JSON) на каждом кадре — при
        // выделении сотен элементов это и был главный фриз перетаскивания
        const dxPx = dragNow.dx * view.s * (view.mir ? -1 : 1);
        const dyPx = -dragNow.dy * view.s;
        const dragDraw = { tint: COLORS.sel, alpha: 0.85, hidden: new Set<M.LayerId>() };
        ctx.save();
        ctx.translate(dxPx, dyPx);
        // выбранные — полупрозрачно с цветом выделения, чтобы отличать от оригинала (который скрыт в базе)
        for (const ent of dragNow.doc0.entities) {
          if (!selRef.current.has(ent.id)) continue;
          drawEnt(ctx, view, ent, dragDraw);
        }
        ctx.restore();
        // направляющие выравнивания: тонкие линии к краям/центрам соседей
        if (dragNow.guides?.length) {
          ctx.save();
          ctx.strokeStyle = '#7ac0ff';
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1;
          for (const g of dragNow.guides) {
            ctx.beginPath();
            if (g.axis === 'x') {
              const p = toPx(g.at, 0);
              ctx.moveTo(p.px + 0.5, 0); ctx.lineTo(p.px + 0.5, size.h);
            } else {
              const p = toPx(0, g.at);
              ctx.moveTo(0, p.py + 0.5); ctx.lineTo(size.w, p.py + 0.5);
            }
            ctx.stroke();
          }
          ctx.restore();
        }
      } else if (dragNow?.mode === 'node' && dragNow.moved && dragNow.preview) {
        // клон одной дорожки держим между кадрами: точка меняется на месте,
        // глубокое клонирование на каждый кадр здесь больше не нужно
        let c = dragNow.cache;
        if (!c) {
          const orig = dragNow.doc0.entities.find(x => x.id === dragNow.entId);
          if (orig && (orig.kind === 'track' || orig.kind === 'poly')) {
            const sc = (globalThis as any).structuredClone as (<T>(v:T)=>T)|undefined;
            try { c = sc ? sc(orig) : JSON.parse(JSON.stringify(orig)) as M.Entity; }
            catch { c = JSON.parse(JSON.stringify(orig)) as M.Entity; }
            dragNow.cache = c;
          }
        }
        if (c && (c.kind === 'track' || c.kind === 'poly')) {
          // применяем moveTrackNode логику упрощённо: меняем точку
          const pts = (c as any).pts as M.Pt[];
          if (pts[dragNow.idx]) pts[dragNow.idx] = dragNow.preview;
          drawEnt(ctx, view, c, { tint: COLORS.sel, alpha: 0.9, hidden: new Set<M.LayerId>() });
        }
      }

      // фантомы размещения
      const ghostOpts = { alpha: 0.55, hidden: new Set<M.LayerId>() };
      const pasteOpts = { alpha: 0.55, tint: COLORS.sel, hidden: new Set<M.LayerId>() };
      const ghost = (ent: M.Entity) => drawEnt(ctx, view, ent, ghostOpts);
      if (!sel.size && !drag.current) {
        const at = { x: mouse.wx, y: mouse.wy };
        if (tool === 'pad') ghost({ id: 'g', kind: 'pad', ...at, shape: defs.padShape, size: defs.padSize, drill: defs.padDrill });
        else if (tool === 'via') ghost({ id: 'g', kind: 'via', ...at, size: defs.viaSize, drill: defs.viaDrill });
        else if (tool === 'hole') ghost({ id: 'g', kind: 'hole', ...at, d: defs.holeD });
        else if (tool === 'smd') ghost({ id: 'g', kind: 'smd', ...at, w: defs.smdW, h: defs.smdH, rot: 0, layer: activeCu });
        else if (tool === 'text' && defs.text.trim()) ghost({
          id: 'g', kind: 'text', ...at, size: defs.textSize, th: defs.textTh, rot: defs.textRot,
          text: defs.text, mirror: defs.textMirror, layer: defs.textLayer,
        });
        else if (tool === 'comp' && place) {
          ghost({
            id: 'g', kind: 'comp', lib: '', name: place.name, ...at, rot: placeRot, side: placeSide,
            bl: place.bl, ents: place.ents,
          });
        }
        // буфер вставки: сдвиг задаём трансформацией холста — раньше здесь
        // клонировался каждый примитив через JSON на каждый кадр движения мыши
        if (pasteTpl && pasteBB) {
          const dx = (at.x - pasteBB[0]) * view.s * (view.mir ? -1 : 1);
          const dy = -(at.y - pasteBB[1]) * view.s;
          ctx.save();
          ctx.translate(dx, dy);
          for (let i = 0; i < pasteTpl.length; i++) drawEnt(ctx, view, pasteTpl[i], pasteOpts);
          ctx.restore();
        }
      }

      // рамка выделения
      if (drag.current?.mode === 'marquee') {
        const d = drag.current;
        const a = toPx(d.startWorld.x, d.startWorld.y), b = toPx(d.curWorld.x, d.curWorld.y);
        ctx.fillStyle = 'rgba(79,140,255,.08)';
        ctx.fillRect(Math.min(a.px, b.px), Math.min(a.py, b.py), Math.abs(b.px - a.px), Math.abs(b.py - a.py));
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = COLORS.sel;
        ctx.strokeRect(Math.min(a.px, b.px) + 0.5, Math.min(a.py, b.py) + 0.5, Math.abs(b.px - a.px), Math.abs(b.py - a.py));
        ctx.setLineDash([]);
      }

      // перекрестие курсора (обе части — из настроек «Холст и курсор»)
      if (mouse.px >= 0 && mouse.px <= size.w && mouse.py >= 0 && mouse.py <= size.h) {
        if (prefsRef.current.crosshair) {
          ctx.strokeStyle = CANVAS_UI.crosshair;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, mouse.py + 0.5); ctx.lineTo(size.w, mouse.py + 0.5);
          ctx.moveTo(mouse.px + 0.5, 0); ctx.lineTo(mouse.px + 0.5, size.h);
          ctx.stroke();
        }
        if (!prefsRef.current.cursorLabel) { noteFrame(performance.now() - t0); return; }
        const lbl = `X ${M.fmt(mouse.wx)}  Y ${M.fmt(mouse.wy)}`;
        ctx.font = '10px monospace';
        ctx.fillStyle = CANVAS_UI.labelBg;
        const tw = ctx.measureText(lbl).width;
        ctx.fillRect(mouse.px + 10, mouse.py - 22, tw + 8, 15);
        ctx.fillStyle = CANVAS_UI.labelInk;
        ctx.fillText(lbl, mouse.px + 14, mouse.py - 11);
      }
      noteFrame(performance.now() - t0);
    });
  });

  // ---------------- производные для UI ----------------
  const counts = useMemo(() => {
    const c: Record<string, number> = { k1: 0, k2: 0, s1: 0, s2: 0, outline: 0 };
    const bump = (l: string) => { if (l in c) c[l]++; };
    for (const e of doc.entities) {
      if (e.kind === 'comp') { expandComp(e).forEach((s) => bump((s as { layer?: string }).layer ?? '')); continue; }
      if (e.kind === 'pad' || e.kind === 'via') { c.k1++; c.k2++; continue; }
      if (e.kind === 'hole') continue;
      bump((e as { layer?: string }).layer ?? '');
    }
    return c;
  }, [doc]);

  const selEnts = useMemo(() => doc.entities.filter((e) => sel.has(e.id)), [doc, sel]);
  const toolMeta = TOOLS.find((t) => t.id === tool)!;
  /** Координата в строке состояния: мм, mil или обе системы (настройка «Единицы координат»). */
  const statusCoord = (mm: number): ReactNode => {
    const u = prefs.statusUnits;
    return (
      <>
        <b>{M.fmt(mm)}</b>{u !== 'mil' && ' мм'}
        {u !== 'mm' && <><b> {M.fmt(M.mm2mil(mm), 1)}</b> mil</>}
      </>
    );
  };
  const toggleHidden = useCallback((l: M.LayerId) =>
    setHidden((h) => { const n = new Set(h); if (n.has(l)) n.delete(l); else n.add(l); return n; }), []);

  // настройки боковых колонок — мемо: идентичность объекта не должна меняться каждый кадр
  const sidesConf = useMemo(() => normalizeSides(uiConf.sides), [uiConf]);
  // полный порядок групп тулбара (включая скрытые) — для конструктора интерфейса
  const uiOrder = useMemo(() => {
    const base = (uiConf.ids.length ? uiConf.ids : GROUP_ORDER).filter((id) => GROUP_DEFS.some((g) => g.id === id));
    // группы, появившиеся в новой версии, дописываем в конец: старый сохранённый
    // порядок интерфейса не должен прятать новые кнопки
    const add = GROUP_ORDER.filter((id) => !base.includes(id));
    if (!add.length) return base;
    const tail = base[base.length - 1] === 'about' ? ['about'] : [];
    return [...base.filter((id) => id !== 'about'), ...add, ...tail];
  }, [uiConf]);
  const updButton = upd.Button;
  const closeApplication = useCallback(() => {
    if (cloudUser && (savingCloud.current || (activeCloud && doc !== syncedCloudDoc.current)
      || (!activeCloud && (doc.entities.length > 1 || doc.name !== 'Плата')))) {
      if (!window.confirm('Изменения ещё не сохранены на сервере. Скачать локальную копию и закрыть?')) return;
      saveFile();
    }
    // Синхронно сбрасываем текущую плату перед выходом, не полагаясь на таймер autosave.
    try {
      (cloudUser ? sessionStorage : localStorage).setItem(draftKey(cloudUser?.id), JSON.stringify(doc));
      localStorage.setItem(DEFS_KEY, JSON.stringify(defs));
      saveUi(uiConf);
    } catch { /* приватный режим / переполненное хранилище */ }

    if (window.psbees?.closeApp) {
      window.psbees.closeApp();
      return;
    }

    // В обычной вкладке браузер может запретить закрытие окна, открытого вручную.
    try { window.close(); } catch { /* браузер запрещает закрывать вкладку */ }
    setDialog('close');
  }, [doc, defs, uiConf, cloudUser, activeCloud, saveFile]);

  // ---------------- верхняя панель (одна строка, конструктор интерфейса) ----------------
  // Мемоизирована: движение мыши не пересобирает шапку (в ней, среди прочего,
  // выпадающий список шага сетки почти на сотню позиций). Быстрые кнопки
  // обновления и настройки стоят сразу после стрелок undo/redo.
  const toolbar = useMemo(() => {
    const tb = (
      n: string, title: string, onClick: () => void, opts?: { active?: boolean; disabled?: boolean },
    ) => (
      <button key={n} type="button" className={'tb-btn' + (opts?.active ? ' active' : '')} title={title}
        onClick={onClick} disabled={opts?.disabled}>
        <Ic n={n} />
      </button>
    );

    const groups: Record<string, ReactNode> = {
      file: (
        <div className="tb-group" key="file">
          {tb('new', 'Новая плата', () => setDialog('new'))}
          {tb('open', 'Открыть локальный файл (Ctrl+O)', () => fileRef.current?.click())}
          {tb('save', cloudUser ? 'Сохранить на сервере (Ctrl+S)' : 'Скачать проект (Ctrl+S)', savePrimary)}
          <MenuBtn
            title="Экспорт и операции с платой"
            items={[
              { icon: 'save', label: 'Скачать проект файлом (.laypcb.json)', onClick: saveFile },
              ...(cloudUser ? [{ icon: 'cloud', label: 'Мои облачные проекты…', onClick: () => setDialog('cloud') }] : []),
              { sep: true },
              { icon: 'gerber', label: 'Экспорт Gerber / PNG / ЧПУ…', kbd: 'Ctrl+E', onClick: () => setDialog('export') },
              { icon: 'cnc', label: 'G-code для фрезерного станка…', onClick: () => setDialog('cnc') },
              { icon: 'fit', label: 'Автокомпоновка компонентов…', onClick: () => setDialog('autoplace') },
              { icon: 'panel', label: 'Размножить плату (панелизация)…', onClick: () => setDialog('panelize') },
              { sep: true },
              { icon: 'inventory', label: 'Перечень площадок и отверстий…', onClick: () => setDialog('inventory') },
              { icon: 'inventory', label: 'Статистика платы…', onClick: () => setDialog('stats') },
              { icon: 'png', label: 'Изображение → шелкография…', onClick: () => setDialog('imgimport') },
              { sep: true },
              { icon: 'gear', label: '🎓 Обучение — туры по функциям…', onClick: () => setDialog('tour') },
              { icon: 'gear', label: 'Настройки…', kbd: 'Ctrl+,', onClick: () => setDialog('settings') },
            ]}
          />
        </div>
      ),
      gen: (
        <div className="tb-group" key="gen">
          <button
            type="button"
            className="tb-btn"
            title="Генератор деталей (I): опишите корпус словами — шаг, размер, крепёж, подписи"
            onClick={() => {
              setLeftTab('lib');
              setLibTab('gen');
              const el = document.getElementById('gen-query') as HTMLInputElement | null;
              el?.focus(); el?.select();
            }}
          >
            <Ic n="gen" />
          </button>
          <button
            type="button"
            className="tb-btn wide"
            title="Автокомпоновка компонентов"
            aria-label="Автокомпоновка компонентов"
            onClick={() => setDialog('autoplace')}
          >
            <Ic n="panel" /><span>Компоновка</span>
          </button>
        </div>
      ),
      undo: (
        <div className="tb-group" key="undo">
          {tb('undo', 'Отменить (Ctrl+Z)', undo, { disabled: !past.current.length })}
          {tb('redo', 'Повторить (Ctrl+Y)', redo, { disabled: !future.current.length })}
        </div>
      ),
      group: (
        <div className="tb-group" key="group">
          {tb('group',
            canGroupSel
              ? 'Сгруппировать выделенное (Ctrl+Shift+G): элементы будут выбираться и двигаться вместе'
              : 'Сгруппировать (Ctrl+Shift+G) — выделите два элемента и больше',
            groupSel, { disabled: !canGroupSel })}
          {tb('ungroup',
            selGroups.length
              ? `Разгруппировать ${selGroups.length > 1 ? `выделенные группы (${selGroups.length})` : `«${selGroups[0].name}»`} (Ctrl+Shift+U)`
              : 'Разгруппировать (Ctrl+Shift+U) — в выделении нет групп',
            ungroupSel, { disabled: !selGroups.length })}
        </div>
      ),
      grid: (
        <div className="tb-group" key="grid">
          <GridToolbar
            defs={defs} setDefs={setDefs} scale={view.s}
            onOpen={() => setDialog('grid')}
          />
        </div>
      ),
      layer: (
        <div className="tb-group" key="layer">
          <button type="button" className={'tb-btn cu' + (activeCu === 'k1' ? ' active' : '')}
            style={{ borderColor: COLORS.k1, color: activeCu === 'k1' ? 'var(--text)' : COLORS.k1 }}
            title="Активный слой: верхняя медь (L)" onClick={() => setActiveCu('k1')}>K1</button>
          <button type="button" className={'tb-btn cu' + (activeCu === 'k2' ? ' active' : '')}
            style={{ borderColor: COLORS.k2, color: activeCu === 'k2' ? 'var(--text)' : COLORS.k2 }}
            title="Активный слой: нижняя медь (L)" onClick={() => setActiveCu('k2')}>K2</button>
        </div>
      ),
      view: (
        <div className="tb-group" key="view">
          {tb('zoomin', 'Приблизить (+)', () => zoomAt(size.w / 2, size.h / 2, 1.3))}
          {tb('zoomout', 'Отдалить (−)', () => zoomAt(size.w / 2, size.h / 2, 1 / 1.3))}
          {tb('fit', 'Показать всю плату (F)', () => fit())}
          {tb('mirror', view.mir ? 'Вид снизу — включён' : 'Вид сверху / переключить на вид снизу',
            () => setView((v) => ({ ...v, mir: !v.mir })), { active: view.mir })}
        </div>
      ),
      preview: (
        // одна кнопка вместо трёх: клик открывает окно предпросмотра в том
        // режиме, который смотрели последним, стрелка выбирает 2D или 3D
        <div className="tb-group" key="preview">
          <SplitBtn
            icon="preview"
            title={boardPreviewTab === '3d'
              ? 'Предпросмотр платы: 3D — объёмная плата'
              : 'Предпросмотр платы: 2D — Sprint Layout'}
            menuTitle="Выбрать режим предпросмотра: 2D или 3D"
            onClick={() => setDialog('board-preview')}
            items={[
              { icon: 'preview2d', label: '2D предпросмотр — Sprint Layout', onClick: () => { setBoardPreviewTab('2d'); setDialog('board-preview'); } },
              { icon: 'preview3d', label: '3D предпросмотр — объёмная плата', onClick: () => { setBoardPreviewTab('3d'); setDialog('board-preview'); } },
            ]}
          />
        </div>
      ),
      about: (
        <div className="tb-group" key="about">
          {tb(theme === 'dark' ? 'sun' : 'moon',
            theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
            () => setTheme(theme === 'dark' ? 'light' : 'dark'))}
          {tb('about', 'О программе', () => setDialog('about'))}
          <button type="button" className="tb-btn tour-launch-btn" title="Обучение — короткие туры по функциям приложения" onClick={() => setDialog('tour')}>Обучение</button>
        </div>
      ),
    };

    const quickActions = (
      <div className="tb-group toolbar-quick" key="quick-actions" aria-label="Обновление и настройки интерфейса">
        {!cloudUser && updButton}
        {tb('gear', 'Настройки программы (Ctrl+,) — отдельным окном', () => setDialog('settings'))}
        {tb('uib', 'Конструктор интерфейса', () => setDialog('uib'))}
        {tb('palette', 'Настроить цвета интерфейса', () => setDialog('colors'))}
      </div>
    );

    // порядок групп: сохранённый в localStorage, иначе порядок по умолчанию;
    // инструменты рисования живут в вертикальном доке у холста. Группа undo
    // закреплена и всегда выводит быстрые кнопки сразу после стрелок отмены/повтора.
    const hiddenSet = new Set(uiConf.hidden);
    const order = uiOrder.filter((id) => id !== 'tools' && (!hiddenSet.has(id) || PINNED_GROUPS.includes(id)));
    return (
      <div className="toolbar">
        <div className="brand">
          <span className="brandmark"><BeeMark /></span>
          <span className="brandtext"><b>PS<em>Bees</em></b><small>PCB · LINUX · WINDOWS · SPRINT-LAYOUT</small></span>
        </div>
        {order.map((id) => (
          <Fragment key={id}>
            {groups[id]}
            {id === 'undo' && quickActions}
          </Fragment>
        ))}
        {cloudUser && <div className="tb-group cloud-header-group" aria-label="Облачное хранилище">
          <button className={'tb-btn cloud-header-save ' + cloudStatus} type="button"
            title={`${activeCloud?.name ?? 'Локальный черновик'}: ${cloudSaveLabel(cloudStatus)}${cloudMessage ? ' · ' + cloudMessage : ''}`}
            onClick={() => setDialog('cloud')}><Ic n="cloud" size={17} /><span>{cloudStatus === 'saved' ? 'Сохранено' : cloudStatus === 'saving' ? 'Сохранение…' : cloudStatus === 'conflict' ? 'Конфликт' : cloudStatus === 'error' ? 'Ошибка' : activeCloud ? 'Изменения…' : 'Не в облаке'}</span>
            {cloudStatus === 'saving' && <span className="cloud-btn-bar" />}</button>
          <button className="tb-btn cloud-header-projects" type="button" title="Открыть мои проекты на сервере" onClick={() => setDialog('cloud')}>Проекты</button>
          <button className="tb-btn cloud-header-account" type="button" title={`Учётная запись: ${cloudUser.email}`} onClick={() => setDialog('account')}>
            {cloudUser.email.split('@')[0]}</button>
        </div>}
        <div className="tb-group toolbar-exit" key="exit" aria-label="Выход">
          <button type="button" className="tb-btn close-app" title="Закрыть приложение / сайт"
            aria-label="Закрыть приложение или вкладку" onClick={closeApplication}>
            <Ic n="close" />
          </button>
        </div>
      </div>
    );
  }, [uiConf, uiOrder, defs, view.s, view.mir, activeCu, size, theme, updButton, saveFile, savePrimary,
    cloudUser, activeCloud, cloudStatus, cloudMessage, undo, redo, fit, zoomAt, setDefs, closeApplication,
    // подсказка единой кнопки предпросмотра показывает последний режим
    boardPreviewTab,
    // группировка: доступность и подсказки кнопок зависят от выделения
    sel.size, selGroups, groupSel, ungroupSel]);

  // ---------------- док инструментов у холста ----------------
  // Группа «Инструменты» конструктора интерфейса управляет видимостью дока.
  const showDock = prefs.showDock && !uiConf.hidden.includes('tools');
  const toolDock = useMemo(() => (
    <div className="tool-dock" role="toolbar" aria-label="Инструменты">
      {TOOL_GROUPS.map((grp, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <div className="dock-sep" />}
          {grp.map((id) => {
            const t = TOOLS.find((x) => x.id === id)!;
            const k = TOOL_KEYS[id];
            return (
              <button
                key={id}
                type="button"
                className={'tb-btn dock-btn' + (tool === id && !(id === 'comp' && !place) ? ' active' : '')}
                title={`${t.name}${k ? ` (${k})` : ''} — ${t.hint}`}
                onClick={() => setTool(id)}
              >
                <Ic n={t.icon} />
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  ), [tool, place, setTool]);

  // ---------------- боковые колонки (конструктор интерфейса) ----------------
  // Мемоизированы: при движении мыши колонки не перерисовываются.
  const leftColumn = useMemo(() => {
    const leftTabs: LeftTabId[] = sidesConf.leftTabs.length ? sidesConf.leftTabs : DEFAULT_SIDES.leftTabs;
    // активная вкладка левой колонки: выбранная вручную, если она видна; иначе первая
    const activeLeft: LeftTabId = leftTabs.includes(leftTab) ? leftTab : leftTabs[0];
    const renderLayersPane = () => (
      <>
        <LayersPanel
          activeCu={activeCu} setActiveCu={setActiveCu}
          hidden={hidden} toggleHidden={toggleHidden} counts={counts}
        />
        <div style={{ flex: 1 }} />
        <div className="hint" style={{ padding: '0 12px 10px' }}>
          Плата: {M.fmt(substrate.bounds[2] - substrate.bounds[0])} × {M.fmt(substrate.bounds[3] - substrate.bounds[1])} мм<br />
          {substrate.openChains > 0 && <><span role="status">Контур не замкнут. Соедините концы линий.{substrate.fallback ? ' Пока используется размер рабочего поля.' : ''}</span><br /></>}
          Элементов: {doc.entities.length} · Выделено: {sel.size}
          {groupCount > 0 && <> · Групп: {groupCount}</>}
          <button type="button" className="btn inventory-open" onClick={() => setDialog('inventory')}>Площадки и отверстия…</button>
        </div>
      </>
    );
    const macroCount = store.macros.length;
    const renderGenPane = () => (
      <>
        <div className="tabs lib-tabs">
          <button type="button" className={libTab === 'gen' ? 'on' : ''} onClick={() => setLibTab('gen')}>
            Генератор
          </button>
          <button type="button" className={libTab === 'lib' ? 'on' : ''} onClick={() => setLibTab('lib')}>
            Библиотека{macroCount ? ` (${macroCount})` : ''}
          </button>
          <button type="button" className={libTab === 'catalog' ? 'on' : ''} onClick={() => setLibTab('catalog')}>
            Каталог
          </button>
        </div>
        <div className="pane-scroll">
          {libTab === 'gen' ? (
            <div ref={genInputRef}>
              <GenPanel
                query={query}
                onQuery={setQuery}
                gen={gen}
                store={store}
                source={editId ? store.macros.find((m) => m.id === editId) ?? null : null}
                onPlace={placeFromGen}
                onPreview={() => { const d = detailFromGen(); if (d) setPreview(d); }}
                onSave={saveGenToLibrary}
                onUpdate={editId ? updateGenMacro : undefined}
                onNewFolder={(n) => { patchStore((st) => createFolder(st, n, null)); setLibTab('lib'); }}
              />
            </div>
          ) : libTab === 'lib' ? (
            <>
            {cloudUser && <div className="cloud-library-hint">Детали хранятся только в этом браузере (для вашего аккаунта). Для переноса используйте экспорт/импорт библиотеки.</div>}
            <MacroTree
              store={store}
              tree={tree}
              pickedId={place?.macroId ?? null}
              filter={libFilter}
              onFilter={setLibFilter}
              collapsed={collapsed}
              toggle={(id) => setCollapsed((prev) => {
                const nx = new Set(prev);
                if (nx.has(id)) nx.delete(id); else nx.add(id);
                return nx;
              })}
              onPick={pickMacro}
              onPreview={(m) => setPreview(detailFromMacro(m))}
              onRename={(m, name) => patchStore((st) => updateMacro(st, m.id, { name }))}
              onDelete={(m) => {
                patchStore((st) => removeMacro(st, m.id));
                if (place?.macroId === m.id) setPlace(null);
                if (preview?.macroId === m.id) setPreview(null);
                if (editId === m.id) setEditId(null);
              }}
              onMove={(m, folderId) => patchStore((st) => moveMacro(st, m.id, folderId))}
              onNewFolder={(parentId) => patchStore((st) => createFolder(st, `Папка ${st.folders.length + 1}`, parentId))}
              onRenameFolder={(id, name) => patchStore((st) => renameFolder(st, id, name))}
              onDeleteFolder={(id) => {
                const n = store.macros.filter((m) => m.folderId === id).length;
                if (n && !confirm(`Удалить папку с деталями? Деталей в ней: ${n} (они переедут в корень).`)) return;
                patchStore((st) => removeFolder(st, id, false));
              }}
              onExport={exportLibJson}
              onImport={() => libFileRef.current?.click()}
            />
            </>
          ) : (
            <FootprintCatalog onPlace={placeFromCatalog} onSave={saveCatalogToLibrary} onExport={(selection) => {
              const detail = detailFromCatalog(selection);
              const macro = makeMacro(detail.name, detail.ents, { note: detail.note });
              download(`${selection.part.id}.json`, new Blob([exportJSON({ v: 2, folders: [], macros: [macro] })], { type: 'application/json' }));
            }} />
          )}
        </div>
      </>
    );
    const renderGroupsPane = () => (
      <GroupsPanel
        groups={doc.groups ?? []}
        selGroup={selGroup}
        canGroup={canGroupSel}
        canUngroup={selGroups.length > 0}
        onGroup={() => groupSel()}
        onSelect={selectGroup}
        onUngroup={ungroupOne}
        onUngroupAll={ungroupAllGroups}
        onRename={renameGroupCb}
      />
    );
    return (
      <div className="side" style={{ width: clampW(sidesConf.leftW) }}>
        <div className="pane-full">
          {leftTabs.length > 1 && (
            <div className="tabs">
              {leftTabs.map((t) => (
                <button key={t} type="button" className={activeLeft === t ? 'on' : ''} onClick={() => setLeftTab(t)}>
                  {LEFT_TABS.find((x) => x.id === t)?.label ?? t}
                </button>
              ))}
            </div>
          )}
          {activeLeft === 'layers' ? renderLayersPane()
            : activeLeft === 'lib' ? renderGenPane()
            : renderGroupsPane()}
        </div>
      </div>
    );
  }, [
    sidesConf, leftTab, activeCu, hidden, counts, doc, substrate, sel, place, preview, gen, query, store, tree,
    cloudUser, libTab, libFilter, collapsed, editId, toggleHidden, setQuery, setLeftTab,
    placeFromGen, placeFromCatalog, saveCatalogToLibrary, pickMacro, editMacro, saveGenToLibrary, updateGenMacro, exportLibJson, patchStore,
    // вкладка «Группы»
    groupCount, selGroup, selGroups, canGroupSel, groupSel, selectGroup, ungroupOne, ungroupAllGroups, renameGroupCb,
  ]);

  const rightColumn = useMemo(() => (
    <div className="side right" style={{ width: clampW(sidesConf.rightW) }}>
      <div className="pane-full">
        {tool === 'route' && <>
          <div className="props route-modes">
            <button type="button" className={'btn' + (routeMode === 'pair' ? ' primary' : '')} onClick={() => { setRouteMode('pair'); setRouteA(null); setSel(new Set()); setRouteMsg({ msg: '', ok: null }); }}>Две точки</button>
            <button type="button" className={'btn' + (routeMode === 'nets' ? ' primary' : '')} onClick={() => { setRouteMode('nets'); setRouteA(null); setSel(new Set()); setRouteMsg({ msg: '', ok: null }); }}>Группы / вся плата</button>
          </div>
          {routeMode === 'nets' && <NetsPanel nets={doc.nets ?? []} active={activeNet} setActive={setActiveNet}
            ends={netGeometry.ends} comp={netGeometry.comp} info={routeMsg} onChange={changeNets} onRoute={routeAll}
            defaults={{ w: defs.rtW, clear: defs.rtClear, viaSize: defs.viaSize, viaDrill: defs.viaDrill, allowTop: defs.rtAllowTop }}
            onNew={() => {
              const id = M.uid();
              const used = new Set((doc.nets ?? []).map((n) => n.name));
              let i = 1; while (used.has(`Цепь ${i}`)) i++;
              changeNets([...(doc.nets ?? []), { id, name: `Цепь ${i}`, pads: [] }]);
              setActiveNet(id);
            }} />}
        </>}
        <PropsPanel
          tool={tool} defs={defs} setDefs={setDefs}
          activeCu={activeCu} setActiveCu={setActiveCu}
          selEnts={selEnts} patchEnt={patchEnt}
          doRotate={rotateSel} doMirror={mirrorSel} doDuplicate={duplicateSel} doDelete={deleteSel}
          doc={doc} setDocSize={setDocSize}
          placeName={place?.name ?? null} placeRot={placeRot} placeSide={placeSide}
          setPlaceRot={setPlaceRot} setPlaceSide={setPlaceSide} cancelPlace={() => setPlace(null)}
          onSaveSel={selEnts.length ? saveSelFromProps : undefined}
          selGroup={selGroup}
          onGroup={canGroupSel ? () => groupSel() : undefined}
          onUngroup={selGroup ? () => ungroupSel() : undefined}
          onRenameGroup={renameGroupCb}
          textRot={defs.textRot} setTextRot={(r) => setDefs({ textRot: r })}
          routeGroups={routeMode === 'nets'}
          routeInfo={{ ...routeMsg, msg: routeMode === 'nets' ? '' : routeMsg.msg, picking: routeA ? 'b' : 'a' }}
          editInfo={editEnt ? {
            pts: editEnt.pts.length,
            node: editNode,
            x: editNode != null ? editEnt.pts[editNode]?.x ?? 0 : 0,
            y: editNode != null ? editEnt.pts[editNode]?.y ?? 0 : 0,
          } : null}
          onEditNode={patchEditNode}
          onBranchNode={editEnt?.kind === 'track' && editNode != null ? branchFromSelectedNode : undefined}
          onDeleteEditNode={editEnt && editNode != null ? () => deleteEditNode(editEnt.id, editNode) : undefined}
          toolMsg={trackMsg.msg ? trackMsg : null}
        />
        <div className="props">
          <h3>Контроль зазора дорожек</h3>
          <label><input type="checkbox" checked={defs.drcEnabled}
            onChange={e => setDefs({ drcEnabled: e.target.checked })} /> Подсвечивать нарушения</label>
          <NI label="Минимальный зазор, мм" value={defs.drcClear} min={0} step={0.05}
            on={v => setDefs({ drcClear: v })} />
          <ClearanceExceptions violations={boardClearance} ignored={doc.ignoredClearance ?? []}
            onChange={ignoredClearance => commit({ ...doc, ignoredClearance })}
            onLocate={v => {
              const x = (v.a.x + v.b.x) / 2, y = (v.a.y + v.b.y) / 2;
              setHidden(old => { const next = new Set(old); next.delete(v.layer); return next; });
              setView(old => ({ ...old, ox: size.w / 2 - (old.mir ? -x : x) * old.s, oy: size.h / 2 + y * old.s }));
            }} />
        </div>
        <GridQuickPanel
          defs={defs} setDefs={setDefs} scale={view.s}
          onOpen={() => setDialog('grid')}
        />
      </div>
    </div>
  ), [
    sidesConf, tool, routeMode, activeNet, doc, netGeometry, routeMsg, routeA, defs, activeCu,
    selEnts, place, placeRot, placeSide, view.s, changeNets, routeAll, patchEnt, rotateSel,
    mirrorSel, duplicateSel, deleteSel, setDocSize, setDefs, saveSelFromProps,
    selGroup, canGroupSel, groupSel, ungroupSel, renameGroupCb,
    editEnt, editNode, trackMsg, patchEditNode, deleteEditNode, branchFromSelectedNode, boardClearance, commit, size,
  ]);

  // ---------------- окно настроек (отдельное окно) ----------------
  /**
   * Настоящее отдельное окно: открываем редактор второй раз с хэшем #settings —
   * в браузере это всплывающее окно, в Electron (Windows) — отдельное окно программы.
   * Если всплывающие окна запрещены, настройки просто остаются в текущем окне.
   */
  const openSettingsWindow = useCallback(() => {
    try {
      const w = window.open(`${location.pathname}#settings`, 'psbees-settings', 'width=980,height=700');
      if (w) { setDialog(null); return; }
    } catch { /* всплывающие окна запрещены — останемся в этом окне */ }
    setDialog('settings');
  }, []);

  // Если страницу открыли как «окно настроек» (#settings), сразу показываем их.
  useEffect(() => {
    if (typeof location !== 'undefined' && location.hash === '#settings') setDialog('settings');
  }, []);

  /** Все настройки одним файлом: программа, инструменты, интерфейс, цвета. */
  const exportSettings = useCallback(() => {
    const data = {
      app: 'psbees', kind: 'settings', version: 1,
      prefs, defs, colors, theme,
      ui: { ids: uiConf.ids, hidden: uiConf.hidden, sides: sidesConf },
      presets: userPresets,
    };
    try {
      download('psbees-settings.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    } catch { alert('Не удалось сохранить файл настроек.'); }
  }, [prefs, defs, colors, theme, uiConf, sidesConf, userPresets]);

  const importSettings = useCallback((file: File) => {
    file.text().then((txt) => {
      let ok = false;
      try {
        const d = JSON.parse(txt);
        if (!d || typeof d !== 'object') throw new Error('формат');
        if (d.prefs) { setPrefs({ ...DEFAULT_PREFS, ...d.prefs }); ok = true; }
        if (d.defs) { setDefs({ ...DEFAULT_DEFS, ...d.defs }); ok = true; }
        if (d.ui) {
          persistUi({
            ids: Array.isArray(d.ui.ids) ? d.ui.ids.filter((x: string) => GROUP_DEFS.some((g) => g.id === x)) : [],
            hidden: Array.isArray(d.ui.hidden) ? d.ui.hidden.filter((x: string) => GROUP_DEFS.some((g) => g.id === x)) : [],
            sides: normalizeSides(d.ui.sides),
          });
          ok = true;
        }
        if (d.colors && typeof d.colors === 'object') { setColors(d.colors); ok = true; }
        if (d.theme === 'dark' || d.theme === 'light') { setTheme(d.theme); ok = true; }
        if (d.presets && typeof d.presets === 'object') {
          setUserPresets(mergeUserPresets(loadUserPresets(), normalizeUserPresets(d.presets)));
          ok = true;
        }
      } catch { /* ниже — сообщение */ }
      if (!ok) alert('Не удалось прочитать настройки из файла.');
    }).catch(() => alert('Не удалось прочитать файл.'));
  }, [setPrefs, setDefs, persistUi, setColors, setTheme, setUserPresets]);

  /** Сброс всех настроек: программа, инструменты, интерфейс и цвета. */
  const resetSettings = useCallback(() => {
    setPrefs({ ...DEFAULT_PREFS });
    setDefs({ ...DEFAULT_DEFS });
    setColors({});
    persistUi({ ids: [], hidden: [], sides: DEFAULT_SIDES });
  }, [setPrefs, setDefs, setColors, persistUi]);

  /** Удалить черновик платы из браузера и начать с чистой платы. */
  const clearDraft = useCallback(() => {
    setConfirmAsk({
      title: 'Очистить черновик платы?',
      text: 'Сохранённая копия текущей платы будет удалена из этого браузера, откроется чистая плата. '
        + 'Если проект нужен — сначала скачайте его файлом (Ctrl+S).',
      ok: 'Очистить',
      onOk: () => {
        setConfirmAsk(null);
        try { (cloudUser ? sessionStorage : localStorage).removeItem(draftKey(cloudUser?.id)); } catch { /* ignore */ }
        const next = M.newBoard(prefs.newW, prefs.newH, prefs.newName);
        past.current = []; future.current = [];
        setDoc(next);
        setSel(new Set()); setDraft(null); setRouteA(null); setProbe(null);
        setEditNode(null); setTrackMsg({ msg: '', ok: null }); setRouteMsg({ msg: '', ok: null });
        setDialog(null);
        setTimeout(() => fit(next), 50);
      },
    });
  }, [cloudUser, prefs.newW, prefs.newH, prefs.newName, fit]);

  // ---------------- разметка ----------------
  return (
    <>
      {toolbar}

      <div className="main">
        {leftColumn}

        <div className="canvas-wrap" ref={wrapRef}>
          {/* базовый слой: сетка + плата (не реагирует на мышь) */}
          <canvas ref={baseRef} className="canvas-base" />
          <canvas ref={probeRef} aria-hidden="true"
            className={`canvas-probe${tool === 'probe' && probe ? ' is-active' : ''}`} />
          <canvas ref={drcRef} aria-hidden="true"
            className={`canvas-drc${hasClearanceMarks ? ' is-active' : ''}`} />
          {/* оверлей: черновики, фантомы, перекрестие; принимает события */}
          <canvas
            ref={overRef}
            className="canvas-over"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDblClick}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
            onPointerLeave={() => {
              if (moveRaf.current) { cancelAnimationFrame(moveRaf.current); moveRaf.current = 0; }
              moveData.current = null;
              setMouse((m) => ({ ...m, px: -100, py: -100 }));
            }}
          />
          {showDock && toolDock}
          <input
            ref={fileRef} type="file" accept=".json,.lay6,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={libFileRef} type="file" accept=".json,application/json,.lmk"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importLibJson(f);
              e.target.value = '';
            }}
          />
        </div>

        {sidesConf.showRight && rightColumn}
      </div>

      {prefs.statusBar && <div className="status">
        <span>X {statusCoord(mouse.wx)}</span>
        <span>Y {statusCoord(mouse.wy)}</span>
        <span title={gridSummary(gridConf, view.s)}>
          Сетка: <b>{fmtGridFull(defs.grid)}</b>
          {' · '}{defs.gridStyle === 'dots' ? 'точки' : defs.gridStyle === 'lines' ? 'линии' : defs.gridStyle === 'cross' ? 'перекрестия' : 'выкл.'}
          {defs.gridDiv > 1 ? ` ÷${defs.gridDiv}` : ''}
          {defs.gridMajor > 1 ? ` · главные ×${defs.gridMajor}` : ''}
          {' · '}
          <b className={defs.snapOn ? '' : 'off'}>{defs.snapOn ? (defs.snapObj ? 'привязка + объекты' : 'привязка') : 'без привязки'}</b>
        </span>
        <span>Масштаб: <b>{Math.round(view.s * 12.5)}%</b></span>
        <span className="lg">
          <span className="sw" style={{ background: activeCu === 'k1' ? COLORS.k1 : COLORS.k2 }} />
          <b>{activeCu === 'k1' ? 'K1 верх' : 'K2 низ'}</b>
        </span>
        {view.mir && <span><b>вид снизу</b></span>}
        <span className="sp" />
        {probe && (
          <span className="probe-info" title="Электрическая цепь под курсором (инструмент «Тест цепи»)">
            ⚡ цепь: {plur(probe.pads, ['площадка', 'площадки', 'площадок'])} · {plur(probe.smd, ['SMD', 'SMD', 'SMD'])} · {plur(probe.vias, ['переход', 'перехода', 'переходов'])} · {plur(probe.tracks, ['дорожка', 'дорожки', 'дорожек'])}
          </span>
        )}
        {prefs.statusHint && <span>{toolMeta.name}: {toolMeta.hint}</span>}
        <span className="lg" title={cloudUser ? `${activeCloud?.name ?? 'Черновик'}: ${cloudSaveLabel(cloudStatus)}${cloudMessage ? ' · ' + cloudMessage : ''}` : 'Локальный режим без сервера проектов'}>
          <span className={'pulse' + (cloudUser && (cloudStatus === 'error' || cloudStatus === 'conflict') ? ' cloud-pulse-error' : '')} />
          {cloudUser ? `Облако · ${cloudStatus === 'saved' ? 'сохранено' : cloudStatus === 'saving' ? 'сохраняем' : cloudStatus === 'error' ? 'ошибка' : cloudStatus === 'conflict' ? 'конфликт' : activeCloud ? 'изменено' : 'черновик'}` : 'локально · офлайн'}
        </span>
      </div>}

      {dialog === 'autoplace' && <AutoPlaceDialog doc={doc} selected={sel} clearance={defs.rtClear}
        onClose={() => setDialog(null)} onApply={(r) => {
          commit({ ...doc, entities: r.entities, groups: pruneGroups(doc.groups, new Set(r.entities.map((e) => e.id))) });
          setDraft(null); setRouteA(null); setProbe(null); setRouteMsg({ msg: '', ok: null });
          setDialog(null); fit();
        }} />}
      {routeVariants && <RouteVariantsDialog doc={routeVariants.snapshot} variants={routeVariants.variants}
        onApply={applyRouteVariant} onClose={() => {
          setRouteVariants(null);
          setRouteMsg({ msg: 'Выбор отменён. Плата не изменена.', ok: null });
        }} />}
      {routing !== null && <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="routing-title">
        <div className="modal">
          <h2 id="routing-title">Расчёт трёх вариантов трассировки групп</h2>
          <RoutingProgress text={routing} />
          <p>Поиск выполняется в фоне. После расчёта выберите один из трёх вариантов. До выбора плата не изменяется; Ctrl+Z отменит применение.</p>
          <button className="btn" autoFocus onClick={cancelRouting}>Отменить (Esc)</button>
        </div>
      </div>}
      {preview && <LibPreviewDialog
        title={preview.name}
        spec={preview.spec}
        note={preview.note ?? (preview.query ? 'строка генератора: ' + preview.query : undefined)}
        onClose={() => setPreview(null)}
        onAdd={addLibFromPreview}
        rot={placeRot} side={placeSide}
        onRot={setPlaceRot} onSide={setPlaceSide}
        ents={preview.ents} bl={preview.bl}
      />}
      {dialog === 'new' && <NewBoardDialog
        defaults={{ name: prefs.newName, w: prefs.newW, h: prefs.newH }}
        onOk={newBoardDlg} onClose={() => setDialog(null)} />}
      {dialog === 'export' && (
        <ExportDialog
          defaults={{ layer: prefs.pngLayer, mirror: prefs.pngMirror, drill: prefs.pngDrill, dpi: prefs.pngDpi }}
          onGerber={exportGerber} onPng={exportPng} onLay6={exportLay6}
          onCnc={() => setDialog('cnc')} onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'cnc' && <Suspense fallback={<div className="modal-bg" role="status"><div className="modal modal-loading">
        <h2>Настройки ЧПУ</h2>
        <ProgressBar label="Загружаем настройки ЧПУ…" indeterminate live meta="модуль фрезеровки и сверловки подгружается по запросу" />
      </div></div>}>
        <CncDialog doc={doc} onClose={() => setDialog(null)} />
      </Suspense>}
      {dialog === 'board-preview' && <Suspense fallback={<div className="modal-bg" role="status"><div className="modal modal-loading">
        <h2>Предпросмотр платы</h2>
        <ProgressBar label="Загружаем 3D предпросмотр…" indeterminate live meta="Three.js и текстуры платы подгружаются по запросу" />
      </div></div>}>
        <BoardPreviewDialog doc={doc} initialTab={boardPreviewTab}
          onTab={setBoardPreviewTab} onClose={() => setDialog(null)} />
      </Suspense>}
      {dialog === 'panelize' && (
        <PanelizeDialog defX={doc.w + 2} defY={doc.h + 2} onOk={(c, r, gx, gy) => { panelize(c, r, gx, gy); setDialog(null); }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'inventory' && <InventoryDialog doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'stats' && <StatsDialog doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'imgimport' && (
        <ImageImportDialog
          onClose={() => setDialog(null)}
          onInsert={(ents) => {
            setDialog(null);
            if (!ents.length) return;
            setPasteTpl(ents);
            pasteGroups.current = [];
            setToolRaw('select');
            setTrackMsg({ msg: 'Кликните по плате, чтобы поставить рисунок (R — повернуть, Esc — отмена).', ok: true });
          }}
        />
      )}
      {dialog === 'colors' && (
        <ColorsDialog
          colors={colors} theme={theme} setColors={setColors}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'uib' && (
        <UiBuilderDialog
          ids={uiOrder}
          names={GROUP_NAMES}
          hidden={uiConf.hidden}
          pinned={PINNED_GROUPS}
          sideTabs={sidesConf.leftTabs}
          sideNames={LEFT_TAB_NAMES}
          leftW={sidesConf.leftW}
          rightW={sidesConf.rightW}
          showRight={sidesConf.showRight}
          onChange={(next) => persistUi({ ...uiConf, ids: next.ids, hidden: next.hidden })}
          onSides={(next) => persistUi({ ...uiConf, sides: next })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'grid' && (
        <GridDialog
          defs={defs} setDefs={setDefs} onClose={() => setDialog(null)}
          cursor={{ x: mouse.wx, y: mouse.wy }}
        />
      )}
      {dialog === 'about' && <AboutDialog version={appVer} onClose={() => setDialog(null)} />}
      {dialog === 'tour' && <TourDialog onClose={() => setDialog(null)} />}
      {cloudUser && dialog === 'cloud' && <CloudProjectsDialog
        current={activeCloud} docName={doc.name} status={cloudStatus} statusMessage={cloudMessage}
        onClose={() => setDialog(null)} onCreate={createCloud} onOpen={loadCloud} onSave={saveCloud}
        onReload={reloadCloud} onRename={renameCloud} onDelete={deleteCloud} onSaveFile={saveFile}
      />}
      {cloudUser && dialog === 'account' && <CloudAccountDialog user={cloudUser}
        onClose={() => setDialog(null)} onLogout={logoutCloud} />}
      {dialog === 'close' && (
        <Modal
          title="Закрытие сайта"
          className="close-help-modal"
          onClose={() => setDialog(null)}
          foot={<button className="btn primary" onClick={() => setDialog(null)}>Понятно</button>}
        >
          <p>
            Браузер не разрешает сайту закрывать вкладки, которые открыли вручную.
            Закройте эту вкладку сочетанием Ctrl+W или кнопкой × в браузере.
          </p>
          <p>В установленном приложении PSBees эта кнопка закрывает окно программы.</p>
        </Modal>
      )}
      {dialog === 'settings' && (
        <SettingsWindow
          prefs={prefs}
          setPrefs={setPrefs}
          defs={defs}
          setDefs={setDefs}
          theme={theme}
          setTheme={setTheme}
          colors={colors}
          setColors={setColors}
          presets={userPresets}
          setPresets={setUserPresets}
          ui={{
            ids: uiOrder,
            hidden: uiConf.hidden,
            sides: sidesConf,
            pinned: PINNED_GROUPS,
            names: GROUP_NAMES,
          }}
          onUi={(next) => persistUi({ ...uiConf, ids: next.ids, hidden: next.hidden })}
          onSides={(next) => persistUi({ ...uiConf, sides: normalizeSides(next) })}
          onUiAll={(next) => persistUi({
            ids: next.ids.filter((x) => GROUP_DEFS.some((g) => g.id === x)),
            hidden: next.hidden.filter((x) => GROUP_DEFS.some((g) => g.id === x) && !PINNED_GROUPS.includes(x)),
            sides: normalizeSides(next.sides),
          })}
          activeCu={activeCu}
          setActiveCu={setActiveCu}
          hiddenLayers={hidden}
          toggleLayer={toggleHidden}
          layerCounts={counts}
          board={{
            name: doc.name,
            w: doc.w,
            h: doc.h,
            entities: doc.entities.length,
            groups: groupCount,
            violations: clearanceMarks.length,
          }}
          version={appVer}
          onClose={() => setDialog(null)}
          onDetach={openSettingsWindow}
          onReset={resetSettings}
          onExport={exportSettings}
          onImport={importSettings}
          onClearDraft={clearDraft}
        />
      )}
      {confirmAsk && (
        <ConfirmDialog
          title={confirmAsk.title}
          text={confirmAsk.text}
          ok={confirmAsk.ok}
          danger
          onOk={confirmAsk.onOk}
          onClose={() => setConfirmAsk(null)}
        />
      )}
      {!cloudUser && upd.Dialog}
    </>
  );
}
