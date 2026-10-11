// PCB-помощник: круглая кнопка в углу и панель чата с текстовым и голосовым вводом.
// Разбор команд — src/pcb/copilot.ts, выполнение — колбэк onRun из App.tsx.
import { useEffect, useRef, useState } from 'react';
import { COPILOT_EXAMPLES } from '../pcb/copilot';

export interface CopilotMsg {
  who: 'user' | 'bot';
  text: string;
}

const GREETING = [
  'Привет! Я помощник 🐝',
  'Скажи словами, что сделать: «4 светодиода в ряд через 5 мм», потом «соедини катоды».',
  'Пиши текстом или жми 🎤 и говори. «Что ты умеешь?» — все команды.',
].join('\n');

type Rec = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: { resultIndex: number; results: { isFinal: boolean; [k: number]: { transcript: string } }[] }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
};

const speechCtor = (): (new () => Rec) | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, unknown>;
  return (w.SpeechRecognition as new () => Rec) ?? (w.webkitSpeechRecognition as new () => Rec) ?? null;
};

export function CopilotFab({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={'copilot-fab' + (open ? ' open' : '')}
      onClick={onClick}
      title="PCB-помощник — команды словами (Ctrl+K)"
      aria-label={open ? 'Закрыть помощника' : 'Открыть помощника'}
    >
      <span aria-hidden>{open ? '✕' : '🐝'}</span>
    </button>
  );
}

export function CopilotPanel({
  onRun, onClose, focusTick, aiOn, onOpenAiSettings,
}: {
  /** выполнить реплику, вернуть ответ (ИИ — асинхронно) */
  onRun: (text: string) => string | Promise<string>;
  onClose: () => void;
  /** растёт при каждом открытии — перевести фокус в строку */
  focusTick: number;
  /** ИИ-режим готов (ключ введён, связь настроена) */
  aiOn: boolean;
  /** открыть настройки ИИ */
  onOpenAiSettings: () => void;
}) {
  const [msgs, setMsgs] = useState<CopilotMsg[]>(() => [
    { who: 'bot', text: aiOn ? GREETING + '\n🧠 ИИ-режим включён — проси свободно, хоть «сделай мигалку».' : GREETING },
  ]);
  const [thinking, setThinking] = useState(false);
  const [value, setValue] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [voiceOK] = useState(() => speechCtor() !== null);
  const [chips] = useState<string[]>(() => {
    const all = [...COPILOT_EXAMPLES];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, 4);
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<Rec | null>(null);
  const sendRef = useRef<(t: string) => void>(() => {});
  const finalRef = useRef('');

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusTick]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, listening, thinking]);

  useEffect(
    () => () => {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      recRef.current = null;
    },
    [],
  );

  const stopListening = (): void => {
    try {
      recRef.current?.stop();
    } catch {
      /* ignore */
    }
    recRef.current = null;
    setListening(false);
  };

  const send = (text: string): void => {
    const t = text.trim();
    if (!t || thinking) return;
    if (recRef.current) stopListening();
    setMsgs((m) => [...m, { who: 'user', text: t }]);
    setValue('');
    setThinking(true);
    Promise.resolve()
      .then(() => onRun(t))
      .then((reply) => {
        setMsgs((m) => [...m, { who: 'bot', text: reply || 'Готово.' }]);
      })
      .catch((e) => {
        setMsgs((m) => [...m, { who: 'bot', text: `😵 Что-то пошло не так: ${e instanceof Error ? e.message : String(e)}` }]);
      })
      .finally(() => {
        setThinking(false);
        inputRef.current?.focus();
      });
  };
  sendRef.current = send;

  const toggleListen = (): void => {
    if (thinking) return;
    if (recRef.current) {
      stopListening();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) {
      setVoiceError('Этот браузер не умеет слушать — напиши команду текстом.');
      return;
    }
    const rec = new Ctor();
    recRef.current = rec;
    finalRef.current = '';
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.continuous = false;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const tr = r[0]?.transcript ?? '';
        if (r.isFinal) finalRef.current += tr;
        else interim += tr;
      }
      setValue((finalRef.current + interim).trimStart());
    };
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
      const t = finalRef.current.trim();
      if (t) sendRef.current(t);
      else setValue('');
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setVoiceError('Нет доступа к микрофону — разреши его в настройках браузера.');
      } else if (e.error === 'audio-capture') {
        setVoiceError('Микрофон не найден — напиши команду текстом.');
      }
    };
    setVoiceError('');
    setValue('');
    setListening(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  };

  return (
    <div className="copilot-panel" role="dialog" aria-label="PCB-помощник">
      <div className="copilot-head">
        <span className="copilot-bee" aria-hidden>🐝</span>
        <span className="copilot-title">PCB-помощник</span>
        <button
          type="button"
          className={'copilot-badge' + (aiOn ? ' ai' : '')}
          onClick={onOpenAiSettings}
          title={aiOn ? 'ИИ-режим включён: понимаю свободные просьбы. Нажми — настройки ИИ.' : 'Локальный режим: строгие команды, без интернета. Нажми — подключить ИИ.'}
        >
          {aiOn ? '🧠 ИИ' : '⚙️ локально'}
        </button>
        <button type="button" className="copilot-x" onClick={() => { stopListening(); onClose(); }} title="Закрыть (Esc)" aria-label="Закрыть помощника">
          ✕
        </button>
      </div>
      <div className="copilot-list" ref={listRef}>
        {msgs.map((m, i) => (
          <div key={i} className={'copilot-msg ' + m.who}>
            {m.text}
          </div>
        ))}
        {listening && <div className="copilot-msg bot listening">🎤 слушаю… говори команду</div>}
        {thinking && <div className="copilot-msg bot thinking">🐝 думаю…</div>}
      </div>
      <div className="copilot-chips">
        {chips.map((c) => (
          <button key={c} type="button" className="copilot-chip" onClick={() => send(c)} title="Выполнить пример">
            {c}
          </button>
        ))}
      </div>
      {voiceError && <div className="copilot-voice-err">{voiceError}</div>}
      <form
        className="copilot-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(value);
        }}
      >
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              stopListening();
              onClose();
            }
          }}
          placeholder={listening ? 'Слушаю…' : voiceOK ? 'Команда словами или 🎤…' : 'Команда словами…'}
          aria-label="Команда помощнику"
          autoComplete="off"
        />
        {voiceOK && (
          <button
            type="button"
            className={'copilot-mic' + (listening ? ' on' : '')}
            onClick={toggleListen}
            title={listening ? 'Остановить и выполнить' : 'Говорить голосом'}
            aria-label={listening ? 'Остановить запись' : 'Голосовой ввод'}
          >
            🎤
          </button>
        )}
        <button type="submit" className="copilot-send" title="Выполнить (Enter)" aria-label="Выполнить команду">
          ➤
        </button>
      </form>
    </div>
  );
}
