# Reporting Overview

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
4. Connections → Google Sheets requests drive.file permission independently from Ads or private-media Drive connections.
5. In **Sheets & schedules**, create an AMCP spreadsheet or bind one already authorized and selected in the connection. An admin/owner creates spreadsheets; operators export to authorized destinations. An arbitrary file ID does not grant access. Google Picker is not included; creating a spreadsheet through AMCP is the supported first-use path.

AMCP marks its own destination tab and replaces its report cells; other tabs remain intact. Typed cells prevent text from becoming executable formulas. Exports are limited to 200,000 cells and an 8 MiB request. Split larger reports or reduce metrics. Retrying replaces the same cells, not appended duplicate rows. Interrupted file creation is reconciled by the app's creation marker; unknown results never trigger blind duplicate creation.

CSV is also available. Both formats include selected/custom metrics, recommendations, attribution, currency/timezone and completeness.

## Scheduled delivery

Choose daily/weekly/hourly cadence, an IANA timezone, rolling complete days, recent-day exclusion and destination. Each occurrence collects fresh data and replaces the destination tab. DST is handled in the chosen timezone. The UI shows next run, pause state, report progress and delivery history, with retry for failed exports.

Keep the HTTP worker enabled (AMCP_RUN_WORKER=true) or run `npm run worker` with the same persistent database and master key. A stopped worker cannot execute schedules. SQLite claims each occurrence once; leases coordinate workers and fence stale/cancelled jobs. Safe transient report/export failures retry with bounded backoff. Completed sources are checkpointed; unknown ad writes never become new retry submissions.

Schedules recheck the creator's membership, credential and account version. Revocation, reduced roles or deselected sources/destinations stops work. Use Resume after reauthorizing to bind the schedule to your current access. Pausing affects future occurrences; cancel an already queued job separately if needed. An HTTP request already sent to Google can finish after cancellation.

## MCP

`amcp_reporting_overview` exposes bootstrap, save, run, get, list, create_spreadsheet, bind_destination, export, export_status, schedule, delete_schedule, resume_schedule, retry and cancel. Use the schema/bootstrap for exact identifiers. Website and MCP share the implementation, permission checks and structured results.

## Acceptance

Tests cover mappings, formulas, missing data, recommendations, pagination, date windows, schedules, permissions, Sheets ownership/typed cells/idempotency and lost create responses. Browser QA uses synthetic reports. Configure real credentials, reconcile a fixed period with each provider, and verify a real export plus scheduled delivery before relying on production results.

References: [Sheets batch updates](https://developers.google.com/workspace/sheets/api/guides/batchupdate), [Drive creation](https://developers.google.com/workspace/drive/api/guides/create-file), [X analytics](https://docs.x.com/x-ads-api/analytics), [Snapchat measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), [GA4 schema](https://developers.google.com/analytics/devguides/reporting/data/v1/api-schema), [Microsoft report columns](https://learn.microsoft.com/en-us/advertising/reporting-service/campaignperformancereportcolumn?view=bingads-13), [Reddit reporting](https://ads-api.reddit.com/docs/v3/api/get-a-report).
