# Architecture

## Design principles

1. **Safe by default.** `SANDBOX_MODE` defaults to on and fails safe. Workflow 1 only calls HubSpot read endpoints (a test enforces this). Workflow 2's single write is `PATCH …/contacts/{id}` setting `hubspot_owner_id`.
2. **Fail loudly, never silently.** If HubSpot returns an error body, the run throws instead of treating the lead as "untouched" — a false breach alert is worse than a failed run you can see.
3. **Testable logic.** Business logic lives in `src/` as pure, dependency-free functions. `scripts/build-workflows.js` inlines them into n8n Code nodes, and the test harness runs that exact generated code against sample data with HTTP mocked. HTTP request bodies are built in Code nodes (`JSON.stringify($json.searchBody)`), so they are tested too.
4. **Few, cheap API calls.** Per monitor run: 1 contact search + 3 batched association reads + up to ⌈engagements/100⌉ batched detail reads per type — roughly 5–8 calls every 5 minutes, independent of lead count (up to 100).

## Workflow 1 — monitor + report

```
Triggers ─► Mode ─► Load Config ─► Search New Leads ─► Normalize Leads
        ─► Build Association Requests ─► Get Associations (×3: calls, emails, meetings)
        ─► Build Detail Requests ─► Engagements to read? ─┬─► Read Engagement Details ─┐
                                                          └───────────────(none)────────┴─► Evaluate SLA
        ─► Build Slack Message ─► Sandbox Mode? ─► Preview | Post to Slack
```

- **Mode** is set by the trigger: *Every 5 Minutes* and *Manual Test* → `monitor`; *Weekly Report* → `report`. Both feed the same pipeline.
- **Search** uses two OR'd filter groups: `createdate ≥ since` or `recent_conversion_date ≥ since`.
- **The "no engagements" branch** exists so untouched leads — the case that matters most — still reach *Evaluate SLA* when there is nothing to read.
- **Evaluate SLA** (monitor): marks `OPEN_AT_RISK` / `OPEN_BREACHED` leads, de-duplicates per `leadId:clockStart:status` (so a lead alerts once at risk and once when breached), prunes entries older than 7 days. (report): rolls up per owner and updates the trend log.

### SLA model

| Status | Meaning |
|---|---|
| `MET` | First touch within `SLA_MINUTES` business minutes |
| `BREACHED_LATE` | First touch happened, after the SLA |
| `OPEN_WITHIN_SLA` | No touch yet, under the warning threshold |
| `OPEN_AT_RISK` | No touch yet, ≥ `SLA_WARN_PCT` of the SLA used |
| `OPEN_BREACHED` | No touch yet, SLA exceeded |

Touch sources: outbound calls (`hs_timestamp`), outbound emails (`hs_timestamp`), meetings (at **booking** time, `hs_createdate`), sequence enrollment (`hs_latest_sequence_enrolled_date`). Inbound calls, incoming/forwarded emails, and anything before the clock start are ignored.

### Business-hours math

`businessMinutesBetween` walks local calendar days in the configured time zone, intersecting each business day's `[open, close)` window with the interval. Local wall-clock times are converted with an offset re-check, so DST transitions are handled. Tests cover weekends, holidays, DST in both directions, and a Sunday–Thursday work week. `addBusinessMinutes` computes the SLA due time shown in Slack.

### Trend log

Each live weekly report appends `{ date, leads, attainmentPct, medianMinutes, p90Minutes, openBreached }` to workflow static data (last 26 kept) and the next Slack report shows the delta. The same entry is available as `trend.entry` on the *Evaluate SLA* output: add a Google Sheets "Append row" node (or a database node) after it if you want a durable external log.

## Workflow 2 — round-robin assignment

```
HubSpot Webhook (Header Auth) ─► Load Config & Validate ─► Get Contact ─► Count Open Leads
   ─► Pick Rep ─► Write to HubSpot? ─┬─► Assign Owner ──┐
                                      └─► Skip Write ────┴─► Format Response ─┬─► Respond to Webhook
                                                                               └─► Fallback Alert Needed? ─► Slack
```

Eligibility per rep, in rotation order: `active`, not out of office today (in `BUSINESS_TIMEZONE`), and open leads < `maxOpenLeads`. If nobody qualifies: fallback owner (and a Slack alert), or leave unassigned (and alert). Contacts that already have an owner are skipped unless `REASSIGN_EXISTING_OWNER=true`.

## State

Alert de-duplication, the rotation index, and the trend log are stored with `$getWorkflowStaticData('global')`. n8n persists this only for **active** workflows' production executions; manual test runs don't save it. It is per instance and not transactional — fine for a lightweight monitor, not a system of record.

## Known limits

See the README's *Status & known limitations*. In short: 100 leads per run, global business hours, static-data state, rotation race on simultaneous webhooks, and no live-portal validation by the author.
