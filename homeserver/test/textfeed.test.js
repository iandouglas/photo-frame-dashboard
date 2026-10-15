import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTextFeed, truncateUtf8, MAX_BYTES } from '../src/textfeed.js';
import { parseTextFeed } from '../src/config.js';

// A local stand-in for the third-party feed. Each path behaves differently.
let server, base, hits = 0, mode = 'ok';

before(async () => {
  server = createServer((req, res) => {
    hits++;
    if (req.url === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<b>bold</b> <script>alert(1)</script> joke');
    }
    if (req.url === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"joke":"no"}');
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('é'.repeat(5000)); // 10,000 bytes
    }
    if (req.url === '/flaky') {
      if (mode === 'down') {
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('down');
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Joke number ' + hits);
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Why did the chicken\ncross the road?\n  To get to the other side.\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});

after(() => new Promise((r) => server.close(r)));

/** A controllable clock, so the rate guard can be tested without waiting. */
function fakeClock(start = 1_000_000) {
  const c = () => c.t;
  c.t = start;
  return c;
}

test('truncateUtf8 cuts at a character boundary', () => {
  const buf = Buffer.from('ab' + 'é'.repeat(3)); // 2 + 6 bytes
  assert.equal(Buffer.from(truncateUtf8(buf, 8)).toString(), 'abééé');
  assert.equal(Buffer.from(truncateUtf8(buf, 5)).toString(), 'abé');
  assert.equal(Buffer.from(truncateUtf8(buf, 3)).toString(), 'ab');
});

test('passes the text through exactly as served', async () => {
  const feed = createTextFeed({ url: base + '/', clock: fakeClock() });
  const r = await feed.get();
  assert.equal(r.text, 'Why did the chicken\ncross the road?\n  To get to the other side.\n');
  assert.equal(r.stale, false);
  assert.equal(typeof r.fetchedAt, 'number');
});

test('text/html is passed through as plain text, never interpreted', async () => {
  const r = await createTextFeed({ url: base + '/html', clock: fakeClock() }).get();
  // The server returns it verbatim; the frame sets it with textContent.
  assert.equal(r.text, '<b>bold</b> <script>alert(1)</script> joke');
});

test('non-text content types are rejected', async () => {
  const r = await createTextFeed({ url: base + '/json', clock: fakeClock() }).get();
  assert.deepEqual(r, { error: 'NOT_TEXT' });
});

test('the body is capped at MAX_BYTES without splitting a character', async () => {
  const r = await createTextFeed({ url: base + '/big', clock: fakeClock() }).get();
  assert.equal(Buffer.byteLength(r.text), MAX_BYTES);
  assert.equal(r.text, 'é'.repeat(MAX_BYTES / 2));
});

test('rate guard: one upstream fetch per interval, shared by concurrent callers', async () => {
  const clock = fakeClock();
  mode = 'ok';
  const feed = createTextFeed({ url: base + '/flaky', clock, minIntervalMs: 10000 });
  const before = hits;
  const [a, b, c] = await Promise.all([feed.get(), feed.get(), feed.get()]);
  assert.equal(hits - before, 1);
  assert.equal(a.text, b.text);
  assert.equal(b.text, c.text);

  clock.t += 5000; // still inside the interval: cached
  assert.equal((await feed.get()).text, a.text);
  assert.equal(hits - before, 1);

  clock.t += 6000; // interval passed: a fresh joke
  const d = await feed.get();
  assert.equal(hits - before, 2);
  assert.notEqual(d.text, a.text);
});

test('on upstream errors the last good text is kept and marked stale', async () => {
  const clock = fakeClock();
  mode = 'ok';
  const feed = createTextFeed({ url: base + '/flaky', clock, minIntervalMs: 10000 });
  const good = await feed.get();
  mode = 'down';
  clock.t += 11000;
  const r = await feed.get();
  assert.equal(r.text, good.text);
  assert.equal(r.fetchedAt, good.fetchedAt);
  assert.equal(r.stale, true);
  mode = 'ok';
  clock.t += 11000;
  assert.equal((await feed.get()).stale, false);
});

test('with no good text yet, an error code is returned', async () => {
  mode = 'down';
  const r = await createTextFeed({ url: base + '/flaky', clock: fakeClock() }).get();
  assert.deepEqual(r, { error: 'HTTP_503' });
  mode = 'ok';
  const dead = await createTextFeed({ url: 'http://127.0.0.1:1/', clock: fakeClock(), timeoutMs: 2000 }).get();
  assert.ok(dead.error && /^[A-Z0-9_]+$/.test(dead.error));
});

test('TEXT_FEED_URL config: unset hides the card, bad values are rejected', () => {
  assert.equal(parseTextFeed('', ''), null);
  assert.equal(parseTextFeed(undefined, 'x'), null);
  assert.deepEqual(parseTextFeed('https://example.com/joke', 'Joke'), { url: 'https://example.com/joke', title: 'Joke' });
  assert.throws(() => parseTextFeed('ftp://example.com/', ''), /http or https/);
  assert.throws(() => parseTextFeed('not a url', ''), /not a valid URL/);
});
