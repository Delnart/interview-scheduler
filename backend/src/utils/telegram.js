// Telegram integration: when an interview is booked, ping the OP's recruiters in a
// dedicated forum topic (thread) of a shared supergroup, and remind them 5 minutes
// before it starts. Entirely optional — disabled (and harmless) when the bot token /
// chat id aren't configured.
const db = require('../db');

const API_BASE = 'https://api.telegram.org';
const TZ = process.env.TIMEZONE || 'Europe/Kyiv';

function isConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "@name" / "name" -> "@name" (escaped for HTML), or '' if unusable.
function mention(tag) {
  const handle = String(tag || '').trim().replace(/^@+/, '');
  return /^[A-Za-z0-9_]{2,64}$/.test(handle) ? `@${escapeHtml(handle)}` : '';
}

function formatDate(iso) {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
  return date;
}

function formatTimeRange(startIso, endIso) {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${fmt.format(new Date(startIso))}–${fmt.format(new Date(endIso))}`;
}

// Low-level send. Best-effort: logs and returns null on any failure, never throws.
// On success returns the sent message's id (truthy), so callers can reply to it later.
async function sendMessage({ threadId, text, replyTo }) {
  if (!isConfigured()) return null;
  const body = {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  // message_thread_id targets a specific forum topic. Without it the message lands
  // in the group's "General" thread.
  if (threadId !== null && threadId !== undefined && String(threadId).trim() !== '') {
    body.message_thread_id = Number(threadId);
  }
  if (replyTo) {
    body.reply_to_message_id = Number(replyTo);
    // Old message may have been deleted — still deliver the notification.
    body.allow_sending_without_reply = true;
  }
  try {
    const resp = await fetch(`${API_BASE}/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error(`Telegram sendMessage failed (${resp.status}): ${detail}`);
      return null;
    }
    const data = await resp.json().catch(() => null);
    return data?.result?.message_id ?? null;
  } catch (err) {
    console.error('Telegram sendMessage error:', err.message);
    return null;
  }
}

// Pulls everything needed to compose a notification for one booked slot.
async function getSlotContext(slotId) {
  return db
    .prepare(
      `SELECT ms.start_time AS start_time, ms.end_time AS end_time,
              ms.telegram_message_id AS message_id,
              oc.name AS op_name, oc.telegram_thread_id AS thread_id,
              mr.full_name AS main_name, mr.telegram AS main_tg,
              sr.full_name AS sec_name, sr.telegram AS sec_tg,
              b.telegram_tag AS candidate_tg, b.full_name AS candidate_name, b.group_name AS candidate_group
       FROM matched_slots ms
       JOIN op_codes oc ON oc.code = ms.op_code
       JOIN recruiters mr ON mr.id = ms.main_recruiter_id
       JOIN recruiters sr ON sr.id = ms.secondary_recruiter_id
       LEFT JOIN bookings b ON b.matched_slot_id = ms.id
       WHERE ms.id = ?`
    )
    .get(slotId);
}

function recruiterLine(ctx) {
  const mentions = [mention(ctx.main_tg), mention(ctx.sec_tg)].filter(Boolean).join(' ');
  const names = `${escapeHtml(ctx.main_name)} + ${escapeHtml(ctx.sec_name)}`;
  return mentions ? `${names} (${mentions})` : names;
}

function candidateLine(ctx) {
  const tg = mention(ctx.candidate_tg) || escapeHtml(ctx.candidate_tg || '—');
  const extras = [ctx.candidate_name, ctx.candidate_group].filter(Boolean).map(escapeHtml).join(', ');
  return extras ? `${tg} (${extras})` : tg;
}

function hasThread(ctx) {
  return ctx && ctx.thread_id !== null && ctx.thread_id !== undefined && String(ctx.thread_id).trim() !== '';
}

// Notify the OP's thread that a new interview has been booked.
async function notifyNewBooking(slotId) {
  if (!isConfigured()) return false;
  const ctx = await getSlotContext(slotId);
  // No thread configured for this OP -> don't post (avoids noise in the group's General).
  if (!ctx || !hasThread(ctx)) return false;
  const text =
    `🆕 <b>Нова співбесіда — ${escapeHtml(ctx.op_name)}</b>\n` +
    `🗓 ${formatDate(ctx.start_time)}\n` +
    `🕐 ${formatTimeRange(ctx.start_time, ctx.end_time)}\n` +
    `👤 Кандидат: ${candidateLine(ctx)}\n` +
    `🧑‍💼 Рекрутери: ${recruiterLine(ctx)}`;
  const messageId = await sendMessage({ threadId: ctx.thread_id, text });
  if (messageId) {
    // Remember the message so a later reschedule can reply to it.
    await db.prepare(`UPDATE matched_slots SET telegram_message_id = ? WHERE id = ?`).run(String(messageId), slotId);
  }
  return Boolean(messageId);
}

// The candidate re-applied and picked a new time: reply to the old booking's message
// in its thread so the recruiters see that this interview is no longer happening.
// Call BEFORE the old slot's booking row is deleted (context needs it).
async function notifyRescheduled(oldSlotId, newSlotId) {
  if (!isConfigured()) return false;
  const [oldCtx, newCtx] = await Promise.all([getSlotContext(oldSlotId), getSlotContext(newSlotId)]);
  if (!oldCtx || !hasThread(oldCtx)) return false;
  const text =
    `🔁 <b>Час змінено — ${escapeHtml(oldCtx.op_name)}</b>\n` +
    `👤 Кандидат ${candidateLine(oldCtx)} заповнив(-ла) заявку повторно.\n` +
    (newCtx
      ? `🗓 Новий час: ${formatDate(newCtx.start_time)}, ${formatTimeRange(newCtx.start_time, newCtx.end_time)}\n`
      : '') +
    `❌ Ця співбесіда не відбудеться, нагадування вимкнено.`;
  const sent = await sendMessage({ threadId: oldCtx.thread_id, text, replyTo: oldCtx.message_id });
  return Boolean(sent);
}

// Notify the OP's thread that an interview starts in ~5 minutes.
async function notifyReminder(slotId) {
  if (!isConfigured()) return false;
  const ctx = await getSlotContext(slotId);
  if (!ctx || !hasThread(ctx)) return false;
  const text =
    `⏰ <b>Через 5 хвилин співбесіда — ${escapeHtml(ctx.op_name)}</b>\n` +
    `🕐 ${formatTimeRange(ctx.start_time, ctx.end_time)}\n` +
    `👤 Кандидат: ${candidateLine(ctx)}\n` +
    `🧑‍💼 Рекрутери: ${recruiterLine(ctx)}`;
  return sendMessage({ threadId: ctx.thread_id, text });
}

// Sends the "5 minutes before" reminder for every booked slot starting within the
// next 5 minutes that hasn't been reminded yet. Called on a short interval.
async function sendDueReminders() {
  if (!isConfigured()) return;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const windowEndIso = new Date(now + 5 * 60 * 1000).toISOString();
  const rows = await db
    .prepare(
      `SELECT ms.id AS id FROM matched_slots ms
       JOIN op_codes oc ON oc.code = ms.op_code
       WHERE ms.status = 'booked' AND ms.reminder_sent = 0
         AND oc.telegram_thread_id IS NOT NULL
         AND ms.start_time > ? AND ms.start_time <= ?`
    )
    .all(nowIso, windowEndIso);
  for (const row of rows) {
    const ok = await notifyReminder(row.id);
    if (ok) {
      await db.prepare(`UPDATE matched_slots SET reminder_sent = 1 WHERE id = ?`).run(row.id);
    }
  }
}

module.exports = {
  isConfigured,
  sendMessage,
  notifyNewBooking,
  notifyRescheduled,
  notifyReminder,
  sendDueReminders,
};
