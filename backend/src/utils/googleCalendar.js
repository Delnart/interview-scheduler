const { google } = require('googleapis');
const db = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

// Retries a Google API call a few times with linear backoff. Transient transport
// failures ("Premature close" / socket resets) to Google's endpoints are common on
// some hosts, and a quick retry usually succeeds. Throws the last error if all fail.
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

function isConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getOAuthClient() {
  if (!isConfigured()) return null;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(state) {
  const client = getOAuthClient();
  if (!client) throw new Error('Google OAuth не налаштовано (заповніть GOOGLE_CLIENT_ID/SECRET у .env)');
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

async function exchangeCodeForTokens(code) {
  const client = getOAuthClient();
  if (!client) throw new Error('Google OAuth не налаштовано');
  const { tokens } = await withRetry(() => client.getToken(code));
  return tokens;
}

async function saveTokens(recruiterId, tokens) {
  // Merge with any existing tokens so refresh_token is preserved
  // (Google only returns refresh_token on the first consent).
  const row = await db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
  let existing = {};
  if (row && row.google_tokens) {
    try {
      existing = JSON.parse(row.google_tokens);
    } catch {
      existing = {};
    }
  }
  const merged = { ...existing, ...tokens };
  if (!merged.refresh_token && existing.refresh_token) merged.refresh_token = existing.refresh_token;
  await db.prepare('UPDATE recruiters SET google_tokens = ? WHERE id = ?').run(JSON.stringify(merged), recruiterId);
  return merged;
}

async function clearTokens(recruiterId) {
  await db.prepare('UPDATE recruiters SET google_tokens = NULL WHERE id = ?').run(recruiterId);
}

async function getRecruiterClient(recruiterId) {
  const row = await db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
  if (!row || !row.google_tokens) return null;
  const client = getOAuthClient();
  if (!client) return null;
  let tokens;
  try {
    tokens = JSON.parse(row.google_tokens);
  } catch {
    return null;
  }
  if (!tokens || !tokens.access_token) return null;
  client.setCredentials(tokens);
  client.on('tokens', (newTokens) => {
    saveTokens(recruiterId, newTokens).catch((err) => console.error('saveTokens failed:', err.message));
  });
  return client;
}

async function isConnected(recruiterId) {
  const row = await db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
  return Boolean(row && row.google_tokens);
}

// Returns busy intervals [{start: Date, end: Date}] from the recruiter's primary
// Google calendar between timeMin and timeMax. Returns [] if not connected or on error.
async function getBusyIntervals(recruiterId, timeMin, timeMax) {
  const client = await getRecruiterClient(recruiterId);
  if (!client) return [];
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const resp = await withRetry(() =>
      calendar.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: [{ id: 'primary' }],
        },
      })
    );
    const busy = resp.data?.calendars?.primary?.busy || [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.error(`Google freebusy failed for recruiter ${recruiterId}:`, err.message);
    return [];
  }
}

// Composes the standard interview event (summary/description/times) from a slot's
// booking data. Shared by the booking flow and admin recruiter replacement.
function buildInterviewEvent({ groupLabel, fullName, email, telegramTag, groupName, start, end }) {
  const summary = `Співбесіда (відбір кураторів) — група ${groupLabel}${fullName ? ` — ${fullName}` : ''}`;
  const description = [
    `Група: ${groupLabel}`,
    fullName ? `Кандидат: ${fullName}` : null,
    `Email: ${email}`,
    `Telegram: ${telegramTag}`,
    groupName ? `Навчальна група: ${groupName}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return { summary, description, start, end };
}

// Creates a calendar event on the recruiter's primary calendar. Returns the event id, or null.
async function createEvent(recruiterId, { summary, description, start, end, attendees = [] }) {
  const client = await getRecruiterClient(recruiterId);
  if (!client) return null;
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const resp = await withRetry(() =>
      calendar.events.insert({
        calendarId: 'primary',
        requestBody: {
          summary,
          description,
          start: { dateTime: start.toISOString() },
          end: { dateTime: end.toISOString() },
          attendees,
        },
      })
    );
    return resp.data.id;
  } catch (err) {
    console.error(`Google event creation failed for recruiter ${recruiterId}:`, err.message);
    return null;
  }
}

async function deleteEvent(recruiterId, eventId) {
  if (!eventId) return;
  const client = await getRecruiterClient(recruiterId);
  if (!client) return;
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    await withRetry(() => calendar.events.delete({ calendarId: 'primary', eventId }));
  } catch (err) {
    console.error(`Google event deletion failed for recruiter ${recruiterId}:`, err.message);
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  saveTokens,
  clearTokens,
  isConnected,
  getBusyIntervals,
  buildInterviewEvent,
  createEvent,
  deleteEvent,
};
