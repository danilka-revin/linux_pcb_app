import { useEffect, useState } from 'react';
import { download } from '../pcb/zip';
import {
  cloudApi, cloudBytes, cloudDate, cloudError,
  type AdminUser, type CloudEvent, type CloudOverview, type CloudProject,
  type CloudProjectDetail, type CloudUser,
} from './api';

type Tab = 'overview' | 'users' | 'projects' | 'events';
const EVENTS: Record<string, string> = {
  'admin.bootstrap': 'Создан администратор', 'admin.password_reset_cli': 'Сброшен пароль администратора',
  'user.register': 'Регистрация', 'user.login': 'Вход', 'user.password_change': 'Смена пароля',
  'user.password_reset_cli': 'Пароль пользователя сброшен на сервере',
  'project.create': 'Создан проект', 'project.save': 'Сохранён проект',
  'project.rename': 'Переименован проект', 'project.delete': 'Удалён проект',
  'admin.user.disable': 'Пользователь заблокирован', 'admin.user.enable': 'Пользователь разблокирован',
  'admin.user.role': 'Изменена роль', 'admin.user.sessions_revoked': 'Сеансы отозваны',
  'admin.user.delete': 'Пользователь удалён', 'admin.project.delete': 'Проект удалён администратором',
  'admin.project.download': 'Администратор скачал проект',
  'admin.registration': 'Изменена регистрация',
};
const PAGE_SIZE = 30;
function Pagination({ total, page, setPage }: { total: number; page: number; setPage: (n: number) => void }) {
  if (total <= PAGE_SIZE) return null;
  return <div className="cloud-pages">
    <button className="btn" disabled={!page} onClick={() => setPage(page - 1)}>← Назад</button>
    <span>{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} из {total}</span>
    <button className="btn" disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Далее →</button>
  </div>;
}

export default function AdminApp({ user, onLogout }: { user: CloudUser; onLogout: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<CloudOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [projects, setProjects] = useState<CloudProject[]>([]);
  const [events, setEvents] = useState<CloudEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => { setPage(0); setQuery(search); }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    const params = `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&q=${encodeURIComponent(query)}`;
    (async () => {
      try {
        const summary = await cloudApi<CloudOverview>('/admin/overview');
        if (active) setOverview(summary);
        if (tab === 'users') {
          const data = await cloudApi<{ total: number; users: AdminUser[] }>('/admin/users' + params);
          if (active) { setUsers(data.users); setTotal(data.total); }
        } else if (tab === 'projects') {
          const data = await cloudApi<{ total: number; projects: CloudProject[] }>(
            '/admin/projects' + params + (ownerId ? '&ownerId=' + encodeURIComponent(ownerId) : ''),
          );
          if (active) { setProjects(data.projects); setTotal(data.total); }
        } else {
          const data = await cloudApi<{ total: number; events: CloudEvent[] }>(
            `/admin/events?limit=${tab === 'overview' ? 6 : PAGE_SIZE}&offset=${tab === 'overview' ? 0 : page * PAGE_SIZE}`,
          );
          if (active) { setEvents(data.events); setTotal(data.total); }
        }
      } catch (e) { if (active) setError(cloudError(e)); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [tab, page, query, ownerId, refresh]);

  const switchTab = (next: Tab) => { setTab(next); setPage(0); setSearch(''); setQuery(''); setOwnerId(''); };
  const action = async (run: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await run(); setRefresh((n) => n + 1); }
    catch (e) { setError(cloudError(e)); }
    finally { setBusy(false); }
  };
  const setDisabled = (target: AdminUser) => {
    if (!window.confirm(target.disabled ? `Разблокировать ${target.email}?` : `Заблокировать ${target.email}? Все его сеансы будут завершены.`)) return;
    void action(() => cloudApi(`/admin/users/${target.id}`, 'PATCH', { disabled: !target.disabled }));
  };
  const setRole = (target: AdminUser) => {
    const role = target.role === 'user' ? 'admin' : 'user';
    if (!window.confirm(`Изменить роль ${target.email} на «${role === 'admin' ? 'администратор' : 'пользователь'}»? Все сеансы будут завершены.`)) return;
    void action(() => cloudApi(`/admin/users/${target.id}`, 'PATCH', { role }));
  };
  const removeUser = (target: AdminUser) => {
    if (window.prompt(`Безвозвратно удалить пользователя, все его проекты и сеансы? Введите адрес ${target.email} для подтверждения:`) !== target.email) return;
    void action(() => cloudApi(`/admin/users/${target.id}`, 'DELETE'));
  };
  const removeProject = (target: CloudProject) => {
    if (window.prompt(`Удалить проект «${target.name}» пользователя ${target.ownerEmail}? Введите название проекта:`) !== target.name) return;
    void action(() => cloudApi(`/admin/projects/${target.id}`, 'DELETE'));
  };
  const exportProject = (target: CloudProject) => void action(async () => {
    const { project } = await cloudApi<{ project: CloudProjectDetail }>(`/admin/projects/${target.id}`);
    download(`${project.name || 'board'}.laypcb.json`, new Blob([JSON.stringify(project.document, null, 1)], { type: 'application/json' }));
  });
  const viewProjects = (target: AdminUser) => {
    setTab('projects'); setPage(0); setSearch(''); setQuery(''); setOwnerId(target.id);
  };

  return <div className="cloud-admin">
    <header className="admin-header">
      <div className="admin-title"><img src="/logo.png" alt="" width={37} height={37} /><div><b>PS<em>Bees</em> · Администрирование</b><small>Локальный сервер проектов</small></div></div>
      <div className="admin-header-actions"><span title={user.email}>{user.email}</span><a className="btn" href="/">Открыть редактор</a>
        <button className="btn" onClick={() => void action(onLogout)}>Выйти</button></div>
    </header>
    <nav className="admin-nav" aria-label="Разделы управления">
      {([['overview', 'Обзор'], ['users', 'Пользователи'], ['projects', 'Проекты'], ['events', 'Журнал действий']] as const).map(([id, name]) =>
        <button key={id} className={tab === id ? 'on' : ''} onClick={() => switchTab(id)}>{name}</button>)}
    </nav>
    <main className="admin-body">
      <div className="admin-heading"><div><h1>{tab === 'overview' ? 'Обзор сервера' : tab === 'users' ? 'Пользователи' : tab === 'projects' ? 'Проекты' : 'Журнал действий'}</h1>
        <p>{tab === 'overview' ? 'Состояние общего хранилища и управление регистрацией' : tab === 'users' ? 'Учётные записи, роли и доступ' : tab === 'projects' ? 'Все платы на сервере: владельцы и резервные копии' : 'Последние изменения на сервере'}</p></div>
        <button className="btn" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>↻ Обновить</button></div>
      {error && <div className="cloud-error" role="alert">{error}</div>}
      {tab === 'overview' && <>
        <div className="admin-stats">
          <div><span>Пользователи</span><strong>{overview?.users ?? '—'}</strong><small>Отключены: {overview?.disabledUsers ?? '—'}</small></div>
          <div><span>Проекты</span><strong>{overview?.projects ?? '—'}</strong><small>По всем владельцам</small></div>
          <div><span>Занято на сервере</span><strong>{overview ? cloudBytes(overview.bytes) : '—'}</strong><small>Лимит аккаунта: {overview ? cloudBytes(overview.quotaBytes) : '—'}</small></div>
          <div><span>Активные сеансы</span><strong>{overview?.activeSessions ?? '—'}</strong><small>Срок действия: 14 дней</small></div>
        </div>
        <section className="admin-card"><h2>Регистрация по почте</h2><p>Если закрыть регистрацию, новые пользователи не смогут создать аккаунт. Существующие сохранят доступ.</p>
          <div className="admin-settings"><span className={overview?.registrationOpen ? 'cloud-pill ok' : 'cloud-pill'}>{overview?.registrationOpen ? 'Открыта' : 'Закрыта'}</span>
            <button className="btn" disabled={busy || !overview} onClick={() => {
              if (!overview || !window.confirm(overview.registrationOpen ? 'Закрыть регистрацию новых пользователей?' : 'Разрешить регистрацию новых пользователей?')) return;
              void action(() => cloudApi('/admin/settings', 'PATCH', { registrationOpen: !overview.registrationOpen }));
            }}>{overview?.registrationOpen ? 'Закрыть регистрацию' : 'Открыть регистрацию'}</button></div>
        </section>
        <section className="admin-card"><h2>Резервное копирование</h2>
          <p>Проекты и учётные записи хранятся в SQLite-каталоге <code>PSBEES_DATA_DIR</code>. Делайте регулярные копии базы вместе с WAL/SHM или через SQLite Online Backup, не кладите каталог внутрь <code>dist</code>. Отдельный проект можно скачать в разделе «Проекты».</p></section>
        <section className="admin-card"><h2>Забыт пароль?</h2>
          <p>На сервере выполните <code>node scripts/cloud-admin.mjs reset-user-password user@example.com</code> — пароль вводится скрыто, проекты не удаляются. Администратор может восстановить свой доступ командой <code>reset-admin-password</code>. Передавайте новый пароль лично, а не в общем чате.</p></section>
        <section className="admin-card"><div className="admin-card-title"><h2>Последние действия</h2><button className="btn tiny" onClick={() => switchTab('events')}>Весь журнал →</button></div>
          {events.length ? <div className="admin-events">{events.map((e) => <div key={e.id}><time>{cloudDate(e.at)}</time><span>{EVENTS[e.action] ?? e.action}</span><small>{e.actorEmail || 'Системный администратор'} {e.detail && `· ${e.detail}`}</small></div>)}</div> : <p>Действий пока нет.</p>}</section>
      </>}
      {(tab === 'users' || tab === 'projects') && <div className="admin-filters">
        <input className="txt" type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={120}
          placeholder={tab === 'users' ? 'Поиск по почте…' : 'Поиск по названию или почте владельца…'} aria-label="Поиск" />
        {ownerId && <button className="btn" onClick={() => { setOwnerId(''); setPage(0); }}>Сбросить фильтр владельца ×</button>}
        <span>{total} {tab === 'users' ? 'пользователей' : 'проектов'}</span>
      </div>}
      {tab === 'users' && <div className="admin-table-wrap"><table className="admin-table"><thead><tr>
        <th>Почта</th><th>Доступ</th><th>Проекты</th><th>Зарегистрирован</th><th>Последний вход</th><th>Действия</th>
      </tr></thead><tbody>{users.map((u) => <tr key={u.id}>
        <td><strong>{u.email}</strong>{u.id === user.id && <small>Это вы</small>}</td>
        <td><span className={'cloud-pill' + (u.disabled ? ' bad' : u.role === 'admin' ? ' ok' : '')}>{u.disabled ? 'Заблокирован' : u.role === 'admin' ? 'Администратор' : 'Пользователь'}</span></td>
        <td><button className="admin-link" onClick={() => viewProjects(u)}>{u.projectCount} · {cloudBytes(u.bytes)}</button></td>
        <td>{cloudDate(u.createdAt)}</td><td>{u.lastLogin ? cloudDate(u.lastLogin) : '—'}</td>
        <td><div className="admin-actions"><button className="btn tiny" disabled={busy || u.id === user.id} onClick={() => setDisabled(u)}>{u.disabled ? 'Разблокировать' : 'Блокировать'}</button>
          <button className="btn tiny" disabled={busy || u.id === user.id} onClick={() => setRole(u)}>{u.role === 'admin' ? 'Снять роль' : 'Сделать админом'}</button>
          <button className="btn tiny" disabled={busy} onClick={() => {
            if (window.confirm(`Завершить все сеансы пользователя ${u.email}?`)) void action(() => cloudApi(`/admin/users/${u.id}/sessions`, 'DELETE'));
          }}>Отозвать сеансы</button>
          <button className="btn tiny danger" disabled={busy || u.id === user.id} onClick={() => removeUser(u)}>Удалить</button></div></td>
      </tr>)}</tbody></table>{!users.length && !busy && <div className="admin-empty">Пользователи не найдены.</div>}</div>}
      {tab === 'projects' && <div className="admin-table-wrap"><table className="admin-table"><thead><tr>
        <th>Проект</th><th>Владелец</th><th>Элементы</th><th>Размер</th><th>Изменён</th><th>Действия</th>
      </tr></thead><tbody>{projects.map((p) => <tr key={p.id}>
        <td><strong>{p.name}</strong><small>Версия {p.version}</small></td><td>{p.ownerEmail}</td>
        <td>{p.entityCount}</td><td>{cloudBytes(p.bytes)}</td><td>{cloudDate(p.updatedAt)}</td>
        <td><div className="admin-actions"><button className="btn tiny" disabled={busy} onClick={() => exportProject(p)}>Скачать JSON</button>
          <button className="btn tiny danger" disabled={busy} onClick={() => removeProject(p)}>Удалить</button></div></td>
      </tr>)}</tbody></table>{!projects.length && !busy && <div className="admin-empty">Проекты не найдены.</div>}</div>}
      {tab === 'events' && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Время</th><th>Действие</th><th>Пользователь</th><th>Детали</th></tr></thead>
        <tbody>{events.map((e) => <tr key={e.id}><td>{cloudDate(e.at)}</td><td>{EVENTS[e.action] ?? e.action}</td><td>{e.actorEmail || 'Администратор сервера'}</td><td>{e.detail}</td></tr>)}</tbody>
      </table>{!events.length && !busy && <div className="admin-empty">Записей пока нет.</div>}</div>}
      {tab !== 'overview' && <Pagination total={total} page={page} setPage={setPage} />}
    </main>
  </div>;
}
