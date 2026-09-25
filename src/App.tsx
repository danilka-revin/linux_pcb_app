// PSBees — редактор печатных плат для Linux и Windows (аналог Sprint-Layout;
// фирменный стиль «пчелиный»: оса с молнией, золото на графите; тёмная и светлая темы).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as M from './pcb/model';
import { expandComp, expandDoc, libBBox } from './pcb/expand';
import { lay6ToDoc, docToLay6, lmkToEnts, entsToLmk, hasLay6Magic } from './pcb/lay6';
import {
  loadUserMacros, saveUserMacros, makeMacro, addUserMacro, macroKey, splitMacroName, type UserMacro,
} from './pcb/userlib';
import { LIB } from './pcb/library';
import { CANVAS_UI, COLORS, drawDoc, drawEnt, renderPrint, setCanvasTheme, toWorld, type ThemeId, type View } from './pcb/render';
import { productionFiles } from './pcb/gerber';
import { autoroute, clearanceAt, pickEndpoint, endpointOf, type RouteEnd } from './pcb/autoroute';
import { copperComponents, type NetRouteResult } from './pcb/netroute';
import { NetsPanel, NET_COLORS } from './ui/nets';
import { InventoryDialog } from './ui/inventory';
import { download, makeZip, unzip } from './pcb/zip';
import { Ic } from './ui/icons';
import {
  LayersPanel, LibraryPanel, PropsPanel, TOOLS,
  type Defs, type ToolId,
} from './ui/panels';
import {
  AboutDialog, ExportDialog, NewBoardDialog, PanelizeDialog, type ExportPngOpts,
} from './ui/dialogs';
import { UiBuilderDialog, useUpdater } from './ui/updater';

type ToolId2 = ToolId;

/** Фирменный логотип (оса с молнией) — значок в шапке. */
function BeeMark({ size = 30 }: { size?: number }) {
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

type Draft =
  | { t: 'track'; pts: { x: number; y: number; layer: 'k1' | 'k2' }[] }
  | { t: 'poly'; pts: M.Pt[] }
  | { t: 'line'; p1: M.Pt }
  | { t: 'rect'; p1: M.Pt }
  | { t: 'circle'; c: M.Pt }
  | { t: 'ruler'; pts: M.Pt[] };

type Drag =
  | { mode: 'pan'; startPx: { x: number; y: number }; view0: View }
  | { mode: 'move'; startWorld: M.Pt; doc0: M.Doc; moved: boolean }
  | { mode: 'marquee'; startWorld: M.Pt; curWorld: M.Pt };

const AUTOSAVE_KEY = 'lauaut.autosave';
const DEFS_KEY = 'lauaut.defs';
const UI_KEY = 'lauaut.ui';

/** Группы кнопок тулбара, настраиваемые конструктором интерфейса. */
const GROUP_DEFS: { id: string; label: string }[] = [
  { id: 'file', label: 'Файл' },
  { id: 'undo', label: 'Отмена / повтор' },
  { id: 'tools', label: 'Инструменты' },
  { id: 'grid', label: 'Сетка и углы' },
  { id: 'layer', label: 'Слой K1 / K2' },
  { id: 'view', label: 'Вид' },
  { id: 'about', label: 'Кнопка „Обновить“ и «О программе»' },
];
const GROUP_ORDER: string[] = GROUP_DEFS.map((g) => g.id);
const GROUP_NAMES: Record<string, string> = Object.fromEntries(GROUP_DEFS.map((g) => [g.id, g.label]));

/** Вкладки левой колонки: «Слои» и «Библиотека». */
const LEFT_TABS: { id: LeftTabId; label: string }[] = [
  { id: 'layers', label: 'Слои' },
  { id: 'lib', label: 'Библиотека' },
];
type LeftTabId = 'layers' | 'lib';
const LEFT_TAB_NAMES: Record<string, string> = Object.fromEntries(LEFT_TABS.map((t) => [t.id, t.label]));

/** Настройки боковых колонок. */
interface SidesConf {
  /** ширина левой колонки, px */
  leftW: number;
  /** ширина правой колонки, px */
  rightW: number;
  /** какие вкладки есть в левой колонке (порядок = порядок вкладок) */
  leftTabs: LeftTabId[];
  /** показывать ли правую колонку («Свойства») */
  showRight: boolean;
}

/** Сохранённая конфигурация интерфейса. */
interface UiState {
  /** порядок групп тулбара */
  ids: string[];
  /** скрытые группы тулбара */
  hidden: string[];
  /** боковые панели */
  sides?: SidesConf;
}

const DEFAULT_SIDES: SidesConf = { leftW: 250, rightW: 274, leftTabs: ['layers', 'lib'], showRight: true };
const normalizeSides = (s?: Partial<SidesConf>): SidesConf => ({
  leftW: s?.leftW ?? DEFAULT_SIDES.leftW,
  rightW: s?.rightW ?? DEFAULT_SIDES.rightW,
  leftTabs: (s?.leftTabs ?? DEFAULT_SIDES.leftTabs).filter((t) => LEFT_TABS.some((x) => x.id === t)),
  showRight: s?.showRight ?? DEFAULT_SIDES.showRight,
});

function loadUi(): UiState {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.ids) && Array.isArray(d.hidden)) {
        return {
          ids: d.ids.filter((id: string) => GROUP_DEFS.some((g) => g.id === id)),
          hidden: d.hidden.filter((id: string) => GROUP_DEFS.some((g) => g.id === id)),
          sides: normalizeSides(d.sides),
        };
      }
    }
  } catch { /* ignore */ }
  return { ids: [], hidden: [], sides: normalizeSides() };
}

const SAVE_UI = (c: UiState) => {
  try { localStorage.setItem(UI_KEY, JSON.stringify(c)); } catch { /* ignore */ }
};

const clampW = (w: number) => Math.max(160, Math.min(650, Math.round(w) || 250));

const DEFAULT_DEFS: Defs = {
  grid: 1.27,
  angle: '45',
  trackW: 0.6,
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

function loadDoc(): M.Doc {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.entities) && typeof d.w === 'number') return d as M.Doc;
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

export default function App() {
  // ---------------- состояние ----------------
  const [doc, setDoc] = useState<M.Doc>(loadDoc);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [tool, setToolRaw] = useState<ToolId2>('select');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [view, setView] = useState<View>({ s: 8, ox: 80, oy: 500, mir: false });
  const [defs, setDefsState] = useState<Defs>(loadDefs);
  const [hidden, setHidden] = useState<Set<M.LayerId>>(new Set());
  const [activeCu, setActiveCu] = useState<'k1' | 'k2'>('k1');
  const [mouse, setMouse] = useState({ px: -100, py: -100, wx: 0, wy: 0 });
  const [size, setSize] = useState({ w: 640, h: 480 });
  const [placeLib, setPlaceLib] = useState<string | null>(null);
  const [macros, setMacros] = useState<UserMacro[]>(loadUserMacros);
  const persistMacros = useCallback((up: (prev: UserMacro[]) => UserMacro[]) => {
    setMacros((prev) => {
      const nx = up(prev);
      saveUserMacros(nx);
      return nx;
    });
  }, []);
  const [placeRot, setPlaceRot] = useState(0);
  const [placeSide, setPlaceSide] = useState<'top' | 'bottom'>('top');
  const [pasteTpl, setPasteTpl] = useState<M.Entity[] | null>(null);
  const [leftTab, setLeftTab] = useState<'layers' | 'lib'>('layers');
  // тема оформления: тёмная (по умолчанию) или светлая, переключается в шапке
  const [theme, setTheme] = useState<ThemeId>(loadTheme);
  const [routeMode, setRouteMode] = useState<'pair' | 'nets'>('pair');
  const [activeNet, setActiveNet] = useState<string | null>(null);
  const [routing, setRouting] = useState<string | null>(null);
  const routeWorker = useRef<Worker | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  useEffect(() => () => routeWorker.current?.terminate(), []);
  const netGeometry = useMemo(() => {
    const ends = new Map<string, RouteEnd>();
    if (tool === 'route' && routeMode === 'nets') for (const e of expandDoc(doc.entities)) {
      const end = endpointOf(e);
      if (end) ends.set(e.id, end);
    }
    return { ends, comp: ends.size ? copperComponents(doc.entities) : new Map<string, string>() };
  }, [doc, tool, routeMode]);
  const [routeA, setRouteA] = useState<RouteEnd | null>(null);
  const [routeMsg, setRouteMsg] = useState<{ msg: string; ok: boolean | null }>({ msg: '', ok: null });
  const [dialog, setDialog] = useState<'new' | 'export' | 'panelize' | 'about' | 'inventory' | 'uib' | null>(null);
  const [uiConf, setUiConf] = useState<UiState>(loadUi);
  // сохраняем конфигурацию интерфейса сразу (не autosave через таймаут)
  const persistUi = useCallback((c: UiState) => {
    setUiConf(c);
    SAVE_UI(c);
  }, []);
  // версия сборки (сервер отдаёт /version из dist/version.json)
  const [appVer, setAppVer] = useState<string | null>(null);
  const upd = useUpdater(appVer);
  // «Тест цепи»: подсвеченная электрическая цепь (все связные пятки и дорожки)
  const [probe, setProbe] = useState<{
    entId: string; ents: Set<string>;
    pads: number; smd: number; vias: number; tracks: number;
  } | null>(null);
  // связность меди пересчитывается только в режиме «Тест цепи»
  const probeData = useMemo(() => {
    if (tool !== 'probe') return null;
    return { flat: expandDoc(doc.entities), comp: copperComponents(doc.entities) };
  }, [doc, tool]);
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
  const clipboard = useRef<M.Entity[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lmkFileRef = useRef<HTMLInputElement>(null);
  const lmkZipRef = useRef<HTMLInputElement>(null);
  const fitted = useRef(false);
  const selRef = useRef(sel);
  selRef.current = sel;

  const setDefs = useCallback((p: Partial<Defs>) => setDefsState((d) => ({ ...d, ...p })), []);

  // ---------------- история ----------------
  const commit = useCallback((next: M.Doc) => {
    past.current.push(doc);
    if (past.current.length > 100) past.current.shift();
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
  }, [doc, pruneSel]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(doc);
    const next = future.current.pop()!;
    setDoc(next);
    pruneSel(next);
    setDraft(null);
    setRouteA(null); setRouteMsg({ msg: '', ok: null });
  }, [doc, pruneSel]);

  // ---------------- автосохранение ----------------
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc)); } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [doc]);
  useEffect(() => {
    try { localStorage.setItem(DEFS_KEY, JSON.stringify(defs)); } catch { /* ignore */ }
  }, [defs]);

  // применяем тему: CSS-переменные на <html> + палитра холста
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    setCanvasTheme(theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

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

  // ---------------- вспомогательные ----------------
  const snapPt = useCallback((w: M.Pt, fine: boolean): M.Pt => (
    fine ? w : { x: M.snap(w.x, defs.grid), y: M.snap(w.y, defs.grid) }
  ), [defs.grid]);

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
    if (tool === 'route' && routeMode === 'nets' && activeNet) { setActiveNet(null); return; }
    if (routeA) { setRouteA(null); setRouteMsg({ msg: '', ok: null }); return; }
    if (draft?.t === 'track') { commitTrack(); return; }
    if (draft?.t === 'poly') { commitPoly(); return; }
    if (draft) { setDraft(null); return; }
    if (pasteTpl) { setPasteTpl(null); return; }
    if (placeLib) { setPlaceLib(null); return; }
    if (probe) { setProbe(null); return; }
    if (sel.size) { setSel(new Set()); }
  }, [draft, commitTrack, commitPoly, pasteTpl, placeLib, probe, sel.size, routeA, activeNet, routeMode, tool]);

  const setTool = useCallback((t: ToolId2) => {
    if (t !== tool) { finishOrCancel(); setToolRaw(t); }
    if (t === 'route') setSel(new Set());
  }, [tool, finishOrCancel]);

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

  const deleteSel = useCallback(() => {
    if (!selRef.current.size) return;
    const nd = M.cloneDoc(doc);
    nd.entities = nd.entities.filter((e) => !selRef.current.has(e.id));
    commit(nd);
    setSel(new Set());
  }, [doc, commit]);

  const duplicateSel = useCallback(() => {
    if (!selRef.current.size) return;
    const nd = M.cloneDoc(doc);
    const clones: M.Entity[] = [];
    for (const e of nd.entities) {
      if (selRef.current.has(e.id)) {
        const c = JSON.parse(JSON.stringify(e)) as M.Entity;
        c.id = M.uid();
        M.translateEnt(c, defs.grid * 2, defs.grid * 2);
        clones.push(c);
      }
    }
    nd.entities.push(...clones);
    commit(nd);
    setSel(new Set(clones.map((c) => c.id)));
  }, [doc, commit, defs.grid]);

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
  }, [doc]);

  const startPaste = useCallback(() => {
    if (!clipboard.current.length) return;
    const tpl = clipboard.current.map((e) => {
      const c = JSON.parse(JSON.stringify(e)) as M.Entity;
      c.id = M.uid();
      return c;
    });
    setPasteTpl(tpl);
    setSel(new Set());
  }, []);

  const dropPaste = useCallback((at: M.Pt) => {
    if (!pasteTpl) return;
    const bb = M.unionBBox(pasteTpl.map(M.entBBox));
    const dx = at.x - bb[0], dy = at.y - bb[1];
    const clones = pasteTpl.map((e) => {
      const c = JSON.parse(JSON.stringify(e)) as M.Entity;
      c.id = M.uid();
      M.translateEnt(c, dx, dy);
      return c;
    });
    const nd = M.cloneDoc(doc);
    nd.entities.push(...clones);
    commit(nd);
    setSel(new Set(clones.map((c) => c.id)));
    setPasteTpl(null);
  }, [pasteTpl, doc, commit]);

  // ---------------- файл/экспорт ----------------
  const saveFile = useCallback(() => {
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    download(`${doc.name || 'board'}.laypcb.json`, blob);
  }, [doc]);

  const openFile = useCallback((f: File) => {
    const name = f.name.toLowerCase();
    f.arrayBuffer().then((ab) => {
      try {
        if (hasLay6Magic(ab)) {
          // Sprint-Layout: .lmk — макрос (в библиотеку), .lay6 — плата
          if (name.endsWith('.lmk')) {
            const { ents, warnings } = lmkToEnts(ab);
            if (!ents.length) throw new Error('пустой макрос');
            const m = makeMacro(f.name.replace(/\.lmk$/i, ''), ents);
            persistMacros((prev) => addUserMacro(prev, m));
            setPlaceLib('u:' + macroKey(m));
            setToolRaw('comp');
            if (warnings.length) alert('Замечания при импорте макроса:\n• ' + warnings.slice(0, 6).join('\n• '));
            return;
          }
          const { doc: nd, warnings } = lay6ToDoc(ab);
          commit(nd);
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
        commit(nd);
        setSel(new Set());
        setTimeout(() => fit(nd), 50);
      } catch {
        alert('Не удалось открыть файл: неверный формат проекта.');
      }
    });
  }, [commit, fit, persistMacros]);

  const exportLay6 = useCallback(() => {
    const base = (doc.name || 'board').replace(/[^\wа-яА-ЯёЁ-]+/g, '_');
    download(`${base}.lay6`, new Blob([docToLay6(doc, expandDoc(doc.entities)).slice().buffer], { type: 'application/octet-stream' }));
  }, [doc]);

  const exportLmk = useCallback(() => {
    const selEnts = doc.entities.filter((e) => selRef.current.has(e.id));
    if (!selEnts.length) return;
    const name = (prompt('Имя макроса Sprint-Layout (можно «Папка/Имя»):', 'Макрос') || 'Макрос').trim() || 'Макрос';
    const { name: base, folder } = splitMacroName(name);
    download(`${folder ? folder + '_' : ''}${base}.lmk`, new Blob([entsToLmk(selEnts).slice().buffer], { type: 'application/octet-stream' }));
    // и в локальную библиотеку — сразу
    persistMacros((prev) => addUserMacro(prev, makeMacro(name, selEnts)));
  }, [doc, persistMacros]);

  const importLmkFile = useCallback((f: File) => {
    f.arrayBuffer().then((ab) => {
      try {
        if (!hasLay6Magic(ab)) throw new Error('формат');
        const { ents } = lmkToEnts(ab);
        if (!ents.length) throw new Error('пустой макрос');
        const m = makeMacro(f.name.replace(/\.lmk$/i, ''), ents);
        persistMacros((prev) => addUserMacro(prev, m));
        setPlaceLib('u:' + macroKey(m));
        setToolRaw('comp');
      } catch {
        alert('Не удалось импортировать макрос .lmk: неверный формат файла.');
      }
    });
  }, [persistMacros]);

  // Пакетный импорт: ZIP-архив с макросами Sprint-Layout (.lmk)
  const importLmkZip = useCallback(async (f: File) => {
    let count = 0;
    let last: string | null = null;
    const warns: string[] = [];
    try {
      const files = await unzip(await f.arrayBuffer());
      const lmks = [...files.entries()].filter(([n]) => n.toLowerCase().endsWith('.lmk'));
      if (!lmks.length) {
        alert('В архиве не найдено ни одного файла .lmk.');
        return;
      }
      for (const [n, data] of lmks) {
        const path = n.split(/[\\/]/);
        const base = path.pop() || n;
        const folder = path.filter(Boolean).join('/') || undefined; // папки архива → папки библиотеки
        const name = base.replace(/\.lmk$/i, '');
        try {
          if (!hasLay6Magic(data)) throw new Error('формат');
          const { ents, warnings } = lmkToEnts(data);
          if (!ents.length) throw new Error('пустой макрос');
          for (const w of warnings) warns.push(`${base}: ${w}`);
          const m = makeMacro(name, ents, folder);
          persistMacros((prev) => addUserMacro(prev, m));
          count++;
          last = macroKey(m);
        } catch (e) {
          warns.push(`${base}: ${e instanceof Error ? e.message : 'ошибка'}`);
        }
      }
      const ok = count ? `Импортировано макросов: ${count}` : 'Ни один макрос не импортирован.';
      alert(warns.length ? `${ok}\n\nЗамечания:\n• ${warns.slice(0, 10).join('\n• ')}` : ok);
      if (last) { setPlaceLib('u:' + last); setToolRaw('comp'); }
    } catch (e) {
      alert('Не удалось открыть архив: ' + (e instanceof Error ? e.message : 'неверный формат') +
        '\nОжидается ZIP с файлами .lmk.');
    }
  }, [persistMacros]);

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
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (r === 0 && c === 0) continue;
        for (const e of doc.entities) {
          const k = JSON.parse(JSON.stringify(e)) as M.Entity;
          k.id = M.uid();
          M.translateEnt(k, c * gx, r * gy);
          copies.push(k);
        }
      }
    }
    nd.entities.push(...copies);
    nd.w = doc.w + (cols - 1) * gx;
    nd.h = doc.h + (rows - 1) * gy;
    commit(nd);
    setTimeout(() => fit(), 50);
  }, [doc, commit, fit]);

  const newBoardDlg = useCallback((name: string, w: number, h: number) => {
    commit(M.newBoard(w, h, name));
    setSel(new Set());
    setDialog(null);
    setTimeout(() => fit(), 50);
  }, [commit, fit]);

  // ---------------- указатель ----------------
  const getPos = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  };

  const zoomAt = useCallback((px: number, py: number, factor: number) => {
    setView((v) => {
      const ns = M.clamp(v.s * factor, 1, 500);
      const w = toWorld(v, px, py);
      return {
        s: ns,
        ox: px - w.x * ns * (v.mir ? -1 : 1),
        oy: py + w.y * ns,
        mir: v.mir,
      };
    });
  }, []);

  const addComp = useCallback((at: M.Pt) => {
    if (!placeLib) return;
    if (placeLib.startsWith('u:')) {
      const m = macros.find((x) => 'u:' + macroKey(x) === placeLib);
      if (!m) return;
      const comp: M.Comp = {
        id: M.uid(), kind: 'comp', lib: '', name: macroKey(m),
        x: at.x, y: at.y, rot: placeRot, side: placeSide,
        bl: m.bl.map((v) => v) as [number, number, number, number],
        ents: m.ents.map((e) => ({ ...JSON.parse(JSON.stringify(e)), id: M.uid() } as M.Entity)),
      };
      addEnts([comp]);
      return;
    }
    const entry = LIB[placeLib];
    if (!entry) return;
    const comp: M.Comp = {
      id: M.uid(), kind: 'comp', lib: placeLib, name: entry.name,
      x: at.x, y: at.y, rot: placeRot, side: placeSide,
      bl: libBBox(entry.build()),
    };
    addEnts([comp]);
  }, [placeLib, placeRot, placeSide, addEnts, macros]);

  // ---------------- автотрассировка ----------------
  const changeNets = (nets: M.Net[]) => {
    commit({ ...doc, nets });
    setRouteMsg({ msg: '', ok: null });
  };
  const cancelRouting = () => {
    routeWorker.current?.terminate();
    routeWorker.current = null;
    setRouting(null);
    setRouteMsg({ msg: 'Трассировка отменена. Плата не изменена.', ok: null });
  };
  const routeAll = () => {
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
        const r = event.data.result as NetRouteResult;
        if (r.errors.length) { setRouteMsg({ msg: r.errors.join('\n'), ok: false }); return; }
        if (r.ents.length) commit({ ...snapshot, entities: [...snapshot.entities, ...r.ents] });
        setSel(new Set());
        const summary = r.missing ? `Осталось связей: ${r.missing}. ` : 'Все группы соединены. ';
        const details = r.unresolved.map((n) => `«${n.name}»: ${n.missing}`).join('; ');
        setRouteMsg({ msg: `${summary}Добавлено: ${r.length.toFixed(1)} мм, переходов: ${r.vias}. Проверено вариантов: ${r.attempts}.` + (details ? `\nНе разведены: ${details}. Проверьте ширину, зазоры и шаг сетки или разрешите верхний слой.` : ''), ok: r.missing === 0 });
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
  };
  const routeClick = useCallback((w: M.Pt, sp: M.Pt) => {
    const tol = 3 / view.s + 0.05;
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
      setRouteMsg({ msg: 'Первая точка: ' + M.fmt(end.x) + '; ' + M.fmt(end.y) + ' — выберите вторую', ok: null });
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
    const sp = snapPt(w, e.altKey);

    if (e.button === 2) { finishOrCancel(); return; }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pasteTpl) { dropPaste(sp); return; }

    switch (tool) {
      case 'select': {
        const hitId = hitAt(w);
        if (hitId) {
          let ns: Set<string>;
          if (e.shiftKey) {
            ns = new Set(sel);
            if (ns.has(hitId)) ns.delete(hitId); else ns.add(hitId);
          } else {
            ns = sel.has(hitId) ? new Set(sel) : new Set([hitId]);
          }
          setSel(ns);
          if (ns.has(hitId))
            drag.current = { mode: 'move', startWorld: w, doc0: M.cloneDoc(doc), moved: false };
        } else {
          if (!e.shiftKey) setSel(new Set());
          drag.current = { mode: 'marquee', startWorld: w, curWorld: w };
        }
        break;
      }
      case 'track': {
        setDraft((d) => {
          if (!d || d.t !== 'track') return { t: 'track', pts: [{ ...sp, layer: activeCu }] };
          const last = d.pts[d.pts.length - 1];
          const c = constrain(last, sp);
          if (Math.hypot(c.x - last.x, c.y - last.y) < 1e-6) return d;
          return { ...d, pts: [...d.pts, { ...c, layer: activeCu }] };
        });
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

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { px, py } = getPos(e);
    const w = toWorld(view, px, py);
    const sp = snapPt(w, e.altKey);
    setMouse({ px, py, wx: sp.x, wy: sp.y });
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') {
      setView({ ...d.view0, ox: d.view0.ox + (px - d.startPx.x), oy: d.view0.oy + (py - d.startPx.y) });
    } else if (d.mode === 'move') {
      const mdx = w.x - d.startWorld.x, mdy = w.y - d.startWorld.y;
      if (!d.moved && Math.hypot(mdx, mdy) * view.s < 4) return;
      d.moved = true;
      const sdx = e.altKey ? mdx : M.snap(mdx, defs.grid);
      const sdy = e.altKey ? mdy : M.snap(mdy, defs.grid);
      const nd = M.cloneDoc(d.doc0);
      nd.entities.forEach((ent) => {
        if (selRef.current.has(ent.id)) M.translateEnt(ent, sdx, sdy);
      });
      setDoc(nd);
    } else if (d.mode === 'marquee') {
      d.curWorld = w;
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'move' && d.moved) {
      past.current.push(d.doc0);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      setDoc((cur) => cur);
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
        if (e.shiftKey) setSel((s) => new Set([...s, ...ns]));
        else setSel(ns);
      }
    }
  };

  const onDblClick = () => {
    if (draft?.t === 'track') commitTrack();
    else if (draft?.t === 'poly') commitPoly();
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const { px, py } = getPos(e);
    zoomAt(px, py, e.deltaY < 0 ? 1.28 : 1 / 1.28);
  };

  // ---------------- клавиатура ----------------
  const keyHandler = useCallback((e: KeyboardEvent) => {
    if (routeWorker.current) {
      if (e.code === 'Escape') { routeWorker.current.terminate(); routeWorker.current = null; setRouting(null); setRouteMsg({ msg: 'Трассировка отменена. Плата не изменена.', ok: null }); }
      e.preventDefault(); return;
    }
    if (dialog) return;
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl) {
      switch (e.code) {
        case 'KeyZ': if (e.shiftKey) redo(); else undo(); e.preventDefault(); return;
        case 'KeyY': redo(); e.preventDefault(); return;
        case 'KeyS': saveFile(); e.preventDefault(); return;
        case 'KeyO': fileRef.current?.click(); e.preventDefault(); return;
        case 'KeyA': setSel(new Set(doc.entities.map((en) => en.id))); e.preventDefault(); return;
        case 'KeyC': copySel(); e.preventDefault(); return;
        case 'KeyV': startPaste(); e.preventDefault(); return;
        case 'KeyD': duplicateSel(); e.preventDefault(); return;
        case 'KeyE': setDialog('export'); e.preventDefault(); return;
        default: return;
      }
    }
    switch (e.code) {
      case 'Escape': finishOrCancel(); break;
      case 'Delete': case 'Backspace': deleteSel(); break;
      case 'KeyR':
        if (placeLib) setPlaceRot((r) => (r + 90) % 360);
        else rotateSel();
        break;
      case 'KeyM': mirrorSel(); break;
      case 'KeyQ': if (placeLib) setPlaceSide((s) => (s === 'top' ? 'bottom' : 'top')); break;
      case 'KeyL': {
        const other: 'k1' | 'k2' = activeCu === 'k1' ? 'k2' : 'k1';
        if (draft?.t === 'track') {
          // точка смены слоя на текущей позиции курсора
          setDraft((d2) => {
            if (!d2 || d2.t !== 'track') return d2;
            return { ...d2, pts: [...d2.pts, { x: mouse.wx, y: mouse.wy, layer: other }] };
          });
        }
        setActiveCu(other);
        break;
      }
      case 'KeyF': fit(); break;
      case 'Equal': case 'NumpadAdd': zoomAt(size.w / 2, size.h / 2, 1.3); break;
      case 'Minus': case 'NumpadSubtract': zoomAt(size.w / 2, size.h / 2, 1 / 1.3); break;
      case 'Digit1': setTool('select'); break;
      case 'Digit2': setTool('track'); break;
      case 'Digit3': setTool('pad'); break;
      case 'Digit4': setTool('via'); break;
      case 'Digit5': setTool('hole'); break;
      case 'Digit6': setTool('line'); break;
      case 'Digit7': setTool('text'); break;
      case 'Digit8': setTool('ruler'); break;
      case 'Digit9': setTool('route'); break;
      case 'Digit0': setTool('probe'); break;
      case 'ArrowLeft': nudge(-defs.grid, 0); e.preventDefault(); break;
      case 'ArrowRight': nudge(defs.grid, 0); e.preventDefault(); break;
      case 'ArrowUp': nudge(0, defs.grid); e.preventDefault(); break;
      case 'ArrowDown': nudge(0, -defs.grid); e.preventDefault(); break;
      default: break;
    }
  }, [
    dialog, doc, undo, redo, saveFile, copySel, startPaste, duplicateSel, finishOrCancel,
    deleteSel, placeLib, rotateSel, mirrorSel, draft, activeCu, mouse.wx, mouse.wy, fit,
    zoomAt, size, nudge, defs.grid, setTool,
  ]);

  const keyRef = useRef(keyHandler);
  keyRef.current = keyHandler;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---------------- отрисовка ----------------
  const compBL = useMemo(() => {
    const m = new Map<string, [number, number, number, number]>();
    Object.values(LIB).forEach((e) => m.set(e.key, libBBox(e.build())));
    return m;
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
    if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
    cv.style.width = size.w + 'px';
    cv.style.height = size.h + 'px';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // фон
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, size.w, size.h);

    // сетка
    let step = defs.grid;
    while (step * view.s < 7) step *= 2;
    const wTL = toWorld(view, 0, 0);
    const wBR = toWorld(view, size.w, size.h);
    const gx1 = Math.min(wTL.x, wBR.x), gx2 = Math.max(wTL.x, wBR.x);
    const gy1 = Math.min(wTL.y, wBR.y), gy2 = Math.max(wTL.y, wBR.y);
    ctx.fillStyle = COLORS.grid;
    for (let x = Math.floor(gx1 / step) * step; x <= gx2; x += step) {
      const sxpx = view.ox + x * view.s * (view.mir ? -1 : 1);
      for (let y = Math.floor(gy1 / step) * step; y <= gy2; y += step) {
        const sypx = view.oy - y * view.s;
        ctx.fillRect(sxpx - 0.65, sypx - 0.65, 1.3, 1.3);
      }
    }

    // оси начала координат
    ctx.strokeStyle = COLORS.axes;
    ctx.lineWidth = 1;
    const o = toPx(0, 0);
    ctx.beginPath();
    if (o.px >= 0 && o.px <= size.w) { ctx.moveTo(o.px + 0.5, 0); ctx.lineTo(o.px + 0.5, size.h); }
    if (o.py >= 0 && o.py <= size.h) { ctx.moveTo(0, o.py + 0.5); ctx.lineTo(size.w, o.py + 0.5); }
    ctx.stroke();

    // документ
    drawDoc(ctx, view, doc, hidden);

    // выделение
    if (sel.size) {
      ctx.save();
      for (const ent of doc.entities) {
        if (!sel.has(ent.id)) continue;
        drawEnt(ctx, view, ent, { tint: COLORS.sel, alpha: 0.5, hidden: new Set() });
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

    // «Тест цепи»: подсветка всей электрической цепи
    if (probe && probeData) {
      ctx.save();
      for (const e of probeData.flat) {
        if (!probe.ents.has(e.id)) continue;
        drawEnt(ctx, view, e, { tint: COLORS.probe, alpha: 0.55, hidden: new Set() });
      }
      ctx.restore();
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
      const c = constrain(last, { x: mouse.wx, y: mouse.wy });
      const a = toPx(last.x, last.y), b = toPx(c.x, c.y);
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = activeCu === 'k1' ? COLORS.k1 : COLORS.k2;
      ctx.beginPath(); ctx.moveTo(a.px, a.py); ctx.lineTo(b.px, b.py); ctx.stroke();
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

    // автотрассировка: зоны зазора вокруг отверстий (ближе дорожка не подойдёт)
    if (tool === 'route' && defs.rtHoleClear > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,180,60,.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (const e of expandDoc(doc.entities)) {
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
          ctx.fillText(net.name, q.px + r + 3, q.py - r);
        }
      });
      ctx.restore();
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

    // фантомы размещения
    const ghost = (ent: M.Entity) => drawEnt(ctx, view, ent, { alpha: 0.55, hidden: new Set() });
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
      else if (tool === 'comp' && placeLib) {
        const um = placeLib.startsWith('u:') ? macros.find((x) => 'u:' + macroKey(x) === placeLib) : undefined;
        ghost({
          id: 'g', kind: 'comp', lib: um ? '' : placeLib, name: '', ...at, rot: placeRot, side: placeSide,
          bl: um ? um.bl : compBL.get(placeLib) ?? [-2, -2, 2, 2],
          ents: um?.ents,
        });
      }
      // буфер вставки
      if (pasteTpl) {
        const bb = M.unionBBox(pasteTpl.map(M.entBBox));
        pasteTpl.forEach((tpl) => {
          const c = JSON.parse(JSON.stringify(tpl)) as M.Entity;
          M.translateEnt(c, at.x - bb[0], at.y - bb[1]);
          drawEnt(ctx, view, c, { alpha: 0.55, tint: COLORS.sel, hidden: new Set() });
        });
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

    // перекрестие курсора
    if (mouse.px >= 0 && mouse.px <= size.w && mouse.py >= 0 && mouse.py <= size.h) {
      ctx.strokeStyle = 'rgba(255,255,255,.13)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mouse.py + 0.5); ctx.lineTo(size.w, mouse.py + 0.5);
      ctx.moveTo(mouse.px + 0.5, 0); ctx.lineTo(mouse.px + 0.5, size.h);
      ctx.stroke();
      const lbl = `X ${M.fmt(mouse.wx)}  Y ${M.fmt(mouse.wy)}`;
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(20,22,26,.85)';
      const tw = ctx.measureText(lbl).width;
      ctx.fillRect(mouse.px + 10, mouse.py - 22, tw + 8, 15);
      ctx.fillStyle = '#9aa3ad';
      ctx.fillText(lbl, mouse.px + 14, mouse.py - 11);
    }
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
  const toggleHidden = (l: M.LayerId) =>
    setHidden((h) => { const n = new Set(h); if (n.has(l)) n.delete(l); else n.add(l); return n; });

  const tb = (
    n: string, title: string, onClick: () => void, opts?: { active?: boolean; disabled?: boolean },
  ) => (
    <button key={n} className={'tb-btn' + (opts?.active ? ' active' : '')} title={title}
      onClick={onClick} disabled={opts?.disabled}>
      <Ic n={n} />
    </button>
  );

  // ---------------- группы тулбара (конструктор интерфейса) ----------------
  const tbGroups: Record<string, ReactNode> = {
    file: (
      <div className="tb-group" key="file">
        {tb('new', 'Новая плата', () => setDialog('new'))}
        {tb('open', 'Открыть проект (Ctrl+O)', () => fileRef.current?.click())}
        {tb('save', 'Сохранить проект (Ctrl+S)', saveFile)}
        {tb('gerber', 'Экспорт Gerber/PNG (Ctrl+E)', () => setDialog('export'))}
        {tb('panel', 'Размножить плату (панелизация)', () => setDialog('panelize'))}
        {tb('inventory', 'Перечень площадок и отверстий', () => setDialog('inventory'))}
      </div>
    ),
    undo: (
      <div className="tb-group" key="undo">
        {tb('undo', 'Отменить (Ctrl+Z)', undo, { disabled: !past.current.length })}
        {tb('redo', 'Повторить (Ctrl+Y)', redo, { disabled: !future.current.length })}
      </div>
    ),
    tools: (
      <div className="tb-group" key="tools">
        {TOOLS.map((t) => tb(t.icon, `${t.name}${t.id === 'track' ? ' (2)' : t.id === 'route' ? ' (9)' : t.id === 'probe' ? ' (0)' : ''}`, () => setTool(t.id), { active: tool === t.id && !(t.id === 'comp' && !placeLib) }))}
      </div>
    ),
    grid: (
      <div className="tb-group" key="grid">
        <select
          className="tb-sel" title="Шаг сетки, мм"
          value={String(defs.grid)}
          onChange={(e) => setDefs({ grid: parseFloat(e.target.value) })}
        >
          {[0.25, 0.5, 0.635, 1.0, 1.27, 2.54, 5.08].map((g) => (
            <option key={g} value={g}>Сетка {g}</option>
          ))}
        </select>
        <button
          className="tb-btn"
          title={`Углы прокладки: ${defs.angle === '45' ? '45°' : defs.angle === '90' ? '90°' : 'свободно'}`}
          onClick={() => setDefs({ angle: defs.angle === '45' ? '90' : defs.angle === '90' ? 'free' : '45' })}
        >
          <Ic n={defs.angle === '45' ? 'angle45' : defs.angle === '90' ? 'angle90' : 'anglefree'} />
        </button>
      </div>
    ),
    layer: (
      <div className="tb-group" key="layer">
        <button className={'tb-btn cu' + (activeCu === 'k1' ? ' active' : '')}
          style={{ borderColor: COLORS.k1, color: activeCu === 'k1' ? 'var(--text)' : COLORS.k1 }}
          title="Активный слой: верхняя медь (L)" onClick={() => setActiveCu('k1')}>K1</button>
        <button className={'tb-btn cu' + (activeCu === 'k2' ? ' active' : '')}
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
    about: (
      <div className="tb-group" key="about">
        {tb('uib', 'Конструктор интерфейса', () => setDialog('uib'))}
        {tb(theme === 'dark' ? 'sun' : 'moon',
          theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
          () => setTheme(theme === 'dark' ? 'light' : 'dark'))}
        {upd.Button}
        {tb('about', 'О программе', () => setDialog('about'))}
      </div>
    ),
  };

  // порядок групп тулбара: сохранённый в localStorage, иначе порядок по умолчанию
  const uiOrder = (uiConf.ids.length ? uiConf.ids : GROUP_ORDER)
    .filter((id) => GROUP_DEFS.some((g) => g.id === id));
  const uiHidden = new Set(uiConf.hidden);
  const toShow = uiOrder.filter((id) => !uiHidden.has(id));

  // ---------------- боковые колонки (конструктор интерфейса) ----------------
  const sidesConf = normalizeSides(uiConf.sides);
  const leftTabs: LeftTabId[] = sidesConf.leftTabs.length ? sidesConf.leftTabs : ['layers', 'lib'];
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
        Плата: {M.fmt(doc.w)} × {M.fmt(doc.h)} мм<br />
        Элементов: {doc.entities.length} · Выделено: {sel.size}
        <button className="btn inventory-open" onClick={() => setDialog('inventory')}>Площадки и отверстия…</button>
      </div>
    </>
  );
  const renderLibPane = () => (
    <LibraryPanel
      picked={placeLib}
      onPick={(k) => { setPlaceLib(k); setToolRaw('comp'); }}
      macros={macros}
      onPickUser={(k) => { setPlaceLib('u:' + k); setToolRaw('comp'); }}
      onDelUser={(k) => { persistMacros((prev) => prev.filter((m) => macroKey(m) !== k)); if (placeLib === 'u:' + k) setPlaceLib(null); }}
      onImportLmk={() => lmkFileRef.current?.click()}
      onImportZip={() => lmkZipRef.current?.click()}
    />
  );

  const leftColumn = (
    <div className="side" style={{ width: clampW(sidesConf.leftW) }}>
      <div className="pane-full">
        {leftTabs.length > 1 && (
          <div className="tabs">
            {leftTabs.map((t) => (
              <button key={t} className={activeLeft === t ? 'on' : ''} onClick={() => setLeftTab(t)}>
                {t === 'layers' ? 'Слои' : 'Библиотека'}
              </button>
            ))}
          </div>
        )}
        {activeLeft === 'layers' ? renderLayersPane() : renderLibPane()}
      </div>
    </div>
  );

  const rightColumn = (
    <div className="side right" style={{ width: clampW(sidesConf.rightW) }}>
      <div className="pane-full">
        {tool === 'route' && <>
          <div className="props route-modes">
            <button className={'btn' + (routeMode === 'pair' ? ' primary' : '')} onClick={() => { setRouteMode('pair'); setRouteA(null); setSel(new Set()); setRouteMsg({ msg: '', ok: null }); }}>Две точки</button>
            <button className={'btn' + (routeMode === 'nets' ? ' primary' : '')} onClick={() => { setRouteMode('nets'); setRouteA(null); setSel(new Set()); setRouteMsg({ msg: '', ok: null }); }}>Группы / вся плата</button>
          </div>
          {routeMode === 'nets' && <NetsPanel nets={doc.nets ?? []} active={activeNet} setActive={setActiveNet}
            ends={netGeometry.ends} comp={netGeometry.comp} info={routeMsg} onChange={changeNets} onRoute={routeAll}
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
          placeLib={placeLib} placeRot={placeRot} placeSide={placeSide}
          setPlaceRot={setPlaceRot} setPlaceSide={setPlaceSide} cancelPlace={() => setPlaceLib(null)}
          textRot={defs.textRot} setTextRot={(r) => setDefs({ textRot: r })}
          routeGroups={routeMode === 'nets'}
          routeInfo={{ ...routeMsg, msg: routeMode === 'nets' ? '' : routeMsg.msg, picking: routeA ? 'b' : 'a' }}
        />
      </div>
    </div>
  );

  // ---------------- разметка ----------------
  return (
    <>
      <div className="toolbar">
        <div className="brand">
          <span className="brandmark"><BeeMark /></span>
          <span><b>PS<em>Bees</em></b><small>PCB · LINUX · WINDOWS · SPRINT-LAYOUT</small></span>
        </div>
        {toShow.map((id) => tbGroups[id])}
      </div>

      <div className="main">
        {leftColumn}

        <div className="canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onDoubleClick={onDblClick}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
            onPointerLeave={() => setMouse((m) => ({ ...m, px: -100, py: -100 }))}
          />
          <input
            ref={fileRef} type="file" accept=".json,.lay6,.lmk,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={lmkFileRef} type="file" accept=".lmk"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importLmkFile(f);
              e.target.value = '';
            }}
          />
          <input
            ref={lmkZipRef} type="file" accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importLmkZip(f);
              e.target.value = '';
            }}
          />
        </div>

        {sidesConf.showRight && rightColumn}
      </div>

      <div className="status">
        <span>X <b>{M.fmt(mouse.wx)}</b> мм <b>{M.fmt(M.mm2mil(mouse.wx), 1)}</b> mil</span>
        <span>Y <b>{M.fmt(mouse.wy)}</b> мм <b>{M.fmt(M.mm2mil(mouse.wy), 1)}</b> mil</span>
        <span>Сетка: <b>{defs.grid}</b></span>
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
        <span>{toolMeta.name}: {toolMeta.hint}</span>
        <span className="lg"><span className="pulse" />локально · офлайн</span>
      </div>

      {routing !== null && <div className="modal-bg" role="dialog" aria-modal="true" aria-labelledby="routing-title">
        <div className="modal">
          <h2 id="routing-title">Разводка всей платы</h2>
          <p aria-live="polite">{routing}</p>
          <p>Поиск выполняется в фоне. Готовый вариант будет добавлен одним действием; Ctrl+Z отменит всю разводку.</p>
          <button className="btn" autoFocus onClick={cancelRouting}>Отменить (Esc)</button>
        </div>
      </div>}
      {dialog === 'new' && <NewBoardDialog onOk={newBoardDlg} onClose={() => setDialog(null)} />}
      {dialog === 'export' && (
        <ExportDialog
          onGerber={exportGerber} onPng={exportPng} onLay6={exportLay6} onLmk={exportLmk}
          selCount={sel.size} onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'panelize' && (
        <PanelizeDialog defX={doc.w + 2} defY={doc.h + 2} onOk={(c, r, gx, gy) => { panelize(c, r, gx, gy); setDialog(null); }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'inventory' && <InventoryDialog doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'uib' && (
        <UiBuilderDialog
          ids={uiOrder}
          names={GROUP_NAMES}
          hidden={uiConf.hidden}
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
      {dialog === 'about' && <AboutDialog version={appVer} onClose={() => setDialog(null)} />}
      {upd.Dialog}
    </>
  );
}
