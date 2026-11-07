---
status: record
tier: engineering
---

# Apple Ads Platform API: facts pinned for Round 2 Task 13

Read on 2026-11-06 from Apple's public documentation (no API call, no sign-in), for V2-RPT-07 Task 13: bounded
multi-page collection of the Apple ad group and ad levels. Every URL below is
`https://developer.apple.com/documentation/apple-ads-platform-api/<page>.md`; the page is named in brackets. Facts are
paraphrased. The Apple fixtures of the tests follow these pages, never the code (`tests/helpers/apple-ads.mjs`).

## Reports

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Page                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R1  | Report queries are `POST /v1/reports/apps/{campaigns,adgroups,ads}/query` (also keywords and search terms, which AMCP does not read). The body is `AppsReportingRequest`: `pagination`, `sorting`, `filters`, `fields`, `groupBy`, `timeRange`, `options`.                                                                                                                                                                                                                                                              | [reports] [appsreportingrequest]                                                                     |
| R2  | `pagination` is `RequestPagination`: `offset` and `pageSize`, with a **maximum `pageSize` of 5000** and a default of 100. It has no flag that asks for totals.                                                                                                                                                                                                                                                                                                                                                          | [reports] [requestpagination]                                                                        |
| R3  | The response is `{result: {rows, summary}, pagination, error}`. **`pagination` is a sibling of `result`**, not inside it, in every example; it holds `offset`, `pageSize` and `totalCount`, and a report always shows `totalCount`. Check `error` before `result`.                                                                                                                                                                                                                                                      | [appsadreportresponse] [appscampaignreportresponse] [appsadgroupreportresponse] [responsepagination] |
| R4  | `result.rows[]` hold `metadata`, `totalMetrics` and, only when a `granularity` is requested, `granularMetrics`. Without `groupBy` there is one aggregate row per entity. Without `EMPTY_METRICS` (`options.includeRows`, Apps only, not with `groupBy`) only entities with metric data appear.                                                                                                                                                                                                                          | [reports]                                                                                            |
| R5  | Row `metadata` names the entity and its parents. Campaign: `id`, `name`, `adAccountId`, `promotedObjectType`, `promotedObjectId`, `promotedObject`, `bidStrategy`, `status`, `deleted`. Ad group: `id`, `name`, `adAccountId`, `campaignId`, `status`, `pricingModel`, `deleted`. Ad: `id`, `name`, `adAccountId`, `campaignId`, `adGroupId`, `status`, `deleted`, `creative`. IDs are JSON integers; money is `{amount, currency}` text; counts are integers; one ad example has `tapInstalls` and no `totalInstalls`. | [get-app-campaign-reports] [get-app-ad-group-reports] [get-app-ad-reports]                           |
| R6  | **The ad group and ad reports require a `campaignId` filter** (optionally narrowed by `adGroupId`; both pages say "required", the table says it scopes the results and reduces the response); for the campaign report it is optional.                                                                                                                                                                                                                                                                                   | [get-app-ad-group-reports] [get-app-ad-reports] [get-app-campaign-reports]                           |
| R7  | A filter is `{field, operator, value}`. A single-value operator such as `EQUALS` takes a bare string or a one-element array; a multi-value one such as `IN` takes an array. The report examples send `"value": "444555666"`.                                                                                                                                                                                                                                                                                            | [filter] [filter/value-data.dictionary]                                                              |
| R8  | `timeRange` is `{start, end, timeZone, granularity?}` with `timeZone` `UTC` or `ORTZ`. Ad reports do not support `HOURLY`. A single day omits `granularity`.                                                                                                                                                                                                                                                                                                                                                            | [timerange] [get-app-ad-reports]                                                                     |

## Entity queries (the parents of report rows)

| #   | Fact                                                                                                                                                                                                                                                                                                                      | Page                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Q1  | `POST /v1/campaigns/query`, `/v1/adgroups/query`, `/v1/ads/query` take a `QueryRequest`: `filters`, `sorting`, `pagination`. `id` takes `EQUALS` and `IN`; ad groups filter `campaignId` with `EQUALS`; ads filter `campaignId`, `adGroupId` with `EQUALS`. Sorting defaults to ID, ascending.                            | [post-campaigns-query] [post-adgroups-query] [post-ads-query] [calling-apple-ads-platform-api] |
| Q2  | `pagination` is `QueryPagination`: `pageSize`, `offset` and `fetchTotalCount` (default false; when true the response carries `totalCount`). **The campaign query caps `pageSize` at 1000**; the ad group and ad pages state no cap.                                                                                       | [querypagination] [post-campaigns-query] [calling-apple-ads-platform-api]                      |
| Q3  | The response is `{result: [...], pagination}`. Deleted entities are **not returned** unless a filter asks for them (`deleted EQUALS true`).                                                                                                                                                                               | [post-ads-query] [post-adgroups-query] [calling-apple-ads-platform-api]                        |
| Q4  | An ad account is `GET /v1/ad-accounts/{id}`; the example carries `id`, `name`, `orgId`, `timezone`, `currency`. Every ad-account-scoped call carries `X-AP-Context: adAccountId=<id>`.                                                                                                                                    | [adaccount] [calling-apple-ads-platform-api]                                                   |
| Q5  | Entity records carry `adAccountId`, `status` (the advertiser's setting) and `systemStatus`; a campaign also carries `displayStatus` (`RUNNING`, `PAUSED` in the examples), an ad group and an ad do not in theirs. An ad group record has `campaignId` and `pricingModel`; an ad record has `campaignId` and `adGroupId`. | [post-campaigns-query] [post-adgroups-query] [post-ads-query]                                  |

## Pagination: what the pages say and where they disagree

- **`pageSize` in a response has two documented meanings.** `QueryPaginationResult` says it is the number of rows actually
  returned, not the requested size (its example: offset 150, 50 requested, 180 in total, `pageSize` 30), and tells the
  caller to compare `offset + pagination.pageSize` with `totalCount`. Every endpoint example, report or query, shows
  `pageSize` equal to the **requested** size (20) while fewer rows came back (one row, `totalCount` 1), and
  `ResponsePagination` and the general guide call it the page size. [querypaginationresult] [responsepagination]
  [calling-apple-ads-platform-api] [get-app-ad-reports] [post-adgroups-query]
- **AMCP therefore never uses `pagination.pageSize` to decide anything.** It continues at `offset + rows received`, stops
  when that reaches `totalCount`, and treats an empty page as the end only when no total was given. `pageSize` must be a
  non-negative integer and the echoed `offset` must be the one requested; either failing refuses the read.
- **Lists without a total.** Apple's change-history article says to page forward until the result array is empty when
  totals are skipped, and that a skipped total reads as `0`. [pagination] [auditquery] The report and query pages do not
  say what an absent total means, so AMCP applies the same rule as an inference: no `totalCount`, read until an empty
  page; a `totalCount` smaller than the rows already read is inconsistent and refused.
- The earlier code read `pagination.totalResults` (and a `pagination` inside `result`), names and a place no Apple page
  uses; `totalCount` beside `result` is the documented one. A count under another name is not a total.

## What AMCP does with them

- Reports and entity queries share one bounded paging helper (`src/apple-report-pages.ts`): pages of 1000 (inside both the
  report maximum of 5000 and the campaign query cap of 1000), at most 25 pages a list (the bound the transport already
  puts on a read) and at most 10,000 rows a report. A total over the rows still allowed refuses before more pages are
  read; a changing total, an empty page before the total, an inconsistent echo or a 25th page without an end refuse. Nothing
  is shortened.
- The ad group and ad levels ask the campaign report for the campaigns with activity in the window (or use the campaign IDs
  the scope names), then ask each report once per campaign with `campaignId EQUALS` (R6). The campaigns have no bound of
  their own: each costs a request, and the whole-job allowance (1,200 requests, 300 seconds) is the bound. Past it, with at
  least one campaign read, the campaigns finished are returned as a partial report with the warning "n of m campaigns read",
  as Snapchat's ad squad level does; with none read, the limit error is raised. Each row must name the account and campaign
  it was asked for.
- A row of a deleted ad group or ad is absent from the entity queries (Q3) but names its own campaign, and an ad its ad
  group (R5). Those are its parents: the campaign's name is read with the others, an ad group record that is gone leaves the
  ad group's name unknown, and a record that names another campaign or ad group than the row does is refused.
- Parents (ads, ad groups, campaigns) are read by `id IN` in batches of at most 1000 IDs, each batch paged with
  `fetchTotalCount`.

## Still unpinned (checked in the owner runbook, `docs/acceptance/ROUND2-APPLE-READ-ACCEPTANCE.md`)

- What a report's `pagination.pageSize` and `totalCount` hold on a page with fewer rows than requested, and whether a
  page above 1000 rows is served for reports (the maximum is 5000) and for the ad group and ad queries (no cap stated).
- Whether an ad group or ad report without `campaignId` is refused (R6 says it is required), and what a report for a
  campaign ID of another account or of no campaign answers (an error or an empty list).
- The largest `IN` list a query accepts, and whether rows keep a stable order across pages without a `sorting` (entity
  queries sort by ID; reports state no default).
- Whether a deleted entity that has report rows appears in the entity queries (Q3 says not), so its status is unknown
  there and its parents come from its own report row (R5; the runbook checks that the row carries them).
- `status`, `displayStatus` and `systemStatus` values beyond the examples (`ENABLED`, `PAUSED`, `RUNNING`, `ON_HOLD`,
  `LIMITED`), and whether `displayStatus` ever reads `DELETED`.
- Whether `options: {}` is accepted (the documented examples omit `options`; the new detail requests omit it, the campaign
  request still sends it).
