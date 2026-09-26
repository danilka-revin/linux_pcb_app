import { useCallback, useEffect, useState, type FormEvent } from 'react';
import App from '../App';
import AdminApp from './admin';
import { cloudApi, cloudError, CloudError, type CloudConfig, type CloudUser } from './api';
import { ProgressBar } from '../ui/progress';

type Gate = { config: CloudConfig; user: CloudUser | null };

export async function discoverCloud(): Promise<CloudConfig> {
  let response: Response;
  try { response = await fetch('/api/cloud/config', { credentials: 'same-origin', cache: 'no-store' }); }
  catch { throw new CloudError('Не удалось подключиться к серверу.', 0); }
  // dist/ по-прежнему можно раздавать обычным статическим сервером без API:
  // он вернёт 404 или index.html вместо JSON, и приложение останется офлайн.
  if (response.status === 404 || response.headers.get('content-type')?.includes('text/html')) return { enabled: false };
  let config: CloudConfig & { ok?: boolean; error?: string };
  try { config = await response.json() as typeof config; }
  catch { throw new CloudError('Неверный ответ облачного сервера.', response.status); }
  if (!response.ok || config.ok === false || typeof config.enabled !== 'boolean') {
    throw new CloudError(config.error || `Ошибка облачного сервера (HTTP ${response.status}).`, response.status);
  }
  return config;
}

function AuthScreen({ config, onLogin }: { config: CloudConfig; onLogin: (user: CloudUser) => void }) {
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (register && password !== confirm) { setError('Пароли не совпадают.'); return; }
    setBusy(true); setError('');
    try {
      const result = await cloudApi<{ user: CloudUser }>(register ? '/register' : '/login', 'POST', { email, password });
      onLogin(result.user);
    } catch (err) { setError(cloudError(err)); }
    finally { setBusy(false); }
  };
  return (
    <div className="cloud-gate">
      <div className="cloud-auth">
        <div className="cloud-auth-brand">
          <img src="/logo.png" width={54} height={54} alt="PSBees" />
          <div><b>PS<em>Bees</em></b><span>Общее рабочее пространство для печатных плат</span></div>
        </div>
        <h1>{register ? 'Создать учётную запись' : 'Войти в PSBees'}</h1>
        <p>Ваши проекты хранятся на этом сервере и доступны с других компьютеров после входа.</p>
        <form onSubmit={(e) => void submit(e)}>
          <label htmlFor="auth-email">Электронная почта</label>
          <input id="auth-email" className="txt" type="email" autoComplete="email" required autoFocus
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" maxLength={254} />
          <label htmlFor="auth-password">Пароль</label>
          <input id="auth-password" className="txt" type="password" autoComplete={register ? 'new-password' : 'current-password'}
            required minLength={register ? 10 : undefined} maxLength={128} value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder={register ? 'Не менее 10 символов' : 'Ваш пароль'} />
          {register && <>
            <label htmlFor="auth-confirm">Повторите пароль</label>
            <input id="auth-confirm" className="txt" type="password" autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </>}
          {error && <div className="cloud-error" role="alert">{error}</div>}
          <button className="btn primary" disabled={busy} type="submit">{busy ? 'Подождите…' : register ? 'Зарегистрироваться' : 'Войти'}</button>
          {busy && <ProgressBar slim live indeterminate title="Отправляем данные учётной записи" />}
        </form>
        {config.registrationOpen && (
          <button className="cloud-switch" type="button" onClick={() => { setRegister(!register); setError(''); setPassword(''); setConfirm(''); }}>
            {register ? 'Уже есть учётная запись? Войти' : 'Нет аккаунта? Зарегистрироваться по почте'}
          </button>
        )}
        {!config.registrationOpen && <div className="cloud-auth-note">Регистрация закрыта администратором. Обратитесь к нему за доступом.</div>}
        <div className="cloud-auth-note">Этот сервер не подтверждает владение почтой. Используйте свой адрес и надёжный пароль.</div>
      </div>
    </div>
  );
}

export default function Workspace() {
  const [gate, setGate] = useState<Gate | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isAdminPage = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const config = await discoverCloud();
        let user: CloudUser | null = null;
        if (config.enabled) {
          try { user = (await cloudApi<{ user: CloudUser }>('/me')).user; }
          catch (e) { if (!(e instanceof CloudError && e.status === 401)) throw e; }
        }
        if (active) { setGate({ config, user }); setError(''); }
      } catch (e) { if (active) setError(cloudError(e)); }
    })();
    return () => { active = false; };
  }, [retry]);

  const logout = useCallback(async () => {
    try { await cloudApi('/logout', 'POST'); }
    catch (e) { if (!(e instanceof CloudError && e.status === 401)) throw e; }
    if (gate?.user) {
      try {
        sessionStorage.removeItem(`psbees.cloud.draft.${gate.user.id}`);
        sessionStorage.removeItem(`psbees.cloud.open.${gate.user.id}`);
      } catch { /* браузер запретил хранилище */ }
    }
    setGate((prev) => prev && ({ ...prev, user: null }));
    if (isAdminPage) window.location.assign('/');
  }, [isAdminPage, gate?.user]);

  if (error || !gate) return (
    <div className="cloud-gate"><div className="cloud-auth cloud-loading">
      <img src="/logo.png" width={52} height={52} alt="" />
      <h1>{error ? 'Сервер недоступен' : 'Подключаемся к PSBees…'}</h1>
      {!error && <ProgressBar label="Проверяем общий сервер" indeterminate live meta="настройки рабочего пространства и сеанс" />}
      {error && <><p role="alert">{error}</p><button className="btn primary" onClick={() => { setError(''); setRetry((n) => n + 1); }}>Повторить</button></>}
    </div></div>
  );
  if (!gate.config.enabled) return isAdminPage
    ? <div className="cloud-gate"><div className="cloud-auth"><h1>Админ-панель недоступна</h1><p>Запустите общий сервер с PSBEES_DATA_DIR и откройте его адрес.</p><a className="btn" href="/">Вернуться к редактору</a></div></div>
    : <App />;
  if (!gate.user) return <AuthScreen config={gate.config} onLogin={(user) => setGate((prev) => prev && ({ ...prev, user }))} />;
  if (isAdminPage) return gate.user.role === 'admin'
    ? <AdminApp user={gate.user} onLogout={logout} />
    : <div className="cloud-gate"><div className="cloud-auth"><h1>Нет доступа</h1><p>Раздел доступен только администратору сервера.</p><a className="btn primary" href="/">К редактору</a></div></div>;
  return <App key={gate.user.id} cloudUser={gate.user} onLogout={logout} />;
}
