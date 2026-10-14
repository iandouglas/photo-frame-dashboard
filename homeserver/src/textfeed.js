// Plain-text feed for the bottom-right card. The text is passed through as served: no rewriting,
// only a size cap. The frame only ever talks to this server; the third-party URL is fetched here.

export const MAX_BYTES = 2048;

/** Cut a UTF-8 buffer to at most maxBytes without splitting a multi-byte character. */
export function truncateUtf8(buf, maxBytes = MAX_BYTES) {
  if (buf.length <= maxBytes) return buf;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** Read at most maxBytes of a fetch Response body, then cancel the rest. */
async function readCapped(res, maxBytes) {
  if (!res.body || !res.body.getReader) {
    return new TextDecoder().decode(truncateUtf8(new Uint8Array(await res.arrayBuffer()), maxBytes));
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size <= maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(truncateUtf8(all, maxBytes));
}

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * A rate-guarded fetcher. get() resolves to { text, fetchedAt, stale } or { error } when nothing
 * good has been fetched yet. Several callers within minIntervalMs share one upstream request.
 */
export function createTextFeed({
  url,
  fetchImpl = fetch,
  clock = Date.now,
  minIntervalMs = 10000,
  timeoutMs = 5000,
  maxBytes = MAX_BYTES,
} = {}) {
  let last = null; // { text, fetchedAt }
  let lastError = null;
  let lastAttempt = -Infinity;
  let inflight = null;

  function result() {
    if (last) return { text: last.text, fetchedAt: last.fetchedAt, stale: !!lastError };
    return { error: lastError || 'UNAVAILABLE' };
  }

  async function fetchOnce() {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/plain, text/*;q=0.9', 'user-agent': 'frame-homeserver' },
        redirect: 'follow',
      });
      if (!res.ok) throw failure('HTTP_' + res.status);
      const type = String(res.headers.get('content-type') || '');
      if (!/^text\//i.test(type)) {
        if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
        throw failure('NOT_TEXT');
      }
      const text = await readCapped(res, maxBytes);
      last = { text, fetchedAt: clock() };
      lastError = null;
    } catch (err) {
      lastError = err && err.code && /^[A-Z0-9_]+$/.test(err.code) ? err.code
        : err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'FETCH_FAILED';
    }
  }

  return {
    async get() {
      if (inflight) {
        await inflight;
        return result();
      }
      if (clock() - lastAttempt < minIntervalMs) return result();
      lastAttempt = clock();
      inflight = fetchOnce().finally(() => { inflight = null; });
      await inflight;
      return result();
    },
  };
}
