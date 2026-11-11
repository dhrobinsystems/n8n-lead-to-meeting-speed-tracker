'use strict';

/**
 * Central configuration loader. Reads environment variables (or an equivalent plain object)
 * and returns one validated config object shared by both workflows.
 *
 * SANDBOX_MODE defaults to TRUE: nothing is posted to Slack and nothing is written to HubSpot
 * until you explicitly set SANDBOX_MODE=false.
 */

// @build:strip-start
const { normalizeHours } = require('./business-hours');
// @build:strip-end

const ENV_KEYS = [
  'SANDBOX_MODE',
  'SLA_MINUTES',
  'SLA_WARN_PCT',
  'LOOKBACK_HOURS',
  'REPORT_LOOKBACK_DAYS',
  'BUSINESS_TIMEZONE',
  'BUSINESS_START',
  'BUSINESS_END',
  'BUSINESS_WORKDAYS',
  'BUSINESS_HOLIDAYS',
  'EXCLUDED_LIFECYCLE_STAGES',
  'EXCLUDED_EMAIL_DOMAINS',
  'CLOCK_RESTARTS_ON_FORM_SUBMIT',
  'HUBSPOT_PORTAL_ID',
  'REPS_JSON',
  'FALLBACK_OWNER_ID',
  'OPEN_LEAD_STATUSES',
  'REASSIGN_EXISTING_OWNER',
  'ALERT_MAX_LEADS',
];

/**
 * Copy known keys out of an env-like object. Safe when n8n blocks env access
 * (N8N_BLOCK_ENV_ACCESS_IN_NODE=true): reads throw, we stop and fall back to safe defaults.
 */
function readEnv(source) {
  const env = {};
  for (const key of ENV_KEYS) {
    try {
      const v = source[key];
      if (v !== undefined && v !== null && v !== '') env[key] = v;
    } catch (e) {
      break;
    }
  }
  return env;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/** Fail-safe: sandbox stays ON unless the value is an explicit "off" word. A typo like "flase" keeps it ON. */
function toSandbox(value) {
  if (value === undefined || value === null || String(value).trim() === '') return true;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function toNum(value, fallback, name) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${value}"`);
  return n;
}

function toList(value, fallback) {
  const raw = value === undefined || value === null ? fallback : String(value);
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseReps(json) {
  if (json === undefined || json === null || String(json).trim() === '') return [];
  let reps;
  try {
    reps = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error(`REPS_JSON is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(reps)) throw new Error('REPS_JSON must be a JSON array of rep objects');
  const seen = new Set();
  return reps.map((r, i) => {
    if (!r || r.id === undefined || r.id === null || !r.name) {
      throw new Error(`REPS_JSON[${i}] needs at least "id" (HubSpot owner ID) and "name"`);
    }
    const id = String(r.id);
    if (seen.has(id)) throw new Error(`REPS_JSON has a duplicate rep id: ${id}`);
    seen.add(id);
    return {
      id,
      name: String(r.name),
      active: r.active !== false,
      maxOpenLeads: Number.isFinite(Number(r.maxOpenLeads)) && r.maxOpenLeads !== null ? Number(r.maxOpenLeads) : null,
      ooo: Array.isArray(r.ooo) ? r.ooo : [],
    };
  });
}

function loadConfig(env) {
  const e = env || {};
  const cfg = {
    sandbox: toSandbox(e.SANDBOX_MODE),
    slaMinutes: toNum(e.SLA_MINUTES, 15, 'SLA_MINUTES'),
    warnPct: toNum(e.SLA_WARN_PCT, 0.75, 'SLA_WARN_PCT'),
    lookbackHours: toNum(e.LOOKBACK_HOURS, 96, 'LOOKBACK_HOURS'),
    reportLookbackDays: toNum(e.REPORT_LOOKBACK_DAYS, 7, 'REPORT_LOOKBACK_DAYS'),
    hours: {
      timezone: e.BUSINESS_TIMEZONE || 'America/New_York',
      startTime: e.BUSINESS_START || '09:00',
      endTime: e.BUSINESS_END || '17:00',
      workdays: toList(e.BUSINESS_WORKDAYS, '1,2,3,4,5').map(Number),
      holidays: toList(e.BUSINESS_HOLIDAYS, ''),
    },
    excludedLifecycleStages: toList(e.EXCLUDED_LIFECYCLE_STAGES, 'customer,evangelist,other').map((s) => s.toLowerCase()),
    excludedEmailDomains: toList(e.EXCLUDED_EMAIL_DOMAINS, '').map((s) => s.toLowerCase().replace(/^@/, '')),
    clockRestartsOnFormSubmit: toBool(e.CLOCK_RESTARTS_ON_FORM_SUBMIT, true),
    portalId: e.HUBSPOT_PORTAL_ID ? String(e.HUBSPOT_PORTAL_ID) : '',
    reps: parseReps(e.REPS_JSON),
    fallbackOwnerId: e.FALLBACK_OWNER_ID ? String(e.FALLBACK_OWNER_ID) : '',
    openLeadStatuses: toList(e.OPEN_LEAD_STATUSES, 'NEW,OPEN,IN_PROGRESS,ATTEMPTED_TO_CONTACT'),
    reassignExistingOwner: toBool(e.REASSIGN_EXISTING_OWNER, false),
    alertMaxLeads: toNum(e.ALERT_MAX_LEADS, 10, 'ALERT_MAX_LEADS'),
  };

  if (!(cfg.slaMinutes > 0)) throw new Error('SLA_MINUTES must be greater than 0');
  if (!(cfg.warnPct > 0 && cfg.warnPct <= 1)) throw new Error('SLA_WARN_PCT must be between 0 (exclusive) and 1');
  if (!(cfg.lookbackHours > 0)) throw new Error('LOOKBACK_HOURS must be greater than 0');
  if (!(cfg.reportLookbackDays > 0)) throw new Error('REPORT_LOOKBACK_DAYS must be greater than 0');
  normalizeHours(cfg.hours); // throws a readable error for bad time zone / hours / workdays
  return cfg;
}

// @build:strip-start
module.exports = { ENV_KEYS, readEnv, loadConfig, parseReps };
// @build:strip-end
