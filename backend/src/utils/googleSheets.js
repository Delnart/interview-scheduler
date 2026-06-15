const { google } = require('googleapis');

// Reads the Google Form responses sheet (read-only, via a service account) so the
// admin calendar can show each candidate's ПІБ, group and answers, matched by
// email/Telegram. Disabled if not configured. Setup: see README and .env.example.

const CACHE_TTL_MS = 60 * 1000;
let cache = { at: 0, lookup: null };

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_SHEETS_ID &&
      (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE)
  );
}

function getAuth() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    } catch {
      console.error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
      return null;
    }
    return new google.auth.GoogleAuth({ credentials, scopes });
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) {
    return new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, scopes });
  }
  return null;
}

// Synonyms used to auto-detect a column from its header. An env override is added
// to the front so an explicit header name always wins.
function synonyms(envKey, defaults) {
  const override = process.env[envKey];
  return (override ? [override, ...defaults] : defaults).map((s) => s.toLowerCase());
}

const COLUMN_SYNONYMS = {
  email: () => synonyms('GOOGLE_SHEETS_EMAIL_COLUMN', ['email', 'e-mail', 'пошт', 'електронна']),
  telegram: () => synonyms('GOOGLE_SHEETS_TELEGRAM_COLUMN', ['telegram', 'телеграм', 'тег']),
  fullName: () => synonyms('GOOGLE_SHEETS_NAME_COLUMN', ['піб', 'прізвище', "ім'я", 'імя', 'full name']),
  group: () => synonyms('GOOGLE_SHEETS_GROUP_COLUMN', ['груп', 'шифр', 'group']),
};
const TIMESTAMP_SYNONYMS = ['timestamp', 'відмітка часу', 'позначка часу'];

function headerMatches(header, synonymList) {
  const h = String(header || '').toLowerCase().trim();
  return h.length > 0 && synonymList.some((s) => h.includes(s));
}

function normTelegram(v) {
  return String(v || '').trim().toLowerCase().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '');
}
function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function parseRows(values) {
  if (!Array.isArray(values) || values.length < 2) return [];
  const headers = values[0];
  const idx = {};
  for (const [field, getSyn] of Object.entries(COLUMN_SYNONYMS)) {
    idx[field] = headers.findIndex((h) => headerMatches(h, getSyn()));
  }
  // Any column that isn't an identity/timestamp column is treated as a Q&A pair.
  const identityCols = new Set(Object.values(idx).filter((i) => i >= 0));
  const answerCols = headers
    .map((h, i) => ({ question: String(h || '').trim(), i }))
    .filter((c) => c.question && !identityCols.has(c.i) && !headerMatches(c.question, TIMESTAMP_SYNONYMS));

  return values.slice(1).map((row) => ({
    email: idx.email >= 0 ? String(row[idx.email] || '').trim() : '',
    telegram: idx.telegram >= 0 ? String(row[idx.telegram] || '').trim() : '',
    fullName: idx.fullName >= 0 ? String(row[idx.fullName] || '').trim() : '',
    group: idx.group >= 0 ? String(row[idx.group] || '').trim() : '',
    answers: answerCols
      .map((c) => ({ question: c.question, answer: String(row[c.i] || '').trim() }))
      .filter((a) => a.answer),
  }));
}

// Returns a lookup { byTelegram: Map, byEmail: Map } (cached), or null if disabled.
async function getLookup() {
  if (!isConfigured()) return null;
  if (cache.lookup && Date.now() - cache.at < CACHE_TTL_MS) return cache.lookup;

  const auth = getAuth();
  if (!auth) return null;
  try {
    const sheets = google.sheets({ version: 'v4', auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: process.env.GOOGLE_SHEETS_RANGE || 'A:ZZ',
    });
    const rows = parseRows(resp.data.values || []);
    const byTelegram = new Map();
    const byEmail = new Map();
    for (const r of rows) {
      if (r.telegram) byTelegram.set(normTelegram(r.telegram), r);
      if (r.email) byEmail.set(normEmail(r.email), r);
    }
    cache = { at: Date.now(), lookup: { byTelegram, byEmail } };
    return cache.lookup;
  } catch (err) {
    console.error('Google Sheets read failed:', err.message);
    return null;
  }
}

// Finds a form response for a candidate by Telegram (preferred) or email.
function matchCandidate(lookup, { email, telegram }) {
  if (!lookup) return null;
  const tg = normTelegram(telegram);
  if (tg && lookup.byTelegram.has(tg)) return lookup.byTelegram.get(tg);
  const em = normEmail(email);
  if (em && lookup.byEmail.has(em)) return lookup.byEmail.get(em);
  return null;
}

module.exports = { isConfigured, getLookup, matchCandidate, parseRows };
