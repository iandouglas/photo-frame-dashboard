// Headlines from RSS 2.0, RSS 1.0 (RDF) and Atom feeds: parse, clean, merge newest first.
// Only text leaves this module: a title, the feed's name and a time. No links or HTML.
import { XMLParser } from 'fast-xml-parser';

export const MAX_ITEMS = 60;
export const MAX_FEED_BYTES = 3 * 1024 * 1024;

/** NEWS_FEEDS: JSON [{ "name": "NPR", "url": "https://..." }]. Empty/unset = no news tab. */
export function parseNewsFeeds(json) {
  if (json == null || String(json).trim() === '') return [];
  let list;
  try {
    list = JSON.parse(json);
  } catch {
    throw new Error('NEWS_FEEDS is not valid JSON');
  }
  if (!Array.isArray(list)) throw new Error('NEWS_FEEDS must be a JSON array');
  if (list.length > 12) throw new Error('NEWS_FEEDS: at most 12 feeds');
  const names = new Set();
  return list.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`NEWS_FEEDS[${i}] must be an object`);
    const name = typeof f.name === 'string' ? f.name.trim().slice(0, 40) : '';
    if (!name) throw new Error(`NEWS_FEEDS[${i}] needs a name`);
    if (names.has(name)) throw new Error(`NEWS_FEEDS: duplicate name "${name}"`);
    names.add(name);
    let u;
    try {
      u = new URL(String(f.url));
    } catch {
      throw new Error(`NEWS_FEEDS[${i}] (${name}) has an invalid url`);
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`NEWS_FEEDS[${i}] (${name}) url must be http or https`);
    return { name, url: u.toString() };
  });
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', uacute: 'ú', iacute: 'í', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Plain-text headline: tags removed, entities decoded (twice, for double-escaped feeds). */
export function cleanTitle(raw) {
  let s = textOf(raw);
  for (let i = 0; i < 2; i++) s = decodeEntities(s.replace(/<[^>]*>/g, ' '));
  s = s.replace(/<[^>]*>/g, ' ');
  return s.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in v) return String(v['#text']);
  return '';
}

function asArray(v) {
  return v == null ? [] : Array.isArray(v) ? v : [v];
}

function timeOf(...candidates) {
  for (const c of candidates) {
    const t = Date.parse(textOf(c).trim());
    if (Number.isFinite(t)) return t;
  }
  return null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false, // decoded once, by cleanTitle, so double-escaped titles come out right
  htmlEntities: false,
  removeNSPrefix: true, // dc:date -> date, rdf:RDF -> RDF
  isArray: (name) => name === 'item' || name === 'entry',
});

/** Parse one feed document into [{ title, source, time }]. Throws on non-feed XML. */
export function parseNews(xml, source) {
  const doc = parser.parse(xml);
  let items;
  if (doc.rss && doc.rss.channel) {
    items = asArray(doc.rss.channel.item).map((it) => ({ title: it.title, time: timeOf(it.pubDate, it.date, it.updated) }));
  } else if (doc.feed) {
    items = asArray(doc.feed.entry).map((it) => ({ title: it.title, time: timeOf(it.published, it.updated, it.date) }));
  } else if (doc.RDF) {
    items = asArray(doc.RDF.item).map((it) => ({ title: it.title, time: timeOf(it.date, it.pubDate) }));
  } else {
    throw Object.assign(new Error('not an RSS or Atom feed'), { code: 'NOT_A_FEED' });
  }
  const out = [];
  for (const it of items) {
    const title = cleanTitle(it.title);
    if (title) out.push({ title, source, time: it.time });
  }
  return out;
}

function dedupeKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Merge per-feed lists: drop repeated headlines, newest first (undated last), cap the count. */
export function mergeNews(lists, max = MAX_ITEMS, nowMs = Date.now()) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const it of list) {
      const key = dedupeKey(it.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      // A feed clock in the future would pin an item to the top; treat it as "now".
      out.push(it.time != null && it.time > nowMs ? { ...it, time: nowMs } : it);
    }
  }
  out.sort((a, b) => (b.time == null ? -Infinity : b.time) - (a.time == null ? -Infinity : a.time));
  return out.slice(0, max);
}

/** Fetch a feed body with a timeout and a size cap. */
export async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = 15000, maxBytes = MAX_FEED_BYTES } = {}) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      'user-agent': 'frame-homeserver/1.0 (+RSS reader)',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { code: 'HTTP_' + res.status });
  const len = Number(res.headers.get('content-length'));
  if (len > maxBytes) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
  return text;
}
