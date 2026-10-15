// Feeds with years of history: expansion must be correct, fast once cached, and cooperative.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bigFeed } from './helpers/bigfeed.js';
import { parseFeed, expandParsed, expandParsedAsync, mergeEvents } from '../src/calendar.js';
import { wallToUtc, localDate } from '../src/tz.js';

const D = 86400000;
const big = bigFeed({ anchor: '2026-10-14', series: 400, exceptions: 2000 });
const TZ = big.tz;
const parsed = parseFeed(big.text);
const TODAY = wallToUtc(2026, 10, 14, 0, 0, 0, TZ);
const WIN = { from: TODAY - 30 * D, to: TODAY + 104 * D }; // what range.js lets the agenda reach
const cal = { id: 'big' };
const key = (e) => JSON.stringify(e);
const sameEvents = (a, b) => assert.deepEqual(a.map(key).sort(), b.map(key).sort());
const overlaps = (e, from, to) => !(e.end < from || (e.end === from && e.start < from) || e.start >= to);
const dayOf = (day) => { const d = new Date(day * D); return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]; };
const at = (day, h, m) => { const [y, mo, d] = dayOf(day); return wallToUtc(y, mo, d, h, m, 0, TZ); };

let full; // the cooperative expansion of the whole window, shared by the tests below
let fullMs;
before(async () => {
  const t = performance.now();
  full = await expandParsedAsync(parsed, cal, WIN.from, WIN.to, TZ);
  fullMs = performance.now() - t;
});

test('exceptions are indexed by UID at parse time', () => {
  let n = 0;
  for (const list of parsed.exByUid.values()) n += list.length;
  assert.equal(n, parsed.exceptions.length);
  assert.ok(n > 1500, 'the synthetic feed has thousands of exceptions');
});

test('fast-forwarded expansion matches stepping every series from its first DTSTART', () => {
  // The reference is the slow, obviously-correct walk; a smaller feed keeps it quick.
  const small = bigFeed({ anchor: '2026-10-14', series: 160, exceptions: 800, seed: 7 });
  const p = parseFeed(small.text);
  const ref = expandParsed(p, cal, WIN.from, WIN.to, TZ, { fastForward: false });
  const ff = expandParsed(p, cal, WIN.from, WIN.to, TZ);
  assert.ok(ref.length > 3000);
  sameEvents(ff, ref);
});

test('filtering the cached window equals expanding a range directly', () => {
  assert.ok(full.stats.skipped > 0, 'series that ended long ago are skipped');
  assert.ok(full.stats.fastForwarded > 200, 'long daily/weekly series start near the window');
  for (const [from, days] of [[TODAY, 1], [TODAY, 14], [TODAY - 30 * D, 1], [TODAY + 90 * D, 14], [TODAY + 37 * D, 3]]) {
    const to = from + days * D;
    sameEvents(full.events.filter((e) => overlaps(e, from, to)), expandParsed(parsed, cal, from, to, TZ));
  }
});

test('hand-checked occurrences: daily series, moved and cancelled exceptions, ended series, all-day', () => {
  const ev = full.events;
  const anchor = big.anchor;
  const d = big.info.daily;
  const today = ev.filter((e) => e.uid === d.uid && overlaps(e, TODAY, TODAY + D));
  // Unless today's instance was itself an exception, it is at its usual time.
  if (today.length && !/moved/.test(today[0].title)) {
    assert.equal(today[0].start, at(anchor, d.hour, d.min));
    assert.equal(today[0].end - today[0].start, d.dur * 60000);
  }
  const cancelledHere = big.info.cancelled.filter((c) => {
    const t = at(c.day, c.hour, c.min);
    return c.uid === d.uid && t >= WIN.from && t < WIN.to;
  }).length;
  assert.equal(ev.filter((e) => e.uid === d.uid).length, 134 - cancelledHere, 'one per day across the window');

  assert.ok(big.info.moved.length > 20);
  let checked = 0;
  for (const m of big.info.moved) {
    const orig = at(m.day, m.hour, m.min);
    if (orig < WIN.from || orig >= WIN.to) continue;
    const same = ev.filter((e) => e.uid === m.uid && Math.abs(e.start - orig) < 2 * 3600000);
    assert.ok(same.some((e) => e.start === at(m.day, m.hour + 1, m.min) && /\(moved\)$/.test(e.title)), 'moved instance');
    assert.ok(!same.some((e) => e.start === orig), 'original slot is gone');
    checked++;
  }
  assert.ok(checked > 20);
  for (const c of big.info.cancelled) {
    assert.ok(!ev.some((e) => e.uid === c.uid && e.start === at(c.day, c.hour, c.min)), 'cancelled instance');
  }
  assert.ok(!ev.some((e) => e.uid === big.info.pastUntil.uid), 'a series that ended two years ago');

  const ad = ev.filter((e) => e.uid === big.info.allDay.uid);
  assert.ok(ad.length >= 19);
  const weekday = new Date(big.info.allDay.start * D).getUTCDay();
  for (const e of ad) {
    assert.equal(e.allDay, true);
    assert.equal(new Date(e.startDate + 'T00:00:00Z').getUTCDay(), weekday);
    assert.equal(e.start, wallToUtc(...e.startDate.split('-').map(Number), 0, 0, 0, TZ));
  }

  const w2 = big.info.weekly2;
  const w2ev = ev.filter((e) => e.uid === w2.uid && !/moved/.test(e.title));
  for (const e of w2ev) {
    const local = localDate(e.start, TZ).split('-').map(Number);
    const day = Math.floor(Date.UTC(local[0], local[1] - 1, local[2]) / D);
    assert.equal((day - w2.start) % 14, 0, 'every other week, on the original phase');
  }
});

test('ranged queries answer from the cached expansion within a small budget', () => {
  console.log(`# full-window expansion: ${Math.round(fullMs)} ms, ${full.events.length} events, ${JSON.stringify(full.stats)}`);
  const sorted = full.events.slice().sort((a, b) => a.start - b.start);
  const t = performance.now();
  for (let i = -30; i <= 90; i++) {
    const from = TODAY + i * D;
    mergeEvents([sorted.filter((e) => overlaps(e, from, from + D))]);
  }
  const perQuery = (performance.now() - t) / 121;
  console.log(`# ranged query (filter + merge): ${perQuery.toFixed(2)} ms`);
  assert.ok(perQuery < 25, `ranged query took ${perQuery} ms`);
});

test('the cooperative expansion keeps the event loop responsive, and stops when superseded', async () => {
  let last = performance.now(), worst = 0, ticks = 0;
  const timer = setInterval(() => {
    const t = performance.now();
    worst = Math.max(worst, t - last);
    last = t;
    ticks++;
  }, 5);
  const r = await expandParsedAsync(parsed, cal, WIN.from, WIN.to, TZ);
  clearInterval(timer);
  assert.equal(r.events.length, full.events.length);
  assert.ok(ticks > 5, 'timers ran during the expansion');
  assert.ok(worst < 120, `event loop was blocked for ${Math.round(worst)} ms`);

  let calls = 0;
  const stopped = await expandParsedAsync(parsed, cal, WIN.from, WIN.to, TZ, { shouldStop: () => ++calls > 2 });
  assert.equal(stopped, null);
});

// ------------------------------------------------------------ a real server, mid-expansion

let proc, base, dir;
const PORT = 20000 + Math.floor(Math.random() * 2000);

async function startServer() {
  const root = new URL('../../tmp/', import.meta.url).pathname;
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, 'bigfeed-srv-'));
  const today = localDate(Date.now(), TZ);
  // Big enough that expanding it takes a noticeable while (seconds on slow hardware).
  const feed = bigFeed({ anchor: today, series: 1200, exceptions: 4000 });
  const file = join(dir, 'big.ics');
  writeFileSync(file, feed.text);
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH, PORT: String(PORT), HOST: '127.0.0.1', TZ, ALLOW_FILE_FEEDS: '1',
      STATE_FILE: join(dir, 'state.json'),
      CALENDARS: JSON.stringify([{ id: 'big', name: 'Big', url: pathToFileURL(file).href }]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.setEncoding('utf8');
  proc.logs = '';
  proc.stdout.on('data', (s) => { proc.logs += s; });
  base = 'http://127.0.0.1:' + PORT;
  return today;
}

after(() => {
  if (proc) proc.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function timed(path) {
  const t = performance.now();
  const res = await fetch(base + path);
  const body = await res.json();
  return { ms: performance.now() - t, status: res.status, body };
}

test('/healthz answers promptly while a large feed is being expanded', async () => {
  const today = await startServer();
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) break;
    } catch { /* not up yet */ }
    if (i > 100) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 50));
  }
  let worstHealth = 0, sawBuilding = false, done = null;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const h = await timed('/healthz');
    worstHealth = Math.max(worstHealth, h.ms);
    const ev = await timed('/api/events?from=' + today + '&days=1');
    assert.equal(ev.status, 200);
    if (ev.body.building) sawBuilding = true;
    else if (ev.body.status[0].okAt) { done = ev; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`# worst /healthz during expansion: ${Math.round(worstHealth)} ms; ${(proc.logs.match(/"calendar_expanded".*/) || [''])[0]}`);
  assert.ok(done, 'expansion finished');
  assert.ok(sawBuilding, 'requests during the expansion were answered with building:true');
  assert.ok(worstHealth < 500, `/healthz took ${Math.round(worstHealth)} ms during expansion`);
  assert.ok(done.body.events.length > 0);
  assert.ok(!/series-|One-off|big\.ics/.test(proc.logs), 'logs carry no titles, UIDs or URLs');

  // Once expanded, other days are just a filter.
  let worst = 0;
  for (const offset of [-30, -1, 1, 7, 45, 90]) {
    const d = new Date(Date.parse(today + 'T12:00:00Z') + offset * D).toISOString().slice(0, 10);
    const r = await timed('/api/events?from=' + d + '&days=' + (offset === 90 ? 14 : 1));
    assert.equal(r.status, 200);
    assert.equal(r.body.building, false);
    worst = Math.max(worst, r.ms);
  }
  console.log(`# worst ranged /api/events after expansion: ${Math.round(worst)} ms`);
  assert.ok(worst < 300);

  // The default window also names the first event after it, for the agenda's "next day" line.
  const def = (await timed('/api/events')).body;
  const lastStart = Math.max(...def.events.map((e) => e.start));
  assert.ok(def.following && def.following.start > lastStart, 'following is after the default window');
  assert.ok(def.following.start - lastStart < 2 * D);
});
