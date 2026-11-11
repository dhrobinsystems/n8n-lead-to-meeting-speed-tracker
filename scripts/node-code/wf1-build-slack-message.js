// Code node: "Build Slack Message" (Run Once for All Items)
const d = $input.first().json;
const payload = d.mode === 'report'
  ? buildWeeklyReport(d.summary, d.ui, d.nowMs, d.trend && d.trend.previous)
  : buildBreachAlert(d.evaluations, d.ui);

return [{ json: { mode: d.mode, sandbox: d.sandbox, payload } }];
