// Code node: "Normalize Leads" (Run Once for All Items)
// Converts the HubSpot contact search response into clean lead objects. Stops the run if there is nothing to evaluate.
const { mode, cfg } = $('Load Config').first().json;
const body = $input.first().json;

assertResults(body, 'contact search');
const leads = normalizeLeads(body.results, cfg);
if (!leads.length) return [];

return [{ json: { mode, cfg, leads } }];
