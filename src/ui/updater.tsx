// «Обновить с main»: кнопка в шапке, диалог проверки/установки обновлений
// и конструктор интерфейса (перестановка/скрытие групп кнопок тулбара).
//
// Кнопка дёргает HTTP-эндпоинты сервера:
//   GET  /update/check  — сверить установленную версию с веткой main на GitHub;
//   POST /update/run    — запустить обновление (git fetch + merge + npm ci + build);
//   GET  /update/status — ход выполнения (сообщения по шагам).
// Сервер (scripts/server.mjs) сам всё делает: в установленной программе сам
// себя перезапускает, в обычном клоне — говорит «перезагрузите страницу».
import { useCallback, useRef, useState } from 'react';
import { Modal } from './widgets';
import { Ic } from './icons';

export type UpdatePhase = 'idle' | 'checking' | 'ready' | 'running' | 'done' | 'error';

export interface UpdaterState {
  phase: UpdatePhase;
  msg: string;
  detail: string[];
  from: string;
  to: string;
  repo: string;
  branch: string;
  latestMsg: string;
  behind: number;
  updateAvailable: boolean;
  tooling: { git: boolean; npm: boolean };
}

export function useUpdater(version: string | null) {
  const [st, setSt] = useState<UpdaterState>({
    phase: 'idle', msg: '', detail: [], from: version ?? '', to: '',
    repo: '', branch: 'main', latestMsg: '', behind: 0,
    updateAvailable: false, tooling: { git: true, npm: true },
  });
  const [open, setOpen] = useState(false);
  const running = useRef(false);

  const check = useCallback(async () => {
    if (running.current) return;
    setSt((s) => ({ ...s, phase: 'checking', msg: 'Проверяем обновления на GitHub…' }));
    try {
      const resp = await fetch('/update/check');
      const text = await resp.text();
      let r: any;
      try { r = JSON.parse(text); } catch { r = null; }
      if (r && r.ok) {
        setSt((s) => ({
          ...s,
          phase: 'ready',
          repo: r.repo || s.repo, branch: r.branch || 'main',
          from: r.local || s.from, to: r.latest,
          latestMsg: r.latestMsg || '', behind: r.behind ?? 0,
          updateAvailable: !!r.updateAvailable,
          tooling: r.tooling || s.tooling,
        }));
      } else if (r && !r.ok) {
        setSt((s) => ({ ...s, phase: 'error', msg: r.error || 'Не удалось проверить обновления' }));
      } else {
        // сервер без поддержки /update (например, npm run dev): честно объясняем
        setSt((s) => ({
          ...s, phase: 'error',
          msg: 'В этом режиме запуска нет встроенного обновления.\nЗапустите программу через bash run.sh (или установленную версию) — там кнопка работает.',
        }));
      }
    } catch {
      setSt((s) => ({ ...s, phase: 'error', msg: 'Сервер не отвечает. Проверьте соединение и повторите.' }));
    }
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSt((s) => ({ ...s, phase: 'running', msg: 'Обновление выполняется…', detail: [] }));
    const finish = () => { running.current = false; };
    try {
      const resp = await fetch('/update/run', { method: 'POST' });
      const text = await resp.text();
      let j: any;
      try { j = JSON.parse(text); } catch { j = null; }
      if (!j || !j.ok) throw new Error((j && j.error) || 'Не удалось начать обновление');

      const until = Date.now() + 12 * 60 * 1000;
      let lastOut = '';
      while (Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1500));
        let s: any;
        try {
          const st = await (await fetch('/update/status')).text();
          try { s = JSON.parse(st); } catch { s = null; }
        } catch { continue; }
        if (!s) continue;
        if ((s.output || '') !== lastOut) {
          lastOut = s.output || '';
          setSt((x) => ({
            ...x,
            detail: (s.output || '').split('\n').filter(Boolean),
            to: s.to || x.to, from: s.from || x.from,
          }));
        }
        if (s.status === 'done' || s.status === 'error') {
          if (s.status === 'done') {
            setSt((x) => ({ ...x, phase: 'done', to: s.to || x.to, from: s.from || x.from, msg: (s.phase || 'Обновление установлено.') }));
            return; // сервер перезапускается/перезапущен сам — страница обновится автоматически
          }
          setSt((x) => ({
            ...x, phase: 'error', msg: 'Обновление не удалось',
            detail: [s.error || ''].filter(Boolean).concat(x.detail),
          }));
          return;
        }
        if (s.status === 'idle') {
          setSt((x) => ({ ...x, phase: 'error', msg: 'Сервер перезапустился — нажмите «Проверить обновления» ещё раз.' }));
          return;
        }
      }
      setSt((x) => ({ ...x, phase: 'error', msg: 'Обновление идёт слишком долго. Проверьте позже или выполните git pull вручную.' }));
    } catch (e) {
      setSt((x) => ({ ...x, phase: 'error', msg: e instanceof Error ? e.message : 'Ошибка обновления' }));
    } finally {
      finish();
    }
  }, []);

  const openDialog = useCallback(() => {
    setOpen(true);
    setSt((s) => ({ ...s, phase: 'idle', msg: '' }));
    void check();
  }, [check]);

  const Button = (
    <button
      className="tb-btn cu upd-btn"
      title="Обновить программу из ветки main (GitHub)"
      onClick={openDialog}
    >
      <Ic n="update" size={16} />
      {' '}Обновить
      {st.updateAvailable && <span className="upd-dot" title="Доступна новая версия" />}
    </button>
  );

  const Dialog = (
    <UpdaterDialog
      open={open} onClose={() => { if (!running.current) setOpen(false); }}
      st={st} onCheck={check} onRun={run} onReload={() => window.location.reload()}
    />
  );

  return { Button, Dialog, state: st, open: openDialog };
}

function UpdaterDialog({
  open, onClose, st, onCheck, onRun, onReload,
}: {
  open: boolean;
  onClose: () => void;
  st: UpdaterState;
  onCheck: () => void;
  onRun: () => void;
  onReload: () => void;
}) {
  if (!open) return null;
  const busy = st.phase === 'checking' || st.phase === 'running';
  return (
    <Modal
      title="Обновить с main"
      className="update-modal"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Закрыть</button>
          {(!busy && st.phase === 'ready' && st.updateAvailable) && (
            <button className="btn primary" onClick={onRun}>Обновить сейчас</button>
          )}
          {st.phase === 'idle' && <button className="btn primary" onClick={onCheck}>Проверить обновления</button>}
          {st.phase === 'done' && <button className="btn primary" onClick={onReload}>Перезагрузить страницу</button>}
          {st.phase === 'error' && <button className="btn primary" onClick={onCheck}>Проверить ещё раз</button>}
        </>
      }
    >
      <div className="upd">
        <div className="upd-row">
          <span className="upd-lab">Репозиторий</span>
          <b className="upd-mono">{st.repo || '…'}</b>
        </div>
        <div className="upd-row">
          <span className="upd-lab">Ветка</span>
          <b className="upd-mono">{st.branch || 'main'}</b>
        </div>
        <div className="upd-row">
          <span className="upd-lab">Установлено</span>
          <b className="upd-mono">{st.from || 'не определена'}</b>
        </div>
        <div className="upd-row">
          <span className="upd-lab">В main</span>
          <b className="upd-mono">{st.to || '…'}</b>
        </div>

        {st.phase === 'checking' && <p className="upd-msg">Проверяем обновления на GitHub…</p>}
        {st.phase === 'ready' && (
          st.updateAvailable ? (
            <div className="upd-msg ok">
              Доступна новая версия <b>{st.to}</b>: позади main на {st.behind} комм.
              {st.latestMsg && <div className="upd-commit">«{st.latestMsg}»</div>}
            </div>
          ) : (
            <p className="upd-msg">Установлена актуальная версия — новых коммитов в main нет.</p>
          )
        )}
        {st.phase === 'running' && <p className="upd-msg" aria-live="polite">{st.msg}</p>}
        {st.phase === 'done' && <p className="upd-msg ok">{st.msg}</p>}
        {st.phase === 'error' && <p className="upd-msg bad">{st.msg}</p>}

        {(st.phase === 'running' || st.phase === 'done' || st.phase === 'error') && st.detail.length > 0 && (
          <div className="upd-log">
            {st.detail.map((l, i) => <div key={i} className="upd-line">{l}</div>)}
          </div>
        )}

        {!st.tooling.git && <p className="upd-msg bad">Не найден git — установите его для обновления: sudo apt install git.</p>}
        {!st.tooling.npm && <p className="upd-msg bad">Не найден npm — установите Node.js для обновления.</p>}

        <p className="upd-note">
          Скачивается последняя версия из ветки <b>main</b> на GitHub, затем программа
          пересобирается (npm ci + npm run build) и перезапускается. Ваши платы не
          затрагиваются — они хранятся отдельно от кода программы.
        </p>
      </div>
    </Modal>
  );
}

// ---------- конструктор интерфейса ----------

/** Перестановка (←/→) и скрытие/показ групп кнопок верхней панели. */
export function UiBuilder({
  ids, names, onChange, hidden,
}: {
  ids: string[];
  names: Record<string, string>;
  onChange: (next: { ids: string[]; hidden: string[] }) => void;
  hidden: string[];
}) {
  const move = (id: string, dir: -1 | 1) => {
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const nx = [...ids];
    [nx[i], nx[j]] = [nx[j], nx[i]];
    onChange({ ids: nx, hidden });
  };
  const toggle = (id: string) => {
    const hid = hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
    onChange({ ids, hidden: hid });
  };

  return (
    <div className="uib">
      {ids.map((id, idx) => (
        <div className="uib-item" key={id}>
          <span className="uib-pos">{idx + 1}</span>
          <button className="uib-left" onClick={() => move(id, -1)} disabled={idx === 0} title="Левее">←</button>
          <button className="uib-right" onClick={() => move(id, 1)} disabled={idx === ids.length - 1} title="Правее">→</button>
          <span className="uib-name">{names[id] ?? id}</span>
          <button
            className={'btn tiny' + (hidden.includes(id) ? ' uib-hide-on' : '')}
            onClick={() => toggle(id)} title={hidden.includes(id) ? 'Показать группу' : 'Скрыть группу'}
          >
            {hidden.includes(id) ? 'Скрыта' : 'Показана'}
          </button>
        </div>
      ))}
      <div className="uib-meta">
        {hidden.length > 0 && (
          <button className="btn tiny" onClick={() => onChange({ ids, hidden: [] })}>Показать все</button>
        )}
      </div>
      <p className="uib-note">
        Стрелки «← / →» меняют порядок групп на панели кнопок, «Скрыта» убирает группу.
        Изменения сразу применяются и сохраняются в этом браузере.
      </p>
    </div>
  );
}

/** Настройка боковых колонок: левая колонка (Слои/Библиотека) и правая («Свойства»). */
export function SideBuilder({
  sideTabs, sideNames, leftW, rightW, showRight, onChange,
}: {
  sideTabs: string[];
  sideNames: Record<string, string>;
  leftW: number;
  rightW: number;
  showRight: boolean;
  onChange: (next: {
    leftTabs: ('layers' | 'lib')[];
    leftW: number;
    rightW: number;
    showRight: boolean;
  }) => void;
}) {
  const move = (id: string, dir: -1 | 1) => {
    const i = sideTabs.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sideTabs.length) return;
    const nx = [...sideTabs] as ('layers' | 'lib')[];
    [nx[i], nx[j]] = [nx[j], nx[i]];
    onChange({ leftTabs: nx, leftW, rightW, showRight });
  };
  const toggleTab = (id: string) => {
    const has = sideTabs.includes(id);
    const nx = (has
      ? sideTabs.filter((x) => x !== id)
      : [...sideTabs, id]) as ('layers' | 'lib')[];
    onChange({ leftTabs: nx.length ? nx : ['layers', 'lib'], leftW, rightW, showRight });
  };

  return (
    <div className="uib">
      <div className="uib-sect-title">Левая колонка — вкладки</div>
      {sideTabs.map((id) => (
        <div className="uib-item" key={'tab-' + id}>
          <button
            className="uib-left" onClick={() => move(id, -1)}
            disabled={sideTabs.indexOf(id) === 0} title="Вкладку левее">←</button>
          <button
            className="uib-right" onClick={() => move(id, 1)}
            disabled={sideTabs.indexOf(id) === sideTabs.length - 1} title="Вкладку правее">→</button>
          <span className="uib-name">{sideNames[id] ?? id}</span>
          <button
            className={'btn tiny' + (!sideTabs.includes(id) ? ' uib-hide-on' : '')}
            onClick={() => toggleTab(id)} title="Скрыть вкладку"
          >
            {sideTabs.includes(id) ? 'Показана' : 'Скрыта'}
          </button>
        </div>
      ))}
      {LEFT_TAB_CHECK.map((id) => {
        if (sideTabs.includes(id)) return null;
        return (
          <button key={'miss-' + id} className="btn tiny uib-restore"
            onClick={() => toggleTab(id)}>
            Вернуть вкладку «{sideNames[id] ?? id}»
          </button>
        );
      })}
      <div className="uib-item uib-row">
        <span className="uib-name">Ширина левой колонки</span>
        <input className="uib-w-input" type="number" min={160} max={650} step={5}
          value={Math.round(leftW)}
          onChange={(e) => onChange({ leftTabs: sideTabs as ('layers' | 'lib')[], leftW: Number(e.target.value) || 250, rightW, showRight })} />
        <span className="uib-w-unit">пкс</span>
      </div>

      <div className="uib-sect-title">Правая колонка — «Свойства»</div>
      <div className={'uib-item' + (showRight ? '' : ' uib-item-off')}>
        <span className="uib-pos">▪</span>
        <span className="uib-name">Панель свойств и трассировки</span>
        <button
          className={'btn tiny' + (!showRight ? ' uib-hide-on' : '')}
          onClick={() => onChange({ leftTabs: sideTabs as ('layers' | 'lib')[], leftW, rightW, showRight: !showRight })}
        >
          {showRight ? 'Показана' : 'Скрыта'}
        </button>
      </div>
      {showRight && (
        <div className="uib-item uib-row">
          <span className="uib-name">Ширина правой колонки</span>
          <input className="uib-w-input" type="number" min={160} max={650} step={5}
            value={Math.round(rightW)}
            onChange={(e) => onChange({ leftTabs: sideTabs as ('layers' | 'lib')[], leftW, rightW: Number(e.target.value) || 274, showRight })} />
          <span className="uib-w-unit">пкс</span>
        </div>
      )}

      <div className="uib-meta">
        <button className="btn tiny" onClick={() => onChange({ leftTabs: ['layers', 'lib'], leftW: 250, rightW: 274, showRight: true })}>
          Настройки по умолчанию
        </button>
      </div>
    </div>
  );
}

const LEFT_TAB_CHECK: string[] = ['layers', 'lib'];

export function UiBuilderDialog({
  ids, names, hidden, onChange, onClose, sideTabs, sideNames, leftW, rightW, showRight, onSides,
}: {
  ids: string[];
  names: Record<string, string>;
  hidden: string[];
  onChange: (next: { ids: string[]; hidden: string[] }) => void;
  onClose: () => void;
  sideTabs?: string[];
  sideNames?: Record<string, string>;
  leftW?: number;
  rightW?: number;
  showRight?: boolean;
  onSides?: (next: {
    leftTabs: ('layers' | 'lib')[];
    leftW: number;
    rightW: number;
    showRight: boolean;
  }) => void;
}) {
  const hasSides = typeof onSides === 'function' && sideTabs && sideNames;
  return (
    <Modal
      title="Конструктор интерфейса"
      className="uib-modal"
      onClose={onClose}
      foot={<button className="btn primary" onClick={onClose}>Готово</button>}
    >
      <p style={{ marginTop: 0 }}>Настройте состав и порядок групп кнопок на верхней панели.</p>
      <UiBuilder ids={ids} names={names} hidden={hidden} onChange={onChange} />
      {hasSides && (
        <>
          <div className="sect" />
          <h3 style={{ margin: '10px 0 0', fontSize: 13 }}>Боковые панели</h3>
          <p style={{ margin: '6px 0 0' }}>
            Левая колонка (вкладки «Слои» / «Библиотека») и правая колонка («Свойства»):
            порядок вкладок, видимость и ширина.
          </p>
          <SideBuilder
            sideTabs={sideTabs} sideNames={sideNames}
            leftW={leftW ?? 250} rightW={rightW ?? 274} showRight={showRight ?? true}
            onChange={onSides}
          />
        </>
      )}
    </Modal>
  );
}
