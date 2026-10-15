import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRange, expansionWindow, RANGE } from '../src/range.js';
import { parseFeed, expandParsed, expandFeed } from '../src/calendar.js';

const TZ = 'America/Edmonton';
const NOW = Date.parse('2026-10-14T18:00:00Z'); // Wed 14 Oct, noon MDT
const q = (s) => new URLSearchParams(s);
const iso = (ms) => new Date(ms).toISOString();

test('no from/days keeps the default window', () => {
  assert.equal(parseRange(q(''), NOW, TZ, 14), null);
  assert.equal(parseRange(q('token=x'), NOW, TZ, 14), null);
});

test('a requested day is local midnight to local midnight', () => {
  const r = parseRange(q('from=2026-10-20&days=1'), NOW, TZ, 14);
  assert.equal(r.fromDate, '2026-10-20');
  assert.equal(r.days, 1);
  assert.equal(iso(r.from), '2026-10-20T06:00:00.000Z');
  assert.equal(iso(r.to), '2026-10-21T06:00:00.000Z');
});

test('ranges across the DST change end at local midnight', () => {
  const r = parseRange(q('from=2026-10-31&days=2'), NOW, TZ, 14);
  assert.equal(iso(r.from), '2026-10-31T06:00:00.000Z'); // MDT
  assert.equal(iso(r.to), '2026-11-02T07:00:00.000Z'); // MST
});

test('days alone starts today; from alone uses the default length', () => {
  assert.equal(parseRange(q('days=3'), NOW, TZ, 14).fromDate, '2026-10-14');
  assert.equal(parseRange(q('from=2026-10-15'), NOW, TZ, 14).days, 14);
  assert.equal(parseRange(q('from=2026-10-15'), NOW, TZ, 30).days, 14); // capped
});

test('bounds: -30..+90 days from today, 1..14 days long', () => {
  assert.ok(parseRange(q('from=2026-09-14'), NOW, TZ, 7)); // -30
  assert.ok(parseRange(q('from=2027-01-12'), NOW, TZ, 7)); // +90
  for (const bad of ['from=2026-09-13', 'from=2027-01-13', 'days=0', 'days=15', 'days=-1', 'days=1.5',
    'from=2026-10-32', 'from=2026-02-30', 'from=20261014', 'from=2026-1-4', 'from=']) {
    assert.throws(() => parseRange(q(bad), NOW, TZ, 7), (e) => e.status === 400, bad);
  }
});

test('one parsed feed expands into any later range (recurrences beyond the default window)', () => {
  const work = readFileSync(new URL('./fixtures/work.ics', import.meta.url), 'utf8');
  const parsed = parseFeed(work);
  const cal = { id: 'work' };
  const standups = (from, to) => expandParsed(parsed, cal, from, to, TZ).filter((e) => e.uid === 'standup-1@example.test');

  const dec = parseRange(q('from=2026-12-07&days=7'), NOW, TZ, 14); // Mon 7 Dec, ~8 weeks out
  const decList = standups(dec.from, dec.to);
  assert.deepEqual(decList.map((e) => iso(e.start)), [
    '2026-12-07T16:30:00.000Z', '2026-12-09T16:30:00.000Z', '2026-12-11T16:30:00.000Z', // 09:30 MST
  ]);

  // The same parsed object still expands the default window, and matches a fresh parse.
  const oct = parseRange(q('from=2026-10-12&days=14'), NOW, TZ, 14);
  assert.deepEqual(standups(oct.from, oct.to), expandFeed(work, cal, oct.from, oct.to, TZ).filter((e) => e.uid === 'standup-1@example.test'));

  // A past day within the bounds.
  const past = parseRange(q('from=2026-10-05&days=1'), NOW, TZ, 14);
  assert.equal(standups(past.from, past.to).length, 1);
});

test('the expansion window covers every range the agenda can ask for, and moves at midnight', () => {
  const w = expansionWindow(NOW, TZ, 14);
  assert.equal(w.day, '2026-10-14');
  assert.equal(new Date(w.from).toISOString(), '2026-09-14T06:00:00.000Z'); // 30 days back, local midnight
  assert.equal(new Date(w.to).toISOString(), '2027-01-26T07:00:00.000Z'); // +90 +14 days, MST by then
  const q = (s) => new URLSearchParams(s);
  for (const [from, days] of [['2026-09-14', 1], ['2027-01-12', RANGE.maxDays], ['2026-10-14', 14]]) {
    const r = parseRange(q('from=' + from + '&days=' + days), NOW, TZ, 14);
    assert.ok(r.from >= w.from && r.to <= w.to, from);
  }
  assert.equal(expansionWindow(NOW, TZ, 60).to, w.to, 'the longest default window fits too');
  const late = Date.parse('2026-10-15T05:59:00Z'), next = Date.parse('2026-10-15T06:00:00Z');
  assert.equal(expansionWindow(late, TZ, 14).day, '2026-10-14');
  assert.equal(expansionWindow(next, TZ, 14).day, '2026-10-15');
});
