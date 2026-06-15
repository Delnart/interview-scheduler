const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const googleCalendar = require('../utils/googleCalendar');
const googleSheets = require('../utils/googleSheets');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

const SELECT_BOOKED = `
  SELECT matched_slots.*, op_codes.name as op_name,
         mr.full_name as main_name, sr.full_name as secondary_name,
         bookings.full_name as candidate_name, bookings.email as candidate_email,
         bookings.telegram_tag as candidate_telegram, bookings.group_name as candidate_group
  FROM matched_slots
  JOIN op_codes ON op_codes.code = matched_slots.op_code
  JOIN recruiters mr ON mr.id = matched_slots.main_recruiter_id
  JOIN recruiters sr ON sr.id = matched_slots.secondary_recruiter_id
  LEFT JOIN bookings ON bookings.matched_slot_id = matched_slots.id
  WHERE matched_slots.status = 'booked'
`;

function eventRow(row) {
  return {
    id: row.id,
    opCode: row.op_code,
    opName: row.op_name,
    startTime: row.start_time,
    endTime: row.end_time,
    mainRecruiter: { id: row.main_recruiter_id, fullName: row.main_name },
    secondaryRecruiter: { id: row.secondary_recruiter_id, fullName: row.secondary_name },
    // Key candidate presence off email (always collected), not full_name (now blank).
    candidate: row.candidate_email
      ? {
          fullName: row.candidate_name || '',
          email: row.candidate_email,
          telegram: row.candidate_telegram,
          group: row.candidate_group || '',
        }
      : null,
  };
}

// Enriches each candidate with ПІБ/group/answers from the Google Sheet (matched by
// email/Telegram), falling back to the booking data if disabled or not found.
async function toEvents(rows) {
  const lookup = await googleSheets.getLookup();
  return rows.map((row) => {
    const ev = eventRow(row);
    if (ev.candidate) {
      const match = googleSheets.matchCandidate(lookup, {
        email: ev.candidate.email,
        telegram: ev.candidate.telegram,
      });
      if (match) {
        ev.candidate = {
          ...ev.candidate,
          fullName: match.fullName || ev.candidate.fullName,
          group: match.group || ev.candidate.group,
          answers: match.answers || [],
        };
      }
    }
    return ev;
  });
}

// General calendar: every booked interview across all recruiters (admin only)
router.get('/general', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const rows = await db.prepare(`${SELECT_BOOKED} ORDER BY matched_slots.start_time`).all();
  res.json({ events: await toEvents(rows) });
}));

// Calendar for the logged-in recruiter (their own booked interviews)
router.get('/mine', requireAuth, asyncHandler(async (req, res) => {
  const rows = await db
    .prepare(`${SELECT_BOOKED} AND (matched_slots.main_recruiter_id = ? OR matched_slots.secondary_recruiter_id = ?) ORDER BY matched_slots.start_time`)
    .all(req.user.id, req.user.id);
  res.json({ events: await toEvents(rows) });
}));

// Calendar for a specific recruiter (admin only)
router.get('/recruiter/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const recruiter = await db.prepare('SELECT id, full_name FROM recruiters WHERE id = ?').get(req.params.id);
  if (!recruiter) return res.status(404).json({ error: 'Не знайдено' });
  const rows = await db
    .prepare(`${SELECT_BOOKED} AND (matched_slots.main_recruiter_id = ? OR matched_slots.secondary_recruiter_id = ?) ORDER BY matched_slots.start_time`)
    .all(req.params.id, req.params.id);
  res.json({ recruiter: { id: recruiter.id, fullName: recruiter.full_name }, events: await toEvents(rows) });
}));

// --- Google OAuth ---

router.get('/oauth/status', requireAuth, asyncHandler(async (req, res) => {
  res.json({ connected: await googleCalendar.isConnected(req.user.id), configured: googleCalendar.isConfigured() });
}));

// Returns a Google consent URL for the logged-in recruiter to connect their calendar.
router.get('/oauth/url', requireAuth, (req, res) => {
  if (!googleCalendar.isConfigured()) {
    return res.status(503).json({ error: 'Google Calendar не налаштовано на сервері (відсутні GOOGLE_CLIENT_ID/SECRET)' });
  }
  const state = jwt.sign({ id: req.user.id }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const url = googleCalendar.getAuthUrl(state);
  res.json({ url });
});

// Google redirects here after the user grants/denies access.
router.get('/oauth/callback', async (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${frontendUrl}/admin/profile?google=error`);
  }
  if (!code || !state) {
    return res.redirect(`${frontendUrl}/admin/profile?google=error`);
  }

  let payload;
  try {
    payload = jwt.verify(state, process.env.JWT_SECRET);
  } catch {
    return res.redirect(`${frontendUrl}/admin/profile?google=error`);
  }

  try {
    const tokens = await googleCalendar.exchangeCodeForTokens(code);
    await googleCalendar.saveTokens(payload.id, tokens);
    return res.redirect(`${frontendUrl}/admin/profile?google=connected`);
  } catch (err) {
    console.error('Google OAuth callback failed', err.message);
    return res.redirect(`${frontendUrl}/admin/profile?google=error`);
  }
});

// Disconnect Google Calendar
router.post('/oauth/disconnect', requireAuth, asyncHandler(async (req, res) => {
  await googleCalendar.clearTokens(req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
