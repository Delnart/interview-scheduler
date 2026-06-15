require('dotenv').config();

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

function bootstrapIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM recruiters').get().c;
  if (count === 0) {
    console.log('База даних порожня — запускаю seed...');
    require('./db/seed');
  }
}

async function start() {
  bootstrapIfEmpty();
  // Build the initial set of matched slots on boot.
  try {
    await slotMatcher.regenerateAll();
  } catch (err) {
    console.error('Помилка під час генерації слотів при старті:', err.message);
  }

  // Periodically refresh matched slots so newly-elapsed time windows roll forward
  // and Google Calendar busy-time changes get picked up.
  setInterval(() => {
    slotMatcher.regenerateAll().catch((err) => console.error('Помилка регенерації слотів:', err.message));
  }, 15 * 60 * 1000);

  app.listen(PORT, () => {
    console.log(`API запущено на порті ${PORT}`);
  });
}

start();
