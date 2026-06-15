const { v4: uuid } = require('uuid');
const db = require('../db');
const { subtractIntervals, intersectIntervalSets, splitIntoSlots } = require('./intervals');
const googleCalendar = require('./googleCalendar');

const DEFAULT_WINDOW_DAYS = 60;

function getSlotDurationMinutes() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('slot_duration_minutes');
  return row ? parseInt(row.value, 10) : 45;
}

// Raw availability intervals declared by the recruiter, within [timeMin, timeMax].
function getRawAvailability(recruiterId, timeMin, timeMax) {
  const rows = db
    .prepare('SELECT start_time, end_time FROM availability WHERE recruiter_id = ?')
    .all(recruiterId);
  return rows
    .map((r) => ({ start: new Date(r.start_time), end: new Date(r.end_time) }))
    .map((i) => ({ start: new Date(Math.max(i.start, timeMin)), end: new Date(Math.min(i.end, timeMax)) }))
    .filter((i) => i.start < i.end);
}

// Time ranges already committed via a booked matched slot (this recruiter as either main or secondary).
function getBookedIntervals(recruiterId, timeMin, timeMax) {
  const rows = db
    .prepare(
      `SELECT start_time, end_time FROM matched_slots
       WHERE status = 'booked' AND (main_recruiter_id = ? OR secondary_recruiter_id = ?)`
    )
    .all(recruiterId, recruiterId);
  return rows
    .map((r) => ({ start: new Date(r.start_time), end: new Date(r.end_time) }))
    .map((i) => ({ start: new Date(Math.max(i.start, timeMin)), end: new Date(Math.min(i.end, timeMax)) }))
    .filter((i) => i.start < i.end);
}

// Free time = declared availability minus already-booked interviews minus Google Calendar busy time.
async function getRecruiterFreeIntervals(recruiterId, timeMin, timeMax) {
  const available = getRawAvailability(recruiterId, timeMin, timeMax);
  if (available.length === 0) return [];
  const booked = getBookedIntervals(recruiterId, timeMin, timeMax);
  const googleBusy = await googleCalendar.getBusyIntervals(recruiterId, timeMin, timeMax);
  return subtractIntervals(available, [...booked, ...googleBusy]);
}

function getTeamAssignments(opCode) {
  const rows = db
    .prepare(
      `SELECT op_recruiters.recruiter_id as recruiter_id, op_recruiters.role as role
       FROM op_recruiters
       JOIN recruiters ON recruiters.id = op_recruiters.recruiter_id
       WHERE op_recruiters.op_code = ? AND recruiters.active = 1`
    )
    .all(opCode);
  return {
    main: rows.filter((r) => r.role === 'main').map((r) => r.recruiter_id),
    secondary: rows.filter((r) => r.role === 'secondary').map((r) => r.recruiter_id),
  };
}

// Global pool of potential partners: every active recruiter who belongs to ANY OP's
// team. A "main" recruiter for an OP can be paired with anyone from this pool.
function getGlobalTeamMembers() {
  const rows = db
    .prepare(
      `SELECT DISTINCT op_recruiters.recruiter_id as recruiter_id
       FROM op_recruiters
       JOIN recruiters ON recruiters.id = op_recruiters.recruiter_id
       WHERE recruiters.active = 1`
    )
    .all();
  return rows.map((r) => r.recruiter_id);
}

// Recomputes 'open' matched slots for one OP by intersecting each "main" recruiter's
// free time with every partner's, splitting overlaps into fixed-size slots. Booked
// slots are never touched.
async function generateMatchedSlotsForOp(opCode, windowDays = DEFAULT_WINDOW_DAYS, options = {}) {
  const duration = options.duration ?? getSlotDurationMinutes();
  const timeMin = options.timeMin ?? new Date();
  const timeMax = options.timeMax ?? new Date(timeMin.getTime() + windowDays * 24 * 60 * 60 * 1000);

  // Memoize each recruiter's free intervals (incl. their Google freebusy call) for the
  // pass, so it's computed once per recruiter instead of once per pair.
  const freeCache = options.freeCache ?? new Map();
  const freeIntervalsFor = async (recruiterId) => {
    if (!freeCache.has(recruiterId)) {
      freeCache.set(recruiterId, await getRecruiterFreeIntervals(recruiterId, timeMin, timeMax));
    }
    return freeCache.get(recruiterId);
  };

  const { main } = getTeamAssignments(opCode);
  const partners = getGlobalTeamMembers();
  const validKeys = new Set();

  const insertStmt = db.prepare(
    `INSERT INTO matched_slots (id, op_code, main_recruiter_id, secondary_recruiter_id, start_time, end_time, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')
     ON CONFLICT(op_code, main_recruiter_id, secondary_recruiter_id, start_time) DO NOTHING`
  );

  for (const mainId of main) {
    const freeMain = await freeIntervalsFor(mainId);
    if (freeMain.length === 0) continue;
    for (const secId of partners) {
      if (mainId === secId) continue;
      const freeSec = await freeIntervalsFor(secId);
      if (freeSec.length === 0) continue;
      const overlap = intersectIntervalSets(freeMain, freeSec);
      const slots = splitIntoSlots(overlap, duration);
      for (const slot of slots) {
        const startIso = slot.start.toISOString();
        const endIso = slot.end.toISOString();
        validKeys.add(`${mainId}|${secId}|${startIso}`);
        insertStmt.run(uuid(), opCode, mainId, secId, startIso, endIso);
      }
    }
  }

  // Remove stale 'open' slots (no longer supported by current availability/config)
  const openSlots = db
    .prepare(`SELECT id, main_recruiter_id, secondary_recruiter_id, start_time FROM matched_slots WHERE op_code = ? AND status = 'open'`)
    .all(opCode);
  const deleteStmt = db.prepare('DELETE FROM matched_slots WHERE id = ?');
  for (const row of openSlots) {
    const key = `${row.main_recruiter_id}|${row.secondary_recruiter_id}|${row.start_time}`;
    if (!validKeys.has(key)) deleteStmt.run(row.id);
  }
}

async function regenerateAll(windowDays = DEFAULT_WINDOW_DAYS) {
  const ops = db.prepare('SELECT code FROM op_codes').all();
  // One shared cache + time window across all OPs, so each recruiter's freebusy is
  // fetched at most once per pass.
  const timeMin = new Date();
  const timeMax = new Date(timeMin.getTime() + windowDays * 24 * 60 * 60 * 1000);
  const duration = getSlotDurationMinutes();
  const freeCache = new Map();
  for (const op of ops) {
    await generateMatchedSlotsForOp(op.code, windowDays, { timeMin, timeMax, duration, freeCache });
  }
}

module.exports = {
  getSlotDurationMinutes,
  getRecruiterFreeIntervals,
  getTeamAssignments,
  generateMatchedSlotsForOp,
  regenerateAll,
};
