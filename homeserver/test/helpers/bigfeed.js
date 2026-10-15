// Synthetic "years of history" iCal feed, shaped like a real Google secret-iCal export: hundreds
// of long-running recurring series, thousands of exceptions, some finished (UNTIL in the past),
// some COUNT-limited, some all-day. Deterministic for a given anchor date.

const TZID = 'America/Edmonton';
const VTIMEZONE = [
  'BEGIN:VTIMEZONE', 'TZID:America/Edmonton', 'X-LIC-LOCATION:America/Edmonton',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0700', 'TZOFFSETTO:-0600', 'TZNAME:MDT', 'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0700', 'TZNAME:MST', 'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE',
];
const DAY = 86400000;
const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const p2 = (n) => (n < 10 ? '0' : '') + n;
// Day index (days since 1970-01-01) <-> YYYYMMDD
const ymd = (day) => {
  const d = new Date(day * DAY);
  return d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate());
};
const local = (day, hour, min) => ymd(day) + 'T' + p2(hour) + p2(min) + '00';

/**
 * opts: { anchor: 'YYYY-MM-DD' (the "today" the feed is built around), series: 400, exceptions: 2000 }
 * Returns { text, info } where info describes a few series for hand-checked assertions.
 */
export function bigFeed(opts = {}) {
  const [ay, am, ad] = (opts.anchor || '2026-10-14').split('-').map(Number);
  const anchor = Math.floor(Date.UTC(ay, am - 1, ad) / DAY);
  const nSeries = opts.series || 400;
  const nEx = opts.exceptions == null ? 2000 : opts.exceptions;
  const rand = rng(opts.seed || 42);
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//synthetic//big feed//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', ...VTIMEZONE];
  const exceptable = []; // series whose occurrences are simple arithmetic: { uid, start, step, hour, min, dur, until }
  const info = { daily: null, pastUntil: null, allDay: null, weekly2: null };

  for (let i = 0; i < nSeries; i++) {
    const uid = 'series-' + i + '@example.test';
    const years = 10 + (i % 6);
    const start = anchor - years * 365 - Math.floor(rand() * 200);
    const hour = 7 + Math.floor(rand() * 10), min = rand() < 0.5 ? 0 : 30;
    const dur = [15, 30, 45, 60][i % 4];
    const kind = i % 8;
    let rule, step = 0, allDay = false;
    if (kind <= 1) { rule = 'FREQ=DAILY'; step = 1; }
    else if (kind === 2) rule = 'FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR';
    else if (kind === 3) { rule = 'FREQ=WEEKLY;BYDAY=' + WD[new Date(start * DAY).getUTCDay()]; step = 7; }
    else if (kind === 4) rule = 'FREQ=WEEKLY;BYDAY=MO,WE,FR';
    else if (kind === 5) rule = 'FREQ=WEEKLY;INTERVAL=3;BYDAY=TU,TH';
    else if (kind === 6) { rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=' + WD[new Date(start * DAY).getUTCDay()]; step = 14; }
    else { rule = 'FREQ=WEEKLY'; step = 7; allDay = true; }

    let until = null;
    if (i % 10 === 9) {
      until = anchor - 700 - (i % 50); // finished two years ago
      rule += ';UNTIL=' + ymd(until) + 'T235959Z';
    } else if (i % 13 === 12) {
      rule += ';COUNT=' + (300 + i);
      step = 0; // keep exceptions off COUNT series (they would need the count arithmetic)
    } else if (i % 17 === 16) {
      until = anchor + 30;
      rule += ';UNTIL=' + ymd(until) + 'T235959Z';
    }

    lines.push('BEGIN:VEVENT');
    if (allDay) {
      lines.push('DTSTART;VALUE=DATE:' + ymd(start), 'DTEND;VALUE=DATE:' + ymd(start + 1));
    } else {
      const endMin = hour * 60 + min + dur;
      lines.push('DTSTART;TZID=' + TZID + ':' + local(start, hour, min));
      lines.push('DTEND;TZID=' + TZID + ':' + local(start, Math.floor(endMin / 60), endMin % 60));
    }
    lines.push('RRULE:' + rule, 'UID:' + uid, 'SUMMARY:Series ' + i, 'STATUS:CONFIRMED', 'END:VEVENT');

    if (step && !allDay) exceptable.push({ uid, i, start, step, hour, min, dur, until });
    if (kind === 0 && !until && !info.daily && rule.indexOf('COUNT') < 0) info.daily = { uid, start, hour, min, dur };
    if (i % 10 === 9 && !info.pastUntil) info.pastUntil = { uid };
    if (allDay && !until && rule.indexOf('COUNT') < 0 && !info.allDay) info.allDay = { uid, start };
    if (kind === 6 && !until && rule.indexOf('COUNT') < 0 && !info.weekly2) info.weekly2 = { uid, start, hour, min };
  }

  // Exceptions: most deep in history (what a real export is full of), some around the anchor.
  info.moved = [];
  info.cancelled = [];
  const used = new Set();
  for (let k = 0; k < nEx && exceptable.length; k++) {
    const s = exceptable[k % exceptable.length];
    const last = s.until != null ? Math.min(s.until - 1, anchor + 100) : anchor + 100;
    const near = k % 5 === 0;
    const lo = near ? Math.max(s.start, anchor - 40) : s.start;
    const span = Math.max(1, Math.floor((last - lo) / s.step));
    const n = Math.floor(rand() * span);
    const day = s.start + Math.ceil((lo - s.start) / s.step) * s.step + n * s.step;
    if (day > last || used.has(s.uid + day)) continue;
    used.add(s.uid + day);
    const rid = local(day, s.hour, s.min);
    lines.push('BEGIN:VEVENT', 'UID:' + s.uid, 'RECURRENCE-ID;TZID=' + TZID + ':' + rid);
    if (k % 3 === 0) {
      lines.push('DTSTART;TZID=' + TZID + ':' + rid, 'DTEND;TZID=' + TZID + ':' + local(day, s.hour + 1, s.min),
        'SUMMARY:Series ' + s.i, 'STATUS:CANCELLED');
      info.cancelled.push({ uid: s.uid, day, hour: s.hour, min: s.min });
    } else {
      // Moved one hour later (and retitled).
      lines.push('DTSTART;TZID=' + TZID + ':' + local(day, s.hour + 1, s.min),
        'DTEND;TZID=' + TZID + ':' + local(day, s.hour + 2, s.min), 'SUMMARY:Series ' + s.i + ' (moved)', 'STATUS:CONFIRMED');
      info.moved.push({ uid: s.uid, day, hour: s.hour, min: s.min });
    }
    lines.push('END:VEVENT');
  }

  // A few one-off events too.
  for (let j = 0; j < 50; j++) {
    const day = anchor - 25 + j * 3;
    lines.push('BEGIN:VEVENT', 'UID:single-' + j + '@example.test', 'DTSTART;TZID=' + TZID + ':' + local(day, 12, 0),
      'DTEND;TZID=' + TZID + ':' + local(day, 13, 0), 'SUMMARY:One-off ' + j, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return { text: lines.join('\r\n') + '\r\n', info, anchor, tz: TZID };
}
