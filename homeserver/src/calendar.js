// Parse Google Calendar iCal feeds, expand recurrences into a time window, filter and merge.
// Pure functions: nothing here fetches, logs, or sees a feed URL.
import ICAL from 'ical.js';
import { wallToUtc, isValidZone } from './tz.js';

const MAX_OCCURRENCES = 20000; // a daily event since 1970 is ~20k; stops runaway rules
const PAD = 31 * 86400000; // iterate a month either side so moved exceptions are not missed

/** Epoch ms for an ICAL.Time. Floating times (and unknown TZIDs) are read in `tz`. */
function instantOf(time, tz, tzidHint) {
  const zone = time.zone;
  const floating = !zone || zone.tzid === 'floating';
  if (!floating) return time.toUnixTime() * 1000;
  const useTz = tzidHint && isValidZone(tzidHint) ? tzidHint : tz;
  return wallToUtc(time.year, time.month, time.day, time.hour, time.minute, time.second, useTz);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

function dateString(time) {
  return time.year + '-' + pad2(time.month) + '-' + pad2(time.day);
}

function tzidOf(component, name) {
  const prop = component.getFirstProperty(name);
  return prop ? prop.getParameter('tzid') : null;
}

/** True when `email` is an attendee who declined. */
function declinedBy(component, email) {
  if (!email) return false;
  const want = 'mailto:' + email.toLowerCase();
  return component.getAllProperties('attendee').some((p) => {
    const v = String(p.getFirstValue() || '').toLowerCase();
    return v === want && String(p.getParameter('partstat') || '').toUpperCase() === 'DECLINED';
  });
}

function compileExclude(list) {
  return (list || []).map((s) => new RegExp(s, 'i'));
}

/**
 * Parse one feed's text once. The result can be expanded into any number of ranges with
 * expandParsed(), so the server keeps it and serves other dates without refetching.
 * Exceptions (RECURRENCE-ID instances) are indexed by UID here, once.
 */
export function parseFeed(text) {
  const root = new ICAL.Component(ICAL.parse(text));
  const masters = new Map();
  const exceptions = [];
  const exByUid = new Map(); // uid -> [exception vevents]
  for (const ve of root.getAllSubcomponents('vevent')) {
    const uid = ve.getFirstPropertyValue('uid');
    if (!uid) continue;
    if (ve.hasProperty('recurrence-id')) {
      exceptions.push(ve);
      const list = exByUid.get(uid);
      if (list) list.push(ve);
      else exByUid.set(uid, [ve]);
    } else masters.set(uid, ve);
  }
  return { masters, exceptions, exByUid };
}

/**
 * Expand one feed's text into occurrences overlapping [fromMs, toMs).
 * cal: { id, email?, exclude?: [regex strings], busyOnly?: bool }
 */
export function expandFeed(text, cal, fromMs, toMs, tz) {
  return expandParsed(parseFeed(text), cal, fromMs, toMs, tz);
}

/**
 * Expand a parseFeed() result into occurrences overlapping [fromMs, toMs), synchronously.
 * opts.fastForward (default true): start long-running DAILY/WEEKLY rules near the window instead
 * of stepping from their first DTSTART. false = the plain reference expansion (tests compare them).
 */
export function expandParsed(parsed, cal, fromMs, toMs, tz, opts) {
  const job = { out: [], stats: newStats() };
  const steps = expandSteps(parsed, cal, fromMs, toMs, tz, job, opts || {});
  while (!steps.next().done) { /* run to the end */ }
  return job.out;
}

/**
 * The same expansion, cooperatively: yields to the event loop every `sliceMs` of work so the
 * server keeps answering while years of recurrences are expanded.
 * Resolves to { events, stats }, or null when opts.shouldStop() turned true (a newer job won).
 */
export async function expandParsedAsync(parsed, cal, fromMs, toMs, tz, opts) {
  opts = opts || {};
  const sliceMs = opts.sliceMs || 8;
  const job = { out: [], stats: newStats() };
  const steps = expandSteps(parsed, cal, fromMs, toMs, tz, job, opts);
  let sliceStart = Date.now();
  while (!steps.next().done) {
    if (Date.now() - sliceStart < sliceMs) continue;
    await new Promise((resolve) => setImmediate(resolve));
    if (opts.shouldStop && opts.shouldStop()) return null;
    sliceStart = Date.now();
  }
  return { events: job.out, stats: job.stats };
}

function newStats() {
  return { masters: 0, recurring: 0, skipped: 0, fastForwarded: 0, iterations: 0 };
}

const YIELD_EVERY = 256; // iterations between yield points inside one long series

/**
 * The expansion as a generator: it yields after each master and every YIELD_EVERY occurrences,
 * so a driver decides when to pause. Results go to job.out.
 */
function* expandSteps(parsed, cal, fromMs, toMs, tz, job, opts) {
  const { masters, exceptions } = parsed;
  const exByUid = parsed.exByUid || indexExceptions(exceptions);
  const exclude = compileExclude(cal.exclude);
  const out = job.out, stats = job.stats;

  const push = (component, start, end, uid) => {
    const status = String(component.getFirstPropertyValue('status') || '').toUpperCase();
    if (status === 'CANCELLED') return;
    if (declinedBy(component, cal.email)) return;
    const title = String(component.getFirstPropertyValue('summary') || '(no title)');
    if (exclude.some((re) => re.test(title))) return;

    const allDay = start.isDate;
    const startTzid = tzidOf(component, 'dtstart');
    let s, e, startDate, endDate;
    if (allDay) {
      startDate = dateString(start);
      endDate = dateString(end);
      s = wallToUtc(start.year, start.month, start.day, 0, 0, 0, tz);
      e = wallToUtc(end.year, end.month, end.day, 0, 0, 0, tz);
    } else {
      s = instantOf(start, tz, startTzid);
      e = instantOf(end, tz, tzidOf(component, 'dtend') || startTzid);
    }
    if (e <= s) e = allDay ? s + 86400000 : s;
    if (e < fromMs || (e === fromMs && s < fromMs)) return;
    if (s >= toMs) return;

    const ev = {
      id: cal.id + ':' + uid + ':' + s,
      uid,
      cal: cal.id,
      title: cal.busyOnly ? 'Busy' : title,
      start: s,
      end: e,
      allDay,
    };
    if (allDay) {
      ev.startDate = startDate;
      ev.endDate = endDate;
    }
    const location = component.getFirstPropertyValue('location');
    if (location && !cal.busyOnly) ev.location = String(location);
    out.push(ev);
  };

  const iterFromMs = fromMs - PAD;
  const iterFrom = ICAL.Time.fromJSDate(new Date(iterFromMs), true);
  const iterTo = toMs + PAD;
  const fastForward = opts.fastForward !== false;

  for (const [uid, master] of masters) {
    stats.masters++;
    // Pass the exceptions explicitly: without `exceptions`, ICAL.Event relates every
    // RECURRENCE-ID component in the whole calendar to this master, whatever its UID, so another
    // series' moved or cancelled instance at the same local time would replace this one's (and
    // it costs masters x exceptions work).
    const event = new ICAL.Event(master, { exceptions: exByUid.get(uid) || [] });
    if (!event.isRecurring()) {
      push(master, event.startDate, event.endDate || endFromDuration(event), uid);
      yield;
      continue;
    }
    stats.recurring++;
    const rules = master.getAllProperties('rrule').map((p) => p.getFirstValue());
    // Every occurrence is before the window (and a moved instance is only seen through its
    // original slot, which is before it too), so there is nothing to step through.
    if (!master.hasProperty('rdate') && rules.length && rules.every((r) => endsBefore(r, iterFromMs))) {
      stats.skipped++;
      yield;
      continue;
    }

    let it;
    const ffStart = fastForward ? fastForwardStart(event, master, rules, iterFromMs) : null;
    if (ffStart) {
      it = event.iterator(ffStart);
      stats.fastForwarded++;
    } else {
      it = event.iterator();
    }
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
      stats.iterations++;
      if (n % YIELD_EVERY === 0) yield;
      if (next.compare(iterFrom) < 0) continue;
      if (next.toUnixTime() * 1000 > iterTo) break;
      const d = event.getOccurrenceDetails(next);
      push(d.item.component, d.startDate, d.endDate, uid);
    }
    yield;
  }

  // Exceptions whose master is not in this feed (e.g. a single moved instance shared with you).
  for (const ex of exceptions) {
    const uid = ex.getFirstPropertyValue('uid');
    if (masters.has(uid)) continue;
    const ev = new ICAL.Event(ex);
    push(ex, ev.startDate, ev.endDate || endFromDuration(ev), uid);
  }
}

function indexExceptions(exceptions) {
  const map = new Map();
  for (const ex of exceptions) {
    const uid = ex.getFirstPropertyValue('uid');
    if (!map.has(uid)) map.set(uid, []);
    map.get(uid).push(ex);
  }
  return map;
}

/** True when a rule's UNTIL is before `ms` (COUNT rules are left to end on their own). */
function endsBefore(rule, ms) {
  if (!rule.until) return false;
  // A DATE until is the whole local day: allow a day of slack rather than resolve its zone.
  return rule.until.toUnixTime() * 1000 + 86400000 < ms;
}

/**
 * A later DTSTART for the iterator that yields exactly the same occurrences from there on, or
 * null when that can't be guaranteed. Safe for one DAILY or WEEKLY rule without COUNT, RDATE or
 * BYSETPOS: moving DTSTART by a whole number of INTERVAL periods keeps the day/week phase the
 * rule is anchored to (and the wall-clock time), and EXDATEs are matched by value. The new start
 * stays at least one period before the window, so DTSTART itself (always an occurrence, even
 * when it doesn't match BYDAY) is never inside it.
 */
function fastForwardStart(event, master, rules, iterFromMs) {
  if (rules.length !== 1 || master.hasProperty('rdate')) return null;
  const r = rules[0];
  if (r.count || (r.freq !== 'DAILY' && r.freq !== 'WEEKLY')) return null;
  const parts = r.parts || {};
  if (parts.BYSETPOS || parts.BYWEEKNO || parts.BYYEARDAY || parts.BYHOUR || parts.BYMINUTE || parts.BYSECOND) return null;
  const periodDays = (r.interval || 1) * (r.freq === 'WEEKLY' ? 7 : 1);
  const start = event.startDate;
  const startMs = start.toUnixTime() * 1000; // only used to count days; zone error is under a day
  const gapDays = Math.floor((iterFromMs - startMs) / 86400000) - periodDays - 2;
  const periods = Math.floor(gapDays / periodDays);
  if (periods < 2) return null;
  const moved = start.clone();
  moved.adjust(periods * periodDays, 0, 0, 0);
  return moved;
}

function endFromDuration(event) {
  const end = event.startDate.clone();
  if (event.duration) end.addDuration(event.duration);
  else if (event.startDate.isDate) end.day += 1;
  return end;
}

/**
 * Merge per-calendar lists: sort by start, and fold the same meeting (same UID and start)
 * appearing on several calendars into one entry with `also: [calIds]`.
 * Calendar order in `calendars` decides which copy wins.
 */
export function mergeEvents(lists) {
  const byKey = new Map();
  const out = [];
  for (const list of lists) {
    for (const ev of list) {
      const key = ev.uid + '@' + ev.start;
      const seen = byKey.get(key);
      if (seen) {
        if (seen.cal !== ev.cal && seen.also.indexOf(ev.cal) < 0) seen.also.push(ev.cal);
        continue;
      }
      const copy = Object.assign({ also: [] }, ev);
      byKey.set(key, copy);
      out.push(copy);
    }
  }
  out.sort((a, b) => a.start - b.start || (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.end - b.end);
  for (const ev of out) if (!ev.also.length) delete ev.also;
  return out;
}

/** Calendar metadata that is safe to send to the client (never the URL). */
export function publicCalendars(calendars) {
  return calendars.map((c) => ({ id: c.id, name: c.name, color: c.color, alert: !!c.alert }));
}

