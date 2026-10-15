// LAN dashboard server: serves the frame UI and a small JSON API.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { parseFeed, expandParsedAsync, mergeEvents, publicCalendars } from './calendar.js';
import { forecastUrl, mapForecast } from './weather.js';
import { createTextFeed } from './textfeed.js';
import { parseNews, mergeNews, fetchFeed } from './news.js';
import { parseRange, expansionWindow } from './range.js';
import { PushStore, validatePushPayload, pushedEventsBetween, pushStatus, tokenMatches, LIMITS as PUSH_LIMITS } from './push.js';
import { StateStore } from './state.js';
import { offsetTable, startOfLocalDay, localDate } from './tz.js';

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
const pushStore = new PushStore(dirname(cfg.stateFile), cfg.pushCalendars);
const allCalendars = cfg.calendars.concat(cfg.pushCalendars); // for the client: ids, names, colours, alert

function log(event, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

// ------------------------------------------------------------ calendars
//
// Each refresh fetches and parses every feed, then expands each calendar ONCE over the whole
// navigable window (range.js expansionWindow), cooperatively, so the event loop keeps serving
// requests. Requests only filter those cached expansions; they never expand anything.

const feeds = new Map(); // id -> { parsed, hash, okAt, error, parseError }
const expansions = new Map(); // id -> { parsed, from, to, list (sorted by start) }
let win = null; // { day, from, to }: the current expansion window
let expandGen = 0; // bumps when a newer expansion run supersedes the running one

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

function overlaps(e, from, to) {
  return !(e.end < from || (e.end === from && e.start < from) || e.start >= to);
}

/**
 * Events in [from, to) from the cached expansions, merged with pushed calendars.
 * building: some calendar has no expansion covering the range yet (first fetch or expansion
 * still running); the events that are ready are returned anyway.
 */
function eventsBetween(from, to) {
  const lists = [];
  let building = false;
  for (const cal of cfg.calendars) {
    const feed = feeds.get(cal.id);
    if (!feed) { building = true; continue; } // not fetched yet
    const exp = expansions.get(cal.id);
    if (feed.parsed && (!exp || exp.from > from || exp.to < to)) building = true;
    if (exp) lists.push(exp.list.filter((e) => overlaps(e, from, to)));
  }
  for (const cal of cfg.pushCalendars) lists.push(pushedEventsBetween(pushStore.get(cal.id), cal, from, to));
  return { events: mergeEvents(lists), building };
}

/** Move the expansion window when the local date changes; true when it moved. */
function updateWindow(now) {
  if (win && localDate(now, cfg.tz) === win.day) return false;
  win = expansionWindow(now, cfg.tz, cfg.eventsDays);
  return true;
}

/** Expand every calendar whose data or window changed. A newer call stops an older run. */
async function expandCalendars() {
  const gen = ++expandGen;
  const w = win;
  for (const cal of cfg.calendars) {
    const feed = feeds.get(cal.id);
    if (!feed || !feed.parsed) continue;
    const have = expansions.get(cal.id);
    if (have && have.parsed === feed.parsed && have.from === w.from && have.to === w.to) continue;
    const started = Date.now();
    let r;
    try {
      r = await expandParsedAsync(feed.parsed, cal, w.from, w.to, cfg.tz, { shouldStop: () => gen !== expandGen });
    } catch (err) {
      log('calendar_expand_failed', { cal: cal.id, message: String(err && err.message).slice(0, 120) });
      // Keep serving an older expansion if there is one; otherwise stop reporting "building".
      if (!have) expansions.set(cal.id, { parsed: feed.parsed, from: w.from, to: w.to, list: [] });
      continue;
    }
    if (!r) return; // superseded by a newer refresh or window
    r.events.sort((a, b) => a.start - b.start);
    expansions.set(cal.id, { parsed: feed.parsed, from: w.from, to: w.to, list: r.events });
    log('calendar_expanded', {
      cal: cal.id, ms: Date.now() - started, events: r.events.length, masters: r.stats.masters,
      skipped: r.stats.skipped, fastForwarded: r.stats.fastForwarded, iterations: r.stats.iterations,
    });
  }
}

function startExpansion() {
  expandCalendars().catch((err) => log('calendar_expand_failed', { message: String(err && err.message).slice(0, 120) }));
}

async function refreshCalendars() {
  let changed = 0;
  await Promise.all(cfg.calendars.map(async (cal) => {
    const feed = feeds.get(cal.id) || {};
    try {
      const text = await fetchText(cal.url);
      feed.okAt = Date.now();
      feed.error = null;
      const hash = createHash('sha256').update(text).digest('hex');
      if (hash !== feed.hash || !feed.parsed) {
        try {
          // Parse once per change; every date range is served from its expansion.
          feed.parsed = parseFeed(text);
          feed.hash = hash;
          feed.parseError = null;
          changed++;
        } catch (err) {
          feed.parseError = 'PARSE_FAILED';
          log('calendar_parse_failed', { cal: cal.id, message: String(err && err.message).slice(0, 120) });
        }
      }
    } catch (err) {
      feed.error = errorCode(err);
      log('calendar_fetch_failed', { cal: cal.id, code: feed.error });
    }
    feeds.set(cal.id, feed);
  }));
  updateWindow(Date.now());
  log('calendars_refreshed', { calendars: cfg.calendars.length, changed });
  startExpansion();
}

function calendarStatus() {
  const now = Date.now();
  return cfg.calendars.map((c) => {
    const f = feeds.get(c.id) || {};
    return { id: c.id, okAt: f.okAt || null, error: f.parseError || f.error || null };
  }).concat(cfg.pushCalendars.map((c) => pushStatus(c, pushStore.get(c.id), now, cfg.pushStaleMinutes)));
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

// ------------------------------------------------------------ news

const newsFeeds = new Map(); // name -> { items, okAt, error }
let news = [];

async function refreshNews() {
  await Promise.all(cfg.newsFeeds.map(async (f) => {
    const st = newsFeeds.get(f.name) || { items: [] };
    try {
      st.items = parseNews(await fetchFeed(f.url), f.name);
      st.okAt = Date.now();
      st.error = null;
    } catch (err) {
      st.error = errorCode(err);
      log('news_fetch_failed', { feed: f.name, code: st.error });
    }
    newsFeeds.set(f.name, st);
  }));
  news = mergeNews(cfg.newsFeeds.map((f) => (newsFeeds.get(f.name) || {}).items || []));
  log('news_refreshed', { feeds: cfg.newsFeeds.length, items: news.length });
}

function newsStatus() {
  return cfg.newsFeeds.map((f) => {
    const st = newsFeeds.get(f.name) || {};
    return { name: f.name, okAt: st.okAt || null, error: st.error || null };
  });
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

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
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
  return { now, pomodoro: s.pomodoro, acks: s.acks, screen: cfg.screen };
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
    if (updateWindow(now)) startExpansion(); // first request after midnight
    const range = parseRange(url.searchParams, now, cfg.tz, cfg.eventsDays);
    if (range) {
      const r = eventsBetween(range.from, range.to);
      return send(res, 200, {
        ...timeInfo(now, range.from - 86400000, range.to + 86400000),
        from: range.fromDate,
        days: range.days,
        calendars: publicCalendars(allCalendars),
        status: calendarStatus(),
        alert: cfg.alert,
        building: r.building,
        events: r.events,
      });
    }
    const from = startOfLocalDay(now, cfg.tz);
    const to = from + cfg.eventsDays * 86400000;
    const r = eventsBetween(from, to);
    return send(res, 200, {
      ...timeInfo(now, from - 86400000, to + 86400000),
      calendars: publicCalendars(allCalendars),
      status: calendarStatus(),
      alert: cfg.alert,
      building: r.building,
      events: r.events,
    });
  }

  if (req.method === 'GET' && path === '/api/weather') {
    if (!weather || now - weatherAt > cfg.weatherMinutes * 60000) await refreshWeather();
    if (!weather) return send(res, 502, { error: weatherError || 'unavailable' });
    return send(res, 200, { fetchedAt: weatherAt, stale: !!weatherError, ...weather });
  }

  if (req.method === 'GET' && path === '/api/state') return send(res, 200, stateBody(now));

  // A laptop pushes a calendar snapshot: PUT /api/push/<id>, Authorization: Bearer <token>.
  if (path.startsWith('/api/push/')) {
    if (req.method !== 'PUT') return send(res, 405, { error: 'use PUT' });
    const id = path.slice('/api/push/'.length);
    let cal = null;
    for (const c of cfg.pushCalendars) if (c.id === id) cal = c;
    // Same answer for an unknown id and a wrong token, so ids can't be probed.
    if (!cal || !tokenMatches(req.headers.authorization, cal.token)) {
      log('push_refused', { cal: cal ? cal.id : '?' });
      return send(res, 401, { error: 'unauthorised' });
    }
    if (Number(req.headers['content-length']) > PUSH_LIMITS.maxBody) return send(res, 413, { error: 'body too large' });
    const body = await readBody(req, PUSH_LIMITS.maxBody);
    const events = validatePushPayload(body, cfg.tz, now);
    pushStore.put(cal.id, events, now);
    log('calendar_pushed', { cal: cal.id, events: events.length });
    return send(res, 200, { ok: true, events: events.length, receivedAt: now });
  }

  if (req.method === 'GET' && path === '/api/news') {
    if (!cfg.newsFeeds.length) return send(res, 404, { error: 'NOT_CONFIGURED' });
    return send(res, 200, { now, items: news, status: newsStatus() });
  }

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
  log('listening', { host: cfg.host, port: cfg.port, tz: cfg.tz, calendars: allCalendars.map((c) => c.id), textFeed: !!textFeed });
});

refreshCalendars();
setInterval(refreshCalendars, cfg.refreshMinutes * 60000).unref();
// Move the expansion window at local midnight even when nothing asks for events.
setInterval(() => { if (updateWindow(Date.now())) startExpansion(); }, 60000).unref();
refreshWeather();
if (cfg.newsFeeds.length) {
  refreshNews();
  setInterval(refreshNews, cfg.newsMinutes * 60000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
