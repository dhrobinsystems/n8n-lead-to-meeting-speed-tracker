// Code node: "Pick Rep" (Run Once for All Items)
// Decides who gets the lead: round-robin over eligible reps, with fallback rules.
const { cfg, contactId } = $('Load Config & Validate').first().json;
const contact = $('Get Contact').first().json;
const search = $input.first().json;
assertResults(search, 'open lead count');

const props = contact.properties || {};
const contactInfo = {
  id: contactId,
  name: [props.firstname, props.lastname].filter(Boolean).join(' ').trim() || props.email || `Contact ${contactId}`,
  email: props.email || '',
  company: props.company || '',
};
const ui = { sandbox: cfg.sandbox, portalId: cfg.portalId };
const currentOwner = props.hubspot_owner_id ? String(props.hubspot_owner_id) : null;

if (currentOwner && !cfg.reassignExistingOwner) {
  const decision = { action: 'SKIP_ALREADY_OWNED', strategy: 'NONE', ownerId: currentOwner, ownerName: null, skipped: [], openLeadsBefore: null };
  return [{ json: { contactId, contact: contactInfo, ui, decision, shouldAssign: false, sandbox: cfg.sandbox } }];
}

const openCounts = {};
search.results.forEach((r) => {
  const id = r.properties && r.properties.hubspot_owner_id;
  if (id) openCounts[id] = (openCounts[id] || 0) + 1;
});

const state = $getWorkflowStaticData('global');
const pick = pickRep({
  reps: cfg.reps,
  openCounts,
  lastAssignedIndex: state.lastAssignedIndex,
  nowMs: Date.now(),
  timezone: cfg.hours.timezone,
  fallbackOwnerId: cfg.fallbackOwnerId,
});

// Sandbox runs never advance the rotation.
if (!cfg.sandbox && pick.strategy === 'ROUND_ROBIN') state.lastAssignedIndex = pick.newIndex;

const decision = Object.assign({}, pick, {
  countsTruncated: typeof search.total === 'number' && search.total > search.results.length,
});
const shouldAssign = decision.action === 'ASSIGN' && Boolean(decision.ownerId);

return [{
  json: {
    contactId,
    contact: contactInfo,
    ui,
    decision,
    shouldAssign,
    sandbox: cfg.sandbox,
    patchBody: shouldAssign ? { properties: { hubspot_owner_id: String(decision.ownerId) } } : null,
  },
}];
