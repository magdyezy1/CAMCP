---
status: reference
tier: operator
---

# Reporting Overview

Finished snapshots also provide branded PDF and Excel downloads through client report packs. Generation is
authenticated, bounded and rechecks every source account after rendering. See the
[report-pack workflow](workflows/REPORT-PACKS.md#client-report-packs-and-recovery) and
[format limits and evidence](records/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

## Client reports and reusable templates

Use **+ New report** for a separate setup. Give it a client label and report name,
select the exact login/accounts, and choose metrics, formulas and objectives.
**Save report** adds it to **Report library**. Reopen it and use **Save changes**
to edit the same report. **Duplicate setup** starts an independent copy, with no
destination or schedule; choose those explicitly for the new report. **+ Connect
accounts** opens Connections; it does not create an advertising account at a provider.

**Save as new template** retains report settings, metric/formula definitions,
calendar choices, per-platform native metric defaults, objective-level targets and their other-currency targets.
It excludes client/account identifiers, campaign-specific targets, spreadsheet
destinations and schedules. Review business targets/currencies when reusing it.
Open a template to edit it, or choose **Create report from template**, supply the
client and select its current accounts. Templates never grant provider access.
There can be up to 100 saved reports and 100 templates per workspace.

**Delete report** removes that saved setup and its linked schedule, cancelling
pending runs/deliveries. **Delete schedule** keeps the setup. Deleting a template
does not change reports created from it. The separate **Recent snapshots → Delete**
control removes a collected result and its reporting jobs. These operations keep
external Google spreadsheets and tabs unchanged. Reports shared with other workspace
members use revision checks: a stale edit or deletion must reload the current setup.
Previously selected accounts that become unavailable remain visible until explicitly
removed; the UI does not silently drop them from a saved report.

## Data grouping versus delivery frequency

**Group data by** chooses whole-period, daily, Monday–Sunday weekly or calendar-month
rows. This is independent of when the report runs. For example, Client A can receive
daily rows for the previous complete month on the first day of each month, while
Client B receives a seven-day total every Monday in a different spreadsheet.

Dates are inclusive. Weeks/months at the beginning or end of a custom range are
clipped to that range. AMCP queries each period directly using the existing native
adapter; it does not sum daily reach/users/frequency into a false monthly total.
The table, CSV and Sheets all retain each row's period dates, currency, native
timezone, quality and formula provenance. Summary cards separate account/period
groups and show the first twelve; all rows remain in the paginated table and exports.

Collection freezes the resolved dates. Completed periods and native async job
checkpoints survive a retry. A rejected period remains an explicit coverage failure;
it does not become zero activity. Successful periods are retained, but recommendations
remain conservative for that incomplete source. Download source evidence for all
period diagnostics. Limits remain 366 days, 30 sources and 10,000 rows per source
**across all its periods**. Shorter ranges or fewer accounts reduce quota consumption.

**Request efficiency (RPT-03, source contract `campaign-source-v4`).**

- Each source reads its account once per job; later periods reuse that read (lineage marks it `cached`). A grouped
  (daily, weekly or monthly) source reads the account once more after collection (`account_verify`). A changed
  currency or time zone fails the source with `REPORT_ACCOUNT_CHANGED` instead of mixing days.
- Daily Google and Meta campaign sources send one natively day-segmented request (`segments.date`,
  `time_increment=1`) and split it by day (`sources[].collection_mode:"native_daily"`). A single-day row is what a
  per-day query returns, reach and frequency included. If the provider refuses the segmented request, the source falls
  back to one query per day with a warning. Weekly and monthly grouping, and every other platform, keep one query per
  period, so reach and frequency are never summed from days.
- Snapshots started under `campaign-source-v3` keep the per-period path when they resume. Each new snapshot, including
  a scheduled one, starts under the current contract.
- `run` returns `estimated_requests`: the fewest provider requests the configuration can need. Pages, retries, polls
  and X analytics are not counted. A configuration whose estimate already exceeds the 1,200-request job budget is
  refused with `REPORT_COLLECTION_LIMIT` (`details.estimate`) before any provider request, and nothing is queued.
  `bootstrap` lists each platform's `request_model`. For example, 30 Meta accounts over a year: weekly needs at least
  1,650 requests and is refused; daily needs 90.

## Reporting levels and measurement settings

The shared positions are campaign, middle level (`adset`) and ad. Labels retain the platform's native hierarchy:

<!-- overview-levels:start -->

| Platform    | Campaign position | Middle position | Ad position    |
| ----------- | ----------------- | --------------- | -------------- |
| `google`    | Campaign          | Ad group        | Ad             |
| `meta`      | Campaign          | Ad set          | Ad             |
| `tiktok`    | Campaign          | Ad group        | Ad             |
| `snapchat`  | Campaign          | Ad squad        | Ad             |
| `linkedin`  | Campaign group    | Campaign        | Creative       |
| `microsoft` | Campaign          | Ad group        | Ad             |
| `reddit`    | Campaign          | Ad group        | Ad             |
| `apple`     | Campaign          | Ad group        | Ad             |
| `x`         | Campaign          | Line item       | Promoted tweet |

<!-- overview-levels:end -->

GA4 and Search Console use the resource position. X Ads additionally reports native line items and promoted tweets;
the provider's promotion ID identifies each promoted-tweet row, including when several promotions reuse one tweet.
`bootstrap.platforms[].entity_levels` supplies the available levels. V4 applies server defaults and permits an
undeclared window as labelled partial, with recommendations held. A legacy detailed source must explicitly declare
`report_options.complete_window` as a boolean and its measurement settings. TikTok and Snapchat require
`complete_window:true` and a closed reporting window. Other supported detailed sources can declare an incomplete
window, which keeps the source partial and holds recommendations. A v4 campaign-level source that declares
`complete_window:false` is partial on every platform, with the declared-incomplete warning; at that level an
undeclared window still needs no declaration. A v3 campaign source cannot declare a window (`INVALID_REPORT_LEVEL`),
so no stored v3 state changes. A detailed source whose window was never declared is partial with its measurement
marked incomplete (`quality.measurement_complete:false`), and its advice says so.

Legacy Snapchat ad-squad reporting (`level:"adset"`) requires `campaign_id`, the exact parent campaign UUID. V4 instead
collects all account campaigns, or the optional exact `campaign_ids` scope, and preserves an old scalar as that scope.
A reusable legacy template can defer selecting its parent. Other legacy detailed presets, including Snapchat ads, refuse
`campaign_id`. Campaign-level sources accept no parent filter and only Meta/Snapchat accept their optional native
attribution profile there; detailed settings do not apply to campaign totals.

Legacy guided detailed sources use their preset metrics. Additional `native_metrics` at those levels are refused with
`INVALID_NATIVE_METRICS`; clear them before selecting a detailed level. A v4 source is refused the same way, with the
same code and sentence and before any provider request, when it selects any detailed level, even beside the
campaign level. Campaign-level native metrics retain their existing platform-specific validation. Missing metrics
remain unavailable.

`bootstrap.platforms[].reporting_v4` supplies each platform's `levels`, `defaults`, `option_names`, `option_choices`
(the fixed attribution windows of the platforms that have them, and which of them exclude each other),
`supported_statuses` and `status_basis`. The website reads its window controls, defaults and option lists from it and
keeps none of its own. It asks for **I have checked the reporting window is complete** only where the answer matters:
for a source with a detailed level, or one saved as incomplete. A campaign-level window needs no declaration.

## Objective sources

Each row retains the native `objective`, its AMCP `objective_group`, `objective_source` and `objective_reason`.
Resolution follows this order: an explicit campaign-position override; a saved legacy hand-chosen `objective`;
the provider's declared objective; conservative inference or mapping where supported; the report's fallback;
otherwise unknown with a reason. The server supplies the platform tables and available choices through bootstrap.

- `objective_fallback` applies when the platform gives no usable objective. The website labels it **Objective when
  the platform gives none** and writes it only after the user changes that selection. Leaving it unset preserves
  provider-led resolution.
- `objective_overrides` is a per-source map of campaign-position IDs to chosen groups, with at most 500 entries.
  For LinkedIn, the campaign position is a campaign group. Unmatched overrides are retained and reported; native IDs
  on rows remain unchanged.
- A legacy `objective` other than `unknown` keeps overriding the source for saved-report compatibility. A legacy
  `unknown` is treated as absent. No saved definition is silently converted.

| Source label        | Meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `user_override`     | A campaign override or saved hand-chosen objective                |
| `provider`          | An objective the platform declares and AMCP groups explicitly     |
| `provider_mapped`   | A group mapped from other declared platform facts                 |
| `provider_inferred` | A group inferred conservatively from an unlisted native objective |
| `user_fallback`     | The chosen fallback after the provider paths gave no usable group |
| `unknown`           | No usable objective; the row explains why                         |

When AMCP could not read an objective (refused, or beyond the entities it reads), the reason says so, never that the
platform returned none, also when a fallback covers it.

Every reason has a stable code. A v4 row's `objective` is `{native, group, source, reason, reason_code, reason_values}`
(the last two only when there is a reason, and `reason_values` only for the codes that name the platform and the native
objective). The website words the reason from the code and never parses the sentence; a snapshot recorded before the
codes keeps its sentence alone.

<!-- objective-reason-codes:start -->

| Code                      | Source              | Reason                                                                      |
| ------------------------- | ------------------- | --------------------------------------------------------------------------- |
| `campaign_override`       | `user_override`     | Chosen for this campaign in the report                                      |
| `source_choice`           | `user_override`     | Chosen for every campaign of the source in the saved report                 |
| `provider_note`           | `provider`          | The platform's declared objective, with a note of its own (a mixed group)   |
| `mapped_by_provider`      | `provider_mapped`   | Mapped from other declared platform facts                                   |
| `inferred_from_native`    | `provider_inferred` | Inferred from a native value AMCP does not list                             |
| `fallback_read_refused`   | `user_fallback`     | The fallback covers an objective the platform refused to let AMCP read      |
| `fallback_read_limited`   | `user_fallback`     | The fallback covers an objective beyond the entities AMCP reads details for |
| `read_refused`            | `unknown`           | The platform refused the read, and no fallback is set                       |
| `read_limited`            | `unknown`           | The report has more entities than AMCP reads details for, and no fallback   |
| `platform_returned_none`  | `unknown`           | The platform returned no objective                                          |
| `source_has_no_objective` | `unknown`           | The source has no campaign objective                                        |
| `no_matching_objective`   | `unknown`           | The platform's objective has no AMCP group; `reason_values` names both      |
| `objective_not_grouped`   | `unknown`           | The platform's objective is not grouped yet; `reason_values` names both     |

<!-- objective-reason-codes:end -->

`mixed` is a row label for a LinkedIn group with different delivered objectives. It cannot be a fallback, override
or filter choice. Unknown stays unknown; neither the website nor MCP invents a default. Objective regrouping can
change monitor incident fingerprints, so an earlier incident can remain open beside one for the new group.

## TikTok collection

Both campaign totals and guided daily detail use the same page rules. Every page with rows must echo its requested
page and size. Missing page metadata, changing totals, duplicate dimensional tuples, oversized pages or more
returned rows than declared refuse the source. A different `total_page` basis is recorded while the declared pages
are read.
Fewer rows than declared can remain partial, with both declared and returned counts.

TikTok's own additive totals decide completeness when comparable: spend matches within half a cent per returned
row; impressions, clicks and conversions match exactly. Matching totals can establish completeness despite a row
count disagreement, with a warning. A gap makes the source partial and names the two values. Missing, non-numeric
or `-` totals fall back to row counts; unavailable row metrics stay unavailable. Overview retains partial sources;
`amcp_reporting` evidence captures require complete collections.

Requests include the level's `STATUS_ALL` filter to include deleted objects. If TikTok explicitly refuses that
optional filter, AMCP retries the read once without it and warns that deleted campaigns may be missing. Daily detail
can cover 1–366 closed advertiser-local days in inclusive, non-overlapping spans of at most 30 days; campaign totals
are limited to 365 days. The existing row, page and request bounds still apply. Matching native totals does not
claim that campaign, ad-group and ad reports reconcile; the snapshot's cross-level check does, within the rounding
described under [levels, coverage and failures](#levels-coverage-and-failures-in-a-v4-snapshot).

## LinkedIn reporting

The campaign position reads campaign groups and their delivered campaigns; the middle position reads native
campaigns; the ad position reads creatives. A group's own objective wins. Without one, only delivered campaigns
establish a shared objective and the group's results; different delivered values produce Mixed, while incomplete
companion coverage keeps the objective unknown. Results attributed to campaigns without delivery are listed as
`other_results`. Names and parents are current metadata, not historical delivery-time values.

| Native objective               | Result used for advice                                                      |
| ------------------------------ | --------------------------------------------------------------------------- |
| Brand awareness                | Members reached, non-additive; conversions remain unavailable               |
| Website visits; job applicants | Landing-page clicks                                                         |
| Engagement                     | Clicks, explicitly labelled because the engagement result is not in the API |
| Video views                    | Video views                                                                 |
| Lead generation                | `oneClickLeads`; `qualifiedLeads` is shown separately and never added       |
| Website conversions            | `externalWebsiteConversions`                                                |
| Talent leads                   | `talentLeads`                                                               |

Mixed groups retain additive spend and impressions and separate results by objective instead of combining unlike
results. Spend omitted alongside explicit zero impressions and clicks is zero under the LinkedIn D3 rule and is
marked `omitted_as_zero`; other absent cost stays unavailable. Reach is unavailable for windows over 92 days and
after a window is split. Frequency stays unavailable.

Every position uses inclusive UTC report days, including a rolling window resolved near midnight in another zone.
Creative detail is limited to the current UTC month and previous five calendar months; too-old or rounded windows
explain the requested and returned dates. An empty window is refused rather than zero-filled; an empty part of a
split window leaves the source partial. The current provider attribution line is retained; conversion-rule windows
are not joined into Overview yet.

At 15,000 rows, AMCP halves the date window down to one day. One period shares at most 32 analytics reads across
all metric batches and campaign/group pivots; metadata reads retain their own bounds. A capped day or exhausted
budget remains partial with its reason. Additive fields sum exactly across disjoint spans; an absent entity or metric
in a span keeps its total unknown. At most 10,000 entities are retained, with a warning at that bound. Native metric
selections remain limited to 18; when base/result fields plus selected metrics need two requests, their entity/date
keys must agree before joining.

## Contract stamps and notices

New runs freeze a stamp per platform in `platform_contracts`: TikTok uses `tiktok-collection-v2`, LinkedIn
`linkedin-levels-v2`. Each saved report has one notice record (`overview_objective_migration`) holding the stamps it
last ran under and the notes it owes. A finished snapshot with rows and a different stamp registers the platform's note
once: TikTok's explains that including deleted campaigns can increase past spend; LinkedIn's explains the new native
positions. The record also holds the D22 note, registered when a stored report with a hand-chosen objective that has
run before is upgraded; a report that never ran is told nothing.

Every snapshot recorded while a note is unspent carries it in `notices`, so History shows it. A note is spent when a
delivery of a snapshot that carries it succeeds (a file export delivered, a Google Sheets tab written), or when the
snapshot is recorded if the report has no scheduled delivery. A failed, skipped, cancelled or complete-only-blocked
delivery spends nothing; a manual run of a scheduled report carries the note without spending it; a comparison
baseline neither carries nor spends one. History is read once per report, when it is first seen; deleting it never
repeats a spent note. Existing snapshots keep their recorded rows, levels and labels, and a stored report's v3 form is
never rewritten.

## Completeness labels

A source is complete only when every page was collected (`collection_complete`), its measurement is not known to be
incomplete and its window has closed. Each label holds recommendations; nothing is deleted or zero-filled.

- **In-progress day.** A period whose last day has not ended in the source's own day boundary is partial with
  `open_window` and `window_closes_at`, and its recommendations `wait`, whatever the objective. The boundary is the
  account time zone, or the collector's fixed zone (LinkedIn, Apple and Reddit UTC; Search Console Los Angeles). An
  unknown zone uses UTC−12, so the latest day stays open until it has ended everywhere. Future `until` dates are
  therefore partial, not refused (Microsoft is the exception below).
- **Microsoft account days (RPT-04, owner policy P6).** Microsoft reports use the account's own `TimeZone`, sent as
  the matching `ReportTimeZone` (`sources[].report_time_zone`) and labelled with its IANA zone (for example
  `AbuDhabiMuscat` is `Asia/Dubai`); `src/microsoft-timezones.ts` maps all 75 pinned enum values. An unknown zone falls
  back to London with a warning. Because `ReturnOnlyCompleteData` is invalid for a period that includes today, a window
  ending on the account's current day is deferred with retryable `REPORT_PENDING` until an hour after that day ends,
  a later end date is refused with `INVALID_REPORT_RANGE`, and Microsoft error 2004 is retried an hour later. This
  changes Microsoft totals for non-UK accounts; a Microsoft job submitted before this change keeps its London days.
  The deferral holds the whole snapshot: a run stops at its first retryable source error, so the sources after a
  Microsoft source whose window ends today are collected only when the retry runs (up to about 25 hours later),
  unlike the other platforms, whose open day is delivered as partial. Set the window's end to yesterday for a
  same-day snapshot.
- **Microsoft report jobs (RPT-06).** `SubmitGenerateReport` creates a provider job. Before it is sent it is admitted
  against the hourly bound per account (`PROVIDER_JOB_QUOTA`), refused while an owner's pause covers provider jobs
  (`WRITES_PAUSED`; the default pause scope `all` and the `provider_jobs` scope both cover it, so such a pause stops
  Microsoft sources of Overview snapshots while other reads continue), and recorded as a `provider_job` receipt in the source's checkpoint. A resumed snapshot polls the
  original `ReportRequestId`; when the earlier submission's answer was lost, it is never submitted again
  (`PROVIDER_JOB_UNCERTAIN`; run a new snapshot). Only a definitive refusal that created nothing (such as error 2004)
  may be submitted again. Reviewed report and export jobs of the other providers follow the deployment owner's
  `AMCP_PROVIDER_JOBS` switch and an account's report-job grant (see
  [write operations](WRITE-OPERATIONS.md#provider-report-and-export-jobs)). An administrator grants report jobs in
  Connections: `PROVIDER_JOBS_DISABLED` while the switch is off, `WRITE_ACCOUNT_NOT_SELECTED` for an account the login
  does not select; an invalid `AMCP_PROVIDER_JOB_HOURLY_LIMIT` refuses jobs with `CONFIGURATION_INVALID`.
- **Declared incomplete.** A supported detailed source that accepts `complete_window:false` is partial
  (`detail_contract:"overview-detail-v3"`) and its recommendations need review.
  Older snapshots with `overview-detail-v2` retain their original stamps and labels.
- **Native parents and more detailed providers (RPT-07, `overview-detail-v3`).** TikTok ad groups and ads, Snapchat
  ads and LinkedIn creatives carry their exact native parents from one bounded parent read per entity and job (drift,
  foreign or repeated parents refuse the source; a refused read keeps unknown parents with a warning). Microsoft,
  Reddit and Apple now offer ad-group and ad levels with the same `report_options:{complete_window, attribution}` as
  Google: Microsoft uses its ad group and ad performance reports (rows name their campaign and ad group), Reddit breaks
  its report down by `CAMPAIGN_ID`, `AD_GROUP_ID` (and `AD_ID`) and reads current names from the account's ad group and
  ad lists (a listed record naming other parents refuses the source), and Apple reads `reports/apps/adgroups` or
  `ads` (one page of at most 999 rows) with parents from the account's own ad group, ad and campaign records. These
  rows are window totals per entity: additive values are exact (nine places, half to even), reach and frequency stay
  unknown, and names and parents beyond 1000 entities per source stay unknown with a warning.
- **Meta omitted actions (RPT-04, owner policy P6).** Meta leaves zero-valued actions out of `actions` and
  `action_values`. On a delivered row (impressions above 0) from a complete page, an absent requested action counts
  as 0 and is named in the row's `omitted_as_zero` (and in its quality, so CSV and Sheets carry it); a row without
  delivery keeps it unknown. Summaries add these zeros and count them per metric (`summary[].omitted_as_zero`);
  guided Meta captures mark the metric's coverage `omitted_as_zero`. The website marks each such cell with `*` and a
  legend, and the zero-result advice names `results_basis:"provider_omitted"`.
- **TikTok optimization events (RPT-04).** TikTok's `conversion` follows each ad group's optimization event. The
  campaign source reads the ad group list once (`GET /v1.3/adgroup/get/` with `STATUS_ALL`, bounded like the campaign
  list) and gives each row a result definition that names its events, so summaries never add conversions of different
  events. A campaign whose ad groups use different events is held as `needs_review` for cost-per-result advice.
  Campaign reporting covers `AUCTION_CAMPAIGN` data only, as a source warning says.
- **Campaign attribution profile (RPT-04).** A campaign-level Meta or Snapchat source may set `report_options` to
  only the attribution windows its detailed presets use (Meta `attribution_windows`; Snapchat
  `swipe_up_attribution_window` and `view_attribution_window`). Campaign rows then use those windows (Meta at
  impression time, Snapchat at conversion time with total sources) and the same `attribution` label as ad set and ad
  rows, so campaign and detailed reports of one profile reconcile. The profile is part of the saved definition and its
  fingerprint. In the website, **Use explicit attribution windows for campaign rows** sets it. Without one, campaign
  reporting keeps the provider default (Meta unified setting; Snapchat 28-day swipe / 1-day view). Other platforms
  still refuse campaign-level `report_options`.
- **Measurement quality** across periods is tri-state: any known gap is `false`, all known complete is `true`, and
  anything unknown stays `null`.
- **Scope limits** describe what a source covers by design and do not make a snapshot partial: sessions without a GA4
  campaign ID (`ga4_unattributed_sessions`) and Search Console top rows (`search_console_top_rows`). They stay in
  `scope_limitations`, source quality and exports. GA4 sampling, thresholding, `(other)`-row data loss, restricted
  metrics and truncation remain incompleteness.

Rolling windows resolve once in their IANA timezone. A source whose platform fixes its report day (LinkedIn, UTC)
resolves in that zone, no account read; `"source_timezone":"report"` ends it, `"account"` resolves every source in its
own zone (one bounded account read unless the zone is fixed). Rows and `sources[].date_range` carry each source's dates,
`sources[].window_resolution` the zone used. `preview_schedule` lists, per occurrence and source, the zone
(`provider_fixed`, `last_observed` from retained snapshots, or `unknown`), its window, `window_closes_at` and
`open_at_delivery`, without a provider request.

## Levels, coverage and failures in a v4 snapshot

Each requested level of a v4 source is collected as its own unit with its own checkpoint, so an interrupted job resumes
at the unit it was in and never reads a finished unit again. A scope that selects descendants (`ad_ids`, `adset_ids`)
also collects the level that measures them as a supporting unit. It is disclosed and is never a level of the report.
One unit holds at most 10,000 rows across its periods; more is refused with `REPORT_ROW_LIMIT`.

**What a source selects.** These fields of a v4 source choose what its report holds. Selection happens after
collection and hides nothing silently: `sources[].scope` counts `returned_rows`, `retained_rows`, `excluded_rows`,
`excluded_status_rows` and `excluded_unknown_rows`. A row whose status or delivery is unknown never satisfies a
positive filter; it is counted in `excluded_unknown_rows` and keeps the source partial.

<!-- overview-source-selection:start -->

| Field                                 | Takes                                                                                            | Default        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------- |
| `levels`                              | Levels from `entity_levels` (`campaign`, `adset`, `ad`), each once; `level` is the first of them | `["campaign"]` |
| `statuses`                            | `all`, or any of `active`, `paused` and `archived` that the platform supports                    | `["all"]`      |
| `delivered_only`                      | `true` keeps the rows with a positive delivery or measurement                                    | `true`         |
| `campaign_ids`, `adset_ids`, `ad_ids` | Up to 500 exact native IDs each; a platform's old parent filter is the same list                 | `[]`           |

<!-- overview-source-selection:end -->

A v3 definition upgraded to v4 keeps `delivered_only:false`, because the earlier build showed rows without activity.
`status_basis` says whether a platform's status is the entity's current configuration (`current_configuration`) or
the one its report returns (`provider_report_status`).

**State and failures.** A level that cannot be collected has its error in `sources[].level_results[]` and is named in
`sources[].failed_levels`; the source's own `error` is set only when every requested level failed. The snapshot is
`failed` when every requested level failed, `partial` when some failed or any is incomplete, and `complete` otherwise.
`empty_reason` follows the requested levels, so a failed collection is never reported as a filter that matched nothing.
A retryable provider error requeues the job, up to 8 attempts, and the finished units are kept. On the last attempt it
fails that unit alone and the snapshot is saved partial with the failure named; a scheduled report delivers that
partial result. A repeated entity or an account mismatch fails its unit and not the job, and a snapshot never stays
`running` after its job failed. A source whose retained state was written under another platform contract cannot be
resumed, so it is collected again from its start and says so in a warning; the job's counters keep what it already spent.

**Selected IDs.** `scope.unmatched_ids` lists, per level, the selected IDs that no returned row carries, and the source
warns with their count, so a mistyped or stale ID cannot narrow a total unnoticed.

**Rolled-up totals.** A source that selects `ad_ids` or `adset_ids` and also asks for a level above them gets that level
as rows rolled up from the selected children only. Such a row totals those ads or ad sets, never the whole campaign or
ad set, and says so: `aggregation:{kind:"rolled_up", from_level, scope_field, child_rows, label}`, where the label is
"Rolled up from selected ads" or "Rolled up from selected child entities". A summary of such rows is a summary of its
own, never mixed with the native totals of the same level, and carries `aggregation:{kind:"rolled_up_from_selected",
from_level, scope_field, label}`; a summary of native rows has no `aggregation`. Every surface below prints the label.
The cross-level check cannot compare a rolled-up level with the level it was rolled up from
(`derived_parent_population`).

**Coverage.** Every entry of `metrics_coverage` has one shape: `{known_rows, total_rows, basis, report_rows,
known_pairs?, unavailable_reason?}`. `total_rows` counts the units a figure could have been calculated from and
`known_rows` those that had a value. `basis` says what a unit is: `report_rows`, each a row of the report, or
`native_measurements`, where a row was built from the provider's own rows (usually days) and `total_rows` can exceed
`report_rows`. A ratio uses only the units that have every value it needs, and a ratio of two parts says how many with
`known_pairs`. `unavailable_reason` is `unknown_currency` (money in several currencies, or in none, is never added),
`non_additive_inputs` (reach and frequency are never summed) or `calculation_limit`. The website says "n of m rows" for
the first basis and "n of m measurements" for the second. Snapshots stored by earlier V2 builds wrote `known` and
`total`, and are read as recorded.

**Coverage notes.** `get` adds `coverage_notes` to every `summary[]` and `window_summary[]` entry of a v4 snapshot: one
note for each figure that was calculated from fewer units than it has, or not at all, and an empty list when every
figure is complete. The notes are derived on every read from the stored `metrics_coverage` by one computation that every
surface below uses, so an earlier v4 snapshot has them too and nothing stored changes. `state` stays the truth about
collection: 28 campaigns, two without a cost, collect completely (`complete`), and their spend reads "26 of 28 rows".

<!-- overview-coverage-notes:start -->

Each note is `{metric, known, total, unit, reason}`, where `unit` is `rows` or `measurements` (the `basis` above) and
`reason` is one of:

| Reason                | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `missing_values`      | A sum; some units have no value for it, and they are never counted as 0   |
| `missing_inputs`      | A ratio or formula; it uses only the units that have every value it needs |
| `unknown_currency`    | Money in several currencies, or in none, is not added                     |
| `non_additive_inputs` | Reach, frequency and the like cannot be calculated from several rows      |
| `calculation_limit`   | The figure exceeds what one report may calculate, and is not calculated   |

<!-- overview-coverage-notes:end -->

**What each surface says.** The same notes, in the report's language where the file has one:

- The website's summary and whole-window cards list each note ("spend: 26 of 28 rows") and end with "Limited coverage:
  these totals may be incomplete.", also when the source itself is complete. The HTML client pack puts the same words
  beside the values and under its table. A period of the spend sparkline built from some of its rows is a hollow mark,
  never a dip.
- CSV and the Sheets tab: a `Coverage` column names, row by row, the figures that are short ("spend: 1 of 2
  measurements"). After the data rows, one `Coverage note` row per short summary names the platform, the rolled-up label
  and the notes in its `Campaign` column, with the account, currency, time zone, dates and level in their own columns,
  and a last row says what "n of m" means. The metric cells of those rows are empty, so a column of numbers stays one,
  and the words are English.
- Excel: the `Report` sheet has a `Coverage` row per short summary and the explanation. **Account summaries** has the
  `Entity level` (a report of several levels has a summary for each), `Aggregation` and `Coverage` columns. The rows
  sheet repeats the CSV's columns and note rows, and **Source coverage** has a `Level check` column.
- PDF: the coverage notes under each summary, the rolled-up label, the level check lines and the explanation.

**Cross-level check.** `sources[].cross_level` compares spend, impressions and clicks between adjacent levels of one
account and window, per currency and time zone. Counts must agree exactly. Money agrees when the difference is at most
half a minor unit of the currency (JPY 0 decimals, USD 2, KWD 3) for each figure compared on either side, counting each
native measurement that a row sums, because a provider rounds every figure. The comparison keeps `delta`,
`coverage_percent` and the `tolerance` it allowed, so nothing the rounding absorbed is hidden. A pair that cannot be
compared says why: `level_failed`, `derived_parent_population`, different windows, statuses or objectives, an unknown
currency or a missing metric. The website, the PDF and the Excel `Level check` column say the result in words, in the
report's language: which metrics agree, how far one level covers another, which are only partly known and why a pair
cannot be compared. A coverage is the exact percentage, cut and never rounded, so a figure that differs from 100 is
never written as 100%.

**Calculation limits.** Metrics are calculated in exact fractions. A metric that uses another starts from the other's
exact value, and each metric is rounded once, to nine places, half to even. A numerator or denominator past 4,096 digits,
a report that spends its calculation budget (about a third of a second of arithmetic on large numbers) or its time
(two minutes) ends that metric: it is unavailable with `unavailable_reason:"calculation_limit"`, as is any metric that
uses it, never a rounded guess. Ordinary reports are unaffected, and row assembly hands the event loop back every 20 ms.

**Numbers in files.** A v4 snapshot keeps every metric as exact decimal text. The CSV carries that text unchanged. Excel
and Sheets write a number when the text is exactly the number a spreadsheet cell holds (the double prints back as the
same decimal, in at most 40 characters), so sums and number formats work. A value with more digits than a double holds
stays text, so no digit is changed. Excel's `Report` sheet then has a `Precision` row with their count, and the Sheets
column note says that values with more digits than a number holds exactly are kept as text. A v3 snapshot is written as
before.

**Reading a snapshot.** `get` returns a v4 row without its native evidence, and a source without `native`,
`native_account_evidence` and `lineage`; `include:{native:true}` and `include:{lineage:true}` return them. A
`window_summary[].series` point is `{date_from, spend}` and, when its period was calculated from fewer units than it
has, also `coverage` in the shape of a metric's, so a week with one unknown campaign is a short point and not a dip.

**Monitors on a v4 snapshot.** A rule watches the top level its source requested (campaign, then ad set, then ad), so
one window is one incident, and compares the value as exact decimal text, never as a double. A summary answers a rule
only when it is complete, its metric is an exact decimal calculated from every one of its units, and its evidence is
newer than `max_age_hours`. Otherwise the outcome is `data_unavailable` with a `reason`, and it neither opens nor
resolves an incident. `save_monitor` accepts `unknown` as `result_definition` or `attribution`, which is what a source
that cannot name them reports.

<!-- overview-monitor-reasons:start -->

| Reason                  | Meaning                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `incomplete`            | The summary is incomplete: a source, level or period is missing or partial    |
| `coverage_unreadable`   | The summary has no readable coverage for the metric                           |
| `metric_unavailable`    | The metric is not calculated, or is not an exact decimal                      |
| `partial_coverage`      | The metric was calculated from some of its units only                         |
| `evidence_time_unknown` | When the evidence was captured is unknown, or lies in the future              |
| `stale_evidence`        | The evidence is older than the rule's `max_age_hours`                         |
| `no_matching_summary`   | No summary has the rule's account, currency, time zone, definitions and level |

<!-- overview-monitor-reasons:end -->

## Snapshot state in the website (RPT-05)

- **Partial strip.** A partial snapshot opens with a strip that names each failed source with its error code ("1 of 2
  sources failed: TikTok · 200 `REPORT_PERIODS_FAILED`. Totals exclude them.") and each limited-coverage source, with
  links to their source cards. Summary cards end with **Excludes: …** for failed sources, and a card whose source has
  limited coverage, or whose figures were calculated from some of their rows (coverage notes, above), says its totals
  may be incomplete. A failed source reads **No quality metadata — source failed**;
  **Legacy snapshot** is kept for snapshots without `source_contract_version`.
- **Queued and stalled runs.** `get` returns, for a queued or running snapshot, `job.queued_at`, `job.started_at`
  (the first time a worker started it, also stored as the snapshot's `started_at`), `job.queued_ms` and
  `job.worker_recent` (any worker heartbeat in the last 90 seconds; process liveness only). The website shows
  **Queued for N minutes**. After 10 minutes without a start, or when no worker has reported recently, it says **AMCP
  has not started this run yet**; owners get a link to worker health in Settings.
- **Polling.** The page refreshes an active snapshot every 3 s for the first minute, every 15 s up to 5 minutes, then
  every 60 s, and stops after 30 minutes with a **Refresh** button. Cancel, Retry and Refresh start a new watch.
- **Deep links.** An open snapshot sets `?report_id=` (with the saved report's `view_id`) in the address bar.
  Reloading reopens it through the same tenant and actor authorization as any other load; the ID is opaque and the
  URL carries no names or account identifiers. Deleting the open snapshot removes it from the address. **Retry** on a
  source card of a snapshot opened this way first fills the setup form from the snapshot, as **History** does, and then
  submits it once.
- **Whole-window tiles.** A daily, weekly or monthly snapshot also stores `window_summary`: one entry per platform,
  account, currency, timezone, objective and measurement definition, keyed without dates, with additive totals over
  every period (reach and frequency are never summed), ratios recomputed from those totals, `period_count`,
  `entity_count`, decisions counted once per entity and a `series` of spend per period (oldest first). `get` returns
  it; `list` pages leave it out. The website shows one tile per account with a spend sparkline (an image with a text
  summary; an unknown period leaves a gap, and a period calculated from some of its rows is a hollow mark) instead of
  one card per period. Older grouped snapshots keep their per-period cards.
- **Results table.** The row header is the entity name only, at most 40 characters (the full name stays on hover and
  in the context cell), and stays visible while the metrics scroll sideways, at the inline start in both directions.
  IDs, level, parents, account, currency, timezone and source details sit in the **Platform · objective** cell. Daily
  grain has one **Date** column. Below 600 px each row reads as a card with its values labelled by column; explicit
  table roles keep the table semantics. Counts use singular and plural forms, and ROAS reads as a multiple (×).
- **Exact numbers.** Values are formatted from their exact decimal text (never a binary double), currency values in
  the currency's own minor units (KWD 3, JPY 0, SAR and USD 2), with the exact value on hover. This applies to
  Overview cells and cards, retained evidence totals and rows, and the client report pack, which also uses platform
  display names and localized dates. Sheets exports send number formats per metric column in the same batch as the
  cells (currency columns use the largest minor units among the report's currencies, counts whole numbers,
  percentages a literal %, ROAS ×); the cell values are unchanged.
- **Native evidence tables.** Long native resource columns (Google resource names used as entity IDs, geographic
  resources) are hidden by default behind a per-viewer **Show native IDs** toggle; long IDs are middle-truncated with
  a copy button, the row header stays visible while scrolling, and location types read as plain labels with the
  native enum on hover.
- **Prefilled capture.** `amcp_reporting` `capture_presets` with `connection_id` and `account_id` also returns that
  account's stored currency, timezone and read time (`target`), without a provider read. The capture wizard prefills
  both (still editable; the capture still verifies them against the provider, so a mismatch is refused), labels
  details read more than 7 days ago, and defaults empty dates to the last 7 complete days in the account timezone.

## X cooldowns and recovery

Input/access refusals preserve native diagnostics without tripping the transient circuit. Repeated network/server
failures can open a connection/account/origin-scoped circuit; one request probes recovery after cooldown. Other
accounts remain independent. HTTP 429 honors account/user reset headers; 503 honors Retry-After. SQLite coordinates
waiting workers. Completed analytics chunks survive retries without double counting. Native HTTP-200 errors fail;
null metrics mean omitted zero, absent columns stay unknown. Advertising write permissions/retries are unchanged.

**Active entities (RPT-03).** `GET /12/stats/accounts/:id/active_entities` uses CAMPAIGN, LINE_ITEM or PROMOTED_TWEET,
whole hours and at most 90 days per read. Deleted-inclusive inventories supply native names/parents; detail proves
the complete bounded population before narrowing scope.

- Analytics uses overlapping activity windows, separate placements, at most seven days/twenty IDs per request, and
  a 100-request ceiling (`REPORT_RANGE_LIMIT`, `details.planned_requests`).
- No-activity entities are counted in `no_activity_count`, never invented as zero rows. Separate WEB_CONVERSION and
  MOBILE_CONVERSION requests preserve spend if conversion coverage fails.
- Malformed/partial active sets fail. Provider refusal (400/404/422) falls back to bounded inventory with a warning.
- Frozen checkpoints bind the request plan/active hash; detail also binds current authority. Incompatible reuse
  refuses with `REPORT_DEFINITION_CHANGED` or an authority error.
- `AMCP_X_ACTIVE_ENTITIES=campaigns` retains active IDs but widens their reporting window; `off` uses inventory.
- **Time zones.** X reports whole UTC hours. An account whose days start on a half or quarter hour (Asia/Kolkata, for
  example) is read over the whole UTC hours that contain its days, and each boundary hour belongs to the local day
  holding its midpoint, so adjacent days never count an hour twice. The source says so in a warning, and exact
  fractional-hour totals are unavailable. A day whose local midnight is skipped by a clock change starts at its first
  valid instant, for X and for Snapchat.

Reports request ALL_ON_TWITTER, SPOTLIGHT and TREND. PUBLISHER_NETWORK remains unrequested pending
[owner acceptance](acceptance/READ-ACCEPTANCE.md): reported activity there makes coverage partial, excludes its spend
and holds recommendations. An entity active only there is never a zero row. See the official
[analytics](https://docs.x.com/x-ads-api/analytics) and
[rate-limit](https://docs.x.com/x-ads-api/fundamentals/rate-limiting) references and the
[Task 12 runbook](acceptance/ROUND2-TASK12-READ-ACCEPTANCE.md).

## Provider error layers and throttles

A provider refusal is classified from the provider's documented codes before its
HTTP status (`src/provider-error-taxonomy.ts`, which reads each provider's documented
error shapes from its adapter's wire profile, `src/<provider>-adapter.ts`). Each error carries `details.layer`
(`credential`, `consent`, `role_or_asset_access`, `app_eligibility`, `rate_limit`,
`api_version` or `unknown`), a closed-set `details.provider_code` (a token or a
number, never provider text) and the provider request ID. Meta's code 190 is
`REAUTHORIZATION_REQUIRED`, and codes 10 and 200–299 are `PROVIDER_PERMISSION_MISSING`,
at any HTTP status. Meta throttles 4, 17, 613 and 80000/80003/80004/80014 and the
Google Ads `RESOURCE_TEMPORARILY_EXHAUSTED` quota body are `PLATFORM_RATE_LIMIT`. They
wait for Meta's `estimated_time_to_regain_access` (60 s otherwise) or Google's
`retryDelay` (30 s otherwise). An account-level Meta throttle cools down only that
account on that login. LinkedIn HTTP 426 is `PROVIDER_VERSION_UNSUPPORTED`. Meta
`is_transient` makes a read retryable. A write is still sent once and never becomes
retryable. TikTok's in-body return codes follow its official table (src/tiktok-adapter.ts,
read 2026-11-06); any other code keeps its previous code with layer `unknown`. Overview runs
defer a throttled source to the cooldown instead of failing it. The cooldown, not the
transient-failure circuit, governs a throttle: it neither counts toward nor resets that
circuit. Readiness `provider_read` checks carry the same `diagnostic` (code, request ID,
layer); their next step is the readiness advice for that layer (reauthorize in place for
`credential`, allow the named permission for `consent`), and a throttled read is
`unknown` and never saved as shared account evidence.
`AMCP_PROVIDER_ERROR_TAXONOMY=off` restores the HTTP-status classification.

## Report-library MCP example

Discover exact source and destination identifiers with `bootstrap`. The following
is a structure example; replace synthetic IDs with authorized bootstrap values.

```json
{
  "action": "save",
  "confirmed": true,
  "config": {
    "name": "Monthly awareness",
    "client_name": "Client A",
    "sources": [{"platform": "meta", "connection_id": "selected-login", "account_id": "123"}],
    "grain": "daily",
    "date_range": {"preset": "last_complete_month", "timezone": "Asia/Riyadh"},
    "metrics": ["spend", "impressions", "clicks", "cpc"]
  }
}
```

`save` returns `id` and `revision`. To edit, send the same `id`, its
`expected_revision`, and the complete new `config`. `save_template` follows the
same pattern. `delete_view`/`delete_template` also require that revision.
`schedule` can attach to `view_id` with its `expected_revision`; supply a schedule
object containing `schedule_kind`, `timezone`, `destination_id`, and
`schedule_config` (minute, hour, weekday for weekly or day for monthly).
Use a stable `idempotency_key` for creation. `update_schedule` needs the schedule
`id`/`expected_revision`; also send `expected_view_revision` when editing a loaded
report. `remove_schedule` requires its current revision. A creation key belonging
to a deleted schedule cannot resurrect it. An explicit new schedule uses a new key.

`source_defaults` optionally stores account-free per-platform `objective_fallback`, `native_metrics`, `level` and
`report_options`, plus the legacy `objective`. Campaign-specific overrides and embedded account identities are
excluded from these reusable defaults; unsupported fields are rejected.
Schedules keep their original identity, destination ownership and actor checks.

## Dates and empty reports

For a historical month, select **Custom dates → Set a full month**. The date summary spells out the month and year before collection; for example, January 2025 means `2025-01-01` through `2025-01-31`. Report links can prefill explicit `since` and `until` dates without running a request or selecting an account. Account choices show synced account names separately from the connected login.

An empty provider result is labeled **No data**, while rows removed by objective filters are labeled **Filtered out**. Source and displayed row counts are retained separately. CSV and manual Sheets exports reject reports with no rows. An empty scheduled run records a skipped export and leaves the previous destination sheet unchanged. Failed or unfinished reports cannot download CSV attachments.

Meta Insights must return an explicit `data` array. Missing or malformed collections fail visibly instead of becoming empty successes. Requested account/date fields are preserved, and rows for a different account or outside the requested date interval are rejected. Attribution settings and the selected date range are never changed automatically to obtain data.

## Troubleshooting source failures

Failed sources expand automatically and show the provider error code/message, account, failed request stage, request ID and a suggested next step. Use **Copy error details** to share the sanitized diagnostic. The Activity page also shows provider diagnostics from earlier failed reads, without needing another provider request. A failed source is never reported as zero performance; successful sources in a mixed report remain explicitly partial.

The diagnostic's closed `category` determines the source card's actions:

| Category        | Meaning and source-card action                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `provider_data` | AMCP refused incomplete, inconsistent or malformed platform data: Retry and Copy         |
| `connection`    | The login needs attention: Manage connections and Copy                                   |
| `permission`    | Account, role or API access is missing: Manage connections and Copy                      |
| `rate_limit`    | The provider cooldown applies: Copy; the worker's bounded retry policy remains in effect |
| `request`       | Correct or narrow the request: Copy                                                      |
| `provider`      | A provider failure: Retry and Copy                                                       |
| `internal`      | AMCP needs investigation: Copy                                                           |

Provider-data diagnostics keep the provider message/request ID and safe page facts (`page`, `page_size`,
`total_number`, `total_page`, `list_length`, `rule`), plus `declared_rows` and `returned_rows` where available.
They omit `http_status`: a successful HTTP response whose data AMCP refused is not a provider HTTP outage. MCP keeps
its error family; every provider-data remedy asks for a retry, except a changed or invalid response shape.
Saved diagnostics without a category render as before.

For Google HTTP 403, distinguish `USER_PERMISSION_DENIED` (identity/account access or manager routing) from developer-token/project restrictions such as `DEVELOPER_TOKEN_NOT_APPROVED` or `DEVELOPER_TOKEN_PROHIBITED`. With direct customer access, an unrelated `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` should be omitted; manager access needs the correct manager ID. Website logins use the manager route their sync recorded, not this variable (CON-05). After changing server OAuth settings, reconnect Google Ads because existing connections retain their saved credentials/settings. The report displays the login customer ID actually sent. AMCP does not bypass a provider denial or automatically change routing. See [Google's error guide](https://developers.google.com/google-ads/api/docs/get-started/common-errors) and [Google's access model](https://developers.google.com/google-ads/api/docs/oauth/access-model).

Open **Reporting overview** in workspace navigation (/reporting-overview). Select multiple platforms/accounts, a date range, objectives and metrics. Save a report setup or pull a new snapshot. Durable jobs freeze account selection and dates for each run.

## Metrics and decisions

<!-- overview-default-metrics:start -->

When `metrics` is omitted, the default selection is `spend`, `impressions`, `clicks`, `conversions`, `cpa` and `roas`.
Clicks include the platform's taps or swipes; conversions use the source's primary-result definition. CPA is spend
divided by conversions, and ROAS is conversion value divided by spend. Missing operands and zero denominators stay
unavailable. These definitions and the other supported metrics are supplied by `bootstrap.metrics`.
<!-- overview-default-metrics:end -->

- Common metrics include spend, impressions, clicks/taps/swipes, primary conversions, revenue, reach, video views, CTR, CPC, CPM, CPA and ROAS where available. Missing data stays blank, not zero.
- **Meta results.** A v4 Meta row's result is Meta's own: the row's insights `results` entry for its optimization goal, with Meta's `cost_per_result` when the entry that gave the value has one, and spend over the result otherwise. The entry's indicator decides what the result is (link clicks, post engagements, messaging conversations started, landing page views, website purchases, leads, app installs, reach, and so on; an indicator Meta adds later is read as a result of its own), so different indicators are different results and are never added. Under the ad set's own attribution setting the value is the one Meta names `default`. Under explicit windows it is the sum of the requested windows' entries, and a requested window with no entry counts 0, because Meta leaves a zero window out. A metric Meta does not split by window (post engagements and 2-second video plays give `default` only) is the sum of the action's own per-window counts in `actions` when it has them, and its `default` otherwise. A `results` that is not the recorded shape is an unknown result (`unverified_native_shape`) and the row keeps its other metrics; a row with an indicator and no values counted none (a zero Meta left out on a row that delivered, unknown on one that did not). A row with no `results`, or a report that sets one exact `result_action_type`, is mapped by AMCP from documented fields as before (the goal's link clicks, impressions or reach, or the first reported lead, app install or post engagement action, or the exact action), and says so: the row's source details name the native field it came from, the CSV, Excel and Sheets exports add a `Result mapped from` column, and the PDF, Excel and report-pack limitations say mapped results are not the platform's own result column. A report with rows of both kinds shows both. The shape was read live on 2026-11-07 and is recorded in `docs/records/META-RESULTS-PIN-2026-11-07.md`; the V2 code has not been read against a live account yet.
- **Meta action counts under explicit windows.** With explicit attribution windows Meta returns the `value` of an action-stats entry for the ad set's own setting and each requested window's number under the window's name (a window with no number has no key). A v4 report reads the requested windows wherever it reads such an entry: the campaign metrics, conversion value, the exact action of a detail level and every native metric that is a list of action stats. Counts (`actions`, `action_values`, `conversions`, `conversion_values` and the catalog and product lists) add the requested windows' keys; a missing key counts 0, and an action with none of the requested keys is the omitted case above. A cost, a ratio or a number of people (`cost_per_action_type`, `cost_per_conversion`, `cost_per_unique_action_type`, `unique_actions`, `purchase_roas`, `website_purchase_roas`, `mobile_app_purchase_roas`) does not add: it is one window's own number, and has no number for several windows. Any other list is read the same way when its entries carry window keys, and keeps `value` when they carry none (the video metrics came back unsplit). A v3 report, and a v4 report under the ad set's own setting, read `value`. Only `actions` of these lists was read live; the others follow from Meta's type for action stats and are recorded as unread in `docs/records/META-RESULTS-PIN-2026-11-07.md`.
- **Value-based bidding (Google).** A Google campaign whose `campaign.bidding_strategy_type` is `TARGET_ROAS` or `MAXIMIZE_CONVERSION_VALUE` is measured by its conversion value: the row's result is that value, a money result with its own definition ID (`google:conversion_value`), so it is never added to a conversion count. Its ROAS is on the row and summary, its conversions stay in the metrics, and it has no cost per result (spend per unit of value is only the inverse of ROAS), so with no target it is asked for ROAS, and a cost per result target gets **Needs review**. Advice checks its minimum sample against conversions, not value. Other or missing strategies keep primary conversions. Microsoft stays on conversions: its performance reports have no bidding strategy column.
- **Additional native metrics** accepts supported provider field identifiers, with examples per platform. Returned native fields retain a platform prefix and become selectable and usable in formulas. Incompatible metric/breakdown combinations return a source error.
- Custom formulas support named identifiers, arithmetic and parentheses: `conversion_value - spend`, `spend / leads`, or `(conversion_value - spend) / spend * 100`. Choose number, percentage or currency formatting. A bounded parser rejects cycles, unknown fields and unsafe identifiers without evaluating JavaScript. Missing operands or division by zero yield unavailable values.
- Set per-objective KPI targets, direction (higher/lower is better), minimum sample and conversion lag. Monetary targets require a currency. Rolling windows can skip recent days for conversion maturity.
- **Direction.** Without an explicit `direction`, a KPI uses its metric definition (`better` in `bootstrap.metrics`): ROAS, CTR, conversion rate and video completion rate are higher-is-better; CPC, CPM, CPA, CPL, CPI, CPV and cost per engagement are lower-is-better. The target card shows it. Custom, native and additive KPIs (for example `conversions`) must declare a direction (`INVALID_TARGET` names `targets.<key>.direction`). A saved definition from before this rule still runs; its recommendation is **Needs review** naming the field until it is edited.
- **Other currencies.** **+ Target for another currency** on a target card adds an `objective:CURRENCY` target (for example `sales:SAR`) with the card's KPI, sample and lag. A campaign key target beats a currency target, which beats the objective target. The key's currency must equal the target currency. Website saves keep campaign targets and fields set through MCP (`minimum_spend`, `maximum_change_percent`, `result_metric`, and `direction` while the KPI is unchanged).
- **Spend.** Zero spend, or spend below an optional `minimum_spend` in the target currency, returns **Insufficient data**; it never recommends scaling.
- **Grouped rows.** With daily, weekly or monthly grouping, each entity gets one recommendation from its additive totals over the whole window (`basis:"entity_window"`, evidence `periods`, `date_from`, `date_to`), shown on each of its rows. One in-progress period holds the whole entity. Non-additive and native-only metrics stay unknown in that total.
- **Validity.** Recommendations are frozen at collection with `as_of` and `valid_until` (48 hours later); the snapshot never changes. The table shows **As of** and, after `valid_until`, **Expired — refresh before acting**. CSV, XLSX and Sheets cells written after `valid_until` show `expired` with the original decision in the reason; packs and PDFs add an expiry limitation (`recommendations_expired`, `recommendations_valid_until`). Older snapshots expire 48 hours after capture. A Sheets delivery's identity stays the snapshot as captured, so a later retry of the same delivery is still recognized.
- **Scale**, **hold**, **pull back** and **reconsider/pause** are advisory. Each includes its reason and evidence. Missing objective/result definitions, immature or incomplete data, insufficient volume and ambiguous currency hold the recommendation. Nothing automatically changes campaign status or budget.
- Summary cards keep platform, account, currency, timezone, attribution and objective groups separate. Ratios use additive components; reach/frequency/users are not blindly summed. AMCP does not deduplicate cross-platform conversions or invent a global currency total.

## Period comparison (RPT-07)

Compare a snapshot with an earlier window of the same report without spreadsheet work. Comparison reads retained
snapshots only: no provider request and no saved change.

- **Pull a pair.** Tick **Also collect the previous equal window to compare** in the builder, or call `run` with
  `compare:"previous_period"`. AMCP queues two linked snapshots: the current window and the equal-length window that
  ends the day before it (a 31-day window compares with the 31 days before it, not the previous calendar month). Each
  snapshot keeps its own whole-job collection limits and estimate check, so a pair never exceeds the limits of one
  run per job; both count against the 100 active reporting jobs and are refused together. With
  `source_timezone:"account"`, each source takes the equal window before its own resolved window.
- **Compare to.** On a finished snapshot, **Compare periods** lists retained snapshots (`compare_candidates`). An
  earlier snapshot qualifies when both finished collecting, use the same grouping, have equal-length windows, the
  baseline ends before the current window starts, and at least one account appears in both. Others stay listed,
  disabled, with the rule they fail. The previous-period pair is preselected and opened.
- **What is compared** (`compare {id, baseline_id?}`; without `baseline_id` the pair is used). Entities match on
  platform, account, entity level and native ID, and are compared only when their compatibility key also matches:
  currency, time zone, result definition, attribution, entity level and grouping. Additive metrics are summed exactly
  over each window; ratios (CPA, CTR, ROAS, …) are recomputed from those sums; reach, frequency, users and position are
  compared only for single-day native values. Each value has this window, the earlier window, Δ and Δ% at nine decimal
  places, rounded half to even. A zero earlier value has no Δ% (`baseline_zero`); a missing value stays unknown.
  Custom metrics are compared only when both snapshots use the same formulas and the formula reads standard additive
  metrics. Entities in only one window, and entities whose definitions differ, are listed with the reason and never
  counted as zero. Group totals add matched entities only.
- **Analysis.** `amcp_reporting capture_overview` on the current snapshot of a pair also keeps the same group of its
  baseline (`pairing`), and `analyze` uses that pair as its default baseline (`baseline_source:
"paired_previous_period"`). A pair that was deleted or is no longer compatible is skipped with a limitation; an
  explicit `baseline_id` is still checked and refused as before.
- **Limits of meaning.** Deltas are observational: they do not establish causality or adjust for seasonality.
- **On the page.** The comparison is a captioned table in a named region that scrolls sideways (keyboard arrows move
  it); each cell shows this window's value, then "Earlier" and "Change" with Δ%, and a zero earlier value shows "—"
  with the reason on hover. Native entity names keep their own direction. The rendered qualification's
  `period-comparison` kind runs the whole journey (pull a pair, the worker collects both windows, compare) in English
  and Arabic, light and dark, at 320, 375, 768 and 1280 pixels ([local browser QA](LOCAL-BROWSER-QA.md)).

On **Evidence and analysis** (`/reports`), the **Earlier comparison report** select applies the same rule as the server
(same account, report type, grain and measurement definitions, equal length, ending before this report starts) and
shows disabled entries with their reason.

## Coverage

| Source         | Reporting behavior                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Ads     | Campaign GAQL and account metadata; micros converted to currency                                                                                                                                                                                                                                                                                                                                               |
| Meta           | Campaign Insights with account attribution (or an explicit attribution profile), and the row's insights results (the objective-specific result aliases when a row has none)                                                                                                                                                                                                                                    |
| TikTok         | Integrated campaign report plus objective inventory                                                                                                                                                                                                                                                                                                                                                            |
| Snapchat       | Campaign totals/inventory and account-local day boundaries                                                                                                                                                                                                                                                                                                                                                     |
| LinkedIn       | Campaign adAnalytics with verified account currency, native UTC period/completion checks and explicit unknown conversion attribution. Campaign names and objectives come from one bounded read of the account's own campaigns per job (current metadata, not delivery-time values); a campaign of another account refuses the source, a refused read keeps IDs with a warning. Objective override when omitted |
| X Ads          | Campaigns, line items and promoted tweets; exact hourly chunks and current native parents/status. Campaign objectives come from bounded line-item metadata; mixed/refused metadata stays unknown. Planning, placement gaps and recovery are described above                                                                                                                                                    |
| Microsoft Ads  | Durable Submit/Poll campaign, ad group or ad report in the account time zone and secure server-side CSV download                                                                                                                                                                                                                                                                                               |
| Apple Ads      | Campaign, ad group or ad report with explicit UTC range; detailed parents from the account's own records                                                                                                                                                                                                                                                                                                       |
| Reddit Ads     | Campaign, ad group or ad metrics/inventory in UTC and spend micro-units; purchase value is read as cents, not yet verified against Reddit; impressions, clicks and viewable-video objectives report that field as the result, while conversion, catalogue-sales, lead-generation and app-install objectives claim none (`unknown`), so their advice asks for review ([ACC-06](acceptance/READ-ACCEPTANCE.md))  |
| GA4            | Campaign-attributed analytics context, property currency/timezone and threshold signals                                                                                                                                                                                                                                                                                                                        |
| Search Console | Organic page context with limited top-row coverage; no paid-budget advice                                                                                                                                                                                                                                                                                                                                      |

Tag Manager and storage connections have no paid campaign report. DV360, Amazon and Criteo may appear in other native/catalog tools but do not have automatic Overview adapters in this release. Provider approval, account access and entitlements remain necessary. This is not a claim of every vendor metric or live parity.

Bounds: 30 selected sources, 366 days, 25 pages and 10,000 rows per source, with stricter provider limits where applicable. Truncation and source failures stay visible. Retained native rows, fields, attribution, dates, capture time and status support reconciliation against provider exports.

## Google Sheets

1. Enable **Google Drive API** and **Google Sheets API** in the Google Cloud project.
2. Register the Web OAuth redirect URI exactly: https://amcp.shop/api/auth/sheets/callback.
3. Set AMCP_SHEETS_CLIENT_ID and AMCP_SHEETS_CLIENT_SECRET. If both are absent, AMCP uses AMCP_GOOGLE_CLIENT_ID/SECRET; register this callback in that client too.
4. Connections → Google Sheets requests `drive.file` (AMCP-created files) and `spreadsheets` (existing spreadsheets supplied by URL), independently from Ads or private-media Drive connections. Configure both scopes on the Google consent screen. Existing connections with only `drive.file` may need to be connected again for pasted URLs; they continue working for previously authorized files.
5. In **Sheets & schedules**, paste a `https://docs.google.com/spreadsheets/d/...` URL, choose a Sheets login, and name the report tab. **Use this Sheet & add a report tab** verifies the file through an authenticated Google API read and saves the destination. The first export creates an AMCP-owned tab with the requested name plus a short unique suffix; the URL's `gid` does not authorize overwriting an existing tab.
6. Owners/admins can explicitly add a new spreadsheet through its URL. Operators can bind and export already selected spreadsheets. The selected Google login must have edit access for exports. Google authorization and AMCP's per-file account grants are both required; a URL alone is not access. Invalid hosts, denied files and malformed responses cannot add grants. No report data is written by destination setup alone.

Existing selected spreadsheets and creating a new spreadsheet remain available under the alternative setup options. URL-selected spreadsheets are checked through the Sheets API on sync even when they are outside the `drive.file` discovery listing.

AMCP marks its own destination tab and replaces its report cells; other tabs remain intact. Typed cells prevent text from becoming executable formulas. Exports are limited to 200,000 cells and an 8 MiB request. Split larger reports or reduce metrics. A batch may take up to 190 s (Google documents a 180 s processing ceiling) under a renewed destination lock; reads time out after 25 s. Sheets requests share one project budget below 300 per minute across workspaces, a 429 sets a shared cooldown, and export retries use truncated exponential backoff with up to 1 s of jitter. Each delivery records its payload bytes, cell count and duration. A new report replaces the same cells. A confirmed report replay returns its historical receipt without another write; it does not certify that collaborators have left those cells unchanged.

**Tab contract (version 2).** Row 1 keeps the stable column identifiers (metric IDs such as `spend` and `cpa`);
new columns are only appended. Each header cell has a note with its label, unit and currency (`Spend. Unit: KWD.`;
with several currencies the note points to each row's Currency), and metric columns get number formats from the metric
definitions: the largest currency precision among the rows (KWD three decimals, JPY none), `#,##0` for counts, `2.50%`
for a percent value of 2.5 and `2.50×` for ROAS (RPT-05's number formats are this one pass; there is no second).
Formats change how a cell shows, not what it holds; which cells are numbers is described under
[numbers in files](#levels-coverage-and-failures-in-a-v4-snapshot). A trailing **Recommendation basis**
column states what each recommendation rests on (its row or the entity's whole window, as-of time and validity,
confidence and limitations; advisory only); CSV and Excel include it too, always: the version 1 rollback below covers
Sheets deliveries only. The basis sentences are English in every artifact, including `?language=ar` Excel files, where
only the column header is translated (like the recommendation reasons). The tab carries `amcp_table_version` developer
metadata `"2"` and, once, a warning-only protected range (when AMCP creates the tab, or on the first version 2 delivery
to an existing tab that has no protection): a collaborator who edits the tab is warned that AMCP replaces it on every
delivery. A protection its users remove is not added again. A delivery first sent under the earlier unmarked layout
(version 1) keeps that layout for its resend and replay, so its fingerprint is unchanged. `AMCP_SHEETS_TABLE_VERSION=1`
rolls new deliveries back to version 1 (no notes, formats, basis column, marker or protection; a version marker is
removed). Delivery receipts report `table_version`.

Each batch carries one delivery marker. A definitive refusal (400, 401, 403, 404, 413, 429, or a 5xx whose Google
error status is `UNAVAILABLE`) is recorded `rejected`: nothing was applied and the export retries normally. Any
other 5xx, a timeout or a lost connection leaves the delivery `uncertain`. Retries of that same report reread the
marker (at most every 150 s) and record success when the batch was applied, without writing again. After a
10-minute settle window, well beyond Google's 180-second processing ceiling, the same report resends its
identical batch once; an existing tab drops every old delivery marker in that atomic batch, so a late copy of the
first attempt cannot leave two markers. Marker re-checks inside the settle window do not count against the export
job's eight attempts, so the resend is reached even after earlier busy or rate-limited attempts. Until then
`SHEETS_DELIVERY_UNRESOLVED` names the earlier report and newer reports to that tab wait; an older snapshot is
reported `superseded` instead of waiting. Other destinations continue independently. Changing a report's numbers
under the same report ID causes `IDEMPOTENCY_CONFLICT`. The automatic resend for the same report is the implemented
default of owner decision D11's open sub-choice; `AMCP_SHEETS_AUTO_RESEND=off` waits for an operator's **Resend same
report** instead (`SHEETS_RESEND_CONFIRMATION_REQUIRED`).

When the automatic retries end, the report's **Unconfirmed Google Sheets delivery** panel (or MCP
`resolve_delivery` with `destination_id`, optional `delivery_id` and `confirmed:true`) offers **Check again**
(`check`: one marker read), **Resend same report** (`resend`: requeues that report's export job) and **Release
tab** (`abandon`: an audited release that lets newer reports use the tab). Resend and release open after the
settle window. Before each new delivery the tab must still carry AMCP's last confirmed marker: a released batch
that landed late is recorded as `late_applied` and replaced by the next newer report; an unknown or duplicated
marker returns `SHEETS_MARKER_MISMATCH` / `SHEET_OWNERSHIP_CONFLICT` until an operator releases the tab
(`abandon` without a delivery). Such a failed export offers **Release tab** and no Retry (`retry_available:false`,
`release_required:true`; `retry` refuses with `SHEETS_RELEASE_REQUIRED`) until the tab is released, then Retry
again. Every check, resend, release and late application is written to Activity. Retention keeps a snapshot whose
delivery is unconfirmed; deleting it requires `resolution:'abandon'` (the website asks to release the tab first), and
the release and the deletion commit together, so a refused deletion releases nothing. `AMCP_SHEETS_DELIVERY_RECOVERY=off` restores the earlier poll-only behaviour.

Account/source access, the selected Sheets login, destination and worker lock
are checked before delivery. Reconnect or restore explicitly approved access
before retrying a permission failure. A write already accepted by Google keeps
its durable receipt even when access is withdrawn during the response.
Interrupted file creation is reconciled by the app's creation marker; unknown
results never trigger blind duplicate creation.

**Export outcome.** An older snapshot never replaces a newer one. When the tab already holds a newer snapshot, the
export job completes without writing and reports `outcome:'superseded'` (with `newer_report_id` and
`newer_captured_at`) in `export_status` and in the snapshot's delivery history, which shows **Superseded · Not
written** with **Export to a new tab**. `state` keeps the job state, so MCP clients that read `state` keep working;
read `outcome` for what happened at the tab. The dialog warns before exporting a snapshot older than the tab's.

**Delivery dialog feedback.** Results appear in a status bar at the foot of the dialog, beside the actions, which takes
focus and has a success, warning, error or progress tone. AMCP's own refusals read in the interface language with
their next step and request reference; a provider's message stays literal. A finished Sheets export states its rows,
tab, spreadsheet and time and the snapshot's capture time. Choosing a tab for **Export now** does not change the
report's saved destination or mark the setup as changed, so opening another snapshot afterwards asks nothing; leaving
real unsaved setup edits asks in AMCP's own confirmation.

**Tab ownership.** A Sheets tab belongs to the report whose active schedule uses it, or otherwise to the saved
reports that deliver to it. **Export now** to such a tab is refused with `DESTINATION_OWNED_BY_OTHER_REPORT` (409,
naming the owning report and client) unless the snapshot comes from that schedule or saved report, or covers the
same platform accounts. The check runs again when the export job starts. The dialog groups **Tabs for this report**
and **Other reports' tabs (locked)**. `AMCP_SHEETS_DESTINATION_OWNERSHIP=off` restores unrestricted manual exports.

**Delivery policy (Sheets and files).** A complete-only report refuses to export a partial snapshot before any job
is created (`PARTIAL_DELIVERY_BLOCKED`); a scheduled partial run records a skipped delivery and its collection still
completes. Failures that repeat on every retry (for example the delivery policy, tab ownership or a changed
schedule) offer no **Retry** (`retry_available:false`) and `retry` refuses them with `JOB_NOT_RETRYABLE`.

CSV is also available to operators, administrators and owners (viewers only when the owner allows viewer downloads). Download links use the browser's download behavior and bypass the client page router; they do not navigate to Connections. Both formats include selected/custom metrics, recommendations, attribution, currency/timezone and completeness. Every CSV AMCP writes (this export and the workflow report file) uses one formula guard, `src/csv-safety.ts`: a text cell that starts with a tab, carriage return or line feed, or whose first character after any leading whitespace or control characters is `=`, `+`, `-`, `@` or one of their full-width forms, gains a leading apostrophe and opens as literal text. Numbers are not text, so a negative amount stays a number; a name such as `-20% sale` shows the apostrophe.

LinkedIn rows must identify the requested native entity and exact UTC period; see
[LinkedIn reporting](#linkedin-reporting) for levels, result definitions, retention and capped-window subdivision.
A snapshot with successful and failed periods keeps marked partial coverage, and complete-only delivery stays
blocked. New snapshots use `campaign-source-v4`; v3 state remains resumable. Older LinkedIn collection state from
before v3 needs a new snapshot from its saved definition. Retained snapshots are not retroactively requalified.

## Scheduled delivery

Choose daily/weekly/monthly/hourly delivery, an IANA timezone, a rolling/calendar window and destination. Monthly day 29–31 clamps to the last day in shorter months. Calendar windows can select the previous complete Monday–Sunday week or calendar month; recent-day exclusion applies to complete-day windows. Each occurrence collects fresh data and replaces the destination tab. Clock times use the chosen timezone: a time that a daylight-saving change skips runs at the first valid time after it (Cairo weekly Friday 00:30 runs at 01:30 on the change day) and `preview_schedule` marks it `dst_shifted`; a repeated time runs once. A missing following occurrence never pauses the schedule or drops the due run: when no valid local time is found, the schedule stays active with the warning `SCHEDULE_UNRESOLVED` and its clock is checked again after 6 hours. The UI shows next run, pause state, report progress and delivery history, with retry for failed exports.

Every schedule time names its zone: the delivery time zone first (`Mon, Oct 12, 2026, 8:00 AM GMT+3 (Asia/Riyadh)`),
then the viewer's own time when the viewer is elsewhere (owner policy P6). While the schedule form is edited, **Next 3
deliveries** previews the unsaved settings through `preview_schedule` (debounced; no provider request): the delivery
time in its zone, the viewer's time, and the dates collected in the window's zone, with times moved by a
daylight-saving gap labeled. The Schedules page shows the same three-column table and a localized frequency. Hourly
delivery with complete-day windows shows a warning, because each run repeats the same complete days until the next day
ends.

Collection and delivery are separate jobs. When collection finishes, the snapshot is complete (or partial) and its Sheets delivery is queued as its own export job with a delivery-history receipt; a delivery failure never fails, recollects or re-stamps the snapshot (`completed_at` is written once, and a retry of a finished snapshot only completes its delivery, without provider requests). Each schedule records `last_delivery` (state, time, snapshot, error code, Retry availability) and `consecutive_delivery_failures`. A failed or retrying delivery marks the schedule **attention** in Operations and on the Schedules page; a successful delivery clears it. After `AMCP_SCHEDULE_DELIVERY_PAUSE_AFTER` (default 3; 0 disables) consecutive non-retryable delivery failures, such as a revoked Sheets permission, an owned tab or an unavailable destination, the schedule pauses with `SCHEDULE_DELIVERY_FAILED` and an Operations attention item. Only the schedule revision that produced the snapshot is changed; resuming starts a new count. `AMCP_SCHEDULED_SHEETS_DELIVERY=inline` restores writing scheduled Sheets inside the collection job.

**Save report & enable schedule** atomically saves a view and an independent schedule with its account selection, objectives, metrics, formulas and destination. Reopen it from **Report library** or **All scheduled reports → Edit report & schedule**. Saving an existing report updates its same identity and linked schedule instead of making a duplicate. Each report can use a separate spreadsheet or a separate AMCP tab in the same spreadsheet. Only one active schedule can use a destination tab, preventing different account reports from replacing one another. Stable creation keys make destination and schedule retries idempotent. Up to 50 schedules can coexist in a workspace.

**Workbook schedules move here (EXP-04).** A local workbook schedule (results kept in AMCP, never written to its
spreadsheet) can move into this schedule system explicitly: `preview_workbook_move` is a dry run that converts its
saved campaign query and clock into one report and schedule and lists the report tabs bound for the workbook's
spreadsheet; `move_workbook_schedule` (with the preview's `move_version` and `confirmed:true`) creates them and pauses
the local schedule in one transaction; `undo_workbook_move` pauses the new schedule and restores the local one. The
saved query and its revision never change, and the moved schedule then follows every rule above (tab ownership, one
active schedule per tab, delivery receipts and pause after repeated failures). Native provider queries, fixed dates,
ad set or ad levels and settings without an Overview equivalent stay local with their reasons listed
([product workflows](PRODUCT-WORKFLOWS.md)).

## Google Ads account discovery

Sync the Google Ads connection to discover directly accessible accounts and all descendant accounts under each accessible manager. Discovery requests account status, name, currency and timezone without active-only or hidden-account filters; cancelled, suspended and closed accounts remain visible and selectable. Each selected child retains its verified login manager for subsequent API requests, and Connections shows it under its direct manager: each sub-manager's direct clients are read through the root manager (at most 200 sub-manager reads per sync; past that, or when one fails, its clients show the root and the group says the hierarchy is incomplete). A website Google Ads login never inherits the deployment-wide `AMCP_GOOGLE_LOGIN_CUSTOMER_ID`: an account without a recorded manager route is refused with `GOOGLE_LOGIN_CUSTOMER_UNMAPPED` and a re-sync step, and no login-customer header is sent (CON-05). Operator-provisioned logins, which record no routes, keep their own provisioned login customer. This does not reactivate accounts, grant provider permissions or promise that Google permits every operation on an inactive account.

Discovery reads one account list, then one detail lookup per directly accessible account, plus one hierarchy query per accessible manager. It supports up to 100 directly accessible accounts; beyond that it stops with `ASSET_SYNC_LIMIT` and asks you to narrow the login. Those calls are paced by the per-tenant provider budget, so a login with many accounts takes proportionally longer to sync rather than failing partway — roughly 18 seconds at the 100-account limit. See [request pacing](operations/WORKERS.md#provider-request-pacing).

Failures in one hierarchy show an incomplete-sync warning without discarding successful discoveries or existing selections. After a complete sync, accounts no longer visible to the login are removed from AMCP grants as before.

Connection sync failures expose the provider code/message, affected account, request stage/path, login customer ID and request ID in **Connections → Manage** and **Activity → website asset sync**. Only redacted diagnostic fields are saved; provider credentials and raw responses are excluded. A successful accessible-account list with a failed details lookup remains an incomplete sync, not a disconnected OAuth login or a successful empty hierarchy.

**Sync and Reauthorize serve different purposes.** Sync reloads accounts with the saved authorization. In **Connections → Google Ads → Manage**, **Reauthorize** opens Google account selection and consent for the existing connection. The saved OAuth client ID and whether it matches the current server configuration are shown in the manager; client secrets and tokens are never displayed. A failed sync displays an attention message with the provider error code.

Reauthorization performs read-only account discovery with the fresh credentials before replacing the saved authorization. It requires Google Ads permission, offline access and a successful direct account read, with the correct manager route, for every currently selected account. An unrelated denied discovery root does not invalidate those verified selections. A successful reauthorization preserves the connection ID, account selections, existing write grants within deployment policy, and saved report/schedule references. It never selects new accounts or executes an advertising mutation. Cancellation, provider denial, a different login without the selected accounts, ended sessions, concurrent disconnects and stale authorization attempts preserve the current connection. A newer authorization also prevents an older in-flight sync from replacing its asset inventory.

**Every browser-OAuth login renews in place.** Meta, LinkedIn, Microsoft, Reddit, Snapchat, TikTok, X, GA4, Tag Manager, Search Console, DV360, Sheets and Drive logins have the same **Reauthorize** action (Apple Ads uses server credentials and has none). The fresh authorization replaces the saved one only after read-only discovery with the new credentials lists every selected account, asset, property, site, spreadsheet or file, the read permission and (for logins AMCP renews itself) offline access are granted again, and, where the provider states the user (Google's ID token, Meta `/me`, Microsoft's authenticated user, X `user_id`), it is the same user as before (owner decision D19). The connection ID, selections, saved queries, schedules, default flag and write grants stay; write grants are removed, and the removal audited as `website_write_access_changed`, when the renewal no longer carries the provider's write permission or the deployment no longer allows writes. Meta's dialog is asked to re-request declined permissions. `AMCP_REAUTHORIZATION_DISABLED` (platform IDs, or `all`) turns the action off again per platform.

**Connections lists declined Meta permissions.** Each Meta connect, ad-account sync and renewal reads the permissions Meta actually granted. A permission the user declined or that expired is listed under **Declined permissions** with Reauthorize, features that need it stay unavailable, and readiness blocks reviewed writes with a reauthorize step instead of letting Meta refuse at execution. When the read fails, Connections says the grant is not confirmed and readiness treats it as unknown. An X login authorized for read access only says so.

**Logins are named after the provider user (CON-05).** Where the provider states who authorized a login without another permission (Google's ID token from the `openid profile` it already requests, Meta `/me`, Microsoft's authenticated user, X's screen name), AMCP keeps that user's identifier and display name with the login and names it "<Platform> · <name>"; otherwise "<Platform> login". The identifier is never shown. An administrator can rename a login (1 to 80 characters, audited as `website_connection_renamed` without the name); later syncs keep that name. A new login of a user who already has one on that platform is flagged **Same identity as another login**, and the result page offers **Reauthorize existing**. Disconnect removes the identity with the login, together with the account names and readiness checks read through it and its connect progress (`local_changes.account_metadata`, `readiness_records`, `connect_progress`).

**Revoke at the provider on disconnect (CON-05, owner decision D19 (4)), off by default.** Disconnect is local: AMCP deletes its copy of the login and the provider grant stays until it is removed in the provider's settings. When the deployment owner sets `AMCP_PROVIDER_REVOCATION=on`, the disconnect dialog for a Google login (Google Ads, GA4, Tag Manager, Search Console, DV360, Business Profile, Sheets, Drive) also offers **Also revoke AMCP's access at Google**, unchecked, with a warning. Checking it sends `DELETE /api/connections/:id` with `{"revoke_at_provider": true}`: AMCP audits the request (`provider_revocation_requested`), sends the login's refresh token (or access token) once in the form body to `https://oauth2.googleapis.com/revoke` (RFC 7009; never in a URL, the audit or a response), audits the answer (`provider_revocation_result`), and disconnects locally only when Google confirmed it (200) or reported the token already invalid (`token_already_invalid`). Any other answer, a redirect or a lost response is `PROVIDER_REVOCATION_FAILED`, and the login is kept so the administrator can retry or disconnect without revocation; the dialog stays open with the reason, and sends one request at a time. Test accounts are never offered it and are refused before the token is read (`TEST_ACCOUNT_SCOPE`): everyone with the shared reviewer password manages the same logins, so one evaluator could otherwise end another's Google grant. `GET /api/platforms` states for a signed-in session whether it is offered (`provider_revocation.available`, with `reason` `deployment_off`, `test_account` or `provider_not_supported` when it is not). The token is sent only to the endpoint of the provider its stored login belongs to, and the disconnect is fenced on the login revision it was read from: a login reauthorized while Google answers keeps its new token, which was never sent (`CONNECTION_CHANGED`), and the administrator decides again. The receipt records `provider_revocation` with the outcome, `network_requests: 1` and `provider_changes`, and its `effect` says the provider grant was asked to be revoked instead of unchanged. Other providers have no revocation wired (`PROVIDER_REVOCATION_UNAVAILABLE`); the MCP disconnect actions stay local. **Before turning it on**, the owner answers Q25 with disposable logins ([operations](operations/CONFIGURATION.md#configuration)): Google revokes the grant of one OAuth client for a Google account as a whole, and every AMCP Google login uses the deployment's Google client unless its surface names its own, so revoking one login may end the same person's other AMCP Google logins, in any workspace of the deployment.

**Default login and result page.** A login without selected assets cannot be made the default (`CONNECTION_DISABLED`), and a default change audits `previous_default`. When two or more enabled logins of one platform have no default, Connections asks for one. A browser that returns from the provider after its session ended, without administrator rights, with an expired or reused state, or with malformed parameters lands on the localized result page (`/oauth/result?error=<code>&platform=<id>`, fixed codes only, no provider parameter echoed) with **Start again**; API callers keep the JSON refusal. The result page links back to Connections.

**Connections shows recorded login health, never the first token's expiry.** AMCP records each renewal it performs against the login it renewed: a login that renews itself reads "Access renews automatically" (with LinkedIn's stated login lifetime when given); a login that cannot (Meta, TikTok, X, LinkedIn without programmatic refresh) shows its expiry and reads **Expiring soon** within seven days; a token endpoint that rejects the login (`invalid_grant`, `invalid_token`) marks it **Reauthorization required**, Reauthorize becomes the primary action, and later requests fail fast with `REAUTHORIZATION_REQUIRED` without contacting the provider. Other refresh failures pause renewal briefly and retry automatically. **Retry renewal** (administrators) clears a recorded failure so the next request asks the provider again.

An upstream HTTP 403 is classified as `PROVIDER_ACCESS_DENIED` unless Google or the provider explicitly identifies an insufficient OAuth scope. Google's `AUTHORIZATION_ERROR` means generic client authorization failure; it is not proof of a missing scope or insufficient Explorer Access. If fresh authorization still returns this error after confirming the correct Cloud project and Google user, provide Google Ads API support with the request ID, affected account and request path shown in the callback or report diagnostics. Reauthorization does not override provider access restrictions.

Activity shows the latest 100 events for the signed-in workspace, newest first. Failed account syncs and reauthorization attempts include their provider diagnostics, affected account, request path and provider request ID. The chronological audit export and hash chain remain unchanged.

Google [migrated API access to Google Cloud projects on September 9, 2026](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). Check the project that owns AMCP's **Google Ads** OAuth client, not a different project used for Sheets or social sign-in. [Explorer Access supports production account reads and reporting](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), so a generic 403 is not evidence that Basic Access is required. `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` identifies a project-access restriction; older API versions can return the less specific `ACTION_NOT_PERMITTED`. `USER_PERMISSION_DENIED` concerns account identity/access or manager routing. `CUSTOMER_NOT_ENABLED` concerns the account's own status. Reconnecting cannot override Google-side restrictions, and AMCP never reactivates an account during sync.

Keep the HTTP worker enabled (AMCP_RUN_WORKER=true) or run `npm run worker` with the same persistent database and master key. A stopped worker cannot execute schedules. SQLite claims each occurrence once; leases coordinate workers and fence stale/cancelled jobs. Safe transient report/export failures retry with bounded backoff. Completed sources, calendar periods and X analytics batches are checkpointed; unknown ad writes never become new retry submissions.

Schedules recheck the creator's membership, credential and account version. Revocation, reduced roles or deselected sources/destinations stops work. Use Resume after reauthorizing to bind the schedule to your current access. Pausing, editing or deleting a schedule cancels its queued/running report and export jobs and fences in-flight workers. Completed snapshots remain available. A cancelled run from an old schedule definition cannot be retried under new settings; pull a fresh report. An HTTP request already sent to Google can finish after cancellation.

## MCP

`amcp_reporting_overview` exposes the following actions. Website and MCP share the implementation, permission checks
and structured results; use bootstrap and action help for exact identifiers.

<!-- overview-actions:start -->

- Help and discovery: `help`, `bootstrap`.
- Saved reports and snapshots: `save`, `save_template`, `delete_template`, `delete_view`, `delete_report`, `list`,
  `get`, `run`, `cancel`, `retry`.
- Presentation and comparison: `report_pack`, `save_presentation`, `presentation_profiles`,
  `apply_profile_presentation`, `compare`, `compare_candidates`.
- Destinations and delivery: `create_spreadsheet`, `bind_destination`, `bind_file_destination`, `export`,
  `export_status`, `resolve_delivery`.
- Schedules: `preview_schedule`, `schedule`, `update_schedule`, `pause_schedule`, `delete_schedule`,
  `resume_schedule`, `remove_schedule`.
- Workbook migration: `preview_workbook_move`, `move_workbook_schedule`, `undo_workbook_move`.

<!-- overview-actions:end -->

`delete_schedule` retains its legacy **pause** meaning; `remove_schedule` removes a schedule. Use
`amcp_reporting_overview {action:"help"}` for the full description and examples, or add `topic:"<action>"` for that
action's argument schema, defaults, limits, effects and least role. Workflow guides are available through
`amcp_workspace {action:"help",topic:"guides/reporting-overview"}`. Help is local and read-only.

### Page sizes and argument notes

Page sizes are explicit integers. A value above an action's maximum is refused, even when the tool's shared flat
schema allows a larger limit. Offsets are non-negative and start at 0.

<!-- overview-pages:start -->

| Action                  | Minimum limit | Maximum limit | Default limit |
| ----------------------- | ------------- | ------------- | ------------- |
| `list`                  | 1             | 100           | 50            |
| `get`                   | 1             | 500           | 100           |
| `compare_candidates`    | 1             | 100           | 50            |
| `compare`               | 1             | 500           | 100           |
| `presentation_profiles` | 1             | 100           | 30            |

<!-- overview-pages:end -->

Presentation-profile results carry `next_offset`; continue even when an account-access filter leaves a page empty.
`bind_destination.tab_name` is at most 80 characters and defaults to `AMCP Overview`. Arguments not used by an action
are reported under `meta.argument_warnings` by default. With `MIRROR_FLAGS {"actionArguments":"enforce"}`, they are
refused with `INVALID_ARGUMENT`. Action help names the accepted arguments; missing required inputs and invalid
values still receive the handler's specific refusal.

Finished snapshots also support `report_pack`, `save_presentation`, `presentation_profiles` and
`apply_profile_presentation`. Report packs offer HTML, PDF and Excel. Approved client profiles can retain a brand
name, accent color, footer and PDF spacing. Applying requires the exact profile and presentation revisions,
confirmation, operator authority and current access to every source. Nonempty profile account/login bindings must
cover all sources. The style is copied into that snapshot, so changing or deleting the reusable profile never
rewrites old report packs. Profile-choice pages return `next_offset`; continue even after an empty filtered page.
See [report-pack contracts and limits](workflows/REPORT-PACKS.md#client-report-packs-and-recovery).

### Scheduled PDF and Excel files

In **Report destinations & schedules**, create a PDF / Excel destination, explicitly choose its formats and branding,
and confirm local storage. No Google Sheets login is needed. Select this destination when delivering a retained
snapshot or saving an independent schedule. The existing calendar/window preview and partial-data policy apply.
Complete-only partial snapshots and empty snapshots do not generate files. Overview schedule edits, pause and
deletion cancel pending deliveries; completed files stay attached to their original snapshot.

MCP uses `bind_file_destination` with `confirmed:true`, a stable `idempotency_key`, and
`file_destination:{name,formats:["pdf","xlsx"],presentation:{brand_name,accent_color,footer,template}}`.
Choose at least one format; `presentation` is optional. Pass its `destination_id` to the existing `export` or
`schedule` flow. There are no arbitrary paths, external folders or recipients. An operator can create at most 100
destinations. Each keeps its saved settings; create a new destination to use different formats or branding.

Collection produces a retained snapshot, then a separate file job. The job freezes the source fingerprint and style,
so a later presentation edit does not rewrite its files. `export_status` and delivery history expose format, size,
SHA-256 and authenticated download paths. A failed second format preserves the first file. Explicit `retry` uses
the original job and generates only missing formats, without recollecting sources. Renderer contention retries with
bounded worker backoff; other failures remain visible for inspection. The reporting queue remains limited to 100
active jobs. If full, the collected snapshot is retained and delivery can be retried when capacity is available.

Files are encrypted using the workspace's existing master-key infrastructure and stored in its database. Each
file is at most 20 MiB; total encrypted file storage is at most 256 MiB per workspace. The existing report-pack
row/cell/render bounds also apply. Set report retention or delete old snapshots to release space. Deleting or
expiring a snapshot removes its stored files. Backups therefore include this encrypted file data. Every download
requires a current authenticated session, an operator role or higher (a viewer only when the workspace owner allows
viewer downloads; see [roles](USER-ACCOUNTS.md#mfa-memberships-and-revocation)) and current access to all source
accounts, verifies the retained bytes, and returns a `no-store` attachment. Saved file links are not public share links. Delivery never emails or uploads
files to an external service.

## Acceptance

Tests cover mappings, formulas, missing data, recommendations, pagination, date windows, schedules, permissions, Sheets ownership/typed cells/idempotency and lost create responses. Browser QA uses synthetic reports. Configure real credentials, reconcile a fixed period with each provider, and verify a real export plus scheduled delivery before relying on production results: the [Sheets delivery acceptance](acceptance/SHEETS-DELIVERY.md) runbook (ACC-03) does that on a disposable AMCP-created spreadsheet and records it in the acceptance ledger.

References: [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate), [Drive creation](https://developers.google.com/workspace/drive/api/guides/create-file), [X analytics](https://docs.x.com/x-ads-api/analytics), [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), [GA4 schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema), [Microsoft report columns](https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportcolumn?view=bingads-13), [Reddit reporting](https://ads-api.reddit.com/docs/v3/api/get-a-report).

## Report contract revision 2026-09-12

New snapshots freeze the source and formula versions, custom formula fingerprint, query fingerprints and measurement-quality metadata. GA4 sampled, thresholded, aggregated or restricted results are visibly limited; restricted metrics and their formulas stay unknown. Apple v1 uses official `metadata` and `totalMetrics` fields, including tap-plus-view total installs. Native metric definitions and attribution remain provider specific.

CSV and Sheets use the same typed table. New trailing columns carry report ID/state, all selected-source statuses (on the first data row), compact per-row quality, formula/query fingerprints and the recommendation basis. Existing metric columns keep their positions. Full authenticated evidence is downloadable at `/api/reporting-overview/<report-id>.metadata.json`, including source failures; it excludes worker authority and private checkpoints. Consumers must not assume appended columns imply compatible mixed-currency totals. Legacy snapshots remain unversioned/unknown rather than being silently recalculated.

The Sheets delivery policy can allow clearly marked partial reports or require complete reports. Complete-only deliveries fail visibly and leave the destination unchanged. Empty reports still leave existing tabs unchanged. Independent schedules and destination ownership retain their original behavior. Recommendations now accept explicit seasonal/recent-change/tracking, secondary-KPI and business-budget/capacity context, explain conflicting evidence and hold when those gates fail. These are observational recommendations, not causal predictions or automatic budget changes.

## LinkedIn native field selectors

Native LinkedIn `fields` strings preserve separator commas and documented child/map selector
punctuation. Other scalar values and account/date List/record parameters retain their existing
encoding and ownership checks. A selector cannot add a sibling query filter. Native unknown-field
failures remain explicit; a failed projected read never falls back to default metrics. A single
cost-only response without identity/date fields is insufficient for a complete saved report.
See [the reproduced defect, safe wire correction and read-only acceptance](records/DELIVERY-2026-10-06-LINKEDIN-FIELD-PROJECTIONS.md).
