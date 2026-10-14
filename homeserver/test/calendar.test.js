import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expandFeed, mergeEvents, publicCalendars } from '../src/calendar.js';

const TZ = 'America/Edmonton';
const work = readFileSync(new URL('./fixtures/work.ics', import.meta.url), 'utf8');
const home = readFileSync(new URL('./fixtures/home.ics', import.meta.url), 'utf8');
const FROM = Date.parse('2026-10-12T06:00:00Z'); // Mon 12 Oct 00:00 MDT
const TO = FROM + 14 * 86400000;
const iso = (ms) => new Date(ms).toISOString();

const workCal = { id: 'work', email: 'me@example.test' };
const homeCal = { id: 'home' };

test('weekly recurrence honours EXDATE, moved and cancelled exceptions', () => {
  const evs = expandFeed(work, workCal, FROM, TO, TZ).filter((e) => e.uid === 'standup-1@example.test');
  assert.deepEqual(evs.map((e) => [iso(e.start), e.title]).sort(), [
    ['2026-10-12T15:30:00.000Z', 'Team standup'],
    ['2026-10-14T16:00:00.000Z', 'Team standup (moved)'], // moved from 09:30 to 10:00
    // 16 Oct: EXDATE. 19 Oct: STATUS:CANCELLED exception.
    ['2026-10-21T15:30:00.000Z', 'Team standup'],
    ['2026-10-23T15:30:00.000Z', 'Team standup'],
  ]);
  assert.equal(evs[0].end - evs[0].start, 15 * 60000);
});

test('cancelled events are dropped', () => {
  const evs = expandFeed(work, workCal, FROM, TO, TZ);
  assert.ok(!evs.some((e) => e.uid === 'cancelled-1@example.test'));
});

test('events the configured attendee declined are dropped, and kept without an email', () => {
  assert.ok(!expandFeed(work, workCal, FROM, TO, TZ).some((e) => e.uid === 'declined-1@example.test'));
  assert.ok(expandFeed(work, { id: 'work' }, FROM, TO, TZ).some((e) => e.uid === 'declined-1@example.test'));
});

test('exclude patterns and busyOnly curate titles', () => {
  const ex = expandFeed(work, { id: 'work', exclude: ['\\(private\\)'] }, FROM, TO, TZ);
  assert.ok(!ex.some((e) => e.uid === 'private-1@example.test'));
  const busy = expandFeed(work, { id: 'work', busyOnly: true }, FROM, TO, TZ);
  assert.ok(busy.length > 0);
  assert.ok(busy.every((e) => e.title === 'Busy' && !('location' in e)));
});

test('daily recurrence keeps wall-clock time across the DST change', () => {
  const to = Date.parse('2026-11-05T07:00:00Z');
  const evs = expandFeed(work, workCal, FROM, to, TZ).filter((e) => e.uid === 'dst-daily@example.test');
  assert.equal(evs.length, 6);
  assert.deepEqual(evs.slice(2, 4).map((e) => iso(e.start)), [
    '2026-10-31T14:00:00.000Z', // 08:00 MDT
    '2026-11-01T15:00:00.000Z', // 08:00 MST
  ]);
});

test('all-day events carry local dates and local-midnight instants', () => {
  const ev = expandFeed(home, homeCal, FROM, TO, TZ).find((e) => e.uid === 'allday-1@example.test');
  assert.equal(ev.allDay, true);
  assert.equal(ev.startDate, '2026-10-17');
  assert.equal(ev.endDate, '2026-10-18');
  assert.equal(iso(ev.start), '2026-10-17T06:00:00.000Z');
  assert.equal(iso(ev.end), '2026-10-18T06:00:00.000Z');
});

test('a TZID without a VTIMEZONE is resolved through the system zone database', () => {
  const ev = expandFeed(home, homeCal, FROM, TO, TZ).find((e) => e.uid === 'no-vtimezone@example.test');
  assert.equal(iso(ev.start), '2026-10-18T16:00:00.000Z'); // 12:00 EDT
});

test('events outside the window are excluded', () => {
  assert.ok(!expandFeed(home, homeCal, FROM, TO, TZ).some((e) => e.uid === 'outside-window@example.test'));
});

test('merge sorts, and folds one meeting on two calendars into one entry', () => {
  const merged = mergeEvents([expandFeed(work, workCal, FROM, TO, TZ), expandFeed(home, homeCal, FROM, TO, TZ)]);
  const shared = merged.filter((e) => e.uid === 'shared-1@example.test');
  assert.equal(shared.length, 1);
  assert.equal(shared[0].cal, 'work');
  assert.deepEqual(shared[0].also, ['home']);
  assert.equal(shared[0].location, 'https://meet.example.test/abc');
  for (let i = 1; i < merged.length; i++) assert.ok(merged[i - 1].start <= merged[i].start);
  assert.ok(merged.filter((e) => !e.also).every((e) => !('also' in e)));
});

test('public calendar metadata never includes the feed URL', () => {
  const out = publicCalendars([{ id: 'work', name: 'Work', url: 'https://secret.example/ical/x/basic.ics', color: '#112233', alert: true }]);
  assert.deepEqual(out, [{ id: 'work', name: 'Work', color: '#112233', alert: true }]);
  assert.ok(!JSON.stringify(out).includes('secret'));
});
