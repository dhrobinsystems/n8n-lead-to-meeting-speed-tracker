Markdown
# n8n Lead-to-Meeting Speed Tracker

**Speed-to-lead SLA monitoring for HubSpot, built in n8n.** Watches new leads and form submissions, measures time to first touch in *business* minutes, flags SLA breaches in Slack, posts a weekly rep-level response-time report, and routes new leads with round-robin assignment and fallback rules.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![n8n](https://img.shields.io/badge/built%20with-n8n-ea4b71)
![HubSpot](https://img.shields.io/badge/CRM-HubSpot-ff7a59)
![Slack](https://img.shields.io/badge/alerts-Slack%20Block%20Kit-4a154b)
![Sandbox](https://img.shields.io/badge/default-SANDBOX__MODE%3Dtrue-blue)

---

## ⚠️ Disclaimer & Liability Limitation

**Use at your own risk.** The code, workflows, and scripts provided in this repository (`n8n-lead-to-meeting-speed-tracker`) are for educational and architectural demonstration purposes.

* **No Liability:** The author and dhRobin Systems assume no responsibility or liability for any direct, indirect, incidental, or consequential damages resulting from the use, misuse, or deployment of these scripts and workflows.
* **CRM Data, Lead Routing & Alerting Risks:** CRM automation carries inherent risks. Misconfigured filters, incorrect property mappings, bad API calls, or aggressive polling can produce wrong SLA alerts, reassign lead ownership to the wrong people, overwrite CRM data, exhaust API rate limits, flood Slack channels, or cause leads to be missed or mis-routed. Workflow 2 **writes to HubSpot** (it changes `hubspot_owner_id`); Workflow 1 only reads from HubSpot.
* **User Responsibility:** You are solely responsible for compliance with applicable laws, regulations, and contracts, including data-protection and privacy rules (such as GDPR, CCPA, and CASL), employment and workplace-monitoring rules that may apply to rep-level performance reporting, API rate limits, and the terms of service of HubSpot, Slack, n8n, and any other provider you connect. You are also solely responsible for proper testing (`SANDBOX_MODE=true`) before connecting any scripts to production environments, live CRM data, or live notification channels.

Full text: [DISCLAIMER.md](DISCLAIMER.md) · Licensed under the [MIT License](LICENSE).

---

## Why this exists

Response time is one of the most-cited RevOps KPIs, and it is easy to measure badly: a lead that arrives at 5:30 PM Friday is not "60 hours late" on Monday morning. This project measures speed-to-lead the way a sales team actually experiences it — **in business hours** — and turns it into alerts and a weekly scorecard.

## What it does

| Capability | How |
|---|---|
| **Detect new leads & form submissions** | HubSpot CRM search every 5 minutes: contacts created *or* re-submitted via form inside a lookback window |
| **Find the first touch** | Earliest outbound **call**, **email**, **meeting booked**, or **sequence enrollment** logged on or after the lead's clock start (inbound calls/emails and pre-existing history are ignored) |
| **Business-hours SLA math** | Time zone, work week, and holidays aware; DST-safe; zero dependencies (`Intl` only) |
| **Alerts** | Slack Block Kit: one *at-risk* warning, then one *breached* alert per lead (de-duplicated) |
| **Weekly report** | Monday 08:00: per-rep leads, SLA attainment %, median / P90 first-touch time, untouched leads, and week-over-week trend |
| **Round-robin assignment** | Skips inactive / out-of-office / at-capacity reps; falls back to a default owner and alerts Slack |
| **Trend log** | Rolling 26-report JSON history; each report also emits a ready-to-append row for Google Sheets |
| **Safe by default** | `SANDBOX_MODE=true` out of the box; typos in the setting keep it **on**; Workflow 1 is read-only |

## Architecture

```mermaid
flowchart LR
  T1["Every 5 min"] --> C
  T2["Mon 08:00 report"] --> C
  T3["Manual test"] --> C
  C["Load Config"] --> S["HubSpot: search new leads"]
  S --> N["Normalize leads"]
  N --> A["HubSpot: associations (calls, emails, meetings)"]
  A --> D["HubSpot: read engagement details"]
  D --> E["Evaluate SLA (business minutes)"]
  E --> B["Build Slack Block Kit"]
  B --> G{"Sandbox mode?"}
  G -- "yes" --> P["Preview only"]
  G -- "no" --> SL["Post to Slack"]
Code snippet
flowchart LR
  W["HubSpot workflow: Send a webhook"] --> V["Validate + load config"]
  V --> GC["HubSpot: get contact"]
  GC --> OC["HubSpot: count each rep's open leads"]
  OC --> PR["Pick rep: round-robin + rules"]
  PR --> WR{"Write enabled?"}
  WR -- "yes" --> AO["HubSpot: set owner"]
  WR -- "no (sandbox / already owned)" --> SK["Skip write"]
  AO --> FR["Format response"]
  SK --> FR
  FR --> RS["Respond to webhook"]
  FR --> FA{"Fallback used?"}
  FA -- "yes" --> SF["Slack fallback alert"]
More detail: docs/ARCHITECTURE.md.

Repository layout
├── workflows/
│   ├── 01-speed-to-lead-monitor-and-report.json   # import into n8n (read-only on HubSpot)
│   └── 02-round-robin-lead-assignment.json        # import into n8n (writes owner when SANDBOX_MODE=false)
├── src/                      # tested, dependency-free logic (inlined into n8n Code nodes at build time)
│   ├── business-hours.js     # business-minute math, time zones, DST, holidays
│   ├── sla-evaluator.js      # MET / BREACHED_LATE / OPEN_AT_RISK / OPEN_BREACHED
│   ├── metrics.js            # median, P90, attainment, per-owner rollups
│   ├── hubspot.js            # request bodies + response normalization
│   ├── round-robin.js        # rotation + eligibility + fallback
│   ├── slack-blocks.js       # Block Kit builders
│   └── config.js             # env loader + validation
├── scripts/                  # build-workflows.js, demo.js, node-code/ (n8n glue)
├── tests/                    # unit tests + workflow simulation harness
├── sample-data/              # HubSpot-shaped sample responses + expected outputs (incl. Slack payloads)
├── config/reps.sample.json   # example REPS_JSON
├── docs/                     # SETUP, CONFIGURATION, ARCHITECTURE
├── .env.example
├── DISCLAIMER.md · LICENSE · CONTRIBUTING.md · CHANGELOG.md
Quick start
Requires: n8n (self-hosted recommended), a HubSpot private app token, and a Slack incoming webhook. Full walkthrough: docs/SETUP.md.

Try it offline first (no accounts needed):

Bash
git clone [https://github.com/dhrobinsystems/n8n-lead-to-meeting-speed-tracker.git](https://github.com/dhrobinsystems/n8n-lead-to-meeting-speed-tracker.git)
cd n8n-lead-to-meeting-speed-tracker
npm test       # 59 checks
npm run demo   # runs the real workflow logic on bundled sample data
Create credentials in n8n: HubSpot App Token (read scopes for Workflow 1; add write scope only if you use Workflow 2) and, for Workflow 2, a Header Auth credential to protect the webhook.

Set environment variables on your n8n instance from .env.example. Keep SANDBOX_MODE=true.

Import both files from workflows/ (n8n → Workflows → Import from file) and attach your credentials.

Dry-run in sandbox: execute Manual Test in Workflow 1. The Slack payload appears on the Sandbox: Preview Only node; paste payload into the Slack Block Kit Builder to preview.

Go live deliberately: only after the checklist in docs/SETUP.md, set SANDBOX_MODE=false and activate the workflows.

How the SLA is measured
Clock start = the contact's create date, or the latest form submission if that is later (CLOCK_RESTARTS_ON_FORM_SUBMIT=true).

Clock runs only inside business hours (default Mon–Fri 09:00–17:00 America/New_York, holidays excluded).

First touch = earliest outbound call, email, meeting booked, or sequence enrollment on/after the clock start.

Statuses: MET · BREACHED_LATE (touched, but late) · OPEN_WITHIN_SLA · OPEN_AT_RISK (≥ 75% of the SLA used) · OPEN_BREACHED.

Attainment % = met ÷ (met + late + untouched-and-breached). Leads still inside their SLA are excluded so the number is not distorted by fresh leads.

Example (default 15-minute SLA): a lead submits a form Fri 17:30, a rep enrolls them in a sequence Mon 09:06 → 6 business minutes → MET (not 63 hours).

Demo output
npm run demo on the bundled sample data (fictional leads, example.com addresses):

Speed-to-Lead Tracker demo  |  "now" = Tue 3:30 PM New York  |  SLA = 15 business minutes

1) Monitor run: leads that need a Slack alert
   Lead            Owner         Status         Waiting   SLA due
   Tom Becker      (unassigned)  OPEN_BREACHED  60 min    Tue 2:45 PM
   Liam O'Connor   Casey Morgan  OPEN_BREACHED  20 min    Tue 3:25 PM
   Priya Nair      Jordan Blake  OPEN_AT_RISK   12 min    Tue 3:33 PM

2) Weekly report: rep-level response times
   Owner           Leads  Attainment  Median    P90       Untouched
   Jordan Blake    3      100%        7 min     8 min     0
   Casey Morgan    2      0%          30 min    30 min    1
   Riley Patel     2      100%        12 min    12 min    0
   Unassigned      1      0%          n/a       n/a       1
   ALL             8      50%         10 min    30 min    2

3) Round-robin: next new lead
   -> Jordan Blake (ROUND_ROBIN); skipped: none; wroteToHubSpot=false (sandbox)
Ready-to-preview Slack payloads: sample-data/expected-output/slack-sla-alert.json and slack-weekly-report.json.

Configuration
Everything is controlled by environment variables — SLA length, warning threshold, business hours, holidays, lead filters, reps, capacity limits, fallback owner. See .env.example and docs/CONFIGURATION.md.

Testing
Bash
npm test         # business-hours edge cases (weekends, holidays, DST), SLA statuses, round-robin rules,
                 # Slack limits, and the REAL generated Code-node code run against HubSpot-shaped sample data
npm run check    # generated workflow JSON is current and every Code node compiles
Status & known limitations
Please read before relying on this.

The logic is covered by automated tests, and the workflow Code nodes are exercised end-to-end against sample data with the HTTP calls mocked. It has not been validated against your live HubSpot portal or your n8n version — API behavior, scopes, and property names vary. Verify in sandbox first (docs/SETUP.md).

Each monitor run reads up to 100 leads (no pagination yet); the open-lead capacity count is also capped at 100 results.

State (alert de-duplication, round-robin position, trend log) lives in n8n workflow static data, which is saved only for active (production) executions, is per instance, and is not a database. Two simultaneous webhook calls can race on the rotation.

Business hours are one global schedule (not per-rep schedules).

"Sequence enrollment" relies on the contact property hs_latest_sequence_enrolled_date; confirm it exists in your portal.

Logged emails that HubSpot records as sent by a user count as touches; fully automated marketing emails normally do not appear as 1:1 engagements, but check your setup.

Rep-level reporting may be regulated where you operate (see the disclaimer).

Roadmap ideas
Pagination for portals with > 100 new leads per window

Per-rep working hours and time zones

Optional Google Sheets / database trend export node

Optional write-back of SLA status to custom HubSpot properties

Escalation to a manager after a second breach

Contributing
See CONTRIBUTING.md. Edit src/ and scripts/node-code/, then run npm run build; the JSON in workflows/ is generated.

License
MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
