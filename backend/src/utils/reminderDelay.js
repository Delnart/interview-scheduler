// How long the Telegram reminder loop should sleep before its next check.
//
// Polling the DB every minute kept the serverless Postgres (Neon) compute endpoint
// awake 24/7 and burned the whole compute quota. Instead we sleep until the soonest
// reminder is actually due, so the DB can scale to zero between interviews.
const REMINDER_MAX_SLEEP = 6 * 60 * 60 * 1000; // safety re-check cap when idle
const REMINDER_MIN_SLEEP = 20 * 1000; // keep polling tightly inside the 5-min window

// dueAtMs = when the soonest booked slot's reminder is due (start_time - 5min), or
// null when nothing is booked. Returns the setTimeout delay in ms.
function computeReminderDelay(dueAtMs, nowMs, max = REMINDER_MAX_SLEEP, min = REMINDER_MIN_SLEEP) {
  if (dueAtMs == null) return max;
  return Math.min(Math.max(dueAtMs - nowMs, min), max);
}

module.exports = { computeReminderDelay, REMINDER_MAX_SLEEP, REMINDER_MIN_SLEEP };

if (require.main === module) {
  const assert = require('assert');
  const now = 1_000_000;
  assert.strictEqual(computeReminderDelay(null, now), REMINDER_MAX_SLEEP); // idle → cap
  assert.strictEqual(computeReminderDelay(now + 10 * 3600 * 1000, now), REMINDER_MAX_SLEEP); // far → cap
  assert.strictEqual(computeReminderDelay(now + 15 * 60 * 1000, now), 15 * 60 * 1000); // soon → exact
  assert.strictEqual(computeReminderDelay(now - 60 * 1000, now), REMINDER_MIN_SLEEP); // due/past → floor
  console.log('reminderDelay checks passed');
}
