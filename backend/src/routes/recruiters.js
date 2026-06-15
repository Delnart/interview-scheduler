const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { z } = require('zod');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const slotMatcher = require('../utils/slotMatcher');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

function toPublicRecruiter(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    telegram: row.telegram,
    isAdmin: Boolean(row.is_admin),
    homeOp: row.home_op,
    active: Boolean(row.active),
    googleConnected: Boolean(row.google_tokens),
    createdAt: row.created_at,
  };
}

// List all recruiters (admin only)
router.get('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.prepare('SELECT * FROM recruiters ORDER BY full_name').all();
  res.json({ recruiters: rows.map(toPublicRecruiter) });
}));

router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.id !== req.params.id && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Немає доступу' });
  }
  const row = await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  res.json({ recruiter: toPublicRecruiter(row) });
}));

const createSchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  telegram: z.string().optional().default(''),
  password: z.string().min(8, 'Пароль має містити щонайменше 8 символів'),
  isAdmin: z.boolean().optional().default(false),
  homeOp: z.string().nullable().optional(),
});

// Create recruiter (admin only)
router.post('/', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const { fullName, email, telegram, password, isAdmin, homeOp } = parsed.data;

  const existing = await db.prepare('SELECT id FROM recruiters WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'Користувач з таким email вже існує' });

  const id = uuid();
  await db.prepare(
    `INSERT INTO recruiters (id, full_name, email, telegram, password_hash, is_admin, home_op, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(id, fullName, email.toLowerCase().trim(), telegram, bcrypt.hashSync(password, 10), isAdmin ? 1 : 0, homeOp || null);

  const row = await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(id);
  res.status(201).json({ recruiter: toPublicRecruiter(row) });
}));

const updateSchema = z.object({
  fullName: z.string().min(1).optional(),
  telegram: z.string().optional(),
  email: z.string().email().optional(),
  isAdmin: z.boolean().optional(),
  homeOp: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

// Update recruiter (admin can change anything; self can change own name/telegram/email)
router.put('/:id', requireAuth, asyncHandler(async (req, res) => {
  const isSelf = req.user.id === req.params.id;
  if (!isSelf && !req.user.isAdmin) return res.status(403).json({ error: 'Немає доступу' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  const data = parsed.data;

  if (!req.user.isAdmin) {
    // non-admins cannot change admin flag, home OP or active status
    delete data.isAdmin;
    delete data.homeOp;
    delete data.active;
  }

  const row = await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });

  const next = {
    full_name: data.fullName ?? row.full_name,
    telegram: data.telegram ?? row.telegram,
    email: (data.email ?? row.email).toLowerCase().trim(),
    is_admin: data.isAdmin === undefined ? row.is_admin : data.isAdmin ? 1 : 0,
    home_op: data.homeOp === undefined ? row.home_op : data.homeOp,
    active: data.active === undefined ? row.active : data.active ? 1 : 0,
  };

  if (next.email !== row.email) {
    const existing = await db.prepare('SELECT id FROM recruiters WHERE email = ? AND id != ?').get(next.email, row.id);
    if (existing) return res.status(409).json({ error: 'Користувач з таким email вже існує' });
  }

  await db.prepare(
    `UPDATE recruiters SET full_name = ?, telegram = ?, email = ?, is_admin = ?, home_op = ?, active = ? WHERE id = ?`
  ).run(next.full_name, next.telegram, next.email, next.is_admin, next.home_op, next.active, row.id);

  const updated = await db.prepare('SELECT * FROM recruiters WHERE id = ?').get(row.id);
  res.json({ recruiter: toPublicRecruiter(updated) });
}));

// Reset a recruiter's password (admin only)
router.post('/:id/reset-password', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const schema = z.object({ newPassword: z.string().min(8, 'Пароль має містити щонайменше 8 символів') });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });

  const row = await db.prepare('SELECT id FROM recruiters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });

  await db.prepare('UPDATE recruiters SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(parsed.data.newPassword, 10), row.id);
  res.json({ ok: true });
}));

// Deactivate (soft-delete) a recruiter (admin only). Keeps history intact.
router.delete('/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const row = await db.prepare('SELECT id FROM recruiters WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  if (row.id === req.user.id) return res.status(400).json({ error: 'Не можна деактивувати власний акаунт' });

  await db.prepare('UPDATE recruiters SET active = 0 WHERE id = ?').run(row.id);

  // Regenerate matched slots for any OP this recruiter is part of, since their
  // availability should no longer be considered.
  const ops = await db.prepare('SELECT DISTINCT op_code FROM op_recruiters WHERE recruiter_id = ?').all(row.id);
  for (const op of ops) await slotMatcher.generateMatchedSlotsForOp(op.op_code);

  res.json({ ok: true });
}));

module.exports = router;
