// Runnable E2E check for booking/rebooking/recruiter-replacement flows.// Needs the stack running (docker compose up) and ADMIN_EMAIL/ADMIN_PASSWORD in env.// Run inside the backend container:  node scripts/smoke.js// WARNING: creates test bookings — run against a dev database only.
// E2E smoke: rebooking cancels the old interview, admin replaces a recruiter.
const assert = (cond, msg) => { if (!cond) { console.error('FAIL: ' + msg); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = require('../src/db');
const API = 'http://127.0.0.1:4000/api';
const j = (r) => r.json();

async function main() {
  const login = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }),
  }).then(j);
  assert(login.token, 'admin login');
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };

  const { recruiters } = await fetch(API + '/recruiters', { headers: H }).then(j);
  const byName = Object.fromEntries(recruiters.map((r) => [r.fullName, r]));
  const darina = byName['Дарина'], ilyusha = byName['Ілюша'], yulia = byName['Юля'];
  assert(darina && ilyusha && yulia, 'seed recruiters present');

  // Availability tomorrow 10:00–13:00 UTC for all three
  const t = new Date(Date.now() + 24 * 3600 * 1000); t.setUTCHours(10, 0, 0, 0);
  const end = new Date(t.getTime() + 3 * 3600 * 1000);
  for (const r of [darina, ilyusha, yulia]) {
    const resp = await fetch(API + '/availability', {
      method: 'POST', headers: H,
      body: JSON.stringify({ recruiterId: r.id, startTime: t.toISOString(), endTime: end.toISOString() }),
    });
    assert(resp.ok, 'add availability -> ' + resp.status);
  }

  let resp = await fetch(API + '/slots/regenerate', { method: 'POST', headers: H, body: JSON.stringify({}) });
  assert(resp.ok, 'regenerate -> ' + resp.status);

  const { slots } = await fetch(API + '/public/slots?op=IK').then(j);
  assert(slots.length >= 2, 'expected >=2 open IK slots, got ' + slots.length);
  // B must not overlap A: booking A invalidates same-time slots for the same recruiters.
  const A = slots[0];
  const B = slots.find((s) => s.startTime >= A.endTime);
  assert(B, 'need a non-overlapping second slot');

  // Book slot A
  resp = await fetch(API + '/public/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchedSlotId: A.id, email: 'cand@test.com', telegramTag: '@cand_test' }),
  });
  assert(resp.status === 201, 'book A -> ' + resp.status + ' ' + (await resp.text()));
  await sleep(2500);
  let rowA = await db.prepare('SELECT status FROM matched_slots WHERE id = ?').get(A.id);
  assert(rowA.status === 'booked', 'A booked, got ' + rowA.status);

  // Re-apply: book slot B with the same telegram -> A must be cancelled, its booking deleted
  resp = await fetch(API + '/public/bookings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ matchedSlotId: B.id, email: 'cand@test.com', telegramTag: '@CAND_test' }),
  });
  assert(resp.status === 201, 'book B -> ' + resp.status);
  await sleep(3500);
  rowA = await db.prepare('SELECT status FROM matched_slots WHERE id = ?').get(A.id);
  const bookA = await db.prepare('SELECT id FROM bookings WHERE matched_slot_id = ?').get(A.id);
  let rowB = await db.prepare('SELECT status, main_recruiter_id, secondary_recruiter_id FROM matched_slots WHERE id = ?').get(B.id);
  assert(rowA.status === 'cancelled', 'A cancelled after rebooking, got ' + rowA.status);
  assert(!bookA, 'old booking row deleted');
  assert(rowB.status === 'booked', 'B booked');

  // Admin replaces the secondary recruiter on B
  const involved = new Set([rowB.main_recruiter_id, rowB.secondary_recruiter_id]);
  const newSec = [darina, ilyusha, yulia].find((r) => !involved.has(r.id));
  assert(newSec, 'replacement recruiter available');
  resp = await fetch(API + '/slots/' + B.id + '/recruiters', {
    method: 'PUT', headers: H, body: JSON.stringify({ secondaryRecruiterId: newSec.id }),
  });
  assert(resp.status === 200, 'replace secondary -> ' + resp.status + ' ' + (await resp.text()));
  const rowB2 = await db.prepare('SELECT main_recruiter_id, secondary_recruiter_id FROM matched_slots WHERE id = ?').get(B.id);
  assert(rowB2.secondary_recruiter_id === newSec.id, 'secondary replaced in DB');

  // Swap main <-> secondary (exercises the UNIQUE-key path)
  resp = await fetch(API + '/slots/' + B.id + '/recruiters', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ mainRecruiterId: rowB2.secondary_recruiter_id, secondaryRecruiterId: rowB2.main_recruiter_id }),
  });
  assert(resp.status === 200, 'swap main/secondary -> ' + resp.status + ' ' + (await resp.text()));

  // main == secondary must be rejected
  const cur = await db.prepare('SELECT main_recruiter_id FROM matched_slots WHERE id = ?').get(B.id);
  resp = await fetch(API + '/slots/' + B.id + '/recruiters', {
    method: 'PUT', headers: H, body: JSON.stringify({ secondaryRecruiterId: cur.main_recruiter_id }),
  });
  assert(resp.status === 400, 'same recruiter twice -> 400, got ' + resp.status);

  // Replacement on a non-booked slot must be rejected
  const open = await db.prepare(`SELECT id FROM matched_slots WHERE status = 'open' LIMIT 1`).get();
  if (open) {
    resp = await fetch(API + '/slots/' + open.id + '/recruiters', {
      method: 'PUT', headers: H, body: JSON.stringify({ secondaryRecruiterId: yulia.id }),
    });
    assert(resp.status === 409, 'open slot replace -> 409, got ' + resp.status);
  }

  // Overlap guard: recruiter with a booked interview at the same time is rejected.
  // Book an IA slot at the same time as B with a different candidate, then try to
  // put one of ITS recruiters onto B.
  const iaSlots = (await fetch(API + '/public/slots?op=IA').then(j)).slots;
  const sameTime = iaSlots.find((s) => s.startTime === B.startTime);
  if (sameTime) {
    resp = await fetch(API + '/public/bookings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchedSlotId: sameTime.id, email: 'other@test.com', telegramTag: '@other_cand' }),
    });
    if (resp.status === 201) {
      await sleep(1500);
      const other = await db.prepare('SELECT secondary_recruiter_id FROM matched_slots WHERE id = ?').get(sameTime.id);
      const busyId = other.secondary_recruiter_id;
      const curB = await db.prepare('SELECT main_recruiter_id, secondary_recruiter_id FROM matched_slots WHERE id = ?').get(B.id);
      if (busyId !== curB.main_recruiter_id && busyId !== curB.secondary_recruiter_id) {
        resp = await fetch(API + '/slots/' + B.id + '/recruiters', {
          method: 'PUT', headers: H, body: JSON.stringify({ secondaryRecruiterId: busyId }),
        });
        assert(resp.status === 409, 'busy recruiter replace -> 409, got ' + resp.status);
        console.log('overlap-guard: verified');
      } else {
        console.log('overlap-guard: skipped (recruiter already on B)');
      }
    }
  } else {
    console.log('overlap-guard: skipped (no same-time IA slot)');
  }

  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
