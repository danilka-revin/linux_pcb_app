// Генератор посадочных мест по описанию «в одну строку».
//
// Вместо каталога готовых макросов — разбор свободной строки: пользователь
// пишет «dip 16 широкий, 2 крепёжных отверстия m3» или «0805», «плата 60x40
// 4 отверстия», «разъём 2x5 шаг 2.54 подписи» — генератор выбирает семейство
// корпусов, подставляет номинальные размеры и считает геометрию (footprint.ts).
//
// Что понимает разборщик:
//   • семейства по названию и синонимам (рус/англ): dip, soic/sop/tssop, qfn,
//     lqfp/qfp, резистор/конденсатор/диод/led, коды 0402…2512, ряд/штыри/
//     разъём/гнездо/панелька, клеммник, кнопка, реле, кварц, to-92…to-247,
//     sot-23/89/223/dpak, электролит, модули (nano, pico, esp32, nodemcu…),
//     плата/основание, крепёжное отверстие, площадка/тестпоинт, метка;
//   • числа с единицами: `2.54 мм`, `100mil`, `0.25 Вт`, `Ø6.3`;
//   • пары: `60x40` (габарит), `2x40` (рядов × выводов), `1.8/0.8` (площадка/сверло);
//   • множитель количества: `отверстие m3 x4`, `4 вывода`;
//   • ключ=значение: `pins=8`, `шаг=1.27`, `отверстия=4`, `подписи=0`, `silk=off`;
//   • слова-модификаторы: широкий/узкий, панелька/штыри, «без шелкографии»,
//     «без подписей», «все подписи», «низ»/«верх», «теплоплощадка», M2…M4.
//
// Всё, что не влияет на геометрию (номинал «10ком», «100нф», слова «для
// зарядки»), ошибкой не считается: номинал уходит подписью на шелкографию,
// остальные слова показаны в списке «проигнорировано».

import {
  bboxOf as fpBBox,
  boardFootprint, chipSmdFootprint, crystalFootprint, dipFootprint, dipSwitchFootprint,
  electroFootprint, fiducialFootprint, holeFootprint, minCopperPitch, moduleFootprint,
  packFootprint, padFootprint, quadFootprint, relayFootprint, rowFootprint, r3, shieldFootprint,
  soicFootprint, sotFootprint, tactFootprint, terminalFootprint, twoLeadFootprint,
  type FpSpec, type LibEl, type LibLayer, type Polarity,
} from './footprint';

export type ParamVal = number | string | boolean;
export type Params = Record<string, ParamVal>;

export interface ParamDef {
  key: string;
  /** подпись в панели параметров */
  label: string;
  kind: 'int' | 'num' | 'bool' | 'enum' | 'text';
  def: ParamVal;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
  hint?: string;
  /** слова в строке описания, которыми задаётся параметр */
  words?: string[];
  /** как печатать параметр обратно в строку; null — не печатать */
  token?: string | null;
  /**
   * false — число ищется только ПОСЛЕ слова. Нужно для слов, которые сами
   * содержат цифру («m3»): иначе «dip 8 m3» прочтётся как «отверстие 8 мм».
   */
  rev?: boolean;
}

export interface GenOut {
  els: LibEl[];
  spec?: FpSpec;
  /** заголовок результата: «DIP-8 · ряд 7.62 мм» */
  title?: string;
  notes?: string[];
}

export interface Family {
  id: string;
  title: string;
  /** подсказка в интерфейсе */
  hint: string;
  /** ключевые слова выбора семейства */
  aliases: string[];
  /** слабые слова: срабатывают, только если ничего сильнее не нашлось */
  weak?: string[];
  /** порядок «огоголенных» чисел: 12 → первый ещё не заданный параметр из списка */
  bare: string[] | ((p: Params) => string[]);
  /** число в имени корпуса — не количество выводов (sot-23, to-220, 0805) */
  noNum?: boolean;
  params: ParamDef[];
  build: (p: Params, ctx: BuildCtx) => GenOut;
}

export interface BuildCtx {
  /** сторона установки (низ → Ш2/K2) */
  bottom: boolean;
  layer: LibLayer;
  cu: 'k1' | 'k2';
  /** какое слово выбрало семейство — влияет на подпись и корпус */
  word: string;
  /** значения по умолчанию: позволяет понять, что пользователь ничего не задавал */
  defaults: Params;
}

// ---------------------------------------------------------------- параметры

const P_INT = (key: string, label: string, def: number, opts: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'int', def, min: 1, max: 200, step: 1, token: key, ...opts });

const P_NUM = (key: string, label: string, def: number, opts: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'num', def, min: 0, max: 500, step: 0.05, token: key, ...opts });

const P_BOOL = (key: string, label: string, def: boolean, opts: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'bool', def, token: key, ...opts });

const P_ENUM = (key: string, label: string, def: string, options: [string, string][], opts: Partial<ParamDef> = {}): ParamDef =>
  ({ key, label, kind: 'enum', def, options, token: key, ...opts });

const pitch = (def = 2.54, words: string[] = ['шаг', 'pitch']): ParamDef =>
  P_NUM('pitch', 'Шаг выводов, мм', def, { min: 0.3, max: 30, step: 0.01, words, hint: 'между соседними выводами в ряду' });

const padSize = (def = 1.7): ParamDef =>
  P_NUM('padSize', 'Площадка, мм', def, { min: 0.6, max: 12, step: 0.05, words: ['площадка', 'pad', 'пятак', 'пяточек'] });

const drill = (def = 0.9): ParamDef =>
  P_NUM('drill', 'Сверло, мм', def, { min: 0, max: 8, step: 0.05, words: ['сверло', 'drill'] });

const labelsEvery = (def = 1, words = ['подписи', 'нумерация', 'labels', 'маркировка']): ParamDef =>
  P_INT('labels', 'Подписывать каждый N-й вывод', def, {
    min: 0, max: 20, words, token: 'подписи', rev: false,
    hint: '1 — все выводы, 0 — без подписей, 5 — каждый пятый плюс первый и последний',
  });

const silkOn = (): ParamDef => P_BOOL('silk', 'Корпус на шелкографии', true, {
  words: ['шелкография', 'silk', 'обводка'], token: 'silk',
});

const socketP = (def = false): ParamDef => P_BOOL('socket', 'Гнездо (панелька под штырь)', def, {
  words: ['панелька', 'socket', 'гнездо', 'female'], token: 'панелька',
});

const holeCount = (def = 0, words = ['крепёжные отверстия', 'крепёж', 'крепление', 'отверстия', 'mounting holes', 'mounts']): ParamDef =>
  P_INT('holes', 'Крепёжных отверстий', def, { min: 0, max: 4, words, token: 'отверстия' });

const holeDia = (def = 3.2): ParamDef =>
  P_NUM('holeD', 'Ø крепёжного отверстия, мм', def, {
    min: 0.6, max: 12, step: 0.05, words: ['m2', 'm2.5', 'm3', 'm4', 'резьба', 'винт'], token: 'отверстие', rev: false,
    hint: 'M2 → 2.2, M2.5 → 2.7, M3 → 3.2, M4 → 4.3 мм',
  });

const holePad = (def = 0): ParamDef =>
  P_NUM('holePad', 'Кольцо меди вокруг крепежа, мм', def, {
    min: 0, max: 15, step: 0.1, words: ['кольцо', 'металлизация'], token: 'кольцо',
    hint: '0 — голое отверстие; больше нуля — металлизированное под стойку',
  });

const valueP = (): ParamDef => ({
  key: 'value', label: 'Номинал / подпись', kind: 'text', def: '', token: null,
  words: ['номинал', 'value'], hint: 'текст в центре корпуса: 10k, 100nF, U1…',
});

const bodyW = (def = 0): ParamDef =>
  P_NUM('bodyW', 'Корпус по X, мм', def, { min: 0, max: 200, step: 0.1, words: ['корпус', 'body', 'габарит'], token: 'корпус' });

const bodyH = (def = 0): ParamDef =>
  P_NUM('bodyH', 'Корпус по Y, мм', def, { min: 0, max: 200, step: 0.1, words: ['высота корпуса'], token: null });

// ---------------------------------------------------------------- утилиты разбора

const norm = (s: string): string => s
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/[«»""„]/g, ' ')
  .replace(/[’‘`]/g, "'")
  .replace(/×/g, 'x')
  .replace(/[–—−]/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

const toNum = (s: string): number => parseFloat(s.replace(',', '.'));

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Число с единицами, «не прилипло» справа к буквам */
const NUMRE = String.raw`(\d+(?:[.,]\d+)?)(?![0-9a-zа-я])`;
/** число, за которым может идти единица измерения («0.25w», «10ком») */
const NUMP = String.raw`(\d+(?:[.,]\d+)?)(?![0-9a-zа-я.])`;
const UNITRE = String.raw`\s*(мм|mm|mil|мил|см|"|дюйм[а-яё0-9-]*)?`;

/** Метрические коды SMD-корпусов: зазор площадок, сами площадки, корпус */
const CHIP_CODES: Record<string, { gap: number; padW: number; padH: number; bw: number; bh: number }> = {
  '0201': { gap: 0.55, padW: 0.5, padH: 0.4, bw: 0.6, bh: 0.3 },
  '0402': { gap: 0.5, padW: 0.5, padH: 0.6, bw: 1.0, bh: 0.5 },
  '0603': { gap: 0.75, padW: 0.8, padH: 0.9, bw: 1.6, bh: 0.8 },
  '0805': { gap: 1.1, padW: 1.0, padH: 1.35, bw: 2.0, bh: 1.25 },
  '1206': { gap: 1.6, padW: 1.2, padH: 1.7, bw: 3.1, bh: 1.6 },
  '1210': { gap: 1.6, padW: 1.4, padH: 2.4, bw: 3.1, bh: 2.6 },
  '1812': { gap: 2.2, padW: 1.6, padH: 3.0, bw: 4.5, bh: 3.2 },
  '2010': { gap: 2.5, padW: 1.8, padH: 2.6, bw: 5.0, bh: 2.5 },
  '2512': { gap: 3.0, padW: 2.0, padH: 3.2, bw: 6.3, bh: 3.1 },
};

/** Выводные резисторы: мощность → шаг между площадками и корпус */
const POWER_THT: Record<string, { pitch: number; l: number; w: number }> = {
  '0.125': { pitch: 7.62, l: 3.6, w: 1.8 },
  '0.25': { pitch: 10.16, l: 6.5, w: 2.3 },
  '0.5': { pitch: 12.7, l: 9.0, w: 3.2 },
  '1': { pitch: 15.24, l: 11.0, w: 3.5 },
  '2': { pitch: 20.32, l: 15.0, w: 4.5 },
  '3': { pitch: 22.86, l: 18.0, w: 6.0 },
};

/** Диаметры крепёжных отверстий под резьбу */
const THREAD: Record<string, number> = {
  m2: 2.2, 'm2.5': 2.7, m3: 3.2, 'm3.5': 3.7, m4: 4.3, m5: 5.3, m6: 6.4,
};

/** Русские единицы номинала → латиница, которая есть в векторном шрифте */
const VALUE_MAP: [RegExp, string][] = [
  [/гком/, 'G'], [/мком/, 'M'], [/ком|килоом/, 'K'], [/ом/, 'R'],
  [/пф|пикофарад/, 'pF'], [/нф|нанофарад/, 'nF'], [/мкф|микрофарад/, 'uF'], [/фарад/, 'F'],
  [/мкгн|микрогенри/, 'uH'], [/нгн|наногенри/, 'nH'], [/мгн|миллигенри/, 'mH'],
  [/вольт/, 'V'], [/ампер/, 'A'], [/мгц/, 'MHz'], [/ггц/, 'GHz'], [/кхц/, 'kHz'], [/герц/, 'Hz'],
  [/[в]$/, 'V'],
];

/** «10ком» → «10K», «100нф» → «100NF», «16 в» → «16V» */
export function normValue(raw: string): string {
  let s = raw.toLowerCase().replace(/\s+/g, '').replace(',', '.');
  for (const [re, rep] of VALUE_MAP) {
    if (re.test(s)) { s = s.replace(re, rep); break; }
  }
  return s.toUpperCase().replace(/[^0-9A-Z.+-]/g, '').slice(0, 12);
}

// ---------------------------------------------------------------- сканер строки

class Scan {
  s: string;
  /** что уже разобрали (для отчёта) */
  used: string[] = [];

  constructor(text: string) { this.s = norm(text); }

  /** вырезает первое совпадение и возвращает группы */
  take(re: RegExp): RegExpMatchArray | null {
    const m = this.s.match(re);
    if (!m || !m[0]) return null;
    const at = m.index ?? 0;
    this.s = this.s.slice(0, at) + ' ' + this.s.slice(at + m[0].length);
    this.used.push(m[0].trim());
    return m;
  }

  /** осталось ли ещё слово (не вырезая) */
  has(re: RegExp): boolean { return re.test(this.s); }

  /** слова, которые разбору не пригодились */
  rest(): string[] {
    return this.s
      .split(/[^0-9a-zа-я.]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 2 && !/^\d+([.,]\d+)?$/.test(w));
  }
}

/**
 * «шаг 2.54 мм», «шаг=2.54», «2.54 шаг», «100mil шаг» → число в мм.
 * Единица может быть приклеена к числу («100mil») — поэтому она внутри совпадения,
 * а граница слова проверяется уже после неё.
 */
const NUMUNIT = String.raw`(\d+(?:[.,]\d+)?)(\s*(?:мм|mm|мил|mil|см|cm|дюйм[а-яё0-9-]*))?(?![0-9a-zа-я])`;
function takeNumBy(sc: Scan, words: string[], rev = true): number | null {
  const alt = words.filter((w) => w.length > 1).map((w) => esc(norm(w))).sort((a, b) => b.length - a.length).join('|');
  if (!alt) return null;
  let m = sc.take(new RegExp(String.raw`(?:${alt})\s*[:=]?\s*${NUMUNIT}`, 'i'));
  if (m) return conv(m[1], m[2] ?? '');
  if (!rev) return null;
  m = sc.take(new RegExp(String.raw`(?:^|[^0-9a-zа-я./])${NUMUNIT}\s*(?:${alt})(?![0-9a-zа-я])`, 'i'));
  if (m) return conv(m[1], m[2] ?? '');
  return null;
}

/** ми́ллы → мм, см → мм */
function conv(v: string, full: string): number {
  const x = toNum(v);
  if (/mil|мил/.test(full)) return r3(x * 0.0254);
  if (/дюйм|"/.test(full)) return r3(x * 25.4);
  if (/см/.test(full)) return r3(x * 10);
  return x;
}

/** «площадка 1.8/0.8» → [площадка, сверло] */
function takePadPair(sc: Scan): [number, number] | null {
  const m = sc.take(/(?:площадка|pad|пят[ао][кч][а-яё0-9-]*)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)/);
  return m ? [toNum(m[1]), toNum(m[2])] : null;
}

/** «60x40», «2x40» (после слова или само по себе) → [a, b] */
function takePair(sc: Scan, before: string[]): [number, number] | null {
  const alt = before.length ? before.map((w) => esc(norm(w))).join('|') : '';
  const P = String.raw`(\d+(?:[.,]\d+)?)`;
  const TAIL = String.raw`(?![0-9a-zа-я])`;
  let m = alt
    ? sc.take(new RegExp(String.raw`(?:${alt})\s*[:=]?\s*${P}\s*(?:мм|mm)?\s*[x/х]\s*${P}${TAIL}`, 'i'))
    : null;
  if (!m) m = sc.take(new RegExp(String.raw`(?:^|\s)${P}\s*(?:мм|mm)?\s*[x/х]\s*${P}${TAIL}`, 'i'));
  return m ? [toNum(m[1]), toNum(m[2])] : null;
}

/** «1.8/0.8» без слова «площадка» — площадка и сверло */
function takeBarePair(sc: Scan): [number, number] | null {
  const m = sc.take(new RegExp(String.raw`(?:^|\s)(\d+(?:[.,]\d+)?)\s*/\s*(\d+(?:[.,]\d+)?)(?![0-9a-zа-я])`));
  return m ? [toNum(m[1]), toNum(m[2])] : null;
}

/** Явный ключ-значение для параметра: «шаг=1.27», «silk off», «номинал=10k» */
function takeKV(sc: Scan, def: ParamDef): ParamVal | undefined {
  const keys = [def.key, def.token ?? '', ...(def.words ?? [])]
    .filter((k) => k && k.length > 1)
    .map((k) => esc(norm(k))).sort((a, b) => b.length - a.length).join('|');
  if (!keys) return undefined;
  if (def.kind === 'bool') {
    const m = sc.take(new RegExp(String.raw`(?:без\s+)?(?:${keys})(?:\s*[:=]\s*(on|off|да|нет|вкл|выкл|есть|без|1|0))?`, 'i'));
    if (m) return !(m[0].startsWith('без') || /off|нет|выкл|без|^0$/.test(m[1] ?? ''));
    // «без шелкографии», «без крепёжных»: после «без» сравниваем основу слова —
    // так падежные окончания не нужно перебирать, и чужое «отверстие 3.25» цело
    const stems = keys.split('|').map((k) => k.replace(/[а-яё]{1,2}$/, '')).filter((k) => k.length > 3);
    if (!stems.length) return undefined;
    return sc.take(new RegExp(String.raw`без\s+(?:${stems.join('|')})`, 'i')) ? false : undefined;
  }
  if (def.kind === 'enum' && def.options) {
    for (const [v, label] of def.options) {
      const words = [v, label.split(' ')[0], ...(def.words ?? [])].filter(Boolean).map((w) => esc(norm(w))).join('|');
      if (v === def.def) continue;
      const m = sc.take(new RegExp(String.raw`(?<![0-9a-zа-я])(?:${def.key}|${def.token}|${words})\s*[:=]?\s*${v}(?![0-9a-zа-я])`, 'i'))
        ?? sc.take(new RegExp(String.raw`(?<![0-9a-zа-я])(?:${words})(?![0-9a-zа-я])`, 'i'));
      if (m) {
        // не съедаем слово, которое относится к другому параметру (диод/светодиод)
        return v;
      }
    }
    return undefined;
  }
  if (def.kind === 'text') {
    const m = sc.take(new RegExp(String.raw`(?:${keys})\s*[:=]\s*"?([0-9a-zа-я.,+-]{1,14})"?`, 'i'));
    return m ? m[1] : undefined;
  }
  const v = takeNumBy(sc, [def.key, def.token ?? '', ...(def.words ?? [])], def.rev !== false);
  if (v === null) return undefined;
  return def.kind === 'int' ? Math.round(v) : r3(v);
}

const clampP = (def: ParamDef, v: ParamVal): ParamVal => {
  if (typeof v !== 'number') return v;
  const min = def.min ?? -Infinity, max = def.max ?? Infinity;
  const c = Math.min(max, Math.max(min, v));
  return def.kind === 'int' ? Math.round(c) : r3(c);
};

// ---------------------------------------------------------------- пресеты модулей

interface ModulePreset {
  title: string;
  left: string[];
  right: string[];
  rowW: number;
  bodyW: number;
  bodyH: number;
  holes: number;
  holeD?: number;
  socket?: boolean;
}

/**
 * Имена выводов популярных модулей — ориентировочные (сверху вниз, левый ряд
 * затем правый), их можно править параметром `имена="A0,B1|3V3,GND"`.
 */
const MODULE_NAMES: Record<string, ModulePreset> = {
  nano: {
    title: 'Arduino Nano', rowW: 15.24, bodyW: 17.78, bodyH: 33.02, holes: 0,
    left: ['D1', 'D0', 'RST', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12'],
    right: ['A7', 'A6', 'A5', 'A4', 'A3', 'A2', 'A1', 'A0', 'GND', 'VIN', 'RX0', 'TX1', 'RST', '5V', 'D13'],
  },
  pro_mini: {
    title: 'Arduino Pro Mini', rowW: 15.24, bodyW: 17.78, bodyH: 33.02, holes: 0,
    left: ['TX0', 'RX1', 'RST', 'GND', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
    right: ['RAW', 'GND', 'RST', 'VCC', 'A3', 'A2', 'A1', 'A0', 'D13', 'D12', 'D11', 'D10'],
  },
  pico: {
    title: 'Raspberry Pi Pico', rowW: 17.78, bodyW: 21, bodyH: 51, holes: 2, holeD: 2.0,
    left: ['GP0', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GP6', 'GP7', 'GP8', 'GP9', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'RUN', '3V3EN', 'VSYS', '3V3', 'GND'],
    right: ['GP1', 'ADC0', 'ADC1', 'ADC2', 'GND', 'GP22', 'GP21', 'GP20', 'GP19', 'GP18', 'GP17', 'GP16', 'GP15', 'GP14', 'GND', 'VBUS', 'GND', 'GP26', 'GP27', 'GP28'],
  },
  esp32: {
    title: 'ESP32-DevKitC', rowW: 25.4, bodyW: 27, bodyH: 48.6, holes: 2, holeD: 2.7,
    left: ['EN', 'VP', 'VN', 'D34', 'D35', 'D32', 'D33', 'D25', 'D26', 'D27', 'D14', 'D12', 'GND', 'D13', 'D9', 'D10', 'D11', 'D18', 'D17'],
    right: ['3V3', 'D23', 'D22', 'TX1', 'RX1', 'D21', 'D19', 'D18', 'D5', 'TX2', 'RX2', 'D4', 'D2', 'D15', 'D13', 'D12', 'D14', 'D27', 'GND'],
  },
  nodemcu: {
    title: 'NodeMCU V3 (ESP8266)', rowW: 24.4, bodyW: 27, bodyH: 48.5, holes: 2, holeD: 3.2,
    left: ['3V3', 'GND', 'D8', 'D7', 'D6', 'D5', 'SD1', 'SD0', 'D9', 'RX2', 'TX2', 'RST', 'EN', 'VIN'],
    right: ['A0', 'D0', 'D4', 'D3', 'D2', 'D1', 'CMD', 'CLK', 'D8', 'D3', 'RX0', 'TX0', 'RST', '3V3'],
  },
  d1mini: {
    title: 'Wemos D1 mini', rowW: 15.24, bodyW: 17.78, bodyH: 34.2, holes: 2, holeD: 2.7,
    left: ['D5', 'D6', 'D7', 'D8', '3V3', 'RST', 'D4', 'D3'],
    right: ['D1', 'D2', 'SCA', '5V', 'GND', 'D4', 'RX', 'TX'],
  },
  esp01: {
    title: 'ESP-01 (гнездо 2×4)', rowW: 15.24, bodyW: 14.5, bodyH: 23.5, holes: 0, socket: true,
    left: ['GND', 'GPIO2', 'RX0', 'EN'],
    right: ['RST', 'GPIO0', 'TX0', 'VCC'],
  },
  bluepill: {
    title: 'STM32F103C8T6 Blue Pill', rowW: 15.24, bodyW: 22.86, bodyH: 53.34, holes: 0,
    left: ['VBAT', 'PC13', 'PC14', 'PC15', 'PA0', 'PA1', 'PA2', 'PA3', 'PA4', 'PA5', 'PA6', 'PA7', 'PB0', 'PB1', 'PB10', 'PB11', 'NRST', '3V3', 'GND', 'GND'],
    right: ['3V3', 'GND', '5V', 'PB9', 'PB8', 'PB7', 'PB6', 'PB5', 'PB4', 'PB3', 'PA15', 'PA12', 'PA11', 'PA10', 'PA9', 'PA8', 'PB15', 'PB14', 'PB13', 'PB12'],
  },
  hat40: {
    title: 'Raspberry Pi GPIO 40 (HAT)', rowW: 2.54, bodyW: 5.8, bodyH: 53.34, holes: 0,
    left: ['3V3', 'IO2', 'IO3', 'IO4', 'GND', 'IO17', 'IO27', 'IO22', '3V3', 'MOSI', 'MISO', 'SCLK', 'GND', 'ID_SD', 'IO5', 'IO6', 'IO13', 'IO19', 'IO26', 'GND'],
    right: ['5V', '5V', 'GND', 'IO14', 'IO15', 'IO18', 'GND', 'IO23', 'IO24', 'GND', 'IO25', 'IO8', 'IO7', 'ID_SC', 'GND', 'IO12', 'GND', 'IO16', 'IO20', 'IO21'],
  },
};

const detectModule = (s: string): string | null => {
  if (/pro\s*mini|про\s*мини/.test(s)) return 'pro_mini';
  if (/blue\s*-?\s*pill|stm32f103c8t6/.test(s)) return 'bluepill';
  if (/nano/.test(s)) return 'nano';
  if (/pico|пико/.test(s)) return 'pico';
  if (/esp\s*-?\s*01\b|esp01/.test(s)) return 'esp01';
  if (/esp\s*32|devkit|эсп\s*32/.test(s)) return 'esp32';
  if (/nodemcu|node\s*mcu/.test(s)) return 'nodemcu';
  if (/d1\s*mini|wemos/.test(s)) return 'd1mini';
  if (/gpio|raspberry|rpi|hat\b/.test(s)) return 'hat40';
  return null;
};

// ---------------------------------------------------------------- семейства

const ctxLayer = (ctx: BuildCtx): LibLayer => ctx.layer;

/** Метит «светодиод/диод» и т. п. — влияет на название и полярность */
const wordIs = (ctx: BuildCtx, re: RegExp): boolean => re.test(ctx.word);

export const FAMILIES: Family[] = [
  {
    id: 'dip',
    title: 'DIP — выводы через отверстие',
    hint: 'Корпуса микросхем и панельки: число выводов, междурядье 7.62 или 15.24 мм, полукруглый ключ, подписи номеров.',
    aliases: ['дип', 'dip', 'корпус dip', 'микросхема dip'],
    weak: ['микросхема', 'ич', 'ic', 'корпус'],
    bare: ['pins', 'pitch', 'rowW'],
    params: [
      P_INT('pins', 'Выводов', 8, { min: 2, max: 100, words: ['выводов', 'pins'], token: 'pins' }),
      P_NUM('rowW', 'Междурядье, мм', 7.62, { min: 2.54, max: 30, step: 0.01, words: ['междурядье', 'row'] }),
      pitch(2.54), padSize(1.6), drill(0.8), socketP(), labelsEvery(1), silkOn(),
      holeCount(), holeDia(), holePad(), valueP(),
    ],
    build(p, ctx) {
      const pins = 2 * Math.max(1, Math.round(((p.pins as number) || 8) / 2));
      const el = dipFootprint({
        pins,
        rowW: p.rowW as number,
        pitch: p.pitch as number,
        padSize: p.padSize as number,
        drill: p.drill as number,
        socket: !!p.socket,
        labels: p.labels as number,
        silk: p.silk as boolean,
        layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
      });
      const holes = mountOn(el.els, p);
      return {
        els: holes.els,
        spec: {
          ...el.spec, holes: holes.n,
          w: r3(p.rowW as number), h: r3(((pins / 2) - 1) * (p.pitch as number) + 2.54),
        },
        title: `DIP-${pins}${p.socket ? ' (панелька)' : ''}${(p.rowW as number) > 10 ? ' · 600 mil' : ''}`,
        notes: holes.note,
      };
    },
  },
  {
    id: 'soic',
    title: 'SOIC / SOP / TSSOP / MSOP',
    hint: 'Планарный корпус с двумя рядами выводов. Межцентровое расстояние рядов: 5.4 мм (узкий) или 9.4 мм (широкий).',
    aliases: ['soic', 'sop', 'соик', 'tssop', 'ssop', 'msop', 'soj', 'планар', 'с оп'],
    bare: ['pins', 'pitch', 'rowX'],
    params: [
      P_INT('pins', 'Выводов', 8, { min: 2, max: 100, words: ['выводов', 'pins'], token: 'pins' }),
      pitch(1.27),
      P_NUM('rowX', 'Между центрами рядов, мм', 5.4, { min: 1.5, max: 20, step: 0.05, words: ['междурядье'], token: null }),
      P_NUM('padLen', 'Длина площадки, мм', 1.8, { min: 0.3, max: 6, step: 0.05, words: ['площадка'], token: 'площадка' }),
      P_NUM('padH', 'Ширина площадки, мм', 0.6, { min: 0.2, max: 4, step: 0.05, words: ['ширина площадки'], token: null }),
      bodyW(0), labelsEvery(1), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const pins = 2 * Math.max(1, Math.round(((p.pins as number) || 8) / 2));
      const el = soicFootprint({
        pins,
        pitch: p.pitch as number,
        rowX: p.rowX as number,
        padLen: p.padLen as number,
        padH: p.padH as number,
        bodyW: (p.bodyW as number) || ((p.rowX as number) > 7 ? 7.5 : (p.rowX as number) - 1.5),
        labels: (p.labels as number) !== 0,
        labelSize: Math.min(0.9, (p.pitch as number) * 0.75),
        silk: p.silk as boolean,
        layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
      });
      const code = wordIs(ctx, /tssop|msop/) ? 'TSSOP' : wordIs(ctx, /ssop/) ? 'SSOP' : 'SOIC';
      return {
        els: el.els,
        spec: {
          ...el.spec, w: r3((p.rowX as number) + 2 * (p.padLen as number)),
          h: r3(((pins / 2) - 1) * (p.pitch as number) + 3),
        },
        title: `${code}-${pins}`,
        notes: pins !== (p.pins as number) ? [`Выводов ${pins}: ряды должны быть равными.`] : undefined,
      };
    },
  },
  {
    id: 'qfn',
    title: 'QFN / DFN',
    hint: 'Площадки по четырём сторонам + тепловая площадка в центре. Размер корпуса — квадрат (3×3, 5×5…).',
    aliases: ['qfn', 'dfn', 'son'],
    bare: ['pins', 'body', 'pitch'],
    params: [
      P_INT('pins', 'Выводов', 16, { min: 4, max: 192, words: ['выводов', 'pins'], token: 'pins' }),
      pitch(0.5),
      P_NUM('body', 'Корпус, мм', 3, { min: 0.8, max: 20, step: 0.1, words: ['корпус', 'body', 'размер'], token: 'корпус' }),
      P_BOOL('thermal', 'Тепловая площадка', true, { words: ['теплоплощадка', 'thermal'], token: 'теплоплощадка' }),
      P_INT('labelEvery', 'Подписывать каждый N-й', 4, { min: 0, max: 20, words: ['подписи', 'labels'], token: 'подписи' }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const want = Math.max(4, Math.round((p.pins as number) || 16));
      const pins = 4 * Math.max(1, Math.round(want / 4));
      const el = quadFootprint({
        kind: 'qfn', pins, pitch: p.pitch as number, body: p.body as number,
        thermal: p.thermal as boolean, labelEvery: p.labelEvery as number,
        silk: p.silk as boolean, layer: ctxLayer(ctx), title: (p.value as string) || undefined,
      });
      return {
        els: el.els, spec: { ...el.spec, w: r3(p.body as number), h: r3(p.body as number) },
        title: `QFN-${pins} (${r3(p.body as number)}×${r3(p.body as number)})`,
        notes: pins !== want ? [`Выводов ${pins} — поровну на 4 стороны (просили ${want}).`] : undefined,
      };
    },
  },
  {
    id: 'qfp',
    title: 'LQFP / TQFP',
    hint: 'Планарный квадратный корпус, выводы на 4 стороны, площадки длиннее чем у QFN.',
    aliases: ['lqfp', 'tqfp', 'qfp', 'lfcp', 'quad flatpack'],
    bare: ['pins', 'body', 'pitch'],
    params: [
      P_INT('pins', 'Выводов', 32, { min: 8, max: 256, words: ['выводов', 'pins'], token: 'pins' }),
      pitch(0.8),
      P_NUM('body', 'Корпус, мм', 7, { min: 2, max: 40, step: 0.1, words: ['корпус', 'body', 'размер'], token: 'корпус' }),
      P_INT('labelEvery', 'Подписывать каждый N-й', 4, { min: 0, max: 20, words: ['подписи', 'labels'], token: 'подписи' }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const want = Math.max(8, Math.round((p.pins as number) || 32));
      const pins = 4 * Math.max(2, Math.round(want / 4));
      const el = quadFootprint({
        kind: 'qfp', pins, pitch: p.pitch as number, body: p.body as number, padLen: 1.25,
        labelEvery: p.labelEvery as number, silk: p.silk as boolean, layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
      });
      return {
        els: el.els, spec: { ...el.spec, w: r3(p.body as number), h: r3(p.body as number) },
        title: `LQFP-${pins} (${r3(p.body as number)}×${r3(p.body as number)})`,
        notes: pins !== want ? [`Выводов ${pins} — поровну на 4 стороны (просили ${want}).`] : undefined,
      };
    },
  },
  {
    id: 'two',
    title: 'Резистор / диод / конденсатор (выводной)',
    hint: 'Осевые компоненты через отверстие: шаг между площадками, размер корпуса, метки полярности, номинал подписью.',
    aliases: [
      'резистор', 'resistor', 'сопротивление', 'диод', 'стабилитрон', 'светодиод', 'led',
      'конденсатор', 'керамический', 'плёночный', 'катушка', 'дроссель', 'индуктивность',
      'предохранитель', 'fuse', 'термистор', 'варистор', 'оптопара',
      'cap', 'caps', 'кондер', 'buzzer', 'зуммер', 'пьезо', 'динамик', 'speaker',
    ],
    bare: (p) => (p.round || p.polarity === 'led' ? ['bodyW', 'pitch', 'padSize'] : ['pitch', 'bodyW', 'bodyH']),
    params: [
      pitch(10.16), bodyW(6.5), bodyH(2.3),
      P_BOOL('round', 'Корпус — окружность', false, { words: ['круглый', 'round'], token: 'круглый' }),
      P_ENUM('polarity', 'Полярность', 'none', [
        ['none', 'нет'], ['diode', 'диод (кольцо катода)'], ['led', 'светодиод (A/K)'],
        ['cap', 'полярный (+)'], ['tant', 'тантал (+)'],
      ], { words: ['полярный', 'полярность'] }),
      padSize(1.8), drill(0.9),
      // «0.25 Вт», «1/4 Вт» разбирает отдельный блок (дроби), здесь только явный ключ
      P_NUM('power', 'Мощность, Вт', 0, { min: 0, max: 10, step: 0.05, words: ['мощность', 'power'], token: null }),
      labelsEvery(0), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const pol = (p.polarity as Polarity) ?? 'none';
      let pitchV = p.pitch as number;
      let l = p.bodyW as number, w = p.bodyH as number;
      const pw = p.power as number;
      const round = !!p.round || pol === 'led' || pol === 'cap';
      const untouched = (k: string): boolean => p[k] === ctx.defaults[k];
      if (pw > 0 && untouched('pitch')) {          // мощность диктует шаг, если его не просили иначе
        const t = POWER_THT[String(pw)] ?? POWER_THT['0.25'];
        pitchV = t.pitch;
        if (untouched('bodyW')) l = t.l;
        if (untouched('bodyH')) w = t.w;
      }
      if (pol === 'led' && untouched('pitch')) pitchV = 2.54;   // стандартные LEDs — 2.54 мм
      if (pol === 'led') { const d = Math.max(l, w) || 5; l = d; w = d; }
      if (!l) l = w * 2.6 || 6.5;
      if (!w) w = l / 2.6;
      const des = /^(r|c|l|d|q|u|xp|cn)$/i.exec(ctx.word)?.[1]?.toLowerCase() ?? '';
      const buz = wordIs(ctx, /buzzer|зуммер|пьезо|динамик|speaker/);
      if (buz) { p.round = true; }
      const name = buz ? 'Пьезоизлучатель'
        : des === 'c' || des === 'cn' ? 'Конденсатор'
        : des === 'l' ? 'Дроссель' : des === 'd' ? 'Диод' : des === 'r' ? 'Резистор'
        : pol === 'led' ? 'Светодиод' : pol === 'diode' ? 'Диод'
        : wordIs(ctx, /конденсатор|керам|плён|cap/) ? 'Конденсатор'
        : wordIs(ctx, /катушка|дроссель|индук/) ? 'Дроссель'
        : wordIs(ctx, /предохран|fuse/) ? 'Предохранитель' : 'Резистор';
      const el = twoLeadFootprint({
        pitch: pitchV, bodyL: l, bodyW: w, round, polarity: pol,
        padSize: p.padSize as number, drill: p.drill as number,
        value: (p.value as string) || undefined, silk: p.silk as boolean, layer: ctxLayer(ctx),
      });
      return {
        els: el.els,
        spec: { ...el.spec, w: r3(Math.max(l, pitchV)), h: r3(w) },
        title: `${name} ${r3(pitchV)} мм${pw ? ` · ${r3(pw)} Вт` : ''}${pol === 'led' ? ` · Ø${r3(l)}` : ''}`,
      };
    },
  },
  {
    id: 'chip',
    title: 'SMD 0201…2512',
    hint: 'Планарные резисторы, конденсаторы, диоды SOD/SMA. Достаточно кода корпуса — размеры площадок подставятся.',
    aliases: ['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512', 'sod', 'sma', 'smb', 'smc', 'чип'],
    // «smd» — слабое слово: «транзистор smd» должен остаться SOT-ом
    weak: ['конденсатор smd', 'резистор smd', 'smd'],
    bare: ['gap', 'padW', 'padH'],
    params: [
      P_ENUM('code', 'Корпус', '0805', Object.keys(CHIP_CODES).map((k): [string, string] => [k, k]), { token: null }),
      P_NUM('gap', 'Между центрами площадок, мм', 1.1, { min: 0.3, max: 12, step: 0.05, words: ['шаг', 'зазор'], token: null }),
      P_NUM('padW', 'Площадка по X, мм', 1, { min: 0.3, max: 8, step: 0.05, words: ['площадка'], token: 'площадка' }),
      P_NUM('padH', 'Площадка по Y, мм', 1.35, { min: 0.3, max: 8, step: 0.05, words: ['размер площадки'], token: null }),
      bodyW(0), bodyH(0),
      P_BOOL('diode', 'Метка катода', false, { words: ['катод'], token: 'диод' }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const code = String(p.code ?? '');
      const c = CHIP_CODES[code] ?? {
        gap: p.gap as number, padW: p.padW as number, padH: p.padH as number,
        bw: 2, bh: 1.25,
      };
      const el = chipSmdFootprint({
        gap: (p.gap as number) && (p.code === undefined) ? (p.gap as number) : c.gap,
        padW: c.padW, padH: c.padH,
        bodyW: (p.bodyW as number) || c.bw, bodyH: (p.bodyH as number) || c.bh,
        polarity: p.diode ? 'diode' : 'none',
        value: (p.value as string) || undefined,
        silk: p.silk as boolean, layer: ctxLayer(ctx), cu: ctx.cu,
      });
      return {
        els: el.els,
        spec: { ...el.spec, w: r3(c.gap + c.padW), h: r3(c.padH) },
        title: code ? `Чип ${code}${p.diode ? ' (диод)' : ''}` : `SMD ${r3(c.gap)} мм`,
      };
    },
  },
  {
    id: 'row',
    title: 'Ряд выводов / штыри / разъём',
    hint: 'Один или несколько рядов площадок через отверстие: штыри, гнезда, IDC, колодки, произвольный разъём. Можно добавить крепёж.',
    aliases: [
      'ряд', 'row', 'гребенка', 'гребёнка', 'штыри', 'pin header', 'header', 'pls',
      'разьем', 'разъём', 'connector', 'коннектор', 'колодка', 'idc', 'папа', 'pin',
      'гребенка 2x40',
    ],
    weak: ['площадки ряда', 'pads', 'панелька', 'гнездо', 'мама', 'female', 'socket'],
    bare: ['n', 'pitch', 'padSize'],
    params: [
      P_INT('n', 'Выводов в ряду', 8, { min: 1, max: 100, words: ['выводов', 'контактов', 'пинов', 'pins', 'шт'], token: 'выводов' }),
      P_INT('rows', 'Рядов', 1, { min: 1, max: 6, words: ['ряда', 'рядов', 'rows'], token: 'рядов' }),
      pitch(2.54),
      P_NUM('pitchY', 'Шаг между рядами, мм', 2.54, { min: 0.3, max: 40, step: 0.01, words: ['между рядами', 'row gap'], token: 'рядов' }),
      padSize(1.7), drill(0.9), socketP(), labelsEvery(1), silkOn(),
      bodyW(0), bodyH(0), holeCount(), holeDia(), holePad(), valueP(),
    ],
    build(p, ctx) {
      const n = Math.max(1, Math.round(p.n as number) || 8);
      const rows = Math.max(1, Math.round(p.rows as number) || 1);
      const el = rowFootprint({
        n, rows,
        pitch: p.pitch as number,
        pitchY: rows > 1 ? (p.pitchY as number) : (p.pitch as number),
        padSize: p.padSize as number,
        drill: p.drill as number,
        socket: p.socket as boolean,
        labels: p.labels as number,
        bodyW: p.bodyW as number, bodyH: p.bodyH as number,
        silk: p.silk as boolean,
        layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
        holes: (p.holes as number) > 0 ? { n: p.holes as number, d: p.holeD as number, pad: p.holePad as number } : undefined,
        firstSquare: true,
      });
      const w = (n - 1) * (p.pitch as number) + (p.padSize as number);
      const h = (rows - 1) * (rows > 1 ? (p.pitchY as number) : (p.pitch as number)) + (p.padSize as number);
      return {
        els: el.els,
        spec: { ...el.spec, w: r3(w), h: r3(h) },
        title: `${p.socket ? 'Гнездо' : 'Штыри'} ${rows > 1 ? `${rows}×${n}` : `1×${n}`} · ${r3(p.pitch as number)} мм`,
      };
    },
  },
  {
    id: 'klem',
    title: 'Винтовой клеммник',
    hint: 'Клеммники с шагом 3.5 / 3.81 / 5.0 / 5.08 мм: площадки, корпус, номера над выводами.',
    aliases: ['клеммник', 'клемма', 'klem', 'terminal', 'винтовой', 'phenix', 'фенекс'],
    bare: ['n', 'pitch', 'padSize'],
    params: [
      P_INT('n', 'Контактов', 2, { min: 1, max: 24, words: ['контактов', 'выводов', 'клемм', 'полюсов'], token: 'контактов' }),
      pitch(5.08), padSize(2.6), drill(1.3), bodyH(10), labelsEvery(1), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const n = Math.max(1, Math.round(p.n as number) || 2);
      const el = terminalFootprint({
        n, pitch: p.pitch as number, padSize: p.padSize as number, drill: p.drill as number,
        bodyH: p.bodyH as number, labels: p.labels as number, layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
      });
      return {
        els: el.els,
        spec: { ...el.spec, w: r3(n * (p.pitch as number)), h: r3((p.bodyH as number) + (p.padSize as number)) },
        title: `Клеммник ${n}×${r3(p.pitch as number)}`,
      };
    },
  },
  {
    id: 'tact',
    title: 'Кнопка / тактовая кнопка',
    hint: 'Четыре вывода по углам и корпус 6×6 (или другой размер); круглый корпус — для «шайбы».',
    aliases: ['кнопка', 'tact', 'тактовик', 'button', 'knopka'],
    weak: ['переключатель кнопочный'],
    bare: ['body', 'px', 'py'],
    params: [
      P_NUM('px', 'Между выводами, мм (X)', 6, { min: 1, max: 20, step: 0.1, words: ['между выводами'], token: null }),
      P_NUM('py', 'Между выводами, мм (Y)', 6, { min: 1, max: 20, step: 0.1, words: [], token: null }),
      P_NUM('body', 'Корпус, мм', 6, { min: 1, max: 24, step: 0.1, words: ['корпус', 'размер'], token: 'корпус' }),
      P_BOOL('round', 'Круглый корпус', false, { words: ['круглая', 'round'], token: 'круглая' }),
      padSize(1.6), drill(0.8), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const body = (p.body as number) || Math.max(p.px as number, p.py as number);
      const el = tactFootprint({
        px: p.px as number, py: p.py as number, body, bodyY: body,
        padSize: p.padSize as number, drill: p.drill as number,
        round: p.round as boolean, layer: ctxLayer(ctx),
      });
      return { els: el.els, spec: { ...el.spec, w: r3(body + 2), h: r3(body + 2) }, title: `Кнопка ${r3(body)}×${r3(body)}` };
    },
  },
  {
    id: 'pack',
    title: 'TO-92 / TO-126 / TO-220 / TO-247',
    hint: 'Три вывода в линию или треугольником, корпус с плоской гранью, «ухо» с отверстием под винт для мощных.',
    aliases: ['to-92', 'to92', 'to-126', 'to126', 'to-220', 'to220', 'to-247', 'to247', 'kren', 'крен', 'irf', 'bd135', 'kt814'],
    weak: ['транзистор', 'стабилизатор', 'тиристор', 'корпус to'],
    noNum: true,
    bare: ['pitch', 'bodyW'],
    params: [
      pitch(2.54),
      P_BOOL('triangle', 'Выводы треугольником', false, { words: ['треугольник', 'треугольником', 'to-92'], token: 'треугольником' }),
      bodyW(10.4), bodyH(15),
      P_BOOL('bolt', 'Отверстие под винт', false, { words: ['отверстие под винт', 'ухо', 'крепление'], token: 'крепление' }),
      holeDia(3.6), padSize(1.6), drill(0.9), labelsEvery(1), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const bolt = !!(p.bolt as boolean) || wordIs(ctx, /220|247|126/);
      const narrow = wordIs(ctx, /92/) || (!wordIs(ctx, /126|220|247/) && (p.bodyW as number) < 8);
      const el = packFootprint({
        pitch: p.pitch === ctx.defaults.pitch ? (narrow ? 1.27 : 2.54) : (p.pitch as number),
        triangle: p.triangle as boolean || narrow,
        bodyW: p.bodyW as number, bodyH: p.bodyH as number,
        holeD: bolt ? (p.holeD as number) : 0,
        holeY: (p.bodyH as number) / 2 + 1.5,
        padSize: p.padSize as number, drill: p.drill as number,
        layer: ctxLayer(ctx),
      });
      return {
        els: el.els, spec: el.spec,
        title: `${narrow ? 'TO-92' : 'TO-корпус'}${bolt ? ' · отверстие под винт' : ''}`,
      };
    },
  },
  {
    id: 'sot',
    title: 'SOT-23 / SOT-89 / SOT-223 / DPAK',
    hint: 'Мелкие планарные корпуса 2–8 выводов, теплоотвод — отдельной площадкой.',
    aliases: ['sot', 'sot-23', 'sot23', 'sot-89', 'sot89', 'sot-223', 'sot223', 'dpak', 'd2pak', 'sc-70', 'sc70', 'sot363', 'sot-363'],
    weak: ['ldo', 'транзистор smd'],
    noNum: true,
    bare: ['pins', 'pitch', 'rowX'],
    params: [
      P_INT('pins', 'Выводов', 3, { min: 2, max: 8, words: ['выводов', 'pins'], token: 'pins' }),
      pitch(0.95),
      P_NUM('rowX', 'Между центрами рядов, мм', 1.9, { min: 0.6, max: 8, step: 0.05, words: ['междурядье'], token: null }),
      P_NUM('padW', 'Площадка по Y, мм', 0.6, { min: 0.2, max: 3, step: 0.05, words: ['площадка'], token: 'площадка' }),
      P_NUM('padH', 'Площадка по X, мм', 1.2, { min: 0.2, max: 4, step: 0.05, words: ['длина площадки'], token: null }),
      bodyW(2.9), bodyH(2.4),
      P_NUM('tabW', 'Теплоотвод: ширина, мм', 0, { min: 0, max: 12, step: 0.1, words: ['теплоотвод'], token: 'теплоотвод' }),
      P_NUM('tabH', 'Теплоотвод: длина, мм', 0, { min: 0, max: 12, step: 0.1, words: [], token: null }),
      labelsEvery(1), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const wide = wordIs(ctx, /223|dpak|89/);
      const byName = wordIs(ctx, /363|sc-?70|sc70/) ? 6 : wordIs(ctx, /8$/) ? 8 : 3;
      const pins = p.pins === ctx.defaults.pins ? byName : (p.pins as number);
      const el = sotFootprint({
        pins, pitch: p.pitch as number,
        rowX: (p.rowX as number) || (wide ? 4.4 : 1.9),
        padW: p.padW as number, padH: p.padH as number,
        bodyW: (p.bodyW as number) || (wide ? 6.5 : 2.9),
        bodyH: (p.bodyH as number) || (wide ? 6.1 : 2.4),
        tabW: (p.tabW as number) || (wide ? 4.6 : undefined),
        tabH: (p.tabH as number) || (wide ? 3.4 : undefined),
        layer: ctxLayer(ctx), cu: ctx.cu,
      });
      const code = (ctx.word.toUpperCase().match(/(?:SOT|SC|DPAK|D2PAK)[ -]?\d*/) ?? [`${wide ? 'SOT-223' : 'SOT-23'}`])[0];
      return { els: el.els, spec: el.spec, title: code.replace(/^SOT(\d)/, 'SOT-$1') };
    },
  },
  {
    id: 'elco',
    title: 'Электролит / тантал (THT)',
    hint: 'Цилиндрический корпус Ø, шаг выводов, полярность «+»; для больших диаметров — крепёжное отверстие.',
    aliases: ['электролит', 'elco', 'алюминиевый', 'конденсатор электролитический', 'радиоконденсатор'],
    weak: ['конденсатор полярный'],
    bare: ['d', 'pitch', 'padSize'],
    params: [
      P_NUM('d', 'Диаметр корпуса, мм', 8, { min: 2, max: 30, step: 0.1, words: ['диаметр', 'корпус', 'ø'], token: 'корпус' }),
      pitch(3.5), padSize(1.8), drill(0.9),
      P_BOOL('hole', 'Крепёжное отверстие', false, { words: ['крепёжное', 'крепление'], token: 'крепление' }),
      holeDia(2.5), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = electroFootprint({
        d: p.d as number, pitch: p.pitch as number, padSize: p.padSize as number,
        drill: p.drill as number, hole: p.hole ? (p.holeD as number) : 0,
        layer: ctxLayer(ctx), value: (p.value as string) || undefined,
      });
      return { els: el.els, spec: el.spec, title: `Электролит Ø${r3(p.d as number)}` };
    },
  },
  {
    id: 'module',
    title: 'Модуль на гребёнках (Arduino, ESP, Pico…)',
    hint: 'Два ряда выводов с подписями, прямоугольник корпуса, размеры и крепёжные отверстия. Имена выводов правятся параметром «имена».',
    aliases: [
      'модуль', 'module', 'arduino', 'nano', 'pro mini', 'pico', 'esp32', 'esp8266',
      'nodemcu', 'd1 mini', 'esp-01', 'wroom', 'gpio', 'hat', 'rpi', 'raspberry',
      'devkit', 'stm32', 'blue pill',
    ],
    bare: ['n', 'rowW'],
    params: [
      P_INT('n', 'Выводов в ряду', 15, { min: 1, max: 40, words: ['выводов', 'пинов', 'pins'], token: 'выводов' }),
      pitch(2.54),
      P_NUM('rowW', 'Между центрами рядов, мм', 15.24, { min: 2.54, max: 60, step: 0.01, words: ['междурядье', 'ширина'], token: null }),
      bodyW(0), bodyH(0), socketP(), padSize(1.7), drill(0.9),
      holeCount(0), holeDia(3.2), holePad(0), silkOn(), valueP(),
      P_BOOL('dim', 'Подпись размеров', true, { words: ['размеры', 'dim'], token: 'размеры' }),
      ({ key: 'names', label: 'Имена выводов', kind: 'text', def: '', token: null, words: ['имена'], hint: 'левый ряд; правый — после «|»' } as ParamDef),
    ],
    build(p, ctx) {
      const n = Math.max(1, Math.round(p.n as number) || 15);
      const raw = String(p.names ?? '');
      const [ls, rs] = raw.split('|');
      const left = (ls ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const right = (rs ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      const el = moduleFootprint({
        n,
        left: left.length >= n ? left.slice(0, n) : undefined,
        right: right.length ? right.slice(0, n) : left.length >= 2 * n ? left.slice(n, 2 * n) : undefined,
        pitch: p.pitch as number,
        rowW: p.rowW as number,
        padSize: p.padSize as number, drill: p.drill as number,
        socket: p.socket as boolean,
        bodyW: p.bodyW as number || undefined, bodyH: p.bodyH as number || undefined,
        holes: (p.holes as number) > 0 ? { n: p.holes as number, d: p.holeD as number, pad: p.holePad as number } : undefined,
        dim: p.dim as boolean,
        title: (p.value as string) || undefined,
        layer: ctxLayer(ctx),
      });
      return {
        els: el.els, spec: el.spec,
        title: `${(p.value as string) || 'Модуль'} 2×${n}`,
      };
    },
  },
  {
    id: 'shield',
    title: 'Shield для Arduino Uno',
    hint: 'Разъёмы шилда: верхний и нижний ряды с именами сигналов, крепёжные отверстия и контур платы 68.58 × 53.34 мм.',
    aliases: ['shield', 'шилд', 'щит', 'uno shield', 'pro shield', 'расширение uno'],
    weak: ['arduino uno'],
    bare: ['padSize', 'holeD'],
    params: [
      P_NUM('w', 'Ширина платы, мм', 68.58, { min: 20, max: 200, step: 0.01, words: ['размер', 'ширина'], token: null }),
      P_NUM('h', 'Высота платы, мм', 53.34, { min: 10, max: 200, step: 0.01, words: ['высота'], token: null }),
      P_BOOL('holes', 'Крепёжные отверстия', true, { words: ['крепёжные', 'крепёж', 'отверстия'], token: 'крепёж' }),
      holeDia(3.2), padSize(1.8), drill(1.0),
      labelsEvery(1, ['подписи', 'имена']), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = shieldFootprint({
        w: p.w as number, h: p.h as number,
        holeD: p.holes ? (p.holeD as number) : 0,
        padSize: p.padSize as number, drill: p.drill as number,
        labels: (p.labels as number) !== 0, layer: ctxLayer(ctx),
        title: (p.value as string) || 'UNO SHIELD',
      });
      return {
        els: el.els, spec: el.spec, title: `Shield ${r3(p.w as number)}×${r3(p.h as number)}`,
        notes: ['Имена выводов — как у Arduino Uno R3; сверьтесь со своей платой.'],
      };
    },
  },
  {
    id: 'board',
    title: 'Плата / основание с крепежом',
    hint: 'Контур заданного размера, крепёжные отверстия по углам (голые или под стойку), метки совмещения, подпись размеров.',
    aliases: ['плата', 'board', 'основание', 'подложка', 'контур платы', 'plate', 'bracket', 'крышка', 'шасси'],
    bare: ['bw', 'bh'],
    params: [
      P_NUM('bw', 'Ширина, мм', 60, { min: 5, max: 500, step: 0.1, words: ['размер', 'ширина'], token: null }),
      P_NUM('bh', 'Высота, мм', 40, { min: 5, max: 500, step: 0.1, words: ['высота'], token: null }),
      holeCount(4), holeDia(3.2), holePad(0),
      P_NUM('inset', 'Отступ крепежа от края, мм', 3.5, { min: 1, max: 40, step: 0.1, words: ['отступ'], token: 'отступ' }),
      P_BOOL('ring', 'Поясок шелкографии вокруг отверстий', false, { words: ['поясок'], token: 'поясок' }),
      P_INT('fiducials', 'Метки совмещения', 0, { min: 0, max: 4, words: ['метки', 'fiducial'], token: 'метки' }),
      P_BOOL('outline', 'Контур платы', true, { words: ['контур', 'outline', 'рамка'], token: 'контур' }),
      P_BOOL('dim', 'Подпись размеров', true, { words: ['размеры', 'dim'], token: 'размеры' }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = boardFootprint({
        w: p.bw as number, h: p.bh as number,
        outline: p.outline as boolean && p.silk as boolean, holes: p.holes as number,
        holeD: p.holeD as number, holeInset: p.inset as number, holePad: p.holePad as number,
        holeRing: p.ring as boolean, fiducials: p.fiducials as number, dim: p.dim as boolean,
        title: (p.value as string) || undefined, layer: ctxLayer(ctx),
      });
      return { els: el.els, spec: el.spec, title: `Плата ${r3(p.bw as number)}×${r3(p.bh as number)}` };
    },
  },
  {
    id: 'hole',
    title: 'Крепёжное отверстие / стойка',
    hint: 'Отверстия под винт (M2…M4), несколько в ряд с шагом; кольцо меди — если отверстие под стойку.',
    aliases: ['крепёжное отверстие', 'крепёжный', 'mounting hole', 'mounting', 'стойка', 'standoff', 'отверстие под винт'],
    weak: ['отверстие', 'отверстия', 'дырка', 'дырки', 'крепёж', 'крепеж', 'hole'],
    bare: ['holeD', 'n', 'pitch'],
    params: [
      holeDia(3.2),
      P_INT('n', 'Сколько', 1, { min: 1, max: 40, words: ['шт', 'отверстий', 'сколько'], token: 'отверстия' }),
      P_NUM('pitch', 'Шаг между отверстиями, мм', 0, { min: 0, max: 500, step: 0.1, words: ['шаг'], token: 'шаг' }),
      holePad(),
      P_BOOL('ring', 'Поясок шелкографии', false, { words: ['поясок'], token: 'поясок' }),
      valueP(),
    ],
    build(p, ctx) {
      const el = holeFootprint({
        d: p.holeD as number, n: p.n as number, pitch: p.pitch as number,
        pad: p.holePad as number, ring: p.ring as boolean,
        label: (p.value as string) || undefined, layer: ctxLayer(ctx),
      });
      return {
        els: el.els, spec: el.spec,
        title: `Отверстие Ø${r3(p.holeD as number)}${(p.n as number) > 1 ? ` ×${p.n}` : ''}`,
      };
    },
  },
  {
    id: 'pad',
    title: 'Площадка / контрольная точка',
    hint: 'Одна или несколько площадок: тестпоинты, пяточки под перемычки, произвольный посадочный ряд.',
    aliases: ['площадка', 'pad', 'тестпоинт', 'testpoint', 'tp', 'пятак', 'пяточек'],
    weak: ['точка'],
    bare: ['padSize', 'pitch', 'n'],
    params: [
      padSize(1.7), drill(1.0),
      P_ENUM('shape', 'Форма', 'round', [['round', 'Круг'], ['square', 'Квадрат'], ['oct', 'Восьмиугольник']], { words: ['форма'] }),
      P_INT('n', 'Сколько', 1, { min: 1, max: 100, words: ['шт', 'сколько'], token: 'шт' }),
      P_NUM('pitch', 'Шаг, мм', 2.54, { min: 0.3, max: 40, step: 0.01, words: ['шаг'], token: 'шаг' }),
      P_BOOL('smd', 'Без отверстия (SMD)', false, { words: ['без отверстия', 'планарная'], token: 'smd' }),
      P_NUM('ring', 'Поясок шелкографии, мм', 0, { min: 0, max: 20, step: 0.1, words: ['поясок'], token: null }),
      valueP(),
    ],
    build(p, ctx) {
      const el = padFootprint({
        size: p.padSize as number, drill: p.smd ? 0 : (p.drill as number),
        shape: p.shape as 'round' | 'square' | 'oct', n: p.n as number, pitch: p.pitch as number,
        ring: (p.ring as number) || undefined, smd: p.smd as boolean,
        label: (p.value as string) || undefined, layer: ctxLayer(ctx), cu: ctx.cu,
      });
      return {
        els: el.els, spec: el.spec,
        title: `${p.smd ? 'SMD-площадка' : 'Площадка'} ${r3(p.padSize as number)}${p.smd ? '' : `/${r3(p.drill as number)}`}${(p.n as number) > 1 ? ` ×${p.n}` : ''}`,
      };
    },
  },
  {
    id: 'fiducial',
    title: 'Метка совмещения',
    hint: 'Медный кружок без отверстия + поясок шелкографии — оптическое позиционирование.',
    aliases: ['метка совмещения', 'fiducial', 'фидуциал'],
    bare: ['d'],
    params: [
      P_NUM('d', 'Ø площадки, мм', 1, { min: 0.3, max: 6, step: 0.05, words: ['диаметр', 'размер'], token: null }),
      P_NUM('ring', 'Ø пояска, мм', 0, { min: 0, max: 12, step: 0.1, words: ['поясок'], token: null }),
    ],
    build(p, ctx) {
      const el = fiducialFootprint({ d: p.d as number, ring: (p.ring as number) || undefined, layer: ctxLayer(ctx) });
      return { els: el.els, spec: el.spec, title: `Метка Ø${r3(p.d as number)}` };
    },
  },
  {
    id: 'crystal',
    title: 'Кварц / резонатор',
    hint: 'HC-49S (2 вывода через 4.88 мм) или SMD-корпус 3225/5032 на 2 или 4 площадки.',
    aliases: ['кварц', 'crystal', 'резонатор', 'резонатор 3 вывода', 'oscillator', 'osc', 'hc-49', 'hc49', '3225', '5032'],
    bare: ['pitch', 'bodyW'],
    params: [
      P_BOOL('smd', 'SMD-корпус', false, { words: ['smd', 'планарный'], token: 'smd' }),
      P_NUM('pitch', 'Между выводами, мм', 4.88, { min: 1, max: 20, step: 0.01, words: ['шаг', 'между'], token: null }),
      bodyW(3.2), bodyH(2.5),
      P_INT('pads', 'Площадок (SMD)', 4, { min: 2, max: 4, step: 2, words: ['площадок', 'выводов'], token: null }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = crystalFootprint({
        smd: p.smd as boolean, pitch: p.pitch as number, bodyL: p.bodyW as number,
        bodyW: p.bodyH as number, pads: p.pads as number, layer: ctxLayer(ctx),
        title: (p.value as string) || undefined,
      });
      return {
        els: el.els, spec: el.spec,
        title: p.smd ? `Кварц SMD ${r3(p.bodyW as number)}×${r3(p.bodyH as number)}` : 'Кварц HC-49S',
      };
    },
  },
  {
    id: 'relay',
    title: 'Реле',
    hint: '4/5 выводов (катушка и группа контактов), корпус, подписи A/K/COM/NO/NC.',
    aliases: ['реле', 'relay', 'srda', 'srD', 'hk4100', 'jrc-23f'],
    bare: ['pins', 'pitch'],
    params: [
      P_INT('pins', 'Выводов', 5, { min: 2, max: 8, words: ['выводов', 'pins'], token: 'pins' }),
      pitch(5), bodyW(0), bodyH(0), padSize(2.2), drill(1.1),
      P_BOOL('names', 'Имена выводов', true, { words: ['имена'], token: null }),
      silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = relayFootprint({
        pins: p.pins as number, pitch: p.pitch as number,
        bodyW: (p.bodyW as number) || undefined, bodyH: (p.bodyH as number) || undefined,
        padSize: p.padSize as number, drill: p.drill as number,
        names: p.names ? undefined : Array.from({ length: p.pins as number }, (_, i) => String(i + 1)),
        layer: ctxLayer(ctx),
      });
      return { els: el.els, spec: el.spec, title: `Реле ${p.pins} выв.` };
    },
  },
  {
    id: 'dipsw',
    title: 'DIP-переключатель',
    hint: 'N секций по два вывода, шаг 2.54, корпус-прямоугольник, номера секций.',
    aliases: ['dip switch', 'dipsw', 'переключатель', 'dip-key', 'тумблер dip'],
    bare: ['n', 'pitch'],
    params: [
      P_INT('n', 'Секций', 4, { min: 1, max: 24, words: ['секций', 'кнопок', 'выводов'], token: 'секций' }),
      pitch(2.54),
      P_NUM('rowW', 'Междурядье, мм', 7.62, { min: 3, max: 20, step: 0.01, words: ['междурядье'], token: null }),
      padSize(1.7), silkOn(), valueP(),
    ],
    build(p, ctx) {
      const el = dipSwitchFootprint({
        n: p.n as number, pitch: p.pitch as number, rowW: p.rowW as number,
        padSize: p.padSize as number, layer: ctxLayer(ctx),
      });
      return { els: el.els, spec: el.spec, title: `DIP-переключатель ${p.n}` };
    },
  },
];

const byId = (id: string): Family => FAMILIES.find((f) => f.id === id)!;

/** весь «вокабуляр» семейства — его слова не считаем проигнорированными */
const wordsOf = (f: Family): string[] => [...f.aliases, ...(f.weak ?? [])].map((a) => norm(a));

// ---------------------------------------------------------------- крепёж у ряда

/** Крепёжные отверстия с двух краёв уже построенной меди */
function mountOn(els: LibEl[], p: Params): { els: LibEl[]; extra: LibEl[]; n: number; note?: string[] } {
  const want = Math.round((p.holes as number) ?? 0);
  if (!want) return { els, extra: [], n: 0 };
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const e of els) {
    if (e.kind === 'pad' || e.kind === 'smd') {
      const hw = e.kind === 'pad' ? e.size / 2 : Math.max(e.w, e.h) / 2;
      x1 = Math.min(x1, e.x - hw); x2 = Math.max(x2, e.x + hw);
      y1 = Math.min(y1, e.y - hw); y2 = Math.max(y2, e.y + hw);
    }
  }
  if (x1 > x2) return { els, extra: [], n: 0, note: ['Крепить не к чему: меди в футпринте нет.'] };
  const d = (p.holeD as number) || 3.2;
  const pad = (p.holePad as number) || 0;
  const cy = (y1 + y2) / 2;
  const n = Math.max(1, Math.min(2, want));
  const out: LibEl[] = [];
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? x2 + d / 2 + 0.45 : (i === 0 ? x1 - d / 2 - 0.45 : x2 + d / 2 + 0.45);
    out.push(pad > 0
      ? { kind: 'pad', x, y: cy, drill: d, size: Math.max(pad, d + 0.6), shape: 'round' }
      : { kind: 'hole', x, y: cy, d });
  }
  return {
    els: [...els, ...out], extra: out, n,
    note: want > n ? [`У ряда выводов крепёж бывает только с двух краёв — сделано ${n}.`] : undefined,
  };
}

// ---------------------------------------------------------------- разбор → план

export interface GenResult {
  ok: boolean;
  query: string;
  family?: Family;
  params?: Params;
  els?: LibEl[];
  spec?: FpSpec;
  title?: string;
  notes: string[];
  used?: string[];
  ignored?: string[];
  error?: string;
  bl?: [number, number, number, number];
}

const aliasRe = (a: string): RegExp =>
  new RegExp(String.raw`(?:^|[^0-9a-zа-я])${esc(norm(a))}(?![0-9a-zа-я])`, 'i');

/** Выбор семейства: сначала пресеты модулей, затем самый длинный сильный алиас */
export function detectFamily(s: string): { fam: Family; preset?: Params; word: string } | null {
  const in_ = norm(s);
  const modKey = detectModule(in_);
  // «nano shield» / «pro mini щит» — это шилд ПОД модуль, а не сам модуль
  if (modKey && /shield|шилд|щит/.test(in_) && (modKey === 'nano' || modKey === 'pro_mini' || modKey === 'esp01')) {
    const m = MODULE_NAMES[modKey];
    return {
      fam: byId('shield'), word: 'shield',
      // габарит шилда — по корпусу модуля с запасом на дорожки
      preset: { value: `${m.title} SHIELD`, w: r3(m.bodyW + 3), h: r3(m.bodyH + 3) },
    };
  }
  if (modKey) {
    const m = MODULE_NAMES[modKey];
    return {
      fam: byId('module'), word: modKey,
      preset: {
        n: Math.max(m.left.length, m.right.length),
        rowW: m.rowW, bodyW: m.bodyW, bodyH: m.bodyH,
        holes: m.holes, holeD: m.holeD ?? 3.2, socket: !!m.socket,
        value: m.title, names: `${m.left.join(',')}|${m.right.join(',')}`,
      },
    };
  }
  // самое раннее слово важнее длинного: «dip 16 … панелька» → dip, а не row
  const score = (pick: (f: Family) => string[]): { fam: Family; len: number; pos: number; word: string } | null => {
    const rank = (len: number, pos: number): number => (pos === 0 ? 1000 : 0) + len * 2 - pos / 100;
    let best: { fam: Family; len: number; pos: number; word: string } | null = null;
    let bestRank = -Infinity;
    for (const f of FAMILIES) {
      for (const a of pick(f)) {
        const m = in_.match(aliasRe(a));
        if (!m) continue;
        const r = rank(a.length, m.index ?? 0);
        if (r > bestRank) {
          bestRank = r;
          best = { fam: f, len: a.length, pos: m.index ?? 0, word: a };
        }
      }
    }
    return best;
  };
  const strong = score((f) => f.aliases);
  if (strong) {
    // «arduino uno shield» — всё-таки шилд, а не модуль на гребёнках
    if (strong.fam.id === 'module' && /shield|шилд|щит/.test(in_)) return { fam: byId('shield'), word: 'shield' };
    return { fam: strong.fam, word: strong.word };
  }
  // склеенные формы: dip8, soic-16, qfn32, klem2, led5
  const glued = in_.match(/(?:^|[^a-zа-я0-9])([a-zа-я]{2,12})-?(\d{1,3})(?![0-9])/);
  if (glued) {
    const head = glued[1];
    for (const f of FAMILIES) {
      if (f.aliases.some((a) => norm(a).replace(/[^a-zа-я0-9]/g, '') === head)) {
        const v = parseInt(glued[2], 10);
        const preset: Params = {};
        if (f.params.some((d) => d.key === 'pins')) preset.pins = v;
        else if (f.params.some((d) => d.key === 'n')) preset.n = v;
        else if (f.params.some((d) => d.key === 'holeD')) preset.holeD = THREAD['m' + v] ?? v;
        return { fam: f, preset, word: glued[1] + glued[2] };
      }
    }
  }
  // обозначение на плате без слова о корпусе: «c1 100nf», «r7 10ком», «d3»
  const desig = in_.match(/(?:^|\s)(r|c|l|d|q|u|xp|cn)(\d{1,3})(?![0-9a-zа-я])/i);
  if (desig) return { fam: byId('two'), preset: { value: desig[0].trim().toUpperCase() }, word: desig[1] };
  // 4-значный код SMD без всякого слова: 0805, 1206, 1206диод…
  const code = in_.match(new RegExp(String.raw`(?:^|\D)(${Object.keys(CHIP_CODES).join('|')})`));
  if (code) return { fam: byId('chip'), preset: { code: code[1] }, word: code[1] };
  // слова-контекст: «12 выводов шаг 3.5», «плата 50 на 40», «2 отверстия m3»
  if (/^\s*(плата|board|основани|подложк|шасси|кроват)/.test(in_)) return { fam: byId('board'), word: 'плата' };
  if (/shield|шилд|щит/.test(in_)) return { fam: byId('shield'), word: 'shield' };
  if (/(греб|штыр|ряд|разем|разъём|connector|контакт|pin|idc|гнезд|панельк|колодк)/.test(in_)) {
    return { fam: byId('row'), word: 'разъем' };
  }
  const weak = score((f) => f.weak ?? []);
  if (weak) return { fam: weak.fam, word: weak.word };
  if (/(отверст|hole|крепёж|крепеж|стойк|дырк)/.test(in_)) return { fam: byId('hole'), word: 'отверстие' };
  if (/(площадк|testpoint|тестпоинт|пятак)/.test(in_)) return { fam: byId('pad'), word: 'площадка' };
  return null;
}

/** «12 выводов», «выводов=12», «на 8 контактов», «x4» */
function takeCount(sc2: Scan, params: Params, fam: Family, touched: Set<string>): void {
  const m = sc2.take(/(\d{1,3})\s*-?\s*(?:вывод|контакт|пин\b|pins?\b|ножек|секци|клемм|полюс|шт\b|контакта)/i)
    ?? sc2.take(/(?:выводов|контактов|пинов|pins|секций|клемм|полюсов)\s*[:=]?\s*(\d{1,3})/i);
  const mult = sc2.take(/(?:^|[^0-9a-zа-я])[x*]\s*(\d{1,3})(?![0-9])(?!=)/);
  const v = m ? parseInt(m[1], 10) : mult ? parseInt(mult[1], 10) : NaN;
  if (!isFinite(v) || v <= 0) return;
  const put = (k: string): void => { params[k] = v; touched.add(k); };
  if (fam.id === 'hole' || fam.id === 'pad' || fam.id === 'module') { if ('n' in params) put('n'); return; }
  if ('pins' in params) { put('pins'); return; }
  if ('n' in params) put('n');
}

/** Огоголенные числа: отдаются параметрам в порядке `fam.bare`, пока не кончатся */
function takeBareNumbers(sc2: Scan, params: Params, fam: Family, touched: Set<string>): void {
  const nums: number[] = [];
  for (;;) {
    const m = sc2.take(new RegExp(String.raw`(?:^|\s)(\d+(?:[.,]\d+)?)(?:(мм|mm|mil|мил|см|дюйм[а-яё0-9-]*)(?![0-9a-zа-я])|(?![0-9a-zа-я.,]))`));
    if (!m) break;
    nums.push(conv(m[1], m[2] ?? ''));
  }
  const order = typeof fam.bare === 'function' ? fam.bare(params) : fam.bare;
  for (const v of nums) {
    for (const key of order) {
      const def = fam.params.find((d) => d.key === key);
      if (!def) continue;
      if (touched.has(key)) continue;                           // уже задано словом/числом
      const num = r3(v);
      const min = def.min ?? -Infinity, max = def.max ?? Infinity;
      if (num < min || num > max) continue;
      params[key] = def.kind === 'int' ? Math.round(num) : num;
      break;
    }
  }
}

/** Основной вход: строка → геометрия + параметры + отчёт «что понято» */
export function generate(query: string): GenResult {
  const sc2 = new Scan(query);
  if (!sc2.s) {
    return { ok: false, query, notes: [], error: 'Пустое описание. Напишите, что нужно: «dip 8», «0805», «плата 60x40 4 отверстия m3».' };
  }
  const det = detectFamily(query);
  if (!det) {
    const sug = suggest(sc2.s);
    return {
      ok: false, query,
      error: 'Не распознано. Назовите тип: dip / soic / qfn / lqfp / код 0805 / ряд или разъём / клеммник / кнопка / реле / кварц / to-92…to-247 / sot / электролит / модуль (nano, pico, esp32) / плата / крепёжное отверстие / площадка.',
      notes: sug.length ? ['Похожее: ' + sug.join(', ')] : [],
    };
  }
  const fam = det.fam;
  const params: Params = {};
  const defaults: Params = {};
  const touched = new Set<string>();
  /** параметр именно назвали в строке (пресет/умолчание — не в счёт) */
  const said = new Set<string>();
  for (const d of fam.params) { params[d.key] = d.def; defaults[d.key] = d.def; }
  if (det.preset) for (const [k, v] of Object.entries(det.preset)) { params[k] = v; touched.add(k); }
  const set = (k: string, v: ParamVal): void => { params[k] = v; touched.add(k); said.add(k); };

  // сторона установки
  const bottom = sc2.take(/(?<![0-9a-zа-я])(низ|снизу|bottom|сторона пайки|k2)(?![0-9a-zа-я])/) !== null;
  if (!bottom) sc2.take(/(?<![0-9a-zа-я])(верх|сверху|top|k1)(?![0-9a-zа-я])/);
  const ctx: BuildCtx = { bottom, layer: bottom ? 's2' : 's1', cu: bottom ? 'k2' : 'k1', word: det.word, defaults };

  // мощность выводного резистора: «0.25 Вт», «1/4 Вт»
  if ('power' in params) {
    const pw = sc2.take(/(?:^|[^0-9a-zа-я.])(\d+(?:[.,]\d+)?)\s*(?:вт|w(?![0-9a-zа-я]))|(\d+)\s*\/\s*(\d+)\s*(?:вт|w)/i);
    if (pw) {
      const v = r3(pw[1] !== undefined && pw[1] !== '' ? toNum(pw[1]) : toNum(pw[2]) / toNum(pw[3]));
      set('power', v);
      const t = POWER_THT[String(v)];
      if (t) {
        if (!touched.has('pitch')) set('pitch', t.pitch);
        if ('bodyW' in params && !touched.has('bodyW')) set('bodyW', t.l);
        if ('bodyH' in params && !touched.has('bodyH')) set('bodyH', t.w);
      }
    }
  }
  // «площадка 1.8/0.8» — раньше остальных: иначе «8 площадка» прочтётся как размер
  const pair0 = takePadPair(sc2);
  // «1.8/0.8» без слова — только если это действительно площадка и сверло (а не дробь «1/4 Вт»)
  const canBare = !pair0 && 'padSize' in params && 'drill' in params
    && params.padSize === defaults.padSize && params.drill === defaults.drill;
  const bare0 = canBare ? takeBarePair(sc2) : null;
  const pair = pair0 ?? (bare0 && bare0[1] < bare0[0] && bare0[0] <= 12 && bare0[1] >= 0.2 ? bare0 : null);
  if (pair) {
    if ('padSize' in params) set('padSize', r3(pair[0]));
    if ('drill' in params) set('drill', r3(pair[1]));
  }
  // явные параметры семейства (ключ=значение, «шаг 1.27», «silk off», слова-флаги)
  for (const d of fam.params) {
    const v = takeKV(sc2, d);
    if (v !== undefined) set(d.key, clampP(d, v));
  }

  // «Ø8», «диаметр 8 мм»
  const dia = sc2.take(new RegExp(String.raw`(?:ø|диаметр|dia)\s*[:=]?\s*${NUMRE}\s*(?:мм|mm)?`, 'i'));
  if (dia) {
    const v = r3(toNum(dia[1]));
    if ('d' in params) set('d', v);
    else if ('bodyW' in params && 'bodyH' in params) { set('bodyW', v); set('bodyH', v); }
    else if ('body' in params) set('body', v);
    else if ('holeD' in params) set('holeD', v);
  }
  // «60x40», «2x40», «8x8»
  const dims = takePair(sc2, ['корпус', 'body', 'размер', 'плата', 'board', 'габарит', 'кнопка', 'кварц', 'сетка']);
  if (dims) {
    const a = r3(dims[0]), b = r3(dims[1]);
    if (fam.id === 'board') { set('bw', a); set('bh', b); }
    else if (fam.id === 'module') { set('bodyW', a); set('bodyH', b); }
    else if (fam.id === 'tact') { set('px', a); set('py', b); set('body', Math.max(a, b)); }
    else if (fam.id === 'qfn' || fam.id === 'qfp') { set('body', a); }
    else if (fam.id === 'crystal') { set('smd', true); set('bodyW', a); set('bodyH', b); }
    else if (fam.id === 'dip' && a <= 6) { set('rowW', b); }
    else if ((fam.id === 'row' || fam.id === 'pad') && a <= 8 && b > 1 && 'rows' in params) {
      set('rows', Math.round(a)); set('n', Math.round(b));
    } else if ('bodyW' in params) {
      set('bodyW', a);
      if ('bodyH' in params) set('bodyH', b);
      else if ('body' in params) set('body', Math.max(a, b));
    } else if ('n' in params && 'rows' in params) { set('rows', Math.round(a)); set('n', Math.round(b)); }
  }
  takeCount(sc2, params, fam, touched);
  // число сразу после названия семейства: «soic-16», «dip 8», «qfn 32»
  {
    const cntDef = fam.params.find((d) => d.key === 'pins') ?? fam.params.find((d) => d.key === 'n');
    if (cntDef && !fam.noNum && !touched.has(cntDef.key)) {
      const names = [det.word, ...fam.aliases].filter((x) => x.length > 1).map((x) => esc(norm(x))).join('|');
      const m = sc2.take(new RegExp(String.raw`(?:${names})\s*-?\s*${NUMRE}`, 'i'));
      if (m) set(cntDef.key, clampP(cntDef, parseInt(m[1], 10)));
    }
  }
  // резьба M2…M4
  const th = sc2.take(/\bm\s?(\d(?:[.,]\d)?)?(?![0-9a-z])/i);
  if (th) {
    const key = 'm' + (th[1] ? r3(toNum(th[1])) : '');
    if ('holeD' in params) set('holeD', THREAD[key] ?? r3(toNum(th[1] ?? '3')));
  }
  // «2 крепёжных отверстия», «крепёж», «без отверстий»
  const mnt = sc2.take(/(?:по\s+|с\s+)?(\d{1,2})?\s*(?:креп[её]жн[а-яё0-9-]*\s*(?:отверст[а-яё0-9-]*)?|креп[её]ж[а-яё0-9-]*|отверстий|отверстия|отверстие|mounting\s+holes?|mounts?)/i);
  if (mnt) {
    const k = mnt[1] ? parseInt(mnt[1], 10) : 0;
    if ('holes' in params) set('holes', k || (params.holes as number) || (fam.id === 'board' ? 4 : 2));
    else if (fam.id === 'hole' && 'n' in params && k) set('n', k);
  } else if (sc2.take(/без\s+(?:креп[её]жа|крепления|отверстий|отверстия)/i)) {
    if ('holes' in params) set('holes', 0);
    if ('bolt' in params) set('bolt', false);
  }
  // «широкий/узкий»
  const wide = sc2.take(/(?<![0-9a-zа-я])(широкий|wide|600\s*mil|300\s*mil)(?![0-9a-zа-я])/i);
  if (wide) {
    const w600 = /600|широк|wide/i.test(wide[0]);
    if (fam.id === 'dip' && 'rowW' in params) set('rowW', w600 ? 15.24 : 7.62);
    if (fam.id === 'soic' && 'rowX' in params) set('rowX', w600 ? 9.4 : 5.4);
  } else if (sc2.take(/(?<![0-9a-zа-я])(узкий|narrow)(?![0-9a-zа-я])/i)) {
    if (fam.id === 'dip' && 'rowW' in params) set('rowW', 7.62);
    if (fam.id === 'soic' && 'rowX' in params) set('rowX', 5.4);
  }
  // панелька/штыри, шелкография, подписи
  if (sc2.take(/(?<![0-9a-zа-я])(панелька|socket|гнездо|мама|female|розетк[а-яё0-9-]*)(?![0-9a-zа-я])/i) && 'socket' in params) set('socket', true);
  if (sc2.take(/(?<![0-9a-zа-я])(штыри|штырь|папа|male|pin\s+header)(?![0-9a-zа-я])/i) && 'socket' in params) set('socket', false);
  if (sc2.take(/(?<![0-9a-zа-я])(без\s+(?:шелкографии|корпуса|обводки)|no\s+silk)(?![0-9a-zа-я])/i) && 'silk' in params) set('silk', false);
  if (sc2.take(/(?<![0-9a-zа-я])(без\s+подписей|no\s+labels|без\s+нумерации)(?![0-9a-zа-я])/i)) {
    if ('labels' in params) set('labels', 0);
    if ('labelEvery' in params) set('labelEvery', 0);
    if ('names' in params) set('names', '');
  }
  const every = sc2.take(/подпис[а-яё0-9-]*\s+(?:кажд[а-яё0-9-]*\s+)?(\d{1,2})\s*-?й?/i);
  if (every) {
    const v = parseInt(every[1], 10);
    if ('labels' in params) set('labels', v);
    if ('labelEvery' in params) set('labelEvery', v);
  }
  if (sc2.take(/(?<![0-9a-zа-я])(все\s+подписи|подписать\s+все|каждый\s+вывод)(?![0-9a-zа-я])/i)) {
    if ('labels' in params) set('labels', 1);
    if ('labelEvery' in params) set('labelEvery', 1);
  }
  if (sc2.take(/(?<![0-9a-zа-я])подпис[а-яё0-9-]*(?![0-9a-zа-я])/i)) {
    if ('labels' in params && params.labels === 0) set('labels', 1);
    if ('labelEvery' in params && params.labelEvery === 0) set('labelEvery', 1);
    if ('dim' in params) set('dim', true);
  }
  // светодиоды ставят на типовой шаг 2.54, если его не просили иначе
  if (fam.id === 'two' && params.polarity === 'led' && !touched.has('pitch')) set('pitch', 2.54);
  // форма площадки
  if ('shape' in params) {
    if (sc2.take(/(?<![0-9a-zа-я])квадратн[а-яё0-9-]*(?![0-9a-zа-я])/i)) set('shape', 'square');
    else if (sc2.take(/(?<![0-9a-zа-я])(восьмиугольн[а-яё0-9-]*|oct)(?![0-9a-zа-я])/i)) set('shape', 'oct');
    else if (sc2.take(/(?<![0-9a-zа-я])кругл[а-яё0-9-]*(?![0-9a-zа-я])/i)) set('shape', 'round');
  }
  // SMD-код корпуса
  if (fam.id === 'chip') {
    const cm = sc2.take(new RegExp(String.raw`(?:^|[^0-9])(${Object.keys(CHIP_CODES).join('|')})(диод|резистор|конденсатор|конд[а-яё0-9-]*|sod[а-яё0-9-]*|sma|smb|smc)?`, 'i'));
    if (cm) {
      set('code', cm[1]);
      if (/диод|sod|sm[abc]/i.test(cm[2] ?? '')) set('diode', true);
    }
    if (sc2.take(/(?<![0-9a-zа-я])(diode|sod[- ]?\w+|sma|smb|smc)(?![0-9a-zа-я])/i)) set('diode', true);
  }
  if (fam.id === 'crystal') {
    const cm = sc2.take(/\b(3225|5032)\b/);
    if (cm) {
      set('smd', true);
      set('bodyW', parseInt(cm[1].slice(0, 2), 10) / 10);
      set('bodyH', parseInt(cm[1].slice(2), 10) / 10);
    }
  }
  // «nano shield»: слово модуля уже вошло в название — не считаем его мусором
  if (fam.id === 'shield') {
    const key = detectModule(sc2.s);
    if (key === 'nano' || key === 'pro_mini' || key === 'esp01') sc2.take(new RegExp(esc(key.replace('_', ' ')), 'i'));
  }
  // пресет модуля: имена выводов, корпус, крепёж
  if (fam.id === 'module') {
    const key = detectModule(sc2.s + ' ' + norm(query));
    if (key) {
      const m = MODULE_NAMES[key];
      set('n', Math.max(m.left.length, m.right.length));
      set('rowW', m.rowW); set('bodyW', m.bodyW); set('bodyH', m.bodyH);
      set('names', `${m.left.join(',')}|${m.right.join(',')}`);
      // крепёж из пресета — не «сказанный»: правило «назвали Ø → нужен крепёж» молчит
      params.holes = m.holes; params.holeD = m.holeD ?? 3.2;
      touched.add('holes'); touched.add('holeD');
      if (m.socket) set('socket', true);
      set('value', m.title);
      sc2.take(new RegExp(esc(key.replace('_', ' ')), 'i'));
    }
  }
  // голые числа: «44» в «lqfp 44» — добивают ещё не заданные параметры
  takeBareNumbers(sc2, params, fam, touched);
  // служебное слово семейства разобрано — в «проигнорировано» его быть не должно
  if (det.word.trim()) sc2.take(new RegExp(esc(norm(det.word)), 'i'));
  // номинал/подпись: «10ком», «100нф», «U1», "U74HC595"
  if ('value' in params) {
    const cur = String(params.value ?? '');
    // значение из пресета-обозначения («c1» → C1) не мешает найти настоящий номинал
    const onlyDesig = !cur || /^[a-z]{1,3}[0-9]{0,3}$/i.test(cur);
    const quoted = sc2.take(/"([^"]{1,14})"/);
    if (quoted) set('value', normValue(quoted[1]) || quoted[1]);
    else {
      const v = sc2.take(new RegExp(String.raw`(?:^|[^0-9a-zа-я.])(\d+(?:[.,]\d+)?)(ком|килоом|мком|гком|ом|ом[а-яё0-9-]*|нф|nf|мкф|uf|пф|pf|фарад[а-яё0-9-]*|мгн|нгн|в|вольт|v|мгц|mhz|ггц|ghz|k|m|ohm|r)(?![0-9a-zа-я])`, 'i'));
      if (v) {
        const nv = normValue(v[1] + (v[2] ?? ''));
        if (nv && onlyDesig) set('value', nv);
      } else {
        const nameTok = sc2.take(/(?<![0-9a-zа-я])([a-z]{1,3}\d{1,3})(?![0-9a-zа-я])/i);
        if (nameTok && !cur) set('value', nameTok[1].toUpperCase());
      }
    }
  }

  // Ø крепежа назвали, а количество — нет: крепёж всегда ставят минимум в двух местах
  if (said.has('holeD') && (params.holes ?? 0) === 0 && 'holes' in params) {
    set('holes', fam.id === 'board' ? 4 : 2);
  }

  let out: GenOut;
  try {
    out = fam.build(params, ctx);
  } catch (e) {
    return {
      ok: false, query, family: fam, params, notes: [],
      error: 'Не удалось построить футпринт: ' + (e instanceof Error ? e.message : 'ошибка'),
    };
  }
  const spec: FpSpec = { ...(out.spec ?? {}) };
  const hasCopper = out.els.some((e) => e.kind === 'pad' || e.kind === 'smd');
  const pitchMin = minCopperPitch(out.els);
  spec.pitch = hasCopper && (spec.pins ?? 0) + (spec.smd ?? 0) > 1 ? pitchMin : undefined;
  const notes: string[] = [...(out.notes ?? [])];
  if (params.socket) notes.push('Гнездо: площадки 1.8/1.0 мм под штырь 2.54 мм.');
  if (bottom) notes.push('Сторона — низ: шелкография на Ш2, планарные площадки на K2.');
  if (fam.id === 'module' && params.names) notes.push('Имена выводов — из даташита модуля; при сомнении правьте параметром «имена.»');
  if ('labels' in params && params.labels !== 0 && (spec.labels ?? 0) === 0) {
    notes.push('Подписей нет: шаг слишком мелкий или включён режим «без подписей».');
  }
  return {
    ok: true, query, family: fam, params,
    els: out.els, spec, title: out.title ?? fam.title,
    notes, used: sc2.used,
    ignored: sc2.rest().filter((w) => !wordsOf(fam).some((a) => a.includes(w) || w.includes(a))),
    bl: bboxOf(out.els),
  };
}

/** Простой bbox по элементам (рамка предпросмотра и габарит компонента) */
/** Габарит сгенерированных примитивов (см. footprint.bboxOf) */
export const bboxOf = fpBBox;

/** Подсказки при нераспознанной строке */
export function suggest(s: string): string[] {
  const out = new Set<string>();
  const words = norm(s).split(/[^a-zа-я0-9]+/).filter((w) => w.length > 2);
  for (const f of FAMILIES) {
    for (const a of [...f.aliases, ...(f.weak ?? [])]) {
      if (a.length < 3) continue;
      if (words.some((w) => a.startsWith(w.slice(0, 3)) || w.startsWith(a.slice(0, 3)))) out.add(a);
    }
  }
  return [...out].slice(0, 6);
}

/**
 * Переписать параметр в строку — панель параметров правит запрос, поэтому
 * пользователь всегда видит, что именно понято («silk off», «шаг=1.27»).
 */
/** родительный падеж для «без …» (шелкография → шелкографии) */
const genitive = (w: string): string => {
  if (/ия$/.test(w)) return `${w.slice(0, -2)}ии`;
  if (/ые$/.test(w)) return `${w.slice(0, -2)}ых`;
  if (/ие$/.test(w)) return `${w.slice(0, -2)}ия`;
  if (/(?:её|е|и|ы|у|ю|а|я)$/.test(w) && /[а-яё]$/i.test(w)) {
    if (/а$/.test(w)) return `${w.slice(0, -1)}ы`;
    if (/я$/.test(w)) return `${w.slice(0, -1)}и`;
    if (/е$/.test(w)) return `${w.slice(0, -1)}я`;
  }
  return w;
};

export function setParamInQuery(query: string, fam: Family, key: string, v: ParamVal): string {
  const def = fam.params.find((d) => d.key === key);
  const token = def?.token ?? key;
  const text = typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
  const keys = [key, token, ...(def?.words ?? [])].filter((k) => k && k.length > 1);
  for (const k of keys) {
    const re = new RegExp(String.raw`${esc(norm(k))}\s*[:=]\s*(?:on|off|да|нет|вкл|выкл|-?\d+(?:[.,]\d+)?[a-zа-я]*)`, 'i');
    if (re.test(query)) return query.replace(re, `${k}=${text}`);
  }
  if (def?.kind === 'bool') {
    const word = (def?.words ?? []).find((w) => /[а-яё]/i.test(w)) ?? token;
    return v ? `${query.trim()} ${word}` : `${query.trim()} без ${genitive(word)}`;
  }
  if (def?.kind === 'text') return `${query.trim()} "${text}"`;
  if (def?.kind === 'enum') return v === def.def ? query : `${query.trim()} ${text}`;
  return `${query.trim()} ${token} ${text}`;
}

/** Строка «что понял генератор» для подписи под полем ввода */
export function describe(r: GenResult): string {
  if (!r.ok || !r.family || !r.params) return '';
  const bits: string[] = [r.family.title];
  const p = r.params;
  const put = (k: string, txt: string): void => { if (p[k] !== undefined && p[k] !== '' && p[k] !== 0) bits.push(txt); };
  put('pins', `${p.pins} выв.`);
  put('n', `${p.n} выв.`);
  put('rows', `${p.rows} ряд(а)`);
  put('pitch', `шаг ${p.pitch} мм`);
  put('rowW', `ряд ${p.rowW} мм`);
  if (p.drill) bits.push(`площадка ${p.padSize}/${p.drill} мм`);
  if (p.holes) bits.push(`крепёж ${p.holes} × Ø${p.holeD}`);
  if (p.value) bits.push(`подпись «${p.value}»`);
  if (p.socket) bits.push('гнездо');
  if (p.silk === false) bits.push('без шелкографии');
  if (p.labels === 0) bits.push('без подписей');
  return bits.join(' · ');
}

// ---------------------------------------------------------------- примеры/справка

export const EXAMPLES: { query: string; note: string }[] = [
  { query: 'dip 8', note: 'DIP-8, междурядье 7.62 мм' },
  { query: 'dip 16 широкий, панелька', note: 'панелька 600 mil' },
  { query: 'soic 8 шаг 1.27', note: 'планарный, 8 выводов' },
  { query: 'tssop 20 шаг 0.65', note: 'мелкий шаг, узкий корпус' },
  { query: 'lqfp 44 10x10 шаг 0.8', note: 'выводы на 4 стороны' },
  { query: 'qfn 32 5x5 шаг 0.5', note: 'с тепловой площадкой' },
  { query: '0805', note: 'SMD-резистор 0805' },
  { query: '1206диод', note: 'SMD-диод с меткой катода' },
  { query: 'резистор 0.25 Вт, 10ком', note: 'номинал подпишем на корпусе' },
  { query: 'светодиод 5 мм', note: 'Ø5, метки A/K' },
  { query: 'конденсатор 100нф шаг 5.08', note: 'корпус под выводной КМ' },
  { query: 'электролит 10 мм шаг 5', note: 'Ø10, полярность' },
  { query: 'разъем 2x5 шаг 2.54, 2 крепёжных отверстия m3', note: 'колодка с крепежом' },
  { query: 'гребенка 40 шаг 2.54', note: 'штыри 1×40, номера выводов' },
  { query: 'клеммник 3 контакта 5.08', note: 'винтовой клеммник' },
  { query: 'кнопка 6x6', note: 'тактовая, 4 вывода' },
  { query: 'to-220, отверстие под винт', note: '3 вывода + крепёж' },
  { query: 'sot-23', note: '3 планарных вывода' },
  { query: 'arduino nano', note: '2×15 с именами выводов' },
  { query: 'esp32 devkit', note: '2×19, крепёж, габарит' },
  { query: 'плата 60x40, 4 отверстия m3, отступ 3.5', note: 'контур + крепёж' },
  { query: 'крепёжное отверстие m3 x4 шаг 20', note: '4 отверстия в ряд' },
  { query: 'тестпоинт 1.8/1.0', note: 'контрольная точка' },
  { query: 'кварц 3225', note: 'SMD 3.2×2.5, 4 площадки' },
  { query: 'реле 5 выводов', note: 'A/K/COM/NO/NC' },
  { query: 'dip switch 8', note: 'переключатель, 8 секций' },
];

/** Справка «что можно писать» — для кнопки со списком примеров */
export const FAMILY_HELP: { id: string; title: string; hint: string; words: string; example: string }[] =
  FAMILIES.map((f) => ({
    id: f.id, title: f.title, hint: f.hint,
    words: [...f.aliases, ...(f.weak ?? [])].slice(0, 8).join(', '),
    example: EXAMPLES.find((e) => detectFamily(e.query)?.fam.id === f.id)?.query ?? f.aliases[0],
  }));
