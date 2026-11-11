'use strict';

/** Aggregation of SLA evaluations into overall and per-owner stats (used by the weekly report). */

// @build:strip-start
const { STATUS } = require('./sla-evaluator');
// @build:strip-end

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

/** Nearest-rank percentile on an ascending array. */
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (!n) return null;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sortedAsc[idx];
}

function statsFor(evals) {
  const count = (s) => evals.filter((e) => e.status === s).length;
  const met = count(STATUS.MET);
  const breachedLate = count(STATUS.BREACHED_LATE);
  const openBreached = count(STATUS.OPEN_BREACHED);
  const openAtRisk = count(STATUS.OPEN_AT_RISK);
  const openWithin = count(STATUS.OPEN_WITHIN_SLA);

  // "Decided" = leads whose SLA outcome is already known (met, late, or blown while untouched).
  const decided = met + breachedLate + openBreached;
  const times = evals
    .filter((e) => e.minutesToFirstTouch !== null)
    .map((e) => e.minutesToFirstTouch)
    .sort((a, b) => a - b);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  const r1 = (n) => (n === null ? null : Math.round(n * 10) / 10);

  return {
    leads: evals.length,
    touched: times.length,
    met,
    breachedLate,
    openBreached,
    openAtRisk,
    openWithin,
    decided,
    attainmentPct: decided ? Math.round((met / decided) * 1000) / 10 : null,
    medianMinutes: r1(median(times)),
    p90Minutes: r1(percentile(times, 90)),
    avgMinutes: r1(avg),
  };
}

/**
 * @param {Array}  evaluations  output of evaluateLead
 * @param {object} ownerNames   { [ownerId]: 'Display Name' }
 */
function summarize(evaluations, ownerNames) {
  const names = ownerNames || {};
  const groups = {};
  for (const e of evaluations) {
    const key = e.ownerId ? String(e.ownerId) : 'unassigned';
    (groups[key] = groups[key] || []).push(e);
  }
  const byOwner = Object.keys(groups)
    .map((key) => ({
      ownerId: key === 'unassigned' ? null : key,
      name: key === 'unassigned' ? 'Unassigned' : names[key] || `Owner ${key}`,
      ...statsFor(groups[key]),
    }))
    .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));
  return { overall: statsFor(evaluations), byOwner };
}

// @build:strip-start
module.exports = { median, percentile, statsFor, summarize };
// @build:strip-end
