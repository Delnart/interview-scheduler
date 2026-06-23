import { useEffect, useState } from 'react';
import { Calendar, dateFnsLocalizer } from 'react-big-calendar';
import format from 'date-fns/format';
import parse from 'date-fns/parse';
import startOfWeek from 'date-fns/startOfWeek';
import getDay from 'date-fns/getDay';
import { uk } from 'date-fns/locale';

const locales = { uk };

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 1 }),
  getDay,
  locales,
});

const messages = {
  date: 'Дата',
  time: 'Час',
  event: 'Подія',
  allDay: 'Увесь день',
  week: 'Тиждень',
  work_week: 'Робочий тиждень',
  day: 'День',
  month: 'Місяць',
  previous: 'Назад',
  next: 'Далі',
  yesterday: 'Вчора',
  tomorrow: 'Завтра',
  today: 'Сьогодні',
  agenda: 'Список',
  noEventsInRange: 'Немає подій у цьому діапазоні.',
  showMore: (total) => `+ ще ${total}`,
};

const VIEWS = ['month', 'week', 'day', 'agenda'];

// Interviews only run 08:00–23:00, so clamp the day/week time grid to that range
// instead of showing an empty 23:00–08:00 stretch. (Date part is ignored by rbc.)
const MIN_TIME = new Date(1970, 0, 1, 8, 0, 0);
const MAX_TIME = new Date(1970, 0, 1, 23, 0, 0);

// "@username" / "username" / "https://t.me/username" -> a t.me URL, or null if unusable.
function telegramUrl(tag) {
  if (!tag) return null;
  const handle = tag.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
  return /^[A-Za-z0-9_]{2,64}$/.test(handle) ? `https://t.me/${handle}` : null;
}

function EventDetailsModal({ event, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const r = event.resource;
  const c = r.candidate;
  const tgUrl = c ? telegramUrl(c.telegram) : null;
  const dayLabel = format(new Date(r.startTime), 'EEEE, d MMMM yyyy', { locale: uk });
  const timeLabel = `${format(new Date(r.startTime), 'HH:mm')}–${format(new Date(r.endTime), 'HH:mm')}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="Деталі співбесіди" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" type="button" aria-label="Закрити" onClick={onClose}>
          ×
        </button>

        <div className="modal-head">
          <span className="booking-badge">{r.opName}</span>
          <div>
            <div className="modal-title">Співбесіда — група {r.opName}</div>
            <div className="muted">{dayLabel} · {timeLabel}</div>
          </div>
        </div>

        <div className="modal-section">
          <div className="modal-label">Рекрутери</div>
          <div>{r.mainRecruiter.fullName} + {r.secondaryRecruiter.fullName}</div>
        </div>

        {c ? (
          <>
            <div className="modal-grid">
              {c.fullName && (
                <div className="modal-section">
                  <div className="modal-label">ПІБ</div>
                  <div>{c.fullName}</div>
                </div>
              )}
              <div className="modal-section">
                <div className="modal-label">Група (навчальна)</div>
                <div>{c.group || '—'}</div>
              </div>
              <div className="modal-section">
                <div className="modal-label">Telegram</div>
                <div>
                  {tgUrl ? (
                    <a href={tgUrl} target="_blank" rel="noopener noreferrer" className="tg-link">
                      {c.telegram} ↗
                    </a>
                  ) : (
                    c.telegram || '—'
                  )}
                </div>
              </div>
              <div className="modal-section">
                <div className="modal-label">Email</div>
                <div>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</div>
              </div>
            </div>

            <div className="modal-section">
              <div className="modal-label">Відповіді анкети</div>
              {Array.isArray(c.answers) && c.answers.length > 0 ? (
                <dl className="answers">
                  {c.answers.map((a, i) => (
                    <div key={i} className="answers-row">
                      <dt>{a.question}</dt>
                      <dd>{a.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Підтягуються з Google-таблиці за поштою/Telegram (потрібно налаштувати інтеграцію).
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="muted">Слот ще не заброньовано кандидатом.</p>
        )}
      </div>
    </div>
  );
}

export default function InterviewCalendar({ events, defaultView = 'week' }) {
  const [date, setDate] = useState(new Date());
  const [view, setView] = useState(defaultView);
  const [selected, setSelected] = useState(null);

  const calendarEvents = events.map((e) => ({
    id: e.id,
    title: `${e.opName} — ${e.candidate?.fullName || e.candidate?.telegram || 'кандидат'}`,
    start: new Date(e.startTime),
    end: new Date(e.endTime),
    resource: e,
  }));

  return (
    <div className="calendar-wrap">
      <Calendar
        localizer={localizer}
        events={calendarEvents}
        date={date}
        view={view}
        onNavigate={setDate}
        onView={setView}
        views={VIEWS}
        messages={messages}
        culture="uk"
        startAccessor="start"
        endAccessor="end"
        style={{ height: '100%' }}
        min={MIN_TIME}
        max={MAX_TIME}
        scrollToTime={MIN_TIME}
        popup
        onSelectEvent={(e) => setSelected(e)}
        eventPropGetter={() => ({ className: 'rbc-interview-event' })}
        tooltipAccessor={(e) => {
          const r = e.resource;
          const lines = [`Група: ${r.opName}`, `Рекрутери: ${r.mainRecruiter.fullName}, ${r.secondaryRecruiter.fullName}`];
          if (r.candidate) {
            lines.push(
              r.candidate.fullName ? `ПІБ: ${r.candidate.fullName}` : null,
              `Telegram: ${r.candidate.telegram}`
            );
          }
          return lines.filter(Boolean).join('\n');
        }}
      />
      {selected && <EventDetailsModal event={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
