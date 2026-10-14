// Time zone helpers built on Node's full ICU. The frame's own clock and zone are not trusted
// (it ships set to America/New_York and can boot at 1969), so the server does all zone maths
// and hands the client a small table of UTC offsets to format with.

const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidZone(tz) {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a zone. */
export function wallParts(ms, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at instant `ms`, in minutes (Denver summer = -360). */
export function offsetAt(ms, tz) {
  const w = wallParts(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Instant of a wall-clock time in `tz`. Month is 1-based. Gaps resolve forward, overlaps to the first. */
export function wallToUtc(year, month, day, hour, minute, second, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const before = offsetAt(guess - 86400000, tz);
  const after = offsetAt(guess + 86400000, tz);
  const valid = [before, after]
    .map((off) => guess - off * 60000)
    .filter((t) => guess - offsetAt(t, tz) * 60000 === t);
  if (valid.length) return Math.min(...valid);
  // In a spring-forward gap: the pre-gap offset lands just after the gap.
  return guess - before * 60000;
}

/**
 * Offset table covering [fromMs, toMs]: [[startMs, offsetMinutes], ...], sorted.
 * The client picks the last entry whose start <= t. Sampled hourly, then the
 * transition is narrowed to the minute.
 */
export function offsetTable(fromMs, toMs, tz) {
  const HOUR = 3600000;
  const table = [[fromMs, offsetAt(fromMs, tz)]];
  let prev = table[0][1];
  for (let t = fromMs + HOUR; t <= toMs + HOUR; t += HOUR) {
    const off = offsetAt(t, tz);
    if (off !== prev) {
      let lo = t - HOUR, hi = t;
      while (hi - lo > 60000) {
        const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
        if (offsetAt(mid, tz) === prev) lo = mid; else hi = mid;
      }
      table.push([hi, off]);
      prev = off;
    }
  }
  return table;
}

/** YYYY-MM-DD for an instant in a zone. */
export function localDate(ms, tz) {
  const w = wallParts(ms, tz);
  return w.year + '-' + String(w.month).padStart(2, '0') + '-' + String(w.day).padStart(2, '0');
}

/** Instant of local midnight on the day containing `ms` in `tz`. */
export function startOfLocalDay(ms, tz) {
  const w = wallParts(ms, tz);
  return wallToUtc(w.year, w.month, w.day, 0, 0, 0, tz);
}
