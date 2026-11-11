'use strict';

/**
 * Slack Block Kit builders. Pure functions that return { text, blocks } payloads for an
 * incoming-webhook POST. Paste any output into https://app.slack.com/block-kit-builder to preview it.
 */

const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtMinutes(m) {
  if (m === null || m === undefined || !Number.isFinite(m)) return 'n/a';
  if (m < 60) return `${String(Math.round(m * 10) / 10)} min`;
  const h = Math.floor(m / 60);
  return `${h}h ${Math.round(m - h * 60)}m`;
}

function fmtLocal(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(ms));
}

function recordLink(id, label, portalId) {
  const safe = esc(String(label).replace(/\|/g, '/'));
  if (!portalId) return safe;
  return `<https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-1/${encodeURIComponent(id)}|${safe}>`;
}

const section = (text) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const header = (text) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });

/**
 * @param {Array}  evaluations  OPEN_BREACHED / OPEN_AT_RISK evaluations (with ownerName attached)
 * @param {object} opts         { portalId, slaMinutes, timezone, maxLeads, sandbox }
 */
function buildBreachAlert(evaluations, opts) {
  const o = Object.assign({ portalId: '', slaMinutes: 15, timezone: 'UTC', maxLeads: 10, sandbox: false }, opts);
  const rank = { OPEN_BREACHED: 0, OPEN_AT_RISK: 1 };
  const sorted = evaluations
    .slice()
    .sort((a, b) => (rank[a.status] - rank[b.status]) || (b.elapsedBusinessMinutes - a.elapsedBusinessMinutes));
  const breached = sorted.filter((e) => e.status === 'OPEN_BREACHED').length;
  const atRisk = sorted.length - breached;
  const shown = sorted.slice(0, Math.max(1, o.maxLeads));
  const prefix = o.sandbox ? '[SANDBOX] ' : '';

  const blocks = [
    header(`${prefix}🚨 Speed-to-Lead SLA Alert`),
    section(`*${breached}* breached · *${atRisk}* at risk · SLA: *${o.slaMinutes} business min* (${esc(o.timezone)})`),
    { type: 'divider' },
  ];

  for (const e of shown) {
    const icon = e.status === 'OPEN_BREACHED' ? '🔴' : '🟠';
    const owner = e.ownerName ? esc(e.ownerName) : e.unassigned ? '*Unassigned*' : `Owner ${esc(e.ownerId)}`;
    const company = e.company ? ` · ${esc(e.company)}` : '';
    blocks.push(
      section(
        `${icon} *${recordLink(e.id, e.name, o.portalId)}*${company}\n` +
          `Owner: ${owner} · Waiting *${fmtMinutes(e.elapsedBusinessMinutes)}* of ${e.slaMinutes} min · ${esc(e.source)}\n` +
          `SLA ${e.status === 'OPEN_BREACHED' ? 'was due' : 'due'}: ${esc(fmtLocal(e.dueAtMs, o.timezone))}`
      )
    );
  }
  if (sorted.length > shown.length) blocks.push(context(`+${sorted.length - shown.length} more lead(s) not shown`));
  blocks.push(context('Speed-to-Lead Tracker · dhRobin Systems · no first touch logged yet'));

  return { text: `${prefix}Speed-to-Lead SLA alert: ${breached} breached, ${atRisk} at risk`, blocks };
}

function attainmentIcon(pct) {
  if (pct === null || pct === undefined) return '⚪';
  if (pct >= 90) return '🟢';
  if (pct >= 70) return '🟡';
  return '🔴';
}

const pctText = (pct) => (pct === null || pct === undefined ? 'n/a' : `${pct}%`);

function signed(n, unit) {
  const r = Math.round(n * 10) / 10;
  return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)}${unit}`;
}

/** "Trend vs 2026-11-03: attainment +12.5 pts · median −3 min" (empty string when there is nothing to compare). */
function trendLine(current, previous) {
  if (!previous) return '';
  const parts = [];
  if (current.attainmentPct !== null && previous.attainmentPct !== null) parts.push(`attainment ${signed(current.attainmentPct - previous.attainmentPct, ' pts')}`);
  if (current.medianMinutes !== null && previous.medianMinutes !== null) parts.push(`median ${signed(current.medianMinutes - previous.medianMinutes, ' min')}`);
  return parts.length ? `Trend vs ${esc(previous.date)}: ${parts.join(' · ')}` : '';
}

/**
 * @param {object} summary   output of summarize()
 * @param {object} opts      { slaMinutes, timezone, reportLookbackDays, sandbox }
 * @param {number} nowMs
 * @param {object} previous  optional previous trend entry { date, attainmentPct, medianMinutes, ... }
 */
function buildWeeklyReport(summary, opts, nowMs, previous) {
  const o = Object.assign({ slaMinutes: 15, timezone: 'UTC', reportLookbackDays: 7, sandbox: false }, opts);
  const day = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: o.timezone, month: 'short', day: 'numeric' }).format(new Date(ms));
  const period = `${day(nowMs - o.reportLookbackDays * 86400000)} – ${day(nowMs)}`;
  const prefix = o.sandbox ? '[SANDBOX] ' : '';
  const t = summary.overall;

  const blocks = [
    header(`${prefix}📊 Weekly Speed-to-Lead Report`),
    context(`${esc(period)} · SLA: ${o.slaMinutes} business min · ${esc(o.timezone)}`),
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Leads*\n${t.leads}` },
        { type: 'mrkdwn', text: `*SLA attainment*\n${attainmentIcon(t.attainmentPct)} ${pctText(t.attainmentPct)}` },
        { type: 'mrkdwn', text: `*Median first touch*\n${fmtMinutes(t.medianMinutes)}` },
        { type: 'mrkdwn', text: `*P90 first touch*\n${fmtMinutes(t.p90Minutes)}` },
        { type: 'mrkdwn', text: `*Never touched (SLA blown)*\n${t.openBreached}` },
        { type: 'mrkdwn', text: `*Touched late*\n${t.breachedLate}` },
      ],
    },
    { type: 'divider' },
  ];
  const trend = trendLine(t, previous);
  if (trend) blocks.splice(3, 0, context(trend));

  const reps = summary.byOwner.slice(0, 20);
  const lines = reps.map(
    (r) =>
      `${attainmentIcon(r.attainmentPct)} *${esc(r.name)}* — ${r.leads} lead${r.leads === 1 ? '' : 's'} · ` +
      `${pctText(r.attainmentPct)} · median ${fmtMinutes(r.medianMinutes)} · p90 ${fmtMinutes(r.p90Minutes)}` +
      (r.openBreached ? ` · *${r.openBreached} untouched*` : '')
  );
  blocks.push(section(`*By owner*\n${lines.join('\n') || '_No leads in this period._'}`));
  if (summary.byOwner.length > reps.length) blocks.push(context(`+${summary.byOwner.length - reps.length} more owner(s) not shown`));
  blocks.push(context('Attainment = met ÷ (met + late + untouched-and-breached). Leads still inside their SLA are excluded.'));

  return { text: `${prefix}Weekly speed-to-lead report: ${pctText(t.attainmentPct)} SLA attainment across ${t.leads} leads`, blocks };
}

/**
 * Alert posted when round-robin could not find an eligible rep.
 * @param {object} decision  output of pickRep (+ contact context)
 * @param {object} contact   { id, name, email, company }
 * @param {object} opts      { portalId }
 */
function buildFallbackAlert(decision, contact, opts) {
  const o = Object.assign({ portalId: '' }, opts);
  const reasons = (decision.skipped || []).map((s) => `${esc(s.name)} (${esc(s.reason.replace(/_/g, ' '))})`).join(', ') || 'no reps configured';
  const outcome =
    decision.strategy === 'FALLBACK_OWNER'
      ? `Assigned to the *fallback owner* (ID ${esc(decision.ownerId)}).`
      : '*Left unassigned* - no fallback owner is configured.';
  return {
    text: `No eligible rep for ${contact.name}`,
    blocks: [
      header('⚠️ Lead assignment fallback'),
      section(
        `*${recordLink(contact.id, contact.name, o.portalId)}*${contact.company ? ` · ${esc(contact.company)}` : ''}\n` +
          `No rep was eligible for round-robin. Skipped: ${reasons}.\n${outcome}`
      ),
      context('Speed-to-Lead Tracker · dhRobin Systems'),
    ],
  };
}

// @build:strip-start
module.exports = { esc, fmtMinutes, fmtLocal, recordLink, trendLine, buildBreachAlert, buildWeeklyReport, buildFallbackAlert };
// @build:strip-end
