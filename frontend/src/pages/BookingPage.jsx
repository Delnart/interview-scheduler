import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { uk } from 'date-fns/locale';
import api, { errorMessage } from '../api.js';

const emptyForm = { email: '', telegramTag: '' };

const STEPS = [
  { n: 1, label: 'Група' },
  { n: 2, label: 'Час' },
  { n: 3, label: 'Контакти' },
];

// Formats a date as YYYYMMDDTHHMMSSZ (UTC) for the Google Calendar "dates" param.
function toGoogleDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

function googleCalendarUrl({ startTime, endTime, groupLabel }) {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Співбесіда (відбір кураторів) — група ${groupLabel}`,
    dates: `${toGoogleDate(startTime)}/${toGoogleDate(endTime)}`,
    details:
      "Співбесіда на відбір кураторів. Потрібен інший час? Запишіться ще раз, вказавши ту саму пошту та Telegram.",
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

// Client-side mirror of the backend schema for instant feedback (server validates too).
function validate(form) {
  const errors = {};

  const email = form.email.trim();
  if (!email) errors.email = 'Вкажіть email';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Невірний формат email';

  const tg = form.telegramTag.trim().replace(/^@/, '');
  if (!tg) errors.telegramTag = 'Вкажіть тег у Telegram';
  else if (tg.length < 2 || tg.length > 64) errors.telegramTag = 'Від 2 до 64 символів';

  return errors;
}

function CalendarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 9.5h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  );
}

function SlotsSkeleton() {
  return (
    <div className="slot-groups" aria-hidden="true">
      {[0, 1].map((row) => (
        <div key={row} className="slot-group">
          <div className="skeleton skeleton-line" />
          <div className="slot-grid">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="skeleton skeleton-slot" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function BookingPage() {
  const [ops, setOps] = useState([]);
  const [step, setStep] = useState(1);
  const [opCode, setOpCode] = useState('');
  const [slots, setSlots] = useState([]);
  const [slotsStatus, setSlotsStatus] = useState('idle'); // idle | loading | loaded | empty | error
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState(null);

  useEffect(() => {
    api.get('/public/ops').then((res) => setOps(res.data.ops)).catch(() => {});
  }, []);

  function loadSlots(code) {
    setSlotsStatus('loading');
    setSlots([]);
    api
      .get('/public/slots', { params: { op: code } })
      .then((res) => {
        const list = res.data.slots || [];
        setSlots(list);
        setSlotsStatus(list.length ? 'loaded' : 'empty');
      })
      .catch(() => setSlotsStatus('error'));
  }

  function selectGroup(code) {
    setOpCode(code);
    setSelectedSlot(null);
    setSubmitError('');
    setStep(2);
    loadSlots(code);
  }

  function selectSlot(slot) {
    setSelectedSlot(slot);
    setErrors({});
    setSubmitError('');
    setStep(3);
  }

  const groupedSlots = useMemo(() => {
    const groups = new Map();
    for (const slot of slots) {
      const day = format(new Date(slot.startTime), 'EEEE, d MMMM', { locale: uk });
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(slot);
    }
    return [...groups.entries()];
  }, [slots]);

  const groupLabel = ops.find((o) => o.code === opCode)?.name || opCode;

  function setField(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const v = validate(form);
    if (Object.keys(v).length) {
      setErrors(v);
      return;
    }
    setSubmitError('');
    setSubmitting(true);
    try {
      const res = await api.post('/public/bookings', {
        matchedSlotId: selectedSlot.id,
        email: form.email.trim(),
        telegramTag: form.telegramTag.trim(),
      });
      setConfirmation({ slot: selectedSlot, booking: res.data.booking });
      setStep(4);
    } catch (err) {
      setSubmitError(errorMessage(err, 'Не вдалося записатись. Можливо, цей час вже зайнято — оберіть інший.'));
      // The slot may have just been taken — bounce back to the time step with a fresh list.
      setSelectedSlot(null);
      setStep(2);
      loadSlots(opCode);
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setStep(1);
    setOpCode('');
    setSlots([]);
    setSlotsStatus('idle');
    setSelectedSlot(null);
    setForm(emptyForm);
    setErrors({});
    setSubmitError('');
    setConfirmation(null);
  }

  const progressWidth = step <= 1 ? '0px' : step === 2 ? 'calc((100% - 28px) * 0.5)' : 'calc(100% - 28px)';

  return (
    <div className="booking-page">
      <div className="card booking-card">
        <div className="booking-eyebrow">Відбір кураторів</div>
        <h1>Запис на співбесіду</h1>

        {step !== 4 && (
          <div className="booking-stepper">
            <div className="booking-stepper-line" />
            <div className="booking-stepper-progress" style={{ width: progressWidth }} />
            {STEPS.map((s) => {
              const status = step > s.n ? 'done' : step === s.n ? 'current' : 'todo';
              return (
                <div key={s.n} className="booking-step">
                  <div className={`booking-step-circle booking-step-circle-${status}`}>
                    {status === 'done' ? '✓' : s.n}
                  </div>
                  <div className={`booking-step-label booking-step-label-${status}`}>{s.label}</div>
                </div>
              );
            })}
          </div>
        )}

        {/* STEP 1 — group selection */}
        {step === 1 && (
          <div className="booking-section">
            <h2>Оберіть групу</h2>
            <p className="muted">Вкажіть шифр групи, для якої записуєтесь на співбесіду.</p>
            {ops.length === 0 ? (
              <p className="muted">Завантаження…</p>
            ) : (
              <div className="group-grid" role="group" aria-label="Групи">
                {ops.map((op) => (
                  <button
                    key={op.code}
                    type="button"
                    className={`group-card ${opCode === op.code ? 'group-card-selected' : ''}`}
                    aria-pressed={opCode === op.code}
                    onClick={() => selectGroup(op.code)}
                  >
                    <span className="group-card-code">{op.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* STEP 2 — time selection */}
        {step === 2 && (
          <div className="booking-section">
            <div className="booking-pill-banner">
              <div className="booking-pill-banner-left">
                <span className="booking-badge">{groupLabel}</span>
                <span className="booking-pill-banner-text">Група {groupLabel}</span>
              </div>
              <button type="button" className="link-btn" onClick={() => setStep(1)}>
                Змінити
              </button>
            </div>

            {submitError && <div className="alert alert-error">{submitError}</div>}

            <h2>Оберіть час</h2>

            <div aria-live="polite" aria-busy={slotsStatus === 'loading'}>
              {slotsStatus === 'loading' && <SlotsSkeleton />}

              {slotsStatus === 'error' && (
                <div className="booking-state">
                  <div className="booking-state-icon booking-state-icon-error">!</div>
                  <p>Не вдалося завантажити слоти. Перевірте з&#39;єднання та спробуйте ще раз.</p>
                  <button type="button" className="btn" onClick={() => loadSlots(opCode)}>
                    Спробувати ще раз
                  </button>
                </div>
              )}

              {slotsStatus === 'empty' && (
                <div className="booking-state">
                  <div className="booking-state-icon">
                    <CalendarIcon />
                  </div>
                  <p>Наразі немає доступних слотів для цієї групи. Спробуйте пізніше.</p>
                </div>
              )}

              {slotsStatus === 'loaded' && (
                <div className="slot-groups">
                  {groupedSlots.map(([day, daySlots]) => (
                    <div key={day} className="slot-group">
                      <div className="slot-group-title">{day}</div>
                      <div className="slot-grid">
                        {daySlots.map((slot) => (
                          <button
                            key={slot.id}
                            type="button"
                            className={`slot-btn ${selectedSlot?.id === slot.id ? 'slot-btn-selected' : ''}`}
                            onClick={() => selectSlot(slot)}
                          >
                            {format(new Date(slot.startTime), 'HH:mm')}–{format(new Date(slot.endTime), 'HH:mm')}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* STEP 3 — contacts */}
        {step === 3 && selectedSlot && (
          <div className="booking-section">
            <div className="booking-selected">
              <span className="booking-selected-icon">
                <CalendarIcon />
              </span>
              <div className="booking-selected-body">
                <div className="booking-selected-eyebrow">Обрано</div>
                <div className="booking-selected-day">
                  {format(new Date(selectedSlot.startTime), 'EEEE, d MMMM yyyy', { locale: uk })}
                </div>
                <div className="booking-selected-time">
                  {format(new Date(selectedSlot.startTime), 'HH:mm')}–{format(new Date(selectedSlot.endTime), 'HH:mm')} · група {groupLabel}
                </div>
              </div>
              <button type="button" className="link-btn" onClick={() => setStep(2)}>
                Змінити
              </button>
            </div>

            <p className="muted">Вкажіть пошту й Telegram, які ви вказували в Google-формі — за ними ми вас впізнаємо.</p>

            <form onSubmit={handleSubmit} noValidate>
              <div className="field">
                <label htmlFor="f-email">Email</label>
                <input
                  id="f-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setField('email', e.target.value)}
                  className={errors.email ? 'input-error' : ''}
                  aria-invalid={Boolean(errors.email)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  inputMode="email"
                />
                {errors.email && <div className="field-error">{errors.email}</div>}
              </div>

              <div className="field">
                <label htmlFor="f-tg">Telegram (тег)</label>
                <input
                  id="f-tg"
                  value={form.telegramTag}
                  onChange={(e) => setField('telegramTag', e.target.value)}
                  className={errors.telegramTag ? 'input-error' : ''}
                  aria-invalid={Boolean(errors.telegramTag)}
                  placeholder="@username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {errors.telegramTag && <div className="field-error">{errors.telegramTag}</div>}
              </div>

              {submitError && <div className="alert alert-error">{submitError}</div>}

              <button className="btn btn-primary btn-block" type="submit" disabled={submitting}>
                {submitting && <span className="spinner" aria-hidden="true" />}
                {submitting ? 'Записуємо…' : 'Записатись на співбесіду'}
              </button>
            </form>
          </div>
        )}

        {/* STEP 4 — confirmation */}
        {step === 4 && confirmation && (
          <div className="booking-confirm">
            <div className="booking-confirm-check">✓</div>
            <h2>Запис підтверджено!</h2>
            <p className="muted">Збережіть деталі — рекрутери чекатимуть на вас у вказаний час.</p>

            <div className="booking-confirm-card">
              <div className="booking-confirm-row">
                <span className="booking-badge">{groupLabel}</span>
                <span>Група {groupLabel}</span>
              </div>
              <div className="booking-divider" />
              <div className="booking-confirm-row booking-confirm-row-top">
                <span className="booking-selected-icon">
                  <CalendarIcon />
                </span>
                <div>
                  <div className="booking-confirm-day">
                    {format(new Date(confirmation.slot.startTime), 'EEEE, d MMMM yyyy', { locale: uk })}
                  </div>
                  <div className="muted">
                    {format(new Date(confirmation.slot.startTime), 'HH:mm')}–{format(new Date(confirmation.slot.endTime), 'HH:mm')}
                  </div>
                </div>
              </div>
            </div>

            <a
              className="btn btn-block"
              href={googleCalendarUrl({
                startTime: confirmation.slot.startTime,
                endTime: confirmation.slot.endTime,
                groupLabel,
              })}
              target="_blank"
              rel="noopener noreferrer"
            >
              <CalendarIcon />
              Додати в Google Calendar
            </a>

            <div className="booking-reschedule-note">
              <strong>Потрібен інший час?</strong> Натисніть «Записатися ще раз» і оберіть новий слот, вказавши{' '}
              <em>ту саму</em> пошту та Telegram. Попередній запис автоматично скасується, а рекрутери побачать
              оновлений час у своєму календарі.
            </div>

            <button type="button" className="link-btn" onClick={reset}>
              Записатися ще раз
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
