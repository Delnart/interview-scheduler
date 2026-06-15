import { useState } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../AuthContext.jsx';
import { errorMessage } from '../api.js';

export default function LoginPage() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  if (user) {
    const dest = location.state?.from?.pathname || '/admin';
    return <Navigate to={dest} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate(location.state?.from?.pathname || '/admin', { replace: true });
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося увійти'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form className="card" style={{ width: 360 }} onSubmit={handleSubmit}>
        <h1 style={{ fontSize: 22, marginBottom: 20 }}>Вхід в адмін-панель</h1>
        {error && <div className="alert alert-error">{error}</div>}
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Вхід...' : 'Увійти'}
        </button>
      </form>
    </div>
  );
}
