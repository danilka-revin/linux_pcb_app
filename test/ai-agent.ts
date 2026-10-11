// Проверка ИИ-режима помощника: пресеты, сводка платы, разбор JSON модели,
// протокол chat completions (fetch подменяется) и агент-цикл.
import * as M from '../src/pcb/model';
import {
  aiReady, AI_PRESETS, DEFAULT_AI, loadAiSettings, parseAiResponse, resolveAi,
  runAiTurn, summarizeBoard,
  type AiMsg, type AISettings,
} from '../src/pcb/ai-agent';
import { execCopilot, type CopilotCmd } from '../src/pcb/copilot';

const fails: string[] = [];
const ok = (c: boolean, m: string): void => {
  if (!c) {
    fails.push(m);
    console.error('FAIL:', m);
  }
};

// -------------------------------------------------------------- пресеты
{
  ok(AI_PRESETS.length >= 4, `пресетов мало: ${AI_PRESETS.length}`);
  const ds = AI_PRESETS.find((p) => p.id === 'deepseek');
  ok(!!ds && ds.baseUrl === 'https://api.deepseek.com' && ds.model === 'deepseek-chat' && ds.needsKey, 'пресет DeepSeek');
  const ol = AI_PRESETS.find((p) => p.id === 'ollama');
  ok(!!ol && !ol.needsKey && ol.baseUrl.includes('11434'), 'пресет Ollama без ключа');

  const s: AISettings = { ...DEFAULT_AI, enabled: true, apiKey: 'sk-test' };
  const r = resolveAi(s);
  ok(r.baseUrl === 'https://api.deepseek.com' && r.model === 'deepseek-chat' && r.apiKey === 'sk-test', 'resolve по умолчанию');
  ok(aiReady(s), 'готов при ключе');
  ok(!aiReady({ ...s, apiKey: '' }), 'не готов без ключа');
  ok(!aiReady({ ...s, enabled: false }), 'не готов, когда выключен');
  ok(aiReady({ ...DEFAULT_AI, enabled: true, presetId: 'ollama' }), 'ollama готова без ключа');
  const custom = resolveAi({ ...s, presetId: 'custom', baseUrl: 'http://x:8080/v1/', model: 'm' });
  ok(custom.baseUrl === 'http://x:8080/v1' && custom.model === 'm', 'custom без хвостового слеша');

  const loaded = loadAiSettings();
  ok(loaded.enabled === false && loaded.presetId === 'deepseek', 'настроек нет — выключено');
}

// -------------------------------------------------------- сводка платы
{
  let doc = M.newBoard(60, 40, 'Тест');
  const r = execCopilot(doc, [{ t: 'place', what: 'dip 8', count: 1, arrangement: 'single', step: null, stepY: null, cols: 0, rows: 0, radius: null, anchor: { t: 'point', x: 10, y: 10 }, rot: null, side: null } as CopilotCmd],
    { center: { x: 30, y: 20 }, w: 60, h: 40, activeCu: 'k1', trackW: 0.6, selIds: [], lastIds: [] });
  doc = r.doc;
  const sum = summarizeBoard(doc, { center: { x: 30, y: 20 }, selIds: r.lastIds, lastIds: r.lastIds, activeCu: 'k1', trackW: 0.6 });
  ok(sum.includes('60×40'), `размер: ${sum}`);
  ok(sum.includes('U1') && sum.includes('DIP'), `деталь: ${sum}`);
  ok(sum.includes('(10, 10)'), `координаты: ${sum}`);
  ok(sum.includes('выводов: 8'), `пины: ${sum}`);
  ok(sum.includes('выделено: U1'), `выделение: ${sum}`);
  ok(sum.includes('«их»'), `память: ${sum}`);
}

// ------------------------------------------------------- разбор ответов
{
  const fenced = parseAiResponse('```json\n{"commands": [{"t": "fit"}], "reply": "Готово"}\n```');
  ok(!!fenced && fenced.commands.length === 1 && fenced.commands[0].t === 'fit' && fenced.reply === 'Готово', 'кодовый блок');

  const raw = parseAiResponse('{"commands": [{"t":"place","what":"dip 8","count":2,"arrangement":"row","step":5,"anchor":{"t":"center"}}], "reply": "ставлю"}');
  ok(!!raw && raw.commands.length === 1 && raw.commands[0].t === 'place', 'сырой JSON');

  ok(parseAiResponse('просто текст без json') === null, 'мусор — null');
  ok(parseAiResponse('{"commands": [], "reply": ""}') === null, 'пустышка — null');
  ok(parseAiResponse('{"commands": [{"t": "fly", "to": "moon"}], "reply": "лечу"}')?.commands.length === 0, 'неизвестная команда отброшена');

  const bad = parseAiResponse('{"commands": [{"t":"place","what":"dip 8","count":5000,"anchor":{"t":"point"}}], "reply": "x"}');
  ok(!!bad && bad.commands.length === 0, 'невалидная команда отброшена');

  const anchor = parseAiResponse('{"commands": [{"t":"text","text":"hi","anchor":{"t":"near","ref":"d1","dir":"r"}}], "reply": ""}');
  ok(!!anchor && anchor.commands[0].t === 'text', 'якорь near принят');
}

// --------------------------------------------------------------- сеть
const realFetch = globalThis.fetch;

const stubFetch = (fn: (url: string, init?: { body?: string }) => unknown): void => {
  (globalThis as Record<string, unknown>).fetch = (async (url: string, init?: { body?: string }) => fn(url, init)) as typeof fetch;
};

const jsonResp = (obj: unknown, status = 200): unknown => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
});

{
  // успех: модель вернула команду
  let seenUrl = '';
  let seenAuth = '';
  stubFetch((url, init) => {
    seenUrl = String(url);
    seenAuth = String((JSON.parse(String((init as { body: string }).body)) as { model: string }).model);
    return jsonResp({ choices: [{ message: { content: '{"commands": [{"t": "fit"}], "reply": "Показал"}' } }] });
  });
  const s: AISettings = { ...DEFAULT_AI, enabled: true, apiKey: 'sk-test' };
  const { chatOnce } = await import('../src/pcb/ai-agent');
  const out = await chatOnce(s, [{ role: 'user', content: 'hi' }]);
  ok(out.includes('fit'), `chatOnce вернул контент: ${out}`);
  ok(seenUrl === 'https://api.deepseek.com/chat/completions', `url: ${seenUrl}`);
  ok(seenAuth === 'deepseek-chat', `модель: ${seenAuth}`);

  // 401 — неверный ключ
  stubFetch(() => jsonResp({ error: { message: 'bad key' } }, 401));
  try {
    await chatOnce(s, [{ role: 'user', content: 'hi' }]);
    ok(false, '401 должен бросать');
  } catch (e) {
    ok(e instanceof Error && e.message.includes('ключ'), `401: ${e instanceof Error ? e.message : e}`);
  }

  // обрыв сети
  stubFetch(() => { throw new Error('net down'); });
  try {
    await chatOnce(s, [{ role: 'user', content: 'hi' }]);
    ok(false, 'сеть должна бросать');
  } catch (e) {
    ok(e instanceof Error && e.message.includes('Нет связи'), `сеть: ${e instanceof Error ? e.message : e}`);
  }

  // нет ключа
  try {
    await chatOnce({ ...DEFAULT_AI, enabled: true }, [{ role: 'user', content: 'hi' }]);
    ok(false, 'без ключа должен бросать');
  } catch (e) {
    ok(e instanceof Error && e.message.includes('API-ключ'), `ключ: ${e instanceof Error ? e.message : e}`);
  }
}

// ---------------------------------------------------------- агент-цикл
{
  stubFetch(() => jsonResp({
    choices: [{
      message: {
        content: '{"commands": [{"t":"place","what":"dip 8","count":1,"anchor":{"t":"point","x":30,"y":20}}], "reply": "Ставлю DIP-8."}',
      },
    }],
  }));
  const s: AISettings = { ...DEFAULT_AI, enabled: true, apiKey: 'sk-test' };
  const doc = M.newBoard(60, 40, 'Тест');
  const executed: CopilotCmd[][] = [];
  const history: AiMsg[] = [];
  const turn = await runAiTurn({
    settings: s,
    history,
    userText: 'поставь dip 8',
    boardSummary: summarizeBoard(doc, { center: { x: 30, y: 20 }, selIds: [], lastIds: [], activeCu: 'k1', trackW: 0.6 }),
    execute: (cmds) => {
      executed.push(cmds);
      return cmds.map((c) => `выполнено: ${c.t}`);
    },
  });
  ok(executed.length === 1 && executed[0][0].t === 'place', 'агент выполнил команду');
  ok(turn.reply.includes('Ставлю') && turn.reply.includes('выполнено: place'), `ответ: ${turn.reply}`);
  ok(turn.history.length === 2, `история выросла: ${turn.history.length}`);

  // только ответ, без команд
  stubFetch(() => jsonResp({ choices: [{ message: { content: '{"commands": [], "reply": "Что именно поставить?"}' } }] }));
  const turn2 = await runAiTurn({
    settings: s, history: turn.history, userText: 'поставь', boardSummary: 'плата пустая',
    execute: (cmds) => cmds.map(() => 'x'),
  });
  ok(turn2.reply === 'Что именно поставить?', `уточнение: ${turn2.reply}`);
  ok(turn2.history.length === 4, 'история продолжает расти');

  // мусор от модели — одна попытка починки, затем ошибка
  let calls = 0;
  stubFetch(() => {
    calls++;
    return jsonResp({ choices: [{ message: { content: 'бла-бла, я не json' } }] });
  });
  try {
    await runAiTurn({ settings: s, history: [], userText: 'x', boardSummary: 'b', execute: () => [] });
    ok(false, 'мусор должен бросать');
  } catch (e) {
    ok(e instanceof Error && e.message.includes('непонятный'), `мусор: ${e instanceof Error ? e.message : e}`);
    ok(calls === 2, `одна попытка починки: вызовов ${calls}`);
  }
}

globalThis.fetch = realFetch;

if (fails.length) {
  console.error(`\nИИ-агент: ${fails.length} ошибок`);
  process.exit(1);
} else {
  console.log('ИИ-агент: все проверки прошли');
}
