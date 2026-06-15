const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const slotMatcher = require('../utils/slotMatcher');
const asyncHandler = require('../utils/asyncHandler');

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
