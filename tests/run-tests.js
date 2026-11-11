'use strict';

/** Zero-dependency unit + simulation tests. Run with: npm test */

const assert = require('assert');
const { performance } = require('perf_hooks');

const bh = require('../src/business-hours');
const { evaluateLead, STATUS } = require('../src/sla-evaluator');
const { summarize, median, percentile } = require('../src/metrics');
const { loadConfig, readEnv, parseReps } = require('../src/config');
const hs = require('../src/hubspot');
const { pickRep, isOutOfOffice } = require('../src/round-robin');
const slack = require('../src/slack-blocks');
const { simulateMonitor, simulateAssignment, SAMPLE, loadWorkflow } = require('./harness');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push({ name, e });
    console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`);
  }
}

const NY = { timezone: 'America/New_York', startTime: '09:00', endTime: '17:00', workdays: [1, 2, 3, 4, 5], holidays: [] };
const at = (y, m, d, h, min, tz) => bh.localToUtcMs(y, m, d, h, min, tz || NY.timezone);

console.log('\nbusiness-hours');
test('same-day minutes', () => assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 10, 10, 0), at(2026, 11, 10, 10, 30), NY), 30));
test('overnight skips closed hours (Tue 16:50 -> Wed 09:10 = 20)', () =>
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 10, 16, 50), at(2026, 11, 11, 9, 10), NY), 20));
test('weekend skipped (Fri 16:45 -> Mon 09:15 = 30)', () =>
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 6, 16, 45), at(2026, 11, 9, 9, 15), NY), 30));
test('holiday skipped (Wed 16:30 -> Fri 09:30 around Thanksgiving = 60)', () =>
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 25, 16, 30), at(2026, 11, 27, 9, 30), { ...NY, holidays: ['2026-11-26'] }), 60));
test('DST spring-forward handled (Fri 16:00 EST -> Mon 10:00 EDT = 120)', () =>
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 3, 6, 16, 0), at(2026, 3, 9, 10, 0), NY), 120));
test('DST fall-back handled (Fri 16:00 EDT -> Mon 10:00 EST = 120)', () =>
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 10, 30, 16, 0), at(2026, 11, 2, 10, 0), NY), 120));
test('non-US week: Dhaka Sun-Thu (Thu 16:30 -> Sun 09:30 = 60)', () => {
  const dhaka = { timezone: 'Asia/Dhaka', startTime: '09:00', endTime: '17:00', workdays: [7, 1, 2, 3, 4], holidays: [] };
  assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 12, 16, 30, 'Asia/Dhaka'), at(2026, 11, 15, 9, 30, 'Asia/Dhaka'), dhaka), 60);
});
test('end before start returns 0', () => assert.strictEqual(bh.businessMinutesBetween(at(2026, 11, 10, 11, 0), at(2026, 11, 10, 10, 0), NY), 0));
test('addBusinessMinutes rolls to next business day (Fri 16:50 + 30 = Mon 09:20)', () =>
  assert.strictEqual(bh.addBusinessMinutes(at(2026, 11, 6, 16, 50), 30, NY), at(2026, 11, 9, 9, 20)));
test('addBusinessMinutes from after-hours starts at next open (Fri 22:30 + 15 = Mon 09:15)', () =>
  assert.strictEqual(bh.addBusinessMinutes(at(2026, 11, 6, 22, 30), 15, NY), at(2026, 11, 9, 9, 15)));
test('isWithinBusinessHours', () => {
  assert.strictEqual(bh.isWithinBusinessHours(at(2026, 11, 10, 12, 0), NY), true);
  assert.strictEqual(bh.isWithinBusinessHours(at(2026, 11, 10, 17, 0), NY), false);
  assert.strictEqual(bh.isWithinBusinessHours(at(2026, 11, 14, 12, 0), NY), false);
});
test('bad config is rejected with readable errors', () => {
  assert.throws(() => bh.normalizeHours({ timezone: 'Mars/Olympus' }), /Invalid time zone/);
  assert.throws(() => bh.normalizeHours({ startTime: '17:00', endTime: '09:00' }), /after startTime/);
  assert.throws(() => bh.normalizeHours({ workdays: [0] }), /ISO weekdays/);
});
test('performance: 30-day span computes quickly', () => {
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) bh.businessMinutesBetween(at(2026, 10, 1, 9, 0), at(2026, 10, 31, 17, 0), NY);
  assert.ok(performance.now() - t0 < 2000, 'too slow');
});

console.log('\nsla-evaluator');
const EVAL_CFG = { slaMinutes: 15, warnPct: 0.75, hours: NY };
const lead = (clockStartMs) => ({ id: '1', name: 'A', email: 'a@example.com', company: '', ownerId: '10', source: 'x', clockStartMs });
const t0 = at(2026, 11, 10, 10, 0);
const plus = (min) => t0 + min * 60000;
test('MET when touched inside SLA', () => assert.strictEqual(evaluateLead(lead(t0), [{ type: 'call', at: plus(10) }], plus(60), EVAL_CFG).status, STATUS.MET));
test('exactly at SLA counts as MET', () => assert.strictEqual(evaluateLead(lead(t0), [{ type: 'call', at: plus(15) }], plus(60), EVAL_CFG).status, STATUS.MET));
test('BREACHED_LATE when touched after SLA', () => assert.strictEqual(evaluateLead(lead(t0), [{ type: 'email', at: plus(16) }], plus(60), EVAL_CFG).status, STATUS.BREACHED_LATE));
test('OPEN_WITHIN_SLA / OPEN_AT_RISK / OPEN_BREACHED thresholds', () => {
  assert.strictEqual(evaluateLead(lead(t0), [], plus(10), EVAL_CFG).status, STATUS.OPEN_WITHIN_SLA);
  assert.strictEqual(evaluateLead(lead(t0), [], plus(12), EVAL_CFG).status, STATUS.OPEN_AT_RISK);
  assert.strictEqual(evaluateLead(lead(t0), [], plus(16), EVAL_CFG).status, STATUS.OPEN_BREACHED);
});
test('touches before the clock started are ignored', () => assert.strictEqual(evaluateLead(lead(t0), [{ type: 'call', at: plus(-500) }], plus(30), EVAL_CFG).status, STATUS.OPEN_BREACHED));
test('earliest touch wins', () => {
  const e = evaluateLead(lead(t0), [{ type: 'email', at: plus(20) }, { type: 'call', at: plus(5) }], plus(60), EVAL_CFG);
  assert.strictEqual(e.firstTouchType, 'call');
  assert.strictEqual(e.minutesToFirstTouch, 5);
});
test('after-hours lead: clock waits for next open', () => {
  const fri1730 = at(2026, 11, 6, 17, 30);
  const e = evaluateLead(lead(fri1730), [], at(2026, 11, 8, 12, 0), EVAL_CFG); // Sunday noon
  assert.strictEqual(e.elapsedBusinessMinutes, 0);
  assert.strictEqual(e.status, STATUS.OPEN_WITHIN_SLA);
  assert.strictEqual(e.dueAtMs, at(2026, 11, 9, 9, 15));
});
test('unassigned flag', () => assert.strictEqual(evaluateLead({ ...lead(t0), ownerId: null }, [], plus(1), EVAL_CFG).unassigned, true));

console.log('\nmetrics');
test('median / percentile helpers', () => {
  assert.strictEqual(median([1, 2, 3]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  assert.strictEqual(median([]), null);
  assert.strictEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});

console.log('\nconfig');
test('defaults are safe: sandbox on, 15 min SLA', () => {
  const c = loadConfig({});
  assert.strictEqual(c.sandbox, true);
  assert.strictEqual(c.slaMinutes, 15);
  assert.deepStrictEqual(c.hours.workdays, [1, 2, 3, 4, 5]);
});
test('sandbox is fail-safe: only an explicit off word disables it (typos keep it ON)', () => {
  for (const off of ['false', 'FALSE', '0', 'no', 'off']) assert.strictEqual(loadConfig({ SANDBOX_MODE: off }).sandbox, false, off);
  for (const on of ['true', '', 'flase', 'maybe', undefined]) assert.strictEqual(loadConfig({ SANDBOX_MODE: on }).sandbox, true, String(on));
});
test('invalid values fail loudly', () => {
  assert.throws(() => loadConfig({ SLA_MINUTES: 'abc' }), /must be a number/);
  assert.throws(() => loadConfig({ SLA_MINUTES: '0' }), /greater than 0/);
  assert.throws(() => loadConfig({ SLA_WARN_PCT: '2' }), /between 0/);
  assert.throws(() => loadConfig({ REPS_JSON: '{nope' }), /not valid JSON/);
  assert.throws(() => loadConfig({ REPS_JSON: '[{"id":"1"}]' }), /needs at least/);
  assert.throws(() => parseReps('[{"id":"1","name":"A"},{"id":"1","name":"B"}]'), /duplicate/);
});
test('readEnv survives blocked env access', () => {
  const blocked = new Proxy({}, { get() { throw new Error('access to env vars denied'); } });
  assert.deepStrictEqual(readEnv(blocked), {});
  assert.strictEqual(loadConfig(readEnv(blocked)).sandbox, true);
});

console.log('\nhubspot helpers');
test('search body covers created OR re-submitted within lookback', () => {
  const cfg = loadConfig({});
  const now = Date.parse('2026-11-10T20:30:00Z');
  const body = hs.buildLeadSearchBody(cfg, 'monitor', now);
  assert.strictEqual(body.filterGroups.length, 2);
  assert.strictEqual(body.filterGroups[0].filters[0].value, String(now - 96 * 3600000));
  assert.strictEqual(hs.buildLeadSearchBody(cfg, 'report', now).filterGroups[0].filters[0].value, String(now - 7 * 86400000));
});
test('inbound calls / incoming emails do not count as touches; meetings count at booking time', () => {
  assert.strictEqual(hs.touchFromEngagement('calls', { hs_call_direction: 'INBOUND', hs_timestamp: '2026-11-10T20:12:00Z' }), null);
  assert.strictEqual(hs.touchFromEngagement('emails', { hs_email_direction: 'INCOMING_EMAIL', hs_timestamp: '2026-11-10T20:12:00Z' }), null);
  assert.strictEqual(hs.touchFromEngagement('emails', { hs_email_direction: 'EMAIL', hs_timestamp: '2026-11-10T20:12:00Z' }).type, 'email');
  const m = hs.touchFromEngagement('meetings', { hs_createdate: '2026-11-10T19:52:00Z', hs_timestamp: '2026-11-12T15:00:00Z' });
  assert.strictEqual(m.at, Date.parse('2026-11-10T19:52:00Z'));
});
test('parseHsDate accepts ISO and epoch strings', () => {
  assert.strictEqual(hs.parseHsDate('2026-11-10T20:30:00.000Z'), Date.parse('2026-11-10T20:30:00Z'));
  assert.strictEqual(hs.parseHsDate('1794342600000'), 1794342600000);
  assert.strictEqual(hs.parseHsDate(''), null);
});
test('HubSpot error bodies are surfaced, never treated as "no touches"', () => {
  assert.throws(() => hs.assertResults({ status: 'error', message: 'rate limit' }, 'x'), /did not contain a results array/);
  assert.throws(() => hs.buildAssocMap([{ results: [] }, { status: 'error' }, { results: [] }]), /associations contacts->emails/);
});
test('detail requests: chunking and the always-one-item guarantee', () => {
  const big = { calls: {}, emails: {}, meetings: {} };
  big.calls['1'] = Array.from({ length: 250 }, (_, i) => String(i + 1));
  const reqs = hs.buildDetailRequests(big);
  assert.strictEqual(reqs.length, 3);
  assert.strictEqual(reqs[0].body.inputs.length, 100);
  assert.strictEqual(reqs[2].body.inputs.length, 50);
  const none = hs.buildDetailRequests({ calls: {}, emails: {}, meetings: {} });
  assert.strictEqual(none.length, 1);
  assert.strictEqual(none[0].skip, true);
});

console.log('\nround-robin');
const REPS = parseReps(SAMPLE().reps);
const RR = (over) => pickRep({ reps: REPS, openCounts: {}, lastAssignedIndex: -1, nowMs: Date.parse('2026-11-10T20:30:00Z'), timezone: 'America/New_York', fallbackOwnerId: '', ...over });
test('starts at the first rep, then rotates', () => {
  assert.strictEqual(RR({}).ownerId, '1001');
  assert.strictEqual(RR({ lastAssignedIndex: 0 }).ownerId, '1002');
});
test('skips at-capacity rep', () => {
  const r = RR({ lastAssignedIndex: 0, openCounts: { 1002: 3 } });
  assert.strictEqual(r.ownerId, '1003');
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['at_capacity']);
});
test('skips out-of-office and inactive reps (wraps around)', () => {
  const r = RR({ lastAssignedIndex: 2 }); // next is 1004 (OOO), then 1005 (inactive), then wraps to 1001
  assert.strictEqual(r.ownerId, '1001');
  assert.deepStrictEqual(r.skipped.map((s) => s.reason), ['out_of_office', 'inactive']);
});
test('OOO window is inclusive and uses the business time zone', () => {
  const rep = { ooo: [{ from: '2026-11-09', to: '2026-11-10' }] };
  assert.strictEqual(isOutOfOffice(rep, Date.parse('2026-11-11T03:00:00Z'), 'America/New_York'), true); // still Nov 10 in New York
  assert.strictEqual(isOutOfOffice(rep, Date.parse('2026-11-11T06:00:00Z'), 'America/New_York'), false); // Nov 11 01:00 local
});
test('falls back to the fallback owner when nobody is eligible', () => {
  const all = REPS.map((r) => ({ ...r, active: false }));
  const r = pickRep({ reps: all, openCounts: {}, lastAssignedIndex: -1, nowMs: 0, timezone: 'UTC', fallbackOwnerId: '9999' });
  assert.strictEqual(r.strategy, 'FALLBACK_OWNER');
  assert.strictEqual(r.ownerId, '9999');
  assert.strictEqual(r.skipped.length, 5);
});
test('no fallback configured => NO_ASSIGNMENT (never invents an owner)', () => {
  const r = pickRep({ reps: [], openCounts: {}, lastAssignedIndex: -1, nowMs: 0, timezone: 'UTC', fallbackOwnerId: '' });
  assert.strictEqual(r.action, 'NO_ASSIGNMENT');
  assert.strictEqual(r.ownerId, null);
});

console.log('\nslack blocks');
test('payloads respect Slack limits and escape user text', () => {
  const evals = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), name: `<b>Lead ${i}</b> & co | x`, company: 'A&B', ownerId: null, unassigned: true, ownerName: null,
    elapsedBusinessMinutes: 20 + i, slaMinutes: 15, dueAtMs: Date.now(), source: 'Form: Test', status: 'OPEN_BREACHED',
  }));
  const p = slack.buildBreachAlert(evals, { portalId: '123', timezone: 'UTC', maxLeads: 10 });
  assert.ok(p.blocks.length <= 50);
  assert.ok(p.blocks.some((b) => b.type === 'context' && /\+20 more/.test(b.elements[0].text)));
  const text = JSON.stringify(p);
  assert.ok(!text.includes('<b>'));
  assert.ok(text.includes('app.hubspot.com/contacts/123/record/0-1/'));
});
test('sandbox label appears in headers', () => {
  const p = slack.buildWeeklyReport(summarize([], {}), { sandbox: true }, Date.now());
  assert.ok(p.blocks[0].text.text.startsWith('[SANDBOX]'));
});

console.log('\nworkflow simulation (real generated Code-node code, mocked HTTP)');
const NOW = '2026-11-10T20:30:00.000Z';
const REPS_ENV = { REPS_JSON: SAMPLE().reps, HUBSPOT_PORTAL_ID: '1234567', BUSINESS_TIMEZONE: 'America/New_York' };

test('monitor: statuses match the expected outcome for every sample lead', () => {
  const r = simulateMonitor({ nowIso: NOW, env: REPS_ENV, staticData: {} });
  const statusById = Object.fromEntries(r.nodes['Evaluate SLA'][0].json.evaluations.map((e) => [e.id, e.status]));
  // Only new at-risk / breached leads come out of the monitor:
  assert.deepStrictEqual(statusById, { 102: 'OPEN_BREACHED', 103: 'OPEN_AT_RISK', 104: 'OPEN_BREACHED' });
});
test('monitor: sandbox is the default and nothing is marked as alerted', () => {
  const sd = {};
  const r = simulateMonitor({ nowIso: NOW, env: REPS_ENV, staticData: sd });
  assert.strictEqual(r.nodes['Build Slack Message'][0].json.sandbox, true);
  assert.ok(!sd.alerted || Object.keys(sd.alerted).length === 0);
});
test('monitor: live mode alerts once, then stays quiet (de-duplication)', () => {
  const sd = {};
  const env = { ...REPS_ENV, SANDBOX_MODE: 'false' };
  const first = simulateMonitor({ nowIso: NOW, env, staticData: sd });
  assert.strictEqual(first.nodes['Build Slack Message'][0].json.sandbox, false);
  assert.strictEqual(Object.keys(sd.alerted).length, 3);
  const second = simulateMonitor({ nowIso: '2026-11-10T20:35:00.000Z', env, staticData: sd });
  // 5 minutes later the at-risk lead (103) has escalated to breached => one NEW alert, the other two are suppressed.
  const ids = second.nodes['Evaluate SLA'][0].json.evaluations.map((e) => `${e.id}:${e.status}`);
  assert.deepStrictEqual(ids, ['103:OPEN_BREACHED']);
  // 20:40: nothing already alerted repeats; the newest lead (108, now 13 min old) is the only new at-risk alert.
  const third = simulateMonitor({ nowIso: '2026-11-10T20:40:00.000Z', env, staticData: sd });
  assert.deepStrictEqual(third.nodes['Evaluate SLA'][0].json.evaluations.map((e) => `${e.id}:${e.status}`), ['108:OPEN_AT_RISK']);
  // Running again at the same minute alerts on nothing: the run ends quietly.
  const fourth = simulateMonitor({ nowIso: '2026-11-10T20:40:00.000Z', env, staticData: sd });
  assert.strictEqual(fourth.stoppedAt, 'Evaluate SLA');
});
test('monitor: alert payload ordering, owner names, unassigned handling', () => {
  const r = simulateMonitor({ nowIso: NOW, env: REPS_ENV, staticData: {} });
  const payload = r.nodes['Build Slack Message'][0].json.payload;
  const body = JSON.stringify(payload);
  assert.ok(payload.blocks[0].text.text.startsWith('[SANDBOX]'));
  assert.ok(body.indexOf('Tom Becker') < body.indexOf('Liam O&#39;Connor') || body.indexOf('Tom Becker') < body.indexOf("Liam O'Connor"));
  assert.ok(body.includes('*Unassigned*'));
  assert.ok(body.includes('Casey Morgan'));
  assert.ok(!body.includes('Existing Customer'), 'lifecycle=customer must be excluded');
});
test('report: summary numbers are exactly right', () => {
  const r = simulateMonitor({ mode: 'report', nowIso: NOW, env: REPS_ENV, staticData: {} });
  const s = r.nodes['Evaluate SLA'][0].json.summary;
  assert.strictEqual(s.overall.leads, 8);
  assert.strictEqual(s.overall.met, 3);
  assert.strictEqual(s.overall.breachedLate, 1);
  assert.strictEqual(s.overall.openBreached, 2);
  assert.strictEqual(s.overall.decided, 6);
  assert.strictEqual(s.overall.attainmentPct, 50);
  const by = Object.fromEntries(s.byOwner.map((o) => [o.name, o]));
  assert.strictEqual(by['Jordan Blake'].attainmentPct, 100);
  assert.strictEqual(by['Jordan Blake'].medianMinutes, 7);
  assert.strictEqual(by['Casey Morgan'].attainmentPct, 0);
  assert.strictEqual(by['Riley Patel'].leads, 2);
  assert.strictEqual(by['Unassigned'].openBreached, 1);
});
test('report: trend log is written in live mode only and the next report shows the delta', () => {
  const sandboxState = {};
  simulateMonitor({ mode: 'report', nowIso: NOW, env: REPS_ENV, staticData: sandboxState });
  assert.ok(!sandboxState.trend || sandboxState.trend.length === 0, 'sandbox must not write the trend log');

  const sd = {};
  const live = { ...REPS_ENV, SANDBOX_MODE: 'false' };
  const first = simulateMonitor({ mode: 'report', nowIso: '2026-11-03T13:00:00.000Z', env: live, staticData: sd });
  assert.strictEqual(sd.trend.length, 1);
  assert.strictEqual(first.nodes['Evaluate SLA'][0].json.trend.previous, null);
  const second = simulateMonitor({ mode: 'report', nowIso: NOW, env: live, staticData: sd });
  assert.strictEqual(sd.trend.length, 2);
  assert.strictEqual(second.nodes['Evaluate SLA'][0].json.trend.previous.date, '2026-11-03');
  assert.ok(/Trend vs 2026-11-03/.test(JSON.stringify(second.nodes['Build Slack Message'][0].json.payload)));
});
test('trend line formatting', () => {
  assert.strictEqual(slack.trendLine({ attainmentPct: 62.5, medianMinutes: 9 }, { date: 'D', attainmentPct: 50, medianMinutes: 12 }), 'Trend vs D: attainment +12.5 pts · median −3 min');
  assert.strictEqual(slack.trendLine({ attainmentPct: null, medianMinutes: null }, { date: 'D', attainmentPct: 50, medianMinutes: 12 }), '');
  assert.strictEqual(slack.trendLine({ attainmentPct: 1, medianMinutes: 1 }, null), '');
});
test('report: after-hours lead (Fri 17:30) is measured from Monday open, not from creation', () => {
  const r = simulateMonitor({ mode: 'report', nowIso: NOW, env: REPS_ENV, staticData: {} });
  // summary doesn't list per-lead data, so re-run the evaluator directly through the monitor in live mode is unnecessary:
  const s = r.nodes['Evaluate SLA'][0].json.summary;
  const jordan = s.byOwner.find((o) => o.name === 'Jordan Blake');
  assert.strictEqual(jordan.met, 2); // Maya (8 min) + Daniel (6 business min after the weekend)
});
test('report: form re-submission restarts the clock and old touches are ignored (Grace = MET at 12 min)', () => {
  const r = simulateMonitor({ mode: 'report', nowIso: NOW, env: REPS_ENV, staticData: {} });
  const riley = r.nodes['Evaluate SLA'][0].json.summary.byOwner.find((o) => o.name === 'Riley Patel');
  assert.strictEqual(riley.met, 1);
  assert.strictEqual(riley.medianMinutes, 12);
});
test('empty search result stops quietly', () => {
  const data = SAMPLE();
  data.contactSearch = { total: 0, results: [] };
  assert.strictEqual(simulateMonitor({ nowIso: NOW, env: REPS_ENV, data }).stoppedAt, 'Normalize Leads');
});
test('no engagements at all still evaluates (untouched leads must not vanish)', () => {
  const data = SAMPLE();
  for (const t of ['calls', 'emails', 'meetings']) data.associations[t] = { status: 'COMPLETE', results: [] };
  const r = simulateMonitor({ nowIso: NOW, env: REPS_ENV, data });
  assert.strictEqual(r.nodes['Build Detail Requests'][0].json.skip, true);
  const ids = r.nodes['Evaluate SLA'][0].json.evaluations.map((e) => e.id).sort();
  assert.ok(ids.includes('101') && ids.includes('102') && ids.includes('104'));
});
test('HubSpot API error is thrown, not silently treated as "nobody touched"', () => {
  const data = SAMPLE();
  data.engagements.calls = { status: 'error', message: 'rate limited' };
  assert.throws(() => simulateMonitor({ nowIso: NOW, env: REPS_ENV, data }), /did not contain a results array/);
});

test('assignment: sandbox returns a decision, writes nothing, does not advance rotation', () => {
  const sd = {};
  const r = simulateAssignment({ nowIso: NOW, env: REPS_ENV, staticData: sd });
  assert.strictEqual(r.formatted.response.sandbox, true);
  assert.strictEqual(r.formatted.response.wroteToHubSpot, false);
  assert.strictEqual(r.formatted.response.ownerId, '1001');
  assert.strictEqual(sd.lastAssignedIndex, undefined);
});
test('assignment: live mode rotates and respects capacity (Casey has 3/3 open)', () => {
  const sd = {};
  const env = { ...REPS_ENV, SANDBOX_MODE: 'false' };
  const a = simulateAssignment({ nowIso: NOW, env, staticData: sd, wrote: true });
  assert.strictEqual(a.formatted.response.ownerId, '1001');
  assert.strictEqual(a.formatted.response.wroteToHubSpot, true);
  assert.deepStrictEqual(a.pick.patchBody, { properties: { hubspot_owner_id: '1001' } });
  const b = simulateAssignment({ nowIso: NOW, env, staticData: sd, wrote: true });
  assert.strictEqual(b.formatted.response.ownerId, '1003'); // 1002 skipped: at capacity
  assert.deepStrictEqual(b.formatted.response.skipped.map((s) => s.reason), ['at_capacity']);
});
test('assignment: leaves an already-owned contact alone by default', () => {
  const r = simulateAssignment({ nowIso: NOW, env: { ...REPS_ENV, SANDBOX_MODE: 'false' }, contact: { id: '301', properties: { hubspot_owner_id: '1003', email: 'x@example.com' } } });
  assert.strictEqual(r.formatted.response.action, 'SKIP_ALREADY_OWNED');
  assert.strictEqual(r.pick.shouldAssign, false);
  assert.strictEqual(r.formatted.needsAlert, false);
});
test('assignment: fallback owner + Slack alert when nobody is eligible', () => {
  const reps = JSON.stringify([{ id: '1', name: 'Only Rep', active: false }]);
  const r = simulateAssignment({ nowIso: NOW, env: { REPS_JSON: reps, SANDBOX_MODE: 'false', FALLBACK_OWNER_ID: '777' } });
  assert.strictEqual(r.formatted.response.strategy, 'FALLBACK_OWNER');
  assert.strictEqual(r.formatted.response.ownerId, '777');
  assert.strictEqual(r.formatted.needsAlert, true);
  assert.ok(JSON.stringify(r.formatted.slackPayload).includes('inactive'));
});
test('assignment: rejects a webhook body without a numeric contactId', () => {
  assert.throws(() => simulateAssignment({ nowIso: NOW, env: REPS_ENV, body: { contactId: "1; DROP TABLE" } }), /numeric contactId/);
});

console.log('\nworkflow JSON integrity');
for (const file of ['01-speed-to-lead-monitor-and-report.json', '02-round-robin-lead-assignment.json']) {
  test(`${file}: connections reference real nodes, names/ids unique, no secrets`, () => {
    const wf = loadWorkflow(file);
    const names = new Set(wf.nodes.map((n) => n.name));
    assert.strictEqual(names.size, wf.nodes.length, 'duplicate node names');
    assert.strictEqual(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length, 'duplicate node ids');
    for (const [from, v] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `unknown source ${from}`);
      v.main.flat().forEach((c) => assert.ok(names.has(c.node), `unknown target ${c.node}`));
    }
    const raw = JSON.stringify(wf);
    assert.ok(!/xox[bpas]-|hooks\.slack\.com\/services|pat-[a-z]{2}\d?-[0-9a-f-]{20,}/i.test(raw), 'looks like a secret is embedded');
    assert.strictEqual(wf.active, false, 'workflows must ship inactive');
  });
}
test('workflow 1 is read-only on HubSpot (no PATCH/PUT/DELETE, no write endpoints)', () => {
  const wf = loadWorkflow('01-speed-to-lead-monitor-and-report.json');
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) {
    assert.ok(['POST', 'GET'].includes(n.parameters.method));
    if (n.name !== 'Post to Slack') assert.ok(/(search|batch\/read)/.test(n.parameters.url), `${n.name} is not a read endpoint: ${n.parameters.url}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
