'use strict';

/**
 * Round-robin lead assignment with fallback rules.
 *
 * Rep shape: { id, name, active, maxOpenLeads (null = no cap), ooo: [{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }] }
 * A rep is skipped when inactive, out of office today (inclusive dates, in the business time zone),
 * or at/over their open-lead capacity. If nobody is eligible the lead goes to the fallback owner.
 */

function localDate(nowMs, timeZone) {
  // 'en-CA' formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
}

function isOutOfOffice(rep, nowMs, timeZone) {
  const today = localDate(nowMs, timeZone);
  return (rep.ooo || []).some((w) => w && w.from && w.to && today >= w.from && today <= w.to);
}

/**
 * @param {object} args
 * @param {Array}  args.reps
 * @param {object} args.openCounts        { [repId]: number of open leads }
 * @param {number} args.lastAssignedIndex index of the last rep chosen (-1 / undefined = start from the top)
 * @param {number} args.nowMs
 * @param {string} args.timezone
 * @param {string} args.fallbackOwnerId
 */
function pickRep(args) {
  const reps = args.reps || [];
  const counts = args.openCounts || {};
  const skipped = [];
  const last = Number.isInteger(args.lastAssignedIndex) ? args.lastAssignedIndex : -1;
  const n = reps.length;

  for (let step = 1; step <= n; step++) {
    const i = (((last + step) % n) + n) % n;
    const rep = reps[i];
    const open = counts[rep.id] || 0;
    if (rep.active === false) {
      skipped.push({ id: rep.id, name: rep.name, reason: 'inactive' });
      continue;
    }
    if (isOutOfOffice(rep, args.nowMs, args.timezone)) {
      skipped.push({ id: rep.id, name: rep.name, reason: 'out_of_office' });
      continue;
    }
    if (rep.maxOpenLeads !== null && rep.maxOpenLeads !== undefined && open >= rep.maxOpenLeads) {
      skipped.push({ id: rep.id, name: rep.name, reason: 'at_capacity' });
      continue;
    }
    return {
      action: 'ASSIGN',
      strategy: 'ROUND_ROBIN',
      ownerId: rep.id,
      ownerName: rep.name,
      newIndex: i,
      openLeadsBefore: open,
      skipped,
    };
  }

  const hasFallback = Boolean(args.fallbackOwnerId);
  return {
    action: hasFallback ? 'ASSIGN' : 'NO_ASSIGNMENT',
    strategy: hasFallback ? 'FALLBACK_OWNER' : 'NO_ELIGIBLE_REP',
    ownerId: hasFallback ? String(args.fallbackOwnerId) : null,
    ownerName: hasFallback ? 'Fallback owner' : null,
    newIndex: last,
    openLeadsBefore: null,
    skipped,
  };
}

// @build:strip-start
module.exports = { isOutOfOffice, pickRep, localDate };
// @build:strip-end
