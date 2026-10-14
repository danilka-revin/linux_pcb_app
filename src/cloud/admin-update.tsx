// Обновление программы из GitHub прямо из админ-панели общего сервера.
// Сам сервер проверяет права администратора и выполняет git/npm/сборку (scripts/server.mjs);
// здесь — проверка версии, запуск, ход выполнения и перезагрузка страницы после перезапуска.
import { useEffect, useRef, useState } from 'react';
import { cloudApi, cloudError, CloudError, type CloudUpdateCheck } from './api';
import { UpdateProgressView, type UpdatePhase, type UpdateProgress } from '../ui/updater';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FOLLOW_FAILS_MAX = 60;
const RESTART_WAIT_MS = 90_000;

/** Ответ /admin/update/status в формате UpdateProgress. */
function progressOf(s: any): UpdateProgress {
  return {
    stages: Array.isArray(s.stages) ? s.stages : [],
    stage: s.stage || '', pct: Number(s.pct) || 0,
    bytes: Number(s.bytes) || 0, total: Number(s.total) || 0, exact: !!s.exact,
    speed: Number(s.speed) || 0, eta: s.eta ?? null, elapsed: Number(s.elapsed) || 0,
    count: Number(s.count) || 0, countTotal: Number(s.countTotal) || 0,
    cancelable: !!s.cancelable, restart: !!s.restart, mode: s.mode || '',
  };
}

export default function AdminUpdatePanel() {
  const [check, setCheck] = useState<CloudUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [msg, setMsg] = useState('');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const [reload, setReload] = useState<'none' | 'waiting' | 'manual'>('none');
  const [error, setError] = useState('');
  const alive = useRef(true);
  const following = useRef(false);

  const applyStatus = (s: any) => {
    setProgress(progressOf(s));
    setOutput(String(s.output || '').split('\n').filter(Boolean));
    if (s.phase) setMsg(String(s.phase));
  };

  /** После установки сервер перезапускается: ждём его и перезагружаем страницу. */
  const awaitRestart = async (expect: string) => {
    setReload('waiting');
    const until = Date.now() + RESTART_WAIT_MS;
    let sawDown = false;
    await sleep(800);
    while (alive.current && Date.now() < until) {
      try {
        const version = await (await fetch('/version', { cache: 'no-store' })).json();
        const current = String(version?.short || version?.sha || '');
        if (sawDown || (expect && current.startsWith(expect.slice(0, 7)))) {
          window.location.reload();
          return;
        }
      } catch {
        sawDown = true;
      }
      await sleep(600);
    }
    if (alive.current) setReload('manual');
  };

  /** Следить за ходом обновления (long-poll по ревизии). */
  const follow = async () => {
    if (following.current) return;
    following.current = true;
    let rev = -1;
    let fails = 0;
    try {
      while (alive.current) {
        let s: any;
        try {
          s = await cloudApi<any>('/admin/update/status' + (rev >= 0 ? `?since=${rev}` : ''));
          fails = 0;
        } catch {
          // сервер может перезапускаться: подождать и продолжить
          if (++fails > FOLLOW_FAILS_MAX) {
            setPhase('error');
            setMsg('Сервер не отвечает. Проверьте, что программа запущена, и обновите страницу.');
            return;
          }
          await sleep(1000);
          continue;
        }
        rev = Number(s.rev) || 0;
        applyStatus(s);
        if (s.status === 'busy') { setPhase('running'); continue; }
        if (s.status === 'done') {
          setPhase('done');
          setMsg(s.phase || 'Обновление установлено.');
          if ((s.changes ?? 0) > 0) {
            if (s.restart) void awaitRestart(String(s.to || ''));
            else setReload('manual');
          }
          return;
        }
        if (s.status === 'cancelled') { setPhase('cancelled'); setMsg(s.phase || 'Обновление отменено.'); return; }
        if (s.status === 'error') { setPhase('error'); setMsg(s.error || 'Обновление не удалось.'); return; }
        setPhase('idle');
        return;
      }
    } finally {
      following.current = false;
    }
  };

  const checkNow = async (force = false) => {
    setChecking(true); setError('');
    try {
      const data = await cloudApi<CloudUpdateCheck>('/admin/update/check' + (force ? '?force=1' : ''));
      if (alive.current) setCheck(data);
    } catch (e) {
      if (alive.current) setError(cloudError(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const start = async () => {
    if (!window.confirm('Обновить программу с GitHub? Сервер перезапустится, и пользователи на несколько секунд потеряют соединение.')) return;
    setError(''); setPhase('running'); setMsg('Запуск обновления…');
    setProgress(null); setOutput([]); setReload('none');
    try {
      await cloudApi('/admin/update/run', 'POST', {});
      await follow();
    } catch (e) {
      // 409 — обновление уже идёт (например, в другой вкладке): просто следим за ним
      if (e instanceof CloudError && e.status === 409) { await follow(); return; }
      setPhase('error'); setMsg(cloudError(e));
    }
  };

  const cancel = async () => {
    try { await cloudApi('/admin/update/cancel', 'POST', {}); }
    catch (e) { setError(cloudError(e)); }
  };

  useEffect(() => {
    alive.current = true;
    void checkNow();
    void (async () => {
      // обновление уже идёт (открыли админку посреди установки) — подхватываем
      try {
        const s = await cloudApi<any>('/admin/update/status');
        if (alive.current && s?.status === 'busy') { applyStatus(s); await follow(); }
      } catch { /* сервер без обновления */ }
    })();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = phase === 'running';
  const toolingLacking = check && (!check.tooling.npm || (check.mode === 'clone' && !check.tooling.git));
  return <section className="admin-card admin-update" aria-label="Обновление программы">
    <h2>Обновление программы из GitHub</h2>
    <p>Новая версия берётся из ветки <b>{check?.branch ?? 'main'}</b> репозитория <b>{check?.repo ?? '—'}</b>.
      Сервер скачает изменения, соберёт приложение и перезапустится сам. Пароли и проекты при этом не меняются.</p>
    <div className="admin-update-facts">
      <div><span>Установлено сейчас</span><strong>{check?.local || '—'}</strong>
        <small>{check ? (check.mode === 'clone' ? 'Установка из git-копии' : 'Установленная программа') : ''}</small></div>
      <div><span>Последний коммит на GitHub</span><strong>{check?.latest || '—'}</strong>
        <small>{check?.latestMsg ? `${check.latestMsg}${check.latestDate ? ` · ${cloudDateLabel(check.latestDate)}` : ''}` : ''}</small></div>
      <div><span>Состояние</span>
        <strong>{checking && !check ? 'Проверяем…' : check ? (check.updateAvailable ? `Доступно обновлений: ${check.behind}` : 'Актуальная версия') : '—'}</strong>
        <small>{check?.cached ? 'Ответ из кэша (до минуты)' : ''}</small></div>
    </div>
    {toolingLacking && <div className="cloud-alert" role="alert">
      На сервере не найдено {!check?.tooling.npm ? 'npm' : 'git'}. Установите его (см. INSTALL_UBUNTU.md) и повторите проверку.
    </div>}
    <div className="admin-update-actions">
      <button className="btn" disabled={checking || running} onClick={() => void checkNow(true)}>
        {checking ? 'Проверяем…' : 'Проверить на GitHub'}
      </button>
      <button className="btn primary" disabled={running || checking || !check?.updateAvailable || !!toolingLacking} onClick={() => void start()}>
        Обновить с GitHub
      </button>
      {running && <button className="btn" onClick={() => void cancel()}>Отменить</button>}
    </div>
    {phase !== 'idle' && <UpdateProgressView p={progress} phase={phase} msg={msg} />}
    {reload === 'waiting' && <p role="status">Сервер перезапускается с новой версией. Страница обновится сама.</p>}
    {reload === 'manual' && <p role="status">Обновление установлено. <button className="btn" onClick={() => window.location.reload()}>Обновить страницу</button></p>}
    {output.length > 0 && <pre className="admin-update-log" aria-label="Журнал обновления">{output.join('\n')}</pre>}
    {error && <div className="cloud-error" role="alert">{error}</div>}
  </section>;
}

function cloudDateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}
