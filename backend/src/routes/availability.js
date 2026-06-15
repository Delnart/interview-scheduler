const express = require('express');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const slotMatcher = require('../utils/slotMatcher');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// A change to one recruiter's free time can affect every OP's slots (global partner
// pool), so regenerate everything — but only if they belong to the pool at all.
async function regenerateOpsForRecruiter(recruiterId) {
  const inPool = await db.prepare('SELECT 1 FROM op_recruiters WHERE recruiter_id = ?').get(recruiterId);
  if (!inPool) return;
  await slotMatcher.regenerateAll();
}

function resolveRecruiterId(req, requestedId) {
  if (req.user.isAdmin && requestedId) return requestedId;
  return req.user.id;
}

// List availability for a recruiter (self, or any recruiter if admin)
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const recruiterId = resolveRecruiterId(req, req.query.recruiterId);
  if (recruiterId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Немає доступу' });

  const rows = await db
    .prepare('SELECT id, recruiter_id as "recruiterId", start_time as "startTime", end_time as "endTime" FROM availability WHERE recruiter_id = ? ORDER BY start_time')
    .all(recruiterId);
  res.json({ availability: rows });
}));

const createSchema = z.object({
  recruiterId: z.string().optional(),
  startTime: z.string().datetime({ message: 'startTime має бути в форматі ISO 8601' }),
  endTime: z.string().datetime({ message: 'endTime має бути в форматі ISO 8601' }),
});

// Add a free-time slot
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const { startTime, endTime } = parsed.data;

  const recruiterId = resolveRecruiterId(req, parsed.data.recruiterId);
  if (recruiterId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Немає доступу' });

  const start = new Date(startTime);
  const end = new Date(endTime);
  if (!(start < end)) return res.status(400).json({ error: 'Час початку має бути раніше часу завершення' });
  if (end < new Date()) return res.status(400).json({ error: 'Не можна додавати час у минулому' });

  const recruiter = await db.prepare('SELECT id FROM recruiters WHERE id = ? AND active = 1').get(recruiterId);
  if (!recruiter) return res.status(404).json({ error: 'Рекрутера не знайдено' });

  const id = uuid();
  await db.prepare('INSERT INTO availability (id, recruiter_id, start_time, end_time) VALUES (?, ?, ?, ?)').run(
    id,
    recruiterId,
    start.toISOString(),
    end.toISOString()
  );

  await regenerateOpsForRecruiter(recruiterId);

  res.status(201).json({ availability: { id, recruiterId, startTime: start.toISOString(), endTime: end.toISOString() } });
}));

const daySlotSchema = z.object({
  startTime: z.string().datetime({ message: 'startTime має бути в форматі ISO 8601' }),
  endTime: z.string().datetime({ message: 'endTime має бути в форматі ISO 8601' }),
});

const daySchema = z.object({
  recruiterId: z.string().optional(),
  dayStart: z.string().datetime({ message: 'dayStart має бути в форматі ISO 8601' }),
  dayEnd: z.string().datetime({ message: 'dayEnd має бути в форматі ISO 8601' }),
  slots: z.array(daySlotSchema).max(48),
});

// Replace all availability slots for a recruiter within a single day (the day's
// boundaries are computed client-side so this respects the recruiter's local
// timezone). Used by the "select slots from a grid and confirm" UI: the client
// sends the full set of slots that should exist for that day, and any existing
// slots within [dayStart, dayEnd) that aren't in the new set are removed.
router.put('/day', requireAuth, asyncHandler(async (req, res) => {
  const parsed = daySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const { dayStart, dayEnd, slots } = parsed.data;

  const recruiterId = resolveRecruiterId(req, parsed.data.recruiterId);
  if (recruiterId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Немає доступу' });

  const recruiter = await db.prepare('SELECT id FROM recruiters WHERE id = ? AND active = 1').get(recruiterId);
  if (!recruiter) return res.status(404).json({ error: 'Рекрутера не знайдено' });

  const start = new Date(dayStart);
  const end = new Date(dayEnd);
  if (!(start < end)) return res.status(400).json({ error: 'dayStart має бути раніше dayEnd' });

  const now = new Date();
  const normalized = [];
  for (const slot of slots) {
    const slotStart = new Date(slot.startTime);
    const slotEnd = new Date(slot.endTime);
    if (!(slotStart < slotEnd)) return res.status(400).json({ error: 'Час початку слоту має бути раніше часу завершення' });
    if (slotStart < start || slotEnd > end) return res.status(400).json({ error: 'Слот виходить за межі обраного дня' });
    if (slotEnd < now) return res.status(400).json({ error: 'Не можна обирати слоти у минулому' });
    normalized.push({ start: slotStart.toISOString(), end: slotEnd.toISOString() });
  }

  await db.transaction(async (tx) => {
    await tx.prepare('DELETE FROM availability WHERE recruiter_id = ? AND start_time >= ? AND start_time < ?').run(
      recruiterId,
      start.toISOString(),
      end.toISOString()
    );
    const insertStmt = tx.prepare('INSERT INTO availability (id, recruiter_id, start_time, end_time) VALUES (?, ?, ?, ?)');
    for (const slot of normalized) {
      await insertStmt.run(uuid(), recruiterId, slot.start, slot.end);
    }
  });

  await regenerateOpsForRecruiter(recruiterId);

  res.json({ ok: true, count: normalized.length });
}));

// Remove a free-time slot
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT * FROM availability WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  if (row.recruiter_id !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: 'Немає доступу' });

  await db.prepare('DELETE FROM availability WHERE id = ?').run(req.params.id);
  await regenerateOpsForRecruiter(row.recruiter_id);
  res.json({ ok: true });
}));

module.exports = router;
