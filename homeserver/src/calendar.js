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
 */
export function parseFeed(text) {
  const root = new ICAL.Component(ICAL.parse(text));
  const masters = new Map();
  const exceptions = [];
  for (const ve of root.getAllSubcomponents('vevent')) {
    const uid = ve.getFirstPropertyValue('uid');
    if (!uid) continue;
    if (ve.hasProperty('recurrence-id')) exceptions.push(ve);
    else masters.set(uid, ve);
  }
  return { masters, exceptions };
}

/**
 * Expand one feed's text into occurrences overlapping [fromMs, toMs).
 * cal: { id, email?, exclude?: [regex strings], busyOnly?: bool }
 */
export function expandFeed(text, cal, fromMs, toMs, tz) {
  return expandParsed(parseFeed(text), cal, fromMs, toMs, tz);
}

/** Expand a parseFeed() result into occurrences overlapping [fromMs, toMs). */
export function expandParsed(parsed, cal, fromMs, toMs, tz) {
  const { masters, exceptions } = parsed;
  const exclude = compileExclude(cal.exclude);

  const out = [];
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

  const iterFrom = ICAL.Time.fromJSDate(new Date(fromMs - PAD), true);
  const iterTo = toMs + PAD;

  for (const [uid, master] of masters) {
    const event = new ICAL.Event(master);
    for (const ex of exceptions) {
      if (ex.getFirstPropertyValue('uid') === uid) event.relateException(ex);
    }
    if (!event.isRecurring()) {
      push(master, event.startDate, event.endDate || endFromDuration(event), uid);
      continue;
    }
    const it = event.iterator();
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_OCCURRENCES) {
      if (next.compare(iterFrom) < 0) continue;
      if (next.toUnixTime() * 1000 > iterTo) break;
      const d = event.getOccurrenceDetails(next);
      push(d.item.component, d.startDate, d.endDate, uid);
    }
  }

  // Exceptions whose master is not in this feed (e.g. a single moved instance shared with you).
  for (const ex of exceptions) {
    const uid = ex.getFirstPropertyValue('uid');
    if (masters.has(uid)) continue;
    const ev = new ICAL.Event(ex);
    push(ex, ev.startDate, ev.endDate || endFromDuration(ev), uid);
  }

  return out;
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

