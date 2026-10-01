# Connected product workflows

Implemented on `magdyezy1/CAMCP`, branch `Work-here`, on 1 October 2026. These website views call the same
first-party service operations as MCP. The [implementation record](review/IMPLEMENTATION-2026-10-01.md) records
qualification and remaining blueprint scope. Provider acceptance is account/action-specific and remains separate
from local implementation.

## Find and resume work

Home (`/dashboard`) links to new plans, recent plans, attention items, creative preparation, reports and account
readiness. The navigation has seven main destinations with expandable campaign, reporting, connection and
management tools. Exact plan, media review, report and evidence IDs are retained in internal links. Session expiry,
logout and workspace changes clear private drafts and invalidate pending responses. Ordinary navigation preserves
an unsaved report setup within the same identity; an explicit new report clears the old selection and destination.

`amcp_workspace {action:"capabilities", gateway?, workflow_id?, account_id?, connection_id?}` projects executable
campaign recipes, Overview adapters, detailed capture presets and media routes into workflow cards. Exact workflow
and account/login filters expose dependencies, lifecycle handoffs, native actions, registered review families and
their evidence paths. The recipe dependencies are tested against the compiled plans. Recorded scopes and current
local access are prerequisites; a dated successful account read is separate evidence, never objective acceptance.
Readiness expires after 15 minutes and is invalidated by connection/credential changes. `contracts` remains the
paginated, searchable action ledger. Neither view creates a grant or replaces native preflight/review.

## Campaign review and recovery

The Campaigns page starts with saved plans and a collapsible composer. The readable review preserves exact native
units and shows account, request and impact alongside expandable source JSON. Required spend, cap and creative-edit
acknowledgements come from the server and start unchecked. A confirm-mode cap can be acknowledged; a block-mode cap
stays blocked.

The page exposes whole-plan approval/run/continue, the execution journal, supported clone creation, amendment of
server-declared editable fields and comparison with observed native state. An observed-state acceptance sends the
exact current `actual_hash`. Uncertain writes retain their original receipts and are never automatically replayed.
Clone support remains the existing Google Search, Snapchat, TikTok and LinkedIn scope. Guided Meta website
purchases (`meta_website_sales`) and website leads (`meta_website_leads`) add explicit pixel, event and attribution
choices to the image workflow. Choose a 1- or 7-day click window and explicitly include or exclude 1-day views.
The campaign starts PAUSED; children are ACTIVE under it. Activation requires a separate reviewed change.
Pixel/Page access is checked during preflight. Event delivery, objective eligibility and landing-page acceptance
still need account-specific evidence. Regulated categories require a tailored native plan; these recipes refuse them.

Client playbooks (`/profiles`) provide naming/UTM fields, selected-account bindings, recipe defaults, revisioned
approval and an expansion preview. Advanced variables, conversion mappings and native templates remain JSON.
Preview resolves the same template function as campaign creation without provider calls. A nonempty binding list
limits both recipe choices and generated/native plan steps to those exact accounts and connections. An empty list
retains the previous behavior of allowing the actor's currently authorized choices. Profiles never grant access.

## Creative preparation and durable uploads

Creative (`/media`) starts with a searchable, paginated metadata library. Filter by platform, account/login, name or
tag; open an exact asset to inspect native IDs, source hashes, transformation dimensions and retained plan usage.
Names and tags are revision-protected internal annotations. Confirming an edit never renames the provider object.
Verified plan usage follows actual media/creative/ad references and retains original plan links; dependency order
alone does not prove usage. **Inspect linked ad performance** selects a retained guided Meta ad report from the
same account/login and shows daily rows for exact verified ad IDs in that plan. It preserves source dates, currency,
timezone, attribution, result definition, completeness and unknown values. It does not allocate results to an image
or prove which creative served throughout the reporting window. External usage remains unknown. Every page/detail checks
current account access; asset reuse still requires the original fresh provider-availability check.

Source upload, variants and destination preparation follow the library. **Save as resumable upload plan** retains up to 50 eligible matrix rows as media-only
campaign steps, preserving every target and original source hash. Saving does not upload. Review and execute the
saved plan through Campaigns; successful step receipts survive later target failures.

The immediate bulk flow continues to prepare and execute one destination at a time, respecting the existing
two-review staging quota. Saved source files still expire after 30 minutes; a durable plan is not permanent media
storage. Expired or unavailable originals are not resurrected by the metadata library. See
[media uploads](MEDIA-UPLOADS.md) for provider limits and safe resume behavior.

## Reports, evidence and delivery

Report library (`/report-library`) separates saved definitions, reusable account-free templates and retained
snapshots. Search finds definitions by client/name; snapshot history pages through older accessible results. A
snapshot link opens its retained results, and **Use this snapshot's setup** explicitly copies its original settings
into the builder. Changing the builder does not mutate the snapshot.

Every Overview collection has one durable allowance across accounts, periods, pages, retries and report downloads:

| Limit | Whole snapshot allowance |
|---|---:|
| Native HTTP requests | 1,200 |
| Normalized source rows | 25,000 |
| Active collection time | 300,000 ms |
| Response bytes | 128 MiB |

Counters are saved before egress and never reset by retry. Clean queue waiting is excluded; an interrupted process
conservatively charges elapsed wall time since its last active checkpoint. Between completed native periods, a
dispatch yields after 20 seconds so other queued work can run. This is not a per-request deadline shorter than the
remaining collection time and does not interrupt advertising mutations. A limit retains completed results and
explicit missing-source/period errors. Narrow the next run rather than retrying for a fresh allowance. Legacy
partially collected jobs without counters require a new run (`REPORT_RESTART_REQUIRED`).

X reporting assigns each UTC hour to one local calendar period by its midpoint. Fractional-hour boundary periods
are marked with the hourly-resolution limitation; adjacent daily totals do not count the same hour twice.
Successful empty or sparse native metrics remain valid dependencies with unknown values, rather than failing
custom formula validation.

**Analyze retained evidence** selects a single compatible account/login/currency/timezone/attribution/conversion
group. It retains original row capture timestamps, query fingerprints and snapshot lineage and makes no new
provider query. Pacing, reconciliation and recommendation operations remain advisory.

`amcp_reporting` adds:

| Action | Inputs / result |
|---|---|
| `capture_presets` | Available detailed native mappings and declared limits |
| `capture_preset` | `preset`, exact `connection_id`/`account_id`, and `semantics`; Meta also requires `result_action_type` and `attribution_windows` |
| `overview_sources` | `id` of a retained Overview snapshot; lists eligible semantic groups |
| `capture_overview` | Snapshot `id` and exact `group_id`; reuses retained evidence |
| `scenarios` | Evidence `id`, `options.budgets`, `efficiency_low`, `efficiency_high`; returns explicit sensitivity assumptions |
| `allocation_candidates` | Guided campaign evidence `id`; paginated campaign metadata with `offset`/`limit` and `next_offset` |
| `allocation` | Evidence `id`, explicit total period budget, campaign floors/caps, sensitivity factors, evidence age and minimum conversions; returns an inspectable proposal |

Google presets are `google_campaign`, `google_adset`, `google_ad` and `google_search_terms`. Each needs currency, IANA
timezone, date_from/date_to, attribution, conversion_definition, source_name and a boolean complete declaration.
The first three retain daily grain; search terms retain campaign/ad-group/search-term grain over the selected
period. Native Google cost micros are divided by 1,000,000. Presets require complete paging and are bounded by 120
requests, 10,000 rows, 120 seconds and 32 MiB. Those limits do not qualify every provider combination. Declared
semantics must match the native account/query; search-term visibility can prevent reconciliation to campaign totals.

Meta presets are `meta_campaign`, `meta_adset` and `meta_ad`, each at entity × day grain. Supply currency, IANA
timezone, dates, source name and completeness. Select the exact native `result_action_type` (for example,
`offsite_conversion.fb_pixel_purchase`) and `attribution_windows`: one of `1d_click`/`7d_click`, optional `1d_view`,
or `1d_view` alone. Both click windows together are refused. The request explicitly uses impression time and
disables account/unified attribution overrides; the saved attribution/result definitions are derived from that query.
The caller still declares timezone/completeness, and each nonempty native row must match account, currency, dates
and unique entity/day grain. Missing selected actions stay unknown; overlapping action aliases are never added.
Partial pagination or ambiguous selected actions refuse capture before retaining evidence. The same collection
bounds apply. SDK schema evidence does not certify live provider acceptance.

Scenarios accept 1–12 decimal budgets and positive low/high efficiency factors no greater than 10. They need positive
observed spend and conversions. They are linear CPA sensitivity models, with evidence age/completeness and source
hash attached, not calibrated delivery forecasts or automatic budget changes.

**Allocate a budget across campaigns** appears for guided Google/Meta campaign-by-day evidence. Choose 2–50
campaigns from paginated retained totals, then supply each floor/cap and a positive total period budget. The model
maximizes linear modeled conversions within those constraints. Amounts support six decimal places; exact integer
arithmetic preserves the total and constraints, and equal efficiencies use native ID ordering. A floor sum above
the budget or cap sum below it is refused. No campaign, currency or report is silently added to the selection.

The `allocation` options are `budget`, `allocations:[{entity_id,minimum,maximum}]`, `efficiency_low`,
`efficiency_high`, `minimum_conversions` (1–1,000,000) and `maximum_age_days` (1–90). Known positive spend and
enough observed conversions are required for every selected campaign. Incomplete reports, unknown measurement,
duplicate campaign/day rows, future/open periods and stale evidence are refused. Both capture time and the native
timezone's reporting end date must be recent; recapturing old dates does not satisfy the age check.

Proposals retain source hash, scope/measurement definitions, assumptions and binding constraints and can be
downloaded as JSON. Their budgets cover a comparable period of the same duration as the evidence. They are not
native daily budgets, calibrated forecasts or approvals. Linear response ignores saturation, causal effects and
changing auctions; the conversion threshold is an explicit planning assumption, not statistical significance.
Provider floors/caps, shared budget ownership and native units require separate validation before any reviewed
change. Editing a constraint clears the old result; late results cannot restore stale inputs or another report.
See the [allocation qualification record](review/DELIVERY-2026-10-01-ALLOCATION.md).

Schedules (`/schedules`) lists existing delivery definitions with a read-only preview of the next three windows.
Pause/resume/delete, destination links and recovery use the existing schedule/export engine. Timing preview performs
no provider request and does not create another schedule. Failed Sheets delivery and successful source collection
remain separate states.

## Read-only monitoring

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
evidence. See the [delivery record](review/DELIVERY-2026-10-01-MONITOR-DELIVERY.md) for limits and lifecycle checks.

The existing owner-selected report retention period includes captured analysis reports and resolved/superseded history.
Current open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
evidence under the existing disconnect workflow.

## Portfolio, measurement and commerce

Live portfolio (`/portfolio`) supports Google Ads and Meta. Google campaigns, ad groups and ads use validated
keyset continuation and retain account/login/parent scope. Duplicate, out-of-order and wrong-parent rows are refused;
each page is limited to 100 entities, 5 requests, 60 seconds and 8 MiB. Native monetary fields remain labeled micros.
This is a paginated current inventory, not a point-in-time snapshot while a provider account changes.

Meta supports `amcp_workspace {action:"portfolio",gateway:"meta_native_action",account_id,connection_id,limit,
requirements:{entity:"campaign"}}`. Use the returned IDs for `entity:"adset",campaign_id` and then
`entity:"ad",campaign_id,adset_id`. Read each parent with the same account/login first; these ownership observations
last five minutes. Each child call re-reads the native parent and checks every returned row's exact account and
hierarchy before exposing the page or recording child ownership. A current read never grants write authority.

Meta pages contain 1–100 rows, use the provider's order/default status visibility, and retain configured and
effective status separately. Missing amounts remain null; exact native integers are not divided by an assumed
currency scale. Cursors are signed and bind the tenant/user, account/login/authorization, entity, parents and page
size. They expire after five minutes and bound a chain to 100 pages. Requests reuse only the opaque `after` token,
never a provider-supplied next URL. Repeated cursors, duplicate/overlapping adjacent pages, malformed IDs/amounts,
oversized pages, incomplete envelopes and changed scope fail. A page is bounded to eight requests, 60 seconds and
8 MiB. This is current inventory, with no guarantee of complete historical statuses or consistency across pages.
Expired parent observations require refreshing the parent inventory; other provider adapters remain qualified
native workflows in Capabilities.

The website switches between Google ad-group and Meta ad-set terminology, provides parent/first-page navigation,
shows exact IDs and native states, and wraps controls at mobile widths. Account-selection changes clear previous
results immediately. Late responses/errors cannot repaint a newer account, route or identity. Wide tables have a
keyboard-focusable scroll region; returned headings receive focus.

Measurement (`/measurement`) connects the existing Google Tag Manager configuration audit with GA4/Search Console
reporting, client conversion mappings and reviewed contract discovery. `measurement_audit` takes an exact GTM
account/login and optional container/workspace requirements. It establishes configuration evidence; actual event
delivery, deduplication and business attribution remain unmeasured by that audit.

Commerce (`/commerce`) validates a Meta product CSV before creating a reviewed plan. Fields: retailer_id, name,
price, currency, image_url; optional url, availability, condition, brand and description. Files are capped at 128 KiB
and 50 products, with unique stable retailer IDs and HTTPS media/product URLs. `catalog_preview` does no provider
egress; `catalog_plan` saves one native product step per item. Both require the exact Meta account/login/catalog ID
and an explicit `allow_upsert` boolean. Decimal prices become exact integer hundredths through the existing qualified
Meta product contract. Every item then gets the normal native ownership, before-state, review, receipt and
verification path. There is no implicit deletion and no direct write on import. WooCommerce synchronization,
destination fan-out and automatic feed deletion are not implemented.

## Client report packs and recovery

`amcp_reporting_overview {action:"report_pack", id}` presents a finished retained snapshot with its separate summary
groups, coverage, source hash and authenticated raw CSV/evidence links. The website provides a styled preview,
script-free HTML, generated PDF and Excel downloads, and browser print preview. A confirmed presentation editor
saves a brand name, accent color, footer and standard/compact layout against the snapshot's current revision.
The edit changes presentation metadata, never source rows or native objects. It performs no recollection, FX
conversion or silent cross-account aggregation. Review visible client/account labels before sharing the file.
Unknown metrics stay unknown; ratio charts name their shared scale.

`save_presentation` requires `id`, `presentation_revision`, `presentation` and `confirmed:true`, operator authority
and current access to every source. The authenticated `.pdf`/`.xlsx` paths returned by `report_pack` recheck session,
source access and snapshot/presentation revisions after asynchronous generation. Files are generated in memory,
with no server-side download archive. PDF includes source evidence and its embedded Latin/Arabic font; unsupported
glyphs produce an explicit error. Excel includes five formatted sheets: Report, Account summaries, Campaign rows,
Source coverage and Evidence. Literal names stay strings, numeric metrics stay numbers, missing values stay blank,
and the workbook states that retained values do not recalculate when edited. Evidence JSON is chunked in order.
Presentation metadata follows snapshot deletion/retention. See the
[download limits and evidence](review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

Clients & templates can also retain optional `report_presentation` inside an approved client profile, using the
same bounded brand/color/footer/layout fields. From a report pack, **Use approved client branding** lists compatible
approved profiles, previews their exact values and requires confirmation before replacing the snapshot's style.
Nonempty profile bindings must cover every report source's exact provider/account/login. Empty bindings mean no
profile-specific account restriction; current report access is always required.

`presentation_profiles {id,offset?,limit?}` projects only approved branding metadata, with pages of 1–100 and at
most 100 candidate profiles checked per request. Continue with `next_offset` even after an empty filtered page.
`apply_profile_presentation` requires `id`, `profile_id`, `profile_revision`, `presentation_revision` and
`confirmed:true`. It copies the current approved revision atomically into the snapshot, records `presentation_source`
and preserves existing source rows. Later profile edits or deletion leave that copy unchanged; manual
`save_presentation` clears the copied-profile provenance. The report title receives keyboard focus after saving,
and delayed responses cannot replace a newer route or signed-in identity. Scheduled local file destinations are
described below. See the [branding delivery record](review/DELIVERY-2026-10-01-PROFILE-BRANDING.md).

Operations (`/operations`) uses `amcp_workspace operations` for paginated campaign plans, upload reviews, Overview
snapshots, export jobs, Overview schedules, incidents, workbook report runs (`kind:workbook_report`) and workbook
schedules (`kind:workbook_schedule`). Filter by
kind, attention category, name/ID and exact account/login.
Continue with `next_cursor` using the same identity and filters, including after an empty page with `has_more:true`.
The new feed projects only metadata and checks at most 500 candidates per call. It rechecks current engine ownership
and account grants on every page, and exposes only an original-object path and read-only next call. Updates may
move rows between pages; refresh for current state. Audit activity remains a separate history surface.
Owner-only support bundle preview/export preserves the backend's sanitized projection. Backend error codes,
safe recovery advice and request references survive the website wrapper. First-party MCP envelopes add versioned
`meta.workflow` state, original `source_state`, exact internal path, permitted next call and required acknowledgements
when present. Native provider payloads cannot supply these links. `automatic_retry_of_mutation` is always false.
Monitoring adds `attention_required`, `deferred` and `complete` outcomes without replacing factual incident state.
The synthetic SDK journey tests measure calls and response bytes; external MCP client acceptance is separate.

Workbook runs open `/operations?run_id=<original-id>`. `amcp_workspace report_run` takes that `id` and returns a
bounded status, original query revision, current account/login, attempt count and retained-result availability.
Prepared runs need explicit execution and appear under Attention; queued runs already await a worker. Operators
can resume prepared, failed or cancelled runs after confirmation with the displayed `run_version` through
`resume_report_run`. A changed run requires refreshing; queued/running/completed work is not restarted. The worker
retains its current-creator and independent read-only checks. A rejected write query requires a corrected new query.
Rolling dates resolve at execution, so a resumed rolling run may collect a different date window.

The older `amcp_native_action get_reporting_run_status` now returns this metadata summary; use `get_reporting_run`
to retrieve retained input/results explicitly. Both reads and `execute_reporting_run` recheck the saved run's account
scope and current connection access, independent of later query edits. Native compiler account aliases in structured
argument bags are recognized and conflicting anchors are refused. Jobs whose scope exists only in opaque body
strings, resource paths or provider results remain unavailable until a new explicitly scoped query is prepared.
Unscoped historical runs are not assigned an account by guesswork. Full job inputs/results, encrypted actor bindings,
leases and raw errors are absent from status and the feed. Legacy workbook bindings still describe local storage;
this view does not establish a live Google Sheets destination. See the
[workbook Operations delivery record](review/DELIVERY-2026-10-01-WORKBOOK-OPERATIONS.md).

Workbook schedules open `/operations?workbook_schedule_id=<original-id>`, also reachable from Schedules.
Inspect the current saved query revision/account and the next three clock occurrences, then edit the name,
hourly/daily/weekly/monthly clock and explicit IANA timezone. The saved query still controls report date windows;
changing the clock timezone does not change the query timezone. Before confirmation, a server preview validates
the proposed fields and shows their changes and three future times. Pausing prevents future enqueues while existing
queued/running work retains its state and saved query. Resuming uses the operator's current access and the next future
occurrence, without creating a catch-up job. Monthly dates clamp to the last day of shorter months; nonexistent DST
times are skipped and repeated local times run once. Previewed times remain visible while paused and are labeled as
clock previews. A last-run link appears only when the user still has access to that original run.

`amcp_workspace report_schedule` returns bounded metadata and `schedule_version`. Send that version with `id`,
`active` and `schedule:{name,timezone,schedule_kind,minute,hour,weekday?,day?}` to `preview_report_schedule`.
The preview makes no changes. Save through `save_report_schedule` with the same fields and `confirmed:true`.
The server rechecks current scope, operator access, schedule revision and saved query revision transactionally.
`STALE_REPORT_SCHEDULE` requires refresh and another review. Readers can inspect but cannot save. This editor
keeps query identity and workbook binding intact and does not configure external spreadsheet delivery.
See the [workbook schedule delivery record](review/DELIVERY-2026-10-01-WORKBOOK-SCHEDULES.md).

Client packs can also be delivered on the existing report schedule to a local **PDF / Excel destination**.
Create it in the delivery dialog with explicit formats, branding and storage confirmation; a Sheets connection is
optional for this flow. Schedules collect their original scoped definition and queue a separate file job from the
retained snapshot. Delivery status, history and Operations preserve the original export ID and job. Successful
formats survive a failed-format retry, and each download rechecks current source access. The job freezes its
branding and source fingerprint. Encrypted files follow snapshot deletion/retention, with 20 MiB per-file and
256 MiB encrypted-storage limits per workspace. Complete-only partial snapshots remain undelivered.
The [reporting guide](REPORTING-OVERVIEW.md#scheduled-pdf-and-excel-files) documents the shared MCP contract,
queue limits and recovery. External email, Drive-folder and object-storage file destinations are not implemented.

## Allocation proposals and native budget drafts

Google campaign allocation results offer **Prepare a native budget draft**. Explicitly choose equal-daily conversion,
read the current dedicated daily budgets and inspect the exact amounts, micros and rounding residuals. Confirmation
saves a source-bound, unapproved Campaigns plan. Average daily amounts continue until separately changed; the
reference period does not schedule an end date or guarantee a period spend. Shared/lifetime/foreign budgets and
changed source/ownership are refused. The original source and current native ownership are checked before unsent
proposal steps, while the existing native review, spend acknowledgement and read-back remain required.

MCP uses `preview_allocation_plan` with report `id`, allocation `options` and `conversion:"equal_daily"`, followed
by `create_allocation_plan` with the same `id`, exact `preview_id`/`preview_hash` and `confirmed:true`. Preview is
bound to the current session and lasts ten minutes. Follow its returned `amcp_campaign get` and website link to
inspect the original draft. Lost responses reuse the same plan. `amcp_campaign create` also supports optional
stable creation keys. See the [native budget-draft record](review/DELIVERY-2026-10-01-ALLOCATION-PLANS.md).

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
broader objective recipes, additional portfolio providers, broader creative performance lineage and calibrated optimization
retain unfinished scope in the implementation matrix. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.
