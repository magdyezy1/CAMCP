# Reporting Overview

Finished snapshots also provide branded PDF and Excel downloads through client report packs. Generation is
authenticated, bounded and rechecks every source account after rendering. See the
[report-pack workflow](PRODUCT-WORKFLOWS.md#client-report-packs-and-recovery) and
[format limits and evidence](review/DELIVERY-2026-10-01-CREATIVE-REPORTS.md).

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
  (`WRITES_PAUSED`), and recorded as a `provider_job` receipt in the source's checkpoint. A resumed snapshot polls the
  original `ReportRequestId`; when the earlier submission's answer was lost, it is never submitted again
  (`PROVIDER_JOB_UNCERTAIN`; run a new snapshot). Only a definitive refusal that created nothing (such as error 2004)
  may be submitted again. Reviewed report and export jobs of the other providers follow the deployment owner's
  `AMCP_PROVIDER_JOBS` switch and an account's report-job grant (see
  [write operations](WRITE-OPERATIONS.md#provider-report-and-export-jobs)). An administrator grants report jobs in
  Connections: `PROVIDER_JOBS_DISABLED` while the switch is off, `WRITE_ACCOUNT_NOT_SELECTED` for an account the login
  does not select; an invalid `AMCP_PROVIDER_JOB_HOURLY_LIMIT` refuses jobs with `CONFIGURATION_INVALID`.
- **Declared incomplete.** A detailed (ad set or ad) source with `complete_window:false` is partial
  (`detail_contract:"overview-detail-v2"`) and its recommendations need review. Snapshots retained earlier keep their
  original labels.
- **Meta omitted actions (RPT-04, owner policy P6).** Meta leaves zero-valued actions out of `actions` and
  `action_values`. On a delivered row (impressions above 0) from a complete page, an absent requested action counts
  as 0 and is named in the row's `omitted_as_zero` (and in its quality, so CSV and Sheets carry it); a row without
  delivery keeps it unknown. Summaries add these zeros and count them per metric (`summary[].omitted_as_zero`);
  guided Meta captures mark the metric's coverage `omitted_as_zero`. The website marks each such cell with `*` and a
  legend, and the zero-result advice names `results_basis:"provider_omitted"`.
- **TikTok optimization events (RPT-04).** TikTok's `conversion` follows each ad group's optimization event. The
  campaign source reads the ad group list once (`GET /v1.3/adgroup/get/`, bounded like the campaign list) and gives
  each row a result definition that names its events, so summaries never add conversions of different events. A
  campaign whose ad groups use different events is held as `needs_review` for cost-per-result advice. Campaign
  reporting covers `AUCTION_CAMPAIGN` data only, and a source warning says so.
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

Rolling windows resolve once in their IANA timezone. Add `"source_timezone":"account"` to the `date_range` to resolve
the same frozen instant in each source's own reporting time zone instead (one extra bounded account read per source
whose zone is not fixed); rows and `sources[].date_range` then carry each source's dates, and
`sources[].window_resolution` records the zone used. `preview_schedule` lists, per occurrence and source, the zone
(`provider_fixed`, `last_observed` from retained snapshots, or `unknown`), its window, `window_closes_at` and
`open_at_delivery`, without a provider request.

## Snapshot state in the website (RPT-05)

- **Partial strip.** A partial snapshot opens with a strip that names each failed source with its error code ("1 of 2
  sources failed: TikTok · 200 `REPORT_PERIODS_FAILED`. Totals exclude them.") and each limited-coverage source, with
  links to their source cards. Summary cards end with **Excludes: …** for failed sources, and a card whose source has
  limited coverage says its totals may be incomplete. A failed source reads **No quality metadata — source failed**;
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
  URL carries no names or account identifiers. Deleting the open snapshot removes it from the address.
- **Whole-window tiles.** A daily, weekly or monthly snapshot also stores `window_summary`: one entry per platform,
  account, currency, timezone, objective and measurement definition, keyed without dates, with additive totals over
  every period (reach and frequency are never summed), ratios recomputed from those totals, `period_count`,
  `entity_count`, decisions counted once per entity and a `series` of spend per period (oldest first). `get` returns
  it; `list` pages leave it out. The website shows one tile per account with a spend sparkline (an image with a text
  summary; an unknown period leaves a gap) instead of one card per period. Older grouped snapshots keep their
  per-period cards.
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

Terminal provider input/access errors (for example 400, 401, 403 or 422) retain
their original diagnostics; they do not trip a transient-failure circuit. Repeated
network/server failures can still open a circuit for the affected connection,
account and origin. One request probes recovery after cooldown. Another account's
valid access is not blocked by that circuit.

HTTP 429 observes X's account/user reset headers; 503 observes Retry-After.
Cooldowns coordinate through SQLite, and workers wait instead of immediately
repeating the call. Completed X analytics batches are checkpointed and are not
counted twice on resume. Null native metric values mean no reported activity;
absent metric columns remain unavailable. Native errors inside HTTP 200 are failures.
No advertising mutation gains permission or automatic retry from these changes.

**Active entities (RPT-03).** X's analytics guide says the Active Entities endpoint should decide which analytics are
requested. The Overview reads `GET /12/stats/accounts/:id/active_entities` (entity `CAMPAIGN`, whole hours, at most 90
days per read). The campaign list, including deleted campaigns, is kept only for names and objectives.

- Analytics are requested only for active campaigns, per placement (as X reports it) and only for the 7-day chunks
  that overlap each activity window.
- The 100-request ceiling is counted from that plan. A larger active set is refused with `REPORT_RANGE_LIMIT` and
  `details.planned_requests`.
- Campaigns with no reported activity are counted (`no_activity_count`) and named in a warning; they are never zero
  rows.
- `WEB_CONVERSION` and `MOBILE_CONVERSION` each have their own request, so a rejected conversion request keeps the
  placement's spend and marks coverage partial.
- A malformed, paginated or invalid active-entities response fails the source. If X refuses the read (400, 404 or
  422), the bounded inventory path runs instead, with a warning.
- The X checkpoint definition (version 3) includes the active-entities response hash, so a resumed run with another
  active set or an older checkpoint is refused with `REPORT_DEFINITION_CHANGED`.
- `AMCP_X_ACTIVE_ENTITIES=campaigns` keeps the active IDs but requests the whole window (widening for late conversion
  updates). `off` restores the inventory path.

The current X endpoint parameter reference lists ALL_ON_TWITTER, SPOTLIGHT and
TREND; some historical examples on the same page still mention PUBLISHER_NETWORK.
The adapter follows the current parameter enum. Official references checked
2026-09-24: [analytics](https://docs.x.com/x-ads-api/analytics) and
[rate limiting](https://docs.x.com/x-ads-api/fundamentals/rate-limiting).

## Provider error layers and throttles

A provider refusal is classified from the provider's documented codes before its
HTTP status (`src/provider-error-taxonomy.ts`). Each error carries `details.layer`
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
retryable. Unknown codes, including every TikTok in-body code until TikTok's official
code table is verified, keep their previous code with layer `unknown`. Overview runs
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
{"action":"save","confirmed":true,"config":{"name":"Monthly awareness","client_name":"Client A","sources":[{"platform":"meta","connection_id":"selected-login","account_id":"123"}],"grain":"daily","date_range":{"preset":"last_complete_month","timezone":"Asia/Riyadh"},"metrics":["spend","impressions","clicks","cpc"]}}
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

`source_defaults` optionally stores account-free per-platform `objective` and
`native_metrics`; unsupported fields or embedded account identities are rejected.
Schedules keep their original identity, destination ownership and actor checks.

## Dates and empty reports

For a historical month, select **Custom dates → Set a full month**. The date summary spells out the month and year before collection; for example, January 2025 means `2025-01-01` through `2025-01-31`. Report links can prefill explicit `since` and `until` dates without running a request or selecting an account. Account choices show synced account names separately from the connected login.

An empty provider result is labeled **No data**, while rows removed by objective filters are labeled **Filtered out**. Source and displayed row counts are retained separately. CSV and manual Sheets exports reject reports with no rows. An empty scheduled run records a skipped export and leaves the previous destination sheet unchanged. Failed or unfinished reports cannot download CSV attachments.

Meta Insights must return an explicit `data` array. Missing or malformed collections fail visibly instead of becoming empty successes. Requested account/date fields are preserved, and rows for a different account or outside the requested date interval are rejected. Attribution settings and the selected date range are never changed automatically to obtain data.

## Troubleshooting source failures

Failed sources expand automatically and show the provider error code/message, account, failed request stage, request ID and a suggested next step. Use **Copy error details** to share the sanitized diagnostic. The Activity page also shows provider diagnostics from earlier failed reads, without needing another provider request. A failed source is never reported as zero performance; successful sources in a mixed report remain explicitly partial.

For Google HTTP 403, distinguish `USER_PERMISSION_DENIED` (identity/account access or manager routing) from developer-token/project restrictions such as `DEVELOPER_TOKEN_NOT_APPROVED` or `DEVELOPER_TOKEN_PROHIBITED`. With direct customer access, an unrelated `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` should be omitted; manager access needs the correct manager ID. Website logins use the manager route their sync recorded, not this variable (CON-05). After changing server OAuth settings, reconnect Google Ads because existing connections retain their saved credentials/settings. The report displays the login customer ID actually sent. AMCP does not bypass a provider denial or automatically change routing. See [Google's error guide](https://developers.google.com/google-ads/api/docs/get-started/common-errors) and [Google's access model](https://developers.google.com/google-ads/api/docs/oauth/access-model).

Open **Reporting overview** in workspace navigation (/reporting-overview). Select multiple platforms/accounts, a date range, objectives and metrics. Save a report setup or pull a new snapshot. Durable jobs freeze account selection and dates for each run.

## Metrics and decisions

- Common metrics include spend, impressions, clicks/taps/swipes, primary conversions, revenue, reach, video views, CTR, CPC, CPM, CPA and ROAS where available. Missing data stays blank, not zero.
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

## Coverage

| Source | Reporting behavior |
|---|---|
| Google Ads | Campaign GAQL and account metadata; micros converted to currency |
| Meta | Campaign Insights with account attribution (or an explicit attribution profile) and objective-specific result aliases |
| TikTok | Integrated campaign report plus objective inventory |
| Snapchat | Campaign totals/inventory and account-local day boundaries |
| LinkedIn | Campaign adAnalytics with verified account currency, native UTC period/completion checks and explicit unknown conversion attribution; objective override when omitted |
| X Ads | Active-entities request planning; current documented placements ALL_ON_TWITTER, SPOTLIGHT and TREND; separate web and mobile conversion requests; resumable hourly batches and explicit partial-coverage flags |
| Microsoft Ads | Durable Submit/Poll campaign report in the account time zone and secure server-side CSV download |
| Apple Ads | Campaign report with explicit UTC range |
| Reddit Ads | Campaign metrics/inventory, spend micro-units and explicit native conversion definitions |
| GA4 | Campaign-attributed analytics context, property currency/timezone and threshold signals |
| Search Console | Organic page context with limited top-row coverage; no paid-budget advice |

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
Cell values stay the typed numbers and text. A trailing **Recommendation basis**
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

LinkedIn source rows must identify one native campaign and cover exactly the requested UTC period. Empty responses
are ambiguous between no activity and missing reporting access, so an empty calendar period is a source error,
not a zero-performance day. Continuation metadata, provider ceilings and duplicate or wrong-period rows are refused.
Older requests may be rounded by LinkedIn; use whole calendar months or recent dates when actual dates differ.
Conversion-rule windows are not independently read, so attribution remains `unknown` and recommendations remain
held. A snapshot with successful and failed periods retains marked partial coverage; complete-only delivery stays
blocked. New snapshots use `campaign-source-v4` (v3 LinkedIn state stays resumable). Older LinkedIn runs with
collection state from before v3 require a new snapshot
from their saved definition, leaving retained counters/checkpoints intact. Untouched queued runs adopt the new
version before collection. Completed historical snapshots are not rewritten or retroactively requalified.

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

Discovery reads one account list, then one detail lookup per directly accessible account, plus one hierarchy query per accessible manager. It supports up to 100 directly accessible accounts; beyond that it stops with `ASSET_SYNC_LIMIT` and asks you to narrow the login. Those calls are paced by the per-tenant provider budget, so a login with many accounts takes proportionally longer to sync rather than failing partway — roughly 18 seconds at the 100-account limit. See [request pacing](OPERATIONS.md#provider-request-pacing).

Failures in one hierarchy show an incomplete-sync warning without discarding successful discoveries or existing selections. After a complete sync, accounts no longer visible to the login are removed from AMCP grants as before.

Connection sync failures expose the provider code/message, affected account, request stage/path, login customer ID and request ID in **Connections → Manage** and **Activity → website asset sync**. Only redacted diagnostic fields are saved; provider credentials and raw responses are excluded. A successful accessible-account list with a failed details lookup remains an incomplete sync, not a disconnected OAuth login or a successful empty hierarchy.

**Sync and Reauthorize serve different purposes.** Sync reloads accounts with the saved authorization. In **Connections → Google Ads → Manage**, **Reauthorize** opens Google account selection and consent for the existing connection. The saved OAuth client ID and whether it matches the current server configuration are shown in the manager; client secrets and tokens are never displayed. A failed sync displays an attention message with the provider error code.

Reauthorization performs read-only account discovery with the fresh credentials before replacing the saved authorization. It requires Google Ads permission, offline access and a successful direct account read, with the correct manager route, for every currently selected account. An unrelated denied discovery root does not invalidate those verified selections. A successful reauthorization preserves the connection ID, account selections, existing write grants within deployment policy, and saved report/schedule references. It never selects new accounts or executes an advertising mutation. Cancellation, provider denial, a different login without the selected accounts, ended sessions, concurrent disconnects and stale authorization attempts preserve the current connection. A newer authorization also prevents an older in-flight sync from replacing its asset inventory.

**Every browser-OAuth login renews in place.** Meta, LinkedIn, Microsoft, Reddit, Snapchat, TikTok, X, GA4, Tag Manager, Search Console, DV360, Sheets and Drive logins have the same **Reauthorize** action (Apple Ads uses server credentials and has none). The fresh authorization replaces the saved one only after read-only discovery with the new credentials lists every selected account, asset, property, site, spreadsheet or file, the read permission and (for logins AMCP renews itself) offline access are granted again, and, where the provider states the user (Google's ID token, Meta `/me`, Microsoft's authenticated user, X `user_id`), it is the same user as before (owner decision D19). The connection ID, selections, saved queries, schedules, default flag and write grants stay; write grants are removed, and the removal audited as `website_write_access_changed`, when the renewal no longer carries the provider's write permission or the deployment no longer allows writes. Meta's dialog is asked to re-request declined permissions. `AMCP_REAUTHORIZATION_DISABLED` (platform IDs, or `all`) turns the action off again per platform.

**Connections lists declined Meta permissions.** Each Meta connect, ad-account sync and renewal reads the permissions Meta actually granted. A permission the user declined or that expired is listed under **Declined permissions** with Reauthorize, features that need it stay unavailable, and readiness blocks reviewed writes with a reauthorize step instead of letting Meta refuse at execution. When the read fails, Connections says the grant is not confirmed and readiness treats it as unknown. An X login authorized for read access only says so.

**Logins are named after the provider user (CON-05).** Where the provider states who authorized a login without another permission (Google's ID token from the `openid profile` it already requests, Meta `/me`, Microsoft's authenticated user, X's screen name), AMCP keeps that user's identifier and display name with the login and names it "<Platform> · <name>"; otherwise "<Platform> login". The identifier is never shown. An administrator can rename a login (1 to 80 characters, audited as `website_connection_renamed` without the name); later syncs keep that name. A new login of a user who already has one on that platform is flagged **Same identity as another login**, and the result page offers **Reauthorize existing**. Disconnect removes the identity with the login, together with the account names and readiness checks read through it and its connect progress (`local_changes.account_metadata`, `readiness_records`, `connect_progress`).

**Revoke at the provider on disconnect (CON-05, owner decision D19 (4)), off by default.** Disconnect is local: AMCP deletes its copy of the login and the provider grant stays until it is removed in the provider's settings. When the deployment owner sets `AMCP_PROVIDER_REVOCATION=on`, the disconnect dialog for a Google login (Google Ads, GA4, Tag Manager, Search Console, DV360, Business Profile, Sheets, Drive) also offers **Also revoke AMCP's access at Google**, unchecked, with a warning. Checking it sends `DELETE /api/connections/:id` with `{"revoke_at_provider": true}`: AMCP audits the request (`provider_revocation_requested`), sends the login's refresh token (or access token) once in the form body to `https://oauth2.googleapis.com/revoke` (RFC 7009; never in a URL, the audit or a response), audits the answer (`provider_revocation_result`), and disconnects locally only when Google confirmed it (200) or reported the token already invalid (`token_already_invalid`). Any other answer, a redirect or a lost response is `PROVIDER_REVOCATION_FAILED`, and the login is kept so the administrator can retry or disconnect without revocation; the dialog stays open with the reason, and sends one request at a time. Test accounts are never offered it and are refused before the token is read (`TEST_ACCOUNT_SCOPE`): everyone with the shared reviewer password manages the same logins, so one evaluator could otherwise end another's Google grant. `GET /api/platforms` states for a signed-in session whether it is offered (`provider_revocation.available`, with `reason` `deployment_off`, `test_account` or `provider_not_supported` when it is not). The token is sent only to the endpoint of the provider its stored login belongs to, and the disconnect is fenced on the login revision it was read from: a login reauthorized while Google answers keeps its new token, which was never sent (`CONNECTION_CHANGED`), and the administrator decides again. The receipt records `provider_revocation` with the outcome, `network_requests: 1` and `provider_changes`, and its `effect` says the provider grant was asked to be revoked instead of unchanged. Other providers have no revocation wired (`PROVIDER_REVOCATION_UNAVAILABLE`); the MCP disconnect actions stay local. **Before turning it on**, the owner answers Q25 with disposable logins ([operations](OPERATIONS.md#configuration)): Google revokes the grant of one OAuth client for a Google account as a whole, and every AMCP Google login uses the deployment's Google client unless its surface names its own, so revoking one login may end the same person's other AMCP Google logins, in any workspace of the deployment.

**Default login and result page.** A login without selected assets cannot be made the default (`CONNECTION_DISABLED`), and a default change audits `previous_default`. When two or more enabled logins of one platform have no default, Connections asks for one. A browser that returns from the provider after its session ended, without administrator rights, with an expired or reused state, or with malformed parameters lands on the localized result page (`/oauth/result?error=<code>&platform=<id>`, fixed codes only, no provider parameter echoed) with **Start again**; API callers keep the JSON refusal. The result page links back to Connections.

**Connections shows recorded login health, never the first token's expiry.** AMCP records each renewal it performs against the login it renewed: a login that renews itself reads "Access renews automatically" (with LinkedIn's stated login lifetime when given); a login that cannot (Meta, TikTok, X, LinkedIn without programmatic refresh) shows its expiry and reads **Expiring soon** within seven days; a token endpoint that rejects the login (`invalid_grant`, `invalid_token`) marks it **Reauthorization required**, Reauthorize becomes the primary action, and later requests fail fast with `REAUTHORIZATION_REQUIRED` without contacting the provider. Other refresh failures pause renewal briefly and retry automatically. **Retry renewal** (administrators) clears a recorded failure so the next request asks the provider again.

An upstream HTTP 403 is classified as `PROVIDER_ACCESS_DENIED` unless Google or the provider explicitly identifies an insufficient OAuth scope. Google's `AUTHORIZATION_ERROR` means generic client authorization failure; it is not proof of a missing scope or insufficient Explorer Access. If fresh authorization still returns this error after confirming the correct Cloud project and Google user, provide Google Ads API support with the request ID, affected account and request path shown in the callback or report diagnostics. Reauthorization does not override provider access restrictions.

Activity shows the latest 100 events for the signed-in workspace, newest first. Failed account syncs and reauthorization attempts include their provider diagnostics, affected account, request path and provider request ID. The chronological audit export and hash chain remain unchanged.

Google [migrated API access to Google Cloud projects on September 9, 2026](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). Check the project that owns AMCP's **Google Ads** OAuth client, not a different project used for Sheets or social sign-in. [Explorer Access supports production account reads and reporting](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), so a generic 403 is not evidence that Basic Access is required. `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` identifies a project-access restriction; older API versions can return the less specific `ACTION_NOT_PERMITTED`. `USER_PERMISSION_DENIED` concerns account identity/access or manager routing. `CUSTOMER_NOT_ENABLED` concerns the account's own status. Reconnecting cannot override Google-side restrictions, and AMCP never reactivates an account during sync.

Keep the HTTP worker enabled (AMCP_RUN_WORKER=true) or run `npm run worker` with the same persistent database and master key. A stopped worker cannot execute schedules. SQLite claims each occurrence once; leases coordinate workers and fence stale/cancelled jobs. Safe transient report/export failures retry with bounded backoff. Completed sources, calendar periods and X analytics batches are checkpointed; unknown ad writes never become new retry submissions.

Schedules recheck the creator's membership, credential and account version. Revocation, reduced roles or deselected sources/destinations stops work. Use Resume after reauthorizing to bind the schedule to your current access. Pausing, editing or deleting a schedule cancels its queued/running report and export jobs and fences in-flight workers. Completed snapshots remain available. A cancelled run from an old schedule definition cannot be retried under new settings; pull a fresh report. An HTTP request already sent to Google can finish after cancellation.

## MCP

`amcp_reporting_overview` exposes bootstrap, save, save_template, delete_view, delete_template, delete_report, run, get, list, create_spreadsheet, bind_destination, export, export_status, resolve_delivery, schedule, update_schedule, pause_schedule, remove_schedule, resume_schedule, retry and cancel. `delete_schedule` is retained as the legacy **pause** alias. Use the schema/bootstrap for exact identifiers. Website and MCP share the implementation, permission checks and structured results.

Finished snapshots also support `report_pack`, `save_presentation`, `presentation_profiles` and
`apply_profile_presentation`. Report packs offer HTML, PDF and Excel. Approved client profiles can retain a brand
name, accent color, footer and PDF spacing. Applying requires the exact profile and presentation revisions,
confirmation, operator authority and current access to every source. Nonempty profile account/login bindings must
cover all sources. The style is copied into that snapshot, so changing or deleting the reusable profile never
rewrites old report packs. Profile-choice pages return `next_offset`; continue even after an empty filtered page.
See [report-pack contracts and limits](PRODUCT-WORKFLOWS.md#client-report-packs-and-recovery).

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

Tests cover mappings, formulas, missing data, recommendations, pagination, date windows, schedules, permissions, Sheets ownership/typed cells/idempotency and lost create responses. Browser QA uses synthetic reports. Configure real credentials, reconcile a fixed period with each provider, and verify a real export plus scheduled delivery before relying on production results.

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
See [the reproduced defect, safe wire correction and read-only acceptance](review/DELIVERY-2026-10-06-LINKEDIN-FIELD-PROJECTIONS.md).
