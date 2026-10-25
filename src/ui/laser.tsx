// Редактор чертежей PSBees — векторное рисование чертежей, развёрток и деталей
// в стиле CorelDRAW: точный вывод в DXF, PDF, EPS, PLT и SVG и импорт из тех же
// форматов. Слои у чертежа свои: пользователь добавляет «Слой 1», «Слой 2», …
// и задаёт им имя, цвет и тип линии (сплошная, штриховая, заливка, служебная).
//
// Станочная часть — G-Code, симуляция обработки, задание на станок и режимы
// обработки по слоям — в коде сохранена, но скрыта из интерфейса: её возвращает
// флаг MACHINE_UI (src/laser/features.ts).
//
// Координаты — миллиметры листа, Y вверх; (0;0) — левый нижний угол листа.

import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type PointerEvent as RPointerEvent, type ReactNode, type WheelEvent as RWheelEvent,
} from 'react';
import { Ic } from './icons';
import { ConfirmDialog, NI, SI } from './widgets';
import { ModeSwitcher, type WorkspaceMode } from './mode-switcher';
import {
  LaserJobPanel, LaserLayersPanel, LaserMaterialPanel, LaserObjectsPanel, LaserPropsPanel,
  type PropsActions,
} from './laser-panels';
import { UnfoldWindow, type UnfoldApplyPayload } from './unfold-window';
import {
  LaserExportDialog, LaserSheetDialog, LaserSimDialog, LaserTraceDialog,
  type LaserDxfSplit, type LaserExportFormat,
} from './laser-dialogs';
import {
  DEFAULT_GCODE_OPTIONS, buildLaserSimulation, exportLaserDxf, exportLaserGCode, exportLaserSvg,
  type GCodeExportOptions, type LaserSimulation,
} from '../laser/export';
import {
  DEFAULT_DXF_OPTIONS, exportDxfPerLayer, type DxfOptions,
} from '../laser/dxf';
import {
  DEFAULT_VECTOR_OPTIONS, exportVectorEps, exportVectorPdf, exportVectorPlt,
  type VectorExportOptions,
} from '../laser/corel';
import { importVectorData } from '../laser/corel-parse';
import { MACHINE_UI } from '../laser/features';
import { BoxStudio, type BoxApplyPayload } from './box-studio';
import {
  loadLaserDraft, parseLaserProject, safeFileName, saveLaserDraft, serializeLaserProject,
} from '../laser/project';
import {
  MATERIAL_PRESETS, addLaserLayer, adoptShapes, alignShapes, arrayShapes, autoNestShapesEx,
  booleanShapes, docContourLength, ensureLayerByName, ensureRoleLayer, filletShapeCorners, hitShape,
  layerIds, layerOf, luid, mirrorShape, newLaserDoc, offsetShape, removeLaserLayer,
  rotateShape, scaleShape, selectionBBox, shapeBBox, shapeToPath, shapeToPolylines, translateShape,
  type AlignMode, type BooleanOp, type LaserDoc, type LaserGroup, type LaserLayerConfig, type LaserLayerId,
  type LaserShape, type MaterialPreset, type PathNode, type PathShape, type Pt,
} from '../laser/model';
import {
  constrainAngle, deleteNode, insertNode, moveHandle, moveNode, nearestHandle, nearestNodeIndex,
  nearestSnapPoint, objectSnapPoints, toggleSmooth,
} from '../laser/nodes';
import {
  AUX_MODES, DEFAULT_AUX_PARAMS, buildAuxLine, pickBase, previewAuxLine,
  type AuxLine, type AuxMode, type AuxParams,
} from '../laser/construction';
import {
  breakApartAtIntersections, breakCurve, extendCurve, trimCurve, trimPreview, trimmable,
  type TrimEdit, type TrimMode, type TrimOptions, type TrimPreview,
} from '../laser/trim';
import {
  drawLaserGrid, drawLaserShape, drawLaserSheet, drawMarquee, drawPathNodes, drawSelectionBox,
  drawSelectionLabel, laserTheme, selectionHandlePoints, toScreen, toWorld,
  type LaserGridConf, type LaserView, type SelectionHandleId,
} from '../laser/render';
import { download, makeZip } from '../pcb/zip';
import { perfDpr } from '../perf';
import type { ThemeId } from '../pcb/render';

// ---------------- инструменты ----------------

export type LaserToolId =
  | 'select' | 'shape' | 'trim' | 'pan' | 'pen' | 'line' | 'rect' | 'ellipse' | 'polygon' | 'text' | 'dim'
  | 'aux';

export type { TrimMode };

export const TRIM_MODES: { id: TrimMode; name: string; key: string; hint: string }[] = [
  { id: 'trim', name: 'Усечь', key: '1', hint: 'кривая режется по пересечениям, кусок под курсором удаляется' },
  { id: 'extend', name: 'Продлить', key: '2', hint: 'ближайший конец кривой дотягивается до границы по касательной' },
  { id: 'break', name: 'Разрезать', key: '3', hint: 'кривая делится в точке клика (замкнутый контур становится открытым)' },
];

const LASER_TOOLS: { id: LaserToolId; name: string; icon: string; key: string; hint: string }[] = [
  { id: 'select', name: 'Выбор', icon: 'select', key: 'V', hint: 'выделение, перенос, масштаб маркерами, Shift — добавить к выделению' },
  { id: 'shape', name: 'Форма (узлы кривой)', icon: 'node', key: 'F10', hint: 'правка узлов и рычагов Безье; двойной клик по кривой — новый узел, по узлу — удалить; S — гладкий/угловой' },
  { id: 'trim', name: 'Усечь кривую', icon: 'cut-curve', key: 'X', hint: 'клик по кривой отрезает кусок до пересечения; 1 — усечь, 2 — продлить, 3 — разрезать; Ctrl+Shift+X — разбить всё по пересечениям' },
  { id: 'pan', name: 'Панорама листа', icon: 'fit', key: 'H', hint: 'перемещение вида (то же — средняя кнопка мыши или пробел)' },
  { id: 'pen', name: 'Перо (кривая Безье)', icon: 'bezier', key: 'P', hint: 'клик — угловой узел, клик с протяжкой — гладкий узел с рычагами; Enter — закончить, клик по первому узлу — замкнуть; инструмент остаётся активным, Esc или V — к выбору' },
  { id: 'line', name: 'Отрезок', icon: 'line', key: 'L', hint: 'два клика; Shift — угол кратный 15°; инструмент остаётся активным, Esc или V — к выбору' },
  { id: 'rect', name: 'Прямоугольник', icon: 'rect', key: 'R', hint: 'протяжка мышью; Shift — квадрат; клик без протяжки — квадрат 20×20 мм; инструмент остаётся активным, Esc или V — к выбору' },
  { id: 'ellipse', name: 'Эллипс / дуга', icon: 'circle', key: 'E', hint: 'протяжка мышью; Shift — окружность; клик без протяжки — окружность 20 мм; углы дуги — в свойствах; Esc или V — к выбору' },
  { id: 'polygon', name: 'Многоугольник / звезда', icon: 'polygon', key: 'Y', hint: 'протяжка задаёт габарит; клик без протяжки — 20 мм; число углов и звезда — в свойствах; Esc или V — к выбору' },
  { id: 'text', name: 'Текст (надпись)', icon: 'text', key: 'T', hint: 'клик ставит надпись; текст, кегль и толщину линии меняйте в свойствах справа' },
  { id: 'dim', name: 'Размерная линия', icon: 'ruler', key: 'D', hint: 'две точки + третий клик задаёт вынос; служебный слой «Размеры» не выводится в файлы' },
  {
    id: 'aux', name: 'Вспомогательная линия', icon: 'aux', key: 'A',
    hint: 'перпендикуляр, параллель, касательная, биссектриса, серединный перпендикуляр, направление под углом, горизонталь и вертикаль; линии живут на служебном слое и не попадают в файлы',
  },
];

const TOOL_GROUPS: LaserToolId[][] = [
  ['select', 'shape', 'trim', 'pan'],
  ['pen', 'line'],
  ['rect', 'ellipse', 'polygon'],
  ['text', 'dim', 'aux'],
];

/** Иконки режимов вспомогательных линий. */
const AUX_ICONS: Record<AuxMode, string> = {
  perp: 'angle90', parallel: 'offset', tangent: 'circle', angle: 'angle45',
  midperp: 'ruler', bisector: 'anglefree', h: 'axis-h', v: 'axis-v',
};

/** Слой вспомогательных линий: служебный, поэтому в файлы не выводится. */
const AUX_LAYER_NAME = 'Вспомогательные';
const AUX_LAYER_COLOR = '#94a3b8';

const TOOL_KEYS: Record<LaserToolId, string> = LASER_TOOLS.reduce(
  (acc, t) => ({ ...acc, [t.id]: t.key }),
  {} as Record<LaserToolId, string>
);

const HISTORY_LIMIT = 120;
const MIN_DRAW_MM = 0.2;

// ---------------- черновик в браузере ----------------
// Файл проекта (.pslaser) и автосохранение черновика — в laser/project.ts
// (чистая логика, проверяется без DOM).

// ---------------- черновики рисования ----------------

type Draft =
  | { t: 'line'; layer: LaserLayerId; a: Pt; b: Pt; shift: boolean }
  | { t: 'rect'; layer: LaserLayerId; a: Pt; b: Pt; shift: boolean }
  | { t: 'ellipse'; layer: LaserLayerId; a: Pt; b: Pt; shift: boolean }
  | { t: 'polygon'; layer: LaserLayerId; a: Pt; b: Pt; shift: boolean }
  | { t: 'pen'; layer: LaserLayerId; nodes: PathNode[]; closed: boolean; dragging: boolean; shift: boolean; cursor?: Pt }
  | { t: 'dim'; a: Pt; b: Pt | null; c: Pt | null };

type Drag =
  | { mode: 'pan'; px: number; py: number; view: LaserView }
  | { mode: 'move'; start: Pt; orig: LaserShape[]; moved: boolean }
  | { mode: 'resize'; handle: SelectionHandleId; bb: [number, number, number, number]; orig: LaserShape[]; moved: boolean; uniform: boolean }
  | { mode: 'marquee'; a: Pt; shift: boolean; base: Set<string>; moved: boolean }
  | { mode: 'draw'; t: 'rect' | 'ellipse' | 'polygon'; layer: LaserLayerId; a: Pt; aRaw: Pt; shift: boolean }
  | { mode: 'node'; id: string; idx: number; orig: PathShape; moved: boolean }
  | { mode: 'handle'; id: string; idx: number; which: 'cp1' | 'cp2'; orig: PathShape; moved: boolean };

/** Знаковое расстояние от точки c до прямой ab (для выноса размерной линии). */
function perpOffset(a: Pt, b: Pt, c: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return ((c.x - a.x) * -dy + (c.y - a.y) * dx) / len;
}

/** Черновик рисования → временная фигура для предпросмотра. */
export function draftToShape(d: Draft): LaserShape | null {
  switch (d.t) {
    case 'line':
      if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < 1e-4) return null;
      return {
        id: 'draft', kind: 'path', layer: d.layer, name: 'Отрезок',
        nodes: [{ x: d.a.x, y: d.a.y }, { x: d.b.x, y: d.b.y }], closed: false, filled: false,
      };
    case 'rect': {
      const x = Math.min(d.a.x, d.b.x);
      const y = Math.min(d.a.y, d.b.y);
      const w = Math.abs(d.b.x - d.a.x);
      const h = Math.abs(d.b.y - d.a.y);
      if (w < 1e-3 || h < 1e-3) return null;
      return { id: 'draft', kind: 'rect', layer: d.layer, name: 'Прямоугольник', x, y, w, h, rx: 0, rot: 0, filled: false };
    }
    case 'ellipse': {
      const w = Math.abs(d.b.x - d.a.x);
      const h = Math.abs(d.b.y - d.a.y);
      if (w < 1e-3 || h < 1e-3) return null;
      return {
        id: 'draft', kind: 'ellipse', layer: d.layer, name: 'Эллипс',
        cx: (d.a.x + d.b.x) / 2, cy: (d.a.y + d.b.y) / 2,
        rx: w / 2, ry: h / 2, rot: 0, startAngle: 0, endAngle: 360, filled: false,
      };
    }
    case 'polygon': {
      const w = Math.abs(d.b.x - d.a.x);
      const h = Math.abs(d.b.y - d.a.y);
      const r = Math.min(w, h) / 2;
      if (r < 1e-3) return null;
      return {
        id: 'draft', kind: 'polygon', layer: d.layer, name: 'Многоугольник',
        cx: (d.a.x + d.b.x) / 2, cy: (d.a.y + d.b.y) / 2, r,
        sides: 6, star: false, innerRatio: 0.45, rot: 0, filled: false,
      };
    }
    case 'pen':
      if (d.nodes.length < 2) return null;
      return {
        id: 'draft', kind: 'path', layer: d.layer, name: 'Кривая',
        nodes: d.nodes, closed: d.closed, filled: false,
      };
    case 'dim': {
      if (!d.b) return null;
      const off = d.c ? perpOffset(d.a, d.b, d.c) : 8;
      return {
        id: 'draft', kind: 'dim', layer: 'guide', name: 'Размер',
        x1: d.a.x, y1: d.a.y, x2: d.b.x, y2: d.b.y,
        offset: Math.abs(off) < 2 ? (off < 0 ? -2 : 2) : off,
      };
    }
  }
}

/** Размер объекта, который создаётся по одному клику без протяжки. */
const CLICK_SHAPE_MM = 20;

/**
 * Фигура по клику без протяжки: 20×20 мм с центром в точке клика.
 * Инструмент обязан отзываться на клик — раньше в этом случае не происходило
 * ничего, и рисование выглядело сломанным.
 */
function clickShape(t: 'rect' | 'ellipse' | 'polygon', layer: LaserLayerId, p: Pt): LaserShape | null {
  const half = CLICK_SHAPE_MM / 2;
  const a = { x: p.x - half, y: p.y - half };
  const b = { x: p.x + half, y: p.y + half };
  return draftToShape(t === 'rect'
    ? { t: 'rect', layer, a, b, shift: false }
    : t === 'ellipse'
      ? { t: 'ellipse', layer, a, b, shift: false }
      : { t: 'polygon', layer, a, b, shift: false });
}

/**
 * Черновик рисуется с временным id 'draft' — для предпросмотра этого довольно.
 * Но в документ объект обязан попасть с уникальным id: иначе каждый следующий
 * нарисованный прямоугольник «сливался» с предыдущим (общее выделение, общая
 * правка и удаление сразу всех), и рисование выглядело сломанным.
 */
function withRealId(shape: LaserShape): LaserShape {
  if (shape.id !== 'draft') return shape;
  return { ...shape, id: luid(shape.kind) };
}

/** Ограничение прямоугольника/эллипса: Shift — квадрат (окружность). */
function constrainBox(a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: a.x + Math.sign(dx || 1) * side, y: a.y + Math.sign(dy || 1) * side };
}

// ---------------- компонент ----------------

export function LaserEditor({
  mode,
  onModeChange,
  theme,
  setTheme,
  onCloseApp,
  cloudUser,
  onOpenBoxes,
  boxPayload,
  onBoxApplied,
}: {
  mode: WorkspaceMode;
  onModeChange: (next: WorkspaceMode) => void;
  theme: ThemeId;
  setTheme: (next: ThemeId) => void;
  onCloseApp: () => void;
  cloudUser?: { id: string; email?: string } | null;
  /** Открыть генератор коробок — самостоятельное окно программы. */
  onOpenBoxes?: () => void;
  /** Раскладка из окна коробок, которую нужно поместить на лист. */
  boxPayload?: BoxApplyPayload | null;
  /** Ответ окну коробок: раскладка принята и помещена на лист. */
  onBoxApplied?: () => void;
}) {
  const [doc, setDocState] = useState<LaserDoc>(() => loadLaserDraft(cloudUser?.id) ?? newLaserDoc());
  const docRef = useRef(doc);
  const setDoc = useCallback((next: LaserDoc) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const past = useRef<{ doc: LaserDoc; label: string }[]>([]);
  const future = useRef<{ doc: LaserDoc; label: string }[]>([]);
  const [histTick, setHistTick] = useState(0);
  const histStart = useRef<LaserDoc | null>(null);

  const [sel, setSelState] = useState<Set<string>>(new Set());
  const selRef = useRef(sel);
  const setSel = useCallback((next: Set<string>) => {
    selRef.current = next;
    setSelState(next);
  }, []);

  const [tool, setTool] = useState<LaserToolId>('select');
  // активный слой — первый слой чертежа; эффект ниже следит, чтобы он существовал
  const [activeLayer, setActiveLayer] = useState<LaserLayerId>(() => layerIds(doc)[0] ?? 'l1');
  const [view, setView] = useState<LaserView>({ s: 3, ox: 80, oy: 80 });
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [grid, setGrid] = useState<LaserGridConf & { snap: boolean }>({
    step: 1, major: 10, on: true, style: 'lines', snap: true,
  });
  // слева по умолчанию дерево объектов, слои — вторая вкладка
  const [leftTab, setLeftTab] = useState<'objects' | 'layers'>('objects');
  const [objFilter, setObjFilter] = useState('');
  const [msg, setMsg] = useState<{ text: string; ok: boolean | null } | null>(null);
  const [dialog, setDialog] = useState<'sheet' | 'new' | 'export' | 'sim' | 'trace' | 'boxes' | 'unfold' | null>(null);
  const [confirmAsk, setConfirmAsk] = useState<{ title: string; text: string; ok: string; onOk: () => void } | null>(null);
  const [sim, setSim] = useState<LaserSimulation | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [gcode, setGcode] = useState<GCodeExportOptions>({ ...DEFAULT_GCODE_OPTIONS });
  const [dxfOpts, setDxfOpts] = useState<DxfOptions>({ ...DEFAULT_DXF_OPTIONS });
  const [dxfSplit, setDxfSplit] = useState<LaserDxfSplit>('single');
  // параметры векторных форматов обмена (PDF, EPS, PLT, SVG): толщина линии,
  // слои PDF (OCG), перья плоттера, допуск аппроксимации кривых
  const [vecOpts, setVecOpts] = useState<VectorExportOptions>({ ...DEFAULT_VECTOR_OPTIONS });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [marquee, setMarquee] = useState<{ a: Pt; b: Pt } | null>(null);
  const [nodeEdit, setNodeEdit] = useState<{ id: string; node: number | null } | null>(null);
  const [trimMode, setTrimMode] = useState<TrimMode>('trim');
  const [trimOnlySel, setTrimOnlySel] = useState(false);
  // вспомогательные линии: режим, параметры построения и незаконченные клики
  const [auxMode, setAuxMode] = useState<AuxMode>('perp');
  const [auxParams, setAuxParams] = useState<AuxParams>({ ...DEFAULT_AUX_PARAMS });
  const [auxDraft, setAuxDraft] = useState<{ pts: Pt[]; baseId: string | null } | null>(null);
  const [auxPreview, setAuxPreview] = useState<AuxLine | null>(null);
  const [trimHover, setTrimHover] = useState<{ id: string; preview: TrimPreview } | null>(null);
  const trimHoverAt = useRef<{ id: string | null; x: number; y: number }>({ id: null, x: 0, y: 0 });
  const [mouse, setMouse] = useState({ px: -100, py: -100, wx: 0, wy: 0 });
  const [snapMark, setSnapMark] = useState<Pt | null>(null);
  const [arrayState, setArrayState] = useState({ rows: 2, cols: 2, gapX: 5, gapY: 5 });
  const [contourState, setContourState] = useState<{ delta: number; layer: LaserLayerId }>(
    () => ({ delta: 1, layer: layerIds(doc)[0] ?? 'l1' })
  );
  const [polygonSides, setPolygonSides] = useState(6);
  const [polygonStar, setPolygonStar] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  // Незаконченное построение вспомогательной линии живёт только с инструментом
  useEffect(() => {
    if (tool !== 'aux') {
      setAuxDraft(null);
      setAuxPreview(null);
    }
  }, [tool]);

  // Активный слой всегда существует: после нового проекта, открытия файла или
  // удаления слоя переключаемся на первый доступный.
  useEffect(() => {
    if (doc.layers[activeLayer]) return;
    const first = layerIds(doc)[0];
    setActiveLayer(first ?? 'l1');
    setContourState((c) => (doc.layers[c.layer] ? c : { ...c, layer: first ?? 'l1' }));
  }, [doc, activeLayer]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const baseRaf = useRef(0);
  const overRaf = useRef(0);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const th = laserTheme(theme);

  // ---------------- история ----------------

  const commit = useCallback((next: LaserDoc, label: string, silent = false) => {
    past.current = [...past.current, { doc: docRef.current, label }].slice(-HISTORY_LIMIT);
    future.current = [];
    setDoc(next);
    setHistTick((t) => t + 1);
    setSim(null);
    if (!silent) setMsg({ text: label, ok: true });
  }, [setDoc]);

  /** Финал перетаскивания: исходное состояние уходит в историю одним шагом. */
  const commitDrag = useCallback((label: string) => {
    const start = histStart.current;
    histStart.current = null;
    if (!start || start === docRef.current) return;
    past.current = [...past.current, { doc: start, label }].slice(-HISTORY_LIMIT);
    future.current = [];
    setHistTick((t) => t + 1);
    setSim(null);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [...future.current, { doc: docRef.current, label: prev.label }];
    setDoc(prev.doc);
    setHistTick((t) => t + 1);
    setSel(new Set());
    setDraft(null);
    setNodeEdit(null);
    setSim(null);
    setMsg({ text: `Отменено: ${prev.label}`, ok: null });
  }, [setDoc, setSel]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current = [...past.current, { doc: docRef.current, label: next.label }].slice(-HISTORY_LIMIT);
    setDoc(next.doc);
    setHistTick((t) => t + 1);
    setSel(new Set());
    setSim(null);
    setMsg({ text: `Повторено: ${next.label}`, ok: null });
  }, [setDoc, setSel]);

  // ---------------- черновик в браузере ----------------

  useEffect(() => {
    const t = window.setTimeout(() => {
      if (saveLaserDraft(doc, cloudUser?.id)) setSavedTick(Date.now());
    }, 600);
    return () => window.clearTimeout(t);
  }, [doc, cloudUser]);

  // ---------------- размер холста ----------------

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback((d?: LaserDoc) => {
    // Холст ещё не размечен (нулевой размер) — вид не трогаем, иначе масштаб
    // уйдёт в минимум и лист «исчезнет».
    if (size.w < 60 || size.h < 60) return;
    const dd = d ?? docRef.current;
    const w = Math.max(dd.w, 1);
    const h = Math.max(dd.h, 1);
    const s = Math.max(0.05, Math.min((size.w - 60) / w, (size.h - 60) / h));
    setView({ s, ox: (size.w - w * s) / 2, oy: (size.h + h * s) / 2 });
  }, [size.w, size.h]);

  useEffect(() => {
    if (!fitted.current && size.w > 100) {
      fitted.current = true;
      fit();
    }
  }, [size, fit]);

  const zoomAt = useCallback((px: number, py: number, k: number) => {
    setView((v) => {
      const s = Math.max(0.05, Math.min(400, v.s * k));
      const ratio = s / v.s;
      return { s, ox: px - (px - v.ox) * ratio, oy: py - (py - v.oy) * ratio };
    });
  }, []);

  // ---------------- производные данные ----------------

  const selShapes = useMemo(() => doc.shapes.filter((s) => sel.has(s.id)), [doc.shapes, sel]);
  const selBBox = useMemo(() => selectionBBox(selShapes), [selShapes]);

  const pickable = useCallback((s: LaserShape) => {
    if (s.hidden || s.locked) return false;
    // Слой может быть «чужим»: старый проект, генератор или импорт принесли id,
    // которого нет в doc.layers. layerOf всегда отдаёт рабочую настройку —
    // иначе объект нельзя было ни выбрать, ни привязаться к нему.
    const cfg = layerOf(doc, s.layer);
    return cfg.visible !== false && cfg.locked !== true;
  }, [doc]);

  // Точки привязки к объектам: узлы кривых, вершины и середины рёбер примитивов,
  // четверти окружностей и центры. Считаются в nodes.ts — там же учитываются
  // примитивы, у которых нет поля nodes.
  const snapPoints = useMemo(
    () => objectSnapPoints(doc.shapes.filter(pickable)),
    [doc.shapes, pickable],
  );

  /** Привязка курсора: сначала к объектам, затем к сетке. */
  const snapWorld = useCallback((p: Pt, alt: boolean): Pt => {
    if (alt || !grid.snap) return p;
    const tol = 7 / Math.max(view.s, 0.001);
    const obj = nearestSnapPoint(snapPoints, p, tol);
    if (obj) return obj;
    // К сетке тянем, только когда её шаг различим на экране: на обзорном
    // масштабе миллиметровая сетка «залипала» под курсором и мешала рисовать.
    if (grid.on && grid.step > 0 && grid.step * view.s >= 3) {
      return {
        x: Math.round(p.x / grid.step) * grid.step,
        y: Math.round(p.y / grid.step) * grid.step,
      };
    }
    return p;
  }, [grid, snapPoints, view.s]);

  /** Рабочий слой для новых объектов: служебный слой для графики не берём. */
  const workLayer = useCallback((): LaserLayerId => {
    const d = docRef.current;
    if (layerOf(d, activeLayer).mode !== 'guide') return activeLayer;
    return layerIds(d).find((x) => layerOf(d, x).mode !== 'guide') ?? activeLayer;
  }, [activeLayer]);

  /** Пунктир слоя на холсте — как он ляжет в файл. */
  const dashOf = useCallback((cfg: LaserLayerConfig): number[] | undefined => {
    if (cfg.mode === 'guide') return [7, 4];
    if ((cfg.mode === 'fold' || cfg.mode === 'score') && cfg.dashLen > 0 && cfg.gapLen > 0) {
      return [Math.max(1, cfg.dashLen * view.s), Math.max(1, cfg.gapLen * view.s)];
    }
    return undefined;
  }, [view.s]);

  const pickShape = useCallback((p: Pt): LaserShape | null => {
    const tol = Math.max(0.6, 6 / Math.max(view.s, 0.001));
    for (let i = doc.shapes.length - 1; i >= 0; i--) {
      const s = doc.shapes[i];
      if (!pickable(s)) continue;
      if (hitShape(s, p, tol)) return s;
    }
    return null;
  }, [doc.shapes, pickable, view.s]);

  // ---------------- операции над объектами ----------------

  const patchSelected = useCallback((patch: Partial<LaserShape>, label = 'Изменён объект') => {
    if (!selRef.current.size) return;
    const ids = selRef.current;
    commit({
      ...docRef.current,
      shapes: docRef.current.shapes.map((s) => (ids.has(s.id) ? ({ ...s, ...patch } as LaserShape) : s)),
    }, label);
  }, [commit]);

  const replaceShapes = useCallback((map: Map<string, LaserShape>, label: string, keepHistory = true) => {
    const shapes = docRef.current.shapes.map((s) => map.get(s.id) ?? s);
    const next = { ...docRef.current, shapes };
    if (keepHistory) commit(next, label);
    else setDoc(next);
  }, [commit, setDoc]);

  const applyGeometry = useCallback((g: { x?: number; y?: number; w?: number; h?: number }) => {
    const bb = selectionBBox(docRef.current.shapes.filter((s) => selRef.current.has(s.id)));
    if (!bb) return;
    const ids = selRef.current;
    const cur = docRef.current.shapes.filter((s) => ids.has(s.id));
    let map = new Map<string, LaserShape>(cur.map((s) => [s.id, s]));

    if (g.w !== undefined || g.h !== undefined) {
      const w0 = Math.max(bb[2] - bb[0], 1e-6);
      const h0 = Math.max(bb[3] - bb[1], 1e-6);
      const sx = g.w !== undefined ? Math.max(0.01, g.w) / w0 : 1;
      const sy = g.h !== undefined ? Math.max(0.01, g.h) / h0 : 1;
      const next = new Map<string, LaserShape>();
      for (const [id, s] of map) next.set(id, scaleShape(s, bb[0], bb[1], sx, sy));
      map = next;
    }
    if (g.x !== undefined || g.y !== undefined) {
      const nb = selectionBBox([...map.values()]) ?? bb;
      const dx = (g.x ?? nb[0]) - nb[0];
      const dy = (g.y ?? nb[1]) - nb[1];
      const next = new Map<string, LaserShape>();
      for (const [id, s] of map) next.set(id, translateShape(s, dx, dy));
      map = next;
    }
    replaceShapes(map, 'Изменён размер/позиция');
  }, [replaceShapes]);

  const rotateSel = useCallback((deg: number) => {
    const bb = selectionBBox(docRef.current.shapes.filter((s) => selRef.current.has(s.id)));
    if (!bb) return;
    const cx = (bb[0] + bb[2]) / 2;
    const cy = (bb[1] + bb[3]) / 2;
    const map = new Map<string, LaserShape>();
    for (const s of docRef.current.shapes) {
      if (selRef.current.has(s.id)) map.set(s.id, rotateShape(s, cx, cy, deg));
    }
    replaceShapes(map, `Поворот на ${deg}°`);
  }, [replaceShapes]);

  const mirrorSel = useCallback((axis: 'h' | 'v') => {
    const bb = selectionBBox(docRef.current.shapes.filter((s) => selRef.current.has(s.id)));
    if (!bb) return;
    const cx = (bb[0] + bb[2]) / 2;
    const cy = (bb[1] + bb[3]) / 2;
    const map = new Map<string, LaserShape>();
    for (const s of docRef.current.shapes) {
      if (selRef.current.has(s.id)) map.set(s.id, mirrorShape(s, cx, cy, axis));
    }
    replaceShapes(map, axis === 'h' ? 'Отражено по горизонтали' : 'Отражено по вертикали');
  }, [replaceShapes]);

  const duplicateSel = useCallback(() => {
    const cur = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (!cur.length) return;
    const step = Math.max(2, grid.step * 5);
    const copies = cur.map((s) => ({
      ...translateShape(s, step, -step),
      id: luid(s.kind),
      name: `${s.name} (копия)`,
    }));
    commit({ ...docRef.current, shapes: [...docRef.current.shapes, ...copies] }, `Дубликат: ${copies.length} шт.`);
    setSel(new Set(copies.map((c) => c.id)));
  }, [commit, grid.step, setSel]);

  const deleteSel = useCallback(() => {
    const ids = new Set(
      docRef.current.shapes.filter((s) => selRef.current.has(s.id) && !s.locked).map((s) => s.id)
    );
    if (!ids.size) {
      setMsg({ text: 'Нечего удалять: выделение пусто или объекты заблокированы.', ok: false });
      return;
    }
    const groups = docRef.current.groups.filter((g) =>
      docRef.current.shapes.some((s) => s.groupId === g.id && !ids.has(s.id))
    );
    commit({
      ...docRef.current,
      shapes: docRef.current.shapes.filter((s) => !ids.has(s.id)),
      groups,
    }, `Удалено объектов: ${ids.size}`);
    setSel(new Set());
    setNodeEdit(null);
  }, [commit, setSel]);

  const groupSel = useCallback(() => {
    const ids = selRef.current;
    if (ids.size < 2) return;
    const id = luid('grp');
    const n = docRef.current.groups.length + 1;
    commit({
      ...docRef.current,
      groups: [...docRef.current.groups, { id, name: `Группа ${n}` }],
      shapes: docRef.current.shapes.map((s) => (ids.has(s.id) ? { ...s, groupId: id } : s)),
    }, `Сгруппировано объектов: ${ids.size}`);
  }, [commit]);

  const ungroupSel = useCallback(() => {
    const ids = selRef.current;
    const touched = new Set(
      docRef.current.shapes.filter((s) => ids.has(s.id) && s.groupId).map((s) => s.groupId as string)
    );
    if (!touched.size) {
      setMsg({ text: 'В выделении нет групп.', ok: false });
      return;
    }
    const groups = docRef.current.groups.filter((g) => !touched.has(g.id));
    commit({
      ...docRef.current,
      groups,
      shapes: docRef.current.shapes.map((s) =>
        ids.has(s.id) && s.groupId && touched.has(s.groupId) ? { ...s, groupId: undefined } : s
      ),
    }, `Разгруппировано: ${touched.size}`);
  }, [commit]);

  const orderSel = useCallback((cmd: 'front' | 'back' | 'forward' | 'backward') => {
    const ids = selRef.current;
    if (!ids.size) return;
    const list = docRef.current.shapes;
    const picked = list.filter((s) => ids.has(s.id));
    const rest = list.filter((s) => !ids.has(s.id));
    let shapes: LaserShape[];
    if (cmd === 'front') shapes = [...rest, ...picked];
    else if (cmd === 'back') shapes = [...picked, ...rest];
    else {
      shapes = rest.slice();
      const firstIdx = list.findIndex((s) => ids.has(s.id));
      const at = cmd === 'forward' ? Math.min(shapes.length, firstIdx + picked.length) : Math.max(0, firstIdx - 1);
      shapes.splice(at, 0, ...picked);
    }
    commit({ ...docRef.current, shapes }, 'Изменён порядок объектов', true);
  }, [commit]);

  const alignSel = useCallback((mode: AlignMode) => {
    const shapes = alignShapes(docRef.current.shapes, selRef.current, mode, docRef.current.w, docRef.current.h);
    commit({ ...docRef.current, shapes }, 'Выравнивание объектов', true);
  }, [commit]);

  const booleanSel = useCallback((op: BooleanOp) => {
    // Порядок как в CorelDRAW: первый (нижний по z) объект — целевой
    const picked = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (picked.length < 2) {
      setMsg({ text: 'Для булевой операции нужно выделить не менее двух объектов.', ok: false });
      return;
    }
    try {
      const result = booleanShapes(picked, op);
      if (!result.length) {
        setMsg({ text: 'Операция не дала результата: объекты не пересекаются.', ok: false });
        return;
      }
      const ids = new Set(picked.map((s) => s.id));
      const names: Record<BooleanOp, string> = {
        union: 'Объединение (Weld)',
        subtract: 'Вычитание (Trim)',
        intersect: 'Пересечение',
        xor: 'Исключение (XOR)',
      };
      const at = docRef.current.shapes.findIndex((s) => ids.has(s.id));
      const shapes = [
        ...docRef.current.shapes.filter((s) => !ids.has(s.id)),
      ];
      shapes.splice(Math.max(0, at), 0, ...result);
      commit({ ...docRef.current, shapes }, `${names[op]}: ${picked.length} → ${result.length}`);
      setSel(new Set(result.map((s) => s.id)));
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Не удалось выполнить булеву операцию.', ok: false });
    }
  }, [commit, setSel]);

  const contourSel = useCallback((delta: number, layer?: LaserLayerId) => {
    const picked = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (!picked.length) {
      setMsg({ text: 'Выделите объект для построения контура.', ok: false });
      return;
    }
    try {
      const created: LaserShape[] = [];
      for (const s of picked) {
        created.push(...offsetShape(s, delta, layer));
      }
      if (!created.length) {
        setMsg({ text: 'Контур не построен: объект слишком мал для такого отступа.', ok: false });
        return;
      }
      commit({ ...docRef.current, shapes: [...docRef.current.shapes, ...created] },
        `Контур ${delta > 0 ? '+' : ''}${delta.toFixed(2)} мм: ${created.length} объект(ов)`);
      setSel(new Set(created.map((s) => s.id)));
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Ошибка построения контура.', ok: false });
    }
  }, [commit, setSel]);

  // ---------------- усечь / продлить / разрезать кривую ----------------

  /** Границы реза: все видимые объекты или только выделенные. */
  const trimOptions = useCallback((): TrimOptions => ({
    boundaryIds: trimOnlySel ? new Set(selRef.current) : undefined,
    self: true,
    tol: Math.max(0.8, 8 / Math.max(view.s, 0.001)),
    sheet: { w: docRef.current.w, h: docRef.current.h },
    // служебный слой узнаётся по типу линии своего слоя, а не по его имени
    doc: docRef.current,
  }), [trimOnlySel, view.s]);

  /** Правка документа после инструмента: старые объекты уходят, новые встают на их место. */
  const applyTrimEdit = useCallback((edit: TrimEdit) => {
    if (!edit.ok) {
      setMsg({ text: edit.message, ok: false });
      return;
    }
    const list = docRef.current.shapes;
    const removeSet = new Set(edit.remove);
    const at = list.findIndex((s) => removeSet.has(s.id));
    const next = list.filter((s) => !removeSet.has(s.id));
    next.splice(Math.max(0, at), 0, ...edit.add);
    commit({ ...docRef.current, shapes: next }, edit.message);
    if (trimOnlySel) {
      // границы остаются выделенными: следующим кликом можно резать снова
      const keep = new Set(selRef.current);
      edit.remove.forEach((id) => keep.delete(id));
      edit.add.forEach((sh) => keep.add(sh.id));
      setSel(keep);
    } else {
      setSel(new Set(edit.add.map((sh) => sh.id)));
    }
    trimHoverAt.current = { id: null, x: 0, y: 0 };
    setTrimHover(null);
  }, [commit, setSel, trimOnlySel]);

  const runTrim = useCallback((id: string, at: Pt) => {
    const shapes = docRef.current.shapes;
    const opts = trimOptions();
    const edit = trimMode === 'trim'
      ? trimCurve(shapes, id, at, opts)
      : trimMode === 'extend'
        ? extendCurve(shapes, id, at, opts)
        : breakCurve(shapes, id, at, opts);
    applyTrimEdit(edit);
  }, [trimMode, trimOptions, applyTrimEdit]);

  /** Разбить кривые по всем взаимным пересечениям (выделение или весь лист). */
  const breakApartSel = useCallback(() => {
    const ids = new Set(docRef.current.shapes.filter((s) => selRef.current.has(s.id)).map((s) => s.id));
    const res = breakApartAtIntersections(docRef.current.shapes, ids, { doc: docRef.current });
    if (!res.split) {
      setMsg({ text: 'Пересечений не найдено: разбивать нечего.', ok: false });
      return;
    }
    commit({ ...docRef.current, shapes: res.shapes },
      `Разбито по пересечениям: ${res.split} кривых → ${res.shapes.length} объектов`);
    setSel(new Set());
  }, [commit, setSel]);

  /** Что подсветить под курсором инструмента «Усечь кривую». */
  const updateTrimHover = useCallback((raw: Pt) => {
    const hit = pickShape(raw);
    const id = hit && trimmable(hit, docRef.current) ? hit.id : null;
    const prev = trimHoverAt.current;
    const moved = Math.hypot(prev.x - raw.x, prev.y - raw.y) > 0.05;
    if (prev.id === id && (!moved || !id)) {
      // цель та же и курсор на месте: превью оставляем, гасим только пустое
      // (setTrimHover(null) при уже пустом состоянии перерисовку не вызывает)
      if (!id) setTrimHover(null);
      return;
    }
    trimHoverAt.current = { id, x: raw.x, y: raw.y };
    if (!id) { setTrimHover(null); return; }
    let preview: TrimPreview | null = null;
    try {
      preview = trimPreview(docRef.current.shapes, id, raw, trimMode, trimOptions());
    } catch { preview = null; }
    setTrimHover(preview ? { id, preview } : null);
  }, [pickShape, trimMode, trimOptions]);

  const toCurves = useCallback(() => {
    const picked = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (!picked.length) return;
    const ids = new Set(picked.map((s) => s.id));
    const converted: LaserShape[] = [];
    for (const s of picked) {
      if (s.kind === 'dim') continue;
      converted.push(...shapeToPath(s));
    }
    if (!converted.length) {
      setMsg({ text: 'Размерную линию нельзя преобразовать в кривую.', ok: false });
      return;
    }
    const shapes = docRef.current.shapes.flatMap((s) => (ids.has(s.id)
      ? (s.kind === 'dim' ? [s] : shapeToPath(s))
      : [s]));
    commit({ ...docRef.current, shapes }, `В кривые: ${converted.length} контур(ов)`);
    setSel(new Set(converted.map((s) => s.id)));
    setTool('shape');
  }, [commit, setSel]);

  const filletSel = useCallback((r: number) => {
    const picked = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (!picked.length) return;
    const map = new Map<string, LaserShape>();
    for (const s of picked) {
      if (s.kind === 'text' || s.kind === 'dim') continue;
      map.set(s.id, filletShapeCorners(s, r));
    }
    if (!map.size) {
      setMsg({ text: 'Скругление доступно для контуров, а не для текста и размеров.', ok: false });
      return;
    }
    replaceShapes(map, `Скругление углов R${r} мм`);
  }, [replaceShapes]);

  const arraySel = useCallback((rows: number, cols: number, gapX: number, gapY: number) => {
    const picked = docRef.current.shapes.filter((s) => selRef.current.has(s.id));
    if (!picked.length) return;
    const copies = arrayShapes(picked, Math.max(1, rows), Math.max(1, cols), gapX, gapY);
    if (!copies.length) {
      setMsg({ text: 'Массив 1×1 ничего не добавляет.', ok: false });
      return;
    }
    const bb = selectionBBox([...picked, ...copies]);
    if (bb && (bb[2] > docRef.current.w + 1 || bb[3] > docRef.current.h + 1)) {
      setMsg({ text: 'Внимание: массив выходит за пределы листа — часть деталей не попадёт в чертёж.', ok: false });
    }
    commit({ ...docRef.current, shapes: [...docRef.current.shapes, ...copies] },
      `Массив ${rows}×${cols}: добавлено ${copies.length} объектов`);
    setSel(new Set([...selRef.current, ...copies.map((c) => c.id)]));
  }, [commit, setSel]);

  const autoNest = useCallback(() => {
    if (!docRef.current.shapes.length) return;
    try {
      const res = autoNestShapesEx(docRef.current.shapes, docRef.current.w, docRef.current.h, 5, 3);
      commit({ ...docRef.current, shapes: res.shapes },
        `Автораскладка: ${res.rows} ряд(ов), ${res.shapes.length} объектов`);
      if (!res.fits) {
        setMsg({
          text: `Раскладка вышла за лист на ${res.overflowMm[0].toFixed(0)} мм по X и ${res.overflowMm[1].toFixed(0)} мм по Y — `
            + 'увеличьте лист (F2) или уменьшите детали.',
          ok: false,
        });
      }
      setTimeout(() => fit(), 30);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Автораскладка не удалась.', ok: false });
    }
  }, [commit, fit]);

  const applyMaterial = useCallback((preset: MaterialPreset) => {
    const layers = { ...docRef.current.layers };
    const patch = (id: LaserLayerId, p: Partial<LaserLayerConfig>) => {
      if (!layers[id]) return; // своих слоёв с такими именами может не быть
      layers[id] = { ...layers[id], ...p };
    };
    patch('cut', {
      power: preset.cutPower, speed: preset.cutSpeed, passes: preset.cutPasses, kerf: preset.kerf,
    });
    patch('inner', { power: preset.cutPower, speed: Math.round(preset.cutSpeed * 0.9), passes: preset.cutPasses, kerf: preset.kerf });
    patch('fold', { power: preset.foldPower, speed: preset.foldSpeed });
    patch('score', { power: preset.scorePower, speed: preset.scoreSpeed });
    patch('engrave', { power: preset.engravePower, speed: preset.engraveSpeed });
    commit({
      ...docRef.current,
      layers,
      materialPresetId: preset.id,
      materialThickness: preset.thicknessMm,
    }, `Материал: ${preset.name} (${preset.thicknessMm} мм)`);
  }, [commit]);

  const patchLayer = useCallback((id: LaserLayerId, p: Partial<LaserLayerConfig>) => {
    commit({
      ...docRef.current,
      layers: { ...docRef.current.layers, [id]: { ...docRef.current.layers[id], ...p } },
      materialPresetId: '',
    }, `Слой «${docRef.current.layers[id]?.short ?? id}»: параметры`, true);
  }, [commit]);

  // ---------------- генератор развёрток ----------------

  /** Раскладка из окна развёрток: объекты раскладываются по своим слоям чертежа. */
  const applyUnfold = useCallback((p: UnfoldApplyPayload) => {
    const grown = adoptShapes(docRef.current, p.shapes);
    const bb = selectionBBox(grown.shapes);
    const over = bb && (bb[2] - bb[0] > docRef.current.w + 0.5 || bb[3] - bb[1] > docRef.current.h + 0.5);
    commit({
      ...grown.doc,
      shapes: [...grown.doc.shapes, ...grown.shapes],
      groups: [...grown.doc.groups, ...p.groups],
    }, `Развёртка: ${p.title} (${grown.shapes.length} объектов)`);
    setSel(new Set(grown.shapes.map((s) => s.id)));
    setMsg({
      text: over
        ? `Развёртка (${(bb![2] - bb![0]).toFixed(0)}×${(bb![3] - bb![1]).toFixed(0)} мм) больше листа `
          + `${docRef.current.w}×${docRef.current.h} мм — увеличьте лист или уменьшите деталь.`
        : `Развёртка «${p.title}» помещена на лист: ${grown.shapes.length} объектов, готовы к правке и экспорту.`,
      ok: !over,
    });
  }, [commit, setSel]);

  // ---------------- генератор коробок ----------------

  const applyBox = useCallback((p: BoxApplyPayload) => {
    // детали коробки раскладываются по слоям чертежа: контуры на сплошной слой,
    // линии сгиба — на штриховой, маркировка — на слой с заливкой
    const grown = adoptShapes(docRef.current, p.shapes);
    const bb = selectionBBox(grown.shapes);
    commit({
      ...grown.doc,
      shapes: [...grown.doc.shapes, ...grown.shapes],
      groups: [...grown.doc.groups, ...p.groups],
    }, `Коробка: ${p.title}`);
    setSel(new Set(grown.shapes.map((s) => s.id)));
    const over = bb && (bb[2] > docRef.current.w + 0.5 || bb[3] > docRef.current.h + 0.5);
    setMsg({
      text: over
        ? `Детали (${(bb![2] - bb![0]).toFixed(0)}×${(bb![3] - bb![1]).toFixed(0)} мм) не влезли на лист `
          + `${docRef.current.w}×${docRef.current.h} мм — увеличьте лист или подберите лист в окне коробок.`
        : `${p.title} помещены на лист: ${p.shapes.length} объектов, готовы к правке и экспорту в DXF, PDF, EPS и PLT.`,
      ok: !over,
    });
  }, [commit, setSel]);

  // Суммарная длина видимых контуров чертежа: нужна для оценки реза и
  // показывает итог в статус-баре вместо станочного времени обработки.
  const cutLengthMm = useMemo(() => docContourLength(doc), [doc]);

  // Раскладка приходит из самостоятельного окна коробок: применяем сразу, как
  // только редактор смонтирован (окно можно открыть и из режима «Платы»).
  useEffect(() => {
    if (!boxPayload) return;
    applyBox(boxPayload);
    onBoxApplied?.();
  }, [boxPayload, applyBox, onBoxApplied]);

  // Генератор коробок — самостоятельное окно программы: если хозяин (шапка
  // PSBees) умеет его открыть, отдаём туда, иначе показываем внутри редактора.
  const openBoxes = useCallback(() => {
    if (onOpenBoxes) onOpenBoxes();
    else setDialog('boxes');
  }, [onOpenBoxes]);

  // ---------------- файлы ----------------

  const fileName = useCallback((ext: string) => `${safeFileName(doc.name)}.${ext}`, [doc.name]);

  const runExport = useCallback(async (format: LaserExportFormat) => {
    try {
      if (format === 'gcode') {
        const text = exportLaserGCode(docRef.current, gcode);
        download(fileName('gcode'), new Blob([text], { type: 'text/plain;charset=utf-8' }));
        setMsg({ text: `G-Code сохранён: ${fileName('gcode')} (${(text.length / 1024).toFixed(1)} КБ)`, ok: true });
      } else if (format === 'svg') {
        const text = exportLaserSvg(docRef.current, { strokeWidthMm: vecOpts.strokeWidthMm });
        download(fileName('svg'), new Blob([text], { type: 'image/svg+xml;charset=utf-8' }));
        setMsg({ text: `SVG сохранён: ${fileName('svg')}`, ok: true });
      } else if (format === 'pdf') {
        // векторный PDF 1:1 мм: кривые Безье и слои чертежа как слои PDF (OCG)
        const text = exportVectorPdf(docRef.current, vecOpts);
        download(fileName('pdf'), new Blob([text], { type: 'application/pdf' }));
        setMsg({
          text: `PDF сохранён: ${fileName('pdf')} (${(text.length / 1024).toFixed(1)} КБ)`
            + (vecOpts.pdfLayers ? ', слои чертежа — слоями PDF' : ''),
          ok: true,
        });
      } else if (format === 'eps') {
        const text = exportVectorEps(docRef.current, vecOpts);
        download(fileName('eps'), new Blob([text], { type: 'application/postscript' }));
        setMsg({ text: `EPS сохранён: ${fileName('eps')} (${(text.length / 1024).toFixed(1)} КБ)`, ok: true });
      } else if (format === 'plt') {
        const text = exportVectorPlt(docRef.current, vecOpts);
        download(fileName('plt'), new Blob([text], { type: 'text/plain;charset=us-ascii' }));
        setMsg({
          text: `PLT сохранён: ${fileName('plt')} — HPGL/2, 40 юнитов на мм`
            + (vecOpts.pltPensPerLayer ? ', перо на каждый слой' : ', всё в перо 1'),
          ok: true,
        });
      } else if (format === 'dxf') {
        if (dxfSplit === 'layers') {
          const files = exportDxfPerLayer(docRef.current, dxfOpts);
          if (!files.length) throw new Error('Нет видимых объектов: слои для экспорта не найдены.');
          const name = fileName('zip');
          download(name, makeZip(files.map((f) => ({ name: f.name, data: f.text }))));
          setMsg({
            text: `DXF по слоям: ${files.length} файл(ов) в ${name} (${files.map((f) => f.name.replace('.dxf', '')).join(', ')})`,
            ok: true,
          });
        } else {
          const text = exportLaserDxf(docRef.current, dxfOpts);
          download(fileName('dxf'), new Blob([text], { type: 'application/dxf' }));
          setMsg({ text: `DXF сохранён: ${fileName('dxf')} (${(text.length / 1024).toFixed(1)} КБ)`, ok: true });
        }
      } else if (format === 'project') {
        download(fileName('psdraw'), new Blob([serializeLaserProject(docRef.current)], { type: 'application/json' }));
        setMsg({ text: `Проект сохранён: ${fileName('psdraw')}`, ok: true });
      } else if (format === 'png') {
        const pxPerMm = Math.max(2, Math.min(20, 2400 / Math.max(docRef.current.w, docRef.current.h)));
        const w = Math.max(64, Math.round(docRef.current.w * pxPerMm));
        const h = Math.max(64, Math.round(docRef.current.h * pxPerMm));
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const ctx = cv.getContext('2d');
        if (!ctx) throw new Error('canvas недоступен');
        const v: LaserView = { s: pxPerMm, ox: 0, oy: h };
        const themeNow = laserTheme(theme);
        drawLaserSheet(ctx, docRef.current, v, w, h, themeNow);
        for (const s of docRef.current.shapes) {
          if (s.hidden) continue;
          const cfg = layerOf(docRef.current, s.layer);
          if (cfg.visible === false) continue;
          drawLaserShape(ctx, s, v, cfg.color || themeNow.sel, { dash: dashOf(cfg) });
        }
        const blob = await new Promise<Blob | null>((resolve) => cv.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('не удалось создать PNG');
        download(fileName('png'), blob);
        setMsg({ text: `PNG сохранён: ${fileName('png')} (${w}×${h} px)`, ok: true });
      }
      setDialog(null);
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : 'Ошибка экспорта.', ok: false });
    }
  }, [fileName, gcode, dxfOpts, dxfSplit, vecOpts, theme]);

  const openProjectFile = useCallback((file: File) => {
    const name = file.name.toLowerCase();
    // Читаем байты, а не текст: PDF и свежий AI хранят сжатые потоки, которые
    // декодирование в UTF-8 необратимо портит.
    file.arrayBuffer().then(async (buf) => {
      const bytes = new Uint8Array(buf);
      if (name.endsWith('.psdraw') || name.endsWith('.pslaser') || name.endsWith('.json')) {
        const next = parseLaserProject(new TextDecoder('utf-8').decode(bytes));
        if (!next) {
          setMsg({ text: 'Это не проект PSBees (.psdraw / .pslaser) или файл повреждён.', ok: false });
          return;
        }
        past.current = [...past.current, { doc: docRef.current, label: 'Открыт проект' }].slice(-HISTORY_LIMIT);
        future.current = [];
        setDoc(next);
        setHistTick((t) => t + 1);
        setSel(new Set());
        setSim(null);
        setMsg({ text: `Открыт проект «${next.name}»: ${next.shapes.length} объектов`, ok: true });
        setTimeout(() => fit(next), 40);
        return;
      }
      // векторный импорт: SVG, DXF, PDF, EPS/AI (PostScript) и PLT (HPGL)
      const res = await importVectorData(file.name, bytes, docRef.current.h);
      if (!res.shapes.length) {
        setMsg({
          text: res.notes.join(' ')
            || 'В файле не найдено векторных объектов (поддерживаются SVG, DXF, PDF, EPS/AI и PLT).',
          ok: false,
        });
        return;
      }
      // переносим импорт в пределы листа
      const bb = selectionBBox(res.shapes);
      let placed = res.shapes;
      if (bb && (bb[0] < 0 || bb[1] < 0 || bb[2] > docRef.current.w || bb[3] > docRef.current.h)) {
        const dx = 5 - bb[0];
        const dy = 5 - bb[1];
        placed = res.shapes.map((s) => translateShape(s, dx, dy));
      }
      // слои из файла (DXF, PDF/OCG, EPS, SVG) становятся слоями чертежа
      const grown = adoptShapes(docRef.current, placed);
      commit({ ...grown.doc, shapes: [...grown.doc.shapes, ...grown.shapes] },
        `Импорт ${file.name}: ${grown.shapes.length} объектов`);
      setSel(new Set(grown.shapes.map((s) => s.id)));
      setMsg({
        text: `Импорт ${file.name}: ${grown.shapes.length} объектов`
          + (res.pages > 1 ? `, страница 1 из ${res.pages}` : '')
          + (res.notes.length ? `. ${res.notes.join(' ')}` : '.'),
        ok: true,
      });
      setTimeout(() => fit(), 40);
    }).catch((e: unknown) => setMsg({
      text: e instanceof Error ? e.message : 'Не удалось прочитать файл.',
      ok: false,
    }));
  }, [commit, fit, setDoc, setSel]);

  const runSimulate = useCallback(() => {
    setSimBusy(true);
    setDialog('sim');
    window.setTimeout(() => {
      try {
        setSim(buildLaserSimulation(docRef.current));
      } catch (e) {
        setMsg({ text: e instanceof Error ? e.message : 'Не удалось рассчитать траекторию.', ok: false });
        setSim(null);
      } finally {
        setSimBusy(false);
      }
    }, 20);
  }, []);

  // ---------------- мышь ----------------

  const cloneSelected = useCallback((): LaserShape[] =>
    docRef.current.shapes.filter((s) => selRef.current.has(s.id)), []);

  /**
   * Вспомогательная линия ложится на служебный слой «Вспомогательные»:
   * он не выводится в DXF, PDF, EPS, PLT и SVG, но по нему можно привязываться.
   */
  const commitAux = useCallback((line: AuxLine | null, base: LaserShape | null) => {
    if (!line) {
      setMsg({
        text: 'Построить линию не удалось. Для касательной точка должна лежать вне окружности, '
          + 'для параллели и перпендикуляра первым кликом нужно попасть в объект-базу.',
        ok: false,
      });
      return;
    }
    const grown = ensureLayerByName(docRef.current, AUX_LAYER_NAME,
      { mode: 'guide', color: AUX_LAYER_COLOR });
    const shape: LaserShape = {
      id: luid('aux'), kind: 'path', layer: grown.id, name: line.name,
      nodes: [{ x: line.a.x, y: line.a.y }, { x: line.b.x, y: line.b.y }], closed: false, filled: false,
    };
    commit({ ...grown.doc, shapes: [...grown.doc.shapes, shape] },
      `${line.name}${base ? ` от «${base.name}»` : ''}`);
    setSel(new Set([shape.id]));
  }, [commit, setSel]);

  /** Объект-база незаконченного построения. */
  const auxBase = useCallback((): LaserShape | null => {
    if (!auxDraft?.baseId) return null;
    return docRef.current.shapes.find((x) => x.id === auxDraft.baseId) ?? null;
  }, [auxDraft]);

  const onPointerDown = useCallback((e: RPointerEvent<HTMLCanvasElement>) => {
    const cv = overRef.current;
    if (!cv) return;
    cv.setPointerCapture(e.pointerId);
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const raw = toWorld(view, px, py);
    const p = snapWorld(raw, e.altKey);
    histStart.current = docRef.current;

    const panning = e.button === 1 || spaceDown || tool === 'pan';
    if (panning) {
      drag.current = { mode: 'pan', px, py, view };
      return;
    }
    if (e.button === 2) return;

    // --- инструмент «Форма»: узлы и рычаги ---
    if (tool === 'shape') {
      // Цель — выделенная кривая, иначе ближайшая кривая под курсором
      const single = selShapes.length === 1 ? selShapes[0] : null;
      const under = pickShape(p);
      const candidate = single?.kind === 'path' ? single : (under?.kind === 'path' ? under : null);
      const target = candidate as PathShape | null;
      if (!target) {
        if (under) {
          setSel(new Set([under.id]));
          setMsg({
            text: 'Это не кривая. Нажмите Ctrl+Q («В кривые»), чтобы править её узлы.',
            ok: false,
          });
        } else {
          setSel(new Set());
          setNodeEdit(null);
        }
        return;
      }
      setSel(new Set([target.id]));
      setNodeEdit({ id: target.id, node: null });
      const tol = 8 / Math.max(view.s, 0.001);
      const nodeIdx = nearestNodeIndex(target, p, tol);
      if (nodeIdx >= 0) {
        const handle = nearestHandle(target, nodeIdx, p, tol * 0.8);
        if (handle) {
          drag.current = { mode: 'handle', id: target.id, idx: nodeIdx, which: handle, orig: target, moved: false };
        } else {
          drag.current = { mode: 'node', id: target.id, idx: nodeIdx, orig: target, moved: false };
        }
        setNodeEdit({ id: target.id, node: nodeIdx });
        return;
      }
      // клик по сегменту — выбираем ближайшую точку на кривой (двойной клик добавит узел)
      setNodeEdit({ id: target.id, node: null });
      drag.current = { mode: 'node', id: target.id, idx: -1, orig: target, moved: false };
      return;
    }

    // --- инструмент «Усечь кривую»: режем по клику ---
    if (tool === 'trim') {
      const hit = pickShape(p);
      if (!hit) {
        setTrimHover(null);
        setMsg({ text: 'Кликните по кривой, которую нужно усекать (границы — другие объекты листа).', ok: false });
        return;
      }
      if (!trimmable(hit, docRef.current)) {
        setMsg({ text: 'Текст, размерные линии, скрытые и заблокированные объекты не усекаются.', ok: false });
        return;
      }
      // в режиме «границы — выделенные» текущее выделение и есть набор границ
      if (!trimOnlySel) setSel(new Set([hit.id]));
      runTrim(hit.id, p);
      return;
    }

    // --- вспомогательные линии: перпендикуляр, параллель, касательная и др. ---
    if (tool === 'aux') {
      const spec = AUX_MODES.find((m) => m.id === auxMode)!;
      const pool = docRef.current.shapes.filter(pickable);
      const tol = Math.max(1.5, 10 / Math.max(view.s, 0.001));
      const sheet = { w: docRef.current.w, h: docRef.current.h };

      if (!auxDraft) {
        const base = pickBase(pool, p, tol);
        if (spec.needsBase && !base && spec.id !== 'perp') {
          setMsg({
            text: `«${spec.name}»: первым кликом попадите в объект-базу — линию, кривую, окружность, `
              + 'прямоугольник или многоугольник.',
            ok: false,
          });
          return;
        }
        if (spec.clicks === 1) {
          commitAux(buildAuxLine({ mode: auxMode, pts: [p], base, params: auxParams, sheet }), base);
          return;
        }
        setAuxDraft({ pts: [p], baseId: base?.id ?? null });
        setMsg({
          text: base
            ? `База — «${base.name}». ${spec.clicks === 3 ? 'Укажите две точки угла.' : 'Укажите точку, через которую пройдёт линия.'}`
            : (spec.id === 'perp'
              ? 'База не найдена: перпендикуляр будет построен к отрезку между двумя кликами.'
              : 'Укажите следующую точку.'),
          ok: null,
        });
        return;
      }

      const pts = [...auxDraft.pts, p];
      const base = auxBase();
      if (pts.length >= spec.clicks) {
        commitAux(buildAuxLine({ mode: auxMode, pts, base, params: auxParams, sheet }), base);
        setAuxDraft(null);
        setAuxPreview(null);
        return;
      }
      setAuxDraft({ pts, baseId: auxDraft.baseId });
      return;
    }

    // --- инструменты рисования ---
    if (tool === 'rect' || tool === 'ellipse' || tool === 'polygon') {
      setDraft({ t: tool, layer: activeLayer, a: p, b: p, shift: e.shiftKey });
      // свой режим протяжки: маркиз здесь ни при чём, иначе первый же move
      // до обновления draft успевает выделить объекты рамкой
      drag.current = { mode: 'draw', t: tool, layer: activeLayer, a: p, aRaw: raw, shift: e.shiftKey };
      return;
    }
    if (tool === 'line') {
      if (!draft || draft.t !== 'line') {
        setDraft({ t: 'line', layer: activeLayer, a: p, b: p, shift: e.shiftKey });
      } else {
        finishLine({ ...draft, b: e.shiftKey ? constrainAngle(draft.a, p, 15) : p });
      }
      return;
    }
    if (tool === 'dim') {
      if (!draft || draft.t !== 'dim') {
        setDraft({ t: 'dim', a: p, b: null, c: null });
      } else if (!draft.b) {
        setDraft({ ...draft, b: p });
      } else {
        finishDim({ ...draft, c: p });
      }
      return;
    }
    if (tool === 'text') {
      const layer: LaserLayerId = workLayer();
      const shape: LaserShape = {
        id: luid('text'), kind: 'text', layer, name: 'Надпись',
        x: p.x, y: p.y, text: 'Текст', size: 6, strokeWidth: 0.4, rot: 0, mirror: false,
        filled: layerOf(docRef.current, layer).mode === 'fill',
      };
      commit({ ...docRef.current, shapes: [...docRef.current.shapes, shape] }, 'Добавлена надпись');
      setSel(new Set([shape.id]));
      setMsg({
        text: 'Надпись поставлена, инструмент «Текст» остался активным. Текст, кегль и толщину линии '
          + 'измените в панели свойств справа; V или Esc — вернуться к выбору.',
        ok: true,
      });
      return;
    }
    if (tool === 'pen') {
      if (!draft || draft.t !== 'pen') {
        setDraft({
          t: 'pen', layer: activeLayer, closed: false, dragging: true, shift: e.shiftKey,
          cursor: p, nodes: [{ x: p.x, y: p.y }],
        });
        return;
      }
      const first = draft.nodes[0];
      const closeTol = 8 / Math.max(view.s, 0.001);
      if (draft.nodes.length >= 3 && Math.hypot(first.x - p.x, first.y - p.y) <= closeTol) {
        finishPen({ ...draft, closed: true, dragging: false });
        return;
      }
      setDraft({
        ...draft,
        dragging: true,
        shift: e.shiftKey,
        cursor: p,
        nodes: [...draft.nodes, { x: p.x, y: p.y }],
      });
      return;
    }

    // --- выбор: маркеры, объекты, маркиз ---
    if (selBBox && selShapes.length) {
      const handles = selectionHandlePoints(selBBox, view);
      const h = handles.find((x) => Math.hypot(x.px - px, x.py - py) <= 7);
      if (h) {
        drag.current = {
          mode: 'resize', handle: h.id, bb: selBBox,
          orig: cloneSelected(), moved: false, uniform: e.shiftKey,
        };
        return;
      }
    }

    const hit = pickShape(p);
    if (hit) {
      let next = selRef.current;
      if (e.shiftKey) {
        next = new Set(selRef.current);
        if (next.has(hit.id)) next.delete(hit.id);
        else next.add(hit.id);
      } else if (!next.has(hit.id)) {
        next = new Set([hit.id]);
      }
      setSel(next);
      const moving = docRef.current.shapes.filter((s) => next.has(s.id) && !s.locked);
      drag.current = { mode: 'move', start: p, orig: moving, moved: false };
      return;
    }

    if (!e.shiftKey) setSel(new Set());
    drag.current = { mode: 'marquee', a: p, shift: e.shiftKey, base: new Set(selRef.current), moved: false };
    setMarquee({ a: p, b: p });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tool, activeLayer, draft, selBBox, selShapes, snapWorld, pickShape, commit, setSel, spaceDown,
    cloneSelected, runTrim, trimOnlySel, pickable, auxMode, auxParams, auxDraft, auxBase, commitAux]);

  /** Завершение рисования отрезка. */
  const finishLine = useCallback((d: Extract<Draft, { t: 'line' }>) => {
    if (Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y) < MIN_DRAW_MM) {
      setDraft(null);
      return;
    }
    const shape: LaserShape = {
      id: luid('line'), kind: 'path', layer: d.layer, name: 'Отрезок',
      nodes: [{ x: d.a.x, y: d.a.y }, { x: d.b.x, y: d.b.y }], closed: false, filled: false,
    };
    commit({ ...docRef.current, shapes: [...docRef.current.shapes, shape] }, 'Добавлен отрезок');
    setSel(new Set([shape.id]));
    setDraft(null);
  }, [commit, setSel]);

  /** Завершение рисования кривой пером. */
  const finishPen = useCallback((d: Extract<Draft, { t: 'pen' }>) => {
    const nodes = d.nodes.filter((n, i) =>
      i === 0 || Math.hypot(n.x - d.nodes[i - 1].x, n.y - d.nodes[i - 1].y) > 1e-4);
    if (nodes.length < 2) {
      setDraft(null);
      return;
    }
    const shape: LaserShape = {
      id: luid('curve'), kind: 'path', layer: d.layer,
      name: d.closed ? 'Замкнутая кривая' : 'Кривая',
      nodes, closed: d.closed, filled: false,
    };
    commit({ ...docRef.current, shapes: [...docRef.current.shapes, shape] },
      d.closed ? `Добавлен замкнутый контур (${nodes.length} узлов)` : `Добавлена кривая (${nodes.length} узлов)`);
    setSel(new Set([shape.id]));
    setDraft(null);
  }, [commit, setSel]);

  /** Завершение размерной линии. */
  const finishDim = useCallback((d: Extract<Draft, { t: 'dim' }>) => {
    if (!d.b) {
      setDraft(null);
      return;
    }
    const len = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y);
    if (len < MIN_DRAW_MM) {
      setDraft(null);
      return;
    }
    const off = d.c ? perpOffset(d.a, d.b, d.c) : 8;
    // размеры живут на служебном слое — создаём его, если такого слоя ещё нет
    const grown = ensureRoleLayer(docRef.current, 'guide');
    const shape: LaserShape = {
      id: luid('dim'), kind: 'dim', layer: grown.id, name: `Размер ${len.toFixed(1)} мм`,
      x1: d.a.x, y1: d.a.y, x2: d.b.x, y2: d.b.y,
      offset: Math.abs(off) < 2 ? (off < 0 ? -2 : 2) : off,
      label: `${len.toFixed(2)} мм`,
    };
    commit({ ...grown.doc, shapes: [...grown.doc.shapes, shape] }, `Добавлен размер ${len.toFixed(2)} мм`);
    setSel(new Set([shape.id]));
    setDraft(null);
  }, [commit, setSel]);

  /** Финал протяжки (прямоугольник / эллипс / многоугольник). */
  const finishDragDraw = useCallback((d: Draft) => {
    setDraft(null);
    if (d.t !== 'rect' && d.t !== 'ellipse' && d.t !== 'polygon') return;
    const built = draftToShape(d) ?? clickShape(d.t, d.layer, d.a);
    if (!built) {
      setMsg({ text: 'Объект не создан: протяжка получилась меньше 0.2 мм.', ok: false });
      return;
    }
    let shape = withRealId(built);
    if (shape.kind === 'polygon') {
      shape.sides = polygonSides;
      shape.star = polygonStar;
      shape.innerRatio = 0.45;
    }
    const bb = shapeBBox(shape);
    if (bb[2] - bb[0] < MIN_DRAW_MM || bb[3] - bb[1] < MIN_DRAW_MM) {
      setMsg({ text: 'Объект не создан: размер меньше 0.2 мм — растяните фигуру мышью.', ok: false });
      return;
    }
    commit({ ...docRef.current, shapes: [...docRef.current.shapes, shape] }, `Добавлен объект: ${shape.name}`);
    setSel(new Set([shape.id]));
  }, [commit, polygonSides, polygonStar, setSel]);

  const onPointerMove = useCallback((e: RPointerEvent<HTMLCanvasElement>) => {
    const cv = overRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const raw = toWorld(view, px, py);
    const p = snapWorld(raw, e.altKey);
    setMouse({ px, py, wx: p.x, wy: p.y });
    setSnapMark(grid.snap && !e.altKey ? nearestSnapPoint(snapPoints, raw, 7 / Math.max(view.s, 0.001)) : null);

    const d = drag.current;
    if (!d) {
      // предпросмотр инструмента «Усечь кривую»: какой кусок уйдёт
      if (tool === 'trim') {
        updateTrimHover(raw);
        return;
      }
      // предпросмотр вспомогательной линии: тянется за курсором
      if (tool === 'aux') {
        setAuxPreview(previewAuxLine({
          mode: auxMode,
          pts: auxDraft?.pts ?? [],
          base: auxBase(),
          params: auxParams,
          sheet: { w: docRef.current.w, h: docRef.current.h },
        }, p));
        return;
      }
      // предпросмотр незавершённого рисунка
      if (draft) {
        if (draft.t === 'line') {
          setDraft({ ...draft, b: e.shiftKey ? constrainAngle(draft.a, p, 15) : p, shift: e.shiftKey });
        } else if (draft.t === 'dim') {
          if (!draft.b) setDraft({ ...draft, c: null });
          else setDraft({ ...draft, c: p });
        } else if (draft.t === 'pen' && draft.nodes.length) {
          if (!draft.dragging) {
            // кнопка не нажата: просто «резиновая нить» к курсору, узел угловой
            setDraft({ ...draft, cursor: p, shift: e.shiftKey });
          } else {
            // протяжка сразу после клика тянет рычаги Безье — узел гладкий
            const nodes = draft.nodes.slice();
            const last = nodes[nodes.length - 1];
            const dx = p.x - last.x;
            const dy = p.y - last.y;
            nodes[nodes.length - 1] = {
              ...last,
              smooth: Math.hypot(dx, dy) > 1e-3,
              cp2x: p.x, cp2y: p.y,
              cp1x: last.x - dx, cp1y: last.y - dy,
            };
            setDraft({ ...draft, nodes, cursor: p, shift: e.shiftKey });
          }
        }
      }
      return;
    }

    if (d.mode === 'pan') {
      const dx = px - d.px;
      const dy = py - d.py;
      setView({ s: d.view.s, ox: d.view.ox + dx, oy: d.view.oy + dy });
      return;
    }

    if (d.mode === 'draw') {
      setDraft({
        t: d.t, layer: d.layer, a: d.a, shift: d.shift,
        b: constrainBox(d.a, p, e.shiftKey || d.shift),
      });
      return;
    }
    if (d.mode === 'marquee') {
      d.moved = true;
      setMarquee({ a: d.a, b: p });
      const x0 = Math.min(d.a.x, p.x);
      const x1 = Math.max(d.a.x, p.x);
      const y0 = Math.min(d.a.y, p.y);
      const y1 = Math.max(d.a.y, p.y);
      const next = new Set(d.shift ? d.base : []);
      for (const s of docRef.current.shapes) {
        if (!pickable(s)) continue;
        const bb = shapeBBox(s);
        if (bb[0] >= x0 - 1e-6 && bb[2] <= x1 + 1e-6 && bb[1] >= y0 - 1e-6 && bb[3] <= y1 + 1e-6) {
          next.add(s.id);
        }
      }
      setSel(next);
      return;
    }

    if (d.mode === 'move') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * view.s < 1.5) return;
      d.moved = true;
      const map = new Map<string, LaserShape>();
      for (const s of d.orig) map.set(s.id, translateShape(s, dx, dy));
      const shapes = docRef.current.shapes.map((s) => map.get(s.id) ?? s);
      setDoc({ ...docRef.current, shapes });
      return;
    }

    if (d.mode === 'resize') {
      d.moved = true;
      const bb = d.bb;
      let nx0 = bb[0], ny0 = bb[1], nx1 = bb[2], ny1 = bb[3];
      const h = d.handle;
      if (h === 'e' || h === 'se' || h === 'ne') nx1 = p.x;
      if (h === 'w' || h === 'sw' || h === 'nw') nx0 = p.x;
      if (h === 'n' || h === 'ne' || h === 'nw') ny1 = p.y;
      if (h === 's' || h === 'se' || h === 'sw') ny0 = p.y;
      const w0 = Math.max(bb[2] - bb[0], 1e-6);
      const h0 = Math.max(bb[3] - bb[1], 1e-6);
      let newW = Math.max(Math.abs(nx1 - nx0), 0.2);
      let newH = Math.max(Math.abs(ny1 - ny0), 0.2);
      const both = (h === 'se' || h === 'ne' || h === 'nw' || h === 'sw');
      if (d.uniform && both) {
        const k = Math.max(newW / w0, newH / h0);
        newW = w0 * k;
        newH = h0 * k;
      }
      const sx = h === 'n' || h === 's' ? 1 : newW / w0;
      const sy = h === 'e' || h === 'w' ? 1 : newH / h0;
      const anchorX = (h === 'w' || h === 'sw' || h === 'nw') ? bb[2] : bb[0];
      const anchorY = (h === 's' || h === 'se' || h === 'sw') ? bb[3] : bb[1];
      const map = new Map<string, LaserShape>();
      for (const s of d.orig) map.set(s.id, scaleShape(s, anchorX, anchorY, sx, sy));
      const shapes = docRef.current.shapes.map((s) => map.get(s.id) ?? s);
      setDoc({ ...docRef.current, shapes });
      return;
    }

    if (d.mode === 'node' || d.mode === 'handle') {
      const shape = docRef.current.shapes.find((s) => s.id === d.id);
      if (!shape || shape.kind !== 'path') return;
      if (d.mode === 'node' && d.idx < 0) return;
      d.moved = true;
      const next = d.mode === 'node'
        ? moveNode(d.orig, d.idx, p)
        : moveHandle(d.orig, d.idx, d.which, p);
      const shapes = docRef.current.shapes.map((s) => (s.id === d.id ? (next as LaserShape) : s));
      setDoc({ ...docRef.current, shapes });
      return;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, draft, grid.snap, snapPoints, snapWorld, pickable, setDoc, setSel, tool, updateTrimHover,
    auxMode, auxParams, auxDraft, auxBase]);

  const onPointerUp = useCallback((e: RPointerEvent<HTMLCanvasElement>) => {
    const cv = overRef.current;
    if (cv && e.pointerId !== undefined) {
      try { cv.releasePointerCapture(e.pointerId); } catch { /* уже снято */ }
    }
    const d = drag.current;
    drag.current = null;

    // Перо работает кликами, без перетаскивания: снимаем флаг протяжки, иначе
    // последний узел продолжал бы гнуться за курсором при простом наведении.
    if (!d && draft?.t === 'pen' && draft.dragging) setDraft({ ...draft, dragging: false });
    if (!d) return;

    if (d.mode === 'draw') {
      const cv2 = overRef.current;
      const rect = cv2?.getBoundingClientRect();
      const pRaw = rect ? toWorld(view, e.clientX - rect.left, e.clientY - rect.top) : d.aRaw;
      const p = snapWorld(pRaw, e.altKey);
      // черновик протяжки собираем по конкретному типу — иначе union «расползается»
      const box = (a: Pt, b: Pt): Draft => (d.t === 'rect'
        ? { t: 'rect', layer: d.layer, a, b, shift: d.shift }
        : d.t === 'ellipse'
          ? { t: 'ellipse', layer: d.layer, a, b, shift: d.shift }
          : { t: 'polygon', layer: d.layer, a, b, shift: d.shift });
      let dd = box(d.a, constrainBox(d.a, p, e.shiftKey || d.shift));
      // привязка к сетке могла схлопнуть протяжку в точку — берём сырые координаты
      if (!draftToShape(dd)) dd = box(d.aRaw, constrainBox(d.aRaw, pRaw, e.shiftKey || d.shift));
      finishDragDraw(dd);
      histStart.current = null;
      return;
    }
    if (d.mode === 'marquee') {
      setMarquee(null);
      if (!d.moved) histStart.current = null;
      return;
    }
    if (d.mode === 'move' && d.moved) {
      commitDrag(`Перемещено объектов: ${d.orig.length}`);
      return;
    }
    if (d.mode === 'resize' && d.moved) {
      commitDrag('Изменён размер');
      return;
    }
    if ((d.mode === 'node' || d.mode === 'handle') && d.moved) {
      commitDrag(d.mode === 'node' ? 'Перемещён узел кривой' : 'Изменён рычаг Безье');
      return;
    }
    histStart.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitDrag, draft, finishDragDraw, snapWorld, view]);

  const onDoubleClick = useCallback((e: RPointerEvent<HTMLCanvasElement>) => {
    const cv = overRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const p = snapWorld(toWorld(view, e.clientX - rect.left, e.clientY - rect.top), e.altKey);

    if (tool === 'pen' && draft?.t === 'pen') {
      finishPen(draft);
      return;
    }

    if (tool === 'shape') {
      const shape = docRef.current.shapes.find((s) => s.id === nodeEdit?.id);
      if (shape && shape.kind === 'path') {
        const idx = nearestNodeIndex(shape, p, 10 / Math.max(view.s, 0.001));
        if (idx >= 0) {
          const next = deleteNode(shape, idx);
          if (!next) {
            setMsg({ text: 'Нельзя удалить узел: останется вырожденный контур.', ok: false });
            return;
          }
          const shapes = docRef.current.shapes.map((s) => (s.id === shape.id ? (next as LaserShape) : s));
          commit({ ...docRef.current, shapes }, 'Удалён узел кривой');
          setNodeEdit({ id: shape.id, node: null });
          return;
        }
        const ins = insertNode(shape, p);
        if (ins) {
          const shapes = docRef.current.shapes.map((s) => (s.id === shape.id ? (ins.shape as LaserShape) : s));
          commit({ ...docRef.current, shapes }, 'Добавлен узел на кривой');
          setNodeEdit({ id: shape.id, node: ins.index });
        }
        return;
      }
    }

    // двойной клик по объекту в режиме выбора: кривую — править узлами, группу — выделить целиком
    const hit = pickShape(p);
    if (!hit) return;
    if (hit.kind === 'path') {
      setSel(new Set([hit.id]));
      setNodeEdit({ id: hit.id, node: null });
      setTool('shape');
      setMsg({ text: 'Кривая открыта для правки узлов (F10).', ok: true });
      return;
    }
    if (hit.groupId) {
      const ids = new Set(docRef.current.shapes.filter((s) => s.groupId === hit.groupId).map((s) => s.id));
      setSel(ids);
      const g = docRef.current.groups.find((x) => x.id === hit.groupId);
      setMsg({ text: `Выделена группа «${g?.name ?? 'без имени'}»: ${ids.size} объектов`, ok: true });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, draft, view, nodeEdit, commit, pickShape, snapWorld, finishPen, setSel]);

  const onWheel = useCallback((e: RWheelEvent<HTMLCanvasElement>) => {
    const cv = overRef.current;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (e.shiftKey) {
      // горизонтальная прокрутка листа
      setView((v) => ({ ...v, ox: v.ox - e.deltaY }));
      return;
    }
    zoomAt(px, py, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, [zoomAt]);

  const nudgeTimer = useRef(0);
  const nudge = useCallback((dx: number, dy: number) => {
    const cur = cloneSelected().filter((s) => !s.locked);
    if (!cur.length) return;
    const map = new Map<string, LaserShape>();
    for (const s of cur) map.set(s.id, translateShape(s, dx, dy));
    // снимок «до» — обязательно до правки, иначе отмена вернёт уже сдвинутый объект
    if (!histStart.current) histStart.current = docRef.current;
    replaceShapes(map, 'Сдвиг стрелками', false);
    window.clearTimeout(nudgeTimer.current);
    nudgeTimer.current = window.setTimeout(() => commitDrag('Сдвиг стрелками'), 400);
  }, [cloneSelected, replaceShapes, commitDrag]);

  // ---------------- клавиатура ----------------

  const keyHandler = useCallback((e: KeyboardEvent) => {
    if (mode !== 'laser') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (key === ' ' && !spaceDown) {
      setSpaceDown(true);
      e.preventDefault();
      return;
    }

    if (ctrl) {
      const k = key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if ((k === 'y') || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
      if (k === 'a') {
        e.preventDefault();
        setSel(new Set(docRef.current.shapes.filter(pickable).map((s) => s.id)));
        return;
      }
      if (k === 'd') { e.preventDefault(); duplicateSel(); return; }
      if (k === 'g' && !e.shiftKey) { e.preventDefault(); groupSel(); return; }
      if (k === 'g' && e.shiftKey) { e.preventDefault(); ungroupSel(); return; }
      if (k === 'q') { e.preventDefault(); toCurves(); return; }
      if (k === 's') { e.preventDefault(); void runExport('project'); return; }
      if (k === 'o') { e.preventDefault(); fileRef.current?.click(); return; }
      if (k === 'e') { e.preventDefault(); setDialog('export'); return; }
      if (k === 'b') { e.preventDefault(); openBoxes(); return; }
      if (k === 'x' && e.shiftKey) { e.preventDefault(); breakApartSel(); return; }
      if (k === 'n') { e.preventDefault(); setDialog('new'); return; }
      if (k === '=' || k === '+') { e.preventDefault(); zoomAt(size.w / 2, size.h / 2, 1.25); return; }
      if (k === '-') { e.preventDefault(); zoomAt(size.w / 2, size.h / 2, 1 / 1.25); return; }
      if (k === '0') { e.preventDefault(); fit(); return; }
      return;
    }

    if (e.altKey) {
      const k = key.toLowerCase();
      if (k === 'w' || k === 'ц') { e.preventDefault(); booleanSel('union'); return; }
      if (k === 't' || k === 'е') { e.preventDefault(); booleanSel('subtract'); return; }
      if (k === 'i' || k === 'ш') { e.preventDefault(); booleanSel('intersect'); return; }
      if (k === 'x' || k === 'ч') { e.preventDefault(); booleanSel('xor'); return; }
      return;
    }

    switch (key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        if (tool === 'shape' && nodeEdit?.node !== null && nodeEdit?.node !== undefined) {
          const shape = docRef.current.shapes.find((s) => s.id === nodeEdit.id);
          if (shape && shape.kind === 'path') {
            const next = deleteNode(shape, nodeEdit.node);
            if (next) {
              commit({
                ...docRef.current,
                shapes: docRef.current.shapes.map((s) => (s.id === shape.id ? (next as LaserShape) : s)),
              }, 'Удалён узел кривой');
              setNodeEdit({ id: shape.id, node: null });
            }
          }
          return;
        }
        deleteSel();
        return;
      case 'Escape':
        if (draft) { setDraft(null); setMsg({ text: 'Рисование отменено.', ok: null }); return; }
        if (auxDraft) {
          setAuxDraft(null);
          setAuxPreview(null);
          setMsg({ text: 'Построение вспомогательной линии отменено.', ok: null });
          return;
        }
        if (dialog) { setDialog(null); return; }
        setSel(new Set());
        setNodeEdit(null);
        setTrimHover(null);
        // инструменты рисования теперь не выключаются сами: Esc — выход к выбору
        if (tool !== 'select' && tool !== 'pan') {
          setTool('select');
          setMsg({ text: 'Инструмент «Выбор» (V).', ok: null });
        }
        return;
      case 'Enter':
        if (draft?.t === 'pen') { e.preventDefault(); finishPen(draft); return; }
        if (draft?.t === 'line') { e.preventDefault(); finishLine(draft); return; }
        if (draft?.t === 'dim') { e.preventDefault(); finishDim(draft); return; }
        return;
      case 'F10':
        e.preventDefault();
        setTool('shape');
        return;
      case 'F2':
        e.preventDefault();
        setDialog('sheet');
        return;
      case 'ArrowLeft': {
        e.preventDefault();
        const st = e.shiftKey ? grid.step * 10 : grid.step;
        nudge(-(st || 1), 0);
        return;
      }
      case 'ArrowRight': {
        e.preventDefault();
        const st = e.shiftKey ? grid.step * 10 : grid.step;
        nudge(st || 1, 0);
        return;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const st = e.shiftKey ? grid.step * 10 : grid.step;
        nudge(0, st || 1);
        return;
      }
      case 'ArrowDown': {
        e.preventDefault();
        const st = e.shiftKey ? grid.step * 10 : grid.step;
        nudge(0, -(st || 1));
        return;
      }
      default: break;
    }

    // Цифры переключают режимы инструмента: 1…3 у «Усечь кривую» и 1…8 у
    // вспомогательных линий. Смотрим и e.code — раскладка может быть русской.
    const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? (/^[1-9]$/.test(key) ? key : null);
    if (digit && !ctrl && !e.altKey) {
      const n = Number(digit);
      if (tool === 'trim' && n <= 3) {
        const m = TRIM_MODES[n - 1];
        if (m) {
          setTrimMode(m.id);
          setTrimHover(null);
          setMsg({ text: `Режим «${m.name}»: ${m.hint}`, ok: null });
        }
        return;
      }
      if (tool === 'aux') {
        const m = AUX_MODES.find((x) => x.key === digit);
        if (m) {
          setAuxMode(m.id);
          setAuxDraft(null);
          setAuxPreview(null);
          setMsg({ text: `«${m.name}»: ${m.hint}`, ok: null });
        }
        return;
      }
    }

    // Буквы, которые не выбирают инструмент: весь лист и гладкость узла
    if (key === 'f' || key === 'F' || key === 'а' || key === 'А') { fit(); return; }
    if (key === 's' || key === 'S' || key === 'ы' || key === 'Ы') {
      if (tool === 'shape' && nodeEdit?.node !== null && nodeEdit?.node !== undefined) {
        const shape = docRef.current.shapes.find((x) => x.id === nodeEdit.id);
        if (shape && shape.kind === 'path') {
          const next = toggleSmooth(shape, nodeEdit.node);
          commit({
            ...docRef.current,
            shapes: docRef.current.shapes.map((x) => (x.id === shape.id ? (next as LaserShape) : x)),
          }, next.nodes[nodeEdit.node].smooth ? 'Узел сделан гладким' : 'Узел сделан угловым');
        }
      }
      return;
    }

    // Выбор инструмента буквой. Сверяемся и с e.code: на русской раскладке
    // физическая клавиша V даёт «м», и раньше инструмент просто не переключался.
    const byCode = /^Key([A-Z])$/.exec(e.code)?.[1];
    const toolByKey = LASER_TOOLS.find((x) => x.key !== 'F10'
      && (x.key.toLowerCase() === key.toLowerCase() || (byCode !== undefined && x.key.toUpperCase() === byCode)));
    if (toolByKey && !draft) {
      setTool(toolByKey.id);
      if (toolByKey.id !== 'shape') setNodeEdit(null);
      setAuxDraft(null);
      setAuxPreview(null);
      const meta = LASER_TOOLS.find((x) => x.id === toolByKey.id)!;
      setMsg({ text: `Инструмент «${meta.name}» (${meta.key}): ${meta.hint}`, ok: null });
    }
  }, [
    mode, spaceDown, undo, redo, duplicateSel, deleteSel, groupSel, ungroupSel, toCurves, booleanSel,
    runExport, zoomAt, fit, size.w, size.h, draft, dialog, tool, nodeEdit, grid.step, nudge, commit,
    pickable, setSel, finishPen, finishLine, finishDim, breakApartSel, auxDraft, auxMode,
  ]);

  const keyRef = useRef(keyHandler);
  keyRef.current = keyHandler;
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    const up = (e: KeyboardEvent) => { if (e.key === ' ') setSpaceDown(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Подсветка инструмента «усечь» живёт только пока не поменялись инструмент,
  // режим или состав листа — иначе курсор «помнит» старый кусок.
  useEffect(() => {
    trimHoverAt.current = { id: null, x: 0, y: 0 };
    setTrimHover(null);
  }, [tool, trimMode, trimOnlySel, doc.shapes]);

  // ---------------- отрисовка: базовый слой ----------------

  useEffect(() => {
    const cv = baseRef.current;
    if (!cv) return;
    cancelAnimationFrame(baseRaf.current);
    baseRaf.current = requestAnimationFrame(() => {
      baseRaf.current = 0;
      const dpr = perfDpr();
      if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
      if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
      cv.style.width = `${size.w}px`;
      cv.style.height = `${size.h}px`;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      drawLaserSheet(ctx, doc, view, size.w, size.h, th);
      drawLaserGrid(ctx, view, size.w, size.h, grid, th);

      for (const s of doc.shapes) {
        if (s.hidden) continue;
        // layerOf: объект с неизвестным id слоя (старый проект, генератор,
        // импорт) раньше просто исчезал с листа — теперь рисуется запасным цветом
        const cfg = layerOf(doc, s.layer);
        if (cfg.visible === false) continue;
        drawLaserShape(ctx, s, view, cfg.color || th.sel, {
          selected: sel.has(s.id), sheetBg: th.sheet, dash: dashOf(cfg),
        });
      }

      if (selBBox) {
        drawSelectionBox(ctx, selBBox, view, th);
        drawSelectionLabel(ctx, selBBox, view, th, sel.size > 1 ? `${sel.size} объектов` : undefined);
      }

      if (tool === 'shape' && nodeEdit) {
        const shape = doc.shapes.find((s) => s.id === nodeEdit.id);
        if (shape && shape.kind === 'path') {
          drawPathNodes(ctx, shape, view, th, nodeEdit.node);
        }
      }
    });
  }, [doc, view, size, sel, selBBox, grid, th, tool, nodeEdit]);

  // ---------------- отрисовка: оверлей ----------------

  useEffect(() => {
    const cv = overRef.current;
    if (!cv) return;
    cancelAnimationFrame(overRaf.current);
    overRaf.current = requestAnimationFrame(() => {
      overRaf.current = 0;
      const dpr = perfDpr();
      if (cv.width !== Math.round(size.w * dpr)) cv.width = Math.round(size.w * dpr);
      if (cv.height !== Math.round(size.h * dpr)) cv.height = Math.round(size.h * dpr);
      cv.style.width = `${size.w}px`;
      cv.style.height = `${size.h}px`;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.w, size.h);

      // перекрестие курсора с координатами
      if (mouse.px >= 0 && tool !== 'pan') {
        ctx.strokeStyle = th.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(mouse.py) + 0.5);
        ctx.lineTo(size.w, Math.round(mouse.py) + 0.5);
        ctx.moveTo(Math.round(mouse.px) + 0.5, 0);
        ctx.lineTo(Math.round(mouse.px) + 0.5, size.h);
        ctx.stroke();
      }

      // точка привязки
      if (snapMark) {
        const p = toScreen(view, snapMark.x, snapMark.y);
        ctx.strokeStyle = th.sel;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(p.px - 6, p.py);
        ctx.lineTo(p.px + 6, p.py);
        ctx.moveTo(p.px, p.py - 6);
        ctx.lineTo(p.px, p.py + 6);
        ctx.stroke();
      }

      // черновик рисования
      if (draft) {
        // у пера к узлам добавляется «резиновая нить» до курсора — видно,
        // куда ляжет следующий сегмент
        const penDraft = draft.t === 'pen' && draft.cursor
          ? { ...draft, nodes: [...draft.nodes, { x: draft.cursor.x, y: draft.cursor.y }] }
          : draft;
        const shape = draftToShape(penDraft);
        if (shape) {
          const color = shape.kind === 'dim'
            ? th.dim
            : (layerOf(doc, draft.t === 'dim' ? 'guide' : draft.layer).color || th.sel);
          drawLaserShape(ctx, shape, view, color, { draft: true });
        }
        if (draft.t === 'pen' && draft.nodes.length) {
          // узлы строящейся кривой
          ctx.fillStyle = th.node;
          for (const n of draft.nodes) {
            const p = toScreen(view, n.x, n.y);
            ctx.beginPath();
            ctx.rect(p.px - 3, p.py - 3, 6, 6);
            ctx.fill();
          }
          const first = toScreen(view, draft.nodes[0].x, draft.nodes[0].y);
          ctx.strokeStyle = th.sel;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(first.px, first.py, 7, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // предпросмотр вспомогательной линии: пунктир, точка касания и база
      if (tool === 'aux' && (auxPreview || auxDraft)) {
        const base = auxBase();
        ctx.save();
        if (base) {
          ctx.strokeStyle = th.sel;
          ctx.lineWidth = 1.1;
          ctx.setLineDash([3, 3]);
          for (const pl of shapeToPolylines(base)) {
            ctx.beginPath();
            pl.forEach((q, i) => {
              const sp = toScreen(view, q.x, q.y);
              if (i === 0) ctx.moveTo(sp.px, sp.py);
              else ctx.lineTo(sp.px, sp.py);
            });
            ctx.stroke();
          }
        }
        if (auxPreview) {
          const a = toScreen(view, auxPreview.a.x, auxPreview.a.y);
          const b = toScreen(view, auxPreview.b.x, auxPreview.b.y);
          ctx.strokeStyle = th.dim;
          ctx.lineWidth = 1.3;
          ctx.setLineDash([8, 4]);
          ctx.beginPath();
          ctx.moveTo(a.px, a.py);
          ctx.lineTo(b.px, b.py);
          ctx.stroke();
          // точки касания, середины и основания перпендикуляров
          ctx.setLineDash([]);
          for (const m of [auxPreview.mark, auxDraft?.pts[auxDraft.pts.length - 1]].filter(Boolean) as Pt[]) {
            const sp = toScreen(view, m.x, m.y);
            ctx.beginPath();
            ctx.arc(sp.px, sp.py, 4, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      // предпросмотр «усечь кривую»: кусок под курсором, точки реза и добор
      if (tool === 'trim' && trimHover) {
        const pv = trimHover.preview;
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        // контур-подсветка куска
        if (pv.pts.length >= 2) {
          ctx.beginPath();
          pv.pts.forEach((q, i) => {
            const sp = toScreen(view, q.x, q.y);
            if (i === 0) ctx.moveTo(sp.px, sp.py);
            else ctx.lineTo(sp.px, sp.py);
          });
          ctx.strokeStyle = pv.mode === 'trim' ? '#ff6b57' : th.sel;
          ctx.globalAlpha = 0.28;
          ctx.lineWidth = 8;
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineWidth = 2.2;
          ctx.setLineDash(pv.mode === 'break' ? [6, 4] : []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        // добор для режима «продлить»
        if (pv.extra) {
          const a = toScreen(view, pv.extra[0].x, pv.extra[0].y);
          const b = toScreen(view, pv.extra[1].x, pv.extra[1].y);
          ctx.strokeStyle = th.sel;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(a.px, a.py);
          ctx.lineTo(b.px, b.py);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(b.px, b.py, 3.6, 0, Math.PI * 2);
          ctx.stroke();
        }
        // точки пересечения — там кривая будет разрезана
        for (const c of pv.cuts) {
          const sp = toScreen(view, c.x, c.y);
          ctx.beginPath();
          ctx.arc(sp.px, sp.py, 3.4, 0, Math.PI * 2);
          ctx.fillStyle = pv.mode === 'trim' ? '#ff6b57' : th.sel;
          ctx.fill();
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = th.handleEdge;
          ctx.stroke();
        }
        // подпись режима
        const anchorPt = pv.cuts[0] ?? pv.pts[0];
        if (anchorPt) {
          const sp = toScreen(view, anchorPt.x, anchorPt.y);
          const label = pv.hint;
          ctx.font = '11px Inter, system-ui, sans-serif';
          const tw = ctx.measureText(label).width + 12;
          ctx.fillStyle = th.selFill;
          ctx.strokeStyle = th.sel;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(sp.px + 10, sp.py - 26, tw, 17, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = th.sel;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, sp.px + 16, sp.py - 17);
        }
        ctx.restore();
      }

      // маркиз
      if (marquee) drawMarquee(ctx, marquee.a, marquee.b, view, th);
    });
  }, [draft, marquee, mouse.px, mouse.py, snapMark, view, size, th, tool, doc.layers, trimHover,
    auxPreview, auxDraft, auxBase]);

  // ---------------- очистка при размонтировании ----------------
  useEffect(() => () => {
    cancelAnimationFrame(baseRaf.current);
    cancelAnimationFrame(overRaf.current);
    window.clearTimeout(nudgeTimer.current);
  }, []);

  // ---------------- панели ----------------

  const propsActions: PropsActions = useMemo(() => ({
    onPatch: (patch) => patchSelected(patch),
    onGeometry: (g) => applyGeometry(g),
    onRotateStep: (deg) => rotateSel(deg),
    onMirror: (axis) => mirrorSel(axis),
    onAlign: (m) => alignSel(m),
    onBoolean: (op) => booleanSel(op),
    onContour: (delta, layer) => contourSel(delta, layer),
    onToCurves: () => toCurves(),
    onFillet: (r) => filletSel(r),
    onTrimTool: (mode) => {
      if (mode) setTrimMode(mode);
      setTool('trim');
      setNodeEdit(null);
    },
    onBreakApart: () => breakApartSel(),
    onArray: (rows, cols, gx, gy) => arraySel(rows, cols, gx, gy),
    onDuplicate: () => duplicateSel(),
    onDelete: () => deleteSel(),
    onGroup: () => groupSel(),
    onUngroup: () => ungroupSel(),
    onOrder: (cmd) => orderSel(cmd),
    onLayer: (layer) => patchSelected({ layer } as Partial<LaserShape>, `Перенесено на слой «${doc.layers[layer]?.short ?? layer}»`),
    onLock: (locked) => patchSelected({ locked } as Partial<LaserShape>, locked ? 'Объект заблокирован' : 'Объект разблокирован'),
    onHide: (hidden) => patchSelected({ hidden } as Partial<LaserShape>, hidden ? 'Объект скрыт' : 'Объект показан'),
  }), [
    patchSelected, applyGeometry, rotateSel, mirrorSel, alignSel, booleanSel, contourSel, toCurves,
    filletSel, arraySel, duplicateSel, deleteSel, groupSel, ungroupSel, orderSel, doc.layers,
    breakApartSel,
  ]);

  const toggleLayerVisible = useCallback((id: LaserLayerId) => {
    patchLayer(id, { visible: !docRef.current.layers[id]?.visible });
  }, [patchLayer]);

  const toggleLayerLock = useCallback((id: LaserLayerId) => {
    patchLayer(id, { locked: !docRef.current.layers[id]?.locked });
  }, [patchLayer]);

  const showAllLayers = useCallback(() => {
    const layers = { ...docRef.current.layers };
    for (const id of layerIds(docRef.current)) layers[id] = { ...layers[id], visible: true };
    commit({ ...docRef.current, layers }, 'Все слои показаны', true);
    setSel(new Set());
  }, [commit, setSel]);

  /** Добавить свой слой («Слой 2», «Слой 3», …) и сделать его активным. */
  const addLayer = useCallback(() => {
    const grown = addLaserLayer(docRef.current);
    commit(grown.doc, `Добавлен слой «${grown.doc.layers[grown.id].short}»`, true);
    setActiveLayer(grown.id);
    setLeftTab('layers');
  }, [commit]);

  /** Удалить слой: его объекты переходят на первый оставшийся. */
  const deleteLayer = useCallback((id: LaserLayerId) => {
    const d = docRef.current;
    if (layerIds(d).length <= 1) {
      setMsg({ text: 'Слой нельзя удалить: он последний.', ok: false });
      return;
    }
    const name = d.layers[id]?.short ?? id;
    const moved = d.shapes.filter((s) => s.layer === id).length;
    const next = removeLaserLayer(d, id);
    commit(next, `Слой «${name}» удалён${moved ? `: объектов перенесено ${moved}` : ''}`);
    const target = moved ? (next.layers[layerIds(next)[0]]?.short ?? '') : '';
    setMsg({
      text: moved
        ? `Слой «${name}» удалён: ${moved} объектов перенесено на слой «${target}».`
        : `Слой «${name}» удалён.`,
      ok: true,
    });
  }, [commit]);

  const cursor = useMemo(() => {
    if (spaceDown || tool === 'pan') return drag.current?.mode === 'pan' ? 'grabbing' : 'grab';
    if (tool === 'select') return 'default';
    return 'crosshair';
  }, [spaceDown, tool]);

  // ---------------- шапка ----------------

  const tb = (icon: string, title: string, onClick: () => void, opts?: { disabled?: boolean; active?: boolean; wide?: boolean }) => (
    <button
      type="button"
      className={'tb-btn' + (opts?.wide ? ' wide' : '') + (opts?.active ? ' active' : '')}
      title={title}
      aria-label={title}
      disabled={opts?.disabled}
      onClick={onClick}
    >
      <Ic n={icon} />
    </button>
  );

  const toolbar = (
    <div className="toolbar">
      <div className="brand">
        <span className="brandmark"><img src="/logo.png" alt="" width={32} height={32} draggable={false} /></span>
        <span className="brandtext">
          <b>PS<em>Bees</em></b>
          <small>ЧЕРТЕЖИ · DXF · CORELDRAW STYLE</small>
        </span>
      </div>

      <ModeSwitcher mode={mode} onChange={onModeChange} />

      <div className="tb-group" aria-label="Файл">
        {tb('new', 'Новый лист / новый проект (Ctrl+N)', () => setDialog('new'))}
        {tb('open', 'Открыть проект или импорт: SVG, DXF, PDF, EPS/AI, PLT (Ctrl+O)', () => fileRef.current?.click())}
        {tb('save', 'Сохранить проект .psdraw (Ctrl+S)', () => void runExport('project'))}
        {tb('spark', 'Векторизовать изображение (трассировка в контуры)', () => setDialog('trace'))}
        {tb('gerber', MACHINE_UI
          ? 'Экспорт на станок: G-Code, DXF, SVG, PNG (Ctrl+E)'
          : 'Экспорт чертежа: DXF, PDF, EPS, PLT, SVG, проект (Ctrl+E)', () => setDialog('export'), { wide: false })}
      </div>

      <div className="tb-group" aria-label="Отмена и повтор">
        {tb('undo', `Отменить (Ctrl+Z)${past.current.length ? ': ' + past.current[past.current.length - 1].label : ''}`, undo, { disabled: !past.current.length })}
        {tb('redo', `Повторить (Ctrl+Y)${future.current.length ? ': ' + future.current[future.current.length - 1].label : ''}`, redo, { disabled: !future.current.length })}
      </div>

      <div className="tb-group" aria-label="Правка объекта">
        {tb('copy-dup', 'Дублировать (Ctrl+D)', duplicateSel, { disabled: !sel.size })}
        {tb('trash', 'Удалить (Del)', deleteSel, { disabled: !sel.size })}
        {tb('group', 'Сгруппировать (Ctrl+G)', groupSel, { disabled: sel.size < 2 })}
        {tb('ungroup', 'Разгруппировать (Ctrl+Shift+G)', ungroupSel, { disabled: !sel.size })}
        {tb('bezier', 'Преобразовать в кривые (Ctrl+Q)', toCurves, { disabled: !sel.size })}
      </div>

      <div className="tb-group" aria-label="Булевы операции">
        {tb('weld', 'Объединение / Weld (Alt+W)', () => booleanSel('union'), { disabled: sel.size < 2 })}
        {tb('trim', 'Вычитание / Trim (Alt+T)', () => booleanSel('subtract'), { disabled: sel.size < 2 })}
        {tb('intersect', 'Пересечение / Intersect (Alt+I)', () => booleanSel('intersect'), { disabled: sel.size < 2 })}
        {tb('offset', `Контур наружу +${contourState.delta} мм`, () => contourSel(Math.abs(contourState.delta) || 0.1, contourState.layer), { disabled: !sel.size })}
      </div>

      <div className="tb-group" aria-label="Выравнивание">
        {tb('align-left', 'Выровнять по левому краю', () => alignSel('left'), { disabled: !sel.size })}
        {tb('align-center-x', 'Выровнять центры по X выделения', () => alignSel('center-x'), { disabled: !sel.size })}
        {tb('align-center-y', 'Выровнять центры по Y выделения', () => alignSel('center-y'), { disabled: !sel.size })}
        {tb('maximize', 'По центру листа', () => alignSel('page-center'), { disabled: !sel.size })}
        {tb('align-right', 'Выровнять по правому краю', () => alignSel('right'), { disabled: !sel.size })}
        {tb('align-top', 'Выровнять по верхнему краю', () => alignSel('top'), { disabled: !sel.size })}
        {tb('align-bottom', 'Выровнять по нижнему краю', () => alignSel('bottom'), { disabled: !sel.size })}
      </div>

      <div className="tb-group" aria-label="Вид">
        {tb('zoomin', 'Приблизить (Ctrl +)', () => zoomAt(size.w / 2, size.h / 2, 1.25))}
        {tb('zoomout', 'Отдалить (Ctrl −)', () => zoomAt(size.w / 2, size.h / 2, 1 / 1.25))}
        {tb('fit', 'Показать весь лист (F / Ctrl+0)', () => fit())}
        {tb('grid', grid.on ? 'Сетка включена — выключить' : 'Сетка выключена — включить',
          () => setGrid((g) => ({ ...g, on: !g.on })), { active: grid.on })}
        {tb('node', grid.snap ? 'Привязка к сетке и объектам включена — выключить' : 'Привязка выключена',
          () => setGrid((g) => ({ ...g, snap: !g.snap })), { active: grid.snap })}
      </div>

      <div className="tb-group" aria-label="Генератор коробок">
        <button
          type="button"
          className="tb-btn labeled"
          data-action="boxes"
          title="Генератор коробок: 28 типов, шип-паз, раскладка и точный DXF — отдельное окно (Ctrl+B)"
          aria-label="Генератор коробок"
          onClick={openBoxes}
        >
          <Ic n="cube" />
          <span>Коробки</span>
        </button>
      </div>

      <div className="tb-group" aria-label={MACHINE_UI ? 'Развёртка и станок' : 'Развёртка и раскладка'}>
        <button
          type="button"
          className="tb-btn labeled"
          data-action="unfold"
          title="Генератор развёрток: коробка, лоток, цилиндр, передняя панель, шестерня — отдельное окно"
          aria-label="Генератор развёрток"
          onClick={() => setDialog('unfold')}
        >
          <Ic n="unfold" />
          <span>Развёртка</span>
        </button>
        {tb('panel', 'Автораскладка деталей на листе', autoNest, { disabled: !doc.shapes.length })}
        {MACHINE_UI && tb('play', 'Симуляция обработки на станке', runSimulate, { disabled: !doc.shapes.length })}
      </div>

      <div style={{ flex: 1 }} />

      <div className="tb-group" aria-label="Оформление">
        {tb(theme === 'dark' ? 'sun' : 'moon', theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему',
          () => setTheme(theme === 'dark' ? 'light' : 'dark'))}
        {/* активного слоя в шапке нет: слой выбирают во вкладке «Слои»,
            а текущий виден в строке состояния */}
      </div>

      <div className="tb-group toolbar-exit" aria-label="Выход">
        <button type="button" className="tb-btn close-app" title="Закрыть приложение / сайт"
          aria-label="Закрыть приложение или вкладку" onClick={onCloseApp}>
          <Ic n="close" />
        </button>
      </div>
    </div>
  );

  // ---------------- левая колонка ----------------

  const leftColumn = (
    <div className="side" style={{ width: 300 }}>
      <div className="pane-full">
        <div className="tabs">
          <button type="button" className={leftTab === 'objects' ? 'on' : ''} onClick={() => setLeftTab('objects')}>
            Объекты{doc.shapes.length ? ` (${doc.shapes.length})` : ''}
          </button>
          <button type="button" className={leftTab === 'layers' ? 'on' : ''} onClick={() => setLeftTab('layers')}>
            Слои{layerIds(doc).length ? ` (${layerIds(doc).length})` : ''}
          </button>
        </div>
        <div className="pane-scroll">
          {leftTab === 'layers' && (
            <LaserLayersPanel
              doc={doc}
              active={activeLayer}
              onActive={setActiveLayer}
              onPatch={patchLayer}
              onToggleVisible={toggleLayerVisible}
              onToggleLock={toggleLayerLock}
              onShowAll={showAllLayers}
              onAdd={addLayer}
              onDelete={deleteLayer}
            />
          )}
          {leftTab === 'objects' && (
            <LaserObjectsPanel
              doc={doc}
              sel={sel}
              filter={objFilter}
              onFilter={setObjFilter}
              onPick={(id, additive) => {
                if (additive) {
                  const next = new Set(selRef.current);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  setSel(next);
                } else {
                  setSel(new Set([id]));
                }
              }}
              onToggleHidden={(id) => {
                const map = new Map<string, LaserShape>();
                const s = doc.shapes.find((x) => x.id === id);
                if (s) map.set(id, { ...s, hidden: !s.hidden });
                replaceShapes(map, s?.hidden ? 'Объект показан' : 'Объект скрыт');
              }}
              onToggleLocked={(id) => {
                const map = new Map<string, LaserShape>();
                const s = doc.shapes.find((x) => x.id === id);
                if (s) map.set(id, { ...s, locked: !s.locked });
                replaceShapes(map, s?.locked ? 'Объект разблокирован' : 'Объект заблокирован');
              }}
              onShowAll={() => {
                const map = new Map<string, LaserShape>();
                for (const s of doc.shapes) if (s.hidden) map.set(s.id, { ...s, hidden: false });
                if (!map.size) return;
                replaceShapes(map, `Показано скрытых объектов: ${map.size}`);
              }}
              onRename={(id, name) => {
                const map = new Map<string, LaserShape>();
                const s = doc.shapes.find((x) => x.id === id);
                if (s) map.set(id, { ...s, name });
                replaceShapes(map, 'Переименован объект', false);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );

  // ---------------- правая колонка ----------------

  const rightColumn = (
    <div className="side right" style={{ width: 292 }}>
      <div className="pane-full">
        <LaserPropsPanel
          doc={doc}
          shapes={selShapes}
          active={activeLayer}
          actions={propsActions}
          arrayState={arrayState}
          onArrayState={(patch) => setArrayState((s) => ({ ...s, ...patch }))}
          contourState={contourState}
          onContourState={(patch) => setContourState((s) => ({ ...s, ...patch }))}
          msg={msg}
        />
        <LaserGridPanel grid={grid} onGrid={(patch) => setGrid((g) => ({ ...g, ...patch }))} />
        {selShapes.length === 1 && selShapes[0].kind === 'polygon' && (
          <div className="props">
            <h3>Новый многоугольник</h3>
            <NI label="Углов / лучей" value={polygonSides} min={3} max={64} step={1}
              on={(v) => setPolygonSides(Math.round(v))} />
            <label className="laser-check">
              <input type="checkbox" checked={polygonStar} onChange={(e) => setPolygonStar(e.target.checked)} />
              Рисовать звезду
            </label>
          </div>
        )}
        {MACHINE_UI && (
          <>
            <LaserMaterialPanel
              doc={doc}
              onApply={applyMaterial}
              onThickness={(mm) => commit({ ...docRef.current, materialThickness: mm }, `Толщина листа ${mm} мм`, true)}
            />
            <LaserJobPanel
              doc={doc}
              sim={sim}
              busy={simBusy}
              onSimulate={runSimulate}
              onExport={() => setDialog('export')}
              onNest={autoNest}
            />
          </>
        )}
        <div className="props">
          <h3>{MACHINE_UI ? 'Лист станка' : 'Лист и чертёж'}</h3>
          <div className="laser-job-grid">
            <div><span>Проект</span><b title={doc.name}>{doc.name}</b></div>
            <div><span>{MACHINE_UI ? 'Стол' : 'Лист'}</span><b>{doc.w}×{doc.h} мм</b></div>
            <div><span>Объектов</span><b>{doc.shapes.length}</b></div>
            <div><span>Групп</span><b>{doc.groups.length}</b></div>
            {!MACHINE_UI && <div><span>Длина контуров</span><b>{cutLengthMm.toFixed(1)} мм</b></div>}
          </div>
          {!MACHINE_UI && (
            <NI label="Толщина, мм" value={doc.materialThickness} min={0.1} max={50} step={0.1}
              on={(mm) => commit({ ...docRef.current, materialThickness: mm }, `Толщина листа ${mm} мм`, true)} />
          )}
          {!MACHINE_UI && (
            <div className="laser-btnrow">
              <button type="button" className="btn" disabled={!doc.shapes.length} onClick={autoNest}
                title="Автоматически разложить детали на листе без пересечений">
                <Ic n="panel" size={14} />
                <span>Автораскладка</span>
              </button>
              <button type="button" className="btn primary" disabled={!doc.shapes.length} onClick={() => setDialog('export')}
                title="Экспорт чертежа: DXF, SVG, проект (Ctrl+E)">
                <Ic n="gerber" size={14} />
                <span>Экспорт чертежа…</span>
              </button>
            </div>
          )}
          <button type="button" className="btn" onClick={() => setDialog('sheet')}>
            <Ic n="ruler" size={14} />
            <span>{MACHINE_UI ? 'Размер стола и материал…' : 'Размер листа и название…'}</span>
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => setConfirmAsk({
              title: 'Очистить лист?',
              text: 'Все объекты чертежа будут удалены. Действие можно отменить (Ctrl+Z).',
              ok: 'Очистить лист',
              onOk: () => {
                commit({ ...docRef.current, shapes: [], groups: [] }, 'Лист очищен');
                setSel(new Set());
                setConfirmAsk(null);
              },
            })}
          >
            <Ic n="trash" size={14} />
            <span>Очистить лист</span>
          </button>
        </div>
      </div>
    </div>
  );

  const toolMeta = LASER_TOOLS.find((t) => t.id === tool)!;

  return (
    <>
      {toolbar}

      <div className="main">
        {leftColumn}

        <div className="canvas-wrap" ref={wrapRef}>
          <canvas ref={baseRef} className="canvas-base" />
          <canvas
            ref={overRef}
            className="canvas-over"
            style={{ cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
            onWheel={onWheel}
            onContextMenu={(e) => e.preventDefault()}
            onPointerLeave={() => {
              setMouse((m) => ({ ...m, px: -100, py: -100 }));
              setSnapMark(null);
            }}
          />

          <div className="tool-dock" role="toolbar" aria-label="Инструменты редактора чертежей">
            {TOOL_GROUPS.map((grp, gi) => (
              <ToolGroup key={gi}>
                {gi > 0 && <div className="dock-sep" />}
                {grp.map((id) => {
                  const t = LASER_TOOLS.find((x) => x.id === id)!;
                  return (
                    <button
                      key={id}
                      type="button"
                      data-tool-id={id}
                      className={'tb-btn dock-btn' + (tool === id ? ' active' : '')}
                      title={`${t.name} (${t.key}) — ${t.hint}`}
                      onClick={() => { setTool(id); if (id !== 'shape') setNodeEdit(null); }}
                    >
                      <Ic n={t.icon} />
                    </button>
                  );
                })}
              </ToolGroup>
            ))}
          </div>

          {tool === 'trim' && (
            <div className="laser-trimbar" role="group" aria-label="Режим инструмента «Усечь кривую»">
              {TRIM_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-trim-mode={m.id}
                  className={trimMode === m.id ? 'on' : ''}
                  title={`${m.name} (${m.key}) — ${m.hint}`}
                  onClick={() => setTrimMode(m.id)}
                >
                  <Ic n={m.id === 'extend' ? 'extend' : 'cut-curve'} size={13} />
                  {m.name}
                </button>
              ))}
              <label className="laser-check" title="Границами реза считать только выделенные объекты">
                <input
                  type="checkbox"
                  checked={trimOnlySel}
                  onChange={(e) => setTrimOnlySel(e.target.checked)}
                />
                границы — выделенные
              </label>
              <button
                type="button"
                className="btn tiny"
                onClick={breakApartSel}
                title="Разбить кривые по всем точкам пересечений (Ctrl+Shift+X)"
              >
                <Ic n="detach" size={13} /> Разбить по пересечениям
              </button>
            </div>
          )}

          {tool === 'aux' && (
            <div className="laser-auxbar" role="group" aria-label="Вспомогательные линии">
              {AUX_MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  data-aux-mode={m.id}
                  className={auxMode === m.id ? 'on' : ''}
                  title={`${m.name} (${m.key}) — ${m.hint}`}
                  onClick={() => {
                    setAuxMode(m.id);
                    setAuxDraft(null);
                    setAuxPreview(null);
                    setMsg({ text: `«${m.name}»: ${m.hint}`, ok: null });
                  }}
                >
                  <Ic n={AUX_ICONS[m.id]} size={13} />
                  {m.name}
                </button>
              ))}

              {auxMode === 'angle' && (
                <label className="aux-field" title="Наклон вспомогательной линии, градусы от оси X против часовой">
                  Угол, °
                  <input
                    type="number"
                    className="txt"
                    value={auxParams.angleDeg}
                    step={1}
                    onChange={(e) => setAuxParams((p) => ({ ...p, angleDeg: Number(e.target.value) || 0 }))}
                  />
                </label>
              )}
              {auxMode === 'parallel' && (
                <label className="aux-field" title="0 — параллель ровно через точку второго клика">
                  Расстояние, мм
                  <input
                    type="number"
                    className="txt"
                    value={auxParams.distance}
                    min={0}
                    step={0.5}
                    onChange={(e) => setAuxParams((p) => ({ ...p, distance: Math.max(0, Number(e.target.value) || 0) }))}
                  />
                </label>
              )}
              <label className="aux-field" title="Длина вспомогательной линии, если не растягивать на весь лист">
                Длина, мм
                <input
                  type="number"
                  className="txt"
                  value={auxParams.length}
                  min={1}
                  step={10}
                  disabled={auxParams.fullSheet}
                  onChange={(e) => setAuxParams((p) => ({ ...p, length: Math.max(1, Number(e.target.value) || 1) }))}
                />
              </label>
              <label className="laser-check" title="Растянуть линию на весь лист вместо фиксированной длины">
                <input
                  type="checkbox"
                  checked={auxParams.fullSheet}
                  onChange={(e) => setAuxParams((p) => ({ ...p, fullSheet: e.target.checked }))}
                />
                на весь лист
              </label>
              {auxDraft && (
                <button
                  type="button"
                  className="btn tiny"
                  onClick={() => { setAuxDraft(null); setAuxPreview(null); }}
                  title="Отменить незаконченное построение (Esc)"
                >
                  Отменить клик
                </button>
              )}
              <span className="aux-note">
                {AUX_MODES.find((m) => m.id === auxMode)!.clicks === 1
                  ? 'один клик по листу'
                  : `${AUX_MODES.find((m) => m.id === auxMode)!.clicks} клика: ${auxDraft ? auxDraft.pts.length : 0} сделано`}
              </span>
            </div>
          )}

          <div className="laser-tool-hint" title={toolMeta.hint}>
            <Ic n={toolMeta.icon} size={14} />
            <b>{toolMeta.name}</b>
            <span>{tool === 'trim' ? TRIM_MODES.find((m) => m.id === trimMode)!.hint : toolMeta.hint}</span>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept=".psdraw,.pslaser,.json,.svg,.dxf,.pdf,.ai,.eps,.ps,.plt,.hp,.hpgl,.cdr,application/pdf,application/postscript,image/svg+xml,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) openProjectFile(f);
              e.target.value = '';
            }}
          />
        </div>

        {rightColumn}
      </div>

      <div className="status">
        <span>X <b>{mouse.wx.toFixed(2)}</b></span>
        <span>Y <b>{mouse.wy.toFixed(2)}</b></span>
        <span>Лист: <b>{doc.w}×{doc.h} мм</b></span>
        <span title="Активный слой: новые объекты рисуются на нём">
          Слой: <b style={{ color: layerOf(doc, activeLayer).color }}>{layerOf(doc, activeLayer).short}</b>
          {' · '}
          <b>{doc.shapes.filter((s) => s.layer === activeLayer && !s.hidden).length}</b> объ.
          {' · '}
          слоёв <b>{layerIds(doc).length}</b>
        </span>
        <span>
          Сетка: <b>{grid.on ? `${grid.step} мм` : 'выкл.'}</b>
          {' · '}
          <b className={grid.snap ? '' : 'off'}>{grid.snap ? 'привязка' : 'без привязки'}</b>
        </span>
        <span title="100% — натуральный размер на экране 96 dpi (1 мм = 3,78 px)">
          Масштаб: <b>{Math.round((view.s * 100) / 3.7795)}%</b>
          {' · '}{view.s.toFixed(2)} px/мм
        </span>
        <span className="sp" />
        {selShapes.length > 0 && selBBox && (
          <span>
            Выделено: <b>{selShapes.length}</b>
            {' · '}
            <b>{(selBBox[2] - selBBox[0]).toFixed(2)} × {(selBBox[3] - selBBox[1]).toFixed(2)} мм</b>
          </span>
        )}
        {MACHINE_UI && sim && (
          <span title="Рассчитанное время обработки и длина реза">
            Задание: <b>{Math.round(sim.totalTimeSec)} с</b> · рез <b>{sim.cutLengthMm.toFixed(0)} мм</b>
          </span>
        )}
        {!MACHINE_UI && cutLengthMm > 0 && (
          <span title="Суммарная длина видимых контуров чертежа">
            Длина контуров: <b>{cutLengthMm.toFixed(0)} мм</b>
          </span>
        )}
        {msg?.text && (
          <span className={msg.ok === false ? 'status-alert' : 'status-note'} title={msg.text}>{msg.text}</span>
        )}
        <span className="lg" title="Черновик чертежа сохраняется в этом браузере автоматически">
          <span className="pulse" />
          {cloudUser ? 'черновик в сеансе' : 'черновик в браузере'}
          {savedTick ? ` · ${new Date(savedTick).toLocaleTimeString('ru-RU')}` : ''}
        </span>
      </div>

      {dialog === 'boxes' && (
        <BoxStudio doc={doc} onApply={applyBox} onClose={() => setDialog(null)} onMsg={(m) => setMsg({ text: m.text, ok: m.ok })} />
      )}

      {dialog === 'unfold' && (
        <UnfoldWindow
          doc={doc}
          onApply={applyUnfold}
          onClose={() => setDialog(null)}
          onMsg={(m) => setMsg({ text: m.text, ok: m.ok })}
        />
      )}

      {dialog === 'new' && (
        <LaserSheetDialog
          doc={newLaserDoc(doc.w, doc.h, 'Новый чертёж')}
          title="Новый чертёж"
          onClose={() => setDialog(null)}
          onOk={(next) => {
            const preset = MATERIAL_PRESETS.find((m) => m.id === next.materialId);
            const fresh = newLaserDoc(next.w, next.h, next.name);
            fresh.materialThickness = next.thickness;
            fresh.materialPresetId = next.materialId;
            fresh.layers = applyPresetToLayers(fresh.layers, preset);
            past.current = [...past.current, { doc: docRef.current, label: 'Новый проект' }].slice(-HISTORY_LIMIT);
            future.current = [];
            setDoc(fresh);
            setHistTick((t) => t + 1);
            setSel(new Set());
            setSim(null);
            setDialog(null);
            setMsg({ text: `Новый лист ${next.w}×${next.h} мм: «${next.name}»`, ok: true });
            setTimeout(() => fit(fresh), 40);
          }}
        />
      )}
      {dialog === 'sheet' && (
        <LaserSheetDialog
          doc={doc}
          title={MACHINE_UI ? 'Размер стола и материал' : 'Размер листа и название'}
          onClose={() => setDialog(null)}
          onOk={(next) => {
            const preset = MATERIAL_PRESETS.find((m) => m.id === next.materialId);
            commit({
              ...docRef.current,
              name: next.name,
              w: next.w,
              h: next.h,
              materialThickness: next.thickness,
              materialPresetId: next.materialId,
              layers: applyPresetToLayers({ ...docRef.current.layers }, preset),
            }, `Лист ${next.w}×${next.h} мм, толщина ${next.thickness} мм`);
            setDialog(null);
            setTimeout(() => fit(), 40);
          }}
        />
      )}
      {dialog === 'export' && (
        <LaserExportDialog
          doc={doc}
          sim={sim}
          gcode={gcode}
          onGcodeChange={(patch) => setGcode((g) => ({ ...g, ...patch }))}
          dxf={dxfOpts}
          onDxfChange={(patch) => setDxfOpts((o) => ({ ...o, ...patch }))}
          dxfSplit={dxfSplit}
          onDxfSplitChange={setDxfSplit}
          vec={vecOpts}
          onVecChange={(patch) => setVecOpts((v) => ({ ...v, ...patch }))}
          onExport={(format) => void runExport(format)}
          onClose={() => setDialog(null)}
        />
      )}
      {MACHINE_UI && dialog === 'sim' && <LaserSimDialog doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'trace' && (
        <LaserTraceDialog
          layer={workLayer()}
          defaultWidthMm={Math.min(80, Math.max(20, doc.w / 3))}
          onClose={() => setDialog(null)}
          onInsert={(shapes, info) => {
            commit({ ...docRef.current, shapes: [...docRef.current.shapes, ...shapes] },
              `Трассировка изображения: ${shapes.length} контуров`);
            setSel(new Set(shapes.map((s) => s.id)));
            setDialog(null);
            setMsg({ text: info, ok: true });
          }}
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
    </>
  );
}

// Обёртка группы кнопок дока — нужен Fragment с key
function ToolGroup({ children }: { children: ReactNode }) {
  return <Fragment>{children}</Fragment>;
}

/**
 * Станочные режимы из пресета материала — только для слоёв с историческими
 * именами: у чертежа свои слои, и им эти параметры не нужны (в интерфейсе они
 * показываются только при MACHINE_UI).
 */
function applyPresetToLayers(
  layers: Record<string, LaserLayerConfig>,
  preset: MaterialPreset | undefined
): Record<string, LaserLayerConfig> {
  if (!preset) return layers;
  const out = { ...layers };
  const patch = (id: string, p: Partial<LaserLayerConfig>) => {
    if (out[id]) out[id] = { ...out[id], ...p };
  };
  patch('cut', { power: preset.cutPower, speed: preset.cutSpeed, passes: preset.cutPasses, kerf: preset.kerf });
  patch('inner', { power: preset.cutPower, speed: preset.cutSpeed, passes: preset.cutPasses, kerf: preset.kerf });
  patch('fold', { power: preset.foldPower, speed: preset.foldSpeed });
  patch('score', { power: preset.scorePower, speed: preset.scoreSpeed });
  patch('engrave', { power: preset.engravePower, speed: preset.engraveSpeed });
  return out;
}

/** Компактная панель сетки и привязки редактора чертежей. */
function LaserGridPanel({
  grid,
  onGrid,
}: {
  grid: LaserGridConf & { snap: boolean };
  onGrid: (patch: Partial<LaserGridConf & { snap: boolean }>) => void;
}) {
  const steps: [string, string][] = [
    ['0.1', '0,1 мм'],
    ['0.5', '0,5 мм'],
    ['1', '1 мм'],
    ['2', '2 мм'],
    ['5', '5 мм'],
    ['10', '10 мм'],
  ];
  return (
    <div className="props">
      <h3>Сетка и привязка</h3>
      <SI label="Шаг сетки" value={String(grid.step)} on={(v) => onGrid({ step: parseFloat(v) || 1 })} options={steps} />
      <NI label="Главные линии" value={grid.major} min={2} max={100} step={1}
        on={(v) => onGrid({ major: Math.max(2, Math.round(v)) })} />
      <div className="laser-btnrow">
        <button type="button" className={'btn tiny' + (grid.on ? ' primary' : '')}
          onClick={() => onGrid({ on: !grid.on })}>
          {grid.on ? 'Сетка включена' : 'Сетка выключена'}
        </button>
        <button type="button" className={'btn tiny' + (grid.snap ? ' primary' : '')}
          onClick={() => onGrid({ snap: !grid.snap })}>
          {grid.snap ? 'Привязка вкл.' : 'Привязка выкл.'}
        </button>
        <button type="button" className="btn tiny" onClick={() => onGrid({ style: grid.style === 'lines' ? 'dots' : 'lines' })}>
          {grid.style === 'lines' ? 'Линии' : 'Точки'}
        </button>
      </div>
      <p className="sub">
        Привязка сначала ищет узлы и углы ближайших объектов, затем — сетку.
        Alt временно отключает привязку для свободного рисования.
      </p>
    </div>
  );
}
