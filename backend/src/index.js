require('dotenv').config();

// Some hosts (notably Render's free tier) have flaky IPv6 egress, which surfaces as
// "Premature close" when calling Google's OAuth/token endpoints (oauth2.googleapis.com).
// Prefer IPv4 for all outbound DNS so these HTTPS calls take the working route. Done in
// code so it doesn't depend on a NODE_OPTIONS env var being set on the host.
require('dns').setDefaultResultOrder('ipv4first');

const required = ['JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Помилка: змінна середовища ${key} не задана. Скопіюйте .env.example у .env та заповніть значення.`);
    process.exit(1);
  }
}
if (process.env.JWT_SECRET === 'change_this_to_a_long_random_string') {
  console.error('Помилка: змініть JWT_SECRET у .env на унікальний випадковий рядок перед запуском.');
  process.exit(1);
}

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const db = require('./db');
const slotMatcher = require('./utils/slotMatcher');
const telegram = require('./utils/telegram');

const authRoutes = require('./routes/auth');
const recruiterRoutes = require('./routes/recruiters');
const opRoutes = require('./routes/ops');
const availabilityRoutes = require('./routes/availability');
const slotRoutes = require('./routes/slots');
const calendarRoutes = require('./routes/calendar');
const publicRoutes = require('./routes/public');

const app = express();
app.set('trust proxy', 1);

app.use(helmet());

const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
  })
);

app.use(express.json({ limit: '100kb' }));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/recruiters', recruiterRoutes);
app.use('/api/ops', opRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/slots', slotRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/public', publicRoutes);

// Fallback for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не знайдено' }));

// Centralized error handler — never leak stack traces to clients.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

const PORT = process.env.PORT || 4000;

async function bootstrapIfEmpty() {
  const row = await db.prepare('SELECT COUNT(*) as c FROM recruiters').get();
  if (Number(row.c) === 0) {
    console.log('База даних порожня — запускаю seed...');
    await require('./db/seed')();
  }
}

async function start() {
  await db.init();
  await bootstrapIfEmpty();
  // Build the initial set of matched slots in the background — don't hold the HTTP
  // port hostage to a full regeneration pass (matters on cold starts).
  slotMatcher.scheduleRegen();

  // Periodic housekeeping only: roll elapsed windows forward and pick up external Google
  // Calendar edits. Booking/availability/team changes already trigger their own
  // scheduleRegen, and reads filter out past slots — so this can be rare. Keeping it
  // infrequent lets the serverless Postgres compute scale to zero instead of being pinged
  // every 15 minutes around the clock (which drained the compute quota).
  setInterval(() => {
    slotMatcher.scheduleRegen();
  }, 6 * 60 * 60 * 1000);

  // Telegram "5 minutes before" reminders — adaptively scheduled (sleeps until a reminder
  // is actually due; bookings re-arm it in-process). No-op when Telegram isn't configured.
  telegram.startReminders();

  app.listen(PORT, () => {
    console.log(`API запущено на порті ${PORT}`);
  });
}

start();
