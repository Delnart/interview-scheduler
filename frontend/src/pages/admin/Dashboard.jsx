import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import api from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';

export default function Dashboard() {
  const { user } = useAuth();
  const [ops, setOps] = useState([]);
  const [openByOp, setOpenByOp] = useState({});
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const opsRes = await api.get('/ops');
      setOps(opsRes.data.ops);

      if (user?.isAdmin) {
        const slotsRes = await api.get('/slots', { params: { status: 'open' } });
        const counts = {};
        for (const s of slotsRes.data.slots) counts[s.opCode] = (counts[s.opCode] || 0) + 1;
        setOpenByOp(counts);

        const calRes = await api.get('/calendar/general');
        const now = new Date();
        const next = calRes.data.events.filter((e) => new Date(e.startTime) >= now).slice(0, 8);
        setUpcoming(next);
      } else {
        const calRes = await api.get('/calendar/mine');
        const now = new Date();
        const next = calRes.data.events.filter((e) => new Date(e.startTime) >= now).slice(0, 8);
        setUpcoming(next);
      }
      setLoading(false);
    }
    load();
  }, [user]);

  if (loading) return <p className="muted">Завантаження...</p>;

  return (
    <div>
      <h1>Огляд</h1>

      {user?.isAdmin && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', marginBottom: 24 }}>
          {ops.map((op) => (
            <div key={op.code} className="card" style={{ textAlign: 'center' }}>
              <div className="muted">{op.name}</div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{openByOp[op.code] || 0}</div>
              <div className="muted">вільних слотів</div>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>{user?.isAdmin ? 'Найближчі співбесіди' : 'Мої найближчі співбесіди'}</h2>
        {upcoming.length === 0 ? (
          <p className="muted">Немає запланованих співбесід.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Дата і час</th>
                <th>ОП</th>
                <th>Рекрутери</th>
                <th>Кандидат</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((e) => (
                <tr key={e.id}>
                  <td>{format(new Date(e.startTime), 'dd.MM.yyyy HH:mm')}</td>
                  <td><span className="badge">{e.opName}</span></td>
                  <td>{e.mainRecruiter.fullName} + {e.secondaryRecruiter.fullName}</td>
                  <td>{e.candidate ? `${e.candidate.fullName} (${e.candidate.group})` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex" style={{ marginTop: 16 }}>
        <Link className="btn" to="/admin/availability">Додати вільний час</Link>
        <Link className="btn" to="/admin/calendar">Загальний календар</Link>
      </div>
    </div>
  );
}
