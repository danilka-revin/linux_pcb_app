// Окно настроек PSBees: отдельное перемещаемое окно со всеми параметрами
// программы — от темы и сетки до зазоров трассировки и горячих клавиш.
//
// Настройки хранятся в трёх местах (исторически сложилось, всё — в localStorage):
//   • src/ui/prefs.ts  — поведение программы (автосохранение, вид, экспорт);
//   • src/ui/panels.ts — Defs: инструменты, сетка, трассировка (ключ lauaut.defs);
//   • src/ui/uiconf.ts — состав и порядок кнопок и панелей (ключ lauaut.ui).
// Окно только меняет эти значения: вся логика применения — в редакторе.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Ic } from './icons';
import { NI, SI, TI } from './widgets';
import { ACCENT_PRESETS, THEME_BASE, type CustomColors } from './palette';
import { PerfBuilder } from './perf';
import { UiBuilder, SideBuilder } from './updater';
import {
  DIV_OPTIONS, GRID_STYLE_NAME, MAJOR_OPTIONS, fmtGridFull, fmtUnit, gridPresets,
  gridSummary, isPresetStep, toMm, type GridConf, type GridStyle, type GridUnit,
} from '../pcb/grid';
import type { Defs } from './panels';
import type { ThemeId } from '../pcb/render';
import { LAYERS, fmt, type LayerId } from '../pcb/model';
import type { SidesConf } from './uiconf';
import type { Prefs, PrintLayer } from './prefs';
import {
  DEFAULT_HOTKEYS, HOTKEYS, HOTKEY_BY_ID, HOTKEY_GROUP_ORDER, addHotkey, assignHotkey,
  clearHotkey, comboLabel, comboOf, hotkeyOwners, isReservedCombo, removeHotkey, type HotkeyMap,
} from './hotkeys';

export type { PrintLayer };

/** Разделы окна настроек: id, иконка, подпись и слова для поиска. */
interface Section {
  id: string;
  icon: string;
  title: string;
  hint: string;
  keys: string;
}

const SECTIONS: Section[] = [
  { id: 'general', icon: 'gear', title: 'Общие', hint: 'Тема, цвета, автосохранение, отмена', keys: 'тема цвет акцент автосохранение история отмена обновления запуск' },
  { id: 'interface', icon: 'uib', title: 'Интерфейс', hint: 'Панели, кнопки, строка состояния', keys: 'интерфейс панель кнопки тулбар док вкладки ширина компактный статус' },
  { id: 'grid', icon: 'grid', title: 'Сетка и привязка', hint: 'Шаг, вид, начало, привязка к объектам', keys: 'сетка шаг mil мм привязка снап объекты оси точки линии перекрестия' },
  { id: 'canvas', icon: 'eye', title: 'Холст и курсор', hint: 'Перекрестие, колесо мыши, качество', keys: 'холст курсор перекрестие координаты колесо зум масштаб качество отрисовка' },
  { id: 'layers', icon: 'layers', title: 'Слои', hint: 'Активный слой меди и видимость слоёв', keys: 'слой k1 k2 медь шелкография контур видимость' },
  { id: 'objects', icon: 'pad', title: 'Новые объекты', hint: 'Чем рисуют инструменты по умолчанию', keys: 'объекты дорожка площадка переход отверстие smd линия текст прямоугольник окружность углы разрыв' },
  { id: 'routing', icon: 'route', title: 'Автотрассировка', hint: 'Зазоры, шаг сетки, цена перехода', keys: 'трассировка автотрассировка зазор переход шаг цена вариант' },
  { id: 'drc', icon: 'probe', title: 'Контроль зазоров', hint: 'Подсветка слишком близких дорожек', keys: 'drc зазор контроль проверка нарушения подсветка' },
  { id: 'files', icon: 'save', title: 'Файлы и экспорт', hint: 'Новая плата, печать 1:1, Gerber', keys: 'файлы экспорт png gerber печать лут новая плата dpi' },
  { id: 'hotkeys', icon: 'keyboard', title: 'Горячие клавиши', hint: 'Свои сочетания для любых действий', keys: 'горячие клавиши shortcuts назначить привязка ctrl alt shift del r m f g' },
  { id: 'data', icon: 'cloud', title: 'Данные и сброс', hint: 'Перенос настроек, черновик, сброс', keys: 'данные сброс импорт экспорт настроек черновик очистить хранилище' },
];

const GRID_STYLES: GridStyle[] = ['dots', 'lines', 'cross', 'none'];
const PRINT_LAYER_NAME: Record<PrintLayer, string> = {
  k1: 'Верхняя медь (K1)', k2: 'Нижняя медь (K2)', s1: 'Шелкография верх',
  s2: 'Шелкография низ', outline: 'Контур платы',
};

// ------------------------------------------------------------------ мелочи

/** Строка «подпись — контрол» с пояснением. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row" title={hint}>
      <span className="set-row-label">{label}</span>
      <span className="set-row-ctl">{children}</span>
    </div>
  );
}

function Check({
  label, hint, value, onChange, disabled,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={'chk set-chk' + (disabled ? ' is-off' : '')} title={hint}>
      <input
        type="checkbox"
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** Блок раздела с заголовком и необязательным пояснением. */
function Block({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <div className="set-block">
      {title && <h3>{title}</h3>}
      {children}
      {note && <p className="set-note">{note}</p>}
    </div>
  );
}

/** Горизонтальный выбор из нескольких значений (кнопки). */
function Choice<T extends string>({
  value, options, onChange, wide,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  wide?: boolean;
}) {
  return (
    <div className={'set-choice' + (wide ? ' wide' : '')} role="group">
      {options.map(([v, t]) => (
        <button
          key={v}
          type="button"
          className={'btn tiny' + (value === v ? ' on' : '')}
          onClick={() => onChange(v)}
        >{t}</button>
      ))}
    </div>
  );
}

const clampN = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

const viewW = (): number => (typeof window === 'undefined' ? 1200 : window.innerWidth);
const viewH = (): number => (typeof window === 'undefined' ? 800 : window.innerHeight);

interface Geom { x: number; y: number; w: number; h: number }

function startGeom(p: Prefs): Geom {
  const w = clampN(p.setW, 520, Math.max(520, viewW() - 24));
  const h = clampN(p.setH, 320, Math.max(320, viewH() - 24));
  const x = p.setX === null ? Math.max(12, Math.round((viewW() - w) / 2)) : clampN(p.setX, 0, Math.max(0, viewW() - 120));
  const y = p.setY === null ? Math.max(12, Math.round((viewH() - h) / 2)) : clampN(p.setY, 0, Math.max(0, viewH() - 60));
  return { x, y, w, h };
}

// ------------------------------------------------------------------ окно

export interface SettingsWindowProps {
  prefs: Prefs;
  setPrefs: (patch: Partial<Prefs>) => void;
  /** настройки инструментов (сетка, объекты, трассировка) */
  defs: Defs;
  setDefs: (patch: Partial<Defs>) => void;
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  colors: CustomColors;
  setColors: (c: CustomColors) => void;
  /** конфигурация интерфейса: группы кнопок и боковые колонки */
  ui: { ids: string[]; hidden: string[]; sides: SidesConf; pinned: string[]; names: Record<string, string> };
  onUi: (next: { ids: string[]; hidden: string[] }) => void;
  onSides: (next: SidesConf) => void;
  /** слои */
  activeCu: 'k1' | 'k2';
  setActiveCu: (l: 'k1' | 'k2') => void;
  hiddenLayers: Set<LayerId>;
  toggleLayer: (l: LayerId) => void;
  layerCounts: Record<string, number>;
  /** сводка о плате — для раздела «Данные» */
  board: { name: string; w: number; h: number; entities: number; groups: number; violations: number };
  version: string | null;
  onClose: () => void;
  /** открыть настройки настоящим отдельным окном браузера */
  onDetach: () => void;
  onReset: () => void;
  onExport: () => void;
  onImport: (f: File) => void;
  onClearDraft: () => void;
}

export function SettingsWindow(props: SettingsWindowProps) {
  const {
    prefs, setPrefs, defs, setDefs, theme, setTheme, colors, setColors, ui, onUi, onSides,
    activeCu, setActiveCu, hiddenLayers, toggleLayer, layerCounts, board, version,
    onClose, onDetach, onReset, onExport, onImport, onClearDraft,
  } = props;

  const [section, setSection] = useState<string>(() =>
    SECTIONS.some((s) => s.id === prefs.setSection) ? prefs.setSection : 'general');
  const [geom, setGeom] = useState<Geom>(() => startGeom(prefs));
  const [maxed, setMaxed] = useState<boolean>(prefs.setMax);
  const [drag, setDrag] = useState<'move' | 'size' | null>(null);
  const [query, setQuery] = useState('');
  const dragRef = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; g: Geom } | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Закрытие по Esc: окно не модальное, но Esc должен его убирать.
  // Исключение — непустой поиск: первое нажатие просто очищает строку поиска.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (query && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { setQuery(''); return; }
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose, query]);

  // Перетаскивание и изменение размера — указатель ловим на окне, а не на элементе:
  // за пределами окна события всё равно приходят, пока кнопка нажата.
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'move') {
        setGeom({
          ...d.g,
          x: clampN(d.g.x + e.clientX - d.sx, 0, Math.max(0, viewW() - 120)),
          y: clampN(d.g.y + e.clientY - d.sy, 0, Math.max(0, viewH() - 44)),
        });
      } else {
        setGeom({
          ...d.g,
          w: clampN(d.g.w + e.clientX - d.sx, 520, Math.max(520, viewW() - 16)),
          h: clampN(d.g.h + e.clientY - d.sy, 320, Math.max(320, viewH() - 16)),
        });
      }
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [drag]);

  // Запоминаем раздел сразу, а геометрию — когда отпустили мышь.
  useEffect(() => { if (prefs.setSection !== section) setPrefs({ setSection: section }); }, [section]);
  useEffect(() => {
    if (drag) return;
    setPrefs({ setW: geom.w, setH: geom.h, setX: maxed ? prefs.setX : geom.x, setY: maxed ? prefs.setY : geom.y, setMax: maxed });
  }, [drag, geom, maxed]);

  // Окно не должно уезжать за край, если уменьшили размер окна браузера.
  useEffect(() => {
    const fit = () => setGeom((g) => ({
      ...g,
      w: clampN(g.w, 520, Math.max(520, viewW() - 16)),
      h: clampN(g.h, 320, Math.max(320, viewH() - 16)),
      x: clampN(g.x, 0, Math.max(0, viewW() - 120)),
      y: clampN(g.y, 0, Math.max(0, viewH() - 44)),
    }));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // Прокрутка к началу при смене раздела.
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [section]);

  const begin = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    if (maxed && mode === 'move') return;
    e.preventDefault();
    dragRef.current = { mode, sx: e.clientX, sy: e.clientY, g: geom };
    setDrag(mode);
  };

  const q = query.trim().toLowerCase();
  const hotkeyHaystack = useMemo(
    () => HOTKEYS.map((h) => `${h.title} ${(prefs.hotkeys[h.id] ?? []).join(' ')}`).join(' ').toLowerCase(),
    [prefs.hotkeys],
  );
  /** Строка поиска показывает только подходящие действия (раздел «Горячие клавиши»). */
  const hkMatch = (h: { id: string; title: string }): boolean =>
    !q || `${h.title} ${(prefs.hotkeys[h.id] ?? []).join(' ')}`.toLowerCase().includes(q);
  const visible = useMemo(
    () => (q
      ? SECTIONS.filter((s) => (s.title + ' ' + s.hint + ' ' + s.keys + ' '
        + (s.id === 'hotkeys' ? hotkeyHaystack : '')).toLowerCase().includes(q))
      : SECTIONS),
    [q, hotkeyHaystack],
  );

  const grid: GridConf = {
    step: defs.grid, unit: defs.gridUnit, style: defs.gridStyle, div: defs.gridDiv,
    major: defs.gridMajor, ox: defs.gridOx, oy: defs.gridOy, snap: defs.snapOn,
    snapObj: defs.snapObj, snapPx: defs.snapPx,
  };
  const presets = useMemo(() => gridPresets(grid.unit), [grid.unit]);
  const gridGroups = useMemo(() => {
    const m = new Map<string, { mm: number; label: string }[]>();
    for (const p of presets) {
      if (!m.has(p.group)) m.set(p.group, []);
      m.get(p.group)!.push(p);
    }
    return [...m.entries()];
  }, [presets]);

  // ---------------- горячие клавиши ----------------
  // recFor — действие, для которого идёт запись сочетания; пока запись идёт,
  // слушаем клавиатуру сами и не пускаем события в редактор.
  const [recFor, setRecFor] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [hkMsg, setHkMsg] = useState('');

  const putHotkeys = (map: HotkeyMap, msg: string) => {
    setPrefs({ hotkeys: map });
    setHkMsg(msg);
    setRecFor(null);
  };
  const assignBinding = useCallback((id: string, combo: string | null, add = false) => {
    if (combo === null) { putHotkeys(clearHotkey(prefs.hotkeys, id), 'Клавиша снята.'); return; }
    const owners = hotkeyOwners(prefs.hotkeys, combo).filter((x) => x !== id);
    const taken = owners.length
      ? ` Снято с: ${owners.map((o) => HOTKEY_BY_ID[o]?.title ?? o).join(', ')}.`
      : (isReservedCombo(combo) ? ' Браузер или система могут перехватить его раньше программы.' : '');
    putHotkeys(
      add ? addHotkey(prefs.hotkeys, id, combo) : assignHotkey(prefs.hotkeys, id, combo),
      `Назначено: ${comboLabel(combo)}.${taken}`,
    );
  }, [prefs.hotkeys, setPrefs]);
  /** Войти в режим записи: полоса записи — сверху, поэтому прокручиваем к ней. */
  const startRec = (id: string, add: boolean) => {
    setAddMode(add);
    setRecFor(id);
    setHkMsg('');
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };
  const removeBinding = (id: string, combo: string) => {
    putHotkeys(removeHotkey(prefs.hotkeys, id, combo), `Снято: ${comboLabel(combo)}.`);
  };
  const resetBinding = (id: string) => {
    let next = clearHotkey(prefs.hotkeys, id);
    for (const c of HOTKEY_BY_ID[id]?.def ?? []) next = addHotkey(next, id, c);
    putHotkeys(next, 'Возвращены стандартные клавиши.');
  };

  useEffect(() => {
    if (!recFor) return;
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { setRecFor(null); setHkMsg('Запись отменена.'); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { assignBinding(recFor, null); return; }
      const c = comboOf(e);
      if (c) assignBinding(recFor, c, addMode);
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [recFor, assignBinding, addMode]);

  const setGridStep = (mm: number) => {
    const v = toMm(mm, grid.unit);
    if (v > 0) setDefs({ grid: v });
  };
  // строка «своего» шага: правится как текст и применяется по Enter/потере фокуса
  const [stepText, setStepText] = useState(() => fmtUnit(grid.step, grid.unit));
  useEffect(() => setStepText(fmtUnit(grid.step, grid.unit)), [grid.step, grid.unit]);
  const applyStep = (text: string) => {
    const v = parseFloat(text.replace(',', '.'));
    if (isFinite(v) && v > 0) setGridStep(v);
    else setStepText(fmtUnit(grid.step, grid.unit));
  };

  const accentBase = THEME_BASE[theme];

  // ---------------------------------------------------------------- разметка разделов

  const renderSection = (): ReactNode => {
    switch (section) {
      // ---------------- Общие ----------------
      case 'general':
        return (
          <>
            <Block title="Оформление">
              <Row label="Тема" hint="Тёмная по умолчанию, светлая — для печати и светлых помещений">
                <Choice<ThemeId>
                  value={theme}
                  options={[['dark', 'Тёмная'], ['light', 'Светлая']]}
                  onChange={setTheme}
                />
              </Row>
              <Row label="Акцентный цвет" hint="Цвет выделения, активных кнопок и полос прогресса">
                <span className="swatches compact">
                  <button
                    className={'swatch auto' + (colors.accent ? '' : ' on')}
                    title="Как в теме" onClick={() => { const n = { ...colors }; delete n.accent; setColors(n); }}
                  />
                  {ACCENT_PRESETS.map((p) => (
                    <button
                      key={p.hex}
                      className={'swatch' + (colors.accent?.toLowerCase() === p.hex ? ' on' : '')}
                      title={p.name}
                      style={{ background: p.hex }}
                      onClick={() => setColors({ ...colors, accent: p.hex })}
                    />
                  ))}
                  <label className="swatch custom" title="Свой цвет акцента">
                    <input
                      type="color"
                      value={colors.accent ?? accentBase.accent}
                      onChange={(e) => setColors({ ...colors, accent: e.target.value })}
                    />
                  </label>
                </span>
              </Row>
              <div className="set-row">
                <span className="set-row-label">Фон, панели, текст</span>
                <span className="set-row-ctl color-fields">
                  {([['page', 'Фон'], ['surface', 'Панели'], ['text', 'Текст']] as const).map(([k, label]) => (
                    <span className="color-field" key={k}>
                      <input
                        type="color"
                        value={colors[k] ?? accentBase[k]}
                        onChange={(e) => setColors({ ...colors, [k]: e.target.value })}
                      />
                      {label}
                      {colors[k] && (
                        <button
                          className="color-reset"
                          title="Вернуть цвет темы"
                          onClick={() => { const n = { ...colors }; delete n[k]; setColors(n); }}
                        >×</button>
                      )}
                    </span>
                  ))}
                </span>
              </div>
              <div className="set-row">
                <span className="set-row-label" />
                <span className="set-row-ctl">
                  <button className="btn tiny" onClick={() => setColors({})}>Сбросить цвета темы</button>
                </span>
              </div>
            </Block>

            <Block title="Редактор" note="Автосохранение пишет черновик в этот браузер (в облачном режиме — в открытую вкладку). Отключите, если плата большая и тормозит ввод.">
              <Check
                label="Восстанавливать прошлую плату при запуске"
                value={prefs.restoreDraft}
                onChange={(v) => setPrefs({ restoreDraft: v })}
              />
              <Check
                label="Автосохранять черновик"
                value={prefs.autosave}
                onChange={(v) => setPrefs({ autosave: v })}
              />
              <Row label="Интервал автосохранения, мс" hint="Как часто писать черновик после правки">
                <NI
                  label="Интервал автосохранения, мс"
                  value={prefs.autosaveMs}
                  step={100} min={200} max={60000}
                  on={(v) => setPrefs({ autosaveMs: Math.round(v) })}
                />
              </Row>
              <Row label="Шагов отмены (0 — автоматически)" hint="Сколько действий держит Ctrl+Z. 0 — считать по размеру платы.">
                <NI
                  label="Шагов отмены"
                  value={prefs.historyDepth}
                  step={10} min={0} max={1000}
                  on={(v) => setPrefs({ historyDepth: Math.round(v) })}
                />
              </Row>
              <Check
                label="Подтверждать удаление (Del)"
                value={prefs.confirmDelete}
                onChange={(v) => setPrefs({ confirmDelete: v })}
              />
              <Check
                label="Проверять обновления при запуске"
                value={prefs.checkUpdates}
                onChange={(v) => setPrefs({ checkUpdates: v })}
              />
            </Block>
          </>
        );

      // ---------------- Интерфейс ----------------
      case 'interface':
        return (
          <>
            <Block title="Окно редактора">
              <Check
                label="Компактный интерфейс"
                hint="Плотнее шапка, панели и поля ввода — больше места под плату"
                value={prefs.compactUi}
                onChange={(v) => setPrefs({ compactUi: v })}
              />
              <Check
                label="Строка состояния внизу окна"
                value={prefs.statusBar}
                onChange={(v) => setPrefs({ statusBar: v })}
              />
              <Check
                label="Подсказка по инструменту в строке состояния"
                value={prefs.statusHint}
                onChange={(v) => setPrefs({ statusHint: v })}
              />
              <Row label="Единицы координат" hint="Что показывать в строке состояния">
                <Choice<Prefs['statusUnits']>
                  value={prefs.statusUnits}
                  options={[['both', 'мм и mil'], ['mm', 'только мм'], ['mil', 'только mil']]}
                  onChange={(v) => setPrefs({ statusUnits: v })}
                />
              </Row>
              <Check
                label="Док инструментов у холста"
                hint="Вертикальная линейка инструментов слева от платы"
                value={prefs.showDock}
                onChange={(v) => setPrefs({ showDock: v })}
              />
            </Block>

            <Block title="Группы кнопок верхней панели">
              <UiBuilder
                ids={ui.ids}
                names={ui.names}
                hidden={ui.hidden}
                pinned={ui.pinned}
                onChange={onUi}
              />
            </Block>

            <Block title="Боковые колонки">
              <SideBuilder
                sideTabs={ui.sides.leftTabs}
                sideNames={{ layers: 'Слои', lib: 'Детали', groups: 'Группы' }}
                leftW={ui.sides.leftW}
                rightW={ui.sides.rightW}
                showRight={ui.sides.showRight}
                onChange={onSides}
              />
            </Block>
          </>
        );

      // ---------------- Сетка ----------------
      case 'grid':
        return (
          <>
            <Block title="Шаг сетки" note={`Сейчас: ${fmtGridFull(grid.step)} · ${gridSummary(grid)}`}>
              <Row label="Шаг" hint="Стандартные шаги (метрика, mil, монтаж) и любое своё значение">
                <select
                  className="set-sel"
                  value={isPresetStep(grid.step) ? String(grid.step) : 'custom'}
                  onChange={(e) => {
                    if (e.target.value === 'custom') return;
                    setDefs({ grid: parseFloat(e.target.value) });
                  }}
                >
                  {!isPresetStep(grid.step) && <option value="custom">своё значение</option>}
                  {gridGroups.map(([g, items]) => (
                    <optgroup key={g} label={g}>
                      {items.map((p) => (
                        <option key={p.mm} value={p.mm} title={p.label}>{fmtUnit(p.mm, grid.unit)} {grid.unit}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Row>
              <Row label={`Своё значение, ${grid.unit}`} hint="Например, 1.27 мм или 50 mil — применится по Enter">
                <span className="set-inline">
                  <input
                    className="txt"
                    value={stepText}
                    onChange={(e) => setStepText(e.target.value)}
                    onBlur={() => { applyStep(stepText); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { applyStep(stepText); (e.target as HTMLInputElement).blur(); }
                      if (e.key === 'Escape') { setStepText(fmtUnit(grid.step, grid.unit)); (e.target as HTMLInputElement).blur(); }
                    }}
                  />
                  <button className="btn tiny" onClick={() => applyStep(stepText)} title="Применить">ОК</button>
                </span>
              </Row>
              <Row label="Единицы сетки" hint="В каких единицах вводить и подписывать шаг">
                <Choice<GridUnit>
                  value={grid.unit}
                  options={[['mm', 'мм'], ['mil', 'mil']]}
                  onChange={(v) => setDefs({ gridUnit: v })}
                />
              </Row>
            </Block>

            <Block title="Отображение">
              <Row label="Вид сетки">
                <Choice<GridStyle>
                  value={grid.style}
                  options={GRID_STYLES.map((s) => [s, GRID_STYLE_NAME[s]] as [GridStyle, string])}
                  onChange={(v) => setDefs({ gridStyle: v })}
                  wide
                />
              </Row>
              <Row label="Подразбиение">
                <SI
                  label="Подразбиение"
                  value={String(grid.div)}
                  options={DIV_OPTIONS.map((d) => [String(d), d === 1 ? 'без подразбиения' : `1/${d} шага`])}
                  on={(v) => setDefs({ gridDiv: Number(v) })}
                />
              </Row>
              <Row label="«Главные» линии">
                <SI
                  label="«Главные» линии"
                  value={String(grid.major)}
                  options={MAJOR_OPTIONS.map((m) => [String(m), m === 1 ? 'нет' : `каждые ${m} узлов`])}
                  on={(v) => setDefs({ gridMajor: Number(v) })}
                />
              </Row>
              <Check
                label="Показывать оси координат"
                value={defs.showAxes}
                onChange={(v) => setDefs({ showAxes: v })}
              />
            </Block>

            <Block title="Начало сетки" note="Смещение удобно, когда плата разведена от своего «нуля»: сетка привязывается к нему.">
              <Row label="X0, мм"><NI label="X0, мм" value={grid.ox} step={grid.step} on={(v) => setDefs({ gridOx: v })} /></Row>
              <Row label="Y0, мм"><NI label="Y0, мм" value={grid.oy} step={grid.step} on={(v) => setDefs({ gridOy: v })} /></Row>
              <button className="btn tiny" onClick={() => setDefs({ gridOx: 0, gridOy: 0 })}>В начало координат</button>
            </Block>

            <Block title="Привязка" note="Привязка к объектам тянет курсор к центрам площадок, концам и серединам дорожек, углам; Alt — временно без привязки.">
              <Check
                label="Привязка к сетке"
                value={grid.snap}
                onChange={(v) => setDefs({ snapOn: v })}
              />
              <Check
                label="Привязка к объектам платы"
                value={grid.snapObj}
                onChange={(v) => setDefs({ snapObj: v, snapOn: v ? true : grid.snap })}
              />
              <Row label="Радиус поиска объектов, px">
                <NI
                  label="Радиус поиска объектов, px"
                  value={grid.snapPx} step={1} min={2} max={40}
                  on={(v) => setDefs({ snapPx: Math.round(v) })}
                />
              </Row>
            </Block>
          </>
        );

      // ---------------- Холст и курсор ----------------
      case 'canvas':
        return (
          <>
            <Block title="Курсор">
              <Check
                label="Перекрестие по курсору"
                value={prefs.crosshair}
                onChange={(v) => setPrefs({ crosshair: v })}
              />
              <Check
                label="Координаты у курсора"
                hint="Плашка с X/Y прямо на холсте"
                value={prefs.cursorLabel}
                onChange={(v) => setPrefs({ cursorLabel: v })}
              />
            </Block>
            <Block title="Масштаб">
              <Check
                label="Колесо мыши масштабирует вид"
                value={prefs.wheelZoom}
                onChange={(v) => setPrefs({ wheelZoom: v })}
              />
              <Check
                label="Инвертировать колесо"
                value={prefs.invertWheel}
                onChange={(v) => setPrefs({ invertWheel: v })}
              />
              <Row label="Шаг масштаба" hint="Во сколько раз меняется масштаб за один щелчок колеса">
                <NI
                  label="Шаг масштаба"
                  value={prefs.zoomStep} step={0.02} min={1.02} max={3}
                  on={(v) => setPrefs({ zoomStep: v })}
                />
              </Row>
            </Block>
            <Block title="Качество отрисовки">
              <PerfBuilder />
            </Block>
          </>
        );

      // ---------------- Слои ----------------
      case 'layers':
        return (
          <>
            <Block title="Активный слой меди" note="Куда ставятся дорожки, SMD-площадки и полигоны. Переключается также клавишей L.">
              <Choice<'k1' | 'k2'>
                value={activeCu}
                options={[['k1', 'K1 — верх'], ['k2', 'K2 — низ']]}
                onChange={setActiveCu}
                wide
              />
            </Block>
            <Block title="Видимость слоёв" note="Скрытый слой не рисуется и не печатается.">
              {LAYERS.map((l) => (
                <div className="set-layer" key={l.id}>
                  <span className="sw" style={{ background: l.color }} />
                  <span className="set-layer-name">
                    {l.short} <small>{l.ru} · {layerCounts[l.id] ?? 0}</small>
                  </span>
                  <button
                    className={'btn tiny' + (hiddenLayers.has(l.id) ? ' uib-hide-on' : '')}
                    onClick={() => toggleLayer(l.id)}
                    title={hiddenLayers.has(l.id) ? 'Показать слой' : 'Скрыть слой'}
                  >
                    {hiddenLayers.has(l.id) ? 'Скрыт' : 'Показан'}
                  </button>
                </div>
              ))}
            </Block>
          </>
        );

      // ---------------- Новые объекты ----------------
      case 'objects':
        return (
          <>
            <Block title="Дорожки">
              <Row label="Ширина дорожки, мм">
                <NI label="Ширина дорожки, мм" value={defs.trackW} step={0.05} min={0.05} max={20} on={(v) => setDefs({ trackW: v })} />
              </Row>
              <Row label="Углы прокладки">
                <Choice<Defs['angle']>
                  value={defs.angle}
                  options={[['45', '45°'], ['90', '90°'], ['free', 'свободно']]}
                  onChange={(v) => setDefs({ angle: v })}
                  wide
                />
              </Row>
              <Row label="Зазор разрыва, мм" hint="Инструмент «Разрыв» — вырезать зазор под амперметр">
                <NI label="Зазор разрыва, мм" value={defs.cutGap} step={0.1} min={0.1} max={50} on={(v) => setDefs({ cutGap: v })} />
              </Row>
              <Check
                label="Ставить площадки на концах разрыва"
                value={defs.cutPads}
                onChange={(v) => setDefs({ cutPads: v })}
              />
            </Block>
            <Block title="Площадки и отверстия">
              <Row label="Форма площадки">
                <Choice<Defs['padShape']>
                  value={defs.padShape}
                  options={[['round', 'Круг'], ['square', 'Квадрат'], ['oct', 'Восьмиугольник']]}
                  onChange={(v) => setDefs({ padShape: v })}
                  wide
                />
              </Row>
              <Row label="Размер площадки, мм">
                <NI label="Размер площадки, мм" value={defs.padSize} step={0.1} min={0.2} max={30} on={(v) => setDefs({ padSize: v })} />
              </Row>
              <Row label="Сверло площадки, мм">
                <NI label="Сверло площадки, мм" value={defs.padDrill} step={0.05} min={0} max={20} on={(v) => setDefs({ padDrill: v })} />
              </Row>
              <Row label="Переход: размер, мм">
                <NI label="Переход: размер, мм" value={defs.viaSize} step={0.1} min={0.2} max={30} on={(v) => setDefs({ viaSize: v })} />
              </Row>
              <Row label="Переход: сверло, мм">
                <NI label="Переход: сверло, мм" value={defs.viaDrill} step={0.05} min={0} max={20} on={(v) => setDefs({ viaDrill: v })} />
              </Row>
              <Row label="Отверстие, мм">
                <NI label="Отверстие, мм" value={defs.holeD} step={0.05} min={0.1} max={30} on={(v) => setDefs({ holeD: v })} />
              </Row>
              <Row label="SMD: ширина, мм">
                <NI label="SMD: ширина, мм" value={defs.smdW} step={0.05} min={0.1} max={30} on={(v) => setDefs({ smdW: v })} />
              </Row>
              <Row label="SMD: высота, мм">
                <NI label="SMD: высота, мм" value={defs.smdH} step={0.05} min={0.1} max={30} on={(v) => setDefs({ smdH: v })} />
              </Row>
            </Block>
            <Block title="Графика">
              <Row label="Линия: толщина, мм">
                <NI label="Линия: толщина, мм" value={defs.lineW} step={0.05} min={0.05} max={20} on={(v) => setDefs({ lineW: v })} />
              </Row>
              <Row label="Линия: слой">
                <SI
                  label="Линия: слой"
                  value={defs.lineLayer}
                  options={[['s1', 'Шелкография верх'], ['s2', 'Шелкография низ'], ['outline', 'Контур']]}
                  on={(v) => setDefs({ lineLayer: v as Defs['lineLayer'] })}
                />
              </Row>
              <Row label="Окружность: толщина, мм">
                <NI label="Окружность: толщина, мм" value={defs.circleW} step={0.05} min={0.05} max={20} on={(v) => setDefs({ circleW: v })} />
              </Row>
              <Row label="Окружность: слой">
                <SI
                  label="Окружность: слой"
                  value={defs.circleLayer}
                  options={[['s1', 'Шелкография верх'], ['s2', 'Шелкография низ'], ['outline', 'Контур']]}
                  on={(v) => setDefs({ circleLayer: v as Defs['circleLayer'] })}
                />
              </Row>
              <Row label="Прямоугольник: слой">
                <SI
                  label="Прямоугольник: слой"
                  value={defs.rectLayer}
                  options={[['s1', 'Шелкография верх'], ['s2', 'Шелкография низ'], ['outline', 'Контур'], ['k1', 'Медь K1'], ['k2', 'Медь K2']]}
                  on={(v) => setDefs({ rectLayer: v as LayerId })}
                />
              </Row>
              <Check
                label="Прямоугольник залитый"
                value={defs.rectFilled}
                onChange={(v) => setDefs({ rectFilled: v })}
              />
              {!defs.rectFilled && (
                <Row label="Прямоугольник: толщина, мм">
                  <NI label="Прямоугольник: толщина, мм" value={defs.rectTh} step={0.05} min={0.05} max={20} on={(v) => setDefs({ rectTh: v })} />
                </Row>
              )}
            </Block>
            <Block title="Текст">
              <Row label="Строка">
                <TI label="Строка" value={defs.text} on={(v) => setDefs({ text: v })} />
              </Row>
              <Row label="Высота, мм">
                <NI label="Высота текста, мм" value={defs.textSize} step={0.1} min={0.3} max={50} on={(v) => setDefs({ textSize: v })} />
              </Row>
              <Row label="Толщина штриха, мм">
                <NI label="Толщина штриха, мм" value={defs.textTh} step={0.05} min={0.05} max={10} on={(v) => setDefs({ textTh: v })} />
              </Row>
              <Row label="Поворот">
                <Choice<string>
                  value={String(defs.textRot)}
                  options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]}
                  onChange={(v) => setDefs({ textRot: Number(v) })}
                  wide
                />
              </Row>
              <Row label="Слой">
                <Choice<Defs['textLayer']>
                  value={defs.textLayer}
                  options={[['s1', 'Шелкография верх'], ['s2', 'Шелкография низ']]}
                  onChange={(v) => setDefs({ textLayer: v })}
                  wide
                />
              </Row>
              <Check
                label="Зеркально (для нижней стороны)"
                value={defs.textMirror}
                onChange={(v) => setDefs({ textMirror: v })}
              />
            </Block>
          </>
        );

      // ---------------- Автотрассировка ----------------
      case 'routing':
        return (
          <>
            <Block title="Параметры трассировщика" note="Работают и в режиме «две точки», и при разводке групп соединений.">
              <Row label="Ширина дорожки, мм">
                <NI label="Ширина дорожки, мм" value={defs.rtW} step={0.05} min={0.05} max={20} on={(v) => setDefs({ rtW: v })} />
              </Row>
              <Row label="Зазор до дорожек и меди, мм">
                <NI label="Зазор до дорожек и меди, мм" value={defs.rtClear} step={0.05} min={0} max={20} on={(v) => setDefs({ rtClear: v })} />
              </Row>
              <Row label="Зазор до площадок и отверстий, мм">
                <NI label="Зазор до площадок и отверстий, мм" value={defs.rtHoleClear} step={0.05} min={0} max={20} on={(v) => setDefs({ rtHoleClear: v })} />
              </Row>
              <Row label="Шаг сетки трассировки, мм" hint="Меньше шаг — точнее, но дольше расчёт">
                <NI label="Шаг сетки трассировки, мм" value={defs.rtStep} step={0.005} min={0.05} max={5} on={(v) => setDefs({ rtStep: v })} />
              </Row>
              <Row label="Цена перехода, мм" hint="Во сколько «миллиметров дорожки» оценивается один переход">
                <NI label="Цена перехода, мм" value={defs.rtViaCost} step={1} min={0} max={200} on={(v) => setDefs({ rtViaCost: v })} />
              </Row>
              <Row label="Штраф за верхний слой" hint="1 — слои равны, 1.5 — верхний слой дороже">
                <NI label="Штраф за верхний слой" value={defs.rtTopMul} step={0.1} min={0.2} max={10} on={(v) => setDefs({ rtTopMul: v })} />
              </Row>
              <Row label="Углы">
                <Choice<Defs['rtAngle']>
                  value={defs.rtAngle}
                  options={[['45', '45°'], ['90', '90°']]}
                  onChange={(v) => setDefs({ rtAngle: v })}
                  wide
                />
              </Row>
              <Check
                label="Разрешить трассировку по верхнему слою"
                value={defs.rtAllowTop}
                onChange={(v) => setDefs({ rtAllowTop: v })}
              />
              <Check
                label="Ставить площадку в пустом месте (под джампер)"
                value={defs.rtAutoPad}
                onChange={(v) => setDefs({ rtAutoPad: v })}
              />
            </Block>
          </>
        );

      // ---------------- Контроль зазоров ----------------
      case 'drc':
        return (
          <>
            <Block
              title="Контроль зазора дорожек"
              note="Слишком близкие дорожки на одном слое подсвечиваются прямо на плате; список нарушений — в правой колонке."
            >
              <Check
                label="Подсвечивать нарушения"
                value={defs.drcEnabled}
                onChange={(v) => setDefs({ drcEnabled: v })}
              />
              <Row label="Минимальный зазор, мм">
                <NI
                  label="Минимальный зазор, мм"
                  value={defs.drcClear} step={0.05} min={0} max={20}
                  on={(v) => setDefs({ drcClear: v })}
                />
              </Row>
              <p className="set-note">
                На текущей плате нарушений: <b>{board.violations}</b>.
                {' '}Исключения настраиваются в правой колонке («Контроль зазора дорожек»).
              </p>
            </Block>
          </>
        );

      // ---------------- Файлы и экспорт ----------------
      case 'files':
        return (
          <>
            <Block title="Новая плата" note="Значения подставляются в диалог «Новая плата».">
              <Row label="Название">
                <TI label="Название" value={prefs.newName} on={(v) => setPrefs({ newName: v })} />
              </Row>
              <Row label="Ширина, мм">
                <NI label="Ширина новой платы, мм" value={prefs.newW} step={5} min={5} max={500} on={(v) => setPrefs({ newW: v })} />
              </Row>
              <Row label="Высота, мм">
                <NI label="Высота новой платы, мм" value={prefs.newH} step={5} min={5} max={500} on={(v) => setPrefs({ newH: v })} />
              </Row>
            </Block>
            <Block title="Печать 1:1 (PNG)" note="ЛУТ и фотошаблон: слой, зеркало, метки центров и разрешение.">
              <Row label="Слой">
                <SI
                  label="Слой печати"
                  value={prefs.pngLayer}
                  options={(Object.keys(PRINT_LAYER_NAME) as PrintLayer[]).map((k) => [k, PRINT_LAYER_NAME[k]])}
                  on={(v) => setPrefs({ pngLayer: v as PrintLayer })}
                />
              </Row>
              <Row label="Разрешение">
                <Choice<string>
                  value={String(prefs.pngDpi)}
                  options={[['300', '300 dpi'], ['600', '600 dpi'], ['1200', '1200 dpi']]}
                  onChange={(v) => setPrefs({ pngDpi: Number(v) })}
                  wide
                />
              </Row>
              <Check
                label="Зеркально (для ЛУТ)"
                value={prefs.pngMirror}
                onChange={(v) => setPrefs({ pngMirror: v })}
              />
              <Check
                label="Метки центров отверстий"
                value={prefs.pngDrill}
                onChange={(v) => setPrefs({ pngDrill: v })}
              />
            </Block>
          </>
        );

      // ---------------- Горячие клавиши ----------------
      case 'hotkeys':
        return (
          <>
            <Block
              title="Горячие клавиши"
              note={'Нажмите «Назначить» у нужного действия и сразу нажмите сочетание — оно начнёт работать тут же. '
                + 'Backspace во время записи снимает клавишу, Esc — отменяет запись. У одного действия может быть '
                + 'несколько сочетаний; если сочетание занято другим действием, оно снимается с него. '
                + 'Клавиши действуют, когда фокус не в поле ввода и не открыто окно.'}
            >
              <div className={'set-rec' + (recFor ? ' on' : '')}>
                {recFor
                  ? (
                    <>
                      <span className="set-rec-dot" />
                      {addMode ? 'Добавить сочетание' : 'Новое сочетание'} для «{HOTKEY_BY_ID[recFor]?.title ?? recFor}»…
                      <button type="button" className="btn tiny" onClick={() => { setRecFor(null); setHkMsg('Запись отменена.'); }}>
                        Отмена (Esc)
                      </button>
                    </>
                  )
                  : 'Нажмите «Назначить» у любого действия — окно перейдёт в режим записи.'}
              </div>
              {hkMsg && <p className="set-note">{hkMsg}</p>}
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button" className="btn tiny"
                  onClick={() => { setPrefs({ hotkeys: DEFAULT_HOTKEYS }); setHkMsg('Все клавиши сброшены на стандартные.'); }}
                >
                  Сбросить все клавиши
                </button>
              </div>
            </Block>
            {HOTKEY_GROUP_ORDER.map((g) => {
              const rows = HOTKEYS.filter((h) => h.group === g && hkMatch(h));
              if (!rows.length) return null;
              return (
                <Block key={g} title={g}>
                  {rows.map((h) => {
                    const list = prefs.hotkeys[h.id] ?? [];
                    const isDef = list.join('|') === h.def.join('|');
                    return (
                      <div className={'set-hk' + (recFor === h.id ? ' is-rec' : '')} key={h.id}>
                        <span className="set-hk-name" title={h.hint}>{h.title}</span>
                        <span className="set-hk-keys">
                          {list.map((c) => (
                            <span className="kbd hk-chip" key={c}>
                              {comboLabel(c)}
                              <button
                                type="button" className="hk-del"
                                title="Снять это сочетание" onClick={() => removeBinding(h.id, c)}
                              >×</button>
                            </span>
                          ))}
                          {!list.length && <span className="set-hk-none">не назначено</span>}
                        </span>
                        <span className="set-hk-act">
                          <button
                            type="button" className={'btn tiny' + (recFor === h.id ? ' primary' : '')}
                            title="Заменить клавиши этого действия"
                            onClick={() => startRec(h.id, false)}
                          >{recFor === h.id && !addMode ? 'Жму…' : 'Назначить'}</button>
                          {list.length > 0 && (
                            <button
                              type="button" className={'btn tiny' + (recFor === h.id && addMode ? ' primary' : '')}
                              title="Добавить ещё одно сочетание (прежние остаются)"
                              onClick={() => startRec(h.id, true)}
                            >{recFor === h.id && addMode ? 'Жму…' : '＋'}</button>
                          )}
                          {!isDef && (
                            <button
                              type="button" className="btn tiny"
                              title="Вернуть стандартные клавиши этого действия"
                              onClick={() => resetBinding(h.id)}
                            >по умолчанию</button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </Block>
              );
            })}
          </>
        );

      // ---------------- Данные и сброс ----------------
      default:
        return (
          <>
            <Block title="Плата и программа">
              <div className="set-facts">
                <div><span>Плата</span><b>{board.name}</b></div>
                <div><span>Размер</span><b>{fmt(board.w)} × {fmt(board.h)} мм</b></div>
                <div><span>Элементов</span><b>{board.entities}</b></div>
                <div><span>Групп</span><b>{board.groups}</b></div>
                <div><span>Версия</span><b>{version ?? 'разработка'}</b></div>
                <div><span>Тема</span><b>{theme === 'dark' ? 'тёмная' : 'светлая'}</b></div>
              </div>
              <p className="set-note">
                Проект и черновик хранятся в этом браузере; на общем сервере — в вашем
                аккаунте. Настройки лежат в localStorage: <code>psbees.prefs</code>,
                {' '}<code>lauaut.defs</code>, <code>lauaut.ui</code>.
              </p>
            </Block>
            <Block title="Перенос настроек">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn" onClick={onExport}>Выгрузить настройки в файл…</button>
                <button className="btn" onClick={() => importRef.current?.click()}>Загрузить из файла…</button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImport(f);
                    e.target.value = '';
                  }}
                />
              </div>
              <p className="set-note">
                Файл содержит настройки программы, инструментов и интерфейса — удобно
                перенести их на другой компьютер. Плата и библиотека деталей в него не входят.
              </p>
            </Block>
            <Block title="Сброс">
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <button className="btn" onClick={onClearDraft}>Очистить черновик платы…</button>
                <button className="btn danger" onClick={onReset}>Сбросить все настройки</button>
              </div>
              <p className="set-note">
                «Очистить черновик» удаляет сохранённую копию текущей платы и открывает
                чистую — сам проект на диске (если вы его скачивали) не трогается.
                «Сбросить все настройки» возвращает значения по умолчанию, включая
                состав кнопок и цвета.
              </p>
            </Block>
          </>
        );
    }
  };

  const cur = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const style = maxed
    ? { left: 8, top: 8, width: viewW() - 16, height: viewH() - 16 }
    : { left: geom.x, top: geom.y, width: geom.w, height: geom.h };

  const win = (
    <div
      className={'set-win' + (maxed ? ' is-max' : '') + (drag ? ' is-drag' : '')}
      style={style}
      role="dialog"
      aria-label="Настройки"
    >
      <div className="set-head" onPointerDown={begin('move')} onDoubleClick={() => setMaxed((m) => !m)}>
        <span className="set-head-ico"><Ic n="gear" size={16} /></span>
        <span className="set-head-title">Настройки</span>
        <span className="set-head-sub">{cur.title}</span>
        <span className="sp" />
        <button
          type="button" className="set-head-btn"
          title="Открыть настройки отдельным окном браузера (на Windows — отдельное окно программы)"
          onClick={onDetach}
        ><Ic n="detach" size={15} /></button>
        <button
          type="button" className="set-head-btn"
          title={maxed ? 'Свернуть окно' : 'Развернуть на весь экран'}
          onClick={() => setMaxed((m) => !m)}
        ><Ic n={maxed ? 'restore' : 'maximize'} size={15} /></button>
        <button type="button" className="set-head-btn set-head-close" title="Закрыть (Esc)" onClick={onClose}>
          <Ic n="close" size={15} />
        </button>
      </div>

      <div className="set-body">
        <div className="set-nav">
          <input
            className="set-search"
            type="search"
            value={query}
            placeholder="Поиск настроек…"
            aria-label="Поиск по настройкам"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="set-nav-list">
            {visible.map((s) => (
              <button
                key={s.id}
                type="button"
                className={'set-nav-item' + (s.id === section ? ' on' : '')}
                title={s.hint}
                onClick={() => setSection(s.id)}
              >
                <Ic n={s.icon} size={16} />
                <span>{s.title}</span>
              </button>
            ))}
            {!visible.length && <div className="set-nav-empty">Ничего не найдено</div>}
          </div>
        </div>
        <div className="set-content" ref={bodyRef}>
          <h2 className="set-title">{cur.title}<small>{cur.hint}</small></h2>
          {renderSection()}
        </div>
      </div>

      <div className="set-foot">
        <button className="btn tiny" onClick={onReset}>Сбросить все настройки</button>
        <span className="sp" />
        <span className="set-foot-note">Изменения применяются сразу</span>
        <button className="btn primary" onClick={onClose}>Готово</button>
      </div>

      {!maxed && (
        <div
          className="set-resize"
          onPointerDown={begin('size')}
          title="Потяните, чтобы изменить размер окна"
        />
      )}
    </div>
  );

  return typeof document === 'undefined' ? win : createPortal(win, document.body);
}
