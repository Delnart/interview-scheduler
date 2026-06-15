import { useEffect, useState } from 'react';
import api, { errorMessage } from '../../api.js';

export default function TeamsPage() {
  const [ops, setOps] = useState([]);
  const [recruiters, setRecruiters] = useState([]);
  const [selectedOp, setSelectedOp] = useState(null);
  const [team, setTeam] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newOpCode, setNewOpCode] = useState('');
  const [newOpName, setNewOpName] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const [opsRes, recRes] = await Promise.all([api.get('/ops'), api.get('/recruiters')]);
    setOps(opsRes.data.ops);
    setRecruiters(recRes.data.recruiters.filter((r) => r.active));
    if (opsRes.data.ops.length > 0 && !selectedOp) {
      selectOp(opsRes.data.ops[0].code);
    }
  }

  function opName(code) {
    return ops.find((o) => o.code === code)?.name || code;
  }

  async function selectOp(code) {
    setSelectedOp(code);
    setError('');
    setSuccess('');
    const res = await api.get(`/ops/${code}/team`);
    setTeam({
      main: res.data.main.map((r) => r.id),
      secondary: res.data.secondary.map((r) => r.id),
    });
  }

  function toggleRole(recruiterId, role) {
    setTeam((prev) => {
      const set = new Set(prev[role]);
      if (set.has(recruiterId)) {
        set.delete(recruiterId);
      } else {
        set.add(recruiterId);
      }
      return { ...prev, [role]: [...set] };
    });
  }

  async function saveTeam() {
    setError('');
    setSuccess('');
    try {
      await api.put(`/ops/${selectedOp}/team`, team);
      setSuccess('Команду оновлено. Слоти для співбесід будуть перераховані.');
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося зберегти команду'));
    }
  }

  async function handleCreateOp(e) {
    e.preventDefault();
    setError('');
    setSuccess('');
    try {
      await api.post('/ops', { code: newOpCode, name: newOpName });
      setNewOpCode('');
      setNewOpName('');
      setSuccess('ОП додано.');
      await load();
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося створити ОП'));
    }
  }

  async function handleRenameOp(code) {
    const op = ops.find((o) => o.code === code);
    const name = window.prompt('Нова назва ОП:', op?.name || '');
    if (!name) return;
    try {
      await api.put(`/ops/${code}`, { name });
      load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleDeleteOp(code) {
    if (!window.confirm(`Видалити ОП "${code}"? Це видалить всі пов'язані слоти та команду.`)) return;
    try {
      await api.delete(`/ops/${code}`);
      if (selectedOp === code) {
        setSelectedOp(null);
        setTeam(null);
      }
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <h1>Команди по ОП</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Для кожної ОП оберіть основних рекрутерів — тих, хто представляє цю ОП на співбесіді. Систему підбору пар
        розширено: основний рекрутер ОП може бути запарований з будь-яким активним рекрутером, який входить хоча б
        в одну команду (включно з тими, кого додано лише як «додаткових» для інших ОП) — головне, щоб хтось один з
        пари був «основним» для цієї ОП. Список «додаткових» нижче лише позначає, що рекрутер входить до загального
        пулу партнерів, і не обмежує конкретні пари.
      </p>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="admin-split">
        <div className="card">
          <h3 style={{ marginBottom: 8 }}>ОП</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ops.map((op) => (
              <div key={op.code} className="flex-between">
                <button
                  className="btn btn-sm"
                  style={{ flex: 1, textAlign: 'left', background: selectedOp === op.code ? 'var(--accent)' : undefined, color: selectedOp === op.code ? '#fff' : undefined }}
                  onClick={() => selectOp(op.code)}
                >
                  {op.name}
                </button>
              </div>
            ))}
          </div>

          {selectedOp && (
            <div className="flex" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" style={{ flex: '1 1 auto' }} onClick={() => handleRenameOp(selectedOp)}>Перейменувати</button>
              <button className="btn btn-sm btn-danger" style={{ flex: '1 1 auto' }} onClick={() => handleDeleteOp(selectedOp)}>Видалити</button>
            </div>
          )}

          <form onSubmit={handleCreateOp} style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <h3 style={{ marginBottom: 8 }}>Нова ОП</h3>
            <div className="field">
              <label>Код</label>
              <input value={newOpCode} onChange={(e) => setNewOpCode(e.target.value)} placeholder="наприклад IT" required />
            </div>
            <div className="field">
              <label>Назва</label>
              <input value={newOpName} onChange={(e) => setNewOpName(e.target.value)} required />
            </div>
            <button className="btn btn-sm btn-primary" type="submit">Додати ОП</button>
          </form>
        </div>

        <div className="card">
          {!team || !selectedOp ? (
            <p className="muted">Оберіть ОП.</p>
          ) : (
            <>
              <h2>{ops.find((o) => o.code === selectedOp)?.name}</h2>
              <div className="admin-two-col" style={{ marginTop: 12 }}>
                <div>
                  <h3>Основні рекрутери</h3>
                  <p className="muted" style={{ marginBottom: 8 }}>Зазвичай з ОП кандидата ({opName(selectedOp)})</p>
                  {recruiters.map((r) => (
                    <label key={r.id} className="flex" style={{ gap: 8, marginBottom: 4 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={team.main.includes(r.id)}
                        onChange={() => toggleRole(r.id, 'main')}
                      />
                      {r.fullName} {r.homeOp ? <span className="badge badge-gray">{opName(r.homeOp)}</span> : null}
                    </label>
                  ))}
                </div>
                <div>
                  <h3>Додаткові рекрутери</h3>
                  <p className="muted" style={{ marginBottom: 8 }}>
                    Входять до загального пулу партнерів (не обов&#39;язково з цієї ОП)
                  </p>
                  {recruiters.map((r) => (
                    <label key={r.id} className="flex" style={{ gap: 8, marginBottom: 4 }}>
                      <input
                        type="checkbox"
                        style={{ width: 'auto' }}
                        checked={team.secondary.includes(r.id)}
                        onChange={() => toggleRole(r.id, 'secondary')}
                      />
                      {r.fullName} {r.homeOp ? <span className="badge badge-gray">{opName(r.homeOp)}</span> : null}
                    </label>
                  ))}
                </div>
              </div>
              <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={saveTeam}>Зберегти команду</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
