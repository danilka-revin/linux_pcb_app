// ИИ-режим помощника: языковая модель как агент поверх команд CopilotCmd.
//
// Локальный разбор (copilot.ts) остаётся основным офлайн-движком; этот модуль
// добавляет «умный» режим: пользователь подключает DeepSeek или любой
// OpenAI-совместимый API (OpenAI, OpenRouter, локальная Ollama), модель читает
// сводку о плате и отвечает строгим JSON со списком команд, которые выполняются
// тем же исполнителем. Ключ хранится только в localStorage и никогда не
// попадает в экспорт настроек.
//
// Сеть — только здесь: тесты подменяют globalThis.fetch (см. test/ai-agent.ts).

import type { Comp, Doc, Pt } from './model';
import { compPads, type CopilotAnchor, type CopilotCmd, type CopilotPick, type CopilotTarget } from './copilot';

// ------------------------------------------------------------ провайдеры

export interface AiPreset {
  id: string;
  title: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hint: string;
}

// Адреса указаны ТАК, как их ждёт провайдер: почти всем нужен хвост /v1 —
// без него OpenAI-совместимый шлюз отвечает 404 на /chat/completions.
// Имена моделей — действующие на момент правки (устаревшие дают ту же 404).
export const AI_PRESETS: AiPreset[] = [
  {
    id: 'deepseek',
    title: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    needsKey: true,
    hint: 'Ключ — на platform.deepseek.com (раздел API keys). Недорого и хорошо понимает русский. Старое имя модели deepseek-chat провайдер отключил 24.07.2026 — теперь нужно deepseek-v4-flash (или deepseek-v4-pro).',
  },
  {
    id: 'teamorouter',
    title: 'TeamoRouter (бесплатно)',
    baseUrl: 'https://api.teamorouter.com/v1',
    model: 'deepseek-v4-flash-free',
    needsKey: true,
    hint: 'Бесплатно: 200 запросов в день на модель. Ключ tr-… — на teamorouter.com (вход через Google → API Keys). Адрес обязательно с /v1, иначе 404. Умная модель — deepseek-v4-pro-free.',
  },
  {
    id: 'openai',
    title: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    hint: 'Ключ — на platform.openai.com. В адресе обязателен /v1: https://api.openai.com/v1 (без него — 404). Список моделей — platform.openai.com/docs/models.',
  },
  {
    id: 'openrouter',
    title: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash',
    needsKey: true,
    hint: 'Единый ключ для сотен моделей — на openrouter.ai/keys. Адрес — https://openrouter.ai/api/v1 (без /v1 будет 404). Точное имя модели копируй из каталога openrouter.ai/models; бесплатные заканчиваются на :free.',
  },
  {
    id: 'nararouter',
    title: 'NaraRouter (запасной, бесплатно)',
    baseUrl: 'https://router.bynara.id/v1',
    model: 'deepseek-v4-pro',
    needsKey: true,
    hint: 'Запасной бесплатный шлюз: ключ sk-nry-… — на router.bynara.id (вход через Google, нужна привязка Telegram). Пригодится, когда на TeamoRouter кончился дневной лимит.',
  },
  {
    id: 'ollama',
    title: 'Ollama (свой компьютер)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1:8b',
    needsKey: false,
    hint: 'Бесплатно и приватно: поставь Ollama, скачай модель («ollama pull llama3.1:8b»), укажи её имя. Если браузер ругается на сеть — запусти Ollama с OLLAMA_ORIGINS=*',
  },
  {
    id: 'custom',
    title: 'Свой адрес (OpenAI API)',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: 'Любой сервер с методом POST /chat/completions: LM Studio, vLLM, корпоративный шлюз. Адрес пиши вместе со схемой (https://…) и, как правило, с хвостом /v1 — без него провайдер отвечает 404.',
  },
];

/** Шлюзы, которым в адресе нужен /v1: без него POST /chat/completions → 404. */
const V1_REQUIRED = [
  'https://api.openai.com',
  'https://openrouter.ai/api',
  'https://api.teamorouter.com',
  'https://router.bynara.id',
];

/** Имена моделей, которые провайдер уже отключил (запрос с ними → 404). */
const RETIRED_MODELS: Record<string, string> = {
  'deepseek-chat': 'deepseek-v4-flash',       // отключён DeepSeek 24.07.2026
  'deepseek-reasoner': 'deepseek-v4-flash',   // отключён DeepSeek 24.07.2026
};

/**
 * Привести адрес API к рабочему виду:
 * добавить схему, если её забыли (иначе браузер пойдёт на наш же сервер и получит 404),
 * добавить /v1 известным шлюзам, не дублировать /chat/completions.
 */
export function normalizeAiBaseUrl(raw: string): string {
  let url = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(url);
    url = (local ? 'http://' : 'https://') + url;
  }
  url = url.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(url)) return url;
  const lower = url.toLowerCase();
  if (V1_REQUIRED.some((b) => lower === b)) url += '/v1';
  return url;
}

/** Полный адрес запроса чата по базовому адресу провайдера. */
export function chatCompletionsUrl(baseUrl: string): string {
  const url = normalizeAiBaseUrl(baseUrl);
  if (!url) return '';
  return /\/chat\/completions$/i.test(url) ? url : `${url}/chat/completions`;
}

/** Действующее имя модели: устаревшие псевдонимы DeepSeek заменяем рабочими. */
export function resolveAiModel(model: string, baseUrl: string): string {
  const m = String(model ?? '').trim();
  const url = normalizeAiBaseUrl(baseUrl).toLowerCase();
  if (!url.includes('deepseek.com') && !url.includes('teamorouter.com') && !url.includes('bynara.id')) return m;
  return RETIRED_MODELS[m] ?? m;
}

export interface AISettings {
  enabled: boolean;
  presetId: string;
  /** переопределения: пусто — взять из пресета */
  baseUrl: string;
  model: string;
  apiKey: string;
}

const AI_KEY = 'psbees.ai';

export const DEFAULT_AI: AISettings = {
  enabled: false,
  presetId: 'deepseek',
  baseUrl: '',
  model: '',
  apiKey: '',
};

export function loadAiSettings(): AISettings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_AI };
    const raw = localStorage.getItem(AI_KEY);
    if (!raw) return { ...DEFAULT_AI };
    const s = JSON.parse(raw) as Partial<AISettings>;
    return {
      enabled: s.enabled === true,
      presetId: typeof s.presetId === 'string' ? s.presetId : 'deepseek',
      baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
      model: typeof s.model === 'string' ? s.model : '',
      apiKey: typeof s.apiKey === 'string' ? s.apiKey : '',
    };
  } catch {
    return { ...DEFAULT_AI };
  }
}

export function saveAiSettings(s: AISettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(AI_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface AiResolved {
  baseUrl: string;
  /** полный адрес POST-запроса (то, что реально уходит в сеть) */
  url: string;
  model: string;
  apiKey: string;
  needsKey: boolean;
}

export function resolveAi(s: AISettings): AiResolved {
  const preset = AI_PRESETS.find((p) => p.id === s.presetId) ?? AI_PRESETS[0];
  const baseUrl = normalizeAiBaseUrl(s.baseUrl.trim() || preset.baseUrl);
  const model = resolveAiModel(s.model.trim() || preset.model, baseUrl);
  return {
    baseUrl,
    url: chatCompletionsUrl(baseUrl),
    model,
    apiKey: s.apiKey.trim(),
    needsKey: preset.needsKey,
  };
}

/** ИИ-режим можно использовать: включён и всё нужное заполнено. */
export function aiReady(s: AISettings): boolean {
  if (!s.enabled) return false;
  const r = resolveAi(s);
  if (!r.baseUrl || !r.model) return false;
  if (r.needsKey && !r.apiKey) return false;
  return true;
}

// ------------------------------------------------------- сводка о плате

function refOf(c: Comp): string {
  return (c.ref ?? '').trim() || c.name;
}

export function summarizeBoard(
  doc: Doc,
  o: { center: Pt; selIds: string[]; lastIds: string[]; activeCu: 'k1' | 'k2'; trackW: number },
): string {
  const comps = doc.entities.filter((e): e is Comp => e.kind === 'comp');
  const byId = new Map(doc.entities.map((e) => [e.id, e]));
  const L: string[] = [];
  L.push(`Плата ${doc.w}×${doc.h} мм (X: 0 слева → ${doc.w} справа, Y: 0 снизу → ${doc.h} сверху).`);
  L.push(`Центр вида: (${r1(o.center.x)}, ${r1(o.center.y)}). Активный слой меди: ${o.activeCu.toUpperCase()}, ширина дорожек по умолчанию: ${o.trackW} мм.`);
  if (!comps.length) {
    L.push('Деталей на плате пока нет.');
  } else {
    const show = comps.slice(0, 40);
    L.push(`Детали (${comps.length}):`);
    for (const c of show) {
      const pins = compPads(c).length;
      L.push(`- ${refOf(c)} «${c.name}» в (${r1(c.x)}, ${r1(c.y)})${c.rot ? `, поворот ${c.rot}°` : ''}${c.side === 'bottom' ? ', снизу платы' : ''}, выводов: ${pins}`);
    }
    if (comps.length > show.length) L.push(`…и ещё ${comps.length - show.length}.`);
  }
  const nets = doc.nets ?? [];
  if (nets.length) {
    L.push(`Цепи (${nets.length}): ${nets.slice(0, 20).map((n) => `«${n.name}» (${n.pads.length} пад)`).join(', ')}${nets.length > 20 ? '…' : ''}.`);
  }
  const selNames = o.selIds.map((id) => byId.get(id)).filter((e) => e !== undefined).map((e) => (e.kind === 'comp' ? refOf(e) : e.kind));
  if (selNames.length) L.push(`Сейчас выделено: ${selNames.slice(0, 12).join(', ')}${selNames.length > 12 ? '…' : ''}.`);
  const lasts = o.lastIds.map((id) => byId.get(id)).filter((e): e is Comp => !!e && e.kind === 'comp');
  if (lasts.length) L.push(`Недавно поставлены помощником («их»): ${lasts.map(refOf).slice(0, 12).join(', ')}.`);
  return L.join('\n');
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------- промпт

const AI_SYSTEM = `Ты — агент в редакторе печатных плат PSBees. Пользователь просит по-русски что-то сделать с платой. Ты отвечаешь СТРОГО одним JSON-объектом без пояснений вне него:
{"commands": [...], "reply": "короткий ответ пользователю по-русски"}
Если просьба непонятна — верни {"commands": [], "reply": "уточняющий вопрос"}.

Команды (поле t обязательно):
- {"t":"place","what":"строка генератора","count":1,"arrangement":"single|row|col|grid|circle","step":5,"stepY":null,"cols":0,"rows":0,"radius":null,"anchor":{...},"rot":null,"side":null}
  what — в ИМЕНИТЕЛЬНОМ падеже: "dip 8", "резистор 0805", "светодиод 5мм", "разъем 2x5", "кнопка 6x6", "кварц 16мгц", "отверстие м3". Необязательные поля можно опускать.
- {"t":"via","viaSize":1.8,"viaDrill":0.8, ...те же поля раскладки, что у place...}
- {"t":"connect","pairs":[{"ref":"D1","pin":2},{"ref":"D2","pin":null}]|null,"picks":[{"t":"cathode","label":"катоды"}|{"t":"anode","label":"аноды"}|{"t":"pin","n":1,"label":"вывод 1"}]|[],"width":null,"layer":null}
  pairs — явная цепочка по обозначениям; picks — соединить одноимённые выводы недавно поставленных деталей (cathode=правый/квадратный пад, anode=левый); оба пустые — соединить детали ближайшими площадками. width/layer null = авто.
- {"t":"track","pts":[{"x":10,"y":20},{"x":30,"y":40}],"width":null,"layer":null}
- {"t":"text","text":"надпись","size":null,"anchor":{...},"bottom":false}
- {"t":"board","w":60,"h":40}
- {"t":"corners","d":3.2,"margin":3.5}
- {"t":"selectAll"} {"t":"clearSel"} {"t":"undo"} {"t":"fit"} {"t":"zoomIn"} {"t":"zoomOut"} {"t":"help"}
- {"t":"delete","target":{...}} {"t":"duplicate","target":{...}} {"t":"rotate","target":{...},"times":1} {"t":"mirror","target":{...},"axis":"v"} {"t":"move","target":{...},"dx":2,"dy":0}

Якорь anchor (центр группы):
{"t":"view"} — центр вида (по умолчанию), {"t":"center"} — центр платы, {"t":"point","x":N,"y":N},
{"t":"corner","h":"l|c|r","v":"t|m|b","margin":5}, {"t":"near","ref":"D1","dir":"l|r|t|b","gap":3}.
Цель target: {"t":"sel"} выделенное, {"t":"last"} недавно поставленное, {"t":"any"} выделенное или недавнее, {"t":"all"} всё, {"t":"ref","ref":"D1"}.

Правила: координаты строго внутри платы; count 1..200; для grid укажи rows и cols; не больше 6 команд за раз; сложные просьбы разбивай на понятные шаги; reply — 1-2 предложения, без JSON.`;

export interface AiMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ------------------------------------------------- разбор ответа модели

const KNOWN_T = new Set([
  'place', 'via', 'connect', 'track', 'text', 'board', 'corners',
  'selectAll', 'clearSel', 'delete', 'duplicate', 'rotate', 'mirror', 'move',
  'undo', 'fit', 'zoomIn', 'zoomOut', 'help',
]);

const isNum = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanAnchor(a: unknown): CopilotAnchor | null {
  if (!isObj(a) || typeof a.t !== 'string') return null;
  switch (a.t) {
    case 'view':
    case 'center':
      return { t: a.t };
    case 'point':
      return isNum(a.x) && isNum(a.y) ? { t: 'point', x: a.x, y: a.y } : null;
    case 'corner':
      return (a.h === 'l' || a.h === 'c' || a.h === 'r') && (a.v === 't' || a.v === 'm' || a.v === 'b')
        ? { t: 'corner', h: a.h, v: a.v, margin: isNum(a.margin) ? a.margin : 5 }
        : null;
    case 'near':
      return typeof a.ref === 'string' && a.ref && (a.dir === 'l' || a.dir === 'r' || a.dir === 't' || a.dir === 'b')
        ? { t: 'near', ref: a.ref.toLocaleUpperCase(), dir: a.dir, gap: isNum(a.gap) ? a.gap : 3 }
        : null;
    default:
      return null;
  }
}

function cleanLayout(c: Record<string, unknown>): {
  count: number; arrangement: 'single' | 'row' | 'col' | 'grid' | 'circle';
  step: number | null; stepY: number | null; cols: number; rows: number;
  radius: number | null; anchor: CopilotAnchor;
  rot: number | null; side: 'top' | 'bottom' | null;
} | null {
  const count = isNum(c.count) ? Math.round(c.count) : 1;
  if (count < 1 || count > 200) return null;
  const arrangement = c.arrangement === 'row' || c.arrangement === 'col' || c.arrangement === 'grid' || c.arrangement === 'circle'
    ? c.arrangement
    : count > 1 ? 'row' : 'single';
  const step = isNum(c.step) && c.step > 0 ? c.step : null;
  const stepY = isNum(c.stepY) && c.stepY > 0 ? c.stepY : null;
  const cols = isNum(c.cols) ? Math.max(0, Math.min(50, Math.round(c.cols))) : 0;
  const rows = isNum(c.rows) ? Math.max(0, Math.min(50, Math.round(c.rows))) : 0;
  if (arrangement === 'grid' && !(cols > 0 && rows > 0)) return null;
  const radius = isNum(c.radius) && c.radius > 0 ? c.radius : null;
  const anchor = c.anchor === undefined ? { t: 'view' as const } : cleanAnchor(c.anchor);
  if (!anchor) return null;
  const rot = isNum(c.rot) ? ((Math.round(c.rot) % 360) + 360) % 360 : null;
  const side = c.side === 'bottom' ? 'bottom' : c.side === 'top' ? 'top' : null;
  return { count, arrangement, step, stepY, cols, rows, radius, anchor, rot, side };
}

function cleanTarget(t: unknown): CopilotTarget | null {
  if (!isObj(t) || typeof t.t !== 'string') return null;
  if (t.t === 'sel' || t.t === 'last' || t.t === 'any' || t.t === 'all') return { t: t.t };
  if (t.t === 'ref' && typeof t.ref === 'string' && t.ref) return { t: 'ref', ref: t.ref.toLocaleUpperCase() };
  return null;
}

const cleanWidth = (v: unknown): number | null => (isNum(v) && v >= 0.05 && v <= 20 ? v : null);
const cleanLayer = (v: unknown): 'k1' | 'k2' | null => (v === 'k1' || v === 'k2' ? v : null);

function cleanCommand(raw: unknown): CopilotCmd | null {
  if (!isObj(raw) || typeof raw.t !== 'string' || !KNOWN_T.has(raw.t)) return null;
  switch (raw.t) {
    case 'place': {
      if (typeof raw.what !== 'string' || !raw.what.trim()) return null;
      const l = cleanLayout(raw);
      return l ? { t: 'place', what: raw.what.trim().slice(0, 160), ...l } : null;
    }
    case 'via': {
      const l = cleanLayout(raw);
      if (!l) return null;
      const size = isNum(raw.viaSize) ? raw.viaSize : 1.8;
      const drill = isNum(raw.viaDrill) ? raw.viaDrill : 0.8;
      if (!(size >= 0.4 && size <= 10 && drill >= 0.1 && drill < size)) return null;
      return { t: 'via', viaSize: size, viaDrill: drill, ...l };
    }
    case 'connect': {
      let pairs: { ref: string; pin: number | null }[] | null = null;
      if (raw.pairs !== undefined && raw.pairs !== null) {
        if (!Array.isArray(raw.pairs) || raw.pairs.length < 2 || raw.pairs.length > 8) return null;
        pairs = [];
        for (const p of raw.pairs) {
          if (!isObj(p) || typeof p.ref !== 'string' || !p.ref) return null;
          const pin = p.pin === null || p.pin === undefined ? null : isNum(p.pin) ? Math.round(p.pin) : NaN;
          if (pin !== null && !(pin >= 1 && pin <= 64)) return null;
          pairs.push({ ref: p.ref.toLocaleUpperCase().slice(0, 12), pin });
        }
      }
      const picks: CopilotPick[] = [];
      if (Array.isArray(raw.picks)) {
        for (const p of raw.picks.slice(0, 4)) {
          if (!isObj(p)) return null;
          if (p.t === 'cathode' || p.t === 'anode') picks.push({ t: p.t, label: typeof p.label === 'string' ? p.label.slice(0, 24) : p.t });
          else if (p.t === 'pin' && isNum(p.n) && p.n >= -1 && p.n <= 64) {
            picks.push({ t: 'pin', n: Math.round(p.n), label: typeof p.label === 'string' ? p.label.slice(0, 24) : `вывод ${p.n}` });
          } else return null;
        }
      }
      return { t: 'connect', pairs, picks, width: cleanWidth(raw.width), layer: cleanLayer(raw.layer) };
    }
    case 'track': {
      if (!Array.isArray(raw.pts) || raw.pts.length < 2 || raw.pts.length > 64) return null;
      const pts: Pt[] = [];
      for (const p of raw.pts) {
        if (!isObj(p) || !isNum(p.x) || !isNum(p.y)) return null;
        pts.push({ x: p.x, y: p.y });
      }
      return { t: 'track', pts, width: cleanWidth(raw.width), layer: cleanLayer(raw.layer) };
    }
    case 'text': {
      if (typeof raw.text !== 'string' || !raw.text.trim()) return null;
      const anchor = raw.anchor === undefined ? { t: 'view' as const } : cleanAnchor(raw.anchor);
      if (!anchor) return null;
      const size = isNum(raw.size) && raw.size >= 0.5 && raw.size <= 50 ? raw.size : null;
      return { t: 'text', text: raw.text.trim().slice(0, 120), size, anchor, bottom: raw.bottom === true };
    }
    case 'board':
      return isNum(raw.w) && isNum(raw.h) && raw.w >= 5 && raw.w <= 1000 && raw.h >= 5 && raw.h <= 1000
        ? { t: 'board', w: raw.w, h: raw.h }
        : null;
    case 'corners': {
      const d = isNum(raw.d) ? raw.d : 3.2;
      const margin = isNum(raw.margin) ? raw.margin : 3.5;
      return d >= 0.5 && d <= 20 && margin >= 0 && margin <= 100 ? { t: 'corners', d, margin } : null;
    }
    case 'selectAll':
    case 'clearSel':
    case 'undo':
    case 'fit':
    case 'zoomIn':
    case 'zoomOut':
    case 'help':
      return { t: raw.t };
    case 'delete':
    case 'duplicate': {
      const target = cleanTarget(raw.target);
      return target ? { t: raw.t, target } : null;
    }
    case 'rotate': {
      const target = cleanTarget(raw.target);
      const times = isNum(raw.times) ? Math.round(raw.times) : 1;
      return target && times >= 1 && times <= 4 ? { t: 'rotate', target, times } : null;
    }
    case 'mirror': {
      const target = cleanTarget(raw.target);
      return target && (raw.axis === 'h' || raw.axis === 'v' || raw.axis === undefined)
        ? { t: 'mirror', target, axis: raw.axis === 'h' ? 'h' : 'v' }
        : null;
    }
    case 'move': {
      const target = cleanTarget(raw.target);
      return target && isNum(raw.dx) && isNum(raw.dy) && Math.abs(raw.dx) <= 500 && Math.abs(raw.dy) <= 500
        ? { t: 'move', target, dx: raw.dx, dy: raw.dy }
        : null;
    }
    default:
      return null;
  }
}

/** Извлечь JSON из ответа модели (кодовый блок или сырой объект). */
export function parseAiResponse(text: string): { commands: CopilotCmd[]; reply: string } | null {
  const src = String(text ?? '');
  const fence = src.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1] : src).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!isObj(obj)) return null;
  const commands: CopilotCmd[] = [];
  if (Array.isArray(obj.commands)) {
    for (const c of obj.commands.slice(0, 8)) {
      const clean = cleanCommand(c);
      if (clean) commands.push(clean);
    }
  } else if (obj.commands !== undefined) {
    return null;
  }
  const reply = typeof obj.reply === 'string' ? obj.reply.trim().slice(0, 2000) : '';
  if (!commands.length && !reply) return null;
  return { commands, reply };
}

// --------------------------------------------------------------- сеть

export class AiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiError';
  }
}

export async function chatOnce(
  s: AISettings,
  messages: AiMsg[],
  opts?: { maxTokens?: number; timeoutMs?: number },
): Promise<string> {
  const r = resolveAi(s);
  if (!r.baseUrl) throw new AiError('Не задан адрес API — открой настройки ИИ (шестерня → «ИИ-помощник»).');
  if (!r.model) throw new AiError('Не задана модель — открой настройки ИИ.');
  if (r.needsKey && !r.apiKey) throw new AiError('Нужен API-ключ — вставь его в настройках ИИ.');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
  if (r.baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = 'https://github.com/danilka-revin/linux_pcb_app';
    headers['X-Title'] = 'PSBees';
  }
  // куда и с какой моделью стучимся — пригодится в тексте ошибки
  const where = `${r.url} · модель «${r.model}»`;
  let response: Response;
  try {
    response = await fetch(r.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: r.model,
        messages,
        temperature: 0.2,
        max_tokens: opts?.maxTokens ?? 2000,
      }),
      signal: AbortSignal.timeout(opts?.timeoutMs ?? 60000),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new AiError('Модель думает слишком долго (больше минуты). Повтори запрос.');
    }
    throw new AiError(
      r.baseUrl.includes('localhost') || r.baseUrl.includes('127.0.0.1')
        ? `Не могу достучаться до локального сервера (${where}). Проверь, что Ollama запущена, а модель скачана.`
        : `Нет связи с API (${where}). Проверь интернет и адрес; если запрос из браузера блокирует провайдер — поставь локальную Ollama.`,
    );
  }
  // тело читаем текстом: у 404 от nginx/Cloudflare бывает HTML, а не JSON
  const text = typeof response.text === 'function' ? await response.text().catch(() => '') : '';
  type AiReply = {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    error?: { message?: string; code?: string; type?: string };
  };
  let data: AiReply | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') data = parsed as AiReply;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const detail = (data?.error?.message ?? data?.error?.code ?? '').slice(0, 220);
    const hint = detail ? ` ${detail}.` : '';
    if (response.status === 401 || response.status === 403) {
      throw new AiError(`API-ключ не подошёл (${response.status}).${hint} Проверь ключ в настройках ИИ.`);
    }
    if (response.status === 402 || response.status === 429) {
      throw new AiError(`Провайдер отклонил запрос (${response.status}): закончились деньги или превышен лимит.${hint}`);
    }
    if (response.status === 404) {
      throw new AiError(
        `Не найдено (404): ${where}.${hint} Причины: в адресе не хватает /v1 (например https://api.openai.com/v1, `
        + 'https://openrouter.ai/api/v1, https://api.teamorouter.com/v1) либо имя модели устарело/написано с опечаткой '
        + '(deepseek-chat отключён — нужно deepseek-v4-flash).',
      );
    }
    if (response.status === 400 || response.status === 422) {
      throw new AiError(`Провайдер не принял запрос (${response.status}): ${where}.${hint} Обычно это неверное имя модели или лишний параметр.`);
    }
    throw new AiError(`Ошибка API (HTTP ${response.status}): ${where}.${hint}`);
  }
  if (!data) throw new AiError(`Сервер вернул не JSON (${where}). Проверь, что адрес указывает на API, а не на сайт.`);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    // DeepSeek в режиме «размышлений» кладёт ответ в reasoning_content, а content оставляет пустым
    const thinking = data.choices?.[0]?.message?.reasoning_content;
    if (typeof thinking === 'string' && thinking.trim()) {
      throw new AiError('Модель вернула только свои рассуждения (thinking) и пустой ответ. Попроси короче или возьми модель без режима размышлений.');
    }
    throw new AiError('Модель вернула пустой ответ. Повтори запрос.');
  }
  return content;
}

/** Проверка связи из настроек: короткий запрос к модели. */
export async function testAiConnection(s: AISettings): Promise<string> {
  const out = await chatOnce(
    s,
    [
      { role: 'system', content: 'Ответь одним словом «ок» без знаков препинания.' },
      { role: 'user', content: 'Проверка связи.' },
    ],
    { maxTokens: 16, timeoutMs: 25000 },
  );
  return out.trim().slice(0, 120);
}

// ----------------------------------------------------------- агент-цикл

export interface AiTurn {
  reply: string;
  history: AiMsg[];
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) + '…' : s);

/**
 * Один ход агента: просьба + свежая сводка платы → команды → выполнение.
 * execute применяет команды к документу и возвращает строки отчёта.
 */
export async function runAiTurn(o: {
  settings: AISettings;
  history: AiMsg[];
  userText: string;
  boardSummary: string;
  execute: (cmds: CopilotCmd[]) => string[];
}): Promise<AiTurn> {
  const userContent = `${o.boardSummary}\n\nПросьба пользователя: ${o.userText}`;
  const messages: AiMsg[] = [
    { role: 'system', content: AI_SYSTEM },
    ...o.history.slice(-6),
    { role: 'user', content: userContent },
  ];
  let raw = await chatOnce(o.settings, messages);
  let parsed = parseAiResponse(raw);
  if (!parsed) {
    // одна попытка починки: просим строго JSON
    raw = await chatOnce(o.settings, [
      ...messages,
      { role: 'assistant' as const, content: raw.slice(0, 1500) },
      { role: 'user' as const, content: 'Ответь СТРОГО одним JSON: {"commands": [...], "reply": "..."} — без текста вокруг.' },
    ]);
    parsed = parseAiResponse(raw);
  }
  if (!parsed) throw new AiError('ИИ вернул непонятный ответ. Попробуй переформулировать или продолжи локально.');
  const history: AiMsg[] = [
    ...o.history,
    { role: 'user' as const, content: clip(o.userText, 500) },
    { role: 'assistant' as const, content: clip(parsed.reply || `Команды: ${parsed.commands.map((c) => c.t).join(', ')}`, 500) },
  ].slice(-8);
  if (!parsed.commands.length) return { reply: parsed.reply, history };
  const lines = o.execute(parsed.commands);
  const report = lines.filter(Boolean).join('\n');
  const reply = parsed.reply ? `${parsed.reply}\n${report}` : report;
  return { reply: reply.trim() || 'Готово.', history };
}
