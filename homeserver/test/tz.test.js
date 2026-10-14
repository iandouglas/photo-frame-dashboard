import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetAt, wallToUtc, offsetTable, startOfLocalDay, localDate } from '../src/tz.js';

const TZ = 'America/Edmonton';
const iso = (ms) => new Date(ms).toISOString();

test('offsets in summer and winter', () => {
  assert.equal(offsetAt(Date.parse('2026-07-01T12:00:00Z'), TZ), -360);
  assert.equal(offsetAt(Date.parse('2026-12-01T12:00:00Z'), TZ), -420);
});

test('wall time to UTC, including the DST gap and overlap', () => {
  assert.equal(iso(wallToUtc(2026, 10, 14, 9, 30, 0, TZ)), '2026-10-14T15:30:00.000Z');
  // 2026-03-08 02:30 does not exist in Edmonton; it resolves forward to 03:30 MDT.
  assert.equal(iso(wallToUtc(2026, 3, 8, 2, 30, 0, TZ)), '2026-03-08T09:30:00.000Z');
  // 2026-11-01 01:30 happens twice; the first (MDT) wins.
  assert.equal(iso(wallToUtc(2026, 11, 1, 1, 30, 0, TZ)), '2026-11-01T07:30:00.000Z');
});

test('offset table records the DST transition to the minute', () => {
  const from = Date.parse('2026-10-25T00:00:00Z');
  const t = offsetTable(from, Date.parse('2026-11-08T00:00:00Z'), TZ);
  assert.deepEqual(t, [[from, -360], [Date.parse('2026-11-01T08:00:00Z'), -420]]);
});

test('local day helpers', () => {
  const ms = Date.parse('2026-10-15T05:00:00Z'); // 23:00 on the 14th in Edmonton
  assert.equal(localDate(ms, TZ), '2026-10-14');
  assert.equal(iso(startOfLocalDay(ms, TZ)), '2026-10-14T06:00:00.000Z');
});
