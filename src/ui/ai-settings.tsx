// Настройки ИИ-режима помощника: провайдер, адрес API, модель и ключ.
// Хранятся отдельно (localStorage «psbees.ai») и НЕ попадают в экспорт настроек.
import { useState } from 'react';
import {
  AI_PRESETS, loadAiSettings, resolveAi, saveAiSettings, testAiConnection,
  type AISettings,
} from '../pcb/ai-agent';

export function AiSettingsPanel() {
  const [s, setS] = useState<AISettings>(loadAiSettings);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  const patch = (p: Partial<AISettings>): void => {
    setS((prev) => {
      const next = { ...prev, ...p };
      saveAiSettings(next);
      return next;
    });
    setTestMsg(null);
  };

  const preset = AI_PRESETS.find((p) => p.id === s.presetId) ?? AI_PRESETS[0];
  const resolved = resolveAi(s);
  const needKey = preset.needsKey;
  const complete = !!resolved.baseUrl && !!resolved.model && (!needKey || !!resolved.apiKey);

  const test = async (): Promise<void> => {
    setTesting(true);
    setTestMsg(null);
    try {
      const out = await testAiConnection(s);
      setTestMsg({ ok: true, text: `Связь есть! Модель ответила: «${out}»` });
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : 'Не получилось соединиться.' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <div className="set-title">
        ИИ-помощник
        <small>Умный режим пчелы 🐝: модель читает плату и выполняет свободные просьбы. Без него помощник понимает только строгие команды (и работает офлайн).</small>
      </div>
      <div className="set-block">
        <h3>Режим</h3>
        <label className="chk set-chk" title="Когда включено и всё заполнено, пчела спрашивает модель; иначе — быстрый локальный разбор">
          <input type="checkbox" checked={s.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
          <span>Включить ИИ-режим</span>
        </label>
        <p className="set-note">
          {s.enabled
            ? complete
              ? '✅ Всё заполнено — пчела в углу станет «умной».'
              : '⚠️ Включилось, но не всё заполнено ниже — пока работает локальный режим.'
            : 'Выключено — работает быстрый локальный разбор команд без интернета.'}
        </p>
      </div>
      <div className="set-block">
        <h3>Провайдер</h3>
        <div className="set-row">
          <span className="set-row-label">Сервис</span>
          <span className="set-row-ctl">
            <select
              className="set-sel"
              aria-label="Провайдер ИИ"
              value={s.presetId}
              onChange={(e) => patch({ presetId: e.target.value, baseUrl: '', model: '' })}
            >
              {AI_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </span>
        </div>
        <div className="set-row">
          <span className="set-row-label">Адрес API</span>
          <span className="set-row-ctl">
            <input
              className="txt"
              style={{ minWidth: 260 }}
              value={s.baseUrl || preset.baseUrl}
              placeholder={preset.baseUrl || 'https://…'}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              aria-label="Адрес API"
              autoComplete="off"
              spellCheck={false}
            />
          </span>
        </div>
        <div className="set-row">
          <span className="set-row-label">Модель</span>
          <span className="set-row-ctl">
            <input
              className="txt"
              style={{ minWidth: 200 }}
              value={s.model || preset.model}
              placeholder={preset.model || 'имя модели'}
              onChange={(e) => patch({ model: e.target.value })}
              aria-label="Модель"
              autoComplete="off"
              spellCheck={false}
            />
          </span>
        </div>
        {needKey ? (
          <div className="set-row">
            <span className="set-row-label">API-ключ</span>
            <span className="set-row-ctl">
              <input
                className="txt"
                style={{ minWidth: 200 }}
                type={showKey ? 'text' : 'password'}
                value={s.apiKey}
                placeholder="sk-…"
                onChange={(e) => patch({ apiKey: e.target.value })}
                aria-label="API-ключ"
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="btn tiny" onClick={() => setShowKey((v) => !v)} title="Показать/скрыть ключ">
                {showKey ? 'Скрыть' : 'Показать'}
              </button>
            </span>
          </div>
        ) : (
          <p className="set-note">Ключ не нужен — всё выполняется на твоём компьютере.</p>
        )}
        <p className="set-note">{preset.hint}</p>
        <p className="set-note">
          Запрос уйдёт на <code>{resolved.url || '…'}</code> с моделью <code>{resolved.model || '…'}</code>.
          {resolved.baseUrl && !/\/v\d+$/.test(resolved.baseUrl) && !resolved.baseUrl.includes('deepseek.com') ? (
            <> Если провайдер отвечает <b>404</b> — допиши к адресу <code>/v1</code>.</>
          ) : null}
        </p>
        <p className="set-note">
          Ключ хранится <b>только в этом браузере</b> и никому не отправляется, кроме выбранного
          API. В файл «Перенос настроек» он не попадает — на другом компьютере введи его заново.
        </p>
      </div>
      <div className="set-block">
        <h3>Проверка</h3>
        <div className="set-row">
          <span className="set-row-label">Связь с моделью</span>
          <span className="set-row-ctl">
            <button type="button" className="btn tiny" disabled={testing || !complete} onClick={test}>
              {testing ? 'Проверяю…' : 'Проверить связь'}
            </button>
            {testMsg && (
              <span className={testMsg.ok ? 'ai-test-ok' : 'ai-test-err'}>{testMsg.text}</span>
            )}
          </span>
        </div>
        <p className="set-note">
          Примеры свободных просьб для ИИ-режима: «сделай мигалку на двух светодиодах»,
          «расставь детали аккуратно», «соедини все резисторы между собой», «что не так с этой платой?».
        </p>
      </div>
    </>
  );
}
