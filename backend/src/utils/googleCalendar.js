const { google } = require('googleapis');
const db = require('../db');

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

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
  const { tokens } = await client.getToken(code);
  return tokens;
}

function saveTokens(recruiterId, tokens) {
  // Merge with any existing tokens so refresh_token is preserved
  // (Google only returns refresh_token on the first consent).
  const row = db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
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
  db.prepare('UPDATE recruiters SET google_tokens = ? WHERE id = ?').run(JSON.stringify(merged), recruiterId);
  return merged;
}

function clearTokens(recruiterId) {
  db.prepare('UPDATE recruiters SET google_tokens = NULL WHERE id = ?').run(recruiterId);
}

function getRecruiterClient(recruiterId) {
  const row = db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
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
    saveTokens(recruiterId, newTokens);
  });
  return client;
}

function isConnected(recruiterId) {
  const row = db.prepare('SELECT google_tokens FROM recruiters WHERE id = ?').get(recruiterId);
  return Boolean(row && row.google_tokens);
}

// Returns busy intervals [{start: Date, end: Date}] from the recruiter's primary
// Google calendar between timeMin and timeMax. Returns [] if not connected or on error.
async function getBusyIntervals(recruiterId, timeMin, timeMax) {
  const client = getRecruiterClient(recruiterId);
  if (!client) return [];
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const resp = await calendar.freebusy.query({
      requestBody: {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: 'primary' }],
      },
    });
    const busy = resp.data?.calendars?.primary?.busy || [];
    return busy.map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.error(`Google freebusy failed for recruiter ${recruiterId}:`, err.message);
    return [];
  }
}

// Creates a calendar event on the recruiter's primary calendar. Returns the event id, or null.
async function createEvent(recruiterId, { summary, description, start, end, attendees = [] }) {
  const client = getRecruiterClient(recruiterId);
  if (!client) return null;
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    const resp = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary,
        description,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees,
      },
    });
    return resp.data.id;
  } catch (err) {
    console.error(`Google event creation failed for recruiter ${recruiterId}:`, err.message);
    return null;
  }
}

async function deleteEvent(recruiterId, eventId) {
  if (!eventId) return;
  const client = getRecruiterClient(recruiterId);
  if (!client) return;
  try {
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId: 'primary', eventId });
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
  createEvent,
  deleteEvent,
};
