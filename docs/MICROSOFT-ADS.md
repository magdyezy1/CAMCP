# Microsoft Advertising / Bing Ads

AMCP includes an independent Microsoft Advertising v13 JSON adapter, website OAuth connection, advertiser-account discovery, reviewed Search mutations and asynchronous reporting. This is separate from the captured AMCP interface. Automated tests establish local contracts; Microsoft app approval and live account qualification are still required.

## Connect your application

1. Register an application in Microsoft Entra with the account types needed by your advertisers. The default AMCP authorization endpoint uses `common`, supporting Microsoft personal and organizational accounts when the app registration permits them.
2. Register the **Web** redirect URI `https://amcp.shop/api/auth/microsoft/callback`. For another AMCP origin, replace the origin while retaining the path.
3. Obtain a Microsoft Advertising developer token. This is separate from the application client secret and the user's access token.
4. Set these server environment variables through your secret configuration:

   ```text
   AMCP_MICROSOFT_CLIENT_ID
   AMCP_MICROSOFT_CLIENT_SECRET
   AMCP_MICROSOFT_DEVELOPER_TOKEN
   ```

5. Open AMCP Connections, connect Microsoft Advertising, complete consent, synchronize and select the advertiser accounts to expose to MCP. Merely connecting does not select every discovered account. Each selected account retains its verified parent customer ID.

AMCP requests `https://ads.microsoft.com/msads.manage offline_access`, uses PKCE S256 and encrypts credentials and OAuth state. Token refresh preserves rotated refresh tokens. Microsoft uses the same `msads.manage` API scope for reads and writes; AMCP's reader/operator roles and per-account write grants enforce the distinction locally. Existing read-only selections stay read-only. Live advertising execution also requires `MIRROR_ALLOW_WRITES=true` and a reviewed request.

Authorization and token endpoints are Microsoft's `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` and `/token`. API requests use separate `Authorization`, `DeveloperToken`, `CustomerAccountId` and verified `CustomerId` headers; clients cannot override these through tool arguments. See Microsoft's [OAuth guide](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth?view=bingads-13), [token and refresh flow](https://learn.microsoft.com/en-us/advertising/guides/authentication-oauth-get-tokens?view=bingads-13), and [developer access requirements](https://learn.microsoft.com/en-us/advertising/guides/get-started?view=bingads-13).

## Discover and read

Use `microsoft_ads_native_action` with `action: LIST_ACTIONS` or `action: DESCRIBE_ACTION` and `target_action`. AMCP exposes <!-- fact:microsoft_actions -->31<!-- /fact --> actions (generated from `microsoftActions`, `src/microsoft-native.ts`), <!-- fact:microsoft_mutations -->16<!-- /fact --> of them mutations:

| Area | Actions |
| --- | --- |
| Account | `GetAccount` |
| Campaigns | `GetCampaignsByAccountId`, `GetCampaignsByIds`, `AddCampaigns`, `UpdateCampaigns`, `DeleteCampaigns` |
| Ad groups | `GetAdGroupsByCampaignId`, `GetAdGroupsByIds`, `AddAdGroups`, `UpdateAdGroups`, `DeleteAdGroups` |
| Ads | `GetAdsByAdGroupId`, `GetAdsByIds`, `AddAds`, `UpdateAds`, `DeleteAds` |
| Keywords | `GetKeywordsByAdGroupId`, `GetKeywordsByIds`, `AddKeywords`, `UpdateKeywords`, `DeleteKeywords` |
| Campaign location criteria | `GetCampaignCriterionsByIds`, `AddCampaignCriterions`, `DeleteCampaignCriterions` |
| Extension links | `GetAdExtensionsByIds`, `GetAdExtensionsAssociations`, `SetAdExtensionsAssociations`, `DeleteAdExtensionsAssociations` |
| Shared budget reads | `GetBudgetsByIds` |
| Reports | `SubmitGenerateReport`, `PollGenerateReport` |

IDs are positive signed 64-bit **decimal strings**, including IDs inside native JSON. Do not convert them to JavaScript numbers. Payload field names use Microsoft's PascalCase. Account IDs always remain explicit AMCP grants.

```json
{
  "action": "GetCampaignsByAccountId",
  "account_id": "123",
  "payload": {"CampaignType": "Search"}
}
```

List responses preserve native entities and any native null results. A child resource request carries the mandatory account header; the provider must enforce that header against the supplied campaign/ad-group IDs. Discovery uses [SearchAccounts](https://learn.microsoft.com/en-us/advertising/customer-management-service/searchaccounts?view=bingads-13), paginates and preserves each account's `ParentCustomerId`. Incomplete discovery cannot silently become a complete inventory.

## Reviewed Search writes

The 12 Add/Update/Delete actions qualify **Search campaigns, their ad groups, responsive search ads and keywords**. Campaign review reads explicitly request Search, including when reviewing a child. Other campaign/ad formats require additional contracts. New serving entities must use `Status: "Paused"`. Updates and deletes read every exact target; stale mutable configuration blocks submission. Native partial failures remain visible and are retained under the original idempotency key.

Campaign activation reads the campaign's location criteria first: see [Location criteria and activation](#location-criteria-and-activation-cmp-03-owner-decision-p7).

Use `amcp_write` with `action: inspect` first for a local contract check, then `prepare` for live state review. The following is a preparation request, using a synthetic account ID:

```json
{
  "action": "prepare",
  "gateway": "microsoft_ads_native_action",
  "arguments": {
    "action": "AddCampaigns",
    "account_id": "123",
    "payload": {
      "Campaigns": [{
        "Name": "Search draft",
        "CampaignType": "Search",
        "Status": "Paused",
        "BudgetType": "DailyBudgetStandard",
        "DailyBudget": 50
      }]
    }
  }
}
```

Here `DailyBudget: 50` means **50 account-currency units**, not micros. Existing `BudgetId` references are also read during review. AMCP preserves native fields, so complete any additional settings required by the advertiser and provider before execution. Old standalone Target CPA/ROAS schemes are rejected; use the current native MaxConversions/MaxConversionValue scheme and its target where appropriate.

Use returned campaign IDs in `payload.CampaignId` for ad groups. Ad and keyword reviews require both `payload.AdGroupId` and top-level `arguments.campaign_id` so the guard reads the exact parent campaign and ad group. No intervening list call is necessary. The review API handles execution, spend confirmation, expiry and retained outcomes as described in [write operations](WRITE-OPERATIONS.md).

`amcp_campaign` `verify` (and every `microsoft_search` plan step) reads each written campaign, ad group, responsive search ad or keyword back by exact ID. The review snapshot and the verification read use one `Get{Kind}ByIds` builder, so campaign reads always send `CampaignType: "Search"` and ad reads always send `AdTypes: ["ResponsiveSearch"]`. When a written record sets something Microsoft returns only on request (for example `AdScheduleUseSearcherTimeZone`, a `TargetSetting` entry in `Settings`, `MaxConversionValueBiddingScheme` or a MaxConversions `TargetCpa`), the read names it in `ReturnAdditionalFields` (comma-separated, values from the pinned v13 WSDL), so the field is compared instead of the result ending inconclusive. Deletions have no read that shows them. Sandbox acceptance of the RSA read-back is still owner-run. Native contracts follow Microsoft's [AddCampaigns](https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigns?view=bingads-13) and [UpdateCampaigns](https://learn.microsoft.com/en-us/advertising/campaign-management-service/updatecampaigns?view=bingads-13) documentation.

### Location criteria and activation (CMP-03, owner decision P7)

A campaign created through the API has no criteria and effectively targets every location until a location criterion is added (Microsoft's targeting guide, pinned below), so AMCP activates a Microsoft campaign only when it holds a positive location criterion. `UpdateCampaigns` with `Status: "Active"` reads each activated campaign's location criteria (`GetCampaignCriterionsByIds` with `CriterionType: "Location"` and `CampaignCriterionIds: null`, the whole set) at prepare and again at execute, and is refused with `LOCATION_CRITERIA_REQUIRED` when none is a positive `LocationCriterion`; an exclusion alone does not count, and nothing is sent. Only location criteria count: a campaign targeted by radius alone (`RadiusCriterion`) is refused too, so activate it in Microsoft Advertising, or add locations knowing they widen its targeting. Pausing, budgets and the children's status need no location read.

**Residual limit (P7).** The rule and the activation gate read campaign criteria only, so they show that the campaign targets a location, not that every ad group does. Location, negative location and radius criteria form one set of geo criteria, and an ad group with any of its own (even a single exclusion) inherits none of the campaign's locations and can serve wherever Microsoft serves (the pinned targeting guide). AMCP neither reads nor writes ad-group criteria: one added in Microsoft Advertising is not seen, and `UpdateAdGroups` with `Status: "Active"` has no location read. Recipe ad groups have none, so a recipe launch activated through AMCP holds; before activating a campaign whose ad groups were edited in Microsoft Advertising, check their locations there.

The reviewed family `microsoft_location_targets` (`src/microsoft-campaign-criteria.ts`) adds and removes those locations:

```json
{
  "action": "AddCampaignCriterions",
  "account_id": "123",
  "payload": {
    "CriterionType": "Targets",
    "CampaignCriterions": [
      {"Type": "BiddableCampaignCriterion", "CampaignId": "501", "Criterion": {"Type": "LocationCriterion", "LocationId": "190"}}
    ]
  }
}
```

- **Shape.** 1–100 rows of one campaign, each exactly a `BiddableCampaignCriterion` holding a `LocationCriterion` with a numeric `LocationId` string, and `CriterionType: "Targets"` (Microsoft adds and deletes target criteria with `Targets` but reads them with `Location`). Negative criteria, radius, location intent and other criterion types, `Id`, `Status` and bid or cashback adjustments are refused (`INVALID_MICROSOFT_REQUEST`): a bid multiplier changes what is paid, and Microsoft applies none when `CriterionBid` is omitted.
- **Review.** The parent campaign is read by exact ID under the account header (a campaign of another account is not returned: `STATE_TARGET_MISMATCH`) and must be paused by the advertiser (`Paused` or `BudgetAndManualPaused`), so the change can neither start nor widen delivery (`LOCATION_PARENT_NOT_PAUSED`). Its current location criteria are part of the reviewed state: a location it already targets or excludes is refused (`CONFIGURATION_EXISTS`), and a change between prepare and execute is `STATE_CHANGED`. `DeleteCampaignCriterions` (`CampaignId`, `CampaignCriterionIds`, `CriterionType: "Targets"`) removes only an existing positive location criterion of that campaign (`STATE_NOT_FOUND` otherwise) and follows the owner's deletion policy.
- **Outcome and read-back.** An add is confirmed only by an ID for every row and no `NestedPartialErrors` entry (Microsoft lists failures there without aligning them to the rows; an empty list, or null entries only, means none failed); a partial or lost answer is never resent under the same key. Each added criterion is read back by ID and compared (campaign, location, positive, bid multiplier 0); the activation gate below lists each location with the `DisplayName` Microsoft gives it. A deletion is verified by the criterion's absence from the campaign's location set.
- **What Microsoft documents.** Pinned in `.mirror/VENDOR/microsoft-rest-v13.json` by `node tools/microsoft-rest.mjs`: the REST pages of the three operations; the `BiddableCampaignCriterion`, `NegativeCampaignCriterion`, `LocationCriterion`, `LocationIntentCriterion`, `BidMultiplier` and `CampaignCriterionType` pages; and the guides [Show Ads to Your Target Audience](https://learn.microsoft.com/en-us/advertising/guides/show-ads-target-audience?view=bingads-13) and [Geographical Location Codes](https://learn.microsoft.com/en-us/advertising/guides/geographical-location-codes?view=bingads-13), each by content digest. The pages were read by public, unauthenticated GETs during implementation (no account or credential was involved); before release the owner re-runs `node tools/microsoft-rest.mjs` and compares its digests with the committed pins, or records that such documentation reads were allowed. Every pinned page records when it was read (`read_at`: the operation and data-object pages were first read on 2026-10-11 and read again, unchanged, on 2026-10-12; the guides on 2026-10-14, UTC), and each records the rules AMCP takes from it (`relies_on`); `--check` holds them to the tool's list, and a page whose rules change is read again. The rules: a campaign created through the API has no criteria and effectively targets all locations (P7's premise, which the review had only from a search result); the first criterion adds a location intent of `PeopleInOrSearchingForOrViewingPages` (people in, searching for or viewing pages about the locations), which AMCP leaves unchanged, so set "people in" in Microsoft Advertising when that is the intent; location, negative location and radius criteria are one set of geo criteria, and an ad group with any of its own inherits none of the campaign's, even when its own are exclusions only (AMCP neither reads nor writes ad-group criteria, and recipe ad groups have none).
- **Location IDs.** They come from the `Location Id` column of Microsoft's geographical locations file (`GetGeoLocationsFileUrl`); its display names are for presentation only, and several IDs can share one, so the activation gate lists each ID with its name. A deprecated location cannot be added, and a deprecated location criterion can still be read but no longer targets. Microsoft's pages disagree on a location the file marks Pending Deprecation: the guide says it still targets for up to 30 days, the `LocationCriterion` page says it no longer does. The location rule and the activation gate do not read that file, so a campaign whose only locations are deprecated or pending deprecation passes the location rule yet may serve anywhere: enter locations the current file lists as Active (the lookup below shows each status), and confirm the names the activation gate shows.
- **Location lookup (`recipe_lookup`, `lookup_kind: "microsoft_location"`).** It finds location IDs by name (`query` of 2–80 letters; case and accents are ignored for matching, names are returned as the file has them) or checks 1–100 IDs (`query` of numeric IDs separated by commas or lines), under an explicit `account_id` (and `connection_id`) the person holds. It reads only: `GetGeoLocationsFileUrl` (`Version` 2.0, `LanguageLocale` en, `CompressionType` GZip, the only compression its page supports, since `Zip` is reserved for future use; sent under the account like any Campaign Management read) returns the file's URL, and the file is downloaded from that public HTTPS address with no credentials and no redirects, by the same DNS-pinned download as report files. Bounds, each a refusal rather than a truncation (`MICROSOFT_LOCATIONS_FILE_INVALID`, `details.problem` names the check): 32 MiB of archive, 128 MiB of text, 1,000,000 rows, 64 columns and 1,024 characters a field; a single-file ZIP (stored or deflated, CRC and size checked) or GZip archive of UTF-8 or UTF-16 CSV with the documented `Location Id` and `Bing Display Name` columns, numeric IDs each listed once. `Location Type` and `Status` are read when present and stay unknown (`null`) otherwise; the answer names the columns it found. A search returns at most 20 matches (exact names, then leading words, Active first) with `match_count`; a check returns each ID found and lists `missing_ids`. A location is `selectable` only when the file says `Active`; Pending Deprecation, Deprecated and an unknown status carry their reason, and a file without a status column says so (`status_not_in_file`). The file is Microsoft's reference file, the same for every account, so a deployment keeps one copy in memory for an hour after it was last checked (then it asks for the URL again and downloads only when `LastModifiedTimeUtc` changed); each lookup still checks the person's own login and account, and the answer counts `provider_requests`, `file_downloads` and `provider_mutations: 0`. The website's Search brief offers **Find Microsoft location IDs**: a search whose **Add** puts an Active location's ID in the brief, and **Check the entered IDs**, which lists each entered ID with its name, type and status, or as not in the file.
- **When the lookup is available.** AMCP sends a Microsoft request only as its Microsoft Learn REST page documents it (F-50). The `GetGeoLocationsFileUrl` page is an optional pin (`document.optional_operations` of `.mirror/VENDOR/microsoft-rest-v13.json`), pinned on 2026-10-17 by a public, unauthenticated read (`1e03807b`; the page showed that `Zip` is reserved for future use, so the lookup requests `GZip`), so the lookup is available and `recipe_context` reports `location_lookup: {available: true}`. A tree without that pin refuses the lookup with `MICROSOFT_LOCATIONS_UNPINNED` before anything is sent, reports `location_lookup: {available: false}` and shows no search on the website, and `--check` names the operation as `optional_not_pinned`; `node tools/microsoft-rest.mjs` pins it again (it prints the page's rules as `newly_pinned` to check against `reliesOn` in `tools/microsoft-rest-rules.mjs`). A pinned page that documents another method, URL or fields keeps the lookup refused (`VENDOR_SCHEMA_UNAVAILABLE`). Not confirmed until an owner-authorized native read: the file version AMCP asks for, the columns it reads when present and their values, the file's size and its compression.

The guided `microsoft_search` recipe takes a required `location_ids` input (one ID per line on the website) and adds a `targets` step after `campaign`, so every compiled plan targets the brief's locations on the paused campaign. A brief saved before this change fails the recipe input check with `location_ids` named, and a plan drafted before it (no `targets` step) is refused at preflight, prepare and approval with `RECIPE_INPUT_REQUIRED` (`location_ids`) while none of its steps has been prepared: draft it again from the recipe. Its activation plan's preflight runs the `microsoft_location_criteria` gate: it reads the campaign's location criteria, blocks with `ACTIVATION_GATE_BLOCKED` when none is positive or the read fails, and otherwise lists each location ID with Microsoft's name for the operator to confirm before approving; the campaign step's own review then reads them again. Native acceptance (one paused campaign with location criteria on a non-serving account, read back) needs the owner's authorization.

## Reports

```json
{
  "action": "SubmitGenerateReport",
  "account_id": "123",
  "payload": {
    "ReportRequest": {
      "Type": "CampaignPerformanceReportRequest",
      "Scope": {"AccountIds": ["123"]},
      "Columns": ["CampaignId", "Clicks", "Spend"],
      "Aggregation": "Summary",
      "Format": "Csv",
      "Time": {"PredefinedTime": "Yesterday"}
    }
  }
}
```

Choose an Account, Campaign, AdGroup, Ad, Keyword or SearchQuery performance report and its valid native columns. Scope must be exactly the selected account. Submission creates a read-oriented report job; it does not change advertising configuration. AMCP does not automatically retry job creation after a lost response. Poll using its `ReportRequestId` on the same connection/account. Pending is incomplete; by default Success returns Microsoft's download URL. Set `download_report: true` on PollGenerateReport to download and parse CSV/TSV on the AMCP server, with `offset` and `limit` (1–100). Follow `next_call` for pending jobs and additional rows. No client download is needed; parsed reports retain native string values rather than entering the cross-platform metrics model. See [SubmitGenerateReport](https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13).

## Qualification limits

This adapter does not implement the whole Microsoft API. Microsoft media imports, Bulk API, budget CRUD, targeting and criterion writes other than positive campaign location criteria, negative keyword lists, Shopping, Performance Max, asset groups, Audience campaigns, billing and customer-wide UET/conversion management are not qualified execution contracts. A native read may support formats beyond the tested Search workflow; that does not extend the write contract. Provider-required fields and account eligibility still need Microsoft validation.

No Microsoft production credential or live mutation was used for this release. Tests cover OAuth, rotating refresh tokens, paginated discovery, selection and customer mapping, the reviewed mutations (the 12 Search routes, the two location-criterion routes and the two extension-association routes: `tests/microsoft.test.ts`, `tests/microsoft-campaign-criteria.test.ts`, `tests/microsoft-associations.test.ts`), read-back verification of each `Get*ByIds` contract (PRV-03), exact state reads, stale budgets, partial failures, no retry after uncertain submission, report scope, reader/operator grants and the website callback. Configure your app and use live reads before qualifying production execution.

### Server download example

```json
{
  "action": "PollGenerateReport",
  "account_id": "123",
  "payload": {"ReportRequestId": "REPLACE_WITH_RETURNED_ID"},
  "download_report": true,
  "offset": 0,
  "limit": 100
}
```

AMCP retains the original report specification and ownership for one day, scoped to the tenant, connection and account. Cached parsed pages avoid repeated downloads; every poll and page still checks current access. Advertising-resource ownership expiry is unchanged. Microsoft download URLs are short lived and their domains can change: downloads resolve and pin public IP addresses, require HTTPS, reject redirects, and send no advertising credentials or cookies. See [Microsoft report status](https://learn.microsoft.com/en-us/advertising/reporting-service/reportrequeststatus?view=bingads-13).

Parsing supports a single CSV/TSV ZIP member, UTF-8 or BOM-marked UTF-16, quoted delimiters/newlines, ordered columns and optional metadata/footer. IDs, amounts and all cells remain strings. Row counts and an included AccountId column are checked; Pending is never called complete, and a successful null download URL becomes an explicitly empty result. Limits: 8 MiB compressed, 32 MiB expanded, 10,000 rows, 100 columns, 64 KiB per field, 256 KiB per row and 512 KiB of row data per MCP page. Narrow the report if it exceeds these bounds. XML and normalized cross-platform Microsoft reporting remain outside this parser. [Report formats](https://learn.microsoft.com/en-us/advertising/guides/reports?view=bingads-13).
