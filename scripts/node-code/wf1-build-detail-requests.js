// Code node: "Build Detail Requests" (Run Once for All Items)
// Input: the 3 association responses (calls, emails, meetings - in that order).
// Output: batch-read requests for the engagement details, plus the contact -> engagement map on the first item.
const responses = $input.all().map((item) => item.json);
const assocMap = buildAssocMap(responses);

return buildDetailRequests(assocMap).map((json) => ({ json }));
