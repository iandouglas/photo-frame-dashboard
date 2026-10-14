import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendars } from '../src/config.js';

const SECRET = 'https://calendar.google.com/calendar/ical/x/private-SECRETVALUE/basic.ics';

test('valid calendars get defaults', () => {
  const [c] = parseCalendars(JSON.stringify([{ id: 'work', url: SECRET, alert: true }]));
  assert.equal(c.name, 'work');
  assert.match(c.color, /^#[0-9A-F]{6}$/i);
  assert.equal(c.alert, true);
  assert.equal(c.busyOnly, false);
});

test('bad input is rejected without echoing the secret URL', () => {
  const cases = [
    '[{"id":"work","url":"' + SECRET + '"',                      // broken JSON
    JSON.stringify([{ id: 'Work!', url: SECRET }]),                // bad id
    JSON.stringify([{ id: 'a', url: SECRET }, { id: 'a', url: SECRET }]),
    JSON.stringify([{ id: 'a', url: SECRET.replace('https', 'http') }]),
    JSON.stringify([{ id: 'a', url: SECRET, color: 'red' }]),
    JSON.stringify([{ id: 'a', url: SECRET, exclude: ['('] }]),
  ];
  for (const input of cases) {
    assert.throws(() => parseCalendars(input), (err) => {
      assert.ok(!String(err.message).includes('SECRETVALUE'), err.message);
      return true;
    });
  }
});

test('file URLs need the explicit test switch', () => {
  const input = JSON.stringify([{ id: 'a', url: 'file:///x.ics' }]);
  assert.throws(() => parseCalendars(input));
  process.env.ALLOW_FILE_FEEDS = '1';
  try {
    assert.equal(parseCalendars(input)[0].url, 'file:///x.ics');
  } finally {
    delete process.env.ALLOW_FILE_FEEDS;
  }
});
