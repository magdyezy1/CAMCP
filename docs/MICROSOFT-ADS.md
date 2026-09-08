# Microsoft Advertising / Bing Ads

AMCP includes an independent Microsoft Advertising v13 JSON adapter, website OAuth connection, advertiser-account discovery, reviewed Search mutations and asynchronous reporting. This is separate from the captured WhatHead interface. Automated tests establish local contracts; Microsoft app approval and live account qualification are still required.

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

Use `microsoft_ads_native_action` with `action: LIST_ACTIONS` or `action: DESCRIBE_ACTION` and `target_action`. AMCP exposes 24 actions:

| Area | Actions |
| --- | --- |
| Account | `GetAccount` |
| Campaigns | `GetCampaignsByAccountId`, `GetCampaignsByIds`, `AddCampaigns`, `UpdateCampaigns`, `DeleteCampaigns` |
| Ad groups | `GetAdGroupsByCampaignId`, `GetAdGroupsByIds`, `AddAdGroups`, `UpdateAdGroups`, `DeleteAdGroups` |
| Ads | `GetAdsByAdGroupId`, `GetAdsByIds`, `AddAds`, `UpdateAds`, `DeleteAds` |
| Keywords | `GetKeywordsByAdGroupId`, `GetKeywordsByIds`, `AddKeywords`, `UpdateKeywords`, `DeleteKeywords` |
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

Use returned campaign IDs in `payload.CampaignId` for ad groups. Ad and keyword reviews require both `payload.AdGroupId` and top-level `arguments.campaign_id` so the guard reads the exact parent campaign and ad group. No intervening list call is necessary. The review API handles execution, spend confirmation, expiry and retained outcomes as described in [write operations](WRITE-OPERATIONS.md). Native contracts follow Microsoft's [AddCampaigns](https://learn.microsoft.com/en-us/advertising/campaign-management-service/addcampaigns?view=bingads-13) and [UpdateCampaigns](https://learn.microsoft.com/en-us/advertising/campaign-management-service/updatecampaigns?view=bingads-13) documentation.

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

Choose an Account, Campaign, AdGroup, Ad, Keyword or SearchQuery performance report and its valid native columns. Scope must be exactly the selected account. Submission creates a read-oriented report job; it does not change advertising configuration. AMCP does not automatically retry job creation after a lost response. Poll using its `ReportRequestId` on the same connection/account. Pending is incomplete; Success returns Microsoft's download URL. AMCP does not currently fetch/parse the ZIP or normalize Microsoft reports into the cross-platform reporting workflow. See [SubmitGenerateReport](https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13).

## Qualification limits

This adapter does not implement the whole Microsoft API. Microsoft media imports, Bulk API, budget CRUD, targeting/criterion writes, negative keyword lists, Shopping, Performance Max, asset groups, Audience campaigns, billing and customer-wide UET/conversion management are not qualified execution contracts. A native read may support formats beyond the tested Search workflow; that does not extend the write contract. Provider-required fields and account eligibility still need Microsoft validation.

No Microsoft production credential or live mutation was used for this release. Tests cover OAuth, rotating refresh tokens, paginated discovery, selection and customer mapping, all 12 qualified mutation routes, exact state reads, stale budgets, partial failures, no retry after uncertain submission, report scope, reader/operator grants and the website callback. Configure your app and use live reads before qualifying production execution.
