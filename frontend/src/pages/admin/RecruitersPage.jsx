import { useEffect, useState } from 'react';
import api, { errorMessage } from '../../api.js';

const emptyForm = { fullName: '', email: '', telegram: '', password: '', homeOp: '', isAdmin: false };

export default function RecruitersPage() {
  const [recruiters, setRecruiters] = useState([]);
  const [ops, setOps] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    load();
    api.get('/ops').then((res) => setOps(res.data.ops));
  }, []);

  async function load() {
    const res = await api.get('/recruiters');
    setRecruiters(res.data.recruiters);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    try {
      await api.post('/recruiters', { ...form, homeOp: form.homeOp || null });
      setForm(emptyForm);
      setShowAdd(false);
      setSuccess('Рекрутера додано.');
      load();
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося створити рекрутера'));
    }
  }

  function startEdit(r) {
    setEditingId(r.id);
    setEditForm({ fullName: r.fullName, email: r.email, telegram: r.telegram || '', homeOp: r.homeOp || '', isAdmin: r.isAdmin, active: r.active });
    setError('');
    setSuccess('');
  }

  async function saveEdit(id) {
    try {
      await api.put(`/recruiters/${id}`, { ...editForm, homeOp: editForm.homeOp || null });
      setEditingId(null);
      setSuccess('Збережено.');
      load();
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося зберегти'));
    }
  }

  async function handleToggleActive(r) {
    if (r.active) {
      if (!window.confirm(`Деактивувати ${r.fullName}? Слоти з цим рекрутером більше не генеруватимуться.`)) return;
      try {
        await api.delete(`/recruiters/${r.id}`);
        load();
      } catch (err) {
        setError(errorMessage(err));
      }
    } else {
      await api.put(`/recruiters/${r.id}`, { active: true });
      load();
    }
  }

  async function handleResetPassword(r) {
    const pwd = window.prompt(`Новий пароль для ${r.fullName} (мінімум 8 символів):`);
    if (!pwd) return;
    try {
      await api.post(`/recruiters/${r.id}/reset-password`, { newPassword: pwd });
      setSuccess(`Пароль для ${r.fullName} оновлено.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <div className="flex-between">
        <h1>Рекрутери</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? 'Закрити' : '+ Додати рекрутера'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {showAdd && (
        <form className="card" style={{ marginBottom: 16 }} onSubmit={handleCreate}>
          <h2>Новий рекрутер</h2>
          <div className="admin-two-col">
            <div className="field">
              <label>ПІБ</label>
              <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
            </div>
            <div className="field">
              <label>Email</label>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
            </div>
            <div className="field">
              <label>Telegram</label>
              <input value={form.telegram} onChange={(e) => setForm({ ...form, telegram: e.target.value })} placeholder="@username" />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={8} />
            </div>
            <div className="field">
              <label>Власна ОП (необов&#39;язково)</label>
              <select value={form.homeOp} onChange={(e) => setForm({ ...form, homeOp: e.target.value })}>
                <option value="">—</option>
                {ops.map((op) => <option key={op.code} value={op.code}>{op.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 22 }}>
              <input type="checkbox" style={{ width: 'auto' }} id="isAdmin" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
              <label htmlFor="isAdmin" style={{ margin: 0 }}>Права адміністратора</label>
            </div>
          </div>
          <button className="btn btn-primary" type="submit">Створити</button>
        </form>
      )}

      <div className="card">
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ПІБ</th>
              <th>Email</th>
              <th>Telegram</th>
              <th>Власна ОП</th>
              <th>Роль</th>
              <th>Статус</th>
              <th>Google</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {recruiters.map((r) => (
              <tr key={r.id}>
                {editingId === r.id ? (
                  <>
                    <td><input value={editForm.fullName} onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })} /></td>
                    <td><input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></td>
                    <td><input value={editForm.telegram} onChange={(e) => setEditForm({ ...editForm, telegram: e.target.value })} /></td>
                    <td>
                      <select value={editForm.homeOp} onChange={(e) => setEditForm({ ...editForm, homeOp: e.target.value })}>
                        <option value="">—</option>
                        {ops.map((op) => <option key={op.code} value={op.code}>{op.name}</option>)}
                      </select>
                    </td>
                    <td>
                      <label className="flex" style={{ gap: 4 }}>
                        <input type="checkbox" style={{ width: 'auto' }} checked={editForm.isAdmin} onChange={(e) => setEditForm({ ...editForm, isAdmin: e.target.checked })} />
                        Адмін
                      </label>
                    </td>
                    <td>—</td>
                    <td>—</td>
                    <td className="flex">
                      <button className="btn btn-sm btn-primary" onClick={() => saveEdit(r.id)}>Зберегти</button>
                      <button className="btn btn-sm" onClick={() => setEditingId(null)}>Скасувати</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td>{r.fullName}</td>
                    <td>{r.email}</td>
                    <td>{r.telegram}</td>
                    <td>{r.homeOp ? <span className="badge">{ops.find((o) => o.code === r.homeOp)?.name || r.homeOp}</span> : '—'}</td>
                    <td>{r.isAdmin ? <span className="badge">Адмін</span> : <span className="badge badge-gray">Рекрутер</span>}</td>
                    <td>{r.active ? <span className="badge badge-green">Активний</span> : <span className="badge badge-gray">Деактивовано</span>}</td>
                    <td>{r.googleConnected ? <span className="badge badge-green">Підключено</span> : <span className="badge badge-gray">Ні</span>}</td>
                    <td className="flex">
                      <button className="btn btn-sm" onClick={() => startEdit(r)}>Редагувати</button>
                      <button className="btn btn-sm" onClick={() => handleResetPassword(r)}>Пароль</button>
                      <button className={`btn btn-sm ${r.active ? 'btn-danger' : ''}`} onClick={() => handleToggleActive(r)}>
                        {r.active ? 'Деактивувати' : 'Активувати'}
                      </button>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
