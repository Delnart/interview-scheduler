const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const slotMatcher = require('../utils/slotMatcher');
const googleCalendar = require('../utils/googleCalendar');
const telegram = require('../utils/telegram');
const asyncHandler = require('../utils/asyncHandler');
const withSlotLock = require('../utils/slotLock');

const router = express.Router();

const bookingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Занадто багато запитів. Спробуйте пізніше.' },
});

// List of OPs candidates can choose from
router.get('/ops', asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT code, name FROM op_codes ORDER BY name').all();
  res.json({ ops: rows });
}));

// Available (open) interview slots for an OP, sorted chronologically.
router.get('/slots', asyncHandler(async (req, res) => {
  const opCode = req.query.op;
  if (!opCode) return res.status(400).json({ error: 'Параметр op є обовʼязковим' });

  const op = await db.prepare('SELECT code FROM op_codes WHERE code = ?').get(opCode);
  if (!op) return res.status(404).json({ error: 'ОП не знайдено' });

  const now = new Date().toISOString();
  const rows = await db
    .prepare(
      `SELECT id, start_time as "startTime", end_time as "endTime"
       FROM matched_slots
       WHERE op_code = ? AND status = 'open' AND start_time > ?
       ORDER BY start_time`
    )
    .all(opCode, now);
  res.json({ slots: rows });
}));

// Only email + Telegram are collected; ПІБ, group and answers are matched from the
// Google Sheet. fullName/groupName stay optional for backwards compatibility.
const bookingSchema = z.object({
  matchedSlotId: z.string().min(1),
  email: z.string().trim().email('Невірний формат email'),
  telegramTag: z
    .string()
    .trim()
    .min(2, 'Вкажіть тег у Telegram')
    .max(64)
    .transform((v) => (v.startsWith('@') ? v : `@${v}`)),
  fullName: z.string().trim().max(200).optional().default(''),
  groupName: z.string().trim().max(100).optional().default(''),
});

// Book an interview slot
router.post('/bookings', bookingLimiter, asyncHandler(async (req, res) => {
  const parsed = bookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const { matchedSlotId, fullName, email, telegramTag, groupName } = parsed.data;

  const slot = await db.prepare('SELECT * FROM matched_slots WHERE id = ?').get(matchedSlotId);
  if (!slot) return res.status(404).json({ error: 'Слот не знайдено' });
  if (slot.status !== 'open') return res.status(409).json({ error: 'Цей слот вже зайнятий. Оберіть інший час.' });
  if (new Date(slot.start_time) < new Date()) return res.status(409).json({ error: 'Цей слот вже минув. Оберіть інший час.' });

  const bookingId = uuid();

  // Guard against double-booking a recruiter: two open slots for the same recruiter
  // at overlapping times can coexist across OPs until regeneration. Reject if either
  // recruiter already has a *booked* slot overlapping this time range, in any OP.
  const overlap = await db
    .prepare(
      `SELECT id FROM matched_slots
       WHERE status = 'booked'
         AND id != ?
         AND (main_recruiter_id IN (?, ?) OR secondary_recruiter_id IN (?, ?))
         AND start_time < ? AND end_time > ?`
    )
    .get(
      matchedSlotId,
      slot.main_recruiter_id,
      slot.secondary_recruiter_id,
      slot.main_recruiter_id,
      slot.secondary_recruiter_id,
      slot.end_time,
      slot.start_time
    );
  if (overlap) {
    // This slot is stale (one of its recruiters is already booked elsewhere at this
    // time) — remove it so it stops being offered, and report it as unavailable.
    await db.prepare(`UPDATE matched_slots SET status = 'cancelled' WHERE id = ? AND status = 'open'`).run(matchedSlotId);
    return res.status(409).json({ error: 'Цей слот вже зайнятий. Оберіть інший час.' });
  }

  // Atomically claim the slot (conditional UPDATE) and record the booking.
  const booked = await db.transaction(async (tx) => {
    const update = await tx
      .prepare(`UPDATE matched_slots SET status = 'booked' WHERE id = ? AND status = 'open'`)
      .run(matchedSlotId);
    if (update.changes === 0) return false;
    await tx
      .prepare(
        `INSERT INTO bookings (id, matched_slot_id, full_name, email, telegram_tag, group_name, op_code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(bookingId, matchedSlotId, fullName, email, telegramTag, groupName, slot.op_code);
    return true;
  });
  if (!booked) return res.status(409).json({ error: 'Цей слот вже зайнятий. Оберіть інший час.' });

  // Respond as soon as the booking is committed — Google Calendar and Telegram are
  // best-effort side effects and run in the background.
  res.status(201).json({
    ok: true,
    booking: {
      id: bookingId,
      opCode: slot.op_code,
      startTime: slot.start_time,
      endTime: slot.end_time,
    },
  });

  // Best-effort: ping the OP's recruiters in their Telegram thread (no-op if Telegram
  // isn't configured). Fire-and-forget so it never affects the committed booking.
  telegram
    .notifyNewBooking(matchedSlotId)
    .catch((err) => console.error('Не вдалося надіслати сповіщення в Telegram:', err.message));

  // Best-effort cleanup, in the background with its own error handling (the booking
  // is already committed, so a failure here must not surface as an error). Work on a
  // given slot is serialized via withSlotLock so a concurrent rebook/replace on the
  // same slot can't interleave with the Google-event bookkeeping.
  (async () => {
    // Google Calendar events for both recruiters.
    const op = await db.prepare('SELECT name FROM op_codes WHERE code = ?').get(slot.op_code);
    const event = googleCalendar.buildInterviewEvent({
      groupLabel: op ? op.name : slot.op_code,
      fullName,
      email,
      telegramTag,
      groupName,
      start: new Date(slot.start_time),
      end: new Date(slot.end_time),
    });
    try {
      await withSlotLock(matchedSlotId, async () => {
        const cur = await db.prepare('SELECT status FROM matched_slots WHERE id = ?').get(matchedSlotId);
        if (!cur || cur.status !== 'booked') return; // already rebooked away — don't create events
        const [mainEventId, secEventId] = await Promise.all([
          googleCalendar.createEvent(slot.main_recruiter_id, event),
          googleCalendar.createEvent(slot.secondary_recruiter_id, event),
        ]);
        if (mainEventId || secEventId) {
          const w = await db
            .prepare(
              `UPDATE matched_slots SET google_event_id_main = ?, google_event_id_secondary = ?
               WHERE id = ? AND status = 'booked'`
            )
            .run(mainEventId, secEventId, matchedSlotId);
          if (w.changes === 0) {
            // Slot got cancelled while we were creating — don't leave ghost events.
            await googleCalendar.deleteEvent(slot.main_recruiter_id, mainEventId);
            await googleCalendar.deleteEvent(slot.secondary_recruiter_id, secEventId);
          }
        }
      });
    } catch (err) {
      console.error('Failed to create Google Calendar events for booking', bookingId, err.message);
    }

    // "Change time": rebooking with the same Telegram cancels the candidate's previous
    // future interview(s), frees that time and removes the stale Google Calendar events.
    // Only bookings strictly OLDER than this one count as "prior" — otherwise two rapid
    // rebookings could each cancel the other, leaving the candidate with nothing.
    const prior = await db
      .prepare(
        `SELECT ms.id
         FROM matched_slots ms
         JOIN bookings b ON b.matched_slot_id = ms.id
         WHERE ms.status = 'booked'
           AND ms.id != ?
           AND ms.start_time > ?
           AND lower(b.telegram_tag) = lower(?)
           AND b.created_at < (SELECT created_at FROM bookings WHERE id = ?)`
      )
      .all(matchedSlotId, new Date().toISOString(), telegramTag, bookingId);

    for (const p of prior) {
      await withSlotLock(p.id, async () => {
        // Re-read under the lock: status/event ids may have changed since the SELECT.
        const cur = await db.prepare('SELECT * FROM matched_slots WHERE id = ?').get(p.id);
        if (!cur || cur.status !== 'booked') return;
        // Reply to the old booking's Telegram message ("час змінено") while its booking
        // row still exists — the notification needs the candidate context.
        await telegram
          .notifyRescheduled(p.id, matchedSlotId)
          .catch((err) => console.error('Не вдалося надіслати сповіщення про перенесення:', err.message));
        await googleCalendar.deleteEvent(cur.main_recruiter_id, cur.google_event_id_main);
        await googleCalendar.deleteEvent(cur.secondary_recruiter_id, cur.google_event_id_secondary);
        // 'cancelled' also stops the "5 minutes before" reminder (it only looks at booked slots).
        await db.prepare(`UPDATE matched_slots SET status = 'cancelled' WHERE id = ?`).run(p.id);
        await db.prepare('DELETE FROM bookings WHERE matched_slot_id = ?').run(p.id);
      });
    }

    // Regenerate everywhere: the global partner pool means this change can affect any
    // OP's slots (clear now-stale open slots, re-open freed time). Coalesced + in the
    // background so it never blocks and overlapping triggers collapse into one pass.
    slotMatcher.scheduleRegen();
    // Re-arm the reminder loop: this booking (or the cancellations above) changed what's
    // due next, and the loop may be sleeping for hours.
    telegram.bumpReminders();
  })().catch((err) => console.error('Помилка фонової обробки після бронювання:', err.message));
}));

module.exports = router;
