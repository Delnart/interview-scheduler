const express = require('express');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const slotMatcher = require('../utils/slotMatcher');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

// List all OPs (public - used by the booking page to populate the OP selector)
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT code, name FROM op_codes ORDER BY name').all();
  res.json({ ops: rows });
});

const opSchema = z.object({
  code: z.string().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'Код може містити лише латинські букви, цифри, "-" та "_"'),
  name: z.string().min(1),
});

// Create a new OP (admin only)
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const parsed = opSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const { code, name } = parsed.data;

  const existing = db.prepare('SELECT code FROM op_codes WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'ОП з таким кодом вже існує' });

  db.prepare('INSERT INTO op_codes (code, name) VALUES (?, ?)').run(code, name);
  res.status(201).json({ op: { code, name } });
});

// Rename an OP (admin only)
router.put('/:code', requireAuth, requireAdmin, (req, res) => {
  const schema = z.object({ name: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Невірні дані' });

  const existing = db.prepare('SELECT code FROM op_codes WHERE code = ?').get(req.params.code);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });

  db.prepare('UPDATE op_codes SET name = ? WHERE code = ?').run(parsed.data.name, req.params.code);
  res.json({ op: { code: req.params.code, name: parsed.data.name } });
});

// Delete an OP and all its team assignments / matched slots (admin only)
router.delete('/:code', requireAuth, requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT code FROM op_codes WHERE code = ?').get(req.params.code);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM op_codes WHERE code = ?').run(req.params.code);
  res.json({ ok: true });
});

// Get the recruiter team configuration for an OP: who can be "main" (recruiter
// from the candidate's own OP) and who can be "secondary" (from another OP).
router.get('/:code/team', requireAuth, requireAdmin, (req, res) => {
  const op = db.prepare('SELECT code FROM op_codes WHERE code = ?').get(req.params.code);
  if (!op) return res.status(404).json({ error: 'Не знайдено' });

  const rows = db
    .prepare(
      `SELECT op_recruiters.recruiter_id as id, op_recruiters.role as role,
              recruiters.full_name as fullName, recruiters.email as email, recruiters.active as active
       FROM op_recruiters
       JOIN recruiters ON recruiters.id = op_recruiters.recruiter_id
       WHERE op_recruiters.op_code = ?
       ORDER BY recruiters.full_name`
    )
    .all(req.params.code);

  res.json({
    main: rows.filter((r) => r.role === 'main').map((r) => ({ id: r.id, fullName: r.fullName, email: r.email, active: Boolean(r.active) })),
    secondary: rows.filter((r) => r.role === 'secondary').map((r) => ({ id: r.id, fullName: r.fullName, email: r.email, active: Boolean(r.active) })),
  });
});

const teamSchema = z.object({
  main: z.array(z.string()).default([]),
  secondary: z.array(z.string()).default([]),
});

// Replace the team configuration for an OP (admin only). Recomputes matched slots afterwards.
router.put('/:code/team', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const op = db.prepare('SELECT code FROM op_codes WHERE code = ?').get(req.params.code);
  if (!op) return res.status(404).json({ error: 'Не знайдено' });

  const parsed = teamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Невірні дані' });
  const { main, secondary } = parsed.data;

  const allIds = [...new Set([...main, ...secondary])];
  if (allIds.length) {
    const placeholders = allIds.map(() => '?').join(',');
    const found = db.prepare(`SELECT id FROM recruiters WHERE id IN (${placeholders})`).all(...allIds);
    if (found.length !== allIds.length) return res.status(400).json({ error: 'Один або декілька рекрутерів не знайдено' });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM op_recruiters WHERE op_code = ?').run(req.params.code);
    const insert = db.prepare('INSERT INTO op_recruiters (id, op_code, recruiter_id, role) VALUES (?, ?, ?, ?)');
    const { v4: uuid } = require('uuid');
    for (const id of main) insert.run(uuid(), req.params.code, id, 'main');
    for (const id of secondary) insert.run(uuid(), req.params.code, id, 'secondary');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Team membership feeds the global partner pool used by every OP's matching
  // (see slotMatcher.getGlobalTeamMembers), so a change here can affect matched
  // slots for all OPs, not just this one.
  await slotMatcher.regenerateAll();
  res.json({ ok: true });
}));

module.exports = router;
