# Reporting Overview

## Dates and empty reports

For a historical month, select **Custom dates → Set a full month**. The date summary spells out the month and year before collection; for example, January 2025 means `2025-01-01` through `2025-01-31`. Report links can prefill explicit `since` and `until` dates without running a request or selecting an account. Account choices show synced account names separately from the connected login.

An empty provider result is labeled **No data**, while rows removed by objective filters are labeled **Filtered out**. Source and displayed row counts are retained separately. CSV and manual Sheets exports reject reports with no rows. An empty scheduled run records a skipped export and leaves the previous destination sheet unchanged. Failed or unfinished reports cannot download CSV attachments.

Meta Insights must return an explicit `data` array. Missing or malformed collections fail visibly instead of becoming empty successes. Requested account/date fields are preserved, and rows for a different account or outside the requested date interval are rejected. Attribution settings and the selected date range are never changed automatically to obtain data.

## Troubleshooting source failures

Failed sources expand automatically and show the provider error code/message, account, failed request stage, request ID and a suggested next step. Use **Copy error details** to share the sanitized diagnostic. The Activity page also shows provider diagnostics from earlier failed reads, without needing another provider request. A failed source is never reported as zero performance; successful sources in a mixed report remain explicitly partial.

For Google HTTP 403, distinguish `USER_PERMISSION_DENIED` (identity/account access or manager routing) from developer-token/project restrictions such as `DEVELOPER_TOKEN_NOT_APPROVED` or `DEVELOPER_TOKEN_PROHIBITED`. With direct customer access, an unrelated `AMCP_GOOGLE_LOGIN_CUSTOMER_ID` should be omitted; manager access needs the correct manager ID. After changing server OAuth settings, reconnect Google Ads because existing connections retain their saved credentials/settings. The report displays the login customer ID actually sent. AMCP does not bypass a provider denial or automatically change routing. See [Google's error guide](https://developers.google.com/google-ads/api/docs/get-started/common-errors) and [Google's access model](https://developers.google.com/google-ads/api/docs/oauth/access-model).

Open **Reporting overview** in workspace navigation (/reporting-overview). Select multiple platforms/accounts, a date range, objectives and metrics. Save a view or pull a new snapshot. Durable jobs freeze account selection and dates for each run.

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
| X Ads | Four placement requests, separate mobile conversions, hourly buckets and explicit partial-coverage flags |
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

AMCP marks its own destination tab and replaces its report cells; other tabs remain intact. Typed cells prevent text from becoming executable formulas. Exports are limited to 200,000 cells and an 8 MiB request. Split larger reports or reduce metrics. Retrying replaces the same cells, not appended duplicate rows. Interrupted file creation is reconciled by the app's creation marker; unknown results never trigger blind duplicate creation.

CSV is also available. Download links use the browser's download behavior and bypass the client page router; they do not navigate to Connections. Both formats include selected/custom metrics, recommendations, attribution, currency/timezone and completeness.

## Scheduled delivery

Choose daily/weekly/hourly cadence, an IANA timezone, rolling complete days, recent-day exclusion and destination. Each occurrence collects fresh data and replaces the destination tab. DST is handled in the chosen timezone. The UI shows next run, pause state, report progress and delivery history, with retry for failed exports.

**Save report & enable schedule** atomically saves a view and an independent schedule with its account selection, objectives, metrics, formulas and destination. Reopen it from **Saved views** or **Scheduled account reports → Open report setup**. Each report can use a separate spreadsheet or a separate AMCP tab in the same spreadsheet. Only one active schedule can use a destination tab, preventing different account reports from replacing one another. Stable creation keys make destination and schedule retries idempotent. Up to 50 schedules can coexist in a workspace.

## Google Ads account discovery

Sync the Google Ads connection to discover directly accessible accounts and all descendant accounts under each accessible manager. Discovery requests account status, name, currency and timezone without active-only or hidden-account filters; cancelled, suspended and closed accounts remain visible and selectable. Each selected child retains its verified login manager for subsequent API requests. This does not reactivate accounts, grant provider permissions or promise that Google permits every operation on an inactive account.

Failures in one hierarchy show an incomplete-sync warning without discarding successful discoveries or existing selections. After a complete sync, accounts no longer visible to the login are removed from AMCP grants as before.

Connection sync failures expose the provider code/message, affected account, request stage/path, login customer ID and request ID in **Connections → Manage** and **Activity → website asset sync**. Only redacted diagnostic fields are saved; provider credentials and raw responses are excluded. A successful accessible-account list with a failed details lookup remains an incomplete sync, not a disconnected OAuth login or a successful empty hierarchy.

Google [migrated API access to Google Cloud projects on September 9, 2026](https://developers.google.com/google-ads/api/docs/api-policy/developer-token). Check the project that owns AMCP's **Google Ads** OAuth client, not a different project used for Sheets or social sign-in. [Explorer Access supports production account reads and reporting](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), so a generic 403 is not evidence that Basic Access is required. `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` identifies a project-access restriction; older API versions can return the less specific `ACTION_NOT_PERMITTED`. `USER_PERMISSION_DENIED` concerns account identity/access or manager routing. `CUSTOMER_NOT_ENABLED` concerns the account's own status. Reconnecting cannot override Google-side restrictions, and AMCP never reactivates an account during sync.

Keep the HTTP worker enabled (AMCP_RUN_WORKER=true) or run `npm run worker` with the same persistent database and master key. A stopped worker cannot execute schedules. SQLite claims each occurrence once; leases coordinate workers and fence stale/cancelled jobs. Safe transient report/export failures retry with bounded backoff. Completed sources are checkpointed; unknown ad writes never become new retry submissions.

Schedules recheck the creator's membership, credential and account version. Revocation, reduced roles or deselected sources/destinations stops work. Use Resume after reauthorizing to bind the schedule to your current access. Pausing affects future occurrences; cancel an already queued job separately if needed. An HTTP request already sent to Google can finish after cancellation.

## MCP

`amcp_reporting_overview` exposes bootstrap, save, run, get, list, create_spreadsheet, bind_destination, export, export_status, schedule, delete_schedule, resume_schedule, retry and cancel. Use the schema/bootstrap for exact identifiers. Website and MCP share the implementation, permission checks and structured results.

## Acceptance

Tests cover mappings, formulas, missing data, recommendations, pagination, date windows, schedules, permissions, Sheets ownership/typed cells/idempotency and lost create responses. Browser QA uses synthetic reports. Configure real credentials, reconcile a fixed period with each provider, and verify a real export plus scheduled delivery before relying on production results.

References: [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate), [Drive creation](https://developers.google.com/workspace/drive/api/guides/create-file), [X analytics](https://docs.x.com/x-ads-api/analytics), [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), [GA4 schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema), [Microsoft report columns](https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportcolumn?view=bingads-13), [Reddit reporting](https://ads-api.reddit.com/docs/v3/api/get-a-report).
