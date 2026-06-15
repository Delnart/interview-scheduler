// Seed script: creates the 7 OP codes, an admin account, and a starting set of
// recruiters + team assignments. Everything is editable later in the admin panel.
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

async function run() {
  await db.init();

  const insertOp = db.prepare('INSERT INTO op_codes (code, name) VALUES (?, ?) ON CONFLICT (code) DO NOTHING');
  for (const op of OPS) await insertOp.run(op.code, op.name);

  // Admin account
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const existingAdmin = await db.prepare('SELECT id FROM recruiters WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    await db
      .prepare(
        `INSERT INTO recruiters (id, full_name, email, telegram, password_hash, is_admin, home_op, active)
         VALUES (?, ?, ?, ?, ?, 1, NULL, 1)`
      )
      .run(uuid(), 'Адміністратор', adminEmail, '', bcrypt.hashSync(adminPassword, 10));
    console.log(`Created admin account: ${adminEmail}`);
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
    const row = await getRecruiterByEmail.get(info.email);
    if (!row) {
      const id = uuid();
      await insertRecruiter.run(id, name, info.email, info.telegram, passwordHash);
      nameToId[name] = id;
    } else {
      nameToId[name] = row.id;
    }
  }
  console.log('Recruiter accounts ready with the default password.');

  // Team (op_recruiters) assignments
  const insertAssignment = db.prepare(
    `INSERT INTO op_recruiters (id, op_code, recruiter_id, role) VALUES (?, ?, ?, ?)
     ON CONFLICT (op_code, recruiter_id, role) DO NOTHING`
  );
  for (const [opCode, roles] of Object.entries(TEAMS)) {
    for (const name of roles.main || []) await insertAssignment.run(uuid(), opCode, nameToId[name], 'main');
    for (const name of roles.secondary || []) await insertAssignment.run(uuid(), opCode, nameToId[name], 'secondary');
  }

  // Default settings
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING')
    .run('slot_duration_minutes', String(process.env.DEFAULT_SLOT_DURATION_MINUTES || '45'));

  console.log('Seed complete.');
}

module.exports = run;

// Allow running directly: `npm run seed`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
