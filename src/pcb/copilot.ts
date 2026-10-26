// PCB-помощник («разводка словами»): разбор команд на русском языке и их выполнение.
//
// Пользователь пишет или говорит «поставь 4 светодиода в ряд через 5 мм» —
// модуль превращает фразу в команды и применяет их к документу. Чистая логика
// без React (тесты — test/copilot.ts); интерфейс — src/ui/copilot.tsx.
//
// Что понимается:
//   • установка: «поставь 4 светодиода 5мм в ряд через 5 мм», «разъём 2x5
//     справа», «dip 8 в центре», «кнопку 6x6 слева вверху», «3 резистора
//     0805 столбиком», «сетка 2x3 конденсатора», «6 отверстий м3 по кругу»;
//   • соединения: «соедини их», «соедини катоды», «соедини вывод 1»,
//     «соедини D1.2 с R4.1 дорожкой 0.5 по низу»;
//   • дорожки: «дорожка от 10 20 до 30 40 шириной 0.6»;
//   • подписи: «текст „Плата v1“ снизу высотой 2.5»;
//   • плата: «плата 60x40», «отверстия м3 по углам»;
//   • правка: «удали выделенное», «продублируй», «поверни на 90», «сдвинь
//     влево на 2», «отмени», «покажи всю плату», «что ты умеешь».

import * as M from './model';
import type { Comp, Doc, Entity, Pt } from './model';
import { generate } from './gen';
import { expandComp, expandDoc, libElsToEnts } from './expand';
import { nextReference } from './component-data';
import { pruneGroups } from './group';

// ------------------------------------------------------------------ типы

export type CopilotAnchor =
  | { t: 'view' }
  | { t: 'center' }
  | { t: 'point'; x: number; y: number }
  | { t: 'corner'; h: 'l' | 'c' | 'r'; v: 't' | 'm' | 'b'; margin: number }
  | { t: 'near'; ref: string; dir: 'l' | 'r' | 't' | 'b'; gap: number };

export interface CopilotLayout {
  count: number;
  arrangement: 'single' | 'row' | 'col' | 'grid' | 'circle';
  step: number | null;
  stepY: number | null;
  cols: number;
  rows: number;
  radius: number | null;
  anchor: CopilotAnchor;
  rot: number | null;
  side: 'top' | 'bottom' | null;
}

/** Какую площадку брать в каждом компоненте группового соединения. */
export type CopilotPick =
  | { t: 'cathode'; label: string }
  | { t: 'anode'; label: string }
  | { t: 'pin'; n: number; label: string };

export type CopilotCmd =
  | ({ t: 'place'; what: string } & CopilotLayout)
  | ({ t: 'via'; viaSize: number; viaDrill: number } & CopilotLayout)
  | {
      t: 'connect';
      /** явные пары «D1.2 с D2.1» (цепочка по порядку) либо null — групповой режим */
      pairs: { ref: string; pin: number | null }[] | null;
      picks: CopilotPick[];
      width: number | null;
      layer: 'k1' | 'k2' | null;
    }
  | { t: 'track'; pts: Pt[]; width: number | null; layer: 'k1' | 'k2' | null }
  | { t: 'text'; text: string; size: number | null; anchor: CopilotAnchor; bottom: boolean }
  | { t: 'board'; w: number; h: number }
  | { t: 'layers'; n: M.CopperLayers }
  | { t: 'corners'; d: number; margin: number }
  | { t: 'selectAll' }
  | { t: 'clearSel' }
  | { t: 'delete'; target: CopilotTarget }
  | { t: 'duplicate'; target: CopilotTarget }
  | { t: 'rotate'; target: CopilotTarget; times: number }
  | { t: 'mirror'; target: CopilotTarget; axis: 'v' | 'h' }
  | { t: 'move'; target: CopilotTarget; dx: number; dy: number }
  | { t: 'undo' }
  | { t: 'fit' }
  | { t: 'zoomIn' }
  | { t: 'zoomOut' }
  | { t: 'help' };

export type CopilotTarget =
  | { t: 'sel' }
  | { t: 'last' }
  | { t: 'any' }
  | { t: 'all' }
  | { t: 'ref'; ref: string };

export interface CopilotCtx {
  /** центр видимой области, мм */
  center: Pt;
  w: number;
  h: number;
  activeCu: 'k1' | 'k2';
  trackW: number;
  selIds: string[];
  lastIds: string[];
}

export type CopilotEffect = { t: 'undo' } | { t: 'fit' } | { t: 'zoom'; f: number };

export interface CopilotLine {
  ok: boolean;
  text: string;
}

export interface CopilotResult {
  doc: Doc;
  /** null — выделение не трогать */
  select: string[] | null;
  lastIds: string[];
  effects: CopilotEffect[];
  lines: CopilotLine[];
  changed: boolean;
}

// ---------------------------------------------------------- нормализация

const norm = (s: string): string =>
  s
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[“”„]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const NUM = String.raw`([+-]?\d+(?:[.,]\d+)?)`;
const toNum = (s: string): number => parseFloat(s.replace(',', '.'));
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

const toMm = (v: number, u: string | undefined): number => {
  if (!u) return v;
  const t = u.toLocaleLowerCase();
  if (t === 'mil' || t === 'мил') return v * 0.0254;
  if (t === 'см' || t === 'cm') return v * 10;
  return v;
};

const NUMWORDS: [RegExp, number][] = [
  [/^((один|одна|одно|одну|одного))(?![0-9a-zа-я])/, 1],
  [/^((два|две|двух))(?![0-9a-zа-я])/, 2],
  [/^((три|трех))(?![0-9a-zа-я])/, 3],
  [/^((четыре|четырех))(?![0-9a-zа-я])/, 4],
  [/^((пять|пяти))(?![0-9a-zа-я])/, 5],
  [/^((шесть|шести))(?![0-9a-zа-я])/, 6],
  [/^((семь|семи))(?![0-9a-zа-я])/, 7],
  [/^((восемь|восьми))(?![0-9a-zа-я])/, 8],
  [/^((девять|девяти))(?![0-9a-zа-я])/, 9],
  [/^((десять|десяти))(?![0-9a-zа-я])/, 10],
  [/^(одиннадцать)(?![0-9a-zа-я])/, 11],
  [/^(двенадцать)(?![0-9a-zа-я])/, 12],
  [/^(тринадцать)(?![0-9a-zа-я])/, 13],
  [/^(четырнадцать)(?![0-9a-zа-я])/, 14],
  [/^(пятнадцать)(?![0-9a-zа-я])/, 15],
  [/^(шестнадцать)(?![0-9a-zа-я])/, 16],
  [/^(семнадцать)(?![0-9a-zа-я])/, 17],
  [/^(восемнадцать)(?![0-9a-zа-я])/, 18],
  [/^(девятнадцать)(?![0-9a-zа-я])/, 19],
  [/^(двадцать)(?![0-9a-zа-я])/, 20],
];

const ORDW: [RegExp, number][] = [
  [/^перв/, 1],
  [/^втор/, 2],
  [/^треть/, 3],
  [/^четверт/, 4],
  [/^пят/, 5],
  [/^шест/, 6],
  [/^седьм/, 7],
  [/^восьм/, 8],
  [/^девят/, 9],
  [/^десят/, 10],
];

/**
 * Склонения → именительный падеж: генератор понимает «светодиод», а говорят
 * «светодиода», «резисторов», «кнопки». Применяется только к описанию детали.
 */
const DECLENSION: [RegExp, string][] = [
  [/(?<![0-9a-zа-я])светодиод[а-я]*(?![0-9a-zа-я])/g, 'светодиод'],
  [/(?<![0-9a-zа-я])светодик[а-я]*(?![0-9a-zа-я])/g, 'светодиод'],
  [/(?<![0-9a-zа-я])стабилитрон[а-я]*(?![0-9a-zа-я])/g, 'стабилитрон'],
  [/(?<![0-9a-zа-я])диод[а-я]*(?![0-9a-zа-я])/g, 'диод'],
  [/(?<![0-9a-zа-я])транзистор[а-я]*(?![0-9a-zа-я])/g, 'транзистор'],
  [/(?<![0-9a-zа-я])резистор[а-я]*(?![0-9a-zа-я])/g, 'резистор'],
  [/(?<![0-9a-zа-я])конденсатор[а-я]*(?![0-9a-zа-я])/g, 'конденсатор'],
  [/(?<![0-9a-zа-я])кондер[а-я]*(?![0-9a-zа-я])/g, 'конденсатор'],
  [/(?<![0-9a-zа-я])электролит[а-я]*(?![0-9a-zа-я])/g, 'электролит'],
  [/(?<![0-9a-zа-я])катушк[а-я]*(?![0-9a-zа-я])/g, 'катушка'],
  [/(?<![0-9a-zа-я])дрос?сел[а-я]*(?![0-9a-zа-я])/g, 'дроссель'],
  [/(?<![0-9a-zа-я])предохранитель[а-я]*(?![0-9a-zа-я])/g, 'предохранитель'],
  [/(?<![0-9a-zа-я])кнопк[а-я]*(?![0-9a-zа-я])/g, 'кнопка'],
  [/(?<![0-9a-zа-я])тактовик[а-я]*(?![0-9a-zа-я])/g, 'tact'],
  [/(?<![0-9a-zа-я])разъем[а-я]*(?![0-9a-zа-я])/g, 'разъем'],
  [/(?<![0-9a-zа-я])клеммник[а-я]*(?![0-9a-zа-я])/g, 'клеммник'],
  [/(?<![0-9a-zа-я])гнезд[а-я]*(?![0-9a-zа-я])/g, 'гнездо'],
  [/(?<![0-9a-zа-я])панельк[а-я]*(?![0-9a-zа-я])/g, 'панелька'],
  [/(?<![0-9a-zа-я])штыр[а-я]*(?![0-9a-zа-я])/g, 'штыри'],
  [/(?<![0-9a-zа-я])перемычк[а-я]*(?![0-9a-zа-я])/g, 'перемычка'],
  [/(?<![0-9a-zа-я])переход[а-я]*(?![0-9a-zа-я])/g, 'переход'],
  [/(?<![0-9a-zа-я])отверсти[а-я]*(?![0-9a-zа-я])/g, 'отверстие'],
  [/(?<![0-9a-zа-я])площадк[а-я]*(?![0-9a-zа-я])/g, 'площадка'],
  [/(?<![0-9a-zа-я])тестпоинт[а-я]*(?![0-9a-zа-я])/g, 'тестпоинт'],
  [/(?<![0-9a-zа-я])кварц[а-я]*(?![0-9a-zа-я])/g, 'кварц'],
  [/(?<![0-9a-zа-я])резонатор[а-я]*(?![0-9a-zа-я])/g, 'резонатор'],
  [/(?<![0-9a-zа-я])модул[а-я]*(?![0-9a-zа-я])/g, 'модуль'],
  [/(?<![0-9a-zа-я])корпус[а-я]*(?![0-9a-zа-я])/g, 'корпус'],
  [/(?<![0-9a-zа-я])реле(?![0-9a-zа-я])/g, 'реле'],
  [/(?<![0-9a-zа-я])ряд[а-я]*(?![0-9a-zа-я])/g, 'ряд'],
  [/(?<![0-9a-zа-я])пин[а-я]*(?![0-9a-zа-я])/g, 'пин'],
  [/(?<![0-9a-zа-я])плат[а-я]*(?![0-9a-zа-я])/g, 'плата'],
];

const normalizeDeclension = (s: string): string => {
  let out = ` ${s} `;
  for (const [re, to] of DECLENSION) out = out.replace(re, to);
  return out.trim().replace(/\s+/g, ' ');
};

/** Генератор с пониманием склонений. */
const genQuery = (what: string) => generate(normalizeDeclension(what));

const VERB_SPLIT =
  /поставь|поставить|добавь|добавить|вставь|вставить|размести|разместить|создай|создать|нарисуй|проведи|провести|сделай|сделать|напиши|написать|подпиши|подписать|удали|удалить|сотри|стереть|убери|выдели|выделить|сними|снять|покажи|показать|поверни|повернуть|отрази|отразить|продублируй|дублируй|скопируй|сдвинь|сдвинуть|подвинь|перемести|отмени|отменить|соедини|соединить|свяжи|связать|спаяй|дорожка|дорожку|перемычка|текст|надпись/i;

const PLACE_VERB = /постав|добав|встав|размест|создай|создать|нарисуй|нарисовать|хочу|пусть/;
const CONNECT_VERB = /соедини|соединить|свяжи|связать|спаяй|сп(о|а)ять/;

/** Разбить реплику на отдельные команды. */
export function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const ln of String(text ?? '').split(/\n+/)) {
    for (const sc of ln.split(/\s*[;]+\s*/)) {
      // точка с пробелом (десятичные «0.5» — без пробела — не трогаем)
      for (const st of sc.split(/[.!?…]+\s+(?=[A-Za-zА-Яа-яЁё«"'«(])/)) {
        for (const th of st.split(/\s+(?:а?\s*потом|затем|далее|после\s+этого)\s+/i)) {
          for (const and of th.split(new RegExp(String.raw`\s+и\s+(?=${VERB_SPLIT.source})`, 'i'))) {
            const t = and.trim().replace(/^[,\s]+|[,\s]+$/g, '');
            if (t) out.push(t);
          }
        }
      }
    }
  }
  return out;
}

/** Разобрать реплику пользователя в команды. */
export function parseCopilot(text: string): CopilotCmd[] {
  const cmds: CopilotCmd[] = [];
  for (const clause of splitClauses(text)) {
    const c = parseClause(clause);
    if (c) cmds.push(c);
  }
  return cmds;
}

function parseClause(raw: string): CopilotCmd | null {
  const s = norm(raw);
  if (!s) return null;
  return (
    mHelp(s) ??
    mUndo(s) ??
    mSelect(s) ??
    mDelete(s) ??
    mDuplicate(s) ??
    mRotate(s) ??
    mMirror(s) ??
    mMove(s) ??
    mLayers(s) ??
    mBoard(s) ??
    mCorners(s) ??
    mText(s, raw) ??
    mTrack(s) ??
    mConnect(s) ??
    mPlace(s)
  );
}

// ---------------------------------------------------------------- помощь

export const COPILOT_HELP = [
  'Команды помощника:',
  '• «поставь 4 светодиода 5мм в ряд через 5 мм» — детали строкой генератора;',
  '• «разъём 2x5 справа», «dip 8 в центре», «сетка 2x3 резистора 0805»;',
  '• «соедини их», «соедини катоды», «соедини D1.2 с R2.1»;',
  '• «сделай плату односторонней» / «верни два слоя» — число слоёв меди;',
  '• «дорожка от 10 20 до 30 40», «текст „Плата v1“ снизу»;',
  '• «плата 60x40», «отверстия м3 по углам»;',
  '• «удали выделенное», «продублируй», «поверни на 90», «сдвинь влево на 2»;',
  '• «отмени», «покажи всю плату». Несколько команд — через точку или «и».',
].join('\n');

export const COPILOT_EXAMPLES = [
  'Поставь 4 светодиода в ряд через 5 мм',
  'Соедини катоды',
  'Разъём 2x5 справа',
  'Текст «Плата v1» снизу',
  'Отверстия М3 по углам',
  'Плата 60x40',
  'Сетка 2x3 резистора 0805',
  'Дорожка от 10 10 до 40 30',
  'Что ты умеешь?',
];

function mHelp(s: string): CopilotCmd | null {
  if (/^(что\s+ты\s+умеешь|помощь|help|справка|как\s+(пользоваться|тобой)|команды|что\s+можно|умеешь)/.test(s)) return { t: 'help' };
  return null;
}

function mUndo(s: string): CopilotCmd | null {
  if (/^(отмени|отменить|undo|назад|верни\s+как\s+было|отмена)(?![0-9a-zа-я])/.test(s) && !/выделен/.test(s)) return { t: 'undo' };
  return null;
}

function mSelect(s: string): CopilotCmd | null {
  if (/^(покажи|показать)\s+(вс[ею]\s+плату|все|всю\s+плату)|^(вместить|фит|fit|обзор)(?![0-9a-zа-я])/.test(s)) return { t: 'fit' };
  if (/^(приблизь|приблизить|увеличь|крупнее|zoom\s*in)(?![0-9a-zа-я])/.test(s)) return { t: 'zoomIn' };
  if (/^(отдали|отдалить|уменьши|мельче|zoom\s*out)(?![0-9a-zа-я])/.test(s)) return { t: 'zoomOut' };
  if (/выде?ли/.test(s) && /вс[её]/.test(s)) return { t: 'selectAll' };
  if (/^(сними|снять|убери|очисти)\s+(выделение|выбор)/.test(s)) return { t: 'clearSel' };
  return null;
}

function targetOf(s: string): CopilotTarget {
  if (/все|всё|всю\s+плату|целиком/.test(s) && !/выделен/.test(s)) return { t: 'all' };
  const m = s.match(/(?:деталь|компонент|резистор|конденсатор|диод|разъем|разъём|кнопк[ауи]|микросхем[ауи])?\s*([a-z]{1,4}\d{1,4})/);
  if (m && /удали|удалить|сотри|стереть|убери|дубли|копир|поверни|повернуть|отрази|зеркал|сдвинь|подвинь|перемести/.test(s)) {
    return { t: 'ref', ref: m[1].toLocaleUpperCase() };
  }
  if (/(?<![0-9a-zа-я])их(?![0-9a-zа-я])|последн|только\s+что|толькочто/.test(s)) return { t: 'last' };
  if (/выделен|выбран|выбор|эти/.test(s)) return { t: 'sel' };
  return { t: 'any' };
}

function mDelete(s: string): CopilotCmd | null {
  if (!/^(удали|удалить|сотри|стереть|убери|убрать|очисти|очистить)|очисти\s+плату|удали\s+вс/.test(s)) return null;
  if (/очисти\s+плату|удали\s+вс[её]/.test(s)) return { t: 'delete', target: { t: 'all' } };
  return { t: 'delete', target: targetOf(s) };
}

function mDuplicate(s: string): CopilotCmd | null {
  if (!/продублируй|дублируй|дублировать|скопируй|скопировать|сделай\s+копию|еще\s+один|ещё\s+один/.test(s)) return null;
  if (PLACE_VERB.test(s) && /^(постав|добав|встав|размест)/.test(s)) return null;
  return { t: 'duplicate', target: targetOf(s) };
}

function mRotate(s: string): CopilotCmd | null {
  if (!/поверни|повернуть|вращай|крути/.test(s)) return null;
  if (/^(постав|добав|встав|размест|создай|нарисуй)/.test(s)) return null;
  const m = s.match(/на\s*(\d{1,3})/);
  const deg = m ? parseInt(m[1], 10) % 360 : 90;
  const times = Math.round(deg / 90) % 4;
  return { t: 'rotate', target: targetOf(s), times: times === 0 ? 4 : times };
}

function mMirror(s: string): CopilotCmd | null {
  if (!/отрази|отразить|зеркал|зеркаль/.test(s)) return null;
  if (/^(постав|добав|встав|размест|создай|нарисуй)/.test(s)) return null;
  const axis: 'v' | 'h' = /горизонтал|сверху\s+вниз|сверху-вниз/.test(s) ? 'h' : 'v';
  return { t: 'mirror', target: targetOf(s), axis };
}

function mMove(s: string): CopilotCmd | null {
  if (!/сдвинь|сдвинуть|подвинь|подвинуть|перемести|переместить|смести|двигай|передвинь/.test(s)) return null;
  if (/^(постав|добав|встав|размест|создай|нарисуй)/.test(s)) return null;
  let dx = 0;
  let dy = 0;
  if (/влево|левее/.test(s)) dx = -1;
  else if (/вправо|правее/.test(s)) dx = 1;
  else if (/вверх|наверх|выше/.test(s)) dy = 1;
  else if (/вниз|ниже/.test(s)) dy = -1;
  else return null;
  const m = s.match(new RegExp(String.raw`на\s*${NUM}\s*(мм|mm|мил|mil|см|cm)?`));
  const d = m ? Math.abs(toMm(toNum(m[1]), m[2])) : 1;
  return { t: 'move', target: targetOf(s), dx: r3(dx * d), dy: r3(dy * d) };
}

// ------------------------------------------------------------- плата

/** «односторонняя плата» / «1 слой меди» / «сделай двусторонней» */
function mLayers(s: string): CopilotCmd | null {
  const one = /односторонн|один слой|1\s*слой|однослойн|single\s*side/.test(s);
  const two = /двусторонн|два слоя|2\s*слоя|двухслойн|double\s*side/.test(s);
  if (one === two) return null;   // ни того, ни другого — либо противоречие
  return { t: 'layers', n: one ? 1 : 2 };
}

function mBoard(s: string): CopilotCmd | null {
  if (!/плата|размер|габарит|сделай|новая|основание/.test(s)) return null;
  const m =
    s.match(new RegExp(String.raw`${NUM}\s*[xх×]\s*${NUM}`)) ??
    s.match(new RegExp(String.raw`${NUM}\s+на\s+${NUM}`));
  if (!m) return null;
  const w = r3(toNum(m[1]));
  const h = r3(toNum(m[2]));
  if (!(w >= 5 && w <= 1000 && h >= 5 && h <= 1000)) return null;
  return { t: 'board', w, h };
}

const METRIC_DRILL: Record<string, number> = {
  м2: 2.2, m2: 2.2, 'м2.5': 2.7, 'm2.5': 2.7, м3: 3.2, m3: 3.2, м4: 4.3, m4: 4.3, м5: 5.3, m5: 5.3,
};

function takeMetric(s: string): { d: number; rest: string } {
  let rest = s;
  let d = 3.2;
  const m = rest.match(/([мm]\s?2(?:\.5)?|[мm]\s?[345])(?![0-9a-zа-я])/);
  if (m) {
    const key = m[1].replace(/\s+/g, '');
    d = METRIC_DRILL[key] ?? 3.2;
    rest = rest.replace(m[0], ' ');
  }
  const md = rest.match(new RegExp(String.raw`(?:диаметр(?:ом)?|ø|d)\s*=?\s*${NUM}\s*(мм|mm)?`));
  if (md) {
    d = r3(toNum(md[1]));
    rest = rest.replace(md[0], ' ');
  }
  return { d, rest };
}

function mCorners(s: string): CopilotCmd | null {
  if (!/угл/.test(s) || !/отверсти/.test(s)) return null;
  const { d, rest } = takeMetric(s);
  const m = rest.match(new RegExp(String.raw`(?:отступ(?:ом|а|е)?|от\s+края)\s*${NUM}\s*(мм|mm)?`));
  const margin = m ? r3(Math.max(1, toNum(m[1]))) : 3.5;
  return { t: 'corners', d: Math.min(20, Math.max(0.5, d)), margin };
}

// ------------------------------------------------------------- текст

function mText(s: string, raw: string): CopilotCmd | null {
  if (!/текст|надпись|подпиши|подписать|напиши|написать|назови|название|маркировка/.test(s)) return null;
  // цитата — в исходном регистре
  const qm = raw.match(/[«"]([^«»"]+)[»"]/) ?? raw.match(/'([^']+)'/);
  let text = qm ? qm[1].trim() : '';
  let rest = s;
  if (qm) {
    rest = s.replace(qm[0].toLocaleLowerCase('ru-RU'), ' ');
  } else {
    // без кавычек: всё после глагола минус модификаторы
    rest = s
      .replace(/^(поставь|добавь|сделай|напиши|подпиши|текст|надпись|назови)\s+/, '')
      .replace(/^(текст|надпись)\s+/, '');
  }
  const sm = rest.match(new RegExp(String.raw`(?:высотой|высота|размер(?:ом)?|кегль)\s*${NUM}\s*(мм|mm)?`));
  const size = sm ? r3(toNum(sm[1])) : null;
  if (sm) rest = rest.replace(sm[0], ' ');
  const bottom = /снизу|на\s+обороте|внизу\s+платы|bottom|s2/.test(rest);
  const { anchor, rest: rest2 } = takeAnchor(rest, true);
  rest = rest2;
  if (!text) {
    text = rest
      .replace(/^(текст|надпись|подпись)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!text) return null;
  if (size !== null && !(size >= 0.5 && size <= 50)) return null;
  return { t: 'text', text: text.slice(0, 120), size, anchor, bottom };
}

// ------------------------------------------------------------ дорожка

function mTrack(s: string): CopilotCmd | null {
  if (!/дорожк|лини|проведи|провести|перемычк/.test(s)) return null;
  if (CONNECT_VERB.test(s)) return null;
  // границы слов — явно: \b кириллицу не видит («до» в «дорожке» — не предлог)
  const at = s.match(/(^|[^0-9a-zа-я])(от|из)(?![0-9a-zа-я])/);
  const to = s.match(/(^|[^0-9a-zа-я])(до|к)(?![0-9a-zа-я])/);
  if (!at || !to) return null;
  // координаты — только в зоне «от…до», ширина («шириной 0.6») — не точка
  const zone = s
    .slice((at.index ?? 0) + at[1].length)
    .split(/шириной|ширина|толщин|по\s+(верх|низ)|на\s+(верх|низ|k1|k2)|\bk[12]\b/)[0];
  const nums: number[] = [];
  const re = new RegExp(NUM, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(zone)) !== null && nums.length < 12) nums.push(toNum(m[1]));
  if (nums.length < 4 || nums.length % 2 !== 0) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: r3(nums[i]), y: r3(nums[i + 1]) });
  // ширина и слой
  const { width, layer, ok } = takeWidthLayer(s);
  if (!ok) return null;
  return { t: 'track', pts, width, layer };
}

function takeWidthLayer(s: string): { width: number | null; layer: 'k1' | 'k2' | null; ok: boolean } {
  const wm = s.match(new RegExp(String.raw`(?:шириной|ширина|дорожк(?:а|ой|и|у)|толщин(?:а|ой))\s*${NUM}\s*(мм|mm|мил|mil)?`));
  let width: number | null = null;
  if (wm) {
    width = r3(toMm(toNum(wm[1]), wm[2]));
    if (!(width >= 0.05 && width <= 20)) return { width: null, layer: null, ok: false };
  }
  let layer: 'k1' | 'k2' | null = null;
  if (/(?<![0-9a-zа-я])k1\b|по\s+верх|на\s+верх|верхн/.test(s)) layer = 'k1';
  else if (/(?<![0-9a-zа-я])k2\b|по\s+низ|на\s+низ|нижн|снизу/.test(s)) layer = 'k2';
  return { width, layer, ok: true };
}

// ---------------------------------------------------------- соединение

function takePinWord(s: string): { n: number; rest: string } | null {
  const m = s.match(/(?:вывод|пин|пин|ножк[ауи]|контакт)\s*(?:№\s*)?(\d{1,2}|\S+)/);
  if (!m) return null;
  const tail = m[1];
  if (/^\d+$/.test(tail)) return { n: parseInt(tail, 10), rest: s.replace(m[0], ' ') };
  const w = norm(tail);
  for (const [re, n] of ORDW) if (re.test(w)) return { n, rest: s.replace(m[0], ' ') };
  if (/^последн/.test(w)) return { n: -1, rest: s.replace(m[0], ' ') };
  return null;
}

function takePicks(s: string): { picks: CopilotPick[]; rest: string } {
  let rest = s;
  const picks: CopilotPick[] = [];
  const grab = (re: RegExp, mk: (w: string) => CopilotPick): void => {
    const m = rest.match(re);
    if (m) {
      picks.push(mk(m[1] ?? m[0]));
      rest = rest.replace(m[0], ' ');
    }
  };
  // «катоды и аноды» — несколько групп
  for (let i = 0; i < 4; i++) {
    const before = rest;
    grab(/катод[а-я]*/i, (w) => ({ t: 'cathode', label: w }));
    grab(/анод[а-я]*/i, (w) => ({ t: 'anode', label: w }));
    grab(/минус[а-я]*/i, (w) => ({ t: 'cathode', label: w }));
    grab(/плюс[а-я]*/i, (w) => ({ t: 'anode', label: w }));
    const pw = takePinWord(rest);
    if (pw) {
      picks.push({ t: 'pin', n: pw.n, label: `вывод ${pw.n === -1 ? 'последний' : pw.n}` });
      rest = pw.rest;
    }
    rest = rest.replace(/^\s*и\s+/, ' ');
    if (rest === before) break;
  }
  return { picks, rest };
}

function mConnect(s: string): CopilotCmd | null {
  if (!CONNECT_VERB.test(s) && !/перемычк/.test(s)) return null;
  if (/^(постав|добав|встав|размест)/.test(s)) return null;
  const { width, layer, ok } = takeWidthLayer(s);
  if (!ok) return null;
  // явные «D1.2 с D2.1»
  const refRe = /([a-z]{1,4}\d{1,4})\s*[.,]?\s*(\d{1,2})?/g;
  const pairs: { ref: string; pin: number | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(s)) !== null) {
    // «d1» внутри слов («светодиод1»?) — требуем границу слева
    const at = m.index;
    if (at > 0 && /[a-zа-я0-9]/.test(s[at - 1])) continue;
    pairs.push({ ref: m[1].toLocaleUpperCase(), pin: m[2] ? parseInt(m[2], 10) : null });
    if (pairs.length >= 8) break;
  }
  if (pairs.length >= 2) return { t: 'connect', pairs, picks: [], width, layer };
  if (pairs.length === 1 && /точк|между/.test(s)) return null;
  const { picks } = takePicks(s);
  return { t: 'connect', pairs: null, picks, width, layer };
}

// ---------------------------------------------------------- установка

function takeLeadingCount(s: string): { n: number; rest: string } | null {
  const m = s.match(/^(\d{1,3})\s*(шт(?:ук[аи]?)?\.?|штуки)?\s+(.+)$/);
  if (m && m[3].length > 1) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 200) return { n, rest: m[3] };
  }
  for (const [re, n] of NUMWORDS) {
    const mm = s.match(re);
    if (mm) {
      const rest = s.slice(mm[0].length).trim();
      if (rest.length > 1) return { n, rest };
    }
  }
  // «отверстие м3 x4» — но не «плата 60x40» (x после цифры — габарит)
  const xm = s.match(/(?<!\d)[xх×]\s*(\d{1,3})\s*$/);
  if (xm) {
    const n = parseInt(xm[1], 10);
    if (n >= 1 && n <= 200) return { n, rest: s.slice(0, xm.index).trim() };
  }
  return null;
}

function takeStep(s: string): { step: number | null; stepY: number | null; rest: string } {
  let rest = s;
  let step: number | null = null;
  let stepY: number | null = null;
  const g = rest.match(
    new RegExp(String.raw`шаг(?:ом)?\s*${NUM}\s*[xх×]\s*${NUM}\s*(мм|mm|мил|mil)?`),
  );
  if (g) {
    step = r3(toMm(toNum(g[1]), g[3]));
    stepY = r3(toMm(toNum(g[2]), g[3]));
    rest = rest.replace(g[0], ' ');
    return { step, stepY, rest };
  }
  const m = rest.match(
    new RegExp(String.raw`(?:через|с\s+шагом|шагом|шаг)\s*${NUM}\s*(мм|mm|мил|mil)?`),
  );
  if (m) {
    step = r3(toMm(toNum(m[1]), m[2]));
    rest = rest.replace(m[0], ' ');
  }
  return { step, stepY, rest };
}

function takeAnchor(s: string, forText: boolean): { anchor: CopilotAnchor; rest: string } {
  let rest = s;
  // «в точке 10 20», «(10, 20)», «x=10 y=20»
  const pm =
    rest.match(new RegExp(String.raw`в\s+(?:точке|позиции|месте|координатах)\s*${NUM}\s+${NUM}`)) ??
    rest.match(new RegExp(String.raw`\(\s*${NUM}\s*[,;]\s*${NUM}\s*\)`)) ??
    rest.match(new RegExp(String.raw`[xх]\s*=\s*${NUM}\s*[ ,;]?\s*[yу]\s*=\s*${NUM}`));
  if (pm) {
    const anchor: CopilotAnchor = { t: 'point', x: r3(toNum(pm[1])), y: r3(toNum(pm[2])) };
    return { anchor, rest: rest.replace(pm[0], ' ') };
  }
  // «рядом с D1», «справа от R2», «под U1»
  const nm = rest.match(/(справа|слева|над|под|рядом|около|возле|ближе)\s+(?:от\s+|с\s+)?([a-z]{1,4}\d{1,4})/);
  if (nm) {
    const dir = nm[1] === 'слева' ? 'l' : nm[1] === 'над' ? 't' : nm[1] === 'под' ? 'b' : 'r';
    const gm = rest.match(new RegExp(String.raw`(?:зазор|через)\s*${NUM}\s*(мм|mm)?`));
    const anchor: CopilotAnchor = {
      t: 'near',
      ref: nm[2].toLocaleUpperCase(),
      dir,
      gap: gm ? r3(toNum(gm[1])) : 3,
    };
    rest = rest.replace(nm[0], ' ');
    if (gm) rest = rest.replace(gm[0], ' ');
    return { anchor, rest };
  }
  if (/в\s+центре|по\s+центру|в\s+середин|посередине|в\s+центр|центр\s+платы/.test(rest)) {
    return {
      anchor: { t: 'center' },
      rest: rest.replace(/в\s+центре|по\s+центру|в\s+середин[аеуы]|посередине|в\s+центр|центр\s+платы/, ' '),
    };
  }
  // углы и края
  const hasL = /слева|с\s*левого/.test(rest);
  const hasR = /справа|с\s*правого/.test(rest);
  const hasT = /вверху|наверху|сверху\s+платы|у\s+верхнего/.test(rest);
  const hasB = /внизу\s+платы|у\s+нижнего|в\s+низу/.test(rest) || (forText && /внизу|снизу/.test(rest));
  const bareTop = !forText && /сверху(?!\s+платы)/.test(rest) && !/на\s+верх/.test(rest);
  if (hasL || hasR || hasT || hasB || bareTop || /в\s+углу|по\s+углам/.test(rest)) {
    const h: 'l' | 'c' | 'r' = hasL ? 'l' : hasR ? 'r' : 'c';
    const v: 't' | 'm' | 'b' = hasT || bareTop ? 't' : hasB ? 'b' : 'm';
    const mm = rest.match(new RegExp(String.raw`(?:отступ(?:ом|а|е)?|от\s+края)\s*${NUM}\s*(мм|mm)?`));
    const margin = mm ? r3(Math.max(0, toNum(mm[1]))) : 5;
    rest = rest
      .replace(/слева|справа|вверху|внизу|наверху|сверху|в\s+углу|по\s+углам|у\s+верхнего|у\s+нижнего|с\s*левого|с\s*правого|кра[юя]/g, ' ');
    if (mm) rest = rest.replace(mm[0], ' ');
    return { anchor: { t: 'corner', h, v, margin }, rest };
  }
  return { anchor: { t: 'view' }, rest };
}

function takeRotSide(s: string): { rot: number | null; side: 'top' | 'bottom' | null; rest: string } {
  let rest = s;
  let rot: number | null = null;
  let side: 'top' | 'bottom' | null = null;
  const rm = rest.match(/(?:поверн(?:ув|и|уть|ут)?\s*(?:на\s*)?|под\s+углом\s*)(\d{1,3})/);
  if (rm) {
    rot = ((parseInt(rm[1], 10) % 360) + 360) % 360;
    rest = rest.replace(rm[0], ' ');
  } else if (/вертикально/.test(rest)) {
    rot = 90;
    rest = rest.replace(/вертикально/, ' ');
  } else if (/горизонтально/.test(rest)) {
    rot = 0;
    rest = rest.replace(/горизонтально/, ' ');
  }
  if (/снизу|на\s+низ|bottom|со\s+стороны\s+пайки|с\s+обратной/.test(rest)) {
    side = 'bottom';
    rest = rest.replace(/снизу|на\s+низ|bottom|со\s+стороны\s+пайки|с\s+обратной/, ' ');
  }
  return { rot, side, rest };
}

function mPlace(s: string): CopilotCmd | null {
  const hasVerb = new RegExp(`^(?:${PLACE_VERB.source})`).test(s) || /^(поставь|добавь|вставь|размести)/.test(s);
  let rest = s.replace(/^(поставь|поставить|добавь|добавить|вставь|вставить|размести|разместить|создай|создать|нарисуй|нарисовать|сделай|сделать|хочу|пусть|пожалуйста)\s+/, '');
  if (!hasVerb) {
    // без глагола — только если остаток похож на деталь и это не другая команда
    if (CONNECT_VERB.test(s) || /дорожк|текст|надпись|плата\s+\d/.test(s)) return null;
    rest = s;
  }
  if (!rest) return null;

  // «переход» — штатный примитив, а не генератор
  const viaM = !/площадк|smd|чип/.test(rest) && rest.match(/переход(?:ное\s+отверстие)?|via/);
  const layout: CopilotLayout = {
    count: 1, arrangement: 'single', step: null, stepY: null,
    cols: 0, rows: 0, radius: null, anchor: { t: 'view' }, rot: null, side: null,
  };

  // сетка / круг / ряд / столбец
  const gridM = rest.match(/(\d{1,3})\s*(?:ряд[а-я]*\s*по|на)\s*(\d{1,3})/) ?? rest.match(/(\d{1,3})\s*[xх×]\s*(\d{1,3})/);
  if (/сетк|таблиц|матриц/.test(rest) || /ряд[а-я]*\s*по/.test(rest)) {
    layout.arrangement = 'grid';
    if (gridM) {
      layout.rows = Math.min(50, Math.max(1, parseInt(gridM[1], 10)));
      layout.cols = Math.min(50, Math.max(1, parseInt(gridM[2], 10)));
      layout.count = layout.rows * layout.cols;
      rest = rest.replace(gridM[0], ' ');
    } else {
      const cm = takeLeadingCount(rest);
      if (cm && cm.n > 1) {
        layout.count = cm.n;
        layout.cols = Math.ceil(Math.sqrt(cm.n));
        layout.rows = Math.ceil(cm.n / layout.cols);
        rest = cm.rest;
      }
    }
    rest = rest.replace(/сетк[аойей]*|таблиц[аей]*|матриц[аей]*/g, ' ');
  } else if (/по\s+кругу|кругом|вокруг/.test(rest)) {
    layout.arrangement = 'circle';
    const rm = rest.match(new RegExp(String.raw`(?:радиус(?:ом|а)?|r)\s*=?\s*${NUM}\s*(мм|mm)?`));
    layout.radius = rm ? r3(toNum(rm[1])) : 15;
    if (rm) rest = rest.replace(rm[0], ' ');
    rest = rest.replace(/по\s+кругу|кругом|вокруг|по\s+окружности/g, ' ');
  } else if (/в\s+столбец|столбцом|столбиком|друг\s+под\s+другом|вертикальн/.test(rest) && !viaM) {
    layout.arrangement = 'col';
    rest = rest.replace(/в\s+столбец|столбцом|столбиком|друг\s+под\s+другом/g, ' ');
  } else if (/в\s+ряд|рядом|в\s+линию|горизонтальн/.test(rest)) {
    layout.arrangement = 'row';
    rest = rest.replace(/в\s+ряд|рядом|в\s+линию/g, ' ');
  }
  // «вертикально» для одиночки — поворот, а не столбец
  const verticalWord = layout.arrangement === 'col' && /вертикальн/.test(rest);

  const st = takeStep(rest);
  layout.step = st.step;
  layout.stepY = st.stepY;
  rest = st.rest;

  const { anchor, rest: restA } = takeAnchor(rest, false);
  layout.anchor = anchor;
  rest = restA;

  const rs = takeRotSide(rest);
  layout.rot = rs.rot ?? (verticalWord && layout.count === 1 ? 90 : layout.rot);
  layout.side = rs.side;
  rest = rs.rest;

  if (layout.arrangement !== 'grid' || layout.count === 1) {
    const cm = takeLeadingCount(rest);
    if (cm) {
      // «dip 8»: ведущее число — часть описания, а не количество. Правило:
      // если остаток без числа не собирается генератором, а целиком — да,
      // то это описание («0805», «2x5» внутри). Иначе — количество.
      const probeRest = genQuery(cm.rest);
      if (!probeRest.ok && cm.rest.trim().split(/\s+/).length <= 1) {
        const probeFull = genQuery(rest.trim());
        if (probeFull.ok) {
          layout.count = 1;
        } else {
          layout.count = cm.n;
          rest = cm.rest;
        }
      } else {
        layout.count = cm.n;
        rest = cm.rest;
      }
    }
  }
  if (layout.arrangement === 'grid' && layout.rows === 0) {
    layout.cols = Math.ceil(Math.sqrt(layout.count));
    layout.rows = Math.ceil(layout.count / layout.cols);
  }
  if (layout.arrangement === 'single' && layout.count > 1) layout.arrangement = 'row';

  const what = rest.replace(/\s+/g, ' ').trim();
  if (viaM) {
    const { rest: restV } = takeMetric(rest.replace(/переход(?:ное\s+отверстие)?|via/g, ' '));
    void restV;
    const vm = rest.match(new RegExp(String.raw`${NUM}\s*\/\s*${NUM}`));
    let viaSize = 1.8;
    let viaDrill = 0.8;
    if (vm) {
      viaSize = r3(toNum(vm[1]));
      viaDrill = r3(toNum(vm[2]));
    }
    return { t: 'via', viaSize, viaDrill, ...layout };
  }
  if (!what) return null;
  if (/дорожк/.test(what)) return null;
  // финальная проверка: генератор должен понять описание
  if (!genQuery(what).ok) {
    if (!hasVerb) return null;
    // с глаголом — всё равно вернём команду: исполнитель честно скажет, что не так
  }
  return { t: 'place', what, ...layout };
}

// -------------------------------------------------------------- отчёты

function plur(n: number, f: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return f[2];
  if (b > 1 && b < 5) return f[1];
  if (b === 1) return f[0];
  return f[2];
}

/** «D1–D4» для последовательных обозначений. */
function refRange(refs: string[]): string {
  if (!refs.length) return '';
  if (refs.length === 1) return refs[0];
  const m0 = refs[0].match(/^([A-Z]+)(\d+)$/);
  if (m0) {
    const [, p, s0] = m0;
    const n0 = parseInt(s0, 10);
    let ok = true;
    for (let i = 1; i < refs.length; i++) {
      if (refs[i] !== `${p}${n0 + i}`) { ok = false; break; }
    }
    if (ok) return `${refs[0]}–${refs[refs.length - 1]}`;
  }
  return refs.length <= 6 ? refs.join(', ') : `${refs.slice(0, 5).join(', ')}… (+${refs.length - 5})`;
}

// ----------------------------------------------------------- выполнение

export interface PadSlot {
  /** индекс примитива внутри comp.ents */
  i: number;
  x: number;
  y: number;
  pin: number | null;
}

export function compPads(c: Comp): PadSlot[] {
  const out: PadSlot[] = [];
  const ents = c.ents ?? [];
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.kind === 'pad') out.push({ i, x: e.x, y: e.y, pin: e.pin && /^\d+$/.test(e.pin) ? parseInt(e.pin, 10) : null });
    else if (e.kind === 'smd') out.push({ i, x: e.x, y: e.y, pin: e.pin && /^\d+$/.test(e.pin) ? parseInt(e.pin, 10) : null });
    else if (e.kind === 'via') out.push({ i, x: e.x, y: e.y, pin: null });
  }
  // порядок выводов: по номеру пина, иначе слева направо, сверху вниз
  if (out.length && out.every((p) => p.pin !== null)) out.sort((a, b) => (a.pin as number) - (b.pin as number));
  else out.sort((a, b) => (a.x - b.x) || (b.y - a.y));
  return out;
}

function pickPad(slots: PadSlot[], pick: CopilotPick): PadSlot | null {
  if (!slots.length) return null;
  if (pick.t === 'pin') {
    if (pick.n === -1) return slots[slots.length - 1];
    const byPin = slots.find((s) => s.pin === pick.n);
    if (byPin) return byPin;
    return slots[pick.n - 1] ?? null;
  }
  if (slots.length === 1) return slots[0];
  if (pick.t === 'cathode') {
    return slots.reduce((a, b) => (b.x > a.x || (b.x === a.x && b.y > a.y) ? b : a));
  }
  return slots.reduce((a, b) => (b.x < a.x || (b.x === a.x && b.y < a.y) ? b : a));
}

export function execCopilot(doc: Doc, cmds: CopilotCmd[], ctx: CopilotCtx): CopilotResult {
  const d: Doc = M.cloneDoc(doc);
  const lines: CopilotLine[] = [];
  const effects: CopilotEffect[] = [];
  let select: string[] | null = null;
  let lastIds = [...ctx.lastIds];
  let changed = false;
  const say = (ok: boolean, text: string): void => { lines.push({ ok, text }); };

  const byId = (id: string): Entity | undefined => d.entities.find((e) => e.id === id);
  const compsByIds = (ids: string[]): Comp[] =>
    ids.map(byId).filter((e): e is Comp => !!e && e.kind === 'comp');
  const findRef = (ref: string): Comp | undefined => {
    const t = ref.trim().toLocaleUpperCase();
    return d.entities.find(
      (e): e is Comp => e.kind === 'comp' && (e.ref ?? '').trim().toLocaleUpperCase() === t,
    );
  };
  const alive = (): Set<string> => new Set(d.entities.map((e) => e.id));
  const removeEnts = (ids: string[]): number => {
    const set = new Set(ids);
    const before = d.entities.length;
    d.entities = d.entities.filter((e) => !set.has(e.id));
    const dead = before - d.entities.length;
    if (dead > 0) {
      const al = alive();
      d.groups = pruneGroups(d.groups, al);
      if (d.nets) {
        for (const n of d.nets) n.pads = n.pads.filter((p) => al.has(p.split(':')[0]) || al.has(p));
      }
      changed = true;
    }
    return dead;
  };
  /** абсолютные координаты площадок компонента (кэш на вызов) */
  const absCache = new Map<string, Map<number, Entity>>();
  const absOf = (c: Comp, i: number): Entity | undefined => {
    let m = absCache.get(c.id);
    if (!m) {
      m = new Map();
      for (const e of expandComp(c)) {
        const k = e.id.split(':').pop();
        const idx = k !== undefined ? parseInt(k, 10) : NaN;
        if (isFinite(idx)) m.set(idx, e);
      }
      absCache.set(c.id, m);
    }
    return m.get(i);
  };
  const padPoint = (c: Comp, slot: PadSlot): Pt | null => {
    const e = absOf(c, slot.i);
    if (!e) return null;
    if (e.kind === 'pad' || e.kind === 'via' || e.kind === 'smd' || e.kind === 'hole') return { x: e.x, y: e.y };
    return null;
  };
  const resolveTarget = (t: CopilotTarget): string[] => {
    if (t.t === 'all') return d.entities.map((e) => e.id);
    if (t.t === 'ref') {
      const c = findRef(t.ref);
      return c ? [c.id] : [];
    }
    if (t.t === 'last') return lastIds.filter((id) => byId(id));
    if (t.t === 'sel') return ctx.selIds.filter((id) => byId(id));
    const sel = ctx.selIds.filter((id) => byId(id));
    if (sel.length) return sel;
    return lastIds.filter((id) => byId(id));
  };

  if (!cmds.length) {
    say(false, 'Не понял команду. Напиши «что ты умеешь?» — покажу примеры.');
    return { doc: d, select, lastIds, effects, lines, changed };
  }

  for (const cmd of cmds) {
    switch (cmd.t) {
      case 'help': {
        say(true, COPILOT_HELP);
        break;
      }
      case 'undo': {
        effects.push({ t: 'undo' });
        say(true, '↩️ Отменил последнюю операцию.');
        break;
      }
      case 'fit': {
        effects.push({ t: 'fit' });
        say(true, '🔍 Показал всю плату.');
        break;
      }
      case 'zoomIn': {
        effects.push({ t: 'zoom', f: 1.4 });
        say(true, '🔍 Приблизил.');
        break;
      }
      case 'zoomOut': {
        effects.push({ t: 'zoom', f: 1 / 1.4 });
        say(true, '🔍 Отдалил.');
        break;
      }
      case 'selectAll': {
        select = d.entities.map((e) => e.id);
        say(true, `Выделил всё: ${d.entities.length} ${plur(d.entities.length, ['объект', 'объекта', 'объектов'])}.`);
        break;
      }
      case 'clearSel': {
        select = [];
        say(true, 'Снял выделение.');
        break;
      }
      case 'delete': {
        const ids = resolveTarget(cmd.target);
        if (cmd.target.t === 'all') {
          const keep = d.entities.filter((e) => e.kind === 'rect' && e.layer === 'outline');
          const n = d.entities.length - keep.length;
          d.entities = keep;
          d.groups = [];
          d.nets = [];
          changed = n > 0;
          say(true, n > 0 ? `🧹 Очистил плату: удалил ${n} ${plur(n, ['объект', 'объекта', 'объектов'])}. Вернуть — «отмени».` : 'Плата уже пустая.');
        } else if (!ids.length) {
          say(false, 'Нечего удалять: ничего не выделено. Подскажи что — например «удали D3».');
        } else {
          const n = removeEnts(ids);
          select = [];
          say(true, `🗑 Удалил ${n} ${plur(n, ['объект', 'объекта', 'объектов'])}. Вернуть — «отмени».`);
        }
        break;
      }
      case 'duplicate': {
        const ids = resolveTarget(cmd.target);
        if (!ids.length) {
          say(false, 'Нечего дублировать: выдели объекты или сначала что-нибудь поставь.');
          break;
        }
        const clones: Entity[] = [];
        for (const id of ids) {
          const e = byId(id);
          if (!e) continue;
          const c = JSON.parse(JSON.stringify(e)) as Entity;
          c.id = M.uid();
          if (c.kind === 'comp' && c.ents) {
            for (const inner of c.ents) inner.id = M.uid();
            c.ref = nextReference(c.name, [...d.entities, ...clones], c.id);
          }
          M.translateEnt(c, 3, 3);
          clones.push(c);
        }
        if (!clones.length) {
          say(false, 'Не получилось продублировать.');
          break;
        }
        d.entities.push(...clones);
        changed = true;
        const ids2 = clones.map((c) => c.id);
        select = ids2;
        if (clones.some((c) => c.kind === 'comp')) lastIds = ids2.filter((id) => byId(id)?.kind === 'comp');
        say(true, `📋 Продублировал: ${clones.length} ${plur(clones.length, ['объект', 'объекта', 'объектов'])} (сдвинул на 3 мм).`);
        break;
      }
      case 'rotate': {
        const ids = resolveTarget(cmd.target);
        if (!ids.length) {
          say(false, 'Нечего поворачивать: выдели объекты или сначала что-нибудь поставь.');
          break;
        }
        const ents = ids.map(byId).filter((e): e is Entity => !!e);
        const bb = M.unionBBox(ents.map(M.entBBox));
        const cx = (bb[0] + bb[2]) / 2;
        const cy = (bb[1] + bb[3]) / 2;
        const times = ((cmd.times % 4) + 4) % 4;
        for (const e of ents) for (let i = 0; i < times; i++) M.rotateEnt90(e, cx, cy);
        changed = true;
        select = ids;
        say(true, `🔄 Повернул на ${(times * 90) % 360 || 360}°: ${ids.length} ${plur(ids.length, ['объект', 'объекта', 'объектов'])}.`);
        break;
      }
      case 'mirror': {
        const ids = resolveTarget(cmd.target);
        if (!ids.length) {
          say(false, 'Нечего отражать: выдели объекты или сначала что-нибудь поставь.');
          break;
        }
        const ents = ids.map(byId).filter((e): e is Entity => !!e);
        const bb = M.unionBBox(ents.map(M.entBBox));
        const cx = (bb[0] + bb[2]) / 2;
        const cy = (bb[1] + bb[3]) / 2;
        for (const e of ents) {
          if (cmd.axis === 'h') {
            M.rotateEnt90(e, cx, cy);
            M.rotateEnt90(e, cx, cy);
          }
          M.mirrorEnt(e, cx);
        }
        changed = true;
        select = ids;
        say(true, cmd.axis === 'h' ? '🪞 Отразил сверху вниз.' : '🪞 Отразил слева направо.');
        break;
      }
      case 'move': {
        const ids = resolveTarget(cmd.target);
        if (!ids.length) {
          say(false, 'Нечего двигать: выдели объекты или сначала что-нибудь поставь.');
          break;
        }
        for (const id of ids) {
          const e = byId(id);
          if (e) M.translateEnt(e, cmd.dx, cmd.dy);
        }
        changed = true;
        select = ids;
        const dd = Math.hypot(cmd.dx, cmd.dy);
        say(true, `➡️ Сдвинул на ${M.fmt(dd)} мм: ${ids.length} ${plur(ids.length, ['объект', 'объекта', 'объектов'])}.`);
        break;
      }
      case 'board': {
        const oldW = d.w;
        const oldH = d.h;
        d.w = cmd.w;
        d.h = cmd.h;
        for (const e of d.entities) {
          if (e.kind === 'rect' && e.layer === 'outline' && e.x === 0 && e.y === 0 && e.w === oldW && e.h === oldH) {
            e.w = cmd.w;
            e.h = cmd.h;
          }
        }
        changed = true;
        say(true, `📐 Размер платы: ${M.fmt(cmd.w)} × ${M.fmt(cmd.h)} мм.`);
        break;
      }
      case 'layers': {
        if (M.boardLayers(d) === cmd.n) {
          say(true, cmd.n === 1 ? '➕ Плата уже односторонняя: медь на K2.' : '➕ Плата уже двусторонняя.');
          break;
        }
        if (cmd.n === 1) {
          const onTop = expandDoc(d.entities)
            .filter((e) => (e.kind === 'track' || e.kind === 'smd' || e.kind === 'poly') && e.layer === 'k1').length;
          d.layers = 1;
          changed = true;
          say(true, onTop
            ? `➕ Плата односторонняя: медь только на K2, без переходов. На K1 осталось элементов: ${onTop} — перенеси их на K2 (список в DRC).`
            : '➕ Плата односторонняя: медь только на K2, трассировка без переходов-«мостов».');
        } else {
          delete d.layers;
          changed = true;
          say(true, '➕ Плата двусторонняя: K1 и переходы снова доступны.');
        }
        break;
      }
      case 'corners': {
        const m = Math.min(cmd.margin, d.w / 2 - 1, d.h / 2 - 1);
        const pts = [
          { x: m, y: m },
          { x: d.w - m, y: m },
          { x: m, y: d.h - m },
          { x: d.w - m, y: d.h - m },
        ];
        const ids: string[] = [];
        for (const p of pts) {
          const id = M.uid();
          d.entities.push({ id, kind: 'hole', x: r3(p.x), y: r3(p.y), d: cmd.d });
          ids.push(id);
        }
        changed = true;
        select = ids;
        say(true, `🔩 Четыре отверстия Ø${M.fmt(cmd.d)} по углам (отступ ${M.fmt(m)} мм).`);
        break;
      }
      case 'text': {
        const pt = resolveAnchor(cmd.anchor, d, ctx, 0, 0, null);
        const size = cmd.size ?? 2;
        const layer = cmd.bottom ? 's2' : 's1';
        const id = M.uid();
        d.entities.push({
          id, kind: 'text', x: r3(pt.x), y: r3(pt.y), size,
          th: Math.max(0.15, r3(size * 0.14)), rot: 0, text: cmd.text,
          mirror: cmd.bottom, layer,
        });
        changed = true;
        select = [id];
        say(true, `✏️ Подписал «${cmd.text}» (высота ${M.fmt(size)} мм, ${cmd.bottom ? 'низ' : 'верх'}).`);
        break;
      }
      case 'track': {
        // зажим точек в плату
        const pts = cmd.pts.map((p) => ({
          x: r3(M.clamp(p.x, 0, d.w)),
          y: r3(M.clamp(p.y, 0, d.h)),
        }));
        const id = M.uid();
        const w = cmd.width ?? ctx.trackW;
        d.entities.push({ id, kind: 'track', pts, w, layer: cmd.layer ?? ctx.activeCu });
        changed = true;
        select = [id];
        const len = pts.reduce((a, p, i) => (i ? a + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);
        say(true, `📏 Дорожка ${M.fmt(w)} мм по ${(cmd.layer ?? ctx.activeCu).toLocaleUpperCase()}, длина ${M.fmt(r3(len))} мм.`);
        break;
      }
      case 'via':
      case 'place': {
        const res = execPlace(d, cmd, ctx, say);
        if (res) {
          changed = true;
          select = res.ids;
          lastIds = res.ids;
        }
        break;
      }
      case 'connect': {
        const res = execConnect(d, cmd, { ...ctx, lastIds }, { findRef, compsByIds, padPoint, say });
        if (res) {
          changed = true;
          select = res.select;
        }
        break;
      }
    }
  }

  const al = alive();
  lastIds = lastIds.filter((id) => al.has(id));
  return { doc: d, select, lastIds, effects, lines, changed };
}

function resolveAnchor(
  a: CopilotAnchor, d: Doc, ctx: CopilotCtx, gw: number, gh: number,
  nearBox: ((ref: string) => [number, number, number, number] | null) | null,
): Pt {
  const cx = M.clamp(ctx.center.x, 1, Math.max(1, d.w - 1));
  const cy = M.clamp(ctx.center.y, 1, Math.max(1, d.h - 1));
  switch (a.t) {
    case 'view': return { x: cx, y: cy };
    case 'center': return { x: d.w / 2, y: d.h / 2 };
    case 'point': return { x: a.x, y: a.y };
    case 'corner': {
      const x = a.h === 'l' ? a.margin + gw / 2 : a.h === 'r' ? d.w - a.margin - gw / 2 : d.w / 2;
      const y = a.v === 'b' ? a.margin + gh / 2 : a.v === 't' ? d.h - a.margin - gh / 2 : d.h / 2;
      return { x, y };
    }
    case 'near': {
      const bb = nearBox ? nearBox(a.ref) : null;
      if (!bb) return { x: cx, y: cy };
      const [x1, y1, x2, y2] = bb;
      if (a.dir === 'r') return { x: x2 + a.gap + gw / 2, y: (y1 + y2) / 2 };
      if (a.dir === 'l') return { x: x1 - a.gap - gw / 2, y: (y1 + y2) / 2 };
      if (a.dir === 't') return { x: (x1 + x2) / 2, y: y2 + a.gap + gh / 2 };
      return { x: (x1 + x2) / 2, y: y1 - a.gap - gh / 2 };
    }
  }
}

/** Раскладка count точек по схеме; возвращает смещения от центра группы и габарит. */
function layoutOffsets(
  count: number, arrangement: CopilotLayout['arrangement'],
  step: number, stepY: number, cols: number, rows: number, radius: number,
): { dx: number[]; dy: number[]; gw: number; gh: number } {
  const dx: number[] = [];
  const dy: number[] = [];
  let gw = 0;
  let gh = 0;
  if (arrangement === 'circle') {
    for (let i = 0; i < count; i++) {
      const a = (Math.PI / 2 - (i * 2 * Math.PI) / Math.max(1, count));
      dx.push(Math.cos(a) * radius);
      dy.push(Math.sin(a) * radius);
    }
    gw = radius * 2;
    gh = radius * 2;
  } else if (arrangement === 'grid') {
    const c = Math.max(1, cols);
    for (let i = 0; i < count; i++) {
      const col = i % c;
      const row = Math.floor(i / c);
      dx.push((col - (c - 1) / 2) * step);
      dy.push(((rows - 1) / 2 - row) * stepY);
    }
    gw = (c - 1) * step;
    gh = (rows - 1) * stepY;
  } else if (arrangement === 'col') {
    for (let i = 0; i < count; i++) {
      dx.push(0);
      dy.push(((count - 1) / 2 - i) * stepY);
    }
    gh = (count - 1) * stepY;
  } else {
    for (let i = 0; i < count; i++) {
      dx.push((i - (count - 1) / 2) * step);
      dy.push(0);
    }
    gw = (count - 1) * step;
  }
  return { dx, dy, gw, gh };
}

function execPlace(
  d: Doc, cmd: { t: 'place'; what: string } & CopilotLayout | { t: 'via'; viaSize: number; viaDrill: number } & CopilotLayout,
  ctx: CopilotCtx, say: (ok: boolean, text: string) => void,
): { ids: string[] } | null {
  const isVia = cmd.t === 'via';
  const g = isVia ? null : genQuery(cmd.what);
  if (!isVia && (!g || !g.ok || !g.els || !g.bl)) {
    const hint = g && !g.ok && g.error ? ` ${g.error.split('.')[0]}.` : '';
    say(false, `🤔 Не понял, что поставить: «${isVia ? '' : (cmd as { what: string }).what}».${hint} Попробуй: «dip 8», «резистор 0805», «светодиод 5мм», «кнопка 6x6».`);
    return null;
  }
  const bl = isVia ? [0, 0, 0, 0] as [number, number, number, number] : (g as { bl: [number, number, number, number] }).bl;
  const rot = cmd.rot ?? 0;
  const swap = Math.abs(((rot % 180) + 180) % 180 - 90) < 45;
  const compW = isVia ? (cmd as { viaSize: number }).viaSize : swap ? bl[3] - bl[1] : bl[2] - bl[0];
  const compH = isVia ? (cmd as { viaSize: number }).viaSize : swap ? bl[2] - bl[0] : bl[3] - bl[1];
  const step = cmd.step ?? r3(compW + 2);
  const stepY = cmd.stepY ?? (cmd.step ?? r3(compH + 2));
  const radius = Math.max(2, cmd.radius ?? 15);
  if (step < 0.2 || stepY < 0.2) {
    say(false, 'Шаг слишком маленький — минимум 0.2 мм.');
    return null;
  }
  const count = Math.min(200, Math.max(1, cmd.count));
  const cols = cmd.cols || count;
  const rows = cmd.rows || 1;
  const { dx, dy, gw, gh } = layoutOffsets(count, cmd.arrangement, step, stepY, cols, rows, radius);
  const nearBox = (ref: string): [number, number, number, number] | null => {
    const c = d.entities.find(
      (e): e is Comp => e.kind === 'comp' && (e.ref ?? '').trim().toLocaleUpperCase() === ref.trim().toLocaleUpperCase(),
    );
    return c ? M.entBBox(c) : null;
  };
  if (cmd.anchor.t === 'near' && !nearBox(cmd.anchor.ref)) {
    say(false, `Не нашёл деталь ${cmd.anchor.ref} — рядом с чем ставить?`);
    return null;
  }
  const fullW = gw + compW;
  const fullH = gh + compH;
  let anchor = resolveAnchor(cmd.anchor, d, ctx, fullW, fullH, nearBox);
  // группа целиком в плату — иначе подтягиваем
  let nudged = false;
  const minX = fullW / 2 + 0.5;
  const maxX = d.w - fullW / 2 - 0.5;
  const minY = fullH / 2 + 0.5;
  const maxY = d.h - fullH / 2 - 0.5;
  if (maxX >= minX && maxY >= minY) {
    const nx = M.clamp(anchor.x, minX, maxX);
    const ny = M.clamp(anchor.y, minY, maxY);
    if (Math.abs(nx - anchor.x) > 1e-6 || Math.abs(ny - anchor.y) > 1e-6) {
      nudged = true;
      anchor = { x: nx, y: ny };
    }
  }

  const ids: string[] = [];
  const refs: string[] = [];
  const side = cmd.side ?? 'top';
  for (let i = 0; i < count; i++) {
    const x = r3(anchor.x + dx[i]);
    const y = r3(anchor.y + dy[i]);
    const id = M.uid();
    if (isVia) {
      const v = cmd as { viaSize: number; viaDrill: number };
      d.entities.push({ id, kind: 'via', x, y, size: v.viaSize, drill: Math.min(v.viaDrill, v.viaSize * 0.6) });
    } else {
      const gg = g as { title?: string; els: Parameters<typeof libElsToEnts>[0]; bl: [number, number, number, number]; query: string };
      const name = gg.title ?? cmd.what;
      const ents = libElsToEnts(gg.els).map((e) => ({ ...JSON.parse(JSON.stringify(e)) as Entity, id: M.uid() }) as Entity);
      const ref = nextReference(name, d.entities);
      d.entities.push({
        id, kind: 'comp', lib: '', name, ref, value: name, footprint: name,
        x, y, rot, side, bl: [...bl] as [number, number, number, number], ents,
      });
      refs.push(ref);
    }
    ids.push(id);
  }

  const n = count;
  const bits: string[] = [];
  if (cmd.arrangement === 'row') bits.push(`в ряд, шаг ${M.fmt(step)} мм`);
  else if (cmd.arrangement === 'col') bits.push(`в столбец, шаг ${M.fmt(stepY)} мм`);
  else if (cmd.arrangement === 'grid') bits.push(`сетка ${rows}×${cols}, шаг ${M.fmt(step)}×${M.fmt(stepY)} мм`);
  else if (cmd.arrangement === 'circle') bits.push(`по кругу, радиус ${M.fmt(radius)} мм`);
  if (rot) bits.push(`поворот ${rot}°`);
  if (side === 'bottom') bits.push('снизу платы');
  if (nudged) bits.push('подвинул, чтобы влезло в плату');
  const tail = bits.length ? ` — ${bits.join(', ')}` : '';
  if (isVia) {
    const v = cmd as { viaSize: number; viaDrill: number };
    say(true, `✅ Поставил ${n} ${plur(n, ['переход', 'перехода', 'переходов'])} ${M.fmt(v.viaSize)}/${M.fmt(v.viaDrill)}${tail}.`);
  } else {
    const title = (g as { title?: string }).title ?? cmd.what;
    const rr = refs.length ? ` (${refRange(refs)})` : '';
    say(true, `✅ Поставил ${n} × «${title}»${rr}${tail}.`);
  }
  return { ids };
}

interface ConnectDeps {
  findRef: (ref: string) => Comp | undefined;
  compsByIds: (ids: string[]) => Comp[];
  padPoint: (c: Comp, slot: PadSlot) => Pt | null;
  say: (ok: boolean, text: string) => void;
}

function nextNetName(d: Doc, label: string | null): string {
  if (label) {
    const base = label.trim().replace(/\s+/g, ' ');
    const name = base.charAt(0).toLocaleUpperCase('ru-RU') + base.slice(1);
    if (!(d.nets ?? []).some((n) => n.name === name)) return name;
  }
  let i = (d.nets ?? []).length + 1;
  const used = new Set((d.nets ?? []).map((n) => n.name));
  while (used.has(`Цепь ${i}`)) i++;
  return `Цепь ${i}`;
}

function execConnect(
  d: Doc, cmd: { t: 'connect'; pairs: { ref: string; pin: number | null }[] | null; picks: CopilotPick[]; width: number | null; layer: 'k1' | 'k2' | null },
  ctx: CopilotCtx, deps: ConnectDeps,
): { select: string[] } | null {
  const { findRef, compsByIds, padPoint, say } = deps;
  const width = cmd.width ?? ctx.trackW;

  // явные «D1.2 с D2.1»
  if (cmd.pairs) {
    const comps: Comp[] = [];
    for (const p of cmd.pairs) {
      const c = findRef(p.ref);
      if (!c) {
        say(false, `Не нашёл деталь ${p.ref} на плате. Сначала поставь её — например «поставь dip 8».`);
        return null;
      }
      comps.push(c);
    }
    const slotsList = comps.map(compPads);
    for (let i = 0; i < comps.length; i++) {
      if (!slotsList[i].length) {
        say(false, `У детали ${cmd.pairs[i].ref} нет площадок — нечего соединять.`);
        return null;
      }
    }
    // точки: указанный вывод либо ближайшая к соседу
    const pts: Pt[] = [];
    const padIds: string[] = [];
    const chosen: PadSlot[] = [];
    for (let i = 0; i < comps.length; i++) {
      const slots = slotsList[i];
      const wantPin = cmd.pairs[i].pin;
      let slot: PadSlot | null = null;
      if (wantPin !== null && wantPin !== undefined) {
        slot = slots.find((s) => s.pin === wantPin) ?? slots[wantPin - 1] ?? null;
        if (!slot) {
          say(false, `У детали ${cmd.pairs[i].ref} нет вывода ${wantPin} (всего ${slots.length}).`);
          return null;
        }
      } else if (pts.length) {
        const prev = pts[pts.length - 1];
        let best: PadSlot | null = null;
        let bd = Infinity;
        for (const s of slots) {
          const p = padPoint(comps[i], s);
          if (!p) continue;
          const dd = Math.hypot(p.x - prev.x, p.y - prev.y);
          if (dd < bd) { bd = dd; best = s; }
        }
        slot = best ?? slots[0];
      } else {
        slot = slots[0];
      }
      const p = padPoint(comps[i], slot);
      if (!p) {
        say(false, `Не получилось найти площадку у ${cmd.pairs[i].ref}.`);
        return null;
      }
      chosen.push(slot);
      pts.push(p);
      padIds.push(`${comps[i].id}:${slot.i}`);
    }
    return finishChain(d, ctx, say, comps, chosen, pts, padIds, width, cmd.layer, null,
      cmd.pairs.map((p, i) => `${p.ref}${p.pin ? `.${p.pin}` : ''}`).join(' → '));
  }

  // групповой режим: последние поставленные либо выделенные
  let comps = compsByIds(ctx.lastIds);
  if (comps.length < 2) comps = compsByIds(ctx.selIds);
  if (comps.length < 2) {
    say(false, 'Нечего соединять: нужно минимум две детали. Сначала поставь их — например «поставь 4 светодиода в ряд».');
    return null;
  }
  const noPads = comps.filter((c) => !compPads(c).length);
  if (noPads.length) {
    say(false, `У деталей ${noPads.map((c) => c.ref ?? c.name).join(', ')} нет площадок — соединять нечего.`);
    return null;
  }
  if (!cmd.picks.length) {
    // «соедини их» — цепочка через ближайшие площадки
    const pts: Pt[] = [];
    const padIds: string[] = [];
    const chosen: PadSlot[] = [];
    for (let i = 0; i < comps.length; i++) {
      const slots = compPads(comps[i]);
      let slot = slots[0];
      if (pts.length) {
        const prev = pts[pts.length - 1];
        let bd = Infinity;
        for (const s of slots) {
          const p = padPoint(comps[i], s);
          if (!p) continue;
          const dd = Math.hypot(p.x - prev.x, p.y - prev.y);
          if (dd < bd) { bd = dd; slot = s; }
        }
      }
      const p = padPoint(comps[i], slot);
      if (!p) {
        say(false, 'Не получилось найти площадки для соединения.');
        return null;
      }
      chosen.push(slot);
      pts.push(p);
      padIds.push(`${comps[i].id}:${slot.i}`);
    }
    return finishChain(d, ctx, say, comps, chosen, pts, padIds, width, cmd.layer, null, null);
  }

  // «соедини катоды (и аноды)» — по цепочке на каждый признак
  const made: string[] = [];
  const sel: string[] = [];
  for (const pick of cmd.picks) {
    const pts: Pt[] = [];
    const padIds: string[] = [];
    const chosen: PadSlot[] = [];
    let missing: Comp | null = null;
    for (const c of comps) {
      const slots = compPads(c);
      const slot = pickPad(slots, pick);
      if (!slot) { missing = c; break; }
      const p = padPoint(c, slot);
      if (!p) { missing = c; break; }
      chosen.push(slot);
      pts.push(p);
      padIds.push(`${c.id}:${slot.i}`);
    }
    if (missing) {
      const mm = missing as Comp;
      if (pick.t === 'pin') say(false, `У детали ${mm.ref ?? mm.name} нет вывода ${pick.n === -1 ? 'последнего' : pick.n}.`);
      else say(false, `У детали ${mm.ref ?? mm.name} не нашёл «${pick.label}».`);
      continue;
    }
    const r = finishChain(d, ctx, say, comps, chosen, pts, padIds, width, cmd.layer, pick.label, null);
    if (r) {
      sel.push(...r.select);
      made.push(pick.label);
    }
  }
  if (!made.length) return null;
  return { select: sel };
}

function finishChain(
  d: Doc, ctx: CopilotCtx, say: (ok: boolean, text: string) => void,
  comps: Comp[], chosen: PadSlot[], pts: Pt[], padIds: string[],
  width: number, wantLayer: 'k1' | 'k2' | null, netLabel: string | null, routeLabel: string | null,
): { select: string[] } | null {
  // убрать повторы соседних точек
  const fp: Pt[] = [];
  const fi: string[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = fp[fp.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.05) {
      fp.push({ x: r3(p.x), y: r3(p.y) });
      fi.push(padIds[i]);
    }
  }
  if (fp.length < 2) {
    say(false, 'Все площадки уже в одной точке — соединять нечего.');
    return null;
  }
  // слой: выводные площадки паяются снизу (K2), SMD — по своему слою
  let layer: 'k1' | 'k2' = wantLayer ?? ctx.activeCu;
  if (!wantLayer) {
    let smdLayer: 'k1' | 'k2' | null = null;
    let mixed = false;
    let hasTht = false;
    for (let i = 0; i < comps.length; i++) {
      const inner = (comps[i].ents ?? [])[chosen[i].i];
      if (!inner) continue;
      if (inner.kind === 'smd') {
        if (smdLayer && smdLayer !== inner.layer) mixed = true;
        smdLayer = inner.layer;
      } else hasTht = true;
    }
    if (mixed) layer = 'k2';
    else if (smdLayer && !hasTht) layer = smdLayer;
    else layer = 'k2';
  }
  const id = M.uid();
  d.entities.push({ id, kind: 'track', pts: fp, w: width, layer });
  const netName = nextNetName(d, netLabel);
  d.nets = [...(d.nets ?? []), { id: M.uid(), name: netName, pads: fi, source: 'manual' }];
  const refs = refRange(comps.map((c) => c.ref ?? c.name));
  const what = netLabel ? `«${netLabel}» ${refs}` : routeLabel ? routeLabel : refs;
  say(true, `✅ Соединил ${what} — дорожка ${M.fmt(width)} мм по ${layer.toLocaleUpperCase()} (цепь «${netName}»).`);
  return { select: [id] };
}
