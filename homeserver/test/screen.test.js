import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseScreen } from '../src/config.js';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/logic.js', import.meta.url), 'utf8'), sandbox);
const L = sandbox.window.Logic;
const at = (hhmm) => L.hhmmToMin(hhmm);

test('hhmmToMin', () => {
  assert.equal(at('00:00'), 0);
  assert.equal(at('22:30'), 1350);
  assert.equal(at('7:05'), 425);
  assert.equal(at('24:00'), null);
  assert.equal(at(''), null);
  assert.equal(at(null), null);
});

test('window inside one day', () => {
  const f = at('01:00'), t = at('05:00');
  assert.equal(L.inWindow(at('00:59'), f, t), false);
  assert.equal(L.inWindow(at('01:00'), f, t), true);
  assert.equal(L.inWindow(at('04:59'), f, t), true);
  assert.equal(L.inWindow(at('05:00'), f, t), false);
});

test('window crossing midnight', () => {
  const f = at('22:30'), t = at('06:30');
  for (const m of ['22:30', '23:59', '00:00', '03:00', '06:29']) assert.equal(L.inWindow(at(m), f, t), true, m);
  for (const m of ['22:29', '06:30', '12:00', '18:00']) assert.equal(L.inWindow(at(m), f, t), false, m);
});

test('no schedule or an empty window is never "off"', () => {
  assert.equal(L.inWindow(at('03:00'), null, null), false);
  assert.equal(L.inWindow(at('03:00'), at('03:00'), at('03:00')), false);
});

const NOW = 1_000_000_000_000;
const night = { from: '22:30', to: '06:30', wakeMin: 2 };
const base = { minuteOfDay: at('02:00'), screen: night, now: NOW, wakeUntil: 0, flashing: false, manualOff: false };
const want = (o) => L.screenWanted(Object.assign({}, base, o));

test('screen is off inside the window and on outside it', () => {
  assert.equal(want({}), 'off');
  assert.equal(want({ minuteOfDay: at('12:00') }), 'on');
  assert.equal(want({ screen: { from: null, to: null, wakeMin: 2 } }), 'on');
  assert.equal(want({ screen: null }), 'on');
});

test('a wake touch keeps it on until wakeUntil, then off again', () => {
  assert.equal(want({ wakeUntil: NOW + 60000 }), 'on');
  assert.equal(want({ wakeUntil: NOW }), 'off');
  assert.equal(want({ wakeUntil: NOW - 1 }), 'off');
});

test('a flashing alert overrides the schedule and the moon button', () => {
  assert.equal(want({ flashing: true }), 'on');
  assert.equal(want({ flashing: true, manualOff: true }), 'on');
  // After ACK: not flashing; the schedule applies again once the wake time has passed.
  assert.equal(want({ flashing: false, wakeUntil: NOW + 120000 }), 'on');
  assert.equal(want({ flashing: false, wakeUntil: NOW - 1 }), 'off');
});

test('the moon button turns it off at any time of day', () => {
  assert.equal(want({ minuteOfDay: at('12:00'), manualOff: true }), 'off');
  assert.equal(want({ manualOff: true, wakeUntil: NOW + 60000 }), 'off');
});

test('SCREEN_OFF_* and WAKE_MINUTES config', () => {
  assert.deepEqual(parseScreen('22:30', '06:30', ''), { from: '22:30', to: '06:30', wakeMin: 2 });
  assert.deepEqual(parseScreen(undefined, undefined, undefined), { from: null, to: null, wakeMin: 2 });
  assert.deepEqual(parseScreen('01:00', '05:00', '5'), { from: '01:00', to: '05:00', wakeMin: 5 });
  for (const [f, t, w] of [['22:30', '', ''], ['', '06:30', ''], ['24:00', '06:00', ''], ['7:00', '08:00', ''],
    ['22:30', '22:30', ''], ['22:30', '06:30', '0'], ['22:30', '06:30', 'x']]) {
    assert.throws(() => parseScreen(f, t, w), Error, `${f} ${t} ${w}`);
  }
});
