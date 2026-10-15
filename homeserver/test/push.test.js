import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  parsePushCalendars, tokenMatches, validatePushPayload, pushedEventsBetween, pushStatus, PushStore, LIMITS,
} from '../src/push.js';

const TZ = 'America/Edmonton';
const NOW = Date.parse('2026-10-14T18:00:00Z');
const TOKEN = 'a'.repeat(20) + 'TOKEN-1234';
const H = 3600000;

test('PUSH_CALENDARS config', () => {
  const [c] = parsePushCalendars(JSON.stringify([{ id: 'work', name: 'Work', token: TOKEN, alert: true }]));
  assert.equal(c.id, 'work');
  assert.equal(c.alert, true);
  assert.match(c.color, /^#[0-9A-F]{6}$/i);
  assert.deepEqual(parsePushCalendars(''), []);
  assert.deepEqual(parsePushCalendars(undefined), []);
  const bad = [
    '{', '{}', JSON.stringify([{ id: 'Work', token: TOKEN }]), JSON.stringify([{ id: 'w', token: 'short' }]),
    JSON.stringify([{ id: 'w', token: TOKEN + ' x' }]), JSON.stringify([{ id: 'w', token: TOKEN, color: 'red' }]),
    JSON.stringify([{ id: 'w', token: TOKEN }, { id: 'w', token: TOKEN }]),
  ];
  for (const b of bad) {
    assert.throws(() => parsePushCalendars(b), (e) => !e.message.includes(TOKEN), b);
  }
  // Shares the id namespace with CALENDARS.
  assert.throws(() => parsePushCalendars(JSON.stringify([{ id: 'home', token: TOKEN }]), ['home']), /already used/);
});

test('bearer token check', () => {
  assert.equal(tokenMatches('Bearer ' + TOKEN, TOKEN), true);
  assert.equal(tokenMatches('Bearer ' + TOKEN + 'x', TOKEN), false);
  assert.equal(tokenMatches('bearer ' + TOKEN, TOKEN), false);
  assert.equal(tokenMatches(TOKEN, TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches('Bearer x', ''), false);
});

test('payload: timed and all-day events, only known fields kept', () => {
  const evs = validatePushPayload({
    events: [
      { uid: 'u1', title: ' Standup\n', start: NOW, end: NOW + H, attendees: ['x@y'], url: 'https://meet', location: 'Room 1' },
      { uid: 'u2', title: 'Offsite', allDay: true, startDate: '2026-10-20', endDate: '2026-10-22', notes: 'secret' },
      { uid: 'u3', title: '', start: NOW, end: NOW },
      { uid: 'u4', title: 'x'.repeat(500), start: NOW, end: NOW + H },
    ],
  }, TZ, NOW);
  assert.deepEqual(evs[0], { uid: 'u1', title: 'Standup', start: NOW, end: NOW + H, allDay: false });
  assert.deepEqual(evs[1], {
    uid: 'u2', title: 'Offsite', allDay: true, startDate: '2026-10-20', endDate: '2026-10-22',
    start: Date.parse('2026-10-20T06:00:00Z'), end: Date.parse('2026-10-22T06:00:00Z'),
  });
  assert.equal(evs[2].title, '(no title)');
  assert.equal(evs[3].title.length, LIMITS.maxTitle);
});

test('payload: rejects malformed and out-of-bounds input', () => {
  const one = (e) => () => validatePushPayload({ events: [e] }, TZ, NOW);
  const cases = [
    one({ title: 'no uid', start: NOW, end: NOW }),
    one({ uid: 'x'.repeat(301), title: 't', start: NOW, end: NOW }),
    one({ uid: 'u', title: 5, start: NOW, end: NOW }),
    one({ uid: 'u', title: 't', start: 'soon', end: NOW }),
    one({ uid: 'u', title: 't', start: NOW, end: NOW - 1 }),
    one({ uid: 'u', title: 't', start: NOW, end: NOW + 63 * 24 * H }),
    one({ uid: 'u', title: 't', start: NOW + 401 * 24 * H, end: NOW + 401 * 24 * H }),
    one({ uid: 'u', title: 't', start: NOW - 121 * 24 * H, end: NOW - 121 * 24 * H }),
    one({ uid: 'u', title: 't', allDay: true, startDate: '2026-02-30', endDate: '2026-03-01' }),
    one({ uid: 'u', title: 't', allDay: true, startDate: '2026-10-20' }),
    () => validatePushPayload({}, TZ, NOW),
    () => validatePushPayload({ events: 'x' }, TZ, NOW),
    () => validatePushPayload({ events: Array.from({ length: 501 }, (_, i) => ({ uid: 'u' + i, title: 't', start: NOW, end: NOW })) }, TZ, NOW),
  ];
  for (const c of cases) assert.throws(c, (e) => e.status === 400);
});

test('snapshot events in a range, and the status line', () => {
  const cal = { id: 'work' };
  const snap = { receivedAt: NOW, events: validatePushPayload({ events: [
    { uid: 'a', title: 'Today', start: NOW, end: NOW + H },
    { uid: 'b', title: 'Next week', start: NOW + 7 * 24 * H, end: NOW + 7 * 24 * H + H },
  ] }, TZ, NOW) };
  const today = pushedEventsBetween(snap, cal, NOW - 12 * H, NOW + 12 * H);
  assert.deepEqual(today.map((e) => [e.id, e.cal, e.title]), [['work:a:' + NOW, 'work', 'Today']]);
  assert.equal(pushedEventsBetween(null, cal, 0, NOW).length, 0);

  assert.deepEqual(pushStatus(cal, null, NOW, 60), { id: 'work', okAt: null, error: 'NO_PUSH_YET' });
  assert.deepEqual(pushStatus(cal, snap, NOW + 59 * 60000, 60), { id: 'work', okAt: NOW, error: null });
  assert.deepEqual(pushStatus(cal, snap, NOW + 61 * 60000, 60), { id: 'work', okAt: NOW, error: 'STALE' });
});

test('PushStore persists snapshots', () => {
  const dir = mkdtempSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'tmp-push-'));
  try {
    const cals = [{ id: 'work' }];
    new PushStore(dir, cals).put('work', [{ uid: 'a', title: 't', start: 1, end: 2, allDay: false }], NOW);
    const again = new PushStore(dir, cals);
    assert.equal(again.get('work').receivedAt, NOW);
    assert.equal(again.get('work').events.length, 1);
    assert.equal(again.get('nope'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ the HTTP route, on a real server

let proc, base, dataDir;
const PORT = 18000 + Math.floor(Math.random() * 2000);

before(async () => {
  dataDir = mkdtempSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'tmp-push-srv-'));
  proc = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PATH: process.env.PATH, PORT: String(PORT), HOST: '127.0.0.1', TZ,
      STATE_FILE: join(dataDir, 'state.json'),
      CALENDARS: '[]',
      PUSH_CALENDARS: JSON.stringify([{ id: 'work', name: 'Work', token: TOKEN, alert: true }]),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = 'http://127.0.0.1:' + PORT;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(base + '/healthz')).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  proc.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

const put = (path, body, token = TOKEN, headers = {}) => fetch(base + path, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('PUT /api/push: auth, validation, then merged into /api/events', async () => {
  const now = Date.now();
  const snapshot = { events: [
    { uid: 'w1', title: 'Design review', start: now + 2 * H, end: now + 3 * H, attendees: ['leak@example.test'] },
    { uid: 'w2', title: 'Far away', start: now + 30 * 24 * H, end: now + 30 * 24 * H + H },
  ] };

  assert.equal((await put('/api/push/work', snapshot, 'wrong-token-wrong-token-xx')).status, 401);
  assert.equal((await put('/api/push/nobody', snapshot)).status, 401);
  assert.equal((await fetch(base + '/api/push/work')).status, 405);
  assert.equal((await put('/api/push/work', { events: [{ uid: 'x', title: 't', start: 'bad', end: 1 }] })).status, 400);
  assert.equal((await put('/api/push/work', '{"events": [')).status, 400);
  assert.equal((await put('/api/push/work', 'x'.repeat(LIMITS.maxBody + 10))).status, 413);

  let ev = await (await fetch(base + '/api/events')).json();
  assert.deepEqual(ev.status.find((s) => s.id === 'work').error, 'NO_PUSH_YET');
  assert.ok(ev.calendars.some((c) => c.id === 'work' && c.alert === true));
  assert.ok(!JSON.stringify(ev).includes(TOKEN), 'token never leaves the server');

  const r = await put('/api/push/work', snapshot);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).events, 2);

  ev = await (await fetch(base + '/api/events')).json();
  const work = ev.events.filter((e) => e.cal === 'work');
  assert.deepEqual(work.map((e) => e.title), ['Design review']);
  assert.equal(ev.status.find((s) => s.id === 'work').error, null);
  assert.ok(!JSON.stringify(ev).includes('leak@example.test'), 'extra fields are dropped');

  // Date navigation reaches pushed events beyond the default window.
  const d = new Date(now + 30 * 24 * H);
  const from = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const ranged = await (await fetch(base + '/api/events?from=' + from + '&days=1')).json();
  assert.deepEqual(ranged.events.filter((e) => e.cal === 'work').map((e) => e.title), ['Far away']);

  // Persisted on the data volume.
  assert.equal(JSON.parse(readFileSync(join(dataDir, 'push-work.json'), 'utf8')).events.length, 2);
});
