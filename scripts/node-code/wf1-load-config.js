// Code node: "Load Config" (Run Once for All Items)
// Reads settings from environment variables (see docs/CONFIGURATION.md) and builds the HubSpot lead search body.
// If your n8n blocks $env access, hard-code settings here instead, e.g. { SANDBOX_MODE: 'true', SLA_MINUTES: '15' }.
const OVERRIDES = {};

const env = Object.assign(readEnv($env), OVERRIDES);
const cfg = loadConfig(env);
const mode = $input.first().json.mode === 'report' ? 'report' : 'monitor';
const nowMs = Date.now();

return [{ json: { mode, cfg, searchBody: buildLeadSearchBody(cfg, mode, nowMs) } }];
