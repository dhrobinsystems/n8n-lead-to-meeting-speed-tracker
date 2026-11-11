// Code node: "Format Response" (Run Once for All Items)
// Builds the JSON answer for the calling HubSpot workflow and, if needed, a Slack fallback alert.
const p = $('Pick Rep').first().json;
const incoming = $input.first().json;

// The HubSpot PATCH response has `properties` and no `decision`; the "skip write" path carries the decision.
const wroteToHubSpot = incoming.decision === undefined && incoming.properties !== undefined;

const response = Object.assign({ contactId: p.contactId, sandbox: p.sandbox, wroteToHubSpot }, p.decision);
const needsAlert = !p.sandbox && p.decision.action !== 'SKIP_ALREADY_OWNED' && p.decision.strategy !== 'ROUND_ROBIN';

return [{
  json: {
    response,
    needsAlert,
    slackPayload: needsAlert ? buildFallbackAlert(p.decision, p.contact, p.ui) : null,
  },
}];
