import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { download } from '../pcb/zip';
import {
  cloudApi, cloudBytes, cloudDate, cloudError,
  type AdminUser, type AdminUserProfile, type CloudEvent, type CloudOverview, type CloudProject,
  type CloudProjectDetail, type CloudUser,
} from './api';
import AdminUpdatePanel from './admin-update';

type Tab = 'overview' | 'users' | 'projects' | 'events' | 'update';
const MIB = 1024 * 1024;
const QUOTA_PRESETS_MB = [50, 100, 250, 500, 1024, 5120];

const EVENTS: Record<string, string> = {
  'admin.bootstrap': 'Создан администратор', 'admin.password_reset_cli': 'Сброшен пароль администратора',
  'user.register': 'Регистрация', 'user.login': 'Вход', 'user.password_change': 'Смена пароля',
  'user.password_reset_cli': 'Пароль пользователя сброшен на сервере',
  'admin.user.create': 'Администратор создал пользователя',
  'admin.user.rename': 'Изменено имя или почта пользователя',
  'admin.user.quota': 'Изменён индивидуальный лимит пользователя',
  'admin.user.password_set': 'Администратор задал пароль пользователю',
  'admin.user.password_reset': 'Администратор выдал временный пароль',
  'admin.user.must_change_password': 'Изменено требование смены пароля',
  'admin.user.verify': 'Изменено подтверждение почты',
  'admin.user.projects_clear': 'Очищены проекты пользователя',
  'admin.user.view': 'Администратор открыл сводку пользователя',
  'project.create': 'Создан проект', 'project.save': 'Сохранён проект',
  'project.rename': 'Переименован проект', 'project.delete': 'Удалён проект',
  'project.sync': 'Синхронизирован проект',
  'project.member.add': 'Приглашён редактор проекта',
  'project.member.remove': 'Отозван доступ к проекту',
  'version.create': 'Сохранена версия проекта', 'version.delete': 'Удалена версия проекта',
  'library.publish': 'Деталь опубликована в общей библиотеке',
  'library.update': 'Общая деталь обновлена', 'library.delete': 'Общая деталь удалена',
  'admin.user.disable': 'Пользователь заблокирован', 'admin.user.enable': 'Пользователь разблокирован',
  'admin.user.role': 'Изменена роль', 'admin.user.sessions_revoked': 'Сеансы отозваны',
  'admin.user.delete': 'Пользователь удалён',
  'admin.project.rename': 'Проект переименован администратором',
  'admin.project.transfer': 'Проект передан другому пользователю',
  'admin.project.member_remove': 'Администратор отозвал доступ к проекту',
  'admin.project.delete': 'Проект удалён администратором',
  'admin.project.download': 'Администратор скачал проект',
  'admin.registration': 'Изменена регистрация',
  'admin.quota': 'Изменены лимиты аккаунта',
  'admin.update.run': 'Запущено обновление программы из GitHub',
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

function generateRandomPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%&*-_';
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function UserProfilePanel({
  profile, loading, error, busy, isCurrentUser, onResetPassword, onRevokeSessions, onShowOwnerProjects,
  onUpdateUser, onClearUserProjects, onDeleteUser,
  onExportProject, onRenameProject, onTransferProject, onDeleteProject, onRevokeSharedProject,
}: {
  profile: AdminUserProfile | null; loading: boolean; error: string; busy: boolean; isCurrentUser: boolean;
  onResetPassword: () => void; onRevokeSessions: () => void; onShowOwnerProjects: (ownerId: string) => void;
  onUpdateUser?: (patch: Record<string, unknown>) => void;
  onClearUserProjects?: () => void;
  onDeleteUser?: () => void;
  onExportProject?: (project: CloudProject) => void;
  onRenameProject?: (project: CloudProject) => void;
  onTransferProject?: (project: CloudProject) => void;
  onDeleteProject?: (project: CloudProject) => void;
  onRevokeSharedProject?: (project: CloudProject) => void;
}) {
  const [loginInput, setLoginInput] = useState('');
  const [quotaMbInput, setQuotaMbInput] = useState('');
  const [maxProjectsInput, setMaxProjectsInput] = useState('');
  const [customPassword, setCustomPassword] = useState('');
  const [requireChangeOnSet, setRequireChangeOnSet] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setLoginInput(profile.user.email);
    const qBytes = profile.user.customQuotaBytes ?? profile.quotaBytes;
    setQuotaMbInput(String(Math.max(1, Math.round(qBytes / MIB))));
    const maxP = profile.user.customMaxProjects ?? profile.maxProjects ?? 1000;
    setMaxProjectsInput(String(maxP));
    setCustomPassword('');
  }, [profile?.user.id, profile?.user.email, profile?.user.customQuotaBytes, profile?.quotaBytes, profile?.user.customMaxProjects, profile?.maxProjects]);

  if (loading) return <div className="admin-user-profile"><p>Загружаем полную сводку…</p></div>;
  if (error) return <div className="admin-user-profile"><div className="cloud-error" role="alert">{error}</div></div>;
  if (!profile) return null;
  const { user, ownedProjects, sharedProjects } = profile;
  const effectiveMaxProjects = profile.maxProjects ?? user.maxProjects ?? 1000;
  const defaultQuotaBytes = profile.defaultQuotaBytes ?? profile.quotaBytes;
  const defaultMaxProjects = profile.defaultMaxProjects ?? 1000;
  const hasCustomLimits = (user.customQuotaBytes !== null && user.customQuotaBytes !== undefined)
    || (user.customMaxProjects !== null && user.customMaxProjects !== undefined);

  const saveUserLimits = (e: FormEvent) => {
    e.preventDefault();
    if (!onUpdateUser) return;
    const mb = Number(quotaMbInput);
    const maxP = Number(maxProjectsInput);
    if (!Number.isInteger(mb) || mb < 1 || mb > 1_000_000) return;
    if (!Number.isInteger(maxP) || maxP < 1 || maxP > 100_000) return;
    onUpdateUser({ quotaBytes: mb * MIB, maxProjects: maxP });
  };

  const resetUserLimits = () => {
    if (!onUpdateUser) return;
    onUpdateUser({ quotaBytes: null, maxProjects: null });
  };

  const submitRename = (e: FormEvent) => {
    e.preventDefault();
    if (!onUpdateUser || !loginInput.trim() || loginInput.trim() === user.email) return;
    onUpdateUser({ email: loginInput.trim() });
  };

  const submitCustomPassword = (e: FormEvent) => {
    e.preventDefault();
    if (!onUpdateUser || customPassword.length < 10) return;
    onUpdateUser({
      newPassword: customPassword,
      ...(isCurrentUser ? {} : { mustChangePassword: requireChangeOnSet }),
    });
    setCustomPassword('');
  };

  const projectList = (items: CloudProject[], shared: boolean) => items.length
    ? <div className="admin-profile-projects">{items.map((project) => <div className="admin-profile-project" key={project.id}>
      <div><strong>{project.name}</strong><small>{shared ? `Владелец: ${project.ownerEmail || 'неизвестен'} · ` : ''}Версия {project.version} · {project.entityCount} элементов · {cloudBytes(project.bytes)} · {cloudDate(project.updatedAt)}</small></div>
      <div className="admin-actions">
        <button className="btn tiny" onClick={() => onShowOwnerProjects(project.ownerId)}>Проекты владельца</button>
        {onExportProject && <button className="btn tiny" disabled={busy} onClick={() => onExportProject(project)}>Скачать</button>}
        {!shared && onRenameProject && <button className="btn tiny" disabled={busy} onClick={() => onRenameProject(project)}>Переименовать</button>}
        {!shared && onTransferProject && <button className="btn tiny" disabled={busy} onClick={() => onTransferProject(project)}>Передать</button>}
        {!shared && onDeleteProject && <button className="btn tiny danger" disabled={busy} onClick={() => onDeleteProject(project)}>Удалить</button>}
        {shared && onRevokeSharedProject && <button className="btn tiny danger" disabled={busy} onClick={() => onRevokeSharedProject(project)}>Отозвать доступ</button>}
      </div>
    </div>)}</div>
    : <p className="admin-profile-muted">Нет проектов.</p>;

  return <div className="admin-user-profile">
    <div className="admin-profile-summary">
      <div><span>Почта и 2FA</span><strong>{profile.twoFactorRequired ? 'Код требуется при каждом входе' : 'Не включена'}</strong>
        <small>{user.emailVerifiedAt ? `Подтверждена ${cloudDate(user.emailVerifiedAt)}` : 'Почта ещё не подтверждена'}</small></div>
      <div><span>Проекты</span><strong>{profile.projectCount} своих · {profile.sharedProjectCount} общих</strong>
        <small>{profile.versionCount} сохранённых версий · лимит: {effectiveMaxProjects}</small></div>
      <div><span>Хранилище</span><strong>{cloudBytes(profile.bytes)} / {cloudBytes(profile.quotaBytes)}</strong>
        <small>{hasCustomLimits ? 'Индивидуальный лимит аккаунта' : 'Общий лимит сервера'} · общие платы: {cloudBytes(profile.sharedBytes)}</small></div>
      <div><span>Сеансы и действия</span><strong>{profile.activeSessions.length} активных · {profile.actionCount} действий</strong>
        <small>{profile.activeSessions.length ? `Последний сеанс создан ${cloudDate(profile.activeSessions[0].createdAt)}` : 'Активных сеансов нет'}</small></div>
      <div><span>Состояние аккаунта</span><strong>{user.disabled ? 'Заблокирован' : 'Активен'}</strong>
        <small>{user.mustChangePassword ? 'При следующем входе обязательна смена пароля' : 'Смена пароля не требуется'}</small></div>
    </div>

    <div className="admin-profile-columns">
      <section>
        <h3>Лимит аккаунта пользователя</h3>
        <form className="admin-user-form" onSubmit={saveUserLimits}>
          <div className="admin-form-grid">
            <label>Лимит хранилища (МиБ)
              <input className="txt" type="number" min={1} max={1000000} required value={quotaMbInput}
                onChange={(e) => setQuotaMbInput(e.target.value)} aria-label="Индивидуальный лимит хранилища (МиБ)" />
            </label>
            <label>Макс. проектов (шт.)
              <input className="txt" type="number" min={1} max={100000} required value={maxProjectsInput}
                onChange={(e) => setMaxProjectsInput(e.target.value)} aria-label="Индивидуальный лимит проектов" />
            </label>
          </div>
          <div className="admin-preset-row">
            <span>Быстрый выбор:</span>
            {QUOTA_PRESETS_MB.map((mb) => <button key={mb} type="button" className="btn tiny" disabled={busy}
              onClick={() => setQuotaMbInput(String(mb))}>{mb >= 1024 ? `${mb / 1024} ГБ` : `${mb} МиБ`}</button>)}
          </div>
          <div className="admin-actions">
            <button className="btn tiny primary" type="submit" disabled={busy}>Сохранить лимит пользователя</button>
            {hasCustomLimits && <button className="btn tiny" type="button" disabled={busy} onClick={resetUserLimits}>
              Сбросить к общему ({cloudBytes(defaultQuotaBytes)}, {defaultMaxProjects} проектов)
            </button>}
          </div>
        </form>
      </section>

      <section>
        <h3>Управление учётной записью</h3>
        <form className="admin-user-form" onSubmit={submitRename}>
          <label>Имя (ник) или электронная почта
            <div className="admin-inline-row">
              <input className="txt" type="text" maxLength={254} required value={loginInput}
                onChange={(e) => setLoginInput(e.target.value)} aria-label="Имя или почта пользователя" />
              <button className="btn tiny" type="submit" disabled={busy || !loginInput.trim() || loginInput.trim() === user.email}>Переименовать</button>
            </div>
          </label>
        </form>
        <form className="admin-user-form" onSubmit={submitCustomPassword}>
          <label>Задать новый пароль вручную (10–128 символов)
            <div className="admin-inline-row">
              <input className="txt" type="text" minLength={10} maxLength={128} value={customPassword}
                onChange={(e) => setCustomPassword(e.target.value)} placeholder="Введите или сгенерируйте пароль…"
                aria-label="Новый пароль пользователя" />
              <button className="btn tiny" type="button" disabled={busy} onClick={() => setCustomPassword(generateRandomPassword())}>Сгенерировать</button>
              <button className="btn tiny primary" type="submit" disabled={busy || customPassword.length < 10}>Установить пароль</button>
            </div>
          </label>
          {!isCurrentUser && <label className="admin-checkbox">
            <input type="checkbox" checked={requireChangeOnSet} onChange={(e) => setRequireChangeOnSet(e.target.checked)} />
            <span>Потребовать смену пароля при следующем входе</span>
          </label>}
        </form>
      </section>
    </div>

    <div className="admin-profile-actions">
      {!isCurrentUser && <button className="btn tiny" disabled={busy || user.disabled} onClick={onResetPassword}>Выдать временный пароль</button>}
      <button className="btn tiny" disabled={busy || profile.activeSessions.length === 0 || isCurrentUser} onClick={onRevokeSessions}>Завершить все сеансы</button>
      {onUpdateUser && !isCurrentUser && <>
        <button className="btn tiny" disabled={busy} onClick={() => onUpdateUser({ disabled: !user.disabled })}>
          {user.disabled ? 'Разблокировать аккаунт' : 'Заблокировать аккаунт'}
        </button>
        <button className="btn tiny" disabled={busy} onClick={() => onUpdateUser({ role: user.role === 'admin' ? 'user' : 'admin' })}>
          {user.role === 'admin' ? 'Снять роль администратора' : 'Назначить администратором'}
        </button>
        <button className="btn tiny" disabled={busy} onClick={() => onUpdateUser({ mustChangePassword: !user.mustChangePassword })}>
          {user.mustChangePassword ? 'Отменить обязательную смену пароля' : 'Потребовать смену пароля'}
        </button>
      </>}
      {onUpdateUser && <button className="btn tiny" disabled={busy} onClick={() => onUpdateUser({ emailVerified: !user.emailVerifiedAt })}>
        {user.emailVerifiedAt ? 'Снять подтверждение почты' : 'Подтвердить почту'}
      </button>}
      {onClearUserProjects && ownedProjects.length > 0 && <button className="btn tiny danger" disabled={busy} onClick={onClearUserProjects}>
        Очистить все проекты ({ownedProjects.length})
      </button>}
      {onDeleteUser && !isCurrentUser && <button className="btn tiny danger" disabled={busy} onClick={onDeleteUser}>
        Удалить пользователя
      </button>}
      <span>Пароль не раскрывается: хранится только scrypt-хеш. Временный пароль будет показан один раз.</span>
    </div>

    <div className="admin-profile-columns">
      <section><h3>Проекты владельца ({ownedProjects.length})</h3>{projectList(ownedProjects, false)}</section>
      <section><h3>Общие проекты ({sharedProjects.length})</h3>{projectList(sharedProjects, true)}</section>
    </div>
    <div className="admin-profile-columns">
      <section><h3>Активные сеансы ({profile.activeSessions.length})</h3>
        {profile.activeSessions.length ? <ul className="admin-profile-list">{profile.activeSessions.map((session, index) =>
          <li key={`${session.createdAt}-${index}`}>Создан {cloudDate(session.createdAt)} · действует до {cloudDate(session.expiresAt)}</li>)}</ul>
          : <p className="admin-profile-muted">Активных сеансов нет.</p>}</section>
      <section><h3>Последние события ({profile.recentEvents.length})</h3>
        {profile.recentEvents.length ? <ul className="admin-profile-list">{profile.recentEvents.map((event) =>
          <li key={event.id}><time>{cloudDate(event.at)}</time> · {EVENTS[event.action] ?? event.action}{event.detail && ` · ${event.detail}`}</li>)}</ul>
          : <p className="admin-profile-muted">Событий нет.</p>}</section>
    </div>
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
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [profile, setProfile] = useState<AdminUserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [issuedPassword, setIssuedPassword] = useState<{ email: string; password: string } | null>(null);
  const [copiedPassword, setCopiedPassword] = useState(false);

  // Форма настройки глобальных лимитов аккаунта
  const [defaultQuotaMb, setDefaultQuotaMb] = useState('250');
  const [defaultMaxProjectMb, setDefaultMaxProjectMb] = useState('8');
  const [defaultMaxProjects, setDefaultMaxProjects] = useState('1000');

  // Форма создания нового пользователя
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'user' | 'admin'>('user');
  const [newUserQuotaMb, setNewUserQuotaMb] = useState('');
  const [newUserMaxProjects, setNewUserMaxProjects] = useState('');
  const [newUserMustChange, setNewUserMustChange] = useState(false);

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
        if (active) {
          setOverview(summary);
          setDefaultQuotaMb(String(Math.max(1, Math.round(summary.quotaBytes / MIB))));
          setDefaultMaxProjectMb(String(Math.max(1, Math.round(summary.maxProjectBytes / MIB))));
          setDefaultMaxProjects(String(summary.maxProjects ?? 1000));
        }
        if (tab === 'users') {
          const data = await cloudApi<{ total: number; users: AdminUser[] }>('/admin/users' + params);
          if (active) { setUsers(data.users); setTotal(data.total); }
        } else if (tab === 'projects') {
          const data = await cloudApi<{ total: number; projects: CloudProject[] }>(
            '/admin/projects' + params + (ownerId ? '&ownerId=' + encodeURIComponent(ownerId) : ''),
          );
          if (active) { setProjects(data.projects); setTotal(data.total); }
        } else if (tab === 'update') {
          // панель обновления загружает свои данные сама
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

  useEffect(() => {
    let active = true;
    if (tab !== 'users' || !selectedUserId) {
      setProfile(null); setProfileError(''); setProfileLoading(false);
      return () => { active = false; };
    }
    setProfile(null); setProfileError(''); setProfileLoading(true);
    cloudApi<AdminUserProfile>(`/admin/users/${selectedUserId}`)
      .then((data) => { if (active) setProfile(data); })
      .catch((e) => { if (active) setProfileError(cloudError(e)); })
      .finally(() => { if (active) setProfileLoading(false); });
    return () => { active = false; };
  }, [tab, selectedUserId, refresh]);

  const switchTab = (next: Tab) => {
    setTab(next); setPage(0); setSearch(''); setQuery(''); setOwnerId(''); setNotice('');
    if (next !== 'users') { setSelectedUserId(''); setIssuedPassword(null); }
  };
  const action = async (run: () => Promise<unknown>, successMessage = '') => {
    setBusy(true); setError(''); setNotice('');
    try {
      await run();
      if (successMessage) setNotice(successMessage);
      setRefresh((n) => n + 1);
    } catch (e) { setError(cloudError(e)); }
    finally { setBusy(false); }
  };
  const saveDefaultLimits = (e: FormEvent) => {
    e.preventDefault();
    const quotaMb = Number(defaultQuotaMb);
    const maxProjectMb = Number(defaultMaxProjectMb);
    const maxProj = Number(defaultMaxProjects);
    if (!Number.isInteger(quotaMb) || quotaMb < 1 || quotaMb > 1_000_000) {
      setError('Лимит аккаунта должен быть целым числом от 1 до 1 000 000 МиБ.'); return;
    }
    if (!Number.isInteger(maxProjectMb) || maxProjectMb < 1 || maxProjectMb > 512) {
      setError('Максимальный размер одного проекта должен быть от 1 до 512 МиБ.'); return;
    }
    if (quotaMb < maxProjectMb) {
      setError('Лимит аккаунта не может быть меньше максимального размера одного проекта.'); return;
    }
    if (!Number.isInteger(maxProj) || maxProj < 1 || maxProj > 100_000) {
      setError('Лимит количества проектов должен быть от 1 до 100 000.'); return;
    }
    void action(
      () => cloudApi('/admin/settings', 'PATCH', {
        quotaBytes: quotaMb * MIB,
        maxProjectBytes: maxProjectMb * MIB,
        maxProjects: maxProj,
      }),
      `Лимиты аккаунта сохранены: ${quotaMb} МиБ на пользователя, до ${maxProj} проектов, плата до ${maxProjectMb} МиБ.`,
    );
  };
  const createNewUser = (e: FormEvent) => {
    e.preventDefault();
    const email = newUserEmail.trim();
    if (!email) { setError('Введите имя (ник) или почту нового пользователя.'); return; }
    if (newUserPassword.length < 10) { setError('Пароль должен содержать не менее 10 символов.'); return; }
    const quotaBytes = newUserQuotaMb.trim() ? Number(newUserQuotaMb) * MIB : null;
    const maxProjects = newUserMaxProjects.trim() ? Number(newUserMaxProjects) : null;
    if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || quotaBytes < MIB)) {
      setError('Индивидуальный лимит хранилища должен быть не менее 1 МиБ.'); return;
    }
    if (maxProjects !== null && (!Number.isSafeInteger(maxProjects) || maxProjects < 1 || maxProjects > 100_000)) {
      setError('Индивидуальный лимит проектов должен быть от 1 до 100 000.'); return;
    }
    void action(async () => {
      const created = await cloudApi<{ user: AdminUser }>('/admin/users', 'POST', {
        email, password: newUserPassword, role: newUserRole,
        mustChangePassword: newUserMustChange,
        quotaBytes, maxProjects,
      });
      setNewUserEmail(''); setNewUserPassword(''); setNewUserRole('user');
      setNewUserQuotaMb(''); setNewUserMaxProjects(''); setNewUserMustChange(false);
      setShowCreateUser(false);
      setSelectedUserId(created.user.id);
    }, `Пользователь «${email}» создан.`);
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
  const promptRenameUser = (target: AdminUser) => {
    const next = window.prompt('Новое имя (ник) или электронная почта пользователя:', target.email);
    if (!next || next.trim() === target.email) return;
    void action(() => cloudApi(`/admin/users/${target.id}`, 'PATCH', { email: next.trim() }), `Имя пользователя изменено на «${next.trim()}».`);
  };
  const promptUserQuota = (target: AdminUser) => {
    const currentMb = Math.max(1, Math.round((target.quotaBytes ?? overview?.quotaBytes ?? 250 * MIB) / MIB));
    const input = window.prompt(
      `Лимит хранилища для ${target.email} в МиБ (оставьте пустым или введите 0 для сброса к общему лимиту сервера):`,
      target.customQuotaBytes ? String(currentMb) : '',
    );
    if (input === null) return;
    const trimmed = input.trim();
    if (!trimmed || trimmed === '0') {
      void action(() => cloudApi(`/admin/users/${target.id}`, 'PATCH', { quotaBytes: null }), `Для ${target.email} восстановлен общий лимит сервера.`);
      return;
    }
    const mb = Number(trimmed);
    if (!Number.isInteger(mb) || mb < 1 || mb > 1_000_000) {
      setError('Укажите целое число от 1 до 1 000 000 МиБ.'); return;
    }
    void action(() => cloudApi(`/admin/users/${target.id}`, 'PATCH', { quotaBytes: mb * MIB }), `Лимит для ${target.email}: ${mb} МиБ.`);
  };
  const clearUserProjects = (target: AdminUser) => {
    if (window.prompt(`Удалить ВСЕ проекты пользователя ${target.email} без удаления самого аккаунта? Введите ${target.email} для подтверждения:`) !== target.email) return;
    void action(() => cloudApi(`/admin/users/${target.id}/projects`, 'DELETE'), `Все проекты пользователя ${target.email} удалены.`);
  };
  const removeUser = (target: AdminUser) => {
    if (window.prompt(`Безвозвратно удалить пользователя, все его проекты и сеансы? Введите адрес ${target.email} для подтверждения:`) !== target.email) return;
    void action(async () => {
      await cloudApi(`/admin/users/${target.id}`, 'DELETE');
      if (selectedUserId === target.id) setSelectedUserId('');
    });
  };
  const issueTemporaryPassword = async (target: AdminUser) => {
    if (!window.confirm(`Сбросить пароль ${target.email}? Все его сеансы завершатся. Временный пароль отобразится только один раз, пользователь должен заменить его при входе.`)) return;
    setBusy(true); setError(''); setNotice(''); setIssuedPassword(null); setCopiedPassword(false);
    try {
      const result = await cloudApi<{ temporaryPassword: string }>(`/admin/users/${target.id}/password`, 'POST', {});
      setIssuedPassword({ email: target.email, password: result.temporaryPassword });
      setSelectedUserId(target.id); setRefresh((n) => n + 1);
    } catch (e) { setError(cloudError(e)); }
    finally { setBusy(false); }
  };
  const copyTemporaryPassword = async () => {
    if (!issuedPassword) return;
    try {
      if (!navigator.clipboard) throw new Error('Буфер обмена недоступен.');
      await navigator.clipboard.writeText(issuedPassword.password);
      setCopiedPassword(true);
    } catch { setError('Не удалось скопировать пароль. Выделите его в поле и скопируйте вручную.'); }
  };
  const renameProject = (target: CloudProject) => {
    const next = window.prompt('Новое название проекта:', target.name);
    if (!next || next.trim() === target.name) return;
    void action(() => cloudApi(`/admin/projects/${target.id}`, 'PATCH', { name: next.trim() }), `Проект переименован в «${next.trim()}».`);
  };
  const transferProject = (target: CloudProject) => {
    const nextOwner = window.prompt(`Передать проект «${target.name}» другому пользователю. Введите его имя (ник) или почту:`, target.ownerEmail || '');
    if (!nextOwner || !nextOwner.trim() || nextOwner.trim() === target.ownerEmail) return;
    void action(() => cloudApi(`/admin/projects/${target.id}`, 'PATCH', { ownerEmail: nextOwner.trim() }), `Проект «${target.name}» передан пользователю ${nextOwner.trim()}.`);
  };
  const revokeSharedProject = (project: CloudProject, memberId: string, memberEmail: string) => {
    if (!window.confirm(`Отозвать у ${memberEmail} доступ к общему проекту «${project.name}»?`)) return;
    void action(() => cloudApi(`/admin/projects/${project.id}/members/${memberId}`, 'DELETE'), `Доступ к проекту «${project.name}» отозван.`);
  };
  const removeProject = (target: CloudProject) => {
    if (window.prompt(`Удалить проект «${target.name}» пользователя ${target.ownerEmail}? Введите название проекта:`) !== target.name) return;
    void action(() => cloudApi(`/admin/projects/${target.id}`, 'DELETE'));
  };
  const exportProject = (target: CloudProject) => void action(async () => {
    const { project } = await cloudApi<{ project: CloudProjectDetail }>(`/admin/projects/${target.id}`);
    download(`${project.name || 'board'}.laypcb.json`, new Blob([JSON.stringify(project.document, null, 1)], { type: 'application/json' }));
  });
  const viewOwnerProjects = (id: string) => {
    switchTab('projects'); setOwnerId(id);
  };

  return <div className="cloud-admin">
    <header className="admin-header">
      <div className="admin-title"><img src="/logo.png" alt="" width={37} height={37} /><div><b>PS<em>Bees</em> · Администрирование</b><small>Локальный сервер проектов</small></div></div>
      <div className="admin-header-actions"><span title={user.email}>{user.email}</span><a className="btn" href="/">Открыть редактор</a>
        <button className="btn" onClick={() => void action(onLogout)}>Выйти</button></div>
    </header>
    <nav className="admin-nav" aria-label="Разделы управления">
      {([['overview', 'Обзор'], ['users', 'Пользователи'], ['projects', 'Проекты'], ['events', 'Журнал действий'], ['update', 'Обновление']] as const).map(([id, name]) =>
        <button key={id} className={tab === id ? 'on' : ''} onClick={() => switchTab(id)}>{name}</button>)}
    </nav>
    <main className="admin-body">
      <div className="admin-heading"><div><h1>{tab === 'overview' ? 'Обзор сервера' : tab === 'users' ? 'Пользователи' : tab === 'projects' ? 'Проекты' : tab === 'update' ? 'Обновление программы' : 'Журнал действий'}</h1>
        <p>{tab === 'overview' ? 'Состояние общего хранилища, лимиты аккаунтов и управление регистрацией' : tab === 'users' ? 'Создание аккаунтов, индивидуальные лимиты, пароли, роли и доступ' : tab === 'projects' ? 'Все платы на сервере: владельцы, передача прав и резервные копии' : tab === 'update' ? 'Установка новой версии из GitHub без терминала' : 'Последние изменения на сервере'}</p></div>
        <button className="btn" disabled={busy} onClick={() => setRefresh((n) => n + 1)}>↻ Обновить</button></div>
      {error && <div className="cloud-error" role="alert">{error}</div>}
      {notice && <div className="cloud-success" role="status">{notice}</div>}
      {issuedPassword && tab === 'users' && <section className="admin-issued-password" role="status">
        <div><h2>Временный пароль для {issuedPassword.email}</h2>
          <p>Скопируйте и передайте его пользователю безопасным способом сейчас. После закрытия это значение нельзя будет получить повторно; при входе пользователь должен задать новый пароль.</p></div>
        <div className="admin-issued-password-row"><input className="txt" aria-label="Временный пароль пользователя" readOnly
          value={issuedPassword.password} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn" onClick={() => void copyTemporaryPassword()}>{copiedPassword ? 'Скопировано' : 'Копировать'}</button>
          <button className="btn" onClick={() => { setIssuedPassword(null); setCopiedPassword(false); }}>Закрыть</button></div>
      </section>}
      {tab === 'overview' && <>
        <div className="admin-stats">
          <div><span>Пользователи</span><strong>{overview?.users ?? '—'}</strong><small>Отключены: {overview?.disabledUsers ?? '—'}</small>
            <small>Почта подтверждена: {overview?.verifiedUsers ?? '—'} · не подтверждена: {overview?.unverifiedUsers ?? '—'}</small>
            <small>Ожидают смены пароля: {overview?.usersMustChangePassword ?? '—'}</small></div>
          <div><span>Проекты</span><strong>{overview?.projects ?? '—'}</strong><small>По всем владельцам · версий: {overview?.versions ?? 0}</small></div>
          <div><span>Занято на сервере</span><strong>{overview ? cloudBytes(overview.bytes) : '—'}</strong>
            <small>Лимит аккаунта: {overview ? cloudBytes(overview.quotaBytes) : '—'}</small>
            <small>Плата до {overview ? cloudBytes(overview.maxProjectBytes) : '—'} · до {overview?.maxProjects ?? 1000} проектов</small></div>
          <div><span>Активные сеансы</span><strong>{overview?.activeSessions ?? '—'}</strong><small>Срок действия: 14 дней</small></div>
        </div>
        <section className="admin-card">
          <h2>Лимит аккаунта и проектов по умолчанию</h2>
          <p>Задайте базовые ограничения для всех пользователей сервера. В разделе «Пользователи» для любого аккаунта можно назначить индивидуальный лимит хранилища и количества проектов.</p>
          <form className="admin-limits-form" onSubmit={saveDefaultLimits}>
            <div className="admin-form-grid">
              <label>Лимит хранилища на аккаунт (МиБ)
                <input className="txt" type="number" min={1} max={1000000} required value={defaultQuotaMb}
                  onChange={(e) => setDefaultQuotaMb(e.target.value)} aria-label="Лимит хранилища на аккаунт (МиБ)" />
              </label>
              <label>Макс. размер одного проекта (МиБ)
                <input className="txt" type="number" min={1} max={512} required value={defaultMaxProjectMb}
                  onChange={(e) => setDefaultMaxProjectMb(e.target.value)} aria-label="Максимальный размер проекта (МиБ)" />
              </label>
              <label>Макс. количество проектов на аккаунт
                <input className="txt" type="number" min={1} max={100000} required value={defaultMaxProjects}
                  onChange={(e) => setDefaultMaxProjects(e.target.value)} aria-label="Максимальное количество проектов" />
              </label>
            </div>
            <div className="admin-preset-row">
              <span>Быстрый выбор квоты:</span>
              {QUOTA_PRESETS_MB.map((mb) => <button key={mb} type="button" className="btn tiny" disabled={busy}
                onClick={() => setDefaultQuotaMb(String(mb))}>{mb >= 1024 ? `${mb / 1024} ГБ` : `${mb} МиБ`}</button>)}
              <button className="btn primary" type="submit" disabled={busy}>Сохранить лимиты</button>
            </div>
          </form>
        </section>
        <section className="admin-card"><h2>Регистрация по почте</h2><p>Если закрыть регистрацию, новые пользователи не смогут создать аккаунт самостоятельно, но администратор всегда может добавить пользователя вручную во вкладке «Пользователи».</p>
          <div className="admin-settings"><span className={overview?.registrationOpen ? 'cloud-pill ok' : 'cloud-pill'}>{overview?.registrationOpen ? 'Открыта' : 'Закрыта'}</span>
            <button className="btn" disabled={busy || !overview} onClick={() => {
              if (!overview || !window.confirm(overview.registrationOpen ? 'Закрыть регистрацию новых пользователей?' : 'Разрешить регистрацию новых пользователей?')) return;
              void action(() => cloudApi('/admin/settings', 'PATCH', { registrationOpen: !overview.registrationOpen }));
            }}>{overview?.registrationOpen ? 'Закрыть регистрацию' : 'Открыть регистрацию'}</button></div>
        </section>
        <section className="admin-card"><h2>Резервное копирование</h2>
          <p>Проекты и учётные записи хранятся в SQLite-каталоге <code>PSBEES_DATA_DIR</code>. Делайте регулярные копии базы вместе с WAL/SHM или через SQLite Online Backup, не кладите каталог внутрь <code>dist</code>. Отдельный проект можно скачать в разделе «Проекты».</p></section>
        <section className="admin-card"><h2>Сброс пароля</h2>
          <p>В разделе «Пользователи» откройте сводку аккаунта и нажмите «Выдать временный пароль» либо задайте новый пароль вручную. Временный пароль показывается только один раз, завершает старые сеансы и обязывает пользователя задать новый пароль при следующем входе. Текущий пароль и его хеш недоступны даже администратору. Если панель недоступна, на сервере можно выполнить <code>node scripts/cloud-admin.mjs reset-user-password user@example.com</code>.</p></section>
        <section className="admin-card"><div className="admin-card-title"><h2>Последние действия</h2><button className="btn tiny" onClick={() => switchTab('events')}>Весь журнал →</button></div>
          {events.length ? <div className="admin-events">{events.map((e) => <div key={e.id}><time>{cloudDate(e.at)}</time><span>{EVENTS[e.action] ?? e.action}</span><small>{e.actorEmail || 'Системный администратор'} {e.detail && `· ${e.detail}`}</small></div>)}</div> : <p>Действий пока нет.</p>}</section>
      </>}
      {(tab === 'users' || tab === 'projects') && <div className="admin-filters">
        <input className="txt" type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={120}
          placeholder={tab === 'users' ? 'Поиск по имени (нику) или почте…' : 'Поиск по названию или почте владельца…'} aria-label="Поиск" />
        {tab === 'users' && <button className="btn primary" type="button" onClick={() => setShowCreateUser((v) => !v)}>
          {showCreateUser ? 'Скрыть форму создания' : '+ Создать пользователя'}
        </button>}
        {ownerId && <button className="btn" onClick={() => { setOwnerId(''); setPage(0); }}>Сбросить фильтр владельца ×</button>}
        <span>{total} {tab === 'users' ? 'пользователей' : 'проектов'}</span>
      </div>}
      {tab === 'users' && showCreateUser && <section className="admin-card admin-create-user-card">
        <h2>Новый пользователь</h2>
        <p>Создайте учётную запись вручную (работает даже при закрытой самостоятельной регистрации). Вы можете сразу задать роль и индивидуальный лимит аккаунта.</p>
        <form className="admin-limits-form" onSubmit={createNewUser}>
          <div className="admin-form-grid">
            <label>Имя (ник) или эл. почта
              <input className="txt" type="text" maxLength={254} required value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)} placeholder="Например: Инженер, user@example.com" />
            </label>
            <label>Пароль (от 10 символов)
              <div className="admin-inline-row">
                <input className="txt" type="text" minLength={10} maxLength={128} required value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)} placeholder="Не менее 10 символов" />
                <button className="btn tiny" type="button" onClick={() => setNewUserPassword(generateRandomPassword())}>Сгенерировать</button>
              </div>
            </label>
            <label>Роль
              <select className="txt" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value as 'user' | 'admin')}>
                <option value="user">Пользователь</option>
                <option value="admin">Администратор</option>
              </select>
            </label>
            <label>Лимит хранилища, МиБ (необязательно)
              <input className="txt" type="number" min={1} max={1000000} value={newUserQuotaMb}
                onChange={(e) => setNewUserQuotaMb(e.target.value)}
                placeholder={`По умолчанию (${defaultQuotaMb} МиБ)`} />
            </label>
            <label>Лимит проектов, шт. (необязательно)
              <input className="txt" type="number" min={1} max={100000} value={newUserMaxProjects}
                onChange={(e) => setNewUserMaxProjects(e.target.value)}
                placeholder={`По умолчанию (${defaultMaxProjects})`} />
            </label>
          </div>
          <div className="admin-preset-row">
            <label className="admin-checkbox">
              <input type="checkbox" checked={newUserMustChange} onChange={(e) => setNewUserMustChange(e.target.checked)} />
              <span>Потребовать смену пароля при первом входе</span>
            </label>
            <button className="btn primary" type="submit" disabled={busy}>Создать пользователя</button>
          </div>
        </form>
      </section>}
      {tab === 'users' && <div className="admin-table-wrap"><table className="admin-table admin-users-table"><thead><tr>
        <th>Аккаунт</th><th>Доступ</th><th>Почта / 2FA</th><th>Проекты</th><th>Данные и лимит</th><th>Сеансы</th><th>Зарегистрирован</th><th>Последний вход</th><th>Действия</th>
      </tr></thead><tbody>{users.map((u) => {
        const uQuota = u.quotaBytes ?? overview?.quotaBytes ?? 250 * MIB;
        const uMaxProj = u.maxProjects ?? overview?.maxProjects ?? 1000;
        const hasCustomQuota = u.customQuotaBytes !== null && u.customQuotaBytes !== undefined;
        const hasCustomMaxProj = u.customMaxProjects !== null && u.customMaxProjects !== undefined;
        return <Fragment key={u.id}><tr>
          <td><strong>{u.email}</strong>{u.id === user.id && <small>Это вы</small>}
            {u.mustChangePassword && <small className="admin-user-warning">Нужна смена пароля</small>}</td>
          <td><span className={'cloud-pill' + (u.disabled ? ' bad' : u.role === 'admin' ? ' ok' : '')}>{u.disabled ? 'Заблокирован' : u.role === 'admin' ? 'Администратор' : 'Пользователь'}</span></td>
          <td><span className={'cloud-pill' + (u.emailVerifiedAt ? ' ok' : ' bad')}>{u.emailVerifiedAt ? 'Подтверждена' : 'Не подтверждена'}</span>
            <small>{u.emailVerifiedAt ? cloudDate(u.emailVerifiedAt) : 'Код не подтверждался'}</small></td>
          <td><button className="admin-link" onClick={() => setSelectedUserId((id) => id === u.id ? '' : u.id)}>
            {u.projectCount} своих · {u.sharedProjectCount} общих</button>
            <small>{u.versionCount} версий · лимит: {uMaxProj}{hasCustomMaxProj ? ' (свой)' : ''}</small></td>
          <td><strong>{cloudBytes(u.bytes)} / {cloudBytes(uQuota)}</strong>
            <small>{hasCustomQuota ? 'Индивидуальный лимит' : 'Общий лимит'}</small></td>
          <td>{u.activeSessions}</td>
          <td>{cloudDate(u.createdAt)}</td><td>{u.lastLogin ? cloudDate(u.lastLogin) : '—'}</td>
          <td><div className="admin-actions">
            <button className="btn tiny" disabled={busy} onClick={() => setSelectedUserId((id) => id === u.id ? '' : u.id)}>{selectedUserId === u.id ? 'Свернуть' : 'Сводка'}</button>
            <button className="btn tiny" disabled={busy} onClick={() => promptUserQuota(u)}>Лимит</button>
            <button className="btn tiny" disabled={busy} onClick={() => promptRenameUser(u)}>Переименовать</button>
            <button className="btn tiny" disabled={busy || u.id === user.id} onClick={() => setDisabled(u)}>{u.disabled ? 'Разблокировать' : 'Блокировать'}</button>
            <button className="btn tiny" disabled={busy || u.id === user.id} onClick={() => setRole(u)}>{u.role === 'admin' ? 'Снять роль' : 'Сделать админом'}</button>
            <button className="btn tiny" disabled={busy || u.activeSessions === 0 || u.id === user.id} onClick={() => {
              if (window.confirm(`Завершить все сеансы пользователя ${u.email}?`)) void action(() => cloudApi(`/admin/users/${u.id}/sessions`, 'DELETE'));
            }}>Отозвать сеансы</button>
            <button className="btn tiny danger" disabled={busy || u.id === user.id} onClick={() => removeUser(u)}>Удалить</button></div></td>
        </tr>{selectedUserId === u.id && <tr className="admin-profile-row"><td colSpan={9}>
          <UserProfilePanel profile={profile?.user.id === u.id ? profile : null} loading={profileLoading} error={profileError} busy={busy} isCurrentUser={u.id === user.id}
            onResetPassword={() => void issueTemporaryPassword(u)}
            onRevokeSessions={() => {
              if (window.confirm(`Завершить все сеансы пользователя ${u.email}?`)) void action(() => cloudApi(`/admin/users/${u.id}/sessions`, 'DELETE'));
            }}
            onShowOwnerProjects={viewOwnerProjects}
            onUpdateUser={(patch) => void action(() => cloudApi(`/admin/users/${u.id}`, 'PATCH', patch), 'Настройки пользователя обновлены.')}
            onClearUserProjects={() => clearUserProjects(u)}
            onDeleteUser={() => removeUser(u)}
            onExportProject={exportProject}
            onRenameProject={renameProject}
            onTransferProject={transferProject}
            onDeleteProject={removeProject}
            onRevokeSharedProject={(proj) => revokeSharedProject(proj, u.id, u.email)} />
        </td></tr>}</Fragment>;
      })}</tbody></table>{!users.length && !busy && <div className="admin-empty">Пользователи не найдены.</div>}</div>}
      {tab === 'projects' && <div className="admin-table-wrap"><table className="admin-table"><thead><tr>
        <th>Проект</th><th>Владелец</th><th>Элементы</th><th>Размер</th><th>Изменён</th><th>Действия</th>
      </tr></thead><tbody>{projects.map((p) => <tr key={p.id}>
        <td><strong>{p.name}</strong><small>Версия {p.version}</small></td><td>{p.ownerEmail}</td>
        <td>{p.entityCount}</td><td>{cloudBytes(p.bytes)}</td><td>{cloudDate(p.updatedAt)}</td>
        <td><div className="admin-actions"><button className="btn tiny" disabled={busy} onClick={() => exportProject(p)}>Скачать JSON</button>
          <button className="btn tiny" disabled={busy} onClick={() => renameProject(p)}>Переименовать</button>
          <button className="btn tiny" disabled={busy} onClick={() => transferProject(p)}>Передать</button>
          <button className="btn tiny danger" disabled={busy} onClick={() => removeProject(p)}>Удалить</button></div></td>
      </tr>)}</tbody></table>{!projects.length && !busy && <div className="admin-empty">Проекты не найдены.</div>}</div>}
      {tab === 'events' && <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Время</th><th>Действие</th><th>Пользователь</th><th>Детали</th></tr></thead>
        <tbody>{events.map((e) => <tr key={e.id}><td>{cloudDate(e.at)}</td><td>{EVENTS[e.action] ?? e.action}</td><td>{e.actorEmail || 'Администратор сервера'}</td><td>{e.detail}</td></tr>)}</tbody>
      </table>{!events.length && !busy && <div className="admin-empty">Записей пока нет.</div>}</div>}
      {tab === 'update' && <AdminUpdatePanel />}
      {tab !== 'overview' && tab !== 'update' && <Pagination total={total} page={page} setPage={setPage} />}
    </main>
  </div>;
}
