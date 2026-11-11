// Code node: "Evaluate SLA" (Run Once for All Items)
// Joins leads with their touches, computes SLA status in business minutes, and then either
//   - monitor mode: returns only NEW at-risk / breached leads (de-duplicated via workflow static data), or
//   - report mode:  returns the weekly summary.
// Returning [] ends the run quietly (nothing to alert on).
const { mode, cfg, leads } = $('Normalize Leads').first().json;
const requestItems = $('Build Detail Requests').all().map((i) => i.json);
const assocMap = requestItems[0].assocMap;
const skipped = requestItems[0].skip === true;
const detailResponses = skipped ? [] : $input.all().map((i) => i.json);
const detailRequests = skipped ? [] : requestItems;

const touchesByLead = collectTouches(assocMap, detailRequests, detailResponses);
const nowMs = Date.now();
const evalCfg = { slaMinutes: cfg.slaMinutes, warnPct: cfg.warnPct, hours: cfg.hours };
const ownerNames = {};
cfg.reps.forEach((r) => { ownerNames[r.id] = r.name; });

const evaluations = leads.map((lead) => {
  const touches = (touchesByLead[lead.id] || []).slice();
  if (lead.sequenceEnrolledAtMs) touches.push({ type: 'sequence', at: lead.sequenceEnrolledAtMs });
  const e = evaluateLead(lead, touches, nowMs, evalCfg);
  e.ownerName = e.ownerId ? ownerNames[e.ownerId] || null : null;
  return e;
});

const ui = {
  portalId: cfg.portalId,
  slaMinutes: cfg.slaMinutes,
  timezone: cfg.hours.timezone,
  sandbox: cfg.sandbox,
  maxLeads: cfg.alertMaxLeads,
  reportLookbackDays: cfg.reportLookbackDays,
};

if (mode === 'report') {
  const summary = summarize(evaluations, ownerNames);

  // Trend log: one compact entry per report, kept in workflow static data (last 26 reports).
  // `trend.entry` is also output so you can append it to Google Sheets / a database (see docs/ARCHITECTURE.md).
  const trendState = $getWorkflowStaticData('global');
  trendState.trend = Array.isArray(trendState.trend) ? trendState.trend : [];
  const previous = trendState.trend.length ? trendState.trend[trendState.trend.length - 1] : null;
  const entry = {
    date: new Date(nowMs).toISOString().slice(0, 10),
    leads: summary.overall.leads,
    attainmentPct: summary.overall.attainmentPct,
    medianMinutes: summary.overall.medianMinutes,
    p90Minutes: summary.overall.p90Minutes,
    openBreached: summary.overall.openBreached,
  };
  // Sandbox runs never write to the log.
  if (!cfg.sandbox) trendState.trend = trendState.trend.concat([entry]).slice(-26);

  return [{ json: { mode, sandbox: cfg.sandbox, nowMs, ui, summary, trend: { entry, previous, history: trendState.trend } } }];
}

// --- monitor mode: alert once per lead per escalation level (at risk, then breached) ---
const state = $getWorkflowStaticData('global');
state.alerted = state.alerted || {};
const cutoff = nowMs - 7 * 86400000;
Object.keys(state.alerted).forEach((k) => { if (state.alerted[k] < cutoff) delete state.alerted[k]; });

const keyOf = (e) => `${e.id}:${e.clockStartMs}:${e.status}`;
const fresh = evaluations.filter(
  (e) => (e.status === STATUS.OPEN_BREACHED || e.status === STATUS.OPEN_AT_RISK) && !state.alerted[keyOf(e)]
);
if (!fresh.length) return [];

// Sandbox runs never mark leads as alerted, so they cannot suppress real alerts later.
if (!cfg.sandbox) fresh.forEach((e) => { state.alerted[keyOf(e)] = nowMs; });

return [{ json: { mode, sandbox: cfg.sandbox, nowMs, ui, evaluations: fresh } }];
