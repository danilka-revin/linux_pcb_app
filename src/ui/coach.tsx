// Практическое обучение: все мини-уроки крутятся на одном движке.
//
// Урок — это список шагов. Шаг говорит, куда показать (кнопка интерфейса,
// точка на холсте, «в никуда»), и каким должно стать состояние редактора,
// чтобы шаг считался сделанным. Никаких лекций и модальных окон поверх работы:
// оверлей не перехватывает мышь (кроме собственных кнопок), учимся на
// настоящей плате, всё отменяется Ctrl+Z.
//
// Обучение добровольное: пока есть непройденные уроки, под холстом висит
// полоса «Пройти обучение / Пропустить» (Настройки → Обучение: «показывать» /
// «сразу показывать» / «не показывать»). Любой шаг и весь урок пропускаются,
// пропущенное не навязывается.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// ------------------------------------------------------------------ состояние

/**
 * Снимок редактора. Шаги не хранят «правильный путь» — они сравнивают этот
 * снимок с тем, что было на start урока и на входе в шаг, поэтому подсказка
 * ведёт себя одинаково и на пустой плате, и на готовой.
 */
export interface CoachState {
  /** активный инструмент ('select', 'track', 'route', ...) */
  tool: string;
  /** черновик на холсте: тип и число точек */
  draftT: string | null;
  draftPts: number;
  /** объекты на плате по видам + общий «отпечаток» геометрии */
  tracks: number;
  vias: number;
  comps: number;
  /** меняется при любом движении, повороте, отмене — «плата стала другой» */
  docSig: string;
  /** активный слой меди и число скрытых слоёв */
  activeCu: string;
  hidden: number;
  /** выделено элементов; placing — идёт установка детали */
  sel: number;
  placing: boolean;
  /** вид: масштаб и положение, зеркало */
  viewS: number;
  viewX: number;
  viewY: number;
  mir: boolean;
  /** сетка */
  grid: number;
  snapOn: boolean;
  /** автотрассировка (выбрана первая точка) и тест цепи (цепь подсвечена) */
  routeA: boolean;
  probe: boolean;
  /** генератор деталей */
  query: string;
  genOk: boolean;
  /** панель «Генератор» сейчас видна (иначе учим её открыть) */
  genVisible: boolean;
  /** открытый диалог (null — чистый редактор) и вкладка предпросмотра */
  dialog: string | null;
  previewTab: string;
  /** сколько раз плату сохраняли с запуска */
  saved: number;
  /** последняя нажатая клавиша — заполняет движок, не приложение */
  key: string;
  keySeq: number;
}

/**
 * Снимок, который отдаёт приложение: поле «клавиатура» движок подставляет сам,
 * App не должен за ней следить.
 */
export type CoachInput = Omit<CoachState, 'key' | 'keySeq'>;

/** Привычка: сочетание клавиш в том же виде, что пишут шаги. */
export function comboOf(e: {
  key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean;
}): string {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mods = [
    (e.ctrlKey || e.metaKey) ? 'ctrl' : '', e.altKey ? 'alt' : '', e.shiftKey ? 'shift' : '',
  ].filter(Boolean);
  return [...mods, k].join('+');
}

// ------------------------------------------------------------- описание урока

/** Куда указывать: элемент интерфейса, точка на холсте (доли), центр экрана. */
export type CoachSpot =
  | { sel: string; pad?: number }
  | { canvas: [number, number] }
  | { center: true };

export interface CoachStep {
  /** крупная строка подсказки */
  big: ReactNode;
  /** пояснение под ней */
  small?: ReactNode;
  /** куда показывать (нет — просто текст в центре) */
  spot?: CoachSpot;
  /** текст, если элемент цели не найден (панель свёрнута, док скрыт…) */
  elseText?: { big: ReactNode; small?: ReactNode };
  /** шаг актуален только когда это true; иначе показываем needText */
  need?: (s: CoachState) => boolean;
  /** что показывать, пока need не выполнено */
  needText?: { big: ReactNode; small?: ReactNode; spot?: CoachSpot };
  /** клавиша, которая засчитывает шаг: 'r', 'Escape', 'ctrl+z' */
  key?: string;
  /** «действие сделано»: now — сейчас, base — на входе в шаг, start — на старте урока */
  done: (now: CoachState, base: CoachState, start: CoachState) => boolean;
  /** не прятаться, пока открыт диалог (цель шага — внутри диалога) */
  dialog?: boolean;
}

export type PracticeId = 'track' | 'parts' | 'nav' | 'layers' | 'route' | 'files';

export interface Practice {
  id: PracticeId;
  title: string;
  emoji: string;
  blurb: string;
  /** строка в полосе «пройти обучение» (вопросик добавится сам) */
  offer?: string;
  minutes: number;
  /** следующий урок — предлагаем на карточке успеха */
  next?: PracticeId;
  steps: CoachStep[];
  win: { title: string; text: ReactNode; hint?: ReactNode };
}

export const PRACTICES: Practice[] = [
  {
    id: 'track',
    title: 'Твоя первая дорожка',
    emoji: '✏️',
    blurb: 'Инструмент «Дорожка», два клика, ПКМ — и медь на плате.',
    offer: 'Показать, как развести первую дорожку',
    minutes: 1,
    next: 'parts',
    steps: [
      {
        big: 'Нажми «Дорожка»',
        small: <>инструмент в доке слева · или клавиша <kbd>2</kbd></>,
        spot: { sel: '[data-tool-id="track"]', pad: 6 },
        elseText: { big: <>Нажми клавишу <kbd>2</kbd></>, small: 'это инструмент «Дорожка»' },
        done: (n) => n.tool === 'track',
      },
      {
        big: 'Кликни по огоньку',
        small: 'это начало дорожки',
        spot: { canvas: [0.42, 0.45] },
        need: (n) => n.tool === 'track',
        needText: {
          big: 'Вернись на «Дорожку»',
          small: 'клавиша 2',
          spot: { sel: '[data-tool-id="track"]', pad: 6 },
        },
        done: (n) => n.draftT === 'track' && n.draftPts >= 1,
      },
      {
        big: 'Веди мышь — кликни ещё раз',
        small: 'нужно длиннее — кликай дальше',
        spot: { canvas: [0.5, 0.55] },
        need: (n) => n.draftT === 'track' && n.draftPts >= 1,
        needText: { big: 'Кликни по огоньку', small: 'начало дорожки', spot: { canvas: [0.42, 0.45] } },
        done: (n, b) => n.draftPts >= 2 || n.tracks > b.tracks,
      },
      {
        big: 'ПКМ или Esc — готово',
        small: 'двойной клик тоже работает',
        spot: { canvas: [0.52, 0.66] },
        // Esc здесь — действие, а не «пропустить урок»: движок его не перехватывает.
        key: 'Escape',
        done: (n, b) => n.tracks > b.tracks,
      },
    ],
    win: {
      title: 'Готово! Первая дорожка твоя',
      text: 'Клики ведут дорожку, ПКМ — конец. Тренируйся!',
      hint: <>2 — дорожка · L — сменить слой · Ctrl+Z — отмена</>,
    },
  },
  {
    id: 'parts',
    title: 'Поставить деталь из генератора',
    emoji: '🧩',
    blurb: 'Одна строка «dip 8» — и корпус с площадками на плате.',
    minutes: 1,
    next: 'layers',
    steps: [
      {
        big: <>Напиши в генераторе <kbd>dip 8</kbd></>,
        small: 'поле слева · Enter — сразу поставит деталь',
        spot: { sel: '#gen-query', pad: 4 },
        need: (n) => n.genVisible,
        needText: {
          big: 'Открой панель «Генератор»',
          small: 'лампочка в шапке или клавиша I',
          spot: { sel: '[data-learn="tb-gen"]', pad: 5 },
        },
        elseText: { big: 'Нажми клавишу I', small: 'откроет панель «Генератор»' },
        done: (n, b) => n.genOk && (n.query.trim() !== b.query.trim() || /^\s*dip\b/i.test(n.query)),
      },
      {
        big: 'Нажми «Поставить на плату»',
        small: 'или Enter прямо в строке генератора',
        spot: { sel: '[data-learn="gen-place"]', pad: 5 },
        need: (n) => n.genOk,
        needText: {
          big: 'Генератор не понял строку',
          small: 'напиши, например, dip 8 или 1206',
          spot: { sel: '#gen-query', pad: 4 },
        },
        done: (n) => n.placing,
      },
      {
        big: 'Кликни по плате — деталь встанет',
        small: 'R — повернуть, Q — на другую сторону',
        spot: { canvas: [0.45, 0.5] },
        need: (n) => n.placing,
        needText: {
          big: 'Нажми «Поставить на плату»',
          small: 'кнопка под генератором',
          spot: { sel: '[data-learn="gen-place"]', pad: 5 },
        },
        done: (n, b) => n.comps > b.comps,
      },
      {
        big: 'Esc — выйти из режима установки',
        small: 'или поставь ещё пару деталей',
        spot: { center: true },
        key: 'Escape',
        done: (n) => !n.placing,
      },
    ],
    win: {
      title: 'Деталь стоит на плате',
      text: 'Корпуса не нужно рисовать и скачивать — генератор делает их по описанию.',
      hint: <>I — генератор · R — поворот · Q — сторона · Ctrl+Z — отмена</>,
    },
  },
  {
    id: 'nav',
    title: 'Мышь, зум и выделение',
    emoji: '🖱️',
    blurb: 'Колесо, средняя кнопка, «вписать плату», выделение и перетаскивание.',
    minutes: 1,
    next: 'layers',
    steps: [
      {
        big: 'Покрути колесо мыши над платой',
        small: 'зум · кнопки +/− в шапке или клавиши + и −',
        spot: { canvas: [0.5, 0.5] },
        done: (n, b) => Math.abs(n.viewS - b.viewS) > 1e-9,
      },
      {
        big: 'Зажми среднюю кнопку и подвигай плату',
        small: 'холст едет за мышью · нет средней кнопки — пропустите шаг',
        spot: { canvas: [0.44, 0.42] },
        done: (n, b) => Math.abs(n.viewX - b.viewX) + Math.abs(n.viewY - b.viewY) > 4,
      },
      {
        big: 'Нажми «Вписать плату»',
        small: <>клавиша <kbd>F</kbd></>,
        spot: { sel: '[data-learn="tb-fit"]', pad: 5 },
        elseText: { big: <>Нажми <kbd>F</kbd></>, small: 'показать всю плату' },
        key: 'f',
        done: (n, b) => Math.abs(n.viewS - b.viewS) > 1e-9
          || Math.abs(n.viewX - b.viewX) > 2 || Math.abs(n.viewY - b.viewY) > 2,
      },
      {
        big: 'Переверни плату — вид снизу',
        small: 'так смотрят сторону K2 · M зеркалит выделенное на другую сторону',
        spot: { sel: '[data-learn="tb-mirror"]', pad: 5 },
        elseText: { big: 'Кнопка «вид сверху / снизу»', small: 'в группе «вид» в шапке' },
        done: (n, b) => n.mir !== b.mir,
      },
      {
        big: 'Кликни по элементу или обведи рамкой',
        small: 'Shift — добавить к выделению · Ctrl+A — всё',
        spot: { canvas: [0.5, 0.5] },
        need: (n) => n.tool === 'select',
        needText: {
          big: 'Инструмент «Выбор»',
          small: 'клавиша 1',
          spot: { sel: '[data-tool-id="select"]', pad: 6 },
        },
        done: (n) => n.sel > 0,
      },
      {
        big: 'Тяни выделенное мышью',
        small: 'или нажми R — повернуть на 90°',
        spot: { canvas: [0.5, 0.52] },
        need: (n) => n.sel > 0,
        needText: { big: 'Сначала что-нибудь выдели', small: 'клик по элементу', spot: { canvas: [0.5, 0.5] } },
        key: 'r',
        done: (n, b) => n.docSig !== b.docSig,
      },
    ],
    win: {
      title: 'Плата слушается мыши',
      text: 'Колесо — зум, средняя кнопка — панорама, F — видно всё. Дальше — слои.',
      hint: <>F — вписать · Esc — снять выделение · Ctrl+Z — отмена</>,
    },
  },
  {
    id: 'layers',
    title: 'Слои, глазик и переходы',
    emoji: '🗂️',
    blurb: 'K1/K2, скрыть слой, шаг сетки, переход между сторонами.',
    minutes: 2,
    next: 'route',
    steps: [
      {
        big: 'Кликни K2 — нижняя медь',
        small: 'это активный слой, куда ложатся дорожки · L — переключить',
        spot: { sel: '[data-learn="cu-k2"]', pad: 5 },
        key: 'l',
        done: (n, b) => n.activeCu !== b.activeCu,
      },
      {
        big: 'Скрой шелкографию глазиком',
        small: 'панель «Слои» слева — слой исчезнет с холста',
        spot: { sel: '[data-learn="layer-eye-s1"]', pad: 6 },
        done: (n, b) => n.hidden !== b.hidden,
      },
      {
        big: 'Кликни глазик ещё раз — слой вернётся',
        small: 'скрывать удобно, чтобы было видно только медь',
        spot: { sel: '[data-learn="layer-eye-s1"]', pad: 6 },
        done: (n, _b, s) => n.hidden === s.hidden,
      },
      {
        big: 'Поменяй шаг сетки',
        small: 'селектор в шапке · G — следующий шаг',
        spot: { sel: '.tb-sel-grid', pad: 4 },
        done: (n, b) => Math.abs(n.grid - b.grid) > 1e-9,
      },
      {
        big: 'Нажми «Переход»',
        small: 'клавиша 4 — дырка, соединяющая K1 и K2',
        spot: { sel: '[data-tool-id="via"]', pad: 6 },
        done: (n) => n.tool === 'via',
      },
      {
        big: 'Кликни рядом с дорожкой',
        small: 'переход встал — медь с двух сторон соединилась',
        spot: { canvas: [0.5, 0.52] },
        need: (n) => n.tool === 'via',
        needText: { big: 'Сначала «Переход»', small: 'клавиша 4', spot: { sel: '[data-tool-id="via"]', pad: 6 } },
        done: (n, b) => n.vias > b.vias,
      },
    ],
    win: {
      title: 'Слои больше не пугают',
      text: 'Активный слой — куда рисуешь, глазик — что видно, переход — мост между сторонами.',
      hint: <>L — слой · 4 — переход · Ctrl+G — настройки сетки</>,
    },
  },
  {
    id: 'route',
    title: 'Автотрассировка за два клика',
    emoji: '⚡',
    blurb: 'Инструмент «Автотрассировка»: точка A, точка B — и дорожка готова.',
    minutes: 1,
    next: 'files',
    steps: [
      {
        big: 'Нажми «Автотрассировка»',
        small: 'клавиша 9 · дорожку проложит сам, с обходом меди',
        spot: { sel: '[data-tool-id="route"]', pad: 6 },
        elseText: { big: <>Нажми клавишу <kbd>9</kbd></>, small: 'инструмент «Автотрассировка»' },
        done: (n) => n.tool === 'route',
      },
      {
        big: 'Кликни, где начать',
        small: 'в пустом месте встанет площадка под провод',
        spot: { canvas: [0.34, 0.44] },
        need: (n) => n.tool === 'route',
        needText: { big: 'Сначала «Автотрассировка»', small: 'клавиша 9', spot: { sel: '[data-tool-id="route"]', pad: 6 } },
        done: (n) => n.routeA,
      },
      {
        big: 'Кликни, куда вести',
        small: 'второй клик — путь посчитан и нарисован',
        spot: { canvas: [0.66, 0.58] },
        need: (n) => n.routeA,
        needText: { big: 'Выбери первую точку', small: 'клик по плате', spot: { canvas: [0.34, 0.44] } },
        done: (n, b) => n.tracks > b.tracks || n.vias > b.vias,
      },
      {
        big: 'Нажми «Тест цепи»',
        small: 'клавиша 0 — посмотреть, что с чем соединено',
        spot: { sel: '[data-tool-id="probe"]', pad: 6 },
        done: (n) => n.tool === 'probe',
      },
      {
        big: 'Кликни по дорожке',
        small: 'вся цепь подсветится фиолетовым',
        spot: { canvas: [0.5, 0.5] },
        need: (n) => n.tool === 'probe' && n.tracks > 0,
        needText: {
          big: 'Нужна дорожка на плате',
          small: 'разведите две точки — и кликайте по получившейся цепи',
        },
        done: (n) => n.probe,
      },
    ],
    win: {
      title: 'Пусть разводит сам',
      text: 'Два клика — и путь готов. Вся плата — режим «Группы» справа.',
      hint: <>9 — автотрассировка · 0 — тест цепи · Ctrl+Z — откатить трассировку</>,
    },
  },
  {
    id: 'files',
    title: 'Сохранить и отдать в работу',
    emoji: '💾',
    blurb: 'Предпросмотр 2D/3D, сохранение файла и экспорт в Gerber и ЧПУ.',
    minutes: 1,
    next: 'track',
    steps: [
      {
        big: 'Глянь на плату со стороны производства',
        small: 'кнопка «Предпросмотр» в шапке',
        spot: { sel: '[data-learn="tb-preview"]', pad: 5 },
        dialog: true,
        done: (n) => n.dialog === 'board-preview',
      },
      {
        big: 'Переключись на 3D',
        small: 'объёмный вид: детали, толщина текстолита',
        spot: { sel: '[data-learn="preview-3d"]', pad: 5 },
        dialog: true,
        done: (n) => n.previewTab === '3d',
      },
      {
        big: 'Esc — закрыть предпросмотр',
        small: 'или кнопка «Закрыть»',
        spot: { center: true },
        dialog: true,
        key: 'Escape',
        done: (n) => n.dialog === null,
      },
      {
        big: 'Сохрани плату',
        small: 'кнопка «Сохранить» в шапке · Ctrl+S',
        spot: { sel: '[data-learn="tb-save"]', pad: 5 },
        key: 'ctrl+s',
        done: (n, b) => n.saved !== b.saved,
      },
      {
        big: 'Меню рядом с «Сохранить» — экспорт',
        small: 'Gerber для завода, PNG под ЛУТ, G-code для ЧПУ',
        spot: { sel: '[data-learn="tb-export"]', pad: 5 },
        done: (n) => n.dialog === 'export' || n.dialog === 'cnc',
      },
    ],
    win: {
      title: 'Плата готова к производству',
      text: 'Экспорт Gerber и G-code — в меню «Сохранить» рядом; там же печать 1:1 под ЛУТ.',
      hint: <>Ctrl+E — экспорт · Ctrl+S — сохранение · Ctrl+G — сетка</>,
    },
  },
];

export const practiceById = (id: PracticeId): Practice =>
  PRACTICES.find((p) => p.id === id) ?? PRACTICES[0];

// ------------------------------------------------------------ прогресс и опции

/** Ключ localStorage: какие практики пройдены или пропущены. */
export const PRACTICE_KEY = 'psbees.practices.done';
/** Устаревший ключ одиночной практики «первая дорожка» — читаем для совместимости. */
export const FIRST_TRACK_KEY = 'psbees.firstTrack.done';

function readStore(): Set<string> {
  const out = new Set<string>();
  try {
    const raw = globalThis.localStorage?.getItem(PRACTICE_KEY);
    if (raw) for (const id of JSON.parse(raw) as string[]) out.add(id);
    if (globalThis.localStorage?.getItem(FIRST_TRACK_KEY) === '1') out.add('track');
  } catch { /* приватный режим / SSR */ }
  return out;
}

function writeStore(set: Set<string>): void {
  try { globalThis.localStorage?.setItem(PRACTICE_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

/** Пройдена (или пропущена) ли практика — больше она сама не предлагается. */
export function practiceDone(id: PracticeId): boolean {
  return readStore().has(id);
}

export function markPracticeDone(id: PracticeId): void {
  const set = readStore();
  if (set.has(id)) return;
  set.add(id);
  writeStore(set);
  // «Дорожку» помним и в старом ключе: его читали внешние скрипты и тесты.
  if (id === 'track') {
    try { globalThis.localStorage?.setItem(FIRST_TRACK_KEY, '1'); } catch { /* ignore */ }
  }
}

export function donePracticeIds(): PracticeId[] {
  const set = readStore();
  return PRACTICES.map((p) => p.id).filter((id) => set.has(id));
}

/**
 * Как напоминать об обучении. По умолчанию «ask» — полоса «Пройти обучение /
 * Пропустить» под холстом: урок необязательный, поэтому мы не лезем в
 * редактор, а только предлагаем. «auto» — сразу запускать первый непройденный
 * урок, «off» — не напоминать вовсе.
 */
export type LearnOfferMode = 'ask' | 'auto' | 'off';
export const LEARN_ASKED_KEY = 'psbees.learn.asked';

export function learnAsked(): boolean {
  try { return globalThis.localStorage?.getItem(LEARN_ASKED_KEY) === '1'; } catch { return false; }
}

export function markLearnAsked(): void {
  try { globalThis.localStorage?.setItem(LEARN_ASKED_KEY, '1'); } catch { /* ignore */ }
}

export function resetPractices(): void {
  writeStore(new Set());
  try { globalThis.localStorage?.removeItem(FIRST_TRACK_KEY); } catch { /* ignore */ }
  // сбросили прогресс — значит, согласие «не напоминать» тоже в силу
  try { globalThis.localStorage?.removeItem(LEARN_ASKED_KEY); } catch { /* ignore */ }
}

// -------------------------------------------------------------- оверлей-движок

interface SpotBox { kind: 'el' | 'point' | 'none'; x: number; y: number; w: number; h: number }

/** Куда смотреть на текущем шаге: цель шага или цель «сначала сделай другое». */
function spotOf(step: CoachStep, state: CoachState): CoachSpot | undefined {
  const waiting = !step.need || step.need(state);
  return waiting ? step.spot : (step.needText?.spot ?? step.spot);
}

export interface CoachProps {
  /** какой урок показываем */
  practice: PracticeId;
  /** рост числа — перезапуск урока */
  run: number;
  /** снимок редактора (клавиши движок читает сам) */
  state: CoachInput;
  /** открыт диалог: прячемся, если шаг не про этот диалог */
  paused: boolean;
  /** выход: true — дошли до конца, false — пропустили */
  onExit: (id: PracticeId, done: boolean) => void;
  /** перейти к следующему уроку, не выходя в настройки */
  onNext?: (id: PracticeId) => void;
}

const CONF_COLORS = ['#e9b63f', '#7ddc52', '#7ac0ff', '#e5484d', '#c792ea'];

export function CoachOverlay(props: CoachProps) {
  const { practice, run, state, paused, onExit, onNext } = props;
  const p = useMemo(() => practiceById(practice), [practice]);
  const [step, setStep] = useState(0);
  const [finished, setFinished] = useState(false);
  const [spot, setSpot] = useState<SpotBox>({ kind: 'none', x: 0, y: 0, w: 0, h: 0 });
  const [key, setKey] = useState<{ name: string; seq: number }>({ name: '', seq: 0 });

  // Состояние редактора + клавиши — единый «now», с которым работают шаги.
  const now = useMemo<CoachState>(() => ({ ...state, key: key.name, keySeq: key.seq }), [state, key]);

  /** снимок на входе в шаг и на старте урока — от них и считаем «изменилось» */
  const live = useRef<CoachState>(now);
  live.current = now;
  const base = useRef<CoachState>(now);
  const start = useRef<CoachState>(now);
  const keyStart = useRef(0);
  /** открыт диалог: урок «спит», и Esc должен закрывать его, а не выбрасывать из урока */
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Перезапуск (первый показ, повтор из настроек, переход к следующему уроку).
  useLayoutEffect(() => {
    setStep(0);
    setFinished(false);
    start.current = now;
    base.current = now;
    keyStart.current = key.seq;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [practice, run]);

  // Новый шаг: новый отсчёт и прокрутка к цели, если она уехала из вида.
  useLayoutEffect(() => {
    base.current = live.current;
    keyStart.current = key.seq;
    const cur = p.steps[step];
    const sel = cur?.spot && 'sel' in cur.spot ? cur.spot.sel : null;
    if (sel) document.querySelector(sel)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, p]);

  // Автопереходы — только по реальным действиям пользователя.
  useEffect(() => {
    if (finished) return;
    const cur = p.steps[step];
    if (!cur) { setFinished(true); return; }
    if (cur.need && !cur.need(now)) return;
    const keyHit = !!cur.key && key.name === cur.key && key.seq > keyStart.current;
    if (keyHit || cur.done(now, base.current, start.current)) {
      if (step + 1 < p.steps.length) setStep(step + 1);
      else { setFinished(true); markPracticeDone(p.id); }
    }
  }, [p, step, finished, now, key]);

  // Клавиатура: Esc — пропустить урок (кроме шагов, которые сами ждут Esc).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
      if (e.key === 'Escape') {
        const cur = p.steps[step];
        if (cur?.key === 'Escape' || typing || pausedRef.current) return;
        e.preventDefault();
        onExit(p.id, false);
        return;
      }
      if (typing || e.repeat) return;
      const combo = comboOf(e);
      setKey((s) => ({ name: combo, seq: s.seq + 1 }));
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [p, step, onExit]);

  // Положение цели: ресайз, скролл и периодический пересчёт (панели могут
  // перестроиться, а событий об этом нет).
  useEffect(() => {
    if (finished) return;
    const cur = p.steps[step];
    const measure = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const s = cur ? spotOf(cur, live.current) : undefined;
      if (!s || 'center' in s) { setSpot({ kind: 'none', x: vw / 2, y: vh * 0.42, w: 0, h: 0 }); return; }
      if ('sel' in s) {
        const el = document.querySelector(s.sel) as HTMLElement | null;
        if (!el) { setSpot({ kind: 'none', x: vw / 2, y: 110, w: 0, h: 0 }); return; }
        const r = el.getBoundingClientRect();
        const pad = s.pad ?? 5;
        setSpot({ kind: 'el', x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
        return;
      }
      const cv = document.querySelector('.canvas-over') as HTMLElement | null;
      const r = cv ? cv.getBoundingClientRect() : { left: 0, top: 0, width: vw, height: vh };
      const [fx, fy] = s.canvas;
      setSpot({ kind: 'point', x: r.left + r.width * fx, y: r.top + r.height * fy, w: 0, h: 0 });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    const iv = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      window.clearInterval(iv);
    };
  }, [p, step, finished]);

  const confetti = useMemo(() => Array.from({ length: 26 }, (_, i) => ({
    left: (i * 37 + 13) % 100,
    delay: ((i * 53) % 90) / 55,
    dur: 2.4 + ((i * 29) % 100) / 80,
    color: CONF_COLORS[i % CONF_COLORS.length],
    size: 6 + (i % 3) * 3,
    rot: (i * 47) % 180,
  })), []);

  if (typeof document === 'undefined') return null;

  const vw = window.innerWidth, vh = window.innerHeight;
  const cur = p.steps[step];
  if (!cur) return null;
  const waiting = !cur.need || cur.need(now);
  const shown = waiting ? cur : (cur.needText ?? cur);
  const inDialog = paused && !(cur?.dialog || finished);
  if (run === 0 || inDialog) return null;

  // шаг про открытый диалог: поднимаемся над модалкой (её z-index 100),
  // иначе подсказка окажется под затемнением и по ней не кликнуть
  const over = paused && (!!cur?.dialog || finished);
  const spotIsEl = spot.kind === 'el';
  // цель не нашлась (панель скрыта конструктором интерфейса) — текстовый вариант
  const fallback = !!cur?.spot && 'sel' in cur.spot && !spotIsEl;
  const texts = fallback && cur.elseText ? cur.elseText : shown;

  // Позиция подсказки рядом с целью, не вылезая за экран.
  const bubble = ((): { left: number; top: number; tx: number; ty: number; arrow: 'left' | 'right' | 'none' } => {
    if (spot.kind === 'el') {
      const right = spot.x + spot.w + 20;
      if (right + 300 <= vw) return { left: right, top: spot.y + spot.h / 2, tx: 0, ty: -50, arrow: 'left' };
      return { left: spot.x - 20, top: spot.y + spot.h / 2, tx: -100, ty: -50, arrow: 'right' };
    }
    if (spot.kind === 'point') {
      const top = Math.max(70, Math.min(vh - 170, spot.y - 26));
      if (spot.x + 44 + 300 <= vw) return { left: spot.x + 44, top, tx: 0, ty: 0, arrow: 'left' };
      return { left: spot.x - 44, top, tx: -100, ty: 0, arrow: 'right' };
    }
    return { left: vw / 2, top: Math.min(vh - 170, Math.max(90, spot.y)), tx: -50, ty: 0, arrow: 'none' };
  })();

  if (finished) {
    const next = p.next ? practiceById(p.next) : null;
    return createPortal(
      <div className={'coach-root' + (paused ? ' is-over' : '')} aria-label={`Обучение: ${p.title} пройдено`}>
        <div className="coach-confetti" aria-hidden="true">
          {confetti.map((c, i) => (
            <i
              key={i}
              style={{
                left: `${c.left}%`, width: c.size, height: c.size * 0.6, background: c.color,
                animationDelay: `${c.delay}s`, animationDuration: `${c.dur}s`, transform: `rotate(${c.rot}deg)`,
              }}
            />
          ))}
        </div>
        <div className="coach-card" style={{ left: vw / 2, top: vh * 0.42 }}>
          <div className="coach-card-emoji">🎉</div>
          <h3>{p.win.title}</h3>
          <p>{p.win.text}</p>
          <div className="coach-card-btns">
            {next && onNext && (
              <button type="button" className="btn" onClick={() => onNext(next.id)}>
                {next.emoji} {next.title} →
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => onExit(p.id, true)}>Рисовать дальше →</button>
          </div>
          {p.win.hint && <small className="coach-card-hint">{p.win.hint}</small>}
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className={'coach-root' + (over ? ' is-over' : '')} aria-label={`Обучение: ${p.title}`}>
      {spotIsEl && (
        <div className="coach-spot" style={{ left: spot.x, top: spot.y, width: spot.w, height: spot.h }} />
      )}
      {spot.kind === 'point' && (
        <>
          <div
            className="coach-spot coach-spot-round"
            style={{ left: spot.x - 28, top: spot.y - 28, width: 56, height: 56 }}
          />
          <div className="coach-marker" style={{ left: spot.x, top: spot.y }} aria-hidden="true">
            <span className="coach-marker-ring" />
            <span className="coach-marker-core" />
          </div>
        </>
      )}
      <div
        className={`coach-bubble arrow-${bubble.arrow}`}
        style={{ left: bubble.left, top: bubble.top, transform: `translate(${bubble.tx}%, ${bubble.ty}%)` }}
        role="status"
      >
        <button type="button" className="coach-skip" title="Пропустить обучение" onClick={() => onExit(p.id, false)}>✕</button>
        <div className="coach-lesson">{p.emoji} {p.title}</div>
        <div className="coach-big">{texts.big}</div>
        {texts.small && <div className="coach-small">{texts.small}</div>}
        <div className="coach-foot">
          <div className="coach-dots" aria-hidden="true">
            {p.steps.map((_, i) => (
              <span key={i} className={'coach-dot' + (i === step ? ' on' : '') + (i < step ? ' done' : '')} />
            ))}
          </div>
          <span className="coach-links">
            {step + 1 < p.steps.length && (
              <button type="button" className="coach-next" onClick={() => setStep(step + 1)}>пропустить шаг →</button>
            )}
            <span className="coach-esc">Esc — всё пропустить</span>
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ----------------------------------------------------- полоса «пройти обучение»

/** Первый непройденный урок — с него и предлагаем продолжить. */
export function nextPracticeId(): PracticeId | null {
  const next = PRACTICES.find((p) => !practiceDone(p.id));
  return next ? next.id : null;
}

/** Русское склонение: 1 урок, 2 урока, 5 уроков. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/**
 * Полоса внизу окна, пока обучение не пройдено: «Пройти обучение» и
 * «Пропустить». Она не перекрывает редактор и не прыгает перед курсором —
 * стоит себе под холстом. «Пропустить» убирает её навсегда (уроки остаются
 * в Настройки → Обучение), «Пройти» запускает первый непройденный урок.
 */
export function LearnBar({ onStart, onSkip }: {
  /** запустить урок (обычно первый непройденный) */
  onStart: (id: PracticeId) => void;
  /** отказаться — больше не напоминаем */
  onSkip: () => void;
}) {
  const left = PRACTICES.filter((p) => !practiceDone(p.id));
  if (!left.length) return null;
  const next = left[0];
  const passed = PRACTICES.length - left.length;
  return (
    <div className="learn-bar" aria-label="Обучение">
      <span className="learn-bar-ico" aria-hidden="true">🐝</span>
      <span className="learn-bar-text">
        <b>{next.offer ? `${next.offer}?` : `Следующий урок: «${next.title}»`}</b>
        <small>
          {next.blurb} · {left.length} {plural(left.length, 'урок', 'урока', 'уроков')}
          {passed > 0 ? ` · пройдено ${passed} из ${PRACTICES.length}` : ''}
        </small>
      </span>
      <button type="button" className="btn primary learn-bar-go" onClick={() => onStart(next.id)}>
        Пройти обучение
      </button>
      <button type="button" className="btn learn-bar-skip" onClick={onSkip} title="Скрыть навсегда — уроки останутся в Настройки → Обучение">
        Пропустить
      </button>
    </div>
  );
}

// ------------------------------------------------------- карточки уроков (для настроек)

/**
 * Список практик: те же карточки, что и туры, но ведут не в модалку,
 * а прямо в редактор — подсветить и дождаться действия.
 */
export function PracticeList({ onStart, done }: {
  onStart: (id: PracticeId) => void;
  done?: Set<PracticeId>;
}) {
  const set = useMemo(() => done ?? new Set(donePracticeIds()), [done]);
  return (
    <div className="practice-list">
      {PRACTICES.map((p) => (
        <button
          key={p.id}
          type="button"
          className={'practice-card' + (set.has(p.id) ? ' done' : '')}
          onClick={() => onStart(p.id)}
          title={`${p.title} — ${p.steps.length} шагов`}
        >
          <span className="practice-emoji" aria-hidden="true">{p.emoji}</span>
          <span className="practice-body">
            <b>{p.title}</b>
            <small>{p.blurb}</small>
            <span className="practice-meta">{p.steps.length} шагов · {p.minutes} мин · прямо в редакторе</span>
          </span>
          <span className="practice-go">{set.has(p.id) ? '✓ ещё раз' : 'Начать ▶'}</span>
        </button>
      ))}
    </div>
  );
}
