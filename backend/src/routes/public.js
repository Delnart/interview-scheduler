const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const slotMatcher = require('../utils/slotMatcher');
const googleCalendar = require('../utils/googleCalendar');
const asyncHandler = require('../utils/asyncHandler');

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

  // Best-effort Google Calendar event creation for both recruiters
  const op = await db.prepare('SELECT name FROM op_codes WHERE code = ?').get(slot.op_code);
  const groupLabel = op ? op.name : slot.op_code;
  const start = new Date(slot.start_time);
  const end = new Date(slot.end_time);
  const summary = `Співбесіда (відбір кураторів) — група ${groupLabel}${fullName ? ` — ${fullName}` : ''}`;
  const description = [
    `Група: ${groupLabel}`,
    fullName ? `Кандидат: ${fullName}` : null,
    `Email: ${email}`,
    `Telegram: ${telegramTag}`,
    groupName ? `Навчальна група: ${groupName}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const [mainEventId, secEventId] = await Promise.all([
      googleCalendar.createEvent(slot.main_recruiter_id, { summary, description, start, end }),
      googleCalendar.createEvent(slot.secondary_recruiter_id, { summary, description, start, end }),
    ]);
    if (mainEventId || secEventId) {
      await db.prepare('UPDATE matched_slots SET google_event_id_main = ?, google_event_id_secondary = ? WHERE id = ?').run(
        mainEventId,
        secEventId,
        matchedSlotId
      );
    }
  } catch (err) {
    console.error('Failed to create Google Calendar events for booking', bookingId, err.message);
  }

  res.status(201).json({
    ok: true,
    booking: {
      id: bookingId,
      opCode: slot.op_code,
      startTime: slot.start_time,
      endTime: slot.end_time,
    },
  });

  // Best-effort cleanup, in the background with its own error handling (the booking
  // is already committed, so a failure here must not surface as an error).
  (async () => {
    // "Change time": rebooking with the same Telegram cancels the candidate's previous
    // future interview(s), frees that time and removes the stale Google Calendar events.
    const prior = await db
      .prepare(
        `SELECT ms.id, ms.main_recruiter_id, ms.secondary_recruiter_id,
                ms.google_event_id_main, ms.google_event_id_secondary
         FROM matched_slots ms
         JOIN bookings b ON b.matched_slot_id = ms.id
         WHERE ms.status = 'booked'
           AND ms.id != ?
           AND ms.start_time > ?
           AND lower(b.telegram_tag) = lower(?)`
      )
      .all(matchedSlotId, new Date().toISOString(), telegramTag);

    for (const p of prior) {
      await googleCalendar.deleteEvent(p.main_recruiter_id, p.google_event_id_main);
      await googleCalendar.deleteEvent(p.secondary_recruiter_id, p.google_event_id_secondary);
      await db.prepare(`UPDATE matched_slots SET status = 'cancelled' WHERE id = ?`).run(p.id);
      await db.prepare('DELETE FROM bookings WHERE matched_slot_id = ?').run(p.id);
    }

    // Regenerate everywhere: the global partner pool means this change can affect any
    // OP's slots (clear now-stale open slots, re-open freed time).
    await slotMatcher.regenerateAll();
  })().catch((err) => console.error('Помилка фонової обробки після бронювання:', err.message));
}));

module.exports = router;
