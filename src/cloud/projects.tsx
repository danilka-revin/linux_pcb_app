import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { download } from '../pcb/zip';
import { Modal } from '../ui/widgets';
import { cloudApi, cloudBytes, cloudDate, cloudError, type CloudProject, type CloudProjectDetail, type CloudUser, type ProjectMember } from './api';
import { ProgressBar, StatBar } from '../ui/progress';

export type CloudSaveState = 'local' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';
const LABELS: Record<CloudSaveState, string> = {
  local: 'Локальный черновик — не сохранён на сервере',
  saved: 'Все изменения сохранены на сервере',
  dirty: 'Изменения ожидают сохранения…',
  saving: 'Сохраняем на сервере…',
  error: 'Не удалось сохранить на сервере',
  conflict: 'Конфликт: проект изменён на другом компьютере',
};
export function cloudSaveLabel(status: CloudSaveState): string { return LABELS[status]; }

export function CloudProjectsDialog({ current, userId, docName, status, statusMessage, onClose, onCreate,
  onOpen, onSave, onReload, onRename, onDelete, onSaveFile }: {
  current: CloudProject | null;
  userId: string;
  docName: string;
  status: CloudSaveState;
  statusMessage: string;
  onClose: () => void;
  onCreate: (name: string) => Promise<void>;
  onOpen: (project: CloudProject) => Promise<boolean>;
  onSave: () => Promise<void>;
  onReload: () => Promise<boolean>;
  onRename: (project: CloudProject, name: string) => Promise<void>;
  onDelete: (project: CloudProject) => Promise<void>;
  onSaveFile: () => void;
}) {
  const [items, setItems] = useState<CloudProject[]>([]);
  const [used, setUsed] = useState(0);
  const [quota, setQuota] = useState(0);
  const [name, setName] = useState(docName);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shareProject, setShareProject] = useState<CloudProject | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [shareEmail, setShareEmail] = useState('');
  const [shareBusy, setShareBusy] = useState(false);
  const load = useCallback(async () => {
    const data = await cloudApi<{ projects: CloudProject[]; usedBytes: number; quotaBytes: number }>('/projects');
    setItems(data.projects); setUsed(data.usedBytes); setQuota(data.quotaBytes);
  }, []);
  useEffect(() => { let live = true; void load().catch((e) => { if (live) setError(cloudError(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; }; }, [load]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await fn(); await load(); }
    catch (e) { setError(cloudError(e)); }
    finally { setBusy(false); }
  };
  const shown = useMemo(() => items.filter((p) => p.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [items, filter]);
  const exportProject = (project: CloudProject) => void perform(async () => {
    const data = await cloudApi<{ project: CloudProjectDetail }>(`/projects/${project.id}`);
    download(`${data.project.name || 'board'}.laypcb.json`, new Blob([JSON.stringify(data.project.document, null, 1)], { type: 'application/json' }));
  });
  const showMembers = async (project: CloudProject) => {
    setShareProject(project); setShareEmail(''); setShareBusy(true); setError('');
    try {
      const result = await cloudApi<{ members: ProjectMember[] }>(`/projects/${project.id}/members`);
      setMembers(result.members);
    } catch (e) { setError(cloudError(e)); }
    finally { setShareBusy(false); }
  };
  const refreshMembers = async (project: CloudProject) => {
    const result = await cloudApi<{ members: ProjectMember[] }>(`/projects/${project.id}/members`);
    setMembers(result.members);
  };
  const inviteMember = async (e: FormEvent) => {
    e.preventDefault();
    if (!shareProject || !shareEmail.trim()) return;
    setShareBusy(true); setError('');
    try {
      await cloudApi(`/projects/${shareProject.id}/members`, 'POST', { email: shareEmail.trim() });
      setShareEmail(''); await refreshMembers(shareProject); await load();
    } catch (err) { setError(cloudError(err)); }
    finally { setShareBusy(false); }
  };
  const removeMember = async (member: ProjectMember) => {
    if (!shareProject || !window.confirm(`Отозвать у ${member.email} доступ к плате «${shareProject.name}»?`)) return;
    setShareBusy(true); setError('');
    try {
      await cloudApi(`/projects/${shareProject.id}/members/${member.id}`, 'DELETE');
      await refreshMembers(shareProject); await load();
    } catch (err) { setError(cloudError(err)); }
    finally { setShareBusy(false); }
  };

  return <Modal title="Облачные проекты" className="cloud-projects-modal" onClose={onClose}
    foot={<button className="btn" onClick={onClose}>Закрыть</button>}>
    <p>Платы приватны, пока вы не пригласите второго пользователя. Участники с доступом редактируют одну плату совместно; администратор сервера может просмотреть и скачать проекты.</p>
    <div className={'cloud-sync-banner ' + status} role="status">
      <span className="cloud-sync-dot" />
      <div><strong>{current ? current.name : 'Новая плата'}</strong><small>{cloudSaveLabel(status)}{statusMessage ? ` · ${statusMessage}` : ''}</small></div>
    </div>
    {(status === 'saving' || loading || busy) && <ProgressBar slim live indeterminate
      label="" title={status === 'saving' ? 'Отправка платы на сервер' : loading ? 'Загрузка списка проектов' : 'Операция с проектом'} />}
    {(status === 'error' || status === 'conflict') && <div className="cloud-alert" role="alert">
      {status === 'conflict' ? 'Сервер не перезаписан: скачайте свою копию или сохраните её как новый проект, затем откройте актуальную версию.'
        : 'Ваши изменения остались в редакторе. Повторите сохранение, когда соединение восстановится.'}
      <div className="row"><button className="btn" onClick={onSaveFile}>Скачать локальную копию</button>
        {current && status === 'error' && <button className="btn" disabled={busy} onClick={() => void perform(onSave)}>Повторить</button>}
        {current && status === 'conflict' && <button className="btn" disabled={busy} onClick={() => void perform(async () => { if (await onReload()) onClose(); })}>Загрузить версию с сервера</button>}</div>
    </div>}
    <div className="cloud-create">
      <label htmlFor="cloud-new-name">Сохранить текущую плату как новый проект</label>
      <div><input id="cloud-new-name" className="txt" value={name} maxLength={120} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) void perform(() => onCreate(name)); }} />
        <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void perform(() => onCreate(name))}>Сохранить копию</button></div>
      {current && status !== 'conflict' && <button className="btn" disabled={busy || status === 'saving'} onClick={() => void perform(onSave)}>Сохранить в «{current.name}»</button>}
    </div>
    <div className="cloud-list-head"><h3>Мои проекты <span>{items.length}</span></h3>
      <span>{cloudBytes(used)} / {cloudBytes(quota)}</span></div>
    <StatBar
      segments={[
        { id: 'used', label: 'занято', value: used, tone: used / Math.max(quota, 1) > 0.9 ? 'danger' : 'accent', hint: `${cloudBytes(used)} ваших файлов` },
        { id: 'free', label: 'свободно', value: Math.max(0, quota - used), tone: 'muted', hint: `${cloudBytes(Math.max(0, quota - used))} до квоты` },
      ]}
    />
    <div className="cloud-list-search"><input className="txt" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Найти проект по названию…" aria-label="Поиск проекта" />
      <button className="btn" disabled={busy} onClick={() => void perform(async () => { /* обновить список */ })} title="Обновить список">↻</button></div>
    <div className="cloud-list">
      {loading && <ProgressBar label="Загружаем проекты…" indeterminate live meta="запрашиваем список у сервера" />}
      {!loading && !shown.length && <p>{filter ? 'По вашему запросу ничего не найдено.' : 'Пока нет облачных проектов. Сохраните первую плату выше.'}</p>}
      {shown.map((p) => {
        const isOwner = p.ownerId === userId;
        const isSharedPanel = shareProject?.id === p.id;
        return <div className="cloud-project-entry" key={p.id}>
          <div className={'cloud-list-item' + (p.id === current?.id ? ' current' : '')}>
            <div className="cloud-list-meta"><strong>{p.name}{p.id === current?.id && <span className="cloud-pill ok">Открыт</span>}
              {!isOwner && <span className="cloud-pill">Общая</span>}</strong>
              <small>{cloudDate(p.updatedAt)} · {p.entityCount} эл. · {cloudBytes(p.bytes)} · версия {p.version}
                {!isOwner && ` · владелец: ${p.ownerEmail ?? 'другой пользователь'}`}</small></div>
            <div className="cloud-list-actions">
              <button className="btn tiny" disabled={busy || p.id === current?.id} onClick={() => void perform(async () => { if (await onOpen(p)) onClose(); })}>Открыть</button>
              <button className="btn tiny" disabled={busy} onClick={() => void showMembers(p)}>{isSharedPanel ? 'Обновить доступ' : 'Участники'}</button>
              <button className="btn tiny" disabled={busy || !isOwner} title={isOwner ? 'Переименовать проект' : 'Переименовывать может владелец'} onClick={() => {
                const next = window.prompt('Новое название проекта:', p.name);
                if (next && next.trim() !== p.name) void perform(() => onRename(p.id === current?.id ? current : p, next));
              }}>Переименовать</button>
              <button className="btn tiny" disabled={busy} onClick={() => exportProject(p)}>Скачать</button>
              <button className="btn tiny danger" disabled={busy || !isOwner} title={isOwner ? 'Удалить проект' : 'Удалять может владелец'} onClick={() => {
                if (window.confirm(`Безвозвратно удалить «${p.name}» из облака?`)) void perform(() => onDelete(p.id === current?.id ? current : p));
              }}>Удалить</button>
            </div>
          </div>
          {isSharedPanel && <section className="cloud-sharing-panel">
            <div><strong>Совместная работа · {p.name}</strong><small>{isOwner ? 'Управлять доступом может владелец.' : 'Доступ выдан владельцем проекта.'}</small></div>
            {shareBusy ? <ProgressBar slim live indeterminate label="Загружаем участников…" /> : <ul>
              {members.map((member) => <li key={member.id}>
                <span><b>{member.email}</b><small>{member.role === 'owner' ? 'Владелец' : 'Редактор'}</small></span>
                {isOwner && member.role === 'editor' && <button className="btn tiny danger" disabled={shareBusy} onClick={() => void removeMember(member)}>Отозвать доступ</button>}
              </li>)}
            </ul>}
            {isOwner && <form className="cloud-share-form" onSubmit={(e) => void inviteMember(e)}>
              <label htmlFor={`share-${p.id}`}>Пригласить пользователя по имени (нику) или почте</label>
              <div><input id={`share-${p.id}`} className="txt" type="text" autoComplete="off" required maxLength={254}
                value={shareEmail} onChange={(e) => setShareEmail(e.target.value)} placeholder="Имя (ник) коллеги" />
                <button className="btn primary" type="submit" disabled={shareBusy || members.some((member) => member.role === 'editor')}>Добавить редактора</button></div>
              <small>Пользователь должен сначала войти на сервер. Всего к плате подключаются владелец и один редактор.</small>
            </form>}
          </section>}
        </div>;
      })}
    </div>
    {error && <div className="cloud-error" role="alert">{error}</div>}
    <p className="cloud-footnote">Работаете на нескольких компьютерах? Откройте проект из списка. При одновременном редактировании старая версия не затрёт новую.</p>
  </Modal>;
}

export function CloudAccountDialog({ user, onClose, onLogout }: {
  user: CloudUser; onClose: () => void; onLogout: () => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) { setError('Пароли не совпадают.'); return; }
    setBusy(true); setError(''); setDone('');
    try {
      await cloudApi('/password', 'POST', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setRepeat(''); setDone('Пароль изменён. Все остальные сеансы завершены.');
    } catch (err) { setError(cloudError(err)); }
    finally { setBusy(false); }
  };
  return <Modal title="Учётная запись" className="cloud-account-modal" onClose={onClose}
    foot={<><button className="btn" onClick={onClose}>Закрыть</button><button className="btn danger" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await onLogout(); } catch (err) { setError(cloudError(err)); }
      finally { setBusy(false); }
    }}>Выйти из аккаунта</button></>}>
    <p><strong>{user.email}</strong> · {user.role === 'admin' ? 'Администратор' : 'Пользователь'}</p>
    {user.role === 'admin' && <p><a className="admin-link" href="/admin">Перейти в админ-панель →</a></p>}
    <h3>Сменить пароль</h3>
    <form className="cloud-password-form" onSubmit={(e) => void changePassword(e)}>
      <label>Текущий пароль<input className="txt" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
      <label>Новый пароль<input className="txt" type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} /></label>
      <label>Повторите новый пароль<input className="txt" type="password" autoComplete="new-password" required value={repeat} onChange={(e) => setRepeat(e.target.value)} /></label>
      <button className="btn primary" type="submit" disabled={busy}>Сменить пароль</button>
    </form>
    {done && <p className="cloud-success" role="status">{done}</p>}
    {error && <div className="cloud-error" role="alert">{error}</div>}
  </Modal>;
}
