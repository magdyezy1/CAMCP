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
Clone support remains the existing Google Search, Snapchat, TikTok and LinkedIn scope. This release adds no new
provider objective recipe or generic mutation passthrough.

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
alone does not prove usage. External usage remains unknown and performance is not joined. Every page/detail checks
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
| `capture_preset` | `preset`, exact `connection_id`/`account_id`, and `semantics`; saves mapped evidence |
| `overview_sources` | `id` of a retained Overview snapshot; lists eligible semantic groups |
| `capture_overview` | Snapshot `id` and exact `group_id`; reuses retained evidence |
| `scenarios` | Evidence `id`, `options.budgets`, `efficiency_low`, `efficiency_high`; returns explicit sensitivity assumptions |

Presets are `google_campaign`, `google_adset`, `google_ad` and `google_search_terms`. Each needs currency, IANA
timezone, date_from/date_to, attribution, conversion_definition, source_name and a boolean complete declaration.
The first three retain daily grain; search terms retain campaign/ad-group/search-term grain over the selected
period. Native Google cost micros are divided by 1,000,000. Presets require complete paging and are bounded by 120
requests, 10,000 rows, 120 seconds and 32 MiB. Those limits do not qualify every provider combination. Declared
semantics must match the native account/query; search-term visibility can prevent reconciliation to campaign totals.

Scenarios accept 1–12 decimal budgets and positive low/high efficiency factors no greater than 10. They need positive
observed spend and conversions. They are linear CPA sensitivity models, with evidence age/completeness and source
hash attached, not calibrated delivery forecasts or automatic budget changes.

Schedules (`/schedules`) lists existing delivery definitions with a read-only preview of the next three windows.
Pause/resume/delete, destination links and recovery use the existing schedule/export engine. Timing preview performs
no provider request and does not create another schedule. Failed Sheets delivery and successful source collection
remain separate states.

## Read-only monitoring

Monitoring inbox (`/monitors`) creates an explicit rule from a retained measurement context. The destination is
the workspace inbox only. No email, webhook or advertising change is sent.

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
Resolved/superseded records cannot be snoozed or resumed. External notification delivery remains unimplemented.

The existing owner-selected report retention period includes captured analysis reports and resolved/superseded history.
Current open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
evidence under the existing disconnect workflow.

## Portfolio, measurement and commerce

Live portfolio (`/portfolio`) currently supports Google Ads campaigns, ad groups and ads. Reads use validated
keyset continuation and retain account/login/parent scope. Duplicate, out-of-order and wrong-parent rows are refused;
each page is limited to 100 entities, 5 requests, 60 seconds and 8 MiB. Native monetary fields remain labeled micros.
This is a paginated current inventory, not a point-in-time snapshot while a provider account changes.

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
Presentation metadata follows snapshot deletion/retention. Scheduled file delivery and reusable branding templates
remain separate expansion work. See the [delivery limits and evidence](review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

Operations (`/operations`) uses `amcp_workspace operations` for paginated campaign plans, upload reviews, Overview
snapshots, export jobs, schedules and incidents. Filter by kind, attention category, name/ID and exact account/login.
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

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
new objective recipes, cross-provider portfolio expansion, creative performance lineage and calibrated optimization
remain open in the blueprint. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.
