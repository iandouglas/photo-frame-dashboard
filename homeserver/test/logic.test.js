import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Load the browser file exactly as the frame does.
const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/logic.js', import.meta.url), 'utf8'), sandbox);
const L = sandbox.window.Logic;

const MIN = 60000;
const T0 = Date.parse('2026-10-14T16:00:00Z');
const ev = (uid, startMin, cal, extra) => Object.assign({ uid, cal: cal || 'work', start: T0 + startMin * MIN, end: T0 + (startMin + 30) * MIN, allDay: false }, extra);
const cals = { work: true };
const opts = { leadMin: 2, countdownMin: 15, graceMin: 10 };
// alertState runs in another realm; compare plain values.
const plain = (o) => JSON.parse(JSON.stringify(o));

test('alert phases by time to start', () => {
  const evs = [ev('a', 60)];
  const at = (minBefore) => L.alertState(evs, cals, T0 + (60 - minBefore) * MIN, {}, opts).phase;
  assert.equal(at(30), 'upcoming');
  assert.equal(at(15), 'countdown');
  assert.equal(at(2.5), 'countdown');
  assert.equal(at(2), 'flash');
  assert.equal(at(0), 'flash');
  assert.equal(at(-9), 'flash'); // started 9 minutes ago, inside the grace period
  assert.equal(at(-10), 'none'); // grace over
});

test('ACK stops the flash, keyed by uid and start', () => {
  const e = ev('a', 1);
  const acks = {};
  acks[L.alertKey(e)] = T0;
  assert.equal(L.alertKey(e), 'a@' + e.start);
  assert.equal(L.alertState([e], cals, T0, acks, opts).phase, 'acked');
  // Same uid, different occurrence: still flashes.
  const nextWeek = ev('a', 1 + 7 * 24 * 60);
  assert.equal(L.alertState([nextWeek], cals, nextWeek.start - MIN, acks, opts).phase, 'flash');
});

test('an acknowledged meeting that has started yields to the next one', () => {
  const first = ev('first', -1);
  const second = ev('second', 1);
  const acks = {};
  acks[L.alertKey(first)] = T0;
  const s = plain(L.alertState([second, first], cals, T0, acks, opts));
  assert.equal(s.event.uid, 'second');
  assert.equal(s.phase, 'flash');
});

test('only opted-in calendars alert, including via a merged copy; all-day never alerts', () => {
  assert.equal(L.alertState([ev('h', 1, 'home')], cals, T0, {}, opts).phase, 'none');
  assert.equal(L.alertState([ev('h', 1, 'home', { also: ['work'] })], cals, T0, {}, opts).phase, 'flash');
  assert.equal(L.alertState([ev('d', 1, 'work', { allDay: true })], cals, T0, {}, opts).phase, 'none');
});

test('pomodoro: start, pause, resume, finish, next phase', () => {
  const s = { work: 25, short: 5, long: 15, longEvery: 2 };
  let run = L.pomodoroAction(null, s, T0, 'start');
  assert.equal(run.status, 'running');
  assert.equal(run.endsAt, T0 + 25 * MIN);

  run = L.pomodoroAction(run, s, T0 + 10 * MIN, 'pause');
  assert.equal(run.status, 'paused');
  assert.equal(run.remainingMs, 15 * MIN);

  run = L.pomodoroAction(run, s, T0 + 20 * MIN, 'start');
  assert.equal(run.endsAt, T0 + 35 * MIN);
  assert.equal(L.pomodoroView(run, s, T0 + 35 * MIN).status, 'finished');

  run = L.pomodoroAction(run, s, T0 + 36 * MIN, 'start'); // start the break
  assert.equal(run.phase, 'short');
  assert.equal(run.done, 1);
  assert.equal(run.endsAt, T0 + 41 * MIN);

  run = L.pomodoroAction(run, s, T0 + 41 * MIN, 'start'); // back to work
  assert.equal(run.phase, 'work');
  run = L.pomodoroAction(run, s, T0 + 66 * MIN, 'start'); // second work done -> long break
  assert.equal(run.phase, 'long');
  assert.equal(run.done, 2);

  assert.deepEqual(plain(L.pomodoroAction(run, s, T0, 'reset')), { status: 'idle', phase: 'work', endsAt: null, remainingMs: null, done: 0 });
});

test('pomodoro: skip moves to the next phase without running it', () => {
  const s = L.DEFAULT_SETTINGS;
  const run = L.pomodoroAction(null, s, T0, 'skip');
  assert.equal(run.status, 'idle');
  assert.equal(run.phase, 'short');
  assert.equal(L.pomodoroView(run, s, T0).remainingMs, 5 * MIN);
});

// ------------------------------------------------------------ agenda day view

test('agenda today: what is left of today, then the first event of the next day with any', () => {
  const H = 60 * MIN, DAY = 24 * H;
  const dayOf = (ms) => Math.floor(ms / DAY); // UTC days are fine for the logic
  const today = dayOf(T0), mid = today * DAY; // T0 is 16:00 UTC
  const e = (id, start, end, allDay) => ({ uid: id, cal: 'work', start, end, allDay: !!allDay });
  const ids = (l) => Array.from(l, (x) => x.uid); // arrays from the other realm, as plain ones
  const list = [
    e('ended', mid + 9 * H, mid + 10 * H),
    e('running', T0 - 30 * MIN, T0 + 30 * MIN),
    e('later', mid + 20 * H, mid + 21 * H),
    e('allday', mid, mid + DAY, true),
    e('trip', mid - DAY, mid + 2 * DAY, true), // multi-day, covers today
    e('overnight', mid - 2 * H, mid + 1 * H), // from yesterday, already over
    e('d3-late', mid + 3 * DAY + 15 * H, mid + 3 * DAY + 16 * H),
    e('d3-early', mid + 3 * DAY + 8 * H, mid + 3 * DAY + 9 * H),
    e('d5-allday', mid + 5 * DAY, mid + 6 * DAY, true),
  ];
  const v = L.agendaDay(list, today, today, T0, dayOf);
  assert.deepEqual(ids(v.allDay), ['trip', 'allday']);
  assert.deepEqual(ids(v.timed), ['running', 'later']);
  // The trip covers tomorrow too, but it started earlier: the next day is the first one on
  // which an event starts, and the part shows that day's earliest event.
  assert.equal(v.next.day, today + 3);
  assert.equal(v.next.event.uid, 'd3-early');

  // An all-day event comes first on its day.
  const withAllDay = list.concat([e('d3-allday', mid + 3 * DAY, mid + 4 * DAY, true)]);
  assert.equal(L.agendaDay(withAllDay, today, today, T0, dayOf).next.event.uid, 'd3-allday');

  // Nothing later in the list: no next part.
  assert.equal(L.agendaDay(list.slice(0, 6), today, today, T0, dayOf).next, null);
  // Once "running" ends it drops off (the UI re-renders every minute).
  assert.deepEqual(ids(L.agendaDay(list, today, today, T0 + 31 * MIN, dayOf).timed), ['later']);

  // Another day: everything on it, ended or not, and no next part.
  const past = L.agendaDay(list, today - 1, today, T0, dayOf);
  assert.deepEqual(ids(past.allDay), ['trip']);
  assert.deepEqual(ids(past.timed), ['overnight']);
  assert.equal(past.next, null);
  assert.deepEqual(ids(L.agendaDay(list, today + 3, today, T0, dayOf).timed), ['d3-early', 'd3-late']);
});
