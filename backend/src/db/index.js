const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_availability_recruiter ON availability(recruiter_id);
CREATE INDEX IF NOT EXISTS idx_matched_slots_op ON matched_slots(op_code, status);
CREATE INDEX IF NOT EXISTS idx_matched_slots_main ON matched_slots(main_recruiter_id, status);
CREATE INDEX IF NOT EXISTS idx_matched_slots_secondary ON matched_slots(secondary_recruiter_id, status);
`);

// One-time migration: bring old DBs that stored a 60-minute slot duration in line
// with the current 45-minute grid (otherwise no 45-min overlaps ever match).
const slotDurationSetting = db.prepare('SELECT value FROM settings WHERE key = ?').get('slot_duration_minutes');
if (slotDurationSetting && slotDurationSetting.value === '60') {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('45', 'slot_duration_minutes');
}

module.exports = db;
