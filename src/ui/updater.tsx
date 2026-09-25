// «Обновить с main»: кнопка в шапке, диалог проверки/установки обновлений
// с интерактивной полосой прогресса, и конструктор интерфейса.
//
// Кнопка дёргает HTTP-эндпоинты сервера (scripts/server.mjs):
//   GET  /update/check          — сверить установленную версию с веткой main на GitHub;
//   POST /update/run            — запустить обновление;
//   GET  /update/status?since=N — ход выполнения (long-poll: ответ сразу при изменении);
//   POST /update/cancel         — отменить.
// После установки сервер сам перезапускается, а страница дожидается новой
// версии и перезагружается автоматически.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './widgets';
import { Ic } from './icons';

export type UpdatePhase = 'idle' | 'checking' | 'ready' | 'running' | 'done' | 'error' | 'cancelled';

export interface UpdateStage {
  id: string;
  label: string;
  weight: number;
  state: 'wait' | 'run' | 'done' | 'skip' | 'error';
  frac: number;
  msg: string;
}

export interface UpdateProgress {
  stages: UpdateStage[];
  stage: string;
  pct: number;
  bytes: number;
  total: number;
  exact: boolean;
  speed: number;
  eta: number | null;
  elapsed: number;
  count: number;
  countTotal: number;
  cancelable: boolean;
  restart: boolean;
  mode: string;
}

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
  progress: UpdateProgress | null;
  /** после установки: ждём перезапуска сервера и перезагружаем страницу */
  reload: 'none' | 'waiting' | 'manual';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, init?: RequestInit, timeout = 30000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const resp = await fetch(url, { cache: 'no-store', ...init, signal: ctl.signal });
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return null; }
  } finally {
    clearTimeout(t);
  }
}

export function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 Б';
  if (n < 1024) return `${Math.round(n)} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} КБ`;
  return `${(n / 1024 / 1024).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} МБ`;
}

export function fmtDur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${String(s % 60).padStart(2, '0')} с`;
}

export function useUpdater(version: string | null) {
  const [st, setSt] = useState<UpdaterState>({
    phase: 'idle', msg: '', detail: [], from: version ?? '', to: '',
    repo: '', branch: 'main', latestMsg: '', behind: 0,
    updateAvailable: false, tooling: { git: true, npm: true },
    progress: null, reload: 'none',
  });
  const [open, setOpen] = useState(false);
  const running = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /** Применить ответ /update/status к состоянию интерфейса. */
  const applyStatus = useCallback((s: any) => {
    const progress: UpdateProgress = {
      stages: Array.isArray(s.stages) ? s.stages : [],
      stage: s.stage || '', pct: Number(s.pct) || 0,
      bytes: Number(s.bytes) || 0, total: Number(s.total) || 0, exact: !!s.exact,
      speed: Number(s.speed) || 0, eta: s.eta ?? null, elapsed: Number(s.elapsed) || 0,
      count: Number(s.count) || 0, countTotal: Number(s.countTotal) || 0,
      cancelable: !!s.cancelable, restart: !!s.restart, mode: s.mode || '',
    };
    setSt((x) => ({
      ...x,
      progress,
      detail: (s.output || '').split('\n').filter(Boolean),
      to: s.to || x.to, from: s.from || x.from,
      msg: s.phase || x.msg,
    }));
  }, []);

  /** После установки: дождаться, когда сервер поднимется с новой версией, и перезагрузить страницу. */
  const awaitRestart = useCallback(async (expect: string) => {
    setSt((x) => ({ ...x, reload: 'waiting' }));
    const until = Date.now() + 90_000;
    let sawDown = false;
    await sleep(800);
    while (alive.current && Date.now() < until) {
      try {
        const v = await getJson('/version', undefined, 2500);
        const cur = String(v?.short || v?.sha || '');
        if (v?.ok && ((expect && cur.startsWith(expect.slice(0, 7))) || (sawDown && !expect))) {
          window.location.reload();
          return;
        }
        if (v?.ok && sawDown) { window.location.reload(); return; }
      } catch {
        sawDown = true;
      }
      await sleep(600);
    }
    if (alive.current) setSt((x) => ({ ...x, reload: 'manual' }));
  }, []);

  /** Следить за ходом обновления (long-poll). */
  const follow = useCallback(async () => {
    let rev = -1;
    let fails = 0;
    while (alive.current) {
      let s: any = null;
      try {
        s = await getJson('/update/status' + (rev >= 0 ? `?since=${rev}` : ''), undefined, 35000);
        fails = 0;
      } catch {
        // сервер мог перезапуститься или соединение оборвалось — пробуем ещё
        if (++fails > 40) {
          setSt((x) => ({ ...x, phase: 'error', msg: 'Сервер не отвечает. Проверьте, что программа запущена, и повторите.' }));
          return;
        }
        await sleep(750);
        continue;
      }
      if (!s) { await sleep(750); continue; }
      rev = Number(s.rev) || 0;
      applyStatus(s);
      if (s.status === 'done') {
        const changed = (s.changes ?? 0) > 0;
        setSt((x) => ({
          ...x, phase: 'done', msg: s.phase || 'Обновление установлено.',
          updateAvailable: changed ? false : x.updateAvailable,
        }));
        if (changed) {
          if (s.restart) void awaitRestart(s.to || '');
          else setSt((x) => ({ ...x, reload: 'manual' }));
        }
        return;
      }
      if (s.status === 'cancelled') {
        setSt((x) => ({ ...x, phase: 'cancelled', msg: s.phase || 'Обновление отменено.' }));
        return;
      }
      if (s.status === 'error') {
        setSt((x) => ({ ...x, phase: 'error', msg: s.error || 'Обновление не удалось' }));
        return;
      }
      if (s.status === 'idle') {
        setSt((x) => ({ ...x, phase: 'error', msg: 'Сервер перезапустился — нажмите «Проверить ещё раз».' }));
        return;
      }
    }
  }, [applyStatus, awaitRestart]);

  const check = useCallback(async () => {
    if (running.current) return;
    setSt((s) => ({ ...s, phase: 'checking', msg: 'Проверяем обновления на GitHub…' }));
    try {
      const r = await getJson('/update/check', undefined, 40000);
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
        // сервер без поддержки /update (например, npm run dev)
        setSt((s) => ({
          ...s, phase: 'error',
          msg: 'В этом режиме запуска нет встроенного обновления.\nЗапустите программу через bash run.sh (или установленную версию) — там кнопка работает.',
        }));
      }
    } catch {
      setSt((s) => ({ ...s, phase: 'error', msg: 'GitHub или сервер не ответили вовремя. Проверьте интернет и повторите.' }));
    }
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSt((s) => ({ ...s, phase: 'running', msg: 'Запуск обновления…', detail: [], progress: null, reload: 'none' }));
    try {
      const j = await getJson('/update/run', { method: 'POST' }, 30000);
      // 409 — обновление уже идёт (например, открыто в другой вкладке): просто следим за ним
      if (!j || (!j.ok && j.status !== 'busy')) throw new Error((j && j.error) || 'Не удалось начать обновление');
      await follow();
    } catch (e) {
      setSt((x) => ({ ...x, phase: 'error', msg: e instanceof Error ? e.message : 'Ошибка обновления' }));
    } finally {
      running.current = false;
    }
  }, [follow]);

  const cancel = useCallback(async () => {
    try {
      const j = await getJson('/update/cancel', { method: 'POST' }, 10000);
      if (j && !j.ok && j.error) setSt((x) => ({ ...x, msg: j.error }));
    } catch { /* статус придёт через long-poll */ }
  }, []);

  // обновление уже идёт (перезагрузили страницу посреди процесса) — подхватываем
  useEffect(() => {
    let stop = false;
    (async () => {
      try {
        const s = await getJson('/update/status', undefined, 5000);
        if (stop || !s || s.status !== 'busy' || running.current) return;
        running.current = true;
        setSt((x) => ({ ...x, phase: 'running' }));
        setOpen(true);
        try { await follow(); } finally { running.current = false; }
      } catch { /* нет сервера с обновлением */ }
    })();
    return () => { stop = true; };
  }, [follow]);

  // процент в заголовке вкладки, пока диалог свёрнут
  const pct = st.phase === 'running' && st.progress ? Math.round(st.progress.pct * 100) : null;
  useEffect(() => {
    if (pct == null) return;
    const base = document.title.replace(/^\[\d+%\]\s*/, '');
    document.title = `[${pct}%] ${base}`;
    return () => { document.title = document.title.replace(/^\[\d+%\]\s*/, ''); };
  }, [pct]);

  const openDialog = useCallback(() => {
    setOpen(true);
    if (running.current || st.phase === 'running' || st.reload === 'waiting') return; // просто развернуть
    setSt((s) => ({ ...s, phase: 'idle', msg: '' }));
    void check();
  }, [check, st.phase, st.reload]);

  const busy = st.phase === 'running';
  // мемоизируем кнопку: тулбар приложения не должен пересобираться на каждое
  // движение мыши из-за новой идентичности этого элемента
  const Button = useMemo(() => (
    <button
      className={'tb-btn cu upd-btn' + (busy ? ' upd-busy' : '')}
      title={busy ? `Идёт обновление: ${pct ?? 0}% — нажмите, чтобы развернуть` : 'Обновить программу из ветки main (GitHub)'}
      onClick={openDialog}
    >
      <Ic n="update" size={16} />
      {' '}{busy ? `${pct ?? 0}%` : 'Обновить'}
      {!busy && st.updateAvailable && <span className="upd-dot" title="Доступна новая версия" />}
      {busy && <span className="upd-btn-bar" style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} />}
    </button>
  ), [busy, pct, st.updateAvailable, openDialog]);

  const Dialog = (
    <UpdaterDialog
      open={open}
      onClose={() => setOpen(false)}
      st={st} onCheck={check} onRun={run} onCancel={cancel}
      onReload={() => window.location.reload()}
    />
  );

  return { Button, Dialog, state: st, open: openDialog };
}

const STAGE_ICON: Record<UpdateStage['state'], string> = {
  wait: '○', run: '', done: '✓', skip: '↷', error: '✕',
};

/** Полоса прогресса + этапы + скорость/ETA. */
export function UpdateProgressView({ p, phase, msg }: { p: UpdateProgress | null; phase: UpdatePhase; msg: string }) {
  const pct = p ? Math.round(p.pct * 1000) / 10 : 0;
  const active = phase === 'running';
  const cur = p?.stages.find((s) => s.id === p.stage);
  const indeterminate = active && (!p || !p.stages.length || pct < 0.5);

  // живой таймер между ответами сервера
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  let sub = '';
  if (p && active) {
    if (p.stage === 'download' && p.bytes > 0) {
      sub = fmtBytes(p.bytes) + (p.total ? ` из ${p.exact ? '' : '~'}${fmtBytes(Math.max(p.total, p.bytes))}` : '')
        + (p.speed ? ` · ${fmtBytes(p.speed)}/с` : '');
    } else if (p.stage === 'deps' && p.countTotal) {
      sub = `${p.count} из ${p.countTotal} пакетов`;
    }
  }

  return (
    <div className={'updp' + (phase === 'error' ? ' is-err' : phase === 'done' ? ' is-ok' : phase === 'cancelled' ? ' is-cancel' : '')}>
      <div className="updp-head">
        <span className="updp-title" aria-live="polite">{active ? (cur?.msg || msg || 'Обновление…') : msg}</span>
        <span className="updp-pct">{indeterminate ? '' : `${pct.toFixed(pct < 10 ? 1 : 0)}%`}</span>
      </div>
      <div
        className={'updp-track' + (indeterminate ? ' indet' : '') + (active ? ' live' : '')}
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : Math.round(pct)}
        title={p?.stages.map((s) => `${s.label}: ${s.state === 'skip' ? 'пропущено' : Math.round(s.frac * 100) + '%'}`).join('\n')}
      >
        {/* сегменты этапов — видно, где мы сейчас */}
        {p && p.stages.length > 0 && (() => {
          const sum = p.stages.reduce((a, s) => a + s.weight, 0) || 1;
          let acc = 0;
          return p.stages.slice(0, -1).map((s) => {
            acc += s.weight;
            return <span key={s.id} className="updp-tick" style={{ left: `${(acc / sum) * 100}%` }} />;
          });
        })()}
        <div className="updp-fill" style={{ width: indeterminate ? undefined : `${pct}%` }} />
      </div>
      <div className="updp-meta">
        <span>{sub}</span>
        {p && (active || phase === 'done') && (
          <span className="updp-time">
            прошло {fmtDur(p.elapsed)}{active && p.eta != null && pct > 3 ? ` · осталось ≈ ${fmtDur(p.eta)}` : ''}
          </span>
        )}
      </div>
      {p && p.stages.length > 0 && (
        <ol className="updp-steps">
          {p.stages.map((s) => (
            <li key={s.id} className={'updp-step s-' + s.state}>
              <span className="updp-ico">{s.state === 'run' ? <span className="updp-spin" /> : STAGE_ICON[s.state]}</span>
              <span className="updp-lab">{s.label}</span>
              <span className="updp-mini">
                {s.state === 'run' && <span className="updp-mini-fill" style={{ width: `${Math.round(s.frac * 100)}%` }} />}
              </span>
              <span className="updp-st">
                {s.state === 'run' ? `${Math.round(s.frac * 100)}%` : s.state === 'skip' ? 'кэш' : s.state === 'done' ? 'готово' : s.state === 'error' ? 'ошибка' : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function UpdaterDialog({
  open, onClose, st, onCheck, onRun, onCancel, onReload,
}: {
  open: boolean;
  onClose: () => void;
  st: UpdaterState;
  onCheck: () => void;
  onRun: () => void;
  onCancel: () => void;
  onReload: () => void;
}) {
  const [showLog, setShowLog] = useState(false);
  if (!open) return null;
  const running = st.phase === 'running';
  const checking = st.phase === 'checking';
  const showProgress = running || ((st.phase === 'done' || st.phase === 'error' || st.phase === 'cancelled') && !!st.progress);
  return (
    <Modal
      title={running ? 'Обновление программы' : 'Обновить с main'}
      className="update-modal"
      onClose={onClose}
      foot={
        <>
          {running ? (
            <>
              <button className="btn" onClick={onClose} title="Обновление продолжится в фоне — прогресс виден на кнопке «Обновить»">Свернуть</button>
              <button className="btn danger" onClick={onCancel} disabled={!st.progress?.cancelable}>Отменить</button>
            </>
          ) : (
            <button className="btn" onClick={onClose} disabled={checking}>Закрыть</button>
          )}
          {(st.phase === 'ready' && st.updateAvailable) && (
            <button className="btn primary" onClick={onRun} disabled={!st.tooling.npm || !st.tooling.git}>Обновить сейчас</button>
          )}
          {st.phase === 'done' && st.reload !== 'none' && (
            <button className="btn primary" onClick={onReload}>Перезагрузить сейчас</button>
          )}
          {(st.phase === 'error' || st.phase === 'cancelled') && <button className="btn primary" onClick={onCheck}>Проверить ещё раз</button>}
        </>
      }
    >
      <div className="upd">
        <div className="upd-vers">
          <div className="upd-ver">
            <span className="upd-lab">Установлено</span>
            <b className="upd-mono">{st.from || '—'}</b>
          </div>
          <span className="upd-arrow">→</span>
          <div className="upd-ver">
            <span className="upd-lab">В {st.branch || 'main'}</span>
            <b className="upd-mono">{st.to || '…'}</b>
          </div>
          <div className="upd-ver upd-repo">
            <span className="upd-lab">Репозиторий</span>
            <b className="upd-mono">{st.repo || '…'}</b>
          </div>
        </div>

        {checking && (
          <UpdateProgressView p={null} phase="running" msg="Проверяем обновления на GitHub…" />
        )}
        {st.phase === 'ready' && (
          st.updateAvailable ? (
            <div className="upd-msg ok">
              Доступна новая версия <b>{st.to}</b>{st.behind > 1 ? `: новых коммитов — ${st.behind}` : ''}.
              {st.latestMsg && <div className="upd-commit">«{st.latestMsg}»</div>}
            </div>
          ) : (
            <p className="upd-msg">Установлена актуальная версия — новых коммитов в {st.branch || 'main'} нет.</p>
          )
        )}

        {showProgress && <UpdateProgressView p={st.progress} phase={st.phase} msg={st.msg} />}

        {st.phase === 'done' && (
          <p className="upd-msg ok">
            {st.msg}
            {st.reload === 'waiting' && <><br />Ждём запуска новой версии — страница перезагрузится сама…</>}
            {st.reload === 'manual' && <><br />Нажмите «Перезагрузить сейчас», чтобы открыть новую версию.</>}
          </p>
        )}
        {st.phase === 'cancelled' && <p className="upd-msg">{st.msg}</p>}
        {st.phase === 'error' && <p className="upd-msg bad">{st.msg}</p>}

        {st.detail.length > 0 && (showProgress || st.phase === 'error') && (
          <>
            <button className="upd-logtoggle" onClick={() => setShowLog((v) => !v)}>
              {showLog ? '▾' : '▸'} Подробности ({st.detail.length})
            </button>
            {showLog && (
              <div className="upd-log" ref={(el) => { if (el) el.scrollTop = el.scrollHeight; }}>
                {st.detail.map((l, i) => <div key={i} className="upd-line">{l}</div>)}
              </div>
            )}
          </>
        )}

        {!st.tooling.git && <p className="upd-msg bad">Не найден git — установите его для обновления: sudo apt install git.</p>}
        {!st.tooling.npm && <p className="upd-msg bad">Не найден npm — установите Node.js для обновления.</p>}

        {!running && st.phase !== 'done' && (
          <p className="upd-note">
            Скачивается последняя версия из ветки <b>{st.branch || 'main'}</b>, затем программа
            пересобирается и перезапускается. Если зависимости не менялись, они берутся из кэша —
            обычно это занимает несколько секунд. Обновление можно свернуть и продолжать работу.
            Ваши платы не затрагиваются.
          </p>
        )}
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
