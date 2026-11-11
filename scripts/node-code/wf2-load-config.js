// Code node: "Load Config & Validate" (Run Once for All Items)
// Loads settings, validates the incoming HubSpot webhook body, and prepares the open-lead search used for capacity checks.
// (Shared-secret authentication is handled by the Webhook node's Header Auth credential, so it fails closed.)
const OVERRIDES = {}; // Optional: hard-code settings if your n8n blocks $env access.

const env = Object.assign(readEnv($env), OVERRIDES);
const cfg = loadConfig(env);

const body = ($input.first().json.body) || {};
const contactId = String(body.contactId || body.objectId || body.hs_object_id || body.id || '').trim();
if (!/^\d+$/.test(contactId)) {
  throw new Error('Webhook body must include a numeric contactId (also accepted: objectId, hs_object_id, id)');
}

return [{ json: { cfg, contactId, openLeadSearchBody: buildOpenLeadSearchBody(cfg) } }];
