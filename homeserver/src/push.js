// Pushed calendars: a laptop (homeserver/push-macos) PUTs a curated snapshot of a calendar the
// server can't read itself, e.g. a Workspace calendar whose secret iCal address is disabled.
// Only titles and times are accepted; the snapshot is kept on the data volume.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wallToUtc } from './tz.js';

export const LIMITS = {
  maxBody: 256 * 1024,
  maxEvents: 500,
  maxTitle: 200,
  maxUid: 300,
  maxDurationMs: 62 * 86400000,
  pastMs: 120 * 86400000, // events must lie within this window around "now"
  futureMs: 400 * 86400000,
};

const DEFAULT_COLORS = ['#7C3AED', '#DB2777', '#0E7490', '#3B6FD8', '#00A36C', '#C2410C'];

/** PUSH_CALENDARS: JSON [{ id, name?, color?, alert?, token }]. Tokens are never echoed. */
export function parsePushCalendars(json, takenIds = []) {
  if (json == null || String(json).trim() === '') return [];
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    throw new Error('PUSH_CALENDARS is not valid JSON'); // don't echo: it holds tokens
  }
  if (!Array.isArray(list)) throw new Error('PUSH_CALENDARS must be a JSON array');
  const ids = new Set(takenIds);
  return list.map((c, i) => {
    const where = `PUSH_CALENDARS[${i}]`;
    if (!c || typeof c !== 'object') throw new Error(`${where} must be an object`);
    if (typeof c.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(c.id)) {
      throw new Error(`${where}.id must be 1-32 chars of a-z, 0-9, _ or -`);
    }
    if (ids.has(c.id)) throw new Error(`${where}.id "${c.id}" is already used (CALENDARS and PUSH_CALENDARS share ids)`);
    ids.add(c.id);
    if (typeof c.token !== 'string' || c.token.length < 24 || /\s/.test(c.token)) {
      throw new Error(`${where} (${c.id}) token must be at least 24 characters, no spaces`);
    }
    const color = c.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${where} (${c.id}) color must be #rrggbb`);
    return {
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : c.id,
      color,
      alert: !!c.alert,
      token: c.token,
      pushed: true,
    };
  });
}

/** Constant-time comparison of "Bearer <token>" against the calendar's token. */
export function tokenMatches(header, token) {
  const m = /^Bearer (\S+)$/.exec(String(header || ''));
  if (!m || !token) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

function bad(msg) {
  return Object.assign(new Error(msg), { status: 400 });
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(s, field) {
  const m = DATE.exec(String(s));
  if (!m) throw bad(`${field} must be YYYY-MM-DD`);
  const y = +m[1], mo = +m[2], d = +m[3];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) throw bad(`${field} is not a real date`);
  return [y, mo, d];
}

/**
 * Validate a pushed snapshot into the server's event shape (without cal-specific fields).
 * Accepted per event: { uid, title, start, end } (epoch ms) or
 * { uid, title, allDay: true, startDate, endDate } (YYYY-MM-DD, endDate exclusive).
 * Any other field is ignored, so a client can't smuggle attendees or links onto the frame.
 */
export function validatePushPayload(body, tz, nowMs) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) throw bad('body must be {"events": [...]}');
  if (body.events.length > LIMITS.maxEvents) throw bad(`at most ${LIMITS.maxEvents} events`);
  const out = [];
  body.events.forEach((e, i) => {
    const where = `events[${i}]`;
    if (!e || typeof e !== 'object') throw bad(`${where} must be an object`);
    if (typeof e.uid !== 'string' || !e.uid || e.uid.length > LIMITS.maxUid) throw bad(`${where}.uid must be a string of 1-${LIMITS.maxUid} chars`);
    if (typeof e.title !== 'string') throw bad(`${where}.title must be a string`);
    let title = e.title.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
    if (title.length > LIMITS.maxTitle) title = title.slice(0, LIMITS.maxTitle - 1) + '…';
    if (!title) title = '(no title)';

    let start, end, startDate, endDate;
    const allDay = e.allDay === true;
    if (allDay) {
      const [sy, sm, sd] = dateParts(e.startDate, `${where}.startDate`);
      const [ey, em, ed] = dateParts(e.endDate, `${where}.endDate`);
      start = wallToUtc(sy, sm, sd, 0, 0, 0, tz);
      end = wallToUtc(ey, em, ed, 0, 0, 0, tz);
      startDate = e.startDate;
      endDate = e.endDate;
    } else {
      start = e.start;
      end = e.end;
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw bad(`${where} needs numeric start and end (epoch ms)`);
    }
    if (end < start) throw bad(`${where} ends before it starts`);
    if (end - start > LIMITS.maxDurationMs) throw bad(`${where} is longer than ${LIMITS.maxDurationMs / 86400000} days`);
    if (start < nowMs - LIMITS.pastMs || start > nowMs + LIMITS.futureMs) throw bad(`${where} is too far from today`);
    if (allDay && end === start) end = start + 86400000;

    const ev = { uid: e.uid, title, start, end, allDay };
    if (allDay) {
      ev.startDate = startDate;
      ev.endDate = endDate;
    }
    out.push(ev);
  });
  return out;
}

/** Snapshot events overlapping [from, to), in the server's event shape for calendar `cal`. */
export function pushedEventsBetween(snapshot, cal, from, to) {
  if (!snapshot) return [];
  const out = [];
  for (const e of snapshot.events) {
    if (e.end < from || (e.end === from && e.start < from) || e.start >= to) continue;
    const ev = { id: cal.id + ':' + e.uid + ':' + e.start, uid: e.uid, cal: cal.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay };
    if (e.allDay) {
      ev.startDate = e.startDate;
      ev.endDate = e.endDate;
    }
    out.push(ev);
  }
  return out;
}

/** Status line entry: okAt = last push; STALE after staleMin; NO_PUSH_YET before the first. */
export function pushStatus(cal, snapshot, nowMs, staleMin) {
  if (!snapshot) return { id: cal.id, okAt: null, error: 'NO_PUSH_YET' };
  const stale = nowMs - snapshot.receivedAt > staleMin * 60000;
  return { id: cal.id, okAt: snapshot.receivedAt, error: stale ? 'STALE' : null };
}

/** Snapshots on disk: <dir>/push-<id>.json, written atomically. */
export class PushStore {
  constructor(dir, calendars) {
    this.dir = dir;
    this.snapshots = new Map();
    for (const cal of calendars) {
      try {
        const s = JSON.parse(readFileSync(this.file(cal.id), 'utf8'));
        if (s && Array.isArray(s.events) && Number.isFinite(s.receivedAt)) this.snapshots.set(cal.id, s);
      } catch {
        // nothing pushed yet
      }
    }
  }

  file(id) {
    return join(this.dir, 'push-' + id + '.json');
  }

  get(id) {
    return this.snapshots.get(id) || null;
  }

  put(id, events, nowMs) {
    const snap = { receivedAt: nowMs, events };
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(id) + '.tmp';
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.file(id));
    this.snapshots.set(id, snap);
    return snap;
  }
}
