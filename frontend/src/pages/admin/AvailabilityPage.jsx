import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { uk } from 'date-fns/locale';
import api, { errorMessage } from '../../api.js';
import { useAuth } from '../../AuthContext.jsx';

// Recruiters pick availability from a fixed daily grid: 08:00–21:00,
// each block = 45 min interview + 15 min break, i.e. one slot per hour
// starting on the hour and lasting 45 minutes (08:00–08:45, 09:00–09:45, ...,
// 20:00–20:45).
const SLOT_HOURS = Array.from({ length: 13 }, (_, i) => 8 + i); // 8..20
const SLOT_MINUTES = 45;

function pad(n) {
  return String(n).padStart(2, '0');
}

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slotRangeForDate(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, hour, 0, 0, 0);
  const end = new Date(start.getTime() + SLOT_MINUTES * 60 * 1000);
  return { start, end };
}

function dayBoundsForDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { start, end };
}

export default function AvailabilityPage() {
  const { user } = useAuth();
  const [recruiters, setRecruiters] = useState([]);
  const [recruiterId, setRecruiterId] = useState(user.id);
  const [items, setItems] = useState([]);
  const [date, setDate] = useState(todayDateString());
  const [selectedHours, setSelectedHours] = useState(new Set());
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user.isAdmin) {
      api.get('/recruiters').then((res) => setRecruiters(res.data.recruiters.filter((r) => r.active)));
    }
  }, [user.isAdmin]);

  useEffect(() => {
    load();
  }, [recruiterId]);

  // Whenever the loaded availability or the selected date changes, recompute
  // which checkboxes should be pre-checked for that date.
  useEffect(() => {
    const hours = new Set();
    for (const item of items) {
      const start = new Date(item.startTime);
      const itemDate = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
      if (itemDate === date) hours.add(start.getHours());
    }
    setSelectedHours(hours);
  }, [items, date]);

  async function load() {
    setLoading(true);
    const res = await api.get('/availability', { params: { recruiterId } });
    setItems(res.data.availability);
    setLoading(false);
  }

  function toggleHour(hour) {
    setError('');
    setSuccess('');
    setSelectedHours((prev) => {
      const next = new Set(prev);
      if (next.has(hour)) next.delete(hour);
      else next.add(hour);
      return next;
    });
  }

  async function handleConfirm() {
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const { start: dayStart, end: dayEnd } = dayBoundsForDate(date);
      const slots = [...selectedHours]
        .sort((a, b) => a - b)
        .map((hour) => {
          const { start, end } = slotRangeForDate(date, hour);
          return { startTime: start.toISOString(), endTime: end.toISOString() };
        });

      await api.put('/availability/day', {
        recruiterId,
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
        slots,
      });
      setSuccess('Вільний час на цей день збережено. Слоти для співбесід оновляться автоматично.');
      load();
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося зберегти'));
    } finally {
      setSaving(false);
    }
  }

  async function handleClearDay() {
    if (!window.confirm('Очистити весь вільний час на цей день?')) return;
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const { start: dayStart, end: dayEnd } = dayBoundsForDate(date);
      await api.put('/availability/day', {
        recruiterId,
        dayStart: dayStart.toISOString(),
        dayEnd: dayEnd.toISOString(),
        slots: [],
      });
      setSuccess('День очищено.');
      load();
    } catch (err) {
      setError(errorMessage(err, 'Не вдалося очистити день'));
    } finally {
      setSaving(false);
    }
  }

  const groupedByDay = useMemo(() => {
    const groups = new Map();
    for (const item of items) {
      const start = new Date(item.startTime);
      const key = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [items]);

  const now = new Date();

  return (
    <div>
      <h1>Мій вільний час</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Оберіть дату та позначте всі проміжки часу, коли ви готові проводити співбесіди (з 08:00 до 21:00).
        Кожен слот триває 45 хвилин (співбесіда) + 15 хвилин перерви до наступного. Можна обрати декілька
        слотів одразу — натисніть «Підтвердити вибір», щоб зберегти. Система автоматично знайде спільний
        вільний час з іншим рекрутером і запропонує цей час кандидатам.
      </p>

      {user.isAdmin && recruiters.length > 0 && (
        <div className="field" style={{ maxWidth: 320 }}>
          <label>Рекрутер</label>
          <select value={recruiterId} onChange={(e) => setRecruiterId(e.target.value)}>
            {recruiters.map((r) => (
              <option key={r.id} value={r.id}>{r.fullName}{r.id === user.id ? ' (я)' : ''}</option>
            ))}
          </select>
        </div>
      )}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="flex-between" style={{ marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div className="field" style={{ marginBottom: 0, maxWidth: 220 }}>
            <label>Дата</label>
            <input type="date" value={date} min={todayDateString()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="muted" style={{ alignSelf: 'flex-end' }}>
            {format(new Date(`${date}T00:00:00`), 'EEEE, d MMMM yyyy', { locale: uk })}
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        <div className="slot-grid">
          {SLOT_HOURS.map((hour) => {
            const { start, end } = slotRangeForDate(date, hour);
            const isPast = end <= now;
            const checked = selectedHours.has(hour);
            return (
              <label
                key={hour}
                className={`slot-checkbox ${checked ? 'slot-checkbox-selected' : ''} ${isPast ? 'slot-checkbox-disabled' : ''}`}
              >
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={checked}
                  disabled={isPast}
                  onChange={() => toggleHour(hour)}
                />
                {format(start, 'HH:mm')}–{format(end, 'HH:mm')}
              </label>
            );
          })}
        </div>

        <div className="flex" style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={handleConfirm} disabled={saving}>
            {saving ? 'Збереження...' : 'Підтвердити вибір'}
          </button>
          <button className="btn btn-danger" onClick={handleClearDay} disabled={saving}>Очистити день</button>
        </div>
      </div>

      <div className="card">
        <h2>Заплановані вільні дні</h2>
        {loading ? (
          <p className="muted">Завантаження...</p>
        ) : groupedByDay.length === 0 ? (
          <p className="muted">Ще нічого не додано.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {groupedByDay.map(([day, dayItems]) => (
              <div key={day} className="flex-between" style={{ flexWrap: 'wrap', gap: 8, borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div>
                  <strong>{format(new Date(`${day}T00:00:00`), 'EEEE, d MMMM yyyy', { locale: uk })}</strong>
                  <div style={{ marginTop: 4 }}>
                    {dayItems
                      .sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
                      .map((item) => (
                        <span key={item.id} className="badge" style={{ marginRight: 6 }}>
                          {format(new Date(item.startTime), 'HH:mm')}–{format(new Date(item.endTime), 'HH:mm')}
                        </span>
                      ))}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => setDate(day)}>Редагувати</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
