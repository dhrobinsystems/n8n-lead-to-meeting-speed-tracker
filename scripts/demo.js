#!/usr/bin/env node
'use strict';

/**
 * Offline demo: runs the real workflow Code-node logic against bundled HubSpot-shaped sample data
 * (no n8n, no HubSpot, no Slack, no network).
 *
 *   npm run demo            print the results
 *   npm run demo -- --write refresh sample-data/expected-output/*.json
 */

const fs = require('fs');
const path = require('path');
const { simulateMonitor, simulateAssignment, SAMPLE, ROOT } = require('../tests/harness');

const NOW = '2026-11-10T20:30:00.000Z'; // Tue 15:30 in New York
const env = { REPS_JSON: SAMPLE().reps, HUBSPOT_PORTAL_ID: '1234567', BUSINESS_TIMEZONE: 'America/New_York' };
const write = process.argv.includes('--write');
const out = (name, obj) => write && fs.writeFileSync(path.join(ROOT, 'sample-data/expected-output', name), JSON.stringify(obj, null, 2) + '\n');

const monitor = simulateMonitor({ nowIso: NOW, env, staticData: {} });
const report = simulateMonitor({ mode: 'report', nowIso: NOW, env, staticData: {} });
const assign = simulateAssignment({ nowIso: NOW, env });

const pad = (s, n) => String(s).padEnd(n);
const fmtTime = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });

console.log(`\nSpeed-to-Lead Tracker demo  |  "now" = ${fmtTime(Date.parse(NOW))} New York  |  SLA = 15 business minutes\n`);
console.log('1) Monitor run: leads that need a Slack alert');
console.log('   ' + pad('Lead', 16) + pad('Owner', 14) + pad('Status', 15) + pad('Waiting', 10) + 'SLA due');
for (const e of monitor.nodes['Evaluate SLA'][0].json.evaluations.sort((a, b) => b.elapsedBusinessMinutes - a.elapsedBusinessMinutes)) {
  console.log('   ' + pad(e.name, 16) + pad(e.ownerName || (e.unassigned ? '(unassigned)' : e.ownerId), 14) + pad(e.status, 15) + pad(`${e.elapsedBusinessMinutes} min`, 10) + fmtTime(e.dueAtMs));
}

const s = report.nodes['Evaluate SLA'][0].json.summary;
console.log('\n2) Weekly report: rep-level response times');
console.log('   ' + pad('Owner', 16) + pad('Leads', 7) + pad('Attainment', 12) + pad('Median', 10) + pad('P90', 10) + 'Untouched');
for (const r of s.byOwner) {
  console.log('   ' + pad(r.name, 16) + pad(r.leads, 7) + pad(r.attainmentPct === null ? 'n/a' : `${r.attainmentPct}%`, 12) + pad(r.medianMinutes === null ? 'n/a' : `${r.medianMinutes} min`, 10) + pad(r.p90Minutes === null ? 'n/a' : `${r.p90Minutes} min`, 10) + r.openBreached);
}
console.log(`   ${pad('ALL', 16)}${pad(s.overall.leads, 7)}${pad(`${s.overall.attainmentPct}%`, 12)}${pad(`${s.overall.medianMinutes} min`, 10)}${pad(`${s.overall.p90Minutes} min`, 10)}${s.overall.openBreached}`);

const d = assign.formatted.response;
console.log('\n3) Round-robin: next new lead');
console.log(`   -> ${d.ownerName} (${d.strategy}); skipped: ${d.skipped.length ? d.skipped.map((x) => `${x.name} [${x.reason}]`).join(', ') : 'none'}; wroteToHubSpot=${d.wroteToHubSpot} (sandbox)`);

out('evaluations-monitor.json', monitor.nodes['Evaluate SLA'][0].json.evaluations);
out('weekly-summary.json', s);
out('slack-sla-alert.json', monitor.nodes['Build Slack Message'][0].json.payload);
out('slack-weekly-report.json', report.nodes['Build Slack Message'][0].json.payload);
out('assignment-decision.json', assign.formatted.response);
console.log(write ? '\nWrote sample-data/expected-output/*.json (paste the slack-*.json files into Slack Block Kit Builder to preview).\n' : '\nTip: add --write to refresh sample-data/expected-output/.\n');
