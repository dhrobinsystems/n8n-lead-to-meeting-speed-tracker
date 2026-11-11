'use strict';

/**
 * HubSpot helpers: build API request bodies, normalize API responses into leads and touches.
 * Pure functions only - the n8n HTTP Request nodes do the actual network calls.
 *
 * NOTE: property names below are standard HubSpot CRM properties, but portals differ.
 * Verify them in your own portal (see docs/SETUP.md > "Verify property names").
 */

const LEAD_PROPERTIES = [
  'createdate',
  'recent_conversion_date',
  'recent_conversion_event_name',
  'firstname',
  'lastname',
  'email',
  'company',
  'hubspot_owner_id',
  'hs_lead_status',
  'lifecyclestage',
  'hs_latest_sequence_enrolled_date',
];

const ENGAGEMENT_TYPES = ['calls', 'emails', 'meetings'];

const DETAIL_PROPERTIES = {
  calls: ['hs_timestamp', 'hs_call_direction'],
  emails: ['hs_timestamp', 'hs_email_direction'],
  meetings: ['hs_timestamp', 'hs_createdate', 'hs_meeting_outcome'],
};

function assertResults(body, label) {
  if (!body || !Array.isArray(body.results)) {
    throw new Error(
      `HubSpot response for "${label}" did not contain a results array: ${JSON.stringify(body).slice(0, 300)}`
    );
  }
}

/** HubSpot returns ISO strings or epoch-ms strings depending on endpoint. Accept both. */
function parseHsDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Search body: contacts created (or re-submitted via form) inside the lookback window. */
function buildLeadSearchBody(cfg, mode, nowMs) {
  const sinceMs = mode === 'report' ? nowMs - cfg.reportLookbackDays * 86400000 : nowMs - cfg.lookbackHours * 3600000;
  const since = String(Math.floor(sinceMs));
  const filterGroups = [{ filters: [{ propertyName: 'createdate', operator: 'GTE', value: since }] }];
  if (cfg.clockRestartsOnFormSubmit) {
    filterGroups.push({ filters: [{ propertyName: 'recent_conversion_date', operator: 'GTE', value: since }] });
  }
  return {
    filterGroups,
    sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
    properties: LEAD_PROPERTIES,
    limit: 100,
  };
}

/** Search body used by round-robin to count each rep's currently open leads. */
function buildOpenLeadSearchBody(cfg) {
  const ids = cfg.reps.map((r) => String(r.id));
  return {
    filterGroups: [
      {
        filters: [
          { propertyName: 'hubspot_owner_id', operator: 'IN', values: ids.length ? ids : ['0'] },
          { propertyName: 'hs_lead_status', operator: 'IN', values: cfg.openLeadStatuses },
        ],
      },
    ],
    properties: ['hubspot_owner_id'],
    limit: 100,
  };
}

/** Turn one HubSpot contact search result into a lead, or null if it should be skipped. */
function normalizeLead(result, cfg) {
  const p = (result && result.properties) || {};
  const createdAt = parseHsDate(p.createdate);
  const recentConversion = parseHsDate(p.recent_conversion_date);

  const stage = String(p.lifecyclestage || '').toLowerCase();
  if (stage && cfg.excludedLifecycleStages.includes(stage)) return null;

  const email = p.email ? String(p.email) : '';
  const domain = email.includes('@') ? email.split('@').pop().toLowerCase() : '';
  if (domain && cfg.excludedEmailDomains.includes(domain)) return null;

  let clockStartMs = createdAt;
  if (cfg.clockRestartsOnFormSubmit && recentConversion && (!createdAt || recentConversion > createdAt)) {
    clockStartMs = recentConversion;
  }
  if (!clockStartMs) return null;

  const eventName = p.recent_conversion_event_name ? String(p.recent_conversion_event_name) : '';
  const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();

  return {
    id: String(result.id),
    name: name || email || `Contact ${result.id}`,
    email,
    company: p.company ? String(p.company) : '',
    ownerId: p.hubspot_owner_id ? String(p.hubspot_owner_id) : null,
    leadStatus: p.hs_lead_status || null,
    lifecycleStage: stage || null,
    createdAtMs: createdAt,
    clockStartMs,
    sequenceEnrolledAtMs: parseHsDate(p.hs_latest_sequence_enrolled_date),
    source: eventName ? `Form: ${eventName}` : 'New contact',
  };
}

function normalizeLeads(results, cfg) {
  return results.map((r) => normalizeLead(r, cfg)).filter(Boolean);
}

/** assocResponses: HubSpot v4 batch-read association responses, in ENGAGEMENT_TYPES order. */
function buildAssocMap(assocResponses) {
  const map = {};
  ENGAGEMENT_TYPES.forEach((type, i) => {
    assertResults(assocResponses[i], `associations contacts->${type}`);
    map[type] = {};
    for (const row of assocResponses[i].results) {
      const from = row.from && row.from.id !== undefined ? String(row.from.id) : null;
      if (!from) continue;
      map[type][from] = (row.to || []).map((t) => String(t.toObjectId));
    }
  });
  return map;
}

/**
 * One batch-read request per type per 100 engagement IDs. Always returns at least one item so the
 * workflow keeps flowing when nobody has been touched yet (that is the case we care about most).
 */
function buildDetailRequests(assocMap, chunkSize) {
  const size = chunkSize || 100;
  const requests = [];
  for (const type of ENGAGEMENT_TYPES) {
    const ids = new Set();
    Object.values(assocMap[type] || {}).forEach((arr) => arr.forEach((id) => ids.add(id)));
    const list = Array.from(ids);
    for (let i = 0; i < list.length; i += size) {
      requests.push({
        objectType: type,
        skip: false,
        body: { properties: DETAIL_PROPERTIES[type], inputs: list.slice(i, i + size).map((id) => ({ id })) },
      });
    }
  }
  if (!requests.length) {
    requests.push({ objectType: 'calls', skip: true, body: { properties: DETAIL_PROPERTIES.calls, inputs: [] } });
  }
  requests[0].assocMap = assocMap;
  return requests;
}

/** Normalize one engagement into a touch, or null if it should not count as outreach. */
function touchFromEngagement(type, props) {
  const p = props || {};
  if (type === 'calls') {
    if (String(p.hs_call_direction || '').toUpperCase() === 'INBOUND') return null;
    const at = parseHsDate(p.hs_timestamp);
    return at ? { type: 'call', at } : null;
  }
  if (type === 'emails') {
    const dir = String(p.hs_email_direction || '').toUpperCase();
    if (dir === 'INCOMING_EMAIL' || dir === 'FORWARDED_EMAIL' || dir === 'INBOUND') return null;
    const at = parseHsDate(p.hs_timestamp);
    return at ? { type: 'email', at } : null;
  }
  if (type === 'meetings') {
    // A meeting counts when it is booked/logged (creation time), not when it takes place.
    const at = parseHsDate(p.hs_createdate) || parseHsDate(p.hs_timestamp);
    return at ? { type: 'meeting', at } : null;
  }
  return null;
}

/**
 * @param assocMap          output of buildAssocMap
 * @param detailRequests    the request items (same order as the responses)
 * @param detailResponses   HubSpot batch-read responses
 * @returns { [contactId]: touches[] }
 */
function collectTouches(assocMap, detailRequests, detailResponses) {
  const engagements = { calls: {}, emails: {}, meetings: {} };
  detailResponses.forEach((resp, i) => {
    const type = detailRequests[i].objectType;
    assertResults(resp, `read ${type}`);
    for (const row of resp.results) {
      const touch = touchFromEngagement(type, row.properties);
      if (touch) engagements[type][String(row.id)] = touch;
    }
  });
  const byLead = {};
  for (const type of ENGAGEMENT_TYPES) {
    const perLead = assocMap[type] || {};
    for (const leadId of Object.keys(perLead)) {
      for (const engagementId of perLead[leadId]) {
        const touch = engagements[type][engagementId];
        if (touch) (byLead[leadId] = byLead[leadId] || []).push(touch);
      }
    }
  }
  return byLead;
}

// @build:strip-start
module.exports = {
  LEAD_PROPERTIES,
  ENGAGEMENT_TYPES,
  DETAIL_PROPERTIES,
  assertResults,
  parseHsDate,
  buildLeadSearchBody,
  buildOpenLeadSearchBody,
  normalizeLead,
  normalizeLeads,
  buildAssocMap,
  buildDetailRequests,
  touchFromEngagement,
  collectTouches,
};
// @build:strip-end
