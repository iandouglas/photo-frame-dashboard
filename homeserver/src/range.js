// The date window for GET /api/events?from=YYYY-MM-DD&days=N, bounded so a client can't ask the
// server to expand years of recurrences.
import { localDate, wallToUtc } from './tz.js';

export const RANGE = { minOffset: -30, maxOffset: 90, minDays: 1, maxDays: 14 };

function dayIndex(y, m, d) {
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function ymd(index) {
  const t = new Date(index * 86400000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Parse ?from=&days= into { from, to, fromDate, days } (epoch ms of local midnights).
 * Returns null when neither is given (the caller uses its default window).
 * Throws { status: 400 } for malformed or out-of-bounds values.
 */
export function parseRange(params, nowMs, tz, defaultDays) {
  const fromRaw = params.get('from');
  const daysRaw = params.get('days');
  if (fromRaw == null && daysRaw == null) return null;
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

  const today = localDate(nowMs, tz).split('-').map(Number);
  const todayIndex = dayIndex(today[0], today[1], today[2]);

  let startIndex = todayIndex;
  if (fromRaw != null) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromRaw);
    if (!m) throw bad('from must be YYYY-MM-DD');
    const y = +m[1], mo = +m[2], d = +m[3];
    startIndex = dayIndex(y, mo, d);
    const back = ymd(startIndex);
    if (back.y !== y || back.m !== mo || back.d !== d) throw bad('from is not a real date');
  }
  const offset = startIndex - todayIndex;
  if (offset < RANGE.minOffset || offset > RANGE.maxOffset) {
    throw bad(`from must be within ${RANGE.minOffset}..${RANGE.maxOffset} days of today`);
  }

  let days = Math.min(defaultDays, RANGE.maxDays);
  if (daysRaw != null) {
    if (!/^\d{1,3}$/.test(daysRaw)) throw bad('days must be a whole number');
    days = +daysRaw;
    if (days < RANGE.minDays || days > RANGE.maxDays) throw bad(`days must be ${RANGE.minDays}..${RANGE.maxDays}`);
  }

  const a = ymd(startIndex), b = ymd(startIndex + days);
  return {
    from: wallToUtc(a.y, a.m, a.d, 0, 0, 0, tz),
    to: wallToUtc(b.y, b.m, b.d, 0, 0, 0, tz),
    fromDate: localDate(wallToUtc(a.y, a.m, a.d, 12, 0, 0, tz), tz),
    days,
  };
}
