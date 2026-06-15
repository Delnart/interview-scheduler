// Seed script: creates the 7 OP codes, an admin account, and a starting set of
// recruiters + team assignments based on the initial team configuration.
// Everything seeded here is fully editable later from the admin panel
// (Recruiters page and Team config page) — this is just a sensible starting point.
require('dotenv').config();
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('./index');

const OPS = [
  { code: 'IA', name: 'ІА' },
  { code: 'IM', name: 'ІМ' },
  { code: 'IP', name: 'ІП' },
  { code: 'IS', name: 'ІС' },
  { code: 'IO', name: 'ІО' },
  { code: 'IK', name: 'ІК' },
  { code: 'II', name: 'ІІ' },
];

// name -> { email, telegram }
const RECRUITERS = {
  'Дарина': { email: 'darina@example.com', telegram: '@darina' },
  'Ілюша': { email: 'ilyusha@example.com', telegram: '@ilyusha' },
  'Коваль': { email: 'koval@example.com', telegram: '@koval' },
  'Артем': { email: 'artem@example.com', telegram: '@artem' },
  'Вовк': { email: 'vovk@example.com', telegram: '@vovk' },
  'Юля': { email: 'yulia@example.com', telegram: '@yulia' },
  'Маріна': { email: 'marina@example.com', telegram: '@marina' },
  'Макс': { email: 'max@example.com', telegram: '@max' },
  'Соня Крицька': { email: 'sonia@example.com', telegram: '@sonia_krytska' },
  'Діана': { email: 'diana@example.com', telegram: '@diana' },
  'Віка': { email: 'vika@example.com', telegram: '@vika' },
  'Юра': { email: 'yura@example.com', telegram: '@yura' },
};

// op_code -> { main: [names], secondary: [names] }
// "main" = recruiter belonging to the candidate's own OP, "secondary" = recruiter from a different OP.
// Reflects the initial mapping provided; adjust freely later in the admin panel.
const TEAMS = {
  IK: { main: ['Дарина'], secondary: ['Ілюша'] },
  IO: { main: ['Коваль'], secondary: ['Артем', 'Вовк'] },
  IS: { main: ['Дарина'], secondary: ['Юля', 'Маріна', 'Макс'] },
  IM: { main: ['Артем'], secondary: ['Юля', 'Маріна', 'Макс', 'Соня Крицька'] },
  IA: { main: ['Дарина'], secondary: ['Юля', 'Маріна', 'Макс'] },
  IP: { main: ['Діана', 'Віка'], secondary: ['Юра'] },
  II: { main: ['Діана'], secondary: ['Юля', 'Маріна', 'Макс'] },
};

const DEFAULT_RECRUITER_PASSWORD = process.env.DEFAULT_RECRUITER_PASSWORD || 'ChangeMe123!';

function run() {
  const insertOp = db.prepare('INSERT OR IGNORE INTO op_codes (code, name) VALUES (?, ?)');
  for (const op of OPS) insertOp.run(op.code, op.name);

  // Admin account
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const existingAdmin = db.prepare('SELECT id FROM recruiters WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    db.prepare(
      `INSERT INTO recruiters (id, full_name, email, telegram, password_hash, is_admin, home_op, active)
       VALUES (?, ?, ?, ?, ?, 1, NULL, 1)`
    ).run(uuid(), 'Адміністратор', adminEmail, '', bcrypt.hashSync(adminPassword, 10));
    console.log(`Created admin account: ${adminEmail} / ${adminPassword}`);
  } else {
    console.log(`Admin account already exists: ${adminEmail}`);
  }

  // Recruiters
  const nameToId = {};
  const getRecruiterByEmail = db.prepare('SELECT id FROM recruiters WHERE email = ?');
  const insertRecruiter = db.prepare(
    `INSERT INTO recruiters (id, full_name, email, telegram, password_hash, is_admin, home_op, active)
     VALUES (?, ?, ?, ?, ?, 0, NULL, 1)`
  );
  const passwordHash = bcrypt.hashSync(DEFAULT_RECRUITER_PASSWORD, 10);
  for (const [name, info] of Object.entries(RECRUITERS)) {
    let row = getRecruiterByEmail.get(info.email);
    if (!row) {
      const id = uuid();
      insertRecruiter.run(id, name, info.email, info.telegram, passwordHash);
      nameToId[name] = id;
    } else {
      nameToId[name] = row.id;
    }
  }
  console.log(`Recruiter accounts created with default password: ${DEFAULT_RECRUITER_PASSWORD}`);

  // Team (op_recruiters) assignments
  const insertAssignment = db.prepare(
    `INSERT OR IGNORE INTO op_recruiters (id, op_code, recruiter_id, role) VALUES (?, ?, ?, ?)`
  );
  for (const [opCode, roles] of Object.entries(TEAMS)) {
    for (const name of roles.main || []) {
      insertAssignment.run(uuid(), opCode, nameToId[name], 'main');
    }
    for (const name of roles.secondary || []) {
      insertAssignment.run(uuid(), opCode, nameToId[name], 'secondary');
    }
  }

  // Default settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  insertSetting.run('slot_duration_minutes', String(process.env.DEFAULT_SLOT_DURATION_MINUTES || '45'));

  console.log('Seed complete.');
}

run();
