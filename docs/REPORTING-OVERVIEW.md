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
calendar choices, per-platform native metric defaults and objective-level targets.
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

The current X endpoint parameter reference lists ALL_ON_TWITTER, SPOTLIGHT and
TREND; some historical examples on the same page still mention PUBLISHER_NETWORK.
The adapter follows the current parameter enum. Official references checked
2026-09-24: [analytics](https://docs.x.com/x-ads-api/analytics) and
[rate limiting](https://docs.x.com/x-ads-api/fundamentals/rate-limiting).

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

For Google HTTP 403, distinguish `USER_PERMISSION_DENIED` (identity/account access or manager routing) from developer-token/project restrictions such as `DEVELOPER_TOKEN_NOT_APPROVED` or `DEVELOPER_TOKEN_PROHIBITED`. With direct customer access, an unrelated `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` should be omitted; manager access needs the correct manager ID. After changing server OAuth settings, reconnect Google Ads because existing connections retain their saved credentials/settings. The report displays the login customer ID actually sent. AMCP does not bypass a provider denial or automatically change routing. See [Google's error guide](https://developers.google.com/google-ads/api/docs/get-started/common-errors) and [Google's access model](https://developers.google.com/google-ads/api/docs/oauth/access-model).

Open **Reporting overview** in workspace navigation (/reporting-overview). Select multiple platforms/accounts, a date range, objectives and metrics. Save a report setup or pull a new snapshot. Durable jobs freeze account selection and dates for each run.

## Metrics and decisions

- Common metrics include spend, impressions, clicks/taps/swipes, primary conversions, revenue, reach, video views, CTR, CPC, CPM, CPA and ROAS where available. Missing data stays blank, not zero.
- **Additional native metrics** accepts supported provider field identifiers, with examples per platform. Returned native fields retain a platform prefix and become selectable and usable in formulas. Incompatible metric/breakdown combinations return a source error.
- Custom formulas support named identifiers, arithmetic and parentheses: `conversion_value - spend`, `spend / leads`, or `(conversion_value - spend) / spend * 100`. Choose number, percentage or currency formatting. A bounded parser rejects cycles, unknown fields and unsafe identifiers without evaluating JavaScript. Missing operands or division by zero yield unavailable values.
- Set per-objective KPI targets, direction (higher/lower is better), minimum sample and conversion lag. Monetary targets require a currency. Rolling windows can skip recent days for conversion maturity.
- **Scale**, **hold**, **pull back** and **reconsider/pause** are advisory. Each includes its reason and evidence. Missing objective/result definitions, immature or incomplete data, insufficient volume and ambiguous currency hold the recommendation. Nothing automatically changes campaign status or budget.
- Summary cards keep platform, account, currency, timezone, attribution and objective groups separate. Ratios use additive components; reach/frequency/users are not blindly summed. AMCP does not deduplicate cross-platform conversions or invent a global currency total.

## Coverage

| Source | Reporting behavior |
|---|---|
| Google Ads | Campaign GAQL and account metadata; micros converted to currency |
| Meta | Campaign Insights with account attribution and objective-specific result aliases |
| TikTok | Integrated campaign report plus objective inventory |
| Snapchat | Campaign totals/inventory and account-local day boundaries |
| LinkedIn | Campaign adAnalytics; objective override when the API omits it |
| X Ads | Current documented placements ALL_ON_TWITTER, SPOTLIGHT and TREND, separate mobile conversions, resumable hourly batches and explicit partial-coverage flags |
| Microsoft Ads | Durable Submit/Poll campaign report and secure server-side CSV download |
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

AMCP marks its own destination tab and replaces its report cells; other tabs remain intact. Typed cells prevent text from becoming executable formulas. Exports are limited to 200,000 cells and an 8 MiB request. Split larger reports or reduce metrics. A new report replaces the same cells. A confirmed report replay returns its historical receipt without another write; it does not certify that collaborators have left those cells unchanged.

If delivery loses its response, retry the original export job. AMCP checks the
original delivery marker in the destination and records success if that batch
was applied. An unconfirmed outcome stays visible and does not cause another
write. `SHEETS_DELIVERY_UNRESOLVED` identifies the earlier report that needs this
reconciliation before a newer report can use the same destination tab. Other
destinations can continue independently. Preserve the original report and job;
changing its numbers under the same report ID causes `IDEMPOTENCY_CONFLICT`.

Account/source access, the selected Sheets login, destination and worker lock
are checked before delivery. Reconnect or restore explicitly approved access
before retrying a permission failure. A write already accepted by Google keeps
its durable receipt even when access is withdrawn during the response.
Interrupted file creation is reconciled by the app's creation marker; unknown
results never trigger blind duplicate creation.

CSV is also available. Download links use the browser's download behavior and bypass the client page router; they do not navigate to Connections. Both formats include selected/custom metrics, recommendations, attribution, currency/timezone and completeness.

## Scheduled delivery

Choose daily/weekly/monthly/hourly delivery, an IANA timezone, a rolling/calendar window and destination. Monthly day 29–31 clamps to the last day in shorter months. Calendar windows can select the previous complete Monday–Sunday week or calendar month; recent-day exclusion applies to complete-day windows. Each occurrence collects fresh data and replaces the destination tab. DST is handled in the chosen timezone. The UI shows next run, pause state, report progress and delivery history, with retry for failed exports.

**Save report & enable schedule** atomically saves a view and an independent schedule with its account selection, objectives, metrics, formulas and destination. Reopen it from **Report library** or **All scheduled reports → Edit report & schedule**. Saving an existing report updates its same identity and linked schedule instead of making a duplicate. Each report can use a separate spreadsheet or a separate AMCP tab in the same spreadsheet. Only one active schedule can use a destination tab, preventing different account reports from replacing one another. Stable creation keys make destination and schedule retries idempotent. Up to 50 schedules can coexist in a workspace.

## Google Ads account discovery

Sync the Google Ads connection to discover directly accessible accounts and all descendant accounts under each accessible manager. Discovery requests account status, name, currency and timezone without active-only or hidden-account filters; cancelled, suspended and closed accounts remain visible and selectable. Each selected child retains its verified login manager for subsequent API requests. This does not reactivate accounts, grant provider permissions or promise that Google permits every operation on an inactive account.

Discovery reads one account list, then one detail lookup per directly accessible account, plus one hierarchy query per accessible manager. It supports up to 100 directly accessible accounts; beyond that it stops with `ASSET_SYNC_LIMIT` and asks you to narrow the login. Those calls are paced by the per-tenant provider budget, so a login with many accounts takes proportionally longer to sync rather than failing partway — roughly 18 seconds at the 100-account limit. See [request pacing](OPERATIONS.md#provider-request-pacing).

Failures in one hierarchy show an incomplete-sync warning without discarding successful discoveries or existing selections. After a complete sync, accounts no longer visible to the login are removed from AMCP grants as before.

Connection sync failures expose the provider code/message, affected account, request stage/path, login customer ID and request ID in **Connections → Manage** and **Activity → website asset sync**. Only redacted diagnostic fields are saved; provider credentials and raw responses are excluded. A successful accessible-account list with a failed details lookup remains an incomplete sync, not a disconnected OAuth login or a successful empty hierarchy.

**Sync and Reauthorize serve different purposes.** Sync reloads accounts with the saved authorization. In **Connections → Google Ads → Manage**, **Reauthorize** opens Google account selection and consent for the existing connection. The saved OAuth client ID and whether it matches the current server configuration are shown in the manager; client secrets and tokens are never displayed. A failed sync displays an attention message with the provider error code.

Reauthorization performs read-only account discovery with the fresh credentials before replacing the saved authorization. It requires Google Ads permission, offline access and a successful direct account read, with the correct manager route, for every currently selected account. An unrelated denied discovery root does not invalidate those verified selections. A successful reauthorization preserves the connection ID, account selections, existing write grants within deployment policy, and saved report/schedule references. It never selects new accounts or executes an advertising mutation. Cancellation, provider denial, a different login without the selected accounts, ended sessions, concurrent disconnects and stale authorization attempts preserve the current connection. A newer authorization also prevents an older in-flight sync from replacing its asset inventory.

An upstream HTTP 403 is classified as `PROVIDER_ACCESS_DENIED` unless Google or the provider explicitly identifies an insufficient OAuth scope. Google's `AUTHORIZATION_ERROR` means generic client authorization failure; it is not proof of a missing scope or insufficient Explorer Access. If fresh authorization still returns this error after confirming the correct Cloud project and Google user, provide Google Ads API support with the request ID, affected account and request path shown in the callback or report diagnostics. Reauthorization does not override provider access restrictions.

Activity shows the latest 100 events for the signed-in workspace, newest first. Failed account syncs and reauthorization attempts include their provider diagnostics, affected account, request path and provider request ID. The chronological audit export and hash chain remain unchanged.

Google [migrated API access to Google Cloud projects on September 9, 2026](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). Check the project that owns AMCP's **Google Ads** OAuth client, not a different project used for Sheets or social sign-in. [Explorer Access supports production account reads and reporting](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), so a generic 403 is not evidence that Basic Access is required. `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` identifies a project-access restriction; older API versions can return the less specific `ACTION_NOT_PERMITTED`. `USER_PERMISSION_DENIED` concerns account identity/access or manager routing. `CUSTOMER_NOT_ENABLED` concerns the account's own status. Reconnecting cannot override Google-side restrictions, and AMCP never reactivates an account during sync.

Keep the HTTP worker enabled (AMCP_RUN_WORKER=true) or run `npm run worker` with the same persistent database and master key. A stopped worker cannot execute schedules. SQLite claims each occurrence once; leases coordinate workers and fence stale/cancelled jobs. Safe transient report/export failures retry with bounded backoff. Completed sources, calendar periods and X analytics batches are checkpointed; unknown ad writes never become new retry submissions.

Schedules recheck the creator's membership, credential and account version. Revocation, reduced roles or deselected sources/destinations stops work. Use Resume after reauthorizing to bind the schedule to your current access. Pausing, editing or deleting a schedule cancels its queued/running report and export jobs and fences in-flight workers. Completed snapshots remain available. A cancelled run from an old schedule definition cannot be retried under new settings; pull a fresh report. An HTTP request already sent to Google can finish after cancellation.

## MCP

`amcp_reporting_overview` exposes bootstrap, save, save_template, delete_view, delete_template, delete_report, run, get, list, create_spreadsheet, bind_destination, export, export_status, schedule, update_schedule, pause_schedule, remove_schedule, resume_schedule, retry and cancel. `delete_schedule` is retained as the legacy **pause** alias. Use the schema/bootstrap for exact identifiers. Website and MCP share the implementation, permission checks and structured results.

Finished snapshots also support `report_pack`, `save_presentation`, `presentation_profiles` and
`apply_profile_presentation`. Report packs offer HTML, PDF and Excel. Approved client profiles can retain a brand
name, accent color, footer and PDF spacing. Applying requires the exact profile and presentation revisions,
confirmation, operator authority and current access to every source. Nonempty profile account/login bindings must
cover all sources. The style is copied into that snapshot, so changing or deleting the reusable profile never
rewrites old report packs. Profile-choice pages return `next_offset`; continue even after an empty filtered page.
See [report-pack contracts and limits](PRODUCT-WORKFLOWS.md#client-report-packs-and-recovery). Existing Sheets
schedule delivery does not imply scheduled PDF/Excel delivery.

## Acceptance

Tests cover mappings, formulas, missing data, recommendations, pagination, date windows, schedules, permissions, Sheets ownership/typed cells/idempotency and lost create responses. Browser QA uses synthetic reports. Configure real credentials, reconcile a fixed period with each provider, and verify a real export plus scheduled delivery before relying on production results.

References: [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate), [Drive creation](https://developers.google.com/workspace/drive/api/guides/create-file), [X analytics](https://docs.x.com/x-ads-api/analytics), [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), [GA4 schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema), [Microsoft report columns](https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportcolumn?view=bingads-13), [Reddit reporting](https://ads-api.reddit.com/docs/v3/api/get-a-report).

## Report contract revision 2026-09-12

New snapshots freeze the source and formula versions, custom formula fingerprint, query fingerprints and measurement-quality metadata. GA4 sampled, thresholded, aggregated or restricted results are visibly limited; restricted metrics and their formulas stay unknown. Apple v1 uses official `metadata` and `totalMetrics` fields, including tap-plus-view total installs. Native metric definitions and attribution remain provider specific.

CSV and Sheets use the same typed table. New trailing columns carry report ID/state, all selected-source statuses (on the first data row), compact per-row quality and formula/query fingerprints. Existing metric columns keep their positions. Full authenticated evidence is downloadable at `/api/reporting-overview/<report-id>.metadata.json`, including source failures; it excludes worker authority and private checkpoints. Consumers must not assume appended columns imply compatible mixed-currency totals. Legacy snapshots remain unversioned/unknown rather than being silently recalculated.

The Sheets delivery policy can allow clearly marked partial reports or require complete reports. Complete-only deliveries fail visibly and leave the destination unchanged. Empty reports still leave existing tabs unchanged. Independent schedules and destination ownership retain their original behavior. Recommendations now accept explicit seasonal/recent-change/tracking, secondary-KPI and business-budget/capacity context, explain conflicting evidence and hold when those gates fail. These are observational recommendations, not causal predictions or automatic budget changes.
