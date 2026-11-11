// Code node: "Build Association Requests" (Run Once for All Items)
// One batch request per engagement type: which calls / emails / meetings are associated with these contacts?
const { leads } = $input.first().json;
const inputs = leads.map((l) => ({ id: l.id }));

return ['calls', 'emails', 'meetings'].map((toObjectType) => ({ json: { toObjectType, body: { inputs } } }));
