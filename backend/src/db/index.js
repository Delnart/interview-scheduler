const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Помилка: змінна середовища DATABASE_URL не задана (рядок підключення до PostgreSQL).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Managed Postgres (Neon / Supabase / Render) requires SSL — set DATABASE_SSL=true.
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

// The app was written against node:sqlite's synchronous prepare().get/all/run API.
// This wrapper keeps the same shape but async, and rewrites `?` placeholders to
// Postgres `$1, $2, ...`.
function toPg(sql) {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

function statement(runner, sql) {
  const text = toPg(sql);
  return {
    async get(...params) {
      const r = await runner(text, params);
      return r.rows[0];
    },
    async all(...params) {
      const r = await runner(text, params);
      return r.rows;
    },
    async run(...params) {
      const r = await runner(text, params);
      return { changes: r.rowCount };
    },
  };
}

const db = {
  prepare: (sql) => statement((text, params) => pool.query(text, params), sql),
  exec: (sql) => pool.query(sql),
  // Runs fn inside a single transaction on one pooled client. fn receives a db-like
  // object whose prepare()/exec() are bound to that client.
  async transaction(fn) {
    const client = await pool.connect();
    const txDb = {
      prepare: (sql) => statement((text, params) => client.query(text, params), sql),
      exec: (sql) => client.query(sql),
    };
    try {
      await client.query('BEGIN');
      const result = await fn(txDb);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },
};

// Creates the schema (idempotent) and runs lightweight migrations. Call once on boot.
async function init() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS recruiters (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  telegram TEXT,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  home_op TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  google_tokens TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS op_codes (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS op_recruiters (
  id TEXT PRIMARY KEY,
  op_code TEXT NOT NULL REFERENCES op_codes(code) ON DELETE CASCADE,
  recruiter_id TEXT NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('main','secondary')),
  UNIQUE(op_code, recruiter_id, role)
);

CREATE TABLE IF NOT EXISTS availability (
  id TEXT PRIMARY KEY,
  recruiter_id TEXT NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS matched_slots (
  id TEXT PRIMARY KEY,
  op_code TEXT NOT NULL REFERENCES op_codes(code) ON DELETE CASCADE,
  main_recruiter_id TEXT NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  secondary_recruiter_id TEXT NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','booked','cancelled')),
  google_event_id_main TEXT,
  google_event_id_secondary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(op_code, main_recruiter_id, secondary_recruiter_id, start_time)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  matched_slot_id TEXT NOT NULL REFERENCES matched_slots(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  telegram_tag TEXT NOT NULL,
  group_name TEXT NOT NULL,
  op_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_availability_recruiter ON availability(recruiter_id);
CREATE INDEX IF NOT EXISTS idx_matched_slots_op ON matched_slots(op_code, status);
CREATE INDEX IF NOT EXISTS idx_matched_slots_main ON matched_slots(main_recruiter_id, status);
CREATE INDEX IF NOT EXISTS idx_matched_slots_secondary ON matched_slots(secondary_recruiter_id, status);

-- Telegram integration: each OP maps to a forum topic (thread) in the recruiters'
-- supergroup; recruiters get pinged there on every new booking. Nullable — OPs
-- without a thread id simply don't get notified.
ALTER TABLE op_codes ADD COLUMN IF NOT EXISTS telegram_thread_id TEXT;
-- Guards the "5 minutes before" Telegram reminder so it fires at most once per slot.
ALTER TABLE matched_slots ADD COLUMN IF NOT EXISTS reminder_sent INTEGER NOT NULL DEFAULT 0;
`);

  // One-time migration: bring old DBs that stored a 60-minute slot duration in line
  // with the current 45-minute grid (otherwise no 45-min overlaps ever match).
  await pool.query(
    `UPDATE settings SET value = '45' WHERE key = 'slot_duration_minutes' AND value = '60'`
  );
}

db.init = init;

module.exports = db;
