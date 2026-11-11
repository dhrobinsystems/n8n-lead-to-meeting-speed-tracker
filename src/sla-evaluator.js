'use strict';

/**
 * Speed-to-lead SLA evaluation.
 *
 * A "touch" is a normalized outbound activity: { type: 'call'|'email'|'meeting'|'sequence', at: epochMs }.
 * The SLA clock only counts business minutes (see business-hours.js).
 */

// @build:strip-start
const { businessMinutesBetween, addBusinessMinutes } = require('./business-hours');
// @build:strip-end

const STATUS = {
  MET: 'MET',                         // first touch inside the SLA
  BREACHED_LATE: 'BREACHED_LATE',     // first touch happened, but after the SLA
  OPEN_WITHIN_SLA: 'OPEN_WITHIN_SLA', // no touch yet, still inside the SLA, below the warning threshold
  OPEN_AT_RISK: 'OPEN_AT_RISK',       // no touch yet, warning threshold reached
  OPEN_BREACHED: 'OPEN_BREACHED',     // no touch yet, SLA already blown
};

const round1 = (n) => Math.round(n * 10) / 10;

/** Earliest touch at or after the clock start (activity before the lead existed is ignored). */
function firstTouchAfter(touches, clockStartMs) {
  let best = null;
  for (const t of touches || []) {
    if (!t || !Number.isFinite(t.at) || t.at < clockStartMs) continue;
    if (!best || t.at < best.at) best = t;
  }
  return best;
}

/**
 * @param {object} lead     normalized lead (see hubspot.js normalizeLead)
 * @param {Array}  touches  normalized touches for this lead
 * @param {number} nowMs    evaluation time
 * @param {object} cfg      { slaMinutes, warnPct, hours }
 */
function evaluateLead(lead, touches, nowMs, cfg) {
  const clockStart = lead.clockStartMs;
  const touch = firstTouchAfter(touches, clockStart);
  const dueAtMs = addBusinessMinutes(clockStart, cfg.slaMinutes, cfg.hours);
  const touchCount = (touches || []).filter((t) => t && t.at >= clockStart).length;

  let elapsed;
  let status;
  if (touch) {
    elapsed = businessMinutesBetween(clockStart, touch.at, cfg.hours);
    status = elapsed <= cfg.slaMinutes + 1e-9 ? STATUS.MET : STATUS.BREACHED_LATE;
  } else {
    elapsed = businessMinutesBetween(clockStart, nowMs, cfg.hours);
    if (elapsed > cfg.slaMinutes) status = STATUS.OPEN_BREACHED;
    else if (elapsed >= cfg.slaMinutes * cfg.warnPct) status = STATUS.OPEN_AT_RISK;
    else status = STATUS.OPEN_WITHIN_SLA;
  }

  return {
    id: String(lead.id),
    name: lead.name,
    email: lead.email,
    company: lead.company,
    source: lead.source,
    ownerId: lead.ownerId,
    unassigned: !lead.ownerId,
    clockStartMs: clockStart,
    firstTouchAtMs: touch ? touch.at : null,
    firstTouchType: touch ? touch.type : null,
    touchCount,
    minutesToFirstTouch: touch ? round1(elapsed) : null,
    elapsedBusinessMinutes: round1(elapsed),
    slaMinutes: cfg.slaMinutes,
    dueAtMs,
    status,
  };
}

// @build:strip-start
module.exports = { STATUS, firstTouchAfter, evaluateLead, round1 };
// @build:strip-end
