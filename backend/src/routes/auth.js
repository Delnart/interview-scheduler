const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Занадто багато спроб входу. Спробуйте пізніше." },
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function toPublicUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    telegram: row.telegram,
    isAdmin: Boolean(row.is_admin),
    homeOp: row.home_op,
    active: Boolean(row.active),
    googleConnected: Boolean(row.google_tokens),
  };
}

router.post('/login', loginLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Невірні дані для входу' });
  const { email, password } = parsed.data;

  const row = db.prepare('SELECT * FROM recruiters WHERE email = ?').get(email.toLowerCase().trim());
  if (!row || !row.active) {
    return res.status(401).json({ error: 'Невірний email або пароль' });
  }
  const ok = bcrypt.compareSync(password, row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Невірний email або пароль' });

  const token = jwt.sign(
    { id: row.id, email: row.email, isAdmin: Boolean(row.is_admin) },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
  res.json({ token, user: toPublicUser(row) });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  res.json({ user: toPublicUser(row) });
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Пароль має містити щонайменше 8 символів'),
});

router.post('/change-password', requireAuth, (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Невірні дані' });
  }
  const { currentPassword, newPassword } = parsed.data;
  const row = db.prepare('SELECT * FROM recruiters WHERE id = ?').get(req.user.id);
  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    return res.status(401).json({ error: 'Поточний пароль невірний' });
  }
  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE recruiters SET password_hash = ? WHERE id = ?').run(newHash, row.id);
  res.json({ ok: true });
});

module.exports = router;
