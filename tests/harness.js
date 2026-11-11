'use strict';

/**
 * Minimal n8n Code-node harness: runs the REAL generated jsCode from workflows/*.json against
 * HubSpot-shaped sample data, with the HTTP nodes mocked. No n8n or network required.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const loadJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const loadWorkflow = (file) => loadJson(path.join('workflows', file));

const SAMPLE = () => ({
  contactSearch: loadJson('sample-data/hubspot/contacts-search-response.json'),
  associations: {
    calls: loadJson('sample-data/hubspot/associations-calls.json'),
    emails: loadJson('sample-data/hubspot/associations-emails.json'),
    meetings: loadJson('sample-data/hubspot/associations-meetings.json'),
  },
  engagements: {
    calls: loadJson('sample-data/hubspot/engagements-calls.json'),
    emails: loadJson('sample-data/hubspot/engagements-emails.json'),
    meetings: loadJson('sample-data/hubspot/engagements-meetings.json'),
  },
  openLeadsSearch: loadJson('sample-data/hubspot/open-leads-search-response.json'),
  reps: fs.readFileSync(path.join(ROOT, 'config/reps.sample.json'), 'utf8'),
});

const wrap = (arr) => ({ first: () => arr[0], last: () => arr[arr.length - 1], all: () => arr, item: arr[0] });

function runCodeNode(wf, nodeName, { input, nodes, env, staticData }) {
  const n = wf.nodes.find((x) => x.name === nodeName);
  if (!n) throw new Error(`No node named "${nodeName}"`);
  const $ = (name) => {
    if (!nodes[name]) throw new Error(`Node "${name}" has no output in this simulation`);
    return wrap(nodes[name]);
  };
  const fn = new Function('$input', '$', '$env', '$getWorkflowStaticData', n.parameters.jsCode);
  return fn(wrap(input), $, env || {}, () => staticData);
}

/** Freeze Date.now() while fn runs so results are deterministic. */
function withFixedNow(iso, fn) {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/**
 * Simulate workflow 1 end to end (Load Config -> ... -> Build Slack Message).
 * Returns the output of every step so tests / the demo can inspect any of them.
 */
function simulateMonitor({ mode = 'monitor', nowIso, env = {}, staticData = {}, data = SAMPLE() }) {
  const wf = loadWorkflow('01-speed-to-lead-monitor-and-report.json');
  return withFixedNow(nowIso, () => {
    const nodes = {};
    const run = (name, input) => {
      const out = runCodeNode(wf, name, { input, nodes, env, staticData });
      nodes[name] = out;
      return out;
    };
    const result = { nodes, stoppedAt: null };
    const stop = (name) => {
      result.stoppedAt = name;
      return result;
    };

    run('Load Config', [{ json: { mode } }]);
    // HTTP: Search New Leads (mocked)
    nodes['Search New Leads'] = [{ json: data.contactSearch }];
    if (!run('Normalize Leads', nodes['Search New Leads']).length) return stop('Normalize Leads');

    const requests = run('Build Association Requests', nodes['Normalize Leads']);
    // HTTP: Get Associations (mocked, one response per request item)
    nodes['Get Associations'] = requests.map((r) => ({ json: data.associations[r.json.toObjectType] }));
    const detail = run('Build Detail Requests', nodes['Get Associations']);

    let evaluateInput;
    if (detail[0].json.skip === true) {
      evaluateInput = detail;
    } else {
      // HTTP: Read Engagement Details (mocked; only return the IDs that were requested)
      evaluateInput = detail.map((r) => {
        const wanted = new Set(r.json.body.inputs.map((i) => i.id));
        const all = data.engagements[r.json.objectType];
        if (!Array.isArray(all.results)) return { json: all }; // mocked HubSpot error body passes through untouched
        return { json: Object.assign({}, all, { results: all.results.filter((x) => wanted.has(x.id)) }) };
      });
      nodes['Read Engagement Details'] = evaluateInput;
    }
    if (!run('Evaluate SLA', evaluateInput).length) return stop('Evaluate SLA');
    run('Build Slack Message', nodes['Evaluate SLA']);
    return result;
  });
}

/** Simulate workflow 2 (Load Config & Validate -> Count Open Leads (mocked) -> Pick Rep -> Format Response). */
function simulateAssignment({ nowIso, env = {}, staticData = {}, body = { contactId: '301' }, contact, wrote = false, data = SAMPLE() }) {
  const wf = loadWorkflow('02-round-robin-lead-assignment.json');
  return withFixedNow(nowIso, () => {
    const nodes = {};
    const run = (name, input) => {
      const out = runCodeNode(wf, name, { input, nodes, env, staticData });
      nodes[name] = out;
      return out;
    };
    run('Load Config & Validate', [{ json: { body, headers: {} } }]);
    nodes['Get Contact'] = [{ json: contact || { id: String(body.contactId), properties: { firstname: 'Test', lastname: 'Lead', email: 'test.lead@example.com', company: 'Example Co', hs_lead_status: 'NEW' } } }];
    nodes['Count Open Leads'] = [{ json: data.openLeadsSearch }];
    const pick = run('Pick Rep', nodes['Count Open Leads']);
    // Skip Write / Assign Owner (mocked): the PATCH response has `properties` and no `decision`.
    const formatInput = wrote ? [{ json: { id: String(body.contactId), properties: { hubspot_owner_id: pick[0].json.decision.ownerId } } }] : pick;
    const formatted = run('Format Response', formatInput);
    return { nodes, pick: pick[0].json, formatted: formatted[0].json };
  });
}

module.exports = { ROOT, loadJson, loadWorkflow, SAMPLE, runCodeNode, withFixedNow, simulateMonitor, simulateAssignment };
