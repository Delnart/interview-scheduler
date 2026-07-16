const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const slotMatcher = require('../utils/slotMatcher');
const googleCalendar = require('../utils/googleCalendar');
const asyncHandler = require('../utils/asyncHandler');
const withSlotLock = require('../utils/slotLock');

const router = express.Router();

function slotRow(row) {
  return {
    id: row.id,
    opCode: row.op_code,
    opName: row.op_name,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    mainRecruiter: { id: row.main_recruiter_id, fullName: row.main_name },
    secondaryRecruiter: { id: row.secondary_recruiter_id, fullName: row.secondary_name },
  };
}

const SELECT_SLOTS = `
  SELECT matched_slots.*, op_codes.name as op_name,
         mr.full_name as main_name, sr.full_name as secondary_name
  FROM matched_slots
  JOIN op_codes ON op_codes.code = matched_slots.op_code
  JOIN recruiters mr ON mr.id = matched_slots.main_recruiter_id
  JOIN recruiters sr ON sr.id = matched_slots.secondary_recruiter_id
`;

// List matched slots (admin only) - optionally filter by op / status
router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.op) {
    clauses.push('matched_slots.op_code = ?');
    params.push(req.query.op);
  }
  if (req.query.status) {
    clauses.push('matched_slots.status = ?');
    params.push(req.query.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.prepare(`${SELECT_SLOTS} ${where} ORDER BY matched_slots.start_time`).all(...params);
  res.json({ slots: rows.map(slotRow) });
}));

// Replace the main and/or secondary recruiter on a booked interview (admin only).
// Swaps the Google Calendar event to the new recruiter in the background.
const replaceSchema = z
  .object({
    mainRecruiterId: z.string().min(1).optional(),
    secondaryRecruiterId: z.string().min(1).optional(),
  })
  .refine((d) => d.mainRecruiterId || d.secondaryRecruiterId, { message: 'Немає полів для оновлення' });

router.put('/:id/recruiters', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = replaceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });

  const slot = await db.prepare('SELECT * FROM matched_slots WHERE id = ?').get(req.params.id);
  if (!slot) return res.status(404).json({ error: 'Не знайдено' });
  if (slot.status !== 'booked') return res.status(409).json({ error: 'Замінити рекрутера можна лише на заброньованій співбесіді' });

  const newMain = parsed.data.mainRecruiterId ?? slot.main_recruiter_id;
  const newSec = parsed.data.secondaryRecruiterId ?? slot.secondary_recruiter_id;
  if (newMain === newSec) return res.status(400).json({ error: 'Основний та другий рекрутер мають бути різними' });

  const changed = [];
  if (newMain !== slot.main_recruiter_id) changed.push(newMain);
  if (newSec !== slot.secondary_recruiter_id) changed.push(newSec);
  if (changed.length === 0) return res.json({ ok: true });

  // ponytail: check-then-act — a booking that commits in this window can still
  // double-book the new recruiter (same TOCTOU class as two concurrent bookings);
  // full fix needs per-recruiter advisory locks in both flows.
  for (const id of changed) {
    const r = await db.prepare('SELECT id FROM recruiters WHERE id = ? AND active = 1').get(id);
    if (!r) return res.status(400).json({ error: 'Рекрутера не знайдено або він неактивний' });
    const busy = await db
      .prepare(
        `SELECT id FROM matched_slots
         WHERE status = 'booked' AND id != ?
           AND (main_recruiter_id = ? OR secondary_recruiter_id = ?)
           AND start_time < ? AND end_time > ?`
      )
      .get(slot.id, id, id, slot.end_time, slot.start_time);
    if (busy) return res.status(409).json({ error: 'У нового рекрутера вже є співбесіда в цей час' });
  }

  const NOT_BOOKED = Symbol('not-booked');
  try {
    await db.transaction(async (tx) => {
      // The new pair may already have an 'open' slot at this exact time (would collide
      // with the UNIQUE key) — drop it, the booked interview supersedes it.
      await tx
        .prepare(
          `DELETE FROM matched_slots
           WHERE op_code = ? AND main_recruiter_id = ? AND secondary_recruiter_id = ?
             AND start_time = ? AND id != ? AND status != 'booked'`
        )
        .run(slot.op_code, newMain, newSec, slot.start_time, slot.id);
      const upd = await tx
        .prepare(`UPDATE matched_slots SET main_recruiter_id = ?, secondary_recruiter_id = ? WHERE id = ? AND status = 'booked'`)
        .run(newMain, newSec, slot.id);
      // The candidate may have rebooked away between our check and this write.
      if (upd.changes === 0) throw NOT_BOOKED;
    });
  } catch (err) {
    if (err === NOT_BOOKED) return res.status(409).json({ error: 'Співбесіда вже неактуальна (перенесена або скасована)' });
    if (err.code === '23505') return res.status(409).json({ error: 'У нового рекрутера вже є співбесіда в цей час' });
    throw err;
  }

  const updated = await db.prepare(`${SELECT_SLOTS} WHERE matched_slots.id = ?`).get(slot.id);
  res.json({ ok: true, slot: slotRow(updated) });

  // The swap changes both recruiters' effective free time — refresh open slots.
  slotMatcher.scheduleRegen();

  // Background: move the Google Calendar events to the new recruiters. Serialized
  // per slot and re-checked, so a concurrent rebook/second replace can't leave
  // ghost events or stale event ids.
  withSlotLock(slot.id, async () => {
    const cur = await db.prepare('SELECT * FROM matched_slots WHERE id = ?').get(slot.id);
    // Superseded meanwhile (rebooked away, or another replace changed it again).
    if (!cur || cur.status !== 'booked') return;

    const booking = await db.prepare('SELECT * FROM bookings WHERE matched_slot_id = ?').get(slot.id);
    const op = await db.prepare('SELECT name FROM op_codes WHERE code = ?').get(slot.op_code);
    const event = googleCalendar.buildInterviewEvent({
      groupLabel: op ? op.name : slot.op_code,
      fullName: booking?.full_name || '',
      email: booking?.email || '',
      telegramTag: booking?.telegram_tag || '',
      groupName: booking?.group_name || '',
      start: new Date(slot.start_time),
      end: new Date(slot.end_time),
    });

    // Per-field: delete the old recruiter's event, create for the new one, and record
    // it only if that recruiter is still assigned (otherwise undo the creation).
    const swaps = [
      { changed: newMain !== slot.main_recruiter_id, oldId: slot.main_recruiter_id, newId: newMain, col: 'main_recruiter_id', evCol: 'google_event_id_main', evOld: cur.google_event_id_main },
      { changed: newSec !== slot.secondary_recruiter_id, oldId: slot.secondary_recruiter_id, newId: newSec, col: 'secondary_recruiter_id', evCol: 'google_event_id_secondary', evOld: cur.google_event_id_secondary },
    ];
    for (const s of swaps) {
      if (!s.changed) continue;
      await googleCalendar.deleteEvent(s.oldId, s.evOld);
      const created = await googleCalendar.createEvent(s.newId, event); // null if not connected
      const w = await db
        .prepare(`UPDATE matched_slots SET ${s.evCol} = ? WHERE id = ? AND ${s.col} = ? AND status = 'booked'`)
        .run(created, slot.id, s.newId);
      if (w.changes === 0 && created) await googleCalendar.deleteEvent(s.newId, created);
    }
  }).catch((err) => console.error('Помилка фонової обробки заміни рекрутера:', err.message));
}));

// Manually trigger regeneration of matched slots (admin only)
const regenSchema = z.object({ op: z.string().optional() });
router.post('/regenerate', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = regenSchema.safeParse(req.body || {});
  const op = parsed.success ? parsed.data.op : undefined;
  if (op) {
    const exists = await db.prepare('SELECT code FROM op_codes WHERE code = ?').get(op);
    if (!exists) return res.status(404).json({ error: 'ОП не знайдено' });
    await slotMatcher.generateMatchedSlotsForOp(op);
  } else {
    await slotMatcher.regenerateAll();
  }
  res.json({ ok: true });
}));

module.exports = router;
