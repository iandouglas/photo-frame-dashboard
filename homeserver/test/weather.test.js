import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecastUrl, groupHours, mapForecast } from '../src/weather.js';

const cfg = { lat: 40.7128, lon: -74.006, tz: 'America/New_York', units: 'imperial', locationName: 'Test' };

/** Hourly times for a local day, as Open-Meteo returns them (wall clock, no offset). */
function hoursOf(date, hours) {
  const out = [];
  for (const h of hours) out.push(date + 'T' + String(h).padStart(2, '0') + ':00');
  return out;
}

test('forecast URL asks for hourly data in the configured zone', () => {
  const u = new URL(forecastUrl(cfg));
  assert.equal(u.searchParams.get('hourly'), 'temperature_2m,weather_code,precipitation_probability,is_day');
  assert.equal(u.searchParams.get('timezone'), 'America/New_York');
  assert.equal(u.searchParams.get('forecast_days'), '10');
});

test('hourly rows are grouped by local date, including DST days', () => {
  const all = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  // Spring-forward day: no 02:00. Fall-back day: 01:00 twice.
  const spring = all.filter((h) => h !== 2);
  const fall = [0, 1, 1, ...all.slice(2)];
  const time = [...hoursOf('2026-03-08', spring), ...hoursOf('2026-11-01', fall)];
  const n = time.length;
  const g = groupHours({
    time,
    temperature_2m: Array.from({ length: n }, (_, i) => i + 0.4),
    weather_code: Array.from({ length: n }, () => 0),
    precipitation_probability: Array.from({ length: n }, () => 10),
    is_day: Array.from({ length: n }, (_, i) => (i % 24 < 6 ? 0 : 1)),
  });
  assert.deepEqual(Object.keys(g), ['2026-03-08', '2026-11-01']);
  assert.equal(g['2026-03-08'].length, 23);
  assert.equal(g['2026-11-01'].length, 25);
  assert.deepEqual(g['2026-03-08'][0], { t: '00:00', temp: 0, pop: 10, icon: 'moon' });
  assert.equal(g['2026-03-08'][2].t, '03:00');
  assert.equal(g['2026-03-08'][10].icon, 'sun');
});

test('mapForecast attaches hours per day; a day without hourly data gets an empty list', () => {
  const raw = {
    current: { temperature_2m: 50, weather_code: 3, is_day: 1 },
    daily: {
      time: ['2026-10-14', '2026-10-15'],
      temperature_2m_max: [60, 61],
      temperature_2m_min: [40, 41],
      weather_code: [3, 61],
      sunrise: ['2026-10-14T07:10', '2026-10-15T07:11'],
      sunset: ['2026-10-14T18:22', '2026-10-15T18:21'],
    },
    hourly: {
      time: ['2026-10-14T22:00', '2026-10-14T23:00', '2026-10-16T00:00'],
      temperature_2m: [45.6, 44.2, 43],
      weather_code: [61, 2, 0],
      precipitation_probability: [80, 20, 0],
      is_day: [0, 0, 0],
    },
  };
  const w = mapForecast(raw, cfg);
  assert.deepEqual(w.days[0].hours, [
    { t: '22:00', temp: 46, pop: 80, icon: 'rain' },
    { t: '23:00', temp: 44, pop: 20, icon: 'partly-night' },
  ]);
  assert.deepEqual(w.days[1].hours, []);
  // Hours for dates outside the daily list are not sent to the frame.
  assert.equal(JSON.stringify(w).indexOf('2026-10-16'), -1);
});

test('mapForecast works without any hourly block', () => {
  const w = mapForecast({ daily: { time: ['2026-10-14'] } }, cfg);
  assert.deepEqual(w.days[0].hours, []);
});
