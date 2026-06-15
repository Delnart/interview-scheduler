import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api, { errorMessage } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';

export default function ProfilePage() {
  const { user, refreshUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccess, setPwdSuccess] = useState('');

  const [googleStatus, setGoogleStatus] = useState(null);
  const [googleError, setGoogleError] = useState('');
  const [googleNotice, setGoogleNotice] = useState('');
  const [ops, setOps] = useState([]);

  useEffect(() => {
    loadGoogleStatus();
    api.get('/public/ops').then((res) => setOps(res.data.ops));

    const g = searchParams.get('google');
    if (g === 'connected') {
      setGoogleNotice('Google Calendar успішно підключено.');
      refreshUser();
    } else if (g === 'error') {
      setGoogleError('Не вдалося підключити Google Calendar. Спробуйте ще раз.');
    }
    if (g) {
      searchParams.delete('google');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadGoogleStatus() {
    const res = await api.get('/calendar/oauth/status');
    setGoogleStatus(res.data);
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwdError('');
    setPwdSuccess('');
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setPwdSuccess('Пароль змінено.');
    } catch (err) {
      setPwdError(errorMessage(err, 'Не вдалося змінити пароль'));
    }
  }

  async function handleConnectGoogle() {
    setGoogleError('');
    try {
      const res = await api.get('/calendar/oauth/url');
      window.location.href = res.data.url;
    } catch (err) {
      setGoogleError(errorMessage(err, 'Не вдалося розпочати підключення'));
    }
  }

  async function handleDisconnectGoogle() {
    if (!window.confirm('Відключити Google Calendar?')) return;
    try {
      await api.post('/calendar/oauth/disconnect');
      setGoogleNotice('Google Calendar відключено.');
      await loadGoogleStatus();
      await refreshUser();
    } catch (err) {
      setGoogleError(errorMessage(err));
    }
  }

  return (
    <div>
      <h1>Профіль</h1>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Дані</h2>
        <p><strong>ПІБ:</strong> {user.fullName}</p>
        <p><strong>Email:</strong> {user.email}</p>
        <p><strong>Telegram:</strong> {user.telegram || '—'}</p>
        {user.homeOp && <p><strong>Власна ОП:</strong> {ops.find((o) => o.code === user.homeOp)?.name || user.homeOp}</p>}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Google Calendar</h2>
        {googleError && <div className="alert alert-error">{googleError}</div>}
        {googleNotice && <div className="alert alert-success">{googleNotice}</div>}

        {!googleStatus ? (
          <p className="muted">Завантаження...</p>
        ) : !googleStatus.configured ? (
          <p className="muted">
            Інтеграція з Google Calendar не налаштована на сервері (відсутні облікові дані Google API).
            Зверніться до адміністратора системи.
          </p>
        ) : googleStatus.connected ? (
          <>
            <p>
              <span className="badge badge-green">Підключено</span> — створені події співбесід будуть автоматично
              додаватись у ваш Google Calendar, а зайнятий час враховуватиметься при пошуку слотів.
            </p>
            <button className="btn btn-danger" style={{ marginTop: 8 }} onClick={handleDisconnectGoogle}>Відключити</button>
          </>
        ) : (
          <>
            <p className="muted">
              Підключіть свій Google Calendar, щоб події співбесід автоматично додавались у календар, а ваш зайнятий
              час враховувався при підборі слотів.
            </p>
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={handleConnectGoogle}>Підключити Google Calendar</button>
          </>
        )}
      </div>

      <div className="card">
        <h2>Змінити пароль</h2>
        {pwdError && <div className="alert alert-error">{pwdError}</div>}
        {pwdSuccess && <div className="alert alert-success">{pwdSuccess}</div>}
        <form onSubmit={handleChangePassword} style={{ maxWidth: 360 }}>
          <div className="field">
            <label>Поточний пароль</label>
            <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
          </div>
          <div className="field">
            <label>Новий пароль (мінімум 8 символів)</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
          </div>
          <button className="btn btn-primary" type="submit">Змінити пароль</button>
        </form>
      </div>
    </div>
  );
}
