// Боковые панели: слои, библиотека компонентов, свойства.
import { useMemo, useState, type ReactNode } from 'react';
import {
  CATS, LIB, type LibEntry,
} from '../pcb/library';
import { libBBox } from '../pcb/expand';
import { LibPreview } from './libpreview';
import type { UserMacro } from '../pcb/userlib';
import { macroKey } from '../pcb/userlib';
import { LAYERS, fmt, type Doc, type Entity, type LayerId, type PadShape } from '../pcb/model';
import type { GridStyle, GridUnit } from '../pcb/grid';
import { fmtGridFull, GRID_STEPS_MM, gridPresets, isPresetStep, gridSummary } from '../pcb/grid';
import { NI, SI, TI } from './widgets';
import { Ic } from './icons';

export type ToolId =
  | 'select' | 'track' | 'pad' | 'smd' | 'via' | 'hole' | 'line' | 'rect'
  | 'circle' | 'fill' | 'text' | 'ruler' | 'comp' | 'route' | 'probe';

export const TOOLS: { id: ToolId; name: string; icon: string; hint: string }[] = [
  { id: 'select', name: 'Выбор', icon: 'select', hint: 'ЛКМ — выбрать/двигать · рамка — выделить · Del — удалить · R — повернуть · M — другая сторона' },
  { id: 'route', name: 'Автотрассировка', icon: 'route', hint: 'Две точки или группы соединений — выберите режим справа · вход в площадки по низу (K2), к SMD — по слою площадки' },
  { id: 'probe', name: 'Тест цепи', icon: 'probe', hint: 'ЛКМ по дорожке, площадке, переходу или SMD — подсветить всю электрическую цепь · клик мимо — снять' },
  { id: 'track', name: 'Дорожка', icon: 'track', hint: 'ЛКМ — точки излома · ПКМ/Esc — закончить · L — сменить слой с переходом' },
  { id: 'pad', name: 'Площадка', icon: 'pad', hint: 'ЛКМ — поставить площадку (с обеих сторон, с металлизацией)' },
  { id: 'smd', name: 'SMD-площадка', icon: 'smd', hint: 'ЛКМ — поставить планарную площадку на активном слое меди' },
  { id: 'via', name: 'Переход', icon: 'via', hint: 'ЛКМ — поставить переходное отверстие' },
  { id: 'hole', name: 'Отверстие', icon: 'hole', hint: 'ЛКМ — неметаллизированное отверстие' },
  { id: 'line', name: 'Линия', icon: 'line', hint: 'ЛКМ — начало и конец линии (на шелкографии/контуре)' },
  { id: 'rect', name: 'Прямоугольник', icon: 'rect', hint: 'ЛКМ — два противоположных угла' },
  { id: 'circle', name: 'Окружность', icon: 'circle', hint: 'ЛКМ — центр, второй ЛКМ — радиус' },
  { id: 'fill', name: 'Полигон', icon: 'fill', hint: 'ЛКМ — вершины · ПКМ/Esc — замкнуть залитый полигон (земля)' },
  { id: 'text', name: 'Текст', icon: 'text', hint: 'Текст задаётся справа · ЛКМ — поставить · R — повернуть при установке' },
  { id: 'ruler', name: 'Линейка', icon: 'ruler', hint: 'ЛКМ — начало и конец измерения · Esc — убрать' },
  { id: 'comp', name: 'Компонент', icon: 'comp', hint: 'Выберите компонент из библиотеки слева · R — повернуть · Q — сторона · ЛКМ — установить' },
];

export interface Defs {
  // --- сетка (см. src/pcb/grid.ts) ---
  grid: number;                 // шаг привязки, мм
  gridUnit: GridUnit;           // единицы ввода/подписи шага
  gridStyle: GridStyle;         // точки / линии / перекрестия / выкл.
  gridDiv: number;              // подразбиение отображения (1/2/4/5/10)
  gridMajor: number;            // «главные» линии каждые N узлов (1 — нет)
  gridOx: number;               // начало сетки по X, мм
  gridOy: number;               // начало сетки по Y, мм
  snapOn: boolean;              // привязка к сетке
  snapObj: boolean;             // привязка к объектам платы
  snapPx: number;               // радиус привязки к объектам, px
  showAxes: boolean;            // показывать оси координат
  angle: '45' | '90' | 'free';
  trackW: number;
  padShape: PadShape;
  padSize: number;
  padDrill: number;
  viaSize: number;
  viaDrill: number;
  holeD: number;
  smdW: number;
  smdH: number;
  lineW: number;
  lineLayer: 's1' | 's2' | 'outline';
  circleW: number;
  circleLayer: 's1' | 's2' | 'outline';
  rectLayer: LayerId;
  rectFilled: boolean;
  rectTh: number;
  text: string;
  textSize: number;
  textTh: number;
  textRot: number;
  textMirror: boolean;
  textLayer: 's1' | 's2';
  // автотрассировка
  rtW: number;          // ширина дорожки
  rtClear: number;      // зазор до дорожек/меди
  rtHoleClear: number;  // зазор до площадок с отверстием, переходов, отверстий
  rtStep: number;       // шаг сетки трассировки
  rtViaCost: number;    // цена перехода, мм
  rtTopMul: number;     // штраф длины на верхнем слое
  rtAllowTop: boolean;
  rtAngle: '45' | '90';
  rtAutoPad: boolean;   // в пустом месте ставить площадку (под джампер)
}

/** Русская форма числа: plural(2, ['вывод', 'вывода', 'выводов']) */
export const plural = (n: number, forms: [string, string, string]): string => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  return b === 1 ? forms[0] : b >= 2 && b <= 4 ? forms[1] : forms[2];
};

/** Краткая характеристика макроса для панели библиотеки */
export function libSpecText(e: LibEntry): string {
  const sp = e.spec;
  if (!sp) return '';
  const parts: string[] = [];
  if (sp.pins) parts.push(`${sp.pins} ${plural(sp.pins, ['вывод', 'вывода', 'выводов'])}`);
  if (sp.smd) parts.push(`${sp.smd} SMD-${plural(sp.smd, ['площадка', 'площадки', 'площадок'])}`);
  if (sp.holes) parts.push(`${sp.holes} ${plural(sp.holes, ['отверстие', 'отверстия', 'отверстий'])}`);
  if (sp.pitch) parts.push(`шаг ${sp.pitch} мм`);
  if (sp.labels) parts.push(`подписи: ${sp.labels}`);
  return parts.join(' · ');
}

// ---------- панель слоёв ----------
export function LayersPanel({
  activeCu, setActiveCu, hidden, toggleHidden, counts,
}: {
  activeCu: 'k1' | 'k2';
  setActiveCu: (l: 'k1' | 'k2') => void;
  hidden: Set<LayerId>;
  toggleHidden: (l: LayerId) => void;
  counts: Record<string, number>;
}) {
  return (
    <div>
      <h3>Слои</h3>
      {LAYERS.map((l) => {
        const isCu = l.id === 'k1' || l.id === 'k2';
        const active = isCu && activeCu === l.id;
        return (
          <div
            key={l.id}
            className={'layer' + (active ? ' active' : '')}
            onClick={() => { if (isCu) setActiveCu(l.id as 'k1' | 'k2'); }}
            title={isCu ? 'Сделать активным слоем меди' : undefined}
          >
            <span className="sw" style={{ background: l.color }} />
            <span className="nm">
              {l.short} <small>{l.ru} · {counts[l.id] ?? 0}</small>
            </span>
            <button
              className={'eye' + (hidden.has(l.id) ? ' off' : '')}
              title={hidden.has(l.id) ? 'Показать слой' : 'Скрыть слой'}
              onClick={(e) => { e.stopPropagation(); toggleHidden(l.id); }}
            >
              <Ic n="eye" size={16} />
            </button>
          </div>
        );
      })}
      <div className="hint" style={{ padding: '8px 12px' }}>
        Активный слой меди используется для дорожек и SMD. Переключение также: клавиша <span className="kbd">L</span>.
      </div>
    </div>
  );
}

// ---------- библиотека ----------
export function LibraryPanel({
  picked, onPick,
  macros, onPickUser, onDelUser, onImportLmk, onImportZip,
}: {
  picked: string | null;
  onPick: (key: string) => void;
  macros: UserMacro[];
  onPickUser: (name: string) => void;
  onDelUser: (name: string) => void;
  onImportLmk: () => void;
  onImportZip: () => void;
}) {
  const [q, setQ] = useState('');
  const pickedEntry = picked && !picked.startsWith('u:') ? LIB[picked] : undefined;
  const pickedUser = picked && picked.startsWith('u:')
    ? macros.find((m) => 'u:' + macroKey(m) === picked)
    : undefined;
  // элементы выбранного макроса строим один раз (а не на каждый рендер панели)
  const pickedEls = useMemo(() => (pickedEntry ? pickedEntry.build() : undefined), [pickedEntry]);
  const list = useMemo(() => {
    const items = Object.values(LIB);
    const f = q.trim().toLowerCase();
    return CATS.map((cat) => ({
      cat,
      items: items.filter((e) => e.cat === cat && (!f || e.name.toLowerCase().includes(f))),
    })).filter((g) => g.items.length);
  }, [q]);
  const f = q.trim().toLowerCase();
  const myMacros = macros.filter((m) => !f || m.name.toLowerCase().includes(f));
  return (
    <>
      <div className="search">
        <input placeholder="Поиск компонента…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {pickedUser && (
        <div className="lib-prev">
          <LibPreview ents={pickedUser.ents} bl={pickedUser.bl} height={140} />
          <div className="lib-prev-title">{macroKey(pickedUser)}</div>
          <div className="lib-prev-spec">
            мой макрос · {pickedUser.ents.length} {plural(pickedUser.ents.length, ['примитив', 'примитива', 'примитивов'])}
          </div>
          <div className="lib-prev-note">Нажмите на плату, чтобы поставить.</div>
        </div>
      )}
      {pickedEntry && (
        <div className="lib-prev">
          <LibPreview
            libKey={pickedEntry.key}
            els={pickedEls}
            height={140}
          />
          <div className="lib-prev-title">{pickedEntry.name}</div>
          <div className="lib-prev-spec">{libSpecText(pickedEntry)}</div>
          {pickedEntry.spec?.note && <div className="lib-prev-note">{pickedEntry.spec.note}</div>}
          <div className="lib-prev-note">
            Нажмите на плату, чтобы поставить. R — поворот, сторона — в тулбаре.
          </div>
        </div>
      )}
      <div className="lib-list">
        <div>
          <div className="cat">
            Мои макросы (.lmk)
            <span style={{ float: 'right', display: 'inline-flex', gap: 4 }}>
              <button className="btn tiny" onClick={onImportLmk}
                title="Импортировать макрос Sprint-Layout (.lmk) в библиотеку">Импорт…</button>
              <button className="btn tiny" onClick={onImportZip}
                title="Импортировать ZIP-архив с макросами Sprint-Layout (.lmk) в библиотеку">Архив…</button>
            </span>
          </div>
          {myMacros.length === 0 && (
            <div className="lib-hint">Пусто. Импортируйте .lmk или сохраните выделенное как макрос (правый клик → «В макрос»).</div>
          )}
          {myMacros.map((m) => (
            <div
              key={m.name}
              className={'lib-item' + (picked === 'u:' + m.name ? ' picked' : '')}
              onClick={() => onPickUser(m.name)}
              title={`Макрос: ${m.ents.length} прим. Нажмите и установите кликом`}
            >
              {m.name}
              <span
                className="lib-del"
                title="Удалить макрос"
                onClick={(ev) => { ev.stopPropagation(); onDelUser(m.name); }}
              >×</span>
            </div>
          ))}
        </div>
        {list.map((g) => (
          <div key={g.cat}>
            <div className="cat">{g.cat}</div>
            {g.items.map((e) => (
              <div
                key={e.key}
                className={'lib-item' + (picked === e.key ? ' picked' : '')}
                onClick={() => onPick(e.key)}
                title={`${e.name}${libSpecText(e) ? '\n' + libSpecText(e) : ''}${e.spec?.note ? '\n' + e.spec.note : ''}\nНажмите и установите на плату кликом`}
              >
                <span className="lib-name">{e.name}</span>
                {libSpecText(e) && <span className="lib-spec">{libSpecText(e)}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- свойства ----------
/** Шаги сетки трассировки: метрические и дюймовые, от точного к быстрому */
const RT_STEP_OPTIONS: [string, string][] = gridPresets('mm').map((p): [string, string] => [
  String(p.mm),
  `${p.label}${p.mm <= 0.254 ? ' — точно, медленно' : p.mm >= 1.27 ? ' — быстро, грубо' : ''}`,
]);

const silkOpts: [string, string][] = [
  ['s1', 'Шелкография верх (Ш1)'],
  ['s2', 'Шелкография низ (Ш2)'],
];
const lineOpts: [string, string][] = [...silkOpts, ['outline', 'Контур платы']];
const rectOpts: [string, string][] = [
  ['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)'], ...lineOpts,
];

function entityEditor(
  e: Entity,
  patch: (p: Record<string, unknown>) => void,
): JSX.Element {
  switch (e.kind) {
    case 'pad':
      return (<>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <SI label="Форма" value={e.shape} options={[['round', 'Круг'], ['square', 'Квадрат'], ['oct', 'Восьмиугольник']]} on={(v) => patch({ shape: v })} />
        <NI label="Размер, мм" value={e.size} min={0.1} on={(v) => patch({ size: v })} />
        <NI label="Отверстие, мм" value={e.drill} min={0} on={(v) => patch({ drill: v })} />
      </>);
    case 'smd':
      return (<>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Ширина, мм" value={e.w} min={0.1} on={(v) => patch({ w: v })} />
        <NI label="Высота, мм" value={e.h} min={0.1} on={(v) => patch({ h: v })} />
        <SI label="Слой" value={e.layer} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => patch({ layer: v })} />
      </>);
    case 'track':
      return (<>
        <NI label="Ширина, мм" value={e.w} min={0.05} on={(v) => patch({ w: v })} />
        <SI label="Слой" value={e.layer} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => patch({ layer: v })} />
        <div className="sub">Точек: {e.pts.length}. Удалите дорожку и проведите заново, чтобы изменить форму.</div>
      </>);
    case 'via':
      return (<>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Размер, мм" value={e.size} min={0.2} on={(v) => patch({ size: v })} />
        <NI label="Отверстие, мм" value={e.drill} min={0.05} on={(v) => patch({ drill: v })} />
      </>);
    case 'hole':
      return (<>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Диаметр, мм" value={e.d} min={0.1} on={(v) => patch({ d: v })} />
      </>);
    case 'line':
      return (<>
        <NI label="X1" value={e.x1} on={(v) => patch({ x1: v })} />
        <NI label="Y1" value={e.y1} on={(v) => patch({ y1: v })} />
        <NI label="X2" value={e.x2} on={(v) => patch({ x2: v })} />
        <NI label="Y2" value={e.y2} on={(v) => patch({ y2: v })} />
        <NI label="Толщина, мм" value={e.w} min={0.05} on={(v) => patch({ w: v })} />
        <SI label="Слой" value={e.layer} options={lineOpts} on={(v) => patch({ layer: v })} />
      </>);
    case 'circle':
      return (<>
        <NI label="X центра" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y центра" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Радиус, мм" value={e.r} min={0.1} on={(v) => patch({ r: v })} />
        <NI label="Толщина, мм" value={e.w} min={0.05} on={(v) => patch({ w: v })} />
        <SI label="Слой" value={e.layer} options={lineOpts} on={(v) => patch({ layer: v })} />
      </>);
    case 'rect':
      return (<>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Ширина, мм" value={e.w} min={0.1} on={(v) => patch({ w: v })} />
        <NI label="Высота, мм" value={e.h} min={0.1} on={(v) => patch({ h: v })} />
        <SI label="Слой" value={e.layer} options={rectOpts} on={(v) => patch({ layer: v })} />
        <label className="chk">
          <input type="checkbox" checked={e.filled} onChange={(ev) => patch({ filled: ev.target.checked })} />
          Залитый
        </label>
        {!e.filled && <NI label="Толщина линии" value={e.th} min={0.05} on={(v) => patch({ th: v })} />}
      </>);
    case 'text':
      return (<>
        <TI label="Текст" value={e.text} on={(v) => patch({ text: v })} />
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <NI label="Высота, мм" value={e.size} min={0.5} on={(v) => patch({ size: v })} />
        <NI label="Толщина, мм" value={e.th} min={0.05} on={(v) => patch({ th: v })} />
        <SI label="Поворот" value={String(e.rot)} options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]} on={(v) => patch({ rot: Number(v) })} />
        <SI label="Слой" value={e.layer} options={silkOpts} on={(v) => patch({ layer: v })} />
        <label className="chk">
          <input type="checkbox" checked={e.mirror} onChange={(ev) => patch({ mirror: ev.target.checked })} />
          Зеркальный
        </label>
      </>);
    case 'poly':
      return (<>
        <SI label="Слой" value={e.layer} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => patch({ layer: v })} />
        <div className="sub">Вершин: {e.pts.length}</div>
      </>);
    case 'comp':
      return (<>
        <div className="sub">Компонент: <b>{e.name}</b></div>
        <NI label="X, мм" value={e.x} on={(v) => patch({ x: v })} />
        <NI label="Y, мм" value={e.y} on={(v) => patch({ y: v })} />
        <SI label="Поворот" value={String(e.rot)} options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]} on={(v) => patch({ rot: Number(v) })} />
        <SI label="Сторона" value={e.side} options={[['top', 'Сверху'], ['bottom', 'Снизу']]} on={(v) => patch({ side: v })} />
      </>);
  }
}

export function PropsPanel({
  tool, defs, setDefs, activeCu, setActiveCu,
  selEnts, patchEnt, doRotate, doMirror, doDuplicate, doDelete,
  doc, setDocSize,
  placeLib, placeRot, placeSide, setPlaceRot, setPlaceSide, cancelPlace,
  textRot, setTextRot, routeInfo, routeGroups,
}: {
  tool: ToolId;
  defs: Defs;
  setDefs: (p: Partial<Defs>) => void;
  activeCu: 'k1' | 'k2';
  setActiveCu: (l: 'k1' | 'k2') => void;
  selEnts: Entity[];
  patchEnt: (id: string, p: Record<string, unknown>) => void;
  doRotate: () => void; doMirror: () => void; doDuplicate: () => void; doDelete: () => void;
  doc: Doc;
  setDocSize: (w: number, h: number) => void;
  placeLib: string | null;
  placeRot: number; placeSide: 'top' | 'bottom';
  setPlaceRot: (r: number) => void; setPlaceSide: (s: 'top' | 'bottom') => void;
  cancelPlace: () => void;
  textRot: number;
  setTextRot: (r: number) => void;
  routeGroups?: boolean;
  routeInfo?: { msg: string; ok: boolean | null; picking: 'a' | 'b' };
}) {
  void fmt;
  // --- выделенные элементы ---
  if (selEnts.length > 0 && tool !== 'route') {
    const one = selEnts.length === 1 ? selEnts[0] : null;
    return (
      <div className="props">
        <h3>Выделено: {selEnts.length}</h3>
        {one ? entityEditor(one, (p) => patchEnt(one.id, p)) : (
          <div className="sub">Несколько элементов. Общие операции ниже.</div>
        )}
        <div className="row">
          <button className="btn" onClick={doRotate} title="R">Повернуть 90°</button>
          <button className="btn" onClick={doMirror} title="M">На другую сторону</button>
        </div>
        <div className="row">
          <button className="btn" onClick={doDuplicate} title="Ctrl+D">Дублировать</button>
          <button className="btn danger" onClick={doDelete} title="Del">Удалить</button>
        </div>
      </div>
    );
  }

  // --- установка компонента ---
  if (tool === 'comp' && placeLib) {
    const entry = LIB[placeLib];
    return (
      <div className="props">
        <h3>Установка компонента</h3>
        <div className="sub">{entry?.name}</div>
        <SI label="Сторона" value={placeSide} options={[['top', 'Сверху'], ['bottom', 'Снизу (зерк.)']]} on={(v) => setPlaceSide(v as 'top' | 'bottom')} />
        <SI label="Поворот" value={String(placeRot)} options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]} on={(v) => setPlaceRot(Number(v))} />
        <div className="row">
          <button className="btn" onClick={() => setPlaceRot((placeRot + 90) % 360)}>Повернуть (R)</button>
          <button className="btn" onClick={cancelPlace}>Отмена (Esc)</button>
        </div>
        <div className="hint">Кликните на плате — компонент будет установлен. Клавиша <span className="kbd">Q</span> меняет сторону.</div>
      </div>
    );
  }

  // --- параметры активного инструмента ---
  switch (tool) {
    case 'route':
      return (
        <div className="props">
          <h3>Автотрассировка</h3>
          <div className="sub">
            {routeGroups ? 'Параметры для всех групп' : routeInfo?.picking === 'b' ? 'Шаг 2: кликните вторую точку' : 'Шаг 1: кликните первую точку'}
          </div>
          <NI label="Ширина дорожки, мм" value={defs.rtW} min={0.1} on={(v) => setDefs({ rtW: v })} />
          <NI label="Зазор до дорожек, мм" value={defs.rtClear} min={0.1} on={(v) => setDefs({ rtClear: v })} />
          <NI label="Зазор до отверстий, мм" value={defs.rtHoleClear} min={0.1} on={(v) => setDefs({ rtHoleClear: v })} />
          <SI label="Шаг сетки трассировки" value={String(defs.rtStep)}
            options={isPresetStep(defs.rtStep)
              ? RT_STEP_OPTIONS
              : [['custom', `своё: ${defs.rtStep} мм`] as [string, string], ...RT_STEP_OPTIONS]}
            on={(v) => { if (v !== 'custom') setDefs({ rtStep: parseFloat(v) }); }} />
          <NI label="Своё значение шага, мм" value={defs.rtStep} min={0.02} step={0.01}
            on={(v) => setDefs({ rtStep: Math.round(v * 1000) / 1000 })} />
          <div className="sub" style={{ marginTop: 4 }}>
            Список шагов тот же, что у сетки ({RT_STEP_OPTIONS.length} вариантов от 0.02 до 30 мм),
            плюс любое своё значение. Чем мельче шаг, тем точнее трасса, но больше времени и памяти:
            0.254 мм (10 mil) и меньше — «точно, медленно», 1.27 мм (50 mil) — «быстро, грубо».
          </div>
          <SI label="Углы" value={defs.rtAngle} options={[['45', '45°'], ['90', '90°']]} on={(v) => setDefs({ rtAngle: v as '45' | '90' })} />
          <div className="hint" style={{ padding: '4px 2px' }}>
            В площадки-«пяточки» вход только по K2 (сторона пайки), к SMD — по слою
            самой площадки, к переходам — с любого слоя.
          </div>
          <label className="chk" title="Разрешить уходить на верх (K1) через переходные отверстия">
            <input type="checkbox" checked={defs.rtAllowTop} onChange={(e) => setDefs({ rtAllowTop: e.target.checked })} />
            Разрешить верх (K1) и переходы
          </label>
          {defs.rtAllowTop && (<>
            <NI label="Переход: площадка, мм" value={defs.viaSize} min={0.3} on={(v) => setDefs({ viaSize: v })} />
            <NI label="Переход: сверло, мм" value={defs.viaDrill} min={0.1} on={(v) => setDefs({ viaDrill: v })} />
            <NI label="Цена перехода (мм пути)" value={defs.rtViaCost} min={0} on={(v) => setDefs({ rtViaCost: v })} />
            <NI label="Штраф длины на верху, ×" value={defs.rtTopMul} min={1} on={(v) => setDefs({ rtTopMul: v })} />
          </>)}
          {!routeGroups && <><label className="chk" title="Клик в пустое место создаёт площадку с отверстием (место под перемычку/джампер)">
            <input type="checkbox" checked={defs.rtAutoPad} onChange={(e) => setDefs({ rtAutoPad: e.target.checked })} />
            В пустом месте ставить площадку
          </label>
          {defs.rtAutoPad && (<>
            <NI label="Площадка: размер, мм" value={defs.padSize} min={0.3} on={(v) => setDefs({ padSize: v })} />
            <NI label="Площадка: отверстие, мм" value={defs.padDrill} min={0} on={(v) => setDefs({ padDrill: v })} />
          </>)}
          </>}
          {routeInfo?.msg && (
            <div className={'route-msg ' + (routeInfo.ok === false ? 'bad' : routeInfo.ok ? 'ok' : '')}>{routeInfo.msg}</div>
          )}
          <div className="hint">
            Приоритет — нижний слой (сторона пайки): в заданные площадки-«пяточки»
            дорожка входит только по K2, к SMD — по слою самой площадки. Верх используется
            только для обхода препятствий, с переходами. Чужие дорожки обходятся с «зазором до дорожек»,
            чужие площадки с отверстиями, переходы и крепёжные отверстия — с «зазором до отверстий»
            (считается от края медного пятачка / края отверстия). Оранжевый пунктир на плате —
            граница зоны вокруг отверстий, ближе которой дорожка не пройдёт.
            <span className="kbd">Esc</span>/ПКМ — {routeGroups ? 'закончить набор группы' : 'сбросить первую точку'}, <span className="kbd">Ctrl+Z</span> — отменить {routeGroups ? 'всю разводку' : 'дорожку'}.
          </div>
        </div>
      );
    case 'track':
      return (
        <div className="props">
          <h3>Дорожка</h3>
          <NI label="Ширина, мм" value={defs.trackW} min={0.05} on={(v) => setDefs({ trackW: v })} />
          <SI label="Слой" value={activeCu} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => setActiveCu(v as 'k1' | 'k2')} />
          <SI label="Углы" value={defs.angle} options={[['45', '45°'], ['90', '90°'], ['free', 'Свободно']]} on={(v) => setDefs({ angle: v as Defs['angle'] })} />
          <div className="hint">
            ЛКМ — точки, ПКМ/Esc — закончить. <span className="kbd">L</span> во время прокладки —
            переход на другой слой с виой.
          </div>
        </div>
      );
    case 'pad':
      return (
        <div className="props">
          <h3>Площадка</h3>
          <SI label="Форма" value={defs.padShape} options={[['round', 'Круг'], ['square', 'Квадрат'], ['oct', 'Восьмиугольник']]} on={(v) => setDefs({ padShape: v as PadShape })} />
          <NI label="Размер, мм" value={defs.padSize} min={0.3} on={(v) => setDefs({ padSize: v })} />
          <NI label="Отверстие, мм" value={defs.padDrill} min={0} on={(v) => setDefs({ padDrill: v })} />
          <div className="hint">Площадка создаётся сразу на обоих слоях меди и попадает в сверловку.</div>
        </div>
      );
    case 'smd':
      return (
        <div className="props">
          <h3>SMD-площадка</h3>
          <NI label="Ширина, мм" value={defs.smdW} min={0.1} on={(v) => setDefs({ smdW: v })} />
          <NI label="Высота, мм" value={defs.smdH} min={0.1} on={(v) => setDefs({ smdH: v })} />
          <SI label="Слой" value={activeCu} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => setActiveCu(v as 'k1' | 'k2')} />
        </div>
      );
    case 'via':
      return (
        <div className="props">
          <h3>Переходное отверстие</h3>
          <NI label="Размер, мм" value={defs.viaSize} min={0.3} on={(v) => setDefs({ viaSize: v })} />
          <NI label="Отверстие, мм" value={defs.viaDrill} min={0.1} on={(v) => setDefs({ viaDrill: v })} />
        </div>
      );
    case 'hole':
      return (
        <div className="props">
          <h3>Отверстие</h3>
          <NI label="Диаметр, мм" value={defs.holeD} min={0.1} on={(v) => setDefs({ holeD: v })} />
          <div className="hint">Неметаллизированное отверстие (крепёж, фрезеровка).</div>
        </div>
      );
    case 'line':
      return (
        <div className="props">
          <h3>Линия</h3>
          <NI label="Толщина, мм" value={defs.lineW} min={0.05} on={(v) => setDefs({ lineW: v })} />
          <SI label="Слой" value={defs.lineLayer} options={lineOpts} on={(v) => setDefs({ lineLayer: v as Defs['lineLayer'] })} />
        </div>
      );
    case 'rect':
      return (
        <div className="props">
          <h3>Прямоугольник</h3>
          <SI label="Слой" value={defs.rectLayer} options={rectOpts} on={(v) => setDefs({ rectLayer: v as LayerId })} />
          <label className="chk">
            <input type="checkbox" checked={defs.rectFilled} onChange={(e) => setDefs({ rectFilled: e.target.checked })} />
            Залитый (сплошная медь)
          </label>
          {!defs.rectFilled && <NI label="Толщина линии" value={defs.rectTh} min={0.05} on={(v) => setDefs({ rectTh: v })} />}
        </div>
      );
    case 'circle':
      return (
        <div className="props">
          <h3>Окружность</h3>
          <NI label="Толщина, мм" value={defs.circleW} min={0.05} on={(v) => setDefs({ circleW: v })} />
          <SI label="Слой" value={defs.circleLayer} options={lineOpts} on={(v) => setDefs({ circleLayer: v as Defs['circleLayer'] })} />
        </div>
      );
    case 'fill':
      return (
        <div className="props">
          <h3>Полигон (заливка)</h3>
          <SI label="Слой меди" value={activeCu} options={[['k1', 'Медь верх (K1)'], ['k2', 'Медь низ (K2)']]} on={(v) => setActiveCu(v as 'k1' | 'k2')} />
          <div className="hint">
            Сплошной медный полигон (экран, «земля»). ЛКМ — вершины, ПКМ/Esc — замкнуть.
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="props">
          <h3>Текст</h3>
          <TI label="Текст" value={defs.text} on={(v) => setDefs({ text: v })} />
          <NI label="Высота, мм" value={defs.textSize} min={0.5} on={(v) => setDefs({ textSize: v })} />
          <NI label="Толщина, мм" value={defs.textTh} min={0.05} on={(v) => setDefs({ textTh: v })} />
          <SI label="Поворот" value={String(textRot)} options={[['0', '0°'], ['90', '90°'], ['180', '180°'], ['270', '270°']]} on={(v) => setTextRot(Number(v))} />
          <SI label="Слой" value={defs.textLayer} options={silkOpts} on={(v) => setDefs({ textLayer: v as Defs['textLayer'] })} />
          <label className="chk">
            <input type="checkbox" checked={defs.textMirror} onChange={(e) => setDefs({ textMirror: e.target.checked })} />
            Зеркальный
          </label>
        </div>
      );
    case 'ruler':
      return (
        <div className="props">
          <h3>Линейка</h3>
          <div className="hint">Два клика измеряют расстояние. <span className="kbd">Esc</span> — убрать измерение.</div>
        </div>
      );
    case 'comp':
      return (
        <div className="props">
          <h3>Компонент</h3>
          <div className="hint">Выберите компонент в библиотеке слева, затем кликните по плате.</div>
        </div>
      );
    default:
      return (
        <div className="props">
          <h3>Плата</h3>
          <TI label="Название" value={doc.name} on={() => undefined} />
          <NI label="Ширина, мм" value={doc.w} min={5} on={(v) => setDocSize(v, doc.h)} />
          <NI label="Высота, мм" value={doc.h} min={5} on={(v) => setDocSize(doc.w, v)} />
          <div className="hint">
            Клик — выбрать элемент. Двигайте выделенное мышью или стрелками
            (шаг = сетка, <span className="kbd">Shift</span> ×10, <span className="kbd">Alt</span> ÷10).
            <span className="kbd"> Ctrl+A</span> — выделить всё,
            <span className="kbd"> G</span> — следующий шаг сетки,
            <span className="kbd"> Ctrl+G</span> — настройки сетки.
          </div>
        </div>
      );
  }
}
