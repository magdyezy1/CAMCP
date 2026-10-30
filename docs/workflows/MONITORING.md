---
status: reference
tier: operator
---

# Read-only monitoring

Monitors, incidents and their e-mail notices, without provider writes. A section of the [workflow guide](../PRODUCT-WORKFLOWS.md), moved here with its text unchanged on 2026-10-24 (DOC-03).

Monitoring inbox (`/monitors`) creates an explicit rule from a retained measurement context. The workspace inbox
is always the evidence destination. Each person may separately enable brief email notices to their own verified
account address; no advertising change is sent.

`amcp_workspace` actions: `monitors`, `monitor`, `save_monitor`, `set_monitor_state`, `incidents`, `incident`,
`acknowledge_incident`, `snooze_incident`, `resume_incident`, and `evaluate_monitors`.
Saving requires operator authority, current account access, `confirmed:true`, and a monitor
containing name, platform, connection_id, account_id, currency, timezone, result_definition, attribution, metric,
comparison, threshold and max_age_hours. Up to 100 rules are retained. Supported metrics are spend, clicks,
conversions and CPA; comparisons are above/below; evidence age is 1–168 hours. Changes use the current revision.

Finished Overview snapshots evaluate matching enabled rules under the rule author's current authority. Incidents
deduplicate by rule version, objective and measurement window. Acknowledgement persists while the threshold stays
breached; only newer, complete, comparable evidence resolves an incident. Stale, missing and incomplete data never
becomes a successful zero. Freshness uses the oldest contributing row capture, not the later job completion time.
The latest evaluation records unavailable data/access or ignored older evidence. The API pages at up to 100 results;
the website has independent incident/rule search, state filters and previous/next controls. Both list actions return
`next_offset`; incident states include open, acknowledged, snoozed, resolved and superseded. `incident`/`monitor`
read an exact ID. A reporting snapshot links directly to monitor creation with its original snapshot ID.

Snooze requires the current revision and `snooze_hours` (integer 1–168). It defers `attention_state` while preserving
factual state and ongoing evaluation. Resume clears the deferral; expiry restores prior attention on the next read.
Neither action resolves evidence. Rule edits preserve paused/active state and supersede older unresolved incidents
atomically, keeping their original rule and evidence. A superseded incident is not evidence of recovery.
Resolved/superseded records cannot be snoozed or resumed.

Open a monitor detail to inspect **Your email notices**, then explicitly enable them for that rule version.
Future openings, reopenings and resolutions send a generic notice and authenticated incident link; account names,
values and report contents stay in the inbox. Existing incidents are not backfilled. Rule revision requires another
opt-in; pausing, opt-out, revoked access, security/email changes or obsolete evidence stop pending delivery. Snoozing
defers pending attention; acknowledgement withholds it. A message already submitted cannot be recalled.

`monitor_notifications` takes monitor `id` and returns your subscription, `subscription_version` and 20 recent
deliveries. `set_monitor_notifications` takes that `id`, exact `subscription_version`, `enabled` and `confirmed:true`.
Viewers can manage their own notices; arbitrary recipients and administrator/test identities are not supported.
`retry_monitor_notification` takes `notification_id`, its displayed `notification_version` and `confirmed:true`.
Only failed transient delivery can be recovered: the same encrypted recipient/body/key is reused within the
original 24-hour expiry. Five automatic attempts are allowed; one recovery permits up to ten total. `sent` means
provider acceptance, not verified inbox delivery. Configuration needs the deployment's existing email sender/key,
master key, public origin and running worker. Notice metadata lasts 30 days; failed transport does not remove inbox
evidence. See the [delivery record](../records/DELIVERY-2026-10-01-MONITOR-DELIVERY.md) for limits and lifecycle checks.

The existing owner-selected report retention period includes captured analysis reports and resolved/superseded history.
Current open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
evidence under the existing disconnect workflow.
