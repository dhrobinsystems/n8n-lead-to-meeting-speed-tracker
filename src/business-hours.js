'use strict';

/**
 * Business-hours-aware time math.
 *
 * Zero dependencies: uses only Intl, so the exact same code runs in Node (tests)
 * and inside n8n Code nodes (the build script inlines this file).
 *
 * Hours config:
 *   {
 *     timezone:  'America/New_York',
 *     startTime: '09:00',
 *     endTime:   '17:00',
 *     workdays:  [1, 2, 3, 4, 5],     // ISO weekdays: 1 = Mon ... 7 = Sun
 *     holidays:  ['2026-12-25']       // local dates (YYYY-MM-DD) with no business hours
 *   }
 */

const MS_PER_MINUTE = 60 * 1000;
const MAX_DAYS_SCANNED = 800;

const DEFAULT_HOURS = {
  timezone: 'America/New_York',
  startTime: '09:00',
  endTime: '17:00',
  workdays: [1, 2, 3, 4, 5],
  holidays: [],
};

const _formatters = {};

function getFormatter(timeZone) {
  if (!_formatters[timeZone]) {
    _formatters[timeZone] = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }
  return _formatters[timeZone];
}

/** Wall-clock parts of an instant in a given IANA time zone. */
function zonedParts(ms, timeZone) {
  const out = {};
  for (const p of getFormatter(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** Offset (ms) of a zone from UTC at a given instant. Positive = ahead of UTC. */
function tzOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert a local wall-clock time in `timeZone` to a UTC epoch (ms). DST-safe. */
function localToUtcMs(year, month, day, hour, minute, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset = tzOffsetMs(guess, timeZone);
  let utc = guess - offset;
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) utc = guess - offset2;
  return utc;
}

function parseHHMM(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) {
    throw new Error(`Invalid time "${value}" - expected HH:MM (24h)`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

function normalizeHours(hours) {
  const h = Object.assign({}, DEFAULT_HOURS, hours || {});
  try {
    getFormatter(h.timezone);
  } catch (e) {
    throw new Error(`Invalid time zone "${h.timezone}" - use an IANA name like "America/New_York"`);
  }
  const start = parseHHMM(h.startTime);
  const end = parseHHMM(h.endTime);
  if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) {
    throw new Error('Business hours endTime must be after startTime');
  }
  const workdays = (h.workdays || []).map(Number);
  if (!workdays.length || workdays.some((d) => !(d >= 1 && d <= 7))) {
    throw new Error('workdays must be ISO weekdays 1 (Mon) to 7 (Sun)');
  }
  return {
    timezone: h.timezone,
    start,
    end,
    workdays,
    holidays: (h.holidays || []).map(String),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

function isBusinessDay(y, m, d, cfg) {
  const iso = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return cfg.workdays.includes(iso) && !cfg.holidays.includes(`${y}-${pad2(m)}-${pad2(d)}`);
}

function nextDay(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayWindow(y, m, d, cfg) {
  return {
    open: localToUtcMs(y, m, d, cfg.start.hour, cfg.start.minute, cfg.timezone),
    close: localToUtcMs(y, m, d, cfg.end.hour, cfg.end.minute, cfg.timezone),
  };
}

/** Is this instant inside business hours? */
function isWithinBusinessHours(ms, hours) {
  const cfg = normalizeHours(hours);
  const p = zonedParts(ms, cfg.timezone);
  if (!isBusinessDay(p.year, p.month, p.day, cfg)) return false;
  const w = dayWindow(p.year, p.month, p.day, cfg);
  return ms >= w.open && ms < w.close;
}

/**
 * Business minutes elapsed between two instants.
 * Time outside business hours, on non-working days, and on holidays does not count.
 */
function businessMinutesBetween(startMs, endMs, hours) {
  if (!(endMs > startMs)) return 0;
  const cfg = normalizeHours(hours);
  let { year: y, month: m, day: d } = zonedParts(startMs, cfg.timezone);
  const last = zonedParts(endMs, cfg.timezone);
  let totalMs = 0;
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isBusinessDay(y, m, d, cfg)) {
      const w = dayWindow(y, m, d, cfg);
      const from = Math.max(startMs, w.open);
      const to = Math.min(endMs, w.close);
      if (to > from) totalMs += to - from;
    }
    if (y === last.year && m === last.month && d === last.day) break;
    ({ y, m, d } = nextDay(y, m, d));
  }
  return totalMs / MS_PER_MINUTE;
}

/** The instant at which `minutes` business minutes will have elapsed since `startMs`. */
function addBusinessMinutes(startMs, minutes, hours) {
  if (!(minutes > 0)) return startMs;
  const cfg = normalizeHours(hours);
  let remaining = minutes * MS_PER_MINUTE;
  let { year: y, month: m, day: d } = zonedParts(startMs, cfg.timezone);
  for (let i = 0; i < MAX_DAYS_SCANNED; i++) {
    if (isBusinessDay(y, m, d, cfg)) {
      const w = dayWindow(y, m, d, cfg);
      const from = Math.max(startMs, w.open);
      if (from < w.close) {
        const available = w.close - from;
        if (remaining <= available) return from + remaining;
        remaining -= available;
      }
    }
    ({ y, m, d } = nextDay(y, m, d));
  }
  throw new Error('addBusinessMinutes: no business hours found within 800 days - check your hours config');
}

// @build:strip-start
module.exports = {
  DEFAULT_HOURS,
  zonedParts,
  tzOffsetMs,
  localToUtcMs,
  normalizeHours,
  isWithinBusinessHours,
  businessMinutesBetween,
  addBusinessMinutes,
};
// @build:strip-end
