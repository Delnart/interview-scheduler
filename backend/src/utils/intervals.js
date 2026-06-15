// Small helper library for working with time intervals.
// All intervals are { start: Date, end: Date } and all times are treated as UTC instants.

function sortIntervals(intervals) {
  return [...intervals].sort((a, b) => a.start - b.start);
}

// Merge overlapping/adjacent intervals into a minimal set.
function mergeIntervals(intervals) {
  const sorted = sortIntervals(intervals.filter((i) => i.start < i.end));
  const result = [];
  for (const cur of sorted) {
    const last = result[result.length - 1];
    if (last && cur.start <= last.end) {
      if (cur.end > last.end) last.end = cur.end;
    } else {
      result.push({ start: new Date(cur.start), end: new Date(cur.end) });
    }
  }
  return result;
}

// Subtract a set of "busy" intervals from a set of "free" intervals.
function subtractIntervals(freeIntervals, busyIntervals) {
  let result = mergeIntervals(freeIntervals);
  const busy = mergeIntervals(busyIntervals);
  for (const b of busy) {
    const next = [];
    for (const f of result) {
      if (b.end <= f.start || b.start >= f.end) {
        // no overlap
        next.push(f);
        continue;
      }
      if (b.start > f.start) {
        next.push({ start: f.start, end: new Date(Math.min(b.start, f.end)) });
      }
      if (b.end < f.end) {
        next.push({ start: new Date(Math.max(b.end, f.start)), end: f.end });
      }
    }
    result = next.filter((i) => i.start < i.end);
  }
  return mergeIntervals(result);
}

// Intersect two sets of intervals (a AND b).
function intersectIntervalSets(aIntervals, bIntervals) {
  const a = mergeIntervals(aIntervals);
  const b = mergeIntervals(bIntervals);
  const result = [];
  for (const x of a) {
    for (const y of b) {
      const start = new Date(Math.max(x.start, y.start));
      const end = new Date(Math.min(x.end, y.end));
      if (start < end) result.push({ start, end });
    }
  }
  return mergeIntervals(result);
}

// Split intervals into fixed-size chunks (in minutes), discarding any remainder
// shorter than the requested duration.
function splitIntoSlots(intervals, durationMinutes) {
  const durationMs = durationMinutes * 60 * 1000;
  const slots = [];
  for (const interval of intervals) {
    let cursor = new Date(interval.start);
    while (cursor.getTime() + durationMs <= interval.end.getTime()) {
      const end = new Date(cursor.getTime() + durationMs);
      slots.push({ start: new Date(cursor), end });
      cursor = end;
    }
  }
  return slots;
}

module.exports = {
  mergeIntervals,
  subtractIntervals,
  intersectIntervalSets,
  splitIntoSlots,
};
