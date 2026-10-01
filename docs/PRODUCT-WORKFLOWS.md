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

`amcp_workspace {action:"capabilities", gateway?}` projects executable campaign recipes, Overview adapters, detailed
capture presets and media routes into workflow cards. Required inputs, effects, next calls, local account blockers
and unverified provider prerequisites are explicit. `contracts` remains the paginated, searchable action ledger.
Neither view creates a grant or replaces native preflight/review.

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

Creative (`/media`) presents source files, variants, per-destination preparation, paginated receipts and single-upload
job status. A new **Save as resumable upload plan** action retains up to 50 eligible matrix rows as media-only
campaign steps, preserving every target and original source hash. Saving does not upload. Review and execute the
saved plan through Campaigns; successful step receipts survive later target failures.

The immediate bulk flow continues to prepare and execute one destination at a time, respecting the existing
two-review staging quota. Saved source files still expire after 30 minutes; a durable plan is not permanent media
storage. Source/variant/upload/creative/ad/performance joins are not added by this release. See
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

`amcp_workspace` actions: `monitors`, `save_monitor`, `set_monitor_state`, `incidents`, `acknowledge_incident`, and
`evaluate_monitors`. Saving requires operator authority, current account access, `confirmed:true`, and a monitor
containing name, platform, connection_id, account_id, currency, timezone, result_definition, attribution, metric,
comparison, threshold and max_age_hours. Up to 100 rules are retained. Supported metrics are spend, clicks,
conversions and CPA; comparisons are above/below; evidence age is 1–168 hours. Changes use the current revision.

Finished Overview snapshots evaluate matching enabled rules under the rule author's current authority. Incidents
deduplicate by rule version, objective and measurement window. Acknowledgement persists while the threshold stays
breached; only newer, complete, comparable evidence resolves an incident. Stale, missing and incomplete data never
becomes a successful zero. Freshness uses the oldest contributing row capture, not the later job completion time.
The latest evaluation records unavailable data/access or ignored older evidence. The API pages at up to 100 results;
the website currently shows the latest 100 incidents. There is no snooze or external notification delivery.

The existing owner-selected report retention period now includes captured analysis reports and resolved incidents.
Open/acknowledged incidents and rules are preserved. Disconnecting a connection purges its retained reporting
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
script-free HTML download and browser print/save-PDF control. It performs no recollection, FX conversion or silent
cross-account aggregation. Review visible client/account labels before sharing the downloaded file. Automated PDF
or XLSX delivery is not implemented. Unknown metrics stay unknown; ratio charts name their shared scale.

Operations (`/operations`) combines the currently loaded campaign, upload and report issues with original-object
links. Owner-only support bundle preview/export preserves the backend's sanitized projection. Backend error codes,
safe recovery advice and request references survive the website wrapper. First-party MCP envelopes add versioned
`meta.workflow` state, original `source_state`, exact internal path, permitted next call and required acknowledgements
when present. Native provider payloads cannot supply these links. `automatic_retry_of_mutation` is always false.

## Qualification boundaries

All additions use synthetic fixtures and existing provider contracts. No new OAuth scope, provider program,
advertising mutation, notification destination or deployment is authorized by this guide. Full Arabic translation,
new objective recipes, cross-provider portfolio expansion, creative performance lineage and calibrated optimization
remain open in the blueprint. See the dated implementation record for actual tests, browser checks and deployment
limitations rather than treating a capability card as live acceptance.
