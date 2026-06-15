import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';
import InterviewCalendar from '../../components/InterviewCalendar.jsx';

export default function GeneralCalendarPage() {
  const { user } = useAuth();
  const [events, setEvents] = useState([]);
  const [recruiters, setRecruiters] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const url = user.isAdmin ? '/calendar/general' : '/calendar/mine';
      const res = await api.get(url);
      setEvents(res.data.events);
      if (user.isAdmin) {
        const r = await api.get('/recruiters');
        setRecruiters(r.data.recruiters.filter((x) => x.active));
      }
      setLoading(false);
    }
    load();
  }, [user]);

  if (loading) return <p className="muted">Завантаження...</p>;

  return (
    <div>
      <h1>{user.isAdmin ? 'Загальний календар співбесід' : 'Мій календар співбесід'}</h1>

      {user.isAdmin && recruiters.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Календар окремого рекрутера</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {recruiters.map((r) => (
              <Link key={r.id} className="btn btn-sm" to={`/admin/calendar/${r.id}`}>{r.fullName}</Link>
            ))}
          </div>
        </div>
      )}

      <InterviewCalendar events={events} />
    </div>
  );
}
