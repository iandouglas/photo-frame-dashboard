// Configuration from the environment. Calendar URLs are secrets: they are validated here
// and never logged, returned by the API, or included in error messages.
import { readFileSync } from 'node:fs';
import { isValidZone } from './tz.js';
import { parseNewsFeeds } from './news.js';
import { parsePushCalendars } from './push.js';

const DEFAULT_COLORS = ['#3B6FD8', '#00A36C', '#C2410C', '#7C3AED', '#DB2777', '#0E7490'];

function num(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return n;
}

export function parseCalendars(json) {
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    // Do not echo the input: it holds the secret URLs.
    throw new Error('CALENDARS is not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('CALENDARS must be a JSON array');
  const ids = new Set();
  return list.map((c, i) => {
    const where = `CALENDARS[${i}]`;
    if (!c || typeof c !== 'object') throw new Error(`${where} must be an object`);
    if (typeof c.id !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(c.id)) {
      throw new Error(`${where}.id must be 1-32 chars of a-z, 0-9, _ or -`);
    }
    if (ids.has(c.id)) throw new Error(`${where}.id "${c.id}" is used twice`);
    ids.add(c.id);
    let url;
    try {
      url = new URL(c.url);
    } catch {
      throw new Error(`${where} (${c.id}) has no valid url`);
    }
    const fileOk = url.protocol === 'file:' && process.env.ALLOW_FILE_FEEDS === '1'; // local testing only
    if (url.protocol !== 'https:' && !fileOk) throw new Error(`${where} (${c.id}) url must be https`);
    const color = c.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length];
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`${where} (${c.id}) color must be #rrggbb`);
    const exclude = c.exclude || [];
    if (!Array.isArray(exclude)) throw new Error(`${where} (${c.id}) exclude must be an array`);
    for (const pattern of exclude) new RegExp(pattern, 'i'); // throws on a bad pattern
    return {
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : c.id,
      url: url.toString(),
      color,
      alert: !!c.alert,
      busyOnly: !!c.busyOnly,
      email: typeof c.email === 'string' ? c.email : null,
      exclude,
    };
  });
}

/**
 * Overnight screen-off window, local "HH:MM" times. Both unset = no schedule; a window may cross
 * midnight (22:30 to 06:30). wakeMin: how long a touch keeps the screen on during the window.
 */
export function parseScreen(from, to, wake) {
  const hhmm = (name, v) => {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v).trim());
    if (!m) throw new Error(`${name} must be HH:MM (24-hour), e.g. 22:30`);
    return m[1] + ':' + m[2];
  };
  const wakeMin = wake == null || wake === '' ? 2 : Number(wake);
  if (!Number.isFinite(wakeMin) || wakeMin < 1 || wakeMin > 120) throw new Error('WAKE_MINUTES must be a number from 1 to 120');
  const hasFrom = from != null && from !== '', hasTo = to != null && to !== '';
  if (hasFrom !== hasTo) throw new Error('Set both SCREEN_OFF_FROM and SCREEN_OFF_TO, or neither');
  if (!hasFrom) return { from: null, to: null, wakeMin };
  const f = hhmm('SCREEN_OFF_FROM', from), t = hhmm('SCREEN_OFF_TO', to);
  if (f === t) throw new Error('SCREEN_OFF_FROM and SCREEN_OFF_TO must differ');
  return { from: f, to: t, wakeMin };
}

/** Optional plain-text card. Unset URL = card hidden. */
export function parseTextFeed(url, title) {
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('TEXT_FEED_URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('TEXT_FEED_URL must be http or https');
  return { url: u.toString(), title: String(title || '').slice(0, 40) };
}

export function loadConfig() {
  const tz = process.env.TZ || 'UTC';
  if (!isValidZone(tz)) throw new Error(`TZ "${tz}" is not a known time zone`);

  let calendarsJson = process.env.CALENDARS || '[]';
  if (process.env.CALENDARS_FILE) calendarsJson = readFileSync(process.env.CALENDARS_FILE, 'utf8');

  const calendars = parseCalendars(calendarsJson);

  const units = process.env.UNITS || 'imperial';
  if (units !== 'imperial' && units !== 'metric') throw new Error('UNITS must be imperial or metric');

  return {
    port: num('PORT', 8080, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    tz,
    // No default location: set LAT/LON (and LOCATION_NAME) in the stack's environment.
    lat: num('LAT', null, -90, 90),
    lon: num('LON', null, -180, 180),
    locationName: process.env.LOCATION_NAME || '',
    units,
    calendars,
    // Calendars pushed by a laptop (homeserver/push-macos); ids share one namespace with CALENDARS.
    pushCalendars: parsePushCalendars(process.env.PUSH_CALENDARS, calendars.map((c) => c.id)),
    pushStaleMinutes: num('PUSH_STALE_MINUTES', 60, 5, 10080),
    refreshMinutes: num('REFRESH_MINUTES', 5, 1, 1440),
    eventsDays: num('EVENTS_DAYS', 14, 1, 60),
    weatherMinutes: num('WEATHER_MINUTES', 15, 5, 1440),
    alert: {
      leadMin: num('ALERT_LEAD_MIN', 2, 0, 120),
      countdownMin: num('ALERT_COUNTDOWN_MIN', 15, 0, 240),
      graceMin: num('ALERT_GRACE_MIN', 10, 0, 120),
    },
    stateFile: process.env.STATE_FILE || './data/state.json',
    writeToken: process.env.WRITE_TOKEN || '',
    textFeed: parseTextFeed(process.env.TEXT_FEED_URL, process.env.TEXT_FEED_TITLE),
    newsFeeds: parseNewsFeeds(process.env.NEWS_FEEDS),
    newsMinutes: num('NEWS_MINUTES', 10, 5, 1440),
    screen: parseScreen(process.env.SCREEN_OFF_FROM, process.env.SCREEN_OFF_TO, process.env.WAKE_MINUTES),
  };
}
