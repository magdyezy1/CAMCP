---
status: reference
tier: operator
---

# Round 2 Task 13: Apple Ads owner read acceptance

Live checks are blocked: no staging (V2 plan D20); Apple comes last, after the other platforms. Later use an
authorized staging ad account, reporting workers only, read-only: no OAuth or settings changes, no advertising mutations,
no real Sheets, no asynchronous jobs. Keep identifiers private. Each check settles one item under "Still unpinned" in
`docs/records/APPLE-ADS-PLATFORM-PINS-2026-11-06.md`. On a small account probe paging with `pageSize` 2.

1. Account: `GET /v1/ad-accounts/{id}` with `X-AP-Context: adAccountId=<id>`. Record the wrapper, currency and time zone.
   Read one closed day with `timeZone` `UTC` and with `ORTZ`; the console's day follows `ORTZ`.
2. Campaign report for a closed week, `pageSize` 1000, with and without `options: {}`: accepted both ways? Record the
   `metadata` fields, that `pagination` sits beside `result`, and whether `totalCount` is there.
3. Ad group and ad reports with `campaignId EQUALS "<id>"` (a string, then a one-element array). Once without the filter
   (AMCP never sends it; the pages call it required) and once with a missing or another account's campaign ID: record each
   answer. Record `adAccountId` and `campaignId` on rows, and whether ad rows always carry `totalInstalls`.
4. Paging, on a campaign with five or more ad groups or ads, `pageSize` 2: `offset`, `pageSize` (the size asked, or the
   rows returned on the last short page) and `totalCount` on every page; the same order on a second read; no row twice or
   missing; `offset` past the total. For a list over 1000 rows ask `pageSize` 1000, then 5000.
5. Entity queries `id IN [...]` with `fetchTotalCount` true and false: where the total is. The longest `IN` list accepted
   (10, 100, 1000 and 1001 IDs of one level; AMCP sends up to 1000). `pageSize` over 1000 on ad groups and ads.
6. Deleted and status: an ad group or ad deleted in the window with report rows is absent from `id IN`, and returned by
   `deleted EQUALS true`? Record `status`, `systemStatus` and `displayStatus` values per level (does `displayStatus` ever
   read `DELETED`?) and `adAccountId` on every record. AMCP gives such a row the parents its own report row names: check
   that a deleted ad group's row carries `campaignId`, and a deleted ad's row `campaignId` and `adGroupId`, and that
   they match the records of the entities that remain.
7. AMCP against Apple: run the Overview report for the same week at the campaign, ad group and ad levels, total and weekly.
   Compare spend, impressions, taps and installs of three entities a level with the console; a campaign's ad groups add up
   to it. Record `quality.population` and the provider request count. Scope one run by two campaign IDs: no campaign report
   is sent.
8. An account whose campaigns active in the week outrun the whole-job allowance (1,200 requests, one for each campaign's
   report) must return the campaigns it finished as a partial report with the warning "n of m campaigns read", never fail
   the whole report and never present the part as the whole; scope the same run by campaign IDs and compare the rows of
   the campaigns it did read. Note any rate-limit answer against AMCP's four requests a second.
9. Record counts, sanitized request IDs and discrepancies. Never change live access or objects to simulate failures. Correct
   the pins record in the same change as any code a check contradicts. Native-speaker Arabic sign-off: Round 4;
   assistive-technology checks remain separate.
