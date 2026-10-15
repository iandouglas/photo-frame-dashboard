import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNews, mergeNews, cleanTitle, parseNewsFeeds, fetchFeed } from '../src/news.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Example</title>
<item><title>Plain headline</title><link>https://example.test/1</link><pubDate>Wed, 14 Oct 2026 19:42:03 GMT</pubDate></item>
<item><title><![CDATA[Ships &amp; <b>boats</b> &#8217;ahoy&#x2019;]]></title><pubDate>Wed, 14 Oct 2026 18:00:00 +0000</pubDate></item>
<item><title>Double &amp;amp; escaped &amp;quot;quote&amp;quot;</title><dc:date>2026-10-14T17:00:00Z</dc:date></item>
<item><title>   </title><pubDate>Wed, 14 Oct 2026 16:00:00 GMT</pubDate></item>
<item><title>No date at all</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
<entry><title type="html">Atom &lt;em&gt;one&lt;/em&gt;</title><published>2026-10-14T20:00:00-04:00</published><updated>2026-10-14T21:00:00-04:00</updated></entry>
<entry><title>PLAIN HEADLINE!</title><updated>2026-10-14T10:00:00Z</updated></entry>
</feed>`;

const ONE_ITEM_RSS = `<rss version="2.0"><channel><item><title>Only one</title><pubDate>Wed, 14 Oct 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>RDF</title></channel>
<item><title>RDF item</title><dc:date>2026-10-13T08:00:00Z</dc:date></item>
</rdf:RDF>`;

test('RSS 2.0: titles cleaned, times parsed, empty titles dropped', () => {
  const items = parseNews(RSS, 'Ex');
  assert.deepEqual(items.map((i) => i.title), [
    'Plain headline',
    'Ships & boats ’ahoy’',
    'Double & escaped "quote"',
    'No date at all',
  ]);
  assert.equal(items[0].source, 'Ex');
  assert.equal(items[0].time, Date.parse('2026-10-14T19:42:03Z'));
  assert.equal(items[2].time, Date.parse('2026-10-14T17:00:00Z'));
  assert.equal(items[3].time, null);
  assert.equal(Object.keys(items[0]).sort().join(), 'source,time,title'); // no links
});

test('Atom: HTML titles become text; published preferred over updated', () => {
  const items = parseNews(ATOM, 'At');
  assert.equal(items[0].title, 'Atom one');
  assert.equal(items[0].time, Date.parse('2026-10-15T00:00:00Z'));
});

test('RSS 1.0 (RDF) and single-item feeds', () => {
  assert.deepEqual(parseNews(RDF, 'R').map((i) => i.title), ['RDF item']);
  assert.deepEqual(parseNews(ONE_ITEM_RSS, 'O').map((i) => i.title), ['Only one']);
});

test('non-feed documents are rejected', () => {
  assert.throws(() => parseNews('<html><body>hi</body></html>', 'X'), (e) => e.code === 'NOT_A_FEED');
});

test('cleanTitle strips scripts and tags to plain text', () => {
  assert.equal(cleanTitle('<script>alert(1)</script>Hello &lt;i&gt;world&lt;/i&gt;'), 'alert(1) Hello world');
  assert.equal(cleanTitle({ '#text': 'From an object' }), 'From an object');
  assert.equal(cleanTitle('&bogus; stays'), '&bogus; stays');
});

test('merge: dedupes by title, newest first, undated last, capped, future clamped', () => {
  const now = Date.parse('2026-10-15T02:00:00Z');
  const merged = mergeNews([parseNews(RSS, 'Ex'), parseNews(ATOM, 'At'), [{ title: 'From the future', source: 'F', time: now + 3600000 }]], 60, now);
  const titles = merged.map((i) => i.title);
  assert.equal(titles.filter((t) => t.toLowerCase().startsWith('plain headline')).length, 1);
  assert.equal(titles[0], 'From the future');
  assert.equal(merged[0].time, now);
  assert.equal(titles[titles.length - 1], 'No date at all');
  for (let i = 1; i < merged.length - 1; i++) assert.ok(merged[i - 1].time >= merged[i].time);
  assert.equal(mergeNews([parseNews(RSS, 'Ex')], 2).length, 2);
});

test('NEWS_FEEDS config', () => {
  assert.deepEqual(parseNewsFeeds(undefined), []);
  assert.deepEqual(parseNewsFeeds(' '), []);
  assert.deepEqual(parseNewsFeeds('[{"name":"NPR","url":"https://feeds.npr.org/1001/rss.xml"}]'),
    [{ name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' }]);
  for (const bad of ['{', '{}', '[{"url":"https://x.test"}]', '[{"name":"A","url":"ftp://x.test"}]',
    '[{"name":"A","url":"https://x.test"},{"name":"A","url":"https://y.test"}]', '[{"name":"A","url":"nope"}]']) {
    assert.throws(() => parseNewsFeeds(bad), Error, bad);
  }
});

test('fetchFeed reports HTTP errors and refuses oversized bodies', async () => {
  const fake = (status, body, headers = {}) => async () => new Response(body, { status, headers });
  await assert.rejects(fetchFeed('https://x.test', { fetchImpl: fake(404, 'no') }), (e) => e.code === 'HTTP_404');
  await assert.rejects(fetchFeed('https://x.test', { fetchImpl: fake(200, 'x'.repeat(50)), maxBytes: 10 }), (e) => e.code === 'TOO_LARGE');
  assert.equal(await fetchFeed('https://x.test', { fetchImpl: fake(200, RSS) }), RSS);
});
