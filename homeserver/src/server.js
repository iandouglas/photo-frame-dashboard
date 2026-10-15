// LAN dashboard server: serves the frame UI and a small JSON API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { loadConfig } from './config.js';
import { expandFeed, mergeEvents, publicCalendars } from './calendar.js';
import { forecastUrl, mapForecast } from './weather.js';
import { createTextFeed } from './textfeed.js';
import { StateStore } from './state.js';
import { offsetTable, startOfLocalDay } from './tz.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const FETCH_TIMEOUT = 20000;
const MAX_BODY = 16384;

const cfg = loadConfig();
const store = new StateStore(cfg.stateFile);

function log(event, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

// ------------------------------------------------------------ calendars

const feeds = new Map(); // id -> { text, okAt, error }
let events = [];
let eventsWindow = null;

async function fetchText(url) {
  if (url.startsWith('file:') && process.env.ALLOW_FILE_FEEDS === '1') {
    return readFileSync(fileURLToPath(url), 'utf8');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { 'user-agent': 'frame-homeserver' } });
  if (!res.ok) {
    const err = new Error('HTTP ' + res.status);
    err.code = 'HTTP_' + res.status;
    throw err;
  }
  return res.text();
}

/** A short, URL-free description of a fetch failure. */
function errorCode(err) {
  if (err && err.code && /^[A-Z0-9_]+$/.test(err.code)) return err.code;
  if (err && err.name === 'TimeoutError') return 'TIMEOUT';
  if (err && err.cause && err.cause.code && /^[A-Z0-9_]+$/.test(err.cause.code)) return err.cause.code;
  return 'FETCH_FAILED';
}

function rebuildEvents() {
  const now = Date.now();
  const from = startOfLocalDay(now, cfg.tz);
  const to = from + cfg.eventsDays * 86400000;
  const lists = [];
  for (const cal of cfg.calendars) {
    const feed = feeds.get(cal.id);
    if (!feed || !feed.text) continue;
    try {
      lists.push(expandFeed(feed.text, cal, from, to, cfg.tz));
      feed.parseError = null;
    } catch (err) {
      feed.parseError = 'PARSE_FAILED';
      log('calendar_parse_failed', { cal: cal.id, message: String(err && err.message).slice(0, 120) });
    }
  }
  events = mergeEvents(lists);
  eventsWindow = { from, to, builtAt: now };
}

async function refreshCalendars() {
  await Promise.all(cfg.calendars.map(async (cal) => {
    const feed = feeds.get(cal.id) || {};
    try {
      feed.text = await fetchText(cal.url);
      feed.okAt = Date.now();
      feed.error = null;
    } catch (err) {
      feed.error = errorCode(err);
      log('calendar_fetch_failed', { cal: cal.id, code: feed.error });
    }
    feeds.set(cal.id, feed);
  }));
  rebuildEvents();
  log('calendars_refreshed', { calendars: cfg.calendars.length, events: events.length });
}

function calendarStatus() {
  return cfg.calendars.map((c) => {
    const f = feeds.get(c.id) || {};
    return { id: c.id, okAt: f.okAt || null, error: f.parseError || f.error || null };
  });
}

// ------------------------------------------------------------ weather

let weather = null;
let weatherAt = 0;
let weatherError = null;

async function refreshWeather() {
  if (cfg.lat == null || cfg.lon == null) {
    weatherError = 'NO_LOCATION';
    return;
  }
  try {
    const res = await fetch(forecastUrl(cfg), { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'HTTP_' + res.status });
    weather = mapForecast(await res.json(), cfg);
    weatherAt = Date.now();
    weatherError = null;
  } catch (err) {
    weatherError = errorCode(err);
    log('weather_failed', { code: weatherError });
  }
}

// ------------------------------------------------------------ text feed

const textFeed = cfg.textFeed ? createTextFeed({ url: cfg.textFeed.url }) : null;

// ------------------------------------------------------------ http

function send(res, status, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': type || 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function authorised(req, url) {
  if (!cfg.writeToken) return true;
  const given = String(req.headers['x-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(given);
  const b = Buffer.from(cfg.writeToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

function timeInfo(now, from, to) {
  return { now, tz: cfg.tz, offsets: offsetTable(from, to, cfg.tz) };
}

function stateBody(now) {
  const s = store.get();
  return { now, pomodoro: s.pomodoro, acks: s.acks };
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC, rel));
  const type = TYPES[extname(file)];
  if (!file.startsWith(PUBLIC + '/') || !type) return send(res, 404, { error: 'not found' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const now = Date.now();
  const path = url.pathname;

  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

  if (req.method === 'GET' && path === '/api/events') {
    if (!eventsWindow || startOfLocalDay(now, cfg.tz) !== eventsWindow.from) rebuildEvents();
    return send(res, 200, {
      ...timeInfo(now, eventsWindow.from - 86400000, eventsWindow.to + 86400000),
      calendars: publicCalendars(cfg.calendars),
      status: calendarStatus(),
      alert: cfg.alert,
      events,
    });
  }

  if (req.method === 'GET' && path === '/api/weather') {
    if (!weather || now - weatherAt > cfg.weatherMinutes * 60000) await refreshWeather();
    if (!weather) return send(res, 502, { error: weatherError || 'unavailable' });
    return send(res, 200, { fetchedAt: weatherAt, stale: !!weatherError, ...weather });
  }

  if (req.method === 'GET' && path === '/api/state') return send(res, 200, stateBody(now));

  if (req.method === 'GET' && path === '/api/text') {
    if (!textFeed) return send(res, 404, { error: 'NOT_CONFIGURED' });
    const r = await textFeed.get();
    if (r.error) {
      log('text_feed_failed', { code: r.error });
      return send(res, 502, { error: r.error, title: cfg.textFeed.title });
    }
    return send(res, 200, { ...r, title: cfg.textFeed.title });
  }

  if (req.method === 'POST' && path.startsWith('/api/')) {
    if (!authorised(req, url)) return send(res, 401, { error: 'token required' });
    const body = await readBody(req);
    if (path === '/api/ack') store.ack(body.key, now);
    else if (path === '/api/unack') store.unack(String(body.key));
    else if (path === '/api/pomodoro') store.setPomodoro(body);
    else return send(res, 404, { error: 'not found' });
    return send(res, 200, stateBody(now));
  }

  if (req.method === 'GET' && !path.startsWith('/api/')) return serveStatic(res, path);
  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err && err.status ? err.status : 400;
    send(res, status, { error: String(err && err.message).slice(0, 100) });
  });
});

server.listen(cfg.port, cfg.host, () => {
  log('listening', { host: cfg.host, port: cfg.port, tz: cfg.tz, calendars: cfg.calendars.map((c) => c.id), textFeed: !!textFeed });
});

refreshCalendars();
setInterval(refreshCalendars, cfg.refreshMinutes * 60000).unref();
refreshWeather();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
